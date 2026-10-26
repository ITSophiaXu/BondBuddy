import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { M4_DOCUMENT_LABELS, M4_DOCUMENT_TYPES, type M4Artifact, type Run } from '@bondbuddy/contracts';
import { artifact, artifactPin, priorPin, fixture, documentTask, install, mount, open, card, priorButton, baselineButton, making,
  snapshot, observe, unchanged, settle, expectOpened, refreshWithSelectedText, previewReads, previewPath, previewContent,
  ids, now, hash, targetRun, writes, noBusiness, type State } from './material-prior-result-fixtures';
import { installMaterialPriorResultReference, captureMaterialPriorResult } from './material-prior-result-reference';

const baseline = process.env.BB_MATERIAL_PRIOR_BASELINE === '1';
const evidence = process.env.BB_MATERIAL_PRIOR_EVIDENCE;
const reference = process.env.BB_MATERIAL_PRIOR_REFERENCE === '1';
test.use({ viewport: { width: 1440, height: 960 } });

const displayTime = (page: Page, value: string) => page.evaluate(value => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)), value);
async function selected(page: Page, state: State, a: M4Artifact, mode: 'base' | 'history') {
  await expect(making(page)).toBeVisible(); await expect(card(page)).toHaveAttribute('data-prior-mode', mode);
  await expect(card(page).locator('h3')).toHaveText(mode === 'base' ? '本次修改基于' : '此前同类成果');
  await expect(card(page)).toContainText(a.filename); await expect(card(page)).toContainText(M4_DOCUMENT_LABELS.private_summary);
  await expect(card(page)).toContainText('第 ' + a.revision_number + ' 稿');
  if (Number.isFinite(Date.parse(a.created_at))) await expect(card(page)).toContainText(await displayTime(page, a.created_at));
  await expect(priorButton(page)).toHaveText(mode === 'base' ? '查看本次修改底稿' : '查看此前同类成果');
  await expect(priorButton(page)).toHaveAttribute('data-run', state.task.run.run_id);
  await expect(priorButton(page)).toHaveAttribute('data-prior-pin', priorPin(a));
  expect(previewReads(state)).toEqual([]);
}
async function noTarget(page: Page, state: State, mode: 'base' | 'none', reason: RegExp) {
  await expect(making(page)).toBeVisible(); await expect(card(page)).toHaveAttribute('data-prior-mode', mode);
  await expect(priorButton(page)).toHaveCount(0); await expect(card(page)).toContainText(reason); expect(previewReads(state)).toEqual([]);
}
async function online(page: Page, state: State) {
  const reads = state.workspaceReads; await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => state.workspaceReads).toBe(reads + 1);
  await page.evaluate(async () => { await (window as unknown as { m4Component?: { refreshing?: Promise<void> } }).m4Component?.refreshing; });
}
async function openAndCheck(page: Page, state: State, a: M4Artifact, mode: 'base' | 'history', before = snapshot(state)) {
  await open(page, state); await selected(page, state, a, mode); await priorButton(page).click();
  await expectOpened(page, state, a); await unchanged(page, state, before);
}

