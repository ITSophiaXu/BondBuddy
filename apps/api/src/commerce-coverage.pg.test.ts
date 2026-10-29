import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {Pool} from 'pg';
import {emptyUpdateDetails,type OutcomePricingItem,type OutcomeWorkPlan} from '@bondbuddy/contracts';
import {bindCommerceScopeRun,readOwnedCommerceCoverage} from './commerce-coverage.js';
import {creditBalance,grantCredits,quoteCredits,reserveCredits} from './billing.js';
import {correctSettlement} from './billing-ops.js';
import {requestScope,publishStandardScopeQuote} from './scope-quotations.js';
import {transaction,type PrivateBlobs} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {checkpointStage,claim,enqueue,finish,promoteWordArtifact} from './queue.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';
import {isolatedTestDatabase} from './test-database.js';
import {applyVerifiedPayment,createServiceTopup,type PaymentProvider} from './payments.js';
import {requestPaymentRefund,type RefundOrder,type VerifiedRefund} from './payment-refunds.js';

// Real PostgreSQL, real wallet reservations and real synthetic Word delivery evidence.
// No customer materials, remote model requests or actual payment channels are used.
const database=await isolatedTestDatabase(undefined,'commerce-work-coverage');
const options={skip:!database,timeout:120000};
const goal=(coverage_key:string,price_key:'fact_reply'|'fact_revision'|'argument_reply'):OutcomePricingItem=>
 ({key:'goal',coverage_key,family:'goal_upgrade',price_key,evidence:['synthetic exact business objective']});
const period=(coverage_key:string,key:string):OutcomePricingItem=>
 ({key:'financial',coverage_key,family:'financial_group',main_period_keys:[key],annual_main_periods:3,interim_main_periods:1,evidence:['synthetic exact reporting period']});
const owned=(pool:Pool,owner:string,keys:string[])=>transaction(pool,c=>readOwnedCommerceCoverage(c,owner,keys));
async function actor(pool:Pool){const id=randomUUID();await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[id,'synthetic_coverage_'+id.slice(0,8)]);return id;}
function memoryBlobs():PrivateBlobs{
 const bytes=new Map<string,Buffer>();return {put:async(k,b)=>{bytes.set(k,Buffer.from(b));},get:async k=>{const b=bytes.get(k);assert.ok(b);return b;},
  getIfExists:async k=>bytes.get(k)??null,getIfExistsBounded:async(k,n)=>{const b=bytes.get(k);if(b&&b.length>n)throw Error('bounded');return b??null;},exists:async k=>bytes.has(k),delete:async k=>{bytes.delete(k);}};
}
async function fixture(pool:Pool,owner:string,items:OutcomePricingItem[],fund=true,start=true){
 const project=randomUUID(),runId=randomUUID();
 const manifest={draft_revision:1,issuer_name:'Synthetic coverage issuer',market:'sse',offering:'private',materials:[],
  update_details:{...emptyUpdateDetails(),reporting_cutoff:'2026-09-30'},
  authoring:{version:'unified_v1',source_prospectuses:[],requirements:[],knowledge:[],knowledge_status:'authoring_reference_not_compliance_approval'}};
 const hash=inputManifestHash(manifest),work_plan:OutcomeWorkPlan={scope_status:'confirmed',items};
 await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic coverage project','generation')",[project,owner]);
 await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,$4,'[]','[]')",[project,owner,hash,manifest]);
 await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1',[project]);
 const pending=await transaction(pool,c=>requestScope(c,owner,project,'authoring',hash,manifest));
 const scope=await publishStandardScopeQuote(pool,{id:pending.scope_quote_id,expected_input_hash:hash,work_plan,actor:'synthetic-classifier',reason:'Synthetic trusted business scope only'});
 const run=(await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'generation',$4,'queued') RETURNING *",[runId,owner,project,hash])).rows[0];
 const quote=(await quoteCredits(pool,owner,project,1,hash,true)).quote;
 if(start)await transaction(pool,async c=>{
  if(fund&&quote.points>0)await grantCredits(c,{owner,source:'purchase',key:randomUUID(),points:quote.points,expiresAt:null,actor:'synthetic-test',reason:'Synthetic test funding'});
  const p=(await c.query('SELECT * FROM bb_projects WHERE id=$1',[project])).rows[0];
  await reserveCredits(c,owner,run,quote.quote_id,{revision:1,manifest},p,undefined,true);
  await bindCommerceScopeRun(c,owner,scope.scope_quote_id,run.id);
 });
 return {owner,project,run,quote,scope,manifest,hash};
}
async function deliver(pool:Pool,f:Awaited<ReturnType<typeof fixture>>){
 const blobs=memoryBlobs();await transaction(pool,c=>enqueue(c,f.run));const lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,f.run.id);
 const revision=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:'Synthetic covered revision'}),blobs,'generated_pair_v1');
 const clean=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:'Synthetic covered clean'}),blobs,'generated_pair_v1');
 await checkpointStage(pool,lease,'word_delivery_pair',{revision_artifact_id:revision.artifactId,clean_artifact_id:clean.artifactId});
 await finish(pool,lease,'succeeded',{artifactId:revision.artifactId,artifactVersion:1,blobs});
}

