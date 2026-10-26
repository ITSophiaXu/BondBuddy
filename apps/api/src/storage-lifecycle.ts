import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { azureBlobs, digest, transaction, uid, type PrivateBlobs } from './data.js';

const MAX_BATCH_SIZE = 50;
const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_RETRY_MS = 5 * 60_000;

class StorageLifecycleConfigurationError extends Error {}

export type StorageLifecyclePolicy = {
  materialRetentionDays: number;
  orphanUploadGraceHours: number;
  batchSize?: number;
  leaseMs?: number;
  retryDelayMs?: number;
  now?: () => Date;
  /** Test/restore-verifier scope only. The production CLI never sets an owner filter. */
  ownerScope?: string;
  /** Failure-injection hook used to model a crash after Blob deletion but before PostgreSQL commit. */
  afterBlobDelete?: (tombstoneId: string) => Promise<void>;
};

type Tombstone = {
  id: string;
  owner_user_id: string;
  project_id: string;
  object_kind: 'material' | 'orphan_upload';
  material_id: string | null;
  material_version: number | null;
  upload_id: string | null;
  object_key: string;
  sha256: string;
  attempts: number;
  claim_token: string;
};

export type StorageLifecycleResult = {
  orphanUploadsQueued: number;
  materialDeadlinesRecorded: number;
  claimed: number;
  purged: number;
  pinned: number;
  failed: number;
};

