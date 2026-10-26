import assert from 'node:assert/strict';
import test from 'node:test';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { projectRunExecution, type RunExecutionIdentity } from '@bondbuddy/api/run-execution';
import type { RunRow, StageContext } from './run-pipeline.js';
import { SSE_PRIVATE_CANDIDATE_ASSET_PIN as pin } from './sse-private-candidate-assets.js';
import { loadAuthorizedHistoricalTestRuleGuidance } from './historical-test-rule-authorization.js';

function fixture(executionVersion: 1 | 2 = 1) {
  const manifest = { market: 'sse', offering: 'private', target_confirmation: { status: 'confirmed',
    confirmed_by: 'synthetic-owner', market: 'sse', offering: 'private', document_purpose: 'issuance', as_of: '2026-09-27' } };
  const grant = { user_id: 'synthetic-owner', project_id: 'synthetic-project', input_revision: executionVersion,
    input_hash: inputManifestHash(manifest), sample_manifest_sha256: 'a'.repeat(64),
    taxonomy_hash: pin.taxonomy.contentSha256, rule_pack_hash: pin.rulePack.contentSha256,
    expires_at: new Date(Date.now() + 3600000), revoked_at: null as Date | null };
  const input = { input_hash: grant.input_hash, draft_revision: 1, manifest, material_versions: [], rule_pack_version: null, template_version: null };
  let gates = 0, reads = 0;
  const execution: RunExecutionIdentity = { executionVersion, inputRevision: grant.input_revision, inputHash: grant.input_hash };
  const rawRun: RunRow = { id: 'synthetic-run', owner_user_id: grant.user_id, project_id: grant.project_id,
    input_revision: 1, input_hash: executionVersion === 1 ? grant.input_hash : 'f'.repeat(64),
    task_kind: 'update', channel: 'non_production_test', test_grant_id: 'synthetic-grant' };
  const activeGrantId = executionVersion === 1 ? 'synthetic-grant' : 'synthetic-successor-grant';
  const ctx = { run: projectRunExecution(rawRun, execution),
    pool: { query: async (sql: string, args: unknown[]) => {
      if (sql.includes('SELECT r.* FROM bb_runs r')) return { rows: [rawRun] };
      if (sql.includes('FROM bb_run_execution_versions e')) return { rows: [{ execution_version: execution.executionVersion,
        input_revision: execution.inputRevision, input_hash: execution.inputHash, channel: rawRun.channel,
        successor_authorization_id: executionVersion === 2 ? 'synthetic-successor-receipt' : null }] };
      if (sql.includes('FROM bb_run_test_successor_authorizations a')) return { rows: [{ id: 'synthetic-successor-receipt', test_grant_id: activeGrantId }] };
      assert.match(sql, /FROM bb_non_production_test_grants/); assert.deepEqual(args, [activeGrantId]);
      reads++; return { rows: [grant] };
    } },
    // These seams represent #17/#19's already-tested stage gate, not sample authorisation evidence.
    testRuleCapabilityLoader: async () => ({ status: 'ready', sampleManifestSha256: 'a'.repeat(64),
      taxonomyHash: pin.taxonomy.contentSha256, rulePackHash: pin.rulePack.contentSha256, uncoveredItems: [] }),
    validateBeforeModelCall: async () => { gates++; return null; },
  } as unknown as StageContext;
  const setRun = (patch: Partial<RunRow>) => {
    Object.assign(rawRun, patch);
    execution.inputRevision = rawRun.input_revision; execution.inputHash = rawRun.input_hash;
    ctx.run = projectRunExecution(rawRun, execution);
  };
  return { manifest, input, grant, ctx, setRun, gates: () => gates, reads: () => reads };
}

async function preprod(action: () => Promise<void>) {
  const previous = [process.env.BB_DEPLOYMENT_TIER, process.env.BB_NON_PRODUCTION_TEST_CHANNEL];
  process.env.BB_DEPLOYMENT_TIER = 'preprod'; process.env.BB_NON_PRODUCTION_TEST_CHANNEL = 'enabled';
  try { await action(); } finally {
    for (const [i, key] of ['BB_DEPLOYMENT_TIER', 'BB_NON_PRODUCTION_TEST_CHANNEL'].entries()) {
      if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
    }
  }
}

