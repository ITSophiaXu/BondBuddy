import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import Fastify from 'fastify';
import {AUTOMATIC_PRICE_VERSION,LEGACY_AUTOMATIC_PRICE_VERSION,automaticTaskTariff} from '@bondbuddy/contracts';
import {configureAutomaticBilling,withAutomaticBilling} from './automatic-billing-context.js';
import {resolveAutomaticTaskPriceVersion} from './automatic-price-versions.js';
import {requestScope,assertScopeQuote,workScopeHash} from './scope-quotations.js';
import {createSubscriptionCheckout,cancelSubscription} from './subscriptions.js';
import {applyVerifiedPayment,type PaymentProvider} from './payments.js';
import {transaction} from './data.js';
import {isolatedTestDatabase} from './test-database.js';
import {installCommerce} from './commerce.js';

// Isolated PostgreSQL, synthetic historic orders and authenticated-adapter receipts.
// No payment channel or model is contacted; historical terms are inserted once, never rewritten.
const database=await isolatedTestDatabase(undefined,'automatic-price-versions');
const provider:PaymentProvider={name:'wechat',merchantId:'synthetic-price-version',acknowledgement:{code:'SUCCESS'},
  create:async()=>({checkoutUrl:'weixin://wxpay/bizpayurl?pr=synthetic-version'}),
  query:async()=>{throw Error('Synthetic receipt is provided explicitly');},
  verifyCallback:async()=>{throw Error('No external callback in synthetic test');}};
async function fixture(pool:Pool){
  const owner=randomUUID(),project=randomUUID();
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_version_'+owner.slice(0,8)]);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic version review','review')",[project,owner]);
  return{owner,project};
}
async function pay(pool:Pool,orderId:string){
  await applyVerifiedPayment(pool,provider,{orderId,merchantId:provider.merchantId,amountFen:19900,currency:'CNY',transactionId:'synthetic-'+orderId,state:'paid',payerCash:{amountFen:19900,currency:'CNY'}});
}
async function historicOrder(pool:Pool,owner:string){
  const subscription=randomUUID(),order=randomUUID().replaceAll('-',''),period=randomUUID();
  await transaction(pool,async c=>{
    await c.query("INSERT INTO bb_subscriptions(id,owner_user_id,plan_id,provider,merchant_id,task_price_version) VALUES($1,$2,'light','wechat',$3,$4)",[subscription,owner,provider.merchantId,LEGACY_AUTOMATIC_PRICE_VERSION]);
    await c.query(`INSERT INTO bb_recharge_orders(id,owner_user_id,request_id,request_hash,provider,pack_id,pack_version,amount_fen,points,currency,merchant_id,expires_at,order_kind)
      VALUES($1,$2,$3,$4,'wechat','subscription_light','bb-subscriptions-20261029-v1',19900,21000,'CNY',$5,now()+interval '30 minutes','subscription')`,[order,owner,randomUUID(),'a'.repeat(64),provider.merchantId]);
    await c.query(`INSERT INTO bb_subscription_periods(id,owner_user_id,subscription_id,cycle_index,order_id,plan_id,catalog_version,amount_fen,points,task_price_version,automatic)
      VALUES($1,$2,$3,1,$4,'light','bb-subscriptions-20261029-v1',19900,21000,$5,false)`,[period,owner,subscription,order,LEGACY_AUTOMATIC_PRICE_VERSION]);
  });
  return{subscription,order,period};
}
const snapshot=(key:string)=>({task:'full_review',request:{operation:'full_review',execution_request_id:key,source_report_id:null,finding_ids:[]},
  review_draft:{source_material_ref:{material_id:'synthetic-source',material_version:1,sha256:'b'.repeat(64)},material_versions:[],requirements:[]}});
const quote=(pool:Pool,f:Awaited<ReturnType<typeof fixture>>,key:string)=>transaction(pool,c=>{
  const input=snapshot(key);return requestScope(c,f.owner,f.project,'review',workScopeHash(input),input);
});
async function catalog(pool:Pool,owner:string){
  const app=Fastify();installCommerce(app,pool,async()=>owner,true,[provider]);
  try{const response=await app.inject('/api/v1/commerce/catalog');assert.equal(response.statusCode,200,response.body);assert.equal(response.headers['cache-control'],'private, no-store');return response.json();}
  finally{await app.close();}
}

test('a paid v2 subscription and cancellation retain v2 task prices after v3 release',{skip:!database},async()=>{
  const pool=new Pool({connectionString:database});configureAutomaticBilling(pool,true);
  try{
    const f=await fixture(pool),old=await historicOrder(pool,f.owner);
    assert.equal(await resolveAutomaticTaskPriceVersion(pool,f.owner),AUTOMATIC_PRICE_VERSION,'unpaid period does not grant price protection');
    await pay(pool,old.order);
    assert.equal(await resolveAutomaticTaskPriceVersion(pool,f.owner),LEGACY_AUTOMATIC_PRICE_VERSION);
    const originalCatalog=await catalog(pool,f.owner);assert.equal(originalCatalog.version,LEGACY_AUTOMATIC_PRICE_VERSION);assert.equal(originalCatalog.items.length,12);
    assert.equal(originalCatalog.items.find((item:any)=>item.code==='full_review').price_points,14900);assert.match(originalCatalog.items.find((item:any)=>item.code==='full_review').label,/本期原价/);
    const first=await quote(pool,f,'first');assert.equal(first.price_version,LEGACY_AUTOMATIC_PRICE_VERSION);assert.equal(first.amount_fen,14900);
    await cancelSubscription(pool,f.owner,old.subscription,randomUUID(),[provider]);
    const next=await quote(pool,f,'after-cancel');assert.equal(next.price_version,LEGACY_AUTOMATIC_PRICE_VERSION);assert.equal(next.amount_fen,14900);
    assert.equal((await catalog(pool,f.owner)).version,LEGACY_AUTOMATIC_PRICE_VERSION,'cancelled renewal keeps current paid catalog prices');
    await assert.rejects(pool.query('UPDATE bb_subscription_periods SET task_price_version=$2 WHERE id=$1',[old.period,AUTOMATIC_PRICE_VERSION]),{code:'23514'});
    assert.equal((await pool.query('SELECT task_price_version FROM bb_subscription_periods WHERE id=$1',[old.period])).rows[0].task_price_version,LEGACY_AUTOMATIC_PRICE_VERSION);
  }finally{await pool.end();}
});

