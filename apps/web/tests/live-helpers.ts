import { expect, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Shared by the BB_E2E_LIVE suites; they need a dedicated migrated API/database, never production.
export const origin = process.env.BB_E2E_BASE_URL ?? 'http://127.0.0.1:5173';
export async function account(playwright: PlaywrightWorkerArgs['playwright']) {
  const username = `web_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = `Synthetic-${randomUUID()}`;
  const request = await playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  const result = await request.post('/api/v1/auth/register', { headers: { Origin: origin }, data: {
    username, password, accepted_terms_version: process.env.BB_E2E_TERMS_VERSION ?? 'synthetic-web-test-v1'
  } });
  expect(result.status()).toBe(201); await request.dispose();
  return { username, password };
}
export async function login(page: Page, user: { username: string; password: string }) {
  await page.goto('/');
  await page.getByLabel('用户名', { exact: true }).fill(user.username);
  await page.getByLabel('密码', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  if (await page.getByRole('button', { name:'打开菜单', exact:true }).isVisible()) await page.getByRole('button', { name:'打开菜单', exact:true }).click();
  await page.getByRole('link', { name: '全部项目', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '全部项目', exact: true })).toBeVisible();
}
