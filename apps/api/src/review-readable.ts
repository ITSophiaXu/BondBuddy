import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { ReviewReadableReport } from '@bondbuddy/contracts';
import { digest, missing, project, transaction, type PrivateBlobs } from './data.js';

const MAX = 4 * 1024 * 1024;
type ReviewMarkdownSource = {
  id: string; prompt_snapshot_ref: string;
  owner_user_id: string; project_id: string; run_id: string; input_hash: string; call_id: string;
  result_ref: string; result_sha256: string; byte_size: number | string;
};
async function readableSource(db: PoolClient, row: ReviewMarkdownSource): Promise<boolean> {
  const found = await db.query(`SELECT p.id FROM bb_provider_result_refs p
    JOIN bb_runs r ON r.owner_user_id=p.owner_user_id AND r.project_id=p.project_id AND r.id=p.run_id
    JOIN bb_projects pr ON pr.owner_user_id=r.owner_user_id AND pr.id=r.project_id AND pr.deleted_at IS NULL
    JOIN bb_users u ON u.id=r.owner_user_id AND u.closed_at IS NULL AND u.status<>'closed'
    JOIN bb_review_execution_snapshots e ON e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id AND e.run_id=r.id
      AND e.execution_version=1 AND e.input_revision=r.input_revision AND e.input_hash=r.input_hash
    WHERE p.id=$1 AND p.owner_user_id=$2 AND p.project_id=$3 AND p.run_id=$4 AND p.call_id=$5
      AND p.prompt_snapshot_ref=$6 AND r.input_hash=$7 AND p.result_ref=$8 AND p.result_sha256=$9 AND p.byte_size=$10
      AND p.logical_call_id='review-file-v1' AND p.result_schema_version='codex-review-file-v1'
      AND r.state IN ('succeeded','test_completed') AND e.operation IN ('full_review','differential_review')
      AND NOT EXISTS (SELECT 1 FROM bb_log_content_tombstones t
        WHERE (t.content_kind='prompt_snapshot' AND t.content_id=p.prompt_snapshot_ref)
          OR (t.content_kind='provider_result' AND t.content_id=p.id))
      AND EXISTS (SELECT 1 FROM bb_review_execution_artifact_versions a JOIN bb_delivered_artifact_versions v ON v.id=a.artifact_id
        AND v.version=a.artifact_version AND v.owner_user_id=a.owner_user_id AND v.run_id=a.run_id
        WHERE a.owner_user_id=r.owner_user_id AND a.project_id=r.project_id AND a.run_id=r.id
          AND a.execution_version=1 AND a.input_hash=r.input_hash AND a.input_revision=r.input_revision
          AND a.kind='report' AND v.delivery_status='available' AND v.quality_status='passed')`,
  [row.id,row.owner_user_id,row.project_id,row.run_id,row.call_id,row.prompt_snapshot_ref,row.input_hash,
    row.result_ref,row.result_sha256.trim(),row.byte_size]);
  return found.rowCount === 1;
}

