import { Type, type Static, type TSchema } from '@sinclair/typebox';

// Public values live here. Consumers import these constants and inferred types.
export const MARKETS = ['sse', 'szse', 'nafmii'] as const;
export const OFFERINGS = ['private', 'public', 'public_all', 'ppn', 'mtn', 'cp', 'scp', 'dfi'] as const;
export const MARKET_OFFERINGS = { sse: ['private', 'public', 'public_all'], szse: ['private', 'public', 'public_all'], nafmii: ['ppn', 'mtn', 'cp', 'scp', 'dfi'] } as const;
// M1 update upload roles are the current project-fields.js partitions, excluding later review/generation roles.
export const M1_MATERIAL_PARTITIONS = [
  { label: '募集说明书', roles: [{ code: 'historical', label: '本企业历史募集书' }, { code: 'reference', label: '相似企业参考募集书' }] },
  { label: '财务与审计', roles: [{ code: 'audit', label: '审计报告（可含报表及附注）' }, { code: 'financial', label: '年度财务报表' }, { code: 'interimFinancial', label: '最近一期财务报表' }, { code: 'notes', label: '财务报表附注' }, { code: 'accountDetails', label: '财务科目明细与辅助账' }] },
  { label: '发行安排与资金用途', roles: [{ code: 'issuancePlan', label: '本期发行方案' }, { code: 'fundUse', label: '募集资金使用计划 / 项目方案' }, { code: 'feasibility', label: '项目可行性研究报告' }, { code: 'priorFundUse', label: '前次募集资金使用说明' }, { code: 'trusteeReport', label: '受托管理事务报告' }, { code: 'resolutions', label: '董事会 / 股东会决议' }] },
  { label: '工商、信用与评级', roles: [{ code: 'corporate', label: '工商及公司资料' }, { code: 'registry', label: '工商登记 / 企业信息公示材料' }, { code: 'credit', label: '征信报告' }, { code: 'creditCompliance', label: '诉讼、失信、处罚及信用核查' }, { code: 'issuerStatement', label: '发行人自查 / 专项说明' }, { code: 'rating', label: '评级报告（主体 / 债项 / 跟踪）' }, { code: 'legal', label: '法律意见书及其他法律文件' }] },
  { label: '债务、授信与担保', roles: [{ code: 'debt', label: '债务明细与融资材料' }, { code: 'bankFacilities', label: '银行授信情况表' }, { code: 'facilityEvidence', label: '银行授信证明材料' }, { code: 'outstandingBonds', label: '存续及历史债券资料' }, { code: 'guarantee', label: '本期增信 / 担保合同' }, { code: 'guarantorMaterials', label: '担保人财务、评级及资质材料' }, { code: 'collateralMaterials', label: '抵质押资产资料' }] },
  { label: '经营、治理与行业', roles: [{ code: 'business', label: '业务经营资料' }, { code: 'governance', label: '章程、治理制度与组织架构' }, { code: 'personnel', label: '董监高及其他人员资料' }, { code: 'industry', label: '行业研究 / 行业统计资料' }, { code: 'other', label: '其他材料' }] }
] as const;
export const M1_UPLOAD_MATERIAL_ROLES = M1_MATERIAL_PARTITIONS.flatMap(partition => partition.roles.map(role => role.code));
export const M1_UPLOAD_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv', 'text/plain', 'image/png', 'image/jpeg'
] as const;
export const RUN_STATES = ['preparing', 'rejected', 'queued', 'running', 'awaiting_input', 'paused', 'validating', 'delivering', 'settlement_pending', 'succeeded', 'failed', 'cancelled'] as const;
export const MATERIAL_STATES = ['uploading', 'persisted', 'prechecking', 'ready', 'parsing', 'needs_confirmation', 'parsed', 'failed'] as const;
export const PROFILE_STATES = ['queued', 'analyzing', 'ready', 'needs_confirmation', 'failed'] as const;
export const ERROR_CODES = ['INPUT_REQUIRED', 'INPUT_REVISION_CONFLICT', 'MATERIAL_UNREADABLE', 'MATERIAL_FORMAT_UNSUPPORTED', 'MATERIAL_ENCRYPTED', 'MATERIAL_CONTENT_MISMATCH', 'FACT_CONFLICT', 'CAPABILITY_NOT_READY', 'DATA_NOT_ENTITLED', 'DATA_UNAVAILABLE', 'CREDITS_INSUFFICIENT', 'METERING_PENDING', 'DELIVERY_FAILED', 'IDEMPOTENCY_CONFLICT', 'RATE_LIMITED', 'ALREADY_TERMINAL', 'NOT_FOUND', 'UNAUTHENTICATED', 'VALIDATION_FAILED', 'CHALLENGE_INVALID', 'AGREEMENT_REQUIRED', 'CSRF_DENIED', 'PASSWORD_INVALID', 'ACCOUNT_CLOSURE_BLOCKED'] as const;
export const PROJECT_EVENT_TYPES = ['material.upload_progress', 'material.parse_progress', 'historical_profile.updated'] as const;
export const RUN_EVENT_TYPES = ['run.state_changed', 'run.progress', 'conversation.clarification', 'artifact.ready'] as const;
export const EVENT_TYPES = [...PROJECT_EVENT_TYPES, ...RUN_EVENT_TYPES] as const;
// Records deliberately kept after closure; M2 adds order/ledger records under their legal retention rules.
export const CLOSURE_RETAINED_RECORDS = ['account_identifier', 'agreement_acceptances', 'registration_event', 'closure_record', 'operation_logs', 'model_usage_records', 'audit_outbox'] as const;
export const TASK_KINDS = ['update', 'review', 'generation', 'qa'] as const;
export const USAGE_STATUSES = ['reported', 'pending', 'unavailable'] as const;
export const JOB_KINDS = ['update', 'review', 'generation', 'qa', 'preflight', 'parse'] as const;
export const JOB_STATUSES = ['created', 'queued', 'running', 'awaiting_input', 'paused', 'succeeded', 'failed', 'cancelled', 'rejected'] as const;
export const ERROR_CATEGORIES = ['validation', 'auth', 'material_parse', 'ocr', 'model_provider', 'tool', 'queue', 'export', 'delivery', 'metering', 'internal'] as const;
export const OBSERVABILITY_EVENT_KINDS = ['operation.submitted', 'operation.rejected', 'job.state_changed', 'prompt.snapshot_saved', 'model.call_started', 'model.call_finished', 'model.usage_observed', 'error.recorded', 'artifact.delivered'] as const;

