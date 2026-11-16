import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {Pool} from 'pg';
import {WORKPAPER_PRICE,workpaperChapters,workpaperProgressiveSelection,billingWireRoute,encodeBillingDto,emptyFileGenerationPreparation,type WorkpaperBatch} from '@bondbuddy/contracts';
import {createServer} from './server.js';
import {digest,transaction,type PrivateBlobs} from './data.js';
import {grantCredits} from './billing.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';
import {headerlessCatalogueXlsx} from './workpaper-catalogue-fixture.js';
import {isolatedTestDatabase} from './test-database.js';
import {advanceWorkpaperBatch,pauseSharedWorkpaperBatch} from './workpapers.js';
import {inputManifestHash} from './production-rule-pin.js';
import {claim,promoteWordArtifact,finish} from './queue.js';
import {registerM4Artifacts} from './m4-workspace.js';

const configured=!!process.env.BB_TEST_DATABASE_URL;
async function fixture(key:string,chapters=9,automatic=false,credits=3000000,legacy=false){
 const pool=new Pool({connectionString:process.env.BB_TEST_DATABASE_URL}),user=randomUUID();let actor:string=user;
 const objects=new Map<string,Buffer>();const blobs:PrivateBlobs={put:async(k,b)=>{objects.set(k,Buffer.from(b));},get:async k=>objects.get(k)!,getIfExists:async k=>objects.get(k)??null,
  getIfExistsBounded:async(k,max)=>{const b=objects.get(k);return b&&b.length<=max?b:null;},exists:async k=>objects.has(k),delete:async k=>{objects.delete(k);}};
 const apiPool=legacy?new Proxy(pool,{get(target,key){
  if(key==='connect')return async()=>{const client=await target.connect();return new Proxy(client,{get(c,k){
   if(k==='query')return async(sql:any,values?:any[])=>{
    if(typeof sql==='string'&&sql.startsWith('INSERT INTO bb_workpaper_batches')){
     values![13].max_parallel=2;
     sql=sql.replace('progressive_phase) VALUES','progressive_phase,max_parallel) VALUES').replace('$14,$15)','$14,$15,NULL)');
    }
    try{return await c.query(sql,values);}catch(e){console.error('synthetic SQL',e);throw e;}
   };
   const value=Reflect.get(c,k);return typeof value==='function'?value.bind(c):value;
  }});};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }}):pool;
 const origin='http://bondbuddy.test',app=createServer({pool:apiPool,blobs,historicalBillingFixture:!automatic,enableSubscriptionBilling:automatic,enableRunRuntime:true,allowedOrigin:origin,principal:async()=>({userId:actor,csrfVerified:true})});
 const errors:string[]=[];app.addHook('onError',async(_req,_reply,e)=>{errors.push(e.message);});
 const send=(method:string,path:string,body?:unknown)=>{const family=billingWireRoute(method,path);return app.inject({method:method as any,url:path,payload:(family?.request&&body!==undefined?encodeBillingDto(family.request,body):body) as any,headers:{origin,...(Buffer.isBuffer(body)?{'content-type':'application/octet-stream'}:{})}});};
 const ok=async(method:string,path:string,body?:unknown)=>{const r=await send(method,path,body);assert.ok(r.statusCode<300,`${r.statusCode}: ${r.body}; ${errors.join(' | ')}`);return r.json();};
 await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[user,'progressive_'+user.slice(0,8)]);
 if(credits)await transaction(pool,c=>grantCredits(c,{owner:user,source:'purchase',key:randomUUID(),points:credits,expiresAt:null,actor:'synthetic',reason:'isolated progressive scheduler regression'}));
 const project=(await ok('POST','/api/v1/projects',{kind:'generation',name:'Synthetic progressive batch',issuer_name:'Synthetic issuer',market:'sse',offering:'private'})).project_id;
 const path=`/api/v1/projects/${project}`,base=path+'/workpapers';
 const upload=async(filename:string,bytes:Buffer,media_type:string,role='other')=>{
  const declared={byte_size:bytes.length,sha256:digest(bytes)},u=await ok('POST',path+'/materials/uploads',{...declared,filename,media_type,role});
  assert.equal((await send('PUT',u.upload_url,bytes)).statusCode,204);
  const m=await ok('POST',path+`/materials/uploads/${u.upload_id}/complete`,declared);
  return {source_project_id:project,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256};
 };
 await upload('source.docx',makeSyntheticDocxFixture({text:'合成募集书：发行人总资产100万元。'}),'application/vnd.openxmlformats-officedocument.wordprocessingml.document','historical');
 const versions=await ok('GET',path+'/prospectus-versions');
 const selected=await ok('POST',path+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:0,version_id:versions.versions[0].version_id});
 const rows=[['编号','文件名称','分类'],...Array.from({length:chapters},(_,c)=>[1,2].map(n=>[`${c+1}-${n}`,`合成核查 ${c+1}-${n}`,`第 ${c+1} 章`])).flat()];
 const material=await upload('catalogue.xlsx',await headerlessCatalogueXlsx(rows),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
 const cat=await ok('POST',base+'/catalogues',{request_id:randomUUID(),material});
 const order=workpaperChapters(cat.entries).map(c=>c.id).reverse();
 const request={request_id:randomUUID(),start_mode:'direct',catalogue_id:cat.catalogue_id,catalogue_sha256:cat.sha256,item_ids:cat.entries.filter((e:any)=>e.kind==='file').map((e:any)=>e.id),
  source_version_id:selected.current_version_id,source_selection_revision:selected.selection_revision,requirements:'保留全量证据。',expected_points:chapters*2*WORKPAPER_PRICE.points,price_version:WORKPAPER_PRICE.version,progressive:{chapter_order:order}};
 const start=async()=>await ok('POST',base+'/batches',request) as WorkpaperBatch;
 const read=async(id:string)=>await ok('GET',base+`/batches/${id}`) as WorkpaperBatch;
 const action=async(batch:WorkpaperBatch,value:Record<string,unknown>)=>await ok('POST',base+`/batches/${batch.batch_id}/actions`,{expected_revision:batch.revision,...value}) as WorkpaperBatch;
 const fail=async(run:string,code='VALIDATION_FAILED')=>transaction(pool,async c=>{
  await c.query("UPDATE bb_jobs SET state='failed',stage='failed',error_code=$2,lease_token=NULL,lease_until=NULL WHERE run_id=$1",[run,code]);
  await c.query("UPDATE bb_runs SET state='failed',stage='failed' WHERE id=$1",[run]);
 });
 const succeed=async(run:string)=>{
  const lease=await claim(pool,60,{runKinds:['generation']});assert.ok(lease);assert.equal(lease.runId,run);
  const documentBytes=makeSyntheticDocxFixture({text:'合成恢复回归底稿：发行人总资产100万元。'}),noteBytes=makeSyntheticDocxFixture({text:'合成恢复回归编制说明。'});
  const document=await promoteWordArtifact(pool,lease,documentBytes,blobs,'generated_pair_v1'),note=await promoteWordArtifact(pool,lease,noteBytes,blobs,'generated_pair_v1');
  assert.equal(document.status,'available');assert.equal(note.status,'available');
  if(document.status!=='available'||note.status!=='available')throw Error('Synthetic recovery Word fixture unavailable');
  await transaction(pool,c=>registerM4Artifacts(c,user,run,[{kind:'document',artifact_id:document.artifactId,artifact_version:document.artifactVersion,filename:'document.docx',byte_size:documentBytes.length},
   {kind:'preparation_note',artifact_id:note.artifactId,artifact_version:note.artifactVersion,filename:'note.docx',byte_size:noteBytes.length}]));
  assert.equal((await finish(pool,lease,'succeeded',{artifactId:document.artifactId,artifactVersion:document.artifactVersion,blobs})).state,'succeeded');
 };
 const close=async()=>{await app.close();await pool.end();};
 return {pool:apiPool,blobs,user,project,path,base,cat,request,start,read,action,fail,succeed,send,ok,close,setActor:(id:string)=>{actor=id;}};
}


