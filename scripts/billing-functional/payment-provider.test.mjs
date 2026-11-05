import test from 'node:test';
import assert from 'node:assert/strict';
import {callbackAuthenticator,paymentTransition,refundTransition,syntheticPaymentProvider} from './provider.mjs';
import {installPaymentControls} from './payment-controls.mjs';

const saved={id:'11111111-2222-4333-8444-555555555555',database:'bb_billing_functional_0123456789abcdef'};
const merchant='synthetic-billing-functional-'+saved.id;
// Small channel persistence double. It deliberately has no wallet/credit tables:
// any attempted balance mutation or unrecognised query makes the test fail.
function fixture(){
  const rows=new Map(),charges=new Map(),refunds=new Map(),cashRefunds=new Map(),mandates=new Map(),statements=[];
  let ticks=Date.parse('2026-11-05T00:00:00.000Z');const now=()=>new Date(ticks+=1000);
  const result=value=>({rows:value?[structuredClone(value)]:[],rowCount:value?1:0});
  const query=async(sql,args=[])=>{
    statements.push(sql);sql=sql.replace(/\s+/g,' ').trim();
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return{rows:[]};
    if(sql.startsWith('SELECT secret FROM bb_local_billing_callback_keys'))return result({secret:'a'.repeat(64)});
    if(sql.startsWith('SELECT o.*,p.automatic,p.subscription_id FROM bb_recharge_orders')){
      const row=rows.get(args[0]);return result(row&&(!sql.includes('o.owner_user_id=$2')||row.owner_user_id===args[1])?row:null);
    }
    if(sql.startsWith('SELECT * FROM bb_local_billing_charges')){
      const row=charges.get(args[0]);return result(row&&(!sql.includes('merchant_id=$2')||row.merchant_id===args[1])?row:null);
    }
    if(sql.startsWith('SELECT * FROM bb_local_billing_mandates WHERE mandate_id='))return result(mandates.get(args[0]));
    if(sql.startsWith('SELECT next_charge_outcome FROM bb_local_billing_controls'))return result(null);
    if(sql.startsWith('INSERT INTO bb_local_billing_charges')){
      const [order_id,owner_user_id,merchant_id,amount_fen,currency,mandate_id,automatic,transaction_id]=args;
      const row={order_id,owner_user_id,merchant_id,amount_fen,currency,mandate_id,automatic,transaction_id,state:'pending',paid_at:null};charges.set(order_id,row);return result(row);
    }
    if(sql.startsWith('UPDATE bb_local_billing_charges SET state=')){
      const row=charges.get(args[0]);row.state=args[1];row.paid_at=row.state==='paid'?now():null;return result(row);
    }
    if(sql.startsWith('SELECT * FROM bb_payment_refunds'))return result(refunds.get(args[0]));
    if(sql.startsWith('SELECT * FROM bb_local_billing_refunds')){
      const row=cashRefunds.get(args[0]);
      return result(row&&(!sql.includes('owner_user_id=$2')||row.owner_user_id===args[1])&&(!sql.includes('merchant_id=$2')||row.merchant_id===args[1])?row:null);
    }
    if(sql.startsWith('INSERT INTO bb_local_billing_refunds')){
      const [refund_id,order_id,owner_user_id,merchant_id,transaction_id,provider_refund_id,order_amount_fen,amount_fen,currency]=args;
      const row={refund_id,order_id,owner_user_id,merchant_id,transaction_id,provider_refund_id,order_amount_fen,amount_fen,currency,state:'processing',created_at:now(),succeeded_at:null};
      cashRefunds.set(refund_id,row);return result(row);
    }
    if(sql.startsWith('UPDATE bb_local_billing_refunds SET state=')){
      const row=cashRefunds.get(args[0]);row.state=args[1];row.succeeded_at=row.state==='succeeded'?now():null;return result(row);
    }
    throw Error('Unexpected SQL in channel-only fixture: '+sql);
  };
  const pool={query,connect:async()=>({query,release(){}})};
  const order=(id='a'.repeat(32),owner='alice')=>{
    const row={id,owner_user_id:owner,merchant_id:merchant,amount_fen:'50000',currency:'CNY',automatic:false,state:'pending',close_requested_at:null};rows.set(id,row);
    return{id,merchant_id:merchant,amount_fen:50000,currency:'CNY',expires_at:'2026-11-05T01:00:00Z'};
  };
  return{pool,rows,charges,refunds,cashRefunds,mandates,statements,order,provider:syntheticPaymentProvider(pool,saved)};
}

