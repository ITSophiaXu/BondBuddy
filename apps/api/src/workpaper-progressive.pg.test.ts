import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {Pool} from 'pg';
import {WORKPAPER_PRICE,workpaperChapters,workpaperProgressiveSelection,billingWireRoute,encodeBillingDto,emptyFileGenerationPreparation,type WorkpaperBatch} from '@bondbuddy/contracts';
import {createServer} from './server.js';
import {digest,transaction,type PrivateBlobs} from './data.js';
import {grantCredits} from './billing.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';
import {headerlessCatalogueXlsx} from './workpaper-catalogue-fixture.js';
import {isolatedTestDatabase} from './test-database.js';
import {advanceWorkpaperBatch as advanceWorkpaperBatchOnce,pauseSharedWorkpaperBatch} from './workpapers.js';
import {inputManifestHash} from './production-rule-pin.js';
import {claim,promoteWordArtifact,finish} from './queue.js';
import {registerM4Artifacts} from './m4-workspace.js';

import {flushPerformanceTraces} from './performance-trace.js';

// Await committed asynchronous telemetry between scheduler ticks. Its FK locks
// may legitimately cause a NOWAIT admission poll to miss a queued sibling.
async function advanceWorkpaperBatch(pool:Pool){
 const result=await advanceWorkpaperBatchOnce(pool);await flushPerformanceTraces(pool,5000);return result;
}
const configured=!!process.env.BB_TEST_DATABASE_URL;
async function fixture(key:string,chapters=9,automatic=false,credits=3000000,legacy=false){
 const pool=new Pool({connectionString:await isolatedTestDatabase(undefined,'progressive-'+key)}),user=randomUUID();let actor:string=user;
 const objects=new Map<string,Buffer>();const blobs:PrivateBlobs={put:async(k,b)=>{objects.set(k,Buffer.from(b));},get:async k=>objects.get(k)!,getIfExists:async k=>objects.get(k)??null,
  getIfExistsBounded:async(k,max)=>{const b=objects.get(k);return b&&b.length<=max?b:null;},exists:async k=>objects.has(k),delete:async k=>{objects.delete(k);}};
 const apiPool=legacy?new Proxy(pool,{get(target,key){
  if(key==='connect')return async()=>{const client=await target.connect();return new Proxy(client,{get(c,k){
   if(k==='query')return async(sql:any,values?:any[])=>{
    if(typeof sql==='string'&&sql.startsWith('INSERT INTO bb_workpaper_batches')){
     values![13].max_parallel=2;
     sql=sql.replace('progressive_phase) VALUES','progressive_phase,max_parallel) VALUES').replace('$14,$15)','$14,$15,NULL)');
    }
    return c.query(sql,values);
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
 const succeed=async(run:string,runtimePool=pool)=>{
  // SKIP LOCKED can temporarily miss a queued run while the independent telemetry
  // writer commits its FK check. Poll like the worker, without extending this test's timeout.
  const claimDeadline=performance.now()+5000;
  let lease=await claim(runtimePool,60,{runKinds:['generation']});
  while(!lease&&performance.now()<claimDeadline){
   await new Promise(resolve=>setTimeout(resolve,25));
   lease=await claim(runtimePool,60,{runKinds:['generation']});
  }
  if(!lease){
   const queued=(await pool.query(`SELECT r.id,r.state run_state,r.stage run_stage,j.id job_id,j.state job_state,
    j.stage job_stage,j.attempts,j.lease_token IS NOT NULL has_lease,j.lease_until,j.error_code
    FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id WHERE r.owner_user_id=$1 ORDER BY j.created_at`,[user])).rows;
   assert.fail(`Expected queued run ${run} to become claimable within 5000ms: ${JSON.stringify(queued)}`);
  }
  assert.equal(lease.runId,run);assert.equal(lease.attempts,1,'empty polls must not consume a job attempt');
  const documentBytes=makeSyntheticDocxFixture({text:'合成恢复回归底稿：发行人总资产100万元。'}),noteBytes=makeSyntheticDocxFixture({text:'合成恢复回归编制说明。'});
  const document=await promoteWordArtifact(runtimePool,lease,documentBytes,blobs,'generated_pair_v1'),note=await promoteWordArtifact(runtimePool,lease,noteBytes,blobs,'generated_pair_v1');
  assert.equal(document.status,'available');assert.equal(note.status,'available');
  if(document.status!=='available'||note.status!=='available')throw Error('Synthetic recovery Word fixture unavailable');
  await transaction(runtimePool,c=>registerM4Artifacts(c,user,run,[{kind:'document',artifact_id:document.artifactId,artifact_version:document.artifactVersion,filename:'document.docx',byte_size:documentBytes.length},
   {kind:'preparation_note',artifact_id:note.artifactId,artifact_version:note.artifactVersion,filename:'note.docx',byte_size:noteBytes.length}]));
  assert.equal((await finish(runtimePool,lease,'succeeded',{artifactId:document.artifactId,artifactVersion:document.artifactVersion,blobs})).state,'succeeded');
 };
 const close=async()=>{await app.close();await flushPerformanceTraces(pool,5000);await pool.end();};
 return {pool,user,project,path,base,cat,request,start,read,action,fail,succeed,send,ok,close,setActor:(id:string)=>{actor=id;}};
}

test('progressive API: immutable chapter order, eight admitted items, confirmation fence, replay safety, owner isolation and failed-only retry',{skip:!configured,timeout:180000},async()=>{
 const f=await fixture('trial');
 try{
  const plan=workpaperProgressiveSelection(f.cat.entries,f.request.item_ids,f.request.progressive.chapter_order);
  assert.equal((await f.send('POST',f.base+'/batches',{...f.request,progressive:{chapter_order:[f.request.progressive.chapter_order[0]]}})).statusCode,422);
  let batch=await f.start();assert.equal(batch.progressive?.phase,'trial');assert.deepEqual(batch.items.map(i=>i.entry.id),plan.ordered_item_ids);
  assert.equal(batch.progressive?.trial_item_ids.length,8);assert.equal((await f.start()).batch_id,batch.batch_id);
  await assert.rejects(f.pool.query("UPDATE bb_workpaper_batches SET progressive_plan=jsonb_set(progressive_plan,'{max_parallel}','3') WHERE id=$1",[batch.batch_id]),{code:'23514'});
  for(let i=0;i<8;i++)assert.equal(await advanceWorkpaperBatch(f.pool),true);assert.equal(await advanceWorkpaperBatch(f.pool),false);
  batch=await f.read(batch.batch_id);assert.equal(batch.items.filter(i=>i.run_id).length,8);
  const inserted=(await f.pool.query('SELECT i.manifest,t.project_id FROM bb_workpaper_items i JOIN bb_workpaper_batches b ON b.id=i.batch_id JOIN bb_m4_topics t ON t.id=b.topic_id WHERE i.batch_id=$1 AND i.item_id=$2',[batch.batch_id,plan.trial_item_ids[2]])).rows[0];
  // Direct database admission cannot bypass the bounded scheduler, even with an
  // otherwise authentic frozen third-item input and the same canonical project.
  await assert.rejects(transaction(f.pool,async c=>{
   const revision=999,hash=inputManifestHash(inserted.manifest),id=randomUUID();
   await c.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,$3,1,$4,$5,'[]','[]')",[inserted.project_id,revision,f.user,hash,inserted.manifest]);
   await c.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,$4,$5,$1,'generation',$5,'queued')",[id,f.user,inserted.project_id,revision,hash]);
  }),{code:'23514'});
  // An unrelated business run retains the original canonical mutex.
  await assert.rejects(transaction(f.pool,async c=>{
   const id=randomUUID(),hash='a'.repeat(64);
   await c.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,998,$2,1,$3,'{}','[]','[]')",[inserted.project_id,f.user,hash]);
   await c.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,998,$4,$1,'generation',$4,'queued')",[id,f.user,inserted.project_id,hash]);
  }),{code:'23514'});
  const attempts=new Set<string>();
  for(let turn=0;turn<16;turn++){
   batch=await f.read(batch.batch_id);for(const item of batch.items.filter(i=>i.run_id&&!attempts.has(i.run_id))){attempts.add(item.run_id!);await f.fail(item.run_id!);}
   await advanceWorkpaperBatch(f.pool);
   batch=await f.read(batch.batch_id);if(batch.progressive?.phase==='awaiting_confirmation')break;
  }
  assert.equal(batch.state,'paused');assert.equal(batch.progressive?.phase,'awaiting_confirmation');assert.equal(attempts.size,8);assert.equal(batch.items.filter(i=>i.state==='queued').length,10);
  assert.equal(await advanceWorkpaperBatch(f.pool),false,'the trial fence does not admit remainder');
  assert.equal((await f.send('POST',f.base+`/batches/${batch.batch_id}/actions`,{action:'resume',expected_revision:batch.revision})).statusCode,409);
  f.setActor(randomUUID());assert.equal((await f.send('GET',f.base+`/batches/${batch.batch_id}`)).statusCode,404);f.setActor(f.user);
  const confirmation={action:'continue_remaining',expected_revision:batch.revision,request_id:randomUUID()};
  batch=await f.ok('POST',f.base+`/batches/${batch.batch_id}/actions`,confirmation);assert.equal(batch.progressive?.phase,'remaining');
  batch=await f.action(batch,{action:'pause'});
  const replay=await f.ok('POST',f.base+`/batches/${batch.batch_id}/actions`,confirmation);assert.equal(replay.state,'paused');assert.equal(replay.revision,batch.revision,'replay never undoes a later user pause');
  batch=await f.action(batch,{action:'resume'});
  for(let turn=0;turn<24;turn++){
   await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);
   for(const item of batch.items.filter(i=>i.run_id&&!attempts.has(i.run_id))){attempts.add(item.run_id!);await f.fail(item.run_id!);}
   if(batch.state==='partial')break;
  }
  assert.equal(batch.state,'partial');assert.equal(attempts.size,18);assert.equal(batch.items.every(i=>i.attempt===1),true);
  batch=await f.action(batch,{action:'retry_failed'});assert.equal(batch.progressive?.phase,'retry_failed');assert.equal(batch.items.every(i=>i.attempt===2&&i.run_id===null),true);
  batch=await f.action(batch,{action:'cancel'});
  assert.equal(Number((await f.pool.query('SELECT count(*) n FROM bb_workpaper_attempts WHERE batch_id=$1',[batch.batch_id])).rows[0].n),18,'retry acceptance does not start or charge a second attempt');
 }finally{await f.close();}
});

test('progressive stop preserves active reconciliation and retry never includes untouched queued files; shared failures pause admission',{skip:!configured,timeout:120000},async()=>{
 const f=await fixture('stop',2);
 try{
  let batch=await f.start();await advanceWorkpaperBatch(f.pool);await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);
  const initial=batch.items.filter(i=>i.run_id),untouched=batch.items.filter(i=>!i.run_id).map(i=>i.entry.id);
  batch=await f.action(batch,{action:'cancel'});
  assert.equal((await f.send('POST',f.base+`/batches/${batch.batch_id}/actions`,{action:'retry_failed',expected_revision:batch.revision})).statusCode,409);
  for(const item of initial)await f.fail(item.run_id!);
  const oldJob=(await f.pool.query('SELECT id FROM bb_jobs WHERE run_id=$1',[initial[0]!.run_id])).rows[0];
  await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);assert.equal(batch.state,'cancelled');
  batch=await f.action(batch,{action:'retry_failed'});await advanceWorkpaperBatch(f.pool);await advanceWorkpaperBatch(f.pool);
  await pauseSharedWorkpaperBatch(f.pool,f.user,batch.batch_id,{itemId:initial[0]!.entry.id,runId:initial[0]!.run_id!,jobId:oldJob.id});
  batch=await f.read(batch.batch_id);assert.equal(batch.items.filter(i=>i.run_id).length,2);assert.ok(batch.items.filter(i=>untouched.includes(i.entry.id)).every(i=>i.run_id===null&&i.attempt===1));
  assert.equal(batch.state,'running','stale failure from a superseded attempt cannot pause the retry');
  for(const item of batch.items.filter(i=>i.run_id))await f.fail(item.run_id!);
  await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);assert.equal(batch.state,'cancelled');
  const next=await f.ok('POST',f.base+'/batches',{...f.request,request_id:randomUUID()}) as WorkpaperBatch;
  await advanceWorkpaperBatch(f.pool);const current=await f.read(next.batch_id);
  await f.fail(current.items.find(i=>i.run_id)!.run_id!,'MODEL_PROVIDER_REQUEST_REJECTED');
  await advanceWorkpaperBatch(f.pool);const blocked=await f.read(next.batch_id);
  assert.equal(blocked.state,'paused');assert.equal(blocked.items.filter(i=>i.run_id).length,1);assert.match(blocked.error!,/模型服务/);
  assert.equal(await advanceWorkpaperBatch(f.pool),false);
 }finally{await f.close();}
});

