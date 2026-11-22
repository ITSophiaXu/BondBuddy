import {test, expect, type Page, type Download} from '@playwright/test';
import type {AdminInspectionSnapshot, AdminPerformanceRunResponse, AdminPerformanceSummaryResponse, PerformanceSpan} from '@bondbuddy/contracts';

// Synthetic operator metadata exercises browser/API contracts, not model quality or production timings.
const at = (ms: number) => new Date(Date.parse('2026-11-15T00:00:00Z') + ms).toISOString();
function span(id: string, start: number, end: number, parent: string | null = null): PerformanceSpan {
  return {span_id: id, parent_span_id: parent, session_id: 'session', run_execution_id: 'execution', trace_id: 'trace', run_id: 'run', job_id: 'job', stage: 'model_generation', step_key: id, step_version: 1, status: 'succeeded', started_at: at(start), ended_at: at(end), duration_ms: end - start, last_activity_at: at(end), clock_source: 'monotonic', attributes: {cache_hit: true, cache_status: 'hit', model_id: 'synthetic_model', bytes_read: 4096, call_id: 'call'}, span_links: ['shared_source']};
}
const spans = [span('root', 0, 10000), span('source_a', 1000, 7000, 'root'), span('source_b', 5000, 9000, 'root')];
function runPage(more = false): AdminPerformanceRunResponse {
  return {schema_version: 1, captured_at: at(more ? 20000 : 15000), snapshot_at: at(15000), audit_id: more ? 'audit_page2' : 'audit_page1', run_id: 'run', trace_id: 'trace', run: {created_at: at(0), state: 'succeeded', started_at: at(0), ended_at: at(12000)}, items: more ? spans.slice(2) : spans.slice(0, 2), next_cursor: more ? null : 'opaque+/=&?', total: 3,
    coverage: {run_count: 1, instrumented_run_count: 1, uninstrumented_run_count: 0, session_count: 1, complete_session_count: 1, purged_session_count: 0, purged_span_count: 0, span_count: 3, unfinished_span_count: 0, dropped_spans: 0, invalid_attributes: 0, flush_errors: 0, complete: true},
    sessions: [{session_id: 'session', run_execution_id: 'execution', service_role: 'worker', worker_instance_id: 'synthetic_worker', release_sha: 'e277c27a', started_at: at(0), ended_at: at(12000), last_flush_at: at(12000), closed: true, generated: 3, acknowledged: 3, dropped: 0, invalid_attributes: 0, flush_errors: 0, last_sequence: 3, complete: true, purged_at: null, purged_span_count: 0, purge_reason: null, purge_policy_version: null}]};
}
function summary(): AdminPerformanceSummaryResponse {
  return {schema_version: 1, captured_at: at(15000), audit_id: 'audit_summary', scope: {from: null, to: null, filters: {}, full_filtered_scope: true}, coverage: {...runPage().coverage, run_count: 2501, instrumented_run_count: 2500, uninstrumented_run_count: 1, span_count: 2510, complete: false},
    items: [{task_kind: 'update', stage: 'model_generation', step_key: 'model.exec', step_version: 1, span_status: 'failed', model_provider: 'synthetic', model_id: 'synthetic_model', release_sha: 'e277c27a', run_state: 'failed', span_count: 2510, run_count: 2500, completed_count: 2510, timed_count: 2500, running_count: 0, failed_count: 2510, missing_duration_count: 10, mean_ms: 4000, p50_ms: 3000, p90_ms: 8000, p95_ms: 10000, max_ms: 12000}]};
}
function snapshot(): AdminInspectionSnapshot {
  return {schema_version: 1, captured_at: at(15000), source: 'synthetic_test', release: 'synthetic_browser_fixture', scope: {run_limit: 1000, run_count: 1, available_run_count: 2501, description: 'Synthetic fixture only'}, warnings: ['合成样例，不代表真实模型质量或生产耗时。'], tables: [
    {name: 'bb_runs', available: true, total: 2501, truncated: true, rows: [{id: 'run', owner_user_id: 'operator', project_id: 'project', task_kind: 'update', state: 'succeeded', channel: 'production', created_at: at(0), updated_at: at(12000)}]},
    {name: 'bb_users', available: true, total: 1, truncated: false, rows: [{id: 'operator', username: '合成运营账号'}]},
    {name: 'bb_projects', available: true, total: 1, truncated: false, rows: [{id: 'project', name: '合成性能项目', owner_user_id: 'operator'}]},
    ...['bb_jobs', 'bb_run_events', 'bb_model_call_attempts', 'bb_workpaper_batches'].map(name => ({name, available: true, total: 0, truncated: false, rows: []})),
  ]};
}
async function setup(page: Page, options: {firstRunFails?: boolean; holdRun?: boolean; toolIncomplete?: 'completed_only' | 'omitted'} = {}) {
  const urls: URL[] = [], unexpected: string[] = [], errors: string[] = [];
  let runReads = 0, release!: () => void, requested!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const runRequested = new Promise<void>(resolve => { requested = resolve; });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()); urls.push(url);
    let body: unknown, status = 200;
    if (url.pathname === '/api/v1/admin/inspection/snapshot') body = snapshot();
    else if (url.pathname === '/api/v1/admin/performance/summary') { const data = summary(); data.scope.filters = Object.fromEntries(url.searchParams); body = data; }
    else if (url.pathname === '/api/v1/admin/performance/runs/run') {
      runReads++; requested(); if (options.holdRun) await released;
      if (options.firstRunFails && runReads === 1) { status = 503; body = {code: 'DATA_UNAVAILABLE'}; }
      else if (options.toolIncomplete) {
        const data = runPage(); data.items = [span('exec', 0, 10000)]; data.items[0].step_key = 'model.exec';
        data.items[0].attributes = {tool_timing_complete: false, tool_missing_start_count: options.toolIncomplete === 'completed_only' ? 1 : 0, tool_omitted_count: options.toolIncomplete === 'omitted' ? 1 : 0};
        data.total = 1; data.next_cursor = null;
        data.coverage = {...data.coverage, span_count: 1, unfinished_span_count: 1, complete: false};
        data.sessions[0] = {...data.sessions[0], generated: 1, acknowledged: 1}; body = data;
      } else body = runPage(url.searchParams.has('cursor'));
    } else if (url.pathname === '/api/v1/auth/logout') { await route.fulfill({status: 204}); return; }
    else { unexpected.push(url.pathname); status = 501; body = {code: 'DATA_UNAVAILABLE'}; }
    try { await route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)}); }
    catch (error) { if (!route.request().failure() && !page.isClosed()) throw error; }
  });
  await page.goto('/admin/'); await expect(page.locator('.workspace')).toBeVisible();
  return {urls, unexpected, errors, release, runRequested};
}
async function openRun(page: Page) {
  await page.locator('[data-recent-executions] .task-name[data-detail="run"]').click();
  await page.locator('[data-tab="performance"]').click();
}
async function downloadText(download: Download): Promise<string> {
  const stream = await download.createReadStream(); const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

test('performance summary queries full server filters and exports audited percentiles beyond snapshot limits', async ({page}, info) => {
  const fixture = await setup(page);
  expect(fixture.urls.some(url => url.pathname.includes('/performance/'))).toBe(false);
  await page.locator('[data-filters] [name="search"]').fill('unrelated snapshot search');
  await page.locator('[data-perf-filters] [name="from"]').fill('2026-11-15');
  await page.locator('[data-perf-filters] [name="to"]').fill('2026-11-16');
  await page.locator('[data-perf-filters] [name="task_kind"]').fill('update');
  await page.locator('[data-perf-filters] [name="span_status"]').selectOption('failed');
  await page.locator('[data-perf-filters] button[type="submit"]').click();
  await expect(page.locator('[data-performance-summary]')).toContainText('全部匹配 2501 次任务');
  const query = fixture.urls.find(url => url.pathname.endsWith('/performance/summary'))!.searchParams;
  expect(query.get('from')).toBe('2026-11-14T16:00:00.000Z'); expect(query.get('to')).toBe('2026-11-16T15:59:59.999Z');
  expect(query.get('task_kind')).toBe('update'); expect(query.get('span_status')).toBe('failed'); expect(query.has('search')).toBe(false);
  await expect(page.locator('.perf-summary-table')).toContainText('P90'); await expect(page.locator('.perf-summary-table')).toContainText('2500 / 10');
  const downloading = page.waitForEvent('download'); await page.locator('[data-perf-export="summary-csv"]').click();
  const text = await downloadText(await downloading); expect(text).toContain('audit_summary'); expect(text).toContain('p90_ms'); expect(text).toContain('full_filtered_scope');
  await page.locator('[data-performance-summary]').screenshot({path: info.outputPath('performance-summary-synthetic.png')});
  expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
});

test('run waterfall paginates on demand, retains nesting and exports the declared loaded scope', async ({page}, info) => {
  const fixture = await setup(page); await openRun(page);
  await expect(page.locator('[data-perf-span]')).toHaveCount(2);
  await expect(page.locator('[data-perf-span="source_a"]')).toHaveAttribute('data-depth', '1');
  await expect(page.locator('[data-perf-span="root"]')).toContainText('待完整记录');
  const partialDownload = page.waitForEvent('download'); await page.locator('[data-perf-export="run-json"]').click();
  const partial = JSON.parse(await downloadText(await partialDownload)); expect(partial.export_scope).toBe('loaded_pages_only'); expect(partial.items).toHaveLength(2); expect(partial.total).toBe(3);
  await page.locator('[data-perf-more]').click(); await expect(page.locator('[data-perf-span]')).toHaveCount(3);
  expect(fixture.urls.filter(url => url.pathname.endsWith('/runs/run')).at(-1)!.searchParams.get('cursor')).toBe('opaque+/=&?');
  await expect(page.locator('[data-perf-span="root"]')).toContainText('8 秒'); await expect(page.locator('[data-perf-span="root"]')).toContainText('2 秒');
  await page.locator('[data-perf-inspect="source_a"]').click();
  await expect(page.locator('#perf-context-source_a')).toContainText('cache_hit'); await expect(page.locator('#perf-context-source_a')).toContainText('4096');
  await page.locator('[data-perf-collapse="root"]').click(); await expect(page.locator('[data-perf-span]')).toHaveCount(1);
  await page.locator('[data-perf-collapse="root"]').click(); await expect(page.locator('[data-perf-span]')).toHaveCount(3);
  await page.locator('[data-performance-run]').screenshot({path: info.outputPath('performance-waterfall-synthetic.png')});
  expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
});

test('run read failure offers retry and does not substitute snapshot stage durations', async ({page}) => {
  const fixture = await setup(page, {firstRunFails: true}); await openRun(page);
  await expect(page.locator('[data-performance-run] [role="alert"]')).toContainText('读取失败');
  await expect(page.locator('[data-perf-span]')).toHaveCount(0);
  await page.locator('[data-perf-run-refresh]').click(); await expect(page.locator('[data-perf-span]')).toHaveCount(2);
  expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
});

test('logout prevents a delayed performance response from restoring private data', async ({page}) => {
  const fixture = await setup(page, {holdRun: true}); await openRun(page); await fixture.runRequested;
  await page.locator('[data-close]').click(); await page.locator('[data-logout]').click(); await expect(page.locator('[data-login]')).toBeVisible();
  fixture.release(); await page.waitForTimeout(150);
  await expect(page.locator('.workspace')).toHaveCount(0); await expect(page.locator('[data-perf-span]')).toHaveCount(0);
  expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
});

test('narrow admin layout contains horizontal waterfall scrolling within the drawer', async ({page}, info) => {
  await page.setViewportSize({width: 390, height: 844}); const fixture = await setup(page); await openRun(page);
  await expect(page.locator('[data-perf-span]')).toHaveCount(2);
  const width = await page.evaluate(() => ({page: document.documentElement.scrollWidth, viewport: innerWidth, chart: document.querySelector('.perf-waterfall-scroll')!.scrollWidth, frame: document.querySelector('.perf-waterfall-scroll')!.clientWidth}));
  expect(width.page).toBeLessThanOrEqual(width.viewport); expect(width.chart).toBeGreaterThan(width.frame);
  await page.screenshot({path: info.outputPath('performance-mobile-synthetic.png')});
  expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
});

for (const scenario of ['completed_only', 'omitted'] as const) test(`missing tool timing ${scenario} retains exec duration without claiming complete coverage`, async ({page}, info) => {
  await page.setViewportSize({width: 1440, height: 1000});
  const fixture = await setup(page, {toolIncomplete: scenario}); await openRun(page);
  const panel = page.locator('[data-performance-run]'), row = page.locator('[data-perf-span="exec"]');
  await expect(row).toContainText('10 秒'); await expect(row).toContainText('工具计时缺测');
  await expect(panel.locator('[data-perf-coverage]')).toContainText('1 个步骤未结束或计时缺测');
  await expect(panel.locator('[data-perf-coverage]')).not.toContainText('当前范围采集完整');
  await expect(panel.locator('.perf-metric').filter({hasText: '未解释时间'}).locator('strong')).toHaveText('未知');
  await expect(panel.locator('.perf-metric').filter({hasText: '失败 / 耗时缺测'}).locator('strong')).toHaveText('0 / 1');
  await page.locator('.detail-body').evaluate(element => { element.scrollTop = 0; });
  const rowBounds = await row.boundingBox(); expect(rowBounds).not.toBeNull(); expect(rowBounds!.y).toBeGreaterThanOrEqual(0); expect(rowBounds!.y + rowBounds!.height).toBeLessThanOrEqual(1000);
  await page.screenshot({path: info.outputPath(`missing-tool-${scenario}.png`)});
  expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
});
