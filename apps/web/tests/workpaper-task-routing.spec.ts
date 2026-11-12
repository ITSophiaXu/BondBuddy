import {test,expect,type Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {WorkpaperAssessment,WorkpaperCatalogue,WorkpaperCheck} from '@bondbuddy/contracts';
import {fixture,ids,now,sha} from './generation-entry-fixtures';

async function setup(page:Page,operation='workpaper_assessment'){
  const original=await fixture(page),source=original.workspaces.get(ids.api)!.source!;
  const runId='requested-old-run';
  const assessment:WorkpaperAssessment={assessment_id:runId,state:'paused',source:{...source,filename:'本次检查旧版募集书.docx',sequence:1},created_at:now,
    request:{request_id:'original-request',catalogue_id:'old-catalogue',catalogue_sha256:sha,item_ids:['i1','i2'],source_version_id:source.version_id,source_selection_revision:source.selection_revision,requirements:'保留本次已确认范围'},
    completed_items:1,result_hash:null,decisions:[],warnings:[]};
  const catalogue:WorkpaperCatalogue={catalogue_id:'old-catalogue',filename:'合成底稿目录.xlsx',sha256:sha,created_at:now,warnings:[],entries:['i1','i2'].map((id,i)=>({id,code:`1.${i+1}`,title:`合成核查${i+1}`,folder:'1 尽职调查文件',kind:'file',sheet:'目录',row:i+2,instructions:'',path:`1.${i+1}.docx`}))};
  const check:WorkpaperCheck={run_id:runId,batch_id:'old-batch',state:'paused',source:{...source,sequence:2},baseline:{...source,sequence:1},stale:true,result:null,created_at:now};
  const calls:{path:string;method:string}[]=[];
  const state={assessment,check,missing:false,wrongProject:false,history:false,stage:'user_paused'};
  const task=()=>({run_id:runId,project_id:ids.api,kind:'generation',state:operation==='workpaper_check'?check.state:assessment.state,stage:state.stage,created_at:now,updated_at:now,artifact_id:null,report_id:null,topic_id:null,document_type:null,operation});
  const run=()=>({run_id:runId,project_id:state.wrongProject?ids.other:ids.api,state:task().state,stage:state.stage,input_revision:1,input_hash:sha,updated_at:now,channel:'production',artifact_id:null});
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/api/v1','');calls.push({path,method:request.method()});
    if(path==='/projects')return route.fulfill({json:{items:[{project_id:ids.api,name:'合成测试项目',kind:'generation',draft_revision:1,updated_at:now,file_count:2,task_summary:{active:0,attention:1,completed:0,total:1,latest:task(),recent_result:null}}],page:{has_more:false,next_cursor:null}}});
    if(path===`/projects/${ids.api}/tasks`){const older=url.searchParams.has('cursor');return route.fulfill({json:{project_id:ids.api,items:state.history&&!older?[{...task(),run_id:'newer-unrelated-run',state:'succeeded'}]:[task()],page:{has_more:state.history&&!older,next_cursor:state.history&&!older?'page2':null}}});}
    if(path===`/runs/${runId}/resume`){assessment.state='running';check.state='running';return route.fulfill({json:run()});}
    if(path===`/runs/${runId}`)return route.fulfill({json:run()});
    if(path==='/m4/topics')return route.fulfill({json:{topics:[]}});
    if(path===`/projects/${ids.api}/workpapers/assessments/${runId}`)return route.fulfill(state.missing?{status:404,json:{code:'NOT_FOUND'}}:{json:assessment});
    if(path===`/projects/${ids.api}/workpapers/catalogues/old-catalogue`)return route.fulfill({json:catalogue});
    if(path===`/projects/${ids.api}/workpapers/checks`)return route.fulfill({json:{checks:[{...check,run_id:'newer-check',state:'succeeded',baseline:{...source,sequence:99}},check]}});
    await route.fallback();
  });
  return {state,original,calls,task,runId,href:()=>`#generate?project=${ids.api}&step=workpapers&run=${runId}&operation=${operation}`};
}
for(const width of [1440,390])test(`all projects opens paused workpaper task ${width}, reload and resume preserve execution`,async({page})=>{
  const s=await setup(page);await page.setViewportSize({width,height:960});await page.goto('/#tasks');
  await page.locator(`[data-tasks="${ids.api}"]`).click();
  const row=page.locator(`[data-run-id="${s.runId}"]`);await expect(row).toContainText('检查可生成底稿');await row.getByRole('link',{name:/查看任务/}).click();
  await expect(page).toHaveURL(/#generate\?.*run=requested-old-run.*operation=workpaper_assessment/);
  const content=page.locator('#wp-task-content');await expect(content).toContainText('已暂停');await expect(content).toContainText('已检查 1 / 2 项');
  await expect(content).toContainText('本次检查旧版募集书');await expect(page.getByText('募集书全文更新',{exact:true})).toHaveCount(0);
  await expect(page.getByText('编制募集书',{exact:true})).toHaveCount(0);
  await page.reload();await expect(content).toContainText('保留本次已确认范围');expect(s.calls.filter(c=>c.method!=='GET')).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  const dir=test.info().outputPath('workpaper-task-routing');await mkdir(dir,{recursive:true});await page.screenshot({path:`${dir}/paused-${width}.png`,fullPage:true});
  await page.getByRole('button',{name:'继续检查',exact:true}).click();await expect(content).toContainText('处理中');
  expect(s.calls.filter(c=>c.method!=='GET')).toEqual([{path:`/runs/${s.runId}/resume`,method:'POST'}]);expect(s.original.errors).toEqual([]);
});
test('legacy prospectus URL resolves older workpaper execution across pagination and preserves return context',async({page})=>{
  const s=await setup(page);s.state.history=true;await page.goto(`/#/projects/${ids.api}?from=projects&run=${s.runId}&return_project=${ids.navigation}`);
  await expect(page).toHaveURL(/#generate\?.*run=requested-old-run.*return_project=generation-entry-navigation-N/);
  await expect(page.locator('#wp-task-content')).toContainText('已暂停');
  expect(s.calls.filter(c=>c.path.endsWith('/tasks'))).toHaveLength(2);expect(s.calls.filter(c=>c.method!=='GET')).toEqual([]);
});
test('completed assessment displays exact historical decisions; missing or cross-project run never falls back',async({page})=>{
  const s=await setup(page);s.state.assessment.state='succeeded';s.state.assessment.result_hash=sha;s.state.assessment.completed_items=2;
  s.state.assessment.decisions=[{item_id:'i1',status:'generate',reason:'披露完整',missing_materials:[],citations:[]},{item_id:'i2',status:'external_evidence',reason:'缺少实际查询记录',missing_materials:['查询记录'],citations:[]}];
  await page.goto('/'+s.href());await expect(page.locator('#wp-task-content')).toContainText('缺少实际查询记录');await expect(page.locator('.wp-table tbody tr')).toHaveCount(2);
  s.state.missing=true;await page.reload();await expect(page.locator('#wp-task-message')).toContainText('暂时无法读取');await expect(page.locator('#wp-task-content')).toBeEmpty();
  s.state.missing=false;s.state.wrongProject=true;await page.reload();await expect(page.locator('#wp-task-message')).toContainText('暂时无法读取');await expect(page.locator('#wp-task-content')).toBeEmpty();
  expect(s.calls.filter(c=>c.method!=='GET')).toEqual([]);
});
test('workpaper change check selects the original run rather than the newest check',async({page})=>{
  const s=await setup(page,'workpaper_check');await page.goto('/#tasks');await page.locator(`[data-tasks="${ids.api}"]`).click();
  await page.locator(`[data-run-id="${s.runId}"]`).getByRole('link').click();await expect(page.getByRole('heading',{name:'检查底稿更新影响'})).toBeVisible();
  const content=page.locator('#wp-task-content');await expect(content).toContainText('V1');await expect(content).toContainText('V2');await expect(content).not.toContainText('V99');await expect(content).toContainText('历史检查');
  await page.reload();await expect(content).toContainText('已暂停');expect(s.calls.filter(c=>c.method!=='GET')).toEqual([]);
});
for(const width of [1440,390])test(`task prototype companion ${width}`,async({page})=>{
  await page.setViewportSize({width,height:960});
  await page.goto('/@fs/'+resolve(process.cwd(),'../../product-prototype/public/workpaper-task.html').replaceAll('\\','/'));
  await expect(page.getByRole('heading',{name:'检查可生成底稿'})).toBeVisible();
  await expect(page.locator('#wp-task-content')).toContainText('已检查 1 / 2 项');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  const dir=test.info().outputPath('workpaper-task-routing');await mkdir(dir,{recursive:true});await page.screenshot({path:`${dir}/prototype-paused-${width}.png`,fullPage:true});
});
test('provider reconciliation stays on the same check and offers refresh without resubmission',async({page})=>{
  const s=await setup(page);s.state.stage='provider_reconcile';await page.goto('/'+s.href());
  await expect(page.locator('#wp-task-content')).toContainText('正在核对本次执行结果');
  await expect(page.getByRole('button',{name:'继续检查',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'刷新状态',exact:true}).click();await expect(page.locator('#wp-task-content')).toContainText('已检查 1 / 2 项');
  expect(s.calls.filter(c=>c.method!=='GET')).toEqual([]);
});
