import { Value } from '@sinclair/typebox/value';
import type { Pool, PoolClient } from 'pg';
import {
  LIBRARY_ERROR_CODES, LIBRARY_QUERY_SCHEMA_VERSION, LIBRARY_QUERY_SCHEMA_VERSION_V1_1, LIBRARY_SYSTEM_OWNER, LibraryQueryRequestSchema, librarySetKey,
  type ErrorCode, type LibraryAlert, type LibraryCandidate, type LibraryCandidateV1_1, type LibraryChapterMapping, type LibraryChapterMappingCreateRequest, type LibraryErrorCode, type LibraryOverview, type LibraryQueryRequest,
  type LibraryQueryResponse, type LibraryReviewActionRequest, type LibrarySelectionLock,
} from '@bondbuddy/contracts';
import { date, digest, missing, Problem, transaction, uid, type PrivateBlobs } from './data.js';
import { raiseAlert } from './evidence-gate.js';
import { emitInternal, internalEvent } from './observability.js';

// #78 backend reference library store. Platform data owned by LIBRARY_SYSTEM_OWNER; no function here
// accepts a user material id, so a personal upload has no path into the library.

export const LIBRARY_OWNER = LIBRARY_SYSTEM_OWNER;
export const DEFAULT_LIBRARY_MAX_ATTEMPTS = 3;
const safeReason = /^[a-z][a-z0-9_]{0,63}$/;
const reasonOf = (reason: string) => { if (!safeReason.test(reason)) throw new Problem(422, 'VALIDATION_FAILED', 'Reason must be a machine code'); return reason; };

// Maps internal pipeline codes onto the public enum for #79 rows; the library code stays in safe_message_code.
const PUBLIC_CODE: Record<LibraryErrorCode, ErrorCode> = {
  LIBRARY_SOURCE_UNREACHABLE: 'DATA_UNAVAILABLE', LIBRARY_FETCH_FAILED: 'DATA_UNAVAILABLE', LIBRARY_BYTES_INVALID: 'MATERIAL_CONTENT_MISMATCH',
  LIBRARY_PARSE_FAILED: 'MATERIAL_UNREADABLE', LIBRARY_CLASSIFY_FAILED: 'VALIDATION_FAILED', LIBRARY_STALE_REVISION: 'ALREADY_TERMINAL',
  LIBRARY_SOURCE_DISABLED: 'CAPABILITY_NOT_READY', LIBRARY_ATTEMPTS_EXHAUSTED: 'DATA_UNAVAILABLE',
};

// ---------------------------------------------------------------- selection cache
// Keyed by active release + rights stamp, both read from PostgreSQL on every query, so a withdraw,
// rollback or rights change in any process invalidates it immediately. Local mutations also clear it.
const queryCache = new Map<string, LibraryQueryResponse>();
export function invalidateLibraryCache() { queryCache.clear(); }
export function libraryCacheSize() { return queryCache.size; }

// ---------------------------------------------------------------- sources
export type LibrarySourceInput = {
  id: string; kind: 'public_disclosure' | 'operator_import'; displayName: string; market: 'sse' | 'szse' | 'nafmii' | null;
  authorizationBasis: string; termsUrl?: string | null; usageRights: 'commercial_licensed' | 'evaluation_only' | 'revoked'; staleAfterSeconds?: number;
  /** Scheduled cadence (0032); defaults to daily. Only public_disclosure sources are scheduled. */
  syncIntervalSeconds?: number;
};
export const OPERATOR_IMPORT_SOURCE: LibrarySourceInput = {
  id: 'operator_import', kind: 'operator_import', market: null, displayName: '运营批量补录',
  authorizationBasis: 'Operator attests a licence or public-disclosure basis per batch; rights stay evaluation_only until recorded.',
  termsUrl: null, usageRights: 'evaluation_only',
};
export async function registerLibrarySource(pool: Pool, input: LibrarySourceInput) {
  await transaction(pool, async client => {
    await client.query("SELECT set_config('bondbuddy.library_reason','source_registered',true), set_config('bondbuddy.library_actor','system',true)");
    await client.query(`INSERT INTO bb_library_sources(id,kind,display_name,market,authorization_basis,terms_url,terms_checked_at,usage_rights,stale_after_seconds,sync_interval_seconds)
      VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $6::text IS NULL THEN NULL ELSE now() END,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
    [input.id, input.kind, input.displayName, input.market, input.authorizationBasis, input.termsUrl ?? null, input.usageRights, input.staleAfterSeconds ?? 172800, input.syncIntervalSeconds ?? 86400]);
  });
}

async function nextRelease(client: PoolClient, action: string, reason: string, actor: string, entries: (previous: string, current: string) => Promise<void>) {
  const active = (await client.query('SELECT * FROM bb_library_index_releases WHERE active FOR UPDATE')).rows[0];
  const id = uid();
  await client.query('UPDATE bb_library_index_releases SET active=false WHERE id=$1', [active.id]);
  await client.query(`INSERT INTO bb_library_index_releases(id,release_no,previous_release_id,action,reason,actor,active)
    VALUES($1,$2,$3,$4,$5,$6,true)`, [id, Number(active.release_no) + 1, active.id, action, reason, actor]);
  await entries(active.id, id);
  return { id, releaseNo: Number(active.release_no) + 1, previous: active.id as string };
}

async function copyEntries(client: PoolClient, from: string, to: string, excludeDocumentIds: string[]) {
  await client.query(`INSERT INTO bb_library_index_entries SELECT $2::text AS release_id, document_id, document_version_id, profile_id, set_key, market, offering, instrument,
    document_stage, taxonomy_version, fiscal_year, disclosed_at, review_quality, applicable_scopes, chapter_mapping_versions
    FROM bb_library_index_entries WHERE release_id=$1 AND NOT (document_id = ANY($3::text[]))`, [from, to, excludeDocumentIds]);
}

async function setVersionState(client: PoolClient, versionId: string, state: string, reason: string, actor: string) {
  await client.query('UPDATE bb_library_document_versions SET state=$2,state_reason=$3,state_actor=$4,state_changed_at=clock_timestamp() WHERE id=$1', [versionId, state, reason, actor]);
}
async function setProfileState(client: PoolClient, profileId: string, state: string, reason: string, actor: string) {
  await client.query('UPDATE bb_library_profiles SET state=$2,state_reason=$3,state_actor=$4,state_changed_at=clock_timestamp() WHERE id=$1', [profileId, state, reason, actor]);
}

/** Rights change. Revocation removes every published version of the source from the index atomically. */
export async function setLibrarySourceRights(pool: Pool, sourceId: string, rights: 'commercial_licensed' | 'evaluation_only' | 'revoked', reason: string, actor: string) {
  reasonOf(reason);
  await transaction(pool, async client => {
    const source = (await client.query('SELECT * FROM bb_library_sources WHERE id=$1 FOR UPDATE', [sourceId])).rows[0];
    if (!source) throw missing();
    if (source.usage_rights === 'revoked' && rights !== 'revoked') throw new Problem(409, 'ALREADY_TERMINAL', 'Revoked source rights need a new source registration');
    await client.query("SELECT set_config('bondbuddy.library_reason',$1,true), set_config('bondbuddy.library_actor',$2,true)", [reason, actor]);
    await client.query('UPDATE bb_library_sources SET usage_rights=$2,updated_at=now() WHERE id=$1', [sourceId, rights]);
    if (rights !== 'revoked') return;
    const affected = (await client.query(`SELECT v.id, v.state, v.document_id FROM bb_library_document_versions v JOIN bb_library_documents d ON d.id=v.document_id
      WHERE d.source_id=$1 AND v.state NOT IN ('withdrawn','license_revoked') FOR UPDATE OF v`, [sourceId])).rows;
    await nextRelease(client, 'license_revoke', reason, actor, async (previous, current) => {
      // The whole source leaves the new release; its superseded/rolled back rows can never come back either.
      const all = (await client.query('SELECT id FROM bb_library_documents WHERE source_id=$1', [sourceId])).rows.map(r => r.id as string);
      await copyEntries(client, previous, current, all);
    });
    for (const v of affected) {
      await setVersionState(client, v.id, 'license_revoked', reason, actor);
      await client.query(`UPDATE bb_library_profiles SET state='withdrawn',state_reason=$2,state_actor=$3,state_changed_at=clock_timestamp()
        WHERE document_version_id=$1 AND state IN ('pending_review','published','superseded','rolled_back')`, [v.id, reason, actor]);
    }
    await client.query("UPDATE bb_library_review_items SET state='superseded',decided_by=$2,decision_reason=$3,decided_at=now() WHERE state='open' AND document_version_id = ANY($1::text[])",
      [affected.map(v => v.id), actor, reason]);
  });
  invalidateLibraryCache();
}

// ---------------------------------------------------------------- jobs (#17 bb_jobs lease model, #79 rows)
export type LibraryLease = {
  jobId: string; subtype: 'library_sync' | 'library_record'; sourceId: string; versionId: string | null; traceId: string; token: string;
  attempts: number; maxAttempts: number; checkpoint: Record<string, any>;
};
const leaseOf = (job: any, token: string): LibraryLease => ({ jobId: job.id, subtype: job.subtype, sourceId: job.library_source_id, versionId: job.library_version_id,
  traceId: job.trace_id, token, attempts: job.attempts, maxAttempts: job.max_attempts, checkpoint: job.checkpoint ?? {} });

async function jobEvent(client: PoolClient, job: any, type: string, state: string, stage: string | null, extra: Record<string, unknown> = {}) {
  await client.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'library_job',$3,$4,$5)",
    [uid(), LIBRARY_OWNER, job.id, type, { job_id: job.id, subtype: job.subtype, source_id: job.library_source_id, version_id: job.library_version_id, state, stage, attempts: job.attempts, ...extra }]);
  await emitInternal(client, internalEvent({ kind: 'job.state_changed', owner: LIBRARY_OWNER, jobId: job.id, traceId: job.trace_id, jobKind: 'library',
    status: state as any, stage: stage && safeReason.test(stage) ? stage : null }));
}
async function jobError(client: PoolClient, job: any, code: LibraryErrorCode, stage: string | null, recovery: 'retry_scheduled' | 'terminal') {
  const id = uid();
  await client.query(`INSERT INTO bb_observability_errors(id,owner_user_id,job_id,trace_id,code,category,stage,retry_count,safe_message_code,recovery_status)
    VALUES($1,$2,$3,$4,$5,'tool',$6,$7,$8,$9)`, [id, LIBRARY_OWNER, job.id, job.trace_id, PUBLIC_CODE[code], stage, job.attempts, code.toLowerCase(), recovery]);
  await emitInternal(client, internalEvent({ kind: 'error.recorded', owner: LIBRARY_OWNER, jobId: job.id, traceId: job.trace_id, jobKind: 'library', stage,
    error: { error_id: id, code: PUBLIC_CODE[code], category: 'tool', retryable: recovery === 'retry_scheduled' } }));
}

/** Idempotent: while a sync for the source is queued or running, a second trigger returns it. */
export async function enqueueLibrarySync(pool: Pool, sourceId: string, options: { checkpoint?: Record<string, unknown>; traceId?: string; maxAttempts?: number } = {}) {
  return transaction(pool, async client => {
    const source = (await client.query('SELECT enabled FROM bb_library_sources WHERE id=$1', [sourceId])).rows[0];
    if (!source) throw missing();
    if (!source.enabled) throw new Problem(409, 'CAPABILITY_NOT_READY', 'Source is disabled');
    const inserted = await client.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,checkpoint,trace_id,max_attempts,library_source_id)
      VALUES($1,$2,NULL,'library','library_sync','queued','queued',$3,$4,$5,$6)
      ON CONFLICT (library_source_id) WHERE job_type='library' AND subtype='library_sync' AND state IN ('queued','running') DO NOTHING RETURNING *`,
    [uid(), LIBRARY_OWNER, options.checkpoint ?? {}, options.traceId ?? uid(), options.maxAttempts ?? DEFAULT_LIBRARY_MAX_ATTEMPTS, sourceId]);
    if (inserted.rows[0]) { await jobEvent(client, inserted.rows[0], 'library.job_enqueued', 'queued', 'queued'); return { jobId: inserted.rows[0].id as string, created: true }; }
    const existing = await client.query("SELECT id FROM bb_jobs WHERE job_type='library' AND subtype='library_sync' AND library_source_id=$1 AND state IN ('queued','running')", [sourceId]);
    return { jobId: existing.rows[0].id as string, created: false };
  });
}