test('retrying failed trial files returns to confirmation and leaves the remaining chapter files untouched',{skip:!configured,timeout:120000},async()=>{
 const f=await fixture('trial-retry',2);
 try{
  let batch=await f.start();
  await advanceWorkpaperBatch(f.pool);await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);
  for(const item of batch.items.filter(i=>i.run_id))await f.fail(item.run_id!);
  await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);assert.equal(batch.progressive?.phase,'awaiting_confirmation');
  const trial=new Set(batch.progressive!.trial_item_ids);
  batch=await f.action(batch,{action:'retry_failed'});
  await advanceWorkpaperBatch(f.pool);await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);
  assert.ok(batch.items.filter(i=>!trial.has(i.entry.id)).every(i=>i.run_id===null&&i.attempt===1));
  for(const item of batch.items.filter(i=>i.run_id))await f.fail(item.run_id!);
  await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);
  assert.equal(batch.state,'paused');assert.equal(batch.progressive?.phase,'awaiting_confirmation');assert.equal(await advanceWorkpaperBatch(f.pool),false);
 }finally{await f.close();}
});

test('shared trial failure retries only settled files, finishes all eight trial chapters and preserves the confirmation fence',{skip:!configured,timeout:180000},async()=>{
 const f=await fixture('shared-trial-recovery');
 try{
  let batch=await f.start();await advanceWorkpaperBatch(f.pool);await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);
  const [blocked,preserved]=batch.items.filter(i=>i.run_id),trial=new Set(batch.progressive!.trial_item_ids);
  await f.fail(blocked!.run_id!,'WORKPAPER_SOURCE_BLOCKED');await f.succeed(preserved!.run_id!);
  await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);
  assert.equal(batch.state,'paused');assert.equal(batch.pause_reason,'shared_blocked');assert.equal(batch.progressive?.phase,'trial');
  const resume=await f.send('POST',f.base+`/batches/${batch.batch_id}/actions`,{action:'resume',expected_revision:batch.revision});
  assert.equal(resume.statusCode,409);assert.match(resume.body,/重试受阻文件/);
  const job=(await f.pool.query('SELECT id FROM bb_jobs WHERE run_id=$1',[blocked!.run_id])).rows[0],attempt=randomUUID();
  await f.pool.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status,model_id) VALUES($1,$2,$3,$4,1,'pending_reconcile','synthetic-model')",[attempt,f.user,job.id,randomUUID()]);
  const pending=await f.send('POST',f.base+`/batches/${batch.batch_id}/actions`,{action:'retry_failed',expected_revision:batch.revision});
  assert.equal(pending.statusCode,409);assert.match(pending.body,/对账/);
  assert.equal((await f.read(batch.batch_id)).items.find(i=>i.entry.id===blocked!.entry.id)!.attempt,1,'pending usage never resets or starts another attempt');
  await f.pool.query("UPDATE bb_model_call_attempts SET status='confirmed_not_sent' WHERE id=$1",[attempt]);
  batch=await f.action(batch,{action:'retry_failed'});assert.equal(batch.progressive?.phase,'retry_failed');
  assert.equal(batch.items.find(i=>i.entry.id===preserved!.entry.id)!.run_id,preserved!.run_id);
  await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);
  const retried=batch.items.find(i=>i.entry.id===blocked!.entry.id)!;assert.equal(retried.attempt,2);await f.succeed(retried.run_id!);
  await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);assert.equal(batch.progressive?.phase,'trial');assert.equal(batch.state,'queued');
  for(let turn=0;turn<16;turn++){
   await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);
   for(const item of batch.items.filter(i=>i.run_id&&i.state==='queued'))await f.succeed(item.run_id!);
   if(batch.progressive?.phase==='awaiting_confirmation')break;
  }
  assert.equal(batch.state,'paused');assert.equal(batch.progressive?.phase,'awaiting_confirmation');
  assert.equal(batch.items.filter(i=>trial.has(i.entry.id)&&i.state==='succeeded').length,8);
  assert.ok(batch.items.filter(i=>!trial.has(i.entry.id)).every(i=>i.run_id===null&&i.attempt===1));
  assert.equal(await advanceWorkpaperBatch(f.pool),false,'a recovered trial never bypasses explicit confirmation');
 }finally{await f.close();}
});

