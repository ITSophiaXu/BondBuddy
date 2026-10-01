import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { login } from './live-helpers';

test.skip(process.env.BB_E2E_LIVE !== '1', 'Requires a dedicated migrated API/database; no production or mocked API is used.');

test('real UI register -> lands logged in -> logout -> login again', async ({ page }) => {
  const user = { username: `Reg_${randomUUID().replaceAll('-', '').slice(0, 16)}`, password: `Synthetic-${randomUUID()}` };
  await page.goto('/');
  await page.getByRole('link', { name: '注册', exact: true }).click();
  await expect(page.locator('#terms-version')).toHaveText(process.env.BB_E2E_TERMS_VERSION ?? 'synthetic-web-test-v1');
  await page.getByLabel('用户名', { exact: true }).fill(user.username);
  await page.getByLabel('密码', { exact: true }).fill(user.password);
  await page.getByLabel('确认密码', { exact: true }).fill(user.password);
  await page.getByRole('checkbox').check();
  const registered = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/register'));
  await page.getByRole('button', { name: '注册并进入工作区' }).click();
  expect((await registered).status()).toBe(201);
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '退出' }).click();
  await expect(page.getByRole('heading', { name: '登录工作区' })).toBeVisible();
  await login(page, { username: user.username.toLowerCase(), password: user.password });
  // The same username in another case is the same, already-taken account.
  await page.getByRole('button', { name: '退出' }).click();
  await page.getByRole('link', { name: '注册', exact: true }).click();
  await expect(page.locator('#terms-version')).toBeVisible();
  await page.getByLabel('用户名', { exact: true }).fill(user.username.toUpperCase());
  await page.getByLabel('密码', { exact: true }).fill(user.password);
  await page.getByLabel('确认密码', { exact: true }).fill(user.password);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '注册并进入工作区' }).click();
  await expect(page.locator('#login-message')).toHaveText('该用户名已被使用，请换一个用户名。');
});