/** Operator per-record re-run: re-parses and re-classifies one version through the same pipeline stages. */
export async function enqueueLibraryRecordRerun(pool: Pool, versionId: string, actor: string, reason = 'operator_rerun') {
  reasonOf(reason);
  const outcome = await transaction(pool, async client => {
    const v = (await client.query(`SELECT v.*, d.source_id FROM bb_library_document_versions v JOIN bb_library_documents d ON d.id=v.document_id WHERE v.id=$1 FOR UPDATE OF v`, [versionId])).rows[0];
    if (!v) throw missing();
    if (!['failed', 'rejected', 'pending_review', 'pending_classify', 'pending_parse'].includes(v.state)) throw new Problem(409, 'ALREADY_TERMINAL', `A ${v.state} version is not re-run; ingest a new version instead`);
    if (v.state !== 'pending_parse') await setVersionState(client, versionId, 'pending_parse', reason, actor);
    await client.query("UPDATE bb_library_review_items SET state='superseded',decided_by=$2,decision_reason=$3,decided_at=now() WHERE state='open' AND document_version_id=$1", [versionId, actor, reason]);
    const inserted = await client.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,trace_id,max_attempts,library_source_id,library_version_id)
      VALUES($1,$2,NULL,'library','library_record','queued','queued',$3,$4,$5,$6)
      ON CONFLICT (library_version_id) WHERE job_type='library' AND subtype='library_record' AND state IN ('queued','running') DO NOTHING RETURNING *`,
    [uid(), LIBRARY_OWNER, uid(), DEFAULT_LIBRARY_MAX_ATTEMPTS, v.source_id, versionId]);
    if (inserted.rows[0]) { await jobEvent(client, inserted.rows[0], 'library.job_enqueued', 'queued', 'queued', { reason }); return { jobId: inserted.rows[0].id as string, created: true }; }
    const existing = await client.query("SELECT id FROM bb_jobs WHERE job_type='library' AND subtype='library_record' AND library_version_id=$1 AND state IN ('queued','running')", [versionId]);
    return { jobId: existing.rows[0].id as string, created: false };
  });
  invalidateLibraryCache();
  return outcome;
}

export async function claimLibraryJob(pool: Pool, leaseSeconds = 60): Promise<LibraryLease | null> {
  for (let scanned = 0; scanned < 20; scanned++) {
    const outcome = await transaction(pool, async client => {
      const job = (await client.query(`SELECT * FROM bb_jobs WHERE job_type='library' AND (state='queued' OR (state='running' AND lease_until<now()))
        ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
      if (!job) return { done: true as const, lease: null };
      if (job.attempts >= job.max_attempts) {
        await client.query("UPDATE bb_jobs SET state='failed',error_code='LIBRARY_ATTEMPTS_EXHAUSTED',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1", [job.id]);
        await jobError(client, job, 'LIBRARY_ATTEMPTS_EXHAUSTED', job.stage, 'terminal');
        await jobEvent(client, job, 'library.job_failed', 'failed', job.stage, { error_code: 'LIBRARY_ATTEMPTS_EXHAUSTED' });
        if (job.subtype === 'library_sync') await markSourceFailure(client, job.library_source_id, 'LIBRARY_ATTEMPTS_EXHAUSTED', job.id);
        return { done: false as const, lease: null };
      }
      const token = uid();
      const updated = (await client.query(`UPDATE bb_jobs SET state='running',stage=CASE WHEN stage='queued' THEN 'claimed' ELSE stage END,lease_token=$2,
        lease_until=now()+($3::integer * interval '1 second'),attempts=attempts+1,updated_at=now() WHERE id=$1 RETURNING *`, [job.id, token, leaseSeconds])).rows[0];
      if (updated.subtype === 'library_sync') await client.query('UPDATE bb_library_sources SET last_attempt_at=now() WHERE id=$1', [updated.library_source_id]);
      await jobEvent(client, updated, 'library.job_claimed', 'running', updated.stage, { reason: job.state === 'running' ? 'lease_recovered' : 'claimed' });
      return { done: true as const, lease: leaseOf(updated, token) };
    });
    if (outcome.done) return outcome.lease;
  }
  return null;
}

async function lockedJob(client: PoolClient, lease: LibraryLease) {
  const job = (await client.query("SELECT * FROM bb_jobs WHERE id=$1 AND job_type='library' FOR UPDATE", [lease.jobId])).rows[0];
  if (!job || job.lease_token !== lease.token || job.state !== 'running' || new Date(job.lease_until).getTime() <= Date.now())
    throw new Problem(409, 'ALREADY_TERMINAL', 'Lease is no longer active');
  return job;
}
export async function renewLibraryJob(pool: Pool, lease: LibraryLease, leaseSeconds = 60) {
  await transaction(pool, async client => { await lockedJob(client, lease); await client.query("UPDATE bb_jobs SET lease_until=now()+($2::integer * interval '1 second'),updated_at=now() WHERE id=$1", [lease.jobId, leaseSeconds]); });
}
/** Durable checkpoint merge; a later attempt resumes from here instead of redoing completed items. */
export async function checkpointLibraryJob(pool: Pool, lease: LibraryLease, stage: string, patch: Record<string, unknown>) {
  await transaction(pool, async client => {
    await lockedJob(client, lease);
    const updated = (await client.query('UPDATE bb_jobs SET stage=$2,checkpoint=checkpoint || $3::jsonb,updated_at=now() WHERE id=$1 RETURNING checkpoint', [lease.jobId, stage, JSON.stringify(patch)])).rows[0];
    lease.checkpoint = updated.checkpoint;
  });
}

