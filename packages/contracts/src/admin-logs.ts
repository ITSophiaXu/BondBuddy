import { RECOVERY_ROLE } from './account-recovery.js';
import { TRIAL_ALERT_KINDS } from './trial-guard.js';
import { OPS_SCHEDULER_ALERT_KINDS } from './ops-scheduler.js';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { RUN_CHANNELS, ARTIFACT_DELIVERY_STATUSES } from './run-channel.js';

// #79 operator surface. Only these DTOs leave the admin routes; none carries prompt plaintext
// except AdminPromptView, which needs the separate prompt_viewer grant and is always audited.
// log_operator performs writes (gate resume, usage corrections); log_reader is read-only.
export const OPERATOR_ROLES = ['log_reader', 'log_operator', 'prompt_viewer', RECOVERY_ROLE] as const;
export const OPS_ALERT_KINDS = ['log_sink_unavailable', 'log_backlog_stale', 'evidence_persist_failed', 'evidence_gate_paused', 'usage_conflict', 'retention_purge_failed', 'storage_orphan_candidates', 'payment_reconciliation_unresolved', 'payment_statement_difference', 'payment_statement_unavailable', ...TRIAL_ALERT_KINDS, ...OPS_SCHEDULER_ALERT_KINDS] as const;
export const EVIDENCE_GATE_STATES = ['open', 'paused'] as const;
export const LOG_CONTENT_STATES = ['available', 'purged'] as const;
export const LOG_CONTENT_TOMBSTONE_REASONS = ['retention_expired', 'user_deleted'] as const;
// Effective per-attempt usage after append-only corrections; conflict/unknown/pending stay unresolved.
export const ADMIN_USAGE_STATUSES = ['measured', 'pending', 'unknown', 'conflict'] as const;
export const ADMIN_ATTEMPT_STATUSES = ['pending_reconcile', 'confirmed_not_sent', 'completed', 'failed'] as const;
// Query parameters accepted by GET /admin/logs/events and /admin/metrics. Anything else is 422.
export const ERROR_RECOVERY_OUTCOMES = ['recovered', 'retried', 'retried_failed', 'not_retried', 'user_cancelled', 'pending_reconcile', 'retry_scheduled', 'terminal'] as const;
export const ADMIN_LOG_FILTERS = ['user_id', 'project_id', 'job_id', 'trace_id', 'from', 'to', 'model_id', 'status', 'error_code', 'error_category', 'fingerprint', 'limit'] as const;
export const ADMIN_LOG_PAGE_LIMIT = 500;

const obj = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const enumOf = <T extends readonly string[]>(values: T) => Type.Union(values.map(value => Type.Literal<T[number]>(value)));
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]{1,128}$' });
const utc = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const code = Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,63}$', description: 'Structured error code; never a message or stack.' });
const safeCode = Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' });
const count = Type.Integer({ minimum: 0 });
const tokens = nullable(count);

