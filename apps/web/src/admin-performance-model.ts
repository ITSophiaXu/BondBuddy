import type {AdminPerformanceRunResponse, AdminPerformanceSummaryResponse, PerformanceSpan} from '@bondbuddy/contracts';

export type Interval = readonly [number, number];
export type RunPerformanceData = Omit<AdminPerformanceRunResponse, 'items'> & {
  items: PerformanceSpan[];
  pages: {audit_id: string; captured_at: string; item_count: number}[];
  observedAt: Record<string, string>;
};
export const timestamp = (value: string | null): number | null => {
  const result = value === null ? NaN : Date.parse(value);
  return Number.isFinite(result) ? result : null;
};
export const knownDuration = (span: PerformanceSpan): number | null => span.ended_at !== null
  && span.status !== 'running' && span.attributes.timing_complete !== false
  && typeof span.duration_ms === 'number' && Number.isFinite(span.duration_ms) && span.duration_ms >= 0 ? span.duration_ms : null;

// These wrappers establish ancestry but do not explain what occupied their interval.
// Actual external boundaries such as model.exec (CLI spawn-close, including tools) remain measurable work.
export const performanceContainers = new Set(['run.execution', 'stage.execute', 'model.call', 'model.attempt',
  'authoring.repair', 'authoring.delivery.attempt', 'unified.read', 'unified.update', 'unified.outline', 'unified.draft',
  'unified.batch', 'unified.review_revision', 'historical.batch', 'group.plan_prepare', 'workpaper.plan_prepare']);

/** Parallel siblings cover the union of their clipped intervals, never their sum. */
export function intervalUnion(intervals: readonly Interval[], bounds?: Interval): number {
  const valid = intervals.map(([start, end]) => [bounds ? Math.max(start, bounds[0]) : start, bounds ? Math.min(end, bounds[1]) : end] as Interval)
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start).sort((a, b) => a[0] - b[0]);
  let total = 0, start: number | undefined, end = 0;
  for (const [nextStart, nextEnd] of valid) {
    if (start === undefined) { start = nextStart; end = nextEnd; }
    else if (nextStart <= end) end = Math.max(end, nextEnd);
    else { total += end - start; start = nextStart; end = nextEnd; }
  }
  return total + (start === undefined ? 0 : end - start);
}

export function spanInterval(span: PerformanceSpan, capturedAt: string, sessionClosed: boolean): Interval | null {
  const start = timestamp(span.started_at), ms = knownDuration(span);
  if (start === null) return null;
  if (ms !== null) return [start, start + ms];
  const end = span.status === 'running' && !sessionClosed ? timestamp(capturedAt) : timestamp(span.ended_at);
  return end !== null && end >= start ? [start, end] : null;
}

export function mergePerformancePage(previous: RunPerformanceData | undefined, next: AdminPerformanceRunResponse): RunPerformanceData {
  if (previous && (previous.run_id !== next.run_id || previous.trace_id !== next.trace_id || previous.snapshot_at !== next.snapshot_at)) throw Error('PERFORMANCE_PAGE_MISMATCH');
  if (next.next_cursor && previous?.next_cursor === next.next_cursor) throw Error('PERFORMANCE_CURSOR_NOT_ADVANCING');
  const items = new Map(previous?.items.map(span => [span.span_id, span]) ?? []);
  const observedAt = {...previous?.observedAt};
  for (const span of next.items) { items.set(span.span_id, span); observedAt[span.span_id] = next.captured_at; }
  const sessions = new Map(previous?.sessions.map(session => [session.session_id, session]) ?? []);
  for (const session of next.sessions) sessions.set(session.session_id, session);
  return {...next, items: [...items.values()], sessions: [...sessions.values()], observedAt,
    pages: [...previous?.pages ?? [], {audit_id: next.audit_id, captured_at: next.captured_at, item_count: next.items.length}]};
}

export function runPerformanceMetrics(data: RunPerformanceData) {
  const closed = new Map(data.sessions.map(session => [session.session_id, session.closed]));
  const spans = new Map(data.items.map(span => [span.span_id, span]));
  const children = new Map<string, PerformanceSpan[]>();
  for (const span of data.items) if (span.parent_span_id && spans.has(span.parent_span_id)) {
    const list = children.get(span.parent_span_id) ?? []; list.push(span); children.set(span.parent_span_id, list);
  }
  const completePages = data.next_cursor === null && data.items.length === data.total;
  const hasOrphans = data.items.some(span => span.parent_span_id !== null && !spans.has(span.parent_span_id));
  const allMeasured = data.items.every(span => knownDuration(span) !== null && span.attributes.tool_timing_complete !== false);
  const complete = completePages && data.coverage.complete && !hasOrphans && allMeasured;
  const intervals = new Map(data.items.map(span => [span.span_id, spanInterval(span, data.observedAt[span.span_id] ?? data.captured_at, closed.get(span.session_id) ?? true)]));
  const terminal = ['succeeded', 'failed', 'cancelled', 'rejected', 'test_completed'].includes(data.run.state);
  const runStart = timestamp(data.run.created_at), runEnd = timestamp(data.run.ended_at ?? (terminal ? null : data.captured_at));
  const runBounds: Interval | undefined = runStart !== null && runEnd !== null && runEnd >= runStart ? [runStart, runEnd] : undefined;
  const totalMs = runBounds ? runBounds[1] - runBounds[0] : null;
  const explained = data.items.filter(span => !performanceContainers.has(span.step_key) && knownDuration(span) !== null)
    .map(span => intervals.get(span.span_id)).filter((value): value is Interval => value != null);
  const coveredMs = intervalUnion(explained, runBounds);
  const unexplainedMs = complete && totalMs !== null ? Math.max(0, totalMs - coveredMs) : null;
  const row = (span: PerformanceSpan) => {
    const range = intervals.get(span.span_id) ?? null, direct = children.get(span.span_id) ?? [];
    const childRanges = direct.map(child => intervals.get(child.span_id)).filter((value): value is Interval => value != null);
    const childUnionMs = range ? intervalUnion(childRanges, range) : null;
    const ms = knownDuration(span), open = span.status === 'running' && !(closed.get(span.session_id) ?? true);
    const elapsedMs = ms ?? (open && range ? range[1] - range[0] : null);
    const rowComplete = complete && ms !== null && direct.every(child => knownDuration(child) !== null);
    return {range, ms, elapsedMs, open, childUnionMs, childCount: direct.length,
      unexplainedMs: rowComplete && childUnionMs !== null ? Math.max(0, ms! - childUnionMs) : null,
      complete: rowComplete, missingParent: Boolean(span.parent_span_id && !spans.has(span.parent_span_id))};
  };
  const allRanges = [...intervals.values()].filter((value): value is Interval => value !== null);
  const chartStart = runBounds?.[0] ?? allRanges.reduce((min, range) => Math.min(min, range[0]), allRanges[0]?.[0] ?? 0);
  const chartEnd = Math.max(chartStart + 1, runBounds?.[1] ?? allRanges.reduce((max, range) => Math.max(max, range[1]), chartStart + 1));
  return {children, row, completePages, complete, hasOrphans, totalMs, coveredMs, unexplainedMs, open: !terminal,
    chartStart, chartEnd, failed: data.items.filter(span => span.status === 'failed').length,
    missing: data.items.filter(span => knownDuration(span) === null || span.attributes.tool_timing_complete === false).length};
}

