import assert from 'node:assert/strict';
import { createHmac,randomUUID,timingSafeEqual } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import { creditBalance } from './billing.js';
import { auditCredits } from './billing-ops.js';
import {applyVerifiedPayment,type PaymentProvider,type VerifiedPayment} from './payments.js';

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
    const historyPending=await send('GET','/api/v1/credits/recharge-history');assert.equal(historyPending.statusCode,200,historyPending.body);assert.equal(historyPending.json().items[0].state,'pending');assert.ok(historyPending.json().items[0].created_at);
    const order=first.json();assert.equal(order.amount_fen,50000);assert.equal(order.points,52500);
    await assert.rejects(()=>pool.query('UPDATE bb_recharge_orders SET points=1 WHERE id=$1',[order.order_id]),/values are locked/);
    assert.equal((await send('POST','/api/v1/credits/recharge-orders',request)).json().order_id,order.order_id);assert.equal(creates,1);
    assert.equal((await send('POST','/api/v1/credits/recharge-orders',{...request,pack_id:'cny200'})).statusCode,409);
    const config=(await send('GET','/api/v1/credits/recharge-config')).json();
    assert.deepEqual(config.packs[0],{id:'cny200',amount_fen:20000,points:20000});
    assert.equal(config.pack_version,'recharge-20261006-v2');
    assert.equal((await send('POST','/api/v1/credits/recharge-orders',{...request,request_id:'retired-pack',pack_id:'cny50'})).statusCode,422);
    assert.equal(creates,1);
    const paid={...receipts.get(order.order_id)!,state:'paid' as const,transactionId:'synthetic-txn-1'};
    assert.equal((await callback(paid,false)).statusCode,401);
    assert.equal((await callback({...paid,amountFen:1})).statusCode,422);
    assert.equal((await callback({...paid,merchantId:'foreign-merchant'})).statusCode,422);
    assert.deepEqual(await creditBalance(pool,actor),{available:0,frozen:0});
    const duplicate=await Promise.all([callback(paid),callback(paid)]);duplicate.forEach(r=>assert.equal(r.statusCode,200,r.body));
    assert.deepEqual(await creditBalance(pool,actor),{available:52500,frozen:0});
    await callback({...paid,state:'expired'});
    assert.equal((await send('GET',`/api/v1/credits/recharge-orders/${order.order_id}`)).json().state,'paid');
    const second=(await send('POST','/api/v1/credits/recharge-orders',{...request,request_id:'synthetic-order-2',pack_id:'cny200'})).json();
    assert.equal(second.amount_fen,20000);assert.equal(second.points,20000);
    const paid2={...receipts.get(second.order_id)!,state:'paid' as const,transactionId:'synthetic-txn-2'};
    await pool.query("CREATE FUNCTION synthetic_payment_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic ledger failure'; END; $$; CREATE TRIGGER synthetic_payment_fault BEFORE INSERT ON bb_credit_events FOR EACH ROW EXECUTE FUNCTION synthetic_payment_fault()");
    try{assert.equal((await callback(paid2)).statusCode,500);}finally{await pool.query('DROP TRIGGER synthetic_payment_fault ON bb_credit_events');}
    assert.equal((await send('GET',`/api/v1/credits/recharge-orders/${second.order_id}`)).json().state,'pending');
    receipts.set(second.order_id,paid2);
    assert.equal((await send('POST',`/api/v1/credits/recharge-orders/${second.order_id}/refresh`,{})).json().state,'paid');
    assert.deepEqual(await creditBalance(pool,actor),{available:72500,frozen:0});
    assert.equal(Number((await pool.query('SELECT count(*) n FROM bb_runs')).rows[0].n),0);
    assert.equal(Number((await pool.query('SELECT count(*) n FROM bb_credit_lots')).rows[0].n),2);
    const history=(await send('GET','/api/v1/credits/recharge-history')).json();assert.equal(history.items.length,2);
    assert.equal(history.items.reduce((sum:number,r:any)=>sum+(r.state==='paid'?r.points:0),0),72500);
    assert.ok(history.items.every((r:any)=>r.credited_at&&r.state==='paid'));
    assert.ok(!JSON.stringify(history).includes('merchant')&&!JSON.stringify(history).includes('checkout'));
    const head=(await send('GET','/api/v1/credits/recharge-history?limit=1')).json();assert.ok(head.page.next_cursor);
    const tail=(await send('GET','/api/v1/credits/recharge-history?limit=1&cursor='+head.page.next_cursor)).json();
    assert.deepEqual([...head.items,...tail.items].map((r:any)=>r.order_id),history.items.map((r:any)=>r.order_id));
    actor='foreign';assert.equal((await send('GET','/api/v1/credits/recharge-history')).json().items.length,0);
    assert.equal((await send('GET','/api/v1/credits/recharge-history?cursor='+head.page.next_cursor)).statusCode,422);
    assert.equal((await send('GET',`/api/v1/credits/recharge-orders/${order.order_id}`)).statusCode,404);
    assert.equal((await send('POST',`/api/v1/credits/recharge-orders/${second.order_id}/refresh`,{})).statusCode,404);
    const report=await auditCredits(pool);assert.equal(report.consistent,true,JSON.stringify(report));
  }finally{await app.close();await pool.end();}
});

