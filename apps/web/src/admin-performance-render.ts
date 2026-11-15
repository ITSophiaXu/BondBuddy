import {PERFORMANCE_SPAN_STATUSES, type AdminPerformanceSummaryResponse, type PerformanceCoverage, type PerformanceSpan} from '@bondbuddy/contracts';
import {esc, button} from './admin-inspection-render.js';
import {label, time} from './admin-inspection-model.js';
import {duration} from './admin-inspection-timing.js';
import {performanceTree, runPerformanceMetrics, type RunPerformanceData} from './admin-performance-model.js';
import type {PerformanceFilters} from './admin-performance-api.js';

export type PerformanceReadState<T> = {data?: T; loading: boolean; error: string};
export const performanceStatus = (status: string) => ({running: '运行中', succeeded: '成功', failed: '失败', cancelled: '已取消', paused: '暂停结束', reused: '已复用', interrupted: '中断 / 缺少结束'}[status] ?? status);
const metric = (title: string, value: string, note: string) => `<div class="perf-metric"><span>${title}</span><strong>${esc(value)}</strong><small>${note}</small></div>`;

export function performanceCoverage(coverage: PerformanceCoverage): string {
  return `<p class="perf-coverage ${coverage.complete ? '' : 'perf-incomplete'}" data-perf-coverage>
    <strong>${coverage.complete ? '当前范围采集完整' : '当前范围存在运行中或缺测记录'}</strong>
    · ${coverage.instrumented_run_count} / ${coverage.run_count} 次任务有步骤记录 · ${coverage.uninstrumented_run_count} 次未埋点
    · ${coverage.complete_session_count} / ${coverage.session_count} 个会话完整 · ${coverage.unfinished_span_count} 个步骤未结束或计时缺测
    · 丢弃 ${coverage.dropped_spans} · 无效属性 ${coverage.invalid_attributes} · 写入错误 ${coverage.flush_errors}
    · 保留期已清理 ${coverage.purged_span_count} 个步骤 / ${coverage.purged_session_count} 个会话
  </p>`;
}

const fields: [keyof PerformanceFilters, string, string][] = [
  ['from', '任务提交起日（北京）', 'date'], ['to', '任务提交止日（北京）', 'date'],
  ['task_kind', '任务类型', '如 update / review / qa'], ['step_key', '步骤', '如 model.exec'],
  ['model_id', '模型', '模型 ID'], ['span_status', '步骤结果', 'status'],
  ['owner_user_id', '用户 ID', '完整用户 ID'], ['project_id', '项目 ID', '完整项目 ID'],
  ['run_state', '任务状态', '如 succeeded / failed'], ['channel', '渠道', '如 production / non_production_test'],
  ['stage', '阶段', '如 model_generation'], ['model_provider', '模型供应方', '供应方代码'],
  ['release_sha', '发布版本', '完整 commit SHA'],
];
function filterField([name, title, kind]: typeof fields[number], values: PerformanceFilters): string {
  const input = kind === 'status' ? `<select name="${name}"><option value="">全部结果</option>${PERFORMANCE_SPAN_STATUSES.map(status => `<option value="${status}" ${values[name] === status ? 'selected' : ''}>${performanceStatus(status)}</option>`).join('')}</select>`
    : `<input name="${name}" type="${kind === 'date' ? 'date' : 'text'}" value="${esc(values[name])}" ${kind === 'date' ? '' : `placeholder="${esc(kind)}" maxlength="128"`}>`;
  return `<label>${title}${input}</label>`;
}

