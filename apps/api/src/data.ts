import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { Pool, type PoolClient } from 'pg';
import { BlobServiceClient, type BlobItem } from '@azure/storage-blob';
import { isMarketOffering, emptyUpdateDetails, isUploadInspectionPublicReason, type Market, type Offering, type M4InputIssue } from '@bondbuddy/contracts';
import { inspectMaterialUpload, inspectMaterialUploadFile, inspectMaterialUploadFileDetailed } from './original-material-upload.js';
import { UploadSafetyError, type UploadInspectionResult, type UploadRejectionReason, type UploadStructureDetail } from './upload-safety.js';

export const uid = () => randomUUID();
export const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const canonical = (value: unknown): string => JSON.stringify(value);
// Longer than any contract-valid key, so the encoded namespace cannot alias a legacy raw key.
const encodedExecutionKeyPrefix=`${'~'.repeat(129)}v2:`;
// Outside the public 128-character key space. A controlled automatic test run
// retains the browser key in its DTO without claiming the production DB key.
const autoTestExecutionKeyPrefix=`${'~'.repeat(129)}auto-test:`;
export const autoTestExecutionKeyStorage=(value:string):string=>{
  if(!/^web-update-[a-f0-9]{64}$/.test(value))throw new Error('Invalid browser update key');
  return autoTestExecutionKeyPrefix+value;
};
export const isAutoTestExecutionKeyStorage=(value:string):boolean=>
  value.startsWith(autoTestExecutionKeyPrefix)&&/^web-update-[a-f0-9]{64}$/.test(value.slice(autoTestExecutionKeyPrefix.length));
export const executionKeyStorage=(value:string):string=>
  value.includes('\0')||Buffer.from(value,'utf8').toString('utf8')!==value
    ? encodedExecutionKeyPrefix+Buffer.from(value,'utf16le').toString('hex')
    : value;
