import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { M4DraftInput, M4ExecuteRequest, M4Template } from '@bondbuddy/contracts';
import { installFourteenthReference } from './upload-fourteenth-reference';
import { install, mount, fixture, ids, now, templateFile, mime, hash, pin, pinKey, inputOf, addMaterial, requirement, uploads, writes, draftWrites, libraryWrites, legacyCache, choose, templatePosts, noBusiness, recovery, resume, select, records, settle, refreshReadOnly, pending, saved, type State } from './m4-template-fourteenth-fixtures';

const referenceOf = (template: M4Template) => ({ template_id: template.template_id, template_version: template.template_version, sha256: template.sha256 });
const firstTemplate = (state: State) => [...state.templateKeys.values()][0].template;
const templateSavedStatus = (page: Page) => recovery(page).locator('[data-m4-template-saved-status]');
const expectedInput = (original: M4DraftInput, state: State): M4DraftInput => ({ ...structuredClone(original), template: referenceOf(firstTemplate(state)) });
const execution = (): M4ExecuteRequest => ({ execution_request_id: 'm4-fourteenth-pending-execution', document_type: 'legal', expected_draft_version: 3, quote_id: 'm4-fourteenth-old-quote', entrypoint: 'workspace' });
async function cacheMutation(page: Page, mutate: (cache: any) => void) { const value = await legacyCache(page); expect(value).not.toBeNull(); mutate(value); const raw = JSON.stringify(value), key = `bb-m4:${ids.owner}:${ids.topic}`; await page.evaluate(({ key, raw }) => { localStorage.setItem(key, raw); dispatchEvent(new StorageEvent('storage', { key, newValue: raw })); }, { key, raw }); return { value, raw, key }; }
async function holdTemplate(page: Page, state: State) { let release!: () => void; state.templateGate = () => new Promise<void>(resolve => { release = resolve; }); await select(page); await expect.poll(() => templatePosts(state).length).toBe(1); return () => { state.templateGate = undefined; release(); }; }
function oneTransport(state: State) { expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1); expect(libraryWrites(state)).toHaveLength(1); }

test('M4 template visible init picker saves the exact file, membership, new template and original whole draft once', async ({ page }) => {
  const state = await install(page), original = inputOf(state.workspace.drafts.init), others = structuredClone(state.workspace.drafts); await mount(page);
  const picker = page.locator('[data-m4-upload=template]'); await expect(picker).toHaveCount(1); await expect(picker).toHaveAttribute('accept', '.docx'); await expect(picker).not.toHaveAttribute('multiple'); await expect(page.locator('#m4-template-region')).toBeVisible();
  await select(page); await saved(page, state); oneTransport(state); expect(uploads(state, 'complete')).toHaveLength(1); expect(templatePosts(state)).toHaveLength(1); expect(state.templateKeys.size).toBe(1);
  const request = templatePosts(state)[0]; expect(request).toEqual({ creation_request_id: expect.any(String), name: templateFile.name, broker: original.fields.broker, document_type: 'init', material: pin([...state.uploads.values()][0].material!), market: 'sse' });
  expect(draftWrites(state)).toEqual([{ expected_version: 3, input: expectedInput(original, state) }]); expect(inputOf(state.workspace.drafts.init)).toEqual(expectedInput(original, state)); expect(state.workspace.drafts.init.version).toBe(4);
  expect(state.workspace.drafts.init.materials).toEqual(original.materials); expect(state.workspace.drafts.init.source_material).toEqual(original.source_material); for (const [type, value] of Object.entries(others)) if (type !== 'init') expect(state.workspace.drafts[type as keyof typeof others]).toEqual(value);
  await expect(page.locator('#m4-template')).toHaveValue(`${firstTemplate(state).template_id}:1`); expect(writes(state).filter(call => call.path.includes(`/projects/${ids.sourceProject}/`))).toEqual([]); noBusiness(state);
});

test('M4 template actual drop zone keeps its single original DOCX instead of accepting a second dropped file', async ({ page }) => {
  const state = await install(page); await mount(page); await page.locator('[data-m4-drop=template]').dispatchEvent('drop', { dataTransfer: await page.evaluateHandle(({ name, mime, content }) => { const value = new DataTransfer(); value.items.add(new File([content], name, { type: mime })); value.items.add(new File(['Unselected second file'], '不应上传的第二份模板.docx', { type: mime })); return value; }, { name: templateFile.name, mime, content: templateFile.buffer.toString() }) });
  await saved(page, state); oneTransport(state); expect(uploads(state, 'create')[0].body).toMatchObject({ filename: templateFile.name, byte_size: templateFile.buffer.length, sha256: hash(templateFile.buffer), role: 'other' }); expect(templatePosts(state)).toHaveLength(1); noBusiness(state);
});

for (const invalid of ['broker', 'market', 'offering'] as const) test(`M4 template missing or incompatible ${invalid} stops before every upload and template write`, async ({ page }) => {
  const state = fixture(); state.workspace.drafts.init.fields[invalid] = invalid === 'broker' ? '   ' : invalid === 'market' ? '' : 'public'; await install(page, state); await mount(page); await select(page); await settle(page); await page.clock.runFor(1_000);
  expect(uploads(state, 'create')).toEqual([]); expect(templatePosts(state)).toEqual([]); expect(draftWrites(state)).toEqual([]); expect(await records(page)).toEqual([]); noBusiness(state);
});

