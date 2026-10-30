import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';
import {Pool} from 'pg';
import Fastify from 'fastify';
import {AUTOMATIC_TASK_SKUS,AUTOMATIC_PRICE_VERSION,LEGACY_BASE_COST_VERSION,standardCostBaseFen,standardCostPoints} from '@bondbuddy/contracts';
import {createBillingCostVersion,createBillingPriceDraft,validateBillingPriceDraft,publishBillingPriceVersion,installBillingPriceAdmin} from './billing-price-admin.js';
import {grantBillingPermission} from './billing-permissions.js';
import {resolveAutomaticTaskPriceVersion} from './automatic-price-versions.js';
import {loadAutomaticTaskTariff,currentAutomaticPriceVersion} from './automatic-tariff-repository.js';
import {configureAutomaticBilling} from './automatic-billing-context.js';
import {requestScope,assertScopeQuote,workScopeHash} from './scope-quotations.js';
import {createSubscriptionCheckout,cancelSubscription} from './subscriptions.js';
import {applyVerifiedPayment,type PaymentProvider} from './payments.js';
import {transaction,Problem} from './data.js';
import {installCommerce} from './commerce.js';
import {isolatedTestDatabase} from './test-database.js';

// Entirely synthetic costs, users, permissions and authenticated payment receipts. No model/channel is called.
const database=await isolatedTestDatabase(undefined,'billing-price-admin');
const provider:PaymentProvider={name:'wechat',merchantId:'synthetic-price-admin',acknowledgement:{code:'SUCCESS'},
  create:async()=>({checkoutUrl:'weixin://wxpay/bizpayurl?pr=synthetic'}),query:async()=>{throw Error('Synthetic only');},verifyCallback:async()=>{throw Error('Synthetic only');}};
async function user(pool:Pool){const owner=randomUUID(),project=randomUUID();await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'price_'+owner.slice(0,8)]);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic review','review')",[project,owner]);return{owner,project};}
async function permission(pool:Pool,owner:string,p:'price_draft'|'price_publish'){return grantBillingPermission(pool,{requestId:randomUUID(),userId:owner,permission:p,actor:'synthetic-test',reason:'Synthetic permission fixture'});}
const request=(key:string)=>({task:'full_review',request:{operation:'full_review',execution_request_id:key,source_report_id:null,finding_ids:[]},review_draft:{source_material_ref:{material_id:'synthetic',material_version:1,sha256:'a'.repeat(64)},material_versions:[],requirements:[]}});
const quote=(pool:Pool,u:Awaited<ReturnType<typeof user>>,key:string)=>transaction(pool,c=>{const snapshot=request(key);return requestScope(c,u.owner,u.project,'review',workScopeHash(snapshot),snapshot);});
const costInput=()=>({request_id:randomUUID(),rows:AUTOMATIC_TASK_SKUS.map((sku,index)=>({sku,planned_cost_cny:`${index+1}.000000000001`,source:'Synthetic cost for testing only; not the approved budget'})),change_reason:'Synthetic cost fixture'});
async function pay(pool:Pool,id:string){await applyVerifiedPayment(pool,provider,{orderId:id,merchantId:provider.merchantId,amountFen:19900,currency:'CNY',transactionId:'synthetic-'+id,state:'paid',payerCash:{amountFen:19900,currency:'CNY'}});}

