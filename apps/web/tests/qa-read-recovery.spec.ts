import {expect,test,type Page,type Route} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fixtureBody} from './billing-fixture-wire';
import {fixture,install,assertFixture,route,projectId,answerId,addActiveRun,recovery,writes,historicalRecords} from './qa-reference-materials-fixtures';

const unavailable='当前结果无法核实，请刷新后联系支持。';
const saveUnknown='保存结果暂未确认，请重新读取当前记录后再继续。';
const captureDir=process.env.BB_QA_RECOVERY_CAPTURE;
async function capture(page:Page,name:string){
  if(!captureDir)return;
  await mkdir(captureDir,{recursive:true});await page.screenshot({path:join(captureDir,name+'.png')});
}
type Failure='network'|'schema'|'billing';
function failRead(intercepted:Route,failure:Failure,s:ReturnType<typeof fixture>){
  if(failure==='network')return intercepted.abort('connectionreset');
  const body=fixtureBody(intercepted,s.workspace) as any;
  if(failure==='schema')body.runs[0].sequence=-1;
  else body.price.points='1.5';
  return intercepted.fulfill({json:body});
}
test.beforeEach(async({page})=>page.setViewportSize({width:1440,height:960}));
test.afterEach(async({page})=>assertFixture(page));

for(const failure of ['network','schema','billing'] as const)test(`QA initial ${failure} read can retry the same result without submitting`,async({page})=>{
  const s=await install(page,fixture()),history=historicalRecords(s);let failing=true;
  await page.route(`**/api/v1/projects/${projectId}/qa?*`,r=>failing?failRead(r,failure,s):r.fallback());
  await page.goto(route(answerId));
  await expect(page.getByRole('heading',{name:'项目问答暂时无法打开'})).toBeVisible();
  await expect(page.locator('#qa-download')).toHaveCount(0);
  if(failure==='schema')await capture(page,'initial-read-retry');
  failing=false;await page.getByRole('button',{name:'重新读取',exact:true}).click();
  await expect(page.locator('#qa-download')).toBeVisible();
  await expect(page.locator('#project-qa-status')).toBeEmpty();
  await expect(page.locator('#qa-history')).toHaveValue(answerId);
  expect(new URL(page.url()).hash).toBe(route(answerId).slice(1));
  expect(historicalRecords(s)).toEqual(history);expect(writes(s)).toEqual([]);
  if(failure==='schema'&&captureDir){
    await capture(page,'recovered-result');
    await page.goto('/@fs/'+resolve(process.cwd(),'../../product-prototype/public/qa-document.html').replaceAll('\\','/'));
    await page.locator('[data-show=result]').click();await expect(page.locator('[data-view=result]')).toBeVisible();
    await capture(page,'prototype-result');
  }
});

test('QA polling clears only its recovered read error and preserves the verified result',async({page})=>{
  const s=fixture(),active=addActiveRun(s);await install(page,s);let failing=false,failedReads=0;
  await page.route(`**/api/v1/projects/${projectId}/qa?*`,r=>{
    if(!failing)return r.fallback();failedReads++;return failRead(r,'schema',s);
  });
  await page.goto(route(answerId));await expect(page.locator('#qa-download')).toBeVisible();
  failing=true;await expect(page.locator('#project-qa-status')).toHaveText(unavailable,{timeout:10000});
  await expect.poll(()=>failedReads,{timeout:10000}).toBeGreaterThanOrEqual(2);
  await expect(page.locator('[data-qa-answer-question]')).toHaveCount(3);
  failing=false;active.state='succeeded';
  await expect(page.locator('#project-qa-status')).toBeEmpty({timeout:10000});
  await expect(page.locator('#qa-download')).toBeVisible();expect(writes(s)).toEqual([]);
});

test('QA read recovery retains an unconfirmed save and its original request',async({page})=>{
  const s=fixture(),active=addActiveRun(s);await install(page,s);let failing=false;
  await page.route(`**/api/v1/projects/${projectId}/qa`,r=>failing?failRead(r,'billing',s):r.fallback());
  await page.goto(route());await expect(page.locator('#qa-save')).toBeVisible();
  await page.locator('#qa-requirements').fill('合成测试：读取恢复不得清除未确认的保存。');
  s.dropDraft=true;await page.locator('#qa-save').click();
  await expect(page.locator('#project-qa-status')).toHaveText(saveUnknown);
  const pending=(await recovery(page)).pending;expect(pending?.kind).toBe('draft');
  failing=true;await expect(page.locator('#project-qa-status')).toContainText(unavailable,{timeout:10000});
  await expect(page.locator('#project-qa-status')).toContainText(saveUnknown);
  failing=false;active.state='succeeded';
  await expect(page.locator('#project-qa-status')).toHaveText(saveUnknown,{timeout:10000});
  await expect(page.locator('#qa-start')).toBeDisabled();
  expect((await recovery(page)).pending).toEqual(pending);expect(s.drafts).toHaveLength(1);
  expect(s.answers).toEqual([]);expect(s.reservations).toEqual([]);
});
