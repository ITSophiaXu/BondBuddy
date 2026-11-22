import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelProcessPerformance, withModelStagePerformance } from './model-performance.js';
import {
  PerformanceTraceRuntime,
  type PerformanceSpanHandle,
  type PerformanceSpanRecord,
} from '@bondbuddy/api/performance-trace';

function fixture() {
  let clock = 0;
  const records: { key: string; attributes: Record<string, unknown>; status?: string }[] = [];
  const startSpan = (
    key: string,
    attributes: Readonly<Record<string, unknown>> = {},
  ): PerformanceSpanHandle => {
    const record = { key, attributes: { ...attributes }, status: undefined as string | undefined };
    records.push(record);
    return {
      spanId: `span-${records.length}`,
      annotate: (attrs) => Object.assign(record.attributes, attrs),
      end: (status, attrs) => {
        assert.equal(record.status, undefined, 'a span is finalized once');
        record.status = status;
        Object.assign(record.attributes, attrs);
      },
    };
  };
  const exec = startSpan('model.exec');
  const observer = createModelProcessPerformance(exec, { now: () => clock, startSpan });
  const at = (time: number) => {
    clock = time;
  };
  const event = (type: string, id: string, extra: Record<string, unknown> = {}) =>
    observer.activity({ type, item: { id, type: 'command_execution', ...extra } });
  return { observer, records, at, event };
}

test('CLI observation metrics distinguish first output from unknown TTFT and parallel tool wall time', () => {
  const f = fixture();
  f.at(2);
  f.observer.stdout();
  f.at(3);
  f.observer.jsonEvent();
  f.at(7);
  f.observer.activity({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'PRIVATE_ANSWER' },
  });
  f.at(10);
  f.event('item.started', 'one', {
    command: 'PRIVATE_COMMAND',
    aggregated_output: 'PRIVATE_OUTPUT',
  });
  f.at(12);
  f.event('item.started', 'two');
  f.at(20);
  f.event('item.completed', 'one', { status: 'completed', exit_code: 0 });
  f.at(25);
  f.event('item.completed', 'two', { status: 'failed', exit_code: 1 });
  f.at(30);
  f.observer.finish('succeeded');
  f.observer.finish('failed');
  const summary = f.records[0].attributes;
  assert.equal(summary.first_stdout_ms, 2);
  assert.equal(summary.first_event_ms, 3);
  assert.equal(summary.first_agent_message_observed_ms, 7);
  assert.equal(summary.ttft_ms, null);
  assert.equal(summary.ttft_availability, 'not_exposed');
  assert.equal(summary.tool_duration_sum_ms, 23);
  assert.equal(summary.tool_busy_union_ms, 15);
  assert.equal(summary.tool_timing_complete, true);
  assert.deepEqual(
    f.records.slice(1).map((r) => r.status),
    ['succeeded', 'failed'],
  );
  assert.equal(JSON.stringify(f.records).includes('PRIVATE_'), false);
});

test('missing tool boundaries stay incomplete and never become fabricated zero-duration tools', () => {
  const f = fixture();
  f.at(4);
  f.event('item.completed', 'missing-start');
  f.at(5);
  f.event('item.completed', 'missing-start');
  f.at(10);
  f.event('item.started', 'missing-end');
  f.at(11);
  f.event('item.started', 'missing-end');
  f.at(20);
  f.observer.finish('cancelled');
  assert.equal(f.records.length, 2);
  assert.equal(f.records[1].status, 'interrupted');
  assert.equal(f.records[1].attributes.timing_complete, false);
  assert.equal(f.records[1].attributes.end_missing, true);
  const summary = f.records[0].attributes;
  assert.equal(summary.tool_missing_start_count, 1);
  assert.equal(summary.tool_missing_end_count, 1);
  assert.equal(summary.tool_busy_union_ms, null);
  assert.equal(summary.tool_duration_sum_ms, null);
  assert.equal(summary.first_stdout_ms, null);
  assert.equal(summary.first_event_ms, null);
  assert.equal(summary.first_agent_message_observed_ms, null);
});

test('tool tracking is bounded and excludes text items and raw identifiers', () => {
  const f = fixture();
  for (let i = 0; i < 140; i++) {
    f.event('item.started', `private-${i}`);
    f.event('item.completed', `private-${i}`);
  }
  f.observer.activity({
    type: 'item.started',
    item: { id: 'private-reason', type: 'reasoning', text: 'PRIVATE_REASONING' },
  });
  f.observer.finish('succeeded');
  assert.equal(f.records.length, 129);
  assert.ok(Number(f.records[0].attributes.tool_omitted_count) > 0);
  assert.equal(f.records[0].attributes.tool_timing_complete, false);
  assert.equal(f.records[0].attributes.tool_duration_sum_ms, null);
  assert.equal(JSON.stringify(f.records).includes('private-'), false);
  assert.equal(JSON.stringify(f.records).includes('PRIVATE_REASONING'), false);
});

test('no trace context avoids metric bookkeeping and preserves stage values', async () => {
  const observer = createModelProcessPerformance(
    { spanId: null, end() {}, annotate() {} },
    {
      now: () => assert.fail('no-op observer must not read the clock'),
      startSpan: () => assert.fail('no-op observer must not allocate a span'),
    },
  );
  observer.stdout();
  observer.jsonEvent();
  observer.activity({ type: 'item.started', item: { id: 'x', type: 'command_execution' } });
  observer.finish('succeeded');
  const failed = { kind: 'fail' as const, code: 'WORD_QUALITY_REJECTED' };
  assert.equal(await withModelStagePerformance('authoring.repair', {}, () => failed), failed);
});

test('business failures, pauses and stops retain their status while telemetry failure is isolated', async () => {
  const rows = new Map<string, PerformanceSpanRecord>();
  const runtime = new PerformanceTraceRuntime(async (_sessions, batch) => {
    for (const row of batch) rows.set(row.span_id, row);
  });
  await runtime.trace({ ownerUserId: 'owner', projectId: 'project', runId: 'run' }, async () => {
    await withModelStagePerformance('authoring.repair', { repair_round: 1 }, async () => ({
      kind: 'fail',
      code: 'WORD_QUALITY_REJECTED',
    }));
    await withModelStagePerformance('authoring.repair', { repair_round: 2 }, async () => ({
      kind: 'pause',
      stage: 'provider_reconcile',
      reason: 'provider_result_pending',
    }));
  });
  await runtime.drain();
  assert.deepEqual(
    [...rows.values()].filter((r) => r.step_key === 'authoring.repair').map((r) => r.status),
    ['failed', 'paused'],
  );
  const broken = new PerformanceTraceRuntime(async () => {
    throw Error('SYNTHETIC_LOG_STORE_FAILURE');
  });
  const answer = { kind: 'done' as const, value: 17 };
  assert.equal(
    await broken.trace({ ownerUserId: 'owner', projectId: 'project', runId: 'run' }, () =>
      withModelStagePerformance('authoring.repair', {}, () => answer),
    ),
    answer,
  );
  await broken.drain();
});
