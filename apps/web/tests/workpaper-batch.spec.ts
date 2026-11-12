import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {AUTOMATIC_PRICE_VERSION,AUTOMATIC_TASK_TARIFF,SUBSCRIPTION_PLANS,SUBSCRIPTION_CATALOG_VERSION,WORKPAPER_PRICE,type WorkpaperWorkspace,type WorkpaperStart,type WorkpaperBatch,type WorkpaperAssess} from '@bondbuddy/contracts';
import {fixture,href,ids,now,sha} from './generation-entry-fixtures';
import {fixtureBody,fixtureRequest} from './billing-fixture-wire';
import {workpaperPreparation} from './workpaper-preparation-fixture';

async function setup(page:import('@playwright/test').Page,count=350){
 const existing=await fixture(page),source=existing.workspaces.get(ids.api)!.source!;
 const data:WorkpaperWorkspace={catalogues:[{catalogue_id:'catalogue-1',filename:'合成底稿目录.xlsx',sha256:sha,created_at:now,warnings:[],entries:Array.from({length:count},(_,i)=>({id:`item-${i+1}`,code:`1.${i+1}`,title:`财务与业务核查 ${i+1}`,folder:'1 尽职调查',kind:'file' as const,path:`1 尽职调查/1.${i+1} 财务与业务核查 ${i+1}.docx`,row:i+2,sheet:'目录',instructions:''}))}],batches:[],assessments:[]};
 const state={data,source,requests:[] as WorkpaperStart[],assessmentRequests:[] as WorkpaperAssess[],resumeRequests:[] as string[],uncertain:false};
 await page.route('**/api/v1/runs/*/resume',async route=>{state.resumeRequests.push(route.request().url());await route.fulfill({status:409,json:{code:'CAPABILITY_NOT_READY'}});});
 await page.route('**/api/v1/projects/*/workpapers**',async route=>{
  const request=route.request(),url=new URL(request.url()),base=`/api/v1/projects/${ids.api}/workpapers`;
  if(url.pathname===base&&request.method()==='GET')return route.fulfill({json:fixtureBody(route,data)});
  if(url.pathname===base+'/progress')return route.fulfill({json:{revision:createHash('sha256').update(JSON.stringify(data.batches)).digest('hex'),active:data.batches.some(b=>['queued','running'].includes(b.state))}});
  if(url.pathname===base+'/assessments'){state.assessmentRequests.push(request.postDataJSON());return route.fulfill({status:500,json:{code:'UNEXPECTED_PREFLIGHT'}});}
  if(url.pathname===base+'/batches'){
   const body=fixtureRequest(request) as WorkpaperStart;state.requests.push(body);
   if(!data.batches.length){const b:WorkpaperBatch={batch_id:'batch-1',topic_id:'topic-workpapers',catalogue_id:body.catalogue_id,revision:1,state:'queued',start_mode:body.start_mode??'assessed',source:structuredClone(source),total_points:body.expected_points,charged_points:0,created_at:now,error:null,
    items:data.catalogues[0].entries.filter(e=>body.item_ids.includes(e.id)).map(entry=>({entry,run_id:null,state:'queued',stage:null,attempt:1,error:null,artifacts:[]}))};data.batches.push(b);}
   if(state.uncertain){state.uncertain=false;return route.abort('failed');}return route.fulfill({json:fixtureBody(route,data.batches[0])});
  }
  if(url.pathname.endsWith('/actions')){const b=data.batches[0],action=fixtureRequest(request).action;b.state=action==='pause'?'paused':action==='cancel'?'cancelled':'queued';b.revision++;return route.fulfill({json:fixtureBody(route,b)});}
  return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
 });return state;
}
const assertNoPreflight=async(page:import('@playwright/test').Page)=>{
 await expect(page.locator('#wp-reviewed')).toHaveCount(0);await expect(page.locator('#wp-assess')).toHaveCount(0);await expect(page.locator('.wp-check-status')).toHaveCount(0);
 if(page.url().includes('workpaper-batch.html'))await expect(page.locator('.wp-workflow')).toContainText('选择底稿');
 else {await expect(page.locator('.pf-flow-steps')).toContainText('选择募集说明书');await expect(page.locator('.pf-flow-steps')).toContainText('选择生成内容');await expect(page.locator('.pf-flow-steps')).toContainText('确认并生成');}
};
async function submitSelection(page:import('@playwright/test').Page){await page.locator('#wp-start').click();if(await page.locator('#wp-confirm-start').isVisible()){await expect(page.locator('[data-flow-step="3"]')).toHaveAttribute('aria-current','step');await page.locator('#wp-confirm-start').click();}}