/** Terminal or partial sync: counts toward consecutive_failures and raises a deduplicated #79 library_sync_failed alert. */
async function recordSourceSyncFailure(client: PoolClient, sourceId: string, code: LibraryErrorCode) {
  const row = (await client.query('UPDATE bb_library_sources SET consecutive_failures=consecutive_failures+1 WHERE id=$1 RETURNING consecutive_failures', [sourceId])).rows[0];
  await raiseAlert(client, { kind: 'library_sync_failed', severity: 'critical', scope: sourceId,
    detail: { source_id: sourceId, error_code: code.toLowerCase(), consecutive_failures: Number(row?.consecutive_failures ?? 0) } });
}
async function markSourceFailure(client: PoolClient, sourceId: string, code: LibraryErrorCode, jobId: string) {
  await client.query('UPDATE bb_library_sources SET last_error_code=$2,updated_at=now() WHERE id=$1', [sourceId, code]);
  await client.query("UPDATE bb_library_sync_runs SET state='failed',finished_at=now() WHERE job_id=$1 AND state='running'", [jobId]);
  await recordSourceSyncFailure(client, sourceId, code);
}

export async function succeedLibraryJob(pool: Pool, lease: LibraryLease, result: Record<string, unknown>, sync?: { syncRunId: string; cursorAfter: Record<string, unknown>; partial: boolean }) {
  await transaction(pool, async client => {
    const job = await lockedJob(client, lease);
    const updated = (await client.query("UPDATE bb_jobs SET state='succeeded',stage='succeeded',result=$2,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *", [job.id, result])).rows[0];
    if (sync) {
      // Cursor and last-success advance only in the same transaction that closes the job.
      await client.query("UPDATE bb_library_sync_runs SET state=$2,cursor_after=$3,finished_at=now() WHERE id=$1", [sync.syncRunId, sync.partial ? 'partial' : 'succeeded', sync.cursorAfter]);
      await client.query(`UPDATE bb_library_sources SET cursor=$2, last_success_at=CASE WHEN $3 THEN last_success_at ELSE now() END,
        last_error_code=CASE WHEN $3 THEN 'LIBRARY_FETCH_FAILED' ELSE NULL END, consecutive_failures=CASE WHEN $3 THEN consecutive_failures ELSE 0 END,
        updated_at=now() WHERE id=$1`, [lease.sourceId, sync.cursorAfter, sync.partial]);
      if (sync.partial) await recordSourceSyncFailure(client, lease.sourceId, 'LIBRARY_FETCH_FAILED');
    }
    await jobEvent(client, updated, 'library.job_succeeded', 'succeeded', 'succeeded', { partial: sync?.partial ?? false });
  });
  invalidateLibraryCache();
}

export async function failLibraryJob(pool: Pool, lease: LibraryLease, code: LibraryErrorCode, retryable: boolean) {
  if (!LIBRARY_ERROR_CODES.includes(code)) throw new Error('Invalid library error code');
  return transaction(pool, async client => {
    const job = await lockedJob(client, lease);
    if (retryable && job.attempts < job.max_attempts) {
      const updated = (await client.query("UPDATE bb_jobs SET state='queued',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *", [job.id])).rows[0];
      await jobError(client, updated, code, job.stage, 'retry_scheduled');
      await jobEvent(client, updated, 'library.job_retry_scheduled', 'queued', job.stage, { error_code: code });
      if (job.subtype === 'library_sync') await client.query('UPDATE bb_library_sources SET last_error_code=$2,updated_at=now() WHERE id=$1', [job.library_source_id, code]);
      return 'retry_scheduled' as const;
    }
    const updated = (await client.query("UPDATE bb_jobs SET state='failed',error_code=$2,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *", [job.id, code])).rows[0];
    await jobError(client, updated, code, job.stage, 'terminal');
    await jobEvent(client, updated, 'library.job_failed', 'failed', job.stage, { error_code: code });
    if (job.subtype === 'library_sync') await markSourceFailure(client, job.library_source_id, code, job.id);
    return 'failed' as const;
  });
}

// ---------------------------------------------------------------- sync logs
export async function startSyncRun(pool: Pool, lease: LibraryLease, mode: 'scheduled' | 'import' | 'record_rerun') {
  const source = (await pool.query('SELECT cursor FROM bb_library_sources WHERE id=$1', [lease.sourceId])).rows[0];
  const inserted = await pool.query(`INSERT INTO bb_library_sync_runs(id,source_id,job_id,mode,cursor_before) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT (job_id) DO UPDATE SET state='running' RETURNING id, cursor_before`, [uid(), lease.sourceId, lease.jobId, mode, source?.cursor ?? {}]);
  return { syncRunId: inserted.rows[0].id as string, cursorBefore: inserted.rows[0].cursor_before as Record<string, unknown> };
}
/** attempts = fetch tries for this item in this call; a resumed run adds to the stored count. */
export async function recordSyncItem(pool: Pool, syncRunId: string, itemKey: string, outcome: string, extra: { errorCode?: LibraryErrorCode; versionId?: string | null; attempts?: number } = {}) {
  await pool.query(`INSERT INTO bb_library_sync_items(sync_run_id,item_key,outcome,error_code,document_version_id,attempts) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT (sync_run_id,item_key) DO UPDATE SET outcome=EXCLUDED.outcome,error_code=EXCLUDED.error_code,
      document_version_id=COALESCE(EXCLUDED.document_version_id,bb_library_sync_items.document_version_id),attempts=bb_library_sync_items.attempts+EXCLUDED.attempts,updated_at=now()`,
  [syncRunId, itemKey.slice(0, 256), outcome, extra.errorCode ?? null, extra.versionId ?? null, Math.max(1, extra.attempts ?? 1)]);
}
export async function syncRunSummary(pool: Pool, syncRunId: string) {
  const run = (await pool.query('SELECT * FROM bb_library_sync_runs WHERE id=$1', [syncRunId])).rows[0];
  const counts = (await pool.query('SELECT outcome, count(*)::int AS n, sum(attempts-1)::int AS retries FROM bb_library_sync_items WHERE sync_run_id=$1 GROUP BY outcome', [syncRunId])).rows;
  return { sync_run_id: syncRunId, source_id: run.source_id, mode: run.mode, state: run.state, started_at: date(run.started_at), finished_at: run.finished_at ? date(run.finished_at) : null,
    outcomes: Object.fromEntries(counts.map(r => [r.outcome, r.n])), item_retries: counts.reduce((sum, r) => sum + (r.retries ?? 0), 0) };
}

// ---------------------------------------------------------------- ingestion
export type IngestInput = {
  sourceId: string; externalKey: string; issuerKey: string; issuerName: string; title: string;
  sourceRevision: string; sourceRevisionRank: number; bytes: Buffer; mediaType: string; sourceUrl?: string | null;
  disclosedAt?: string | null; market?: 'sse' | 'szse' | 'nafmii' | null; jobId?: string | null;
};
export type IngestOutcome = { outcome: 'new_document' | 'new_version' | 'unchanged' | 'stale_ignored'; versionId: string; documentId: string };

/**
 * Stores bytes content-addressed in private Blob (library/ prefix), then records the version in one
 * transaction under the document row lock. Same hash = unchanged. A lower source revision than an
 * already recorded one is kept for audit but immediately superseded, so a late job cannot win.
 */
