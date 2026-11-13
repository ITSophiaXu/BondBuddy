import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureBody } from './billing-fixture-wire';
import { assertFixture, calls, fixture, ids, latestUpload, now, pdf, seedMaterial, setup, writes,
  type FilePayload, type State } from './upload-session-recovery-fixtures';

// Real browser state/recovery journal; all HTTP receipts and files are synthetic.
test.beforeEach(async ({ page }) => { await page.clock.install({ time: new Date(now) }); });
test.afterEach(({ page }) => assertFixture(page));

const pendingRow = (page: Page, operation: string) => page.locator(`[data-upload-id="${operation}"]`);
const auditRows = (page: Page) => page.locator('[data-material-role="audit"] .material-file-row');
const refresh = (page: Page) => page.locator('[data-refresh-materials]').click();
async function journal(page: Page) {
  return page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('bondbuddy:upload-recovery:v1:'))
    .map(key => ({ key, record: JSON.parse(localStorage.getItem(key)!) })));
}
async function failedUpload(page: Page, state = fixture(), file: FilePayload = pdf('重试后只能显示一份的审计报告.pdf'), reason: 'inspection_timeout' | 'structure_invalid' = 'inspection_timeout') {
  state.inspectionReason = reason;
  await setup(page, state);
  await page.locator('[data-upload-role="audit"]').setInputFiles(file);
  const local = auditRows(page).filter({ hasText: file.name });
  await expect(local).toHaveCount(1);
  const operation = (await local.getAttribute('data-upload-id'))!;
  await expect(local).toHaveAttribute('data-upload-phase', 'failed');
  await expect(local.locator(`[data-upload-action="${reason === 'structure_invalid' ? 'replace' : 'retry'}"]`)).toBeEnabled();
  expect(calls(state, 'create')).toHaveLength(1);
  expect(calls(state, 'put')).toHaveLength(1);
  return { state, file, operation, upload: latestUpload(state) };
}
async function onlySaved(page: Page, filename: string) {
  // Assert count and success together so a transient pre-refresh single failed
  // row cannot satisfy the count assertion before the server list arrives.
  await expect(auditRows(page)).toHaveText([/上传成功/]);
  await expect(auditRows(page)).toContainText([filename]);
  await expect(auditRows(page).locator('[data-upload-action="retry"]')).toHaveCount(0);
  await expect(auditRows(page).locator('[data-upload-action="remove"]')).toHaveCount(0);
}
function originalTransport(state: State) {
  expect(calls(state, 'create')).toHaveLength(1);
  expect(calls(state, 'put')).toHaveLength(1);
}

test('a saved receipt discovered after upload failure replaces its failed row and clears the recovery journal', async ({ page }) => {
  const { state, file, upload } = await failedUpload(page);
  seedMaterial(state, file, { uploadId: upload.id });
  const before = writes(state).length;
  await refresh(page);
  await onlySaved(page, file.name);
  if (process.env.BB_RETRY_EVIDENCE_DIR) {
    await mkdir(process.env.BB_RETRY_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.BB_RETRY_EVIDENCE_DIR, 'reconciled.png'), fullPage: true });
  }
  await expect.poll(async () => (await journal(page)).length).toBe(0);
  expect(writes(state)).toHaveLength(before);
  originalTransport(state);
  await page.reload();
  await onlySaved(page, file.name);
  originalTransport(state);
});

test('reload reconciles the original saved upload with its restored failure without another complete or PUT', async ({ page }) => {
  const { state, file, upload } = await failedUpload(page);
  seedMaterial(state, file, { uploadId: upload.id });
  const before = writes(state).length;
  await page.reload();
  await onlySaved(page, file.name);
  await expect.poll(async () => (await journal(page)).length).toBe(0);
  expect(writes(state)).toHaveLength(before);
  await page.goto(`/#/projects/${ids.sibling}`);
  await expect(page.locator('[data-upload-role="audit"]')).toBeEnabled();
  await expect(auditRows(page)).toHaveCount(0);
  await page.goto(`/#/projects/${ids.project}`);
  await onlySaved(page, file.name);
  expect(writes(state)).toHaveLength(before);
});

