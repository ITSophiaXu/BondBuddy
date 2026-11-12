import { expect, test } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';

const origin = process.env.BB_E2E_BASE_URL ?? 'http://127.0.0.1:5173';

test('real PostgreSQL/Azurite material survives browser close and same-account re-login', async ({ page, request }) => {
  test.skip(process.env.BB_E2E_REAL_API !== '1', 'requires the local API with fresh PostgreSQL 16 and Azurite');
  const termsVersion = process.env.BB_E2E_TERMS_VERSION;
  if (!termsVersion) throw new Error('BB_E2E_TERMS_VERSION must match the local API configuration');

  const username = `bb${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = 'Synthetic-event-browser-password-2026';
  const registration = await request.post(`${origin}/api/v1/auth/register`, {
    headers: { origin },
    data: { username, password, accepted_terms_version: termsVersion }
  });
  expect(registration.status()).toBe(201);

  await page.goto('/');
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('link', { name: '任务进度与结果', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '任务进度与结果', exact: true })).toBeVisible();
  await page.goto('/#/new');
  const issuer = `真实 API 材料恢复 ${username}`;
  const projectName = `${issuer}-募集书更新`;
  await page.getByLabel('发行人全称', { exact: true }).fill(issuer);
  await page.getByRole('button', { name: '创建项目，继续提供材料' }).click();
  await expect(page).toHaveURL(/#\/projects\//);
  const projectId = decodeURIComponent(new URL(page.url()).hash.split('/').at(-1)!.split('?')[0]);
  await expect(page.getByRole('heading', { name: projectName, exact: true })).toBeVisible();

  const { pdfSample, PDF } = await import('../../api/dist/upload-safety.samples.js');
  const bytes = pdfSample();
  const completed = page.waitForResponse(response => response.url().includes(`/projects/${projectId}/materials/uploads/`) && response.url().endsWith('/complete') && response.request().method() === 'POST' && response.status() === 200);
  const fileInput = page.getByLabel('为审计报告（可含报表及附注）选择文件');
  await expect(fileInput).toBeEnabled();
  await fileInput.setInputFiles({ name: 'real-api-recovery.pdf', mimeType: PDF, buffer: bytes });
  const completion = await completed;
  expect(completion.status()).toBe(200);
  const material = await completion.json();
  const materialId = material.material_id as string;
  expect(material).toMatchObject({ material_id: expect.any(String), material_version: 1,
    upload_id: expect.any(String), sha256: createHash('sha256').update(bytes).digest('hex'), byte_size: bytes.length });
  await expect(page.locator('.material-file-row').filter({ hasText: 'real-api-recovery.pdf' })).toContainText('服务器已确认保存');

  const browser = page.context().browser();
  if (!browser) throw new Error('Playwright browser is unavailable');
  await page.context().close();
  const reopenedContext = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  try {
    const reopened = await reopenedContext.newPage();
    await reopened.goto('/');
    await reopened.getByLabel('用户名').fill(username);
    await reopened.getByLabel('密码').fill(password);
    await reopened.getByRole('button', { name: '登录', exact: true }).click();
    await reopened.getByRole('link', { name: '任务进度与结果', exact: true }).first().click();
    await expect(reopened.getByRole('heading', { name: '任务进度与结果', exact: true })).toBeVisible();
    await reopened.goto(`/#/projects/${encodeURIComponent(projectId)}`);
    await expect(reopened.getByRole('heading', { name: projectName, exact: true })).toBeVisible();
    await expect(reopened.getByText('已保存 1 份材料。')).toBeVisible();
    await expect(reopened.locator('.persisted-material')).toContainText('real-api-recovery.pdf');
    const saved = await reopened.evaluate(async path => {
      const response = await fetch(path);
      return { status: response.status, body: await response.json() };
    }, `/api/v1/projects/${projectId}/materials/${materialId}?version=${material.material_version}`);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ material_id: materialId, material_version: material.material_version,
      upload_id: material.upload_id, sha256: material.sha256, byte_size: material.byte_size });

    const deletedStatus = await reopened.evaluate(async ({ projectId: id, materialId: mid }) => {
      const csrf = document.cookie.split('; ').find(value => value.startsWith('bb_csrf='))?.slice('bb_csrf='.length) ?? '';
      const response = await fetch(`/api/v1/projects/${encodeURIComponent(id)}/materials/${encodeURIComponent(mid)}`, { method: 'DELETE', headers: { 'X-BB-CSRF': csrf } });
      return response.status;
    }, { projectId, materialId });
    expect(deletedStatus).toBe(204);
    await reopened.getByRole('button', { name: '刷新已保存材料' }).click();
    await expect(reopened.getByText('尚未添加材料。')).toBeVisible();
    await expect(reopened.locator('.persisted-material')).toHaveCount(0);
  } finally {
    await reopenedContext.close();
  }
});
