import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Value} from '@sinclair/typebox/value';
import {WorkpaperSharedPlanSchema,type WorkpaperSharedPlan,type M4DocumentManifest,type ProjectFileText,type ProjectFileLink} from '@bondbuddy/contracts';
import {digest} from '@bondbuddy/api/data';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {checkpointStage} from '@bondbuddy/api/queue';
import {loadWorkpaperTemplate,publishWorkpaperItemResult,pauseSharedWorkpaperBatch} from '@bondbuddy/api/workpapers';
import {projectFilesRoot,projectFilePython} from './project-file-tools.js';
import {codexModelStage,type StageContext,type StageOutcome} from './run-pipeline.js';
import {loadCodexAdapterConfig,CodexOutputValidationError,type CodexAdapterConfig} from './codex-adapter.js';
import {loadM4RuntimeSkill} from './m4-runtime-skills.js';
import {m4ModelGate} from './m4-method.js';
import {m4ActionObserver,recordM4Progress} from './m4-action-progress.js';
import {checkedM4File,M4_FILE_MAX,m4ToolHashes} from './m4-file-workspace.js';
import {verifiedFileLinks} from './project-file-evidence.js';
import type {M4WorkerInput} from './m4-input.js';
import type {M4DocumentResult} from './m4-document-stage.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const MAX_SNAPSHOT=64*1024*1024;
type SharedSource={version:'workpaper-source-v1';source:ProjectFileText;tables:unknown[];images:{id:string;name:string;sha256:string;data?:string;key?:string;page?:number}[]};
const hash=(v:unknown)=>inputManifestHash(v);
async function python(ctx:StageContext,args:string[]){
  return promisify(execFile)(process.env.BONDBUDDY_WORD_PYTHON??process.env.BONDBUDDY_TEST_PYTHON??'python3',
    ['-B',join(projectFilesRoot,'python/bondbuddy_workpaper_batch.py'),...args],
    {cwd:projectFilesRoot,env:{...process.env,PYTHONPATH:join(projectFilesRoot,'python'),PYTHONDONTWRITEBYTECODE:'1'},signal:ctx.signal,timeout:300000,maxBuffer:16384});
}
async function jsonFile(dir:string,name:string,value:unknown){
  await writeFile(join(dir,name),JSON.stringify(value),{mode:0o600});
}
export function sharedPlanIdentity(manifests:M4DocumentManifest[]){
  return hash({version:'workpaper-shared-v1',manifests});
}
export function checkedSharedPlan(value:unknown,source:SharedSource,manifests:M4DocumentManifest[]):value is WorkpaperSharedPlan{
  if(!Value.Check(WorkpaperSharedPlanSchema,value)||value.source_sha256!==source.source.sha256)return false;
  const expected=manifests.map(m=>m.input.workpaper!.entry.id),actual=value.items.map(i=>i.item_id);
  return new Set(actual).size===actual.length&&actual.length===expected.length&&expected.every(id=>actual.includes(id));
}

/** Only the first item needs a model. Subsequent item runs render this immutable
 * plan; item attempts, credit rules, cancellation and authorized downloads stay
 * on the existing pipeline. Legacy batches never enter this path. */
