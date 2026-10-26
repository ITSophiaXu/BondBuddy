import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isReviewReport, type ReviewReport, type ReviewAction } from '@bondbuddy/contracts';
import { digest, Problem, transaction } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { readRunExecutionInput } from '@bondbuddy/api/run-execution-input';
import { findReviewExecutionReport } from '@bondbuddy/api/review-report-execution';
import { checkpointStage, recordReviewAction } from '@bondbuddy/api/queue';
import type { RunStage, StageContext } from './run-pipeline.js';
import {lockStageRunExecution} from './run-execution-lease.js';

const runFile = promisify(execFile), repo = resolve(fileURLToPath(import.meta.url), '../../../..');
/** Shares the project lock with adoption/execution so a cancelled old writer cannot change the catalog behind a new acceptance. */
export async function registerReviewReport(ctx:Pick<StageContext,'pool'|'run'|'lease'>,report:ReviewReport):Promise<boolean> {
  if(!isReviewReport(report)||report.run_id!==ctx.run.id||report.project_id!==ctx.run.project_id||report.input_revision!==ctx.run.input_revision
    ||ctx.lease.owner!==ctx.run.owner_user_id||ctx.lease.runId!==ctx.run.id)return false;
  for(let attempt=0;attempt<3;attempt++)try{return await transaction(ctx.pool,async client=>{
    const project=(await client.query(`SELECT id FROM bb_projects WHERE id=$1 AND owner_user_id=$2 AND archived_at IS NULL AND deleted_at IS NULL FOR UPDATE`,
      [ctx.run.project_id,ctx.run.owner_user_id])).rows[0];
    if(!project)return false;
    // The queue sets claimed and checkpointed jobs to running. Paused, stop/cancelled
    // and every terminal state must obtain a new normal claim before publication.
    const run=await lockStageRunExecution(client,ctx);
    if(!run||run.input_revision!==report.input_revision)return false;
    const frozen=await readRunExecutionInput(client,ctx.run.owner_user_id,ctx.run.id,ctx.lease),execution=frozen.reviewExecution;
    const manifest=frozen.input.manifest.review as Record<string,unknown>|undefined;
    if(!execution||manifest?.report_id!==report.report_id||report.version!==execution.version||report.scope.mode!==execution.operation
      ||inputManifestHash(report.source_material)!==inputManifestHash(execution.snapshot.input?.source_material_ref??null)
      ||inputManifestHash(report.scope.finding_ids)!==inputManifestHash(execution.snapshot.finding_ids??null)
      ||report.follow_up&&(report.follow_up.source_report_id!==execution.source_report_id
        ||report.follow_up.source_report_sha256!==manifest.source_report_sha256))return false;
    const hash=inputManifestHash(report),exact=[ctx.run.owner_user_id,ctx.run.project_id,ctx.run.id,ctx.lease.executionVersion,ctx.lease.inputRevision,ctx.lease.inputHash];
    const saved=await client.query(`INSERT INTO bb_review_execution_reports(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,id,version,content_sha256,report)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,[...exact,report.report_id,report.version,hash,report]);
    const previous=await findReviewExecutionReport(client,ctx.run.owner_user_id,ctx.run.project_id,report.report_id);
    if(!previous||previous.run_id!==ctx.run.id||previous.execution_version!==ctx.lease.executionVersion
      ||previous.input_revision!==ctx.lease.inputRevision||previous.input_hash!==ctx.lease.inputHash
      ||previous.version!==report.version||previous.content_sha256!==hash){
      if(saved.rowCount)throw new Problem(409,'INPUT_REVISION_CONFLICT','Stored report does not match its execution');
      return false; // ON CONFLICT wrote nothing; preserve the existing immutable report.
    }
    if(ctx.lease.executionVersion===1){
      await client.query(`INSERT INTO bb_review_reports(id,owner_user_id,project_id,run_id,version,content_sha256,report,created_at)
        SELECT id,owner_user_id,project_id,run_id,version,content_sha256,report,created_at FROM bb_review_execution_reports
        WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3 AND execution_version=$4 AND input_revision=$5 AND input_hash=$6
        ON CONFLICT DO NOTHING`,exact);
      const mirror=await client.query(`SELECT 1 FROM bb_review_reports l JOIN bb_review_execution_reports e
        ON l.owner_user_id=e.owner_user_id AND l.project_id=e.project_id AND l.run_id=e.run_id AND l.id=e.id
          AND l.version=e.version AND l.content_sha256=e.content_sha256 AND l.report=e.report AND l.created_at=e.created_at
        WHERE e.owner_user_id=$1 AND e.project_id=$2 AND e.run_id=$3 AND e.execution_version=$4 AND e.input_revision=$5 AND e.input_hash=$6`,exact);
      if(mirror.rowCount!==1)throw new Problem(409,'INPUT_REVISION_CONFLICT','Report mirror does not match its execution');
    }
    return true;
  });}catch(error){
    // Retry the complete idempotent registration, never model/Word work. A
    // rolling legacy writer can hold its unique key while awaiting our parents.
    if((error as {code?:string}).code!=='40P01'||attempt===2)throw error;
  }
  return false;
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
