import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {Pool} from 'pg';
import {uid,transaction} from './data.js';
import {grantCredits,creditBalance} from './billing.js';
import {auditCredits} from './billing-ops.js';
import {isolatedTestDatabase} from './test-database.js';
import {applyVerifiedPayment,type PaymentProvider} from './payments.js';
import {requestPaymentRefund,refreshPaymentRefund,type VerifiedRefund} from './payment-refunds.js';
import {reconcilePendingPayments} from './payment-reconciliation.js';
import {enqueuePaymentStatement,reconcileDailyStatements} from './payment-statements.js';
import {normalizeAlipayStatementDocuments} from './alipay-statements-format.js';
import type {VerifiedAlipayStatement} from './alipay-statements.js';

const database=await isolatedTestDatabase(undefined,'alipay-normalized-statements');
const day='2026-10-27',nextDay='2026-10-28',appId='2021000000000000';
const manualNow=new Date('2026-10-30T01:00:00Z');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const iso=(date:string,hour='12:00:00')=>new Date(date+'T'+hour+'+08:00').toISOString();
type Row={kind:'payment'|'refund';orderId:string;transactionId:string;refundId?:string;local?:string;amount?:bigint;received?:bigint;discount?:bigint;fee?:bigint;negative?:boolean};
const money=(fen:bigint)=>{const negative=fen<0n,amount=negative?-fen:fen;return (negative?'-':'')+(amount/100n).toString()+'.'+(amount%100n).toString().padStart(2,'0');};
function detail(rows:Row[],date:string){
  const totals={payment:{count:0,received:0n,discount:0n},refund:{count:0,received:0n,discount:0n}};
  const body=rows.map(row=>{
    const amount=row.amount??(row.kind==='payment'?10000n:2500n),discount=row.discount??0n,received=row.received??amount-discount;
    const sign=row.negative?-1n:1n,fee=row.fee??(row.kind==='payment'?60n:-15n),group=totals[row.kind];
    group.count++;group.received+=received;group.discount+=discount;
    return [row.transactionId,row.orderId,row.kind==='payment'?'交易':'退款',row.local??date+(row.kind==='payment'?' 12:00:00':' 13:00:00'),
      money(sign*amount),money(sign*received),money(sign*discount),money(fee),row.refundId??''].join(',');
  });
  return ['支付宝交易号,商家订单号,业务类型,完成时间,订单金额（元）,商家实收（元）,商家优惠,服务费,退款批次号',...body,
    `#交易合计：${totals.payment.count}笔,商家实收共${money(totals.payment.received)}元,商家优惠共${money(totals.payment.discount)}元`,
    `#退款合计：${totals.refund.count}笔,商家实收退款共${money(totals.refund.received)}元,商家优惠退款共${money(totals.refund.discount)}元`].join('\n')+'\n';
}
function download(merchant:string,source:string,date=day):VerifiedAlipayStatement{
  // Complete synthetic CSV through the real normalizer; the signed-download
  // boundary is supplied by a fake adapter and tested separately with RSA2.
  const digest=hash(source);
  return {provider:'alipay',merchantId:merchant,requestAppId:appId,billDate:date,kind:'trade',accountType:null,
    availability:'available',sha1:null,sha256:digest,byteLength:Buffer.byteLength(source),verifiedAt:manualNow.toISOString(),
    evidence:{kind:'alipay_rsa2_download_url',signedResponseSha256:hash('synthetic signed response '+digest),downloadSha256:digest,
      signedUrlMerchantId:merchant,requestedBillDate:date,requestBillType:'trade'},
    documents:[{nameSha256:hash('synthetic.csv'),sha256:digest,byteLength:Buffer.byteLength(source),encoding:'utf-8',lineCount:source.split('\n').length-1}],
    ...normalizeAlipayStatementDocuments([{text:source}],date)};
}
const financialTables=['bb_credit_accounts','bb_credit_lots','bb_credit_quotes','bb_credit_reservations','bb_credit_allocations','bb_credit_events',
  'bb_recharge_orders','bb_payment_cash_proofs','bb_payment_refunds','bb_payment_refund_events','bb_payment_refund_allocations',
  'bb_subscriptions','bb_subscription_periods','bb_subscription_actions','bb_task_refund_units','bb_task_refund_unit_slices',
  'bb_task_refund_requests','bb_task_refund_request_items','bb_task_refund_decisions','bb_task_refund_returned_items','bb_task_refund_credits','bb_outbox'] as const;
