import {test,expect,type Page,type Locator} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import * as authoring from './authoring-next-layout-fixtures';
import * as qa from './project-qa-continuation-fixtures';
import * as review from './review-flow-reader-fixtures';
import * as generation from './generation-entry-fixtures';
import * as files from './project-file-status-fixtures';

// Real DOM, CSS, downloads and interactions against existing synthetic HTTP
// fixtures. No provider calls, live billing or customer material is used.
async function visibleAction(button:Locator){
  await expect(button).toBeInViewport({ratio:1});
  expect(await button.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})).toBe(true);
}
async function capture(page:Page,name:string){
  const directory=process.env.BB_DESKTOP_UX_EVIDENCE;if(!directory)return;
  await mkdir(directory,{recursive:true});await page.screenshot({path:join(directory,name+'.png')});
}
async function laptop(page:Page){await page.setViewportSize({width:1366,height:768});await page.evaluate(()=>window.scrollTo(0,0));}

test('long project titles leave a single-line action and the original authoring footer accessible',async({page})=>{
  const state=authoring.fixture();state.project.name='合成城市建设投资集团有限公司-上交所-普通私募公司债-募集书更新';
  await authoring.open(page,state);await authoring.prepare(page);await laptop(page);
  await expect(page.locator('#project-heading')).toHaveText(state.project.name);
  await expect(page.locator('#project-heading')).toHaveAttribute('title',state.project.name);
  const title=await page.locator('#project-heading').boundingBox(),action=await page.locator('#delete-project').boundingBox();
  expect(action!.height).toBeLessThanOrEqual(40);expect(title!.x+title!.width).toBeLessThan(action!.x);
  await expect(page.locator('#execute-input')).toHaveCount(1);
  for(const y of [0,700,1500]){await page.evaluate(y=>window.scrollTo(0,y),y);await visibleAction(page.locator('#execute-input'));}
  await page.evaluate(()=>window.scrollTo(0,0));await capture(page,'authoring-sticky');
  expect(state.executions).toEqual([]);await authoring.assertFixture(page);
});

test('review presents the selected V1 download before the fold and keeps the other running task separate',async({page})=>{
  const state=await review.open(page),before=review.immutable(state);await laptop(page);
  const download=page.getByRole('button',{name:'下载原文批注版',exact:true});await visibleAction(download);
  await expect(page.locator('[data-review-result-context]')).toContainText('正在查看成果 V1');
  await expect(page.locator('.review-background-task')).toContainText('第 3 轮');
  await expect(page.getByRole('link',{name:'查看进行中任务'})).toHaveAttribute('href',/tab=making&run=review-flow-reader-run-3/);
  const event=page.waitForEvent('download');await download.click();const received=await event;
  expect(await review.downloadBytes(received)).toEqual(state.bytes.get(review.artifactId(1,'comments')));
  expect(review.immutable(state)).toEqual(before);expect(review.writes(state)).toEqual([]);
  await capture(page,'review-result');await review.assertFixture(page);
});

test('QA delivers the selected answer first without changing its material snapshot or history',async({page})=>{
  const state=qa.fixture(),before=qa.historicalRecords(state);await qa.install(page,state);
  await page.goto('/#qa?project='+qa.projectId+'&run='+qa.answerId);await laptop(page);
  const download=page.locator('#qa-download');await visibleAction(download);
  await expect(page.locator('.qa-result-context')).toBeInViewport({ratio:1});
  expect(await page.locator('.qa-layout > *').evaluateAll(nodes=>nodes[0].classList.contains('qa-document'))).toBe(true);
  await expect(page.locator('.qa-project-materials')).toContainText('此历史任务未单独记录募集说明书版本');
  await capture(page,'qa-result');await page.locator('#qa-history').selectOption(qa.otherAnswerId);
  await expect(page).toHaveURL(new RegExp(qa.otherAnswerId));await visibleAction(page.locator('#qa-download'));
  expect(qa.historicalRecords(state)).toEqual(before);expect(qa.writes(state)).toEqual([]);await qa.assertFixture(page);
});

test('QA sticky controls retain native disabled state and save the same preparation',async({page})=>{
  const state=qa.fixture();await qa.install(page,state);await page.goto('/#qa?project='+qa.projectId);await laptop(page);
  await expect(page.locator('#qa-start')).toBeDisabled();
  for(const y of [700,1100,1600]){await page.evaluate(y=>window.scrollTo(0,y),y);await visibleAction(page.locator('#qa-save'));}
  await page.locator('#qa-requirements').fill('合成验证：保留原题，逐项说明依据。');
  await page.locator('#qa-save').click();await expect(page.locator('#project-qa-status')).toContainText('已保存');
  expect(state.answers).toEqual([]);expect(state.prepares).toEqual([]);
  await capture(page,'qa-preparation-sticky');await qa.assertFixture(page);
});

test('generation has a readable change control and a visible original submit action',async({page})=>{
  const state=await generation.fixture(page);await generation.open(page);await generation.choose(page,['issuer','legal']);await laptop(page);
  const change=page.locator('.pf-generation-source > a');expect((await change.boundingBox())!.width).toBeGreaterThanOrEqual(64);
  await expect(change).toHaveAttribute('href',/step=source/);
  await page.evaluate(()=>window.scrollTo(0,500));await visibleAction(page.locator('#pf-generate'));
  await expect(page.locator('#pf-generate')).toHaveCount(1);await capture(page,'generation-sticky');
  await change.click();await expect(page).toHaveURL(/step=source/);expect(generation.batches(state)).toEqual([]);
});

test('compact current-file card keeps upload, version history and warnings available',async({page})=>{
  const state=await files.open(page);await laptop(page);
  await visibleAction(page.locator('#choose-prospectus-version'));
  await expect(page.locator('.prospectus-current-file')).toContainText(state.source.filename);
  await page.locator('[data-prospectus-history] > summary').click();await expect(page.locator('[data-prospectus-history]')).toHaveAttribute('open','');
  await page.locator('[data-prospectus-history] > summary').click();await capture(page,'project-current-file');files.noExecution(state);
});

for(const width of [1024,1366])test(`desktop workspace responds to the open assistant at ${width}px`,async({page})=>{
  const state=qa.fixture();await qa.install(page,state);await page.setViewportSize({width,height:768});
  await page.goto('/#qa?project='+qa.projectId+'&run='+qa.answerId);
  await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();
  await expect(page.locator('#ba-panel')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  const history=await page.locator('#qa-history').boundingBox(),assistant=await page.locator('#ba-panel').boundingBox();
  expect(history!.x+history!.width).toBeLessThanOrEqual(assistant!.x);
  await page.getByRole('button',{name:'收起助手',exact:true}).click();await expect(page.locator('#ba-panel')).toBeHidden();
  await capture(page,'qa-assistant-'+width);expect(qa.writes(state)).toEqual([]);
});
