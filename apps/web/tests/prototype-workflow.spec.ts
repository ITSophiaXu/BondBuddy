import { expect, test, type Page } from '@playwright/test';
import { emptyUpdateDetails, schemas } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Dto } from '../src/api';
import { createHash } from 'node:crypto';

// Synthetic API state; the UI, routing, saves and layouts are real browser code.
async function setup(page: Page) {
  const projects: Dto<'ProjectResponse'>[] = [];
  const messages: Dto<'ProjectMessage'>[] = [];
  const messageRef = () => ({ version: messages.length + 1, content_sha256: createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
    message_ids: messages.map(m => m.message_id).sort() });
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
    } else if(path==='/projects/synthetic-design-project/messages' && request.method()==='GET') {
      body={conversation_id:'synthetic-design-project',items:messages,project_message_set_ref:messageRef(),next_cursor:null,has_more:false};
    } else if(path==='/projects/synthetic-design-project/messages' && request.method()==='POST') {
      const input=request.postDataJSON() as Dto<'ProjectMessageSaveRequest'>;
      expect(Value.Check(schemas.ProjectMessageSaveRequest,input)).toBe(true);
      const message: Dto<'ProjectMessage'>={message_id:input.message_id,submission_id:input.submission_request_id,submission_version:1,
        message_version:1,prompt_snapshot_ref:'synthetic-prompt',revises_submission_id:null,
        content_sha256:createHash('sha256').update(input.body).digest('hex'),body:input.body,material_versions:[],created_at:'2026-09-28T00:00:00Z',
        role:'user',source_status:'user_asserted',intent_status:'not_classified',route:'save_only'};
      messages.push(message);body={...message,conversation_id:'synthetic-design-project',is_current:true,project_message_set_ref:messageRef()};status=201;
    } else if(path.endsWith('/events')) body={items:[],next_cursor:null};
    else {status=404;body={code:'NOT_FOUND'};}
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('/#dashboard');
  return {projects,writes,routes,messages};
}

test('prototype dashboard leads through creation to materials with persistent material-footer requirements',async({page})=>{
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
  await expect(page.locator('[name=has_historical]')).toHaveCount(0);
  await page.getByLabel('发行市场',{exact:true}).selectOption('sse');
  await page.getByLabel('发行方式',{exact:true}).selectOption('private');
  await expect(page.getByLabel('补充募集书更新说明')).toHaveCount(0);
  await page.evaluate(()=>{ document.activeElement instanceof HTMLElement && document.activeElement.blur(); scrollTo(0,0); });
  await page.screenshot({path:join(tmpdir(),'bb361-create-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'创建项目，继续提供材料'}).click();
  await expect(page.locator('.step.current')).toContainText('材料与要求');
  await expect(page.locator('#draft-form')).toBeHidden();
  await expect(page.getByRole('heading',{name:'提供项目材料'})).toBeVisible();
  await page.getByLabel('补充募集书更新说明').fill('补充授信证明后核对时点。');
  await page.locator('#send-project-message').click();
  await expect(page.locator('.cowork-message')).toContainText('补充授信证明后核对时点。');
  await page.getByLabel('补充募集书更新说明').fill('材料阶段也可保存下一轮说明。');
  await page.locator('#send-project-message').click();
  await expect.poll(()=>state.messages.map(m=>m.body)).toEqual(['补充授信证明后核对时点。','材料阶段也可保存下一轮说明。']);
  await page.reload(); await expect(page.locator('.step.current')).toContainText('材料与要求');
  await expect(page.locator('.cowork-message')).toHaveCount(2);
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
  for(const route of ['generate','qa','billing']) {
    await page.goto(`/#${route}`); await expect(page.getByRole('heading',{name:'这项功能尚未开放'})).toBeVisible();
  }
  await page.goto('/#review'); await expect(page.getByRole('heading',{name:'准备复核项目'})).toBeVisible();
  expect(state.writes).toEqual([]);
  await page.goto('/#tasks'); await expect(page.getByRole('heading',{name:'全部项目',exact:true})).toBeVisible();
  await page.goto('/'); await expect(page.getByRole('heading',{name:'工作台',exact:true})).toBeVisible();
});