export const executionKeyFromStorage=(value:string):string=>{
  if(isAutoTestExecutionKeyStorage(value))return value.slice(autoTestExecutionKeyPrefix.length);
  if(!value.startsWith(encodedExecutionKeyPrefix))return value;
  const hex=value.slice(encodedExecutionKeyPrefix.length);
  return hex.length>0&&hex.length%4===0&&/^[a-f0-9]+$/.test(hex)
    ? Buffer.from(hex,'hex').toString('utf16le') : value;
};
export class Problem extends Error {
  inputIssues?: M4InputIssue[];
  constructor(public status: number, public code: string, message: string, public readonly uploadReason?: UploadRejectionReason, public readonly uploadDetail?: UploadStructureDetail) { super(message); }
}
export function publicProblem(error: Problem, correlationId: string) {
  const inspection = error.uploadReason && (error.code === 'MATERIAL_UNREADABLE' || error.code === 'DATA_UNAVAILABLE')
    ? isUploadInspectionPublicReason(error.uploadDetail) ? error.uploadDetail
      : isUploadInspectionPublicReason(error.uploadReason) ? error.uploadReason : 'structure_invalid'
    : undefined;
  return {
    code: error.code, message: inspection ? 'Material inspection was not completed' : error.message,
    retryable: error.status === 503 || inspection === 'inspection_queue_timeout' ||
      inspection === 'inspection_timeout' || inspection === 'inspection_worker_failed',
    field_errors: inspection ? [{ field: 'material_upload', code: inspection, message: 'File inspection was not completed' }] : error.code === 'INPUT_REQUIRED' ? error.inputIssues ?? [] : [],
    correlation_id: correlationId,
  };
}
export const missing = () => new Problem(404, 'NOT_FOUND', 'Resource does not exist');
export const conflict = (code: string, message: string) => new Problem(409, code, message);
export const unavailable = () => new Problem(501, 'CAPABILITY_NOT_READY', 'Capability is not connected');
export async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export const date = (value: Date | string) => new Date(value).toISOString();
export const projectDto = (p: any) => ({ project_id: p.id, draft_revision: p.draft_revision, input_revision: p.latest_input_revision, input_hash: p.input_hash ?? null, name: p.name, kind: p.kind, issuer_name: p.issuer_name, market: p.market, offering: p.offering, update_details: { ...emptyUpdateDetails(), ...p.update_details }, updated_at: date(p.updated_at), archived_at: p.archived_at ? date(p.archived_at) : null });
export const materialDto = (m: any) => ({ material_id: m.id, material_version: m.version, upload_id: m.upload_id, role: m.role, filename: m.filename, media_type: m.media_type, byte_size: Number(m.byte_size), sha256: m.sha256.trim(), state: m.state, persisted_at: date(m.persisted_at), error: m.error, signature_assessment: m.signature_assessment ?? null, parse_snapshot_id: typeof m.parse_snapshot_id === 'string' && m.parse_snapshot_id.length > 0 ? m.parse_snapshot_id : null });
const inputCreditSupplementRefs = (manifest: unknown) => {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !Object.hasOwn(manifest, 'credit_facility_supplements')) return undefined;
  const pins = (manifest as Record<string, unknown>).credit_facility_supplements;
  if (!Array.isArray(pins) || pins.length > 60) throw new Problem(503, 'DATA_UNAVAILABLE', 'Stored input supplement references are invalid');
  const seen = new Set<string>();
  return pins.map(pin => {
    if (!pin || typeof pin !== 'object' || Array.isArray(pin)) throw new Problem(503, 'DATA_UNAVAILABLE', 'Stored input supplement references are invalid');
    const value = pin as Record<string, unknown>;
    if (typeof value.supplement_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.supplement_id) ||
        !Number.isSafeInteger(value.version) || Number(value.version) < 1 || typeof value.request_hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.request_hash))
      throw new Problem(503, 'DATA_UNAVAILABLE', 'Stored input supplement references are invalid');
    if (!['user_asserted', 'needs_confirmation', 'conflicted'].includes(String(value.status)) || value.eligible_for_manuscript !== false)
      throw new Problem(503, 'DATA_UNAVAILABLE', 'Stored input supplement status is invalid');
    const key = value.supplement_id;
    if (seen.has(key)) throw new Problem(503, 'DATA_UNAVAILABLE', 'Stored input supplement references are duplicated');
    seen.add(key);
    return { supplement_id: value.supplement_id, version: value.version, request_hash: value.request_hash };
  });
};
export const inputDto = (i: any) => {
  const pins = inputCreditSupplementRefs(i.manifest);
  return { project_id: i.project_id, input_revision: i.revision, input_hash: i.input_hash.trim(), target_confirmation: i.manifest?.target_confirmation ?? {status:'unconfirmed',market:null,offering:null,document_purpose:null,as_of:null,target_reporting_periods:[],confirmed_by:null,confirmed_at:null}, material_versions: i.material_versions,
    ...(pins?.length ? { credit_facility_supplements: pins } : {}), rule_pack_version: i.rule_pack_version, template_version: i.template_version,
    reference_release: i.reference_release, created_at: date(i.created_at) };
};
export const runDto = (r: any) => ({ run_id: r.id, execution_request_id: executionKeyFromStorage(r.execution_request_id), project_id: r.project_id, input_revision: r.input_revision, input_hash: r.input_hash.trim(), channel: r.channel ?? 'production', test_grant_id: r.test_grant_id ?? null, uncovered_items: r.uncovered_items ?? [], state: r.state, stage: r.stage, event_cursor: r.event_cursor, billing_mode: r.channel==='non_production_test'?'non_billable_test':r.billing_mode ?? 'platform_trial', reservation_id: r.reservation_id ?? null, artifact_id: r.artifact_id, prompt_snapshot_ref: r.prompt_snapshot_ref, updated_at: date(r.updated_at) });
export async function project(pool: Pool | PoolClient, owner: string, id: string, lock = false) {
  const result = await pool.query(`SELECT p.*,i.input_hash FROM bb_projects p LEFT JOIN bb_input_revisions i ON i.project_id=p.id AND i.revision=p.latest_input_revision WHERE p.owner_user_id=$1 AND p.id=$2 AND p.deleted_at IS NULL ${lock ? 'FOR UPDATE OF p' : ''}`, [owner,id]);
  if (!result.rows[0]) throw missing();
  return result.rows[0];
}
/** Caller holds the target project lock; DB run trigger remains the final race guard. */
export async function assertCanonicalBusinessRunIdle(client:PoolClient,owner:string,p:{id:string;kind:string;execution_scope_project_id?:string|null}){
  const scope=p.execution_scope_project_id||p.id;
  if(!p.execution_scope_project_id&&p.kind!=='review'&&!(await client.query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND execution_scope_project_id=$2 LIMIT 1',[owner,scope])).rowCount)return;
  try{const canonicalProject=(await client.query('SELECT id FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE NOWAIT',[owner,scope])).rows[0];if(!canonicalProject)throw missing();}
  catch(error){if((error as {code?:string}).code==='55P03')throw conflict('INPUT_REVISION_CONFLICT','同一来源项目正在提交任务，请稍后重试。');throw error;}
  if((await client.query(`SELECT 1 FROM bb_runs r JOIN bb_projects related ON related.owner_user_id=r.owner_user_id AND related.id=r.project_id
    WHERE r.owner_user_id=$1 AND COALESCE(related.execution_scope_project_id,related.id)=$2 AND r.task_kind<>'qa'
    AND r.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected') LIMIT 1`,[owner,scope])).rowCount)
    throw conflict('PROJECT_RUN_ACTIVE','同一来源项目已有业务任务执行中，请等待完成或停止任务后执行。');
}
export async function run(pool: Pool | PoolClient, owner: string, id: string, lock = false) {
  // Runs of a deleted project are owner-safe 404, like the project itself.
  const result = await pool.query(`SELECT r.* FROM bb_runs r JOIN bb_projects p ON p.owner_user_id=r.owner_user_id AND p.id=r.project_id
    WHERE r.owner_user_id=$1 AND r.id=$2 AND p.deleted_at IS NULL ${lock ? 'FOR UPDATE OF r' : ''}`, [owner,id]);
  if (!result.rows[0]) throw missing();
  return result.rows[0];
}
export async function material(pool: Pool | PoolClient, owner: string, projectId: string, id: string) {
  const result = await pool.query(`SELECT m.*,(SELECT s.id FROM bb_parse_snapshots s
      WHERE s.owner_user_id=m.owner_user_id AND s.project_id=m.project_id AND s.material_id=m.id AND s.material_version=m.version
        AND s.response_status <> 'failed'
        AND NOT EXISTS(SELECT 1 FROM bb_parse_snapshots newer WHERE newer.owner_user_id=s.owner_user_id AND newer.project_id=s.project_id
          AND newer.material_id=s.material_id AND newer.material_version=s.material_version AND (newer.created_at,newer.id)>(s.created_at,s.id))
      LIMIT 1) AS parse_snapshot_id
    FROM bb_material_versions m WHERE m.owner_user_id=$1 AND m.project_id=$2 AND m.id=$3 AND m.deleted_at IS NULL ORDER BY m.version DESC LIMIT 1`, [owner,projectId,id]);
  if (!result.rows[0]) throw missing();
  return result.rows[0];
}
export interface PrivateBlobs {
  put(key: string, bytes: Buffer, mediaType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  getIfExists(key: string): Promise<Buffer | null>;
  getIfExistsBounded(key: string, maxBytes: number): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  deleteIfMatch?(key: string, etag: string): Promise<boolean>;
  /** One bounded listing page; continuation is opaque and must never be logged. */
  listPage?(prefix: string, continuation: string | undefined, pageSize: number): Promise<{ items: { key: string; bytes: number; lastModified?: Date; etag: string }[]; continuation?: string }>;
  /** Streaming variants for large objects (Azure/Azurite). In-memory test doubles may omit them. */
  putFile?(key: string, path: string, mediaType: string): Promise<void>;
  /** Streams the object, hashing it and (with `path`) writing it to a file; null when absent. */
  readToFile?(key: string, path: string | null, maxBytes: number): Promise<BlobDigest | null>;
  /** Opens the object as a stream (with its stored length); null when absent. */
  openRead?(key: string): Promise<{ body: Readable; contentLength: number | undefined } | null>;
}
export type BlobDigest = { byteSize: number; sha256: string };
const BLOB_BLOCK_BYTES = 4 * 1024 * 1024;
const notFound = (error: unknown) => Boolean(error && typeof error === 'object' && ('statusCode' in error && error.statusCode === 404 || 'code' in error && error.code === 'BlobNotFound'));
async function hashStream(body: Readable, path: string | null, maxBytes: number, expected?: number): Promise<BlobDigest> {
  const hash = createHash('sha256');
  const out = path ? createWriteStream(path, { flags: 'wx', mode: 0o600 }) : null;
  let byteSize = 0;
  try {
    for await (const chunk of body) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteSize += value.length;
      if (byteSize > maxBytes) throw new Problem(413,'DATA_UNAVAILABLE','Stored object exceeds the bounded read limit');
      hash.update(value);
      if (out && !out.write(value)) await new Promise<void>(resolve => out.once('drain', () => resolve()));
    }
    if (out) await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => error ? reject(error) : resolve()));
  } catch (error) {
    body.destroy();
    if (out) { out.destroy(); await rm(path!, { force: true }).catch(() => undefined); }
    throw error;
  }
  if (expected !== undefined && byteSize !== expected) {
    if (path) await rm(path, { force: true }).catch(() => undefined);
    throw new Problem(503,'DATA_UNAVAILABLE','Stored object size changed during bounded read');
  }
  return { byteSize, sha256: hash.digest('hex') };
}
/** Stage a spooled file to private Blob without loading it into memory. */
export async function putBlobFile(blobs: PrivateBlobs, key: string, path: string, mediaType: string): Promise<void> {
  if (blobs.putFile) return blobs.putFile(key, path, mediaType);
  await blobs.put(key, await readFile(path), mediaType);
}
/** Hash a stored object (and optionally copy it to `path`) without holding it in memory. */
export async function readBlobToFile(blobs: PrivateBlobs, key: string, path: string | null, maxBytes: number): Promise<BlobDigest | null> {
  if (blobs.readToFile) return blobs.readToFile(key, path, maxBytes);
  const bytes = await blobs.getIfExistsBounded(key, maxBytes);
  if (bytes === null) return null;
  if (path) await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  return { byteSize: bytes.length, sha256: digest(bytes) };
}
export function azureBlobs(connectionString: string, containerName = 'bondbuddy-private'): PrivateBlobs {
  const container = BlobServiceClient.fromConnectionString(connectionString).getContainerClient(containerName);
  let ready: Promise<unknown> | undefined;
  const ensure = () => ready ??= container.createIfNotExists();
  const read = async (key: string) => {
    const response = await container.getBlockBlobClient(key).download();
    const chunks: Buffer[] = [];
    if (response.readableStreamBody) for await (const chunk of response.readableStreamBody) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  };
  return {
    async put(key, bytes, mediaType) { await ensure(); await container.getBlockBlobClient(key).uploadData(bytes,{ blobHTTPHeaders: { blobContentType: mediaType } }); },
    async get(key) { await ensure(); return read(key); },
    async getIfExists(key) {
      await ensure();
      try { return await read(key); }
      catch (error) {
        if (error && typeof error === 'object' && ('statusCode' in error && error.statusCode === 404 || 'code' in error && error.code === 'BlobNotFound')) return null;
        throw error;
      }
    },
    async getIfExistsBounded(key, maxBytes) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Problem(422,'VALIDATION_FAILED','Invalid Blob read limit');
      await ensure();
      const blob = container.getBlockBlobClient(key);
      try {
        const properties = await blob.getProperties();
        if (properties.contentLength !== undefined && properties.contentLength > maxBytes) throw new Problem(413,'DATA_UNAVAILABLE','Stored object exceeds the bounded read limit');
        const response = await blob.download();
        const chunks: Buffer[] = [];
        let total = 0;
        if (response.readableStreamBody) for await (const chunk of response.readableStreamBody) {
          const value = Buffer.from(chunk);
          total += value.length;
          if (total > maxBytes) throw new Problem(413,'DATA_UNAVAILABLE','Stored object exceeds the bounded read limit');
          chunks.push(value);
        }
        if (properties.contentLength !== undefined && total !== properties.contentLength) throw new Problem(503,'DATA_UNAVAILABLE','Stored object size changed during bounded read');
        return Buffer.concat(chunks,total);
      } catch (error) {
        if (error instanceof Problem) throw error;
        if (error && typeof error === 'object' && ('statusCode' in error && error.statusCode === 404 || 'code' in error && error.code === 'BlobNotFound')) return null;
        throw error;
      }
    },
    async exists(key) {
      await ensure();
      try { await container.getBlockBlobClient(key).getProperties(); return true; }
      catch (error) {
        if (error && typeof error === 'object' && ('statusCode' in error && error.statusCode === 404 || 'code' in error && error.code === 'BlobNotFound')) return false;
        throw error;
      }
    },
    async delete(key) { await ensure(); await container.getBlockBlobClient(key).deleteIfExists(); },
    async deleteIfMatch(key, etag) { return (await container.getBlockBlobClient(key).deleteIfExists({ conditions: { ifMatch: etag } })).succeeded; },
    async listPage(prefix, continuation, pageSize) {
      const page = await container.listBlobsFlat({ prefix }).byPage({ continuationToken: continuation, maxPageSize: pageSize }).next();
      return { items: (page.value?.segment.blobItems ?? []).map((item: BlobItem) => ({ key: item.name, bytes: item.properties.contentLength ?? 0, lastModified: item.properties.lastModified, etag: item.properties.etag ?? '' })), continuation: page.value?.continuationToken || undefined };
    },
    async putFile(key, path, mediaType) {
      await ensure();
      // Always stage blocks (the SDK would otherwise send objects up to 256 MiB in one buffered request),
      // so at most blockSize x concurrency bytes are in memory at a time.
      await container.getBlockBlobClient(key).uploadFile(path, { blockSize: BLOB_BLOCK_BYTES, maxSingleShotSize: BLOB_BLOCK_BYTES, concurrency: 2, blobHTTPHeaders: { blobContentType: mediaType } });
    },
    async openRead(key) {
      await ensure();
      try {
        const response = await container.getBlockBlobClient(key).download();
        if (!response.readableStreamBody) throw new Problem(503,'DATA_UNAVAILABLE','Stored object has no body');
        return { body: response.readableStreamBody as Readable, contentLength: response.contentLength };
      } catch (error) {
        if (error instanceof Problem) throw error;
        if (notFound(error)) return null;
        throw error;
      }
    },
    async readToFile(key, path, maxBytes) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Problem(422,'VALIDATION_FAILED','Invalid Blob read limit');
      await ensure();
      try {
        const response = await container.getBlockBlobClient(key).download();
        if (response.contentLength !== undefined && response.contentLength > maxBytes) { (response.readableStreamBody as Readable | undefined)?.destroy(); throw new Problem(413,'DATA_UNAVAILABLE','Stored object exceeds the bounded read limit'); }
        if (!response.readableStreamBody) throw new Problem(503,'DATA_UNAVAILABLE','Stored object has no body');
        return await hashStream(response.readableStreamBody as Readable, path, maxBytes, response.contentLength);
      } catch (error) {
        if (error instanceof Problem) throw error;
        if (notFound(error)) return null;
        throw error;
      }
    }
  };
}
export async function verifiedMedia(bytes: Buffer, declared: string): Promise<string> {
  try {
    return await inspectMaterialUpload(bytes, declared);
  } catch (error) {
    if (error instanceof UploadSafetyError) {
      throw new Problem(error.status, error.code, error.message, error.reason, error.detail);
    }
    throw new Problem(422,'MATERIAL_UNREADABLE','Material could not be safely inspected','inspection_worker_failed');
  }
}
/** Validate the upload declaration and stored size without reading document content. */
export async function verifiedMediaFile(path: string, byteSize: number, declared: string): Promise<string> {
  try {
    return await inspectMaterialUploadFile(path, byteSize, declared);
  } catch (error) {
    if (error instanceof UploadSafetyError) {
      throw new Problem(error.status, error.code, error.message, error.reason, error.detail);
    }
    throw new Problem(422,'MATERIAL_UNREADABLE','Material could not be safely inspected','inspection_worker_failed');
  }
}
export async function verifiedMediaFileDetailed(path: string, byteSize: number, declared: string): Promise<UploadInspectionResult> {
  try {
    return await inspectMaterialUploadFileDetailed(path, byteSize, declared);
  } catch (error) {
    if (error instanceof UploadSafetyError) throw new Problem(error.status, error.code, error.message, error.reason, error.detail);
    throw new Problem(422,'MATERIAL_UNREADABLE','Material could not be safely inspected','inspection_worker_failed');
  }
}
export function checkedPair(market: Market | null, offering: Offering | null) {
  if (market && offering && !isMarketOffering(market,offering)) throw new Problem(422,'VALIDATION_FAILED','Market and offering do not match');
  if (!market && offering) throw new Problem(422,'VALIDATION_FAILED','Market is required for an offering');
}
