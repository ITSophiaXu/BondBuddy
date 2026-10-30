import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {Pool} from 'pg';
import {uid} from './data.js';
import {isolatedTestDatabase} from './test-database.js';
import {applyVerifiedPayment,createServiceTopup,type PaymentProvider,type VerifiedPayment} from './payments.js';
import {applyVerifiedRefund,requestPaymentRefund,type VerifiedRefund} from './payment-refunds.js';
import {createSubscriptionCheckout,processDueSubscriptionCreditReleases} from './subscriptions.js';
import {enqueuePaymentStatement,reconcileDailyStatements} from './payment-statements.js';
import {parsePaymentStatement,type VerifiedPaymentStatement} from './payment-statements-format.js';
import {normalizeAlipayStatementDocuments} from './alipay-statements-format.js';
import {tradeHeaders} from './test-payment-statements.js';
import {auditCredits} from './billing-audit.js';
import {createSubscriptionChangeQuote,createSubscriptionChangeCheckout} from './subscription-changes.js';
import {subscriptionOrderPeriod} from './subscription-order-detail.js';
import {readSubscriptionFacts} from './subscription-facts-report.js';

const database=await isolatedTestDatabase(undefined,'annual-payment-statements');
const day='2026-10-27',paidAt=day+'T04:00:00.000Z',refundedAt=day+'T05:00:00.000Z';
const manualNow=new Date('2026-10-28T01:00:00.000Z');
const hash=(value:string,algorithm='sha256')=>createHash(algorithm).update(value).digest('hex');
const money=(value:number)=>`${Math.floor(value/100)}.${String(value%100).padStart(2,'0')}`;
type Channel='wechat'|'alipay';
type StatementRow={order:string;transaction:string;amount:number;refund?:string;providerRefund?:string};

function statement(channel:Channel,merchant:string,rows:StatementRow[]):VerifiedPaymentStatement{
 const payments=rows.filter(r=>!r.refund),refunds=rows.filter(r=>r.refund),total=(items:StatementRow[])=>items.reduce((s,r)=>s+r.amount,0);
 if(channel==='wechat'){
  const body=rows.map(r=>{
   const cells:Record<string,string>={'交易时间':day+(r.refund?' 13:00:00':' 12:00:00'),'公众账号ID':'wx1234567890abcdef','商户号':merchant,'特约商户号':'0',
    '微信订单号':r.transaction,'商户订单号':r.order,'交易类型':'NATIVE','交易状态':r.refund?'REFUND':'SUCCESS','付款银行':'SYNTHETIC','货币种类':'CNY',
    '应结订单金额':r.refund?'0.00':money(r.amount),'代金券金额':'0.00','微信退款单号':r.providerRefund??'0','商户退款单号':r.refund??'0',
    '退款金额':r.refund?money(r.amount):'0.00','充值券退款金额':'0.00','退款类型':r.refund?'ORIGINAL':'','退款状态':r.refund?'SUCCESS':'',
    '商品名称':'synthetic annual statement','手续费':'0.00','订单金额':r.refund?'0.00':money(r.amount),'申请退款金额':r.refund?money(r.amount):'0.00'};
   return tradeHeaders.split(',').map(key=>'`'+(cells[key]??'')).join(',');
  });
  const source=[tradeHeaders,...body,'总交易单数,应结订单总金额,退款总金额,充值券退款总金额,手续费总金额,订单总金额,申请退款总金额',
   [rows.length,money(total(payments)),money(total(refunds)),'0.00','0.00',money(total(payments)),money(total(refunds))].map(v=>'`'+v).join(',')].join('\r\n')+'\r\n';
  return parsePaymentStatement(Buffer.from(source),{billDate:day,kind:'trade',merchantId:merchant,appId:'wx1234567890abcdef',sha1:hash(source,'sha1'),verifiedAt:manualNow.toISOString()});
 }
 const source=['支付宝交易号,商家订单号,业务类型,完成时间,订单金额（元）,商家实收（元）,商家优惠,服务费,退款批次号',
  ...rows.map(r=>[r.transaction,r.order,r.refund?'退款':'交易',day+(r.refund?' 13:00:00':' 12:00:00'),money(r.amount),money(r.amount),'0.00','0.00',r.refund??''].join(',')),
  `#交易合计：${payments.length}笔,商家实收共${money(total(payments))}元,商家优惠共0.00元`,
  `#退款合计：${refunds.length}笔,商家实收退款共${money(total(refunds))}元,商家优惠退款共0.00元`].join('\n')+'\n';
 const digest=hash(source);
 // Synthetic adapter boundary plus real CSV normalization; no supplier call,
 // genuine merchant signature or real customer bill is claimed.
 return{provider:'alipay',merchantId:merchant,requestAppId:'2021000000000000',billDate:day,kind:'trade',accountType:null,availability:'available',
  sha1:null,sha256:digest,byteLength:Buffer.byteLength(source),verifiedAt:manualNow.toISOString(),
  evidence:{kind:'alipay_rsa2_download_url',signedResponseSha256:hash('synthetic '+digest),downloadSha256:digest,signedUrlMerchantId:merchant,requestedBillDate:day,requestBillType:'trade'},
  documents:[{nameSha256:hash('synthetic.csv'),sha256:digest,byteLength:Buffer.byteLength(source),encoding:'utf-8',lineCount:source.split('\n').length-1}],
  ...normalizeAlipayStatementDocuments([{text:source}],day)};
}
const financialTables=['bb_credit_lots','bb_credit_events','bb_recharge_orders','bb_payment_cash_proofs','bb_payment_refunds','bb_payment_refund_events',
 'bb_subscription_periods','bb_subscription_credit_releases','bb_subscription_changes','bb_subscription_change_allocations','bb_subscription_funding_sources','bb_subscription_lot_funding'] as const;
