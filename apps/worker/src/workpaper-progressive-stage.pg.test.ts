// Synthetic issuer/model only; real API, queue, durable journal, Python Word
// rendering, private storage, accounting and authenticated ZIP download.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Pool} from 'pg';
import {createServer} from '@bondbuddy/api';
import {digest,transaction,type PrivateBlobs} from '@bondbuddy/api/data';
import {savePromptSnapshot} from '@bondbuddy/api/log-ops';
import {advanceWorkpaperBatch} from '@bondbuddy/api/workpapers';
import {action as runAction} from '@bondbuddy/api/queue';
import {WORKPAPER_PRICE,workpaperChapters,type WorkpaperBatch,type WorkpaperSharedPlan} from '@bondbuddy/contracts';
import {grantCredits} from '../../api/dist/billing.js';
import {catalogueXlsx} from '../../api/dist/workpaper-catalogue.test.js';
import {isolatedTestDatabase} from './test-database.js';
import {inputLockStage,materialsReadyStage,runPipelineOnce,type codexModelStage,type RunStage} from './run-pipeline.js';
import {m4DocumentStage,m4DocumentDeliveryStage} from './m4-document-stage.js';
import {loadM4WorkerInput} from './m4-input.js';
import {sharedWorkpaperDocument,stoppedWorkpaperFailure} from './workpaper-shared-stage.js';
import {loadCodexAdapterConfig,CodexOutputValidationError} from './codex-adapter.js';
import {CodexDurableJournal} from './durable-probe-journal.js';
import {projectFilesRoot} from './project-file-tools.js';
const database=await isolatedTestDatabase(undefined,'workpaper-progressive-plan');

