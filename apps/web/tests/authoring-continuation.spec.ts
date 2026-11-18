import {serveAuditPdfQuality} from './audit-pdf-quality-fixture';
import {serveDisabledBillingCatalog} from './billing-fixture-wire';
import {fixtureJson,fixtureRequest} from './billing-fixture-wire';
import { expect, test, type Page, type Route } from '@playwright/test';
import { emptyUpdateDetails, schemas } from '@bondbuddy/contracts';
import '../src/schema-formats';
import { Value } from '@sinclair/typebox/value';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Dto } from './billing-fixture-wire';
import { taskPage } from './collection-fixtures';
import { captureAuthoringPreparation, installAuthoringSourceGuideReference } from './authoring-source-guide-reference';

// Synthetic public HTTP boundary only. Private authoring manifests, real billing,
// model calls and Word contents are deliberately outside this browser fixture.
const projectId = 'synthetic-continuation-a';
const otherProjectId = 'synthetic-continuation-b';
const ownerId = 'synthetic-continuation-owner-a';
const oldRunId = 'synthetic-continuation-run-7';
const now = '2026-10-25T05:00:00Z';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const emptyMessages = { version: 1, content_sha256: sha256('bondbuddy:empty-project-messages'), message_ids: [] };
type Project = Dto<'ProjectResponse'>;
type Period = NonNullable<NonNullable<Project['update_details']>['target_reporting_periods']>[number];
type Version = Dto<'ProspectusVersionsResponse'>['versions'][number];
type Pin = NonNullable<Dto<'InputRevisionCreateRequest'>['edit_base']>;
type Locked = { request: Dto<'InputRevisionCreateRequest'>; projectSnapshot: Project; response: Dto<'InputRevisionResponse'> };
type Call = { method: string; path: string; body?: unknown };
const actualPeriods: Period[] = [2024, 2025].map<Period>(year => ({
  start: `${year}-01-01`, end: `${year}-12-31`, period_kind: 'annual', scope: 'consolidated', status: 'user_asserted', evidence_refs: []
}));
const cleanPin: Pin = { artifact_id: 'synthetic-clean-7', artifact_version: 4, sha256: sha256('clean-7') };
const newerPin: Pin = { artifact_id: 'synthetic-clean-9', artifact_version: 6, sha256: sha256('clean-9') };

