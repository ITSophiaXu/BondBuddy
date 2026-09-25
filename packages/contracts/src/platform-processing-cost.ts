import { Type, type Static, type TSchema } from '@sinclair/typebox';

// Internal #76/#79 handoff for platform-paid source-preflight processing. This is
// deliberately separate from model-attempt usage and is never a user wallet entry.
export const PLATFORM_PROCESSING_COST_EVENT_KIND = 'platform.processing_cost' as const;
export const PROCESSING_COST_STAGES = ['ocr', 'parse'] as const;
export const PROCESSING_COST_UNITS = ['ocr_page', 'document'] as const;
export const PROCESSING_COST_OUTCOMES = ['succeeded', 'failed'] as const;

const obj = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 128 });

export const PlatformProcessingCostPayloadSchema = obj({
  job_id: id,
  material_id: id,
  material_version: Type.Integer({ minimum: 1 }),
  stage: Type.Union(PROCESSING_COST_STAGES.map(value => Type.Literal(value))),
  attempt: Type.Integer({ minimum: 1 }),
  unit: Type.Union(PROCESSING_COST_UNITS.map(value => Type.Literal(value))),
  // null means the consumed quantity could not be measured after an interrupted attempt.
  quantity: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  processing_ms: Type.Integer({ minimum: 1 }),
  billable: Type.Literal(false),
  cost_payer: Type.Literal('platform'),
  pricing_status: Type.Literal('unknown'),
  unit_price_ref: Type.Null(),
  outcome: Type.Union(PROCESSING_COST_OUTCOMES.map(value => Type.Literal(value))),
  ocr_pages: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  ocr_engine: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()])),
  ocr_engine_version: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()])),
});

export const PlatformProcessingCostEventSchema = obj({
  kind: Type.Literal(PLATFORM_PROCESSING_COST_EVENT_KIND),
  payload: PlatformProcessingCostPayloadSchema,
});

export const platformProcessingCostSchemas = {
  PlatformProcessingCostPayload: PlatformProcessingCostPayloadSchema,
  PlatformProcessingCostEvent: PlatformProcessingCostEventSchema,
} as const;

export type PlatformProcessingCostPayload = Static<typeof PlatformProcessingCostPayloadSchema>;
export type PlatformProcessingCostEvent = Static<typeof PlatformProcessingCostEventSchema>;
