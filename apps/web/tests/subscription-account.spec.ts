import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect,test,type Page,type Route} from '@playwright/test';
import Fastify from 'fastify';
import type {Pool} from 'pg';
import {installSubscriptions} from '../../api/dist/subscriptions.js';
import {AUTOMATIC_PRICE_VERSION,LEGACY_AUTOMATIC_PRICE_VERSION,automaticTaskTariff,DATA_POLICY_VERSION,DELETION_PURGED_CONTENT,DELETION_RETAINED_METADATA,type AutomaticPriceVersion,type DataPolicy,type SubscriptionCatalog,encodeBillingDto,type BillingWireDtoName,AUTOMATIC_TASK_TERMS,type AutomaticTaskSku} from '@bondbuddy/contracts';

// Synthetic HTTP and UI evidence. No merchant, mandate, cash transfer or professional task is executed.
const now='2026-10-29T04:00:00Z',end='2026-11-29T04:00:00Z',expiry='2027-01-27T04:00:00Z';
const plans=[{id:'light',label:'轻量',amount_fen:19900,annual_amount_fen:214920,points:21000,period_months:1,credit_valid_days:90},{id:'professional',label:'专业',amount_fen:49900,annual_amount_fen:538920,points:55000,period_months:1,credit_valid_days:90},{id:'intensive',label:'密集',amount_fen:99900,annual_amount_fen:1078920,points:114000,period_months:1,credit_valid_days:90}];
const policy:DataPolicy={policy_version:DATA_POLICY_VERSION,storage_location:'platform_private_cloud',server_side_processing:true,model_provider_processing:true,active_retention:'until_user_deletes',purge_enabled:false,deleted_content_purge_days:null,orphan_upload_purge_hours:null,log_content_retention_days:30,backup_retention_days:null,pinned_by_active_run:'retained_until_run_ends',purged_content:[...DELETION_PURGED_CONTENT],retained_metadata:[...DELETION_RETAINED_METADATA]};
// New-client fixtures use the explicit decimal-string wire format even when
// synthetic domain inputs below use small safe integers for readability.
const responseFamily=(path:string,method:string):BillingWireDtoName|undefined=>{
  if(path==='/subscriptions/catalog')return 'subscriptionCatalog';
  if(path==='/subscriptions/account')return 'subscriptionAccount';
  if(path==='/commerce/catalog')return 'commerceCatalog';
  if(path==='/commerce/quotations')return 'scopeQuotationList';
  if(path==='/credits/consumption-history')return 'consumptionHistory';
  if(path==='/credits/recharge-history')return 'rechargeHistory';
  if((path==='/subscriptions'||/^\/subscriptions\/[^/]+\/renew$/.test(path))&&method==='POST')return 'subscriptionCheckout';
  if(path.endsWith('/auto-renew')||path.endsWith('/auto-renew/refresh'))return 'subscriptionAutoRenew';
  if(path.endsWith('/cancel')&&path.startsWith('/subscriptions/'))return 'subscription';
  if(path.startsWith('/commerce/topups'))return path.endsWith('/refund-eligibility')?'refundEligibility':path.endsWith('/refunds')||path.includes('/refunds/')?'refund':'rechargeOrder';
  return undefined;
};
const json=(route:Route,status:number,body:unknown)=>{const path=new URL(route.request().url()).pathname.replace('/api/v1',''),family=responseFamily(path,route.request().method());return route.fulfill({status,contentType:'application/json',body:JSON.stringify(status<400&&family?encodeBillingDto(family,body):body)});};
async function evidence(page:Page,name:string){const directory=process.env.BB_UX_EVIDENCE_DIR;if(!directory)return;await mkdir(directory,{recursive:true});await page.screenshot({path:join(directory,name),fullPage:true});}
async function regionEvidence(page:Page,name:string,selector:string){const directory=process.env.BB_UX_EVIDENCE_DIR;if(!directory)return;await mkdir(directory,{recursive:true});const region=page.locator(selector);await region.evaluate(element=>element.scrollIntoView({block:'center'}));await region.screenshot({path:join(directory,name)});}
async function setup(page:Page,options:{payment?:boolean;active?:boolean;renewal?:boolean;manualActive?:boolean;uncertainCheckout?:boolean;uncertainTopup?:boolean;expired?:boolean;refundHeld?:boolean;orderPaid?:boolean;priceVersion?:AutomaticPriceVersion;subscriptionCatalog?:SubscriptionCatalog;cancelPending?:boolean;zeroTask?:boolean;periodHistoryOverflow?:boolean;periodUnavailable?:404|503;topupOrder?:boolean;annual?:boolean}={}){
  const calls:{method:string;path:string;body:any}[]=[];let attempts=0,topupAttempts=0,cancelRefreshes=0,periodUnavailable=options.periodUnavailable;
  const priceVersion=options.priceVersion??AUTOMATIC_PRICE_VERSION,tariff=automaticTaskTariff(priceVersion);
  const contractEnd=options.annual?'2027-10-29T04:00:00Z':end;
  let subscription:any=options.active||options.expired?{id:'subscription-1',plan_id:'light',status:'active',auto_renew:!!options.renewal&&!options.manualActive,mandate_status:options.renewal&&!options.manualActive?'active':'none',current_period_start:now,current_period_end:options.expired?'2026-10-28T04:00:00Z':contractEnd,task_price_version:priceVersion,billing_cycle:options.annual?'annual':'monthly',next_charge_at:options.renewal&&!options.manualActive?contractEnd:null,next_charge_amount_fen:options.renewal&&!options.manualActive?options.annual?214920:19900:null}:null;
  let order={order_id:options.topupOrder?'topup-order-1':'subscription-order-1',provider:'wechat',state:options.orderPaid||options.active?'paid':'pending',amount_fen:options.topupOrder?5000:19900,points:options.topupOrder?5000:21000,currency:'CNY',checkout_url:'weixin://wxpay/bizpayurl?pr=synthetic-subscription',project_id:null,expires_at:end,credited_at:options.orderPaid||options.active?now:null};
  const period=()=>({id:'period-1',order_id:order.order_id,plan_id:subscription?.plan_id??'light',status:order.state==='paid'?'active':'pending',amount_fen:order.amount_fen,points:order.points,available_points:options.refundHeld?0:order.state==='paid'?options.annual?21000:order.points:0,held_points:options.refundHeld?21000:0,task_held_points:0,refund_held_points:options.refundHeld?21000:0,starts_at:order.state==='paid'?now:null,ends_at:order.state==='paid'?contractEnd:null,credits_expires_at:order.state==='paid'?expiry:null,refundable_until:order.state==='paid'?'2026-11-05T04:00:00Z':null,billing_cycle:subscription?.billing_cycle??'monthly',monthly_points:plans.find(p=>p.id===subscription?.plan_id)?.points??21000,release_count:subscription?.billing_cycle==='annual'?12:1,released_count:order.state==='paid'?1:0,next_release_at:subscription?.billing_cycle==='annual'&&order.state==='paid'?end:null});
  const refunds:any[]=[];
  await page.clock.install({time:new Date(now)});
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.replace('/api/v1',''),method=request.method(),body=request.postData()?request.postDataJSON():undefined;calls.push({method,path,body});
    if(path==='/me')return json(route,200,{user_id:'subscription-owner',session_status:'active'});
    if(path==='/account')return json(route,200,{user_id:'subscription-owner',username:'sample_user',phone_masked:null,status:'active',created_at:now,accepted_terms_version:'terms-1',current_terms_version:'terms-1',password_updated_at:null,self_service_recovery:'unavailable',support_contact:null});
    if(path==='/account/sessions')return json(route,200,{items:[{session_id:'session-1',current:true,created_at:now,last_refreshed_at:now,refresh_expires_at:'2030-01-01T00:00:00Z'}]});
    if(path==='/account/recovery')return json(route,200,{enabled:false,support_operator:false,current:null,pending:null});
    if(path==='/data-policy')return json(route,200,policy);
    if(path==='/subscriptions/catalog')return json(route,200,options.subscriptionCatalog??{enabled:true,version:'bb-subscriptions-20261029-v1',plans,providers:options.payment?['wechat']:[],auto_renew_available:!!options.renewal});
    if(path==='/subscriptions/account')return json(route,200,{subscription,available_points:options.refundHeld?800:subscription&&order.state==='paid'?22000:19782,held_points:options.refundHeld?21200:subscription&&order.state==='paid'?0:1218,task_held_points:options.refundHeld?200:subscription&&order.state==='paid'?0:1218,refund_held_points:options.refundHeld?21000:0,subscription_available_points:options.refundHeld?0:subscription&&order.state==='paid'?21000:0,topup_available_points:options.refundHeld?800:subscription&&order.state==='paid'?1000:19782,other_available_points:0,periods:subscription?options.periodHistoryOverflow?Array.from({length:50},(_,index)=>({...period(),id:`newer-period-${index+1}`,order_id:`newer-order-${index+1}`})):[period()]:[]});
    if(path==='/subscriptions/orders/'+order.order_id+'/period'){
      if(periodUnavailable)return json(route,periodUnavailable,{code:periodUnavailable===404?'NOT_FOUND':'DATA_UNAVAILABLE'});
      const p=period();return json(route,200,{order_id:order.order_id,period:order.order_id.startsWith('topup-')?null:{...p,...Object.fromEntries(['amount_fen','points','available_points','held_points','task_held_points','refund_held_points','monthly_points'].map(key=>[key,String(p[key as keyof typeof p])]))}});
    }
    if(path==='/commerce/catalog')return json(route,200,{enabled:true,currency:'CNY',version:priceVersion,model:'subscription_and_topup',items:Object.entries(tariff).map(([code,item])=>({code,label:item.label+(code==='full_review'&&priceVersion===LEGACY_AUTOMATIC_PRICE_VERSION?'（本期原价）':''),unit:item.unit,price_fen:options.zeroTask&&code==='response'?0:item.points,price_points:options.zeroTask&&code==='response'?0:item.points,capability:'limited',...AUTOMATIC_TASK_TERMS[code as AutomaticTaskSku]})),rules:[]});
    if(path==='/commerce/quotations')return json(route,200,{items:[]});
    if(path==='/credits/consumption-history')return json(route,200,{items:[
      {reservation_id:'response-settled',run_id:'response-run',project_id:'project-1',project_name:'合成项目',task_name:'问题回复',created_at:now,finalized_at:now,state:'settled',reserved_points:1218,charged_points:1218,released_points:0,corrected_points:0,pricing_mode:'outcome_cny_v1',price_version:priceVersion,currency:'CNY',amount_fen:1218},
      {reservation_id:'full-review-settled',run_id:'full-review-run',project_id:'project-1',project_name:'合成项目',task_name:'独立全面复核',created_at:now,finalized_at:now,state:'settled',reserved_points:tariff.full_review.points,charged_points:tariff.full_review.points,released_points:0,corrected_points:0,pricing_mode:'outcome_cny_v1',price_version:priceVersion,currency:'CNY',amount_fen:tariff.full_review.points}],page:{next_cursor:null,has_more:false}});
    if(path==='/credits/recharge-history')return json(route,200,{items:[{order_id:order.order_id,provider:'wechat',state:'paid',amount_fen:19900,points:21000,created_at:now,credited_at:now,pricing_mode:'outcome_cny_v1',price_version:'bb-task-price-170-20261029-v2',currency:'CNY'}],page:{next_cursor:null,has_more:false}});
    if((path==='/subscriptions'||path==='/subscriptions/subscription-1/renew')&&method==='POST'){
      attempts++;
      const plan=plans.find(plan=>plan.id===body.plan_id)!;order={...order,amount_fen:body.billing_cycle==='annual'?plan.annual_amount_fen:plan.amount_fen,points:plan.points*(body.billing_cycle==='annual'?12:1)};
      subscription={id:'subscription-1',plan_id:plan.id,status:'pending',auto_renew:false,mandate_status:'none',current_period_start:null,current_period_end:null,task_price_version:AUTOMATIC_PRICE_VERSION,billing_cycle:body.billing_cycle??'monthly'};
      if(options.uncertainCheckout&&attempts===1)return json(route,500,{code:'INTERNAL_ERROR'});
      return json(route,201,{subscription,order});
    }
    if(path==='/subscriptions/subscription-1/cancel'&&method==='POST'){subscription={...subscription,status:'cancelled',auto_renew:false,mandate_status:options.cancelPending?'cancel_pending':'cancelled'};return json(route,200,subscription);}
    if(path==='/subscriptions/subscription-1/auto-renew'&&method==='POST'){subscription={...subscription,auto_renew:false,mandate_status:'pending'};return json(route,200,{subscription,authorization_url:'https://payments.example.test/mandate'});}
    if(path==='/subscriptions/subscription-1/auto-renew/refresh'&&method==='POST'){if(subscription.mandate_status==='cancel_pending'){cancelRefreshes++;subscription={...subscription,auto_renew:false,mandate_status:cancelRefreshes>1?'cancelled':'cancel_pending'};return json(route,200,{subscription,authorization_url:'https://payments.example.test/obsolete-mandate'});}subscription={...subscription,auto_renew:true,mandate_status:'active'};return json(route,200,{subscription,authorization_url:null});}
    if(path==='/commerce/topups'&&method==='POST'){topupAttempts++;order={...order,order_id:'topup-order-1',amount_fen:body.amount_fen,points:body.amount_fen};if(options.uncertainTopup&&topupAttempts===1)return json(route,503,{code:'PAYMENT_UNAVAILABLE'});return json(route,201,order);}
    if(path==='/commerce/topups/'+order.order_id+'/refund-eligibility')return json(route,200,{order_id:order.order_id,currency:'CNY',order_amount_fen:order.amount_fen,paid_amount_fen:order.amount_fen,original_points:order.points,refundable_points:refunds.length?0:order.points,refunded_points:0,request_unit:'amount_fen',refundable_fen:refunds.length?0:order.amount_fen,held_refund_fen:refunds.length?order.amount_fen:0,refunded_fen:0,enabled:true,reason:'',refunds});
    if(path==='/commerce/topups/'+order.order_id+'/refunds'&&method==='POST'){const refund={refund_id:'refund-1',order_id:order.order_id,currency:'CNY',amount_fen:body.amount_fen,credit_points:order.points,state:'requested',created_at:now,updated_at:now,completed_at:null,failure_code:null};refunds.push(refund);return json(route,202,refund);}
    if(path==='/commerce/topups/'+order.order_id||path==='/commerce/topups/'+order.order_id+'/refresh')return json(route,200,order);
    return json(route,404,{code:'NOT_FOUND'});
  });
  return{calls,settle:()=>{order={...order,state:'paid',credited_at:now};},setPeriodUnavailable:(status:404|503|undefined)=>{periodUnavailable=status;}};
}

