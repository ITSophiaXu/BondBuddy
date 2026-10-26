import {expect,test,type Page} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,install,assertFixture,route,projectId,answerId,recovery,writes} from './qa-reference-materials-fixtures';
import {installContextualErrorsReference} from './contextual-errors-reference';

const baseline=process.env.BB_CONTEXTUAL_ERRORS_BASELINE==='1';
const readText='读取暂未成功，请稍后重新读取。';
const downloadText='文件暂时未能下载，请稍后重试下载。';
async function capture(page:Page,name:string,extra:Record<string,unknown>={}) {
  const output=process.env.BB_CONTEXTUAL_ERRORS_CAPTURE;
  if(!output)return;
  await mkdir(output,{recursive:true});
  const facts=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollY,scrollWidth:document.documentElement.scrollWidth,
    hash:location.hash,text:document.querySelector('#project-qa-status,[role=alert]')?.textContent,
    focus:document.activeElement instanceof HTMLElement?{tag:document.activeElement.tagName,id:document.activeElement.id}:null}));
  expect(facts.width).toBe(1440);expect(facts.height).toBe(960);expect(facts.scrollWidth).toBeLessThanOrEqual(1441);
  await page.screenshot({path:join(output,name+'.png')});
  await writeFile(join(output,name+'.json'),JSON.stringify({...facts,...extra},null,2));
}
test.beforeEach(async({page})=>{await page.setViewportSize({width:1440,height:960});page.on('dialog',dialog=>void dialog.accept());});
test.afterEach(async({page})=>{await assertFixture(page);});

for(const failure of ['network','malformed-json'] as const) test(`contextual errors ${baseline?'baseline':'current'}: native QA ${failure} read has no write`,async({page})=>{
  const finish=baseline?await installContextualErrorsReference(page):undefined;
  const s=await install(page,fixture());
  await page.route(`**/api/v1/projects/${projectId}/qa*`,intercepted=>failure==='network'?intercepted.abort('connectionreset'):
    intercepted.fulfill({status:200,contentType:'application/json',body:'{"private_synthetic_body":'}));
  await page.goto(route());await expect(page.getByRole('heading',{name:'项目问答暂时无法打开'})).toBeVisible();
  const alert=page.locator('main [role=alert]');
  if(baseline){await expect(alert).not.toHaveText(readText);await expect(alert).toContainText(failure==='network'?/fetch/i:/JSON|position|Unexpected/i);}
  else await expect(alert).toHaveText(readText);
  expect(writes(s)).toEqual([]);expect(s.answers).toEqual([]);expect(s.prepares).toEqual([]);expect(s.reservations).toEqual([]);
  await capture(page,`${baseline?'r39':'current'}-qa-read-${failure}`,{reference:finish?.(),business_writes:0});
});

if(!baseline){
  for(const failure of ['network','malformed-json','wrong-run'] as const)test(`contextual errors: native QA ${failure} download retains read-only context`,async({page})=>{
    const s=await install(page,fixture());let artifactReads=0,downloads=0;
    page.on('download',()=>downloads++);
    await page.route('**/api/v1/artifacts/**',intercepted=>{
      artifactReads++;
      if(failure==='network')return intercepted.abort('connectionreset');
      if(failure==='malformed-json')return intercepted.fulfill({status:200,contentType:'application/json',body:'{invalid private body'});
      return intercepted.fulfill({json:{artifact_id:s.workspace.runs.find(r=>r.run_id===answerId)!.artifact_id,run_id:'synthetic-wrong-run'}});
    });
    await page.goto(route(answerId));await expect(page.locator('#qa-download')).toBeVisible();await page.locator('#qa-download').click();
    const status=page.locator('#project-qa-status');
    await expect(status).toHaveText(failure==='wrong-run'?'当前回填 Word 与所选问答任务的对应关系无法核实，请重新读取后再下载。':downloadText);
    expect(artifactReads).toBe(1);expect(downloads).toBe(0);expect(writes(s)).toEqual([]);expect(s.reservations).toEqual([]);
    await status.scrollIntoViewIfNeeded();await capture(page,'current-qa-download-'+failure,{artifact_reads:artifactReads,business_writes:0,downloads});
  });

  test('contextual errors: lost QA save receipt retains complete request and only reads to reconcile',async({page})=>{
    const s=await install(page,fixture());await page.goto(route());await expect(page.locator('#qa-save')).toBeVisible();
    await page.locator('#qa-requirements').fill('合成 R40：保存回执丢失后保留完整原请求。');s.dropDraft=true;await page.locator('#qa-save').click();
    await expect(page.locator('#project-qa-status')).toHaveText('保存结果暂未确认，请重新读取当前记录后再继续。');
    const pending=(await recovery(page)).pending;expect(pending?.kind).toBe('draft');expect(s.drafts).toHaveLength(1);
    await expect(page.locator('#qa-start')).toBeDisabled();await expect(page.locator('#qa-refresh-pending')).toBeVisible();
    await page.locator('#project-qa-status').scrollIntoViewIfNeeded();await capture(page,'current-qa-save-unknown',{pending,business_writes:s.drafts.length});
    await page.locator('#qa-refresh-pending').click();await expect(page.locator('#project-qa-status')).toContainText('原准备内容已完整保存');
    expect(s.drafts).toHaveLength(1);expect((await recovery(page)).pending).toBeUndefined();expect(s.answers).toEqual([]);expect(s.reservations).toEqual([]);
  });

  test('contextual errors: lost QA submit receipt retains original identity and explicit retry causes one reservation',async({page})=>{
    const s=await install(page,fixture());s.dropAnswer='after';await page.goto(route());await expect(page.locator('#qa-start')).toBeVisible();
    await page.locator('#qa-start').click();await page.locator('#qa-confirm').click();
    await expect(page.locator('#project-qa-status')).toHaveText('提交结果暂未确认，请先重新读取状态后再继续。');
    const pending=(await recovery(page)).pending;expect(pending?.kind).toBe('answer');expect(s.answers).toHaveLength(1);expect(s.reservations).toHaveLength(1);
    await expect(page.locator('#qa-start')).toBeDisabled();await page.locator('#project-qa-status').scrollIntoViewIfNeeded();
    await capture(page,'current-qa-submit-unknown',{pending,reservations:s.reservations.length});
    await page.locator('#qa-retry-pending').click();await expect.poll(()=>s.answers.length).toBe(2);expect(s.answers[1]).toEqual(s.answers[0]);
    await expect.poll(async()=>(await recovery(page)).pending).toBeUndefined();expect(s.reservations).toHaveLength(1);
  });
}