async function setupPreparation(page:import('@playwright/test').Page,count=350,automatic=false,builtinAvailable=true){
 const state=await setup(page,count);
 const generation=await workpaperPreparation(page,state.data,state.source,automatic,builtinAvailable);
 return {...state,generation};
}
async function openPreparation(page:import('@playwright/test').Page){
 await page.goto('/'+href({step:'workpapers'}));
 await expect(page).toHaveURL(/step=prepare/);
 await expect(page.getByRole('heading',{name:'底稿目录与文件模板',exact:true})).toBeVisible();
 await expect(page.locator('#fg-confirm')).toBeEnabled();
}
async function submitPreparation(page:import('@playwright/test').Page,automatic=false){
 await page.locator('#fg-confirm').click();
 if(!automatic){await expect(page.locator('#fg-submit')).toBeVisible();await page.locator('#fg-submit').click();}
 await expect(page.locator('.fg-status')).toContainText('本批文件已提交');
}
async function existingBatch(page:import('@playwright/test').Page,count:number){
 const state=await setup(page,count);state.data.batches.push({batch_id:'batch-1',topic_id:'topic-workpapers',catalogue_id:'catalogue-1',revision:1,state:'running',start_mode:'direct',source:structuredClone(state.source),total_points:0,charged_points:0,created_at:now,error:null,items:state.data.catalogues[0].entries.map(entry=>({entry,run_id:null,state:'queued',stage:null,attempt:1,error:null,artifacts:[]}))});return state;
}
async function seedLegacy(page:import('@playwright/test').Page,saved:Record<string,unknown>){
 await page.addInitScript(({key,saved})=>{if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify(saved));},{key:`bb-workpapers-v1:${ids.owner}:${ids.api}`,saved});
}
async function screenshotPath(name:string){
 const path=process.env.BB_UX_EVIDENCE_DIR?resolve(process.env.BB_UX_EVIDENCE_DIR,name):test.info().outputPath(name);
 await mkdir(dirname(path),{recursive:true});return path;
}

