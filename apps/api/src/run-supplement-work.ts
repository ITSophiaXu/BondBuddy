import type { Pool, PoolClient } from 'pg';
import type { RunSupplementDraftResponse } from '@bondbuddy/contracts';
import { Problem, type PrivateBlobs, digest, transaction } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import { assertRunExecution } from './run-execution.js';
import { assertModelCallExecution } from './model-call-execution.js';
import { providerCallNeedsReconciliation } from './queue.js';

type Db = Pick<PoolClient, 'query'>;
type SavedWork = RunSupplementDraftResponse['saved_work'];
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const unavailable = () => new Problem(409, 'INPUT_REVISION_CONFLICT', '已保存工作与本次暂停位置不一致，请核对后重新保存补料草稿。');
function checkpoint(value: unknown): Record<string, any> {
  if (!record(value) || value.stages !== undefined && !record(value.stages)
    || value.provider_results !== undefined && !Array.isArray(value.provider_results)) throw unavailable();
  return value;
}
function matches(entry: any, result: any): boolean {
  return record(entry) && entry.call_id === result.attempt_id && entry.logical_call_id === result.logical_call_id
    && entry.attempt_no === result.attempt_no && entry.result_id === result.id && entry.result_ref === result.result_ref
    && entry.result_sha256 === result.result_sha256.trim() && entry.result_schema_version === result.result_schema_version;
}

