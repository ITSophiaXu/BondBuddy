import type { Pool, PoolClient } from 'pg';
import { isReviewReport, type ReviewReport } from '@bondbuddy/contracts';
import { missing, Problem } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';

export type ReviewExecutionReport = {
  id: string; owner_user_id: string; project_id: string; run_id: string;
  execution_version: number; input_revision: number; input_hash: string;
  version: number; content_sha256: string; report: ReviewReport; created_at: Date | string;
};

/** Report IDs name immutable source executions, independently of a consumer's lease. */
async function load(db: Pool | PoolClient, owner: string, projectId: string, reportId: string) {
  return (await db.query(`SELECT p.*,s.snapshot AS execution_snapshot,s.version AS execution_report_version,
      s.operation AS execution_operation,s.source_report_id AS execution_source_report_id,i.manifest AS execution_input_manifest
    FROM bb_review_execution_reports p
    JOIN bb_run_execution_versions e ON e.owner_user_id=p.owner_user_id AND e.project_id=p.project_id AND e.run_id=p.run_id
      AND e.execution_version=p.execution_version AND e.input_revision=p.input_revision AND e.input_hash=p.input_hash
    JOIN bb_review_execution_snapshots s ON s.owner_user_id=p.owner_user_id AND s.project_id=p.project_id AND s.run_id=p.run_id
      AND s.execution_version=p.execution_version AND s.input_revision=p.input_revision AND s.input_hash=p.input_hash
    JOIN bb_input_revisions i ON i.owner_user_id=p.owner_user_id AND i.project_id=p.project_id
      AND i.revision=p.input_revision AND i.input_hash=p.input_hash
    JOIN bb_runs r ON r.owner_user_id=p.owner_user_id AND r.project_id=p.project_id AND r.id=p.run_id
    JOIN bb_projects project ON project.owner_user_id=p.owner_user_id AND project.id=p.project_id AND project.deleted_at IS NULL
    WHERE p.owner_user_id=$1 AND p.project_id=$2 AND p.id=$3`, [owner, projectId, reportId])).rows[0];
}

function checked(row: any): ReviewExecutionReport | null {
  const report = row.report, review = row.execution_input_manifest?.review;
  if (!isReviewReport(report) || typeof row.content_sha256 !== 'string' || typeof row.input_hash !== 'string'
    || inputManifestHash(report) !== row.content_sha256.trim()
    || inputManifestHash(row.execution_input_manifest) !== row.input_hash.trim()
    || report.report_id !== row.id || report.project_id !== row.project_id || report.run_id !== row.run_id
    || report.input_revision !== row.input_revision || report.version !== row.version
    || row.version !== row.execution_report_version || report.scope.mode !== row.execution_operation
    || review?.version !== 'review_v1' || report.report_id !== review.report_id || report.version !== review.version_number
    || report.scope.mode !== review.operation || row.execution_source_report_id !== review.source_report_id
    || inputManifestHash(row.execution_snapshot?.input ?? null) !== inputManifestHash(review.input ?? null)
    || inputManifestHash(report.source_material) !== inputManifestHash(row.execution_snapshot?.input?.source_material_ref ?? null)
    || inputManifestHash(report.source_material) !== inputManifestHash(review.input?.source_material_ref ?? null)
    || inputManifestHash(report.scope.finding_ids) !== inputManifestHash(row.execution_snapshot?.finding_ids ?? null)
    || inputManifestHash(report.scope.finding_ids) !== inputManifestHash(review.finding_ids ?? null)
    || report.follow_up && (report.follow_up.source_report_id !== row.execution_source_report_id
      || report.follow_up.source_report_sha256 !== review.source_report_sha256)) return null;
  return { id: row.id, owner_user_id: row.owner_user_id, project_id: row.project_id, run_id: row.run_id,
    execution_version: row.execution_version, input_revision: row.input_revision, input_hash: row.input_hash.trim(),
    version: row.version, content_sha256: row.content_sha256.trim(), report, created_at: row.created_at };
}

/** Internal gates reject absent or corrupt sources without consulting the legacy mirror. */
export async function findReviewExecutionReport(db: Pool | PoolClient, owner: string, projectId: string, reportId: string): Promise<ReviewExecutionReport | null> {
  const row = await load(db, owner, projectId, reportId);
  return row ? checked(row) : null;
}

/** Explicit reports retain their existing visibility before Word delivery completes. */
export async function readReviewExecutionReport(db: Pool | PoolClient, owner: string, projectId: string, reportId: string): Promise<ReviewExecutionReport> {
  const row = await load(db, owner, projectId, reportId);
  if (!row) throw missing();
  const result = checked(row);
  if (!result) throw new Problem(503, 'DATA_UNAVAILABLE', 'Report snapshot is invalid');
  return result;
}
