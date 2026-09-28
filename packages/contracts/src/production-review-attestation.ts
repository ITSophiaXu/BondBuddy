import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ProductionReviewManifestSchema, PRODUCTION_SAMPLE_POLARITIES, validProductionReviewManifestContent, type ProductionReviewManifest } from './production-review-manifest.js';

const id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const reason = Type.String({ minLength: 1, maxLength: 4096 });
const utc = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$', description: 'Server-generated UTC ISO-8601 timestamp.' });
const evidenceRef = Type.Object({ evidence_id: id, evidence_sha256: hash }, { additionalProperties: false });
const decision = Type.Union([
  Type.Literal('approve'), Type.Literal('request_more_evidence'), Type.Literal('reject'),
]);

/** Required industry review evidence, anchored to the immutable manifest content. */
export const ProductionIndustryAttestationEvidenceSchema = Type.Object({
  source_effectivity_applicability: Type.Array(Type.Object({
    source_evidence_id: id,
    source_check_sha256: hash,
    conclusion: Type.Union([Type.Literal('applicable'), Type.Literal('not_applicable'), Type.Literal('needs_evidence')]),
    reason,
    evidence_refs: Type.Array(evidenceRef, { minItems: 1, maxItems: 100 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 1000 }),
  chapter_boundaries: Type.Array(Type.Object({
    chapter_id: id,
    boundary: Type.Union([Type.Literal('included'), Type.Literal('excluded'), Type.Literal('partial')]),
    reason,
    evidence_refs: Type.Array(evidenceRef, { minItems: 1, maxItems: 100 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 500 }),
  exceptions_and_uncovered: Type.Array(Type.Object({
    item_code: id,
    item_kind: Type.Union([Type.Literal('exception'), Type.Literal('uncovered')]),
    disposition: Type.Union([Type.Literal('within_scope'), Type.Literal('out_of_scope'), Type.Literal('needs_evidence')]),
    reason,
    evidence_refs: Type.Array(evidenceRef, { minItems: 1, maxItems: 100 }),
  }, { additionalProperties: false }), { maxItems: 500 }),
  sample_conclusions: Type.Array(Type.Object({
    sample_case_id: id,
    sample_evidence_id: id,
    conclusion: decision,
    reason,
    evidence_refs: Type.Array(evidenceRef, { minItems: 1, maxItems: 100 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 500 }),
}, { additionalProperties: false, description: 'Industry review of source effectivity/applicability, chapter boundaries, each exception/uncovered item, and per-sample conclusions.' });

/** Required technical review evidence, anchored to the same manifest as industry review. */
export const ProductionTechnicalAttestationEvidenceSchema = Type.Object({
  checker_version_or_commit: Type.String({ minLength: 1, maxLength: 256 }),
  converter_version_or_commit: Type.String({ minLength: 1, maxLength: 256 }),
  test_evidence: Type.Array(evidenceRef, { minItems: 1, maxItems: 500 }),
  template_coverage_consistency: Type.Object({
    chapter_template_sha256: hash,
    coverage_manifest_sha256: hash,
    result: Type.Union([Type.Literal('consistent'), Type.Literal('inconsistent'), Type.Literal('needs_evidence')]),
    evidence_refs: Type.Array(evidenceRef, { minItems: 1, maxItems: 100 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false, description: 'Technical review of checker/converter revision, test evidence, and template/coverage consistency.' });

const manifestPin = {
  manifest_id: id,
  manifest_version: Type.Integer({ minimum: 1, maximum: 2147483647 }),
  content_sha256: hash,
};

/** Authenticated reviewer input. Actor, grant and time are intentionally absent. */
export const ProductionIndustryAttestationRequestSchema = Type.Object({
  ...manifestPin,
  decision,
  reason,
  evidence: ProductionIndustryAttestationEvidenceSchema,
}, { additionalProperties: false });

export const ProductionTechnicalAttestationRequestSchema = Type.Object({
  ...manifestPin,
  decision,
  reason,
  evidence: ProductionTechnicalAttestationEvidenceSchema,
}, { additionalProperties: false });

export const ProductionReviewAttestationRequestSchema = Type.Union([
  ProductionIndustryAttestationRequestSchema,
  ProductionTechnicalAttestationRequestSchema,
], { description: 'Self-submission by the authenticated reviewer; role, user identity, grant and reviewed_at are server-derived and cannot be supplied. The authenticated route validates the role-specific branch.' });

/** Immutable append-only event created from a validated authenticated request. */
export const ProductionReviewAttestationEventSchema = Type.Union([
  Type.Object({
    attestation_event_id: id,
    schema_version: Type.Literal(1),
    ...manifestPin,
    reviewer_role: Type.Literal('industry'),
    reviewer_user_id: id,
    grant_id: id,
    decision,
    reason,
    evidence: ProductionIndustryAttestationEvidenceSchema,
    reviewed_at: utc,
  }, { additionalProperties: false }),
  Type.Object({
    attestation_event_id: id,
    schema_version: Type.Literal(1),
    ...manifestPin,
    reviewer_role: Type.Literal('technical'),
    reviewer_user_id: id,
    grant_id: id,
    decision,
    reason,
    evidence: ProductionTechnicalAttestationEvidenceSchema,
    reviewed_at: utc,
  }, { additionalProperties: false }),
], { description: 'Server-authored immutable decision event; the writer enforces active grants, exact manifest pin and distinct users for the two roles.' });

/** Reviewer input to withdraw their own prior attestation; actor/time are server-derived. */
export const ProductionReviewAttestationWithdrawalRequestSchema = Type.Object({
  attestation_event_id: id,
  reason,
}, { additionalProperties: false });

/** Append-only withdrawal event linked to, and never replacing, the original attestation. */
export const ProductionReviewAttestationWithdrawalEventSchema = Type.Object({
  withdrawal_event_id: id,
  schema_version: Type.Literal(1),
  attestation_event_id: id,
  withdrawn_by_user_id: id,
  grant_id: id,
  reason,
  withdrawn_at: utc,
}, { additionalProperties: false });

export const productionReviewAttestationSchemas = {
  ProductionIndustryAttestationRequest: ProductionIndustryAttestationRequestSchema,
  ProductionTechnicalAttestationRequest: ProductionTechnicalAttestationRequestSchema,
  ProductionReviewAttestationRequest: ProductionReviewAttestationRequestSchema,
  ProductionReviewAttestationEvent: ProductionReviewAttestationEventSchema,
  ProductionReviewAttestationWithdrawalRequest: ProductionReviewAttestationWithdrawalRequestSchema,
  ProductionReviewAttestationWithdrawalEvent: ProductionReviewAttestationWithdrawalEventSchema,
} as const;

export type ProductionReviewAttestationRequest = Static<typeof ProductionReviewAttestationRequestSchema>;
export type ProductionIndustryAttestationRequest = Static<typeof ProductionIndustryAttestationRequestSchema>;
export type ProductionTechnicalAttestationRequest = Static<typeof ProductionTechnicalAttestationRequestSchema>;
export type ProductionReviewAttestationEvent = Static<typeof ProductionReviewAttestationEventSchema>;
export type ProductionReviewAttestationWithdrawalRequest = Static<typeof ProductionReviewAttestationWithdrawalRequestSchema>;
export type ProductionReviewAttestationWithdrawalEvent = Static<typeof ProductionReviewAttestationWithdrawalEventSchema>;

/**
 * Checks that a reviewer request refers only to the already-frozen
 * manifest supplied by the caller. The caller is responsible for validating the
 * manifest content hash with the registry's productionReviewContentHashMatches
 * before calling; this function checks shape and semantic content but deliberately
 * does not calculate a hash and is not an authorization or release decision.
 *
 * Chapter IDs are checked for duplicates, but cannot be checked for completeness:
 * the manifest pins the chapter-template hash and does not expose its chapter list.
 */
export function validProductionReviewAttestationBinding(
  request: ProductionReviewAttestationRequest,
  manifest: ProductionReviewManifest,
): boolean {
  if (!Value.Check(ProductionReviewAttestationRequestSchema, request) ||
      !Value.Check(ProductionReviewManifestSchema, manifest) ||
      !validProductionReviewManifestContent(manifest)) return false;
  if (request.manifest_id !== manifest.manifest_id ||
      request.manifest_version !== manifest.manifest_version ||
      request.content_sha256 !== manifest.content_sha256) return false;

  const evidence = request.evidence;
  const seenEvidenceHashes = new Map<string, string>();
  const uniqueEvidenceRefs = (refs: readonly { evidence_id: string; evidence_sha256: string }[]): boolean => {
    const local = new Set<string>();
    for (const ref of refs) {
      if (local.has(ref.evidence_id)) return false;
      local.add(ref.evidence_id);
      const previous = seenEvidenceHashes.get(ref.evidence_id);
      if (previous !== undefined && previous !== ref.evidence_sha256) return false;
      seenEvidenceHashes.set(ref.evidence_id, ref.evidence_sha256);
    }
    return true;
  };

  if ('source_effectivity_applicability' in evidence) {
    const scope = manifest.content.applicability_scope;
    const applicabilityDimensions = [scope.issuer_scopes, scope.investor_scopes, scope.industry_codes, scope.special_feature_scope];
    if (request.decision === 'approve' && applicabilityDimensions.some(dimension => dimension.mode === 'needs_review')) return false;
    const sources = new Map(manifest.content.source_date_evidence.map(source => [source.source_evidence_id, source]));
    const reviewedSources = new Set<string>();
    for (const row of evidence.source_effectivity_applicability) {
      const source = sources.get(row.source_evidence_id);
      if (!source || source.source_check_sha256 !== row.source_check_sha256 || reviewedSources.has(row.source_evidence_id) ||
          !uniqueEvidenceRefs(row.evidence_refs)) return false;
      reviewedSources.add(row.source_evidence_id);
      if (request.decision === 'approve' && row.conclusion !== 'applicable') return false;
    }
    if (request.decision === 'approve' && reviewedSources.size !== sources.size) return false;

    const items = new Set([
      ...manifest.content.applicability_scope.exceptions.map(item => `exception:${item.code}`),
      ...manifest.content.applicability_scope.uncovered_items.map(item => `uncovered:${item.code}`),
    ]);
    const reviewedItems = new Set<string>();
    for (const row of evidence.exceptions_and_uncovered) {
      const itemKey = `${row.item_kind}:${row.item_code}`;
      if (!items.has(itemKey) || reviewedItems.has(itemKey) || !uniqueEvidenceRefs(row.evidence_refs)) return false;
      reviewedItems.add(itemKey);
      if (request.decision === 'approve' && row.disposition === 'needs_evidence') return false;
    }
    if (request.decision === 'approve' && reviewedItems.size !== items.size) return false;

    const samples = new Map(manifest.content.authorized_real_sample_evidence.map(sample => [sample.sample_evidence_id, sample]));
    if (request.decision === 'approve' && !PRODUCTION_SAMPLE_POLARITIES.every(polarity =>
      manifest.content.authorized_real_sample_evidence.some(sample => sample.polarity === polarity))) return false;
    const reviewedSamples = new Set<string>();
    for (const row of evidence.sample_conclusions) {
      const sample = samples.get(row.sample_evidence_id);
      if (!sample || sample.sample_case_id !== row.sample_case_id || reviewedSamples.has(row.sample_evidence_id) ||
          !uniqueEvidenceRefs(row.evidence_refs)) return false;
      reviewedSamples.add(row.sample_evidence_id);
      if (request.decision === 'approve' && row.conclusion !== 'approve') return false;
    }
    if (request.decision === 'approve' && reviewedSamples.size !== samples.size) return false;

    const chapters = new Set<string>();
    for (const row of evidence.chapter_boundaries) {
      if (chapters.has(row.chapter_id) || !uniqueEvidenceRefs(row.evidence_refs)) return false;
      chapters.add(row.chapter_id);
    }
    return true;
  }

  if (evidence.template_coverage_consistency.chapter_template_sha256 !== manifest.content.chapter_template.sha256 ||
      evidence.template_coverage_consistency.coverage_manifest_sha256 !== manifest.content.coverage_manifest.sha256 ||
      !uniqueEvidenceRefs(evidence.template_coverage_consistency.evidence_refs) ||
      !uniqueEvidenceRefs(evidence.test_evidence)) return false;
  if (request.decision === 'approve' && evidence.template_coverage_consistency.result !== 'consistent') return false;
  return true;
}
