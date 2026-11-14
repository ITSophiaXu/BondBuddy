import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { UPLOAD_BYTES_PENDING_FIELD_ERROR } from '@bondbuddy/contracts';
import { fixtureBody } from './billing-fixture-wire';
import { assertFixture, calls, fixture, hash, ids, latestUpload, now, pdf, secretUrlToken, seedMaterial, setup, writes,
  type FilePayload, type ReceiptFault, type State } from './upload-session-recovery-fixtures';

test.afterEach(({ page }) => assertFixture(page));
test.beforeEach(async ({ page }) => { await page.clock.install({ time: new Date(now) }); });
test.setTimeout(60_000);
const row = (page: Page, operation: string) => page.locator(`[data-upload-id="${operation}"]`);
const confirm = (page: Page, operation: string) => row(page, operation).locator('[data-upload-action="retry"]');
const picker = (page: Page) => page.locator('[data-upload-role="audit"]');
async function screenshot(page: Page, name: string) {
  const output = process.env.BB_UX_EVIDENCE_DIR; if (!output) return;
  await mkdir(output, { recursive: true }); await page.screenshot({ path: join(output, `upload-session-recovery-${name}.png`), fullPage: false });
}
async function journal(page: Page) {
  return page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('bondbuddy:upload-recovery:v1:'))
    .map(key => ({ key, raw: localStorage.getItem(key)! })));
}
async function selectedOperation(page: Page, file: FilePayload) {
  const selected = page.locator('.material-file-row[data-upload-id]').filter({ hasText: file.name });
  await expect(selected).toHaveCount(1); return (await selected.getAttribute('data-upload-id'))!;
}
async function settledUncertain(page: Page, operation: string, advance = 2000) {
  // The UI enters uncertain briefly before each automatic confirmation. Wait
  // for the final recovery message, advancing the real retry budget in the
  // browser clock, so a subsequent reload cannot race the old page's retries.
  await expect.poll(async () => {
    if (advance > 2000) await page.clock.fastForward(advance);
    else await page.clock.runFor(advance);
    return await row(page, operation).textContent();
  }, { timeout: 20_000, intervals: [100] }).toContain('暂时无法确认保存结果');
  await expect(row(page, operation)).toHaveAttribute('data-upload-phase', 'uncertain');
}
async function lostPut(page: Page, state = fixture(), file = pdf()) {
  state.dropPutReplies = 1; state.completeUnavailable = true;
  await setup(page, state); await picker(page).setInputFiles(file); const operation = await selectedOperation(page, file);
  await expect.poll(() => latestUpload(state)?.state).toBe('received');
  await settledUncertain(page, operation);
  const upload = latestUpload(state).id;
  expect(calls(state, 'create')).toHaveLength(1); expect(calls(state, 'put')).toHaveLength(1); expect(state.materials.size).toBe(0);
  return { state, file, operation, upload };
}
async function reloadPending(page: Page, state: State, operation: string) {
  const previousWrites = writes(state).length; await page.reload();
  await expect(picker(page)).toBeEnabled(); await expect(confirm(page, operation)).toBeVisible();
  await expect(confirm(page, operation)).toContainText('确认原上传');
  await expect(picker(page)).toHaveValue('');
  expect(writes(state).length, 'Loading recovery metadata must not create, PUT, complete or perform business writes.').toBe(previousWrites);
}
async function saved(page: Page, state: State, filename?: string) {
  await expect.poll(() => state.materials.size).toBe(1);
  await expect(page.locator('.material-file-row')).toHaveText([/服务器已确认保存/]);
  if (filename) await expect(page.locator('.material-file-row')).toContainText([filename]);
}
async function reselect(page: Page, operation: string, file: FilePayload) {
  const chooser = page.waitForEvent('filechooser');
  await row(page, operation).locator('[data-upload-action="reselect"]').click();
  await (await chooser).setFiles(file);
}
function unchangedTransport(state: State, creates = 1, puts = 1) {
  expect(calls(state, 'create')).toHaveLength(creates); expect(calls(state, 'put')).toHaveLength(puts);
}

