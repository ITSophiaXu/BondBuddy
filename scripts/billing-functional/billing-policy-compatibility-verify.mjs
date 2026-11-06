import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {readFile,writeFile,stat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {Pool} from 'pg';
import {baseURL,config,pgBase,runtime,terms,cleanEnvironment} from './config.mjs';
import {syntheticPaymentProvider} from './provider.mjs';

// Real HTTP sessions, one database/account and production worker input gates.
// Most scenarios exercise real queue/settlement with synthetic milestones and
// artifacts. Pipeline scenarios also use runPipelineOnce/defaultRunStages,
// replacing only model/file-output stages. No generated-content quality claim.
const clean=cleanEnvironment();for(const key of Object.keys(process.env))if(!(key in clean))delete process.env[key];Object.assign(process.env,clean);
const {createServer}=await import('../../apps/api/dist/server.js');
const {claim,checkpointStage,pauseAtCheckpoint,releaseLease,finish}=await import('../../apps/api/dist/queue.js');
const {syntheticReviewPair}=await import('../../apps/api/dist/review-delivery-test-fixture.js');
const {auditCredits}=await import('../../apps/api/dist/billing-audit.js');
const {automaticBillingEnabled}=await import('../../apps/api/dist/automatic-billing-context.js');
const {inputLockStage,runPipelineOnce,defaultRunStages}=await import('../../apps/worker/dist/run-pipeline.js');
const saved=config(),connectionString=pgBase+saved.database;
const legacyPool=new Pool({connectionString,max:4}),automaticPool=new Pool({connectionString,max:4});
const nonce=randomUUID().slice(0,8),evidence=join(runtime,'billing-policy-compatibility-'+nonce);mkdirSync(evidence,{recursive:true});
const startedAt=new Date().toISOString(),checks=[],runs=[],orders=[],httpLog=join(evidence,'http.jsonl');
const workerGates=[],workerPipelines=[],lockedBindings=new Map();
const record=name=>{checks.push(name);console.log('PASS '+name);};
const sql=async(query,params)=>(await automaticPool.query(query,params)).rows;
const blobPath=key=>join(runtime,'blobs',createHash('sha256').update(key).digest('hex'));
const get=key=>readFile(blobPath(key));
const getIfExists=async key=>{try{return await get(key);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const blobs={put:(key,bytes)=>writeFile(blobPath(key),bytes),get,getIfExists,
  getIfExistsBounded:async(key,limit)=>{try{assert.ok((await stat(blobPath(key))).size<=limit);return await get(key);}catch(error){if(error.code==='ENOENT')return null;throw error;}},
  exists:async key=>(await getIfExists(key))!==null,delete:async key=>{try{await unlink(blobPath(key));}catch(error){if(error.code!=='ENOENT')throw error;}}};
const apps=[],urls={main:baseURL},cookies=new Map();let owner,username,failure,finalAuditConsistent,finalActiveRuns;
async function send(target,method,path,body,expected=200){
  const headers={origin:baseURL,cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),'x-bb-csrf':cookies.get('bb_csrf')??''};
  if(body!==undefined)headers['content-type']='application/json';
  const response=await fetch(urls[target]+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  for(const value of response.headers.getSetCookie()){const pair=value.split(';',1)[0],at=pair.indexOf('=');cookies.set(pair.slice(0,at),pair.slice(at+1));}
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  appendFileSync(httpLog,JSON.stringify({at:new Date().toISOString(),target,method,path,body:body&&Object.hasOwn(body,'password')?{...body,password:'[synthetic password omitted]'}:body,status:response.status,data})+'\n');
  assert.equal(response.status,expected,JSON.stringify({target,path,status:response.status,data}));return data;
}
const post=(target,path,body={},expected=200)=>send(target,'POST',path,body,expected);
const read=(target,path)=>send(target,'GET',path);
const balance=async()=>{const r=(await sql('SELECT COALESCE(sum(remaining-frozen),0)::text available,COALESCE(sum(frozen),0)::text held FROM bb_credit_lots WHERE owner_user_id=$1',[owner]))[0];return {available:BigInt(r.available),held:BigInt(r.held)};};
async function expectBalance(available,held=0){assert.deepEqual(await balance(),{available:BigInt(available),held:BigInt(held)});}
const charge=id=>read('automatic','/api/v1/runs/'+id+'/credit-charge');
const ledger=id=>sql('SELECT id,quote_id,state,billing_policy,points::text,charged_points::text FROM bb_credit_reservations WHERE owner_user_id=$1 AND run_id=$2',[owner,id]);
const allocations=id=>sql(`SELECT a.lot_id,a.points::text,a.charged_points::text,l.source_key,l.cash_order_id,l.cash_basis_fen::text,l.cash_basis_points::text
  FROM bb_credit_allocations a JOIN bb_credit_reservations r ON r.id=a.reservation_id JOIN bb_credit_lots l ON l.id=a.lot_id
  WHERE r.owner_user_id=$1 AND r.run_id=$2 ORDER BY l.created_at,l.id`,[owner,id]);
async function topup(amount){const o=await post('main','/api/v1/commerce/topups',{request_id:randomUUID(),amount_fen:String(amount),provider:'wechat'},201);orders.push(o.order_id);return o;}
async function pay(id){await post('main','/__billing-test/api/payment/outcome',{id,outcome:'paid',delivery:'query'});return post('automatic','/api/v1/credits/recharge-orders/'+id+'/refresh');}
async function prepare(mode){const id=randomUUID(),s=await post('main','/__billing-test/api/review/prepare',{id,mode});const t=s.tasks.find(t=>t.id===id);assert.ok(t);return t;}
async function execute(target,t){const run=await post(target,'/api/v1/projects/'+t.project_id+'/review-executions',t.request);runs.push(run.run_id);return run;}
async function workerGate(pool,lease){
  const run=(await pool.query('SELECT * FROM bb_runs WHERE id=$1 AND owner_user_id=$2',[lease.runId,owner])).rows[0];assert.ok(run);
  const locked=(await pool.query(`SELECT r.input_revision,r.input_hash,i.manifest,c.id reservation_id,c.quote_id,c.points::text,c.billing_policy
    FROM bb_runs r JOIN bb_input_revisions i ON i.owner_user_id=r.owner_user_id AND i.project_id=r.project_id AND i.revision=r.input_revision
    JOIN bb_credit_reservations c ON c.id=r.reservation_id AND c.owner_user_id=r.owner_user_id WHERE r.id=$1 AND r.owner_user_id=$2`,[run.id,owner])).rows[0];
  assert.ok(locked);if(lockedBindings.has(run.id))assert.deepEqual(locked,lockedBindings.get(run.id));else lockedBindings.set(run.id,locked);
  const ctx={pool,blobs,lease,run,signal:AbortSignal.timeout(30000),checkpoint:lease.checkpoint.stages??{},values:new Map()};
  const gate=await inputLockStage.run(ctx);assert.equal(gate.kind,'done',JSON.stringify({run:run.id,gate}));
  lease.verifiedInputLock=gate.value??gate.checkpoint??{};
  workerGates.push({run:run.id,automatic:automaticBillingEnabled(pool),inputRevision:run.input_revision,inputHash:run.input_hash,
    reservationId:locked.reservation_id,quoteId:locked.quote_id,billingPolicy:locked.billing_policy,gate:lease.verifiedInputLock});
}
async function nextOwn(id){
  const next=(await sql(`SELECT r.id,r.owner_user_id FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id WHERE
    (j.state='queued' OR (j.state='running' AND j.lease_until<now())) AND r.state NOT IN ('cancelled','failed','succeeded','test_completed','rejected')
    AND j.job_type IN ('review','update') ORDER BY j.created_at LIMIT 1`))[0];
  assert.equal(next?.id,id,'Another task owns the queue; no unrelated task was claimed');assert.equal(next.owner_user_id,owner);
}
async function claimOwn(pool,id){
  await nextOwn(id);
  const lease=await claim(pool,120,{runKinds:['review','update']});
  if(!lease||lease.runId!==id||lease.owner!==owner){if(lease)await releaseLease(pool,lease,'policy_compatibility_unrelated_guard');throw Error('Queue ownership changed');}
  await workerGate(pool,lease);return lease;
}
async function deliver(pool,lease){const artifact=await syntheticReviewPair(pool,lease,blobs);return finish(pool,lease,'succeeded',{artifactId:artifact.artifactId,artifactVersion:1,blobs});}
async function pipelineOwn(id,stages){
  await nextOwn(id);let taken,unexpected;
  try{
    const outcome=await runPipelineOnce({pool:automaticPool,blobs,leaseSeconds:120,runKinds:['review','update'],stages,
      onLease:lease=>{if(!lease)return;if(lease.runId!==id||lease.owner!==owner){unexpected=lease;throw Error('Queue ownership changed before compatibility pipeline');}taken=lease;},
      onUnexpectedError:error=>assert.fail(JSON.stringify(error))});
    assert.ok(taken);return{outcome,lease:taken};
  }finally{if(unexpected)await releaseLease(automaticPool,unexpected,'policy_compatibility_unrelated_guard');}
}
const runEvents=id=>sql('SELECT id,kind,lot_id,points::text FROM bb_credit_events WHERE owner_user_id=$1 AND run_id=$2 ORDER BY id',[owner,id]);
async function rejectRepeatedFinish(lease){
  const before={balance:await balance(),reservation:await ledger(lease.runId),allocations:await allocations(lease.runId),events:await runEvents(lease.runId)};
  await assert.rejects(finish(automaticPool,lease,'failed',{errorCode:'SYNTHETIC_DUPLICATE_FAILURE',failedStage:'word_delivery'}),error=>error.status===409&&error.code==='ALREADY_TERMINAL');
  assert.deepEqual({balance:await balance(),reservation:await ledger(lease.runId),allocations:await allocations(lease.runId),events:await runEvents(lease.runId)},before);
}
async function updateRequest(projectId,sourceRun,requirements){
  const body={execution_request_id:randomUUID(),source_run_id:sourceRun,requirements},path='/api/v1/projects/'+projectId+'/review-updates';
  const q=await post('legacy',path+'/quote',body);assert.equal(q.quote.points,'14900');assert.equal(q.quote.pricing_mode,undefined);
  return {path,body:{...body,quote_id:q.quote.quote_id},quote:q.quote};
}
try{
  assert.deepEqual(await sql('SELECT current_database() database,instance_id FROM bb_local_billing_instance'),[{database:saved.database,instance_id:saved.id}]);
  for(const [name,pool,automatic] of [['legacy',legacyPool,false],['automatic',automaticPool,true]]){
    const app=createServer({pool,blobs,enableSubscriptionBilling:automatic,enableOutcomePricing:false,enablePaidAuthoring:true,enablePaidReview:true,enableSyntheticQueue:true,
      paymentProviders:[syntheticPaymentProvider(pool,saved)],allowedOrigin:baseURL,auth:{termsVersion:terms}});apps.push(app);urls[name]=await app.listen({host:'127.0.0.1',port:0});
  }
  assert.equal(automaticBillingEnabled(legacyPool),false);assert.equal(automaticBillingEnabled(automaticPool),true);
  username='policy_compat_'+nonce;owner=(await post('main','/api/v1/auth/register',{username,password:'Synthetic-Policy-2026!',accepted_terms_version:terms},201)).user_id;
  await expectBalance(0);record('same marker database and authenticated account are shared by real legacy and automatic HTTP servers');

  const initial=await topup(1);await pay(initial.order_id);const old=await prepare('dynamic');assert.equal(old.quote.points,'27195');
  const first=await execute('automatic',old);await expectBalance(1);let receipt=await charge(first.run_id);
  assert.equal(receipt.progress.policy,'authoring_balance_v2');assert.equal(receipt.quote.quote_id,old.request.quote_id);
  assert.equal((await ledger(first.run_id))[0].points,'27195');
  const replay=await post('automatic','/api/v1/projects/'+old.project_id+'/review-executions',old.request);assert.equal(replay.run_id,first.run_id);
  record('automatic HTTP accepts an old v2 quotation with one point, retains its locked 27195 price and never imposes a full-price hold');
  let lease=await claimOwn(legacyPool,first.run_id);await checkpointStage(legacyPool,lease,'input_lock',{synthetic:true,source:'old-config-worker',saved_input:'must-survive-upgrade'});assert.equal(await pauseAtCheckpoint(legacyPool,lease),true);await expectBalance(0);
  const snapshot=(await sql('SELECT checkpoint FROM bb_jobs WHERE run_id=$1 AND owner_user_id=$2',[first.run_id,owner]))[0].checkpoint;
  const small=await topup(1000);await pay(small.order_id);
  await post('automatic','/api/v1/runs/'+first.run_id+'/resume',{reason:'synthetic_policy_upgrade'});await expectBalance(1000);
  lease=await claimOwn(automaticPool,first.run_id);assert.deepEqual(lease.checkpoint.stages.input_lock,snapshot.stages.input_lock);
  await checkpointStage(automaticPool,lease,'model_generation',{synthetic:true,source:'new-automatic-worker',logical_call_id:'same-saved-run'});assert.equal(await pauseAtCheckpoint(automaticPool,lease),true);
  await expectBalance(0);receipt=await charge(first.run_id);assert.equal(receipt.progress.policy,'authoring_balance_v2');assert.equal(receipt.progress.charged_points,'1001');
  assert.equal((await ledger(first.run_id))[0].billing_policy,'authoring_balance_v2');
  record('new automatic worker resumes the legacy checkpoint with a partial recharge, debits only available funds and pauses the same run again');

  const modern=await topup(30000);await pay(modern.order_id);
  const packs=await read('legacy','/api/v1/credits/recharge-config');assert.equal(packs.enabled,true);const pack=packs.packs.find(p=>p.id==='cny500');assert.equal(pack.points,'52500');assert.equal(pack.amount_fen,'50000');
  const packBody={request_id:randomUUID(),pack_id:pack.id,provider:'wechat'};
  const legacyOrder=await post('legacy','/api/v1/credits/recharge-orders',packBody,201);orders.push(legacyOrder.order_id);assert.equal(legacyOrder.points,'52500');
  await pay(legacyOrder.order_id);await expectBalance(82500);
  const oldOrderReplay=await post('automatic','/api/v1/credits/recharge-orders',packBody,201);assert.equal(oldOrderReplay.order_id,legacyOrder.order_id);assert.equal(oldOrderReplay.points,'52500');
  await post('automatic','/api/v1/runs/'+first.run_id+'/resume',{reason:'synthetic_new_and_legacy_recharge'});lease=await claimOwn(automaticPool,first.run_id);
  assert.deepEqual(lease.checkpoint.stages.input_lock,snapshot.stages.input_lock);assert.equal(lease.checkpoint.stages.model_generation.logical_call_id,'same-saved-run');
  assert.equal((await deliver(automaticPool,lease)).state,'succeeded');await expectBalance(56306);
  receipt=await charge(first.run_id);assert.equal(receipt.progress.policy,'authoring_balance_v2');assert.equal(receipt.progress.charged_points,'27195');
  assert.equal((await sql('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[owner,old.request.execution_request_id]))[0].n,1);
  record('new worker delivers the old saved run once; current topup and old bonus pack coexist and old pack replays preserve its original 50000/52500 consideration');

  const successful=await updateRequest(old.project_id,first.run_id,'Synthetic old on-delivery revision handed to upgraded worker');
  const oldDelivery=await post('legacy',successful.path,successful.body);runs.push(oldDelivery.run_id);
  assert.equal((await ledger(oldDelivery.run_id))[0].billing_policy,'on_delivery');await expectBalance(41406,14900);
  lease=await claimOwn(automaticPool,oldDelivery.run_id);await checkpointStage(automaticPool,lease,'input_lock',{synthetic:true,new_config_old_contract:true});await expectBalance(41406,14900);
  assert.equal((await deliver(automaticPool,lease)).state,'succeeded');await expectBalance(41406);
  receipt=await charge(oldDelivery.run_id);assert.equal(receipt.quote.quote_id,successful.quote.quote_id);assert.equal(receipt.quote.points,'14900');assert.equal(receipt.progress.policy,'on_delivery');assert.equal(receipt.progress.charged_points,'14900');
  const mixed=await allocations(oldDelivery.run_id);assert.deepEqual(new Set(mixed.map(r=>r.cash_order_id)),new Set([modern.order_id,legacyOrder.order_id]));
  assert.equal(mixed.reduce((n,r)=>n+BigInt(r.points),0n),14900n);
  record('new worker settles an already-started legacy on_delivery task at 14900, using both old bonus and new 1:1 lots without incremental charges');

  for(const outcome of ['failed','cancelled']){
    const pending=await updateRequest(old.project_id,first.run_id,'Synthetic old on-delivery '+outcome);
    const run=await post('automatic',pending.path,pending.body);runs.push(run.run_id);await expectBalance(26506,14900);
    assert.equal((await ledger(run.run_id))[0].billing_policy,'on_delivery');
    assert.equal((await post('automatic',pending.path,pending.body)).run_id,run.run_id);
    lease=await claimOwn(automaticPool,run.run_id);await checkpointStage(automaticPool,lease,'input_lock',{synthetic:true,outcome});await expectBalance(26506,14900);
    if(outcome==='failed')await finish(automaticPool,lease,'failed',{errorCode:'SYNTHETIC_POLICY_COMPATIBILITY_FAILURE',failedStage:'synthetic_upgrade'});
    else await post('automatic','/api/v1/runs/'+run.run_id+'/cancel',{reason:'synthetic_old_contract_cancel'});
    await expectBalance(41406);receipt=await charge(run.run_id);assert.equal(receipt.progress.charged_points,'0');assert.equal(receipt.state,'released');
    assert.equal((await sql("SELECT count(*)::int n FROM bb_credit_events WHERE reservation_id=$1 AND kind='release'",[(await ledger(run.run_id))[0].id]))[0].n,1);
  }
  record('automatic HTTP starts legacy revision quotations without repricing; new worker failure and cancellation each release the original hold exactly once');

  const current=await prepare('commerce'),newRun=await execute('automatic',current);await expectBalance(14211,27195);
  assert.equal((await charge(newRun.run_id)).progress.policy,'on_delivery');await post('automatic','/api/v1/runs/'+newRun.run_id+'/cancel',{reason:'synthetic_new_contract_cancel'});await expectBalance(41406);
  const beforeRefund=await read('automatic','/api/v1/commerce/topups/'+legacyOrder.order_id+'/refund-eligibility');
  const failing=await prepare('dynamic'),failed=await execute('legacy',failing);lease=await claimOwn(automaticPool,failed.run_id);
  await checkpointStage(automaticPool,lease,'input_lock',{synthetic:true});await checkpointStage(automaticPool,lease,'model_generation',{synthetic:true});
  assert.ok((await balance()).available<41406n);await finish(automaticPool,lease,'failed',{errorCode:'SYNTHETIC_POLICY_COMPATIBILITY_FAILURE',failedStage:'synthetic_model'});
  await expectBalance(41406);assert.equal((await charge(failed.run_id)).progress.charged_points,'0');
  const afterRefund=await read('automatic','/api/v1/commerce/topups/'+legacyOrder.order_id+'/refund-eligibility');
  assert.equal(afterRefund.refundable_points,beforeRefund.refundable_points);assert.equal(afterRefund.refundable_fen,beforeRefund.refundable_fen);
  const corrected=(await sql(`SELECT l.cash_basis_fen::text,l.cash_basis_points::text,l.cash_order_id FROM bb_credit_events e JOIN bb_credit_lots l ON l.id=e.lot_id
    JOIN bb_credit_reservations r ON r.id=e.reservation_id WHERE r.run_id=$1 AND r.owner_user_id=$2 AND e.kind='correction'`,[failed.run_id,owner]));
  assert.ok(corrected.length>0);for(const l of corrected){assert.equal(l.cash_order_id,legacyOrder.order_id);assert.equal(l.cash_basis_fen,'50000');assert.equal(l.cash_basis_points,'52500');}
  record('new automatic cancellation and old v2 failure interleave on one account without policy drift, duplicate debit or lost original bonus-pack cash basis');

  assert.equal(afterRefund.refundable_points,'41406');assert.equal(BigInt(afterRefund.refundable_fen),50000n*41406n/52500n);
  const refund=await post('automatic','/api/v1/commerce/topups/'+legacyOrder.order_id+'/refunds',{request_id:randomUUID(),points:afterRefund.refundable_points,expected_amount_fen:afterRefund.refundable_fen},202);
  await expectBalance(0,41406);await post('main','/__billing-test/api/refund/outcome',{id:refund.refund_id,outcome:'succeeded',delivery:'query'});
  await post('automatic','/api/v1/commerce/refunds/'+refund.refund_id+'/refresh');await expectBalance(0);
  await post('automatic','/api/v1/commerce/refunds/'+refund.refund_id+'/refresh');await expectBalance(0);
  assert.equal((await read('automatic','/api/v1/commerce/topups/'+legacyOrder.order_id+'/refund-eligibility')).refunded_fen,afterRefund.refundable_fen);
  record('remaining legacy bonus rights including restored failure slices refund at original cash consideration once, never at the new 1:1 rate');

  // Exercise the real pipeline orchestrator and its replaying production input
  // gate. Only the model and file-output stages are synthetic; their output is
  // promoted, registered and settled by runPipelineOnce itself.
  const pipelineFunding=await topup(30000);await pay(pipelineFunding.order_id);
  const pipelineTask=await prepare('dynamic'),pipelineRun=await execute('legacy',pipelineTask);
  const originalReservation=(await ledger(pipelineRun.run_id))[0];lease=await claimOwn(legacyPool,pipelineRun.run_id);
  await checkpointStage(legacyPool,lease,'input_lock',lease.verifiedInputLock);await releaseLease(legacyPool,lease,'synthetic_real_pipeline_upgrade');
  await nextOwn(pipelineRun.run_id);let unexpected;
  const syntheticModel={name:'model_generation',replay:true,run:async ctx=>{
    assert.equal(ctx.values.get('input_lock').review_mode,'review_v1');assert.equal(await ctx.validateBeforeModelCall(),null);
    await workerGate(automaticPool,ctx.lease);return{kind:'done',checkpoint:{synthetic_model:true},value:{synthetic_model:true}};
  }};
  const syntheticFiles={name:'word_delivery',replay:true,run:async ctx=>{
    assert.equal(await ctx.validateBeforeModelCall(),null);
    const {makeSyntheticDocxFixture}=await import('../../apps/api/dist/docx-fixtures.js');
    return{kind:'deliver',bytes:makeSyntheticDocxFixture({text:'Synthetic review pipeline revision. Content quality not evaluated.'}),
      cleanBytes:makeSyntheticDocxFixture({text:'Synthetic review pipeline clean version. Content quality not evaluated.'}),
      attachments:[{kind:'report',bytes:makeSyntheticDocxFixture({text:'Synthetic review pipeline report. Content quality not evaluated.'})}],deliveryPolicy:'generated_pair_v1',wordSummary:{synthetic_output:true,content_review:'not_performed'}};
  }};
  let pipelineOutcome;
  try{pipelineOutcome=await runPipelineOnce({pool:automaticPool,blobs,leaseSeconds:120,runKinds:['review','update'],
    stages:defaultRunStages({model_generation:syntheticModel,word_delivery:syntheticFiles}),onLease:claimed=>{
      if(claimed&&(claimed.runId!==pipelineRun.run_id||claimed.owner!==owner)){unexpected=claimed;throw Error('Queue ownership changed before real pipeline');}
    },onUnexpectedError:error=>assert.fail(JSON.stringify(error))});}
  finally{if(unexpected)await releaseLease(automaticPool,unexpected,'policy_compatibility_unrelated_guard');}
  assert.equal(pipelineOutcome,'succeeded');await expectBalance(2805);
  const afterPipeline=(await ledger(pipelineRun.run_id))[0];assert.equal(afterPipeline.id,originalReservation.id);assert.equal(afterPipeline.quote_id,pipelineTask.request.quote_id);
  assert.equal(afterPipeline.billing_policy,'authoring_balance_v2');assert.equal(afterPipeline.charged_points,'27195');
  workerPipelines.push({run:pipelineRun.run_id,outcome:pipelineOutcome,productionStages:['input_lock','materials_ready'],syntheticStages:['model_generation','word_delivery'],billingPolicy:afterPipeline.billing_policy});
  const unused=await post('automatic','/api/v1/commerce/topups/'+pipelineFunding.order_id+'/refunds',{request_id:randomUUID(),amount_fen:'2805'},202);
  await post('main','/__billing-test/api/refund/outcome',{id:unused.refund_id,outcome:'succeeded',delivery:'query'});
  await post('automatic','/api/v1/commerce/refunds/'+unused.refund_id+'/refresh');await expectBalance(0);
  record('production runPipelineOnce replays an old v2 input lock through real input/material gates and delivery settlement; only model/file output is synthetic');

  // Persist synthetic model output once. Both worker invocations use production
  // orchestration, promotion and settlement; the second reads the same bytes.
  const tailFunding=await topup(10000);await pay(tailFunding.order_id);
  const tailTask=await prepare('dynamic'),tailRun=await execute('legacy',tailTask),tailReservation=(await ledger(tailRun.run_id))[0];
  lease=await claimOwn(legacyPool,tailRun.run_id);await checkpointStage(legacyPool,lease,'input_lock',lease.verifiedInputLock);await releaseLease(legacyPool,lease,'synthetic_tail_upgrade');
  let tailModelCalls=0,tailWordReads=0;
  const tailModel={name:'model_generation',run:async ctx=>{
    assert.equal(await ctx.validateBeforeModelCall(),null);await workerGate(automaticPool,ctx.lease);tailModelCalls++;
    const {makeSyntheticDocxFixture}=await import('../../apps/api/dist/docx-fixtures.js'),files={};
    for(const kind of ['revision','clean','report']){
      const bytes=makeSyntheticDocxFixture({text:'Synthetic saved review '+kind+'. Content quality not evaluated.'}),key='synthetic-policy-tail/'+tailRun.run_id+'/'+kind;
      await blobs.put(key,bytes);files[kind]={key,sha256:createHash('sha256').update(bytes).digest('hex')};
    }
    return{kind:'done',checkpoint:{synthetic_model:true,files}};
  }};
  const tailFiles={name:'word_delivery',replay:true,run:async ctx=>{
    assert.equal(await ctx.validateBeforeModelCall(),null);tailWordReads++;
    const files=ctx.values.get('model_generation').files,bytes={};
    for(const [kind,file] of Object.entries(files)){bytes[kind]=await blobs.get(file.key);assert.equal(createHash('sha256').update(bytes[kind]).digest('hex'),file.sha256);}
    return{kind:'deliver',bytes:bytes.revision,cleanBytes:bytes.clean,attachments:[{kind:'report',bytes:bytes.report}],deliveryPolicy:'generated_pair_v1',wordSummary:{synthetic_output:true,content_review:'not_performed'}};
  }};
  const tailStages=defaultRunStages({model_generation:tailModel,word_delivery:tailFiles});
  assert.equal((await pipelineOwn(tailRun.run_id,tailStages)).outcome,'paused');await expectBalance(0);
  assert.deepEqual([tailModelCalls,tailWordReads],[1,1]);assert.equal((await charge(tailRun.run_id)).progress.charged_points,'10000');
  const savedTailArtifacts=await sql('SELECT id,version,sha256,object_key FROM bb_artifact_versions WHERE owner_user_id=$1 AND run_id=$2 ORDER BY id,version',[owner,tailRun.run_id]);assert.equal(savedTailArtifacts.length,3);
  assert.deepEqual((await sql('SELECT state,stage,artifact_id FROM bb_runs WHERE id=$1',[tailRun.run_id]))[0],{state:'paused',stage:'credits_exhausted',artifact_id:null});
  const tailRefill=await topup(30000);await pay(tailRefill.order_id);await post('automatic','/api/v1/runs/'+tailRun.run_id+'/resume',{reason:'synthetic_real_pipeline_tail_refill'});await expectBalance(30000);
  assert.equal((await pipelineOwn(tailRun.run_id,tailStages)).outcome,'succeeded');await expectBalance(12805);
  assert.deepEqual([tailModelCalls,tailWordReads],[1,2]);assert.deepEqual(await sql('SELECT id,version,sha256,object_key FROM bb_artifact_versions WHERE owner_user_id=$1 AND run_id=$2 ORDER BY id,version',[owner,tailRun.run_id]),savedTailArtifacts);
  const tailFinal=(await ledger(tailRun.run_id))[0];assert.equal(tailFinal.id,tailReservation.id);assert.equal(tailFinal.quote_id,tailTask.request.quote_id);assert.equal(tailFinal.billing_policy,'authoring_balance_v2');assert.equal(tailFinal.charged_points,'27195');
  for(const artifact of savedTailArtifacts)assert.equal(createHash('sha256').update(await blobs.get(artifact.object_key)).digest('hex'),artifact.sha256.trim());
  workerPipelines.push({run:tailRun.run_id,outcomes:['paused','succeeded'],billingPolicy:tailFinal.billing_policy,syntheticModelInvocations:tailModelCalls,wordReads:tailWordReads,reusedArtifacts:savedTailArtifacts.map(({id,version,sha256})=>({id,version,sha256}))});
  const tailUnused=await post('automatic','/api/v1/commerce/topups/'+tailRefill.order_id+'/refunds',{request_id:randomUUID(),amount_fen:'12805'},202);
  await post('main','/__billing-test/api/refund/outcome',{id:tailUnused.refund_id,outcome:'succeeded',delivery:'query'});await post('automatic','/api/v1/commerce/refunds/'+tailUnused.refund_id+'/refresh');await expectBalance(0);
  record('real upgraded review pipeline pauses at old v2 tail, resumes after recharge, reuses all three exact artifacts and the single saved synthetic model output');

  const failureFunding=await topup(30000);await pay(failureFunding.order_id);
  for(const policy of ['authoring_balance_v2','on_delivery']){
    const prepared=policy==='authoring_balance_v2'?await prepare('dynamic'):await updateRequest(old.project_id,first.run_id,'Synthetic real pipeline old-policy failure');
    const failedRun=policy==='authoring_balance_v2'?await execute('legacy',prepared):await post('legacy',prepared.path,prepared.body);
    if(policy==='on_delivery')runs.push(failedRun.run_id);
    const original=(await ledger(failedRun.run_id))[0];assert.equal(original.billing_policy,policy);
    lease=await claimOwn(legacyPool,failedRun.run_id);await checkpointStage(legacyPool,lease,'input_lock',lease.verifiedInputLock);await releaseLease(legacyPool,lease,'synthetic_pipeline_failure_upgrade');
    let failureStageEntered=0;const failStages=defaultRunStages({
      model_generation:{name:'model_generation',run:async ctx=>{assert.equal(await ctx.validateBeforeModelCall(),null);await workerGate(automaticPool,ctx.lease);return{kind:'done',checkpoint:{synthetic_model:true}};}},
      word_delivery:{name:'word_delivery',run:async ctx=>{assert.equal(await ctx.validateBeforeModelCall(),null);const held=(await ledger(ctx.run.id))[0];assert.equal(held.id,original.id);assert.equal(held.billing_policy,policy);if(policy==='authoring_balance_v2')assert.ok(BigInt(held.charged_points)>0n);failureStageEntered++;return{kind:'fail',code:'SYNTHETIC_OLD_POLICY_STAGE_FAILURE'};}}
    });
    const failedPipeline=await pipelineOwn(failedRun.run_id,failStages);assert.equal(failedPipeline.outcome,'failed');assert.equal(failureStageEntered,1);await expectBalance(30000);
    assert.deepEqual((await sql('SELECT state,artifact_id FROM bb_runs WHERE id=$1',[failedRun.run_id]))[0],{state:'failed',artifact_id:null});
    const failedCharge=await charge(failedRun.run_id);assert.equal(failedCharge.progress.policy,policy);assert.equal(failedCharge.progress.charged_points,'0');
    const after=(await ledger(failedRun.run_id))[0];assert.equal(after.id,original.id);assert.equal(after.quote_id,original.quote_id);assert.equal(after.points,original.points);
    const events=await runEvents(failedRun.run_id),sum=kind=>events.filter(e=>e.kind===kind).reduce((n,e)=>n+BigInt(e.points),0n);
    if(policy==='authoring_balance_v2'){assert.ok(sum('settle')>0n);assert.equal(sum('correction'),sum('settle'));}
    else{assert.equal(sum('settle'),0n);assert.equal(sum('release'),BigInt(original.points));assert.equal(events.filter(e=>e.kind==='release').length,1);}
    assert.equal((await sql('SELECT count(*)::int n FROM bb_artifact_versions WHERE owner_user_id=$1 AND run_id=$2',[owner,failedRun.run_id]))[0].n,0);
    await rejectRepeatedFinish(failedPipeline.lease);assert.equal((await auditCredits(automaticPool,owner)).consistent,true);
    workerPipelines.push({run:failedRun.run_id,outcome:'failed',failureStage:'word_delivery',failureStageEntered,billingPolicy:policy,repeatFinish:'ALREADY_TERMINAL_no_ledger_change',creditEvents:events});
    record('real upgraded review pipeline stage failure preserves '+policy+' contract, restores its original debits/hold and rejects duplicate finish without another refund');
  }
  const failureUnused=await post('automatic','/api/v1/commerce/topups/'+failureFunding.order_id+'/refunds',{request_id:randomUUID(),amount_fen:'30000'},202);
  await post('main','/__billing-test/api/refund/outcome',{id:failureUnused.refund_id,outcome:'succeeded',delivery:'query'});await post('automatic','/api/v1/commerce/refunds/'+failureUnused.refund_id+'/refresh');await expectBalance(0);

  finalAuditConsistent=(await auditCredits(automaticPool,owner)).consistent;assert.equal(finalAuditConsistent,true);
  assert.equal((await sql('SELECT count(*)::int n FROM bb_model_call_attempts WHERE owner_user_id=$1',[owner]))[0].n,0);
  finalActiveRuns=(await sql("SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1 AND state NOT IN ('succeeded','failed','cancelled','rejected','test_completed')",[owner]))[0].n;assert.equal(finalActiveRuns,0);
  record('shared-account final authoritative audit passes with no active run and zero real payment or model calls');
}catch(error){failure=error;}
finally{
  const cleanup=[];
  if(failure&&owner)for(const run of await sql("SELECT id FROM bb_runs WHERE owner_user_id=$1 AND state NOT IN ('succeeded','failed','cancelled','rejected','test_completed')",[owner])){
    try{await post('automatic','/api/v1/runs/'+run.id+'/cancel',{reason:'synthetic_compatibility_cleanup'});cleanup.push({run:run.id,cancelled:true});}catch(error){cleanup.push({run:run.id,error:String(error)});}
  }
  const proof={synthetic:true,realHttp:true,realPostgres:true,oneDatabase:true,oneAccount:true,realPaymentCallsPerformed:0,modelCallsPerformed:0,
    startedAt,finishedAt:new Date().toISOString(),instanceId:saved.id,username,owner,runs,orders,workerGates,workerPipelines,contentQualityEvaluated:false,finalAuditConsistent,finalActiveRuns,
    compatibilityScope:'Current binary under legacy/automatic configuration; immutable policy compatibility, not historical schema or binary migration.',
    remainingCoverage:['No historical binary/schema or original provider-journal migration; no unknown provider result or measured-usage reconciliation is constructed.'],
    passed:checks.length,failed:failure?1:0,skipped:0,checks,cleanup,
    ...(failure?{error:String(failure),stack:failure.stack}:{})};
  writeFileSync(join(evidence,'verification.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify({evidence,...proof}));
  for(const app of apps.reverse())await app.close();await legacyPool.end();await automaticPool.end();
}
if(failure)throw failure;
