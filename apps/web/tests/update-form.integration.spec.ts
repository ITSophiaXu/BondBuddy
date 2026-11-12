import { expect, test, type Page } from '@playwright/test';
import { account, login } from './live-helpers';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test.skip(process.env.BB_E2E_LIVE !== '1', 'Requires the dedicated API/database.');

async function readSaved(page: Page, path: string) {
  // Use the real browser session, including Secure cookies, for authenticated reads.
  const response = await page.evaluate(async path => {
    const result = await fetch(path, { credentials: 'same-origin' });
    return { status: result.status, body: await result.json() };
  }, path);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
}

test('DFI form and actual PDF survive browser restart with conflict-safe edits', async ({ page, playwright, browser }) => {
  const user = await account(playwright);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page, user);
  await page.locator('#main .page-head').getByRole('link', { name: '新建项目', exact: true }).click();
  await page.getByLabel('发行人全称', { exact: true }).fill('合成测试发行人有限公司');
  await page.getByLabel('发行市场', { exact: true }).selectOption('nafmii');
  await page.getByLabel('发行方式', { exact: true }).selectOption('dfi');
  const projectName = '合成测试发行人有限公司-交易商协会-DFI · 储架发行-募集书更新';
  await expect(page.locator('#generated-project-name')).toHaveText(projectName);
  await expect(page.locator('#create-form input[name="name"]')).toHaveCount(0);
  await page.getByLabel('最新报告期年份').selectOption('2026');
  await page.getByRole('radio',{name:'6月末',exact:true}).check();
  await page.locator('[data-update-group="agencies"] > summary').click();
  await page.getByLabel('承销安排', { exact: true }).fill('合成证券担任主承销商');
  await page.locator('[data-update-group="funding"] > summary').click();
  await page.getByRole('button', { name: '＋ 添加资金用途' }).click();
  await page.locator('#purpose_0').selectOption('construction');
  await page.locator('#use_amount_0').fill('1.000001');
  await page.getByRole('button', { name: '创建项目，继续提供材料' }).click();
  await expect(page.getByRole('heading', { name: projectName, exact: true })).toBeVisible();
  await page.getByLabel('补充募集书更新说明', { exact: true }).fill('合成说明：额度未定，等待审议。');
  await expect(page.locator('#conversation-status')).toHaveText('已自动保存');
  await expect(page.getByLabel('补充募集书更新说明', { exact: true })).toHaveValue('合成说明：额度未定，等待审议。');
  await page.getByRole('button', { name: '添加另一条说明', exact: true }).click();
  await expect(page.locator('.cowork-message')).toContainText('合成说明：额度未定，等待审议。');
  const route = new URL(page.url()).hash;
  const id = decodeURIComponent(route.split('/').at(-1)!.split('?')[0]);
  const saved = await readSaved(page, `/api/v1/projects/${id}`);
  expect(saved).toMatchObject({ name: projectName, kind: 'update', market: 'nafmii', offering: 'dfi' });
  expect(saved.update_details.authoring_mode).toBe('unified_v1');
  expect((await readSaved(page, `/api/v1/projects/${id}/messages`)).items).toEqual([
    expect.objectContaining({ body: '合成说明：额度未定，等待审议。', route: 'save_only', source_status: 'user_asserted' })
  ]);
  expect(saved.update_details.registration_amount).toBeNull();
  expect(saved.update_details.issuance_amount).toBeNull();
  expect(saved.update_details.underwriting).toBe('合成证券担任主承销商');
  expect(saved.update_details.funding_uses[0].amount).toEqual({ value: '1.000001', unit: 'hundred_million' });
  expect(saved.update_details.reporting_cutoff).toBe('2026-06-30');
  const expectedPeriods = [
    { start: '2023-01-01', end: '2023-12-31', period_kind: 'annual', scope: null, status: 'needs_confirmation', evidence_refs: [] },
    { start: '2024-01-01', end: '2024-12-31', period_kind: 'annual', scope: null, status: 'needs_confirmation', evidence_refs: [] },
    { start: '2025-01-01', end: '2025-12-31', period_kind: 'annual', scope: null, status: 'needs_confirmation', evidence_refs: [] },
    { start: '2026-01-01', end: '2026-06-30', period_kind: 'interim', scope: null, status: 'needs_confirmation', evidence_refs: [] }
  ];
  expect(saved.update_details.target_reporting_periods).toEqual(expectedPeriods);
  const { pdfSample, PDF } = await import('../../api/dist/upload-safety.samples.js');
  const pdf = pdfSample(), pdfHash = createHash('sha256').update(pdf).digest('hex');
  const fileInput = page.getByLabel('为审计报告（可含报表及附注）选择文件');
  await expect(fileInput).toBeEnabled();
  const completed = page.waitForResponse(response => response.url().includes(`/projects/${id}/materials/uploads/`) && response.url().endsWith('/complete') && response.request().method() === 'POST' && response.status() === 200);
  await fileInput.setInputFiles({ name: 'form-recovery.pdf', mimeType: PDF, buffer: pdf });
  await expect(page.locator('.material-file-row').filter({ hasText: 'form-recovery.pdf' })).toContainText('服务器已确认保存', { timeout: 30_000 });
  const completion = await completed; expect(completion.status()).toBe(200);
  const material = await completion.json();
  expect(material).toMatchObject({ filename: 'form-recovery.pdf', role: 'audit', media_type: PDF, byte_size: pdf.length, sha256: pdfHash, state: 'persisted' });
  await page.context().close();
  const context = await browser.newContext({ baseURL: process.env.BB_E2E_BASE_URL, ignoreHTTPSErrors: true });
  try {
    const resumed = await context.newPage();
    resumed.on('pageerror', error => errors.push(error.message));
    await login(resumed, user);
    await resumed.goto(`/${route}`);
    await expect(resumed.locator('.cowork-message')).toContainText('合成说明：额度未定，等待审议。');
    await expect(resumed.locator('.persisted-material')).toContainText('form-recovery.pdf');
    await expect(resumed.locator('.persisted-material').filter({ hasText: 'form-recovery.pdf' })).toBeVisible();
    expect(await readSaved(resumed, `/api/v1/projects/${id}/materials/${material.material_id}`)).toMatchObject({ material_id: material.material_id, material_version: material.material_version, upload_id: material.upload_id, byte_size: pdf.length, sha256: pdfHash });
    await resumed.getByRole('button', { name: '编辑项目信息' }).click();
    await expect(resumed.getByLabel('发行方式', { exact: true })).toHaveValue('dfi');
    await resumed.locator('[data-update-group="funding"] > summary').click();
    await expect(resumed.locator('#use_amount_0')).toHaveValue('1.000001');
    await resumed.getByLabel('发行市场', { exact: true }).selectOption('sse');
    await expect(resumed.getByLabel('发行方式', { exact: true })).toHaveValue('');
    await expect(resumed.locator('#market-notice')).toContainText('重新选择');
    await expect(resumed.locator('#offering option[value="dfi"]')).toHaveCount(0);
    await resumed.getByLabel('发行方式', { exact: true }).selectOption('public_all');
    await resumed.locator('[data-update-group="other"] > summary').click();
    await resumed.getByLabel('其他已知信息', { exact: true }).fill('改成交易所，其他信息保留。');
    await resumed.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(resumed.locator('#save-state')).toHaveText('已保存');
    const concurrent = await context.newPage();
    concurrent.on('pageerror', error => errors.push(error.message));
    await concurrent.goto(`/${route}`);
    await concurrent.getByRole('button', { name: '编辑项目信息' }).click();
    await concurrent.locator('[data-update-group="other"] > summary').click();
    await expect(concurrent.getByLabel('其他已知信息', { exact: true })).toHaveValue('改成交易所，其他信息保留。');
    await resumed.getByLabel('其他已知信息', { exact: true }).fill('甲页已经保存');
    await resumed.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(resumed.locator('#save-state')).toHaveText('已保存');
    await concurrent.getByLabel('其他已知信息', { exact: true }).fill('乙页冲突输入');
    await expect(concurrent.locator('#save-state')).toHaveText('有版本冲突');
    await expect(concurrent.getByLabel('其他已知信息', { exact: true })).toHaveValue('乙页冲突输入');
    concurrent.once('dialog', dialog => dialog.accept());
    await concurrent.getByRole('button', { name: '放弃当前输入并加载最新资料' }).click();
    await expect(concurrent.locator('#save-state')).toHaveText('已保存');
    await concurrent.locator('[data-update-group="other"] > summary').click();
    await expect(concurrent.getByLabel('其他已知信息', { exact: true })).toHaveValue('甲页已经保存');
    const latest = await readSaved(concurrent, `/api/v1/projects/${id}`);
    expect(latest.update_details.target_reporting_periods).toEqual(expectedPeriods);
    expect(latest).toMatchObject({ name: projectName, market: 'sse', offering: 'public_all' });
    expect(latest.update_details.other_information).toBe('甲页已经保存');
    expect(latest.update_details.funding_uses[0].amount).toEqual({ value: '1.000001', unit: 'hundred_million' });
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
