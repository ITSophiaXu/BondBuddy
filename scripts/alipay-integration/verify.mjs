import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {request} from 'node:http';
import {join} from 'node:path';
import {Pool} from 'pg';
import {client} from './http.mjs';
import {baseURL,apiURL,terms,runtime,atomicJson,databaseURL,config,cleanEnvironment} from './config.mjs';
import {assertDatabase} from './database.mjs';

const send=client(),checks=[],testUser='alipay_qa_'+randomUUID().slice(0,8),startedAt=new Date().toISOString();
const check=(name,work)=>{work();checks.push(name);};
async function hostStatus(url){return new Promise((resolve,reject)=>{const r=request(url,{headers:{host:'untrusted.example'}},response=>{response.resume();resolve(response.statusCode);});r.on('error',reject);r.end();});}
const account=()=>send('GET','/api/v1/subscriptions/account');
try{
  const cleaned=cleanEnvironment({DATABASE_URL:'production',BB_ALIPAY_APP_PRIVATE_KEY:'production',AWS_SECRET_ACCESS_KEY:'production',NODE_OPTIONS:'production',PATH:'test'});
  check('ambient production and runtime credentials removed',()=>{for(const key of ['DATABASE_URL','BB_ALIPAY_APP_PRIVATE_KEY','AWS_SECRET_ACCESS_KEY','NODE_OPTIONS'])assert.equal(cleaned[key],undefined);assert.equal(cleaned.BB_ALIPAY_ENVIRONMENT,'sandbox');});
  check('API rejects untrusted Host',()=>{});assert.equal(await hostStatus(apiURL+'/__alipay-test/status'),403);
  assert.equal(await hostStatus(baseURL+'/'),403);checks.push('web rejects untrusted Host');
  await send('GET','/api/v1/subscriptions/account',undefined,{expected:401});checks.push('anonymous account access denied');
  const identity=await send('POST','/api/v1/auth/register',{username:testUser,password:'Local-Alipay-QA-2026!',accepted_terms_version:terms});
  assert.equal((await account()).available_points,'0');checks.push('real product registration starts with zero points');
  const catalog=await send('GET','/api/v1/subscriptions/catalog');
  check('only real Alipay provider, no automatic debit',()=>{assert.equal(catalog.enabled,true);assert.deepEqual(catalog.providers,['alipay']);assert.equal(catalog.auto_renew_available,false);});
  const input={request_id:randomUUID(),plan_id:'light',provider:'alipay',billing_cycle:'monthly'};
  await send('POST','/api/v1/subscriptions',input,{headers:{'x-bb-csrf':''},expected:403});checks.push('missing CSRF cannot create checkout');
  await send('POST','/api/v1/subscriptions',input,{headers:{origin:'http://untrusted.example'},expected:403});checks.push('foreign Origin cannot create checkout');
  const checkout=await send('POST','/api/v1/subscriptions',input),order=checkout.order;
  const url=new URL(order.checkout_url),biz=JSON.parse(url.searchParams.get('biz_content'));
  check('real product checkout targets sandbox and retains original tariff',()=>{
    assert.equal(order.state,'pending');assert.equal(String(order.amount_fen),'19900');assert.equal(String(order.points),'21000');
    assert.equal(url.origin,'https://openapi-sandbox.dl.alipaydev.com');assert.equal(url.searchParams.get('method'),'alipay.trade.page.pay');
    assert.equal(biz.total_amount,'199.00');assert.equal(biz.out_trade_no,order.order_id);assert.equal(url.searchParams.get('return_url'),baseURL+'/payment/alipay/return.html');
  });
  const replay=await send('POST','/api/v1/subscriptions',input);
  assert.equal(replay.order.order_id,order.order_id);checks.push('same checkout request reuses original order');
  const foreign=client();await foreign('POST','/api/v1/auth/register',{username:'alipay_qa_'+randomUUID().slice(0,8),password:'Local-Alipay-QA-2026!',accepted_terms_version:terms});
  await foreign('GET','/api/v1/commerce/topups/'+order.order_id,undefined,{expected:404});checks.push('foreign user cannot read order');
  const fakeReturn=await fetch(baseURL+'/payment/alipay/return.html?trade_status=TRADE_SUCCESS&total_amount=199.00');
  assert.equal(fakeReturn.status,200);assert.ok((await fakeReturn.text()).includes('打开此页面不代表付款成功'));
  assert.equal((await account()).available_points,'0');checks.push('unsigned return parameters cannot grant points');
  const fakeNotify=await fetch(baseURL+'/api/v1/payments/alipay/callback',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'sign_type=RSA2&sign=eA%3D%3D&trade_status=TRADE_SUCCESS'});
  assert.equal(fakeNotify.status,401);assert.equal(await fakeNotify.text(),'fail');checks.push('invalid callback signature rejected with fail');
  const pending=await send('GET','/api/v1/commerce/topups/'+order.order_id);assert.equal(pending.state,'pending');assert.equal((await account()).available_points,'0');checks.push('unpaid order does not activate or credit');
  const db=new Pool({connectionString:databaseURL});try{
    await assertDatabase(db,config());
    const counts=(await db.query('SELECT (SELECT count(*)::int FROM bb_recharge_orders WHERE owner_user_id=$1) orders,(SELECT count(*)::int FROM bb_credit_lots WHERE owner_user_id=$1) lots',[identity.user_id])).rows[0];
    assert.deepEqual(counts,{orders:1,lots:0});checks.push('PostgreSQL persists one pending order and no credit lot');
  }finally{await db.end();}
  const result={startedAt,finishedAt:new Date().toISOString(),realProductApi:true,realPostgres:true,channel:'alipay-sandbox',buyerPaymentCompleted:false,checks,passed:checks.length,failed:0};
  atomicJson(join(runtime,'http-verification.json'),result);console.log(JSON.stringify(result));
}catch(error){atomicJson(join(runtime,'http-verification.json'),{startedAt,checks,failed:1,message:error.message});throw error;}
