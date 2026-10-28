import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {WORKPAPER_PRICE,type WorkpaperWorkspace,type WorkpaperStart,type WorkpaperBatch,type WorkpaperAssess} from '@bondbuddy/contracts';
import {fixture,href,ids,now,sha} from './generation-entry-fixtures';

async function setup(page:import('@playwright/test').Page,count=350){
  const existing=await fixture(page),source=existing.workspaces.get(ids.api)!.source!;
  const data:WorkpaperWorkspace={catalogues:[{catalogue_id:'catalogue-1',filename:'合成底稿目录.xlsx',sha256:sha,created_at:now,warnings:[],entries:Array.from({length:count},(_,i)=>({id:`item-${i+1}`,code:`1.${i+1}`,title:`财务与业务核查 ${i+1}`,folder:'1 尽职调查',kind:'file' as const,path:`1 尽职调查/1.${i+1} 财务与业务核查 ${i+1}.docx`,row:i+2,sheet:'目录',instructions:''}))}],batches:[],assessments:[]};
  const state={data,source,requests:[] as WorkpaperStart[],assessmentRequests:[] as WorkpaperAssess[],assessmentState:'succeeded',uncertain:false,uncertainAssessment:false};
  await page.route('**/api/v1/projects/*/workpapers**',async route=>{
    const request=route.request(),url=new URL(request.url()),base=`/api/v1/projects/${ids.api}/workpapers`;
    if(url.pathname===base&&request.method()==='GET')return route.fulfill({json:data});
    if(url.pathname===base+'/assessments'){
      const request=route.request().postDataJSON();state.assessmentRequests.push(request);
      const assessment={assessment_id:'assessment-'+(data.assessments.length+1),state:state.assessmentState,source,request,created_at:now,result_hash:state.assessmentState==='succeeded'?sha:null,warnings:['资料不足不等于业务不适用。'],completed_items:state.assessmentState==='succeeded'?request.item_ids.length:0,
        decisions:data.catalogues[0].entries.filter(e=>request.item_ids.includes(e.id)).map((e,i)=>({item_id:e.id,status:(['not_applicable','external_evidence','missing_information','generate'] as const)[Math.min(i,3)],reason:['募集说明书明确不涉及境外投资。','需要经签章的原始证据。','募集书披露不足，暂无法生成。','募集书可支撑分析底稿。'][Math.min(i,3)],citations:i===0||i>=3?[{span_id:'p1',quote:i===0?'本期不涉及境外投资。':'募集书披露总资产100万元。'}]:[],missing_materials:i===2?['请补充业务明细。']:[]}))};
      data.assessments.unshift(assessment);if(state.uncertainAssessment){state.uncertainAssessment=false;return route.abort('failed');}return route.fulfill({json:assessment});
    }
    if(url.pathname===base+'/batches'){
      const body=request.postDataJSON() as WorkpaperStart;state.requests.push(body);
      if(!data.batches.length){const b:WorkpaperBatch={batch_id:'batch-1',topic_id:'topic-workpapers',catalogue_id:body.catalogue_id,revision:1,state:body.expected_points?'queued':'complete',source,total_points:body.expected_points,charged_points:0,created_at:now,error:null,
        items:data.catalogues[0].entries.filter(e=>body.item_ids.includes(e.id)).map((entry,i)=>({entry,decision:data.assessments[0].decisions.find(d=>d.item_id===entry.id),...(i<3?{explanation:{filename:entry.title+'-不适用说明.docx',sha256:sha}}:{}),run_id:null,state:i<3?'succeeded':'queued',stage:null,attempt:1,error:null,artifacts:[]}))};data.batches.push(b);}
      if(state.uncertain){state.uncertain=false;return route.abort('failed');}return route.fulfill({json:data.batches[0]});
    }
    return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
  });return state;
}
test('first visit with no catalogue presents the upload control',async({page})=>{
  const state=await setup(page);state.data.catalogues=[];
  await page.goto('/'+href({step:'choose'}));
  await page.getByRole('link',{name:'批量生成底稿',exact:true}).click();
  await expect(page).toHaveURL(new RegExp(`project=${ids.api}&step=workpapers`));
  await expect(page.getByRole('heading',{name:'上传底稿目录',exact:true})).toBeVisible();
  await expect(page.locator('#wp-upload')).toBeEnabled();
  await expect(page.getByText('底稿记录暂时无法读取。原记录已保留，请刷新重试。')).toHaveCount(0);
  await page.reload();await expect(page.locator('#wp-upload')).toBeEnabled();
});

