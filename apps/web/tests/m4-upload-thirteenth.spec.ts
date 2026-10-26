import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { M4DraftInput, M4ExecuteRequest } from '@bondbuddy/contracts';
import { installThirteenthReference } from './upload-thirteenth-reference';
import { install, mount, ids, file, secondFile, hash, inputOf, pin, pinKey, requirement, materialOf, addMaterial, writes, uploads, draftWrites, libraryWrites, noBusiness, recovery, records, legacyCache, choose, type State } from './m4-upload-thirteenth-fixtures';

const resume = (page: Page, filename = file.name) => recovery(page, filename).locator('[data-m4-recovery-action=resume]');
const select = (page: Page, purpose: 'source' | 'material' = 'material', selected: typeof file | typeof file[] = file) => page.locator(`[data-m4-upload=${purpose}]`).last().setInputFiles(selected);
async function pending(page: Page, state: State, purpose: 'source' | 'material' = 'material') { await select(page, purpose); await expect(resume(page)).toBeEnabled(); expect(await records(page)).toHaveLength(1); noBusiness(state); }
async function refreshReadOnly(page: Page, state: State) {
  const before = writes(state).length; await mount(page, { navigation: 'reload' });
  // Exercise the existing 550ms autosave and return-to-page hooks; every non-GET is counted, including view.
  await page.clock.runFor(1_000); await page.evaluate(() => { dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); }); await page.clock.runFor(1_000);
  expect(writes(state)).toHaveLength(before); noBusiness(state); return before;
}
async function saved(page: Page, state: State) { await expect.poll(() => uploads(state, 'create').length).toBeGreaterThan(0); await expect.poll(async () => (await records(page)).length).toBe(0); noBusiness(state); }
function expectedInput(original: M4DraftInput, state: State, purpose: 'source' | 'material', item = 0) {
  const material = [...state.uploads.values()][item].material!, selected = pin(material);
  return purpose === 'source' ? { ...original, source_material: selected } : { ...original, materials: original.materials.some(value => value.material_id === selected.material_id && value.material_version === selected.material_version) ? original.materials : [...original.materials, selected] };
}
async function gatedUpload(page: Page, state: State) { let release!: () => void; state.completeGate = () => new Promise<void>(resolve => { release = resolve; }); await select(page); await expect.poll(() => uploads(state, 'complete').length).toBe(1); return () => { state.completeGate = undefined; release(); }; }
async function cacheMutation(page: Page, mutate: (cache: any) => void) {
  const cache = await legacyCache(page); expect(cache).not.toBeNull(); mutate(cache); const raw = JSON.stringify(cache), key = `bb-m4:${ids.owner}:${ids.topic}`;
  await page.evaluate(({ key, raw }) => { localStorage.setItem(key, raw); dispatchEvent(new StorageEvent('storage', { key, newValue: raw })); }, { key, raw }); return { key, raw, cache };
}
const pendingExecution = (): M4ExecuteRequest => ({ execution_request_id: 'm4-thirteenth-separate-pending-execution', document_type: 'legal', expected_draft_version: 3, quote_id: 'm4-thirteenth-original-quote', entrypoint: 'workspace' });

for (const purpose of ['source', 'material'] as const) test(`M4 ${purpose} normal selection completes the original file, library and whole draft in one action`, async ({ page }) => {
  const state = await install(page), original = inputOf(state.workspace.drafts.private_summary), others = structuredClone(state.workspace.drafts);
  if (purpose === 'material') { original.project_file = { project_id: ids.sourceProject, source_version_id: 'original-source-version', source_selection_revision: 7, expected_file_version_id: 'original-file-version' }; state.workspace.drafts.private_summary.project_file = structuredClone(original.project_file); state.projectFileSources.set('original-source-version', original.source_material!); }
  await mount(page, { entry: purpose === 'material' ? 'generation-project' : 'topic' }); await select(page, purpose); await saved(page, state);
  const expected = expectedInput(original, state, purpose); expect(draftWrites(state)).toEqual([{ expected_version: 3, input: expected }]); expect(inputOf(state.workspace.drafts.private_summary)).toEqual(expected);
  expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1); expect(uploads(state, 'complete')).toHaveLength(1); expect(libraryWrites(state)).toHaveLength(1);
  expect(libraryWrites(state)[0].body).toEqual({ material: pin([...state.uploads.values()][0].material!) }); expect(state.workspace.drafts.private_summary.version).toBe(4);
  for (const [type, draft] of Object.entries(others)) if (type !== 'private_summary') expect(state.workspace.drafts[type as keyof typeof others]).toEqual(draft);
  expect(state.calls.filter(call => call.method !== 'GET' && call.path.includes(`/projects/${ids.sourceProject}/`))).toEqual([]); noBusiness(state);
});

test('M4 source upload also adopts an originally empty source without appending it to support materials', async ({ page }) => {
  const state = await install(page); state.workspace.drafts.private_summary.source_material = null; const original = inputOf(state.workspace.drafts.private_summary); await mount(page); await select(page, 'source'); await saved(page, state);
  expect(inputOf(state.workspace.drafts.private_summary)).toEqual(expectedInput(original, state, 'source')); expect(state.workspace.drafts.private_summary.materials).toEqual(original.materials); expect(draftWrites(state)).toHaveLength(1);
});