async function financialSnapshot(pool:Pool,omitRefundTimes=false){
  const output:Record<string,string>={};
  for(const table of financialTables){
    const value=table==='bb_payment_refunds'&&omitRefundTimes?"to_jsonb(t)-ARRAY['provider_created_at','provider_succeeded_at','next_reconcile_at','reconcile_attempts']":"to_jsonb(t)";
    output[table]=(await pool.query(`SELECT COALESCE(jsonb_agg(${value} ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text snapshot FROM ${table} t`)).rows[0].snapshot;
  }
  return output;
}
async function setup(){
  const pool=new Pool({connectionString:database}),owner=uid(),merchant='2088'+BigInt('0x'+uid().replaceAll('-','').slice(0,9)).toString().padStart(12,'0');
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'alipay_normal_'+owner.slice(0,8)]);
  const channel=new Map<string,VerifiedRefund>();let creates=0,queries=0,recoveries=0,queryFailure=false,refundTime:string|undefined=iso(day,'13:00:00');
  const provider:PaymentProvider={name:'alipay',merchantId:merchant,statementAppId:appId,statementKinds:['trade'],statementAccounts:[],acknowledgement:'success',
    create:async()=>{throw Error('No merchant checkout');},query:async()=>{throw Error('No merchant payment query');},verifyCallback:async()=>{throw Error('No merchant callback');},
    refunds:{create:async r=>{
      creates++;const result:VerifiedRefund={refundId:r.id,orderId:r.order_id,merchantId:r.merchant_id,transactionId:r.provider_transaction_id,
        providerRefundId:'alipay_'+hash(JSON.stringify([r.provider_transaction_id,r.id])),currency:'CNY',orderAmountFen:r.order_amount_fen,
        amountFen:r.amount_fen,payerTotalFen:r.order_amount_fen,payerRefundFen:r.amount_fen,state:'succeeded',...(refundTime?{providerSucceededAt:refundTime}:{})};
      channel.set(r.id,result);return result;},
      query:async r=>{queries++;if(queryFailure)throw Error('Synthetic query timeout');return channel.get(r.id)!;},
      recoverSameRequest:async()=>{recoveries++;throw Error('Terminal proof must not resubmit a refund');},verifyCallback:async()=>{throw Error('No callback');}}};
  const seed=async(options:{date?:string;time?:string|null;cash?:number;amount?:bigint}={}):Promise<Row>=>{
    const orderId=uid().replaceAll('-',''),transactionId='trade_'+orderId,amount=options.amount??10000n,date=options.date??day;
    await pool.query(`INSERT INTO bb_recharge_orders(id,owner_user_id,request_id,request_hash,provider,pack_id,pack_version,amount_fen,points,currency,merchant_id,expires_at)
      VALUES($1,$2,$1,$3,'alipay','service_balance','synthetic-alipay-normalized',$4,10000,'CNY',$5,now()+interval '30 minutes')`,[orderId,owner,'a'.repeat(64),amount.toString(),merchant]);
    if(amount<=BigInt(Number.MAX_SAFE_INTEGER))await applyVerifiedPayment(pool,provider,{orderId,merchantId:merchant,amountFen:Number(amount),currency:'CNY',transactionId,state:'paid',
      ...(options.time===null?{}:{paidAt:options.time??iso(date)}),payerCash:{amountFen:options.cash??Number(amount),currency:'CNY'}});
    else{
      // Synthetic historical bigint record, not an allowed checkout or invented
      // cash receipt. Preserve the real grant ledger and expose missing cash proof.
      await pool.query("UPDATE bb_recharge_orders SET state='paid',provider_txn_id=$2,provider_paid_at=$3,credited_at=now() WHERE id=$1",[orderId,transactionId,iso(date)]);
      await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:'recharge:'+orderId,points:10000,expiresAt:null,actor:'synthetic',reason:'Historical exact statement fixture'}));
    }
    return {kind:'payment',orderId,transactionId,amount};
  };
  const refund=async(original:Row,time:string|null=iso(day,'13:00:00')):Promise<Row>=>{
    refundTime=time??undefined;const value=await requestPaymentRefund(pool,owner,original.orderId,{request_id:uid(),amount_fen:2500},[provider]);
    return {kind:'refund',orderId:original.orderId,transactionId:original.transactionId,refundId:value.refund_id};
  };
  return {pool,owner,merchant,provider,seed,refund,channel,counts:()=>({creates,queries,recoveries}),setQueryFailure:(value:boolean)=>{queryFailure=value;}};
}
type Harness=Awaited<ReturnType<typeof setup>>;
async function check(h:Harness,date:string,rows:Row[]=[],override?:VerifiedAlipayStatement){
  const statement=override??download(h.merchant,detail(rows,date),date);h.provider.downloadStatements=async()=>statement;
  await h.pool.query("UPDATE bb_payment_statement_jobs SET next_attempt_at=now()+interval '1 day' WHERE merchant_id=$1 AND bill_date<>$2",[h.merchant,date]);
  await enqueuePaymentStatement(h.pool,h.provider,{billDate:date,kind:'trade'});
  const job=(await h.pool.query("UPDATE bb_payment_statement_jobs SET next_attempt_at=now()-interval '1 minute' WHERE merchant_id=$1 AND bill_date=$2 AND kind='trade' RETURNING id",[h.merchant,date])).rows[0].id;
  const result=await reconcileDailyStatements(h.pool,[h.provider],{now:manualNow,limit:1});assert.equal(result.checked,1);
  const state=(await h.pool.query('SELECT * FROM bb_payment_statement_jobs WHERE id=$1',[job])).rows[0];
  const issues=(await h.pool.query('SELECT kind,reference_id,unit,expected_value::text,observed_value::text FROM bb_payment_statement_differences WHERE check_id=$1 ORDER BY kind,reference_id,line_no',[state.last_check_id])).rows;
  return {job,result,state,issues,statement};
}

