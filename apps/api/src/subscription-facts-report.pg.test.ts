import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {uid} from './data.js';
import {isolatedTestDatabase} from './test-database.js';
import {createSubscriptionCheckout} from './subscriptions.js';
import {createServiceTopup,applyVerifiedPayment,type PaymentProvider,type VerifiedPayment} from './payments.js';
import {readSubscriptionFacts} from './subscription-facts-report.js';
import {applyVerifiedRefund,refreshPaymentRefund,requestPaymentRefund,type VerifiedRefund} from './payment-refunds.js';
const database=await isolatedTestDatabase(undefined,'subscription-facts-report');
test('monthly read-only report observes actual paid lots without recording prepayments or expiry as earned revenue',{skip:!database,timeout:60000},async()=>{
 const pool=new Pool({connectionString:database}),owner=uid(),receipts=new Map<string,VerifiedPayment>();
 const provider:PaymentProvider={name:'wechat',merchantId:'synthetic-monthly-facts',acknowledgement:{code:'SUCCESS'},create:async o=>{receipts.set(o.id,{orderId:o.id,merchantId:o.merchant_id,amountFen:o.amount_fen,currency:'CNY',state:'pending',transactionId:null});return{checkoutUrl:'weixin://wxpay/bizpayurl?pr=synthetic-facts'};},query:async o=>receipts.get(o.id)!,verifyCallback:async()=>{throw Error('Synthetic only');}};
 try{
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'facts_'+owner.replaceAll('-','').slice(0,24)]);
  const sub=await createSubscriptionCheckout(pool,owner,{request_id:uid(),plan_id:'light',provider:'wechat'},[provider]);
  const topup=await createServiceTopup(pool,owner,{request_id:uid(),provider:'wechat',amount_fen:1000},[provider]);
  for(const id of [sub.order.order_id,topup.order_id]){const r=receipts.get(id)!;await applyVerifiedPayment(pool,provider,{...r,state:'paid',transactionId:'synthetic-'+id,payerCash:{amountFen:r.amountFen,currency:'CNY'}});}
  const snapshot=async()=>(await pool.query("SELECT (SELECT count(*)::text FROM bb_credit_events) events,(SELECT count(*)::text FROM bb_credit_lots) lots,(SELECT COALESCE(sum(remaining),0)::text FROM bb_credit_lots) remaining")).rows[0];
  const before=await snapshot(),month=new Date(Date.now()+8*3600000).toISOString().slice(0,7),r=await readSubscriptionFacts(pool,month,month),m=r.months[0];
  assert.equal(m.paid_orders,'2');assert.equal(m.paid_subscription_orders,'1');assert.equal(m.paid_topup_orders,'1');assert.equal(m.verified_cash_paid_unique,'1');assert.equal(m.verified_payer_cash_fen,'20900');
  assert.equal(m.redeemed_points,'0');assert.deepEqual(m.net_earned_order_consideration_fen,{numerator:'0',denominator:'1'});assert.equal(m.expired_unfrozen_points_at_snapshot,'0');
  assert.equal(r.cohorts[0].calendar_month_subscription_repurchase_rate,null);assert.deepEqual(await snapshot(),before);
 }finally{await pool.end();}
});

