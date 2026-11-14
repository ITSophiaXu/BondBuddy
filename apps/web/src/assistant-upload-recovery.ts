import {uploadFileDigest} from './upload-file-digest.js';
import { M1_UPLOAD_LIMITS, M1_UPLOAD_MIME_TYPES, M4MaterialPinSchema, type M4MaterialPin, type M4Workspace } from './billing-types.js';
import { UserFacingError } from './user-facing-error.js';
import { Value } from '@sinclair/typebox/value';
import type { Dto } from './api.js';
import { UploadRecovery, UploadRecoveryConflictError, UploadRecoveryStorageError, type UploadRecoveryDependencies,
  type UploadRecoveryRecord, type UploadRecoveryResumeOptions } from './upload-recovery.js';
import { assistantSame, assertAssistantTemplateClear, withAssistantTopicWrite } from './assistant-view-cache.js';

export type AssistantUploadEntry = 'attachment' | 'business';
export class AssistantUploadRecoveryError extends UserFacingError {}
type AssistantMaterialApi = { workspace(topic: string): Promise<M4Workspace>; material(topic: string, material: M4MaterialPin): Promise<unknown> };
type Context = { version: 1; kind: 'assistant-material'; topic_id: string; entrypoint: AssistantUploadEntry };
const purpose = 'assistant-material';
const validId = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
const samePin = (a: M4MaterialPin, b: M4MaterialPin) => a.source_project_id === b.source_project_id && a.material_id === b.material_id && a.material_version === b.material_version && a.sha256 === b.sha256;
const materialPin = (project: string, value: Dto<'MaterialResponse'>): M4MaterialPin => ({ source_project_id: project, material_id: value.material_id, material_version: value.material_version, sha256: value.sha256 });
function context(record: UploadRecoveryRecord): Context {
  const value = record.context;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'entrypoint,kind,topic_id,version' ||
    value.version !== 1 || value.kind !== purpose || !validId(value.topic_id) || !['attachment', 'business'].includes(String(value.entrypoint))) throw new UploadRecoveryConflictError();
  return value as Context;
}