test('subscription mode closes legacy bonus-pack sales while replaying original paid and pending orders unchanged',{skip:!connection,timeout:60000},async()=>{
  const pool=new Pool({connectionString:connection}),actor=randomUUID(),receipts=new Map<string,VerifiedPayment>();let creates=0;
  const provider:PaymentProvider={name:'alipay',merchantId:'synthetic-legacy-transition',acknowledgement:{accepted:true},
    create:async order=>{creates++;receipts.set(order.id,{orderId:order.id,merchantId:order.merchant_id,amountFen:order.amount_fen,currency:'CNY',transactionId:null,state:'pending'});return{checkoutUrl:'https://synthetic.invalid/transition/'+order.id};},
    query:async order=>receipts.get(order.id)!,verifyCallback:async()=>{throw Error('Synthetic test uses verified provider seam');}};
  const settings={pool,enablePaidAuthoring:true,paymentProviders:[provider],allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:actor,csrfVerified:true})};
  let app=createServer({...settings,enableSubscriptionBilling:false,enableOutcomePricing:false});
  const send=(method:string,url:string,payload?:any)=>app.inject({method:method as any,url,payload,headers:{origin:'http://bondbuddy.test'}});
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[actor,'synthetic_transition_'+actor.slice(0,8)]);
    const paidRequest={request_id:randomUUID(),provider:'alipay',pack_id:'cny500'},pendingRequest={...paidRequest,request_id:randomUUID(),pack_id:'cny2000'};
    const paidResponse=await send('POST','/api/v1/credits/recharge-orders',paidRequest);assert.equal(paidResponse.statusCode,201,paidResponse.body);
    const pendingResponse=await send('POST','/api/v1/credits/recharge-orders',pendingRequest);assert.equal(pendingResponse.statusCode,201,pendingResponse.body);
    const paid=paidResponse.json(),pending=pendingResponse.json();
    await applyVerifiedPayment(pool,provider,{...receipts.get(paid.order_id)!,state:'paid',transactionId:'synthetic-transition-paid'});
    await app.close();app=createServer({...settings,enableSubscriptionBilling:true});
    const config=(await send('GET','/api/v1/credits/recharge-config')).json();assert.equal(config.enabled,false);assert.deepEqual(config.packs,[]);assert.deepEqual(config.providers,[]);
    for(const pack_id of ['cny200','cny500','cny2000','cny10000']){
      const blocked=await send('POST','/api/v1/credits/recharge-orders',{...paidRequest,request_id:randomUUID(),pack_id});
      assert.equal(blocked.statusCode,503,blocked.body);
    }
    for(const [request,original] of [[paidRequest,paid],[pendingRequest,pending]] as const){
      const replay=await send('POST','/api/v1/credits/recharge-orders',request);assert.equal(replay.statusCode,201,replay.body);
      assert.equal(replay.json().order_id,original.order_id);assert.equal(replay.json().amount_fen,original.amount_fen);assert.equal(replay.json().points,original.points);
    }
    assert.equal(creates,2,'legacy replays do not create new channel orders');
    assert.equal((await send('POST','/api/v1/credits/recharge-orders',{...paidRequest,pack_id:'cny200'})).statusCode,409,'existing request terms remain immutable');
    receipts.set(pending.order_id,{...receipts.get(pending.order_id)!,state:'paid',transactionId:'synthetic-transition-pending'});
    assert.equal((await send('POST',`/api/v1/credits/recharge-orders/${pending.order_id}/refresh`,{})).json().state,'paid');
    assert.deepEqual(await creditBalance(pool,actor),{available:52500+220000,frozen:0},'the accepted old bonuses remain intact');
    const topup=await send('POST','/api/v1/commerce/topups',{request_id:randomUUID(),provider:'alipay',amount_fen:50000});assert.equal(topup.statusCode,201,topup.body);
    assert.equal(topup.json().amount_fen,50000);assert.equal(topup.json().points,50000,'all new topups use one yuan per 100 points');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_recharge_orders WHERE owner_user_id=$1',[actor])).rows[0].n,3);
  }finally{await app.close();await pool.end();}
});
