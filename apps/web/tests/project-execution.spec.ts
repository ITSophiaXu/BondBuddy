import { expect, test, type Page, type Route } from '@playwright/test';
import { emptyUpdateDetails, schemas } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';
import { createHash } from 'node:crypto';
import type { Dto } from '../src/api';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Synthetic HTTP boundary tests in real Chromium; no actual API/PG/model/Word acceptance.
const now = '2026-09-27T12:00:00Z';
const id = 'synthetic-execution-project';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const periods: NonNullable<Dto<'InputRevisionCreateRequest'>['target_confirmation']>['target_reporting_periods'] = [{ start: '2025-01-01', end: '2025-12-31', period_kind: 'annual', scope: 'consolidated', status: 'user_asserted', evidence_refs: [] }];
function fixture() {
  const project: Dto<'ProjectResponse'> = { project_id: id, name: '合成任务项目', issuer_name: '合成发行人', kind: 'update',
    market: 'sse', offering: 'private', draft_revision: 2, input_revision: null, input_hash: null, updated_at: now,
    update_details: { ...emptyUpdateDetails(), has_historical: true, reporting_cutoff: '2025-12-31', target_reporting_periods: structuredClone(periods) } };
  const materials: Dto<'MaterialResponse'>[] = ['history', 'audit'].map((name, i) => ({ material_id: `synthetic-${name}`, material_version: 1,
    upload_id: `synthetic-upload-${i}`, role: i === 0 ? 'historical' : 'audit', filename: `${name}.docx`,
    media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', byte_size: 1024, sha256: hash(name), state: 'persisted', persisted_at: now, error: null }));
  return { project, materials, inputs: [] as Dto<'InputRevisionCreateRequest'>[], snapshots: new Map<number, Dto<'InputRevisionResponse'>>(),
    executes: [] as Dto<'ExecuteRequest'>[], runs: new Map<string, Dto<'RunResponse'>>(), preflights: [] as Dto<'PreflightRequest'>[],
    loggedOut: false, dropSave: false, dropExecute: false, conflictSave: false, holdExecute: false, holdCheck: false,
    releaseExecute: undefined as (() => void) | undefined, releaseCheck: undefined as (() => void) | undefined,
    listPages: [] as string[], eventPages: [] as string[], paginate: false, lateRunForeign: false,
    checkStatus: 'blocked' as Dto<'PreflightResponse'>['status'], reason: 'rule_pack:rule_applicability_overall_review_required' };
}
async function setup(page: Page, state = fixture()) {
  await page.context().route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/v1', '');
    const method = request.method();
    if (path === '/auth/logout') { state.loggedOut = true; return route.fulfill({ status: 204 }); }
    if (state.loggedOut) return json(route, 401, { code: 'UNAUTHENTICATED' });
    if (path === '/me') return json(route, 200, { user_id: 'synthetic-owner', session_status: 'active' });
    if (path === `/projects/${id}`) {
      if (method === 'PATCH') Object.assign(state.project, request.postDataJSON(), { draft_revision: state.project.draft_revision + 1 });
      return json(route, 200, state.project);
    }
    if (path === '/projects') {
      state.listPages.push(url.searchParams.get('cursor') ?? 'first');
      const lastRun = [...state.runs.values()].at(-1);
      const skip = state.paginate && !url.searchParams.has('cursor');
      return json(route, 200, { items: skip ? [] : [{ ...state.project, latest_run: lastRun ? { run_id: lastRun.run_id, state: lastRun.state, updated_at: now } : null,
        latest_artifact: { artifact_id: 'synthetic-old-artifact', run_id: 'synthetic-old-run', version: 1, created_at: now } }], page: { next_cursor: skip ? 'page-two' : null, has_more: skip } });
    }
    if (path === `/projects/${id}/events`) return json(route, 200, { items: state.materials.map((m, i) => ({ event_id: `event-${i}`, schema_version: 1, project_id: id, trace_id: 'trace', seq: i + 1, occurred_at: now, type: 'material.upload_progress', payload: { material_id: m.material_id } })), next_cursor: null });
    if (path.endsWith('/parse-job')) return json(route, 404, { code: 'NOT_FOUND' });
    const material = state.materials.find(m => path === `/projects/${id}/materials/${m.material_id}`);
    if (material) return json(route, 200, material);
    if (path === `/projects/${id}/input-revisions` && method === 'POST') {
      const body = request.postDataJSON();
      expect(Value.Check(schemas.InputRevisionCreateRequest, body)).toBe(true);
      state.inputs.push(body);
      if (state.conflictSave) return json(route, 409, { code: 'INPUT_REVISION_CONFLICT' });
      const revision = state.snapshots.size + 1;
      const snapshot: Dto<'InputRevisionResponse'> = { project_id: id, input_revision: revision, input_hash: hash(JSON.stringify(body)),
        material_versions: body.material_versions, ...(body.credit_facility_supplements ? { credit_facility_supplements: body.credit_facility_supplements } : {}), target_confirmation: { ...body.target_confirmation, status: 'confirmed', confirmed_at: now, confirmed_by: 'synthetic-owner' },
        rule_pack_version: null, template_version: null, reference_release: null, created_at: now };
      state.snapshots.set(revision, snapshot); state.project.input_revision = revision; state.project.input_hash = snapshot.input_hash;
      if (state.dropSave) { state.dropSave = false; return route.abort('connectionreset'); }
      return json(route, 201, snapshot);
    }
    const rev = path.match(/\/input-revisions\/(\d+)$/);
    if (rev) return json(route, 200, state.snapshots.get(Number(rev[1])));
    if (path === `/projects/${id}/preflight`) {
      const body = request.postDataJSON();
      state.preflights.push(body);
      if (state.holdCheck) await new Promise<void>(resolve => { state.releaseCheck = resolve; });
      return json(route, 200, { project_id: id, ...body, status: state.checkStatus, missing_inputs: state.checkStatus === 'blocked' ? [state.reason] : [],
        uncertainty: ['material_needs_confirmation:synthetic-audit:1'], billing_mode: 'platform_trial' });
    }
    if (path === '/runs/execute') {
      const body = request.postDataJSON();
      expect(Value.Check(schemas.ExecuteRequest, body)).toBe(true);
      state.executes.push(body);
      let run = state.runs.get(body.execution_request_id);
      if (!run) {
        run = { run_id: `synthetic-run-${state.runs.size + 1}`, execution_request_id: body.execution_request_id, project_id: id,
          input_revision: body.input_revision, input_hash: body.input_hash, state: 'paused', stage: 'capability_not_ready', event_cursor: 2,
          channel: 'production', test_grant_id: null, uncovered_items: [], billing_mode: 'platform_trial',
          reservation_id: null, artifact_id: null, prompt_snapshot_ref: null, updated_at: now };
        state.runs.set(body.execution_request_id, run);
      }
      if (state.holdExecute) await new Promise<void>(resolve => { state.releaseExecute = resolve; });
      if (state.dropExecute) { state.dropExecute = false; return route.abort('connectionreset'); }
      return json(route, 202, state.lateRunForeign ? { ...run, project_id: 'synthetic-foreign' } : run);
    }
    if (path.startsWith('/runs/')) {
      const run = [...state.runs.values()].find(run => path.startsWith(`/runs/${run.run_id}`));
      if (!run) return json(route, 404, { code: 'NOT_FOUND' });
      if (method === 'POST' && (path.endsWith('/cancel') || path.endsWith('/resume'))) { run.state = path.endsWith('/cancel') ? 'cancelled' : 'running'; return json(route,200,run); }
      if (path.endsWith('/events')) {
        const cursor = url.searchParams.get('after') ?? '0'; state.eventPages.push(cursor);
        const more = state.paginate && cursor === '0';
        const seq = more ? 1 : 2;
        return json(route, 200, { items: Number(cursor) >= 2 ? [] : [{ event_id: `run-event-${seq}`, schema_version: 1, trace_id: 'trace', run_id: run.run_id, seq,
          occurred_at: now, stage: run.stage, type: 'run.state_changed', state: more ? 'queued' : run.state,
          payload: more ? {} : { reason: 'rule_applicability_overall_review_required' } }], next_cursor: more ? 1 : null });
      }
      return json(route, 200, run);
    }
    if (path.endsWith('/facts/candidates')) return json(route, 200, { items: [], page: { next_cursor: null, has_more: false } });
    return json(route, 404, { code: 'NOT_FOUND' });
  });
  await page.goto(`/#/projects/${id}`);
  await expect(page.getByRole('heading', { name: '合成任务项目', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始更新', exact: true })).toBeEnabled();
  return state;
}
async function confirmTarget(page: Page) {
  await page.getByLabel('本次文书用途', { exact:true }).selectOption('issuance');
  await page.getByLabel('本次法规适用日', { exact:true }).fill('2026-09-27');
  await page.getByLabel('确认以上目标为本次拟定安排', { exact:false }).check();
}
async function prepare(page: Page) {
  await confirmTarget(page); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-preflight')).toContainText('预检：');
}
async function openRecords(page: Page) { await page.locator('#execution-records > summary').click(); }

test('ready input saves, preflights and executes through one explicit action', async ({ page }) => {
  const state=fixture(); state.checkStatus='ready'; await setup(page,state);
  await confirmTarget(page); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  expect(state.inputs).toHaveLength(1); expect(state.preflights).toHaveLength(1); expect(state.executes).toHaveLength(1);
  expect(state.inputs[0].target_confirmation).toEqual({market:'sse',offering:'private',document_purpose:'issuance',as_of:'2026-09-27',target_reporting_periods:periods});
  expect(state.inputs[0].material_versions).toEqual(state.materials.map(m=>({material_id:m.material_id,material_version:1})));
  await expect(page.getByRole('button',{name:'保存材料版本'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'检查已保存版本'})).toHaveCount(0);
});

test('actual preflight gaps are shown once before submission, then refresh recovers without a new task', async ({ page }) => {
  const state=await setup(page); await prepare(page);
  expect(state.executes).toHaveLength(0);
  await expect(page.locator('#execution-preflight')).toContainText('等待规则适用性审核');
  await page.getByRole('button',{name:'确认提交，等待条件齐备'}).click();
  await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  await expect(page.getByRole('link',{name:'查看此前成功成果'})).toBeVisible();
  await page.reload(); await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  expect(state.executes).toHaveLength(1); await expect(page.locator('.project-cowork')).toBeVisible();
  await openRecords(page); await expect(page.locator('#execution-snapshot')).toContainText('已保存材料版本 1');
});

test('lost execute response retries the same key; reload restores the actual task', async ({ page }) => {
  const state=await setup(page); await prepare(page); state.dropExecute=true;
  await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('连接中断');
  await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  expect(state.executes).toHaveLength(2); expect(state.executes[0]).toEqual(state.executes[1]); expect(state.runs.size).toBe(1);
  await page.reload(); await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  expect(state.inputs).toHaveLength(1); expect(state.executes).toHaveLength(2);
});

test('lost snapshot response requires readback and explicit selection, without another snapshot POST', async ({ page }) => {
  const state=await setup(page); state.dropSave=true;
  await confirmTarget(page); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('保存结果尚未确认');
  await expect(page.locator('#execute-input')).toBeDisabled(); expect(state.inputs).toHaveLength(1);
  await page.getByRole('button',{name:'刷新任务状态'}).click(); await openRecords(page);
  await page.getByRole('button',{name:'使用这个已保存版本'}).click();
  await page.locator('#execute-input').click();
  await expect(page.locator('#execution-preflight')).toContainText('预检：');
  expect(state.inputs).toHaveLength(1); expect(state.executes).toHaveLength(0);
});

test('double click and edits during submission preserve the locked request', async ({ page }) => {
  const state=await setup(page); await prepare(page); state.holdExecute=true;
  await page.locator('#execute-input').click(); await expect.poll(()=>!!state.releaseExecute).toBe(true);
  await expect(page.locator('#execute-input')).toBeDisabled();
  await page.getByLabel('补充说明与写作要求').fill('下一轮的补充'); state.releaseExecute!();
  await expect(page.locator('#execution-progress')).toContainText('使用材料版本 1');
  expect(state.executes).toHaveLength(1); expect(state.executes[0].input_hash).toBe(state.snapshots.get(1)!.input_hash);
});

test('editing while preflight is pending discards that result; next action locks a new revision', async ({ page }) => {
  const state=await setup(page); state.holdCheck=true; await confirmTarget(page);
  await page.locator('#execute-input').click(); await expect.poll(()=>!!state.releaseCheck).toBe(true);
  await page.getByLabel('补充说明与写作要求').fill('只供下一版使用'); state.releaseCheck!(); state.holdCheck=false;
  await expect(page.locator('#execution-preflight')).toBeEmpty(); expect(state.executes).toHaveLength(0);
  await expect(page.locator('#save-state')).toHaveText('已保存'); await prepare(page);
  expect(state.inputs).toHaveLength(2); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('使用材料版本 2');
});

test('409 preserves target input and never submits a run', async ({ page }) => {
  const state=await setup(page); state.conflictSave=true; await confirmTarget(page); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('其他页面修改');
  await expect(page.getByLabel('本次法规适用日',{exact:true})).toHaveValue('2026-09-27');
  expect(state.inputs).toHaveLength(1); expect(state.executes).toHaveLength(0);
});

test('target consent and optional material exclusion preserve unknown dates', async ({ page }) => {
  const state=await setup(page); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('勾选确认');
  await page.getByText('本次使用的材料',{exact:true}).click();
  await page.locator('[data-material="synthetic-history"]').uncheck(); await page.locator('[data-material="synthetic-audit"]').uncheck();
  await page.getByLabel('确认以上目标为本次拟定安排',{exact:false}).check(); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('至少一份'); expect(state.inputs).toHaveLength(0);
  await page.locator('[data-material="synthetic-history"]').check();
  await page.getByLabel('确认以上目标为本次拟定安排',{exact:false}).check(); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-preflight')).toContainText('预检：');
  expect(state.inputs[0].material_versions).toEqual([{material_id:'synthetic-history',material_version:1}]);
  expect(state.inputs[0].target_confirmation!.as_of).toBeNull();
});

test('paginated recovery and real task actions keep one run', async ({ page }) => {
  const state=await setup(page); await prepare(page); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  state.paginate=true; state.eventPages=[]; state.listPages=[]; await page.reload();
  await expect(page.locator('#execution-progress')).toContainText('等待规则适用性审核');
  expect(state.listPages).toContain('page-two'); expect(state.eventPages).toContain('1');
  await page.getByRole('button',{name:'继续更新',exact:true}).click();
  await expect(page.locator('#execution-progress')).toContainText('处理中');
  await page.getByRole('button',{name:'停止更新',exact:true}).click();
  await expect(page.locator('#execution-progress')).toContainText('已取消'); expect(state.runs.size).toBe(1);
});

test('account switch ignores an in-flight execute result', async ({ page }) => {
  const state=await setup(page); await prepare(page); state.holdExecute=true;
  await page.locator('#execute-input').click(); await expect.poll(()=>!!state.releaseExecute).toBe(true);
  await page.evaluate(()=>{const channel=new BroadcastChannel('bondbuddy-session');channel.postMessage('changed');channel.close();});
  await expect(page.getByLabel('用户名',{exact:true})).toBeVisible(); state.releaseExecute!();
  await expect(page.locator('#execution-progress')).toHaveCount(0); await expect(page.locator('.project-cowork')).toHaveCount(0);
});

test('foreign execute response is rejected', async ({ page }) => {
  const state=await setup(page); await prepare(page); state.lateRunForeign=true;
  await page.locator('#execute-input').click(); await expect(page.locator('#execution-message')).not.toBeEmpty();
  await expect(page.locator('#execution-progress')).not.toContainText('任务已暂停');
});

test('unknown blockers remain explicit; prototype workspace captures all states without fake progress', async ({ page }) => {
  const state=fixture(); state.reason='<img src=x onerror=alert(1)>'; await setup(page,state);
  await page.setViewportSize({width:1440,height:960});
  await page.evaluate(()=>{ document.activeElement instanceof HTMLElement && document.activeElement.blur(); scrollTo(0,0); });
  await page.screenshot({path:join(tmpdir(),'bb361-materials-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'编辑项目信息'}).click();
  await page.evaluate(()=>{ document.activeElement instanceof HTMLElement && document.activeElement.blur(); scrollTo(0,0); });
  await page.screenshot({path:join(tmpdir(),'bb361-project-details-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'保存并继续'}).click(); await prepare(page);
  await expect(page.locator('#execution-preflight')).toContainText('待处理条件');
  await expect(page.locator('#execution-preflight img')).toHaveCount(0);
  await page.locator('#execute-input').click(); await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  await page.evaluate(()=>{ document.activeElement instanceof HTMLElement && document.activeElement.blur(); scrollTo(0,0); });
  await page.screenshot({path:join(tmpdir(),'bb361-paused-desktop.png'),fullPage:true});
  for (const [status, file] of [['running','running'],['awaiting_input','awaiting'],['failed','failed']] as const) {
    [...state.runs.values()][0].state=status; await page.getByRole('button',{name:'刷新任务状态'}).click();
    await expect(page.locator('#execution-progress')).toContainText(status==='running'?'处理中':status==='awaiting_input'?'待补充信息':'任务失败');
    await page.evaluate(()=>{ document.activeElement instanceof HTMLElement && document.activeElement.blur(); scrollTo(0,0); });
  await page.screenshot({path:join(tmpdir(),`bb361-${file}-desktop.png`),fullPage:true});
  }
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{ document.activeElement instanceof HTMLElement && document.activeElement.blur(); scrollTo(0,0); });
  await page.screenshot({path:join(tmpdir(),'bb361-workspace-mobile.png'),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});

test('restored snapshot retains exact user assertion pins in a new version', async ({ page }) => {
  const state=await setup(page); await prepare(page);
  const pin={supplement_id:'00000000-0000-4000-8000-000000000001',version:2,request_hash:'a'.repeat(64)};
  state.snapshots.get(1)!.credit_facility_supplements=[pin];
  await page.reload(); await expect(page.locator('#execute-input')).toBeEnabled();
  await page.getByLabel('补充说明与写作要求').fill('下一轮补充'); await expect(page.locator('#save-state')).toHaveText('已保存');
  await prepare(page); expect(state.inputs[1].credit_facility_supplements).toEqual([pin]);
});

test('failed task recovery cannot enable a new snapshot until the server record is read', async ({page})=>{
  const state=await setup(page);
  await page.route('**/api/v1/projects?*',route=>json(route,503,{code:'DATA_UNAVAILABLE'}));
  await page.getByRole('button',{name:'刷新任务状态'}).click();
  await expect(page.locator('#execution-message')).not.toBeEmpty();
  await expect(page.locator('#execute-input')).toBeDisabled();
  expect(state.inputs).toHaveLength(0); expect(state.executes).toHaveLength(0);
  await page.unroute('**/api/v1/projects?*'); await page.getByRole('button',{name:'刷新任务状态'}).click();
  await expect(page.locator('#execute-input')).toBeEnabled();
});

test('a test terminal state in the production channel never exposes a deliverable',async({page})=>{
  const state=await setup(page); await prepare(page); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  const run=[...state.runs.values()][0];run.state='test_completed';run.artifact_id='invalid-artifact';
  await page.getByRole('button',{name:'刷新任务状态'}).click();
  await expect(page.locator('#execution-delivery')).toBeEmpty();
  await expect(page.getByRole('button',{name:'下载修订版',exact:true})).toHaveCount(0);
});

test('continuing after completion creates a new input and retains the preceding successful artifact without reload',async({page})=>{
  const state=await setup(page); await prepare(page); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  const first=[...state.runs.values()][0]; first.state='succeeded'; first.artifact_id='first-successful-artifact';
  await page.getByRole('button',{name:'刷新任务状态'}).click();
  await expect(page.locator('#execution-progress')).toContainText('已生成');
  await page.getByRole('button',{name:'继续修改',exact:true}).click();
  await prepare(page); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('使用材料版本 2');
  await expect(page.getByRole('link',{name:'查看此前成功成果'})).toHaveAttribute('href','#/artifacts/first-successful-artifact');
  expect(state.runs.size).toBe(2);
  expect(state.executes[0].input_hash).toBe(state.snapshots.get(1)!.input_hash);
  expect(state.executes[0].execution_request_id).not.toBe(state.executes[1].execution_request_id);
});
