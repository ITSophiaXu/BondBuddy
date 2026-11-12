import { expect, test, type Page } from '@playwright/test';
import { UPLOAD_BYTES_PENDING_FIELD_ERROR } from '@bondbuddy/contracts';
import { assertFixture, calls, fixture, ids, latestUpload, now, pdf, setup, type State } from './upload-session-recovery-fixtures';

test.beforeEach(async ({ page }) => { await page.clock.install({ time: new Date(now) }); });
test.afterEach(({ page }) => assertFixture(page));
const picker = (page: Page) => page.locator('[data-upload-role="audit"]');
const row = (page: Page, id: string) => page.locator(`[data-upload-id="${id}"]`);
async function pendingContract(page: Page, state: State) {
  await page.route('**/api/v1/projects/*/materials/uploads/*/complete', async route => {
    const path = new URL(route.request().url()).pathname.slice('/api/v1'.length);
    const id = path.split('/').at(-2)!, upload = state.uploads.get(id);
    if (!upload || upload.state !== 'uploading') return route.fallback();
    state.calls.push({ page: 'pending-bytes-contract', owner: state.owner, method: 'POST', path, body: route.request().postDataJSON() });
    return route.fulfill({ status: 422, json: { code: 'MATERIAL_UNREADABLE', field_errors: [UPLOAD_BYTES_PENDING_FIELD_ERROR] } });
  });
}

test('expired lost-body recovery reselects once, keeps its old ID and survives refresh and reopen', async ({ page, context }) => {
  const state = fixture(), file = pdf('过期后重新选择原文件.pdf'); state.dropBeforeReceive = 1;
  await setup(page, state); await pendingContract(page, state); await picker(page).setInputFiles(file);
  await expect.poll(() => calls(state, 'put').length).toBe(1);
  const operation = (await page.locator('.material-file-row[data-upload-id]').getAttribute('data-upload-id'))!;
  const original = latestUpload(state).id;
  state.clock += 16 * 60000; await page.clock.setSystemTime(new Date(state.clock)); await page.reload();
  const reselect = row(page, operation).locator('[data-upload-action="reselect"]'); await expect(reselect).toBeVisible();
  expect(calls(state, 'create')).toHaveLength(1); expect(calls(state, 'put')).toHaveLength(1);
  let finish!: () => void; state.completeGate = async upload => { if (upload.id !== original) await new Promise<void>(resolve => { finish = resolve; }); };
  const chooser = page.waitForEvent('filechooser'); await reselect.click(); await (await chooser).setFiles(file);
  await expect.poll(() => state.activeCompletes).toBe(1);
  const checkpoint = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('bondbuddy:upload-recovery:v1:')).map(k => JSON.parse(localStorage.getItem(k)!)));
  expect(checkpoint[0].previousUploadIds).toEqual([original]); state.completeGate = undefined; finish();
  await expect.poll(() => state.materials.size).toBe(1);
  await expect(row(page, operation)).toHaveAttribute('data-upload-phase', 'persisted');
  expect(calls(state, 'create')).toHaveLength(2); expect(calls(state, 'put')).toHaveLength(2);
  expect(latestUpload(state).id).not.toBe(original); expect(state.uploads.get(original)?.state).toBe('uploading');
  const savedId = [...state.materials.keys()][0]; await page.reload();
  await expect(page.locator('.material-file-row')).toContainText(['服务器已确认保存']);
  await page.close(); const reopened = await context.newPage(); await reopened.clock.install({ time: new Date(state.clock) });
  await setup(reopened, state); await expect(reopened.locator('.material-file-row')).toContainText(['服务器已确认保存']);
  expect([...state.materials.keys()]).toEqual([savedId]); expect(calls(state, 'create')).toHaveLength(2); expect(calls(state, 'put')).toHaveLength(2); assertFixture(reopened);
});