test('refresh is read-only at the channel until explicit owner payment; signed receipt survives provider restart',async()=>{
  const f=fixture(),order=f.order();await f.provider.create(order);
  for(let i=0;i<3;i++)assert.equal((await f.provider.query(order)).state,'pending');
  assert.equal(f.charges.get(order.id).state,'pending');assert.equal(f.statements.filter(sql=>sql.startsWith('UPDATE')).length,0);
  const receipt=await f.provider.synthetic.paymentOutcome('alice',order.id,'paid');assert.equal(receipt.state,'paid');assert.equal(receipt.payerCash.amountFen,50000);
  const callback=await f.provider.synthetic.callback('payment',receipt);
  assert.deepEqual(await f.provider.verifyCallback(callback.headers,callback.body),receipt);
  const restarted=syntheticPaymentProvider(f.pool,saved);
  assert.deepEqual(await restarted.query(order),receipt);assert.deepEqual(await restarted.verifyCallback(callback.headers,callback.body),receipt);
  const mismatched=await restarted.synthetic.callback('payment',{...receipt,amountFen:receipt.amountFen+1});
  await assert.rejects(restarted.verifyCallback(mismatched.headers,mismatched.body),/differs from persisted/);
  assert.deepEqual(await restarted.synthetic.paymentOutcome('alice',order.id,'paid'),receipt);
  await assert.rejects(restarted.synthetic.paymentOutcome('alice',order.id,'failed'),{statusCode:409});
});

test('foreign payment controls, order tampering and closed-order payment cannot change a channel result',async()=>{
  const f=fixture(),order=f.order();await f.provider.create(order);
  await assert.rejects(f.provider.synthetic.paymentOutcome('bob',order.id,'paid'),{statusCode:404});
  await assert.rejects(f.provider.query({...order,amount_fen:50001}),/identity or amount mismatch/);
  assert.equal((await f.provider.query(order)).state,'pending');
  assert.equal((await f.provider.closePayment(order)).state,'expired');
  assert.equal((await f.provider.closePayment(order)).state,'expired');
  await assert.rejects(f.provider.synthetic.paymentOutcome('alice',order.id,'paid'),{statusCode:409});
  assert.equal((await f.provider.query(order)).state,'expired');
});

test('closing after channel payment reports the paid fact and never cancels already-paid value',async()=>{
  const f=fixture(),order=f.order();await f.provider.create(order);
  const paid=await f.provider.synthetic.paymentOutcome('alice',order.id,'paid');
  assert.deepEqual(await f.provider.closePayment(order),paid);
  f.rows.get(order.id).close_requested_at=new Date();
  assert.deepEqual(await f.provider.synthetic.paymentOutcome('alice',order.id,'paid'),paid);
});

test('querying an undispatched automatic order cannot create a manual charge or bypass its mandate',async()=>{
  const f=fixture(),order=f.order(),row=f.rows.get(order.id),mandateId='synthetic-mandate-test';
  row.automatic=true;row.subscription_id='subscription-test';
  f.mandates.set(mandateId,{mandate_id:mandateId,subscription_id:row.subscription_id,owner_user_id:'alice',amount_fen:row.amount_fen,state:'active'});
  for(let i=0;i<3;i++)assert.equal((await f.provider.query(order)).state,'pending');
  assert.equal(f.charges.size,0);
  await assert.rejects(f.provider.synthetic.paymentOutcome('alice',order.id,'paid'),{statusCode:409});
  assert.equal(f.charges.size,0);
  const paid=await f.provider.recurring.charge({...order,mandateId});
  assert.equal(paid.state,'paid');assert.equal(f.charges.get(order.id).mandate_id,mandateId);
  assert.deepEqual(await f.provider.query(order),paid);
  assert.deepEqual(await f.provider.recurring.charge({...order,mandateId}),paid);
});

test('refund remains processing until explicit result; replays preserve identity/times and foreign controls fail',async()=>{
  const f=fixture(),order=f.order();await f.provider.create(order);const paid=await f.provider.synthetic.paymentOutcome('alice',order.id,'paid');
  const id='b'.repeat(32),row={id,order_id:order.id,owner_user_id:'alice',merchant_id:merchant,provider_txn_id:paid.transactionId,order_amount_fen:50000,amount_fen:5000,currency:'CNY'};
  f.refunds.set(id,row);const input={id,order_id:order.id,merchant_id:merchant,provider_transaction_id:paid.transactionId,order_amount_fen:50000,amount_fen:5000,currency:'CNY'};
  const pending=await f.provider.refunds.create(input);assert.equal(pending.state,'processing');
  assert.deepEqual(await f.provider.refunds.query(input),pending);assert.deepEqual(await f.provider.refunds.create(input),pending);
  await assert.rejects(f.provider.synthetic.refundOutcome('bob',id,'succeeded'),{statusCode:404});
  await assert.rejects(f.provider.refunds.query({...input,amount_fen:5001}),/refund identity or amount mismatch/);
  const complete=await f.provider.synthetic.refundOutcome('alice',id,'succeeded');assert.ok(complete.providerSucceededAt);
  const callback=await f.provider.synthetic.callback('refund',complete);assert.deepEqual(await f.provider.refunds.verifyCallback(callback.headers,callback.body),complete);
  const mismatched=await f.provider.synthetic.callback('refund',{...complete,orderId:'c'.repeat(32)});
  await assert.rejects(f.provider.refunds.verifyCallback(mismatched.headers,mismatched.body),/differs from persisted/);
  assert.deepEqual(await f.provider.synthetic.refundOutcome('alice',id,'succeeded'),complete);
  await assert.rejects(f.provider.synthetic.refundOutcome('alice',id,'failed'),{statusCode:409});
  assert.deepEqual(await syntheticPaymentProvider(f.pool,saved).refunds.query(input),complete);
});