/** Capture only under the caller's run -> job locks, in the draft-save transaction. */
export async function captureRunSupplementWork(db: PoolClient, r: any, job: any, revision: number): Promise<void> {
  if (!job || job.owner_user_id !== r.owner_user_id || job.run_id !== r.id || r.state !== 'paused'
    || job.state !== 'paused' || !job.user_pause_requested || job.lease_token || job.lease_until
    || await providerCallNeedsReconciliation(db, job.id)) throw unavailable();
  const execution = await assertRunExecution(db, r), source = checkpoint(job.checkpoint);
  const refs = source.provider_results ?? [];
  const results = (await db.query(`SELECT p.*,a.status AS attempt_status FROM bb_provider_result_refs p
    JOIN bb_model_call_attempts a ON a.id=p.attempt_id AND a.owner_user_id=p.owner_user_id AND a.job_id=p.job_id
    WHERE p.owner_user_id=$1 AND p.project_id=$2 AND p.run_id=$3 AND p.job_id=$4 ORDER BY p.id`,
  [r.owner_user_id, r.project_id, r.id, job.id])).rows;
  if (Object.keys(source.stages ?? {}).length > 10000 || results.length > 10000 || refs.length !== results.length) throw unavailable();
  const seen = new Set<string>();
  for (const result of results) {
    if (result.attempt_status !== 'completed' || seen.has(result.attempt_id)
      || refs.filter((entry: unknown) => matches(entry, result)).length !== 1) throw unavailable();
    seen.add(result.attempt_id);
    const binding = await assertModelCallExecution(db, { owner: r.owner_user_id, projectId: r.project_id,
      runId: r.id, jobId: job.id, attemptId: result.attempt_id, ...execution });
    if (binding.promptSnapshotRef !== result.prompt_snapshot_ref) throw unavailable();
  }
  await db.query(`INSERT INTO bb_run_supplement_saved_work(owner_user_id,project_id,run_id,supplement_revision,
    job_id,execution_version,input_revision,input_hash,source_checkpoint,checkpoint_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [r.owner_user_id, r.project_id, r.id, revision, job.id,
    execution.executionVersion, execution.inputRevision, execution.inputHash, source, inputManifestHash(source)]);
  for (const result of results) await db.query(`INSERT INTO bb_run_supplement_saved_results
    (owner_user_id,project_id,run_id,supplement_revision,attempt_id,result_id) VALUES($1,$2,$3,$4,$5,$6)`,
  [r.owner_user_id, r.project_id, r.id, revision, result.attempt_id, result.id]);
}

/** Metadata only. Public callers get counts, never model content, object keys or a download grant. */
export async function runSupplementWorkSummary(db: Db, r: any, job: any, revision: number): Promise<SavedWork> {
  const work = (await db.query(`SELECT * FROM bb_run_supplement_saved_work
    WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3 AND supplement_revision=$4`,
  [r.owner_user_id, r.project_id, r.id, revision])).rows[0];
  if (!work) return { status: 'not_captured', stage_count: 0, result_count: 0 };
  const source = checkpoint(work.source_checkpoint), hash = inputManifestHash(source);
  if (work.checkpoint_hash.trim() !== hash || work.job_id !== job?.id || work.execution_version !== 1
    || work.input_revision !== r.input_revision || work.input_hash.trim() !== r.input_hash.trim()) throw unavailable();
  const count = Number((await db.query(`SELECT count(*)::int AS n FROM bb_run_supplement_saved_results
    WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3 AND supplement_revision=$4`,
  [r.owner_user_id, r.project_id, r.id, revision])).rows[0].n);
  const stageCount = Object.keys(source.stages ?? {}).length;
  if (count !== (source.provider_results ?? []).length || stageCount > 10000 || count > 10000) throw unavailable();
  return { status: !job || inputManifestHash(job.checkpoint) !== hash ? 'stale_boundary' : 'captured',
    stage_count: stageCount, result_count: count };
}

type CapturedReadInput = { db: Pool; blobs: PrivateBlobs; owner: string; projectId: string;
  runId: string; revision: number; resultId: string; resultSchemaVersion: string;
  validate: (value: unknown, db: PoolClient) => boolean | Promise<boolean> };

/** Service-internal read, serialized with prompt/result content purges through
 * Blob I/O and asynchronous validation. This grants no execution or download. */
export async function readCapturedSupplementResult(input: CapturedReadInput): Promise<unknown> {
  return transaction(input.db, async db => {
    const ref = (await db.query(`SELECT p.id,p.prompt_snapshot_ref FROM bb_run_supplement_saved_results c
      JOIN bb_provider_result_refs p ON p.id=c.result_id AND p.attempt_id=c.attempt_id
        AND p.owner_user_id=c.owner_user_id AND p.project_id=c.project_id AND p.run_id=c.run_id
      WHERE c.owner_user_id=$1 AND c.project_id=$2 AND c.run_id=$3 AND c.supplement_revision=$4 AND c.result_id=$5`,
    [input.owner, input.projectId, input.runId, input.revision, input.resultId])).rows[0];
    if (!ref) throw unavailable();
    await db.query("SELECT pg_advisory_xact_lock(hashtext('prompt_snapshot'),hashtext($1::text))", [ref.prompt_snapshot_ref]);
    await db.query("SELECT pg_advisory_xact_lock(hashtext('provider_result'),hashtext($1::text))", [ref.id]);
    // Recheck all visibility after waiting for either purge lock.
    return readCapturedResultLocked({ ...input, db });
  });
}

async function readCapturedResultLocked(input: Omit<CapturedReadInput, 'db'> & { db: PoolClient }): Promise<unknown> {
  const row = (await input.db.query(`SELECT p.*,w.execution_version,w.input_revision,w.input_hash,w.source_checkpoint,w.checkpoint_hash
    FROM bb_run_supplement_saved_results c
    JOIN bb_run_supplement_saved_work w ON w.run_id=c.run_id AND w.supplement_revision=c.supplement_revision
      AND w.owner_user_id=c.owner_user_id AND w.project_id=c.project_id
    JOIN bb_provider_result_refs p ON p.id=c.result_id AND p.attempt_id=c.attempt_id AND p.owner_user_id=c.owner_user_id
      AND p.project_id=c.project_id AND p.run_id=c.run_id AND p.job_id=w.job_id
    JOIN bb_model_call_attempts a ON a.id=p.attempt_id AND a.owner_user_id=p.owner_user_id AND a.job_id=p.job_id AND a.status='completed'
    JOIN bb_projects pr ON pr.id=w.project_id AND pr.owner_user_id=w.owner_user_id AND pr.deleted_at IS NULL
    JOIN bb_users u ON u.id=w.owner_user_id AND u.closed_at IS NULL AND u.status<>'closed'
    WHERE c.owner_user_id=$1 AND c.project_id=$2 AND c.run_id=$3 AND c.supplement_revision=$4 AND c.result_id=$5
      AND NOT EXISTS (SELECT 1 FROM bb_log_content_tombstones x
        WHERE (x.content_kind='provider_result' AND x.content_id=p.id)
          OR (x.content_kind='prompt_snapshot' AND x.content_id=p.prompt_snapshot_ref))`,
  [input.owner, input.projectId, input.runId, input.revision, input.resultId])).rows[0];
  if (!row || row.owner_user_id !== input.owner || row.project_id !== input.projectId || row.run_id !== input.runId
    || row.id !== input.resultId || row.result_schema_version !== input.resultSchemaVersion || row.execution_version !== 1
    || row.checkpoint_hash.trim() !== inputManifestHash(checkpoint(row.source_checkpoint))
    || row.source_checkpoint.provider_results?.filter((entry: unknown) => matches(entry, row)).length !== 1) throw unavailable();
  const binding = await assertModelCallExecution(input.db, { owner: input.owner, projectId: input.projectId, runId: input.runId,
    jobId: row.job_id, attemptId: row.attempt_id, executionVersion: row.execution_version,
    inputRevision: row.input_revision, inputHash: row.input_hash.trim() });
  if (binding.promptSnapshotRef !== row.prompt_snapshot_ref || !Number.isSafeInteger(Number(row.byte_size))
    || Number(row.byte_size) < 1 || Number(row.byte_size) > 10485760) throw unavailable();
  let bytes: Buffer | null;
  try { bytes = await input.blobs.getIfExistsBounded(row.result_ref, Number(row.byte_size)); } catch { throw unavailable(); }
  if (!bytes || bytes.length !== Number(row.byte_size) || digest(bytes) !== row.result_sha256.trim()) throw unavailable();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw unavailable(); }
  if (!await input.validate(value, input.db)) throw unavailable();
  return value;
}
