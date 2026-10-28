import assert from 'node:assert/strict';
import test from 'node:test';
import {Pool} from 'pg';
import {createServer} from './server.js';
import {isolatedTestDatabase} from './test-database.js';
import {applyVerifiedPayment,type PaymentProvider,type VerifiedPayment} from './payments.js';
import {creditBalance} from './billing.js';
import {OUTCOME_PRICES,OUTCOME_PRICE_VERSION} from '@bondbuddy/contracts';

const connection=await isolatedTestDatabase(undefined,'commerce-payg');
test('synthetic PAYG: exact payment, pinned order, replay safety, isolation and honest unavailable state',{skip:!connection,timeout:60000},async()=>{
  const pool=new Pool({connectionString:connection});let actor='commerce-owner',creates=0;
  const receipts=new Map<string,VerifiedPayment>();
  const provider:PaymentProvider={name:'wechat',merchantId:'synthetic-merchant',acknowledgement:{code:'SUCCESS'},
    create:async o=>{creates++;receipts.set(o.id,{orderId:o.id,merchantId:o.merchant_id,amountFen:o.amount_fen,currency:'CNY',transactionId:null,state:'pending'});return{checkoutUrl:'weixin://wxpay/bizpayurl?pr=synthetic'};},
    query:async o=>receipts.get(o.id)!,verifyCallback:async()=>{throw Error('Use the separate signed-provider tests');}};
  const app=createServer({pool,enableOutcomePricing:true,paymentProviders:[provider],allowedOrigin:'http://commerce.test',principal:async()=>({userId:actor,csrfVerified:true})});
  const send=(method:string,url:string,payload?:any)=>app.inject({method:method as any,url,payload,headers:{origin:'http://commerce.test'}});
  try{
    await pool.query("INSERT INTO bb_users(id,username) VALUES('commerce-owner','synthetic_commerce_owner'),('commerce-other','synthetic_commerce_other')");
    const catalog=await send('GET','/api/v1/commerce/catalog');assert.equal(catalog.statusCode,200,catalog.body);
    assert.equal(catalog.json().version,OUTCOME_PRICE_VERSION);assert.equal(catalog.json().model,'pay_as_you_go');
    const items=catalog.json().items;
    for(const [code,price] of Object.entries(OUTCOME_PRICES))assert.equal(items.find((x:any)=>x.code===code)?.price_fen,price,code);
    assert.equal(items.some((x:any)=>x.code==='prospectus_first_draft'),false,'First draft requires actual business-scope classification rather than a flat 599-yuan SKU');
    assert.equal(items.find((x:any)=>x.code==='integrity_check').price_fen,null);assert.equal(items.find((x:any)=>x.code==='integrity_check').capability,'unavailable');
    assert.equal((await send('GET','/api/v1/credits/recharge-config')).json().enabled,false,'New mode must not sell legacy bonus packs');
    assert.equal((await send('POST','/api/v1/credits/recharge-orders',{request_id:'legacy-bonus',provider:'wechat',pack_id:'cny500'})).statusCode,503);
    const request={request_id:'exact-980',provider:'wechat',amount_fen:980};
    const first=await send('POST','/api/v1/commerce/topups',request);assert.equal(first.statusCode,201,first.body);
    const order=first.json();assert.equal(order.amount_fen,980);assert.equal(order.points,980);
    assert.equal((await send('POST','/api/v1/commerce/topups',request)).json().order_id,order.order_id);assert.equal(creates,1);
    assert.equal((await send('POST','/api/v1/commerce/topups',{...request,amount_fen:990})).statusCode,409);
    assert.equal((await send('POST','/api/v1/commerce/topups',{...request,request_id:'fractional',amount_fen:9.8})).statusCode,422);
    assert.deepEqual(await creditBalance(pool,actor),{available:0,frozen:0});
    const paid={...receipts.get(order.order_id)!,state:'paid' as const,transactionId:'synthetic-payg-transaction'};
    await assert.rejects(applyVerifiedPayment(pool,provider,{...paid,amountFen:981}));
    await Promise.all([applyVerifiedPayment(pool,provider,paid),applyVerifiedPayment(pool,provider,paid)]);
    const account=(await send('GET','/api/v1/commerce/account')).json();assert.equal(account.available_fen,980);assert.equal(account.held_fen,0);assert.equal(account.payment_enabled,true);
    assert.equal(Number((await pool.query('SELECT count(*) n FROM bb_runs')).rows[0].n),0,'Funding must not execute a task');
    actor='commerce-other';assert.equal((await send('GET',`/api/v1/commerce/topups/${order.order_id}`)).statusCode,404);
    assert.equal((await send('POST',`/api/v1/commerce/topups/${order.order_id}/refresh`,{})).statusCode,404);
    assert.equal((await send('POST','/api/v1/commerce/feedback',{request_id:'foreign',run_id:'absent',outcome:'adopted'})).statusCode,404);
    const disabled=createServer({pool,enableOutcomePricing:true,paymentProviders:[],allowedOrigin:'http://commerce.test',principal:async()=>({userId:actor,csrfVerified:true})});
    try{
      assert.equal((await disabled.inject({url:'/api/v1/commerce/account'})).json().payment_enabled,false);
      assert.equal((await disabled.inject({method:'POST',url:'/api/v1/commerce/topups',headers:{origin:'http://commerce.test'},payload:{...request,request_id:'not-configured'}})).statusCode,503);
    }finally{await disabled.close();}
  }finally{await app.close();await pool.end();}
});
