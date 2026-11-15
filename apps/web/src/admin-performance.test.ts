import assert from 'node:assert/strict';
import test from 'node:test';
import type {AdminPerformanceRunResponse, AdminPerformanceSummaryResponse, PerformanceSpan} from '@bondbuddy/contracts';
import {AdminPerformanceApi, emptyPerformanceFilters, performanceQuery} from './admin-performance-api.js';
import {intervalUnion, mergePerformancePage, performanceTree, runPerformanceMetrics, csvCell, runCsv, summaryCsv} from './admin-performance-model.js';
import {performanceRunPanel, performanceSummaryPanel} from './admin-performance-render.js';
import {AdminPerformanceController} from './admin-performance.js';

const at = (ms: number) => new Date(Date.parse('2026-11-15T00:00:00Z') + ms).toISOString();
function span(id: string, start: number, end: number, parent: string | null = null, extra: Partial<PerformanceSpan> = {}): PerformanceSpan {
  return {span_id: id, parent_span_id: parent, session_id: 'session', run_execution_id: 'execution', trace_id: 'trace', run_id: 'run', job_id: 'job', stage: 'model_generation', step_key: id,
    step_version: 1, status: 'succeeded', started_at: at(start), ended_at: at(end), duration_ms: end - start, last_activity_at: at(end), clock_source: 'monotonic', attributes: {}, span_links: [], ...extra};
}
function page(items: PerformanceSpan[], extra: Partial<AdminPerformanceRunResponse> = {}): AdminPerformanceRunResponse {
  return {schema_version: 1, captured_at: at(15000), snapshot_at: at(15000), audit_id: 'audit', run_id: 'run', trace_id: 'trace',
    run: {created_at: at(0), state: 'succeeded', started_at: at(0), ended_at: at(12000)}, items, next_cursor: null, total: items.length,
    coverage: {run_count: 1, instrumented_run_count: 1, uninstrumented_run_count: 0, session_count: 1, complete_session_count: 1, purged_session_count: 0, purged_span_count: 0, span_count: items.length, unfinished_span_count: 0, dropped_spans: 0, invalid_attributes: 0, flush_errors: 0, complete: true},
    sessions: [{session_id: 'session', run_execution_id: 'execution', service_role: 'worker', worker_instance_id: 'worker', release_sha: 'abc123', started_at: at(0), ended_at: at(12000), last_flush_at: at(12000), closed: true, generated: items.length, acknowledged: items.length, dropped: 0, invalid_attributes: 0, flush_errors: 0, last_sequence: 1, complete: true, purged_at: null, purged_span_count: 0, purge_reason: null, purge_policy_version: null}], ...extra};
}
function summary(): AdminPerformanceSummaryResponse {
  return {schema_version: 1, captured_at: at(15000), audit_id: 'summary_audit', scope: {from: null, to: null, filters: {}, full_filtered_scope: true},
    coverage: {...page([]).coverage, run_count: 2501, instrumented_run_count: 2500, uninstrumented_run_count: 1, complete: false},
    items: [{task_kind: 'update', stage: 'model_generation', step_key: 'model.exec', step_version: 1, span_status: 'failed', model_provider: 'synthetic', model_id: 'synthetic_model', release_sha: 'abc123', run_state: 'failed', span_count: 2510, run_count: 2500, completed_count: 2510, timed_count: 2500, running_count: 0, failed_count: 2510, missing_duration_count: 10, mean_ms: 4000, p50_ms: 3000, p90_ms: 8000, p95_ms: 10000, max_ms: 12000}]};
}