test('asynchronous batch shortage pays and resumes the exact remaining batch without touching a manual pause',async({page})=>{
 await page.setViewportSize({width:1440,height:960});
 const s=await setup(page,3),points=AUTOMATIC_TASK_TARIFF.workpaper.points;
 s.data.price={version:AUTOMATIC_PRICE_VERSION,points,auto_charge:true};
 const batch:WorkpaperBatch={batch_id:'short-batch',topic_id:'topic-short',catalogue_id:'catalogue-1',revision:4,state:'paused',source:s.source,total_points:points*2,charged_points:points,created_at:now,error:'积分不足',billing_resume:{price_version:AUTOMATIC_PRICE_VERSION,required_points:points,available_points:0,shortage:points},items:s.data.catalogues[0].entries.slice(0,2).map((entry,i)=>({entry,run_id:i?'': 'completed-child',state:i?'queued':'succeeded',stage:null,attempt:1,error:null,artifacts:[]}))};
 const manual={...structuredClone(batch),batch_id:'manually-paused',billing_resume:undefined,error:null};s.data.batches=[manual,batch];
 let funded=false;const actions:any[]=[],payments:any[]=[],future=new Date(Date.now()+86400000).toISOString();
 const order=()=>({order_id:'recovery-topup',provider:'wechat',state:funded?'paid':'pending',amount_fen:points,points,currency:'CNY',checkout_url:'weixin://wxpay/bizpayurl?pr=synthetic',project_id:null,expires_at:future,credited_at:funded?new Date().toISOString():null});
 await page.route('**/api/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname.replace('/api/v1','');
  if(path==='/account/sessions')return route.fulfill({json:{items:[]}});
  if(path==='/account/recovery')return route.fulfill({json:{enabled:false,support_operator:false,current:null,pending:null}});
  if(path===`/projects/${ids.api}/workpapers/batches/short-batch/actions`){const body=route.request().postDataJSON();actions.push(body);if(!funded)return route.fulfill({status:402,json:{code:'CREDITS_INSUFFICIENT'}});batch.state='queued';batch.revision++;batch.billing_resume=undefined;return route.fulfill({json:fixtureBody(route,batch)});}
  if(path==='/subscriptions/catalog')return route.fulfill({json:fixtureBody(route,{enabled:true,version:SUBSCRIPTION_CATALOG_VERSION,plans:SUBSCRIPTION_PLANS,providers:['wechat'],auto_renew_available:false})});
  if(path==='/subscriptions/account')return route.fulfill({json:fixtureBody(route,{subscription:null,available_points:funded?points:0,held_points:0,subscription_available_points:0,topup_available_points:funded?points:0,other_available_points:0,periods:[]})});
  if(path==='/commerce/catalog')return route.fulfill({json:fixtureBody(route,{enabled:true,version:AUTOMATIC_PRICE_VERSION,currency:'CNY',model:'subscription_and_topup',items:[],rules:[]})});
  if(path==='/commerce/quotations')return route.fulfill({json:{items:[]}});
  if(path==='/credits/consumption-history'||path==='/credits/recharge-history')return route.fulfill({json:{items:[],page:{has_more:false,next_cursor:null}}});
  if(path==='/commerce/topups'&&route.request().method()==='POST'){payments.push(fixtureRequest(route.request()));return route.fulfill({status:201,json:fixtureBody(route,order())});}
  if(path==='/commerce/topups/recovery-topup/refresh')throw new Error('Automatic recovery must not need the refresh-payment button');
  if(path==='/commerce/topups/recovery-topup')return route.fulfill({json:fixtureBody(route,order())});
  await route.fallback();
 });
 await page.goto('/'+href({step:'workpapers',view:'results',batch:batch.batch_id}));
 await expect(page.locator('[data-wp-batch-id="manually-paused"]')).not.toContainText('需足够积分');expect(actions).toEqual([]);
 if(process.env.BB_UX_EVIDENCE_DIR){await page.evaluate(()=>window.scrollTo(0,0));await expect.poll(()=>page.evaluate(()=>scrollY)).toBe(0);await page.screenshot({path:await screenshotPath('workpaper-shortage-1440.png'),fullPage:true});}
 await page.locator('[data-wp-batch-id="short-batch"]').getByRole('button',{name:'继续本批（需足够积分）'}).click();
 await expect(page.locator('#billing-task-notice')).toContainText('已完成文件保留，待执行请求已保存');await expect(page.locator('#billing-task-notice')).toContainText('查看积分与支付渠道状态；积分充足后返回，将自动继续这一批的剩余文件');expect(actions).toHaveLength(1);expect(payments).toEqual([]);
 const fundingLink=page.locator('#billing-task-notice').getByRole('link',{name:'查看积分与支付状态',exact:true}),fundingHref=(await fundingLink.getAttribute('href'))!,fundingQuery=new URLSearchParams(fundingHref.split('?')[1]);
 expect(fundingHref.split('?')[0]).toBe('#/account');expect(fundingQuery.get('return_to')).toBe(href({step:'workpapers',view:'results',batch:batch.batch_id}));expect(fundingQuery.get('resume_request')).toMatch(/^[a-f0-9]{64}$/);
 await fundingLink.click();
 await expect(page.locator('#subscription-topup-amount')).toHaveValue((points/100).toFixed(2));
 await page.getByRole('button',{name:'充值并前往支付'}).click();await expect(page.getByRole('button',{name:'刷新支付状态'})).toBeVisible();
 expect(actions).toHaveLength(1);funded=true;await page.evaluate(()=>window.dispatchEvent(new Event('bondbuddy:credits-changed')));
 await expect.poll(()=>actions.length).toBe(2);expect(actions[1]).toEqual(actions[0]);expect(payments).toHaveLength(1);expect(payments[0].amount_fen).toBe(points);
 await expect(page).toHaveURL(/view=results&batch=short-batch/);expect(manual.state).toBe('paused');
 await page.reload();await expect(page.locator('[data-wp-batch-id="short-batch"]')).toContainText('等待生成');expect(actions).toHaveLength(2);
});

