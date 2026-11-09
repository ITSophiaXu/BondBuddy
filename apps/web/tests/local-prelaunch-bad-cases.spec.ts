import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { M1_UPLOAD_LIMITS } from '@bondbuddy/contracts';
import { asUploadFile, createLocalPrelaunchBasicFixtures, createLocalPrelaunchFinancialFixtures, createLocalPrelaunchFixtures, type LocalPrelaunchFixture } from './local-prelaunch-fixtures';
import { test, expect, browserApi, createSyntheticProject, downloadedHash, fillSourceInformation, lockCurrentInput, openProject,
  prelaunchConfig, savedMaterials, sha256, uploadFromPicker, type Audit } from './local-prelaunch-helpers';
import { parseEvidenceObservation, uploadBlobObservation } from './local-prelaunch-helpers';

test.skip(process.env.BB_E2E_LOCAL_PRELAUNCH !== '1', 'Requires the explicitly owned local prelaunch HTTP/API/PostgreSQL/Blob/worker environment.');
test.use({ viewport: { width: 1440, height: 1000 } });
test.setTimeout(120000);
const fixtures = createLocalPrelaunchBasicFixtures();
const marker = () => randomUUID().slice(0, 8);
const pins = (material: any) => [{ material_id: material.material_id, material_version: material.material_version }];
const rowFor = (page: Parameters<typeof openProject>[0], name: string) => page.locator('.material-file-row').filter({ hasText: name });
async function recordSaved(page: Parameters<typeof openProject>[0], audit: Audit, projectId: string, file: LocalPrelaunchFixture, material: any) {
  const downloaded = await downloadedHash(page, projectId, material.material_id);
  audit.checkpoint('saved-original-and-authorized-download', { fixture: file.id, originalSha256: file.sha256, material, downloaded });
  expect(downloaded).toEqual({ status: 200, bytes: file.buffer.length, sha256: file.sha256 });
}

test('required source: financial-only rejection, incomplete-source rejection, correction and real quote create no task or debit', async ({ page, audit }) => {
  const project = await createSyntheticProject(page, marker()); await openProject(page, project.project_id);
  const financial = await uploadFromPicker(page, project.project_id, asUploadFile(fixtures.normalPdf));
  await recordSaved(page, audit, project.project_id, fixtures.normalPdf, financial);
  await expect.soft(page.locator('#execute-input')).toBeDisabled();
  await expect.soft(page.locator('#start-disabled-reason')).toContainText('请先上传并采用');
  const missingSource = await lockCurrentInput(page, project.project_id, pins(financial));
  audit.checkpoint('financial-only-input-rejected', missingSource);
  expect.soft(missingSource.status).toBe(422);
  expect.soft(JSON.stringify(missingSource.body)).toContain('SOURCE_PROSPECTUS_REQUIRED');
  audit.noTaskOrDebit('financial-only-created-no-run-or-credit-event');

  const source = await uploadFromPicker(page, project.project_id, asUploadFile(fixtures.normalDocx), true);
  await expect(page.locator(`[data-source-material="${source.material_id}"]`)).toBeVisible();
  await expect(page.locator('#execute-input')).toBeDisabled();
  await expect(page.locator('#start-disabled-reason')).toContainText('请补齐');
  const incomplete = await lockCurrentInput(page, project.project_id, [...pins(source), ...pins(financial)]);
  audit.checkpoint('incomplete-source-input-rejected', incomplete); expect(incomplete.status).toBe(422);
  audit.noTaskOrDebit('incomplete-source-created-no-run-or-credit-event');
  await page.locator('#complete-source-information').click();
  await expect(page.locator(`[data-source-material="${source.material_id}"] [data-source-field="relation"]`)).toBeFocused();
  await fillSourceInformation(page, source.material_id);
  await page.reload(); await expect(page.locator('#execute-input')).toBeEnabled();
  const input = await lockCurrentInput(page, project.project_id, [...pins(source), ...pins(financial)]);
  audit.checkpoint('corrected-input-lock', input); expect(input.status, JSON.stringify(input.body)).toBe(201);
  const quote = await browserApi(page, 'POST', `/api/v1/projects/${project.project_id}/credit-quote`, { input_revision: input.body.input_revision, input_hash: input.body.input_hash });
  audit.checkpoint('corrected-input-real-quote', quote); expect(quote.status, JSON.stringify(quote.body)).toBe(200);
  audit.noTaskOrDebit('saving-locking-and-quoting-create-no-run-or-debit');
});

