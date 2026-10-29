import assert from 'node:assert/strict';
import test from 'node:test';
import {Pool} from 'pg';
import {isolatedTestDatabase} from './test-database.js';
import {uid} from './data.js';
import {creditBalance} from './billing.js';
import {auditCredits} from './billing-ops.js';
import {reconcilePendingPayments} from './payment-reconciliation.js';
import {applyVerifiedPayment,type PaymentProvider,type VerifiedPayment} from './payments.js';
import {applyVerifiedRefund,requestPaymentRefund,refreshPaymentRefund,type VerifiedRefund} from './payment-refunds.js';
import {createServer} from './server.js';

const connection=await isolatedTestDatabase(undefined,'payment-reconciliation');
async function owner(pool:Pool){const id=uid();await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[id,'synthetic_rec_'+id.slice(0,8)]);return id;}
async function order(pool:Pool,user:string,merchant:string){
  const id=uid().replaceAll('-','');
  await pool.query(`INSERT INTO bb_recharge_orders(id,owner_user_id,request_id,request_hash,provider,pack_id,pack_version,amount_fen,points,currency,merchant_id,expires_at,created_at)
    VALUES($1,$2,$1,$3,'wechat','service_balance','outcome-cny-20261028-v2',10000,10000,'CNY',$4,now()+interval '20 minutes',now()-interval '2 minutes')`,[id,user,'a'.repeat(64),merchant]);
  return id;
}
const paid=(id:string,merchant:string):VerifiedPayment=>({orderId:id,merchantId:merchant,amountFen:10000,currency:'CNY',transactionId:'synthetic-txn-'+id,state:'paid',payerCash:{amountFen:10000,currency:'CNY'}});

test('lost payment callbacks reconcile once without a browser, another charge, or another task',{skip:!connection},async()=>{
  const pool=new Pool({connectionString:connection}),queries=new Map<string,number>(),merchant=uid();
  const provider:PaymentProvider={name:'wechat',merchantId:merchant,acknowledgement:{code:'SUCCESS'},create:async()=>{throw Error('Reconciliation must not create payments');},verifyCallback:async()=>{throw Error('No callback used');},
    query:async o=>{queries.set(o.id,(queries.get(o.id)??0)+1);return paid(o.id,merchant);}};
  try{
    const user=await owner(pool),first=await order(pool,user,merchant),late=await order(pool,user,merchant),foreign=await order(pool,user,'unconfigured-merchant');
    await pool.query("UPDATE bb_recharge_orders SET state='expired' WHERE id=$1",[late]);
    const attempts=await Promise.all([reconcilePendingPayments(pool,[provider]),reconcilePendingPayments(pool,[provider])]);
    assert.equal(attempts.reduce((s,r)=>s+r.payments_checked,0),2);assert.equal(queries.get(first),1);assert.equal(queries.get(late),1);assert.equal(queries.has(foreign),false);
    assert.deepEqual(await creditBalance(pool,user),{available:20000,frozen:0});
    await applyVerifiedPayment(pool,provider,paid(first,merchant)); // Delayed callback converges on the same original lot.
    assert.deepEqual(await creditBalance(pool,user),{available:20000,frozen:0});
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1',[user])).rows[0].n,0);
    assert.equal((await reconcilePendingPayments(pool,[provider])).payments_checked,0);
    assert.equal((await auditCredits(pool)).consistent,true);
  }finally{await pool.end();}
});

test('query timeout and mismatched identity keep original payment pending and back off',{skip:!connection},async()=>{
  const pool=new Pool({connectionString:connection}),merchant=uid();
  try{
    const user=await owner(pool),timeout=await order(pool,user,merchant),mismatch=await order(pool,user,merchant);
    const provider:PaymentProvider={name:'wechat',merchantId:merchant,acknowledgement:{code:'SUCCESS'},create:async()=>{throw Error('No create');},verifyCallback:async()=>{throw Error('No callback');},
      query:async o=>{if(o.id===timeout)throw Error('Synthetic timeout');assert.equal(o.id,mismatch);return paid(timeout,merchant);}};
    const result=await reconcilePendingPayments(pool,[provider]);assert.equal(result.unknown,2);
    const rows=(await pool.query('SELECT state,reconcile_attempts,next_reconcile_at>now() AS later FROM bb_recharge_orders WHERE owner_user_id=$1',[user])).rows;
    assert.ok(rows.every(r=>r.state==='pending'&&r.reconcile_attempts===1&&r.later));
    assert.deepEqual(await creditBalance(pool,user),{available:0,frozen:0});
    assert.equal((await reconcilePendingPayments(pool,[provider])).payments_checked,0);
    const alerts=(await pool.query("SELECT detail FROM bb_ops_alerts WHERE kind='payment_reconciliation_unresolved' AND detail->>'intent_id'=ANY($1::text[])",[[timeout,mismatch]])).rows;
    assert.equal(alerts.length,2);alerts.forEach(r=>assert.deepEqual(Object.keys(r.detail).sort(),['attempts','intent_id','intent_kind','provider']));
  }finally{await pool.end();}
});

