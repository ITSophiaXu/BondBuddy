import {test,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {artifactId,assertFixture,fixture,ids,install,mutations,runId,task} from './parallel-projects-fixtures';

test.afterEach(({page})=>assertFixture(page));
const row=(page:import('@playwright/test').Page,id:string)=>page.locator(`[data-project-id="${id}"]`);

test('returning to task progress reuses the loaded list until an explicit refresh',async({page})=>{
  const state=fixture();await install(page,state);await page.goto('/#tasks');
  await expect(row(page,ids.a)).toBeVisible();
  await row(page,ids.a).getByRole('button',{name:'查看进度'}).click();
  await expect(page.locator(`[data-task-panel="${ids.a}"] [data-run-id]`).first()).toBeVisible();
  const projectReads=state.projectReads.length,taskReads=state.taskReads.length;
  await page.evaluate(()=>{location.hash='#/new';});
  await expect(page.locator('#project-list')).toHaveCount(0);
  await page.evaluate(()=>{location.hash='#tasks';});
  await expect(row(page,ids.a)).toBeVisible();
  await expect(page.locator(`[data-task-panel="${ids.a}"] [data-run-id]`).first()).toBeVisible();
  expect(state.projectReads).toHaveLength(projectReads);
  expect(state.taskReads).toHaveLength(taskReads);
  await page.getByRole('button',{name:'刷新状态',exact:true}).click();
  await expect.poll(()=>state.projectReads.length).toBe(projectReads+1);
  await page.evaluate(()=>{location.hash='#/new';});
  await expect(page.locator('#project-list')).toHaveCount(0);
  await page.evaluate(()=>{window.dispatchEvent(new Event('bondbuddy:project-collection-changed'));location.hash='#tasks';});
  await expect.poll(()=>state.projectReads.length).toBe(projectReads+2);
  expect(mutations(state)).toEqual([]);
});

test('primary progress and exact result actions are available before expanding, with secondary tools in More',async({page})=>{
  const state=fixture();await install(page,state);await page.goto('/#tasks');
  const a=row(page,ids.a);
  await expect(a.getByRole('button',{name:'查看进度'})).toHaveClass(/primary/);
  await expect(a.getByRole('link',{name:'查看结果',exact:true})).toHaveAttribute('href',`#/artifacts/${artifactId('a',43)}`);
  await expect(a.getByRole('link',{name:'项目文件',exact:true})).toHaveCount(0);
  await expect(a.getByRole('link',{name:'检查文件一致性'})).toHaveCount(0);
  expect(state.taskReads).toHaveLength(0);
  await a.getByRole('button',{name:/更多操作/}).click();
  await expect(page.getByRole('menuitem',{name:'项目文件',exact:true})).toHaveAttribute('href',`#/projects/${ids.a}/files`);
  await expect(page.getByRole('menuitem',{name:'检查文件一致性'})).toHaveAttribute('href',`#consistency?project=${ids.a}`);
  await page.keyboard.press('Escape');await expect(a.getByRole('button',{name:/更多操作/})).toBeFocused();
  await a.getByRole('link',{name:'查看结果',exact:true}).click();
  await expect.poll(()=>state.artifactReads).toContain(artifactId('a',43));
  expect(mutations(state)).toEqual([]);
});

test('older results remain accessible after a page of recent failures, filtering and refresh retain the exact result',async({page})=>{
  const state=fixture();state.tasks.set(ids.b,[...Array.from({length:23},(_,i)=>task('b',25-i,'failed')),task('b',1)]);
  await install(page,state);await page.goto('/#tasks');
  await row(page,ids.b).getByRole('button',{name:'查看结果',exact:true}).click();
  const panel=page.locator(`[data-task-panel="${ids.b}"]`);
  await expect(panel.locator('[data-run-id]')).toHaveCount(1);
  await expect(panel.getByRole('link',{name:'查看结果',exact:true})).toHaveAttribute('href',`#/artifacts/${artifactId('b',1)}`);
  expect(state.taskReads.filter(r=>r.projectId===ids.b)).toHaveLength(2);
  await page.getByRole('button',{name:'刷新状态',exact:true}).click();
  await expect(panel.getByRole('button',{name:'已有结果'})).toHaveAttribute('aria-pressed','true');
  await expect(panel.locator('[data-run-id]')).toHaveCount(1);
  await panel.getByRole('button',{name:'全部任务',exact:true}).click();
  await expect(panel.locator('[data-run-id]')).toHaveCount(24);
  expect(mutations(state)).toEqual([]);
});

test('a result lookup failure keeps retry available and drafts never promise results',async({page})=>{
  const state=fixture();state.failTask=id=>id===ids.b;await install(page,state);await page.goto('/#tasks');
  await expect(row(page,ids.c).getByRole('button',{name:'暂无结果'})).toBeDisabled();
  await row(page,ids.b).getByRole('button',{name:'查看结果',exact:true}).click();
  const panel=page.locator(`[data-task-panel="${ids.b}"]`);
  await expect(panel.getByRole('alert')).toBeVisible();state.failTask=undefined;
  await panel.getByRole('button',{name:'重试',exact:true}).click();
  await expect(panel.getByRole('link',{name:'查看结果',exact:true})).toHaveAttribute('href',`#/artifacts/${artifactId('b',1)}`);
  expect(mutations(state)).toEqual([]);
});

for(const kind of ['update','review','generation','qa'] as const)test(`an empty ${kind} project continues the same kind of work`,async({page})=>{
  const state=fixture();state.projects.find(project=>project.project_id===ids.c)!.kind=kind;
  await install(page,state);await page.goto('/#tasks');
  await row(page,ids.c).getByRole('button',{name:'查看任务',exact:false}).click();
  const route=kind==='generation'?'generate':kind;
  await expect(page.locator(`[data-task-panel="${ids.c}"]`).getByRole('link',{name:'继续准备材料'})).toHaveAttribute('href',`#${route}?project=${ids.c}&from=projects`);
  expect(mutations(state)).toEqual([]);
});

test('completed, QA, review and partial batch results retain their original destinations',async({page})=>{
  const state=fixture();const finished=task('a',1);
  const cases=[
    {...finished,kind:'review' as const,operation:'full_review' as const,project_id:ids.aReview,report_id:'exact-report'},
    {...finished,kind:'generation' as const,operation:'qa_answer' as const},
    {...finished,kind:'generation' as const,state:'failed' as const,operation:'workpaper_batch' as const,workpaper_batch:{project_id:ids.a,batch_id:'exact-batch',total:248,completed:12}},
  ];
  const expected=[`#/projects/${ids.aReview}/review?from=projects&run=${finished.run_id}&tab=results&report_id=exact-report`,`#qa?project=${ids.a}&run=${finished.run_id}`,`#generate?from=projects&project=${ids.a}&step=workpapers&view=results&batch=exact-batch`];
  await install(page,state);
  for(let i=0;i<cases.length;i++){
    state.tasks.set(ids.a,[cases[i]]);await page.goto('/#tasks');await page.reload();
    const a=row(page,ids.a);await expect(a.getByRole('link',{name:'查看结果',exact:true})).toHaveAttribute('href',expected[i]);
    await expect(a.getByRole('link',{name:'查看结果',exact:true})).toHaveClass(/primary/);
  }
  expect(mutations(state)).toEqual([]);
});

test('task and result actions remain visible without overflow on desktop, tablet and mobile',async({page})=>{
  const state=fixture();state.bumpB();await install(page,state);await page.goto('/#tasks');
  const output=process.env.BB_UX_EVIDENCE_DIR;if(output)await mkdir(output,{recursive:true});
  for(const width of [1920,1440,1024,390,320]){
    await page.setViewportSize({width,height:width<500?844:960});
    const a=row(page,ids.a);await expect(a.getByRole('button',{name:'查看进度'})).toBeVisible();
    await expect(a.getByRole('link',{name:'查看结果',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    if(output&&[1440,390].includes(width))await page.screenshot({path:join(output,`tasks-results-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:960});await row(page,ids.a).getByRole('button',{name:'查看进度'}).click();
  await expect(page.locator(`[data-run-id="${runId('a',45)}"]`)).toBeVisible();
  if(output)await page.screenshot({path:join(output,'tasks-results-expanded.png'),fullPage:false});
  if(process.env.BB_EXPORT_TASK_RESULTS_PROTOTYPE==='1'){
    for(const id of [ids.b,ids.c]){await page.locator(`[data-tasks="${id}"]`).click();await expect(page.locator(`[data-task-sync="${id}"]`)).toContainText('任务上次同步');}
    for(const id of [ids.a,ids.b,ids.c])await page.locator(`[data-tasks="${id}"]`).click();
    const snapshot=await page.evaluate(()=>{
      const body=document.body.cloneNode(true) as HTMLElement;body.querySelectorAll('script').forEach(s=>s.remove());
      body.querySelectorAll('[data-collection-focus],[data-collection-anchor]').forEach(el=>{el.removeAttribute('data-collection-focus');el.removeAttribute('data-collection-anchor');});
      body.querySelectorAll('.brand img').forEach(el=>el.setAttribute('src','../../apps/web/public/favicon.svg'));
      return {body:body.innerHTML,styles:[...document.querySelectorAll('style[data-vite-dev-id]')].map(el=>el.getAttribute('data-vite-dev-id')!)};
    });
    const directory=resolve('../../product-prototype/public');
    const styles=snapshot.styles.map(path=>`<link rel="stylesheet" href="${relative(directory,path).replaceAll('\\','/')}">`).join('\n');
    await writeFile(join(directory,'task-results.html'),`<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BondBuddy · 任务进度与结果 · 合成设计预览</title>${styles}</head><body>${snapshot.body}<script type="module" src="./task-results-preview.js"></script></body></html>`);
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:width<500?844:960});
      await page.goto('/@fs/'+join(directory,'task-results.html').replaceAll('\\','/'));
      await expect(page.getByRole('heading',{name:'任务进度与结果',exact:true})).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
      if(output)await page.screenshot({path:join(output,`prototype-${width}.png`),fullPage:true});
    }
  }
  expect(mutations(state)).toEqual([]);
});
