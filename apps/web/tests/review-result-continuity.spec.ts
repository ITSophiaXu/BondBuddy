import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { isReviewReport, ReviewDraftInputSchema, ReviewEditorResponseSchema, schemas,
  type ReviewArtifact, type ReviewEditorResponse, type ReviewHistoryEntry, type ReviewReport,
  type ReviewWorkspace, type Run } from '@bondbuddy/contracts';
import type { Dto } from '../src/api';
import { taskPage } from './collection-fixtures';

// Owner-aware synthetic HTTP data exercises the real browser UI and download hash checks.
// The synthetic Word payloads are not document-generation or professional-review acceptance.
const projectId = 'synthetic-review-continuity', owner = 'continuity-owner';
const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const now = '2026-10-25T04:00:00Z';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const runId = (version: number) => `continuity-run-${version}`;
const reportId = (version: number) => `continuity-report-${version}`;
const marker = (version: number) => `合成历史 V${version} 专属正文`;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });

function fixture(mode: 'editor' | 'structured' = 'editor', includeTimeline = true) {
  const material: Dto<'MaterialResponse'> = { material_id: 'continuity-source', material_version: 1,
    upload_id: 'continuity-upload', role: 'historical', filename: '合成待复核稿.docx', media_type: mime,
    byte_size: 100, sha256: hash('synthetic source'), state: 'persisted', persisted_at: now, error: null };
  const pin = { material_id: material.material_id, material_version: 1, sha256: material.sha256 };
  const draft: ReviewWorkspace['draft'] = { version: 1, source_material_ref: pin, material_versions: [pin],
    requirements: ['合成测试：保持指定历史成果。'], as_of: null, evidence_links: [] };
  expect(Value.Check(ReviewDraftInputSchema, (({ version, ...input }) => input)(draft))).toBe(true);
  const project: ReviewWorkspace['project'] = { project_id: projectId, name: '合成历史成果接续项目',
    kind: 'review', issuer_name: '合成发行人', market: 'sse', offering: 'private', draft_revision: 1,
    input_revision: 1, input_hash: hash('input'), updated_at: now };
  const history: ReviewHistoryEntry[] = [];
  const reports = new Map<string, ReviewReport>();
  const editors = new Map<string, ReviewEditorResponse>();
  const metadata = new Map<string, Dto<'ArtifactResponse'>>();
  const bytes = new Map<string, string>();
  const state = { project, draft, material, history, reports, editors, metadata, bytes, includeTimeline,
    activeRun: null as Run | null, unexpected: [] as string[], requests: [] as string[],
    workspaceReads: [] as (string | null)[], editorReads: [] as string[], artifactReads: [] as string[],
    downloads: [] as string[], readableReads: [] as string[] };
  const makeRun = (version: number, state: Run['state'] = 'succeeded'): Run => ({ run_id: runId(version),
    execution_request_id: `continuity-request-${version}`, project_id: projectId, input_revision: 1,
    input_hash: hash('input'), channel: 'production', test_grant_id: null, uncovered_items: [], state,
    stage: state === 'running' ? 'review_model_call' : null, event_cursor: 0, billing_mode: 'platform_trial',
    reservation_id: null, artifact_id: state === 'succeeded' ? `continuity-${version}-report` : null,
    prompt_snapshot_ref: null, updated_at: `2026-10-25T0${version}:00:00Z` });
  const addArtifacts = (version: number, kinds: ReviewArtifact['kind'][]) => kinds.map(kind => {
    const artifact_id = `continuity-${version}-${kind}`, filename = `合成成果V${version}-${kind}.docx`;
    const payload = `Synthetic continuity V${version} ${kind} Word payload.`;
    bytes.set(artifact_id, payload);
    const value: Dto<'ArtifactResponse'> = { artifact_id, run_id: runId(version), version: 1, filename,
      media_type: mime, sha256: hash(payload), quality_status: 'passed', delivery_status: 'available',
      download_url: `/api/v1/artifacts/${artifact_id}/download`, expires_at: '2027-01-01T00:00:00Z' };
    expect(Value.Check(schemas.ArtifactResponse, value)).toBe(true);
    metadata.set(artifact_id, value);
    return { artifact_id, artifact_version: 1, kind, filename };
  });
  const addVersion = (version: number) => {
    const run = makeRun(version);
    expect(Value.Check(schemas.RunResponse, run)).toBe(true);
    const artifacts = addArtifacts(version, mode === 'editor' ? ['revision', 'clean', 'report'] : ['report']);
    const entry: ReviewHistoryEntry = { run, operation: 'full_review', version, source_report_id: null,
      report_id: mode === 'structured' ? reportId(version) : null,
      input: (({ version, ...input }) => input)(structuredClone(draft)), input_revision: 1,
      finding_ids: [], plan: null, artifacts, created_at: run.updated_at };
    history.unshift(entry);
    if (mode === 'editor') {
      const editor: ReviewEditorResponse = { run_id: run.run_id, sha256: hash(`editor-${version}`), snapshot: {
        version: 'review-editor-v1', source_filename: `合成成果V${version}.docx`, source_sha256: material.sha256,
        source_format: 'docx', warnings: [], paragraphs: [{ id: 'p1', text: marker(version) }], issues: [{
          id: `issue-${version}`, decision: 'original', manual_text: '', category: '合成财务核对',
          title: `V${version} 专属复核发现`, original: marker(version), replacement: `V${version} 建议正文`,
          reason: `仅属于成果 V${version} 的合成依据。`, evidence: '合成依据，不代表专业审核。', missing: '',
          uncertain: false, paragraph_id: 'p1', applied: false, limitation: '' }] } };
      expect(Value.Check(ReviewEditorResponseSchema, editor)).toBe(true);
      editors.set(run.run_id, editor);
    } else {
      const report: ReviewReport = { report_id: reportId(version), project_id: projectId, run_id: run.run_id,
        input_revision: 1, version, source_material: pin, scope: { mode: 'full_review', finding_ids: [] },
        findings: [{ finding_id: `finding-${version}`, report_id: reportId(version), dimension: 'financial',
          conclusion: 'needs_evidence', severity: 'P2', title: marker(version), description: '合成历史发现。',
          target_refs: [], evidence_refs: [], limitations: ['仅用于验证浏览器历史接续。'],
          repairability: { can_revise: false, reason: '合成夹具没有可自动修订的证据。', allowed_record_ids: [] },
          origin_report_id: reportId(version), check_status: 'rechecked' }],
        coverage: [], limitations: ['Synthetic：不代表专业复核完成。'], created_at: run.updated_at };
      expect(isReviewReport(report)).toBe(true);
      reports.set(report.report_id, report);
    }
    return entry;
  };
  const addRevision = (version: number, sourceVersion: number) => {
    const run = makeRun(version), artifacts = addArtifacts(version, ['revision', 'clean']);
    const entry: ReviewHistoryEntry = { run, operation: 'revision', version, source_report_id: reportId(sourceVersion),
      report_id: null, input: (({ version, ...input }) => input)(structuredClone(draft)), input_revision: 1,
      finding_ids: [`finding-${sourceVersion}`], plan: null, artifacts, created_at: run.updated_at };
    history.unshift(entry); return entry;
  };
  const addRunning = (version: number) => {
    const entry: ReviewHistoryEntry = { run: makeRun(version, 'running'), operation: 'full_review', version,
      source_report_id: null, report_id: null, input: (({ version, ...input }) => input)(structuredClone(draft)),
      input_revision: 1, finding_ids: [], plan: null, artifacts: [], created_at: `2026-10-25T0${version}:00:00Z` };
    history.unshift(entry); state.activeRun = entry.run; return entry;
  };
  addVersion(1); addVersion(2);
  return Object.assign(state, { addVersion, addRevision, addRunning });
}
type State = ReturnType<typeof fixture>;
const fixtures = new WeakMap<Page, State>();

