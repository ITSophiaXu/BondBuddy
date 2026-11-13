import { expect, test, type Page } from '@playwright/test';
import { Value } from '@sinclair/typebox/value';
import { AdminInspectionSnapshotSchema, type AdminInspectionRow, type AdminInspectionSnapshot } from '@bondbuddy/contracts';

// Synthetic operator metadata only. Every API route is intercepted; these tests
// do not exercise production data, real authentication, models, or billing.
test.use({ viewport: { width: 1440, height: 1000 } });

const states = ['succeeded', 'paused', 'failed', 'preparing', 'queued', 'running', 'validating', 'delivering', 'settlement_pending', 'awaiting_input', 'cancelled', 'rejected', 'test_completed', 'future_state'] as const;
const created = '2026-11-13T01:00:00Z';
const captured = '2026-11-13T02:00:00Z';

function snapshot(mode: 'complete' | 'truncated' | 'missing' | 'historical' = 'complete'): AdminInspectionSnapshot {
  const run = (id: string, state: string, task_kind = 'update', extra: AdminInspectionRow = {}): AdminInspectionRow => ({
    id, state, task_kind, owner_user_id: 'synthetic_owner_a', project_id: 'synthetic_project_a', channel: 'production',
    created_at: created, updated_at: state === 'queued' && task_kind === 'update' ? created : '2026-11-13T01:59:00Z', stage: 'synthetic_stage', ...extra
  });
  const runs = [
    ...states.map(state => run(`synthetic_update_${state}`, state)),
    ...['succeeded', 'paused', 'failed', 'queued'].map(state => run(`synthetic_review_${state}`, state, 'review')),
    run('synthetic_other_owner_success', 'succeeded', 'update', { owner_user_id: 'synthetic_owner_b', project_id: 'synthetic_project_b' }),
    run('synthetic_outside_date_failure', 'failed', 'update', { created_at: '2026-11-11T01:00:00Z' }),
    run('synthetic_trial_pause', 'paused', 'update', { channel: 'trial' })
  ];
  const rows: Record<string, AdminInspectionRow[]> = {
    bb_runs: mode === 'missing' ? [] : runs,
    bb_users: [
      { id: 'synthetic_owner_a', username: '合成运营甲', status: 'active' },
      { id: 'synthetic_owner_b', username: '合成运营乙', status: 'active' }
    ],
    bb_projects: [
      { id: 'synthetic_project_a', owner_user_id: 'synthetic_owner_a', name: '合成运行统计项目' },
      { id: 'synthetic_project_b', owner_user_id: 'synthetic_owner_b', name: '另一个合成项目' }
    ],
    bb_jobs: [], bb_run_events: [], bb_model_call_attempts: [], bb_workpaper_batches: [],
    // A recovered task can retain an error; its current succeeded state wins.
    bb_observability_errors: [{ id: 'synthetic_historical_error', trace_id: 'synthetic_update_succeeded', code: 'SYNTHETIC_OLD_ERROR', created_at: created }]
  };
  const value: AdminInspectionSnapshot = {
    schema_version: 1, source: mode === 'historical' ? 'historical_evidence' : 'synthetic_test', captured_at: captured,
    release: 'synthetic-status-browser-fixture',
    scope: { run_limit: 1000, run_count: mode === 'missing' ? 0 : runs.length, available_run_count: mode === 'truncated' ? 1200 : mode === 'missing' ? 0 : runs.length, description: 'Synthetic task status regression fixture.' },
    tables: Object.entries(rows).map(([name, data]) => ({ name, available: !(name === 'bb_runs' && mode === 'missing'), total: name === 'bb_runs' && mode === 'truncated' ? 1200 : data.length, truncated: name === 'bb_runs' && mode === 'truncated', rows: data })),
    warnings: ['合成数据，仅验证运营看板状态统计和筛选，不代表客户使用或真实后端验收。']
  };
  if (!Value.Check(AdminInspectionSnapshotSchema, value)) throw Error('Invalid synthetic task status fixture');
  return value;
}