test('test reference rechecks the stage gate and exact grant on every recovery without a production pin', async () => preprod(async () => {
  const f = fixture();
  const g = await loadAuthorizedHistoricalTestRuleGuidance(f.ctx, f.input);
  assert.equal(g.authorization.grant_id, 'synthetic-grant');
  assert.equal(g.authorization.input_hash, f.ctx.run.input_hash);
  assert.equal(g.pack_hash, pin.rulePack.contentSha256); assert.equal(g.rules.length, 31);
  assert.deepEqual(await loadAuthorizedHistoricalTestRuleGuidance(f.ctx, f.input), g);
  assert.equal(f.gates(), 2); assert.equal(f.reads(), 2);
  f.grant.revoked_at = new Date();
  await assert.rejects(loadAuthorizedHistoricalTestRuleGuidance(f.ctx, f.input), /test_grant_revoked/);
}));

test('successor reference records its active grant instead of the immutable original run grant', async () => preprod(async () => {
  const f = fixture(2);
  const guidance = await loadAuthorizedHistoricalTestRuleGuidance(f.ctx, f.input);
  assert.equal(f.ctx.run.test_grant_id, 'synthetic-grant');
  assert.equal(guidance.authorization.grant_id, 'synthetic-successor-grant');
  assert.equal(guidance.authorization.input_revision, 2);
  assert.equal(guidance.authorization.input_hash, f.input.input_hash);
  assert.notEqual(f.ctx.run.originInput.inputHash, guidance.authorization.input_hash);
  f.grant.revoked_at = new Date();
  await assert.rejects(loadAuthorizedHistoricalTestRuleGuidance(f.ctx, f.input), /test_grant_revoked/);
}));

test('production, missing selector/gate and failed identity gates cannot load test guidance', async () => preprod(async () => {
  for (const mode of ['production', 'selector', 'gate', 'identity'] as const) {
    const f = fixture();
    if (mode === 'production') f.setRun({ channel: 'production' });
    if (mode === 'selector') delete f.ctx.testRuleCapabilityLoader;
    if (mode === 'gate') delete f.ctx.validateBeforeModelCall;
    if (mode === 'identity') f.ctx.validateBeforeModelCall = async () => ({ kind: 'pause', stage: 'capability_not_ready', reason: 'historical_issuer_identity_stale' });
    await assert.rejects(loadAuthorizedHistoricalTestRuleGuidance(f.ctx, f.input), /authorization_missing|issuer_identity_stale/);
    assert.equal(f.reads(), 0);
  }
  const f = fixture(); process.env.BB_DEPLOYMENT_TIER = 'production';
  await assert.rejects(loadAuthorizedHistoricalTestRuleGuidance(f.ctx, f.input), /test_channel_disabled/);
  assert.equal(f.reads(), 0);
}));

test('a not-ready candidate or unregistered sample stops before loading rules even with an active grant', async () => preprod(async () => {
  const f = fixture();
  f.ctx.testRuleCapabilityLoader = async () => ({ status: 'not_ready', reason: 'test_sample_membership_mismatch' });
  await assert.rejects(loadAuthorizedHistoricalTestRuleGuidance(f.ctx, f.input), /test_sample_membership_mismatch/);
  assert.equal(f.reads(), 0);
}));

test('cross-account/project, stale input, expiry and candidate hash changes reject before reference use', async () => preprod(async () => {
  for (const field of ['user_id', 'project_id', 'input_revision', 'input_hash', 'expires_at', 'taxonomy_hash', 'rule_pack_hash'] as const) {
    const f = fixture();
    Object.assign(f.grant, { [field]: field === 'expires_at' ? new Date(0) : field === 'input_revision' ? 2 : 'wrong' });
    await assert.rejects(loadAuthorizedHistoricalTestRuleGuidance(f.ctx, f.input), /test_grant_|pin_mismatch/, field);
  }
  const f = fixture(); f.manifest.target_confirmation.as_of = '2026-09-28';
  await assert.rejects(loadAuthorizedHistoricalTestRuleGuidance(f.ctx, f.input), /UPDATE_INPUT_LOCK_MISMATCH/);
  assert.equal(f.gates(), 0);
}));

test('missing current target intent cannot be inferred from reporting cutoff or historical draft', async () => preprod(async () => {
  for (const field of ['confirmed_by', 'document_purpose', 'as_of'] as const) {
    const f = fixture(); Object.assign(f.manifest.target_confirmation, { [field]: null });
    f.input.input_hash = f.grant.input_hash = inputManifestHash(f.manifest);
    f.setRun({ input_hash: f.input.input_hash });
    await assert.rejects(loadAuthorizedHistoricalTestRuleGuidance(f.ctx, f.input), /target_confirmation_required/);
  }
}));