if (baseline) {
  for (const mode of ['base', 'history'] as const) test('material-prior-result baseline diagnostic: R36 ' + mode + ' shortcut opens the last other document type', async ({ page }) => {
    const auditReference = await installMaterialPriorResultReference(page), state = fixture(mode), before = snapshot(state);
    await open(page, state); await expect(making(page)).toBeVisible(); await expect(card(page)).toHaveCount(0);
    await expect(baselineButton(page)).toHaveAttribute('data-artifact', state.other.artifact_id + ':' + state.other.artifact_version);
    await baselineButton(page).click(); await expectOpened(page, state, state.other); await unchanged(page, state, before);
    const audit = await auditReference(), output = process.env.BB_MATERIAL_PRIOR_BASELINE_EVIDENCE;
    if (output) { await mkdir(output, { recursive: true }); await writeFile(join(output, 'r36-' + mode + '-wrong-type-diagnostic.json'), JSON.stringify({
      audit, mode, frozen_manifest: state.task.manifest, before, observed_local: await observe(page), observed_server: snapshot(state), calls: state.calls,
      conclusion: 'Observed accurate R36 behavior through its real entryRunId making view and visible shortcut. It opens another document type; this passed diagnostic is separate from desired new-business checks.',
    }, null, 2)); }
  });
} else if (evidence) {
  test('material-prior-result collector: desktop task relationship with accurate R36 component reference', async ({ page }) => {
    const auditReference = reference ? await installMaterialPriorResultReference(page) : undefined, state = fixture();
    state.task.run.state = 'failed'; state.workspace.active_run = null;
    const historyInput = structuredClone(state.task.manifest.input); historyInput.edit_base = null;
    const historyTask = documentTask(historyInput, targetRun + '-history', 'failed');
    const missingInput = structuredClone(state.task.manifest.input); missingInput.edit_base = { ...artifactPin(state.base), artifact_id: 'unavailable-fixed-bottom-draft' };
    const missingTask = documentTask(missingInput, targetRun + '-unavailable', 'failed'); state.workspace.tasks.push(historyTask, missingTask);
    const before = snapshot(state), phases: unknown[] = [], captures: unknown[] = [];
    await install(page, state);
    const tasks = [{ task: state.task, mode: 'base', expected: state.base }, { task: historyTask, mode: 'history', expected: state.recent },
      ...(!reference ? [{ task: missingTask, mode: 'unavailable', expected: undefined }] : [])];
    for (const [index, entry] of tasks.entries()) {
      const start = state.calls.length; await mount(page, { runId: entry.task.run.run_id, samePage: index > 0 }); await expect(making(page, entry.task.run.run_id)).toBeVisible();
      if (!reference) {
        await expect(card(page)).toContainText(entry.mode === 'base' || entry.mode === 'unavailable' ? '本次修改基于' : '此前同类成果');
        if (entry.expected) {
          await expect(card(page)).toContainText(entry.expected.filename); await expect(card(page)).toContainText('第 ' + entry.expected.revision_number + ' 稿');
          await expect(card(page)).toContainText(M4_DOCUMENT_LABELS.private_summary); await expect(card(page)).toContainText('登记于');
          await expect(card(page)).toContainText(await displayTime(page, entry.expected.created_at));
          await expect(priorButton(page)).toHaveAttribute('data-prior-pin', priorPin(entry.expected));
        } else { await expect(priorButton(page)).toHaveCount(0); await expect(card(page)).toContainText('本工作区内暂无法准确定位'); }
        if (entry.mode === 'base' || entry.mode === 'unavailable') await card(page).locator('summary').click();
      } else await expect(baselineButton(page)).toBeVisible();
      await page.evaluate(() => { scrollTo(0, 0); const content = document.querySelector('#m4-content'); if (content) content.scrollTop = 0; });
      const audit = auditReference ? await auditReference() : { implementation: 'current', mode: entry.mode };
      captures.push(await captureMaterialPriorResult(page, evidence, (reference ? 'r36-reference-' : 'current-') + entry.mode + '-1440', {
        ...audit, task_run: entry.task.run.run_id, frozen_manifest: entry.task.manifest, expected_current_artifact: entry.expected ?? null,
        phase_scope: 'Real entryRunId making view, disclosure only. No artifact navigation or business writes in the screenshot phase.',
      }));
      const calls = state.calls.slice(start); expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
      phases.push({ mode: entry.mode, calls, zero_writes: true, scroll_y: await page.evaluate(() => scrollY) }); await unchanged(page, state, before);
    }
    // Navigation is audited after all read-only captures so its original view PUT is not called a screenshot write.
    await mount(page, { runId: historyTask.run.run_id, samePage: true }); const navigationStart = state.calls.length;
    if (reference) await baselineButton(page).click(); else await priorButton(page).click();
    await expectOpened(page, state, reference ? state.other : state.recent); await unchanged(page, state, before);
    await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, (reference ? 'r36-reference' : 'current') + '-capture-summary.json'), JSON.stringify({
      reference, comparison_scope: 'Same fixture, real no-own-document task entry, 1440 by 960 and scroll zero. Common base/history making views; current additionally shows unavailable fixed reference.',
      captures, phases, navigation_phase: { calls: state.calls.slice(navigationStart), permits_only_original_view_save: true },
      before, observed_local: await observe(page), observed_server: snapshot(state), calls: state.calls, errors: state.errors, unexpected: state.unexpected,
    }, null, 2));
  });
} else {
  test('material-prior-result: frozen manifest base opens its exact file despite newer same-type and other-type records and different current draft', async ({ page }) => {
    const state = fixture(); await openAndCheck(page, state, state.base, 'base');
    expect(state.task.manifest.input.edit_base).not.toEqual(state.workspace.drafts.private_summary.edit_base);
  });

  test('material-prior-result: the visible recent task button reaches the same fixed base without a private producer', async ({ page }) => {
    const state = fixture(), before = snapshot(state); await open(page, state, { runId: null });
    const entry = page.locator('[data-m4-action="task"][data-run="' + targetRun + '"]'); await expect(entry).toHaveText('查看生成进度');
    await entry.click(); await selected(page, state, state.base, 'base'); await priorButton(page).click();
    await expectOpened(page, state, state.base); await unchanged(page, state, before);
  });

  test('material-prior-result: history uses the nearest earlier same type independent of array order, revision number and run updated time', async ({ page }) => {
    const state = fixture('history'); state.base.revision_number = 99;
    state.workspace.artifacts = [state.late, state.recent, state.other, state.base];
    await openAndCheck(page, state, state.recent, 'history');
  });

  test('material-prior-result: explicit time zone offsets are compared as instants', async ({ page }) => {
    const state = fixture('history'); state.recent.created_at = '2026-10-25T18:20:00+08:00';
    await openAndCheck(page, state, state.recent, 'history');
  });

  for (const status of ['failed', 'paused', 'cancelled'] as Run['state'][]) test('material-prior-result: a ' + status + ' task retains its own frozen modification base', async ({ page }) => {
    const state = fixture(); state.task.run.state = status; if (status === 'paused') state.task.run.stage = 'user_paused';
    state.workspace.active_run = status === 'paused' ? state.task.run : null; await openAndCheck(page, state, state.base, 'base');
  });

  test('material-prior-result: a fixed pin remains the modification base when its recorded date is after task submission', async ({ page }) => {
    const state = fixture(); state.base.created_at = '2026-10-25T12:01:00Z'; await openAndCheck(page, state, state.base, 'base');
  });

  test('material-prior-result: a fixed pin with an unverifiable date remains locatable and discloses the uncertain date', async ({ page }) => {
    const state = fixture(); state.base.created_at = 'unverifiable-artifact-date'; const before = snapshot(state);
    await open(page, state); await selected(page, state, state.base, 'base'); await expect(card(page)).toContainText('登记时间暂不可核实');
    await priorButton(page).click(); await expectOpened(page, state, state.base); await unchanged(page, state, before);
  });

  const unavailable: { name: string; change: (state: State) => void }[] = [
    { name: 'missing fixed artifact', change: state => { state.workspace.artifacts = state.workspace.artifacts.filter(a => a !== state.base); } },
    { name: 'different hash', change: state => { state.task.manifest.input.edit_base!.sha256 = hash('unavailable hash'); } },
    { name: 'malformed stored fixed hash in a defensive API snapshot', change: state => { state.task.manifest.input.edit_base!.sha256 = 'not-a-sha256'; } },
    { name: 'different version', change: state => { state.task.manifest.input.edit_base!.artifact_version++; } },
    { name: 'different project', change: state => { state.task.manifest.input.edit_base!.source_project_id = 'outside-project'; } },
    { name: 'different document type', change: state => { state.base.document_type = 'financial'; } },
    { name: 'preparation note instead of document', change: state => { state.base.kind = 'preparation_note'; } },
    // Deliberately inconsistent public snapshot: this checks a defensive boundary, not a completed-task lifecycle.
    { name: 'inconsistent record attributed to the viewed run', change: state => { state.base.run_id = targetRun; } },
    { name: 'duplicate short key with a different hash', change: state => { state.workspace.artifacts.push({ ...state.base, sha256: hash('conflicting duplicate') }); } },
    { name: 'duplicate exact record', change: state => { state.workspace.artifacts.push(structuredClone(state.base)); } },
  ];
  for (const scenario of unavailable) test('material-prior-result: ' + scenario.name + ' retains the full fixed reference and never falls back', async ({ page }) => {
    const state = fixture(); scenario.change(state); const before = snapshot(state), pin = state.task.manifest.input.edit_base!;
    await open(page, state); await noTarget(page, state, 'base', /无法准确定位|不会改用其他稿件/);
    await card(page).locator('summary').click(); for (const value of [pin.source_project_id, pin.artifact_id, 'V' + pin.artifact_version, pin.sha256]) await expect(card(page)).toContainText(value);
    await settle(page); await unchanged(page, state, before); expect(writes(state)).toEqual([]);
  });

  test('material-prior-result: no eligible same-type artifact gives a clear empty state without opening another type or late draft', async ({ page }) => {
    const state = fixture('history'); state.workspace.artifacts = [state.other, state.late,
      artifact('foreign-project', { source_project_id: 'another-project' }), artifact('note-only', { kind: 'preparation_note' })];
    const before = snapshot(state); await open(page, state); await noTarget(page, state, 'none', /提交前暂无.*同类成果/);
    await settle(page); await unchanged(page, state, before);
  });

  test('material-prior-result: an artifact registered exactly at submission is not called earlier', async ({ page }) => {
    const state = fixture('history'); state.recent.created_at = now; state.workspace.artifacts = [state.recent]; const before = snapshot(state);
    await open(page, state); await noTarget(page, state, 'none', /提交前暂无/); await settle(page); await unchanged(page, state, before);
  });

  test('material-prior-result: two nearest artifacts at the same instant do not select one by array order', async ({ page }) => {
    const state = fixture('history'); state.workspace.artifacts.push(artifact('tied-nearest', { created_at: state.recent.created_at, revision_number: 100 }));
    const before = snapshot(state); await open(page, state); await noTarget(page, state, 'none', /歧义/); await settle(page); await unchanged(page, state, before);
  });

  for (const badDate of ['not-an-instant', '2026-10-25T10:20:00', '2026-02-30T10:20:00Z']) test('material-prior-result: unverifiable artifact time ' + badDate + ' does not establish an earlier result', async ({ page }) => {
    const state = fixture('history'); state.recent.created_at = badDate; state.workspace.artifacts = [state.recent]; const before = snapshot(state);
    await open(page, state); await noTarget(page, state, 'none', /提交前暂无/); await settle(page); await unchanged(page, state, before);
  });

  for (const badDate of ['not-a-task-instant', '2026-10-25T12:00:00', '2026-02-30T12:00:00Z']) test('material-prior-result: unverifiable task time ' + badDate + ' keeps the task readable without guessing an earlier result', async ({ page }) => {
    const state = fixture('history'); state.task.created_at = badDate; const before = snapshot(state);
    await open(page, state); await noTarget(page, state, 'none', /提交时间暂不可核实/); await expect(making(page)).toContainText('提交时间暂不可核实');
    await settle(page); await unchanged(page, state, before);
  });

  test('material-prior-result: a conflicting ID and version blocks history navigation even when the duplicate is another type', async ({ page }) => {
    const state = fixture('history'); state.workspace.artifacts.push({ ...state.recent, document_type: 'financial', sha256: hash('same short key different pin') });
    const before = snapshot(state); await open(page, state); await noTarget(page, state, 'none', /歧义/); await settle(page); await unchanged(page, state, before);
  });

  test('material-prior-result: a malformed stored artifact pin cannot establish a history target', async ({ page }) => {
    const state = fixture('history'); state.recent.sha256 = 'not-a-sha256'; state.workspace.artifacts = [state.recent]; const before = snapshot(state);
    await open(page, state); await noTarget(page, state, 'none', /提交前暂无/); await settle(page); await unchanged(page, state, before);
  });

  test('material-prior-result: a task from another execution project does not navigate using this workspace artifacts', async ({ page }) => {
    const state = fixture(); state.task.run.project_id = 'outside-execution-project'; const before = snapshot(state);
    await open(page, state); await noTarget(page, state, 'base', /归属暂不可核实/); await settle(page); await unchanged(page, state, before);
  });

  test('material-prior-result: a stale visible base card cannot open a replacement after an online refresh loses its exact pin', async ({ page }) => {
    const state = fixture(); const before = snapshot(state); await open(page, state); await selected(page, state, state.base, 'base');
    const originalPin = await priorButton(page).getAttribute('data-prior-pin'); state.workspace.artifacts = state.workspace.artifacts.filter(a => a !== state.base);
    await refreshWithSelectedText(page, state); await expect(priorButton(page)).toHaveAttribute('data-prior-pin', originalPin!); await priorButton(page).click();
    await expect(page.locator('#m4-status')).toContainText('未打开其他稿件'); expect(previewReads(state)).toEqual([]);
    expect((await observe(page)).reading.selected).toBe('run:' + targetRun); await settle(page); await unchanged(page, state, before);
  });

  test('material-prior-result: a stale visible history card cannot silently open the newly nearest file', async ({ page }) => {
    const state = fixture('history'), before = snapshot(state); await open(page, state); await selected(page, state, state.recent, 'history');
    const originalPin = await priorButton(page).getAttribute('data-prior-pin'); state.workspace.artifacts.push(artifact('newly-discovered-earlier', { created_at: '2026-10-25T11:55:00Z' }));
    await refreshWithSelectedText(page, state); await expect(priorButton(page)).toHaveAttribute('data-prior-pin', originalPin!); await priorButton(page).click();
    await expect(page.locator('#m4-status')).toContainText('未打开其他稿件'); expect(previewReads(state)).toEqual([]);
    expect((await observe(page)).reading.selected).toBe('run:' + targetRun); await settle(page); await unchanged(page, state, before);
  });

  test('material-prior-result: refreshing after a later same-type completion retains the earlier history target', async ({ page }) => {
    const state = fixture('history'), before = snapshot(state); await open(page, state);
    state.workspace.artifacts.push(artifact('newest-after-target', { created_at: '2026-10-25T14:00:00Z', revision_number: 20 }));
    await page.locator('[data-m4-action="refresh"]').click(); await expect.poll(() => state.workspaceReads).toBe(2);
    await selected(page, state, state.recent, 'history'); await priorButton(page).click(); await expectOpened(page, state, state.recent); await unchanged(page, state, before);
  });

  test('material-prior-result: exact-reference disclosure and summary focus survive a same-target online refresh', async ({ page }) => {
    const state = fixture(), before = snapshot(state); await open(page, state); const summary = card(page).locator('summary'); await summary.click();
    await expect(summary).toBeFocused(); await online(page, state); await expect(card(page).locator('details')).toHaveAttribute('open', '');
    await expect(card(page).locator('summary')).toBeFocused(); await settle(page); await unchanged(page, state, before); expect(writes(state)).toEqual([]);
  });

  test('material-prior-result: exact-reference disclosure and button focus survive a same-target real poll', async ({ page }) => {
    const state = fixture(), before = snapshot(state); await open(page, state); await card(page).locator('summary').click(); await priorButton(page).focus();
    const reads = state.workspaceReads; await page.clock.runFor(2300); await expect.poll(() => state.workspaceReads).toBe(reads + 1);
    await expect(priorButton(page)).toBeFocused(); await expect(card(page).locator('details')).toHaveAttribute('open', '');
    await unchanged(page, state, before); expect(writes(state)).toEqual([]);
  });

  test('material-prior-result: a refreshed history target closes the old disclosure and focuses the new card without focusing its action', async ({ page }) => {
    const state = fixture('history'), before = snapshot(state); await open(page, state); await card(page).locator('summary').click(); await priorButton(page).focus();
    const next = artifact('new-visible-nearest', { created_at: '2026-10-25T11:55:00Z' }); state.workspace.artifacts.push(next); await online(page, state);
    await selected(page, state, next, 'history'); await expect(card(page).locator('details')).not.toHaveAttribute('open', '');
    await expect(card(page)).toBeFocused(); await expect(priorButton(page)).not.toBeFocused(); expect(previewReads(state)).toEqual([]);
    await online(page, state); await expect(card(page)).toBeFocused(); await expect(priorButton(page)).not.toBeFocused();
    await expect(priorButton(page)).toHaveAttribute('data-prior-pin', priorPin(next)); await expect(card(page).locator('details')).not.toHaveAttribute('open', '');
    await settle(page); await unchanged(page, state, before);
  });

  test('material-prior-result: a synthetic completed-task snapshot replaces making with its own output and focuses the reading title', async ({ page }) => {
    const state = fixture(), before = snapshot(state); await open(page, state); await priorButton(page).focus();
    const output = artifact('task-own-output', { run_id: targetRun, created_at: '2026-10-25T12:01:00Z', revision_number: 9, filename: '合成本轮真实完成正文.docx' });
    state.workspace.artifacts.push(output); state.task.artifacts = [output]; state.task.run.state = 'succeeded'; state.task.run.artifact_id = output.artifact_id; state.workspace.active_run = null;
    await online(page, state); await expect(card(page)).toHaveCount(0); await expect(page.locator('.artifact-file')).toContainText(output.filename);
    await expect(page.locator('#m4-content h2').first()).toBeFocused(); await expect(page.locator('[data-m4-action="continue"]')).not.toBeFocused();
    await expect.poll(() => previewReads(state).map(call => call.path)).toEqual([previewPath(output)]);
    await expect(page.getByLabel(output.filename + '正文', { exact: true })).toHaveText(previewContent(output));
    await expect(page.locator('#m4-content h2').first()).toBeFocused();
    await online(page, state); await expect(page.locator('#m4-content h2').first()).toBeFocused();
    await expect(page.locator('[data-m4-action="continue"]')).not.toBeFocused();
    expect((await observe(page)).reading.selected).toBe('run:' + targetRun); await settle(page); await unchanged(page, state, before);
  });

  test('material-prior-result: a foreign-topic artifact is refused at the workspace API boundary before any selector or preview', async ({ page }) => {
    const state = fixture(); state.base.topic_id = 'another-topic'; const before = snapshot(state); await open(page, state);
    await expect(page.locator('.m4-empty [role="alert"]')).toBeVisible(); await expect(card(page)).toHaveCount(0); expect(previewReads(state)).toEqual([]);
    expect(snapshot(state)).toEqual(before); expect(writes(state)).toEqual([]); noBusiness(state);
    const local = await observe(page); for (const type of M4_DOCUMENT_TYPES) { expect(local.drafts[type].version).toBe(0); expect(local.drafts[type].dirty).toBe(false); expect(local.drafts[type].input.fields).toEqual({}); }
  });
}
