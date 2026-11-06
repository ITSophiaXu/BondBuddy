import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {Pool} from 'pg';
import {testClient} from './test-client.mjs';
import {runtime,config,pgBase} from './config.mjs';
import {auditCredits} from '../../apps/api/dist/billing-audit.js';
import {syntheticPaymentProvider} from './provider.mjs';

// Every state transition below crosses real authenticated HTTP and PostgreSQL.
// Only channel receipts, work milestones and explicitly labelled Word are synthetic.
// No wallet, order, task, clock or response is directly edited by this verifier.
const saved=config(),pool=new Pool({connectionString:pgBase+saved.database});
const startedAt=new Date().toISOString(),checks=[],accounts=[],resourceIds={orders:[],tasks:[],refunds:[]};
const record=name=>checks.push(name),account=async(prefix)=>{const a=testClient();Object.assign(a,await a.register(prefix));accounts.push(a);return a;};
const amounts=(s,available,refundHeld=0)=>{assert.equal(BigInt(s.account.available_points),BigInt(available));assert.equal(BigInt(s.account.task_held_points),0n);assert.equal(BigInt(s.account.refund_held_points),BigInt(refundHeld));};
const payment=(s,id)=>{const p=s.payments.find(p=>p.id===id);assert.ok(p,'missing payment '+id);return p;};
const refund=(s,id)=>{const r=s.refunds.find(r=>r.id===id);assert.ok(r,'missing refund '+id);return r;};
const task=(s,id)=>{const t=s.tasks.find(t=>t.id===id);assert.ok(t,'missing task '+id);return t;};
const topup=async(a,amount)=>{const request_id=randomUUID(),order=await a.post('/api/v1/commerce/topups',{request_id,amount_fen:String(amount),provider:'wechat'},201);resourceIds.orders.push(order.order_id);return {...order,request_id};};
const prepare=async(a)=>{const id=randomUUID();await a.post('/__billing-test/api/review/prepare',{id,mode:'dynamic'});resourceIds.tasks.push(id);return id;};
const progress=(a,id,stage)=>a.post('/__billing-test/api/review/progress',{id,stage});
const finish=(a,id,outcome)=>a.post('/__billing-test/api/review/finish',{id,outcome});
const counters=async(owner,id)=>{
  return (await pool.query(`SELECT r.id,r.state,r.billing_policy,r.points::text,r.charged_points::text,
    (SELECT COALESCE(sum(a.points),0)::text FROM bb_credit_allocations a WHERE a.reservation_id=r.id) allocated,
    (SELECT COALESCE(sum(e.points),0)::text FROM bb_credit_events e WHERE e.reservation_id=r.id AND e.kind='settle') gross,
    (SELECT COALESCE(sum(e.points),0)::text FROM bb_credit_events e WHERE e.reservation_id=r.id AND e.kind='correction') corrected,
    (SELECT count(*)::int FROM bb_credit_events e WHERE e.reservation_id=r.id AND e.kind IN ('reserve','release')) legacy_events,
    (SELECT count(*)::int FROM bb_credit_allocations a JOIN bb_credit_lots l ON l.id=a.lot_id WHERE a.reservation_id=r.id AND l.owner_user_id<>$1) foreign_lots
    FROM bb_credit_reservations r WHERE r.run_id=$2 AND r.owner_user_id=$1`,[owner,id])).rows[0];
};
let failure;
try{
  assert.deepEqual((await pool.query('SELECT current_database() database,instance_id FROM bb_local_billing_instance')).rows,[{database:saved.database,instance_id:saved.id}]);
  const anonymous=testClient();await anonymous.post('/__billing-test/api/payment/outcome',{id:'0'.repeat(32),outcome:'paid',delivery:'query'},401);
  const a=await account('billing_pay_'),foreign=await account('billing_other_');amounts(await a.state(),0);amounts(await foreign.state(),0);
  record('isolated marker verified; new accounts start at zero and anonymous controls are denied');
  const quoteTask=await prepare(a);await a.post('/__billing-test/api/review/start',{id:quoteTask},402);amounts(await a.state(),0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1',[a.owner])).rows[0].n,0);
  record('zero-balance start creates neither a run nor a debit');

  const first=await topup(a,30000);
  const replayed=await a.post('/api/v1/commerce/topups',{request_id:first.request_id,amount_fen:'30000',provider:'wechat'},201);assert.equal(replayed.order_id,first.order_id);
  await a.post('/api/v1/commerce/topups',{request_id:first.request_id,amount_fen:'30001',provider:'wechat'},409);
  await a.post('/api/v1/commerce/topups',{request_id:randomUUID(),amount_fen:'0',provider:'wechat'},422);
  await a.post('/api/v1/commerce/topups',{request_id:randomUUID(),amount_fen:'1.5',provider:'wechat'},422);
  record('same recharge key returns one order, a changed amount conflicts, and invalid amounts create no payment');
  assert.equal((await a.post('/api/v1/commerce/topups/'+first.order_id+'/refresh')).state,'pending');amounts(await a.state(),0);
  await a.post('/__billing-test/api/payment/outcome',{id:first.order_id,outcome:'paid',delivery:'query'},403,{'x-bb-csrf':''});
  await a.post('/__billing-test/api/payment/outcome',{id:first.order_id,outcome:'paid',delivery:'query'},403,{origin:'http://untrusted.example'});
  for(const path of ['payment/outcome','payment/close','payment/refresh'])await foreign.post('/__billing-test/api/'+path,path.endsWith('outcome')?{id:first.order_id,outcome:'paid',delivery:'query'}:{id:first.order_id},404);
  record('refreshing an unpaid order grants nothing; CSRF, Origin and owner isolation are enforced');
  await a.post('/__billing-test/api/payment/outcome',{id:first.order_id,outcome:'paid',delivery:'query'});
  let current=await a.state();amounts(current,0);assert.equal(payment(current,first.order_id).channel_state,'paid');assert.equal(payment(current,first.order_id).state,'pending');
  await a.post('/api/v1/commerce/topups/'+first.order_id+'/refresh');amounts(await a.state(),30000);
  await a.pay(first.order_id);await a.pay(first.order_id,'callback');amounts(await a.state(),30000);
  await Promise.all([
    a.post('/__billing-test/api/payment/outcome',{id:first.order_id,outcome:'paid',delivery:'callback'}),
    a.post('/api/v1/commerce/topups/'+first.order_id+'/refresh')
  ]);amounts(await a.state(),30000);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_lots WHERE owner_user_id=$1 AND source_key=$2',[a.owner,'recharge:'+first.order_id])).rows[0].n,1);
  record('a persisted paid channel receipt is credited by product query exactly once, including concurrent callback/query delivery');
  const second=await topup(a,10000);await a.post('/__billing-test/api/payment/outcome',{id:second.order_id,outcome:'paid',delivery:'callback'});
  current=await a.state();amounts(current,40000);assert.equal(payment(current,second.order_id).state,'paid');
  await a.pay(second.order_id,'callback');amounts(await a.state(),40000);record('authenticated synthetic callback credits a second actual order once');
  const failed=await topup(a,1234);await a.pay(failed.order_id,'query','failed');current=await a.state();amounts(current,40000);assert.equal(payment(current,failed.order_id).state,'failed');
  const closed=await topup(a,5000);await a.post('/__billing-test/api/payment/close',{id:closed.order_id});
  current=await a.state();amounts(current,40000);assert.ok(['closed','expired'].includes(payment(current,closed.order_id).state));
  await a.post('/__billing-test/api/payment/outcome',{id:closed.order_id,outcome:'paid',delivery:'query'},409);amounts(await a.state(),40000);
  record('failed and confirmed-closed orders never credit the wallet and a closed order cannot be paid');

  current=await a.post('/__billing-test/api/review/start',{id:quoteTask});amounts(current,40000);const succeededRun=task(current,quoteTask).run_id;
  assert.equal(task(current,quoteTask).billing_policy,'authoring_balance_v2');assert.equal(task(current,quoteTask).gross_charged_points,'0');
  await progress(a,quoteTask,'input_lock');current=await progress(a,quoteTask,'model_generation');assert.ok(BigInt(task(current,quoteTask).gross_charged_points)>0n);
  const beforeReplay=await counters(a.owner,succeededRun);await progress(a,quoteTask,'model_generation');assert.deepEqual(await counters(a.owner,succeededRun),beforeReplay);
  current=await finish(a,quoteTask,'succeeded');amounts(current,12805);assert.equal(task(current,quoteTask).state,'succeeded');assert.equal(BigInt(task(current,quoteTask).charged_points),27195n);
  const afterSuccess=await counters(a.owner,succeededRun);assert.equal(afterSuccess.gross,'27195');assert.equal(afterSuccess.allocated,'27195');assert.equal(afterSuccess.legacy_events,0);
  await finish(a,quoteTask,'succeeded');current=await a.post('/__billing-test/api/review/start',{id:quoteTask});amounts(current,12805);assert.equal(task(current,quoteTask).run_id,succeededRun);assert.deepEqual(await counters(a.owner,succeededRun),afterSuccess);
  record('v2 starts without a full-price hold, debits real milestones once, then settles one successful delivery exactly once');
  const failedTask=await prepare(a);await a.post('/__billing-test/api/review/start',{id:failedTask});current=await progress(a,failedTask,'input_lock');const failedRun=task(current,failedTask).run_id;
  await progress(a,failedTask,'model_generation');const beforeFailure=await counters(a.owner,failedRun);assert.ok(BigInt(beforeFailure.gross)>0n);
  current=await finish(a,failedTask,'failed');amounts(current,12805);assert.equal(task(current,failedTask).charged_points,'0');
  const afterFailure=await counters(a.owner,failedRun);assert.equal(afterFailure.gross,afterFailure.allocated);assert.equal(afterFailure.gross,afterFailure.corrected);assert.equal(afterFailure.foreign_lots,0);assert.equal(afterFailure.legacy_events,0);
  await finish(a,failedTask,'failed');amounts(await a.state(),12805);assert.deepEqual(await counters(a.owner,failedRun),afterFailure);
  record('platform failure preserves gross debits and refunds every allocated source once, restoring the wallet and net charge to zero');

  const low=await account('billing_low_'),initial=await topup(low,1);await low.pay(initial.order_id);const lowTask=await prepare(low);
  current=await low.post('/__billing-test/api/review/start',{id:lowTask});amounts(current,1);const resumedRun=task(current,lowTask).run_id;
  current=await progress(low,lowTask,'input_lock');amounts(current,0);assert.equal(task(current,lowTask).state,'paused');assert.deepEqual(task(current,lowTask).checkpoint_stages,['input_lock']);
  const lowBefore=await counters(low.owner,resumedRun);await progress(low,lowTask,'input_lock');assert.deepEqual(await counters(low.owner,resumedRun),lowBefore);
  const tiny=await topup(low,100);await low.pay(tiny.order_id);current=await low.state();amounts(current,100);assert.equal(task(current,lowTask).state,'queued');
  current=await progress(low,lowTask,'model_generation');amounts(current,0);assert.equal(task(current,lowTask).state,'paused');assert.ok(task(current,lowTask).checkpoint_stages.includes('model_generation'));
  const lowMiddle=await counters(low.owner,resumedRun);await progress(low,lowTask,'model_generation');assert.deepEqual(await counters(low.owner,resumedRun),lowMiddle);
  const small=await topup(low,1);await low.pay(small.order_id);current=await finish(low,lowTask,'succeeded');amounts(current,0);assert.equal(task(current,lowTask).state,'paused');
  const artifactSql='SELECT a.artifact_id AS id,a.artifact_version AS version,v.sha256 FROM bb_review_artifacts a JOIN bb_artifact_versions v ON v.id=a.artifact_id AND v.version=a.artifact_version WHERE a.run_id=$1 AND a.owner_user_id=$2 ORDER BY a.artifact_id,a.artifact_version';
  const artifactBefore=(await pool.query(artifactSql,[resumedRun,low.owner])).rows;
  assert.equal(artifactBefore.length,3);assert.ok(task(current,lowTask).checkpoint_stages.includes('word_delivery_pair'));
  const enough=await topup(low,30000);await low.pay(enough.order_id);current=await finish(low,lowTask,'succeeded');
  amounts(current,2907);assert.equal(task(current,lowTask).state,'succeeded');assert.equal(task(current,lowTask).run_id,resumedRun);assert.equal(task(current,lowTask).gross_charged_points,'27195');
  assert.deepEqual((await pool.query(artifactSql,[resumedRun,low.owner])).rows,artifactBefore);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1',[low.owner])).rows[0].n,1);
  record('one-point start pauses at zero; recharge resumes the same saved stages and delivery tail without new artifacts, run or duplicate debit');

  const refunds=await account('billing_refund_'),refundable=await topup(refunds,10000);await refunds.pay(refundable.order_id);amounts(await refunds.state(),10000);
  const requestId=randomUUID();current=await refunds.post('/__billing-test/api/refund/request',{id:refundable.order_id,amount_fen:'2000',request_id:requestId});
  const pending=current.refunds.find(r=>r.order_id===refundable.order_id&&r.request_id===requestId);assert.ok(pending);resourceIds.refunds.push(pending.id);amounts(current,8000,2000);assert.equal(pending.channel_state,'processing');
  await refunds.post('/__billing-test/api/refund/request',{id:refundable.order_id,amount_fen:'2000',request_id:requestId});amounts(await refunds.state(),8000,2000);
  await refunds.post('/__billing-test/api/refund/request',{id:refundable.order_id,amount_fen:'2001',request_id:requestId},409);amounts(await refunds.state(),8000,2000);
  await foreign.post('/__billing-test/api/refund/outcome',{id:pending.id,outcome:'succeeded',delivery:'query'},404);
  await refunds.post('/__billing-test/api/refund/outcome',{id:pending.id,outcome:'failed',delivery:'query'});await refunds.post('/__billing-test/api/refund/refresh',{id:pending.id});amounts(await refunds.state(),10000);
  record('a real refund request freezes only original-order points, retries once, rejects another owner, and releases on verified failure');
  const finalRequest=randomUUID();current=await refunds.post('/__billing-test/api/refund/request',{id:refundable.order_id,amount_fen:'3000',request_id:finalRequest});
  const successful=current.refunds.find(r=>r.request_id===finalRequest);assert.ok(successful);resourceIds.refunds.push(successful.id);amounts(current,7000,3000);
  await refunds.post('/__billing-test/api/refund/outcome',{id:successful.id,outcome:'succeeded',delivery:'query'});amounts(await refunds.state(),7000,3000);
  await refunds.post('/__billing-test/api/refund/refresh',{id:successful.id});current=await refunds.state();amounts(current,7000);assert.equal(refund(current,successful.id).state,'succeeded');
  await refunds.post('/__billing-test/api/refund/outcome',{id:successful.id,outcome:'succeeded',delivery:'callback'});await refunds.post('/__billing-test/api/refund/refresh',{id:successful.id});amounts(await refunds.state(),7000);
  assert.equal((await pool.query("SELECT count(*)::int n FROM bb_payment_refund_events WHERE refund_id=$1 AND kind='succeeded'",[successful.id])).rows[0].n,1);
  record('query and callback refund confirmation remove frozen points once with one cash-refund settlement event');
  const callbackRequest=randomUUID();current=await refunds.post('/__billing-test/api/refund/request',{id:refundable.order_id,amount_fen:'1000',request_id:callbackRequest});const callbackRefund=current.refunds.find(r=>r.request_id===callbackRequest);assert.ok(callbackRefund);resourceIds.refunds.push(callbackRefund.id);
  await refunds.post('/__billing-test/api/refund/outcome',{id:callbackRefund.id,outcome:'succeeded',delivery:'callback'});amounts(await refunds.state(),6000);record('authenticated refund callback completes an additional partial original-order refund');

  const reconstructed=syntheticPaymentProvider(pool,saved),raw=(await pool.query('SELECT * FROM bb_recharge_orders WHERE id=$1 AND owner_user_id=$2',[first.order_id,a.owner])).rows[0];
  const persisted=await reconstructed.query({id:raw.id,merchant_id:raw.merchant_id,amount_fen:Number(raw.amount_fen),currency:raw.currency,expires_at:raw.expires_at.toISOString()});assert.equal(persisted.state,'paid');
  const rawRefund=(await pool.query('SELECT * FROM bb_payment_refunds WHERE id=$1 AND owner_user_id=$2',[successful.id,refunds.owner])).rows[0];
  assert.equal((await reconstructed.refunds.query({id:rawRefund.id,order_id:rawRefund.order_id,merchant_id:rawRefund.merchant_id,provider_transaction_id:rawRefund.provider_txn_id,currency:'CNY',order_amount_fen:Number(rawRefund.order_amount_fen),amount_fen:Number(rawRefund.amount_fen)})).state,'succeeded');
  record('newly reconstructed provider reads the same persisted paid and refunded channel results');
  for(const a of accounts){assert.equal((await auditCredits(pool,a.owner)).consistent,true);assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE owner_user_id=$1',[a.owner])).rows[0].n,0);}
  record('all random accounts pass authoritative wallet audit with zero model calls');
}catch(error){failure=error;}
finally{
  const proof={synthetic:true,realHttp:true,realPostgres:true,realPaymentCallsPerformed:0,modelCallsPerformed:0,startedAt,finishedAt:new Date().toISOString(),instanceId:saved.id,
    accounts:accounts.map(({username,owner})=>({username,owner})),resourceIds,passed:checks.length,failed:failure?1:0,skipped:0,checks,...(failure?{error:String(failure),stack:failure.stack}:{})};
  mkdirSync(runtime,{recursive:true});writeFileSync(join(runtime,'payment-lifecycle-verification.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));await pool.end();
}
if(failure)throw failure;
