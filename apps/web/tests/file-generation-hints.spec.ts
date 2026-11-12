import {test,expect} from '@playwright/test';
import {resolve} from 'node:path';
import type {WorkpaperWorkspace} from '@bondbuddy/contracts';
import {fixture,href,ids,now,sha} from './generation-entry-fixtures';
import {workpaperPreparation} from './workpaper-preparation-fixture';

for(const width of [1440,390,320])test(`current preparation explains server pricing and empty selection ${width}`,async({page})=>{
 await page.setViewportSize({width,height:960});const transport=await fixture(page);
 const workpapers:WorkpaperWorkspace={catalogues:[{catalogue_id:'hint-cat',filename:'合成提示核对目录.xlsx',created_at:now,sha256:sha,warnings:[],entries:[1,2].map(n=>({id:'hint-'+n,code:'1.'+n,title:'合成核查 '+n,folder:'1 尽职调查',kind:'file',path:'1.'+n+' 合成核查.docx',sheet:'目录',row:n+1,instructions:''}))}],batches:[],assessments:[]};
 const generation=await workpaperPreparation(page,workpapers,transport.workspaces.get(ids.api)!.source!,true);
 generation.data.pricing!.workpaper_points=6789;
 await page.goto('/'+href({step:'prepare'}));await expect(page.locator('#fg-confirm')).toBeEnabled();
 await expect(page.locator('#fg-fee-note')).toContainText('每份底稿 6,789 积分');await expect(page.locator('#fg-fee-note')).toContainText('成功交付后扣费');await expect(page.locator('#fg-fee-note')).toContainText('仅形成资料不足或不适用说明不收费');
 await expect(page.locator('#fg-estimate')).toHaveText('13,578');await expect(page.locator('#fg-confirm')).toHaveAccessibleDescription(/每份底稿 6,789 积分/);
 await page.screenshot({path:test.info().outputPath(`implementation-fees-${width}.png`),fullPage:true});
 await page.locator('#fg-edit-scope').click();await page.locator('#fg-select-none').click();
 await expect(page.locator('#fg-confirm')).toBeDisabled();await expect(page.locator('#fg-action-hint')).toHaveText('请至少选择一份文件。');await expect(page.locator('#fg-confirm')).toHaveAccessibleDescription(/请至少选择一份文件/);
 await page.screenshot({path:test.info().outputPath(`implementation-empty-${width}.png`),fullPage:true});
 expect(generation.quotes).toEqual([]);expect(generation.submissions).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.locator('[data-fg-item="hint-2"]').check();await expect(page.locator('#fg-confirm')).toBeEnabled();await expect(page.locator('#fg-action-hint')).toHaveCount(0);
 await page.locator('[data-fg-type="workpaper"]').uncheck();await expect(page.locator('#fg-confirm')).toBeDisabled();await expect(page.locator('#fg-action-hint')).toBeVisible();await expect(page.locator('#fg-fee-note')).toHaveCount(0);
 expect(generation.quotes).toEqual([]);expect(generation.submissions).toEqual([]);
});

for(const width of [1440,390])test(`approved unified prototype keeps fee explanation and empty-selection guidance ${width}`,async({page})=>{
 await page.setViewportSize({width,height:960});const path=resolve('../../product-prototype/public/file-templates-v2.html').replaceAll('\\','/');await page.goto('/@fs/'+path);
 await page.locator('.source-strip [data-action="source"]').click();await page.locator('[data-action="demo-source"]').click();
 await page.locator('[data-action="next"]').click();await expect(page.locator('.confirm-summary')).toContainText('生成逐份计费');await expect(page.locator('.confirm-summary')).toContainText('仅形成说明的底稿');
 await page.screenshot({path:test.info().outputPath(`prototype-fees-${width}.png`),fullPage:true});
 await page.getByRole('button',{name:'返回调整',exact:true}).click();await page.locator('[data-action="review-missing"]').click();await page.locator('[data-action="clear-selection"]').click();await page.locator('[data-action="next"]').click();
 await expect(page.getByText('请至少选择一份文件。',{exact:true})).toBeVisible();await page.screenshot({path:test.info().outputPath(`prototype-empty-${width}.png`),fullPage:true});
});
