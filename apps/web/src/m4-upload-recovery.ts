import { M1_UPLOAD_LIMITS, M1_UPLOAD_MIME_TYPES, M4_DOCUMENT_TYPES, M4DraftInputSchema, M4DraftRequestSchema,
  M4MaterialPinSchema, M4RequirementSchema, M4ViewStateSchema, M4MessageRequestSchema, M4ExecuteRequestSchema, schemas,
  type M4DocumentType, type M4Draft, type M4DraftInput, type M4DraftRequest, type M4MaterialPin, type M4Requirement, type M4Workspace } from './billing-types.js';
import { Value } from '@sinclair/typebox/value';
import { UserFacingError } from './user-facing-error.js';
import type { Dto } from './api.js';
import { qaRecoveryDigest } from './qa-recovery-journal.js';
import { UploadRecovery, UploadRecoveryLockError, UploadRecoveryStorageError, validateUploadMaterial,
  type UploadRecoveryDependencies, type UploadRecoveryJson, type UploadRecoveryRecord, type UploadRecoveryResumeOptions,
  type UploadRecoveryStorage, type UploadRecoveryLock } from './upload-recovery.js';

export type M4UploadPageSnapshot = { version: number; input: M4DraftInput; dirty: boolean; conflict: boolean };
export type M4UploadStage = 'prepared' | 'material_saved' | 'library_registration_unknown' | 'library_registered' | 'draft_prepared' | 'draft_unknown' | 'draft_confirmed' | 'content_satisfied_pending_unknown' | 'cleanup_pending' | 'complete';
export type M4UploadItem = { id: string; index: number; declaration: Dto<'UploadCreateRequest'>; stage: M4UploadStage;
  material?: Dto<'MaterialResponse'>; adoptionBase?: M4UploadPageSnapshot; cacheTarget?: M4UploadPageSnapshot | null;
  draftRequest?: M4DraftRequest; requestDigest?: string; pending?: M4Requirement[]; expectedInput?: M4DraftInput;
  observedDraft?: M4Draft; localCacheResult: 'pending' | 'patched' | 'preserved'; coreCleaned: boolean };
export type M4UploadEnvelope = { version: 1; owner: string; projectId: string; topicId: string; id: string;
  purpose: 'source' | 'material'; documentType: M4DocumentType; sourcePolicy: 'replace-source-only' | 'append-material-only';
  basePage: M4UploadPageSnapshot; baseCacheTarget: M4UploadPageSnapshot | null; basePending: { message: null; execution: null }; digest: string; recordRevision: number; items: M4UploadItem[] };
export type M4UploadResult = { envelope: M4UploadEnvelope; state: 'pending' | 'retryable' | 'content_confirmed' | 'pending_unknown' | 'complete' | 'conflict'; draft?: M4Draft; applyToPage: boolean; reason?: string };
export type M4UploadRecoveryOptions = UploadRecoveryDependencies & { current: () => boolean; snapshot: (type: M4DocumentType) => M4UploadPageSnapshot | undefined; signal?: AbortSignal; coordinatePrepare?: () => void };
export type M4UploadCacheMergeResult = { raw: string; accepted: string[]; rejected: string[] };
type BusinessApi = { workspace(id: string): Promise<M4Workspace>; material(id: string, pin: M4MaterialPin): Promise<unknown>; draft(id: string, input: M4DraftRequest): Promise<unknown> };
type Cache = { owner: string; topic: string; drafts: Partial<Record<M4DocumentType, M4UploadPageSnapshot>>; view?: unknown; viewVersion?: number; viewDirty?: boolean; pendingMessage?: unknown; pendingExecution?: unknown };
export class M4UploadRecoveryError extends UserFacingError { constructor(message: string) { super(message); this.name = 'M4UploadRecoveryError'; } }

