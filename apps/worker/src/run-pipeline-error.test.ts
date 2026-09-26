import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeRunError } from './run-pipeline.js';

test('unexpected run errors retain diagnostic identifiers without logging input text', () => {
  const databaseError = Object.assign(new Error('relation "bb_missing_table" does not exist'), { code: '42P01' });
  assert.deepEqual(safeRunError(databaseError, 'input_lock'), {
    stage: 'input_lock', name: 'Error', message: 'relation "bb_missing_table" does not exist', code: '42P01',
  });
  const sensitiveError = new Error('Synthetic material text and prompt should stay private');
  assert.deepEqual(safeRunError(sensitiveError, 'model_generation'), {
    stage: 'model_generation', name: 'Error', message: 'redacted', code: null,
  });
});