test('invalid project input is rejected by the real API and corrected values can be saved', async ({ page, audit }) => {
  const invalid = await browserApi(page, 'POST', '/api/v1/projects', { name: '合成错误市场品种', kind: 'update', issuer_name: '合成发行人有限公司', market: 'sse', offering: 'dfi' });
  audit.checkpoint('invalid-market-offering', invalid); expect(invalid.status).toBe(422);
  const invalidDate = await browserApi(page, 'POST', '/api/v1/projects', { name: '合成错误日期', kind: 'update', issuer_name: '合成发行人有限公司', market: 'sse', offering: 'private', update_details: { reporting_cutoff: '2026-02-30' } });
  audit.checkpoint('invalid-reporting-date', invalidDate); expect(invalidDate.status).toBe(422);
  const rejected = audit.checkpoint('invalid-projects-not-persisted'); expect(rejected.projects).toBe(audit.before.projects);
  const corrected = await createSyntheticProject(page, marker()); await openProject(page, corrected.project_id);
  audit.noTaskOrDebit('corrected-project-only-saves-draft');
});

test('unsupported browser file offers replacement and saves only the correct file', async ({ page, audit }) => {
  const project = await createSyntheticProject(page, marker()); await openProject(page, project.project_id);
  await page.getByLabel('为审计报告（可含报表及附注）选择文件', { exact: true }).setInputFiles(asUploadFile(fixtures.unsupportedExecutable));
  const row = rowFor(page, fixtures.unsupportedExecutable.name);
  await expect(row).toContainText('请选择支持格式的文件');
  await expect(row.getByRole('button', { name: '重试此文件' })).toHaveCount(0);
  const rejected = audit.checkpoint('local-unsupported-file-no-upload'); expect(rejected.uploads).toBe(audit.before.uploads);
  audit.noTaskOrDebit('unsupported-file-no-run-or-credit-event');
  const chooser = page.waitForEvent('filechooser');
  await row.getByRole('button', { name: '选择其他文件', exact: true }).click();
  const complete = page.waitForResponse(r => r.url().endsWith('/complete') && r.request().method() === 'POST');
  await (await chooser).setFiles(asUploadFile(fixtures.normalPdf));
  const response = await complete; expect(response.status()).toBe(200); const saved = await response.json();
  await expect(row).toHaveCount(0); await recordSaved(page, audit, project.project_id, fixtures.normalPdf, saved);
  audit.noTaskOrDebit('replacement-does-not-start-task-or-debit');
});

test('zero-byte browser file is actionable and a correct selection continues without a task or debit', async ({ page, audit }) => {
  const project = await createSyntheticProject(page, marker()); await openProject(page, project.project_id);
  await page.getByLabel('为审计报告（可含报表及附注）选择文件', { exact: true }).setInputFiles(asUploadFile(fixtures.zeroByteDocx));
  const row = rowFor(page, fixtures.zeroByteDocx.name);
  await expect(row).toContainText(/文件为空|空文件|文件大小/);
  const rejected = audit.checkpoint('zero-byte-no-persistent-upload'); expect(rejected.uploads).toBe(audit.before.uploads);
  audit.noTaskOrDebit('zero-byte-no-run-or-credit-event');
  const material = await uploadFromPicker(page, project.project_id, asUploadFile(fixtures.normalDocx));
  await recordSaved(page, audit, project.project_id, fixtures.normalDocx, material);
  audit.noTaskOrDebit('correct-file-after-zero-byte-no-task-or-debit');
});