const purpose = 'm4-upload', maxLength = 50_000_000;
const stages: M4UploadStage[] = ['prepared', 'material_saved', 'library_registration_unknown', 'library_registered', 'draft_prepared', 'draft_unknown', 'draft_confirmed', 'content_satisfied_pending_unknown', 'cleanup_pending', 'complete'];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => object(v) && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const canonical = (v: unknown): string => JSON.stringify(v, (_k, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const m4UploadSame = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const digest = (v: unknown) => qaRecoveryDigest(canonical(v));
const check: (v: unknown, message?: string) => asserts v = (v, message = '原文件生成上传记录无法核实，请保留记录后核对。') => { if (!v) throw new M4UploadRecoveryError(message); };
const pin = (projectId: string, m: Dto<'MaterialResponse'>): M4MaterialPin => ({ source_project_id: projectId, material_id: m.material_id, material_version: m.material_version, sha256: m.sha256 });
const validPin = (v: unknown): v is M4MaterialPin => Value.Check(M4MaterialPinSchema, v) && integer(v.material_version);
const validRows = (v: unknown): v is M4Requirement[] => Array.isArray(v) && v.length <= 100 && v.every(r => Value.Check(M4RequirementSchema, r) && integer(r.message_version)) && new Set(v.map(r => r.requirement_id)).size === v.length;
export function m4UploadValidInput(v: unknown): v is M4DraftInput {
  return Value.Check(M4DraftInputSchema, v) && (!v.project_file || integer(v.project_file.source_selection_revision)) &&
    (!v.source_material || validPin(v.source_material)) && v.materials.every(validPin) && new Set(v.materials.map(p => `${p.material_id}:${p.material_version}`)).size === v.materials.length &&
    (!v.template || integer(v.template.template_version)) && (!v.edit_base || integer(v.edit_base.artifact_version)) && validRows(v.requirements);
}
function snapshot(v: unknown): v is M4UploadPageSnapshot { return exact(v, ['version', 'input', 'dirty', 'conflict']) && integer(v.version) && v.version < Number.MAX_SAFE_INTEGER && m4UploadValidInput(v.input) && typeof v.dirty === 'boolean' && typeof v.conflict === 'boolean'; }
export function m4UploadInputOf(value: M4Draft): M4DraftInput { const { version: _v, sha256: _s, updated_at: _t, ...input } = value; return clone(input); }
function draft(v: unknown, type: M4DocumentType): M4Draft {
  check(object(v) && integer(v.version) && v.version < Number.MAX_SAFE_INTEGER && hash(v.sha256) && (v.updated_at === null || typeof v.updated_at === 'string' && Number.isFinite(Date.parse(v.updated_at))), '服务器原草稿版本无法核实。');
  const value = v as unknown as M4Draft; check(m4UploadValidInput(m4UploadInputOf(value)) && value.document_type === type, '服务器原草稿完整内容无法核实。'); return clone(value);
}
const pageOf = (d: M4Draft): M4UploadPageSnapshot => ({ version: d.version, input: m4UploadInputOf(d), dirty: false, conflict: false });
function declaration(v: unknown, kind: 'source' | 'material'): v is Dto<'UploadCreateRequest'> {
  return Value.Check(schemas.UploadCreateRequest, v) && v.byte_size > 0 && v.byte_size <= M1_UPLOAD_LIMITS.fileBytes && v.role === (kind === 'source' ? 'historical' : 'other') && (kind !== 'source' || M1_UPLOAD_MIME_TYPES.slice(0, 2).includes(v.media_type as typeof M1_UPLOAD_MIME_TYPES[0]));
}
function mergePending(input: M4DraftInput, pending: M4Requirement[]) { const next = clone(input); for (const row of pending) if (!next.requirements.some(r => r.requirement_id === row.requirement_id)) next.requirements.push(clone(row)); check(m4UploadValidInput(next), '合并原待采用要求后已超限或内容无法核实，未裁剪要求。'); return next; }
export function m4UploadAdoptionInput(e: M4UploadEnvelope, item: M4UploadItem): M4DraftInput {
  check(item.material && item.adoptionBase); const next = clone(item.adoptionBase.input), p = pin(e.projectId, item.material);
  if (e.purpose === 'source') { check(!next.project_file || m4UploadSame(next.source_material, p), '原草稿含项目文件来源约束，新来源关系无法核实。文件已保存，未移除原约束。'); next.source_material = p; }
  else { const old = next.materials.find(m => m.material_id === p.material_id && m.material_version === p.material_version); check(!old || m4UploadSame(old, p), '原材料版本已有不同准确引用，未替换原引用。'); if (!old) next.materials.push(p); }
  check(m4UploadValidInput(next), '原完整草稿无法采用这份文件或数量已超限，未裁剪原内容。'); return next;
}
function identity(e: Omit<M4UploadEnvelope, 'digest'> | M4UploadEnvelope) { return { version: 1, owner: e.owner, projectId: e.projectId, topicId: e.topicId, id: e.id, purpose: e.purpose, documentType: e.documentType, sourcePolicy: e.sourcePolicy, basePage: e.basePage, baseCacheTarget: e.baseCacheTarget, basePending: e.basePending, items: e.items.map(({ id, index, declaration }) => ({ id, index, declaration })) }; }
function normalize(v: unknown, owner: string, projectId: string, topicId: string): M4UploadEnvelope {
  check(exact(v, ['version', 'owner', 'projectId', 'topicId', 'id', 'purpose', 'documentType', 'sourcePolicy', 'basePage', 'baseCacheTarget', 'basePending', 'digest', 'recordRevision', 'items']) && v.version === 1 && v.owner === owner && v.projectId === projectId && v.topicId === topicId && id(v.id) && ['source', 'material'].includes(String(v.purpose)) && M4_DOCUMENT_TYPES.includes(v.documentType as M4DocumentType) && snapshot(v.basePage) && !v.basePage.dirty && !v.basePage.conflict && (v.baseCacheTarget === null || snapshot(v.baseCacheTarget) && m4UploadSame(v.baseCacheTarget, v.basePage)) && exact(v.basePending, ['message', 'execution']) && v.basePending.message === null && v.basePending.execution === null && hash(v.digest) && integer(v.recordRevision) && Array.isArray(v.items) && v.items.length > 0 && v.items.length <= 60);
  const e = v as unknown as M4UploadEnvelope; check(e.basePage.input.document_type === e.documentType && e.sourcePolicy === (e.purpose === 'source' ? 'replace-source-only' : 'append-material-only'));
  let previous: M4UploadItem | undefined;
  for (const [index, item] of e.items.entries()) {
    check(exact(item, ['id', 'index', 'declaration', 'stage', 'localCacheResult', 'coreCleaned'], ['material', 'adoptionBase', 'cacheTarget', 'draftRequest', 'requestDigest', 'pending', 'expectedInput', 'observedDraft']) && id(item.id) && item.index === index && declaration(item.declaration, e.purpose) && stages.includes(item.stage) && ['pending', 'patched', 'preserved'].includes(item.localCacheResult) && typeof item.coreCleaned === 'boolean');
    const n = stages.indexOf(item.stage); if (index > 0 && n > 0) check(previous?.stage === 'complete' && previous.localCacheResult === 'patched', '原有序批次前项尚未可靠确认。');
    if (n === 0) check(!item.material && !item.adoptionBase && !Object.hasOwn(item, 'cacheTarget'));
    else {
      check(item.material && snapshot(item.adoptionBase) && Object.hasOwn(item, 'cacheTarget') && (item.cacheTarget === null || snapshot(item.cacheTarget))); validateUploadMaterial(item.declaration, item.material);
      const expected = index === 0 ? e.basePage : pageOf(previous!.observedDraft!); check(m4UploadSame(item.adoptionBase, expected) && m4UploadSame(item.cacheTarget, index === 0 ? e.baseCacheTarget : expected));
    }
    if (n < 4) check(!item.draftRequest && !item.requestDigest && !item.pending && !item.expectedInput && !item.observedDraft);
    else {
      check(item.draftRequest && Value.Check(M4DraftRequestSchema, item.draftRequest) && item.draftRequest.expected_version === item.adoptionBase!.version && m4UploadSame(item.draftRequest.input, m4UploadAdoptionInput(e, item)) && hash(item.requestDigest) && validRows(item.pending) && m4UploadValidInput(item.expectedInput) && m4UploadSame(item.expectedInput, mergePending(item.draftRequest.input, item.pending)) && digest({ request: item.draftRequest, pending: item.pending, expected: item.expectedInput }) === item.requestDigest);
      if (item.observedDraft) draft(item.observedDraft, e.documentType);
      if (n >= 6) { check(item.observedDraft); const base = item.adoptionBase!, changed = !m4UploadSame(base.input, item.expectedInput), expectedVersion = changed || base.version === 0 ? base.version + 1 : base.version; check(item.observedDraft.version === expectedVersion && m4UploadSame(m4UploadInputOf(item.observedDraft), item.expectedInput)); }
    }
    if (n < 8) check(item.localCacheResult === 'pending' && !item.coreCleaned); if (n === 9) check(item.localCacheResult !== 'pending' && item.coreCleaned);
    previous = item;
  }
  check(new Set(e.items.map(i => i.id)).size === e.items.length && digest(identity(e)) === e.digest); return clone(e);
}
export function m4UploadContext(e: M4UploadEnvelope, index: number): UploadRecoveryJson { return { version: 1, envelope_id: e.id, declaration_digest: e.digest, item_index: index, document_type: e.documentType, purpose: e.purpose }; }
export function m4UploadRecordMatches(e: M4UploadEnvelope, index: number, r: UploadRecoveryRecord) { const item = e.items[index]; return !!item && r.id === item.id && r.owner === e.owner && r.projectId === e.projectId && r.purpose === purpose && m4UploadSame(r.declaration, item.declaration) && m4UploadSame(r.context, m4UploadContext(e, index)); }
const browserLock: UploadRecoveryLock = { async run<T>(name: string, action: () => Promise<T>, signal?: AbortSignal) { signal?.throwIfAborted(); const locks = globalThis.navigator?.locks; if (!locks) throw new UploadRecoveryLockError(); return locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => { if (!lock) throw new UploadRecoveryLockError(); signal?.throwIfAborted(); return action(); }); } };

/** Explicit business recovery. A page scan never submits a transport, membership or draft request. */
export class M4UploadRecovery {
  private prefix: string; private cacheKey: string; private lockKey: string; private core: UploadRecovery;
  constructor(private api: ConstructorParameters<typeof UploadRecovery>[0], private m4: BusinessApi, private owner: string, private projectId: string, private topicId: string, private options: M4UploadRecoveryOptions) {
    check([owner, projectId, topicId].every(id)); this.prefix = `bb-m4-upload-v1:${[owner, projectId, topicId].map(encodeURIComponent).join(':')}:`; this.cacheKey = `bb-m4:${owner}:${topicId}`;
    this.lockKey = `bb-m4-upload-lock:${encodeURIComponent(owner)}:${encodeURIComponent(topicId)}`; this.core = new UploadRecovery(api, owner, projectId, purpose, options.current, options);
  }
  private live() { this.options.signal?.throwIfAborted(); if (!this.options.current()) throw new DOMException('当前文件生成页面或账号已变更。', 'AbortError'); }
  private store(): UploadRecoveryStorage { try { const value = this.options.store ?? globalThis.localStorage; if (value) return value; } catch {} throw new UploadRecoveryStorageError(); }
  private async locked<T>(action: () => Promise<T>) { this.live(); return (this.options.lock ?? browserLock).run(this.lockKey, async () => { this.live(); return action(); }, this.options.signal); }
  private nonce() { const value = this.options.id?.() ?? crypto.randomUUID(); check(id(value)); return value; }
  list(): M4UploadEnvelope[] {
    this.live(); try { const store = this.store(), length = store.length, keys: string[] = []; for (let i = 0; i < length; i++) { const key = store.key(i); if (key?.startsWith(this.prefix)) keys.push(key); } check(store.length === length && new Set(keys).size === keys.length);
      return keys.map(key => { const raw = store.getItem(key); check(raw !== null && raw.length <= maxLength); const e = normalize(JSON.parse(raw), this.owner, this.projectId, this.topicId); check(key === this.prefix + encodeURIComponent(e.id) && store.getItem(key) === raw); return e; });
    } catch (error) { if (error instanceof M4UploadRecoveryError || error instanceof UploadRecoveryStorageError) throw error; throw new UploadRecoveryStorageError(); }
  }
  transportRecords() { this.live(); return this.core.list(); }
  private read(id: string) { const e = this.list().find(e => e.id === id); check(e, '原上传业务记录已移除，未重新建立或采用当前草稿。'); return e; }
  private unchanged(e: M4UploadEnvelope) { check(m4UploadSame(this.read(e.id), e), '另一页面已改变原上传进度，未覆盖该记录。'); }
  private write(e: M4UploadEnvelope, old: M4UploadEnvelope | null) {
    this.live(); const value = normalize(e, this.owner, this.projectId, this.topicId), all = this.list(), previous = all.find(v => v.id === e.id);
    check(old ? previous && m4UploadSame(previous, old) && e.recordRevision === old.recordRevision + 1 && e.digest === old.digest : !all.length, '另一页面已改变原上传准备，未覆盖该记录。');
    if (old) for (const [index, item] of value.items.entries()) { const before = old.items[index]; check(stages.indexOf(item.stage) >= stages.indexOf(before.stage) || before.stage === 'content_satisfied_pending_unknown' && item.stage === 'draft_confirmed'); for (const k of ['material', 'adoptionBase', 'cacheTarget', 'draftRequest', 'requestDigest', 'pending', 'expectedInput'] as const) if (Object.hasOwn(before, k)) check(m4UploadSame(item[k], before[k])); if (stages.indexOf(before.stage) >= 6) check(m4UploadSame(item.observedDraft, before.observedDraft)); }
    try { const raw = JSON.stringify(value); if (raw.length > maxLength) throw new Error(); const store = this.store(), key = this.prefix + encodeURIComponent(e.id); store.setItem(key, raw); if (store.getItem(key) !== raw) throw new Error(); return value; } catch { throw new UploadRecoveryStorageError(); }
  }
  private update(e: M4UploadEnvelope, index: number, change: Partial<M4UploadItem>) { const next = clone(e); Object.assign(next.items[index], change); next.recordRevision++; return this.write(next, e); }
  private remove(e: M4UploadEnvelope) { this.live(); this.unchanged(e); try { const store = this.store(), key = this.prefix + encodeURIComponent(e.id); store.removeItem(key); if (store.getItem(key) !== null) throw new Error(); } catch { throw new UploadRecoveryStorageError(); } }
  private cache(raw: string | null): Cache | null {
    if (raw === null) return null; try { check(raw.length <= maxLength); const v: unknown = JSON.parse(raw); check(exact(v, ['owner', 'topic', 'drafts'], ['view', 'viewVersion', 'viewDirty', 'pendingMessage', 'pendingExecution']) && v.owner === this.owner && v.topic === this.topicId && object(v.drafts) && Object.entries(v.drafts).every(([type, d]) => M4_DOCUMENT_TYPES.includes(type as M4DocumentType) && snapshot(d) && d.input.document_type === type) && (!Object.hasOwn(v, 'view') || Value.Check(M4ViewStateSchema, v.view)) && (!Object.hasOwn(v, 'viewVersion') || integer(v.viewVersion)) && (!Object.hasOwn(v, 'viewDirty') || typeof v.viewDirty === 'boolean') && (!Object.hasOwn(v, 'pendingMessage') || exact(v.pendingMessage, ['request', 'viewContent']) && Value.Check(M4MessageRequestSchema, v.pendingMessage.request) && typeof v.pendingMessage.viewContent === 'string') && (!Object.hasOwn(v, 'pendingExecution') || Value.Check(M4ExecuteRequestSchema, v.pendingExecution))); return v as unknown as Cache; } catch (error) { if (error instanceof M4UploadRecoveryError) throw error; throw new UploadRecoveryStorageError(); }
  }
  private cacheRead() { this.live(); try { return this.cache(this.store().getItem(this.cacheKey)); } catch (error) { if (error instanceof M4UploadRecoveryError) throw error; throw new UploadRecoveryStorageError(); } }
  private cacheWrite(value: Cache) { this.live(); try { const raw = JSON.stringify(value); this.cache(raw); this.store().setItem(this.cacheKey, raw); if (this.store().getItem(this.cacheKey) !== raw) throw new Error(); return raw; } catch (error) { if (error instanceof M4UploadRecoveryError) throw error; throw new UploadRecoveryStorageError(); } }
  /** Three-way field merge: stale unchanged page fields cannot undo a helper patch. */
  async mergeCache(previousRaw: string | null, nextRaw: string): Promise<M4UploadCacheMergeResult> {
    return this.locked(async () => { const previous = this.cache(previousRaw), next = this.cache(nextRaw); check(next); const latest = this.cacheRead(), result: Cache = latest ? clone(latest) : { owner: this.owner, topic: this.topicId, drafts: {} }, accepted: string[] = [], rejected: string[] = [];
      for (const type of M4_DOCUMENT_TYPES) { const before = previous?.drafts[type], after = next.drafts[type], current = latest?.drafts[type], path = `draft:${type}`;
        if (m4UploadSame(current, after)) accepted.push(path); else if (!m4UploadSame(before, after) && m4UploadSame(current, before)) { if (after === undefined) delete result.drafts[type]; else result.drafts[type] = clone(after); accepted.push(path); } else rejected.push(path);
      }
      for (const k of ['view', 'viewVersion', 'viewDirty', 'pendingMessage', 'pendingExecution'] as const) { const before = previous?.[k], after = next[k], current = latest?.[k]; if (m4UploadSame(current, after)) accepted.push(k); else if (!m4UploadSame(before, after) && m4UploadSame(current, before)) { if (after === undefined) delete result[k]; else Object.assign(result, { [k]: clone(after) }); accepted.push(k); } else rejected.push(k); }
      return { raw: this.cacheWrite(result), accepted, rejected };
    });
  }
  private pageMatches(base: M4UploadPageSnapshot, type: M4DocumentType) { const current = this.options.snapshot(type); return !!current && m4UploadSame(current, base); }
  private requireBase(e: M4UploadEnvelope, base: M4UploadPageSnapshot, target: M4UploadPageSnapshot | null) { const cache = this.cacheRead(); check(this.pageMatches(base, e.documentType) && m4UploadSame(cache?.drafts[e.documentType] ?? null, target) && !cache?.pendingMessage && !cache?.pendingExecution, '原文种草稿或本机待确认请求已变化，文件保留，未覆盖当前准备。'); }
  private async workspace(e?: M4UploadEnvelope) { const w = await this.m4.workspace(this.topicId); this.live(); if (e) this.unchanged(e); check(w?.topic?.topic_id === this.topicId && w.topic.project_id === this.projectId && w.topic.surface !== 'assistant' && w.project?.project_id === this.projectId && Array.isArray(w.materials) && w.materials.every(validPin) && validRows(w.pending_requirements) && Array.isArray(w.messages) && Array.isArray(w.templates) && Array.isArray(w.artifacts), '原话题、实际上传项目或待采用要求无法核实。'); return w; }
  private relation(w: M4Workspace, input: M4DraftInput) { check(input.requirements.every(row => w.messages.some(m => m.role === 'assistant' && m.message_id === row.message_id && m.version === row.message_version && m.reply?.requirements.includes(row.text))), '原结构化要求的消息版本无法核实。'); if (input.template) check(w.templates.some(t => t.status === 'active' && t.document_type === input.document_type && t.template_id === input.template!.template_id && t.template_version === input.template!.template_version && t.sha256 === input.template!.sha256), '原模板准确版本无法核实。'); if (input.edit_base) check(w.artifacts.some(a => a.kind === 'document' && a.document_type === input.document_type && a.artifact_id === input.edit_base!.artifact_id && a.artifact_version === input.edit_base!.artifact_version && a.source_project_id === input.edit_base!.source_project_id && a.sha256 === input.edit_base!.sha256), '原续稿成果准确版本无法核实。'); }
  async prepare(declarations: Dto<'UploadCreateRequest'>[], kind: 'source' | 'material', type: M4DocumentType): Promise<M4UploadEnvelope> {
    return this.locked(async () => { check(!this.list().length && !this.core.list().length, '请先核实原上传待办。'); this.options.coordinatePrepare?.(); check(M4_DOCUMENT_TYPES.includes(type) && declarations.length > 0 && declarations.length <= 60 && declarations.every(v => declaration(v, kind)));
      const captured = this.options.snapshot(type); check(snapshot(captured)); const page = clone(captured); check(!page.dirty && !page.conflict && page.input.document_type === type, '原草稿尚未可靠保存。'); const cache = this.cacheRead(), target = cache?.drafts[type] ?? null; check(!cache?.pendingMessage && !cache?.pendingExecution && (target === null || m4UploadSame(target, page)), '原本机草稿或请求尚未确认。');
      const w = await this.workspace(), saved = draft(w.drafts[type], type); check(m4UploadSame(pageOf(saved), page), '服务器原完整草稿已改变或尚未保存。'); this.relation(w, page.input);
      const value: Omit<M4UploadEnvelope, 'digest'> = { version: 1, owner: this.owner, projectId: this.projectId, topicId: this.topicId, id: this.nonce(), purpose: kind, documentType: type, sourcePolicy: kind === 'source' ? 'replace-source-only' : 'append-material-only', basePage: clone(page), baseCacheTarget: clone(target), basePending: { message: null, execution: null }, recordRevision: 0, items: declarations.map((d, index) => ({ id: this.nonce(), index, declaration: clone(d), stage: 'prepared', localCacheResult: 'pending', coreCleaned: false })) };
      this.requireBase(value as M4UploadEnvelope, page, target); this.options.coordinatePrepare?.(); const e = this.write({ ...value, digest: digest(identity(value)) }, null); for (const item of e.items) this.core.begin(item.declaration, m4UploadContext(e, item.index), item.id); return e;
    });
  }
  private result(e: M4UploadEnvelope, index: number, state: M4UploadResult['state'], reason?: string): M4UploadResult { const item = e.items[index], confirmed = stages.indexOf(item.stage) >= 6; return { envelope: clone(e), state, applyToPage: confirmed && item.localCacheResult === 'patched' && (this.pageMatches(item.adoptionBase!, e.documentType) || !!item.observedDraft && this.pageMatches(pageOf(item.observedDraft), e.documentType)), ...(confirmed ? { draft: clone(item.observedDraft!) } : {}), ...(reason ? { reason } : {}) }; }
  private async cleanup(e: M4UploadEnvelope, index: number): Promise<M4UploadResult> {
    let item = e.items[index]; check(['draft_confirmed', 'cleanup_pending', 'complete'].includes(item.stage)); if (item.stage === 'draft_confirmed') { e = this.update(e, index, { stage: 'cleanup_pending' }); item = e.items[index]; }
    if (item.localCacheResult === 'pending') { const cache = this.cacheRead(), current = cache?.drafts[e.documentType] ?? null, adopted = pageOf(item.observedDraft!), samePage = this.pageMatches(item.adoptionBase!, e.documentType) || this.pageMatches(adopted, e.documentType), matches = samePage && !cache?.pendingMessage && !cache?.pendingExecution && (m4UploadSame(current, item.cacheTarget) || m4UploadSame(current, adopted));
      if (matches) { this.unchanged(e); this.cacheWrite({ ...(cache ?? { owner: this.owner, topic: this.topicId, drafts: {} }), drafts: { ...(cache?.drafts ?? {}), [e.documentType]: adopted } }); e = this.update(e, index, { localCacheResult: 'patched' }); } else e = this.update(e, index, { localCacheResult: 'preserved' }); item = e.items[index]; }
    if (!item.coreCleaned) { this.unchanged(e); const record = this.core.list().find(r => r.id === item.id); check(!record || m4UploadRecordMatches(e, index, record)); await this.core.forget(item.id); this.live(); this.unchanged(e); e = this.update(e, index, { coreCleaned: true }); }
    // Forgetting the transport yields. A late edit or pending action must still
    // prevent page adoption and the next batch item after the cache was patched.
    item = e.items[index]; if (item.localCacheResult === 'patched') { const cache = this.cacheRead(), adopted = pageOf(item.observedDraft!); if (!m4UploadSame(cache?.drafts[e.documentType], adopted) || cache?.pendingMessage || cache?.pendingExecution || !this.pageMatches(item.adoptionBase!, e.documentType) && !this.pageMatches(adopted, e.documentType)) e = this.update(e, index, { localCacheResult: 'preserved' }); }
    if (e.items[index].stage !== 'complete') e = this.update(e, index, { stage: 'complete' }); if (e.items.every(i => i.stage === 'complete')) { this.remove(e); return this.result(e, index, 'complete'); } return this.result(e, index, 'content_confirmed', e.items[index].localCacheResult === 'preserved' ? '服务器原内容已核实；新本机修改已保留，后项尚未采用。' : undefined);
  }
  private async observe(e: M4UploadEnvelope, index: number): Promise<M4UploadResult> {
    const item = e.items[index]; check(item.draftRequest && item.adoptionBase && item.expectedInput && item.pending); const w = await this.workspace(e), observed = draft(w.drafts[e.documentType], e.documentType), input = m4UploadInputOf(observed), base = item.adoptionBase;
    if (!w.materials.some(p => m4UploadSame(p, pin(e.projectId, item.material!)))) return this.result(e, index, 'conflict', '原文件的话题准确关联已不可核实，未根据单独草稿内容完成采用。');
    const changed = !m4UploadSame(item.expectedInput, base.input), version = changed || base.version === 0 ? base.version + 1 : base.version;
    if (observed.version === version && m4UploadSame(input, item.expectedInput)) { const pendingUnknown = w.pending_requirements.length > 0; e = this.update(e, index, { observedDraft: observed, stage: pendingUnknown ? 'content_satisfied_pending_unknown' : 'draft_confirmed' }); if (pendingUnknown) return this.result(e, index, 'pending_unknown', '原内容效果已核实；话题仍显示待采用要求，非原子读取无法确认其消费状态，未继续写入。'); return this.cleanup(e, index); }
    if (stages.indexOf(item.stage) >= 6) return this.result(e, index, 'conflict', '先前内容效果已确认，但服务器后续内容或版本已变化。');
    if (observed.version === base.version && m4UploadSame(input, base.input)) return this.result(e, index, 'retryable', '尚未观察到原草稿效果。可明确继续同一份原请求，未自动重发。');
    return this.result(e, index, 'conflict', '服务器版本或完整输入已改变，未重基或覆盖后续内容。');
  }
  private async submit(e: M4UploadEnvelope, index: number): Promise<M4UploadResult> {
    const item = e.items[index]; check(item.adoptionBase && item.draftRequest && item.pending); this.requireBase(e, item.adoptionBase, item.cacheTarget!); const w = await this.workspace(e), saved = draft(w.drafts[e.documentType], e.documentType);
    check(m4UploadSame(pageOf(saved), item.adoptionBase) && m4UploadSame(w.pending_requirements, item.pending) && w.materials.some(p => m4UploadSame(p, pin(e.projectId, item.material!))), '原完整草稿、待采用要求或话题材料已变化，未重放原保存。'); this.relation(w, item.expectedInput!); this.requireBase(e, item.adoptionBase, item.cacheTarget!);
    if (item.stage !== 'draft_unknown') e = this.update(e, index, { stage: 'draft_unknown' }); this.requireBase(e, item.adoptionBase, item.cacheTarget!); this.unchanged(e); this.live(); try { await this.m4.draft(this.topicId, clone(item.draftRequest)); } catch { this.live(); } this.live(); this.unchanged(e); return this.observe(e, index);
  }
  async reconcile(id: string, index: number): Promise<M4UploadResult> { return this.locked(async () => { let e = this.read(id); const item = e.items[index]; check(item); if (['draft_confirmed', 'cleanup_pending', 'complete'].includes(item.stage)) return this.cleanup(e, index); if (item.draftRequest) return this.observe(e, index); if (item.material) { const w = await this.workspace(e); if (w.materials.some(p => m4UploadSame(p, pin(e.projectId, item.material!))) && stages.indexOf(item.stage) < 3) e = this.update(e, index, { stage: 'library_registered' }); } return this.result(e, index, 'pending'); }); }
  async resume(id: string, index: number, options: Omit<UploadRecoveryResumeOptions, 'signal' | 'previousRecord'> & { retryDraft?: boolean; retryMembership?: boolean } = {}): Promise<M4UploadResult> {
    return this.locked(async () => { let e = this.read(id), item = e.items[index]; check(item); if (index > 0) check(e.items[index - 1].stage === 'complete' && e.items[index - 1].localCacheResult === 'patched', '请先确认原有序批次前项。'); if (['draft_confirmed', 'cleanup_pending', 'complete'].includes(item.stage)) return this.cleanup(e, index);
      if (item.draftRequest) { const result = await this.observe(e, index); if (result.state !== 'retryable' || !options.retryDraft) return result; e = this.read(id); return this.submit(e, index); }
      const base = index === 0 ? e.basePage : pageOf(e.items[index - 1].observedDraft!), target = index === 0 ? e.baseCacheTarget : base; this.requireBase(e, base, target); const record = this.core.list().find(r => r.id === item.id); check(record && m4UploadRecordMatches(e, index, record), '原上传记录缺失或关联不一致，未重新建立上传。');
      const material = await this.core.resume(item.id, { ...options, signal: this.options.signal }); this.live(); this.unchanged(e); if (!item.material) { e = this.update(e, index, { material: validateUploadMaterial(item.declaration, material), adoptionBase: clone(base), cacheTarget: clone(target), stage: 'material_saved' }); item = e.items[index]; } else check(m4UploadSame(item.material, material)); this.requireBase(e, base, target);
      let w = await this.workspace(e); check(m4UploadSame(pageOf(draft(w.drafts[e.documentType], e.documentType)), base), '服务器原完整草稿已变化，文件已保存，未采用另一草稿。'); this.requireBase(e, base, target);
      if (!w.materials.some(p => m4UploadSame(p, pin(e.projectId, material)))) { if (item.stage === 'library_registration_unknown' && !options.retryMembership) return this.result(e, index, 'pending', '原话题关联尚未核实。可明确继续原关联，刷新不会重复登记。'); e = this.update(e, index, { stage: 'library_registration_unknown' }); this.requireBase(e, base, target); this.unchanged(e); try { await this.m4.material(this.topicId, pin(e.projectId, material)); } catch { this.live(); } this.live(); this.unchanged(e); w = await this.workspace(e); if (!w.materials.some(p => m4UploadSame(p, pin(e.projectId, material)))) return this.result(e, index, 'pending', '文件已保存，原话题关联尚未核实。'); }
      if (stages.indexOf(e.items[index].stage) < 3) e = this.update(e, index, { stage: 'library_registered' }); item = e.items[index]; this.requireBase(e, base, target); check(m4UploadSame(pageOf(draft(w.drafts[e.documentType], e.documentType)), base), '服务器原草稿已改变，未继续采用。');
      const request: M4DraftRequest = { expected_version: base.version, input: m4UploadAdoptionInput(e, item) }, pending = clone(w.pending_requirements), expected = mergePending(request.input, pending); this.relation(w, expected); e = this.update(e, index, { draftRequest: request, pending, expectedInput: expected, requestDigest: digest({ request, pending, expected }), stage: 'draft_prepared' }); return this.submit(e, index);
    });
  }
  async stop(id: string): Promise<void> { return this.locked(async () => { const e = this.read(id); for (const item of e.items) { const record = this.core.list().find(r => r.id === item.id); check(!record || m4UploadRecordMatches(e, item.index, record)); await this.core.forget(item.id); this.live(); this.unchanged(e); } this.remove(e); }); }
  async removeOrphan(id: string): Promise<void> { return this.locked(async () => { check(!this.list().some(e => e.items.some(i => i.id === id)), '该文件仍有原业务记录。'); check(this.core.list().some(r => r.id === id), '原本机记录已移除。'); await this.core.forget(id); this.live(); }); }
}
