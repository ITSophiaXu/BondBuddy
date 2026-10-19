import { prototypeIcon as icon } from './prototype-design';
import { esc } from './ui';
import { dashboardKinds, dashboardGroups } from './dashboard-model';

/** Shared with the live dashboard; data and execution remain owned by the caller. */
export function dashboardFrame(options: { description?: string; starts?: string[][]; kinds?: Record<string,string>; footnote?: string } = {}) {
  return `<div class="status-dashboard"><header class="page-head"><div><h1>工作台</h1><p>${esc(options.description ?? "继续手上的任务，查看生成结果。")}</p></div></header>
      <div class="dashboard-summary" aria-label="任务状态概览">${(['attention','active','done'] as const).map(group=>`<button type="button" class="dashboard-summary-card" data-dashboard-group="${group}" aria-pressed="false"><span class="dashboard-summary-label">${icon(group==='active'?'clock':group==='done'?'check':'file')}${dashboardGroups[group]}</span><strong data-dashboard-count="${group}">—</strong><span data-dashboard-sub="${group}">正在同步</span><span class="dashboard-summary-arrow">${icon('arrow')}</span></button>`).join('')}</div>
      <div class="dashboard-start"><span>开始新任务</span>${(options.starts ?? [['update','update','更新募集书'],['review','review','复核募集书'],['generate?new=1','spark','生成材料']]).map(([route,ico,label])=>`<a class="btn secondary small" href="#${route}">${icon(ico)}${label}</a>`).join('')}</div>
      <section class="panel dashboard-tasks"><div class="panel-head"><h2 id="dashboard-list-title">最近任务</h2><a class="text-btn" href="#tasks">全部项目 ${icon('arrow')}</a></div>
      <div class="dashboard-toolbar"><div class="dashboard-type-filters" aria-label="任务类型">${[['all','全部类型'],...Object.entries(options.kinds ?? dashboardKinds)].map(([kind,label])=>`<button type="button" data-dashboard-kind="${kind}" aria-pressed="false">${label}</button>`).join('')}</div><label class="dashboard-status-filter"><span class="sr-only">任务状态</span><select id="dashboard-status">${Object.entries(dashboardGroups).map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></label></div>
      <p id="dashboard-error" class="dashboard-error" role="alert" hidden></p><div id="dashboard-projects" aria-live="polite"><p class="empty" role="status">正在同步任务…</p></div>
      <footer class="dashboard-list-footer"><span id="dashboard-list-note">统计未归档项目，每个项目显示当前或最近任务</span><button type="button" class="text-btn" id="dashboard-more" hidden>显示更多</button><button type="button" class="text-btn" id="dashboard-refresh">刷新状态</button></footer></section>
      <p class="dashboard-footnote">${icon('clock')}${esc(options.footnote ?? "任务在后台持续执行，离开页面也会继续。")}</p></div>`;
}