async function setup(page: Page, state = fixture(), selectedRun = runId(1), tab = 'results', returnProject = projectId) {
  fixtures.set(page, state);
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.slice('/api/v1'.length);
    const method = request.method(); state.requests.push(`${method} ${path}${url.search}`);
    // This suite is read-only. Any mutation, including quote/execution/adoption, is a fixture failure.
    if (method === 'GET') {
      if (path === '/me') return json(route, { user_id: owner, session_status: 'active' });
      if (path === '/account') return json(route, { user_id: owner, username: 'continuity_user' });
      if (path === '/credits/balance') return json(route, { enabled: false, available: 0, frozen: 0 });
      if (path === `/projects/${projectId}`) return json(route, state.project);
      if (returnProject !== projectId && path === `/projects/${returnProject}`) return json(route, {
        ...state.project, project_id: returnProject, name: '合成原项目文件夹' });
      if (path === `/projects/${projectId}/tasks`) return json(route, taskPage(projectId, state.history.map(h => h.run), 'review'));
      if (path === `/projects/${projectId}/prospectus-versions`) return json(route, {
        project_id: projectId, current_version_id: null, selection_revision: 0, inactive_material_ids: [], versions: [] });
      if (path === `/projects/${projectId}/review-history`) return json(route, { items: state.history });
      if (path === `/projects/${projectId}/review-workspace`) {
        const requested = url.searchParams.get('report_id'); state.workspaceReads.push(requested);
        const completed = state.history.filter(h => ['succeeded', 'test_completed'].includes(h.run.state))
          .sort((a, b) => b.version - a.version);
        const requestedReport = requested ? state.reports.get(requested) : undefined;
        if (requested && !requestedReport) return json(route, { code: 'NOT_FOUND' }, 404);
        // Mirrors the API: report_id also chooses the original report run's artifacts. A historical
        // revision must project its own artifacts again after reading this source report.
        const result = requestedReport ? completed.find(h => h.run.run_id === requestedReport.run_id) : completed[0];
        const selected = requestedReport ?? (result ? state.reports.get(result.report_id ?? result.source_report_id ?? '') : undefined);
        const timeline: ReviewWorkspace['timeline'] = state.history.map(h => ({ kind: 'task',
          entry_id: `task:${h.run.run_id}`, created_at: h.created_at, task: { run: h.run, operation: h.operation,
            version: h.version, input_version: h.input_revision, input_revision: h.input_revision,
            input_sha256: h.run.input_hash, source_report_id: h.source_report_id, report_id: h.report_id,
            finding_ids: h.finding_ids, origin: { version: 'review-execution-origin-v1', entrypoint: 'quick_action',
              accepted_proposal: null, context_report_ref: null }, artifacts: h.artifacts, events: [] } }));
        const workspace: ReviewWorkspace = { project: state.project, materials: [state.material], draft: state.draft,
          message_drafts: [], active_run: state.activeRun, selected_report: selected ?? null,
          reports: [...state.reports.values()].map(r => ({ report_id: r.report_id, version: r.version,
            run_id: r.run_id, created_at: r.created_at })), messages: [], plan: null,
          artifacts: result?.artifacts ?? [], artifact_run: result ? { run_id: result.run.run_id, version: result.version,
            operation: result.operation, source_report_id: result.source_report_id } : null,
          ...(state.includeTimeline ? { timeline } : {}) };
        return json(route, workspace);
      }
      const editor = path.match(new RegExp(`^/projects/${projectId}/review-executions/([^/]+)/editor$`));
      if (editor) { state.editorReads.push(editor[1]); return json(route,
        state.editors.get(editor[1]) ?? { code: 'NOT_FOUND' }, state.editors.has(editor[1]) ? 200 : 404); }
      const readable = path.match(new RegExp(`^/projects/${projectId}/review-executions/([^/]+)/readable-report$`));
      if (readable) {
        state.readableReads.push(readable[1]); const entry = state.history.find(h => h.run.run_id === readable[1]);
        if (!entry) return json(route, { code: 'NOT_FOUND' }, 404);
        const markdown = `# 合成 V${entry.version} 复核报告\n\n## 财务核对\n${marker(entry.version)}`;
        return json(route, { version: 'review-readable-v1', project_id: projectId, run_id: entry.run.run_id,
          execution_version: entry.version, status: 'available', markdown, content_sha256: hash(markdown) });
      }
      const run = path.match(/^\/runs\/([^/]+)(?:\/(credit-charge|stream))?$/);
      if (run && state.history.some(h => h.run.run_id === run[1])) {
        if (run[2] === 'credit-charge') return json(route, { quote: null, state: null });
        if (run[2] === 'stream') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': synthetic continuity stream\n\n' });
        return json(route, state.history.find(h => h.run.run_id === run[1])!.run);
      }
      const artifact = path.match(/^\/artifacts\/([^/]+)(\/download)?$/);
      if (artifact && state.metadata.has(artifact[1])) {
        if (artifact[2]) { state.downloads.push(artifact[1]); return route.fulfill({ status: 200, contentType: mime, body: state.bytes.get(artifact[1])! }); }
        state.artifactReads.push(artifact[1]); return json(route, state.metadata.get(artifact[1]));
      }
    }
    state.unexpected.push(`${method} ${path}${url.search}`);
    return json(route, { code: 'UNEXPECTED_SYNTHETIC_REQUEST' }, 500);
  });
  await page.goto(`/#/projects/${projectId}/review?tab=${tab}&run=${selectedRun}&return_project=${returnProject}`);
  return state;
}

