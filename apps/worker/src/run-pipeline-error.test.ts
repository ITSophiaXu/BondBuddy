import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safePauseReason, safeRunError } from './run-pipeline.js';

test('pause reasons use a stable public machine code', () => {
  assert.equal(safePauseReason('rule_applicability_field_needs_review:market'), 'rule_applicability_field_needs_review');
  assert.equal(safePauseReason('rule_applicability_field_needs_review'), 'rule_applicability_field_needs_review');
  assert.equal(safePauseReason('Unsafe:market'), 'rule_applicability_needs_review');
  assert.equal(safePauseReason('a'.repeat(65) + ':market'), 'rule_applicability_needs_review');
});

test('unexpected run errors retain diagnostic identifiers without logging input text', () => {
  const databaseError = Object.assign(new Error('relation "bb_missing_table" does not exist'), { code: '42P01' });
  assert.deepEqual(safeRunError(databaseError, 'input_lock'), {
    stage: 'input_lock', name: 'Error', message: 'relation "bb_missing_table" does not exist', code: '42P01',
  });
  const sensitiveError = Object.assign(new Error('Synthetic material text, prompt and credential should stay private'),
    { name: 'SyntheticSecretName', code: 'SYNTHETIC_SECRET_CODE' });
  assert.deepEqual(safeRunError(sensitiveError, 'model_generation'), {
    stage: 'model_generation', name: 'UnknownError', message: 'redacted', code: null,
  });
});

test('host-helper failures map to a public terminal reason', () => {
  assert.equal(safeRunError(new Error('Command failed: python3 -m bondbuddy_file_authoring.fixed_edit'), 'model_generation').code,
    'CAPABILITY_NOT_READY');
  assert.equal(safeRunError(new Error('AUTHORING_FILE_SANDBOX_UNAVAILABLE'), 'model_generation').code, 'CAPABILITY_NOT_READY');
  assert.equal(safeRunError(new Error('INPUT_REVISION_CONFLICT'), 'model_generation').code, 'INPUT_REVISION_CONFLICT');
  assert.equal(safeRunError(Object.assign(new Error('sensitive'), { code: 'MODEL_ADAPTER_CONFIG_INVALID' }), 'model_generation').code,
    'MODEL_ADAPTER_CONFIG_INVALID');
});