for(const channel of ['wechat','alipay'] as const)test(channel+': cash refunds use authenticated Shanghai success month; missing dates remain unknown until read-only original-refund recovery',
 {skip:!database,timeout:60000},async()=>{
 const connection=await isolatedTestDatabase(undefined,'refund-facts-'+channel),pool=new Pool({connectionString:connection}),owner=uid();
 const merchant='synthetic-refund-facts-'+channel,receipts=new Map<string,VerifiedPayment>(),refundReceipts=new Map<string,VerifiedRefund>();
 let successAt:string|undefined,creates=0,queries=0;
 const provider:PaymentProvider={name:channel,merchantId:merchant,acknowledgement:{},
  create:async o=>{receipts.set(o.id,{orderId:o.id,merchantId:merchant,amountFen:o.amount_fen,currency:'CNY',state:'paid',transactionId:'synthetic-'+o.id,
   paidAt:'2026-01-30T04:00:00.000Z',payerCash:{amountFen:o.amount_fen,currency:'CNY'}});return{checkoutUrl:'https://synthetic.invalid/'+o.id};},
  query:async o=>receipts.get(o.id)!,verifyCallback:async()=>{throw Error('Synthetic only');},refunds:{
   create:async r=>{creates++;const receipt:VerifiedRefund={refundId:r.id,orderId:r.order_id,merchantId:merchant,transactionId:r.provider_transaction_id,
    providerRefundId:'synthetic-'+r.id,currency:'CNY',orderAmountFen:r.order_amount_fen,amountFen:r.amount_fen,payerTotalFen:r.order_amount_fen,payerRefundFen:r.amount_fen,
    state:'succeeded',...(successAt?{providerSucceededAt:successAt}:{}),...(channel==='wechat'?{providerCreatedAt:'2026-01-31T04:00:00.000Z'}:{})};
    refundReceipts.set(r.id,receipt);return receipt;},
   query:async r=>{queries++;return refundReceipts.get(r.id)!;},verifyCallback:async()=>{throw Error('Synthetic only');}}};
 const snapshot=async(omitRefundDates=false)=>{
  const result:Record<string,string>={};
  for(const table of ['bb_credit_accounts','bb_credit_lots','bb_credit_events','bb_recharge_orders','bb_payment_cash_proofs','bb_payment_refunds','bb_payment_refund_events','bb_payment_refund_allocations','bb_outbox']){
   const omit=table==='bb_payment_refunds'&&omitRefundDates?['provider_created_at','provider_succeeded_at','updated_at','next_reconcile_at','reconcile_attempts']:[];
   result[table]=(await pool.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t)-$2::text[] ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text value FROM ${table} t WHERE owner_user_id=$1`,[owner,omit])).rows[0].value;
  }
  return result;
 };
 const read=async()=>{
  const before=await snapshot(),report=await readSubscriptionFacts(pool,'2026-01','2026-11');
  assert.deepEqual(await snapshot(),before,'Reporting must not write balances, evidence, events or outbox');return report;
 };
 const refund=async(at?:string)=>{
  successAt=at;const order=await createServiceTopup(pool,owner,{request_id:uid(),provider:channel,amount_fen:10000},[provider]);
  await applyVerifiedPayment(pool,provider,receipts.get(order.order_id)!);
  return requestPaymentRefund(pool,owner,order.order_id,{request_id:uid(),amount_fen:2500},[provider]);
 };
 try{
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'refund_facts_'+owner.slice(0,8)]);
  await refund('2026-01-31T15:59:59.000Z');await refund('2026-01-31T16:00:00.000Z');
  const known=await read(),jan=known.months[0],feb=known.months[1];
  assert.equal(jan.verified_payer_cash_fen,'20000');assert.equal(jan.cash_refunded_fen,'2500');assert.equal(jan.net_payer_cash_flow_fen,'17500');
  assert.equal(feb.verified_payer_cash_fen,'0');assert.equal(feb.cash_refunded_fen,'2500');assert.equal(feb.net_payer_cash_flow_fen,'-2500');
  assert.equal(known.months[10].cash_refunded_fen,'0','Late local settlement must not create November cash outflow');
  const missing=await refund(),unknown=await read();
  assert.deepEqual(unknown.unallocated_cash_refunds,{events:'1',amount_fen:'2500',refund_ids:[missing.refund_id]});
  assert.equal(unknown.months[0].cash_refunded_fen_known,'2500');assert.equal(unknown.months[1].cash_refunded_fen_known,'2500');
  for(const m of unknown.months){assert.equal(m.cash_refunded_fen,null);assert.equal(m.net_payer_cash_flow_fen,null);}
  const beforeRecovery=await snapshot(true),receipt={...refundReceipts.get(missing.refund_id)!,providerSucceededAt:'2026-02-02T01:00:00.000Z'};
  refundReceipts.set(missing.refund_id,receipt);
  await refreshPaymentRefund(pool,owner,missing.refund_id,[provider]);await applyVerifiedRefund(pool,provider,receipt);
  await refreshPaymentRefund(pool,owner,missing.refund_id,[provider]);
  assert.deepEqual(await snapshot(true),beforeRecovery,'Terminal date enrichment and callback replay must not move money or replay events');
  const enriched=await read();
  assert.deepEqual(enriched.unallocated_cash_refunds,{events:'0',amount_fen:'0',refund_ids:[]});
  assert.equal(enriched.months[0].cash_refunded_fen,'2500');assert.equal(enriched.months[0].net_payer_cash_flow_fen,'27500');
  assert.equal(enriched.months[1].cash_refunded_fen,'5000');assert.equal(enriched.months[1].net_payer_cash_flow_fen,'-5000');
  assert.equal(enriched.months[10].cash_refunded_fen,'0');assert.equal(creates,3);assert.equal(queries,1);
  assert.deepEqual((await pool.query("SELECT count(*)::text events,sum(cash_refunded_fen)::text cash FROM bb_payment_refund_events WHERE owner_user_id=$1 AND kind='succeeded'",[owner])).rows[0],{events:'3',cash:'7500'});
 }finally{await pool.end();}
});