test.afterEach(async ({ page }) => {
  const state = fixtures.get(page); if (state) expect(state.unexpected, 'Every API request must be explicitly handled by this read-only fixture.').toEqual([]);
});

async function expectRunInUrl(page: Page, selectedRun: string, tab = 'results', returnProject = projectId) {
  await expect.poll(() => page.evaluate(() => {
    const query = new URLSearchParams(location.hash.split('?')[1]);
    return { run: query.get('run'), tab: query.get('tab'), original: query.get('return_project') };
  })).toEqual({ run: selectedRun, tab, original: returnProject });
}
async function expectEditor(page: Page, version: number) {
  const host = page.locator('#review-results-panel');
  await expect(host.locator('[data-editor-history]')).toHaveValue(runId(version));
  await expect(host.locator('[data-editor-document]')).toContainText(marker(version));
  for (const other of [1, 2, 3].filter(v => v !== version)) await expect(host.locator('[data-editor-document]')).not.toContainText(marker(other));
  return host;
}
async function download(page: Page, button: Locator, filename: string, payload: string) {
  const completed = page.waitForEvent('download'); await button.click(); const file = await completed;
  expect(file.suggestedFilename()).toBe(filename);
  expect(await readFile((await file.path())!, 'utf8')).toBe(payload);
}
async function refreshFromServer(page: Page, state: State) {
  const before = state.workspaceReads.length;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => state.workspaceReads.length).toBeGreaterThan(before);
}
async function evidence(page: Page, name: string) {
  const output = process.env.BB_UX_EVIDENCE_DIR; if (!output) return;
  await mkdir(output, { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 960 : 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: join(output, `review-continuity-${name}-${width}.png`), fullPage: true });
  }
}