for (const width of [1440, 390]) {
  test(`received PUT with a lost reply survives reload and explicit confirmation without File or a second PUT at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    const { state, operation, upload, file } = await lostPut(page, fixture(), pdf('待确认的原审计报告与财务报表附注-长文件名.pdf'));
    const records = await journal(page); expect(records).toHaveLength(1);
    const record = JSON.parse(records[0].raw);
    expect(record).toMatchObject({ owner: ids.owner, projectId: ids.project, purpose: 'authoring-material', uploadId: upload,
      declaration: { filename: file.name, role: 'audit', byte_size: file.buffer.length, sha256: hash(file.buffer), media_type: file.mimeType } });
    expect(records[0].raw).not.toContain(secretUrlToken); expect(records[0].raw).not.toContain('upload_url');
    expect(records[0].raw).not.toContain(file.buffer.toString());
    await reloadPending(page, state, operation); await row(page, operation).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await screenshot(page, `pending-${width}`);
    const before = calls(state, 'complete').length; state.completeUnavailable = false;
    await confirm(page, operation).click(); await saved(page, state, file.name);
    expect(calls(state, 'complete').slice(before).map(call => call.path)).toEqual([`/projects/${ids.project}/materials/uploads/${upload}/complete`]);
    unchangedTransport(state); await screenshot(page, `saved-${width}`);
    await page.reload(); await saved(page, state, file.name); unchangedTransport(state);
  });
}

test('a lost complete reply returns the original material after reload without retransmitting bytes', async ({ page }) => {
  const state = fixture(), file = pdf('完成回执丢失.pdf');
  state.dropCompleteReplies = 1; state.blockAfterCompleteDrop = true; state.discoveryUnavailable = true;
  await setup(page, state); await picker(page).setInputFiles(file); const operation = await selectedOperation(page, file);
  await expect.poll(() => state.materials.size).toBe(1);
  await settledUncertain(page, operation);
  const original = [...state.materials.keys()][0], upload = latestUpload(state).id;
  await reloadPending(page, state, operation); state.completeUnavailable = false; state.discoveryUnavailable = false;
  await confirm(page, operation).click(); await saved(page, state, file.name);
  expect([...state.materials.keys()]).toEqual([original]); unchangedTransport(state);
  expect(calls(state, 'complete').every(call => call.path.endsWith(`/${upload}/complete`))).toBe(true);
});

test('an expired session with received bytes is still confirmed with the original complete', async ({ page }) => {
  const { state, operation, upload } = await lostPut(page);
  state.clock += 16 * 60000; await page.clock.setSystemTime(new Date(state.clock));
  expect(Date.parse(latestUpload(state).expiresAt)).toBeLessThan(state.clock);
  await reloadPending(page, state, operation); state.completeUnavailable = false;
  await confirm(page, operation).click(); await saved(page, state); unchangedTransport(state);
  expect(calls(state, 'complete').at(-1)!.path).toContain(`/${upload}/complete`);
});

test('a complete receipt may reuse an older upload ID and filename when every content declaration agrees', async ({ page }) => {
  const { state, operation, file, upload } = await lostPut(page); await reloadPending(page, state, operation);
  const prior = seedMaterial(state, file, { filename: '原先保存的同内容审计报告.pdf', uploadId: 'old-deduplicated-upload' });
  state.completeUnavailable = false; await confirm(page, operation).click(); await saved(page, state, prior.filename);
  expect(prior.upload_id).not.toBe(upload); expect([...state.materials.keys()]).toEqual([prior.material_id]); unchangedTransport(state);
});

for (const fault of ['role', 'media', 'size', 'hash', 'schema', 'state'] as ReceiptFault[]) {
  test(`a ${fault} mismatch in a complete receipt never becomes a saved material or a new upload`, async ({ page }) => {
    const { state, operation } = await lostPut(page); await reloadPending(page, state, operation);
    state.completeUnavailable = false; state.receiptFault = fault;
    await confirm(page, operation).click();
    if (['size', 'hash', 'schema'].includes(fault)) {
      // The API client rejects these before UploadRecovery receives a DTO, so
      // the result remains unconfirmed rather than becoming an accepted file.
      await settledUncertain(page, operation);
    } else {
      await expect(row(page, operation)).toHaveAttribute('data-upload-phase', 'failed');
      await expect(row(page, operation)).toContainText(/回执|不一致|未确认/);
    }
    await expect(row(page, operation)).not.toContainText('服务器已确认保存');
    expect(state.materials.size).toBe(0); unchangedTransport(state);
    state.receiptFault = undefined; await confirm(page, operation).click(); await saved(page, state); unchangedTransport(state);
  });
}

for (const reason of ['inspection_timeout', 'structure_invalid'] as const) {
  test(`422 ${reason} preserves the rejected upload and offers the appropriate explicit recovery`, async ({ page }) => {
    const { state, operation, upload } = await lostPut(page); await reloadPending(page, state, operation);
    state.completeUnavailable = false; state.inspectionReason = reason;
    await confirm(page, operation).click(); await expect(row(page, operation)).toHaveAttribute('data-upload-phase', 'failed');
    await expect(row(page, operation)).toContainText(/检查|读取|超时|确认|核验/);
    await expect(row(page, operation).locator('[data-upload-action="reselect"]')).toHaveCount(0);
    expect(latestUpload(state).id).toBe(upload); expect(latestUpload(state).state).toBe('received'); unchangedTransport(state);
    state.inspectionReason = undefined;
    if (reason === 'structure_invalid') {
      await expect(confirm(page, operation)).toHaveCount(0);
      const chooser = page.waitForEvent('filechooser');
      await row(page, operation).locator('[data-upload-action="replace"]').click();
      const replacement = pdf('结构检查失败后明确选择的新文件.pdf', 'different valid replacement');
      await (await chooser).setFiles(replacement);
      await saved(page, state, replacement.name);
      expect(latestUpload(state).id).not.toBe(upload); unchangedTransport(state, 2, 2);
      expect(state.uploads.get(upload)!.state).toBe('received');
    } else {
      await confirm(page, operation).click(); await saved(page, state); unchangedTransport(state);
    }
  });
}

test('a same-name same-size changed file cannot replace a missing original; renamed equal bytes can continue its declaration', async ({ page }) => {
  const state = fixture(), file = pdf('需要重新选择的原稿.pdf'); state.dropBeforeReceive = 1;
  await setup(page, state);
  // Model the current server's explicit unreceived-bytes receipt. A generic
  // unreadable-file rejection is deliberately insufficient to replace bytes.
  await page.route('**/materials/uploads/*/complete', async route => {
    const uploadId = new URL(route.request().url()).pathname.split('/').at(-2)!;
    if (state.uploads.get(uploadId)?.state !== 'uploading') return route.fallback();
    return route.fulfill({ status: 422, json: fixtureBody(route, {
      code: 'MATERIAL_UNREADABLE', message: 'Synthetic original bytes have not arrived', retryable: false,
      correlation_id: 'missing-original-bytes',
      field_errors: [{ ...UPLOAD_BYTES_PENDING_FIELD_ERROR, message: 'Upload bytes not received' }],
    }) });
  });
  await picker(page).setInputFiles(file); const operation = await selectedOperation(page, file);
  await expect.poll(() => calls(state, 'put').length).toBe(1);
  await settledUncertain(page, operation, 600_001);
  state.clock = await page.evaluate(() => Date.now());
  expect(Date.parse(latestUpload(state).expiresAt)).toBeLessThan(state.clock);
  const upload = latestUpload(state).id; await reloadPending(page, state, operation);
  await expect(row(page, operation).locator('[data-upload-action="reselect"]')).toBeVisible();
  const changed = Buffer.from(file.buffer); changed[changed.length - 8] ^= 1;
  await reselect(page, operation, { ...file, buffer: changed });
  await expect(row(page, operation)).toHaveAttribute('data-upload-phase', 'failed');
  await expect(row(page, operation)).toContainText(/相同|原文件|不一致|声明/); unchangedTransport(state); expect(state.materials.size).toBe(0);
  await reselect(page, operation, { ...file, name: '改名但内容完全相同.pdf' }); await saved(page, state, file.name);
  unchangedTransport(state, 2, 2); expect(latestUpload(state).id).not.toBe(upload);
  expect(calls(state, 'create').at(-1)!.body).toEqual(calls(state, 'create')[0].body);
});

test('two tabs claiming the same restored upload permit one complete in flight and share the exact saved result', async ({ page, context }) => {
  const { state, operation } = await lostPut(page); await reloadPending(page, state, operation);
  const second = await context.newPage(); await second.clock.install({ time: new Date(now) });
  await setup(second, state); await expect(confirm(second, operation)).toBeVisible();
  let release!: () => void; state.completeUnavailable = false;
  state.completeGate = () => new Promise<void>(resolve => { release = resolve; }); const before = calls(state, 'complete').length;
  await confirm(page, operation).click(); await expect.poll(() => state.activeCompletes).toBe(1);
  await confirm(second, operation).click(); await expect(row(second, operation)).toContainText(/另一|处理|页面|锁/);
  expect(calls(state, 'complete').length - before).toBe(1); expect(state.maxActiveCompletes).toBe(1);
  state.completeGate = undefined; release(); await saved(page, state);
  if (await confirm(second, operation).isVisible()) await confirm(second, operation).click();
  await saved(second, state); unchangedTransport(state); expect(state.maxActiveCompletes).toBe(1); assertFixture(second);
});

test('pending material identity stays in its original project while another project is open', async ({ page }) => {
  const { state, file, operation } = await lostPut(page); await reloadPending(page, state, operation); const previous = writes(state).length;
  await page.goto(`/#/projects/${ids.sibling}`); await expect(picker(page)).toBeEnabled();
  await expect(page.locator('#material-partitions')).not.toContainText(file.name); expect(writes(state)).toHaveLength(previous);
  await page.goto(`/#/projects/${ids.project}`); await expect(confirm(page, operation)).toBeVisible();
  expect(writes(state)).toHaveLength(previous); state.completeUnavailable = false; await confirm(page, operation).click(); await saved(page, state);
  expect([...state.materials.values()][0]).toMatchObject({ owner: ids.owner, project: ids.project }); unchangedTransport(state);
});

