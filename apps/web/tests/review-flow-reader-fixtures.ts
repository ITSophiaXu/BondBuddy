import {serveDisabledBillingCatalog} from './billing-fixture-wire';
import {fixtureBody} from './billing-fixture-wire';
import { expect, type Page, type Route } from '@playwright/test';
import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { createHash } from 'node:crypto';
import { ReviewDraftInputSchema, ReviewReadableReportSchema, schemas, type ReviewHistoryEntry, type ReviewWorkspace, type Run } from '@bondbuddy/contracts';
import type { Dto } from './billing-fixture-wire';
import { taskPage } from './collection-fixtures';
import { docx, downloadBytes } from './word-roundtrip-fixtures';
export { downloadBytes };

// Closed synthetic public HTTP data and minimal stored OOXML. These journeys do
// not exercise a model, worker, database, Blob service, ledger or Word application.
export const projectId = 'review-flow-reader-project', owner = 'review-flow-reader-owner';
export const now = '2026-10-25T08:00:00Z', mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
// The timeline producer hashes snapshot.input canonically, independently of the run manifest.
function canonicalInput(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalInput).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalInput((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const runId = (version: number) => `review-flow-reader-run-${version}`;
export const artifactId = (version: number, kind: string) => `review-flow-reader-${version}-${kind}`;
FormatRegistry.Set('date-time', value => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value)));

function markdown(version: number, other: boolean) {
  const items = (dimension: string, start: number) => Array.from({ length: 7 }, (_, index) => `### ${start + index}. V${version} ${dimension}事项${index + 1}\n\n**原文位置：** 第八章，第 ${index + 1} 项。\n\n**问题说明：** 合成 V${version} 专属依据；金额 ${version}00 万元，仍需核对报告期和口径。\n\n${Array.from({ length: 4 }, (_, paragraph) => `合成阅读段落 ${paragraph + 1}：本事项保留原文披露、对照依据、差异及影响。请结合原始材料核实，不代表专业结论已经通过。`).join('\n\n')}\n\n**修改建议：** 取得原始依据后人工核实。`).join('\n\n');
  return `# 合成长报告 V${version}\n\n## 财务核对\n\n本版财务核对仍有待确认事项。\n\n${items('财务核对', 1)}\n\n## 合规与披露\n\n本版披露结论需结合原始材料核实。\n\n${items('合规披露', 8)}\n\n## 公开信息核验\n\n公开信息核验未执行，不能据此判断无风险。${other ? '\n\n## 其他需确认事项\n\n### 15. V' + version + ' 名称需要确认\n\n材料名称尚需人工确认，不能确定所属维度。' : ''}\n\n## 建议处理顺序\n\n先核实原始依据，再在 Word 中处理。仍有待确认事项，不能据此认定复核通过。`;
}
function input(draft: ReviewWorkspace['draft']) { const { version: _version, ...value } = draft; return structuredClone(value); }
function checked<K extends keyof typeof schemas>(name: K, value: unknown): asserts value is Dto<K> {
  expect(Value.Check(schemas[name], value), `${name}: ${JSON.stringify([...Value.Errors(schemas[name], value)])}`).toBe(true);
}

