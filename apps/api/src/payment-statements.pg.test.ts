import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {Pool} from 'pg';
import {isolatedTestDatabase} from './test-database.js';
import {uid} from './data.js';
import {creditBalance} from './billing.js';
import {auditCredits} from './billing-ops.js';
import {applyVerifiedPayment,closeRecharge,refreshRecharge,openCheckout,type PaymentProvider,type VerifiedPayment} from './payments.js';
import {requestPaymentRefund,type VerifiedRefund} from './payment-refunds.js';
import {enqueuePaymentStatement,reconcileDailyStatements} from './payment-statements.js';
import {parsePaymentStatement,type PaymentStatementRequest,type VerifiedPaymentStatement} from './payment-statements-format.js';
import {syntheticTradeStatement,syntheticFundStatement,statementFixtureDate} from './test-payment-statements.js';
const database=await isolatedTestDatabase(undefined,'payment-statements');
const manualNow=new Date('2026-10-28T01:00:00Z'); // 09:00 Shanghai: only explicitly queued jobs run.
async function setup(){
  const pool=new Pool({connectionString:database}),owner=uid(),merchant=String(BigInt('0x'+uid().replaceAll('-','').slice(0,10)));
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_statement_'+owner.slice(0,8)]);
  return {pool,owner,merchant};
}
async function order(h:Awaited<ReturnType<typeof setup>>,points=10000){
  const id=uid().replaceAll('-','');await h.pool.query(`INSERT INTO bb_recharge_orders(id,owner_user_id,request_id,request_hash,provider,pack_id,pack_version,amount_fen,points,currency,merchant_id,expires_at)
    VALUES($1,$2,$1,$3,'wechat',$4,'synthetic-old-paid',10000,$5,'CNY',$6,now()+interval '30 minutes')`,[id,h.owner,'a'.repeat(64),points===10000?'service_balance':'legacy_bonus',points,h.merchant]);return id;
}
const paid=(id:string,merchant:string,cash=true):VerifiedPayment=>({orderId:id,merchantId:merchant,amountFen:10000,currency:'CNY',transactionId:'synthetic_txn_'+id,state:'paid',paidAt:'2026-10-27T04:00:00Z',...(cash?{payerCash:{amountFen:10000,currency:'CNY'}}:{})});
function provider(merchant:string):PaymentProvider{return{name:'wechat',merchantId:merchant,acknowledgement:{},create:async()=>{throw Error('No checkout creation allowed');},query:async o=>paid(o.id,merchant),verifyCallback:async()=>{throw Error('No callback');}};}
function parsed(source:string,request:PaymentStatementRequest,merchant:string):VerifiedPaymentStatement{return parsePaymentStatement(Buffer.from(source),{...request,merchantId:merchant,appId:'wx1234567890abcdef',sha1:createHash('sha1').update(source).digest('hex'),verifiedAt:'2026-10-28T04:00:00Z'});}

test('paid historical proof refresh reuses the exact existing lot without granting credits again',{skip:!database},async()=>{
  const h=await setup(),p=provider(h.merchant);
  try{
    const id=await order(h,17000);await applyVerifiedPayment(h.pool,p,paid(id,h.merchant,false));
    assert.equal((await h.pool.query('SELECT count(*)::int n FROM bb_payment_cash_proofs WHERE order_id=$1',[id])).rows[0].n,0);
    const original=(await h.pool.query('SELECT id FROM bb_credit_lots WHERE owner_user_id=$1',[h.owner])).rows[0].id;
    await refreshRecharge(h.pool,h.owner,id,[p]);await applyVerifiedPayment(h.pool,p,paid(id,h.merchant));
    assert.equal((await h.pool.query('SELECT lot_id FROM bb_payment_cash_proofs WHERE order_id=$1',[id])).rows[0].lot_id,original);
    assert.deepEqual(await creditBalance(h.pool,h.owner),{available:17000,frozen:0});
    assert.equal((await h.pool.query("SELECT count(*)::int n FROM bb_credit_events WHERE owner_user_id=$1 AND kind='grant'",[h.owner])).rows[0].n,1);
    await assert.rejects(()=>applyVerifiedPayment(h.pool,p,{...paid(id,h.merchant),transactionId:'foreign_transaction'}));
    assert.equal((await auditCredits(h.pool)).consistent,true);
  }finally{await h.pool.end();}
});

