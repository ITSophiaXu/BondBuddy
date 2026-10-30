import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {AUTOMATIC_PRICE_VERSION,AUTOMATIC_TASK_TARIFF,SUBSCRIPTION_PLANS,SUBSCRIPTION_CATALOG_VERSION,WORKPAPER_PRICE,type WorkpaperWorkspace,type WorkpaperStart,type WorkpaperBatch,type WorkpaperAssess} from '@bondbuddy/contracts';
import {fixture,href,ids,now,sha} from './generation-entry-fixtures';

async function setup(page:import('@playwright/test').Page,count=350){
 const existing=await fixture(page),source=existing.workspaces.get(ids.api)!.source!;
 const data:WorkpaperWorkspace={catalogues:[{catalogue_id:'catalogue-1',filename:'合成底稿目录.xlsx',sha256:sha,created_at:now,warnings:[],entries:Array.from({length:count},(_,i)=>({id:`item-${i+1}`,code:`1.${i+1}`,title:`财务与业务核查 ${i+1}`,folder:'1 尽职调查',kind:'file' as const,path:`1 尽职调查/1.${i+1} 财务与业务核查 ${i+1}.docx`,row:i+2,sheet:'目录',instructions:''}))}],batches:[],assessments:[]};
 const state={data,source,requests:[] as WorkpaperStart[],assessmentRequests:[] as WorkpaperAssess[],resumeRequests:[] as string[],uncertain:false};
 await page.route('**/api/v1/runs/*/resume',async route=>{state.resumeRequests.push(route.request().url());await route.fulfill({status:409,json:{code:'CAPABILITY_NOT_READY'}});});
 await page.route('**/api/v1/projects/*/workpapers**',async route=>{
  const request=route.request(),url=new URL(request.url()),base=`/api/v1/projects/${ids.api}/workpapers`;
  if(url.pathname===base&&request.method()==='GET')return route.fulfill({json:data});
  if(url.pathname===base+'/assessments'){state.assessmentRequests.push(request.postDataJSON());return route.fulfill({status:500,json:{code:'UNEXPECTED_PREFLIGHT'}});}
  if(url.pathname===base+'/batches'){
   const body=request.postDataJSON() as WorkpaperStart;state.requests.push(body);
   if(!data.batches.length){const b:WorkpaperBatch={batch_id:'batch-1',topic_id:'topic-workpapers',catalogue_id:body.catalogue_id,revision:1,state:'queued',start_mode:body.start_mode??'assessed',source:structuredClone(source),total_points:body.expected_points,charged_points:0,created_at:now,error:null,
    items:data.catalogues[0].entries.filter(e=>body.item_ids.includes(e.id)).map(entry=>({entry,run_id:null,state:'queued',stage:null,attempt:1,error:null,artifacts:[]}))};data.batches.push(b);}
   if(state.uncertain){state.uncertain=false;return route.abort('failed');}return route.fulfill({json:data.batches[0]});
  }
  if(url.pathname.endsWith('/actions')){const b=data.batches[0],action=request.postDataJSON().action;b.state=action==='pause'?'paused':action==='cancel'?'cancelled':'queued';b.revision++;return route.fulfill({json:b});}
  return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
 });return state;
}
const assertNoPreflight=async(page:import('@playwright/test').Page)=>{
 await expect(page.locator('#wp-reviewed')).toHaveCount(0);await expect(page.locator('#wp-assess')).toHaveCount(0);await expect(page.locator('.wp-check-status')).toHaveCount(0);
 if(page.url().includes('workpaper-batch.html'))await expect(page.locator('.wp-workflow')).toContainText('选择底稿');
 else {await expect(page.locator('.pf-flow-steps')).toContainText('选择募集说明书');await expect(page.locator('.pf-flow-steps')).toContainText('选择生成内容');await expect(page.locator('.pf-flow-steps')).toContainText('确认并生成');}
};
async function submitSelection(page:import('@playwright/test').Page){await page.locator('#wp-start').click();if(await page.locator('#wp-confirm-start').isVisible()){await expect(page.locator('[data-flow-step="3"]')).toHaveAttribute('aria-current','step');await page.locator('#wp-confirm-start').click();}}

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
  if(path===`/projects/${ids.api}/workpapers/batches/short-batch/actions`){const body=route.request().postDataJSON();actions.push(body);if(!funded)return route.fulfill({status:402,json:{code:'CREDITS_INSUFFICIENT'}});batch.state='queued';batch.revision++;batch.billing_resume=undefined;return route.fulfill({json:batch});}
  if(path==='/subscriptions/catalog')return route.fulfill({json:{enabled:true,version:SUBSCRIPTION_CATALOG_VERSION,plans:SUBSCRIPTION_PLANS,providers:['wechat'],auto_renew_available:false}});
  if(path==='/subscriptions/account')return route.fulfill({json:{subscription:null,available_points:funded?points:0,held_points:0,subscription_available_points:0,topup_available_points:funded?points:0,other_available_points:0,periods:[]}});
  if(path==='/commerce/catalog')return route.fulfill({json:{enabled:true,version:AUTOMATIC_PRICE_VERSION,currency:'CNY',model:'subscription_and_topup',items:[],rules:[]}});
  if(path==='/commerce/quotations')return route.fulfill({json:{items:[]}});
  if(path==='/credits/consumption-history'||path==='/credits/recharge-history')return route.fulfill({json:{items:[],page:{has_more:false,next_cursor:null}}});
  if(path==='/commerce/topups'&&route.request().method()==='POST'){payments.push(route.request().postDataJSON());return route.fulfill({status:201,json:order()});}
  if(path==='/commerce/topups/recovery-topup/refresh')throw new Error('Automatic recovery must not need the refresh-payment button');
  if(path==='/commerce/topups/recovery-topup')return route.fulfill({json:order()});
  await route.fallback();
 });
 await page.goto('/'+href({step:'workpapers',view:'results',batch:batch.batch_id}));
 await expect(page.locator('[data-wp-batch-id="manually-paused"]')).not.toContainText('补足积分');expect(actions).toEqual([]);
 if(process.env.BB_UX_EVIDENCE_DIR){await mkdir(process.env.BB_UX_EVIDENCE_DIR,{recursive:true});await page.evaluate(()=>window.scrollTo(0,0));await expect.poll(()=>page.evaluate(()=>scrollY)).toBe(0);await page.screenshot({path:resolve(process.env.BB_UX_EVIDENCE_DIR,'workpaper-shortage-1440.png'),fullPage:true});}
 await page.locator('[data-wp-batch-id="short-batch"]').getByRole('button',{name:'补足积分并继续本批'}).click();
 await expect(page.locator('#billing-task-notice')).toContainText('已完成文件保留');expect(actions).toHaveLength(1);expect(payments).toEqual([]);
 await page.locator('#billing-task-notice').getByRole('link',{name:'订阅或充值，继续原任务'}).click();
 await expect(page.locator('#subscription-topup-amount')).toHaveValue((points/100).toFixed(2));
 await page.getByRole('button',{name:'充值并前往支付'}).click();await expect(page.getByRole('button',{name:'刷新支付状态'})).toBeVisible();
 expect(actions).toHaveLength(1);funded=true;await page.evaluate(()=>window.dispatchEvent(new Event('bondbuddy:credits-changed')));
 await expect.poll(()=>actions.length).toBe(2);expect(actions[1]).toEqual(actions[0]);expect(payments).toHaveLength(1);expect(payments[0].amount_fen).toBe(points);
 await expect(page).toHaveURL(/view=results&batch=short-batch/);expect(manual.state).toBe('paused');
 await page.reload();await expect(page.locator('[data-wp-batch-id="short-batch"]')).toContainText('等待生成');expect(actions).toHaveLength(2);
});