export async function ingestLibraryVersion(pool: Pool, blobs: PrivateBlobs, input: IngestInput): Promise<IngestOutcome> {
  if (!input.bytes.length) throw new Error('LIBRARY_BYTES_INVALID');
  const sha256 = digest(input.bytes);
  const documentKey = digest(`${input.sourceId}\u0000${input.externalKey}`).slice(0, 32);
  const blobKey = `library/${input.sourceId}/${documentKey}/${sha256}`;
  if (!(await blobs.exists(blobKey))) await blobs.put(blobKey, input.bytes, input.mediaType);
  const stored = await blobs.get(blobKey);
  if (digest(stored) !== sha256) throw new Error('LIBRARY_BYTES_INVALID');
  const result = await transaction(pool, async client => {
    const inserted = await client.query(`INSERT INTO bb_library_documents(id,source_id,external_key,issuer_key,issuer_name,title) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT (source_id,external_key) DO NOTHING RETURNING id`, [uid(), input.sourceId, input.externalKey, input.issuerKey, input.issuerName, input.title]);
    const doc = (await client.query('SELECT * FROM bb_library_documents WHERE source_id=$1 AND external_key=$2 FOR UPDATE', [input.sourceId, input.externalKey])).rows[0];
    const isNewDocument = inserted.rowCount === 1;
    const same = (await client.query('SELECT id FROM bb_library_document_versions WHERE document_id=$1 AND sha256=$2', [doc.id, sha256])).rows[0];
    if (same) return { outcome: 'unchanged' as const, versionId: same.id as string, documentId: doc.id as string };
    const latest = (await client.query('SELECT max(version) AS v, max(source_revision_rank) AS rank FROM bb_library_document_versions WHERE document_id=$1', [doc.id])).rows[0];
    const versionId = uid();
    await client.query(`INSERT INTO bb_library_document_versions(id,document_id,version,source_revision,source_revision_rank,sha256,byte_size,media_type,blob_key,source_url,disclosed_at,market,state_reason,state_actor,fetched_by_job_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ingested','pipeline',$13)`,
    [versionId, doc.id, Number(latest.v ?? 0) + 1, input.sourceRevision, input.sourceRevisionRank, sha256, input.bytes.length, input.mediaType, blobKey,
      input.sourceUrl ?? null, input.disclosedAt ?? null, input.market ?? null, input.jobId ?? null]);
    if (latest.rank !== null && Number(latest.rank) > input.sourceRevisionRank) {
      await setVersionState(client, versionId, 'superseded', 'stale_late_revision', 'pipeline');
      return { outcome: 'stale_ignored' as const, versionId, documentId: doc.id as string };
    }
    // Older not-yet-published revisions of the same document leave the queue.
    const older = (await client.query(`SELECT id FROM bb_library_document_versions WHERE document_id=$1 AND id<>$2 AND state IN ('pending_parse','pending_classify','pending_review','failed','rejected') FOR UPDATE`, [doc.id, versionId])).rows;
    for (const o of older) {
      await setVersionState(client, o.id, 'superseded', 'newer_revision_ingested', 'pipeline');
      await client.query(`UPDATE bb_library_profiles SET state='superseded',state_reason='newer_revision_ingested',state_actor='pipeline',state_changed_at=clock_timestamp() WHERE document_version_id=$1 AND state='pending_review'`, [o.id]);
      await client.query("UPDATE bb_library_review_items SET state='superseded',decided_by='pipeline',decision_reason='newer_revision_ingested',decided_at=now() WHERE state='open' AND document_version_id=$1", [o.id]);
    }
    return { outcome: isNewDocument ? 'new_document' as const : 'new_version' as const, versionId, documentId: doc.id as string };
  });
  return result;
}

export async function readLibraryVersionBytes(pool: Pool, blobs: PrivateBlobs, versionId: string) {
  const v = (await pool.query('SELECT blob_key, sha256, media_type FROM bb_library_document_versions WHERE id=$1', [versionId])).rows[0];
  if (!v) throw missing();
  const bytes = await blobs.get(v.blob_key);
  if (digest(bytes) !== v.sha256.trim()) throw new Error('LIBRARY_BYTES_INVALID');
  return { bytes, mediaType: v.media_type as string, sha256: v.sha256.trim() as string };
}

export async function markLibraryVersionParsed(pool: Pool, versionId: string, summary: Record<string, unknown>) {
  await transaction(pool, async client => {
    const v = (await client.query('SELECT state FROM bb_library_document_versions WHERE id=$1 FOR UPDATE', [versionId])).rows[0];
    if (!v) throw missing();
    if (v.state !== 'pending_parse') return; // already advanced by an earlier attempt, or superseded meanwhile
    await client.query('UPDATE bb_library_document_versions SET parse_summary=$2 WHERE id=$1', [versionId, summary]);
    await setVersionState(client, versionId, 'pending_classify', 'parsed', 'pipeline');
  });
}
export async function markLibraryVersionFailed(pool: Pool, versionId: string, code: LibraryErrorCode) {
  await transaction(pool, async client => {
    const v = (await client.query('SELECT state FROM bb_library_document_versions WHERE id=$1 FOR UPDATE', [versionId])).rows[0];
    if (v && ['pending_parse', 'pending_classify'].includes(v.state)) await setVersionState(client, versionId, 'failed', code.toLowerCase(), 'pipeline');
  });
}

// ---------------------------------------------------------------- profiles and review
export type ProfileLine = { code: string; label: string; rank: number; revenue: string; evidence: string[] };
export type RevenueBasis = 'operating_revenue' | 'main_business_revenue';
export type AmountUnit = 'yuan' | 'thousand_yuan' | 'ten_thousand_yuan' | 'million_yuan' | 'hundred_million_yuan';
/** Comparability facts are optional on a draft (a classifier may not know them) but required before publish. */
export type ProfileDraft = { fiscalYear: number | null; taxonomyVersion: string; accountingScope: 'consolidated' | 'parent' | 'mixed' | 'unknown'; top3: ProfileLine[] | null;
  revenueBasis?: RevenueBasis | null; currency?: string | null; unit?: AmountUnit | null };
export type Classification = { market: 'sse' | 'szse' | 'nafmii' | null; offering: string | null; instrument: string | null; documentStage: 'registration' | 'issuance' | null };

// jsonb does not keep key order, so compare stored and new profile lines with sorted keys.
const canonicalJson = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(value);

function profileKeys(draft: ProfileDraft) {
  const lines = draft.top3;
  const valid = lines && lines.length === 3 && new Set(lines.map(l => l.code)).size === 3 && lines.every(l => l.evidence.length > 0)
    && [...lines].map(l => l.rank).sort().join(',') === '1,2,3' && draft.fiscalYear !== null && draft.accountingScope === 'consolidated';
  if (!valid) return { complete: false, setKey: null, rankingKey: null, top3: lines ?? null };
  const ordered = [...lines!].sort((a, b) => a.rank - b.rank);
  return { complete: true, setKey: librarySetKey(ordered.map(l => l.code)), rankingKey: JSON.stringify([draft.fiscalYear, draft.taxonomyVersion, ordered.map(l => l.code)]), top3: ordered };
}

/**
 * Appends a profile version to one document version. The same ranking (fiscal year, taxonomy and ordered
 * codes) reuses the latest profile; any change - including only the third business swapping rank -
 * appends a new version and supersedes the pending one.
 */