for(const width of [1440,390])test(`workpapers ${width}: 350-row preview, selection, cost, existing source and batch progress`,async({page})=>{
  const state=await setup(page);await page.setViewportSize({width,height:960});await page.goto('/'+href({step:'workpapers'}));
  await expect(page.getByRole('heading',{name:'上传底稿目录',exact:true})).toBeVisible();await expect(page.locator('[data-wp-item]')).toHaveCount(350);
  await expect(page.locator('#wp-start')).toBeVisible();await expect(page.locator('#wp-start')).toHaveText('批量生成底稿');await expect(page.locator('#wp-start')).toBeEnabled();expect(state.requests).toHaveLength(0);
  await page.locator('#wp-filter').fill('核查 350');await expect(page.locator('[data-wp-item]')).toHaveCount(1);
  await page.locator('[data-wp-item]').uncheck();await expect(page.locator('#wp-confirm')).toContainText('349 份底稿');
  await page.locator('#wp-filter').fill('');await page.locator('#wp-requirements').fill('访谈只准备提纲，缺原件处标记待补充');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  // Leave the textarea before a full-page capture restores the narrow viewport.
  await page.locator('#wp-requirements').press('Tab');
  await mkdir('test-evidence/workpaper-actions',{recursive:true});await page.screenshot({path:`test-evidence/workpaper-actions/preparation-${width}.png`,fullPage:true});
  await page.locator('#wp-confirm').screenshot({path:`test-evidence/workpaper-actions/preparation-card-${width}.png`});
  await page.locator('#wp-start').click();await expect(page.locator('#wp-confirm')).toContainText('不生成 3 份');
  await expect(page.locator('#wp-start')).toBeDisabled();expect(state.requests).toHaveLength(0);
  await expect(page.locator('[data-wp-decision]')).toHaveCount(349);
  await page.screenshot({path:`test-evidence/workpaper-actions/assessment-${width}.png`,fullPage:true});
  await page.locator('#wp-confirm').screenshot({path:`test-evidence/workpaper-actions/assessment-card-${width}.png`});
  await page.locator('#wp-reviewed').check();await page.locator('#wp-start').click();await expect(page.locator('#wp-batches')).toContainText('3 / 349 份完成');
  expect(state.requests).toHaveLength(1);expect(state.requests[0].expected_points).toBe(346*WORKPAPER_PRICE.points);expect(state.requests[0].source_version_id).toBe('source-v3');
  expect(state.requests[0].requirements).toContain('访谈只准备提纲');await page.reload();await expect(page.locator('#wp-batches')).toContainText('3 / 349 份完成');
  expect(state.requests).toHaveLength(1);await page.screenshot({path:`test-evidence/workpaper-actions/progress-${width}.png`,fullPage:true});
});
test('workpapers uncertain submit survives reload and reuses the exact request and selection',async({page})=>{
  const state=await setup(page,3);state.uncertain=true;await page.goto('/'+href({step:'workpapers'}));await page.locator('#wp-start').click();await page.locator('#wp-reviewed').check();await page.locator('#wp-start').click();
  await expect(page.locator('#wp-start')).toHaveText('继续确认上次提交');await page.reload();await expect(page.locator('#wp-start')).toHaveText('继续确认上次提交');
  await expect(page.locator('[data-wp-item]').first()).toBeDisabled();await page.locator('#wp-start').click();await expect(page.locator('#wp-batches')).toContainText('3 / 3 份完成');
  expect(state.requests).toHaveLength(2);expect(state.requests[0]).toEqual(state.requests[1]);
});
for(const width of [1440,390])test(`workpaper prototype companion ${width}: selection and progress`,async({page})=>{
  await page.setViewportSize({width,height:960});
  const file=resolve(process.cwd(),'../../product-prototype/public/workpaper-batch.html').replaceAll('\\','/');
  await page.goto('/@fs/'+file);await expect(page.locator('#entries input')).toHaveCount(350);
  await page.locator('#wp-filter').fill('核查 350');await page.locator('#entries input').uncheck();await page.locator('#wp-filter').fill('');
  await page.locator('#wp-requirements').fill('访谈只准备提纲，缺原件处标记待补充');await expect(page.locator('#wp-confirm')).toContainText('349 份底稿');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.locator('#wp-requirements').press('Tab');
  await page.screenshot({path:`test-evidence/workpaper-actions/prototype-preparation-${width}.png`,fullPage:true});
  await page.locator('#wp-start').click();await expect(page.locator('#wp-confirm')).toContainText('不生成 3 份');
  await expect(page.locator('#wp-start')).toBeDisabled();
  await page.screenshot({path:`test-evidence/workpaper-actions/prototype-assessment-${width}.png`,fullPage:true});
  await page.locator('#wp-reviewed').check();await page.locator('#wp-start').click();await expect(page.locator('#wp-batches')).toContainText('3 / 349 份完成');
  await page.screenshot({path:`test-evidence/workpaper-actions/prototype-progress-${width}.png`,fullPage:true});
});