async function setup(page: Page, data = snapshot()) {
  const unexpected: string[] = [], pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/admin/inspection/snapshot' && request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    } else {
      unexpected.push(`${request.method()} ${path}`);
      await route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ code: 'DATA_UNAVAILABLE' }) });
    }
  });
  await page.goto('/admin/');
  await expect(page.locator('.workspace')).toBeVisible();
  await expect(page.locator('[data-refresh]')).toBeEnabled();
  return () => { expect(unexpected).toEqual([]); expect(pageErrors).toEqual([]); };
}

const statusCard = (page: Page, status: string) => page.locator(`[data-status-summary] [data-run-state="${status}"]`);
const breakdownRow = (page: Page, kind: string) => page.locator(`[data-status-breakdown] [data-status-kind="${kind}"]`);
async function expectCounts(page: Page, kind: string, numbers: number[]) {
  const values = await breakdownRow(page, kind).locator('td').allTextContents();
  expect(values.slice(-numbers.length).map(value => value.trim())).toEqual(numbers.map(String));
}
async function visibleTaskIds(page: Page) {
  return page.locator('.tasks tbody [data-detail]').evaluateAll(elements => [...new Set(elements.map(element => element.getAttribute('data-detail')))]);
}
async function apply(page: Page, values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) {
    const field = page.locator(`[data-filters] [name="${name}"]`);
    if (['kind', 'state', 'channel'].includes(name)) await field.selectOption(value);
    else await field.fill(value);
  }
  await page.locator('[data-filters]').getByRole('button', { name: '筛选', exact: true }).click();
}

