import {workpaperChangeDelivery} from './workpaper-change-stage.js';
import {isWorkpaperAssessment,workpaperAssessmentGate,workpaperAssessmentStage,workpaperAssessmentDelivery} from './workpaper-assessment-stage.js';
import { projectQaDeliveryStage } from './project-qa-stage.js';
import { integrityDeliveryStage } from './integrity-stage.js';
import { fileAuthoringDeliveryStage } from './file-authoring-stage.js';
import { m4DocumentDeliveryStage } from './m4-document-stage.js';
import { m4QaDeliveryStage } from './m4-qa-stage.js';
import { projectFileDeliveryStage } from './project-file-stage.js';
import { createHash } from 'node:crypto';
import { unifiedWordDeliveryStage } from './unified-word-stage.js';
import { reviewFileDeliveryStage } from './review-file-stage.js';
import { reviewWordDeliveryStage } from './review-word-stage.js';
import { resolvePythonExecutable } from './python-executable.js';
import { REVIEW_REVISION_CLI_METHOD, reviewRevisionCliDeliveryStage } from './review-revision-cli-stage.js';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { updateContentHash } from '@bondbuddy/domain/historical-update';
import { PENDING_ORIGINAL_NOTICE, type HistoricalGenerationPlan } from './historical-model-stage.js';
import { type RunStage, type StageContext } from './run-pipeline.js';

const runFile = promisify(execFile);
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_SOURCE = 100 * 1024 * 1024;
const MAX_OUTPUT = 64 * 1024 * 1024;
const repo = resolve(fileURLToPath(import.meta.url), '../../../..');