for(const width of [1440,390,320])test(`saved directory stays compact and confirmation preserves selected scope ${width}`,async({page})=>{
 const state=await setup(page,3);await page.setViewportSize({width,height:960});await page.goto('/'+href({step:'workpapers'}));
 await expect(page.locator('.wp-directory-current')).toContainText('合成底稿目录.xlsx');await expect(page.locator('.wp-upload-zone')).toHaveCount(0);await expect(page.locator('#wp-upload')).toBeHidden();
 await page.locator('#wp-change-directory').click();await expect(page.locator('#wp-upload')).toBeVisible();await page.locator('#wp-change-directory').click();
 await page.locator('[data-wp-item]').first().uncheck();await expect(page.locator('.wp-file-group>summary small')).toHaveText('2 / 3');expect(await page.locator('[data-wp-group]').evaluate((el:HTMLInputElement)=>el.indeterminate)).toBe(true);
 const dir='test-evidence/generation-ux-flow-20261028';await mkdir(dir,{recursive:true});await page.evaluate(()=>window.scrollTo(0,0));await expect.poll(()=>page.evaluate(()=>scrollY)).toBe(0);await page.screenshot({path:`${dir}/directory-${width}.png`,fullPage:true});await page.screenshot({path:`${dir}/directory-${width}-viewport.png`});
 await page.locator('#wp-start').click();expect(state.requests).toHaveLength(0);await expect(page.locator('#wp-confirmation-page')).toContainText('2 份文件');await expect(page.locator('#wp-confirmation-page')).toContainText('9,000');
 await page.locator('#wp-confirm-back').click();await expect(page.locator('[data-wp-item]:checked')).toHaveCount(2);await page.locator('#wp-start').click();
 await page.evaluate(()=>window.scrollTo(0,0));await expect.poll(()=>page.evaluate(()=>scrollY)).toBe(0);await page.screenshot({path:`${dir}/directory-confirm-${width}.png`,fullPage:true});
 await page.locator('#wp-confirm-start').click();expect(state.requests).toHaveLength(1);expect(state.requests[0].item_ids).toHaveLength(2);await expect(page.locator('.wp-prepare')).toBeHidden();await expect(page.locator('[data-flow-step="4"]')).toHaveAttribute('aria-current','step');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.reload();await expect(page.locator('#wp-batches')).toBeVisible();expect(state.requests).toHaveLength(1);
});