function publicInput(revision: number, materials: Dto<'InputRevisionResponse'>['material_versions'], inputHash = sha256(`input-${revision}`)): Dto<'InputRevisionResponse'> {
  return { project_id: projectId, input_revision: revision, input_hash: inputHash, material_versions: structuredClone(materials),
    target_confirmation: { status: 'unconfirmed', market: null, offering: null, as_of: null, document_purpose: null,
      target_reporting_periods: [], confirmed_at: null, confirmed_by: null },
    rule_pack_version: null, template_version: null, reference_release: null, created_at: now };
}
function successfulRun(runId: string, revision: number, artifactId: string): Dto<'RunResponse'> {
  return { run_id: runId, execution_request_id: `synthetic-execution-${revision}`, project_id: projectId,
    input_revision: revision, input_hash: sha256(`input-${revision}`), channel: 'production', test_grant_id: null, uncovered_items: [],
    state: 'succeeded', stage: 'succeeded', event_cursor: 0, billing_mode: 'fixed_credits', reservation_id: null,
    artifact_id: artifactId, prompt_snapshot_ref: null, updated_at: now };
}
function artifactPair(runId: string, pin: Pin, revisionId: string): Dto<'ArtifactResponse'>[] {
  const round = runId.match(/(\d+)$/)?.[1] ?? '7';
  return (['revision', 'clean'] as const).map(variant => ({
    artifact_id: variant === 'clean' ? pin.artifact_id : revisionId, run_id: runId, version: pin.artifact_version,
    filename: `合成第${round}轮募集书_${variant === 'clean' ? '清洁版' : '修订版'}.docx`,
    media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sha256: variant === 'clean' ? pin.sha256 : sha256(revisionId), quality_status: 'passed', delivery_status: 'available',
    download_url: `https://synthetic.invalid/artifacts/${variant === 'clean' ? pin.artifact_id : revisionId}`, expires_at: now,
    word_delivery: { variant, revision_artifact_id: revisionId, clean_artifact_id: pin.artifact_id,
      writer_version: 'bondbuddy-unified-word-1.0.0', source_sha256: sha256('historical-current'), baseline_hash: null,
      effective_baseline_sha256: null, plan_hash: null, delivery_policy: 'generated_pair_v1', content_review: 'not_performed',
      baseline_kind: 'uploaded_source', source_issuer: '合成发行人有限公司', replacements: null, columns: null,
      pending_review_count: null, pending_review: [] }
  }));
}
function generatedVersion(runId: string, pin: Pin, revisionId: string, sequence: number): Version {
  const round = runId.match(/(\d+)$/)?.[1] ?? '7';
  return { version_id: `synthetic-generated-${sequence}`, sequence, origin: 'generated',
    filename: `合成第${round}轮募集书_清洁版.docx`, sha256: pin.sha256, created_at: now,
    material_id: null, material_version: null, artifact_id: pin.artifact_id, artifact_version: pin.artifact_version,
    revision_artifact_id: revisionId, run_id: runId };
}
function fixture() {
  const materials: Dto<'MaterialResponse'>[] = [
    { material_id: 'synthetic-historical-current', material_version: 2, upload_id: 'synthetic-history-upload', role: 'historical',
      filename: '合成有效历史原件.pdf', media_type: 'application/pdf', byte_size: 2048, sha256: sha256('historical-current'), state: 'persisted', persisted_at: now, error: null },
    { material_id: 'synthetic-audit-current', material_version: 3, upload_id: 'synthetic-audit-upload', role: 'audit',
      filename: '合成已保存财务资料.pdf', media_type: 'application/pdf', byte_size: 4096, sha256: sha256('audit-current'), state: 'persisted', persisted_at: now, error: null },
    { material_id: 'synthetic-historical-inactive', material_version: 1, upload_id: 'synthetic-old-upload', role: 'historical',
      filename: '合成停用旧原稿.pdf', media_type: 'application/pdf', byte_size: 1024, sha256: sha256('historical-inactive'), state: 'persisted', persisted_at: now, error: null }
  ];
  const activeRefs = materials.slice(0, 2).map(material => ({ material_id: material.material_id, material_version: material.material_version }));
  const input = publicInput(7, activeRefs);
  const project: Project = { project_id: projectId, name: '合成募集书续改项目', issuer_name: '合成发行人有限公司', kind: 'update',
    market: 'sse', offering: 'private', draft_revision: 11, input_revision: 7, input_hash: input.input_hash, updated_at: now,
    update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1', has_historical: true, reporting_cutoff: '2025-12-31',
      target_reporting_periods: structuredClone(actualPeriods), supplementary_notes: '原已保存的要求必须保留。',
      source_prospectuses: [{ material_id: materials[0].material_id, material_version: 2, sha256: materials[0].sha256,
        issuer_name: '合成发行人有限公司', relation: 'same_issuer', market: 'sse', offering: 'private', status: 'user_asserted',
        reporting_periods: [{ start: '2022-01-01', end: '2022-12-31', period_kind: 'annual', scope: 'consolidated', status: 'user_asserted', evidence_refs: [] }] }] } };
  const uploaded: Version[] = [materials[2], materials[0]].map((material, index) => ({
    version_id: `synthetic-upload-version-${index + 1}`, sequence: index + 1, origin: 'upload', filename: material.filename,
    sha256: material.sha256, created_at: now, material_id: material.material_id, material_version: material.material_version,
    artifact_id: null, artifact_version: null, revision_artifact_id: null, run_id: null
  }));
  const run = successfulRun(oldRunId, 7, 'synthetic-revision-7');
  return { project, otherProject: { ...structuredClone(project), project_id: otherProjectId, name: '另一个合成项目', input_revision: null, input_hash: null,
      update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1', source_prospectuses: [], reporting_cutoff: '2025-12-31' } } as Project,
    owner: ownerId, materials, versions: { project_id: projectId, current_version_id: 'synthetic-generated-3', selection_revision: 5,
      inactive_material_ids: [materials[2].material_id], versions: [...uploaded, generatedVersion(oldRunId, cleanPin, 'synthetic-revision-7', 3)] } as Dto<'ProspectusVersionsResponse'>,
    inputs: new Map([[7, input]]), runs: new Map([[run.run_id, run]]),
    artifacts: new Map(artifactPair(oldRunId, cleanPin, 'synthetic-revision-7').map(artifact => [artifact.artifact_id, artifact])),
    locked: [] as Locked[], inputAttempts: [] as Dto<'InputRevisionCreateRequest'>[], patches: [] as Dto<'ProjectPatchRequest'>[],
    preflights: [] as Dto<'PreflightRequest'>[], quotes: [] as Dto<'FixedQuoteRequest'>[], executes: [] as Dto<'ExecuteRequest'>[],
    quote: null as Dto<'FixedQuoteResponse'>['quote'], calls: [] as Call[], unexpected: [] as string[], errors: [] as string[],
    runQuotes: new Map<string, Dto<'FixedQuoteResponse'>['quote']>(), quoteVersion: 1, available: 100000,
    dropNextExecuteResponse: false, dropNextExecuteBeforeAcceptance: false, dropNextInputResponse: false,
    rejectNextExecute: undefined as 'QUOTE_CHANGED' | 'QUOTE_REQUIRED' | 'CREDITS_INSUFFICIENT' | undefined,
    failVersions: false, failMaterial: false, versionReads: 0,
    holdVersionsAt: undefined as number | undefined, heldVersions: false, releasedVersions: 0,
    releaseVersions: undefined as (() => void) | undefined,
    holdNextProjectRead: false, heldProjectRead: false, releaseProjectRead: undefined as (() => void) | undefined,
    holdNextTasksRead: false, heldTasksRead: false, releaseTasksRead: undefined as (() => void) | undefined };
}
type State = ReturnType<typeof fixture>;
const installed = new WeakMap<Page, State>();
function checked<T extends keyof typeof schemas>(name: T, value: unknown): asserts value is Dto<T> {
  expect(Value.Check(schemas[name], value), `${name}: ${JSON.stringify([...Value.Errors(schemas[name], value)])}`).toBe(true);
}
async function reply<T extends keyof typeof schemas>(route: Route, name: T, body: Dto<T>, status = 200) {
  checked(name, body); await route.fulfill({ status, contentType: 'application/json', body: fixtureJson(route,body) });
}
const errorReply = (route: Route, status: number, code: string) => route.fulfill({ status, contentType: 'application/json', body: fixtureJson(route,{ code }) });
const activeMaterials = (state: State) => state.materials.filter(material => !state.versions.inactive_material_ids.includes(material.material_id));
const refs = (state: State) => activeMaterials(state).map(material => ({ material_id: material.material_id, material_version: material.material_version }));
const writes = (state: State) => state.calls.filter(call => call.method !== 'GET' && !call.path.endsWith('/pdf-quality'));
function expectNoExecution(state: State) {
  expect(state.inputAttempts).toEqual([]); expect(state.locked).toEqual([]); expect(state.preflights).toEqual([]);
  expect(state.quotes).toEqual([]); expect(state.executes).toEqual([]);
}
function oldRecords(state: State) {
  return structuredClone({ input: state.inputs.get(7), run: state.runs.get(oldRunId), artifacts: [...state.artifacts.values()],
    materials: state.materials, versions: state.versions, source: state.project.update_details?.source_prospectuses });
}
function addNewerCurrent(state: State) {
  const run = successfulRun('synthetic-continuation-run-9', 9, 'synthetic-revision-9');
  state.runs.set(run.run_id, run); state.inputs.set(9, publicInput(9, refs(state)));
  for (const artifact of artifactPair(run.run_id, newerPin, 'synthetic-revision-9')) state.artifacts.set(artifact.artifact_id, artifact);
  state.versions.versions.push(generatedVersion(run.run_id, newerPin, 'synthetic-revision-9', 4));
  state.versions.current_version_id = 'synthetic-generated-4'; state.versions.selection_revision++;
  state.project.draft_revision++; state.project.input_revision = 9; state.project.input_hash = state.inputs.get(9)!.input_hash;
}
function adoptExistingNewerCurrent(state: State) {
  state.versions.current_version_id = 'synthetic-generated-4'; state.versions.selection_revision++;
  state.project = { ...state.project, draft_revision: state.project.draft_revision + 1 };
}
function completeSyntheticRun(state: State, run: Dto<'RunResponse'>) {
  const revisionId = `synthetic-completed-revision-${run.input_revision}`;
  const pin: Pin = { artifact_id: `synthetic-completed-clean-${run.input_revision}`, artifact_version: run.input_revision,
    sha256: sha256(`synthetic-completed-clean-${run.input_revision}`) };
  run.state = 'succeeded'; run.stage = 'succeeded'; run.artifact_id = revisionId;
  for (const artifact of artifactPair(run.run_id, pin, revisionId)) state.artifacts.set(artifact.artifact_id, artifact);
  const sequence = Math.max(...state.versions.versions.map(version => version.sequence)) + 1;
  const version = generatedVersion(run.run_id, pin, revisionId, sequence); state.versions.versions.push(version);
  state.versions.current_version_id = version.version_id; state.versions.selection_revision++; state.project.draft_revision++;
}
async function install(page: Page, state = fixture()) {
  installed.set(page, state); page.on('pageerror', error => state.errors.push(error.message));
  await page.context().route('https://synthetic.invalid/**', async route => {
    state.unexpected.push(`BINARY ${route.request().url()}`); await route.abort();
  });
  await page.context().route('**/api/v1/**', async route => {
    if(await serveDisabledBillingCatalog(route))return;
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname.replace('/api/v1', '');
    const body: unknown = request.postData() && request.headers()['content-type']?.includes('application/json') ? fixtureRequest(request) : undefined;
    state.calls.push({ method, path, ...(body === undefined ? {} : { body: structuredClone(body) }) });
    if (method === 'GET' && path === '/me') return reply(route, 'MeResponse', { user_id: state.owner, session_status: 'active' });
    if (method === 'GET' && path === '/account') return reply(route, 'AccountResponse', { user_id: state.owner, username: 'synthetic', phone_masked: null,
      status: 'active', created_at: now, accepted_terms_version: null, current_terms_version: null, password_updated_at: null,
      self_service_recovery: 'unavailable', support_contact: null });
    if (method === 'GET' && path === '/credits/balance') return reply(route, 'CreditBalanceResponse', { enabled: true, available: state.available, frozen: 0 });
    if (method === 'GET' && path === '/projects') return reply(route, 'ProjectListResponse', {
      items: state.owner === ownerId ? [state.project, state.otherProject].map(project => ({ project_id: project.project_id, name: project.name,
        draft_revision: project.draft_revision, updated_at: now, kind: project.kind, issuer_name: project.issuer_name, market: project.market,
        offering: project.offering, latest_run: null, latest_artifact: null })) : [], page: { has_more: false, next_cursor: null } });
    const projectMatch = path.match(/^\/projects\/([^/]+)(.*)$/);
    if (projectMatch) {
      const requestedProject = projectMatch[1], suffix = projectMatch[2];
      if (state.owner !== ownerId || ![projectId, otherProjectId].includes(requestedProject)) return errorReply(route, 404, 'NOT_FOUND');
      const project = requestedProject === projectId ? state.project : state.otherProject;
      const materials = requestedProject === projectId ? state.materials : [];
      if(await serveAuditPdfQuality(route,requestedProject,materials))return;
      if (method === 'GET' && suffix === '') {
        if (requestedProject === projectId && state.holdNextProjectRead) {
          state.holdNextProjectRead = false; state.heldProjectRead = true;
          await new Promise<void>(resolve => { state.releaseProjectRead = resolve; });
          state.heldProjectRead = false; state.releaseProjectRead = undefined;
          return reply(route, 'ProjectResponse', state.project);
        }
        return reply(route, 'ProjectResponse', project);
      }
      if (method === 'PATCH' && suffix === '' && requestedProject === projectId) {
        checked('ProjectPatchRequest', body); state.patches.push(structuredClone(body));
        if (request.headers()['if-match'] !== String(project.draft_revision)) return errorReply(route, 409, 'DRAFT_REVISION_CONFLICT');
        state.project = { ...project, ...structuredClone(body), draft_revision: project.draft_revision + 1, updated_at: now };
        return reply(route, 'ProjectResponse', state.project);
      }
      if (method === 'GET' && suffix === '/tasks') {
        const response = taskPage(requestedProject, [...state.runs.values()].filter(run => run.project_id === requestedProject).reverse(), project.kind);
        if (requestedProject === projectId && state.holdNextTasksRead) {
          state.holdNextTasksRead = false; state.heldTasksRead = true;
          await new Promise<void>(resolve => { state.releaseTasksRead = resolve; });
          state.heldTasksRead = false; state.releaseTasksRead = undefined;
        }
        return reply(route, 'ProjectTasksResponse', response);
      }
      if (method === 'GET' && suffix === '/messages') return reply(route, 'ProjectMessagePage', {
        conversation_id: requestedProject, items: [], project_message_set_ref: emptyMessages, next_cursor: null, has_more: false });
      if (method === 'GET' && suffix === '/prospectus-versions') {
        if (state.failVersions && requestedProject === projectId) return errorReply(route, 503, 'DATA_UNAVAILABLE');
        const response = structuredClone(requestedProject === projectId ? state.versions : {
          project_id: otherProjectId, current_version_id: null, selection_revision: 0, inactive_material_ids: [], versions: [] });
        if (requestedProject === projectId) {
          state.versionReads++;
          if (state.holdVersionsAt === state.versionReads) {
            state.holdVersionsAt = undefined; state.heldVersions = true;
            await new Promise<void>(resolve => { state.releaseVersions = resolve; });
            state.heldVersions = false; state.releaseVersions = undefined;
            await reply(route, 'ProspectusVersionsResponse', response); state.releasedVersions++; return;
          }
        }
        return reply(route, 'ProspectusVersionsResponse', response);
      }
      if (method === 'GET' && suffix === '/events') return reply(route, 'ProjectEventsResponse', {
        items: materials.map((material, index) => ({ event_id: `synthetic-material-event-${index}`, schema_version: 1 as const, trace_id: 'synthetic-trace',
          project_id: requestedProject, seq: index + 1, occurred_at: now, type: 'material.upload_progress' as const,
          payload: { material_id: material.material_id } })).filter(event => event.seq > Number(url.searchParams.get('after') ?? 0)), next_cursor: null });
      const material = materials.find(value => suffix === `/materials/${value.material_id}`);
      if (method === 'GET' && material) return state.failMaterial ? errorReply(route, 503, 'DATA_UNAVAILABLE') : reply(route, 'MaterialResponse', material);
      if (method === 'GET' && materials.some(value => suffix === `/materials/${value.material_id}/parse-job`)) return errorReply(route, 404, 'NOT_FOUND');
      const inputMatch = suffix.match(/^\/input-revisions\/(\d+)$/);
      if (method === 'GET' && inputMatch && requestedProject === projectId) {
        const input = state.inputs.get(Number(inputMatch[1]));
        return input ? reply(route, 'InputRevisionResponse', input) : errorReply(route, 404, 'NOT_FOUND');
      }
      if (method === 'POST' && suffix === '/input-revisions' && requestedProject === projectId) {
        checked('InputRevisionCreateRequest', body); state.inputAttempts.push(structuredClone(body));
        if (body.draft_revision !== state.project.draft_revision || body.prospectus_selection_revision !== state.versions.selection_revision) return errorReply(route, 409, 'INPUT_REVISION_CONFLICT');
        expect([...body.material_versions].sort((a, b) => a.material_id.localeCompare(b.material_id))).toEqual(refs(state).sort((a, b) => a.material_id.localeCompare(b.material_id)));
        expect(body).toHaveProperty('edit_base'); expect(body.project_message_set_ref).toEqual(emptyMessages); expect(body.requirement_message_ids).toEqual([]);
        if (body.edit_base) expect(state.versions.versions.some(version => version.origin === 'generated' && version.artifact_id === body.edit_base!.artifact_id &&
          version.artifact_version === body.edit_base!.artifact_version && version.sha256 === body.edit_base!.sha256)).toBe(true);
        const revision = Math.max(...state.inputs.keys()) + 1;
        const response = publicInput(revision, body.material_versions, sha256(JSON.stringify({ revision, body })));
        state.locked.push({ request: structuredClone(body), projectSnapshot: structuredClone(state.project), response: structuredClone(response) });
        state.inputs.set(revision, response); state.project.input_revision = revision; state.project.input_hash = response.input_hash;
        if (state.dropNextInputResponse) { state.dropNextInputResponse = false; return route.abort('connectionreset'); }
        return reply(route, 'InputRevisionResponse', response, 201);
      }
      if (method === 'POST' && suffix === '/preflight' && requestedProject === projectId) {
        checked('PreflightRequest', body); state.preflights.push(structuredClone(body));
        const input = state.locked.at(-1)!.response; expect(body).toEqual({ input_revision: input.input_revision, input_hash: input.input_hash });
        return reply(route, 'PreflightResponse', { project_id: projectId, ...body, status: 'ready', missing_inputs: [], uncertainty: [],
          blocking_inputs: [], advisory_inputs: [], billing_mode: 'fixed_credits' });
      }
      if (method === 'POST' && suffix === '/credit-quote' && requestedProject === projectId) {
        checked('FixedQuoteRequest', body); state.quotes.push(structuredClone(body)); expect(body).toEqual(state.preflights.at(-1));
        state.quote = { quote_id: `synthetic-quote-${body.input_revision}-v${state.quoteVersion}`, project_id: projectId, ...body, task_type: 'annual', points: 17900,
          price_version: `synthetic-continuation-v${state.quoteVersion}`, reason: '合成续改任务', created_at: now };
        return reply(route, 'FixedQuoteResponse', { enabled: true, quote: state.quote, balance: { available: state.available, frozen: 0 },
          shortage: Math.max(0, state.quote.points - state.available), reason: null });
      }
    }
    if (method === 'POST' && path === '/runs/execute') {
      checked('ExecuteRequest', body); state.executes.push(structuredClone(body));
      const input = state.locked.at(-1)!.response;
      expect(body.project_id).toBe(projectId); expect(body.workspace_id).toBe(projectId); expect(body.task_kind).toBe('update');
      expect(body.input_revision).toBe(input.input_revision); expect(body.input_hash).toBe(input.input_hash);
      expect(body.input_manifest_ref).toBe(input.input_hash); expect(body.quote_id).toBe(state.quote!.quote_id);
      if (state.dropNextExecuteBeforeAcceptance) { state.dropNextExecuteBeforeAcceptance = false; return route.abort('connectionreset'); }
      if (state.rejectNextExecute) {
        const code = state.rejectNextExecute; state.rejectNextExecute = undefined; state.quoteVersion++;
        if (code === 'CREDITS_INSUFFICIENT') state.available = 0;
        return errorReply(route, 409, code);
      }
      let run = [...state.runs.values()].find(value => value.execution_request_id === body.execution_request_id);
      if (!run) { run = { ...successfulRun(`synthetic-new-run-${input.input_revision}`, input.input_revision, 'unused'),
        execution_request_id: body.execution_request_id, input_hash: body.input_hash, state: 'queued', stage: 'queued', artifact_id: null };
        state.runs.set(run.run_id, run); state.runQuotes.set(run.run_id, structuredClone(state.quote)); }
      if (state.dropNextExecuteResponse) { state.dropNextExecuteResponse = false; return route.abort('connectionreset'); }
      return reply(route, 'RunResponse', run, 202);
    }
    const run = [...state.runs.values()].find(value => path === `/runs/${value.run_id}` || path.startsWith(`/runs/${value.run_id}/`));
    if (method === 'GET' && run) {
      if (state.owner !== ownerId) return errorReply(route, 404, 'NOT_FOUND');
      if (path === `/runs/${run.run_id}`) return reply(route, 'RunResponse', run);
      if (path === `/runs/${run.run_id}/events`) return reply(route, 'RunEventsResponse', { items: [], next_cursor: null });
      if (path === `/runs/${run.run_id}/stream`) return route.fulfill({ contentType: 'text/event-stream', body: ': synthetic polling fallback\n\n' });
      if (path === `/runs/${run.run_id}/credit-charge`) return reply(route, 'RunCreditChargeResponse', {
        quote: state.runQuotes.get(run.run_id) ?? null, state: run.state === 'succeeded' ? 'settled' : run.state === 'failed' || run.state === 'cancelled' ? 'released' : 'held' });
    }
    const artifact = state.artifacts.get(path.replace(/^\/artifacts\//, ''));
    if (method === 'GET' && artifact && path === `/artifacts/${artifact.artifact_id}`) return state.owner === ownerId
      ? reply(route, 'ArtifactResponse', artifact) : errorReply(route, 404, 'NOT_FOUND');
    state.unexpected.push(`${method} ${path}`); return errorReply(route, 501, 'UNEXPECTED_SYNTHETIC_REQUEST');
  });
  return state;
}
test.afterEach(async ({ page }) => {
  const state = installed.get(page); if (!state) return;
  expect(state.unexpected, 'Every synthetic endpoint must be explicitly allowed; uploads/downloads are never expected.').toEqual([]);
  expect(state.errors, 'No unhandled browser errors.').toEqual([]);
  expect(state.calls.filter(call => /uploads|\/download|\/bytes/.test(call.path)), 'Existing materials must be reused without uploading or downloading bytes.').toEqual([]);
});
const summary = (page: Page) => page.locator('[data-next-authoring-summary]');
const basis = (page: Page) => page.locator('[data-next-basis-choice]');
const routeFor = (options: { run?: string; prepare?: boolean; basis?: 'result' | 'current'; step?: 'details' | 'materials'; after?: number } = {}) => {
  const query = new URLSearchParams({ step: options.step ?? 'materials', run: options.run ?? oldRunId });
  if (options.prepare) { query.set('prepare', 'next'); query.set('prepare_after', String(options.after ?? 7)); if (options.basis) query.set('basis', options.basis); }
  return `/#/projects/${projectId}?${query}`;
};
async function openCompleted(page: Page, state = fixture()) {
  await install(page, state); await page.goto(routeFor()); await expect(page.locator('#prepare-next-version')).toBeVisible();
  await expect(page.locator('#workspace-material-count')).toContainText('2'); return state;
}
async function prepare(page: Page) {
  await page.locator('#prepare-next-version').click(); await expect(summary(page)).toBeVisible();
  await expect(page.locator('#execute-input')).toBeEnabled();
}
async function expectSummary(page: Page, filename = '合成第7轮募集书_清洁版.docx', sequence = 3) {
  await expect(summary(page)).toContainText(filename); await expect(summary(page)).toContainText(new RegExp(`V\\s*${sequence}`, 'i'));
  await expect(summary(page)).toContainText('清洁版'); await expect(summary(page)).toContainText('2024'); await expect(summary(page)).toContainText('2025');
  await expect(summary(page)).not.toContainText('2023'); await expect(summary(page)).toContainText('合成已保存财务资料.pdf');
  await expect(summary(page)).toContainText('合成有效历史原件.pdf'); await expect(summary(page)).not.toContainText('合成停用旧原稿.pdf');
}
async function startAndAssert(page: Page, state: State, expectedPin: Pin | null) {
  await page.locator('#execute-input').click(); await expect.poll(() => state.executes.length).toBe(1);
  expect(state.inputAttempts).toHaveLength(1); expect(state.locked).toHaveLength(1); expect(state.preflights).toHaveLength(1); expect(state.quotes).toHaveLength(1);
  expect(state.locked[0].request.edit_base).toEqual(expectedPin); expect(state.locked[0].request.prospectus_selection_revision).toBe(state.versions.selection_revision);
  expect(state.locked[0].request.draft_revision).toBe(state.locked[0].projectSnapshot.draft_revision);
  expect(state.executes[0].execution_request_id).not.toBe(state.runs.get(oldRunId)!.execution_request_id);
  await expect(page.locator('#execute-input')).toBeDisabled(); await expect(summary(page)).toBeHidden();
}
async function screenshotAtTop(page: Page, directory: string, filename: string) {
  await mkdir(directory, { recursive: true });
  await page.evaluate(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0);
  });
  await page.screenshot({ path: join(directory, filename), fullPage: true });
}

