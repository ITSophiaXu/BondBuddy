import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schemas } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';
import { Problem, publicProblem } from './data.js';

test('upload inspection exposes only bounded public detail and a correlation id', () => {
  const externalLink = publicProblem(new Problem(422, 'MATERIAL_UNREADABLE',
    'File inspection failed', 'structure_invalid', 'external_link_invalid'), 'synthetic-request');
  assert.equal(Value.Check(schemas.Error, externalLink), true);
  assert.deepEqual(externalLink.field_errors, [{
    field: 'material_upload', code: 'external_link_invalid', message: 'File inspection was not completed',
  }]);
  assert.equal(externalLink.correlation_id, 'synthetic-request');
  assert.equal(externalLink.retryable, false);

  const unsupportedDetail = publicProblem(new Problem(422, 'MATERIAL_UNREADABLE',
    'File inspection failed', 'structure_invalid', 'xml_parse_error'), 'synthetic-request-2');
  assert.equal(Value.Check(schemas.Error, unsupportedDetail), true);
  assert.equal(unsupportedDetail.field_errors[0]?.code, 'structure_invalid');
  assert.doesNotMatch(JSON.stringify(unsupportedDetail), /xml_parse_error/);
});

test('inspection service failure is retryable without claiming damage; non-upload errors keep empty detail', () => {
  const timeout = publicProblem(new Problem(422, 'MATERIAL_UNREADABLE',
    'File inspection timed out', 'inspection_timeout'), 'synthetic-timeout');
  assert.equal(timeout.retryable, true);
  assert.equal(timeout.field_errors[0]?.code, 'inspection_timeout');
  const unrelated = publicProblem(new Problem(409, 'INPUT_REQUIRED', 'Input is incomplete'), 'synthetic-input');
  assert.deepEqual(unrelated.field_errors, []);
  assert.equal(unrelated.retryable, false);
  assert.equal(Value.Check(schemas.Error, unrelated), true);
  const queue = publicProblem(new Problem(503, 'DATA_UNAVAILABLE',
    'Material inspection capacity is temporarily busy', 'inspection_queue_timeout'), 'synthetic-queue');
  assert.equal(queue.retryable, true);
  assert.equal(queue.field_errors[0]?.code, 'inspection_queue_timeout');
  assert.equal(queue.message, 'Material inspection was not completed');
});
