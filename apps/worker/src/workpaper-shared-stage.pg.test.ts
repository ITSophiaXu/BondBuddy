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
import {WORKPAPER_PRICE,type WorkpaperBatch,type WorkpaperSharedPlan} from '@bondbuddy/contracts';
import {grantCredits} from '../../api/dist/billing.js';
import {catalogueXlsx} from '../../api/dist/workpaper-catalogue.test.js';
import {isolatedTestDatabase} from './test-database.js';
import {inputLockStage,materialsReadyStage,runPipelineOnce,type codexModelStage,type RunStage} from './run-pipeline.js';
import {m4DocumentStage,m4DocumentDeliveryStage} from './m4-document-stage.js';
import {loadM4WorkerInput} from './m4-input.js';
import {sharedWorkpaperDocument} from './workpaper-shared-stage.js';
import {loadCodexAdapterConfig} from './codex-adapter.js';
import {CodexDurableJournal} from './durable-probe-journal.js';
import {projectFilesRoot} from './project-file-tools.js';
const database=await isolatedTestDatabase(undefined,'workpaper-shared-plan');

test('one batch plan across deliveries, crash replay, failure/retry, pause, immutable owner cache, refund and source-free ZIP',
  {skip:!database,timeout:300000},async()=>{
  const pool=new Pool({connectionString:database}),owner=randomUUID();let actor=owner,modelCalls=0,modelReplays=0,checkOnce=true,failItem=true;
  const directory=await mkdtemp(join(tmpdir(),'bb-shared-test-'));
  const storage=new Map<string,Buffer>();const blobs:PrivateBlobs={put:async(k,b)=>{storage.set(k,Buffer.from(b));},get:async k=>Buffer.from(storage.get(k)!),getIfExists:async k=>storage.get(k)??null,
    getIfExistsBounded:async(k,max)=>{const b=storage.get(k);if(b&&b.length>max)throw Error('too large');return b??null;},exists:async k=>storage.has(k),delete:async k=>{storage.delete(k);}};
  const origin='http://bondbuddy.test',app=createServer({pool,blobs,allowedOrigin:origin,enableRunRuntime:true,
    // Replay the original 4500-point contract, retired assessment and progress-refund semantics.
    historicalBillingFixture:true,principal:async()=>({userId:actor,csrfVerified:true})});
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
  const config={...loadCodexAdapterConfig({}),model_id:'synthetic-shared-model',model_config_version:'synthetic-shared-v1'};
  const model:typeof codexModelStage=options=>({name:options.name,replay:true,run:async ctx=>{
    const gate=await ctx.validateBeforeModelCall?.();if(gate)return gate;
    const journal=new CodexDurableJournal({pool,blobs,lease:ctx.lease,validateResult:options.validate});
    const prior=await journal.latestAttempt(options.logicalCallId);
    if(prior){const saved=await journal.readCompleted(options.logicalCallId,prior.attempt_no);assert.ok(saved);modelReplays++;return {kind:'done',value:saved.value};}
    const version=Number((await pool.query("SELECT COALESCE(max(version),0)+1 n FROM bb_snapshot_refs WHERE owner_user_id=$1 AND project_id=$2 AND snapshot_kind='model_request'",[owner,ctx.run.project_id])).rows[0].n);
    const snapshot=await savePromptSnapshot(pool,blobs,{owner,projectId:ctx.run.project_id,runId:ctx.run.id,kind:'model_request',version,
      body:await options.buildPrompt(ctx),inputRevision:ctx.run.input_revision,inputHash:ctx.run.input_hash,templateVersion:options.templateVersion});
    const intent={owner_user_id:owner,project_id:ctx.run.project_id,job_id:ctx.lease.jobId,run_id:ctx.run.id,trace_id:ctx.run.id,
      logical_call_id:options.logicalCallId,call_id:randomUUID(),attempt_no:1,model_id:config.model_id,model_config_version:config.model_config_version,prompt_snapshot_ref:snapshot};
    const cwd=join(directory,intent.call_id);await mkdir(cwd);assert.ok(options.fileWorkspace);await options.fileWorkspace.prepare(cwd);await journal.recordIntent(intent);modelCalls++;
    const source=JSON.parse(await readFile(join(cwd,'source-data.json'),'utf8')),batch=JSON.parse(await readFile(join(cwd,'batch-input.json'),'utf8'));
    const facts=source.source.spans.filter((s:any)=>s.text.trim()).map((s:any)=>s.id);
    const plan:WorkpaperSharedPlan={version:'workpaper-shared-plan-v1',source_sha256:source.source.sha256,reviewed_span_ids:facts,excluded:[],
      image_reviews:source.images.map((image:any)=>({image_id:image.id,description:'合成图示，已核对图片内容和对应条目。',verified:true,item_ids:batch.entries.map((e:any)=>e.id)})),items:batch.entries.map((entry:any,index:number)=>({
      item_id:entry.id,decision:{item_id:entry.id,status:index===1?'external_evidence':'generate',
        reason:index===1?'募集说明书已列示子公司财务数据，但本项审计签章原件尚未包含在材料中。':'已有合成发行人的完整子公司财务数据，可形成对应财务核查清单。',
        missing_materials:index===1?['子公司2024年度签章审计报告']:[],citations:[{span_id:'p0',quote:source.source.spans[0].text}]},
      required_evidence:entry.title+'所需的子公司财务资料',facts,searched_span_ids:['p0'],narrative:[],calculations:[]}))};
    await writeFile(join(cwd,'output/batch-plan.json'),JSON.stringify(plan));
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
    if(task.entry.code==='3'&&failItem){failItem=false;return {kind:'fail',code:'WORD_DELIVERY_UNAVAILABLE'};}
    if(checkOnce){
      checkOnce=false;
      assert.deepEqual(await sharedWorkpaperDocument({...ctx,run:{...ctx.run,owner_user_id:'foreign'}},input,model,config),{kind:'fail',code:'INPUT_REVISION_CONFLICT'});
      // Crash precisely after durable model acceptance but before plan caching.
      const crashingPool=new Proxy(pool,{get(target,key){if(key==='query')return async(...args:any[])=>{if(typeof args[0]==='string'&&args[0].startsWith('INSERT INTO bb_workpaper_shared_plans'))throw Error('SYNTHETIC_CACHE_CRASH');return (target.query as any)(...args);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
      await assert.rejects(stage.run({...ctx,pool:crashingPool}),/SYNTHETIC_CACHE_CRASH/);
      assert.equal(modelCalls,1);
      assert.deepEqual(await sharedWorkpaperDocument(ctx,input,model,{...config,model_config_version:'changed'}),{kind:'pause',stage:'capability_not_ready',reason:'m4_document_method_changed'});
      assert.equal(modelCalls,1);
    }
    return await stage.run(ctx);
    }catch(error){process.stderr.write('Shared synthetic test stage: '+String(error instanceof Error?error.stack:error)+'\n');throw error;}
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
    const request={start_mode:'direct',request_id:randomUUID(),catalogue_id:cat.catalogue_id,catalogue_sha256:cat.sha256,item_ids:cat.entries.map((e:any)=>e.id),source_version_id:adopted.current_version_id,source_selection_revision:adopted.selection_revision,
      requirements:'仅处理所选目录，正文不写来源。',price_version:WORKPAPER_PRICE.version,expected_points:String(3*WORKPAPER_PRICE.points)};
    // Independent current Pool avoids changing the historical worker's out-of-request billing context.
    const currentPool=new Pool({connectionString:database});
    const currentApp=createServer({pool:currentPool,blobs,allowedOrigin:origin,principal:async()=>({userId:actor,csrfVerified:true})});
    try{
      const workspace=await currentApp.inject({method:'GET',url:base,headers:{origin}});
      assert.equal(workspace.statusCode,200,workspace.body);assert.equal(workspace.json().price.auto_charge,true);
      assert.notEqual(workspace.json().price.version,WORKPAPER_PRICE.version);
      const rejected=await currentApp.inject({method:'POST',url:base+'/batches',payload:request,headers:{origin}});
      assert.equal(rejected.statusCode,409,rejected.body);assert.equal(rejected.json().code,'QUOTE_CHANGED');
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_workpaper_batches WHERE project_id=$1',[id])).rows[0].n,0);
    }finally{await currentApp.close();await currentPool.end();}
    let batch=await ok('POST',base+'/batches',request) as WorkpaperBatch;
    const read=async()=>((await ok('GET',base)).batches as WorkpaperBatch[]).find(b=>b.batch_id===batch.batch_id)!;
    await advanceWorkpaperBatch(pool);assert.equal(await execute(),'succeeded');assert.equal(modelCalls,1);assert.equal(modelReplays,1);
    batch=await read();assert.equal(batch.state,'paused','a failed shared-plan cache must stop automatic retries on every file');
    batch=await ok('POST',base+`/batches/${batch.batch_id}/actions`,{action:'resume',expected_revision:batch.revision});
    assert.equal((await pool.query('SELECT count(*) n FROM bb_workpaper_shared_sources')).rows[0].n,'1');
    const cached=(await pool.query('SELECT snapshot FROM bb_workpaper_shared_sources')).rows[0].snapshot;
    assert.equal(cached.images.length,1);assert.equal(cached.images[0].data,undefined);assert.ok(storage.has(cached.images[0].key),'image bytes are kept in private Blob, outside PostgreSQL');
    assert.equal((await pool.query('SELECT count(*) n FROM bb_workpaper_shared_plans')).rows[0].n,'1');
    await assert.rejects(pool.query("UPDATE bb_workpaper_shared_sources SET snapshot_hash=$1",['a'.repeat(64)]),{code:'23514'});
    await assert.rejects(pool.query("DELETE FROM bb_workpaper_shared_plans"),{code:'23514'});
    batch=await read();batch=await ok('POST',base+`/batches/${batch.batch_id}/actions`,{action:'pause',expected_revision:batch.revision});
    assert.equal(await advanceWorkpaperBatch(pool),false);assert.equal(modelCalls,1);
    batch=await ok('POST',base+`/batches/${batch.batch_id}/actions`,{action:'resume',expected_revision:batch.revision});
    await advanceWorkpaperBatch(pool);assert.equal(await execute(),'succeeded');
    await advanceWorkpaperBatch(pool);assert.equal(await execute(),'failed');
    await advanceWorkpaperBatch(pool);batch=await read();assert.equal(batch.state,'partial');
    batch=await ok('POST',base+`/batches/${batch.batch_id}/actions`,{action:'retry_failed',expected_revision:batch.revision});
    await advanceWorkpaperBatch(pool);assert.equal(await execute(),'succeeded');await advanceWorkpaperBatch(pool);batch=await read();
    assert.equal(batch.state,'complete');assert.equal(modelCalls,1);assert.equal(modelReplays,1);assert.equal(batch.charged_points,String(2*WORKPAPER_PRICE.points));
    assert.equal(batch.items[2].attempt,2);assert.ok(batch.items[1].explanation);
    const zip=await send('GET',base+`/batches/${batch.batch_id}/download`);assert.equal(zip.statusCode,200);await writeFile(join(directory,'delivery.zip'),zip.rawPayload);
    await python(['-c',`from zipfile import ZipFile\nfrom io import BytesIO\nfrom docx import Document\nimport sys\nwith ZipFile(sys.argv[1]) as z:\n assert len(z.namelist()) == 3\n assert sum(n.startswith('不适用说明/') for n in z.namelist()) == 1\n for n in z.namelist():\n  assert n.endswith('.docx') and 'preparation' not in n\n  d=Document(BytesIO(z.read(n)))\n  text=''.join(d.element.body.itertext())\n  assert '合成主体12' in text and '原文空白' in text\n  assert '资料来源' not in text and '第12页' not in text and 'span_id' not in text\n  assert len(d.tables[0].rows) == 15\n`,join(directory,'delivery.zip')]);
    actor=randomUUID();assert.equal((await send('GET',base+`/batches/${batch.batch_id}/download`)).statusCode,404);actor=owner;
    assert.equal((await pool.query('SELECT count(*) n FROM bb_model_call_attempts')).rows[0].n,'1');
  }finally{await app.close();await pool.end();await rm(directory,{recursive:true,force:true});}
});
