import {test,expect} from '@playwright/test';
import {fixture,install,prepareId,projectId,writes} from './project-qa-continuation-fixtures';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
test.skip(!process.env.BB_QA_SINGLE_START_BASELINE,'Optional immutable baseline visual capture');
for(const width of [1440,390])test(`baseline two-page preparation at ${width}`,async({page,baseURL})=>{
 for(const ext of ['ts','css'])await page.route(`**/src/project-qa-workspace.${ext}*`,async route=>{
  const response=await route.fetch({url:`${baseURL}/src/qa-single-start-baseline.${ext}`});await route.fulfill({response});
 });
 const s=fixture();s.workspace.draft={preparation_id:null,questions:[],materials:[],requirements:'',use_knowledge:false};await install(page,s);await page.setViewportSize({width,height:960});
 await page.goto(`/#qa?project=${projectId}&run=${prepareId}`);await expect(page.locator('#qa-use-preparation')).toBeVisible();
 const dir=process.env.BB_UX_EVIDENCE_DIR!;await mkdir(dir,{recursive:true});await page.screenshot({path:join(dir,`before-recognition-${width}.png`),fullPage:true});
 await page.locator('#qa-use-preparation').click();await page.locator('[data-remove-q]').last().click();await page.locator('#qa-requirements').fill('请保留完整明细与期间。');await page.reload();
 await expect(page.locator('#qa-knowledge')).toBeVisible();await page.screenshot({path:join(dir,`before-preparation-${width}.png`),fullPage:true});expect(writes(s)).toEqual([]);expect(s.errors).toEqual([]);
});
