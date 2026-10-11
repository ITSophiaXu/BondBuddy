import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {INITIAL_FIXED_PRICES,emptyUpdateDetails} from '@bondbuddy/contracts';
import {createServer} from './server.js';
import {isolatedTestDatabase} from './test-database.js';
import {creditBalance,grantCredits,publishPrices} from './billing.js';
import {auditCredits,correctSettlement} from './billing-ops.js';
import {claim,checkpointStage,pauseAtCheckpoint,recordAuthoringActivity,finish,promoteWordArtifact} from './queue.js';
import {digest,transaction,type PrivateBlobs} from './data.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';
import {accruedAuthoringPoints,measuredActiveMs} from './authoring-progress.js';

test('authoring meter: monotonic, capped, lease bounded and independent of page time',()=>{
  assert.equal(accruedAuthoringPoints(48900,0,0),0);
  let previous=0;
  for(const ms of [1,1000,10000,60000,1800000,86400000,1e12]){
    const n=accruedAuthoringPoints(48900,ms,2500);assert.ok(n>=previous&&n<=Math.floor(48900*.95));previous=n;
  }
  assert.equal(measuredActiveMs({active_ms:1200,clock_at:'2026-01-01T00:00:00Z',lease_until:'2026-01-01T00:00:30Z'},new Date('2026-01-02T00:00:00Z')),31200);
  assert.equal(measuredActiveMs({active_ms:1200,clock_at:'2026-01-01T00:00:00Z',lease_until:null},new Date('2026-01-02T00:00:00Z')),1200);
});

