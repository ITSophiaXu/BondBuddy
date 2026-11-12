import assert from 'node:assert/strict';
import test from 'node:test';
import {Pool} from 'pg';
import {M4_BILLING_TASKS} from '@bondbuddy/contracts';
import {isolatedTestDatabase} from './test-database.js';
import {transaction,uid,digest,type PrivateBlobs} from './data.js';
import {grantCredits,creditBalanceExact} from './billing.js';
import {auditCredits,correctSettlement} from './billing-ops.js';
import {publishM4BillingConfig,quoteM4,reserveM4} from './m4-billing.js';
import {taskRefundEligibility,createTaskRefund,decideTaskRefund,listTaskRefunds} from './task-refunds.js';
import {grantBillingPermission} from './billing-permissions.js';
import {inspectAndIsolateBillingScope,repairWalletProjection,billingAuditHash,resumeBillingScope} from './billing-safety.js';
import {enqueue,claim,finish,action,resumePausedRun,promoteWordArtifact,recordPotentialCall,reconcilePausedCall} from './queue.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';
import {inputManifestHash} from './production-rule-pin.js';
import {readSubscriptionFacts} from './subscription-facts-report.js';

const database=await isolatedTestDatabase(undefined,'actual-charge-regression');
test('synthetic actual-charge regression preserves historical settlement and caps every return at actual debit',
 {skip:!database,timeout:120000},async t=>{
 const pool=new Pool({connectionString:database});
 const person=async()=>{const owner=uid();await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'actual_'+owner.slice(0,8)]);return owner;};
 const fund=async(owner:string)=>transaction(pool,c=>grantCredits(c,{owner,source:'existing_grant',key:uid(),points:1000,expiresAt:null,actor:'synthetic',reason:'Synthetic isolated regression'}));
 const operator=await person();
 await grantBillingPermission(pool,{requestId:uid(),userId:operator,permission:'task_refund_approve',actor:'synthetic',reason:'Synthetic independent approval'});
 await grantBillingPermission(pool,{requestId:uid(),userId:operator,permission:'billing_repair',actor:'synthetic',reason:'Synthetic independent repair'});
 const budgets=Object.fromEntries(Object.keys(M4_BILLING_TASKS).map(key=>[key,{input_tokens:166667,output_tokens:166666,reserve_factor:1}]));
 await publishM4BillingConfig(pool,{id:uid(),config:{model_id:'synthetic-model',rates:{'synthetic-model':{input_microyuan_per_million:1000000,cached_microyuan_per_million:1000000,output_microyuan_per_million:1000000}},budgets},effective_at:'2026-01-01T00:00:00Z',actor:'synthetic',reason:'Retained historical metered contract fixture'});
 async function metered(split=false){
  const owner=await person(),project=uid(),topic=uid(),runId=uid(),artifact=uid(),ev=uid(),hash='a'.repeat(64);
  if(split){for(const points of [4,996])await transaction(pool,c=>grantCredits(c,{owner,source:'existing_grant',key:uid(),points,expiresAt:null,actor:'synthetic',reason:'Synthetic cross-lot historical fixture'}));}
  else await fund(owner);
  let reservation='';
  await transaction(pool,async c=>{
   await c.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic historical metered contract','qa')",[project,owner]);
   await c.query("INSERT INTO bb_m4_topics(id,owner_user_id,project_id,name,creation_request_id,request_hash) VALUES($1,$2,$3,'Synthetic topic',$1,$4)",[topic,owner,project,hash]);
   await c.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')",[project,owner,hash]);
   const run=(await c.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'qa',$4,'queued') RETURNING *",[runId,owner,project,hash])).rows[0];
   await enqueue(c,run,'m4_qa_v1');
   await c.query("INSERT INTO bb_m4_executions(run_id,owner_user_id,topic_id,manifest,input_hash) VALUES($1,$2,$3,'{\"kind\":\"qa\"}',$4)",[runId,owner,topic,hash]);
   const quote=(await quoteM4(c,owner,topic,'m4_Q03',hash,{},false)).quote;
   assert.equal(quote.points,100);assert.equal(quote.billing_method,'metered_capped');
   await reserveM4(c,owner,run,quote.quote_id,topic,hash);reservation=run.reservation_id;
  });
  const text='Synthetic retained QA delivery',sha=digest(Buffer.from(text));
  await pool.query('INSERT INTO bb_m4_text_delivery_evidence(id,owner_user_id,run_id,artifact_id,artifact_version,sha256,byte_size,content) VALUES($1,$2,$3,$4,1,$5,$6,$7)',[ev,owner,runId,artifact,sha,Buffer.byteLength(text),text]);
  await pool.query("INSERT INTO bb_artifact_versions(id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status,m4_text_delivery_evidence_id) VALUES($1,1,$2,$3,'text/plain',$4,$5,'passed','available',$6)",[artifact,owner,runId,sha,'synthetic/'+artifact,ev]);
  await pool.query("INSERT INTO bb_m4_artifacts(owner_user_id,topic_id,run_id,artifact_id,artifact_version,kind,filename,byte_size,input_hash,body_content,preview_content) VALUES($1,$2,$3,$4,1,'qa_text','synthetic.txt',$5,$6,$7,$7)",[owner,topic,runId,artifact,Buffer.byteLength(text),hash,text]);
  await pool.query("INSERT INTO bb_m4_metering(run_id,owner_user_id,status,actual_points,charged_points,evidence) VALUES($1,$2,'verified',7,7,'{\"synthetic\":true}')",[runId,owner]);
  await pool.query("UPDATE bb_runs SET artifact_id=$2,artifact_version=1,state='succeeded' WHERE id=$1",[runId,artifact]);
  return{owner,runId,reservation};
 }
 try{
  await t.test('new partial metering writes actual allocations, stays healthy and refunds seven rather than the hundred-point hold',async()=>{
   const f=await metered();assert.equal((await creditBalanceExact(pool,f.owner)).available,993n);
   assert.deepEqual((await pool.query('SELECT points,charged_points FROM bb_credit_allocations WHERE reservation_id=$1',[f.reservation])).rows,[{points:'100',charged_points:'7'}]);
   assert.equal((await auditCredits(pool,f.owner)).consistent,true);
   assert.equal((await inspectAndIsolateBillingScope(pool,{kind:'wallet',owner:f.owner})).status,'healthy');
   const e=await taskRefundEligibility(pool,f.owner,f.runId);assert.equal(e.units[0].available_points,'7');
   const request=await createTaskRefund(pool,f.owner,f.runId,{request_id:uid(),item_ids:[e.units[0].item_id],reason:'Synthetic quality concern'});
   assert.equal(request.requested_points,'7');
   const decision={request_id:uid(),item_ids:[e.units[0].item_id],reason:'Synthetic approved quality correction'};
   const results=await Promise.all([decideTaskRefund(pool,operator,request.refund_request_id,decision),decideTaskRefund(pool,operator,request.refund_request_id,decision)]);
   assert(results.every(r=>r.refunded_points==='7'&&r.state==='approved'));
   assert.equal((await creditBalanceExact(pool,f.owner)).available,1000n);
   assert.equal((await auditCredits(pool,f.owner)).consistent,true);
   assert.equal((await correctSettlement(pool,{runId:f.runId,actor:'synthetic',reason:'No additional refund after seven returned'})).length,0);
  });
  await t.test('historical NULL allocation derives only evidenced original ordering and whole correction cannot over-return',async()=>{
   const definition=(await pool.query("SELECT pg_get_functiondef('bb_m4_credit_finalize_run()'::regprocedure) definition")).rows[0].definition as string;
   const old=definition.replace('UPDATE bb_credit_allocations SET charged_points=take WHERE reservation_id=r.id AND lot_id=allocation.lot_id;','');
   assert.notEqual(old,definition);await pool.query(old);
   let f:Awaited<ReturnType<typeof metered>>;
   try{f=await metered(true);}finally{await pool.query(definition);}
   const events=(await pool.query('SELECT * FROM bb_credit_events WHERE reservation_id=$1 ORDER BY id',[f!.reservation])).rows;
   assert.equal((await pool.query('SELECT charged_points FROM bb_credit_allocations WHERE reservation_id=$1',[f!.reservation])).rows[0].charged_points,null);
   assert.equal((await pool.query('SELECT count(*)::int n,sum(bb_credit_allocation_charge(reservation_id,lot_id))::text charge FROM bb_credit_allocations WHERE reservation_id=$1',[f!.reservation])).rows[0].n,2);
   assert.equal((await pool.query('SELECT sum(bb_credit_allocation_charge(reservation_id,lot_id))::text charge FROM bb_credit_allocations WHERE reservation_id=$1',[f!.reservation])).rows[0].charge,'7');
   assert.equal((await auditCredits(pool,f!.owner)).consistent,true);
   assert.equal((await taskRefundEligibility(pool,f!.owner,f!.runId)).units[0].available_points,'7');
   const month=new Date(Date.now()+8*3600000).toISOString().slice(0,7),beforeReport=await creditBalanceExact(pool,f!.owner);
   const monthly=await readSubscriptionFacts(pool,month,month),charges=(await pool.query('SELECT lot_id,bb_credit_allocation_charge(reservation_id,lot_id)::text points FROM bb_credit_allocations WHERE reservation_id=$1',[f!.reservation])).rows;
   for(const charge of charges){
    const observed=monthly.original_batches.find(b=>b.origin_lot_id===charge.lot_id);
    if(charge.points==='0')assert.equal(observed,undefined);else{assert.ok(observed);assert.equal(observed.redeemed_points,charge.points);assert.equal(observed.consideration_complete,true);}
   }
   assert.deepEqual(await creditBalanceExact(pool,f!.owner),beforeReport,'historical charge reporting is read only');
   await correctSettlement(pool,{runId:f!.runId,actor:'synthetic',reason:'Synthetic actual historical charge correction'});
   assert.equal((await creditBalanceExact(pool,f!.owner)).available,1000n);
   assert.deepEqual((await pool.query("SELECT * FROM bb_credit_events WHERE reservation_id=$1 AND kind<>'correction' ORDER BY id",[f!.reservation])).rows,events);
   assert.equal((await auditCredits(pool,f!.owner)).consistent,true);
   assert.equal((await listTaskRefunds(pool,operator,{state:'approved'})).items.length,1);
  });
  await t.test('an already pending historical hundred-point request reports the actual seven-point approval',async()=>{
   const f=await metered(true),e=await taskRefundEligibility(pool,f.owner,f.runId),id=uid();
   await pool.query('INSERT INTO bb_task_refund_requests(id,owner_user_id,run_id,reservation_id,request_id,request_hash,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,f.owner,f.runId,f.reservation,uid(),'b'.repeat(64),'Synthetic pending historical request']);
   await pool.query('INSERT INTO bb_task_refund_request_items VALUES($1,$2,$3)',[id,f.reservation,e.units[0].item_id]);
   const decided=await decideTaskRefund(pool,operator,id,{request_id:uid(),item_ids:[e.units[0].item_id],reason:'Synthetic actual charged approval'});
   assert.equal(decided.requested_points,'100');assert.equal(decided.refunded_points,'7');assert.equal(decided.state,'partially_approved');
   assert.equal((await listTaskRefunds(pool,operator,{state:'partially_approved'})).items[0].refund_request_id,id);
   assert.equal((await creditBalanceExact(pool,f.owner)).available,1000n);assert.equal((await auditCredits(pool,f.owner)).consistent,true);
  });
  await t.test('an existing historical over-return remains immutable and requires independent review',async()=>{
   const f=await metered(),origin=(await pool.query('SELECT lot_id FROM bb_credit_allocations WHERE reservation_id=$1',[f.reservation])).rows[0].lot_id;
   // Reproduce an already committed old whole-return event; no production
   // correction API or new quality approval may create this excessive return.
   await transaction(pool,c=>grantCredits(c,{owner:f.owner,source:'correction',key:`settlement-correction:${f.reservation}:${origin}`,points:100,expiresAt:null,actor:'synthetic-old-operator',reason:'Synthetic historical over-return',reservationId:f.reservation,runId:f.runId}));
   const before=await creditBalanceExact(pool,f.owner),events=(await pool.query('SELECT * FROM bb_credit_events WHERE reservation_id=$1 ORDER BY id',[f.reservation])).rows;
   assert.equal(before.available,1093n);assert.equal((await auditCredits(pool,f.owner)).reservationDrift.length,1);
   await assert.rejects(correctSettlement(pool,{runId:f.runId,actor:'synthetic',reason:'Must not add another return'}),{code:'DATA_UNAVAILABLE'});
   assert.equal((await inspectAndIsolateBillingScope(pool,{kind:'wallet',owner:f.owner})).status,'isolated');
   assert.deepEqual(await creditBalanceExact(pool,f.owner),before);
   assert.deepEqual((await pool.query('SELECT * FROM bb_credit_events WHERE reservation_id=$1 ORDER BY id',[f.reservation])).rows,events);
  });
 }finally{await pool.end();}
});