test('a complete canonical duplicate may reconcile an idle failure despite its older upload identity and filename', async ({ page }) => {
  const { state, file, upload } = await failedUpload(page);
  const material = seedMaterial(state, file, { uploadId: 'earlier-canonical-audit-upload', filename: '先前保存的完整同内容报告.pdf' });
  expect(material.upload_id).not.toBe(upload.id);
  const before = writes(state).length;
  await refresh(page);
  await onlySaved(page, material.filename);
  await expect.poll(async () => (await journal(page)).length).toBe(0);
  expect(writes(state)).toHaveLength(before);
  originalTransport(state);
});

test('a canonical duplicate cannot hide a deterministic rejection of the current upload, including after reload', async ({ page }) => {
  const { state, file, operation, upload } = await failedUpload(page, fixture(), pdf('原上传结构检查被拒绝.pdf'), 'structure_invalid');
  const material = seedMaterial(state, file, { uploadId: 'earlier-canonical-audit-upload' });
  expect(material.upload_id).not.toBe(upload.id);
  const before = writes(state).length;
  await refresh(page);
  await expect(pendingRow(page, operation)).toHaveAttribute('data-upload-phase', 'failed');
  await expect(pendingRow(page, operation).locator('[data-upload-action="replace"]')).toBeEnabled();
  expect(await journal(page)).toHaveLength(1);
  await page.reload();
  await expect(pendingRow(page, operation)).toHaveAttribute('data-upload-phase', 'uncertain');
  expect(await journal(page)).toHaveLength(1);
  expect(writes(state)).toHaveLength(before);
  originalTransport(state);
});

for (const lateStatus of [503, 422] as const) test(`a late ${lateStatus} complete cannot undo a saved receipt or retransmit bytes while retrying the same upload`, async ({ page }) => {
  const { state, file, operation, upload } = await failedUpload(page);
  state.inspectionReason = undefined;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false, responded = false;
  await page.route(`**/materials/uploads/${upload.id}/complete`, async route => {
    entered = true;
    await gate;
    await route.fulfill({ status: lateStatus, json: fixtureBody(route, {
      code: lateStatus === 422 ? 'MATERIAL_UNREADABLE' : 'DATA_UNAVAILABLE', message: 'Synthetic delayed failure', retryable: lateStatus >= 500,
      correlation_id: 'late-upload-complete', field_errors: [],
    }) }).catch(() => undefined); // Reconciliation may cancel this stale request.
    responded = true;
  });
  await pendingRow(page, operation).locator('[data-upload-action="retry"]').click();
  await expect.poll(() => entered).toBe(true);
  seedMaterial(state, file, { uploadId: upload.id });
  await refresh(page);
  try { await onlySaved(page, file.name); }
  finally { release(); }
  await expect.poll(() => responded).toBe(true);
  await page.clock.runFor(6000);
  await onlySaved(page, file.name);
  await expect.poll(async () => (await journal(page)).length).toBe(0);
  originalTransport(state);
  await page.reload();
  await onlySaved(page, file.name);
});

