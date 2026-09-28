import { Type } from '@sinclair/typebox';

const id = Type.String({ minLength: 1, maxLength: 128, description: 'Opaque identifier; never an authorization grant.' });
const day = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const FactIdentityInputSchema = Type.Object({
  entity_id: id,
  scope: id,
  metric: id,
  period: Type.Object({ start: Type.Optional(day), end: Type.Optional(day), as_of: Type.Optional(day) }, { additionalProperties: false }),
  currency: Type.Union([id, Type.Null()]),
  unit: id,
  basis: id,
  data_version: id,
}, { additionalProperties: false });
const FactIdentitySchema = Type.Object({
  account_id: id,
  entity_id: id,
  scope: id,
  metric: id,
  period: Type.Object({ start: Type.Union([day, Type.Null()]), end: Type.Union([day, Type.Null()]), as_of: Type.Union([day, Type.Null()]) }, { additionalProperties: false }),
  currency: Type.Union([id, Type.Null()]),
  unit: id,
  basis: id,
  data_version: id,
}, { additionalProperties: false });
const FactEvidenceSchema = Type.Object({
  evidence_id: id,
  material_id: id,
  material_version: Type.Integer({ minimum: 1 }),
  content_hash: hash,
  locator_type: id,
  locator: Type.Record(Type.String(), Type.Unknown()),
  literal_quote: Type.String(),
  extraction_method: id,
  extraction_version: id,
  confidence: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
  uncertainty: Type.Array(Type.String()),
  candidate_confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  source_anchor_review: Type.Optional(Type.Object({ verifier_id: id, verified_at: Type.String() }, { additionalProperties: false })),
  ocr_source: Type.Optional(Type.Object({ snapshot_id: id, result_sha256: hash, record_id: id, page: Type.Integer({ minimum: 1 }), bbox: Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()]), page_image_sha256: hash, coordinate_system: id }, { additionalProperties: false })),
  ocr_correction: Type.Optional(Type.Object({ correction_id: id, revision: Type.Integer({ minimum: 1 }), corrected_text: Type.String(), reason: Type.String(), actor_user_id: id, created_at: Type.String(), period: Type.Union([day, Type.Null()]), scope: Type.Union([id, Type.Null()]), unit: Type.Union([id, Type.Null()]) }, { additionalProperties: false })),
}, { additionalProperties: false });
const FactEvidenceAssessmentSchema = Type.Object({
  target_id: id,
  assessment: Type.Union([Type.Literal('supports_candidate'), Type.Literal('contradicts_candidate'), Type.Literal('not_relevant'), Type.Literal('unresolved')]),
  reason: Type.String({ minLength: 1, maxLength: 2048 }),
}, { additionalProperties: false });
const normalizedDecimal = Type.String({ pattern: '^(?:0(?:\\.[0-9]*[1-9])?|-0\\.[0-9]*[1-9]|-?[1-9][0-9]*(?:\\.[0-9]*[1-9])?)$', description: 'Canonical decimal text without insignificant fractional zeros.' });
const FactEvidenceCandidateValueSchema = Type.Union([
  Type.Object({ value_kind: Type.Literal('decimal'), value_decimal: normalizedDecimal, value_text: Type.Null() }, { additionalProperties: false }),
  Type.Object({ value_kind: Type.Literal('text'), value_decimal: Type.Null(), value_text: Type.String() }, { additionalProperties: false }),
  Type.Object({ value_kind: Type.Union([Type.Literal('unknown'), Type.Literal('not_applicable')]), value_decimal: Type.Null(), value_text: Type.Null() }, { additionalProperties: false }),
]);
const FactEvidenceContextManifestSchema = Type.Object({
  schema_version: Type.Literal('fact-evidence-context-v1'), owner_user_id: id, project_id: id, candidate_id: id,
  input_revision: Type.Integer({ minimum: 1 }), input_hash: hash, candidate_identity_sha256: hash,
  fact_identity: Type.Record(Type.String(), Type.Unknown()), candidate_value: FactEvidenceCandidateValueSchema,
  source_kind: Type.Union([Type.Literal('audited'), Type.Literal('external')]),
  candidate_status: Type.Union([Type.Literal('extracted'), Type.Literal('verified'), Type.Literal('user_asserted'), Type.Literal('conflicted'), Type.Literal('needs_confirmation'), Type.Literal('superseded')]),
  candidate_uncertainty: Type.Array(Type.String()), candidate_confidence: Type.Number({ minimum: 0, maximum: 1 }),
  material_id: id, material_version: Type.Integer({ minimum: 1 }), material_sha256: hash, snapshot_id: id,
  parser_version: id, parse_request_hash: hash, parse_response_sha256: hash, parse_status: id,
  original_warnings: Type.Array(Type.Object({ code: id, message: Type.String() }, { additionalProperties: false })),
  selected_body: Type.Array(Type.Object({ record_id: id, content_sha256: hash, locator_type: id,
    locator: Type.Record(Type.String(), Type.Unknown()), confidence: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
    uncertainty: Type.Array(Type.String()) }, { additionalProperties: false })),
  auxiliary_targets: Type.Array(Type.Object({ target_id: id, kind: id, part_name: Type.String(), part_sha256: Type.Union([hash, Type.Null()]),
    target_sha256: Type.Union([hash, Type.Null()]), scope: Type.Record(Type.String(), Type.Unknown()), parse_status: id,
    relevance: Type.Union([Type.Literal('relevant'), Type.Literal('not_relevant'), Type.Literal('unknown')]), relevance_reason: id }, { additionalProperties: false })),
  completeness_status: Type.Union([Type.Literal('complete'), Type.Literal('incomplete')]), completeness_reasons: Type.Array(id),
  reviewable: Type.Boolean(), evidence_set_sha256: hash,
}, { additionalProperties: false });
const FactDecisionSummarySchema = Type.Object({
  decision_id: id,
  version: Type.Integer({ minimum: 1 }),
  resolution: Type.Union([Type.Literal('selected'), Type.Literal('unresolved')]),
  selected_candidate_id: Type.Union([id, Type.Null()]),
  reason: Type.String(),
  created_at: Type.String(),
}, { additionalProperties: false });
const FactCandidateSchema = Type.Object({
  candidate_id: id,
  fact_key_hash: hash,
  identity: FactIdentitySchema,
  value_kind: Type.Union([Type.Literal('decimal'), Type.Literal('text'), Type.Literal('unknown'), Type.Literal('not_applicable')]),
  value: Type.Union([Type.String(), Type.Null()]),
  source_kind: Type.Union([Type.Literal('audited'), Type.Literal('user_statement'), Type.Literal('external')]),
  source_ref: id,
  observed_at: Type.Union([Type.String(), Type.Null()]),
  valid_as_of: Type.Union([day, Type.Null()]),
  status: Type.Union([Type.Literal('extracted'), Type.Literal('verified'), Type.Literal('user_asserted'), Type.Literal('conflicted'), Type.Literal('needs_confirmation'), Type.Literal('superseded')], { description: 'Selection never upgrades this status. OCR and user statements remain unverified.' }),
  verification: Type.Union([Type.Object({ actor_id: id, actor_role: Type.Literal('internal_reviewer'), verified_at: Type.String() }, { additionalProperties: false }), Type.Null()]),
  material_id: Type.Union([id, Type.Null()]),
  material_version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  evidence: Type.Array(FactEvidenceSchema),
  uncertainty: Type.Array(Type.String()),
  created_at: Type.String(),
  latest_decision: Type.Union([FactDecisionSummarySchema, Type.Null()]),
}, { additionalProperties: false });

