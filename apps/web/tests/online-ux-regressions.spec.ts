import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {fixture,install,projectId,prepareId,now,writes} from './project-qa-continuation-fixtures';

test('default QA entry retains active recognition and its exact run across navigation',async({page})=>{
  const state=fixture();const preparation=state.workspace.runs.find(r=>r.run_id===prepareId)!;
  preparation.state='queued';preparation.stage='queued';preparation.result=null;
  state.workspace.runs=[preparation];state.workspace.draft={preparation_id:null,questions:[],materials:[],requirements:'',use_knowledge:true};
  await install(page,state);const url=`/#qa?project=${projectId}`;
  await page.goto(url);await expect(page.getByRole('region',{name:'进行中的问答任务'})).toContainText('识别 Word 问题清单');
  await expect(page.locator('#qa-history option')).toHaveCount(2);
  await page.getByRole('link',{name:'查看进度与操作'}).click();await expect(page).toHaveURL(new RegExp('run='+prepareId));
  await expect(page.locator('#qa-document-body')).toContainText('排队');
  await page.goto('/#projects');await page.goto(url);await page.reload();
  await expect(page.getByRole('link',{name:'查看进度与操作'})).toBeVisible();expect(writes(state)).toEqual([]);
});

for(const width of [1108,1440,390])test(`embedded QA assistant retains readable width and collapses cleanly at ${width}`,async({page})=>{
  const state=fixture();state.workspace.runs[0].state='queued';state.workspace.runs[0].result=null;await install(page,state);
  const topic={topic_id:'embedded-topic',project_id:'scope',source_project_id:projectId,name:'合成项目 · BondBuddy',surface:'assistant',created_at:now,updated_at:now};
  const workspace={topic,project:{project_id:'scope',kind:'qa',name:'BondBuddy',draft_revision:1},materials:[],material_details:[],drafts:{},templates:[],messages:[{message_id:'m',role:'user',version:1,content:'请根据合成材料说明本期偿债资金安排。',created_at:now,reply_status:'queued',run_id:null,reply:null,error:null}],tasks:[],artifacts:[],pending_requirements:[],active_run:null,
    view:{version:0,selected_document_type:null,open_tabs:[],active_tab:null,unsent_content:'',unsent_context:{document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:null},assistant:{project_id:null,action:null}}};
  await page.route('**/api/v1/m4/topics',route=>route.fulfill({json:{topics:[topic]}}));
  await page.route('**/api/v1/m4/topics/embedded-topic/workspace',route=>route.fulfill({json:workspace}));
  await page.route('**/api/v1/assistant/topics/embedded-topic/cards',route=>route.fulfill({json:{cards:[]}}));
  await page.setViewportSize({width,height:771});await page.goto(`/#qa?project=${projectId}`);
  const before=(await page.locator('.qa-page').boundingBox())!.width;
  await page.locator('#qa-assistant summary').click();await expect(page.locator('#qa-agent .ba-text')).toBeVisible();
  expect((await page.locator('.qa-page').boundingBox())!.width).toBeGreaterThanOrEqual(before-1);
  expect((await page.locator('#qa-agent .bb-assistant').boundingBox())!.width).toBeGreaterThan(width===390?250:300);
  expect((await page.locator('#qa-agent .ba-text').boundingBox())!.width).toBeGreaterThan(150);
  await expect.poll(()=>page.locator('#qa-agent .bb-assistant').count()).toBe(1);
  // A workspace refresh must keep the assistant embedded; old details toggle events must not detach it.
  await expect.poll(()=>state.calls.filter(c=>c.path.endsWith('/qa')).length,{timeout:10000}).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#qa-agent .ba-text')).toBeVisible();
  await expect(page.locator('#qa-assistant')).toHaveAttribute('open','');
  if(width===390)expect(await page.evaluate(()=>[document.documentElement,document.body].every(el=>getComputedStyle(el).overflowY!=='hidden'))).toBe(true);
  if(process.env.BB_UX_EVIDENCE_DIR){
    await mkdir(process.env.BB_UX_EVIDENCE_DIR,{recursive:true});
    await page.screenshot({path:`${process.env.BB_UX_EVIDENCE_DIR}/qa-embedded-${width}.png`,fullPage:true});
    if(width===1440){
      await page.setViewportSize({width:1265,height:712});await page.evaluate(()=>window.scrollTo(0,0));
      await page.screenshot({path:`${process.env.BB_UX_EVIDENCE_DIR}/qa-implementation-1265.png`});
      await page.setViewportSize({width,height:771});
    }
  }
  await page.locator('#qa-assistant summary').click();await expect(page.locator('.ba-embedded')).toHaveCount(0);
  await expect(page.locator('.bb-assistant')).toBeHidden();
  expect(Math.abs((await page.locator('.qa-page').boundingBox())!.width-before)).toBeLessThan(2);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
