import assert from 'node:assert/strict';
import { createHmac,randomUUID,timingSafeEqual } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import { creditBalance } from './billing.js';
import { auditCredits } from './billing-ops.js';
import type { PaymentProvider,VerifiedPayment } from './payments.js';

const connection=await isolatedTestDatabase(undefined,'m2-payments');
test('synthetic signed provider: forged/mismatched/replayed callbacks and query-based credit repair', {skip:!connection,timeout:60000},async()=>{
  const pool=new Pool({connectionString:connection});let actor='synthetic-payment-owner';
  const key=randomUUID(),sign=(body:string)=>createHmac('sha256',key).update(body).digest('hex');
  const receipts=new Map<string,VerifiedPayment>();let creates=0;
  // Test-only adapter. No real merchant, transaction or payment is represented.
  const provider:PaymentProvider={name:'alipay',merchantId:'synthetic-merchant',acknowledgement:{accepted:true},
    create:async order=>{creates++;receipts.set(order.id,{orderId:order.id,merchantId:order.merchant_id,amountFen:order.amount_fen,currency:'CNY',transactionId:null,state:'pending'});return {checkoutUrl:`https://synthetic.invalid/pay/${order.id}`};},
    query:async order=>receipts.get(order.id)!,
    verifyCallback:async(headers,raw)=>{const signature=String(headers['x-synthetic-signature']??'');
      if(signature.length!==64||!timingSafeEqual(Buffer.from(signature),Buffer.from(sign(raw))))throw Error('bad synthetic signature');return JSON.parse(raw);}};
  const app=createServer({pool,enablePaidAuthoring:true,paymentProviders:[provider],allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:actor,csrfVerified:true})});
  const send=(method:string,url:string,payload?:any,headers:Record<string,string>={})=>app.inject({method:method as any,url,payload,headers:{origin:'http://bondbuddy.test',...headers}});
  const callback=(receipt:VerifiedPayment,valid=true)=>{const raw=JSON.stringify(receipt);return send('POST','/api/v1/payments/alipay/callback',raw,{'content-type':'application/json','x-synthetic-signature':valid?sign(raw):'0'.repeat(64)});};
  try{
    await pool.query("INSERT INTO bb_users(id,username) VALUES($1,'synthetic_payments')",[actor]);
    const request={request_id:'synthetic-order-1',provider:'alipay',pack_id:'cny500'};
    const first=await send('POST','/api/v1/credits/recharge-orders',request);assert.equal(first.statusCode,201,first.body);
    const order=first.json();assert.equal(order.amount_fen,50000);assert.equal(order.points,52500);
    await assert.rejects(()=>pool.query('UPDATE bb_recharge_orders SET points=1 WHERE id=$1',[order.order_id]),/values are locked/);
    assert.equal((await send('POST','/api/v1/credits/recharge-orders',request)).json().order_id,order.order_id);assert.equal(creates,1);
    assert.equal((await send('POST','/api/v1/credits/recharge-orders',{...request,pack_id:'cny50'})).statusCode,409);
    const paid={...receipts.get(order.order_id)!,state:'paid' as const,transactionId:'synthetic-txn-1'};
    assert.equal((await callback(paid,false)).statusCode,401);
    assert.equal((await callback({...paid,amountFen:1})).statusCode,422);
    assert.equal((await callback({...paid,merchantId:'foreign-merchant'})).statusCode,422);
    assert.deepEqual(await creditBalance(pool,actor),{available:0,frozen:0});
    const duplicate=await Promise.all([callback(paid),callback(paid)]);duplicate.forEach(r=>assert.equal(r.statusCode,200,r.body));
    assert.deepEqual(await creditBalance(pool,actor),{available:52500,frozen:0});
    await callback({...paid,state:'expired'});
    assert.equal((await send('GET',`/api/v1/credits/recharge-orders/${order.order_id}`)).json().state,'paid');
    const second=(await send('POST','/api/v1/credits/recharge-orders',{...request,request_id:'synthetic-order-2',pack_id:'cny50'})).json();
    const paid2={...receipts.get(second.order_id)!,state:'paid' as const,transactionId:'synthetic-txn-2'};
    await pool.query("CREATE FUNCTION synthetic_payment_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic ledger failure'; END; $$; CREATE TRIGGER synthetic_payment_fault BEFORE INSERT ON bb_credit_events FOR EACH ROW EXECUTE FUNCTION synthetic_payment_fault()");
    try{assert.equal((await callback(paid2)).statusCode,500);}finally{await pool.query('DROP TRIGGER synthetic_payment_fault ON bb_credit_events');}
    assert.equal((await send('GET',`/api/v1/credits/recharge-orders/${second.order_id}`)).json().state,'pending');
    receipts.set(second.order_id,paid2);
    assert.equal((await send('POST',`/api/v1/credits/recharge-orders/${second.order_id}/refresh`,{})).json().state,'paid');
    assert.deepEqual(await creditBalance(pool,actor),{available:57500,frozen:0});
    assert.equal(Number((await pool.query('SELECT count(*) n FROM bb_runs')).rows[0].n),0);
    assert.equal(Number((await pool.query('SELECT count(*) n FROM bb_credit_lots')).rows[0].n),2);
    actor='foreign';assert.equal((await send('GET',`/api/v1/credits/recharge-orders/${order.order_id}`)).statusCode,404);
    assert.equal((await send('POST',`/api/v1/credits/recharge-orders/${second.order_id}/refresh`,{})).statusCode,404);
    const report=await auditCredits(pool);assert.equal(report.consistent,true,JSON.stringify(report));
  }finally{await app.close();await pool.end();}
});