export function performanceSummaryPanel(state: PerformanceReadState<AdminPerformanceSummaryResponse>, draft: PerformanceFilters, advanced: boolean): string {
  const data = state.data;
  const rows = data ? [...data.items].sort((a, b) => (b.p95_ms ?? -1) - (a.p95_ms ?? -1) || b.span_count - a.span_count) : [];
  return `<section class="panel perf-panel" data-performance-summary aria-busy="${state.loading}">
    <div class="perf-heading"><div><h3>步骤性能</h3><p class="muted">按任务类型、步骤、模型、发布版本和结果分组，定位慢任务。</p></div><span class="source-tag">服务端全筛选统计</span></div>
    <p class="muted perf-scope-note">本区单独筛选完整数据库范围，不受上方任务列表筛选或 1000 条快照上限影响。日期按任务提交时间。</p>
    <form data-perf-filters><div class="perf-filters">${fields.slice(0, 6).map(field => filterField(field, draft)).join('')}</div>
      <details data-perf-advanced ${advanced ? 'open' : ''}><summary>更多筛选：用户、项目、任务状态、阶段和发布版本</summary><div class="perf-filters">${fields.slice(6).map(field => filterField(field, draft)).join('')}</div></details>
      <div class="actions perf-actions">${button(state.loading ? '查询中…' : '查询性能', `type="submit" ${state.loading ? 'disabled' : ''}`, 'button primary')}${button('重置性能筛选', 'type="button" data-perf-reset')}${button('导出汇总 CSV', `type="button" data-perf-export="summary-csv" ${!data || state.loading ? 'disabled' : ''}`)}${button('导出汇总 JSON', `type="button" data-perf-export="summary-json" ${!data || state.loading ? 'disabled' : ''}`)}</div>
    </form>
    ${state.error ? `<p class="notice" role="alert">${esc(state.error)}${data ? ' 下方保留上次查询结果。' : ''}</p>` : ''}
    ${!data ? `<div class="empty">${state.loading ? '正在查询服务端全部匹配记录…' : '点击“查询性能”加载统计。未查询不代表没有耗时或调用。'}</div>` : `
      <p class="perf-query-receipt">查询于 ${esc(time(data.captured_at))} · 全部匹配 ${data.coverage.run_count} 次任务 · ${data.items.length} 个分组<br>生效范围：${esc(Object.entries(data.scope.filters).map(([key, value]) => `${key}=${value}`).join(' · ') || '全部任务')} · 审计 ID <span class="mono">${esc(data.audit_id)}</span></p>
      ${performanceCoverage(data.coverage)}
      <p class="muted">P50 / P90 / P95 仅使用具有完整结束计时的样本；运行中、缺测不会计为 0。各分组任务可能重叠，不能相加当作总任务数。</p>
      ${rows.length ? `<div class="table-scroll" role="region" aria-label="全筛选步骤性能统计" tabindex="0"><table class="perf-summary-table"><thead><tr><th>任务 / 阶段 / 步骤</th><th>模型 / 发布版本</th><th>任务 / 步骤结果</th><th>任务数 / 步骤数</th><th>分位样本 / 缺测</th><th>P50</th><th>P90</th><th>P95 ↓</th><th>平均 / 最长</th></tr></thead><tbody>${rows.map(row => `<tr>
        <td><strong>${esc(label(row.task_kind))}</strong><small>${esc(row.stage ?? '未记录阶段')}</small><code>${esc(row.step_key)}</code><small>步骤定义 v${row.step_version}</small></td>
        <td>${esc(row.model_id ?? '无模型记录')}<small>${esc(row.model_provider ?? '供应方未记录')}</small><code title="${esc(row.release_sha ?? '')}">${esc(row.release_sha?.slice(0, 12) ?? '版本未记录')}</code></td>
        <td>${esc(label(row.run_state))}<small>${esc(performanceStatus(row.span_status))}</small></td>
        <td>${row.run_count} / ${row.span_count}<small>结束 ${row.completed_count} · 运行 ${row.running_count} · 失败 ${row.failed_count}</small></td>
        <td><strong>${row.timed_count}</strong> / ${row.missing_duration_count}</td><td>${esc(duration(row.p50_ms))}</td><td>${esc(duration(row.p90_ms))}</td><td><strong>${esc(duration(row.p95_ms))}</strong></td><td>${esc(duration(row.mean_ms))}<small>${esc(duration(row.max_ms))}</small></td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="empty">该筛选范围没有步骤样本；历史未埋点任务保留在上方覆盖统计中。</div>'}
    `}
  </section>`;
}

function spanAttributes(span: PerformanceSpan): string {
  const all = Object.entries(span.attributes);
  const groups: [string, typeof all][] = [
    ['调用与模型', all.filter(([key]) => /call|attempt|model|provider|adapter|reasoning|token|first_|ttft/.test(key))],
    ['缓存与共享工作', all.filter(([key]) => /cache|reused|producer|batch|group|work_item/.test(key) && !/token/.test(key))],
    ['工作量与测量上下文', all.filter(([key]) => !/call|attempt|model|provider|adapter|reasoning|token|first_|ttft|cache|reused|producer|batch|group|work_item/.test(key))],
  ];
  return groups.filter(([, values]) => values.length).map(([title, values]) => `<div><h4>${title}</h4><dl class="perf-attributes">${values.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value === null ? '未知' : value === true ? '是' : value === false ? '否' : value)}</dd>`).join('')}</dl></div>`).join('') || '<p class="muted">此步骤未记录额外上下文。</p>';
}

export function performanceRunPanel(runId: string, state: PerformanceReadState<RunPerformanceData>, collapsed: ReadonlySet<string>, expanded: ReadonlySet<string>): string {
  const data = state.data;
  const controls = `<div class="actions perf-actions">${button(state.loading ? '读取中…' : data ? '刷新步骤' : '加载步骤', `data-perf-run-refresh="${esc(runId)}" ${state.loading ? 'disabled' : ''}`)}${button('导出已载入 CSV', `data-perf-export="run-csv" ${!data || state.loading ? 'disabled' : ''}`)}${button('导出已载入 JSON', `data-perf-export="run-json" ${!data || state.loading ? 'disabled' : ''}`)}</div>`;
  if (!data) return `<section class="panel perf-panel" data-performance-run aria-busy="${state.loading}"><h3>步骤瀑布</h3>${controls}${state.error ? `<p role="alert" class="notice">${esc(state.error)}</p>` : ''}<div class="empty">${state.loading ? '正在读取此任务的步骤…' : '按需读取本次执行的嵌套步骤与采集完整度；历史任务不会补造步骤。'}</div></section>`;
  const metrics = runPerformanceMetrics(data), tree = performanceTree(data.items, collapsed);
  const session = new Map(data.sessions.map(item => [item.session_id, item]));
  const width = metrics.chartEnd - metrics.chartStart;
  return `<section class="panel perf-panel" data-performance-run aria-busy="${state.loading}">
    <div class="perf-heading"><h3>步骤瀑布</h3><span class="source-tag">按需分页 · ${data.items.length} / ${data.total} 条</span></div>${controls}
    ${state.error ? `<p role="alert" class="notice">${esc(state.error)} 已载入记录保留。</p>` : ''}
    <div class="perf-metrics">
      ${metric(metrics.open ? '任务已历时' : '任务总历时', duration(metrics.totalMs), metrics.open ? '提交至本次查询，含排队与暂停' : '提交至可信终态；缺终态则未知')}
      ${metric('细步骤解释覆盖', duration(metrics.coveredMs), metrics.complete ? '真实边界区间并集，排除整段容器' : '仅已载入完整计时，覆盖尚不完整')}
      ${metric('未解释时间', duration(metrics.unexplainedMs), '仅完整采集且完整分页时计算')}
      ${metric('失败 / 耗时缺测', `${metrics.failed} / ${metrics.missing}`, '已载入步骤；含未结束或工具边界缺测')}
    </div>
    ${performanceCoverage({...data.coverage, complete: data.coverage.complete && metrics.missing === 0, unfinished_span_count: Math.max(data.coverage.unfinished_span_count, metrics.missing)})}
    <p class="perf-query-receipt">查询于 ${esc(time(data.captured_at))} · 已读取 ${data.pages.length} 页 · ${metrics.completePages ? '分页已全部载入' : '分页尚未全部载入'} · 审计 ID <span class="mono">${esc(data.audit_id)}</span></p>
    <p class="muted">顶部解释覆盖排除任务、阶段、模型调用等整段容器，只统计实际工作边界；CLI 执行包含模型和工具，不代表纯模型耗时。父行显示直接子步骤的区间并集。“未解释”不等于空闲或 CPU 耗时。运行中已历时截至所在页查询时间；继续分页不会自动更新旧页。缺测及未载入部分保持未知。</p>
    ${metrics.hasOrphans ? '<p class="notice">部分父步骤尚未载入或未采集，相关步骤暂列在顶层；不会推测其父子关系。</p>' : ''}
    ${tree.length ? `<div class="perf-waterfall-scroll" role="region" aria-label="嵌套步骤耗时瀑布" tabindex="0"><div class="perf-waterfall">
      <div class="perf-waterfall-head"><span>步骤 / 状态（展开查看上下文）</span><span>相对提交时间 · ${esc(duration(Math.max(0, width)))}</span><span>总耗时 / 已历时</span><span>子区间并集</span><span>未解释</span></div>
      ${tree.map(({span, depth}) => {
        const row = metrics.row(span), children = metrics.children.get(span.span_id) ?? [];
        const left = row.range ? Math.max(0, Math.min(100, (row.range[0] - metrics.chartStart) / width * 100)) : 0;
        const extent = row.range ? Math.max(0.2, Math.min(100 - left, (row.range[1] - row.range[0]) / width * 100)) : 0;
        const ss = session.get(span.session_id), missingEnd = span.status === 'running' && ss?.closed;
        return `<div class="perf-span-group" id="perf-span-${esc(span.span_id)}">
          <div class="perf-span-row" data-perf-span="${esc(span.span_id)}" data-depth="${depth}">
            <div class="perf-span-label" style="--perf-depth:${Math.min(depth, 8)}">${children.length ? `<button class="perf-tree-toggle" data-perf-collapse="${esc(span.span_id)}" aria-expanded="${!collapsed.has(span.span_id)}" aria-label="${collapsed.has(span.span_id) ? '展开' : '收起'} ${esc(span.step_key)} 的子步骤">${collapsed.has(span.span_id) ? '▸' : '▾'}</button>` : '<span class="perf-tree-leaf">·</span>'}
              <button class="link perf-span-title" data-perf-inspect="${esc(span.span_id)}" aria-expanded="${expanded.has(span.span_id)}" aria-controls="perf-context-${esc(span.span_id)}"><strong>${esc(span.step_key)}</strong><small>${esc(span.stage ?? '跨阶段')} · <span class="perf-status" data-status="${span.status}">${missingEnd ? '会话已关闭 / 结束缺测' : performanceStatus(span.status)}</span>${row.missingParent ? ' · 父步骤未载入' : ''}</small></button>
            </div>
            <div class="perf-track" aria-label="${esc(span.step_key)}：${esc(duration(row.elapsedMs))}">${row.range ? `<i style="left:${left.toFixed(3)}%;width:${extent.toFixed(3)}%" data-status="${span.status}" class="${row.ms === null ? 'perf-provisional' : ''}"></i>` : '<span>时间区间缺测</span>'}</div>
            <span class="perf-number">${esc(duration(row.elapsedMs))}${row.open ? '<small>运行中已历时</small>' : row.ms === null ? '<small>耗时缺测</small>' : span.attributes.tool_timing_complete === false ? '<small>工具计时缺测</small>' : ''}</span>
            <span class="perf-number">${esc(duration(row.childUnionMs))}<small>${row.complete ? `${children.length} 个直接子步骤` : '已载入覆盖'}</small></span>
            <span class="perf-number">${esc(duration(row.unexplainedMs))}<small>${row.complete ? '' : '待完整记录'}</small></span>
          </div>
          <div class="perf-context" id="perf-context-${esc(span.span_id)}" ${expanded.has(span.span_id) ? '' : 'hidden'}>
            <dl class="perf-attributes"><dt>span / 父 span</dt><dd>${esc(span.span_id)} / ${esc(span.parent_span_id ?? '根步骤')}</dd><dt>执行 / 会话 / 作业</dt><dd>${esc(span.run_execution_id)} / ${esc(span.session_id)} / ${esc(span.job_id ?? '未记录')}</dd><dt>开始 / 结束</dt><dd>${esc(time(span.started_at))} / ${span.ended_at ? esc(time(span.ended_at)) : '未记录结束'}</dd><dt>所在页查询 / 最近活动</dt><dd>${esc(time(data.observedAt[span.span_id]))} / ${esc(time(span.last_activity_at))}</dd><dt>时钟 / 步骤定义</dt><dd>${esc(span.clock_source)} / v${span.step_version}</dd><dt>worker / 发布版本</dt><dd>${esc(ss?.worker_instance_id ?? '未记录')} / ${esc(ss?.release_sha ?? '未记录')}</dd><dt>关联共享步骤</dt><dd>${span.span_links.length ? span.span_links.map(id => `<code>${esc(id)}</code>`).join(' · ') : '未记录'}</dd></dl>
            <div class="perf-context-groups">${spanAttributes(span)}</div>
          </div>
        </div>`;
      }).join('')}
    </div></div>` : '<div class="empty">该任务没有已采集的步骤。旧版本未埋点或采集故障都可能造成缺测，不能推定未执行。</div>'}
    <div class="pagination"><span>已载入 ${data.items.length} / ${data.total} 条 · 导出仅含已载入页</span>${data.next_cursor ? button(state.loading ? '读取中…' : '加载更多步骤', `data-perf-more="${esc(runId)}" ${state.loading ? 'disabled' : ''}`) : ''}</div>
    <details class="perf-sessions"><summary>执行会话与采集完整度（${data.sessions.length}）</summary><div class="table-scroll"><table><thead><tr><th>执行 / 会话</th><th>worker / 版本</th><th>结束 / 完整</th><th>产生 / 接收 / 丢弃</th><th>写入错误 / 最近写入</th><th>保留期清理凭据</th></tr></thead><tbody>${data.sessions.map(item => `<tr><td>${esc(item.run_execution_id)}<small>${esc(item.session_id)}</small></td><td>${esc(item.worker_instance_id ?? '未记录')}<small>${esc(item.release_sha ?? '未记录')}</small></td><td>${item.closed ? '已关闭' : '未关闭'} / ${item.complete ? '完整' : '不完整'}</td><td>${item.generated} / ${item.acknowledged} / ${item.dropped}</td><td>${item.flush_errors}<small>${esc(time(item.last_flush_at))}</small></td><td>${item.purged_span_count} 个步骤<small>${item.purged_at?esc(time(item.purged_at)):'未清理'}</small><small>${esc(item.purge_reason??'')} ${esc(item.purge_policy_version??'')}</small></td></tr>`).join('')}</tbody></table></div></details>
  </section>`;
}