const enumOf = <T extends readonly string[]>(values: T) => Type.Union(values.map(value => Type.Literal(value)));
const obj = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 128, description: 'Opaque, non-guessable identifier; never an authorization grant.' });
const utc = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$', description: 'UTC ISO-8601 timestamp ending in Z.' });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$', description: 'Lowercase SHA-256 hex.' });
const date = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Calendar date; distinct from a document signing or issuance date.' });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const revision = Type.Integer({ minimum: 1 });
const safeCode = Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$', description: 'Machine code only; no prompt, material excerpt or secret.' });
const cursor = nullable(Type.String({ minLength: 1, description: 'Opaque cursor; null means no next page.' }));

const market = enumOf(MARKETS);
const offering = enumOf(OFFERINGS);
const runState = enumOf(RUN_STATES);
const materialState = enumOf(MATERIAL_STATES);
const profileState = enumOf(PROFILE_STATES);
const errorCode = enumOf(ERROR_CODES);
const projectEventType = enumOf(PROJECT_EVENT_TYPES);
const runEventType = enumOf(RUN_EVENT_TYPES);
const taskKind = enumOf(TASK_KINDS);
const usageStatus = enumOf(USAGE_STATUSES);
const uploadMediaType = enumOf(M1_UPLOAD_MIME_TYPES);
const materialRole = enumOf(M1_UPLOAD_MATERIAL_ROLES);
const jobKind = enumOf(JOB_KINDS);
const jobStatus = enumOf(JOB_STATUSES);
const errorCategory = enumOf(ERROR_CATEGORIES);
const observabilityEventKind = enumOf(OBSERVABILITY_EVENT_KINDS);
const PageSchema = obj({ next_cursor: cursor, has_more: Type.Boolean() });
const provenanceMethod = enumOf(['native_text', 'ocr', 'model_assisted', 'user_correction', 'derived'] as const);
const recognitionStatus = enumOf(['recognized', 'needs_confirmation', 'user_asserted', 'unknown'] as const);
const ProvenanceSchema = obj({ material_id: id, material_version: revision, method: nullable(provenanceMethod), extractor_version: nullable(Type.String()), evidence_refs: Type.Array(id) });
const recognizedField = <T extends TSchema>(value: T) => obj({ value: nullable(value), raw_value: nullable(Type.String()), provenance: ProvenanceSchema, uncertainty: Type.Array(Type.String()), status: recognitionStatus });
const ReportingPeriodSchema = obj({ start: nullable(date), end: nullable(date), period_kind: nullable(enumOf(['annual', 'interim'] as const)), scope: nullable(enumOf(['consolidated', 'parent'] as const)), raw_value: nullable(Type.String()), provenance: ProvenanceSchema, uncertainty: Type.Array(Type.String()), status: recognitionStatus });
const SafeEventPayloadSchema = obj({ reason: Type.Optional(safeCode), previous_state: Type.Optional(runState), completed_items: Type.Optional(Type.Integer({ minimum: 0 })), total_items: Type.Optional(nullable(Type.Integer({ minimum: 0 }))), uploaded_bytes: Type.Optional(Type.Integer({ minimum: 0 })), total_bytes: Type.Optional(nullable(Type.Integer({ minimum: 0 }))), processed_pages: Type.Optional(Type.Integer({ minimum: 0 })), total_pages: Type.Optional(nullable(Type.Integer({ minimum: 0 }))), material_id: Type.Optional(id), artifact_id: Type.Optional(id), profile_version: Type.Optional(revision), clarification_ref: Type.Optional(id), required_fields: Type.Optional(Type.Array(safeCode)), evidence_refs: Type.Optional(Type.Array(id)), error_code: Type.Optional(errorCode) });
const RunEventSchema = obj({ event_id: id, schema_version: Type.Literal(1), trace_id: id, run_id: id, seq: Type.Integer({ minimum: 1 }), occurred_at: utc, stage: nullable(Type.String()), type: runEventType, state: runState, payload: SafeEventPayloadSchema });
const ProjectEventSchema = obj({ event_id: id, schema_version: Type.Literal(1), trace_id: id, project_id: id, seq: Type.Integer({ minimum: 1 }), occurred_at: utc, type: projectEventType, payload: SafeEventPayloadSchema });
const UsageObservationSchema = obj({ status: usageStatus, input_tokens: nullable(Type.Integer({ minimum: 0 })), output_tokens: nullable(Type.Integer({ minimum: 0 })), cached_input_tokens: nullable(Type.Integer({ minimum: 0 })), reasoning_tokens: nullable(Type.Integer({ minimum: 0 })), evidence_ref: nullable(id) });
const ObservabilityErrorSchema = obj({ error_id: id, code: errorCode, category: errorCategory, retryable: Type.Boolean() });
const InternalObservabilityEventSchema = obj({ event_id: id, schema_version: Type.Literal(1), kind: observabilityEventKind, occurred_at: utc, operation_id: id, request_id: id, trace_id: id, span_id: id, parent_span_id: nullable(id), actor_type: enumOf(['user', 'system', 'operator'] as const), user_id: nullable(id), project_id: nullable(id), conversation_id: nullable(id), message_id: nullable(id), job_id: nullable(id), parent_job_id: nullable(id), run_id: nullable(id), work_item_id: nullable(id), logical_call_id: nullable(id), call_id: nullable(id), attempt_no: nullable(revision), job_kind: nullable(jobKind), stage: nullable(Type.String()), status: nullable(jobStatus), prompt_snapshot_ref: nullable(id), error: nullable(ObservabilityErrorSchema), usage: nullable(UsageObservationSchema) });

