import { randomUUID } from 'node:crypto';
import { asUploadFile, createLocalPrelaunchBasicFixtures } from './local-prelaunch-fixtures';
import { test, expect, browserApi, createSyntheticProject, downloadedHash, fillSourceInformation, lockCurrentInput, openProject,
  savedMaterials, uploadFromPicker } from './local-prelaunch-helpers';

test.skip(process.env.BB_E2E_LOCAL_PRELAUNCH !== '1', 'Requires the explicitly owned local public API/PostgreSQL/Blob instance.');
test.use({ viewport: { width: 1440, height: 1000 } });
test.setTimeout(120000);
const marker = () => randomUUID().slice(0, 8);

test('renamed equal bytes deduplicate inside a role, while another role keeps its own material identity', async ({ page, audit }) => {
  const project = await createSyntheticProject(page, marker()), file = createLocalPrelaunchBasicFixtures({ marker: marker() }).normalDocx;
  await openProject(page, project.project_id);
  const first = await uploadFromPicker(page, project.project_id, asUploadFile(file));
  const renamed = await uploadFromPicker(page, project.project_id, { ...asUploadFile(file), name: `renamed-${file.name}` });
  expect(renamed.material_id).toBe(first.material_id); expect(renamed.material_version).toBe(first.material_version);
  await expect(page.locator('#material-recovery-status')).toContainText('重复上传');
  expect(audit.checkpoint('renamed-identical-audit-one-material', { first, renamed }).materials).toBe(audit.before.materials + 1);
  const source = await uploadFromPicker(page, project.project_id, asUploadFile(file), true);
  expect(source.role).toBe('historical'); expect(source.material_id).not.toBe(first.material_id);
  const counts = audit.checkpoint('same-bytes-different-role-two-materials', { source }); expect(counts.materials).toBe(audit.before.materials + 2);
  await page.reload();
  const items = await savedMaterials(page, project.project_id);
  expect(items).toHaveLength(2); expect(items.map((m: any) => m.role).sort()).toEqual(['audit', 'historical']);
  for (const material of items) expect((await downloadedHash(page, project.project_id, material.material_id)).sha256).toBe(file.sha256);
  audit.noTaskOrDebit('deduplication-and-role-change-no-run-or-credit-event');
});

test('newly adopted source never inherits old metadata or accepts old adoption/material pins, and correction can continue', async ({ page, audit }) => {
  const project = await createSyntheticProject(page, marker()); await openProject(page, project.project_id);
  const originalFile = createLocalPrelaunchBasicFixtures({ marker: marker() }).normalDocx;
  const original = await uploadFromPicker(page, project.project_id, asUploadFile(originalFile), true);
  await fillSourceInformation(page, original.material_id);
  const oldVersions = await browserApi(page, 'GET', `/api/v1/projects/${project.project_id}/prospectus-versions`);
  const changedFile = createLocalPrelaunchBasicFixtures({ marker: marker() }).normalDocx;
  const changed = await uploadFromPicker(page, project.project_id, asUploadFile(changedFile), true);
  const source = page.locator(`[data-source-material="${changed.material_id}"]`);
  await expect(source).toBeVisible(); await expect(source.locator('[data-source-field="relation"]')).toHaveValue('');
  await expect(page.locator('#execute-input')).toBeDisabled();
  const current = await browserApi(page, 'GET', `/api/v1/projects/${project.project_id}`);
  const staleSelection = await browserApi(page, 'POST', `/api/v1/projects/${project.project_id}/input-revisions`, {
    draft_revision: current.body.draft_revision, prospectus_selection_revision: oldVersions.body.selection_revision,
    material_versions: [{ material_id: changed.material_id, material_version: changed.material_version }], requirement_message_ids: [],
  });
  audit.checkpoint('stale-adoption-rejected', staleSelection); expect(staleSelection.status).toBe(409);
  const incomplete = await lockCurrentInput(page, project.project_id, [{ material_id: changed.material_id, material_version: changed.material_version }]);
  audit.checkpoint('new-source-old-metadata-rejected', incomplete); expect(incomplete.status).toBe(422);
  audit.noTaskOrDebit('stale-or-incomplete-source-no-run-or-credit-event');
  await fillSourceInformation(page, changed.material_id);
  const staleMaterial = await lockCurrentInput(page, project.project_id, [{ material_id: original.material_id, material_version: original.material_version }]);
  audit.checkpoint('old-source-material-rejected', staleMaterial); expect(staleMaterial.status).toBe(409);
  await page.reload();
  const correct = await lockCurrentInput(page, project.project_id, [{ material_id: changed.material_id, material_version: changed.material_version }]);
  audit.checkpoint('new-source-correct-pins-locked', correct); expect(correct.status, JSON.stringify(correct.body)).toBe(201);
  const quote = await browserApi(page, 'POST', `/api/v1/projects/${project.project_id}/credit-quote`, { input_revision: correct.body.input_revision, input_hash: correct.body.input_hash });
  audit.checkpoint('new-source-corrected-quote', quote); expect(quote.status).toBe(200);
  const bytes = await downloadedHash(page, project.project_id, changed.material_id); expect(bytes.sha256).toBe(changedFile.sha256);
  audit.noTaskOrDebit('corrected-source-lock-and-quote-no-run-or-credit-event');
});

test('same-account material from another project cannot be pinned, then an own-project replacement can continue', async ({ page, audit }) => {
  const first = await createSyntheticProject(page, marker(), false), second = await createSyntheticProject(page, marker(), false);
  const file = createLocalPrelaunchBasicFixtures({ marker: marker() }).normalPdf;
  await openProject(page, first.project_id); const foreignPin = await uploadFromPicker(page, first.project_id, asUploadFile(file));
  const rejected = await lockCurrentInput(page, second.project_id, [{ material_id: foreignPin.material_id, material_version: foreignPin.material_version }]);
  audit.checkpoint('same-user-cross-project-material-rejected', rejected); expect(rejected.status).toBe(404);
  await openProject(page, second.project_id); const own = await uploadFromPicker(page, second.project_id, asUploadFile(file));
  const accepted = await lockCurrentInput(page, second.project_id, [{ material_id: own.material_id, material_version: own.material_version }]);
  audit.checkpoint('same-user-correct-project-material-accepted', accepted); expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  audit.noTaskOrDebit('cross-project-rejection-and-correction-no-run-or-credit-event');
});
