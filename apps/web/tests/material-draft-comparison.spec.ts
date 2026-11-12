import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { M4DraftInputSchema, type M4DraftInput } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';
import {
  fixture, install, mount, restore, seedCache, setServer, realConflict, openComparison, dialog, action, row, holdWorkspace,
  ids, inputOf, pinKey, hash, longRequirement, draftWrites, writes, noBusiness, legacyCache, waitCache, writeCache,
  pendingExecution, workspaceGets, nextWorkspaceSettled, observedState, file, uploads, records, recovery, choose,
} from './material-draft-comparison-fixtures';
import { installMaterialDraftComparisonReference, captureMaterialDraftComparison } from './material-draft-comparison-reference';

test.use({ viewport: { width: 1440, height: 960 } });
test.afterEach(async ({ page }, info) => {
  const state = observedState(page); if (!state) return;
  await info.attach('synthetic-material-draft-http-boundary', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
    synthetic: true, scope: 'Public synthetic HTTP traffic for this whole journey, including preparation writes where applicable. No model, billing, worker, or Word acceptance is implied.',
    calls: state.calls, workspace_gets: workspaceGets(state), all_non_gets: writes(state), draft_requests: draftWrites(state), unexpected: state.unexpected, page_errors: state.errors,
  }, null, 2)) });
});

test('material draft comparison: real CAS conflict exposes every input and keeps the exact complete local body', async ({ page }) => {
  const state = await install(page, fixture());
  await realConflict(page, state); const failed = structuredClone(draftWrites(state)[0]);
  const before = writes(state).length; await openComparison(page, state);
  await expect(dialog(page)).toHaveAccessibleName('核对材料与要求');
  await expect(dialog(page).locator('pre')).toHaveCount(0);
  const changed = dialog(page).locator('[data-draft-comparison-changed]');
  for (const key of ['project_file', 'source_material', 'materials', 'template', 'edit_base', 'fields.custom_complete_field', 'fields.only_local_field', 'fields.only_server_field', 'fields.explicit_empty', 'requirements', 'supplemental_requirements']) {
    await expect(changed.locator(`[data-draft-comparison-row=${JSON.stringify(key)}]`), key).toHaveCount(1);
    await expect(row(page, key).locator('[data-comparison-side="local"]')).toHaveCount(1);
    await expect(row(page, key).locator('[data-comparison-side="server"]')).toHaveCount(1);
  }
  const same = dialog(page).locator('details[data-draft-comparison-same]'); await expect(same).not.toHaveAttribute('open', '');
  await same.locator(':scope>summary').click();
  for (const key of ['document_type', 'scope', 'fields.issuer_name', 'fields.same_business_field']) await expect(same.locator(`[data-draft-comparison-row=${JSON.stringify(key)}]`)).toHaveCount(1);
  await expect(row(page, 'fields.custom_complete_field')).toContainText(state.localInput.fields.custom_complete_field);
  await expect(row(page, 'fields.constructor')).toContainText('其他任务信息：constructor');
  await expect(row(page, 'fields.constructor')).toContainText(state.localInput.fields['constructor']);
  await expect(row(page, 'fields.constructor').locator('[data-comparison-side="server"]')).toContainText('未提供此项');
  await expect(row(page, 'project_file')).toContainText('comparison-source-version-local'); await expect(row(page, 'project_file')).toContainText('comparison-file-version-local');
  await expect(row(page, 'project_file')).toContainText('comparison-source-version-server');
  for (const [key, pins] of [
    ['source_material', [state.localInput.source_material!, state.serverInput.source_material!]],
    ['materials', [...state.localInput.materials, ...state.serverInput.materials]],
    ['template', [state.localInput.template!, state.serverInput.template!]],
    ['edit_base', [state.localInput.edit_base!, state.serverInput.edit_base!]],
  ] as const) {
    const refs = row(page, key).locator('[data-comparison-reference]'); expect(await refs.count()).toBeGreaterThanOrEqual(pins.length);
    for (const selected of pins) {
      const reference = refs.filter({ hasText: selected.sha256 }); await expect(reference).toHaveCount(1);
      const values = 'material_id' in selected ? [selected.source_project_id, selected.material_id, selected.material_version, selected.sha256]
        : 'artifact_id' in selected ? [selected.source_project_id, selected.artifact_id, selected.artifact_version, selected.sha256]
          : [selected.template_id, selected.template_version, selected.sha256];
      await expect(reference.locator('dd')).toHaveText(values.map(String));
    }
  }
  await expect(row(page, 'requirements')).toContainText(longRequirement);
  for (const value of [...state.localInput.requirements, ...state.serverInput.requirements]) {
    await expect(row(page, 'requirements')).toContainText(value.requirement_id); await expect(row(page, 'requirements')).toContainText(value.message_id);
  }
  expect(await row(page, 'requirements').locator('img,script').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { comparisonInjected?: boolean }).comparisonInjected ?? false)).toBe(false);
  const style = await row(page, 'requirements').locator('[data-comparison-side="local"] p').first().evaluate(e => ({ whiteSpace: getComputedStyle(e).whiteSpace, text: e.textContent }));
  expect(style.whiteSpace).toBe('pre-wrap'); expect(style.text).toContain('\n');
  expect(writes(state)).toHaveLength(before);
  const reads = state.workspaceReads; await action(page, 'keep').click();
  await expect.poll(() => draftWrites(state).length).toBe(2); await expect(dialog(page)).toHaveCount(0); await waitCache(page);
  expect(state.workspaceReads).toBe(reads + 1);
  expect(draftWrites(state)).toEqual([failed, { expected_version: 4, input: failed.input }]);
  expect(inputOf(state.workspace.drafts.private_summary)).toEqual(failed.input); expect(state.workspace.drafts.private_summary.version).toBe(5);
  expect((await legacyCache(page)).drafts.private_summary.input).toEqual(failed.input); noBusiness(state);
});

