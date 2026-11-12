import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertFixture, fixture, install, marker, mutations, projectId, runId, setup, title, type State } from './review-followup-fixtures';

test.afterEach(({ page }) => assertFixture(page));
const modal = (page: Page) => page.getByRole('dialog', { name: '准备下一轮复核', exact: true });
const save = (page: Page) => modal(page).getByRole('button', { name: '保存要求并去补料', exact: true });
async function editor(page: Page, version = 1) {
  const host = page.locator('#review-results-panel');
  await expect(host.locator('[data-editor-history]')).toHaveValue(runId(version));
  await expect(host.locator('[data-editor-document]')).toContainText(marker(version));
  return host;
}
async function openEditor(page: Page, version = 1) {
  const host = await editor(page, version); await host.locator('[data-editor-followup]').click();
  await expect(modal(page)).toBeVisible(); return modal(page);
}
async function expectSaved(page: Page, state: State, requirement: string, count = 2) {
  await expect(modal(page)).not.toBeVisible();
  await expect(page.getByRole('tab', { name: '材料与要求', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#review-requirements')).toBeFocused();
  await expect.poll(() => state.draft.requirements.length).toBe(count);
  expect(state.draft.requirements.filter(item => item === requirement)).toHaveLength(1);
  await expect(page.locator('#review-requirements')).toHaveValue(state.draft.requirements.join('\n'));
}
async function evidence(page: Page, name: string) {
  const output = process.env.BB_UX_EVIDENCE_DIR; if (!output) return;
  await mkdir(output, { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 960 : 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: join(output, `review-followup-${name}-${width}.png`), fullPage: true });
    const dialog = modal(page);
    if (await dialog.isVisible()) {
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: join(output, `review-followup-${name}-${width}-viewport.png`), fullPage: false });
      await save(page).scrollIntoViewIfNeeded(); await expect(save(page)).toBeInViewport();
      await page.screenshot({ path: join(output, `review-followup-${name}-${width}-actions-viewport.png`), fullPage: false });
    }
  }
}

test('historical editor V1 adds one durable requirement without silently adopting latest V2 or executing', async ({ page }) => {
  const state = await setup(page), originalSource = structuredClone(state.draft.source_material_ref);
  await editor(page); await evidence(page, 'editor-v1-results');
  const dialog = await openEditor(page);
  await expect(dialog).toContainText('本次待复核稿：合成待复核稿-v2.docx');
  await expect(dialog).toContainText('关注事项不会缩小完整复核范围');
  const text = await dialog.locator('#review-followup-text').inputValue();
  expect(text).toContain('V1'); expect(text).toContain(title(1)); expect(text).toContain(marker(1));
  expect(text).toContain('同口径现金流附注'); expect(text).not.toContain(title(2));
  await expect(dialog.locator('#review-followup-clean')).not.toBeChecked();
  await evidence(page, 'editor-v1-dialog');
  await save(page).click(); await expectSaved(page, state, text);
  expect(state.draft.source_material_ref).toEqual(originalSource); expect(state.sources).toEqual([]);
  expect(state.executions).toEqual([]); expect(state.quotes).toEqual([]); expect(state.exports).toEqual([]);
  expect(state.catalog.current_version_id).toBe('followup-clean-version-2'); expect(state.catalog.selection_revision).toBe(9);
  expect(state.draft.evidence_links).toEqual([]);
  await page.reload(); await expect(page.locator('#review-requirements')).toHaveValue(['原已保存要求。', text].join('\n'));
  await page.getByRole('tab', { name: '复核结果', exact: true }).click(); await openEditor(page);
  await save(page).click(); await expectSaved(page, state, text);
  expect(state.draft.requirements).toEqual(['原已保存要求。', text]);
  await evidence(page, 'saved-materials');
});