test('shared remainder failure continues queued files and a repeated retry preserves its unstarted retry members and completed outputs',{skip:!configured,timeout:180000},async()=>{
 const f=await fixture('shared-remainder-recovery',5);
 try{
  let batch=await f.start();
  for(let turn=0;turn<14;turn++){
   await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);
   for(const item of batch.items.filter(i=>i.run_id&&i.state==='queued'))await f.succeed(item.run_id!);
   if(batch.progressive?.phase==='awaiting_confirmation')break;
  }
  assert.equal(batch.progressive?.phase,'awaiting_confirmation');
  batch=await f.action(batch,{action:'continue_remaining',request_id:randomUUID()});
  await advanceWorkpaperBatch(f.pool);await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);
  const [blocked,preserved]=batch.items.filter(i=>i.run_id&&i.state==='queued');
  await f.fail(blocked!.run_id!,'WORKPAPER_GROUP_BLOCKED');await f.succeed(preserved!.run_id!);
  await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);assert.equal(batch.pause_reason,'shared_blocked');
  batch=await f.action(batch,{action:'retry_failed'});await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);
  await f.succeed(batch.items.find(i=>i.entry.id===blocked!.entry.id)!.run_id!);
  await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);assert.equal(batch.state,'queued');assert.equal(batch.progressive?.phase,'remaining');
  for(let turn=0;turn<10;turn++){
   await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);
   for(const item of batch.items.filter(i=>i.run_id&&i.state==='queued'))await f.fail(item.run_id!);
   if(batch.state==='partial')break;
  }
  assert.equal(batch.state,'partial');assert.equal(batch.items.filter(i=>i.state==='failed').length,3);
  const completed=batch.items.filter(i=>i.state==='succeeded').map(i=>({id:i.entry.id,run:i.run_id,attempt:i.attempt}));
  batch=await f.action(batch,{action:'retry_failed'});await advanceWorkpaperBatch(f.pool);await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);
  const active=batch.items.filter(i=>i.run_id&&i.state==='queued'),unstarted=batch.items.find(i=>!i.run_id)!;
  assert.equal(unstarted.attempt,2);await f.fail(active[0]!.run_id!,'WORKPAPER_SOURCE_BLOCKED');await f.fail(active[1]!.run_id!);
  await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);assert.equal(batch.pause_reason,'shared_blocked');assert.equal(batch.progressive?.phase,'retry_failed');
  batch=await f.action(batch,{action:'retry_failed'});
  assert.equal(batch.items.find(i=>i.entry.id===unstarted.entry.id)!.attempt,2,'unstarted retry membership is retained without incrementing its attempt');
  for(let turn=0;turn<10;turn++){
   await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);
   for(const item of batch.items.filter(i=>i.run_id&&i.state==='queued'))await f.succeed(item.run_id!);
   if(batch.state==='complete')break;
  }
  assert.equal(batch.state,'complete');assert.equal(batch.items.length,10);
  for(const old of completed){const item=batch.items.find(i=>i.entry.id===old.id)!;assert.equal(item.run_id,old.run);assert.equal(item.attempt,old.attempt);}
  assert.equal(batch.items.find(i=>i.entry.id===unstarted.entry.id)!.attempt,2);
 }finally{await f.close();}
});

