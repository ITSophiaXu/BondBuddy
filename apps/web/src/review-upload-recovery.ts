import { M1_UPLOAD_LIMITS, M1_UPLOAD_MIME_TYPES, ReviewContextSchema, ReviewDraftInputSchema, ReviewDraftRequestSchema,
  ReviewReportSchema, isReviewReport, schemas, type ReviewContext, type ReviewDraft, type ReviewDraftInput,
  type ReviewDraftRequest, type ReviewMaterialPin, type ReviewReport, type ReviewWorkspace } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';
import { UserFacingError } from './user-facing-error.js';
import type { Dto } from './api.js';
import { qaRecoveryDigest } from './qa-recovery-journal.js';
import { UploadRecovery, UploadRecoveryConflictError, UploadRecoveryLockError, UploadRecoveryStorageError,
  validateUploadMaterial, type UploadRecoveryDependencies, type UploadRecoveryJson, type UploadRecoveryRecord,
  type UploadRecoveryResumeOptions, type UploadRecoveryStorage, type UploadRecoveryLock } from './upload-recovery.js';

export type ReviewUploadStage = 'prepared' | 'material_saved' | 'adoption_prepared' | 'adoption_unknown' | 'adopted' | 'cleanup_pending' | 'complete';
export type ReviewUploadPageSnapshot = { version: number; input: ReviewDraftInput };
export type ReviewUploadAdoptionBase = ReviewUploadPageSnapshot & { cacheRaw: string | null };
export type ReviewUploadAdoptionRequest = Extract<ReviewDraftRequest, { kind: 'input' }>;
export type ReviewUploadTargetGuard = Pick<ReviewReport, 'report_id' | 'version' | 'run_id' | 'input_revision' | 'source_material'> & { digest: string };
export type ReviewUploadItem = { id: string; index: number; declaration: Dto<'UploadCreateRequest'>; stage: ReviewUploadStage;
  material?: Dto<'MaterialResponse'>; adoptionBase?: ReviewUploadAdoptionBase; adoptionRequest?: ReviewUploadAdoptionRequest;
  adoptionDigest?: string; observedDraft?: ReviewDraft; localCacheResult: 'pending' | 'cleared' | 'preserved'; coreCleaned: boolean };
export type ReviewUploadEnvelope = { version: 1; owner: string; projectId: string; id: string; kind: 'material' | 'evidence';
  baseVersion: number; baseInput: ReviewDraftInput; baseCacheRaw: string | null; targetContext: ReviewContext | null;
  targetGuard: ReviewUploadTargetGuard | null; sourcePolicy: 'preserve' | 'adopt-first-source-if-empty'; digest: string;
  recordRevision: number; items: ReviewUploadItem[] };
export type ReviewUploadResult = { envelope: ReviewUploadEnvelope; state: 'pending' | 'retryable' | 'adopted' | 'complete' | 'conflict';
  draft?: ReviewDraft; applyToPage: boolean; reason?: string };
export type ReviewUploadRecoveryOptions = UploadRecoveryDependencies & { current: () => boolean;
  snapshot: () => ReviewUploadPageSnapshot | undefined; signal?: AbortSignal };
type ReviewBusinessApi = { drafts(): Promise<Pick<ReviewWorkspace, 'draft' | 'message_drafts'>>;
  saveDraft(input: ReviewDraftRequest): Promise<unknown>; workspace(reportId?: string): Promise<ReviewWorkspace> };
export class ReviewUploadRecoveryError extends UserFacingError { constructor(message: string) { super(message); this.name = 'ReviewUploadRecoveryError'; } }

