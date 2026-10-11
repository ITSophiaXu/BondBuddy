import { expect, test, type Page } from '@playwright/test';
import { emptyUpdateDetails, schemas } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Dto } from '../src/api';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

// Synthetic API state; the UI, routing, saves and layouts are real browser code.
async function setup(page: Page, options: { beforeProjectRead?: () => Promise<void>; failProjectRead?: boolean } = {}) {
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
      if(request.method()==='GET') {
        await options.beforeProjectRead?.();
        if(options.failProjectRead) { await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'DATA_UNAVAILABLE'})});return; }
      }
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
  await expect(page.locator('.dashboard-start a')).toHaveCount(3);
  await page.setViewportSize({width:1440,height:960});
  await page.evaluate(()=>{ document.activeElement instanceof HTMLElement && document.activeElement.blur(); scrollTo(0,0); });
  await page.screenshot({path:join(tmpdir(),'bb361-dashboard-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{ document.activeElement instanceof HTMLElement && document.activeElement.blur(); scrollTo(0,0); });
  await page.screenshot({path:join(tmpdir(),'bb361-dashboard-mobile.png'),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  await page.getByRole('button',{name:'打开菜单'}).click();
  await expect(page.getByRole('link',{name:'全部项目',exact:true}).first()).toBeVisible();
  await page.getByRole('navigation',{name:'主导航'}).getByRole('link',{name:'更新募集书',exact:true}).click();
  await expect(page.getByRole('heading',{name:'更新募集说明书'})).toBeVisible();
  await page.setViewportSize({width:1440,height:960});
  await expect(page.locator('.step.current')).toContainText('创建项目');

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

test('creating an update keeps its navigation active while the project loads',async({page})=>{
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release=resolve; });
  await setup(page,{beforeProjectRead:()=>pending});
  await page.locator('.dashboard-start').getByRole('link',{name:'更新募集书',exact:true}).click();

  await page.getByLabel('发行人全称').fill('合成发行人有限公司');
  await page.getByRole('button',{name:'创建项目，继续提供材料'}).click();
  await expect(page.getByRole('status').filter({hasText:'正在读取项目'})).toBeVisible();
  await expect(page.locator('.nav-item.active')).toHaveText('更新募集书');
  release();
  await expect(page.getByRole('heading',{name:'提供项目材料'})).toBeVisible();
  await expect(page.locator('.nav-item.active')).toHaveText('更新募集书');
});

for (const width of [1440, 390]) {
  test(`project guidance stays visible through typing, funding changes and saved draft reload (${width}px)`, async ({page}) => {
    await page.setViewportSize({width, height: 960});
    const state = await setup(page);
    await page.goto('/#update');
    const form = page.locator('#create-form');
    await expect(form.locator('.field-note')).toHaveCount(9);
    await expect(form.locator('input[placeholder], textarea[placeholder]')).toHaveCount(0);
    await expect(page.locator('#underwriting-note')).toContainText('受托管理人、存续期管理人');
    await expect(page.locator('#other_agencies-note')).toHaveText('如律师事务所等。');
    const originalNotes = await form.locator('.field-note').allTextContents();
    const fields: Record<string, string> = {
      issuer: '合成发行人有限公司', registration_amount: '20', issuance_amount: '10',
      bond_terms: '3年期，分两个品种', underwriting: '合成证券担任主承销商', other_agencies: '合成律师事务所',
      rating_enhancement: '主体评级AA+', other_information: '合成授信资料待补充'
    };
    for (const [id, value] of Object.entries(fields)) {
      const control = page.locator(`#${id}`);
      await control.fill(value);
      await expect(control).toHaveAccessibleDescription(await page.locator(`#${id}-note`).innerText());
      await expect(page.locator(`#${id}-note`)).toBeVisible();
    }
    expect(await form.locator('.field-note').allTextContents()).toEqual(originalNotes);
    await page.getByRole('button', {name:'＋ 添加资金用途'}).click();
    await page.locator('#purpose_0').selectOption('refinance_bonds');
    await expect(page.locator('#purpose_0-note')).toHaveText('可提供拟偿还债券简称、余额、到期日及兑付安排。');
    await page.getByRole('button', {name:'＋ 添加资金用途'}).click();
    await page.locator('#purpose_1').selectOption('repay_debt');
    await page.locator('#use_amount_1').fill('1.5');
    await page.locator('#use_target_1').fill('合成贷款');
    await page.locator('#use_details_1').fill('按到期计划偿还');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-remove-purpose="0"]').click();
    await expect(page.locator('#use_amount_0')).toHaveValue('1.5');
    await expect(page.locator('#purpose_0')).toHaveAccessibleDescription('可提供债务明细、余额和拟偿还金额。');
    for (const id of ['use_amount_0', 'use_target_0', 'use_details_0']) {
      await expect(page.locator(`#${id}-note`)).toBeVisible();
      await expect(page.locator(`#${id}`)).toHaveAccessibleDescription(await page.locator(`#${id}-note`).innerText());
    }
    await expect(form.locator('.field-note')).toHaveCount(12);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); scrollTo(0, 0); });
    await page.screenshot({path:join(tmpdir(), `bb-project-notes-${width}-filled.png`), fullPage:true});
    await page.getByRole('button', {name:'创建项目，继续提供材料'}).click();
    await expect(page.getByRole('heading', {name:'提供项目材料'})).toBeVisible();
    expect(state.projects[0].name).toBe(`${fields.issuer}-募集书更新`);
    expect(state.projects[0].update_details?.underwriting).toBe(fields.underwriting);
    expect(state.projects[0].update_details?.funding_uses[0].amount?.value).toBe('1.5');
    expect(JSON.stringify(state.writes)).not.toContain('沿用历史募集说明书内容');
    await page.getByRole('button', {name:'编辑项目信息'}).click();
    await page.reload();
    await expect(page.locator('#underwriting')).toHaveValue(fields.underwriting);
    await expect(page.locator('#draft-form .field-note')).toHaveCount(12);
    await expect(page.locator('#underwriting-note')).toBeVisible();
    await expect(page.locator('#use_amount_0-note')).toBeVisible();
    expect(await page.evaluate(() => {
      const ids = [...document.querySelectorAll('#draft-form [id]')].map(e => e.id);
      return new Set(ids).size === ids.length;
    })).toBe(true);
    expect(state.routes.some(path => path.includes('/runs/execute'))).toBe(false);
  });
}

