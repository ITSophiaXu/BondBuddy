import { Type, type Static } from '@sinclair/typebox';

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
  }, { additionalProperties: false }), { minItems: 1, maxItems: 500 }),
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
export const ProductionReviewAttestationRequestSchema = Type.Union([
  Type.Object({
    ...manifestPin,
    reviewer_role: Type.Literal('industry'),
    decision,
    reason,
    evidence: ProductionIndustryAttestationEvidenceSchema,
  }, { additionalProperties: false }),
  Type.Object({
    ...manifestPin,
    reviewer_role: Type.Literal('technical'),
    decision,
    reason,
    evidence: ProductionTechnicalAttestationEvidenceSchema,
  }, { additionalProperties: false }),
], { description: 'Self-submission by the authenticated reviewer; user identity, grant and reviewed_at are server-derived and cannot be supplied.' });

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
  ProductionReviewAttestationRequest: ProductionReviewAttestationRequestSchema,
  ProductionReviewAttestationEvent: ProductionReviewAttestationEventSchema,
  ProductionReviewAttestationWithdrawalRequest: ProductionReviewAttestationWithdrawalRequestSchema,
  ProductionReviewAttestationWithdrawalEvent: ProductionReviewAttestationWithdrawalEventSchema,
} as const;

export type ProductionReviewAttestationRequest = Static<typeof ProductionReviewAttestationRequestSchema>;
export type ProductionReviewAttestationEvent = Static<typeof ProductionReviewAttestationEventSchema>;
export type ProductionReviewAttestationWithdrawalRequest = Static<typeof ProductionReviewAttestationWithdrawalRequestSchema>;
export type ProductionReviewAttestationWithdrawalEvent = Static<typeof ProductionReviewAttestationWithdrawalEventSchema>;