function validHash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function sha(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

export interface HistoricalWordResult {
  revision: Buffer; clean: Buffer; baseline: Buffer;
  summary: { writer_version: string; source_sha256: string; baseline_hash: string; plan_hash: string; replacements: number;
    columns: number; pending: number; revision_sha256: string; clean_sha256: string; effective_baseline_sha256: string };
}

async function writeHistoricalWord(ctx: StageContext, plan: HistoricalGenerationPlan): Promise<HistoricalWordResult> {
  const source = plan.source;
  const [input, material, run] = await Promise.all([
    ctx.pool.query('SELECT input_hash,material_versions FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
      [ctx.run.owner_user_id, ctx.run.project_id, ctx.run.input_revision]),
    ctx.pool.query(`SELECT role,media_type,sha256,byte_size,object_key FROM bb_material_versions
      WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL`,
      [ctx.run.owner_user_id, ctx.run.project_id, source.materialId, source.materialVersion]),
    ctx.pool.query('SELECT created_at FROM bb_runs WHERE id=$1 AND owner_user_id=$2 AND project_id=$3',
      [ctx.run.id, ctx.run.owner_user_id, ctx.run.project_id]),
  ]);
  const revision = input.rows[0];
  const row = material.rows[0];
  const refs = revision?.material_versions as { material_id: string; material_version: number }[] | undefined;
  if (!revision || revision.input_hash.trim() !== ctx.run.input_hash.trim() || !Array.isArray(refs) ||
    !refs.some(ref => ref.material_id === source.materialId && ref.material_version === source.materialVersion) ||
    !row || row.role !== 'historical' || row.media_type !== DOCX || row.sha256.trim() !== source.contentHash ||
    Number(row.byte_size) < 1 || Number(row.byte_size) > MAX_SOURCE || !run.rows[0]?.created_at) {
    throw new Error('WORD_LOCKED_SOURCE_MISMATCH');
  }
  const bytes = await ctx.blobs.getIfExistsBounded(row.object_key, MAX_SOURCE);
  if (!bytes || bytes.length !== Number(row.byte_size) || sha(bytes) !== source.contentHash) throw new Error('WORD_SOURCE_BLOB_MISMATCH');
  const directory = await mkdtemp(resolve(tmpdir(), 'bondbuddy-word-'));
  try {
    const original = resolve(directory, 'original.docx');
    const request = resolve(directory, 'plan.json');
    const tracked = resolve(directory, 'tracked.docx');
    const clean = resolve(directory, 'clean.docx');
    const baseline = resolve(directory, 'baseline.docx');
    await Promise.all([
      writeFile(original, bytes, { mode: 0o600 }),
      writeFile(request, JSON.stringify({ ...plan, _delivery_date: new Date(run.rows[0].created_at).toISOString().replace(/\.\d{3}Z$/, 'Z') }), { mode: 0o600 }),
    ]);
    const python = resolvePythonExecutable();
    const executed = await runFile(python, ['-m', 'bondbuddy_word_delivery', original, request, tracked, clean, baseline], {
      cwd: repo, env: { ...process.env, PYTHONPATH: resolve(repo, 'python') }, timeout: 300_000,
      maxBuffer: 1024 * 1024, signal: ctx.signal,
    });
    const summary = JSON.parse(executed.stdout.trim()) as HistoricalWordResult['summary'];
    const [revisionBytes, cleanBytes, baselineBytes] = await Promise.all([readFile(tracked), readFile(clean), readFile(baseline)]);
    if (revisionBytes.length > MAX_OUTPUT || cleanBytes.length > MAX_OUTPUT || baselineBytes.length > MAX_OUTPUT ||
      summary.writer_version !== 'bondbuddy-word-delivery-1.0.0' ||
      summary.source_sha256 !== source.contentHash || summary.baseline_hash !== plan.baselineHash ||
      summary.plan_hash !== plan.planHash || summary.replacements !== plan.replacements.length ||
      summary.columns !== plan.columns.length || summary.pending !== plan.reviewNotes.length ||
      summary.revision_sha256 !== sha(revisionBytes) || summary.clean_sha256 !== sha(cleanBytes) ||
      summary.effective_baseline_sha256 !== sha(baselineBytes)) {
      throw new Error('WORD_WRITER_OUTPUT_MISMATCH');
    }
    return { revision: revisionBytes, clean: cleanBytes, baseline: baselineBytes, summary };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Native revision generation is a replayable, deterministic stage; only checked bytes may become artifacts. */
export function historicalWordDeliveryStage(options: { writer?: typeof writeHistoricalWord } = {}): RunStage {
  return { name: 'word_delivery', replay: true, run: async ctx => {
    if((ctx.values.get('input_lock') as {workpaper_change?:boolean})?.workpaper_change)return workpaperChangeDelivery().run(ctx);
    if((ctx.values.get('input_lock') as {workpaper_assessment?:boolean})?.workpaper_assessment)return workpaperAssessmentDelivery().run(ctx);
    if((ctx.values.get('input_lock') as {project_qa_mode?:string})?.project_qa_mode)return projectQaDeliveryStage().run(ctx);
    if((ctx.values.get('input_lock') as {integrity_mode?:string})?.integrity_mode)return integrityDeliveryStage().run(ctx);
    if((ctx.values.get('input_lock') as {project_file_mode?:string})?.project_file_mode)return projectFileDeliveryStage().run(ctx);
    if ((ctx.values.get('input_lock') as {m4_mode?:string})?.m4_mode==='document')return m4DocumentDeliveryStage().run(ctx);
    if ((ctx.values.get('input_lock') as {m4_mode?:string})?.m4_mode==='qa')return m4QaDeliveryStage().run(ctx);
    if ((ctx.values.get('model_generation') as {version?:string})?.version === 'codex-review-file-v1') return reviewFileDeliveryStage().run(ctx);
    if ((ctx.values.get('model_generation') as {version?:string})?.version===REVIEW_REVISION_CLI_METHOD) return reviewRevisionCliDeliveryStage().run(ctx);
    if ((ctx.values.get('model_generation') as {version?:string})?.version==='codex-file-word-v1') return fileAuthoringDeliveryStage().run(ctx);
    if ((ctx.values.get('model_generation') as { version?: string })?.version === 'unified-plan-v1') return unifiedWordDeliveryStage().run(ctx);
    if ((ctx.values.get('model_generation') as { version?: string })?.version === 'review-analysis-v1') return reviewWordDeliveryStage().run(ctx);
    if (ctx.run.task_kind !== 'update') return { kind: 'pause', stage: 'capability_not_ready', reason: 'historical_word_task_kind_required' };
    const value = ctx.values.get('model_generation');
    const plan = value as HistoricalGenerationPlan | undefined;
    if (!plan || plan.schemaVersion !== 'historical-update-plan-v1' || plan.deliverable !== false ||
      plan.source?.format !== 'docx_effective' || !validHash(plan.planHash) || !validHash(plan.baselineHash) ||
      !validHash(plan.source.contentHash) || !plan.generation || !Array.isArray(plan.reviewNotes) ||
      plan.reviewNotes.length > HISTORICAL_REVIEW_NOTE_MAX_COUNT || plan.reviewNotes.some(note => !note || typeof note.recordId !== 'string' ||
        !note.recordId || typeof note.message !== 'string' || !note.message.trim() || note.message.length > HISTORICAL_REVIEW_NOTE_MAX_LENGTH) ||
      !Array.isArray(plan.replacements) || !Array.isArray(plan.columns) ||

      plan.context?.ownerUserId !== ctx.run.owner_user_id || plan.context?.projectId !== ctx.run.project_id ||
      plan.context?.inputRevision !== ctx.run.input_revision || plan.context?.inputHash !== ctx.run.input_hash.trim()) {
      return { kind: 'fail', code: 'VALIDATION_FAILED' };
    }
    if (plan.pendingOriginalDraft) {
      const draft = plan.pendingOriginalDraft;
      if (ctx.run.channel !== 'non_production_test' || draft.mode !== 'non_production_pending_original' ||
        !ctx.checkpoint?.historical_pending_original || draft.status !== 'needs_confirmation' || draft.notice !== PENDING_ORIGINAL_NOTICE ||
        plan.replacements.length + plan.columns.length !== 0 || !plan.textPreview?.length || plan.generation.reviewedBlocks !== plan.textPreview.length ||
        !ctx.checkpoint.historical_generation_input || updateContentHash(ctx.checkpoint.historical_generation_input) !== plan.generation.preparationHash ||
        plan.textPreview.some(p => p.before !== p.after || !plan.reviewNotes.some(n => n.recordId === p.recordId)) ||
        updateContentHash(ctx.checkpoint.historical_pending_original) !== updateContentHash({
          preparation_hash: plan.generation.preparationHash, draft })) return { kind: 'fail', code: 'VALIDATION_FAILED' };
    } else if (plan.replacements.length + plan.columns.length === 0) return { kind: 'fail', code: 'VALIDATION_FAILED' };
    const { planHash, ...content } = plan;
    if (updateContentHash(content) !== planHash) return { kind: 'fail', code: 'VALIDATION_FAILED' };
    if (plan.findings.some(finding => finding.recordIds.some(id =>
      !plan.reviewNotes.some(note => note.recordId === id)))) return { kind: 'fail', code: 'VALIDATION_FAILED' };
    try {
      const generated = await (options.writer ?? writeHistoricalWord)(ctx, plan);
      return { kind: 'deliver', bytes: generated.revision, cleanBytes: generated.clean, baselineBytes: generated.baseline,
        wordSummary: { ...generated.summary, ...(plan.pendingOriginalDraft ? { pending_original_draft: plan.pendingOriginalDraft } : {}), pending_review: plan.reviewNotes.map(note => ({ record_id: note.recordId, message: note.message })) } };
    } catch (error) {
      if (ctx.signal.aborted) return { kind: 'stopped' };
      const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
      if (error instanceof Error && (error.message.startsWith('WORD_') || /^WORD_[A-Z_]+\s*$/.test(stderr)))
        return { kind: 'fail', code: 'WORD_QUALITY_REJECTED' };
      throw error;
    }
  } };
}
import { HISTORICAL_REVIEW_NOTE_MAX_LENGTH, HISTORICAL_REVIEW_NOTE_MAX_COUNT } from './historical-review-notes.js';
