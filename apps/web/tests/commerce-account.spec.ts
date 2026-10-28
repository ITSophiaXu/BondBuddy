import {mkdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {expect,test,type Page,type Route} from '@playwright/test';
import {DATA_POLICY_VERSION,DELETION_PURGED_CONTENT,DELETION_RETAINED_METADATA,commerceMetadata,type DataPolicy} from '@bondbuddy/contracts';

// Synthetic HTTP tests exercise display, amount confirmation and safe retries, not merchant settlement.
const now='2026-10-28T04:00:00Z';
const policy:DataPolicy={policy_version:DATA_POLICY_VERSION,storage_location:'platform_private_cloud',server_side_processing:true,model_provider_processing:true,active_retention:'until_user_deletes',purge_enabled:false,deleted_content_purge_days:null,orphan_upload_purge_hours:null,log_content_retention_days:30,backup_retention_days:null,pinned_by_active_run:'retained_until_run_ends',purged_content:[...DELETION_PURGED_CONTENT],retained_metadata:[...DELETION_RETAINED_METADATA]};
async function evidence(page:Page,name:string){const directory=process.env.BB_UX_EVIDENCE_DIR;if(!directory)return;await mkdir(directory,{recursive:true});await page.screenshot({path:join(directory,name),fullPage:true});}
test.beforeEach(async({page})=>page.setViewportSize({width:1440,height:960}));
const json=(route:Route,status:number,body:unknown)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
async function setup(page:Page,options:{payment?:boolean;uncertainTopup?:boolean}={}){
  const calls:{method:string;path:string;body:any}[]=[];
  const order={order_id:'synthetic-cny-order',provider:'wechat',state:'pending',amount_fen:1234,points:1234,currency:'CNY',checkout_url:'weixin://wxpay/bizpayurl?pr=synthetic-local-qr',project_id:null,expires_at:'2030-01-01T00:00:00Z',credited_at:null};
  let created=0;
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.replace('/api/v1',''),method=request.method(),body=request.postData()?request.postDataJSON():undefined;calls.push({method,path,body});
    if(path==='/me')return json(route,200,{user_id:'commerce-owner',session_status:'active'});
    if(path==='/account')return json(route,200,{user_id:'commerce-owner',username:'sample_user',phone_masked:null,status:'active',created_at:now,accepted_terms_version:'terms-1',current_terms_version:'terms-1',password_updated_at:null,self_service_recovery:'unavailable',support_contact:null});
    if(path==='/account/sessions')return json(route,200,{items:[{session_id:'commerce-session',current:true,created_at:now,last_refreshed_at:now,refresh_expires_at:'2030-01-01T00:00:00Z'}]});
    if(path==='/account/recovery')return json(route,200,{enabled:false,support_operator:false,current:null,pending:null});
    if(path==='/data-policy')return json(route,200,policy);
    if(path==='/commerce/catalog')return json(route,200,{enabled:true,currency:'CNY',version:'synthetic-price',model:'pay_as_you_go',items:[{code:'synthetic',label:'示例成果',unit:'份',price_fen:3990,capability:'limited',scope:['依本次输入范围报价'],included:['原范围修正']}],rules:['执行前确认本次总价。']});
    if(path==='/commerce/account')return json(route,200,{available_fen:16800,held_fen:4990,payment_enabled:!!options.payment,providers:options.payment?['wechat']:[],legacy_balance_notice:'旧积分保留原规则。'});
    if(path==='/credits/consumption-history')return json(route,200,{items:[{reservation_id:'cny-settled',run_id:'commercial-run',project_id:'project-1',project_name:'合成项目',task_name:'内审问题回复',created_at:now,finalized_at:now,state:'settled',reserved_points:4990,charged_points:4990,released_points:0,corrected_points:0,...commerceMetadata(4990)},{reservation_id:'legacy-settled',run_id:'legacy-run',project_id:'project-old',project_name:'旧项目',task_name:'关联文件生成',created_at:now,finalized_at:now,state:'settled',reserved_points:4500,charged_points:4500,released_points:0,corrected_points:0}],page:{next_cursor:null,has_more:false}});
    if(path==='/credits/recharge-history')return json(route,200,{items:[{order_id:'cny-topup',provider:'wechat',state:'paid',amount_fen:1234,points:1234,created_at:now,credited_at:now,...commerceMetadata(1234)},{order_id:'legacy-topup',provider:'alipay',state:'paid',amount_fen:20000,points:21000,created_at:now,credited_at:now}],page:{next_cursor:null,has_more:false}});
    if(path==='/commerce/feedback')return json(route,200,{ok:true});
    if(path==='/commerce/topups'&&method==='POST'){created++;if(options.uncertainTopup&&created===1)return json(route,500,{code:'INTERNAL_ERROR'});return json(route,201,order);}
    if(path.startsWith('/commerce/topups/'))return json(route,200,order);
    return json(route,404,{code:'NOT_FOUND'});
  });
  return {calls};
}

