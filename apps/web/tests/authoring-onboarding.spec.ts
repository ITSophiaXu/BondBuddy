import {serveDisabledBillingCatalog} from './billing-fixture-wire';
import {fixtureJson,fixtureRequest} from './billing-fixture-wire';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { emptyUpdateDetails, schemas } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';
import { FormatRegistry } from '@sinclair/typebox';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Dto } from './billing-fixture-wire';
import { taskPage } from './collection-fixtures';

// Synthetic public HTTP boundary in Chromium. This does not accept real parsing, billing, models or Word output.
const projectId = 'synthetic-onboarding-project';
const now = '2026-10-25T03:00:00Z';
// Value does not install JSON Schema formats. These fixtures use one fixed,
// valid RFC3339 timestamp; reject anything else rather than skip the format.
FormatRegistry.Set('date-time', value => value === now);
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const emptyMessages = { version: 1, content_sha256: sha256('bondbuddy:empty-project-messages'), message_ids: [] };
type Details = NonNullable<Dto<'ProjectResponse'>['update_details']>;
type Call = { method: string; path: string; body?: unknown };
type LockedInput = { request: Dto<'InputRevisionCreateRequest'>; project: Dto<'ProjectResponse'>; response: Dto<'InputRevisionResponse'> };

function fixture() {
  const project: Dto<'ProjectResponse'> = {
    project_id: projectId, name: '已保存的自定义项目名', issuer_name: '合成发行人有限公司', kind: 'update',
    market: 'sse', offering: 'private', draft_revision: 1, input_revision: null, input_hash: null, updated_at: now,
    update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1', source_prospectuses: [], reporting_cutoff: '2026-06-30' }
  };
  return {
    project, created: [] as Dto<'ProjectCreateRequest'>[], patches: [] as { body: Dto<'ProjectPatchRequest'>; ifMatch: string | undefined }[],
    materials: [] as Dto<'MaterialResponse'>[], uploads: new Map<string, { request: Dto<'UploadCreateRequest'>; bytes?: Buffer }>(),
    locked: [] as LockedInput[], preflights: [] as Dto<'PreflightRequest'>[], quotes: [] as Dto<'FixedQuoteRequest'>[],
    executes: [] as Dto<'ExecuteRequest'>[], runs: new Map<string, Dto<'RunResponse'>>(), quote: null as Dto<'FixedQuoteResponse'>['quote'],
    calls: [] as Call[], unexpected: [] as string[], errors: [] as string[], failNextPatch: false
  };
}
type State = ReturnType<typeof fixture>;
const installed = new WeakMap<Page, State>();

function checked<T extends keyof typeof schemas>(name: T, value: unknown): asserts value is Dto<T> {
  expect(Value.Check(schemas[name], value), `${name}: ${JSON.stringify([...Value.Errors(schemas[name], value)])}`).toBe(true);
}
async function reply<T extends keyof typeof schemas>(route: Route, name: T, body: Dto<T>, status = 200) {
  checked(name, body);
  await route.fulfill({ status, contentType: 'application/json', body: fixtureJson(route,body) });
}
const errorReply = (route: Route, status: number, code: string) => route.fulfill({ status, contentType: 'application/json', body: fixtureJson(route,{ code }) });
const writes = (state: State) => state.calls.filter(call => call.method !== 'GET');
function expectNoExecution(state: State) {
  expect(state.locked).toHaveLength(0); expect(state.preflights).toHaveLength(0);
  expect(state.quotes).toHaveLength(0); expect(state.executes).toHaveLength(0);
}

