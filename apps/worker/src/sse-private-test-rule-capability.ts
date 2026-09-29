import type { Pool } from 'pg';
import { assertTestGrant } from '@bondbuddy/api/non-production-test';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { readTestApplicabilityRef } from '@bondbuddy/api/test-rule-applicability-pin';
import { isVerifiedIssuerIdentityBinding } from '@bondbuddy/api/issuer-identity-binding';
import { loadReviewedRuleApplicabilityContext } from '@bondbuddy/rule-applicability-context';
import { AUTHORIZED_SAMPLE_MANIFEST_SHA256 } from './authorized-sample-membership.generated.js';
import { loadAuthorizedSampleMembershipFromLockedInput } from './authorized-sample-membership-loader.js';
import { loadSsePrivateCandidateAssets, SSE_PRIVATE_CANDIDATE_RUNTIME_ROOT } from './sse-private-candidate-assets.js';
import { toTestCoverageGap } from './test-coverage.js';
import type { RunRow, TestRuleCapability, TestRuleCapabilityLoader } from './run-pipeline.js';

type LockedInput = Parameters<TestRuleCapabilityLoader>[1];
type CapabilityDependencies = {
  readonly candidateRoot?: string;
  readonly reviewedContextLoader?: typeof loadReviewedRuleApplicabilityContext;
};

const notReady = (reason: string): TestRuleCapability => ({ status: 'not_ready', reason });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value.trim());

/**
 * Trusted worker-only candidate capability. Coverage-item gaps retain their
 * own manifest/item identity; they are not promoted into rule-checker IDs.
 */
