import {Value} from '@sinclair/typebox/value';
import {
  adminDashboardSchemas,
  type AdminDashboardOverview,
  type AdminDashboardTask,
  type AdminDashboardTasks,
  type AdminDashboardUser,
  type AdminDashboardUsers
} from '@bondbuddy/contracts';
import {ApiClient, ApiError, friendlyError} from './api.js';
import {date, esc} from './ui.js';

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
  const card = (key: string, label: string, value: string) =>
    `<div class="admin-dashboard-card"><span>${esc(label)}</span><strong data-dashboard-metric="${esc(key)}">${esc(value)}</strong></div>`;
  const states = overview.tasks_by_state.length
    ? overview.tasks_by_state.map(row => `${stateLabel(row.state)} ${number(row.count)}`).join(' · ')
    : '暂无任务';
  return `<section class="admin-dashboard-summary" aria-label="运营汇总">
    ${card('users', '用户', number(overview.users))}
    ${card('projects', '项目', number(overview.projects))}
    ${card('tasks', '任务', number(overview.tasks))}
    ${card('model_attempts', '模型尝试', number(overview.model_attempts))}
    ${card('tokens', '输入 / 输出 tokens', `${number(overview.input_tokens)} / ${number(overview.output_tokens)}`)}
    ${card('cost', '平台成本', dashboardCost(overview.cost_amount, overview.currency))}
    ${card('credits', '已结算积分', points(overview.credit_settled_points))}
  </section>
  <p class="admin-dashboard-range">状态分布：${esc(states)}。范围：${overview.range.from ? esc(date(overview.range.from)) : '不限'} 至 ${overview.range.to ? esc(date(overview.range.to)) : '不限'}。</p>`;
}