test('close intent survives unknown response, blocks reopening, and cannot erase a verified payment',{skip:!database},async()=>{
  const h=await setup(),p=provider(h.merchant);let closes=0,unknown=true;
  p.closePayment=async o=>{closes++;if(unknown)throw Error('Synthetic close timeout');return paid(o.id,h.merchant);};
  try{
    const id=await order(h);await assert.rejects(()=>closeRecharge(h.pool,h.owner,id,[p]));
    const pending=(await h.pool.query('SELECT * FROM bb_recharge_orders WHERE id=$1',[id])).rows[0];
    assert.equal(pending.state,'pending');assert.ok(pending.close_requested_at);assert.equal(pending.close_confirmed_at,null);
    await assert.rejects(()=>openCheckout(h.pool,h.owner,pending,[p]));
    await assert.rejects(()=>closeRecharge(h.pool,uid(),id,[p]));assert.equal(closes,1);
    unknown=false;assert.equal((await closeRecharge(h.pool,h.owner,id,[p])).state,'paid');
    assert.equal((await closeRecharge(h.pool,h.owner,id,[p])).state,'paid');assert.equal(closes,2);
    assert.deepEqual(await creditBalance(h.pool,h.owner),{available:10000,frozen:0});assert.equal((await auditCredits(h.pool)).consistent,true);
  }finally{await h.pool.end();}
});

test('historical statement keeps gross issuance and refund cash separate from current balance and later refund success',{skip:!database},async()=>{
  const h=await setup();let refund!:VerifiedRefund;
  const p:PaymentProvider={...provider(h.merchant),refunds:{create:async r=>refund={refundId:r.id,orderId:r.order_id,merchantId:r.merchant_id,transactionId:r.provider_transaction_id,providerRefundId:'channel_'+r.id.slice(0,23),currency:'CNY',orderAmountFen:10000,amountFen:r.amount_fen,payerTotalFen:10000,payerRefundFen:r.amount_fen,state:'succeeded'},query:async()=>refund,verifyCallback:async()=>refund}};
  try{
    const id=await order(h,17000);await applyVerifiedPayment(h.pool,p,paid(id,h.merchant));
    await requestPaymentRefund(h.pool,h.owner,id,{request_id:uid(),points:4250,expected_amount_fen:2500},[p]);
    const before=await creditBalance(h.pool,h.owner);
    p.downloadStatements=async request=>parsed(request.kind==='trade'?syntheticTradeStatement({merchant:h.merchant,orderId:id,transactionId:paid(id,h.merchant).transactionId!,refund:true,refundId:refund.refundId,providerRefundId:refund.providerRefundId,refundStatus:'PROCESSING'}):syntheticFundStatement({orderId:id,transactionId:paid(id,h.merchant).transactionId!}),request,h.merchant);
    for(const kind of ['trade','funds'] as const)await enqueuePaymentStatement(h.pool,p,{billDate:statementFixtureDate,kind});
    assert.equal((await reconcileDailyStatements(h.pool,[p],{now:manualNow})).completed,2);
    const checks=(await h.pool.query('SELECT c.difference_count FROM bb_payment_statement_checks c JOIN bb_payment_statement_jobs j ON j.id=c.job_id WHERE j.merchant_id=$1',[h.merchant])).rows;
    assert.equal(checks.length,2);assert.ok(checks.every(row=>row.difference_count===0),JSON.stringify(checks));
    assert.deepEqual(await creditBalance(h.pool,h.owner),before);assert.equal((await auditCredits(h.pool)).consistent,true);
    assert.equal((await reconcileDailyStatements(h.pool,[p],{now:manualNow})).checked,0);
  }finally{await h.pool.end();}
});

test('statement-only receipt raises persisted differences without creating payment credit, and concurrent scans claim once',{skip:!database},async()=>{
  const h=await setup(),p=provider(h.merchant);let downloads=0;
  p.downloadStatements=async request=>{downloads++;return parsed(syntheticTradeStatement({merchant:h.merchant}),request,h.merchant);};
  try{
    await enqueuePaymentStatement(h.pool,p,{billDate:statementFixtureDate,kind:'trade'});
    const runs=await Promise.all([reconcileDailyStatements(h.pool,[p],{now:manualNow}),reconcileDailyStatements(h.pool,[p],{now:manualNow})]);
    assert.equal(downloads,1);assert.equal(runs.reduce((sum,r)=>sum+r.completed,0),1);
    const issues=(await h.pool.query('SELECT d.kind FROM bb_payment_statement_differences d JOIN bb_payment_statement_checks c ON c.id=d.check_id JOIN bb_payment_statement_jobs j ON j.id=c.job_id WHERE j.merchant_id=$1',[h.merchant])).rows;
    assert.deepEqual(issues.map(i=>i.kind),['channel_payment_without_order']);
    assert.deepEqual(await creditBalance(h.pool,h.owner),{available:0,frozen:0});
    assert.equal((await h.pool.query("SELECT count(*)::int n FROM bb_ops_alerts WHERE kind='payment_statement_difference' AND detail->>'statement_job_id' IN (SELECT id FROM bb_payment_statement_jobs WHERE merchant_id=$1)",[h.merchant])).rows[0].n,1);
  }finally{await h.pool.end();}
});

