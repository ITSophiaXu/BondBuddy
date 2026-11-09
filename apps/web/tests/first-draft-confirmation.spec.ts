import { expect, test, type Page, type Route } from '@playwright/test';
import { emptyUpdateDetails, reportingWindow, schemas } from '@bondbuddy/contracts';
import '../src/schema-formats';
import { Value } from '@sinclair/typebox/value';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fixtureJson, fixtureRequest, serveDisabledBillingCatalog, type Dto } from './billing-fixture-wire';
import { taskPage } from './collection-fixtures';

// Synthetic HTTP responses in Chromium only. These tests do not exercise PostgreSQL,
// document parsing, model generation, billing admission or delivered Word quality.
// Keep the excluded historical inventory separate from selected project materials.
const projectId = 'synthetic-first-draft-project';
const now = '2026-10-25T03:00:00Z';
const scope = 'project_undeleted_historical_versions' as const;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const messages = { version: 1, content_sha256: hash('bondbuddy:empty-project-messages'), message_ids: [] };
type Exclusion = Dto<'FirstDraftExclusionsResponse'>['excluded_historical'][number];
type Call = { method: string; path: string; body?: unknown };

function material(id: string, role: Dto<'MaterialResponse'>['role'], filename: string): Dto<'MaterialResponse'> {
  return { material_id: id, material_version: 1, upload_id: `upload-${id}`, role, filename,
    media_type: 'application/pdf', byte_size: 32, sha256: hash(id), state: 'persisted', persisted_at: now, error: null };
}
function fixture(kind: 'generation' | 'update' = 'generation', adopted = false) {
  const history = material('adopted-history', 'historical', '合成已采用历史稿.pdf');
  const periods = reportingWindow('sse', 'private', '2026-06-30');
  const project: Dto<'ProjectResponse'> = { project_id: projectId, name: '合成首稿确认项目', issuer_name: '合成首稿发行人有限公司',
    kind, market: 'sse', offering: 'private', draft_revision: 1, input_revision: null, input_hash: null, updated_at: now,
    update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1', reporting_cutoff: '2026-06-30', target_reporting_periods: periods,
      source_prospectuses: adopted ? [{ material_id: history.material_id, material_version: 1, sha256: history.sha256,
        issuer_name: '合成首稿发行人有限公司', relation: 'same_issuer', market: 'sse', offering: 'private',
        reporting_periods: periods, status: 'user_asserted' }] : [] } };
  return { project, adopted, history, selectionRevision: adopted ? 1 : 0,
    materials: [material('selected-finance', 'audit', '合成财务材料.pdf'), ...(adopted ? [history] : [])],
    excluded: [
      { material_id: 'unselected-history-a', material_version: 2, sha256: hash('history-a-v2'), filename: '未采用的历史募集书甲.pdf' },
      { material_id: 'unselected-history-b', material_version: 7, sha256: hash('history-b-v7'), filename: '未采用的历史募集书乙.pdf' }
    ] as Exclusion[],
    rejection: 'FIRST_DRAFT_CONFIRMATION_REQUIRED', rejectConfirmedOnce: false,
    requests: [] as Dto<'InputRevisionCreateRequest'>[], locked: [] as Dto<'InputRevisionResponse'>[],
    preflights: [] as Dto<'PreflightRequest'>[], previews: [] as Dto<'FirstDraftExclusionsResponse'>[],
    uploads: new Map<string, { request: Dto<'UploadCreateRequest'>; bytes?: Buffer }>(),
    calls: [] as Call[], unexpected: [] as string[], errors: [] as string[] };
}
type State = ReturnType<typeof fixture>;
const installed = new WeakMap<Page, State>();
function checked<T extends keyof typeof schemas>(name: T, value: unknown): asserts value is Dto<T> {
  expect(Value.Check(schemas[name], value), `${name}: ${JSON.stringify([...Value.Errors(schemas[name], value)])}`).toBe(true);
}
async function reply<T extends keyof typeof schemas>(route: Route, name: T, body: Dto<T>, status = 200) {
  checked(name, body);
  await route.fulfill({ status, contentType: 'application/json', body: fixtureJson(route, body) });
}
const errorReply = (route: Route, status: number, code: string) => route.fulfill({ status, contentType: 'application/json', body: fixtureJson(route, { code }) });
const confirmation = (excluded: Exclusion[]) => ({ decision: 'generate_first_draft', scope,
  excluded_historical: excluded.map(({ material_id, material_version, sha256 }) => ({ material_id, material_version, sha256 })) });
