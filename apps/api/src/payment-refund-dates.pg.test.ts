import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {Pool} from 'pg';
import {isolatedTestDatabase} from './test-database.js';
import {uid} from './data.js';
import {auditCredits} from './billing-ops.js';
import {creditBalance} from './billing.js';
import {applyVerifiedPayment,type PaymentProvider} from './payments.js';
import {applyVerifiedRefund,requestPaymentRefund,refreshPaymentRefund,type RefundOrder,type VerifiedRefund} from './payment-refunds.js';
import {reconcilePendingPayments} from './payment-reconciliation.js';
import {enqueuePaymentStatement,reconcileDailyStatements} from './payment-statements.js';
import {parsePaymentStatement,type PaymentStatementRequest} from './payment-statements-format.js';
import {syntheticTradeStatement,tradeHeaders} from './test-payment-statements.js';

const database=process.env.BB_TEST_DATABASE_URL;
const applicationDay='2026-10-27',applicationAt='2026-10-27T05:00:00.000Z';
const successDay='2026-10-28',successAt='2026-10-28T01:00:00.000Z';
const paidAt='2026-10-27T04:00:00.000Z',appId='wx1234567890abcdef';
const manualNow=new Date('2026-10-29T01:00:00Z'); // 09:00 Shanghai: only explicitly queued statements.
type Seed={orderId:string;transactionId:string;refundId:string;providerRefundId:string};
type ReceiptOptions={state?:VerifiedRefund['state'];createdAt?:string;successAt?:string;loseCreate?:boolean;paidAt?:string};

