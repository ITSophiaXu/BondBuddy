import {mkdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {expect,test,type Page,type Route} from '@playwright/test';
import Fastify from 'fastify';
import type {Pool} from 'pg';
import {installSubscriptions} from '../../api/dist/subscriptions.js';
import {AUTOMATIC_PRICE_VERSION,LEGACY_AUTOMATIC_PRICE_VERSION,automaticTaskTariff,DATA_POLICY_VERSION,DELETION_PURGED_CONTENT,DELETION_RETAINED_METADATA,type AutomaticPriceVersion,type DataPolicy,type SubscriptionCatalog} from '@bondbuddy/contracts';

// Synthetic HTTP and UI evidence. No merchant, mandate, cash transfer or professional task is executed.
const now='2026-10-29T04:00:00Z',end='2026-11-29T04:00:00Z',expiry='2027-01-27T04:00:00Z';
const plans=[{id:'light',label:'轻量',amount_fen:19900,points:21000,period_months:1,credit_valid_days:90},{id:'professional',label:'专业',amount_fen:49900,points:55000,period_months:1,credit_valid_days:90},{id:'intensive',label:'密集',amount_fen:99900,points:114000,period_months:1,credit_valid_days:90}];
const policy:DataPolicy={policy_version:DATA_POLICY_VERSION,storage_location:'platform_private_cloud',server_side_processing:true,model_provider_processing:true,active_retention:'until_user_deletes',purge_enabled:false,deleted_content_purge_days:null,orphan_upload_purge_hours:null,log_content_retention_days:30,backup_retention_days:null,pinned_by_active_run:'retained_until_run_ends',purged_content:[...DELETION_PURGED_CONTENT],retained_metadata:[...DELETION_RETAINED_METADATA]};
const json=(route:Route,status:number,body:unknown)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
async function evidence(page:Page,name:string){const directory=process.env.BB_UX_EVIDENCE_DIR;if(!directory)return;await mkdir(directory,{recursive:true});await page.screenshot({path:join(directory,name),fullPage:true});}
async function setup(page:Page,options:{payment?:boolean;active?:boolean;renewal?:boolean;manualActive?:boolean;uncertainCheckout?:boolean;orderPaid?:boolean;priceVersion?:AutomaticPriceVersion;subscriptionCatalog?:SubscriptionCatalog}={}){
  const calls:{method:string;path:string;body:any}[]=[];let attempts=0;
  const priceVersion=options.priceVersion??AUTOMATIC_PRICE_VERSION,tariff=automaticTaskTariff(priceVersion);
  let subscription:any=options.active?{id:'subscription-1',plan_id:'light',status:'active',auto_renew:!!options.renewal&&!options.manualActive,mandate_status:options.renewal&&!options.manualActive?'active':'none',current_period_start:now,current_period_end:end,task_price_version:priceVersion}:null;
  let order={order_id:'subscription-order-1',provider:'wechat',state:options.orderPaid||options.active?'paid':'pending',amount_fen:19900,points:21000,currency:'CNY',checkout_url:'weixin://wxpay/bizpayurl?pr=synthetic-subscription',project_id:null,expires_at:end,credited_at:options.orderPaid||options.active?now:null};
  const period=()=>({id:'period-1',order_id:order.order_id,plan_id:subscription?.plan_id??'light',status:order.state==='paid'?'active':'pending',amount_fen:order.amount_fen,points:order.points,available_points:order.state==='paid'?order.points:0,held_points:0,starts_at:order.state==='paid'?now:null,ends_at:order.state==='paid'?end:null,credits_expires_at:order.state==='paid'?expiry:null,refundable_until:order.state==='paid'?'2026-11-05T04:00:00Z':null});
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
    if(path==='/subscriptions/account')return json(route,200,{subscription,available_points:subscription&&order.state==='paid'?22000:19782,held_points:subscription&&order.state==='paid'?0:1218,subscription_available_points:subscription&&order.state==='paid'?21000:0,topup_available_points:subscription&&order.state==='paid'?1000:19782,other_available_points:0,periods:subscription?[period()]:[]});
    if(path==='/commerce/catalog')return json(route,200,{enabled:true,currency:'CNY',version:priceVersion,model:'subscription_and_topup',items:Object.entries(tariff).map(([code,item])=>({code,label:item.label+(code==='full_review'&&priceVersion===LEGACY_AUTOMATIC_PRICE_VERSION?'（本期原价）':''),unit:item.unit,price_fen:item.points,price_points:item.points,capability:'limited',scope:code==='full_review'?['一份募集说明书与锁定材料的一轮全面复核，交付复核报告及批注。','另行委托的差异复核、原文修订各按14,900积分独立计费。']:['独立业务范围'],included:code==='full_review'?['本轮报告与批注的修复、平台重试包含。']:['原范围修订']})),rules:[]});
    if(path==='/commerce/quotations')return json(route,200,{items:[]});
    if(path==='/credits/consumption-history')return json(route,200,{items:[
      {reservation_id:'response-settled',run_id:'response-run',project_id:'project-1',project_name:'合成项目',task_name:'问题回复',created_at:now,finalized_at:now,state:'settled',reserved_points:1218,charged_points:1218,released_points:0,corrected_points:0,pricing_mode:'outcome_cny_v1',price_version:priceVersion,currency:'CNY',amount_fen:1218},
      {reservation_id:'full-review-settled',run_id:'full-review-run',project_id:'project-1',project_name:'合成项目',task_name:'独立全面复核',created_at:now,finalized_at:now,state:'settled',reserved_points:tariff.full_review.points,charged_points:tariff.full_review.points,released_points:0,corrected_points:0,pricing_mode:'outcome_cny_v1',price_version:priceVersion,currency:'CNY',amount_fen:tariff.full_review.points}],page:{next_cursor:null,has_more:false}});
    if(path==='/credits/recharge-history')return json(route,200,{items:[{order_id:order.order_id,provider:'wechat',state:'paid',amount_fen:19900,points:21000,created_at:now,credited_at:now,pricing_mode:'outcome_cny_v1',price_version:'bb-task-price-170-20261029-v2',currency:'CNY'}],page:{next_cursor:null,has_more:false}});
    if(path==='/subscriptions'&&method==='POST'){
      attempts++;if(options.uncertainCheckout&&attempts===1)return json(route,500,{code:'INTERNAL_ERROR'});
      const plan=plans.find(plan=>plan.id===body.plan_id)!;order={...order,amount_fen:plan.amount_fen,points:plan.points};
      subscription={id:'subscription-1',plan_id:plan.id,status:'pending',auto_renew:false,mandate_status:'none',current_period_start:null,current_period_end:null,task_price_version:AUTOMATIC_PRICE_VERSION};
      return json(route,201,{subscription,order});
    }
    if(path==='/subscriptions/subscription-1/cancel'&&method==='POST'){subscription={...subscription,status:'cancelled',auto_renew:false,mandate_status:'cancelled'};return json(route,200,subscription);}
    if(path==='/subscriptions/subscription-1/auto-renew'&&method==='POST'){subscription={...subscription,auto_renew:false,mandate_status:'pending'};return json(route,200,{subscription,authorization_url:'https://payments.example.test/mandate'});}
    if(path==='/subscriptions/subscription-1/auto-renew/refresh'&&method==='POST'){subscription={...subscription,auto_renew:true,mandate_status:'active'};return json(route,200,{subscription,authorization_url:null});}
    if(path==='/commerce/topups'&&method==='POST'){order={...order,order_id:'topup-order-1',amount_fen:body.amount_fen,points:body.amount_fen};return json(route,201,order);}
    if(path==='/commerce/topups/'+order.order_id+'/refund-eligibility')return json(route,200,{order_id:order.order_id,currency:'CNY',order_amount_fen:order.amount_fen,paid_amount_fen:order.amount_fen,refundable_fen:refunds.length?0:order.amount_fen,held_refund_fen:refunds.length?order.amount_fen:0,refunded_fen:0,enabled:true,reason:'',refunds});
    if(path==='/commerce/topups/'+order.order_id+'/refunds'&&method==='POST'){const refund={refund_id:'refund-1',order_id:order.order_id,currency:'CNY',amount_fen:body.amount_fen,state:'requested',created_at:now,updated_at:now,completed_at:null,failure_code:null};refunds.push(refund);return json(route,202,refund);}
    if(path==='/commerce/topups/'+order.order_id||path==='/commerce/topups/'+order.order_id+'/refresh')return json(route,200,order);
    return json(route,404,{code:'NOT_FOUND'});
  });
  return{calls,settle:()=>{order={...order,state:'paid',credited_at:now};}};
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
    const body={request_id:'paid-original-answer',expected_revision:7,price_version:'bb-task-price-170-20261029-v3',expected_points:1218,scope_quote_id:'original-scope'};
    const task=await recovery.createBillingTask('subscription-owner','/projects/original-project/qa/runs',body,{},'#qa?project=original-project');
    localStorage.setItem('bondbuddy:billing-task:v1:'+task.id,JSON.stringify({...task,state:'needs_funds'}));return task;
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
  expect(Object.keys(orders[0].body).sort()).toEqual(['plan_id','provider','request_id']);
  expect(orders[0].body).toMatchObject({plan_id:'professional',provider:'wechat'});
  await expect(page.locator('.subscription-payment')).toContainText('55,000 积分');
  await expect(page.locator('.subscription-payment')).not.toContainText('积分已到账');
  expect(calls.filter(call=>call.path.includes('auto-renew'))).toEqual([]);
});

