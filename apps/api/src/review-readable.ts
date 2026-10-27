import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { hasReviewReportBody, type ReviewReadableReport } from '@bondbuddy/contracts';
import { digest, missing, project, type PrivateBlobs } from './data.js';
import { readDocxBodyText, DOCX_LIMITS } from './docx-inspector.js';

const MAX = 4 * 1024 * 1024;
/** Public reads use only completed, owner-bound file reports, never prompts/final chatter. */
export async function readReviewMarkdown(blobs: Pick<PrivateBlobs, 'getIfExistsBounded'>, row: {
  owner_user_id: string; project_id: string; run_id: string; input_hash: string; call_id: string;
  result_ref: string; result_sha256: string; byte_size: number | string;
}): Promise<{ markdown: string; content_sha256: string } | null> {
  const expected = `users/${row.owner_user_id}/projects/${row.project_id}/provider-results/${row.call_id}-${row.result_sha256.trim()}.json`;
  if (row.result_ref !== expected || Number(row.byte_size) < 1 || Number(row.byte_size) > 10485760) return null;
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
  const report = await blobs.getIfExistsBounded(file.key, MAX);
  if (!report || report.length !== file.byte_size || digest(report) !== file.sha256) return null;
  let markdown;
  try { markdown = new TextDecoder('utf-8', { fatal: true }).decode(report); } catch { return null; }
  return markdown.trim() ? { markdown, content_sha256: file.sha256 } : null;
}

export function registerReadableReview(app: FastifyInstance, db: () => Pool,
  owner: (request: FastifyRequest) => Promise<string>, blobs: () => PrivateBlobs) {
  app.get('/api/v1/projects/:project_id/review-executions/:run_id/readable-report', async (request, reply): Promise<ReviewReadableReport> => {
    const user = await owner(request), { project_id, run_id } = request.params as { project_id: string; run_id: string };
    await project(db(), user, project_id);

    const run = (await db().query(`SELECT r.input_hash,e.version FROM bb_runs r JOIN bb_review_executions e
      ON e.run_id=r.id AND e.project_id=r.project_id AND e.owner_user_id=r.owner_user_id
      WHERE r.owner_user_id=$1 AND r.project_id=$2 AND r.id=$3 AND r.state IN ('succeeded','test_completed')
      AND e.operation IN ('full_review','differential_review') AND EXISTS (
        SELECT 1 FROM bb_review_artifacts a JOIN bb_artifact_versions v ON v.id=a.artifact_id
          AND v.version=a.artifact_version AND v.owner_user_id=a.owner_user_id AND v.run_id=a.run_id
        WHERE a.owner_user_id=r.owner_user_id AND a.project_id=r.project_id AND a.run_id=r.id
          AND a.kind='report' AND v.delivery_status='available' AND v.quality_status='passed')`, [user, project_id, run_id])).rows[0];
    if (!run) throw missing();
    reply.header('Cache-Control', 'private, no-store');
    const result: ReviewReadableReport = { version: 'review-readable-v1', project_id, run_id, execution_version: run.version,
      status: 'unavailable', markdown: '', content_sha256: null };
    const rows = (await db().query(`SELECT owner_user_id,project_id,run_id,call_id,result_ref,result_sha256,byte_size
      FROM bb_provider_result_refs WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3
      AND logical_call_id='review-file-v1' AND result_schema_version='codex-review-file-v1'`, [user, project_id, run_id])).rows;
    // Historical file-only reports may have no Markdown companion. Inspect the
    // exact delivered bytes without rewriting the task, artifact or credit ledger.
    const artifact = (await db().query(`SELECT v.object_key,v.sha256 FROM bb_review_artifacts a
      JOIN bb_artifact_versions v ON v.id=a.artifact_id AND v.version=a.artifact_version AND v.owner_user_id=a.owner_user_id AND v.run_id=a.run_id
      WHERE a.owner_user_id=$1 AND a.project_id=$2 AND a.run_id=$3 AND a.kind='report'
      AND v.delivery_status='available' AND v.quality_status='passed'`, [user, project_id, run_id])).rows[0];
    if (artifact) try {
      const bytes = await blobs().getIfExistsBounded(artifact.object_key, DOCX_LIMITS.archiveBytes);
      if (bytes && digest(bytes) === artifact.sha256.trim()) {
        const body = readDocxBodyText(bytes);
        if (body !== null && !hasReviewReportBody(body)) return { ...result, status: 'invalid_content' };
      }
    } catch { /* An unreadable file is not proof of an empty report. */ }
    // Storage/format issues affect this optional view only; no state writes or model re-execution.
    if (rows.length === 1) try { const text = await readReviewMarkdown(blobs(), { ...rows[0], input_hash: run.input_hash });
      if (text && hasReviewReportBody(text.markdown)) return { ...result, status: 'available', ...text };
    } catch { /* Keep the successful Word delivery and retryable read independent. */ }
    return result;
  });
}