test('real upload declaration rejects zero size, unsupported MIME and over-limit size before persistent writes', async ({ page, audit }) => {
  const project = await createSyntheticProject(page, marker());
  const declaration = { filename: fixtures.normalDocx.name, media_type: fixtures.normalDocx.mimeType, byte_size: fixtures.normalDocx.buffer.length, sha256: fixtures.normalDocx.sha256, role: 'audit' };
  for (const [name, changed] of [
    ['zero', { byte_size: 0 }], ['unsupported', { filename: 'synthetic.exe', media_type: 'application/x-executable' }],
    ['over-limit', { byte_size: M1_UPLOAD_LIMITS.fileBytes + 1 }],
  ] as const) {
    const response = await browserApi(page, 'POST', `/api/v1/projects/${project.project_id}/materials/uploads`, { ...declaration, ...changed });
    audit.checkpoint(`declaration-${name}-rejected`, response); expect(response.status).toBe(422);
  }
  const rejected = audit.checkpoint('all-invalid-declarations-no-upload-or-material');
  expect(rejected.uploads).toBe(audit.before.uploads); expect(rejected.materials).toBe(audit.before.materials);
  audit.noTaskOrDebit('invalid-declarations-no-run-or-credit-event');
  await openProject(page, project.project_id);
  const material = await uploadFromPicker(page, project.project_id, asUploadFile(fixtures.normalDocx));
  await recordSaved(page, audit, project.project_id, fixtures.normalDocx, material);
});

test('real PUT rejects short bytes and same-size wrong hash, then reuses the declaration with correct bytes', async ({ page, audit }) => {
  const project = await createSyntheticProject(page, marker()), file = fixtures.normalDocx;
  const base = `/api/v1/projects/${project.project_id}/materials/uploads`;
  const begin = await browserApi(page, 'POST', base, { filename: file.name, media_type: file.mimeType, byte_size: file.buffer.length, sha256: file.sha256, role: 'audit' });
  expect(begin.status).toBe(201); audit.record('original-upload-declaration', begin.body);
  const wrong = Buffer.from(file.buffer); wrong[wrong.length - 1] ^= 1;
  for (const [name, bytes] of [['short', file.buffer.subarray(0, -1)], ['wrong-hash', wrong]] as const) {
    const response = await browserApi(page, 'PUT', begin.body.upload_url, undefined, bytes);
    audit.checkpoint(`${name}-bytes-rejected`, response); expect(response.status).toBe(422); expect(response.body.code).toBe('MATERIAL_CONTENT_MISMATCH');
  }
  const rejected = audit.checkpoint('mismatched-bytes-no-material'); expect(rejected.materials).toBe(audit.before.materials);
  const stored = uploadBlobObservation(audit.owner, begin.body.upload_id); audit.record('mismatched-bytes-private-blob-not-written', stored);
  expect(stored.state).toBe('uploading'); expect(stored.blob.exists).toBe(false);
  audit.noTaskOrDebit('mismatched-bytes-no-run-or-credit-event');
  const put = await browserApi(page, 'PUT', begin.body.upload_url, undefined, file.buffer); expect(put.status).toBe(204);
  const repeatedPut = await browserApi(page, 'PUT', begin.body.upload_url, undefined, file.buffer); expect(repeatedPut.status).toBe(204);
  const declaration = { byte_size: file.buffer.length, sha256: file.sha256 };
  const complete = await browserApi(page, 'POST', `${base}/${begin.body.upload_id}/complete`, declaration); expect(complete.status).toBe(200);
  const repeated = await browserApi(page, 'POST', `${base}/${begin.body.upload_id}/complete`, declaration); expect(repeated.status).toBe(200);
  expect(repeated.body.material_id).toBe(complete.body.material_id);
  await openProject(page, project.project_id); await recordSaved(page, audit, project.project_id, file, complete.body);
  expect(audit.checkpoint('corrected-declaration-one-material').materials).toBe(audit.before.materials + 1);
  audit.noTaskOrDebit('corrected-upload-no-task-or-debit');
});