test('current catalog lists all twelve tasks and full-review history stays in points',async({page})=>{
  await setup(page);await page.goto('/#/account');
  await page.locator('.subscription-price-list summary').click();
  await expect(page.locator('[data-task-price]')).toHaveCount(12);
  await expect(page.locator('[data-task-price="full_review"]')).toHaveText('独立全面复核 / 份／轮27,195 积分');
  await expect(page.locator('[data-record="full-review-settled"] .credit-history-amount')).toContainText('消耗 27,195 积分');
  await expect(page.locator('[data-record="full-review-settled"] .credit-history-amount')).not.toContainText('¥');
  await expect(page.locator('.subscription-review-scope')).toContainText('交付复核报告及批注');
  await expect(page.locator('.subscription-review-scope')).toContainText('原文修订各按14,900积分独立计费');
  await evidence(page,'subscription-full-review-v3-1440.png');
});

test('a protected paid v2 month displays the original full-review price and historical points',async({page})=>{
  await setup(page,{active:true,priceVersion:LEGACY_AUTOMATIC_PRICE_VERSION});await page.goto('/#/account');
  await page.locator('.subscription-price-list summary').click();
  await expect(page.locator('.subscription-price-list')).toContainText('本期锁定的任务积分价格');
  await expect(page.locator('[data-task-price="full_review"]')).toHaveText('独立全面复核（本期原价） / 份／轮14,900 积分');
  await expect(page.locator('[data-record="full-review-settled"] .credit-history-amount')).toContainText('消耗 14,900 积分');
  await expect(page.locator('[data-record="full-review-settled"] .credit-history-amount')).not.toContainText('¥');
  await evidence(page,'subscription-full-review-v2-protected-1440.png');
});

