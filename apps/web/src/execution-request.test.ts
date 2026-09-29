import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executionRequest, executionTaskKind } from './execution-request.js';

const input = { project_id: 'synthetic-project', input_revision: 3, input_hash: 'a'.repeat(64) };

test('no-history projects submit the generation task kind; in-issuer history keeps update', async () => {
  const generation = await executionRequest(input, executionTaskKind('generation'));
  assert.equal(generation.task_kind, 'generation');
  assert.equal(generation.storage_origin, 'cloud');
  assert.equal(generation.input_manifest_ref, input.input_hash);
  assert.equal(generation.workspace_id, input.project_id);
  assert.match(generation.execution_request_id, /^web-generation-/);

  const update = await executionRequest(input, executionTaskKind('update'));
  assert.equal(update.task_kind, 'update');
  assert.match(update.execution_request_id, /^web-update-/);
  // Same locked input under a different task kind must not reuse the other path's idempotency key.
  assert.notEqual(update.execution_request_id, generation.execution_request_id);
  // Re-submitting the exact same locked input replays one identical request.
  assert.deepEqual(await executionRequest(input, 'update'), update);
});

test('review and qa projects never silently execute as generation', () => {
  assert.equal(executionTaskKind('review'), 'update');
  assert.equal(executionTaskKind('qa'), 'update');
  assert.equal(executionTaskKind('update'), 'update');
  assert.equal(executionTaskKind('generation'), 'generation');
});