test('complete API price lifecycle changes future real quotes, preserves paid contracts, and rolls back through a future version',{skip:!database},async()=>{
  const pool=new Pool({connectionString:database});configureAutomaticBilling(pool,true);
  try{
    const maker=await user(pool),publisher=await user(pool),customer=await user(pool),subscriber=await user(pool),laterSubscriber=await user(pool),outsider=await user(pool);
    await permission(pool,maker.owner,'price_draft');await permission(pool,publisher.owner,'price_publish');
    const oldQuote=await quote(pool,customer,'old-valid');
    const checkout=await createSubscriptionCheckout(pool,subscriber.owner,{request_id:randomUUID(),plan_id:'light',provider:'wechat'},[provider]);await pay(pool,checkout.order.order_id);
    const costs=costInput(),costResults=await Promise.all([createBillingCostVersion(pool,maker.owner,costs),createBillingCostVersion(pool,maker.owner,costs)]);
    const cost=costResults[0].cost_version;assert.equal(costResults[1].cost_version.id,cost.id);
    await assert.rejects(createBillingCostVersion(pool,maker.owner,{...costs,change_reason:'different content'}),{code:'IDEMPOTENCY_CONFLICT'});
    const createInput={request_id:randomUUID(),base_cost_version:cost.id,multiplier_bps:'17000',change_reason:'Synthetic first managed tariff'};
    const {version:draft}=await createBillingPriceDraft(pool,maker.owner,createInput);
    assert.equal((await createBillingPriceDraft(pool,maker.owner,createInput)).version.id,draft.id);
    await assert.rejects(createBillingPriceDraft(pool,maker.owner,{...createInput,multiplier_bps:'20000'}),{code:'IDEMPOTENCY_CONFLICT'});
    assert.equal(draft.rows.length,12);assert.equal(draft.state,'DRAFT');assert.equal(draft.comparison_version,AUTOMATIC_PRICE_VERSION);
    for(const row of draft.rows){assert.equal(row.base_price_fen,standardCostBaseFen(row.planned_cost_cny!));assert.equal(row.points,standardCostPoints(row.base_price_fen,'17000'));assert.equal(typeof row.points,'string');}
    await assert.rejects(publishBillingPriceVersion(pool,publisher.owner,draft.id,{expected_checksum:draft.checksum,effective_at:new Date(Date.now()+60000).toISOString()}),/全部校验/);
    const {version:validated}=await validateBillingPriceDraft(pool,maker.owner,draft.id,{expected_checksum:draft.checksum});assert(validated.validation_checks.every(x=>x.passed));
    await assert.rejects(publishBillingPriceVersion(pool,maker.owner,draft.id,{expected_checksum:draft.checksum,effective_at:new Date(Date.now()+60000).toISOString()}),{status:404});
    await assert.rejects(publishBillingPriceVersion(pool,publisher.owner,draft.id,{expected_checksum:'f'.repeat(64),effective_at:new Date(Date.now()+60000).toISOString()}),/价格内容/);
    await assert.rejects(publishBillingPriceVersion(pool,publisher.owner,draft.id,{expected_checksum:draft.checksum,effective_at:new Date(Date.now()-1000).toISOString()}),/未来/);
    const when=new Date(Date.now()+1200).toISOString();
    await publishBillingPriceVersion(pool,publisher.owner,draft.id,{expected_checksum:draft.checksum,effective_at:when});
    assert.equal(await currentAutomaticPriceVersion(pool),AUTOMATIC_PRICE_VERSION,'a scheduled price cannot leak into current tasks');
    await assert.rejects(loadAutomaticTaskTariff(pool,draft.id as any),{code:'BILLING_NOT_READY'});
    await setTimeout(Math.max(0,Date.parse(when)-Date.now()+30));
    assert.equal(await resolveAutomaticTaskPriceVersion(pool,customer.owner),draft.id);
    const after=await quote(pool,customer,'new-version');assert.equal(after.price_version,draft.id);assert.equal(String(after.amount_fen),draft.rows.find(r=>r.sku==='full_review')!.points);
    const oldAgain=await quote(pool,customer,'old-valid');assert.equal(oldAgain.scope_quote_id,oldQuote.scope_quote_id);assert.equal(oldAgain.amount_fen,27195);
    await transaction(pool,c=>assertScopeQuote(c,oldQuote.scope_quote_id,customer.owner,customer.project,'review',workScopeHash(request('old-valid')),27195));
    assert.equal(await resolveAutomaticTaskPriceVersion(pool,subscriber.owner),AUTOMATIC_PRICE_VERSION,'paid subscription month pins the original version');
    await cancelSubscription(pool,subscriber.owner,checkout.subscription.id,randomUUID(),[provider]);assert.equal(await resolveAutomaticTaskPriceVersion(pool,subscriber.owner),AUTOMATIC_PRICE_VERSION);
    const newCheckout=await createSubscriptionCheckout(pool,laterSubscriber.owner,{request_id:randomUUID(),plan_id:'light',provider:'wechat'},[provider]);await pay(pool,newCheckout.order.order_id);
    assert.equal(await resolveAutomaticTaskPriceVersion(pool,laterSubscriber.owner),draft.id);
    await assert.rejects(pool.query("UPDATE bb_billing_price_drafts SET multiplier_bps='20000' WHERE id=$1",[draft.id]),{code:'23514'});
    await assert.rejects(pool.query("UPDATE bb_credit_price_versions SET reason='tampered' WHERE id=$1",[draft.id]),{code:'23514'});
    await assert.rejects(pool.query("UPDATE bb_billing_cost_versions SET complete=false WHERE id=$1",[cost.id]),{code:'23514'});
    const app=Fastify();app.setErrorHandler((e,_r,reply)=>reply.code(e instanceof Problem?e.status:500).send({message:e instanceof Error?e.message:String(e)}));
    installBillingPriceAdmin(app,()=>pool,async()=>maker.owner);installCommerce(app,pool,async()=>customer.owner,true,[provider]);
    try{
      const catalog=await app.inject('/api/v1/commerce/catalog');assert.equal(catalog.statusCode,200,catalog.body);assert.equal(catalog.json().items.length,12);assert.equal(catalog.json().version,draft.id);
      assert.doesNotMatch(catalog.json().items.find((r:any)=>r.code==='full_review').label,/本期原价/);
      const get=await app.inject('/api/v1/admin/price-versions/'+draft.id);assert.equal(get.statusCode,200,get.body);assert.equal(get.json().version.rows.length,12);
      const numeric=await app.inject({method:'POST',url:'/api/v1/admin/price-versions',payload:{request_id:randomUUID(),base_cost_version:cost.id,multiplier_bps:17000,change_reason:'must reject numeric'}});assert.equal(numeric.statusCode,422,numeric.body);
      const create=await app.inject({method:'POST',url:'/api/v1/admin/price-versions',payload:{request_id:randomUUID(),base_cost_version:cost.id,multiplier_bps:'20000',change_reason:'second independent multiplier'}});assert.equal(create.statusCode,201,create.body);
      const second=create.json().version;assert.equal(second.rows[0].points,standardCostPoints(second.rows[0].base_price_fen,'20000'));
      await validateBillingPriceDraft(pool,maker.owner,second.id,{expected_checksum:second.checksum});
      const secondAt=new Date(Date.now()+350).toISOString();await publishBillingPriceVersion(pool,publisher.owner,second.id,{expected_checksum:second.checksum,effective_at:secondAt});await setTimeout(Math.max(0,Date.parse(secondAt)-Date.now()+30));
      assert.equal(await currentAutomaticPriceVersion(pool),second.id);
      const {version:rollback}=await createBillingPriceDraft(pool,maker.owner,{request_id:randomUUID(),base_cost_version:cost.id,multiplier_bps:'17000',change_reason:'Synthetic scheduled rollback',rollback_of:draft.id});
      await validateBillingPriceDraft(pool,maker.owner,rollback.id,{expected_checksum:rollback.checksum});
      const rollbackAt=new Date(Date.now()+350).toISOString();await publishBillingPriceVersion(pool,publisher.owner,rollback.id,{expected_checksum:rollback.checksum,effective_at:rollbackAt});assert.equal(await currentAutomaticPriceVersion(pool),second.id);
      await setTimeout(Math.max(0,Date.parse(rollbackAt)-Date.now()+30));assert.equal(await currentAutomaticPriceVersion(pool),rollback.id);
      assert.equal(await resolveAutomaticTaskPriceVersion(pool,laterSubscriber.owner),draft.id,'rollback cannot replace an existing paid cycle');
      const audit=await pool.query("SELECT operation FROM bb_billing_price_audit WHERE aggregate_id=$1 ORDER BY created_at",[draft.id]);assert.deepEqual(audit.rows.map(r=>r.operation),['draft_created','validated','published']);
    }finally{await app.close();}
    await assert.rejects(createBillingCostVersion(pool,outsider.owner,costInput()),{status:404});
    const {version:legacy}=await createBillingPriceDraft(pool,maker.owner,{request_id:randomUUID(),base_cost_version:LEGACY_BASE_COST_VERSION,multiplier_bps:'17000',change_reason:'Legacy missing source cannot publish'});
    const {version:bad}=await validateBillingPriceDraft(pool,maker.owner,legacy.id,{expected_checksum:legacy.checksum});assert.equal(bad.validated_checksum,null);assert(bad.validation_checks.some(x=>x.code==='complete_cost_source'&&!x.passed));
    await assert.rejects(publishBillingPriceVersion(pool,publisher.owner,legacy.id,{expected_checksum:legacy.checksum,effective_at:new Date(Date.now()+60000).toISOString()}),/全部校验/);
  }finally{await pool.end();}
});
