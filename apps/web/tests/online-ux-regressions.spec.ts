import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {fixture,install,projectId,prepareId,writes} from './project-qa-continuation-fixtures';

test('default QA entry retains active recognition and its exact run across navigation',async({page})=>{
  const state=fixture();const preparation=state.workspace.runs.find(r=>r.run_id===prepareId)!;
  preparation.state='queued';preparation.stage='queued';preparation.result=null;
  state.workspace.runs=[preparation];state.workspace.draft={preparation_id:null,questions:[],materials:[],requirements:'',use_knowledge:true};
  await install(page,state);const url=`/#qa?project=${projectId}`;
  const runHref=`#qa?project=${projectId}&run=${prepareId}&return_project=${projectId}`;
  const active=page.getByRole('region',{name:'进行中的问答任务',exact:true});
  const progress=active.getByRole('link',{name:'查看进度与操作',exact:true});
  const expectActivePreparation=async()=>{
    await expect(page.locator('.qa-page')).toHaveAttribute('data-view','preparation');
    // Preparation progress remains reachable without becoming an answer-history entry.
    await expect(page.locator('.qa-toolbar')).toHaveAttribute('hidden','');
    await expect(page.locator('#qa-history')).toBeHidden();
    await expect(page.locator('#qa-history option')).toHaveText(['准备下一轮']);
    await expect(page.locator('#qa-history option[value=""]')).toHaveText('准备下一轮');
    await expect(page.locator(`#qa-history option[value="${prepareId}"]`)).toHaveCount(0);
    await expect(active).toContainText('处理问题清单 · 排队中');
    await expect(progress).toBeVisible();await expect(progress).toHaveAttribute('href',runHref);
  };
  await page.goto(url);await expectActivePreparation();
  const runUrl=new URL(runHref,page.url()).href;
  await progress.click();await expect(page).toHaveURL(runUrl);
  await expect(page.locator('#qa-document-body')).toContainText('排队');
  await expect(page.locator('.qa-run-head').getByRole('heading',{name:'处理问题清单 · 排队中',exact:true})).toBeVisible();
  await expect(page.locator('#qa-history')).toBeHidden();
  await page.getByRole('link',{name:'任务进度与结果',exact:true}).click();
  await expect(page.getByRole('heading',{name:'任务进度与结果',exact:true})).toBeVisible();
  await page.goto(url);await expectActivePreparation();
  await page.reload();await expectActivePreparation();
  expect(writes(state)).toEqual([]);
});

for(const width of [1108,1440,390])test(`document QA keeps one global assistant and restores width at ${width}`,async({page})=>{
  const state=fixture();state.workspace.runs[0].state='queued';state.workspace.runs[0].result=null;await install(page,state);
  await page.setViewportSize({width,height:771});await page.goto(`/#qa?project=${projectId}`);
  const before=(await page.locator('.qa-page').boundingBox())!.width;
  await expect(page.locator('#qa-assistant,#qa-agent')).toHaveCount(0);
  await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();
  await expect(page.locator('#ba-panel')).toBeVisible();
  await expect(page.locator('.ba-embedded')).toHaveCount(0);
  await expect.poll(()=>state.calls.filter(c=>c.path.endsWith('/qa')).length,{timeout:10000}).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#ba-panel')).toBeVisible();
  await page.getByRole('button',{name:'收起助手',exact:true}).click();
  await expect(page.locator('#ba-panel')).toBeHidden();
  expect(Math.abs((await page.locator('.qa-page').boundingBox())!.width-before)).toBeLessThan(2);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  expect(await page.evaluate(()=>[document.documentElement,document.body].every(el=>getComputedStyle(el).overflowY!=='hidden'))).toBe(true);
  if(process.env.BB_UX_EVIDENCE_DIR){
    await mkdir(process.env.BB_UX_EVIDENCE_DIR,{recursive:true});
    await page.screenshot({path:`${process.env.BB_UX_EVIDENCE_DIR}/qa-integrated-${width}.png`,fullPage:true});
  }
  expect(writes(state)).toEqual([]);
});