test('resuming a blocked progressive batch points to paused child recovery and does not retry or bypass it',{skip:!configured,timeout:120000},async()=>{
 const f=await fixture('paused-child-recovery',2);
 try{
  let batch=await f.start();await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);const item=batch.items.find(i=>i.run_id)!;
  await f.pool.query("UPDATE bb_jobs SET state='paused',lease_token=NULL,lease_until=NULL WHERE run_id=$1",[item.run_id]);
  await f.pool.query("UPDATE bb_runs SET state='paused' WHERE id=$1",[item.run_id]);
  await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);assert.equal(batch.pause_reason,'shared_blocked');
  for(const state of ['paused','awaiting_input']){
   await f.pool.query('UPDATE bb_runs SET state=$2 WHERE id=$1',[item.run_id,state]);
   const response=await f.send('POST',f.base+`/batches/${batch.batch_id}/actions`,{action:'resume',expected_revision:batch.revision});
   assert.equal(response.statusCode,409);assert.match(response.body,/查看任务/);
   assert.equal((await f.send('POST',f.base+`/batches/${batch.batch_id}/actions`,{action:'retry_failed',expected_revision:batch.revision})).statusCode,409);
  }
  await f.pool.query("UPDATE bb_jobs SET state='queued' WHERE run_id=$1",[item.run_id]);
  await f.pool.query("UPDATE bb_runs SET state='queued' WHERE id=$1",[item.run_id]);
  batch=await f.action(batch,{action:'resume'});assert.equal(batch.state,'queued');assert.equal(batch.items.find(i=>i.entry.id===item.entry.id)!.run_id,item.run_id);
 }finally{await f.close();}
});

