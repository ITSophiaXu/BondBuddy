import type {AdminPerformanceSummaryResponse} from '@bondbuddy/contracts';
import {ApiError} from './api.js';
import {AdminPerformanceApi, emptyPerformanceFilters, performanceFilterNames, type PerformanceFilters} from './admin-performance-api.js';
import {mergePerformancePage, runCsv, summaryCsv, type RunPerformanceData} from './admin-performance-model.js';
import {performanceRunPanel, performanceSummaryPanel, type PerformanceReadState} from './admin-performance-render.js';

const emptyRead = <T>(): PerformanceReadState<T> => ({loading: false, error: ''});
const readError = (error: unknown) => error instanceof ApiError && [403, 404].includes(error.status)
  ? '无权读取此性能记录，或当前环境尚未提供该接口。' : error instanceof ApiError && error.status === 401
    ? '登录已失效，请重新登录。' : '性能数据读取失败，请重试；不会用任务快照代替全量统计。';

export class AdminPerformanceController {
  private summary = emptyRead<AdminPerformanceSummaryResponse>();
  private draft = emptyPerformanceFilters();
  private advanced = false;
  private runs = new Map<string, PerformanceReadState<RunPerformanceData>>();
  private runVersions = new Map<string, number>();
  private collapsed = new Map<string, Set<string>>();
  private expanded = new Map<string, Set<string>>();
  private activeRun = '';
  private epoch = 0;
  private summaryVersion = 0;

  constructor(private readonly api: AdminPerformanceApi, private readonly changed: () => void) {}

  reset(): void {
    this.epoch++; this.summaryVersion++; this.summary = emptyRead(); this.draft = emptyPerformanceFilters();
    this.runs.clear(); this.runVersions.clear(); this.collapsed.clear(); this.expanded.clear(); this.activeRun = ''; this.advanced = false;
  }
  renderSummary(): string { return performanceSummaryPanel(this.summary, this.draft, this.advanced); }
  renderRun(id: string): string {
    this.activeRun = id;
    return performanceRunPanel(id, this.runs.get(id) ?? emptyRead(), this.collapsed.get(id) ?? new Set(), this.expanded.get(id) ?? new Set());
  }

  async loadRun(id: string, mode: 'initial' | 'refresh' | 'more' = 'initial'): Promise<void> {
    const state = this.runs.get(id) ?? emptyRead<RunPerformanceData>();
    if (state.loading || mode === 'initial' && state.data || mode === 'more' && !state.data?.next_cursor) return;
    const epoch = this.epoch, version = (this.runVersions.get(id) ?? 0) + 1;
    this.runVersions.set(id, version); state.loading = true; state.error = ''; this.runs.set(id, state); this.changed();
    try {
      const page = await this.api.run(id, mode === 'more' ? state.data?.next_cursor ?? undefined : undefined);
      if (epoch !== this.epoch || version !== this.runVersions.get(id)) return;
      state.data = mergePerformancePage(mode === 'more' ? state.data : undefined, page);
    } catch (error) {
      if (epoch !== this.epoch || version !== this.runVersions.get(id)) return;
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) state.data = undefined;
      state.error = readError(error);
    } finally { if (epoch === this.epoch && version === this.runVersions.get(id)) { state.loading = false; this.changed(); } }
  }

  private remember(form: HTMLFormElement): void {
    const values = new FormData(form);
    for (const name of performanceFilterNames) this.draft[name] = String(values.get(name) ?? '');
  }
  private async query(): Promise<void> {
    const version = ++this.summaryVersion, epoch = this.epoch, filters: PerformanceFilters = {...this.draft};
    this.summary.loading = true; this.summary.error = ''; this.changed();
    try {
      if (filters.from && filters.to && filters.from > filters.to) throw new RangeError('invalid range');
      const data = await this.api.summary(filters);
      if (version !== this.summaryVersion || epoch !== this.epoch) return;
      this.summary.data = data;
    } catch (error) {
      if (version !== this.summaryVersion || epoch !== this.epoch) return;
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) this.summary.data = undefined;
      this.summary.error = error instanceof RangeError ? '提交起日不能晚于止日，请调整日期。' : readError(error);
    } finally { if (version === this.summaryVersion && epoch === this.epoch) { this.summary.loading = false; this.changed(); } }
  }

  private export(kind: string): void {
    const summary = this.summary.data, run = this.runs.get(this.activeRun)?.data;
    if (kind.startsWith('summary-') && !summary || kind.startsWith('run-') && !run) return;
    const csv = kind.endsWith('-csv');
    const body = kind.startsWith('summary-') ? csv ? summaryCsv(summary!) : JSON.stringify({...summary!, export_scope: 'full_filtered_server_groups'}, null, 2)
      : csv ? runCsv(run!) : JSON.stringify({...run!, export_scope: 'loaded_pages_only', loaded_count: run!.items.length}, null, 2);
    const blob = new Blob([body], {type: csv ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8'});
    const href = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = href; link.download = `performance-${kind.startsWith('summary-') ? 'summary' : 'run-' + this.activeRun}.${csv ? 'csv' : 'json'}`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  bind(root: HTMLElement): void {
    const form = root.querySelector<HTMLFormElement>('[data-perf-filters]');
    form?.addEventListener('input', () => this.remember(form)); form?.addEventListener('change', () => this.remember(form));
    form?.addEventListener('submit', event => { event.preventDefault(); this.remember(form); void this.query(); });
    root.querySelector<HTMLDetailsElement>('[data-perf-advanced]')?.addEventListener('toggle', event => { this.advanced = (event.currentTarget as HTMLDetailsElement).open; });
    root.querySelector('[data-perf-reset]')?.addEventListener('click', () => { this.summaryVersion++; this.summary.loading = false; this.draft = emptyPerformanceFilters(); this.changed(); });
    root.querySelectorAll<HTMLElement>('[data-perf-run-refresh]').forEach(element => element.onclick = () => { void this.loadRun(element.dataset.perfRunRefresh!, 'refresh'); });
    root.querySelectorAll<HTMLElement>('[data-perf-more]').forEach(element => element.onclick = () => { void this.loadRun(element.dataset.perfMore!, 'more'); });
    root.querySelectorAll<HTMLElement>('[data-perf-export]').forEach(element => element.onclick = () => this.export(element.dataset.perfExport!));
    for (const [attribute, store] of [['perfCollapse', this.collapsed], ['perfInspect', this.expanded]] as const) {
      const selector = attribute === 'perfCollapse' ? 'data-perf-collapse' : 'data-perf-inspect';
      root.querySelectorAll<HTMLElement>(`[${selector}]`).forEach(element => element.onclick = () => {
        const id = element.dataset[attribute]!, ids = store.get(this.activeRun) ?? new Set<string>();
        ids.has(id) ? ids.delete(id) : ids.add(id); store.set(this.activeRun, ids); this.changed();
        root.querySelector<HTMLElement>(`[${selector}="${CSS.escape(id)}"]`)?.focus({preventScroll: true});
      });
    }
  }
}