test('material draft comparison: recovered dirty cache uses the entire saved version only after explicit choice', async ({ page }) => {
  const state = await install(page, fixture()); setServer(state); await restore(page, state); await openComparison(page, state);
  const before = writes(state).length, reads = state.workspaceReads; await action(page, 'server').click(); await expect(dialog(page)).toHaveCount(0); await waitCache(page);
  expect(state.workspaceReads).toBe(reads + 1); expect(writes(state)).toHaveLength(before); expect(draftWrites(state)).toEqual([]);
  await expect(page.locator('#m4-requirements')).toHaveValue(state.serverInput.supplemental_requirements!);
  expect((await legacyCache(page)).drafts.private_summary).toEqual({ version: 4, input: state.serverInput, dirty: false, conflict: false });
  await page.clock.runFor(1_000); expect(writes(state)).toHaveLength(before); noBusiness(state);
});

test('material draft comparison: schema-valid cache under the wrong document key is preserved and cannot save to another type', async ({ page }) => {
  const state = await install(page, fixture()); setServer(state);
  const mismatched: M4DraftInput = { ...structuredClone(state.localInput), document_type: 'legal' };
  expect(Value.Check(M4DraftInputSchema, mismatched)).toBe(true);
  const legal = structuredClone(state.workspace.drafts.legal), summary = structuredClone(state.workspace.drafts.private_summary);
  await seedCache(page, state, mismatched);
  const key = `bb-m4:${ids.owner}:${ids.topic}`, original = await page.evaluate(key => localStorage.getItem(key), key);
  await mount(page, { navigation: 'same-page' });
  await expect(page.locator('#m4-status')).toContainText('文件类型与保存位置不一致');
  await expect(page.locator('#m4-status')).toContainText('原记录已保留且未加载');
  await expect(page.locator('[data-m4-action="resolve-draft"]')).toHaveCount(0); await expect(dialog(page)).toHaveCount(0);
  const settled = nextWorkspaceSettled(page); await page.locator('[data-m4-action="refresh"]').click(); await settled; await page.clock.runFor(1_000);
  await expect(page.locator('#m4-status')).toContainText('文件类型与保存位置不一致');
  // A disabled action is already blocked at the public UI. If the existing
  // generation control remains enabled, its real click must stop before quote.
  const execute = page.locator('[data-m4-action="execute"]').first(); await expect(execute).toBeVisible();
  if (await execute.isEnabled()) await execute.click(); else await expect(execute).toBeDisabled();
  await page.clock.runFor(1_000);
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(original);
  expect((await legacyCache(page)).drafts.private_summary.input).toEqual(mismatched);
  expect(state.workspace.drafts.legal).toEqual(legal); expect(state.workspace.drafts.private_summary).toEqual(summary);
  expect(draftWrites(state)).toEqual([]); expect(writes(state)).toEqual([]); await expect(dialog(page)).toHaveCount(0); noBusiness(state);
});

