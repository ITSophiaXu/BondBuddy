import {taskExecFile as runFile} from './task-execution.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReviewReport, type ReviewReport, type ReviewAction } from '@bondbuddy/contracts';
import { digest, transaction } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { checkpointStage, recordReviewAction } from '@bondbuddy/api/queue';
import type { RunStage, StageContext } from './run-pipeline.js';

const repo = resolve(fileURLToPath(import.meta.url), '../../../..');
/** Shares the project lock with adoption/execution so a cancelled old writer cannot change the catalog behind a new acceptance. */
export async function registerReviewReport(ctx:Pick<StageContext,'pool'|'run'|'lease'>,report:ReviewReport):Promise<boolean> {
  if(!isReviewReport(report)||report.run_id!==ctx.run.id||report.project_id!==ctx.run.project_id||report.input_revision!==ctx.run.input_revision
    ||ctx.lease.owner!==ctx.run.owner_user_id||ctx.lease.runId!==ctx.run.id)return false;
  return transaction(ctx.pool,async client=>{
    const project=(await client.query(`SELECT id FROM bb_projects WHERE id=$1 AND owner_user_id=$2 AND archived_at IS NULL AND deleted_at IS NULL FOR UPDATE`,
      [ctx.run.project_id,ctx.run.owner_user_id])).rows[0];
    if(!project)return false;
    const run=(await client.query(`SELECT state,input_hash,input_revision FROM bb_runs WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 FOR UPDATE`,
      [ctx.run.id,ctx.run.owner_user_id,ctx.run.project_id])).rows[0];
    // The queue sets claimed and checkpointed jobs to running. Paused, stop/cancelled
    // and every terminal state must obtain a new normal claim before publication.
    if(!run||run.state!=='running'||String(run.input_hash).trim()!==ctx.run.input_hash.trim()||run.input_revision!==report.input_revision)return false;
    const job=(await client.query(`SELECT id FROM bb_jobs WHERE id=$1 AND owner_user_id=$2 AND run_id=$3 AND state='running'
      AND lease_token=$4 AND lease_until>clock_timestamp() FOR UPDATE`,[ctx.lease.jobId,ctx.run.owner_user_id,ctx.run.id,ctx.lease.token])).rows[0];
    if(!job)return false;
    const hash=inputManifestHash(report),saved=await client.query(`INSERT INTO bb_review_reports(id,owner_user_id,project_id,run_id,version,content_sha256,report)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(run_id) DO NOTHING RETURNING id`,
      [report.report_id,ctx.run.owner_user_id,ctx.run.project_id,ctx.run.id,report.version,hash,report]);
    if(saved.rowCount)return true;
    const previous=(await client.query(`SELECT id,version,content_sha256,report FROM bb_review_reports WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3`,
      [ctx.run.owner_user_id,ctx.run.project_id,ctx.run.id])).rows[0];
    return !!previous&&previous.id===report.report_id&&previous.version===report.version
      &&String(previous.content_sha256).trim()===hash&&inputManifestHash(previous.report)===hash;
  });
}

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
    const action_id=digest(`${ctx.run.id}:${ctx.lease.token}:prepare_report`);
    let actionStarted=false;
    const progress=async(state:ReviewAction['state'])=>{
      if(ctx.signal.aborted)return;
      try { await recordReviewAction(ctx.pool,ctx.lease,{version:'review-action-v1',action_id,code:'prepare_report',state}); }
      catch { process.stderr.write('review_action_persist_failed\n'); }
    };
    try {
      const docx = material.media_type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      if (docx) {
        const bytes = await ctx.blobs.getIfExistsBounded(material.object_key, 100 * 1024 * 1024);
        if (!bytes || digest(bytes) !== pin.sha256) return { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' };
        await writeFile(resolve(directory, 'source.docx'), bytes, { mode: 0o600 });
      }
      const request = resolve(directory, 'request.json'), reportPath = resolve(directory, 'report.docx'), commentsPath = resolve(directory, 'comments.docx');
      await writeFile(request, JSON.stringify({ report }), { mode: 0o600 });
      await progress('started');actionStarted=true;
      const result = await runFile(process.env.BONDBUDDY_WORD_PYTHON ?? process.env.BONDBUDDY_TEST_PYTHON ?? 'python3', ['-m', 'bondbuddy_word_delivery.review', request, docx ? resolve(directory, 'source.docx') : '-', reportPath, commentsPath],
        { cwd: repo, env: { ...process.env, PYTHONPATH: resolve(repo, 'python') }, timeout: 300000, maxBuffer: 4 * 1024 * 1024, signal: ctx.signal });
      const summary = JSON.parse(result.stdout.trim());
      const bytes = await readFile(reportPath), comments = docx ? await readFile(commentsPath) : null;
      if (summary.writer_version !== 'bondbuddy-review-word-1.0.0' || summary.report_sha256 !== digest(bytes) || (comments && summary.comments_sha256 !== digest(comments))) {await progress('failed');return { kind: 'fail', code: 'WORD_QUALITY_REJECTED' };}
      if (summary.unanchored.length) report.limitations = [...new Set([...report.limitations, ...summary.unanchored.map((item: Record<string, unknown>) => `批注定位限制：${JSON.stringify(item)}`)])].slice(0, 200);
      if (!isReviewReport(report)) {await progress('failed');return { kind: 'fail', code: 'VALIDATION_FAILED' };}
      if(!await registerReviewReport(ctx,report)){await progress('failed');return {kind:'fail',code:'INPUT_REVISION_CONFLICT'};}
      await progress('completed');
      return { kind: 'deliver', bytes, ...(comments ? { attachments: [{ kind: 'comments' as const, bytes: comments }] } : {}), wordSummary: summary };
    } catch (error) {
      if (ctx.signal.aborted) return { kind: 'stopped' };
      if(actionStarted)await progress('failed');
      throw error;
    } finally { await rm(directory, { recursive: true, force: true }); }
  } };
}