test('ordinary start with an adopted clean result displays inherited format before a continuation choice', async ({ page }) => {
  const state = fixture(); state.runs.clear(); state.project.input_revision = null; state.project.input_hash = null;
  await install(page, state); await page.goto(`/#/projects/${projectId}?step=materials`);
  await expect(page.locator('#material-editing')).toBeEnabled();
  await expect(page.locator('[data-format-template-result]')).toBeVisible();
  await expect(page.locator('[data-format-template-details]')).toBeHidden();
  await expect(page.locator('[data-format-template="synthetic-historical-current"]')).toBeHidden();
  await expect(page.locator('[data-format-template="synthetic-historical-current"]')).toBeDisabled();
  expect(state.patches).toEqual([]); expectNoExecution(state);
});

test('template fidelity: continuation inherits the exact result format and restores source choices for an uploaded basis', async ({ page }) => {
  const state = fixture(); addNewerCurrent(state); await openCompleted(page, state); await prepare(page);
  await expectSummary(page, '合成第7轮募集书_清洁版.docx', 3);
  await expect(page.locator('[data-format-template-result]')).toBeVisible();
  await expect(page.locator('[data-format-template-result]')).toHaveText('沿用所选成果格式，参考原稿仅用于补充内容。');
  const source = page.locator('[data-format-template="synthetic-historical-current"]');
  await expect(source).toBeHidden(); await expect(source).toBeDisabled();
  await source.evaluate(node => { (node as HTMLInputElement).checked = true; node.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(state.patches).toEqual([]); expectNoExecution(state);
  await page.reload(); await expectSummary(page);
  await expect(page.locator('[data-format-template-result]')).toBeVisible(); await expect(source).toBeDisabled();
  state.versions.current_version_id = 'synthetic-upload-version-2'; state.versions.selection_revision++;
  await basis(page).selectOption('current');
  await expect(page.locator('[data-format-template-result]')).toBeHidden();
  await expect(source).toBeVisible(); await expect(source).toBeEnabled();
  expect(state.patches).toEqual([]); expectNoExecution(state);
});

for (const width of [1440, 390]) test(`${width}: continue and refresh restore only preparation intent with the exact saved summary`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 960 }); const state = await openCompleted(page); const old = oldRecords(state);
  const evidence = process.env.BB_UX_EVIDENCE_DIR;
  if (evidence) {
    await expect(page.locator('#artifact-downloads')).toBeVisible();
    await screenshotAtTop(page, evidence, `continuation-implementation-completed-${width}.png`);
  }
  await expect(summary(page)).toBeHidden(); await prepare(page); await expect(basis(page)).toHaveValue('result'); await expectSummary(page);
  await expect(page).toHaveURL(/prepare=next/); await expect(page).toHaveURL(new RegExp(`run=${oldRunId}`)); await expect(page).toHaveURL(/basis=result/);
  await expect(page).toHaveURL(/prepare_after=7/);
  expect(writes(state)).toEqual([]); expectNoExecution(state); await page.reload(); await expectSummary(page);
  await expect(page.locator('#project-materials-details')).toHaveJSProperty('open', true); await expect(summary(page)).toBeVisible();
  await expect(basis(page)).toHaveValue('result'); await expect(page.locator('#execute-input')).toBeEnabled();
  expectNoExecution(state); expect(writes(state)).toEqual([]); expect(oldRecords(state)).toEqual(old);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (evidence) await screenshotAtTop(page, evidence, `continuation-${width}.png`);
});