async function snapshot(pool:Pool,owner:string){
 const result:Record<string,string>={};
 for(const table of financialTables)result[table]=(await pool.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text value FROM ${table} t WHERE owner_user_id=$1`,[owner])).rows[0].value;
 return result;
}
async function setup(pool:Pool,channel:Channel){
 const owner=uid(),merchant=(channel==='alipay'?'2088':'19')+BigInt('0x'+uid().replaceAll('-','').slice(0,9)).toString().padStart(12,'0');
 await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'annual_stmt_'+owner.slice(0,8)]);
 await pool.query('INSERT INTO bb_statement_test_clock VALUES($1,$2)',[owner,paidAt]);
 const receipts=new Map<string,VerifiedPayment>(),refundReceipts=new Map<string,VerifiedRefund>(),rows:StatementRow[]=[];let refundCalls=0;
 const provider:PaymentProvider={name:channel,merchantId:merchant,statementAppId:channel==='wechat'?'wx1234567890abcdef':'2021000000000000',statementKinds:['trade'],
  acknowledgement:channel==='wechat'?{}:'success',
  create:async o=>{receipts.set(o.id,{orderId:o.id,merchantId:merchant,amountFen:o.amount_fen,currency:'CNY',state:'paid',transactionId:'synthetic_'+o.id,paidAt,payerCash:{amountFen:o.amount_fen,currency:'CNY'}});return{checkoutUrl:'https://synthetic.invalid/'+o.id};},
  query:async o=>receipts.get(o.id)!,verifyCallback:async()=>{throw Error('Synthetic only');},
  refunds:{create:async r=>{refundCalls++;const receipt:VerifiedRefund={refundId:r.id,orderId:r.order_id,merchantId:merchant,transactionId:r.provider_transaction_id,
    providerRefundId:channel==='alipay'?'alipay_'+hash(JSON.stringify([r.provider_transaction_id,r.id])):'synthetic_'+r.id,currency:'CNY',orderAmountFen:r.order_amount_fen,
    amountFen:r.amount_fen,payerTotalFen:r.order_amount_fen,payerRefundFen:r.amount_fen,state:'succeeded',providerSucceededAt:refundedAt,...(channel==='wechat'?{providerCreatedAt:refundedAt}:{})};
    refundReceipts.set(r.id,receipt);rows.push({order:r.order_id,transaction:r.provider_transaction_id,amount:r.amount_fen,refund:r.id,providerRefund:receipt.providerRefundId});return receipt;},
   query:async r=>refundReceipts.get(r.id)!,verifyCallback:async()=>{throw Error('Synthetic only');}},
  downloadStatements:async()=>statement(channel,merchant,rows)};
 const pay=async(orderId:string)=>{const receipt=receipts.get(orderId)!;await applyVerifiedPayment(pool,provider,receipt);rows.push({order:orderId,transaction:receipt.transactionId!,amount:receipt.amountFen});return receipt;};
 const buy=async(cycle:'monthly'|'annual'='annual',plan:'light'|'intensive'='light')=>{
  const result=await createSubscriptionCheckout(pool,owner,{request_id:uid(),plan_id:plan,provider:channel,billing_cycle:cycle},[provider]);await pay(result.order.order_id);return result;
 };
 const check=async()=>{
  await enqueuePaymentStatement(pool,provider,{billDate:day,kind:'trade'});
  const job=(await pool.query("UPDATE bb_payment_statement_jobs SET next_attempt_at=now()-interval '1 minute' WHERE provider=$1 AND merchant_id=$2 AND bill_date=$3 AND kind='trade' RETURNING id",[channel,merchant,day])).rows[0].id;
  const before=await snapshot(pool,owner),result=await reconcileDailyStatements(pool,[provider],{now:manualNow,limit:1});
  assert.deepEqual(result,{checked:1,completed:1,unknown:0});assert.deepEqual(await snapshot(pool,owner),before,'Statement checks must never mutate financial records');
  return (await pool.query('SELECT kind,expected_value::text,observed_value::text FROM bb_payment_statement_differences WHERE check_id=(SELECT last_check_id FROM bb_payment_statement_jobs WHERE id=$1) ORDER BY kind',[job])).rows;
 };
 return{owner,provider,buy,pay,check,refundReceipts,refundCalls:()=>refundCalls};
}

test('annual statements reconcile monthly issuance against one paid contract across both channels',{skip:!database,timeout:120000},async t=>{
 const pool=new Pool({connectionString:database});
 try{
  // This clock exists only in the private test clone. Contract/schedule dates
  // are never edited, and the service or shared template is never connected.
  await pool.query('CREATE TABLE bb_statement_test_clock(owner_user_id text PRIMARY KEY,observed_at timestamptz NOT NULL)');
  await pool.query("CREATE OR REPLACE FUNCTION bb_subscription_clock(p_owner text) RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT COALESCE((SELECT observed_at FROM bb_statement_test_clock WHERE owner_user_id=p_owner),date_trunc('milliseconds',now())) $$");
  for(const channel of ['wechat','alipay'] as const){
   await t.test(channel+': original monthly subscription and topup still reconcile',async()=>{
    const h=await setup(pool,channel);await h.buy('monthly');
    const topup=await createServiceTopup(pool,h.owner,{request_id:uid(),provider:channel,amount_fen:1000},[h.provider]);await h.pay(topup.order_id);
    assert.deepEqual(await h.check(),[]);assert.equal((await auditCredits(pool,h.owner)).consistent,true);
   });
   await t.test(channel+': first grant and all twelve annual releases produce no extra cash order or statement payment',async()=>{
    const h=await setup(pool,channel),paid=await h.buy();assert.equal(paid.order.points,252000);assert.deepEqual(await h.check(),[]);
    const schedule=(await pool.query('SELECT due_at FROM bb_subscription_credit_releases WHERE owner_user_id=$1 ORDER BY installment_index',[h.owner])).rows;
    await pool.query('UPDATE bb_statement_test_clock SET observed_at=$2 WHERE owner_user_id=$1',[h.owner,schedule.at(-1).due_at]);
    assert.equal((await processDueSubscriptionCreditReleases(pool,100,h.owner)).issued,11);assert.equal((await processDueSubscriptionCreditReleases(pool,100,h.owner)).issued,0);
    const facts=(await pool.query(`SELECT (SELECT count(*) FROM bb_recharge_orders WHERE owner_user_id=$1)::int orders,
      (SELECT count(*) FROM bb_payment_cash_proofs WHERE owner_user_id=$1)::int cash_proofs,
      (SELECT sum(cash_amount_fen) FROM bb_payment_cash_proofs WHERE owner_user_id=$1)::text cash_fen,
      (SELECT count(*) FROM bb_subscription_credit_releases WHERE owner_user_id=$1 AND state='issued')::int releases`,[h.owner])).rows[0];
    assert.deepEqual(facts,{orders:1,cash_proofs:1,cash_fen:'214920',releases:12});assert.deepEqual(await h.check(),[]);assert.equal((await auditCredits(pool,h.owner)).consistent,true);
   });
   await t.test(channel+': actual wrong first-grant quantity and source remain visible differences',async()=>{
    const h=await setup(pool,channel),paid=await h.buy(),key='recharge:'+paid.order.order_id,prefix=channel==='alipay'?'alipay_':'';
    // Deliberately corrupt only this synthetic clone's projection. No trigger
    // or constraint is disabled; reconciliation must detect, never repair it.
    await pool.query('UPDATE bb_credit_lots SET original_points=original_points+1 WHERE owner_user_id=$1 AND source_key=$2',[h.owner,key]);
    assert.deepEqual(await h.check(),[{kind:prefix+'original_credit_issuance',expected_value:'21000',observed_value:'21001'}]);
    await pool.query("UPDATE bb_credit_lots SET original_points=original_points-1,source='purchase' WHERE owner_user_id=$1 AND source_key=$2",[h.owner,key]);
    assert.deepEqual(await h.check(),[{kind:prefix+'subscription_contract_issuance',expected_value:null,observed_value:null}]);
    await pool.query("UPDATE bb_credit_lots SET source='subscription' WHERE owner_user_id=$1 AND source_key=$2",[h.owner,key]);
    assert.deepEqual(await h.check(),[]);assert.equal((await auditCredits(pool,h.owner)).consistent,true);
   });
   await t.test(channel+': largest annual refund reconciles whole cash once, removes first batch and cancels future grants',async()=>{
    const h=await setup(pool,channel),paid=await h.buy('annual','intensive'),input={request_id:uid(),amount_fen:1078920};
    const refund=await requestPaymentRefund(pool,h.owner,paid.order.order_id,input,[h.provider]);assert.equal(refund.state,'succeeded');
    await requestPaymentRefund(pool,h.owner,paid.order.order_id,input,[h.provider]);await applyVerifiedRefund(pool,h.provider,h.refundReceipts.get(refund.refund_id)!);
    assert.equal(h.refundCalls(),1);assert.deepEqual(await h.check(),[]);assert.deepEqual(await h.check(),[]);
    const facts=(await pool.query(`SELECT (SELECT count(*) FROM bb_payment_refunds WHERE owner_user_id=$1)::int refunds,
      (SELECT count(*) FROM bb_payment_refund_events WHERE owner_user_id=$1 AND kind='succeeded')::int cash_events,
      (SELECT sum(cash_refunded_fen) FROM bb_payment_refund_events WHERE owner_user_id=$1)::text refunded_fen,
      (SELECT sum(credit_points) FROM bb_payment_refunds WHERE owner_user_id=$1 AND state='succeeded')::text removed_points,
      (SELECT count(*) FROM bb_subscription_credit_releases WHERE owner_user_id=$1 AND state='cancelled')::int cancelled`,[h.owner])).rows[0];
    assert.deepEqual(facts,{refunds:1,cash_events:1,refunded_fen:'1078920',removed_points:'114000',cancelled:11});
    assert.equal((await processDueSubscriptionCreditReleases(pool,100,h.owner)).issued,0);assert.equal((await auditCredits(pool,h.owner)).consistent,true);
   });
   await t.test(channel+': consecutive upgrades reconcile only new cash and preserve source rights after the new annual refund',async()=>{
    const before=(await readSubscriptionFacts(pool,'2026-10','2026-10')).months[0];
    const h=await setup(pool,channel),original=await h.buy('monthly');
    const upgrade=async(cycle:'monthly'|'annual')=>{
     const {quote}=await createSubscriptionChangeQuote(pool,h.owner,{request_id:uid(),plan_id:'professional',billing_cycle:cycle});
     const input={request_id:uid(),quote_id:quote.quote_id,provider:channel};
     const checkout=await createSubscriptionChangeCheckout(pool,h.owner,input,[h.provider]);
     assert.equal((await createSubscriptionChangeCheckout(pool,h.owner,input,[h.provider])).order.order_id,checkout.order.order_id);
     await h.pay(checkout.order.order_id);return{quote,checkout};
    };
    const monthly=await upgrade('monthly');assert.equal(monthly.quote.credit_offset_fen,'19900');assert.equal(monthly.quote.pay_now_fen,'30000');
    assert.deepEqual(await h.check(),[]);
    const annual=await upgrade('annual');assert.equal(annual.quote.credit_offset_fen,'49900');assert.equal(annual.quote.pay_now_fen,'489020');
    assert.deepEqual(await h.check(),[]);assert.equal((await auditCredits(pool,h.owner)).consistent,true);
    assert.equal((await subscriptionOrderPeriod(pool,h.owner,original.order.order_id)).period?.status,'superseded');
    const detail=(await subscriptionOrderPeriod(pool,h.owner,annual.checkout.order.order_id)).period!;
    assert.equal(detail.funding_kind,'mixed');assert.equal(detail.face_amount_fen,'538920');assert.equal(detail.amount_fen,'489020');assert.equal(detail.monthly_points,'55000');
    const after=(await readSubscriptionFacts(pool,'2026-10','2026-10')).months[0];
    assert.equal(BigInt(after.verified_payer_cash_fen!)-BigInt(before.verified_payer_cash_fen!),538920n);
    assert.deepEqual(after.net_earned_order_consideration_fen,before.net_earned_order_consideration_fen,'Purchases and transfers are not task income');
    const input={request_id:uid(),amount_fen:489020};
    const refund=await requestPaymentRefund(pool,h.owner,annual.checkout.order.order_id,input,[h.provider]);assert.equal(refund.state,'succeeded');
    await requestPaymentRefund(pool,h.owner,annual.checkout.order.order_id,input,[h.provider]);
    assert.equal(h.refundCalls(),1);assert.deepEqual(await h.check(),[]);assert.equal((await auditCredits(pool,h.owner)).consistent,true);
    const restored=(await pool.query("SELECT COALESCE(sum(remaining-frozen),0)::text points FROM bb_credit_lots WHERE owner_user_id=$1 AND source_key LIKE 'subscription-change-restore:%'",[h.owner])).rows[0];
    assert.equal(restored.points,'55000');
    const refunded=(await readSubscriptionFacts(pool,'2026-10','2026-10')).months[0];
    assert.equal(BigInt(refunded.net_payer_cash_flow_fen!)-BigInt(before.net_payer_cash_flow_fen!),49900n);
   });
  }
 }finally{await pool.end();}
});
