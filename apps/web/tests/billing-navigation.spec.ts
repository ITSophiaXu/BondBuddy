import {expect,test,type Page,type Route} from '@playwright/test';
import {DATA_POLICY_VERSION,DELETION_PURGED_CONTENT,DELETION_RETAINED_METADATA,type DataPolicy} from '@bondbuddy/contracts';
import type {Dto} from '../src/api';

// Synthetic HTTP responses verify navigation and order ownership, not payment settlement.
const now='2026-10-25T04:00:00Z',original='navigation-original',execution='navigation-execution';
const accountSessions:Dto<'AccountSessionListResponse'>={items:[{session_id:'synthetic-current-session',current:true,created_at:now,last_refreshed_at:now,refresh_expires_at:'2030-01-01T00:00:00Z'}]};
const recovery:Dto<'RecoveryAccountResponse'>={enabled:false,support_operator:false,current:null,pending:null};
const policy:DataPolicy={policy_version:DATA_POLICY_VERSION,storage_location:'platform_private_cloud',server_side_processing:true,model_provider_processing:true,active_retention:'until_user_deletes',purge_enabled:false,deleted_content_purge_days:null,orphan_upload_purge_hours:null,log_content_retention_days:30,backup_retention_days:null,pinned_by_active_run:'retained_until_run_ends',purged_content:[...DELETION_PURGED_CONTENT],retained_metadata:[...DELETION_RETAINED_METADATA]};
const json=(route:Route,status:number,body:unknown)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
async function setup(page:Page){
  const calls:{method:string;path:string;body:unknown}[]=[];
  const orders=new Map<string,Record<string,unknown>>();
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname.replace('/api/v1',''),method=req.method(),body=req.postData()?req.postDataJSON():undefined;
    calls.push({method,path,body});
    if(path==='/me')return json(route,200,{user_id:'synthetic-navigation-owner',session_status:'active'});
    if(path==='/account')return json(route,200,{user_id:'synthetic-navigation-owner',username:'sample_user',phone_masked:null,status:'active',created_at:now,accepted_terms_version:'terms-1',current_terms_version:'terms-1',password_updated_at:null,self_service_recovery:'unavailable',support_contact:null});
    if(path==='/account/sessions')return json(route,200,accountSessions);
    if(path==='/account/recovery')return json(route,200,recovery);
    if(path==='/data-policy')return json(route,200,policy);
    if(path==='/credits/balance')return json(route,200,{enabled:true,available:100,frozen:0});
    if(path==='/credits/recharge-config')return json(route,200,{enabled:true,providers:['alipay'],packs:[{id:'cny200',amount_fen:20000,points:20000}],pack_version:'synthetic-navigation'});
    if(path==='/credits/recharge-orders'&&method==='POST'){
      const id='synthetic-order-'+(orders.size+1),order={order_id:id,project_id:body.project_id??null,provider:'alipay',state:'pending',points:20000,amount_fen:20000,checkout_url:null,created_at:now,expires_at:'2030-01-01T00:00:00Z',credited_at:null};
      orders.set(id,order);return json(route,201,order);
    }
    if(path.startsWith('/credits/recharge-orders/'))return json(route,200,orders.get(path.split('/').at(-1)!)??{});
    if(path.startsWith('/credits/'))return json(route,200,{items:[],page:{next_cursor:null,has_more:false}});
    if(path===`/projects/${original}`||path===`/projects/${execution}`)return json(route,200,{project_id:path.split('/').at(-1),name:path.endsWith(original)?'原债券项目':'执行工作区',kind:path.endsWith(execution)?'review':'generation',issuer_name:'合成发行人',market:'sse',offering:'private',draft_revision:1,input_revision:null,input_hash:null,updated_at:now});
    return json(route,404,{code:'NOT_FOUND'});
  });
  return {calls,orders};
}
const account=(work:string,project:string|undefined=execution)=>'#'+ '/account?'+new URLSearchParams({...(project?{project}:{}),return_project:original,return_to:work});

test('recharge order keeps execution ownership and returns to the exact mapped review',async({page})=>{
  const state=await setup(page),work=`#/projects/${execution}/review?tab=results&report_id=report-1&return_project=${original}`;
  await page.goto('/'+account(work));
  await expect(page.getByRole('link',{name:'返回刚才的工作'}).first()).toHaveAttribute('href',work);
  await expect(page.locator('[data-project-context-name]')).toHaveText('原债券项目');
  await page.locator('[data-pack="cny200"]').click();
  await expect(page.getByRole('heading',{name:'等待支付确认'})).toBeVisible();
  const query=await page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).toString());
  expect(new URLSearchParams(query).get('project')).toBe(execution);
  expect(new URLSearchParams(query).get('return_project')).toBe(original);
  expect(new URLSearchParams(query).get('return_to')).toBe(work);
  expect(state.calls.filter(c=>c.method==='POST').map(c=>[c.path,c.body])).toEqual([['/credits/recharge-orders',expect.objectContaining({project_id:execution})]]);
  await expect(page.getByRole('link',{name:'返回刚才的工作'}).first()).toHaveAttribute('href',work);
});

test('associated-file recharge retains the check and never claims automatic batch continuation',async({page})=>{
  const state=await setup(page),work=`#consistency?project=${execution}&run=check-7&file=file-2&return_project=${original}`;
  await page.goto('/'+account(work));
  await expect(page.locator('#account-credits .notice')).toContainText('不会自动提交文件更新或生成');
  await expect(page.locator('#account-credits .notice')).not.toContainText('自动继续');
  await page.locator('[data-pack="cny200"]').click();
  await expect(page.getByRole('heading',{name:'等待支付确认'})).toBeVisible();
  await expect(page.getByRole('link',{name:'返回刚才的工作'}).first()).toHaveAttribute('href',work);
  expect(state.calls.some(c=>c.path.endsWith('/credit-quote'))).toBe(false);
  expect(state.calls.filter(c=>c.method==='POST').every(c=>c.path==='/credits/recharge-orders')).toBe(true);
});

test('a topic-only wallet retains navigation without assigning the original project to its order',async({page})=>{
  const state=await setup(page),work=`#generate?topic=topic-1&run=run-1&return_project=${original}`;
  await page.goto('/'+work);
  const wallet=page.getByRole('link',{name:'查看积分与充值',exact:true});
  await expect(wallet).toBeVisible();const href=await wallet.getAttribute('href'),query=new URLSearchParams(href!.split('?')[1]);
  expect(query.get('project')).toBeNull();expect(query.get('return_project')).toBe(original);expect(query.get('return_to')).toBe(work);
  await wallet.click();await expect(page.locator('[data-pack="cny200"]')).toBeVisible();
  await page.locator('[data-pack="cny200"]').click();
  await expect(page.getByRole('heading',{name:'等待支付确认'})).toBeVisible();
  const create=state.calls.find(c=>c.path==='/credits/recharge-orders'&&c.method==='POST');
  expect(create?.body).not.toHaveProperty('project_id');
  await expect(page.getByRole('link',{name:'返回刚才的工作'}).first()).toHaveAttribute('href',work);
});

test('an external recharge return target is discarded',async({page})=>{
  await setup(page);await page.goto('/'+account('https://example.com/elsewhere'));
  await expect(page.locator('[data-pack="cny200"]')).toBeVisible();
  await expect(page.getByRole('link',{name:'返回刚才的工作'})).toHaveCount(0);
  await expect(page.locator('a[href^="https://example.com"]')).toHaveCount(0);
});