async function install(page: Page, state = fixture()) {
  installed.set(page, state);
  page.on('pageerror', error => state.errors.push(error.message));
  await page.context().route('**/api/v1/**', async route => {
    if(await serveDisabledBillingCatalog(route))return;
    const request = route.request(), url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', ''), method = request.method();
    const body: unknown = request.headers()['content-type']?.includes('application/json') && request.postData() ? fixtureRequest(request) : undefined;
    state.calls.push({ method, path, ...(body === undefined ? {} : { body: structuredClone(body) }) });
    if (method === 'GET' && path === '/me') return reply(route, 'MeResponse', { user_id: 'synthetic-owner', session_status: 'active' });
    if (method === 'GET' && path === '/account') return reply(route, 'AccountResponse', {
      user_id: 'synthetic-owner', username: 'synthetic', phone_masked: null, status: 'active', created_at: now,
      accepted_terms_version: null, current_terms_version: null, password_updated_at: null,
      self_service_recovery: 'unavailable', support_contact: null
    });
    if (method === 'GET' && path === '/credits/balance') return reply(route, 'CreditBalanceResponse', { enabled: true, available: 1, frozen: 0 });
    if (method === 'GET' && path === '/m4/topics') return route.fulfill({ contentType: 'application/json', body: fixtureJson(route,{ topics: [] }) });
    if (path === '/projects' && method === 'POST') {
      checked('ProjectCreateRequest', body); state.created.push(structuredClone(body));
      const { creation_request_id: _creationRequestId, ...fields } = body;
      state.project = { ...fields, project_id: projectId, draft_revision: 1, input_revision: null, input_hash: null, updated_at: now };
      return reply(route, 'ProjectResponse', state.project, 201);
    }
    if (path === '/projects' && method === 'GET') return reply(route, 'ProjectListResponse', {
      items: [{ project_id: projectId, name: state.project.name, draft_revision: state.project.draft_revision, updated_at: now, kind: state.project.kind,
        issuer_name: state.project.issuer_name, market: state.project.market, offering: state.project.offering, latest_run: null, latest_artifact: null }],
      page: { has_more: false, next_cursor: null }
    });
    if (path === `/projects/${projectId}` && method === 'PATCH') {
      checked('ProjectPatchRequest', body);
      const ifMatch = request.headers()['if-match']; state.patches.push({ body: structuredClone(body), ifMatch });
      if (ifMatch !== String(state.project.draft_revision)) return errorReply(route, 409, 'DRAFT_REVISION_CONFLICT');
      if (state.failNextPatch) { state.failNextPatch = false; return route.abort('connectionreset'); }
      state.project = { ...state.project, ...structuredClone(body), draft_revision: state.project.draft_revision + 1, updated_at: now };
      return reply(route, 'ProjectResponse', state.project);
    }
    if (path === `/projects/${projectId}` && method === 'GET') return reply(route, 'ProjectResponse', state.project);
    if (path === `/projects/${projectId}/tasks` && method === 'GET') return reply(route, 'ProjectTasksResponse', taskPage(projectId, [...state.runs.values()], state.project.kind));
    if (path === `/projects/${projectId}/events` && method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? 0);
      return reply(route, 'ProjectEventsResponse', { items: state.materials.map((material, index) => ({
        event_id: `onboarding-material-${index}`, schema_version: 1 as const, trace_id: 'synthetic-trace', project_id: projectId,
        seq: index + 1, occurred_at: now, type: 'material.upload_progress' as const, payload: { material_id: material.material_id }
      })).filter(event => event.seq > after), next_cursor: null });
    }
    if (path === `/projects/${projectId}/messages` && method === 'GET') return reply(route, 'ProjectMessagePage', {
      conversation_id: projectId, items: [], project_message_set_ref: emptyMessages, next_cursor: null, has_more: false
    });
    if (path === `/projects/${projectId}/prospectus-versions` && method === 'GET') {
      const historical = state.materials.find(material => material.role === 'historical');
      return reply(route, 'ProspectusVersionsResponse', {
        project_id: projectId, current_version_id: historical ? 'synthetic-source-version' : null, selection_revision: historical ? 1 : 0,
        inactive_material_ids: [], versions: historical ? [{
          version_id: 'synthetic-source-version', sequence: 1, origin: 'upload', filename: historical.filename, sha256: historical.sha256,
          created_at: now, material_id: historical.material_id, material_version: historical.material_version,
          artifact_id: null, artifact_version: null, revision_artifact_id: null, run_id: null
        }] : []
      });
    }
    if (path === `/projects/${projectId}/materials/uploads` && method === 'POST') {
      checked('UploadCreateRequest', body);
      const uploadId = `synthetic-upload-${state.uploads.size + 1}`;
      state.uploads.set(uploadId, { request: structuredClone(body) });
      return reply(route, 'UploadSessionResponse', { upload_id: uploadId, state: 'uploading',
        upload_url: `/api/v1/projects/${projectId}/materials/uploads/${uploadId}/bytes`, expires_at: '2099-01-01T00:00:00Z', max_bytes: 100 * 1024 * 1024 }, 201);
    }
    const uploadMatch = path.match(new RegExp(`^/projects/${projectId}/materials/uploads/([^/]+)/(bytes|complete)$`));
    if (uploadMatch) {
      const upload = state.uploads.get(uploadMatch[1]); expect(upload).toBeDefined();
      if (uploadMatch[2] === 'bytes' && method === 'PUT') {
        const bytes = request.postDataBuffer(); expect(bytes).not.toBeNull();
        expect(bytes!.byteLength).toBe(upload!.request.byte_size); expect(sha256(bytes!)).toBe(upload!.request.sha256);
        upload!.bytes = Buffer.from(bytes!); return route.fulfill({ status: 204 });
      }
      if (uploadMatch[2] === 'complete' && method === 'POST') {
        checked('UploadCompleteRequest', body); expect(upload!.bytes).toBeDefined();
        expect(body).toEqual({ byte_size: upload!.bytes!.byteLength, sha256: sha256(upload!.bytes!) });
        const material: Dto<'MaterialResponse'> = { ...upload!.request, material_id: `synthetic-material-${state.materials.length + 1}`,
          material_version: 1, upload_id: uploadMatch[1], state: 'persisted', persisted_at: now, error: null };
        state.materials.push(material); return reply(route, 'MaterialResponse', material);
      }
    }
    const material = state.materials.find(value => path === `/projects/${projectId}/materials/${value.material_id}`);
    if (material && method === 'GET') return reply(route, 'MaterialResponse', material);
    if (method === 'GET' && state.materials.some(value => path === `/projects/${projectId}/materials/${value.material_id}/parse-job`)) return errorReply(route, 404, 'NOT_FOUND');
    if (path === `/projects/${projectId}/input-revisions` && method === 'POST') {
      checked('InputRevisionCreateRequest', body);
      expect(body.draft_revision).toBe(state.project.draft_revision);
      expect(body.prospectus_selection_revision).toBe(0);
      expect(body.material_versions).toEqual(state.materials.map(value => ({ material_id: value.material_id, material_version: value.material_version })));
      expect(body.project_message_set_ref).toEqual(emptyMessages); expect(body.requirement_message_ids).toEqual([]);
      const response: Dto<'InputRevisionResponse'> = { project_id: projectId, input_revision: state.locked.length + 1,
        input_hash: sha256(JSON.stringify(body)), material_versions: structuredClone(body.material_versions),
        target_confirmation: { status: 'unconfirmed', market: null, offering: null, as_of: null, document_purpose: null,
          target_reporting_periods: [], confirmed_at: null, confirmed_by: null }, rule_pack_version: null, template_version: null, reference_release: null, created_at: now };
      // The public snapshot DTO pins a draft revision, not the private authoring manifest.
      state.locked.push({ request: structuredClone(body), project: structuredClone(state.project), response: structuredClone(response) });
      state.project.input_revision = response.input_revision; state.project.input_hash = response.input_hash;
      return reply(route, 'InputRevisionResponse', response, 201);
    }
    const revisionMatch = path.match(new RegExp(`^/projects/${projectId}/input-revisions/(\\d+)$`));
    if (revisionMatch && method === 'GET') {
      const locked = state.locked.find(value => value.response.input_revision === Number(revisionMatch[1])); expect(locked).toBeDefined();
      return reply(route, 'InputRevisionResponse', locked!.response);
    }
    if (path === `/projects/${projectId}/preflight` && method === 'POST') {
      checked('PreflightRequest', body); state.preflights.push(structuredClone(body));
      const snapshot = state.locked.at(-1)!.response;
      expect(body).toEqual({ input_revision: snapshot.input_revision, input_hash: snapshot.input_hash });
      return reply(route, 'PreflightResponse', { project_id: projectId, ...body, status: 'ready', missing_inputs: [],
        blocking_inputs: [], advisory_inputs: [], uncertainty: [], billing_mode: 'fixed_credits' });
    }
    if (path === `/projects/${projectId}/credit-quote` && method === 'POST') {
      checked('FixedQuoteRequest', body); state.quotes.push(structuredClone(body)); expect(body).toEqual(state.preflights.at(-1));
      state.quote = { quote_id: 'synthetic-onboarding-quote', project_id: projectId, ...body,
        task_type: 'interim', points: 17900, price_version: 'synthetic-v1', reason: '合成一期编制', created_at: now };
      return reply(route, 'FixedQuoteResponse', { enabled: true, quote: state.quote, balance: { available: 1, frozen: 0 }, shortage: 17899, reason: null });
    }
    if (path === '/runs/execute' && method === 'POST') {
      checked('ExecuteRequest', body); state.executes.push(structuredClone(body));
      const snapshot = state.locked.at(-1)!.response;
      expect(body.project_id).toBe(projectId); expect(body.input_revision).toBe(snapshot.input_revision);
      expect(body.input_hash).toBe(snapshot.input_hash); expect(body.quote_id).toBe(state.quote!.quote_id);
      let run = state.runs.get(body.execution_request_id);
      if (!run) {
        run = { run_id: 'synthetic-onboarding-run', execution_request_id: body.execution_request_id, project_id: projectId,
          input_revision: body.input_revision, input_hash: body.input_hash, state: 'queued', stage: 'queued', event_cursor: 0,
          channel: 'production', test_grant_id: null, uncovered_items: [], billing_mode: 'fixed_credits', reservation_id: null,
          artifact_id: null, prompt_snapshot_ref: null, updated_at: now };
        state.runs.set(body.execution_request_id, run);
      }
      return reply(route, 'RunResponse', run, 202);
    }
    const run = [...state.runs.values()].find(value => path === `/runs/${value.run_id}` || path.startsWith(`/runs/${value.run_id}/`));
    if (run && method === 'GET') {
      if (path === `/runs/${run.run_id}/events`) return reply(route, 'RunEventsResponse', { items: [], next_cursor: null });
      if (path === `/runs/${run.run_id}/credit-charge`) return reply(route, 'RunCreditChargeResponse', { quote: state.quote, state: 'held' });
      if (path === `/runs/${run.run_id}/stream`) return route.fulfill({ contentType: 'text/event-stream', body: ': synthetic polling fallback\n\n' });
      if (path === `/runs/${run.run_id}`) return reply(route, 'RunResponse', run);
    }
    state.unexpected.push(`${method} ${path}`);
    return errorReply(route, 501, 'UNEXPECTED_SYNTHETIC_REQUEST');
  });
  return state;
}