test('progressive item plans deliver before a blocked sibling, share extraction, replay, isolate settled failures and preserve global blockers',
  {skip:!database,timeout:300000},async t=>{
  let submittedAt=0,firstDeliveryMs=0;
  const pool=new Pool({connectionString:database,max:2}),owner=randomUUID();let actor=owner,modelCalls=0,modelReplays=0,checkOnce=true,failItem=true,deliveryFail=true,globalFailure=false,sourceReads=0,reconcileFailure=false,cancelBeforeCall=false;
  let releaseSlow!:()=>void,slowStarted!:()=>void;const slowReady=new Promise<void>(r=>slowStarted=r),slowGate=new Promise<void>(r=>releaseSlow=r);
  let executions:Promise<string>[]=[];
  let failureContext:any=null;
  let sourceMismatchChecked=false;
  const directory=await mkdtemp(join(tmpdir(),'bb-shared-test-'));
  const storage=new Map<string,Buffer>();const blobs:PrivateBlobs={put:async(k,b)=>{storage.set(k,Buffer.from(b));},get:async k=>Buffer.from(storage.get(k)!),getIfExists:async k=>storage.get(k)??null,
    getIfExistsBounded:async(k,max)=>{const b=storage.get(k);if(b&&b.length>max)throw Error('too large');return b??null;},exists:async k=>storage.has(k),delete:async k=>{storage.delete(k);}};
  const origin='http://bondbuddy.test',app=createServer({pool,blobs,historicalBillingFixture:true,allowedOrigin:origin,enableRunRuntime:true,principal:async()=>({userId:actor,csrfVerified:true})});
  const send=(method:string,url:string,payload?:any)=>app.inject({method:method as any,url,payload,headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});
  const ok=async(method:string,url:string,payload?:any)=>{const r=await send(method,url,payload);assert.ok(r.statusCode<300,`${r.statusCode}: ${r.body}`);return r.json();};
  const upload=async(id:string,name:string,bytes:Buffer,media_type:string,role='other')=>{
    const base='/api/v1/projects/'+id,declaration={byte_size:bytes.length,sha256:digest(bytes)};
    const u=await ok('POST',base+'/materials/uploads',{...declaration,filename:name,media_type,role});
    assert.equal((await send('PUT',u.upload_url,bytes)).statusCode,204);
    const m=await ok('POST',base+'/materials/uploads/'+u.upload_id+'/complete',declaration);
    return {source_project_id:id,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256};
  };
  const python=async(args:string[])=>promisify(execFile)(process.env.BONDBUDDY_TEST_PYTHON??'python3',['-B',...args],{cwd:projectFilesRoot,env:{...process.env,PYTHONPATH:join(projectFilesRoot,'python')},maxBuffer:1024*1024});
  const config={...loadCodexAdapterConfig({}),model_id:'synthetic-shared-model',model_config_version:'synthetic-progressive-v1'};
  const model:typeof codexModelStage=options=>({name:options.name,replay:true,run:async ctx=>{
    const gate=await ctx.validateBeforeModelCall?.();if(gate)return gate;
    if(cancelBeforeCall){failureContext=ctx;await runAction(pool,owner,ctx.run.id,'cancel');return {kind:'stopped'};}
    const journal=new CodexDurableJournal({pool,blobs,lease:ctx.lease,validateResult:options.validate});
    const prior=await journal.latestAttempt(options.logicalCallId);
    if(prior){const saved=await journal.readCompleted(options.logicalCallId,prior.attempt_no);assert.ok(saved);modelReplays++;return {kind:'done',value:saved.value};}
    let snapshot='';
    while(!snapshot){
      const version=Number((await pool.query("SELECT COALESCE(max(version),0)+1 n FROM bb_snapshot_refs WHERE owner_user_id=$1 AND project_id=$2 AND snapshot_kind='model_request'",[owner,ctx.run.project_id])).rows[0].n);
      try{snapshot=await savePromptSnapshot(pool,blobs,{owner,projectId:ctx.run.project_id,runId:ctx.run.id,kind:'model_request',version,
        body:await options.buildPrompt(ctx),inputRevision:ctx.run.input_revision,inputHash:ctx.run.input_hash,templateVersion:options.templateVersion});}
      catch(error){if((error as {code?:string}).code!=='23505')throw error;}
    }
    const intent={owner_user_id:owner,project_id:ctx.run.project_id,job_id:ctx.lease.jobId,run_id:ctx.run.id,trace_id:ctx.run.id,
      logical_call_id:options.logicalCallId,call_id:randomUUID(),attempt_no:1,model_id:config.model_id,model_config_version:config.model_config_version,prompt_snapshot_ref:snapshot};
    const cwd=join(directory,intent.call_id);await mkdir(cwd);assert.ok(options.fileWorkspace);await options.fileWorkspace.prepare(cwd);await journal.recordIntent(intent);modelCalls++;
    const source=JSON.parse(await readFile(join(cwd,'source-data.json'),'utf8')),batch=JSON.parse(await readFile(join(cwd,'batch-input.json'),'utf8'));
    assert.equal(batch.entries.length,1,'each model call receives exactly the current item');
    const entry=batch.entries[0];
    if(entry.code==='2'&&!globalFailure){slowStarted();await slowGate;}
    if(globalFailure||entry.code==='3'&&failItem){
      failItem=false;failureContext=ctx;
      await journal.recordObservation({...intent,provider_request_id:null,finish_reason:'stop',outcome:'failed',result_ref:null,result_sha256:null,result_schema_version:null,result_byte_size:null,
        usage:globalFailure?{status:'unknown',input_tokens:null,cached_input_tokens:null,output_tokens:null,reasoning_tokens:null,total_tokens:null}:{status:'measured',input_tokens:1000,cached_input_tokens:0,output_tokens:100,reasoning_tokens:0,total_tokens:1100},
        error_code:globalFailure&&!reconcileFailure?'MODEL_PROVIDER_REQUEST_REJECTED':'MODEL_OUTPUT_SCHEMA_INVALID'});
      return {kind:'stopped'};
    }
    const facts=source.source.spans.filter((s:any)=>s.text.trim()).map((s:any)=>s.id);
    const plan:WorkpaperSharedPlan={version:'workpaper-shared-plan-v1',source_sha256:source.source.sha256,reviewed_span_ids:facts,excluded:[],
      image_reviews:source.images.map((image:any)=>({image_id:image.id,description:'合成图示，已核对图片内容和对应条目。',verified:true,item_ids:batch.entries.map((e:any)=>e.id)})),items:batch.entries.map((entry:any,index:number)=>({
      item_id:entry.id,decision:{item_id:entry.id,status:entry.code==='2'?'external_evidence':'generate',
        reason:entry.code==='2'?'募集说明书已列示子公司财务数据，但本项审计签章原件尚未包含在材料中。':'已有合成发行人的完整子公司财务数据，可形成对应财务核查清单。',
        missing_materials:entry.code==='2'?['子公司2024年度签章审计报告']:[],citations:[{span_id:'p0',quote:source.source.spans[0].text}]},
      required_evidence:entry.title+'所需的子公司财务资料',facts,searched_span_ids:['p0'],narrative:[],calculations:[]}))};
    await writeFile(join(cwd,'output/batch-plan.json'),JSON.stringify(plan));
    if(!sourceMismatchChecked){
      await writeFile(join(cwd,'output/batch-plan.json'),JSON.stringify({...plan,source_sha256:'0'.repeat(64)}));
      await assert.rejects(options.fileWorkspace.collect(cwd,intent),error=>error instanceof Error&&error.message==='INPUT_REVISION_CONFLICT'&&!(error instanceof CodexOutputValidationError));
      sourceMismatchChecked=true;await writeFile(join(cwd,'output/batch-plan.json'),JSON.stringify(plan));
    }
    const value=await options.fileWorkspace.collect(cwd,intent);assert.ok(options.validate(value));
    const ref=await journal.storeResult(intent,Buffer.from(JSON.stringify(value)),options.resultSchemaVersion);
    await journal.recordObservation({...intent,...ref,provider_request_id:null,finish_reason:'stop',outcome:'completed',
      usage:{status:'measured',input_tokens:1000,cached_input_tokens:0,output_tokens:100,reasoning_tokens:0,total_tokens:1100},error_code:null});
    return {kind:'done',value};
  }});
  const stage=m4DocumentStage({model,config});
  const guarded:RunStage={...stage,run:async ctx=>{
    try{
    const input=await loadM4WorkerInput(ctx);assert.equal(input.manifest.kind,'document');
    const task=(input.manifest as any).input.workpaper;
    const source=input.materials.find(m=>m.pin.sha256===(input.manifest as any).input.source_material?.sha256)!;
    const counted={...ctx,blobs:{...ctx.blobs,getIfExistsBounded:async(key:string,max:number)=>{if(key===source.objectKey)sourceReads++;return ctx.blobs.getIfExistsBounded(key,max);}}};
    if(checkOnce&&task.entry.code==='1'){
      checkOnce=false;
      assert.deepEqual(await sharedWorkpaperDocument({...ctx,run:{...ctx.run,owner_user_id:'foreign'}},input,model,config),{kind:'fail',code:'INPUT_REVISION_CONFLICT'});
      // Crash precisely after durable model acceptance but before plan caching.
      const crashingPool=new Proxy(pool,{get(target,key){if(key==='query')return async(...args:any[])=>{if(typeof args[0]==='string'&&args[0].startsWith('INSERT INTO bb_workpaper_progressive_plans'))throw Error('SYNTHETIC_CACHE_CRASH');return (target.query as any)(...args);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
      assert.deepEqual(await stage.run({...counted,pool:crashingPool}),{kind:'pause',stage:'capability_not_ready',reason:'workpaper_authoring_unavailable'});
      assert.ok(modelCalls<=2);
      assert.deepEqual(await sharedWorkpaperDocument(ctx,input,model,{...config,model_config_version:'changed'}),{kind:'pause',stage:'capability_not_ready',reason:'m4_document_method_changed'});
      assert.ok(modelCalls<=2);
    }
    const result=await stage.run(counted);
    if(task.entry.code==='3'&&result.kind==='done'&&deliveryFail){deliveryFail=false;return {kind:'fail',code:'WORD_DELIVERY_UNAVAILABLE'};}
    return result;
    }catch(error){process.stderr.write('Progressive synthetic test stage: '+String(error instanceof Error?error.stack:error)+'\n');throw error;}
  }};
  const execute=()=>runPipelineOnce({pool,blobs,runKinds:['generation'],leaseSeconds:120,stages:[inputLockStage,materialsReadyStage,guarded,m4DocumentDeliveryStage()],onUnexpectedError:e=>assert.fail(JSON.stringify(e))});
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'shared_'+owner.slice(0,8)]);
    await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:randomUUID(),points:100000,expiresAt:null,actor:'synthetic',reason:'isolated shared test'}));
    const project=await ok('POST','/api/v1/projects',{kind:'generation',name:'合成共享计划测试',issuer_name:'合成发行人集团',market:'sse',offering:'public'}),id=project.project_id,path='/api/v1/projects/'+id,base=path+'/workpapers';
    await python(['-c',"from runpy import run_path; import sys; run_path('python/tests/test_workpaper_shared_batch.py')['fixture'](sys.argv[1], 12)",directory]);
    await python(['-c',"from pathlib import Path; from PIL import Image; from docx import Document; import sys; p=Path(sys.argv[1]); Image.new('RGB',(200,80),'navy').save(p/'diagram.png'); d=Document(p/'source.docx'); d.add_picture(str(p/'diagram.png')); d.save(p/'source.docx')",directory]);
    const DOCX='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    await upload(id,'synthetic-prospectus.docx',await readFile(join(directory,'source.docx')),DOCX,'historical');
    const versions=await ok('GET',path+'/prospectus-versions');
    const adopted=await ok('POST',path+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:0,version_id:versions.versions[0].version_id});
    const material=await upload(id,'synthetic-catalogue.xlsx',await catalogueXlsx(3),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const cat=await ok('POST',base+'/catalogues',{request_id:randomUUID(),material});
    const request={progressive:{chapter_order:workpaperChapters(cat.entries).map(c=>c.id)},start_mode:'direct',request_id:randomUUID(),catalogue_id:cat.catalogue_id,catalogue_sha256:cat.sha256,item_ids:cat.entries.map((e:any)=>e.id),source_version_id:adopted.current_version_id,source_selection_revision:adopted.selection_revision,
      requirements:'仅处理所选目录，正文不写来源。',price_version:WORKPAPER_PRICE.version,expected_points:String(3*WORKPAPER_PRICE.points)};
    submittedAt=performance.now();let batch=await ok('POST',base+'/batches',request) as WorkpaperBatch;
    const read=async()=>((await ok('GET',base)).batches as WorkpaperBatch[]).find(b=>b.batch_id===batch.batch_id)!;
    await advanceWorkpaperBatch(pool);await advanceWorkpaperBatch(pool);
    executions=[execute(),execute()];
    await Promise.race([slowReady,Promise.all(executions).then(()=>assert.fail('two workers must enter their independent model plans'))]);
    assert.equal(await Promise.race(executions),'succeeded');firstDeliveryMs=Math.round(performance.now()-submittedAt);
    batch=await read();assert.equal(batch.items[0].artifacts.length,1,'the first file is downloadable while the second model is unfinished');
    assert.equal(batch.items[1].state,'running');assert.equal(modelCalls,2);assert.equal(modelReplays,1);assert.equal(sourceReads,1,'concurrent first runs extract the source exactly once');
    const firstZip=await send('GET',base+`/batches/${batch.batch_id}/download`);assert.equal(firstZip.statusCode,200);
    releaseSlow();assert.deepEqual(await Promise.all(executions),['succeeded','succeeded']);
    batch=await read();assert.equal(batch.state,'paused','a cache persistence failure requires explicit recovery');
    batch=await ok('POST',base+`/batches/${batch.batch_id}/actions`,{action:'resume',expected_revision:batch.revision});
    assert.equal((await pool.query('SELECT count(*) n FROM bb_workpaper_shared_sources')).rows[0].n,'1');
    assert.equal((await pool.query('SELECT count(*) n FROM bb_workpaper_progressive_plans')).rows[0].n,'2');
    assert.equal((await pool.query('SELECT count(*) n FROM bb_workpaper_shared_plans')).rows[0].n,'0','legacy shared plans are untouched');
    await assert.rejects(pool.query("DELETE FROM bb_workpaper_progressive_plans"),{code:'23514'});
    const cached=(await pool.query('SELECT snapshot FROM bb_workpaper_shared_sources')).rows[0].snapshot;
    assert.equal(cached.images[0].data,undefined);assert.ok(storage.has(cached.images[0].key));
    await advanceWorkpaperBatch(pool);assert.equal(await execute(),'stopped');
    assert.equal(await stoppedWorkpaperFailure(failureContext,batch.batch_id,batch.items[2].entry.id,'workpaper-progressive-item-v1'),'MODEL_OUTPUT_SCHEMA_INVALID');
    assert.equal(await stoppedWorkpaperFailure({...failureContext,run:{...failureContext.run,owner_user_id:'foreign'}},batch.batch_id,batch.items[2].entry.id,'workpaper-progressive-item-v1'),null);
    assert.equal(await stoppedWorkpaperFailure(failureContext,batch.batch_id,batch.items[0].entry.id,'workpaper-progressive-item-v1'),null);
    await advanceWorkpaperBatch(pool);batch=await read();assert.equal(batch.state,'partial');
    batch=await ok('POST',base+`/batches/${batch.batch_id}/actions`,{action:'retry_failed',expected_revision:batch.revision});
    await advanceWorkpaperBatch(pool);assert.equal(await execute(),'failed');
    await advanceWorkpaperBatch(pool);batch=await read();assert.equal(batch.state,'partial');
    assert.equal(modelCalls,4,'only the failed item invokes a new model');
    batch=await ok('POST',base+`/batches/${batch.batch_id}/actions`,{action:'retry_failed',expected_revision:batch.revision});
    await advanceWorkpaperBatch(pool);assert.equal(await execute(),'succeeded');await advanceWorkpaperBatch(pool);batch=await read();
    assert.equal(batch.state,'complete');assert.equal(modelCalls,4,'a delivery retry reuses its accepted item plan');assert.equal(modelReplays,1);assert.equal(sourceReads,1);assert.equal(sourceMismatchChecked,true);
    assert.equal(batch.charged_points,String(2*WORKPAPER_PRICE.points));assert.equal(batch.items[2].attempt,3);assert.ok(batch.items[1].explanation);
    assert.equal((await pool.query('SELECT count(*) n FROM bb_workpaper_progressive_plans')).rows[0].n,'3');
    const zip=await send('GET',base+`/batches/${batch.batch_id}/download`);assert.equal(zip.statusCode,200);await writeFile(join(directory,'delivery.zip'),zip.rawPayload);
    await python(['-c',`from zipfile import ZipFile\nfrom io import BytesIO\nfrom docx import Document\nimport sys\nwith ZipFile(sys.argv[1]) as z:\n assert len(z.namelist()) == 3\n assert sum(n.startswith('不适用说明/') for n in z.namelist()) == 1\n for n in z.namelist():\n  assert n.endswith('.docx') and 'preparation' not in n\n  d=Document(BytesIO(z.read(n)))\n  text=''.join(d.element.body.itertext())\n  assert '合成主体12' in text and '原文空白' in text\n  assert '资料来源' not in text and '第12页' not in text and 'span_id' not in text\n  assert len(d.tables[0].rows) == 15\n`,join(directory,'delivery.zip')]);
    actor=randomUUID();assert.equal((await send('GET',base+`/batches/${batch.batch_id}/download`)).statusCode,404);actor=owner;
    assert.equal((await pool.query('SELECT count(*) n FROM bb_model_call_attempts')).rows[0].n,'4');
    t.diagnostic(JSON.stringify({boundary:'synthetic model; real API, queue, PostgreSQL, Python rendering and storage',first_delivery_from_submission_ms:firstDeliveryMs,total_with_injected_failures_and_retries_ms:Math.round(performance.now()-submittedAt),source_extractions:sourceReads,model_calls:modelCalls,parallel_limit:2}));
    globalFailure=true;batch=await ok('POST',base+'/batches',{...request,request_id:randomUUID()});
    await advanceWorkpaperBatch(pool);assert.equal(await execute(),'stopped');
    batch=await read();assert.equal(batch.state,'paused');await advanceWorkpaperBatch(pool);assert.equal(await advanceWorkpaperBatch(pool),false);batch=await read();
    assert.equal(batch.items.filter(i=>i.state==='queued').length,2,'a model capability/provider rejection blocks untouched siblings');
    assert.equal(await stoppedWorkpaperFailure(failureContext,batch.batch_id,batch.items[0].entry.id,'workpaper-progressive-item-v1'),'MODEL_PROVIDER_REQUEST_REJECTED');
    batch=await ok('POST',base+`/batches/${batch.batch_id}/actions`,{action:'cancel',expected_revision:batch.revision});
    cancelBeforeCall=true;batch=await ok('POST',base+'/batches',{...request,request_id:randomUUID()});
    await advanceWorkpaperBatch(pool);assert.equal(await execute(),'stopped');batch=await read();
    assert.equal(batch.items[0].state,'cancelled');assert.equal(batch.state,'running','stopped cancellation is not a shared preparation failure');
    assert.equal(await stoppedWorkpaperFailure(failureContext,batch.batch_id,batch.items[0].entry.id,'workpaper-progressive-item-v1'),null);
    batch=await ok('POST',base+`/batches/${batch.batch_id}/actions`,{action:'cancel',expected_revision:batch.revision});
    await advanceWorkpaperBatch(pool); // Settle the accepted cancelled run before scheduling the next independent scenario.
    cancelBeforeCall=false;reconcileFailure=true;batch=await ok('POST',base+'/batches',{...request,request_id:randomUUID()});
    await advanceWorkpaperBatch(pool);assert.equal(await execute(),'stopped');
    assert.equal(await stoppedWorkpaperFailure(failureContext,batch.batch_id,batch.items[0].entry.id,'workpaper-progressive-item-v1'),null,'unmeasured failure must remain in reconciliation');
    await advanceWorkpaperBatch(pool);batch=await read();assert.equal(batch.state,'paused');
    assert.equal(batch.items[0].state,'paused');assert.equal(batch.items.filter(i=>i.state==='queued').length,2);

  }finally{releaseSlow();await Promise.allSettled(executions);await app.close();await pool.end();await rm(directory,{recursive:true,force:true});}
});
