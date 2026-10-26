import { expect, type Page } from '@playwright/test';
import { M4_DOCUMENT_TYPES, type M4Artifact, type M4DraftInput, type M4DraftRequest, type M4ExecuteRequest } from '@bondbuddy/contracts';
import {
  fixture as uploadFixture, install as installUpload, mount as mountUpload, addMaterial, materialOf, pinKey,
  ids, now, hash, inputOf, requirement, draftWrites, writes, noBusiness, legacyCache,
  type State as UploadState,
} from './m4-upload-thirteenth-fixtures';

export { ids, hash, inputOf, pinKey, requirement, draftWrites, writes, noBusiness, legacyCache };
export { file, uploads, records, recovery, choose } from './m4-upload-thirteenth-fixtures';

// Synthetic browser/API boundary only. The real component, cache restore, buttons,
// CAS requests and existing upload recovery are exercised; no model or charge is run.
export const longRequirement = '第一行：金额以万元列示，保留“合并口径”。\n<img src=x onerror="window.comparisonInjected=true"> & <script>window.comparisonInjected=true</script>\n'
  + Array.from({ length: 46 }, (_, i) => `第${i + 1}项：逐项保留原始证据、页码、消息来源及完整财务期间；不得把待核事项写成已确认。`).join('\n')
  + '\n结尾：LONG_REQUIREMENT_END_' + '完整长行'.repeat(85);

export function fixture() {
  const state = uploadFixture();
  state.workspace.topic.name = '合成材料与要求冲突比较';
  state.workspace.project.name = state.workspace.topic.name;
  const localInput = inputOf(state.workspace.drafts.private_summary);
  const originalSource = state.materials.get(pinKey(localInput.source_material!))!;
  const originalSupport = state.materials.get(pinKey(localInput.materials[0]))!;
  originalSource.filename = '同名募集书.docx · 合成发行人公开发行公司债券募集说明书及财务期间修订对照完整长文件名';
  originalSupport.filename = '同名财务资料.pdf · 合成集团合并口径九月末财务报表及附注完整长文件名';
  const nextSource = { ...originalSource, material_version: 2, sha256: hash('Synthetic new prospectus'), byte_size: Buffer.byteLength('Synthetic new prospectus'), upload_id: 'comparison-source-2' };
  const nextSupport = { ...originalSupport, material_version: 2, sha256: hash('Synthetic new financial note'), byte_size: Buffer.byteLength('Synthetic new financial note'), upload_id: 'comparison-support-2' };
  const serverSource = addMaterial(state, nextSource, ids.sourceProject, true), serverSupport = addMaterial(state, nextSupport, ids.project, true);
  for (const detail of state.workspace.material_details) {
    if (detail.material_id === originalSource.material_id) detail.filename = originalSource.filename;
    if (detail.material_id === originalSupport.material_id) detail.filename = originalSupport.filename;
  }
  state.materialBytes.set(pinKey(serverSource), Buffer.from('Synthetic new prospectus'));
  state.materialBytes.set(pinKey(serverSupport), Buffer.from('Synthetic new financial note'));
  const extra = materialOf({ name: '仅本页采用的决议.pdf', mimeType: 'application/pdf', buffer: Buffer.from('Synthetic local decision') }, 'comparison-local-extra');
  const localExtra = addMaterial(state, extra, ids.project, true);
  const oldTemplate = state.workspace.templates[0]; oldTemplate.name = '同名私有模板.docx · 合成券商公司债券募集说明书摘要完整版式及章节要求';
  const nextTemplate = { ...oldTemplate, template_version: 3, sha256: hash('Synthetic new template'), material: serverSupport };
  state.workspace.templates.push(nextTemplate);
  const oldArtifact = state.workspace.artifacts[0]; oldArtifact.filename = '同名摘要成果.docx · 合成发行人本期债券摘要和披露口径完整长文件名';
  const nextArtifact: M4Artifact = { ...oldArtifact, artifact_version: 3, sha256: hash('Synthetic new edit base'), revision_number: 3, run_id: 'comparison-server-run' };
  state.workspace.artifacts.push(nextArtifact);
  localInput.project_file = { project_id: ids.sourceProject, source_version_id: 'comparison-source-version-local', source_selection_revision: 7, expected_file_version_id: 'comparison-file-version-local' };
  localInput.materials.push(localExtra);
  localInput.fields = { ...localInput.fields, custom_complete_field: '本页任意业务字段 <保留> & "引号"\n第二行', only_local_field: '仅本页字段', explicit_empty: '', same_business_field: '两份相同内容', constructor: '任意业务字段 constructor 的原始内容' };
  localInput.requirements = [requirement('comparison-local-long', longRequirement), requirement('comparison-local-second', '本页要求：保留债券期限和财务单位。')];
  localInput.supplemental_requirements = '本页补充：不合并来源不明的数字。\n第二行仍须保留。';
  const serverInput: M4DraftInput = { ...structuredClone(localInput), source_material: serverSource, materials: [serverSupport],
    template: { template_id: nextTemplate.template_id, template_version: nextTemplate.template_version, sha256: nextTemplate.sha256 },
    edit_base: { source_project_id: nextArtifact.source_project_id, artifact_id: nextArtifact.artifact_id, artifact_version: nextArtifact.artifact_version, sha256: nextArtifact.sha256 },
    project_file: { project_id: ids.sourceProject, source_version_id: 'comparison-source-version-server', source_selection_revision: 9, expected_file_version_id: null },
    fields: { ...localInput.fields, custom_complete_field: '服务器已保存的任意业务字段', only_server_field: '仅服务器字段' },
    requirements: [requirement('comparison-server-same-text-new-provenance', longRequirement), requirement('comparison-server-second', '服务器要求：本次采用九月末财务口径。')],
    supplemental_requirements: '服务器补充：采用最新授信资料。' };
  const { only_local_field: _onlyLocal, explicit_empty: _empty, constructor: _constructor, ...serverFields } = serverInput.fields;
  serverInput.fields = serverFields;
  state.projectFileSources.set(localInput.project_file.source_version_id, localInput.source_material!);
  state.projectFileSources.set(serverInput.project_file!.source_version_id, serverInput.source_material!);
  for (const value of [...localInput.requirements, ...serverInput.requirements]) state.workspace.messages.push({ message_id: value.message_id, role: 'assistant', content: value.text, version: value.message_version,
    context: { document_type: null, draft_version: 0, source_material: null, citations: [], reading_artifact: null }, created_at: now, reply_status: 'completed', reply_to: null, run_id: null,
    reply: { content: value.text, citations: [], requirements: [value.text], fields: {}, intent: 'draft', document_type: null, target_business: null, retrieval: 'not_performed' }, error: null });
  state.workspace.drafts.private_summary = { ...structuredClone(localInput), version: 3, sha256: hash(JSON.stringify(localInput)), updated_at: now };
  return Object.assign(state, { localInput, serverInput });
}
export type State = ReturnType<typeof fixture>;

