import { Type, type Static, type TObject, type TProperties } from '@sinclair/typebox';

const strict = <T extends TProperties>(properties: T): TObject<T> => Type.Object(properties, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 128 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const utc = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' });

/** Consent names one immutable quote. Prices, plans and execution authority
 * remain server-derived; confirming a quote alone never adopts or debits. */
export const RunSupplementAdoptRequestSchema = strict({ request_id: id, quote_id: id, confirmation_id: id, quote_hash: hash });
export const RunSupplementAdoptionQuerySchema = strict({ request_id: id });
const receipt = { adoption_id: id, request_id: id, project_id: id, run_id: id, job_id: id,
  execution_version: Type.Literal(2), input_revision: Type.Integer({ minimum: 1 }), input_hash: hash,
  quote_id: id, confirmation_id: id, quote_hash: hash, adopted_at: utc };

/** This is the immutable adoption receipt, not the run's current queue state.
 * Exact replay remains meaningful after the worker has advanced or completed. */
export const RunSupplementAdoptionSchema = Type.Union([
  strict({ ...receipt, assignment_kind: Type.Literal('rework'),
    additional_points: Type.Integer({ minimum: 1, maximum: 1000000000 }), billing_segment_id: id, reservation_id: id }),
  strict({ ...receipt, assignment_kind: Type.Literal('carry'), additional_points: Type.Literal(0),
    billing_segment_id: id, reservation_id: id }),
  strict({ ...receipt, assignment_kind: Type.Literal('unbilled'), additional_points: Type.Literal(0),
    billing_segment_id: Type.Null(), reservation_id: Type.Null() }),
]);
export const RunSupplementAdoptionResponseSchema = strict({ adoption: RunSupplementAdoptionSchema });
export type RunSupplementAdoptRequest = Static<typeof RunSupplementAdoptRequestSchema>;
export type RunSupplementAdoptionQuery = Static<typeof RunSupplementAdoptionQuerySchema>;
export type RunSupplementAdoption = Static<typeof RunSupplementAdoptionSchema>;
export type RunSupplementAdoptionResponse = Static<typeof RunSupplementAdoptionResponseSchema>;
export const runSupplementAdoptionSchemas = { RunSupplementAdoptRequest: RunSupplementAdoptRequestSchema,
  RunSupplementAdoptionQuery: RunSupplementAdoptionQuerySchema, RunSupplementAdoption: RunSupplementAdoptionSchema,
  RunSupplementAdoptionResponse: RunSupplementAdoptionResponseSchema };
