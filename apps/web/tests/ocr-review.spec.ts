import { expect, test, type Page } from '@playwright/test';
import { OcrReviewSchema, type OcrCorrectionRequest, type OcrReview } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';
import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';

// Synthetic HTTP and PNG only. These tests do not run OCR or establish accuracy.
const path = '/projects/synthetic-project/materials/synthetic-material/ocr';
const png = new PNG({ width: 200, height: 100 });
png.data.fill(255);
const image = PNG.sync.write(png);
function review(): OcrReview {
  return {
    snapshot_id: 'synthetic-snapshot', result_sha256: 'a'.repeat(64), material_id: 'synthetic-material', material_version: 1,
    purpose: 'source_preflight', coverage: 'partial', page_count: 74, eligible_for_manuscript: false, warnings: [], corrections: [],
    pages: [1, 2].map(page => ({ page, width: 200, height: 100, rotation_clockwise: 0, coordinate_system: 'rendered_pixels_top_left',
      image_sha256: createHash('sha256').update(image).digest('hex'), warnings: [], image_url: `/api/v1${path}/pages/synthetic-snapshot/${page}` })),
    records: Array.from({ length: 600 }, (_, i) => ({ record_id: `record-${i}`, page: i < 550 ? 1 : 2, bbox: [20, 20, 100, 40],
      text: i === 549 ? '' : '(1,234.50)', confidence: null, numeric: { kind: i === 549 ? 'blank' : 'number', decimal: i === 549 ? null : '-1234.50', unit: null },
      cell: { table_id: `table-${i < 550 ? 1 : 2}`, row: i + 1, column: 1, row_span: 1, column_span: 1 },
      uncertainty: ['synthetic_unverified'], eligible_for_manuscript: false }))
  };
}
type State = {
  review: OcrReview; images: number; imageFailures: number; writes: OcrCorrectionRequest[]; failWrite: boolean; conflict: boolean;
  holdImage?: () => Promise<void>; calls: { method: string; path: string }[];
};
async function open(page: Page) {
  const state: State = { review: review(), images: 0, imageFailures: 0, writes: [], failWrite: false, conflict: false, calls: [] };
  expect(Value.Check(OcrReviewSchema, state.review)).toBe(true);
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), endpoint = url.pathname.replace('/api/v1', '');
    state.calls.push({ method: request.method(), path: endpoint });
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (endpoint === '/me') return json(200, { user_id: 'synthetic-owner', session_status: 'active' });
    if (endpoint === '/projects') return json(200, { items: [], page: { next_cursor: null, has_more: false } });
    if (endpoint.startsWith(`${path}/pages/`)) {
      state.images++;
      if (state.holdImage) await state.holdImage();
      if (state.imageFailures > 0) { state.imageFailures--; return json(503, { code: 'DATA_UNAVAILABLE' }); }
      return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'cache-control': 'no-store' }, body: image });
    }
    if (endpoint === path) return json(200, state.review);
    if (endpoint === `${path}/corrections`) {
      const input = request.postDataJSON() as OcrCorrectionRequest;
      state.writes.push(input);
      if (state.conflict) return json(409, { code: 'INPUT_REVISION_CONFLICT' });
      // Persist once, then lose the first response to exercise idempotent replay.
      if (!state.review.corrections.some(c => c.correction_id === input.request_id)) {
        state.review.corrections.push({ correction_id: input.request_id, record_id: input.record_id, revision: input.expected_revision + 1,
          original_text: state.review.records.find(r => r.record_id === input.record_id)!.text, corrected_text: input.corrected_text,
          period: input.period, unit: input.unit, scope: input.scope, reason: input.reason, actor_user_id: 'synthetic-owner',
          created_at: '2026-09-26T08:00:00Z', status: 'user_asserted', eligible_for_manuscript: false });
      }
      if (state.failWrite) { state.failWrite = false; return route.abort('failed'); }
      return json(200, state.review.corrections.at(-1));
    }
    return json(404, { code: 'NOT_FOUND' });
  });
  await page.goto(`/#${path}`);
  await expect(page.getByRole('heading', { name: '材料识别核对', exact: true })).toBeVisible();
  return state;
}
const record = (page: Page, index: number) => page.locator(`[data-record="record-${index}"]`);
const save = (page: Page) => page.getByRole('button', { name: '保存用户校正', exact: true });

test('all repeated and blank records remain reachable after the first 500', async ({ page }) => {
  const state = await open(page);
  await expect(page.locator('[data-record]')).toHaveCount(500);
  await page.getByRole('button', { name: '下一组' }).click();
  await expect(page.locator('[data-record]')).toHaveCount(100);
  await expect(record(page, 549)).toContainText('（空白单元格）');
  await record(page, 599).click();
  await expect(page.getByRole('heading', { name: '第 2 页原文片段' })).toBeVisible();
  await expect(save(page)).toBeEnabled();
  await expect(page.getByRole('button', { name: '下一组' })).toBeDisabled();
  await page.getByRole('button', { name: '上一组' }).click();
  await expect(record(page, 0)).toBeVisible();
  expect(state.calls.every(c => c.method === 'GET')).toBe(true);
  await expect(page.locator('.ocr-notice')).toContainText('2 / 74');
});

