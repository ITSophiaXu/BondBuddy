import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { azureBlobs, uid, type PrivateBlobs } from './data.js';
import { raiseAlert } from './evidence-gate.js';

export const INVENTORY_PREFIXES = ['users/', 'parse-cache/', 'log-archive/'] as const;
export type InventoryKind = 'snapshot' | 'upload' | 'provider_result' | 'ocr_result' | 'ocr_page' | 'artifact' | 'parse_cache' | 'log_archive' | 'unrecognized';
export type InventoryClass = 'referenced' | 'intent_pending' | 'orphan_candidate' | 'unrecognized';
type Item = { key: string; bytes: number; lastModified: Date; etag: string };
type Db = Pool | PoolClient;
const digest = (key: string) => createHash('sha256').update(key).digest('hex');
const id = '[A-Za-z0-9_-]{1,128}';
const hex = '[a-f0-9]{64}';
const uuid = '[a-f0-9-]{36}';
const patterns: [InventoryKind, RegExp][] = [
  ['snapshot', new RegExp(`^users/${id}/projects/${id}/snapshots/${id}$`)],
  ['upload', new RegExp(`^users/${id}/projects/${id}/uploads/${id}$`)],
  ['provider_result', new RegExp(`^users/${id}/projects/${id}/provider-results/${id}-${hex}\\.json$`)],
  ['ocr_result', new RegExp(`^users/${id}/projects/${id}/ocr/results/${hex}\\.json$`)],
  ['ocr_page', new RegExp(`^users/${id}/projects/${id}/ocr/${id}/[1-9][0-9]*/${hex}\\.png$`)],
  ['artifact', new RegExp(`^users/${id}/runs/${id}/artifacts/${id}/v[1-9][0-9]*\\.docx$`)],
  ['parse_cache', new RegExp(`^parse-cache/${hex}/${uuid}$`)],
  ['log_archive', new RegExp(`^log-archive/[a-z][a-z0-9_]{0,63}/${uuid}(\\.${hex})?\\.ndjson$`)]
];
export function parseInventoryKey(key: string): InventoryKind {
  return patterns.find(([, pattern]) => pattern.test(key))?.[0] ?? 'unrecognized';
}

async function classify(db: Db, kind: InventoryKind, key: string): Promise<InventoryClass> {
  if (kind === 'unrecognized') return 'unrecognized';
  const sql: Record<Exclude<InventoryKind,'unrecognized'>, string> = {
    snapshot: `SELECT 1 FROM bb_snapshot_refs s WHERE s.object_key=$1 AND NOT EXISTS
      (SELECT 1 FROM bb_log_content_tombstones t WHERE t.content_kind='prompt_snapshot' AND t.content_id=s.id)`,
    upload: 'SELECT 1 FROM bb_uploads WHERE object_key=$1 UNION ALL SELECT 1 FROM bb_material_versions WHERE object_key=$1',
    provider_result: `SELECT 1 FROM bb_provider_result_refs r WHERE r.result_ref=$1 AND NOT EXISTS
      (SELECT 1 FROM bb_log_content_tombstones t WHERE t.content_kind='provider_result' AND t.content_id=r.id)`,
    ocr_result: 'SELECT 1 FROM bb_ocr_snapshots WHERE result_key=$1',
    // Page keys are embedded in the result Blob. A matching snapshot for the
    // material/version conservatively pins all pages in that scope.
    ocr_page: `SELECT 1 FROM bb_ocr_snapshots WHERE owner_user_id=split_part($1,'/',2)
      AND project_id=split_part($1,'/',4) AND material_id=split_part($1,'/',6)
      AND material_version=split_part($1,'/',7)::integer`,
    artifact: 'SELECT 1 FROM bb_artifact_versions WHERE object_key=$1',
    parse_cache: 'SELECT 1 FROM bb_parse_cache WHERE object_key=$1',
    log_archive: `SELECT 1 FROM bb_log_archive_receipts r LEFT JOIN bb_log_archive_lifecycle l ON l.segment_id=r.segment_id
      WHERE r.object_key=$1 AND l.segment_id IS NULL
      UNION ALL SELECT 1 FROM bb_log_archive_lifecycle WHERE deleted_at IS NULL AND (object_key=$1 OR pending_old_key=$1)`
  };
  if ((await db.query(sql[kind], [key])).rowCount) return 'referenced';
  if (kind === 'snapshot' && (await db.query('SELECT 1 FROM bb_prompt_blob_intents WHERE object_key=$1 AND registered_at IS NULL AND cleared_at IS NULL', [key])).rowCount)
    return 'intent_pending';
  return 'orphan_candidate';
}

