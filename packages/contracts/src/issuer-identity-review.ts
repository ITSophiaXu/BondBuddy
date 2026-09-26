import { Type } from '@sinclair/typebox';

const id = Type.String({ minLength: 1, maxLength: 128 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const utc = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' });
export const ISSUER_IDENTITY_REVIEW_DECISIONS = ['verified', 'rejected', 'conflict'] as const;
export const ISSUER_IDENTITY_OBSERVATION_STATES = ['needs_review', ...ISSUER_IDENTITY_REVIEW_DECISIONS] as const;
export const VERIFIED_ISSUER_ENTITY_PATTERN = '^(?:uscc:[0-9A-HJ-NPQRTUWXY]{18}|entity:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$';
export const ISSUER_ENTITY_BASIS_KINDS = ['uscc', 'registry_record', 'manual_attestation'] as const;
const reason = Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' });
const basis = Type.String({ minLength: 1, maxLength: 512 });
export const issuerIdentityReviewSchemas = {
  IssuerIdentityReviewRequest: Type.Union([
    Type.Object({ decision: Type.Literal('verified'), reason_code: reason,
      verified_entity_id: Type.String({ pattern: VERIFIED_ISSUER_ENTITY_PATTERN }),
      entity_basis_kind: Type.Union(ISSUER_ENTITY_BASIS_KINDS.map(value => Type.Literal(value))),
      entity_basis_ref: basis }, { additionalProperties: false }),
    Type.Object({ decision: Type.Literal('rejected'), reason_code: reason }, { additionalProperties: false }),
    Type.Object({ decision: Type.Literal('conflict'), reason_code: reason }, { additionalProperties: false }),
  ]),
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
      quote: Type.String(), issuer_display_name: Type.String(),
      candidate_key: Type.String({ minLength: 1, maxLength: 128, description: 'Review-only candidate clustering key; production issuer-name:v1 is not a legal entity ID.' }),
      verified_entity_id: Type.Union([Type.String({ pattern: VERIFIED_ISSUER_ENTITY_PATTERN }), Type.Null()]),
      entity_basis_kind: Type.Union([...ISSUER_ENTITY_BASIS_KINDS.map(value => Type.Literal(value)), Type.Null()]),
      entity_basis_ref: Type.Union([basis, Type.Null()]),
      status: Type.Union(ISSUER_IDENTITY_OBSERVATION_STATES.map(value => Type.Literal(value))),
      reviewed_at: Type.Union([utc, Type.Null()]),
    })),
  }),
};
