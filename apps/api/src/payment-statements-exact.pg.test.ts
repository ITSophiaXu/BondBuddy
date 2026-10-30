import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {Pool} from 'pg';
import {isolatedTestDatabase} from './test-database.js';
import {transaction,uid} from './data.js';
import {grantCredits} from './billing.js';
import {auditCredits} from './billing-ops.js';
import {applyVerifiedPayment,type PaymentProvider} from './payments.js';
import {enqueuePaymentStatement,reconcileDailyStatements} from './payment-statements.js';
import {parsePaymentStatement,type PaymentStatementRequest,type VerifiedPaymentStatement} from './payment-statements-format.js';
import {syntheticTradeStatement,tradeHeaders,statementFixtureDate} from './test-payment-statements.js';

const database=await isolatedTestDatabase(undefined,'payment-statements-exact');
const manualNow=new Date('2026-10-28T01:00:00Z'); // 09:00 Shanghai, explicitly queued jobs only.
const paidAt='2026-10-27T04:00:00.000Z',appId='wx1234567890abcdef';
const aboveSafe=9007199254740992n,adjacent=aboveSafe+1n;
type BillRow={orderId:string;transactionId:string;appId?:string;tradeType?:string};
type Harness={pool:Pool;owner:string;merchant:string};
async function setup():Promise<Harness>{
  const pool=new Pool({connectionString:database}),owner=uid(),merchant='synthetic_'+uid();
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'statement_exact_'+owner.slice(0,8)]);
  return {pool,owner,merchant};
}
function provider(merchant:string):PaymentProvider{
  return {name:'wechat',merchantId:merchant,acknowledgement:{},
    create:async()=>{throw Error('No external checkout');},query:async()=>{throw Error('No external payment query');},
    verifyCallback:async()=>{throw Error('No external callback');}};
}
async function seed(h:Harness,options:{amount?:bigint;points?:bigint;lotPoints?:bigint;transactionId?:string;withoutPaidAt?:boolean}={}):Promise<BillRow>{
  const orderId=uid().replaceAll('-',''),transactionId=options.transactionId??'txn_'+orderId;
  const amount=options.amount??10000n,points=options.points??10000n,lotPoints=options.lotPoints??points;
  await h.pool.query("INSERT INTO bb_recharge_orders(id,owner_user_id,request_id,request_hash,provider,pack_id,pack_version,amount_fen,points,currency,merchant_id,expires_at) VALUES($1,$2,$1,$3,'wechat','service_balance','synthetic-exact-history',$4,$5,'CNY',$6,now()+interval '30 minutes')",
    [orderId,h.owner,'a'.repeat(64),amount.toString(),points.toString(),h.merchant]);
  if(amount===10000n&&points===10000n&&lotPoints===points){
    await applyVerifiedPayment(h.pool,provider(h.merchant),{orderId,merchantId:h.merchant,amountFen:10000,
      currency:'CNY',transactionId,state:'paid',...(options.withoutPaidAt?{}:{paidAt}),payerCash:{amountFen:10000,currency:'CNY'}});
  }else{
    // Synthetic persisted historical evidence, not a valid new checkout or cash proof.
    // Keep every DB constraint and the actual grant/lot ledger intact. Deliberate
    // order-vs-lot drift is the reconciliation condition under test.
    await h.pool.query("UPDATE bb_recharge_orders SET state='paid',provider_txn_id=$2,provider_paid_at=$3,credited_at=$3 WHERE id=$1",
      [orderId,transactionId,paidAt]);
    await transaction(h.pool,c=>grantCredits(c,{owner:h.owner,source:'purchase',key:'recharge:'+orderId,
      points:lotPoints.toString(),expiresAt:null,actor:'synthetic-test',reason:'historical statement precision fixture'}));
  }
  return {orderId,transactionId};
}
function parsed(rows:BillRow[],request:PaymentStatementRequest,merchant:string):VerifiedPaymentStatement{
  assert.equal(request.kind,'trade');
  const format=(fen:bigint)=>(fen/100n).toString()+'.'+(fen%100n).toString().padStart(2,'0');
  const body=rows.map(row=>{
    const source=syntheticTradeStatement({merchant,orderId:row.orderId,transactionId:row.transactionId,
      appId:row.appId??appId,date:request.billDate}).split(/\r?\n/);
    const cells=source[1].split(',');
    if(row.tradeType)cells[tradeHeaders.split(',').indexOf('交易类型')]=String.fromCharCode(96)+row.tradeType;
    return cells.join(',');
  });
  const count=BigInt(rows.length);
  const source=[tradeHeaders,...body,
    '总交易单数,应结订单总金额,退款总金额,充值券退款总金额,手续费总金额,订单总金额,申请退款总金额',
    [rows.length,format(10000n*count),'0.00','0.00',format(60n*count),format(10000n*count),'0.00'].join(',')].join('\n')+'\n';
  return parsePaymentStatement(Buffer.from(source),{...request,merchantId:merchant,appId,
    sha1:createHash('sha1').update(source).digest('hex'),verifiedAt:'2026-10-28T04:00:00.000Z'});
}
async function financialSnapshot(pool:Pool,owners:string[]){
  // Return raw JSON TEXT from PostgreSQL, preserving every bigint digit and all
  // financial columns; do not JSON.parse bigint-valued snapshots into Number.
  const result:Record<string,string[]>={};
  for(const [table,key] of [
    ['bb_credit_accounts','owner_user_id'],['bb_recharge_orders','id'],['bb_credit_lots','id'],
    ['bb_credit_events','id'],['bb_credit_reservations','id'],['bb_payment_cash_proofs','order_id'],
    ['bb_payment_refunds','id']
  ] as const){
    const rows=await pool.query('SELECT row_to_json(t)::text AS snapshot FROM '+table+' t WHERE owner_user_id=ANY($1::text[]) ORDER BY '+key,[owners]);
    result[table]=rows.rows.map(row=>row.snapshot);
  }
  const allocations=await pool.query('SELECT row_to_json(a)::text AS snapshot FROM bb_credit_allocations a JOIN bb_credit_reservations r ON r.id=a.reservation_id WHERE r.owner_user_id=ANY($1::text[]) ORDER BY a.reservation_id,a.lot_id',[owners]);
  result.bb_credit_allocations=allocations.rows.map(row=>row.snapshot);
  return result;
}
async function check(h:Harness,p:PaymentProvider){
  const job=await enqueuePaymentStatement(h.pool,p,{billDate:statementFixtureDate,kind:'trade'});
  assert.ok(job,'the fixture needs a new, distinct merchant job');
  assert.deepEqual(await reconcileDailyStatements(h.pool,[p],{now:manualNow}),{checked:1,completed:1,unknown:0});
  const issues=(await h.pool.query('SELECT d.kind,d.line_no,d.reference_id,d.unit,d.expected_value::text,d.observed_value::text FROM bb_payment_statement_differences d JOIN bb_payment_statement_jobs j ON j.last_check_id=d.check_id WHERE j.id=$1 ORDER BY d.kind,d.reference_id',[job])).rows;
  return {job,issues};
}