test('small topup uses exact fen and preserves the non-subscription entry',async({page})=>{
  const {calls}=await setup(page,{payment:true});await page.goto('/#/account');
  await page.locator('[data-topup-shortcut="50"]').click();
  expect(calls.filter(call=>call.method==='POST')).toEqual([]);
  await page.locator('#subscription-topup-amount').fill('12.18');
  await page.getByRole('button',{name:'充值并前往支付',exact:true}).click();
  await expect(page.getByRole('heading',{name:'等待支付确认',exact:true})).toBeVisible();
  expect(calls.filter(call=>call.path==='/commerce/topups'&&call.method==='POST').map(call=>call.body)).toEqual([expect.objectContaining({amount_fen:1218,provider:'wechat'})]);
  await expect(page.locator('.subscription-payment')).toContainText('1,218 积分 · 永久有效');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
});

test('stopping automatic renewal preserves the current period and all remaining credits',async({page})=>{
  const {calls}=await setup(page,{payment:true,active:true,renewal:true});await page.goto('/#/account');
  await page.getByRole('button',{name:'停止下期续费',exact:true}).click();
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
  expect(calls.filter(call=>call.path.endsWith('/refunds')&&call.method==='POST').map(call=>call.body)).toEqual([expect.objectContaining({amount_fen:19900})]);
  await expect(page.locator('[data-refund="refund-1"]')).not.toContainText('已原路退款');
});

test('a mandate authorization link is not displayed as a completed automatic renewal',async({page})=>{
  await setup(page,{payment:true,active:true,renewal:true,manualActive:true});await page.goto('/#/account');
  await page.getByRole('button',{name:'授权自动续费',exact:true}).click();
  await expect(page.getByRole('link',{name:'前往支付渠道授权',exact:true})).toHaveAttribute('href','https://payments.example.test/mandate');
  await expect(page.locator('.subscription-current')).not.toContainText('已开通自动续费');
  await page.getByRole('button',{name:'刷新续费授权状态',exact:true}).click();
  await expect(page.locator('.subscription-current')).toContainText('已开通自动续费');
  await expect(page.getByRole('link',{name:'前往支付渠道授权',exact:true})).toHaveCount(0);
});

