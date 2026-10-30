import { M1_UPLOAD_LIMITS, M4MaterialPinSchema, M4RequirementSchema, M4ViewRequestSchema, M4ViewStateSchema, SourceProspectusSchema, emptyUpdateDetails, schemas, updateDetailsErrors,
  type AssistantResult, type M4MaterialPin, type M4ViewRequest, type M4ViewState, type M4Workspace, type SourceProspectus } from './billing-types.js';
import { Value } from '@sinclair/typebox/value';
import { ApiError, type ApiClient, type Dto } from './api.js';
import { isDateTime } from './schema-formats.js';
import { AssistantUploadRecovery } from './assistant-upload-recovery.js';
import { AssistantViewCache, AssistantViewCacheError, assistantCheck as check, assistantClone as clone, assistantDigest as digest, assistantExact as exact, assistantId as validId,
  assistantInteger as integer, assistantSame as same, assistantValidSnapshot, assistantParseCacheRecord, assertAssistantTemplateClear, withAssistantTopicWrite,
  type AssistantTopicWriteAllow, type AssistantViewCacheRecord, type AssistantViewSnapshot } from './assistant-view-cache.js';
import { UploadRecovery, UploadRecoveryLockError, UploadRecoveryNeedsFileError, UploadRecoveryStorageError, validateUploadMaterial,
  type UploadRecoveryDependencies, type UploadRecoveryJson, type UploadRecoveryRecord, type UploadRecoveryStorage } from './upload-recovery.js';

export type AssistantProjectCopyProjectData = { project: Dto<'ProjectResponse'>; materials: Dto<'MaterialResponse'>[]; results: AssistantResult[] };
export type AssistantProjectCopyOptions = UploadRecoveryDependencies & { current: () => boolean; snapshot: () => AssistantViewSnapshot | undefined;
  projectData: (projectId: string, signal?: AbortSignal) => Promise<AssistantProjectCopyProjectData>; signal?: AbortSignal; coordinatePrepare?: () => void };
export type AssistantProjectCopyStage = 'prepared' | 'target_create_prepared' | 'target_create_unknown' | 'target_known' | 'ordered_items' | 'target_patch_prepared' | 'target_patch_unknown' | 'target_patch_confirmed' | 'view_prepared' | 'view_unknown' | 'view_confirmed' | 'cleanup_pending' | 'complete';
export type AssistantProjectCopyItem = { id: string; index: number; sourceProjectId: string; sourceMaterial: Dto<'MaterialResponse'>; sourceProspectus?: SourceProspectus;
  declaration: Dto<'UploadCreateRequest'>; stage: 'prepared' | 'transport_unknown' | 'material_saved' | 'membership_unknown' | 'member_confirmed';
  coreState: 'unprepared' | 'prepared' | 'known' | 'cleaned'; material?: Dto<'MaterialResponse'>; requestUploadId?: string; targetPin?: M4MaterialPin;
  membership: 'pending' | 'unknown' | 'confirmed' | 'unavailable'; mapping: 'pending' | 'mapped' | 'merged' | 'conflict' };
export type AssistantProjectCopyEnvelope = { version: 1; purpose: 'assistant-project-copy'; owner: string; scopeProjectId: string; topicId: string; id: string;
  sourceProjectId: string; sourceProject: Dto<'ProjectResponse'>; targetKind: 'update' | 'review'; targetProjectId?: string; createdTarget?: Dto<'ProjectResponse'>;
  input: Omit<Dto<'ProjectCreateRequest'>, 'creation_request_id'>; createRequest: Dto<'ProjectCreateRequest'>; createRequestDigest: string;
  basePage: AssistantViewSnapshot; baseCache: AssistantViewCacheRecord; baseServerIdentity: UploadRecoveryJson; desiredToken: string;
  stage: AssistantProjectCopyStage; items: AssistantProjectCopyItem[]; mappedSources?: SourceProspectus[]; targetBase?: Dto<'ProjectPatchRequest'>;
  targetPatch?: Dto<'ProjectPatchRequest'>; targetPatchDigest?: string; expectedTarget?: Dto<'ProjectPatchRequest'>; observedTarget?: Dto<'ProjectResponse'>;
  viewRequest?: M4ViewRequest; viewRequestDigest?: string; expectedView?: M4ViewState; observedView?: M4ViewState & { version: number };
  localCacheResult: 'pending' | 'patched' | 'preserved'; stopRequested: boolean; digest: string; recordRevision: number };
export type AssistantProjectCopyResult = { envelope: AssistantProjectCopyEnvelope; state: 'pending' | 'retryable' | 'unknown' | 'unavailable' | 'conflict' | 'view_confirmed' | 'complete';
  applyToPage: boolean; view?: M4ViewState & { version: number }; targetData?: AssistantProjectCopyProjectData; reason?: string };
export type AssistantProjectCopyResumeOptions = { retryTargetCreate?: boolean; retryMembership?: boolean; retryTargetPatch?: boolean; retryView?: boolean;
  status?: (message: string, index?: number) => void; progress?: (loaded: number, total: number, index: number) => void };
