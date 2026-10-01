import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPreflightReadiness } from './preflight-readiness.js';

test('all business gaps are advisory with or without a working-draft grant', () => {
  const missing = ['target_market_offering_required', 'reporting_cutoff_required',
    'rule_pack:rule_applicability_reference_missing', 'user_reference_needs_review:needs_review',
    'material_parse_pending:history:1', 'update_difficulty_pending:financial_materials_required'];
  for (const channel of [true, false]) assert.deepEqual(classifyPreflightReadiness(missing, [], channel), {
    status: 'needs_confirmation', blockingInputs: [], advisoryInputs: missing,
  });
});

test('execution capability stays truthful; an empty diagnostic is ready', () => {
  assert.deepEqual(classifyPreflightReadiness(['execution_capability_not_ready', 'reporting_cutoff_required'], [], true), {
    status: 'blocked', blockingInputs: ['execution_capability_not_ready'], advisoryInputs: ['reporting_cutoff_required'],
  });
  assert.equal(classifyPreflightReadiness([], [], false).status, 'ready');
});
