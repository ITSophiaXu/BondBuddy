import { Type, type Static, type TObject, type TProperties } from '@sinclair/typebox';
import { BILLING_TASKS } from './billing.js';
import { M4_DOCUMENT_BILLING_TASKS } from './m4-document-types.js';

const strict = <T extends TProperties>(properties: T): TObject<T> => Type.Object(properties, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 128 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const revision = Type.Integer({ minimum: 1 });
const points = Type.Integer({ minimum: 0, maximum: 1000000000 });
const positivePoints = Type.Integer({ minimum: 1, maximum: 1000000000 });
const utc = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' });
const taskType = Type.Union([
  ...Object.keys(BILLING_TASKS).map(task => Type.Literal(task as keyof typeof BILLING_TASKS)),
  ...Object.values(M4_DOCUMENT_BILLING_TASKS).map(task => Type.Literal(task)),
]);
const target = { target_id: id, document_name: Type.String({ minLength: 1, maxLength: 500 }) };

/** One business document may produce several delivery variants; those are not extra priced targets. */
export const RunSupplementQuoteItemSchema = Type.Union([
  strict({ ...target, needs_redo: Type.Literal(false), task_type: Type.Null(), price_version: Type.Null(),
    full_price_points: Type.Null(), points: Type.Literal(0) }),
  strict({ ...target, needs_redo: Type.Literal(true), task_type: taskType, price_version: id,
    full_price_points: positivePoints, points: positivePoints }),
]);

/** The server derives the price and private processing basis from this exact saved preparation. */
export const RunSupplementQuoteRequestSchema = strict({
  request_id: id, supplement_revision: revision, saved_request_id: id, candidate_input_hash: hash,
});

/** A frozen B1 quotation is neither execution authority nor a reservation or payment. */
export const RunSupplementQuoteSchema = strict({
  quote_id: id, project_id: id, run_id: id, supplement_revision: revision, saved_request_id: id,
  pricing_rule: Type.Literal('b1_full_document_v1'),
  items: Type.Array(RunSupplementQuoteItemSchema, { minItems: 1, maxItems: 1 }),
  total_points: points, quote_hash: hash, created_at: utc, expires_at: utc,
});

/** Explicitly acknowledges one exact quotation; it does not adopt materials or resume work. */
export const RunSupplementQuoteConfirmRequestSchema = strict({ request_id: id, quote_hash: hash });
export const RunSupplementQuoteConfirmationSchema = strict({
  confirmation_id: id, quote_id: id, project_id: id, run_id: id, request_id: id,
  quote_hash: hash, total_points: points, confirmed_at: utc,
});
export const RunSupplementQuoteResponseSchema = strict({
  quote: RunSupplementQuoteSchema,
  confirmation: Type.Union([RunSupplementQuoteConfirmationSchema, Type.Null()]),
});

export type RunSupplementQuoteItem = Static<typeof RunSupplementQuoteItemSchema>;
export type RunSupplementQuoteRequest = Static<typeof RunSupplementQuoteRequestSchema>;
export type RunSupplementQuote = Static<typeof RunSupplementQuoteSchema>;
export type RunSupplementQuoteConfirmRequest = Static<typeof RunSupplementQuoteConfirmRequestSchema>;
export type RunSupplementQuoteConfirmation = Static<typeof RunSupplementQuoteConfirmationSchema>;
export type RunSupplementQuoteResponse = Static<typeof RunSupplementQuoteResponseSchema>;
export const runSupplementQuoteSchemas = {
  RunSupplementQuoteItem: RunSupplementQuoteItemSchema,
  RunSupplementQuoteRequest: RunSupplementQuoteRequestSchema,
  RunSupplementQuote: RunSupplementQuoteSchema,
  RunSupplementQuoteConfirmRequest: RunSupplementQuoteConfirmRequestSchema,
  RunSupplementQuoteConfirmation: RunSupplementQuoteConfirmationSchema,
  RunSupplementQuoteResponse: RunSupplementQuoteResponseSchema,
};