test('material draft comparison: defer and Escape keep recovered contents and create no save request', async ({ page }) => {
  const state = await install(page, fixture()); setServer(state); await restore(page, state); const original = await legacyCache(page), before = writes(state).length;
  await openComparison(page, state); await action(page, 'close').click(); await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('#m4-requirements')).toHaveValue(state.localInput.supplemental_requirements!);
  await openComparison(page, state); await page.keyboard.press('Escape'); await expect(dialog(page)).toHaveCount(0); await page.clock.runFor(1_000);
  expect((await legacyCache(page)).drafts.private_summary).toEqual(original.drafts.private_summary); expect(writes(state)).toHaveLength(before); noBusiness(state);
});

test('material draft comparison: identical full inputs are folded and an explicit saved-version choice does not invent a new version', async ({ page }) => {
  const state = await install(page, fixture()); setServer(state, state.localInput); await restore(page, state); await openComparison(page, state, 'server');
  await expect(dialog(page).locator('[data-draft-comparison-changed] [data-draft-comparison-row]')).toHaveCount(0);
  await expect(action(page, 'keep')).toHaveCount(0); await expect(action(page, 'server')).toBeEnabled();
  await expect(action(page, 'server')).toHaveClass(/\bprimary\b/);
  const same = dialog(page).locator('details[data-draft-comparison-same]'); await expect(same).not.toHaveAttribute('open', '');
  await expect(same.locator(':scope>summary')).toContainText('相同内容'); await same.locator(':scope>summary').click();
  await expect(row(page, 'requirements')).toContainText('LONG_REQUIREMENT_END_');
  const before = writes(state).length; await action(page, 'server').click(); await expect(dialog(page)).toHaveCount(0); await waitCache(page);
  expect(writes(state)).toHaveLength(before); expect(state.workspace.drafts.private_summary.version).toBe(4);
  expect((await legacyCache(page)).drafts.private_summary).toEqual({ version: 4, input: state.localInput, dirty: false, conflict: false }); noBusiness(state);
});

test('material draft comparison: absent and explicitly empty fields remain distinct in display and the saved input', async ({ page }) => {
  const state = await install(page, fixture()), local: M4DraftInput = { ...state.localInput, supplemental_requirements: '' }, server = structuredClone(local);
  local.fields = { ...local.fields, market: 'constructor' };
  expect(Value.Check(M4DraftInputSchema, local)).toBe(true);
  delete server.supplemental_requirements; delete server.fields.explicit_empty;
  expect(Value.Check(M4DraftInputSchema, server)).toBe(true);
  setServer(state, server); await restore(page, state, local); await openComparison(page, state);
  for (const key of ['supplemental_requirements', 'fields.explicit_empty']) {
    await expect(row(page, key)).toHaveAttribute('data-comparison-change', 'content');
    expect(await row(page, key).locator('[data-comparison-side="local"]').textContent()).not.toBe(await row(page, key).locator('[data-comparison-side="server"]').textContent());
  }
  await expect(row(page, 'fields.market').locator('[data-comparison-side="local"]')).toContainText('constructor');
  await expect(row(page, 'fields.market')).not.toContainText('function Object');
  await action(page, 'keep').click(); await expect.poll(() => draftWrites(state).length).toBe(1); await expect(dialog(page)).toHaveCount(0);
  expect(draftWrites(state)).toEqual([{ expected_version: 4, input: local }]); await waitCache(page);
  expect((await legacyCache(page)).drafts.private_summary.input).toEqual(local); noBusiness(state);
});