test('a failed refund reports the explicit CLOSED channel fact required to release the product freeze',async()=>{
  const f=fixture(),order=f.order();await f.provider.create(order);const paid=await f.provider.synthetic.paymentOutcome('alice',order.id,'paid');
  const id='d'.repeat(32),row={id,order_id:order.id,owner_user_id:'alice',merchant_id:merchant,provider_txn_id:paid.transactionId,order_amount_fen:50000,amount_fen:5000,currency:'CNY'};
  f.refunds.set(id,row);const input={id,order_id:order.id,merchant_id:merchant,provider_transaction_id:paid.transactionId,order_amount_fen:50000,amount_fen:5000,currency:'CNY'};
  await f.provider.refunds.create(input);
  const failed=await f.provider.synthetic.refundOutcome('alice',id,'failed');
  assert.equal(failed.failureCode,'CLOSED');assert.ok(!Object.hasOwn(failed,'providerSucceededAt'));
  assert.deepEqual(await f.provider.refunds.query(input),failed);
  const callback=await f.provider.synthetic.callback('refund',failed);assert.deepEqual(await f.provider.refunds.verifyCallback(callback.headers,callback.body),failed);
  assert.deepEqual(await f.provider.synthetic.refundOutcome('alice',id,'failed'),failed);
});

test('callback authentication rejects forged, modified and cross-kind bodies without exposing keys',()=>{
  const auth=callbackAuthenticator('1'.repeat(64)),body=JSON.stringify({orderId:'local-only',state:'paid'}),headers=auth.sign('payment',body);
  assert.deepEqual(auth.verify('payment',headers,body),JSON.parse(body));
  assert.throws(()=>auth.verify('payment',{},body),/signature/);
  assert.throws(()=>auth.verify('payment',{'x-bb-synthetic-signature':'0'.repeat(64)},body),/signature/);
  assert.throws(()=>auth.verify('payment',headers,body.replace('paid','failed')),/signature/);
  assert.throws(()=>auth.verify('refund',headers,body),/signature/);
  assert.throws(()=>auth.verify('payment',{'x-bb-synthetic-signature':[headers['x-bb-synthetic-signature']]},body),/signature/);
  assert.ok(!JSON.stringify(headers).includes('1'.repeat(64)));
});

test('terminal payment and refund transitions reject conflicting facts',()=>{
  assert.equal(paymentTransition('pending','paid'),'paid');assert.equal(paymentTransition('failed','failed'),'failed');
  assert.throws(()=>paymentTransition('expired','paid'),{statusCode:409});
  assert.equal(refundTransition('processing','failed'),'failed');assert.equal(refundTransition('succeeded','succeeded'),'succeeded');
  assert.throws(()=>refundTransition('failed','succeeded'),{statusCode:409});
});

test('refund control preserves the decimal-string wire amount when forwarding to the product',async()=>{
  const handlers=new Map(),calls=[],id='a'.repeat(32),requestId='11111111-2222-4333-8444-555555555555';
  const app={post:(path,_options,handler)=>handlers.set(path,handler)};
  const pool={query:async(_sql,args)=>{assert.deepEqual(args,[id,'alice',merchant]);return{rows:[{id}]};}};
  const expected={payments:[],refunds:[{id:'b'.repeat(32),request_id:requestId}]};
  installPaymentControls(app,{pool,saved,provider:{merchantId:merchant,synthetic:{}},owner:async()=> 'alice',serial:work=>work(),
    product:async(_request,method,path,body)=>{calls.push({method,path,body});assert.equal(typeof body.amount_fen,'string');},state:async()=>expected});
  const result=await handlers.get('/__billing-test/api/refund/request')({body:{id,request_id:requestId,amount_fen:'1078920'}});
  assert.deepEqual(result,expected);
  assert.deepEqual(calls,[{method:'POST',path:`/api/v1/commerce/topups/${id}/refunds`,body:{request_id:requestId,amount_fen:'1078920'}}]);
});