test('failed CAS save retains modal edits and retry replaces failed text A with edited text B once', async ({ page }) => {
  const state = await setup(page); state.failDraft = true; const dialog = await openEditor(page);
  const edited = `来源成果 V1；${title(1)}；请按补充附注核对现金流。`;
  await dialog.locator('#review-followup-text').fill(edited); await save(page).click();
  await expect(dialog.locator('#review-dialog-status')).toContainText('下一轮要求尚未保存确认');
  await expect(dialog).toBeVisible(); await expect(dialog.locator('#review-followup-text')).toHaveValue(edited);
  await expect(dialog.locator('#review-followup-text')).toBeEditable();
  expect(state.draft.requirements).toEqual(['原已保存要求。']); expect(state.executions).toEqual([]);
  const revised = `来源成果 V1；${title(1)}；改为先确认审计口径和单位，再补充附注。`;
  await dialog.locator('#review-followup-text').fill(revised);
  state.failDraft = false; await save(page).click(); await expectSaved(page, state, revised);
  expect(state.drafts).toHaveLength(2); expect(state.draft.requirements).toEqual(['原已保存要求。', revised]);
  expect(state.draft.requirements).not.toContain(edited);
  await page.reload(); await expect(page.locator('#review-requirements')).toHaveValue(['原已保存要求。', revised].join('\n'));
});

test('readable historical V1 item saves its explanation as text and requires an explicit full-review start', async ({ page }) => {
  const state = await setup(page, fixture('readable'));
  const item = page.locator('[data-readable-item]').filter({ hasText: title(1) });
  await item.locator('summary').click(); await evidence(page, 'readable-v1-results'); await item.locator('[data-readable-followup]').click();
  const dialog = modal(page); await expect(dialog).toBeVisible();
  const text = await dialog.locator('#review-followup-text').inputValue();
  expect(text).toContain('V1'); expect(text).toContain(title(1)); expect(text).toContain(marker(1));
  expect(text).not.toContain('**'); expect(text).not.toContain('__');
  expect(text).not.toContain(title(2)); await expect(dialog.locator('#review-followup-clean')).toHaveCount(0);
  await evidence(page, 'readable-v1-dialog');
  await save(page).click(); await expectSaved(page, state, text);
  expect(state.executions).toEqual([]); expect(state.quotes).toEqual([]); expect(state.draft.evidence_links).toEqual([]);
  await page.reload(); await expect(page.locator('#review-requirements')).toHaveValue(['原已保存要求。', text].join('\n'));
  await page.getByRole('button', { name: '开始复核', exact: true }).click();
  await expect.poll(() => state.executions.length).toBe(1); expect(state.quotes).toHaveLength(1);
  expect(state.executions[0]).toMatchObject({ operation: 'full_review', source_report_id: null, finding_ids: [], expected_plan_version: null });
  expect(state.executions[0].expected_input_version).toBe(state.draft.version);
  expect(state.history[0].input.requirements).toEqual(['原已保存要求。', text]);
  expect(state.history[0].finding_ids).toEqual([]); expect(state.history[0].input.evidence_links).toEqual([]);
  await expect(page.locator('[data-review-tab="making"]')).toHaveAttribute('aria-selected', 'true');
});

for (const action of ['discuss', 'dispute', 'explain'] as const) {
  test(`structured finding ${action} reaches the same next-round requirement flow`, async ({ page }) => {
    const state = await setup(page, fixture('structured'));
    const finding = page.locator('[data-finding-id="public-finding-1"]'); await finding.locator('summary').click();
    await finding.locator(`[data-review-action="${action}"]`).first().click();
    if (action === 'explain') await page.getByRole('dialog', { name: '问题解释', exact: true }).getByRole('button', { name: '补充复核要求', exact: true }).click();
    const dialog = modal(page); await expect(dialog).toBeVisible();
    const text = await dialog.locator('#review-followup-text').inputValue();
    expect(text).toContain(title(1)); expect(text).toContain('V1'); expect(text).not.toContain(title(2));
    await expect(dialog.locator('#review-followup-clean')).toHaveCount(0);
    await save(page).click(); await expectSaved(page, state, text);
    expect(state.reports.get('followup-report-1')!.findings[0].conclusion).toBe('needs_evidence');
    expect(state.executions).toEqual([]); expect(state.exports).toEqual([]); expect(state.draft.evidence_links).toEqual([]);
    expect(mutations(state).map(c => c.path)).toEqual([`/projects/${projectId}/review-draft`]);
  });
}

