import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { makeSyntheticDocxFixture } from '../../api/dist/docx-fixtures.js';
import { login } from './live-helpers';

const origin = process.env.BB_E2E_BASE_URL;
test.skip(process.env.BB_E2E_COS_INTEGRATION !== '1', 'Dedicated local COS integration only.');
test.beforeAll(() => {
  if (origin !== 'http://127.0.0.1:5198') throw new Error('COS browser test requires the isolated local web endpoint');
});

test('real browser uploads a synthetic prospectus through API to COS and restores it after reload', async ({ page, playwright }) => {
  test.setTimeout(120000);
  const username = `cosweb_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = `Synthetic-${randomUUID()}`;
  const request = await playwright.request.newContext({ baseURL: origin });
  try {
    const registered = await request.post('/api/v1/auth/register', { headers: { Origin: origin! }, data: {
      username, password, accepted_terms_version: process.env.BB_E2E_TERMS_VERSION,
    } });
    expect(registered.status()).toBe(201);
  } finally { await request.dispose(); }
  await login(page, { username, password });
  page.setDefaultTimeout(10000);
  await page.goto('/#update');
  await page.getByRole('link', { name: '＋ 新建项目' }).click();
  await page.getByLabel('发行人全称', { exact: true }).fill('COS 本地合成测试有限公司');
  await page.getByLabel('发行市场', { exact: true }).selectOption('szse');
  await page.getByLabel('发行方式', { exact: true }).selectOption('private');
  await page.getByLabel('最新报告期年份', { exact: true }).selectOption('2026');
  await page.getByRole('radio', { name: '6月末', exact: true }).check();
  await page.getByRole('button', { name: '创建项目，继续提供材料', exact: true }).click();
  await expect(page.getByLabel('募集书新版本文件', { exact: true })).toBeEnabled();
  const bytes = makeSyntheticDocxFixture({ text: 'Synthetic COS browser upload. No customer data.' });
  const completed = page.waitForResponse(response => response.url().includes('/materials/uploads/') &&
    response.url().endsWith('/complete') && response.request().method() === 'POST' && response.status() === 200,
    { timeout: 60000 });
  await page.getByLabel('募集书新版本文件', { exact: true }).setInputFiles({
    name: '合成历史募集书.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: bytes,
  });
  await completed;
  await expect(page.getByText('服务器已确认保存', { exact: false })).toBeVisible();
  await page.reload();
  await expect(page.getByText('服务器已确认保存', { exact: false })).toBeVisible();
});