for(const width of [1440,390,320])test(`saved directory stays compact and confirmation preserves selected scope ${width}`,async({page})=>{
 const state=await setupPreparation(page,3);await page.setViewportSize({width,height:960});await openPreparation(page);
 await expect(page.locator('.fg-source-card').first()).toContainText('合成底稿目录.xlsx');await expect(page.locator('#fg-matches')).toBeHidden();
 await expect(page.getByText('更换目录',{exact:true})).toBeVisible();await expect(page.locator('#fg-catalogue-upload')).toBeEnabled();
 await page.locator('#fg-edit-scope').click();await page.locator('[data-fg-item="item-1"]').uncheck();
 await expect(page.locator('.fg-source-card').first()).toContainText('已选 2 / 3 项');
 await expect.poll(()=>state.generation.data.preparation.item_ids).toEqual(['item-2','item-3']);
 await page.screenshot({path:await screenshotPath(`directory-${width}.png`),fullPage:true});
 await page.locator('#fg-confirm').click();expect(state.generation.submissions).toHaveLength(0);
 await expect(page.getByRole('dialog')).toContainText('2 份文件');await expect(page.getByRole('dialog')).toContainText('9,000');
 await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();await expect(page.locator('[data-fg-item]:checked')).toHaveCount(2);
 await page.reload();await expect(page.locator('.fg-source-card').first()).toContainText('已选 2 / 3 项');
 await page.locator('#fg-confirm').click();await page.screenshot({path:await screenshotPath(`confirmation-${width}.png`),fullPage:true});
 await page.locator('#fg-submit').click();await expect(page.locator('.fg-status')).toContainText('本批文件已提交');
 expect(state.generation.submissions).toHaveLength(1);expect(state.generation.submissions[0].preparation.item_ids).toEqual(['item-2','item-3']);
 await expect(page.locator('[data-flow-step="4"]')).toHaveAttribute('aria-current','step');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.reload();await expect(page.locator('.fg-history')).toContainText('底稿 0/2');expect(state.generation.submissions).toHaveLength(1);expect(state.requests).toHaveLength(0);
});

