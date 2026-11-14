import {uploadFileDigest} from './upload-file-digest.js';
import { M1_UPLOAD_LIMITS, M1_UPLOAD_MIME_TYPES, schemas } from './billing-types.js';
import { Value } from '@sinclair/typebox/value';
import { UserFacingError } from './user-facing-error.js';
import { ApiError, type ApiClient, type Dto } from './api.js';
import { isDateTime } from './schema-formats.js';
import { DIRECT_UPLOAD_TRANSPORT, type UploadTransport, isUploadInspectionPublicReason } from '@bondbuddy/contracts';

export type UploadRecoveryJson = null | boolean | number | string | UploadRecoveryJson[] | { [key: string]: UploadRecoveryJson };
export type UploadRecoveryStage = 'pending' | 'creating' | 'session' | 'bytes_unknown' | 'confirming' | 'saved';
export type UploadRecoveryRecord = {
  version: 1; id: string; owner: string; projectId: string; purpose: string;
  declaration: Dto<'UploadCreateRequest'>; context?: UploadRecoveryJson; stage: UploadRecoveryStage;
  uploadId?: string; expiresAt?: string; uploadTransport?: UploadTransport; previousUploadIds?: string[]; material?: Dto<'MaterialResponse'>;
  lastError?: { status: number; code: string; uploadReason?: string; correlationId?: string };
};
export type UploadRecoveryStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
export interface UploadRecoveryLock { run<T>(name: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T>; }
export type UploadRecoveryDependencies = {
  store?: UploadRecoveryStorage; lock?: UploadRecoveryLock; now?: () => number; id?: () => string;
  digest?: (file: File) => Promise<string>;
};
export type UploadRecoveryResumeOptions = {
  file?: File; signal?: AbortSignal; status?: (message: string) => void; progress?: (loaded: number, total: number) => void;
  /** Only a fresh, explicit file selection may replace an expired, unreceived session. */
  reselectExpiredSession?: boolean;
  /** Explicit user retry only: a scoped checkpoint retained before another tab forgot it. */
  previousRecord?: UploadRecoveryRecord;
  /** Opt-in business journal safety: an in-flight transfer cannot recreate a removed or replaced durable slot. */
  requireDurableRecord?: boolean;
};
type UploadApi = Pick<ApiClient, 'createUpload' | 'completeUpload' | 'uploadBytes' | 'material' | 'project'> & Partial<Pick<ApiClient,'refreshUpload'>>;
type MemorySession = { uploadId: string; url: string; expiresAt: string; transport?: UploadTransport };
const prefix = 'bondbuddy:upload-recovery:v1:';
const stages: UploadRecoveryStage[] = ['pending', 'creating', 'session', 'bytes_unknown', 'confirming', 'saved'];
const maxRecordLength = 256_000;
const uncertainPut = (error: unknown): error is ApiError => error instanceof ApiError && (error.status === 0 || error.status >= 500);
const bytesPending = (error: unknown): error is ApiError => error instanceof ApiError && error.status === 422 && error.code === 'MATERIAL_UNREADABLE' && error.details.uploadBytesPending === true && error.details.uploadReason === undefined;
const temporaryInspectionFailure = (error: ApiError) => error.status === 422 && error.code === 'MATERIAL_UNREADABLE' &&
  ['inspection_timeout', 'inspection_queue_timeout', 'inspection_worker_failed'].includes(String(error.details.uploadReason));
const validId = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => plain(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));

export class UploadRecoveryStorageError extends UserFacingError {
  constructor(public readonly record?: UploadRecoveryRecord, public readonly confirmedMaterial?: Dto<'MaterialResponse'>) { super('无法可靠保存上传恢复记录，请保留原文件并在本页重试确认。'); this.name = 'UploadRecoveryStorageError'; }
}
export class UploadRecoveryLockError extends UserFacingError {
  constructor() { super('另一页面正在处理这项上传，或当前浏览器暂不支持继续确认。请保留原文件，稍后重试。'); this.name = 'UploadRecoveryLockError'; }
}
export class UploadRecoveryConflictError extends UserFacingError {
  constructor() { super('上传恢复记录发生冲突，原文件声明和记录已保留，请勿改用其他文件继续。'); this.name = 'UploadRecoveryConflictError'; }
}
export class UploadRecoveryReceiptError extends UserFacingError {
  constructor() { super('上传回执与原文件声明不一致，尚未确认材料保存，请重试确认原上传。'); this.name = 'UploadRecoveryReceiptError'; }
}
export class UploadRecoveryNeedsFileError extends UserFacingError {
  constructor(public readonly record: UploadRecoveryRecord) { super(`“${record.declaration.filename}”需要重新上传，请选择相同内容的文件后继续。`); this.name = 'UploadRecoveryNeedsFileError'; }
}