test('unified file generation forwards a locked progressive selection and rejects a different order with the old quote',{skip:!configured,timeout:120000},async()=>{
 const f=await fixture('unified',2,true);
 try{
  const base=f.path+'/file-generation',preparation={...emptyFileGenerationPreparation(),workpaper_template_mode:'automatic',catalogue_id:f.cat.catalogue_id,item_ids:f.request.item_ids,progressive:f.request.progressive};
  const saved=await f.ok('PUT',base+'/preparation',{expected_revision:0,preparation});
  const pricing=(await f.ok('GET',base)).pricing;
  const request={request_id:randomUUID(),expected_revision:saved.revision,source_version_id:f.request.source_version_id,source_selection_revision:f.request.source_selection_revision,expected_points:f.request.item_ids.length*Number(pricing.workpaper_points),price_version:pricing.price_version,progressive:f.request.progressive};
  const quote=await f.ok('POST',base+'/quote',request);
  assert.ok(quote.quote_id,'automatic progressive quote is persisted');
  const changed=await f.send('POST',base+'/batches',{...request,quote_id:quote.quote_id,progressive:{chapter_order:[...f.request.progressive.chapter_order].reverse()}});
  assert.equal(changed.statusCode,409);
  const result=await f.ok('POST',base+'/batches',{...request,quote_id:quote.quote_id});
  assert.deepEqual(result.workpapers.progressive.chapters.map((c:any)=>c.id),f.request.progressive.chapter_order);
  const manifests=(await f.pool.query('SELECT manifest FROM bb_workpaper_items WHERE batch_id=$1',[result.workpapers.batch_id])).rows;
  assert.ok(manifests.every(i=>i.manifest.input.workpaper.execution==='progressive_item_v1'));
  await f.action(result.workpapers,{action:'cancel'});
 }finally{await f.close();}
});