test('owned coverage is earned after exact successful settlement; same-goal upgrades retain contract levels',options,async()=>{
 const pool=new Pool({connectionString:database});
 try{
  const owner=await actor(pool),key='synthetic-goal:'+owner,amounts:number[]=[],runs:string[]=[];
  for(const price of ['fact_reply','fact_revision','argument_reply'] as const){
   const f=await fixture(pool,owner,[goal(key,price)]);amounts.push(f.quote.points);runs.push(f.run.id);
   const before=await owned(pool,owner,[key]);assert.equal(before.some(c=>c.price_key===price),false,'queued/held work is not purchased delivery coverage');
   await deliver(pool,f);assert.ok((await owned(pool,owner,[key])).some(c=>c.price_key===price));
  }
  assert.deepEqual(amounts,[980,2920,6000]);assert.equal(amounts.reduce((a,b)=>a+b,0),9900);
  assert.equal((await owned(pool,owner,[key])).length,3);
  assert.deepEqual(await owned(pool,await actor(pool),[key]),[],'another owner cannot borrow contract coverage');
  await correctSettlement(pool,{runId:runs[0],actor:'synthetic-operator',reason:'Synthetic correction of the first upgrade source'});
  assert.deepEqual(await owned(pool,owner,[key]),[],'paid upgrade differences cannot preserve higher coverage after their source is corrected');
 }finally{await pool.end();}
});

test('499 group uses union of separately delivered periods; the 1-yuan third purchase does not re-earn old periods',options,async()=>{
 const pool=new Pool({connectionString:database});
 try{
  const owner=await actor(pool),key='synthetic-financial:'+owner,fs=[];
  for(const p of ['2023','2024','2025']){const f=await fixture(pool,owner,[period(key,p)]);fs.push(f);await deliver(pool,f);}
  assert.deepEqual(fs.map(f=>f.quote.points),[24900,24900,100]);
  let receipts=await owned(pool,owner,[key]);
  assert.deepEqual(receipts.map(c=>c.period_keys),[['2023'],['2024'],['2025']]);
  assert.equal(receipts.every(c=>c.price_key==='period'&&!c.complete_group),true);
  await correctSettlement(pool,{runId:fs[0].run.id,actor:'synthetic-operator',reason:'Synthetic erroneous first delivery charge'});
  receipts=await owned(pool,owner,[key]);
  const remaining=receipts.flatMap(c=>c.period_keys??[]);
  assert.equal(remaining.includes('2023'),false,'later purchase cannot re-earn a corrected old period');
  assert.equal(remaining.includes('2025'),false,'the discounted third period depends on the paid receipts that provided its cap');
  assert.deepEqual(remaining,['2024'],'a separately paid full-price period retains its own coverage');
 }finally{await pool.end();}
});

