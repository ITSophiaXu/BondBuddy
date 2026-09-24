import { Type, type Static, type TSchema } from '@sinclair/typebox';

// Public values live here. Consumers import these constants and inferred types.
export const MARKETS = ['sse', 'szse', 'nafmii'] as const;
export const OFFERINGS = ['private', 'public', 'public_all', 'ppn', 'mtn', 'cp', 'scp', 'dfi'] as const;
export const MARKET_OFFERINGS = { sse: ['private', 'public', 'public_all'], szse: ['private', 'public', 'public_all'], nafmii: ['ppn', 'mtn', 'cp', 'scp', 'dfi'] } as const;
export const RUN_STATES = ['preparing', 'rejected', 'queued', 'running', 'awaiting_input', 'paused', 'validating', 'delivering', 'settlement_pending', 'succeeded', 'failed', 'cancelled'] as const;
export const MATERIAL_STATES = ['uploading', 'persisted', 'prechecking', 'ready', 'parsing', 'needs_confirmation', 'parsed', 'failed'] as const;
export const PROFILE_STATES = ['queued', 'analyzing', 'ready', 'needs_confirmation', 'failed'] as const;
export const ERROR_CODES = ['INPUT_REQUIRED', 'INPUT_REVISION_CONFLICT', 'MATERIAL_UNREADABLE', 'FACT_CONFLICT', 'CAPABILITY_NOT_READY', 'DATA_NOT_ENTITLED', 'DATA_UNAVAILABLE', 'CREDITS_INSUFFICIENT', 'METERING_PENDING', 'DELIVERY_FAILED', 'IDEMPOTENCY_CONFLICT', 'RATE_LIMITED', 'ALREADY_TERMINAL', 'NOT_FOUND', 'UNAUTHENTICATED', 'VALIDATION_FAILED'] as const;
export const EVENT_TYPES = ['material.upload_progress', 'material.parse_progress', 'historical_profile.updated', 'run.state_changed', 'run.progress', 'conversation.clarification', 'artifact.ready'] as const;
export const TASK_KINDS = ['update', 'review', 'generation', 'qa'] as const;
export const USAGE_STATUSES = ['reported', 'pending', 'unavailable'] as const;

const enumOf = <T extends readonly string[]>(values: T) => Type.Union(values.map(value => Type.Literal(value)));
const obj = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 128, description: 'Opaque, non-guessable identifier; never an authorization grant.' });
const utc = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$', description: 'UTC ISO-8601 timestamp ending in Z.' });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$', description: 'Lowercase SHA-256 hex.' });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const revision = Type.Integer({ minimum: 1 });
const cursor = nullable(Type.String({ minLength: 1, description: 'Opaque cursor; null means no next page.' }));

const market = enumOf(MARKETS);
const offering = enumOf(OFFERINGS);
const runState = enumOf(RUN_STATES);
const materialState = enumOf(MATERIAL_STATES);
const profileState = enumOf(PROFILE_STATES);
const errorCode = enumOf(ERROR_CODES);
const eventType = enumOf(EVENT_TYPES);
const taskKind = enumOf(TASK_KINDS);
const usageStatus = enumOf(USAGE_STATUSES);
const PageSchema = obj({ next_cursor: cursor, has_more: Type.Boolean() });
const RunEventSchema = obj({ event_id: id, schema_version: Type.Literal(1), trace_id: id, run_id: id, seq: Type.Integer({ minimum: 1 }), occurred_at: utc, stage: nullable(Type.String()), type: eventType, state: runState, payload: Type.Record(Type.String(), Type.Unknown(), { description: 'Event-specific, redacted UI payload; never prompt body, secret or internal library candidate.' }) });

