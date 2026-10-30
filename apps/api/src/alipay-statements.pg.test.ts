import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {Pool} from 'pg';
import {isolatedTestDatabase} from './test-database.js';
import {uid} from './data.js';
import {creditBalance} from './billing.js';
import {auditCredits} from './billing-ops.js';
import {applyVerifiedPayment,type PaymentProvider,type VerifiedPayment} from './payments.js';
import {requestPaymentRefund,type VerifiedRefund} from './payment-refunds.js';
import {enqueuePaymentStatement,reconcileDailyStatements} from './payment-statements.js';
import type {VerifiedAlipayStatement} from './alipay-statements.js';

const database=await isolatedTestDatabase(undefined,'alipay-statements');
const billDate='2026-10-27',appId='2021000000000000';
const manualNow=new Date('2026-10-28T01:00:00Z'); // 09:00 Shanghai; only explicitly queued jobs run.
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const financialTables=[
  'bb_credit_accounts','bb_credit_lots','bb_credit_quotes','bb_credit_reservations','bb_credit_allocations','bb_credit_events',
  'bb_recharge_orders','bb_payment_cash_proofs','bb_payment_refunds','bb_payment_refund_events','bb_payment_refund_allocations',
  'bb_subscriptions','bb_subscription_periods','bb_subscription_actions',
  'bb_task_refund_units','bb_task_refund_unit_slices','bb_task_refund_requests','bb_task_refund_request_items',
  'bb_task_refund_decisions','bb_task_refund_returned_items','bb_task_refund_credits',
] as const;
async function financialSnapshot(pool:Pool):Promise<Record<string,string>>{
  const rows=await Promise.all(financialTables.map(async(table):Promise<[string,string]>=>[table,
    (await pool.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS snapshot FROM ${table} t`)).rows[0].snapshot]));
  return Object.fromEntries(rows);
}
async function setup(){
  const pool=new Pool({connectionString:database}),owner=uid();
  const merchant='2088'+BigInt('0x'+uid().replaceAll('-','').slice(0,9)).toString().padStart(12,'0');
  try{await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'alipay_statement_'+owner.slice(0,8)]);}
  catch(error){await pool.end();throw error;}
  return {pool,owner,merchant};
}
type Harness=Awaited<ReturnType<typeof setup>>;
function verifiedDownload(merchant:string,date=billDate):VerifiedAlipayStatement{
  // Synthetic adapter output only. No official CSV format or real signature is claimed.
  const source='synthetic bounded Alipay ZIP download '+merchant+' '+date,hash=digest(source),document='synthetic uninterpreted CSV';
  return {provider:'alipay',merchantId:merchant,requestAppId:appId,billDate:date,kind:'trade',accountType:null,
    availability:'available',sha1:null,sha256:hash,byteLength:Buffer.byteLength(source),verifiedAt:'2026-10-28T04:00:00Z',
    evidence:{kind:'alipay_rsa2_download_url',signedResponseSha256:digest('synthetic signed response '+merchant+' '+date),downloadSha256:hash,
      signedUrlMerchantId:merchant,requestedBillDate:date,requestBillType:'trade'},
    normalization:{status:'unresolved',reasons:['ALIPAY_CSV_FORMAT_UNVERIFIED']},
    documents:[{nameSha256:digest('synthetic.csv'),sha256:digest(document),byteLength:Buffer.byteLength(document),encoding:'utf-8',lineCount:1}],
    entries:[],totals:null};
}
const paid=(id:string,merchant:string):VerifiedPayment=>({orderId:id,merchantId:merchant,amountFen:10000,currency:'CNY',
  transactionId:'synthetic_alipay_'+id,state:'paid',paidAt:'2026-10-27T04:00:00Z',payerCash:{amountFen:10000,currency:'CNY'}});
function provider(merchant:string):PaymentProvider{
  return {name:'alipay',merchantId:merchant,statementAppId:appId,statementKinds:['trade'],statementAccounts:[],acknowledgement:'success',
    create:async()=>{throw Error('No external checkout');},query:async o=>paid(o.id,merchant),verifyCallback:async()=>{throw Error('No external callback');},
    downloadStatements:async request=>{assert.equal(request.kind,'trade');return verifiedDownload(merchant,request.billDate);}};
}
async function seedPaidRefund(h:Harness,p:PaymentProvider){
  const id=uid().replaceAll('-','');
  await h.pool.query(`INSERT INTO bb_recharge_orders(id,owner_user_id,request_id,request_hash,provider,pack_id,pack_version,amount_fen,points,currency,merchant_id,expires_at)
    VALUES($1,$2,$1,$3,'alipay','service_balance','synthetic-statement-paid',10000,10000,'CNY',$4,now()+interval '30 minutes')`,[id,h.owner,'a'.repeat(64),h.merchant]);
  await applyVerifiedPayment(h.pool,p,paid(id,h.merchant));
  let receipt!:VerifiedRefund;
  const withRefund:PaymentProvider={...p,refunds:{create:async r=>receipt={refundId:r.id,orderId:r.order_id,merchantId:r.merchant_id,
    transactionId:r.provider_transaction_id,providerRefundId:'synthetic_refund_'+r.id.slice(0,15),currency:'CNY',orderAmountFen:10000,
    amountFen:r.amount_fen,payerTotalFen:10000,payerRefundFen:r.amount_fen,state:'succeeded'},query:async()=>receipt,verifyCallback:async()=>receipt}};
  await requestPaymentRefund(h.pool,h.owner,id,{request_id:uid(),amount_fen:2500},[withRefund]);
  assert.deepEqual(await creditBalance(h.pool,h.owner),{available:7500,frozen:0});
  assert.equal((await h.pool.query('SELECT state FROM bb_payment_refunds WHERE id=$1',[receipt.refundId])).rows[0].state,'succeeded');
}

test('Alipay download proof persists as unresolved coverage with JSON null totals and never mutates wallet or refund ledgers',{skip:!database},async()=>{
  const h=await setup(),p=provider(h.merchant),download=verifiedDownload(h.merchant);
  try{
    await seedPaidRefund(h,p);const before=await financialSnapshot(h.pool);
    const job=await enqueuePaymentStatement(h.pool,p,{billDate,kind:'trade'})??
      (await h.pool.query("SELECT id FROM bb_payment_statement_jobs WHERE provider='alipay' AND merchant_id=$1 AND bill_date=$2 AND kind='trade'",[h.merchant,billDate])).rows[0]?.id;
    assert.ok(job,'First authenticated payment date may already have queued this bill');
    assert.deepEqual(await reconcileDailyStatements(h.pool,[p],{now:manualNow}),{checked:1,completed:0,unknown:1});
    const evidence=(await h.pool.query(`SELECT *,totals IS NULL AS totals_is_sql_null,jsonb_typeof(totals) AS totals_json_type
      FROM bb_payment_statements WHERE job_id=$1`,[job])).rows;
    assert.equal(evidence.length,1);const saved=evidence[0];
    assert.equal(saved.verification_method,'alipay_rsa2_download_url');assert.equal(saved.sha1,null);
    assert.equal(saved.sha256,download.sha256);assert.equal(saved.signed_response_sha256,download.evidence.signedResponseSha256);
    assert.equal(saved.byte_length,download.byteLength);assert.equal(saved.totals,null);assert.equal(saved.totals_is_sql_null,false);assert.equal(saved.totals_json_type,'null');
    assert.deepEqual(saved.verification_context,{request_app_id:appId,merchant_id:h.merchant,requested_bill_date:billDate,request_bill_type:'trade',
      normalization:download.normalization,documents:download.documents});
    assert.equal((await h.pool.query('SELECT count(*)::int n FROM bb_payment_statement_entries WHERE statement_id=$1',[saved.id])).rows[0].n,0);
    const state=(await h.pool.query(`SELECT *,extract(epoch FROM next_attempt_at-updated_at)::int AS retry_seconds
      FROM bb_payment_statement_jobs WHERE id=$1`,[job])).rows[0];
    assert.equal(state.state,'unknown');assert.equal(state.attempts,1);assert.equal(state.lease_token,null);assert.equal(state.lease_until,null);assert.ok(state.retry_seconds>=590);
    const differences=(await h.pool.query(`SELECT kind,line_no,reference_id,unit,expected_value,observed_value
      FROM bb_payment_statement_differences WHERE check_id=$1`,[state.last_check_id])).rows;
    assert.deepEqual(differences,[{kind:'alipay_statement_format_unverified',line_no:0,reference_id:billDate,unit:'coverage',expected_value:null,observed_value:null}]);
    assert.deepEqual(await reconcileDailyStatements(h.pool,[p],{now:manualNow}),{checked:0,completed:0,unknown:0});
    await h.pool.query("UPDATE bb_payment_statement_jobs SET next_attempt_at=now()-interval '1 minute' WHERE id=$1",[job]);
    assert.deepEqual(await reconcileDailyStatements(h.pool,[p],{now:manualNow}),{checked:1,completed:0,unknown:1});
    assert.equal((await h.pool.query('SELECT count(*)::int n FROM bb_payment_statements WHERE job_id=$1',[job])).rows[0].n,1);
    assert.equal((await h.pool.query('SELECT count(*)::int n FROM bb_payment_statement_checks WHERE job_id=$1',[job])).rows[0].n,2);
    assert.deepEqual(await financialSnapshot(h.pool),before);assert.equal((await auditCredits(h.pool)).consistent,true);
  }finally{await h.pool.end();}
});

test('Alipay trade-only scheduling creates seven trade jobs and never creates or claims fund jobs',{skip:!database},async()=>{
  const h=await setup(),calls:string[]=[],p:PaymentProvider={...provider(h.merchant),statementAccounts:['BASIC']};
  p.downloadStatements=async request=>{calls.push(request.kind);assert.equal(request.kind,'trade');return verifiedDownload(h.merchant,request.billDate);};
  try{
    const before=await financialSnapshot(h.pool),dailyNow=new Date('2026-10-28T03:00:00Z');
    assert.deepEqual(await reconcileDailyStatements(h.pool,[p],{now:dailyNow}),{checked:2,completed:0,unknown:2});
    assert.deepEqual((await h.pool.query('SELECT kind,count(*)::int n FROM bb_payment_statement_jobs WHERE provider=$1 AND merchant_id=$2 GROUP BY kind',['alipay',h.merchant])).rows,[{kind:'trade',n:7}]);
    await assert.rejects(()=>enqueuePaymentStatement(h.pool,p,{billDate,kind:'funds',accountType:'BASIC'}),/Invalid statement account/);
    const oldFunds=uid();
    await h.pool.query(`INSERT INTO bb_payment_statement_jobs(id,provider,merchant_id,bill_date,kind,account_type)
      VALUES($1,'alipay',$2,$3,'funds','BASIC')`,[oldFunds,h.merchant,billDate]);
    assert.deepEqual(await reconcileDailyStatements(h.pool,[p],{now:dailyNow,limit:10}),{checked:5,completed:0,unknown:5});
    assert.deepEqual((await h.pool.query('SELECT state,attempts FROM bb_payment_statement_jobs WHERE id=$1',[oldFunds])).rows,[{state:'pending',attempts:0}]);
    assert.equal(calls.length,7);assert.ok(calls.every(kind=>kind==='trade'));
    assert.equal((await h.pool.query("SELECT count(*)::int n FROM bb_payment_statement_jobs WHERE provider='alipay' AND merchant_id=$1 AND kind='funds'",[h.merchant])).rows[0].n,1);
    assert.deepEqual(await financialSnapshot(h.pool),before);
  }finally{await h.pool.end();}
});

test('Alipay identity, signed URL scope and SHA1 confusion are rejected without persisting financial evidence',{skip:!database},async()=>{
  const h=await setup(),p=provider(h.merchant),valid=verifiedDownload(h.merchant);
  const invalid:Array<[string,VerifiedAlipayStatement]>=[
    ['foreign merchant',{...valid,merchantId:'2088000000000001'}],
    ['foreign application',{...valid,requestAppId:'2021000000000001'}],
    ['foreign bill date',{...valid,billDate:'2026-10-26'}],
    ['foreign signed URL merchant',{...valid,evidence:{...valid.evidence,signedUrlMerchantId:'2088000000000001'}}],
    ['unexpected SHA1',{...valid,sha1:'a'.repeat(40)} as unknown as VerifiedAlipayStatement],
    ['foreign requested date',{...valid,evidence:{...valid.evidence,requestedBillDate:'2026-10-26'}}],
    ['download hash mismatch',{...valid,evidence:{...valid.evidence,downloadSha256:'b'.repeat(64)}}],
  ];
  try{
    const before=await financialSnapshot(h.pool),job=await enqueuePaymentStatement(h.pool,p,{billDate,kind:'trade'});assert.ok(job);
    for(const [name,value] of invalid){
      p.downloadStatements=async()=>value;
      await h.pool.query("UPDATE bb_payment_statement_jobs SET next_attempt_at=now()-interval '1 minute' WHERE id=$1",[job]);
      assert.deepEqual(await reconcileDailyStatements(h.pool,[p],{now:manualNow}),{checked:1,completed:0,unknown:1},name);
      const state:{state:string;lease_token:string|null;backed_off:boolean}=(await h.pool.query('SELECT state,lease_token,next_attempt_at>updated_at AS backed_off FROM bb_payment_statement_jobs WHERE id=$1',[job])).rows[0];
      assert.deepEqual(state,{state:'unknown',lease_token:null,backed_off:true},name);
      assert.equal((await h.pool.query('SELECT count(*)::int n FROM bb_payment_statements WHERE job_id=$1',[job])).rows[0].n,0,name);
      assert.equal((await h.pool.query('SELECT count(*)::int n FROM bb_payment_statement_checks WHERE job_id=$1',[job])).rows[0].n,0,name);
    }
    assert.deepEqual(await financialSnapshot(h.pool),before);
  }finally{await h.pool.end();}
});

test('database provenance guards reject provider-method mismatch and NULL WeChat SHA1 instead of accepting SQL UNKNOWN',{skip:!database},async()=>{
  const h=await setup(),p=provider(h.merchant),valid=verifiedDownload(h.merchant);
  try{
    const alipayJob=await enqueuePaymentStatement(h.pool,p,{billDate,kind:'trade'}),wechatJob=uid();assert.ok(alipayJob);
    await h.pool.query("INSERT INTO bb_payment_statement_jobs(id,provider,merchant_id,bill_date,kind) VALUES($1,'wechat',$2,$3,'trade')",[wechatJob,h.merchant,billDate]);
    const context={request_app_id:appId,merchant_id:h.merchant,requested_bill_date:billDate,request_bill_type:'trade',normalization:valid.normalization,documents:valid.documents};
    const insert=(job:string,method:string,sha1:string|null,signed:string|null,verificationContext:object,totals:unknown)=>h.pool.query(`
      INSERT INTO bb_payment_statements(id,job_id,evidence_key,availability,sha1,sha256,byte_length,verified_at,totals,verification_method,signed_response_sha256,verification_context)
      VALUES($1,$2,$3::text,'available',$4,$3::char(64),10,now(),$5,$6,$7,$8)`,[uid(),job,valid.sha256,sha1,JSON.stringify(totals),method,signed,verificationContext]);
    await assert.rejects(()=>insert(alipayJob,'wechat_sha1','a'.repeat(40),null,{},{}),{code:'P0001'});
    await assert.rejects(()=>insert(wechatJob,'alipay_rsa2_download_url',null,valid.evidence.signedResponseSha256,context,null),{code:'P0001'});
    await assert.rejects(()=>insert(wechatJob,'wechat_sha1',null,null,{},{}),{code:'23514',constraint:'bb_payment_statement_verified_provenance'});
    await assert.rejects(()=>insert(alipayJob,'alipay_rsa2_download_url',null,null,context,null),{code:'23514',constraint:'bb_payment_statement_verified_provenance'});
    const {request_app_id:removed,...missingApp}=context;void removed;
    await assert.rejects(()=>insert(alipayJob,'alipay_rsa2_download_url',null,valid.evidence.signedResponseSha256,missingApp,null),{code:'23514',constraint:'bb_payment_statement_verified_provenance'});
    assert.equal((await h.pool.query('SELECT count(*)::int n FROM bb_payment_statements WHERE job_id=ANY($1::text[])',[[alipayJob,wechatJob]])).rows[0].n,0);
  }finally{await h.pool.end();}
});