export function fixture(options: { other?: boolean; revision?: boolean } = {}) {
  const source = docx('合成只读原募集书。'), material: Dto<'MaterialResponse'> = { material_id: 'reader-source', material_version: 1,
    upload_id: 'reader-source-upload', role: 'historical', filename: '合成待复核稿.docx', media_type: mime, byte_size: source.length,
    sha256: hash(source), state: 'persisted', persisted_at: now, error: null };
  const pin = { material_id: material.material_id, material_version: 1, sha256: material.sha256 };
  const latestInputRevision = options.revision ? 4 : 3;
  const project: Dto<'ProjectResponse'> = { project_id: projectId, name: '合成长报告历史项目', kind: 'review', issuer_name: '合成发行人',
    market: 'sse', offering: 'private', draft_revision: 1, input_revision: latestInputRevision, input_hash: hash('input-' + latestInputRevision), updated_at: now };
  const draft: ReviewWorkspace['draft'] = { version: 2, source_material_ref: pin, material_versions: [pin], requirements: ['合成只读长报告。'], as_of: null, evidence_links: [] };
  const history: ReviewHistoryEntry[] = [], metadata = new Map<string, Dto<'ArtifactResponse'>>(), bytes = new Map<string, Buffer>();
  const readable = new Map<string, Dto<'ReviewReadableReport'>>();
  const makeRun = (version: number, state: Run['state'] = 'succeeded'): Run => ({ run_id: runId(version), execution_request_id: `reader-execution-${version}`,
    project_id: projectId, input_revision: version, input_hash: hash('input-' + version), state, stage: state === 'running' ? 'review_model_call' : 'completed',
    channel: 'production', test_grant_id: null, uncovered_items: [], event_cursor: 0, billing_mode: 'platform_trial', reservation_id: null,
    artifact_id: state === 'succeeded' ? artifactId(version, version === 4 ? 'revision' : 'report') : null, prompt_snapshot_ref: null, updated_at: now });
  for (const version of [1, 2, ...(options.revision ? [4] : [])]) {
    const kinds: ('report' | 'comments' | 'revision' | 'clean')[] = version === 4 ? ['revision', 'clean'] : ['report', 'comments'];
    const artifacts = kinds.map(kind => {
      const id = artifactId(version, kind), payload = docx(`合成历史 V${version} ${kind} 专属文档；不代表真实复核。`);
      const filename = `合成冻结项目_${{ report: '复核报告', comments: '原文批注版', revision: '募集书修订版', clean: '募集书清洁版' }[kind]}_V${version}_20261024.docx`;
      bytes.set(id, payload); metadata.set(id, { artifact_id: id, run_id: runId(version), version: version + 6, display_version: version, filename,
        media_type: mime, sha256: hash(payload), quality_status: 'passed', delivery_status: 'available',
        download_url: `/api/v1/artifacts/${id}/download?grant=synthetic-reader`, expires_at: '2099-01-01T00:00:00Z' });
      return { artifact_id: id, artifact_version: version + 6, kind, filename };
    });
    history.unshift({ run: makeRun(version), operation: version === 4 ? 'revision' : 'full_review', version, source_report_id: null,
      report_id: null, input: input(draft), input_revision: version, finding_ids: [], plan: null, artifacts, created_at: now });
    if (version !== 4) {
      const text = markdown(version, options.other !== false);
      readable.set(runId(version), { version: 'review-readable-v1', project_id: projectId, run_id: runId(version), execution_version: version,
        status: 'available', markdown: text, content_sha256: hash(text) });
    }
  }
  const active = options.revision ? null : makeRun(3, 'running');
  if (active) history.unshift({ run: active, operation: 'full_review', version: 3, source_report_id: null, report_id: null, input: input(draft),
    input_revision: active.input_revision, finding_ids: [], plan: null, artifacts: [], created_at: now });
  return { project, material, draft, history, metadata, bytes, readable, active, revision: Boolean(options.revision), failReadable: false,
    calls: [] as { method: string; path: string }[], unexpected: [] as string[], errors: [] as string[],
    readableReads: [] as string[], metadataReads: [] as string[], byteReads: [] as string[] };
}
export type State = ReturnType<typeof fixture>;
export const writes = (state: State) => state.calls.filter(call => call.method !== 'GET');
export const immutable = (state: State) => structuredClone({ project: state.project, material: state.material, draft: state.draft, history: state.history,
  metadata: [...state.metadata], bytes: [...state.bytes].map(([id, payload]) => [id, hash(payload)]), readable: [...state.readable] });

