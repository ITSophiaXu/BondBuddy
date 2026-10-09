import { expect, test, type Page, type Route } from '@playwright/test';
import { emptyUpdateDetails, reportingWindow, RECHARGE_PACKS, schemas } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';
import { createHash } from 'node:crypto';
import type { Dto } from '../src/api';
import { join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// Synthetic HTTP boundary tests in real Chromium; no actual API/PG/model/Word acceptance.
const now = '2026-09-27T12:00:00Z';
const id = 'synthetic-execution-project';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const emptyMessages = { version: 1, content_sha256: hash('bondbuddy:empty-project-messages'), message_ids: [] };
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const periods: NonNullable<Dto<'InputRevisionCreateRequest'>['target_confirmation']>['target_reporting_periods'] = [{ start: '2025-01-01', end: '2025-12-31', period_kind: 'annual', scope: 'consolidated', status: 'user_asserted', evidence_refs: [] }];
function fixture() {
  const project: Dto<'ProjectResponse'> = { project_id: id, name: '合成任务项目', issuer_name: '合成发行人', kind: 'update',
    market: 'sse', offering: 'private', draft_revision: 2, input_revision: null, input_hash: null, updated_at: now,
    update_details: { ...emptyUpdateDetails(), has_historical: true, reporting_cutoff: '2025-12-31', target_reporting_periods: structuredClone(periods) } };
  const materials: Dto<'MaterialResponse'>[] = ['history', 'audit'].map((name, i) => ({ material_id: `synthetic-${name}`, material_version: 1,
    upload_id: `synthetic-upload-${i}`, role: i === 0 ? 'historical' : 'audit', filename: `${name}.docx`,
    media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', byte_size: 1024, sha256: hash(name), state: 'persisted', persisted_at: now, error: null }));
  project.update_details!.source_prospectuses=[{material_id:materials[0].material_id,material_version:1,sha256:materials[0].sha256,
    issuer_name:'合成发行人',relation:'same_issuer',market:'sse',offering:'private',
    reporting_periods:reportingWindow('sse','private','2024-12-31'),status:'user_asserted'}];
  return { project, materials, inputs: [] as Dto<'InputRevisionCreateRequest'>[], snapshots: new Map<number, Dto<'InputRevisionResponse'>>(),
    executes: [] as Dto<'ExecuteRequest'>[], runs: new Map<string, Dto<'RunResponse'>>(), preflights: [] as Dto<'PreflightRequest'>[],
    nextInputRevision: undefined as number | undefined, patchRequests: 0,
    holdProjectRead: false, releaseProjectRead: undefined as (() => void) | undefined,
    loggedOut: false, dropSave: false, dropExecute: false, conflictSave: false, holdExecute: false, holdCheck: false,
    releaseExecute: undefined as (() => void) | undefined, releaseCheck: undefined as (() => void) | undefined,
    holdRunRead: false, runReads: 0, releaseRunRead: undefined as (() => void) | undefined,
    listPages: [] as string[], eventPages: [] as string[], paginate: false, lateRunForeign: false,
    chargeState: 'held' as 'held'|'settled'|'released', chargeFailure:false, frozen:0,
    paid:false,freeClassification:false,points:17900,available:17899,priceVersion:'test-v1',
    order:undefined as Dto<'RechargeOrderResponse'>|undefined,
    parseSucceeded: false,
    runStage: 'capability_not_ready', runState: 'paused' as Dto<'RunResponse'>['state'],
    runReason: 'rule_applicability_overall_review_required', eventSeq: 2, failEvents: false,
    eventStage: undefined as string | undefined, eventError: undefined as string | undefined,
    eventHistory: [] as { seq: number; state: Dto<'RunResponse'>['state']; stage: string; reason: string }[],
    executeError: undefined as { status: number; code: string; correlation_id: string } | undefined,
    preflightError: undefined as { status: number; code: string; correlation_id: string } | undefined,
    runActions: [] as string[],
    checkStatus: 'blocked' as Dto<'PreflightResponse'>['status'], reason: 'rule_pack:rule_applicability_overall_review_required',
    blockers: undefined as string[] | undefined };
}
async function setup(page: Page, state = fixture(), canStart = true) {
  await page.context().route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/v1', '');
    const method = request.method();
    if (path === '/auth/logout') { state.loggedOut = true; return route.fulfill({ status: 204 }); }
    if (state.loggedOut) return json(route, 401, { code: 'UNAUTHENTICATED' });
    if(path==='/account')return json(route,200,{user_id:'synthetic-owner',username:'synthetic',phone_masked:null,status:'active',created_at:now,accepted_terms_version:null,current_terms_version:null,password_updated_at:null,support_contact:null});
    if(path==='/account/sessions')return json(route,200,{items:[]});
    if(path==='/account/recovery')return json(route,200,{enabled:false,support_operator:false,current:null,pending:null});
    if (path === '/m4/topics') return json(route,200,{topics:[]});
    if (path === '/me') return json(route, 200, { user_id: 'synthetic-owner', session_status: 'active' });
    if (path === `/projects/${id}`) {
      if (method === 'PATCH') { state.patchRequests++; Object.assign(state.project, request.postDataJSON(), { draft_revision: state.project.draft_revision + 1 }); }
      if (method === 'GET' && state.holdProjectRead) {
        state.holdProjectRead=false;
        await new Promise<void>(resolve=>{state.releaseProjectRead=resolve;});
      }
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
    if (path === `/projects/${id}/messages` && method === 'GET') return json(route, 200,
      { conversation_id: id, items: [], project_message_set_ref: emptyMessages, next_cursor: null, has_more: false });
    if (!canStart && (path.endsWith('/parse-job') || path.includes('/materials/uploads') || path.endsWith('/source-profile'))) return route.fallback();
    if (path.endsWith('/parse-job')) {
      const material = state.materials.find(m => m.material_id === path.split('/').at(-2));
      if (!state.parseSucceeded || !material) return json(route, 404, { code: 'NOT_FOUND' });
      return json(route, 200, { job_id: `job-${material.material_id}`, job_type: 'parse', subtype: 'material_parse', project_id: id,
        material_id: material.material_id, material_version: material.material_version, material_sha256: material.sha256,
        parser_version: 'synthetic-v1', state: 'succeeded', stage: 'succeeded', completed_stages: ['parse_evidence'],
        attempts: 1, max_attempts: 3, error_code: null, outcome: 'needs_confirmation', parse_status: 'needs_confirmation',
        profile_version: material.role === 'historical' ? 1 : null, pending_capabilities: [], updated_at: now });
    }
    const material = state.materials.find(m => path === `/projects/${id}/materials/${m.material_id}`);
    if (material) return json(route, 200, material);
    if (path === `/projects/${id}/input-revisions` && method === 'POST') {
      const body = request.postDataJSON();
      expect(Value.Check(schemas.InputRevisionCreateRequest, body)).toBe(true);
      state.inputs.push(body);
      if (state.conflictSave) return json(route, 409, { code: 'INPUT_REVISION_CONFLICT' });
      const revision = state.nextInputRevision ?? state.snapshots.size + 1;
      const snapshot: Dto<'InputRevisionResponse'> = { project_id: id, input_revision: revision, input_hash: hash(JSON.stringify(body)),
        material_versions: body.material_versions, ...(body.credit_facility_supplements ? { credit_facility_supplements: body.credit_facility_supplements } : {}), target_confirmation: {status:'unconfirmed',market:null,offering:null,as_of:null,document_purpose:null,target_reporting_periods:[],confirmed_at:null,confirmed_by:null},
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
      if (state.preflightError) return json(route, state.preflightError.status, state.preflightError);
      if (state.holdCheck) await new Promise<void>(resolve => { state.releaseCheck = resolve; });
      const blocking = state.checkStatus === 'blocked' ? state.blockers ?? [state.reason] : [];
      return json(route, 200, { project_id: id, ...body, status: state.checkStatus, missing_inputs: blocking,
        blocking_inputs: blocking, advisory_inputs: [], uncertainty: ['material_needs_confirmation:synthetic-audit:1'], billing_mode: state.paid?'fixed_credits':'platform_trial' });
    }
    if(path.endsWith('/credit-quote'))return json(route,200,{enabled:true,quote:state.freeClassification?null:{quote_id:`quote-${state.priceVersion}`,project_id:id,...request.postDataJSON(),task_type:'interim',points:state.points,price_version:state.priceVersion,reason:'合成一期更新',created_at:now},balance:{available:state.available,frozen:0},shortage:state.freeClassification?0:Math.max(0,state.points-state.available),reason:state.freeClassification?'原稿信息不足，本次保留 M1 免费编制，不补扣。':null});
    if(path==='/credits/balance')return json(route,200,{enabled:state.paid,available:state.available,frozen:state.frozen});
    if(path==='/credits/recharge-config')return json(route,200,{enabled:true,providers:['alipay'],packs:RECHARGE_PACKS,pack_version:'synthetic-v1'});
    if(path==='/credits/recharge-orders'){
      state.order={order_id:'synthetic-order',provider:'alipay',state:'pending',amount_fen:20000,points:20000,currency:'CNY',checkout_url:'https://synthetic.invalid/pay',project_id:id,expires_at:now,credited_at:null};
      return json(route,201,state.order);
    }
    if(path.startsWith('/credits/recharge-orders/'))return json(route,200,state.order);
    if (path === '/runs/execute') {
      const body = request.postDataJSON();
      expect(Value.Check(schemas.ExecuteRequest, body)).toBe(true);
      state.executes.push(body);
      if (state.executeError) return json(route, state.executeError.status, state.executeError);
      let run = state.runs.get(body.execution_request_id);
      if (!run) {
        run = { run_id: `synthetic-run-${state.runs.size + 1}`, execution_request_id: body.execution_request_id, project_id: id,
          input_revision: body.input_revision, input_hash: body.input_hash, state: state.runState, stage: state.runStage, event_cursor: state.eventSeq,
          channel: 'production', test_grant_id: null, uncovered_items: [], billing_mode: state.paid?'fixed_credits':'platform_trial',
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
      if(path.endsWith('/credit-charge'))return state.chargeFailure?json(route,503,{code:'DATA_UNAVAILABLE'}):json(route,200,{quote:{points:state.points},state:state.chargeState});
      if (method === 'POST' && (path.endsWith('/cancel') || path.endsWith('/resume'))) { state.runActions.push(path); run.state = path.endsWith('/cancel') ? 'cancelled' : 'running'; return json(route,200,run); }
      if (path.endsWith('/events')) {
        const cursor = url.searchParams.get('after') ?? '0'; state.eventPages.push(cursor);
        const more = state.paginate && cursor === '0';
        if (state.failEvents) return json(route, 503, { code: 'DATA_UNAVAILABLE' });
        if (state.eventHistory.length) return json(route, 200, { items: state.eventHistory.filter(event => event.seq > Number(cursor)).map(event => ({
          event_id: `run-event-${event.seq}`, schema_version: 1, trace_id: 'trace', run_id: run.run_id, seq: event.seq,
          occurred_at: now, stage: event.stage, type: 'run.state_changed', state: event.state, payload: { reason: event.reason }
        })), next_cursor: null });
        const seq = more ? 1 : state.eventSeq;
        return json(route, 200, { items: Number(cursor) >= state.eventSeq ? [] : [{ event_id: `run-event-${seq}`, schema_version: 1, trace_id: 'trace', run_id: run.run_id, seq,
          occurred_at: now, stage: state.eventStage ?? run.stage, type: 'run.state_changed', state: more ? 'queued' : run.state,
          payload: more ? {} : { ...(state.runReason ? { reason: state.runReason } : {}), ...(state.eventError ? { error_code: state.eventError } : {}) } }], next_cursor: more ? 1 : null });
      }
      state.runReads++;
      const snapshot={...structuredClone(run),event_cursor:state.eventSeq};
      if (state.holdRunRead) {
        state.holdRunRead=false;
        await new Promise<void>(resolve=>{state.releaseRunRead=resolve;});
      }
      return json(route, 200, snapshot);
    }
    if (path.endsWith('/facts/candidates')) return json(route, 200, { items: [], page: { next_cursor: null, has_more: false } });
    return json(route, 404, { code: 'NOT_FOUND' });
  });
  await page.goto(`/#/projects/${id}`);
  await expect(page.getByRole('heading', { name: '合成任务项目', exact: true })).toBeVisible();
  if (canStart) await expect(page.getByRole('button', { name: '开始编制', exact: true })).toBeEnabled();
  else await expect(page.getByRole('button', { name: '开始编制', exact: true })).toBeDisabled();
  return state;
}
async function prepare(page: Page) {
  await page.locator('#execute-input').click();
  await expect(page.locator('#execution-preflight')).not.toBeEmpty();
}

test('M2 shortage preserves inputs, recharge never executes, returning requires confirmed quote',async({page})=>{
  const state=fixture();state.paid=true;state.checkStatus='ready';state.project.update_details!.authoring_mode='unified_v1';
  await page.setViewportSize({width:1440,height:960});await setup(page,state);
  await page.locator('#execute-input').click();await expect(page.locator('#fixed-quote')).toContainText('还差 1 积分');
  expect(state.executes).toHaveLength(0);await expect(page.locator('#execute-input')).toBeDisabled();
  const evidence=process.env.BB_UX_EVIDENCE_DIR;if(evidence){await mkdir(evidence,{recursive:true});await page.locator('#fixed-quote').scrollIntoViewIfNeeded();await page.screenshot({path:join(evidence,'m2-quote-desktop.png')});}
  await page.locator('#fixed-quote').getByRole('link',{name:'充值积分',exact:true}).click();
  await expect(page.getByRole('heading',{name:'按需充值',exact:true})).toBeVisible();
  if(evidence)await page.screenshot({path:join(evidence,'m2-billing-desktop.png')});
  await expect(page.locator('[data-pack]')).toHaveCount(4);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  if(evidence)await page.screenshot({path:join(evidence,'m2-billing-mobile.png')});
  await page.setViewportSize({width:1440,height:960});
  await expect(page.getByRole('button',{name:'充值 ¥50',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'充值 ¥200',exact:true}).click();
  await expect(page.getByRole('heading',{name:'等待支付确认'})).toBeVisible();expect(state.executes).toHaveLength(0);
  state.order!.state='paid';state.order!.credited_at=now;state.available+=20000;
  await page.getByRole('button',{name:'刷新支付状态'}).click();await expect(page.getByRole('heading',{name:'积分已到账'})).toBeVisible();
  expect(state.executes).toHaveLength(0);
  await page.getByRole('link',{name:'返回项目确认开始'}).first().click();
  await page.locator('#execute-input').click();await expect(page.locator('#execute-input')).toHaveText('确认并开始更新');
  expect(state.executes).toHaveLength(0);await page.locator('#execute-input').click();
  await expect.poll(()=>state.executes.length).toBe(1);expect(state.executes[0].quote_id).toBe('quote-test-v1');
  expect(state.inputs.at(-1)!.material_versions).toEqual(state.inputs[0].material_versions);
});
test('M2 price change refreshes the displayed quote and requires another confirmation',async({page})=>{
  const state=fixture();state.paid=true;state.checkStatus='ready';state.available=999999;
  await setup(page,state);await page.locator('#execute-input').click();
  await expect(page.locator('#fixed-quote')).toContainText('17,900');
  state.points=20000;state.priceVersion='test-v2';state.executeError={status:409,code:'QUOTE_CHANGED',correlation_id:'synthetic'};
  await page.locator('#execute-input').click();await expect(page.locator('#fixed-quote')).toContainText('20,000');
  expect(state.executes).toHaveLength(1);expect(state.runs.size).toBe(0);
  state.executeError=undefined;await page.locator('#execute-input').click();await expect.poll(()=>state.runs.size).toBe(1);
  expect(state.executes[1].quote_id).toBe('quote-test-v2');
});
test('M2 a legacy empty quote cannot offer a new free task',async({page})=>{
  const state=fixture();state.paid=true;state.checkStatus='ready';state.freeClassification=true;
  await setup(page,state);await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('请查看本次任务报价后确认开始');
  await expect(page.getByRole('button',{name:'按 M1 免费编制'})).toHaveCount(0);
  await expect(page.locator('#fixed-quote')).toBeHidden();expect(state.executes).toHaveLength(0);
  await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('请查看本次任务报价后确认开始');
  expect(state.executes).toHaveLength(0);
});
test('M2 missing uploaded source metadata blocks the next action before quote or execution',async({page})=>{
  const state=fixture();state.paid=true;state.checkStatus='ready';state.available=0;
  state.project.update_details!.authoring_mode='unified_v1';
  state.project.update_details!.source_prospectuses=[];
  await setup(page,state,false);
  await expect(page.locator('#execute-input')).toBeDisabled();
  await expect(page.locator('#start-disabled-reason')).toContainText('企业关系、原发行市场、原品种、原稿最新报告期');
  await expect(page.locator('#fixed-quote')).toBeHidden();
  expect(state.inputs).toHaveLength(0);expect(state.preflights).toHaveLength(0);expect(state.executes).toHaveLength(0);
});
test('ready input saves, preflights and executes through one explicit action', async ({ page }) => {
  const state=fixture(); state.checkStatus='ready'; await setup(page,state);
  await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  expect(state.inputs).toHaveLength(1); expect(state.preflights).toHaveLength(1); expect(state.executes).toHaveLength(1);
  expect(state.inputs[0]).not.toHaveProperty('target_confirmation');
  expect(state.project.update_details!.target_reporting_periods).toEqual(periods);
  expect(state.inputs[0].material_versions).toEqual(state.materials.map(m=>({material_id:m.material_id,material_version:1})));
  await expect(page.getByRole('button',{name:'保存材料版本'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'检查已保存版本'})).toHaveCount(0);
});

test('authoring materials stay read-only after starting until an explicit next version', async ({ page }) => {
  const state = fixture(); state.checkStatus = 'ready'; state.runState = 'running'; state.runStage = 'generation';
  state.project.update_details!.authoring_mode = 'unified_v1';
  await setup(page, state);
  const picker = page.locator('#upload-audit');
  const source = page.locator('[data-source-field="relation"]');
  const capture = async (name: string) => {
    if (!process.env.BB_MATERIAL_LOCK_EVIDENCE_DIR) return;
    const output = resolve(process.env.BB_MATERIAL_LOCK_EVIDENCE_DIR); await mkdir(output, { recursive: true });
    for (const [device, width, height] of [['desktop',1440,960],['mobile',390,844]] as const) {
      await page.setViewportSize({ width, height });
      await page.locator('#materials-title').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(output, `${name}-${device}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  };
  await expect(picker).toBeEnabled();
  await expect(page.locator('#materials-state-description')).toContainText('开始后材料锁定，仅可查看');
  await capture('preparing');
  await page.locator('#execute-input').click();
  await expect(page.locator('#project-materials-details')).toHaveClass(/materials-readonly/);
  await page.getByRole('button', { name: '查看材料', exact: true }).click();
  await expect(page.locator('#materials-state-label')).toHaveText('材料已锁定，仅可查看');
  await expect(page.locator('#materials-title')).toHaveText('查看项目材料');
  await expect(picker).toBeDisabled();
  await expect(picker.locator('..')).toBeHidden();
  await expect(source).toBeDisabled();
  await expect(page.locator('[data-delete-material]').first()).toBeHidden();
  await expect(page.locator('.material-footnote')).toBeHidden();
  const writes: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/api/v1/')) writes.push(request.method() + ' ' + new URL(request.url()).pathname); });
  // Refresh replaces material rows; native fieldset locking must survive that replacement.
  await page.getByRole('button', { name: '刷新已保存材料', exact: true }).click();
  await expect(page.locator('#material-recovery-status')).toContainText('已恢复');
  await expect(source).toBeDisabled();
  await expect(page.locator('[data-delete-material]').first()).toBeDisabled();
  // A late file-chooser event or a drop must not enqueue a file after the run starts.
  await picker.setInputFiles({ name: 'late-audit.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') });
  await page.locator('.material-picker').first().dispatchEvent('drop');
  await source.dispatchEvent('change');
  await page.locator('[data-delete-material]').first().dispatchEvent('click');
  expect(writes).toEqual([]);
  await expect(page.locator('#material-partitions')).not.toContainText('late-audit.txt');
  await capture('running');
  await page.reload();
  await expect(page.locator('#project-materials-details')).toHaveClass(/materials-readonly/);
  await page.getByRole('button', { name: '查看材料', exact: true }).click();
  await expect(picker).toBeDisabled();
  const run = [...state.runs.values()][0];
  for (const status of ['paused', 'awaiting_input', 'cancelled'] as const) {
    run.state = status;
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(page.locator('#material-editing')).toHaveJSProperty('disabled', true);
    await expect(picker).toBeDisabled();
  }
  await expect(page.locator('#materials-state-description')).toContainText('继续修改');
  await page.getByRole('button', { name: '继续修改', exact: true }).click();
  await expect(picker).toBeEnabled();
  await expect(picker.locator('..')).toBeVisible();
  await expect(source).toBeEnabled();
  await expect(page.locator('[data-delete-material]').first()).toBeVisible();
  await expect(page.locator('#materials-state-label')).toHaveText('为下一轮补充材料');
  await capture('next-version');
  expect(state.executes).toHaveLength(1);
  expect(writes).toEqual([]);
});

test('blocked preflight keeps backend gates and does not turn five diagnostics into user tasks or runs', async ({ page }) => {
  const state=fixture(); state.parseSucceeded=true; state.blockers=['rule_pack:rule_applicability_overall_review_required',
    'issuer_identity_not_bound:issuer_identity_source_missing_unreviewed_or_conflicting',
    'material_needs_confirmation:synthetic-audit:1','source_profile_missing:synthetic-history:1','update_difficulty_pending:target_confirmation_required'];
  await setup(page,state); await prepare(page);
  expect(state.executes).toHaveLength(0);
  await expect(page.locator('#execution-preflight')).toContainText('当前处理条件尚未就绪');
  await expect(page.locator('#execution-preflight')).not.toContainText(/规则适用性审核|发行人身份|报告期|待确认内容|source_profile/);
  await expect(page.locator('#execute-input')).toBeDisabled();
  await expect(page.getByRole('button',{name:'继续提交并等待处理'})).toHaveCount(0);
  await page.locator('#recheck-input').click();
  await expect.poll(()=>state.preflights.length).toBe(2);
  expect(state.executes).toHaveLength(0); expect(state.inputs).toHaveLength(1);
  if (process.env.BB_UX_EVIDENCE_DIR) {
    const output = resolve(process.env.BB_UX_EVIDENCE_DIR); await mkdir(output, { recursive: true });
    for (const [label, width, height] of [['desktop', 1440, 960], ['mobile', 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); scrollTo(0, 0); });
      await page.screenshot({ path: join(output, `blocked-${label}.png`), fullPage: true });
    }
  }
  state.checkStatus='ready'; await page.locator('#recheck-input').click();
  await expect(page.locator('#execute-input')).toBeEnabled();
  await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  expect(state.executes).toHaveLength(1); expect(state.inputs).toHaveLength(1);
  await page.reload(); await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  await expect(page.locator('#resume-run')).toHaveCount(0);
  expect(state.executes).toHaveLength(1);
});

test('lost execute response retries the same key; reload restores the actual task', async ({ page }) => {
  const state=fixture(); state.checkStatus='ready'; await setup(page,state); state.dropExecute=true;
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
  await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('保存结果尚未确认');
  await expect(page.locator('#execute-input')).toBeDisabled(); expect(state.inputs).toHaveLength(1);
  await page.getByRole('button',{name:'重新读取',exact:true}).click();
  await page.getByRole('button',{name:'继续上次提交'}).click();
  await expect(page.locator('#execution-preflight')).not.toBeEmpty();
  expect(state.inputs).toHaveLength(1); expect(state.executes).toHaveLength(0);
});

test('double click and edits during submission preserve the locked request', async ({ page }) => {
  const state=fixture(); state.checkStatus='ready'; await setup(page,state); state.holdExecute=true;
  await page.locator('#execute-input').click(); await expect.poll(()=>!!state.releaseExecute).toBe(true);
  await expect(page.locator('#execute-input')).toBeDisabled();
  await page.getByLabel('补充募集书更新说明').fill('下一轮的补充'); state.releaseExecute!();
  await expect(page.locator('#execution-progress .task-progress')).toHaveAttribute('data-input-revision','1');
  expect(state.executes).toHaveLength(1); expect(state.executes[0].input_hash).toBe(state.snapshots.get(1)!.input_hash);
});

test('editing while preflight is pending discards that result; next action locks a new revision', async ({ page }) => {
  const state=await setup(page); state.holdCheck=true;
  await page.locator('#execute-input').click(); await expect.poll(()=>!!state.releaseCheck).toBe(true);
  await page.getByLabel('补充募集书更新说明').fill('只供下一版使用'); state.releaseCheck!(); state.holdCheck=false;
  await expect(page.locator('#execution-preflight')).toBeEmpty(); expect(state.executes).toHaveLength(0);
  await expect(page.locator('#start-disabled-reason')).toContainText('尚未保存');
  await page.getByLabel('补充募集书更新说明').fill('');
  await prepare(page);
  await expect.poll(()=>state.inputs.length).toBe(2); state.checkStatus='ready'; await page.locator('#recheck-input').click();
  await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress .task-progress')).toHaveAttribute('data-input-revision','2');
});

test('409 preserves target input and never submits a run', async ({ page }) => {
  const state=await setup(page); state.conflictSave=true; await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('版本已变化');
  expect(state.project.update_details!.reporting_cutoff).toBe('2025-12-31');
  expect(state.inputs).toHaveLength(1); expect(state.executes).toHaveLength(0);
});

test('unified rejection leaves history optional and preserves saved financial material', async ({ page }) => {
  const state=fixture(); state.materials.shift(); state.checkStatus='ready';
  state.executeError={status:409,code:'INPUT_REQUIRED',correlation_id:'synthetic-history-required'};
  await setup(page,state); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('历史／参考募集书选填');
  await expect(page.locator('#execution-message')).toContainText('错误编号：synthetic-history-required');
  await expect(page.locator('#execute-input')).toBeDisabled();
  expect(state.materials).toHaveLength(1); expect(state.runs.size).toBe(0);
});

test('legacy reference plus audit upgrades to unified input without requiring a new project', async ({ page }) => {
  const state=fixture(); state.project.update_details!.has_historical=false;
  Object.assign(state.materials[0], { role: 'reference', parse_snapshot_id: 'synthetic-snapshot' });
  state.checkStatus='ready';
  state.executeError={status:409,code:'INPUT_REQUIRED',correlation_id:'synthetic-generation-required'};
  await setup(page,state); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('历史／参考募集书选填');
  await expect(page.locator('#execution-message')).toContainText('无需更改企业关系或重复上传');
  expect(state.materials[0].role).toBe('reference');
  await expect(page.locator('#execution-message')).toContainText('错误编号：synthetic-generation-required');
  await expect(page.locator('#execute-input')).toBeDisabled();
  if (process.env.BB_361_ERROR_EVIDENCE_DIR) {
    for (const [device, width, height] of [['desktop',1440,960],['mobile',390,844]] as const) {
      await page.setViewportSize({width,height});
      await page.locator('#execution-message').scrollIntoViewIfNeeded();
      await page.screenshot({path:join(process.env.BB_361_ERROR_EVIDENCE_DIR,`generation-input-${device}.png`)});
    }
  }
  expect(state.inputs[0].material_versions).toHaveLength(2);
  expect(state.runs.size).toBe(0);
  await page.reload(); await expect(page.locator('#execute-input')).toBeEnabled();
  expect(state.project.update_details!.has_historical).toBeNull();
  expect(state.project.update_details!.authoring_mode).toBe('unified_v1');
});

test('a unified INPUT_REQUIRED preserves source roles and rechecks the same immutable input', async ({ page }) => {
  const state=fixture(); state.project.update_details!.has_historical=false;
  Object.assign(state.materials[0], { role:'reference' });
  state.preflightError={status:409,code:'INPUT_REQUIRED',correlation_id:'synthetic-preflight-role'};
  await setup(page,state); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('历史／参考募集书选填');
  await expect(page.locator('#execution-message')).toContainText('错误编号：synthetic-preflight-role');
  await expect(page.locator('#execute-input')).toBeDisabled();
  await expect(page.locator('#recheck-input')).toBeVisible();
  await page.locator('#recheck-input').click();
  await expect.poll(()=>state.preflights.length).toBe(2);
  await expect(page.locator('#execute-input')).toBeDisabled();
  expect(state.inputs).toHaveLength(1); expect(state.executes).toHaveLength(0);
  expect(state.preflights[0]).toEqual(state.preflights[1]);
  if (process.env.BB_361_START_EVIDENCE_DIR) {
    const output=resolve(process.env.BB_361_START_EVIDENCE_DIR); await mkdir(output,{recursive:true});
    for (const [device,width,height] of [['desktop',1440,960],['mobile',390,844]] as const) {
      await page.setViewportSize({width,height});
      await page.locator('#execution-message').scrollIntoViewIfNeeded();
      await page.screenshot({path:join(output,`reference-role-${device}.png`)});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
  }
  state.preflightError=undefined;
  state.checkStatus='blocked'; state.blockers=['issuer_identity_not_bound:historical_material_not_selected'];
  await page.locator('#recheck-input').click();
  await expect(page.locator('#execution-preflight')).toContainText('发行人身份核验尚未完成');
  await expect(page.locator('#execute-input')).toBeDisabled();
  expect(state.inputs).toHaveLength(1); expect(state.executes).toHaveLength(0);
  expect(state.materials.map(m=>m.role)).toEqual(['reference','audit']);
});

test('recheck replaces rejected input v3 with current v7 materials without submitting a run', async ({ page }) => {
  const state=fixture(); state.nextInputRevision=3;
  state.preflightError={status:409,code:'INPUT_REQUIRED',correlation_id:'synthetic-stale-input'};
  await setup(page,state); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('错误编号：synthetic-stale-input');
  expect(state.preflights[0].input_revision).toBe(3);

  state.project.draft_revision=4;
  state.project.input_revision=7;
  state.project.input_hash=hash('synthetic-current-v7');
  state.materials.push({...state.materials[0],material_id:'synthetic-current-history',material_version:2,filename:'current-history.docx'});
  state.project.update_details!.source_prospectuses!.push({...state.project.update_details!.source_prospectuses![0],material_id:'synthetic-current-history',material_version:2});
  state.snapshots.set(7,{...state.snapshots.get(3)!,input_revision:7,input_hash:state.project.input_hash,
    material_versions:state.materials.map(m=>({material_id:m.material_id,material_version:m.material_version}))});
  await page.locator('#recheck-input').click();
  await expect(page.locator('#execution-message')).toContainText('项目已保存更新的输入版本');
  await expect(page.locator('#workspace-material-count')).toContainText('3 份已保存材料');
  await expect(page.locator('#material-partitions')).toContainText('current-history.docx');
  await expect(page.locator('#execute-input')).toBeEnabled();
  await expect(page.locator('#select-saved-input')).toBeHidden();
  if (process.env.BB_489_STALE_EVIDENCE_DIR) {
    const output=resolve(process.env.BB_489_STALE_EVIDENCE_DIR); await mkdir(output,{recursive:true});
    for (const [device,width,height] of [['desktop',1440,960],['mobile',390,844]] as const) {
      await page.setViewportSize({width,height});
      await page.locator('#execution-message').scrollIntoViewIfNeeded();
      await page.screenshot({path:join(output,`stale-input-${device}.png`)});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
  }
  expect(state.preflights).toHaveLength(1);
  expect(state.executes).toHaveLength(0);
  expect(state.runActions).toHaveLength(0);
  expect(state.inputs).toHaveLength(1);
});

test('v3 recheck restores failed test run v8; explicit new input v9 uses a distinct production key', async ({ page }) => {
  const state=fixture(); state.nextInputRevision=3;
  state.preflightError={status:409,code:'INPUT_REQUIRED',correlation_id:'synthetic-stale-failed-run'};
  await setup(page,state); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('错误编号：synthetic-stale-failed-run');
  const old=state.snapshots.get(3)!;
  state.project.input_revision=8; state.project.input_hash=hash('synthetic-failed-v8');
  state.snapshots.set(8,{...old,input_revision:8,input_hash:state.project.input_hash});
  const occupiedKey=`web-update-${hash(JSON.stringify([id,8,state.project.input_hash]))}`;
  state.runs.set(occupiedKey,{run_id:'synthetic-existing-failed-run',execution_request_id:occupiedKey,
    project_id:id,input_revision:8,input_hash:state.project.input_hash,channel:'non_production_test',test_grant_id:'synthetic-test-grant',uncovered_items:[],
    state:'failed',stage:'materials_ready',event_cursor:2,billing_mode:'platform_trial',reservation_id:null,
    artifact_id:null,prompt_snapshot_ref:null,updated_at:now});
  await page.locator('#recheck-input').click();
  await expect(page.locator('#execution-progress')).toContainText('本轮未完成');
  await expect(page.locator('#execution-progress')).toContainText('这是内部测试任务');
  await expect(page.locator('#execution-progress')).toContainText('正式更新需保存新输入版本');
  expect(state.preflights).toHaveLength(1);
  expect(state.executes).toHaveLength(0);
  expect(state.runActions).toHaveLength(0);
  await expect(page.locator('#resume-run')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'下载修订版',exact:true})).toHaveCount(0);
  if (process.env.BB_489_STALE_EVIDENCE_DIR) {
    const output=resolve(process.env.BB_489_STALE_EVIDENCE_DIR); await mkdir(output,{recursive:true});
    for (const [device,width,height] of [['desktop',1440,960],['mobile',390,844]] as const) {
      await page.setViewportSize({width,height});
      await page.locator('#execution-progress').scrollIntoViewIfNeeded();
      await page.screenshot({path:join(output,`stale-test-run-${device}.png`)});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
  }
  state.preflightError=undefined; state.checkStatus='ready'; state.nextInputRevision=9;
  await page.getByRole('button',{name:'继续修改',exact:true}).click();
  await expect(page.locator('#execute-input')).toBeEnabled();
  await page.locator('#execute-input').click();
  await expect.poll(()=>state.executes.length).toBe(1);
  const fresh=state.snapshots.get(9)!;
  const productionKey=`web-update-${hash(JSON.stringify([id,9,fresh.input_hash]))}`;
  await expect.poll(()=>state.inputs.length).toBe(2);
  expect(state.project.input_revision).toBe(9);
  expect(state.preflights.at(-1)).toEqual({input_revision:9,input_hash:fresh.input_hash});
  expect(state.executes[0].execution_request_id).toBe(productionKey);
  expect(productionKey).not.toBe(occupiedKey);
  expect(state.executes[0]).not.toHaveProperty('test_grant_id');
  expect(state.runs.get(occupiedKey)?.state).toBe('failed');
  expect(state.runs.get(productionKey)?.channel).toBe('production');
  expect(state.runActions).toHaveLength(0);
});

test('stale recheck with a dirty local draft stops without writing it over the fresh project', async ({ page }) => {
  const state=fixture(); state.nextInputRevision=3;
  state.preflightError={status:409,code:'INPUT_REQUIRED',correlation_id:'synthetic-dirty-stale'};
  await setup(page,state); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('错误编号：synthetic-dirty-stale');
  const initialPatches=state.patchRequests; // Explicit start migrates this legacy draft once.
  state.project.draft_revision=4; state.project.input_revision=8; state.project.input_hash=hash('synthetic-dirty-v8');
  state.snapshots.set(8,{...state.snapshots.get(3)!,input_revision:8,input_hash:state.project.input_hash});
  state.holdProjectRead=true;
  await page.locator('#recheck-input').click();
  await expect.poll(()=>Boolean(state.releaseProjectRead)).toBe(true);
  await page.locator('#edit-project-details').click();
  await page.locator('#name').fill('未保存的旧草稿名称');
  state.releaseProjectRead?.();
  await expect(page.locator('#conflict-panel')).toBeVisible();
  await expect(page.locator('#execute-input')).toBeDisabled();
  if (process.env.BB_489_STALE_EVIDENCE_DIR) {
    const output=resolve(process.env.BB_489_STALE_EVIDENCE_DIR); await mkdir(output,{recursive:true});
    for (const [device,width,height] of [['desktop',1440,960],['mobile',390,844]] as const) {
      await page.setViewportSize({width,height});
      await page.locator('#conflict-panel').scrollIntoViewIfNeeded();
      await page.screenshot({path:join(output,`stale-dirty-${device}.png`)});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
  }
  await page.waitForTimeout(900);
  expect(state.patchRequests).toBe(initialPatches);
  expect(state.project.name).toBe('合成任务项目');
  page.once('dialog', dialog=>{ void dialog.accept(); });
  await page.locator('#reload-draft').click();
  await expect(page.locator('#execution-message')).toContainText('项目已保存更新的输入版本');
  await expect(page.locator('#name')).toHaveValue('合成任务项目');
  expect(state.patchRequests).toBe(initialPatches);
  expect(state.executes).toHaveLength(0);
});

test('recheck rejects an inconsistent latest input without retrying the old revision', async ({ page }) => {
  const state=fixture(); state.nextInputRevision=3;
  state.preflightError={status:409,code:'INPUT_REQUIRED',correlation_id:'synthetic-stale-mismatch'};
  await setup(page,state); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('错误编号：synthetic-stale-mismatch');
  state.project.input_revision=7; state.project.input_hash=hash('synthetic-expected-v7');
  state.snapshots.set(7,{...state.snapshots.get(3)!,input_revision:7,input_hash:hash('synthetic-wrong-v7')});
  await page.locator('#recheck-input').click();
  await expect(page.locator('#execution-message')).toContainText('当前结果无法核实');
  expect(state.preflights).toHaveLength(1);
  expect(state.executes).toHaveLength(0);
  await expect(page.locator('#execute-input')).toBeDisabled();
});

test('unified input includes reference materials and does not ask for reclassification', async ({ page }) => {
  const state=fixture(); state.materials[0].role='reference';
  state.preflightError={status:409,code:'INPUT_REQUIRED',correlation_id:'synthetic-excluded-reference'};
  await setup(page,state); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('历史／参考募集书选填');
  expect(state.inputs[0].material_versions).toEqual(state.materials.map(m=>({material_id:m.material_id,material_version:1})));
  await page.reload(); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('历史／参考募集书选填');
  expect(state.materials[0].role).toBe('reference'); expect(state.executes).toHaveLength(0);
});

test('a legacy generation rejection keeps references optional and supports rechecking', async ({ page }) => {
  const state=fixture(); state.project.kind='generation'; state.project.update_details!.has_historical=false;
  Object.assign(state.materials[0], {role:'reference',parse_snapshot_id:'synthetic-snapshot'});
  state.preflightError={status:409,code:'INPUT_REQUIRED',correlation_id:'synthetic-generation-preflight'};
  await setup(page,state); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('历史／参考募集书选填');
  await expect(page.locator('#execution-message')).toContainText('无需更改企业关系或重复上传');
  await expect(page.locator('#execution-message')).not.toContainText('更正分类');
  await expect(page.locator('#execute-input')).toBeDisabled();
  state.preflightError=undefined; state.checkStatus='ready';
  await page.locator('#recheck-input').click();
  await expect(page.locator('#execute-input')).toBeEnabled();
  expect(state.inputs).toHaveLength(1); expect(state.executes).toHaveLength(0);
  await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  expect(state.inputs).toHaveLength(1); expect(state.executes).toHaveLength(1);
  expect(state.executes[0].task_kind).toBe('generation');
});

test('preflight processing wait checks the same input without calling the file damaged or generation unavailable', async ({ page }) => {
  const state=fixture();
  state.preflightError={status:409,code:'CAPABILITY_NOT_READY',correlation_id:'synthetic-processing-wait'};
  await setup(page,state); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('材料或处理条件尚未就绪');
  await expect(page.locator('#execution-message')).toContainText('错误编号：synthetic-processing-wait');
  await expect(page.locator('#execution-message')).not.toContainText(/损坏|尚未开放全文更新/);
  await expect(page.locator('#execute-input')).toBeDisabled();
  await page.locator('#recheck-input').click();
  await expect.poll(()=>state.preflights.length).toBe(2);
  expect(state.inputs).toHaveLength(1); expect(state.executes).toHaveLength(0);
  expect(state.preflights[1]).toEqual(state.preflights[0]);
  state.preflightError=undefined; state.checkStatus='ready';
  await page.locator('#recheck-input').click();
  await expect(page.locator('#execute-input')).toBeEnabled();
  await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  expect(state.inputs).toHaveLength(1); expect(state.executes).toHaveLength(1);
});

test('temporary start failure retains support reference and does not claim missing materials', async ({ page }) => {
  const state=fixture(); state.checkStatus='ready';
  state.executeError={status:503,code:'DATA_UNAVAILABLE',correlation_id:'synthetic-start-unavailable'};
  await setup(page,state); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('服务暂时无法完成操作，结果尚未确认');
  await expect(page.locator('#execution-message')).toContainText('错误编号：synthetic-start-unavailable');
  await expect(page.locator('#execution-message')).not.toContainText('填写内容');
  expect(state.runs.size).toBe(0);
});

test('unified authoring includes all uploaded source materials without a second selection form', async ({ page }) => {
  const state=fixture(); state.materials.push({...state.materials[0],material_id:'synthetic-reference',role:'reference',filename:'reference.docx'});
  state.project.update_details!.source_prospectuses!.push({...state.project.update_details!.source_prospectuses![0],material_id:'synthetic-reference',relation:'similar_business'});
  await setup(page,state); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-preflight')).not.toBeEmpty();
  expect(state.inputs[0].material_versions).toEqual(state.materials.map(m=>({material_id:m.material_id,material_version:1})));
  expect(state.inputs[0]).not.toHaveProperty('target_confirmation');
  await expect(page.locator('#execution-actions input, #execution-actions select')).toHaveCount(0);
});

test('legacy generation task kind is retained with unified source metadata', async ({ page }) => {
  const state=fixture();
  state.project.kind='generation';
  state.project.update_details={...state.project.update_details!,has_historical:false};
  const reference={...state.materials[0],material_id:'synthetic-reference',role:'reference' as const,filename:'reference.docx',parse_snapshot_id:'synthetic-snapshot'};
  state.materials=[reference as Dto<'MaterialResponse'>,state.materials[1]];
  Object.assign(state.project.update_details!.source_prospectuses![0],{material_id:'synthetic-reference',relation:'similar_business'});
  state.checkStatus='ready';
  await setup(page,state);
  await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  expect(state.preflights).toHaveLength(1);
  expect(state.executes).toHaveLength(1);
  expect(state.executes[0].task_kind).toBe('generation');
  expect(state.executes[0].execution_request_id).toMatch(/^web-generation-/);
  expect(state.inputs[0].material_versions).toEqual([
    {material_id:'synthetic-reference',material_version:1},{material_id:'synthetic-audit',material_version:1}]);
  // Source metadata is pinned from the saved project by the API; no separate reference-library gate.
  expect(state.inputs[0]).not.toHaveProperty('user_reference');
  expect(state.project.update_details!.authoring_mode).toBe('unified_v1');
  await expect(page.locator('#execution-message')).not.toContainText('解析快照');
});

test('reference parsing is handled by the unified worker after an immutable task is submitted', async ({ page }) => {
  const state=fixture(); state.project.kind='generation';
  state.project.update_details={...state.project.update_details!,has_historical:false};
  state.materials=[{...state.materials[0],material_id:'synthetic-reference',role:'reference',filename:'reference.docx'},state.materials[1]];
  Object.assign(state.project.update_details!.source_prospectuses![0],{material_id:'synthetic-reference',relation:'similar_business'});
  state.checkStatus='ready'; await setup(page,state); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  expect(state.inputs).toHaveLength(1); expect(state.executes).toHaveLength(1);
  expect(state.inputs[0].material_versions).toEqual(state.materials.map(m=>({material_id:m.material_id,material_version:1})));
  expect(state.inputs[0]).not.toHaveProperty('user_reference');
});

test('unified input rejection preserves the selected version without silently substituting newer material', async ({ page }) => {
  const state=fixture(); state.checkStatus='ready'; state.conflictSave=true;
  await setup(page,state);
  Object.assign(state.materials[0],{material_version:2,sha256:hash('history-v2')});
  await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText('消息或项目版本已变化');
  expect(state.inputs).toHaveLength(1); expect(state.inputs[0].material_versions[0].material_version).toBe(1);
  expect(state.executes).toHaveLength(0); expect(state.runs.size).toBe(0);
});

test('manual task refresh invalidates a late paused poll without replaying task actions', async ({ page }) => {
  // Freeze the scheduled five-second poll so only explicit refreshes can change the state.
  await page.clock.install({time:new Date(now)});
  await page.clock.pauseAt(new Date(Date.parse(now)+1000));
  const state=fixture(); state.checkStatus='ready'; state.holdRunRead=true;
  await setup(page,state); await page.locator('#execute-input').click();
  await expect.poll(()=>Boolean(state.releaseRunRead)).toBe(true);
  const run=[...state.runs.values()][0]; run.state='running';
  await page.getByRole('button',{name:'重新读取',exact:true}).click();
  await expect(page.locator('#execution-progress')).toContainText('正在根据材料编制募集书');
  state.releaseRunRead!();
  await expect.poll(()=>state.runReads).toBeGreaterThanOrEqual(3);
  await expect(page.locator('#execution-progress')).toContainText('正在根据材料编制募集书');
  await expect(page.locator('#recheck-paused')).toHaveCount(0);
  expect(state.inputs).toHaveLength(1); expect(state.executes).toHaveLength(1);
  expect(state.runActions).toHaveLength(0); expect(state.runs.size).toBe(1);
});

test('paginated recovery and real task actions keep one run', async ({ page }) => {
  const state=fixture(); state.parseSucceeded=true; state.checkStatus='ready'; await setup(page,state); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  state.paginate=true; state.eventPages=[]; state.listPages=[]; await page.reload();
  await expect(page.locator('#execution-progress')).toContainText('适用规则的处理条件尚未就绪');
  expect(state.listPages).toContain('page-two'); expect(state.eventPages).toContain('1');
  state.checkStatus='blocked'; await page.locator('#recheck-paused').click();
  await expect(page.locator('#resume-run')).toHaveCount(0);
  await expect(page.locator('#recheck-paused')).toBeEnabled();
  expect(state.runActions).toHaveLength(0);
  if (process.env.BB_UX_EVIDENCE_DIR) {
    const output = resolve(process.env.BB_UX_EVIDENCE_DIR); await mkdir(output, { recursive: true });
    for (const [label, width, height] of [['desktop', 1440, 960], ['mobile', 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); scrollTo(0, 0); });
      await page.screenshot({ path: join(output, `paused-${label}.png`), fullPage: true });
    }
  }
  state.checkStatus='ready'; await page.locator('#recheck-paused').click();
  await page.getByRole('button',{name:'继续更新',exact:true}).click();
  await expect(page.locator('#execution-progress')).toContainText('正在根据材料编制募集书');
  const run=[...state.runs.values()][0]; run.state='paused'; state.eventSeq=4;
  state.eventHistory=[
    {seq:2,state:'paused',stage:'capability_not_ready',reason:state.runReason},
    {seq:3,state:'queued',stage:'queued',reason:'user_resumed'},
    {seq:4,state:'paused',stage:'capability_not_ready',reason:state.runReason}
  ];
  await page.getByRole('button',{name:'重新读取',exact:true}).click();
  await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  await expect(page.locator('#resume-run')).toHaveCount(0);
  await expect(page.locator('#recheck-paused')).toHaveCount(0);
  await expect(page.locator('.execution-summary')).toContainText('重复继续不会推进');
  state.eventHistory = [
    ...state.eventHistory.slice(0, 2),
    ...Array.from({ length: 14 }, (_, i) => ({
      seq: i + 4, state: 'running' as const, stage: 'model_generation', reason: 'progress'
    })),
    { ...state.eventHistory[2], seq: 18 }
  ];
  state.eventSeq = 18;
  await page.reload();
  await expect(page.locator('.execution-summary')).toContainText('重复继续不会推进');
  await expect(page.locator('#resume-run')).toHaveCount(0);
  state.eventHistory.push({seq:19,state:'paused',stage:'capability_not_ready',reason:'issuer_material_missing'});
  state.eventSeq=19;
  await page.reload();
  await expect(page.locator('#recheck-paused')).toBeVisible();
  expect(state.runActions).toEqual([`/runs/${run.run_id}/resume`]);
  run.state='running';
  await expect(page.locator('#cancel-run')).toBeVisible({ timeout: 10000 });
  await page.getByRole('button',{name:'停止本次任务',exact:true}).click();
  await expect(page.locator('#execution-progress')).toContainText('本轮已停止'); expect(state.runs.size).toBe(1);
});

test('resumed source-input task shows compilation without a false blocker', async ({ page }) => {
  const state = fixture(); state.checkStatus = 'ready';
  state.runStage = 'awaiting_materials'; state.runReason = 'authoring_source_information_required';
  await setup(page, state); await page.locator('#execute-input').click();
  await expect(page.locator('.execution-summary')).toContainText('旧任务保留原输入');
  const run = [...state.runs.values()][0]; const inputHash = run.input_hash;
  run.state = 'running'; run.stage = 'provider_call';
  state.runReason = 'provider_call_may_be_sent'; state.eventSeq++;
  await page.reload();
  await expect(page.locator('#execution-progress')).toContainText('正在编制募集书');
  await expect(page.locator('.execution-summary')).toHaveCount(0);
  await expect(page.locator('#execution-progress')).not.toContainText('联系支持');
  await expect(page.locator('#project-conversation-root')).not.toBeVisible();
  expect(state.executes).toHaveLength(1); expect(run.input_hash).toBe(inputHash);
  if (process.env.BB_RUNNING_UX_DIR) {
    for (const [name, width, height] of [['desktop',1440,960],['mobile',390,844]] as const) {
      await page.setViewportSize({width,height});
      await page.screenshot({path:join(process.env.BB_RUNNING_UX_DIR,`running-${name}.png`)});
    }
  }
});

test('provider timeout explains service recovery and keeps the same task after automatic retry', async ({ page }) => {
  const state=fixture();state.checkStatus='ready';state.runStage='provider_reconcile';state.runReason='provider_result_pending';
  await setup(page,state);await page.locator('#execute-input').click();
  await expect(page.locator('.execution-summary')).toContainText('无需补充材料');
  await expect(page.locator('.execution-summary')).not.toContainText('待处理条件');
  await expect(page.locator('#project-conversation-root')).not.toBeVisible();
  const run=[...state.runs.values()][0];const hash=run.input_hash;
  if(process.env.BB_TIMEOUT_UX_DIR){
    await mkdir(process.env.BB_TIMEOUT_UX_DIR,{recursive:true});
    for(const [name,width,height] of [['desktop',1440,960],['mobile',390,844]] as const){
      await page.setViewportSize({width,height});await page.screenshot({path:join(process.env.BB_TIMEOUT_UX_DIR,`recovery-${name}.png`)});
    }
  }
  run.state='running';run.stage='provider_call';state.runReason='provider_call_may_be_sent';state.eventSeq++;
  await page.reload();await expect(page.locator('#execution-progress')).toContainText('正在编制募集书');
  await expect(page.locator('.execution-summary')).toHaveCount(0);expect(state.executes).toHaveLength(1);expect(run.input_hash).toBe(hash);
  run.state='failed';run.stage='failed';state.runReason='provider_timeout_retries_exhausted';state.eventSeq++;
  await page.reload();await expect(page.locator('.execution-summary')).toContainText('编制服务多次响应超时');
  await expect(page.locator('#prepare-next-version')).toBeVisible();
});

test('account switch ignores an in-flight execute result', async ({ page }) => {
  const state=fixture(); state.checkStatus='ready'; await setup(page,state); state.holdExecute=true;
  await page.locator('#execute-input').click(); await expect.poll(()=>!!state.releaseExecute).toBe(true);
  await page.evaluate(()=>{const channel=new BroadcastChannel('bondbuddy-session');channel.postMessage('changed');channel.close();});
  await expect(page.getByLabel('用户名',{exact:true})).toBeVisible(); state.releaseExecute!();
  await expect(page.locator('#execution-progress')).toHaveCount(0); await expect(page.locator('.project-cowork')).toHaveCount(0);
});

test('foreign execute response is rejected', async ({ page }) => {
  const state=fixture(); state.checkStatus='ready'; await setup(page,state); state.lateRunForeign=true;
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
  await expect(page.locator('#execution-preflight')).toContainText('当前处理条件尚未就绪');
  await expect(page.locator('#execution-preflight img')).toHaveCount(0);
  state.checkStatus='ready'; await page.locator('#recheck-input').click();
  await page.locator('#execute-input').click(); await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  await page.evaluate(()=>{ document.activeElement instanceof HTMLElement && document.activeElement.blur(); scrollTo(0,0); });
  await page.screenshot({path:join(tmpdir(),'bb361-paused-desktop.png'),fullPage:true});
  for (const [status, file] of [['running','running'],['awaiting_input','awaiting'],['failed','failed']] as const) {
    [...state.runs.values()][0].state=status; await page.getByRole('button',{name:'重新读取',exact:true}).click();
    await expect(page.locator('#execution-progress')).toContainText(status==='running'?'正在根据材料编制募集书':status==='awaiting_input'?'等待补充信息':'本轮未完成');
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
  await page.getByRole('button',{name:'编辑项目信息'}).click();
  await page.getByLabel('其他已知信息').fill('下一轮补充');
  await expect(page.locator('#save-state')).toHaveText('已保存');
  await page.getByRole('button',{name:'保存并继续'}).click();
  await prepare(page); expect(state.inputs[1].credit_facility_supplements).toEqual([pin]);
});

test('failed task recovery cannot enable a new snapshot until the server record is read', async ({page})=>{
  const state=await setup(page);
  await page.route('**/api/v1/projects?*',route=>json(route,503,{code:'DATA_UNAVAILABLE'}));
  await page.reload();
  await expect(page.locator('#execution-message')).not.toBeEmpty();
  await expect(page.locator('#execute-input')).toBeDisabled();
  expect(state.inputs).toHaveLength(0); expect(state.executes).toHaveLength(0);
  await page.unroute('**/api/v1/projects?*'); await page.getByRole('button',{name:'重新读取',exact:true}).click();
  await expect(page.locator('#execute-input')).toBeEnabled();
});

test('a test terminal state in the production channel never exposes a deliverable',async({page})=>{
  const state=fixture(); state.checkStatus='ready'; await setup(page,state); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  const run=[...state.runs.values()][0];run.state='test_completed';run.artifact_id='invalid-artifact';
  await page.getByRole('button',{name:'重新读取',exact:true}).click();
  await expect(page.locator('#execution-delivery')).toBeEmpty();
  await expect(page.getByRole('button',{name:'下载修订版',exact:true})).toHaveCount(0);
});

test('continuing after completion creates a new input and retains the preceding successful artifact without reload',async({page})=>{
  const state=fixture(); state.checkStatus='ready'; await setup(page,state); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  const first=[...state.runs.values()][0]; first.state='succeeded'; first.artifact_id='first-successful-artifact';
  await page.getByRole('button',{name:'重新读取',exact:true}).click();
  await expect(page.locator('#execution-progress')).toContainText('已生成');
  await page.getByRole('button',{name:'继续修改',exact:true}).click();
  await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress .task-progress')).toHaveAttribute('data-input-revision','2');
  await expect(page.getByRole('link',{name:'查看此前成功成果'})).toHaveAttribute('href','#/artifacts/first-successful-artifact');
  expect(state.runs.size).toBe(2);
  expect(state.executes[0].input_hash).toBe(state.snapshots.get(1)!.input_hash);
  expect(state.executes[0].execution_request_id).not.toBe(state.executes[1].execution_request_id);
});


for (const [reason, message] of [
  ['model_tokens_per_user_per_day', '今日试用额度已用完，额度恢复后自动继续。'],
  ['kill_switch', '更新服务暂时停用，服务恢复后自动继续。']]) {
  test(`trial pause ${reason}: reload and automatic recovery preserve one run`, async ({ page }) => {
    const state = fixture(); state.checkStatus = 'ready'; state.runStage = 'trial_limit'; state.runReason = reason;
    await setup(page, state); await page.locator('#execute-input').click();
    await expect(page.locator('.execution-summary')).toHaveText(message);
    await expect(page.getByRole('button', { name: '继续更新', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '查看材料', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '查看此前成功成果' })).toBeVisible();
    if (reason === 'model_tokens_per_user_per_day' && process.env.BB_TRIAL_UX_DIR) {
      for (const [label, width, height] of [['desktop', 1440, 960], ['mobile', 390, 844]] as const) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); scrollTo(0, 0); });
        await page.screenshot({ path: join(process.env.BB_TRIAL_UX_DIR, `trial-${label}.png`), fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    }
    await page.reload();
    await expect(page.locator('.execution-summary')).toHaveText(message);
    await expect(page.locator('#resume-run')).toHaveCount(0);
    const run = [...state.runs.values()][0];
    const originalInput = run.input_hash;
    run.state = 'queued'; state.runReason = 'trial_limit_cleared'; state.eventSeq++;
    await expect(page.locator('.execution-summary')).toHaveText('试用限制已解除，任务继续处理。', { timeout: 10000 });
    await expect(page.locator('#execution-progress')).toContainText('等待开始');
    await expect(page.locator('#cancel-run')).toBeVisible();
    expect(state.runActions).toEqual([]); expect(state.executes).toHaveLength(1);
    expect(state.inputs).toHaveLength(1); expect(run.input_hash).toBe(originalInput);
  });
}

test('trial stage stays honest without events; a different paused stage discards the old limit reason', async ({ page }) => {
  const state = fixture(); state.checkStatus = 'ready'; state.runStage = 'trial_limit'; state.failEvents = true;
  await setup(page, state); await page.locator('#execute-input').click();
  await expect(page.locator('.execution-summary')).toHaveText('当前更新暂受试用限制，限制解除后自动继续。');
  await expect(page.locator('#resume-run')).toHaveCount(0);
  state.failEvents = false; state.runReason = 'model_tokens_per_user_per_day';
  await expect(page.locator('.execution-summary')).toContainText('今日试用额度已用完', { timeout: 10000 });
  const run = [...state.runs.values()][0];
  run.stage = 'capability_not_ready'; state.eventSeq++; state.eventStage = 'trial_limit';
  // A delayed event for the previous paused stage must not describe the new pause.
  await expect(page.locator('#recheck-paused')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#resume-run')).toHaveCount(0);
  await expect(page.locator('.execution-summary')).toContainText('处理条件尚未就绪');
  await page.locator('#recheck-paused').click();
  await expect(page.locator('#resume-run')).toBeVisible();
  await page.locator('#resume-run').click();
  await expect(page.locator('#execution-progress')).toContainText('正在根据材料编制募集书');
  expect(state.runActions).toEqual([`/runs/${run.run_id}/resume`]);
  expect(state.executes).toHaveLength(1);
});

test('operator denial remains a failed task without automatic-recovery guidance', async ({ page }) => {
  const state = fixture(); state.checkStatus = 'ready'; state.runState = 'failed'; state.runStage = 'model_generation';
  state.runReason = ''; state.eventError = 'TRIAL_ACCESS_DENIED';
  await setup(page, state); await page.locator('#execute-input').click();
  await expect(page.locator('#execution-progress')).toContainText('本轮未完成');
  await expect(page.locator('.execution-summary')).toHaveText('当前账号的试用权限已停用，请联系支持。');
  await expect(page.locator('#execution-progress')).not.toContainText('自动继续');
  await expect(page.locator('#resume-run')).toHaveCount(0);
  expect(state.runActions).toEqual([]); expect(state.executes).toHaveLength(1);
});


for (const [label, width, height] of [['desktop', 1440, 960], ['mobile', 390, 844]] as const) {
  test(`lost upload acknowledgement restores start without resending ${label}`, async ({ page, context }) => {
    const state = fixture();
    state.project.update_details!.authoring_mode='unified_v1';
    const puts: string[] = [];
    let completes = 0, creates = 0;
    await page.setViewportSize({ width, height });
    await page.route('**/api/v1/**/materials/uploads**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path.endsWith('/uploads')) {
        creates++;
        return json(route, 201, { upload_id:'lost-upload', state:'uploading', upload_url:`/api/v1/projects/${id}/materials/uploads/lost-upload/bytes`, expires_at:now, max_bytes:100_000_000 });
      }
      if (path.endsWith('/bytes')) { puts.push(path); return route.fulfill({status:204}); }
      if (path.endsWith('/complete')) {
        completes++;
        const body = request.postDataJSON();
        state.materials.push({material_id:'lost-material', material_version:1, upload_id:'lost-upload', role:'audit', filename:'lost.pdf', media_type:'application/pdf', byte_size:body.byte_size, sha256:body.sha256, state:'persisted', persisted_at:now, error:null});
        return route.abort('connectionreset');
      }
      return route.fallback();
    });
    await setup(page, state);
    await page.getByLabel('为审计报告（可含报表及附注）选择文件').setInputFiles({name:'lost.pdf', mimeType:'application/pdf', buffer:Buffer.from('%PDF synthetic lost acknowledgement')});
    const row = page.locator('.material-file-row').filter({hasText:'lost.pdf'});
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('服务器已确认保存');
    await expect(page.locator('[data-processing-key]')).toHaveCount(0);
    await expect(page.getByText('处理状态不可用', {exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'开始编制',exact:true})).toBeEnabled();
    expect({creates, completes, puts:puts.length}).toEqual({creates:1, completes:1, puts:1});
    expect(state.inputs).toHaveLength(0); expect(state.executes).toHaveLength(0);
    if (process.env.BB_UPLOAD_RECOVERY_EVIDENCE_DIR) {
      const output = resolve(process.env.BB_UPLOAD_RECOVERY_EVIDENCE_DIR); await mkdir(output, {recursive:true});
      await page.screenshot({path:join(output,`recovered-${label}.png`),fullPage:true});
    }
  });

  test(`material workflow ${label}: upload, retry, pending evidence, one-click execution and reopen`, async ({ page, context }) => {
    const state = fixture(); state.materials = []; state.checkStatus = 'needs_confirmation';
    state.runState = 'running'; state.runStage = 'model_generation'; state.runReason = '';
    const uploads = new Map<string, { filename: string; role: string; media_type: Dto<'MaterialResponse'>['media_type'] }>();
    const unexpected: string[] = []; let failAudit = true, completed = false;
    let releaseSave: (() => void) | undefined;
    await page.setViewportSize({ width, height });
    await context.route('**/api/v1/**/materials/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path.endsWith('/source-profile') || path.endsWith('/ocr')) { unexpected.push(path); return json(route, 500, { code: 'UNEXPECTED_REVIEW_REQUEST' }); }
      if (path.endsWith('/materials/uploads')) {
        const uploadId = `synthetic-upload-${uploads.size + 1}`;
        uploads.set(uploadId, request.postDataJSON());
        return json(route, 201, { upload_id: uploadId, state: 'uploading', upload_url: `/api/v1/projects/${id}/materials/uploads/${uploadId}/bytes`, expires_at: now, max_bytes: 100_000_000 });
      }
      if (path.endsWith('/bytes')) return route.fulfill({ status: 204 });
      if (path.endsWith('/complete')) {
        const uploadId = path.split('/').at(-2)!, upload = uploads.get(uploadId)!;
        if (upload.role === 'audit' && failAudit) { failAudit = false; return json(route, 422, { code: 'MATERIAL_CONTENT_MISMATCH' }); }
        if (upload.role === 'historical' && !releaseSave) await new Promise<void>(resolve => { releaseSave = resolve; });
        const body = request.postDataJSON();
        const material: Dto<'MaterialResponse'> = { material_id: `material-${uploadId}`, material_version: 1, upload_id: uploadId,
          role: upload.role as Dto<'MaterialResponse'>['role'], filename: upload.filename, media_type: upload.media_type,
          byte_size: body.byte_size, sha256: body.sha256, state: 'persisted', persisted_at: now, error: null };
        state.materials.push(material); return json(route, 200, material);
      }
      if (path.endsWith('/parse-job')) {
        const material = state.materials.find(m => m.material_id === path.split('/').at(-2))!;
        return json(route, 200, { job_id: `job-${material.material_id}`, job_type: 'parse', subtype: 'material_parse', project_id: id,
          material_id: material.material_id, material_version: 1, material_sha256: material.sha256, parser_version: 'synthetic-v1',
          state: completed ? 'succeeded' : 'running', stage: completed ? 'succeeded' : 'historical_profile',
          completed_stages: ['parse_evidence'], attempts: 1, max_attempts: 3, error_code: null,
          outcome: completed ? 'needs_confirmation' : null, parse_status: completed ? 'needs_confirmation' : null,
          profile_version: completed && material.role === 'historical' ? 1 : null, pending_capabilities: [], updated_at: now });
      }
      return route.fallback();
    });
    // setup's catch-all was registered last; it must fall back to the material fixture above.
    await setup(page, state, false);
    await page.getByLabel('为历史／参考募集书选择文件').setInputFiles({ name: '合成历史稿.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('%PDF synthetic history') });
    const history = page.locator('.material-file-row').filter({ hasText: '合成历史稿.docx' });
    await expect(history).toContainText('正在保存');
    expect(releaseSave).toBeDefined(); releaseSave!();
    await expect(history).toContainText('处理中');
    await page.getByLabel('为审计报告（可含报表及附注）选择文件').setInputFiles({ name: '合成财务材料.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF synthetic financial') });
    const financial = page.locator('.material-file-row').filter({ hasText: '合成财务材料.pdf' });
    await expect(financial.getByRole('button', { name: '重试此文件' })).toBeVisible();
    await expect(history).toContainText('服务器已确认保存');
    await financial.getByRole('button', { name: '重试此文件' }).click();
    await expect(financial).toContainText('服务器已确认保存');
    completed = true;
    await page.getByRole('button', { name: '刷新已保存材料' }).click();
    await expect(page.locator('.processing-title')).toHaveText(['处理完成', '处理完成']);
    await expect(page.locator('.source-profile, [data-source-correction], a[href$="/ocr"], .workspace-evidence, .fact-review')).toHaveCount(0);
    await expect(page.locator('#material-partitions')).not.toContainText(/evidence-|native_text|历史稿信息|核对识别内容|待确认项/);
    expect(state.materials).toHaveLength(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    if (process.env.BB_UX_EVIDENCE_DIR) {
      const output = resolve(process.env.BB_UX_EVIDENCE_DIR); await mkdir(output, { recursive: true });
      await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); scrollTo(0, 0); });
      await page.screenshot({ path: join(output, `materials-${label}.png`), fullPage: true });
    }
    const source = history.locator('[data-source-material]');
    await source.getByLabel('与目标发行人的关系',{exact:true}).selectOption('same_issuer');
    await source.getByLabel('原发行市场',{exact:true}).selectOption('sse');
    await source.getByLabel('原品种',{exact:true}).selectOption('private');
    await source.getByRole('radio',{name:'年末',exact:true}).check();
    await page.getByRole('button', { name: '开始编制', exact: true }).click();
    await expect(page.locator('#execution-progress')).toContainText('生成全文内容');
    await expect(page.locator('#execution-preflight')).toBeHidden();
    await expect(page.getByRole('button', { name: '保留待确认项并开始编制' })).toHaveCount(0);
    expect(state.inputs).toHaveLength(1); expect(state.executes).toHaveLength(1);
    expect(state.inputs[0]).not.toHaveProperty('target_confirmation');
    expect(state.inputs[0].material_versions).toEqual(state.materials.map(m => ({ material_id: m.material_id, material_version: 1 })));
    const locked = structuredClone(state.executes[0]);
    await page.reload(); await expect(page.locator('#execution-progress')).toContainText('生成全文内容');
    const url = page.url(); await page.close(); page = await context.newPage(); await page.goto(url);
    await expect(page.locator('#execution-progress')).toContainText('生成全文内容');
    await page.getByRole('button', { name: '查看材料' }).click();
    await expect(page.locator('.processing-title')).toHaveCount(0);
    await expect(page.locator('.material-file-row')).toHaveCount(2);
    expect(state.executes).toEqual([locked]); expect(unexpected).toEqual([]);
  });
}

test('all-projects update keeps its list context through progress, edit and refresh',async({page})=>{
 const state=fixture();state.checkStatus='ready';state.runState='running';state.runStage='file_authoring';state.runReason='';
 await setup(page,state);await page.locator('#execute-input').click();await expect(page.locator('#execution-progress .task-progress')).toContainText('编制募集书');
 await page.goto('/#tasks');await page.getByRole('link',{name:'合成任务项目',exact:true}).click();
 await expect(page.locator('.sidebar a.active')).toContainText('全部项目');await expect(page.locator('#workspace-progress .task-progress')).toBeVisible();
 await page.getByRole('button',{name:'编辑项目信息',exact:true}).click();await expect(page).toHaveURL(/from=projects/);await expect(page.locator('.sidebar a.active')).toContainText('全部项目');
 await page.getByRole('button',{name:/保存并继续/}).click();await page.reload();
 await expect(page.locator('.sidebar a.active')).toContainText('全部项目');await expect(page.locator('#workspace-progress .task-progress')).toBeVisible();
 expect(state.executes).toHaveLength(1);
});


// Project-list links and refreshed step URLs carry navigation context in the query.
// It must not prevent the material workspace from accepting its own read/upload results.
for (const scenario of [
  { name: 'project list', query: null, width: 1440, height: 960 },
  { name: 'reloaded material step', query: 'step=materials&from=projects', width: 390, height: 844 },
  { name: 'query order and run link', query: 'from=projects&step=materials&run=synthetic-run-1', width: 1440, height: 960 },
]) test(`cancel then supplement materials from ${scenario.name}`, async ({ page }) => {
  const state = fixture(); state.checkStatus = 'ready'; state.runState = 'running'; state.runStage = 'file_authoring'; state.runReason = '';
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: scenario.width, height: scenario.height });
  await setup(page, state); await page.locator('#execute-input').click();
  await expect(page.locator('#cancel-run')).toBeVisible();
  const originalInput = structuredClone(state.inputs[0]);
  if (scenario.query === null) {
    await page.goto('/#tasks'); await page.getByRole('link', { name: state.project.name, exact: true }).click();
  } else await page.goto(`/#/projects/${id}?${scenario.query}`);
  await expect(page).toHaveURL(/from=projects/);
  await page.getByRole('button', { name: '停止本次任务', exact: true }).click();
  await expect(page.locator('#execution-progress')).toContainText('本轮已停止');
  await page.getByRole('button', { name: '继续修改', exact: true }).click();
  await expect(page.locator('#material-recovery-status')).toContainText('已恢复 2 份材料');
  await expect(page.locator('.material-file-row')).toHaveCount(2);
  // Re-entering the cancelled project must recover the same files before editing.
  await page.reload();
  await page.getByRole('button', { name: '继续修改', exact: true }).click();
  await expect(page.locator('#material-recovery-status')).toContainText('已恢复 2 份材料');
  const picker = page.getByLabel('为审计报告（可含报表及附注）选择文件');
  await expect(picker).toBeEnabled();
  let byteUploads = 0;
  await page.route(`**/api/v1/projects/${id}/materials/uploads**`, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/bytes')) { byteUploads++; return route.fulfill({ status: 204 }); }
    if (path.endsWith('/complete')) {
      const receipt: Dto<'MaterialResponse'> = { material_id: 'synthetic-supplement', material_version: 1, upload_id: 'synthetic-supplement-upload',
        role: 'audit', filename: 'supplement.txt', media_type: 'text/plain', ...route.request().postDataJSON(), state: 'persisted', persisted_at: now, error: null };
      state.materials.push(receipt); return json(route, 200, receipt);
    }
    return json(route, 201, { upload_id: 'synthetic-supplement-upload', state: 'uploading',
      upload_url: `/api/v1/projects/${id}/materials/uploads/synthetic-supplement-upload/bytes`, expires_at: '2099-01-01T00:00:00Z', max_bytes: 100_000_000 });
  });
  await picker.setInputFiles({ name: 'supplement.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic supplementary material') });
  await expect(page.locator('.material-file-row').filter({ hasText: 'supplement.txt' })).toContainText('服务器已确认保存');
  await expect(page.locator('#workspace-material-count')).toHaveText('3 份已保存材料');
  await expect(page.locator('#material-recovery-status')).toContainText('已恢复 3 份材料');
  await expect(page.locator('#execute-input')).toBeEnabled();
  await page.locator('#execute-input').click({ trial: true });
  const evidence = process.env.BB_UX_EVIDENCE_DIR;
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, `cancel-supplement-${scenario.width}-${scenario.query === null ? 'list' : 'step'}.png`) });
  }
  await page.reload(); await page.getByRole('button', { name: '查看材料', exact: true }).click();
  await expect(page.locator('.material-file-row')).toHaveCount(3);
  await expect(picker).toBeDisabled();
  expect(byteUploads).toBe(1); expect(state.runActions).toEqual(['/runs/synthetic-run-1/cancel']);
  expect(state.executes).toHaveLength(1); expect(state.inputs).toEqual([originalInput]);
  expect(errors).toEqual([]);
});

test('credit visibility: quote precedes execution and running receipt follows settlement and retry',async({page})=>{
  const state=fixture(); state.paid=true; state.checkStatus='ready'; state.available=100000; state.runState='running'; state.runStage='provider_call';
  await page.setViewportSize({width:1440,height:960}); await setup(page,state);
  await expect(page.locator('#execution-credit-hint')).toContainText('确认报价后');
  await page.locator('#execute-input').click();
  await expect(page.locator('#fixed-quote')).toContainText('本次需要 17,900 积分');
  await expect(page.locator('#fixed-quote')).toContainText('预留后可用 82,100 积分');
  expect(state.executes).toHaveLength(0);
  const evidence=process.env.BB_UX_EVIDENCE_DIR;
  if(evidence){await mkdir(evidence,{recursive:true});await page.locator('#fixed-quote').scrollIntoViewIfNeeded();await page.screenshot({path:join(evidence,'implementation-quote.png')});}
  state.available=82100; state.frozen=17900;
  await page.locator('#execute-input').click();
  await expect(page.locator('.task-credit-receipt')).toContainText('17,900 积分 · 已预留');
  await expect(page.locator('.credit-wallet .wallet-value strong')).toHaveText('100,000');await expect(page.locator('.credit-wallet')).toContainText('可用 82,100');
  await expect(page.locator('.credit-wallet')).toContainText('任务已预留 17,900');
  if(evidence){await page.locator('#workspace-progress').scrollIntoViewIfNeeded();await page.screenshot({path:join(evidence,'implementation-running.png')});}
  state.chargeState='settled'; state.frozen=0;
  [...state.runs.values()][0].state='succeeded';
  await expect(page.locator('.task-credit-receipt')).toContainText('已扣费',{timeout:12000});
  await expect(page.locator('.credit-wallet')).toContainText('暂无预留积分');await expect(page.locator('.credit-wallet .wallet-value strong')).toHaveText('82,100');
  state.chargeFailure=true; await page.locator('#refresh-run-charge').click();
  await expect(page.locator('.task-credit-receipt')).toContainText('暂未同步');
  state.chargeFailure=false; state.chargeState='released'; state.available=100000;
  await page.locator('#refresh-run-charge').click();
  await expect(page.locator('.task-credit-receipt')).toContainText('已返还，本次不扣费');
  await expect(page.locator('.credit-wallet')).toContainText('100,000');
});

test('credit visibility: trial explains zero charge before and during execution',async({page})=>{
  const state=fixture(); state.checkStatus='ready'; state.runState='running'; state.runStage='provider_call';
  await setup(page,state);
  await expect(page.locator('#execution-credit-hint')).toHaveText('当前为试用编制，本次不扣积分。');
  await page.locator('#execute-input').click();
  await expect(page.locator('.task-credit-receipt')).toHaveText('本次任务按提交时的试用规则执行，不扣积分。');
  await expect(page.locator('#fixed-quote')).toBeHidden();
  expect(state.executes[0].quote_id).toBeUndefined();
});


test('credit visibility: an in-flight old receipt is refreshed after the run completes',async({page})=>{
  const state=fixture(); state.paid=true;state.checkStatus='ready';state.available=100000;state.runState='running';state.runStage='provider_call';
  await setup(page,state);let release!:()=>void, reads=0;
  await page.route('**/credit-charge',async route=>{
    const first=++reads===1;if(first)await new Promise<void>(resolve=>{release=resolve;});
    return json(route,200,{quote:{points:17900},state:first?'held':'settled'});
  });
  await page.locator('#execute-input').click();await page.locator('#execute-input').click();
  await expect.poll(()=>reads).toBe(1);
  [...state.runs.values()][0].state='succeeded';
  await expect(page.locator('#execution-progress')).toContainText('文档已生成，可下载',{timeout:12000});
  release();await expect(page.locator('.task-credit-receipt')).toContainText('已扣费');expect(reads).toBeGreaterThan(1);
});


test('dashboard update preserves filtered workbench context through execution, edit, reload and return',async({page})=>{
 const state=fixture();state.checkStatus='ready';state.runState='running';state.runStage='file_authoring';state.runReason='';
 await setup(page,state);await page.locator('#execute-input').click();await expect(page.locator('#execution-progress .task-progress')).toContainText('编制募集书');
 await page.goto('/#dashboard?kind=update&status=active');await page.locator('.dashboard-primary-action').click();
 await expect(page.locator('.nav-item.active')).toHaveText('工作台');await expect(page.locator('#workspace-progress .task-progress')).toBeVisible();
 await page.getByRole('button',{name:'编辑项目信息',exact:true}).click();await page.getByRole('button',{name:/保存并继续/}).click();await page.reload();
 await expect(page.locator('.nav-item.active')).toHaveText('工作台');await expect(page.locator('#workspace-progress .task-progress')).toBeVisible();
 await page.getByRole('link',{name:'返回工作台'}).click();await expect(page.locator('[data-dashboard-kind=update]')).toHaveAttribute('aria-pressed','true');await expect(page.locator('#dashboard-status')).toHaveValue('active');expect(state.executes).toHaveLength(1);
});


for (const reloadBeforeDelete of [false, true]) test(`replace mistaken historical upload (${reloadBeforeDelete ? 'restored' : 'same session'})`, async ({ page }) => {
  const state = fixture(); state.checkStatus = 'ready'; state.runState = 'running'; state.runStage = 'file_authoring'; state.runReason = '';
  await page.setViewportSize({width: reloadBeforeDelete ? 390 : 1440, height: reloadBeforeDelete ? 844 : 960});
  await setup(page, state);
  await page.locator('#execute-input').click();
  await expect(page.locator('#cancel-run')).toBeVisible();
  const originalInput = structuredClone(state.inputs[0]);
  await page.getByRole('button', {name:'停止本次任务',exact:true}).click();
  await page.getByRole('button', {name:'继续修改',exact:true}).click();
  let failDelete = false, deletes = 0, nextName = '', sequence = 0;
  await page.route(`**/api/v1/projects/${id}/materials/*`, async route => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    deletes++;
    if (failDelete) { failDelete = false; return json(route,503,{code:'DATA_UNAVAILABLE'}); }
    const materialId = new URL(route.request().url()).pathname.split('/').at(-1);
    state.materials.splice(state.materials.findIndex(m => m.material_id === materialId),1);
    return route.fulfill({status:204});
  });
  await page.route(`**/api/v1/projects/${id}/materials/uploads**`, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/bytes')) return route.fulfill({status:204});
    if (path.endsWith('/complete')) {
      const material: Dto<'MaterialResponse'> = {material_id:`replacement-${sequence}`,material_version:1,upload_id:`upload-${sequence}`,
        role:'historical',filename:nextName,media_type:'application/pdf',...route.request().postDataJSON(),state:'persisted',persisted_at:now,error:null};
      state.materials.push(material); return json(route,200,material);
    }
    nextName = route.request().postDataJSON().filename; sequence++;
    return json(route,201,{upload_id:`upload-${sequence}`,state:'uploading',upload_url:`/api/v1/projects/${id}/materials/uploads/upload-${sequence}/bytes`,expires_at:'2099-01-01T00:00:00Z',max_bytes:100000000});
  });
  const remove = async (name:string, accept=true) => {
    page.once('dialog', dialog => accept ? dialog.accept() : dialog.dismiss());
    await page.locator('.material-file-row').filter({hasText:name}).getByRole('button',{name:'删除',exact:true}).click();
  };
  await remove('history.docx');
  await expect(page.locator('.material-file-row').filter({hasText:'history.docx'})).toHaveCount(0);
  await expect.poll(()=>state.project.update_details!.source_prospectuses).toEqual([]);
  const picker = page.getByLabel('为历史／参考募集书选择文件');
  await picker.setInputFiles({name:'误传募集书.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF synthetic wrong')});
  const wrong = page.locator('.material-file-row').filter({hasText:'误传募集书.pdf'});
  await expect(wrong).toContainText('服务器已确认保存');
  await wrong.locator('[data-source-field="relation"]').selectOption('parent');
  await expect.poll(()=>state.project.update_details!.source_prospectuses?.[0]?.relation).toBe('parent');
  if (reloadBeforeDelete) { await page.reload(); await page.getByRole('button',{name:'继续修改',exact:true}).click(); }
  await remove('误传募集书.pdf',false);
  expect(deletes).toBe(1);
  await expect(wrong).toBeVisible();
  failDelete = true; await remove('误传募集书.pdf');
  await expect(wrong.getByRole('button',{name:'删除',exact:true})).toBeEnabled();
  expect(state.materials.some(m=>m.filename==='误传募集书.pdf')).toBe(true);
  await remove('误传募集书.pdf');
  await expect(wrong).toHaveCount(0);
  await expect.poll(()=>state.project.update_details!.source_prospectuses).toEqual([]);
  await picker.setInputFiles({name:'正确募集书.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF synthetic correct')});
  const correct = page.locator('.material-file-row').filter({hasText:'正确募集书.pdf'});
  await expect(correct).toContainText('服务器已确认保存');
  await expect(correct.locator('[data-source-field="issuer_name"]')).toHaveCount(0);
  await expect(correct.locator('[data-source-field="relation"]')).toHaveValue('');
  await correct.locator('[data-source-field="relation"]').selectOption('same_issuer');
  await correct.locator('[data-source-field="market"]').selectOption('sse');
  await correct.locator('[data-source-field="offering"]').selectOption('private');
  await correct.locator('[data-source-field="year"]').selectOption('2024');
  await correct.locator('[data-source-field="quarter"][value="12-31"]').check();
  await expect(page.locator('#execute-input')).toBeEnabled();
  await expect.poll(()=>state.project.update_details!.source_prospectuses?.[0]?.reporting_periods.length).toBeGreaterThan(0);
  const evidence=process.env.BB_UX_EVIDENCE_DIR;
  if(evidence) {await mkdir(evidence,{recursive:true});await correct.evaluate(el=>el.scrollIntoView({block:'start'}));await page.evaluate(()=>window.scrollBy(0,-90));await page.screenshot({path:join(evidence,`implementation-${reloadBeforeDelete?'mobile':'desktop'}.png`)});}
  await page.reload();
  await page.getByRole('button',{name:'继续修改',exact:true}).click();
  await expect(correct).toBeVisible();
  await expect(page.locator('.material-file-row')).toHaveCount(2);
  await page.locator('#execute-input').click();
  await expect.poll(()=>state.inputs.length).toBe(2);
  expect(state.inputs[0]).toEqual(originalInput);
  expect(state.inputs[1].material_versions.map(m=>m.material_id).sort()).toEqual(['replacement-2','synthetic-audit']);
  expect(JSON.stringify(state.inputs[1])).not.toContain('replacement-1');
  expect(JSON.stringify(state.inputs[1])).not.toContain('误传发行人');
});
test('uploaded source without an issuer name can start and preserves target identity', async ({page}) => {
  const state=fixture();state.checkStatus='ready';
  state.project.update_details!.source_prospectuses![0].issuer_name=null;
  await setup(page,state);
  await expect(page.getByLabel('原发行人名称',{exact:true})).toHaveCount(0);
  await page.locator('[data-source-field="relation"]').selectOption('parent');
  await expect.poll(()=>state.project.update_details!.source_prospectuses![0].relation).toBe('parent');
  expect(state.project.update_details!.source_prospectuses![0].issuer_name).toBeNull();
  expect(state.project.issuer_name).toBe('合成发行人');
  const evidence=process.env.BB_NO_SOURCE_ISSUER_EVIDENCE_DIR;
  if(evidence) {
    await mkdir(evidence,{recursive:true});
    for(const [name,width,height] of [['desktop',1440,960],['mobile',390,844]] as const) {
      await page.setViewportSize({width,height});
      await page.locator('[data-source-material]').evaluate(el=>el.scrollIntoView({block:'start'}));
      await page.evaluate(()=>window.scrollBy(0,-90));
      await page.screenshot({path:join(evidence,'implementation-'+name+'.png')});
    }
  }
  await page.locator('#execute-input').click();
  await expect.poll(()=>state.executes.length).toBe(1);
  expect(state.project.update_details!.source_prospectuses![0].issuer_name).toBeNull();
});