for (const phase of ['before-bytes', 'after-bytes', 'after-complete'] as const) {
  test(`upload interruption ${phase}: real server state and same file recover without duplicate material or debit`, async ({ page, audit }) => {
    const project = await createSyntheticProject(page, marker()); await openProject(page, project.project_id);
    const suffix = phase === 'after-complete' ? 'complete' : 'bytes', pattern = `**/api/v1/projects/${project.project_id}/materials/uploads/*/${suffix}`;
    let dropped = false; let serverUploadId: string | undefined;
    await page.route(pattern, async route => {
      if (dropped) { await route.continue(); return; }
      dropped = true; serverUploadId = new URL(route.request().url()).pathname.split('/').at(-2);
      if (phase === 'before-bytes') audit.checkpoint('fault-before-server-accepts-bytes', { uploadId: serverUploadId });
      else {
        // Fetch reaches the real API and commits normally; only its browser reply is lost.
        const response = await route.fetch();
        audit.checkpoint('fault-after-real-server-response', { uploadId: serverUploadId, serverStatus: response.status(), phase });
        expect(response.status()).toBe(phase === 'after-complete' ? 200 : 204);
      }
      await route.abort('connectionreset');
    });
    await page.getByLabel('为审计报告（可含报表及附注）选择文件', { exact: true }).setInputFiles(asUploadFile(fixtures.normalDocx));
    await expect.poll(() => dropped).toBe(true);
    if (phase === 'before-bytes') {
      const row = rowFor(page, fixtures.normalDocx.name); await expect(row.getByRole('button', { name: '重试此文件' })).toBeVisible();
      audit.noTaskOrDebit('interrupted-unreceived-file-no-task-or-debit');
      await page.unroute(pattern); await row.getByRole('button', { name: '重试此文件' }).click();
    }
    await expect(rowFor(page, fixtures.normalDocx.name)).toContainText('服务器已确认保存', { timeout: 30000 });
    await page.unroute(pattern); await page.reload();
    const items = await savedMaterials(page, project.project_id);
    expect(items).toHaveLength(1); expect(items[0].upload_id).toBe(serverUploadId);
    await recordSaved(page, audit, project.project_id, fixtures.normalDocx, items[0]);
    expect(audit.checkpoint('recovered-upload-exactly-one-material').materials).toBe(audit.before.materials + 1);
    audit.noTaskOrDebit('recovered-interruption-no-run-or-credit-event');
  });
}

for (const id of ['docxNamedPdf', 'damagedDocx', 'truncatedDocx', 'corruptPdf', 'encryptedPdf'] as const) {
  test(`bad original ${id}: raw bytes persist, real Python failure is actionable, and a valid replacement parses`, async ({ page, audit }) => {
    let file: LocalPrelaunchFixture;
    if (id === 'encryptedPdf') {
      const python = process.env.BB_PRELAUNCH_FIXTURE_PYTHON ?? (process.platform === 'win32' ? join(process.env.USERPROFILE!, '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe') : 'python3');
      file = (await createLocalPrelaunchFixtures({ pythonExecutable: python })).encryptedPdf;
    } else file = fixtures[id];
    // Legacy material processing is a real public path. Unified authoring intentionally does no auxiliary parse at upload.
    const project = await createSyntheticProject(page, marker(), false); await openProject(page, project.project_id);
    const material = await uploadFromPicker(page, project.project_id, asUploadFile(file));
    await recordSaved(page, audit, project.project_id, file, material);
    let processing: any;
    await expect.poll(async () => {
      const response = await browserApi(page, 'GET', `/api/v1/projects/${project.project_id}/materials/${material.material_id}/parse-job`);
      processing = response; return response.status === 200 && ['failed', 'paused', 'succeeded'].includes(response.body.state) ? response.body.state : 'pending';
    }, { timeout: 60000, intervals: [250, 500, 1000] }).toBe('failed');
    audit.checkpoint('real-parser-failure', processing);
    expect(processing.body.error_code).toBe(id === 'encryptedPdf' ? 'MATERIAL_ENCRYPTED' : 'MATERIAL_UNREADABLE');
    await expect(rowFor(page, file.name)).toContainText(id === 'encryptedPdf' ? '文件已加密' : '无法读取', { timeout: 15000 });
    audit.noTaskOrDebit('failed-auxiliary-parse-no-business-run-or-debit');
    await page.reload(); await expect(rowFor(page, file.name)).toContainText('处理失败');
    const replacement = await uploadFromPicker(page, project.project_id, asUploadFile(fixtures.normalDocx));
    await expect.poll(async () => {
      const response = await browserApi(page, 'GET', `/api/v1/projects/${project.project_id}/materials/${replacement.material_id}/parse-job`);
      processing = response; return response.body?.state;
    }, { timeout: 60000, intervals: [250, 500, 1000] }).toBe('succeeded');
    audit.checkpoint('real-parser-replacement-success', processing);
    await expect(rowFor(page, fixtures.normalDocx.name)).toContainText('处理完成', { timeout: 15000 });
    await recordSaved(page, audit, project.project_id, fixtures.normalDocx, replacement);
    audit.noTaskOrDebit('replacement-parser-no-business-run-or-debit');
  });
}

