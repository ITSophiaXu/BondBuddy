import type { Pool } from 'pg';
import { enqueueLibrarySync } from '@bondbuddy/api/library';
import { raiseAlert } from '@bondbuddy/api/evidence-gate';
import { Problem } from '@bondbuddy/api/data';
import { runLibraryOnce, type LibraryPipelineDependencies, type LibraryRunOutcome } from './library-pipeline.js';

// #78 scheduled library sync, run as the `library_sync` task of the #79/#35 ops scheduler.
// One pass: claim due sources (per-source cadence from bb_library_sources, 0032) -> enqueue one library_sync
// job each (idempotent while one is live) -> drain library jobs through the shared pipeline, which owns the
// incremental cursor, hash dedupe, per-item retries and checkpoint resume -> raise stale-source alerts.
// Single execution: a source is claimed with a conditional UPDATE lease; jobs are claimed with the bb_jobs
// lease (SKIP LOCKED), and a crashed job is re-claimed after its lease expires and resumes from its checkpoint.

export type LibrarySyncOptions = LibraryPipelineDependencies & {
  owner: string;
  /** Upper bound on library jobs drained per pass (keeps one pass bounded). */
  maxJobs?: number;
  /** Stale when no success for longer than staleFactor x sync_interval_seconds. */
  staleFactor?: number;
  jitter?: number;
  random?: () => number;
  sourceLeaseSeconds?: number;
};
export type LibrarySyncPass = { claimed: number; enqueued: number; no_adapter: number; jobs: number; failed: number; partial: number; lost: number; stale: number };

/** Claims every due, enabled public-disclosure source this instance can lease. Revoked sources are never scheduled. */
export async function claimDueLibrarySources(pool: Pool, owner: string, leaseSeconds = 300, limit = 20) {
  return (await pool.query(`UPDATE bb_library_sources s SET sync_lease_owner=$1, sync_lease_until=now()+($2::integer * interval '1 second')
    WHERE s.id IN (SELECT id FROM bb_library_sources WHERE enabled AND kind='public_disclosure' AND usage_rights<>'revoked' AND next_sync_due_at<=now()
      AND (sync_lease_until IS NULL OR sync_lease_until<now()) ORDER BY next_sync_due_at, id FOR UPDATE SKIP LOCKED LIMIT $3)
    RETURNING s.id, s.sync_interval_seconds`, [owner, leaseSeconds, limit])).rows as Array<{ id: string; sync_interval_seconds: number }>;
}

/** Releases the source lease and schedules the next run; a lease this owner no longer holds changes nothing. */
export async function releaseLibrarySource(pool: Pool, sourceId: string, owner: string, nextInSeconds: number) {
  const q = await pool.query(`UPDATE bb_library_sources SET sync_lease_owner=NULL, sync_lease_until=NULL, next_sync_due_at=now()+($3::integer * interval '1 second')
    WHERE id=$1 AND sync_lease_owner=$2`, [sourceId, owner, Math.max(60, Math.round(nextInSeconds))]);
  return q.rowCount === 1;
}

/** Raises one library_source_stale alert per source per interval bucket (bb_ops_alerts dedupe key). */
export async function checkStaleLibrarySources(pool: Pool, staleFactor = 2) {
  const rows = (await pool.query(`SELECT id, sync_interval_seconds, last_success_at, EXTRACT(EPOCH FROM now()-COALESCE(last_success_at, created_at))::bigint AS age
    FROM bb_library_sources WHERE enabled AND kind='public_disclosure' AND usage_rights<>'revoked'
      AND COALESCE(last_success_at, created_at) < now() - ($1::double precision * sync_interval_seconds * interval '1 second') ORDER BY id`, [staleFactor])).rows;
  for (const r of rows) await raiseAlert(pool, { kind: 'library_source_stale', severity: 'warning', scope: r.id, bucketSeconds: Number(r.sync_interval_seconds),
    detail: { source_id: r.id, age_seconds: Number(r.age), threshold_seconds: Math.round(staleFactor * Number(r.sync_interval_seconds)), never_succeeded: r.last_success_at ? 0 : 1 } });
  return rows.map(r => r.id as string);
}

export async function runLibrarySyncPass(options: LibrarySyncOptions): Promise<LibrarySyncPass> {
  const { pool, owner, adapters } = options;
  const jitter = options.jitter ?? 0.1, random = options.random ?? Math.random;
  const pass: LibrarySyncPass = { claimed: 0, enqueued: 0, no_adapter: 0, jobs: 0, failed: 0, partial: 0, lost: 0, stale: 0 };
  for (const source of await claimDueLibrarySources(pool, owner, options.sourceLeaseSeconds ?? 300)) {
    pass.claimed++;
    try {
      if (!adapters[source.id]) pass.no_adapter++;
      else if ((await enqueueLibrarySync(pool, source.id)).created) pass.enqueued++;
    } catch (error) {
      // Disabled between claim and enqueue: nothing to run; anything else surfaces to the scheduler.
      if (!(error instanceof Problem && error.code === 'CAPABILITY_NOT_READY')) { await releaseLibrarySource(pool, source.id, owner, 60); throw error; }
    }
    await releaseLibrarySource(pool, source.id, owner, source.sync_interval_seconds * (1 + jitter * (2 * random() - 1)));
  }
  for (let i = 0; i < (options.maxJobs ?? 10); i++) {
    const out: LibraryRunOutcome = await runLibraryOnce(options);
    if (out.outcome === 'idle') break;
    pass.jobs++;
    if (out.outcome === 'failed') pass.failed++;
    if (out.outcome === 'lost') pass.lost++;
    if (out.partial) pass.partial++;
  }
  pass.stale = (await checkStaleLibrarySources(pool, options.staleFactor ?? 2)).length;
  return pass;
}
