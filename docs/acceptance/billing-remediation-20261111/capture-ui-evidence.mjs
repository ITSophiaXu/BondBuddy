import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const output=dirname(fileURLToPath(import.meta.url)),require=createRequire(resolve(repo,'package.json')),{chromium}=require('playwright');
await mkdir(output,{recursive:true});
const server=createServer(async(req,res)=>{
 try{
  const file=resolve(repo,'.'+decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname));
  if(!file.startsWith(resolve(repo)+sep)){res.writeHead(403);res.end();return;}
  const bytes=await readFile(file),mime={'.html':'text/html;charset=utf-8','.css':'text/css;charset=utf-8','.js':'text/javascript;charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'}[extname(file)]??'application/octet-stream';res.writeHead(200,{'content-type':mime});res.end(bytes);
 }catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const prototypeOrigin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({viewport:{width:1440,height:960},deviceScaleFactor:1}),observations=[];
async function screenshot(page,name,extra={}){await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:resolve(output,name),fullPage:false,animations:'disabled'});observations.push({name,viewport:{width:1440,height:960},...extra});}
const mainSource=await readFile(resolve(repo,'apps/web/src/main.ts'),'utf8');
const stylePaths=[...mainSource.matchAll(/^import ['"]([^'"]+\.css)['"];$/gm)].map(m=>'/@fs/'+resolve(repo,'apps/web/src',m[1]).replaceAll('\\','/'));
async function implementation(){
 const page=await context.newPage();await page.route('**/api/v1/**',r=>r.fulfill({status:401,json:{code:'UNAUTHENTICATED'}}));
 await page.route('**/__billing_evidence_host.html',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><script type="module">await Promise.all('+JSON.stringify(stylePaths)+'.map(p=>import(p)));window.syntheticStylesReady=true;</script></body></html>'}));
 await page.goto('http://127.0.0.1:5173/__billing_evidence_host.html',{waitUntil:'load'});await page.waitForFunction(()=>window.syntheticStylesReady===true);return page;
}
try{
 const prototype=await context.newPage();let apiRequests=0;await prototype.route('**/api/**',r=>{apiRequests++;return r.abort();});
 await prototype.goto(prototypeOrigin+'/product-prototype/public/account-credits.html?subscription=1&cycle=annual');await prototype.locator('.subscription-plan-grid').waitFor();await prototype.locator('.subscription-plan-grid').scrollIntoViewIfNeeded();
 await screenshot(prototype,'prototype-annual-account-1440x960.png',{source:'product-prototype/public/account-credits.html?subscription=1&cycle=annual',exactCounterpart:false,reason:'原型展示年度套餐及规则，没有整期现金退款输入状态。'});
 await prototype.goto(prototypeOrigin+'/product-prototype/public/integrity-notes.html');await screenshot(prototype,'prototype-integrity-notes-1440x960.png',{source:'product-prototype/public/integrity-notes.html',exactCounterpart:false,reason:'仓库只提供诚信说明区原型，未提供完整名单／五主体限制／pending恢复原型。'});
 await prototype.goto(prototypeOrigin+'/product-prototype/public/task-results.html');await screenshot(prototype,'prototype-task-results-1440x960.png',{source:'product-prototype/public/task-results.html',exactCounterpart:false,reason:'任务列表为最接近原型，没有billing_reconcile状态卡。'});assert.equal(apiRequests,0);await prototype.close();

 const annual=await implementation();await annual.evaluate(async()=>{
  const module='/src/commerce-refunds.ts',{CommerceRefunds}=await import(module);
  document.body.innerHTML='<main style="max-width:1100px;margin:28px auto"><p class="muted">合成视觉取证 · 生产退款组件临时装渲染</p><div id="synthetic-refund"></div></main>';
  const eligibility={order_id:'synthetic-annual-order',currency:'CNY',order_amount_fen:'1078920',paid_amount_fen:'1078920',original_points:'1368000',request_unit:'amount_fen',refundable_points:'114000',refunded_points:'0',refundable_fen:'1078920',held_refund_fen:'0',refunded_fen:'0',enabled:true,reason:'',refunds:[]};
  const api={request:async()=>eligibility};const component=new CommerceRefunds(api,()=>true,'synthetic-owner',()=>true);component.mount(document.getElementById('synthetic-refund'),'synthetic-annual-order');Object.assign(window,{syntheticComponent:component});
 });await annual.locator('[data-refund-amount]').waitFor();assert.equal(await annual.locator('[data-refund-amount]').inputValue(),'10789.20');assert.equal(await annual.locator('[data-refund-amount]').getAttribute('readonly'),'');
 await screenshot(annual,'implementation-annual-refund-1440x960.png',{source:'apps/web/src/commerce-refunds.ts',render:'真实组件，合成年度资格，独立临时宿主',amount:'10789.20',readonly:true});await annual.close();

 const integrity=await implementation();await integrity.evaluate(async()=>{
  const module='/src/integrity-workspace.ts',types='/src/billing-types.ts',{IntegrityWorkspace}=await import(module),contracts=await import(types);
  const subjects=Array.from({length:5},(_,i)=>({id:'subject-'+i,kind:'company',name:'合成测试企业'+(i+1),identifier:'',role:i?'关联方':'发行人',province:'上海',city:''}));
  const workspace={revision:1,draft:{subjects,site_ids:['csrc'],notes:'合成范围：五个主体。'},price:{...contracts.INTEGRITY_PRICE,points:'22738',version:contracts.AUTOMATIC_PRICE_VERSION,price_version:contracts.AUTOMATIC_PRICE_VERSION,pricing_mode:'outcome_cny_v1',currency:'CNY',amount_fen:'22738',auto_charge:true},rounds:[]};
  document.body.innerHTML='<main id="synthetic-integrity" style="max-width:1100px;margin:28px auto"></main>';
  const api={project:async()=>({project_id:'synthetic-evidence-project',name:'合成视觉取证项目',kind:'generation',issuer_name:'合成测试企业1',market:'sse',offering:'private',draft_revision:1,input_revision:null,input_hash:null,updated_at:'2026-11-11T00:00:00Z'}),request:async()=>workspace};
  const controller=new IntegrityWorkspace(api,html=>{document.getElementById('synthetic-integrity').innerHTML=html;},()=>true,'synthetic-evidence-project','synthetic-evidence-owner');await controller.render();Object.assign(window,{syntheticComponent:controller});
 });await integrity.locator('#integrity-roster').waitFor();await integrity.locator('#integrity-add').click();assert.equal(await integrity.locator('[data-subject-row]').count(),5);assert.match(await integrity.locator('#integrity-status').textContent(),/每轮最多 5 个对象/);
 await screenshot(integrity,'implementation-integrity-five-subjects-1440x960.png',{source:'apps/web/src/integrity-workspace.ts',render:'真实工作区控制器，合成只读API，独立临时宿主',subjects:5});
 await integrity.locator('#integrity-status').scrollIntoViewIfNeeded();await screenshot(integrity,'implementation-integrity-limit-feedback-1440x960.png',{source:'apps/web/src/integrity-workspace.ts',subjects:5,status:await integrity.locator('#integrity-status').textContent()});await integrity.close();

 const recovery=await implementation();await recovery.evaluate(async()=>{
  const module='/src/integrity-workspace.ts',types='/src/billing-types.ts',compiled=await(await fetch(module)).text(),apiModule=compiled.match(/from ["']([^"']*\/api\.ts[^"']*)["']/)[1],{IntegrityWorkspace}=await import(module),contracts=await import(types),{ApiError}=await import(apiModule);
  const draft={subjects:[{id:'issuer',kind:'company',name:'合成恢复测试企业',identifier:'',role:'发行人',province:'上海',city:''}],site_ids:['csrc'],notes:'原准备内容完整保留。'},request={request_id:'synthetic-legacy-5000',expected_revision:1,expected_points:5000,price_version:contracts.INTEGRITY_PRICE.version};
  const value={revision:1,draft,pending:{kind:'check',request}},owner='synthetic-recovery-owner',project='synthetic-recovery-project';localStorage.setItem(`bb-integrity-recovery:${owner}:${project}`,JSON.stringify({version:'integrity-recovery-cache-v1',owner,project,value}));
  const workspace={revision:1,draft,price:{...contracts.INTEGRITY_PRICE,points:'22738',version:contracts.AUTOMATIC_PRICE_VERSION,price_version:contracts.AUTOMATIC_PRICE_VERSION,pricing_mode:'outcome_cny_v1',currency:'CNY',amount_fen:'22738',auto_charge:true},rounds:[]};document.body.innerHTML='<main id="synthetic-integrity" style="max-width:1100px;margin:28px auto"></main>';
  let submissions=0;const api={project:async()=>({project_id:project,name:'合成旧请求恢复项目',kind:'generation',issuer_name:'合成恢复测试企业',market:'sse',offering:'private',draft_revision:1,input_revision:null,input_hash:null,updated_at:'2026-11-11T00:00:00Z'}),request:async(method)=>{if(method==='POST'){submissions++;throw new ApiError(409,'BILLING_REQUEST_REJECTED');}return workspace;}};
  const controller=new IntegrityWorkspace(api,html=>document.getElementById('synthetic-integrity').innerHTML=html,()=>true,project,owner);await controller.render();Object.assign(window,{syntheticComponent:controller,syntheticSubmissions:()=>submissions});
 });await recovery.locator('#integrity-retry-pending').waitFor();assert.equal(await recovery.evaluate(()=>window.syntheticSubmissions()),0);
 await screenshot(recovery,'implementation-integrity-pending-before-1440x960.png',{source:'apps/web/src/integrity-workspace.ts',pending:'原numeric5000/key保持',autoSubmissions:0});
 await recovery.locator('#integrity-retry-pending').click();await recovery.waitForFunction(()=>!document.getElementById('integrity-retry-pending'));assert.equal(await recovery.locator('#integrity-preparation-controls').getAttribute('disabled'),null);assert.equal(await recovery.evaluate(()=>window.syntheticSubmissions()),1);
 await screenshot(recovery,'implementation-integrity-pending-rejected-1440x960.png',{source:'apps/web/src/integrity-workspace.ts',pending:false,submissions:1,autoNewTask:false});await recovery.locator('#integrity-status').scrollIntoViewIfNeeded();assert.match(await recovery.locator('#integrity-status').textContent(),/上次请求未受理，已结束该申请/);await screenshot(recovery,'implementation-integrity-rejected-feedback-1440x960.png',{source:'apps/web/src/integrity-workspace.ts',status:await recovery.locator('#integrity-status').textContent()});await recovery.close();

 const reconcile=await implementation();await reconcile.evaluate(async()=>{
  const statusModule='/src/authoring-progress.ts',progressModule='/src/task-progress.ts',{authoringStatus}=await import(statusModule),{taskProgress}=await import(progressModule);
  const run={run_id:'synthetic-reconcile-run',project_id:'synthetic-project',execution_request_id:'original-key',input_revision:1,input_hash:'a'.repeat(64),state:'paused',stage:'billing_reconcile',event_cursor:0,channel:'production',billing_mode:'fixed_credits',reservation_id:'original-reservation',artifact_id:null,prompt_snapshot_ref:null,updated_at:'2026-11-11T00:00:00Z'};
  document.body.innerHTML='<main style="max-width:1100px;margin:28px auto"><p class="muted">合成视觉取证 · 生产进度组件临时装渲染</p><div class="run-status-card"><div class="eyebrow">募集书全文更新</div>'+taskProgress(run,'update',authoringStatus(run,[]))+'</div></main>';
 });assert.match(await reconcile.locator('.task-progress').textContent(),/正在核对积分账务，任务已暂停/);await screenshot(reconcile,'implementation-billing-reconcile-1440x960.png',{source:'apps/web/src/authoring-progress.ts + task-progress.ts',render:'真实生产进度组件及状态函数，合成paused/billing_reconcile',noSuccessOrRechargeClaim:true});await reconcile.close();
 await writeFile(resolve(output,'observations.json'),JSON.stringify({synthetic:true,productionAccess:false,prototypeOrigin,observations},null,2));
 console.log(JSON.stringify({screenshots:observations.length,viewport:'1440x960',synthetic:true,output},null,2));
}finally{await context.close();await browser.close();await new Promise(r=>server.close(r));}
