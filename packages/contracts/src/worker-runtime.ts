import { Type, type Static, type TSchema } from '@sinclair/typebox';

// #17 worker runtime and public event streams. Kept in its own module so parallel PRs that
// append to index.ts do not collide; index.ts only re-exports and spreads these values.

// Run pipeline stages in execution order. A stage without an installed implementation pauses
// the run at `capability_not_ready`; it never reports success.
export const RUN_PIPELINE_SUBTYPE = 'update_pipeline_v1' as const;
// Shared server limits for a complete, host-verified file-authoring recovery snapshot.
export const FILE_AUTHORING_RECOVERY_LIMITS = { files: 4096, fileBytes: 100 * 1024 * 1024, totalBytes: 512 * 1024 * 1024 } as const;
export const RUN_PIPELINE_STAGES = ['input_lock', 'materials_ready', 'model_generation', 'word_delivery'] as const;
// Paused-run stages the runtime understands. `provider_reconcile` is shared with #16.
export const RUN_PAUSE_STAGES = ['capability_not_ready', 'awaiting_materials', 'provider_reconcile', 'billing_reconcile', 'trial_limit', 'user_paused', 'credits_exhausted'] as const;
// Reasons written to bb_run_events.payload.reason by the runtime (in addition to the existing queue reasons).
export const RUN_RUNTIME_REASONS = ['stage_completed', 'stage_not_implemented', 'material_parse_pending', 'material_parse_failed', 'materials_ready', 'provider_reconciled', 'lease_released', 'run_input_changed', 'model_tokens_per_user_per_day', 'kill_switch', 'trial_limit_cleared', 'file_authoring_payload_recovery_pending', 'file_authoring_payload_retry_scheduled', 'file_authoring_payload_recovery_unavailable', 'file_authoring_payload_retries_exhausted', 'file_authoring_output_limit_recovery_pending', 'file_authoring_output_limit_retry_scheduled', 'file_authoring_output_limit_recovery_unavailable', 'file_authoring_output_limit_retries_exhausted', 'file_authoring_timeout_recovery_pending', 'file_authoring_timeout_retry_scheduled', 'file_authoring_timeout_recovery_unavailable', 'file_authoring_timeout_retries_exhausted', 'file_authoring_manual_restart_scheduled'] as const;

// Parse jobs: OCR is a checkpointed stage once a server-side OCR processor is configured.
export const MATERIAL_PARSE_OCR_STAGE = 'ocr_evidence' as const;
// Emitted when the runtime re-queues a paused parse job (e.g. OCR became available).
export const MATERIAL_PARSE_RUNTIME_EVENT_TYPES = ['material_parse.resumed'] as const;

// SSE: `event:` names. Every event with a persisted sequence carries `id: <seq>` so a client
// reconnects with Last-Event-ID; `snapshot` (no id) is sent first when no cursor is given.
export const STREAM_EVENT_NAMES = ['snapshot', 'run.state_changed', 'run.progress', 'job.state_changed', 'stream.end'] as const;
export const STREAM_END_REASONS = ['terminal', 'max_duration', 'client_closed'] as const;
export const STREAM_LIMITS = { maxDurationMs: 25_000, pollMs: 1_000, retryMs: 2_000, pageSize: 100 } as const;

const obj = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const enumOf = <T extends readonly string[]>(values: T) => Type.Union(values.map(value => Type.Literal<T[number]>(value)));
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const id = Type.String({ minLength: 1, maxLength: 128 });
const utc = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' });
const safeCode = Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' });
const jobState = enumOf(['queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled'] as const);
const errorCode = Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,63}$' });

// `data:` of a parse-job stream event. Only state metadata; never parser output or material text.
const JobStreamEventSchema = obj({
  event_id: id, schema_version: Type.Literal(1), job_id: id, job_type: Type.Literal('parse'), seq: Type.Integer({ minimum: 1 }),
  occurred_at: utc, type: Type.String({ pattern: '^material_parse\\.[a-z_]+$' }), state: jobState, stage: nullable(Type.String()),
  payload: obj({ reason: Type.Optional(safeCode), error_code: Type.Optional(errorCode), attempts: Type.Optional(Type.Integer({ minimum: 0 })), outcome: Type.Optional(safeCode) })
});
const StreamEndSchema = obj({ reason: enumOf(STREAM_END_REASONS), last_event_id: nullable(Type.Integer({ minimum: 0 })) });

export const runtimeSchemas = {
  JobStreamEvent: JobStreamEventSchema,
  StreamEnd: StreamEndSchema,
};
export type JobStreamEvent = Static<typeof JobStreamEventSchema>;
export type StreamEnd = Static<typeof StreamEndSchema>;
