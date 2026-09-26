import { Type } from '@sinclair/typebox';

const id = Type.String({ minLength: 1, maxLength: 128 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const utc = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' });
export const ISSUER_IDENTITY_REVIEW_DECISIONS = ['verified', 'rejected', 'conflict'] as const;
export const ISSUER_IDENTITY_OBSERVATION_STATES = ['needs_review', ...ISSUER_IDENTITY_REVIEW_DECISIONS] as const;
export const issuerIdentityReviewSchemas = {
  IssuerIdentityReviewRequest: Type.Object({
    decision: Type.Union(ISSUER_IDENTITY_REVIEW_DECISIONS.map(value => Type.Literal(value))),
    reason_code: Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' }),
  }, { additionalProperties: false }),
  IssuerIdentityReviewResponse: Type.Object({
    review_id: id, source_record_id: id,
    decision: Type.Union(ISSUER_IDENTITY_REVIEW_DECISIONS.map(value => Type.Literal(value))),
    created_at: utc, replayed: Type.Boolean(),
  }),
  IssuerIdentityObservationListResponse: Type.Object({
    project_id: id, material_id: id, material_version: Type.Integer({ minimum: 1 }),
    status: Type.Union(ISSUER_IDENTITY_OBSERVATION_STATES.map(value => Type.Literal(value))),
    items: Type.Array(Type.Object({
      source_record_id: id, identity_version: Type.Integer({ minimum: 1 }), snapshot_id: id,
      evidence_record_id: id, source_record_sha256: hash, source_content_sha256: hash,
      content_sha256: hash, locator_type: Type.String(), locator: Type.Record(Type.String(), Type.Unknown()),
      quote: Type.String(), issuer_display_name: Type.String(), entity_id: id,
      status: Type.Union(ISSUER_IDENTITY_OBSERVATION_STATES.map(value => Type.Literal(value))),
      reviewed_at: Type.Union([utc, Type.Null()]),
    })),
  }),
};
