import { Type } from '@sinclair/typebox';

const id = Type.String({ minLength: 1, maxLength: 128 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const utc = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' });
const tieProof = Type.Object({ status: Type.Union([Type.Literal('clear'), Type.Literal('unresolved')]),
  thresholdRevenue: Type.String({ pattern: '^(0|[1-9][0-9]*)(?:\\.[0-9]+)?$' }),
  tiedBusinessCodes: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 200 }),
  evidence: Type.Array(id, { minItems: 1, maxItems: 200 }) }, { additionalProperties: false });
const sourceEvidence = Type.Object({ record_id: id, record_sha256: hash, locator_type: Type.String(),
  locator: Type.Record(Type.String(), Type.Unknown()), quote: Type.String(), context: Type.String() }, { additionalProperties: false });
const revenueBasis = Type.Object({ fiscalYear: Type.Integer({ minimum: 1900, maximum: 2200 }), accountingScope: Type.Literal('consolidated'),
  revenueBasis: Type.Literal('main_business_revenue'), currency: Type.String({ minLength: 1 }), unit: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const reviewableProfile = Type.Object({
  profile_id: id, profile_version: Type.Integer({ minimum: 1 }), profile_sha256: hash,
  input_revision: Type.Integer({ minimum: 1 }), input_hash: hash,
  source_material_id: id, source_material_version: Type.Integer({ minimum: 1 }), source_material_sha256: hash,
  parse_snapshot_id: id, parse_snapshot_sha256: hash, issuer_identity_record_id: id,
  issuer_identity_version: Type.Integer({ minimum: 1 }), issuer_identity_hash: hash, verified_entity_id: id,
  annual_revenue_basis: revenueBasis, annual_revenue_total: Type.String({ pattern: '^(0|[1-9][0-9]*)(?:\\.[0-9]+)?$' }),
  annual_revenue_total_evidence: Type.Array(id, { minItems: 1, maxItems: 200 }),
  third_place_tie_proof: tieProof, profile: Type.Record(Type.String(), Type.Unknown()),
  source_evidence: Type.Array(sourceEvidence, { maxItems: 200, description: 'Exact parser evidence anchors for reviewer verification; profile proof is not an automated industry signoff.' }),
  latest_decision: Type.Union([Type.Literal('pending_review'), Type.Literal('approve'), Type.Literal('request_more_evidence'), Type.Literal('withdraw')]),
  created_at: utc,
}, { additionalProperties: false });

export const issuerAnnualProfileReviewSchemas = {
  IssuerAnnualProfileReviewAction: Type.Union([Type.Literal('approve'), Type.Literal('request_more_evidence'), Type.Literal('withdraw')]),
  IssuerAnnualProfileReviewRequest: Type.Object({
    request_id: id, action: Type.Union([Type.Literal('approve'), Type.Literal('request_more_evidence'), Type.Literal('withdraw')]),
    reason: Type.String({ minLength: 1, maxLength: 2048 }),
    reviewer_attestation: Type.Literal('manual_source_evidence_review', { description: 'Reviewer checked exact source anchors, complete annual profile, same-basis total and third-place tie proof. This is not professional signoff.' }),
    profile_version: Type.Integer({ minimum: 1 }),
    profile_sha256: hash, input_revision: Type.Integer({ minimum: 1 }), input_hash: hash,
    source_material_sha256: hash, parse_snapshot_sha256: hash,
  }, { additionalProperties: false }),
  IssuerAnnualProfileReviewResponse: Type.Object({ review_id: id, profile_id: id,
    action: Type.Union([Type.Literal('approve'), Type.Literal('request_more_evidence'), Type.Literal('withdraw')]),
    created_at: utc, replayed: Type.Boolean() }),
  IssuerAnnualProfileReviewListResponse: Type.Object({ project_id: id, items: Type.Array(reviewableProfile, { maxItems: 50 }) }),
};