test('initial task read does not freeze safe draft editing and a saved name survives run restoration', async ({ page }) => {
  const state = fixture(); state.holdNextTasksRead = true; const oldInput = structuredClone(state.inputs.get(7)), oldRun = structuredClone(state.runs.get(oldRunId));
  await install(page, state);
  try {
    await page.goto(routeFor({ step: 'details' })); await expect.poll(() => state.heldTasksRead).toBe(true);
    await expect(page.locator('#draft-form')).toBeVisible(); await expect(page.locator('#draft-form')).toHaveJSProperty('inert', false);
    await expect(page.locator('#name')).toBeEditable(); await expect(page.locator('#execute-input')).toBeDisabled();
    await page.locator('#name').fill('初始任务读取期间已保存的本地名称'); await page.locator('#save-draft').click();
    await expect(page.locator('#save-state')).toHaveText('已保存'); expect(state.project.name).toBe('初始任务读取期间已保存的本地名称');
    expect(state.patches).toHaveLength(1); expect(state.patches[0].name).toBe('初始任务读取期间已保存的本地名称');
    expect(state.project.draft_revision).toBe(12); expect(state.heldTasksRead).toBe(true);
    await expect(page.locator('#execute-input')).toBeDisabled(); expectNoExecution(state);
    state.releaseTasksRead!(); await expect(page.locator('#prepare-next-version')).toHaveCount(1);
    await expect(page.locator('#name')).toHaveValue('初始任务读取期间已保存的本地名称');
    await page.locator('#continue-materials').click(); await expect(page.locator('#workspace-materials')).toBeVisible();
    await expect(page.locator('#draft-form')).toBeHidden(); await expect(page.locator('#prepare-next-version')).toBeVisible();
    await expect(page.locator('#artifact-downloads')).toBeVisible(); await expect(page.locator('#execute-input')).toBeDisabled();
    expect(state.project.name).toBe('初始任务读取期间已保存的本地名称'); expect(state.patches).toHaveLength(1);
    expect(state.inputs.get(7)).toEqual(oldInput); expect(state.runs.get(oldRunId)).toEqual(oldRun); expectNoExecution(state);
    expect(writes(state).map(call => ({ method: call.method, path: call.path }))).toEqual([{ method: 'PATCH', path: `/projects/${projectId}` }]);
  } finally { state.releaseTasksRead?.(); }
});

