import type { Pool, PoolClient } from 'pg';
import { loadReviewedRuleApplicabilityContext } from '@bondbuddy/rule-applicability-context';
import { isVerifiedIssuerIdentityBinding, type VerifiedIssuerIdentityBinding } from './issuer-identity-binding.js';
import { inputManifestHash, validContextRef, verifyRuleApplicabilitySourceLock,
  type LockedRuleSource, type RuleApplicabilityContextRef } from './production-rule-pin.js';

type Db = Pick<Pool | PoolClient, 'query'>;
type Project = { owner_user_id: string; id: string; market: unknown; offering: unknown };
export type TestApplicabilityPin = { ref: RuleApplicabilityContextRef | null; reason: string | null };

/** A request supplies an assertion only. The stored ref comes from an exact reviewed context. */
export async function lockTestRuleApplicabilityRef(db: Db, project: Project, current: LockedRuleSource,
  identity: VerifiedIssuerIdentityBinding | undefined, asserted: unknown): Promise<TestApplicabilityPin> {
  if (!validContextRef(asserted)) return { ref: null, reason: 'test_reviewed_applicability_pin_missing' };
  if (!identity || !isVerifiedIssuerIdentityBinding(identity))
    return { ref: null, reason: 'test_reviewed_issuer_identity_required' };
  const sourceFailure = await verifyRuleApplicabilitySourceLock(db, project.owner_user_id, project.id, asserted, current);
  if (sourceFailure) return { ref: null, reason: sourceFailure };
  const source = (await db.query(`SELECT manifest FROM bb_input_revisions
    WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3 FOR SHARE`,
  [project.owner_user_id, project.id, asserted.source_input_revision])).rows[0];
  if (!source || !source.manifest || source.manifest.market !== project.market || source.manifest.offering !== project.offering)
    return { ref: null, reason: 'rule_applicability_project_scope_mismatch' };
  const result = await loadReviewedRuleApplicabilityContext(db, {
    ownerUserId: project.owner_user_id, projectId: project.id, contextId: asserted.context_id,
    version: asserted.version, contentHash: asserted.content_hash,
    expectedSourceInputRevision: asserted.source_input_revision,
    expectedSourceInputHash: asserted.source_input_hash, expectedIssuerBinding: identity,
    currentDraftRevision: current.draftRevision, mode: 'selection',
    currentMaterialVersions: current.materials.map(item => ({ materialId: item.material_id,
      materialVersion: item.material_version, sha256: item.sha256 })),
  });
  // Candidate tests need a reviewed context, but do not require a production-published taxonomy.
  const reviewed = result.status === 'approved' ||
    (result.reasons.length === 1 && result.reasons[0] === 'rule_applicability_taxonomy_not_published');
  if (!reviewed) return { ref: null, reason: result.reasons[0] ?? 'rule_applicability_needs_review' };
  if (!result.contextPin || inputManifestHash(result.contextPin) !== asserted.content_hash)
    return { ref: null, reason: 'rule_applicability_context_hash_mismatch' };
  if (result.status === 'approved' && (result.request.market !== project.market || result.request.offering !== project.offering))
    return { ref: null, reason: 'rule_applicability_project_scope_mismatch' };
  return { ref: { ...asserted }, reason: null };
}

/** Shared shape check for the input gate and the #19 exact-ref reader. */
export function readTestApplicabilityRef(manifest: unknown): RuleApplicabilityContextRef | null {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  const ref = (manifest as Record<string, unknown>).test_rule_applicability_ref;
  return validContextRef(ref) ? { ...ref } : null;
}