const purpose = 'review-upload', maxEnvelopeLength = 50_000_000;
const stages: ReviewUploadStage[] = ['prepared', 'material_saved', 'adoption_prepared', 'adoption_unknown', 'adopted', 'cleanup_pending', 'complete'];
const validId = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => object(v) && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const canonical = (v: unknown): string => JSON.stringify(v, (_key, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const reviewUploadSame = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const digest = (v: unknown) => qaRecoveryDigest(canonical(v));
const pin = (m: Dto<'MaterialResponse'>): ReviewMaterialPin => ({ material_id: m.material_id, material_version: m.material_version, sha256: m.sha256 });
const samePin = (a: ReviewMaterialPin | null, b: ReviewMaterialPin | null) => reviewUploadSame(a, b);
const fail = (message: string): never => { throw new ReviewUploadRecoveryError(message); };
const check: (condition: unknown, message?: string) => asserts condition = (condition, message = '原上传与复核准备无法核实，请保留记录后核对。') => { if (!condition) fail(message); };

/** Public schema plus the server's material uniqueness and complete-pin relations. */
export function reviewUploadValidInput(value: unknown): value is ReviewDraftInput {
  if (!Value.Check(ReviewDraftInputSchema, value) || new Set(value.material_versions.map(p => p.material_id)).size !== value.material_versions.length) return false;
  if (value.as_of !== null && (!Number.isFinite(Date.parse(value.as_of)) || new Date(value.as_of).toISOString().slice(0, 10) !== value.as_of)) return false;
  const selected = (p: ReviewMaterialPin) => value.material_versions.some(other => samePin(p, other));
  return (!value.source_material_ref || selected(value.source_material_ref)) && (value.evidence_links ?? []).every(link => selected(link.material_ref));
}
function draft(value: unknown): ReviewDraft {
  check(object(value) && integer(value.version), '服务器原草稿版本无法核实，尚未继续保存。');
  const { version, ...input } = value; check(reviewUploadValidInput(input), '服务器原草稿完整内容无法核实，尚未继续保存。');
  return { ...clone(input), version } as ReviewDraft;
}
function inputOf(value: ReviewDraft): ReviewDraftInput { const { version: _version, ...input } = value; return clone(input); }
function declaration(value: unknown): value is Dto<'UploadCreateRequest'> {
  return Value.Check(schemas.UploadCreateRequest, value) && value.byte_size > 0 && value.byte_size <= M1_UPLOAD_LIMITS.fileBytes &&
    (!['historical', 'reference'].includes(value.role) || M1_UPLOAD_MIME_TYPES.slice(0, 2).includes(value.media_type as typeof M1_UPLOAD_MIME_TYPES[0]));
}
function cacheCompatible(raw: string | null, owner: string, projectId: string, base: ReviewUploadPageSnapshot) {
  if (raw === null) return true;
  try { const value: unknown = JSON.parse(raw); return exact(value, ['owner', 'project_id', 'version', 'input']) && value.owner === owner && value.project_id === projectId && value.version === base.version && reviewUploadSame(value.input, base.input); } catch { return false; }
}
function identity(e: Omit<ReviewUploadEnvelope, 'digest'> | ReviewUploadEnvelope) {
  return { version: 1, owner: e.owner, projectId: e.projectId, id: e.id, kind: e.kind, baseVersion: e.baseVersion, baseInput: e.baseInput,
    baseCacheRaw: e.baseCacheRaw, targetContext: e.targetContext, targetGuard: e.targetGuard, sourcePolicy: e.sourcePolicy,
    items: e.items.map(({ id, index, declaration }) => ({ id, index, declaration })) };
}
function targetGuard(report: ReviewReport): ReviewUploadTargetGuard {
  return { report_id: report.report_id, version: report.version, run_id: report.run_id, input_revision: report.input_revision, source_material: clone(report.source_material), digest: digest(report) };
}
function targetMatches(context: ReviewContext, report: ReviewReport, projectId: string) {
  if (!Value.Check(ReviewContextSchema, context) || context.project_id !== projectId || !context.report_id || !context.finding_ids.length ||
    !isReviewReport(report) || report.project_id !== projectId || report.report_id !== context.report_id ||
    context.finding_ids.some(id => !report.findings.some(f => f.finding_id === id)) || new Set(context.material_refs.map(canonical)).size !== context.material_refs.length) return false;
  const refs = report.findings.filter(f => context.finding_ids.includes(f.finding_id)).flatMap(f => [...f.target_refs, ...f.evidence_refs]);
  return context.material_refs.every(p => refs.some(ref => ref.material_id === p.material_id && ref.material_version === p.material_version && ref.material_sha256 === p.sha256));
}
/** Preserve every unrelated field and link; a changed version cannot strand old source/evidence pins. */
export function reviewUploadAdoptionInput(e: ReviewUploadEnvelope, item: ReviewUploadItem): ReviewDraftInput {
  check(item.material && item.adoptionBase, '原文件与原采用基础尚未确认。');
  const input = clone(item.adoptionBase.input), materialPin = pin(item.material), index = input.material_versions.findIndex(p => p.material_id === materialPin.material_id);
  if (index < 0) input.material_versions.push(materialPin); else input.material_versions[index] = materialPin;
  if (e.sourcePolicy === 'adopt-first-source-if-empty' && !input.source_material_ref && ['historical', 'reference'].includes(item.declaration.role)) input.source_material_ref = clone(materialPin);
  if (e.targetContext) {
    const links = input.evidence_links ?? [];
    for (const finding_id of e.targetContext.finding_ids) if (!links.some(link => link.report_id === e.targetContext!.report_id && link.finding_id === finding_id && samePin(link.material_ref, materialPin))) links.push({ report_id: e.targetContext.report_id!, finding_id, material_ref: clone(materialPin) });
    input.evidence_links = links;
  }
  check(reviewUploadValidInput(input), '原来源或旧补证与本文件版本冲突，或材料数量已超限。文件已保存，未删除旧关联或覆盖草稿。'); return input;
}
function normalize(value: unknown, owner: string, projectId: string): ReviewUploadEnvelope {
  check(exact(value, ['version', 'owner', 'projectId', 'id', 'kind', 'baseVersion', 'baseInput', 'baseCacheRaw', 'targetContext', 'targetGuard', 'sourcePolicy', 'digest', 'recordRevision', 'items']) &&
    value.version === 1 && value.owner === owner && value.projectId === projectId && validId(value.id) && ['material', 'evidence'].includes(String(value.kind)) && integer(value.baseVersion) &&
    reviewUploadValidInput(value.baseInput) && (value.baseCacheRaw === null || typeof value.baseCacheRaw === 'string') && integer(value.recordRevision) && hash(value.digest) && Array.isArray(value.items) && value.items.length > 0 && value.items.length <= 60);
  const e = value as unknown as ReviewUploadEnvelope;
  check(cacheCompatible(e.baseCacheRaw, owner, projectId, { version: e.baseVersion, input: e.baseInput }));
  check(e.sourcePolicy === (e.baseInput.source_material_ref ? 'preserve' : 'adopt-first-source-if-empty'));
  if (e.kind === 'material') check(e.targetContext === null && e.targetGuard === null);
  else {
    check(Value.Check(ReviewContextSchema, e.targetContext) && e.targetContext?.project_id === projectId && e.targetContext.report_id && e.targetContext.finding_ids.length &&
      new Set(e.targetContext.material_refs.map(canonical)).size === e.targetContext.material_refs.length &&
      exact(e.targetGuard, ['report_id', 'version', 'run_id', 'input_revision', 'source_material', 'digest']) && e.targetGuard.report_id === e.targetContext.report_id &&
      integer(e.targetGuard.version) && e.targetGuard.version > 0 && Value.Check(ReviewReportSchema.properties.run_id, e.targetGuard.run_id) && integer(e.targetGuard.input_revision) && e.targetGuard.input_revision > 0 &&
      Value.Check(ReviewReportSchema.properties.source_material, e.targetGuard.source_material) && hash(e.targetGuard.digest));
  }
  let previous: ReviewUploadItem | undefined;
  for (const [index, item] of e.items.entries()) {
    check(exact(item, ['id', 'index', 'declaration', 'stage', 'localCacheResult', 'coreCleaned'], ['material', 'adoptionBase', 'adoptionRequest', 'adoptionDigest', 'observedDraft']) &&
      validId(item.id) && item.index === index && declaration(item.declaration) && stages.includes(item.stage) && ['pending', 'cleared', 'preserved'].includes(item.localCacheResult) && typeof item.coreCleaned === 'boolean');
    const stage = stages.indexOf(item.stage);
    if (index > 0 && stage > 0) check(previous?.stage === 'complete' && previous.localCacheResult === 'cleared', '原有序批次的前项尚未核实。');
    if (stage === 0) check(!Object.hasOwn(item, 'material') && !Object.hasOwn(item, 'adoptionBase'));
    else {
      check(item.material && exact(item.adoptionBase, ['version', 'input', 'cacheRaw']) && integer(item.adoptionBase.version) && reviewUploadValidInput(item.adoptionBase.input) && (item.adoptionBase.cacheRaw === null || typeof item.adoptionBase.cacheRaw === 'string'));
      validateUploadMaterial(item.declaration, item.material);
      const expected = index === 0 ? { version: e.baseVersion, input: e.baseInput, cacheRaw: e.baseCacheRaw } : { version: previous!.observedDraft!.version, input: inputOf(previous!.observedDraft!), cacheRaw: null };
      check(reviewUploadSame(item.adoptionBase, expected));
    }
    if (stage < 2) check(!Object.hasOwn(item, 'adoptionRequest') && !Object.hasOwn(item, 'adoptionDigest') && !Object.hasOwn(item, 'observedDraft'));
    else {
      check(item.adoptionRequest && Value.Check(ReviewDraftRequestSchema, item.adoptionRequest) && item.adoptionRequest.kind === 'input' && item.adoptionRequest.expected_version === item.adoptionBase!.version &&
        reviewUploadSame(item.adoptionRequest.input, reviewUploadAdoptionInput(e, item)) && hash(item.adoptionDigest) && digest(item.adoptionRequest) === item.adoptionDigest);
      if (item.observedDraft) draft(item.observedDraft);
      if (stage >= 4) check(item.observedDraft && item.observedDraft.version === item.adoptionRequest.expected_version + 1 && reviewUploadSame(inputOf(item.observedDraft), item.adoptionRequest.input));
    }
    if (stage < 5) check(item.localCacheResult === 'pending' && !item.coreCleaned);
    if (stage === 6) check(item.localCacheResult !== 'pending' && item.coreCleaned);
    previous = item;
  }
  check(new Set(e.items.map(item => item.id)).size === e.items.length && digest(identity(e)) === e.digest); return clone(e);
}
export function reviewUploadContext(e: ReviewUploadEnvelope, index: number): UploadRecoveryJson { return { version: 1, kind: e.kind, envelope_id: e.id, digest: e.digest, item_index: index }; }
export function reviewUploadRecordMatches(e: ReviewUploadEnvelope, index: number, record: UploadRecoveryRecord) {
  const item = e.items[index]; return !!item && record.owner === e.owner && record.projectId === e.projectId && record.purpose === purpose && record.id === item.id && reviewUploadSame(record.declaration, item.declaration) && reviewUploadSame(record.context, reviewUploadContext(e, index));
}
const browserLock: UploadRecoveryLock = { async run<T>(name: string, action: () => Promise<T>, signal?: AbortSignal) {
  signal?.throwIfAborted(); const locks = globalThis.navigator?.locks; if (!locks) throw new UploadRecoveryLockError();
  return locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => { if (!lock) throw new UploadRecoveryLockError(); signal?.throwIfAborted(); return action(); });
} };

/** No background work: only explicit prepare/resume/stop can write transport or draft APIs. */
export class ReviewUploadRecovery {
  private prefix: string; private cacheKey: string; private core: UploadRecovery;
  constructor(private api: ConstructorParameters<typeof UploadRecovery>[0], private review: ReviewBusinessApi, private owner: string, private projectId: string, private options: ReviewUploadRecoveryOptions) {
    check(validId(owner) && validId(projectId)); this.prefix = `bb-review-upload-v1:${encodeURIComponent(owner)}:${encodeURIComponent(projectId)}:`;
    this.cacheKey = `bb-review-input:${owner}:${projectId}`; this.core = new UploadRecovery(api, owner, projectId, purpose, options.current, options);
  }
  private live() { this.options.signal?.throwIfAborted(); if (!this.options.current()) throw new DOMException('当前复核页面或账号已变更。', 'AbortError'); }
  private store(): UploadRecoveryStorage { try { const store = this.options.store ?? globalThis.localStorage; if (store) return store; } catch {} throw new UploadRecoveryStorageError(); }
  private cacheRaw() { this.live(); try { return this.store().getItem(this.cacheKey); } catch { throw new UploadRecoveryStorageError(); } }
  private nonce() { const id = this.options.id?.() ?? crypto.randomUUID(); check(validId(id)); return id; }
  private async locked<T>(action: () => Promise<T>): Promise<T> { this.live(); return (this.options.lock ?? browserLock).run(this.prefix + 'project-lock', async () => { this.live(); return action(); }, this.options.signal); }
  list(): ReviewUploadEnvelope[] {
    this.live();
    try {
      const store = this.store(), keys: string[] = [], length = store.length;
      for (let i = 0; i < length; i++) { const key = store.key(i); if (key?.startsWith(this.prefix)) keys.push(key); }
      if (store.length !== length || new Set(keys).size !== keys.length) throw new UploadRecoveryStorageError();
      return keys.map(key => { const raw = store.getItem(key); if (raw === null || raw.length > maxEnvelopeLength) throw new UploadRecoveryStorageError();
        const value = normalize(JSON.parse(raw), this.owner, this.projectId); if (key !== this.prefix + encodeURIComponent(value.id) || store.getItem(key) !== raw) throw new UploadRecoveryStorageError(); return value; });
    } catch (error) { if (error instanceof ReviewUploadRecoveryError || error instanceof UploadRecoveryStorageError) throw error; throw new UploadRecoveryStorageError(); }
  }
  transportRecords() { this.live(); return this.core.list(); }
  private read(id: string) { const e = this.list().find(e => e.id === id); check(e, '原复核上传记录已移除，未重新建立上传或采用。'); return e; }
  private unchanged(e: ReviewUploadEnvelope) { check(reviewUploadSame(this.read(e.id), e), '另一页面已改变原上传进度，当前页面已停止推进。'); }
  private write(e: ReviewUploadEnvelope, expected: ReviewUploadEnvelope | null) {
    this.live(); const checked = normalize(e, this.owner, this.projectId), all = this.list(), previous = all.find(value => value.id === e.id);
    check(expected === null ? !previous && all.length === 0 : previous && reviewUploadSame(previous, expected) && e.recordRevision === expected.recordRevision + 1 && e.digest === expected.digest, '另一页面已改变原上传准备，未覆盖该记录。');
    if (expected) for (const [index, item] of checked.items.entries()) {
      const old = expected.items[index]; check(stages.indexOf(item.stage) >= stages.indexOf(old.stage));
      for (const field of ['material', 'adoptionBase', 'adoptionRequest', 'adoptionDigest'] as const) if (old[field] !== undefined) check(reviewUploadSame(old[field], item[field]));
      if (stages.indexOf(old.stage) >= 4) check(reviewUploadSame(old.observedDraft, item.observedDraft));
    }
    try { const raw = JSON.stringify(checked); if (raw.length > maxEnvelopeLength) throw new Error(); const store = this.store(), key = this.prefix + encodeURIComponent(e.id); store.setItem(key, raw); if (store.getItem(key) !== raw) throw new Error(); return checked; } catch { throw new UploadRecoveryStorageError(); }
  }
  private update(e: ReviewUploadEnvelope, index: number, change: Partial<ReviewUploadItem>) { const next = clone(e); Object.assign(next.items[index], change); next.recordRevision++; return this.write(next, e); }
  private remove(e: ReviewUploadEnvelope) { this.live(); this.unchanged(e); try { const store = this.store(), key = this.prefix + encodeURIComponent(e.id); store.removeItem(key); if (store.getItem(key) !== null) throw new Error(); } catch { throw new UploadRecoveryStorageError(); } }
  private pageMatches(base: ReviewUploadAdoptionBase) { const page = this.options.snapshot(); return !!page && page.version === base.version && reviewUploadSame(page.input, base.input); }
  private pageMatchesAdoption(item: ReviewUploadItem) { const page = this.options.snapshot(); return !!item.adoptionBase && (this.pageMatches(item.adoptionBase) || !!page && !!item.observedDraft && page.version === item.observedDraft.version && reviewUploadSame(page.input, inputOf(item.observedDraft))); }
  private requireBase(base: ReviewUploadAdoptionBase) { check(this.pageMatches(base) && this.cacheRaw() === base.cacheRaw, '材料或要求已在本页或其他页面改变。原文件保留，未覆盖当前准备。'); }
  private async readDraft() { const value = await this.review.drafts(); this.live(); return draft(value?.draft); }
  private async verifyTarget(e: ReviewUploadEnvelope) {
    if (!e.targetContext) return;
    const workspace = await this.review.workspace(e.targetContext.report_id!); this.live(); this.unchanged(e);
    check(workspace.project?.project_id === this.projectId && workspace.selected_report && targetMatches(e.targetContext, workspace.selected_report, this.projectId) && reviewUploadSame(targetGuard(workspace.selected_report), e.targetGuard), '原报告或问题已变化或不可读取，材料没有转到当前报告。');
  }
  async prepare(files: File[], role: Dto<'UploadCreateRequest'>['role'], target?: ReviewContext): Promise<ReviewUploadEnvelope> {
    return this.locked(async () => {
      check(!this.list().length && !this.core.list().length, '请先确认原文件或移除本机待办，再选择新文件。');
      const page = this.options.snapshot(); check(page && integer(page.version) && page.version < Number.MAX_SAFE_INTEGER && reviewUploadValidInput(page.input));
      const base = clone(page), raw = this.cacheRaw(); check(cacheCompatible(raw, this.owner, this.projectId, base), '原材料与要求尚未可靠保存，未开始上传。');
      const saved = await this.readDraft(); check(saved.version === base.version && reviewUploadSame(inputOf(saved), base.input), '服务器原材料与要求尚未保存或已变化，未开始上传。');
      let guard: ReviewUploadTargetGuard | null = null, targetContext: ReviewContext | null = target ? clone(target) : null;
      if (targetContext) { const workspace = await this.review.workspace(targetContext.report_id ?? undefined); this.live();
        check(workspace.project?.project_id === this.projectId && workspace.selected_report && targetMatches(targetContext, workspace.selected_report, this.projectId), '无法核实原报告与问题，未建立补证上传。'); guard = targetGuard(workspace.selected_report); }
      check(files.length > 0 && files.length <= 60, '请每批选择 1 至 60 份材料。');
      const media: Record<string, typeof M1_UPLOAD_MIME_TYPES[number]> = { docx: M1_UPLOAD_MIME_TYPES[0], pdf: M1_UPLOAD_MIME_TYPES[1], xlsx: M1_UPLOAD_MIME_TYPES[2], csv: M1_UPLOAD_MIME_TYPES[3], txt: M1_UPLOAD_MIME_TYPES[4], png: M1_UPLOAD_MIME_TYPES[5], jpg: M1_UPLOAD_MIME_TYPES[6], jpeg: M1_UPLOAD_MIME_TYPES[6] };
      const items: ReviewUploadItem[] = [];
      for (const [index, file] of files.entries()) {
        const media_type = media[file.name.split('.').at(-1)?.toLowerCase() ?? ''];
        check(media_type && file.size > 0 && file.size <= M1_UPLOAD_LIMITS.fileBytes && (!['historical', 'reference'].includes(role) || M1_UPLOAD_MIME_TYPES.slice(0, 2).includes(media_type as typeof M1_UPLOAD_MIME_TYPES[0])), '历史或参考募集书仅支持 DOCX/PDF；其他材料须为支持格式且不超过 100 MB。');
        const sha256 = this.options.digest ? await this.options.digest(file) : [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(v => v.toString(16).padStart(2, '0')).join(''); this.live();
        items.push({ id: this.nonce(), index, declaration: { filename: file.name, role, media_type, byte_size: file.size, sha256 }, stage: 'prepared', localCacheResult: 'pending', coreCleaned: false });
      }
      this.requireBase({ ...base, cacheRaw: raw });
      const value: Omit<ReviewUploadEnvelope, 'digest'> = { version: 1, owner: this.owner, projectId: this.projectId, id: this.nonce(), kind: targetContext ? 'evidence' : 'material', baseVersion: base.version, baseInput: base.input, baseCacheRaw: raw,
        targetContext, targetGuard: guard, sourcePolicy: base.input.source_material_ref ? 'preserve' : 'adopt-first-source-if-empty', recordRevision: 0, items };
      const e = this.write({ ...value, digest: digest(identity(value)) }, null);
      for (const item of e.items) this.core.begin(item.declaration, reviewUploadContext(e, item.index), item.id); return e;
    });
  }
  private result(e: ReviewUploadEnvelope, index: number, state: ReviewUploadResult['state'], reason?: string): ReviewUploadResult {
    const item = e.items[index], adopted = stages.indexOf(item.stage) >= 4;
    return { envelope: clone(e), state, applyToPage: adopted && item.localCacheResult === 'cleared' && this.pageMatchesAdoption(item), ...(adopted ? { draft: clone(item.observedDraft!) } : {}), ...(reason ? { reason } : {}) };
  }
  private async cleanup(e: ReviewUploadEnvelope, index: number): Promise<ReviewUploadResult> {
    let item = e.items[index]; check(stages.indexOf(item.stage) >= 4);
    if (item.stage !== 'complete' && item.stage !== 'cleanup_pending') { e = this.update(e, index, { stage: 'cleanup_pending' }); item = e.items[index]; }
    if (item.localCacheResult === 'pending') {
      const raw = this.cacheRaw(), matches = (raw === item.adoptionBase!.cacheRaw || raw === null) && this.pageMatchesAdoption(item);
      if (matches) {
        this.unchanged(e); this.live(); try { this.store().removeItem(this.cacheKey); if (this.store().getItem(this.cacheKey) !== null) throw new Error(); } catch { throw new UploadRecoveryStorageError(); }
        e = this.update(e, index, { localCacheResult: 'cleared' });
      } else e = this.update(e, index, { localCacheResult: 'preserved' });
      item = e.items[index];
    }
    if (!item.coreCleaned) { this.unchanged(e); await this.core.forget(item.id); this.live(); this.unchanged(e); e = this.update(e, index, { coreCleaned: true }); }
    if (e.items[index].stage !== 'complete') e = this.update(e, index, { stage: 'complete' });
    if (e.items.every(item => item.stage === 'complete')) { this.remove(e); return this.result(e, index, 'complete', e.items[index].localCacheResult === 'preserved' ? '原采用已确认；本页或其他页面另有修改，已保留。' : undefined); }
    return this.result(e, index, 'adopted', e.items[index].localCacheResult === 'preserved' ? '原采用已确认；本页或其他页面另有修改，后续材料尚未采用。' : undefined);
  }
  private async observe(e: ReviewUploadEnvelope, index: number): Promise<ReviewUploadResult> {
    const item = e.items[index]; check(item.adoptionRequest && item.adoptionBase);
    await this.verifyTarget(e); const observed = await this.readDraft(); this.unchanged(e);
    e = this.update(e, index, { observedDraft: observed }); const v = item.adoptionRequest.expected_version, input = inputOf(observed);
    if (observed.version === v + 1 && reviewUploadSame(input, item.adoptionRequest.input)) { e = this.update(e, index, { stage: 'adopted' }); return this.cleanup(e, index); }
    if (observed.version === v && reviewUploadSame(input, item.adoptionBase.input)) return this.result(e, index, 'retryable', '尚未观察到原材料选择保存。可明确重试同一份原保存；未自动再次提交。');
    return this.result(e, index, 'conflict', '服务器原输入已变化，原材料选择的保存尚未核实；未重基或覆盖后续内容。');
  }
  private async submit(e: ReviewUploadEnvelope, index: number): Promise<ReviewUploadResult> {
    const item = e.items[index]; check(item.adoptionRequest && item.adoptionBase); this.requireBase(item.adoptionBase); this.unchanged(e);
    e = this.update(e, index, { stage: 'adoption_unknown' }); this.requireBase(item.adoptionBase); this.unchanged(e); this.live();
    try { await this.review.saveDraft(clone(item.adoptionRequest)); } catch { this.live(); /* Even a lost response must first reconcile by GET, never replay here. */ }
    this.live(); this.unchanged(e); return this.observe(e, index);
  }
  async reconcile(id: string, index: number): Promise<ReviewUploadResult> {
    return this.locked(async () => { const e = this.read(id), item = e.items[index]; check(item); if (stages.indexOf(item.stage) >= 4) return this.result(e, index, 'adopted');
      if (!item.adoptionRequest) return this.result(e, index, 'pending'); return this.observe(e, index); });
  }
  async resume(id: string, index: number, options: Omit<UploadRecoveryResumeOptions, 'signal' | 'previousRecord'> & { retryAdoption?: boolean } = {}): Promise<ReviewUploadResult> {
    return this.locked(async () => {
      let e = this.read(id), item = e.items[index]; check(item);
      if (index > 0) check(e.items[index - 1].stage === 'complete' && e.items[index - 1].localCacheResult === 'cleared', '请先核实这一批中的前一份原材料；未采用后续材料。');
      if (stages.indexOf(item.stage) >= 4) return this.cleanup(e, index);
      if (item.adoptionRequest) {
        const observed = await this.observe(e, index); if (observed.state !== 'retryable' || !options.retryAdoption) return observed;
        e = this.read(id); await this.verifyTarget(e); return this.submit(e, index);
      }
      const base: ReviewUploadAdoptionBase = index === 0 ? { version: e.baseVersion, input: clone(e.baseInput), cacheRaw: e.baseCacheRaw } : { version: e.items[index - 1].observedDraft!.version, input: inputOf(e.items[index - 1].observedDraft!), cacheRaw: null };
      this.requireBase(base);
      const record = this.core.list().find(record => record.id === item.id); check(record && reviewUploadRecordMatches(e, index, record), '原上传记录已丢失或关联不一致，未新建上传或采用当前准备。');
      const material = await this.core.resume(item.id, { ...options, signal: this.options.signal }); this.live(); this.unchanged(e);
      if (!item.material) {
        e = this.update(e, index, { material: validateUploadMaterial(item.declaration, material), adoptionBase: base, stage: 'material_saved' }); item = e.items[index];
      } else check(reviewUploadSame(item.material, validateUploadMaterial(item.declaration, material)), '原已保存文件的准确版本已变化，未替换引用。');
      this.requireBase(base); await this.verifyTarget(e); const saved = await this.readDraft(); this.unchanged(e); this.requireBase(base);
      check(saved.version === base.version && reviewUploadSame(inputOf(saved), base.input), '服务器原准备已改变。文件已保存，未加入另一份材料选择。');
      if (base.input.source_material_ref) { const p = base.input.source_material_ref, value = await this.api.material(this.projectId, p.material_id, this.options.signal, p.material_version); this.live(); this.unchanged(e);
        check(Value.Check(schemas.MaterialResponse, value) && value.state === 'persisted' && samePin(pin(value), p) && M1_UPLOAD_MIME_TYPES.slice(0, 2).includes(value.media_type as typeof M1_UPLOAD_MIME_TYPES[0]), '原待复核来源文件或准确版本无法核实，未替换来源。'); }
      this.requireBase(base);
      const request: ReviewUploadAdoptionRequest = { kind: 'input', expected_version: base.version, input: reviewUploadAdoptionInput(e, item) };
      e = this.update(e, index, { adoptionRequest: request, adoptionDigest: digest(request), stage: 'adoption_prepared' }); return this.submit(e, index);
    });
  }
  async stop(id: string): Promise<void> { return this.locked(async () => { const e = this.read(id); for (const item of e.items) { const record = this.core.list().find(record => record.id === item.id); check(!record || reviewUploadRecordMatches(e, item.index, record)); await this.core.forget(item.id); this.live(); this.unchanged(e); } this.remove(e); }); }
  async removeOrphan(id: string): Promise<void> { return this.locked(async () => { check(!this.list().some(e => e.items.some(item => item.id === id)), '这份文件仍有原准备记录，请从原待办继续或停止。'); const record = this.core.list().find(record => record.id === id); check(record, '原本机记录已移除。'); await this.core.forget(id); this.live(); }); }
}