function jsonContext(value: unknown, depth = 0, seen = new Set<object>()): value is UploadRecoveryJson {
  if (depth > 20) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  // Ordinary business text may contain URLs. Transport-URL fields and byte/file
  // objects are rejected below; never silently discard original requirements.
  if (typeof value === 'string') return true;
  if ((!Array.isArray(value) && !plain(value)) || seen.has(value as object)) return false;
  if (plain(value) && Reflect.ownKeys(value).some(key => typeof key !== 'string' || !Object.getOwnPropertyDescriptor(value, key)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) return false;
  if (Array.isArray(value) && (Reflect.ownKeys(value).length !== value.length + 1 || Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index))).some(descriptor => !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')))) return false;
  seen.add(value as object);
  const valid = Array.isArray(value) ? value.every(item => jsonContext(item, depth + 1, seen))
    : Object.entries(value as Record<string, unknown>).every(([key, item]) => !/^(?:__proto__|constructor|prototype|upload_?url|download_?url|file|blob|bytes)$/i.test(key) && jsonContext(item, depth + 1, seen));
  seen.delete(value as object); return valid;
}
function declaration(value: unknown): asserts value is Dto<'UploadCreateRequest'> {
  if (!Value.Check(schemas.UploadCreateRequest, value) || value.byte_size > M1_UPLOAD_LIMITS.fileBytes ||
    (['historical', 'reference'].includes(value.role) && !M1_UPLOAD_MIME_TYPES.slice(0, 2).includes(value.media_type as typeof M1_UPLOAD_MIME_TYPES[0]))) throw new UploadRecoveryReceiptError();
}
/** Receipt identity comes from the scoped API call; old upload IDs/names are legal deduplication receipts. */
export function validateUploadMaterial(input: Dto<'UploadCreateRequest'>, value: unknown): Dto<'MaterialResponse'> {
  declaration(input);
  if (!Value.Check(schemas.MaterialResponse, value) || !isDateTime(value.persisted_at) || value.state !== 'persisted' || value.error !== null ||
    value.sha256 !== input.sha256 || value.byte_size !== input.byte_size || value.role !== input.role || value.media_type !== input.media_type) throw new UploadRecoveryReceiptError();
  return clone(value);
}
function browserStore(): UploadRecoveryStorage {
  try { if (globalThis.localStorage) return globalThis.localStorage; } catch { /* fail explicitly below */ }
  throw new UploadRecoveryStorageError();
}
const browserLock: UploadRecoveryLock = {
  async run<T>(name: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const locks = globalThis.navigator?.locks;
    if (!locks) throw new UploadRecoveryLockError();
    return locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) throw new UploadRecoveryLockError(); signal?.throwIfAborted(); return action();
    });
  },
};
const defaultDigest = async (file: File, signal?: AbortSignal) => [...new Uint8Array(await uploadFileDigest(file,signal))].map(byte => byte.toString(16).padStart(2, '0')).join('');