export const factSchemas = {
  FactCandidateListQuery: Type.Object({ cursor: Type.Optional(Type.String({ minLength: 1 })), limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-9][0-9]|100)$' })) }, { additionalProperties: false }),
  FactCandidate: FactCandidateSchema,
  FactCandidateListResponse: Type.Object({ items: Type.Array(FactCandidateSchema), next_cursor: Type.Union([Type.String(), Type.Null()]), has_more: Type.Boolean() }),
  FactDecisionRequest: Type.Object({
    decision_id: id,
    request_id: id,
    expected_version: Type.Integer({ minimum: 0, description: 'Latest decision version observed by the reviewer; 0 when no decision exists.' }),
    identity: FactIdentityInputSchema,
    resolution: Type.Union([Type.Literal('selected'), Type.Literal('unresolved')]),
    selected_candidate_id: Type.Optional(id),
    reason: Type.String({ minLength: 1, maxLength: 2000 }),
  }, { additionalProperties: false }),
  FactDecisionResponse: Type.Object({
    decision_id: id,
    request_id: id,
    project_id: id,
    identity: FactIdentitySchema,
    fact_key_hash: hash,
    version: Type.Integer({ minimum: 1 }),
    resolution: Type.Union([Type.Literal('selected'), Type.Literal('unresolved')]),
    selected_candidate_id: Type.Union([id, Type.Null()]),
    reason: Type.String(),
    actor_kind: Type.Literal('user'),
    created_at: Type.String(),
    replayed: Type.Boolean(),
    verification_effect: Type.Literal('none', { description: 'A decision selects among source candidates but never verifies a source or upgrades a candidate.' }),
  }, { additionalProperties: false }),
  FactEvidenceReviewRequest: Type.Object({
    request_id: id,
    candidate_id: id,
    evidence_context_set_id: id,
    evidence_set_sha256: hash,
    assessments: Type.Array(FactEvidenceAssessmentSchema, { minItems: 1, maxItems: 500 }),
    reason: Type.String({ minLength: 1, maxLength: 2048 }),
  }, { additionalProperties: false }),
  FactEvidenceContextManifest: FactEvidenceContextManifestSchema,
  FactEvidenceContextResponse: Type.Object({
    evidence_context_set_id: id, owner_user_id: id, project_id: id, candidate_id: id,
    evidence_set_sha256: hash, completeness_status: Type.Union([Type.Literal('complete'), Type.Literal('incomplete')]),
    reviewable: Type.Boolean(), manifest: FactEvidenceContextManifestSchema,
  }, { additionalProperties: false }),
  FactEvidenceReviewerReadQuery: Type.Object({ cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })) }, { additionalProperties: false }),
  FactEvidenceReviewerReadResponse: Type.Object({
    project_id: id, candidate_id: id, evidence_context_set_id: id, evidence_set_sha256: hash,
    input_revision: Type.Integer({ minimum: 1 }), input_hash: hash,
    material_id: id, material_version: Type.Integer({ minimum: 1 }), material_sha256: hash,
    snapshot_id: id, parser_version: Type.String({ minLength: 1, maxLength: 128 }), parse_response_sha256: hash,
    candidate: Type.Object({
      identity: Type.Record(Type.String(), Type.Unknown()), identity_sha256: hash,
      value_kind: Type.Union([Type.Literal('decimal'), Type.Literal('text'), Type.Literal('unknown'), Type.Literal('not_applicable')]),
      value_decimal: Type.Union([Type.String(), Type.Null()]), value_text: Type.Union([Type.String(), Type.Null()]),
      source_kind: Type.Union([Type.Literal('audited'), Type.Literal('external'), Type.Literal('user_statement')]),
      source_ref: Type.String(), status: Type.Union([Type.Literal('extracted'), Type.Literal('verified'), Type.Literal('user_asserted'), Type.Literal('conflicted'), Type.Literal('needs_confirmation'), Type.Literal('superseded')]),
      uncertainty: Type.Array(Type.Unknown()), confidence: Type.Number({ minimum: 0, maximum: 1 }),
    }, { additionalProperties: false }),
    parse_warnings: Type.Array(Type.Object({ code: Type.String(), message: Type.String() }, { additionalProperties: false })),
    items: Type.Array(Type.Object({
      record_id: id, record_sha256: hash, content_sha256: hash,
      locator_type: Type.Union([Type.Literal('docx_block'), Type.Literal('pdf_bbox'), Type.Literal('xlsx_cell'), Type.Literal('csv_cell'), Type.Literal('text_line')]),
      locator: Type.Record(Type.String(), Type.Unknown()), literal_quote: Type.String({ minLength: 1, maxLength: 65536 }),
      confidence: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]), uncertainty: Type.Array(Type.Unknown()),
    }, { additionalProperties: false })),
    auxiliary_targets: Type.Array(Type.Object({
      target_id: id, kind: Type.Union([Type.Literal('header'), Type.Literal('footer'), Type.Literal('footnote'), Type.Literal('endnote'), Type.Literal('drawing'), Type.Literal('auxiliary_part')]),
      part_name: Type.String({ minLength: 1, maxLength: 1024 }), part_sha256: Type.Union([hash, Type.Null()]), target_sha256: Type.Union([hash, Type.Null()]),
      scope: Type.Record(Type.String(), Type.Unknown()),
      parse_status: Type.Union([Type.Literal('parsed'), Type.Literal('empty'), Type.Literal('not_extracted'), Type.Literal('read_failed'), Type.Literal('parse_failed'),
        Type.Literal('unsafe_xml'), Type.Literal('size_limited'), Type.Literal('unrecognized_part'), Type.Literal('external_relationship'), Type.Literal('missing_relationship'),
        Type.Literal('unsafe_relationship'), Type.Literal('missing_reference_target')]),
      relevance: Type.Union([Type.Literal('relevant'), Type.Literal('not_relevant'), Type.Literal('unknown')]), relevance_reason: Type.String(),
    }, { additionalProperties: false }), { maxItems: 1000 }),
    next_cursor: Type.Union([Type.String({ minLength: 1, maxLength: 2048 }), Type.Null()]),
    verification_effect: Type.Literal('none', { description: 'This read exposes evidence only; it does not mark a fact verified.' }),
  }, { additionalProperties: false }),
  FactEvidenceReviewResponse: Type.Object({
    review_id: id, request_id: id, owner_user_id: id, project_id: id,
    candidate_id: id, candidate_identity_sha256: hash, candidate_snapshot: Type.Record(Type.String(), Type.Unknown()),
    evidence_context_set_id: id, evidence_set_sha256: hash,
    input_revision: Type.Integer({ minimum: 1 }), input_hash: hash,
    material_id: id, material_version: Type.Integer({ minimum: 1 }), material_sha256: hash,
    snapshot_id: id, parser_version: id, parse_response_sha256: hash,
    source_kind: Type.Union([Type.Literal('audited'), Type.Literal('external')]),
    assessments: Type.Array(FactEvidenceAssessmentSchema),
    outcome: Type.Union([Type.Literal('evidence_impact_reviewed'), Type.Literal('external_evidence_impact_reviewed'), Type.Literal('needs_more_evidence')]),
    reviewer_user_id: id, reviewer_grant_id: id, authority: Type.Literal('fact_evidence_reviewer'),
    reason: Type.String(), reviewed_at: Type.String(), replayed: Type.Boolean(),
    verification_effect: Type.Literal('none', { description: 'Evidence review is an append-only audit event; it does not mutate candidate status, confidence, uncertainty, or audited/external source kind.' }),
  }, { additionalProperties: false }),
  FactEvidenceReviewWithdrawalRequest: Type.Object({ request_id: id, review_id: id, reason: Type.String({ minLength: 1, maxLength: 2048 }) }, { additionalProperties: false }),
  FactEvidenceReviewWithdrawalResponse: Type.Object({ withdrawal_id: id, review_id: id, reviewer_user_id: id, reviewer_grant_id: id,
    authority: Type.Literal('fact_evidence_reviewer'), reason: Type.String(), withdrawn_at: Type.String(), replayed: Type.Boolean() }, { additionalProperties: false }),
} as const;