test('M4 template transport lost acknowledgement refreshes read-only and explicitly confirms the same original upload', async ({ page }) => {
  const state = await install(page); state.dropPut = 'after'; await mount(page); await pending(page, state); const upload = [...state.uploads.keys()][0]; await refreshReadOnly(page, state); expect(templatePosts(state)).toEqual([]); await resume(page).click(); await saved(page, state);
  oneTransport(state); expect(uploads(state, 'complete').every(call => call.path.endsWith(`/${upload}/complete`))).toBe(true); expect(templatePosts(state)).toHaveLength(1); expect(draftWrites(state)).toHaveLength(1);
});

for (const drop of ['before', 'after'] as const) test(`M4 template membership acknowledgement lost ${drop} acceptance retries only the exact missing original relation`, async ({ page }) => {
  const state = await install(page); state.dropLibrary = drop; if (drop === 'after') state.libraryGate = async () => { state.failWorkspaceReads = true; }; await mount(page); await pending(page, state); const first = structuredClone(libraryWrites(state)[0]); state.failWorkspaceReads = false; state.libraryGate = undefined; await refreshReadOnly(page, state); expect(templatePosts(state)).toEqual([]); await resume(page).click(); await saved(page, state);
  expect(libraryWrites(state)).toEqual(drop === 'before' ? [first, first] : [first]); expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1); expect(templatePosts(state)).toHaveLength(1); expect(draftWrites(state)).toHaveLength(1);
});

test('M4 template unknown creation never infers its key from a single matching candidate and explicit retry seals the original full request', async ({ page }) => {
  const state = await install(page); state.dropTemplate = 'after'; await mount(page); await pending(page, state); const original = structuredClone(templatePosts(state)[0]), created = structuredClone(firstTemplate(state)); expect(state.templateKeys.size).toBe(1); expect(draftWrites(state)).toEqual([]);
  const before = await refreshReadOnly(page, state); expect(templatePosts(state)).toEqual([original]); expect((await records(page))[0].value.items[0].templateReceipt).toBeUndefined(); expect(state.workspace.templates.filter(value => value.template_id === created.template_id)).toHaveLength(1);
  await choose(page, 'legal'); expect(writes(state)).toHaveLength(before); await expect(page.locator('[data-m4-upload=template]')).toHaveCount(0); await page.locator('[data-m4-template-recovery-target]').first().click(); await expect(page.locator('[data-m4-type]:checked')).toHaveValue('init'); await expect(resume(page)).toBeFocused(); await expect(recovery(page)).toBeInViewport();
  await resume(page).click(); await saved(page, state); expect(templatePosts(state)).toEqual([original, original]); expect(state.templateKeys.size).toBe(1); expect(state.workspace.drafts.init.template).toEqual(referenceOf(created)); oneTransport(state); expect(draftWrites(state)).toHaveLength(1);
});

test('M4 template unknown unaccepted creation does not adopt an unrelated identical template from another creation key', async ({ page }) => {
  const state = await install(page); state.dropTemplate = 'before'; await mount(page); await pending(page, state); const original = structuredClone(templatePosts(state)[0]);
  const decoy: M4Template = { ...state.workspace.templates.find(value => value.document_type === 'init')!, template_id: 'm4-fourteenth-unrelated-template', template_version: 1, name: original.name, broker: original.broker, material: structuredClone(original.material), sha256: original.material.sha256, status: 'active', retired_at: null };
  state.workspace.templates.push(decoy); state.templateKeys.set('m4-fourteenth-unrelated-key', { request: { ...original, creation_request_id: 'm4-fourteenth-unrelated-key' }, template: decoy }); await refreshReadOnly(page, state);
  expect(templatePosts(state)).toEqual([original]); expect(draftWrites(state)).toEqual([]); expect((await records(page))[0].value.items[0].templateReceipt).toBeUndefined(); await resume(page).click(); await saved(page, state);
  expect(templatePosts(state)).toEqual([original, original]); expect(state.templateKeys.size).toBe(2); expect(state.workspace.drafts.init.template?.template_id).not.toBe(decoy.template_id); expect(draftWrites(state)).toHaveLength(1); noBusiness(state);
});

for (const unavailable of ['retired', 'material-missing'] as const) test(`M4 template known ${unavailable} creation remains recorded without adopting or creating a replacement`, async ({ page }) => {
  const state = await install(page); state.dropTemplate = 'after'; await mount(page); await pending(page, state); const request = structuredClone(templatePosts(state)[0]), template = firstTemplate(state);
  if (unavailable === 'retired') { template.status = 'retired'; template.retired_at = now; } else { state.materials.delete(pinKey(template.material)); state.workspace.templates = state.workspace.templates.filter(value => value.template_id !== template.template_id); state.workspace.materials = state.workspace.materials.filter(value => pinKey(value) !== pinKey(template.material)); state.workspace.material_details = state.workspace.material_details.filter(value => pinKey(value) !== pinKey(template.material)); }
  await refreshReadOnly(page, state); expect((await records(page))[0].value.items[0].templateReceipt).toBeUndefined(); expect(templatePosts(state)).toEqual([request]); await resume(page).click(); await expect(resume(page)).toBeEnabled(); const [record] = await records(page);
  expect(record.value.items[0].templateReceipt).toMatchObject({ template_id: template.template_id, template_version: 1 }); expect(record.value.items[0].templateAvailability).toBe('unavailable'); expect(templatePosts(state)).toEqual([request, request]); expect(state.templateKeys.size).toBe(1); expect(draftWrites(state)).toEqual([]); expect(state.workspace.drafts.init.version).toBe(3); expect(libraryWrites(state)).toHaveLength(1); expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1); noBusiness(state);
  await expect(templateSavedStatus(page)).toHaveText('模板已保存，目前不可采用，尚未确认用于原立项草稿。');
  await expect(page.locator(`#m4-template option[value="${template.template_id}:1"]`)).toHaveCount(0);
  if (unavailable === 'material-missing') {
    const selected = pinKey(template.material); expect(await page.evaluate(selected => { const workspace = (window as unknown as { m4Component: { workspace: { materials: { source_project_id: string; material_id: string; material_version: number; sha256: string }[]; material_details: { source_project_id: string; material_id: string; material_version: number; sha256: string }[] } } }).m4Component.workspace, key = (value: { source_project_id: string; material_id: string; material_version: number; sha256: string }) => [value.source_project_id, value.material_id, value.material_version, value.sha256].join(':'); return { member: workspace.materials.some(value => key(value) === selected), details: workspace.material_details.some(value => key(value) === selected) }; }, selected)).toEqual({ member: false, details: false });
    await expect(page.locator(`[data-m4-material="${selected}"]`)).toHaveCount(0); await expect(page.locator(`[data-m4-action=download-material][data-pin="${selected}"]`)).toHaveCount(0);
  }
});

