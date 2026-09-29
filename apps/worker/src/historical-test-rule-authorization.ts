import { assertTestGrant } from '@bondbuddy/api/non-production-test';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { Problem } from '@bondbuddy/api/data';
import { updateContentHash } from '@bondbuddy/domain/historical-update';
import type { StageContext, TestRuleCapabilityLoader } from './run-pipeline.js';
import { HistoricalRulesUnavailable } from './historical-rule-context.js';
import { loadHistoricalCandidateRuleGuidance } from './historical-candidate-rule-context.js';
import { testWorkingDraftTarget } from './test-working-draft-target.js';

/** Test-only consumer. Never interpret a draft/blocked production pin as a release. */
export async function loadAuthorizedHistoricalTestRuleGuidance(ctx: StageContext, input: Parameters<TestRuleCapabilityLoader>[1]) {
  if (ctx.run.channel !== 'non_production_test' || ctx.run.task_kind !== 'update' || !ctx.run.test_grant_id ||
      !ctx.testRuleCapabilityLoader || !ctx.validateBeforeModelCall)
    throw new HistoricalRulesUnavailable('historical_test_rule_authorization_missing');
  const manifest = input.manifest;
  if (!manifest || input.input_hash.trim() !== ctx.run.input_hash.trim() ||
      inputManifestHash(manifest) !== ctx.run.input_hash.trim()) throw new Error('UPDATE_INPUT_LOCK_MISMATCH');
  // Reuses #17's issuer identity + #19 candidate/membership gate, including replay.
  const gate = await ctx.validateBeforeModelCall();
  if (gate?.kind === 'pause') throw new HistoricalRulesUnavailable(gate.reason);
  if (gate) throw new Error('UPDATE_TEST_RULE_AUTHORIZATION_REJECTED');
  const capability = await ctx.testRuleCapabilityLoader(ctx.run, input);
  if (capability.status !== 'ready') throw new HistoricalRulesUnavailable(capability.reason);
  let grant;
  try {
    grant = await assertTestGrant(ctx.pool, { grantId: ctx.run.test_grant_id, userId: ctx.run.owner_user_id,
      projectId: ctx.run.project_id, inputRevision: ctx.run.input_revision, inputHash: ctx.run.input_hash.trim() });
  } catch (error) {
    if (error instanceof Problem) throw new HistoricalRulesUnavailable(error.code.toLowerCase());
    throw error;
  }
  if (capability.sampleManifestSha256 !== grant.sample_manifest_sha256.trim() ||
      capability.taxonomyHash !== grant.taxonomy_hash.trim() || capability.rulePackHash !== grant.rule_pack_hash.trim())
    throw new HistoricalRulesUnavailable('historical_test_rule_pin_mismatch');
  const t=testWorkingDraftTarget(manifest,grant,ctx.run.owner_user_id);
  if (!t)
    throw new HistoricalRulesUnavailable('historical_test_rule_target_confirmation_required');
  const guidance = await loadHistoricalCandidateRuleGuidance({ market: t.market, offering: t.offering,
    documentStage: t.document_purpose, asOf: t.as_of },
  { taxonomyHash: grant.taxonomy_hash.trim(), rulePackHash: grant.rule_pack_hash.trim() });
  const { content_hash: _, ...reference } = guidance;
  const content = { ...reference, authorization: { grant_id: ctx.run.test_grant_id, input_revision: ctx.run.input_revision,
    input_hash: ctx.run.input_hash.trim(), sample_manifest_sha256: grant.sample_manifest_sha256.trim(),
    target_status:t.status } };
  return { ...content, content_hash: updateContentHash(content) };
}