async function setup(){
  const connection=await isolatedTestDatabase(undefined,'refund-dates-'+uid());
  const pool=new Pool({connectionString:connection}),owner=uid(),merchant='synthetic_'+uid();
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'refund_dates_'+owner.slice(0,8)]);
  const channel=new Map<string,VerifiedRefund>();
  let creates=0,queries=0,recoveries=0,queryFails=false,next:ReceiptOptions={};
  const receipt=(r:RefundOrder):VerifiedRefund=>({refundId:r.id,orderId:r.order_id,merchantId:r.merchant_id,
    transactionId:r.provider_transaction_id,providerRefundId:'wx_'+r.id,currency:'CNY',orderAmountFen:r.order_amount_fen,
    amountFen:r.amount_fen,payerTotalFen:r.order_amount_fen,payerRefundFen:r.amount_fen,state:next.state??'processing',
    ...(next.state==='failed'?{failureCode:'CLOSED'}:{}),...(next.createdAt?{providerCreatedAt:next.createdAt}:{}),
    ...(next.successAt?{providerSucceededAt:next.successAt}:{})});
  // Synthetic normalized receipts test the persistence boundary. Adapter signature/date
  // parsing is tested separately; this harness cannot contact a real payment provider.
  const provider:PaymentProvider={name:'wechat',merchantId:merchant,statementAppId:appId,statementKinds:['trade'],acknowledgement:{},
    create:async()=>{throw Error('No external checkout');},query:async()=>{throw Error('No external payment query');},
    verifyCallback:async()=>{throw Error('No external callback');},refunds:{
      create:async r=>{creates++;const result=receipt(r);channel.set(r.id,result);if(next.loseCreate)throw Error('Synthetic accepted refund response lost');return result;},
      query:async r=>{queries++;if(queryFails)throw Error('Synthetic query unavailable');const result=channel.get(r.id);assert.ok(result);return result;},
      recoverSameRequest:async()=>{recoveries++;throw Error('Terminal enrichment must never resubmit a refund');},
      verifyCallback:async()=>{throw Error('No external refund callback');}}};
  async function seed(options:ReceiptOptions={}):Promise<Seed>{
    next=options;const orderId=uid().replaceAll('-',''),transactionId='txn_'+orderId;
    await pool.query(`INSERT INTO bb_recharge_orders(id,owner_user_id,request_id,request_hash,provider,pack_id,pack_version,amount_fen,points,currency,merchant_id,expires_at)
      VALUES($1,$2,$1,$3,'wechat','service_balance','outcome-cny-20261028-v2',10000,10000,'CNY',$4,now()+interval '20 minutes')`,
      [orderId,owner,'a'.repeat(64),merchant]);
    await applyVerifiedPayment(pool,provider,{orderId,merchantId:merchant,amountFen:10000,currency:'CNY',transactionId,
      state:'paid',paidAt:options.paidAt??paidAt,payerCash:{amountFen:10000,currency:'CNY'}});
    const refund=await requestPaymentRefund(pool,owner,orderId,{request_id:uid(),amount_fen:2500},[provider]);
    return {orderId,transactionId,refundId:refund.refund_id,providerRefundId:'wx_'+refund.refund_id};
  }
  return {pool,owner,merchant,provider,channel,seed,counts:()=>({creates,queries,recoveries}),
    setQueryFailure:(value:boolean)=>{queryFails=value;},
    row:async(id:string)=>(await pool.query('SELECT * FROM bb_payment_refunds WHERE id=$1',[id])).rows[0],
    due:async(id:string)=>{await pool.query("UPDATE bb_payment_refunds SET next_reconcile_at=now()-interval '1 minute' WHERE id=$1",[id]);}};
}
type Harness=Awaited<ReturnType<typeof setup>>;
async function financialSnapshot(h:Harness){
  const snapshot:Record<string,string[]>={};
  for(const [table,key] of [['bb_credit_accounts','owner_user_id'],['bb_recharge_orders','id'],['bb_credit_lots','id'],
    ['bb_credit_events','id'],['bb_payment_cash_proofs','order_id'],['bb_payment_refund_events','id'],
    ['bb_payment_refund_allocations','refund_id,lot_id']] as const){
    snapshot[table]=(await h.pool.query('SELECT row_to_json(t)::text AS snapshot FROM '+table+' t WHERE owner_user_id=$1 ORDER BY '+key,[h.owner])).rows.map(r=>r.snapshot);
  }
  // Proof timestamps and reconciliation scheduling may change; financial identity,
  // state and completion time must stay identical during terminal enrichment.
  snapshot.refunds=(await h.pool.query(`SELECT (to_jsonb(r)-ARRAY['provider_created_at','provider_succeeded_at','updated_at','next_reconcile_at','reconcile_attempts'])::text snapshot
    FROM bb_payment_refunds r WHERE owner_user_id=$1 ORDER BY id`,[h.owner])).rows.map(r=>r.snapshot);
  snapshot.outbox=(await h.pool.query("SELECT row_to_json(o)::text snapshot FROM bb_outbox o ORDER BY id")).rows.map(r=>r.snapshot);
  return snapshot;
}
function parsed(h:Harness,request:PaymentStatementRequest,payments:Seed[],refunds:Array<Seed&{hour?:string;app?:string}>) {
  const rows:string[]=[];
  for(const seed of payments)rows.push(syntheticTradeStatement({merchant:h.merchant,appId,orderId:seed.orderId,
    transactionId:seed.transactionId,date:request.billDate}).split(/\r?\n/)[1]);
  for(const seed of refunds){
    let row=syntheticTradeStatement({merchant:h.merchant,appId:seed.app??appId,orderId:seed.orderId,transactionId:seed.transactionId,
      refundId:seed.refundId,providerRefundId:seed.providerRefundId,refund:true,date:request.billDate}).split(/\r?\n/)[2];
    if(seed.hour)row=row.replace(request.billDate+' 13:00:00',request.billDate+' '+seed.hour);
    rows.push(row);
  }
  const money=(fen:number)=>(fen/100).toFixed(2),p=payments.length,r=refunds.length;
  const source=[tradeHeaders,...rows,'总交易单数,应结订单总金额,退款总金额,充值券退款总金额,手续费总金额,订单总金额,申请退款总金额',
    [p+r,money(p*10000),money(r*2500),'0.00',money(p*60-r*15),money(p*10000),money(r*2500)].join(',')].join('\n')+'\n';
  return parsePaymentStatement(Buffer.from(source),{...request,merchantId:h.merchant,appId,
    sha1:createHash('sha1').update(source).digest('hex'),verifiedAt:manualNow.toISOString()});
}
async function check(h:Harness,billDate:string,payments:Seed[]=[],refunds:Array<Seed&{hour?:string;app?:string}>=[]){
  h.provider.downloadStatements=async request=>parsed(h,request,payments,refunds);
  await enqueuePaymentStatement(h.pool,h.provider,{billDate,kind:'trade'});
  const job=(await h.pool.query("SELECT id FROM bb_payment_statement_jobs WHERE provider='wechat' AND merchant_id=$1 AND bill_date=$2 AND kind='trade'",[h.merchant,billDate])).rows[0]?.id;
  assert.ok(job,'First authenticated application proof may already have queued this date');
  assert.deepEqual(await reconcileDailyStatements(h.pool,[h.provider],{now:manualNow}),{checked:1,completed:1,unknown:0});
  return (await h.pool.query(`SELECT d.kind,d.reference_id,d.unit FROM bb_payment_statement_differences d
    JOIN bb_payment_statement_jobs j ON j.last_check_id=d.check_id WHERE j.id=$1 ORDER BY d.kind,d.reference_id`,[job])).rows;
}
const invalid=(error:any)=>error?.code==='PAYMENT_INVALID';

