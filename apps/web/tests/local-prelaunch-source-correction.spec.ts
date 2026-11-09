import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { reportingWindow, type SourceProspectus } from '@bondbuddy/contracts';
import type { Page } from '@playwright/test';
import { makeWorkerDocxFixture } from '../../worker/src/docx-test-fixture.js';
import { test, expect, browserApi, downloadedHash, localSql, lockCurrentInput, openProject, sha256,
  targetCutoff, uploadFromPicker } from './local-prelaunch-helpers';

test.skip(process.env.BB_E2E_LOCAL_PRELAUNCH !== '1', 'Requires the explicitly owned local public API/PostgreSQL/Blob instance.');
test.use({ viewport: { width: 1440, height: 1000 } });
test.setTimeout(180000);

// These are deliberately wrong user declarations, not facts detected or approved by the product.
type SourceChoice = Pick<SourceProspectus, 'relation' | 'market' | 'offering'> & { cutoff: string };
const wrong: SourceChoice = { relation: 'parent', market: 'nafmii', offering: 'mtn', cutoff: '2024-06-30' };
const corrected: SourceChoice = { relation: 'same_issuer', market: 'sse', offering: 'private', cutoff: '2025-12-31' };

async function chooseSource(page: Page, materialId: string, choice: SourceChoice) {
  const source = page.locator(`[data-source-material="${materialId}"]`);
  await expect(source).toBeVisible();
  await source.locator('[data-source-field="relation"]').selectOption(choice.relation!);
  await source.locator('[data-source-field="market"]').selectOption(choice.market!);
  await source.locator('[data-source-field="offering"]').selectOption(choice.offering!);
  await source.locator('[data-source-field="year"]').selectOption(choice.cutoff.slice(0, 4));
  await source.locator(`[data-source-field="quarter"][value="${choice.cutoff.slice(5)}"]`).check();
  await expect(source.locator('[data-source-required-message]')).toHaveText('原稿信息已填写完整。');
  await expect(page.locator('#save-state')).toHaveText('已保存');
}

async function expectSourceControls(page: Page, materialId: string, choice: SourceChoice) {
  const source = page.locator(`[data-source-material="${materialId}"]`);
  await expect(source.locator('[data-source-field="relation"]')).toHaveValue(choice.relation!);
  await expect(source.locator('[data-source-field="market"]')).toHaveValue(choice.market!);
  await expect(source.locator('[data-source-field="offering"]')).toHaveValue(choice.offering!);
  await expect(source.locator('[data-source-field="year"]')).toHaveValue(choice.cutoff.slice(0, 4));
  await expect(source.locator(`[data-source-field="quarter"][value="${choice.cutoff.slice(5)}"]`)).toBeChecked();
  // The 2026-10-09 product decision removed manual source issuer entry.
  await expect(source.getByRole('textbox')).toHaveCount(0);
}

const target = (project: any) => ({ issuer: project.issuer_name, market: project.market, offering: project.offering,
  cutoff: project.update_details.reporting_cutoff, periods: project.update_details.target_reporting_periods });
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function lockedSource(owner: string, projectId: string, revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 1) throw Error('A real persisted input revision is required.');
  // Read only the pinned declarations/material hashes, not the knowledge text or authentication data.
  return localSql<any>(`SELECT json_build_object('revision',revision,'hash',btrim(input_hash),'draftRevision',draft_revision,
    'target',json_build_object('issuer',manifest->>'issuer_name','market',manifest->>'market','offering',manifest->>'offering',
      'cutoff',manifest->'update_details'->>'reporting_cutoff','periods',manifest->'update_details'->'target_reporting_periods'),
    'sources',manifest->'authoring'->'source_prospectuses','draftSources',manifest->'update_details'->'source_prospectuses',
    'materials',manifest->'materials') FROM bb_input_revisions
    WHERE owner_user_id=${literal(owner)} AND project_id=${literal(projectId)} AND revision=${revision};`);
}

