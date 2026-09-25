import { Type, type Static, type TSchema } from '@sinclair/typebox';

// #35 controlled trial: quotas, abuse limits, operator overrides, platform cost ledger,
// liveness/readiness and trial alerts. Kept in its own module so parallel PRs that append to
// index.ts do not collide; index.ts only re-exports and spreads these values.
// M1 does not charge users: there are no credits, prices or payment fields here.

// Public API error codes added to ERROR_CODES.
// TRIAL_QUOTA_EXCEEDED (429): a per-user, per-source or global trial limit is reached.
// TRIAL_ACCESS_DENIED (403): an operator deny override is active for the account.
// MODEL_CALLS_SUSPENDED (503): the emergency kill switch stops new model work.
export const TRIAL_GUARD_ERROR_CODES = ['TRIAL_QUOTA_EXCEEDED', 'TRIAL_ACCESS_DENIED', 'MODEL_CALLS_SUSPENDED'] as const;
// Which limit rejected the request. Stored on the quota alert and in the rejection log detail.
export const TRIAL_LIMIT_KINDS = [
  'active_runs_per_user', 'runs_per_user_per_day', 'upload_bytes_per_user_per_day', 'model_tokens_per_user_per_day',
  'global_active_runs', 'kill_switch', 'operator_deny',
  'projects_per_user_per_day', 'projects_per_source_per_hour', 'uploads_per_user_per_hour', 'uploads_per_source_per_hour'
] as const;
// Admission events counted for abuse limits (the source is stored only as a keyed hash).
export const TRIAL_ADMISSION_KINDS = ['project_create', 'upload_create', 'run_submit'] as const;
export const TRIAL_OVERRIDE_EFFECTS = ['allow', 'deny'] as const;
export const TRIAL_KILL_SWITCH_STATES = ['engaged', 'released'] as const;
// Appended to OPS_ALERT_KINDS (admin-logs.ts) and the bb_ops_alerts kind check (migration 0025).
export const TRIAL_ALERT_KINDS = ['worker_heartbeat_stale', 'queue_backlog_stale', 'error_rate_spike', 'trial_quota_exhausted'] as const;
export const READINESS_CHECKS = ['database', 'blob_storage', 'evidence_gate', 'worker_heartbeat'] as const;
export const READINESS_CHECK_STATES = ['ok', 'failed', 'paused', 'stale', 'missing'] as const;
// #16 decision: the supplier rate is unconfirmed, so every cost record carries pricing_status=unknown and no amount.
export const TRIAL_PRICING_STATUS = 'unknown' as const;

const obj = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const enumOf = <T extends readonly string[]>(values: T) => Type.Union(values.map(value => Type.Literal<T[number]>(value)));
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]{1,128}$' });
const utc = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' });
const day = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Trial accounting day in the configured trial time zone.' });
const safeCode = Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' });
const count = Type.Integer({ minimum: 0 });
const tokens = obj({ input_tokens: count, output_tokens: count, cached_input_tokens: count, reasoning_tokens: count });

const TrialLimitsSchema = obj({
  enabled: Type.Boolean(), day_time_zone: Type.String({ pattern: '^[A-Za-z_]+(?:/[A-Za-z_+-]+)*$' }),
  active_runs_per_user: count, runs_per_user_per_day: count, upload_bytes_per_user_per_day: count, model_tokens_per_user_per_day: count,
  unknown_usage_tokens_per_attempt: count, global_active_runs: count,
  projects_per_user_per_day: count, projects_per_source_per_hour: count, uploads_per_user_per_hour: count, uploads_per_source_per_hour: count,
  kill_switch_config: Type.Boolean()
});
const KillSwitchSchema = obj({ engaged: Type.Boolean(), config_engaged: Type.Boolean(), operator_state: nullable(enumOf(TRIAL_KILL_SWITCH_STATES)), reason_code: nullable(safeCode), changed_at: nullable(utc) });
const OverrideSchema = obj({ override_id: id, user_id: id, effect: enumOf(TRIAL_OVERRIDE_EFFECTS), reason_code: safeCode, created_at: utc, expires_at: nullable(utc), revoked_at: nullable(utc) });
const usageRow = obj({
  day, user_id: nullable(id), runs_created: count, runs_finished: count, run_duration_ms: count,
  attempts: count, measured_attempts: count, unresolved_attempts: count, model_call_duration_ms: count,
  measured_tokens: tokens, conservative_tokens: count, upload_bytes: count, pricing_status: Type.Literal(TRIAL_PRICING_STATUS)
});