test('M4 template malformed receipt cannot replace its exact original material hash or permit draft adoption', async ({ page }) => {
  const state = await install(page); state.templateResponse = value => ({ ...value, sha256: hash('Wrong receipt template hash') }); await mount(page); await pending(page, state); const original = structuredClone(templatePosts(state)[0]); await refreshReadOnly(page, state); await resume(page).click(); await expect(resume(page)).toBeEnabled();
  expect(templatePosts(state).every(request => JSON.stringify(request) === JSON.stringify(original))).toBe(true); expect(state.templateKeys.size).toBe(1); expect(draftWrites(state)).toEqual([]); expect(state.workspace.drafts.init.version).toBe(3); noBusiness(state);
});

test('M4 template known creation remains saved when the original server draft changes before adoption', async ({ page }) => {
  const state = await install(page), original = inputOf(state.workspace.drafts.init); state.afterTemplate = () => { state.workspace.drafts.init = { ...state.workspace.drafts.init, version: 4, supplemental_requirements: '服务器另一页面新增要求' }; }; await mount(page); await pending(page, state);
  expect((await records(page))[0].value.items[0].templateReceipt).toEqual(firstTemplate(state)); expect(templatePosts(state)).toHaveLength(1); expect(draftWrites(state)).toEqual([]); await expect(templateSavedStatus(page)).toHaveText('模板已保存，尚未确认用于原立项草稿。'); await refreshReadOnly(page, state); await expect(templateSavedStatus(page)).toHaveText('模板已保存，尚未确认用于原立项草稿。'); await expect(page.locator('#m4-template')).toHaveValue(`${original.template!.template_id}:${original.template!.template_version}`); noBusiness(state);
});

for (const drop of ['before', 'after'] as const) test(`M4 template draft acknowledgement lost ${drop} acceptance retains the original CAS and never repeats earlier stages`, async ({ page }) => {
  const state = await install(page), original = inputOf(state.workspace.drafts.init); state.dropDraft = drop; if (drop === 'after') state.afterDraft = () => { state.failWorkspaceReads = true; }; await mount(page); await pending(page, state); const request = structuredClone(draftWrites(state)[0]), templateRequest = structuredClone(templatePosts(state)[0]); state.failWorkspaceReads = false;
  await refreshReadOnly(page, state); if (drop === 'before') { expect(draftWrites(state)).toEqual([request]); await resume(page).click(); } await saved(page, state);
  expect(draftWrites(state)).toEqual(drop === 'before' ? [request, request] : [request]); expect(templatePosts(state)).toEqual([templateRequest]); expect(inputOf(state.workspace.drafts.init)).toEqual(expectedInput(original, state)); oneTransport(state); expect(state.templateKeys.size).toBe(1);
});

test('M4 template initial draft v0 uses the original complete input and reaches v1', async ({ page }) => {
  const state = await install(page); state.workspace.drafts.init.version = 0; const original = inputOf(state.workspace.drafts.init); await mount(page); await select(page); await saved(page, state);
  expect(draftWrites(state)).toEqual([{ expected_version: 0, input: expectedInput(original, state) }]); expect(state.workspace.drafts.init.version).toBe(1); oneTransport(state); expect(templatePosts(state)).toHaveLength(1);
});

test('M4 template captured pending requirements retain exact ordering and deduplication in the original complete effect', async ({ page }) => {
  const state = await install(page), original = inputOf(state.workspace.drafts.init), added = requirement('fourteenth-captured'); state.workspace.pending_requirements = [original.requirements[0], added]; await mount(page); await select(page); await saved(page, state);
  const sent = expectedInput(original, state); expect(draftWrites(state)).toEqual([{ expected_version: 3, input: sent }]); expect(inputOf(state.workspace.drafts.init)).toEqual({ ...sent, requirements: [...original.requirements, added] }); expect(state.workspace.pending_requirements).toEqual([]); oneTransport(state); noBusiness(state);
});

test('M4 template pending added between original GET and PUT is retained without rebasing or falsely confirming adoption', async ({ page }) => {
  const state = await install(page), added = requirement('fourteenth-new-before-put'); state.beforeDraft = () => { state.workspace.pending_requirements = [added]; }; await mount(page); await pending(page, state); const request = structuredClone(draftWrites(state)[0]);
  expect(state.workspace.drafts.init.requirements).toContainEqual(added); expect(request.input.requirements).not.toContainEqual(added); await refreshReadOnly(page, state); await resume(page).click(); await expect(resume(page)).toBeEnabled(); expect(draftWrites(state)).toEqual([request]); expect(templatePosts(state)).toHaveLength(1); expect(await records(page)).toHaveLength(1); noBusiness(state);
});