test('a late original-owner complete cannot expose the filename or result in a new account workspace', async ({ page }) => {
  const { state, file, operation } = await lostPut(page); await reloadPending(page, state, operation);
  let release!: () => void; state.completeUnavailable = false; state.completeGate = () => new Promise<void>(resolve => { release = resolve; });
  await confirm(page, operation).click(); await expect.poll(() => state.activeCompletes).toBe(1);
  const documentOrigin = await page.evaluate(() => performance.timeOrigin); state.owner = null;
  await page.evaluate(() => { const channel = new BroadcastChannel('bondbuddy-session'); channel.postMessage('changed'); channel.close(); });
  await expect(page.getByRole('heading', { name: '登录工作区', exact: true })).toBeVisible();
  await page.getByLabel('用户名', { exact: true }).fill('recovery_owner_b');
  await page.getByLabel('密码', { exact: true }).fill('Synthetic-recovery-owner-b');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '任务进度与结果', exact: true })).toBeVisible();
  await page.goto(`/#/projects/${ids.otherProject}`); await expect(picker(page)).toBeEnabled();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentOrigin);
  state.completeGate = undefined; release(); await expect.poll(() => state.activeCompletes).toBe(0);
  await expect(page.locator('body')).not.toContainText(file.name); await expect(page.locator('.material-file-row')).toHaveCount(0);
  expect(writes(state).filter(call => call.owner === ids.otherOwner)).toEqual([]);
  expect(writes(state).filter(call => call.path === '/auth/login')).toHaveLength(1);
  expect([...state.materials.values()].every(item => item.owner === ids.owner && item.project === ids.project)).toBe(true);
});

