import { taskPage } from './collection-fixtures';
import { expect, test, type Page, type Route } from '@playwright/test';
import { emptyUpdateDetails, reportingWindow, schemas } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Dto } from '../src/api';

// Real Chromium against synthetic, owner-aware HTTP. No model, database or Word acceptance.
const id = 'synthetic-conversation-project', now = '2026-09-29T12:00:00Z';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const reply = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

function fixture() {
  const project: Dto<'ProjectResponse'> = { project_id: id, name: '合成消息项目', issuer_name: '合成发行人', kind: 'update',
    market: 'sse', offering: 'private', draft_revision: 1, input_revision: null, input_hash: null, updated_at: now,
    update_details: { ...emptyUpdateDetails(), has_historical: true, reporting_cutoff: '2025-12-31' } };
  const materials: Dto<'MaterialResponse'>[] = ['historical', 'audit'].map((role, index) => ({
    material_id: `synthetic-${role}`, material_version: 1, upload_id: `synthetic-upload-${index}`,
    role: role as Dto<'MaterialResponse'>['role'], filename: `${role}.docx`,
    media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    byte_size: 1024, sha256: hash(role), state: 'persisted', persisted_at: now, error: null
  }));
  project.update_details!.source_prospectuses=[{material_id:materials[0].material_id,material_version:1,sha256:materials[0].sha256,
    issuer_name:'合成发行人',relation:'same_issuer',market:'sse',offering:'private',
    reporting_periods:reportingWindow('sse','private','2024-12-31'),status:'user_asserted'}];
  const messages: Dto<'ProjectMessage'>[] = [];
  const versions = new Map<string, Dto<'ProjectMessage'>>();
  const requests = new Map<string, { input: Dto<'ProjectMessageSaveRequest'>; response: Dto<'ProjectMessageSaveResponse'> }>();
  const state = {
    owner: 'owner-a' as string | null, project, materials, messages, versions, requests,
    saves: [] as Dto<'ProjectMessageSaveRequest'>[], inputs: [] as Dto<'InputRevisionCreateRequest'>[],
    snapshots: new Map<number, Dto<'InputRevisionResponse'>>(),
    executes: [] as Dto<'ExecuteRequest'>[], run: undefined as Dto<'RunResponse'> | undefined,
    createFailOnce: false, notePatchFailOnce: false, dropOnce: false, changedCursor: false, failRead: false, inputConflictOnce: false, pageCursors: [] as string[]
  };
  function ref() {
    const members = messages.map(m => ({ message_id: m.message_id, message_version: m.message_version,
      submission_id: m.submission_id, content_sha256: m.content_sha256 }));
    return { version: requests.size + 1, content_sha256: hash(JSON.stringify(members)), message_ids: messages.map(m => m.message_id).sort() };
  }
  function save(input: Dto<'ProjectMessageSaveRequest'>) {
    const previous = requests.get(input.submission_request_id);
    if (previous) {
      if (JSON.stringify(previous.input) !== JSON.stringify(input)) return { status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' } };
      return { status: 201, body: previous.response };
    }
    const index = messages.findIndex(m => m.message_id === input.message_id), old = messages[index];
    if (input.expected_message_version !== (old?.message_version ?? null))
      return { status: 409, body: { code: 'INPUT_REVISION_CONFLICT' } };
    const message: Dto<'ProjectMessage'> = {
      message_id: input.message_id, submission_id: `submission-${requests.size + 1}`, submission_version: requests.size + 1,
      message_version: (old?.message_version ?? 0) + 1, prompt_snapshot_ref: `snapshot-${requests.size + 1}`,
      revises_submission_id: old?.submission_id ?? null, content_sha256: hash(input.body), body: input.body,
      material_versions: input.material_versions, created_at: now, role: 'user', source_status: 'user_asserted',
      intent_status: 'not_classified', route: 'save_only'
    };
    if (index < 0) messages.push(message); else messages[index] = message;
    versions.set(`${message.message_id}:${message.message_version}`, message);
    const response: Dto<'ProjectMessageSaveResponse'> = { ...message, conversation_id: id, is_current: true,
      project_message_set_ref: { ...ref(), version: requests.size + 2 } };
    requests.set(input.submission_request_id, { input, response });
    return { status: 201, body: response };
  }
  return { state, ref, save };
}
async function setup(page: Page, fixtureState = fixture()) {
  const { state, ref, save } = fixtureState;
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/v1', '');
    const method = request.method();
    if (path === '/auth/logout') { state.owner = null; return route.fulfill({ status: 204 }); }
    if (path === '/auth/login') {
      state.owner = request.postDataJSON().username === 'second' ? 'owner-b' : 'owner-a';
      return reply(route, 200, { user_id: state.owner });
    }
    if (path === '/auth/recovery/info') return reply(route, 200, { enabled: false });
    if (path === '/m4/topics') return reply(route, 200, { topics: [] });
    if (path === '/me') return state.owner ? reply(route, 200, { user_id: state.owner, session_status: 'active' }) : reply(route, 401, { code: 'UNAUTHENTICATED' });
    if (!state.owner) return reply(route, 401, { code: 'UNAUTHENTICATED' });
    if(path===`/projects/${id}/tasks`)return reply(route,200,taskPage(id,state.run?[state.run]:[]));
    if(path===`/projects/${id}/prospectus-versions`)return reply(route,200,{project_id:id,selection_revision:0,current_version_id:null,versions:[],inactive_material_ids:[]});
    if (path === '/projects' && method === 'POST') {
      if (state.createFailOnce) { state.createFailOnce=false; return reply(route,503,{code:'DATA_UNAVAILABLE'}); }
      const input = request.postDataJSON() as Dto<'ProjectCreateRequest'>;
      expect(Value.Check(schemas.ProjectCreateRequest, input)).toBe(true);
      Object.assign(state.project, input);
      return reply(route, 201, state.project);
    }
    if (path === '/projects') return reply(route, 200, { items: state.owner === 'owner-a' ? [{
      ...state.project, latest_run: state.run ? { run_id: state.run.run_id, state: state.run.state, updated_at: now } : null
    }] : [], page: { next_cursor: null, has_more: false } });
    if (state.owner !== 'owner-a') return reply(route, 404, { code: 'NOT_FOUND' });
    if (path === `/projects/${id}`) {
      if (method==='PATCH'&&state.notePatchFailOnce) { state.notePatchFailOnce=false; return reply(route,503,{code:'DATA_UNAVAILABLE'}); }
      if (method === 'PATCH') Object.assign(state.project, request.postDataJSON(), { draft_revision: state.project.draft_revision + 1 });
      return reply(route, 200, state.project);
    }
    if (path === `/projects/${id}/messages` && method === 'GET') {
      if (state.failRead) return reply(route, 503, { code: 'DATA_UNAVAILABLE' });
      const cursor = url.searchParams.get('cursor'), first = cursor ? Number(cursor.split(':')[1]) : 0;
      state.pageCursors.push(cursor ?? 'first');
      if (cursor && (state.changedCursor || Number(cursor.split(':')[0]) !== ref().version))
        return reply(route, 409, { code: 'INPUT_REVISION_CONFLICT' });
      const limit = Number(url.searchParams.get('limit')), items = state.messages.slice(first, first + limit);
      const next = first + items.length < state.messages.length ? `${ref().version}:${first + items.length}` : null;
      return reply(route, 200, { conversation_id: id, items, project_message_set_ref: ref(), next_cursor: next, has_more: !!next });
    }
    const version = path.match(/^\/projects\/[^/]+\/messages\/([^/]+)\/versions\/(\d+)$/);
    if (version) {
      const saved = state.versions.get(`${decodeURIComponent(version[1])}:${version[2]}`);
      return reply(route, saved ? 200 : 404, saved ?? { code: 'NOT_FOUND' });
    }
    if (path === `/projects/${id}/messages` && method === 'POST') {
      const input = request.postDataJSON() as Dto<'ProjectMessageSaveRequest'>;
      expect(Value.Check(schemas.ProjectMessageSaveRequest, input)).toBe(true);
      state.saves.push(input);
      const result = save(input);
      if (state.dropOnce && result.status === 201) { state.dropOnce = false; return route.abort('connectionreset'); }
      return reply(route, result.status, result.body);
    }
    if (path === `/projects/${id}/events`) return reply(route, 200, { items: state.materials.map((m, i) => ({
      event_id: `event-${i}`, schema_version: 1, trace_id: 'synthetic', project_id: id, seq: i + 1, occurred_at: now,
      type: 'material.upload_progress', payload: { material_id: m.material_id }
    })), next_cursor: null });
    const material = state.materials.find(m => path === `/projects/${id}/materials/${m.material_id}`);
    if (material) return reply(route, 200, material);
    if (path.endsWith('/parse-job')) return reply(route, 404, { code: 'NOT_FOUND' });
    if (path.endsWith('/facts/candidates')) return reply(route, 200, { items: [], page: { next_cursor: null, has_more: false } });
    if (path === `/projects/${id}/input-revisions` && method === 'POST') {
      const input = request.postDataJSON() as Dto<'InputRevisionCreateRequest'>;
      expect(Value.Check(schemas.InputRevisionCreateRequest, input)).toBe(true);
      if (state.inputConflictOnce) {
        state.inputConflictOnce = false;
        save({ message_id: 'external-before-input-lock', submission_request_id: 'external-before-input-lock',
          expected_message_version: null, body: '另一页面新增的已保存消息', material_versions: [] });
        return reply(route, 409, { code: 'INPUT_REVISION_CONFLICT' });
      }
      if (JSON.stringify(input.project_message_set_ref) !== JSON.stringify(ref()) ||
          JSON.stringify(input.requirement_message_ids) !== JSON.stringify(ref().message_ids))
        return reply(route, 409, { code: 'INPUT_REVISION_CONFLICT' });
      state.inputs.push(input);
      const snapshot: Dto<'InputRevisionResponse'> = {
        project_id: id, input_revision: state.snapshots.size + 1, input_hash: hash(JSON.stringify(input)),
        material_versions: input.material_versions, target_confirmation: {
          status: 'unconfirmed', market: null, offering: null, document_purpose: null, as_of: null,
          target_reporting_periods: [], confirmed_by: null, confirmed_at: null
        }, rule_pack_version: null, template_version: null, reference_release: null, created_at: now
      };
      state.snapshots.set(snapshot.input_revision, snapshot); state.project.input_revision = snapshot.input_revision;
      state.project.input_hash = snapshot.input_hash;
      return reply(route, 201, snapshot);
    }
    const inputRead = path.match(/\/input-revisions\/(\d+)$/);
    if (inputRead) return reply(route, 200, state.snapshots.get(Number(inputRead[1])));
    if (path.endsWith('/preflight')) return reply(route, 200, {
      project_id: id, ...request.postDataJSON(), status: 'ready', missing_inputs: [], uncertainty: [], billing_mode: 'platform_trial'
    });
    if (path === '/runs/execute') {
      const input = request.postDataJSON() as Dto<'ExecuteRequest'>;
      state.executes.push(input);
      state.run = { run_id: `run-${state.executes.length}`, execution_request_id: input.execution_request_id, project_id: id,
        input_revision: input.input_revision, input_hash: input.input_hash, state: 'paused', stage: 'capability_not_ready',
        event_cursor: 0, channel: 'production', test_grant_id: null, uncovered_items: [],
        billing_mode: 'platform_trial', reservation_id: null, artifact_id: null, prompt_snapshot_ref: null, updated_at: now };
      return reply(route, 202, state.run);
    }
    if (path.startsWith('/runs/')) {
      if (path.endsWith('/events')) return reply(route, 200, { items: [], next_cursor: null });
      return reply(route, 200, state.run);
    }
    return reply(route, 404, { code: 'NOT_FOUND' });
  });
  await page.goto(`/#/projects/${id}`);
  await expect(page.locator('#conversation-status')).toBeEmpty();
  return fixtureState;
}
async function send(page: Page, text: string) {
  await page.getByLabel('补充募集书更新说明').fill(text);
  await page.locator('#send-project-message').click();
  await expect(page.locator('.cowork-message').filter({ hasText: text })).toBeVisible();
}