test('explicit generation creates one new immutable input/run using the exact clean pin and existing versions', async ({ page }) => {
  const state = await openCompleted(page), old = oldRecords(state); await prepare(page); expectNoExecution(state);
  await startAndAssert(page, state, cleanPin);
  expect([...state.locked[0].request.material_versions].sort((a, b) => a.material_id.localeCompare(b.material_id))).toEqual(refs(state).sort((a, b) => a.material_id.localeCompare(b.material_id)));
  expect(state.locked[0].projectSnapshot.update_details?.target_reporting_periods).toEqual(actualPeriods);
  expect(state.locked[0].projectSnapshot.update_details?.source_prospectuses).toEqual(old.source);
  expect(oldRecords(state)).toEqual(old); const created = structuredClone(state.locked), execution = structuredClone(state.executes);
  await page.reload(); await expect(page.locator('#execute-input')).toBeDisabled(); expect(state.locked).toEqual(created); expect(state.executes).toEqual(execution);
});

test('a historical successful run defaults to its own clean output even when current points at a newer result', async ({ page }) => {
  const state = fixture(); addNewerCurrent(state); await openCompleted(page, state); const old = oldRecords(state);
  await prepare(page); await expect(basis(page)).toHaveValue('result'); await expectSummary(page);
  await expect(summary(page)).not.toContainText('合成第9轮募集书_清洁版.docx'); await startAndAssert(page, state, cleanPin); expect(oldRecords(state)).toEqual(old);
});

test('explicit current choice uses current_version_id and persists that choice across refresh', async ({ page }) => {
  const state = fixture(); addNewerCurrent(state); await openCompleted(page, state); const old = oldRecords(state); await prepare(page);
  await basis(page).selectOption('current'); await expectSummary(page, '合成第9轮募集书_清洁版.docx', 4); await expect(page).toHaveURL(/basis=current/);
  expectNoExecution(state); await page.reload(); await expect(basis(page)).toHaveValue('current'); await expectSummary(page, '合成第9轮募集书_清洁版.docx', 4);
  expect(writes(state)).toEqual([]); await startAndAssert(page, state, newerPin); expect(oldRecords(state)).toEqual(old);
});

test('failed task without a reference stays blocked until a saved uploaded source is available, then uses a null edit base', async ({ page }) => {
  const state = fixture(), oldRun = state.runs.get(oldRunId)!; oldRun.state = 'failed'; oldRun.stage = 'failed'; oldRun.artifact_id = null;
  const source = structuredClone(state.materials[0]), sourceInformation = structuredClone(state.project.update_details!.source_prospectuses);
  const sourceVersion = structuredClone(state.versions.versions.find(version => version.material_id === source.material_id)!);
  const originalRun = structuredClone(oldRun), originalInput = structuredClone(state.inputs.get(7));
  state.versions.current_version_id = null; state.versions.versions = []; state.versions.selection_revision = 0;
  state.materials = [state.materials[1]]; state.versions.inactive_material_ids = [];
  const financial = structuredClone(state.materials[0]);
  state.project.update_details!.source_prospectuses = []; state.project.update_details!.has_historical = false;
  await install(page, state); await page.goto(routeFor()); await expect(page.locator('#prepare-next-version')).toBeVisible();
  await page.locator('#prepare-next-version').click(); await expect(summary(page)).toBeVisible();
  await expect(basis(page)).toHaveValue('current'); await expect(summary(page)).toContainText(/尚未采用|没有|无|首稿/); expectNoExecution(state);
  await expect(page.locator('#execute-input')).toBeDisabled();
  await expect(page.locator('#start-disabled-reason')).toContainText('历史／参考募集书');
  await page.locator('#execute-input').dispatchEvent('click'); expectNoExecution(state);
  expect(state.materials).toEqual([financial]); expect(state.inputs.get(7)).toEqual(originalInput); expect(state.runs.get(oldRunId)).toEqual(originalRun);

  // This HTTP-boundary fixture now exposes a persisted, adopted original with
  // complete declarations. Upload bytes themselves are covered by upload suites.
  state.materials.unshift(source); state.versions.versions = [sourceVersion];
  state.versions.current_version_id = sourceVersion.version_id; state.versions.selection_revision++;
  state.project.update_details!.source_prospectuses = sourceInformation; state.project.update_details!.has_historical = true;
  state.project.draft_revision++;
  await page.reload(); await expect(summary(page)).toBeVisible(); await expect(basis(page)).toHaveValue('current');
  await expect(summary(page)).toContainText(source.filename); await expect(page.locator('#execute-input')).toBeEnabled();
  await startAndAssert(page, state, null); expect(state.locked[0].request.material_versions).toEqual(refs(state));
  expect(state.locked[0].request.material_versions).toContainEqual({material_id:financial.material_id,material_version:financial.material_version});
  expect(state.inputs.get(7)).toEqual(originalInput); expect(state.runs.get(oldRunId)).toEqual(originalRun);
});

test('missing exact result mapping blocks until the user explicitly selects current, without substituting the revision file', async ({ page }) => {
  const state = fixture(); addNewerCurrent(state); state.versions.versions = state.versions.versions.filter(version => version.run_id !== oldRunId);
  await openCompleted(page, state); await page.locator('#prepare-next-version').click(); await expect(summary(page)).toBeVisible();
  await expect(basis(page)).toHaveValue('result'); await expect(page.locator('#execute-input')).toBeDisabled();
  await expect(summary(page)).toContainText(/无法|未找到|缺少|不能|不可/); expectNoExecution(state);
  await basis(page).selectOption('current'); await expectSummary(page, '合成第9轮募集书_清洁版.docx', 4);
  await expect(page.locator('#execute-input')).toBeEnabled(); await startAndAssert(page, state, newerPin);
});

test('an active same-project task takes precedence over a terminal run preparation URL', async ({ page }) => {
  const state = fixture(); const active = { ...successfulRun('synthetic-active-run', 8, 'unused'), state: 'running' as const, stage: 'authoring', artifact_id: null };
  state.runs.set(active.run_id, active); state.inputs.set(8, publicInput(8, refs(state))); state.project.input_revision = 8; state.project.input_hash = active.input_hash;
  await install(page, state); await page.goto(routeFor({ prepare: true, basis: 'result' }));
  await expect(page.locator('#execution-progress')).toBeVisible(); await expect(page.locator('#execute-input')).toBeDisabled();
  await expect(summary(page)).toBeHidden(); await expect(page.locator('#prepare-next-version')).toHaveCount(0);
  await expect(page.locator('[data-upload-role=audit]')).toBeDisabled(); expectNoExecution(state); expect(writes(state)).toEqual([]);
});

test('a newer terminal task clears an older preparation URL instead of preparing or executing again', async ({ page }) => {
  const state = fixture(); const newer = { ...successfulRun('synthetic-newer-terminal', 8, 'unused'), state: 'failed' as const, stage: 'failed', artifact_id: null };
  state.runs.set(newer.run_id, newer); state.inputs.set(8, publicInput(8, refs(state)));
  state.project.input_revision = 8; state.project.input_hash = newer.input_hash;
  await install(page, state); await page.goto(routeFor({ prepare: true, basis: 'result', after: 7 }));
  await expect(page.locator('#prepare-next-version')).toBeVisible(); await expect(page.locator('#execute-input')).toBeDisabled();
  await expect(summary(page)).toBeHidden(); await expect(page).not.toHaveURL(/prepare=next/);
  await expect(page).toHaveURL(/run=synthetic-newer-terminal/); expectNoExecution(state); expect(writes(state)).toEqual([]);
});

test('an input saved after preparation without a corresponding task requires record review and never resumes preparation', async ({ page }) => {
  const state = fixture(); state.inputs.set(8, publicInput(8, refs(state))); state.project.input_revision = 8; state.project.input_hash = state.inputs.get(8)!.input_hash;
  await install(page, state); await page.goto(routeFor({ prepare: true, basis: 'result', after: 7 }));
  await expect(page.locator('#execute-input')).toBeDisabled(); await expect(summary(page)).toBeHidden();
  await expect(page.locator('#execution-message')).toContainText(/输入|任务|记录|核对/); await expect(page).not.toHaveURL(/prepare=next/);
  expectNoExecution(state); expect(writes(state)).toEqual([]);
});