test('specified file edition V1 survives reload, tab changes and a newly completed V3; Word stays V1', async ({ page }) => {
  const state = await setup(page);
  const results = await expectEditor(page, 1); await expectRunInUrl(page, runId(1));
  await download(page, results.getByRole('button', { name: '下载清洁版', exact: true }),
    '合成成果V1-clean.docx', state.bytes.get('continuity-1-clean')!);
  expect(state.artifactReads).toEqual(['continuity-1-clean']); expect(state.downloads).toEqual(['continuity-1-clean']);
  await page.reload(); await expectEditor(page, 1);
  await page.getByRole('tab', { name: '材料与要求', exact: true }).click(); await expectRunInUrl(page, runId(1), 'materials');
  await page.getByRole('tab', { name: '复核结果', exact: true }).click(); await expectEditor(page, 1);
  state.addVersion(3); await refreshFromServer(page, state); await expectEditor(page, 1); await expectRunInUrl(page, runId(1));
  expect(state.editorReads.length).toBeGreaterThan(0); expect(new Set(state.editorReads)).toEqual(new Set([runId(1)]));
  await evidence(page, 'v1');
});

test('choosing V2 from editor history updates the URL and reloads the same editor and Word', async ({ page }) => {
  const state = await setup(page); await expectEditor(page, 1);
  await page.locator('[data-editor-history]').selectOption(runId(2)); await expectEditor(page, 2); await expectRunInUrl(page, runId(2));
  await page.reload(); const results = await expectEditor(page, 2); await expectRunInUrl(page, runId(2));
  await download(page, results.getByRole('button', { name: '下载修订版', exact: true }),
    '合成成果V2-revision.docx', state.bytes.get('continuity-2-revision')!);
  expect(state.artifactReads).toEqual(['continuity-2-revision']); expect(state.downloads).toEqual(['continuity-2-revision']);
});