test('empty-content DOCX records its actual parse result without inventing facts and permits a valid replacement', async ({ page, audit }) => {
  const project = await createSyntheticProject(page, marker(), false); await openProject(page, project.project_id);
  const empty = await uploadFromPicker(page, project.project_id, asUploadFile(fixtures.emptyDocx));
  let result: any;
  await expect.poll(async () => { result = await browserApi(page, 'GET', `/api/v1/projects/${project.project_id}/materials/${empty.material_id}/parse-job`); return result.body?.state; }, { timeout: 60000 }).toMatch(/^(failed|paused|succeeded)$/);
  audit.checkpoint('empty-content-actual-parser-result', result);
  const evidence = parseEvidenceObservation(audit.owner, empty.material_id); audit.record('empty-content-parse-evidence', evidence);
  expect(evidence.nonEmptyQuotes).toBe(0);
  await recordSaved(page, audit, project.project_id, fixtures.emptyDocx, empty);
  // A successfully parsed package can still contain no facts. Record the actual evidence, rather than requiring a raw upload denial.
  const profile = await browserApi(page, 'GET', `/api/v1/projects/${project.project_id}/materials/${empty.material_id}/source-profile`);
  expect(profile.status).toBe(404);
  const replacement = await uploadFromPicker(page, project.project_id, asUploadFile(fixtures.normalDocx));
  await expect.poll(async () => { result = await browserApi(page, 'GET', `/api/v1/projects/${project.project_id}/materials/${replacement.material_id}/parse-job`); return result.body?.state; }, { timeout: 60000 }).toBe('succeeded');
  await expect(rowFor(page, fixtures.normalDocx.name)).toContainText('处理完成', { timeout: 15000 });
  audit.checkpoint('empty-content-replacement-parser-success', result);
  await recordSaved(page, audit, project.project_id, fixtures.normalDocx, replacement);
  audit.noTaskOrDebit('empty-content-and-replacement-no-business-run-or-debit');
});

for (const id of ['damagedXlsx', 'truncatedXlsx'] as const) {
  test(`financial material ${id}: real Linux parser rejects bad XLSX, corrected native financial workbook remains usable`, async ({ page, audit }) => {
    const financial = await createLocalPrelaunchFinancialFixtures({ marker: marker() }), file = financial[id];
    const project = await createSyntheticProject(page, marker(), false); await openProject(page, project.project_id);
    const material = await uploadFromPicker(page, project.project_id, asUploadFile(file));
    await recordSaved(page, audit, project.project_id, file, material); expect(material.role).toBe('audit');
    let processing: any;
    await expect.poll(async () => { processing = await browserApi(page, 'GET', `/api/v1/projects/${project.project_id}/materials/${material.material_id}/parse-job`); return processing.body?.state; }, { timeout: 60000, intervals: [250, 500, 1000] }).toBe('failed');
    audit.checkpoint('financial-xlsx-real-parser-failure', processing); expect(processing.body.error_code).toBe('MATERIAL_UNREADABLE');
    await expect(rowFor(page, file.name)).toContainText('无法读取', { timeout: 15000 });
    const failedEvidence = parseEvidenceObservation(audit.owner, material.material_id); audit.record('financial-xlsx-failed-parser-evidence', failedEvidence);
    expect(failedEvidence.nonEmptyQuotes).toBe(0); audit.noTaskOrDebit('financial-bad-xlsx-no-business-run-or-debit');
    await page.reload(); await expect(rowFor(page, file.name)).toContainText('处理失败');
    const replacement = await uploadFromPicker(page, project.project_id, asUploadFile(financial.normalXlsx));
    await expect.poll(async () => { processing = await browserApi(page, 'GET', `/api/v1/projects/${project.project_id}/materials/${replacement.material_id}/parse-job`); return processing.body?.state; }, { timeout: 60000, intervals: [250, 500, 1000] }).toBe('succeeded');
    audit.checkpoint('financial-xlsx-corrected-native-parser-success', processing);
    const correctedEvidence = parseEvidenceObservation(audit.owner, replacement.material_id); audit.record('financial-xlsx-corrected-native-evidence', correctedEvidence);
    expect(correctedEvidence.nonEmptyQuotes).toBeGreaterThan(6);
    await expect(rowFor(page, financial.normalXlsx.name)).toContainText('处理完成', { timeout: 15000 });
    await recordSaved(page, audit, project.project_id, financial.normalXlsx, replacement);
    audit.noTaskOrDebit('financial-corrected-xlsx-no-business-run-or-debit');
  });
}

