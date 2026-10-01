import { Type, type Static } from '@sinclair/typebox';

const id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const reason = Type.String({ minLength: 1, maxLength: 4096 });

export const ProductionRulePackReleaseCreateRequestSchema = Type.Object({
  request_id: id,
  manifest_id: id,
  manifest_version: Type.Integer({ minimum: 1, maximum: 2147483647 }),
  manifest_content_hash: hash,
  reason,
}, { additionalProperties: false });

export const ProductionRulePackReleaseActionRequestSchema = Type.Object({
  request_id: id,
  target_event_id: id,
  reason,
}, { additionalProperties: false });

/** Small immutable response for production release/withdrawal/rollback events. */
export const ProductionRulePackReleaseEventSchema = Type.Object({
  id,
  pack_id: id,
  request_id: id,
  sequence: Type.Integer({ minimum: 1 }),
  action: Type.Union([Type.Literal('production_release'), Type.Literal('production_withdrawal'), Type.Literal('production_rollback')]),
  pack_version: Type.String({ minLength: 1, maxLength: 128 }),
  content_hash: hash,
  target_event_id: Type.Union([id, Type.Null()]),
  manifest_id: Type.Union([id, Type.Null()]),
  manifest_version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  manifest_content_sha256: Type.Union([hash, Type.Null()]),
  industry_attestation_event_id: Type.Union([id, Type.Null()]),
  technical_attestation_event_id: Type.Union([id, Type.Null()]),
  operator_user_id: id,
  operator_grant_id: id,
  reason,
  occurred_at: Type.String({ format: 'date-time' }),
}, { additionalProperties: false });

export const productionRulePackReleaseSchemas = {
  ProductionRulePackReleaseCreateRequest: ProductionRulePackReleaseCreateRequestSchema,
  ProductionRulePackReleaseActionRequest: ProductionRulePackReleaseActionRequestSchema,
  ProductionRulePackReleaseEvent: ProductionRulePackReleaseEventSchema,
} as const;

export type ProductionRulePackReleaseCreateRequest = Static<typeof ProductionRulePackReleaseCreateRequestSchema>;
export type ProductionRulePackReleaseActionRequest = Static<typeof ProductionRulePackReleaseActionRequestSchema>;
export type ProductionRulePackReleaseEvent = Static<typeof ProductionRulePackReleaseEventSchema>;