test('refund reverse coverage needs authenticated application-date evidence and detects a later missing row without mutating wallets',{skip:!database},async()=>{
  const h=await setup();let refund!:VerifiedRefund,includeRefund=false;
  const p:PaymentProvider={...provider(h.merchant),refunds:{create:async r=>refund={refundId:r.id,orderId:r.order_id,merchantId:r.merchant_id,transactionId:r.provider_transaction_id,providerRefundId:'channel_'+r.id.slice(0,23),currency:'CNY',orderAmountFen:10000,amountFen:r.amount_fen,payerTotalFen:10000,payerRefundFen:r.amount_fen,state:'succeeded'},query:async()=>refund,verifyCallback:async()=>refund}};
  try{
    const id=await order(h,17000);await applyVerifiedPayment(h.pool,p,paid(id,h.merchant));
    await requestPaymentRefund(h.pool,h.owner,id,{request_id:uid(),points:4250,expected_amount_fen:2500},[p]);
    const before=await creditBalance(h.pool,h.owner),eventCount=(await h.pool.query('SELECT count(*)::int n FROM bb_credit_events WHERE owner_user_id=$1',[h.owner])).rows[0].n;
    p.downloadStatements=async request=>parsed(syntheticTradeStatement({merchant:h.merchant,orderId:id,transactionId:paid(id,h.merchant).transactionId!,refund:includeRefund,refundId:refund.refundId,providerRefundId:refund.providerRefundId}),request,h.merchant);
    const job=await enqueuePaymentStatement(h.pool,p,{billDate:statementFixtureDate,kind:'trade'});
    const check=async()=>{
      await h.pool.query("UPDATE bb_payment_statement_jobs SET next_attempt_at=now()-interval '1 minute' WHERE id=$1",[job]);
      assert.equal((await reconcileDailyStatements(h.pool,[p],{now:manualNow})).completed,1);
      return (await h.pool.query('SELECT d.kind,d.reference_id,d.line_no FROM bb_payment_statement_differences d JOIN bb_payment_statement_jobs j ON j.last_check_id=d.check_id WHERE j.id=$1 ORDER BY d.kind',[job])).rows;
    };
    assert.deepEqual(await check(),[{kind:'refund_application_date_uncovered',reference_id:refund.refundId,line_no:0}]);
    includeRefund=true;assert.deepEqual(await check(),[]);
    includeRefund=false;assert.deepEqual(await check(),[{kind:'local_refund_missing_from_statement',reference_id:refund.refundId,line_no:0}]);
    assert.deepEqual(await creditBalance(h.pool,h.owner),before);
    assert.equal((await h.pool.query('SELECT count(*)::int n FROM bb_credit_events WHERE owner_user_id=$1',[h.owner])).rows[0].n,eventCount);
    assert.equal((await auditCredits(h.pool)).consistent,true);
  }finally{await h.pool.end();}
});

test('mismatched statement identity and unavailable provider keep the job recoverable and alert without private error data',{skip:!database},async()=>{
  const h=await setup(),p=provider(h.merchant);
  p.downloadStatements=async request=>({...parsed(syntheticTradeStatement({merchant:h.merchant}),request,h.merchant),merchantId:'foreign-merchant'});
  try{
    await enqueuePaymentStatement(h.pool,p,{billDate:statementFixtureDate,kind:'trade'});
    assert.equal((await reconcileDailyStatements(h.pool,[p],{now:manualNow})).unknown,1);
    const job=(await h.pool.query('SELECT * FROM bb_payment_statement_jobs WHERE merchant_id=$1',[h.merchant])).rows[0];
    assert.equal(job.state,'unknown');assert.equal(job.lease_token,null);
    assert.equal((await h.pool.query('SELECT count(*)::int n FROM bb_payment_statements WHERE job_id=$1',[job.id])).rows[0].n,0);
    p.downloadStatements=async()=>{throw Error('synthetic-private-download-token');};
    await h.pool.query("UPDATE bb_payment_statement_jobs SET next_attempt_at=now()-interval '1 minute' WHERE id=$1",[job.id]);
    assert.equal((await reconcileDailyStatements(h.pool,[p],{now:manualNow})).unknown,1);
    const alerts=(await h.pool.query("SELECT detail FROM bb_ops_alerts WHERE detail->>'statement_job_id'=$1",[job.id])).rows;
    assert.ok(alerts.length>0);assert.equal(JSON.stringify(alerts).includes('synthetic-private-download-token'),false);
    assert.deepEqual(await creditBalance(h.pool,h.owner),{available:0,frozen:0});
  }finally{await h.pool.end();}
});