/** Parents may arrive on a later page. Cycles and orphans remain visible rather than dropping records. */
export function performanceTree(items: PerformanceSpan[], collapsed: ReadonlySet<string> = new Set()) {
  const byId = new Map(items.map(span => [span.span_id, span])), visited = new Set<string>();
  const ordered = [...items].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at) || a.span_id.localeCompare(b.span_id));
  const children = new Map<string, PerformanceSpan[]>();
  for (const span of ordered) if (span.parent_span_id && byId.has(span.parent_span_id)) {
    const list = children.get(span.parent_span_id) ?? []; list.push(span); children.set(span.parent_span_id, list);
  }
  const rows: {span: PerformanceSpan; depth: number; hidden: boolean}[] = [];
  function walk(span: PerformanceSpan, depth: number, hidden: boolean) {
    if (visited.has(span.span_id)) return;
    visited.add(span.span_id); rows.push({span, depth, hidden});
    if (depth < 64) for (const child of children.get(span.span_id) ?? []) walk(child, depth + 1, hidden || collapsed.has(span.span_id));
  }
  for (const span of ordered) if (!span.parent_span_id || !byId.has(span.parent_span_id)) walk(span, 0, false);
  for (const span of ordered) if (!visited.has(span.span_id)) walk(span, 0, false);
  return rows.filter(row => !row.hidden);
}

export function csvCell(value: unknown): string {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // A CSV is opened in spreadsheets by operators; text fields must not become formulas.
  if (typeof value === 'string' && (/^\s*[=+@-]/.test(text) || /^[\t\r\n]/.test(text))) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function csvRows(rows: Record<string, unknown>[], columns: string[]): string {
  return '\ufeff' + [columns.map(csvCell).join(','), ...rows.map(row => columns.map(key => csvCell(row[key])).join(','))].join('\r\n') + '\r\n';
}
export function summaryCsv(data: AdminPerformanceSummaryResponse): string {
  const metadata = {captured_at: data.captured_at, audit_id: data.audit_id, full_filtered_scope: true, filters: data.scope, coverage: data.coverage};
  const columns = ['captured_at', 'audit_id', 'full_filtered_scope', 'filters', 'coverage', 'task_kind', 'stage', 'step_key', 'step_version', 'model_provider', 'model_id', 'release_sha', 'run_state', 'span_status', 'span_count', 'run_count', 'completed_count', 'timed_count', 'running_count', 'failed_count', 'missing_duration_count', 'mean_ms', 'p50_ms', 'p90_ms', 'p95_ms', 'max_ms'];
  return csvRows(data.items.length ? data.items.map(item => ({...metadata, ...item})) : [metadata], columns);
}
export function runCsv(data: RunPerformanceData): string {
  const metrics = runPerformanceMetrics(data);
  const metadata = {run_id: data.run_id, captured_at: data.captured_at, audit_id: data.audit_id, export_scope: 'loaded_pages_only', loaded_count: data.items.length, total_count: data.total, all_pages_loaded: metrics.completePages, page_reads: data.pages, coverage: data.coverage};
  const columns = ['run_id', 'captured_at', 'audit_id', 'export_scope', 'loaded_count', 'total_count', 'all_pages_loaded', 'page_reads', 'coverage', 'span_id', 'parent_span_id', 'session_id', 'run_execution_id', 'job_id', 'stage', 'step_key', 'step_version', 'status', 'started_at', 'ended_at', 'duration_ms', 'elapsed_ms', 'child_union_ms', 'unexplained_ms', 'clock_source', 'observed_at', 'attributes', 'span_links'];
  return csvRows(data.items.length ? data.items.map(span => { const row = metrics.row(span); return {...metadata, ...span, elapsed_ms: row.elapsedMs, child_union_ms: row.childUnionMs, unexplained_ms: row.unexplainedMs, observed_at: data.observedAt[span.span_id]}; }) : [metadata], columns);
}
