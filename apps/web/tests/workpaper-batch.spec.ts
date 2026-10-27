import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {WORKPAPER_PRICE,type WorkpaperWorkspace,type WorkpaperStart,type WorkpaperBatch} from '@bondbuddy/contracts';
import {fixture,href,ids,now,sha} from './generation-entry-fixtures';

async function setup(page:import('@playwright/test').Page,count=350){
  const existing=await fixture(page),source=existing.workspaces.get(ids.api)!.source!;
  const data:WorkpaperWorkspace={catalogues:[{catalogue_id:'catalogue-1',filename:'合成底稿目录.xlsx',sha256:sha,created_at:now,warnings:[],entries:Array.from({length:count},(_,i)=>({id:`item-${i+1}`,code:`1.${i+1}`,title:`财务与业务核查 ${i+1}`,folder:'1 尽职调查',kind:'file' as const,path:`1 尽职调查/1.${i+1} 财务与业务核查 ${i+1}.docx`,row:i+2,sheet:'目录',instructions:''}))}],batches:[]};
  const state={data,requests:[] as WorkpaperStart[],uncertain:false};
  await page.route('**/api/v1/projects/*/workpapers**',async route=>{
    const request=route.request(),url=new URL(request.url()),base=`/api/v1/projects/${ids.api}/workpapers`;
    if(url.pathname===base&&request.method()==='GET')return route.fulfill({json:data});
    if(url.pathname===base+'/batches'){
      const body=request.postDataJSON() as WorkpaperStart;state.requests.push(body);
      if(!data.batches.length){const b:WorkpaperBatch={batch_id:'batch-1',topic_id:'topic-workpapers',catalogue_id:body.catalogue_id,revision:1,state:'queued',source,total_points:body.expected_points,charged_points:0,created_at:now,error:null,
        items:data.catalogues[0].entries.filter(e=>body.item_ids.includes(e.id)).map(entry=>({entry,run_id:null,state:'queued',stage:null,attempt:1,error:null,artifacts:[]}))};data.batches.push(b);}
      if(state.uncertain){state.uncertain=false;return route.abort('failed');}return route.fulfill({json:data.batches[0]});
    }
    return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
  });return state;
}
for(const width of [1440,390])test(`workpapers ${width}: 350-row preview, selection, cost, existing source and batch progress`,async({page})=>{
  const state=await setup(page);await page.setViewportSize({width,height:960});await page.goto('/'+href({step:'workpapers'}));
  await expect(page.getByRole('heading',{name:'按底稿目录批量生成'})).toBeVisible();await expect(page.locator('[data-wp-item]')).toHaveCount(350);
  await expect(page.locator('#wp-confirm')).toContainText('1,575,000 积分');expect(state.requests).toHaveLength(0);
  await page.locator('#wp-filter').fill('核查 350');await expect(page.locator('[data-wp-item]')).toHaveCount(1);
  await page.locator('[data-wp-item]').uncheck();await expect(page.locator('#wp-confirm')).toContainText('349 份底稿');
  await page.locator('#wp-filter').fill('');await page.locator('#wp-requirements').fill('访谈只准备提纲，缺原件处标记待补充');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await mkdir('test-evidence/workpaper-batch',{recursive:true});await page.screenshot({path:`test-evidence/workpaper-batch/preparation-${width}.png`,fullPage:true});
  await page.locator('#wp-start').click();await expect(page.locator('#wp-batches')).toContainText('0 / 349 份完成');
  expect(state.requests).toHaveLength(1);expect(state.requests[0].expected_points).toBe(349*WORKPAPER_PRICE.points);expect(state.requests[0].source_version_id).toBe('source-v3');
  expect(state.requests[0].requirements).toContain('访谈只准备提纲');await page.reload();await expect(page.locator('#wp-batches')).toContainText('0 / 349 份完成');
  expect(state.requests).toHaveLength(1);await page.screenshot({path:`test-evidence/workpaper-batch/progress-${width}.png`,fullPage:true});
});
test('workpapers uncertain submit survives reload and reuses the exact request and selection',async({page})=>{
  const state=await setup(page,3);state.uncertain=true;await page.goto('/'+href({step:'workpapers'}));await expect(page.locator('#wp-start')).toBeEnabled();await page.locator('#wp-start').click();
  await expect(page.locator('#wp-start')).toHaveText('继续确认上次提交');await page.reload();await expect(page.locator('#wp-start')).toHaveText('继续确认上次提交');
  await expect(page.locator('[data-wp-item]').first()).toBeDisabled();await page.locator('#wp-start').click();await expect(page.locator('#wp-batches')).toContainText('0 / 3 份完成');
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
  await page.locator('#wp-start').click();await expect(page.locator('#wp-batches')).toContainText('0 / 349 份完成');
  await page.screenshot({path:`test-evidence/workpaper-batch/prototype-progress-${width}.png`,fullPage:true});
});