for (const fault of ['quota', 'write-readback'] as const) {
  test(`a local recovery ${fault} failure keeps the selected file visible and stops before any upload write`, async ({ page }) => {
    await page.addInitScript(mode => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (this === localStorage && key.startsWith('bondbuddy:upload-recovery:')) {
          if (mode === 'quota') throw new DOMException('Synthetic recovery store full', 'QuotaExceededError');
          return;
        }
        return set.call(this, key, value);
      };
    }, fault);
    const state = await setup(page), file = pdf('本地恢复记录保存失败仍保留此文件.pdf');
    await picker(page).setInputFiles(file); const operation = await selectedOperation(page, file);
    await expect(row(page, operation)).toHaveAttribute('data-upload-phase', 'failed');
    await expect(row(page, operation)).toContainText(/恢复记录|保留原文件|可靠保存/);
    await expect(row(page, operation)).not.toContainText('服务器已确认保存');
    expect(writes(state)).toEqual([]); expect(state.uploads.size).toBe(0); expect(state.materials.size).toBe(0);
  });
}

test('five queued files keep every prepared original declaration across reload while all four transfer slots are blocked', async ({ page }) => {
  const state = fixture(); state.completeUnavailable = true;
  const files = [pdf('批量一-审计原稿.pdf'), pdf('批量二-债务资料.pdf', 'second debt document'), pdf('批量三-其他资料.pdf', 'third pending original'),pdf('批量四-其他资料.pdf','fourth original'),pdf('批量五-待传资料.pdf','fifth original')];
  const roles = ['audit', 'debt', 'other','other','other'] as const, releases: (() => void)[] = [];
  state.putGate = () => new Promise<void>(resolve => { releases.push(resolve); });
  await setup(page, state);
  for (let i = 0; i < files.length; i++) {
    const input = page.locator(`[data-upload-role="${roles[i]}"]`);
    await expect(input).toHaveCount(1); await input.setInputFiles(files[i]);
  }
  await expect.poll(() => releases.length).toBe(4);
  await expect.poll(async () => (await journal(page)).length).toBe(5);
  const records: { id: string; uploadId?: string; declaration: { filename: string; role: string; sha256: string; byte_size: number } }[] =
    (await journal(page)).map(item => JSON.parse(item.raw));
  for (let i = 0; i < files.length; i++) expect(records.find(record => record.declaration.filename === files[i].name)?.declaration)
    .toMatchObject({ role: roles[i], sha256: hash(files[i].buffer), byte_size: files[i].buffer.length });
  const fifth = records.find(record => record.declaration.filename === files[4].name)!;
  expect(fifth.uploadId).toBeUndefined(); unchangedTransport(state, 4, 4);
  const previousWrites = writes(state).length;
  page.once('dialog', async dialog => {
    if (dialog.type() !== 'beforeunload') { state.errors.push(`Unexpected ${dialog.type()} dialog during explicit refresh`); await dialog.dismiss(); }
    else await dialog.accept();
  });
  await page.reload(); await expect(picker(page)).toBeEnabled();
  for (let i = 0; i < files.length; i++) {
    const record = records.find(record => record.declaration.filename === files[i].name)!;
    await expect(row(page, record.id)).toContainText(files[i].name);
    await expect(row(page, record.id).locator('[data-upload-action="retry"]')).toBeAttached();
    await expect(page.locator(`[data-material-role="${roles[i]}"]`)).toContainText(files[i].name);
  }
  expect(writes(state)).toHaveLength(previousWrites);
  state.putGate = undefined; for (const release of releases) release(); state.completeUnavailable = false;
  await confirm(page, fifth.id).click();
  await expect(row(page, fifth.id).locator('[data-upload-action="reselect"]')).toBeVisible();
  expect(writes(state), 'Confirming a prepared item without a session must first request the original bytes.').toHaveLength(previousWrites);
  await reselect(page, fifth.id, files[4]); await expect.poll(() => state.materials.size).toBe(1);
  for (const record of records.filter(record => record.uploadId)) {
    const target = row(page, record.id);
    await target.locator('xpath=ancestor::details').evaluateAll(details => details.forEach(detail => { (detail as HTMLDetailsElement).open = true; }));
    await confirm(page, record.id).click();
  }
  await expect.poll(() => state.materials.size).toBe(5); unchangedTransport(state, 5, 5);
  await expect(page.locator('.material-file-row')).toHaveCount(5);
  for (let i = 0; i < files.length; i++) {
    const material = [...state.materials.values()].find(item => item.material.filename === files[i].name)!;
    expect(material).toMatchObject({ owner: ids.owner, project: ids.project, material: { role: roles[i], sha256: hash(files[i].buffer), byte_size: files[i].buffer.length } });
    await expect(page.locator('.material-file-row').filter({ hasText: files[i].name })).toContainText('服务器已确认保存');
  }
});