test.afterEach(async ({ page }) => {
  const state = installed.get(page); if (!state) return;
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

const groups = (page: Page) => page.locator('details.update-optional-section');
const groupFor = (page: Page, control: string) => groups(page).filter({ has: page.locator(control) });
async function setOpen(group: Locator, open: boolean) {
  if (await group.evaluate(element => (element as HTMLDetailsElement).open) !== open) await group.locator(':scope > summary').click();
  await expect(group).toHaveJSProperty('open', open);
}
async function allCollapsed(page: Page) {
  await expect(groups(page)).toHaveCount(5);
  for (const group of await groups(page).all()) await expect(group).toHaveJSProperty('open', false);
}
async function screenshot(page: Page, name: string) {
  const directory = process.env.BB_UX_EVIDENCE_DIR; if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); scrollTo(0, 0); });
  await page.screenshot({ path: join(directory, name), fullPage: true });
}
async function existingDetails(page: Page, state = fixture()) {
  await install(page, state); await page.goto(`/#/projects/${projectId}?step=details`);
  await expect(page.locator('#draft-form')).toBeVisible(); await expect(page.locator('#save-state')).toHaveText('已保存');
  return state;
}
async function fillOptionalGroups(page: Page) {
  for (const group of await groups(page).all()) await setOpen(group, true);
  await page.locator('#registration_amount').fill('2.5');
  await page.locator('[name=registration_amount_unit]').selectOption('hundred_million');
  await page.locator('#issuance_amount').fill('12500');
  await page.locator('[name=issuance_amount_unit]').selectOption('ten_thousand');
  await page.locator('#bond_terms').fill('3年期，按年付息，到期还本。');
  await page.locator('#underwriting').fill('合成证券牵头承销，合成银行联席。');
  await page.locator('#other_agencies').fill('合成律师事务所负责法律意见。');
  await page.locator('#rating_enhancement').fill('主体AA+，由合成保证人提供保证。');
  await page.locator('#add-purpose').click(); await page.locator('#purpose_0').selectOption('refinance_bonds');
  await page.locator('#use_amount_0').fill('9000'); await page.locator('[name=use_amount_0_unit]').selectOption('ten_thousand');
  await page.locator('#use_target_0').fill('合成存续债券'); await page.locator('#use_details_0').fill('按到期兑付计划偿还。');
  await page.locator('#add-purpose').click(); await page.locator('#purpose_1').selectOption('repay_debt');
  await page.locator('#use_amount_1').fill('35000000'); await page.locator('[name=use_amount_1_unit]').selectOption('yuan');
  await page.locator('#use_target_1').fill('合成银行借款'); await page.locator('#use_details_1').fill('置换银行流动资金借款。');
  await page.locator('#other_information').fill('授信额度及使用情况将在材料区补充。');
}
async function assertOptionalValues(page: Page) {
  const values = { registration_amount: '2.5', issuance_amount: '12500', bond_terms: '3年期，按年付息，到期还本。',
    underwriting: '合成证券牵头承销，合成银行联席。', other_agencies: '合成律师事务所负责法律意见。',
    rating_enhancement: '主体AA+，由合成保证人提供保证。', purpose_0: 'refinance_bonds', use_amount_0: '9000',
    use_target_0: '合成存续债券', use_details_0: '按到期兑付计划偿还。', purpose_1: 'repay_debt', use_amount_1: '35000000',
    use_target_1: '合成银行借款', use_details_1: '置换银行流动资金借款。', other_information: '授信额度及使用情况将在材料区补充。' };
  for (const [id, value] of Object.entries(values)) await expect(page.locator(`#${id}`)).toHaveValue(value);
  for (const [name, value] of Object.entries({ registration_amount_unit: 'hundred_million', issuance_amount_unit: 'ten_thousand', use_amount_0_unit: 'ten_thousand', use_amount_1_unit: 'yuan' })) await expect(page.locator(`[name=${name}]`)).toHaveValue(value);
}