test('changing requirements invalidates the displayed assessment; all excluded files cost zero',async({page})=>{
 const state=await setup(page,3);await page.goto('/'+href({step:'workpapers'}));await page.locator('#wp-start').click();
 await expect(page.locator('#wp-confirm')).toContainText('可生成 0 份；不生成 3 份');await expect(page.locator('#wp-confirm')).toContainText('本批共 0 积分');
 await page.locator('#wp-reviewed').check();await page.locator('#wp-requirements').fill('新的要求');
 await expect(page.locator('#wp-start')).toBeVisible();await expect(page.locator('#wp-start')).toHaveText('批量生成底稿');await expect(page.locator('#wp-start')).toBeEnabled();expect(state.requests).toHaveLength(0);
 await page.locator('#wp-start').click();await expect(page.locator('#wp-start')).toBeDisabled();
 await page.locator('#wp-reviewed').check();await page.locator('#wp-start').click();
 expect(state.requests[0].expected_points).toBe(0);await page.getByText('查看逐份状态与下载').click();
 await expect(page.getByRole('button',{name:'下载不适用说明'})).toHaveCount(3);
});

test('uncertain confirmation can be recovered after the current prospectus changes',async({page})=>{
 const state=await setup(page,3);state.uncertain=true;await page.goto('/'+href({step:'workpapers'}));
 await page.locator('#wp-start').click();await page.locator('#wp-reviewed').check();await page.locator('#wp-start').click();
 await expect(page.locator('#wp-start')).toHaveText('继续确认上次提交');
 state.source.version_id='source-new';state.source.selection_revision++;
 await page.reload();await expect(page.locator('#wp-start')).toHaveText('继续确认上次提交');
 await page.locator('#wp-start').click();expect(state.requests).toHaveLength(2);expect(state.requests[0]).toEqual(state.requests[1]);
 await expect(page.locator('#wp-batches')).toContainText('3 / 3 份完成');
});

test('affected files can be recompiled from a batch older than the recent ten',async({page})=>{
 const state=await setup(page,3),catalogue={...state.data.catalogues[0],catalogue_id:'old-catalogue',filename:'历史底稿目录.xlsx'};
 await page.route('**/api/v1/projects/*/workpapers/batches/old-batch',r=>r.fulfill({json:{batch_id:'old-batch',catalogue_id:catalogue.catalogue_id}}));
 await page.route('**/api/v1/projects/*/workpapers/catalogues/old-catalogue',r=>r.fulfill({json:catalogue}));
 await page.route('**/api/v1/projects/*/workpapers/checks',r=>r.fulfill({json:{checks:[{batch_id:'old-batch',stale:false,result:{items:[{item_id:catalogue.entries[1].id,status:'needs_update'},{item_id:catalogue.entries[2].id,status:'current'}]}}]}}));
 await page.goto('/'+href({step:'workpapers'})+'&workpaper_batch=old-batch');
 await expect(page.locator('#wp-catalogue')).toHaveValue('old-catalogue');
 await expect(page.locator('[data-wp-item]:checked')).toHaveCount(1);
 await expect(page.locator('[data-wp-item]:checked')).toHaveAttribute('data-wp-item',catalogue.entries[1].id);
 await expect(page.locator('#wp-status')).toContainText('当前募集书重新判断');
});

