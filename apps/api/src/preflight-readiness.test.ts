import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPreflightReadiness } from './preflight-readiness.js';

test('a test grant makes selected review gaps advisory for submission', () => {
  const missing = ['rule_pack:rule_applicability_reference_missing'];
  assert.deepEqual(classifyPreflightReadiness(missing, ['source_profile_needs_confirmation:history:1'], true), {
    status: 'needs_confirmation', blockingInputs: [], advisoryInputs: missing,
  });
  assert.deepEqual(classifyPreflightReadiness(missing, [], false), {
    status: 'blocked', blockingInputs: missing, advisoryInputs: [],
  });
  const unreviewedIdentity=['rule_pack:issuer_identity_not_bound',
    'issuer_identity_not_bound:issuer_identity_source_missing_unreviewed_or_conflicting'];
  assert.deepEqual(classifyPreflightReadiness(unreviewedIdentity, ['update_difficulty_needs_confirmation'], true), {
    status:'needs_confirmation',blockingInputs:[],advisoryInputs:unreviewedIdentity,
  });
  assert.deepEqual(classifyPreflightReadiness(['update_difficulty_pending:target_confirmation_required'],[],true),{
    status:'needs_confirmation',blockingInputs:[],advisoryInputs:['update_difficulty_pending:target_confirmation_required'],
  });
});

test('missing bytes, stale identity and corrupted pins remain blocking in a test channel', () => {
  const hard = ['material_parse_failed:history:1:UNREADABLE', 'issuer_identity_stale:history:1',
    'rule_pack:input_manifest_hash_mismatch', 'update_difficulty_pending:financial_materials_required'];
  const missing = ['rule_pack:production_rule_pack_registry_empty', ...hard];
  assert.deepEqual(classifyPreflightReadiness(missing, [], true), {
    status: 'blocked', blockingInputs: hard, advisoryInputs: [missing[0]],
  });
});
