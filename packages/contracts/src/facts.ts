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
} as const;

export type FactCandidateListQuery = import('@sinclair/typebox').Static<typeof factSchemas.FactCandidateListQuery>;
export type FactCandidate = import('@sinclair/typebox').Static<typeof factSchemas.FactCandidate>;
export type FactDecisionRequest = import('@sinclair/typebox').Static<typeof factSchemas.FactDecisionRequest>;
export type FactDecisionResponse = import('@sinclair/typebox').Static<typeof factSchemas.FactDecisionResponse>;