test('ready zero continuation requires a real parent chain and loses inherited coverage after its source is corrected',options,async()=>{
 const pool=new Pool({connectionString:database});
 try{
  const owner=await actor(pool),key='synthetic-included:'+owner,first=await fixture(pool,owner,[goal(key,'argument_reply')]);await deliver(pool,first);
  const parent=(await owned(pool,owner,[key]))[0];assert.ok(parent);
  const second=await fixture(pool,owner,[{key:'included',coverage_key:key,family:'included',owned_coverage_id:parent.id,reason:'Original-scope evidence completion',evidence:['synthetic original promised scope']}]);
  assert.equal(second.scope.quote_status,'ready');assert.equal(second.quote.points,0);
  assert.equal(Number((await pool.query('SELECT count(*) n FROM bb_credit_reservations WHERE run_id=$1',[second.run.id])).rows[0].n),0);
  await deliver(pool,second);const receipts=await owned(pool,owner,[key]);assert.equal(receipts.length,2);assert.equal(receipts.every(c=>c.price_key==='argument_reply'),true);
  const third=await fixture(pool,owner,[{key:'included-again',coverage_key:key,family:'included',owned_coverage_id:receipts[1].id,reason:'Original-scope quality correction',evidence:['synthetic same promised scope']}]);await deliver(pool,third);
  assert.equal((await owned(pool,owner,[key])).length,3);
  await correctSettlement(pool,{runId:first.run.id,actor:'synthetic-operator',reason:'Synthetic correction of original source charge'});
  assert.deepEqual(await owned(pool,owner,[key]),[],'zero descendants cannot launder revoked coverage');
  await assert.rejects(fixture(pool,owner,[{key:'forged',coverage_key:key,family:'included',owned_coverage_id:parent.id,reason:'Synthetic revoked reference',evidence:['synthetic']}]),e=>(e as any).code==='VALIDATION_FAILED');
 }finally{await pool.end();}
});

test('binding is replay-safe under concurrency, immutable, single-consumption and cannot turn pending zero into coverage',options,async()=>{
 const pool=new Pool({connectionString:database});
 try{
  const owner=await actor(pool),key='synthetic-replay:'+owner,paid=await fixture(pool,owner,[goal(key,'fact_revision')]);await deliver(pool,paid);
  const parent=(await owned(pool,owner,[key]))[0];
  const plan:OutcomePricingItem[]=[{key:'concurrent-continuation',coverage_key:key,family:'included',owned_coverage_id:parent.id,reason:'Synthetic original-scope continuation',evidence:['synthetic same promised scope']}];
  const candidates=[await fixture(pool,owner,plan,false,false),await fixture(pool,owner,plan,false,false)];
  const attempted=await Promise.allSettled(candidates.map(f=>transaction(pool,c=>bindCommerceScopeRun(c,owner,f.scope.scope_quote_id,f.run.id))));
  assert.equal(attempted.filter(r=>r.status==='fulfilled').length,1,'different quotes cannot concurrently bind the same business coverage');
  assert.equal(attempted.filter(r=>r.status==='rejected'&&(r.reason as any).code==='QUOTE_CHANGED').length,1);
  const f=candidates[attempted.findIndex(r=>r.status==='fulfilled')],blocked=candidates[attempted.findIndex(r=>r.status==='rejected')];
  await Promise.all(Array.from({length:6},()=>transaction(pool,c=>bindCommerceScopeRun(c,owner,f.scope.scope_quote_id,f.run.id))));
  assert.equal(Number((await pool.query('SELECT count(*) n FROM bb_commerce_scope_runs WHERE scope_quote_id=$1',[f.scope.scope_quote_id])).rows[0].n),1);
  await assert.rejects(pool.query("UPDATE bb_commerce_scope_runs SET plan='{}' WHERE scope_quote_id=$1",[f.scope.scope_quote_id]),/immutable/);
  await assert.rejects(pool.query('DELETE FROM bb_commerce_scope_runs WHERE scope_quote_id=$1',[f.scope.scope_quote_id]),/immutable/);
  const otherRun=randomUUID();await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'generation',$4,'failed')",[otherRun,owner,f.project,f.hash]);
  await assert.rejects(transaction(pool,c=>bindCommerceScopeRun(c,owner,f.scope.scope_quote_id,otherRun)),e=>(e as any).code==='IDEMPOTENCY_CONFLICT');
  await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[f.run.id]);
  await transaction(pool,c=>bindCommerceScopeRun(c,owner,blocked.scope.scope_quote_id,blocked.run.id));
  const pendingProject=randomUUID();await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic pending scope','generation')",[pendingProject,owner]);
  await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,$4,'[]','[]')",[pendingProject,owner,f.hash,f.manifest]);
  await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1',[pendingProject]);
  const pending=await quoteCredits(pool,owner,pendingProject,1,f.hash,true);assert.equal(pending.quote.points,0);assert.equal(pending.quote.quote_status,'pending_scope');
  const pendingRun={...f.run,id:randomUUID(),project_id:pendingProject};
  await assert.rejects(transaction(pool,async c=>{const p=(await c.query('SELECT * FROM bb_projects WHERE id=$1',[pendingProject])).rows[0];await reserveCredits(c,owner,pendingRun,pending.quote.quote_id,{revision:1,manifest:f.manifest},p,undefined,true);}),e=>['QUOTE_CHANGED','QUOTE_REQUIRED'].includes((e as any).code));
  assert.equal((await owned(pool,owner,[key])).length,1,'an accepted but undelivered continuation creates no new owned receipt');
 }finally{await pool.end();}
});