/** Public reads use only completed, owner-bound file reports, never prompts/final chatter. */
export async function readReviewMarkdown(pool: Pool, blobs: Pick<PrivateBlobs, 'getIfExistsBounded'>,
  row: ReviewMarkdownSource): Promise<{ markdown: string; content_sha256: string } | null> {
  const expected = `users/${row.owner_user_id}/projects/${row.project_id}/provider-results/${row.call_id}-${row.result_sha256.trim()}.json`;
  if (row.result_ref !== expected || Number(row.byte_size) < 1 || Number(row.byte_size) > 10485760) return null;
  return transaction(pool, async db => {
    // Retention and the saved-work reader use this same order. Keep both
    // parents locked through report validation, without late project/run locks.
    await db.query("SELECT pg_advisory_xact_lock(hashtext('prompt_snapshot'),hashtext($1::text))", [row.prompt_snapshot_ref]);
    await db.query("SELECT pg_advisory_xact_lock(hashtext('provider_result'),hashtext($1::text))", [row.id]);
    if (!await readableSource(db, row)) return null;
    const bytes = await blobs.getIfExistsBounded(expected, 10485760);
    if (!bytes || bytes.length !== Number(row.byte_size) || digest(bytes) !== row.result_sha256.trim()) return null;
    let result;
    try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return null; }
    if (result?.version !== 'codex-review-file-v1' || result.input_hash !== row.input_hash.trim()) return null;
    const file = result.files?.['report.md'];
    if (!file || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.byte_size) || file.byte_size < 1 || file.byte_size > MAX) return null;
    const key = `owners/${row.owner_user_id}/projects/${row.project_id}/runs/${row.run_id}/review-files/${row.call_id}/${file.sha256}/report.md`;
    const correctionKey=`owners/${row.owner_user_id}/projects/${row.project_id}/runs/${row.run_id}/review-files/correction/${file.sha256}/report.md`;
    if (file.key !== key && !(result.files?.['editor.json'] && result.files?.['revision.docx'] && file.key===correctionKey)) return null;
    await db.query("SELECT pg_advisory_xact_lock(hashtext('run_file_object'),hashtext($1::text))", [file.key]);
    // Account/project visibility and registry state may have changed while a
    // cleaner held this file lock. Legacy files need no fabricated registry.
    if (!await readableSource(db, row)) return null;
    const registered = (await db.query(`SELECT o.*,s.stored_at,s.purge_started_at,s.purged_at
      FROM bb_run_working_objects o LEFT JOIN bb_run_working_object_state s ON s.object_key=o.object_key
      WHERE o.object_key=$1`, [file.key])).rows[0];
    if (registered && (!registered.stored_at || registered.purge_started_at || registered.purged_at
      || registered.owner_user_id !== row.owner_user_id || registered.project_id !== row.project_id
      || registered.run_id !== row.run_id || registered.filename !== 'report.md'
      || registered.sha256.trim() !== file.sha256 || Number(registered.byte_size) !== file.byte_size
      || registered.media_type !== 'text/markdown')) return null;
    const report = await blobs.getIfExistsBounded(file.key, MAX);
    if (!report || report.length !== file.byte_size || digest(report) !== file.sha256) return null;
    let markdown;
    try { markdown = new TextDecoder('utf-8', { fatal: true }).decode(report); } catch { return null; }
    return markdown.trim() ? { markdown, content_sha256: file.sha256 } : null;
  });
}

export function registerReadableReview(app: FastifyInstance, db: () => Pool,
  owner: (request: FastifyRequest) => Promise<string>, blobs: () => PrivateBlobs) {
  app.get('/api/v1/projects/:project_id/review-executions/:run_id/readable-report', async (request, reply): Promise<ReviewReadableReport> => {
    const user = await owner(request), { project_id, run_id } = request.params as { project_id: string; run_id: string };
    await project(db(), user, project_id);

    const run = (await db().query(`SELECT e.input_hash,e.version FROM bb_runs r JOIN bb_review_execution_snapshots e
      ON e.run_id=r.id AND e.project_id=r.project_id AND e.owner_user_id=r.owner_user_id
      AND e.execution_version=1 AND e.input_revision=r.input_revision AND e.input_hash=r.input_hash
      WHERE r.owner_user_id=$1 AND r.project_id=$2 AND r.id=$3 AND r.state IN ('succeeded','test_completed')
      AND e.operation IN ('full_review','differential_review') AND EXISTS (
        SELECT 1 FROM bb_review_execution_artifact_versions a JOIN bb_delivered_artifact_versions v ON v.id=a.artifact_id
          AND v.version=a.artifact_version AND v.owner_user_id=a.owner_user_id AND v.run_id=a.run_id
        WHERE a.owner_user_id=r.owner_user_id AND a.project_id=r.project_id AND a.run_id=r.id
          AND a.execution_version=1 AND a.input_hash=r.input_hash AND a.input_revision=r.input_revision
          AND a.kind='report' AND v.delivery_status='available' AND v.quality_status='passed')`, [user, project_id, run_id])).rows[0];
    if (!run) throw missing();
    reply.header('Cache-Control', 'private, no-store');
    const result: ReviewReadableReport = { version: 'review-readable-v1', project_id, run_id, execution_version: run.version,
      status: 'unavailable', markdown: '', content_sha256: null };
    const rows = (await db().query(`SELECT id,prompt_snapshot_ref,owner_user_id,project_id,run_id,call_id,result_ref,result_sha256,byte_size
      FROM bb_provider_result_refs WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3
      AND logical_call_id='review-file-v1' AND result_schema_version='codex-review-file-v1'`, [user, project_id, run_id])).rows;
    if (rows.length !== 1) return result;
    // Storage/format issues affect this optional view only; no state writes or model re-execution.
    try { const text = await readReviewMarkdown(db(), blobs(), { ...rows[0], input_hash: run.input_hash });
      if (text) return { ...result, status: 'available', ...text };
    } catch { /* Keep the successful Word delivery and retryable read independent. */ }
    return result;
  });
}