test('daily statement differences preserve adjacent DB bigints above 2^53 without repairing financial records',
  {skip:!database,timeout:120000},async()=>{
  const h=await setup(),p=provider(h.merchant);
  try{
    const amountA=await seed(h,{amount:aboveSafe}),amountB=await seed(h,{amount:adjacent});
    const issuance=await seed(h,{points:adjacent,lotPoints:aboveSafe});
    const before=await financialSnapshot(h.pool,[h.owner]),auditBefore=await auditCredits(h.pool,h.owner);
    assert.deepEqual(auditBefore.lotDrift,[]);assert.deepEqual(auditBefore.reservationDrift,[]);
    assert.deepEqual(auditBefore.refundDrift,[]);
    assert.deepEqual(auditBefore.paymentDrift.map(row=>row.id),[issuance.orderId],
      'the fixture has one explicit order/issuance mismatch, without disabling any ledger invariant');
    p.downloadStatements=async request=>parsed([amountA,amountB,issuance],request,h.merchant);
    const {issues}=await check(h,p);
    const byReference=(kind:string,id:string)=>issues.find(row=>row.kind===kind&&row.reference_id===id);
    assert.equal(byReference('payment_nominal',amountA.orderId)?.expected_value,aboveSafe.toString());
    assert.equal(byReference('payment_nominal',amountB.orderId)?.expected_value,adjacent.toString());
    assert.equal(byReference('payment_nominal',amountA.orderId)?.observed_value,'10000');
    assert.equal(byReference('payment_nominal',amountB.orderId)?.observed_value,'10000');
    assert.deepEqual(byReference('original_credit_issuance',issuance.orderId),
      {kind:'original_credit_issuance',line_no:4,reference_id:issuance.orderId,unit:'points',
        expected_value:adjacent.toString(),observed_value:aboveSafe.toString()});
    for(const row of [amountA,amountB])assert.ok(byReference('local_payment_missing_from_statement',row.orderId),
      'a mismatched amount cannot count as complete payment coverage');
    assert.deepEqual(await financialSnapshot(h.pool,[h.owner]),before);
    assert.deepEqual(await auditCredits(h.pool,h.owner),auditBefore);
  }finally{await h.pool.end();}
});

