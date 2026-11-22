import test from 'node:test';
import assert from 'node:assert/strict';
import { inputManifestHash as hash } from '@bondbuddy/api/production-rule-pin';
import {
  PerformanceTraceRuntime,
  type PerformanceSpanRecord,
} from '@bondbuddy/api/performance-trace';
import { prepareProgressiveGroup } from './workpaper-progressive-groups.js';
import type { StageContext } from './run-pipeline.js';

function fixture(waitReads = 0, batchState = 'running') {
  const group = {
    id: 'a'.repeat(64),
    manifests: ['author', 'consumer'].map((id) => ({ input: { workpaper: { entry: { id } } } })),
  };
  const source = { source: { sha256: 'b'.repeat(64) } },
    method = 'c'.repeat(64),
    batchIdentity = 'd'.repeat(64);
  const receipt = {
    version: 'workpaper-progressive-group-result-v1',
    status: 'items',
    items: [{ item_id: 'consumer', plan_hash: 'e'.repeat(64) }],
  };
  const saved = {
    input_hash: hash({
      version: 'workpaper-progressive-group-v1',
      batch_identity: batchIdentity,
      group_id: group.id,
      manifests: group.manifests,
    }),
    method_hash: method,
    source_hash: hash(source),
    receipt,
    receipt_hash: hash(receipt),
    author_run_id: 'producer-run',
  };
  let reads = 0,
    modelCalls = 0;
  const controller = new AbortController();
  const ctx = {
    run: { id: 'consumer-run', owner_user_id: 'owner' },
    signal: controller.signal,
    pool: {
      query: async (sql: string) => {
        if (sql.startsWith('SELECT * FROM bb_workpaper_progressive_groups'))
          return { rows: reads++ < waitReads ? [] : [saved] };
        if (sql.includes('AS batch_state'))
          return {
            rows: [
              {
                batch_state: batchState,
                run_state: 'running',
                run_id: 'producer-run',
                settled_terminal: false,
              },
            ],
          };
        throw Error('UNEXPECTED_QUERY');
      },
    },
  } as unknown as StageContext;
  const options = {
    batch: 'batch',
    itemId: 'consumer',
    group,
    batchIdentity,
    method,
    source,
    dir: 'unused',
    input: {},
    skill: { content: '' },
    config: {},
    model: () => {
      modelCalls++;
      assert.fail('a consumer never buys a group model call');
    },
    prepare: async () => {},
    validPlan: () => true,
    itemError: () => false,
  } as unknown as Parameters<typeof prepareProgressiveGroup>[1];
  const spans = new Map<string, PerformanceSpanRecord>();
  const runtime = new PerformanceTraceRuntime(async (_sessions, batch) => {
    for (const span of batch) spans.set(span.span_id, span);
  });
  const run = () =>
    runtime.trace({ ownerUserId: 'owner', projectId: 'project', runId: 'consumer-run' }, () =>
      prepareProgressiveGroup(ctx, options),
    );
  return { run, spans, runtime, controller, modelCalls: () => modelCalls };
}

test('group consumers record one wait across polling, then link actual producer reuse', async () => {
  const f = fixture(3);
  assert.deepEqual(await f.run(), { kind: 'ready', planHash: 'e'.repeat(64) });
  await f.runtime.drain();
  const waits = [...f.spans.values()].filter((s) => s.step_key === 'group.wait');
  const reuses = [...f.spans.values()].filter((s) => s.step_key === 'group.reuse');
  assert.equal(waits.length, 1);
  assert.equal(waits[0].status, 'succeeded');
  assert.ok(waits[0].duration_ms! >= 250);
  assert.equal(reuses.length, 1);
  assert.equal(reuses[0].status, 'reused');
  const attributes = reuses[0].attributes as Record<string, unknown>;
  assert.equal(attributes.author_run_id, 'producer-run');
  assert.equal(attributes.logical_call_id, 'workpaper-group-' + 'a'.repeat(40));
  assert.deepEqual(reuses[0].span_links, []);
  assert.equal(f.modelCalls(), 0);
});

test('an already accepted group records reuse without inventing a wait', async () => {
  const f = fixture();
  assert.equal((await f.run()).kind, 'ready');
  await f.runtime.drain();
  assert.equal([...f.spans.values()].filter((s) => s.step_key === 'group.wait').length, 0);
  assert.equal([...f.spans.values()].filter((s) => s.step_key === 'group.reuse').length, 1);
  assert.equal(f.modelCalls(), 0);
});

test('a paused producer keeps the consumer paused and finalizes its single wait', async () => {
  const f = fixture(1, 'paused');
  const result = await f.run();
  await f.runtime.drain();
  assert.equal(result.kind, 'outcome');
  if (result.kind === 'outcome') assert.equal(result.outcome.kind, 'pause');
  const waits = [...f.spans.values()].filter((s) => s.step_key === 'group.wait');
  assert.equal(waits.length, 1);
  assert.equal(waits[0].status, 'paused');
  assert.equal(f.modelCalls(), 0);
});

test('cancelling a consumer finalizes wait without changing the abort or calling a model', async () => {
  const f = fixture(1000);
  const task = f.run();
  const timer = setTimeout(() => f.controller.abort(), 30);
  try {
    await assert.rejects(task, { name: 'AbortError' });
  } finally {
    clearTimeout(timer);
  }
  await f.runtime.drain();
  const waits = [...f.spans.values()].filter((s) => s.step_key === 'group.wait');
  assert.equal(waits.length, 1);
  assert.equal(waits[0].status, 'cancelled');
  assert.equal(f.modelCalls(), 0);
});
