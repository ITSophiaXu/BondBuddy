import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Pool} from 'pg';
import {testClient} from './test-client.mjs';
import {baseURL,apiURL,config,directory,pgBase,repo,runtime} from './config.mjs';
import {syntheticPaymentProvider} from './provider.mjs';
import {auditCredits} from '../../apps/api/dist/billing-audit.js';

// Run alone, after the other billing verifiers: this deliberately stops and
// starts only the marker/token-owned local server. SQL inspection is read-only.
const saved=config(),pool=new Pool({connectionString:pgBase+saved.database});
const startedAt=new Date().toISOString(),out=join(runtime,'payment-restart',Date.now()+'-'+randomUUID().slice(0,8));
mkdirSync(out,{recursive:true});
const checks=[],accounts=[],restarts=[],record=name=>checks.push(name);
const account=async prefix=>{const a=testClient();Object.assign(a,await a.register(prefix));accounts.push(a);return a;};
const topup=(a,amount)=>a.post('/api/v1/commerce/topups',{request_id:randomUUID(),amount_fen:String(amount),provider:'wechat'},201);
const task=(state,id)=>{const value=state.tasks.find(row=>row.id===id);assert.ok(value);return value;};
const balances=(state,available,held=0)=>{assert.equal(BigInt(state.account.available_points),BigInt(available));assert.equal(BigInt(state.account.refund_held_points),BigInt(held));assert.equal(BigInt(state.account.task_held_points),0n);};
const status=async()=>{const response=await fetch(apiURL+'/__billing-test/status');assert.equal(response.status,200);const body=await response.json();assert.equal(body.synthetic,true);assert.equal(body.ready,true);return body;};
async function command(name){
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[join(directory,name+'.mjs')],{cwd:repo,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
    child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));
  });
  writeFileSync(join(out,restarts.length+'-'+name+'.log'),result.stdout+'\n'+result.stderr);
  assert.equal(result.code,0,name+' failed: '+result.stderr);return result;
}
async function restart(){
  const before=await status();
  await command('stop');
  let stopped=false;try{await fetch(apiURL+'/__billing-test/status',{signal:AbortSignal.timeout(1500)});}catch{stopped=true;}
  assert.equal(stopped,true,'owned API must be stopped before starting it again');
  await command('start');
  const after=await status();assert.notEqual(after.launch_id,before.launch_id);
  restarts.push({before:before.launch_id,after:after.launch_id});
}
async function callback(kind,envelope){
  const response=await fetch(baseURL+'/api/v1/payments/wechat/'+(kind==='payment'?'callback':'refund-callback'),{method:'POST',headers:{'content-type':'application/json',...envelope.headers},body:envelope.body});
  const text=await response.text();assert.equal(response.status,200,text);
}
const paymentCount=async order=>(await pool.query('SELECT count(*)::int n FROM bb_credit_lots WHERE source_key=$1',['recharge:'+order])).rows[0].n;
const refundCount=async id=>(await pool.query("SELECT count(*)::int n FROM bb_payment_refund_events WHERE refund_id=$1 AND kind='succeeded'",[id])).rows[0].n;
let failure;
try{
  assert.deepEqual((await pool.query('SELECT current_database() database,instance_id FROM bb_local_billing_instance')).rows,[{database:saved.database,instance_id:saved.id}]);
  await status();
  const paid=await account('billing_restart_pay_'),refunded=await account('billing_restart_ref_'),low=await account('billing_restart_low_');
  const provider=syntheticPaymentProvider(pool,saved);
  const pendingPaid=await topup(paid,10000);
  await paid.post('/__billing-test/api/payment/outcome',{id:pendingPaid.order_id,outcome:'paid',delivery:'query'});
  const receipt=await provider.query({id:pendingPaid.order_id,merchant_id:provider.merchantId,amount_fen:10000,currency:'CNY',expires_at:pendingPaid.expires_at});
  const signedPayment=await provider.synthetic.callback('payment',receipt);
  const paidDuringClose=await topup(paid,2500);
  await paid.post('/__billing-test/api/payment/outcome',{id:paidDuringClose.order_id,outcome:'paid',delivery:'query'});
  const closeReceipt=await provider.query({id:paidDuringClose.order_id,merchant_id:provider.merchantId,amount_fen:2500,currency:'CNY',expires_at:paidDuringClose.expires_at});
  const signedClosePayment=await provider.synthetic.callback('payment',closeReceipt);
  // Persist channel facts through the same provider control used by the UI;
  // constructing the envelope only reads its instance-specific durable key.
  const unpaid=await topup(paid,66),failed=await topup(paid,77),closed=await topup(paid,88);
  await paid.pay(failed.order_id,'query','failed');await paid.post('/__billing-test/api/payment/close',{id:closed.order_id});
  balances(await paid.state(),0);assert.equal(await paymentCount(pendingPaid.order_id),0);

  const refundOrder=await topup(refunded,10000);await refunded.pay(refundOrder.order_id);
  const refundRequest=randomUUID();let state=await refunded.post('/__billing-test/api/refund/request',{id:refundOrder.order_id,amount_fen:'2000',request_id:refundRequest});
  const refund=state.refunds.find(row=>row.request_id===refundRequest);assert.ok(refund);balances(state,8000,2000);
  await refunded.post('/__billing-test/api/refund/outcome',{id:refund.id,outcome:'succeeded',delivery:'query'});
  const refundReceipt=await provider.refunds.query({id:refund.id,order_id:refundOrder.order_id,merchant_id:provider.merchantId,provider_transaction_id:'synthetic-'+refundOrder.order_id,currency:'CNY',order_amount_fen:10000,amount_fen:2000});
  const signedRefund=await provider.synthetic.callback('refund',refundReceipt);assert.equal(await refundCount(refund.id),0);

  const tiny=await topup(low,1);await low.pay(tiny.order_id);
  const intent=randomUUID();await low.post('/__billing-test/api/review/prepare',{id:intent,mode:'dynamic'});
  state=await low.post('/__billing-test/api/review/start',{id:intent});const originalTask=task(state,intent),run=originalTask.run_id;
  state=await low.post('/__billing-test/api/review/progress',{id:intent,stage:'input_lock'});
  balances(state,0);assert.equal(task(state,intent).state,'paused');assert.deepEqual(task(state,intent).checkpoint_stages,['input_lock']);
  const originalCheckpoint=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE run_id=$1 AND owner_user_id=$2',[run,low.owner])).rows[0].checkpoint;
  const remaining=BigInt(originalTask.quote.points)-1n;const recharge=await topup(low,remaining);
  await low.post('/__billing-test/api/payment/outcome',{id:recharge.order_id,outcome:'paid',delivery:'query'});
  record('before restart: channel-paid/product-pending, refund-success/product-processing, and one saved credit-paused task are independently persisted');

  await restart();
  state=await paid.state();balances(state,0);
  assert.equal(state.payments.find(row=>row.id===pendingPaid.order_id).state,'pending');
  assert.equal(state.payments.find(row=>row.id===pendingPaid.order_id).channel_state,'paid');
  assert.equal(state.payments.find(row=>row.id===failed.order_id).state,'failed');
  assert.equal(state.payments.find(row=>row.id===closed.order_id).state,'expired');
  assert.equal((await paid.post('/api/v1/commerce/topups/'+unpaid.order_id+'/refresh')).state,'pending');
  balances(await paid.state(),0);record('a real server stop/start retains sessions and original payment states; startup and unpaid refresh never issue credits');

  await callback('payment',signedPayment);
  await Promise.all([callback('payment',signedPayment),paid.post('/api/v1/commerce/topups/'+pendingPaid.order_id+'/refresh')]);
  balances(await paid.state(),10000);assert.equal(await paymentCount(pendingPaid.order_id),1);
  record('a payment envelope signed before shutdown authenticates after restart; callback/query competition credits the original order once');

  const [closedAfterPaid]=await Promise.all([
    paid.post('/api/v1/credits/recharge-orders/'+paidDuringClose.order_id+'/close'),callback('payment',signedClosePayment)
  ]);
  assert.equal(closedAfterPaid.state,'paid');balances(await paid.state(),12500);assert.equal(await paymentCount(paidDuringClose.order_id),1);
  assert.equal((await paid.post('/api/v1/commerce/topups/'+paidDuringClose.order_id+'/refresh')).state,'paid');
  record('closing an original order already paid at the channel competes with its callback without losing payment or issuing a second credit');

  state=await refunded.state();balances(state,8000,2000);assert.equal(state.refunds.find(row=>row.id===refund.id).state,'processing');
  await callback('refund',signedRefund);
  await Promise.all([callback('refund',signedRefund),refunded.post('/api/v1/commerce/refunds/'+refund.id+'/refresh')]);
  state=await refunded.state();balances(state,8000);assert.equal(state.refunds.find(row=>row.id===refund.id).state,'succeeded');assert.equal(await refundCount(refund.id),1);
  record('a pre-shutdown refund envelope restores the original frozen refund after restart; repeated callback/query settles it once');

  state=await low.state();balances(state,0);assert.equal(task(state,intent).state,'paused');assert.equal(task(state,intent).run_id,run);
  assert.deepEqual((await pool.query('SELECT checkpoint FROM bb_jobs WHERE run_id=$1 AND owner_user_id=$2',[run,low.owner])).rows[0].checkpoint,originalCheckpoint);
  state=await low.post('/__billing-test/api/payment/refresh',{id:recharge.order_id});balances(state,remaining);assert.equal(task(state,intent).state,'queued');
  state=await low.post('/__billing-test/api/review/finish',{id:intent,outcome:'succeeded'});
  balances(state,0);assert.equal(task(state,intent).state,'succeeded');assert.equal(task(state,intent).run_id,run);
  assert.equal(BigInt(task(state,intent).charged_points),BigInt(originalTask.quote.points));
  const terminal=(await pool.query('SELECT state,charged_points::text FROM bb_credit_reservations WHERE run_id=$1 AND owner_user_id=$2',[run,low.owner])).rows;
  const artifacts=(await pool.query('SELECT artifact_id,artifact_version FROM bb_review_artifacts WHERE run_id=$1 AND owner_user_id=$2 ORDER BY artifact_id,artifact_version',[run,low.owner])).rows;
  record('a credit-paused task survives restart with its exact checkpoint and run; confirming its saved recharge resumes and settles the same task once');

  await restart();
  balances(await paid.state(),12500);balances(await refunded.state(),8000);balances(await low.state(),0);
  await callback('payment',signedPayment);await callback('refund',signedRefund);
  await low.post('/__billing-test/api/review/finish',{id:intent,outcome:'succeeded'});
  assert.equal(await paymentCount(pendingPaid.order_id),1);assert.equal(await refundCount(refund.id),1);
  assert.deepEqual((await pool.query('SELECT state,charged_points::text FROM bb_credit_reservations WHERE run_id=$1 AND owner_user_id=$2',[run,low.owner])).rows,terminal);
  assert.deepEqual((await pool.query('SELECT artifact_id,artifact_version FROM bb_review_artifacts WHERE run_id=$1 AND owner_user_id=$2 ORDER BY artifact_id,artifact_version',[run,low.owner])).rows,artifacts);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1',[low.owner])).rows[0].n,1);
  record('a second real restart and terminal replays preserve one payment lot, one refund settlement, one task charge and the same artifacts');
  for(const a of accounts){assert.equal((await auditCredits(pool,a.owner)).consistent,true);assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE owner_user_id=$1',[a.owner])).rows[0].n,0);}
  record('all restart accounts pass authoritative wallet audits with zero real payment or model calls');
}catch(error){failure=error;}
finally{
  const report={synthetic:true,realHttp:true,realPostgres:true,actualServerRestarts:restarts,realMoneyCharged:false,modelCalls:0,startedAt,finishedAt:new Date().toISOString(),instanceId:saved.id,accounts:accounts.map(({username,owner})=>({username,owner})),passed:checks.length,failed:failure?1:0,skipped:0,checks,...(failure?{error:String(failure),stack:failure.stack}:{})};
  writeFileSync(join(out,'result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,reportPath:join(out,'result.json')}));await pool.end();
}
if(failure)throw failure;
