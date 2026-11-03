import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import type {
  AdminDashboardOverview,
  AdminDashboardUsers,
  AdminDashboardTasks,
  AdminExecLog
} from '@bondbuddy/contracts';

// All accounts, runs and numbers below are synthetic operator-view fixtures.
const owner = 'u_test';
const run = 'r_test';
const project = 'p_test';
const attempt = 'a_test';
const sha = 'a'.repeat(64);

const overview: AdminDashboardOverview = {
  range: { from: null, to: null },
  users: 2,
  projects: 1,
  tasks: 1,
  tasks_by_state: [{ state: 'failed', count: 1 }],
  model_attempts: 1,
  input_tokens: 1000,
  output_tokens: 200,
  cost_amount: '0.0014000000',
  currency: 'USD',
  credit_settled_points: '500'
};

const user = {
  user_id: owner,
  phone_masked: '****0001',
  status: 'active' as const,
  created_at: '2026-11-01T00:00:00Z',
  projects: 1,
  runs: 1,
  runs_by_state: [{ state: 'failed' as const, count: 1 }],
  last_run_at: '2026-11-03T16:20:40Z',
  model_attempts: 1,
  input_tokens: 1000,
  output_tokens: 200,
  cost_amount: '0.0014000000',
  currency: 'USD',
  credit_settled_points: '500'
};

const task = {
  run_id: run,
  user_id: owner,
  phone_masked: '****0001',
  project_id: project,
  project_name: '合成项目',
  task_kind: 'update',
  state: 'failed' as const,
  stage: null,
  created_at: '2026-11-03T16:20:40Z',
  updated_at: '2026-11-03T16:20:40Z',
  duration_ms: 12345,
  model_attempts: 1,
  input_tokens: 1000,
  output_tokens: 200,
  cost_amount: '0.0014000000',
  currency: 'USD',
  pricing_status: 'priced' as const,
  last_error_code: 'MODEL_TIMEOUT',
  credit_settled_points: '500',
  latest_attempt_id: attempt,
  exec_log_available: true
};

const secondTask = { ...task, run_id: 'r_test2', project_name: '合成项目二', state: 'succeeded' as const, pricing_status: 'unknown' as const, last_error_code: null };

const execLog: AdminExecLog = {
  attempt_id: attempt,
  run_id: run,
  sha256: sha,
  byte_size: 2048,
  truncated: true,
  content_type: 'text/plain; charset=utf-8',
  body: '[stdout]\n{"type":"thread.started"}\n[stderr]\n<redacted private bytes>\n'
};

const json = (route: Route, status: number, value: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });

async function setup(page: Page, options: { forbidden?: boolean; paginate?: boolean; execLog?: AdminExecLog } = {}) {
  const calls: { path: string; query: string }[] = [];
  await page.route('**/api/v1/**', async r => {
    const url = new URL(r.request().url());
    const path = url.pathname.replace('/api/v1', '');
    calls.push({ path, query: url.search });
    if (path === '/me') return json(r, 200, { user_id: owner, session_status: 'active' });
    if (path === '/billing/permissions') return json(r, 200, { permissions: [] });
    if (path.startsWith('/admin/dashboard/')) {
      if (options.forbidden) return json(r, 404, { code: 'NOT_FOUND' });
      if (path === '/admin/dashboard/overview') return json(r, 200, overview);
      if (path === '/admin/dashboard/users') {
        const cursor = url.searchParams.get('cursor');
        if (options.paginate && cursor === 'u2') return json(r, 200, { items: [], next_cursor: null });
        return json(r, 200, { items: [user], next_cursor: options.paginate ? 'u2' : null } as AdminDashboardUsers);
      }
      if (path === '/admin/dashboard/tasks') {
        const cursor = url.searchParams.get('cursor');
        const items = options.paginate && cursor === 't2' ? [secondTask] : [task];
        return json(r, 200, { items, next_cursor: options.paginate && cursor !== 't2' ? 't2' : null } as AdminDashboardTasks);
      }
    }
    if (path === `/admin/exec-logs/${attempt}`) return json(r, 200, options.execLog ?? execLog);
    return json(r, 404, { code: 'NOT_FOUND' });
  });
  return { calls };
}

