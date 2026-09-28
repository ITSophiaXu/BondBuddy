import { expect, test, type Page } from '@playwright/test';
import { emptyUpdateDetails, schemas } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Dto } from '../src/api';

// Synthetic API state; the UI, routing, saves and layouts are real browser code.
async function setup(page: Page) {
  const projects: Dto<'ProjectResponse'>[] = [];
  const writes: unknown[] = [];
  const routes: string[] = [];
  await page.route('**/api/v1/**', async route => {
    const request=route.request(), url=new URL(request.url()), path=url.pathname.replace('/api/v1',''); routes.push(path);
    let body: unknown = {}, status=200;
    if(path==='/me') body={user_id:'synthetic-owner',session_status:'active'};
    else if(path==='/projects' && request.method()==='POST') {
      const input=request.postDataJSON(); expect(Value.Check(schemas.ProjectCreateRequest,input)).toBe(true); writes.push(input);
      const project: Dto<'ProjectResponse'>={...input,project_id:'synthetic-design-project',draft_revision:1,input_revision:null,input_hash:null,updated_at:'2026-09-28T00:00:00Z'};
      projects.push(project); body=project; status=201;
    } else if(path==='/projects') body={items:projects,page:{next_cursor:null,has_more:false}};
    else if(path==='/projects/synthetic-design-project') {
      if(request.method()==='PATCH') { const input=request.postDataJSON();writes.push(input);Object.assign(projects[0],input,{draft_revision:projects[0].draft_revision+1}); }
      body=projects[0];
    } else if(path.endsWith('/events')) body={items:[],next_cursor:null};
    else {status=404;body={code:'NOT_FOUND'};}
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('/#dashboard');
  return {projects,writes,routes};
}

test('prototype dashboard leads through creation to materials with persistent right-side requirements',async({page})=>{
  const errors: string[]=[]; page.on('pageerror',e=>errors.push(e.message));
  const state=await setup(page);
  await expect(page.getByRole('heading',{name:'工作台',exact:true})).toBeVisible();
  await expect(page.locator('.workflow-card')).toHaveCount(4);
  await expect(page.locator('.stats')).not.toContainText('0 份');
  await page.setViewportSize({width:1440,height:960});
  await page.evaluate(()=>{ document.activeElement instanceof HTMLElement && document.activeElement.blur(); scrollTo(0,0); });
  await page.screenshot({path:join(tmpdir(),'bb361-dashboard-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{ document.activeElement instanceof HTMLElement && document.activeElement.blur(); scrollTo(0,0); });
  await page.screenshot({path:join(tmpdir(),'bb361-dashboard-mobile.png'),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  await page.getByRole('button',{name:'打开菜单'}).click();
  await expect(page.getByRole('link',{name:'全部项目',exact:true}).first()).toBeVisible();
  await page.getByRole('link',{name:'更新募集书',exact:true}).click();
  await expect(page.getByRole('heading',{name:'更新募集说明书'})).toBeVisible();
  await page.setViewportSize({width:1440,height:960});
  await expect(page.locator('.step.current')).toContainText('创建项目');
  await page.getByLabel('项目名称').fill('合成设计验收 · 募集书更新');
  await page.getByLabel('发行人全称').fill('合成发行人有限公司');
  await page.locator('[name=has_historical][value=yes]').check();
  await page.getByLabel('发行市场',{exact:true}).selectOption('sse');
  await page.getByLabel('发行方式',{exact:true}).selectOption('private');
  await page.getByLabel('补充说明与写作要求').fill('补充授信证明后核对时点。');
  await page.evaluate(()=>{ document.activeElement instanceof HTMLElement && document.activeElement.blur(); scrollTo(0,0); });
  await page.screenshot({path:join(tmpdir(),'bb361-create-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'创建项目，继续提供材料'}).click();
  await expect(page.locator('.step.current')).toContainText('材料与要求');
  await expect(page.locator('#draft-form')).toBeHidden();
  await expect(page.getByRole('heading',{name:'提供项目材料'})).toBeVisible();
  await expect(page.getByLabel('补充说明与写作要求')).toHaveValue('补充授信证明后核对时点。');
  await page.getByLabel('补充说明与写作要求').fill('材料阶段也可保存下一轮说明。');
  await expect.poll(()=>state.projects[0]?.update_details?.supplementary_notes).toBe('材料阶段也可保存下一轮说明。');
  await page.reload(); await expect(page.locator('.step.current')).toContainText('材料与要求');
  await page.getByRole('button',{name:'编辑项目信息'}).click();
  await expect(page.getByLabel('发行人全称')).toHaveValue('合成发行人有限公司');
  await page.reload(); await expect(page.locator('.step.current')).toContainText('创建项目');
  await expect(page.getByLabel('发行人全称')).toHaveValue('合成发行人有限公司');
  await expect(page.getByRole('heading',{name:'参与机构'})).toBeVisible();
  await page.getByRole('button',{name:'保存并继续'}).click();
  await expect(page.locator('.project-cowork')).toBeVisible();
  expect(state.routes.some(path=>path.includes('/runs/execute'))).toBe(false);
  expect(await page.evaluate(()=>localStorage.length+sessionStorage.length)).toBe(0);
  expect(errors).toEqual([]);
});

test('unavailable modules retain original navigation but never create demo work',async({page})=>{
  const state=await setup(page);
  for(const route of ['review','generate','qa','billing']) {
    await page.goto(`/#${route}`); await expect(page.getByRole('heading',{name:'这项功能尚未开放'})).toBeVisible();
  }
  expect(state.writes).toEqual([]);
  await page.goto('/#tasks'); await expect(page.getByRole('heading',{name:'全部项目',exact:true})).toBeVisible();
  await page.goto('/'); await expect(page.getByRole('heading',{name:'工作台',exact:true})).toBeVisible();
});