test('explicitly choosing historical clean V1 imports the exact catalog artifact while project current stays V2', async ({ page }) => {
  const state = await setup(page); const dialog = await openEditor(page);
  await expect(dialog).toContainText('项目文件 V41');
  await dialog.locator('#review-followup-clean').check();
  const text = await dialog.locator('#review-followup-text').inputValue();
  await save(page).click(); await expectSaved(page, state, text);
  expect(state.sources).toEqual([{ version_id: 'followup-clean-version-1' }]);
  const imported = state.extraMaterials[0];
  expect(state.draft.source_material_ref).toEqual({ material_id: imported.material_id, material_version: 1, sha256: state.metadata.get('followup-1-clean')!.sha256 });
  expect(state.draft.material_versions).toContainEqual(state.draft.source_material_ref);
  expect(state.catalog.current_version_id).toBe('followup-clean-version-2'); expect(state.catalog.selection_revision).toBe(9);
  expect(state.executions).toEqual([]); expect(state.quotes).toEqual([]);
  await page.reload(); await expect(page.locator('#review-project-source')).toHaveValue('v:followup-clean-version-1');
  await page.getByRole('button', { name: '开始复核', exact: true }).click();
  await expect.poll(() => state.executions.length).toBe(1);
  expect(state.executions[0]).toMatchObject({ operation: 'full_review', source_report_id: null, finding_ids: [] });
  expect(state.history[0].input.source_material_ref).toEqual(state.draft.source_material_ref);
});

test('mismatched imported clean hash keeps the modal and never replaces the saved source or requirements', async ({ page }) => {
  const state = await setup(page); state.importedMismatch = 'sha256';
  const source = structuredClone(state.draft.source_material_ref), dialog = await openEditor(page);
  await dialog.locator('#review-followup-clean').check();
  const text = await dialog.locator('#review-followup-text').inputValue(); await save(page).click();
  await expect(dialog.locator('#review-dialog-status')).toContainText('清洁版保存回执与所选版本不一致');
  await expect(dialog).toBeVisible(); await expect(dialog.locator('#review-followup-text')).toHaveValue(text);
  expect(state.draft.source_material_ref).toEqual(source); expect(state.draft.requirements).toEqual(['原已保存要求。']);
  expect(state.drafts).toEqual([]); expect(state.executions).toEqual([]);
  state.importedMismatch = undefined; await save(page).click(); await expectSaved(page, state, text);
  expect(state.sources).toEqual([{ version_id: 'followup-clean-version-1' }, { version_id: 'followup-clean-version-1' }]);
});

test('ambiguous clean catalog entries do not offer an adoption shortcut or guess a latest version', async ({ page }) => {
  const state = fixture(); state.catalog.versions.push({ ...state.catalog.versions.find(v => v.run_id === runId(1))!, version_id: 'ambiguous-v1-clean' });
  await setup(page, state); const dialog = await openEditor(page);
  await expect(dialog.locator('#review-followup-clean')).toHaveCount(0); await expect(dialog).toContainText('唯一核实');
  const text = await dialog.locator('#review-followup-text').inputValue(); await save(page).click(); await expectSaved(page, state, text);
  expect(state.sources).toEqual([]); expect(state.draft.source_material_ref?.material_version).toBe(2);
});

test('dirty manual choices require free export before preparing another review and free export does not quote AI', async ({ page }) => {
  const state = await setup(page); const host = await editor(page);
  await host.getByRole('radio', { name: '手动修改', exact: true }).check();
  await host.getByLabel('替换原文的内容', { exact: true }).fill('合成人工确认现金流为 130 万元。');
  await expect(host.locator('[data-editor-followup]')).toBeDisabled();
  await expect(host).toContainText('免费导出');
  await host.locator('[data-editor-save]').click(); await expect.poll(() => state.exports.length).toBe(1);
  expect(state.exports[0]).toMatchObject({ source_run_id: runId(1), decisions: [{ id: 'editor-item-1', decision: 'manual', manual_text: '合成人工确认现金流为 130 万元。' }] });
  expect(state.quotes).toEqual([]); expect(state.executions).toEqual([]); expect(state.sources).toEqual([]);
  await expect(page.locator('[data-review-tab="making"]')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: '复核结果', exact: true }).click(); await editor(page);
  await page.getByRole('link', { name: '查看最新成果 V3', exact: true }).click(); await editor(page, 3);
  await expect(page.locator('[data-editor-followup]')).toBeEnabled(); const dialog = await openEditor(page, 3);
  await expect(dialog).toContainText('来源成果 V3'); await expect(dialog).toContainText('项目文件 V43');
});