type CopyApi = Pick<ApiClient, 'create' | 'patch' | 'project' | 'material' | 'materialBytes' | 'createUpload' | 'uploadBytes' | 'completeUpload'>;
type CopyM4Api = { workspace(topic: string): Promise<M4Workspace>; material(topic: string, pin: M4MaterialPin): Promise<unknown>; view(topic: string, request: M4ViewRequest): Promise<unknown> };
export { AssistantViewCacheError as AssistantProjectCopyRecoveryError };
const purpose = 'assistant-project-copy', stages: AssistantProjectCopyStage[] = ['prepared', 'target_create_prepared', 'target_create_unknown', 'target_known', 'ordered_items', 'target_patch_prepared', 'target_patch_unknown', 'target_patch_confirmed', 'view_prepared', 'view_unknown', 'view_confirmed', 'cleanup_pending', 'complete'];
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const declarationOf = (m: Dto<'MaterialResponse'>): Dto<'UploadCreateRequest'> => ({ filename: m.filename, media_type: m.media_type, byte_size: m.byte_size, sha256: m.sha256, role: m.role });
const pinOf = (project: string, m: Dto<'MaterialResponse'>): M4MaterialPin => ({ source_project_id: project, material_id: m.material_id, material_version: m.material_version, sha256: m.sha256 });
const materialIdentity = (m: Dto<'MaterialResponse'>) => ({ ...pinOf('', m), ...declarationOf(m), upload_id: m.upload_id });
const projectView = (p: Dto<'ProjectResponse'>): Dto<'ProjectPatchRequest'> => ({ name: p.name, issuer_name: p.issuer_name, market: p.market, offering: p.offering, update_details: { ...emptyUpdateDetails(), ...clone(p.update_details ?? {}) } });
const initialTarget = (e: AssistantProjectCopyEnvelope): Dto<'ProjectPatchRequest'> => ({ name: e.createRequest.name, issuer_name: e.createRequest.issuer_name, market: e.createRequest.market, offering: e.createRequest.offering, update_details: { ...emptyUpdateDetails(), ...clone(e.createRequest.update_details ?? {}) } });
// ProjectCreateRequest forbids source_project_id; a response may omit it or return null.
const targetIdentity = (e: AssistantProjectCopyEnvelope, p: Dto<'ProjectResponse'>) => p.project_id === e.targetProjectId && p.kind === e.targetKind && !p.archived_at && p.input_revision === null && p.input_hash === null && p.source_project_id == null;
const creationInitial = (e: AssistantProjectCopyEnvelope) => !!e.createdTarget && targetIdentity(e, e.createdTarget) && e.createdTarget.draft_revision === 1 && same(projectView(e.createdTarget), initialTarget(e));
const viewOf = (v: M4ViewState & { version: number }): M4ViewState => { const { version: _version, ...view } = v; return clone(view); };
function validView(v: unknown): v is M4ViewState & { version: number } { if (!v || typeof v !== 'object') return false; const { version, ...view } = v as Record<string, unknown>; return integer(version) && Value.Check(M4ViewStateSchema, view); }
function validProject(v: unknown): v is Dto<'ProjectResponse'> { return Value.Check(schemas.ProjectResponse, v) && isDateTime(v.updated_at) && (v.archived_at == null || isDateTime(v.archived_at)); }
function validMaterial(v: unknown): v is Dto<'MaterialResponse'> { if (!Value.Check(schemas.MaterialResponse, v)) return false; try { validateUploadMaterial(declarationOf(v), v); return true; } catch { return false; } }
function serverIdentity(w: M4Workspace): UploadRecoveryJson { return { messages: w.messages.map(m => ({ id: m.message_id, version: m.version, role: m.role, run: m.run_id ?? null, status: m.reply_status ?? null })), tasks: w.tasks.map(t => ({ id: t.run.run_id, state: t.run.state, execution: t.run.execution_request_id ?? null })), active_run: w.active_run ? { id: w.active_run.run_id, state: w.active_run.state } : null, pending_requirements: clone(w.pending_requirements) } as UploadRecoveryJson; }
function validServer(v: unknown) { return exact(v, ['messages', 'tasks', 'active_run', 'pending_requirements']) && Array.isArray(v.messages) && v.messages.every(m => exact(m, ['id', 'version', 'role', 'run', 'status']) && validId(m.id) && integer(m.version) && m.version > 0 && ['user', 'assistant'].includes(String(m.role)) && (m.run === null || validId(m.run)) && (m.status === null || validId(m.status))) && Array.isArray(v.tasks) && v.tasks.every(t => exact(t, ['id', 'state', 'execution']) && validId(t.id) && validId(t.state) && (t.execution === null || validId(t.execution))) && (v.active_run === null || exact(v.active_run, ['id', 'state']) && validId(v.active_run.id) && validId(v.active_run.state)) && Array.isArray(v.pending_requirements) && v.pending_requirements.every(r => Value.Check(M4RequirementSchema, r)); }
function identity(e: Omit<AssistantProjectCopyEnvelope, 'digest'> | AssistantProjectCopyEnvelope) { return { version: e.version, purpose: e.purpose, owner: e.owner, scopeProjectId: e.scopeProjectId, topicId: e.topicId, id: e.id, sourceProjectId: e.sourceProjectId, sourceProject: e.sourceProject, targetKind: e.targetKind, input: e.input, createRequest: e.createRequest, createRequestDigest: e.createRequestDigest, basePage: e.basePage, baseCache: e.baseCache, baseServerIdentity: e.baseServerIdentity, desiredToken: e.desiredToken, items: e.items.map(({ id, index, sourceProjectId, sourceMaterial, sourceProspectus, declaration }) => ({ id, index, sourceProjectId, sourceMaterial, ...(sourceProspectus ? { sourceProspectus } : {}), declaration })) }; }
export function assistantProjectCopyContext(e: AssistantProjectCopyEnvelope, index: number): UploadRecoveryJson { check(e.items[index]?.index === index); return { version: 1, kind: purpose, scope_project_id: e.scopeProjectId, topic_id: e.topicId, envelope_id: e.id, envelope_digest: e.digest, item_index: index, source_digest: digest({ projectId: e.sourceProjectId, material: materialIdentity(e.items[index].sourceMaterial) }), declaration_digest: digest(e.items[index].declaration) }; }
export function assistantProjectCopyRecordMatches(e: AssistantProjectCopyEnvelope, index: number, r: UploadRecoveryRecord) { const i = e.items[index]; return !!i && i.index === index && r.id === i.id && r.owner === e.owner && r.projectId === e.targetProjectId && r.purpose === purpose && same(r.declaration, i.declaration) && same(r.context, assistantProjectCopyContext(e, index)); }
export function assistantProjectCopyAdoptionView(e: AssistantProjectCopyEnvelope): M4ViewState { check(e.targetProjectId && e.mappedSources && e.basePage.view.assistant); const view = clone(e.basePage.view); view.assistant!.project_id = e.targetProjectId; view.assistant!.source_prospectuses = clone(e.mappedSources); delete view.assistant!.copy_source_project_id; delete view.assistant!.project_creation_request_id; view.assistant!.draft_token = e.desiredToken; check(Value.Check(M4ViewStateSchema, view)); return view; }
const savedSnapshot = (e: AssistantProjectCopyEnvelope): AssistantViewSnapshot => ({ ...clone(e.basePage), version: e.basePage.version + 1, view: clone(e.expectedView!), dirty: false, conflict: false });
function mapping(e: AssistantProjectCopyEnvelope): SourceProspectus[] {
  const result: SourceProspectus[] = [];
  for (const i of e.items) if (i.sourceProspectus) { check(i.targetPin); const s = { ...clone(i.sourceProspectus), material_id: i.targetPin.material_id, material_version: i.targetPin.material_version, sha256: i.targetPin.sha256 }, old = result.find(v => v.material_id === s.material_id); check(!old || same(old, s), '不同原稿信息指向了同一份目标文件，请先核对；已有文件和修改保留。'); if (!old) result.push(s); }
  return result;
}
function normalize(value: unknown, owner: string, scope: string, topic: string): AssistantProjectCopyEnvelope {
  check(exact(value, ['version', 'purpose', 'owner', 'scopeProjectId', 'topicId', 'id', 'sourceProjectId', 'sourceProject', 'targetKind', 'input', 'createRequest', 'createRequestDigest', 'basePage', 'baseCache', 'baseServerIdentity', 'desiredToken', 'stage', 'items', 'localCacheResult', 'stopRequested', 'digest', 'recordRevision'], ['targetProjectId', 'createdTarget', 'mappedSources', 'targetBase', 'targetPatch', 'targetPatchDigest', 'expectedTarget', 'observedTarget', 'viewRequest', 'viewRequestDigest', 'expectedView', 'observedView']));
  const e = value as AssistantProjectCopyEnvelope, n = stages.indexOf(e.stage);
  check(e.version === 1 && e.purpose === purpose && e.owner === owner && e.scopeProjectId === scope && e.topicId === topic && [e.id, e.sourceProjectId, e.desiredToken].every(validId) && e.desiredToken !== e.basePage?.view?.assistant?.draft_token && ['update', 'review'].includes(e.targetKind) && n >= 0 && integer(e.recordRevision) && typeof e.stopRequested === 'boolean');
  check(assistantValidSnapshot(e.basePage) && !e.basePage.dirty && !e.basePage.conflict && !e.basePage.runtime.pending && !e.basePage.runtime.uncertain && e.basePage.view.assistant?.action?.business === e.targetKind && !e.basePage.view.assistant.copy_source_project_id && !e.basePage.view.assistant.project_creation_request_id);
  assistantParseCacheRecord(e.baseCache, owner, scope, topic); check(same(e.baseCache.snapshot, e.basePage) && validServer(e.baseServerIdentity));
  check(validProject(e.sourceProject) && e.sourceProject.project_id === e.sourceProjectId && e.sourceProject.kind !== e.targetKind && !e.sourceProject.archived_at && (e.basePage.view.assistant.project_id ?? scope) === e.sourceProjectId);
  check(Value.Check(schemas.ProjectCreateRequest, e.input) && !Object.hasOwn(e.input, 'creation_request_id') && e.input.kind === e.targetKind && e.input.update_details && !updateDetailsErrors(e.input.update_details).length && Array.isArray(e.input.update_details.target_reporting_periods));
  check(Value.Check(schemas.ProjectCreateRequest, e.createRequest) && validId(e.createRequest.creation_request_id) && same(e.createRequest, { ...e.input, creation_request_id: e.createRequest.creation_request_id, update_details: { ...e.input.update_details, source_prospectuses: [] } }) && e.createRequestDigest === digest(e.createRequest));
  check(Array.isArray(e.items) && e.items.length <= M1_UPLOAD_LIMITS.projectFiles && new Set(e.items.map(i => i.id)).size === e.items.length && new Set(e.items.map(i => i.sourceMaterial.material_id)).size === e.items.length);
  const declared = e.input.update_details.source_prospectuses ?? [];
  for (const [index, i] of e.items.entries()) { check(exact(i, ['id', 'index', 'sourceProjectId', 'sourceMaterial', 'declaration', 'stage', 'coreState', 'membership', 'mapping'], ['sourceProspectus', 'material', 'requestUploadId', 'targetPin']) && validId(i.id) && i.index === index && i.sourceProjectId === e.sourceProjectId && validMaterial(i.sourceMaterial) && same(i.declaration, declarationOf(i.sourceMaterial)) && ['prepared', 'transport_unknown', 'material_saved', 'membership_unknown', 'member_confirmed'].includes(i.stage) && ['unprepared', 'prepared', 'known', 'cleaned'].includes(i.coreState) && ['pending', 'unknown', 'confirmed', 'unavailable'].includes(i.membership) && ['pending', 'mapped', 'merged', 'conflict'].includes(i.mapping));
    const matches = declared.filter(s => s.material_id === i.sourceMaterial.material_id && s.material_version === i.sourceMaterial.material_version && s.sha256 === i.sourceMaterial.sha256); check(matches.length <= 1 && (i.sourceProspectus ? Value.Check(SourceProspectusSchema, i.sourceProspectus) && same(i.sourceProspectus, matches[0]) : matches.length === 0));
    if (i.material) { validateUploadMaterial(i.declaration, i.material); check(validId(e.targetProjectId) && Value.Check(M4MaterialPinSchema, i.targetPin) && same(i.targetPin, pinOf(e.targetProjectId, i.material)) && validId(i.requestUploadId) && i.coreState !== 'unprepared'); } else check(!i.targetPin && !i.requestUploadId && i.membership === 'pending' && i.mapping === 'pending');
    if (i.membership === 'confirmed') check(i.material && i.stage === 'member_confirmed'); if (i.stage === 'member_confirmed') check(i.material && ['confirmed', 'unavailable'].includes(i.membership));
  }
  check(declared.every(s => e.items.some(i => same(i.sourceProspectus, s))));
  if (e.targetProjectId !== undefined) check(validId(e.targetProjectId) && e.targetProjectId !== e.sourceProjectId && e.targetProjectId !== scope && validProject(e.createdTarget) && e.createdTarget.project_id === e.targetProjectId); else check(!e.createdTarget && e.items.every(i => i.coreState === 'unprepared') && n <= 2);
  if (n >= 3) check(e.targetProjectId); if (e.targetBase) check(same(e.targetBase, initialTarget(e)));
  if (e.mappedSources) check(same(e.mappedSources, mapping(e)) && e.items.every(i => i.material && ['confirmed', 'unavailable'].includes(i.membership)));
  if (e.targetPatch) check(e.targetBase && e.mappedSources && Value.Check(schemas.ProjectPatchRequest, e.targetPatch) && same(e.targetPatch, { ...e.targetBase, update_details: { ...e.targetBase.update_details!, source_prospectuses: e.mappedSources } }) && e.targetPatchDigest === digest(e.targetPatch) && same(e.expectedTarget, e.targetPatch));
  else check(!e.targetPatchDigest && !e.expectedTarget && !e.observedTarget && n < 5);
  if (e.observedTarget) check(validProject(e.observedTarget) && e.observedTarget.project_id === e.targetProjectId && e.observedTarget.kind === e.targetKind && e.observedTarget.draft_revision === 2 && same(projectView(e.observedTarget), e.expectedTarget)); if (n >= 7) check(e.observedTarget);
  if (e.viewRequest) check(e.observedTarget && Value.Check(M4ViewRequestSchema, e.viewRequest) && e.viewRequest.expected_version === e.basePage.version && same(e.viewRequest.view, assistantProjectCopyAdoptionView(e)) && same(e.expectedView, e.viewRequest.view) && e.viewRequestDigest === digest(e.viewRequest));
  else check(!e.expectedView && !e.viewRequestDigest && !e.observedView && n < 8);
  if (e.observedView) check(validView(e.observedView) && e.observedView.version === e.basePage.version + 1 && same(viewOf(e.observedView), e.expectedView)); if (n >= 10) check(e.observedView);
  check(['pending', 'patched', 'preserved'].includes(e.localCacheResult) && (n >= 11 || e.localCacheResult === 'pending') && e.digest === digest(identity(e))); return clone(e);
}