test('normalized Alipay payment/refund CSV reconciles without treating merchant receipts as buyer cash or writing financial tables',{skip:!database},async()=>{
  const h=await setup();try{
    const original=await h.seed(),refund=await h.refund(original),discounted=await h.seed({cash:8000});
    const before=await financialSnapshot(h.pool),checked=await check(h,day,[original,{...refund,negative:true},{...discounted,received:9500n,discount:500n}]);
    assert.deepEqual(checked.result,{checked:1,completed:1,unknown:0});assert.deepEqual(checked.issues,[]);
    const evidence=(await h.pool.query('SELECT evidence_key,verification_context,totals FROM bb_payment_statements WHERE job_id=$1',[checked.job])).rows[0];
    assert.equal(evidence.evidence_key,checked.statement.sha256+':alipay-trade-cn-v1');assert.equal(evidence.totals.refund.amountFen,'2500');
    const entry=(await h.pool.query("SELECT payload FROM bb_payment_statement_entries WHERE statement_id=(SELECT id FROM bb_payment_statements WHERE job_id=$1) AND kind='refund'",[checked.job])).rows[0].payload;
    assert.equal(entry.sourceAmounts.amountFen,'-2500');assert.equal(entry.amountFen,'2500');assert.equal('appId' in entry,false);assert.equal('payerCashFen' in entry,false);
    assert.deepEqual(await financialSnapshot(h.pool),before);assert.equal((await auditCredits(h.pool,h.owner)).consistent,true);
  }finally{await h.pool.end();}
});

test('Alipay amount/identity mismatches and unregistered PID rows cannot suppress registered local missing coverage',{skip:!database},async()=>{
  const h=await setup();try{
    const amount=await h.seed(),identity=await h.seed(),original=await h.seed(),refund=await h.refund(original),missing=await h.seed();
    const unknown:Row={kind:'payment',orderId:'unregistered_order',transactionId:'unregistered_trade'};
    const before=await financialSnapshot(h.pool),{result,issues}=await check(h,day,[{...amount,amount:9999n},{...identity,transactionId:'different_trade'},
      {...refund,transactionId:'different_refund_trade'},unknown]);
    assert.equal(result.completed,1);assert.equal(result.unknown,0);
    for(const [kind,id] of [['alipay_payment_nominal',amount.orderId],['alipay_payment_identity',identity.orderId],
      ['alipay_refund_identity',refund.refundId!],['alipay_payment_without_registered_order',unknown.orderId],
      ['alipay_local_payment_missing_from_statement',missing.orderId],['alipay_local_refund_missing_from_statement',refund.refundId!]] as const)
      assert.ok(issues.some(i=>i.kind===kind&&i.reference_id===id),kind);
    for(const row of [amount,identity])assert.ok(issues.some(i=>i.kind==='alipay_local_payment_missing_from_statement'&&i.reference_id===row.orderId));
    assert.deepEqual(await financialSnapshot(h.pool),before);
  }finally{await h.pool.end();}
});

