import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createServer} from '@bondbuddy/api';
import {digest,transaction,type PrivateBlobs} from '@bondbuddy/api/data';
import {advanceWorkpaperBatch} from '@bondbuddy/api/workpapers';
import {WORKPAPER_PRICE,type WorkpaperBatch,type M4DocumentManifest} from '@bondbuddy/contracts';
import {grantCredits} from '../../api/dist/billing.js';
import {makeSyntheticDocxFixture} from '../../api/dist/docx-fixtures.js';
import {catalogueXlsx} from '../../api/dist/workpaper-catalogue.test.js';
import {isolatedTestDatabase} from './test-database.js';
import {inputLockStage,materialsReadyStage,runPipelineOnce,type RunStage} from './run-pipeline.js';
import {workpaperAssessmentStage,workpaperAssessmentDelivery} from './workpaper-assessment-stage.js';
import {loadCodexAdapterConfig} from './codex-adapter.js';
import {m4InputGate} from './m4-input.js';
const database=await isolatedTestDatabase(undefined,'workpaper-batches');

test('300 workpapers: real API, PostgreSQL queue, pinned inputs, failure isolation/retry, billing and 300 ZIP entries (synthetic content)',{skip:!database,timeout:1800000},async()=>{
  const pool=new Pool({connectionString:database}),user=randomUUID();let actor=user;
  const store=new Map<string,Buffer>();const blobs:PrivateBlobs={put:async(k,b)=>{store.set(k,Buffer.from(b));},get:async k=>Buffer.from(store.get(k)!),getIfExists:async k=>store.get(k)??null,
    getIfExistsBounded:async(k,max)=>{const b=store.get(k);if(b&&b.length>max)throw Error('too large');return b??null;},exists:async k=>store.has(k),delete:async k=>{store.delete(k);}};
  const origin='http://bondbuddy.test',app=createServer({pool,blobs,allowedOrigin:origin,enableRunRuntime:true,principal:async()=>({userId:actor,csrfVerified:true})});
  const send=(method:string,url:string,payload?:any)=>app.inject({method:method as any,url,payload,headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});
  const ok=async(method:string,url:string,payload?:any)=>{const r=await send(method,url,payload);assert.ok(r.statusCode<300,`${r.statusCode}: ${r.body}`);return r.json();};
  const upload=async(id:string,name:string,bytes:Buffer,media_type:string,role='other')=>{
    const base='/api/v1/projects/'+id,declaration={byte_size:bytes.length,sha256:digest(bytes)};
    const u=await ok('POST',base+'/materials/uploads',{...declaration,filename:name,media_type,role});
    assert.equal((await send('PUT',u.upload_url,bytes)).statusCode,204);
    const m=await ok('POST',base+'/materials/uploads/'+u.upload_id+'/complete',declaration);
    return {source_project_id:id,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256};
  };
  const DOCX='application/vnd.openxmlformats-officedocument.wordprocessingml.document';let processed=0,failOnce=true;
  const synthetic:RunStage={name:'model_generation',run:async ctx=>{
    const manifest=(await pool.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',[ctx.run.project_id,ctx.run.input_revision])).rows[0].manifest as M4DocumentManifest;
    assert.equal(manifest.input.document_type,'workpaper');assert.ok(manifest.input.workpaper);assert.match(manifest.knowledge!.content,/不替代独立核查证据/);
    processed++;if(manifest.input.workpaper.entry.code==='2'&&failOnce){failOnce=false;return {kind:'fail',code:'MODEL_TURN_FAILED'};}
    return {kind:'done',value:manifest.input.workpaper.entry.title};
  }};
  const delivery:RunStage={name:'word_delivery',run:async ctx=>({kind:'deliver',bytes:makeSyntheticDocxFixture({text:'合成底稿 '+ctx.values.get('model_generation')}),
    namedArtifacts:[{kind:'preparation_note',filename:'preparation-note.docx',bytes:makeSyntheticDocxFixture({text:'合成编制说明：实际核查尚未执行。'})}],deliveryPolicy:'generated_review_v1'})};
  const execute=()=>runPipelineOnce({pool,blobs,runKinds:['generation'],leaseSeconds:120,stages:[inputLockStage,materialsReadyStage,synthetic,delivery],onUnexpectedError:e=>assert.fail(JSON.stringify(e))});
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[user,'workpapers_'+user.slice(0,8)]);
    await transaction(pool,c=>grantCredits(c,{owner:user,source:'purchase',key:randomUUID(),points:3000000,expiresAt:null,actor:'synthetic',reason:'workpaper isolated test'}));
    const project=await ok('POST','/api/v1/projects',{kind:'generation',name:'合成底稿批量测试',issuer_name:'合成发行人',market:'sse',offering:'public'}),id=project.project_id,path='/api/v1/projects/'+id,base=path+'/workpapers';
    const source=await upload(id,'synthetic-prospectus.docx',makeSyntheticDocxFixture({text:'合成募集书：发行人总资产100万元。'}),DOCX,'historical');
    const versions=await ok('GET',path+'/prospectus-versions');
    const adopted=await ok('POST',path+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:0,version_id:versions.versions[0].version_id});
    const material=await upload(id,'synthetic-catalogue.xlsx',await catalogueXlsx(500),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const importRequest={request_id:randomUUID(),material},cat=await ok('POST',base+'/catalogues',importRequest);
    assert.equal(cat.entries.length,500);assert.deepEqual(await ok('POST',base+'/catalogues',importRequest),cat);
    const request={request_id:randomUUID(),catalogue_id:cat.catalogue_id,catalogue_sha256:cat.sha256,item_ids:cat.entries.slice(0,300).map((e:any)=>e.id),source_version_id:adopted.current_version_id,source_selection_revision:adopted.selection_revision,requirements:'缺少资料标记待补充',price_version:WORKPAPER_PRICE.version,expected_points:300*WORKPAPER_PRICE.points};
    const assess=async(req:any)=>{
      const {price_version,expected_points,assessment_id,assessment_hash,...body}=req;
      const a=await ok('POST',base+'/assessments',{...body,request_id:randomUUID()});
      const model:typeof import('./run-pipeline.js').codexModelStage=options=>({name:options.name,run:async ctx=>{
        const prompt=await options.buildPrompt(ctx),data=JSON.parse(prompt.split('ref=workpaper-assessment\n')[1].split('\nBB-DATA-')[0]);
        assert.match(prompt,/发行人总资产/);
        const value={decisions:data.entries.map((e:any)=>({item_id:e.id,status:'generate',reason:'募集书披露了相关财务资料，可编制分析稿。',missing_materials:[],citations:[{span_id:data.spans[0].id,quote:data.spans[0].text}]}))};
        assert.ok(options.validate(value));return {kind:'done',value};
      }});
      assert.equal(await runPipelineOnce({pool,blobs,runKinds:['generation'],leaseSeconds:120,stages:[inputLockStage,materialsReadyStage,workpaperAssessmentStage({model,config:()=>loadCodexAdapterConfig({})}),workpaperAssessmentDelivery()],onUnexpectedError:e=>assert.fail(JSON.stringify(e))}),'succeeded');
      const ready=(await ok('GET',base)).assessments.find((x:any)=>x.assessment_id===a.assessment_id);
      return {...req,assessment_id:a.assessment_id,assessment_hash:ready.result_hash};
    };
    assert.equal((await send('POST',base+'/batches',request)).statusCode,422);
    Object.assign(request,await assess(request));
    assert.equal((await send('POST',base+'/batches',{...request,expected_points:1})).statusCode,409);
    let batch=await ok('POST',base+'/batches',request) as WorkpaperBatch;
    assert.equal(batch.items.length,300);assert.equal((await ok('POST',base+'/batches',request)).batch_id,batch.batch_id);
    actor=randomUUID();assert.equal((await send('GET',base)).statusCode,404);assert.equal((await send('GET',base+`/batches/${batch.batch_id}/download`)).statusCode,404);actor=user;
    const read=async()=>((await ok('GET',base)).batches as WorkpaperBatch[]).find(b=>b.batch_id===batch.batch_id)!;
    await Promise.all([advanceWorkpaperBatch(pool),advanceWorkpaperBatch(pool),advanceWorkpaperBatch(pool)]);
    assert.equal((await pool.query('SELECT count(*) n FROM bb_workpaper_attempts WHERE batch_id=$1',[batch.batch_id])).rows[0].n,'1');
    const started=await read(),firstRun=started.items[0].run_id!;
    const bound=(await pool.query('SELECT r.*,i.manifest,i.input_hash pinned_hash FROM bb_runs r JOIN bb_input_revisions i ON i.project_id=r.project_id AND i.revision=r.input_revision WHERE r.id=$1',[firstRun])).rows[0];
    assert.equal(await m4InputGate(pool,bound,{input_hash:bound.pinned_hash,manifest:bound.manifest} as any),null);
    assert.ok(await m4InputGate(pool,{...bound,owner_user_id:'foreign'},{input_hash:bound.pinned_hash,manifest:bound.manifest} as any));
    assert.equal(await execute(),'succeeded');
    await upload(id,'synthetic-prospectus-v2.docx',makeSyntheticDocxFixture({text:'合成新募集书：发行人总资产200万元。'}),DOCX,'historical');
    const updatedVersions=await ok('GET',path+'/prospectus-versions');
    const updatedSource=await ok('POST',path+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:adopted.selection_revision,version_id:updatedVersions.versions.find((v:any)=>v.version_id!==adopted.current_version_id).version_id});
    const manifests=(await pool.query('SELECT manifest FROM bb_workpaper_items WHERE batch_id=$1',[batch.batch_id])).rows;
    assert.ok(manifests.every(r=>r.manifest.input.source_material.sha256===source.sha256));
    assert.equal((await ok('POST',base+'/batches',request)).batch_id,batch.batch_id);
    batch=await read();batch=await ok('POST',base+`/batches/${batch.batch_id}/actions`,{action:'pause',expected_revision:batch.revision});
    assert.equal(await advanceWorkpaperBatch(pool),false);
    batch=await ok('POST',base+`/batches/${batch.batch_id}/actions`,{action:'resume',expected_revision:batch.revision});
    for(let i=1;i<300;i++){await advanceWorkpaperBatch(pool);const state=await execute();assert.equal(state,i===1?'failed':'succeeded');if(i%100===0)process.stdout.write(`workpaper synthetic deliveries: ${i}\n`);}
    await advanceWorkpaperBatch(pool);batch=await read();assert.equal(batch.state,'partial');assert.equal(batch.items.filter(i=>i.state==='succeeded').length,299);
    const succeededRuns=batch.items.filter(i=>i.state==='succeeded').map(i=>i.run_id);
    batch=await ok('POST',base+`/batches/${batch.batch_id}/actions`,{action:'retry_failed',expected_revision:batch.revision});
    await advanceWorkpaperBatch(pool);assert.equal(await execute(),'succeeded');await advanceWorkpaperBatch(pool);batch=await read();
    assert.equal(batch.state,'complete');assert.equal(processed,301);assert.ok(succeededRuns.every(id=>batch.items.some(i=>i.run_id===id)));
    assert.equal(batch.charged_points,300*WORKPAPER_PRICE.points);assert.equal(batch.items[1].attempt,2);
    assert.equal(batch.items[0].artifacts.length,1);assert.ok(batch.items[0].artifacts.every(a=>a.kind==='document'&&a.filename.includes('财务核查 1')));
    const response=await send('GET',base+`/batches/${batch.batch_id}/download`);assert.equal(response.statusCode,200);assert.equal(response.headers['content-type'],'application/zip');
    const bytes=response.rawPayload,end=bytes.length-22;assert.equal(bytes.readUInt32LE(end),0x06054b50);assert.equal(bytes.readUInt16LE(end+10),300);
    let cursor=bytes.readUInt32LE(end+16);const names:string[]=[];
    while(cursor<end){assert.equal(bytes.readUInt32LE(cursor),0x02014b50);const len=bytes.readUInt16LE(cursor+28);names.push(bytes.subarray(cursor+46,cursor+46+len).toString('utf8'));cursor+=46+len+bytes.readUInt16LE(cursor+30)+bytes.readUInt16LE(cursor+32);}
    assert.equal(new Set(names).size,300);assert.ok(names.includes('可生成文件/财务资料/300 财务核查 300.docx'));assert.ok(names.every(n=>n.startsWith('可生成文件/')));
    assert.equal((await pool.query('SELECT count(*) n FROM bb_model_call_attempts')).rows[0].n,'0');
    assert.equal((await ok('POST',base+'/batches',request)).batch_id,batch.batch_id);
    let smallRequest={...request,request_id:randomUUID(),item_ids:request.item_ids.slice(0,3),expected_points:3*WORKPAPER_PRICE.points,source_version_id:updatedSource.current_version_id,source_selection_revision:updatedSource.selection_revision};
    assert.equal((await send('POST',base+'/batches',{...smallRequest,source_version_id:request.source_version_id,source_selection_revision:request.source_selection_revision})).json().code,'INPUT_REVISION_CONFLICT');
    smallRequest=await assess(smallRequest);
    batch=await ok('POST',base+'/batches',smallRequest);await advanceWorkpaperBatch(pool);
    batch=await read();batch=await ok('POST',base+`/batches/${batch.batch_id}/actions`,{action:'cancel',expected_revision:batch.revision});
    assert.equal(await advanceWorkpaperBatch(pool),false);assert.equal(await execute(),'succeeded');
    const cancelledRun=(await read()).items[0].run_id;
    const other=await ok('POST',base+'/batches',{...smallRequest,request_id:randomUUID()}) as WorkpaperBatch;
    assert.equal((await send('POST',base+`/batches/${batch.batch_id}/actions`,{action:'retry_failed',expected_revision:batch.revision})).statusCode,409);
    await ok('POST',base+`/batches/${other.batch_id}/actions`,{action:'cancel',expected_revision:other.revision});
    batch=await ok('POST',base+`/batches/${batch.batch_id}/actions`,{action:'retry_failed',expected_revision:batch.revision});
    for(let i=0;i<2;i++){await advanceWorkpaperBatch(pool);assert.equal(await execute(),'succeeded');}
    await advanceWorkpaperBatch(pool);batch=await read();assert.equal(batch.state,'complete');assert.equal(batch.items[0].run_id,cancelledRun);assert.equal(processed,304);
  }finally{await app.close();await pool.end();}
});