test('unknown free-export receipt locks the followup entry and reload never submits or starts another review', async ({ page }) => {
  const state = await setup(page); state.dropExport = true; const host = await editor(page);
  await host.getByRole('radio', { name: '手动修改', exact: true }).check();
  await host.locator('[data-editor-save]').click(); await expect.poll(() => state.exports.length).toBe(1);
  await expect(host.locator('[data-editor-status]')).toContainText('处理选择已保留并锁定');
  await expect(host.locator('[data-editor-followup]')).toBeDisabled();
  await page.reload(); const restored = await editor(page); await expect(restored.locator('[data-editor-followup]')).toBeDisabled();
  await expect(restored.locator('[data-editor-status]')).toContainText('尚未确认');
  expect(state.exports).toHaveLength(1); expect(state.executions).toEqual([]); expect(state.quotes).toEqual([]);
});

test('supplements during a running review become next-round requirements and leave the frozen current input unchanged', async ({ page }) => {
  const state = fixture(), running = state.addRunning(), fixed = structuredClone(running.input); await setup(page, state);
  const dialog = await openEditor(page); await expect(dialog).toContainText('当前任务输入已固定，本次补充只用于下一轮');
  const text = await dialog.locator('#review-followup-text').inputValue(); await save(page).click(); await expectSaved(page, state, text);
  expect(running.input).toEqual(fixed); expect(running.input.requirements).toEqual(['原已保存要求。']);
  expect(state.activeRun?.run_id).toBe(runId(3)); await expect(page.locator('#review-materials-panel [data-review-action="review"]')).toBeDisabled();
  expect(state.executions).toEqual([]); expect(state.quotes).toEqual([]);
});

test('historical structured source download pins material V1 when the draft contains V2', async ({ page }) => {
  const state = await setup(page, fixture('structured')); const finding = page.locator('[data-finding-id="public-finding-1"]');
  await finding.locator('summary').click(); await finding.locator('[data-review-action="source"]').first().click();
  const dialog = page.getByRole('dialog', { name: '依据定位', exact: true }); await expect(dialog).toContainText('V1');
  const complete = page.waitForEvent('download'); await dialog.getByRole('button', { name: '下载原材料', exact: true }).click();
  const file = await complete; expect(file.suggestedFilename()).toBe('合成待复核稿-v1.docx');
  expect(await readFile((await file.path())!, 'utf8')).toBe(state.materialBytes.get(1));
  expect(state.materialReads).toEqual([1]); expect(state.materialDownloads).toEqual([1]);
  expect(state.calls.filter(c => c.path.includes('/materials/followup-source')).map(c => c.search)).toEqual(['?version=1', '?version=1']);
  expect(mutations(state)).toEqual([]);
});

for (const mode of ['editor', 'readable'] as const) {
  test(`default results URL without a run opens the displayed latest ${mode} item followup`, async ({ page }) => {
    const state = await install(page, fixture(mode)); await page.goto(`/#/projects/${projectId}/review?tab=results`);
    if (mode === 'editor') await openEditor(page, 2);
    else { const item = page.locator('[data-readable-item]').filter({ hasText: title(2) }); await item.locator('summary').click(); await item.locator('[data-readable-followup]').click(); }
    const dialog = modal(page); await expect(dialog).toBeVisible();
    const text = await dialog.locator('#review-followup-text').inputValue(); expect(text).toContain(title(2)); expect(text).not.toContain(title(1));
    await save(page).click(); await expectSaved(page, state, text);
    expect(state.executions).toEqual([]); expect(state.quotes).toEqual([]);
  });
}