test('changed selection stops before input creation and requires explicit basis refresh before generation', async ({ page }) => {
  // Both task/input records predate preparation. Only the explicit selection
  // changes afterward; this must not exercise the newer-task restore guard.
  const state = fixture(); addNewerCurrent(state); state.versions.current_version_id = 'synthetic-generated-3';
  await openCompleted(page, state); await prepare(page); await basis(page).selectOption('current'); await expectSummary(page);
  await expect(page).toHaveURL(/prepare_after=9/);
  const input9 = structuredClone(state.inputs.get(9)), run9 = structuredClone(state.runs.get('synthetic-continuation-run-9'));
  adoptExistingNewerCurrent(state); const old = oldRecords(state);
  await page.locator('#execute-input').click(); await expect(page.locator('[data-next-refresh-basis]')).toBeVisible();
  await expect(page.locator('#execute-input')).toBeDisabled(); expectNoExecution(state);
  await page.locator('[data-next-refresh-basis]').click(); await expectSummary(page, '合成第9轮募集书_清洁版.docx', 4);
  await expect(page.locator('#execute-input')).toBeEnabled(); expectNoExecution(state); await startAndAssert(page, state, newerPin);
  expect(oldRecords(state)).toEqual(old); expect(state.inputs.get(9)).toEqual(input9); expect(state.runs.get('synthetic-continuation-run-9')).toEqual(run9);
});

test('an in-flight explicit basis refresh preserves dirty local fields when another page changes selection', async ({ page }) => {
  const state = fixture(); addNewerCurrent(state); state.versions.current_version_id = 'synthetic-generated-3';
  await openCompleted(page, state); await prepare(page); await basis(page).selectOption('current'); await expectSummary(page);
  const oldInput = structuredClone(state.inputs.get(7)), oldSource = structuredClone(state.project.update_details!.source_prospectuses);
  state.holdNextProjectRead = true;
  try {
    await page.locator('[data-next-refresh-basis]').click(); await expect.poll(() => state.heldProjectRead).toBe(true);
    await page.locator('[data-next-edit-details]').click(); await expect(page.locator('#draft-form')).toBeVisible();
    adoptExistingNewerCurrent(state); const remote = structuredClone(state.project);
    await page.locator('#name').fill('本页尚未保存的项目名称'); state.releaseProjectRead!();
    // The serialized draft writer must keep the original CAS revision. Its
    // eventual 409 leaves the local value intact and stops background writes.
    await expect(page.locator('#save-state')).toHaveText('有版本冲突'); await expect(page.locator('#conflict-panel')).toBeVisible();
    await expect(page.locator('#name')).toHaveValue('本页尚未保存的项目名称'); expect(state.project).toEqual(remote);
    expect(state.patches).toHaveLength(1); expect(state.inputs.get(7)).toEqual(oldInput); expect(state.project.update_details!.source_prospectuses).toEqual(oldSource);
    page.once('dialog', dialog => dialog.dismiss()); await page.locator('#reload-draft').click();
    await expect(page.locator('#name')).toHaveValue('本页尚未保存的项目名称'); expect(state.project).toEqual(remote); expectNoExecution(state);
  } finally { state.releaseProjectRead?.(); }
});

test('a late basis response cannot restore exited preparation or overwrite a newer explicit choice', async ({ page }) => {
  const state = fixture(); addNewerCurrent(state); state.versions.current_version_id = 'synthetic-generated-3';
  await openCompleted(page, state); await prepare(page); await basis(page).selectOption('current'); await expectSummary(page);
  // Refresh first reads versions for material recovery, then reads the exact
  // basis. Hold the latter with its old immutable response body.
  state.holdVersionsAt = state.versionReads + 2;
  try {
    await page.locator('[data-next-refresh-basis]').click(); await expect.poll(() => state.heldVersions).toBe(true);
    await page.locator('[data-next-leave]').click(); await expect(summary(page)).toBeHidden(); await expect(page).not.toHaveURL(/prepare=next/);
    adoptExistingNewerCurrent(state); await prepare(page); await expect(basis(page)).toHaveValue('result'); await expectSummary(page);
    await basis(page).selectOption('current'); await expectSummary(page, '合成第9轮募集书_清洁版.docx', 4);
    await expect(page.locator('#execute-input')).toBeEnabled(); state.releaseVersions!();
    await expect.poll(() => state.releasedVersions).toBe(1);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(basis(page)).toHaveValue('current'); await expectSummary(page, '合成第9轮募集书_清洁版.docx', 4);
    await expect(summary(page)).not.toContainText('合成第7轮募集书_清洁版.docx');
    await expect(page).toHaveURL(/basis=current/); await expect(page.locator('#execute-input')).toBeEnabled();
    expectNoExecution(state); expect(writes(state)).toEqual([]);
  } finally { state.releaseVersions?.(); }
});

test('detail steps preserve preparation and actual periods; explicit target change affects only the next snapshot', async ({ page }) => {
  const state = await openCompleted(page), originalInput = structuredClone(state.inputs.get(7)), originalSource = structuredClone(state.project.update_details!.source_prospectuses);
  await prepare(page); await page.locator('[data-next-edit-details]').click(); await expect(page.locator('#draft-form')).toBeVisible();
  await expect(page).toHaveURL(/prepare=next/); await expect(page).toHaveURL(/basis=result/); await expect(page).toHaveURL(/prepare_after=7/);
  await page.locator('#name').fill('已更名的合成续改项目'); await page.locator('#continue-materials').click();
  await expect(page.locator('#workspace-materials')).toBeVisible(); await expect(page.locator('#draft-form')).toBeHidden(); await expect(summary(page)).toBeVisible();
  await expectSummary(page);
  expect(state.project.update_details!.target_reporting_periods).toEqual(actualPeriods); expect(state.project.update_details!.source_prospectuses).toEqual(originalSource);
  await expect(page).toHaveURL(/prepare=next/); await page.reload(); await expectSummary(page); expectNoExecution(state);
  await page.locator('[data-next-edit-details]').click(); await page.locator('#reporting-year').selectOption('2026');
  await page.locator('[name=reporting_quarter][value="06-30"]').check(); await page.locator('#continue-materials').click();
  await expect(page.locator('#workspace-materials')).toBeVisible(); await expect(page.locator('#draft-form')).toBeHidden(); await expect(summary(page)).toBeVisible();
  await expect(summary(page)).toContainText('2026'); expect(state.project.update_details!.reporting_cutoff).toBe('2026-06-30');
  expect(state.project.update_details!.target_reporting_periods).not.toEqual(actualPeriods); await startAndAssert(page, state, cleanPin);
  expect(state.locked[0].projectSnapshot.update_details!.reporting_cutoff).toBe('2026-06-30'); expect(state.inputs.get(7)).toEqual(originalInput);
  expect(state.project.update_details!.source_prospectuses).toEqual(originalSource);
});

test('preparation never leaks to another project or owner and a foreign requested run cannot enable execution', async ({ page }) => {
  const state = await openCompleted(page); await prepare(page); await page.goto(`/#/projects/${otherProjectId}?step=materials`);
  await expect(page.locator('#project-heading')).toHaveText('另一个合成项目'); await expect(summary(page)).toBeHidden();
  await expect(page.locator('.material-file-row')).toHaveCount(0); expectNoExecution(state);
  const foreign = { ...successfulRun('synthetic-foreign-run', 7, 'synthetic-foreign-artifact'), project_id: otherProjectId };
  state.runs.set(foreign.run_id, foreign); await page.goto(routeFor({ prepare: true, basis: 'result', run: foreign.run_id }));
  await expect(page.locator('#execute-input')).toBeDisabled(); await expect(summary(page)).toBeHidden(); expectNoExecution(state);
  state.owner = 'synthetic-continuation-owner-b'; await page.reload(); await expect(page.getByRole('heading', { name: '项目暂时无法打开' })).toBeVisible();
  await expect(summary(page)).toHaveCount(0); await expect(page.locator('.material-file-row')).toHaveCount(0); expectNoExecution(state); expect(writes(state)).toEqual([]);
});

test('basis read failure and mismatched saved source identity block without guessed pins or replacement uploads', async ({ page }) => {
  const state = await openCompleted(page); await prepare(page); state.failVersions = true;
  await page.locator('[data-next-refresh-basis]').click(); await expect(page.locator('#execute-input')).toBeDisabled();
  await expect(summary(page)).toContainText(/无法|失败|重新|暂时/); expectNoExecution(state);
  state.failVersions = false; await page.locator('[data-next-refresh-basis]').click(); await expectSummary(page); await expect(page.locator('#execute-input')).toBeEnabled();
  state.failMaterial = true; await page.reload(); await expect(page.locator('#material-recovery-status')).toContainText('无法读取服务器材料记录');
  await expect(page.locator('#execute-input')).toBeDisabled(); expectNoExecution(state); state.failMaterial = false;
  state.materials[0] = { ...state.materials[0], material_version: 3, sha256: sha256('changed-source-without-metadata') };
  await page.reload(); await expect(summary(page)).toBeVisible(); await expect(page.locator('#execute-input')).toBeDisabled();
  await expect(page.locator('#start-disabled-reason')).toContainText(/原稿|原件|材料|补齐/); expectNoExecution(state); expect(writes(state)).toEqual([]);
});