export const schemas = {
  Error: obj({ code: errorCode, message: Type.String(), retryable: Type.Boolean(), field_errors: Type.Array(obj({ field: Type.String(), code: Type.String(), message: Type.String() })), correlation_id: id }),
  Page: PageSchema,
  RegisterRequest: obj({ username: Type.String({ minLength: 3, maxLength: 32, pattern: '^[A-Za-z][A-Za-z0-9_]{2,31}$', description: 'Normalized to lowercase ASCII; unique.' }), password: Type.String({ minLength: 12, maxLength: 128, description: 'Sent only in JSON over TLS; never persisted except as an Argon2id hash.' }), accepted_terms_version: Type.String({ minLength: 1, description: 'Exact current required agreement version.' }) }),
  LoginRequest: obj({ username: Type.String({ minLength: 3, maxLength: 32 }), password: Type.String({ minLength: 1, maxLength: 512 }) }),
  SessionResponse: obj({ user_id: id, expires_at: utc, session_status: Type.Literal('active') }),
  MeResponse: obj({ user_id: id, session_status: Type.Literal('active') }),
  AccountResponse: obj({ user_id: id, username: nullable(Type.String()), phone_masked: nullable(Type.String({ description: 'Legacy phone identity with middle digits hidden; never the full number.' })), status: Type.Literal('active'), created_at: utc, accepted_terms_version: nullable(Type.String()), current_terms_version: nullable(Type.String()), password_updated_at: nullable(utc), self_service_recovery: Type.Literal('unavailable', { description: 'No verified recovery channel exists; recovery requires a reviewed manual process.' }), support_contact: nullable(Type.String({ description: 'Configured support entry; null until published.' })) }),
  AccountSessionListResponse: obj({ items: Type.Array(obj({ session_id: id, current: Type.Boolean(), created_at: utc, last_refreshed_at: nullable(utc), refresh_expires_at: utc })) }),
  SessionRevokeOthersResponse: obj({ revoked_sessions: Type.Integer({ minimum: 0 }) }),
  PasswordChangeRequest: obj({ current_password: Type.String({ minLength: 1, maxLength: 512 }), new_password: Type.String({ minLength: 12, maxLength: 128 }) }),
  PasswordChangeResponse: obj({ revoked_sessions: Type.Integer({ minimum: 0, description: 'Other sessions revoked; the current session stays active.' }) }),
  AccountClosurePreviewResponse: obj({ can_close: Type.Boolean(), active_runs: Type.Array(obj({ run_id: id, project_id: id, state: runState })), projects: Type.Integer({ minimum: 0 }), material_versions: Type.Integer({ minimum: 0 }), available_artifacts: Type.Integer({ minimum: 0 }), balance_status: Type.Literal('not_applicable_m1', { description: 'M1 has no wallet; M2 replaces this with frozen/refundable balance handling before closure.' }), retained_records: Type.Array(enumOf(CLOSURE_RETAINED_RECORDS)), local_exports: Type.Literal('not_affected', { description: 'Files the user downloaded or exported are outside BondBuddy and are not deleted by closure.' }) }),
  AccountClosureRequest: obj({ password: Type.String({ minLength: 1, maxLength: 512 }), confirm_username: Type.String({ minLength: 3, maxLength: 32 }) }),
  AccountClosureResponse: obj({ closure_id: id, status: Type.Literal('closed'), closed_at: utc, projects_deleted: Type.Integer({ minimum: 0 }), material_versions_deleted: Type.Integer({ minimum: 0 }), artifacts_revoked: Type.Integer({ minimum: 0 }), sessions_revoked: Type.Integer({ minimum: 0 }), cloud_content: Type.Literal('access_removed_purge_scheduled', { description: 'Access ends now; private bytes are purged by the storage lifecycle, and snapshot-pinned material stays until a release lifecycle exists.' }), balance_status: Type.Literal('not_applicable_m1'), retained_records: Type.Array(enumOf(CLOSURE_RETAINED_RECORDS)), local_exports: Type.Literal('not_affected') }),
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
  UploadCreateRequest: Type.Object({ filename: Type.String({ minLength: 1 }), media_type: uploadMediaType, byte_size: Type.Integer({ minimum: 1 }), sha256: hash, role: materialRole }, { additionalProperties: false, if: { properties: { role: { enum: ['historical', 'reference'] } } }, then: { properties: { media_type: { enum: [M1_UPLOAD_MIME_TYPES[0], M1_UPLOAD_MIME_TYPES[1]] } } } }),
  UploadSessionResponse: obj({ upload_id: id, state: Type.Literal('uploading'), upload_url: Type.String({ description: 'Short-lived, scoped URL; never store or log it.' }), expires_at: utc, max_bytes: Type.Integer({ minimum: 1 }) }),
  UploadCompleteRequest: obj({ byte_size: Type.Integer({ minimum: 1 }), sha256: hash }),
  MaterialResponse: obj({ material_id: id, material_version: revision, upload_id: id, role: materialRole, filename: Type.String(), media_type: uploadMediaType, byte_size: Type.Integer({ minimum: 1 }), sha256: hash, state: materialState, persisted_at: utc, error: nullable(Type.String()) }),
  RecognitionResponse: obj({ material_id: id, material_version: revision, profile_version: revision, state: profileState, source_market: recognizedField(market), source_offering: recognizedField(offering), reporting_periods: Type.Array(ReportingPeriodSchema), latest_reporting_cutoff: recognizedField(date) }),
  RecognitionPatchRequest: obj({ profile_version: revision, source_market: nullable(market), source_offering: nullable(offering), reason: Type.String({ minLength: 1 }), evidence_refs: Type.Array(id) }),
  PreflightRequest: obj({ input_revision: revision, input_hash: hash }),
  PreflightResponse: obj({ project_id: id, input_revision: revision, input_hash: hash, status: Type.Union([Type.Literal('ready'), Type.Literal('needs_confirmation'), Type.Literal('blocked')]), missing_inputs: Type.Array(Type.String()), uncertainty: Type.Array(Type.String()), billing_mode: Type.Literal('platform_trial') }),
  ExecuteRequest: obj({ execution_request_id: id, project_id: id, input_revision: revision, input_hash: hash, task_kind: taskKind, input_manifest_ref: id, storage_origin: Type.Literal('cloud'), workspace_id: id }),
  RunResponse: Type.Object({ run_id: id, execution_request_id: id, project_id: id, input_revision: revision, input_hash: hash, state: runState, stage: nullable(Type.String()), event_cursor: nullable(Type.Integer({ minimum: 0 })), billing_mode: Type.Literal('platform_trial'), reservation_id: Type.Null(), artifact_id: nullable(id), prompt_snapshot_ref: nullable(id), updated_at: utc }, { additionalProperties: false, if: { properties: { state: { const: 'succeeded' } } }, then: { properties: { artifact_id: { type: 'string', minLength: 1 } } } }),
  RunActionRequest: obj({ reason: Type.String({ minLength: 1 }) }),
  RunEvent: RunEventSchema,
  RunEventsResponse: obj({ items: Type.Array(RunEventSchema), next_cursor: nullable(Type.Integer({ minimum: 0 })) }),
  ProjectEvent: ProjectEventSchema,
  ProjectEventsResponse: obj({ items: Type.Array(ProjectEventSchema), next_cursor: nullable(Type.Integer({ minimum: 0 })) }),
  InternalObservabilityEvent: InternalObservabilityEventSchema,
  UsageObservation: UsageObservationSchema,
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
export type ProjectEvent = Static<typeof schemas.ProjectEvent>;
export type Material = Static<typeof schemas.MaterialResponse>;
export type ModelCallAttempt = Static<typeof schemas.ModelCallAttempt>;
export type Recognition = Static<typeof schemas.RecognitionResponse>;
export type ReportingPeriod = Static<typeof ReportingPeriodSchema>;
export type InternalObservabilityEvent = Static<typeof schemas.InternalObservabilityEvent>;
export type MaterialRole = typeof M1_UPLOAD_MATERIAL_ROLES[number];
export type UploadMediaType = typeof M1_UPLOAD_MIME_TYPES[number];
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
  op('post', '/auth/register', 'Register username and password; accept current agreement and issue cookie session', 'SessionResponse', 201, 'RegisterRequest', [409,422]),
  op('post', '/auth/login', 'Verify username and password; issue cookie session', 'SessionResponse', 200, 'LoginRequest', [429]),
  op('post', '/auth/refresh', 'Rotate access and refresh cookies', 'SessionResponse'),
  op('post', '/auth/logout', 'Revoke current session', 'SessionResponse', 204),
  op('get', '/me', 'Read authenticated identity', 'MeResponse'),
  op('get', '/account', 'Read account settings: username, masked legacy phone, agreement and recovery status', 'AccountResponse'),
  op('get', '/account/sessions', 'List own active sessions and mark the current one', 'AccountSessionListResponse'),
  op('delete', '/account/sessions/{session_id}', 'Revoke one own session; its tokens stop working immediately', 'AccountSessionListResponse', 204, undefined, [404]),
  op('post', '/account/sessions/revoke-others', 'Revoke every own session except the current one', 'SessionRevokeOthersResponse'),
  op('post', '/account/password', 'Change password after verifying the current one; revoke other sessions', 'PasswordChangeResponse', 200, 'PasswordChangeRequest', [403, 422, 429]),
  op('get', '/account/closure', 'Preview closure blockers, deleted content and retained records', 'AccountClosurePreviewResponse'),
  op('post', '/account/closure', 'Close account after password check when no run is active', 'AccountClosureResponse', 200, 'AccountClosureRequest', [403, 409, 422, 429]),
  op('get', '/capabilities', 'Read released capabilities (contract only)', 'CapabilityResponse'),
  op('get', '/projects', 'List owner projects with cursor (contract only)', 'ProjectListResponse'),
  op('post', '/projects', 'Create project draft (contract only)', 'ProjectResponse', 201, 'ProjectCreateRequest'),
  op('get', '/projects/{project_id}', 'Read owner project (contract only)', 'ProjectResponse', 200, undefined, [404]),
  op('patch', '/projects/{project_id}', 'Patch draft with If-Match revision (contract only)', 'ProjectResponse', 200, 'ProjectPatchRequest', [404, 409]),
  op('post', '/projects/{project_id}/input-revisions', 'Lock verified owner material and draft versions; server computes hash (contract only)', 'InputRevisionResponse', 201, 'InputRevisionCreateRequest', [404, 409]),
  op('get', '/projects/{project_id}/input-revisions/{input_revision}', 'Read immutable input snapshot (contract only)', 'InputRevisionResponse', 200, undefined, [404]),
  op('post', '/projects/{project_id}/materials/uploads', 'Create scoped upload (contract only)', 'UploadSessionResponse', 201, 'UploadCreateRequest', [404, 415, 422]),
  op('post', '/projects/{project_id}/materials/uploads/{upload_id}/complete', 'Verify object bytes/hash and register material idempotently (contract only)', 'MaterialResponse', 200, 'UploadCompleteRequest', [404, 409, 415, 422, 503]),
  op('get', '/projects/{project_id}/materials/{material_id}', 'Read owner material save/parse state', 'MaterialResponse', 200, undefined, [404]),
  op('get', '/projects/{project_id}/materials/{material_id}/download', 'Download verified owner material bytes', 'MaterialResponse', 200, undefined, [404]),
  op('delete', '/projects/{project_id}/materials/{material_id}', 'Remove current material access while preserving pinned snapshots', 'MaterialResponse', 204, undefined, [404]),
  op('get', '/projects/{project_id}/events', 'Read owner project material events after cursor (contract only)', 'ProjectEventsResponse', 200, undefined, [404]),
  op('get', '/projects/{project_id}/materials/{material_id}/source-profile', 'Read asynchronous recognition (contract only)', 'RecognitionResponse', 200, undefined, [404]),
  op('patch', '/projects/{project_id}/materials/{material_id}/source-profile', 'Correct source recognition with revision (contract only)', 'RecognitionResponse', 200, 'RecognitionPatchRequest', [404, 409]),
  op('post', '/projects/{project_id}/preflight', 'Validate material, capability and input snapshot (contract only)', 'PreflightResponse', 200, 'PreflightRequest', [404, 409]),
  op('post', '/runs/execute', 'Submit idempotent persistent run (contract only)', 'RunResponse', 202, 'ExecuteRequest', [404, 409]),
  op('get', '/runs/{run_id}', 'Re-read owner run after new session (contract only)', 'RunResponse', 200, undefined, [404]),
  op('get', '/runs/{run_id}/events', 'Read events after cursor (contract only)', 'RunEventsResponse', 200, undefined, [404]),
  op('post', '/runs/{run_id}/cancel', 'Cancel server run explicitly (contract only)', 'RunResponse', 200, 'RunActionRequest', [404, 409]),
  op('post', '/runs/{run_id}/resume', 'Resume paused run after provider reconciliation (contract only)', 'RunResponse', 200, 'RunActionRequest', [404, 409]),
  op('get', '/artifacts/{artifact_id}', 'Get authorized checked Word artifact', 'ArtifactResponse', 200, undefined, [404]),
  op('get', '/artifacts/{artifact_id}/download', 'Download checked owner Word artifact bytes', 'ArtifactResponse', 200, undefined, [404]),
  op('post', '/conversations/{conversation_id}/messages', 'Submit and snapshot user message (contract only)', 'ConversationMessageResponse', 202, 'ConversationMessageRequest', [404, 409])
];

