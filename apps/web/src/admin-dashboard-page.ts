import {Value} from '@sinclair/typebox/value';
import {
  adminDashboardSchemas,
  schemas,
  type AdminDashboardOverview,
  type AdminDashboardTask,
  type AdminDashboardTasks,
  type AdminDashboardUser,
  type AdminDashboardUsers,
  type AdminExecLog
} from '@bondbuddy/contracts';
import {ApiClient, ApiError, friendlyError} from './api.js';
import {date, esc, icon} from './ui.js';
import {prototypeIcon} from './prototype-design.js';

// #448 read-only operator dashboard. Permission is rechecked server-side on every
// request; a 404 means "no operator grant" and is rendered as a plain permission
// notice rather than an error. Phone numbers are already masked by the API.
export type DashboardFilters = {from: string; to: string; state: string; userId: string};

export const emptyDashboardFilters = (): DashboardFilters => ({from: '', to: '', state: '', userId: ''});

export const DASHBOARD_STATE_LABELS: Record<string, string> = {
  preparing: '准备中', rejected: '已拒绝', queued: '排队中', running: '执行中', awaiting_input: '等待补充',
  paused: '已暂停', validating: '校验中', delivering: '交付中', settlement_pending: '结算中',
  succeeded: '已完成', test_completed: '测试完成', failed: '失败', cancelled: '已取消'
};

const number = (value: number) => value.toLocaleString('zh-CN');
const points = (value: string) => `${BigInt(value).toLocaleString('zh-CN')} 积分`;
const stateLabel = (state: string) => DASHBOARD_STATE_LABELS[state] ?? state;

const ICONS = {
  users: icon('M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 20a8 8 0 0 1 16 0'),
  projects: prototypeIcon('folder'),
  tasks: prototypeIcon('grid'),
  attempts: prototypeIcon('spark'),
  tokens: prototypeIcon('file'),
  cost: icon('M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6'),
  credits: prototypeIcon('clock'),
  clock: prototypeIcon('clock'),
  refresh: prototypeIcon('refresh'),
  search: prototypeIcon('search'),
  settings: prototypeIcon('settings'),
  log: prototypeIcon('file'),
  download: prototypeIcon('download'),
  close: prototypeIcon('close'),
  lock: prototypeIcon('lock'),
  empty: prototypeIcon('folder'),
  chart: icon('M3 3v18h18M7 15l4-4 3 3 5-6'),
  link: prototypeIcon('link'),
  more: prototypeIcon('down')
};
const STATE_TONE: Record<string, string> = {
  succeeded: 'success', test_completed: 'success', failed: 'danger', rejected: 'danger',
  cancelled: 'muted', paused: 'warn', awaiting_input: 'warn', settlement_pending: 'warn',
  running: 'info', queued: 'info', preparing: 'info', validating: 'info', delivering: 'info'
};
const badge = (tone: string, label: string) => `<span class="admin-dashboard-badge ${tone}">${esc(label)}</span>`;
const stateBadge = (state: string) => badge(STATE_TONE[state] ?? 'muted', stateLabel(state));
const pricingBadge = (value: string | null) => value
  ? badge(value === 'priced' ? 'success' : value === 'rate_missing' ? 'warn' : 'muted', value)
  : badge('muted', '未定价');

/** Builds the query string shared by overview/users/tasks; the cursor is opaque. */
export function dashboardQuery(filters: DashboardFilters, cursor: string | null = null, limit = 20): string {
  const query = new URLSearchParams();
  if (filters.from) query.set('from', filters.from);
  if (filters.to) query.set('to', filters.to);
  if (filters.state) query.set('state', filters.state);
  if (filters.userId) query.set('user_id', filters.userId);
  if (cursor) query.set('cursor', cursor);
  query.set('limit', String(limit));
  return '?' + query.toString();
}