test('first visit with no catalogue presents the upload control',async({page})=>{
  const state=await setupPreparation(page,3,false,false);state.data.catalogues=[];
  await page.goto('/'+href({step:'workpapers'}));
  await expect(page).toHaveURL(/step=prepare/);
  await expect(page.getByRole('heading',{name:'底稿目录与文件模板',exact:true})).toBeVisible();
  await expect(page.getByText('上传目录',{exact:true})).toBeVisible();await expect(page.locator('#fg-catalogue-upload')).toBeEnabled();
  await expect(page.getByText('底稿记录暂时无法读取。原记录已保留，请刷新重试。')).toHaveCount(0);
  await page.reload();await expect(page.locator('#fg-catalogue-upload')).toBeEnabled();await expect(page.locator('#fg-confirm')).toBeDisabled();
  expect(state.generation.quotes).toEqual([]);expect(state.generation.submissions).toEqual([]);
});
for(const width of [1440,390])test(`automatic workpaper ${width} quotes each selected file and charges on delivery without a confirmation step`,async({page})=>{
 const state=await setupPreparation(page,350,true);await page.setViewportSize({width,height:960});await openPreparation(page);
 await expect(page.locator('#fg-confirm')).toHaveText('生成本批文件');
 // Keep the delivery-charging disclosure assertion while migrating the route.
 // A missing disclosure must remain a product failure, not a removed assertion.
 await expect.soft(page.locator('.fg-footer')).toContainText('每份底稿 3,458 积分');
 await expect.soft(page.locator('.fg-footer')).toContainText('成功交付后扣费');await expect(page.locator('.fg-footer')).not.toContainText('按处理进度');
 if(process.env.BB_UX_EVIDENCE_DIR){await page.locator('.fg-footer').screenshot({path:await screenshotPath(`workpaper-automatic-card-${width}.png`)});}
 await submitPreparation(page,true);expect(state.generation.quotes).toHaveLength(1);expect(state.generation.submissions).toHaveLength(1);
 expect(state.generation.submissions[0].request).toMatchObject({price_version:AUTOMATIC_PRICE_VERSION,expected_points:350*AUTOMATIC_TASK_TARIFF.workpaper.points});
 expect(state.generation.submissions[0].preparation.item_ids).toEqual(state.data.catalogues[0].entries.map(e=>e.id));
 await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('.fg-history')).toContainText('底稿 0/350');
 await page.getByRole('link',{name:'底稿进度与下载',exact:true}).click();await expect(page.locator('#wp-batches')).toContainText('0 / 350 份完成');expect(state.requests).toHaveLength(0);
});
for(const width of [1440,390])test(`confirmation submits selected 349 files and shows progress ${width}`,async({page})=>{
 const state=await setupPreparation(page);await page.setViewportSize({width,height:960});await openPreparation(page);await assertNoPreflight(page);
 await page.locator('#fg-edit-scope').click();await expect(page.locator('[data-fg-item]')).toHaveCount(20);
 await expect(page.locator('.fg-match-pages')).toContainText('共 350 项');await page.locator('#fg-next-page').click();await expect(page.locator('[data-fg-item="item-21"]')).toBeChecked();
 await page.locator('#fg-filter').fill('核查 350');await page.locator('#fg-filter').press('Tab');await expect(page.locator('[data-fg-item]')).toHaveCount(1);
 await page.locator('[data-fg-item="item-350"]').uncheck();await page.locator('#fg-filter').fill('');await page.locator('#fg-filter').press('Tab');
 await page.locator('#fg-supporting-details > summary').click();await page.locator('#fg-requirements').fill('访谈只准备提纲，缺原件处如实说明');await page.locator('#fg-requirements').press('Tab');
 await expect(page.locator('.fg-footer')).toContainText((349*WORKPAPER_PRICE.points).toLocaleString());
 const expectedIds=state.data.catalogues[0].entries.slice(0,349).map(e=>e.id);
 await expect.poll(()=>state.generation.data.preparation.item_ids).toEqual(expectedIds);
 await page.screenshot({path:await screenshotPath(`preparation-${width}.png`),fullPage:true});
 await page.locator('#fg-confirm').click();await expect(page.getByRole('dialog')).toContainText('349 份文件');await expect(page.getByRole('dialog')).toContainText('说明文件沿用不收费规则');
 await expect(page.getByRole('dialog')).toContainText('本次未纳入 1 项');await expect(page.getByRole('dialog')).toContainText('财务与业务核查 350');
 await page.locator('#fg-submit').click();await expect(page.locator('.fg-status')).toContainText('本批文件已提交');
 expect(state.generation.submissions).toHaveLength(1);const submitted=state.generation.submissions[0];
 expect(submitted.request).toMatchObject({expected_revision:state.generation.data.revision,expected_points:349*WORKPAPER_PRICE.points,source_version_id:'source-v3',source_selection_revision:7});
 expect(submitted.preparation).toMatchObject({catalogue_id:'catalogue-1',item_ids:expectedIds,requirements:'访谈只准备提纲，缺原件处如实说明',workpaper_template_mode:'automatic'});
 expect(submitted.source.asset).toEqual(state.source.asset);expect(state.generation.quotes).toHaveLength(1);
 expect(state.requests).toHaveLength(0);expect(state.assessmentRequests).toHaveLength(0);expect(state.resumeRequests).toHaveLength(0);
 await page.getByRole('link',{name:'底稿进度与下载',exact:true}).click();await expect(page.locator('#wp-batches')).toContainText('0 / 349 份完成');
 await expect(page.locator('#wp-start')).toBeHidden();await page.reload();await expect(page.locator('#wp-batches')).toContainText('0 / 349 份完成');expect(state.generation.submissions).toHaveLength(1);
 await page.screenshot({path:await screenshotPath(`progress-${width}.png`),fullPage:true});
 await expect(page.locator('[data-flow-step="4"]')).toHaveAttribute('aria-current','step');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test('uncertain direct submit survives reload and source changes using the exact saved request',async({page})=>{
 const state=await existingBatch(page,3),cat=state.data.catalogues[0];
 const pending:WorkpaperStart={request_id:'historical-direct',start_mode:'direct',catalogue_id:cat.catalogue_id,catalogue_sha256:cat.sha256,item_ids:cat.entries.map(e=>e.id),source_version_id:state.source.version_id,source_selection_revision:state.source.selection_revision,requirements:'原已确认范围',price_version:WORKPAPER_PRICE.version,expected_points:3*WORKPAPER_PRICE.points};
 state.data.batches[0].state='queued';state.data.batches[0].total_points=pending.expected_points;
 await seedLegacy(page,{catalogue:cat.catalogue_id,selected:pending.item_ids,requirements:pending.requirements,pending});
 state.uncertain=true;await page.goto('/'+href({step:'prepare'}));await expect(page).toHaveURL(/step=workpapers/);expect(state.requests).toEqual([]);
 await submitSelection(page);
 await expect(page.locator('#wp-start')).toBeEnabled();await expect(page.locator('#wp-start')).toHaveText('继续确认上次提交');state.source.version_id='source-new';state.source.selection_revision++;
 await page.reload();await expect(page.locator('#wp-start')).toHaveText('继续确认上次提交');await expect(page.locator('[data-wp-item]').first()).toBeDisabled();
 expect(state.requests).toEqual([pending]);await submitSelection(page);await expect(page.locator('#wp-batches')).toContainText('0 / 3 份完成');expect(state.requests).toEqual([pending,pending]);expect(state.data.batches).toHaveLength(1);expect(state.assessmentRequests).toHaveLength(0);
});
for(const oldState of ['paused','running','succeeded'])test(`legacy ${oldState} preflight never gates direct submission`,async({page})=>{
 const state=await setupPreparation(page,4),cat=state.data.catalogues[0];
 const request:WorkpaperAssess={request_id:'old-check',catalogue_id:cat.catalogue_id,catalogue_sha256:cat.sha256,item_ids:cat.entries.map(e=>e.id),source_version_id:state.source.version_id,source_selection_revision:state.source.selection_revision,requirements:''};
 state.data.assessments.push({assessment_id:'old-assessment',state:oldState,source:state.source,request,created_at:now,result_hash:oldState==='succeeded'?sha:null,decisions:[],warnings:[],completed_items:0,pause:{stage:'provider_reconcile',reason:'provider_result_pending',error_code:'MODEL_RESULT_STORE_FAILED'}});
 await seedLegacy(page,{catalogue:cat.catalogue_id,selected:request.item_ids,requirements:'',assessing:request});
 await openPreparation(page);await page.reload();await assertNoPreflight(page);await expect(page.locator('#fg-confirm')).toBeEnabled();await submitPreparation(page);
 expect(state.generation.submissions).toHaveLength(1);expect(state.generation.submissions[0].preparation.item_ids).toEqual(request.item_ids);
 expect(state.data.batches[0].start_mode).toBe('direct');expect(state.requests).toHaveLength(0);expect(state.assessmentRequests).toHaveLength(0);expect(state.resumeRequests).toHaveLength(0);
});

test('a previously confirmed legacy request is replayed without changing its price or identity',async({page})=>{
 const state=await existingBatch(page,3);
 const cat=state.data.catalogues[0],pending:WorkpaperStart={request_id:'legacy-paid',assessment_id:'old-assessment',assessment_hash:sha,catalogue_id:cat.catalogue_id,catalogue_sha256:cat.sha256,item_ids:cat.entries.map(e=>e.id),source_version_id:state.source.version_id,source_selection_revision:state.source.selection_revision,requirements:'已确认旧批次',price_version:WORKPAPER_PRICE.version,expected_points:WORKPAPER_PRICE.points};
 state.data.batches[0].start_mode='assessed';state.data.batches[0].total_points=pending.expected_points;
 await seedLegacy(page,{catalogue:cat.catalogue_id,selected:pending.item_ids,requirements:pending.requirements,pending});
 state.source.version_id='source-new';state.source.selection_revision++;
 await page.goto('/'+href({step:'prepare'}));await expect(page).toHaveURL(/step=workpapers/);await expect(page.locator('#wp-start')).toHaveText('继续确认上次提交');
 expect(state.requests).toEqual([]);await page.reload();expect(state.requests).toEqual([]);await submitSelection(page);expect(state.requests).toEqual([pending]);expect(state.data.batches).toHaveLength(1);expect(state.assessmentRequests).toHaveLength(0);
});

test('delivered explanations are visible and batch pause/resume do not submit another batch',async({page})=>{
 const state=await existingBatch(page,3);await page.clock.install();await page.goto('/'+href({step:'workpapers',view:'results',batch:'batch-1'}));
 await page.getByRole('button',{name:'当前文件后暂停'}).click();await expect(page.getByRole('button',{name:'继续文件包'})).toBeVisible();await page.getByRole('button',{name:'继续文件包'}).click();
 await expect(page.getByRole('button',{name:'当前文件后暂停'})).toBeVisible();
 const b=state.data.batches[0];b.state='complete';b.items.forEach(i=>{i.state='succeeded';i.explanation={filename:i.entry.title+'-不适用说明.docx',sha256:sha};});
 await page.clock.fastForward(5100);await expect(page.getByRole('button',{name:'下载不适用说明'})).toHaveCount(3);
 await expect(page.locator('#wp-batches')).toContainText('0 积分');expect(state.requests).toHaveLength(0);expect(state.assessmentRequests).toHaveLength(0);expect(state.data.batches).toHaveLength(1);
});

test('empty selection explains why submit is disabled and never sends requests',async({page})=>{
 const state=await setupPreparation(page,4);await openPreparation(page);await page.locator('#fg-edit-scope').click();await page.locator('#fg-select-none').click();
 await expect(page.locator('#fg-confirm')).toBeDisabled();await expect(page.locator('.fg-footer')).toContainText('本批 0 份文件');
 await expect.soft(page.locator('.fg-preparation')).toContainText(/请.*(?:选择|勾选).*(?:文件|底稿)/);
 expect(state.generation.quotes).toEqual([]);expect(state.generation.submissions).toEqual([]);expect(state.requests).toEqual([]);expect(state.assessmentRequests).toEqual([]);
});

test('result action failures remain visible on the separate results step',async({page})=>{
 const state=await existingBatch(page,3);await page.goto('/'+href({step:'workpapers',view:'results',batch:'batch-1'}));
 await page.route('**/workpapers/batches/*/actions',route=>route.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}}));
 await page.getByRole('button',{name:'当前文件后暂停'}).click();await expect(page.locator('#wp-results-status')).toBeVisible();await expect(page.locator('#wp-results-status')).not.toHaveText('底稿文件包已提交，关闭页面后仍会继续。');await expect(page.locator('#wp-results-status')).not.toBeEmpty();expect(state.requests).toHaveLength(0);expect(state.data.batches).toHaveLength(1);
});