export type InventoryPolicy = { deleteEnabled?: boolean; graceHours?: number; pageSize?: number; maxPages?: number; maxDeletes?: number; sampleLimit?: number; now?: () => Date; beforeDelete?: (key: string) => Promise<void> };
export function inventoryPolicyFromEnv(env = process.env): InventoryPolicy {
  if (env.BB_STORAGE_INVENTORY_DELETE !== undefined && !['true','false'].includes(env.BB_STORAGE_INVENTORY_DELETE)) throw new Error('BB_STORAGE_INVENTORY_DELETE must be true or false');
  const number = (name: string, fallback: number, max: number) => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) > max) throw new Error(`Invalid ${name}`);
    return Number(raw);
  };
  return { deleteEnabled: env.BB_STORAGE_INVENTORY_DELETE === 'true',
    graceHours: Math.max(24, number('BB_STORAGE_ORPHAN_GRACE_HOURS', 24, 87600)),
    pageSize: number('BB_STORAGE_INVENTORY_PAGE_SIZE', 100, 500),
    maxPages: number('BB_STORAGE_INVENTORY_MAX_PAGES', 3, 20),
    maxDeletes: number('BB_STORAGE_INVENTORY_MAX_DELETES', 20, 100),
    sampleLimit: number('BB_STORAGE_INVENTORY_SAMPLE_LIMIT', 5, 20) };
}

type Bucket = { count: number; bytes: number; oldest: string | null };
export type InventoryReport = { scanned: number; byPrefix: Record<string, Record<InventoryClass, Bucket>>; byKind: Record<string, Record<InventoryClass, Bucket>>;
  candidateKeyHashes: string[]; deleted: number; deleteSkipped: number; continuation: Record<string, boolean> };
const classes: InventoryClass[] = ['referenced','intent_pending','orphan_candidate','unrecognized'];
const empty = () => Object.fromEntries(classes.map(c => [c,{ count: 0, bytes: 0, oldest: null }])) as Record<InventoryClass,Bucket>;
function record(bucket: Bucket, item: Item) {
  bucket.count++; bucket.bytes += item.bytes;
  const stamp = item.lastModified.toISOString();
  if (!bucket.oldest || stamp < bucket.oldest) bucket.oldest = stamp;
}

/** One bounded, resumable sweep. The default is read-only; deletion is limited to pre-intent snapshots. */
export async function runStorageInventory(pool: Pool, blobs: PrivateBlobs, policy: InventoryPolicy = {}): Promise<InventoryReport> {
  if (!blobs.listPage) throw new Error('Private Blob listing is unavailable');
  const pageSize = policy.pageSize ?? 100, maxPages = policy.maxPages ?? 3, maxDeletes = policy.maxDeletes ?? 20;
  const sampleLimit = policy.sampleLimit ?? 5, graceHours = policy.graceHours ?? 24;
  if (![pageSize,maxPages,maxDeletes,sampleLimit].every(n => Number.isSafeInteger(n) && n >= 1) || pageSize > 500 || maxPages > 20 || maxDeletes > 100 || sampleLimit > 20 || !Number.isSafeInteger(graceHours) || graceHours < 24)
    throw new Error('Invalid inventory bounds');
  if (policy.deleteEnabled && !blobs.deleteIfMatch) throw new Error('Conditional Blob delete required');
  const now = policy.now?.() ?? new Date();
  const report: InventoryReport = { scanned: 0, byPrefix: {}, byKind: {}, candidateKeyHashes: [], deleted: 0, deleteSkipped: 0, continuation: {} };
  let deleteAttempted = 0;
  for (const prefix of INVENTORY_PREFIXES) {
    report.byPrefix[prefix] = empty();
    let cursor: string | undefined = (await pool.query('SELECT continuation FROM bb_storage_inventory_cursors WHERE prefix=$1', [prefix])).rows[0]?.continuation ?? undefined;
    for (let pageNo = 0; pageNo < maxPages; pageNo++) {
      const page = await blobs.listPage(prefix, cursor, pageSize);
      if (page.items.length > pageSize) throw new Error('Blob listing exceeded page bound');
      for (const item of page.items) {
        if (!item.key.startsWith(prefix) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || Number.isNaN(item.lastModified.getTime())) throw new Error('Invalid Blob listing item');
        const kind = parseInventoryKey(item.key), category = await classify(pool, kind, item.key);
        report.byKind[kind] ??= empty();
        record(report.byPrefix[prefix][category], item); record(report.byKind[kind][category], item);
        report.scanned++;
        if (category === 'orphan_candidate') {
          if (report.candidateKeyHashes.length < sampleLimit) report.candidateKeyHashes.push(digest(item.key));
          if (policy.deleteEnabled && deleteAttempted < maxDeletes && kind === 'snapshot' && item.lastModified.getTime() <= now.getTime() - graceHours * 3600000 && item.etag) {
            deleteAttempted++;
            await policy.beforeDelete?.(item.key);
            await pool.query(`INSERT INTO bb_storage_inventory_delete_attempts(id,key_sha256,etag_sha256,byte_size,object_last_modified)
              VALUES($1,$2,$3,$4,$5)`, [uid(),digest(item.key),digest(item.etag),item.bytes,item.lastModified]);
            report.deleted += Number(await deleteLegacySnapshot(pool, blobs, item, now, graceHours));
          }
          else if (policy.deleteEnabled) report.deleteSkipped++;
        }
      }
      cursor = page.continuation;
      await pool.query(`INSERT INTO bb_storage_inventory_cursors(prefix,continuation) VALUES($1,$2)
        ON CONFLICT(prefix) DO UPDATE SET continuation=$2,updated_at=now()`, [prefix,cursor ?? null]);
      if (!cursor) break;
    }
    report.continuation[prefix] = !!cursor;
  }
  const candidates = Object.values(report.byPrefix).reduce((n, counts) => n + counts.orphan_candidate.count, 0);
  if (candidates) await raiseAlert(pool, { kind: 'storage_orphan_candidates', severity: 'warning', scope: 'private_blob', detail: { candidates, scanned: report.scanned } });
  return report;
}

