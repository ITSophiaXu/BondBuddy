import { Type } from '@sinclair/typebox';

const id = Type.String({ minLength: 1, maxLength: 128 });
const revision = Type.Integer({ minimum: 1, maximum: 2147483647 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const RULE_APPLICABILITY_FEATURE_DIMENSIONS = [
  'urban_construction', 'real_estate', 'group_operations', 'special_product_or_use',
  'embedded_or_perpetual', 'optimized_review', 'restructuring', 'special_issuer', 'transition_arrangement',
] as const;
export const RULE_APPLICABILITY_FEATURE_EVIDENCE_V2_CONTRACT_VERSION = 'sse-private-feature-evidence-v2' as const;
const evidenceRef = Type.Object({
  materialId: id, materialVersion: revision, materialSha256: hash,
  parseSnapshotId: id, recordId: id, recordSha256: hash,
}, { additionalProperties: false });
const nonEmptyReason = Type.String({ minLength: 1, maxLength: 1024 });

/** Owner-visible reference to an immutable applicability draft. This DTO can never represent production eligibility. */
export const ruleApplicabilityContextSchemas = {
  RuleApplicabilityContextDraftCreateRequest: Type.Object({
    request_id: Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' }),
  }, { additionalProperties: false }),
  RuleApplicabilityContextDraftResponse: Type.Object({
    status: Type.Literal('needs_review'),
    production_eligible: Type.Literal(false),
    context_ref: Type.Object({
      context_id: id,
      version: revision,
      content_hash: hash,
      source_input_revision: revision,
      source_input_hash: hash,
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  RuleApplicabilityOverallReviewCreateRequest: Type.Object({
    request_id: Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' }),
    action: Type.Union([Type.Literal('approve'), Type.Literal('request_more_evidence'), Type.Literal('withdraw')]),
    reason: Type.String({ minLength: 1, maxLength: 2048 }),
    approved_values: Type.Optional(Type.Object({
      market: Type.Union([Type.Literal('sse'), Type.Literal('szse'), Type.Literal('nafmii')]),
      offering: Type.Union([Type.Literal('private'), Type.Literal('public'), Type.Literal('public_all'),
        Type.Literal('ppn'), Type.Literal('mtn'), Type.Literal('cp'), Type.Literal('scp'), Type.Literal('dfi')]),
      instrument: Type.String({ minLength: 1, maxLength: 128 }),
      documentStage: Type.Union([Type.Literal('registration'), Type.Literal('issuance')]),
      issuerScope: Type.Union([Type.Literal('domestic-company'), Type.Literal('other')]),
      investorScope: Type.Union([Type.Literal('professional'), Type.Literal('other')]),
      industry: Type.String({ minLength: 1, maxLength: 128 }),
      specialFeatures: Type.Array(Type.String({ pattern: '^[a-z][a-z0-9_-]{0,63}$' }), { maxItems: 32, uniqueItems: true }),
      asOf: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    }, { additionalProperties: false })),
    value_evidence: Type.Optional(Type.Record(Type.String(), Type.Array(evidenceRef, { minItems: 1, maxItems: 64 }),
      { maxProperties: 8 })),
    feature_evidence: Type.Optional(Type.Union([
      Type.Array(Type.Object({
      dimension: Type.Union(RULE_APPLICABILITY_FEATURE_DIMENSIONS.map(dimension => Type.Literal(dimension))),
      outcome: Type.Union([Type.Literal('present'), Type.Literal('absent'), Type.Literal('not_applicable')]),
      featureCode: Type.Optional(Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' })),
      reason: nonEmptyReason,
      evidenceRefs: Type.Array(evidenceRef, { minItems: 1, maxItems: 64 }),
      }, { additionalProperties: false }), { maxItems: RULE_APPLICABILITY_FEATURE_DIMENSIONS.length }),
      Type.Object({
        contractVersion: Type.Literal(RULE_APPLICABILITY_FEATURE_EVIDENCE_V2_CONTRACT_VERSION),
        dictionaryVersion: Type.String({ minLength: 1, maxLength: 64 }),
        dictionarySha256: hash,
        dimensions: Type.Array(Type.Object({
          dimension: Type.Union(RULE_APPLICABILITY_FEATURE_DIMENSIONS.map(dimension => Type.Literal(dimension))),
          outcome: Type.Union([Type.Literal('present'), Type.Literal('absent'), Type.Literal('not_applicable')]),
          reason: nonEmptyReason,
          evidenceRefs: Type.Array(evidenceRef, { minItems: 1, maxItems: 64 }),
          childAssessments: Type.Array(Type.Object({
            featureCode: Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }),
            outcome: Type.Union([Type.Literal('present'), Type.Literal('absent'), Type.Literal('not_applicable'), Type.Literal('unknown')]),
            reason: nonEmptyReason,
            evidenceRefs: Type.Array(evidenceRef, { maxItems: 64 }),
          }, { additionalProperties: false }), { maxItems: 3 }),
        }, { additionalProperties: false }), { maxItems: RULE_APPLICABILITY_FEATURE_DIMENSIONS.length }),
      }, { additionalProperties: false }),
    ])),
    taxonomy_version: Type.Optional(Type.String({ pattern: '^bondbuddy-applicability-[a-z0-9.-]{1,64}$' })),
  }, { additionalProperties: false }),
  RuleApplicabilityOverallReviewResponse: Type.Object({
    review_id: id,
    action: Type.Union([Type.Literal('approve'), Type.Literal('request_more_evidence'), Type.Literal('withdraw')]),
    replayed: Type.Boolean(),
    production_eligible: Type.Literal(false),
  }, { additionalProperties: false }),
};