export function setServer(state: State, input: M4DraftInput = state.serverInput, version = 4) {
  state.workspace.drafts.private_summary = { ...structuredClone(input), version, sha256: hash(JSON.stringify(input)), updated_at: now };
  if (input.project_file && input.source_material) state.projectFileSources.set(input.project_file.source_version_id, input.source_material);
}
const observations = new WeakMap<Page, State>();
export async function install(page: Page, state = fixture()) { await installUpload(page, state); observations.set(page, state); return state; }
export const observedState = (page: Page) => observations.get(page);
export const mount = (page: Page, options: Parameters<typeof mountUpload>[1] = {}) => mountUpload(page, options);

export function cacheValue(state: State, input = state.localInput, version = 3) {
  const drafts = Object.fromEntries(M4_DOCUMENT_TYPES.map(type => [type, { version: state.workspace.drafts[type].version, input: inputOf(state.workspace.drafts[type]), dirty: false, conflict: false }]));
  drafts.private_summary = { version, input: structuredClone(input), dirty: true, conflict: true };
  const { version: viewVersion, ...view } = structuredClone(state.workspace.view);
  view.selected_document_type = 'private_summary'; view.workspace_tab = 'input';
  return { owner: ids.owner, topic: ids.topic, drafts, view, viewVersion, viewDirty: false };
}
export async function seedCache(page: Page, state: State, input = state.localInput, version = 3, extra: Record<string, unknown> = {}) {
  await page.goto('/');
  await page.evaluate(({ key, value }) => { localStorage.setItem(key, JSON.stringify(value)); }, { key: `bb-m4:${ids.owner}:${ids.topic}`, value: { ...cacheValue(state, input, version), ...extra } });
}
export async function restore(page: Page, state: State, input = state.localInput, version = 3, extra: Record<string, unknown> = {}) {
  await seedCache(page, state, input, version, extra); await mount(page, { navigation: 'same-page' });
  await expect(page.locator('#m4-requirements')).toHaveValue(input.supplemental_requirements ?? '');
  await expect(page.locator('[data-m4-action="resolve-draft"]')).toBeVisible();
}