export type FactCandidateListQuery = import('@sinclair/typebox').Static<typeof factSchemas.FactCandidateListQuery>;
export type FactCandidate = import('@sinclair/typebox').Static<typeof factSchemas.FactCandidate>;
export type FactDecisionRequest = import('@sinclair/typebox').Static<typeof factSchemas.FactDecisionRequest>;
export type FactDecisionResponse = import('@sinclair/typebox').Static<typeof factSchemas.FactDecisionResponse>;
export type FactEvidenceReviewRequest = import('@sinclair/typebox').Static<typeof factSchemas.FactEvidenceReviewRequest>;
export type FactEvidenceContextManifest = import('@sinclair/typebox').Static<typeof factSchemas.FactEvidenceContextManifest>;
export type FactEvidenceContextResponse = import('@sinclair/typebox').Static<typeof factSchemas.FactEvidenceContextResponse>;
export type FactEvidenceReviewerReadQuery = import('@sinclair/typebox').Static<typeof factSchemas.FactEvidenceReviewerReadQuery>;
export type FactEvidenceReviewerReadResponse = import('@sinclair/typebox').Static<typeof factSchemas.FactEvidenceReviewerReadResponse>;
export type FactEvidenceReviewResponse = import('@sinclair/typebox').Static<typeof factSchemas.FactEvidenceReviewResponse>;
export type FactEvidenceReviewWithdrawalRequest = import('@sinclair/typebox').Static<typeof factSchemas.FactEvidenceReviewWithdrawalRequest>;
export type FactEvidenceReviewWithdrawalResponse = import('@sinclair/typebox').Static<typeof factSchemas.FactEvidenceReviewWithdrawalResponse>;
