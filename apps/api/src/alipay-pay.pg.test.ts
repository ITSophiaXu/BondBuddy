import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {Pool} from 'pg';
import {isolatedTestDatabase} from './test-database.js';
import {uid,Problem} from './data.js';
import {installPayments,createServiceTopup,refreshRecharge} from './payments.js';
import {creditBalance} from './billing.js';
import {auditCredits} from './billing-ops.js';
import {createAlipayPayProvider} from './alipay-pay.js';
import {syntheticAlipayFixture} from './test-alipay-pay-fixtures.js';
import {requestPaymentRefund,refreshPaymentRefund} from './payment-refunds.js';

const database=await isolatedTestDatabase(undefined,'alipay-callbacks');
test('official-SDK synthetic form callback credits once, acknowledges plain text after commit, and query repairs a failed commit',{skip:!database,timeout:60000},async()=>{
  const f=syntheticAlipayFixture(),pool=new Pool({connectionString:database}),owner=uid(),app=Fastify();
  app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof Problem?error.status:typeof (error as any).statusCode==='number'?(error as any).statusCode:500).send({code:error instanceof Problem?error.code:'SYNTHETIC_ERROR'}));
  const p=createAlipayPayProvider(f.options,{fetch:async(_url,init)=>{
    const {fields,biz}=f.request(init?.body);return f.response(fields.method,{...f.paid,out_trade_no:biz.out_trade_no,trade_no:'trade_'+biz.out_trade_no});
  }});
  installPayments(app,pool,async request=>{if(request.headers['x-synthetic-owner']!=='authorized')throw new Problem(401,'UNAUTHENTICATED','Synthetic session required');return owner;},true,[p]);
  const notify=(id:string,changes:Record<string,string|undefined>={})=>{const c=f.callback({out_trade_no:id,trade_no:'trade_'+id,...changes});return app.inject({method:'POST',url:'/api/v1/payments/alipay/callback',payload:c.raw,headers:c.headers});};
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_alipay_'+owner.slice(0,8)]);
    const first=await createServiceTopup(pool,owner,{request_id:uid(),provider:'alipay',amount_fen:10000},[p]);
    const wrong=await notify(first.order_id,{total_amount:'1.00',buyer_pay_amount:'1.00'});assert.equal(wrong.statusCode,422);assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:0});
    const forged=f.callback({out_trade_no:first.order_id,trade_no:'trade_'+first.order_id});
    assert.equal((await app.inject({method:'POST',url:'/api/v1/payments/alipay/callback',headers:forged.headers,payload:forged.raw.replace('100.00','1.00')})).statusCode,401);
    const duplicate=await Promise.all([notify(first.order_id),notify(first.order_id)]);
    for(const response of duplicate){assert.equal(response.statusCode,200,response.body);assert.equal(response.body,'success');assert.match(response.headers['content-type']??'',/^text\/plain/);}
    assert.deepEqual(await creditBalance(pool,owner),{available:10000,frozen:0});
    const second=await createServiceTopup(pool,owner,{request_id:uid(),provider:'alipay',amount_fen:10000},[p]);
    await pool.query("CREATE FUNCTION synthetic_alipay_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic ledger failure'; END; $$; CREATE TRIGGER synthetic_alipay_fault BEFORE INSERT ON bb_credit_events FOR EACH ROW EXECUTE FUNCTION synthetic_alipay_fault()");
    try{const failed=await notify(second.order_id);assert.equal(failed.statusCode,500);assert.notEqual(failed.body,'success');}
    finally{await pool.query('DROP TRIGGER synthetic_alipay_fault ON bb_credit_events');}
    assert.equal((await pool.query('SELECT state FROM bb_recharge_orders WHERE id=$1',[second.order_id])).rows[0].state,'pending');
    assert.equal((await refreshRecharge(pool,owner,second.order_id,[p])).state,'paid');
    assert.deepEqual(await creditBalance(pool,owner),{available:20000,frozen:0});
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_payment_cash_proofs WHERE owner_user_id=$1',[owner])).rows[0].n,2);
    assert.equal((await auditCredits(pool)).consistent,true);
    assert.equal((await app.inject({method:'POST',url:'/api/v1/payments/alipay/callback/extra',headers:forged.headers,payload:forged.raw})).statusCode,404);
    const protectedRequest=await app.inject({method:'POST',url:'/api/v1/credits/recharge-orders',headers:{'content-type':'application/json'},payload:{request_id:uid(),provider:'alipay',pack_id:'cny500'}});
    assert.equal(protectedRequest.statusCode,401,'callback parser does not bypass authentication of purchase endpoints');
    assert.equal((await app.inject({method:'POST',url:'/api/v1/credits/recharge-orders',headers:forged.headers,payload:forged.raw})).statusCode,415,'form parser remains scoped to callback plugin');
  }finally{await app.close();await pool.end();}
});

test('Alipay refund integration preserves its hold without buyer cash evidence, then settles the original refund once after authenticated repair',{skip:!database,timeout:60000},async()=>{
  const f=syntheticAlipayFixture(),pool=new Pool({connectionString:database}),owner=uid();let buyerEvidence=false,refundCalls=0;
  const p=createAlipayPayProvider({...f.options,refundsEnabled:true},{fetch:async(_url,init)=>{
    const {fields,biz}=f.request(init?.body),trade='trade_'+biz.out_trade_no;
    if(fields.method==='alipay.trade.query')return f.response(fields.method,{...f.paid,out_trade_no:biz.out_trade_no,trade_no:trade});
    if(fields.method==='alipay.trade.refund'){refundCalls++;return f.response(fields.method,{code:'10000',out_trade_no:biz.out_trade_no,trade_no:trade,refund_fee:'65.00',fund_change:'Y'});}
    return f.response(fields.method,{...f.refunded,out_trade_no:biz.out_trade_no,trade_no:trade,out_request_no:biz.out_request_no,present_refund_buyer_amount:buyerEvidence?'25.00':undefined});
  }});
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_alipay_refund_'+owner.slice(0,8)]);
    const order=await createServiceTopup(pool,owner,{request_id:uid(),provider:'alipay',amount_fen:10000},[p]);await refreshRecharge(pool,owner,order.order_id,[p]);
    const request={request_id:uid(),amount_fen:2500},pending=await requestPaymentRefund(pool,owner,order.order_id,request,[p]);
    assert.equal(pending.state,'processing');assert.deepEqual(await creditBalance(pool,owner),{available:7500,frozen:2500});
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_payment_refund_events WHERE refund_id=$1 AND kind='succeeded'",[pending.refund_id])).rows[0].n,0);
    buyerEvidence=true;assert.equal((await refreshPaymentRefund(pool,owner,pending.refund_id,[p])).state,'succeeded');
    assert.equal((await requestPaymentRefund(pool,owner,order.order_id,request,[p])).refund_id,pending.refund_id);assert.equal(refundCalls,1);
    assert.deepEqual(await creditBalance(pool,owner),{available:7500,frozen:0});
    assert.equal((await pool.query("SELECT sum(cash_refunded_fen)::int n FROM bb_payment_refund_events WHERE refund_id=$1 AND kind='succeeded'",[pending.refund_id])).rows[0].n,2500);
    assert.equal((await auditCredits(pool)).consistent,true);
  }finally{await pool.end();}
});