test('Alipay refund coverage follows completion day across midnight and detects a genuinely omitted local completion',{skip:!database},async()=>{
  const h=await setup();try{
    const original=await h.seed(),refund=await h.refund(original,iso(nextDay,'00:01:00')),before=await financialSnapshot(h.pool);
    assert.deepEqual((await check(h,day,[original])).issues,[]);
    const omitted=await check(h,nextDay);assert.ok(omitted.issues.some(i=>i.kind==='alipay_local_refund_missing_from_statement'&&i.reference_id===refund.refundId));
    const corrected=await check(h,nextDay,[{...refund,local:nextDay+' 00:01:00'}]);assert.deepEqual(corrected.issues,[]);
    assert.deepEqual(await financialSnapshot(h.pool),before);
  }finally{await h.pool.end();}
});

test('missing authenticated payment/refund time stays unknown instead of borrowing CSV or local timestamps',{skip:!database},async()=>{
  const h=await setup();try{
    const original=await h.seed({time:null}),refund=await h.refund(original,null),before=await financialSnapshot(h.pool);
    const checked=await check(h,day,[original,refund]);assert.deepEqual(checked.result,{checked:1,completed:0,unknown:1});
    assert.ok(checked.issues.some(i=>i.kind==='alipay_payment_time_uncovered'));assert.ok(checked.issues.some(i=>i.kind==='alipay_refund_time_uncovered'));
    assert.equal(checked.issues.some(i=>i.kind.includes('missing_from_statement')),false);
    assert.deepEqual(await financialSnapshot(h.pool),before);assert.ok(checked.state.next_attempt_at>checked.state.updated_at);
  }finally{await h.pool.end();}
});

test('duplicate Alipay records remain unresolved and parser-version evidence preserves earlier same-archive unknown history',{skip:!database},async()=>{
  const h=await setup();try{
    const original=await h.seed(),before=await financialSnapshot(h.pool);
    const duplicate=await check(h,day,[original,original]);assert.equal(duplicate.result.unknown,1);assert.equal(duplicate.statement.normalization.status,'unresolved');
    const valid=download(h.merchant,detail([original],day));assert.equal(valid.normalization.status,'normalized');
    const old:VerifiedAlipayStatement={...valid,normalization:{status:'unresolved',reasons:['ALIPAY_CSV_FORMAT_UNVERIFIED']},entries:[],totals:null};
    await check(h,day,[],old);const repaired=await check(h,day,[],valid);assert.deepEqual(repaired.issues,[]);assert.equal(repaired.result.completed,1);
    const evidence=(await h.pool.query('SELECT evidence_key,totals FROM bb_payment_statements WHERE job_id=$1 AND sha256=$2 ORDER BY evidence_key',[repaired.job,valid.sha256])).rows;
    assert.equal(evidence.length,2);assert.equal(evidence[0].evidence_key,valid.sha256);assert.equal(evidence[0].totals,null);
    assert.equal(evidence[1].evidence_key,valid.sha256+':alipay-trade-cn-v1');assert.equal(evidence[1].totals.payment.count,1);
    assert.deepEqual(await financialSnapshot(h.pool),before);
  }finally{await h.pool.end();}
});