test('physical-page and text filters reset the group and preserve the selected draft', async ({ page }) => {
  await open(page);
  await record(page, 0).click();
  await page.getByLabel('校正后文字或数值').fill('未保存的校正');
  await page.getByRole('button', { name: '下一组' }).click();
  await page.getByLabel('原件页码').selectOption('2');
  await expect(page.locator('[data-record]')).toHaveCount(50);
  await expect(page.getByRole('button', { name: '上一组' })).toBeDisabled();
  await page.getByPlaceholder('按识别文字搜索').fill('无匹配的合成文字');
  await expect(page.locator('[data-record]')).toHaveCount(0);
  await expect(page.getByText('没有匹配的识别内容。')).toBeVisible();
  await page.getByPlaceholder('按识别文字搜索').fill('');
  await expect(page.getByLabel('校正后文字或数值')).toHaveValue('未保存的校正');
  page.once('dialog', dialog => dialog.dismiss());
  await record(page, 550).click();
  await expect(page.getByRole('heading', { name: '第 1 页原文片段' })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await record(page, 550).click();
  await expect(page.getByRole('heading', { name: '第 2 页原文片段' })).toBeVisible();
});

test('failed original image retries without losing input or enabling an unviewed correction', async ({ page }) => {
  const state = await open(page); state.imageFailures = 1;
  await record(page, 0).click();
  await expect(page.getByText('原页暂时无法读取，请稍后重试。')).toBeVisible();
  await page.getByLabel('校正后文字或数值').fill('(1,234.60)');
  await page.getByLabel('校正依据 / 说明').fill('synthetic 用户说明');
  await expect(save(page)).toBeDisabled();
  const retry = page.getByRole('button', { name: '重新读取原页' });
  await retry.click();
  await expect(save(page)).toBeEnabled();
  await expect(page.getByLabel('校正后文字或数值')).toHaveValue('(1,234.60)');
  expect(state.writes).toHaveLength(0); expect(state.images).toBe(2);
});

test('a late image response cannot unlock the newly selected record or revive a disposed page', async ({ page }) => {
  const state = await open(page);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  state.holdImage = () => pending;
  await record(page, 0).click();
  await expect.poll(() => state.images).toBe(1);
  state.holdImage = undefined; state.imageFailures = 1;
  await page.getByLabel('原件页码').selectOption('2');
  await record(page, 550).click();
  await expect(page.getByText('原页暂时无法读取，请稍后重试。')).toBeVisible();
  release();
  await expect(save(page)).toBeDisabled();
  const response = page.waitForResponse(r => r.url().endsWith('/pages/synthetic-snapshot/2'));
  await page.getByRole('button', { name: '重新读取原页' }).click(); await response;
  await expect(save(page)).toBeEnabled();
  const before = state.images;
  let finish!: () => void;
  const afterNavigation = new Promise<void>(resolve => { finish = resolve; });
  state.holdImage = () => afterNavigation;
  await record(page, 551).click();
  await expect.poll(() => state.images).toBe(before + 1);
  await page.getByRole('link', { name: '我的项目', exact: true }).click();
  finish();
  await expect(page.locator('#ocr-crop')).toHaveCount(0);
  expect(state.writes).toHaveLength(0); expect(errors).toEqual([]);
});

test('correction retry reuses the request and refresh restores exact context as user supplied', async ({ page }) => {
  const state = await open(page); state.failWrite = true;
  await record(page, 0).click(); await expect(save(page)).toBeEnabled();
  await page.getByLabel('校正后文字或数值').fill('(1,234.60)');
  await page.getByLabel('所属期间').fill('2025 年末');
  await page.getByLabel('单位', { exact: true }).fill('万元');
  await page.getByLabel('主体与合并口径').fill('合成发行人合并口径');
  await page.getByLabel('校正依据 / 说明').fill('synthetic 用户核对说明');
  await save(page).click(); await expect(page.locator('#ocr-save-status')).not.toHaveText('正在保存…');
  await expect(save(page)).toBeEnabled();
  await save(page).click();
  await expect(page.getByText('用户校正已保存，原始识别和历史记录已保留。')).toBeVisible();
  expect(state.writes).toHaveLength(2); expect(state.writes[0]).toEqual(state.writes[1]);
  expect(state.writes[0]).toMatchObject({ snapshot_id: 'synthetic-snapshot', result_sha256: 'a'.repeat(64), record_id: 'record-0', expected_revision: 0 });
  await page.reload(); await record(page, 0).click();
  await expect(page.getByLabel('校正后文字或数值')).toHaveValue('(1,234.60)');
  await expect(page.getByLabel('所属期间')).toHaveValue('2025 年末');
  await expect(page.getByLabel('单位', { exact: true })).toHaveValue('万元');
  await expect(page.getByLabel('主体与合并口径')).toHaveValue('合成发行人合并口径');
  expect(state.review.corrections).toHaveLength(1);
  expect(state.review.corrections[0]).toMatchObject({ status: 'user_asserted', eligible_for_manuscript: false });
  expect(state.review.records[0].text).toBe('(1,234.50)');
});

test('conflict preserves inputs and narrow-screen navigation stays usable', async ({ page }, testInfo) => {
  const state = await open(page); state.conflict = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('原件页码').selectOption('2'); await record(page, 550).click();
  await expect(save(page)).toBeEnabled();
  await page.getByLabel('校正后文字或数值').fill('0');
  await page.getByLabel('校正依据 / 说明').fill('synthetic 冲突核对');
  await save(page).click();
  await expect(page.locator('#ocr-save-status')).toContainText('当前输入保留');
  await expect(page.getByLabel('校正后文字或数值')).toHaveValue('0');
  expect(state.review.corrections).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.locator('h1').click(); await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('ocr-review-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('ocr-review-desktop.png'), fullPage: true });
});
