import { expect, test, type Page } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { account, login, origin } from './live-helpers';

test.skip(process.env.BB_E2E_LIVE !== '1', 'Requires a dedicated migrated API/database; no production or mocked API is used.');
async function createProject(page: Page, name: string) {
  await page.getByRole('link', { name: '新建更新项目', exact: true }).first().click();
  await page.getByLabel('项目名称 必填', { exact: true }).fill(name);
  await page.getByLabel('发行人全称').fill('浏览器验收合成发行人有限公司');
  await page.getByRole('button', { name: '创建项目，继续提供材料' }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  const id = decodeURIComponent(new URL(page.url()).hash.split('/').at(-1)!.split('?')[0]);
  await page.getByRole('button', { name:'编辑项目信息' }).click();
  return id;
}
async function patchExternally(page: Page, id: string, name: string) {
  const project = await (await page.request.get(`/api/v1/projects/${id}`)).json();
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'bb_csrf')!.value;
  const result = await page.request.patch(`/api/v1/projects/${id}`, {
    headers: { Origin: origin, 'X-BB-CSRF': csrf, 'If-Match': String(project.draft_revision) }, data: { name }
  });
  expect(result.status()).toBe(200);
}

test('real login -> project -> autosave -> reload -> relogin; account B cannot read A', async ({ page, playwright }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const a = await account(playwright), b = await account(playwright);
  await login(page, a);
  await expect(page.getByText('还没有项目', { exact: true })).toBeVisible();
  await expect(page).toHaveTitle('BondBuddy · 债券项目工作空间');
  const id = await createProject(page, '合成验收 · 2026 募集书更新');
  await page.getByLabel('项目名称 必填', { exact: true }).fill('合成验收 · 已重命名项目');
  await expect(page.getByRole('heading', { name: '合成验收 · 已重命名项目', exact: true })).toBeVisible();
  await expect(page.locator('#save-state')).toHaveText('已保存');
  await page.reload();
  await expect(page.getByLabel('发行人全称')).toHaveValue('浏览器验收合成发行人有限公司');
  await expect(page.getByLabel('项目名称 必填', { exact: true })).toHaveValue('合成验收 · 已重命名项目');
  await page.getByRole('link', { name: '全部项目', exact: true }).click();
  await expect(page.getByRole('heading', { name: '合成验收 · 已重命名项目', exact: true })).toBeVisible();
  await page.getByLabel('搜索项目名称或发行人').fill('不存在');
  await expect(page.getByRole('heading', { name: '没有找到匹配的项目' })).toBeVisible();
  await page.getByLabel('搜索项目名称或发行人').fill('');
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({ path: join(tmpdir(), 'bondbuddy-m1-05-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(tmpdir(), 'bondbuddy-m1-05-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (await page.getByRole('button', { name:'打开菜单', exact:true }).isVisible()) await page.getByRole('button', { name:'打开菜单', exact:true }).click();
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await login(page, a);
  await expect(page.getByRole('heading', { name: '合成验收 · 已重命名项目', exact: true })).toBeVisible();
  if (await page.getByRole('button', { name:'打开菜单', exact:true }).isVisible()) await page.getByRole('button', { name:'打开菜单', exact:true }).click();
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await login(page, b);
  await expect(page.getByText('还没有项目', { exact: true })).toBeVisible();
  expect((await page.request.get(`/api/v1/projects/${id}`)).status()).toBe(404);
  await page.goto(`/#/projects/${id}`);
  await expect(page.getByText('无法访问这个项目，它可能已移除或不属于当前账号。', { exact: true })).toBeVisible();
  await expect(page.getByText('合成验收 · 已重命名项目', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

test('server 409 retains input, blocks navigation and reloads only after an explicit discard', async ({ page, playwright }) => {
  await login(page, await account(playwright));
  const id = await createProject(page, '合成冲突样本');
  await patchExternally(page, id, '另一页面已经保存的名称');
  await page.getByLabel('项目名称 必填', { exact: true }).fill('本页尚未保存的修改');
  await expect(page.locator('#save-state')).toHaveText('有版本冲突');
  await expect(page.getByLabel('项目名称 必填', { exact: true })).toHaveValue('本页尚未保存的修改');
  await page.getByRole('link', { name: '全部项目', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${id}$`));
  await expect(page.getByLabel('项目名称 必填', { exact: true })).toHaveValue('本页尚未保存的修改');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '放弃当前输入并加载最新资料' }).click();
  await expect(page.getByLabel('项目名称 必填', { exact: true })).toHaveValue('另一页面已经保存的名称');
  await expect(page.locator('#save-state')).toHaveText('已保存');
});

test('network failure stays unsaved and access-cookie expiry refreshes the real session', async ({ page, playwright }) => {
  await login(page, await account(playwright));
  const id = await createProject(page, '合成网络样本');
  await page.route(`**/api/v1/projects/${id}`, route => route.request().method() === 'PATCH' ? route.abort('failed') : route.continue());
  await page.getByLabel('项目名称 必填', { exact: true }).fill('断网时保留的输入');
  await expect(page.locator('#save-state')).toHaveText('保存未确认');
  await expect(page.getByLabel('项目名称 必填', { exact: true })).toHaveValue('断网时保留的输入');
  await page.unroute(`**/api/v1/projects/${id}`);
  await page.getByRole('button', { name: '重试保存' }).click();
  await expect(page.locator('#save-state')).toHaveText('已保存');
  await page.context().clearCookies({ name: 'bb_session' });
  await page.reload();
  await expect(page.getByLabel('项目名称 必填', { exact: true })).toHaveValue('断网时保留的输入');
  expect((await page.context().cookies()).some(cookie => cookie.name === 'bb_session')).toBe(true);
});

test('logout from another tab clears project data without needing a reload', async ({ page, context, playwright }) => {
  await login(page, await account(playwright));
  await createProject(page, '合成跨页会话样本');
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByRole('heading', { name: '全部项目', exact: true })).toBeVisible();
  await other.getByRole('button', { name: '退出', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录工作区' })).toBeVisible();
  await expect(page.getByText('合成跨页会话样本', { exact: true })).toHaveCount(0);
});

test('all cursor pages are reachable and project names render as text', async ({ page, playwright }) => {
  await login(page, await account(playwright));
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'bb_csrf')!.value;
  const literal = '<img src=x onerror=alert(1)> 合成名称';
  for (let i = 0; i < 51; i++) {
    const result = await page.request.post('/api/v1/projects', {
      headers: { Origin: origin, 'X-BB-CSRF': csrf },
      data: { name: i === 0 ? literal : `合成分页项目 ${i}`, kind: 'update', issuer_name: null, market: null, offering: null }
    });
    expect(result.status()).toBe(201);
  }
  await page.getByRole('button', { name: '刷新状态' }).click();
  await expect(page.locator('.collection-project')).toHaveCount(30);
  await page.getByRole('button', { name: '加载更多项目' }).click();
  await expect(page.locator('.collection-project')).toHaveCount(51);
  await expect(page.getByRole('button', { name: '加载更多项目' })).toBeHidden();
  await page.getByLabel('搜索项目名称或发行人').fill('<img');
  await expect(page.getByRole('link', { name: literal, exact: true })).toBeVisible();
  await expect(page.locator('#project-list img')).toHaveCount(0);
  await page.locator('.skip-link').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  await expect(page.getByRole('link', { name: literal, exact: true })).toBeVisible();
});