test('foreign account cannot read, download, mutate or execute another account project and can continue its own project', async ({ page, browser, audit }) => {
  const project = await createSyntheticProject(page, marker()); await openProject(page, project.project_id);
  const material = await uploadFromPicker(page, project.project_id, asUploadFile(fixtures.normalDocx));
  await recordSaved(page, audit, project.project_id, fixtures.normalDocx, material);
  const otherContext = await browser.newContext({ baseURL: prelaunchConfig().origin, viewport: { width: 1440, height: 1000 } });
  try {
    const other = await otherContext.newPage();
    const { registerSynthetic, databaseSnapshot } = await import('./local-prelaunch-helpers');
    const foreign = await registerSynthetic(other, prelaunchConfig()), foreignBefore = databaseSnapshot(foreign.owner);
    for (const path of [`/api/v1/projects/${project.project_id}`, `/api/v1/projects/${project.project_id}/events`, `/api/v1/projects/${project.project_id}/materials/${material.material_id}`, `/api/v1/projects/${project.project_id}/materials/${material.material_id}/download`, `/api/v1/projects/${project.project_id}/materials/${material.material_id}/parse-job`]) {
      const denied = await browserApi(other, 'GET', path); audit.record('foreign-read-denied', { path, ...denied }); expect(denied.status).toBe(404);
      expect(JSON.stringify(denied.body)).not.toContain(fixtures.normalDocx.name);
    }
    const deleted = await browserApi(other, 'DELETE', `/api/v1/projects/${project.project_id}/materials/${material.material_id}`); expect(deleted.status).toBe(404);
    const locked = await browserApi(other, 'POST', `/api/v1/projects/${project.project_id}/input-revisions`, { draft_revision: project.draft_revision, material_versions: pins(material), requirement_message_ids: [] }); expect(locked.status).toBe(404);
    const execute = await browserApi(other, 'POST', '/api/v1/runs/execute', { execution_request_id: `synthetic-foreign-${randomUUID()}`, project_id: project.project_id, input_revision: 1, input_hash: 'a'.repeat(64), task_kind: 'update', input_manifest_ref: 'synthetic-missing', storage_origin: 'cloud', workspace_id: project.project_id });
    audit.record('foreign-mutation-and-execution-denied', { deleted, locked, execute }); expect([403, 404]).toContain(execute.status);
    await other.goto(`/#/projects/${project.project_id}`); await expect(other.getByText('无法访问这个项目，它可能已移除或不属于当前账号。')).toBeVisible();
    await expect(other.getByText(fixtures.normalDocx.name, { exact: true })).toHaveCount(0);
    const foreignAfter = databaseSnapshot(foreign.owner); audit.record('foreign-database-no-task-or-credit-event', { before: foreignBefore, after: foreignAfter });
    for (const key of ['runs', 'creditEvents', 'reservations', 'modelCalls'] as const) expect(foreignAfter[key]).toBe(foreignBefore[key]);
    const ownProject = await createSyntheticProject(other, marker()); await openProject(other, ownProject.project_id);
    const ownMaterial = await uploadFromPicker(other, ownProject.project_id, asUploadFile(fixtures.normalPdf));
    const ownBytes = await downloadedHash(other, ownProject.project_id, ownMaterial.material_id); expect(ownBytes.sha256).toBe(fixtures.normalPdf.sha256);
    audit.noTaskOrDebit('foreign-actions-do-not-affect-original-owner-task-or-balance');
  } finally { await otherContext.close(); }
});
