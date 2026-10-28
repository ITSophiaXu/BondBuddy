import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyUpdateDetails } from '@bondbuddy/contracts';
import { installTwelfthReference } from './upload-twelfth-reference';
import { install, mount, ids, now, file, secondFile, hash, inputOf, pin, writes, uploads, draftWrites, noBusiness, recovery, records, selectEvidence, type State } from './review-upload-twelfth-fixtures';

const resume = (page: Page, filename = file.name) => recovery(page, filename).locator('[data-review-recovery-action=resume]');
async function pending(page: Page, state: State, kind: 'material' | 'evidence' = 'material') {
  if (kind === 'evidence') await selectEvidence(page); else await page.locator('[data-review-upload-role=audit]').setInputFiles(file);
  await expect(resume(page)).toBeEnabled(); expect(await records(page)).toHaveLength(1); noBusiness(state);
}
async function refreshReadOnly(page: Page, state: State, options: { report?: string } = {}) {
  const before = writes(state).length; await mount(page, { navigation: 'reload', report: options.report });
  // Both the 650ms input timer and return-to-page listeners must remain read-only.
  await page.clock.runFor(1_000); await page.evaluate(() => { dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(1_000); expect(writes(state)).toHaveLength(before); noBusiness(state); return before;
}
async function saved(page: Page, state: State, materialCount = 3) {
  await expect.poll(() => state.draft.material_versions.length).toBe(materialCount); await expect.poll(async () => (await records(page)).length).toBe(0); noBusiness(state);
}

for (const kind of ['material', 'evidence'] as const) test(`review ${kind} normal upload saves one complete draft in the original action without starting a task`, async ({ page }) => {
  const state = await install(page), original = inputOf(state.draft); await mount(page);
  if (kind === 'evidence') await selectEvidence(page); else await page.locator('[data-review-upload-role=audit]').setInputFiles(file);
  await saved(page, state); expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1); expect(uploads(state, 'complete')).toHaveLength(1); expect(draftWrites(state)).toHaveLength(1);
  const material = [...state.uploads.values()][0].material!, expected = { ...original, material_versions: [...original.material_versions, pin(material)], evidence_links: [...original.evidence_links ?? [], ...(kind === 'evidence' ? [{ report_id: ids.report, finding_id: ids.finding, material_ref: pin(material) }] : [])] };
  expect(draftWrites(state)[0]).toEqual({ kind: 'input', expected_version: 3, input: expected }); expect(inputOf(state.draft)).toEqual(expected);
  expect(state.calls.filter(call => call.method === 'GET' && call.path.endsWith('/review-draft')).length).toBeGreaterThan(0);
  if (kind === 'evidence') await expect(page.getByRole('dialog', { name: '材料已补充，核对下一步' }).getByRole('button', { name: '核对并重新核验', exact: true })).toBeEnabled();
});

test('first upload from draft version zero preserves UI-derived existing materials and the project reporting cutoff', async ({ page }) => {
  const state = await install(page), existing = [...state.materials.values()].map(pin); state.draft = { version: 0, source_material_ref: null, material_versions: [], requirements: [], as_of: null, evidence_links: [] };
  state.project.update_details = { ...emptyUpdateDetails(), reporting_cutoff: '2026-09-30' }; await mount(page); await page.locator('[data-review-upload-role=audit]').setInputFiles(file); await saved(page, state);
  const material = [...state.uploads.values()][0].material!; expect(inputOf(state.draft)).toEqual({ source_material_ref: null, material_versions: [...existing, pin(material)], requirements: [], as_of: '2026-09-30', evidence_links: [] });
  expect(draftWrites(state).length).toBeGreaterThanOrEqual(1); expect(draftWrites(state).length).toBeLessThanOrEqual(2); expect(draftWrites(state).at(-1)!.input).toEqual(inputOf(state.draft));
  expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1); noBusiness(state);
});