test('a second tab with a no-session snapshot discovers only the unique exact saved material after the first tab clears its journal', async ({ page, context }) => {
  const state = fixture(), file = pdf('跨页创建回执未到的原稿.pdf');
  let release!: () => void; state.createGate = () => new Promise<void>(resolve => { release = resolve; });
  await setup(page, state); await picker(page).setInputFiles(file); const operation = await selectedOperation(page, file);
  await expect.poll(() => Boolean(release)).toBe(true); await expect.poll(async () => (await journal(page)).length).toBe(1);
  expect(JSON.parse((await journal(page))[0].raw).uploadId).toBeUndefined(); unchangedTransport(state, 1, 0);
  const second = await context.newPage(); await second.clock.install({ time: new Date(now) }); await setup(second, state);
  await expect(confirm(second, operation)).toBeVisible();
  expect(JSON.parse((await journal(second))[0].raw).uploadId).toBeUndefined(); unchangedTransport(state, 1, 0);
  state.createGate = undefined; release(); await saved(page, state, file.name);
  await expect.poll(async () => (await journal(page)).length).toBe(0);
  const material = [...state.materials.values()][0].material, previousWrites = writes(state).length, previousCalls = state.calls.length;
  await confirm(second, operation).click(); await saved(second, state, file.name);
  expect(writes(state), 'A no-session snapshot can only reconcile authorized saved material metadata.').toHaveLength(previousWrites);
  const reads = state.calls.slice(previousCalls).filter(call => call.method === 'GET');
  expect(reads.some(call => call.path === `/projects/${ids.project}/events`)).toBe(true);
  expect(reads.some(call => call.path === `/projects/${ids.project}/materials/${material.material_id}` && call.search === `?version=${material.material_version}`)).toBe(true);
  unchangedTransport(state); expect(calls(state, 'complete')).toHaveLength(1); expect([...state.materials.keys()]).toEqual([material.material_id]);
  assertFixture(second);
});
