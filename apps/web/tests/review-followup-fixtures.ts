import {serveDisabledBillingCatalog} from './billing-fixture-wire';
import {fixtureBody} from './billing-fixture-wire';
import {fixtureRequest} from './billing-fixture-wire';
import { expect, type Page, type Route } from '@playwright/test';
import { FormatRegistry, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { createHash } from 'node:crypto';
import { schemas, ReviewDraftInputSchema, ReviewDraftRequestSchema, ReviewEditorResponseSchema,
  ReviewExecutionRequestSchema, ReviewExportRequestSchema, ReviewReadableReportSchema, ReviewSourceRequestSchema,
  isReviewReport, type ReviewDraftInput, type ReviewDraftRequest, type ReviewEditorResponse,
  type ReviewExecutionRequest, type ReviewExportRequest, type ReviewHistoryEntry, type ReviewReport,
  type ReviewWorkspace, type Run } from '@bondbuddy/contracts';
import type { Dto } from './billing-fixture-wire';
import { taskPage } from './collection-fixtures';

// Public HTTP fixtures exercise the real UI. Synthetic Word bytes do not establish
// document generation, professional review, worker execution or billing acceptance.
export const projectId = 'synthetic-review-followup', owner = 'synthetic-review-followup-owner';
export const now = '2026-10-25T08:00:00Z';
export const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const runId = (version: number) => `followup-run-${version}`;
export const title = (version: number) => `V${version} 专属现金流差异待补证`;
export const marker = (version: number) => `合成成果 V${version} 的现金流原文为 ${version}00 万元。`;
const reportId = (version: number) => `followup-report-${version}`;
FormatRegistry.Set('date-time', value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value));
export type Call = { method: string; path: string; search: string; body?: unknown };
function check(schema: TSchema, value: unknown, name: string) {
  expect(Value.Check(schema, value), `${name}: ${JSON.stringify([...Value.Errors(schema, value)])}`).toBe(true);
}
function checked<K extends keyof typeof schemas>(name: K, value: unknown): asserts value is Dto<K> { check(schemas[name], value, name); }
function input(draft: ReviewWorkspace['draft']): ReviewDraftInput { const { version: _version, ...value } = draft; return structuredClone(value); }
export function fixture(mode: 'editor' | 'readable' | 'structured' = 'editor') {
  const materialBytes = new Map<number, string>([[1, 'Synthetic source v1: cash 100.'], [2, 'Synthetic source v2: cash 200.']]);
  const materials = new Map<number, Dto<'MaterialResponse'>>([...materialBytes].map(([version, bytes]) => [version, {
    material_id: 'followup-source', material_version: version, upload_id: `followup-source-upload-${version}`,
    role: 'historical', filename: `合成待复核稿-v${version}.docx`, media_type: mime,
    byte_size: Buffer.byteLength(bytes), sha256: hash(bytes), state: 'persisted', persisted_at: now, error: null,
  }]));
  const pin = (version: number) => { const m = materials.get(version)!; return { material_id: m.material_id, material_version: version, sha256: m.sha256 }; };
  const project: ReviewWorkspace['project'] = { project_id: projectId, name: '合成复核事项接续项目', kind: 'review',
    issuer_name: '合成发行人', market: 'sse', offering: 'private', draft_revision: 1,
    input_revision: 1, input_hash: hash('followup input'), updated_at: now };
  const draft: ReviewWorkspace['draft'] = { version: 4, source_material_ref: pin(2), material_versions: [pin(2)],
    requirements: ['原已保存要求。'], as_of: null, evidence_links: [] };
  const history: ReviewHistoryEntry[] = [], editors = new Map<string, ReviewEditorResponse>(), reports = new Map<string, ReviewReport>();
  const metadata = new Map<string, Dto<'ArtifactResponse'>>(), bytes = new Map<string, string>();
  const catalog: Dto<'ProspectusVersionsResponse'> = { project_id: projectId, current_version_id: 'followup-clean-version-2',
    selection_revision: 9, inactive_material_ids: [], versions: [] };
  const state = { mode, project, draft, history, editors, reports, materials, materialBytes, metadata, bytes, catalog,
    activeRun: null as Run | null, calls: [] as Call[], unexpected: [] as string[], errors: [] as string[],
    drafts: [] as ReviewDraftRequest[], quotes: [] as ReviewExecutionRequest[], executions: [] as ReviewExecutionRequest[],
    exports: [] as ReviewExportRequest[], sources: [] as { version_id: string }[], failDraft: false,
    importedMismatch: undefined as 'sha256' | 'role' | 'media_type' | 'state' | undefined,
    extraMaterials: [] as Dto<'MaterialResponse'>[], workspaceReads: 0, materialReads: [] as number[], materialDownloads: [] as number[],
    dropExport: false, sourceGate: undefined as (() => Promise<void>) | undefined,
    dropDraft: undefined as 'before' | 'after' | undefined, afterDropDraft: undefined as (() => void) | undefined,
    readableProse: false, uploads: [] as Dto<'UploadCreateRequest'>[], uploadedBytes: 0,
    supplement: undefined as Dto<'MaterialResponse'> | undefined };
  const makeRun = (version: number, status: Run['state'] = 'succeeded', requestId = `followup-request-${version}`): Run => ({
    run_id: runId(version), execution_request_id: requestId, project_id: projectId, input_revision: status === 'succeeded' ? 1 : state.draft.version,
    input_hash: hash(`followup-input-${version}`), channel: 'production', test_grant_id: null, uncovered_items: [], state: status,
    stage: status === 'running' ? 'review_model_call' : status === 'queued' ? 'queued' : null,
    event_cursor: 0, billing_mode: 'platform_trial', reservation_id: null,
    artifact_id: status === 'succeeded' ? `followup-${version}-report` : null, prompt_snapshot_ref: null, updated_at: now,
  });
  const addVersion = (version: number) => {
    const run = makeRun(version), artifacts: ReviewHistoryEntry['artifacts'] = [];
    for (const kind of mode === 'editor' ? ['revision', 'clean', 'report'] as const : ['report'] as const) {
      const artifact_id = `followup-${version}-${kind}`, payload = `Synthetic review V${version} ${kind} Word bytes.`;
      const filename = `合成复核成果V${version}-${kind}.docx`, artifactVersion = version + 2;
      bytes.set(artifact_id, payload); metadata.set(artifact_id, { artifact_id, run_id: run.run_id, version: artifactVersion,
        filename, media_type: mime, sha256: hash(payload), quality_status: 'passed', delivery_status: 'available',
        download_url: `/api/v1/artifacts/${artifact_id}/download`, expires_at: '2027-01-01T00:00:00Z' });
      artifacts.push({ artifact_id, artifact_version: artifactVersion, kind, filename });
      if (kind === 'clean') catalog.versions.unshift({ version_id: `followup-clean-version-${version}`, sequence: 40 + version,
        origin: 'generated', filename, sha256: hash(payload), created_at: now, material_id: null, material_version: null,
        artifact_id, artifact_version: artifactVersion, revision_artifact_id: `followup-${version}-revision`, run_id: run.run_id });
    }
    const entry: ReviewHistoryEntry = { run, operation: 'full_review', version, source_report_id: null,
      report_id: mode === 'structured' ? reportId(version) : null, input: { ...input(draft), source_material_ref: pin(1), material_versions: [pin(1)] },
      input_revision: 1, finding_ids: [], plan: null, artifacts, created_at: now };
    history.unshift(entry);
    if (mode === 'editor') editors.set(run.run_id, { run_id: run.run_id, sha256: hash(`editor-${version}`), snapshot: {
      version: 'review-editor-v1', source_filename: `合成成果V${version}.docx`, source_sha256: materials.get(1)!.sha256,
      source_format: 'docx', warnings: [], paragraphs: [{ id: 'p1', text: marker(version) }], issues: [{
        id: `editor-item-${version}`, decision: 'original', manual_text: '', category: '财务核对', title: title(version),
        original: marker(version), replacement: `合成建议 V${version} 金额待确认。`, reason: `成果 V${version} 缺少同口径附注。`,
        evidence: `成果 V${version} 合成审计报告。`, missing: '请补充同口径现金流附注。', uncertain: true,
        paragraph_id: 'p1', applied: false, limitation: '' }] } });
    if (mode === 'structured') {
      const evidence = { material_id: 'followup-source', material_version: 1, material_sha256: materials.get(1)!.sha256,
        parse_snapshot_id: 'followup-parse-v1', parse_response_sha256: hash('parse-v1'), record_id: 'followup-record-v1',
        record_sha256: hash(marker(version)), locator_type: 'docx_block' as const, locator: { paragraph: 10 },
        quote: marker(version), extraction_method: 'native_text' as const, uncertainty: [] };
      const report: ReviewReport = { report_id: reportId(version), project_id: projectId, run_id: run.run_id,
        input_revision: 1, version, source_material: pin(1), scope: { mode: 'full_review', finding_ids: [] }, findings: [{
          finding_id: `public-finding-${version}`, report_id: reportId(version), dimension: 'financial', conclusion: 'needs_evidence',
          severity: 'P2', title: title(version), description: `成果 V${version} 缺少现金流附注。`, target_refs: [evidence], evidence_refs: [],
          suggested_change: '取得同口径附注后再核验。', limitations: ['合成测试，不代表专业复核。'],
          repairability: { can_revise: false, reason: '需要补证。', allowed_record_ids: [] },
          origin_report_id: reportId(version), check_status: 'rechecked' }], coverage: [], limitations: [], created_at: now };
      expect(isReviewReport(report)).toBe(true); reports.set(report.report_id, report);
    }
    return entry;
  };
  const addRunning = (version = 3, requestId = `followup-request-${version}`) => {
    const run = makeRun(version, 'running', requestId);
    const entry: ReviewHistoryEntry = { run, operation: 'full_review', version, source_report_id: null, report_id: null,
      input: input(state.draft), input_revision: state.draft.version, finding_ids: [], plan: null, artifacts: [], created_at: now };
    history.unshift(entry); state.activeRun = run; return entry;
  };
  const completeActive = () => {
    const active = history.find(h => h.run.run_id === state.activeRun?.run_id); if (!active) throw new Error('No active synthetic review.');
    const completed = addVersion(active.version);
    completed.input = structuredClone(active.input); completed.input_revision = active.input_revision;
    completed.run.input_revision = active.run.input_revision; completed.run.input_hash = active.run.input_hash;
    completed.run.execution_request_id = active.run.execution_request_id;
    history.splice(history.indexOf(active), 1); state.activeRun = null; return completed;
  };
  addVersion(1); addVersion(2);
  return Object.assign(state, { addVersion, addRunning, completeActive });
}
export type State = ReturnType<typeof fixture>;
const installed = new WeakMap<Page, State>();
function workspace(state: State, requested: string | null): ReviewWorkspace {
  const completed = state.history.filter(h => h.run.state === 'succeeded').sort((a, b) => b.version - a.version);
  const report = requested ? state.reports.get(requested) : undefined;
  const selected = report ? completed.find(h => h.run.run_id === report.run_id) : completed[0];
  const value: ReviewWorkspace = { project: state.project, materials: [state.materials.get(2)!, ...state.extraMaterials], draft: state.draft,
    message_drafts: [], active_run: state.activeRun, selected_report: report ?? state.reports.get(selected?.report_id ?? '') ?? null,
    reports: [...state.reports.values()].map(r => ({ report_id: r.report_id, run_id: r.run_id, version: r.version, created_at: now })),
    messages: [], plan: null, artifacts: selected?.artifacts ?? [], artifact_run: selected ? {
      run_id: selected.run.run_id, version: selected.version, operation: selected.operation, source_report_id: selected.source_report_id } : null,
    timeline: state.history.map(h => ({ kind: 'task', entry_id: `task:${h.run.run_id}`, created_at: h.created_at, task: {
      run: h.run, operation: h.operation, version: h.version, input_version: h.input_revision, input_revision: h.input_revision,
      input_sha256: h.run.input_hash, source_report_id: h.source_report_id, report_id: h.report_id, finding_ids: h.finding_ids,
      origin: { version: 'review-execution-origin-v1', entrypoint: 'quick_action', accepted_proposal: null, context_report_ref: null },
      artifacts: h.artifacts, events: [] } })) };
  // Workspace/history have public TypeScript DTOs, rather than a response JSON schema.
  // Validate every schema-backed nested record using the actual public contracts.
  checked('ProjectResponse', value.project); check(ReviewDraftInputSchema, input(value.draft), 'ReviewDraftInput');
  value.materials.forEach(m => checked('MaterialResponse', m)); if (value.active_run) checked('RunResponse', value.active_run);
  value.timeline?.forEach(t => { if (t.kind === 'task') checked('RunResponse', t.task.run); });
  return value;
}
async function reply<K extends keyof typeof schemas>(route: Route, name: K, body: Dto<K>, status = 200) {
  checked(name, body); return route.fulfill({ status, json: fixtureBody(route,body) });
}
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: fixtureBody(route,body) });
const problem = (route: Route, status: number, code: Dto<'Error'>['code']) => reply(route, 'Error', {
  code, message: `Synthetic ${code}`, retryable: status >= 500, field_errors: [], correlation_id: 'followup-synthetic-correlation',
}, status);
export async function install(page: Page, state = fixture()) {
  installed.set(page, state); page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/v1/**', async route => {
    if(await serveDisabledBillingCatalog(route))return;
    const request = route.request(), url = new URL(request.url()), path = url.pathname.slice('/api/v1'.length), method = request.method();
    const body = ['POST', 'PUT', 'PATCH'].includes(method) && path !== '/synthetic-review-followup-upload' && request.postData() ? fixtureRequest(request) : undefined;
    state.calls.push({ method, path, search: url.search, ...(body ? { body } : {}) });
    if (method === 'GET') {
      if (path === '/me') return reply(route, 'MeResponse', { user_id: owner, session_status: 'active' });
      if (path === '/account') return reply(route, 'AccountResponse', { user_id: owner, username: 'followup_owner', phone_masked: null,
        status: 'active', created_at: now, accepted_terms_version: 'v1', current_terms_version: 'v1', password_updated_at: null,
        self_service_recovery: 'unavailable', support_contact: null });
      if (path === '/credits/balance') return reply(route, 'CreditBalanceResponse', { enabled: false, available: 0, frozen: 0 });
      if (path === `/projects/${projectId}`) return reply(route, 'ProjectResponse', state.project);
      if (path === `/projects/${projectId}/tasks`) return reply(route, 'ProjectTasksResponse', taskPage(projectId, state.history.map(h => h.run), 'review'));
      if (path === `/projects/${projectId}/prospectus-versions`) return reply(route, 'ProspectusVersionsResponse', state.catalog);
      if (path === `/projects/${projectId}/review-draft`) { check(ReviewDraftInputSchema, input(state.draft), 'ReviewDraftInput'); return json(route, { draft: state.draft, message_drafts: [] }); }
      if (path === `/projects/${projectId}/review-history`) { state.history.forEach(h => { checked('RunResponse', h.run); check(ReviewDraftInputSchema, h.input, 'HistoryInput'); }); return json(route, { items: state.history }); }
      if (path === `/projects/${projectId}/review-workspace`) { state.workspaceReads++; return json(route, workspace(state, url.searchParams.get('report_id'))); }
      const editor = path.match(new RegExp(`^/projects/${projectId}/review-executions/([^/]+)/editor$`));
      if (editor && state.editors.has(editor[1])) { const value = state.editors.get(editor[1])!; check(ReviewEditorResponseSchema, value, 'ReviewEditorResponse'); return json(route, value); }
      const readable = path.match(new RegExp(`^/projects/${projectId}/review-executions/([^/]+)/readable-report$`));
      if (readable) {
        const entry = state.history.find(h => h.run.run_id === readable[1]);
        if (entry) { const markdown = state.readableProse
          ? `# 合成成果 V${entry.version} 复核报告\n\n## 财务核对\n**本次结论：** 成果 V${entry.version} 的现金流附注尚需补证。\n\n**核对依据：** ${marker(entry.version)}\n\n请补充同口径附注后重新核验。`
          : `# 合成成果 V${entry.version} 复核报告\n\n## 财务核对\n**本次结论：** 一项现金流事项待补证。\n\n### 1. ${title(entry.version)}\n**原文位置：** 第八章现金流表。\n\n**问题说明：** ${marker(entry.version)}\n\n**核对依据：** 成果 V${entry.version} 合成审计报告。\n\n**待确认事项：** 缺少同口径现金流附注。\n\n**修改建议：** 补证后重新核验。`;
          const value = { version: 'review-readable-v1', project_id: projectId, run_id: entry.run.run_id, execution_version: entry.version,
            status: 'available', markdown, content_sha256: hash(markdown) }; check(ReviewReadableReportSchema, value, 'ReviewReadableReport'); return json(route, value); }
      }
      const run = path.match(/^\/runs\/([^/]+)(?:\/(credit-charge|stream))?$/), entry = run && state.history.find(h => h.run.run_id === run[1]);
      if (run && entry) {
        if (run[2] === 'credit-charge') return reply(route, 'RunCreditChargeResponse', { quote: null, state: null });
        if (run[2] === 'stream') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': synthetic review followup\n\n' });
        return reply(route, 'RunResponse', entry.run);
      }
      const artifact = path.match(/^\/artifacts\/([^/]+)(\/download)?$/);
      if (artifact && state.metadata.has(artifact[1])) {
        if (artifact[2]) return route.fulfill({ status: 200, contentType: mime, body: state.bytes.get(artifact[1])! });
        return reply(route, 'ArtifactResponse', state.metadata.get(artifact[1])!);
      }
      const material = path.match(new RegExp(`^/projects/${projectId}/materials/followup-source(/download)?$`));
      if (material) {
        const version = Number(url.searchParams.get('version') ?? 2), value = state.materials.get(version);
        if (value) {
          if (material[1]) { state.materialDownloads.push(version); return route.fulfill({ status: 200, contentType: mime, body: state.materialBytes.get(version)! }); }
          state.materialReads.push(version); return reply(route, 'MaterialResponse', value);
        }
      }
    }
    if (method === 'PUT' && path === `/projects/${projectId}/review-draft`) {
      check(ReviewDraftRequestSchema, body, 'ReviewDraftRequest'); state.drafts.push(structuredClone(body));
      if (state.failDraft) return problem(route, 503, 'DATA_UNAVAILABLE');
      const drop = state.dropDraft; state.dropDraft = undefined;
      if (drop === 'before') { state.afterDropDraft?.(); return route.abort('connectionreset'); }
      if (body.kind !== 'input') throw new Error('Followup may save only the public input draft.');
      if (body.expected_version !== state.draft.version) return problem(route, 409, 'INPUT_REVISION_CONFLICT');
      state.draft = { ...structuredClone(body.input), version: body.expected_version + 1 };
      if (drop === 'after') return route.abort('connectionreset');
      return json(route, { draft: state.draft, message_drafts: [] });
    }
    if (method === 'POST' && path === `/projects/${projectId}/review-source`) {
      check(ReviewSourceRequestSchema, body, 'ReviewSourceRequest'); state.sources.push(structuredClone(body));
      const version = state.catalog.versions.find(v => v.version_id === body.version_id);
      if (!version) return problem(route, 404, 'NOT_FOUND');
      await state.sourceGate?.();
      const payload = state.bytes.get(version.artifact_id!)!;
      const material: Dto<'MaterialResponse'> = { material_id: `imported-${version.version_id}`, material_version: 1,
        upload_id: `import-${version.version_id}`, role: 'historical', filename: version.filename,
        media_type: mime, byte_size: Buffer.byteLength(payload), sha256: version.sha256, state: 'persisted', persisted_at: now, error: null };
      if (state.importedMismatch === 'sha256') material.sha256 = hash('foreign clean');
      if (state.importedMismatch === 'role') material.role = 'other';
      if (state.importedMismatch === 'media_type') material.media_type = 'application/pdf';
      if (state.importedMismatch === 'state') { material.state = 'failed'; material.error = 'SYNTHETIC_NOT_PERSISTED'; }
      if (!state.importedMismatch && !state.extraMaterials.some(m => m.material_id === material.material_id)) state.extraMaterials.push(material);
      return reply(route, 'MaterialResponse', material);
    }
    if (method === 'POST' && path === `/projects/${projectId}/review-executions/quote`) {
      check(ReviewExecutionRequestSchema, body, 'ReviewExecutionRequest'); state.quotes.push(structuredClone(body));
      return reply(route, 'FixedQuoteResponse', { enabled: false, quote: null, balance: { available: 0, frozen: 0 }, shortage: 0, reason: null });
    }
    if (method === 'POST' && path === `/projects/${projectId}/review-executions`) {
      check(ReviewExecutionRequestSchema, body, 'ReviewExecutionRequest'); state.executions.push(structuredClone(body));
      if (state.activeRun) return problem(route, 409, 'PROJECT_RUN_ACTIVE');
      expect(body.expected_input_version).toBe(state.draft.version);
      const entry = state.addRunning(Math.max(...state.history.map(h => h.version)) + 1, body.execution_request_id);
      return reply(route, 'RunResponse', entry.run, 202);
    }
    if (method === 'POST' && path === `/projects/${projectId}/review-exports`) {
      check(ReviewExportRequestSchema, body, 'ReviewExportRequest'); state.exports.push(structuredClone(body));
      let entry = state.history.find(h => h.run.execution_request_id === body.request_id);
      if (!entry) { entry = state.addVersion(Math.max(...state.history.map(h => h.version)) + 1); entry.run.execution_request_id = body.request_id; }
      if (state.dropExport) return route.abort('connectionreset');
      return reply(route, 'RunResponse', entry.run, 202);
    }
    if (method === 'POST' && path === `/projects/${projectId}/materials/uploads`) {
      checked('UploadCreateRequest', body); state.uploads.push(structuredClone(body));
      return reply(route, 'UploadSessionResponse', { upload_id: 'followup-supplement-upload', state: 'uploading',
        upload_url: '/api/v1/synthetic-review-followup-upload', expires_at: '2027-01-01T00:00:00Z', max_bytes: 104857600 }, 201);
    }
    if (method === 'PUT' && path === '/synthetic-review-followup-upload') {
      const upload = state.uploads.at(-1)!; const bytes = request.postDataBuffer()!;
      expect(bytes.byteLength).toBe(upload.byte_size); expect(createHash('sha256').update(bytes).digest('hex')).toBe(upload.sha256);
      state.uploadedBytes++; return route.fulfill({ status: 204 });
    }
    if (method === 'POST' && path === `/projects/${projectId}/materials/uploads/followup-supplement-upload/complete`) {
      const upload = state.uploads.at(-1)!;
      state.supplement ??= { ...upload, material_id: 'followup-supplement-financial', material_version: 1,
        upload_id: 'followup-supplement-upload', state: 'persisted', persisted_at: now, error: null };
      if (!state.extraMaterials.some(m => m.material_id === state.supplement!.material_id)) state.extraMaterials.push(state.supplement);
      return reply(route, 'MaterialResponse', state.supplement);
    }
    state.unexpected.push(`${method} ${path}${url.search}`); return problem(route, 500, 'DATA_UNAVAILABLE');
  });
  return state;
}
export async function setup(page: Page, state = fixture(), selectedRun = runId(1)) {
  await install(page, state);
  await page.goto(`/#/projects/${projectId}/review?tab=results&run=${selectedRun}`); return state;
}
export function assertFixture(page: Page) {
  const state = installed.get(page); if (!state) return;
  expect(state.unexpected, 'All HTTP requests must use the explicitly allowed public fixture routes.').toEqual([]);
  expect(state.errors, 'The real browser page must not throw.').toEqual([]);
}
export const mutations = (state: State) => state.calls.filter(c => c.method !== 'GET');