test.beforeEach(async({page})=>page.setViewportSize({width:1440,height:960}));

test('subscription account shows point rights and disables unavailable payment capabilities',async({page})=>{
  // Use the real API route response here: a mocked enabled:true formerly hid
  // the API's provider-dependent fallback to the old cash-balance page.
  const app=Fastify();
  installSubscriptions(app,{} as Pool,async()=> 'subscription-owner',true,[]);
  let subscriptionCatalog:SubscriptionCatalog;
  try{const response=await app.inject({method:'GET',url:'/api/v1/subscriptions/catalog'});expect(response.statusCode).toBe(200);subscriptionCatalog=response.json();}finally{await app.close();}
  expect(subscriptionCatalog).toMatchObject({enabled:true,providers:[],auto_renew_available:false});
  const {calls}=await setup(page,{subscriptionCatalog});await page.goto('/#/account');
  await expect(page.locator('#account-balance-title')).toHaveText('可用积分');
  await expect(page.locator('.account-balance-value')).toHaveText('19,782积分');
  await expect(page.locator('.subscription-balance-sources')).toContainText('充值额度19,782 积分');
  await expect(page.getByRole('button',{name:'开通轻量',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'开通专业',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'开通密集',exact:true})).toBeDisabled();
  await expect(page.locator('#subscription-topup-form')).toHaveCount(0);
  await expect(page.locator('[data-record="response-settled"] .credit-history-amount')).toContainText('消耗 1,218 积分');
  await expect(page.locator('.top-plan-link')).toHaveText('订阅与充值');
  await expect(page.locator('[data-credit-wallet]').first()).not.toContainText('¥');
  expect(calls.filter(call=>call.method==='POST')).toEqual([]);
  await evidence(page,'subscription-account-1440.png');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await evidence(page,'subscription-account-390.png');
});