test('material draft comparison: inherited toString market renders without inventing a valid market or changing the saved input', async ({ page }) => {
  const state = await install(page, fixture()), local: M4DraftInput = { ...structuredClone(state.localInput), fields: { ...state.localInput.fields, market: 'toString' } };
  expect(Value.Check(M4DraftInputSchema, local)).toBe(true);
  setServer(state); await restore(page, state, local);
  await expect(page.locator('#m4-market')).toHaveValue('');
  await expect(page.locator('#m4-offering')).toHaveValue('');
  await expect(page.locator('#m4-offering option')).toHaveCount(1);
  await openComparison(page, state);
  await expect(row(page, 'fields.market').locator('[data-comparison-side="local"]')).toContainText('toString');
  await expect(row(page, 'fields.market')).not.toContainText('function');
  expect(writes(state)).toEqual([]);
  await action(page, 'keep').click(); await expect.poll(() => draftWrites(state).length).toBe(1); await expect(dialog(page)).toHaveCount(0); await waitCache(page);
  expect(draftWrites(state)).toEqual([{ expected_version: 4, input: local }]);
  expect((await legacyCache(page)).drafts.private_summary.input).toEqual(local); noBusiness(state);
});

test('material draft comparison: fresh names require unique complete pins and never borrow a similar file', async ({ page }) => {
  const state = await install(page, fixture()); setServer(state); await restore(page, state);
  // These are public workspace responses, changed after the component read its old
  // display metadata. Same filenames and near-matching references cannot authorize a name.
  const serverDetail = state.workspace.material_details.find(value => pinKey(value) === pinKey(state.serverInput.source_material!))!;
  serverDetail.filename = 'fresh准确服务器募集书.docx';
  const support = state.workspace.material_details.find(value => pinKey(value) === pinKey(state.serverInput.materials[0]))!;
  support.filename = '不得借用的重复材料名.pdf'; state.workspace.material_details.push(structuredClone(support));
  const template = state.workspace.templates.find(value => value.template_id === state.serverInput.template!.template_id && value.template_version === state.serverInput.template!.template_version)!;
  template.name = '不得借用的错hash模板.docx'; template.sha256 = hash('unrelated template with same id and version');
  const artifact = state.workspace.artifacts.find(value => value.artifact_version === state.serverInput.edit_base!.artifact_version)!;
  artifact.filename = '不得借用的其他项目成果.docx'; artifact.source_project_id = 'comparison-other-project';
  await openComparison(page, state);
  await expect(row(page, 'source_material').locator('[data-comparison-side="local"]')).toContainText('同名募集书.docx');
  await expect(row(page, 'source_material').locator('[data-comparison-side="server"]')).toContainText('fresh准确服务器募集书.docx');
  for (const key of ['materials', 'template', 'edit_base']) await expect(row(page, key).locator('[data-comparison-side="server"] [data-comparison-unverified]')).toHaveCount(1);
  await expect(row(page, 'materials')).not.toContainText('不得借用的重复材料名.pdf');
  await expect(row(page, 'template')).not.toContainText('不得借用的错hash模板.docx');
  await expect(row(page, 'edit_base')).not.toContainText('不得借用的其他项目成果.docx');
  for (const key of ['template', 'edit_base'] as const) await expect(row(page, key)).toContainText(state.serverInput[key]!.sha256);
  state.workspace.material_details = state.workspace.material_details.filter(value => pinKey(value) !== pinKey(state.serverInput.source_material!));
  await action(page, 'reload').click(); await expect(action(page, 'keep')).toBeEnabled();
  await expect(row(page, 'source_material').locator('[data-comparison-side="server"] [data-comparison-unverified]')).toHaveCount(1);
  await expect(row(page, 'source_material').locator('[data-comparison-side="server"]')).not.toContainText('fresh准确服务器募集书.docx');
  await expect(row(page, 'source_material').locator('[data-comparison-side="server"]')).toContainText(state.serverInput.source_material!.sha256);
  expect(draftWrites(state)).toEqual([]); noBusiness(state);
});

