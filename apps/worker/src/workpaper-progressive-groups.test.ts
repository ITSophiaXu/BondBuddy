import test from 'node:test';
import assert from 'node:assert/strict';
import { Value } from '@sinclair/typebox/value';
import type { M4DocumentManifest, WorkpaperProgressive } from '@bondbuddy/contracts';
import {
  progressivePlanGroup,
  WorkpaperProgressiveGroupResultSchema,
} from './workpaper-progressive-groups.js';

const ids = Array.from({ length: 20 }, (_, i) => 'item-' + i);
const manifests = ids.map(
  (id) => ({ input: { workpaper: { entry: { id } } } }) as M4DocumentManifest,
);
const plan: WorkpaperProgressive = {
  phase: 'remaining',
  chapters: [
    { id: 'one', title: '第一章', item_ids: ids.slice(0, 11) },
    { id: 'two', title: '第二章', item_ids: ids.slice(11) },
  ],
  trial_item_ids: [ids[0]!, ids[11]!],
  max_parallel: 2,
};
test('bounded plans respect confirmation, immutable chapter boundaries and trial membership', () => {
  assert.equal(progressivePlanGroup(manifests, { ...plan, phase: 'trial' }, ids[1]!), null);
  assert.equal(
    progressivePlanGroup(manifests, { ...plan, phase: 'awaiting_confirmation' }, ids[1]!),
    null,
  );
  assert.equal(progressivePlanGroup(manifests, plan, ids[0]!), null);
  const first = progressivePlanGroup(manifests, plan, ids[1]!)!;
  assert.deepEqual(
    first.manifests.map((m) => m.input.workpaper!.entry.id),
    ids.slice(1, 9),
  );
  assert.equal(progressivePlanGroup(manifests, plan, ids[8]!)!.id, first.id);
  assert.deepEqual(
    progressivePlanGroup(manifests, plan, ids[9]!)!.manifests.map(
      (m) => m.input.workpaper!.entry.id,
    ),
    ids.slice(9, 11),
  );
  assert.deepEqual(
    progressivePlanGroup(manifests, plan, ids[12]!)!.manifests.map(
      (m) => m.input.workpaper!.entry.id,
    ),
    ids.slice(12),
  );
  assert.equal(
    progressivePlanGroup(manifests, { ...plan, phase: 'retry_failed' }, ids[3]!)!.id,
    first.id,
  );
  assert.throws(
    () => progressivePlanGroup(manifests.slice(0, 3), plan, ids[1]!),
    /INPUT_REVISION_CONFLICT/,
  );
});
test('a group fallback is an explicit typed disposition with no accepted content', () => {
  const fallback = {
    version: 'workpaper-progressive-group-result-v1',
    status: 'fallback',
    items: [],
  };
  assert.equal(Value.Check(WorkpaperProgressiveGroupResultSchema, fallback), true);
  assert.equal(
    Value.Check(WorkpaperProgressiveGroupResultSchema, {
      ...fallback,
      items: [{ item_id: 'x', error: 'WORKPAPER_PLAN_INVALID' }],
    }),
    false,
  );
  assert.equal(
    Value.Check(WorkpaperProgressiveGroupResultSchema, { ...fallback, status: 'items' }),
    false,
  );
});