test('commercial account shows CNY and preserves legacy record units without a merchant',async({page})=>{
  const {calls}=await setup(page);await page.goto('/#/account');
  await expect(page.locator('#account-balance-title')).toHaveText('服务余额');
  await expect(page.locator('.account-balance-value')).toHaveText('¥168.00');
  await expect(page.locator('#account-credits')).toContainText('设计参考金额，不是统一成交价或最低价');
  await expect(page.getByRole('form')).toHaveCount(0);
  await expect(page.locator('#commerce-topup')).toHaveCount(0);
  await expect(page.locator('[data-record="cny-settled"] .credit-history-amount')).toContainText('消耗 ¥49.90');
  await expect(page.locator('[data-record="legacy-settled"] .credit-history-amount')).toContainText('消耗 4,500 积分');
  await evidence(page,'commerce-account-implementation-1440.png');
  await page.getByRole('tab',{name:'充值记录',exact:true}).click();
  await expect(page.locator('[data-record="cny-topup"]')).toContainText('¥12.34 服务余额');
  await expect(page.locator('[data-record="legacy-topup"]')).toContainText('21,000 历史积分');
  expect(calls.filter(c=>c.method==='POST')).toEqual([]);
});

test('paid commercial results accept original-scope feedback without promising an automatic refund',async({page})=>{
  const {calls}=await setup(page);await page.goto('/#/account');
  page.once('dialog',dialog=>dialog.accept('原题依据页码需要修正'));
  await page.getByRole('button',{name:'原范围问题／需要修改',exact:true}).click();
  await expect(page.locator('[data-feedback-run="commercial-run"]')).toContainText('已收到，将按原单核实处理。');
  expect(calls.filter(c=>c.path==='/commerce/feedback').map(c=>c.body)).toEqual([expect.objectContaining({run_id:'commercial-run',outcome:'needs_changes',reason:'原题依据页码需要修正'})]);
  await expect(page.locator('[data-record="legacy-settled"] [data-feedback]')).toHaveCount(0);
});

test('an uncertain topup retries the same exact amount and renders the native WeChat QR locally',async({page})=>{
  const {calls}=await setup(page,{payment:true,uncertainTopup:true});await page.goto('/#/account');
  await page.locator('#commerce-topup-amount').fill('12.34');
  await page.getByRole('button',{name:'确认金额并前往支付',exact:true}).click();
  await expect(page.locator('.account-billing-error')).toBeVisible();
  await expect(page.locator('#commerce-topup-amount')).toHaveValue('12.34');
  await page.getByRole('button',{name:'确认金额并前往支付',exact:true}).click();
  await expect(page.getByRole('heading',{name:'等待支付确认',exact:true})).toBeVisible();
  await expect(page.getByRole('img',{name:'本订单微信支付二维码',exact:true})).toHaveAttribute('src',/^data:image\/png;base64,/);
  const topups=calls.filter(c=>c.path==='/commerce/topups'&&c.method==='POST');
  expect(topups).toHaveLength(2);expect(topups[0].body).toEqual(topups[1].body);expect(topups[1].body).toMatchObject({amount_fen:1234,provider:'wechat'});
  await page.getByRole('button',{name:'刷新支付状态',exact:true}).click();
  expect(calls.filter(c=>c.path==='/commerce/topups'&&c.method==='POST')).toHaveLength(2);
});

test('synthetic commerce account prototype uses the same desktop dimensions without payment actions',async({page})=>{
  const directory=resolve('../../product-prototype/public');
  await page.route('**/prototype-commerce/**',async route=>{const filename=new URL(route.request().url()).pathname.split('/').at(-1)!;if(!['account-credits.html','commerce-account-prototype.js'].includes(filename))return route.abort();return route.fulfill({contentType:filename.endsWith('.html')?'text/html':'text/javascript',body:await readFile(join(directory,filename),'utf8')});});
  await page.goto('/prototype-commerce/account-credits.html?commerce=1');await expect(page.locator('#account-credits')).toContainText('设计参考金额');await expect(page.locator('#account-balance-title')).toHaveCount(0);await expect(page.getByRole('button',{name:'支付暂不可用',exact:true})).toBeDisabled();
  await expect(page.locator('.account-balance-value')).toHaveText('¥168.00');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await evidence(page,'commerce-account-prototype-1440.png');
});
