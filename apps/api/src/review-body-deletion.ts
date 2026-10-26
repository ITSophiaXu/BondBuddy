import type { Pool } from 'pg';
import { DATA_POLICY_VERSION } from '@bondbuddy/contracts';
import { transaction } from './data.js';

const bodyTables = [
  'bb_review_editors', 'bb_review_execution_editors',
  'bb_review_reports', 'bb_review_execution_reports'
] as const;

export type ReviewBodyDeletionPolicy = {
  deletedContentPurgeDays: number;
  batchSize?: number;
  ownerScope?: string;
};

/** Four review SQL-body copies only. This is not a full project-content receipt. */
export type ReviewBodyDeletionResult = { projectsPurged: number; rowsPurged: number; failed: number };

/**
 * User-deleted projects use the configured deletion window, never the ordinary
 * terminal-run log lifetime. The database clock is authoritative for both the
 * selection and the DELETE guard; a caller's simulated/future clock cannot
 * shorten this business-content window. Old artifact-only receipts are not a
 * completion signal for these bodies.
 */
export async function purgeDeletedReviewBodies(pool: Pool, policy: ReviewBodyDeletionPolicy): Promise<ReviewBodyDeletionResult> {
  if (!Number.isSafeInteger(policy.deletedContentPurgeDays) || policy.deletedContentPurgeDays < 0)
    throw new Error('Review body deletion requires a non-negative integer window');
  const requestedBatch = policy.batchSize ?? 50;
  if (!Number.isSafeInteger(requestedBatch) || requestedBatch < 1) throw new Error('Invalid review body deletion batch size');
  const batchSize = Math.min(50, requestedBatch);
  const due = await pool.query(`SELECT p.owner_user_id,p.id FROM bb_projects p
    WHERE p.deleted_at IS NOT NULL AND isfinite(p.deleted_at)
      AND extract(epoch FROM clock_timestamp()-p.deleted_at) >= $1::bigint*86400::numeric
      AND ($2::text IS NULL OR p.owner_user_id=$2)
      AND (${bodyTables.map(table => `EXISTS (SELECT 1 FROM ${table} b WHERE b.owner_user_id=p.owner_user_id AND b.project_id=p.id)`).join(' OR ')})
    ORDER BY p.deleted_at,p.id LIMIT $3`, [policy.deletedContentPurgeDays, policy.ownerScope ?? null, batchSize]);
  let projectsPurged = 0, rowsPurged = 0, failed = 0;
  for (const project of due.rows) {
    try {
      const rows = await transaction(pool, async client => {
        // Match current trusted registrars' project -> run -> job order. The
        // SQL INSERT guard uses SHARE NOWAIT so a rolling run-first writer
        // cannot wait on this project while holding a run needed below.
        const locked = await client.query(`SELECT id FROM bb_projects
          WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NOT NULL AND isfinite(deleted_at)
            AND extract(epoch FROM clock_timestamp()-deleted_at) >= $3::bigint*86400::numeric
          FOR UPDATE SKIP LOCKED`, [project.owner_user_id, project.id, policy.deletedContentPurgeDays]);
        if (!locked.rowCount) return 0;
        await client.query('SELECT id FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 ORDER BY id FOR UPDATE',
          [project.owner_user_id, project.id]);
        await client.query(`SELECT j.id FROM bb_jobs j JOIN bb_runs r ON r.owner_user_id=j.owner_user_id AND r.id=j.run_id
          WHERE r.owner_user_id=$1 AND r.project_id=$2 ORDER BY j.id FOR UPDATE OF j`, [project.owner_user_id, project.id]);
        await client.query("SELECT set_config('bb.review_body_purge',$1,true)", [JSON.stringify({
          version: 'review_body_purge_v1', owner_user_id: project.owner_user_id, project_id: project.id,
          deleted_content_purge_days: policy.deletedContentPurgeDays, policy_version: DATA_POLICY_VERSION
        })]);
        let count = 0;
        for (const table of bodyTables) {
          const deleted = await client.query(`DELETE FROM ${table} WHERE owner_user_id=$1 AND project_id=$2`,
            [project.owner_user_id, project.id]);
          count += deleted.rowCount ?? 0;
        }
        return count;
      });
      if (rows) { projectsPurged++; rowsPurged += rows; }
    } catch { failed++; }
  }
  return { projectsPurged, rowsPurged, failed };
}