test('progressive automatic billing admits only affordable files, retains full scope quote, and resumes one file without duplicating reservations',{skip:!configured,timeout:120000},async()=>{
 const f=await fixture('billing',2,true,0);
 try{
  const pricing=(await f.ok('GET',f.path+'/file-generation')).pricing,unit=Number(pricing.workpaper_points);
  const request={...f.request,price_version:pricing.price_version,expected_points:f.request.item_ids.length*unit};
  assert.equal((await f.send('POST',f.base+'/batches',request)).statusCode,402);
  const credit=()=>transaction(f.pool,c=>grantCredits(c,{owner:f.user,source:'purchase',key:randomUUID(),points:unit,expiresAt:null,actor:'synthetic',reason:'one progressive file'}));
  await credit();let batch=await f.ok('POST',f.base+'/batches',request) as WorkpaperBatch;
  assert.equal(Number(batch.total_points),4*unit,'the full user-selected scope remains quoted');
  await advanceWorkpaperBatch(f.pool);await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);
  assert.equal(batch.state,'paused');assert.equal(batch.items.filter(i=>i.run_id).length,1);assert.equal(Number(batch.billing_resume!.required_points),unit);
  assert.equal((await f.send('POST',f.base+`/batches/${batch.batch_id}/actions`,{action:'resume',expected_revision:batch.revision,billing_resume:true,request_id:randomUUID(),price_version:pricing.price_version,expected_points:unit})).statusCode,402);
  await credit();const requestId=randomUUID();
  const resume={action:'resume',billing_resume:true,request_id:requestId,price_version:pricing.price_version,expected_points:unit,expected_revision:batch.revision};
  batch=await f.ok('POST',f.base+`/batches/${batch.batch_id}/actions`,resume);await advanceWorkpaperBatch(f.pool);batch=await f.read(batch.batch_id);
  assert.equal(batch.items.filter(i=>i.run_id).length,2);
  batch=await f.action(batch,{action:'pause'});
  assert.equal((await f.ok('POST',f.base+`/batches/${batch.batch_id}/actions`,resume)).state,'paused');
  assert.equal(Number((await f.pool.query('SELECT count(*) n FROM bb_credit_reservations r JOIN bb_workpaper_attempts a ON a.run_id=r.run_id WHERE a.batch_id=$1',[batch.batch_id])).rows[0].n),2);
  batch=await f.action(batch,{action:'cancel'});for(const item of batch.items.filter(i=>i.run_id))await f.fail(item.run_id!);
  await advanceWorkpaperBatch(f.pool);
 }finally{await f.close();}
});