for (const [device, width, height] of [['desktop',1440,960],['mobile',390,844]] as const) {
  test(`required source information gates every uploaded file and survives reload - ${device}`, async ({ page }) => {
    await page.setViewportSize({width,height});
    const f=fixture();f.state.project.update_details!.source_prospectuses=[];
    f.state.materials.push({...f.state.materials[0],material_id:'synthetic-reference',role:'reference',filename:'reference.docx',sha256:hash('reference')});
    await setup(page,f);
    const button=page.locator('#execute-input');
    await expect(button).toBeDisabled();
    await expect(page.locator('#start-disabled-reason')).toContainText('共 2 份原稿待补充');
    const out=process.env.BB_REQUIRED_SOURCE_EVIDENCE_DIR??join(tmpdir(),'bb-required-source-evidence');await mkdir(out,{recursive:true});
    const first=page.locator('[data-source-material="synthetic-historical"]');
    await first.evaluate(el=>el.scrollIntoView({block:'start'}));
    await page.screenshot({path:join(out,`implementation-source-required-${device}.png`)});
    for (const [material,relation] of [['synthetic-historical','same_issuer'],['synthetic-reference','similar_business']] as const) {
      const source=page.locator(`[data-source-material="${material}"]`);
      await source.getByLabel('与目标发行人的关系',{exact:true}).selectOption(relation);
      await expect(button).toBeDisabled();
      await source.getByLabel('原发行市场',{exact:true}).selectOption('szse');
      await source.getByLabel('原品种',{exact:true}).selectOption('public_all');
      await source.getByLabel('原稿最新报告期年份',{exact:true}).selectOption('2024');
      await expect(button).toBeDisabled();
      await source.getByRole('radio',{name:'9月末',exact:true}).check();
      await expect(source.locator('[data-source-required-message]')).toHaveText('原稿信息已填写完整。');
    }
    await expect(button).toBeEnabled();
    await expect.poll(()=>f.state.project.update_details!.source_prospectuses!.length).toBe(2);
    await page.reload();await expect(button).toBeEnabled();
    expect(f.state.project.update_details!.source_prospectuses!.every(s=>s.reporting_periods.length===4)).toBe(true);
    expect(f.state.inputs).toHaveLength(0);expect(f.state.executes).toHaveLength(0);
    const source=page.locator('[data-source-material="synthetic-reference"]');
    await source.getByLabel('原发行市场',{exact:true}).selectOption('nafmii');
    await expect(button).toBeDisabled();await expect(source.getByLabel('原品种',{exact:true})).toHaveValue('');
    await source.getByLabel('原品种',{exact:true}).selectOption('ppn');await expect(button).toBeEnabled();
    // A replacement cannot reuse declarations for the prior bytes/version.
    f.state.materials[2]={...f.state.materials[2],material_version:2,sha256:hash('reference-v2')};
    await page.reload();await expect(button).toBeDisabled();
    expect(f.state.inputs).toHaveLength(0);expect(f.state.executes).toHaveLength(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  });
}

test('no uploaded prospectus requires no source fields and can start authoring', async ({page}) => {
  const f=fixture();f.state.materials.splice(0,1);f.state.project.update_details!.source_prospectuses=[];
  await setup(page,f);await expect(page.locator('[data-source-material]')).toHaveCount(0);
  await expect(page.locator('#execute-input')).toBeEnabled();await page.locator('#execute-input').click();
  await expect.poll(()=>f.state.executes.length).toBe(1);
});

test('unified source metadata is material-version-bound, survives reopening and never starts on save', async ({page}) => {
  const {state}=await setup(page);
  await expect(page.getByRole('heading',{name:'是否有本发行人的历史募集书？'})).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'募集书更新补充说明'})).toBeVisible();
  const source=page.locator('[data-source-material="synthetic-historical"]');
  await source.getByLabel('与目标发行人的关系',{exact:true}).selectOption('parent');
  await source.getByLabel('原发行市场',{exact:true}).selectOption('nafmii');
  await source.getByLabel('原品种',{exact:true}).selectOption('ppn');
  await source.getByLabel('原稿最新报告期年份',{exact:true}).selectOption('2024');
  await source.getByRole('radio',{name:'6月末',exact:true}).check();
  await source.getByLabel('与目标发行人的关系',{exact:true}).focus();
  await expect.poll(()=>state.project.update_details?.source_prospectuses?.[0]?.reporting_periods.length).toBe(3);
  expect(state.project.update_details!.source_prospectuses![0]).toMatchObject({material_id:'synthetic-historical',material_version:1,sha256:hash('historical'),relation:'parent',market:'nafmii',offering:'ppn'});
  expect(state.project.market).toBe('sse');expect(state.project.offering).toBe('private');expect(state.executes).toHaveLength(0);
  await page.reload();await expect(source.getByLabel('原发行人名称',{exact:true})).toHaveCount(0);
  await expect(source.getByLabel('原稿最新报告期年份',{exact:true})).toHaveValue('2024');
  await expect(source.getByRole('radio',{name:'6月末',exact:true})).toBeChecked();
  expect(state.project.update_details!.source_prospectuses![0].reporting_periods.map(p=>p.end)).toEqual(['2022-12-31','2023-12-31','2024-06-30']);
  await send(page,'合成补充：更新至2025年末。');expect(state.executes).toHaveLength(0);
  await mkdir('test-evidence/m1-unified',{recursive:true});
  await page.screenshot({path:'test-evidence/m1-unified/materials.png',fullPage:true});
});

