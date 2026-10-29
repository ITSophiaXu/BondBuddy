import {test,expect,type BrowserContext,type Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {Value} from '@sinclair/typebox/value';
import {AUTOMATIC_PRICE_VERSION,AUTOMATIC_TASK_TARIFF,encodeBillingDto,projectFileCheckBatchSchemas,type FileCheckBatch,type ProjectFileSource} from '@bondbuddy/contracts';

// Real FileConsistency page and browser request persistence; synthetic API responses.
// Real HTTP/PG/Word execution is covered by ordinary-file-check-batches.pg.test.ts.
const prototypeRoot='/@fs/'+fileURLToPath(new URL('../../../product-prototype/public/',import.meta.url)).replaceAll('\\','/');
const project='synthetic-review',owner='synthetic-owner',base='/projects/'+project,endpoint=base+'/project-files/check-batches';
const now='2026-10-29T04:00:00Z',sha256='a'.repeat(64),each=String(AUTOMATIC_TASK_TARIFF.check.points);
const source:ProjectFileSource={project_id:project,version_id:'source-v1',selection_revision:1,sequence:1,filename:'合成募集说明书.docx',asset:{kind:'material',pin:{source_project_id:project,material_id:'source-material',material_version:1,sha256}}};
const filenames=['合成发行人立项申请文件.docx','合成发行人发行申请文件.docx'];
type Options={failure?:'unknown'|'changed'|'funds';holdFirst?:boolean;noLocks?:boolean;partial?:boolean;outsideRecent?:boolean;retryUnknown?:boolean};
async function fixture(context:BrowserContext,options:Options={}){
  const calls:{method:string;path:string;body:any}[]=[];let batch:FileCheckBatch|undefined,createCount=0,retryCount=0;
  let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
  if(options.noLocks)await context.addInitScript(()=>Object.defineProperty(navigator,'locks',{value:undefined,configurable:true}));
  const items=filenames.map((filename,i)=>({file_version_id:'file-v'+i,filename,points:each,price_version:AUTOMATIC_PRICE_VERSION,scope_quote_id:'scope-'+i,reused_run_id:null}));
  const makeBatch=(requestId:string):FileCheckBatch=>({batch_id:'batch-1',request_id:requestId,source,created_at:now,price_version:AUTOMATIC_PRICE_VERSION,price_versions:[AUTOMATIC_PRICE_VERSION],points:String(2*Number(each)),charged_points:options.partial?each:'0',state:options.partial?'partial':'queued',items:items.map((item,i)=>({...item,run_id:'check-'+i,state:options.partial?i===0?'succeeded':'failed':'queued',attempt:1,charged_points:options.partial&&i===0?each:'0'}))});
  await context.route('**/api/v1/**',async route=>{
    const r=route.request(),path=new URL(r.url()).pathname.replace('/api/v1',''),method=r.method(),body=r.postData()?r.postDataJSON():undefined;calls.push({method,path,body});
    if(path===base)return route.fulfill({json:{project_id:project,name:'合成复核项目',kind:'review',issuer_name:'合成发行人',market:'sse',offering:'private',draft_revision:1,input_revision:null,input_hash:null,updated_at:now}});
    if(path==='/commerce/catalog')return route.fulfill({json:encodeBillingDto('commerceCatalog',{enabled:true,currency:'CNY',version:AUTOMATIC_PRICE_VERSION,model:'subscription_and_topup',items:[],rules:[]})});
    if(path===base+'/project-files/workspace')return route.fulfill({json:{source}});
    if(path===base+'/project-files')return route.fulfill({json:{files:filenames.map((filename,i)=>({file_id:'file-'+i,version_id:'file-v'+i,latest:true,document_type:i?'application':'init',filename,sequence:1,asset:{kind:'material',pin:{source_project_id:project,material_id:'related-'+i,material_version:1,sha256}},revision_asset:null,source_version_id:null,template_id:null,template_version:null,source_name:null,source_sequence:null,created_at:now,run_id:null,links:[],version_count:1,consistency:{status:'unchecked',count:0,check_run_id:null}}))}});
    if(path===base+'/project-files/checks')return route.fulfill({json:{checks:[]}});
    if(path===base+'/project-files/updates')return route.fulfill({json:{batches:[]}});
    if(path===endpoint+'/quote'){
      expect(Value.Check(projectFileCheckBatchSchemas.FileCheckBatchQuoteRequest,body)).toBe(true);
      return route.fulfill({json:{source,points:String(2*Number(each)),price_version:AUTOMATIC_PRICE_VERSION,price_versions:[AUTOMATIC_PRICE_VERSION],auto_charge:true,items:items.map(i=>({...i,quote_status:'ready'}))}});
    }
    if(path===endpoint&&method==='GET')return route.fulfill({json:{batches:batch&&!options.outsideRecent?[batch]:[]}});
    if(path===endpoint+'/batch-1'&&method==='GET')return route.fulfill({json:batch});
    if(path===endpoint&&method==='POST'){
      expect(Value.Check(projectFileCheckBatchSchemas.FileCheckBatchCreateRequest,body)).toBe(true);createCount++;
      if(createCount===1&&options.holdFirst)await gate;
      if(createCount===1&&options.failure)return route.fulfill({status:options.failure==='unknown'?503:options.failure==='changed'?409:402,json:{code:options.failure==='unknown'?'DATA_UNAVAILABLE':options.failure==='changed'?'QUOTE_CHANGED':'CREDITS_INSUFFICIENT'}});
      batch??=makeBatch(body.request_id);expect(batch.request_id).toBe(body.request_id);return route.fulfill({json:batch});
    }
    if(path===endpoint+'/batch-1/retry'){
      expect(Value.Check(projectFileCheckBatchSchemas.FileCheckBatchRetryRequest,body)).toBe(true);expect(body.expected_attempts).toEqual([{file_version_id:'file-v1',run_id:'check-1'}]);expect(body.expected_points).toBe(each);
      if(++retryCount===1&&options.retryUnknown)return route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE'}});
      batch!.items[1]={...batch!.items[1],run_id:'check-1-retry',state:'queued',attempt:2};batch!.state='running';return route.fulfill({json:batch});
    }
    return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
  });
  await context.route('**/ordinary-check-harness',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><main style="max-width:1160px;margin:0 auto;padding:32px 20px"><div id="content"></div></main></body></html>'}));
  return {calls,release,batch:()=>batch};
}
async function mount(page:Page){
  await page.goto('/ordinary-check-harness#consistency?project='+project);
  await page.evaluate(async root=>{const load=(path:string)=>import(path);await load('/src/style.css');await load(root+'styles.css');await load(root+'project-workspace.css');await load('/src/prototype-adapter.css');const {ApiClient}=await load('/src/api.ts'),{FileConsistency}=await load('/src/file-consistency.ts');
    const view=new FileConsistency(new ApiClient(()=>{}),(html:string)=>document.querySelector('#content')!.innerHTML=html,()=>true,'synthetic-review','synthetic-owner');(window as any).consistencyPage=view;await view.render();
  },prototypeRoot);await expect(page.locator('[data-fc-start]')).toBeEnabled();
}
const start=(page:Page)=>page.getByRole('button',{name:'开始逐份检查',exact:true}).click();

test('one click executes without an amount dialog; partial outputs retain independent charges and failed-only retry',async({context,page})=>{
  const f=await fixture(context,{partial:true});await mount(page);await start(page);
  await expect(page.getByRole('heading',{name:'本批部分文件已完成'})).toBeVisible();await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.locator('[data-check-file="file-v0"]')).toContainText('已扣');await expect(page.locator('[data-check-file="file-v1"]')).toContainText('已扣 0 积分');
  await expect(page.locator('[data-check-file="file-v0"] a')).toHaveAttribute('href',/#consistency\?project=synthetic-review&run=check-0/);
  const before=structuredClone(f.batch()!.items[0]);await page.getByRole('button',{name:'仅重试失败或已取消文件'}).click();await expect(page.getByRole('heading',{name:'正在逐份检查'})).toBeVisible();
  expect(f.batch()!.items[0]).toEqual(before);expect(f.batch()!.charged_points).toBe(each);expect(f.calls.filter(c=>c.path.endsWith('/quote'))).toHaveLength(1);
  expect(f.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/checks'))).toHaveLength(0);
});
for(const failure of [undefined,'unknown'] as const)test(`two tabs serialize ${failure??'successful'} submissions and keep one original request`,async({context,page})=>{
  const f=await fixture(context,{holdFirst:true,failure}),other=await context.newPage();await mount(page);await mount(other);
  await start(page);await expect.poll(()=>f.calls.filter(c=>c.path===endpoint&&c.method==='POST').length).toBe(1);await start(other);f.release();
  await expect(other.getByRole('heading',{name:'逐份检查已受理'})).toBeVisible();
  const creates=f.calls.filter(c=>c.path===endpoint&&c.method==='POST');expect(creates).toHaveLength(failure?2:1);expect(new Set(creates.map(c=>c.body.request_id)).size).toBe(1);expect(f.calls.filter(c=>c.path.endsWith('/quote'))).toHaveLength(1);
  expect(await other.evaluate(()=>JSON.parse(localStorage.getItem('bondbuddy:file-check-batch:v1:'+JSON.stringify(['synthetic-owner','synthetic-review']))!))).toMatchObject({completed:{request_id:creates[0].body.request_id,batch_id:'batch-1'}});
});
test('a definite quote conflict permits a fresh quote after rejected submission',async({context,page})=>{
  const f=await fixture(context,{failure:'changed'});await mount(page);await start(page);await expect(page.locator('#fc-check-batches [role="alert"]')).toBeVisible();await start(page);await expect(page.getByRole('heading',{name:'逐份检查已受理'})).toBeVisible();
  const creates=f.calls.filter(c=>c.path===endpoint&&c.method==='POST');expect(creates).toHaveLength(2);expect(creates[0].body.request_id).not.toBe(creates[1].body.request_id);expect(f.calls.filter(c=>c.path.endsWith('/quote'))).toHaveLength(2);
});
test('insufficient balance retains the original range and only offers subscription or topup',async({context,page})=>{
  const f=await fixture(context,{failure:'funds'});await mount(page);await start(page);await expect(page.getByText('积分不足，原文件范围和价格已保存，尚未开始。')).toBeVisible();await expect(page.getByRole('link',{name:'订阅或充值',exact:true})).toBeVisible();
  await page.locator('[data-file-check-pending]').click();await expect(page.getByRole('heading',{name:'逐份检查已受理'})).toBeVisible();
  const creates=f.calls.filter(c=>c.path===endpoint&&c.method==='POST');expect(creates[0].body).toEqual(creates[1].body);expect(f.calls.filter(c=>c.path.endsWith('/quote'))).toHaveLength(1);
});
test('without Web Locks the page does not quote or submit a chargeable task',async({context,page})=>{
  const f=await fixture(context,{noLocks:true});await mount(page);await start(page);await expect(page.locator('#fc-check-batches [role="alert"]')).toBeVisible();expect(f.calls.filter(c=>c.method==='POST')).toEqual([]);
});
test('an unknown retry outside the recent-30 list restores the exact old batch and request after reopening',async({context,page})=>{
  const f=await fixture(context,{partial:true,outsideRecent:true,retryUnknown:true});await mount(page);await start(page);await expect(page.getByRole('heading',{name:'本批部分文件已完成'})).toBeVisible();
  await page.getByRole('button',{name:'仅重试失败或已取消文件'}).click();await expect(page.locator('[data-file-check-pending]')).toBeEnabled();
  await mount(page);await expect(page.getByRole('heading',{name:'本批部分文件已完成'})).toBeVisible();await page.locator('[data-file-check-pending]').click();await expect(page.getByRole('heading',{name:'正在逐份检查'})).toBeVisible();
  const attempts=f.calls.filter(c=>c.path.endsWith('/batch-1/retry'));expect(attempts).toHaveLength(2);expect(attempts[0].body).toEqual(attempts[1].body);expect(f.calls.filter(c=>c.method==='GET'&&c.path.endsWith('/batch-1')).length).toBeGreaterThan(1);expect(f.batch()!.items[0].run_id).toBe('check-0');
});
test('capture same-size partial-batch prototype and implementation at desktop and mobile sizes',async({context,page})=>{
  const out=process.env.BB_UX_EVIDENCE_DIR;if(!out)return;await mkdir(out,{recursive:true});await fixture(context,{partial:true});await mount(page);await start(page);await expect(page.getByRole('heading',{name:'本批部分文件已完成'})).toBeVisible();
  for(const width of [1440,390]){await page.setViewportSize({width,height:960});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.locator('#content').screenshot({path:join(out,`ordinary-check-implementation-${width}.png`)});}
  await page.goto(prototypeRoot+'prospectus-panel.html?purpose=consistency&check-batches=partial');
  await expect(page.getByRole('heading',{name:'本批部分文件已完成'})).toBeVisible();
  for(const width of [1440,390]){await page.setViewportSize({width,height:960});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.locator('#consistency-preview').screenshot({path:join(out,`ordinary-check-prototype-${width}.png`)});}
  await page.getByRole('button',{name:'仅重试失败或已取消文件'}).click();await expect(page.getByRole('heading',{name:'正在逐份检查'})).toBeVisible();await expect(page.locator('dialog[open]')).toHaveCount(0);
});