test('a slow exact-clean import cannot overwrite a server draft refreshed during the receipt wait', async ({ page }) => {
  const state = await setup(page); let release!: () => void;
  state.sourceGate = () => new Promise<void>(resolve => { release = resolve; });
  const dialog = await openEditor(page), originalVersion = state.draft.version;
  await dialog.locator('#review-followup-clean').check();
  const text = await dialog.locator('#review-followup-text').inputValue(); await save(page).click();
  await expect.poll(() => state.sources.length).toBe(1);
  const concurrent = { ...structuredClone(state.draft), version: originalVersion + 1, requirements: ['另一页面已保存的并发要求，不能被旧快照覆盖。'] };
  state.draft = structuredClone(concurrent); const reads = state.workspaceReads;
  await page.evaluate(() => window.dispatchEvent(new Event('online'))); await expect.poll(() => state.workspaceReads).toBeGreaterThan(reads);
  release();
  await expect(dialog.locator('#review-followup-text')).toBeEditable(); await expect(dialog).toBeVisible();
  await expect(dialog.locator('#review-followup-text')).toHaveValue(text);
  expect(state.draft).toEqual(concurrent);
  expect(state.drafts.every(d => d.expected_version === originalVersion)).toBe(true);
  expect(state.draft.requirements).not.toContain(text); expect(state.executions).toEqual([]);
});

test('an explanation opened before a new report refresh cannot relabel the old finding as the new report', async ({ page }) => {
  const state = fixture('structured'); state.history.splice(state.history.findIndex(h => h.run.run_id === runId(2)), 1); state.reports.delete('followup-report-2');
  await install(page, state); await page.goto(`/#/projects/${projectId}/review?tab=results`);
  const finding = page.locator('[data-finding-id="public-finding-1"]'); await finding.locator('summary').click();
  await finding.locator('[data-review-action="explain"]').click(); const explanation = page.getByRole('dialog', { name: '问题解释', exact: true });
  await expect(explanation).toContainText(title(1)); state.addVersion(3); const reads = state.workspaceReads;
  await page.evaluate(() => window.dispatchEvent(new Event('online'))); await expect.poll(() => state.workspaceReads).toBeGreaterThan(reads);
  await expect(page.locator('#review-results-panel')).toContainText(title(1));
  await expect(page.getByRole('link', { name: '查看最新成果 V3', exact: true })).toBeVisible();
  await explanation.getByRole('button', { name: '补充复核要求', exact: true }).click();
  await expect(modal(page)).toBeVisible();
  const text = await modal(page).locator('#review-followup-text').inputValue(); expect(text).toContain('V1'); expect(text).not.toContain('V3');
  expect(mutations(state)).toEqual([]); expect(state.draft.requirements).toEqual(['原已保存要求。']);
});

test('a readable dimension with prose and no parsed items can still prepare exact V1 supplemental requirements', async ({ page }) => {
  const state = fixture('readable'); state.readableProse = true; await setup(page, state);
  await expect(page.locator('[data-readable-item]')).toHaveCount(0);
  await page.locator('[data-readable-followup-section="financial"]').click();
  const dialog = modal(page); await expect(dialog).toBeVisible();
  const text = await dialog.locator('#review-followup-text').inputValue();
  expect(text).toContain('财务'); expect(text).toContain('V1'); expect(text).toContain(marker(1)); expect(text).not.toContain('V2');
  await save(page).click(); await expectSaved(page, state, text); expect(state.executions).toEqual([]);
});

for (const drop of ['before', 'after'] as const) {
  test(`lost draft ${drop === 'after' ? 'response after commit is reconciled read-only' : 'request before commit remains editable until explicit retry'}`, async ({ page }) => {
    const state = await setup(page); state.dropDraft = drop; const dialog = await openEditor(page);
    const text = await dialog.locator('#review-followup-text').inputValue(); await save(page).click();
    if (drop === 'before') {
      await expect(dialog.locator('#review-dialog-status')).toContainText('下一轮要求尚未保存确认');
      await expect(dialog.locator('#review-followup-text')).toHaveValue(text); await expect(dialog.locator('#review-followup-text')).toBeEditable();
      expect(state.drafts).toHaveLength(1); expect(state.draft.requirements).toEqual(['原已保存要求。']);
      await save(page).click();
    }
    await expectSaved(page, state, text); expect(state.drafts).toHaveLength(drop === 'after' ? 1 : 2);
    expect(state.draft.requirements).toEqual(['原已保存要求。', text]); expect(state.executions).toEqual([]); expect(state.quotes).toEqual([]);
  });
}

