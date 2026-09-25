import { Type, type Static, type TSchema } from '@sinclair/typebox';

// #79/#16 operator-only platform probe. A log_operator enqueues one fixed synthetic prompt
// template; the worker runs it through the contained model adapter and the durable journal,
// so the normal attempt, usage, runtime and cost-ledger rows are written. The probe is owned
// by the reserved platform principal (migration 0027), never touches user data and has no
// user-facing route. Kept in its own module; index.ts only re-exports it.
export const PLATFORM_PROBE_JOB_TYPE = 'platform_probe' as const;
export const PLATFORM_PROBE_JOB_SUBTYPE = 'model_probe' as const;
// Fixed, versioned, synthetic templates. The prompt text lives server-side in the worker.
export const PLATFORM_PROBE_TEMPLATE_IDS = ['bb_probe_json_echo_v1'] as const;
export const PLATFORM_PROBE_STATES = ['queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled'] as const;

const obj = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const enumOf = <T extends readonly string[]>(values: T) => Type.Union(values.map(value => Type.Literal<T[number]>(value)));
const id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]{1,128}$' });
const safeCode = Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' });
const utc = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' });

export const platformProbeSchemas = {
  PlatformProbeRequest: obj({
    template_id: enumOf(PLATFORM_PROBE_TEMPLATE_IDS),
    // Idempotency key: the same request_id always returns the same probe.
    request_id: Type.String({ minLength: 8, maxLength: 96, pattern: '^[A-Za-z0-9_-]{8,96}$' }),
    reason_code: safeCode
  }),
  PlatformProbeResponse: obj({
    probe_id: id, job_id: id, run_id: id, trace_id: id,
    job_type: Type.Literal(PLATFORM_PROBE_JOB_TYPE), subtype: Type.Literal(PLATFORM_PROBE_JOB_SUBTYPE),
    template_id: enumOf(PLATFORM_PROBE_TEMPLATE_IDS), state: enumOf(PLATFORM_PROBE_STATES),
    replayed: Type.Boolean(), created_at: utc,
    // Read the evidence with GET /api/v1/admin/jobs/{job_id}/timeline (log_reader).
    timeline_path: Type.String({ pattern: '^/api/v1/admin/jobs/[A-Za-z0-9_-]{1,128}/timeline$' })
  })
} as const;

export const PLATFORM_PROBE_ADMIN_OPERATIONS = [
  { method: 'post', path: '/admin/probes/model', summary: 'Enqueue the fixed synthetic model probe as a platform job (log_operator); trial kill switch and quotas apply', response: 'PlatformProbeResponse', status: 202, request: 'PlatformProbeRequest', errors: [403, 404, 422, 429, 503] }
] as const;

export type PlatformProbeTemplateId = typeof PLATFORM_PROBE_TEMPLATE_IDS[number];
export type PlatformProbeRequest = Static<typeof platformProbeSchemas.PlatformProbeRequest>;
export type PlatformProbeResponse = Static<typeof platformProbeSchemas.PlatformProbeResponse>;
