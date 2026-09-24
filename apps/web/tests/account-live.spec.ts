import { expect, test } from '@playwright/test';
import { account, login, origin } from './live-helpers';

test.skip(process.env.BB_E2E_LIVE !== '1', 'Requires a dedicated migrated API/database; no production or mocked API is used.');

test('real settings: revoked sessions stop working, password change revokes others, closure affects only this account', async ({ page, playwright }) => {
  const a = await account(playwright), b = await account(playwright);
  const device = async (password = a.password) => {
    const context = await playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
    expect((await context.post('/api/v1/auth/login', { headers: { Origin: origin }, data: { username: a.username, password } })).status()).toBe(200);
    // Proves the device cookie works, so the later 401 means revocation rather than a missing cookie.
    expect((await context.get('/api/v1/me')).status()).toBe(200);
    return context;
  };
  const laptop = await device();
  await login(page, a);
  await page.getByRole('link', { name: '账号设置' }).click();
  await expect(page.locator('#account-info')).toContainText(a.username);
  await expect(page.locator('.session-row').filter({ hasText: '当前会话' })).toHaveCount(1);
  // Registration and the laptop login each left an active session besides this page.
  await expect(page.getByRole('button', { name: /^撤销 .+ 登录的会话$/ })).toHaveCount(2);
  await page.getByRole('button', { name: '退出其他全部会话' }).click();
  await expect(page.locator('#sessions-message')).toHaveText('已退出其他 2 个会话。');
  expect((await laptop.get('/api/v1/me')).status()).toBe(401);

  const phone = await device();
  const newPassword = `Synthetic-new-${Date.now()}`;
  await page.getByLabel('当前密码', { exact: true }).fill(a.password);
  await page.getByLabel('新密码 12–128 个字符', { exact: true }).fill(newPassword);
  await page.getByLabel('再次输入新密码', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: '修改密码' }).click();
  await expect(page.locator('#password-message')).toHaveText('密码已修改。已退出其他 1 个会话，当前页面保持登录。');
  expect((await phone.get('/api/v1/me')).status()).toBe(401);
  await expect(page.locator('#account-info div').filter({ hasText: '密码最近修改' }).locator('dd')).not.toHaveText('—');

  await page.getByRole('button', { name: '查看注销影响' }).click();
  await page.getByLabel(/输入用户名/).fill(a.username);
  await page.getByLabel('输入密码以确认', { exact: true }).fill(newPassword);
  await page.getByLabel(/我了解注销后无法恢复/).check();
  await page.getByRole('button', { name: '永久注销账号' }).click();
  await expect(page.getByRole('heading', { name: '账号已注销', exact: true })).toBeVisible();
  expect((await page.request.get('/api/v1/me')).status()).toBe(401);

  await page.getByRole('button', { name: '返回登录页' }).click();
  await page.getByLabel('用户名', { exact: true }).fill(a.username);
  await page.getByLabel('密码', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('用户名或密码不正确，请重试。')).toBeVisible();
  const again = await playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  expect((await again.post('/api/v1/auth/register', { headers: { Origin: origin }, data: {
    username: a.username, password: newPassword, accepted_terms_version: process.env.BB_E2E_TERMS_VERSION ?? 'synthetic-web-test-v1'
  } })).status()).toBe(409);
  await Promise.all([laptop.dispose(), phone.dispose(), again.dispose()]);

  await login(page, b);
  await page.getByRole('link', { name: '账号设置' }).click();
  await expect(page.locator('#account-info')).toContainText(b.username);
});