test('unknown draft request with a newer different server body becomes a conflict instead of borrowing the newer version', async ({ page }) => {
  const state = await setup(page), originalVersion = state.draft.version;
  const concurrent = { ...structuredClone(state.draft), version: originalVersion + 1, requirements: ['其他页面刚保存的现金流证据口径。'] };
  state.dropDraft = 'before'; state.afterDropDraft = () => { state.draft = structuredClone(concurrent); };
  const dialog = await openEditor(page), text = await dialog.locator('#review-followup-text').inputValue();
  await save(page).click(); await expect(dialog.locator('#review-dialog-status')).toContainText('下一轮要求尚未保存确认');
  const reads = state.workspaceReads; await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => state.workspaceReads).toBeGreaterThan(reads);
  await expect(dialog.locator('#review-followup-text')).toHaveValue(text); expect(state.draft).toEqual(concurrent); expect(state.drafts).toHaveLength(1);
  await save(page).click(); await expect(dialog.locator('#review-dialog-status')).toContainText('版本冲突');
  expect(state.drafts).toHaveLength(1); expect(state.draft).toEqual(concurrent); expect(state.executions).toEqual([]);
});

test('a concrete editor item leads through real supplement upload to a fixed full review while old V1 remains downloadable', async ({ page }) => {
  const state = await setup(page), dialog = await openEditor(page);
  const requirement = await dialog.locator('#review-followup-text').inputValue(); await save(page).click(); await expectSaved(page, state, requirement);
  const section = page.locator('.material-partition').filter({ has: page.getByRole('heading', { name: '审计报告 / 财务报表及附注', exact: true }) });
  await expect(section).toBeVisible();
  const picker=section.locator('#review-upload-audit');await expect(picker).toBeEnabled();await expect(picker).toHaveAttribute('data-review-upload-role','audit');
  await picker.setInputFiles({ name: '合成补充现金流报表.csv', mimeType: 'text/csv',
    buffer: Buffer.from('期间,项目,金额\n2025,经营现金流,130\n', 'utf8') });
  await expect.poll(() => state.supplement?.state).toBe('persisted');
  const pin = { material_id: state.supplement!.material_id, material_version: 1, sha256: state.supplement!.sha256 };
  await expect.poll(() => state.draft.material_versions.some(m => m.material_id === pin.material_id && m.sha256 === pin.sha256)).toBe(true);
  await expect(page.locator('.material-file-main').filter({ hasText: '合成补充现金流报表.csv' })).toContainText('已保存');
  expect(state.uploads).toHaveLength(1); expect(state.uploads[0].role).toBe('audit');expect(state.supplement!.role).toBe('audit'); expect(state.uploadedBytes).toBe(1);
  expect(state.executions).toEqual([]); expect(state.quotes).toEqual([]);
  await page.getByRole('button', { name: '开始复核', exact: true }).click(); await expect.poll(() => state.executions.length).toBe(1);
  expect(state.executions[0]).toMatchObject({ operation: 'full_review', source_report_id: null, finding_ids: [], expected_plan_version: null });
  const fixed = structuredClone(state.history[0].input); expect(fixed.material_versions).toContainEqual(pin); expect(fixed.requirements).toContain(requirement);
  expect(fixed.evidence_links).toEqual([]); expect(state.executions[0].expected_input_version).toBe(state.history[0].input_revision);
  await expect(page.locator('[data-review-tab="making"]')).toHaveAttribute('aria-selected', 'true');
  state.completeActive(); const reads = state.workspaceReads;
  await page.evaluate(() => window.dispatchEvent(new Event('online'))); await expect.poll(() => state.workspaceReads).toBeGreaterThan(reads);
  expect(state.history[0].input).toEqual(fixed);
  await page.getByRole('tab', { name: '复核结果', exact: true }).click(); const old = await editor(page, 1);
  await expect(page.getByRole('link', { name: '查看最新成果 V3', exact: true })).toBeVisible();
  const completed = page.waitForEvent('download'); await old.getByRole('button', { name: '下载清洁版', exact: true }).click();
  const file = await completed; expect(file.suggestedFilename()).toBe('合成复核成果V1-clean.docx');
  expect(await readFile((await file.path())!, 'utf8')).toBe(state.bytes.get('followup-1-clean'));
  await page.getByRole('link', { name: '查看最新成果 V3', exact: true }).click(); await editor(page, 3);
  expect(state.executions).toHaveLength(1); expect(state.exports).toEqual([]);
});