export function dashboardCost(amount: string | null, currency: string | null): string {
  if (amount === null) return '—';
  const [whole, fraction = ''] = amount.split('.');
  const trimmed = fraction.replace(/0+$/, '').slice(0, 4) || '0';
  return `${whole}.${trimmed}${currency ? ` ${currency}` : '（币种未知）'}`;
}

export function dashboardDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒`;
}

export function dashboardSummaryHtml(overview: AdminDashboardOverview): string {
  const card = (key: string, label: string, value: string, glyph: string, tone: string) =>
    `<article class="admin-dashboard-card"><span class="admin-dashboard-card-icon ${tone}">${glyph}</span><div><span class="admin-dashboard-card-label">${esc(label)}</span><strong data-dashboard-metric="${esc(key)}">${esc(value)}</strong></div></article>`;
  const states = overview.tasks_by_state.length
    ? overview.tasks_by_state.map(row => `${stateLabel(row.state)} ${number(row.count)}`).join(' · ')
    : '暂无任务';
  return `<section class="admin-dashboard-summary" aria-label="运营汇总">
    ${card('users', '用户', number(overview.users), ICONS.users, '')}
    ${card('projects', '项目', number(overview.projects), ICONS.projects, 'blue')}
    ${card('tasks', '任务', number(overview.tasks), ICONS.tasks, 'violet')}
    ${card('model_attempts', '模型尝试', number(overview.model_attempts), ICONS.attempts, 'amber')}
    ${card('tokens', '输入 / 输出 tokens', `${number(overview.input_tokens)} / ${number(overview.output_tokens)}`, ICONS.tokens, 'teal')}
    ${card('cost', '平台成本', dashboardCost(overview.cost_amount, overview.currency), ICONS.cost, 'gold')}
    ${card('credits', '已结算积分', points(overview.credit_settled_points), ICONS.credits, 'rose')}
  </section>
  <p class="admin-dashboard-range">状态分布：${esc(states)}。范围：${overview.range.from ? esc(date(overview.range.from)) : '不限'} 至 ${overview.range.to ? esc(date(overview.range.to)) : '不限'}。</p>`;
}

function barSvg(items: { value: number; label: string; text: string }[], cls: string): string {
  const W = 300, H = 110, pad = 6;
  const max = Math.max(0, ...items.map(item => item.value)) || 1;
  const width = (W - pad * 2) / Math.max(1, items.length);
  const bars = items.map((item, index) => {
    if (item.value <= 0) return '';
    const height = (item.value / max) * (H - 22);
    const x = pad + index * width + width * 0.16;
    return `<rect class="${cls}" x="${x.toFixed(1)}" y="${(H - 16 - height).toFixed(1)}" width="${(width * 0.68).toFixed(1)}" height="${height.toFixed(1)}" rx="1.5"><title>${esc(item.text)}</title></rect>`;
  }).join('');
  const step = Math.max(1, Math.ceil(items.length / 5));
  const labels = items.map((item, index) => index % step === 0
    ? `<text class="admin-dashboard-axis" x="${(pad + index * width + width * 0.5).toFixed(1)}" y="${H - 3}" text-anchor="middle">${esc(item.label)}</text>` : '').join('');
  return `<svg class="admin-dashboard-chart-svg" viewBox="0 0 300 110" preserveAspectRatio="none" aria-hidden="true">${bars}${labels}</svg>`;
}

function tokenSvg(items: { in: number; out: number; label: string; text: string }[]): string {
  const W = 300, H = 110, pad = 6;
  const max = Math.max(1, ...items.map(item => item.in + item.out));
  const width = (W - pad * 2) / Math.max(1, items.length);
  const bars = items.map((item, index) => {
    const input = (item.in / max) * (H - 22);
    const output = (item.out / max) * (H - 22);
    const x = pad + index * width + width * 0.16;
    return (item.in > 0 ? `<rect class="admin-dashboard-bar token-in" x="${x.toFixed(1)}" y="${(H - 16 - input).toFixed(1)}" width="${(width * 0.68).toFixed(1)}" height="${input.toFixed(1)}" rx="1.5"><title>${esc(item.label)} 输入 ${number(item.in)}</title></rect>` : '') +
      (item.out > 0 ? `<rect class="admin-dashboard-bar token-out" x="${x.toFixed(1)}" y="${(H - 16 - input - output).toFixed(1)}" width="${(width * 0.68).toFixed(1)}" height="${output.toFixed(1)}" rx="1.5"><title>${esc(item.label)} 输出 ${number(item.out)}</title></rect>` : '');
  }).join('');
  const step = Math.max(1, Math.ceil(items.length / 5));
  const labels = items.map((item, index) => index % step === 0
    ? `<text class="admin-dashboard-axis" x="${(pad + index * width + width * 0.5).toFixed(1)}" y="${H - 3}" text-anchor="middle">${esc(item.label)}</text>` : '').join('');
  return `<svg class="admin-dashboard-chart-svg" viewBox="0 0 300 110" preserveAspectRatio="none" aria-hidden="true">${bars}${labels}</svg>`;
}

export function dashboardTrendHtml(overview: AdminDashboardOverview): string {
  const daily = overview.daily ?? [];
  if (!daily.length) return `<section class="admin-dashboard-panel" aria-label="时间趋势"><div class="admin-dashboard-panel-head"><div class="admin-dashboard-panel-title">${ICONS.chart}时间趋势 <span class="admin-dashboard-panel-sub">按任务创建时间（UTC）</span></div></div><div class="admin-dashboard-empty">${ICONS.empty}<p>暂无按天趋势数据。</p></div></section>`;
  const first = daily[0]!.date, last = daily[daily.length - 1]!.date;
  const rangeText = `${first} 至 ${last} · ${daily.length} 个 UTC 日`;
  const truncated = overview.range.from !== null && overview.range.from.slice(0, 10) < first;
  const rangeNote = truncated
    ? `趋势仅展示所选范围最后 ${daily.length} 个 UTC 日；汇总与明细保留完整筛选范围。`
    : '图表按以上日期统计；汇总与明细按完整筛选范围统计。';
  const panelHead = `<div class="admin-dashboard-panel-head"><div class="admin-dashboard-panel-title">${ICONS.chart}时间趋势 <span class="admin-dashboard-panel-sub">按任务创建时间（UTC）</span></div><span class="admin-dashboard-panel-sub">${esc(rangeText)}</span></div>`;
  const tasksTotal = daily.reduce((sum, d) => sum + d.tasks, 0);
  if (tasksTotal === 0) return `<section class="admin-dashboard-panel" aria-label="时间趋势">${panelHead}<p class="admin-dashboard-range">${esc(rangeNote)}</p><div class="admin-dashboard-empty">${ICONS.empty}<p>该趋势日期范围内没有任务。</p></div></section>`;
  const inputTotal = daily.reduce((sum, d) => sum + d.input_tokens, 0);
  const outputTotal = daily.reduce((sum, d) => sum + d.output_tokens, 0);
  const priced = daily.filter(d => d.cost_amount !== null);
  const costTotal = priced.reduce((sum, d) => sum + Number(d.cost_amount), 0);
  const currencies = new Set(priced.map(d => d.currency).filter((c): c is string => !!c));
  const currency = currencies.size === 1 ? [...currencies][0] : null;
  const costText = priced.length ? dashboardCost(costTotal.toFixed(10), currency) : '未定价';
  const short = (value: string) => (value.length >= 10 ? value.slice(5) : value);
  const tasks = barSvg(daily.map(d => ({ value: d.tasks, label: short(d.date), text: `${d.date} 任务 ${d.tasks}` })), 'admin-dashboard-bar');
  const users = barSvg(daily.map(d => ({ value: d.active_users, label: short(d.date), text: `${d.date} 活跃用户 ${d.active_users}` })), 'admin-dashboard-bar users');
  const avgUsers = (daily.reduce((sum, d) => sum + d.active_users, 0) / daily.length).toFixed(1);
  const tokens = tokenSvg(daily.map(d => ({ in: d.input_tokens, out: d.output_tokens, label: short(d.date), text: `${d.date} ${d.input_tokens + d.output_tokens}` })));
  const costs = barSvg(daily.map(d => ({ value: d.cost_amount === null ? 0 : Number(d.cost_amount), label: short(d.date), text: `${d.date} 成本 ${d.cost_amount === null ? '未定价' : dashboardCost(d.cost_amount, d.currency)}` })), 'admin-dashboard-bar cost');
  return `<section class="admin-dashboard-panel admin-dashboard-trend" aria-label="时间趋势">
    ${panelHead}<p class="admin-dashboard-range">${esc(rangeNote)}</p>
    <div class="admin-dashboard-charts">
      <div class="admin-dashboard-chart"><h3>${ICONS.tasks}任务数 <small>共 ${number(tasksTotal)}</small></h3>${tasks}<div class="admin-dashboard-legend"><span><i style="background:#3f7a5e"></i>任务</span></div></div>
      <div class="admin-dashboard-chart"><h3>${ICONS.tokens}tokens <small>${number(inputTotal)} / ${number(outputTotal)}</small></h3>${tokens}<div class="admin-dashboard-legend"><span><i style="background:#2f6f9f"></i>输入</span><span><i style="background:#9cc0d8"></i>输出</span></div></div>
      <div class="admin-dashboard-chart"><h3>${ICONS.cost}平台成本 <small>${esc(costText)}</small></h3>${costs}<div class="admin-dashboard-legend"><span><i style="background:#b98a2e"></i>成本</span></div></div>
      <div class="admin-dashboard-chart"><h3>${ICONS.users}用户量 <small>日均 ${avgUsers} 人</small></h3>${users}<div class="admin-dashboard-legend"><span><i style="background:#6b4fa0"></i>当日活跃用户</span></div></div>
    </div>
  </section>`;
}

export function dashboardUsersHtml(items: AdminDashboardUser[], activeUserId: string | null): string {
  if (!items.length) return `<div class="admin-dashboard-empty">${ICONS.empty}<p>没有符合条件的用户。</p></div>`;
  const rows = items.map(item => `<tr data-dashboard-user-row="${esc(item.user_id)}"${item.user_id === activeUserId ? ' class="selected"' : ''}>
    <th scope="row"><button type="button" class="admin-dashboard-link" data-dashboard-user-filter="${esc(item.user_id)}">${esc(item.user_id)}</button></th>
    <td class="admin-dashboard-mono">${esc(item.phone_masked ?? '未绑定手机')}</td>
    <td>${badge(item.status === 'active' ? 'success' : 'muted', item.status === 'active' ? '正常' : '已停用')}</td>
    <td class="admin-dashboard-num">${number(item.projects)}</td>
    <td class="admin-dashboard-num">${number(item.runs)}<small class="admin-dashboard-sub">${esc(item.runs_by_state.map(row => `${stateLabel(row.state)} ${number(row.count)}`).join(' · ') || '无任务')}</small></td>
    <td>${item.last_run_at ? esc(date(item.last_run_at)) : '—'}</td>
    <td class="admin-dashboard-num">${number(item.model_attempts)}</td>
    <td class="admin-dashboard-num">${number(item.input_tokens)} / ${number(item.output_tokens)}</td>
    <td class="admin-dashboard-num">${esc(dashboardCost(item.cost_amount, item.currency))}</td>
    <td class="admin-dashboard-num">${esc(points(item.credit_settled_points))}</td>
  </tr>`).join('');
  return `<div class="admin-dashboard-table" role="region" aria-label="用户明细" tabindex="0"><table>
    <thead><tr><th>用户</th><th>手机</th><th>状态</th><th class="admin-dashboard-num">项目</th><th class="admin-dashboard-num">任务</th><th>最近任务</th><th class="admin-dashboard-num">模型尝试</th><th class="admin-dashboard-num">输入 / 输出 tokens</th><th class="admin-dashboard-num">平台成本</th><th class="admin-dashboard-num">已结算积分</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