test('subscription quotation deep link shows its original scope and point amount without a purchase confirmation',async({page})=>{
  const {calls}=await setup(page);
  const original={id:'original-scope',project_id:'project-1',action:'review',input_hash:'a'.repeat(64),price_version:AUTOMATIC_PRICE_VERSION,quote_status:'ready',amount_fen:27195,scope_lines:[{key:'review',label:'锁定募集说明书与材料',quantity:1,unit:'轮',unit_price_fen:27195,amount_fen:27195,evidence:['原材料版本保持不变']}],reason:'本次范围记录',created_at:now,published_at:now,expires_at:end,closed_at:null,decline_reason:'',closure_reason:'',revision:1,previous_quote_id:null};
  await page.route('**/api/v1/commerce/quotations',route=>json(route,200,{items:[original,{...original,id:'expired-scope',quote_status:'expired',closure_reason:'原范围已过期'}]}));
  await page.goto('/#/account?quotation=original-scope');
  await expect(page.locator('#subscription-quotation-details')).toHaveAttribute('open','');
  const selected=page.locator('[data-quotation="original-scope"]');
  await expect(selected.locator('[data-quotation-details]')).toHaveAttribute('open','');
  await expect(selected).toContainText('27,195 积分');await expect(selected).toContainText('原材料版本保持不变');await expect(selected).not.toContainText('¥271.95');
  await expect(page.locator('[data-quotation="expired-scope"]')).toContainText('原范围已过期');
  await expect(page.locator('[data-decline-quote],[data-requote],[data-commerce-accept]')).toHaveCount(0);
  expect(calls.filter(call=>call.method==='POST')).toEqual([]);
});