const exclusionPath = `/projects/${projectId}/first-draft-exclusions`;
const inputPath = `/projects/${projectId}/input-revisions`;
const decisionCalls = (state: State) => state.calls.filter(call => call.path === exclusionPath || call.path === inputPath).map(call => `${call.method} ${call.path}`);

async function install(page: Page, state: State) {
  installed.set(page, state); page.on('pageerror', error => state.errors.push(error.message));
  await page.context().route('**/api/v1/**', async route => {
    if (await serveDisabledBillingCatalog(route)) return;
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname.replace('/api/v1', '');
    const body: unknown = request.headers()['content-type']?.includes('application/json') && request.postData() ? fixtureRequest(request) : undefined;
    state.calls.push({ method, path, ...(body === undefined ? {} : { body: structuredClone(body) }) });
    if (method === 'GET' && path === '/me') return reply(route, 'MeResponse', { user_id: 'synthetic-owner', session_status: 'active' });
    if (method === 'GET' && path === '/account') return reply(route, 'AccountResponse', { user_id: 'synthetic-owner', username: 'synthetic',
      phone_masked: null, status: 'active', created_at: now, accepted_terms_version: null, current_terms_version: null,
      password_updated_at: null, self_service_recovery: 'unavailable', support_contact: null });
    if (method === 'GET' && path === '/credits/balance') return reply(route, 'CreditBalanceResponse', { enabled: true, available: 1, frozen: 0 });
    if (method === 'GET' && path === '/m4/topics') return route.fulfill({ contentType: 'application/json', body: fixtureJson(route, { topics: [] }) });
    if (method === 'GET' && path === '/projects') return reply(route, 'ProjectListResponse', { items: [{ project_id: projectId,
      name: state.project.name, kind: state.project.kind, issuer_name: state.project.issuer_name, market: state.project.market,
      offering: state.project.offering, draft_revision: state.project.draft_revision, updated_at: now, latest_run: null, latest_artifact: null }],
      page: { has_more: false, next_cursor: null } });
    if (path === `/projects/${projectId}` && method === 'GET') return reply(route, 'ProjectResponse', state.project);
    if (path === `/projects/${projectId}` && method === 'PATCH') {
      checked('ProjectPatchRequest', body); expect(request.headers()['if-match']).toBe(String(state.project.draft_revision));
      state.project = { ...state.project, ...structuredClone(body), draft_revision: state.project.draft_revision + 1, updated_at: now };
      return reply(route, 'ProjectResponse', state.project);
    }
    if (method === 'GET' && path === `/projects/${projectId}/tasks`) return reply(route, 'ProjectTasksResponse', taskPage(projectId, [], state.project.kind));
    if (method === 'GET' && path === `/projects/${projectId}/messages`) return reply(route, 'ProjectMessagePage', {
      conversation_id: projectId, items: [], project_message_set_ref: messages, next_cursor: null, has_more: false });
    if (method === 'GET' && path === `/projects/${projectId}/events`) {
      const after = Number(url.searchParams.get('after') ?? 0);
      return reply(route, 'ProjectEventsResponse', { items: state.materials.map((value, index) => ({ event_id: `material-event-${index}`,
        schema_version: 1 as const, trace_id: 'synthetic-trace', project_id: projectId, seq: index + 1, occurred_at: now,
        type: 'material.upload_progress' as const, payload: { material_id: value.material_id } })).filter(value => value.seq > after), next_cursor: null });
    }
    if (method === 'GET' && path === `/projects/${projectId}/prospectus-versions`) return reply(route, 'ProspectusVersionsResponse', {
      project_id: projectId, current_version_id: state.adopted ? 'synthetic-adopted-version' : null, selection_revision: state.selectionRevision,
      inactive_material_ids: [], versions: state.adopted ? [{ version_id: 'synthetic-adopted-version', sequence: 1, origin: 'upload',
        filename: state.history.filename, sha256: state.history.sha256, created_at: now, material_id: state.history.material_id,
        material_version: state.history.material_version, artifact_id: null, artifact_version: null, revision_artifact_id: null, run_id: null }] : [] });
    if (method === 'GET' && path === exclusionPath) {
      if (state.project.kind !== 'generation' && state.project.kind !== 'update') throw new Error('Synthetic fixture requires an authoring project');
      const preview: Dto<'FirstDraftExclusionsResponse'> = { project_id: projectId, draft_revision: state.project.draft_revision,
        project_kind: state.project.kind, scope, excluded_historical: structuredClone(state.excluded) };
      state.previews.push(structuredClone(preview)); return reply(route, 'FirstDraftExclusionsResponse', preview);
    }
    if (path === `/projects/${projectId}/materials/uploads` && method === 'POST') {
      checked('UploadCreateRequest', body); const uploadId = `synthetic-upload-${state.uploads.size + 1}`;
      state.uploads.set(uploadId, { request: structuredClone(body) });
      return reply(route, 'UploadSessionResponse', { upload_id: uploadId, state: 'uploading',
        upload_url: `/api/v1/projects/${projectId}/materials/uploads/${uploadId}/bytes`, expires_at: '2099-01-01T00:00:00Z', max_bytes: 100 * 1024 * 1024 }, 201);
    }
    const uploadMatch = path.match(new RegExp(`^/projects/${projectId}/materials/uploads/([^/]+)/(bytes|complete)$`));
    if (uploadMatch) {
      const upload = state.uploads.get(uploadMatch[1]); expect(upload).toBeDefined();
      if (method === 'PUT' && uploadMatch[2] === 'bytes') {
        const bytes = request.postDataBuffer(); expect(bytes).not.toBeNull();
        expect(bytes!.byteLength).toBe(upload!.request.byte_size); expect(hash(bytes!)).toBe(upload!.request.sha256);
        upload!.bytes = Buffer.from(bytes!); return route.fulfill({ status: 204 });
      }
      if (method === 'POST' && uploadMatch[2] === 'complete') {
        checked('UploadCompleteRequest', body); expect(upload!.bytes).toBeDefined();
        expect(body).toEqual({ byte_size: upload!.bytes!.byteLength, sha256: hash(upload!.bytes!) });
        const saved: Dto<'MaterialResponse'> = { ...upload!.request, material_id: `new-financial-${state.uploads.size}`,
          material_version: 1, upload_id: uploadMatch[1], state: 'persisted', persisted_at: now, error: null };
        state.materials.push(saved); return reply(route, 'MaterialResponse', saved);
      }
    }
    const selectedMaterial = [...state.materials, state.history].find(value => path === `/projects/${projectId}/materials/${value.material_id}`);
    if (selectedMaterial && method === 'GET') return reply(route, 'MaterialResponse', selectedMaterial);
    if (method === 'GET' && [...state.materials, state.history].some(value => path === `/projects/${projectId}/materials/${value.material_id}/parse-job`)) return errorReply(route, 404, 'NOT_FOUND');
    if (method === 'POST' && path === inputPath) {
      checked('InputRevisionCreateRequest', body); state.requests.push(structuredClone(body));
      expect(body.draft_revision).toBe(state.project.draft_revision); expect(body.prospectus_selection_revision).toBe(state.selectionRevision);
      expect(body.project_message_set_ref).toEqual(messages); expect(body.requirement_message_ids).toEqual([]);
      expect(body.material_versions).toEqual(state.materials.map(value => ({ material_id: value.material_id, material_version: value.material_version })));
      if (!body.first_draft_confirmation) return errorReply(route, 409, state.rejection);
      expect(body.first_draft_confirmation).toEqual(confirmation(state.excluded));
      if (state.rejectConfirmedOnce) {
        state.rejectConfirmedOnce = false;
        state.excluded = [...state.excluded, { material_id: 'concurrent-history', material_version: 1, sha256: hash('concurrent-history'), filename: '另一页面新增历史稿.pdf' }];
        return errorReply(route, 409, 'FIRST_DRAFT_EXCLUSION_STALE');
      }
      const response: Dto<'InputRevisionResponse'> = { project_id: projectId, input_revision: state.locked.length + 1,
        input_hash: hash(JSON.stringify(body)), material_versions: structuredClone(body.material_versions),
        target_confirmation: { status: 'unconfirmed', market: null, offering: null, as_of: null, document_purpose: null,
          target_reporting_periods: [], confirmed_at: null, confirmed_by: null },
        rule_pack_version: null, template_version: null, reference_release: null, created_at: now };
      state.locked.push(response); state.project.input_revision = response.input_revision; state.project.input_hash = response.input_hash;
      return reply(route, 'InputRevisionResponse', response, 201);
    }
    const revision = state.locked.find(value => path === `${inputPath}/${value.input_revision}`);
    if (method === 'GET' && revision) return reply(route, 'InputRevisionResponse', revision);
    if (method === 'POST' && path === `/projects/${projectId}/preflight`) {
      checked('PreflightRequest', body); state.preflights.push(structuredClone(body));
      const input = state.locked.at(-1)!; expect(body).toEqual({ input_revision: input.input_revision, input_hash: input.input_hash });
      // Stop after recording a confirmed input. Any quote or execution request is unexpected.
      return reply(route, 'PreflightResponse', { project_id: projectId, ...body, status: 'blocked', missing_inputs: [],
        blocking_inputs: ['synthetic_processing_unavailable'], advisory_inputs: [], uncertainty: [], billing_mode: 'fixed_credits' });
    }
    state.unexpected.push(`${method} ${path}`); return errorReply(route, 501, 'UNEXPECTED_SYNTHETIC_REQUEST');
  });
}
test.afterEach(async ({ page }) => {
  const state = installed.get(page); if (!state) return;
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

// Current new-task policy requires a historical/reference source. Old first-draft
// confirmation responses must not restore the superseded source-free path.
for(const kind of ['update','generation'] as const) test('required source blocks '+kind+' before any first-draft confirmation or input write',async({page})=>{
 const state=fixture(kind);await install(page,state);await page.goto('/#/projects/'+projectId+'?step=materials');
 await expect(page.locator('#materials-title')).toBeVisible();await expect(page.locator('#execute-input')).toBeDisabled();
 await expect(page.locator('#start-disabled-reason')).toContainText('历史／参考募集书');
 await expect(page.locator('#execution-first-draft')).toBeHidden();expect(decisionCalls(state)).toEqual([]);
 await page.reload();await expect(page.locator('#execute-input')).toBeDisabled();expect(state.requests).toEqual([]);expect(state.previews).toEqual([]);
});
test('an adopted reference never permits the obsolete first-draft confirmation path',async({page})=>{
 const state=fixture('generation',true);await install(page,state);await page.goto('/#/projects/'+projectId+'?step=materials');
 await expect(page.locator('#execute-input')).toBeEnabled();await page.locator('#execute-input').click();
 await expect.poll(()=>state.requests.length).toBe(1);await expect(page.locator('#execution-first-draft')).toBeHidden();
 expect(state.requests[0].first_draft_confirmation).toBeUndefined();expect(state.locked).toEqual([]);
});
