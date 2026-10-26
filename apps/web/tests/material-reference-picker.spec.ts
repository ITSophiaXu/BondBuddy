import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { M4_DOCUMENT_LABELS, type M4MaterialPin } from '@bondbuddy/contracts';
import {
  fixture, install, mount, open, openPicker, closePicker, picker, entry, adopt, labels, currentInput, expectedInput,
  ids, inputOf, pinKey, draftWrites, libraryWrites, writes, noBusiness, choose, settle, observe,
  holdLibrary, beginHeldAdoption, finishHeld, baselineSourceEntry, type Purpose, type State,
} from './material-reference-picker-fixtures';
import { installMaterialReferencePickerReference, captureMaterialReferencePicker } from './material-reference-picker-reference';

const baseline = process.env.BB_MATERIAL_REFERENCE_BASELINE === '1';
const evidence = process.env.BB_MATERIAL_REFERENCE_EVIDENCE;
const reference = process.env.BB_MATERIAL_REFERENCE_REFERENCE === '1';
test.use({ viewport: { width: 1440, height: 960 } });

async function saveSelection(page: import('@playwright/test').Page, state: State, purpose: Purpose, selected: M4MaterialPin) {
  const original = currentInput(state), allDrafts = structuredClone(state.workspace.drafts);
  await openPicker(page, purpose); await expect(adopt(page, selected)).toBeEnabled();
  await expect(adopt(page, selected)).toHaveText(labels[purpose]); await adopt(page, selected).click();
  await expect.poll(() => libraryWrites(state).length).toBe(1);
  const expected = expectedInput(original, purpose, selected);
  await expect.poll(async () => (await observe(page)).drafts.private_summary.input).toEqual(expected);
  await settle(page); await expect.poll(() => draftWrites(state).length).toBe(1);
  expect(draftWrites(state)).toEqual([{ expected_version: allDrafts.private_summary.version, input: expected }]);
  expect(currentInput(state)).toEqual(expected);
  for (const [type, draft] of Object.entries(allDrafts)) if (type !== 'private_summary') expect(state.workspace.drafts[type as keyof typeof state.workspace.drafts]).toEqual(draft);
  noBusiness(state);
}