async function screenshot(page: Page, name: string) {
  if (!process.env.BB_UX_EVIDENCE_DIR) return;
  await mkdir(process.env.BB_UX_EVIDENCE_DIR, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(process.env.BB_UX_EVIDENCE_DIR, name), fullPage: true });
}

test('agents and operators see per-user/per-task aggregates and masked phones', async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/#/admin/dashboard');

  await expect(page.locator('[data-dashboard-metric="users"]')).toHaveText('2');
  await expect(page.locator('[data-dashboard-metric="tasks"]')).toHaveText('1');
  await expect(page.locator('[data-dashboard-metric="tokens"]')).toHaveText('1,000 / 200');
  await expect(page.locator('[data-dashboard-metric="cost"]')).toHaveText('0.0014 USD');
  await expect(page.locator('[data-dashboard-metric="credits"]')).toHaveText('500 积分');

  await expect(page.locator('[data-dashboard-user-row="u_test"]')).toContainText('****0001');
  const row = page.locator('[data-dashboard-task-row="r_test"]');
  await expect(row).toContainText('合成项目');
  await expect(row).toContainText('失败');
  await expect(row).toContainText('12.3 秒');
  await expect(row).toContainText('1,000 / 200');
  await expect(row).toContainText('0.0014 USD');
  await expect(row).toContainText('priced');
  await expect(row).toContainText('MODEL_TIMEOUT');

  await screenshot(page, 'dashboard-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await screenshot(page, 'dashboard-mobile.png');
});

test('the execution log is bounded, marked truncated and downloadable', async ({ page }) => {
  await setup(page);
  await page.goto('/#/admin/dashboard');
  await page.locator('[data-dashboard-exec-log="a_test"]').click();
  const panel = page.locator('[data-dashboard-exec-log-panel]');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('2,048 字节');
  await expect(panel).toContainText('超出上限，已截断');
  await expect(panel).toContainText(sha);
  await expect(panel.locator('[data-dashboard-exec-log-body]')).toContainText('[stdout]');
  const download = page.waitForEvent('download');
  await panel.locator('[data-dashboard-exec-log-download]').click();
  await expect((await download).suggestedFilename()).toBe('exec-a_test.log');
});

test('selecting a user, filtering and cursor pagination use the exact query', async ({ page }) => {
  const { calls } = await setup(page, { paginate: true });
  await page.goto('/#/admin/dashboard');

  await page.locator('[data-dashboard-user-filter="u_test"]').click();
  await expect(page.getByText('仅显示用户 u_test 的任务')).toBeVisible();
  expect(calls.some(c => c.path === '/admin/dashboard/tasks' && c.query.includes('user_id=u_test'))).toBe(true);
  await page.locator('[data-dashboard-clear-user]').click();

  await page.locator('[data-dashboard-state]').selectOption('failed');
  await page.locator('[data-dashboard-from]').fill('2026-11-01');
  await page.locator('[data-dashboard-apply]').click();
  expect(calls.some(c => c.path === '/admin/dashboard/tasks' && c.query.includes('state=failed') && c.query.includes('from=2026-11-01'))).toBe(true);

  await page.locator('[data-dashboard-more-tasks]').click();
  await expect(page.locator('[data-dashboard-task-row="r_test2"]')).toBeVisible();
  expect(calls.some(c => c.path === '/admin/dashboard/tasks' && c.query.includes('cursor=t2'))).toBe(true);
});

test('missing operator grant renders a permission notice instead of a failure', async ({ page }) => {
  await setup(page, { forbidden: true });
  await page.goto('/#/admin/dashboard');
  await expect(page.getByText('无运营权限。本页面仅对具备日志读取权限的运营账号开放')).toBeVisible();
  await expect(page.locator('[data-dashboard-metric="users"]')).toHaveCount(0);
});