import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {writeFileSync} from 'node:fs';
import {WorkerRuntime} from '../../worker/dist/runtime.js';
import {PgModelCallBudget} from '../../worker/dist/model-call-budget.js';
import {configureExecutionCapacity,executionCapacityControl,bindExecutionRegistration,registerExecutionRuntime} from './execution-capacity.js';
const until=async(check:()=>Promise<boolean>,message:string)=>{for(let i=0;i<400;i++){if(await check())return;await delay(25);}throw Error(message);};
test('eight real native children share one managed node and a frozen 250-file batch', {skip:!configured,timeout:60000},async()=>{
 const f=await fixture('eight',125,false,3000000,true),runtimePool=new Pool({connectionString:process.env.BB_TEST_DATABASE_URL,max:20});
 let worker:WorkerRuntime|undefined;const children:ReturnType<typeof spawn>[]=[],records:any[]=[],logs:any[]=[];let release!:()=>void;
 const overlap=new Promise<void>(r=>{release=r;}),control=executionCapacityControl(f.pool),hash='a'.repeat(64),identity={account_id:'synthetic',region:'synthetic',instance_id:'eight-native',epoch:randomUUID()};
 try{
  let batch=await f.start();assert.equal(batch.items.length,250);assert.equal(batch.progressive?.max_parallel,2);
  const frozen=(await f.pool.query('SELECT progressive_plan,max_parallel FROM bb_workpaper_batches WHERE id=$1',[batch.batch_id])).rows[0];
  for(let i=0;i<8;i++)assert.equal(await advanceWorkpaperBatch(f.pool),true,'admission '+i+' '+JSON.stringify(await f.pool.query('SELECT state,error,progressive_phase FROM bb_workpaper_batches WHERE id=$1',[batch.batch_id]).then(r=>r.rows)));
  assert.equal(await advanceWorkpaperBatch(f.pool),false);batch=await f.read(batch.batch_id);assert.equal(batch.items.filter(i=>i.run_id).length,8);
  const inputs=(await f.pool.query('SELECT input_hash,input_revision FROM bb_runs ORDER BY id')).rows;
  await configureExecutionCapacity(f.pool,0,{managed_nodes:true,global_model_limit:8,node_model_limit:8,max_nodes:2,budget_available:true,provider_concurrency_limit:8,provider_policy_sha256:hash,expense_policy_sha256:hash});
  let op=await control.reserveStart({...identity,instance_id:null,instance_count:1,source_sha256:hash,image_sha256:hash,launch_manifest_sha256:hash,capabilities:['authoring'],services:[{service_id:'one',capabilities:['authoring']}]},'eight-run',1);
  op=await control.claimCloudDispatch(op.operation_id,0);op=await control.recordCloudResult(op.operation_id,op.revision,{state:'submitted',identity,provider_request_id:'eight-ack',observation:null,run_acceptance:{operation_id:op.operation_id,identity,provider_request_id:'eight-ack',instance_ids:[identity.instance_id],client_token:op.client_token,launch_manifest_sha256:hash,launch_binding_sha256:hash,evidence_ref:'synthetic-accepted.json',evidence_sha256:hash}});
  await control.recordCloudResult(op.operation_id,op.revision,{state:'completed',identity,provider_request_id:'eight-ack',observation:{instance_state:'RUNNING',latest_operation:'RunInstances',latest_operation_state:'SUCCESS',latest_operation_request_id:'eight-ack',stop_charging_mode:null,observed_at:new Date().toISOString(),evidence_ref:'synthetic.json',evidence_sha256:hash,run_creation:{operation_id:op.operation_id,identity,launch_manifest_sha256:hash,launch_binding_sha256:hash,created_at:op.dispatched_at!,instance_status:'RUNNING',status_request_id:'synthetic-status'}}});
  const token='synthetic-eight-registration-012345';await bindExecutionRegistration(f.pool,identity,'eight-run',token);
  await registerExecutionRuntime(runtimePool,{identity,session_id:randomUUID()},{source_sha256:hash,image_sha256:hash,launch_manifest_sha256:hash,registration_token:token,service_id:'one',capabilities:['authoring'],process_identity:{pid:String(process.pid)}});
  const budget=new PgModelCallBudget(runtimePool,8);
  worker=new WorkerRuntime({pool:runtimePool,blobs:f.blobs,kinds:['run'],runKinds:['generation'],concurrency:8,interactiveSlots:0,parseSlots:0,pollMs:25,heartbeatMs:100,sweepMs:60000,executionTransport:{refresh:async()=>{},ready:()=>true,close:()=>{}},log:e=>logs.push(e),
   runStages:[{name:'input_lock',run:async ctx=>{try{
    const permit=await budget.acquire(ctx.signal,'batch:'+batch.batch_id,{kind:'job',id:ctx.lease.jobId,token:ctx.lease.token});
    const child=spawn(process.execPath,['-e',"process.stdout.write('ready\\n');process.stdin.once('data',()=>process.exit(0));setTimeout(()=>process.exit(2),15000)"],{stdio:['pipe','pipe','pipe'],detached:true});children.push(child);
    const closed=new Promise<number|null>(resolve=>child.once('close',resolve));assert.ok(child.pid);await permit.bindProcess(child.pid!);
    const record={run_id:ctx.run.id,pid:child.pid,start:performance.now(),exit:null as number|null};records.push(record);
    try{await overlap;child.stdin!.end('done');record.exit=await closed;assert.equal(record.exit,0);}finally{await permit.release();}
    // Real bounded children finish naturally via a message; no provider/model is invoked.
    const bytes=makeSyntheticDocxFixture({text:'合成八路机械调度成果，不代表业务专业验收。'});
    const noteBytes=makeSyntheticDocxFixture({text:'合成八路机械调度编制说明。'});
    const document=await promoteWordArtifact(runtimePool,ctx.lease,bytes,f.blobs,'generated_pair_v1'),note=await promoteWordArtifact(runtimePool,ctx.lease,noteBytes,f.blobs,'generated_pair_v1');
    assert.equal(document.status,'available');assert.equal(note.status,'available');if(document.status!=='available'||note.status!=='available')throw Error('delivery');
    await transaction(runtimePool,c=>registerM4Artifacts(c,f.user,ctx.run.id,[{kind:'document',artifact_id:document.artifactId,artifact_version:document.artifactVersion,filename:'document.docx',byte_size:bytes.length},{kind:'preparation_note',artifact_id:note.artifactId,artifact_version:note.artifactVersion,filename:'note.docx',byte_size:noteBytes.length}]));
    assert.equal((await finish(runtimePool,ctx.lease,'succeeded',{artifactId:document.artifactId,artifactVersion:document.artifactVersion,blobs:f.blobs})).state,'succeeded');return {kind:'stopped'};}catch(e){console.error('synthetic stage',e);throw e;}
   }}]}).start();
  await until(async()=>records.length===8,'eight native children not admitted: '+JSON.stringify(logs));
  const snap=await control.snapshot();assert.equal(snap.nodes[0]?.active_leases,8);assert.equal(snap.nodes[0]?.active_model_calls,8);assert.equal(snap.nodes[0]?.ready_slots,0);
  const holders=(await f.pool.query('SELECT node_slot,child_pid FROM bb_model_capacity_holders ORDER BY node_slot')).rows;assert.deepEqual(holders.map(h=>h.node_slot),[1,2,3,4,5,6,7,8]);
  await delay(500);assert.ok(children.every(c=>c.exitCode===null));const overlapMs=performance.now()-Math.max(...records.map(r=>r.start));
  release();await until(async()=>(await f.pool.query("SELECT count(*)::int n FROM bb_runs WHERE state='succeeded'")).rows[0].n===8,'eight artifacts not persisted').catch(async e=>{console.error('states',(await f.pool.query('SELECT state,stage FROM bb_runs')).rows,logs.slice(-16));throw e;});
  const ready=await control.snapshot();assert.equal(ready.nodes[0]?.ready_slots,8);assert.equal(ready.nodes[0]?.active_model_calls,0);
  await control.beginDrain(identity,'eight-drain',ready.nodes[0]!.revision);await worker.stop();worker=undefined;assert.ok(await control.drainProof(identity,'eight-drain'));
  assert.deepEqual((await f.pool.query('SELECT progressive_plan,max_parallel FROM bb_workpaper_batches WHERE id=$1',[batch.batch_id])).rows[0],frozen);
  assert.deepEqual((await f.pool.query('SELECT input_hash,input_revision FROM bb_runs ORDER BY id')).rows,inputs);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_model_capacity_holders')).rows[0].n,0);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_model_call_attempts')).rows[0].n,0);
  const receipt={synthetic:true,upstream_calls:0,batch_items:250,frozen_max_parallel:2,node_limit:8,global_limit:8,peak_native:8,overlap_ms:overlapMs,records,word_artifacts:(await f.pool.query('SELECT count(*)::int n FROM bb_artifact_versions')).rows[0].n,positive_drain:true,remaining_holders:0};
  console.log(JSON.stringify(receipt));if(process.env.BB_EIGHT_RECEIPT)writeFileSync(process.env.BB_EIGHT_RECEIPT,JSON.stringify(receipt,null,2));
 }finally{release();await worker?.stop();await runtimePool.end();await f.close();}
});