test('blocked navigation after choosing V2 keeps the V2 URL and unsaved manual edits when storage writes fail', async ({ page }) => {
  const state = await setup(page); await expectEditor(page, 1);
  await page.locator('[data-editor-history]').selectOption(runId(2));
  const results = await expectEditor(page, 2); await expectRunInUrl(page, runId(2));
  // Only the browser storage API fails; dirty state and navigation use the real UI handlers.
  await page.evaluate(() => Object.defineProperty(Storage.prototype, 'setItem', {
    configurable: true, value() { throw new DOMException('Synthetic storage quota exhausted', 'QuotaExceededError'); }
  }));
  await results.getByRole('radio', { name: '手动修改', exact: true }).check();
  const manual = results.getByLabel('替换原文的内容', { exact: true });
  const edited = '合成 V2 人工修改：导航被拦截后仍保留。';
  await manual.fill(edited);
  await expect(results.locator('[data-editor-status]')).toContainText('浏览器未能保存并校验恢复记录');
  await expect(manual).toHaveValue(edited);
  const workspacesBefore = state.workspaceReads.length;
  await page.getByRole('link', { name: '返回本项目文件', exact: true }).click();
  await expect(results.locator('[data-editor-status]')).toContainText('恢复浏览器存储后再离开');
  await expectRunInUrl(page, runId(2));
  await expect(page.locator('[data-editor-history]')).toHaveValue(runId(2));
  await expect(manual).toHaveValue(edited);
  await expect(results.getByRole('radio', { name: '手动修改', exact: true })).toBeChecked();
  expect(state.workspaceReads).toHaveLength(workspacesBefore);
  expect(state.requests.some(request => request.includes('/project-files/workspace'))).toBe(false);
  expect(new Set(state.editorReads)).toEqual(new Set([runId(1), runId(2)]));
});

