import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readExecutionStages, stampExecutionCheckpoint } from './run-execution.js';

const v1 = { executionVersion: 1, inputRevision: 7, inputHash: 'a'.repeat(64) };
const v2 = { executionVersion: 2, inputRevision: 8, inputHash: 'b'.repeat(64) };
const conflict = { status: 409, code: 'INPUT_REVISION_CONFLICT' };

test('legacy stages belong only to the resolved initial execution', () => {
  const legacy = { stages: { model_generation: { completed: true } } };
  assert.deepEqual(readExecutionStages(legacy, v1), legacy.stages);
  assert.throws(() => readExecutionStages(legacy, v2), conflict);
  assert.throws(() => stampExecutionCheckpoint(legacy, v2), conflict);
  assert.equal(Object.hasOwn(legacy, 'stage_execution'), false);
});

test('a stamped stage set is readable only for its full execution tuple', () => {
  const old = { stages: { model_generation_prompt: { snapshot_id: 'old-prompt' } }, provider_results: [{ call_id: 'old-call' }] };
  const stamped = stampExecutionCheckpoint(old, v1);
  assert.deepEqual(stamped.stage_execution, { execution_version: 1, input_revision: 7, input_hash: v1.inputHash });
  assert.deepEqual(readExecutionStages(stamped, v1), old.stages);
  for (const identity of [v2, { ...v1, inputRevision: 8 }, { ...v1, inputHash: v2.inputHash }]) {
    assert.throws(() => readExecutionStages(stamped, identity), conflict);
    assert.throws(() => stampExecutionCheckpoint(stamped, identity), conflict);
  }
  assert.deepEqual(stamped.provider_results, old.provider_results);
  assert.equal(Object.hasOwn(old, 'stage_execution'), false);
});

test('an explicitly scoped later set never borrows stages from another input', () => {
  // Pure format test only: production execution/database gates still reject V2.
  const later = { stage_execution: { execution_version: 2, input_revision: 8, input_hash: v2.inputHash },
    stages: { materials_ready: { adopted: true } }, provider_results: [{ call_id: 'old-call' }] };
  assert.deepEqual(readExecutionStages(later, v2), later.stages);
  assert.throws(() => readExecutionStages(later, v1), conflict);
});

test('malformed stamps and stages fail closed, including an explicit null stamp', () => {
  for (const checkpoint of [null, [], { stage_execution: null }, { stage_execution: {} },
    { stage_execution: { execution_version: 1, input_revision: 7, input_hash: 'wrong' } },
    { stages: [] }, { stages: { model_generation: null } }]) {
    assert.throws(() => readExecutionStages(checkpoint, v1), conflict);
  }
});
