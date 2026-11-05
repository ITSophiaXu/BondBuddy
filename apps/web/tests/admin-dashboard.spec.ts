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
  credit_settled_points: '500',
  daily: [
    { date: '2026-11-01', tasks: 1, active_users: 1, input_tokens: 1000, output_tokens: 200, cost_amount: '0.0014000000', currency: 'USD', credit_settled_points: '500' },
    { date: '2026-11-02', tasks: 1, active_users: 1, input_tokens: 1000, output_tokens: 200, cost_amount: '0.0014000000', currency: 'USD', credit_settled_points: '0' }
  ]
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

async function setup(page: Page, options: { forbidden?: boolean; paginate?: boolean; overview?: AdminDashboardOverview; execLog?: AdminExecLog; logoutFailures?: number; holdLogout?: boolean; holdViewSave?: boolean } = {}) {
  const calls: { path: string; query: string; method: string }[] = [];
  const now = '2026-11-05T00:00:00Z';
  const source = { source_project_id: 'assistant_scope', material_id: 'synthetic_source', material_version: 1, sha256: sha };
  const result = { source_project_id: 'assistant_scope', artifact_id: 'synthetic_result', artifact_version: 2, sha256: sha };
  const workspace = {
    topic: { topic_id: 'admin_navigation_topic', project_id: 'assistant_scope', source_project_id: null, name: '合成对话', surface: 'assistant', created_at: now, updated_at: now },
    project: { project_id: 'assistant_scope', kind: 'qa', name: '合成对话', draft_revision: 1 },
    materials: [], material_details: [], drafts: {}, templates: [], messages: [], tasks: [], artifacts: [], pending_requirements: [], active_run: null,
    view: { version: 0, selected_document_type: null, open_tabs: [result], active_tab: result, unsent_content: '',
      unsent_context: { document_type: null, draft_version: 0, source_material: source, citations: [{ kind: 'material', ref: source, locator: '合成原稿第2段' }], reading_artifact: result },
      assistant: { project_id: null, action: null } }
  };
  let logoutAttempts = 0;
  let releaseLogout = () => {};
  const heldLogout = options.holdLogout ? new Promise<void>(resolve => { releaseLogout = resolve; }) : Promise.resolve();
  let releaseViewSave = () => {};
  const heldViewSave = options.holdViewSave ? new Promise<void>(resolve => { releaseViewSave = resolve; }) : Promise.resolve();
  await page.route('**/api/v1/**', async r => {
    const url = new URL(r.request().url());
    const path = url.pathname.replace('/api/v1', '');
    const method = r.request().method();
    calls.push({ path, query: url.search, method });
    if (path === '/me') return json(r, 200, { user_id: owner, session_status: 'active' });
    if (path === '/account') return json(r, 200, { user_id: owner, username: '合成运营账号' });
    if (path === '/projects') return json(r, 200, { items: [], page: { has_more: false, next_cursor: null } });
    if (path === '/auth/logout' && method === 'POST') {
      logoutAttempts++;
      await heldLogout;
      if (logoutAttempts <= (options.logoutFailures ?? 0)) return json(r, 503, { code: 'DATA_UNAVAILABLE' });
      return r.fulfill({ status: 204 });
    }
    if (path === '/m4/topics' && method === 'GET') return json(r, 200, { topics: [workspace.topic] });
    if (path === '/m4/topics/admin_navigation_topic/workspace') return json(r, 200, workspace);
    if (path === '/assistant/topics/admin_navigation_topic/cards') return json(r, 200, { cards: [] });
    if (path === '/m4/topics/admin_navigation_topic/view' && method === 'PUT') {
      const input = r.request().postDataJSON();
      expect(input.expected_version).toBe(workspace.view.version);
      await heldViewSave;
      workspace.view = { ...input.view, version: workspace.view.version + 1 };
      return json(r, 200, { view: workspace.view });
    }
    if (path === '/billing/permissions') return json(r, 200, { permissions: [] });
    if (path.startsWith('/admin/dashboard/')) {
      if (options.forbidden) return json(r, 404, { code: 'NOT_FOUND' });
      if (path === '/admin/dashboard/overview') return json(r, 200, options.overview ?? overview);
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
  return { calls, workspace, releaseViewSave, releaseLogout };
}

async function screenshot(page: Page, name: string, fullPage = true) {
  if (!process.env.BB_UX_EVIDENCE_DIR) return;
  await mkdir(process.env.BB_UX_EVIDENCE_DIR, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(process.env.BB_UX_EVIDENCE_DIR, name), fullPage });
}

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.title.startsWith('desktop admin')) await screenshot(page, testInfo.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 180) + '.png', false);
});