test('M4 template exact content proof with contradictory pending remains separate until a later explicit confirmation', async ({ page }) => {
  const state = await install(page), captured = requirement('fourteenth-pending-later'); state.workspace.pending_requirements = [captured]; state.afterDraft = () => { state.workspaceObservation = value => ({ ...value, pending_requirements: [captured] }); }; await mount(page); await pending(page, state);
  const request = structuredClone(draftWrites(state)[0]), templateRequest = structuredClone(templatePosts(state)[0]), proof = structuredClone(state.workspace.drafts.init); expect(proof.requirements).toContainEqual(captured); expect((await records(page))[0].value.items[0].observedDraft).toEqual(proof);
  const before = await refreshReadOnly(page, state); await expect(resume(page)).toBeEnabled(); expect((await records(page))[0].value.items[0].stage).toBe('content_satisfied_pending_unknown'); state.workspaceObservation = undefined; state.afterDraft = undefined;
  await resume(page).click(); await saved(page, state); expect(writes(state)).toHaveLength(before); expect(draftWrites(state)).toEqual([request]); expect(templatePosts(state)).toEqual([templateRequest]); expect((await legacyCache(page)).drafts.init).toEqual({ version: 4, input: inputOf(proof), dirty: false, conflict: false }); noBusiness(state);
});

test('M4 template a higher version with the same full content cannot confirm or rebase its sealed original draft', async ({ page }) => {
  const state = await install(page); state.afterDraft = () => { state.workspace.drafts.init.version++; }; await mount(page); await pending(page, state); const request = structuredClone(draftWrites(state)[0]); expect(state.workspace.drafts.init.version).toBe(5); await refreshReadOnly(page, state); await resume(page).click(); await expect(resume(page)).toBeEnabled();
  expect(draftWrites(state)).toEqual([request]); expect(templatePosts(state)).toHaveLength(1); expect(state.workspace.drafts.init.version).toBe(5); expect(await records(page)).toHaveLength(1); noBusiness(state);
});

test('M4 template a target cache edit during creation is preserved while the new template remains unadopted', async ({ page }) => {
  const state = await install(page); await mount(page); const release = await holdTemplate(page, state), changed = await cacheMutation(page, value => { value.drafts.init.input.supplemental_requirements = '另一页面在模板创建时输入的新要求'; value.drafts.init.dirty = true; }); release(); await expect(resume(page)).toBeEnabled();
  expect(await page.evaluate(key => localStorage.getItem(key), changed.key)).toBe(changed.raw); expect(templatePosts(state)).toHaveLength(1); expect(state.templateKeys.size).toBe(1); expect(draftWrites(state)).toEqual([]); await refreshReadOnly(page, state); await expect(page.locator('#m4-requirements')).toHaveValue('另一页面在模板创建时输入的新要求'); noBusiness(state);
});

test('M4 template local typing during a sent draft remains separate from the exact server adoption', async ({ page }) => {
  const state = await install(page); let release!: () => void; state.draftGate = () => new Promise<void>(resolve => { release = resolve; }); await mount(page); await select(page); await expect.poll(() => draftWrites(state).length).toBe(1);
  await page.locator('#m4-requirements').fill('本页在原模板草稿发送后输入的新要求'); const request = structuredClone(draftWrites(state)[0]); state.draftGate = undefined; release(); await settle(page); await page.clock.runFor(1_000);
  await expect(page.locator('#m4-requirements')).toHaveValue('本页在原模板草稿发送后输入的新要求'); expect(inputOf(state.workspace.drafts.init)).toEqual(request.input); expect(draftWrites(state)).toEqual([request]); expect((await legacyCache(page)).drafts.init.input.supplemental_requirements).toBe('本页在原模板草稿发送后输入的新要求'); expect(templatePosts(state)).toHaveLength(1); noBusiness(state);
});

test('M4 template cache adoption patches only the original init child and retains newer other-document and reading state', async ({ page }) => {
  const state = await install(page); await mount(page); const release = await holdTemplate(page, state), changed = await cacheMutation(page, value => { value.drafts.legal.input.supplemental_requirements = '保留另一文种的新要求'; value.drafts.legal.dirty = true; value.view.unsent_content = '保留新讨论文字'; value.view.tab_scroll = { 'artifact:other:2': 179 }; value.viewVersion = 9; value.viewDirty = true; }); release(); await saved(page, state); const current = await legacyCache(page);
  expect(current.drafts.legal).toEqual(changed.value.drafts.legal); for (const key of ['view', 'viewVersion', 'viewDirty', 'pendingMessage', 'pendingExecution']) expect(current[key]).toEqual(changed.value[key]); expect(current.drafts.init).toEqual({ version: 4, input: inputOf(state.workspace.drafts.init), dirty: false, conflict: false }); noBusiness(state);
});