test('a new V3 stays separate from V1 until the explicit latest-result link is followed', async ({ page }) => {
  const state = fixture(), returnProject = 'continuity-original-project';
  await setup(page, state, runId(1), 'results', returnProject);
  await expectEditor(page, 1); await expectRunInUrl(page, runId(1), 'results', returnProject);
  state.addVersion(3); await refreshFromServer(page, state);
  const latest = page.locator('#review-results-panel a[data-review-latest-result]');
  await expect(latest).toHaveText('查看最新成果 V3');
  await expectEditor(page, 1); await expectRunInUrl(page, runId(1), 'results', returnProject);
  expect(new Set(state.editorReads)).toEqual(new Set([runId(1)]));
  const href = (await latest.getAttribute('href'))!;
  expect(href.split('?')[0]).toBe(`#/projects/${projectId}/review`);
  const query = new URLSearchParams(href.split('?')[1]);
  expect({ run: query.get('run'), tab: query.get('tab'), original: query.get('return_project') })
    .toEqual({ run: runId(3), tab: 'results', original: returnProject });
  await latest.click(); const results = await expectEditor(page, 3);
  await expectRunInUrl(page, runId(3), 'results', returnProject);
  await expect(latest).toHaveCount(0);
  await download(page, results.getByRole('button', { name: '下载清洁版', exact: true }),
    '合成成果V3-clean.docx', state.bytes.get('continuity-3-clean')!);
  await page.reload(); await expectEditor(page, 3); await expectRunInUrl(page, runId(3), 'results', returnProject);
  expect(state.artifactReads).toEqual(['continuity-3-clean']); expect(state.downloads).toEqual(['continuity-3-clean']);
});

test('unknown specified run clearly reports missing result without substituting the latest V2', async ({ page }) => {
  const state = await setup(page, fixture(), 'missing-continuity-run');
  await expect(page.locator('[data-review-result-unavailable]')).toBeVisible();
  await expect(page.locator('[data-review-result-unavailable]')).toContainText('指定的复核成果不存在或暂不可用');
  await expect(page.locator('#review-results-panel [data-review-editor],#review-results-panel [data-review-action="download"]')).toHaveCount(0);
  expect(state.editorReads).toEqual([]); expect(state.artifactReads).toEqual([]); expect(state.downloads).toEqual([]);
  await page.reload(); await expect(page.locator('[data-review-result-unavailable]')).toBeVisible();
  await expectRunInUrl(page, 'missing-continuity-run');
});

test('structured V1 report is resolved through its historical run and keeps its own Word after refresh', async ({ page }) => {
  const state = await setup(page, fixture('structured'));
  const results = page.locator('#review-results-panel');
  await expect(results.locator('[data-finding-id="finding-1"]')).toContainText(marker(1));
  await expect(results.locator('[data-finding-id="finding-2"]')).toHaveCount(0);
  expect(state.workspaceReads).toContain(reportId(1));
  const button = results.locator('[data-review-action="download"][data-artifact-id="continuity-1-report"]');
  await download(page, button, '合成成果V1-report.docx', state.bytes.get('continuity-1-report')!);
  state.addVersion(3); await refreshFromServer(page, state);
  await page.getByRole('tab', { name: '材料与要求', exact: true }).click();
  await page.getByRole('tab', { name: '复核结果', exact: true }).click();
  await page.reload(); await expect(results.locator('[data-finding-id="finding-1"]')).toBeVisible();
  await expect(results.locator('[data-finding-id="finding-2"],[data-finding-id="finding-3"]')).toHaveCount(0);
  await expectRunInUrl(page, runId(1)); expect(state.downloads).toEqual(['continuity-1-report']); expect(state.editorReads).toEqual([]);
});

test('structured revision keeps its source report while downloads belong to the selected revision run', async ({ page }) => {
  const state = fixture('structured'); state.addRevision(4, 1); state.addVersion(5);
  await setup(page, state, runId(4)); const results = page.locator('#review-results-panel');
  await expect(results.locator('[data-finding-id="finding-1"]')).toBeVisible();
  await expect(results.locator('[data-finding-id="finding-2"],[data-finding-id="finding-5"]')).toHaveCount(0);
  expect(state.workspaceReads).toContain(reportId(1));
  const button = results.locator('[data-review-action="download"][data-artifact-id="continuity-4-clean"]');
  await download(page, button, '合成成果V4-clean.docx', state.bytes.get('continuity-4-clean')!);
  await page.reload(); await expect(button).toBeVisible(); await expectRunInUrl(page, runId(4));
  expect(state.downloads).toEqual(['continuity-4-clean']); expect(state.artifactReads).toEqual(['continuity-4-clean']);
});

