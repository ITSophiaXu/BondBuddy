import {test,expect,type Page} from '@playwright/test';
import type {Dto} from '../src/api';
import {answerId,assertFixture,checked,fixture,install,prepareId,projectId,workspaceReads,writes} from './project-qa-continuation-fixtures';
type ProjectTask=Dto<'ProjectTasksResponse'>['items'][number];

// Real project list and QA UI, synthetic public HTTP. Opening a task must stay
// read-only and select the requested execution even when newer answers exist.
async function setup(page:Page,operation:'prepare'|'answer',status:'paused'|'succeeded'){
  const state=fixture(),runId=operation==='prepare'?prepareId:answerId;
  const selected=state.workspace.runs.find(run=>run.run_id===runId)!;
  selected.state=status;
  if(status==='paused'){selected.stage='user_paused';selected.result=null;selected.artifact_id=null;selected.charged_points=0;selected.reserved_points=selected.manifest.points;}
  await install(page,state);
  await page.route(`**/api/v1/projects/${projectId}/tasks*`,async route=>{
    const request=route.request(),url=new URL(request.url());
    state.calls.push({method:request.method(),path:url.pathname.replace('/api/v1',''),search:url.search});
    expect(request.method()).toBe('GET');
    const body:Dto<'ProjectTasksResponse'>={project_id:projectId,items:state.workspace.runs.map(run=>({
      run_id:run.run_id,project_id:projectId,kind:'generation',operation:'qa_'+run.operation,state:run.state as ProjectTask['state'],stage:run.stage,
      created_at:run.created_at,updated_at:run.created_at,artifact_id:run.artifact_id,report_id:null,topic_id:null,document_type:null
    })),page:{has_more:false,next_cursor:null}};
    checked('ProjectTasksResponse',body);await route.fulfill({json:body});
  });
  await page.goto('/#tasks');await page.locator(`[data-tasks="${projectId}"]`).click();
  const row=page.locator(`[data-run-id="${runId}"]`);
  await expect(row).toContainText(operation==='prepare'?'识别问题清单':'项目问答');
  await row.getByRole('link',{name:status==='paused'?/查看任务/:/查看结果/}).click();
  return {state,runId};
}

test.afterEach(async({page})=>{await assertFixture(page);});

for(const operation of ['prepare','answer'] as const)for(const status of ['paused','succeeded'] as const){
  test(`all projects opens exact ${status} QA ${operation} and refresh stays read-only`,async({page})=>{
    const {state,runId}=await setup(page,operation,status);
    const original=structuredClone(state.workspace);
    for(let visit=0;visit<2;visit++){
      if(visit)await page.reload();
      await expect(page).toHaveURL(new RegExp(`#qa\\?project=${projectId}&run=${runId}$`));
      await expect(page.getByRole('heading',{name:'项目问答',exact:true})).toBeVisible();
      await expect(page.locator('#qa-history')).toHaveValue(operation==='answer'?runId:'');
      await expect(page.locator(`#qa-history option[value="${prepareId}"]`)).toHaveCount(0);
      if(operation==='prepare'&&status==='succeeded'){
        await expect(page.locator('.qa-prepared')).toContainText('候选问题');
        await expect(page.locator('#qa-download')).toHaveCount(0);
      }else{
        await expect(page.locator('.qa-run-head')).toContainText(operation==='prepare'?'识别问题清单':'回答问题');
        await expect(page.locator('.qa-run-head')).toContainText(status==='paused'?'等待恢复':'已完成');
      }
      await expect(page.getByText('募集书全文更新',{exact:true})).toHaveCount(0);
      expect(workspaceReads(state).every(call=>new URLSearchParams(call.search).get('run_id')===runId)).toBe(true);
      expect(writes(state)).toEqual([]);expect(state.workspace).toEqual(original);
    }
    expect(workspaceReads(state).length).toBeGreaterThanOrEqual(2);
  });
}

test('a missing selected QA history stays in QA and never opens another run or prospectus',async({page})=>{
  const {state,runId}=await setup(page,'answer','succeeded');
  await expect(page.locator('#qa-history')).toHaveValue(runId);
  state.omitRequestedRun=true;await page.reload();
  await expect(page.getByRole('heading',{name:'无法读取指定的问答版本'})).toBeVisible();
  await expect(page.getByText('募集书全文更新',{exact:true})).toHaveCount(0);
  await expect(page.locator('.qa-run-head')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#qa\\?project=${projectId}&run=${runId}$`));
  expect(writes(state)).toEqual([]);
});