function nonNegativeInteger(value: string | undefined): number | null {
  if (value === undefined || value === '' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * No retention or purge default is supplied here. An unset/false enable switch disables the worker;
 * an enabled worker with incomplete policy fails before opening PostgreSQL or Blob storage.
 */
export function storageLifecyclePolicyFromEnv(env: NodeJS.ProcessEnv = process.env): StorageLifecyclePolicy | null {
  if (env.BB_STORAGE_PURGE_ENABLED !== undefined && env.BB_STORAGE_PURGE_ENABLED !== 'true' && env.BB_STORAGE_PURGE_ENABLED !== 'false') {
    throw new StorageLifecycleConfigurationError('BB_STORAGE_PURGE_ENABLED must be exactly true or false');
  }
  if (env.BB_STORAGE_PURGE_ENABLED !== 'true') return null;
  const materialRetentionDays = nonNegativeInteger(env.BB_STORAGE_MATERIAL_RETENTION_DAYS);
  const orphanUploadGraceHours = nonNegativeInteger(env.BB_STORAGE_ORPHAN_GRACE_HOURS);
  if (materialRetentionDays === null || orphanUploadGraceHours === null) {
    throw new StorageLifecycleConfigurationError('Storage purge enabled but BB_STORAGE_MATERIAL_RETENTION_DAYS and BB_STORAGE_ORPHAN_GRACE_HOURS must be explicitly set to non-negative integers');
  }
  return { materialRetentionDays, orphanUploadGraceHours };
}

function policyValues(policy: StorageLifecyclePolicy) {
  if (!Number.isSafeInteger(policy.materialRetentionDays) || policy.materialRetentionDays < 0
    || !Number.isSafeInteger(policy.orphanUploadGraceHours) || policy.orphanUploadGraceHours < 0) {
    throw new StorageLifecycleConfigurationError('Storage lifecycle policy requires explicit non-negative integer retention and grace values');
  }
  const batchSize = Math.min(MAX_BATCH_SIZE, policy.batchSize ?? MAX_BATCH_SIZE);
  const leaseMs = policy.leaseMs ?? DEFAULT_LEASE_MS;
  const retryDelayMs = policy.retryDelayMs ?? DEFAULT_RETRY_MS;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || !Number.isSafeInteger(leaseMs) || leaseMs < 1
    || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1) {
    throw new StorageLifecycleConfigurationError('Storage lifecycle batch, lease and retry values must be positive integers');
  }
  return { batchSize, leaseMs, retryDelayMs, now: policy.now ?? (() => new Date()) };
}

function scopeParam(ownerScope: string | undefined) {
  return ownerScope ?? null;
}

async function queueExpiredOrphans(
  pool: Pool,
  policy: StorageLifecyclePolicy,
  batchSize: number,
  now: Date
): Promise<number> {
  return transaction(pool, async client => {
    const due = await client.query(`
      WITH candidates AS (
        SELECT u.id
          FROM bb_uploads u
         WHERE u.state IN ('uploading','received')
           AND u.expires_at + ($1::integer * interval '1 hour') <= $2::timestamptz
           AND ($3::text IS NULL OR u.owner_user_id=$3)
           AND NOT EXISTS (
             SELECT 1 FROM bb_material_versions m
              WHERE m.owner_user_id=u.owner_user_id AND m.upload_id=u.id
           )
         ORDER BY u.expires_at,u.id
         LIMIT $4
         FOR UPDATE OF u SKIP LOCKED
      )
      UPDATE bb_uploads u
         SET state='deleting'
        FROM candidates c
       WHERE u.id=c.id AND u.state IN ('uploading','received')
      RETURNING u.*,(u.expires_at + ($1::integer * interval '1 hour')) AS purge_after`,
      [policy.orphanUploadGraceHours, now, scopeParam(policy.ownerScope), batchSize]);

    for (const upload of due.rows) {
      const tombstoneId = uid();
      await client.query(`INSERT INTO bb_storage_tombstones
        (id,owner_user_id,project_id,object_kind,upload_id,object_key,sha256,requested_at,eligible_at)
        VALUES($1,$2,$3,'orphan_upload',$4,$5,lower($6),$7,$8)`,
        [tombstoneId, upload.owner_user_id, upload.project_id, upload.id, upload.object_key,
          upload.sha256.trim(), now, upload.purge_after]);
      await client.query(`INSERT INTO bb_outbox
        (id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
        VALUES($1,$2,'upload',$3,'upload.orphan_purge_requested',$4)`,
        [uid(), upload.owner_user_id, upload.id, { project_id: upload.project_id, tombstone_id: tombstoneId }]);
    }
    return due.rowCount ?? 0;
  });
}

async function recordDueMaterialDeadlines(
  pool: Pool,
  policy: StorageLifecyclePolicy,
  batchSize: number,
  now: Date
): Promise<number> {
  return transaction(pool, async client => {
    const result = await client.query(`
      WITH due AS (
        SELECT t.id
          FROM bb_storage_tombstones t
         WHERE t.object_kind='material' AND t.state='pending' AND t.eligible_at IS NULL
           AND t.requested_at + ($1::integer * interval '1 day') <= $2::timestamptz
           AND ($3::text IS NULL OR t.owner_user_id=$3)
         ORDER BY t.requested_at,t.id
         LIMIT $4
         FOR UPDATE OF t SKIP LOCKED
      )
      UPDATE bb_storage_tombstones t
         SET eligible_at=t.requested_at + ($1::integer * interval '1 day')
        FROM due
       WHERE t.id=due.id
      RETURNING t.id`,
      [policy.materialRetentionDays, now, scopeParam(policy.ownerScope), batchSize]);
    return result.rowCount ?? 0;
  });
}

async function isPinned(client: Pool | PoolClient, tombstone: Pick<Tombstone, 'owner_user_id' | 'project_id' | 'material_id' | 'material_version'>) {
  if (!tombstone.material_id || tombstone.material_version === null) return false;
  // The database checks the exact accepted V1 input and canonical M4 snapshot.
  // A saved candidate or processing plan does not retain original material bytes.
  const result = await client.query('SELECT bb_material_bytes_pinned($1,$2,$3,$4) AS pinned',
    [tombstone.owner_user_id, tombstone.project_id, tombstone.material_id, tombstone.material_version]);
  return result.rows[0]?.pinned === true;
}

async function countEligiblePinnedTombstones(pool: Pool, policy: StorageLifecyclePolicy, batchSize: number, now: Date) {
  const result = await pool.query(`
    SELECT count(*)::integer AS count FROM (
      SELECT t.id
        FROM bb_storage_tombstones t
       WHERE t.object_kind='material' AND t.state='pending'
         AND t.eligible_at IS NOT NULL AND t.eligible_at <= $1::timestamptz
         AND (t.retry_after IS NULL OR t.retry_after <= $1::timestamptz)
         AND t.requested_at + ($2::integer * interval '1 day') <= $1::timestamptz
         AND ($3::text IS NULL OR t.owner_user_id=$3)
         AND bb_material_bytes_pinned(t.owner_user_id,t.project_id,t.material_id,t.material_version)
       ORDER BY t.eligible_at,t.requested_at,t.id
       LIMIT $4
    ) AS bounded_pins`, [now, policy.materialRetentionDays, scopeParam(policy.ownerScope), batchSize]);
  return Number(result.rows[0]?.count ?? 0);
}

async function claimReadyTombstones(
  pool: Pool,
  policy: StorageLifecyclePolicy,
  batchSize: number,
  leaseMs: number,
  now: Date
): Promise<Tombstone[]> {
  return transaction(pool, async client => {
    const candidates = await client.query(`
      SELECT t.*
        FROM bb_storage_tombstones t
        LEFT JOIN bb_uploads u ON u.owner_user_id=t.owner_user_id AND u.id=t.upload_id
       WHERE t.eligible_at IS NOT NULL AND t.eligible_at <= $1::timestamptz
         AND (t.retry_after IS NULL OR t.retry_after <= $1::timestamptz)
         AND (t.state='pending' OR (t.state='claimed' AND t.lease_until <= $1::timestamptz))
         AND ($2::text IS NULL OR t.owner_user_id=$2)
         AND (
           (t.object_kind='material'
            AND t.requested_at + ($3::integer * interval '1 day') <= $1::timestamptz
            AND NOT bb_material_bytes_pinned(t.owner_user_id,t.project_id,t.material_id,t.material_version))
           OR
           (t.object_kind='orphan_upload' AND u.expires_at + ($4::integer * interval '1 hour') <= $1::timestamptz)
         )
       ORDER BY t.eligible_at,t.requested_at,t.id
       LIMIT $5
       FOR UPDATE OF t SKIP LOCKED`,
      [now, scopeParam(policy.ownerScope), policy.materialRetentionDays, policy.orphanUploadGraceHours, batchSize]);

    const claimed: Tombstone[] = [];
    for (const row of candidates.rows) {
      const token = uid();
      const update = await client.query(`UPDATE bb_storage_tombstones
        SET state='claimed',claim_token=$2,lease_until=$3,attempts=attempts+1,retry_after=NULL,last_error_code=NULL
        WHERE id=$1 RETURNING *`, [row.id, token, new Date(now.getTime() + leaseMs)]);
      if (update.rows[0]) claimed.push(update.rows[0] as Tombstone);
    }
    return claimed;
  });
}

async function releasePinnedClaim(db: Pool | PoolClient, tombstone: Tombstone) {
  await db.query(`UPDATE bb_storage_tombstones
    SET state='pending',claim_token=NULL,lease_until=NULL,retry_after=NULL,last_error_code=NULL
    WHERE id=$1 AND state='claimed' AND claim_token=$2`, [tombstone.id, tombstone.claim_token]);
}

async function failClaim(pool: Pool, tombstone: Tombstone, retryDelayMs: number, now: Date, code: string) {
  const delay = retryDelayMs * Math.min(Math.max(1, tombstone.attempts), 12);
  await pool.query(`UPDATE bb_storage_tombstones
    SET state='pending',claim_token=NULL,lease_until=NULL,retry_after=$3,last_error_code=$4
    WHERE id=$1 AND state='claimed' AND claim_token=$2`,
    [tombstone.id, tombstone.claim_token, new Date(now.getTime() + delay), code]);
}

async function markPurged(pool: Pool, tombstone: Tombstone, now: Date): Promise<boolean> {
  return transaction(pool, async client => {
    const result = await client.query(`UPDATE bb_storage_tombstones
      SET state='purged',claim_token=NULL,lease_until=NULL,retry_after=NULL,last_error_code=NULL,purged_at=$3
      WHERE id=$1 AND state='claimed' AND claim_token=$2 RETURNING *`,
      [tombstone.id, tombstone.claim_token, now]);
    if (!result.rows[0]) return false;
    const row = result.rows[0];
    if (row.object_kind === 'orphan_upload') {
      const upload = await client.query(`UPDATE bb_uploads SET state='purged'
        WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND state='deleting'`,
        [row.owner_user_id, row.project_id, row.upload_id]);
      if (upload.rowCount !== 1) throw new Error('Orphan upload state changed before tombstone replay completed');
    }
    const payload: Record<string, unknown> = { project_id: row.project_id, tombstone_id: row.id, object_kind: row.object_kind };
    if (row.material_id) Object.assign(payload, { material_id: row.material_id, material_version: row.material_version });
    if (row.upload_id) Object.assign(payload, { upload_id: row.upload_id });
    await client.query(`INSERT INTO bb_outbox
      (id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'storage_tombstone',$3,'storage.object_purged',$4)`,
      [uid(), row.owner_user_id, row.id, payload]);
    return true;
  });
}

function failureCode(error: unknown): 'pin_check_failed' | 'blob_read_failed' | 'blob_delete_failed' | 'blob_hash_mismatch' | 'purge_attempt_failed' | 'blob_io_failed' {
  if (error instanceof Error && error.name === 'StoragePinCheckFailed') return 'pin_check_failed';
  if (error instanceof Error && error.name === 'StorageBlobReadFailed') return 'blob_read_failed';
  if (error instanceof Error && error.name === 'StorageBlobDeleteFailed') return 'blob_delete_failed';
  if (error instanceof Error && error.name === 'StorageBlobHashMismatch') return 'blob_hash_mismatch';
  if (error instanceof Error && error.name === 'StoragePurgeFinalizeFailed') return 'purge_attempt_failed';
  return 'blob_io_failed';
}

function safeFailure(name: string) {
  const error = new Error('Storage lifecycle operation failed');
  error.name = name;
  return error;
}

/** Publish an irreversible deletion boundary before touching private bytes.
 * Producers hold the same material lock until their run/snapshot/job commits.
 * Only this short database transaction holds locks; Blob I/O follows its commit.
 */
async function startPurge(pool: Pool, tombstone: Tombstone): Promise<'started' | 'pinned' | 'lease_lost'> {
  return transaction(pool, async client => {
    if (tombstone.object_kind === 'material') {
      // Keep the lock and the following reads in separate SQL statements so a
      // producer that committed while we waited is visible at READ COMMITTED.
      await client.query('SELECT pg_advisory_xact_lock(bb_material_lifecycle_lock_key($1,$2,$3,$4))',
        [tombstone.owner_user_id, tombstone.project_id, tombstone.material_id, tombstone.material_version]);
    }
    const current = (await client.query(`SELECT *,lease_until>clock_timestamp() AS lease_live
      FROM bb_storage_tombstones WHERE id=$1 AND state='claimed' AND claim_token=$2 FOR UPDATE`,
      [tombstone.id, tombstone.claim_token])).rows[0];
    if (!current || !current.lease_live || current.attempts !== tombstone.attempts) return 'lease_lost';
    if (current.owner_user_id !== tombstone.owner_user_id || current.project_id !== tombstone.project_id
      || current.object_kind !== tombstone.object_kind || current.object_key !== tombstone.object_key
      || current.sha256.trim() !== tombstone.sha256.trim() || current.material_id !== tombstone.material_id
      || current.material_version !== tombstone.material_version || current.upload_id !== tombstone.upload_id)
      throw safeFailure('StoragePinCheckFailed');
    if (await isPinned(client, tombstone)) {
      await releasePinnedClaim(client, tombstone);
      return 'pinned';
    }
    if (tombstone.object_kind === 'material') {
      await client.query(`INSERT INTO bb_storage_purge_starts(tombstone_id,claim_token,claim_attempt,origin,created_at)
        VALUES($1,$2,$3,'verified_delete',clock_timestamp()) ON CONFLICT (tombstone_id) DO NOTHING`,
        [tombstone.id, tombstone.claim_token, current.attempts]);
    }
    return 'started';
  });
}

async function processTombstone(
  pool: Pool,
  blobs: PrivateBlobs,
  tombstone: Tombstone,
  policy: StorageLifecyclePolicy,
  retryDelayMs: number,
  now: () => Date
): Promise<'purged' | 'pinned' | 'failed' | 'lease_lost'> {
  try {
    let start: Awaited<ReturnType<typeof startPurge>>;
    try { start = await startPurge(pool, tombstone); }
    catch { throw safeFailure('StoragePinCheckFailed'); }
    if (start !== 'started') return start;
    let bytes: Buffer | null;
    try { bytes = await blobs.getIfExists(tombstone.object_key); }
    catch { throw safeFailure('StorageBlobReadFailed'); }
    if (bytes !== null && digest(bytes) !== tombstone.sha256.trim()) {
      throw safeFailure('StorageBlobHashMismatch');
    }
    if (bytes !== null) {
      try { await blobs.delete(tombstone.object_key); }
      catch { throw safeFailure('StorageBlobDeleteFailed'); }
    }
    try { await policy.afterBlobDelete?.(tombstone.id); }
    catch { throw safeFailure('StoragePurgeFinalizeFailed'); }
    try {
      return await markPurged(pool, tombstone, now()) ? 'purged' : 'lease_lost';
    } catch { throw safeFailure('StoragePurgeFinalizeFailed'); }
  } catch (error) {
    await failClaim(pool, tombstone, retryDelayMs, now(), failureCode(error));
    return 'failed';
  }
}

/**
 * Processes a bounded batch. Both the claim and material deletion boundary commit before Blob I/O.
 * New pins cannot cross that boundary, including after an uncertain delete or process crash.
 * The immutable target and delete-if-absent replay preserve recovery of the exact private object.
 */
export async function runStorageLifecycle(
  pool: Pool,
  blobs: PrivateBlobs,
  policy: StorageLifecyclePolicy
): Promise<StorageLifecycleResult> {
  const { batchSize, leaseMs, retryDelayMs, now } = policyValues(policy);
  const at = now();
  const orphanUploadsQueued = await queueExpiredOrphans(pool, policy, batchSize, at);
  const materialDeadlinesRecorded = await recordDueMaterialDeadlines(pool, policy, batchSize, at);
  const pinned = await countEligiblePinnedTombstones(pool, policy, batchSize, at);
  const claimed = await claimReadyTombstones(pool, policy, batchSize, leaseMs, at);
  const result: StorageLifecycleResult = {
    orphanUploadsQueued,
    materialDeadlinesRecorded,
    claimed: claimed.length,
    purged: 0,
    pinned,
    failed: 0
  };
  for (const tombstone of claimed) {
    const outcome = await processTombstone(pool, blobs, tombstone, policy, retryDelayMs, now);
    if (outcome === 'purged') result.purged++;
    else if (outcome === 'pinned') result.pinned++;
    else if (outcome === 'failed') result.failed++;
  }
  return result;
}

async function main() {
  const policy = storageLifecyclePolicyFromEnv();
  if (!policy) {
    process.stdout.write('Storage lifecycle purge disabled; no objects changed\n');
    return;
  }
  if (!process.env.DATABASE_URL || !process.env.AZURE_STORAGE_CONNECTION_STRING) {
    throw new StorageLifecycleConfigurationError('Enabled storage purge requires DATABASE_URL and AZURE_STORAGE_CONNECTION_STRING');
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await runStorageLifecycle(pool, azureBlobs(process.env.AZURE_STORAGE_CONNECTION_STRING), policy);
    process.stdout.write(`Storage lifecycle batch complete: queued=${result.orphanUploadsQueued} deadlines=${result.materialDeadlinesRecorded} claimed=${result.claimed} purged=${result.purged} pinned=${result.pinned} failed=${result.failed}\n`);
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    if (error instanceof StorageLifecycleConfigurationError) process.stderr.write(`${error.message}\n`);
    else process.stderr.write('Storage lifecycle run failed; durable tombstones remain available for safe retry\n');
    process.exitCode = 1;
  });
}
