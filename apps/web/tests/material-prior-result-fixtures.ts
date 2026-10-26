import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { M4_DOCUMENT_BILLING_TASKS, M4_DOCUMENT_TYPES, type M4Artifact, type M4ArtifactPin, type M4DocumentManifest, type M4DraftInput, type M4Task, type M4ViewRequest, type Run } from '@bondbuddy/contracts';
import { fixture as baseFixture, install as installBase, ids, now, mime, hash, inputOf, writes, noBusiness } from './m4-upload-thirteenth-fixtures';

export { ids, now, hash, inputOf, writes, noBusiness };
export const targetRun = 'material-prior-result-target-run';
export const artifactPin = (a: M4Artifact): M4ArtifactPin => ({ source_project_id: a.source_project_id, artifact_id: a.artifact_id, artifact_version: a.artifact_version, sha256: a.sha256 });
// The independent fixture declares the public pin wire format; it never imports the product resolver.
export const priorPin = (a: M4ArtifactPin) => JSON.stringify([a.source_project_id, a.artifact_id, a.artifact_version, a.sha256]);
export const previewContent = (a: M4Artifact) => '合成准确成果正文：' + a.filename + '；版本 V' + a.artifact_version + '；SHA-256 ' + a.sha256;
export const previewPath = (a: M4Artifact) => '/m4/artifacts/' + encodeURIComponent(a.artifact_id) + '/versions/' + a.artifact_version + '/preview';
export function artifact(id: string, overrides: Partial<M4Artifact> = {}): M4Artifact {
  return { source_project_id: ids.project, artifact_id: id, artifact_version: 2, sha256: hash('Synthetic prior artifact ' + id),
    topic_id: ids.topic, run_id: 'prior-source-' + id, document_type: 'private_summary', kind: 'document',
    filename: '合成私募摘要-' + id + '.docx', mime_type: mime, byte_size: 37, created_at: '2026-10-24T08:10:00Z',
    base_artifact: null, input_hash: hash('Synthetic complete input ' + id), revision_number: 2, ...overrides };
}
export function run(id = targetRun, state: Run['state'] = 'running'): Run {
  return { run_id: id, project_id: ids.project, execution_request_id: 'execution-' + id, input_revision: 1,
    input_hash: hash('Synthetic target input ' + id), state, stage: state === 'paused' ? 'user_paused' : 'm4_document_prompt',
    channel: 'production', test_grant_id: null, uncovered_items: [], event_cursor: 0, billing_mode: 'platform_trial',
    reservation_id: null, artifact_id: state === 'succeeded' ? 'synthetic-unavailable-output' : null,
    prompt_snapshot_ref: null, updated_at: '2026-10-25T23:59:00Z' };
}
export function documentTask(input: M4DraftInput, id = targetRun, state: Run['state'] = 'running'): M4Task & { manifest: M4DocumentManifest } {
  return { run: run(id, state), manifest: { version: 'm4-document-input-v1', kind: 'document', topic_id: ids.topic,
    execution_scope_project_id: ids.sourceProject, draft_version: 2, input: structuredClone(input), template_material: null,
    market: 'sse', offering: 'private', billing_task: M4_DOCUMENT_BILLING_TASKS[input.document_type] },
    created_at: now, events: [], artifacts: [] };
}
export function fixture(mode: 'base' | 'history' = 'base') {
  const state = baseFixture();
  state.workspace.topic.name = '合成任务此前成果核对'; state.workspace.project.name = state.workspace.topic.name;
  const base = artifact('fixed-base', { filename: '合成私募摘要·本任务固定修改底稿.docx' });
  const recent = artifact('nearest-earlier', { artifact_version: 4, revision_number: 7, created_at: '2026-10-25T10:20:00Z', filename: '合成私募摘要·提交前最近同类成果.docx' });
  const late = artifact('late-same-type', { artifact_version: 5, revision_number: 8, created_at: '2026-10-25T12:30:00Z', filename: '合成私募摘要·本任务提交后登记.docx' });
  const other = artifact('last-other-type', { document_type: 'financial', artifact_version: 3, revision_number: 3,
    created_at: '2026-10-25T11:40:00Z', filename: '合成财务说明·最后排列的另一文种.docx' });
  state.workspace.artifacts = [base, recent, late, other];
  for (const type of M4_DOCUMENT_TYPES) {
    const draft = state.workspace.drafts[type];
    draft.project_file = { project_id: ids.sourceProject, source_version_id: 'prior-original-source-version', source_selection_revision: 11, expected_file_version_id: 'prior-original-file-version' };
    draft.fields.custom_nested_semantics = '保留字段顺序、原始金额单位与' + type + '当前口径';
    state.projectFileSources.set(draft.project_file.source_version_id, structuredClone(draft.source_material!));
  }
  state.workspace.drafts.private_summary.edit_base = artifactPin(recent);
  state.workspace.drafts.private_summary.fields.issuer_name = '合成当前输入发行人·与已提交任务不同';
  const frozen = inputOf(state.workspace.drafts.private_summary);
  frozen.fields.issuer_name = '合成本任务提交时的发行人';
  frozen.edit_base = mode === 'base' ? artifactPin(base) : null;
  frozen.supplemental_requirements = '合成本任务冻结要求；当前草稿及较新成果不能改写。';
  const task = documentTask(frozen); state.workspace.tasks = [task]; state.workspace.active_run = task.run;
  return Object.assign(state, { base, recent, late, other, task });
}
export type State = ReturnType<typeof fixture>;
export const card = (page: Page) => page.locator('[data-material-prior-result]');
export const priorButton = (page: Page) => card(page).locator('[data-m4-action="prior-artifact"]');
export const baselineButton = (page: Page) => page.getByRole('button', { name: '查看此前成果', exact: true });
export const making = (page: Page, id = targetRun) => page.locator('.m4-delivery[data-run-id="' + id + '"]');
export const previewReads = (state: State) => state.calls.filter(call => call.method === 'GET' && /\/m4\/artifacts\/[^/]+\/versions\/\d+\/preview$/.test(call.path));
export async function install(page: Page, state = fixture()) {
  await installBase(page, state);
  // Override the old fixture's single-version preview with exact public ID/version reads.
  await page.route('**/api/v1/m4/artifacts/**/preview', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.slice('/api/v1'.length);
    if (request.method() !== 'GET') return route.fallback();
    state.calls.push({ method: 'GET', path, search: url.search });
    const match = path.match(/^\/m4\/artifacts\/([^/]+)\/versions\/(\d+)\/preview$/);
    const selected = match && state.workspace.artifacts.find(a => a.artifact_id === decodeURIComponent(match[1]) && a.artifact_version === Number(match[2]));
    if (!selected) return route.fulfill({ status: 404, json: { code: 'NOT_FOUND', message: 'Synthetic exact artifact unavailable', retryable: false, correlation_id: 'prior-exact-preview', field_errors: [] } });
    return route.fulfill({ json: { artifact: structuredClone(selected), content: previewContent(selected) } });
  });
  return state;
}
export async function mount(page: Page, options: { runId?: string | null; samePage?: boolean } = {}) {
  if (!options.samePage) await page.goto('/');
  await page.evaluate(async options => {
    const w = window as unknown as { m4Component?: { dispose(): void; render(): Promise<void> }; m4Owner?: string };
    w.m4Component?.dispose(); w.m4Owner = options.owner;
    const path = '/src/material-workspace.ts', apiPath = '/src/api.ts';
    const { MaterialWorkspace } = await import(path), { ApiClient } = await import(apiPath);
    const component = new MaterialWorkspace(new ApiClient(), options.owner,
      (html: string) => { document.querySelector('.shell')!.innerHTML = html; }, () => w.m4Owner === options.owner,
      options.topic, options.sourceProject, false, options.runId ?? undefined);
    w.m4Component = component; await component.render();
  }, { owner: ids.owner, topic: ids.topic, sourceProject: ids.sourceProject, runId: options.runId === undefined ? targetRun : options.runId });
  if (!options.samePage) for (const path of ['src/style.css', '../../product-prototype/public/styles.css', '../../product-prototype/public/source-prospectus.css', '../../product-prototype/public/project-workspace.css', 'src/prototype-adapter.css']) {
    await page.addStyleTag({ content: (await readFile(resolve(process.cwd(), path), 'utf8')).replace(/@import\s+[^;]+;/g, '') });
  }
}
export async function open(page: Page, state = fixture(), options: Parameters<typeof mount>[1] = {}) {
  await install(page, state); await mount(page, options); return state;
}
export function snapshot(state: State) {
  return structuredClone({ drafts: state.workspace.drafts, materials: state.workspace.materials, material_details: state.workspace.material_details,
    templates: state.workspace.templates, pending_requirements: state.workspace.pending_requirements,
    manifests: state.workspace.tasks.map(task => ({ run_id: task.run.run_id, manifest: task.manifest })) });
}
export async function observe(page: Page) {
  return page.evaluate(() => {
    const component = (window as unknown as { m4Component: { selected: string; drafts: Map<string, { version: number; input: M4DraftInput; dirty: boolean; conflict: boolean }>;
      reading: { selected: string; tabs: unknown[] }; cacheQueue?: Promise<void>; refreshing?: Promise<void>; pendingExecution?: unknown; pendingMessage?: unknown } }).m4Component;
    return { selected: component.selected, drafts: Object.fromEntries([...component.drafts].map(([type, value]) => [type, structuredClone(value)])),
      reading: structuredClone(component.reading), pendingExecution: component.pendingExecution, pendingMessage: component.pendingMessage };
  });
}
export async function settle(page: Page) {
  await page.clock.runFor(800);
  await page.evaluate(async () => { await (window as unknown as { m4Component?: { cacheQueue?: Promise<void> } }).m4Component?.cacheQueue; });
}
export async function unchanged(page: Page, state: State, before: ReturnType<typeof snapshot>) {
  expect(snapshot(state)).toEqual(before); const local = await observe(page);
  expect(Object.keys(local.drafts).sort()).toEqual([...M4_DOCUMENT_TYPES].sort());
  for (const type of M4_DOCUMENT_TYPES) expect(local.drafts[type]).toEqual({ version: before.drafts[type].version, input: inputOf(before.drafts[type]), dirty: false, conflict: false });
  expect(local.pendingExecution).toBeUndefined(); expect(local.pendingMessage).toBeUndefined();
  // Reading retains the original view auto-save. All other writes are forbidden.
  expect(writes(state).filter(call => !(call.method === 'PUT' && call.path === '/m4/topics/' + ids.topic + '/view'))).toEqual([]);
  noBusiness(state);
}
export async function expectOpened(page: Page, state: State, selected: M4Artifact) {
  await expect(page.locator('.artifact-file')).toContainText(selected.filename);
  await page.locator('[data-m4-detail="preview"] > summary').click();
  const preview = page.getByLabel(selected.filename + '正文', { exact: true });
  await expect(preview).toHaveText(previewContent(selected));
  expect(previewReads(state).map(call => call.path)).toEqual([previewPath(selected)]);
  expect((await observe(page)).reading.selected).toBe('artifact:' + selected.artifact_id + ':' + selected.artifact_version);
  await settle(page);
  const expectedPin = artifactPin(selected), expectedTab = 'artifact:' + selected.artifact_id + ':' + selected.artifact_version;
  // Advancing the existing timer and awaiting its cache prerequisite does not await its HTTP save.
  // Observe the original public view-save effect, then await only work already started by the real click.
  await expect.poll(() => ({ active_tab: state.workspace.view.active_tab, workspace_tab: state.workspace.view.workspace_tab }))
    .toEqual({ active_tab: expectedPin, workspace_tab: expectedTab });
  const settled = await page.evaluate(async () => {
    const component = (window as unknown as { m4Component: { saving?: Promise<boolean>; cacheQueue: Promise<void>; viewDirty: boolean; viewVersion: number } }).m4Component;
    await component.saving; await component.cacheQueue;
    return { viewDirty: component.viewDirty, viewVersion: component.viewVersion };
  });
  const viewCalls = writes(state).filter(call => call.method === 'PUT' && call.path === '/m4/topics/' + ids.topic + '/view');
  expect(viewCalls.length).toBeGreaterThan(0); const saved = viewCalls.at(-1)!.body as M4ViewRequest;
  expect(saved.view.active_tab).toEqual(expectedPin); expect(saved.view.workspace_tab).toBe(expectedTab); expect(saved.view.open_tabs).toContainEqual(expectedPin);
  expect(state.workspace.view.version).toBe(saved.expected_version + 1); expect(settled.viewVersion).toBe(state.workspace.view.version); expect(settled.viewDirty).toBe(false);
}
/** A real online refresh preserves the user's selected text, so an old visible card can outlive fresh records. */
export async function refreshWithSelectedText(page: Page, state: State) {
  const before = state.workspaceReads;
  await page.evaluate(() => {
    const title = document.querySelector('.m4-delivery[data-run-id] h2')!;
    const range = document.createRange(); range.selectNodeContents(title); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    window.dispatchEvent(new Event('online'));
  });
  await expect.poll(() => state.workspaceReads).toBe(before + 1);
  await page.evaluate(async () => { await (window as unknown as { m4Component?: { refreshing?: Promise<void> } }).m4Component?.refreshing; });
}