export async function sharedWorkpaperDocument(ctx:StageContext,input:M4WorkerInput,model=codexModelStage,providedConfig?:CodexAdapterConfig):Promise<StageOutcome>{
  if(input.manifest.kind!=='document')return {kind:'fail',code:'INPUT_REVISION_CONFLICT'};
  const task=input.manifest.input.workpaper!;
  const owner=ctx.run.owner_user_id,batch=task.batch_id;
  const imagePrefix=`owners/${owner}/projects/${ctx.run.project_id}/workpaper-batches/${batch}/source-images/`;
  const imageBytes=async(image:SharedSource['images'][number])=>{
    if(!image.key||!image.key.startsWith(imagePrefix)||image.key!==imagePrefix+image.sha256)throw Error('WORKPAPER_IMAGE_UNSAFE');
    const bytes=await ctx.blobs.getIfExistsBounded(image.key,M4_FILE_MAX);
    if(!bytes||digest(bytes)!==image.sha256)throw Error('WORKPAPER_IMAGE_HASH_MISMATCH');
    return bytes;
  };
  const rows=(await ctx.pool.query(`SELECT i.manifest FROM bb_workpaper_items i JOIN bb_workpaper_batches b ON b.owner_user_id=i.owner_user_id AND b.id=i.batch_id
    WHERE i.owner_user_id=$1 AND i.batch_id=$2 ORDER BY i.ordinal`,[owner,batch])).rows;
  const manifests=rows.map(r=>r.manifest as M4DocumentManifest);
  if(!manifests.length||manifests.some(m=>m.input.workpaper?.execution!=='shared_batch_v1')||!manifests.some(m=>hash(m)===hash(input.manifest)))
    return {kind:'fail',code:'INPUT_REVISION_CONFLICT'};
  const identity=sharedPlanIdentity(manifests),config=providedConfig??loadCodexAdapterConfig();
  const gate=await m4ModelGate(ctx,config);if(gate)return gate;
  const skill=loadM4RuntimeSkill('m4-workpaper-batch');
  const method=hash({version:'workpaper-shared-method-v1',skill:skill.sha256,
    helper:digest(await readFile(join(projectFilesRoot,'python/bondbuddy_workpaper_batch.py'))),
    sourceHelper:digest(await readFile(join(projectFilesRoot,'python/bondbuddy_workpaper_source.py'))),
    tools:await m4ToolHashes(),
    templates:digest(await readFile(join(projectFilesRoot,'knowledge/workpaper-templates/2026-10-27/catalog.json'))),
    model:{id:config.model_id,provider:config.model_provider,base:config.base_url,version:config.model_config_version,reasoning:config.reasoning_effort}});
  const methodKey='workpaper_shared_method_v1',prior=ctx.checkpoint[methodKey];
  if(prior&&prior.hash!==method)return {kind:'pause',stage:'capability_not_ready',reason:'m4_document_method_changed'};
  if(!prior){await checkpointStage(ctx.pool,ctx.lease,methodKey,{hash:method});ctx.checkpoint[methodKey]={hash:method};}
  const dir=await mkdtemp(join(tmpdir(),'bb-shared-workpapers-'));
  const batchInput={entries:manifests.map(m=>m.input.workpaper!.entry),issuer_name:input.manifest.input.fields.issuer_name,
    requirements:input.manifest.input.supplemental_requirements??'',templates:manifests.map(m=>({item_id:m.input.workpaper!.entry.id,template_id:m.knowledge?.template?.id}))};
  try{
    let sourceRow=(await ctx.pool.query('SELECT * FROM bb_workpaper_shared_sources WHERE owner_user_id=$1 AND batch_id=$2',[owner,batch])).rows[0];
    if(!sourceRow){
      await recordM4Progress(ctx,'m4_reading_materials');
      const pin=input.manifest.input.source_material!,material=input.materials.find(m=>hash(m.pin)===hash(pin));
      if(!material)throw Error('WORKPAPER_SOURCE_UNAVAILABLE');
      const sourceGate=await ctx.validateBeforeModelCall?.();if(sourceGate)return sourceGate;
      const bytes=await ctx.blobs.getIfExistsBounded(material.objectKey,M4_FILE_MAX);
      if(!bytes||digest(bytes)!==pin.sha256)throw Error('INPUT_REVISION_CONFLICT');
      const path=join(dir,material.mediaType==='application/pdf'?'source.pdf':'source.docx');
      await writeFile(path,bytes,{mode:0o400});await python(ctx,['extract',path,join(dir,'source-data.json')]);
      const snapshot=JSON.parse((await checkedM4File(dir,'source-data.json',MAX_SNAPSHOT)).toString('utf8')) as SharedSource;
      if(snapshot.source.sha256!==pin.sha256)throw Error('INPUT_REVISION_CONFLICT');
      // Private image bytes belong in Blob, not in PostgreSQL JSON. Later items
      // retrieve only their mapped graphics; PDF review pages are read once.
      for(const image of snapshot.images){
        const bytes=Buffer.from(image.data??'','base64');if(digest(bytes)!==image.sha256)throw Error('WORKPAPER_IMAGE_HASH_MISMATCH');
        image.key=imagePrefix+image.sha256;delete image.data;
        await ctx.blobs.put(image.key,bytes,'application/octet-stream');await imageBytes(image);
      }
      await ctx.pool.query(`INSERT INTO bb_workpaper_shared_sources(owner_user_id,batch_id,input_hash,snapshot,snapshot_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[owner,batch,identity,snapshot,hash(snapshot)]);
      sourceRow=(await ctx.pool.query('SELECT * FROM bb_workpaper_shared_sources WHERE owner_user_id=$1 AND batch_id=$2',[owner,batch])).rows[0];
    }
    if(sourceRow.input_hash.trim()!==identity||hash(sourceRow.snapshot)!==sourceRow.snapshot_hash.trim())throw Error('INPUT_REVISION_CONFLICT');
    const source=sourceRow.snapshot as SharedSource;
    await jsonFile(dir,'source-data.json',source);await jsonFile(dir,'batch-input.json',batchInput);
    let saved=(await ctx.pool.query('SELECT * FROM bb_workpaper_shared_plans WHERE owner_user_id=$1 AND batch_id=$2',[owner,batch])).rows[0];
    if(!saved){
      const observer=m4ActionObserver(ctx,'document');
      try{
        const outcome=await model({name:'workpaper_shared_plan_v1',logicalCallId:'workpaper-shared-plan-v1',config:{...config,max_schema_reasks:0,max_output_bytes:MAX_SNAPSHOT},
          schema:WorkpaperSharedPlanSchema,validate:v=>checkedSharedPlan(v,source,manifests),resultSchemaVersion:'workpaper-shared-plan-v1',templateVersion:method,
          buildPrompt:async()=>skill.content,onActivity:e=>observer.onEvent(e),
          fileWorkspace:{prepare:async cwd=>{
            for(const name of ['scratch','output','images'])await mkdir(join(cwd,name),{mode:0o700});
            await jsonFile(cwd,'input.json',batchInput);await jsonFile(cwd,'batch-input.json',batchInput);
            await jsonFile(cwd,'source-data.json',source);await jsonFile(cwd,'batch-plan-schema.json',WorkpaperSharedPlanSchema);
            for(const image of source.images){
              if(!/^image-\d+$/.test(image.id)||!/^[a-zA-Z0-9._-]+$/.test(image.name))throw Error('WORKPAPER_IMAGE_UNSAFE');
              const bytes=await imageBytes(image);
              await writeFile(join(cwd,'images',image.id+'-'+image.name),bytes,{mode:0o400});
            }
          },collect:async cwd=>{
            const plan=JSON.parse((await checkedM4File(join(cwd,'output'),'batch-plan.json',MAX_SNAPSHOT)).toString('utf8'));
            if(!checkedSharedPlan(plan,source,manifests))throw new CodexOutputValidationError('WORKPAPER_PLAN_INVALID');
            // Validate against host-owned inputs, never agent-modified files.
            await jsonFile(dir,'batch-plan.json',plan);
            try{await python(ctx,['validate',join(dir,'source-data.json'),join(dir,'batch-input.json'),join(dir,'batch-plan.json')]);}
            catch{throw new CodexOutputValidationError('WORKPAPER_PLAN_CONTENT_INVALID');}
            return plan;
          }}
        }).run(ctx);
        if(outcome.kind!=='done'){
          if(outcome.kind==='fail')await pauseSharedWorkpaperBatch(ctx.pool,owner,batch);
          return outcome;
        }
        if(!checkedSharedPlan(outcome.value,source,manifests))throw Error('WORKPAPER_PLAN_INVALID');
        // Also validate a journal replay. The model may have completed before
        // the worker crashed and before this batch cache was committed.
        await jsonFile(dir,'batch-plan.json',outcome.value);
        await python(ctx,['validate',join(dir,'source-data.json'),join(dir,'batch-input.json'),join(dir,'batch-plan.json')]);
        // Store only after the durable model journal has accepted the result.
        await ctx.pool.query(`INSERT INTO bb_workpaper_shared_plans(owner_user_id,batch_id,input_hash,method_hash,source_hash,plan,plan_hash,author_run_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[owner,batch,identity,method,hash(source),outcome.value,hash(outcome.value),ctx.run.id]);
        saved=(await ctx.pool.query('SELECT * FROM bb_workpaper_shared_plans WHERE owner_user_id=$1 AND batch_id=$2',[owner,batch])).rows[0];
      }finally{await observer.drain();}
    }
    if(saved.input_hash.trim()!==identity||saved.source_hash.trim()!==hash(source)||saved.plan_hash.trim()!==hash(saved.plan))throw Error('INPUT_REVISION_CONFLICT');
    if(saved.method_hash.trim()!==method)return {kind:'pause',stage:'capability_not_ready',reason:'m4_document_method_changed'};
    if(!checkedSharedPlan(saved.plan,source,manifests))throw Error('WORKPAPER_PLAN_INVALID');
    const plan=saved.plan as WorkpaperSharedPlan,item=plan.items.find(i=>i.item_id===task.entry.id)!;
    const beforeRender=await ctx.validateBeforeModelCall?.();if(beforeRender)return beforeRender;
    await recordM4Progress(ctx,'m4_writing_files');
    const template=loadWorkpaperTemplate({code:task.entry.code,title:item.decision.status==='generate'?task.entry.title:'不适用说明'});
    // The generation template must still match the immutable input pin.
    if(item.decision.status==='generate'&&template.sha256!==input.manifest.knowledge?.template?.sha256)throw Error('INPUT_REVISION_CONFLICT');
    await writeFile(join(dir,'template.docx'),template.bytes,{mode:0o400});await jsonFile(dir,'format.json',template.format);
    await jsonFile(dir,'batch-plan.json',plan);
    const relevantImages=new Set(plan.image_reviews.filter(r=>r.item_ids.includes(task.entry.id)).map(r=>r.image_id));
    const renderImages=await Promise.all(source.images.map(async image=>relevantImages.has(image.id)&&!image.page?{...image,data:(await imageBytes(image)).toString('base64')}:image));
    await jsonFile(dir,'source-data.json',{...source,images:renderImages});
    const out=join(dir,'output');
    await python(ctx,['render-validated',join(dir,'source-data.json'),join(dir,'batch-input.json'),join(dir,'batch-plan.json'),task.entry.id,join(dir,'template.docx'),join(dir,'format.json'),out]);
    const note=await checkedM4File(out,'preparation-note.docx');
    const outputBytes=await checkedM4File(out,'document.docx');
    await projectFilePython(ctx,['inspect',join(out,'document.docx'),join(dir,'target.json')]);
    const target=JSON.parse((await checkedM4File(dir,'target.json',MAX_SNAPSHOT)).toString('utf8')) as ProjectFileText;
    const proposed=JSON.parse((await checkedM4File(out,'file-links.json',MAX_SNAPSHOT)).toString('utf8')).links as ProjectFileLink[];
    const links=verifiedFileLinks(source.source,target,proposed,100000);
    if(links.length!==proposed.length)throw Error('WORKPAPER_CONTENT_LINKS_MISSING');
    const files:M4DocumentResult['files']={};
    for(const name of ['document.docx','preparation-note.docx']){
      const bytes=name==='document.docx'?outputBytes:note,sha256=digest(bytes);
      const key=`owners/${owner}/projects/${ctx.run.project_id}/runs/${ctx.run.id}/m4-documents/shared-${saved.plan_hash.trim()}/${sha256}/${name}`;
      await ctx.blobs.put(key,bytes,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      const readback=await ctx.blobs.getIfExistsBounded(key,M4_FILE_MAX);if(!readback||digest(readback)!==sha256)throw Error('M4_OUTPUT_STORE_FAILED');
      files[name]={key,sha256,byte_size:bytes.length};
    }
    const decision={...item.decision,citations:item.decision.citations.map(c=>({...c,location:source.source.spans.find(s=>s.id===c.span_id)!.location}))};
    // Explanations must be accepted before the next billing milestone. Otherwise
    // a low balance could pause before the existing no-charge refund is applied.
    await publishWorkpaperItemResult(ctx.pool,owner,ctx.run.id,decision,
      decision.status==='generate'?null:{...files['document.docx']!,filename:''});
    return {kind:'done',value:{version:'codex-m4-document-v1',input_hash:ctx.run.input_hash.trim(),skill_sha256:skill.sha256,method_hash:method,internal_note:true,
      workpaper_decision:decision,files,project_file_links:{links,source_sha256:source.source.sha256,target_sha256:digest(outputBytes),warnings:source.source.warnings}} satisfies M4DocumentResult};
  }catch(error){
    // A failed shared extraction/plan must not automatically repeat one expensive
    // model attempt per queued file. An explicit resume can retry the batch.
    const planned=(await ctx.pool.query('SELECT 1 FROM bb_workpaper_shared_plans WHERE owner_user_id=$1 AND batch_id=$2',[owner,batch])).rowCount;
    if(!planned)await pauseSharedWorkpaperBatch(ctx.pool,owner,batch);
    throw error;
  }finally{await rm(dir,{recursive:true,force:true});}
}