test('ordinary compensation and refunding unused original payment balance preserve delivered service coverage',options,async()=>{
 const pool=new Pool({connectionString:database});
 try{
  const owner=await actor(pool),key='synthetic-cash-refund:'+owner;
  const refund=(o:RefundOrder):VerifiedRefund=>({refundId:o.id,orderId:o.order_id,merchantId:o.merchant_id,transactionId:o.provider_transaction_id,providerRefundId:'synthetic_'+o.id,
   currency:'CNY',orderAmountFen:o.order_amount_fen,amountFen:o.amount_fen,payerTotalFen:o.order_amount_fen,payerRefundFen:o.amount_fen,state:'succeeded'});
  const provider:PaymentProvider={name:'wechat',merchantId:'synthetic-coverage-merchant',acknowledgement:{code:'SUCCESS'},create:async()=>({checkoutUrl:'weixin://wxpay/bizpayurl?pr=synthetic-coverage'}),
   query:async()=>{throw Error('No external query');},verifyCallback:async()=>{throw Error('No external callback');},refunds:{create:async o=>refund(o),query:async o=>refund(o),verifyCallback:async()=>{throw Error('No external callback');}}};
  const order=await createServiceTopup(pool,owner,{request_id:randomUUID(),provider:'wechat',amount_fen:10000},[provider]);
  await applyVerifiedPayment(pool,provider,{orderId:order.order_id,merchantId:provider.merchantId,amountFen:10000,currency:'CNY',transactionId:'synthetic_'+order.order_id,state:'paid',payerCash:{amountFen:10000,currency:'CNY'}});
  const f=await fixture(pool,owner,[goal(key,'argument_reply')],false);await deliver(pool,f);
  assert.deepEqual(await creditBalance(pool,owner),{available:100,frozen:0});
  assert.equal((await requestPaymentRefund(pool,owner,order.order_id,{request_id:randomUUID(),amount_fen:100},[provider])).state,'succeeded');
  assert.equal((await owned(pool,owner,[key])).length,1,'unused wallet cash is not a service-entitlement reversal');
  const reservation=(await pool.query('SELECT id FROM bb_credit_reservations WHERE run_id=$1',[f.run.id])).rows[0];
  await transaction(pool,c=>grantCredits(c,{owner,source:'correction',key:'synthetic-platform-goodwill:'+f.run.id,points:1,expiresAt:null,actor:'synthetic-support',reason:'Ordinary support compensation',reservationId:reservation.id,runId:f.run.id}));
  assert.equal((await owned(pool,owner,[key])).length,1,'an unrelated correction event must not revoke coverage');
  await correctSettlement(pool,{runId:f.run.id,actor:'synthetic-operator',reason:'Synthetic verified service charge correction'});
  assert.deepEqual(await owned(pool,owner,[key]),[]);
 }finally{await pool.end();}
});

