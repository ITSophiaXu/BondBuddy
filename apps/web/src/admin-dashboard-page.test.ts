import test from 'node:test';
import assert from 'node:assert/strict';
import type {AdminDashboardOverview, AdminDashboardTask, AdminDashboardUser} from '@bondbuddy/contracts';
import {
  dashboardCost,
  dashboardDuration,
  dashboardExecLogHtml,
  dashboardForbiddenHtml,
  dashboardQuery,
  dashboardSummaryHtml,
  dashboardTrendHtml,
  dashboardTasksHtml,
  dashboardUsersHtml,
  emptyDashboardFilters
} from './admin-dashboard-page.js';

const overview: AdminDashboardOverview = {
  range: {from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z'},
  users: 12, projects: 7, tasks: 34,
  tasks_by_state: [{state: 'succeeded', count: 20}, {state: 'failed', count: 4}, {state: 'running', count: 10}],
  model_attempts: 88, input_tokens: 123456, output_tokens: 23456,
  cost_amount: '12.3400000000', currency: 'CNY', credit_settled_points: '9800'
};

const user: AdminDashboardUser = {
  user_id: 'user_syn_1', phone_masked: '****1234', status: 'active', created_at: '2026-10-01T08:00:00Z',
  projects: 3, runs: 9, runs_by_state: [{state: 'succeeded', count: 7}, {state: 'failed', count: 2}],
  last_run_at: '2026-10-31T09:30:00Z', model_attempts: 21, input_tokens: 45000, output_tokens: 8900,
  cost_amount: '3.2100000000', currency: 'CNY', credit_settled_points: '4200'
};

const task: AdminDashboardTask = {
  run_id: 'run_syn_1', user_id: 'user_syn_1', phone_masked: '****1234', project_id: 'proj_syn_1', project_name: '合成项目',
  task_kind: 'update', state: 'succeeded', stage: 'delivered', created_at: '2026-10-31T08:00:00Z', updated_at: '2026-10-31T08:05:00Z',
  duration_ms: 300000, model_attempts: 6, input_tokens: 12000, output_tokens: 3400, cost_amount: '1.2300000000', currency: 'CNY',
  pricing_status: 'priced', last_error_code: null, credit_settled_points: '600',
  latest_attempt_id: 'att_syn_1', exec_log_available: true
};

test('summary cards render every aggregate, including tokens, cost and settled points', () => {
  const html = dashboardSummaryHtml(overview);
  assert.match(html, /data-dashboard-metric="users"[^>]*>12</);
  assert.match(html, /data-dashboard-metric="projects"[^>]*>7</);
  assert.match(html, /data-dashboard-metric="tasks"[^>]*>34</);
  assert.match(html, /data-dashboard-metric="model_attempts"[^>]*>88</);
  assert.match(html, /123,456 \/ 23,456/);
  assert.match(html, /12\.34 CNY/);
  assert.match(html, /9,800 积分/);
  assert.match(html, /已完成 20 · 失败 4 · 执行中 10/);
});

test('users table shows masked phones and lets an operator select a user', () => {
  const html = dashboardUsersHtml([user], 'user_syn_1');
  assert.match(html, /data-dashboard-user-row="user_syn_1" class="selected"/);
  assert.match(html, /data-dashboard-user-filter="user_syn_1"/);
  assert.match(html, /\*\*\*\*1234/);
  assert.equal(html.includes('+8613800001234'), false);
  assert.match(html, /3\.21 CNY/);
  assert.match(html, /4,200 积分/);
  assert.match(html, /已完成 7 · 失败 2/);
  assert.match(dashboardUsersHtml([], null), /没有符合条件的用户/);
});

test('tasks table renders state/stage, duration, tokens, pricing and the latest error code', () => {
  const html = dashboardTasksHtml([task, {...task, run_id: 'run_syn_2', state: 'failed', stage: 'model_call', last_error_code: 'DELIVERY_FAILED', pricing_status: null, cost_amount: null, currency: null, latest_attempt_id: null, exec_log_available: false}]);
  assert.match(html, /data-dashboard-task-row="run_syn_1"/);
  assert.match(html, /已完成/);
  assert.match(html, /delivered/);
  assert.match(html, /5 分 0 秒/);
  assert.match(html, /12,000 \/ 3,400/);
  assert.match(html, /priced/);
  assert.match(html, /DELIVERY_FAILED/);
  assert.match(html, /未定价/);
  assert.match(html, /—/);
  assert.match(html, /data-dashboard-exec-log="att_syn_1"[^>]*>(?:<svg[\s\S]*?<\/svg>)?查看执行日志/);
  assert.equal((html.match(/data-dashboard-exec-log=/g) ?? []).length, 1, 'runs without evidence show a dash, not a broken link');
  assert.match(dashboardTasksHtml([]), /没有符合条件的任务/);
});

test('execution log panel shows bounded size, truncation and escaped private bytes', () => {
  const log = {attempt_id: 'att_syn_1', run_id: 'run_syn_1', sha256: 'a'.repeat(64), byte_size: 42, truncated: true,
    content_type: 'text/plain; charset=utf-8' as const, body: '{"type":"thread.started"}\n[stderr]\n<b>synthetic</b>'};
  const html = dashboardExecLogHtml(log, '');
  assert.match(html, /data-dashboard-exec-log-panel/);
  assert.match(html, /42 字节（超出上限，已截断）/);
  assert.match(html, /data-dashboard-exec-log-download/);
  assert.match(html, /&lt;b&gt;synthetic&lt;\/b&gt;/);
  assert.equal(html.includes('<b>synthetic</b>'), false);
  assert.equal(dashboardExecLogHtml(null, ''), '');
  assert.match(dashboardExecLogHtml(null, '无权限或执行日志不存在。'), /role="alert"/);
});

test('filters and cursor become an encoded query without losing the user selection', () => {
  const filters = {from: '2026-10-01', to: '2026-10-31', state: 'failed', userId: 'user_syn_1'};
  const first = new URLSearchParams(dashboardQuery(filters).slice(1));
  assert.equal(first.get('from'), '2026-10-01');
  assert.equal(first.get('to'), '2026-10-31');
  assert.equal(first.get('state'), 'failed');
  assert.equal(first.get('user_id'), 'user_syn_1');
  assert.equal(first.get('limit'), '20');
  assert.equal(first.get('cursor'), null);
  const next = new URLSearchParams(dashboardQuery(filters, 'abc_-123', 100).slice(1));
  assert.equal(next.get('cursor'), 'abc_-123');
  assert.equal(next.get('limit'), '100');
  const cleared = new URLSearchParams(dashboardQuery(emptyDashboardFilters()).slice(1));
  assert.deepEqual([...cleared.keys()], ['limit']);
});

test('the forbidden state is a permission notice, never a generic failure', () => {
  const html = dashboardForbiddenHtml();
  assert.match(html, /无运营权限/);
  assert.match(html, /日志读取权限/);
  assert.equal(/role="alert"/.test(html), true);
});

test('cost and duration formatting stay readable and explicit', () => {
  assert.equal(dashboardCost('1.2300000000', 'CNY'), '1.23 CNY');
  assert.equal(dashboardCost('0.0000000000', null), '0.0（币种未知）');
  assert.equal(dashboardCost(null, null), '—');
  assert.equal(dashboardDuration(null), '—');
  assert.equal(dashboardDuration(900), '900 ms');
  assert.equal(dashboardDuration(1500), '1.5 秒');
});

const idleDay = (date: string) => ({date, tasks: 0, active_users: 0, input_tokens: 0, output_tokens: 0, cost_amount: null, currency: null, credit_settled_points: '0'});

test('trend dates and active-user daily average include every idle UTC day', () => {
  const daily = Array.from({length: 14}, (_, i) => idleDay(`2026-10-${String(i + 1).padStart(2, '0')}`));
  daily[0] = {...daily[0], tasks: 2, active_users: 1};
  daily[13] = {...daily[13], tasks: 3, active_users: 2};
  const html = dashboardTrendHtml({...overview, daily});
  assert.match(html, /2026-10-01 至 2026-10-14/);
  assert.match(html, /14 个 UTC 日/);
  assert.match(html, /日均 0\.2 人/);
  assert.doesNotMatch(html, /最近 14 天/);
});

test('a bounded trend discloses the last 90 UTC days while full-filter summaries and details remain available', () => {
  const daily = Array.from({length: 90}, (_, i) => idleDay(new Date(Date.parse('2026-01-31T00:00:00Z') + i * 86400000).toISOString().slice(0, 10)));
  daily[0] = {...daily[0], tasks: 1, active_users: 1};
  const html = dashboardTrendHtml({...overview, range: {from: '2026-01-01T00:00:00Z', to: '2026-04-30T23:59:59.999Z'}, daily});
  assert.match(html, /2026-01-31 至 2026-04-30/);
  assert.match(html, /最后 90 个 UTC 日/);
  assert.match(html, /汇总与明细保留完整筛选范围/);
});

test('idle windows display their actual range without drawing activity or measured-zero cost bars', () => {
  const html = dashboardTrendHtml({...overview, daily: [idleDay('2026-02-01'), idleDay('2026-02-02')]});
  assert.match(html, /2026-02-01 至 2026-02-02/);
  assert.match(html, /该趋势日期范围内没有任务/);
  assert.doesNotMatch(html, /<rect/);
  assert.doesNotMatch(html, /0\.0.*USD/);
});

test('zero tokens and unknown costs do not get minimum-height activity bars', () => {
  const html = dashboardTrendHtml({...overview, daily: [{...idleDay('2026-02-01'), tasks: 1, active_users: 1}, idleDay('2026-02-02')]});
  assert.doesNotMatch(html, /<rect class="admin-dashboard-bar token-(?:in|out)"/);
  assert.doesNotMatch(html, /<rect class="admin-dashboard-bar cost"/);
  assert.equal((html.match(/<rect class="admin-dashboard-bar"/g) ?? []).length, 1);
  assert.equal((html.match(/<rect class="admin-dashboard-bar users"/g) ?? []).length, 1);
  assert.match(html, /未定价/);
});

test('small positive costs have visible proportional bars while known zero and null costs have none', () => {
  const html = dashboardTrendHtml({...overview, daily: [
    {...idleDay('2026-02-01'), tasks: 1, active_users: 1, cost_amount: '0.0001000000', currency: 'USD'},
    {...idleDay('2026-02-02'), tasks: 1, active_users: 1, cost_amount: '0.0002000000', currency: 'USD'},
    {...idleDay('2026-02-03'), tasks: 1, active_users: 1, cost_amount: '0.0000000000', currency: 'USD'},
    idleDay('2026-02-04')
  ]});
  const bars = [...html.matchAll(/<rect class="admin-dashboard-bar cost"[^>]* height="([0-9.]+)"/g)];
  assert.equal(bars.length, 2, 'only the two known positive costs draw bars');
  const heights = bars.map(match => Number(match[1]));
  assert.ok(heights.every(height => height > 0));
  assert.equal(heights[1], heights[0] * 2, '0.0002 costs twice 0.0001');
  assert.match(html, /0\.0003 USD/);
});

test('an older response without daily data never claims the selected summary range has no tasks', () => {
  const html = dashboardTrendHtml(overview);
  assert.match(html, /暂无按天趋势数据/);
  assert.doesNotMatch(html, /所选范围内没有任务/);
});