test('wrong app or trade type cannot suppress local payment missing coverage; a valid row still matches',
  {skip:!database,timeout:120000},async()=>{
  const h=await setup(),p=provider(h.merchant);
  try{
    const foreignApp=await seed(h),foreignType=await seed(h),valid=await seed(h);
    p.downloadStatements=async request=>parsed([{...foreignApp,appId:'wx_other_application'},
      {...foreignType,tradeType:'JSAPI'},valid],request,h.merchant);
    const before=await financialSnapshot(h.pool,[h.owner]),{issues}=await check(h,p);
    for(const row of [foreignApp,foreignType]){
      assert.ok(issues.some(issue=>issue.kind==='other_application_or_trade'&&issue.reference_id===row.orderId));
      assert.ok(issues.some(issue=>issue.kind==='local_payment_missing_from_statement'&&issue.reference_id===row.orderId));
    }
    assert.equal(issues.some(issue=>issue.reference_id===valid.orderId),false);
    assert.equal(issues.length,4);
    assert.deepEqual(await financialSnapshot(h.pool,[h.owner]),before);
    assert.equal((await auditCredits(h.pool,h.owner)).consistent,true);
  }finally{await h.pool.end();}
});

test('same-merchant owners reconcile separately while another merchant with the same transaction ID is never consumed',
  {skip:!database,timeout:120000},async()=>{
  const h=await setup(),p=provider(h.merchant),second=await setup(),foreign=await setup();
  const sameMerchant={...second,merchant:h.merchant},foreignProvider=provider(foreign.merchant);
  try{
    const a=await seed(h,{transactionId:'shared_txn_'+uid()}),b=await seed(sameMerchant);
    const other=await seed(foreign,{transactionId:a.transactionId});
    p.downloadStatements=async request=>parsed([a,b,other],request,h.merchant);
    const owners=[h.owner,second.owner,foreign.owner],before=await financialSnapshot(h.pool,owners);
    const {issues}=await check(h,p);
    assert.deepEqual(issues,[{kind:'channel_payment_without_order',line_no:4,reference_id:other.orderId,
      unit:'coverage',expected_value:null,observed_value:null}]);
    foreignProvider.downloadStatements=async request=>parsed([other],request,foreign.merchant);
    assert.deepEqual((await check(foreign,foreignProvider)).issues,[]);
    assert.deepEqual(await financialSnapshot(h.pool,owners),before);
    for(const owner of owners)assert.equal((await auditCredits(h.pool,owner)).consistent,true);
  }finally{await h.pool.end();await second.pool.end();await foreign.pool.end();}
});

test('unsafe normalized statement money remains unknown and rolls back evidence without changing the wallet',
  {skip:!database,timeout:120000},async()=>{
  const h=await setup(),p=provider(h.merchant);
  try{
    const row=await seed(h),before=await financialSnapshot(h.pool,[h.owner]);
    p.downloadStatements=async request=>{
      const statement=parsed([row],request,h.merchant);
      if(statement.provider!=='wechat')throw Error('fixture WeChat statement missing');
      assert.equal(statement.entries[0].kind,'payment');
      if(statement.entries[0].kind!=='payment')throw Error('fixture payment missing');
      statement.entries[0].nominalFen=Number.MAX_SAFE_INTEGER+1;
      return statement;
    };
    const job=await enqueuePaymentStatement(h.pool,p,{billDate:statementFixtureDate,kind:'trade'});
    assert.deepEqual(await reconcileDailyStatements(h.pool,[p],{now:manualNow}),{checked:1,completed:0,unknown:1});
    assert.equal((await h.pool.query('SELECT state FROM bb_payment_statement_jobs WHERE id=$1',[job])).rows[0].state,'unknown');
    assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM bb_payment_statements WHERE job_id=$1',[job])).rows[0].n,0);
    assert.deepEqual(await financialSnapshot(h.pool,[h.owner]),before);
    assert.equal((await auditCredits(h.pool,h.owner)).consistent,true);
  }finally{await h.pool.end();}
});

test('missing authenticated channel time remains uncovered despite a local credit timestamp and never repairs the wallet',
  {skip:!database,timeout:120000},async()=>{
  const h=await setup(),p=provider(h.merchant);
  try{
    // Historical authenticated receipts can omit success_time. Do not clear an
    // existing channel timestamp: migration 0140 correctly makes it immutable.
    const row=await seed(h,{withoutPaidAt:true});
    const order=(await h.pool.query('SELECT provider_paid_at,credited_at FROM bb_recharge_orders WHERE id=$1',[row.orderId])).rows[0];
    assert.equal(order.provider_paid_at,null);assert.ok(order.credited_at);
    p.downloadStatements=async request=>parsed([row],request,h.merchant);
    const before=await financialSnapshot(h.pool,[h.owner]),{issues}=await check(h,p);
    assert.deepEqual(issues,[{kind:'payment_channel_time_uncovered',line_no:2,reference_id:row.orderId,
      unit:'coverage',expected_value:null,observed_value:null}]);
    assert.deepEqual(await financialSnapshot(h.pool,[h.owner]),before);
    assert.equal((await h.pool.query('SELECT provider_paid_at FROM bb_recharge_orders WHERE id=$1',[row.orderId])).rows[0].provider_paid_at,null);
    assert.equal((await auditCredits(h.pool,h.owner)).consistent,true);
  }finally{await h.pool.end();}
});