test('callback success-only proof is enriched by terminal query without repeating refund or credit events',
  {skip:!database,timeout:120000},async()=>{
  const h=await setup();
  try{
    const seed=await h.seed({loseCreate:true});
    const callback={...h.channel.get(seed.refundId)!,state:'succeeded' as const,providerSucceededAt:successAt};
    await applyVerifiedRefund(h.pool,h.provider,callback);
    assert.equal((await h.row(seed.refundId)).provider_created_at,null);
    const before=await financialSnapshot(h);
    h.channel.set(seed.refundId,{...callback,providerCreatedAt:applicationAt});
    await Promise.all([refreshPaymentRefund(h.pool,h.owner,seed.refundId,[h.provider]),
      refreshPaymentRefund(h.pool,h.owner,seed.refundId,[h.provider]),applyVerifiedRefund(h.pool,h.provider,callback)]);
    const row=await h.row(seed.refundId);
    assert.equal(row.provider_created_at.toISOString(),applicationAt);assert.equal(row.provider_succeeded_at.toISOString(),successAt);
    assert.deepEqual(await financialSnapshot(h),before);
    assert.deepEqual(await creditBalance(h.pool,h.owner),{available:7500,frozen:0});
    assert.equal(h.counts().creates,1);assert.equal(h.counts().recoveries,0);
    assert.equal((await auditCredits(h.pool,h.owner)).consistent,true);
  }finally{await h.pool.end();}
});

test('channel dates reject conflicting identities, backwards time and database mutation without changing financial records',
  {skip:!database,timeout:120000},async()=>{
  const h=await setup();
  try{
    const seed=await h.seed({state:'succeeded',createdAt:applicationAt,successAt}),receipt=h.channel.get(seed.refundId)!;
    const before=await financialSnapshot(h);
    for(const changed of [{providerCreatedAt:'2026-10-27T05:01:00.000Z'},
      {providerSucceededAt:'2026-10-28T01:01:00.000Z'},{providerSucceededAt:'2026-10-26T01:00:00.000Z'},
      {merchantId:'other_merchant'},{orderId:uid()},{providerRefundId:'other_refund'},
      {state:'processing' as const,providerSucceededAt:successAt}])
      await assert.rejects(()=>applyVerifiedRefund(h.pool,h.provider,{...receipt,...changed}),invalid);
    for(const sql of ["provider_created_at=NULL","provider_succeeded_at=NULL",
      "provider_created_at=provider_created_at+interval '1 second'","provider_succeeded_at=provider_succeeded_at+interval '1 second'"])
      await assert.rejects(()=>h.pool.query('UPDATE bb_payment_refunds SET '+sql+' WHERE id=$1',[seed.refundId]),(e:any)=>e.code==='23514');
    assert.deepEqual(await financialSnapshot(h),before);
    const onlySuccess=await h.seed({state:'succeeded',successAt});
    await assert.rejects(()=>applyVerifiedRefund(h.pool,h.provider,{...h.channel.get(onlySuccess.refundId)!,providerCreatedAt:'2026-10-29T01:00:00.000Z'}),invalid);
    assert.equal((await h.row(onlySuccess.refundId)).provider_created_at,null,'Conflicting combined evidence does not partly persist');
    const processing=await h.seed({createdAt:applicationAt});
    await assert.rejects(()=>h.pool.query('UPDATE bb_payment_refunds SET provider_succeeded_at=$2 WHERE id=$1',[processing.refundId,successAt]),(e:any)=>e.code==='23514');
    assert.equal((await auditCredits(h.pool,h.owner)).consistent,true);
  }finally{await h.pool.end();}
});

test('first application-day bill detects missing accepted refunds in processing, closed and succeeded states',
  {skip:!database,timeout:120000},async()=>{
  const h=await setup();
  try{
    const processing=await h.seed({createdAt:applicationAt}),closed=await h.seed({state:'failed',createdAt:applicationAt}),
      succeeded=await h.seed({state:'succeeded',createdAt:applicationAt,successAt});
    const before=await financialSnapshot(h),issues=await check(h,applicationDay,[processing,closed,succeeded]);
    assert.deepEqual(issues.map(r=>[r.kind,r.reference_id]).sort(),[processing,closed,succeeded]
      .map(r=>['local_refund_missing_from_statement',r.refundId]).sort());
    assert.deepEqual(await financialSnapshot(h),before);
  }finally{await h.pool.end();}
});