for(const cancel of [false,true])test(`server-confirmed payment polling ${cancel?'preserves cancelled waiting task':'automatically resumes the named task once'}`,async({page})=>{
  const fixture=await setup(page,{payment:true}),resumes:any[]=[];
  await page.route('**/api/v1/projects/original-project/qa/runs',route=>{resumes.push(route.request().postDataJSON());return json(route,200,{run_id:'original-run'});});
  await page.goto('/#/account');
  const task=await page.evaluate(async()=>{
    const recovery=await import('/src/'+'billing-task-recovery.ts');
    const body={request_id:'paid-original-answer',expected_revision:7,price_version:'bb-task-price-170-20261029-v3',expected_points:'1218',scope_quote_id:'original-scope'};
    const task=await recovery.createBillingTask('subscription-owner','/projects/original-project/qa/runs',body,{'x-bb-billing-format':'int64-decimal-v1'},'#qa?project=original-project');
    localStorage.setItem('bondbuddy:billing-task:v2:'+task.id,JSON.stringify({...task,state:'needs_funds'}));return task;
  });
  await page.goto('/#/account?'+new URLSearchParams({order:'subscription-order-1',return_to:task.returnTo,resume_request:task.id}));
  await expect(page.getByRole('heading',{name:'等待支付确认',exact:true})).toBeVisible();expect(resumes).toEqual([]);
  if(cancel)await page.getByRole('button',{name:'取消这次等待任务'}).click();
  fixture.settle();await page.clock.fastForward(15_100);
  if(cancel){
    await expect(page.getByRole('heading',{name:'积分已到账',exact:true})).toBeVisible();await expect(page).toHaveURL(/#\/account\?/);expect(resumes).toEqual([]);
    await page.evaluate(()=>window.dispatchEvent(new Event('bondbuddy:credits-changed')));expect(resumes).toEqual([]);
  }else{
    await expect.poll(()=>resumes.length).toBe(1);expect(resumes[0]).toEqual(task.body);
    await expect(page).toHaveURL(/#qa\?project=original-project$/);await page.reload();expect(resumes).toHaveLength(1);
  }
  expect(fixture.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/refresh'))).toEqual([]);
});

test('checkout retries one selected plan and never sends a client-controlled price or grants points on return',async({page})=>{
  const {calls}=await setup(page,{payment:true,uncertainCheckout:true});await page.goto('/#/account');
  await page.getByRole('button',{name:'开通专业',exact:true}).click();
  await expect(page.locator('.account-billing-error')).toBeVisible();
  await page.getByRole('button',{name:'开通专业',exact:true}).click();
  await expect(page.getByRole('heading',{name:'等待支付确认',exact:true})).toBeVisible();
  await expect(page.getByRole('img',{name:'本订单微信支付二维码'})).toHaveAttribute('src',/^data:image\/png;base64,/);
  const orders=calls.filter(call=>call.path==='/subscriptions'&&call.method==='POST');
  expect(orders).toHaveLength(2);expect(orders[0].body).toEqual(orders[1].body);
  expect(Object.keys(orders[0].body).sort()).toEqual(['billing_cycle','plan_id','provider','request_id']);
  expect(orders[0].body).toMatchObject({plan_id:'professional',provider:'wechat',billing_cycle:'monthly'});
  await expect(page.locator('.subscription-payment')).toContainText('55,000 积分');
  await expect(page.locator('.subscription-payment')).not.toContainText('积分已到账');
  expect(calls.filter(call=>call.path.includes('auto-renew'))).toEqual([]);
});

test('account removes the task catalog while full-review consumption history stays in points',async({page})=>{
  await setup(page);await page.goto('/#/account');
  await expect(page.locator('.subscription-price-list,[data-task-price],[data-task-scope]')).toHaveCount(0);
  await expect(page.getByText('查看任务价格与计费范围',{exact:true})).toHaveCount(0);
  await expect(page.locator('[data-record="full-review-settled"] .credit-history-amount')).toContainText('消耗 27,195 积分');
  await expect(page.locator('[data-record="full-review-settled"] .credit-history-amount')).not.toContainText('¥');
  await evidence(page,'subscription-full-review-v3-1440.png');
});

test('a protected paid v2 month retains its original historical consumption without a price table',async({page})=>{
  await setup(page,{active:true,priceVersion:LEGACY_AUTOMATIC_PRICE_VERSION});await page.goto('/#/account');
  await expect(page.locator('.subscription-price-list')).toHaveCount(0);
  await expect(page.locator('[data-record="full-review-settled"] .credit-history-amount')).toContainText('消耗 14,900 积分');
  await expect(page.locator('[data-record="full-review-settled"] .credit-history-amount')).not.toContainText('¥');
  await evidence(page,'subscription-full-review-v2-protected-1440.png');
});

test('small topup uses exact fen and preserves the non-subscription entry',async({page})=>{
  const {calls}=await setup(page,{payment:true});await page.goto('/#/account');
  await page.locator('[data-topup-shortcut="50"]').click();
  expect(calls.filter(call=>call.method==='POST')).toEqual([]);
  await page.locator('#subscription-topup-amount').fill('12.18');
  await expect(page.locator('#subscription-topup-preview')).toHaveText('将到账 1,218 积分');
  await evidence(page,'subscription-final-monthly-1440.png');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await evidence(page,'subscription-final-monthly-390.png');await page.setViewportSize({width:1440,height:960});
  await page.getByRole('button',{name:'充值并前往支付',exact:true}).click();
  await expect(page.getByRole('heading',{name:'等待支付确认',exact:true})).toBeVisible();
  expect(calls.filter(call=>call.path==='/commerce/topups'&&call.method==='POST').map(call=>call.body)).toEqual([expect.objectContaining({amount_fen:'1218',provider:'wechat'})]);
  await expect(page.locator('.subscription-payment')).toContainText('1,218 积分 · 永久有效');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
});

test('unknown topup survives reload and another tab; changing the amount cannot create a replacement',async({page,context})=>{
  const first=await setup(page,{payment:true,uncertainTopup:true});await page.goto('/#/account');
  await page.locator('#subscription-topup-amount').fill('12.18');await page.getByRole('button',{name:'充值并前往支付',exact:true}).click();
  await expect(page.locator('.account-billing-error')).toBeVisible();await page.reload();
  await expect(page.getByRole('button',{name:'继续原付款',exact:true})).toBeVisible();
  await page.locator('#subscription-topup-amount').fill('50');await page.getByRole('button',{name:'充值并前往支付',exact:true}).click();
  await expect(page.locator('.account-billing-error')).toContainText('已有原付款待核对');
  expect(first.calls.filter(call=>call.path==='/commerce/topups'&&call.method==='POST')).toHaveLength(1);
  const secondPage=await context.newPage(),second=await setup(secondPage,{payment:true});await secondPage.goto('/#/account');
  await secondPage.getByRole('button',{name:'继续原付款',exact:true}).click();
  await expect(secondPage.getByRole('heading',{name:'等待支付确认',exact:true})).toBeVisible();
  const original=first.calls.find(call=>call.path==='/commerce/topups'&&call.method==='POST')!,replayed=second.calls.find(call=>call.path==='/commerce/topups'&&call.method==='POST')!;
  expect(replayed.body).toEqual(original.body);expect(replayed.body.amount_fen).toBe('1218');
  await page.getByRole('button',{name:'继续原付款',exact:true}).click();
  await expect(page.getByRole('heading',{name:'等待支付确认',exact:true})).toBeVisible();
  expect(first.calls.filter(call=>call.path==='/commerce/topups'&&call.method==='POST')).toHaveLength(1);
  await secondPage.close();
});

test('manual renewal uses the renewal endpoint and restores its original plan after an unknown response',async({page})=>{
  const fixture=await setup(page,{payment:true,expired:true,uncertainCheckout:true});await page.goto('/#/account');
  await page.getByRole('button',{name:'续订专业',exact:true}).click();await expect(page.locator('.account-billing-error')).toBeVisible();
  await page.reload();await page.getByRole('button',{name:'继续原付款',exact:true}).click();
  await expect(page.getByRole('heading',{name:'等待支付确认',exact:true})).toBeVisible();
  const calls=fixture.calls.filter(call=>call.path==='/subscriptions/subscription-1/renew'&&call.method==='POST');
  expect(calls).toHaveLength(2);expect(calls[0].body).toEqual(calls[1].body);expect(calls[1].body.plan_id).toBe('professional');
  expect(fixture.calls.filter(call=>call.path==='/subscriptions'&&call.method==='POST')).toHaveLength(0);
});

test('a paid storage event does not turn a stale tab retry into a second topup',async({page,context})=>{
  const first=await setup(page,{payment:true,uncertainTopup:true});await page.goto('/#/account');
  await page.locator('#subscription-topup-amount').fill('12.18');await page.getByRole('button',{name:'充值并前往支付',exact:true}).click();
  await expect(page.locator('.account-billing-error')).toBeVisible();
  const secondPage=await context.newPage(),second=await setup(secondPage,{payment:true,orderPaid:true});await secondPage.goto('/#/account');
  await secondPage.getByRole('button',{name:'继续原付款',exact:true}).click();await expect(secondPage.locator('.subscription-message')).toContainText('付款成功');
  first.settle();
  await expect(page.locator('.subscription-original-checkout')).toHaveCount(0);
  // This page has only received storage. It has never authenticated or displayed the paid order.
  await page.getByRole('button',{name:'充值并前往支付',exact:true}).click();
  await expect(page.locator('.subscription-message')).toContainText('付款成功');
  expect(first.calls.filter(call=>call.path==='/commerce/topups'&&call.method==='POST')).toHaveLength(1);
  expect(second.calls.filter(call=>call.path==='/commerce/topups'&&call.method==='POST')).toHaveLength(1);
  const a=first.calls.find(call=>call.path==='/commerce/topups'&&call.method==='POST')!,b=second.calls.find(call=>call.path==='/commerce/topups'&&call.method==='POST')!;
  expect(a.body).toEqual(b.body);await secondPage.close();
});

test('wallet and subscription period distinguish task holds from pending cash-refund credits',async({page})=>{
  await setup(page,{payment:true,active:true,refundHeld:true});await page.goto('/#/account');
  await expect(page.locator('.account-balance-value')).toHaveText('800积分');
  await expect(page.locator('[data-task-held]')).toContainText('任务预留 200 积分');
  await expect(page.locator('[data-refund-held]')).toContainText('原路退款冻结 21,000 积分');
  await expect(page.locator('[data-period="period-1"]')).toContainText('退款冻结 21,000 积分');
  await expect(page.locator('[data-period="period-1"]')).toContainText('可用 0 积分');
  await expect(page.locator('[data-task-held]')).not.toContainText('21,000');
  await evidence(page,'subscription-separated-holds-1440.png');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await evidence(page,'subscription-separated-holds-390.png');
});

test('stopping automatic renewal preserves the current period and all remaining credits',async({page})=>{
  const {calls}=await setup(page,{payment:true,active:true,renewal:true});await page.goto('/#/account');
  await page.getByRole('switch',{name:'自动续费',exact:true}).click();
  await expect(page.locator('.subscription-message')).toContainText('已停止未来续费，已到账积分按原有效期继续使用');
  await expect(page.locator('.account-balance-value')).toHaveText('22,000积分');
  await expect(page.locator('.subscription-current')).toContainText('已停止续费');
  expect(calls.filter(call=>call.path.endsWith('/cancel')&&call.method==='POST')).toHaveLength(1);
  expect(calls.filter(call=>call.path.endsWith('/refunds')&&call.method==='POST')).toEqual([]);
});

test('subscription payment and task points remain distinct during an eligible full-period refund',async({page})=>{
  const {calls}=await setup(page,{payment:true,active:true,orderPaid:true});await page.goto('/#/account?order=subscription-order-1');
  await expect(page.getByRole('heading',{name:'本期订阅退款',exact:true})).toBeVisible();
  await expect(page.locator('[data-refund-amount]')).toHaveValue('199.00');
  await expect(page.locator('[data-refund-amount]')).toHaveAttribute('readonly','');
  await page.getByRole('button',{name:'核对原路退款申请',exact:true}).click();
  await page.getByRole('button',{name:'提交本单原路退款申请',exact:true}).click();
  await expect(page.locator('[data-refund="refund-1"]')).toContainText('申请已受理');
  expect(calls.filter(call=>call.path.endsWith('/refunds')&&call.method==='POST').map(call=>call.body)).toEqual([expect.objectContaining({amount_fen:'19900'})]);
  await expect(page.locator('[data-refund="refund-1"]')).not.toContainText('已原路退款');
});

test('an original subscription outside the latest 50 periods retains its original expiry and full-period refund rules',async({page})=>{
  const {calls}=await setup(page,{payment:true,active:true,orderPaid:true,periodHistoryOverflow:true});
  await page.goto('/#/account?order=subscription-order-1');
  await expect(page.locator('[data-period]')).toHaveCount(50);
  await expect(page.locator('[data-period="period-1"]')).toHaveCount(0);
  await expect(page.locator('[data-payment-kind]')).toHaveText('轻量月付订阅');
  await expect(page.locator('[data-payment-validity]')).toContainText('2027');
  await expect(page.locator('.subscription-payment')).not.toContainText('永久有效');
  await expect(page.getByRole('heading',{name:'本期订阅退款',exact:true})).toBeVisible();
  await expect(page.locator('[data-refund-amount]')).toHaveAttribute('readonly','');
  expect(calls.filter(call=>call.path==='/subscriptions/orders/subscription-order-1/period'&&call.method==='GET')).toHaveLength(1);
  expect(calls.filter(call=>call.method==='POST')).toEqual([]);
  await evidence(page,'subscription-original-period-outside-50-1440.png');
});

for(const status of [404,503] as const)test(`unavailable original period (${status}) does not classify an order as permanent recharge or allow the wrong refund`,async({page})=>{
  const fixture=await setup(page,{payment:true,active:true,orderPaid:true,periodUnavailable:status});
  await page.goto('/#/account?order=subscription-order-1');
  await expect(page.locator('[data-payment-kind]')).toHaveText('订单类型待核实');
  await expect(page.locator('[data-payment-validity]')).toContainText('有效期待核实');
  await expect(page.locator('[data-order-period-unavailable]')).toBeVisible();
  await expect(page.locator('.subscription-payment')).not.toContainText('永久有效');
  await expect(page.locator('.subscription-payment')).not.toContainText('按需充值');
  await expect(page.locator('.subscription-payment [data-refund-form]')).toHaveCount(0);
  expect(fixture.calls.filter(call=>call.path.endsWith('/refund-eligibility'))).toEqual([]);
  expect(fixture.calls.filter(call=>call.method==='POST')).toEqual([]);
  fixture.setPeriodUnavailable(undefined);await page.getByRole('button',{name:'刷新支付状态',exact:true}).click();
  await expect(page.locator('[data-payment-kind]')).toHaveText('轻量月付订阅');
  await expect(page.locator('[data-refund-amount]')).toHaveAttribute('readonly','');
});

test('a verified recharge order explicitly returning null retains permanent credits and editable refund amount',async({page})=>{
  const {calls}=await setup(page,{payment:true,orderPaid:true,topupOrder:true});await page.goto('/#/account?order=topup-order-1');
  await expect(page.locator('[data-payment-kind]')).toHaveText('按需充值');
  await expect(page.locator('[data-payment-validity]')).toContainText('永久有效');
  await expect(page.getByRole('heading',{name:'本充值单原路退款',exact:true})).toBeVisible();
  await expect(page.locator('[data-refund-amount]')).toBeEditable();
  expect(calls.filter(call=>call.method==='POST')).toEqual([]);
});

test('losing original order detail closes an existing refund dialog until its period is verified again',async({page})=>{
  const fixture=await setup(page,{payment:true,active:true,orderPaid:true});await page.goto('/#/account?order=subscription-order-1');
  await page.getByRole('button',{name:'核对原路退款申请',exact:true}).click();
  await expect(page.getByRole('button',{name:'提交本单原路退款申请',exact:true})).toBeVisible();
  fixture.setPeriodUnavailable(503);await page.clock.fastForward(15_100);
  await expect(page.locator('[data-order-period-unavailable]')).toBeVisible();
  await expect(page.getByRole('button',{name:'提交本单原路退款申请',exact:true})).toHaveCount(0);
  await expect(page.locator('[data-refund-form]')).toHaveCount(0);
  expect(fixture.calls.filter(call=>call.path.endsWith('/refunds')&&call.method==='POST')).toEqual([]);
});

test('a mismatched order detail cannot supply another order period or imply permanent validity',async({page})=>{
  await setup(page,{payment:true,active:true,orderPaid:true});
  await page.route('**/api/v1/subscriptions/orders/subscription-order-1/period',route=>json(route,200,{order_id:'other-order',period:null}));
  await page.goto('/#/account?order=subscription-order-1');
  await expect(page.locator('[data-order-period-unavailable]')).toBeVisible();
  await expect(page.locator('.subscription-payment')).not.toContainText('永久有效');
  await expect(page.locator('[data-refund-form]')).toHaveCount(0);
});

test('a mandate authorization link is not displayed as a completed automatic renewal',async({page})=>{
  const {calls}=await setup(page,{payment:true,active:true,renewal:true,manualActive:true});await page.goto('/#/account');
  await expect(page.getByRole('switch',{name:'自动续费',exact:true})).toHaveAttribute('aria-checked','false');
  await page.getByRole('switch',{name:'自动续费',exact:true}).click();
  await expect(page.getByRole('link',{name:'前往支付渠道授权',exact:true})).toHaveAttribute('href','https://payments.example.test/mandate');
  await expect(page.locator('.subscription-current')).not.toContainText('已开通自动续费');
  await page.getByRole('button',{name:'刷新续费授权状态',exact:true}).click();
  await expect(page.locator('.subscription-current')).toContainText('已开通自动续费');
  await expect(page.locator('.subscription-message')).toHaveText('自动续费已开通。');
  await expect(page.getByRole('link',{name:'前往支付渠道授权',exact:true})).toHaveCount(0);
  await page.getByRole('switch',{name:'自动续费',exact:true}).click();
  await expect(page.getByRole('switch',{name:'自动续费',exact:true})).toHaveAttribute('aria-checked','false');
  await page.getByRole('switch',{name:'自动续费',exact:true}).click();
  await page.getByRole('button',{name:'刷新续费授权状态',exact:true}).click();
  await expect(page.getByRole('switch',{name:'自动续费',exact:true})).toHaveAttribute('aria-checked','true');
  await page.getByRole('switch',{name:'自动续费',exact:true}).click();
  const authorizations=calls.filter(c=>c.path.endsWith('/auto-renew')&&c.method==='POST'),cancellations=calls.filter(c=>c.path.endsWith('/cancel')&&c.method==='POST');
  expect(authorizations).toHaveLength(2);expect(authorizations[0].body.request_id).not.toBe(authorizations[1].body.request_id);
  expect(cancellations).toHaveLength(2);expect(cancellations[0].body.request_id).not.toBe(cancellations[1].body.request_id);
});

test('a verified paid order returns only to its valid named waiting task without another amount click',async({page})=>{
  const {calls}=await setup(page,{payment:true,active:true,orderPaid:true});
  const resumed:unknown[]=[];
  await page.route('**/api/v1/projects/project-1/qa/runs',route=>{resumed.push(route.request().postDataJSON());return json(route,200,{run_id:'resumed-run'});});
  await page.goto('/#/account');await expect(page.locator('#account-balance-title')).toBeVisible();
  const id=await page.evaluate(async()=>{
    const module=await import('/src/'+'billing-task-recovery.ts');
    const task=await module.createBillingTask('subscription-owner','/projects/project-1/qa/runs',{request_id:'waiting-1',expected_revision:1,expected_points:'1218',price_version:'bb-task-price-170-20261029-v2',scope_quote_id:'scope-1'},{'x-bb-billing-format':'int64-decimal-v1'},'#qa?project=project-1');
    localStorage.setItem('bondbuddy:billing-task:v2:'+task.id,JSON.stringify({...task,state:'needs_funds'}));return task.id;
  });
  await page.goto('/#/account?'+new URLSearchParams({order:'subscription-order-1',return_to:'#qa?project=project-1',resume_request:id}));
  await expect(page).toHaveURL(/#qa\?project=project-1$/);
  await expect.poll(()=>resumed.length).toBe(1);
  expect(resumed).toEqual([{request_id:'waiting-1',expected_revision:1,expected_points:'1218',price_version:'bb-task-price-170-20261029-v2',scope_quote_id:'scope-1'}]);
  expect(calls.filter(call=>call.path==='/commerce/topups'&&call.method==='POST')).toEqual([]);
  await expect(page.locator('dialog[data-commerce-confirm]')).toHaveCount(0);
});

test('a paid order does not resume a task owned by another account',async({page})=>{
  const {calls}=await setup(page,{payment:true,active:true,orderPaid:true});await page.goto('/#/account');
  await expect(page.locator('#account-balance-title')).toBeVisible();
  const id=await page.evaluate(async()=>{
    const module=await import('/src/'+'billing-task-recovery.ts');
    const task=await module.createBillingTask('another-owner','/projects/project-1/qa/runs',{request_id:'foreign-waiting',expected_revision:1,expected_points:'1218',price_version:'bb-task-price-170-20261029-v2'},{'x-bb-billing-format':'int64-decimal-v1'},'#qa?project=project-1');
    localStorage.setItem('bondbuddy:billing-task:v2:'+task.id,JSON.stringify({...task,state:'needs_funds'}));return task.id;
  });
  await page.goto('/#/account?'+new URLSearchParams({order:'subscription-order-1',return_to:'#qa?project=project-1',resume_request:id}));
  await expect(page.getByRole('heading',{name:'积分已到账',exact:true})).toBeVisible();
  expect(page.url()).toContain('#/account?');
  expect(calls.filter(call=>call.path==='/projects/project-1/qa/runs'&&call.method==='POST')).toEqual([]);
});

test('subscription preview shares the account layout and keeps its interactive example entirely local',async({page})=>{
  const apiCalls:string[]=[];page.on('request',request=>{if(request.url().includes('/api/'))apiCalls.push(request.url());});
  const directory=fileURLToPath(new URL('../../../product-prototype/public/',import.meta.url));
  await page.route('**/prototype-subscription/**',async route=>{
    const filename=new URL(route.request().url()).pathname.split('/').at(-1)!;
    if(!['account-credits.html','commerce-account-prototype.js','subscription-account-prototype.js','subscription-billing.css','subscription-experience-prototype.css'].includes(filename))return route.abort();
    return route.fulfill({contentType:filename.endsWith('.html')?'text/html':filename.endsWith('.css')?'text/css':'text/javascript',body:await readFile(join(directory,filename),'utf8')});
  });
  await page.goto('/prototype-subscription/account-credits.html?subscription=1');
  await expect(page.locator('.subscription-plan-grid .credit-pack')).toHaveCount(3);
  await expect(page.getByRole('button',{name:'开通专业',exact:true})).toBeEnabled();
  await expect(page.locator('.subscription-price-list')).toHaveCount(0);
  await page.locator('#subscription-topup-amount').fill('12.18');await expect(page.locator('#prototype-points')).toHaveText('将到账 1,218 积分');
  await evidence(page,'subscription-final-prototype-monthly-1440.png');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await evidence(page,'subscription-final-prototype-monthly-390.png');
  await page.getByRole('radio',{name:'年付 · 9折',exact:true}).click();await expect(page.locator('[data-subscription-plan="light"] .subscription-price-context')).toHaveText('折合 ¥179.10 / 月 · 省10%');
  await evidence(page,'subscription-final-prototype-annual-390.png');await regionEvidence(page,'subscription-final-prototype-annual-card-detail-390.png','[data-subscription-plan="intensive"]');await regionEvidence(page,'subscription-final-prototype-topup-detail-390.png','.subscription-topup');
  await page.setViewportSize({width:1440,height:960});await evidence(page,'subscription-final-prototype-annual-1440.png');await regionEvidence(page,'subscription-final-prototype-annual-plans-detail-1440.png','.subscription-plans');await regionEvidence(page,'subscription-final-prototype-topup-detail-1440.png','.subscription-topup');
  await page.getByRole('button',{name:'开通轻量',exact:true}).click();await expect(page.locator('.subscription-message')).toHaveText('付款成功，本月积分已到账，剩余额度按月发放。');
  await expect(page.getByRole('switch',{name:'自动续费',exact:true})).toHaveAttribute('aria-checked','false');await page.getByRole('switch',{name:'自动续费',exact:true}).click();await expect(page.getByRole('switch',{name:'自动续费',exact:true})).toHaveAttribute('aria-checked','true');
  expect(apiCalls).toEqual([]);
});


test('quote-only authoring recovery pre-fills the exact topup gap in yuan without rewriting the task',async({page})=>{
 const {calls}=await setup(page,{payment:true});await page.goto('/#/account');await expect(page.locator('#account-balance-title')).toBeVisible();
 const id=await page.evaluate(async()=>{
  const module=await import('/src/'+'billing-task-recovery.ts');module.configureBillingTaskRecovery(()=>'subscription-owner');module.observeAutomaticQuotes({quote:{quote_id:'authoring-quoted',price_version:'bb-task-price-170-20261029-v2',points:'20341'}});
  const body={execution_request_id:'authoring-gap',project_id:'project-1',input_revision:3,quote_id:'authoring-quoted'};
  try{await module.runRecoverableBillingRequest('POST','/runs/execute',body,{},async()=>{throw {status:402,code:'CREDITS_INSUFFICIENT'};});}catch{}
  const key=Object.keys(localStorage).find(key=>key.startsWith('bondbuddy:billing-task:v2:'))!;return JSON.parse(localStorage.getItem(key)!).id;
 });
 await page.goto('/#/account?'+new URLSearchParams({return_to:'#/projects/project-1',resume_request:id}));await expect(page.locator('#subscription-topup-amount')).toHaveValue('5.59');
 expect(calls.filter(call=>call.path==='/commerce/topups'&&call.method==='POST')).toEqual([]);
});

test('pending cancellation refreshes the original mandate across reload and forbids reauthorization until confirmed',async({page})=>{
  const {calls}=await setup(page,{payment:true,active:true,renewal:true,cancelPending:true});await page.goto('/#/account');
  await page.getByRole('switch',{name:'自动续费',exact:true}).click();await expect(page.locator('.subscription-current')).toContainText('正在停止续费');
  await expect(page.getByRole('switch',{name:'自动续费',exact:true})).toBeDisabled();await expect(page.getByRole('link',{name:'前往支付渠道授权',exact:true})).toHaveCount(0);
  await page.reload();await page.getByRole('button',{name:'刷新原解约状态',exact:true}).click();
  await expect(page.locator('.subscription-message')).toContainText('原解约结果仍在核对');await expect(page.getByRole('switch',{name:'自动续费',exact:true})).toBeDisabled();
  await expect(page.getByRole('link',{name:'前往支付渠道授权',exact:true})).toHaveCount(0);await expect(page.locator('.account-balance-value')).toHaveText('22,000积分');
  await evidence(page,'subscription-cancellation-pending-1440.png');
  await page.getByRole('button',{name:'刷新原解约状态',exact:true}).click();
  await expect(page.locator('.subscription-message')).toContainText('支付渠道已确认停止续费');await expect(page.getByRole('button',{name:'刷新原解约状态',exact:true})).toHaveCount(0);
  await expect(page.getByRole('switch',{name:'自动续费',exact:true})).toBeVisible();
  expect(calls.filter(c=>c.method==='POST'&&c.path==='/subscriptions/subscription-1/cancel')).toHaveLength(1);
  expect(calls.filter(c=>c.method==='POST'&&c.path==='/subscriptions/subscription-1/auto-renew/refresh')).toHaveLength(2);
  expect(calls.filter(c=>c.method==='POST'&&c.path==='/subscriptions/subscription-1/auto-renew')).toHaveLength(0);
});

test('account refresh keeps the simplified layout without reintroducing the task price table',async({page})=>{
  const {calls}=await setup(page);await page.goto('/#/account');
  await expect(page.locator('.subscription-plan-grid')).toBeVisible();
  await page.evaluate(()=>window.dispatchEvent(new Event('bondbuddy:credits-changed')));
  await expect.poll(()=>calls.filter(c=>c.path==='/subscriptions/account').length).toBeGreaterThan(1);
  await expect(page.locator('.subscription-price-list,[data-task-price],[data-task-scope]')).toHaveCount(0);
  await page.evaluate(()=>window.scrollTo(0,0));await evidence(page,'subscription-simplified-account-1440.png');
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.scrollTo(0,0));expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await evidence(page,'subscription-simplified-account-390.png');
  expect(calls.filter(c=>c.method==='POST')).toHaveLength(0);
});

test('topup preview follows each edit exactly and rejects invalid input without a payment request',async({page})=>{
  const {calls}=await setup(page,{payment:true});await page.goto('/#/account');
  const input=page.locator('#subscription-topup-amount'),preview=page.locator('#subscription-topup-preview');
  for(const [amount,expected] of [['0.01','1'],['12.18','1,218'],['9999.99','999,999'],['10000','1,000,000']]){
    await input.fill(amount);await expect(preview).toHaveText(`将到账 ${expected} 积分`);await expect(input).toHaveAttribute('aria-invalid','false');await expect(input).toBeFocused();
  }
  for(const amount of ['0','-1','1.001','1e3','10000.01','9007199254740993']){
    await input.fill(amount);await expect(input).toHaveAttribute('aria-invalid','true');await expect(preview).toContainText('最多两位小数');
    await page.getByRole('button',{name:'充值并前往支付',exact:true}).click();
  }
  await input.fill('');await expect(preview).toHaveText('输入金额后显示将到账的积分。');
  await page.locator('[data-topup-shortcut="500"]').click();await expect(preview).toHaveText('将到账 50,000 积分');
  expect(calls.filter(c=>c.method==='POST')).toHaveLength(0);
});

test('annual checkout displays the full 10-percent-discount price and monthly releases while preserving an unknown original cycle',async({page})=>{
  const {calls}=await setup(page,{payment:true,uncertainCheckout:true});await page.goto('/#/account');
  await page.getByRole('radio',{name:'年付 · 9折',exact:true}).click();
  for(const [plan,amount,monthly] of [['light','2,149.20','21,000'],['professional','5,389.20','55,000'],['intensive','10,789.20','114,000']]){
    const card=page.locator(`[data-subscription-plan="${plan}"]`);await expect(card.locator('.plan-price')).toHaveText(`¥${amount} / 年`);await expect(card).toContainText(`${monthly} 积分 / 月`);await expect(card).toContainText('一次支付全年费用，分12个月到账');
  }
  await page.locator('#subscription-topup-amount').fill('12.18');
  await evidence(page,'subscription-final-annual-1440.png');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await evidence(page,'subscription-final-annual-390.png');await page.setViewportSize({width:1440,height:960});
  await page.getByRole('button',{name:'开通专业',exact:true}).click();await expect(page.locator('.account-billing-error')).toBeVisible();
  await page.getByRole('radio',{name:'月付',exact:true}).click();await page.getByRole('button',{name:'开通专业',exact:true}).click();
  await expect(page.locator('.account-billing-error')).toContainText('已有原付款待核对');
  await page.reload();await expect(page.getByRole('radio',{name:'年付 · 9折',exact:true})).toHaveAttribute('aria-checked','true');
  await page.getByRole('button',{name:'继续原付款',exact:true}).click();await expect(page.locator('.subscription-payment')).toContainText('¥5,389.20');
  await expect(page.locator('[data-payment-validity]')).toHaveText('全年 660,000 积分，按月到账 55,000 积分，每批有效90天');
  const requests=calls.filter(c=>c.path==='/subscriptions'&&c.method==='POST');expect(requests).toHaveLength(2);expect(requests[0].body).toEqual(requests[1].body);
  expect(requests[0].body).toMatchObject({billing_cycle:'annual',plan_id:'professional'});expect(calls.filter(c=>c.path.includes('auto-renew'))).toHaveLength(0);
});

test('a default paid checkout ends on the overview while an explicit history link retains order and refund detail',async({page})=>{
  const fixture=await setup(page,{payment:true});await page.goto('/#/account');
  await page.locator('#subscription-topup-amount').fill('12.18');await page.getByRole('button',{name:'充值并前往支付',exact:true}).click();
  await expect(page).toHaveURL(/checkout=1/);await expect(page.locator('.subscription-payment')).toBeVisible();
  fixture.settle();await page.getByRole('button',{name:'刷新支付状态',exact:true}).click();
  await expect(page).toHaveURL(/#\/account$/);await expect(page.locator('.subscription-payment')).toHaveCount(0);await expect(page.locator('.subscription-message')).toHaveText('付款成功，积分已到账。');
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('bondbuddy:checkout-intent:v1:subscription-owner')!));expect(saved.order.state).toBe('paid');
  await page.clock.fastForward(5100);await expect(page.locator('.subscription-message')).toHaveCount(0);
  await page.reload();await expect(page.locator('#account-balance-title')).toBeVisible();await expect(page.locator('.subscription-message,.subscription-payment')).toHaveCount(0);
  await page.locator('[data-history-tab="recharge"]').click();
  await page.getByRole('link',{name:'查看订单',exact:true}).click();
  await expect(page.locator('.subscription-payment')).toBeVisible();await expect(page.locator('.payment-amount')).toHaveText('¥12.18');await expect(page.getByRole('heading',{name:'本充值单原路退款',exact:true})).toBeVisible();
  expect(fixture.calls.filter(c=>c.path==='/commerce/topups'&&c.method==='POST')).toHaveLength(1);
});

test('annual renewal shows the next whole-year charge and cancelling preserves the remaining monthly entitlement',async({page})=>{
  const {calls}=await setup(page,{payment:true,active:true,renewal:true,annual:true});await page.goto('/#/account');
  const control=page.getByRole('switch',{name:'自动续费',exact:true});await expect(control).toHaveAttribute('aria-checked','true');
  await expect(page.locator('[data-renewal-schedule]')).toContainText('¥2,149.20（年付）');await expect(page.locator('[data-renewal-schedule]')).toContainText('2027');
  await expect(page.locator('.subscription-annual-releases')).toContainText('已发放 1/12 个月额度，剩余 11 个月；每月 21,000 积分');
  await expect(page.locator('.subscription-plan .credit-pack-badge')).toHaveCount(1);await expect(page.locator('[data-subscription-plan="light"] .btn')).toHaveText('当前订阅');await expect(page.locator('.subscription-plan .btn').filter({hasText:'到期后可选'})).toHaveCount(2);
  await page.getByRole('radio',{name:'月付',exact:true}).click();await expect(page.locator('.subscription-plan .credit-pack-badge')).toHaveCount(0);await expect(page.locator('.subscription-plan .btn').filter({hasText:'到期后可选'})).toHaveCount(3);
  await page.getByRole('radio',{name:'年付 · 9折',exact:true}).click();await expect(page.locator('.subscription-plan .credit-pack-badge')).toHaveCount(1);
  await page.locator('#subscription-topup-amount').fill('12.18');await expect(page.locator('#subscription-topup-preview')).toHaveText('将到账 1,218 积分');
  await evidence(page,'subscription-final-annual-current-1440.png');await regionEvidence(page,'subscription-final-annual-plans-detail-1440.png','.subscription-plans');await regionEvidence(page,'subscription-final-topup-detail-1440.png','.subscription-topup');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await evidence(page,'subscription-final-annual-current-390.png');await regionEvidence(page,'subscription-final-annual-card-detail-390.png','[data-subscription-plan="intensive"]');await regionEvidence(page,'subscription-final-topup-detail-390.png','.subscription-topup');await page.setViewportSize({width:1440,height:960});
  await control.click();await expect(control).toHaveAttribute('aria-checked','false');
  await expect(page.locator('.subscription-current')).toContainText('已停止续费');await expect(page.locator('.subscription-current')).toContainText('2027');
  await expect(page.locator('.subscription-annual-releases')).toContainText('剩余 11 个月');await expect(page.locator('.subscription-annual-releases')).toContainText('停止续费不影响本年剩余额度按月到账');
  expect(calls.filter(c=>c.path.endsWith('/cancel')&&c.method==='POST')).toHaveLength(1);expect(calls.filter(c=>c.path.endsWith('/refunds')&&c.method==='POST')).toHaveLength(0);
});