for(const width of [1440,390])test(`generation action stays visible through checks and requires cost confirmation ${width}`,async({page})=>{
 const state=await setup(page,248);state.assessmentState='queued';
 await page.setViewportSize({width,height:960});await page.clock.install();
 await page.goto('/'+href({step:'workpapers'}));
 const start=page.locator('#wp-start'),status=page.locator('.wp-check-status'),hint=page.locator('#wp-action-hint');
 await expect(start).toHaveAccessibleName('批量生成底稿');await expect(start).toBeEnabled();
 await expect(start).toHaveAccessibleDescription('点击后先检查可生成文件；核对清单与费用后，再确认生成。');
 await start.click();await expect(status).toContainText('等待检查可生成文件');
 await expect(status).toContainText('已检查 0 / 248 项');await expect(start).toBeVisible();await expect(start).toBeDisabled();
 expect(state.requests).toHaveLength(0);expect(state.assessmentRequests).toHaveLength(1);
 const assessment=state.data.assessments[0];assessment.state='running';
 await page.clock.fastForward(5100);await expect(status).toContainText('正在检查可生成文件');
 await page.locator('.wp-check-help summary').click();
 await page.locator('#wp-confirm').scrollIntoViewIfNeeded();
 await mkdir('test-evidence/workpaper-actions',{recursive:true});
 await page.screenshot({path:`test-evidence/workpaper-actions/checking-${width}.png`,fullPage:true});
 await page.locator('#wp-confirm').screenshot({path:`test-evidence/workpaper-actions/checking-card-${width}.png`});
 assessment.completed_items=12;await page.clock.fastForward(5100);await expect(status).toContainText('已检查 12 / 248 项');
 await expect(page.locator('.wp-check-help')).toHaveAttribute('open','');
 await expect(page.getByRole('progressbar',{name:'可生成文件检查进度'})).toHaveAttribute('value','12');
 assessment.state='paused';await page.clock.fastForward(5100);await expect(status).toContainText('检查已暂停');
 await expect(hint).toContainText('处理提示后继续检查');await expect(start).toBeDisabled();
 await expect(page.getByRole('link',{name:'查看暂停任务'})).toHaveAttribute('href','#tasks');
 assessment.state='failed';await page.clock.fastForward(5100);await expect(status).toContainText('检查未完成');
 await expect(start).toBeEnabled();await expect(hint).toContainText('重新检查');expect(state.requests).toHaveLength(0);
 state.assessmentState='succeeded';await start.click();
 await expect(start).toHaveAccessibleName('确认并生成底稿');await expect(start).toBeDisabled();
 await expect(hint).toContainText('勾选确认');expect(state.requests).toHaveLength(0);
 await expect(page.locator('#wp-confirm')).toContainText((245*WORKPAPER_PRICE.points).toLocaleString());
 expect(await page.locator('.wp-assessment').evaluate(el=>{el.scrollTop=480;return {top:el.scrollTop,height:el.clientHeight,scrollHeight:el.scrollHeight};})).toMatchObject({top:480});
 await page.clock.fastForward(5100);
 expect(await page.locator('.wp-assessment').evaluate(el=>el.scrollTop)).toBe(480);
 await page.locator('#wp-reviewed').check();await expect(start).toBeEnabled();
 await start.click();await expect(page.locator('#wp-batches')).toContainText('3 / 248 份完成');
 expect(state.requests).toHaveLength(1);await expect(start).toBeDisabled();
 await expect(hint).toContainText('已有底稿文件包正在处理');
 const url=page.url();await page.getByRole('link',{name:'查看生成进度',exact:true}).click();await expect(page).toHaveURL(url);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test('uncertain check reuses the saved request and cannot start paid generation',async({page})=>{
 const state=await setup(page,4);state.uncertainAssessment=true;
 await page.goto('/'+href({step:'workpapers'}));await page.locator('#wp-start').click();
 await expect(page.locator('#wp-start')).toHaveText('继续确认检查请求');
 await page.reload();await expect(page.locator('#wp-start')).toHaveText('继续确认检查请求');
 await page.locator('#wp-start').click();await expect(page.locator('#wp-start')).toHaveText('确认并生成底稿');
 await expect(page.locator('#wp-start')).toBeDisabled();
 expect(state.assessmentRequests).toHaveLength(2);expect(state.assessmentRequests[0]).toEqual(state.assessmentRequests[1]);
 expect(state.requests).toHaveLength(0);
});

test('empty selection explains the disabled action without submitting a check',async({page})=>{
 const state=await setup(page,4);await page.goto('/'+href({step:'workpapers'}));await page.locator('#wp-none').click();
 await expect(page.locator('#wp-start')).toBeVisible();await expect(page.locator('#wp-start')).toBeDisabled();
 await expect(page.locator('#wp-start')).toHaveAccessibleDescription('请先在目录中勾选需要生成的底稿。');
 expect(state.assessmentRequests).toHaveLength(0);expect(state.requests).toHaveLength(0);
});

for(const width of [1440,390])test(`checking prototype companion ${width}`,async({page})=>{
 await page.setViewportSize({width,height:960});
 const file=resolve(process.cwd(),'../../product-prototype/public/workpaper-batch.html').replaceAll('\\','/');
 await page.goto('/@fs/'+file+'?check=running');await page.locator('.wp-check-help summary').click();
 await expect(page.locator('#wp-start')).toBeVisible();await expect(page.locator('#wp-start')).toBeDisabled();
 await page.locator('#wp-confirm').scrollIntoViewIfNeeded();
 await page.screenshot({path:`test-evidence/workpaper-actions/prototype-checking-${width}.png`,fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