for (const width of [1440, 390]) test(`issuer-only creation keeps five optional native groups collapsed and never starts ${width}`, async ({ page }) => {
  const state = await install(page); await page.setViewportSize({ width, height: width === 1440 ? 960 : 844 });
  await page.goto('/#/new'); await allCollapsed(page);
  await expect(page.locator('#create-form [required]')).toHaveCount(1); await expect(page.locator('#issuer')).toHaveAttribute('required', '');
  await expect(page.locator('#create-form #name, #create-form [name=has_historical]')).toHaveCount(0);
  await expect(page.locator('#market')).toBeVisible(); await expect(page.locator('#offering')).toBeVisible(); await expect(page.locator('#reporting-year')).toBeVisible();
  await expect(page.locator('[data-update-summary]')).toHaveText(['未填写', '未填写', '未填写', '未填写', '未填写']);
  for (const group of await groups(page).all()) { await setOpen(group, true); await setOpen(group, false); }
  expect(writes(state)).toEqual([]);
  await page.locator('#issuer').fill('合成新发行人有限公司');
  await expect(page.locator('#generated-project-name')).toContainText('合成新发行人有限公司');
  await screenshot(page, `authoring-create-${width}.png`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#create-form button[type=submit]').click();
  await expect(page.locator('#materials-title')).toBeVisible();
  await screenshot(page, `authoring-materials-${width}.png`);
  expect(state.created).toHaveLength(1); expect(state.created[0].issuer_name).toBe('合成新发行人有限公司');
  expect(state.created[0].market).toBeNull(); expect(state.created[0].offering).toBeNull();
  expect(state.created[0].update_details?.authoring_mode).toBe('unified_v1'); expect(state.created[0].update_details?.source_prospectuses).toEqual([]);
  expect(writes(state).map(call => `${call.method} ${call.path}`)).toEqual(['POST /projects']); expectNoExecution(state);
});

for (const width of [1440, 390]) test(`all five optional groups preserve amounts, units and multiple purposes after collapsed create and reload ${width}`, async ({ page }) => {
  const state = await install(page); await page.setViewportSize({ width, height: width === 1440 ? 960 : 844 }); await page.goto('/#/new');
  await page.locator('#issuer').fill('合成完整信息发行人有限公司'); await page.locator('#market').selectOption('sse'); await page.locator('#offering').selectOption('private');
  await page.locator('#reporting-year').selectOption('2026'); await page.locator('[name=reporting_quarter][value="06-30"]').check();
  await fillOptionalGroups(page);
  // A newly added empty row is not described as a completed funding use.
  await page.locator('#add-purpose').click(); await expect(groupFor(page, '#funding-rows').locator('[data-update-summary]')).toHaveText('已填写 2 项用途');
  page.once('dialog', dialog => dialog.accept()); await page.locator('[data-remove-purpose="2"]').click();
  await expect(page.locator('[data-update-summary]')).toHaveText(['已填写 3 项', '已填写 2 项', '已填写 1 项', '已填写 2 项用途', '已填写 1 项']);
  for (const group of await groups(page).all()) await setOpen(group, false);
  expect(writes(state)).toEqual([]); await page.locator('#create-form button[type=submit]').click(); await expect(page.locator('#materials-title')).toBeVisible();
  const saved = structuredClone(state.project.update_details);
  expect(saved?.funding_uses).toHaveLength(2); expect(saved?.registration_amount).toEqual({ value: '2.5', unit: 'hundred_million' });
  expect(saved?.issuance_amount).toEqual({ value: '12500', unit: 'ten_thousand' });
  await page.locator('#edit-project-details').click(); await page.reload(); await expect(page.locator('#draft-form')).toBeVisible(); await allCollapsed(page);
  await expect(page.locator('[data-update-summary]')).toHaveText(['已填写 3 项', '已填写 2 项', '已填写 1 项', '已填写 2 项用途', '已填写 1 项']);
  const before = writes(state).length;
  for (const group of await groups(page).all()) await setOpen(group, true);
  await assertOptionalValues(page);
  for (const group of await groups(page).all()) await setOpen(group, false);
  await page.waitForTimeout(950); expect(writes(state)).toHaveLength(before);
  expect(state.project.update_details).toEqual(saved); expect(state.patches).toEqual([]); expectNoExecution(state);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('basic edits preserve custom name, source metadata, unusual reporting periods, notes and folded values', async ({ page }) => {
  const state = fixture();
  const actualPeriods: Details['target_reporting_periods'] = [
    { start: '2022-07-01', end: '2023-06-30', period_kind: 'annual', scope: 'parent', status: 'user_asserted', evidence_refs: [] },
    { start: null, end: '2024-04-20', period_kind: 'interim', scope: null, status: 'needs_confirmation', evidence_refs: [] }
  ];
  const source: Dto<'MaterialResponse'> = { material_id: 'original-source', material_version: 4, upload_id: 'original-upload', role: 'historical',
    filename: '合成历史募集书.pdf', media_type: 'application/pdf', byte_size: 32, sha256: sha256('original-source'), state: 'persisted', persisted_at: now, error: null };
  state.materials = [source];
  state.project.update_details = { ...state.project.update_details!, reporting_cutoff: '2024-04-20', target_reporting_periods: actualPeriods,
    supplementary_notes: '原有补充要求必须保留。', registration_amount: { value: '20', unit: 'hundred_million' }, bond_terms: '保留原债券安排。',
    underwriting: '保留原承销分工。', rating_enhancement: '保留原担保安排。', other_information: '保留其他折叠信息。',
    funding_uses: [{ purpose: 'construction', amount: { value: '5000', unit: 'ten_thousand' }, target: '合成在建项目', details: '按原建设计划投入。' }],
    source_prospectuses: [{ material_id: source.material_id, material_version: 4, sha256: source.sha256, issuer_name: '历史发行人有限公司', relation: 'parent',
      market: 'sse', offering: 'private', reporting_periods: structuredClone(actualPeriods), status: 'user_asserted' }] };
  const retained = structuredClone(state.project.update_details), customName = state.project.name;
  await existingDetails(page, state); await allCollapsed(page);
  await expect(page.locator('#legacy-cutoff')).toContainText('2024-04-20'); await expect(page.locator('[name=reporting_quarter]:checked')).toHaveCount(0);
  await page.locator('#issuer').fill('合成更名后发行人有限公司'); await page.locator('#continue-materials').click();
  await expect(page.locator('#materials-title')).toBeVisible(); expect(state.patches).toHaveLength(1);
  expect(state.patches[0].ifMatch).toBe('1'); expect(state.project.name).toBe(customName); expect(state.project.update_details).toEqual(retained);
  await page.reload(); await page.locator('#edit-project-details').click(); await allCollapsed(page);
  await expect(page.locator('#name')).toHaveValue(customName); await expect(page.locator('#issuer')).toHaveValue('合成更名后发行人有限公司');
  await setOpen(groupFor(page, '#registration_amount'), true); await expect(page.locator('#registration_amount')).toHaveValue('20');
  await setOpen(groupFor(page, '#funding-rows'), true); await expect(page.locator('#use_amount_0')).toHaveValue('5000');
  expect(state.project.update_details?.source_prospectuses).toEqual(retained.source_prospectuses); expectNoExecution(state);
});

test('submitting a hidden malformed amount opens its group and focuses the precise error before create', async ({ page }) => {
  const state = await install(page); await page.goto('/#/new'); await page.locator('#issuer').fill('合成金额校验发行人');
  const group = groupFor(page, '#registration_amount'); await setOpen(group, true); await page.locator('#registration_amount').fill('1.2345678'); await setOpen(group, false);
  await page.locator('#create-form button[type=submit]').click();
  await expect(group).toHaveJSProperty('open', true); await expect(page.locator('#registration_amount')).toBeFocused();
  await expect(page.locator('#registration_amount')).toHaveAttribute('aria-invalid', 'true'); await expect(group.locator('[data-update-group-error]')).toBeVisible();
  expect(state.created).toEqual([]); expect(writes(state)).toEqual([]);
  await page.locator('#registration_amount').fill('1.234567');
  await expect(page.locator('#registration_amount')).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#registration_amount')).toHaveAttribute('aria-describedby', 'registration_amount-note');
  await setOpen(group, false); await page.locator('#create-form button[type=submit]').click(); await expect(page.locator('#materials-title')).toBeVisible();
  expect(state.created).toHaveLength(1); expect(state.project.update_details?.registration_amount?.value).toBe('1.234567'); expectNoExecution(state);
});

test('continuing with a hidden over-registration amount focuses issuance and saves only after correction', async ({ page }) => {
  const state = await existingDetails(page); const group = groupFor(page, '#issuance_amount'); await setOpen(group, true);
  // First invalidate the amount so the normal autosave cannot persist an intermediate valid edit.
  await page.locator('#issuance_amount').fill('invalid'); await page.locator('#registration_amount').fill('1');
  await page.locator('[name=registration_amount_unit]').selectOption('hundred_million'); await page.locator('#issuance_amount').fill('10001');
  await page.locator('[name=issuance_amount_unit]').selectOption('ten_thousand'); await setOpen(group, false);
  await page.locator('#continue-materials').click(); await expect(page.locator('#draft-form')).toBeVisible();
  await expect(group).toHaveJSProperty('open', true); await expect(page.locator('#issuance_amount')).toBeFocused();
  await expect(page.locator('#issuance_amount')).toHaveAttribute('aria-invalid', 'true'); expect(state.patches).toEqual([]);
  await page.locator('#issuance_amount').fill('10000'); await expect(page.locator('#issuance_amount')).not.toHaveAttribute('aria-invalid', 'true');
  await setOpen(group, false); await page.locator('#continue-materials').click(); await expect(page.locator('#materials-title')).toBeVisible();
  expect(state.patches).toHaveLength(1); expect(state.patches[0].ifMatch).toBe('1'); expect(state.project.update_details?.issuance_amount).toEqual({ value: '10000', unit: 'ten_thousand' }); expectNoExecution(state);
});

test('draft 409 retains local folded fields and never overwrites a newer server revision', async ({ page }) => {
  const state = await existingDetails(page); const group = groupFor(page, '#other_information'); await setOpen(group, true);
  state.project = { ...structuredClone(state.project), name: '其他页面保存的项目名', draft_revision: 2,
    update_details: { ...state.project.update_details!, other_information: '服务器第二版内容。' } };
  const server = structuredClone(state.project);
  await page.locator('#other_information').fill('本页尚未保存的折叠信息。'); await setOpen(group, false); await page.locator('#continue-materials').click();
  await expect(page.locator('#save-state')).toHaveText('有版本冲突'); await expect(page.locator('#conflict-panel')).toBeVisible();
  await expect(page.locator('#draft-form')).toBeVisible(); await setOpen(group, true); await expect(page.locator('#other_information')).toHaveValue('本页尚未保存的折叠信息。');
  await page.locator('#issuer').fill('冲突后的本地发行人'); await page.waitForTimeout(950);
  expect(state.patches).toHaveLength(1); expect(state.patches[0].ifMatch).toBe('1'); expect(state.project).toEqual(server);
  page.once('dialog', dialog => dialog.dismiss()); await page.locator('#reload-draft').click();
  await expect(page.locator('#issuer')).toHaveValue('冲突后的本地发行人'); expect(state.project).toEqual(server);
  page.once('dialog', dialog => dialog.accept()); await page.locator('#reload-draft').click(); await expect(page.locator('#save-state')).toHaveText('已保存');
  await expect(page.locator('#name')).toHaveValue('其他页面保存的项目名'); await setOpen(groupFor(page, '#other_information'), true);
  await expect(page.locator('#other_information')).toHaveValue('服务器第二版内容。'); expect(state.patches).toHaveLength(1); expectNoExecution(state);
});

test('network save failure retains fields without background retry and explicit retry keeps the CAS revision', async ({ page }) => {
  const state = await existingDetails(page), server = structuredClone(state.project); state.failNextPatch = true;
  const group = groupFor(page, '#rating_enhancement'); await setOpen(group, true); await page.locator('#rating_enhancement').fill('网络失败后仍保留的评级及担保信息。');
  await setOpen(group, false); await page.locator('#continue-materials').click(); await expect(page.locator('#save-state')).toHaveText('保存未确认');
  await expect(page.locator('#draft-form')).toBeVisible(); expect(state.project).toEqual(server);
  await setOpen(group, true); await expect(page.locator('#rating_enhancement')).toHaveValue('网络失败后仍保留的评级及担保信息。');
  await page.locator('#issuer').fill('网络失败后继续填写的发行人'); await page.waitForTimeout(950); expect(state.patches).toHaveLength(1); expect(state.project).toEqual(server);
  await setOpen(group, false); await page.locator('#continue-materials').click(); await expect(page.locator('#materials-title')).toBeVisible();
  expect(state.patches.map(patch => patch.ifMatch)).toEqual(['1', '1']); expect(state.project.draft_revision).toBe(2);
  expect(state.project.issuer_name).toBe('网络失败后继续填写的发行人'); expect(state.project.update_details?.rating_enhancement).toBe('网络失败后仍保留的评级及担保信息。'); expectNoExecution(state);
});

test('finance-only project uses the existing explicit start and locks the exact no-source draft through preflight, quote and reload', async ({ page }) => {
  const state = await install(page); await page.goto(`/#/projects/${projectId}?step=materials`);
  const guide = page.locator('#project-materials-details [data-authoring-preparation-guide]'); await expect(guide).toBeVisible();
  await expect(page.getByRole('button', { name: '添加财务材料', exact: true })).toHaveCount(0);
  await expect(guide).toContainText('没有原稿也可编制首稿'); await expect(guide).toContainText('不会开始任务');
  await page.locator('[data-authoring-requirements]').click();
  await expect(page.locator('#project-message')).toBeFocused();
  expect(writes(state)).toEqual([]);
  await expect(page.locator('[data-upload-role=audit]')).toBeEnabled();
  expect(await page.locator('[data-material-role=audit]').evaluate(element => Boolean(element.compareDocumentPosition(document.querySelector('[data-material-role=historical]')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  expectNoExecution(state);
  await screenshot(page, 'financial-upload-entry-desktop.png');
  const chooserEvent = page.waitForEvent('filechooser'); await page.locator('[data-material-role=audit] .material-picker').click(); const chooser = await chooserEvent;
  expect(await chooser.element().getAttribute('data-upload-role')).toBe('audit');
  const bytes = Buffer.from('%PDF-1.7\nsynthetic finance upload boundary\n%%EOF');
  await chooser.setFiles({ name: '合成财务材料.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('[data-material-role=audit] .material-file-row')).toContainText('服务器已确认保存');
  await expect(page.locator('#execute-input')).toBeEnabled(); expectNoExecution(state);
  expect(state.materials).toHaveLength(1); expect(state.materials[0].role).toBe('audit'); expect(state.materials[0].sha256).toBe(sha256(bytes));
  const beforeStart = writes(state).map(call => call.path);
  expect(beforeStart).toEqual([`/projects/${projectId}/materials/uploads`, `/projects/${projectId}/materials/uploads/synthetic-upload-1/bytes`, `/projects/${projectId}/materials/uploads/synthetic-upload-1/complete`]);
  await page.locator('#execute-input').click(); await expect.poll(() => state.executes.length).toBe(1); await expect(page.locator('#execution-progress')).toContainText('等待开始');
  expect(state.locked).toHaveLength(1); expect(state.preflights).toHaveLength(1); expect(state.quotes).toHaveLength(1);
  const locked = structuredClone(state.locked[0]), execution = structuredClone(state.executes[0]);
  expect(locked.project.update_details?.authoring_mode).toBe('unified_v1'); expect(locked.project.update_details?.source_prospectuses).toEqual([]);
  expect(locked.request.draft_revision).toBe(locked.project.draft_revision);
  expect(locked.request.material_versions).toEqual([{ material_id: state.materials[0].material_id, material_version: 1 }]);
  expect(locked.request).not.toHaveProperty('user_reference'); expect(locked.request).not.toHaveProperty('target_confirmation');
  expect(state.preflights[0]).toEqual({ input_revision: locked.response.input_revision, input_hash: locked.response.input_hash });
  expect(state.quotes[0]).toEqual(state.preflights[0]); expect(execution.quote_id).toBe('synthetic-onboarding-quote');
  await expect(guide).toBeHidden(); await expect(page.locator('[data-upload-role=audit]')).toBeDisabled();
  await page.reload(); await expect(page.locator('#execution-progress')).toContainText('等待开始'); await expect(page.locator('#execute-input')).toBeDisabled();
  expect(state.runs.size).toBe(1); expect(state.executes).toEqual([execution]); expect(state.locked).toEqual([locked]);
  expect(state.project.update_details?.authoring_mode).toBe('unified_v1'); expect(state.project.update_details?.source_prospectuses).toEqual([]);
});