const ref = (name: SchemaName) => ({ $ref: `#/components/schemas/${name}` });
const parameters = (path: string) => [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({ name: match[1], in: 'path', required: true, schema: { type: 'string' } }));
export function openApiDocument() {
  const { InternalObservabilityEvent: _internalEvent, UsageObservation: _usageObservation, ModelCallAttempt: _modelCallAttempt, TraceContext: _traceContext, ...publicSchemas } = schemas;
  const paths: Record<string, Record<string, unknown>> = {
    '/health': { get: { summary: 'Live process health only', 'x-implementation-status': 'live', responses: { '200': { description: 'Process is running; dependencies are not checked', content: { 'application/json': { schema: ref('HealthResponse') } } } } } }
  };
  for (const operation of operations) {
    const path = `/api/v1${operation.path}`;
    paths[path] ??= {};
    const binary = operation.path.endsWith('/download');
    const responses: Record<string, unknown> = { [operation.status]: { description: 'Response for this operation', ...(operation.status === 204 ? {} : { content: binary ? { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } : { 'application/json': { schema: ref(operation.response) } } }) } };
    for (const status of operation.errors ?? []) responses[status] = { description: ({ 404: 'Owner-safe not found', 409: 'Revision, idempotency or precondition conflict', 415: 'Unsupported material format', 422: 'Encrypted or mismatched material content', 503: 'Temporary upload inspection capacity unavailable; retryable' } as Record<number, string>)[status] ?? 'Contract error', content: { 'application/json': { schema: ref('Error') } } };
    for (const code of [401,403,501]) responses[code] = { description: code === 501 ? 'Capability not connected' : 'Session or CSRF/Origin check failed', content: { 'application/json': { schema: ref('Error') } } };
    const queryParameters = operation.path === '/projects' ? [{ name: 'cursor', in: 'query', required: false, schema: { type: 'string' } }] : operation.path.endsWith('/events') ? [{ name: 'after', in: 'query', required: false, schema: { type: 'integer', minimum: 0 }, description: 'Last seen per-run seq; returned events have greater seq.' }] : [];
    const ifMatch = operation.method === 'patch' && operation.path.includes('/projects/') ? [{ name: 'If-Match', in: 'header', required: true, schema: { type: 'string', description: 'Current draft or source-profile revision as decimal integer' } }] : [];
    const ready = ['/projects','/projects/{project_id}','/projects/{project_id}/input-revisions','/projects/{project_id}/input-revisions/{input_revision}','/projects/{project_id}/materials/uploads','/projects/{project_id}/materials/uploads/{upload_id}/complete','/projects/{project_id}/materials/{material_id}','/projects/{project_id}/materials/{material_id}/download','/runs/{run_id}','/runs/{run_id}/events','/artifacts/{artifact_id}','/artifacts/{artifact_id}/download'].includes(operation.path);
    const status = ['/auth/register','/auth/login'].includes(operation.path) ? 'implemented; PostgreSQL Argon2id credentials' : (['/auth/refresh','/auth/logout','/me'].includes(operation.path) || operation.path.startsWith('/account')) ? 'implemented; PostgreSQL session' : ['/runs/execute','/runs/{run_id}/cancel','/runs/{run_id}/resume'].includes(operation.path) ? 'test-only-durable-queue; production-501-until-provider-logging-and-delivery' : ready ? 'implemented; requires-valid-session' : 'contract-only-or-501';
    const csrfHeader=operation.method==='post'||operation.method==='patch'||operation.method==='delete' ? [{name:'Origin',in:'header',required:true,schema:{type:'string'}},...(!['/auth/register','/auth/login'].includes(operation.path) ? [{name:'X-BB-CSRF',in:'header',required:true,schema:{type:'string'},description:'Match bb_csrf cookie; required for authenticated mutations.'}] : [])] : [];
    paths[path][operation.method] = { summary: operation.summary, 'x-implementation-status': status, security: ['/auth/register','/auth/login'].includes(operation.path) ? [] : [{ [operation.path==='/auth/refresh'||operation.path==='/auth/logout' ? 'refreshCookie' : 'sessionCookie']: [] }], parameters: [...parameters(path), ...queryParameters, ...ifMatch, ...csrfHeader], ...(operation.request ? { requestBody: { required: true, content: { 'application/json': { schema: ref(operation.request) } } } } : {}), responses };
  }
  paths['/api/v1/projects/{project_id}/materials/uploads/{upload_id}/bytes'] = { put: {
    summary: 'Stream declared bytes to a private owner-scoped upload session',
    'x-implementation-status': 'implemented; requires-valid-session',
    security: [{ sessionCookie: [] }], parameters: [...parameters('/projects/{project_id}/materials/uploads/{upload_id}/bytes'),{name:'Origin',in:'header',required:true,schema:{type:'string'}},{name:'X-BB-CSRF',in:'header',required:true,schema:{type:'string'}}],
    requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
    responses: { '204': { description: 'Bytes verified and received; call complete to register material' }, '404': { description: 'Unknown or foreign upload' }, '422': { description: 'Content mismatch or expired upload', content: { 'application/json': { schema: ref('Error') } } }, '503': { description: 'Temporary upload inspection capacity unavailable; retryable', content: { 'application/json': { schema: ref('Error') } } } }
  } };
  return { openapi: '3.1.0', info: { title: 'BondBuddy M1 public contract', version: '0.3.0', description: 'Username/password registration and login use PostgreSQL Argon2id credentials; legacy SMS routes are absent and fail closed. PostgreSQL-backed sessions bind personal routes to a verified user. Durable queue submission/cancel/resume are available only by explicit in-process synthetic-test injection; production returns 501 until #16 provider reconciliation, #79 logs and checked Word delivery. Other capability routes return 501. UTC timestamps end in Z. Nullable means explicitly unknown/not yet available; 0 is a known measured zero. Cursor is opaque and null at end. All personal resources require owner checks; unknown and foreign IDs share 404. Browser closes do not cancel server runs. Access and rotating refresh tokens use HttpOnly Secure SameSite cookies; bb_csrf is a readable SameSite cookie and mutations require its X-BB-CSRF echo plus exact allowed Origin.' }, servers: [{ url: '/' }], components: { schemas: publicSchemas, securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'bb_session', description: 'Server-set HttpOnly, Secure, SameSite access cookie.' }, refreshCookie: { type:'apiKey', in:'cookie', name:'bb_refresh', description:'Rotating HttpOnly, Secure, SameSite refresh cookie with absolute lifetime.' } } }, paths };
}