test('refund reconciliation uses authenticated application day rather than success day or local completion time',
  {skip:!database,timeout:120000},async()=>{
  const h=await setup();
  try{
    const seed=await h.seed({state:'succeeded',createdAt:applicationAt,successAt}),before=await financialSnapshot(h);
    assert.notEqual((await h.row(seed.refundId)).completed_at.toISOString().slice(0,10),applicationDay);
    assert.deepEqual(await check(h,applicationDay,[seed],[seed]),[]);
    assert.deepEqual(await check(h,successDay),[],'No missing refund on a day which only contains its later success time');
    assert.deepEqual(await financialSnapshot(h),before);
  }finally{await h.pool.end();}
});

test('wrong application time or app cannot count as valid refund coverage, while legacy missing proof stays explicit',
  {skip:!database,timeout:120000},async()=>{
  const h=await setup();
  try{
    const timed=await h.seed({createdAt:applicationAt}),foreign=await h.seed({createdAt:applicationAt}),
      legacy=await h.seed({state:'succeeded',successAt});
    const before=await financialSnapshot(h),issues=await check(h,applicationDay,[timed,foreign,legacy],
      [{...timed,hour:'14:00:00'},{...foreign,app:'wx_other_application'}]);
    for(const row of [timed,foreign])assert.ok(issues.some(i=>i.kind==='local_refund_missing_from_statement'&&i.reference_id===row.refundId));
    assert.ok(issues.some(i=>i.unit==='identity'&&i.reference_id===timed.refundId),'Authenticated application time mismatch is explicit');
    assert.ok(issues.some(i=>i.kind==='other_application_or_trade'&&i.reference_id===foreign.refundId));
    assert.ok(issues.some(i=>i.kind==='refund_application_date_uncovered'&&i.reference_id===legacy.refundId));
    assert.deepEqual(await financialSnapshot(h),before);
  }finally{await h.pool.end();}
});

test('terminal proof refresh enforces owner and remains query-only when the channel is unavailable',
  {skip:!database,timeout:120000},async()=>{
  const h=await setup();
  try{
    const seed=await h.seed({state:'succeeded',successAt}),before=await financialSnapshot(h);
    await assert.rejects(()=>refreshPaymentRefund(h.pool,uid(),seed.refundId,[h.provider]),(e:any)=>e.status===404||e.statusCode===404||e.code==='NOT_FOUND');
    assert.equal(h.counts().queries,0,'Ownership rejection happens before any channel query');
    h.setQueryFailure(true);
    assert.equal((await refreshPaymentRefund(h.pool,h.owner,seed.refundId,[h.provider])).state,'succeeded');
    assert.deepEqual(h.counts(),{creates:1,queries:1,recoveries:0});
    assert.equal((await h.row(seed.refundId)).provider_created_at,null);
    assert.deepEqual(await financialSnapshot(h),before);
  }finally{await h.pool.end();}
});

test('background terminal proof recovery backs off unknown queries and enriches the original refund without new money movement',
  {skip:!database,timeout:120000},async()=>{
  const h=await setup();
  try{
    const seed=await h.seed({state:'succeeded',successAt}),before=await financialSnapshot(h);
    // Keep the terminal-row immutability trigger intact. Let the original local
    // completion age pass the production 30-second recovery gate once.
    await new Promise(resolve=>setTimeout(resolve,31000));
    await h.due(seed.refundId);h.setQueryFailure(true);
    const waiting=await reconcilePendingPayments(h.pool,[h.provider]);assert.equal(waiting.refunds_checked,1);assert.equal(waiting.unknown,1);
    const row=await h.row(seed.refundId);assert.ok(row.next_reconcile_at.getTime()>Date.now());assert.equal(row.reconcile_attempts,1);
    assert.equal((await reconcilePendingPayments(h.pool,[h.provider])).refunds_checked,0);
    h.setQueryFailure(false);h.channel.set(seed.refundId,{...h.channel.get(seed.refundId)!,providerCreatedAt:applicationAt});
    await h.due(seed.refundId);
    const done=await reconcilePendingPayments(h.pool,[h.provider]);assert.equal(done.refunds_checked,1);assert.equal(done.unknown,0);
    assert.equal((await h.row(seed.refundId)).provider_created_at.toISOString(),applicationAt);
    await h.due(seed.refundId);assert.equal((await reconcilePendingPayments(h.pool,[h.provider])).refunds_checked,0,'Complete terminal proof leaves the retry queue');
    assert.deepEqual(h.counts(),{creates:1,queries:2,recoveries:0});
    assert.deepEqual(await financialSnapshot(h),before);assert.equal((await auditCredits(h.pool,h.owner)).consistent,true);
  }finally{await h.pool.end();}
});