test('affected files can be directly recompiled from a batch older than the recent ten',async({page})=>{
 const state=await setup(page,3),catalogue={...state.data.catalogues[0],catalogue_id:'old-catalogue',filename:'历史底稿目录.xlsx'};
 await page.route('**/api/v1/projects/*/workpapers/batches/old-batch',r=>r.fulfill({json:{batch_id:'old-batch',catalogue_id:catalogue.catalogue_id}}));
 await page.route('**/api/v1/projects/*/workpapers/catalogues/old-catalogue',r=>r.fulfill({json:catalogue}));
 await page.route('**/api/v1/projects/*/workpapers/checks',r=>r.fulfill({json:{checks:[{batch_id:'old-batch',stale:false,result:{items:[{item_id:catalogue.entries[1].id,status:'needs_update'},{item_id:catalogue.entries[2].id,status:'current'}]}}]}}));
 await page.goto('/'+href({step:'workpapers'})+'&workpaper_batch=old-batch');await expect(page.locator('#wp-catalogue')).toHaveValue('old-catalogue');await expect(page.locator('[data-wp-item]:checked')).toHaveCount(1);
 await expect(page.locator('#wp-status')).toContainText('直接重新编制');await submitSelection(page);expect(state.requests[0].catalogue_id).toBe('old-catalogue');expect(state.assessmentRequests).toHaveLength(0);
});