test('a verified paid order returns only to its valid named waiting task without another amount click',async({page})=>{
  const {calls}=await setup(page,{payment:true,active:true,orderPaid:true});
  const resumed:unknown[]=[];
  await page.route('**/api/v1/projects/project-1/qa/runs',route=>{resumed.push(route.request().postDataJSON());return json(route,200,{run_id:'resumed-run'});});
  await page.goto('/#/account');await expect(page.locator('#account-balance-title')).toBeVisible();
  const id=await page.evaluate(async()=>{
    const module=await import('/src/'+'billing-task-recovery.ts');
    const task=await module.createBillingTask('subscription-owner','/projects/project-1/qa/runs',{request_id:'waiting-1',expected_revision:1,expected_points:1218,price_version:'bb-task-price-170-20261029-v2',scope_quote_id:'scope-1'},{},'#qa?project=project-1');
    localStorage.setItem('bondbuddy:billing-task:v1:'+task.id,JSON.stringify({...task,state:'needs_funds'}));return task.id;
  });
  await page.goto('/#/account?'+new URLSearchParams({order:'subscription-order-1',return_to:'#qa?project=project-1',resume_request:id}));
  await expect(page).toHaveURL(/#qa\?project=project-1$/);
  await expect.poll(()=>resumed.length).toBe(1);
  expect(resumed).toEqual([{request_id:'waiting-1',expected_revision:1,expected_points:1218,price_version:'bb-task-price-170-20261029-v2',scope_quote_id:'scope-1'}]);
  expect(calls.filter(call=>call.path==='/commerce/topups'&&call.method==='POST')).toEqual([]);
  await expect(page.locator('dialog[data-commerce-confirm]')).toHaveCount(0);
});

test('a paid order does not resume a task owned by another account',async({page})=>{
  const {calls}=await setup(page,{payment:true,active:true,orderPaid:true});await page.goto('/#/account');
  await expect(page.locator('#account-balance-title')).toBeVisible();
  const id=await page.evaluate(async()=>{
    const module=await import('/src/'+'billing-task-recovery.ts');
    const task=await module.createBillingTask('another-owner','/projects/project-1/qa/runs',{request_id:'foreign-waiting',expected_revision:1,expected_points:1218,price_version:'bb-task-price-170-20261029-v2'},{},'#qa?project=project-1');
    localStorage.setItem('bondbuddy:billing-task:v1:'+task.id,JSON.stringify({...task,state:'needs_funds'}));return task.id;
  });
  await page.goto('/#/account?'+new URLSearchParams({order:'subscription-order-1',return_to:'#qa?project=project-1',resume_request:id}));
  await expect(page.getByRole('heading',{name:'积分已到账',exact:true})).toBeVisible();
  expect(page.url()).toContain('#/account?');
  expect(calls.filter(call=>call.path==='/projects/project-1/qa/runs'&&call.method==='POST')).toEqual([]);
});

test('subscription preview shares the account layout and never enables payment actions',async({page})=>{
  const directory=resolve('../../product-prototype/public');
  await page.route('**/prototype-subscription/**',async route=>{
    const filename=new URL(route.request().url()).pathname.split('/').at(-1)!;
    if(!['account-credits.html','commerce-account-prototype.js','subscription-account-prototype.js','subscription-billing.css'].includes(filename))return route.abort();
    return route.fulfill({contentType:filename.endsWith('.html')?'text/html':filename.endsWith('.css')?'text/css':'text/javascript',body:await readFile(join(directory,filename),'utf8')});
  });
  await page.goto('/prototype-subscription/account-credits.html?subscription=1');
  await expect(page.locator('.subscription-plan-grid .credit-pack')).toHaveCount(3);
  await expect(page.getByRole('button',{name:'开通专业',exact:true})).toBeDisabled();
  await page.locator('.subscription-price-list summary').click();
  await expect(page.locator('.subscription-price-list li')).toHaveCount(12);
  await expect(page.locator('.subscription-price-list')).toContainText('独立全面复核');
  await expect(page.locator('.subscription-price-list')).toContainText('27,195 积分');
  await evidence(page,'subscription-account-prototype-1440.png');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await evidence(page,'subscription-account-prototype-390.png');
});


test('quote-only authoring recovery pre-fills the exact topup gap in yuan without rewriting the task',async({page})=>{
 const {calls}=await setup(page,{payment:true});await page.goto('/#/account');await expect(page.locator('#account-balance-title')).toBeVisible();
 const id=await page.evaluate(async()=>{
  const module=await import('/src/'+'billing-task-recovery.ts');module.configureBillingTaskRecovery(()=>'subscription-owner');module.observeAutomaticQuotes({quote:{quote_id:'authoring-quoted',price_version:'bb-task-price-170-20261029-v2',points:20341}});
  const body={execution_request_id:'authoring-gap',project_id:'project-1',input_revision:3,quote_id:'authoring-quoted'};
  try{await module.runRecoverableBillingRequest('POST','/runs/execute',body,{},async()=>{throw {status:402,code:'CREDITS_INSUFFICIENT'};});}catch{}
  const key=Object.keys(localStorage).find(key=>key.startsWith('bondbuddy:billing-task:v1:'))!;return JSON.parse(localStorage.getItem(key)!).id;
 });
 await page.goto('/#/account?'+new URLSearchParams({return_to:'#/projects/project-1',resume_request:id}));await expect(page.locator('#subscription-topup-amount')).toHaveValue('5.59');
 expect(calls.filter(call=>call.path==='/commerce/topups'&&call.method==='POST')).toEqual([]);
});
