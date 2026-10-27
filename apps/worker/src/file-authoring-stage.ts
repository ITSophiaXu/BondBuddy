import { join } from 'node:path';
import { digest } from '@bondbuddy/api/data';
import { writeRunWorkingFile } from '@bondbuddy/api/run-working-files';
import { readCheckpointedProviderResult } from '@bondbuddy/api/provider-results';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import { codexModelStage,type RunStage,type StageContext } from './run-pipeline.js';
import { loadUnifiedInput } from './unified-input.js';
import { buildFileAuthoringRequest, checkedAuthoringFile as checkedFile } from './file-authoring-request.js';
import { adoptedFileAuthoringRequest } from './run-supplement-execution-request.js';
export { editingSource } from './file-authoring-request.js';

const DOCX='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX=100*1024*1024;
type FileRef={key:string;sha256:string;byte_size:number};
export type FileAuthoringResult={version:'codex-file-word-v1';input_hash:string;files:Record<string,FileRef>;summary:Record<string,unknown>;error?:string};
const fileNames=['tracked.docx','clean.docx','baseline.docx','delivery.md'] as const;
const requiredFiles=['tracked.docx','clean.docx'] as const;
function prefix(ctx:StageContext){return `owners/${ctx.run.owner_user_id}/projects/${ctx.run.project_id}/runs/${ctx.run.id}/file-authoring/`;}
function validPair(r:FileAuthoringResult,ctx:StageContext){
  return requiredFiles.every(name=>{
    const f=r.files?.[name];return f && f.key.startsWith(prefix(ctx)) && !f.key.includes('..') && /^[a-f0-9]{64}$/.test(f.sha256) && Number.isSafeInteger(f.byte_size) && f.byte_size>0 && f.byte_size<=MAX;
  });
}
export function validFileResult(value:unknown,ctx:StageContext):value is FileAuthoringResult {
  const r=value as FileAuthoringResult;
  return !!r && r.version==='codex-file-word-v1' && r.input_hash===ctx.run.input_hash.trim() && !!r.summary &&
    (r.error==='WORD_QUALITY_REJECTED' || validPair(r,ctx));
}