export function createSsePrivateTestRuleCapabilityLoader(pool: Pool, dependencies: CapabilityDependencies = {}): TestRuleCapabilityLoader {
  const candidateRoot = dependencies.candidateRoot ?? SSE_PRIVATE_CANDIDATE_RUNTIME_ROOT;
  const reviewedContextLoader = dependencies.reviewedContextLoader ?? loadReviewedRuleApplicabilityContext;
  return async (run: RunRow, input: LockedInput): Promise<TestRuleCapability> => {
    if (run.channel !== 'non_production_test' || !run.test_grant_id || run.task_kind !== 'update')
      return notReady('test_run_scope_required');
    if (!input.manifest || input.input_hash.trim() !== run.input_hash.trim() ||
        inputManifestHash(input.manifest) !== run.input_hash.trim()) return notReady('test_input_pin_mismatch');

    let grant: Awaited<ReturnType<typeof assertTestGrant>>;
    try {
      // This checks the current deployment tier/channel flag and the active grant
      // on every invocation, including every stage and pre-model-call gate.
      grant = await assertTestGrant(pool, { grantId: run.test_grant_id, userId: run.owner_user_id,
        projectId: run.project_id, inputRevision: run.input_revision, inputHash: run.input_hash.trim() });
    } catch {
      return notReady('test_grant_inactive_or_scope_changed');
    }

    const membership = await loadAuthorizedSampleMembershipFromLockedInput(pool, {
      ownerUserId: run.owner_user_id, projectId: run.project_id,
      inputRevision: run.input_revision, inputHash: run.input_hash.trim(),
    });
    if (!membership.accepted) return notReady(`authorized_sample_${membership.reason}`);
    if (grant.sample_manifest_sha256.trim() !== AUTHORIZED_SAMPLE_MANIFEST_SHA256)
      return notReady('authorized_sample_manifest_pin_mismatch');

    let candidate: Awaited<ReturnType<typeof loadSsePrivateCandidateAssets>>;
    try { candidate = await loadSsePrivateCandidateAssets(candidateRoot); }
    catch { return notReady('sse_private_candidate_asset_invalid'); }
    const bundle = candidate.bundle;
    if (grant.taxonomy_hash.trim() !== bundle.taxonomy.contentSha256 ||
        grant.rule_pack_hash.trim() !== bundle.rulePack.contentSha256)
      return notReady('test_candidate_hash_mismatch');

    const manifest = input.manifest;
    const ref = readTestApplicabilityRef(manifest);
    if (manifest.test_rule_applicability_ref != null && !ref) return notReady('test_reviewed_applicability_pin_invalid');
    if (typeof manifest.test_rule_applicability_block_reason === 'string')
      return notReady(manifest.test_rule_applicability_block_reason);
    if (ref && (ref.source_input_revision > run.input_revision ||
        (ref.source_input_revision === run.input_revision && ref.source_input_hash !== run.input_hash.trim())))
      return notReady('test_reviewed_applicability_source_mismatch');
    if (!isVerifiedIssuerIdentityBinding(manifest.issuer_identity))
      return notReady('test_reviewed_issuer_identity_required');

    const materials = manifest.materials;
    if (!Array.isArray(materials) || materials.some(item => !isRecord(item) || typeof item.material_id !== 'string' ||
        !Number.isSafeInteger(item.material_version) || Number(item.material_version) < 1 || !sha256(item.sha256)))
      return notReady('test_reviewed_material_manifest_invalid');
    const target = manifest.target_confirmation;
    if (!isRecord(target) || target.status !== 'confirmed' || target.confirmed_by !== run.owner_user_id ||
        manifest.market !== 'sse' || manifest.offering !== 'private' ||
        target.market !== manifest.market || target.offering !== manifest.offering ||
        !['registration','issuance'].includes(String(target.document_purpose)) ||
        typeof target.as_of !== 'string')
      return notReady('test_reviewed_applicability_scope_mismatch');
    if (ref) {
      const reviewed = await reviewedContextLoader(pool, {
        ownerUserId: run.owner_user_id, projectId: run.project_id, contextId: ref.context_id,
        version: ref.version, contentHash: ref.content_hash,
        expectedSourceInputRevision: ref.source_input_revision, expectedSourceInputHash: ref.source_input_hash,
        expectedIssuerBinding: manifest.issuer_identity,
        currentDraftRevision: Number(input.draft_revision), mode: 'non_production_test',
        currentMaterialVersions: materials.map(item => ({ materialId: String((item as Record<string, unknown>).material_id),
          materialVersion: Number((item as Record<string, unknown>).material_version),
          sha256: String((item as Record<string, unknown>).sha256).trim().toLowerCase() })),
      });
      if (reviewed.status !== 'approved') return notReady(`test_reviewed_applicability_${reviewed.reasons[0] ?? 'not_approved'}`);
      const request = reviewed.request;
      if (request.market !== target.market || request.offering !== target.offering ||
          request.documentStage !== target.document_purpose || request.asOf !== target.as_of ||
          request.instrument !== 'ordinary-company-bond' || request.issuerScope !== 'domestic-company' ||
          request.investorScope !== 'professional' || !request.industry || !Array.isArray(request.specialFeatures))
        return notReady('test_reviewed_applicability_scope_mismatch');
    }

    // 31 coverage gaps have no linked rule IDs; the sole not_applicable coverage
    // item is a scope exclusion, not a gap. Project only uncovered items through
    // the #337 DTO, preserving their candidate identity and never inventing IDs.
    const gaps = bundle.coverage.items.filter(item => item.disposition === 'uncovered');
    const exclusions = bundle.coverage.items.filter(item => item.disposition === 'not_applicable');
    if (gaps.length !== 31 || exclusions.length !== 1 || gaps.some(item => item.ruleIds.length > 0))
      return notReady('sse_private_candidate_coverage_semantics_changed');
    return { status: 'ready', sampleManifestSha256: AUTHORIZED_SAMPLE_MANIFEST_SHA256,
      taxonomyHash: bundle.taxonomy.contentSha256, rulePackHash: bundle.rulePack.contentSha256,
      uncoveredItems: gaps.map(toTestCoverageGap) };
  };
}