test('without timeline the exact old edition is recovered from owned history rather than the latest result', async ({ page }) => {
  const state = await setup(page, fixture('editor', false)); await expectEditor(page, 1);
  await page.reload(); await expectEditor(page, 1); await expectRunInUrl(page, runId(1));
  expect(state.requests).toContain(`GET /projects/${projectId}/review-history`);
  expect(new Set(state.editorReads)).toEqual(new Set([runId(1)]));
});

test('a temporarily absent historical task preserves its frozen export recovery instead of destroying the editor', async ({ page }) => {
  const state=fixture(),editor=state.editors.get(runId(1))!,decisions=editor.snapshot.issues.map(({id,decision,manual_text})=>({id,decision,manual_text}));
  const pending={request_id:'continuity-unconfirmed-export',source_run_id:runId(1),expected_editor_sha256:editor.sha256,decisions};
  await page.addInitScript(({owner,project,run,sha256,decisions,pending})=>localStorage.setItem(`bb-review-editor:${owner}:${project}:${run}`,JSON.stringify({sha256,decisions,pending})),{owner,project:projectId,run:runId(1),sha256:editor.sha256,decisions,pending});
  await setup(page,state);await expectEditor(page,1);await expect(page.locator('[data-editor-save]')).toHaveText('重试确认新版导出');
  state.history.splice(state.history.findIndex(item=>item.run.run_id===runId(1)),1);await refreshFromServer(page,state);
  await expect(page.locator('[data-review-preserved-recovery]')).toContainText('原处理选择和导出回执已保留');
  await expectEditor(page,1);await expect(page.locator('[data-editor-save]')).toBeEnabled();
  await expect(page.getByRole('radio',{name:'手动修改',exact:true})).toBeDisabled();
  expect(state.requests.every(request=>request.startsWith('GET '))).toBe(true);
  const raw=await page.evaluate(({owner,project,run})=>localStorage.getItem(`bb-review-editor:${owner}:${project}:${run}`),{owner,project:projectId,run:runId(1)});
  expect(JSON.parse(raw!).pending).toEqual(pending);
});

test('a historical run belonging to another project cannot reveal an editor or the latest owned result', async ({ page }) => {
  const state = fixture('editor', false);
  state.history.find(h => h.run.run_id === runId(1))!.run.project_id = 'another-project';
  await setup(page, state);
  await expect(page.locator('[data-review-result-unavailable],#review-workspace [role="alert"]').first()).toBeVisible();
  await expect(page.locator('#review-results-panel [data-review-editor]')).toHaveCount(0);
  await expect(page.locator('#review-workspace')).not.toContainText(marker(2));
  expect(state.editorReads).toEqual([]); expect(state.artifactReads).toEqual([]); expect(state.downloads).toEqual([]);
});

for (const mismatch of ['run', 'project'] as const) test(`structured historical report rejects a mismatched ${mismatch} instead of displaying V2`, async ({ page }) => {
  const state = fixture('structured');
  const report = state.reports.get(reportId(1))!;
  if (mismatch === 'run') report.run_id = runId(2);
  else report.project_id = 'another-project';
  expect(isReviewReport(report)).toBe(true); // Valid shape alone does not prove the requested identity.
  await setup(page, state);
  await expect(page.locator('[data-review-result-unavailable],#review-workspace [role="alert"]').first()).toBeVisible();
  await expect(page.locator('#review-results-panel [data-finding-id]')).toHaveCount(0);
  await expect(page.locator('#review-results-panel [data-review-action="download"]')).toHaveCount(0);
  expect(state.editorReads).toEqual([]); expect(state.artifactReads).toEqual([]); expect(state.downloads).toEqual([]);
});