async function appendProfile(client: PoolClient, versionId: string, draft: ProfileDraft, origin: 'classifier' | 'operator_correction', actor: string) {
  const keys = profileKeys(draft);
  const latest = (await client.query('SELECT * FROM bb_library_profiles WHERE document_version_id=$1 ORDER BY profile_version DESC LIMIT 1', [versionId])).rows[0];
  if (latest && latest.state === 'pending_review' && keys.complete && latest.ranking_key === keys.rankingKey && latest.origin === origin
      && canonicalJson(latest.top3) === canonicalJson(keys.top3) && latest.revenue_basis === (draft.revenueBasis ?? null)
      && latest.currency === (draft.currency ?? null) && latest.unit === (draft.unit ?? null)) return { profileId: latest.id as string, created: false };
  if (latest?.state === 'pending_review') await setProfileState(client, latest.id, 'superseded', origin === 'operator_correction' ? 'operator_correction' : 'reclassified', actor);
  const id = uid();
  await client.query(`INSERT INTO bb_library_profiles(id,document_version_id,profile_version,fiscal_year,taxonomy_version,accounting_scope,top3,set_key,ranking_key,completeness,origin,state_reason,state_actor,revenue_basis,currency,unit)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
  [id, versionId, Number(latest?.profile_version ?? 0) + 1, draft.fiscalYear, draft.taxonomyVersion, keys.complete ? 'consolidated' : draft.accountingScope,
    keys.top3 ? JSON.stringify(keys.top3) : null, keys.setKey, keys.rankingKey, keys.complete ? 'complete' : 'incomplete', origin,
    latest && latest.ranking_key !== keys.rankingKey ? 'ranking_changed' : 'profile_created', actor, draft.revenueBasis ?? null, draft.currency ?? null, draft.unit ?? null]);
  return { profileId: id, created: true };
}

async function openReview(client: PoolClient, versionId: string, profileId: string, reason: string, actor: string) {
  await client.query("UPDATE bb_library_review_items SET state='superseded',decided_by=$2,decision_reason='replaced_by_new_profile',decided_at=now() WHERE state='open' AND document_version_id=$1", [versionId, actor]);
  await client.query('INSERT INTO bb_library_review_items(id,document_version_id,profile_id,opened_reason) VALUES($1,$2,$3,$4)', [uid(), versionId, profileId, reason]);
}

/** Pipeline classify stage: pending_classify -> pending_review with a profile and an open review item. Nothing is published here. */
export async function classifyLibraryVersion(pool: Pool, versionId: string, classification: Classification, draft: ProfileDraft) {
  return transaction(pool, async client => {
    const v = (await client.query('SELECT state FROM bb_library_document_versions WHERE id=$1 FOR UPDATE', [versionId])).rows[0];
    if (!v) throw missing();
    if (v.state === 'pending_review') {
      const existing = (await client.query("SELECT profile_id FROM bb_library_review_items WHERE document_version_id=$1 AND state='open'", [versionId])).rows[0];
      return { profileId: existing?.profile_id as string, created: false };
    }
    if (v.state !== 'pending_classify') return { profileId: null, created: false };
    await client.query('UPDATE bb_library_document_versions SET market=COALESCE($2,market),offering=$3,instrument=$4,document_stage=$5 WHERE id=$1',
      [versionId, classification.market, classification.offering, classification.instrument, classification.documentStage]);
    const profile = await appendProfile(client, versionId, draft, 'classifier', 'pipeline');
    await setVersionState(client, versionId, 'pending_review', 'classified', 'pipeline');
    await openReview(client, versionId, profile.profileId, profileKeys(draft).complete ? 'classified' : 'profile_incomplete', 'pipeline');
    return profile;
  });
}

/** Test/ops helper: reclassification of a pending version (e.g. classifier upgrade). Ranking change => new profile. */
export async function reclassifyPendingProfile(pool: Pool, versionId: string, draft: ProfileDraft, actor = 'pipeline') {
  return transaction(pool, async client => {
    const v = (await client.query('SELECT state FROM bb_library_document_versions WHERE id=$1 FOR UPDATE', [versionId])).rows[0];
    if (v?.state !== 'pending_review') throw new Problem(409, 'ALREADY_TERMINAL', 'Only pending versions are reclassified');
    const profile = await appendProfile(client, versionId, draft, 'classifier', actor);
    if (profile.created) await openReview(client, versionId, profile.profileId, 'reclassified', actor);
    return profile;
  });
}

const scopeKey = (s: any) => `${s.market}|${s.offering}|${s.instrument}|${s.document_stage}|${s.rule_version}`;

/** Operator review action. approve/withdraw/rollback each write body, profile and index release in one transaction. */
export async function reviewLibraryVersion(pool: Pool, versionId: string, action: LibraryReviewActionRequest, actor: string) {
  const reason = reasonOf(action.reason);
  const out = await transaction(pool, async client => {
    const v = (await client.query(`SELECT v.*, d.source_id FROM bb_library_document_versions v JOIN bb_library_documents d ON d.id=v.document_id WHERE v.id=$1 FOR UPDATE OF v`, [versionId])).rows[0];
    if (!v) throw missing();
    // Serialize every publish/withdraw on the document row so a late approval of an older version cannot race a newer one.
    await client.query('SELECT 1 FROM bb_library_documents WHERE id=$1 FOR UPDATE', [v.document_id]);
    const profile = (await client.query('SELECT * FROM bb_library_profiles WHERE document_version_id=$1 ORDER BY profile_version DESC LIMIT 1', [versionId])).rows[0];
    if (action.action === 'approve') {
      if (v.state !== 'pending_review' || profile?.state !== 'pending_review') throw new Problem(409, 'ALREADY_TERMINAL', 'Only a pending review can be approved');
      if (profile.completeness !== 'complete') throw new Problem(422, 'VALIDATION_FAILED', 'Profile lacks an evidenced consolidated top-three; correct it first');
      if (!profile.revenue_basis || !profile.currency || !profile.unit) throw new Problem(422, 'VALIDATION_FAILED', 'Profile lacks reviewed revenue basis, currency and unit; correct it first');
      if (!v.market || !v.offering || !v.instrument || !v.document_stage) throw new Problem(422, 'VALIDATION_FAILED', 'Market, offering, instrument and stage must be classified');
      const newer = (await client.query(`SELECT 1 FROM bb_library_document_versions WHERE document_id=$1 AND id<>$2 AND source_revision_rank>$3
        AND state IN ('published','pending_parse','pending_classify','pending_review')`, [v.document_id, versionId, v.source_revision_rank])).rows[0];
      if (newer) {
        await setVersionState(client, versionId, 'superseded', 'stale_late_revision', actor);
        await setProfileState(client, profile.id, 'superseded', 'stale_late_revision', actor);
        await client.query("UPDATE bb_library_review_items SET state='superseded',decided_by=$2,decision_reason='stale_late_revision',decided_at=now() WHERE state='open' AND document_version_id=$1", [versionId, actor]);
        return { status: 'stale_superseded' as const };
      }
      const scopes = (action.applicable_scopes ?? [{ market: v.market, offering: v.offering, instrument: v.instrument, document_stage: v.document_stage, rule_version: 'unspecified' }]);
      if (new Set(scopes.map(scopeKey)).size !== scopes.length) throw new Problem(422, 'VALIDATION_FAILED', 'Duplicate applicable scope');
      const previousPublished = (await client.query("SELECT id FROM bb_library_document_versions WHERE document_id=$1 AND state='published' AND id<>$2", [v.document_id, versionId])).rows;
      const release = await nextRelease(client, previousPublished.length ? 'supersede' : 'publish', reason, actor, async (previous, active) => {
        await copyEntries(client, previous, active, [v.document_id]);
        await client.query(`INSERT INTO bb_library_index_entries(release_id,document_id,document_version_id,profile_id,set_key,market,offering,instrument,document_stage,taxonomy_version,fiscal_year,disclosed_at,review_quality,applicable_scopes)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [active, v.document_id, versionId, profile.id, profile.set_key, v.market, v.offering, v.instrument, v.document_stage, profile.taxonomy_version, profile.fiscal_year,
          v.disclosed_at, action.review_quality ?? 60, JSON.stringify(scopes)]);
      });
      for (const p of previousPublished) {
        await setVersionState(client, p.id, 'superseded', 'newer_version_published', actor);
        await client.query("UPDATE bb_library_profiles SET state='superseded',state_reason='newer_version_published',state_actor=$2,state_changed_at=clock_timestamp() WHERE document_version_id=$1 AND state='published'", [p.id, actor]);
      }
      await setVersionState(client, versionId, 'published', reason, actor);
      // The approving review item is the attestation: same id, reviewer and time as on the profile version.
      const review = (await client.query("UPDATE bb_library_review_items SET state='approved',decided_by=$2,decision_reason=$3,decided_at=clock_timestamp() WHERE state='open' AND document_version_id=$1 RETURNING id, decided_at",
        [versionId, actor, reason])).rows[0];
      if (!review) throw new Problem(409, 'ALREADY_TERMINAL', 'No open review item to approve');
      await client.query(`UPDATE bb_library_profiles SET state='published',state_reason=$2,state_actor=$3,state_changed_at=clock_timestamp(),
        reviewed_review_id=$4,reviewed_by=$3,reviewed_at=$5 WHERE id=$1`, [profile.id, reason, actor, review.id, review.decided_at]);
      return { status: 'published' as const, release_id: release.id, release_no: release.releaseNo };
    }
    if (action.action === 'reject') {
      if (v.state !== 'pending_review') throw new Problem(409, 'ALREADY_TERMINAL', 'Only a pending review can be rejected');
      await setVersionState(client, versionId, 'rejected', reason, actor);
      if (profile?.state === 'pending_review') await setProfileState(client, profile.id, 'rejected', reason, actor);
      await client.query("UPDATE bb_library_review_items SET state='rejected',decided_by=$2,decision_reason=$3,decided_at=now() WHERE state='open' AND document_version_id=$1", [versionId, actor, reason]);
      return { status: 'rejected' as const };
    }
    if (action.action === 'correct') {
      if (!['pending_review', 'rejected'].includes(v.state) || !action.correction) throw new Problem(409, 'ALREADY_TERMINAL', 'Corrections apply to unpublished versions and need a correction body');
      const c = action.correction;
      await client.query('UPDATE bb_library_document_versions SET market=COALESCE($2,market),offering=COALESCE($3,offering),instrument=COALESCE($4,instrument),document_stage=COALESCE($5,document_stage) WHERE id=$1',
        [versionId, c.market ?? null, c.offering ?? null, c.instrument ?? null, c.document_stage ?? null]);
      if (v.state === 'rejected') await setVersionState(client, versionId, 'pending_review', reason, actor);
      const created = await appendProfile(client, versionId, { fiscalYear: c.fiscal_year, taxonomyVersion: c.taxonomy_version, accountingScope: 'consolidated',
        revenueBasis: c.revenue_basis ?? null, currency: c.currency ?? null, unit: c.unit ?? null, top3: c.top3.map(l => ({ ...l, evidence: [...l.evidence] })) }, 'operator_correction', actor);
      await openReview(client, versionId, created.profileId, 'operator_correction', actor);
      return { status: 'corrected' as const, profile_id: created.profileId };
    }
    if (action.action === 'withdraw') {
      if (['withdrawn', 'license_revoked'].includes(v.state)) throw new Problem(409, 'ALREADY_TERMINAL', 'Version already withdrawn');
      let release: { id: string; releaseNo: number } | null = null;
      if (v.state === 'published') {
        release = await nextRelease(client, 'withdraw', reason, actor, (previous, current) => copyEntries(client, previous, current, [v.document_id]));
      }
      await setVersionState(client, versionId, 'withdrawn', reason, actor);
      await client.query(`UPDATE bb_library_profiles SET state='withdrawn',state_reason=$2,state_actor=$3,state_changed_at=clock_timestamp()
        WHERE document_version_id=$1 AND state IN ('pending_review','published','superseded','rolled_back')`, [versionId, reason, actor]);
      await client.query("UPDATE bb_library_review_items SET state='superseded',decided_by=$2,decision_reason=$3,decided_at=now() WHERE state='open' AND document_version_id=$1", [versionId, actor, reason]);
      return { status: 'withdrawn' as const, release_id: release?.id ?? null, release_no: release?.releaseNo ?? null };
    }
    throw new Problem(422, 'VALIDATION_FAILED', 'Use the release rollback operation');
  });
  invalidateLibraryCache();
  return out;
}