/** Ordinary attachments only. Templates and cross-project copying have separate business stages. */
export class AssistantUploadRecovery {
  private cores = new Map<string, UploadRecovery>();
  private topicWrites = new Map<string, Promise<void>>();
  constructor(private api: ConstructorParameters<typeof UploadRecovery>[0], private m4: AssistantMaterialApi,
    private owner: string, private current = () => true, private dependencies: UploadRecoveryDependencies & { signal?: AbortSignal; coordinatePrepare?: (topic: string) => void } = {}) {
    if (!validId(owner)) throw new UploadRecoveryConflictError();
  }
  private live() { this.dependencies.signal?.throwIfAborted(); if (!this.current()) throw new DOMException('当前账号已变更。', 'AbortError'); }
  private recovery(project: string) { let value = this.cores.get(project); if (!value) { value = new UploadRecovery(this.api, this.owner, project, purpose, this.current, this.dependencies); this.cores.set(project, value); } return value; }
  private topicWrite<T>(topic: string, action: () => Promise<T>, signal: AbortSignal | undefined = this.dependencies.signal): Promise<T> {
    const pending = (this.topicWrites.get(topic) ?? Promise.resolve()).then(() => withAssistantTopicWrite(this.owner, topic, this.current, this.dependencies, action, signal));
    const settled = pending.then(() => {}, () => {}); this.topicWrites.set(topic, settled);
    void settled.then(() => { if (this.topicWrites.get(topic) === settled) this.topicWrites.delete(topic); });
    return pending;
  }
  /** Only discover this owner's local transport scopes, then let the core strictly parse every record. No server discovery. */
  list(topic: string): UploadRecoveryRecord[] {
    this.live(); if (!validId(topic)) throw new UploadRecoveryConflictError();
    const projects = new Set<string>(), ownPrefix = 'bondbuddy:upload-recovery:v1:' + encodeURIComponent(this.owner) + ':';
    try {
      const store = this.dependencies.store ?? globalThis.localStorage;
      if (!store) throw new Error();
      for (let index = 0; index < store.length; index++) {
        const key = store.key(index); if (!key?.startsWith(ownPrefix)) continue;
        const parts = key.slice(ownPrefix.length).split(':'), [encodedProject, encodedPurpose, encodedId, encodedSlot] = parts;
        if (decodeURIComponent(encodedPurpose ?? '') !== purpose) continue;
        if (encodedPurpose !== encodeURIComponent(purpose) || parts.length !== 4) throw new Error();
        const project = decodeURIComponent(encodedProject);
        if (!validId(project) || encodeURIComponent(project) !== encodedProject || ![encodedId, encodedSlot].every(value => { const decoded = decodeURIComponent(value); return validId(decoded) && encodeURIComponent(decoded) === value; })) throw new Error(); projects.add(project);
      }
    } catch { throw new UploadRecoveryStorageError(); }
    return [...projects].flatMap(project => this.recovery(project).list()).filter(record => context(record).topic_id === topic);
  }
  async begin(file: File, role: Dto<'UploadCreateRequest'>['role'], project: string, topic: string, entrypoint: AssistantUploadEntry, id: string): Promise<UploadRecoveryRecord> {
    this.live(); if (!validId(topic) || !['attachment', 'business'].includes(entrypoint)) throw new UploadRecoveryConflictError();
    assertAssistantTemplateClear(this.api, this.owner, topic, this.current, this.dependencies); this.dependencies.coordinatePrepare?.(topic);
    const media: Record<string, typeof M1_UPLOAD_MIME_TYPES[number]> = { docx: M1_UPLOAD_MIME_TYPES[0], pdf: M1_UPLOAD_MIME_TYPES[1], xlsx: M1_UPLOAD_MIME_TYPES[2], csv: M1_UPLOAD_MIME_TYPES[3], txt: M1_UPLOAD_MIME_TYPES[4], png: M1_UPLOAD_MIME_TYPES[5], jpg: M1_UPLOAD_MIME_TYPES[6], jpeg: M1_UPLOAD_MIME_TYPES[6] };
    const mime = media[file.name.split('.').at(-1)?.toLowerCase() ?? ''];
    if (!mime || !file.size || file.size > M1_UPLOAD_LIMITS.fileBytes) throw new AssistantUploadRecoveryError('文件格式或大小不符合上传要求。');
    const digest = this.dependencies.digest ? await this.dependencies.digest(file) : [...new Uint8Array(await uploadFileDigest(file,this.dependencies.signal))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    this.live();
    // Queue this helper's short topic phases so concurrent picks and final member
    // checks cannot reject each other through the fail-fast cross-page lock.
    return this.topicWrite(topic, async () => { assertAssistantTemplateClear(this.api, this.owner, topic, this.current, this.dependencies); this.dependencies.coordinatePrepare?.(topic); return this.recovery(project).begin({ filename: file.name, media_type: mime, byte_size: file.size, sha256: digest, role }, { version: 1, kind: purpose, topic_id: topic, entrypoint }, id); });
  }
  async resume(original: UploadRecoveryRecord, options: Omit<UploadRecoveryResumeOptions, 'previousRecord'> = {}): Promise<{ material: Dto<'MaterialResponse'>; associated: true; uploadId?: string }> {
    this.live(); const expected = context(original);
    if (original.owner !== this.owner || original.purpose !== purpose) throw new UploadRecoveryConflictError();
    assertAssistantTemplateClear(this.api, this.owner, expected.topic_id, this.current, this.dependencies);
    const recovery = this.recovery(original.projectId), durable = recovery.list().find(record => record.id === original.id);
    const matchesOriginal = (record: UploadRecoveryRecord) => context(record).topic_id === expected.topic_id && context(record).entrypoint === expected.entrypoint &&
      (['filename', 'media_type', 'byte_size', 'sha256', 'role'] as const).every(key => record.declaration[key] === original.declaration[key]);
    // Missing known identities are never re-begun or restored from stale business context.
    if (!durable || !matchesOriginal(durable)) throw new UploadRecoveryConflictError();
    const material = await recovery.resume(original.id, options); this.live(); options.signal?.throwIfAborted();
    return this.topicWrite(expected.topic_id, async () => {
    assertAssistantTemplateClear(this.api, this.owner, expected.topic_id, this.current, this.dependencies);
    // A different tab can finish and clear this record after the core lock ends.
    // Unknown transport identity suppresses duplicate wording; material's older U
    // is never substituted for the actual request U.
    const finished = recovery.list().find(record => record.id === original.id);
    if (finished && (!matchesOriginal(finished) || finished.stage !== 'saved' || !assistantSame(finished.material, material))) throw new UploadRecoveryConflictError();
    const remaining = () => {
      const record = recovery.list().find(record => record.id === original.id);
      if (record && (!finished || !assistantSame(record, finished))) throw new UploadRecoveryConflictError();
      return record;
    };
    const pin = materialPin(original.projectId, material);
    const associated = async () => {
      const workspace = await this.m4.workspace(expected.topic_id); this.live(); options.signal?.throwIfAborted();
      if (workspace.topic.topic_id !== expected.topic_id || !Array.isArray(workspace.materials) || workspace.materials.some(value => !Value.Check(M4MaterialPinSchema, value))) throw new UploadRecoveryConflictError();
      return workspace.materials.some(value => samePin(value, pin));
    };
    if (!await associated()) {
      options.status?.('材料已保存，正在加入原对话…'); this.live();
      assertAssistantTemplateClear(this.api, this.owner, expected.topic_id, this.current, this.dependencies);
      if (!remaining()) throw new UploadRecoveryConflictError();
      await this.m4.material(expected.topic_id, pin); this.live(); options.signal?.throwIfAborted();
      if (!await associated()) throw new AssistantUploadRecoveryError('材料已保存，尚未确认加入原对话，请重试确认。');
    }
    const uploadId = remaining()?.uploadId;
    await recovery.forget(original.id); this.live(); return { material, associated: true, uploadId };
    }, options.signal);
  }
  forget(original: UploadRecoveryRecord) {
    this.live(); context(original); if (original.owner !== this.owner || original.purpose !== purpose) throw new UploadRecoveryConflictError();
    return this.recovery(original.projectId).forget(original.id);
  }
}