test('save-only sends, exact edit history, lost-response idempotency and refresh/relogin', async ({ page }) => {
  const setupState = await setup(page);
  const { state } = setupState;
  state.dropOnce = true;
  await page.getByLabel('补充募集书更新说明').fill('用户授信原话：50亿元');
  await page.locator('#send-project-message').click();
  await expect(page.locator('#conversation-status')).toContainText('保存结果尚未确认');
  await expect(page.getByLabel('补充募集书更新说明')).toHaveValue('用户授信原话：50亿元');
  await page.getByLabel('补充募集书更新说明').fill('另一条尚未发送的内容');
  await expect(page.locator('#send-project-message')).toBeDisabled();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#restore-message-request').click();
  await expect(page.getByLabel('补充募集书更新说明')).toHaveValue('用户授信原话：50亿元');
  await page.locator('#send-project-message').click();
  await expect(page.locator('.cowork-message')).toContainText('用户授信原话：50亿元');
  expect(state.saves[0]).toEqual(state.saves[1]); expect(state.messages).toHaveLength(1);
  await page.locator('[data-edit-message]').click();
  await page.getByLabel('补充募集书更新说明').fill('用户修正：截至6月，已用30亿元');
  await page.locator('#send-project-message').click();
  await expect(page.locator('.cowork-message')).toContainText('用户修正：截至6月');
  expect(state.messages[0].message_version).toBe(2);
  expect(state.saves.at(-1)?.expected_message_version).toBe(1);
  await page.getByRole('button', { name: '查看旧版本' }).click();
  await expect(page.locator('.message-history')).toContainText('用户授信原话：50亿元');
  expect(state.executes).toHaveLength(0); expect(state.inputs).toHaveLength(0);
  await page.reload(); await expect(page.locator('.cowork-message')).toContainText('用户修正：截至6月');
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await page.getByLabel('用户名').fill('first'); await page.getByLabel('密码').fill('synthetic-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '任务进度与结果', exact: true })).toBeVisible();
  await page.goto(`/#/projects/${id}`);
  await expect(page.locator('.cowork-message')).toContainText('用户修正：截至6月');
  await expect(page.locator('.cowork-assistant')).toHaveCount(0);
  expect(state.executes).toHaveLength(0);
});

test('acknowledged save is not reported as pending when the following read fails', async ({ page }) => {
  const { state } = await setup(page);
  state.failRead = true;
  await page.getByLabel('补充募集书更新说明').fill('服务器已保存的用户消息');
  await page.locator('#send-project-message').click();
  await expect(page.locator('#conversation-status')).toContainText('补充要求已保存，但列表读取失败');
  await expect(page.getByLabel('补充募集书更新说明')).toHaveValue('');
  await expect(page.locator('#send-project-message')).toBeDisabled();
  expect(state.messages).toHaveLength(1);
  expect(state.saves).toHaveLength(1);
  state.failRead = false;
  await page.locator('#reload-project-messages').click();
  await expect(page.locator('.cowork-message')).toContainText('服务器已保存的用户消息');
  await expect(page.locator('#conversation-status')).toBeEmpty();
  expect(state.saves).toHaveLength(1);
});

test('input-lock conflict rereads every saved message before creating a fresh snapshot', async ({ page }) => {
  const f = await setup(page);
  await send(page, '锁定前已有消息');
  f.state.inputConflictOnce = true;
  await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('消息或项目版本已变化');
  await expect(page.locator('.cowork-message')).toHaveCount(2);
  expect(f.state.inputs).toHaveLength(0);
  expect(f.state.executes).toHaveLength(0);
  await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  expect(f.state.inputs).toHaveLength(1);
  expect(f.state.inputs[0].requirement_message_ids).toEqual(f.ref().message_ids);
  expect(f.state.inputs[0].project_message_set_ref).toEqual(f.ref());
});

test('legacy generation project upgrades to unified input while preserving messages and execution kind', async ({ page }) => {
  const f = fixture();
  f.state.project.kind = 'generation';
  f.state.project.update_details!.has_historical = false;
  f.state.materials[0] = { ...f.state.materials[0], material_id: 'synthetic-reference',
    role: 'reference', filename: 'reference.docx', sha256: hash('reference'),
    parse_snapshot_id: 'synthetic-reference-snapshot' };
  Object.assign(f.state.project.update_details!.source_prospectuses![0], {material_id:'synthetic-reference',sha256:hash('reference'),relation:'similar_business'});
  const { state } = await setup(page, f);
  await send(page, '生成新稿时保留的用户要求');
  await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  expect(state.inputs).toHaveLength(1);
  expect(state.executes).toHaveLength(1);
  expect(state.inputs[0].requirement_message_ids).toEqual(f.ref().message_ids);
  expect(state.inputs[0].project_message_set_ref).toEqual(f.ref());
  expect(state.inputs[0].user_reference).toBeUndefined();
  expect(state.inputs[0].material_versions).toContainEqual({material_id:'synthetic-reference',material_version:1});
  expect(state.project.update_details!.authoring_mode).toBe('unified_v1');
  expect(state.executes[0].task_kind).toBe('generation');
  await expect(page.locator('.cowork-assistant')).toHaveCount(0);
});

test('pagination pins all messages, new edit produces a new immutable input without changing active run', async ({ page }) => {
  const f = fixture();
  for (let n = 1; n <= 24; n++) f.save({ message_id: `synthetic-${n}`, submission_request_id: `request-${n}`,
    expected_message_version: null, body: `合成已保存消息 ${n}`, material_versions: [] });
  const { state } = await setup(page, f);
  await expect(page.locator('.cowork-message')).toHaveCount(20);
  await page.locator('#more-project-messages').click();
  await expect(page.locator('.cowork-message')).toHaveCount(24);
  await expect(page.locator('#execute-input')).toBeEnabled();
  await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  expect(state.inputs[0].requirement_message_ids).toHaveLength(24);
  expect(state.inputs[0].project_message_set_ref).toEqual(f.ref());
  const oldHash = state.snapshots.get(1)!.input_hash;
  await expect(page.locator('#project-conversation-root')).toBeHidden();
  await page.getByRole('button',{name:'查看材料'}).click();
  await expect(page.locator('#project-message')).toBeHidden();
  expect(state.run?.input_hash).toBe(oldHash);expect(state.executes).toHaveLength(1);
  state.run!.state = 'failed';
  await page.reload(); await expect(page.locator('#execution-progress .task-progress [role="status"]')).toHaveText('本轮未完成');
  await page.getByRole('button', { name: '继续修改' }).click();
  await page.getByLabel('补充募集书更新说明').fill('下一轮补充，不能改写旧输入');
  await page.locator('#send-project-message').click();
  await expect.poll(()=>state.messages.length).toBe(25);
  expect(state.snapshots.get(1)!.input_hash).toBe(oldHash);
  await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  expect(state.inputs).toHaveLength(2);
  expect(state.inputs[1].requirement_message_ids).toHaveLength(25);
  expect(state.inputs[1].project_message_set_ref).toEqual(f.ref());
  expect(state.snapshots.get(1)!.input_hash).toBe(oldHash);
});

test('stale edit and cursor reread without overriding; owner switch clears private messages', async ({ page }) => {
  const f = await setup(page);
  await send(page, '用户原话 A');
  await page.locator('[data-edit-message]').click();
  f.save({ message_id: f.state.messages[0].message_id, submission_request_id: 'external-edit',
    expected_message_version: 1, body: '另一页面已修改', material_versions: [] });
  await page.getByLabel('补充募集书更新说明').fill('本页不同的修改');
  await page.locator('#send-project-message').click();
  await expect(page.locator('#conversation-status')).toContainText('新版本');
  await expect(page.getByLabel('补充募集书更新说明')).toHaveValue('本页不同的修改');
  expect(f.state.messages[0].body).toBe('另一页面已修改');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('[data-edit-message]').click();
  await expect(page.getByLabel('补充募集书更新说明')).toHaveValue('另一页面已修改');
  for (let n = 1; n <= 21; n++) f.save({ message_id: `extra-${n}`, submission_request_id: `extra-${n}`,
    expected_message_version: null, body: `补充 ${n}`, material_versions: [] });
  await page.locator('#reload-project-messages').click();
  await expect(page.locator('#more-project-messages')).toBeVisible();
  f.state.changedCursor = true;
  await page.locator('#more-project-messages').click();
  await expect(f.state.pageCursors.filter(cursor => cursor === 'first').length).toBeGreaterThan(2);
  await expect(page.getByLabel('补充募集书更新说明')).toHaveValue('另一页面已修改');
  await page.locator('#cancel-message-edit').click();
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await page.getByLabel('用户名').fill('second'); await page.getByLabel('密码').fill('synthetic-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '任务进度与结果', exact: true })).toBeVisible();
  await page.goto(`/#/projects/${id}`);
  await expect(page.getByText('项目暂时无法打开')).toBeVisible();
  await expect(page.getByText('用户原话 A')).toHaveCount(0);
});

test('create and material conversation use the prototype desktop and mobile workspace', async ({ page }) => {
  await setup(page);
  const evidence = process.env.BB_UX_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  if(evidence){
    for(const [device,width,height] of [['desktop',1440,960],['mobile',390,844]] as const){
      await page.setViewportSize({width,height});
      await expect(page.locator('#execute-input')).toBeEnabled();
      await page.locator('#project-conversation-root').scrollIntoViewIfNeeded();
      await page.screenshot({path:join(evidence,`implementation-ready-${device}.png`)});
    }
  }
  const capture = async (name: string) => {
    await page.evaluate(() => { document.activeElement instanceof HTMLElement && document.activeElement.blur(); scrollTo(0, 0); });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    if (evidence) {
      await page.screenshot({ path: join(evidence, `bb18-implementation-${name}.png`), fullPage: true });
      await page.screenshot({ path: join(evidence, `implementation-${name}-viewport.png`) });
    }
  };
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/#update');
  await page.getByRole('link',{name:'＋ 新建项目并更新',exact:true}).click();
  await page.getByLabel('发行人全称').fill('合成发行人有限公司');
  await page.getByLabel('发行市场', { exact: true }).selectOption('sse');
  await page.getByLabel('发行方式', { exact: true }).selectOption('private');
  await page.getByLabel('最新报告期年份').selectOption('2026');
  await page.getByRole('radio',{name:'6月末',exact:true}).check();
  await expect(page.locator('#project-message')).toHaveCount(0);
  await capture('create');
  await page.setViewportSize({ width: 390, height: 844 }); await capture('create-mobile');
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole('button', { name: '创建项目，继续提供材料' }).click();
  await expect(page.locator('#conversation-status')).toBeEmpty();
  await expect(page.getByLabel('补充募集书更新说明')).toHaveValue('');
  if(evidence){
    for(const [device,width,height] of [['desktop',1440,960],['mobile',390,844]] as const){
      await page.setViewportSize({width,height});
      await page.locator('#project-conversation-root').scrollIntoViewIfNeeded();
      await page.screenshot({path:join(evidence,`implementation-empty-${device}.png`)});
    }
    await page.setViewportSize({width:1440,height:960});
  }
  await send(page,'合成补充：授信口径待核对。');
  expect(await page.locator('#project-conversation-root').evaluate(el=>!!el.closest('#project-materials-details'))).toBe(true);
  await capture('materials');
  if(evidence){await page.locator('#project-conversation-root').scrollIntoViewIfNeeded();await page.screenshot({path:join(evidence,'implementation-supplement.png')});}
  await page.setViewportSize({ width: 390, height: 844 }); await capture('materials-mobile');
  if(evidence){await page.locator('#project-conversation-root').scrollIntoViewIfNeeded();await page.screenshot({path:join(evidence,'implementation-supplement-mobile.png')});}
});


test('latest period derives source-independent windows; supplementary notes are saved on materials and editable after reload', async ({page}) => {
  const {state}=await setup(page);
  await page.goto('/#update');
  await page.getByRole('link',{name:'＋ 新建项目并更新',exact:true}).click();
  await page.getByLabel('发行人全称').fill('合成发行人有限公司');
  await page.getByLabel('发行市场',{exact:true}).selectOption('sse');
  await page.getByLabel('发行方式',{exact:true}).selectOption('private');
  await page.getByLabel('最新报告期年份').selectOption('2026');
  await page.getByRole('radio',{name:'6月末',exact:true}).check();
  await expect(page.locator('#reporting-window')).toHaveText('报告期：2024年、2025年、2026年1—6月');
  await expect(page.locator('.cowork-context,.cowork-prompts, input[type=date]')).toHaveCount(0);
  await expect(page.locator('#project-message')).toHaveCount(0);
  await page.getByRole('button',{name:'创建项目，继续提供材料'}).click();
  await send(page,'上传后补充要求：重点更新经营情况');
  expect(state.project.update_details?.target_reporting_periods?.map(p=>p.end)).toEqual(['2024-12-31','2025-12-31','2026-06-30']);
  expect(state.saves).toHaveLength(1); expect(state.executes).toHaveLength(0);
  await page.reload();
  await page.locator('[data-edit-message]').click();
  await page.getByLabel('补充募集书更新说明').fill('修改后要求：补充业务变化');
  await page.getByRole('button',{name:'保存补充说明',exact:true}).click();
  await expect(page.locator('.cowork-message')).toContainText('修改后要求：补充业务变化');
  await page.getByRole('button',{name:'编辑项目信息'}).click();
  await page.getByLabel('发行方式',{exact:true}).selectOption('public');
  await expect.poll(()=>state.project.update_details?.target_reporting_periods?.map(p=>p.end)).toEqual(['2023-12-31','2024-12-31','2025-12-31','2026-06-30']);
  await page.getByRole('radio',{name:'年末',exact:true}).check();
  await expect.poll(()=>state.project.update_details?.target_reporting_periods?.map(p=>p.end)).toEqual(['2024-12-31','2025-12-31','2026-12-31']);
  await page.reload();
  await expect(page.getByRole('radio',{name:'年末',exact:true})).toBeChecked();
  await expect(page.locator('#project-conversation-root')).toBeHidden();
  await page.getByRole('button',{name:'保存并继续'}).click();
  await expect(page.locator('.cowork-message')).toContainText('修改后要求：补充业务变化');
  expect(state.executes).toHaveLength(0);
});

test('unrelated edits preserve historical target metadata and original prospectus metadata',async({page})=>{
  const f=fixture();
  const old=[{start:'2024-01-01',end:'2024-12-31',period_kind:'annual' as const,scope:'parent' as const,status:'user_asserted' as const,evidence_refs:[]}];
  f.state.project.update_details!.target_reporting_periods=old;
  f.state.project.update_details!.source_prospectuses=[{material_id:'synthetic-historical',material_version:1,sha256:hash('historical'),issuer_name:'合成母公司',relation:'parent',market:'nafmii',offering:'ppn',reporting_periods:old,status:'user_asserted'}];
  await setup(page,f);await page.getByRole('button',{name:'编辑项目信息'}).click();
  await page.getByLabel('项目名称').fill('仅改名称');
  await expect.poll(()=>f.state.project.name).toBe('仅改名称');
  expect(f.state.project.update_details!.target_reporting_periods).toEqual(old);
  await page.getByRole('radio',{name:'9月末',exact:true}).check();
  await expect.poll(()=>f.state.project.update_details!.reporting_cutoff).toBe('2025-09-30');
  expect(f.state.project.update_details!.source_prospectuses![0].reporting_periods).toEqual(old);
  expect(f.state.project.update_details!.source_prospectuses![0].issuer_name).toBe('合成母公司');
  expect(f.state.executes).toHaveLength(0);
});


test('legacy initial-note save failure preserves content at the material footer for explicit retry',async({page})=>{
  const f=fixture();f.state.project.update_details!.supplementary_notes='旧项目已保存的补充说明';
  const {state}=await setup(page,f);
  await expect(page.locator('.cowork-initial')).toContainText('旧项目已保存的补充说明');
  await page.getByRole('button',{name:'修改创建时的补充说明'}).click();
  await page.getByLabel('补充募集书更新说明').fill('修改失败仍保留');state.notePatchFailOnce=true;
  await page.getByRole('button',{name:'保存补充说明',exact:true}).click();
  await expect(page.locator('#conversation-status')).toContainText('保存失败');
  await expect(page.getByLabel('补充募集书更新说明')).toHaveValue('修改失败仍保留');
  await page.getByRole('button',{name:'保存补充说明',exact:true}).click();
  await expect(page.locator('.cowork-initial')).toContainText('修改失败仍保留');
  expect(state.executes).toHaveLength(0);expect(state.saves).toHaveLength(0);
});

test('explicit start derives missing legacy target periods without changing a previously locked input',async({page})=>{
  const {state}=await setup(page);
  expect(state.project.update_details?.target_reporting_periods).toBeUndefined();
  await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  expect(state.project.update_details?.target_reporting_periods?.map(p=>p.end)).toEqual(['2024-12-31','2025-12-31']);
  expect(state.inputs).toHaveLength(1);expect(state.executes).toHaveLength(1);
  const snapshot=JSON.stringify(state.snapshots.get(1));
  await page.reload();
  expect(JSON.stringify(state.snapshots.get(1))).toBe(snapshot);
  expect(state.executes).toHaveLength(1);
});


test('source quarter controls stay independent and unrelated edits preserve actual nonstandard coverage',async({page})=>{
  const f=fixture();
  const old=[{start:'2023-04-01',end:'2024-03-30',period_kind:'annual' as const,scope:'parent' as const,status:'user_asserted' as const,evidence_refs:[]}];
  f.state.project.update_details!.source_prospectuses=[{material_id:'synthetic-historical',material_version:1,sha256:hash('historical'),issuer_name:'合成母公司',relation:'parent',market:'nafmii',offering:'ppn',reporting_periods:old,status:'user_asserted'}];
  f.state.materials.push({...f.state.materials[0],material_id:'synthetic-reference',role:'reference',filename:'reference.docx',sha256:hash('reference')});
  await setup(page,f);
  const source=page.locator('[data-source-material="synthetic-historical"]'), reference=page.locator('[data-source-material="synthetic-reference"]');
  await expect(source.getByText('已保留原稿的实际报告期',{exact:false})).toBeVisible();
  await source.getByLabel('与目标发行人的关系',{exact:true}).selectOption('subsidiary');await reference.getByLabel('与目标发行人的关系',{exact:true}).focus();
  await expect.poll(()=>f.state.project.update_details!.source_prospectuses![0].relation).toBe('subsidiary');
  expect(f.state.project.update_details!.source_prospectuses![0].reporting_periods).toEqual(old);
  expect(f.state.project.update_details!.source_prospectuses![0].issuer_name).toBe('合成母公司');
  await reference.getByLabel('原稿最新报告期年份').selectOption('2022');
  await page.getByRole('button',{name:'刷新已保存材料'}).click();
  await expect(reference.getByLabel('原稿最新报告期年份')).toHaveValue('2022');
  await reference.getByRole('radio',{name:'9月末',exact:true}).check();
  await reference.getByLabel('原发行市场',{exact:true}).selectOption('sse');
  await reference.getByLabel('原品种',{exact:true}).selectOption('public');
  await source.getByRole('radio',{name:'6月末',exact:true}).check();
  await reference.getByLabel('与目标发行人的关系',{exact:true}).focus();
  await expect.poll(()=>f.state.project.update_details!.source_prospectuses!.find(s=>s.material_id==='synthetic-reference')?.reporting_periods.map(p=>p.end)).toEqual(['2019-12-31','2020-12-31','2021-12-31','2022-09-30']);
  await page.reload();
  await expect(source.getByRole('radio',{name:'6月末',exact:true})).toBeChecked();
  await expect(reference.getByRole('radio',{name:'9月末',exact:true})).toBeChecked();
  expect(f.state.project.update_details!.source_prospectuses!.every(s=>s.reporting_periods.every(p=>p.status==='needs_confirmation'&&p.scope===null))).toBe(true);
  await expect(page.locator('input[type=date]')).toHaveCount(0);
});
