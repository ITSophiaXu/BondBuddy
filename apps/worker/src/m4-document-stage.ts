import { join } from 'node:path';
import { digest } from '@bondbuddy/api/data';
import { writeRunWorkingFile } from '@bondbuddy/api/run-working-files';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import { codexModelStage, type RunStage, type StageContext } from './run-pipeline.js';
import { loadM4WorkerInput } from './m4-input.js';
import { checkedM4File, verifyM4Calculation,m4ArtifactPreview, M4_FILE_MAX } from './m4-file-workspace.js';
import { buildM4DocumentRequest, loadM4DocumentSkill } from './m4-document-request.js';
import { m4ActionObserver, recordM4Progress } from './m4-action-progress.js';
import { m4ModelGate,m4PinnedMethod } from './m4-method.js';
import {saveGenerationLinks,publishProjectFileLinks} from './project-file-tools.js';
import { adoptedM4DocumentRequest } from './run-supplement-execution-request.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export type M4DocumentResult = {version: 'codex-m4-document-v1'; input_hash: string; skill_sha256: string; method_hash: string;
  project_file_links?:Awaited<ReturnType<typeof saveGenerationLinks>>;
  files: Record<string, {key: string; sha256: string; byte_size: number}>; error?: 'WORD_DELIVERY_UNAVAILABLE'};
const names = ['document.docx', 'preparation-note.docx'] as const;
const prefix = (ctx: StageContext) => `owners/${ctx.run.owner_user_id}/projects/${ctx.run.project_id}/runs/${ctx.run.id}/m4-documents/`;
export function validM4DocumentResult(value: unknown, ctx: StageContext): value is M4DocumentResult {
  const v = value as M4DocumentResult | null;
  return !!v && v.version === 'codex-m4-document-v1' && v.input_hash === ctx.run.input_hash.trim()
    && /^[a-f0-9]{64}$/.test(v.skill_sha256) && /^[a-f0-9]{64}$/.test(v.method_hash) && !!v.files
    && Object.entries(v.files).every(([name, f]) => names.includes(name as typeof names[number]) && f.key.startsWith(prefix(ctx))
      && !f.key.includes('..') && f.key.endsWith(`/${f.sha256}/${name}`) && /^[a-f0-9]{64}$/.test(f.sha256)
      && Number.isSafeInteger(f.byte_size) && f.byte_size > 0 && f.byte_size <= M4_FILE_MAX)
    && (v.error === 'WORD_DELIVERY_UNAVAILABLE' || names.every(name => !!v.files[name])
      && v.files['document.docx']!.sha256!==v.files['preparation-note.docx']!.sha256);
}