test('lost continuation execute response freezes editing and retries the identical complete request after server completion', async ({ page }) => {
  const state = await openCompleted(page), oldInput = structuredClone(state.inputs.get(7)), oldRun = structuredClone(state.runs.get(oldRunId));
  const originalMaterials = structuredClone(state.materials); await prepare(page); state.dropNextExecuteResponse = true;
  await page.locator('#execute-input').click(); await expect(page.locator('#retry-execution')).toBeVisible();
  await expect.poll(() => state.executes.length).toBe(1); await expect(page.locator('#retry-execution')).toBeEnabled();
  await expect(page.locator('#execution-message')).toContainText('提交结果尚未确认');
  expect(state.inputAttempts).toHaveLength(1); expect(state.locked).toHaveLength(1); expect(state.preflights).toHaveLength(1); expect(state.quotes).toHaveLength(1);
  expect(state.executes).toHaveLength(1); expect(state.runs.size).toBe(2);
  const envelope = structuredClone(state.executes[0]), locked = structuredClone(state.locked[0]);
  expect(envelope.quote_id).toBeTruthy(); expect(locked.request.edit_base).toEqual(cleanPin);
  await expect(summary(page)).toBeHidden(); await expect(basis(page)).toBeHidden(); await expect(page.locator('#prepare-next-version')).toHaveCount(0);
  await expect(page.locator('#edit-project-details')).toBeDisabled(); await expect(page.locator('#draft-form')).toHaveJSProperty('inert', true);
  await expect(page.locator('[data-upload-role=audit]')).toBeDisabled(); await expect(page.locator('#project-conversation-root')).toBeHidden();
  await expect(page.locator('#execute-input')).toBeDisabled();
  const accepted = [...state.runs.values()].find(run => run.execution_request_id === envelope.execution_request_id)!;
  expect(accepted).toBeDefined(); completeSyntheticRun(state, accepted);
  await page.locator('#retry-execution').click(); await expect(page.locator('#artifact-downloads')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`run=${accepted.run_id}`));
  await expect.poll(() => state.calls.some(call => call.method === 'GET' && call.path === `/artifacts/${accepted.artifact_id}`)).toBe(true);
  await expect(page.locator('#retry-execution')).toBeHidden(); await expect(summary(page)).toBeHidden();
  expect(state.executes).toEqual([envelope, envelope]); expect(state.locked).toEqual([locked]); expect(state.inputAttempts).toHaveLength(1);
  expect(state.preflights).toHaveLength(1); expect(state.quotes).toHaveLength(1); expect(state.inputs.size).toBe(2); expect(state.runs.size).toBe(2);
  expect(state.inputs.get(7)).toEqual(oldInput); expect(state.runs.get(oldRunId)).toEqual(oldRun); expect(state.materials).toEqual(originalMaterials);
  await page.reload(); await expect(page.locator('#artifact-downloads')).toBeVisible();
  expect(state.executes).toEqual([envelope, envelope]); expect(state.locked).toEqual([locked]); expect(state.runs.size).toBe(2);
});

test('unknown execute without acceptance survives read-only refresh and a definitive quote rejection recovers the same input', async ({ page }) => {
  const state = await openCompleted(page); await prepare(page); state.dropNextExecuteBeforeAcceptance = true;
  await page.locator('#execute-input').click(); await expect(page.locator('#retry-execution')).toBeVisible();
  await expect.poll(() => state.executes.length).toBe(1); await expect(page.locator('#retry-execution')).toBeEnabled();
  await expect(page.locator('#execution-message')).toContainText('提交结果尚未确认');
  expect(state.executes).toHaveLength(1); expect(state.runs.size).toBe(1); expect(state.locked).toHaveLength(1);
  const envelope = structuredClone(state.executes[0]), locked = structuredClone(state.locked[0]);
  const inputRequest = structuredClone(state.inputAttempts[0]), preflight = structuredClone(state.preflights[0]), quoteRequest = structuredClone(state.quotes[0]);
  expect(state.inputAttempts).toEqual([inputRequest]); expect(state.preflights).toEqual([preflight]); expect(state.quotes).toEqual([quoteRequest]);
  const beforeReadback = state.calls.length;
  await page.locator('#refresh-execution').click(); await expect(page.locator('#retry-execution')).toBeEnabled();
  await expect(page.locator('#execution-message')).toContainText(/准确回执|尚未确认|核对/);
  await expect(page.locator('#execute-input')).toBeDisabled(); await expect(page.locator('#prepare-next-version')).toHaveCount(0);
  await expect(page).toHaveURL(/prepare=next/); await expect(page).toHaveURL(/basis=result/); await expect(page).toHaveURL(/prepare_after=7/);
  expect(state.calls.slice(beforeReadback).filter(call => call.method !== 'GET' && !call.path.endsWith('/pdf-quality'))).toEqual([]);
  expect(state.executes).toEqual([envelope]); expect(state.inputAttempts).toEqual([inputRequest]); expect(state.locked).toEqual([locked]);
  expect(state.preflights).toEqual([preflight]); expect(state.quotes).toEqual([quoteRequest]); expect(state.runs.size).toBe(1);
  state.rejectNextExecute = 'QUOTE_CHANGED'; await page.locator('#retry-execution').click();
  await expect(page.locator('#execution-message')).toContainText(/计费|报价|积分/); await expect(page.locator('#retry-execution')).toBeHidden();
  expect(state.executes).toEqual([envelope, envelope]); expect(state.runs.size).toBe(1); expect(state.locked).toEqual([locked]);
  await expect.poll(() => state.quotes.length).toBe(2);
  expect(state.inputAttempts).toEqual([inputRequest]); expect(state.preflights).toEqual([preflight]); expect(state.quotes).toEqual([quoteRequest, quoteRequest]);
  await expect(page.locator('#execute-input')).toBeEnabled(); await page.locator('#execute-input').click(); await expect.poll(() => state.runs.size).toBe(2);
  expect(state.executes).toHaveLength(3); expect(state.locked).toEqual([locked]); expect(state.inputAttempts).toEqual([inputRequest]); expect(state.inputs.size).toBe(2);
  const { quote_id: originalQuote, ...originalInput } = envelope, { quote_id: recoveredQuote, ...recoveredInput } = state.executes[2];
  expect(recoveredInput).toEqual(originalInput); expect(recoveredQuote).not.toBe(originalQuote); expect(recoveredQuote).toBe(state.quote!.quote_id);
  expect(state.preflights).toEqual([preflight]); expect(state.quotes).toEqual([quoteRequest, quoteRequest]); await expect(page.locator('#retry-execution')).toBeHidden();
});

test('read-only execution refresh finds an exact completed receipt without retrying or creating another task', async ({ page }) => {
  const state = await openCompleted(page); await prepare(page); state.dropNextExecuteResponse = true;
  await page.locator('#execute-input').click(); await expect(page.locator('#retry-execution')).toBeVisible();
  await expect.poll(() => state.executes.length).toBe(1); await expect(page.locator('#retry-execution')).toBeEnabled();
  await expect(page.locator('#execution-message')).toContainText('提交结果尚未确认');
  const envelope = structuredClone(state.executes[0]), locked = structuredClone(state.locked[0]);
  const accepted = [...state.runs.values()].find(run => run.execution_request_id === envelope.execution_request_id)!;
  expect(accepted).toBeDefined(); completeSyntheticRun(state, accepted); const beforeReadback = state.calls.length;
  await page.locator('#refresh-execution').click(); await expect(page.locator('#retry-execution')).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`run=${accepted.run_id}`)); await expect(page).not.toHaveURL(/prepare=next/);
  await expect.poll(() => state.calls.some(call => call.method === 'GET' && call.path === `/artifacts/${accepted.artifact_id}`)).toBe(true);
  await expect(page.locator('#artifact-downloads')).toBeVisible();
  expect(state.calls.slice(beforeReadback).filter(call => call.method !== 'GET' && !call.path.endsWith('/pdf-quality'))).toEqual([]);
  expect(state.executes).toEqual([envelope]); expect(state.locked).toEqual([locked]); expect(state.inputAttempts).toHaveLength(1);
  expect(state.preflights).toHaveLength(1); expect(state.quotes).toHaveLength(1); expect(state.inputs.size).toBe(2); expect(state.runs.size).toBe(2);
  await page.reload(); await expect(page.locator('#artifact-downloads')).toBeVisible();
  expect(state.executes).toEqual([envelope]); expect(state.locked).toEqual([locked]); expect(state.runs.size).toBe(2);
});