test('parallel intervals use their clipped union including adjacent and nested ranges', () => {
  assert.equal(intervalUnion([[1000, 7000], [5000, 9000], [3000, 4000], [-1000, 0], [9000, 10000], [10, 5], [NaN, 4]], [0, 10000]), 9000);
  assert.equal(intervalUnion([]), 0);
});
test('parent unexplained time subtracts the direct-child union, not duration sum', () => {
  const data = mergePerformancePage(undefined, page([span('root', 0, 10000), span('a', 1000, 7000, 'root'), span('b', 5000, 9000, 'root')]));
  const metrics = runPerformanceMetrics(data), root = metrics.row(data.items[0]);
  assert.equal(root.childUnionMs, 8000); assert.equal(root.unexplainedMs, 2000);
  assert.equal(metrics.coveredMs, 10000); assert.equal(metrics.totalMs, 12000); assert.equal(metrics.unexplainedMs, 2000);
});
test('task and stage containers alone cannot explain the elapsed run', () => {
  const data = mergePerformancePage(undefined, page([span('execution', 0, 10000, null, {step_key: 'run.execution'}), span('stage', 0, 10000, 'execution', {step_key: 'stage.execute'})]));
  const metrics = runPerformanceMetrics(data);
  assert.equal(metrics.coveredMs, 0); assert.equal(metrics.unexplainedMs, 12000);
});
test('the measured CLI boundary explains elapsed work even when tool children exist', () => {
  const data = mergePerformancePage(undefined, page([span('exec', 0, 10000, null, {step_key: 'model.exec'}), span('tool', 1000, 2000, 'exec', {step_key: 'model.tool'})]));
  assert.equal(runPerformanceMetrics(data).coveredMs, 10000);
});
test('unloaded pages never turn a partial child union into definitive unexplained time', () => {
  const data = mergePerformancePage(undefined, page([span('root', 0, 10000), span('a', 1000, 7000, 'root')], {total: 3, next_cursor: 'next'}));
  const metrics = runPerformanceMetrics(data);
  assert.equal(metrics.row(data.items[0]).childUnionMs, 6000);
  assert.equal(metrics.row(data.items[0]).unexplainedMs, null); assert.equal(metrics.unexplainedMs, null);
  assert.match(performanceRunPanel('run', {data, loading: false, error: ''}, new Set(), new Set()), /分页尚未全部载入/);
});
test('a later page restores parent-child nesting without losing page observation times', () => {
  const first = mergePerformancePage(undefined, page([span('child', 1000, 7000, 'root')], {total: 2, next_cursor: 'next'}));
  assert.equal(runPerformanceMetrics(first).hasOrphans, true);
  const all = mergePerformancePage(first, page([span('root', 0, 10000)], {total: 2, captured_at: at(20000), audit_id: 'audit2'}));
  assert.deepEqual(performanceTree(all.items).map(row => [row.span.span_id, row.depth]), [['root', 0], ['child', 1]]);
  assert.equal(all.observedAt.child, at(15000)); assert.equal(all.observedAt.root, at(20000)); assert.equal(all.pages.length, 2);
  assert.deepEqual(performanceTree(all.items, new Set(['root'])).map(row => row.span.span_id), ['root']);
});
test('pagination rejects a changed run, snapshot window or repeated cursor', () => {
  const first = mergePerformancePage(undefined, page([span('root', 0, 1000)], {next_cursor: 'same', total: 2}));
  assert.throws(() => mergePerformancePage(first, page([], {run_id: 'other'})), /PAGE_MISMATCH/);
  assert.throws(() => mergePerformancePage(first, page([], {snapshot_at: at(20000)})), /PAGE_MISMATCH/);
  assert.throws(() => mergePerformancePage(first, page([], {next_cursor: 'same'})), /NOT_ADVANCING/);
});
test('cycles and orphans remain visible rather than being dropped or recursed forever', () => {
  const items = [span('a', 0, 1000, 'b'), span('b', 0, 1000, 'a'), span('orphan', 0, 1000, 'missing')];
  assert.equal(new Set(performanceTree(items).map(row => row.span.span_id)).size, 3);
  assert.equal(runPerformanceMetrics(mergePerformancePage(undefined, page(items))).unexplainedMs, null);
});
test('running elapsed uses its own page capture; a closed session cannot imply still running', () => {
  const p = page([span('live', 1000, 1000, null, {status: 'running', ended_at: null, duration_ms: null})], {run: {created_at: at(0), state: 'running', started_at: at(1000), ended_at: null}});
  p.sessions[0].closed = false; p.coverage.complete = false;
  const data = mergePerformancePage(undefined, p); data.captured_at = at(30000);
  assert.equal(runPerformanceMetrics(data).row(data.items[0]).elapsedMs, 14000);
  assert.equal(runPerformanceMetrics(data).totalMs, 30000);
  data.sessions[0].closed = true;
  assert.equal(runPerformanceMetrics(data).row(data.items[0]).elapsedMs, null);
});
test('failure and incomplete timing remain missing even with plausible wall timestamps', () => {
  for (const extra of [{duration_ms: null}, {duration_ms: 4000, attributes: {timing_complete: false}}]) {
    const data = mergePerformancePage(undefined, page([span('failed', 1000, 5000, null, {status: 'failed', ...extra})]));
    assert.equal(runPerformanceMetrics(data).row(data.items[0]).elapsedMs, null);
    assert.equal(runPerformanceMetrics(data).unexplainedMs, null);
    assert.match(performanceRunPanel('run', {data, loading: false, error: ''}, new Set(), new Set()), /耗时缺测/);
  }
});
test('known zero differs from missing timing; missing terminal evidence is not replaced by update time', () => {
  const data = mergePerformancePage(undefined, page([span('instant', 1000, 1000)], {run: {created_at: at(0), state: 'failed', started_at: at(0), ended_at: null}}));
  assert.equal(runPerformanceMetrics(data).row(data.items[0]).ms, 0); assert.equal(runPerformanceMetrics(data).totalMs, null);
});
test('collection failures prevent a false complete-coverage conclusion', () => {
  const p = page([span('root', 0, 10000)]); p.coverage.complete = false; p.coverage.dropped_spans = 2;
  const metrics = runPerformanceMetrics(mergePerformancePage(undefined, p));
  assert.equal(metrics.coveredMs, 10000); assert.equal(metrics.unexplainedMs, null);
});
test('summary keeps server percentiles and scope beyond 1000 runs without client reaggregation', () => {
  const data = summary(), html = performanceSummaryPanel({data, loading: false, error: ''}, emptyPerformanceFilters(), false);
  assert.match(html, /全部匹配 2501 次任务/); assert.match(html, /P90/); assert.match(html, /2500<\/strong> \/ 10/);
  assert.match(summaryCsv(data), /run_count"":2501/); assert.match(summaryCsv(data), /"p90_ms"/); assert.match(summaryCsv(data), /summary_audit/);
});
test('CSV protects spreadsheet formulas, preserves multiline text, and labels loaded-page exports', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"'); assert.equal(csvCell('  +cmd'), '"\'  +cmd"');
  assert.equal(csvCell('a\nb'), '"a\nb"'); assert.equal(csvCell(null), '""'); assert.equal(csvCell(0), '"0"');
  const data = mergePerformancePage(undefined, page([span('root', 0, 1000)], {total: 2, next_cursor: 'next'}));
  const csv = runCsv(data); assert.match(csv, /loaded_pages_only/); assert.match(csv, /audit/); assert.match(csv, /"all_pages_loaded"/);
});
test('date filters are explicit Beijing days and opaque cursor values are safely encoded', async () => {
  const filters = {...emptyPerformanceFilters(), from: '2026-11-15', to: '2026-11-16', task_kind: 'update'};
  const query = new URLSearchParams(performanceQuery(filters));
  assert.equal(query.get('from'), '2026-11-14T16:00:00.000Z'); assert.equal(query.get('to'), '2026-11-16T15:59:59.999Z');
  const paths: string[] = [];
  const api = new AdminPerformanceApi({request: async <T>(_method: string, path: string): Promise<T> => { paths.push(path); return page([]) as T; }});
  await api.run('run', 'opaque+/=&?');
  assert.equal(new URLSearchParams(paths[0].split('?')[1]).get('cursor'), 'opaque+/=&?'); assert.match(paths[0], /^\/admin\/performance\/runs\/run\?/);
});
test('the summary client refuses a truncated or malformed server scope without snapshot fallback', async () => {
  const paths: string[] = [], result = summary();
  const api = new AdminPerformanceApi({request: async <T>(_method: string, path: string): Promise<T> => { paths.push(path); return {...result, scope: {...result.scope, full_filtered_scope: false}} as T; }});
  await assert.rejects(api.summary(emptyPerformanceFilters()));
  assert.equal(paths.length, 1); assert.match(paths[0], /^\/admin\/performance\/summary/);
});
test('in-flight reads cannot repopulate performance data after logout resets the controller', async () => {
  let resolve!: (value: AdminPerformanceRunResponse) => void;
  const pending = new Promise<AdminPerformanceRunResponse>(done => { resolve = done; });
  const api = new AdminPerformanceApi({request: async <T>(): Promise<T> => await pending as T});
  const controller = new AdminPerformanceController(api, () => {}), reading = controller.loadRun('run');
  controller.reset(); resolve(page([span('private_step', 0, 1000)])); await reading;
  assert.doesNotMatch(controller.renderRun('run'), /private_step/);
});
