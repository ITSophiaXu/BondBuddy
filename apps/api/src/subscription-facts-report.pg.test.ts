import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {uid} from './data.js';
import {isolatedTestDatabase} from './test-database.js';
import {createSubscriptionCheckout} from './subscriptions.js';
import {createServiceTopup,applyVerifiedPayment,type PaymentProvider,type VerifiedPayment} from './payments.js';
import {readSubscriptionFacts} from './subscription-facts-report.js';
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
