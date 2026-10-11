import { mkdir,writeFile,readFile,copyFile,lstat,realpath } from 'node:fs/promises';
import { join,resolve,extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '@bondbuddy/api/data';
import { readCheckpointedProviderResult } from '@bondbuddy/api/provider-results';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import { codexModelStage,type RunStage,type StageContext } from './run-pipeline.js';
import { loadUnifiedInput,type UnifiedInput } from './unified-input.js';

const repo=resolve(fileURLToPath(import.meta.url),'../../../..');
const helpers=join(repo,'python/bondbuddy_file_authoring');
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

export function editingSource(input:UnifiedInput){
  return [...input.materials].filter(m=>['project_output','historical','reference'].includes(m.pin.role)).sort((a,b)=>{
    const rank=(m:typeof a)=>m.pin.material_id===input.manifest.authoring.review_result?.source_material.material_id?-2:m.pin.role==='project_output'?-1:input.manifest.authoring.source_prospectuses.find(s=>s.material_id===m.pin.material_id)?.relation==='same_issuer'?0:1;
    return rank(a)-rank(b)||a.pin.material_id.localeCompare(b.pin.material_id);
  })[0]??null;
}

async function checkedFile(root:string,name:string,max=MAX){
  const path=join(root,name),stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<1||stat.size>max||await realpath(path)!==resolve(path))throw Error('WORD_OUTPUT_UNSAFE');
  return readFile(path);
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
    const input=await (options.load??loadUnifiedInput)(ctx,{originalFiles:true});
    const source=editingSource(input);
    const originals=new Map<string,string>();
    const prepare=async(cwd:string)=>{
      for(const dir of ['materials','knowledge','scratch','output'])await mkdir(join(cwd,dir),{mode:0o700});
      const materials=[];
      for(const [i,m] of input.materials.entries()){
        const suffix=m.mediaType===DOCX?'.docx':/\.(pdf|xlsx|txt|csv|png|jpg|jpeg)$/i.test(m.filename)?extname(m.filename).toLowerCase():'.bin';
        const path=`materials/m${i}${suffix}`;
        if(ctx.blobs.readToFile){
          const received=await ctx.blobs.readToFile(m.objectKey,join(cwd,path),MAX);
          if(!received||received.sha256!==m.pin.sha256)throw Error('INPUT_REVISION_CONFLICT');
        }else{
          const bytes=await ctx.blobs.getIfExistsBounded(m.objectKey,MAX);
          if(!bytes||digest(bytes)!==m.pin.sha256)throw Error('INPUT_REVISION_CONFLICT');
          await writeFile(join(cwd,path),bytes,{mode:0o400});
        }
        originals.set(path,m.pin.sha256);
        materials.push({...m.pin,filename:m.filename,path,source_information:input.manifest.authoring.source_prospectuses.find(s=>s.material_id===m.pin.material_id)??null,editing_baseline:m===source});
      }
      const knowledge=[];
      for(const [i,k] of input.manifest.authoring.knowledge.entries()){
        if(digest(k.markdown)!==k.sha256)throw Error('INPUT_REVISION_CONFLICT');
        const path=`knowledge/k${i}.md`;await writeFile(join(cwd,path),k.markdown,{mode:0o400});originals.set(path,k.sha256);
        knowledge.push({...k,markdown:undefined,local_path:path});
      }
      const data={version:'codex-file-input-v1',revision_author:`BondBuddy-${ctx.run.input_hash.trim().slice(0,12)}`,input_hash:ctx.run.input_hash.trim(),target:{issuer_name:input.manifest.issuer_name,market:input.manifest.market,offering:input.manifest.offering,details:input.manifest.update_details},
        requirements:input.requirements,materials,knowledge,source_review:input.manifest.authoring.review_result??null,previous_output:input.manifest.authoring.previous_output??null,
        baseline_path:materials.find(m=>m.editing_baseline)?.path??null,baseline_kind:!source?'none':source.pin.role==='project_output'?'project_output':source.mediaType===DOCX?'uploaded_source':'reconstructed_pdf',
        output:{tracked:'output/tracked.docx',clean:'output/clean.docx',baseline:'output/baseline.docx',delivery:'output/delivery.md'}};
      await writeFile(join(cwd,'input.json'),JSON.stringify(data,null,2),{mode:0o400});
      originals.set('input.json',digest(await readFile(join(cwd,'input.json'))));
      for(const name of ['task.md','read_material.py','word_patch.py'])await copyFile(join(helpers,name),join(cwd,name));
    };
    const collect=async(cwd:string,intent:{call_id:string})=>{
      for(const [path,hash] of originals)if(digest(await checkedFile(cwd,path))!==hash)throw Error('INPUT_REVISION_CONFLICT');
      const files:Record<string,FileRef>={};
      // Retain only bounded, regular declared artifacts in private storage, including a
      // rejected draft. Never rerun the provider just to recover a discarded Word file.
      for(const name of fileNames){
        let bytes:Buffer;
        try{bytes=await checkedFile(join(cwd,'output'),name,name==='delivery.md'?256*1024:MAX);}catch{continue;}
        const sha256=digest(bytes),key=`${prefix(ctx)}${intent.call_id}/${sha256}/${name}`;
        await ctx.blobs.put(key,bytes,name.endsWith('.docx')?DOCX:'text/markdown');
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
        baseline_kind:!source?'none':source.pin.role==='project_output'?'project_output':source.mediaType===DOCX?'uploaded_source':'reconstructed_pdf',
        source_sha256:source?.pin.sha256??null,effective_baseline_sha256:files['baseline.docx']?.sha256??null,
        authoring_summary:delivery?[delivery.slice(0,12000)]:[],
        source_issuer:source?.pin.role==='project_output'?input.manifest.issuer_name:input.manifest.authoring.source_prospectuses.find(s=>s.material_id===source?.pin.material_id)?.issuer_name??null}};
    };
    const config=options.config??loadCodexAdapterConfig();
    return (options.model??codexModelStage)({name:'file_authoring_v1',logicalCallId:'file-authoring-v1',
      config:{...config,work_root:join(process.env.BB_PARSE_STAGING_DIR??config.work_root,'file-authoring'),max_output_bytes:32*1024*1024},
      buildPrompt:async()=>`请在切换实际处理工作时发送一条独立的用户可见进度消息，严格使用 BB_PROGRESS:read_materials、BB_PROGRESS:read_knowledge、BB_PROGRESS:analyze、BB_PROGRESS:write_document、BB_PROGRESS:check_document 或 BB_PROGRESS:prepare_download 中的相应一项，并在其后用「 | 」附上一句不超过240字的用户可见工作摘要，说明刚完成或当前处理的具体步骤。每次取得中间进展都发送一条，不包含思考过程、材料正文、命令、内部路径或密钥。请先完整阅读 task.md 和 input.json，再自主使用本次原始材料和知识文件完成整份募集书及 output/ 下的交付文件。一次执行完成，不返回全文修改 JSON，不等待逐批请求。输入锁：${ctx.run.input_hash.trim()}。`,
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
