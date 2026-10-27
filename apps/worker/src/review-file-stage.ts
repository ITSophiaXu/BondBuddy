import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { digest } from '@bondbuddy/api/data';
import { writeRunWorkingFile } from '@bondbuddy/api/run-working-files';
import type { registerReviewEditorSnapshot } from '@bondbuddy/api/review-editor';
import { readRunExecutionInput } from '@bondbuddy/api/run-execution-input';
import { isReviewInput, reviewInputGate, type ReviewManifest } from './review-input.js';
import { codexModelStage, type RunStage, type StageContext } from './run-pipeline.js';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import { correctionFiles, correctionExport, validCorrectionExportPin } from './review-correction-stage.js';
import { buildReviewFileRequest, checkedReviewFile as checkedFile, loadReviewSelectedFindings, type ReviewFileInput } from './review-file-request.js';
import { adoptedReviewFileRequest } from './run-supplement-execution-request.js';
export type { ReviewFileInput } from './review-file-request.js';

const root = resolve(fileURLToPath(import.meta.url), '../../../..');
const helpers = join(root, 'python/bondbuddy_file_authoring');
const runFile = promisify(execFile);
const MAX = 100 * 1024 * 1024, TEXT_MAX = 4 * 1024 * 1024;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
// A completed provider turn can contain only a progress event. It is never a report.
function hasReviewReportText(bytes: Buffer | undefined): bytes is Buffer {
  return !!bytes?.toString('utf8').replace(/^.*BB_REVIEW_PROGRESS:[^\r\n]*$/gm, '').replace(/[\s\uFEFF#*`~>-]/g, '');
}
type FileRef = { key: string; sha256: string; byte_size: number };
export type ReviewFileResult = { version: 'codex-review-file-v1'; input_hash: string; files: Record<string, FileRef>; error?: 'WORD_DELIVERY_UNAVAILABLE' };
const prefix = (ctx: StageContext) => `owners/${ctx.run.owner_user_id}/projects/${ctx.run.project_id}/runs/${ctx.run.id}/review-files/`;

export function validReviewFileResult(value: unknown, ctx: StageContext): value is ReviewFileResult {
  const result = value as ReviewFileResult | null;
  return !!result && result.version === 'codex-review-file-v1' && result.input_hash === ctx.run.input_hash.trim()
    && !!result.files && Object.entries(result.files).every(([name, file]) => ['report.docx', 'model-report.docx', 'report.md', 'final-response.md', 'comments.docx', 'comments.pdf', 'annotations.json','revision.docx','clean.docx','baseline.docx','editor.json'].includes(name)
      && file.key.startsWith(prefix(ctx)) && !file.key.includes('..') && file.key.endsWith(`/${file.sha256}/${name}`)
      && /^[a-f0-9]{64}$/.test(file.sha256) && Number.isSafeInteger(file.byte_size) && file.byte_size > 0 && file.byte_size <= MAX)
    && (result.error === 'WORD_DELIVERY_UNAVAILABLE' || !!result.files['report.docx']);
}

export async function loadReviewFileInput(ctx: StageContext): Promise<ReviewFileInput> {
  if (!ctx.lease || ctx.run.id !== ctx.lease.runId || ctx.run.owner_user_id !== ctx.lease.owner
    || ctx.run.executionVersion !== ctx.lease.executionVersion || ctx.run.inputRevision !== ctx.lease.inputRevision
    || ctx.run.inputHash !== ctx.lease.inputHash
    || ctx.run.input_revision !== ctx.lease.inputRevision || ctx.run.input_hash.trim() !== ctx.lease.inputHash)
    throw Error('INPUT_REVISION_CONFLICT');
  const resolved = await readRunExecutionInput(ctx.pool, ctx.lease.owner, ctx.lease.runId, ctx.lease);
  if (resolved.run.project_id !== ctx.run.project_id || resolved.run.task_kind !== ctx.run.task_kind
    || resolved.run.input_revision !== ctx.run.input_revision || resolved.run.input_hash.trim() !== ctx.run.input_hash.trim())
    throw Error('INPUT_REVISION_CONFLICT');
  const row = resolved.input;
  if (!row || !isReviewInput(row.manifest) || await reviewInputGate(ctx.pool, ctx.run, row, resolved.reviewExecution, ctx.lease)) throw Error('INPUT_REVISION_CONFLICT');
  const manifest = row.manifest as ReviewManifest;
  if (!['review-file-v1','review-correction-v2'].includes(manifest.review.file_delivery?.version ?? '') || manifest.review.operation === 'revision'
    || !Array.isArray(manifest.review.file_delivery?.knowledge)
    || manifest.review.file_delivery!.knowledge.some(k => typeof k.markdown !== 'string' || digest(k.markdown) !== k.sha256)) throw Error('INPUT_REVISION_CONFLICT');
  if(Object.hasOwn(manifest.review.file_delivery!,'export')&&!validCorrectionExportPin(manifest.review.file_delivery!.export))
    throw Error('INPUT_REVISION_CONFLICT');
  const materials: ReviewFileInput['materials'] = [];
  for (const pin of manifest.materials) {
    const material = (await ctx.pool.query('SELECT object_key,media_type,filename,sha256 FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL',
      [ctx.run.owner_user_id, ctx.run.project_id, pin.material_id, pin.material_version])).rows[0];
    if (!material || material.sha256.trim() !== pin.sha256) throw Error('INPUT_REVISION_CONFLICT');
    materials.push({ pin, object_key: material.object_key, media_type: material.media_type, filename: material.filename });
  }
  const selected_findings = await loadReviewSelectedFindings(ctx.pool, ctx.run.owner_user_id, ctx.run.project_id, manifest);
  return { manifest, materials, selected_findings };
}

export function reviewFileStage(options: { model?: typeof codexModelStage; load?: typeof loadReviewFileInput; config?: ReturnType<typeof loadCodexAdapterConfig>;
  /** Internal test seam; production always uses the durable working-file writer. */
  writer?: typeof writeRunWorkingFile;
  /** Internal conversion-test seam; production always uses the trusted registrar. */
  registerEditor?:typeof registerReviewEditorSnapshot } = {}): RunStage {
  return { name: 'model_generation', replay: true, run: async ctx => {
    const load = () => (options.load ?? loadReviewFileInput)(ctx);
    const loaded = await load();
    const { input, request } = ctx.lease.executionVersion === 2 ? await adoptedReviewFileRequest(ctx, loaded, load, options.config)
      : { input: loaded, request: buildReviewFileRequest({ input: loaded, inputHash: ctx.run.input_hash.trim(), blobs: ctx.blobs, config: options.config }) };
    const { manifest } = input;
    const correction=manifest.review.file_delivery?.version==='review-correction-v2';
    if(correction&&Object.hasOwn(manifest.review.file_delivery!,'export')){
      if(!validCorrectionExportPin(manifest.review.file_delivery!.export))throw Error('INPUT_REVISION_CONFLICT');
      return correctionExport(ctx,input,options.writer,options.registerEditor);
    }
    const collect = async (cwd: string, intent: { call_id: string }, response: { text: string } = { text: '' }): Promise<ReviewFileResult> => {
      await request.verifyOriginals(cwd);
      const files: Record<string, FileRef> = {}, output = join(cwd, 'output');
      const retain = async (name: string, bytes: Buffer) => {
        if (!bytes.length || bytes.length > (/\.(docx|pdf)$/.test(name) ? MAX : TEXT_MAX)) return;
        const sha256 = digest(bytes), key = `${prefix(ctx)}${intent.call_id}/${sha256}/${name}`;
        await (options.writer??writeRunWorkingFile)({pool:ctx.pool,blobs:ctx.blobs,lease:ctx.lease,projectId:ctx.run.project_id,
          source:{kind:'provider',attemptId:intent.call_id,resultSchemaVersion:'codex-review-file-v1'},name,key,bytes,
          mediaType:name.endsWith('.docx') ? DOCX : name.endsWith('.pdf') ? 'application/pdf' : name.endsWith('.json') ? 'application/json' : 'text/markdown'});
        const stored = await ctx.blobs.getIfExistsBounded(key, MAX);
        if (!stored || digest(stored) !== sha256) throw Error('REVIEW_OUTPUT_STORE_FAILED');
        files[name] = { key, sha256, byte_size: bytes.length };
      };
      // Preserve the actual final response before any format conversion. Never publish it to logs.
      if (response.text.trim()) await retain('final-response.md', Buffer.from(response.text));
      let reportText: Buffer | undefined, word: Buffer | undefined;
      try { reportText = await checkedFile(output, 'report.md', TEXT_MAX); } catch { /* Optional text companion. */ }
      if (reportText) await retain('report.md', reportText);
      if(correction){
        // A final "files saved" message is not the report. Prefer the actual Word
        // report when its Markdown companion is absent; never export that message
        // into a zero-finding copy of the source.
        try { word=await checkedFile(output,'report.docx'); } catch { /* Markdown is sufficient. */ }
        if(word)await retain('model-report.docx',word);
        if(!hasReviewReportText(reportText)&&word){
          const exportDir=await mkdtemp(join(cwd,'..','review-report-text-'));
          try{
            await writeFile(join(exportDir,'report.docx'),word,{mode:0o600});
            await runFile(process.env.BONDBUDDY_WORD_PYTHON??process.env.BONDBUDDY_TEST_PYTHON??'python3',
              ['-m','bondbuddy_file_authoring.review_report_text',join(exportDir,'report.docx'),join(exportDir,'report.md')],
              {cwd:root,env:{...process.env,PYTHONPATH:join(root,'python')},timeout:120000,signal:ctx.signal,maxBuffer:1024*1024});
            reportText=await checkedFile(exportDir,'report.md',TEXT_MAX);
          }catch(error){
            if(ctx.signal.aborted)throw error;
            return {version:'codex-review-file-v1',input_hash:ctx.run.input_hash.trim(),files,error:'WORD_DELIVERY_UNAVAILABLE'};
          }finally{await rm(exportDir,{recursive:true,force:true});}
        }
        if(!hasReviewReportText(reportText))return {version:'codex-review-file-v1',input_hash:ctx.run.input_hash.trim(),files,error:'WORD_DELIVERY_UNAVAILABLE'};
        const result=await correctionFiles(ctx,input,reportText,intent.call_id,options.writer,options.registerEditor);
        return {...result,files:{...files,...result.files}};
      }
      try { word = await checkedFile(output, 'report.docx'); } catch { /* Plain CLI responses can still be exported. */ }
      if (!word) {
        const text = reportText ?? (response.text.trim() ? Buffer.from(response.text) : undefined);
        if (hasReviewReportText(text) && text.length <= TEXT_MAX) {
          const exportDir = await mkdtemp(join(cwd, '..', 'report-export-'));
          await writeFile(join(exportDir, 'returned-report.txt'), text, { mode: 0o600 });
          // A deterministic local export, never a second model call or a JSON/schema re-ask.
          try {
            await runFile(process.env.BONDBUDDY_WORD_PYTHON ?? process.env.BONDBUDDY_TEST_PYTHON ?? 'python3',
              [join(helpers, 'report_from_text.py'), join(exportDir, 'returned-report.txt'), join(exportDir, 'returned-report.docx')],
              { timeout: 120000, signal: ctx.signal, maxBuffer: 1024 * 1024 });
            word = await checkedFile(exportDir, 'returned-report.docx');
          } catch { /* Saved text remains available for delivery-only recovery. */ }
          finally { await rm(exportDir, { recursive: true, force: true }); }
        }
      }
      // A trusted local writer adds native comments to the pinned source. The model's
      // Markdown is the single finding text; no second model call or generated JSON.
      const sourcePin = manifest.review.input.source_material_ref!;
      const sourceIndex = input.materials.findIndex(m => m.pin.material_id === sourcePin.material_id && m.pin.material_version === sourcePin.material_version && m.pin.sha256 === sourcePin.sha256);
      const source = input.materials[sourceIndex];
      if (word && source && [DOCX, 'application/pdf'].includes(source.media_type)) {
        const exportDir = await mkdtemp(join(cwd, '..', 'review-annotations-'));
        try {
          const suffix = source.media_type === DOCX ? '.docx' : '.pdf';
          const original = await checkedFile(cwd, `materials/m${sourceIndex}${suffix}`);
          if (digest(original) !== sourcePin.sha256) throw Error('INPUT_REVISION_CONFLICT');
          await writeFile(join(exportDir, `source${suffix}`), original);
          const reportName = reportText ? 'returned.md' : 'returned.docx';
          await writeFile(join(exportDir, reportName), reportText ?? word);
          await writeFile(join(exportDir, 'request.json'), JSON.stringify({ pin: sourcePin, filename: source.filename,
            created_at: new Date().toISOString() }));
          await runFile(process.env.BONDBUDDY_WORD_PYTHON ?? process.env.BONDBUDDY_TEST_PYTHON ?? 'python3',
            ['-m', 'bondbuddy_file_authoring.annotate_review', join(exportDir, `source${suffix}`), join(exportDir, 'request.json'), join(exportDir, reportName), exportDir],
            { cwd: root, env: { ...process.env, PYTHONPATH: join(root, 'python') }, timeout: 300000, signal: ctx.signal, maxBuffer: 1024 * 1024 });
          for (const name of ['report.md', 'report.docx', `comments${suffix}`, 'annotations.json']) await retain(name, await checkedFile(exportDir, name, /\.(docx|pdf)$/.test(name) ? MAX : TEXT_MAX));
          word = undefined; // The canonical report with the same IDs/limits is already retained.
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          // Retain the report for recovery, but never label a missing annotated source as delivered.
          if (word) await retain('report.docx', word);
          return { version: 'codex-review-file-v1', input_hash: ctx.run.input_hash.trim(), files, error: 'WORD_DELIVERY_UNAVAILABLE' };
        } finally { await rm(exportDir, { recursive: true, force: true }); }
      }
      if (word) await retain('report.docx', word);
      return { version: 'codex-review-file-v1', input_hash: ctx.run.input_hash.trim(), files,
        ...(!files['report.docx'] ? { error: 'WORD_DELIVERY_UNAVAILABLE' as const } : {}) };
    };
    const config = options.config ?? loadCodexAdapterConfig();
    return (options.model ?? codexModelStage)({ name: 'review_file_v1', logicalCallId: 'review-file-v1',
      config: { ...config, work_root: join(process.env.BB_PARSE_STAGING_DIR ?? config.work_root, 'review-files'), max_output_bytes: 32 * 1024 * 1024 },
      buildPrompt: request.buildPrompt,
      schema: {}, validate: value => validReviewFileResult(value, ctx), resultSchemaVersion: 'codex-review-file-v1', templateVersion: correction?'review-correction-report-v3':'review-file-progress-v3',
      fileWorkspace: { prepare: request.prepare, collect } }).run(ctx);
  } };
}

export function reviewFileDeliveryStage(): RunStage {
  return { name: 'word_delivery', replay: true, run: async ctx => {
    const result = ctx.values.get('model_generation');
    if (!validReviewFileResult(result, ctx)) return { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' };
    if (result.error) return { kind: 'fail', code: 'WORD_DELIVERY_UNAVAILABLE' };
    if(result.files['revision.docx']){
      const files:Record<string,Buffer>={};
      for(const name of ['revision.docx','clean.docx','report.docx']){
        const ref=result.files[name];if(!ref)return {kind:'fail',code:'WORD_DELIVERY_UNAVAILABLE'};
        const bytes=await ctx.blobs.getIfExistsBounded(ref.key,MAX);
        if(!bytes||bytes.length!==ref.byte_size||digest(bytes)!==ref.sha256)return {kind:'fail',code:'WORD_DELIVERY_UNAVAILABLE'};
        files[name]=bytes;
      }
      const gate=await ctx.validateBeforeModelCall?.();if(gate)return gate;
      return {kind:'deliver',bytes:files['revision.docx'],cleanBytes:files['clean.docx'],attachments:[{kind:'report',bytes:files['report.docx']}],deliveryPolicy:'generated_pair_v1',wordSummary:{writer_version:'review-correction-v2',delivery_policy:'generated_pair_v1',content_review:'not_performed'}};
    }
    const file = result.files['report.docx'];
    if (!file || result.error) return { kind: 'fail', code: 'WORD_DELIVERY_UNAVAILABLE' };
    const gate = await ctx.validateBeforeModelCall?.(); if (gate) return gate;
    const bytes = await ctx.blobs.getIfExistsBounded(file.key, MAX);
    if (!bytes || bytes.length !== file.byte_size || digest(bytes) !== file.sha256) return { kind: 'fail', code: 'WORD_DELIVERY_UNAVAILABLE' };
    const attachments: {kind:'comments';bytes:Buffer;mediaType?:'application/pdf'}[] = [];
    for (const name of ['comments.docx', 'comments.pdf']) {
      const annotation = result.files[name]; if (!annotation) continue;
      const content = await ctx.blobs.getIfExistsBounded(annotation.key, MAX);
      if (!content || content.length !== annotation.byte_size || digest(content) !== annotation.sha256) return { kind:'fail', code:'WORD_DELIVERY_UNAVAILABLE' };
      attachments.push({ kind:'comments', bytes:content, ...(name.endsWith('.pdf') ? {mediaType:'application/pdf' as const} : {}) });
    }
    return { kind: 'deliver', bytes, attachments, deliveryPolicy: 'generated_review_v1',
      wordSummary: { writer_version: 'codex-review-file-v1', delivery_policy: 'generated_review_v1', content_review: 'not_performed', structured_report: 'not_requested' } };
  } };
}