test('late application proof reopens an older completed bill and preserves its first check while detecting the missing refund',
  {skip:!database,timeout:120000},async()=>{
  const h=await setup(),historicalDay='2026-10-09',historicalAt=historicalDay+'T05:00:00.000Z';
  try{
    const seed=await h.seed({state:'succeeded',successAt,paidAt:historicalDay+'T04:00:00.000Z'});
    const first=await check(h,historicalDay,[seed]);
    assert.ok(first.some(i=>i.kind==='refund_application_date_uncovered'&&i.reference_id===seed.refundId));
    const job=async()=>(await h.pool.query("SELECT * FROM bb_payment_statement_jobs WHERE merchant_id=$1 AND bill_date=$2 AND kind='trade'",[h.merchant,historicalDay])).rows[0];
    const original=await job();assert.equal(original.state,'complete');
    const before=await financialSnapshot(h);
    h.channel.set(seed.refundId,{...h.channel.get(seed.refundId)!,providerCreatedAt:historicalAt});
    await refreshPaymentRefund(h.pool,h.owner,seed.refundId,[h.provider]);
    const reopened=await job();assert.equal(reopened.id,original.id);assert.equal(reopened.state,'pending');
    assert.equal(reopened.last_check_id,original.last_check_id,'Original check evidence remains available');
    assert.equal(reopened.lease_token,null);assert.equal(reopened.lease_until,null);
    assert.deepEqual(await check(h,historicalDay,[seed]),[{kind:'local_refund_missing_from_statement',reference_id:seed.refundId,unit:'coverage'}]);
    assert.equal((await h.pool.query('SELECT count(*)::int n FROM bb_payment_statement_checks WHERE job_id=$1',[original.id])).rows[0].n,2);
    assert.deepEqual(await financialSnapshot(h),before);
  }finally{await h.pool.end();}
});

test('application proof outside the channel retrieval window stays explicitly uncovered without an out-of-window download',
  {skip:!database,timeout:120000},async()=>{
  const h=await setup(),historicalDay='2026-06-01',day91='2026-07-30',day90='2026-07-31';
  try{
    const seed=await h.seed({state:'succeeded',createdAt:historicalDay+'T05:00:00.000Z',successAt,paidAt:historicalDay+'T04:00:00.000Z'});
    const outside=await h.seed({state:'succeeded',createdAt:day91+'T05:00:00.000Z',successAt,paidAt:day91+'T04:00:00.000Z'});
    const boundary=await h.seed({state:'succeeded',createdAt:day90+'T05:00:00.000Z',successAt,paidAt:day90+'T04:00:00.000Z'});
    // Keep the eligible boundary-day job outside this batch. The current bill
    // must use the scheduler's as-of date, not its own earlier billing date, to
    // report the 91-day gap and avoid reporting a 90-day gap prematurely.
    await h.pool.query("UPDATE bb_payment_statement_jobs SET next_attempt_at=now()+interval '1 day' WHERE merchant_id=$1 AND bill_date=$2",[h.merchant,day90]);
    const before=await financialSnapshot(h);
    const issues=await check(h,applicationDay);
    assert.deepEqual(issues,[seed,outside].map(row=>({kind:'refund_application_statement_window_uncovered',reference_id:row.refundId,unit:'coverage'})).sort((a,b)=>a.reference_id.localeCompare(b.reference_id)));
    assert.equal(issues.some(i=>i.reference_id===boundary.refundId),false,'The 90th day remains inside the retrieval window');
    const old=(await h.pool.query('SELECT state,attempts FROM bb_payment_statement_jobs WHERE merchant_id=$1 AND bill_date=ANY($2::date[])',[h.merchant,[historicalDay,day91,day90]])).rows;
    assert.equal(old.length,3);assert.ok(old.every(row=>row.state==='pending'&&row.attempts===0),'No out-of-window download or prematurely due boundary download');
    assert.deepEqual(await financialSnapshot(h),before);
  }finally{await h.pool.end();}
});