for (const code of ['QUOTE_CHANGED', 'QUOTE_REQUIRED', 'CREDITS_INSUFFICIENT'] as const) test(`continuation ${code} recovers a fresh quote on the same locked input`, async ({ page }) => {
  const state = await openCompleted(page); await prepare(page); state.rejectNextExecute = code;
  await page.locator('#execute-input').click(); await expect(page.locator('#execution-message')).toContainText(/积分|计费|更新|核验/);
  expect(state.executes).toHaveLength(1); expect(state.runs.size).toBe(1); expect(state.inputAttempts).toHaveLength(1); expect(state.locked).toHaveLength(1);
  await expect(page.locator('#retry-execution')).toBeHidden();
  const rejected = structuredClone(state.executes[0]), locked = structuredClone(state.locked[0]);
  if (code === 'CREDITS_INSUFFICIENT') {
    await expect(page.locator('#refresh-quote')).toBeVisible(); state.available = 100000;
    await page.locator('#refresh-quote').click(); await expect(page.locator('#fixed-quote')).toBeHidden();
  }
  await expect(page.locator('#execute-input')).toBeEnabled(); await page.locator('#execute-input').click();
  await expect.poll(() => state.runs.size).toBe(2); await expect(page.locator('#execute-input')).toBeDisabled();
  expect(state.executes).toHaveLength(2); expect(state.inputAttempts).toHaveLength(1); expect(state.locked).toEqual([locked]); expect(state.inputs.size).toBe(2);
  const recovered = state.executes[1];
  expect(recovered.execution_request_id).toBe(rejected.execution_request_id); expect(recovered.input_revision).toBe(rejected.input_revision);
  expect(recovered.input_hash).toBe(rejected.input_hash); expect(recovered.input_manifest_ref).toBe(rejected.input_manifest_ref);
  expect(recovered.quote_id).not.toBe(rejected.quote_id); expect(recovered.quote_id).toBe(state.quote!.quote_id);
  expect(state.quotes.length).toBeGreaterThanOrEqual(2); expect(state.locked[0].request.edit_base).toEqual(cleanPin);
  await expect(page.locator('#retry-execution')).toBeHidden();
});

test('lost continuation input response requires honest readback and never guesses that the saved input is executable', async ({ page }) => {
  const state = await openCompleted(page), oldInput = structuredClone(state.inputs.get(7)), oldRun = structuredClone(state.runs.get(oldRunId));
  await prepare(page); state.dropNextInputResponse = true; await page.locator('#execute-input').click();
  await expect(page.locator('#execution-message')).toContainText(/保存结果尚未确认|输入.*未确认/);
  await expect(page.locator('#execution-message')).not.toContainText('用已保存内容开始更新');
  await expect(page.locator('#refresh-execution')).toBeVisible(); await expect(page.locator('#execute-input')).toBeDisabled();
  await expect(page.locator('#select-saved-input')).toBeHidden(); await expect(page.locator('#retry-execution')).toBeHidden();
  expect(state.inputAttempts).toHaveLength(1); expect(state.locked).toHaveLength(1); expect(state.inputs.size).toBe(2); expect(state.runs.size).toBe(1);
  expect(state.preflights).toEqual([]); expect(state.quotes).toEqual([]); expect(state.executes).toEqual([]);
  const accepted = structuredClone(state.locked[0]); await page.locator('#refresh-execution').click();
  await expect(page.locator('#execution-message')).toContainText(/更新的输入版本|任务记录|核对记录/);
  await expect(summary(page)).toBeHidden(); await expect(page.locator('#execute-input')).toBeDisabled(); await expect(page.locator('#select-saved-input')).toBeHidden();
  await expect(page).not.toHaveURL(/prepare=next/);
  expect(state.inputAttempts).toHaveLength(1); expect(state.locked).toEqual([accepted]); expect(state.preflights).toEqual([]); expect(state.quotes).toEqual([]); expect(state.executes).toEqual([]);
  expect(state.inputs.get(7)).toEqual(oldInput); expect(state.runs.get(oldRunId)).toEqual(oldRun); expect(state.inputs.size).toBe(2); expect(state.runs.size).toBe(1);
});

test('authoring preparation: repeated continue preserves explicit current basis', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = fixture(); addNewerCurrent(state); await openCompleted(page, state); const old = oldRecords(state);
  const originalButton = await page.locator('#prepare-next-version').elementHandle(); expect(originalButton).not.toBeNull();
  await prepare(page); await basis(page).selectOption('current'); await expectSummary(page, '合成第9轮募集书_清洁版.docx', 4);
  await expect(page.locator('#prepare-next-version')).toHaveCount(0); expect(await originalButton!.evaluate(node => node.isConnected)).toBe(false);
  const before = { hash: await page.evaluate(() => location.hash), inputs: structuredClone([...state.inputs]), attempts: structuredClone(state.inputAttempts),
    locked: structuredClone(state.locked), writes: structuredClone(writes(state)) };
  // The old listener remains on this detached node. It must preserve an already
  // explicit basis rather than reinitializing preparation to the older result.
  await originalButton!.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await expect(basis(page)).toHaveValue('current'); await expectSummary(page, '合成第9轮募集书_清洁版.docx', 4); await expect(page.locator('#prepare-next-version')).toHaveCount(0);
  expect({ hash: await page.evaluate(() => location.hash), inputs: structuredClone([...state.inputs]), attempts: structuredClone(state.inputAttempts),
    locked: structuredClone(state.locked), writes: structuredClone(writes(state)) }).toEqual(before);
  expect(oldRecords(state)).toEqual(old); expectNoExecution(state);
  await page.reload(); await expect(basis(page)).toHaveValue('current'); await expectSummary(page, '合成第9轮募集书_清洁版.docx', 4); await expect(page.locator('#prepare-next-version')).toHaveCount(0);
  expectNoExecution(state); expect(writes(state)).toEqual([]); await startAndAssert(page, state, newerPin); expect(oldRecords(state)).toEqual(old);
});

test('authoring preparation desktop component comparison at 1440px retains the explicit current basis', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const reference = process.env.BB_AUTHORING_SOURCE_GUIDE_REFERENCE === '1', verify = reference ? await installAuthoringSourceGuideReference(page) : undefined;
  const directory = process.env.BB_AUTHORING_SOURCE_GUIDE_EVIDENCE_DIR ?? test.info().outputPath('component-capture');
  const state = fixture(); addNewerCurrent(state); await openCompleted(page, state); const old = oldRecords(state);
  const originalButton = await page.locator('#prepare-next-version').elementHandle(); expect(originalButton).not.toBeNull();
  await prepare(page); await basis(page).selectOption('current'); await expectSummary(page, '合成第9轮募集书_清洁版.docx', 4);
  const before = { hash: await page.evaluate(() => location.hash), inputs: structuredClone([...state.inputs]), attempts: structuredClone(state.inputAttempts),
    locked: structuredClone(state.locked), writes: structuredClone(writes(state)) };
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); scrollTo(0, 0); });
  if (reference) await expect(page.locator('#prepare-next-version')).toBeVisible(); else await expect(page.locator('#prepare-next-version')).toHaveCount(0);
  await captureAuthoringPreparation(page, directory!, 'authoring-source-guide-current-basis-1440', { reference, action: 'same explicitly selected newer current basis', before, old_records: old }, true);
  if (reference) {
    await page.locator('#prepare-next-version').click(); await expect(basis(page)).toHaveValue('result'); await expectSummary(page);
  } else {
    await originalButton!.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await expect(basis(page)).toHaveValue('current'); await expectSummary(page, '合成第9轮募集书_清洁版.docx', 4);
  }
  const after = { hash: await page.evaluate(() => location.hash), inputs: structuredClone([...state.inputs]), attempts: structuredClone(state.inputAttempts),
    locked: structuredClone(state.locked), writes: structuredClone(writes(state)) };
  if (reference) { expect(after.hash).not.toBe(before.hash); expect(after.hash).toContain('basis=result'); }
  else expect(after).toEqual(before);
  expect(after.inputs).toEqual(before.inputs); expect(after.attempts).toEqual(before.attempts); expect(after.locked).toEqual(before.locked); expect(after.writes).toEqual([]);
  expect(oldRecords(state)).toEqual(old); expectNoExecution(state);
  await writeFile(join(directory!, 'authoring-source-guide-repeat-check-1440.json'), JSON.stringify({ reference, before, after, basis: await basis(page).inputValue(), old_records_unchanged: true }, null, 2));
  if (verify) await writeFile(join(directory!, 'authoring-source-guide-continuation-reference-1440.json'), JSON.stringify(await verify(), null, 2));
});