export function dashboardUsersHtml(items: AdminDashboardUser[], activeUserId: string | null): string {
  if (!items.length) return '<p>没有符合条件的用户。</p>';
  const rows = items.map(item => `<tr data-dashboard-user-row="${esc(item.user_id)}"${item.user_id === activeUserId ? ' class="selected"' : ''}>
    <th scope="row"><button type="button" class="text-button" data-dashboard-user-filter="${esc(item.user_id)}">${esc(item.user_id)}</button></th>
    <td>${esc(item.phone_masked ?? '未绑定手机')}</td>
    <td>${item.status === 'active' ? '正常' : '已停用'}</td>
    <td>${number(item.projects)}</td>
    <td>${number(item.runs)}<small>${esc(item.runs_by_state.map(row => `${stateLabel(row.state)} ${number(row.count)}`).join(' · ') || '无任务')}</small></td>
    <td>${item.last_run_at ? esc(date(item.last_run_at)) : '—'}</td>
    <td>${number(item.model_attempts)}</td>
    <td>${number(item.input_tokens)} / ${number(item.output_tokens)}</td>
    <td>${esc(dashboardCost(item.cost_amount, item.currency))}</td>
    <td>${esc(points(item.credit_settled_points))}</td>
  </tr>`).join('');
  return `<div class="admin-dashboard-table" role="region" aria-label="用户明细" tabindex="0"><table>
    <thead><tr><th>用户</th><th>手机</th><th>状态</th><th>项目</th><th>任务</th><th>最近任务</th><th>模型尝试</th><th>输入 / 输出 tokens</th><th>平台成本</th><th>已结算积分</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

export function dashboardTasksHtml(items: AdminDashboardTask[]): string {
  if (!items.length) return '<p>没有符合条件的任务。</p>';
  const rows = items.map(item => `<tr data-dashboard-task-row="${esc(item.run_id)}">
    <th scope="row">${esc(item.run_id)}</th>
    <td>${esc(item.user_id)}<small>${esc(item.phone_masked ?? '未绑定手机')}</small></td>
    <td>${esc(item.project_name)}<small>${esc(item.project_id)}</small></td>
    <td>${esc(item.task_kind)}</td>
    <td>${esc(stateLabel(item.state))}<small>${esc(item.stage ?? '—')}</small></td>
    <td>${esc(dashboardDuration(item.duration_ms))}</td>
    <td>${number(item.model_attempts)}</td>
    <td>${number(item.input_tokens)} / ${number(item.output_tokens)}</td>
    <td>${esc(dashboardCost(item.cost_amount, item.currency))}<small>${esc(item.pricing_status ?? '未定价')}</small></td>
    <td>${esc(item.last_error_code ?? '—')}</td>
    <td>${esc(points(item.credit_settled_points))}</td>
  </tr>`).join('');
  return `<div class="admin-dashboard-table" role="region" aria-label="任务明细" tabindex="0"><table>
    <thead><tr><th>任务</th><th>用户</th><th>项目</th><th>类型</th><th>状态 / 阶段</th><th>耗时</th><th>模型尝试</th><th>输入 / 输出 tokens</th><th>平台成本</th><th>最近错误</th><th>已结算积分</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

export function dashboardForbiddenHtml(): string {
  return `<section class="admin-dashboard" aria-label="运营管理看板"><header><h1>运营管理看板</h1><a href="#tasks">返回任务进度与结果</a></header>
    <p role="alert">无运营权限。本页面仅对具备日志读取权限的运营账号开放；如需访问，请联系运营管理员开通。</p></section>`;
}

function filtersHtml(filters: DashboardFilters): string {
  const options = Object.entries(DASHBOARD_STATE_LABELS)
    .map(([value, label]) => `<option value="${esc(value)}"${filters.state === value ? ' selected' : ''}>${esc(label)}</option>`).join('');
  return `<form class="admin-dashboard-filters" data-dashboard-filters>
    <label>开始日期<input type="date" data-dashboard-from value="${esc(filters.from)}"></label>
    <label>结束日期<input type="date" data-dashboard-to value="${esc(filters.to)}"></label>
    <label>状态<select data-dashboard-state><option value="">全部状态</option>${options}</select></label>
    <button type="submit" class="btn secondary" data-dashboard-apply>应用筛选</button>
    <button type="button" class="text-button" data-dashboard-reset>清除筛选</button>
  </form>${filters.userId ? `<p class="admin-dashboard-user-filter" role="status">仅显示用户 ${esc(filters.userId)} 的任务 <button type="button" class="text-button" data-dashboard-clear-user>清除用户筛选</button></p>` : ''}`;
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

  private draw() {
    if (!this.live()) return;
    if (this.forbidden) { this.shell(dashboardForbiddenHtml(), 'projects'); return; }
    this.shell(`<section class="admin-dashboard">
      <header><h1>运营管理看板</h1><button type="button" class="text-button" data-dashboard-refresh ${this.loading ? 'disabled' : ''}>刷新数据</button></header>
      <p>只读运营视图：按用户和任务查看模型用量、平台成本与已结算积分。手机号仅显示后四位。</p>
      ${this.error ? `<p role="alert">${esc(this.error)}</p>` : ''}
      ${this.overview ? dashboardSummaryHtml(this.overview) : this.loading ? '<p role="status">正在读取运营汇总…</p>' : ''}
      ${filtersHtml(this.filters)}
      <section aria-label="用户明细"><header><h2>用户</h2></header>${this.loading && !this.users.length ? '<p role="status">正在读取用户明细…</p>' : dashboardUsersHtml(this.users, this.filters.userId || null)}${this.usersCursor ? `<button type="button" class="text-button" data-dashboard-more-users ${this.loading ? 'disabled' : ''}>加载更多用户</button>` : ''}</section>
      <section aria-label="任务明细"><header><h2>任务</h2></header>${this.loading && !this.tasks.length ? '<p role="status">正在读取任务明细…</p>' : dashboardTasksHtml(this.tasks)}${this.tasksCursor ? `<button type="button" class="text-button" data-dashboard-more-tasks ${this.loading ? 'disabled' : ''}>加载更多任务</button>` : ''}</section>
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
  }
}