test('accepted refund with a lost response completes by querying its original ID; unknown holds stay frozen',{skip:!connection},async()=>{
  const pool=new Pool({connectionString:connection}),merchant=uid();let creates=0,queries=0,refund:VerifiedRefund|undefined,unknown=true;
  const provider:PaymentProvider={name:'wechat',merchantId:merchant,acknowledgement:{code:'SUCCESS'},create:async()=>{throw Error('No new checkout');},verifyCallback:async()=>{throw Error('No callback');},query:async o=>paid(o.id,merchant),
    refunds:{create:async r=>{creates++;refund={refundId:r.id,orderId:r.order_id,merchantId:r.merchant_id,transactionId:r.provider_transaction_id,providerRefundId:'synthetic-refund-'+r.id,
      currency:'CNY',orderAmountFen:r.order_amount_fen,amountFen:r.amount_fen,payerTotalFen:r.order_amount_fen,payerRefundFen:r.amount_fen,state:'succeeded'};throw Error('Synthetic accepted request with response lost');},
      query:async r=>{queries++;assert.equal(r.id,refund?.refundId);if(unknown)throw Error('Synthetic channel timeout');return refund!;},verifyCallback:async()=>{throw Error('No callback');}}};
  try{
    const user=await owner(pool),id=await order(pool,user,merchant);await applyVerifiedPayment(pool,provider,paid(id,merchant));
    const requested=await requestPaymentRefund(pool,user,id,{request_id:uid(),amount_fen:2500},[provider]);
    assert.equal(requested.state,'processing');assert.equal(creates,1);
    const due=()=>pool.query("UPDATE bb_payment_refunds SET updated_at=now()-interval '2 minutes',next_reconcile_at=now()-interval '1 minute' WHERE id=$1",[requested.refund_id]);
    await due();const waiting=await reconcilePendingPayments(pool,[provider]);assert.equal(waiting.unknown,1);
    assert.deepEqual(await creditBalance(pool,user),{available:7500,frozen:2500});
    unknown=false;await due();const done=await reconcilePendingPayments(pool,[provider]);assert.equal(done.refunds_terminal,1);assert.equal(creates,1);assert.equal(queries,2);
    assert.deepEqual(await creditBalance(pool,user),{available:7500,frozen:0});
    assert.equal((await reconcilePendingPayments(pool,[provider])).refunds_checked,0);assert.equal((await auditCredits(pool)).consistent,true);
  }finally{await pool.end();}
});