test('first visit with no catalogue presents the upload control',async({page})=>{
  const state=await setup(page);state.data.catalogues=[];
  await page.goto('/'+href({step:'workpapers'}));
  await expect(page).toHaveURL(new RegExp(`project=${ids.api}&step=workpapers`));
  await expect(page.getByRole('heading',{name:'添加底稿目录',exact:true})).toBeVisible();
  await expect(page.locator('#wp-upload')).toBeEnabled();
  await expect(page.getByText('底稿记录暂时无法读取。原记录已保留，请刷新重试。')).toHaveCount(0);
  await page.reload();await expect(page.locator('#wp-upload')).toBeEnabled();
  await expect(page.locator('#wp-start')).toHaveCount(0);
});
for(const width of [1440,390])test(`confirmation submits selected 349 files and shows progress ${width}`,async({page})=>{
 const state=await setup(page);await page.setViewportSize({width,height:960});await page.goto('/'+href({step:'workpapers'}));await assertNoPreflight(page);
 await expect(page.locator('[data-wp-item]')).toHaveCount(350);await expect(page.locator('#wp-start')).toBeEnabled();
 await page.locator('#wp-filter').fill('核查 350');await page.locator('[data-wp-item]').uncheck();await page.locator('#wp-filter').fill('');
 await page.locator('#wp-requirements').fill('访谈只准备提纲，缺原件处如实说明');await page.locator('#wp-requirements').press('Tab');
 await expect(page.locator('#wp-confirm')).toContainText((349*WORKPAPER_PRICE.points).toLocaleString());
 await expect(page.locator('#wp-fee-note')).toContainText('仅形成说明的条目不收取生成积分');
 await mkdir('test-evidence/workpaper-direct',{recursive:true});await page.evaluate(()=>window.scrollTo(0,0));await expect.poll(()=>page.evaluate(()=>scrollY)).toBe(0);
 await page.screenshot({path:`test-evidence/workpaper-direct/preparation-${width}.png`,fullPage:true});
 await page.locator('#wp-confirm').screenshot({path:`test-evidence/workpaper-direct/preparation-card-${width}.png`});
 await submitSelection(page);await expect(page.locator('#wp-batches')).toContainText('0 / 349 份完成');
 expect(state.requests).toHaveLength(1);expect(state.requests[0]).toMatchObject({start_mode:'direct',expected_points:349*WORKPAPER_PRICE.points,source_version_id:'source-v3',requirements:'访谈只准备提纲，缺原件处如实说明'});
 expect(state.requests[0].assessment_id).toBeUndefined();expect(state.assessmentRequests).toHaveLength(0);await expect(page.locator('#wp-start')).toBeDisabled();
 await page.reload();await expect(page.locator('#wp-batches')).toContainText('0 / 349 份完成');expect(state.requests).toHaveLength(1);
 await page.screenshot({path:`test-evidence/workpaper-direct/progress-${width}.png`,fullPage:true});
 await expect(page.locator('[data-flow-step="4"]')).toHaveAttribute('aria-current','step');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test('uncertain direct submit survives reload and source changes using the exact saved request',async({page})=>{
 const state=await setup(page,3);state.uncertain=true;await page.goto('/'+href({step:'workpapers'}));await submitSelection(page);
 await expect(page.locator('#wp-confirm-start')).toHaveText('继续确认上次提交');state.source.version_id='source-new';state.source.selection_revision++;
 await page.reload();await expect(page.locator('#wp-start')).toHaveText('继续确认上次提交');await expect(page.locator('[data-wp-item]').first()).toBeDisabled();
 await submitSelection(page);await expect(page.locator('#wp-batches')).toContainText('0 / 3 份完成');expect(state.requests).toHaveLength(2);expect(state.requests[1]).toEqual(state.requests[0]);expect(state.assessmentRequests).toHaveLength(0);
});
for(const oldState of ['paused','running','succeeded'])test(`legacy ${oldState} preflight never gates direct submission`,async({page})=>{
 const state=await setup(page,4),cat=state.data.catalogues[0];
 const request:WorkpaperAssess={request_id:'old-check',catalogue_id:cat.catalogue_id,catalogue_sha256:cat.sha256,item_ids:cat.entries.map(e=>e.id),source_version_id:state.source.version_id,source_selection_revision:state.source.selection_revision,requirements:''};
 state.data.assessments.push({assessment_id:'old-assessment',state:oldState,source:state.source,request,created_at:now,result_hash:oldState==='succeeded'?sha:null,decisions:[],warnings:[],completed_items:0,pause:{stage:'provider_reconcile',reason:'provider_result_pending',error_code:'MODEL_RESULT_STORE_FAILED'}});
 await page.goto('/'+href({step:'workpapers'}));await page.locator('#wp-requirements').fill('临时');await page.locator('#wp-requirements').fill('');
 await page.evaluate(request=>{const key=Object.keys(localStorage).find(k=>k.startsWith('bb-workpapers-v1:'))!,saved=JSON.parse(localStorage.getItem(key)!);saved.assessing=request;localStorage.setItem(key,JSON.stringify(saved));},request);
 await page.reload();await assertNoPreflight(page);await expect(page.locator('#wp-start')).toBeEnabled();await submitSelection(page);
 expect(state.requests).toHaveLength(1);expect(state.requests[0].start_mode).toBe('direct');expect(state.assessmentRequests).toHaveLength(0);expect(state.resumeRequests).toHaveLength(0);
});

test('a previously confirmed legacy request is replayed without changing its price or identity',async({page})=>{
 const state=await setup(page,3);await page.goto('/'+href({step:'workpapers'}));await page.locator('#wp-requirements').fill('已确认旧批次');
 const cat=state.data.catalogues[0],pending:WorkpaperStart={request_id:'legacy-paid',assessment_id:'old-assessment',assessment_hash:sha,catalogue_id:cat.catalogue_id,catalogue_sha256:cat.sha256,item_ids:cat.entries.map(e=>e.id),source_version_id:state.source.version_id,source_selection_revision:state.source.selection_revision,requirements:'已确认旧批次',price_version:WORKPAPER_PRICE.version,expected_points:WORKPAPER_PRICE.points};
 await page.evaluate(pending=>{const key=Object.keys(localStorage).find(k=>k.startsWith('bb-workpapers-v1:'))!,saved=JSON.parse(localStorage.getItem(key)!);saved.pending=pending;localStorage.setItem(key,JSON.stringify(saved));},pending);
 await page.reload();await expect(page.locator('#wp-start')).toHaveText('继续确认上次提交');await submitSelection(page);expect(state.requests).toEqual([pending]);
});

test('delivered explanations are visible and batch pause/resume do not submit another batch',async({page})=>{
 const state=await setup(page,3);await page.clock.install();await page.goto('/'+href({step:'workpapers'}));await submitSelection(page);
 await page.getByRole('button',{name:'当前文件后暂停'}).click();await expect(page.getByRole('button',{name:'继续文件包'})).toBeVisible();await page.getByRole('button',{name:'继续文件包'}).click();
 await expect(page.getByRole('button',{name:'当前文件后暂停'})).toBeVisible();
 const b=state.data.batches[0];b.state='complete';b.items.forEach(i=>{i.state='succeeded';i.explanation={filename:i.entry.title+'-不适用说明.docx',sha256:sha};});
 await page.clock.fastForward(5100);await page.getByText('查看逐份状态与下载').click();await expect(page.getByRole('button',{name:'下载不适用说明'})).toHaveCount(3);
 await expect(page.locator('#wp-batches')).toContainText('0 积分');expect(state.requests).toHaveLength(1);expect(state.assessmentRequests).toHaveLength(0);
});

test('empty selection explains why submit is disabled and never sends requests',async({page})=>{
 const state=await setup(page,4);await page.goto('/'+href({step:'workpapers'}));await page.locator('#wp-none').click();await expect(page.locator('#wp-start')).toBeDisabled();await expect(page.locator('#wp-action-hint')).toContainText('请先在目录中勾选');expect(state.requests).toHaveLength(0);expect(state.assessmentRequests).toHaveLength(0);
});

test('result action failures remain visible on the separate results step',async({page})=>{
 const state=await setup(page,3);await page.goto('/'+href({step:'workpapers'}));await submitSelection(page);
 await page.route('**/workpapers/batches/*/actions',route=>route.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}}));
 await page.getByRole('button',{name:'当前文件后暂停'}).click();await expect(page.locator('#wp-results-status')).toBeVisible();await expect(page.locator('#wp-results-status')).not.toHaveText('底稿文件包已提交，关闭页面后仍会继续。');await expect(page.locator('#wp-results-status')).not.toBeEmpty();expect(state.requests).toHaveLength(1);
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
 await mkdir('test-evidence/workpaper-direct',{recursive:true});await page.screenshot({path:`test-evidence/workpaper-direct/prototype-preparation-${width}.png`,fullPage:true});await page.locator('#wp-confirm').screenshot({path:`test-evidence/workpaper-direct/prototype-preparation-card-${width}.png`});
 await page.locator('#wp-start').click();await expect(page.locator('#wp-batches')).toContainText('3 / 349 份完成');await page.screenshot({path:`test-evidence/workpaper-direct/prototype-progress-${width}.png`,fullPage:true});expect(errors).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});


test('automatic workpaper tariff starts the chosen batch on one click with the server unit price',async({page})=>{
 const state=await setup(page,3);state.data.price={version:AUTOMATIC_PRICE_VERSION,points:3458,auto_charge:true};
 await page.goto('/'+href({step:'workpapers'}));await expect(page.locator('.wp-fee-summary')).toContainText('10,374');await expect(page.locator('#wp-start')).toHaveText('开始生成底稿');
 await page.locator('#wp-start').click();await expect.poll(()=>state.requests.length).toBe(1);expect(state.requests[0]).toMatchObject({price_version:AUTOMATIC_PRICE_VERSION,expected_points:10374});await expect(page.locator('#wp-confirm-start')).toHaveCount(0);
});