const TokenBreakdown = obj({ input_tokens: tokens, output_tokens: tokens, cached_input_tokens: tokens, reasoning_tokens: tokens });
const AdminLogEvent = obj({ event_id: id, kind: Type.String({ pattern: '^[a-z_]+\\.[a-z_]+$' }), occurred_at: utc, user_id: id, project_id: nullable(id), job_id: nullable(id), run_id: nullable(id), channel: enumOf(RUN_CHANNELS), trace_id: id, actor_type: enumOf(['user', 'system', 'operator'] as const), status: nullable(safeCode), stage: nullable(safeCode), error_code: nullable(code), error_id: nullable(id), logical_call_id: nullable(id), attempt_no: nullable(Type.Integer({ minimum: 1 })), prompt_snapshot_ref: nullable(id) });
const PromptRef = obj({ snapshot_id: id, kind: enumOf(['user_prompt', 'model_request', 'structured_input'] as const), version: Type.Integer({ minimum: 1 }), content_sha256: hash, redaction_version: safeCode, input_revision: nullable(Type.Integer({ minimum: 1 })), template_version: nullable(Type.String()), rule_pack_version: nullable(Type.String()), model_parameters_version: nullable(Type.String()), content_state: enumOf(LOG_CONTENT_STATES), created_at: utc });
const Attempt = obj({ attempt_id: id, logical_call_id: id, attempt_no: Type.Integer({ minimum: 1 }), channel: enumOf(RUN_CHANNELS), status: enumOf(ADMIN_ATTEMPT_STATUSES), model_id: nullable(Type.String({ maxLength: 128 })), provider_request_id: nullable(Type.String({ maxLength: 256 })), prompt_snapshot_ref: nullable(id), user_submission_id: nullable(id), usage_status: enumOf(ADMIN_USAGE_STATUSES), usage: TokenBreakdown, corrected: Type.Boolean(), duration_ms: nullable(count), error_code: nullable(code), created_at: utc });
const UserSubmission = obj({ submission_id: id, snapshot_id: id, kind: enumOf(['run_execute','project_message'] as const), message_id: nullable(id), message_version: nullable(Type.Integer({ minimum: 1 })), version: Type.Integer({ minimum: 1 }), previous_submission_id: nullable(id), content_sha256: hash, input_revision: nullable(Type.Integer({ minimum: 1 })), input_hash: nullable(hash), material_versions: Type.Array(obj({ material_id: id, material_version: Type.Integer({ minimum: 1 }) })), content_state: enumOf(LOG_CONTENT_STATES), created_at: utc });
const Stage = obj({ seq: Type.Integer({ minimum: 1 }), type: Type.String({ maxLength: 64 }), state: safeCode, stage: nullable(safeCode), reason: nullable(safeCode), occurred_at: utc });
const ErrorRow = obj({ error_id: id, code, category: safeCode, stage: nullable(safeCode), attempt_id: nullable(id), provider_status: nullable(Type.Integer({ minimum: 100, maximum: 599 })), provider_error_type: nullable(safeCode), retry_count: count, fingerprint: nullable(hash), safe_message: nullable(Type.String({ maxLength: 1024 })), safe_stack: nullable(Type.String({ maxLength: 2048 })), recovery_status: nullable(enumOf(ERROR_RECOVERY_OUTCOMES)), created_at: utc });
const Artifact = obj({ artifact_id: id, version: Type.Integer({ minimum: 1 }), sha256: hash, quality_status: enumOf(['pending', 'passed', 'failed'] as const), delivery_status: enumOf(['pending', ...ARTIFACT_DELIVERY_STATUSES, 'revoked'] as const), created_at: utc });
const Consumption = obj({ attempts: count, measured_attempts: count, unresolved_attempts: count, ...TokenBreakdown.properties });