for(const width of [1440,390])test(`direct generation prototype ${width}`,async({page})=>{
 await page.setViewportSize({width,height:960});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const file=resolve(process.cwd(),'../../product-prototype/public/workpaper-batch.html').replaceAll('\\','/');await page.goto('/@fs/'+file);await assertNoPreflight(page);
 await page.locator('#wp-filter').fill('核查 350');await page.locator('#entries input').uncheck();await page.locator('#wp-filter').fill('');await page.locator('#wp-requirements').fill('访谈只准备提纲，缺原件处如实说明');await page.locator('#wp-requirements').press('Tab');
 await page.screenshot({path:await screenshotPath(`prototype-preparation-${width}.png`),fullPage:true});await page.locator('#wp-confirm').screenshot({path:await screenshotPath(`prototype-preparation-card-${width}.png`)});
 await page.locator('#wp-start').click();await expect(page.locator('#wp-batches')).toContainText('3 / 349 份完成');await page.screenshot({path:await screenshotPath(`prototype-progress-${width}.png`),fullPage:true});expect(errors).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});


test('automatic workpaper tariff starts the chosen batch on one click with the server unit price',async({page})=>{
 const state=await setupPreparation(page,3,true);await openPreparation(page);
 await expect(page.locator('.fg-footer')).toContainText('10,374');await expect(page.locator('#fg-confirm')).toHaveText('生成本批文件');
 await submitPreparation(page,true);expect(state.generation.submissions).toHaveLength(1);expect(state.generation.quotes).toHaveLength(1);
 expect(state.generation.submissions[0].request).toMatchObject({price_version:AUTOMATIC_PRICE_VERSION,expected_points:10374});await expect(page.getByRole('dialog')).toHaveCount(0);expect(state.requests).toEqual([]);
});

test('unified workpaper submission keeps its quoted scope and request when the reply is lost and the source changes',async({page})=>{
 const state=await setupPreparation(page,3,true);await openPreparation(page);state.generation.lost=true;
 await page.locator('#fg-confirm').click();await expect(page.locator('#fg-resolve')).toBeVisible();
 expect(state.generation.submissions).toHaveLength(1);const original=structuredClone(state.generation.submissions[0]);
 state.source.version_id='source-new';state.source.selection_revision++;
 await page.reload();await expect(page.locator('#fg-resolve')).toBeVisible();expect(state.generation.submissions).toHaveLength(1);
 await expect(page.locator('#fg-controls')).toHaveAttribute('inert','');await page.locator('#fg-resolve').click();await expect(page.locator('.fg-status')).toContainText('本批文件已提交');
 expect(state.generation.quotes).toHaveLength(1);expect(state.generation.submissions).toEqual([original,original]);
 expect(state.data.batches).toHaveLength(1);expect(state.data.batches[0].source.version_id).toBe('source-v3');expect(state.requests).toHaveLength(0);expect(state.assessmentRequests).toHaveLength(0);
});