for (const mismatch of ['content', 'role', 'size', 'media', 'project', 'owner'] as const) {
  test(`a same-name saved material with a different ${mismatch} cannot clear the original failed upload`, async ({ page }) => {
    const { state, file, operation, upload } = await failedUpload(page);
    const changed = Buffer.from(file.buffer);
    changed[changed.length - 8] ^= 1;
    const other = mismatch === 'content' ? { ...file, buffer: changed }
      : mismatch === 'size' ? { ...file, buffer: Buffer.concat([file.buffer, Buffer.from('extra')]) }
        : mismatch === 'media' ? { ...file, mimeType: 'text/plain' } : file;
    seedMaterial(state, other, { uploadId: upload.id,
      ...(mismatch === 'role' ? { role: 'financial' as const } : {}),
      ...(mismatch === 'project' ? { project: ids.sibling } : {}),
      ...(mismatch === 'owner' ? { owner: ids.otherOwner } : {}),
    });
    const before = writes(state).length;
    await refresh(page);
    await expect(pendingRow(page, operation)).toHaveAttribute('data-upload-phase', 'failed');
    await expect(pendingRow(page, operation).locator('[data-upload-action="retry"]')).toBeEnabled();
    expect(await journal(page)).toHaveLength(1);
    await page.reload();
    await expect(pendingRow(page, operation)).toHaveAttribute('data-upload-phase', 'uncertain');
    await expect(pendingRow(page, operation).locator('[data-upload-action="retry"]')).toBeEnabled();
    expect(await journal(page)).toHaveLength(1);
    expect(writes(state)).toHaveLength(before);
    originalTransport(state);
  });
}

test('retry success remains saved when its final local journal write fails once', async ({ page }) => {
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    let injected = false;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (!injected && this === localStorage && key.startsWith('bondbuddy:upload-recovery:v1:')) {
        const record = JSON.parse(value);
        if (record.purpose === 'authoring-material' && record.stage === 'saved') {
          injected = true;
          (window as unknown as { savedJournalFailure: boolean }).savedJournalFailure = true;
          throw new DOMException('Synthetic final journal write failure', 'QuotaExceededError');
        }
      }
      return set.call(this, key, value);
    };
  });
  const { state, file, operation } = await failedUpload(page, fixture(), pdf('重试保存回执已到但本地记录写入失败.pdf'));
  // The trusted complete response must suffice even when discovery cannot run.
  state.discoveryUnavailable = true;
  state.inspectionReason = undefined;
  await pendingRow(page, operation).locator('[data-upload-action="retry"]').click();
  await expect.poll(() => state.materials.size).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as unknown as { savedJournalFailure?: boolean }).savedJournalFailure)).toBe(true);
  await onlySaved(page, file.name);
  originalTransport(state);
  state.discoveryUnavailable = false;
  await refresh(page);
  await expect.poll(async () => (await journal(page)).length).toBe(0);
  await page.reload();
  await onlySaved(page, file.name);
  originalTransport(state);
});

test('retry success remains saved when reading the completed journal for UI synchronization fails once', async ({ page }) => {
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem, get = Storage.prototype.getItem;
    let completedKey: string | undefined, reads = 0, injected = false;
    Storage.prototype.setItem = function (key: string, value: string) {
      set.call(this, key, value);
      if (this === localStorage && key.startsWith('bondbuddy:upload-recovery:v1:')) {
        const record = JSON.parse(value);
        if (record.purpose === 'authoring-material' && record.stage === 'saved') completedKey = key;
      }
    };
    Storage.prototype.getItem = function (key: string) {
      // The first read verifies the durable write. The next read is the page's
      // post-success syncRecord, after the complete receipt was validated.
      if (!injected && this === localStorage && key === completedKey && ++reads === 2) {
        injected = true;
        (window as unknown as { savedJournalReadFailure: boolean }).savedJournalReadFailure = true;
        throw new DOMException('Synthetic journal synchronization failure', 'SecurityError');
      }
      return get.call(this, key);
    };
  });
  const { state, file, operation } = await failedUpload(page, fixture(), pdf('重试保存成功后读取本机记录失败.pdf'));
  state.discoveryUnavailable = true;
  state.inspectionReason = undefined;
  await pendingRow(page, operation).locator('[data-upload-action="retry"]').click();
  await expect.poll(() => state.materials.size).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as unknown as { savedJournalReadFailure?: boolean }).savedJournalReadFailure)).toBe(true);
  await onlySaved(page, file.name);
  originalTransport(state);
  state.discoveryUnavailable = false;
  await refresh(page);
  await expect.poll(async () => (await journal(page)).length).toBe(0);
  await page.reload();
  await onlySaved(page, file.name);
  originalTransport(state);
});