/**
 * Restores an earlier release as a new release. Entries whose version was since withdrawn or revoked,
 * or whose source lost its rights, are left out. Body and profile states follow the restored index.
 */
export async function rollbackLibraryRelease(pool: Pool, targetReleaseId: string, reasonCode: string, actor: string) {
  const reason = reasonOf(reasonCode);
  const out = await transaction(pool, async client => {
    const target = (await client.query('SELECT * FROM bb_library_index_releases WHERE id=$1', [targetReleaseId])).rows[0];
    if (!target) throw missing();
    if (target.active) throw new Problem(409, 'ALREADY_TERMINAL', 'Release is already active');
    const release = await nextRelease(client, 'rollback', reason, actor, async (_previous, active) => {
      await client.query(`INSERT INTO bb_library_index_entries SELECT $2::text, e.document_id, e.document_version_id, e.profile_id, e.set_key, e.market, e.offering, e.instrument,
          e.document_stage, e.taxonomy_version, e.fiscal_year, e.disclosed_at, e.review_quality, e.applicable_scopes, e.chapter_mapping_versions
        FROM bb_library_index_entries e JOIN bb_library_document_versions v ON v.id=e.document_version_id JOIN bb_library_documents d ON d.id=e.document_id
          JOIN bb_library_sources s ON s.id=d.source_id JOIN bb_library_profiles p ON p.id=e.profile_id
        WHERE e.release_id=$1 AND v.state NOT IN ('withdrawn','license_revoked') AND p.state<>'withdrawn' AND s.usage_rights<>'revoked'`, [targetReleaseId, active]);
    });
    const restored = (await client.query('SELECT document_version_id, profile_id FROM bb_library_index_entries WHERE release_id=$1', [release.id])).rows;
    const keepVersions = new Set(restored.map(r => r.document_version_id as string)), keepProfiles = new Set(restored.map(r => r.profile_id as string));
    for (const row of (await client.query("SELECT id FROM bb_library_document_versions WHERE state='published' FOR UPDATE")).rows)
      if (!keepVersions.has(row.id)) await setVersionState(client, row.id, 'rolled_back', reason, actor);
    for (const row of (await client.query("SELECT id FROM bb_library_profiles WHERE state='published' FOR UPDATE")).rows)
      if (!keepProfiles.has(row.id)) await setProfileState(client, row.id, 'rolled_back', reason, actor);
    for (const r of restored) {
      const v = (await client.query('SELECT state FROM bb_library_document_versions WHERE id=$1 FOR UPDATE', [r.document_version_id])).rows[0];
      if (v.state !== 'published') await setVersionState(client, r.document_version_id, 'published', reason, actor);
      const p = (await client.query('SELECT state FROM bb_library_profiles WHERE id=$1 FOR UPDATE', [r.profile_id])).rows[0];
      if (p.state !== 'published') await setProfileState(client, r.profile_id, 'published', reason, actor);
    }
    return { status: 'rolled_back' as const, release_id: release.id, release_no: release.releaseNo, restored_entries: restored.length };
  });
  invalidateLibraryCache();
  return out;
}