async function deleteLegacySnapshot(pool: Pool, blobs: PrivateBlobs, item: Item, now: Date, graceHours: number) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // New writers commit an intent before Blob IO. This lock waits for in-flight
    // intent inserts and blocks new ones until the conditional delete finishes.
    await client.query('LOCK TABLE bb_prompt_blob_intents IN SHARE MODE');
    await client.query('LOCK TABLE bb_snapshot_refs IN SHARE MODE');
    if (item.lastModified.getTime() > now.getTime() - graceHours * 3600000 || await classify(client, 'snapshot', item.key) !== 'orphan_candidate') {
      await client.query('ROLLBACK'); return false;
    }
    let removed: boolean;
    try { removed = await blobs.deleteIfMatch!(item.key, item.etag); }
    catch (error) {
      // A writer replaced this object after listing; never delete its new ETag.
      if ((error as { statusCode?: number }).statusCode !== 412) throw error;
      await client.query('ROLLBACK'); return false;
    }
    if (removed) await client.query(`INSERT INTO bb_storage_inventory_deletions
      (id,key_sha256,kind,byte_size,object_last_modified,policy_version) VALUES($1,$2,'snapshot',$3,$4,'inventory_v1')
      ON CONFLICT(key_sha256) DO NOTHING`, [uid(),digest(item.key),item.bytes,item.lastModified]);
    await client.query('COMMIT');
    return removed;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (!process.env.DATABASE_URL || !process.env.AZURE_STORAGE_CONNECTION_STRING) throw new Error('DATABASE_URL and AZURE_STORAGE_CONNECTION_STRING required');
    const policy = inventoryPolicyFromEnv();
    if (process.argv[2] === 'delete') policy.deleteEnabled = true;
    else if (process.argv[2] === undefined || process.argv[2] === 'scan') policy.deleteEnabled = false;
    else throw new Error('usage: storage-inventory scan|delete');
    if (policy.deleteEnabled && process.env.BB_STORAGE_INVENTORY_DELETE !== 'true') throw new Error('Deletion requires BB_STORAGE_INVENTORY_DELETE=true');
    process.stdout.write(`${JSON.stringify(await runStorageInventory(pool, azureBlobs(process.env.AZURE_STORAGE_CONNECTION_STRING), policy))}\n`);
  } catch (error) { process.stderr.write(`storage-inventory failed: ${error instanceof Error ? error.message : 'unknown'}\n`); process.exitCode = 1; }
  finally { await pool.end(); }
}