export function dashboardTasksHtml(items: AdminDashboardTask[]): string {
  if (!items.length) return `<div class="admin-dashboard-empty">${ICONS.empty}<p>没有符合条件的任务。</p></div>`;
  const rows = items.map(item => `<tr data-dashboard-task-row="${esc(item.run_id)}">
    <th scope="row" class="admin-dashboard-mono">${esc(item.run_id)}</th>
    <td>${esc(item.user_id)}<small class="admin-dashboard-sub">${esc(item.phone_masked ?? '未绑定手机')}</small></td>
    <td>${esc(item.project_name)}<small class="admin-dashboard-sub">${esc(item.project_id)}</small></td>
    <td>${esc(item.task_kind)}</td>
    <td>${stateBadge(item.state)}<small class="admin-dashboard-sub">${esc(item.stage ?? '—')}</small></td>
    <td class="admin-dashboard-num">${esc(dashboardDuration(item.duration_ms))}</td>
    <td class="admin-dashboard-num">${number(item.model_attempts)}</td>
    <td class="admin-dashboard-num">${number(item.input_tokens)} / ${number(item.output_tokens)}</td>
    <td>${esc(dashboardCost(item.cost_amount, item.currency))}<small class="admin-dashboard-sub">${pricingBadge(item.pricing_status)}</small></td>
    <td class="admin-dashboard-mono">${esc(item.last_error_code ?? '—')}</td>
    <td class="admin-dashboard-num">${esc(points(item.credit_settled_points))}</td>
    <td>${item.exec_log_available && item.latest_attempt_id
      ? `<button type="button" class="admin-dashboard-link" data-dashboard-exec-log="${esc(item.latest_attempt_id)}">${ICONS.log}查看执行日志</button>`
      : '—'}</td>
  </tr>`).join('');
  return `<div class="admin-dashboard-table" role="region" aria-label="任务明细" tabindex="0"><table>
    <thead><tr><th>任务</th><th>用户</th><th>项目</th><th>类型</th><th>状态 / 阶段</th><th class="admin-dashboard-num">耗时</th><th class="admin-dashboard-num">模型尝试</th><th class="admin-dashboard-num">输入 / 输出 tokens</th><th>平台成本</th><th>最近错误</th><th class="admin-dashboard-num">已结算积分</th><th>执行日志</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

/** Private attempt log viewer; only reachable through the audited log_reader route. */
export function dashboardExecLogHtml(log: AdminExecLog | null, error: string): string {
  if (error) return `<section class="admin-dashboard-exec-log" role="alert"><p>${esc(error)}</p></section>`;
  if (!log) return '';
  return `<section class="admin-dashboard-exec-log" aria-label="执行日志" data-dashboard-exec-log-panel>
    <header><h2>${ICONS.log}执行日志 ${esc(log.attempt_id)}</h2>
      <div class="admin-dashboard-exec-meta"><span>${ICONS.log}${number(log.byte_size)} 字节${log.truncated ? '（超出上限，已截断）' : ''}</span><span class="admin-dashboard-mono">${ICONS.link}sha256 ${esc(log.sha256)}</span></div>
      <div class="admin-dashboard-exec-actions"><button type="button" class="admin-dashboard-link" data-dashboard-exec-log-download>${ICONS.download}下载 .log</button>
      <button type="button" class="admin-dashboard-link" data-dashboard-exec-log-close>${ICONS.close}关闭</button></div></header>
    <pre data-dashboard-exec-log-body>${esc(log.body)}</pre>
  </section>`;
}

export function dashboardForbiddenHtml(): string {
  return `<section class="admin-dashboard admin-dashboard-forbidden" aria-label="运营管理看板">
    <div class="admin-dashboard-forbidden-card"><span class="admin-dashboard-card-icon">${ICONS.lock}</span><h1>运营管理看板</h1>
    <p role="alert">无运营权限。本页面仅对具备日志读取权限的运营账号开放；如需访问，请联系运营管理员开通。</p>
    <a class="btn secondary" href="#tasks">返回任务进度与结果</a></div></section>`;
}

function filtersHtml(filters: DashboardFilters): string {
  const options = Object.entries(DASHBOARD_STATE_LABELS)
    .map(([value, label]) => `<option value="${esc(value)}"${filters.state === value ? ' selected' : ''}>${esc(label)}</option>`).join('');
  return `<form class="admin-dashboard-filters" data-dashboard-filters>
    <div class="admin-dashboard-filter-grid">
      <label class="admin-dashboard-field"><span>${ICONS.clock}开始日期</span><input type="date" data-dashboard-from value="${esc(filters.from)}"></label>
      <label class="admin-dashboard-field"><span>${ICONS.clock}结束日期</span><input type="date" data-dashboard-to value="${esc(filters.to)}"></label>
      <label class="admin-dashboard-field"><span>${ICONS.settings}状态</span><select data-dashboard-state><option value="">全部状态</option>${options}</select></label>
      <div class="admin-dashboard-filter-actions"><button type="submit" class="btn primary" data-dashboard-apply>${ICONS.search}应用筛选</button>
      <button type="button" class="admin-dashboard-link" data-dashboard-reset>${ICONS.close}清除筛选</button></div>
    </div>
  </form>${filters.userId ? `<p class="admin-dashboard-user-filter" role="status">仅显示用户 ${esc(filters.userId)} 的任务 <button type="button" class="admin-dashboard-link" data-dashboard-clear-user>${ICONS.close}清除用户筛选</button></p>` : ''}`;
}

/** Read-only operator dashboard: summary cards + per-user and per-task tables. */
export class AdminDashboardPage {
  private controller = new AbortController();
  private overview?: AdminDashboardOverview;
  private users: AdminDashboardUser[] = [];
  private tasks: AdminDashboardTask[] = [];
  private usersCursor: string | null = null;
  private tasksCursor: string | null = null;
  private filters = emptyDashboardFilters();
  private loading = false;
  private error = '';
  private forbidden = false;
  private execLog: AdminExecLog | null = null;
  private execLogError = '';
  private execLogLoading = false;
  constructor(private api: ApiClient, private shell: (html: string, section: string) => void, private active: () => boolean) {}
  dispose() { this.controller.abort(); }
  private live() { return this.active() && !this.controller.signal.aborted; }
  async render() { this.draw(); await this.refresh(); }

  private async refresh() {
    if (this.loading) return;
    this.loading = true; this.error = ''; this.draw();
    try {
      const [overview, users, tasks] = await Promise.all([
        this.api.request<AdminDashboardOverview>('GET', '/admin/dashboard/overview' + dashboardQuery(this.filters), undefined, {}, this.controller.signal),
        this.api.request<AdminDashboardUsers>('GET', '/admin/dashboard/users' + dashboardQuery(this.filters), undefined, {}, this.controller.signal),
        this.api.request<AdminDashboardTasks>('GET', '/admin/dashboard/tasks' + dashboardQuery(this.filters), undefined, {}, this.controller.signal)
      ]);
      if (!Value.Check(adminDashboardSchemas.AdminDashboardOverviewResponse, overview) ||
          !Value.Check(adminDashboardSchemas.AdminDashboardUsersResponse, users) ||
          !Value.Check(adminDashboardSchemas.AdminDashboardTasksResponse, tasks)) throw Error('Invalid dashboard data');
      if (!this.live()) return;
      this.overview = overview; this.users = users.items; this.usersCursor = users.next_cursor;
      this.tasks = tasks.items; this.tasksCursor = tasks.next_cursor; this.forbidden = false;
    } catch (error) {
      if (!this.live()) return;
      if (error instanceof ApiError && error.status === 404) { this.forbidden = true; return; }
      this.error = friendlyError(error, 'read');
    } finally {
      if (this.live()) { this.loading = false; this.draw(); }
    }
  }

  private async moreUsers() {
    if (!this.usersCursor || this.loading) return;
    await this.append('users', this.usersCursor);
  }
  private async moreTasks() {
    if (!this.tasksCursor || this.loading) return;
    await this.append('tasks', this.tasksCursor);
  }
  private async append(kind: 'users' | 'tasks', cursor: string) {
    this.loading = true; this.error = ''; this.draw();
    try {
      if (kind === 'users') {
        const page = await this.api.request<AdminDashboardUsers>('GET', '/admin/dashboard/users' + dashboardQuery(this.filters, cursor), undefined, {}, this.controller.signal);
        if (!Value.Check(adminDashboardSchemas.AdminDashboardUsersResponse, page)) throw Error('Invalid dashboard users');
        if (!this.live()) return;
        this.users = [...this.users, ...page.items]; this.usersCursor = page.next_cursor;
      } else {
        const page = await this.api.request<AdminDashboardTasks>('GET', '/admin/dashboard/tasks' + dashboardQuery(this.filters, cursor), undefined, {}, this.controller.signal);
        if (!Value.Check(adminDashboardSchemas.AdminDashboardTasksResponse, page)) throw Error('Invalid dashboard tasks');
        if (!this.live()) return;
        this.tasks = [...this.tasks, ...page.items]; this.tasksCursor = page.next_cursor;
      }
    } catch (error) {
      if (this.live()) this.error = friendlyError(error, 'read');
    } finally {
      if (this.live()) { this.loading = false; this.draw(); }
    }
  }

  private setUser(userId: string) {
    this.filters = {...this.filters, userId};
    this.usersCursor = null; this.tasksCursor = null;
    void this.refresh();
  }

  private async showExecLog(attemptId: string) {
    if (!attemptId || this.execLogLoading) return;
    this.execLogLoading = true; this.execLog = null; this.execLogError = ''; this.draw();
    try {
      const log = await this.api.request<AdminExecLog>('GET', `/admin/exec-logs/${encodeURIComponent(attemptId)}`, undefined, {}, this.controller.signal);
      if (!Value.Check(schemas.AdminExecLogResponse, log)) throw Error('Invalid execution log');
      if (this.live()) this.execLog = log;
    } catch (error) {
      if (this.live()) this.execLogError = error instanceof ApiError && error.status === 404
        ? '无权限或执行日志不存在。' : friendlyError(error, 'read');
    } finally {
      this.execLogLoading = false;
      if (this.live()) this.draw();
    }
  }

  private downloadExecLog() {
    if (!this.execLog) return;
    const url = URL.createObjectURL(new Blob([this.execLog.body], {type: 'text/plain;charset=utf-8'}));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `exec-${this.execLog.attempt_id}.log`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  private draw() {
    if (!this.live()) return;
    if (this.forbidden) { this.shell(dashboardForbiddenHtml(), 'projects'); return; }
    this.shell(`<section class="admin-dashboard">
      <div class="admin-dashboard-page-title">
        <div><h1>${ICONS.chart}运营看板</h1>
        <p>按用户与任务查看模型用量、平台成本与已结算积分；手机号仅显示后四位，执行日志仅经审计读取。</p></div>
        <div class="admin-dashboard-page-actions"><span class="admin-dashboard-pill">${ICONS.lock}只读</span>
        <button type="button" class="btn primary" data-dashboard-refresh ${this.loading ? 'disabled' : ''}>${ICONS.refresh}刷新数据</button></div>
      </div>
      ${this.error ? `<p class="admin-dashboard-alert" role="alert">${esc(this.error)}</p>` : ''}
      ${this.overview ? dashboardSummaryHtml(this.overview) : this.loading ? '<p role="status">正在读取运营汇总…</p>' : ''}
      ${this.overview ? dashboardTrendHtml(this.overview) : ''}
      ${filtersHtml(this.filters)}
      <section class="admin-dashboard-panel" aria-label="用户明细">
        <div class="admin-dashboard-panel-head"><div class="admin-dashboard-panel-title">${ICONS.users}用户</div><div class="admin-dashboard-panel-tools"><span class="admin-dashboard-panel-sub">${this.users.length} 位</span><span class="admin-dashboard-scroll-hint">左右滑动查看更多</span></div></div>
        ${this.loading && !this.users.length ? '<p role="status">正在读取用户明细…</p>' : dashboardUsersHtml(this.users, this.filters.userId || null)}
        ${this.usersCursor ? `<div class="admin-dashboard-more"><button type="button" class="admin-dashboard-link" data-dashboard-more-users ${this.loading ? 'disabled' : ''}>${ICONS.more}加载更多用户</button></div>` : ''}
      </section>
      <section class="admin-dashboard-panel" aria-label="任务明细">
        <div class="admin-dashboard-panel-head"><div class="admin-dashboard-panel-title">${ICONS.tasks}任务</div><div class="admin-dashboard-panel-tools"><span class="admin-dashboard-panel-sub">${this.tasks.length} 个</span><span class="admin-dashboard-scroll-hint">左右滑动查看更多</span></div></div>
        ${this.loading && !this.tasks.length ? '<p role="status">正在读取任务明细…</p>' : dashboardTasksHtml(this.tasks)}
        ${this.tasksCursor ? `<div class="admin-dashboard-more"><button type="button" class="admin-dashboard-link" data-dashboard-more-tasks ${this.loading ? 'disabled' : ''}>${ICONS.more}加载更多任务</button></div>` : ''}
      </section>
      ${this.execLogLoading ? '<p role="status">正在读取执行日志…</p>' : ''}
      ${dashboardExecLogHtml(this.execLog, this.execLogError)}
    </section>`, 'projects');
    document.querySelector('[data-dashboard-refresh]')?.addEventListener('click', () => void this.refresh());
    document.querySelector('[data-dashboard-filters]')?.addEventListener('submit', event => {
      event.preventDefault();
      const value = (selector: string) => (document.querySelector<HTMLInputElement | HTMLSelectElement>(selector)?.value ?? '');
      this.filters = {from: value('[data-dashboard-from]'), to: value('[data-dashboard-to]'), state: value('[data-dashboard-state]'), userId: this.filters.userId};
      this.usersCursor = null; this.tasksCursor = null;
      void this.refresh();
    });
    document.querySelector('[data-dashboard-reset]')?.addEventListener('click', () => {
      this.filters = emptyDashboardFilters(); this.usersCursor = null; this.tasksCursor = null; void this.refresh();
    });
    document.querySelector('[data-dashboard-clear-user]')?.addEventListener('click', () => this.setUser(''));
    document.querySelectorAll<HTMLButtonElement>('[data-dashboard-user-filter]').forEach(button =>
      button.addEventListener('click', () => this.setUser(button.dataset.dashboardUserFilter ?? '')));
    document.querySelector('[data-dashboard-more-users]')?.addEventListener('click', () => void this.moreUsers());
    document.querySelector('[data-dashboard-more-tasks]')?.addEventListener('click', () => void this.moreTasks());
    document.querySelectorAll<HTMLButtonElement>('[data-dashboard-exec-log]').forEach(button =>
      button.addEventListener('click', () => void this.showExecLog(button.dataset.dashboardExecLog ?? '')));
    document.querySelector('[data-dashboard-exec-log-close]')?.addEventListener('click', () => {
      this.execLog = null; this.execLogError = ''; this.draw();
    });
    document.querySelector('[data-dashboard-exec-log-download]')?.addEventListener('click', () => this.downloadExecLog());
  }
}
