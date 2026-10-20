import { esc, date } from '../ui';
import { prototypeIcon as ico } from '../prototype-design';
import { dashboardItems, type DashboardItem } from './dashboard-state';
import type { DesignState, Project } from './model';

export const TASK_GROUPS = { attention: '待处理', active: '进行中', done: '已完成' } as const;
export type TaskGroup = keyof typeof TASK_GROUPS;
export function projectSummary(state: DesignState, selected = 'all') {
  const items = dashboardItems(state);
  return `<div class="pd-overview-stats" aria-label="项目与任务概览"><a href="#tasks" class="pd-stat-card ${selected === 'all' ? 'selected' : ''}" ${selected === 'all' ? 'aria-current="true"' : ''}><span>${ico('folder')} 全部项目</span><strong>${state.projects.length}<small>个项目</small></strong><p>项目资料与工作进展，一处查看</p></a>${Object.entries(TASK_GROUPS).map(([key,label]) => {
    const tasks = items.filter(i => i.group === key);
    const projects = state.projects.filter(p => dashboardItems(state,p).some(i => i.group === key)).length;
    return `<a href="#tasks?status=${key}" class="pd-stat-card ${key} ${selected === key ? 'selected' : ''}" ${selected === key ? 'aria-current="true"' : ''}><span><i></i>${label}</span><strong>${tasks.length}<small>项任务</small></strong><p>${key === 'attention' ? '待补材料、草稿与需确认事项' : key === 'active' ? '正在执行的任务' : '已完成及归档的任务'} · ${projects} 个项目</p></a>`;
  }).join('')}</div>`;
}
export function taskSummary(p: Project, state: DesignState) {
  const tasks = dashboardItems(state,p);
  const next = tasks.find(t => t.group === 'active') ?? tasks.find(t => t.group === 'attention') ?? tasks[0];
  return `<div class="pd-project-task-counts">${Object.entries(TASK_GROUPS).map(([key,label]) => `<button class="pd-task-count ${key}" data-action="project-tasks" data-project="${p.id}" data-group="${key}" aria-label="${esc(p.name)}，${label} ${tasks.filter(t => t.group === key).length} 项"><i></i>${label}<b>${tasks.filter(t => t.group === key).length}</b></button>`).join('')}</div>${next ? `<a class="pd-next-task" href="${esc(next.url)}">${esc(next.title)} ${ico('chevron')}</a><small class="pd-task-detail">${esc(next.detail)}</small>` : '<small class="pd-task-detail">暂无任务 · 从“开始工作”发起</small>'}`;
}
export function projectTaskView(p: Project, state: DesignState, group: string) {
  const items = dashboardItems(state,p).filter(i => group === 'all' || i.group === group);
  return `<p class="pd-task-project">${ico('folder')} ${esc(p.name)}</p><div class="pd-task-dialog-tabs">${[['all','全部'],...Object.entries(TASK_GROUPS)].map(([key,label]) => `<button class="btn ${key === group ? 'primary' : 'secondary'}" data-task-tab="${key}" aria-pressed="${key === group}">${label}</button>`).join('')}</div>${items.length ? `<div class="pd-task-list">${items.map(item => taskRow(item)).join('')}</div>` : '<div class="pd-empty">暂无这类任务，可切换查看其他状态。</div>'}`;
}
function taskRow(item: DashboardItem) {
  return `<div class="pd-task-entry"><div class="pd-grow"><span class="pd-task-label ${item.group}">${esc(item.label)}</span><h3>${esc(item.title)}</h3><p>${esc(item.detail)}</p><time datetime="${esc(item.time)}">${esc(date(item.time))}</time></div><a class="btn secondary" href="${esc(item.url)}">${esc(item.action)} ${ico('arrow')}</a></div>`;
}