for (const version of [0, 3]) test(`M4 exact duplicate at base v${version} respects initial-save and no-op version rules`, async ({ page }) => {
  const state = await install(page), reused = materialOf(); state.dedupMaterial = reused; const selected = addMaterial(state, reused, ids.project, true); state.workspace.drafts.private_summary.materials.push(selected); state.workspace.drafts.private_summary.version = version;
  const original = inputOf(state.workspace.drafts.private_summary); await mount(page); await select(page); await saved(page, state);
  expect(inputOf(state.workspace.drafts.private_summary)).toEqual(original); expect(state.workspace.drafts.private_summary.version).toBe(version === 0 ? 1 : version);
  if (version === 0) expect(draftWrites(state)).toEqual([{ expected_version: 0, input: original }]); else expect(draftWrites(state).length).toBeLessThanOrEqual(1);
  expect(libraryWrites(state)).toHaveLength(0); expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1); await page.clock.runFor(1_000); noBusiness(state);
});

for (const purpose of ['source', 'material'] as const) for (const width of [1440, 390]) test(`M4 ${purpose} refresh is read-only and explicit recovery retains the original target at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 960 }); const state = await install(page), original = inputOf(state.workspace.drafts.private_summary); state.dropPut = 'after'; await mount(page); await pending(page, state, purpose);
  const uploadId = [...state.uploads.keys()][0]; expect(libraryWrites(state)).toHaveLength(0); expect(draftWrites(state)).toHaveLength(0); await refreshReadOnly(page, state);
  await choose(page, 'legal'); const before = writes(state).length; await page.clock.runFor(1_000); expect(writes(state)).toHaveLength(before); await expect(recovery(page)).toContainText('募集说明书摘要');
  const target = recovery(page).locator('[data-m4-recovery-target]'); await target.click(); await expect(page.locator('[data-m4-type]:checked')).toHaveValue('private_summary'); await expect(resume(page)).toBeFocused(); await expect(recovery(page)).toBeInViewport(); expect(writes(state)).toHaveLength(before);
  await resume(page).click(); await saved(page, state); expect(inputOf(state.workspace.drafts.private_summary)).toEqual(expectedInput(original, state, purpose)); expect(state.workspace.drafts.legal.version).toBe(3);
  expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1); expect(uploads(state, 'complete').every(call => call.path.includes('/' + uploadId + '/complete'))).toBe(true); expect(draftWrites(state)).toHaveLength(1); noBusiness(state);
});

test('M4 lost library acknowledgement is confirmed by the exact member and never repeats the event-producing POST', async ({ page }) => {
  const state = await install(page); state.dropLibrary = 'after'; state.libraryGate = async () => { state.failWorkspaceReads = true; }; await mount(page); await pending(page, state); expect(libraryWrites(state)).toHaveLength(1); expect(draftWrites(state)).toHaveLength(0);
  state.failWorkspaceReads = false; state.libraryGate = undefined; await refreshReadOnly(page, state); await resume(page).click(); await saved(page, state); expect(libraryWrites(state)).toHaveLength(1); expect(draftWrites(state)).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1);
});

test('M4 library absence retains the original registration and only an explicit action can resend it', async ({ page }) => {
  const state = await install(page); state.dropLibrary = 'before'; await mount(page); await pending(page, state); expect(libraryWrites(state)).toHaveLength(1); const request = structuredClone(libraryWrites(state)[0]);
  await refreshReadOnly(page, state); expect(libraryWrites(state)).toHaveLength(1); await resume(page).click(); await saved(page, state); expect(libraryWrites(state)).toEqual([request, request]); expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1);
});

test('M4 a near library member with a different project, version or hash cannot confirm the original pin', async ({ page }) => {
  const state = await install(page); state.dropLibrary = 'before'; await mount(page); await pending(page, state); const material = [...state.uploads.values()][0].material!, exact = pin(material);
  state.workspace.materials.push({ ...exact, source_project_id: ids.sourceProject }, { ...exact, material_version: 2 }, { ...exact, sha256: hash('different bytes') });
  await refreshReadOnly(page, state); expect(draftWrites(state)).toHaveLength(0); await resume(page).click(); await saved(page, state); expect(libraryWrites(state)).toHaveLength(2); expect(libraryWrites(state)[1].body).toEqual({ material: exact });
});

test('M4 lost draft acknowledgement uses exact v+1 and all public input fields without another PUT', async ({ page }) => {
  const state = await install(page); state.dropDraft = 'after'; state.afterDraft = () => { state.failWorkspaceReads = true; }; await mount(page); await pending(page, state); const request = structuredClone(draftWrites(state)[0]);
  expect(state.workspace.drafts.private_summary.version).toBe(4); state.failWorkspaceReads = false; await refreshReadOnly(page, state); await saved(page, state);
  expect(draftWrites(state)).toEqual([request]); expect(inputOf(state.workspace.drafts.private_summary)).toEqual(request.input); expect(libraryWrites(state)).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1);
});

test('M4 unchanged full baseline permits only an explicit identical sealed-CAS retry', async ({ page }) => {
  const state = await install(page); state.dropDraft = 'before'; await mount(page); await pending(page, state); const request = structuredClone(draftWrites(state)[0]); await refreshReadOnly(page, state);
  expect(draftWrites(state)).toEqual([request]); await resume(page).click(); await saved(page, state); expect(draftWrites(state)).toEqual([request, request]); expect(libraryWrites(state)).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1);
});

for (const change of ['higher-same-input', 'next-different-field'] as const) test(`M4 ${change} cannot falsely confirm or rebase the sealed draft`, async ({ page }) => {
  const state = await install(page); state.dropDraft = 'after'; state.afterDraft = request => { if (change === 'higher-same-input') state.workspace.drafts.private_summary.version = request.expected_version + 2; else state.workspace.drafts.private_summary.fields.custom_complete_field = '另一页面已保存字段'; };
  await mount(page); await pending(page, state); const request = structuredClone(draftWrites(state)[0]), observed = structuredClone(state.workspace.drafts.private_summary); await refreshReadOnly(page, state); await resume(page).click(); await expect(resume(page)).toBeEnabled();
  expect(draftWrites(state)).toEqual([request]); expect(state.workspace.drafts.private_summary).toEqual(observed); expect(await records(page)).toHaveLength(1); noBusiness(state);
});

test('M4 captured topic pending requirements form the exact ordered deduplicated expected effect', async ({ page }) => {
  const state = await install(page), original = inputOf(state.workspace.drafts.private_summary), added = requirement('captured-pending'); state.workspace.pending_requirements = [original.requirements[0], added]; await mount(page); await select(page); await saved(page, state);
  const sent = expectedInput(original, state, 'material'); expect(draftWrites(state)).toEqual([{ expected_version: 3, input: sent }]); expect(inputOf(state.workspace.drafts.private_summary)).toEqual({ ...sent, requirements: [...original.requirements, added] }); expect(state.workspace.pending_requirements).toEqual([]); noBusiness(state);
});

test('M4 a newly arriving pending requirement between GET and PUT is retained as a conflict instead of being removed or rebased', async ({ page }) => {
  const state = await install(page), arrived = requirement('arrived-during-put'); state.beforeDraft = () => { state.workspace.pending_requirements.push(arrived); }; await mount(page); await pending(page, state);
  const request = structuredClone(draftWrites(state)[0]); expect(request.input.requirements).not.toContainEqual(arrived); expect(state.workspace.drafts.private_summary.requirements).toContainEqual(arrived); const observed = structuredClone(state.workspace.drafts.private_summary);
  await refreshReadOnly(page, state); await resume(page).click(); await expect(resume(page)).toBeEnabled(); expect(draftWrites(state)).toEqual([request]); expect(state.workspace.drafts.private_summary).toEqual(observed); expect(await records(page)).toHaveLength(1); noBusiness(state);
});

test('M4 contradictory non-atomic draft and pending observations preserve content confirmation separately from pending consumption', async ({ page }) => {
  const state = await install(page), captured = requirement('non-atomic-pending'); state.workspace.pending_requirements = [captured]; state.afterDraft = () => { state.workspaceObservation = value => ({ ...value, pending_requirements: [captured] }); };
  await mount(page); await pending(page, state); const sent = structuredClone(draftWrites(state)[0]), content = structuredClone(state.workspace.drafts.private_summary); expect(content.requirements).toContainEqual(captured);
  await refreshReadOnly(page, state); await resume(page).click(); await expect(resume(page)).toBeEnabled(); expect(draftWrites(state)).toEqual([sent]); expect(state.workspace.drafts.private_summary).toEqual(content); expect(await records(page)).toHaveLength(1); await expect(recovery(page)).toContainText(/要求|核对/); noBusiness(state);
});

test('M4 no-op content already satisfied cannot prove that captured pending requirements were consumed', async ({ page }) => {
  const state = await install(page), reused = materialOf(); state.dedupMaterial = reused; state.workspace.drafts.private_summary.materials.push(addMaterial(state, reused, ids.project, true)); const original = inputOf(state.workspace.drafts.private_summary), captured = original.requirements[0]; state.workspace.pending_requirements = [captured]; state.afterDraft = () => { state.workspaceObservation = value => ({ ...value, pending_requirements: [captured] }); };
  await mount(page); await pending(page, state); expect(state.workspace.drafts.private_summary.version).toBe(3); expect(inputOf(state.workspace.drafts.private_summary)).toEqual(original); const sent = structuredClone(draftWrites(state)); expect(sent.length).toBeLessThanOrEqual(1);
  await refreshReadOnly(page, state); await resume(page).click(); await expect(resume(page)).toBeEnabled(); expect(draftWrites(state)).toEqual(sent); expect(await records(page)).toHaveLength(1); await expect(recovery(page)).toContainText(/要求|核对/); noBusiness(state);
});

test('M4 pending consumption confirmed later applies the original proof and lets the next file continue from it', async ({ page }) => {
  const state = await install(page), captured = requirement('pending-eventually-confirmed'); state.workspace.pending_requirements = [captured];
  state.afterDraft = () => { state.workspaceObservation = value => ({ ...value, pending_requirements: [captured] }); }; await mount(page); await select(page, 'material', [file, secondFile]);
  await expect(resume(page)).toBeEnabled(); await expect(resume(page, secondFile.name)).toBeDisabled(); const first = structuredClone(draftWrites(state)[0]), proof = structuredClone(state.workspace.drafts.private_summary);
  expect(proof.version).toBe(4); expect(proof.requirements).toContainEqual(captured); expect(uploads(state, 'create')).toHaveLength(1); expect((await records(page))[0].value.items[0].observedDraft).toEqual(proof);
  const refreshWrites = await refreshReadOnly(page, state);
  // Return-to-page refresh launches a GET-only recovery read without awaiting it. Keep P visible until that read and its local queue settle.
  await expect.poll(() => page.evaluate(async () => { const component = (window as unknown as { m4Component: { refreshing?: unknown; uploadReading: boolean; uploading: boolean; cacheQueue: Promise<void> } }).m4Component; if (component.refreshing || component.uploadReading || component.uploading) return false; const queue = component.cacheQueue; await queue; return !component.refreshing && !component.uploadReading && !component.uploading && component.cacheQueue === queue; })).toBe(true);
  await expect(resume(page)).toBeEnabled(); expect(writes(state)).toHaveLength(refreshWrites); expect(draftWrites(state)).toEqual([first]); state.workspaceObservation = undefined; state.afterDraft = undefined;
  const before = writes(state).length; await resume(page).click(); await expect(resume(page, secondFile.name)).toBeEnabled(); expect(writes(state)).toHaveLength(before); expect(draftWrites(state)).toEqual([first]);
  const [record] = await records(page); expect(record.value.items[0].localCacheResult).toBe('patched'); expect(record.value.items[0].observedDraft).toEqual(proof); expect((await legacyCache(page)).drafts.private_summary).toEqual({ version: proof.version, input: inputOf(proof), dirty: false, conflict: false });
  await resume(page, secondFile.name).click(); const secondReselect = recovery(page, secondFile.name).locator('[data-m4-recovery-reselect]'); await expect(secondReselect).toBeAttached(); await expect(resume(page, secondFile.name)).toBeEnabled();
  expect(writes(state)).toHaveLength(before); await secondReselect.setInputFiles(secondFile); await saved(page, state); expect(uploads(state, 'create')).toHaveLength(2); expect(uploads(state, 'bytes')).toHaveLength(2); expect(draftWrites(state)).toEqual([first, { expected_version: 4, input: expectedInput(inputOf(proof), state, 'material', 1) }]); expect(state.workspace.drafts.private_summary.requirements).toContainEqual(captured); noBusiness(state);
});

test('M4 captured pending consumed elsewhere prevents replay of an unknown original draft request', async ({ page }) => {
  const state = await install(page), captured = requirement('pending-consumed-elsewhere'); state.workspace.pending_requirements = [captured]; state.dropDraft = 'before'; await mount(page); await pending(page, state);
  const sent = structuredClone(draftWrites(state)[0]); state.workspace.drafts.legal.requirements.push(captured); state.workspace.drafts.legal.version++; state.workspace.pending_requirements = []; await refreshReadOnly(page, state); await resume(page).click(); await expect(resume(page)).toBeEnabled();
  expect(draftWrites(state)).toEqual([sent]); expect(state.workspace.drafts.private_summary.version).toBe(3); expect(state.workspace.drafts.legal.requirements).toContainEqual(captured); noBusiness(state);
});

test('M4 ordered batch resumes its interrupted second item only along the first verified complete draft', async ({ page }) => {
  const state = await install(page), original = inputOf(state.workspace.drafts.private_summary); state.dropCompleteAt = 2; await mount(page); await select(page, 'material', [file, secondFile]); await expect(resume(page, secondFile.name)).toBeEnabled();
  expect(draftWrites(state)).toHaveLength(1); const first = structuredClone(draftWrites(state)[0]); expect(state.workspace.drafts.private_summary.version).toBe(4); await refreshReadOnly(page, state); await resume(page, secondFile.name).click(); await saved(page, state);
  expect(draftWrites(state)).toHaveLength(2); expect(draftWrites(state)[0]).toEqual(first); expect(draftWrites(state)[1]).toEqual({ expected_version: 4, input: expectedInput(first.input, state, 'material', 1) }); expect(state.workspace.drafts.private_summary.requirements).toEqual(original.requirements); expect(uploads(state, 'create')).toHaveLength(2); expect(uploads(state, 'bytes')).toHaveLength(2);
});

test('M4 target cache edits during upload are preserved and prevent adoption from a stale component snapshot', async ({ page }) => {
  const state = await install(page); await mount(page); const release = await gatedUpload(page, state); const changed = await cacheMutation(page, cache => { cache.drafts.private_summary.input.supplemental_requirements = '另一页面未保存的新要求'; cache.drafts.private_summary.dirty = true; }); release(); await expect(resume(page)).toBeEnabled();
  expect(draftWrites(state)).toHaveLength(0); expect(await page.evaluate(key => localStorage.getItem(key), changed.key)).toBe(changed.raw); await refreshReadOnly(page, state); await expect(page.locator('#m4-requirements')).toHaveValue('另一页面未保存的新要求'); noBusiness(state);
});

test('M4 local typing during a sent draft is preserved separately from confirmed server adoption', async ({ page }) => {
  const state = await install(page); let release!: () => void; state.draftGate = () => new Promise<void>(resolve => { release = resolve; }); await mount(page); await select(page); await expect.poll(() => draftWrites(state).length).toBe(1);
  await page.locator('#m4-requirements').fill('本页稍后输入的要求，不属于已经封存的上传。'); const request = structuredClone(draftWrites(state)[0]); state.draftGate = undefined; release(); await page.clock.runFor(1_000);
  await expect(page.locator('#m4-requirements')).toHaveValue('本页稍后输入的要求，不属于已经封存的上传。'); expect(inputOf(state.workspace.drafts.private_summary)).toEqual(request.input); expect(draftWrites(state)).toEqual([request]); noBusiness(state);
});

test('M4 applying the original draft patches only its cache child and retains newer other-document and reading state', async ({ page }) => {
  const state = await install(page); await mount(page); const release = await gatedUpload(page, state); const changed = await cacheMutation(page, cache => {
    cache.drafts.legal.input.supplemental_requirements = '另一文种的新本地要求'; cache.drafts.legal.dirty = true; cache.view.unsent_content = '保留较新的讨论文字'; cache.view.tab_scroll = { 'artifact:old:2': 137 }; cache.viewVersion = 8; cache.viewDirty = true;
  }); release(); await saved(page, state); const current = await legacyCache(page);
  expect(current.drafts.legal).toEqual(changed.cache.drafts.legal); for (const key of ['view', 'viewVersion', 'viewDirty', 'pendingMessage', 'pendingExecution']) expect(current[key]).toEqual(changed.cache[key]); expect(current.drafts.private_summary.input).toEqual(inputOf(state.workspace.drafts.private_summary)); expect(draftWrites(state)).toHaveLength(1); noBusiness(state);
});

test('M4 a new pending execution before draft transmission stops adoption and preserves its original request', async ({ page }) => {
  const state = await install(page); await mount(page); const release = await gatedUpload(page, state), request = pendingExecution();
  await cacheMutation(page, cache => { cache.pendingExecution = request; }); release(); await expect(resume(page)).toBeEnabled();
  expect(draftWrites(state)).toHaveLength(0); expect((await legacyCache(page)).pendingExecution).toEqual(request); expect(state.workspace.drafts.private_summary.version).toBe(3);
  await refreshReadOnly(page, state); expect(draftWrites(state)).toHaveLength(0); expect((await legacyCache(page)).pendingExecution).toEqual(request); expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1); expect(await records(page)).toHaveLength(1); noBusiness(state);
});

test('M4 a pending execution arriving during draft transmission preserves proof and local input without starting the next file', async ({ page }) => {
  const state = await install(page), original = inputOf(state.workspace.drafts.private_summary); let release!: () => void; state.draftGate = () => new Promise<void>(resolve => { release = resolve; });
  await mount(page); await select(page, 'material', [file, secondFile]); await expect.poll(() => draftWrites(state).length).toBe(1); const sent = structuredClone(draftWrites(state)[0]), request = pendingExecution();
  await cacheMutation(page, cache => { cache.pendingExecution = request; }); state.draftGate = undefined; release();
  await expect.poll(async () => (await records(page))[0]?.value.items[0].localCacheResult).toBe('preserved');
  const [record] = await records(page), proof = structuredClone(record.value.items[0].observedDraft); expect(proof).toEqual(state.workspace.drafts.private_summary); expect(inputOf(proof)).toEqual(sent.input); expect(proof.version).toBe(4);
  expect(record.value.items[1].stage).toBe('prepared'); expect((await legacyCache(page)).drafts.private_summary.input).toEqual(original); expect((await legacyCache(page)).pendingExecution).toEqual(request); expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1);
  await refreshReadOnly(page, state); expect(draftWrites(state)).toEqual([sent]); expect(uploads(state, 'create')).toHaveLength(1); expect((await records(page))[0].value.items[0].observedDraft).toEqual(proof); expect((await records(page))[0].value.items[1].stage).toBe('prepared'); expect((await legacyCache(page)).pendingExecution).toEqual(request); await expect(resume(page, secondFile.name)).toBeDisabled(); noBusiness(state);
});

test('M4 a concurrent server baseline never becomes a new base for the original upload', async ({ page }) => {
  const state = await install(page); await mount(page); const release = await gatedUpload(page, state); state.workspace.drafts.private_summary = { ...state.workspace.drafts.private_summary, version: 4, supplemental_requirements: '服务器另一页面已保存的新要求' }; const observed = structuredClone(state.workspace.drafts.private_summary); release(); await expect(resume(page)).toBeEnabled();
  expect(state.workspace.drafts.private_summary).toEqual(observed); expect(draftWrites(state).length).toBeLessThanOrEqual(1); expect(draftWrites(state).every(request => request.expected_version === 3)).toBe(true); await refreshReadOnly(page, state); expect(state.workspace.drafts.private_summary).toEqual(observed); noBusiness(state);
});

test('M4 a refresh GET captured before upload cannot roll back a later confirmed and applied complete draft', async ({ page }) => {
  const state = await install(page); await mount(page); let release!: () => void, entered = false; const held = new Promise<void>(resolve => { release = resolve; });
  state.workspaceGate = async value => { if (!entered) { entered = true; expect(value.drafts.private_summary.version).toBe(3); await held; } };
  await page.locator('[data-m4-action=refresh]').click(); await expect.poll(() => entered).toBe(true); await select(page); await saved(page, state);
  const confirmed = structuredClone(state.workspace.drafts.private_summary), selected = pin([...state.uploads.values()][0].material!), before = writes(state).length; expect(confirmed.version).toBe(4);
  const response = page.waitForResponse(value => value.url().includes(`/m4/topics/${ids.topic}/workspace`)); state.workspaceGate = undefined; release(); await response;
  await expect.poll(() => page.evaluate(() => !(window as unknown as { m4Component: { refreshing?: unknown } }).m4Component.refreshing)).toBe(true); await page.clock.runFor(1_000);
  await expect(page.locator(`[data-m4-material="${pinKey(selected)}"]`)).toBeChecked(); const cache = await legacyCache(page); expect(cache.drafts.private_summary).toEqual({ version: 4, input: inputOf(confirmed), dirty: false, conflict: false });
  expect(state.workspace.drafts.private_summary).toEqual(confirmed); expect(writes(state)).toHaveLength(before); expect(draftWrites(state)).toHaveLength(1); noBusiness(state);
});

test('M4 local-event and cache-queue fault injection between the real helper result and UI apply preserves edits and stops the batch', async ({ page }) => {
  const state = await install(page), originalInput = inputOf(state.workspace.drafts.private_summary); await mount(page);
  // Preserve real HTTP/helper results and the original UI method. This is a local queue/input fault injection at the final apply seam, not an HTTP race.
  await page.evaluate(() => {
    const w = window as unknown as { m4Component: { applyUploadResult(result: { applyToPage: boolean }, index: number): boolean; cache(): void; cacheQueue: Promise<void>; drafts: Map<string, unknown>; uploading: boolean }; m4ApplyFault?: { injected: boolean; applied?: boolean; queuedOldTarget?: unknown } }, component = w.m4Component, original = component.applyUploadResult;
    w.m4ApplyFault = { injected: false }; component.applyUploadResult = function(result, index) {
      if (index === 0 && result.applyToPage && !w.m4ApplyFault!.injected) {
        w.m4ApplyFault!.injected = true; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), previousQueue = this.cacheQueue;
        this.cacheQueue = previousQueue.then(() => gate); w.m4ApplyFault!.queuedOldTarget = structuredClone(this.drafts.get('private_summary')); this.cache();
        const input = document.querySelector<HTMLTextAreaElement>('#m4-requirements')!; input.value = '最后采用前新输入的本地要求必须保留'; input.dispatchEvent(new Event('input', { bubbles: true }));
        try { const applied = original.call(this, result, index); w.m4ApplyFault!.applied = applied; return applied; } finally { release(); }
      }
      return original.call(this, result, index);
    };
  });
  await select(page, 'material', [file, secondFile]); await expect.poll(() => page.evaluate(() => (window as unknown as { m4ApplyFault?: { injected: boolean } }).m4ApplyFault?.injected)).toBe(true);
  await expect.poll(() => page.evaluate(() => !(window as unknown as { m4Component: { uploading: boolean } }).m4Component.uploading)).toBe(true); await page.clock.runFor(1_000);
  await page.evaluate(async () => { await (window as unknown as { m4Component: { cacheQueue: Promise<void> } }).m4Component.cacheQueue; });
  expect(await page.evaluate(() => (window as unknown as { m4ApplyFault: { queuedOldTarget?: unknown } }).m4ApplyFault.queuedOldTarget)).toEqual({ version: 3, input: originalInput, dirty: false, conflict: false });
  expect(await page.evaluate(() => (window as unknown as { m4ApplyFault: { applied?: boolean } }).m4ApplyFault.applied)).toBe(false); await expect(page.locator('#m4-requirements')).toHaveValue('最后采用前新输入的本地要求必须保留');
  expect((await legacyCache(page)).drafts.private_summary.input.supplemental_requirements).toBe('最后采用前新输入的本地要求必须保留'); expect(state.workspace.drafts.private_summary.version).toBe(4); expect(state.workspace.drafts.private_summary.supplemental_requirements).not.toBe('最后采用前新输入的本地要求必须保留');
  expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1); expect(draftWrites(state)).toHaveLength(1); expect((await records(page))[0].value.items[1].stage).toBe('prepared'); noBusiness(state);
});

test('M4 late upload response after account disposal cannot reveal the original filename or continue library and draft writes', async ({ page }) => {
  const state = await install(page); await mount(page); const release = await gatedUpload(page, state); state.owner = ids.otherOwner; await mount(page, { navigation: 'same-page', owner: ids.otherOwner }); release(); await page.clock.runFor(1_000);
  await expect(page.locator('body')).not.toContainText(file.name); expect(libraryWrites(state)).toHaveLength(0); expect(draftWrites(state)).toHaveLength(0); expect((await records(page))[0].value.owner).toBe(ids.owner); noBusiness(state);
});

test('M4 a removed business record during upload is never recreated from old memory', async ({ page }) => {
  const state = await install(page); await mount(page); const release = await gatedUpload(page, state); const [record] = await records(page); await page.evaluate(key => { localStorage.removeItem(key); dispatchEvent(new StorageEvent('storage', { key, newValue: null })); }, record.key); release(); await page.clock.runFor(1_000);
  expect(await records(page)).toHaveLength(0); expect(libraryWrites(state)).toHaveLength(0); expect(draftWrites(state)).toHaveLength(0); await refreshReadOnly(page, state); expect(await records(page)).toHaveLength(0); expect(uploads(state, 'create')).toHaveLength(1); noBusiness(state);
});

test('M4 a missing core record fails closed instead of replacing the original upload identity', async ({ page }) => {
  const state = await install(page); state.dropPut = 'after'; await mount(page); await pending(page, state); await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('bondbuddy:upload-recovery:v1:') && key.includes(':m4-upload:')) localStorage.removeItem(key); });
  await refreshReadOnly(page, state); const before = writes(state).length; await resume(page).click(); await expect(resume(page)).toBeEnabled(); expect(writes(state)).toHaveLength(before); expect(await records(page)).toHaveLength(1); expect(uploads(state, 'create')).toHaveLength(1); noBusiness(state);
});

test('M4 browser declaration storage failure prevents every upload, library, draft and view write', async ({ page }) => {
  const state = await install(page); await mount(page); await page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.startsWith('bb-m4-upload-v1:')) throw new DOMException('Synthetic quota', 'QuotaExceededError'); return original.call(this, key, value); }; });
  await select(page); await expect(page.locator('#m4-status')).toContainText(/保存|记录|本机|浏览器/); await page.clock.runFor(1_000); expect(writes(state)).toEqual([]); noBusiness(state);
});

test('M4 cleanup failure retries local cleanup only after the three server stages are confirmed', async ({ page }) => {
  const state = await install(page); await mount(page); await page.evaluate(() => { const w = window as unknown as { failM4Cleanup: boolean }; w.failM4Cleanup = true; const original = Storage.prototype.removeItem; Storage.prototype.removeItem = function(key) { if (w.failM4Cleanup && key.startsWith('bondbuddy:upload-recovery:v1:') && key.includes(':m4-upload:')) throw new DOMException('Synthetic cleanup failure'); return original.call(this, key); }; });
  await select(page); await expect(resume(page)).toBeEnabled(); expect(state.workspace.drafts.private_summary.version).toBe(4); expect(draftWrites(state)).toHaveLength(1); const before = writes(state).length;
  await page.evaluate(() => { (window as unknown as { failM4Cleanup: boolean }).failM4Cleanup = false; }); await resume(page).click(); await saved(page, state); expect(writes(state)).toHaveLength(before); expect(libraryWrites(state)).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1);
});

test('M4 original-file reselect rejects different bytes and explicitly replaces only the original declaration', async ({ page }) => {
  const state = await install(page); state.dropPut = 'before'; await mount(page); await pending(page, state); await refreshReadOnly(page, state); await resume(page).click(); const reselect = recovery(page).locator('[data-m4-recovery-reselect]'); await expect(reselect).toBeAttached(); await expect(resume(page)).toBeEnabled();
  const before = writes(state).length, declaration = structuredClone((await records(page))[0].value.items[0].declaration), originalUploadId = [...state.uploads.keys()][0];
  await reselect.setInputFiles({ ...file, buffer: Buffer.from('x'.repeat(file.buffer.length)) }); await expect(resume(page)).toBeEnabled();
  expect(writes(state).slice(before)).toEqual([{ method: 'POST', path: `/projects/${ids.project}/materials/uploads/${originalUploadId}/complete`, search: '', body: { byte_size: declaration.byte_size, sha256: declaration.sha256 } }]);
  expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1); expect(libraryWrites(state)).toHaveLength(0); expect(draftWrites(state)).toHaveLength(0); expect((await records(page))[0].value.items[0].declaration).toEqual(declaration); await expect(recovery(page)).toContainText('原文件声明和记录已保留');
  await reselect.setInputFiles(file); await saved(page, state); expect(uploads(state, 'create')).toHaveLength(2); expect(uploads(state, 'bytes')).toHaveLength(2); expect(uploads(state, 'create')[1].body).toEqual(uploads(state, 'create')[0].body); expect(libraryWrites(state)).toHaveLength(1); expect(draftWrites(state)).toHaveLength(1);
});

test('M4 recovery blocks autosave, direct save, execution and beforeLeave while reading and local edits remain available', async ({ page }) => {
  const state = await install(page), historical = state.workspace.drafts.private_summary.source_material!, old = [...state.materials.values()].find(value => value.material_id === historical.material_id)!;
  const latestBytes = Buffer.from('Synthetic newer prospectus must not replace the pinned download'); addMaterial(state, { ...old, material_version: 2, byte_size: latestBytes.length, sha256: hash(latestBytes), upload_id: 'newer-source-upload' }, ids.sourceProject);
  state.dropCompleteAt = 1; await mount(page); await pending(page, state); const before = writes(state).length; await page.locator('#m4-requirements').fill('保留本页新增要求；原上传未解决时不能保存任何文种。');
  await choose(page, 'legal'); await page.locator('#m4-requirements').fill('其他文种允许本地编辑但不能消费同话题要求。');
  await page.evaluate(async () => { const component = (window as unknown as { m4Component: { flush(): Promise<boolean>; execute(entry: string): Promise<void>; beforeLeave(): Promise<boolean> } }).m4Component; await component.flush(); await component.execute('workspace'); await component.beforeLeave(); });
  const downloaded = page.waitForEvent('download'); await page.locator('.m4-source-file [data-m4-action=download-material]').click(); expect((await downloaded).suggestedFilename()).toBe(old.filename);
  const exactPath = `/projects/${ids.sourceProject}/materials/${historical.material_id}`; expect(state.calls.filter(call => call.path === exactPath).at(-1)?.search).toBe('?version=1'); expect(state.calls.filter(call => call.path === exactPath + '/download').at(-1)?.search).toBe('?version=1');
  await page.locator('[data-m4-action=artifact]').first().click(); await expect(page.locator('.m4-preview')).toContainText('合成原成果正文'); await page.clock.runFor(1_000); expect(writes(state)).toHaveLength(before); noBusiness(state);
  await refreshReadOnly(page, state); const cache = await legacyCache(page); expect(cache.drafts.private_summary.input.supplemental_requirements).toContain('保留本页新增要求'); expect(cache.drafts.legal.input.supplemental_requirements).toContain('其他文种允许本地编辑'); expect(draftWrites(state)).toHaveLength(0);
});

test('M4 source replacement cannot discard a project_file association to bypass its exact source constraint', async ({ page }) => {
  const state = await install(page), original = inputOf(state.workspace.drafts.private_summary); original.project_file = { project_id: ids.sourceProject, source_version_id: 'protected-source-version', source_selection_revision: 7, expected_file_version_id: null }; state.workspace.drafts.private_summary.project_file = structuredClone(original.project_file); state.projectFileSources.set('protected-source-version', original.source_material!);
  await mount(page); await pending(page, state, 'source'); expect(state.workspace.drafts.private_summary.version).toBe(3); expect(inputOf(state.workspace.drafts.private_summary)).toEqual(original); expect(draftWrites(state).every(request => JSON.stringify(request.input.project_file) === JSON.stringify(original.project_file))).toBe(true); expect(draftWrites(state).length).toBeLessThanOrEqual(1); expect(await records(page)).toHaveLength(1); noBusiness(state);
});

test('M4 unavailable original topic after file save cannot redirect registration or adoption to another target', async ({ page }) => {
  const state = await install(page); await mount(page); const release = await gatedUpload(page, state); state.unavailableTopic = true; release(); await expect(resume(page)).toBeEnabled(); const before = writes(state).length; await resume(page).click(); await expect(resume(page)).toBeEnabled();
  expect(writes(state)).toHaveLength(before); expect(libraryWrites(state)).toHaveLength(0); expect(draftWrites(state)).toHaveLength(0); expect(await records(page)).toHaveLength(1); noBusiness(state);
});

async function capture(page: Page, directory: string, name: string) {
  const filename = `m4-upload-thirteenth-${name}.png`, bytes = await page.screenshot({ path: join(directory, filename), fullPage: false });
  const geometry = await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight }, overflow: document.documentElement.scrollWidth > innerWidth + 1, text: document.body.innerText, regions: [...document.querySelectorAll('[data-m4-drop=source],[data-m4-drop=material],[data-m4-recovery-id]')].map(element => { const rect = element.getBoundingClientRect(); return { selector: element.hasAttribute('data-m4-recovery-id') ? 'recovery' : element.getAttribute('data-m4-drop'), x: rect.x, y: rect.y, width: rect.width, height: rect.height }; }) })); expect(geometry.overflow).toBe(false);
  const record = { filename, screenshot_sha256: hash(bytes), kind: 'viewport', scope: 'Actual MaterialWorkspace and global CSS; strict synthetic public HTTP; no production object storage, document acceptance or human signoff.', ...geometry }; await writeFile(join(directory, filename.replace('.png', '.json')), JSON.stringify(record, null, 2)); return record;
}
for (const purpose of ['source', 'material'] as const) for (const width of [1440, 390]) test(`m4 upload component comparison ${purpose} at ${width}`, async ({ page }) => {
  const directory = process.env.BB_M4_UPLOAD_THIRTEENTH_EVIDENCE_DIR ?? process.env.BB_THIRTEENTH_EVIDENCE_DIR; test.skip(!directory, 'Explicit thirteenth evidence directory is required'); await mkdir(directory!, { recursive: true });
  const reference = process.env.BB_THIRTEENTH_REFERENCE === '1', finish = reference ? await installThirteenthReference(page) : undefined; await page.setViewportSize({ width, height: 960 }); const state = await install(page); state.dropPut = 'after'; await mount(page);
  const flavor = reference ? 'reference' : 'implementation', captured = []; await page.locator(`[data-m4-upload=${purpose}]`).last().scrollIntoViewIfNeeded(); captured.push(await capture(page, directory!, `${flavor}-${purpose}-ready-${width}`));
  await select(page, purpose); if (reference) await expect(page.locator('[data-m4-action=retry-upload]')).toBeEnabled(); else await expect(resume(page)).toBeEnabled(); captured.push(await capture(page, directory!, `${flavor}-${purpose}-pending-${width}`));
  const before = await refreshReadOnly(page, state); if (reference) { await expect(page.locator('[data-m4-action=retry-upload]')).toHaveCount(0); await expect(page.locator('[data-m4-recovery-id]')).toHaveCount(0); await page.locator(`[data-m4-upload=${purpose}]`).last().scrollIntoViewIfNeeded(); } else { await expect(resume(page)).toBeEnabled(); await recovery(page).scrollIntoViewIfNeeded(); }
  expect(writes(state)).toHaveLength(before); captured.push(await capture(page, directory!, `${flavor}-${purpose}-refreshed-${width}`));
  await writeFile(join(directory!, `m4-upload-thirteenth-${flavor}-${purpose}-comparison-${width}.json`), JSON.stringify({ reference, source: finish ? await finish() : { scope: 'Current thirteenth implementation; no approved new recovery prototype or human signoff.' }, records: captured, writes_after_refresh: 0, original_upload_creates: uploads(state, 'create').length, original_puts: uploads(state, 'bytes').length, library_posts: libraryWrites(state).length, draft_puts: draftWrites(state).length, errors: state.errors, unexpected_requests: state.unexpected }, null, 2)); noBusiness(state);
});