export const dialog = (page: Page) => page.locator('dialog[data-material-draft-comparison][open]');
export const action = (page: Page, value: 'keep' | 'server' | 'reload' | 'close') => dialog(page).locator(`[data-draft-comparison-action="${value}"]`);
export const row = (page: Page, key: string) => dialog(page).locator(`[data-draft-comparison-row=${JSON.stringify(key)}]`);
export async function openComparison(page: Page, state: UploadState, readyChoice: 'keep' | 'server' = 'keep') {
  const before = writes(state).length, reads = state.workspaceReads;
  await page.locator('[data-m4-action="resolve-draft"]').click();
  await expect(dialog(page)).toBeVisible(); await expect(action(page, readyChoice)).toBeEnabled();
  expect(state.workspaceReads).toBe(reads + 1); expect(writes(state)).toHaveLength(before); noBusiness(state);
}
export async function realConflict(page: Page, state: State, content = state.localInput.supplemental_requirements!) {
  await mount(page); let changed = false;
  state.beforeDraft = (request: M4DraftRequest) => { if (!changed && request.input.document_type === 'private_summary') { changed = true; setServer(state); } };
  await page.locator('#m4-requirements').fill(content); await page.clock.runFor(600);
  await expect.poll(() => draftWrites(state).length).toBe(1); await waitCache(page);
  // Re-enter the authoritative state through the existing public refresh button.
  // No private paint or resolution method is called to expose the conflict.
  await page.locator('[data-m4-action="refresh"]').click(); await expect(page.locator('[data-m4-action="resolve-draft"]')).toBeVisible();
  state.beforeDraft = undefined;
  expect(draftWrites(state)).toEqual([{ expected_version: 3, input: { ...state.localInput, supplemental_requirements: content } }]);
  expect(inputOf(state.workspace.drafts.private_summary)).toEqual(state.serverInput);
}
export async function waitCache(page: Page) {
  // Observation only, after a real UI operation. No private resolution/save method is invoked.
  await expect.poll(() => page.evaluate(async () => {
    const c = (window as unknown as { m4Component: { cacheQueue: Promise<void>; saving?: unknown } }).m4Component;
    const queued = c.cacheQueue; await queued; return queued === c.cacheQueue && !c.saving;
  })).toBe(true);
}
export async function holdWorkspace(state: State) {
  let release!: () => void, entered = false;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  state.workspaceGate = async () => { entered = true; await waiting; };
  return { entered: () => entered, release: () => { state.workspaceGate = undefined; release(); } };
}
export function nextWorkspaceSettled(page: Page) {
  return new Promise<void>(resolve => {
    const done = (request: import('@playwright/test').Request) => {
      if (!new URL(request.url()).pathname.endsWith(`/m4/topics/${ids.topic}/workspace`)) return;
      page.off('requestfinished', done); page.off('requestfailed', done); resolve();
    };
    page.on('requestfinished', done); page.on('requestfailed', done);
  });
}
export async function writeCache(page: Page, mutate: (cache: any) => void) {
  const cache = await legacyCache(page); expect(cache).not.toBeNull(); mutate(cache);
  const key = `bb-m4:${ids.owner}:${ids.topic}`, raw = JSON.stringify(cache);
  await page.evaluate(({ key, raw }) => { localStorage.setItem(key, raw); dispatchEvent(new StorageEvent('storage', { key, newValue: raw })); }, { key, raw });
  return { cache, raw, key };
}
export const pendingExecution = (): M4ExecuteRequest => ({ execution_request_id: 'comparison-original-pending-execution', document_type: 'legal', expected_draft_version: 3, quote_id: 'comparison-original-quote', entrypoint: 'workspace' });
export const workspaceGets = (state: UploadState) => state.calls.filter(call => call.method === 'GET' && call.path === `/m4/topics/${ids.topic}/workspace`);