export function m4DocumentStage(options: {model?: typeof codexModelStage; load?: typeof loadM4WorkerInput; config?: ReturnType<typeof loadCodexAdapterConfig>;
  /** Internal test seam; production always uses the durable working-file writer. */
  writer?: typeof writeRunWorkingFile} = {}): RunStage {
  return {name: 'model_generation', replay: true, run: async ctx => {
    const load = () => (options.load ?? loadM4WorkerInput)(ctx);
    const loaded = await load();
    if (loaded.manifest.kind !== 'document') return {kind: 'fail', code: 'INPUT_REVISION_CONFLICT'};
    const skill = loadM4DocumentSkill(loaded.manifest);
    const config = options.config ?? loadCodexAdapterConfig();
    const modelGate=await m4ModelGate(ctx,config); if(modelGate)return modelGate;
    // Validate the receipt's original method before stamping any V2 checkpoint.
    const adopted=ctx.lease.executionVersion===2 ? await adoptedM4DocumentRequest(ctx,loaded,load,skill,config) : null;
    const pinned=await m4PinnedMethod(ctx,'document',skill,config);if(pinned.gate)return pinned.gate;
    const methodHash=pinned.hash;
    if(adopted&&adopted.methodHash!==methodHash)throw Error('m4_document_method_changed');
    const {input,request}=adopted??{input:loaded,request:buildM4DocumentRequest({context:{blobs:ctx.blobs,signal:ctx.signal,inputHash:ctx.run.input_hash.trim()},
      input:loaded,skill,methodHash})};
    const observer = m4ActionObserver(ctx, 'document');
    const prepare = async (cwd: string) => { await recordM4Progress(ctx, 'm4_reading_materials'); await request.prepare(cwd); };
    const collect = async (cwd: string, intent: {call_id: string}): Promise<M4DocumentResult> => {
      await request.verifyOriginals(cwd);
      await verifyM4Calculation(ctx,cwd);
      const project_file_links=request.linkedSource?await saveGenerationLinks(ctx,request.linkedSource,cwd):undefined;
      const files: M4DocumentResult['files'] = {};
      for (const name of names) {
        let bytes: Buffer;
        try { bytes = await checkedM4File(join(cwd, 'output'), name); } catch { continue; }
        const sha256 = digest(bytes), key = `${prefix(ctx)}${intent.call_id}/${sha256}/${name}`;
        await (options.writer??writeRunWorkingFile)({pool:ctx.pool,blobs:ctx.blobs,lease:ctx.lease,projectId:ctx.run.project_id,
          source:{kind:'provider',attemptId:intent.call_id,resultSchemaVersion:'codex-m4-document-v1'},name,key,bytes,mediaType:DOCX});
        const stored = await ctx.blobs.getIfExistsBounded(key, M4_FILE_MAX);
        if (!stored || digest(stored) !== sha256) throw Error('M4_OUTPUT_STORE_FAILED');
        files[name] = {key, sha256, byte_size: bytes.length};
      }
      return {version: 'codex-m4-document-v1', input_hash: ctx.run.input_hash.trim(), skill_sha256: skill.sha256, method_hash: methodHash, files,project_file_links,
        ...(!names.every(name => files[name]) ? {error: 'WORD_DELIVERY_UNAVAILABLE' as const} : {})};
    };
    try {
      return await (options.model ?? codexModelStage)({name: 'm4_document_v1', logicalCallId: 'm4-document-v1',
        config: {...config, work_root: join(process.env.BB_PARSE_STAGING_DIR ?? config.work_root, 'm4-documents'), max_output_bytes: 32 * 1024 * 1024},
        buildPrompt: request.buildPrompt,
        schema: {}, validate: value => validM4DocumentResult(value, ctx), resultSchemaVersion: 'codex-m4-document-v1', templateVersion: `m4-document-${methodHash}`,
        onActivity: event => observer.onEvent(event), fileWorkspace: {prepare, collect}}).run(ctx);
    } finally { await observer.drain(); }
  }};
}

export function m4DocumentDeliveryStage(): RunStage {
  return {name: 'word_delivery', replay: true, run: async ctx => {
    const result = ctx.values.get('model_generation');
    if (!validM4DocumentResult(result, ctx) || result.error) return {kind: 'fail', code: 'WORD_DELIVERY_UNAVAILABLE'};
    const gate = await ctx.validateBeforeModelCall?.(); if (gate) return gate;
    const read = async (name: string) => {
      const file = result.files[name]!;
      const bytes = await ctx.blobs.getIfExistsBounded(file.key, M4_FILE_MAX);
      if (!bytes || bytes.length !== file.byte_size || digest(bytes) !== file.sha256) throw Error('M4_OUTPUT_BLOB_MISMATCH');
      return bytes;
    };
    await recordM4Progress(ctx, 'm4_registering_artifacts');
    const document=await read('document.docx'),note=await read('preparation-note.docx');
    if(result.project_file_links){
      if(result.project_file_links.target_sha256!==digest(document))throw Error('INPUT_REVISION_CONFLICT');
      await publishProjectFileLinks(ctx.pool,ctx.run.owner_user_id,ctx.run.id,result.project_file_links);
    }
    const [documentPreview,notePreview]=await Promise.all([m4ArtifactPreview(ctx,document),m4ArtifactPreview(ctx,note)]);
    return {kind: 'deliver', bytes:document, namedArtifacts: [{kind: 'preparation_note', filename: 'preparation-note.docx', bytes:note,
      ...(notePreview?{previewContent:notePreview}:{})}],
      deliveryPolicy: 'generated_review_v1', wordSummary: {writer_version: result.version, content_review: 'not_performed',...(documentPreview?{preview_content:documentPreview}:{})}};
  }};
}