test('one accepted scope supports released failure retries, but only one live or successful attempt',options,async()=>{
 const pool=new Pool({connectionString:database});
 try{
  const owner=await actor(pool),key='synthetic-retry:'+owner,paid=await fixture(pool,owner,[goal(key,'fact_revision')]);await deliver(pool,paid);
  const source=(await owned(pool,owner,[key]))[0];
  const first=await fixture(pool,owner,[{key:'retry-included',coverage_key:key,family:'included',owned_coverage_id:source.id,reason:'Synthetic original-scope retry',evidence:['synthetic exact accepted scope']}]);
  const attempt=async(f:typeof first)=>{
   const run=(await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'generation',$4,'queued') RETURNING *",[randomUUID(),owner,f.project,f.hash])).rows[0];
   return {...f,run};
  };
  await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[first.run.id]);
  const second=await attempt(first),third=await attempt(first);
  const raced=await Promise.allSettled([second,third].map(f=>transaction(pool,c=>bindCommerceScopeRun(c,owner,f.scope.scope_quote_id,f.run.id))));
  assert.equal(raced.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(raced.filter(r=>r.status==='rejected'&&(r.reason as any).code==='IDEMPOTENCY_CONFLICT').length,1);
  const winner=[second,third][raced.findIndex(r=>r.status==='fulfilled')],retry=[second,third][raced.findIndex(r=>r.status==='rejected')];
  await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[winner.run.id]);
  await transaction(pool,c=>bindCommerceScopeRun(c,owner,retry.scope.scope_quote_id,retry.run.id));
  await deliver(pool,retry);
  await transaction(pool,c=>bindCommerceScopeRun(c,owner,first.scope.scope_quote_id,first.run.id));
  assert.equal(Number((await pool.query('SELECT count(*) n FROM bb_commerce_scope_runs WHERE scope_quote_id=$1',[first.scope.scope_quote_id])).rows[0].n),3,'attempt history remains immutable and replay does not add a row');
  const receipts=await owned(pool,owner,[key]);assert.equal(receipts.length,2,'only the successful retry earns the one contract receipt');
  assert.equal(receipts.filter(c=>c.id!==source.id).length,1);
  const afterSuccess=await attempt(first);
  await assert.rejects(transaction(pool,c=>bindCommerceScopeRun(c,owner,first.scope.scope_quote_id,afterSuccess.run.id)),e=>(e as any).code==='IDEMPOTENCY_CONFLICT');
  await assert.rejects(pool.query('INSERT INTO bb_commerce_scope_runs(owner_user_id,scope_quote_id,run_id,plan,pricing_items) SELECT $1,id,$3,work_plan,pricing_items FROM bb_scope_quotations WHERE id=$2',[owner,first.scope.scope_quote_id,afterSuccess.run.id]),/Scope already active or delivered/);
  assert.equal(Number((await pool.query('SELECT count(*) n FROM bb_credit_reservations WHERE run_id=ANY($1::text[])',[[first.run.id,second.run.id,third.run.id]])).rows[0].n),0,'zero-price retries never create a zero reservation');

  // A malformed historical terminal row must not permit spending again while
  // its old hold remains unreleased, even through a direct table insertion.
  const holdKey='synthetic-unreleased:'+owner,held=await fixture(pool,owner,[goal(holdKey,'fact_reply')]);
  await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[held.run.id]);
  const reservation=(await pool.query('SELECT id,state FROM bb_credit_reservations WHERE run_id=$1',[held.run.id])).rows[0];assert.equal(reservation.state,'released');
  await pool.query("UPDATE bb_credit_reservations SET state='held' WHERE id=$1",[reservation.id]);
  const blocked=await attempt(held);
  await assert.rejects(transaction(pool,c=>bindCommerceScopeRun(c,owner,held.scope.scope_quote_id,blocked.run.id)),e=>(e as any).code==='IDEMPOTENCY_CONFLICT');
  await assert.rejects(pool.query('INSERT INTO bb_commerce_scope_runs(owner_user_id,scope_quote_id,run_id,plan,pricing_items) SELECT $1,id,$3,work_plan,pricing_items FROM bb_scope_quotations WHERE id=$2',[owner,held.scope.scope_quote_id,blocked.run.id]),/previous reservation not released/);
  await pool.query("UPDATE bb_credit_reservations SET state='released' WHERE id=$1",[reservation.id]);
 }finally{await pool.end();}
});