test('Alipay statement differences preserve adjacent bigint fen above 2^53 and never repair a historical balance',{skip:!database},async()=>{
  const h=await setup();try{
    const value=9007199254740992n,original=await h.seed({amount:value+1n}),before=await financialSnapshot(h.pool);
    const {issues}=await check(h,day,[{...original,amount:value}]);
    assert.deepEqual(issues.find(i=>i.kind==='alipay_payment_nominal'),{kind:'alipay_payment_nominal',reference_id:original.orderId,unit:'cny_fen',expected_value:(value+1n).toString(),observed_value:value.toString()});
    assert.ok(issues.some(i=>i.kind==='alipay_local_payment_missing_from_statement'));
    assert.deepEqual(await financialSnapshot(h.pool),before);
  }finally{await h.pool.end();}
});

test('late authenticated Alipay payment/refund completion reopens its old bill without rewriting earlier checks or settling twice',{skip:!database},async()=>{
  const h=await setup(),oldDay='2026-10-09';try{
    const empty=await check(h,oldDay);assert.equal(empty.result.completed,1);
    const original=await h.seed({date:oldDay});
    assert.equal((await h.pool.query('SELECT state FROM bb_payment_statement_jobs WHERE id=$1',[empty.job])).rows[0].state,'pending','First authenticated payment date reopens its old bill');
    const paid=await check(h,oldDay,[original]);assert.deepEqual(paid.issues,[]);
    const refund=await h.refund(original,null);assert.equal((await h.pool.query('SELECT state FROM bb_payment_statement_jobs WHERE id=$1',[paid.job])).rows[0].state,'complete');
    const before=await financialSnapshot(h.pool,true),receipt=h.channel.get(refund.refundId!)!;
    h.channel.set(refund.refundId!,{...receipt,providerSucceededAt:iso(oldDay,'13:00:00')});
    await refreshPaymentRefund(h.pool,h.owner,refund.refundId!,[h.provider]);
    assert.equal((await h.pool.query('SELECT state FROM bb_payment_statement_jobs WHERE id=$1',[paid.job])).rows[0].state,'pending');
    const checked=await check(h,oldDay,[original,refund]);assert.deepEqual(checked.issues,[]);assert.equal(checked.result.completed,1);
    assert.equal((await h.pool.query('SELECT count(*)::int n FROM bb_payment_statement_checks WHERE job_id=$1',[paid.job])).rows[0].n,3);
    assert.equal((await h.pool.query('SELECT provider_created_at FROM bb_payment_refunds WHERE id=$1',[refund.refundId])).rows[0].provider_created_at,null,'Alipay completion does not invent a WeChat-style application time');
    assert.deepEqual(await financialSnapshot(h.pool,true),before);assert.deepEqual(h.counts(),{creates:1,queries:1,recoveries:0});
  }finally{await h.pool.end();}
});

test('Alipay terminal date recovery uses bounded query retries without creating another refund or moving cash again',{skip:!database,timeout:120000},async()=>{
  const h=await setup();try{
    const original=await h.seed(),refund=await h.refund(original,null),before=await financialSnapshot(h.pool,true);
    await assert.rejects(()=>refreshPaymentRefund(h.pool,uid(),refund.refundId!,[h.provider]),(e:any)=>e.status===404);
    assert.equal(h.counts().queries,0);h.setQueryFailure(true);
    await new Promise(resolve=>setTimeout(resolve,31000));
    const due=()=>h.pool.query("UPDATE bb_payment_refunds SET next_reconcile_at=now()-interval '1 minute' WHERE id=$1",[refund.refundId]);
    await due();assert.equal((await reconcilePendingPayments(h.pool,[h.provider])).unknown,1);
    assert.equal((await reconcilePendingPayments(h.pool,[h.provider])).refunds_checked,0);
    h.setQueryFailure(false);h.channel.set(refund.refundId!,{...h.channel.get(refund.refundId!)!,providerSucceededAt:iso(day,'13:00:00')});
    await due();const completed=await reconcilePendingPayments(h.pool,[h.provider]);assert.equal(completed.refunds_checked,1);assert.equal(completed.unknown,0);
    await due();assert.equal((await reconcilePendingPayments(h.pool,[h.provider])).refunds_checked,0);
    assert.deepEqual(h.counts(),{creates:1,queries:2,recoveries:0});assert.deepEqual(await creditBalance(h.pool,h.owner),{available:7500,frozen:0});
    assert.deepEqual(await financialSnapshot(h.pool,true),before);assert.equal((await auditCredits(h.pool,h.owner)).consistent,true);
  }finally{await h.pool.end();}
});
