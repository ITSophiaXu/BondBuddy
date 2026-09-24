import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import { isMarketOffering, emptyUpdateDetails, type Market, type Offering } from '@bondbuddy/contracts';
import { inspectMaterialUpload } from './upload-safety.js';

export const uid = () => randomUUID();
export const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const canonical = (value: unknown): string => JSON.stringify(value);
export class Problem extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
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
export const projectDto = (p: any) => ({ project_id: p.id, draft_revision: p.draft_revision, input_revision: p.latest_input_revision, input_hash: p.input_hash ?? null, name: p.name, kind: p.kind, issuer_name: p.issuer_name, market: p.market, offering: p.offering, update_details: { ...emptyUpdateDetails(), ...p.update_details }, updated_at: date(p.updated_at) });
export const materialDto = (m: any) => ({ material_id: m.id, material_version: m.version, upload_id: m.upload_id, role: m.role, filename: m.filename, media_type: m.media_type, byte_size: Number(m.byte_size), sha256: m.sha256.trim(), state: m.state, persisted_at: date(m.persisted_at), error: m.error });
export const inputDto = (i: any) => ({ project_id: i.project_id, input_revision: i.revision, input_hash: i.input_hash.trim(), material_versions: i.material_versions, rule_pack_version: i.rule_pack_version, template_version: i.template_version, reference_release: i.reference_release, created_at: date(i.created_at) });
export const runDto = (r: any) => ({ run_id: r.id, execution_request_id: r.execution_request_id, project_id: r.project_id, input_revision: r.input_revision, input_hash: r.input_hash.trim(), state: r.state, stage: r.stage, event_cursor: r.event_cursor, billing_mode: 'platform_trial', reservation_id: null, artifact_id: r.artifact_id, prompt_snapshot_ref: r.prompt_snapshot_ref, updated_at: date(r.updated_at) });
export async function project(pool: Pool | PoolClient, owner: string, id: string, lock = false) {
  const result = await pool.query(`SELECT p.*,i.input_hash FROM bb_projects p LEFT JOIN bb_input_revisions i ON i.project_id=p.id AND i.revision=p.latest_input_revision WHERE p.owner_user_id=$1 AND p.id=$2 AND p.deleted_at IS NULL ${lock ? 'FOR UPDATE OF p' : ''}`, [owner,id]);
  if (!result.rows[0]) throw missing();
  return result.rows[0];
}
export async function run(pool: Pool | PoolClient, owner: string, id: string, lock = false) {
  const result = await pool.query(`SELECT * FROM bb_runs WHERE owner_user_id=$1 AND id=$2 ${lock ? 'FOR UPDATE' : ''}`, [owner,id]);
  if (!result.rows[0]) throw missing();
  return result.rows[0];
}
export async function material(pool: Pool | PoolClient, owner: string, projectId: string, id: string) {
  const result = await pool.query('SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND deleted_at IS NULL ORDER BY version DESC LIMIT 1', [owner,projectId,id]);
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
    async delete(key) { await ensure(); await container.getBlockBlobClient(key).deleteIfExists(); }
  };
}
export async function verifiedMedia(bytes: Buffer, declared: string): Promise<string> {
  try {
    return await inspectMaterialUpload(bytes, declared);
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && 'code' in error && error instanceof Error) {
      throw new Problem(error.status as number, String(error.code), error.message);
    }
    throw new Problem(422,'MATERIAL_UNREADABLE','Material could not be safely inspected');
  }
}
export function checkedPair(market: Market | null, offering: Offering | null) {
  if (market && offering && !isMarketOffering(market,offering)) throw new Problem(422,'VALIDATION_FAILED','Market and offering do not match');
  if (!market && offering) throw new Problem(422,'VALIDATION_FAILED','Market is required for an offering');
}