test('overview counts every current execution once and breaks down each task type', async ({ page }, info) => {
  const clean = await setup(page);
  for (const [state, count] of [['succeeded', 3], ['paused', 3], ['failed', 3], ['in_progress', 7]] as const) {
    await expect(statusCard(page, state).locator('strong')).toHaveText(String(count));
  }
  await expectCounts(page, '__total', [21, 3, 3, 3, 7, 1, 1, 1, 1, 1]);
  await expectCounts(page, 'update', [17, 2, 2, 2, 6, 1, 1, 1, 1, 1]);
  await expectCounts(page, 'review', [4, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
  await page.screenshot({ path: info.outputPath('status-overview-desktop.png'), fullPage: true });
  clean();
});

test('type status drilldown preserves user search date and channel constraints', async ({ page }) => {
  const clean = await setup(page);
  await page.locator('nav [data-view="users"]').click();
  await page.getByRole('button', { name: '合成运营甲', exact: true }).click();
  await page.locator('nav [data-view="overview"]').click();
  const filter = { search: '合成运行统计', from: '2026-11-13', to: '2026-11-13', channel: 'production' };
  await apply(page, filter);
  await expectCounts(page, '__total', [18, 2, 2, 2, 7, 1, 1, 1, 1, 1]);
  await breakdownRow(page, 'review').locator('[data-run-state="paused"]').click();
  await expect(page.getByRole('heading', { name: '任务与追踪', exact: true })).toBeVisible();
  await expect(page.locator('[data-clear-user]')).toBeVisible();
  await expect(page.locator('[data-filters] [name="kind"]')).toHaveValue('review');
  await expect(page.locator('[data-filters] [name="state"]')).toHaveValue('paused');
  for (const [name, value] of Object.entries(filter)) await expect(page.locator(`[data-filters] [name="${name}"]`)).toHaveValue(value);
  expect(await visibleTaskIds(page)).toEqual(['synthetic_review_paused']);
  clean();
});

test('in progress card keeps an already narrower queued filter', async ({ page }) => {
  const clean = await setup(page);
  await apply(page, { state: 'queued' });
  await expect(statusCard(page, 'in_progress').locator('strong')).toHaveText('2');
  await statusCard(page, 'in_progress').click();
  await expect(page.locator('[name="state"]')).toHaveValue('queued');
  expect(await visibleTaskIds(page)).toEqual(['synthetic_update_queued', 'synthetic_review_queued']);
  clean();
});

test('attention to in progress drilldown keeps only stale active tasks', async ({ page }) => {
  const clean = await setup(page);
  await apply(page, { state: 'attention' });
  await expect(statusCard(page, 'in_progress').locator('strong')).toHaveText('1');
  await statusCard(page, 'in_progress').click();
  await expect(page.locator('[name="state"]')).toHaveValue('stale');
  expect(await visibleTaskIds(page)).toEqual(['synthetic_update_queued']);
  clean();
});

test('unknown states remain visible and are not combined with failures', async ({ page }) => {
  const clean = await setup(page);
  await breakdownRow(page, 'update').locator('[data-run-state="unknown_state"]').click();
  await expect(page.locator('[name="state"]')).toHaveValue('unknown_state');
  expect(await visibleTaskIds(page)).toEqual(['synthetic_update_future_state']);
  clean();
});

test('workpaper entries use their business type and batch records are not extra executions', async ({ page }) => {
  const data = snapshot();
  data.tables.push({ name: 'task_input_snapshots', available: true, total: 1, truncated: false, rows: [{ run_id: 'synthetic_update_succeeded', document_type: 'workpaper' }] });
  const batches = data.tables.find(table => table.name === 'bb_workpaper_batches')!;
  batches.rows.push({ id: 'synthetic_batch', owner_user_id: 'synthetic_owner_a', project_id: 'synthetic_project_a', state: 'complete', created_at: created, updated_at: captured });
  batches.total = 1;
  const clean = await setup(page, data);
  await expectCounts(page, '__total', [21, 3, 3, 3, 7, 1, 1, 1, 1, 1]);
  await expectCounts(page, 'workpaper', [1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  await expect(breakdownRow(page, 'workpaper')).toContainText('底稿条目');
  await breakdownRow(page, 'workpaper').locator('[data-run-state="succeeded"]').click();
  expect(await visibleTaskIds(page)).toEqual(['synthetic_update_succeeded']);
  clean();
});

test('in progress drilldown retains queued and running workpaper batches', async ({ page }) => {
  const data = snapshot();
  const batches = data.tables.find(table => table.name === 'bb_workpaper_batches')!;
  batches.rows = ['queued', 'running', 'paused', 'complete'].map(state => ({ id: `synthetic_batch_${state}`, owner_user_id: 'synthetic_owner_a', project_id: 'synthetic_project_a', state, created_at: created, updated_at: captured }));
  batches.total = batches.rows.length;
  const clean = await setup(page, data);
  await statusCard(page, 'in_progress').click();
  await expect(page.locator('[name="state"]')).toHaveValue('in_progress');
  await expect(page.locator('[data-workpaper-batches] .batches tbody [data-detail]')).toHaveCount(2);
  expect(await page.locator('[data-workpaper-batches] .batches tbody [data-detail]').evaluateAll(elements => elements.map(element => element.getAttribute('data-detail')))).toEqual(['synthetic_batch_queued', 'synthetic_batch_running']);
  clean();
});

test('missing task data is unknown rather than a zero status summary', async ({ page }) => {
  const clean = await setup(page, snapshot('missing'));
  await expect(page.locator('[data-status-summary]')).toContainText(/未采集|未知|无法/);
  await expect(page.locator('[data-status-summary] [data-run-state]')).toHaveCount(0);
  await expect(page.locator('[data-status-breakdown] [data-status-kind]')).toHaveCount(0);
  clean();
});

test('truncated scope is identified alongside the statistics', async ({ page }) => {
  const clean = await setup(page, snapshot('truncated'));
  await expect(page.locator('[data-status-summary]')).toContainText(/已载入/);
  await expect(page.locator('[data-status-summary]')).toContainText(/非全量|不是全量|不代表.*全部|不代表.*全量|未覆盖全部/);
  await expect(page.locator('[data-status-summary]')).toContainText('1200');
  clean();
});

test('historical snapshots describe recorded states rather than current live states', async ({ page }) => {
  const clean = await setup(page, snapshot('historical'));
  await expect(page.locator('[data-status-summary]')).toContainText(/历史/);
  clean();
});

test('mobile status cards fit the viewport while wide breakdown scrolls internally', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const clean = await setup(page);
  await expect(statusCard(page, 'succeeded')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const scroll = page.locator('[data-status-breakdown] .table-scroll');
  await expect(scroll).toBeVisible();
  expect(await scroll.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('status-overview-mobile.png'), fullPage: true });
  clean();
});