test('agents and operators see per-user/per-task aggregates and masked phones', async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/#/admin/dashboard');

  await expect(page.locator('[data-dashboard-metric="users"]')).toHaveText('2');
  await expect(page.locator('[data-dashboard-metric="tasks"]')).toHaveText('1');
  await expect(page.locator('[data-dashboard-metric="tokens"]')).toHaveText('1,000 / 200');
  await expect(page.locator('[data-dashboard-metric="cost"]')).toHaveText('0.0014 USD');
  await expect(page.locator('[data-dashboard-metric="credits"]')).toHaveText('500 积分');
  await expect(page.getByText('时间趋势').first()).toBeVisible();
  await expect(page.locator('.admin-dashboard-chart').first()).toContainText('任务数');
  await expect(page.locator('.admin-dashboard-chart-svg rect').first()).toBeVisible();

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

for (const selector of ['.admin-tabs a', '.admin-brand']) {
  test(`desktop admin navigation keeps the dashboard route after clicking ${selector}`, async ({ page }) => {
    const { calls } = await setup(page);
    await page.goto('/#/admin/dashboard');
    await expect(page.locator('[data-dashboard-metric="users"]')).toHaveText('2');
    await page.locator(selector).click();
    await expect(page).toHaveURL(/#\/admin\/dashboard$/);
    await expect(page.locator('.admin-app')).toBeVisible();
    await expect(page.locator('.prototype-app')).toHaveCount(0);
    expect(calls.some(call => call.path === '/admin/dashboard/overview' && call.method === 'GET')).toBe(true);
    expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
  });
}

test('desktop admin logout sends one request and clears the current session view', async ({ page }) => {
  const { calls } = await setup(page);
  await page.goto('/#/admin/dashboard');
  await expect(page.locator('[data-dashboard-metric="users"]')).toHaveText('2');
  await page.locator('#admin-logout').click();
  await expect.poll(() => calls.filter(call => call.path === '/auth/logout' && call.method === 'POST').length).toBe(1);
  await expect(page.getByRole('heading', { name: '登录工作区', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator('.admin-app, .bb-assistant, [data-assistant-dock]')).toHaveCount(0);
  expect(calls.filter(call => call.method !== 'GET')).toEqual([{ path: '/auth/logout', query: '', method: 'POST' }]);
});

test('desktop admin logout failure is visible and the same session can retry', async ({ page }) => {
  const { calls, releaseLogout } = await setup(page, { logoutFailures: 1, holdLogout: true });
  await page.goto('/#/admin/dashboard');
  await expect(page.locator('[data-dashboard-metric="users"]')).toHaveText('2');
  await page.locator('#admin-logout').click();
  await expect.poll(() => calls.filter(call => call.path === '/auth/logout' && call.method === 'POST').length).toBe(1);
  await expect(page.locator('#admin-logout')).toBeDisabled();
  await page.locator('#admin-logout').click({ force: true });
  expect(calls.filter(call => call.path === '/auth/logout' && call.method === 'POST')).toHaveLength(1);
  await screenshot(page, 'desktop-admin-logout-pending.png', false);
  releaseLogout();
  await expect(page.locator('#admin-page-error')).toContainText('退出结果尚未确认，请重试退出');
  await expect(page.locator('#admin-logout')).toBeEnabled();
  await expect(page).toHaveURL(/#\/admin\/dashboard$/);
  await expect(page.locator('[data-dashboard-metric="users"]')).toHaveText('2');
  await screenshot(page, 'desktop-admin-logout-failure-visible.png', false);
  await page.locator('#admin-logout').click();
  await expect(page.getByRole('heading', { name: '登录工作区', exact: true })).toBeVisible();
  expect(calls.filter(call => call.path === '/auth/logout' && call.method === 'POST')).toHaveLength(2);
});

test('desktop admin hides the product assistant while preserving a pending complete conversation save', async ({ page }) => {
  const { calls, workspace, releaseViewSave } = await setup(page, { holdViewSave: true });
  const originalContext = structuredClone(workspace.view.unsent_context);
  await page.goto('/#tasks');
  await expect(page.getByRole('heading', { name: '任务进度与结果', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '打开 BondBuddy', exact: true }).click();
  const composer = page.locator('[data-composer]');
  await expect(composer).toBeEnabled();
  await composer.fill('这段桌面问题还没有发送，请保留原稿引用和成果上下文。');
  await expect.poll(() => calls.some(call => call.path.endsWith('/view') && call.method === 'PUT')).toBe(true);
  await page.evaluate(() => { location.hash = '/admin/dashboard'; });
  await expect(page.locator('.admin-app')).toBeVisible();
  await expect(page.locator('.bb-assistant')).not.toBeVisible();
  await expect(page.locator('[data-assistant-dock]')).not.toBeVisible();
  await screenshot(page, 'desktop-admin-assistant-hidden.png', false);
  releaseViewSave();
  await expect.poll(() => workspace.view.unsent_content).toBe('这段桌面问题还没有发送，请保留原稿引用和成果上下文。');
  expect(workspace.view.unsent_context).toEqual(originalContext);
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem('bb-assistant-view-v1:u_test:assistant_scope:admin_navigation_topic');
    return raw ? JSON.parse(raw).snapshot.view : null;
  })).toMatchObject({ unsent_content: workspace.view.unsent_content, unsent_context: originalContext });
  await page.evaluate(() => { location.hash = 'tasks'; });
  await expect(page.getByRole('heading', { name: '任务进度与结果', exact: true })).toBeVisible();
  await expect(composer).toHaveValue(workspace.view.unsent_content);
  await screenshot(page, 'desktop-admin-assistant-restored.png', false);
  expect(calls.filter(call => call.path === '/m4/topics' && call.method === 'GET')).toHaveLength(1);
  expect(calls.filter(call => call.method !== 'GET').map(call => `${call.method} ${call.path}`)).toEqual(['PUT /m4/topics/admin_navigation_topic/view']);
});

test('desktop admin trend discloses fourteen calendar days and includes inactive days in the average', async ({ page }) => {
  const daily = Array.from({ length: 14 }, (_, index) => {
    const tasks = index === 3 ? 1 : index === 10 ? 2 : 0;
    return { date: new Date(Date.UTC(2026, 9, 23 + index)).toISOString().slice(0, 10), tasks, active_users: tasks,
      input_tokens: tasks * 100, output_tokens: tasks * 20,
      cost_amount: tasks ? (tasks * 0.0001).toFixed(10) : null, currency: tasks ? 'USD' as const : null,
      credit_settled_points: String(tasks * 500) };
  });
  const { calls } = await setup(page, { overview: { ...overview, tasks: 3, tasks_by_state: [{ state: 'failed', count: 3 }],
    model_attempts: 3, input_tokens: 300, output_tokens: 60, cost_amount: '0.0003000000', credit_settled_points: '1500', daily } });
  await page.goto('/#/admin/dashboard');
  const trend = page.getByRole('region', { name: '时间趋势', exact: true });
  await expect(trend).toContainText('2026-10-23 至 2026-11-05 · 14 个 UTC 日');
  await expect(trend.getByRole('heading', { name: /用户量/ })).toContainText('日均 0.2 人');
  const tasksChart = trend.locator('.admin-dashboard-chart').filter({ has: page.getByRole('heading', { name: /任务数/ }) });
  await expect(tasksChart).toContainText('共 3');
  await expect(tasksChart.locator('rect')).toHaveCount(2);
  await expect(tasksChart.locator('title')).toHaveText(['2026-10-26 任务 1', '2026-11-02 任务 2']);
  const costChart = trend.locator('.admin-dashboard-chart').filter({ has: page.getByRole('heading', { name: /平台成本/ }) });
  await expect(costChart.locator('rect')).toHaveCount(2);
  const heights = await costChart.locator('rect').evaluateAll(rects => rects.map(rect => Number(rect.getAttribute('height'))));
  expect(heights[0]).toBeGreaterThan(0);
  expect(heights[1]).toBeGreaterThan(0);
  expect(heights[1]! / heights[0]!).toBeCloseTo(2);
  await expect(page.locator('[data-dashboard-metric="tasks"]')).toHaveText('3');
  expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
  await screenshot(page, 'desktop-admin-fourteen-calendar-days.png', false);
});