function workspace(state: State): ReviewWorkspace {
  const selected = state.history.filter(entry => entry.run.state === 'succeeded').sort((a, b) => b.version - a.version)[0];
  return { project: state.project, materials: [state.material], draft: state.draft, message_drafts: [], messages: [], reports: [], selected_report: null,
    active_run: state.active, plan: null, artifacts: selected.artifacts, artifact_run: { run_id: selected.run.run_id, version: selected.version,
      operation: selected.operation, source_report_id: null, ...(state.revision ? { source_run_id: runId(1) } : {}) },
    timeline: state.history.map(entry => ({ kind: 'task', entry_id: 'task:' + entry.run.run_id, created_at: entry.created_at, task: {
      run: entry.run, operation: entry.operation, version: entry.version, input_version: state.draft.version, input_revision: entry.input_revision,
      input_sha256: hash(canonicalInput(entry.input)), source_report_id: null, report_id: null, finding_ids: [],
      origin: { version: 'review-execution-origin-v1', entrypoint: 'quick_action', accepted_proposal: null, context_report_ref: null }, artifacts: entry.artifacts, events: [] } })) };
}
const installed = new WeakMap<Page, State>();
async function dto<K extends keyof typeof schemas>(route: Route, name: K, value: Dto<K>) { checked(name, value); return route.fulfill({ status: 200, json: fixtureBody(route,value) }); }
const failure = (route: Route) => route.fulfill({ status: 503, json: fixtureBody(route,{ code: 'DATA_UNAVAILABLE', message: 'Synthetic read failure', retryable: true, field_errors: [], correlation_id: 'review-flow-reader' }) });
export async function install(page: Page, state = fixture()) {
  expect(installed.has(page)).toBe(false); installed.set(page, state); page.on('pageerror', error => state.errors.push(error.message));
  checked('ProjectResponse', state.project); checked('MaterialResponse', state.material);
  expect(Value.Check(ReviewDraftInputSchema, input(state.draft))).toBe(true);
  for (const entry of state.history) { checked('RunResponse', entry.run); expect(Value.Check(ReviewDraftInputSchema, entry.input)).toBe(true); }
  for (const [id, value] of state.metadata) { checked('ArtifactResponse', value); expect(value.artifact_id).toBe(id); expect(hash(state.bytes.get(id)!)).toBe(value.sha256); }
  for (const value of state.readable.values()) expect(Value.Check(ReviewReadableReportSchema, value)).toBe(true);
  await page.route('**/api/v1/**', async route => {
    if(await serveDisabledBillingCatalog(route))return;
    const request = route.request(), url = new URL(request.url()), path = url.pathname.slice('/api/v1'.length), method = request.method();
    state.calls.push({ method, path });
    if (method === 'GET') {
      if (path === '/me') return dto(route, 'MeResponse', { user_id: owner, session_status: 'active' });
      if (path === '/account') return dto(route, 'AccountResponse', { user_id: owner, username: 'reader_owner', phone_masked: null, status: 'active', created_at: now,
        accepted_terms_version: 'v1', current_terms_version: 'v1', password_updated_at: null, self_service_recovery: 'unavailable', support_contact: null });
      if (path === '/credits/balance') return dto(route, 'CreditBalanceResponse', { enabled: false, available: 0, frozen: 0 });
      if (path === '/m4/topics') return route.fulfill({ status: 200, json: fixtureBody(route,{ topics: [] }) });
      const base = '/projects/' + projectId;
      if (path === base) return dto(route, 'ProjectResponse', state.project);
      if (path === base + '/tasks') return dto(route, 'ProjectTasksResponse', taskPage(projectId, state.history.map(entry => entry.run), 'review'));
      if (path === base + '/prospectus-versions') return dto(route, 'ProspectusVersionsResponse', { project_id: projectId, current_version_id: null, selection_revision: 0, inactive_material_ids: [], versions: [] });
      if (path === base + '/review-workspace') return route.fulfill({ status: 200, json: fixtureBody(route,workspace(state)) });
      if (path === base + '/review-history') return route.fulfill({ status: 200, json: fixtureBody(route,{ items: state.history }) });
      if (path === base + '/review-draft') return route.fulfill({ status: 200, json: fixtureBody(route,{ draft: state.draft, message_drafts: [] }) });
      const readable = path.match(new RegExp('^' + base + '/review-executions/([^/]+)/readable-report$'));
      if (readable && state.readable.has(readable[1])) { state.readableReads.push(readable[1]); return state.failReadable ? failure(route) : route.fulfill({ status: 200, json: fixtureBody(route,state.readable.get(readable[1])) }); }
      const run = path.match(/^\/runs\/([^/]+)(?:\/(credit-charge|stream))?$/), entry = run && state.history.find(item => item.run.run_id === run[1]);
      if (run && entry) {
        if (run[2] === 'credit-charge') return dto(route, 'RunCreditChargeResponse', { quote: null, state: null });
        if (run[2] === 'stream') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': synthetic reader\n\n' });
        return dto(route, 'RunResponse', entry.run);
      }
      const artifact = path.match(/^\/artifacts\/([^/]+)(\/download)?$/);
      if (artifact && state.metadata.has(artifact[1])) {
        if (artifact[2]) { state.byteReads.push(artifact[1]); return route.fulfill({ status: 200, contentType: mime, body: state.bytes.get(artifact[1])! }); }
        state.metadataReads.push(artifact[1]); return dto(route, 'ArtifactResponse', state.metadata.get(artifact[1])!);
      }
    }
    state.unexpected.push(method + ' ' + path + url.search); return failure(route);
  });
  return state;
}
export async function open(page: Page, state = fixture(), version = 1) {
  await page.setViewportSize({ width: 1440, height: 1000 }); await install(page, state);
  await page.goto(`/#/projects/${projectId}/review?tab=results&run=${runId(version)}`);
  await expect(page.locator('.readable-body')).toContainText(`V${version === 4 ? 1 : version} 财务核对事项1`); return state;
}
export function assertFixture(page: Page) {
  const state = installed.get(page); if (!state) return;
  expect(state.unexpected, 'Closed public HTTP fixture must account for every request.').toEqual([]);
  expect(state.errors, 'The real browser page must not throw.').toEqual([]); expect(writes(state)).toEqual([]);
}