test('a crash after refund freeze but before dispatch resumes the same authorised request once',{skip:!connection},async()=>{
  const pool=new Pool({connectionString:connection}),merchant=uid();let creates=0;
  const receipt=(r:import('./payment-refunds.js').RefundOrder):VerifiedRefund=>({refundId:r.id,orderId:r.order_id,merchantId:r.merchant_id,transactionId:r.provider_transaction_id,
    providerRefundId:'synthetic-refund-'+r.id,currency:'CNY',orderAmountFen:r.order_amount_fen,amountFen:r.amount_fen,payerTotalFen:r.order_amount_fen,payerRefundFen:r.amount_fen,state:'succeeded'});
  const provider:PaymentProvider={name:'wechat',merchantId:merchant,acknowledgement:{code:'SUCCESS'},create:async()=>{throw Error('No new checkout');},verifyCallback:async()=>{throw Error('No callback');},query:async o=>paid(o.id,merchant),
    refunds:{create:async r=>{creates++;return receipt(r);},query:async r=>{if(!creates)throw Error('Not yet dispatched');return receipt(r);},verifyCallback:async()=>{throw Error('No callback');}}};
  try{
    const user=await owner(pool),id=await order(pool,user,merchant);await applyVerifiedPayment(pool,provider,paid(id,merchant));
    // Domain transaction commits normally. Simulate process death on the first subsequent DB access.
    const stopped=new Proxy(pool,{get(target,key){
      if(key==='query')return()=>{throw Error('Synthetic process death before dispatch');};
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    await assert.rejects(()=>requestPaymentRefund(stopped,user,id,{request_id:uid(),amount_fen:2500},[provider]),/Synthetic process death/);
    const row=(await pool.query('SELECT * FROM bb_payment_refunds WHERE order_id=$1',[id])).rows[0];
    assert.equal(row.state,'requested');assert.equal(row.dispatch_started_at,null);assert.equal(creates,0);
    assert.deepEqual(await creditBalance(pool,user),{available:7500,frozen:2500});
    await pool.query("UPDATE bb_payment_refunds SET updated_at=now()-interval '2 minutes' WHERE id=$1",[row.id]);
    await Promise.all([reconcilePendingPayments(pool,[provider]),reconcilePendingPayments(pool,[provider]),refreshPaymentRefund(pool,user,row.id,[provider])]);
    assert.equal(creates,1);assert.equal((await pool.query('SELECT state FROM bb_payment_refunds WHERE id=$1',[row.id])).rows[0].state,'succeeded');
    assert.deepEqual(await creditBalance(pool,user),{available:7500,frozen:0});assert.equal((await auditCredits(pool)).consistent,true);
  }finally{await pool.end();}
});

test('pre-send dispatch crash uses only documented same-request recovery; unknown or mismatched receipts never release held points',{skip:!connection},async()=>{
  const pool=new Pool({connectionString:connection}),merchant=uid();let firstId='',creates=0,recoveries=0,mode:'unknown'|'mismatch'|'paid'='unknown';
  const provider:PaymentProvider={name:'wechat',merchantId:merchant,acknowledgement:{code:'SUCCESS'},create:async()=>{throw Error('No checkout');},verifyCallback:async()=>{throw Error('No callback');},query:async o=>paid(o.id,merchant),
    refunds:{create:async r=>{creates++;firstId=r.id;throw Error('Synthetic stop before network send');},query:async()=>{throw Error('Synthetic unverified absence');},
      recoverSameRequest:async r=>{recoveries++;assert.equal(r.id,firstId);assert.equal(r.amount_fen,2500);
        if(mode==='unknown')throw Error('Synthetic timeout');
        return {refundId:mode==='mismatch'?uid():r.id,orderId:r.order_id,merchantId:r.merchant_id,transactionId:r.provider_transaction_id,
          providerRefundId:'synthetic-refund-'+r.id,currency:'CNY',orderAmountFen:r.order_amount_fen,amountFen:r.amount_fen,payerTotalFen:r.order_amount_fen,payerRefundFen:r.amount_fen,state:'succeeded'};},
      verifyCallback:async()=>{throw Error('No callback');}}};
  try{
    const user=await owner(pool),id=await order(pool,user,merchant);await applyVerifiedPayment(pool,provider,paid(id,merchant));
    const original=await requestPaymentRefund(pool,user,id,{request_id:uid(),amount_fen:2500},[provider]);assert.equal(original.state,'processing');
    const due=()=>pool.query("UPDATE bb_payment_refunds SET updated_at=now()-interval '2 minutes',next_reconcile_at=now()-interval '1 minute' WHERE id=$1",[original.refund_id]);
    await due();assert.equal((await reconcilePendingPayments(pool,[provider])).unknown,1);
    mode='mismatch';await due();assert.equal((await reconcilePendingPayments(pool,[provider])).unknown,1);
    assert.deepEqual(await creditBalance(pool,user),{available:7500,frozen:2500});
    mode='paid';await due();assert.equal((await reconcilePendingPayments(pool,[provider])).refunds_terminal,1);
    assert.equal(creates,1);assert.equal(recoveries,3);assert.deepEqual(await creditBalance(pool,user),{available:7500,frozen:0});
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_payment_refunds WHERE order_id=$1',[id])).rows[0].n,1);
    assert.equal((await auditCredits(pool)).consistent,true);
  }finally{await pool.end();}
});

test('a matching callback arriving during a failed query prevents needless same-request resubmission',{skip:!connection},async()=>{
  const pool=new Pool({connectionString:connection}),merchant=uid();let verified!:VerifiedRefund,recoveries=0;
  let queried!:()=>void,rejectQuery!:(error:Error)=>void;
  const inQuery=new Promise<void>(resolve=>{queried=resolve;});
  const pendingQuery=new Promise<VerifiedRefund>((_resolve,reject)=>{rejectQuery=reject;});
  const provider:PaymentProvider={name:'wechat',merchantId:merchant,acknowledgement:{code:'SUCCESS'},create:async()=>{throw Error('No checkout');},verifyCallback:async()=>{throw Error('No callback');},query:async o=>paid(o.id,merchant),
    refunds:{create:async r=>{verified={refundId:r.id,orderId:r.order_id,merchantId:r.merchant_id,transactionId:r.provider_transaction_id,providerRefundId:'synthetic-refund-'+r.id,
      currency:'CNY',orderAmountFen:r.order_amount_fen,amountFen:r.amount_fen,payerTotalFen:r.order_amount_fen,payerRefundFen:r.amount_fen,state:'succeeded'};throw Error('Synthetic lost response');},
      query:async()=>{queried();return pendingQuery;},recoverSameRequest:async()=>{recoveries++;return verified;},verifyCallback:async()=>{throw Error('No callback');}}};
  try{
    const user=await owner(pool),id=await order(pool,user,merchant);await applyVerifiedPayment(pool,provider,paid(id,merchant));
    const original=await requestPaymentRefund(pool,user,id,{request_id:uid(),amount_fen:2500},[provider]);
    await pool.query("UPDATE bb_payment_refunds SET updated_at=now()-interval '2 minutes' WHERE id=$1",[original.refund_id]);
    const reconciliation=reconcilePendingPayments(pool,[provider]);await inQuery;
    await applyVerifiedRefund(pool,provider,verified);rejectQuery(Error('Synthetic query failure after callback'));
    assert.equal((await reconciliation).refunds_terminal,1);assert.equal(recoveries,0);
    assert.deepEqual(await creditBalance(pool,user),{available:7500,frozen:0});assert.equal((await auditCredits(pool)).consistent,true);
  }finally{await pool.end();}
});

test('shutdown stops starting claimed rows; unfinished original orders remain recoverable',{skip:!connection},async()=>{
  const pool=new Pool({connectionString:connection}),merchant=uid();let stopping=false,queries=0;
  const provider:PaymentProvider={name:'wechat',merchantId:merchant,acknowledgement:{code:'SUCCESS'},create:async()=>{throw Error('No checkout');},verifyCallback:async()=>{throw Error('No callback');},
    query:async o=>{queries++;stopping=true;return paid(o.id,merchant);}};
  try{
    const user=await owner(pool);for(let i=0;i<6;i++)await order(pool,user,merchant);
    assert.equal((await reconcilePendingPayments(pool,[provider],20,()=>true)).payments_checked,0);
    const result=await reconcilePendingPayments(pool,[provider],20,()=>stopping);assert.equal(result.payments_paid,1);assert.equal(queries,1);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_recharge_orders WHERE owner_user_id=$1 AND state='pending'",[user])).rows[0].n,5);
    await pool.query('UPDATE bb_recharge_orders SET next_reconcile_at=now() WHERE owner_user_id=$1',[user]);
    assert.equal((await reconcilePendingPayments(pool,[provider])).payments_paid,5);
    assert.deepEqual(await creditBalance(pool,user),{available:60000,frozen:0});assert.equal((await auditCredits(pool)).consistent,true);
  }finally{await pool.end();}
});

test('server-owned database remains open until an in-flight payment query is applied',{skip:!connection,timeout:60000},async()=>{
  const pool=new Pool({connectionString:connection}),merchant=uid(),previousDatabase=process.env.DATABASE_URL;
  let queried!:()=>void,release!:()=>void,closeEntered!:()=>void,queries=0;
  const inQuery=new Promise<void>(resolve=>{queried=resolve;}),response=new Promise<void>(resolve=>{release=resolve;});
  const closingStarted=new Promise<void>(resolve=>{closeEntered=resolve;});
  const provider:PaymentProvider={name:'wechat',merchantId:merchant,acknowledgement:{code:'SUCCESS'},
    create:async()=>{throw Error('Shutdown must not create a payment');},verifyCallback:async()=>{throw Error('No callback');},
    query:async o=>{queries++;queried();await response;return paid(o.id,merchant);}};
  process.env.DATABASE_URL=connection!;
  const app=createServer({paymentProviders:[provider],enableSubscriptionBilling:false,enableOutcomePricing:false});
  // Fastify executes this last-registered close hook first. Let the actual
  // application hooks start while the authenticated provider query is pending.
  app.addHook('onClose',async()=>{closeEntered();});
  try{
    const user=await owner(pool),id=await order(pool,user,merchant);
    await app.listen({host:'127.0.0.1',port:0});await inQuery;
    const closing=app.close();await closingStarted;
    await new Promise<void>(resolve=>setImmediate(resolve));
    release();await closing;
    assert.equal(queries,1);
    assert.equal((await pool.query('SELECT state FROM bb_recharge_orders WHERE id=$1',[id])).rows[0].state,'paid');
    assert.deepEqual(await creditBalance(pool,user),{available:10000,frozen:0});
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_lots WHERE owner_user_id=$1 AND source_key=$2',[user,`recharge:${id}`])).rows[0].n,1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1',[user])).rows[0].n,0);
  }finally{
    release();await app.close();await pool.end();
    if(previousDatabase===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previousDatabase;
  }
});
