import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {readFile,writeFile,stat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {Pool} from 'pg';
import {baseURL,config,pgBase,runtime,terms,cleanEnvironment} from './config.mjs';
import {syntheticPaymentProvider} from './provider.mjs';

// Real HTTP sessions, worker input gates/loaders, immutable inputs, queue leases
// and money/credit transactions. Most cases use synthetic milestones/artifacts;
// pipeline scenarios replace only model/file-output stages.
// This verifies policy compatibility and byte delivery, never content quality.
const clean=cleanEnvironment();for(const key of Object.keys(process.env))if(!(key in clean))delete process.env[key];Object.assign(process.env,clean);
const {createServer}=await import('../../apps/api/dist/server.js');
const {claim,checkpointStage,pauseAtCheckpoint,releaseLease,finish,promoteWordArtifact}=await import('../../apps/api/dist/queue.js');
const {emptyM4Draft,registerM4Artifacts}=await import('../../apps/api/dist/m4-workspace.js');
const {transaction}=await import('../../apps/api/dist/data.js');
const {makeSyntheticDocxFixture}=await import('../../apps/api/dist/docx-fixtures.js');
const {auditCredits}=await import('../../apps/api/dist/billing-audit.js');
const {automaticBillingEnabled}=await import('../../apps/api/dist/automatic-billing-context.js');
const {inputLockStage,runPipelineOnce,defaultRunStages}=await import('../../apps/worker/dist/run-pipeline.js');
const {loadM4WorkerInput}=await import('../../apps/worker/dist/m4-input.js');
const saved=config(),connectionString=pgBase+saved.database,legacyPool=new Pool({connectionString,max:4}),automaticPool=new Pool({connectionString,max:4});
const nonce=randomUUID().slice(0,8),evidence=join(runtime,'m4-billing-policy-compatibility-'+nonce);mkdirSync(evidence,{recursive:true});
const startedAt=new Date().toISOString(),checks=[],runs=[],orders=[],historicalQuoteFixtures=[],artifacts=[],apps=[],urls={main:baseURL},cookies=new Map();let owner,username,failure,finalAuditConsistent,finalActiveRuns;
const workerGates=[],workerPipelines=[],lockedBindings=new Map();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),record=name=>{checks.push(name);console.log('PASS '+name);};
const sql=async(query,params)=>(await automaticPool.query(query,params)).rows;
const blobPath=key=>join(runtime,'blobs',hash(key)),get=key=>readFile(blobPath(key));
const getIfExists=async key=>{try{return await get(key);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const blobs={put:(key,bytes)=>writeFile(blobPath(key),bytes),get,getIfExists,
  getIfExistsBounded:async(key,limit)=>{try{assert.ok((await stat(blobPath(key))).size<=limit);return get(key);}catch(error){if(error.code==='ENOENT')return null;throw error;}},
  exists:async key=>(await getIfExists(key))!==null,delete:async key=>{try{await unlink(blobPath(key));}catch(error){if(error.code!=='ENOENT')throw error;}}};
async function send(target,method,path,body,expected=200,binary=false){
  const raw=Buffer.isBuffer(body),headers={origin:baseURL,cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),'x-bb-csrf':cookies.get('bb_csrf')??''};
  if(body!==undefined)headers['content-type']=raw?'application/octet-stream':'application/json';
  const response=await fetch(urls[target]+path,{method,headers,...(body===undefined?{}:{body:raw?body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  for(const value of response.headers.getSetCookie()){const pair=value.split(';',1)[0],at=pair.indexOf('=');cookies.set(pair.slice(0,at),pair.slice(at+1));}
  const bytes=Buffer.from(await response.arrayBuffer());let data=bytes.toString();if(!binary)try{data=JSON.parse(data);}catch{}
  appendFileSync(join(evidence,'http.jsonl'),JSON.stringify({at:new Date().toISOString(),target,method,path,
    body:raw?{syntheticBytes:body.length,sha256:hash(body)}:body&&Object.hasOwn(body,'password')?{...body,password:'[synthetic password omitted]'}:body,
    status:response.status,data:binary?{bytes:bytes.length,sha256:hash(bytes)}:data})+'\n');
  assert.equal(response.status,expected,JSON.stringify({target,path,status:response.status,data:binary?'[binary]':data}));return binary?bytes:data;
}
const post=(target,path,body={},expected=200)=>send(target,'POST',path,body,expected),read=(target,path)=>send(target,'GET',path);
const balance=async()=>{const r=(await sql('SELECT COALESCE(sum(remaining-frozen),0)::text available,COALESCE(sum(frozen),0)::text held FROM bb_credit_lots WHERE owner_user_id=$1',[owner]))[0];return {available:BigInt(r.available),held:BigInt(r.held)};};
const expectBalance=async(available,held=0)=>assert.deepEqual(await balance(),{available:BigInt(available),held:BigInt(held)});
const ledger=id=>sql('SELECT id,quote_id,state,billing_policy,points::text,charged_points::text FROM bb_credit_reservations WHERE owner_user_id=$1 AND run_id=$2',[owner,id]);
const workspace=t=>read('automatic',t.base+'/workspace');
async function task(t,id){const w=await workspace(t),r=w.tasks.find(t=>t.run.run_id===id);assert.ok(r);return r;}
const input=id=>sql(`SELECT r.input_revision,r.input_hash,i.manifest,x.manifest AS m4_manifest,x.input_hash AS m4_hash
  FROM bb_runs r JOIN bb_input_revisions i ON i.project_id=r.project_id AND i.revision=r.input_revision AND i.owner_user_id=r.owner_user_id
  JOIN bb_m4_executions x ON x.run_id=r.id AND x.owner_user_id=r.owner_user_id WHERE r.id=$1 AND r.owner_user_id=$2`,[id,owner]);
async function topup(amount){const o=await post('main','/api/v1/commerce/topups',{request_id:randomUUID(),amount_fen:String(amount),provider:'wechat'},201);orders.push(o);await post('main','/__billing-test/api/payment/outcome',{id:o.order_id,outcome:'paid',delivery:'query'});await post('automatic','/api/v1/commerce/topups/'+o.order_id+'/refresh');return o;}
async function prepare(target='legacy',historical=false){
  const t=(await post(target,'/api/v1/m4/topics',{creation_request_id:randomUUID(),name:'【合成计费兼容验收】M4文档'})).topic,base='/api/v1/m4/topics/'+t.topic_id;
  const bytes=makeSyntheticDocxFixture({text:'Synthetic M4 input for billing-policy compatibility only. Not a real issuer document.'}),sha256=hash(bytes),d={byte_size:bytes.length,sha256};
  const upload=await post(target,'/api/v1/projects/'+t.project_id+'/materials/uploads',{...d,filename:'synthetic-m4-billing.docx',media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',role:'other'},201);
  await send(target,'PUT',upload.upload_url,bytes,204);const material=await post(target,'/api/v1/projects/'+t.project_id+'/materials/uploads/'+upload.upload_id+'/complete',d);
  const pin={source_project_id:t.project_id,material_id:material.material_id,material_version:material.material_version,sha256};
  await send(target,'PUT',base+'/drafts/underwriter',{expected_version:0,input:{...emptyM4Draft('underwriter'),materials:[pin],fields:{market:'sse',issuer_name:'Synthetic issuer for billing tests'}}});
  const q=(await post(target,base+'/quote',{kind:'document',document_type:'underwriter',expected_draft_version:1})).quote;
  let quoteId=q.quote_id;
  if(historical){
    assert.equal(target,'legacy');assert.equal(q.points,'4500');assert.equal(q.billing_policy,'authoring_balance_v2');quoteId=randomUUID();
    // Exactly the historical reconstruction used by m4-fixed-billing.pg.test:
    // append one quotation with the pre-v2 schema default on_delivery. No run,
    // reservation, wallet, price table or existing quotation is edited.
    const inserted=await sql(`INSERT INTO bb_m4_quotes(id,owner_user_id,topic_id,intent_hash,task_type,reserve_points,multiplier,snapshot,expires_at,billing_method,fixed_price_version)
      SELECT $1,owner_user_id,topic_id,intent_hash,task_type,reserve_points,multiplier,snapshot,expires_at,billing_method,fixed_price_version
      FROM bb_m4_quotes WHERE id=$2 AND owner_user_id=$3 RETURNING billing_policy,reserve_points::text`,[quoteId,q.quote_id,owner]);
    assert.deepEqual(inserted,[{billing_policy:'on_delivery',reserve_points:'4500'}]);historicalQuoteFixtures.push({quoteId,copiedFrom:q.quote_id,points:'4500',billing_policy:'on_delivery',appendOnly:true});
  }
  return {...t,base,q,request:{execution_request_id:randomUUID(),document_type:'underwriter',expected_draft_version:1,quote_id:quoteId,entrypoint:'workspace'}};
}
async function execute(target,t){const run=(await post(target,t.base+'/execute',t.request)).run;runs.push(run.run_id);return run;}
async function workerGate(pool,lease){
  const run=(await pool.query('SELECT * FROM bb_runs WHERE id=$1 AND owner_user_id=$2',[lease.runId,owner])).rows[0];assert.ok(run);
  const reservation=(await ledger(run.id))[0],locked={input:await input(run.id),reservation:{id:reservation.id,quote_id:reservation.quote_id,points:reservation.points,billing_policy:reservation.billing_policy}};
  if(lockedBindings.has(run.id))assert.deepEqual(locked,lockedBindings.get(run.id));else lockedBindings.set(run.id,locked);
  const ctx={pool,blobs,lease,run,signal:AbortSignal.timeout(30000),checkpoint:lease.checkpoint.stages??{},values:new Map()};
  const gate=await inputLockStage.run(ctx);assert.equal(gate.kind,'done',JSON.stringify({run:run.id,gate}));assert.equal(gate.value.m4_mode,'document');
  const loaded=await loadM4WorkerInput(ctx);assert.deepEqual(loaded.manifest,locked.input[0].manifest);assert.ok(loaded.materials.length>0);
  lease.verifiedInputLock=gate.value??gate.checkpoint??{};
  workerGates.push({run:run.id,automatic:automaticBillingEnabled(pool),inputRevision:run.input_revision,inputHash:run.input_hash,
    reservationId:reservation.id,quoteId:reservation.quote_id,billingPolicy:reservation.billing_policy,m4InputLoaded:true,materialPins:loaded.materials.map(m=>m.pin)});
}
async function nextOwn(id){
  const next=(await sql(`SELECT r.id,r.owner_user_id FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id WHERE
    (j.state='queued' OR (j.state='running' AND j.lease_until<now())) AND r.state NOT IN ('cancelled','failed','succeeded','test_completed','rejected')
    AND j.job_type='generation' ORDER BY j.created_at LIMIT 1`))[0];assert.equal(next?.id,id,'An unrelated task owns the queue; none was claimed');assert.equal(next.owner_user_id,owner);
}
async function claimOwn(pool,id){
  await nextOwn(id);const lease=await claim(pool,120,{runKinds:['generation']});
  if(!lease||lease.runId!==id||lease.owner!==owner){if(lease)await releaseLease(pool,lease,'m4_compatibility_unrelated_guard');throw Error('Queue ownership changed');}
  await workerGate(pool,lease);return lease;
}
async function savedPair(pool,lease){
  const result={};for(const kind of ['document','preparation_note']){
    const bytes=makeSyntheticDocxFixture({text:'Synthetic '+kind+' for M4 billing compatibility. Content quality not evaluated.'});
    const a=await promoteWordArtifact(pool,lease,bytes,blobs);assert.equal(a.status,'available');
    await transaction(pool,c=>registerM4Artifacts(c,owner,lease.runId,[{kind,artifact_id:a.artifactId,artifact_version:a.artifactVersion,filename:'synthetic-'+kind+'.docx',byte_size:bytes.length}]));
    result[kind]={...a,sha256:hash(bytes)};artifacts.push({run:lease.runId,kind,artifactId:a.artifactId,artifactVersion:a.artifactVersion,sha256:hash(bytes)});
  }
  await checkpointStage(pool,lease,'word_delivery',{artifact:result.document.artifactId,preparation_note:result.preparation_note.artifactId,synthetic:true});return result;
}
const finishPair=(pool,lease,pair)=>finish(pool,lease,'succeeded',{artifactId:pair.document.artifactId,artifactVersion:pair.document.artifactVersion,blobs});
const cancel=id=>post('automatic','/api/v1/runs/'+id+'/cancel',{reason:'synthetic_m4_policy_compatibility'});
async function pipelineOwn(id,stages){
  await nextOwn(id);let taken,unexpected;
  try{
    const outcome=await runPipelineOnce({pool:automaticPool,blobs,leaseSeconds:120,runKinds:['generation'],stages,
      onLease:lease=>{if(!lease)return;if(lease.runId!==id||lease.owner!==owner){unexpected=lease;throw Error('Queue ownership changed before compatibility pipeline');}taken=lease;},
      onUnexpectedError:error=>assert.fail(JSON.stringify(error))});
    assert.ok(taken);return{outcome,lease:taken};
  }finally{if(unexpected)await releaseLease(automaticPool,unexpected,'m4_compatibility_unrelated_guard');}
}
const runEvents=id=>sql('SELECT id,kind,lot_id,points::text FROM bb_credit_events WHERE owner_user_id=$1 AND run_id=$2 ORDER BY id',[owner,id]);
async function rejectRepeatedFinish(lease){
  const snapshot=async()=>({balance:await balance(),reservation:await ledger(lease.runId),events:await runEvents(lease.runId),
    allocations:await sql('SELECT a.* FROM bb_credit_allocations a JOIN bb_credit_reservations r ON r.id=a.reservation_id WHERE r.owner_user_id=$1 AND r.run_id=$2 ORDER BY a.lot_id',[owner,lease.runId])});
  const before=await snapshot();
  await assert.rejects(finish(automaticPool,lease,'failed',{errorCode:'SYNTHETIC_DUPLICATE_FAILURE',failedStage:'word_delivery'}),error=>error.status===409&&error.code==='ALREADY_TERMINAL');
  assert.deepEqual(await snapshot(),before);
}
try{
  assert.deepEqual(await sql('SELECT current_database() database,instance_id FROM bb_local_billing_instance'),[{database:saved.database,instance_id:saved.id}]);
  for(const [name,pool,automatic] of [['legacy',legacyPool,false],['automatic',automaticPool,true]]){const app=createServer({pool,blobs,enableSubscriptionBilling:automatic,enableOutcomePricing:false,
    enablePaidAuthoring:true,enablePaidReview:true,enableSyntheticQueue:true,paymentProviders:[syntheticPaymentProvider(pool,saved)],allowedOrigin:baseURL,auth:{termsVersion:terms}});apps.push(app);urls[name]=await app.listen({host:'127.0.0.1',port:0});}
  assert.equal(automaticBillingEnabled(legacyPool),false);assert.equal(automaticBillingEnabled(automaticPool),true);
  username='m4_policy_'+nonce;owner=(await post('main','/api/v1/auth/register',{username,password:'Synthetic-M4-Policy-2026!',accepted_terms_version:terms},201)).user_id;
  const old=await prepare();assert.equal(old.q.points,'4500');assert.equal(old.q.billing_policy,'authoring_balance_v2');
  await post('automatic',old.base+'/execute',old.request,402);await expectBalance(0);
  assert.equal((await sql('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1',[owner]))[0].n,0);
  record('M4 topic, DOCX upload, saved draft and old v2 quotation use real HTTP; zero balance creates no run');
  await topup(1);const first=await execute('automatic',old),originalInput=await input(first.run_id);await expectBalance(1);
  assert.equal((await ledger(first.run_id))[0].billing_policy,'authoring_balance_v2');assert.equal((await task(old,first.run_id)).credit_charge.quote.points,'4500');
  assert.equal((await post('automatic',old.base+'/execute',old.request)).run.run_id,first.run_id);
  let lease=await claimOwn(legacyPool,first.run_id);await checkpointStage(legacyPool,lease,'input_lock',{synthetic:true,source:'old-m4-worker',input_hash:first.input_hash});assert.equal(await pauseAtCheckpoint(legacyPool,lease),true);await expectBalance(0);
  const checkpoint=(await sql('SELECT checkpoint FROM bb_jobs WHERE run_id=$1',[first.run_id]))[0].checkpoint;
  await topup(100);await post('automatic','/api/v1/runs/'+first.run_id+'/resume',{reason:'synthetic_upgrade_partial_recharge'});await expectBalance(100);
  lease=await claimOwn(automaticPool,first.run_id);assert.deepEqual(lease.checkpoint.stages.input_lock,checkpoint.stages.input_lock);assert.deepEqual(await input(first.run_id),originalInput);
  await checkpointStage(automaticPool,lease,'model_generation',{synthetic:true,logical_call_id:'persisted-synthetic-m4'});assert.equal(await pauseAtCheckpoint(automaticPool,lease),true);await expectBalance(0);
  assert.equal((await task(old,first.run_id)).credit_charge.progress.charged_points,'101');
  record('new M4 API starts old 4500 v2 quote with one point; new worker resumes old input lock and partial recharge without full-price reservation');
  await topup(1);await post('automatic','/api/v1/runs/'+first.run_id+'/resume',{reason:'synthetic_saved_delivery'});lease=await claimOwn(automaticPool,first.run_id);
  const pair=await savedPair(automaticPool,lease);assert.equal((await finishPair(automaticPool,lease,pair)).state,'paused');await expectBalance(0);
  assert.equal((await workspace(old)).artifacts.length,0);
  const download=kind=>'/api/v1/m4/artifacts/'+pair[kind].artifactId+'/versions/'+pair[kind].artifactVersion+'/bytes';
  await send('automatic','GET',download('document'),undefined,404);
  const beforeArtifacts=await sql('SELECT id,version,sha256 FROM bb_artifact_versions WHERE run_id=$1 ORDER BY id,version',[first.run_id]);assert.equal(beforeArtifacts.length,2);
  await topup(5000);await post('automatic','/api/v1/runs/'+first.run_id+'/resume',{reason:'synthetic_delivery_balance'});lease=await claimOwn(automaticPool,first.run_id);
  assert.equal(lease.checkpoint.stages.word_delivery.artifact,pair.document.artifactId);assert.equal(lease.checkpoint.stages.word_delivery.preparation_note,pair.preparation_note.artifactId);
  assert.equal((await finishPair(automaticPool,lease,pair)).state,'succeeded');await expectBalance(602);
  assert.deepEqual(await input(first.run_id),originalInput);assert.deepEqual(await sql('SELECT id,version,sha256 FROM bb_artifact_versions WHERE run_id=$1 ORDER BY id,version',[first.run_id]),beforeArtifacts);
  assert.equal((await task(old,first.run_id)).credit_charge.progress.charged_points,'4500');assert.equal((await workspace(old)).artifacts.length,2);
  for(const kind of ['document','preparation_note'])assert.equal(hash(await send('automatic','GET',download(kind),undefined,200,true)),pair[kind].sha256);
  record('saved M4 document and preparation note remain private until old locked tail is funded; new worker settles once with unchanged artifacts and exact downloaded bytes');

  await topup(20000);const historical=await prepare('legacy',true),oldFixed=await execute('legacy',historical);await expectBalance(16102,4500);
  assert.equal((await ledger(oldFixed.run_id))[0].billing_policy,'on_delivery');const fixedInput=await input(oldFixed.run_id);
  lease=await claimOwn(legacyPool,oldFixed.run_id);await checkpointStage(legacyPool,lease,'input_lock',{synthetic:true,source:'old-fixed-m4-worker'});await releaseLease(legacyPool,lease,'synthetic_upgrade_handoff');await expectBalance(16102,4500);
  lease=await claimOwn(automaticPool,oldFixed.run_id);assert.equal(lease.checkpoint.stages.input_lock.source,'old-fixed-m4-worker');assert.deepEqual(await input(oldFixed.run_id),fixedInput);
  assert.equal((await finishPair(automaticPool,lease,await savedPair(automaticPool,lease))).state,'succeeded');await expectBalance(16102);
  let receipt=(await task(historical,oldFixed.run_id)).credit_charge;assert.equal(receipt.quote.quote_id,historical.request.quote_id);assert.equal(receipt.quote.points,'4500');assert.equal(receipt.progress.policy,'on_delivery');assert.equal(receipt.progress.charged_points,'4500');
  record('historical fixed on_delivery quote fixture starts through old API; new worker accepts its actual reservation and checkpoint and settles old 4500 exactly');
  for(const outcome of ['failed','cancelled']){
    const t=await prepare('legacy',true),r=await execute('automatic',t);await expectBalance(11602,4500);assert.equal((await ledger(r.run_id))[0].billing_policy,'on_delivery');
    assert.equal((await post('automatic',t.base+'/execute',t.request)).run.run_id,r.run_id);
    lease=await claimOwn(automaticPool,r.run_id);await checkpointStage(automaticPool,lease,'input_lock',{synthetic:true,outcome});await expectBalance(11602,4500);
    if(outcome==='failed')await finish(automaticPool,lease,'failed',{errorCode:'SYNTHETIC_M4_UPGRADE_FAILURE',failedStage:'synthetic_m4'});else await cancel(r.run_id);
    await expectBalance(16102);receipt=(await task(t,r.run_id)).credit_charge;assert.equal(receipt.progress.charged_points,'0');assert.equal(receipt.state,'released');assert.equal(receipt.quote.quote_id,t.request.quote_id);
    assert.equal((await sql("SELECT count(*)::int n FROM bb_credit_events WHERE reservation_id=$1 AND kind='release'",[(await ledger(r.run_id))[0].id]))[0].n,1);
  }
  record('new M4 API starts old on_delivery quotations without changing policy; failure and cancellation release each old full hold once');

  const dynamicFailed=await prepare(),failed=await execute('automatic',dynamicFailed);lease=await claimOwn(automaticPool,failed.run_id);
  await checkpointStage(automaticPool,lease,'input_lock',{synthetic:true});await checkpointStage(automaticPool,lease,'model_generation',{synthetic:true});assert.ok((await balance()).available<16102n);
  await finish(automaticPool,lease,'failed',{errorCode:'SYNTHETIC_M4_UPGRADE_FAILURE',failedStage:'synthetic_model'});await expectBalance(16102);assert.equal((await task(dynamicFailed,failed.run_id)).credit_charge.progress.charged_points,'0');
  const dynamicCancelled=await prepare(),cancelled=await execute('automatic',dynamicCancelled);lease=await claimOwn(automaticPool,cancelled.run_id);await checkpointStage(automaticPool,lease,'input_lock',{synthetic:true});await cancel(cancelled.run_id);
  const spent=BigInt((await task(dynamicCancelled,cancelled.run_id)).credit_charge.progress.charged_points);assert.ok(spent>0n&&spent<4500n);await expectBalance(16102n-spent);
  record('new worker failure restores old v2 debits, while user cancellation retains only old-policy work already charged');

  await topup(50000);
  for(const outcome of ['succeeded','failed','cancelled']){
    const before=(await balance()).available,t=await prepare('automatic'),price=BigInt(t.q.points);assert.equal(t.q.billing_policy,'on_delivery');assert.equal(t.q.auto_charge,true);assert.ok(price>0n&&price<before);
    const r=await execute('automatic',t);await expectBalance(before-price,price);lease=await claimOwn(automaticPool,r.run_id);await checkpointStage(automaticPool,lease,'input_lock',{synthetic:true,outcome});await expectBalance(before-price,price);
    if(outcome==='succeeded')await finishPair(automaticPool,lease,await savedPair(automaticPool,lease));
    else if(outcome==='failed')await finish(automaticPool,lease,'failed',{errorCode:'SYNTHETIC_M4_CURRENT_FAILURE',failedStage:'synthetic_m4'});else await cancel(r.run_id);
    await expectBalance(outcome==='succeeded'?before-price:before);receipt=(await task(t,r.run_id)).credit_charge;assert.equal(receipt.progress.policy,'on_delivery');assert.equal(BigInt(receipt.progress.charged_points),outcome==='succeeded'?price:0n);
  }
  record('current automatic M4 policy interleaves with both old policies on one wallet; success charges its locked price and failure/cancellation release fully');

  const beforePipeline=(await balance()).available,pipelineTask=await prepare('legacy',true),pipelineRun=await execute('legacy',pipelineTask);
  await expectBalance(beforePipeline-4500n,4500);const originalReservation=(await ledger(pipelineRun.run_id))[0];
  lease=await claimOwn(legacyPool,pipelineRun.run_id);await checkpointStage(legacyPool,lease,'input_lock',lease.verifiedInputLock);
  await releaseLease(legacyPool,lease,'synthetic_real_m4_pipeline_upgrade');await nextOwn(pipelineRun.run_id);let unexpected;
  const syntheticModel={name:'model_generation',replay:true,run:async ctx=>{
    assert.equal(ctx.values.get('input_lock').m4_mode,'document');assert.equal(await ctx.validateBeforeModelCall(),null);
    await workerGate(automaticPool,ctx.lease);const loaded=await loadM4WorkerInput(ctx);assert.equal(loaded.manifest.input.document_type,'underwriter');
    return{kind:'done',checkpoint:{synthetic_model:true},value:{synthetic_model:true}};
  }};
  const syntheticFiles={name:'word_delivery',replay:true,run:async ctx=>{
    assert.equal(await ctx.validateBeforeModelCall(),null);
    return{kind:'deliver',bytes:makeSyntheticDocxFixture({text:'Synthetic M4 real pipeline document. Content quality not evaluated.'}),
      namedArtifacts:[{kind:'preparation_note',filename:'synthetic-preparation-note.docx',bytes:makeSyntheticDocxFixture({text:'Synthetic preparation note. Content quality not evaluated.'})}],deliveryPolicy:'generated_review_v1'};
  }};
  let pipelineOutcome;
  try{pipelineOutcome=await runPipelineOnce({pool:automaticPool,blobs,leaseSeconds:120,runKinds:['generation'],
    stages:defaultRunStages({model_generation:syntheticModel,word_delivery:syntheticFiles}),onLease:claimed=>{
      if(claimed&&(claimed.runId!==pipelineRun.run_id||claimed.owner!==owner)){unexpected=claimed;throw Error('Queue ownership changed before real M4 pipeline');}
    },onUnexpectedError:error=>assert.fail(JSON.stringify(error))});}
  finally{if(unexpected)await releaseLease(automaticPool,unexpected,'m4_compatibility_unrelated_guard');}
  assert.equal(pipelineOutcome,'succeeded');await expectBalance(beforePipeline-4500n);
  const afterPipeline=(await ledger(pipelineRun.run_id))[0];assert.equal(afterPipeline.id,originalReservation.id);assert.equal(afterPipeline.quote_id,pipelineTask.request.quote_id);
  assert.equal(afterPipeline.billing_policy,'on_delivery');assert.equal(afterPipeline.charged_points,'4500');
  const pipelineArtifacts=(await workspace(pipelineTask)).artifacts.filter(a=>a.run_id===pipelineRun.run_id);assert.equal(pipelineArtifacts.length,2);
  for(const a of pipelineArtifacts)assert.equal(hash(await send('automatic','GET','/api/v1/m4/artifacts/'+a.artifact_id+'/versions/'+a.artifact_version+'/bytes',undefined,200,true)),a.sha256);
  workerPipelines.push({run:pipelineRun.run_id,outcome:pipelineOutcome,productionStages:['input_lock','materials_ready'],syntheticStages:['model_generation','word_delivery'],billingPolicy:afterPipeline.billing_policy,artifactCount:pipelineArtifacts.length});
  record('production runPipelineOnce replays an old on_delivery M4 input through real gates/loader and registers both deliverables at old locked 4500; only model/file output is synthetic');

  let returned=0n,failedRefundChecked=false;
  for(const order of orders){
    const e=await read('automatic','/api/v1/commerce/topups/'+order.order_id+'/refund-eligibility');if(!e.enabled||BigInt(e.refundable_fen)===0n)continue;
    const request=()=>post('automatic','/api/v1/commerce/topups/'+order.order_id+'/refunds',{request_id:randomUUID(),amount_fen:e.refundable_fen},202);
    if(!failedRefundChecked){const before=await balance(),r=await request();await post('main','/__billing-test/api/refund/outcome',{id:r.refund_id,outcome:'failed',delivery:'query'});await post('automatic','/api/v1/commerce/refunds/'+r.refund_id+'/refresh');assert.deepEqual(await balance(),before);failedRefundChecked=true;}
    const r=await request();await post('main','/__billing-test/api/refund/outcome',{id:r.refund_id,outcome:'succeeded',delivery:'query'});await post('automatic','/api/v1/commerce/refunds/'+r.refund_id+'/refresh');await post('automatic','/api/v1/commerce/refunds/'+r.refund_id+'/refresh');returned+=BigInt(r.amount_fen);
    assert.ok(BigInt((await read('automatic','/api/v1/commerce/topups/'+order.order_id+'/refund-eligibility')).refunded_fen)<=BigInt(order.amount_fen));
  }
  await expectBalance(0);assert.ok(failedRefundChecked);
  const net=(await sql("SELECT COALESCE(sum(points) FILTER(WHERE kind='settle'),0)-COALESCE(sum(points) FILTER(WHERE kind='correction'),0) AS points FROM bb_credit_events WHERE owner_user_id=$1",[owner]))[0].points;
  assert.equal(BigInt(net),orders.reduce((n,o)=>n+BigInt(o.amount_fen),0n)-returned);
  record('all unspent and failure-restored M4 source rights refund through original orders; refund failure releases and duplicate success never repays twice');

  // The model fixture writes its output once; production orchestration replays
  // the saved checkpoint and promotes the exact same bytes after a tail pause.
  await topup(2000);const tailTask=await prepare(),tailRun=await execute('legacy',tailTask),tailReservation=(await ledger(tailRun.run_id))[0];
  lease=await claimOwn(legacyPool,tailRun.run_id);await checkpointStage(legacyPool,lease,'input_lock',lease.verifiedInputLock);await releaseLease(legacyPool,lease,'synthetic_m4_tail_upgrade');
  let tailModelCalls=0,tailWordReads=0;
  const tailModel={name:'model_generation',run:async ctx=>{
    assert.equal(await ctx.validateBeforeModelCall(),null);await workerGate(automaticPool,ctx.lease);tailModelCalls++;
    const files={};for(const kind of ['document','preparation_note']){
      const bytes=makeSyntheticDocxFixture({text:'Synthetic saved M4 '+kind+'. Content quality not evaluated.'}),key='synthetic-m4-policy-tail/'+tailRun.run_id+'/'+kind;
      await blobs.put(key,bytes);files[kind]={key,sha256:hash(bytes)};
    }
    return{kind:'done',checkpoint:{synthetic_model:true,files}};
  }};
  const tailFiles={name:'word_delivery',replay:true,run:async ctx=>{
    assert.equal(await ctx.validateBeforeModelCall(),null);tailWordReads++;
    const bytes={};for(const [kind,file] of Object.entries(ctx.values.get('model_generation').files)){bytes[kind]=await blobs.get(file.key);assert.equal(hash(bytes[kind]),file.sha256);}
    return{kind:'deliver',bytes:bytes.document,namedArtifacts:[{kind:'preparation_note',filename:'synthetic-preparation-note.docx',bytes:bytes.preparation_note}],deliveryPolicy:'generated_review_v1'};
  }};
  const tailStages=defaultRunStages({model_generation:tailModel,word_delivery:tailFiles});
  assert.equal((await pipelineOwn(tailRun.run_id,tailStages)).outcome,'paused');await expectBalance(0);
  assert.deepEqual([tailModelCalls,tailWordReads],[1,1]);assert.equal((await task(tailTask,tailRun.run_id)).credit_charge.progress.charged_points,'2000');assert.equal((await workspace(tailTask)).artifacts.length,0);
  const savedTailArtifacts=await sql('SELECT id,version,sha256,object_key FROM bb_artifact_versions WHERE owner_user_id=$1 AND run_id=$2 ORDER BY id,version',[owner,tailRun.run_id]);assert.equal(savedTailArtifacts.length,2);
  assert.deepEqual((await sql('SELECT state,stage,artifact_id FROM bb_runs WHERE id=$1',[tailRun.run_id]))[0],{state:'paused',stage:'credits_exhausted',artifact_id:null});
  for(const a of savedTailArtifacts)await send('automatic','GET','/api/v1/m4/artifacts/'+a.id+'/versions/'+a.version+'/bytes',undefined,404);
  const tailRefill=await topup(5000);await post('automatic','/api/v1/runs/'+tailRun.run_id+'/resume',{reason:'synthetic_real_m4_pipeline_tail_refill'});await expectBalance(5000);
  assert.equal((await pipelineOwn(tailRun.run_id,tailStages)).outcome,'succeeded');await expectBalance(2500);
  assert.deepEqual([tailModelCalls,tailWordReads],[1,2]);assert.deepEqual(await sql('SELECT id,version,sha256,object_key FROM bb_artifact_versions WHERE owner_user_id=$1 AND run_id=$2 ORDER BY id,version',[owner,tailRun.run_id]),savedTailArtifacts);
  const tailFinal=(await ledger(tailRun.run_id))[0];assert.equal(tailFinal.id,tailReservation.id);assert.equal(tailFinal.quote_id,tailTask.request.quote_id);assert.equal(tailFinal.billing_policy,'authoring_balance_v2');assert.equal(tailFinal.charged_points,'4500');
  for(const a of savedTailArtifacts)assert.equal(hash(await send('automatic','GET','/api/v1/m4/artifacts/'+a.id+'/versions/'+a.version+'/bytes',undefined,200,true)),a.sha256.trim());
  workerPipelines.push({run:tailRun.run_id,outcomes:['paused','succeeded'],billingPolicy:tailFinal.billing_policy,syntheticModelInvocations:tailModelCalls,wordReads:tailWordReads,reusedArtifacts:savedTailArtifacts.map(({id,version,sha256})=>({id,version,sha256}))});
  const tailUnused=await post('automatic','/api/v1/commerce/topups/'+tailRefill.order_id+'/refunds',{request_id:randomUUID(),amount_fen:'2500'},202);
  await post('main','/__billing-test/api/refund/outcome',{id:tailUnused.refund_id,outcome:'succeeded',delivery:'query'});await post('automatic','/api/v1/commerce/refunds/'+tailUnused.refund_id+'/refresh');returned+=2500n;await expectBalance(0);
  record('real upgraded M4 pipeline pauses at old v2 tail, keeps both files private, then reuses exact artifacts and one saved synthetic model output after recharge');

  const failureFunding=await topup(10000);
  for(const policy of ['authoring_balance_v2','on_delivery']){
    const prepared=await prepare('legacy',policy==='on_delivery'),failedRun=await execute('legacy',prepared),original=(await ledger(failedRun.run_id))[0];assert.equal(original.billing_policy,policy);
    lease=await claimOwn(legacyPool,failedRun.run_id);await checkpointStage(legacyPool,lease,'input_lock',lease.verifiedInputLock);await releaseLease(legacyPool,lease,'synthetic_m4_pipeline_failure_upgrade');
    let failureStageEntered=0;const failStages=defaultRunStages({
      model_generation:{name:'model_generation',run:async ctx=>{assert.equal(await ctx.validateBeforeModelCall(),null);await workerGate(automaticPool,ctx.lease);return{kind:'done',checkpoint:{synthetic_model:true}};}},
      word_delivery:{name:'word_delivery',run:async ctx=>{assert.equal(await ctx.validateBeforeModelCall(),null);const held=(await ledger(ctx.run.id))[0];assert.equal(held.id,original.id);assert.equal(held.billing_policy,policy);if(policy==='authoring_balance_v2')assert.ok(BigInt(held.charged_points)>0n);failureStageEntered++;return{kind:'fail',code:'SYNTHETIC_OLD_M4_POLICY_STAGE_FAILURE'};}}
    });
    const failedPipeline=await pipelineOwn(failedRun.run_id,failStages);assert.equal(failedPipeline.outcome,'failed');assert.equal(failureStageEntered,1);await expectBalance(10000);
    assert.deepEqual((await sql('SELECT state,artifact_id FROM bb_runs WHERE id=$1',[failedRun.run_id]))[0],{state:'failed',artifact_id:null});
    const failedCharge=(await task(prepared,failedRun.run_id)).credit_charge;assert.equal(failedCharge.progress.policy,policy);assert.equal(failedCharge.progress.charged_points,'0');
    const after=(await ledger(failedRun.run_id))[0];assert.equal(after.id,original.id);assert.equal(after.quote_id,original.quote_id);assert.equal(after.points,original.points);
    const events=await runEvents(failedRun.run_id),sum=kind=>events.filter(e=>e.kind===kind).reduce((n,e)=>n+BigInt(e.points),0n);
    if(policy==='authoring_balance_v2'){assert.ok(sum('settle')>0n);assert.equal(sum('correction'),sum('settle'));}
    else{assert.equal(sum('settle'),0n);assert.equal(sum('release'),BigInt(original.points));assert.equal(events.filter(e=>e.kind==='release').length,1);}
    assert.equal((await workspace(prepared)).artifacts.length,0);assert.equal((await sql('SELECT count(*)::int n FROM bb_artifact_versions WHERE owner_user_id=$1 AND run_id=$2',[owner,failedRun.run_id]))[0].n,0);
    await rejectRepeatedFinish(failedPipeline.lease);assert.equal((await auditCredits(automaticPool,owner)).consistent,true);
    workerPipelines.push({run:failedRun.run_id,outcome:'failed',failureStage:'word_delivery',failureStageEntered,billingPolicy:policy,repeatFinish:'ALREADY_TERMINAL_no_ledger_change',creditEvents:events});
    record('real upgraded M4 pipeline stage failure preserves '+policy+' contract, restores its original debits/hold and rejects duplicate finish without another refund');
  }
  const failureUnused=await post('automatic','/api/v1/commerce/topups/'+failureFunding.order_id+'/refunds',{request_id:randomUUID(),amount_fen:'10000'},202);
  await post('main','/__billing-test/api/refund/outcome',{id:failureUnused.refund_id,outcome:'succeeded',delivery:'query'});await post('automatic','/api/v1/commerce/refunds/'+failureUnused.refund_id+'/refresh');returned+=10000n;await expectBalance(0);
  const finalNet=(await sql("SELECT COALESCE(sum(points) FILTER(WHERE kind='settle'),0)-COALESCE(sum(points) FILTER(WHERE kind='correction'),0) AS points FROM bb_credit_events WHERE owner_user_id=$1",[owner]))[0].points;
  assert.equal(BigInt(finalNet),orders.reduce((n,o)=>n+BigInt(o.amount_fen),0n)-returned);
  finalAuditConsistent=(await auditCredits(automaticPool,owner)).consistent;assert.equal(finalAuditConsistent,true);
  assert.equal((await sql('SELECT count(*)::int n FROM bb_model_call_attempts WHERE owner_user_id=$1',[owner]))[0].n,0);
  finalActiveRuns=(await sql("SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1 AND state NOT IN ('succeeded','failed','cancelled','rejected','test_completed')",[owner]))[0].n;assert.equal(finalActiveRuns,0);
  record('final M4 shared-account credit audit reconciles exact net task charges and cash refunds with no active run and zero model calls');
}catch(error){failure=error;}
finally{
  const cleanup=[];
  if(failure&&owner)for(const r of await sql("SELECT id FROM bb_runs WHERE owner_user_id=$1 AND state NOT IN ('succeeded','failed','cancelled','rejected','test_completed')",[owner]))try{await cancel(r.id);cleanup.push({run:r.id,cancelled:true});}catch(error){cleanup.push({run:r.id,error:String(error)});}
  const proof={synthetic:true,contentQualityEvaluated:false,realHttp:true,realPostgres:true,oneDatabase:true,oneAccount:true,realPaymentCallsPerformed:0,modelCallsPerformed:0,
    startedAt,finishedAt:new Date().toISOString(),instanceId:saved.id,username,owner,runs,orders:orders.map(o=>({id:o.order_id,amount_fen:o.amount_fen})),historicalQuoteFixtures,artifacts,workerGates,workerPipelines,finalAuditConsistent,finalActiveRuns,
    compatibilityScope:'Current binary under legacy/automatic configuration; historical on_delivery is an explicitly appended policy fixture using the current snapshot format, not a historical binary/schema migration.',
    remainingCoverage:['No historical binary/schema or original provider-journal migration; no unknown provider result or measured-usage reconciliation is constructed.'],
    passed:checks.length,failed:failure?1:0,skipped:0,checks,cleanup,...(failure?{error:String(failure),stack:failure.stack}:{})};
  writeFileSync(join(evidence,'verification.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify({evidence,...proof}));for(const app of apps.reverse())await app.close();await legacyPool.end();await automaticPool.end();
}
if(failure)throw failure;