test('user corrects valid but mistaken source declarations; reload, immutable input and quote never reuse the old facts', async ({ page, audit }) => {
  const status = await page.request.get('/__prelaunch/status'); expect(status.status()).toBe(200);
  const environment = await status.json(); expect(environment.production_server).toBe(true);
  audit.record('actual-running-local-image-and-mounted-source-identity', environment);
  const marker = randomUUID().slice(0, 8), issuer = `合成源信息纠正 ${marker} 有限公司`;
  await page.goto('/#/new');
  await page.getByLabel('发行人全称', { exact: true }).fill(issuer);
  await page.getByLabel('发行市场', { exact: true }).selectOption('sse');
  await page.getByLabel('发行方式', { exact: true }).selectOption('private');
  await page.getByLabel('最新报告期年份', { exact: true }).selectOption(targetCutoff.slice(0, 4));
  await page.locator(`[name="reporting_quarter"][value="${targetCutoff.slice(5)}"]`).check();
  await page.getByRole('heading', { name: '更新募集说明书', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(audit.directory, 'creation-reference-guidance-1440.png') });
  const creating = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/projects' && r.request().method() === 'POST');
  await page.getByRole('button', { name: '创建项目，继续提供材料', exact: true }).click();
  const created = await creating; expect(created.status(), await created.text()).toBe(201);
  const project = await created.json(), projectPath = `/api/v1/projects/${project.project_id}`;
  const expectedTarget = target(project);
  expect(expectedTarget).toEqual({ issuer, market: 'sse', offering: 'private', cutoff: targetCutoff,
    periods: reportingWindow('sse', 'private', targetCutoff) });
  await openProject(page, project.project_id);
  await page.locator('.project-context').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(audit.directory, 'project-context-empty-reference-1440.png') });
  const bytes = makeWorkerDocxFixture({ externalLink: false,
    text: `【纯合成纠错测试，非客户材料】${issuer}历史募集说明书。原稿发行人为目标企业自身，上交所普通私募公司债。原稿最新报告期为2025年12月31日。测试标记：${marker}。` });
  const source = await uploadFromPicker(page, project.project_id, { name: `${marker}-合成原稿信息纠正.docx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: bytes }, true);
  const pin = { material_id: source.material_id, material_version: source.material_version, sha256: sha256(bytes) };
  const materialRef = { material_id: pin.material_id, material_version: pin.material_version };
  expect(source.sha256).toBe(pin.sha256);
  const declaration = (choice: SourceChoice): SourceProspectus => ({ ...pin, issuer_name: null, relation: choice.relation,
    market: choice.market, offering: choice.offering, reporting_periods: reportingWindow(choice.market, choice.offering, choice.cutoff), status: 'user_asserted' });
  const savedDeclaration = async (choice: SourceChoice) => {
    await expect.poll(async () => {
      const saved = await browserApi(page, 'GET', projectPath); expect(saved.status).toBe(200);
      expect(target(saved.body)).toEqual(expectedTarget);
      return saved.body.update_details.source_prospectuses;
    }).toEqual([declaration(choice)]);
    const saved = await browserApi(page, 'GET', projectPath); expect(saved.status).toBe(200); return saved.body;
  };
  audit.record('synthetic-source-facts-and-test-boundary', { pin, byteSize: bytes.length, expectedTarget,
    correctUserDeclaration: declaration(corrected), incorrectUserDeclaration: declaration(wrong),
    manualSourceIssuerInputRemoved: true, automaticFactDetectionTested: false, modelTaskRequested: false });

  await chooseSource(page, source.material_id, wrong);
  const mistakenDraft = await savedDeclaration(wrong);
  await page.reload(); await expectSourceControls(page, source.material_id, wrong); await savedDeclaration(wrong);
  const oldInput = await lockCurrentInput(page, project.project_id, [materialRef]); expect(oldInput.status, JSON.stringify(oldInput.body)).toBe(201);
  const originalObservation = lockedSource(audit.owner, project.project_id, oldInput.body.input_revision);
  expect(originalObservation).toMatchObject({ hash: oldInput.body.input_hash, target: expectedTarget,
    sources: [declaration(wrong)], draftSources: [declaration(wrong)], materials: [{ ...pin, role: 'historical' }] });
  const oldQuote = await browserApi(page, 'POST', `${projectPath}/credit-quote`, inputIdentity(oldInput.body));
  expect(oldQuote.status, JSON.stringify(oldQuote.body)).toBe(200); expect(BigInt(oldQuote.body.quote.points)).toBeGreaterThan(0n);
  audit.checkpoint('mistaken-but-valid-source-saved-and-quoted', { draftRevision: mistakenDraft.draft_revision,
    input: oldInput.body, pinned: originalObservation, quote: oldQuote.body });
  audit.noTaskOrDebit('saving-user-assertions-is-not-a-task-or-charge');

  await chooseSource(page, source.material_id, corrected);
  const correctedDraft = await savedDeclaration(corrected); expect(correctedDraft.draft_revision).toBeGreaterThan(mistakenDraft.draft_revision);
  await page.reload(); await expectSourceControls(page, source.material_id, corrected); await savedDeclaration(corrected);
  expect(await downloadedHash(page, project.project_id, source.material_id)).toEqual({ status: 200, bytes: bytes.length, sha256: pin.sha256 });
  const staleLock = await browserApi(page, 'POST', `${projectPath}/input-revisions`, {
    draft_revision: mistakenDraft.draft_revision, material_versions: [materialRef], requirement_message_ids: [] });
  expect(staleLock).toMatchObject({ status: 409, body: { code: 'INPUT_REVISION_CONFLICT' } });
  audit.noTaskOrDebit('stale-draft-cannot-relock-old-source');

  const newInput = await lockCurrentInput(page, project.project_id, [materialRef]); expect(newInput.status, JSON.stringify(newInput.body)).toBe(201);
  expect(newInput.body.input_revision).toBeGreaterThan(oldInput.body.input_revision); expect(newInput.body.input_hash).not.toBe(oldInput.body.input_hash);
  expect(newInput.body.material_versions).toEqual(oldInput.body.material_versions);
  const correctedObservation = lockedSource(audit.owner, project.project_id, newInput.body.input_revision);
  expect(correctedObservation).toMatchObject({ hash: newInput.body.input_hash, draftRevision: correctedDraft.draft_revision,
    target: expectedTarget, sources: [declaration(corrected)], draftSources: [declaration(corrected)], materials: [{ ...pin, role: 'historical' }] });
  expect(lockedSource(audit.owner, project.project_id, oldInput.body.input_revision)).toEqual(originalObservation);
  const staleQuote = await browserApi(page, 'POST', `${projectPath}/credit-quote`, inputIdentity(oldInput.body));
  expect(staleQuote).toMatchObject({ status: 409, body: { code: 'INPUT_REVISION_CONFLICT' } });
  const mixedHash = await browserApi(page, 'POST', `${projectPath}/credit-quote`, { input_revision: newInput.body.input_revision, input_hash: oldInput.body.input_hash });
  expect(mixedHash).toMatchObject({ status: 409, body: { code: 'INPUT_REVISION_CONFLICT' } });
  const freshQuote = await browserApi(page, 'POST', `${projectPath}/credit-quote`, inputIdentity(newInput.body));
  expect(freshQuote.status, JSON.stringify(freshQuote.body)).toBe(200);
  expect(freshQuote.body.quote).toMatchObject({ project_id: project.project_id, ...inputIdentity(newInput.body) });
  expect(freshQuote.body.quote.quote_id).not.toBe(oldQuote.body.quote.quote_id);
  expect(BigInt(freshQuote.body.quote.points)).toBeGreaterThan(0n);
  audit.checkpoint('corrected-source-pinned-to-new-input-and-quote', { staleLock, staleQuote, mixedHash,
    input: newInput.body, pinned: correctedObservation, quote: freshQuote.body });

  // Only deliberately invalid submissions are sent. There is no funded account, accepted execution, or model request.
  expect(audit.before.remaining).toBe('0');
  for (const [label, input, quote, code] of [
    ['old-input-and-old-quote', oldInput.body, oldQuote.body.quote, 'INPUT_REVISION_CONFLICT'],
    ['corrected-input-with-old-quote', newInput.body, oldQuote.body.quote, 'QUOTE_CHANGED'],
    ['old-input-with-corrected-quote', oldInput.body, freshQuote.body.quote, 'QUOTE_CHANGED'],
  ] as const) {
    const rejected = await browserApi(page, 'POST', '/api/v1/runs/execute', {
      execution_request_id: randomUUID(), project_id: project.project_id, ...inputIdentity(input), task_kind: 'update',
      input_manifest_ref: input.input_hash, storage_origin: 'cloud', workspace_id: project.project_id, quote_id: quote.quote_id });
    expect(rejected, JSON.stringify(rejected.body)).toMatchObject({ status: 409, body: { code } });
    audit.checkpoint(label, rejected); audit.noTaskOrDebit(`${label}-rejected-without-run-reservation-or-model`);
  }
  await page.reload(); await expectSourceControls(page, source.material_id, corrected); await savedDeclaration(corrected);
  const final = audit.checkpoint('source-correction-final-state');
  expect(final.inputs).toBe(audit.before.inputs + 2); expect(final.materials).toBe(audit.before.materials + 1);
  expect(final.parseJobs).toBe(audit.before.parseJobs);
  expect(lockedSource(audit.owner, project.project_id, newInput.body.input_revision)).toEqual(correctedObservation);
  expect(lockedSource(audit.owner, project.project_id, oldInput.body.input_revision)).toEqual(originalObservation);
  audit.noTaskOrDebit('source-correction-final-no-task-or-credit-write');
  await page.locator('.project-context').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(audit.directory, 'saved-adopted-reference-1440.png') });
  if (await page.locator('#project-materials-details').getAttribute('open') === null)
    await page.locator('#project-materials-details > summary').click();
  await page.locator('.material-file-row').filter({ has: page.locator(`[data-source-material="${source.material_id}"]`) }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(audit.directory, 'source-material-row-1440.png') });
});

function inputIdentity(input: { input_revision: number; input_hash: string }) {
  return { input_revision: input.input_revision, input_hash: input.input_hash };
}
