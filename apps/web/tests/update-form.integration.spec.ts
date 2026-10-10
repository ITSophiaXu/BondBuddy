import { expect, test } from '@playwright/test';
import { account, login } from './live-helpers';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test.skip(process.env.BB_E2E_LIVE !== '1', 'Requires the dedicated API/database.');

test('DFI form and actual PDF survive browser restart with conflict-safe edits', async ({ page, playwright, browser }) => {
  const user = await account(playwright);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page, user);
  await page.getByRole('link', { name: '新建更新项目', exact: true }).first().click();
  await page.getByLabel('项目名称 必填', { exact: true }).fill('合成 DFI 完整恢复验收');
  await page.getByLabel('发行人全称', { exact: true }).fill('合成测试发行人有限公司');
  await page.getByLabel('发行市场', { exact: true }).selectOption('nafmii');
  await page.getByLabel('发行方式', { exact: true }).selectOption('dfi');
  await page.getByLabel('最新报告期年份').selectOption('2026');
  await page.getByRole('radio',{name:'6月末',exact:true}).check();
  await page.getByLabel('承销安排', { exact: true }).fill('合成证券担任主承销商');
  await page.getByRole('button', { name: '＋ 添加资金用途' }).click();
  await page.locator('#purpose_0').selectOption('construction');
  await page.locator('#use_amount_0').fill('1.000001');
  await page.getByRole('button', { name: '创建项目，继续提供材料' }).click();
  await expect(page.getByRole('heading', { name: '合成 DFI 完整恢复验收', exact: true })).toBeVisible();
  await page.getByLabel('补充募集书更新说明', { exact: true }).fill('合成说明：额度未定，等待审议。');
  await page.getByRole('button', { name: '保存补充说明' }).click();
  await expect(page.locator('.cowork-message')).toContainText('合成说明：额度未定，等待审议。');
  const route = new URL(page.url()).hash;
  const id = decodeURIComponent(route.split('/').at(-1)!.split('?')[0]);
  const savedResponse = await page.request.get(`/api/v1/projects/${id}`);
  expect(savedResponse.status(), await savedResponse.text()).toBe(200);
  const saved = await savedResponse.json();
  expect(saved.update_details.registration_amount).toBeNull();
  expect(saved.update_details.issuance_amount).toBeNull();
  expect(saved.update_details.reporting_cutoff).toBe('2026-06-30');
  const expectedPeriods = [
    { start: '2023-01-01', end: '2023-12-31', period_kind: 'annual', scope: null, status: 'needs_confirmation', evidence_refs: [] },
    { start: '2024-01-01', end: '2024-12-31', period_kind: 'annual', scope: null, status: 'needs_confirmation', evidence_refs: [] },
    { start: '2025-01-01', end: '2025-12-31', period_kind: 'annual', scope: null, status: 'needs_confirmation', evidence_refs: [] },
    { start: '2026-01-01', end: '2026-06-30', period_kind: 'interim', scope: null, status: 'needs_confirmation', evidence_refs: [] }
  ];
  expect(saved.update_details.target_reporting_periods).toEqual(expectedPeriods);
  const { pdfSample, PDF } = await import('../../api/dist/upload-safety.samples.js');
  const fileInput = page.getByLabel('为审计报告（可含报表及附注）选择文件');
  await expect(fileInput).toBeEnabled();
  await fileInput.setInputFiles({ name: 'form-recovery.pdf', mimeType: PDF, buffer: pdfSample() });
  await expect(page.locator('.material-file-row').filter({ hasText: 'form-recovery.pdf' })).toContainText('服务器已确认保存', { timeout: 30_000 });
  await page.context().close();
  const context = await browser.newContext({ baseURL: process.env.BB_E2E_BASE_URL, ignoreHTTPSErrors: true });
  try {
    const resumed = await context.newPage();
    resumed.on('pageerror', error => errors.push(error.message));
    await login(resumed, user);
    await resumed.goto(`/${route}`);
    await resumed.getByRole('button', { name: '编辑项目信息' }).click();
    await expect(resumed.getByLabel('发行方式', { exact: true })).toHaveValue('dfi');
    await expect(resumed.locator('.cowork-message')).toContainText('合成说明：额度未定，等待审议。');
    await expect(resumed.locator('#use_amount_0')).toHaveValue('1.000001');
    await expect(resumed.locator('.persisted-material')).toContainText('form-recovery.pdf');
    await resumed.getByLabel('发行市场', { exact: true }).selectOption('sse');
    await expect(resumed.getByLabel('发行方式', { exact: true })).toHaveValue('');
    await expect(resumed.locator('#market-notice')).toContainText('重新选择');
    await expect(resumed.locator('#offering option[value="dfi"]')).toHaveCount(0);
    await resumed.getByLabel('发行方式', { exact: true }).selectOption('public_all');
    await resumed.getByLabel('其他已知信息', { exact: true }).fill('改成交易所，其他信息保留。');
    await resumed.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(resumed.locator('#save-state')).toHaveText('已保存');
    const concurrent = await context.newPage();
    await concurrent.goto(`/${route}`);
    await concurrent.getByRole('button', { name: '编辑项目信息' }).click();
    await expect(concurrent.getByLabel('其他已知信息', { exact: true })).toHaveValue('改成交易所，其他信息保留。');
    await resumed.getByLabel('其他已知信息', { exact: true }).fill('甲页已经保存');
    await resumed.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(resumed.locator('#save-state')).toHaveText('已保存');
    await concurrent.getByLabel('其他已知信息', { exact: true }).fill('乙页冲突输入');
    await expect(concurrent.locator('#save-state')).toHaveText('有版本冲突');
    await expect(concurrent.getByLabel('其他已知信息', { exact: true })).toHaveValue('乙页冲突输入');
    concurrent.once('dialog', dialog => dialog.accept());
    await concurrent.getByRole('button', { name: '放弃当前输入并加载最新资料' }).click();
    await expect(concurrent.getByLabel('其他已知信息', { exact: true })).toHaveValue('甲页已经保存');
    expect((await (await concurrent.request.get(`/api/v1/projects/${id}`)).json()).update_details.target_reporting_periods).toEqual(expectedPeriods);
    await resumed.setViewportSize({ width: 1440, height: 1000 });
    await resumed.evaluate(() => window.scrollTo(0, 0));
    await resumed.screenshot({ path: join(tmpdir(), 'bondbuddy-form-desktop.png') });
    await resumed.setViewportSize({ width: 390, height: 844 });
    await resumed.screenshot({ path: join(tmpdir(), 'bondbuddy-form-mobile.png') });
    expect(await resumed.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(await resumed.locator('vite-error-overlay').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