for(const mode of ['settle','cancel','provider'] as const)test(`synthetic isolated wallet preserves ready delivery and ${mode} after independent recovery`,
 {skip:!database,timeout:120000},async()=>{
 const cancel=mode==='cancel',pool=new Pool({connectionString:database}),owner=uid(),operator=uid(),project=uid(),runId=uid(),quote=uid(),reservation=uid(),lot=uid();
 const store=new Map<string,Buffer>();const blobs:PrivateBlobs={put:async(k,b)=>{store.set(k,Buffer.from(b));},get:async k=>store.get(k)!,getIfExists:async k=>store.get(k)??null,getIfExistsBounded:async k=>store.get(k)??null,exists:async k=>store.has(k),delete:async k=>{store.delete(k);}};
 const result:any={answers:[{question_id:'q0',answer:'Synthetic answer'}]},manifest={questions:[{id:'q0',question:'Synthetic question'}]},hash=inputManifestHash(manifest);
 try{
  for(const person of [owner,operator])await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[person,'recovery_'+person.slice(0,8)]);
  await grantBillingPermission(pool,{requestId:uid(),userId:operator,permission:'billing_repair',actor:'synthetic',reason:'Synthetic independent recovery'});
  await transaction(pool,async c=>{
   await grantCredits(c,{owner,source:'existing_grant',key:lot,points:1000,expiresAt:null,actor:'synthetic',reason:'Synthetic lifecycle fixture'});
   await c.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic lifecycle','generation')",[project,owner]);
   await c.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,$4,'[]','[]')",[project,owner,hash,manifest]);
   const run=(await c.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'generation',$4,'queued') RETURNING *",[runId,owner,project,hash])).rows[0];
   await c.query("INSERT INTO bb_project_qa_runs(run_id,owner_user_id,project_id,sequence,operation,manifest,input_hash) VALUES($1,$2,$3,1,'answer',$4,$5)",[runId,owner,project,manifest,hash]);
   await c.query("INSERT INTO bb_project_qa_quotes(id,owner_user_id,run_id,input_hash,question_count,unit_points,points,price_version) VALUES($1,$2,$3,$4,1,60,60,'project-qa-question-60-v1')",[quote,owner,runId,hash]);
   await c.query('INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points) VALUES($1,$2,$3,$4,60)',[reservation,owner,runId,quote]);
   await c.query("UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1",[runId,reservation]);
   const origin=(await c.query('SELECT id FROM bb_credit_lots WHERE owner_user_id=$1',[owner])).rows[0].id;
   await c.query('INSERT INTO bb_credit_allocations(reservation_id,lot_id,points) VALUES($1,$2,60)',[reservation,origin]);
   await c.query('UPDATE bb_credit_lots SET frozen=60 WHERE id=$1',[origin]);
   await c.query("INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason) VALUES($1,$2,$1,'reserve',60,$3,$4,'synthetic','Synthetic reserve')",[uid(),owner,reservation,runId]);
   await enqueue(c,run,'project_qa_v1');
  });
  const lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,runId);
  const doc=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:'Synthetic ready Word'}),blobs,'generated_review_v1');
  const artifact=(await pool.query('SELECT * FROM bb_artifact_versions WHERE id=$1',[doc.artifactId])).rows[0];
  result.document={sha256:artifact.sha256.trim(),key:artifact.object_key,byte_size:(await blobs.get(artifact.object_key)).length};
  await pool.query('UPDATE bb_project_qa_runs SET result=$2,result_hash=$3 WHERE run_id=$1',[runId,result,inputManifestHash(result)]);
  if(mode==='provider')await recordPotentialCall(pool,lease,'synthetic-billing-pending',1);
  const origin=(await pool.query('SELECT id FROM bb_credit_lots WHERE owner_user_id=$1',[owner])).rows[0].id;
  await pool.query('UPDATE bb_credit_lots SET remaining=999 WHERE id=$1',[origin]);
  assert.equal((await inspectAndIsolateBillingScope(pool,{kind:'wallet',owner})).status,'isolated');
  const paused=await finish(pool,lease,'succeeded',{artifactId:doc.artifactId,artifactVersion:1,blobs});
  assert.equal(paused.state,'paused');assert.equal(paused.stage,'billing_reconcile');
  const job=(await pool.query('SELECT * FROM bb_jobs WHERE id=$1',[lease.jobId])).rows[0];
  assert.equal(job.attempts,0);assert.equal(job.checkpoint.billing_terminal.artifactId,doc.artifactId);
  assert.equal(await resumePausedRun(pool,owner,runId,'billing_reconciled'),false);
  if(cancel){
   await Promise.all([action(pool,owner,runId,'cancel',uid()),action(pool,owner,runId,'cancel',uid())]);
   assert.ok((await pool.query('SELECT billing_cancel_requested_at FROM bb_jobs WHERE id=$1',[lease.jobId])).rows[0].billing_cancel_requested_at);
  }
  assert.equal((await creditBalanceExact(pool,owner)).frozen,60n);
  await assert.rejects(pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[runId]),{code:'55000'},'SQL money isolation remains enforced');
  const scope={kind:'wallet' as const,owner};
  await repairWalletProjection(pool,{requestId:uid(),actor:operator,reason:'Synthetic independently verified projection',owner,expectedAuditHash:billingAuditHash(await auditCredits(pool,owner))});
  assert.equal(await resumePausedRun(pool,owner,runId,'billing_reconciled'),false,'projection repair cannot clear isolation');
  assert.equal((await resumeBillingScope(pool,{requestId:uid(),actor:operator,reason:'Synthetic independent resume',scope})).status,'resumed');
  if(mode==='provider'){
   assert.equal(await resumePausedRun(pool,owner,runId,'billing_reconciled'),false);
   assert.equal((await pool.query('SELECT stage FROM bb_jobs WHERE id=$1',[lease.jobId])).rows[0].stage,'provider_reconcile');
   await reconcilePausedCall(pool,owner,runId,'synthetic-billing-pending',1,'confirmed_not_sent');
   assert.equal(await resumePausedRun(pool,owner,runId,'provider_reconciled'),true);
  }else assert.deepEqual((await Promise.all([resumePausedRun(pool,owner,runId,'billing_reconciled'),resumePausedRun(pool,owner,runId,'billing_reconciled')])).sort(),[false,true]);
  if(!cancel){
   const restored=await claim(pool);assert.ok(restored);assert.equal(restored.runId,runId);
   assert.deepEqual(restored.checkpoint.billing_terminal,job.checkpoint.billing_terminal);
   await finish(pool,restored,'succeeded',{artifactId:doc.artifactId,artifactVersion:1,blobs});
   assert.equal((await pool.query('SELECT count(*)::int n FROM bb_artifact_versions WHERE run_id=$1',[runId])).rows[0].n,1);
  }
  assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1',[runId])).rows[0].state,cancel?'cancelled':'succeeded');
  assert.equal((await pool.query('SELECT state FROM bb_credit_reservations WHERE id=$1',[reservation])).rows[0].state,cancel?'released':'settled');
  assert.equal((await creditBalanceExact(pool,owner)).available,cancel?1000n:940n);assert.equal((await creditBalanceExact(pool,owner)).frozen,0n);
  assert.equal((await auditCredits(pool,owner)).consistent,true);
 }finally{await pool.end();}
});