for (const kind of ['material', 'evidence'] as const) for (const width of [1440, 390]) test(`review ${kind} restores original upload and full draft only after explicit confirmation at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 960 }); const state = await install(page), original = inputOf(state.draft);
  if (kind === 'material') state.dropPut = 'after'; else state.dropComplete = true; await mount(page); await pending(page, state, kind);
  if (kind === 'evidence') {
    const dialog = page.getByRole('dialog', { name: '为此问题补充材料' }), progress = dialog.locator('#review-upload-progress');
    await expect(progress).toContainText('原文件保存结果待确认'); await expect(progress).not.toContainText('正在上传');
    await expect(dialog.getByRole('button', { name: '上传并保存', exact: true })).toHaveCount(0);
    const beforeReturn = writes(state).length; await dialog.locator('[data-review-upload-return]').click();
    await expect(dialog).not.toBeVisible(); await expect(page.locator('#review-tab-materials')).toHaveAttribute('aria-selected', 'true');
    await expect(recovery(page)).toBeInViewport(); await expect(resume(page)).toBeFocused();
    await page.clock.runFor(1_000); expect(writes(state)).toHaveLength(beforeReturn); noBusiness(state);
  }
  const uploadId = [...state.uploads.keys()][0]; expect(draftWrites(state)).toHaveLength(0); const before = await refreshReadOnly(page, state, { report: kind === 'evidence' ? ids.otherReport : undefined });
  await expect(recovery(page)).toContainText(file.name); if (kind === 'evidence') await expect(recovery(page)).toContainText(/报告\s*R1/);
  expect(writes(state)).toHaveLength(before); await resume(page).click(); await saved(page, state);
  expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1); expect(uploads(state, 'complete').every(call => call.path.includes('/' + uploadId + '/complete'))).toBe(true);
  expect(draftWrites(state)).toHaveLength(1); const request = draftWrites(state)[0], material = state.uploads.get(uploadId)!.material!;
  expect(request.expected_version).toBe(3); expect(request.input).toEqual({ ...original, material_versions: [...original.material_versions, pin(material)], evidence_links: [...original.evidence_links ?? [], ...(kind === 'evidence' ? [{ report_id: ids.report, finding_id: ids.finding, material_ref: pin(material) }] : [])] });
  if (kind === 'evidence') expect(request.input.evidence_links!.filter(link => link.material_ref.material_id === material.material_id).map(link => link.report_id)).toEqual([ids.report]); noBusiness(state);
});

test('lost draft acknowledgement is confirmed only by exact v+1 and the whole input, without another upload or adoption PUT', async ({ page }) => {
  const state = await install(page); state.dropDraft = 'after'; state.afterDraft = () => { state.failDraftReads = true; }; await mount(page); await pending(page, state);
  expect(draftWrites(state)).toHaveLength(1); const request = structuredClone(draftWrites(state)[0]); expect(state.draft.version).toBe(request.expected_version + 1);
  state.failDraftReads = false; await refreshReadOnly(page, state); await saved(page, state);
  expect(draftWrites(state)).toEqual([request]); expect(inputOf(state.draft)).toEqual(request.input); expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1);
});

test('v plus unchanged base retains a sealed full CAS and retries that exact request only on explicit confirmation', async ({ page }) => {
  const state = await install(page); state.dropDraft = 'before'; await mount(page); await pending(page, state); expect(draftWrites(state)).toHaveLength(1);
  const request = structuredClone(draftWrites(state)[0]); expect(state.draft.version).toBe(3); const before = await refreshReadOnly(page, state); expect(writes(state)).toHaveLength(before);
  await expect(resume(page)).toContainText('原草稿'); await resume(page).click();
  await saved(page, state); expect(draftWrites(state)).toEqual([request, request]); expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1);
});

for (const observation of ['higher-same-input', 'next-different-input'] as const) test(`draft observation ${observation} cannot falsely confirm or rebase the sealed adoption`, async ({ page }) => {
  const state = await install(page); state.dropDraft = 'after'; state.afterDraft = request => { if (observation === 'higher-same-input') state.draft.version = request.expected_version + 2; else state.draft.requirements = [...state.draft.requirements, '其他页面新增加的要求。']; };
  await mount(page); await pending(page, state); const request = structuredClone(draftWrites(state)[0]), observed = structuredClone(state.draft); expect(await records(page)).toHaveLength(1);
  await refreshReadOnly(page, state); await resume(page).click(); await expect(resume(page)).toBeEnabled(); expect(state.draft).toEqual(observed); expect(draftWrites(state)).toEqual([request]); expect(await records(page)).toHaveLength(1); noBusiness(state);
});

for (const targetFailure of ['inaccessible-report', 'missing-original-finding'] as const) test(`original evidence target ${targetFailure} stays unresolved and never moves to the selected report`, async ({ page }) => {
  const state = await install(page); state.dropComplete = true; await mount(page); await pending(page, state, 'evidence');
  if (targetFailure === 'inaccessible-report') state.unavailableReports.add(ids.report); else state.reports.get(ids.report)!.findings = [];
  const original = structuredClone(state.draft); await refreshReadOnly(page, state, { report: ids.otherReport }); await resume(page).click(); await expect(resume(page)).toBeEnabled();
  expect(state.draft).toEqual(original); expect(draftWrites(state)).toHaveLength(0); expect(await records(page)).toHaveLength(1); expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1); noBusiness(state);
});

test('ordered batch preserves its adopted first item and resumes the second from the verified prior full draft', async ({ page }) => {
  const state = await install(page), original = inputOf(state.draft); state.dropCompleteAt = 2; await mount(page); await page.locator('[data-review-upload-role=audit]').setInputFiles([file, secondFile]);
  await expect(resume(page, secondFile.name)).toBeEnabled(); expect(draftWrites(state)).toHaveLength(1); expect(state.draft.version).toBe(4); const first = structuredClone(draftWrites(state)[0]);
  await refreshReadOnly(page, state); await resume(page, secondFile.name).click(); await saved(page, state, 4);
  expect(uploads(state, 'create')).toHaveLength(2); expect(uploads(state, 'bytes')).toHaveLength(2); expect(draftWrites(state)).toHaveLength(2); expect(draftWrites(state)[0]).toEqual(first);
  const second = draftWrites(state)[1]; expect(second.expected_version).toBe(4); expect(second.input.requirements).toEqual(original.requirements); expect(second.input.evidence_links).toEqual(original.evidence_links); expect(second.input.material_versions.slice(0, 3)).toEqual(first.input.material_versions); noBusiness(state);
});

test('an explicit same-file reselect validates bytes before replacing an original upload that never received them', async ({ page }) => {
  const state = await install(page); state.dropPut = 'before'; await mount(page); await pending(page, state); await refreshReadOnly(page, state); await resume(page).click();
  const reselect = recovery(page).locator('[data-review-recovery-reselect]'); await expect(reselect).toBeAttached();
  await reselect.setInputFiles({ ...file, buffer: Buffer.from('x'.repeat(file.buffer.length)) }); await expect(recovery(page).locator('[role=alert]')).toContainText('上传恢复记录发生冲突'); await expect(resume(page)).toBeEnabled(); await expect(reselect).toBeEnabled(); expect(uploads(state, 'create')).toHaveLength(1); expect(draftWrites(state)).toHaveLength(0);
  await reselect.setInputFiles(file); await saved(page, state); expect(uploads(state, 'create')).toHaveLength(2); expect(uploads(state, 'bytes')).toHaveLength(2); expect(draftWrites(state)).toHaveLength(1);
  expect(uploads(state, 'create').map(call => call.body)).toEqual([uploads(state, 'create')[0].body, uploads(state, 'create')[0].body]);
});

test('a different local cached draft is preserved while the saved file remains unadopted', async ({ page }) => {
  const state = await install(page); let release!: () => void; state.completeGate = () => new Promise<void>(resolve => { release = resolve; }); await mount(page); await page.locator('[data-review-upload-role=audit]').setInputFiles(file);
  await expect.poll(() => uploads(state, 'complete').length).toBe(1); const cache = JSON.stringify({ owner: ids.owner, project_id: ids.project, version: 3, input: { ...inputOf(state.draft), requirements: ['另一页面尚未保存的新要求。'] } });
  await page.evaluate(({ key, raw }) => { localStorage.setItem(key, raw); dispatchEvent(new StorageEvent('storage', { key, newValue: raw })); }, { key: `bb-review-input:${ids.owner}:${ids.project}`, raw: cache });
  state.completeGate = undefined; release(); await expect(resume(page)).toBeEnabled(); expect(draftWrites(state)).toHaveLength(0); expect(await page.evaluate(key => localStorage.getItem(key), `bb-review-input:${ids.owner}:${ids.project}`)).toBe(cache); noBusiness(state);
});

test('a concurrent server draft is retained and the original upload never rebases over it', async ({ page }) => {
  const state = await install(page), original = inputOf(state.draft); let release!: () => void; state.completeGate = () => new Promise<void>(resolve => { release = resolve; }); await mount(page); await page.locator('[data-review-upload-role=audit]').setInputFiles(file);
  await expect.poll(() => uploads(state, 'complete').length).toBe(1); state.draft = { ...original, version: 4, requirements: ['服务器另一页面已保存的新要求。'] }; const concurrent = structuredClone(state.draft); state.completeGate = undefined; release(); await expect(resume(page)).toBeEnabled();
  expect(state.draft).toEqual(concurrent); expect(draftWrites(state).every(request => request.expected_version === 3 && JSON.stringify(request.input.requirements) === JSON.stringify(original.requirements))).toBe(true); expect(draftWrites(state).length).toBeLessThanOrEqual(1);
  await refreshReadOnly(page, state); expect(state.draft).toEqual(concurrent); noBusiness(state);
});

test('a late complete response from the disposed owner cannot expose the filename or adopt into another account', async ({ page }) => {
  const state = await install(page); let release!: () => void; state.completeGate = () => new Promise<void>(resolve => { release = resolve; }); await mount(page); await page.locator('[data-review-upload-role=audit]').setInputFiles(file);
  await expect.poll(() => uploads(state, 'complete').length).toBe(1); state.owner = ids.otherOwner; await mount(page, { navigation: 'same-page', owner: ids.otherOwner }); state.completeGate = undefined; release(); await page.clock.runFor(1_000);
  await expect(page.locator('body')).not.toContainText(file.name); expect(draftWrites(state)).toHaveLength(0); expect(uploads(state, 'create')).toHaveLength(1); expect((await records(page))[0].value.owner).toBe(ids.owner); noBusiness(state);
});

test('missing business record during upload is never reconstructed from the component snapshot', async ({ page }) => {
  const state = await install(page); let release!: () => void; state.completeGate = () => new Promise<void>(resolve => { release = resolve; }); await mount(page); await page.locator('[data-review-upload-role=audit]').setInputFiles(file);
  await expect.poll(() => uploads(state, 'complete').length).toBe(1); const [record] = await records(page); await page.evaluate(key => { localStorage.removeItem(key); dispatchEvent(new StorageEvent('storage', { key, newValue: null })); }, record.key);
  state.completeGate = undefined; release(); await page.clock.runFor(1_000); expect(await records(page)).toHaveLength(0); expect(draftWrites(state)).toHaveLength(0); expect(uploads(state, 'create')).toHaveLength(1);
  await refreshReadOnly(page, state); expect(await records(page)).toHaveLength(0); expect(draftWrites(state)).toHaveLength(0); await expect(page.locator('[data-review-recovery-action=resume]')).toHaveCount(0); noBusiness(state);
});

test('a missing core record cannot turn the explicit business recovery action into another upload', async ({ page }) => {
  const state = await install(page); state.dropPut = 'after'; await mount(page); await pending(page, state);
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('bondbuddy:upload-recovery:v1:') && key.includes(':review-upload:')) localStorage.removeItem(key); });
  await refreshReadOnly(page, state); const before = writes(state).length; await resume(page).click(); await expect(resume(page)).toBeEnabled();
  expect(writes(state)).toHaveLength(before); expect(draftWrites(state)).toHaveLength(0); expect(uploads(state, 'create')).toHaveLength(1); expect(await records(page)).toHaveLength(1); noBusiness(state);
});

test('pending recovery blocks delayed input autosave and beforeLeave writes while retaining newly typed requirements', async ({ page }) => {
  const state = await install(page); state.dropComplete = true; await mount(page); await pending(page, state); const before = writes(state).length;
  await page.locator('#review-requirements').fill('本页新增要求应保留，不能覆盖原上传草稿。'); await page.clock.runFor(1_000);
  await page.evaluate(async () => { await (window as unknown as { reviewComponent: { beforeLeave(): Promise<boolean> } }).reviewComponent.beforeLeave(); }); expect(writes(state)).toHaveLength(before);
  await refreshReadOnly(page, state); await expect(page.locator('#review-requirements')).toHaveValue('本页新增要求应保留，不能覆盖原上传草稿。'); expect(draftWrites(state)).toHaveLength(0); noBusiness(state);
});

test('browser storage failure before the declaration is durable prevents all upload and draft writes', async ({ page }) => {
  const state = await install(page); await mount(page); await page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.startsWith('bb-review-upload-v1:')) throw new DOMException('Synthetic quota', 'QuotaExceededError'); return original.call(this, key, value); }; });
  await page.locator('[data-review-upload-role=audit]').setInputFiles(file); await expect(page.locator('#review-status')).toContainText(/保存|记录|本机/); await page.clock.runFor(1_000); expect(writes(state)).toEqual([]); noBusiness(state);
});

test('confirmed adoption with failed local cleanup retries only cleanup and never retransfers or saves the draft again', async ({ page }) => {
  const state = await install(page); await mount(page); await page.evaluate(() => { const w = window as unknown as { failReviewCleanup: boolean }; w.failReviewCleanup = true; const original = Storage.prototype.removeItem; Storage.prototype.removeItem = function(key) { if (w.failReviewCleanup && key.startsWith('bondbuddy:upload-recovery:v1:') && key.includes(':review-upload:')) throw new DOMException('Synthetic cleanup failure'); return original.call(this, key); }; });
  await page.locator('[data-review-upload-role=audit]').setInputFiles(file); await expect(resume(page)).toBeEnabled(); expect(state.draft.version).toBe(4); expect(draftWrites(state)).toHaveLength(1); const before = writes(state).length;
  await page.evaluate(() => { (window as unknown as { failReviewCleanup: boolean }).failReviewCleanup = false; }); await resume(page).click(); await saved(page, state); expect(writes(state)).toHaveLength(before); expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1); expect(draftWrites(state)).toHaveLength(1);
});

test('legal older-upload deduplication saves the accurate material pin while preserving the existing source and evidence', async ({ page }) => {
  const state = await install(page), original = inputOf(state.draft); state.dedupMaterial = { material_id: 'review-twelfth-dedup', material_version: 2, upload_id: 'legal-older-upload', filename: '此前材料名.pdf', media_type: 'application/pdf', byte_size: file.buffer.length, sha256: hash(file.buffer), role: 'audit', state: 'persisted', persisted_at: now, error: null };
  await mount(page); await page.locator('[data-review-upload-role=audit]').setInputFiles(file); await saved(page, state);
  expect(state.draft.source_material_ref).toEqual(original.source_material_ref); expect(state.draft.evidence_links).toEqual(original.evidence_links); expect(state.draft.material_versions).toContainEqual(pin(state.dedupMaterial)); expect(draftWrites(state)).toHaveLength(1); noBusiness(state);
});

test('replacing a selected material version cannot silently discard the older source or evidence links', async ({ page }) => {
  const state = await install(page), original = structuredClone(state.draft), old = state.materials.get('review-twelfth-old-evidence')!;
  state.dedupMaterial = { ...old, material_version: 2, upload_id: 'legal-other-version-upload', byte_size: file.buffer.length, sha256: hash(file.buffer), filename: file.name };
  await mount(page); await page.locator('[data-review-upload-role=audit]').setInputFiles(file); await expect(resume(page)).toBeEnabled(); expect(state.draft).toEqual(original); expect(draftWrites(state)).toHaveLength(0); expect(await records(page)).toHaveLength(1); noBusiness(state);
});

test('a historical upload adopts the new source only when the original saved source was empty', async ({ page }) => {
  const state = await install(page); state.draft.source_material_ref = null; const original = inputOf(state.draft); await mount(page); await page.locator('[data-review-upload-role=historical]').setInputFiles(file); await saved(page, state);
  const material = [...state.uploads.values()][0].material!; expect(draftWrites(state)).toEqual([{ kind: 'input', expected_version: 3, input: { ...original, source_material_ref: pin(material), material_versions: [...original.material_versions, pin(material)] } }]); expect(state.draft.evidence_links).toEqual(original.evidence_links); noBusiness(state);
});

async function capture(page: Page, directory: string, name: string) {
  const filename = `review-upload-twelfth-${name}.png`; const bytes = await page.screenshot({ path: join(directory, filename), fullPage: false });
  const geometry = await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight }, overflow: document.documentElement.scrollWidth > innerWidth + 1, text: document.body.innerText })); expect(geometry.overflow).toBe(false);
  const record = { filename, screenshot_sha256: hash(bytes), kind: 'viewport', scope: 'Actual ReviewWorkspace component and global CSS; strict synthetic public HTTP; no production object storage, professional acceptance or human design signoff.', ...geometry };
  await writeFile(join(directory, filename.replace('.png', '.json')), JSON.stringify(record, null, 2)); return record;
}
for (const scene of ['materials', 'target-dialog'] as const) for (const width of [1440, 390]) test(`review upload component comparison ${scene} at ${width}`, async ({ page }) => {
  const directory = process.env.BB_TWELFTH_EVIDENCE_DIR ?? process.env.BB_UX_EVIDENCE_DIR; test.skip(!directory, 'Explicit twelfth evidence directory is required'); await mkdir(directory!, { recursive: true });
  const reference = process.env.BB_TWELFTH_REFERENCE === '1', finish = reference ? await installTwelfthReference(page) : undefined;
  await page.setViewportSize({ width, height: 960 }); const state = await install(page); state.dropPut = 'after'; await mount(page);
  const flavor = reference ? 'reference' : 'implementation', captured = [];
  if (scene === 'target-dialog') { await page.locator('#review-tab-results').click(); const finding = page.locator(`[data-finding-id="${ids.finding}"]`); await finding.locator('summary').click(); await finding.locator('[data-review-action=evidence]').click(); await expect(page.getByRole('dialog', { name: '为此问题补充材料' })).toBeVisible(); }
  else await page.locator('[data-review-drop=audit]').scrollIntoViewIfNeeded();
  captured.push(await capture(page, directory!, `${flavor}-${scene}-ready-${width}`));
  if (scene === 'target-dialog') { await page.locator('#review-upload-role').selectOption('other'); await page.locator('#review-upload-file').setInputFiles(file);  }
  else await page.locator('[data-review-upload-role=audit]').setInputFiles(file);
  if (reference) await expect(page.locator('[data-review-action=retry-upload]')).toBeEnabled(); else await expect(resume(page)).toBeEnabled();
  captured.push(await capture(page, directory!, `${flavor}-${scene}-pending-${width}`)); const before = await refreshReadOnly(page, state);
  if (reference) { await expect(page.locator('[data-review-action=retry-upload]')).toHaveCount(0); await expect(page.locator('[data-review-recovery-id]')).toHaveCount(0); }
  else { await expect(resume(page)).toBeEnabled(); await recovery(page).scrollIntoViewIfNeeded(); }
  expect(writes(state)).toHaveLength(before); captured.push(await capture(page, directory!, `${flavor}-${scene}-refreshed-${width}`));
  await writeFile(join(directory!, `review-upload-twelfth-${flavor}-${scene}-comparison-${width}.json`), JSON.stringify({ reference, source: finish ? await finish() : { scope: 'Current twelfth implementation; no new approved recovery prototype or human signoff.' }, records: captured, writes_after_refresh: 0, original_upload_creates: uploads(state, 'create').length, original_puts: uploads(state, 'bytes').length, draft_puts: draftWrites(state).length, errors: state.errors, unexpected_requests: state.unexpected }, null, 2)); noBusiness(state);
});