for (const phase of ['creation', 'draft'] as const) test(`M4 template a pending execution arriving during ${phase} preserves the request and stops later business writes`, async ({ page }) => {
  const state = await install(page), original = inputOf(state.workspace.drafts.init); await mount(page); let release!: () => void;
  if (phase === 'creation') { release = await holdTemplate(page, state); } else {
    // Passively retain the real helper result before single-item cleanup removes its completed journal; no HTTP/result/UI behavior is replaced.
    await page.evaluate(() => { const w = window as unknown as { m4Component: { applyTemplateUploadResult(result: any, index: number): boolean }; m4TemplatePendingProof?: { result: any; applied: boolean } }, component = w.m4Component, originalApply = component.applyTemplateUploadResult; component.applyTemplateUploadResult = function(result, index) { const applied = originalApply.call(this, result, index); if (result.draft) w.m4TemplatePendingProof = { result: structuredClone(result), applied }; return applied; }; });
    state.draftGate = () => new Promise<void>(resolve => { release = resolve; }); await select(page); await expect.poll(() => draftWrites(state).length).toBe(1);
  }
  const request = execution(); await cacheMutation(page, value => { value.pendingExecution = request; }); state.draftGate = undefined; release(); if (phase === 'creation') await expect(resume(page)).toBeEnabled(); else await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { m4TemplatePendingProof?: unknown }).m4TemplatePendingProof))).toBe(true); await settle(page);
  expect((await legacyCache(page)).pendingExecution).toEqual(request); expect((await legacyCache(page)).drafts.init.input).toEqual(original); expect(draftWrites(state)).toHaveLength(phase === 'creation' ? 0 : 1); expect(templatePosts(state)).toHaveLength(1);
  if (phase === 'creation') expect((await records(page))[0].value.items[0].templateReceipt).toEqual(firstTemplate(state));
  else { const proof = await page.evaluate(() => (window as unknown as { m4TemplatePendingProof: { result: any; applied: boolean } }).m4TemplatePendingProof); expect(proof.result.envelope.items[0].templateReceipt).toEqual(firstTemplate(state)); expect(proof.result.envelope.items[0].observedDraft).toEqual(state.workspace.drafts.init); expect(proof.result.envelope.items[0].localCacheResult).toBe('preserved'); expect(proof.result.applyToPage).toBe(false); expect(proof.applied).toBe(false); expect(await records(page)).toEqual([]); }
  const before = writes(state).length; await refreshReadOnly(page, state); expect(writes(state)).toHaveLength(before); expect((await legacyCache(page)).pendingExecution).toEqual(request); noBusiness(state);
});

test('M4 template a stale refresh GET cannot roll back its later confirmed template choice or material membership', async ({ page }) => {
  const state = await install(page); await mount(page); let release!: () => void, entered = false; const gate = new Promise<void>(resolve => { release = resolve; }); state.workspaceGate = async value => { if (!entered) { entered = true; expect(value.drafts.init.version).toBe(3); await gate; } };
  await page.locator('[data-m4-action=refresh]').click(); await expect.poll(() => entered).toBe(true); await select(page); await saved(page, state, false); const proof = structuredClone(state.workspace.drafts.init), template = structuredClone(firstTemplate(state)); await expect(page.locator('#m4-template')).toHaveValue(`${template.template_id}:1`); const before = writes(state).length;
  const response = page.waitForResponse(value => value.url().includes(`/m4/topics/${ids.topic}/workspace`)); state.workspaceGate = undefined; release(); await response; await settle(page); await page.clock.runFor(1_000);
  await expect(page.locator('#m4-template')).toHaveValue(`${template.template_id}:1`); expect((await legacyCache(page)).drafts.init).toEqual({ version: 4, input: inputOf(proof), dirty: false, conflict: false }); expect(await page.evaluate(selected => (window as unknown as { m4Component: { workspace: { materials: unknown[] } } }).m4Component.workspace.materials.some(value => JSON.stringify(value) === JSON.stringify(selected)), template.material)).toBe(true); expect(writes(state)).toHaveLength(before); noBusiness(state);
});

test('M4 template local-event and old-cache-queue fault at the real final UI apply preserves durable edits without adopting the template', async ({ page }) => {
  const state = await install(page), originalInput = inputOf(state.workspace.drafts.init); await mount(page);
  // Deterministic local queue/input fault injection. All HTTP, helper results, cache snapshots and the called UI method remain real.
  await page.evaluate(() => { const w = window as unknown as { m4Component: { applyTemplateUploadResult(result: { applyToPage: boolean }, index: number): boolean; cache(): void; cacheQueue: Promise<void>; drafts: Map<string, unknown> }; m4TemplateFault?: { injected: boolean; applied?: boolean; old?: unknown } }, component = w.m4Component, original = component.applyTemplateUploadResult; w.m4TemplateFault = { injected: false }; component.applyTemplateUploadResult = function(result, index) { if (result.applyToPage && !w.m4TemplateFault!.injected) { w.m4TemplateFault!.injected = true; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), previous = this.cacheQueue; this.cacheQueue = previous.then(() => gate); w.m4TemplateFault!.old = structuredClone(this.drafts.get('init')); this.cache(); const input = document.querySelector<HTMLTextAreaElement>('#m4-requirements')!; input.value = '模板最终采用前的本页新要求必须可靠保留'; input.dispatchEvent(new Event('input', { bubbles: true })); try { const applied = original.call(this, result, index); w.m4TemplateFault!.applied = applied; return applied; } finally { release(); } } return original.call(this, result, index); }; });
  await select(page); await expect.poll(() => page.evaluate(() => (window as unknown as { m4TemplateFault?: { injected: boolean } }).m4TemplateFault?.injected)).toBe(true); await settle(page); await page.clock.runFor(1_000); await settle(page);
  const fault = await page.evaluate(() => (window as unknown as { m4TemplateFault: { injected: boolean; applied?: boolean; old?: unknown } }).m4TemplateFault); expect(fault.old).toEqual({ version: 3, input: originalInput, dirty: false, conflict: false }); expect(fault.applied).toBe(false);
  await expect(page.locator('#m4-requirements')).toHaveValue('模板最终采用前的本页新要求必须可靠保留'); const local = (await legacyCache(page)).drafts.init; expect(local.input).toEqual({ ...originalInput, supplemental_requirements: '模板最终采用前的本页新要求必须可靠保留' }); expect(local.dirty).toBe(true); expect(local.conflict).toBe(true); expect(state.workspace.drafts.init.version).toBe(4); expect(state.workspace.drafts.init.supplemental_requirements).toBe(originalInput.supplemental_requirements); expect(templatePosts(state)).toHaveLength(1); expect(draftWrites(state)).toHaveLength(1); oneTransport(state); noBusiness(state);
});