test('an editor response for a different run is rejected before its document or controls are rendered', async ({ page }) => {
  const state = fixture(); state.editors.set(runId(1), structuredClone(state.editors.get(runId(2))!));
  await setup(page, state);
  await expect(page.locator('#review-results-panel [role="alert"]')).toContainText('复核编辑器版本与所选任务不一致');
  await expect(page.locator('#review-results-panel [data-editor-document],#review-results-panel [data-editor-download]')).toHaveCount(0);
  await expect(page.locator('#review-results-panel')).not.toContainText(marker(2));
  expect(state.editorReads).toEqual([runId(1)]); expect(state.downloads).toEqual([]);
});

for (const mismatch of ['run', 'artifact', 'version'] as const) test(`Word metadata with a different ${mismatch} cannot download bytes for the selected edition`, async ({ page }) => {
  const state = await setup(page); const results = await expectEditor(page, 1);
  const metadata = state.metadata.get('continuity-1-clean')!;
  if (mismatch === 'run') metadata.run_id = runId(2);
  else if (mismatch === 'artifact') metadata.artifact_id = 'continuity-2-clean';
  else metadata.version = 2;
  const downloaded: string[] = []; page.on('download', file => downloaded.push(file.suggestedFilename()));
  await results.getByRole('button', { name: '下载清洁版', exact: true }).click();
  await expect(results.locator('[data-editor-status]')).toContainText('下载文件与当前复核版本不一致');
  expect(state.artifactReads).toEqual(['continuity-1-clean']); expect(state.downloads).toEqual([]); expect(downloaded).toEqual([]);
  await expectEditor(page, 1); await expectRunInUrl(page, runId(1));
});

test('a specified running task in making stays a progress page and is not treated as a missing completed result', async ({ page }) => {
  const state = fixture(); state.addRunning(3);
  await setup(page, state, runId(3), 'making');
  const progress = page.locator('#review-making-panel');
  await expect(progress.locator('.review-live-workspace')).toBeVisible();
  await expect(progress.getByRole('heading', { name: '复核进度', exact: true })).toBeVisible();
  await expect(progress.locator('.review-live-heading .review-tag')).toHaveText('第 3 轮');
  await expect(page.locator('[data-review-result-unavailable]')).toHaveCount(0);
  await expectRunInUrl(page, runId(3), 'making');
  await page.reload(); await expect(progress.locator('.review-live-workspace')).toBeVisible();
  await expect(progress.locator('.review-live-heading .review-tag')).toHaveText('第 3 轮');
  expect(state.editorReads).not.toContain(runId(3)); expect(state.artifactReads).toEqual([]); expect(state.downloads).toEqual([]);
});

test('a new active task keeps the selected old Word while progress and reload retain their separate task', async ({page})=>{
  const state=await setup(page);await expectEditor(page,1);state.addRunning(3);await refreshFromServer(page,state);await expectEditor(page,1);
  await page.locator('[data-review-tab=making]').click();
  await expect(page.locator('#review-making-panel .review-live-heading .review-tag')).toHaveText('第 3 轮');
  await expectRunInUrl(page,runId(3),'making');
  expect(await page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('result_run'))).toBe(runId(1));
  await page.reload();await expect(page.locator('#review-making-panel .review-live-heading .review-tag')).toHaveText('第 3 轮');
  await page.getByRole('tab',{name:'复核结果',exact:true}).click();const results=await expectEditor(page,1);await expectRunInUrl(page,runId(1));
  await download(page,results.getByRole('button',{name:'下载清洁版',exact:true}),'合成成果V1-clean.docx',state.bytes.get('continuity-1-clean')!);
  expect(state.downloads).toEqual(['continuity-1-clean']);
});
