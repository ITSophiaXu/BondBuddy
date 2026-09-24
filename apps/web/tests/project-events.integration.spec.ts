import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

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
  await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
  await page.goto('/#/new');
  const projectName = `真实 API 材料恢复 ${username}`;
  await page.getByLabel('项目名称').fill(projectName);
  await page.getByRole('button', { name: '创建并保存项目' }).click();
  await expect(page).toHaveURL(/#\/projects\//);
  const projectId = new URL(page.url()).hash.split('/').at(-1)!;
  await expect(page.getByRole('heading', { name: projectName, exact: true })).toBeVisible();

  const { pdfSample, PDF } = await import('../../api/dist/upload-safety.samples.js');
  const completed = page.waitForResponse(response => response.url().includes(`/projects/${projectId}/materials/uploads/`) && response.url().endsWith('/complete') && response.request().method() === 'POST');
  await page.getByLabel('为审计报告（可含报表及附注）选择文件').setInputFiles({ name: 'real-api-recovery.pdf', mimeType: PDF, buffer: pdfSample() });
  const completion = await completed;
  expect(completion.status()).toBe(200);
  const materialId = (await completion.json()).material_id as string;
  await expect(page.locator('.material-file-row').filter({ hasText: 'real-api-recovery.pdf' })).toContainText('服务器已确认保存');

  const browser = page.context().browser();
  if (!browser) throw new Error('Playwright browser is unavailable');
  await page.context().close();
  const reopenedContext = await browser.newContext();
  try {
    const reopened = await reopenedContext.newPage();
    await reopened.goto('/');
    await reopened.getByLabel('用户名').fill(username);
    await reopened.getByLabel('密码').fill(password);
    await reopened.getByRole('button', { name: '登录', exact: true }).click();
    await expect(reopened.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
    await reopened.goto(`/#/projects/${encodeURIComponent(projectId)}`);
    await expect(reopened.getByRole('heading', { name: projectName, exact: true })).toBeVisible();
    await expect(reopened.getByText('已从服务器恢复 1 份当前账号可访问的材料记录。')).toBeVisible();
    await expect(reopened.locator('.persisted-material')).toContainText('real-api-recovery.pdf');

    const deletedStatus = await reopened.evaluate(async ({ projectId: id, materialId: mid }) => {
      const csrf = document.cookie.split('; ').find(value => value.startsWith('bb_csrf='))?.slice('bb_csrf='.length) ?? '';
      const response = await fetch(`/api/v1/projects/${encodeURIComponent(id)}/materials/${encodeURIComponent(mid)}`, { method: 'DELETE', headers: { 'X-BB-CSRF': csrf } });
      return response.status;
    }, { projectId, materialId });
    expect(deletedStatus).toBe(204);
    await reopened.getByRole('button', { name: '刷新已保存材料' }).click();
    await expect(reopened.getByText('材料事件中没有可恢复记录；重新选择本地文件不会代替服务器保存记录。')).toBeVisible();
    await expect(reopened.locator('.persisted-material')).toHaveCount(0);
  } finally {
    await reopenedContext.close();
  }
});