test('historical frozen two-way plan keeps its exact policy and confirmation fence',{skip:!configured,timeout:60000},async()=>{
 const f=await fixture('legacy-two',9,false,3000000,true);
 try{
  let batch=await f.start();assert.equal(batch.progressive?.max_parallel,2);
  assert.equal((await f.pool.query('SELECT max_parallel FROM bb_workpaper_batches WHERE id=$1',[batch.batch_id])).rows[0].max_parallel,null);
  await advanceWorkpaperBatch(f.pool);await advanceWorkpaperBatch(f.pool);
  assert.equal(await advanceWorkpaperBatch(f.pool),false);
  batch=await f.read(batch.batch_id);assert.equal(batch.items.filter(i=>i.run_id).length,2);
  assert.equal(batch.progressive?.phase,'trial');
  await f.action(batch,{action:'pause'});assert.equal(await advanceWorkpaperBatch(f.pool),false);
 }finally{await f.close();}
});


test('restricted workpaper consumer creates child runs through the real mutex, delivers and resumes without duplicate billing',
 {skip:!configured,timeout:180000},async()=>{
  const f=await fixture('restricted-role',2),role='synthetic_workpaper_'+randomUUID().replaceAll('-','');
  const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
  await f.pool.query(`CREATE ROLE ${quote(role)} LOGIN`);
  const acl=JSON.parse(await readFile(new URL('../../worker/src/fixtures/managed-runtime-acl.json',import.meta.url),'utf8'));
  for(const table of acl.tables){
    for(const privilege of table.privileges)await f.pool.query(`GRANT ${privilege} ON public.${quote(table.name)} TO ${quote(role)}`);
    for(const [privilege,columns] of Object.entries(table.columns) as [string,string[]][])
      await f.pool.query(`GRANT ${privilege}(${columns.map(quote).join(',')}) ON public.${quote(table.name)} TO ${quote(role)}`);
  }
  const grants=await readFile(new URL('../../../deploy/m1/security/managed-execution-prerequisites.sql',import.meta.url),'utf8');
  const apply=()=>f.pool.query(grants.replaceAll(':"runtime_role"',quote(role)));
  await apply();
  // Isolate the first production failure; the other new grants are checked separately.
  await f.pool.query(`REVOKE SELECT ON public.bb_workpaper_paid_check_items FROM ${quote(role)}`);
  const url=new URL(f.pool.options.connectionString!);url.username=role;url.password='';
  const worker=new Pool({connectionString:url.toString()});
  try{
    let batch=await f.start();
    await assert.rejects(worker.query('SELECT 1 FROM public.bb_workpaper_paid_check_items'),{code:'42501'});
    assert.equal(await advanceWorkpaperBatch(worker),true);
    batch=await f.read(batch.batch_id);
    assert.equal(batch.state,'paused');assert.ok(batch.items.every(i=>i.run_id===null));
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_workpaper_attempts WHERE batch_id=$1',[batch.batch_id])).rows[0].n,0);
    await apply();await apply();
    batch=await f.action(batch,{action:'resume'});
    assert.equal(batch.progressive?.trial_item_ids.length,2,'one trial file per chapter');
    const deadline=performance.now()+60000;
    while((await f.read(batch.batch_id)).items.filter(i=>i.run_id).length<2){
      // Competing consumers must not create duplicate siblings or reservations.
      await Promise.all([advanceWorkpaperBatch(worker),advanceWorkpaperBatch(worker)]);
      const current=await f.read(batch.batch_id);
      assert.notEqual(current.state,'paused',current.error??'unexpected pause');
      assert.ok(current.items.filter(i=>i.run_id).length===2||performance.now()<deadline,JSON.stringify({message:'two trial child runs must become admitted',state:current.state,runs:current.items.map(i=>i.run_id)}));
    }
    batch=await f.read(batch.batch_id);
    const runs=(await f.pool.query('SELECT id FROM bb_runs WHERE owner_user_id=$1 ORDER BY created_at,id',[f.user])).rows.map(r=>r.id as string);
    assert.equal(new Set(runs).size,2);assert.equal(batch.items.filter(i=>i.run_id&&runs.includes(i.run_id)).length,2);
    assert.equal(await advanceWorkpaperBatch(worker),false,'only the two selected trial files are in flight');
    assert.equal((await f.start()).batch_id,batch.batch_id,'retrying submission preserves the frozen batch');
    assert.equal((await f.send('POST',f.base+'/batches',{...f.request,request_id:randomUUID()})).statusCode,409,'another batch cannot enter the active source scope');
    f.setActor(randomUUID());assert.equal((await f.send('GET',f.base+`/batches/${batch.batch_id}`)).statusCode,404);f.setActor(f.user);
    const target=(await f.pool.query('SELECT project_id FROM bb_runs WHERE id=$1',[runs[0]])).rows[0].project_id;
    await assert.rejects(transaction(worker,async c=>{
      const id=randomUUID(),hash='b'.repeat(64);
      await c.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,999,$2,1,$3,'{}','[]','[]')",[target,f.user,hash]);
      await c.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,999,$4,$1,'generation',$4,'queued')",[id,f.user,target,hash]);
    }),{code:'23514'},'the canonical mutex still rejects an unrelated run');
    for(const run of runs)await f.succeed(run,worker);
    await advanceWorkpaperBatch(worker);
    batch=await f.read(batch.batch_id);assert.equal(batch.state,'paused');assert.equal(batch.progressive?.phase,'awaiting_confirmation');
    assert.equal(batch.items.filter(i=>i.run_id===null).length,2,'remaining files require the normal trial confirmation');
    batch=await f.action(batch,{action:'continue_remaining',request_id:randomUUID()});
    for(let i=0;i<2;i++)assert.equal(await advanceWorkpaperBatch(worker),true);
    const remaining=(await f.pool.query('SELECT id FROM bb_runs WHERE owner_user_id=$1 AND NOT(id=ANY($2::text[])) ORDER BY created_at,id',[f.user,runs])).rows.map(r=>r.id as string);
    assert.equal(remaining.length,2);runs.push(...remaining);
    for(const run of remaining)await f.succeed(run,worker);
    await advanceWorkpaperBatch(worker);
    batch=await f.read(batch.batch_id);assert.equal(batch.state,'complete');
    assert.ok(batch.items.every(i=>i.state==='succeeded'&&i.attempt===1));
    const download=await f.send('GET',f.base+`/batches/${batch.batch_id}/download`);
    assert.equal(download.statusCode,200);assert.equal(download.headers['content-type'],'application/zip');
    assert.ok(download.rawPayload.length>100);
    f.setActor(randomUUID());assert.equal((await f.send('GET',f.base+`/batches/${batch.batch_id}/download`)).statusCode,404);f.setActor(f.user);
    const billing=(await f.pool.query(`SELECT count(*)::int n,count(DISTINCT r.run_id)::int runs,
      bool_and(r.state='settled') AS settled FROM bb_credit_reservations r WHERE r.run_id=ANY($1::text[])`,[runs])).rows[0];
    assert.deepEqual(billing,{n:4,runs:4,settled:true});
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_workpaper_attempts WHERE batch_id=$1',[batch.batch_id])).rows[0].n,4);
    assert.equal((await f.pool.query("SELECT has_table_privilege($1,'public.bb_workpaper_paid_check_items','INSERT,UPDATE,DELETE,TRUNCATE') AS mutation",[role])).rows[0].mutation,false);
  }finally{
    await flushPerformanceTraces(worker,5000);await worker.end();await f.pool.query(`DROP OWNED BY ${quote(role)}`);await f.pool.query(`DROP ROLE ${quote(role)}`);await f.close();
  }
});