/** One fixed source batch, independent target receipts and one original full-view adoption. No tasks or billing. */
export class AssistantProjectCopyRecovery {
  private prefix: string; private cache: AssistantViewCache; private ordinary: AssistantUploadRecovery;
  constructor(private api: CopyApi, private m4: CopyM4Api, private owner: string, private scopeProjectId: string, private topicId: string, private options: AssistantProjectCopyOptions) {
    check([owner, scopeProjectId, topicId].every(validId)); this.prefix = `bb-assistant-project-copy-v1:${[owner, scopeProjectId, topicId].map(encodeURIComponent).join(':')}:`;
    this.cache = new AssistantViewCache(api, owner, options.current, options); this.ordinary = new AssistantUploadRecovery(api, m4, owner, options.current, options);
  }
  private live() { this.options.signal?.throwIfAborted(); if (!this.options.current()) throw new DOMException('当前账号或原材料复用对话已变化。', 'AbortError'); }
  private store(): UploadRecoveryStorage { try { const s = this.options.store ?? globalThis.localStorage; if (s) return s; } catch {} throw new UploadRecoveryStorageError(); }
  private nonce() { const id = this.options.id?.() ?? crypto.randomUUID(); check(validId(id)); return id; }
  private async locked<T>(id: string, fn: () => Promise<T>): Promise<T> { this.live(); check(validId(id)); const name = this.prefix + encodeURIComponent(id), action = async () => { this.live(); return fn(); }; if (this.options.lock) return this.options.lock.run(name, action, this.options.signal); const locks = globalThis.navigator?.locks; if (!locks) throw new UploadRecoveryLockError(); return locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => { if (!lock) throw new UploadRecoveryLockError(); return action(); }); }
  list(): AssistantProjectCopyEnvelope[] { this.live(); try { const s = this.store(), length = s.length, keys: string[] = []; for (let n = 0; n < length; n++) { const key = s.key(n); if (key?.startsWith(this.prefix)) keys.push(key); } check(length === s.length && new Set(keys).size === keys.length); return keys.map(key => { const raw = s.getItem(key); check(raw && raw.length <= 50_000_000); const e = normalize(JSON.parse(raw), this.owner, this.scopeProjectId, this.topicId); check(key === this.prefix + encodeURIComponent(e.id) && s.getItem(key) === raw); return e; }); } catch (error) { if (error instanceof AssistantViewCacheError || error instanceof UploadRecoveryStorageError) throw error; throw new UploadRecoveryStorageError(); } }
  private core(project: string, e?: AssistantProjectCopyEnvelope) { return new UploadRecovery(this.api, this.owner, project, purpose, () => { try { this.live(); if (e) this.requireBase(e); return true; } catch { return false; } }, this.options); }
  transportRecords(): UploadRecoveryRecord[] { this.live(); const s = this.store(), prefix = `bondbuddy:upload-recovery:v1:${encodeURIComponent(this.owner)}:`, projects = new Set<string>(); try { const length = s.length; for (let n = 0; n < length; n++) { const key = s.key(n); if (!key?.startsWith(prefix)) continue; const parts = key.slice(prefix.length).split(':'); if (decodeURIComponent(parts[1] ?? '') !== purpose) continue; check(parts.length === 4 && parts.every(p => validId(decodeURIComponent(p)) && encodeURIComponent(decodeURIComponent(p)) === p)); projects.add(decodeURIComponent(parts[0])); } check(length === s.length); return [...projects].flatMap(p => this.core(p).list()).filter(r => { const c = r.context; check(exact(c, ['version', 'kind', 'scope_project_id', 'topic_id', 'envelope_id', 'envelope_digest', 'item_index', 'source_digest', 'declaration_digest']) && c.version === 1 && c.kind === purpose && [c.scope_project_id, c.topic_id, c.envelope_id].every(validId) && integer(c.item_index) && [c.envelope_digest, c.source_digest, c.declaration_digest].every(hash)); return c.scope_project_id === this.scopeProjectId && c.topic_id === this.topicId; }); } catch (error) { if (error instanceof AssistantViewCacheError || error instanceof UploadRecoveryStorageError) throw error; throw new UploadRecoveryStorageError(); } }
  private read(id: string) { const e = this.list().find(e => e.id === id); check(e, '原材料复用待办已移除，未重建原操作。'); return e; }
  private unchanged(e: AssistantProjectCopyEnvelope) { check(same(this.read(e.id), e), '另一页面已改变原材料复用进度，已有修改保留。'); }
  private allow(e: AssistantProjectCopyEnvelope): AssistantTopicWriteAllow { return { kind: purpose, scopeProjectId: e.scopeProjectId, envelopeId: e.id, envelope: e, records: e.targetProjectId ? e.items.map(i => ({ projectId: e.targetProjectId!, recordId: i.id, declaration: i.declaration, context: assistantProjectCopyContext(e, i.index) })) : [] }; }
  private clear(e?: AssistantProjectCopyEnvelope) { assertAssistantTemplateClear(this.api, this.owner, this.topicId, this.options.current, this.options, e ? this.allow(e) : undefined); check(!this.ordinary.list(this.topicId).length, '原对话仍有附件保存待办，请先核对。'); this.options.coordinatePrepare?.(); }
  private pageMatches(e: AssistantProjectCopyEnvelope, saved = false) { const p = this.options.snapshot(); return same(p, e.basePage) || saved && same(p, savedSnapshot(e)); }
  private requireBase(e: AssistantProjectCopyEnvelope) { this.live(); this.unchanged(e); check(this.pageMatches(e) && same(this.cache.read(this.topicId, this.scopeProjectId), e.baseCache), '原对话输入或任务状态已变化，已暂停复用；已有文件和修改保留，请先核对。'); this.clear(e); this.checkCores(e); }
  private checkCores(e: AssistantProjectCopyEnvelope) { if (!e.targetProjectId) return; const records = this.core(e.targetProjectId).list(); for (const i of e.items) if (i.coreState === 'known' || i.coreState === 'prepared') { const r = records.find(r => r.id === i.id); check(r && assistantProjectCopyRecordMatches(e, i.index, r), '原文件的本机保存记录已变化，未重新建立上传。'); if (i.material) check(r.stage === 'saved' && r.material && same(materialIdentity(r.material), materialIdentity(i.material)), '原文件保存结果已变化，请先核对。'); } }
  private write(e: AssistantProjectCopyEnvelope, before: AssistantProjectCopyEnvelope | null) { this.live(); const valid = normalize(e, this.owner, this.scopeProjectId, this.topicId); if (before) { this.unchanged(before); check(e.recordRevision === before.recordRevision + 1 && e.digest === before.digest && stages.indexOf(e.stage) >= stages.indexOf(before.stage) && (!before.stopRequested || e.stopRequested)); for (const f of ['targetProjectId', 'createdTarget', 'mappedSources', 'targetBase', 'targetPatch', 'targetPatchDigest', 'expectedTarget', 'observedTarget', 'viewRequest', 'viewRequestDigest', 'expectedView', 'observedView'] as const) if (Object.hasOwn(before, f)) check(same(before[f], e[f])); for (const i of before.items) if (i.material) check(same(i.material, e.items[i.index].material) && same(i.targetPin, e.items[i.index].targetPin) && i.requestUploadId === e.items[i.index].requestUploadId); } else check(!this.list().length);
    try { const raw = JSON.stringify(valid), s = this.store(); check(raw.length <= 50_000_000); s.setItem(this.prefix + encodeURIComponent(e.id), raw); check(s.getItem(this.prefix + encodeURIComponent(e.id)) === raw); return valid; } catch (error) { if (error instanceof AssistantViewCacheError) throw error; throw new UploadRecoveryStorageError(); } }
  private update(e: AssistantProjectCopyEnvelope, change: Partial<AssistantProjectCopyEnvelope>, index?: number, item?: Partial<AssistantProjectCopyItem>) { const next = clone(e); Object.assign(next, change); if (index !== undefined) Object.assign(next.items[index], item); next.recordRevision++; return this.write(next, e); }
  private async topic<T>(e: AssistantProjectCopyEnvelope, fn: () => Promise<T>) { return withAssistantTopicWrite(this.owner, this.topicId, this.options.current, this.options, async () => { this.requireBase(e); return fn(); }, this.options.signal); }
  private async workspace(e?: AssistantProjectCopyEnvelope) { const w = await this.m4.workspace(this.topicId); this.live(); if (e) this.unchanged(e); check(w?.topic?.topic_id === this.topicId && w.topic.project_id === this.scopeProjectId && w.topic.surface === 'assistant' && w.project?.project_id === this.scopeProjectId && validView(w.view) && Array.isArray(w.materials) && w.materials.every(p => Value.Check(M4MaterialPinSchema, p)) && Array.isArray(w.messages) && Array.isArray(w.tasks) && Array.isArray(w.pending_requirements)); return w; }
  private checkServer(e: AssistantProjectCopyEnvelope, w: M4Workspace) { check(w.view.version === e.basePage.version && same(viewOf(w.view), e.basePage.view) && same(serverIdentity(w), e.baseServerIdentity), '原对话内容、版本或任务状态已变化，已暂停保存；已有修改保留，请先核对。'); }
  async prepare(value: { sourceProjectId: string; input: Omit<Dto<'ProjectCreateRequest'>, 'creation_request_id'> }): Promise<AssistantProjectCopyEnvelope> {
    this.live(); this.clear(); check(!this.list().length && !this.transportRecords().length); const snapshot = this.options.snapshot(); check(assistantValidSnapshot(snapshot) && !snapshot.dirty && !snapshot.conflict && !snapshot.runtime.pending && !snapshot.runtime.uncertain, '请先可靠保存原对话，并核对待确认的任务。'); const page = clone(snapshot), a = page.view.assistant;
    check(a?.action && ['update', 'review'].includes(a.action.business) && !a.copy_source_project_id && !a.project_creation_request_id && validId(value.sourceProjectId) && (a.project_id ?? this.scopeProjectId) === value.sourceProjectId, '原材料复用缺少完整依据，请先核对原项目与任务。');
    const input = clone(value.input); check(Value.Check(schemas.ProjectCreateRequest, input) && !Object.hasOwn(input, 'creation_request_id') && input.kind === a.action.business && input.issuer_name === (a.action.fields.issuer_name || null) && input.market === (a.action.fields.market ?? null) && input.offering === (a.action.fields.offering ?? null) && input.update_details?.reporting_cutoff === a.action.fields.reporting_cutoff && input.update_details?.supplementary_notes === a.action.requirements && Array.isArray(input.update_details.target_reporting_periods) && !updateDetailsErrors(input.update_details).length);
    const source = await this.options.projectData(value.sourceProjectId, this.options.signal); this.live(); check(same(this.options.snapshot(), page) && validProject(source.project) && source.project.project_id === value.sourceProjectId && source.project.kind !== input.kind && !source.project.archived_at && Array.isArray(source.materials)); check(same(input.update_details!.source_prospectuses ?? [], a.source_prospectuses ?? source.project.update_details?.source_prospectuses ?? []), '原稿信息与原项目记录不同，请先核对。');
    const batch = source.materials.filter(m => m.state === 'persisted').map(clone); check(batch.every(validMaterial) && new Set(batch.map(m => m.material_id)).size === batch.length);
    for (const declared of input.update_details!.source_prospectuses ?? []) { const index = batch.findIndex(m => m.material_id === declared.material_id), listed = batch[index]; if (!listed || listed.material_version !== declared.material_version || listed.sha256 !== declared.sha256) { const accurate = await this.api.material(value.sourceProjectId, declared.material_id, this.options.signal, declared.material_version); this.live(); check(same(this.options.snapshot(), page) && validMaterial(accurate) && accurate.material_id === declared.material_id && accurate.material_version === declared.material_version && accurate.sha256 === declared.sha256, '原稿准确版本无法读取，未改用最新文件。'); if (index < 0) batch.push(clone(accurate)); else batch[index] = clone(accurate); } }
    check(batch.length <= M1_UPLOAD_LIMITS.projectFiles);
    const workspace = await this.workspace(); this.live(); check(workspace.view.version === page.version && same(viewOf(workspace.view), page.view));
    return withAssistantTopicWrite(this.owner, this.topicId, this.options.current, this.options, async () => { this.live(); this.clear(); check(!this.list().length && !this.transportRecords().length && same(this.options.snapshot(), page)); const cache = this.cache.read(this.topicId, this.scopeProjectId); check(cache && same(cache.snapshot, page), '原完整对话尚未可靠缓存，请先保存。');
      const sources = input.update_details!.source_prospectuses ?? [], items: AssistantProjectCopyItem[] = batch.map((material, index) => { const matches = sources.filter(s => s.material_id === material.material_id && s.material_version === material.material_version && s.sha256 === material.sha256); check(matches.length <= 1); return { id: this.nonce(), index, sourceProjectId: value.sourceProjectId, sourceMaterial: clone(material), ...(matches[0] ? { sourceProspectus: clone(matches[0]) } : {}), declaration: declarationOf(material), stage: 'prepared', coreState: 'unprepared', membership: 'pending', mapping: 'pending' }; });
      check(sources.every(s => items.some(i => same(i.sourceProspectus, s))), '原稿信息未对应准确文件版本，请先核对。'); const createRequest: Dto<'ProjectCreateRequest'> = { ...input, creation_request_id: this.nonce(), update_details: { ...input.update_details!, source_prospectuses: [] } };
      const raw: Omit<AssistantProjectCopyEnvelope, 'digest'> = { version: 1, purpose, owner: this.owner, scopeProjectId: this.scopeProjectId, topicId: this.topicId, id: this.nonce(), sourceProjectId: value.sourceProjectId, sourceProject: clone(source.project), targetKind: input.kind as 'update' | 'review', input, createRequest, createRequestDigest: digest(createRequest), basePage: page, baseCache: cache, baseServerIdentity: serverIdentity(workspace), desiredToken: this.nonce(), stage: 'prepared', items, localCacheResult: 'pending', stopRequested: false, recordRevision: 0 };
      return this.write({ ...raw, digest: digest(identity(raw)) }, null);
    }, this.options.signal);
  }
  private result(e: AssistantProjectCopyEnvelope, state: AssistantProjectCopyResult['state'], reason?: string): AssistantProjectCopyResult {
    const materials = [...new Map(e.items.filter(i => i.material).map(i => [i.material!.material_id + '/' + i.material!.material_version, clone(i.material!)] as const)).values()];
    return { envelope: clone(e), state, applyToPage: !e.stopRequested && !!e.observedView && e.localCacheResult === 'patched' && this.pageMatches(e, true), ...(e.observedView ? { view: clone(e.observedView) } : {}), ...(e.observedTarget ? { targetData: { project: clone(e.observedTarget), materials, results: [] } } : {}), ...(reason ? { reason } : {}) };
  }
  private async data(e: AssistantProjectCopyEnvelope) { check(e.targetProjectId); const data = await this.options.projectData(e.targetProjectId, this.options.signal); this.live(); this.unchanged(e); check(validProject(data.project) && targetIdentity(e, data.project) && Array.isArray(data.materials) && data.materials.every(validMaterial) && Array.isArray(data.results) && !data.results.length, '目标项目或任务状态已变化，请先核对；已有文件保留。'); return data; }
  private checkMaterials(e: AssistantProjectCopyEnvelope, data: AssistantProjectCopyProjectData) { const pins = [...new Map(e.items.filter(i => i.targetPin).map(i => [JSON.stringify(i.targetPin), i.targetPin!] as const)).values()]; check(data.materials.length === pins.length && data.materials.every(m => pins.some(p => same(p, pinOf(e.targetProjectId!, m)))), '目标项目的文件已变化，已暂停复用；已有文件保留，请先核对。'); }
  private async targetInitial(e: AssistantProjectCopyEnvelope) { const data = await this.data(e); this.checkMaterials(e, data); check(data.project.draft_revision === 1 && same(projectView(data.project), e.targetBase ?? initialTarget(e)), '目标项目信息或版本已变化，已暂停保存；已有修改保留，请先核对。'); return data; }
  private async targetBusinessInitial(e: AssistantProjectCopyEnvelope) { const data = await this.data(e); check(data.project.draft_revision === 1 && same(projectView(data.project), e.targetBase ?? initialTarget(e)), '目标项目信息或版本已变化，未核对原上传回执。'); }
  private async available(e: AssistantProjectCopyEnvelope, w: M4Workspace): Promise<{ envelope: AssistantProjectCopyEnvelope; available: boolean }> {
    let valid = true;
    try { const data = await this.data(e); this.checkMaterials(e, data); check(data.project.draft_revision === 2 && same(projectView(data.project), e.expectedTarget)); for (const i of e.items) { check(i.material && i.targetPin); const material = await this.api.material(e.targetProjectId!, i.material.material_id, this.options.signal, i.material.material_version); this.live(); this.unchanged(e); check(validMaterial(material) && same(materialIdentity(material), materialIdentity(i.material))); if (!w.materials.some(p => same(p, i.targetPin))) { if (i.membership !== 'unavailable') e = this.update(e, {}, i.index, { membership: 'unavailable' }); valid = false; } else if (i.membership === 'unavailable') { valid = false; } } } catch (error) { this.live(); this.unchanged(e); if (error instanceof UploadRecoveryStorageError) throw error; valid = false; }
    return { envelope: e, available: valid };
  }
  private memberState(e: AssistantProjectCopyEnvelope, w: M4Workspace) { let available = true; for (const original of e.items) { const i = e.items[original.index]; if (i.membership === 'unavailable') available = false; else if (i.membership === 'confirmed' && !w.materials.some(p => same(p, i.targetPin))) { e = this.update(e, {}, i.index, { membership: 'unavailable' }); available = false; } } return { envelope: e, available }; }
  private async observeTarget(e: AssistantProjectCopyEnvelope): Promise<AssistantProjectCopyResult> {
    let data: AssistantProjectCopyProjectData; try { data = await this.data(e); this.checkMaterials(e, data); } catch (error) { this.live(); this.unchanged(e); if (error instanceof UploadRecoveryStorageError) throw error; return this.result(e, 'conflict', '原目标当前字段、状态或文件集合已变化，未重基原保存。'); } const p = data.project;
    if (p.draft_revision === 2 && same(projectView(p), e.expectedTarget)) { if (!e.observedTarget) e = this.update(e, { observedTarget: clone(p), stage: 'target_patch_confirmed' }); const members = this.memberState(e, await this.workspace(e)); return this.result(members.envelope, members.available ? 'pending' : 'unavailable', members.available ? '目标项目信息已保存，尚未用于原完整对话。' : '已证明的原对话成员已移除，未自动重新加入。'); }
    if (!e.observedTarget && p.draft_revision === 1 && same(projectView(p), e.targetBase)) { const members = this.memberState(e, await this.workspace(e)); return this.result(members.envelope, members.available ? 'retryable' : 'unavailable', members.available ? '目标项目信息尚未确认保存，可继续原保存请求。' : '已证明的原对话成员已移除，未继续原项目保存或自动重新加入。'); }
    return this.result(e, 'conflict', '目标项目信息或版本已变化，已暂停保存；已有修改保留，请先核对。');
  }
  private async patchTarget(e: AssistantProjectCopyEnvelope, retry: boolean): Promise<AssistantProjectCopyResult> {
    const observed = await this.observeTarget(e); e = observed.envelope; if (e.observedTarget || observed.state !== 'retryable') return observed; if (e.stage === 'target_patch_unknown' && !retry) return observed;
    this.requireBase(e); const w = await this.workspace(e); this.requireBase(e); this.checkServer(e, w);
    e = await this.topic(e, async () => { const next = this.update(e, { stage: 'target_patch_unknown' }); this.requireBase(next); return next; });
    try { const p = await this.topic(e, () => this.api.patch(e.targetProjectId!, 1, clone(e.targetPatch!))); this.live(); this.unchanged(e); if (validProject(p) && targetIdentity(e, p) && p.draft_revision === 2 && same(projectView(p), e.expectedTarget)) e = this.update(e, { observedTarget: clone(p), stage: 'target_patch_confirmed' }); }
    catch (error) { this.live(); this.unchanged(e); if (error instanceof AssistantViewCacheError || error instanceof UploadRecoveryStorageError) throw error; }
    if (e.observedTarget) return this.result(e, 'pending', '目标项目信息已保存，尚未用于原完整对话。'); this.requireBase(e); return this.observeTarget(e);
  }
  private async transfer(e: AssistantProjectCopyEnvelope, index: number, options: AssistantProjectCopyResumeOptions): Promise<AssistantProjectCopyResult> {
    let i = e.items[index]; this.requireBase(e); check(e.targetProjectId);
    if (i.coreState === 'unprepared') { e = await this.topic(e, async () => { const next = this.update(e, { stage: 'ordered_items' }, index, { coreState: 'prepared' }); this.core(next.targetProjectId!).begin(i.declaration, assistantProjectCopyContext(next, index), i.id); return this.update(next, {}, index, { coreState: 'known' }); }); i = e.items[index]; }
    const records = this.core(e.targetProjectId!).list(), record = records.find(r => r.id === i.id); check(record && assistantProjectCopyRecordMatches(e, index, record));
    if (!i.material) {
      if (record.stage === 'creating' && !record.uploadId) return this.result(e, 'unknown', '原文件上传请求结果尚未确认。已保留原待办，未重新建立上传；可只读核对或停止本机处理。');
      e = this.update(e, {}, index, { stage: 'transport_unknown' }); i = e.items[index]; const core = this.core(e.targetProjectId!, e);
      const file = async () => { this.requireBase(e); const source = await this.api.material(i.sourceProjectId, i.sourceMaterial.material_id, this.options.signal, i.sourceMaterial.material_version); this.live(); this.unchanged(e); this.requireBase(e); check(validMaterial(source) && same(materialIdentity(source), materialIdentity(i.sourceMaterial)), '原来源文件版本已变化或不可读，未改用其他文件。'); const bytes = await this.api.materialBytes(i.sourceProjectId, source, this.options.signal); this.live(); this.unchanged(e); this.requireBase(e); check(bytes instanceof Blob && bytes.size === i.declaration.byte_size); return new File([bytes], i.declaration.filename, { type: i.declaration.media_type }); };
      const report = (fn: () => void) => { try { this.requireBase(e); } catch { return; } fn(); };
      const callbacks = { signal: this.options.signal, requireDurableRecord: true, status: (message: string) => report(() => options.status?.(message, index)), progress: (loaded: number, total: number) => report(() => options.progress?.(loaded, total, index)) };
      let material: Dto<'MaterialResponse'>;
      try { if (record.uploadId) { try { material = await core.resume(i.id, callbacks); } catch (error) { if (!(error instanceof UploadRecoveryNeedsFileError)) throw error; this.requireBase(e); material = await core.resume(i.id, { ...callbacks, file: await file() }); } } else material = await core.resume(i.id, { ...callbacks, file: await file() }); }
      catch (error) { this.live(); this.unchanged(e); this.requireBase(e); if (error instanceof AssistantViewCacheError || error instanceof UploadRecoveryStorageError) throw error; return this.result(e, 'unknown', '原文件保存结果尚未确认，原待办已保留，请核对后继续。'); }
      this.live(); this.unchanged(e); this.requireBase(e); const saved = this.core(e.targetProjectId!).list().find(r => r.id === i.id); check(saved && assistantProjectCopyRecordMatches(e, index, saved) && saved.stage === 'saved' && saved.uploadId && same(materialIdentity(saved.material!), materialIdentity(material)));
      e = this.update(e, {}, index, { material: validateUploadMaterial(i.declaration, material), requestUploadId: saved.uploadId, targetPin: pinOf(e.targetProjectId!, material), stage: 'material_saved' }); i = e.items[index];
    }
    await this.targetInitial(e); this.requireBase(e); let w = await this.workspace(e); this.requireBase(e); this.checkServer(e, w); const member = w.materials.some(p => same(p, i.targetPin));
    if (i.membership === 'unavailable' || !member && i.membership === 'confirmed') { if (i.membership !== 'unavailable') e = this.update(e, {}, index, { membership: 'unavailable' }); return this.result(e, 'unavailable', '原文件的对话关联已移除，未自动重新加入；已有文件保留，请先核对。'); }
    if (!member) { if (i.membership === 'unknown' && !options.retryMembership) return this.result(e, 'pending', '文件已保存，加入原对话的结果尚待核对。'); e = this.update(e, {}, index, { stage: 'membership_unknown', membership: 'unknown' }); this.requireBase(e); try { await this.topic(e, () => this.m4.material(this.topicId, clone(e.items[index].targetPin!))); } catch (error) { this.live(); this.unchanged(e); if (error instanceof AssistantViewCacheError || error instanceof UploadRecoveryStorageError) throw error; } this.requireBase(e); w = await this.workspace(e); this.requireBase(e); this.checkServer(e, w); if (!w.materials.some(p => same(p, e.items[index].targetPin))) return this.result(e, 'pending', '文件已保存，尚未确认加入原对话。'); }
    if (e.items[index].membership !== 'confirmed') e = this.update(e, {}, index, { stage: 'member_confirmed', membership: 'confirmed' }); return this.result(e, 'pending');
  }
  /** A durable saved transport receipt is authoritative even when its envelope marker was interrupted. */
  private absorb(e: AssistantProjectCopyEnvelope) {
    if (!e.targetProjectId) return e; const records = this.core(e.targetProjectId).list();
    for (const original of e.items) { let i = e.items[original.index]; if (i.coreState === 'unprepared' || i.coreState === 'cleaned') continue; const r = records.find(r => r.id === i.id); check(r && assistantProjectCopyRecordMatches(e, i.index, r), '原上传槽已丢失或被替换，未从内存重建原操作。'); if (i.coreState === 'prepared') { e = this.update(e, {}, i.index, { coreState: 'known' }); i = e.items[i.index]; }
      if (r.stage === 'saved') { check(r.material && r.uploadId); const m = validateUploadMaterial(i.declaration, r.material); if (i.material) check(same(materialIdentity(i.material), materialIdentity(m)) && i.requestUploadId === r.uploadId); else e = this.update(e, {}, i.index, { material: clone(m), requestUploadId: r.uploadId, targetPin: pinOf(e.targetProjectId!, m), stage: 'material_saved' }); }
      else check(!i.material, '已证明的原保存回执已变化，未继续业务请求。');
    }
    return e;
  }
  /** Original-U complete may already have accepted while its durable receipt is still unknown. Never infer it from a list. */
  private async confirmKnownTransports(e: AssistantProjectCopyEnvelope): Promise<AssistantProjectCopyResult> {
    if (!e.targetProjectId || e.targetPatch) return this.result(e, 'pending');
    for (const original of e.items) { const i = e.items[original.index]; if (i.material || i.coreState === 'unprepared') continue; const record = this.core(e.targetProjectId!).list().find(r => r.id === i.id); check(record && assistantProjectCopyRecordMatches(e, i.index, record));
      if (!record.uploadId) { if (record.stage === 'creating') return this.result(e, 'unknown', '原上传session无准确回执，未另建上传。'); continue; }
      this.requireBase(e); await this.targetBusinessInitial(e); this.requireBase(e);
      try { await this.core(e.targetProjectId!, e).resume(i.id, { signal: this.options.signal, requireDurableRecord: true }); }
      catch (error) { this.live(); this.unchanged(e); this.requireBase(e); if (error instanceof UploadRecoveryNeedsFileError) { if (record.stage === 'creating') return this.result(e, 'unknown', '先前替换上传session的结果尚未确认，未再次建立session。'); continue; } if (error instanceof AssistantViewCacheError || error instanceof UploadRecoveryStorageError) throw error; return this.result(e, 'unknown', '原上传标识的保存结果尚未确认，未从目标列表猜测回执。'); }
      this.live(); this.unchanged(e); this.requireBase(e); e = this.absorb(e);
    }
    return this.result(e, 'pending');
  }
  private async createTarget(e: AssistantProjectCopyEnvelope, retry: boolean): Promise<AssistantProjectCopyResult> {
    if (e.targetProjectId) return this.result(e, 'pending');
    if (e.stage === 'target_create_unknown' && !retry) return this.result(e, 'unknown', '原目标建立请求结果待核对；继续会明确重发同一份原请求及原标识。');
    this.requireBase(e); const w = await this.workspace(e); this.requireBase(e); this.checkServer(e, w);
    if (e.stage === 'prepared') { e = this.update(e, { stage: 'target_create_prepared' }); this.requireBase(e); }
    e = this.update(e, { stage: 'target_create_unknown' }); this.requireBase(e);
    let target: Dto<'ProjectResponse'>;
    try { target = await this.topic(e, () => this.api.create(clone(e.createRequest))); }
    catch (error) { this.live(); this.unchanged(e); if (error instanceof AssistantViewCacheError || error instanceof UploadRecoveryStorageError) throw error; return this.result(e, error instanceof ApiError && error.code === 'IDEMPOTENCY_CONFLICT' ? 'conflict' : 'unknown', '原目标建立结果尚未确认，原完整请求和标识已保留，未建立替代目标。'); }
    this.live(); this.unchanged(e); check(validProject(target) && target.project_id !== e.sourceProjectId && target.project_id !== e.scopeProjectId, '原目标回执无法可靠核实，未采用其他项目。');
    // Same-key POST replays the current DTO. Save the known ID before testing whether it is still initial.
    e = this.update(e, { targetProjectId: target.project_id, createdTarget: clone(target), targetBase: initialTarget(e), stage: 'target_known' });
    if (!creationInitial(e)) return this.result(e, 'conflict', '原标识已确定目标，但回执中的当前项目已改变或不可采用；未继续复制或建立替代项目。');
    this.requireBase(e); return this.result(e, 'pending');
  }
  private async cleanup(e: AssistantProjectCopyEnvelope): Promise<AssistantProjectCopyResult> {
    check(e.observedView && ['view_confirmed', 'cleanup_pending', 'complete'].includes(e.stage));
    if (e.stage === 'view_confirmed') e = this.update(e, { stage: 'cleanup_pending' });
    if (e.localCacheResult === 'pending') { const result = await this.cache.confirm(this.topicId, this.scopeProjectId, e.baseCache, e.basePage, savedSnapshot(e), e.id, () => { this.live(); this.unchanged(e); return this.pageMatches(e); }); this.live(); this.unchanged(e); e = this.update(e, { localCacheResult: result.patched ? 'patched' : 'preserved' }); }
    if (e.localCacheResult === 'preserved') await this.retainAlreadyRead(e);
    for (const original of e.items) { const i = e.items[original.index]; if (i.coreState === 'cleaned' || i.coreState === 'unprepared') continue; const core = this.core(e.targetProjectId!), r = core.list().find(r => r.id === i.id); check(!r || assistantProjectCopyRecordMatches(e, i.index, r)); this.retained(e); await core.forget(i.id); this.live(); this.unchanged(e); e = this.update(e, {}, i.index, { coreState: 'cleaned' }); }
    if (e.localCacheResult === 'patched') { const c = this.cache.read(this.topicId, this.scopeProjectId); if (!c || !same(c.snapshot, savedSnapshot(e)) || !this.pageMatches(e, true)) e = this.update(e, { localCacheResult: 'preserved' }); }
    this.retained(e); if (e.stage !== 'complete') e = this.update(e, { stage: 'complete' }); this.retained(e); this.remove(e);
    return this.result(e, 'complete', e.localCacheResult === 'preserved' ? '原目标、文件及服务器完整会话效果已核实；新的完整本机输入或当前不可用状态保留，未应用到本页。' : undefined);
  }
  /** Refresh may already display exact server S with freshly read target runtime, while cache still holds original B. */
  private async retainAlreadyRead(e: AssistantProjectCopyEnvelope) {
    this.live(); this.unchanged(e); const page = this.options.snapshot(); if (!assistantValidSnapshot(page) || page.dirty || page.conflict || page.version !== e.observedView?.version || !same(page.view, e.expectedView)) return;
    const before = this.cache.read(this.topicId, this.scopeProjectId); if (before && same(before.snapshot, page)) return;
    const ownSaved = before && same(before.snapshot, savedSnapshot(e)) && same(before.proof, { operationId: e.id, base: e.basePage, saved: savedSnapshot(e) });
    if (!same(before, e.baseCache) && !ownSaved) return;
    const result = await this.cache.merge(this.topicId, this.scopeProjectId, before, page); this.live(); this.unchanged(e);
    check(result.accepted && same(this.options.snapshot(), page) && same(this.cache.read(this.topicId, this.scopeProjectId)?.snapshot, page), '当前完整会话或任务状态在保存时又有变化，已保留原清理待办，请先核对。');
  }
  private async observeView(e: AssistantProjectCopyEnvelope): Promise<AssistantProjectCopyResult> {
    check(e.viewRequest && e.expectedView); const w = await this.workspace(e), observed = w.view, verified = await this.available(e, w); e = verified.envelope;
    if (observed.version === e.basePage.version + 1 && same(viewOf(observed), e.expectedView)) { const preserved = !verified.available || !same(serverIdentity(w), e.baseServerIdentity); if (!e.observedView) e = this.update(e, { observedView: clone(observed), stage: preserved ? 'cleanup_pending' : 'view_confirmed', ...(preserved ? { localCacheResult: 'preserved' as const } : {}) }); return this.cleanup(e); }
    if (e.observedView) return this.result(e, 'conflict', '原完整会话效果已核实，但服务器后续内容或版本已变化。');
    if (!verified.available) return this.result(e, 'unavailable', '原目标已知，但准确文件、原对话成员或项目信息当前不可用；已有文件保留。');
    if (observed.version === e.basePage.version && same(viewOf(observed), e.basePage.view) && same(serverIdentity(w), e.baseServerIdentity)) return this.result(e, 'retryable', '尚未观察到原完整会话采用；可明确继续同一份完整原请求。');
    return this.result(e, 'conflict', '原完整对话内容、版本或任务状态已变化，未覆盖或重基新会话。');
  }
  private async submitView(e: AssistantProjectCopyEnvelope): Promise<AssistantProjectCopyResult> {
    this.requireBase(e); let w = await this.workspace(e); this.requireBase(e); this.checkServer(e, w); const verified = await this.available(e, w); e = verified.envelope;
    if (!verified.available) return this.result(e, 'unavailable', '原目标或准确材料当前不可采用，已有保存结果保留。');
    this.requireBase(e); w = await this.workspace(e); this.requireBase(e); this.checkServer(e, w);
    if (e.stage !== 'view_unknown') e = this.update(e, { stage: 'view_unknown' }); this.requireBase(e);
    try { const response = await this.topic(e, () => this.m4.view(this.topicId, clone(e.viewRequest!))); this.live(); this.unchanged(e); check(exact(response, ['view']) && validView(response.view) && response.view.version === e.basePage.version + 1 && same(viewOf(response.view), e.expectedView), '原完整会话回执不完整或不符；已保留原请求，等待准确只读核对。'); }
    catch (error) { this.live(); this.unchanged(e); if (error instanceof AssistantViewCacheError || error instanceof UploadRecoveryStorageError) throw error; }
    return this.observeView(e);
  }
  async resume(id: string, options: AssistantProjectCopyResumeOptions = {}): Promise<AssistantProjectCopyResult> { return this.locked(id, async () => {
    let e = this.read(id);
    if (e.stopRequested) { await this.finishStop(e); return this.result(e, 'complete', '本机后续处理已停止；服务器目标、文件、成员及已有会话保留。'); }
    if (['view_confirmed', 'cleanup_pending', 'complete'].includes(e.stage)) { if (e.localCacheResult !== 'preserved') e = this.update(e, { stage: e.stage === 'complete' ? 'complete' : 'cleanup_pending', localCacheResult: 'preserved' }); return this.cleanup(e); }
    if (e.viewRequest) { const r = await this.observeView(e); if (r.state !== 'retryable' || !options.retryView) return r; return this.submitView(this.read(id)); }
    // A saved core receipt is absorbed before checking the target's whole material set.
    e = this.absorb(e); this.requireBase(e);
    if (!e.targetProjectId) { const r = await this.createTarget(e, !!options.retryTargetCreate); e = r.envelope; if (!e.targetProjectId || r.state !== 'pending') return r; }
    if (!creationInitial(e)) return this.result(e, 'conflict', '原目标建立回执已知但不再是原初始项目，未继续复制或建立替代目标。');
    const confirmed = await this.confirmKnownTransports(e); e = confirmed.envelope; if (confirmed.state !== 'pending') return confirmed;
    if (e.targetPatch) { const r = await this.patchTarget(e, !!options.retryTargetPatch); e = r.envelope; if (!e.observedTarget || r.state === 'conflict' || r.state === 'unavailable') return r; }
    else {
      try { await this.targetInitial(e); } catch (error) { this.live(); this.unchanged(e); if (error instanceof UploadRecoveryStorageError) throw error; return this.result(e, 'conflict', '原目标已知，但其当前业务字段、版本或文件集合已变化；未继续复制或建立替代项目。'); } this.requireBase(e);
      for (const original of e.items) { const r = await this.transfer(e, original.index, options); e = r.envelope; if (r.state !== 'pending' || e.items[original.index].membership !== 'confirmed') return r; }
      this.requireBase(e); let mapped: SourceProspectus[];
      try { mapped = mapping(e); } catch (error) { if (!(error instanceof AssistantViewCacheError)) throw error; for (const i of e.items) if (i.sourceProspectus && i.mapping !== 'conflict') e = this.update(e, {}, i.index, { mapping: 'conflict' }); return this.result(e, 'conflict', error.message); }
      const seen = new Set<string>(); for (const i of e.items) { const m = i.sourceProspectus ? seen.has(i.targetPin!.material_id) ? 'merged' : 'mapped' : 'mapped'; if (i.sourceProspectus) seen.add(i.targetPin!.material_id); if (i.mapping !== m) e = this.update(e, {}, i.index, { mapping: m }); }
      const targetBase = e.targetBase ?? initialTarget(e), targetPatch = { ...clone(targetBase), update_details: { ...clone(targetBase.update_details!), source_prospectuses: clone(mapped) } };
      e = this.update(e, { targetBase, mappedSources: mapped, targetPatch, targetPatchDigest: digest(targetPatch), expectedTarget: clone(targetPatch), stage: 'target_patch_prepared' }); this.requireBase(e);
      const patched = await this.patchTarget(e, false); e = patched.envelope; if (!e.observedTarget || patched.state === 'conflict' || patched.state === 'unavailable') return patched;
    }
    this.requireBase(e); const w = await this.workspace(e); this.requireBase(e); this.checkServer(e, w); const verified = await this.available(e, w); e = verified.envelope;
    if (!verified.available) return this.result(e, 'unavailable', '原目标信息已保存，但准确材料或原对话成员当前不可采用。'); this.requireBase(e);
    const expectedView = assistantProjectCopyAdoptionView(e), viewRequest = { expected_version: e.basePage.version, view: expectedView };
    e = this.update(e, { expectedView, viewRequest, viewRequestDigest: digest(viewRequest), stage: 'view_prepared' }); this.requireBase(e); return this.submitView(e);
  }); }
  /** Only GETs and local proof/cleanup. It never resumes transport or submits business requests. */
  async reconcile(id: string): Promise<AssistantProjectCopyResult> { return this.locked(id, async () => {
    let e = this.read(id);
    if (e.stopRequested) { await this.finishStop(e); return this.result(e, 'complete', '本机后续处理已停止；服务器目标、文件、成员及已有会话保留。'); }
    if (['view_confirmed', 'cleanup_pending', 'complete'].includes(e.stage)) { if (e.localCacheResult !== 'preserved') e = this.update(e, { stage: e.stage === 'complete' ? 'complete' : 'cleanup_pending', localCacheResult: 'preserved' }); return this.cleanup(e); }
    if (e.viewRequest) return this.observeView(e);
    e = this.absorb(e); if (!e.targetProjectId) return this.result(e, e.stage === 'target_create_unknown' ? 'unknown' : 'pending', '原目标尚未确认；未从项目列表选择候选。');
    if (!creationInitial(e)) return this.result(e, 'conflict', '原目标建立回执已知但当前DTO不符合原初始依据，未继续采用。');
    if (e.targetPatch) return this.observeTarget(e);
    try { await this.targetInitial(e); } catch (error) { this.live(); this.unchanged(e); if (error instanceof UploadRecoveryStorageError) throw error; return this.result(e, 'conflict', '原目标当前信息、版本或文件集合与原依据不同；已有保存结果保留。'); }
    const w = await this.workspace(e); for (const original of e.items) { const i = e.items[original.index]; if (!i.material) continue; const member = w.materials.some(p => same(p, i.targetPin)); if (!member && ['confirmed', 'unavailable'].includes(i.membership)) { if (i.membership !== 'unavailable') e = this.update(e, {}, i.index, { membership: 'unavailable' }); }
      else if (member && i.membership !== 'confirmed' && i.membership !== 'unavailable') e = this.update(e, {}, i.index, { membership: 'confirmed', stage: 'member_confirmed' }); }
    if (e.items.some(i => i.membership === 'unavailable')) return this.result(e, 'unavailable', '已证明的原对话成员已移除，未自动重新加入。');
    const records = this.core(e.targetProjectId!).list(); if (e.items.some(i => !i.material && records.some(r => r.id === i.id && r.stage === 'creating' && !r.uploadId))) return this.result(e, 'unknown', '原文件上传session尚无准确回执，未另建上传。');
    return this.result(e, 'pending', '只读核对已完成；尚未进行后续保存或采用。');
  }); }
  private retained(e: AssistantProjectCopyEnvelope) { const page = this.options.snapshot(), cache = this.cache.read(this.topicId, this.scopeProjectId); check(assistantValidSnapshot(page)); if (!same(page, e.basePage) && !same(page, savedSnapshotIfKnown(e))) check(cache && same(cache.snapshot, page), '新的完整本机输入或任务状态尚未可靠缓存，保留清理待办，请先保存。'); }
  private remove(e: AssistantProjectCopyEnvelope) { this.live(); this.unchanged(e); try { const s = this.store(), key = this.prefix + encodeURIComponent(e.id); s.removeItem(key); check(s.getItem(key) === null); } catch (error) { if (error instanceof AssistantViewCacheError) throw error; throw new UploadRecoveryStorageError(); } }
  private async preserveConflict(e?: AssistantProjectCopyEnvelope) {
    this.live(); if (e) this.unchanged(e); const page = this.options.snapshot(), before = this.cache.read(this.topicId, this.scopeProjectId); check(assistantValidSnapshot(page) && before); const marked = { ...clone(page), conflict: true };
    const ownSaved = e?.observedView && same(page, e.basePage) && same(before.snapshot, savedSnapshot(e)) && same(before.proof, { operationId: e.id, base: e.basePage, saved: savedSnapshot(e) });
    check(same(before.snapshot, page) || same(before.snapshot, marked) || ownSaved, '完整本机输入尚未可靠保存，或另一页面已有不同草稿；已保留停止意图与原待办，请先核对。');
    const result = await this.cache.merge(this.topicId, this.scopeProjectId, before, marked); this.live(); if (e) this.unchanged(e); check(result.accepted && same(this.options.snapshot(), page) && same(this.cache.read(this.topicId, this.scopeProjectId)?.snapshot, marked), '新的完整本机输入已变化，停止意图保留，未删除其原追踪。');
  }
  private async finishStop(e: AssistantProjectCopyEnvelope) {
    check(e.stopRequested); await this.preserveConflict(e);
    if (e.targetProjectId) for (const original of e.items) { const i = e.items[original.index]; if (i.coreState === 'cleaned' || i.coreState === 'unprepared') continue; const core = this.core(e.targetProjectId!), r = core.list().find(r => r.id === i.id); check(!r || assistantProjectCopyRecordMatches(e, i.index, r)); await this.preserveConflict(e); await core.forget(i.id); this.live(); this.unchanged(e); e = this.update(e, {}, i.index, { coreState: 'cleaned' }); await this.preserveConflict(e); }
    await this.preserveConflict(e); this.remove(e);
  }
  async stop(id: string): Promise<void> { return this.locked(id, async () => { let e = this.read(id); if (!e.stopRequested) e = this.update(e, { stopRequested: true }); return this.finishStop(e); }); }
  async removeOrphan(targetProjectId: string, recordId: string): Promise<void> { return this.locked('orphan-' + digest({ targetProjectId, recordId }).slice(0, 32), async () => {
    check(validId(targetProjectId) && validId(recordId)); const core = this.core(targetProjectId), record = this.transportRecords().find(r => r.projectId === targetProjectId && r.id === recordId); check(record && !this.list().some(e => e.targetProjectId === targetProjectId && e.items.some(i => i.id === recordId)), '该文件仍有完整原复用待办，请先处理原操作。');
    await this.preserveConflict(); check(!this.list().some(e => e.targetProjectId === targetProjectId && e.items.some(i => i.id === recordId)) && same(core.list().find(r => r.id === recordId), record)); await core.forget(recordId); this.live(); await this.preserveConflict();
  }); }
}
const savedSnapshotIfKnown = (e: AssistantProjectCopyEnvelope) => e.expectedView ? savedSnapshot(e) : undefined;