test('material draft comparison: equal requirement text with different message provenance remains a visible reference change', async ({ page }) => {
  const state = await install(page, fixture()), server = structuredClone(state.localInput);
  server.requirements = server.requirements.map(value => ({ ...value, requirement_id: value.requirement_id + '-new', message_id: value.message_id + '-new', message_version: 3 }));
  setServer(state, server); await restore(page, state); await openComparison(page, state);
  await expect(row(page, 'requirements')).toHaveAttribute('data-comparison-change', 'reference');
  await expect(row(page, 'requirements')).toContainText(longRequirement);
  for (const value of server.requirements) { await expect(row(page, 'requirements')).toContainText(value.message_id); await expect(row(page, 'requirements')).toContainText(value.requirement_id); }
  await action(page, 'server').click(); await expect(dialog(page)).toHaveCount(0); await waitCache(page);
  expect((await legacyCache(page)).drafts.private_summary.input.requirements).toEqual(server.requirements); expect(draftWrites(state)).toEqual([]); noBusiness(state);
});

for (const choice of ['keep', 'server'] as const) test(`material draft comparison: ${choice} rereads a second server change and requires another explicit choice`, async ({ page }) => {
  const state = await install(page, fixture()); setServer(state); await restore(page, state); await openComparison(page, state);
  const next = { ...structuredClone(state.serverInput), supplemental_requirements: '比较已打开之后，另一页面保存了新一轮要求。' };
  // One variant changes the version; the other changes a complete input while
  // keeping the version, so checking a version number alone is insufficient.
  const version = choice === 'keep' ? 5 : 4; setServer(state, next, version);
  const before = writes(state).length; await action(page, choice).click();
  await expect(row(page, 'supplemental_requirements').locator('[data-comparison-side="server"]')).toContainText(next.supplemental_requirements);
  await expect(action(page, choice)).toBeEnabled(); expect(writes(state)).toHaveLength(before); expect(draftWrites(state)).toEqual([]);
  await expect(page.locator('#m4-requirements')).toHaveValue(state.localInput.supplemental_requirements!);
  await action(page, choice).click(); await expect(dialog(page)).toHaveCount(0); await waitCache(page);
  if (choice === 'keep') expect(draftWrites(state)).toEqual([{ expected_version: version, input: state.localInput }]);
  else { expect(writes(state)).toHaveLength(before); expect((await legacyCache(page)).drafts.private_summary).toEqual({ version, input: next, dirty: false, conflict: false }); }
  noBusiness(state);
});

test('material draft comparison: failed comparison read retains local intent and explicit reload reads fresh data', async ({ page }) => {
  const state = await install(page, fixture()); setServer(state); await restore(page, state); state.failWorkspaceReads = true;
  await page.locator('[data-m4-action="resolve-draft"]').click(); await expect(dialog(page)).toBeVisible(); await expect(action(page, 'reload')).toBeEnabled();
  await expect(action(page, 'keep')).toBeDisabled(); await expect(action(page, 'server')).toBeDisabled();
  await expect(page.locator('#m4-requirements')).toHaveValue(state.localInput.supplemental_requirements!);
  state.failWorkspaceReads = false; await action(page, 'reload').click(); await expect(action(page, 'keep')).toBeEnabled();
  await expect(row(page, 'supplemental_requirements')).toContainText(state.serverInput.supplemental_requirements!);
  expect(writes(state)).toEqual([]); noBusiness(state);
});

for (const intent of ['document type', 'local text', 'leave'] as const) test(`material draft comparison: a late opening read cannot reclaim ${intent}`, async ({ page }) => {
  const state = await install(page, fixture()); setServer(state); await restore(page, state); const held = await holdWorkspace(state);
  await page.locator('[data-m4-action="resolve-draft"]').click(); await expect.poll(held.entered).toBe(true); await expect(dialog(page)).toBeVisible();
  const settled = nextWorkspaceSettled(page);
  await action(page, 'close').click(); await expect(dialog(page)).toHaveCount(0);
  if (intent === 'document type') await choose(page, 'legal');
  if (intent === 'local text') await page.locator('#m4-requirements').fill('关闭比较以后本页新写的要求，迟到读取不得替换。');
  if (intent === 'leave') await page.evaluate(() => { const w = window as unknown as { m4Component: { dispose(): void }; m4Owner?: string }; w.m4Component.dispose(); w.m4Owner = 'comparison-left'; document.querySelector('.shell')!.innerHTML = '<h1>已离开材料页</h1>'; });
  held.release(); await settled; await page.clock.runFor(100);
  await expect(dialog(page)).toHaveCount(0); expect(draftWrites(state)).toEqual([]);
  if (intent === 'document type') await expect(page.locator('[data-m4-type]:checked')).toHaveValue('legal');
  if (intent === 'local text') await expect(page.locator('#m4-requirements')).toHaveValue('关闭比较以后本页新写的要求，迟到读取不得替换。');
  if (intent === 'leave') await expect(page.locator('.shell')).toHaveText('已离开材料页');
  noBusiness(state);
});

