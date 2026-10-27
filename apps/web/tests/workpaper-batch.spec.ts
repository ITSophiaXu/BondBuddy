import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {WORKPAPER_PRICE,type WorkpaperWorkspace,type WorkpaperStart,type WorkpaperBatch} from '@bondbuddy/contracts';
import {fixture,href,ids,now,sha} from './generation-entry-fixtures';

async function setup(page:import('@playwright/test').Page,count=350){
  const existing=await fixture(page),source=existing.workspaces.get(ids.api)!.source!;
  const data:WorkpaperWorkspace={catalogues:[{catalogue_id:'catalogue-1',filename:'合成底稿目录.xlsx',sha256:sha,created_at:now,warnings:[],entries:Array.from({length:count},(_,i)=>({id:`item-${i+1}`,code:`1.${i+1}`,title:`财务与业务核查 ${i+1}`,folder:'1 尽职调查',kind:'file' as const,path:`1 尽职调查/1.${i+1} 财务与业务核查 ${i+1}.docx`,row:i+2,sheet:'目录',instructions:''}))}],batches:[],assessments:[]};
  const state={data,source,requests:[] as WorkpaperStart[],uncertain:false};
  await page.route('**/api/v1/projects/*/workpapers**',async route=>{
    const request=route.request(),url=new URL(request.url()),base=`/api/v1/projects/${ids.api}/workpapers`;
    if(url.pathname===base&&request.method()==='GET')return route.fulfill({json:data});
    if(url.pathname===base+'/assessments'){
      const request=route.request().postDataJSON();
      const assessment={assessment_id:'assessment-'+(data.assessments.length+1),state:'succeeded',source,request,created_at:now,result_hash:sha,warnings:['资料不足不等于业务不适用。'],completed_items:request.item_ids.length,
        decisions:data.catalogues[0].entries.filter(e=>request.item_ids.includes(e.id)).map((e,i)=>({item_id:e.id,status:(['not_applicable','external_evidence','missing_information','generate'] as const)[Math.min(i,3)],reason:['募集说明书明确不涉及境外投资。','需要经签章的原始证据。','募集书披露不足，暂无法生成。','募集书可支撑分析底稿。'][Math.min(i,3)],citations:i===0||i>=3?[{span_id:'p1',quote:i===0?'本期不涉及境外投资。':'募集书披露总资产100万元。'}]:[],missing_materials:i===2?['请补充业务明细。']:[]}))};
      data.assessments.unshift(assessment);return route.fulfill({json:assessment});
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
  await page.goto('/'+href({step:'workpapers'}));
  await expect(page.getByRole('heading',{name:'按底稿目录批量生成'})).toBeVisible();
  await expect(page.locator('#wp-upload')).toBeEnabled();
  await expect(page.getByText('底稿记录暂时无法读取。原记录已保留，请刷新重试。')).toHaveCount(0);
  await page.reload();await expect(page.locator('#wp-upload')).toBeEnabled();
});

for(const width of [1440,390])test(`workpapers ${width}: 350-row preview, selection, cost, existing source and batch progress`,async({page})=>{
  const state=await setup(page);await page.setViewportSize({width,height:960});await page.goto('/'+href({step:'workpapers'}));
  await expect(page.getByRole('heading',{name:'按底稿目录批量生成'})).toBeVisible();await expect(page.locator('[data-wp-item]')).toHaveCount(350);
  await expect(page.locator('#wp-start')).toHaveCount(0);expect(state.requests).toHaveLength(0);
  await page.locator('#wp-filter').fill('核查 350');await expect(page.locator('[data-wp-item]')).toHaveCount(1);
  await page.locator('[data-wp-item]').uncheck();await expect(page.locator('#wp-confirm')).toContainText('349 份底稿');
  await page.locator('#wp-filter').fill('');await page.locator('#wp-requirements').fill('访谈只准备提纲，缺原件处标记待补充');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await mkdir('test-evidence/workpaper-batch',{recursive:true});await page.screenshot({path:`test-evidence/workpaper-batch/preparation-${width}.png`,fullPage:true});
  await page.locator('#wp-assess').click();await expect(page.locator('#wp-confirm')).toContainText('不生成 3 份');
  await expect(page.locator('#wp-start')).toBeDisabled();expect(state.requests).toHaveLength(0);
  await expect(page.locator('[data-wp-decision]')).toHaveCount(349);
  await page.screenshot({path:`test-evidence/workpaper-batch/assessment-${width}.png`,fullPage:true});
  await page.locator('#wp-reviewed').check();await page.locator('#wp-start').click();await expect(page.locator('#wp-batches')).toContainText('3 / 349 份完成');
  expect(state.requests).toHaveLength(1);expect(state.requests[0].expected_points).toBe(346*WORKPAPER_PRICE.points);expect(state.requests[0].source_version_id).toBe('source-v3');
  expect(state.requests[0].requirements).toContain('访谈只准备提纲');await page.reload();await expect(page.locator('#wp-batches')).toContainText('3 / 349 份完成');
  expect(state.requests).toHaveLength(1);await page.screenshot({path:`test-evidence/workpaper-batch/progress-${width}.png`,fullPage:true});
});
test('workpapers uncertain submit survives reload and reuses the exact request and selection',async({page})=>{
  const state=await setup(page,3);state.uncertain=true;await page.goto('/'+href({step:'workpapers'}));await page.locator('#wp-assess').click();await page.locator('#wp-reviewed').check();await page.locator('#wp-start').click();
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
  await page.screenshot({path:`test-evidence/workpaper-batch/prototype-preparation-${width}.png`,fullPage:true});
  await page.locator('#wp-assess').click();await expect(page.locator('#wp-confirm')).toContainText('不生成 3 份');
  await expect(page.locator('#wp-start')).toBeDisabled();
  await page.screenshot({path:`test-evidence/workpaper-batch/prototype-assessment-${width}.png`,fullPage:true});
  await page.locator('#wp-reviewed').check();await page.locator('#wp-start').click();await expect(page.locator('#wp-batches')).toContainText('3 / 349 份完成');
  await page.screenshot({path:`test-evidence/workpaper-batch/prototype-progress-${width}.png`,fullPage:true});
});

test('changing requirements invalidates the displayed assessment; all excluded files cost zero',async({page})=>{
 const state=await setup(page,3);await page.goto('/'+href({step:'workpapers'}));await page.locator('#wp-assess').click();
 await expect(page.locator('#wp-confirm')).toContainText('可生成 0 份；不生成 3 份');await expect(page.locator('#wp-confirm')).toContainText('本批共 0 积分');
 await page.locator('#wp-reviewed').check();await page.locator('#wp-requirements').fill('新的要求');
 await expect(page.locator('#wp-start')).toHaveCount(0);expect(state.requests).toHaveLength(0);
 await page.locator('#wp-assess').click();await expect(page.locator('#wp-start')).toBeDisabled();
 await page.locator('#wp-reviewed').check();await page.locator('#wp-start').click();
 expect(state.requests[0].expected_points).toBe(0);await page.getByText('查看逐份状态与下载').click();
 await expect(page.getByRole('button',{name:'下载不适用说明'})).toHaveCount(3);
});

test('uncertain confirmation can be recovered after the current prospectus changes',async({page})=>{
 const state=await setup(page,3);state.uncertain=true;await page.goto('/'+href({step:'workpapers'}));
 await page.locator('#wp-assess').click();await page.locator('#wp-reviewed').check();await page.locator('#wp-start').click();
 await expect(page.locator('#wp-start')).toHaveText('继续确认上次提交');
 state.source.version_id='source-new';state.source.selection_revision++;
 await page.reload();await expect(page.locator('#wp-start')).toHaveText('继续确认上次提交');
 await page.locator('#wp-start').click();expect(state.requests).toHaveLength(2);expect(state.requests[0]).toEqual(state.requests[1]);
 await expect(page.locator('#wp-batches')).toContainText('3 / 3 份完成');
});
