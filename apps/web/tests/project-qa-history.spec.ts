import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fixture,install,route,historical} from './qa-result-next-fixtures';
import {answerId,otherAnswerId,prepareId,projectId,writes,assertFixture} from './project-qa-continuation-fixtures';

test.afterEach(async({page})=>{await assertFixture(page);});

for(const width of [1440,390])test(`QA history contains only answers, ordered and numbered independently at ${width}`,async({page})=>{
 const s=fixture(),first=historical(s),second=historical(s,otherAnswerId),preparation=historical(s,prepareId);
 first.answer_sequence=1;second.answer_sequence=2;
 // The API pins a requested older run first; display order must stay newest first.
 s.workspace.runs=[first,preparation,second];
 await install(page,s);await page.setViewportSize({width,height:width===390?844:960});await page.goto(route());
 const select=page.locator('#qa-history');
 await expect(select).toHaveValue(answerId);
 await expect(select.locator('option')).toHaveText(['准备下一轮',/^第 2 次 · 回答问题 · 已完成/,/^第 1 次 · 回答问题 · 已完成/]);
 await expect(select.locator(`option[value="${prepareId}"]`)).toHaveCount(0);
 await expect(select).not.toContainText('识别问题');
 const evidence=process.env.BB_QA_HISTORY_EVIDENCE_DIR;
 if(evidence){
  await mkdir(evidence,{recursive:true});
  await page.screenshot({path:join(evidence,`history-page-${width}.png`),fullPage:true});
  await page.locator('.qa-toolbar').screenshot({path:join(evidence,`history-implementation-${width}.png`)});
  const componentWidth=(await page.locator('.qa-toolbar').boundingBox())!.width,reference=await page.context().newPage();
  await reference.setViewportSize({width,height:width===390?844:960});
  await reference.goto('/@fs/'+resolve(process.cwd(),'../../product-prototype/public/qa-document.html').replaceAll('\\','/'));
  await reference.locator('[data-show="result"]').click();
  await reference.locator('main').evaluate((node,w)=>{node.style.width=w+'px';node.style.maxWidth='none';node.style.padding='0';},componentWidth);
  await reference.locator('.qa-toolbar').screenshot({path:join(evidence,`history-prototype-${width}.png`)});await reference.close();
 }
 await select.selectOption(otherAnswerId);await expect(page.locator('#qa-history')).toHaveValue(otherAnswerId);
 await page.reload();await expect(page.locator('#qa-history')).toHaveValue(otherAnswerId);
 await page.locator('#qa-history').selectOption(answerId);await expect(page.locator('#qa-history')).toHaveValue(answerId);
 await expect(page.locator('#qa-download')).toBeVisible();
 await page.locator('#qa-history').selectOption('');
 await expect(page).toHaveURL(url=>{const query=new URLSearchParams(url.hash.split('?')[1]);return query.get('project')===projectId&&!query.has('run');});
 expect(writes(s)).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});

test('preparation-only history stays hidden while the current preparation remains editable',async({page})=>{
 const s=fixture();s.workspace.runs=s.workspace.runs.filter(r=>r.operation==='prepare');
 await install(page,s);await page.goto(route(prepareId));await expect(page.locator('#qa-history')).toBeHidden();
 await expect(page.locator('#qa-preparation-controls')).toBeVisible();await page.reload();
 await expect(page.locator('#qa-use-preparation')).toHaveCount(0);await expect(page.locator('#qa-preparation-controls')).toBeVisible();
 await expect(page.locator('#qa-history')).toBeHidden();expect(s.answers).toEqual([]);expect(s.prepares).toEqual([]);
});

for(const state of ['queued','running','failed','cancelled'])test(`answer attempts remain in history when ${state}`,async({page})=>{
 const s=fixture(),answer=historical(s);answer.state=state;answer.result=null;answer.artifact_id=null;answer.answer_sequence=1;
 await install(page,s);await page.goto(route());await expect(page.locator('#qa-history')).toHaveValue(answerId);
 await expect(page.locator(`#qa-history option[value="${answerId}"]`)).toContainText('第 1 次 · 回答问题');
 await expect(page.locator(`#qa-history option[value="${prepareId}"]`)).toHaveCount(0);expect(writes(s)).toEqual([]);
});

test('older servers without answer ordinals do not display the combined task count',async({page})=>{
 const s=fixture();await install(page,s);await page.goto(route());
 await expect(page.locator(`#qa-history option[value="${answerId}"]`)).toHaveText(/^回答问题 · 已完成/);
 await expect(page.locator('#qa-history')).not.toContainText('第 5 次');expect(writes(s)).toEqual([]);
});

test('a pinned older answer keeps its global answer number outside the recent history window',async({page})=>{
 const s=fixture();historical(s).answer_sequence=1;historical(s,otherAnswerId).answer_sequence=106;
 await install(page,s);await page.goto(route());
 await expect(page.locator('#qa-history option')).toHaveText(['准备下一轮',/^第 106 次 · 回答问题/,/^第 1 次 · 回答问题/]);
 await expect(page.locator('#qa-history')).toHaveValue(answerId);expect(writes(s)).toEqual([]);
});