/** Explicit upload recovery only: no discovery, association, draft adoption, task execution or billing. */
export class UploadRecovery {
  private namespace: string;
  private sessions = new Map<string, MemorySession>();
  private deps: UploadRecoveryDependencies;
  constructor(private api: UploadApi, private owner: string, private projectId: string, private purpose: string, private current = () => true, dependencies: UploadRecoveryDependencies = {}) {
    if (![owner, projectId, purpose].every(validId)) throw new UploadRecoveryConflictError();
    this.namespace = prefix + [owner, projectId, purpose].map(encodeURIComponent).join(':') + ':'; this.deps = dependencies;
  }
  private live(signal?: AbortSignal) { signal?.throwIfAborted(); if (!this.current()) throw new DOMException('当前上传页面或账号已变更。', 'AbortError'); }
  private store() { return this.deps.store ?? browserStore(); }
  private nonce() { const id = this.deps.id?.() ?? crypto.randomUUID(); if (!validId(id)) throw new UploadRecoveryConflictError(); return id; }
  private parse(raw: string, key: string): UploadRecoveryRecord {
    try {
      if (raw.length > maxRecordLength) throw new Error();
      const r: unknown = JSON.parse(raw);
      if (!plain(r) || !exactKeys(r, ['version', 'id', 'owner', 'projectId', 'purpose', 'declaration', 'context', 'stage', 'uploadId', 'expiresAt', 'uploadTransport', 'previousUploadIds', 'material', 'lastError']) ||
        r.version !== 1 || !validId(r.id) || r.owner !== this.owner || r.projectId !== this.projectId || r.purpose !== this.purpose ||
        !key.startsWith(this.namespace + encodeURIComponent(r.id) + ':') || !stages.includes(r.stage as UploadRecoveryStage)) throw new Error();
      declaration(r.declaration);
      if (Object.hasOwn(r, 'context') && !jsonContext(r.context)) throw new Error();
      if (r.uploadId !== undefined && !validId(r.uploadId) || r.expiresAt !== undefined && (typeof r.expiresAt !== 'string' || !isDateTime(r.expiresAt))) throw new Error();
      if(r.uploadTransport!==undefined&&r.uploadTransport!==DIRECT_UPLOAD_TRANSPORT)throw new Error();
      if ((r.uploadId === undefined) !== (r.expiresAt === undefined)) throw new Error();
      if (['session', 'bytes_unknown', 'confirming', 'saved'].includes(r.stage as string) && !r.uploadId) throw new Error();
      if (r.previousUploadIds !== undefined && (!Array.isArray(r.previousUploadIds) || !r.previousUploadIds.every(validId) || new Set(r.previousUploadIds).size !== r.previousUploadIds.length || r.uploadId !== undefined && r.previousUploadIds.includes(r.uploadId))) throw new Error();
      if (r.material !== undefined) validateUploadMaterial(r.declaration, r.material);
      if ((r.stage === 'saved') !== (r.material !== undefined)) throw new Error();
      if (r.lastError !== undefined && (!plain(r.lastError) || !exactKeys(r.lastError, ['status', 'code', 'uploadReason', 'correlationId']) ||
        !Number.isInteger(r.lastError.status) || !validId(r.lastError.code) || r.lastError.uploadReason !== undefined && !validId(r.lastError.uploadReason) || r.lastError.correlationId !== undefined && !validId(r.lastError.correlationId))) throw new Error();
      return r as UploadRecoveryRecord;
    } catch { throw new UploadRecoveryStorageError(); }
  }
  private entries(): { key: string; record: UploadRecoveryRecord }[] {
    try {
      const store = this.store(), keys: string[] = [];
      for (let i = 0; i < store.length; i++) { const key = store.key(i); if (key?.startsWith(this.namespace)) keys.push(key); }
      const result = keys.map(key => { const raw = store.getItem(key); if (raw === null) throw new UploadRecoveryConflictError(); return { key, record: this.parse(raw, key) }; });
      if (new Set(result.map(item => item.record.id)).size !== result.length) throw new UploadRecoveryConflictError();
      return result;
    } catch (error) { if (error instanceof UploadRecoveryConflictError || error instanceof UploadRecoveryStorageError) throw error; throw new UploadRecoveryStorageError(); }
  }
  private entry(id: string) { if (!validId(id)) throw new UploadRecoveryConflictError(); const entry = this.entries().find(item => item.record.id === id); if (!entry) throw new UploadRecoveryConflictError(); return entry; }
  private write(key: string, record: UploadRecoveryRecord) {
    this.live();
    try {
      // Project explicitly; session URL/File are never part of a journal write.
      const raw = JSON.stringify(record); if (raw.length > maxRecordLength) throw new Error(); this.parse(raw, key);
      const store = this.store(); store.setItem(key, raw); if (store.getItem(key) !== raw) throw new Error();
    } catch (error) { if (error instanceof UploadRecoveryStorageError) throw new UploadRecoveryStorageError(clone(record)); throw new UploadRecoveryStorageError(clone(record)); }
  }
  private async locked<T>(id: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.live(signal); if (!validId(id)) throw new UploadRecoveryConflictError();
    return (this.deps.lock ?? browserLock).run(this.namespace + encodeURIComponent(id), async () => { this.live(signal); return action(); }, signal);
  }
  list(): UploadRecoveryRecord[] { this.live(); return this.entries().map(entry => clone(entry.record)); }
  begin(input: Dto<'UploadCreateRequest'>, context?: UploadRecoveryJson, id = this.nonce()): UploadRecoveryRecord {
    this.live(); declaration(input); if (!validId(id) || context !== undefined && !jsonContext(context)) throw new UploadRecoveryConflictError();
    const found = this.entries().find(item => item.record.id === id);
    if (found) {
      if (canonical(found.record.declaration) !== canonical(input) || canonical(found.record.context) !== canonical(context)) throw new UploadRecoveryConflictError();
      return clone(found.record);
    }
    const record: UploadRecoveryRecord = { version: 1, id, owner: this.owner, projectId: this.projectId, purpose: this.purpose, declaration: clone(input), stage: 'pending', ...(context === undefined ? {} : { context: clone(context) }) };
    // Separate append-only slots preserve simultaneous begin calls with the same
    // caller ID. Duplicate identities are rejected, never treated as atomic CAS.
    const key = this.namespace + encodeURIComponent(id) + ':' + this.nonce();
    this.write(key, record); this.entry(id); return clone(record);
  }
  async forget(id: string): Promise<void> {
    await this.locked(id, async () => {
      // Another page may already have removed the tracking item after verifying
      // the same business result. Still validate every scoped record before
      // treating absence as successful local cleanup.
      const entry = this.entries().find(item => item.record.id === id); this.live();
      if (entry) {
        try { const store = this.store(); store.removeItem(entry.key); if (store.getItem(entry.key) !== null) throw new Error(); } catch { throw new UploadRecoveryStorageError(entry.record); }
      }
      this.sessions.delete(id);
    });
  }
  async updateContext(id: string, context: UploadRecoveryJson, expected?: {context?: UploadRecoveryJson}): Promise<UploadRecoveryRecord> {
    return this.locked(id, async () => {
      if (!jsonContext(context)) throw new UploadRecoveryConflictError(); const { key, record } = this.entry(id);
      if (expected && canonical(record.context) !== canonical(expected.context)) throw new UploadRecoveryConflictError();
      const next = { ...record, context: clone(context) }; this.write(key, next); return clone(next);
    });
  }
  async resume(id: string, options: UploadRecoveryResumeOptions = {}): Promise<Dto<'MaterialResponse'>> {
    return this.locked(id, async () => {
      if (options.requireDurableRecord && options.previousRecord !== undefined) throw new UploadRecoveryConflictError();
      if (options.previousRecord !== undefined) this.restoreCheckpoint(id, options.previousRecord);
      return this.transfer(id, options);
    }, options.signal);
  }
  private restoreCheckpoint(id: string, snapshot: UploadRecoveryRecord): void {
    // Inspect durable records first. Invalid/duplicate storage must never become
    // permission to overwrite an identity with a caller's stale checkpoint.
    const existing = this.entries().find(entry => entry.record.id === id);
    const key = this.namespace + encodeURIComponent(id) + ':' + this.nonce();
    let record: UploadRecoveryRecord;
    try {
      // Validate the actual object before serializing: File/Blob/URL objects,
      // accessors and hidden transport fields must not disappear into JSON {}.
      if (!jsonContext(snapshot) || !plain(snapshot) || snapshot.id !== id) throw new Error();
      record = this.parse(JSON.stringify(snapshot), key);
    } catch { throw new UploadRecoveryConflictError(); }
    if (existing) {
      if (canonical(existing.record.declaration) !== canonical(record.declaration)) throw new UploadRecoveryConflictError();
      return; // Prefer the current durable session/material/context, never rewind it.
    }
    // A stale pre-create snapshot cannot prove that another tab never uploaded
    // and forgot the operation. Only an original upload identity can be restored.
    if (!record.uploadId) throw new UploadRecoveryConflictError();
    this.write(key, record);
    this.entry(id); // A competing append is an explicit conflict, not fake CAS.
  }
  private async transfer(id: string, options: UploadRecoveryResumeOptions): Promise<Dto<'MaterialResponse'>> {
    const { key, record: initial } = this.entry(id); let record = initial;
    const signal = options.signal ?? new AbortController().signal;
    const live = () => {
      this.live(signal);
      if (options.requireDurableRecord) {
        const durable = this.entry(id);
        if (durable.key !== key || canonical(durable.record) !== canonical(record)) throw new UploadRecoveryConflictError();
      }
    };
    const status = (message: string) => { live(); options.status?.(message); if (options.requireDurableRecord) live(); };
    const save = (change: Partial<UploadRecoveryRecord>) => { live(); const next = { ...record, ...change }; delete next.lastError; this.write(key, next); record = next; };
    const rememberError = (error: ApiError) => {
      live();
      const lastError = { status: error.status, code: error.code, ...(error.details.uploadReason ? { uploadReason: error.details.uploadReason } : {}), ...(error.details.correlationId ? { correlationId: error.details.correlationId } : {}) };
      const next = { ...record, lastError }; this.write(key, next); record = next;
    };
    const accepted = (value: unknown) => {
      live(); const material = validateUploadMaterial(record.declaration, value);
      try { save({ material, stage: 'saved' }); }
      catch (error) {
        // Only a freshly validated server receipt can outlive a journal failure.
        // An older saved checkpoint may instead be recording a failed recheck.
        if (error instanceof UploadRecoveryStorageError) throw new UploadRecoveryStorageError(error.record, material);
        throw error;
      }
      this.sessions.delete(id); return material;
    };
    let selectedFile: File | undefined;
    const verifySelectedFile = async () => {
      if (selectedFile) return selectedFile;
      if (!options.file) throw new UploadRecoveryNeedsFileError(clone(record));
      status('正在核对重新选择的文件内容…');
      const file = options.file, input = record.declaration;
      const ext = file.name.split('.').at(-1)?.toLowerCase();
      const mediaByExtension: Record<string, typeof M1_UPLOAD_MIME_TYPES[number]> = { docx: M1_UPLOAD_MIME_TYPES[0], pdf: M1_UPLOAD_MIME_TYPES[1], xlsx: M1_UPLOAD_MIME_TYPES[2], csv: M1_UPLOAD_MIME_TYPES[3], txt: M1_UPLOAD_MIME_TYPES[4], png: M1_UPLOAD_MIME_TYPES[5], jpg: M1_UPLOAD_MIME_TYPES[6], jpeg: M1_UPLOAD_MIME_TYPES[6], doc: M1_UPLOAD_MIME_TYPES[7] };
      // Match the original declaration, even if File.type is empty or incorrect.
      if (file.size !== input.byte_size || mediaByExtension[ext ?? ''] !== input.media_type) throw new UploadRecoveryConflictError();
      const digest = this.deps.digest ? await this.deps.digest(file) : await defaultDigest(file,signal); live(); if (digest !== input.sha256) throw new UploadRecoveryConflictError();
      return selectedFile = file;
    };
    try {
      if (options.reselectExpiredSession) await verifySelectedFile();
      if (record.material) {
        status('正在确认原材料的准确版本…');
        const material = await this.api.material(this.projectId, record.material.material_id, signal, record.material.material_version); live();
        const checked = validateUploadMaterial(record.declaration, material);
        if (checked.material_id !== record.material.material_id || checked.material_version !== record.material.material_version || checked.upload_id !== record.material.upload_id) throw new UploadRecoveryReceiptError();
        return accepted(checked);
      }
      // A previous create may have replied just before storage failed. Keep that
      // identity in this instance and persist it before any further network work.
      const memory = this.sessions.get(id);
      if (memory && memory.uploadId !== record.uploadId) {
        const previous = [...new Set([...(record.previousUploadIds ?? []), ...(record.uploadId ? [record.uploadId] : [])])];
        save({ uploadId: memory.uploadId, expiresAt: memory.expiresAt, uploadTransport:memory.transport, previousUploadIds: previous, stage: 'session' });
        status('已保留上次上传，正在继续确认…');
      }
      let needsBytes = !record.uploadId;
      if (record.uploadId) {
        if (record.stage === 'bytes_unknown') {
          const previous = new ApiError(record.lastError?.status ?? 0, record.lastError?.code ?? 'DATA_UNAVAILABLE', {
            correlationId: record.lastError?.correlationId,
            ...(isUploadInspectionPublicReason(record.lastError?.uploadReason) ? { uploadReason: record.lastError.uploadReason } : {}),
          });
          if (record.uploadTransport===DIRECT_UPLOAD_TRANSPORT) {
            try{return accepted(await this.api.completeUpload(this.projectId,record.uploadId,{byte_size:record.declaration.byte_size,sha256:record.declaration.sha256},signal));}
            catch(error){live();if(!bytesPending(error))throw error;needsBytes=true;}
          } else {
            // A temporary complete/inspection error after an unknown PUT must
            // not become a permanent rejection of those same uploaded bytes.
            if (previous.status >= 400 && previous.status < 500 && previous.status !== 401 && !temporaryInspectionFailure(previous)) throw previous;
            status('正在确认上次上传的文件是否已保存…');
            if (!options.reselectExpiredSession || !record.expiresAt || Date.parse(record.expiresAt) > (this.deps.now?.() ?? Date.now()))
              return accepted(await this.confirmUnknownPut(record, signal, live, previous));
            // Expiry alone is not evidence that bytes were lost. First authorize
            // and confirm the original upload; accepted bytes/materials still win.
            try {
              const material = await this.api.completeUpload(this.projectId, record.uploadId, { byte_size: record.declaration.byte_size, sha256: record.declaration.sha256 }, signal);
              live(); if (material.upload_id === record.uploadId && material.filename !== record.declaration.filename) throw new UploadRecoveryReceiptError();
              return accepted(material);
            } catch (error) {
              live(); if (!bytesPending(error)) throw error;
              needsBytes = true; this.sessions.delete(id);
            }
          }
        } else {
          save({ stage: 'confirming' }); status('正在确认上次上传的文件是否已保存…');
          try { return accepted(await this.api.completeUpload(this.projectId, record.uploadId, { byte_size: record.declaration.byte_size, sha256: record.declaration.sha256 }, signal)); }
          catch (error) {
            live();
            if (error instanceof ApiError && error.status === 404 && record.uploadTransport!==DIRECT_UPLOAD_TRANSPORT) {
              const project = await this.api.project(this.projectId, signal); live();
              if (!Value.Check(schemas.ProjectResponse, project) || !isDateTime(project.updated_at) || project.project_id !== this.projectId) throw new UploadRecoveryReceiptError(); needsBytes = true;
              this.sessions.delete(id);
            } else if (record.uploadTransport===DIRECT_UPLOAD_TRANSPORT?bytesPending(error):error instanceof ApiError&&error.status===422&&error.code==='MATERIAL_UNREADABLE'&&error.details.uploadReason===undefined) needsBytes=true;
            else throw error;
          }
        }
      }
      if (!needsBytes) throw new UploadRecoveryReceiptError();
      const file = await verifySelectedFile(), input = record.declaration;
      let session = this.sessions.get(id);
      if (!session || session.uploadId !== record.uploadId || Date.parse(session.expiresAt) <= (this.deps.now?.() ?? Date.now())) {
        save({ stage: 'creating' });
        status(record.uploadId ? '正在准备重新上传这份文件…' : '正在准备上传文件…');
        const renewing=!!record.uploadId&&record.uploadTransport===DIRECT_UPLOAD_TRANSPORT;
        if(renewing&&!this.api.refreshUpload)throw new UploadRecoveryReceiptError();
        const created = renewing?await this.api.refreshUpload!(this.projectId,record.uploadId!,{byte_size:input.byte_size,sha256:input.sha256},signal):await this.api.createUpload(this.projectId, clone(input), signal); live();
        if(renewing&&(created.upload_id!==record.uploadId||created.upload_transport!==DIRECT_UPLOAD_TRANSPORT))throw new UploadRecoveryReceiptError();
        if (!Value.Check(schemas.UploadSessionResponse, created) || !isDateTime(created.expires_at) || Date.parse(created.expires_at) <= (this.deps.now?.() ?? Date.now()) || created.max_bytes < input.byte_size || !/^https?:\/\//i.test(created.upload_url) && !created.upload_url.startsWith('/')) throw new UploadRecoveryReceiptError();
        if(created.upload_transport===DIRECT_UPLOAD_TRANSPORT){
          let target:URL;try{target=new URL(created.upload_url);}catch{throw new UploadRecoveryReceiptError();}
          if(target.protocol!=='https:'||target.username||target.password||target.hash)throw new UploadRecoveryReceiptError();
        }
        const previous = [...new Set([...(record.previousUploadIds ?? []), ...(record.uploadId ? [record.uploadId] : [])])];
        if (renewing)previous.splice(previous.indexOf(created.upload_id),1);
        if (previous.includes(created.upload_id)) throw new UploadRecoveryReceiptError();
        session = { uploadId: created.upload_id, url: created.upload_url, expiresAt: created.expires_at, transport:created.upload_transport }; this.sessions.set(id, session);
        save({ uploadId: session.uploadId, expiresAt: session.expiresAt, uploadTransport:session.transport, previousUploadIds: previous, stage: 'session' });
        status('已准备好，开始上传文件…');
      }
      save({ stage: 'bytes_unknown' }); status('正在上传文件…');
      try {
        await this.api.uploadBytes(session.url, file, (loaded, total) => { if (this.current() && !signal.aborted) options.progress?.(loaded, total); }, signal, session.transport); live();
      } catch (error) {
        live(); if(session.transport===DIRECT_UPLOAD_TRANSPORT&&error instanceof ApiError&&[403,409,412].includes(error.status)){
          rememberError(error);
          // A create-only retry may have been rejected because the original PUT succeeded.
          try{return accepted(await this.api.completeUpload(this.projectId,record.uploadId!,{byte_size:input.byte_size,sha256:input.sha256},signal));}
          catch(completion){live();if(!bytesPending(completion))throw completion;throw error;}
        }
        if (!uncertainPut(error)) throw error;
        rememberError(error); status('正在确认上次上传的文件是否已保存…');
        return accepted(await this.confirmUnknownPut(record, signal, live, error));
      }
      // Tiny successful PUTs need not emit an XHR progress event. Its accepted
      // receipt proves the declared bytes arrived, while material saving remains
      // unconfirmed until the separate complete receipt is checked and stored.
      options.progress?.(input.byte_size, input.byte_size);
      save({ stage: 'confirming' }); status('正在确认材料保存…');
      return accepted(await this.api.completeUpload(this.projectId, record.uploadId!, { byte_size: input.byte_size, sha256: input.sha256 }, signal));
    } catch (error) {
      live();
      if (error instanceof ApiError) rememberError(error);
      throw error;
    }
  }
  private async confirmUnknownPut(record: UploadRecoveryRecord, signal: AbortSignal, live: () => void, putError: ApiError): Promise<Dto<'MaterialResponse'>> {
    // One budget covers waiting for bytes and complete's existing 202/200 polling.
    // Expiry keeps the original uncertain PUT error and identity recoverable.
    const deadline = new AbortController(), waiting = AbortSignal.any([signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(putError), 600_000);
    try {
      for (;;) {
        live(); waiting.throwIfAborted();
        try {
          const material = await this.api.completeUpload(this.projectId, record.uploadId!, { byte_size: record.declaration.byte_size, sha256: record.declaration.sha256 }, waiting);
          live(); waiting.throwIfAborted();
          // Reuse can legitimately name an older canonical upload. A receipt for
          // this upload itself must retain its original filename.
          if (material.upload_id === record.uploadId && material.filename !== record.declaration.filename) throw new UploadRecoveryReceiptError();
          return material;
        } catch (error) {
          live(); waiting.throwIfAborted();
          // Only this existing response means bytes have not arrived yet. All
          // inspection, ownership, declaration and receipt failures remain errors.
          if (!bytesPending(error)) throw error;
        }
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(delay); waiting.removeEventListener('abort', abort); reject(waiting.reason); };
          const delay = setTimeout(() => { waiting.removeEventListener('abort', abort); resolve(); }, 2000);
          waiting.addEventListener('abort', abort, { once: true }); if (waiting.aborted) abort();
        });
      }
    } finally { clearTimeout(timer); }
  }
}