for (const [suffix, active] of [['','更新募集书'],['?from=projects','全部项目'],['?from=dashboard&dashboard_kind=update&dashboard_status=active','工作台']]) {
  test(`project loading and error preserve the entry navigation: ${active}`,async({page})=>{
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release=resolve; });
    await setup(page,{beforeProjectRead:()=>pending,failProjectRead:true});
    await page.goto(`/#/projects/synthetic-design-project${suffix}`);
    await expect(page.getByRole('status').filter({hasText:'正在读取项目'})).toBeVisible();
    await expect(page.locator('.nav-item.active')).toHaveText(active);
    release();
    await expect(page.getByRole('heading',{name:'项目暂时无法打开'})).toBeVisible();
    await expect(page.locator('.nav-item.active')).toHaveText(active);
  });
}

test('material workspace respects unavailable server resources without creating demo work',async({page})=>{
  const state=await setup(page);
  await page.goto('/#generate');
  await expect(page.getByRole('heading',{name:'材料生成',exact:true})).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('无法访问这个项目');
  await expect(page.getByRole('button',{name:'重新读取',exact:true})).toBeVisible();
  await page.goto('/#review'); await expect(page.locator('#review-create-form')).toBeVisible();
  expect(state.writes).toEqual([]);
  expect(state.routes.some(path=>path.includes('/runs/execute'))).toBe(false);
  await page.goto('/#tasks'); await expect(page.getByRole('heading',{name:'全部项目',exact:true})).toBeVisible();
  await page.goto('/'); await expect(page.getByRole('heading',{name:'工作台',exact:true})).toBeVisible();
});