export const adminSchemas = {
  AdminLogEventsResponse: obj({ items: Type.Array(AdminLogEvent, { maxItems: ADMIN_LOG_PAGE_LIMIT }), truncated: Type.Boolean() }),
  AdminErrorCountsResponse: obj({ items: Type.Array(obj({ error_code: code, error_category: safeCode, fingerprint: nullable(hash), count })), audit_id: id }),
  AdminUserSubmissionListResponse: obj({ job_id: id, items: Type.Array(UserSubmission), audit_id: id }),
  AdminJobTimelineResponse: obj({
    job: obj({ job_id: id, user_id: id, project_id: nullable(id), run_id: nullable(id), channel: enumOf(RUN_CHANNELS), operation_id: Type.Optional(nullable(id)), request_id: Type.Optional(nullable(id)), execution_request_id: Type.Optional(nullable(id)), execution_request_key_hash: Type.Optional(nullable(hash)), trace_id: nullable(id), input_revision: Type.Optional(nullable(Type.Integer({ minimum: 1 }))), input_hash: Type.Optional(nullable(hash)), job_type: safeCode, subtype: safeCode, state: safeCode, stage: nullable(safeCode), attempts: count, error_code: nullable(code), created_at: utc, updated_at: utc, duration_ms: nullable(count) }),
    prompts: Type.Array(PromptRef),
    user_submissions: Type.Array(UserSubmission),
    stages: Type.Array(Stage),
    attempts: Type.Array(Attempt),
    errors: Type.Array(ErrorRow),
    artifact: nullable(Artifact),
    outcome: obj({ state: safeCode, error_code: nullable(code), artifact_available: Type.Boolean() }),
    // All attempts including failed retries vs. attempts whose status is completed.
    consumption: obj({ all_attempts: Consumption, completed_attempts: Consumption })
  }),
  AdminMetricsResponse: obj({
    window: obj({ from: nullable(utc), to: nullable(utc) }),
    operations: obj({ submitted: count, rejected: count }),
    jobs: obj({ total: count, succeeded: count, failed: count, cancelled: count, rejected: Type.Optional(count), other: count, success_rate: nullable(Type.Number({ minimum: 0, maximum: 1 })), failure_rate: nullable(Type.Number({ minimum: 0, maximum: 1 })), duration_ms_avg: nullable(Type.Number({ minimum: 0 })), duration_ms_p95: nullable(Type.Number({ minimum: 0 })) }),
    attempts: obj({ total: count, completed: count, failed: count, pending_reconcile: count, confirmed_not_sent: count, conflict: count, duration_ms_avg: nullable(Type.Number({ minimum: 0 })) }),
    consumption: obj({ all_attempts: Consumption, completed_attempts: Consumption, retry_attempts: Consumption }),
    by_model: Type.Array(obj({ model_id: nullable(Type.String({ maxLength: 128 })), attempts: count, completed: count, failed: count, ...TokenBreakdown.properties })),
    errors: Type.Array(obj({ error_code: code, error_category: safeCode, fingerprint: nullable(hash), count }))
  }),
  AdminPromptView: obj({ snapshot_id: id, user_id: id, project_id: id, kind: enumOf(['user_prompt', 'model_request', 'structured_input'] as const), version: Type.Integer({ minimum: 1 }), content_sha256: hash, redaction_version: safeCode, media_type: Type.Literal('text/plain; charset=utf-8'), body: Type.String({ description: 'Redacted snapshot body; secrets/codes/cookies were scrubbed before storage.' }), audit_id: id }),
  AdminAlertsResponse: obj({ items: Type.Array(obj({ alert_id: id, kind: enumOf(OPS_ALERT_KINDS), severity: enumOf(['warning', 'critical'] as const), detail: Type.Record(Type.String({ pattern: '^[a-z_]{1,64}$' }), Type.Union([Type.String({ maxLength: 128 }), Type.Integer()])), created_at: utc, acked_at: nullable(utc) })) }),
  EvidenceGateResponse: obj({ state: enumOf(EVIDENCE_GATE_STATES), reason_code: nullable(safeCode), changed_at: nullable(utc), process_state: enumOf(EVIDENCE_GATE_STATES) }),
  EvidenceGateResumeRequest: obj({ reason_code: safeCode }),
  UsageCorrectionRequest: obj({ chosen_observation_id: nullable(id), usage_status: enumOf(['measured', 'unknown'] as const), reason_code: safeCode }),
  UsageCorrectionResponse: obj({ correction_id: id, attempt_id: id, usage_status: enumOf(['measured', 'unknown'] as const), usage: TokenBreakdown })
} as const;
export type AdminJobTimeline = Static<typeof adminSchemas.AdminJobTimelineResponse>;
export type AdminMetrics = Static<typeof adminSchemas.AdminMetricsResponse>;
export type OperatorRole = typeof OPERATOR_ROLES[number];
export type OpsAlertKind = typeof OPS_ALERT_KINDS[number];
