import type { Pool, PoolClient } from 'pg';
import { digest, missing, Problem, transaction, run as getRun, type PrivateBlobs } from './data.js';
import type { Lease } from './queue.js';
import type { ProviderCallIntent } from './provider-results.js';

// #448: private per-attempt Codex execution evidence. The adapter bounds the capture;
// this module only stores it in private Blob storage and records the immutable reference.
export const CODEX_EXEC_LOG_MAX_BYTES = 20 * 1024 * 1024;
export const CODEX_EXEC_LOG_MEDIA_TYPE = 'text/plain; charset=utf-8';
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/** `<run prefix>/<attempt_id>/exec.log`, matching provider result object ownership. */
export function codexExecLogObjectKey(intent: ProviderCallIntent): string {
  if (!safeId(intent.owner_user_id) || !safeId(intent.project_id) || !safeId(intent.run_id) || !safeId(intent.call_id)) throw new Error('Invalid exec log identity');
  return `users/${intent.owner_user_id}/projects/${intent.project_id}/runs/${intent.run_id}/attempts/${intent.call_id}/exec.log`;
}

export type CodexExecLogMeta = { truncated: boolean };

/** Persist one bounded attempt log and its immutable database reference under the active lease. */
export async function recordCodexExecLog(pool: Pool, blobs: PrivateBlobs, lease: Lease, intent: ProviderCallIntent, bytes: Buffer, meta: CodexExecLogMeta) {
  if (!Buffer.isBuffer(bytes) || bytes.length > CODEX_EXEC_LOG_MAX_BYTES || typeof meta.truncated !== 'boolean') throw new Error('Invalid codex exec log');
  if (lease.owner !== intent.owner_user_id || lease.jobId !== intent.job_id || lease.runId !== intent.run_id) throw missing();
  const objectKey = codexExecLogObjectKey(intent);
  const copy = Buffer.from(bytes);
  const sha256 = digest(copy);
  // Fast idempotent replay: never overwrite an existing attempt's private evidence,
  // and never treat a stale lease as authorization to replay it.
  const prior = (await pool.query(`SELECT l.sha256,l.byte_size,l.truncated,
      (j.state='running' AND j.lease_token=$2 AND j.lease_until>now()) AS active
    FROM bb_codex_exec_logs l
    JOIN bb_jobs j ON j.owner_user_id=l.owner_user_id AND j.id=l.job_id AND j.run_id=l.run_id
    WHERE l.attempt_id=$1 AND l.owner_user_id=$3`, [intent.call_id, lease.token, lease.owner])).rows[0];
  if (prior) {
    if (prior.active !== true) throw new Problem(409, 'CAPABILITY_NOT_READY', 'Codex exec log lease is no longer active');
    if (String(prior.sha256).trim() !== sha256 || Number(prior.byte_size) !== copy.length || prior.truncated !== meta.truncated)
      throw new Problem(409, 'IDEMPOTENCY_CONFLICT', 'Codex exec log already has different evidence');
    return { idempotent: true, object_key: objectKey, sha256, byte_size: copy.length, truncated: meta.truncated };
  }
  // Preflight keeps rejected uploads from creating private orphan objects. The
  // authoritative check still runs inside the insert transaction below.
  const run = (await pool.query('SELECT project_id,state FROM bb_runs WHERE owner_user_id=$1 AND id=$2', [lease.owner, lease.runId])).rows[0];
  const job = (await pool.query('SELECT state,lease_token,lease_until FROM bb_jobs WHERE owner_user_id=$1 AND id=$2 AND run_id=$3', [lease.owner, lease.jobId, lease.runId])).rows[0];
  const attempt = (await pool.query('SELECT id FROM bb_model_call_attempts WHERE owner_user_id=$1 AND job_id=$2 AND logical_call_id=$3 AND attempt_no=$4', [intent.owner_user_id, intent.job_id, intent.logical_call_id, intent.attempt_no])).rows[0];
  if (!run || run.project_id !== intent.project_id || !job || !attempt || attempt.id !== intent.call_id) throw missing();
  if (['succeeded', 'test_completed', 'failed', 'cancelled', 'rejected'].includes(run.state) || job.state !== 'running' || job.lease_token !== lease.token || !job.lease_until || new Date(job.lease_until).getTime() <= Date.now())
    throw new Problem(409, 'CAPABILITY_NOT_READY', 'Codex exec log lease is no longer active');
  await blobs.put(objectKey, copy, CODEX_EXEC_LOG_MEDIA_TYPE);
  const stored = await blobs.get(objectKey);
  if (stored.length !== copy.length || digest(stored) !== sha256) throw new Problem(409, 'CAPABILITY_NOT_READY', 'Codex exec log Blob verification failed');
  return transaction(pool, async client => {
    // Match the runtime evidence lock order: run -> job -> attempt.
    const r = await getRun(client, lease.owner, lease.runId, true);
    if (r.project_id !== intent.project_id) throw missing();
    if (['succeeded', 'test_completed', 'failed', 'cancelled', 'rejected'].includes(r.state))
      throw new Problem(409, 'CAPABILITY_NOT_READY', 'Codex exec log lease is no longer active');
    const job = (await client.query('SELECT state,lease_token,lease_until FROM bb_jobs WHERE owner_user_id=$1 AND id=$2 AND run_id=$3 FOR UPDATE', [lease.owner, lease.jobId, lease.runId])).rows[0];
    const attempt = (await client.query('SELECT id FROM bb_model_call_attempts WHERE owner_user_id=$1 AND job_id=$2 AND logical_call_id=$3 AND attempt_no=$4', [intent.owner_user_id, intent.job_id, intent.logical_call_id, intent.attempt_no])).rows[0];
    if (!job || !attempt || attempt.id !== intent.call_id) throw missing();
    if (job.state !== 'running' || job.lease_token !== lease.token || !job.lease_until || new Date(job.lease_until).getTime() <= Date.now())
      throw new Problem(409, 'CAPABILITY_NOT_READY', 'Codex exec log lease is no longer active');
    const existing = (await client.query('SELECT object_key,sha256,byte_size,truncated FROM bb_codex_exec_logs WHERE attempt_id=$1', [attempt.id])).rows[0];
    if (existing) {
      const same = existing.object_key === objectKey && existing.sha256.trim() === sha256 && Number(existing.byte_size) === copy.length && existing.truncated === meta.truncated;
      if (!same) throw new Problem(409, 'IDEMPOTENCY_CONFLICT', 'Codex exec log already has different evidence');
      return { idempotent: true, object_key: objectKey, sha256, byte_size: copy.length, truncated: meta.truncated };
    }
    await client.query(`INSERT INTO bb_codex_exec_logs(attempt_id,owner_user_id,project_id,run_id,job_id,logical_call_id,attempt_no,object_key,sha256,byte_size,truncated)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [attempt.id, intent.owner_user_id, intent.project_id, intent.run_id, intent.job_id, intent.logical_call_id, intent.attempt_no,
        objectKey, sha256, copy.length, meta.truncated]);
    return { idempotent: false, object_key: objectKey, sha256, byte_size: copy.length, truncated: meta.truncated };
  });
}

export type CodexExecLogRow = {
  attempt_id: string;
  owner_user_id: string;
  project_id: string;
  run_id: string;
  object_key: string;
  sha256: string;
  byte_size: number;
  truncated: boolean;
  channel: string | null;
  created_at: Date | string;
};

/** Read one owned log reference. Authorization and auditing stay with the admin route. */
export async function codexExecLogRow(pool: Pool | PoolClient, attemptId: string): Promise<CodexExecLogRow | null> {
  if (!safeId(attemptId)) return null;
  const row = (await pool.query(`SELECT l.attempt_id,l.owner_user_id,l.project_id,l.run_id,l.object_key,l.sha256,l.byte_size,l.truncated,l.created_at,r.channel
    FROM bb_codex_exec_logs l
    JOIN bb_runs r ON r.owner_user_id=l.owner_user_id AND r.id=l.run_id
    WHERE l.attempt_id=$1`, [attemptId])).rows[0];
  if (!row) return null;
  return { ...row, sha256: String(row.sha256).trim(), byte_size: Number(row.byte_size), truncated: row.truncated === true };
}