// ---------------------------------------------------------------- internal query v1 (#77 contract)
async function recordMiss(pool: Pool, releaseId: string | null, request: LibraryQueryRequest, reason: string) {
  await pool.query(`INSERT INTO bb_library_query_misses(id,index_release_id,market,offering,instrument,document_stage,set_key_hash,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [uid(), releaseId, request.target.market, request.target.offering, request.target.instrument, request.target.document_stage, digest(librarySetKey(request.target.top3_codes)), reason]);
}

/**
 * Trusted task-service query. Returns only versions that are published in the active release, whose
 * profile is published and whose source currently has commercial usage rights. Unreviewed, pending,
 * superseded, withdrawn, rolled back and revoked rows can never appear. Reference bodies, issuer names
 * and revenue values are not part of the response.
 */
export async function queryReferenceLibrary(pool: Pool, request: LibraryQueryRequest): Promise<LibraryQueryResponse> {
  if (!Value.Check(LibraryQueryRequestSchema, request)) throw new Problem(422, 'VALIDATION_FAILED', 'Invalid library query');
  const project = await pool.query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL', [request.audit.owner_user_id, request.audit.project_id]);
  if (!project.rowCount) throw missing();
  let head: any;
  try { head = (await pool.query(`SELECT r.id, r.release_no, (SELECT coalesce(max(updated_at),'epoch') FROM bb_library_sources) AS rights_stamp,
      (SELECT coalesce(max(state_changed_at),'epoch') FROM bb_library_chapter_mapping_versions) AS mapping_stamp FROM bb_library_index_releases r WHERE r.active`)).rows[0]; }
  catch { return { schema_version: request.schema_version, status: 'unavailable', index_release: null, candidates: [], reason: 'library_unavailable' }; }
  const release = { release_id: head.id as string, release_no: Number(head.release_no) };
  if (request.index_release && request.index_release !== release.release_id) {
    return { schema_version: request.schema_version, status: 'index_version_mismatch', index_release: release, candidates: [], reason: 'requested_release_not_active' };
  }
  const setKey = librarySetKey(request.target.top3_codes);
  const v11 = request.schema_version === LIBRARY_QUERY_SCHEMA_VERSION_V1_1;
  const t = request.target;
  const cacheKey = JSON.stringify([request.schema_version, release.release_id, new Date(head.rights_stamp).toISOString(), new Date(head.mapping_stamp).toISOString(), setKey,
    t.taxonomy_version, t.instrument, t.document_stage, ...(v11 ? [t.market, t.offering, t.rule_version] : [])]);
  const cached = queryCache.get(cacheKey);
  let response: LibraryQueryResponse;
  if (cached) response = cached;
  else {
    const rows = (await pool.query(`SELECT e.*, v.version AS document_version, p.profile_version, p.accounting_scope, p.revenue_basis, p.currency, p.unit,
      p.reviewed_review_id, p.reviewed_by, p.reviewed_at, v.state AS v_state, p.state AS p_state, s.usage_rights, s.enabled
      FROM bb_library_index_entries e
      JOIN bb_library_document_versions v ON v.id=e.document_version_id AND v.state='published'
      JOIN bb_library_profiles p ON p.id=e.profile_id AND p.state='published' AND p.completeness='complete'
      JOIN bb_library_documents d ON d.id=e.document_id
      JOIN bb_library_sources s ON s.id=d.source_id AND s.usage_rights='commercial_licensed'
      WHERE e.release_id=$1 AND e.set_key=$2 AND e.taxonomy_version=$3 AND e.instrument=$4 AND e.document_stage=$5
      ORDER BY (e.market=$6 AND e.offering=$7) DESC, e.review_quality DESC, e.disclosed_at DESC NULLS LAST, e.document_id`,
    [release.release_id, setKey, request.target.taxonomy_version, request.target.instrument, request.target.document_stage, request.target.market, request.target.offering])).rows;
    const candidates: LibraryCandidate[] = rows.map(r => ({
      reference_id: r.document_id, document_version_id: r.document_version_id, document_version: r.document_version, profile_id: r.profile_id, profile_version: r.profile_version,
      taxonomy_version: r.taxonomy_version, fiscal_year: r.fiscal_year, market: r.market, offering: r.offering, instrument: r.instrument, document_stage: r.document_stage,
      availability: 'published', readable: true, use_authorized: true, source_validity: 'valid', applicable_scopes: r.applicable_scopes, chapter_mapping_versions: r.chapter_mapping_versions,
      review_quality: r.review_quality, disclosed_at: r.disclosed_at ? new Date(r.disclosed_at).toISOString().slice(0, 10) : null, top3_set_key: r.set_key,
    }));
    response = v11
      ? { schema_version: LIBRARY_QUERY_SCHEMA_VERSION_V1_1, status: candidates.length ? 'candidates' : 'no_match', index_release: release,
        candidates: await withComparability(pool, rows, candidates, t), reason: candidates.length ? null : 'no_published_exact_set' }
      : { schema_version: LIBRARY_QUERY_SCHEMA_VERSION, status: candidates.length ? 'candidates' : 'no_match', index_release: release, candidates, reason: candidates.length ? null : 'no_published_exact_set' };
    queryCache.set(cacheKey, response);
    if (queryCache.size > 500) queryCache.delete(queryCache.keys().next().value!);
  }
  if (response.status === 'no_match') await recordMiss(pool, release.release_id, request, 'no_published_exact_set');
  return response;
}

const mappingOf = (m: any): LibraryChapterMapping => ({
  mapping_version_id: m.id, mapping_key: m.mapping_key, version: m.version, status: 'accepted',
  source: { market: m.source_market, offering: m.source_offering, instrument: m.source_instrument },
  target: { market: m.target_market, offering: m.target_offering, instrument: m.target_instrument },
  document_stage: m.document_stage, rule_version: m.rule_version,
});

/**
 * v1.1 additions. Comparability comes from the published profile version only (never from the request).
 * A chapter mapping is attached only when its source scope is the candidate's market/offering/instrument
 * and its target scope is exactly the requested market/offering/instrument, stage and rule version.
 */
async function withComparability(pool: Pool, rows: any[], candidates: LibraryCandidate[], target: LibraryQueryRequest['target']): Promise<LibraryCandidateV1_1[]> {
  const mappings = candidates.length ? (await pool.query(`SELECT * FROM bb_library_chapter_mapping_versions WHERE state='accepted'
    AND target_market=$1 AND target_offering=$2 AND target_instrument=$3 AND document_stage=$4 AND rule_version=$5 ORDER BY mapping_key, version`,
  [target.market, target.offering, target.instrument, target.document_stage, target.rule_version])).rows : [];
  return candidates.map((c, i) => {
    const r = rows[i];
    const comparable = r.revenue_basis && r.currency && r.unit && r.reviewed_review_id;
    const scoped = mappings.filter(m => m.source_market === c.market && m.source_offering === c.offering && m.source_instrument === c.instrument).map(mappingOf);
    return {
      ...c,
      chapter_mapping_versions: scoped.map(m => m.mapping_version_id),
      comparability: comparable ? {
        accounting_scope: r.accounting_scope, revenue_basis: r.revenue_basis, currency: r.currency, unit: r.unit, fiscal_year: r.fiscal_year,
        attestation: { review_id: r.reviewed_review_id, reviewed_by: r.reviewed_by, reviewed_at: date(r.reviewed_at), profile_id: c.profile_id, profile_version: c.profile_version },
      } : null,
      chapter_mappings: scoped,
    };
  });
}

// ---------------------------------------------------------------- chapter-mapping versions (operator)
/** Records a new accepted mapping version (next version for its key). Mappings never convert a scope implicitly. */
export async function recordChapterMappingVersion(pool: Pool, input: LibraryChapterMappingCreateRequest, actor: string): Promise<LibraryChapterMapping> {
  const reason = reasonOf(input.reason);
  if (input.source.market === input.target.market && input.source.offering === input.target.offering) throw new Problem(422, 'VALIDATION_FAILED', 'A chapter mapping must cross market or offering');
  const out = await transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`library-mapping:${input.mapping_key}`]);
    const next = Number((await client.query('SELECT coalesce(max(version),0)+1 AS n FROM bb_library_chapter_mapping_versions WHERE mapping_key=$1', [input.mapping_key])).rows[0].n);
    const row = (await client.query(`INSERT INTO bb_library_chapter_mapping_versions(id,mapping_key,version,source_market,source_offering,source_instrument,
      target_market,target_offering,target_instrument,document_stage,rule_version,reviewed_by,reason,state_actor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$12) RETURNING *`,
    [uid(), input.mapping_key, next, input.source.market, input.source.offering, input.source.instrument, input.target.market, input.target.offering, input.target.instrument,
      input.document_stage, input.rule_version, actor, reason])).rows[0];
    return mappingOf(row);
  });
  invalidateLibraryCache();
  return out;
}

export async function withdrawChapterMappingVersion(pool: Pool, mappingVersionId: string, reasonCode: string, actor: string) {
  const reason = reasonOf(reasonCode);
  const r = await pool.query(`UPDATE bb_library_chapter_mapping_versions SET state='withdrawn',reason=$2,state_actor=$3,state_changed_at=clock_timestamp()
    WHERE id=$1 AND state='accepted' RETURNING id`, [mappingVersionId, reason, actor]);
  if (!r.rowCount) throw missing();
  invalidateLibraryCache();
  return { mapping_version_id: mappingVersionId, status: 'withdrawn' as const };
}

/** Pins the selected versions for a task. The candidate must be in the stated release and still usable now. */
export async function lockReferenceSelection(pool: Pool, input: { ownerUserId: string; projectId: string; runId?: string | null; documentVersionId: string; profileId: string; indexReleaseId: string }): Promise<LibrarySelectionLock> {
  return transaction(pool, async client => {
    const project = await client.query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL', [input.ownerUserId, input.projectId]);
    if (!project.rowCount) throw missing();
    if (input.runId && !(await client.query('SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND id=$3', [input.ownerUserId, input.projectId, input.runId])).rowCount) throw missing();
    if (input.runId) {
      const existing = (await client.query(`SELECT id, query_schema_version, document_version_id, profile_id, taxonomy_version, index_release_id, locked_at
        FROM bb_library_selection_locks WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3 FOR UPDATE`, [input.ownerUserId, input.projectId, input.runId])).rows[0];
      if (existing) {
        if (existing.document_version_id !== input.documentVersionId || existing.profile_id !== input.profileId || existing.index_release_id !== input.indexReleaseId) {
          throw new Problem(409, 'ALREADY_TERMINAL', 'Run already has a different immutable reference selection');
        }
        return { lock_id: existing.id, query_schema_version: existing.query_schema_version, document_version_id: existing.document_version_id,
          profile_id: existing.profile_id, taxonomy_version: existing.taxonomy_version, index_release_id: existing.index_release_id,
          locked_at: date(existing.locked_at) };
      }
    }
    const entry = (await client.query(`SELECT e.taxonomy_version FROM bb_library_index_entries e
      JOIN bb_library_index_releases r ON r.id=e.release_id AND r.active
      JOIN bb_library_document_versions v ON v.id=e.document_version_id AND v.state='published'
      JOIN bb_library_profiles p ON p.id=e.profile_id AND p.state='published'
      JOIN bb_library_documents d ON d.id=e.document_id JOIN bb_library_sources s ON s.id=d.source_id AND s.usage_rights='commercial_licensed'
      WHERE e.release_id=$1 AND e.document_version_id=$2 AND e.profile_id=$3`, [input.indexReleaseId, input.documentVersionId, input.profileId])).rows[0];
    if (!entry) throw new Problem(409, 'DATA_NOT_ENTITLED', 'Candidate is no longer selectable in the active release');
    const id = uid();
    const row = (await client.query(`INSERT INTO bb_library_selection_locks(id,owner_user_id,project_id,run_id,query_schema_version,document_version_id,profile_id,taxonomy_version,index_release_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING locked_at`, [id, input.ownerUserId, input.projectId, input.runId ?? null, LIBRARY_QUERY_SCHEMA_VERSION, input.documentVersionId, input.profileId, entry.taxonomy_version, input.indexReleaseId])).rows[0];
    return { lock_id: id, query_schema_version: LIBRARY_QUERY_SCHEMA_VERSION, document_version_id: input.documentVersionId, profile_id: input.profileId, taxonomy_version: entry.taxonomy_version, index_release_id: input.indexReleaseId, locked_at: date(row.locked_at) };
  });
}

/**
 * Trusted read of a locked reference. The lock itself stays traceable forever, but body bytes are released
 * only while the version is not withdrawn/revoked and its source still has rights (re-checked on every read).
 * A later release never changes which versions the lock points at.
 */
export async function readLockedReference(pool: Pool, blobs: PrivateBlobs, ownerUserId: string, projectId: string, lockId: string) {
  const row = (await pool.query(`SELECT l.*, v.state AS version_state, s.usage_rights, p.top3, p.set_key, p.profile_version, v.version AS document_version
    FROM bb_library_selection_locks l JOIN bb_library_document_versions v ON v.id=l.document_version_id JOIN bb_library_profiles p ON p.id=l.profile_id
    JOIN bb_library_documents d ON d.id=v.document_id JOIN bb_library_sources s ON s.id=d.source_id
    WHERE l.id=$1 AND l.owner_user_id=$2 AND l.project_id=$3`, [lockId, ownerUserId, projectId])).rows[0];
  if (!row) throw missing();
  const lock = { lock_id: row.id, document_version_id: row.document_version_id, document_version: row.document_version, profile_id: row.profile_id, profile_version: row.profile_version,
    taxonomy_version: row.taxonomy_version, index_release_id: row.index_release_id, version_state: row.version_state as string };
  if (['withdrawn', 'license_revoked'].includes(row.version_state) || row.usage_rights !== 'commercial_licensed') {
    return { lock, access: 'denied' as const, reason: row.usage_rights !== 'commercial_licensed' ? 'source_rights_not_current' : `version_${row.version_state}`, bytes: null };
  }
  const body = await readLibraryVersionBytes(pool, blobs, row.document_version_id);
  return { lock, access: 'granted' as const, reason: null, bytes: body.bytes, sha256: body.sha256 };
}

// ---------------------------------------------------------------- operator views
export async function libraryOperatorRole(pool: Pool, userId: string): Promise<'library_reader' | 'library_operator' | null> {
  const rows = (await pool.query('SELECT role FROM bb_library_operator_grants WHERE user_id=$1 AND revoked_at IS NULL', [userId])).rows.map(r => r.role as string);
  return rows.includes('library_operator') ? 'library_operator' : rows.includes('library_reader') ? 'library_reader' : null;
}

export async function libraryOverview(pool: Pool): Promise<LibraryOverview> {
  const c = (await pool.query(`SELECT
      (SELECT count(*) FROM bb_library_document_versions WHERE created_at>now()-interval '24 hours')::int AS new_24h,
      (SELECT count(*) FROM bb_library_document_versions WHERE state IN ('pending_parse','pending_classify','pending_review'))::int AS pending,
      (SELECT count(*) FROM bb_library_document_versions WHERE state='failed')::int
        + (SELECT count(*) FROM bb_jobs WHERE job_type='library' AND state='failed' AND updated_at>now()-interval '7 days')::int AS failed,
      (SELECT count(*) FROM bb_library_sources WHERE enabled AND kind='public_disclosure' AND (last_success_at IS NULL OR last_success_at<now()-stale_after_seconds*interval '1 second'))::int AS stale_sources,
      (SELECT count(*) FROM bb_library_document_versions WHERE state='published')::int AS published,
      (SELECT count(*) FROM bb_library_review_items WHERE state='open')::int AS open_reviews`)).rows[0];
  const sources = (await pool.query(`SELECT *, (enabled AND kind='public_disclosure' AND (last_success_at IS NULL OR last_success_at<now()-stale_after_seconds*interval '1 second')) AS stale FROM bb_library_sources ORDER BY id`)).rows;
  const active = (await pool.query('SELECT id, release_no FROM bb_library_index_releases WHERE active')).rows[0];
  const coverage = (await pool.query(`SELECT e.market, e.offering, count(*)::int AS published,
      (SELECT count(DISTINCT c)::int FROM bb_library_index_entries e2 CROSS JOIN LATERAL jsonb_array_elements_text(e2.set_key::jsonb) AS c
        WHERE e2.release_id=$1 AND e2.market=e.market AND e2.offering=e.offering) AS business_codes
    FROM bb_library_index_entries e WHERE e.release_id=$1 GROUP BY e.market, e.offering ORDER BY e.market, e.offering`, [active.id])).rows;
  return {
    counts: c,
    sources: sources.map(s => ({ source_id: s.id, kind: s.kind, usage_rights: s.usage_rights, enabled: s.enabled, last_success_at: s.last_success_at ? date(s.last_success_at) : null,
      last_attempt_at: s.last_attempt_at ? date(s.last_attempt_at) : null, last_error_code: s.last_error_code, stale: s.stale,
      sync_interval_seconds: s.sync_interval_seconds, next_sync_due_at: s.kind === 'public_disclosure' && s.enabled ? date(s.next_sync_due_at) : null, consecutive_failures: s.consecutive_failures })),
    coverage: coverage.map(r => ({ market: r.market, offering: r.offering, published: r.published, business_codes: r.business_codes })),
    active_release: { release_id: active.id, release_no: Number(active.release_no) },
  };
}

export async function libraryAlerts(pool: Pool, options: { reviewBacklog?: number } = {}): Promise<LibraryAlert[]> {
  const alerts: LibraryAlert[] = [];
  for (const s of (await pool.query('SELECT * FROM bb_library_sources WHERE enabled ORDER BY id')).rows) {
    if (s.last_error_code) alerts.push({ kind: 'source_sync_failed', severity: 'critical', subject: s.id, detail: s.last_error_code, since: s.last_attempt_at ? date(s.last_attempt_at) : null });
    const staleSince = s.last_success_at ? new Date(s.last_success_at).getTime() + s.stale_after_seconds * 1000 : null;
    if (s.kind === 'public_disclosure' && (staleSince === null || staleSince < Date.now()))
      alerts.push({ kind: 'source_stale', severity: 'warning', subject: s.id, detail: s.last_success_at ? `no successful sync for more than ${s.stale_after_seconds}s` : 'never synced successfully', since: s.last_success_at ? date(s.last_success_at) : null });
  }
  const failed = (await pool.query("SELECT count(*)::int AS n, min(state_changed_at) AS since FROM bb_library_document_versions WHERE state='failed'")).rows[0];
  if (failed.n > 0) alerts.push({ kind: 'items_failed', severity: 'warning', subject: 'document_versions', detail: `${failed.n} version(s) failed parse/classify; re-run per record`, since: date(failed.since) });
  const backlog = (await pool.query("SELECT count(*)::int AS n, min(created_at) AS since FROM bb_library_review_items WHERE state='open'")).rows[0];
  if (backlog.n >= (options.reviewBacklog ?? 50)) alerts.push({ kind: 'review_backlog', severity: 'warning', subject: 'review_queue', detail: `${backlog.n} open review item(s)`, since: date(backlog.since) });
  return alerts;
}

export async function libraryMissSummary(pool: Pool, days = 30) {
  return (await pool.query(`SELECT market, offering, instrument, document_stage, reason, count(*)::int AS misses, count(DISTINCT set_key_hash)::int AS distinct_sets, max(occurred_at) AS last_at
    FROM bb_library_query_misses WHERE occurred_at>now()-($1::integer * interval '1 day') GROUP BY 1,2,3,4,5 ORDER BY misses DESC LIMIT 100`, [days])).rows
    .map(r => ({ ...r, last_at: date(r.last_at) }));
}

export async function libraryVersionDetail(pool: Pool, versionId: string) {
  const v = (await pool.query(`SELECT v.id, v.document_id, v.version, v.source_revision, v.sha256, v.byte_size, v.media_type, v.disclosed_at, v.market, v.offering, v.instrument, v.document_stage,
      v.state, v.state_reason, v.state_actor, v.state_changed_at, d.source_id, d.external_key, d.issuer_name, d.title
    FROM bb_library_document_versions v JOIN bb_library_documents d ON d.id=v.document_id WHERE v.id=$1`, [versionId])).rows[0];
  if (!v) throw missing();
  const profiles = (await pool.query('SELECT id, profile_version, fiscal_year, taxonomy_version, accounting_scope, revenue_basis, currency, unit, reviewed_review_id, reviewed_by, reviewed_at, top3, set_key, completeness, origin, state, state_reason FROM bb_library_profiles WHERE document_version_id=$1 ORDER BY profile_version', [versionId])).rows;
  const audit = (await pool.query(`SELECT subject_type, subject_id, from_state, to_state, reason, actor, occurred_at FROM bb_library_audit
    WHERE (subject_type='document_version' AND subject_id=$1) OR (subject_type='profile' AND subject_id = ANY($2::text[])) ORDER BY id`, [versionId, profiles.map(p => p.id)])).rows;
  return { version: { ...v, sha256: v.sha256.trim(), state_changed_at: date(v.state_changed_at) }, profiles, audit: audit.map(a => ({ ...a, occurred_at: date(a.occurred_at) })) };
}