export function fileAuthoringStage(options:{model?:typeof codexModelStage;load?:typeof loadUnifiedInput;config?:ReturnType<typeof loadCodexAdapterConfig>}={}):RunStage{
  return {name:'model_generation',replay:true,run:async ctx=>{
    const recovery=ctx.lease.checkpoint.word_pair_delivery_recovery as {attempt_no?:number}|undefined;
    if(recovery){
      // Explicit delivery-only repair can never fall back to another provider call.
      const saved=await readCheckpointedProviderResult({pool:ctx.pool,blobs:ctx.blobs,lease:ctx.lease,
        logicalCallId:'file-authoring-v1',attemptNo:recovery.attempt_no!,validateResult:value=>validFileResult(value,ctx)});
      if(!saved)return {kind:'fail',code:'WORD_DELIVERY_UNAVAILABLE'};
      return {kind:'done',value:saved.value,checkpoint:{logical_call_id:'file-authoring-v1'}};
    }
    const load=()=> (options.load??loadUnifiedInput)(ctx,{originalFiles:true});
    const loaded=await load();
    const {input,request}=ctx.lease.executionVersion===2 ? await adoptedFileAuthoringRequest(ctx,loaded,load)
      : {input:loaded,request:buildFileAuthoringRequest({input:loaded,inputHash:ctx.run.input_hash.trim(),blobs:ctx.blobs})};
    const {source,prepare}=request;
    const collect=async(cwd:string,intent:{call_id:string})=>{
      await request.verifyOriginals(cwd);
      const files:Record<string,FileRef>={};
      // Retain only bounded, regular declared artifacts in private storage, including a
      // rejected draft. Never rerun the provider just to recover a discarded Word file.
      for(const name of fileNames){
        let bytes:Buffer;
        try{bytes=await checkedFile(join(cwd,'output'),name,name==='delivery.md'?256*1024:MAX);}catch{continue;}
        const sha256=digest(bytes),key=`${prefix(ctx)}${intent.call_id}/${sha256}/${name}`;
        await writeRunWorkingFile({pool:ctx.pool,blobs:ctx.blobs,lease:ctx.lease,projectId:ctx.run.project_id,
          source:{kind:'provider',attemptId:intent.call_id,resultSchemaVersion:'codex-file-word-v1'},name,key,bytes,
          mediaType:name.endsWith('.docx')?DOCX:'text/markdown'});
        const stored=await ctx.blobs.getIfExistsBounded(key,MAX);
        if(!stored||digest(stored)!==sha256)throw Error('AUTHORING_OUTPUT_STORE_FAILED');
        files[name]={key,sha256,byte_size:bytes.length};
      }
      if(!requiredFiles.every(name=>files[name])){
        // Keep the durable completion and usage even if a required output is missing.
        return {version:'codex-file-word-v1',input_hash:ctx.run.input_hash.trim(),files,
          summary:{validation_error:'WORD_OUTPUT_MISSING'},error:'WORD_QUALITY_REJECTED'};
      }
      const delivery=files['delivery.md']?(await checkedFile(join(cwd,'output'),'delivery.md',256*1024)).toString('utf8'):'';
      return {version:'codex-file-word-v1',input_hash:ctx.run.input_hash.trim(),files,summary:{
        baseline_kind:request.baselineKind,
        source_sha256:request.sourceHash,effective_baseline_sha256:files['baseline.docx']?.sha256??null,
        authoring_summary:delivery?[delivery.slice(0,12000)]:[],
        source_issuer:source?.pin.role==='project_output'?input.manifest.issuer_name:input.manifest.authoring.source_prospectuses.find(s=>s.material_id===source?.pin.material_id)?.issuer_name??null}};
    };
    const config=options.config??loadCodexAdapterConfig();
    return (options.model??codexModelStage)({name:'file_authoring_v1',logicalCallId:'file-authoring-v1',
      config:{...config,work_root:join(process.env.BB_PARSE_STAGING_DIR??config.work_root,'file-authoring'),max_output_bytes:32*1024*1024},
      buildPrompt:request.buildPrompt,
      schema:{},validate:value=>validFileResult(value,ctx),resultSchemaVersion:'codex-file-word-v1',templateVersion:'single-cli-authoring-v1',fileWorkspace:{prepare,collect}}).run(ctx);
  }};
}

export function fileAuthoringDeliveryStage():RunStage{
  return {name:'word_delivery',replay:true,run:async ctx=>{
    const value=ctx.values.get('model_generation');
    if(!validFileResult(value,ctx))return {kind:'fail',code:'VALIDATION_FAILED'};
    if(!validPair(value,ctx))return {kind:'fail',code:'WORD_DELIVERY_UNAVAILABLE'};
    const gate=await ctx.validateBeforeModelCall?.();if(gate)return gate;
    const read=async(name:string)=>{const f=value.files[name]!;const b=await ctx.blobs.getIfExistsBounded(f.key,MAX);if(!b||b.length!==f.byte_size||digest(b)!==f.sha256)throw Error('WORD_OUTPUT_BLOB_MISMATCH');return b;};
    // Preserve any old checker result in its original private provider record; it is not
    // rewritten as a pass. A new policy publishes just the two generated files.
    return {kind:'deliver',deliveryPolicy:'generated_pair_v1',bytes:await read('tracked.docx'),cleanBytes:await read('clean.docx'),
      wordSummary:{...value.summary,writer_version:'bondbuddy-file-word-1.0.0',delivery_policy:'generated_pair_v1',content_review:'not_performed',
        source_sha256:value.summary.source_sha256??null,baseline_hash:value.summary.baseline_hash??null,
        effective_baseline_sha256:value.summary.effective_baseline_sha256??null,plan_hash:value.summary.plan_hash??null,
        replacements:null,columns:null,pending:null,pending_review:[]}};
  }};
}