export const trialSchemas = {
  LivenessResponse: obj({ status: Type.Literal('ok'), service: Type.Literal('bondbuddy-m1-api') }),
  ReadinessResponse: obj({
    status: enumOf(['ready', 'not_ready'] as const),
    checks: obj({ database: enumOf(READINESS_CHECK_STATES), blob_storage: enumOf(READINESS_CHECK_STATES), evidence_gate: enumOf(READINESS_CHECK_STATES), worker_heartbeat: enumOf(READINESS_CHECK_STATES) }),
    worker_heartbeat_age_seconds: nullable(count), checked_at: utc
  }),
  AdminTrialStatusResponse: obj({
    limits: TrialLimitsSchema, kill_switch: KillSwitchSchema, global_active_runs: count,
    workers: Type.Array(obj({ worker_id: id, last_seen_at: utc, age_seconds: count, kinds: Type.Array(enumOf(['run', 'parse'] as const)), concurrency: Type.Integer({ minimum: 1, maximum: 16 }) })),
    oldest_queued_age_seconds: nullable(count)
  }),
  AdminTrialUsageResponse: obj({ from: day, to: day, day_time_zone: Type.String(), pricing_status: Type.Literal(TRIAL_PRICING_STATUS), per_user: Type.Array(usageRow), totals: Type.Array(usageRow) }),
  AdminCostLedgerResponse: obj({
    pricing_status: Type.Literal(TRIAL_PRICING_STATUS),
    items: Type.Array(obj({
      attempt_id: id, user_id: id, job_id: id, run_id: nullable(id), logical_call_id: id, attempt_no: Type.Integer({ minimum: 1 }), model_id: nullable(Type.String({ pattern: '^[A-Za-z0-9._-]{1,128}$' })),
      call_status: safeCode, usage_status: enumOf(['measured', 'pending', 'unknown', 'conflict'] as const), input_tokens: nullable(count), output_tokens: nullable(count),
      cached_input_tokens: nullable(count), reasoning_tokens: nullable(count), conservative_tokens: count, duration_ms: nullable(count),
      pricing_status: Type.Literal(TRIAL_PRICING_STATUS), cost_amount: Type.Null({ description: 'No price is confirmed for M1 (#16); never 0.' }), created_at: utc
    })),
    next_cursor: nullable(Type.String({ minLength: 1 }))
  }),
  TrialOverrideRequest: obj({ user_id: id, effect: enumOf(TRIAL_OVERRIDE_EFFECTS), reason_code: safeCode, expires_at: Type.Optional(nullable(utc)) }),
  TrialOverrideResponse: OverrideSchema,
  TrialOverridesResponse: obj({ items: Type.Array(OverrideSchema) }),
  TrialOverrideRevokeRequest: obj({ reason_code: safeCode }),
  KillSwitchRequest: obj({ state: enumOf(TRIAL_KILL_SWITCH_STATES), reason_code: safeCode }),
  KillSwitchResponse: KillSwitchSchema
} as const;

// Operator routes (log_reader reads, log_operator writes); all return the owner-safe 404 without a grant.
export const TRIAL_ADMIN_OPERATIONS = [
  { method: 'get', path: '/admin/trial/status', summary: 'Trial limits, kill switch, active runs, worker heartbeats and queue age (log_reader)', response: 'AdminTrialStatusResponse', status: 200, errors: [404] },
  { method: 'get', path: '/admin/trial/usage', summary: 'Daily tokens, runs, uploads and duration per user and in total; pricing_status=unknown (log_reader)', response: 'AdminTrialUsageResponse', status: 200, errors: [404, 422] },
  { method: 'get', path: '/admin/trial/cost-ledger', summary: 'Per-attempt platform cost records; pricing_status=unknown, cost_amount=null (log_reader)', response: 'AdminCostLedgerResponse', status: 200, errors: [404, 422] },
  { method: 'get', path: '/admin/trial/overrides', summary: 'List active trial allow/deny overrides (log_reader)', response: 'TrialOverridesResponse', status: 200, errors: [404] },
  { method: 'post', path: '/admin/trial/overrides', summary: 'Append an allow/deny override for an account (log_operator)', response: 'TrialOverrideResponse', status: 201, request: 'TrialOverrideRequest', errors: [404, 422] },
  { method: 'post', path: '/admin/trial/overrides/{override_id}/revoke', summary: 'Revoke an override once (log_operator)', response: 'TrialOverrideResponse', status: 200, request: 'TrialOverrideRevokeRequest', errors: [404, 409] },
  { method: 'post', path: '/admin/trial/kill-switch', summary: 'Engage or release the emergency stop for new model work (log_operator)', response: 'KillSwitchResponse', status: 200, request: 'KillSwitchRequest', errors: [404, 409] }
] as const;

/** Public probes; unauthenticated, no dependency detail beyond check states. */
export function trialOpenApiPaths(ref: (name: 'LivenessResponse' | 'ReadinessResponse') => unknown) {
  const json = (name: 'LivenessResponse' | 'ReadinessResponse') => ({ 'application/json': { schema: ref(name) } });
  return {
    '/api/v1/health': { get: { summary: 'Liveness: the API process is running', 'x-implementation-status': 'implemented; public', security: [], responses: { '200': { description: 'Process is live; dependencies not checked', content: json('LivenessResponse') } } } },
    '/api/v1/ready': { get: { summary: 'Readiness: database, private Blob, evidence gate and worker heartbeat freshness', 'x-implementation-status': 'implemented; public', security: [], responses: { '200': { description: 'All checks ok', content: json('ReadinessResponse') }, '503': { description: 'At least one check failed; same body', content: json('ReadinessResponse') } } } }
  };
}

export type TrialGuardErrorCode = typeof TRIAL_GUARD_ERROR_CODES[number];
export type TrialLimitKind = typeof TRIAL_LIMIT_KINDS[number];
export type TrialAdmissionKind = typeof TRIAL_ADMISSION_KINDS[number];
export type TrialOverrideEffect = typeof TRIAL_OVERRIDE_EFFECTS[number];
export type TrialLimits = Static<typeof TrialLimitsSchema>;
export type ReadinessResponse = Static<typeof trialSchemas.ReadinessResponse>;
export type AdminTrialUsageResponse = Static<typeof trialSchemas.AdminTrialUsageResponse>;
export type AdminCostLedgerResponse = Static<typeof trialSchemas.AdminCostLedgerResponse>;