test('new non-subscribers and new paid subscriptions use the published v3 comprehensive review tariff',{skip:!database},async()=>{
  const pool=new Pool({connectionString:database});configureAutomaticBilling(pool,true);
  try{
    const f=await fixture(pool),price=automaticTaskTariff(AUTOMATIC_PRICE_VERSION).full_review.points;
    const first=await quote(pool,f,'no-subscription');assert.equal(first.price_version,AUTOMATIC_PRICE_VERSION);assert.equal(first.amount_fen,price);
    const newCatalog=await catalog(pool,f.owner);assert.equal(newCatalog.version,AUTOMATIC_PRICE_VERSION);assert.equal(newCatalog.items.length,12);
    assert.equal(newCatalog.items.find((item:any)=>item.code==='full_review').price_points,27195);assert.doesNotMatch(newCatalog.items.find((item:any)=>item.code==='full_review').label,/本期原价/);
    assert.match(newCatalog.items.find((item:any)=>item.code==='full_review').scope.join(' '),/复核报告及批注/);
    assert.match(newCatalog.items.find((item:any)=>item.code==='full_review').scope.join(' '),/原文修订各按14,900积分独立计费/);
    assert.deepEqual(newCatalog.items.find((item:any)=>item.code==='full_review').included,['本轮复核报告与批注的修复、平台重试包含在任务内。']);
    const order=await createSubscriptionCheckout(pool,f.owner,{request_id:randomUUID(),plan_id:'light',provider:'wechat'},[provider]);
    await pay(pool,order.order.order_id);
    const second=await quote(pool,f,'new-subscription');assert.equal(second.price_version,AUTOMATIC_PRICE_VERSION);assert.equal(second.amount_fen,price);
    assert.equal((await catalog(pool,f.owner)).version,AUTOMATIC_PRICE_VERSION);
    const versions=(await pool.query('SELECT id,prices FROM bb_credit_price_versions WHERE id=ANY($1::text[])',[[LEGACY_AUTOMATIC_PRICE_VERSION,AUTOMATIC_PRICE_VERSION]])).rows;
    assert.equal(versions.find(r=>r.id===LEGACY_AUTOMATIC_PRICE_VERSION).prices.full_review,14900);
    assert.equal(versions.find(r=>r.id===AUTOMATIC_PRICE_VERSION).prices.full_review,price);
  }finally{await pool.end();}
});

test('an unexpired v2 quote keeps its immutable price and remains executable after v3 release',{skip:!database},async()=>{
  const pool=new Pool({connectionString:database});configureAutomaticBilling(pool,true);
  try{
    const f=await fixture(pool),input=snapshot('existing-v2'),hash=workScopeHash(input);
    const old=await transaction(pool,c=>withAutomaticBilling(c,true,()=>requestScope(c,f.owner,f.project,'review',hash,input),LEGACY_AUTOMATIC_PRICE_VERSION));
    const current=await quote(pool,f,'existing-v2');assert.equal(current.scope_quote_id,old.scope_quote_id);assert.equal(current.price_version,LEGACY_AUTOMATIC_PRICE_VERSION);assert.equal(current.amount_fen,14900);
    const accepted=await transaction(pool,c=>assertScopeQuote(c,old.scope_quote_id,f.owner,f.project,'review',hash,14900));
    assert.equal(accepted.price_version,LEGACY_AUTOMATIC_PRICE_VERSION);
    await assert.rejects(pool.query('UPDATE bb_scope_quotations SET price_version=$2 WHERE id=$1',[old.scope_quote_id,AUTOMATIC_PRICE_VERSION]),{code:'23514'});
  }finally{await pool.end();}
});

test('stored batch price protection is scoped to its transaction callback and survives current-price changes',{skip:!database},async()=>{
  const pool=new Pool({connectionString:database});configureAutomaticBilling(pool,true);
  try{
    const f=await fixture(pool);
    await transaction(pool,async c=>{
      assert.equal(await resolveAutomaticTaskPriceVersion(c,f.owner),AUTOMATIC_PRICE_VERSION);
      await withAutomaticBilling(c,true,async()=>assert.equal(await resolveAutomaticTaskPriceVersion(c,f.owner),LEGACY_AUTOMATIC_PRICE_VERSION),LEGACY_AUTOMATIC_PRICE_VERSION);
      assert.equal(await resolveAutomaticTaskPriceVersion(c,f.owner),AUTOMATIC_PRICE_VERSION);
      await assert.rejects(withAutomaticBilling(c,true,async()=>{throw Error('synthetic batch failure');},LEGACY_AUTOMATIC_PRICE_VERSION),/synthetic batch failure/);
      assert.equal(await resolveAutomaticTaskPriceVersion(c,f.owner),AUTOMATIC_PRICE_VERSION);
    });
  }finally{await pool.end();}
});