test('material draft comparison: a late choice read cannot save newer local text that was never compared', async ({ page }) => {
  const state = await install(page, fixture()); setServer(state); await restore(page, state); await openComparison(page, state); const held = await holdWorkspace(state);
  await action(page, 'keep').click(); await expect.poll(held.entered).toBe(true); const settled = nextWorkspaceSettled(page); await action(page, 'close').click();
  const next = '选择读取期间关闭窗口后写下的新意图，必须重新核对。'; await page.locator('#m4-requirements').fill(next); held.release(); await settled; await page.clock.runFor(100);
  expect(draftWrites(state)).toEqual([]); await expect(dialog(page)).toHaveCount(0); await expect(page.locator('#m4-requirements')).toHaveValue(next);
  await openComparison(page, state); await expect(row(page, 'supplemental_requirements').locator('[data-comparison-side="local"]')).toContainText(next);
  await action(page, 'keep').click(); await expect.poll(() => draftWrites(state).length).toBe(1); await expect(dialog(page)).toHaveCount(0);
  expect(draftWrites(state)).toEqual([{ expected_version: 4, input: { ...state.localInput, supplemental_requirements: next } }]); noBusiness(state);
});

for (const delivery of ['before', 'after'] as const) test(`material draft comparison: a lost PUT ${delivery} saving stays guarded through reload and explicit recheck`, async ({ page }) => {
  const state = await install(page, fixture()); setServer(state); await restore(page, state); await openComparison(page, state); state.dropDraft = delivery;
  await action(page, 'keep').click(); await expect.poll(() => draftWrites(state).length).toBe(1);
  await expect(dialog(page).locator('[data-draft-comparison-status]')).toHaveAttribute('data-error', 'true'); await waitCache(page);
  const sent = structuredClone(draftWrites(state)[0]); expect(sent).toEqual({ expected_version: 4, input: state.localInput });
  expect(inputOf(state.workspace.drafts.private_summary)).toEqual(delivery === 'after' ? sent.input : state.serverInput); expect(state.workspace.drafts.private_summary.version).toBe(delivery === 'after' ? 5 : 4);
  const before = writes(state).length; await page.clock.runFor(1_000); await page.evaluate(() => { dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(1_000); expect(writes(state)).toHaveLength(before);
  await mount(page, { navigation: 'reload' }); await page.clock.runFor(1_000); expect(writes(state)).toHaveLength(before);
  const recheckChoice = delivery === 'after' ? 'server' : 'keep';
  await expect(page.locator('[data-m4-action="resolve-draft"]')).toBeVisible(); await openComparison(page, state, recheckChoice);
  if (delivery === 'after') {
    await expect(dialog(page).locator('[data-draft-comparison-changed] [data-draft-comparison-row]')).toHaveCount(0);
    await expect(action(page, 'keep')).toHaveCount(0); await expect(action(page, 'server')).toHaveClass(/\bprimary\b/);
  }
  else await expect(row(page, 'supplemental_requirements')).toContainText(state.serverInput.supplemental_requirements!);
  await action(page, recheckChoice).click(); await expect(dialog(page)).toHaveCount(0); await waitCache(page);
  expect(writes(state)).toHaveLength(before + (delivery === 'before' ? 1 : 0)); expect(draftWrites(state)).toEqual(delivery === 'before' ? [sent, sent] : [sent]); expect(state.workspace.drafts.private_summary.version).toBe(5);
  expect((await legacyCache(page)).drafts.private_summary).toEqual({ version: 5, input: sent.input, dirty: false, conflict: false }); noBusiness(state);
});

test('material draft comparison: a pending original execution arriving behind the cache queue prevents the choice', async ({ page }) => {
  const state = await install(page, fixture()); setServer(state); await restore(page, state); await openComparison(page, state); await waitCache(page);
  // Supplementary queue fault injection only; all primary paths above use the real queue.
  await page.evaluate(() => { const w = window as unknown as { m4Component: { cacheQueue: Promise<void> }; releaseComparisonQueue?: () => void }; const queue = w.m4Component.cacheQueue; w.m4Component.cacheQueue = queue.then(() => new Promise<void>(resolve => { w.releaseComparisonQueue = resolve; })); });
  await action(page, 'keep').click(); const request = pendingExecution();
  const saved = await writeCache(page, cache => { cache.pendingExecution = request; });
  expect(draftWrites(state)).toEqual([]); await page.evaluate(() => { (window as unknown as { releaseComparisonQueue: () => void }).releaseComparisonQueue(); });
  await page.clock.runFor(1_000); expect(draftWrites(state)).toEqual([]);
  expect((await legacyCache(page)).pendingExecution).toEqual(request); expect(await page.evaluate(key => localStorage.getItem(key), saved.key)).toBe(saved.raw); noBusiness(state);
});

test('material draft comparison: unknown original upload blocks comparison and preserves its request and target', async ({ page }) => {
  const state = await install(page, fixture()); state.dropDraft = 'before'; await mount(page);
  await page.locator('[data-m4-upload="material"]').last().setInputFiles(file); await expect(recovery(page).locator('[data-m4-recovery-action="resume"]')).toBeEnabled();
  const sent = structuredClone(draftWrites(state)[0]), original = await records(page); expect(original).toHaveLength(1);
  expect(uploads(state, 'create')).toHaveLength(1); setServer(state); const cache = await legacyCache(page);
  await writeCache(page, value => { value.drafts.private_summary = { ...cache.drafts.private_summary, dirty: true, conflict: true }; });
  await mount(page, { navigation: 'reload' }); await expect(page.locator('[data-m4-action="resolve-draft"]')).toBeDisabled();
  const before = writes(state).length; await page.clock.runFor(1_000); expect(writes(state)).toHaveLength(before); expect(draftWrites(state)).toEqual([sent]);
  expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1);
  const [kept] = await records(page); expect(kept.value.documentType).toBe('private_summary'); expect(kept.value.id).toBe(original[0].value.id);
  expect(kept.value.basePage).toEqual(original[0].value.basePage); expect(kept.value.items[0].draftRequest).toEqual(sent); expect(kept.value.items[0].requestDigest).toBe(original[0].value.items[0].requestDigest);
  await expect(recovery(page)).toContainText('募集说明书摘要'); await expect(dialog(page)).toHaveCount(0); noBusiness(state);
});

test('material draft comparison: desktop component comparison with exact R34 or current implementation', async ({ page }) => {
  const evidence = process.env.BB_MATERIAL_DRAFT_COMPARISON_EVIDENCE_DIR;
  test.skip(!evidence, 'Opt-in component capture, excluded from business journey counts.');
  const reference = !!process.env.BB_MATERIAL_DRAFT_COMPARISON_REFERENCE;
  const auditReference = reference ? await installMaterialDraftComparisonReference(page) : undefined;
  const state = await install(page, fixture()); const captures: unknown[] = [], phases: unknown[] = [];
  for (const mode of ['changes', 'same'] as const) {
    setServer(state, mode === 'changes' ? state.serverInput : state.localInput); await seedCache(page, state); await mount(page, { navigation: 'same-page' });
    const before = writes(state).length, reads = workspaceGets(state).length, start = state.calls.length;
    await page.locator('[data-m4-action="resolve-draft"]').click(); await expect(page.locator('dialog[open]')).toBeVisible();
    if (!reference) {
      await expect(action(page, mode === 'same' ? 'server' : 'keep')).toBeEnabled();
      if (mode === 'same') await expect(action(page, 'keep')).toHaveCount(0);
    }
    await page.locator('dialog[open]').evaluate(element => { element.scrollTop = 0; const content = element.querySelector<HTMLElement>('[data-draft-comparison-content]'); if (content) content.scrollTop = 0; });
    const audit = { mode, synthetic: true, scope: 'Comparison/capture phase only: no non-GET requests. Dirty local cache is fixture preparation, without a CAS request in this capture test.',
      calls: state.calls, writes_before_open: before, writes_at_capture_start: writes(state).length, workspace_gets_before_open: reads, workspace_gets_after_open: workspaceGets(state).length,
      ...(auditReference ? { reference: await auditReference() } : { reference: null }) };
    expect(writes(state)).toHaveLength(before); expect(workspaceGets(state)).toHaveLength(reads + 1); noBusiness(state);
    const top = await captureMaterialDraftComparison(page, evidence!, `${reference ? 'r34-reference' : 'current'}-${mode}-top-1440`, { ...audit, framing: reference ? 'R34 dialog and both JSON pre elements at top; all scroll offsets recorded.' : 'Current dialog and independently scrolling comparison body at top; all scroll offsets recorded.' });
    captures.push(top);
    if (mode === 'changes') {
      const framing = await page.locator('dialog[open]').evaluate((element, reference) => {
        const modal = element as HTMLDialogElement;
        if (!reference) {
          const content = modal.querySelector<HTMLElement>('[data-draft-comparison-content]')!;
          const target = modal.querySelector<HTMLElement>('[data-draft-comparison-row="requirements"]')!;
          content.scrollTop += target.getBoundingClientRect().top - content.getBoundingClientRect().top - 8;
          return 'Current comparison body scrolled to its requirements business row; header/footer stay outside that scroll container and all actual offsets are recorded.';
        }
        for (const pre of modal.querySelectorAll('pre')) {
          const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT); let node: Node | null;
          while ((node = walker.nextNode())) {
            const index = node.textContent?.indexOf('"requirements":') ?? -1;
            if (index < 0) continue;
            const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + '"requirements":'.length);
            // R34 gives each pre its own 220px scroller. Scrolling only the
            // dialog leaves that JSON text at its old top, as first evidence showed.
            pre.scrollTop += range.getBoundingClientRect().top - pre.getBoundingClientRect().top - 12;
            break;
          }
        }
        return 'Both R34 JSON pre elements independently scrolled to their requirements property using DOM text ranges; each pre scroll/marker geometry is recorded. This is not the same content offset as the current business row.';
      }, reference);
      const requirements = await captureMaterialDraftComparison(page, evidence!, `${reference ? 'r34-reference' : 'current'}-changes-requirements-1440`, { ...audit, framing });
      captures.push(requirements);
      if (!reference) {
        expect(requirements.comparisonContent!.scrollTop).toBeGreaterThan(top.comparisonContent!.scrollTop);
        expect(requirements.dialog!.scrollTop).toBe(top.dialog!.scrollTop);
        expect(Math.abs(requirements.header!.box.top - top.header!.box.top)).toBeLessThanOrEqual(1);
        expect(Math.abs(requirements.footer!.box.top - top.footer!.box.top)).toBeLessThanOrEqual(1);
        expect(requirements.requirementParagraphs.filter(value => value.text?.includes('LONG_REQUIREMENT_END_') && value.inViewport)).toHaveLength(2);
      }
      expect(writes(state)).toHaveLength(before);
    }
    phases.push({ mode, calls_from_open_through_capture: state.calls.slice(start), non_gets_before_open: before, non_gets_after_all_captures: writes(state).length, zero_writes_in_phase: writes(state).length === before });
    await page.locator(reference ? 'dialog[open] [data-close]' : 'dialog[open] [data-draft-comparison-action="close"]').click();
  }
  await mkdir(evidence!, { recursive: true });
  await writeFile(join(evidence!, `${reference ? 'r34-reference' : 'current'}-capture-summary.json`), JSON.stringify({ reference, phases, captures, calls: state.calls, writes: writes(state), errors: state.errors, unexpected: state.unexpected }, null, 2));
});