export const schemas = {
  Error: obj({ code: errorCode, message: Type.String(), retryable: Type.Boolean(), field_errors: Type.Array(obj({ field: Type.String(), code: Type.String(), message: Type.String() })), correlation_id: id }),
  Page: PageSchema,
  SmsChallengeRequest: obj({ phone: Type.String({ minLength: 1 }), purpose: Type.Literal('login') }),
  SmsChallengeResponse: obj({ challenge_id: id, expires_at: utc, retry_at: utc }),
  SmsVerifyRequest: obj({ challenge_id: id, code: Type.String({ minLength: 1 }), accepted_terms_version: Type.String({ minLength: 1 }) }),
  SessionResponse: obj({ user_id: id, expires_at: utc, session_status: Type.Literal('active') }),
  MeResponse: obj({ user_id: id, session_status: Type.Literal('active') }),
  CapabilityResponse: obj({ scopes: Type.Array(Type.String()), version: Type.String(), status: Type.Union([Type.Literal('available'), Type.Literal('limited')]) }),
  ProjectCreateRequest: Type.Object({ name: Type.String({ minLength: 1 }), kind: taskKind, issuer_name: nullable(Type.String()), market: nullable(market), offering: nullable(offering) }, { additionalProperties: false, allOf: [
    { if: { properties: { market: { const: 'sse' } } }, then: { properties: { offering: { enum: [...MARKET_OFFERINGS.sse, null] } } } },
    { if: { properties: { market: { const: 'szse' } } }, then: { properties: { offering: { enum: [...MARKET_OFFERINGS.szse, null] } } } },
    { if: { properties: { market: { const: 'nafmii' } } }, then: { properties: { offering: { enum: [...MARKET_OFFERINGS.nafmii, null] } } } }
  ] }),
  ProjectPatchRequest: Type.Object({ name: Type.Optional(Type.String({ minLength: 1 })), issuer_name: Type.Optional(nullable(Type.String())), market: Type.Optional(nullable(market)), offering: Type.Optional(nullable(offering)) }, { additionalProperties: false, minProperties: 1 }),
  ProjectResponse: obj({ project_id: id, draft_revision: revision, input_revision: nullable(revision), input_hash: nullable(hash), name: Type.String(), kind: taskKind, issuer_name: nullable(Type.String()), market: nullable(market), offering: nullable(offering), updated_at: utc }),
  ProjectListResponse: obj({ items: Type.Array(obj({ project_id: id, name: Type.String(), draft_revision: revision, updated_at: utc })), page: PageSchema }),
  InputRevisionCreateRequest: obj({ draft_revision: revision, material_versions: Type.Array(obj({ material_id: id, material_version: revision })), requirement_message_ids: Type.Array(id) }),
  InputRevisionResponse: obj({ project_id: id, input_revision: revision, input_hash: hash, material_versions: Type.Array(obj({ material_id: id, material_version: revision })), rule_pack_version: nullable(Type.String()), template_version: nullable(Type.String()), reference_release: nullable(Type.String()), created_at: utc }),
  UploadCreateRequest: obj({ filename: Type.String({ minLength: 1 }), media_type: Type.Union([Type.Literal('application/pdf'), Type.Literal('application/vnd.openxmlformats-officedocument.wordprocessingml.document')]), byte_size: Type.Integer({ minimum: 1 }), sha256: hash, role: Type.String({ minLength: 1 }) }),
  UploadSessionResponse: obj({ upload_id: id, state: Type.Literal('uploading'), upload_url: Type.String({ description: 'Short-lived, scoped URL; never store or log it.' }), expires_at: utc, max_bytes: Type.Integer({ minimum: 1 }) }),
  UploadCompleteRequest: obj({ byte_size: Type.Integer({ minimum: 1 }), sha256: hash }),
  MaterialResponse: obj({ material_id: id, material_version: revision, upload_id: id, role: Type.String(), filename: Type.String(), media_type: Type.String(), byte_size: Type.Integer({ minimum: 1 }), sha256: hash, state: materialState, persisted_at: utc, error: nullable(Type.String()) }),
  RecognitionResponse: obj({ material_id: id, material_version: revision, profile_version: revision, state: profileState, source_market: nullable(market), source_offering: nullable(offering), raw_value: nullable(Type.String()), uncertainty: Type.Array(Type.String()), evidence_refs: Type.Array(id), latest_reporting_cutoff: nullable(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })) }),
  RecognitionPatchRequest: obj({ profile_version: revision, source_market: nullable(market), source_offering: nullable(offering), reason: Type.String({ minLength: 1 }), evidence_refs: Type.Array(id) }),
  PreflightRequest: obj({ input_revision: revision, input_hash: hash }),
  PreflightResponse: obj({ project_id: id, input_revision: revision, input_hash: hash, status: Type.Union([Type.Literal('ready'), Type.Literal('needs_confirmation'), Type.Literal('blocked')]), missing_inputs: Type.Array(Type.String()), uncertainty: Type.Array(Type.String()), billing_mode: Type.Literal('platform_trial') }),
  ExecuteRequest: obj({ execution_request_id: id, project_id: id, input_revision: revision, input_hash: hash, task_kind: taskKind, input_manifest_ref: id, storage_origin: Type.Literal('cloud'), workspace_id: id }),
  RunResponse: Type.Object({ run_id: id, execution_request_id: id, project_id: id, input_revision: revision, input_hash: hash, state: runState, stage: nullable(Type.String()), event_cursor: nullable(Type.Integer({ minimum: 0 })), billing_mode: Type.Literal('platform_trial'), reservation_id: Type.Null(), artifact_id: nullable(id), prompt_snapshot_ref: nullable(id), updated_at: utc }, { additionalProperties: false, if: { properties: { state: { const: 'succeeded' } } }, then: { properties: { artifact_id: { type: 'string', minLength: 1 } } } }),
  RunActionRequest: obj({ reason: Type.String({ minLength: 1 }) }),
  RunEvent: RunEventSchema,
  RunEventsResponse: obj({ items: Type.Array(RunEventSchema), next_cursor: nullable(Type.Integer({ minimum: 0 })) }),
  ArtifactResponse: obj({ artifact_id: id, run_id: id, version: revision, media_type: Type.Literal('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), sha256: hash, quality_status: Type.Literal('passed'), delivery_status: Type.Literal('available'), download_url: Type.String({ description: 'Short-lived authorized URL, only after owner and hash check.' }), expires_at: utc }),
  ConversationMessageRequest: obj({ message_id: id, project_id: id, body: Type.String({ minLength: 1 }), prompt_version: revision, attachment_material_ids: Type.Array(id) }),
  ConversationMessageResponse: obj({ message_id: id, conversation_id: id, prompt_snapshot_ref: id, intent: Type.Union([Type.Literal('answer'), Type.Literal('update'), Type.Literal('clarify')]), reply: nullable(Type.String()), run_id: nullable(id), created_at: utc }),
  ModelCallAttempt: obj({ logical_call_id: id, call_id: id, attempt_no: revision, provider_request_id: nullable(id), model_id: Type.String(), prompt_snapshot_ref: id, usage_status: usageStatus, input_tokens: nullable(Type.Integer({ minimum: 0 })), output_tokens: nullable(Type.Integer({ minimum: 0 })), cached_input_tokens: nullable(Type.Integer({ minimum: 0 })), reasoning_tokens: nullable(Type.Integer({ minimum: 0 })), usage_evidence_ref: nullable(id), billable: Type.Boolean(), cost_payer: Type.Literal('platform') }),
  TraceContext: obj({ operation_id: id, request_id: id, trace_id: id, span_id: id, parent_span_id: nullable(id), user_id: nullable(id), project_id: nullable(id), job_id: nullable(id), run_id: nullable(id), work_item_id: nullable(id), occurred_at: utc }),
  HealthResponse: obj({ status: Type.Literal('ok'), service: Type.Literal('bondbuddy-m1-api-skeleton'), implementation: Type.Literal('health-and-contract-only') })
} as const;

export type Project = Static<typeof schemas.ProjectResponse>;
export type Run = Static<typeof schemas.RunResponse>;
export type RunEvent = Static<typeof schemas.RunEvent>;
export type Material = Static<typeof schemas.MaterialResponse>;
export type ModelCallAttempt = Static<typeof schemas.ModelCallAttempt>;
export type Market = typeof MARKETS[number];
export type Offering = typeof OFFERINGS[number];
export type RunState = typeof RUN_STATES[number];
export type ErrorCode = typeof ERROR_CODES[number];
export type UsageStatus = typeof USAGE_STATUSES[number];
export function isMarketOffering(market: Market, offering: Offering): boolean {
  return (MARKET_OFFERINGS[market] as readonly Offering[]).includes(offering);
}

export type SchemaName = keyof typeof schemas;
export type Operation = { method: 'get' | 'post' | 'patch' | 'delete'; path: string; summary: string; request?: SchemaName; response: SchemaName; status: number; errors?: number[]; headers?: Record<string, string> };
const op = (method: Operation['method'], path: string, summary: string, response: SchemaName, status = 200, request?: SchemaName, errors: number[] = []): Operation => ({ method, path, summary, request, response, status, errors });
export const operations: readonly Operation[] = [
  op('post', '/auth/sms/challenges', 'Create SMS challenge (contract only)', 'SmsChallengeResponse', 202, 'SmsChallengeRequest'),
  op('post', '/auth/sms/verify', 'Verify SMS and establish HttpOnly session (contract only)', 'SessionResponse', 200, 'SmsVerifyRequest'),
  op('post', '/auth/refresh', 'Refresh session (contract only)', 'SessionResponse'),
  op('post', '/auth/logout', 'Revoke session (contract only)', 'SessionResponse'),
  op('get', '/me', 'Read authenticated identity (contract only)', 'MeResponse'),
  op('get', '/capabilities', 'Read released capabilities (contract only)', 'CapabilityResponse'),
  op('get', '/projects', 'List owner projects with cursor (contract only)', 'ProjectListResponse'),
  op('post', '/projects', 'Create project draft (contract only)', 'ProjectResponse', 201, 'ProjectCreateRequest'),
  op('get', '/projects/{project_id}', 'Read owner project (contract only)', 'ProjectResponse', 200, undefined, [404]),
  op('patch', '/projects/{project_id}', 'Patch draft with If-Match revision (contract only)', 'ProjectResponse', 200, 'ProjectPatchRequest', [404, 409]),
  op('post', '/projects/{project_id}/input-revisions', 'Lock verified owner material and draft versions; server computes hash (contract only)', 'InputRevisionResponse', 201, 'InputRevisionCreateRequest', [404, 409]),
  op('get', '/projects/{project_id}/input-revisions/{input_revision}', 'Read immutable input snapshot (contract only)', 'InputRevisionResponse', 200, undefined, [404]),
  op('post', '/projects/{project_id}/materials/uploads', 'Create scoped upload (contract only)', 'UploadSessionResponse', 201, 'UploadCreateRequest', [404]),
  op('post', '/projects/{project_id}/materials/uploads/{upload_id}/complete', 'Verify object bytes/hash and register material idempotently (contract only)', 'MaterialResponse', 200, 'UploadCompleteRequest', [404, 409]),
  op('get', '/projects/{project_id}/materials/{material_id}', 'Read owner material save/parse state (contract only)', 'MaterialResponse', 200, undefined, [404]),
  op('get', '/projects/{project_id}/materials/{material_id}/source-profile', 'Read asynchronous recognition (contract only)', 'RecognitionResponse', 200, undefined, [404]),
  op('patch', '/projects/{project_id}/materials/{material_id}/source-profile', 'Correct source recognition with revision (contract only)', 'RecognitionResponse', 200, 'RecognitionPatchRequest', [404, 409]),
  op('post', '/projects/{project_id}/preflight', 'Validate material, capability and input snapshot (contract only)', 'PreflightResponse', 200, 'PreflightRequest', [404, 409]),
  op('post', '/runs/execute', 'Submit idempotent persistent run (contract only)', 'RunResponse', 202, 'ExecuteRequest', [404, 409]),
  op('get', '/runs/{run_id}', 'Re-read owner run after new session (contract only)', 'RunResponse', 200, undefined, [404]),
  op('get', '/runs/{run_id}/events', 'Read events after cursor (contract only)', 'RunEventsResponse', 200, undefined, [404]),
  op('post', '/runs/{run_id}/cancel', 'Cancel server run explicitly (contract only)', 'RunResponse', 200, 'RunActionRequest', [404, 409]),
  op('post', '/runs/{run_id}/resume', 'Resume paused run after provider reconciliation (contract only)', 'RunResponse', 200, 'RunActionRequest', [404, 409]),
  op('get', '/artifacts/{artifact_id}', 'Get authorized checked Word artifact (contract only)', 'ArtifactResponse', 200, undefined, [404]),
  op('post', '/conversations/{conversation_id}/messages', 'Submit and snapshot user message (contract only)', 'ConversationMessageResponse', 202, 'ConversationMessageRequest', [404, 409])
];

const ref = (name: SchemaName) => ({ $ref: `#/components/schemas/${name}` });
const parameters = (path: string) => [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({ name: match[1], in: 'path', required: true, schema: { type: 'string' } }));
export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {
    '/health': { get: { summary: 'Live process health only', 'x-implementation-status': 'live', responses: { '200': { description: 'Process is running; dependencies are not checked', content: { 'application/json': { schema: ref('HealthResponse') } } } } } }
  };
  for (const operation of operations) {
    const path = `/api/v1${operation.path}`;
    paths[path] ??= {};
    const responses: Record<string, unknown> = { [operation.status]: { description: 'Contract response; route is not implemented', content: { 'application/json': { schema: ref(operation.response) } } } };
    for (const status of operation.errors ?? []) responses[status] = { description: status === 404 ? 'Owner-safe not found' : 'Revision or idempotency conflict', content: { 'application/json': { schema: ref('Error') } } };
    const queryParameters = operation.path === '/projects' ? [{ name: 'cursor', in: 'query', required: false, schema: { type: 'string' } }] : operation.path.endsWith('/events') ? [{ name: 'after', in: 'query', required: false, schema: { type: 'integer', minimum: 0 }, description: 'Last seen per-run seq; returned events have greater seq.' }] : [];
    const ifMatch = operation.method === 'patch' && operation.path.includes('/projects/') ? [{ name: 'If-Match', in: 'header', required: true, schema: { type: 'string', description: 'Current draft or source-profile revision as decimal integer' } }] : [];
    paths[path][operation.method] = { summary: operation.summary, 'x-implementation-status': 'contract-only', security: operation.path.startsWith('/auth/sms/') ? [] : [{ sessionCookie: [] }], parameters: [...parameters(path), ...queryParameters, ...ifMatch], ...(operation.request ? { requestBody: { required: true, content: { 'application/json': { schema: ref(operation.request) } } } } : {}), responses };
  }
  return { openapi: '3.1.0', info: { title: 'BondBuddy M1 public contract', version: '0.1.0', description: 'Only /health is live. /api/v1 paths describe future behavior and are not registered by the skeleton. UTC timestamps end in Z. Nullable means explicitly unknown/not yet available; 0 is a known measured zero. Cursor is opaque and null at end. All personal resources require owner checks; unknown and foreign IDs share 404. Browser closes do not cancel server runs. Sessions use HttpOnly Secure SameSite cookies; mutations require CSRF/Origin checks when implemented.' }, servers: [{ url: '/' }], components: { schemas, securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'bb_session', description: 'Server-set HttpOnly, Secure, SameSite cookie; never expose supplier credentials to browser.' } } }, paths };
}