const connection=await isolatedTestDatabase(undefined,'authoring-progress');
test('authoring billing: queue zero, safe pause freezes, resume reuses, cancel settles once, failure releases, legacy preserved',{skip:!connection,timeout:120000},async()=>{
 const pool=new Pool({connectionString:connection}),owner='progress-'+randomUUID();let actor=owner;
 const files=new Map<string,Buffer>();
 const blobs:PrivateBlobs={put:async(k,b)=>{files.set(k,Buffer.from(b));},get:async k=>files.get(k)!,
   getIfExists:async k=>files.get(k)??null,getIfExistsBounded:async k=>files.get(k)??null,exists:async k=>files.has(k),delete:async k=>{files.delete(k);}};
 const app=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:actor,csrfVerified:true}),enableSyntheticQueue:true,enablePaidAuthoring:true});
 const send=(method:string,url:string,payload?:any,headers:Record<string,string>={})=>app.inject({method:method as any,url,payload,headers:{origin:'http://bondbuddy.test',...headers}});
 const ok=(r:any)=>{assert.ok(r.statusCode>=200&&r.statusCode<300,r.body);return r.json();};
 const create=async()=>{
   const p=ok(await send('POST','/api/v1/projects',{kind:'update',name:'Synthetic progress',issuer_name:'Synthetic issuer',market:'sse',offering:'private',update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1',reporting_cutoff:'2026-09-30'}}));
   const b=Buffer.from('Synthetic issuer information'),d={byte_size:b.length,sha256:digest(b)};
   const u=ok(await send('POST','/api/v1/projects/'+p.project_id+'/materials/uploads',{...d,filename:'synthetic.txt',media_type:'text/plain',role:'audit'}));
   assert.equal((await send('PUT',u.upload_url,b,{'content-type':'application/octet-stream'})).statusCode,204);
   const m=ok(await send('POST','/api/v1/projects/'+p.project_id+'/materials/uploads/'+u.upload_id+'/complete',d));
   const i=ok(await send('POST','/api/v1/projects/'+p.project_id+'/input-revisions',{draft_revision:1,material_versions:[{material_id:m.material_id,material_version:1}],requirement_message_ids:[]}));
   const q=ok(await send('POST','/api/v1/projects/'+p.project_id+'/credit-quote',{input_revision:i.input_revision,input_hash:i.input_hash}));
   const run=ok(await send('POST','/api/v1/runs/execute',{execution_request_id:randomUUID(),project_id:p.project_id,input_revision:i.input_revision,input_hash:i.input_hash,task_kind:'update',input_manifest_ref:i.input_hash,storage_origin:'cloud',workspace_id:p.project_id,quote_id:q.quote.quote_id}));
   // Synthetic persisted v1 reservation, representing a task created before this policy rollout.
   await pool.query("UPDATE bb_credit_reservations SET billing_policy='authoring_progress_v1',charged_points=NULL WHERE run_id=$1",[run.run_id]);
   const lot=(await pool.query('SELECT id FROM bb_credit_lots WHERE owner_user_id=$1 AND remaining-frozen>=10000 ORDER BY created_at LIMIT 1',[owner])).rows[0];
   await pool.query('UPDATE bb_credit_lots SET frozen=frozen+10000 WHERE id=$1',[lot.id]);
   await pool.query('INSERT INTO bb_credit_allocations(reservation_id,lot_id,points) VALUES($1,$2,10000)',[run.reservation_id,lot.id]);
   await pool.query("INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason) VALUES($1,$2,$1,'reserve',10000,$3,$4,'test','synthetic_legacy')",[randomUUID(),owner,run.reservation_id,run.run_id]);
   return run;
 };
 const charge=async(id:string)=>ok(await send('GET','/api/v1/runs/'+id+'/credit-charge'));
 const act=async(id:string,kind:string)=>send('POST','/api/v1/runs/'+id+'/'+kind,{reason:'synthetic-test'});
 const age=async(id:string)=>pool.query("UPDATE bb_authoring_progress SET clock_at=now()-interval '30 seconds',lease_until=now()+interval '30 seconds' WHERE run_id=$1",[id]);
 try{
   // Establish the authenticated user before granting test-only credits.
   await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_progress']);
   await transaction(pool,c=>grantCredits(c,{owner,points:1000000,key:'synthetic-progress-funds',source:'purchase',expiresAt:null,actor:'test',reason:'synthetic'}));
   await publishPrices(pool,{id:'progress-test-v1',prices:{...INITIAL_FIXED_PRICES,new_authoring:10000},effectiveAt:'2020-01-01T00:00:00Z',actor:'test',reason:'synthetic'});
   const queued=await create();
   assert.equal((await charge(queued.run_id)).progress.accrued_points,0);
   assert.equal(ok(await act(queued.run_id,'pause')).state,'paused');
   assert.equal(await claim(pool),null);
   ok(await act(queued.run_id,'cancel'));
   assert.equal((await charge(queued.run_id)).progress.charged_points,0);

   const running=await create(),lease=await claim(pool);assert.ok(lease);
   assert.equal((await pool.query('SELECT stage FROM bb_runs WHERE id=$1',[running.run_id])).rows[0].stage,'claimed');
   await age(running.run_id);await checkpointStage(pool,lease,'materials_ready',{synthetic:true});
   const before=(await charge(running.run_id)).progress.accrued_points;assert.ok(before>400&&before<10000);
   ok(await act(running.run_id,'pause'));
   const frozen=(await charge(running.run_id)).progress.accrued_points;
   await checkpointStage(pool,lease,'model_generation',{logical_call_id:'synthetic-saved-result'});
   assert.equal((await charge(running.run_id)).progress.accrued_points,frozen);
   assert.equal(await recordAuthoringActivity(pool,lease,{activity_id:'a'.repeat(64),code:'read_materials',state:'completed'}),false);
   assert.equal(await pauseAtCheckpoint(pool,lease),true);
   assert.equal((await charge(running.run_id)).progress.accrued_points,frozen);
   ok(await act(running.run_id,'resume'));
   const resumed=await claim(pool);assert.ok(resumed);
   assert.equal((resumed.checkpoint.stages as any).model_generation.logical_call_id,'synthetic-saved-result');
   const activity={activity_id:'b'.repeat(64),code:'write_document' as const,state:'started' as const};
   assert.equal(await recordAuthoringActivity(pool,resumed,activity),true);
   assert.equal(await recordAuthoringActivity(pool,resumed,activity),false);
   const events=ok(await send('GET','/api/v1/runs/'+running.run_id+'/events')).items;
   assert.ok(events.some((e:any)=>e.payload.authoring_activity?.code==='write_document'));
   actor='foreign-'+randomUUID();assert.equal((await act(running.run_id,'pause')).statusCode,404);assert.equal((await send('GET','/api/v1/runs/'+running.run_id+'/credit-charge')).statusCode,404);actor=owner;
   const cancels=await Promise.all([act(running.run_id,'cancel'),act(running.run_id,'cancel')]);assert.deepEqual(cancels.map(x=>x.statusCode).sort(),[200,409]);
   const final=await charge(running.run_id);assert.equal(final.state,'settled');assert.ok(final.progress.charged_points>=frozen);
   assert.equal(final.progress.charged_points+final.progress.released_points,10000);
   assert.equal(await recordAuthoringActivity(pool,resumed,{...activity,state:'completed'}),false);
   const history=ok(await send('GET','/api/v1/credits/consumption-history')).items.find((i:any)=>i.run_id===running.run_id);
   assert.equal(history.charged_points,final.progress.charged_points);assert.equal(history.released_points,final.progress.released_points);
   assert.equal((await auditCredits(pool)).consistent,true);
   const balance=await creditBalance(pool,owner);
   await correctSettlement(pool,{runId:running.run_id,actor:'test',reason:'synthetic correction'});
   await correctSettlement(pool,{runId:running.run_id,actor:'test',reason:'synthetic correction'});
   assert.equal((await creditBalance(pool,owner)).available,balance.available+final.progress.charged_points);

   const failed=await create(),failureLease=await claim(pool);assert.ok(failureLease);await age(failed.run_id);
   await finish(pool,failureLease,'failed',{errorCode:'DATA_UNAVAILABLE'});
   assert.equal((await charge(failed.run_id)).progress.charged_points,0);
   const legacy=await create();await pool.query("UPDATE bb_credit_reservations SET billing_policy='on_delivery' WHERE run_id=$1",[legacy.run_id]);
   assert.ok(await claim(pool));await age(legacy.run_id);ok(await act(legacy.run_id,'cancel'));
   assert.equal((await charge(legacy.run_id)).progress.charged_points,0);
   const success=await create(),successLease=await claim(pool);assert.ok(successLease);
   const revision=await promoteWordArtifact(pool,successLease,makeSyntheticDocxFixture({text:'Synthetic revised'}),blobs,'generated_pair_v1');
   const clean=await promoteWordArtifact(pool,successLease,makeSyntheticDocxFixture({text:'Synthetic clean'}),blobs,'generated_pair_v1');
   await checkpointStage(pool,successLease,'word_delivery_pair',{revision_artifact_id:revision.artifactId,clean_artifact_id:clean.artifactId});
   ok(await act(success.run_id,'pause'));
   assert.equal((await finish(pool,successLease,'succeeded',{artifactId:revision.artifactId,artifactVersion:1,blobs})).state,'paused');
   assert.equal((await charge(success.run_id)).state,'held');
   ok(await act(success.run_id,'resume'));const deliveryLease=await claim(pool);assert.ok(deliveryLease);
   await finish(pool,deliveryLease,'succeeded',{artifactId:revision.artifactId,artifactVersion:1,blobs});
   assert.equal((await charge(success.run_id)).progress.charged_points,10000);
   assert.equal((await auditCredits(pool)).consistent,true);
 }finally{await app.close();await pool.end();}
});