for (const purpose of ['source', 'material'] as const) test(`M4 template and ${purpose} prepare compete under one topic lock and cannot establish two durable batches`, async ({ page }) => {
  const state = await install(page); await mount(page); const other = await page.context().newPage(); await install(other, state); await mount(other); await settle(page); await settle(other); const before = writes(state).length;
  // Call the two real component-owned helpers concurrently to exercise the locked prepare guard beyond disabled controls.
  const results = await Promise.all([
    page.evaluate(async () => { const component = (window as unknown as { m4Component: { m4TemplateUploads: { prepare(declaration: unknown): Promise<unknown> } } }).m4Component; try { await component.m4TemplateUploads.prepare({ filename: '原并发模板.docx', media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', byte_size: 7, sha256: 'a'.repeat(64), role: 'other' }); return 'prepared'; } catch { return 'blocked'; } }),
    other.evaluate(async purpose => { const component = (window as unknown as { m4Component: { m4Uploads: { prepare(declarations: unknown[], purpose: string, type: string): Promise<unknown> } } }).m4Component; try { await component.m4Uploads.prepare([{ filename: '另一页面原材料.docx', media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', byte_size: 8, sha256: 'b'.repeat(64), role: purpose === 'source' ? 'historical' : 'other' }], purpose, 'private_summary'); return 'prepared'; } catch { return 'blocked'; } }, purpose)
  ]);
  expect(results.sort()).toEqual(['blocked', 'prepared']); const count = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('bb-m4-upload-v1:') || key.startsWith('bb-m4-template-upload-v1:')).length); expect(count).toBe(1); expect(writes(state)).toHaveLength(before); expect(templatePosts(state)).toEqual([]); noBusiness(state); await other.close();
});

test('M4 template unresolved operation blocks source and material selection, autosave and task actions while keeping local editing', async ({ page }) => {
  const state = await install(page); state.dropTemplate = 'after'; await mount(page); await pending(page, state); const before = writes(state).length; await expect(page.locator('[data-m4-upload=source]')).toBeDisabled(); for (const input of await page.locator('[data-m4-upload=material]').all()) await expect(input).toBeDisabled();
  await page.locator('#m4-requirements').fill('模板待办期间保留本页输入'); await page.evaluate(async () => { const component = (window as unknown as { m4Component: { flush(): Promise<boolean>; execute(entry: string): Promise<void>; beforeLeave(): Promise<boolean> } }).m4Component; await component.flush(); await component.execute('workspace'); await component.beforeLeave(); }); await page.clock.runFor(1_000); expect(writes(state)).toHaveLength(before); await expect(page.locator('#m4-requirements')).toHaveValue('模板待办期间保留本页输入');
  await refreshReadOnly(page, state); expect((await legacyCache(page)).drafts.init.input.supplemental_requirements).toBe('模板待办期间保留本页输入'); expect(draftWrites(state)).toEqual([]); noBusiness(state);
});

test('M4 template original file reselect rejects changed bytes and replaces only the sealed original declaration', async ({ page }) => {
  const state = await install(page); state.dropPut = 'before'; state.sessionLifetimeMs = 10_000; await mount(page); await pending(page, state); await refreshReadOnly(page, state); const reselect = recovery(page).locator('[data-m4-template-recovery-reselect]'); await expect(reselect).toBeAttached(); await expect(resume(page)).toBeEnabled();
  const before = writes(state).length, record = (await records(page))[0], original = structuredClone(record.value.items[0].declaration), upload = [...state.uploads.keys()][0]; await reselect.setInputFiles({ ...templateFile, buffer: Buffer.from('x'.repeat(templateFile.buffer.length)) }); await expect(resume(page)).toBeEnabled();
  // Explicit original-file selection verifies the hash before any old-complete request.
  expect(writes(state).slice(before)).toEqual([]); expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1); expect(templatePosts(state)).toEqual([]); expect((await records(page))[0].value.items[0].declaration).toEqual(original);
  expect((await records(page))[0].value.id).toBe(record.value.id); expect(libraryWrites(state)).toEqual([]); expect(draftWrites(state)).toEqual([]);
  await reselect.setInputFiles(templateFile); await saved(page, state);
  expect(writes(state).slice(before, before + 1)).toEqual([{ method: 'POST', path: `/projects/${ids.project}/materials/uploads/${upload}/complete`, search: '', body: { byte_size: original.byte_size, sha256: original.sha256 } }]);
  expect(uploads(state, 'create')).toHaveLength(2); expect(uploads(state, 'bytes')).toHaveLength(2); expect(uploads(state, 'create')[1].body).toEqual(uploads(state, 'create')[0].body); expect(templatePosts(state)).toHaveLength(1); expect(draftWrites(state)).toHaveLength(1);
});

test('M4 template late transport response after account disposal cannot reveal the filename or continue the original business', async ({ page }) => {
  const state = await install(page); let release!: () => void; state.completeGate = () => new Promise<void>(resolve => { release = resolve; }); await mount(page); await select(page); await expect.poll(() => uploads(state, 'complete').length).toBe(1); state.owner = ids.otherOwner; await mount(page, { navigation: 'same-page', owner: ids.otherOwner }); release(); await page.clock.runFor(1_000);
  await expect(page.locator('body')).not.toContainText(templateFile.name); expect(libraryWrites(state)).toEqual([]); expect(templatePosts(state)).toEqual([]); expect(draftWrites(state)).toEqual([]); expect((await records(page))[0].value.owner).toBe(ids.owner); noBusiness(state);
});

test('M4 template declaration storage failure prevents all four server stages and view writes', async ({ page }) => {
  const state = await install(page); await mount(page); await page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.startsWith('bb-m4-template-upload-v1:')) throw new DOMException('Synthetic quota', 'QuotaExceededError'); return original.call(this, key, value); }; }); await select(page); await expect(page.locator('#m4-status')).toContainText(/保存|记录|本机|浏览器/); await page.clock.runFor(1_000);
  expect(writes(state)).toEqual([]); expect(await records(page)).toEqual([]); noBusiness(state);
});

test('M4 template cleanup failure retries only local cleanup after every server stage is known', async ({ page }) => {
  const state = await install(page); await mount(page); await page.evaluate(() => { const w = window as unknown as { failTemplateCleanup: boolean }; w.failTemplateCleanup = true; const original = Storage.prototype.removeItem; Storage.prototype.removeItem = function(key) { if (w.failTemplateCleanup && key.startsWith('bondbuddy:upload-recovery:v1:') && key.includes(':m4-template-upload:')) throw new DOMException('Synthetic cleanup failure'); return original.call(this, key); }; }); await select(page); await expect(resume(page)).toBeEnabled();
  expect(state.workspace.drafts.init.version).toBe(4); expect(templatePosts(state)).toHaveLength(1); expect(draftWrites(state)).toHaveLength(1); await expect(templateSavedStatus(page)).toHaveText('模板与服务器原立项草稿已保存。'); const before = writes(state).length; await page.evaluate(() => { (window as unknown as { failTemplateCleanup: boolean }).failTemplateCleanup = false; }); await resume(page).click(); await saved(page, state); expect(writes(state)).toHaveLength(before); oneTransport(state); expect(state.templateKeys.size).toBe(1);
});

test('M4 template missing core record fails closed rather than assigning a new upload or creation key', async ({ page }) => {
  const state = await install(page); state.dropPut = 'after'; await mount(page); await pending(page, state); await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('bondbuddy:upload-recovery:v1:') && key.includes(':m4-template-upload:')) localStorage.removeItem(key); }); await refreshReadOnly(page, state); const before = writes(state).length; await resume(page).click(); await expect(resume(page)).toBeEnabled();
  expect(writes(state)).toHaveLength(before); expect(uploads(state, 'create')).toHaveLength(1); expect(templatePosts(state)).toEqual([]); expect(draftWrites(state)).toEqual([]); expect(await records(page)).toHaveLength(1); noBusiness(state);
});

test('M4 template removed business journal during transport is never recreated from component memory', async ({ page }) => {
  const state = await install(page); let release!: () => void; state.completeGate = () => new Promise<void>(resolve => { release = resolve; }); await mount(page); await select(page); await expect.poll(() => uploads(state, 'complete').length).toBe(1); const [record] = await records(page); await page.evaluate(key => { localStorage.removeItem(key); dispatchEvent(new StorageEvent('storage', { key, newValue: null })); }, record.key); release(); await page.clock.runFor(1_000); await settle(page);
  expect(await records(page)).toEqual([]); expect(libraryWrites(state)).toEqual([]); expect(templatePosts(state)).toEqual([]); expect(draftWrites(state)).toEqual([]); await refreshReadOnly(page, state); expect(await records(page)).toEqual([]); expect(uploads(state, 'create')).toHaveLength(1); noBusiness(state);
});

test('M4 template stopping a known but unadopted operation removes only local work and preserves saved server objects', async ({ page }) => {
  const state = await install(page); state.afterTemplate = () => { state.workspace.drafts.init.version++; }; await mount(page); await pending(page, state); const material = structuredClone([...state.uploads.values()][0].material!), template = structuredClone(firstTemplate(state)), draft = structuredClone(state.workspace.drafts.init), before = writes(state).length;
  await recovery(page).locator('[data-m4-template-recovery-remove]').click(); await expect.poll(async () => (await records(page)).length).toBe(0); expect(writes(state)).toHaveLength(before); expect(state.materials.get(pinKey(pin(material)))).toEqual(material); expect(firstTemplate(state)).toEqual(template); expect(state.workspace.drafts.init).toEqual(draft); expect(draftWrites(state)).toEqual([]); noBusiness(state);
});

test('M4 template an unavailable original topic after transport cannot redirect membership or template creation', async ({ page }) => {
  const state = await install(page); let release!: () => void; state.completeGate = () => new Promise<void>(resolve => { release = resolve; }); await mount(page); await select(page); await expect.poll(() => uploads(state, 'complete').length).toBe(1); state.unavailableTopic = true; release(); await expect(resume(page)).toBeEnabled(); const before = writes(state).length; await resume(page).click(); await expect(resume(page)).toBeEnabled();
  expect(writes(state)).toHaveLength(before); expect(libraryWrites(state)).toEqual([]); expect(templatePosts(state)).toEqual([]); expect(draftWrites(state)).toEqual([]); expect(await records(page)).toHaveLength(1); noBusiness(state);
});

async function templateRegion(page: Page) { const region = page.locator('section.form-card').filter({ has: page.locator('[data-m4-upload=template]') }); await expect(region).toHaveCount(1); await region.evaluate(value => value.scrollIntoView({ block: 'start' })); }
async function capture(page: Page, state: State, directory: string, flavor: string, label: string, width: number) {
  const filename = `m4-template-fourteenth-${flavor}-${label}-${width}.png`, bytes = await page.screenshot({ path: join(directory, filename), fullPage: false });
  const geometry = await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight }, overflow: document.documentElement.scrollWidth > innerWidth + 1, text: document.body.innerText, template_saved_status: [...document.querySelectorAll('[data-m4-template-saved-status]')].map(value => value.textContent), template_recovery_feedback: [...document.querySelectorAll('[data-m4-template-recovery-id] p.m4-status')].map(value => value.textContent), page_status: document.querySelector('#m4-status')?.textContent ?? '', draft_conflict_feedback: [...document.querySelectorAll('[data-m4-action=resolve-draft]')].map(value => value.parentElement?.textContent ?? ''), regions: [...document.querySelectorAll('[data-m4-drop=template],[data-m4-template-recovery-id],#m4-template-region')].map(value => { const rect = value.getBoundingClientRect(); return { selector: value.id || value.getAttribute('data-m4-drop') || 'template-recovery', x: rect.x, y: rect.y, width: rect.width, height: rect.height }; }) })); expect(geometry.overflow).toBe(false);
  const value = { filename, screenshot_sha256: hash(bytes), kind: 'viewport', state: label, scope: 'Actual MaterialWorkspace and global CSS; strict synthetic public HTTP. No production object-store, DOCX quality or human signoff.', ...geometry, template_posts: templatePosts(state).length, templates_created: state.templateKeys.size, total_http_writes: writes(state).length };
  await writeFile(join(directory, filename.replace('.png', '.json')), JSON.stringify(value, null, 2)); return value;
}
for (const width of [1440, 390]) test(`m4 template component comparison at ${width}`, async ({ page }) => {
  const directory = process.env.BB_M4_TEMPLATE_FOURTEENTH_EVIDENCE_DIR ?? process.env.BB_FOURTEENTH_EVIDENCE_DIR; test.skip(!directory, 'Explicit fourteenth evidence directory is required'); await mkdir(directory!, { recursive: true });
  const reference = process.env.BB_FOURTEENTH_REFERENCE === '1', finish = reference ? await installFourteenthReference(page) : undefined, flavor = reference ? 'reference' : 'implementation', state = await install(page); await page.setViewportSize({ width, height: 960 }); await mount(page); const captured = [];
  await templateRegion(page); captured.push(await capture(page, state, directory!, flavor, 'ready', width)); state.dropTemplate = 'after'; await select(page);
  if (reference) await expect(page.locator('[data-m4-action=retry-upload]')).toBeEnabled(); else await expect(resume(page)).toBeEnabled(); expect(templatePosts(state)).toHaveLength(1); expect(state.templateKeys.size).toBe(1); expect(draftWrites(state)).toEqual([]); await templateRegion(page); captured.push(await capture(page, state, directory!, flavor, 'pending', width));
  const beforeRefresh = writes(state).length; await refreshReadOnly(page, state); const afterRefresh = writes(state).length; if (reference) await expect(page.locator('[data-m4-action=retry-upload]')).toHaveCount(0); else { await expect(resume(page)).toBeEnabled(); expect((await records(page))[0].value.items[0].templateReceipt).toBeUndefined(); } await templateRegion(page); captured.push(await capture(page, state, directory!, flavor, 'refreshed', width));
  // The fourth image is a new explicit operation after stopping the first local one. Its real template receipt is known, but a concurrent server draft prevents adoption.
  if (!reference) { await recovery(page).locator('[data-m4-template-recovery-remove]').click(); await expect.poll(async () => (await records(page)).length).toBe(0); }
  state.dedupMaterial = [...state.uploads.values()][0].material; state.afterTemplate = () => { state.workspace.drafts.init = { ...state.workspace.drafts.init, version: state.workspace.drafts.init.version + 1, supplemental_requirements: '服务器已保存的新立项要求，原模板尚未采用' }; }; await select(page);
  if (reference) {
    await expect.poll(() => state.templateKeys.size).toBe(2); await settle(page);
    // Exact R13 returns from a failed draft flush without setting row.error, so no upload-retry button exists here.
    await expect(page.locator('[data-m4-action=resolve-draft]')).toBeVisible(); await expect(page.locator('#m4-status')).toContainText('这个项目已在其他页面修改。你的输入仍保留，请查看最新版本后再修改。'); await expect(page.locator('[data-m4-action=retry-upload]')).toHaveCount(0);
  } else {
    await expect(resume(page)).toBeEnabled(); expect((await records(page))[0].value.items[0].templateReceipt).toMatchObject({ template_id: [...state.templateKeys.values()][1].template.template_id }); await expect(templateSavedStatus(page)).toHaveText('模板已保存，尚未确认用于原立项草稿。');
  }
  expect(templatePosts(state)).toHaveLength(2); expect(state.templateKeys.size).toBe(2); expect(state.workspace.drafts.init.template).not.toEqual(referenceOf([...state.templateKeys.values()][1].template)); await templateRegion(page); captured.push(await capture(page, state, directory!, flavor, 'template-known-not-adopted', width));
  await writeFile(join(directory!, `m4-template-fourteenth-${flavor}-comparison-${width}.json`), JSON.stringify({ reference, source: finish ? await finish() : { scope: 'Current R14 implementation; no approved new prototype or human signoff.' }, records: captured, refresh_write_window: { before: beforeRefresh, after: afterRefresh, added: afterRefresh - beforeRefresh }, template_posts: templatePosts(state).length, templates_created: state.templateKeys.size, original_upload_creates: uploads(state, 'create').length, original_puts: uploads(state, 'bytes').length, library_posts: libraryWrites(state).length, draft_puts: draftWrites(state).length, errors: state.errors, unexpected_requests: state.unexpected }, null, 2)); noBusiness(state);
});
