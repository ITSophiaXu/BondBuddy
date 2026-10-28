import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {WORKPAPER_PRICE,type WorkpaperWorkspace,type WorkpaperStart,type WorkpaperBatch,type WorkpaperAssess} from '@bondbuddy/contracts';
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
 await expect(page.locator('.wp-workflow')).toContainText('选择底稿');await expect(page.locator('.wp-workflow')).toContainText('批量生成');await expect(page.locator('.wp-workflow')).toContainText('下载文件');
};

test('first visit with no catalogue presents the upload control',async({page})=>{
  const state=await setup(page);state.data.catalogues=[];
  await page.goto('/'+href({step:'choose'}));
  await page.getByRole('link',{name:'批量生成底稿',exact:true}).click();
  await expect(page).toHaveURL(new RegExp(`project=${ids.api}&step=workpapers`));
  await expect(page.getByRole('heading',{name:'上传底稿目录',exact:true})).toBeVisible();
  await expect(page.locator('#wp-upload')).toBeEnabled();
  await expect(page.getByText('底稿记录暂时无法读取。原记录已保留，请刷新重试。')).toHaveCount(0);
  await page.reload();await expect(page.locator('#wp-upload')).toBeEnabled();
  await expect(page.locator('#wp-start')).toHaveCount(0);
});
for(const width of [1440,390])test(`one click directly submits the selected 349 files and shows progress ${width}`,async({page})=>{
 const state=await setup(page);await page.setViewportSize({width,height:960});await page.goto('/'+href({step:'workpapers'}));await assertNoPreflight(page);
 await expect(page.locator('[data-wp-item]')).toHaveCount(350);await expect(page.locator('#wp-start')).toBeEnabled();
 await page.locator('#wp-filter').fill('核查 350');await page.locator('[data-wp-item]').uncheck();await page.locator('#wp-filter').fill('');
 await page.locator('#wp-requirements').fill('访谈只准备提纲，缺原件处如实说明');await page.locator('#wp-requirements').press('Tab');
 await expect(page.locator('#wp-confirm')).toContainText((349*WORKPAPER_PRICE.points).toLocaleString());
 await expect(page.locator('#wp-fee-note')).toContainText('仅形成说明的条目不收取生成积分');
 await mkdir('test-evidence/workpaper-direct',{recursive:true});await page.evaluate(()=>window.scrollTo(0,0));await expect.poll(()=>page.evaluate(()=>scrollY)).toBe(0);
 await page.screenshot({path:`test-evidence/workpaper-direct/preparation-${width}.png`,fullPage:true});
 await page.locator('#wp-confirm').screenshot({path:`test-evidence/workpaper-direct/preparation-card-${width}.png`});
 await page.locator('#wp-start').click();await expect(page.locator('#wp-batches')).toContainText('0 / 349 份完成');
 expect(state.requests).toHaveLength(1);expect(state.requests[0]).toMatchObject({start_mode:'direct',expected_points:349*WORKPAPER_PRICE.points,source_version_id:'source-v3',requirements:'访谈只准备提纲，缺原件处如实说明'});
 expect(state.requests[0].assessment_id).toBeUndefined();expect(state.assessmentRequests).toHaveLength(0);await expect(page.locator('#wp-start')).toBeDisabled();
 await page.reload();await expect(page.locator('#wp-batches')).toContainText('0 / 349 份完成');expect(state.requests).toHaveLength(1);
 await page.screenshot({path:`test-evidence/workpaper-direct/progress-${width}.png`,fullPage:true});
 const url=page.url();await page.getByRole('link',{name:'查看生成进度',exact:true}).click();await expect(page).toHaveURL(url);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test('uncertain direct submit survives reload and source changes using the exact saved request',async({page})=>{
 const state=await setup(page,3);state.uncertain=true;await page.goto('/'+href({step:'workpapers'}));await page.locator('#wp-start').click();
 await expect(page.locator('#wp-start')).toHaveText('继续确认上次提交');state.source.version_id='source-new';state.source.selection_revision++;
 await page.reload();await expect(page.locator('#wp-start')).toHaveText('继续确认上次提交');await expect(page.locator('[data-wp-item]').first()).toBeDisabled();
 await page.locator('#wp-start').click();await expect(page.locator('#wp-batches')).toContainText('0 / 3 份完成');expect(state.requests).toHaveLength(2);expect(state.requests[1]).toEqual(state.requests[0]);expect(state.assessmentRequests).toHaveLength(0);
});
for(const oldState of ['paused','running','succeeded'])test(`legacy ${oldState} preflight never gates direct submission`,async({page})=>{
 const state=await setup(page,4),cat=state.data.catalogues[0];
 const request:WorkpaperAssess={request_id:'old-check',catalogue_id:cat.catalogue_id,catalogue_sha256:cat.sha256,item_ids:cat.entries.map(e=>e.id),source_version_id:state.source.version_id,source_selection_revision:state.source.selection_revision,requirements:''};
 state.data.assessments.push({assessment_id:'old-assessment',state:oldState,source:state.source,request,created_at:now,result_hash:oldState==='succeeded'?sha:null,decisions:[],warnings:[],completed_items:0,pause:{stage:'provider_reconcile',reason:'provider_result_pending',error_code:'MODEL_RESULT_STORE_FAILED'}});
 await page.goto('/'+href({step:'workpapers'}));await page.locator('#wp-requirements').fill('临时');await page.locator('#wp-requirements').fill('');
 await page.evaluate(request=>{const key=Object.keys(localStorage).find(k=>k.startsWith('bb-workpapers-v1:'))!,saved=JSON.parse(localStorage.getItem(key)!);saved.assessing=request;localStorage.setItem(key,JSON.stringify(saved));},request);
 await page.reload();await assertNoPreflight(page);await expect(page.locator('#wp-start')).toBeEnabled();await page.locator('#wp-start').click();
 expect(state.requests).toHaveLength(1);expect(state.requests[0].start_mode).toBe('direct');expect(state.assessmentRequests).toHaveLength(0);expect(state.resumeRequests).toHaveLength(0);
});

test('a previously confirmed legacy request is replayed without changing its price or identity',async({page})=>{
 const state=await setup(page,3);await page.goto('/'+href({step:'workpapers'}));await page.locator('#wp-requirements').fill('已确认旧批次');
 const cat=state.data.catalogues[0],pending:WorkpaperStart={request_id:'legacy-paid',assessment_id:'old-assessment',assessment_hash:sha,catalogue_id:cat.catalogue_id,catalogue_sha256:cat.sha256,item_ids:cat.entries.map(e=>e.id),source_version_id:state.source.version_id,source_selection_revision:state.source.selection_revision,requirements:'已确认旧批次',price_version:WORKPAPER_PRICE.version,expected_points:WORKPAPER_PRICE.points};
 await page.evaluate(pending=>{const key=Object.keys(localStorage).find(k=>k.startsWith('bb-workpapers-v1:'))!,saved=JSON.parse(localStorage.getItem(key)!);saved.pending=pending;localStorage.setItem(key,JSON.stringify(saved));},pending);
 await page.reload();await expect(page.locator('#wp-start')).toHaveText('继续确认上次提交');await page.locator('#wp-start').click();expect(state.requests).toEqual([pending]);
});

test('delivered explanations are visible and batch pause/resume do not submit another batch',async({page})=>{
 const state=await setup(page,3);await page.clock.install();await page.goto('/'+href({step:'workpapers'}));await page.locator('#wp-start').click();
 await page.getByRole('button',{name:'当前文件后暂停'}).click();await expect(page.getByRole('button',{name:'继续文件包'})).toBeVisible();await page.getByRole('button',{name:'继续文件包'}).click();
 await expect(page.getByRole('button',{name:'当前文件后暂停'})).toBeVisible();
 const b=state.data.batches[0];b.state='complete';b.items.forEach(i=>{i.state='succeeded';i.explanation={filename:i.entry.title+'-不适用说明.docx',sha256:sha};});
 await page.clock.fastForward(5100);await page.getByText('查看逐份状态与下载').click();await expect(page.getByRole('button',{name:'下载不适用说明'})).toHaveCount(3);
 await expect(page.locator('#wp-batches')).toContainText('0 积分');expect(state.requests).toHaveLength(1);expect(state.assessmentRequests).toHaveLength(0);
});

test('empty selection explains why submit is disabled and never sends requests',async({page})=>{
 const state=await setup(page,4);await page.goto('/'+href({step:'workpapers'}));await page.locator('#wp-none').click();await expect(page.locator('#wp-start')).toBeDisabled();await expect(page.locator('#wp-action-hint')).toContainText('请先在目录中勾选');expect(state.requests).toHaveLength(0);expect(state.assessmentRequests).toHaveLength(0);
});

test('affected files can be directly recompiled from a batch older than the recent ten',async({page})=>{
 const state=await setup(page,3),catalogue={...state.data.catalogues[0],catalogue_id:'old-catalogue',filename:'历史底稿目录.xlsx'};
 await page.route('**/api/v1/projects/*/workpapers/batches/old-batch',r=>r.fulfill({json:{batch_id:'old-batch',catalogue_id:catalogue.catalogue_id}}));
 await page.route('**/api/v1/projects/*/workpapers/catalogues/old-catalogue',r=>r.fulfill({json:catalogue}));
 await page.route('**/api/v1/projects/*/workpapers/checks',r=>r.fulfill({json:{checks:[{batch_id:'old-batch',stale:false,result:{items:[{item_id:catalogue.entries[1].id,status:'needs_update'},{item_id:catalogue.entries[2].id,status:'current'}]}}]}}));
 await page.goto('/'+href({step:'workpapers'})+'&workpaper_batch=old-batch');await expect(page.locator('#wp-catalogue')).toHaveValue('old-catalogue');await expect(page.locator('[data-wp-item]:checked')).toHaveCount(1);
 await expect(page.locator('#wp-status')).toContainText('直接重新编制');await page.locator('#wp-start').click();expect(state.requests[0].catalogue_id).toBe('old-catalogue');expect(state.assessmentRequests).toHaveLength(0);
});

for(const width of [1440,390])test(`direct generation prototype ${width}`,async({page})=>{
 await page.setViewportSize({width,height:960});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const file=resolve(process.cwd(),'../../product-prototype/public/workpaper-batch.html').replaceAll('\\','/');await page.goto('/@fs/'+file);await assertNoPreflight(page);
 await page.locator('#wp-filter').fill('核查 350');await page.locator('#entries input').uncheck();await page.locator('#wp-filter').fill('');await page.locator('#wp-requirements').fill('访谈只准备提纲，缺原件处如实说明');await page.locator('#wp-requirements').press('Tab');
 await mkdir('test-evidence/workpaper-direct',{recursive:true});await page.screenshot({path:`test-evidence/workpaper-direct/prototype-preparation-${width}.png`,fullPage:true});await page.locator('#wp-confirm').screenshot({path:`test-evidence/workpaper-direct/prototype-preparation-card-${width}.png`});
 await page.locator('#wp-start').click();await expect(page.locator('#wp-batches')).toContainText('3 / 349 份完成');await page.screenshot({path:`test-evidence/workpaper-direct/prototype-progress-${width}.png`,fullPage:true});expect(errors).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