for (const width of [1440, 390]) {
  test(`automatic project name saves and restores without manual naming (${width}px)`, async ({page}) => {
    const state = await setup(page);
    await page.setViewportSize({width, height: width === 1440 ? 960 : 844});
    await page.goto('/#update');
    const form = page.locator('#create-form');
    await expect(form.locator('h2').first()).toHaveText('项目基本信息 必填');
    await expect(form.locator('input[name=name]')).toHaveCount(0);
    const preview = page.locator('#generated-project-name');
    await expect(preview).toHaveText('填写发行人后自动生成');
    await page.getByLabel('发行人全称').fill('   ');
    await page.getByRole('button',{name:'创建项目，继续提供材料'}).click();
    await expect(page.locator('#page-error')).toHaveText('请填写发行人全称。');
    expect(state.writes).toHaveLength(0);
    await page.getByLabel('发行人全称').fill('  合成发行人有限公司  ');
    await expect(preview).toHaveText('合成发行人有限公司-募集书更新');
    await page.getByLabel('发行市场',{exact:true}).selectOption('nafmii');
    await page.getByLabel('发行方式',{exact:true}).selectOption('dfi');
    await expect(preview).toHaveText('合成发行人有限公司-交易商协会-DFI · 储架发行-募集书更新');
    await page.getByLabel('发行市场',{exact:true}).selectOption('sse');
    await expect(page.getByLabel('发行方式',{exact:true})).toHaveValue('');
    await expect(preview).toHaveText('合成发行人有限公司-上交所-募集书更新');
    await page.getByLabel('发行方式',{exact:true}).selectOption('private');
    await expect(preview).toHaveText('合成发行人有限公司-上交所-普通私募公司债-募集书更新');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if(process.env.BB_NAME_EVIDENCE){
      const dir='test-evidence/project-auto-name-20261011';await mkdir(dir,{recursive:true});
      await page.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();scrollTo(0,0);});
      await page.screenshot({path:`${dir}/implementation-${width}.png`});
    }
    const generated = await preview.textContent();
    await page.getByRole('button',{name:'创建项目，继续提供材料'}).click();
    await expect(page.getByRole('heading',{name:'提供项目材料'})).toBeVisible();
    expect(state.projects[0].name).toBe(generated);
    expect(state.projects[0].issuer_name).toBe('合成发行人有限公司');
    await page.getByRole('button',{name:'编辑项目信息'}).click();
    await page.reload();
    await expect(page.getByLabel('项目名称',{exact:true})).toHaveValue(generated!);
    await page.getByLabel('项目名称',{exact:true}).fill('原有自定义名称');
    await expect.poll(()=>state.projects[0].name).toBe('原有自定义名称');
    await page.reload();
    await page.getByLabel('发行人全称').fill('已调整发行人有限公司');
    await expect.poll(()=>state.projects[0].issuer_name).toBe('已调整发行人有限公司');
    expect(state.projects[0].name).toBe('原有自定义名称');
    expect(state.routes.some(path=>path.includes('/runs/execute'))).toBe(false);
  });
}

test('issuer alone and a long Unicode issuer can create projects within the public name limit',async({page})=>{
  const state=await setup(page);
  await page.goto('/#update');
  const issuer='合成𠮷'.repeat(45);
  await page.getByLabel('发行人全称').fill(issuer);
  const name=await page.locator('#generated-project-name').textContent();
  expect(name!.length).toBeLessThanOrEqual(120);
  expect(name).toMatch(/-募集书更新$/);
  await page.getByRole('button',{name:'创建项目，继续提供材料'}).click();
  await expect(page.getByRole('heading',{name:'提供项目材料'})).toBeVisible();
  expect(state.projects[0].name).toBe(name);
  expect(state.projects[0].issuer_name).toBe(issuer);
  expect(state.projects[0].market).toBeNull();
  expect(state.projects[0].offering).toBeNull();
});
