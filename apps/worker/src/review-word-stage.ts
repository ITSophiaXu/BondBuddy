import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isReviewReport, type ReviewReport } from '@bondbuddy/contracts';
import { digest } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { checkpointStage } from '@bondbuddy/api/queue';
import type { RunStage } from './run-pipeline.js';

const runFile = promisify(execFile), repo = resolve(fileURLToPath(import.meta.url), '../../../..');
export function reviewWordDeliveryStage(): RunStage {
  return { name: 'word_delivery', replay: true, run: async ctx => {
    const value = ctx.values.get('model_generation') as { report?: ReviewReport; input_hash?: string } | undefined;
    const report = value?.report ? structuredClone(value.report) : undefined;
    if (!isReviewReport(report) || value?.input_hash !== ctx.run.input_hash.trim() || report.run_id !== ctx.run.id || report.project_id !== ctx.run.project_id) return { kind: 'fail', code: 'VALIDATION_FAILED' };
    const gate = await ctx.validateBeforeModelCall?.(); if (gate) return gate;
    // Lock the actual report completion time once, so recovery produces identical report bytes.
    let completedAt = ctx.checkpoint.review_completion?.completed_at;
    if (!completedAt) {
      completedAt = new Date().toISOString();
      await checkpointStage(ctx.pool, ctx.lease, 'review_completion', { completed_at: completedAt });
      ctx.checkpoint.review_completion = { completed_at: completedAt };
    }
    if (typeof completedAt !== 'string' || !Number.isFinite(Date.parse(completedAt))) return { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' };
    report.created_at = completedAt;
    const pin = report.source_material;
    const material = (await ctx.pool.query('SELECT object_key,sha256,media_type FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL', [ctx.run.owner_user_id, ctx.run.project_id, pin.material_id, pin.material_version])).rows[0];
    if (!material || material.sha256.trim() !== pin.sha256) return { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' };
    const directory = await mkdtemp(resolve(tmpdir(), 'bb-review-word-'));
    try {
      const docx = material.media_type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      if (docx) {
        const bytes = await ctx.blobs.getIfExistsBounded(material.object_key, 100 * 1024 * 1024);
        if (!bytes || digest(bytes) !== pin.sha256) return { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' };
        await writeFile(resolve(directory, 'source.docx'), bytes, { mode: 0o600 });
      }
      const request = resolve(directory, 'request.json'), reportPath = resolve(directory, 'report.docx'), commentsPath = resolve(directory, 'comments.docx');
      await writeFile(request, JSON.stringify({ report }), { mode: 0o600 });
      const result = await runFile(process.env.BONDBUDDY_WORD_PYTHON ?? process.env.BONDBUDDY_TEST_PYTHON ?? 'python3', ['-m', 'bondbuddy_word_delivery.review', request, docx ? resolve(directory, 'source.docx') : '-', reportPath, commentsPath],
        { cwd: repo, env: { ...process.env, PYTHONPATH: resolve(repo, 'python') }, timeout: 300000, maxBuffer: 4 * 1024 * 1024, signal: ctx.signal });
      const summary = JSON.parse(result.stdout.trim());
      const bytes = await readFile(reportPath), comments = docx ? await readFile(commentsPath) : null;
      if (summary.writer_version !== 'bondbuddy-review-word-1.0.0' || summary.report_sha256 !== digest(bytes) || (comments && summary.comments_sha256 !== digest(comments))) return { kind: 'fail', code: 'WORD_QUALITY_REJECTED' };
      if (summary.unanchored.length) report.limitations = [...new Set([...report.limitations, ...summary.unanchored.map((item: Record<string, unknown>) => `批注定位限制：${JSON.stringify(item)}`)])].slice(0, 200);
      if (!isReviewReport(report)) return { kind: 'fail', code: 'VALIDATION_FAILED' };
      const hash = inputManifestHash(report);
      const saved = await ctx.pool.query(`INSERT INTO bb_review_reports(id,owner_user_id,project_id,run_id,version,content_sha256,report)
        SELECT $1,$2,$3,$4,$5,$6,$7 FROM bb_jobs WHERE id=$8 AND owner_user_id=$2 AND run_id=$4 AND state='running' AND lease_token=$9
        ON CONFLICT(run_id) DO NOTHING RETURNING id`, [report.report_id, ctx.run.owner_user_id, ctx.run.project_id, ctx.run.id, report.version, hash, report, ctx.lease.jobId, ctx.lease.token]);
      if (!saved.rowCount) {
        const previous = (await ctx.pool.query('SELECT content_sha256 FROM bb_review_reports WHERE owner_user_id=$1 AND run_id=$2', [ctx.run.owner_user_id, ctx.run.id])).rows[0];
        if (!previous || previous.content_sha256.trim() !== hash) return { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' };
      }
      return { kind: 'deliver', bytes, ...(comments ? { attachments: [{ kind: 'comments' as const, bytes: comments }] } : {}), wordSummary: summary };
    } catch (error) {
      if (ctx.signal.aborted) return { kind: 'stopped' };
      throw error;
    } finally { await rm(directory, { recursive: true, force: true }); }
  } };
}