if (baseline) {
  test('material reference baseline diagnostic: visible R35 source picker accepts XLSX into supplements instead of a source', async ({ page }) => {
    const auditReference = await installMaterialReferencePickerReference(page), state = await open(page), original = currentInput(state);
    const before = writes(state).length; await baselineSourceEntry(page).click();
    const dialog = page.locator('dialog[open]'); await expect(dialog.locator('#m4-picker-project')).toHaveValue(ids.sourceProject);
    const selected = dialog.locator(`[data-adopt-pin="${pinKey(state.xlsx)}"]`); await expect(selected).toBeEnabled();
    expect(writes(state)).toHaveLength(before); await selected.click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await observe(page)).drafts.private_summary.input.materials).toEqual([...original.materials, state.xlsx]);
    await settle(page);
    const local = (await observe(page)).drafts.private_summary.input;
    expect(local.source_material).toEqual(original.source_material); expect(local.materials).toEqual([...original.materials, state.xlsx]);
    expect(libraryWrites(state)).toHaveLength(1); noBusiness(state);
    const audit = await auditReference(), output = process.env.BB_MATERIAL_REFERENCE_BASELINE_EVIDENCE;
    if (output) { await mkdir(output, { recursive: true }); await writeFile(join(output, 'r35-visible-source-xlsx-diagnostic.json'), JSON.stringify({
      audit, original, observed_local: local, observed_server: currentInput(state), calls: state.calls, library_writes: libraryWrites(state), draft_writes: draftWrites(state),
      conclusion: 'Synthetic accurate-R35 visible source entry accepted XLSX into supplements. This is the observed old behavior, not a desired new-business assertion, and no unused libraryHtml producer was invoked.',
    }, null, 2)); }
  });
} else if (evidence) {
  test('material reference picker: desktop component capture with accurate sealed R35 reference', async ({ page }) => {
    const auditReference = reference ? await installMaterialReferencePickerReference(page) : undefined;
    const state = await open(page), captures: unknown[] = [], phases: unknown[] = [];
    const collect = async (purpose: Purpose) => {
      const start = state.calls.length, before = writes(state).length;
      if (reference) await baselineSourceEntry(page).click(); else await openPicker(page, purpose);
      const dialog = page.locator('dialog[open]'); await expect(dialog.locator('#m4-picker-project')).toHaveValue(ids.sourceProject);
      await expect(dialog.locator('[data-adopt-pin]').first()).toBeAttached();
      const audit = auditReference ? await auditReference() : { implementation: 'current', purpose };
      const top = await captureMaterialReferencePicker(page, evidence, `${reference ? 'r35-reference' : 'current'}-${purpose}-1440`, audit); captures.push(top);
      if (!reference) {
        const lastRow = dialog.locator('[data-picker-file]').last(), content = dialog.locator('[data-picker-content]');
        await lastRow.locator('summary').click(); await expect(lastRow.locator('details')).toHaveAttribute('open', '');
        await content.evaluate(element => { element.scrollTop = element.scrollHeight; });
        const bottom = await captureMaterialReferencePicker(page, evidence, `current-${purpose}-bottom-1440`, { ...audit, capture_phase: 'last-file-details-open-and-content-bottom' }); captures.push(bottom);
        expect(bottom.dialog!.content!.scrollTop).toBeGreaterThan(0); expect(bottom.dialog!.content!.overflowY).toMatch(/auto|scroll/);
        expect(bottom.dialog!.scrollTop).toBe(top.dialog!.scrollTop); expect(bottom.scrollY).toBe(top.scrollY);
        for (const area of ['header', 'footer'] as const) {
          expect(bottom.dialog![area]!.fullyWithinDialogAndViewport).toBe(true);
          expect(Math.abs(bottom.dialog![area]!.box.y - top.dialog![area]!.box.y)).toBeLessThanOrEqual(1);
          expect(Math.abs(bottom.dialog![area]!.box.height - top.dialog![area]!.box.height)).toBeLessThanOrEqual(1);
        }
        expect(bottom.dialog!.lastAction).not.toBeNull(); expect(bottom.dialog!.lastAction!.adopt).toBe(pinKey(state.xlsx));
        expect(bottom.dialog!.lastAction!.visible).toBe(true); expect(bottom.dialog!.lastAction!.centerUnobscured).toBe(true);
        expect(bottom.dialog!.lastAction!.disabled).toBe(purpose === 'source'); expect(bottom.dialog!.rows.at(-1)!.detailsOpen).toBe(true);
      }
      const calls = state.calls.slice(start); expect(calls.filter(call => call.method !== 'GET')).toEqual([]); expect(writes(state)).toHaveLength(before);
      phases.push({ purpose, calls_from_open_through_capture: calls, zero_writes_in_phase: true });
      await dialog.locator('[data-close-picker]').first().click();
    };
    await collect('source');
    // R35 has no visible supplement-picker producer. Do not activate dead libraryHtml to invent a counterpart.
    if (!reference) await collect('material');
    noBusiness(state); await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, `${reference ? 'r35-reference' : 'current'}-capture-summary.json`), JSON.stringify({ reference,
      comparison_scope: 'Common visible source picker top on both sides. Current-only source/supplement bottom captures and supplement picker have no R35 counterpart.', captures, phases, calls: state.calls, errors: state.errors, unexpected: state.unexpected }, null, 2));
  });
} else {
  for (const kind of ['pdf', 'docx', 'xlsx'] as const) test(`material reference picker: ${kind.toUpperCase()} explicitly adds a supplement and preserves the source and complete draft`, async ({ page }) => {
    const state = await open(page); await saveSelection(page, state, 'material', state[kind]);
  });
  for (const kind of ['docx', 'pdf'] as const) test(`material reference picker: ${kind.toUpperCase()} explicitly replaces only the source in the complete current draft`, async ({ page }) => {
    const state = await open(page); await saveSelection(page, state, 'source', state[kind]);
  });

  test('material reference picker: a source entry never offers an enabled XLSX adoption or silently adds a supplement', async ({ page }) => {
    const state = await open(page), original = currentInput(state), before = writes(state).length;
    await openPicker(page, 'source'); await expect(picker(page)).toContainText('募集书'); await expect(picker(page)).toContainText(M4_DOCUMENT_LABELS.private_summary);
    const button = adopt(page, state.xlsx); if (await button.count()) await expect(button).toBeDisabled();
    await closePicker(page); await settle(page); expect(currentInput(state)).toEqual(original); expect(writes(state)).toHaveLength(before); noBusiness(state);
  });

  test('material reference picker: a project-file binding fixes its source while allowing explicit supplements without losing any input', async ({ page }) => {
    const state = fixture(), binding = { project_id: ids.sourceProject, source_version_id: 'picker-bound-source-version', source_selection_revision: 7, expected_file_version_id: 'picker-bound-file-version' };
    state.workspace.drafts.private_summary.project_file = structuredClone(binding);
    state.projectFileSources.set(binding.source_version_id, structuredClone(state.workspace.drafts.private_summary.source_material!));
    await open(page, state); const original = currentInput(state), before = writes(state).length;
    await openPicker(page, 'source'); await expect(picker(page)).toContainText('固定募集书依据');
    await expect(picker(page)).toContainText('项目文件入口'); await expect(picker(page)).toContainText('补充资料仍可添加');
    for (const selected of [state.pdf, state.docx]) await expect(adopt(page, selected)).toBeDisabled();
    await closePicker(page); await settle(page);
    expect(writes(state)).toHaveLength(before); expect(libraryWrites(state)).toEqual([]); expect(draftWrites(state)).toEqual([]);
    expect((await observe(page)).drafts.private_summary.input).toEqual(original); expect(currentInput(state)).toEqual(original);
    await saveSelection(page, state, 'material', state.pdf);
    expect(currentInput(state)).toEqual(expectedInput(original, 'material', state.pdf));
    expect(currentInput(state).project_file).toEqual(binding); expect(currentInput(state).source_material).toEqual(original.source_material);
    expect(state.projectFileSources.get(binding.source_version_id)).toEqual(original.source_material); noBusiness(state);
  });

  test('material reference picker: exact same-name reads stay read only and cancelled registrations retain entry focus', async ({ page }) => {
    const state = await open(page), before = writes(state).length, original = currentInput(state);
    await openPicker(page, 'material'); await expect(picker(page)).toContainText(M4_DOCUMENT_LABELS.private_summary);
    for (const selected of [state.pdf, state.duplicatePdf]) {
      const row = adopt(page, selected).locator('xpath=ancestor::*[self::li or self::article][1]');
      await expect(row).toContainText('合成财务报告.pdf'); await expect(row).toContainText(`V${selected.material_version}`);
      await expect(row).toContainText('合成原募集书项目'); await row.locator('summary').first().click();
      await expect(row).toContainText(selected.material_id); await expect(row).toContainText(selected.sha256);
    }
    await page.keyboard.press('Escape'); await expect(picker(page)).toHaveCount(0); await expect(entry(page, 'material')).toBeFocused(); await settle(page);
    expect(currentInput(state)).toEqual(original); expect(writes(state)).toHaveLength(before); noBusiness(state);
    for (const [index, cancellation] of ['close', 'escape'].entries()) {
      const selected = index === 0 ? state.pdf : state.duplicatePdf;
      const hold = await beginHeldAdoption(page, state, 'material', selected);
      if (cancellation === 'close') await closePicker(page); else { await page.keyboard.press('Escape'); await expect(picker(page)).toHaveCount(0); }
      await expect(entry(page, 'material')).toBeFocused(); await finishHeld(page, state, hold, selected);
      await expect(entry(page, 'material')).toBeFocused();
      expect((await observe(page)).drafts.private_summary.input).toEqual(original); expect(currentInput(state)).toEqual(original);
      expect(libraryWrites(state)).toHaveLength(index + 1); expect(draftWrites(state)).toEqual([]); noBusiness(state);
    }
  });

  test('material reference picker: pagination beyond fifty, Chinese project search and local material search stay read only', async ({ page }) => {
    const state = await open(page), before = writes(state).length; await openPicker(page, 'material');
    await expect(picker(page).locator(`#m4-picker-project option[value="${state.distantProject}"]`)).toHaveCount(0);
    await picker(page).locator('[data-picker-more-projects]').click();
    await expect(picker(page).locator(`#m4-picker-project option[value="${state.distantProject}"]`)).toHaveCount(1);
    await picker(page).locator('#m4-picker-project').selectOption(state.distantProject); await expect(adopt(page, state.distantPdf)).toBeVisible();
    await picker(page).locator('#m4-picker-material-query').fill('不存在的材料'); await expect(adopt(page, state.distantPdf)).toBeHidden();
    await picker(page).locator('#m4-picker-material-query').fill('财务报告'); await expect(adopt(page, state.distantPdf)).toBeVisible();
    await picker(page).locator('#m4-picker-project-query').fill('海河'); await picker(page).locator('[data-picker-search-projects]').click();
    await expect.poll(() => state.calls.filter(call => call.path === '/projects' && new URLSearchParams(call.search).get('q') === '海河').length).toBe(1);
    await expect(picker(page).locator(`#m4-picker-project option[value="${state.distantProject}"]`)).toHaveCount(1);
    expect(state.calls.some(call => call.path === '/projects' && new URLSearchParams(call.search).get('cursor') === 'picker-offset-50')).toBe(true);
    await closePicker(page); expect(writes(state)).toHaveLength(before); noBusiness(state);
  });

  test('material reference picker: repeated adoption clicks share one original registration and one saved choice', async ({ page }) => {
    const state = await open(page), original = currentInput(state), hold = await beginHeldAdoption(page, state);
    await expect(adopt(page, state.pdf)).toBeDisabled();
    // Dispatch a second native click against the already-disabled control; no private adoption method is invoked.
    await adopt(page, state.pdf).dispatchEvent('click'); expect(libraryWrites(state)).toHaveLength(1);
    await finishHeld(page, state, hold); await expect.poll(() => draftWrites(state).length).toBe(1);
    expect(currentInput(state)).toEqual(expectedInput(original, 'material', state.pdf)); expect(libraryWrites(state)).toHaveLength(1); noBusiness(state);
  });

  test('material reference picker: closing and changing type while registration waits never adopts into either draft', async ({ page }) => {
    const state = await open(page), original = structuredClone(state.workspace.drafts), hold = await beginHeldAdoption(page, state);
    await closePicker(page); await choose(page, 'legal'); await finishHeld(page, state, hold);
    const current = await observe(page); expect(current.selected).toBe('legal');
    expect(current.drafts.private_summary.input).toEqual(inputOf(original.private_summary)); expect(current.drafts.legal.input).toEqual(inputOf(original.legal));
    expect(draftWrites(state)).toEqual([]); expect(libraryWrites(state)).toHaveLength(1);
    await expect(page.locator('#m4-status')).toContainText(/登记|工作区/); await expect(page.locator('#m4-status')).toContainText(/未.*(?:采用|用于|加入)|没有.*采用/); noBusiness(state);
  });

  test('material reference picker: newer local requirements survive a late registration without adopting unreviewed input', async ({ page }) => {
    const state = await open(page), original = currentInput(state), hold = await beginHeldAdoption(page, state);
    await closePicker(page); const text = '用户关闭选择器后刚输入的新要求，必须保留。'; await page.locator('#m4-requirements').fill(text);
    await finishHeld(page, state, hold); const expected = { ...original, supplemental_requirements: text };
    await expect(page.locator('#m4-requirements')).toHaveValue(text); expect((await observe(page)).drafts.private_summary.input).toEqual(expected);
    expect(draftWrites(state).every(request => JSON.stringify(request.input) === JSON.stringify(expected))).toBe(true);
    expect(state.workspace.materials.some(value => pinKey(value) === pinKey(state.pdf))).toBe(true); noBusiness(state);
  });

  test('material reference picker: a late registration preserves the specific prior draft conflict and the complete newer input', async ({ page }) => {
    const state = await open(page), original = currentInput(state), hold = await beginHeldAdoption(page, state);
    let advanced = false;
    state.beforeDraft = () => { if (!advanced) { advanced = true; state.workspace.drafts.private_summary.version = 4; } };
    await closePicker(page); const text = '登记等待期间输入的新要求，保存冲突后仍须完整保留。'; await page.locator('#m4-requirements').fill(text);
    const expected = { ...structuredClone(original), supplemental_requirements: text };
    await settle(page); await expect.poll(() => draftWrites(state).length).toBe(1);
    await expect(page.locator('#m4-status')).toContainText('这个项目已在其他页面修改');
    const conflictMessage = await page.locator('#m4-status').innerText(), conflicted = (await observe(page)).drafts.private_summary;
    expect(conflicted.input).toEqual(expected); expect(conflicted.dirty).toBe(true); expect(conflicted.conflict).toBe(true);
    expect(draftWrites(state)).toEqual([{ expected_version: 3, input: expected }]); expect(currentInput(state)).toEqual(original);
    await finishHeld(page, state, hold);
    await expect(page.locator('#m4-status')).toContainText(conflictMessage);
    await expect(page.locator('#m4-status')).toContainText(/已.*(?:登记|加入原工作区)/);
    await expect(page.locator('#m4-status')).toContainText(/未.*(?:采用|用于|加入)/);
    const current = (await observe(page)).drafts.private_summary;
    expect(current.input).toEqual(expected); expect(current.dirty).toBe(true); expect(current.conflict).toBe(true); expect(current.version).toBe(3);
    expect(currentInput(state)).toEqual(original); expect(state.workspace.drafts.private_summary.version).toBe(4);
    expect(state.workspace.materials.some(value => pinKey(value) === pinKey(state.pdf))).toBe(true);
    await settle(page); expect(draftWrites(state)).toEqual([{ expected_version: 3, input: expected }]); expect(libraryWrites(state)).toHaveLength(1); noBusiness(state);
  });

  test('material reference picker: leaving the component while registration waits preserves the server registration without saving a draft', async ({ page }) => {
    const state = await open(page), original = currentInput(state); await openPicker(page, 'material');
    const hold = await holdLibrary(state), cancelled = page.waitForEvent('requestfailed', { predicate: request => request.method() === 'POST'
      && new URL(request.url()).pathname === `/api/v1/m4/topics/${ids.topic}/materials` && pinKey(request.postDataJSON().material) === pinKey(state.pdf) });
    await adopt(page, state.pdf).click(); await expect.poll(hold.entered).toBe(true);
    await closePicker(page);
    await page.evaluate(() => { const windowState = window as unknown as { m4Component: { dispose(): void }; m4Owner?: string }; windowState.m4Component.dispose(); windowState.m4Owner = 'departed-owner'; document.querySelector('.shell')!.innerHTML = '<h1>已离开原材料工作区</h1>'; });
    const failedRequest = await cancelled; expect(failedRequest.failure()).not.toBeNull(); expect(failedRequest.failure()!.errorText).toMatch(/abort|cancel/i);
    hold.release(); await expect.poll(() => state.workspace.materials.some(value => pinKey(value) === pinKey(state.pdf))).toBe(true); await settle(page);
    await expect(page.getByRole('heading', { name: '已离开原材料工作区' })).toBeVisible();
    expect((await observe(page)).drafts.private_summary.input).toEqual(original); expect(currentInput(state)).toEqual(original);
    expect(draftWrites(state)).toEqual([]); expect(libraryWrites(state)).toHaveLength(1); noBusiness(state);
    await test.info().attach('disposed-registration-request-failed', { contentType: 'application/json', body: JSON.stringify({
      method: failedRequest.method(), url: failedRequest.url(), body: failedRequest.postDataJSON(), failure: failedRequest.failure(),
      server_registered_after_release: state.workspace.materials.some(value => pinKey(value) === pinKey(state.pdf)), draft_writes: draftWrites(state), library_writes: libraryWrites(state),
    }, null, 2) });
  });

  test('material reference picker: an old response cannot close or adopt into a reopened picker with another purpose', async ({ page }) => {
    const state = await open(page), original = currentInput(state), hold = await beginHeldAdoption(page, state);
    await closePicker(page); await openPicker(page, 'source'); await expect(adopt(page, state.docx)).toBeDisabled();
    await finishHeld(page, state, hold); await expect(picker(page)).toBeVisible(); await expect(picker(page)).toHaveAttribute('data-picker-purpose', 'source');
    expect((await observe(page)).drafts.private_summary.input).toEqual(original); expect(draftWrites(state)).toEqual([]); expect(libraryWrites(state)).toHaveLength(1);
    await closePicker(page); noBusiness(state);
  });

  test('material reference picker: late material reads from the old project cannot replace the newly selected project', async ({ page }) => {
    const state = fixture(); let release!: () => void, entered = false;
    const waiting = new Promise<void>(resolve => { release = resolve; }); state.eventsGate = async project => { if (project === ids.sourceProject) { entered = true; await waiting; } };
    await open(page, state); await openPicker(page, 'material'); await expect.poll(() => entered).toBe(true);
    await picker(page).locator('#m4-picker-project').selectOption(state.alternateProject); await expect(adopt(page, state.alternateDocx)).toBeVisible();
    state.eventsGate = undefined; release(); await settle(page);
    await expect(picker(page).locator('#m4-picker-project')).toHaveValue(state.alternateProject); await expect(adopt(page, state.alternateDocx)).toBeVisible();
    await expect(adopt(page, state.pdf)).toHaveCount(0); expect(libraryWrites(state)).toEqual([]); expect(draftWrites(state)).toEqual([]); await closePicker(page); noBusiness(state);
  });

  test('material reference picker: changing source project during registration keeps its receipt separate from the draft', async ({ page }) => {
    const state = await open(page), original = currentInput(state), hold = await beginHeldAdoption(page, state);
    await picker(page).locator('#m4-picker-project').selectOption(state.alternateProject);
    await expect(adopt(page, state.alternateDocx)).toBeVisible(); await expect(adopt(page, state.alternateDocx)).toBeDisabled();
    await finishHeld(page, state, hold);
    await expect(picker(page)).toBeVisible(); await expect(picker(page).locator('#m4-picker-project')).toHaveValue(state.alternateProject);
    expect((await observe(page)).drafts.private_summary.input).toEqual(original); expect(currentInput(state)).toEqual(original);
    expect(draftWrites(state)).toEqual([]); expect(libraryWrites(state)).toHaveLength(1);
    await expect(picker(page).locator('[data-picker-status]')).toContainText(/已.*(?:登记|加入原工作区)/);
    await expect(picker(page).locator('[data-picker-status]')).toContainText(/未.*(?:采用|用于|加入)/);
    await closePicker(page); noBusiness(state);
  });

  test('material reference picker: newly arrived original pending, upload and cache guards block adoption and preserve their state', async ({ context }) => {
    // Simulate asynchronous guard arrival after a visible read. This injects only concurrent state,
    // never calls a private save/adoption/paint function or bypasses the public click handler.
    for (const guard of ['pendingExecution', 'uploading', 'cacheFailure'] as const) {
      const page = await context.newPage(), state = await install(page); await page.goto('/'); await page.evaluate(() => localStorage.clear()); await mount(page, { navigation: 'same-page' });
      await openPicker(page, 'material'); await expect(adopt(page, state.pdf)).toBeEnabled(); const original = currentInput(state);
      const pending = { execution_request_id: 'picker-original-pending', document_type: 'private_summary', expected_draft_version: 3, quote_id: 'picker-original-quote', entrypoint: 'workspace' };
      await page.evaluate(({ guard, pending }) => { const component = (window as unknown as { m4Component: Record<string, unknown> }).m4Component; component[guard] = guard === 'pendingExecution' ? pending : true; }, { guard, pending });
      await adopt(page, state.pdf).click(); await settle(page); expect(libraryWrites(state)).toEqual([]); expect(draftWrites(state)).toEqual([]);
      expect((await observe(page)).drafts.private_summary.input).toEqual(original); if (guard === 'pendingExecution') expect((await observe(page)).pendingExecution).toEqual(pending);
      noBusiness(state); await page.close();
    }
  });

  test('material reference picker: a draft CAS conflict keeps registration separate from the unsaved complete local choice', async ({ page }) => {
    const state = await open(page), original = currentInput(state); let changed = false;
    state.beforeDraft = () => { if (!changed) { changed = true; state.workspace.drafts.private_summary = { ...state.workspace.drafts.private_summary, version: 4, supplemental_requirements: '服务器另一页新要求' }; } };
    await openPicker(page, 'material'); await adopt(page, state.pdf).click(); await settle(page); await expect.poll(() => draftWrites(state).length).toBe(1);
    expect(draftWrites(state)[0]).toEqual({ expected_version: 3, input: expectedInput(original, 'material', state.pdf) });
    const current = (await observe(page)).drafts.private_summary; expect(current.input).toEqual(expectedInput(original, 'material', state.pdf)); expect(current.dirty).toBe(true); expect(current.conflict).toBe(true);
    expect(currentInput(state).supplemental_requirements).toBe('服务器另一页新要求'); expect(state.workspace.materials.some(value => pinKey(value) === pinKey(state.pdf))).toBe(true);
    await expect(page.locator('#m4-status')).toContainText(/冲突|版本|核对/); expect(libraryWrites(state)).toHaveLength(1); noBusiness(state);
  });

  test('material reference picker: a lost registration receipt never claims absence or silently resubmits or adopts', async ({ page }) => {
    const state = await open(page), original = currentInput(state); state.dropLibrary = 'after';
    await openPicker(page, 'material');
    const failed = page.waitForEvent('requestfailed', { predicate: request => request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/v1/m4/topics/' + ids.topic + '/materials'
      && pinKey(request.postDataJSON().material) === pinKey(state.pdf) });
    await adopt(page, state.pdf).click(); await settle(page);
    // The original cache settle does not await registration's network outcome.
    const failedRequest = await failed; expect(failedRequest.postDataJSON()).toEqual({ material: state.pdf });
    expect(failedRequest.failure()?.errorText).toMatch(/CONNECTION_RESET/i);
    await expect.poll(() => state.workspace.materials.some(value => pinKey(value) === pinKey(state.pdf))).toBe(true);
    await expect(picker(page).locator('[data-picker-status]')).toContainText('文件登记或选择尚未确认');
    await expect(picker(page).locator('[data-picker-status]')).toContainText('不会自动重发');
    expect(libraryWrites(state)).toHaveLength(1); expect(state.workspace.materials.some(value => pinKey(value) === pinKey(state.pdf))).toBe(true);
    expect((await observe(page)).drafts.private_summary.input).toEqual(original); expect(draftWrites(state)).toEqual([]);
    await expect(page.locator('[data-picker-status],#m4-status').filter({ hasText: /核对|确认|未.*采用|尚未/ }).first()).toBeVisible();
    await settle(page); expect(libraryWrites(state)).toHaveLength(1); noBusiness(state);
  });
}
