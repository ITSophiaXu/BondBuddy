import { recoverySchemas, RECOVERY_OPERATIONS } from './account-recovery.js';
import { billingSchemas } from './billing.js';
export * from './billing.js';
export * from './account-recovery.js';
import { OcrReviewSchema, OcrCorrectionRequestSchema, OcrCorrectionSchema } from './ocr.js';
// Internal #76/#79 platform-paid OCR/parse consumption event; separate from model usage.
export * from './platform-processing-cost.js';
export * from './ocr.js';
export * from './ocr-v2.js';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { ReviewActionSchema } from './review-action.js';
export * from './review-action.js';
import { ReviewRevisionHandlingSchema } from './review-revision.js';
import { RUN_CHANNELS, RUN_BILLING_MODES, ARTIFACT_DELIVERY_STATUSES } from './run-channel.js';
export * from './run-channel.js';
import { TestUncoveredItemsSchema } from './test-coverage.js';
export * from './test-coverage.js';
import { M1_MATERIAL_PARTITIONS, M1_UPLOAD_MATERIAL_ROLES } from './material-partitions.js';
export { M1_MATERIAL_PARTITIONS, M1_UPLOAD_MATERIAL_ROLES } from './material-partitions.js';
import { UpdateDetailsSchema, TargetReportingPeriodSchema, PROJECT_FIELD_LIMITS } from './update-project.js';
import { targetPeriodEvidenceSchemas, validTargetPeriodEvidenceDecision } from './target-period-evidence.js';
export { validTargetPeriodEvidenceDecision } from './target-period-evidence.js';
export * from './target-period-candidate-snapshot.js';
import { ProjectMessageIdSchema, projectMessageSetSchemas } from './project-message-set-pin.js';
export * from './project-message-set-pin.js'; // #76 active project-message set pin; the aggregate ref is pinned by immutable input/candidate snapshots
export * from './upload-inspection-errors.js';
export * from './update-project.js';
import { adminSchemas, ADMIN_LOG_FILTERS } from './admin-logs.js';
export * from './admin-logs.js';
import { browserErrorSchemas } from './browser-errors.js';
export * from './browser-errors.js';
export * from './data-lifecycle.js';
// --- #17 worker runtime (BB-M1-12-RUNTIME) ---
import { runtimeSchemas } from './worker-runtime.js';
export * from './worker-runtime.js';
export * from './ops-scheduler.js'; // #79 scheduled ops
// --- end #17 worker runtime ---
import { trialSchemas, TRIAL_GUARD_ERROR_CODES, TRIAL_ADMIN_OPERATIONS, trialOpenApiPaths } from './trial-guard.js'; export * from './trial-guard.js'; // #35 trial guard
export * from './reference-library.js';
export * from './user-reference.js';
export * from './platform-probe.js'; // #79/#16 platform probe
import { agreementSchemas, agreementOpenApiPaths } from './agreement.js'; export * from './agreement.js'; // #7 registration agreement
import { factSchemas } from './facts.js'; export * from './facts.js'; // #15 owner-scoped fact review API
import { creditFacilitySupplementSchemas } from './credit-facility-supplements.js'; export * from './credit-facility-supplements.js'; // #15 structured user assertions
import { issuerIdentityReviewSchemas } from './issuer-identity-review.js'; export * from './issuer-identity-review.js';
import { issuerAnnualProfileReviewSchemas } from './issuer-annual-profile-review.js'; export * from './issuer-annual-profile-review.js';
import { generationIssuerBindingSchemas } from './generation-issuer-binding.js'; export * from './generation-issuer-binding.js';
import { ruleApplicabilityContextSchemas } from './rule-applicability-context.js'; export * from './rule-applicability-context.js';
import { productionReviewManifestSchemas } from './production-review-manifest.js'; export * from './production-review-manifest.js';
import { productionReviewAttestationSchemas } from './production-review-attestation.js'; export * from './production-review-attestation.js';
import { productionRulePackReleaseSchemas } from './production-rule-pack-release.js'; export * from './production-rule-pack-release.js';
export { MARKETS, OFFERINGS, DOCUMENT_PURPOSES, MARKET_OFFERINGS, MARKET_LABELS, OFFERING_LABELS } from './public-enums.js';
import { MARKETS, OFFERINGS, DOCUMENT_PURPOSES, MARKET_OFFERINGS, MARKET_LABELS, OFFERING_LABELS } from './public-enums.js';
import { reviewerParseEvidenceSchemas } from './reviewer-parse-evidence.js'; export * from './reviewer-parse-evidence.js';

// Public values live here. Consumers import these constants and inferred types.
// M1 update upload roles are the current project-fields.js partitions, excluding later review/generation roles.
export const M1_UPLOAD_LIMITS = { fileBytes: 100 * 1024 * 1024, projectBytes: 500 * 1024 * 1024, projectFiles: 60 } as const;
export const M1_UPLOAD_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv', 'text/plain', 'image/png', 'image/jpeg'
] as const;
export const RUN_STATES = ['preparing', 'rejected', 'queued', 'running', 'awaiting_input', 'paused', 'validating', 'delivering', 'settlement_pending', 'succeeded', 'test_completed', 'failed', 'cancelled'] as const;
/** Project list projection: no run is a draft; otherwise reuse the actual run state. */
export const PROJECT_STATES = ['draft', ...RUN_STATES] as const;
export const PROJECT_ARCHIVE_VIEWS = ['active', 'archived', 'all'] as const;
export const MATERIAL_STATES = ['uploading', 'persisted', 'prechecking', 'ready', 'parsing', 'needs_confirmation', 'parsed', 'failed'] as const;
export const PROFILE_STATES = ['queued', 'analyzing', 'ready', 'needs_confirmation', 'failed'] as const;
export const ERROR_CODES = ['BROWSER_ERROR_REPORTED', 'TEST_CHANNEL_DISABLED', 'TEST_GRANT_INVALID', 'TEST_GRANT_EXPIRED', 'TEST_GRANT_REVOKED', 'TEST_GRANT_MISMATCH', 'INPUT_REQUIRED', 'INPUT_REVISION_CONFLICT', 'ISSUER_IDENTITY_VERIFICATION_INVALID', 'ISSUER_IDENTITY_SNAPSHOT_CONFLICT', 'MATERIAL_UNREADABLE', 'MATERIAL_PARSE_TIMEOUT', 'MATERIAL_TOO_LARGE', 'MATERIAL_FORMAT_UNSUPPORTED', 'MATERIAL_ENCRYPTED', 'MATERIAL_CONTENT_MISMATCH', 'FACT_CONFLICT', 'CAPABILITY_NOT_READY', 'DATA_NOT_ENTITLED', 'DATA_UNAVAILABLE', 'CREDITS_INSUFFICIENT', 'QUOTE_REQUIRED', 'QUOTE_CHANGED', 'BILLING_NOT_READY', 'PAYMENT_UNAVAILABLE', 'PAYMENT_INVALID', 'METERING_PENDING', 'DELIVERY_FAILED', 'IDEMPOTENCY_CONFLICT', 'RATE_LIMITED', 'ALREADY_TERMINAL', 'NOT_FOUND', 'UNAUTHENTICATED', 'VALIDATION_FAILED', 'CHALLENGE_INVALID', 'AGREEMENT_REQUIRED', 'CSRF_DENIED', 'PASSWORD_INVALID', 'ACCOUNT_CLOSURE_BLOCKED', 'PROJECT_DELETE_BLOCKED', ...TRIAL_GUARD_ERROR_CODES] as const;
export const PROJECT_EVENT_TYPES = ['material.upload_progress', 'material.parse_progress', 'historical_profile.updated'] as const;
export const RUN_EVENT_TYPES = ['run.state_changed', 'run.progress', 'conversation.clarification', 'artifact.ready'] as const;
export const EVENT_TYPES = [...PROJECT_EVENT_TYPES, ...RUN_EVENT_TYPES] as const;
// Records deliberately kept after closure; M2 adds order/ledger records under their legal retention rules.
export const CLOSURE_RETAINED_RECORDS = ['account_identifier', 'agreement_acceptances', 'registration_event', 'closure_record', 'operation_logs', 'model_usage_records', 'audit_outbox'] as const;
export const TASK_KINDS = ['update', 'review', 'generation', 'qa'] as const;
export const USAGE_STATUSES = ['reported', 'pending', 'unavailable'] as const;
export const JOB_KINDS = ['update', 'review', 'generation', 'qa', 'preflight', 'parse', 'library'] as const;
export const JOB_STATUSES = ['created', 'queued', 'running', 'awaiting_input', 'paused', 'succeeded', 'test_completed', 'failed', 'cancelled', 'rejected'] as const;
export const ERROR_CATEGORIES = ['validation', 'auth', 'material_parse', 'ocr', 'model_provider', 'tool', 'queue', 'export', 'delivery', 'metering', 'internal'] as const;
// #16 contained model adapter (internal worker/#79 codes; never shown as a public API error).
export const MODEL_ADAPTER_KINDS = ['codex_exec'] as const;
export const MODEL_ADAPTER_ERROR_CODES = ['MODEL_ADAPTER_CONFIG_INVALID', 'MODEL_SPAWN_FAILED', 'MODEL_TOOL_ATTEMPT_BLOCKED', 'MODEL_OUTPUT_SCHEMA_INVALID', 'MODEL_TIMEOUT', 'MODEL_STREAM_BROKEN', 'MODEL_TURN_FAILED', 'MODEL_PROVIDER_REQUEST_REJECTED', 'MODEL_PROVIDER_BALANCE_EXHAUSTED', 'MODEL_PROVIDER_AUTH_FAILED', 'MODEL_PROVIDER_RATE_LIMITED', 'MODEL_PROCESS_EXIT_NONZERO', 'MODEL_CANCELLED', 'MODEL_OUTPUT_TOO_LARGE', 'MODEL_RESULT_STORE_FAILED', 'MODEL_USAGE_PENDING', 'MODEL_PRIOR_ATTEMPT_UNRESOLVED'] as const;
export const MODEL_ADAPTER_OUTCOMES = ['completed', 'failed', 'pending_reconcile', 'confirmed_not_sent'] as const;
export const MODEL_ADAPTER_USAGE_STATUSES = ['measured', 'pending', 'unknown'] as const;
// #17/#13/#76 durable material parse seam. One job per owner + material version + parser version.
export const MATERIAL_PARSE_JOB_TYPE = 'parse' as const;
export const MATERIAL_PARSE_JOB_SUBTYPE = 'material_parse' as const;
export const MATERIAL_PARSE_JOB_STATES = ['queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled'] as const;
// Checkpointed stages in execution order; awaiting_ocr is a paused stage until the OCR processor is connected.
export const MATERIAL_PARSE_STAGES = ['parse_evidence', 'historical_profile', 'awaiting_ocr'] as const;
export const MATERIAL_PARSE_OUTCOMES = ['parsed', 'needs_confirmation', 'pending_ocr'] as const;
export const MATERIAL_PARSE_PENDING_CAPABILITIES = ['ocr'] as const;
// Outbox event_type values; each commits in the same transaction as the job state change.
export const MATERIAL_PARSE_EVENT_TYPES = ['material_parse.enqueued', 'material_parse.claimed', 'material_parse.stage_completed', 'material_parse.retry_scheduled', 'material_parse.paused', 'material_parse.succeeded', 'material_parse.failed', 'material_parse.cancelled'] as const;
export const OBSERVABILITY_EVENT_KINDS = ['operation.submitted', 'operation.rejected', 'job.state_changed', 'prompt.snapshot_saved', 'model.call_started', 'model.call_finished', 'model.usage_observed', 'error.recorded', 'artifact.delivered', 'model.usage_corrected', 'log.content_purged'] as const;

const enumOf = <T extends readonly string[]>(values: T) => Type.Union(values.map(value => Type.Literal<T[number]>(value)));
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
const TargetConfirmationRequestSchema = obj({ market, offering, document_purpose: nullable(enumOf(DOCUMENT_PURPOSES)), as_of: nullable(date), target_reporting_periods: Type.Array(TargetReportingPeriodSchema, { maxItems: 30, description: 'The complete target period set from the current draft, not source evidence.' }) });
const TargetConfirmationSchema = Type.Union([
  obj({ status: Type.Literal('confirmed'), market, offering, document_purpose: nullable(enumOf(DOCUMENT_PURPOSES)), as_of: nullable(date), target_reporting_periods: Type.Array(TargetReportingPeriodSchema, { maxItems: 30 }), confirmed_by: id, confirmed_at: utc }),
  obj({ status: Type.Literal('unconfirmed'), market: Type.Null(), offering: Type.Null(), document_purpose: Type.Null(), as_of: Type.Null(), target_reporting_periods: Type.Array(TargetReportingPeriodSchema, { maxItems: 0 }), confirmed_by: Type.Null(), confirmed_at: Type.Null() })
], { description: 'User-declared target intent only; neither source fact nor professional review.' });
const runState = enumOf(RUN_STATES);
const materialState = enumOf(MATERIAL_STATES);
export const SIGNED_PDF_PROFILE_VERSION = 'signed-pdf-classic-v1' as const;
export const SignatureAssessmentSchema = obj({
  status: Type.Literal('signature_unverified'),
  profile_version: Type.Literal(SIGNED_PDF_PROFILE_VERSION),
  signature_count: Type.Literal(1)
});
export type SignatureAssessment = Static<typeof SignatureAssessmentSchema>;
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
const MaterialParseJobSchema = obj({ job_id: id, job_type: Type.Literal(MATERIAL_PARSE_JOB_TYPE), subtype: Type.Literal(MATERIAL_PARSE_JOB_SUBTYPE), project_id: id, material_id: id, material_version: revision, material_sha256: hash, parser_version: Type.String({ minLength: 1, maxLength: 128 }), state: enumOf(MATERIAL_PARSE_JOB_STATES), stage: nullable(Type.String()), completed_stages: Type.Array(enumOf(MATERIAL_PARSE_STAGES)), attempts: Type.Integer({ minimum: 0 }), max_attempts: Type.Integer({ minimum: 1 }), error_code: nullable(errorCode), outcome: nullable(enumOf(MATERIAL_PARSE_OUTCOMES)), parse_status: nullable(enumOf(['parsed', 'needs_confirmation', 'failed'] as const)), profile_version: nullable(revision), pending_capabilities: Type.Array(enumOf(MATERIAL_PARSE_PENDING_CAPABILITIES)), updated_at: utc });
const PageSchema = obj({ next_cursor: cursor, has_more: Type.Boolean() });
const historyResult = {
  run_id: id, input_revision: revision, completed_at: utc,
  primary_artifact: obj({ artifact_id: id, version: revision }),
  word_delivery: nullable(obj({
    revision: obj({ artifact_id: id, version: revision }),
    clean: obj({ artifact_id: id, version: revision }),
    baseline: obj({ artifact_id: id, version: revision })
  }))
};
const ProjectMessageSchema = obj({
  message_id: id, submission_id: id, submission_version: revision, message_version: revision,
  prompt_snapshot_ref: id, revises_submission_id: nullable(id), content_sha256: hash,
  body: Type.String({ minLength: 1 }), material_versions: Type.Array(obj({ material_id: id, material_version: revision }), { maxItems: 100 }),
  created_at: utc, role: Type.Literal('user'), source_status: Type.Literal('user_asserted'),
  intent_status: Type.Literal('not_classified'), route: Type.Literal('save_only'),
});
const provenanceMethod = enumOf(['native_text', 'ocr', 'model_assisted', 'user_correction', 'derived'] as const);
const recognitionStatus = enumOf(['recognized', 'needs_confirmation', 'user_asserted', 'unknown'] as const);
const ProvenanceSchema = obj({ material_id: id, material_version: revision, method: nullable(provenanceMethod), extractor_version: nullable(Type.String()), evidence_refs: Type.Array(id) });
const recognizedField = <T extends TSchema>(value: T) => obj({ value: nullable(value), raw_value: nullable(Type.String()), provenance: ProvenanceSchema, uncertainty: Type.Array(Type.String()), status: recognitionStatus });
const ReportingPeriodSchema = obj({ start: nullable(date), end: nullable(date), period_kind: nullable(enumOf(['annual', 'interim'] as const)), scope: nullable(enumOf(['consolidated', 'parent'] as const)), raw_value: nullable(Type.String()), provenance: ProvenanceSchema, uncertainty: Type.Array(Type.String()), status: recognitionStatus });
const ReportingPeriodCorrectionSchema = obj({ start: nullable(date), end: nullable(date), period_kind: nullable(enumOf(['annual', 'interim'] as const)), scope: nullable(enumOf(['consolidated', 'parent'] as const)), evidence_refs: Type.Array(id) });
const SafeEventPayloadSchema = obj({ reason: Type.Optional(safeCode), previous_state: Type.Optional(runState), completed_items: Type.Optional(Type.Integer({ minimum: 0 })), total_items: Type.Optional(nullable(Type.Integer({ minimum: 0 }))), uploaded_bytes: Type.Optional(Type.Integer({ minimum: 0 })), total_bytes: Type.Optional(nullable(Type.Integer({ minimum: 0 }))), processed_pages: Type.Optional(Type.Integer({ minimum: 0 })), total_pages: Type.Optional(nullable(Type.Integer({ minimum: 0 }))), material_id: Type.Optional(id), artifact_id: Type.Optional(id), profile_version: Type.Optional(revision), clarification_ref: Type.Optional(id), required_fields: Type.Optional(Type.Array(safeCode)), evidence_refs: Type.Optional(Type.Array(id)), error_code: Type.Optional(enumOf([...ERROR_CODES, ...MODEL_ADAPTER_ERROR_CODES] as const)) });
const RunEventPayloadSchema = obj({ ...SafeEventPayloadSchema.properties, action: Type.Optional(ReviewActionSchema) });
const RunEventSchema = obj({ event_id: id, schema_version: Type.Literal(1), trace_id: id, run_id: id, seq: Type.Integer({ minimum: 1 }), occurred_at: utc, stage: nullable(Type.String()), type: runEventType, state: runState, payload: RunEventPayloadSchema });
const ProjectEventSchema = obj({ event_id: id, schema_version: Type.Literal(1), trace_id: id, project_id: id, seq: Type.Integer({ minimum: 1 }), occurred_at: utc, type: projectEventType, payload: SafeEventPayloadSchema });
const UsageObservationSchema = obj({ status: usageStatus, input_tokens: nullable(Type.Integer({ minimum: 0 })), output_tokens: nullable(Type.Integer({ minimum: 0 })), cached_input_tokens: nullable(Type.Integer({ minimum: 0 })), reasoning_tokens: nullable(Type.Integer({ minimum: 0 })), evidence_ref: nullable(id) });
const ObservabilityErrorSchema = obj({ error_id: id, code: enumOf([...ERROR_CODES, ...MODEL_ADAPTER_ERROR_CODES] as const), category: errorCategory, retryable: Type.Boolean(), reason: Type.Optional(safeCode), detail: Type.Optional(safeCode) });
const InternalObservabilityEventSchema = obj({ event_id: id, schema_version: Type.Literal(1), kind: observabilityEventKind, occurred_at: utc, operation_id: id, request_id: id, trace_id: id, span_id: id, parent_span_id: nullable(id), actor_type: enumOf(['user', 'system', 'operator'] as const), user_id: nullable(id), project_id: nullable(id), conversation_id: nullable(id), message_id: nullable(id), job_id: nullable(id), parent_job_id: nullable(id), run_id: nullable(id), work_item_id: nullable(id), logical_call_id: nullable(id), call_id: nullable(id), attempt_no: nullable(revision), job_kind: nullable(jobKind), stage: nullable(Type.String()), status: nullable(jobStatus), prompt_snapshot_ref: nullable(id), error: nullable(ObservabilityErrorSchema), usage: nullable(UsageObservationSchema) });

const materialResponseSchema = obj({ material_id: id, material_version: revision, upload_id: id, role: materialRole, filename: Type.String(), media_type: uploadMediaType, byte_size: Type.Integer({ minimum: 1 }), sha256: hash, state: materialState, persisted_at: utc, error: nullable(Type.String()), signature_assessment: Type.Optional(nullable(SignatureAssessmentSchema)), parse_snapshot_id: Type.Optional(nullable(id)) });
export const schemas = {
  ...billingSchemas,
  ...browserErrorSchemas,
  ...targetPeriodEvidenceSchemas,
  ...issuerIdentityReviewSchemas,
  ...issuerAnnualProfileReviewSchemas,
  ...generationIssuerBindingSchemas,
  ...recoverySchemas,
  ...adminSchemas,
  ...runtimeSchemas, // #17 worker runtime
  ...trialSchemas, // #35 trial guard
  ...agreementSchemas, // #7 registration agreement
  ...factSchemas, // #15 fact candidate review and append-only decisions
  ...creditFacilitySupplementSchemas, // #15 owner/project-scoped credit supplement
  ...ruleApplicabilityContextSchemas, // #19 owner-visible needs_review drafts
  ...productionReviewManifestSchemas, // #19 content-only production review manifest; no attestation/release API
  ...productionReviewAttestationSchemas, // #19 reviewer attestation DTOs; writer/authorization are separate
  ...productionRulePackReleaseSchemas, // #19 authenticated production release/withdrawal/rollback writes
  ...reviewerParseEvidenceSchemas, // #19 reviewer-only immutable parse evidence lookup
  OcrReview: OcrReviewSchema, OcrCorrectionRequest: OcrCorrectionRequestSchema, OcrCorrection: OcrCorrectionSchema,
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
  ProjectCreateRequest: Type.Object({ name: Type.String({ minLength: 1, maxLength: PROJECT_FIELD_LIMITS.name }), kind: taskKind, issuer_name: nullable(Type.String({ maxLength: PROJECT_FIELD_LIMITS.issuer })), market: nullable(market), offering: nullable(offering), update_details: Type.Optional(UpdateDetailsSchema) }, { additionalProperties: false, allOf: [
    { if: { properties: { market: { const: 'sse' } } }, then: { properties: { offering: { enum: [...MARKET_OFFERINGS.sse, null] } } } },
    { if: { properties: { market: { const: 'szse' } } }, then: { properties: { offering: { enum: [...MARKET_OFFERINGS.szse, null] } } } },
    { if: { properties: { market: { const: 'nafmii' } } }, then: { properties: { offering: { enum: [...MARKET_OFFERINGS.nafmii, null] } } } }
  ] }),
  ProjectPatchRequest: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: PROJECT_FIELD_LIMITS.name })), issuer_name: Type.Optional(nullable(Type.String({ maxLength: PROJECT_FIELD_LIMITS.issuer }))), market: Type.Optional(nullable(market)), offering: Type.Optional(nullable(offering)), update_details: Type.Optional(UpdateDetailsSchema) }, { additionalProperties: false, minProperties: 1 }),
  ProjectKindConversionRequest: obj({ conversion_request_id: id, expected_draft_revision: revision, expected_input_revision: nullable(revision), expected_input_hash: nullable(hash), no_historical_prospectus: Type.Literal(true) }),
  ProjectKindConversionResponse: obj({ conversion_request_id: id, project_id: id, from_kind: Type.Literal('update'), to_kind: Type.Literal('generation'), old_draft_revision: revision, draft_revision: revision, previous_input_revision: nullable(revision), previous_input_hash: nullable(hash), converted_at: utc }),
  ProjectResponse: obj({ project_id: id, draft_revision: revision, input_revision: nullable(revision), input_hash: nullable(hash), name: Type.String(), kind: taskKind, issuer_name: nullable(Type.String()), market: nullable(market), offering: nullable(offering), update_details: Type.Optional(UpdateDetailsSchema), updated_at: utc, archived_at: Type.Optional(nullable(utc)) }),
  ProjectListQuery: obj({ cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })), q: Type.Optional(Type.String({ maxLength: PROJECT_FIELD_LIMITS.issuer })), kind: Type.Optional(taskKind), status: Type.Optional(enumOf(PROJECT_STATES)), archive: Type.Optional(enumOf(PROJECT_ARCHIVE_VIEWS)), limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-9][0-9]|100)$' })) }),
  ArtifactHistoryQuery: obj({ cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 768 })), limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-4][0-9]|50)$' })) }),
  ArtifactHistoryResponse: obj({ items: Type.Array(Type.Union([
    obj({ ...historyResult, state: Type.Literal('succeeded'), channel: Type.Literal('production') }),
    obj({ ...historyResult, state: Type.Literal('test_completed'), channel: Type.Literal('non_production_test') })
  ]), { maxItems: 50 }), page: PageSchema }),
  ProjectArchiveRequest: obj({ archived: Type.Boolean() }),
  ProjectListResponse: obj({ items: Type.Array(obj({ project_id: id, name: Type.String(), draft_revision: revision, updated_at: utc,
    kind: Type.Optional(taskKind), issuer_name: Type.Optional(nullable(Type.String())), market: Type.Optional(nullable(market)), offering: Type.Optional(nullable(offering)),
    status: Type.Optional(enumOf(PROJECT_STATES)), archived_at: Type.Optional(nullable(utc)),
    latest_run: Type.Optional(nullable(obj({ run_id: id, state: runState, updated_at: utc }))),
    latest_artifact: Type.Optional(nullable(obj({ artifact_id: id, run_id: id, version: revision, created_at: utc })))
  })), page: PageSchema }),
  InputRevisionCreateRequest: obj({ draft_revision: revision, material_versions: Type.Array(obj({ material_id: id, material_version: revision })), requirement_message_ids: Type.Array(id), target_confirmation: Type.Optional(TargetConfirmationRequestSchema), user_reference: Type.Optional(obj({ material_id: id, material_version: revision, material_sha256: hash, parse_snapshot_id: id, target_product: id, target_document_stage: id })), rule_applicability_context_ref: Type.Optional(obj({ context_id: id, version: revision, content_hash: hash, source_input_revision: revision, source_input_hash: hash })), test_rule_applicability_context_ref: Type.Optional(obj({ context_id: id, version: revision, content_hash: hash, source_input_revision: revision, source_input_hash: hash })), credit_facility_supplements: Type.Optional(Type.Array(creditFacilitySupplementSchemas.CreditFacilitySupplementVersionRef, { maxItems: 60, description: 'Optional exact same-project user assertion versions to lock into this immutable input revision; never indicates verification.' })), generation_issuer_binding_ref: Type.Optional(generationIssuerBindingSchemas.GenerationIssuerBindingRef), project_message_set_ref: Type.Optional(projectMessageSetSchemas.ProjectMessageSetRef) }),
  InputRevisionResponse: obj({ project_id: id, input_revision: revision, input_hash: hash, target_confirmation: TargetConfirmationSchema, material_versions: Type.Array(obj({ material_id: id, material_version: revision })), credit_facility_supplements: Type.Optional(Type.Array(creditFacilitySupplementSchemas.CreditFacilitySupplementVersionRef, { maxItems: 60, description: 'Exact user-asserted supplement versions pinned by this immutable input revision; not verified facts.' })), rule_pack_version: nullable(Type.String()), template_version: nullable(Type.String()), reference_release: nullable(Type.String()), created_at: utc }),
  UploadCreateRequest: Type.Object({ filename: Type.String({ minLength: 1 }), media_type: uploadMediaType, byte_size: Type.Integer({ minimum: 1 }), sha256: hash, role: materialRole }, { additionalProperties: false, if: { properties: { role: { enum: ['historical', 'reference'] } } }, then: { properties: { media_type: { enum: [M1_UPLOAD_MIME_TYPES[0], M1_UPLOAD_MIME_TYPES[1]] } } } }),
  UploadSessionResponse: obj({ upload_id: id, state: Type.Literal('uploading'), upload_url: Type.String({ description: 'Short-lived, scoped URL; never store or log it.' }), expires_at: utc, max_bytes: Type.Integer({ minimum: 1 }) }),
  UploadCompleteRequest: obj({ byte_size: Type.Integer({ minimum: 1 }), sha256: hash }),
  MaterialRoleCopyRequest: obj({ request_key: Type.String({ pattern: '^[A-Za-z0-9._:-]{1,128}$' }), source_material_id: id, source_material_version: revision, source_sha256: hash, source_media_type: Type.Union([Type.Literal(M1_UPLOAD_MIME_TYPES[0]), Type.Literal(M1_UPLOAD_MIME_TYPES[1])]), target_role: Type.Literal('historical') }),
  MaterialRoleCopyResponse: obj({ receipt_id: id, source_material_id: id, source_material_version: revision, material: materialResponseSchema }),
  MaterialResponse: materialResponseSchema,
  RecognitionResponse: obj({ material_id: id, material_version: revision, profile_version: revision, state: profileState, source_market: recognizedField(market), source_offering: recognizedField(offering), reporting_periods: Type.Array(ReportingPeriodSchema), latest_reporting_cutoff: recognizedField(date) }),
  RecognitionPatchRequest: Type.Object({
    profile_version: revision,
    source_market: Type.Optional(nullable(market)),
    source_offering: Type.Optional(nullable(offering)),
    reporting_periods: Type.Optional(Type.Array(ReportingPeriodCorrectionSchema)),
    reason: Type.String({ minLength: 1 }),
    evidence_refs: Type.Array(id),
  }, { additionalProperties: false, anyOf: [
    { properties: { source_market: Type.Any() }, required: ['source_market'] },
    { properties: { source_offering: Type.Any() }, required: ['source_offering'] },
    { properties: { reporting_periods: Type.Any() }, required: ['reporting_periods'] },
  ] }),
  PreflightRequest: obj({ input_revision: revision, input_hash: hash, test_grant_id: Type.Optional(id) }),
  PreflightResponse: obj({ project_id: id, input_revision: revision, input_hash: hash, status: Type.Union([Type.Literal('ready'), Type.Literal('needs_confirmation'), Type.Literal('blocked')]), missing_inputs: Type.Array(Type.String()), uncertainty: Type.Array(Type.String()), blocking_inputs: Type.Array(Type.String()), advisory_inputs: Type.Array(Type.String()), billing_mode: Type.Union([Type.Literal('platform_trial'), Type.Literal('fixed_credits')]), update_difficulty: Type.Optional(obj({ snapshot_id: id, status: Type.Union([Type.Literal('ready'), Type.Literal('needs_confirmation')]), estimated_n: nullable(Type.Integer({ minimum: 0 })), structure_adaptation_required: nullable(Type.Boolean()), confirmation_reasons: Type.Array(Type.String()), source_profile_version: revision })) }),
  ExecuteRequest: obj({ execution_request_id: id, project_id: id, input_revision: revision, input_hash: hash, task_kind: taskKind, input_manifest_ref: id, storage_origin: Type.Literal('cloud'), workspace_id: id, quote_id: Type.Optional(id), test_grant_id: Type.Optional(id), user_prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 12000 })) }),
  RunResponse: Type.Object({ run_id: id, execution_request_id: id, project_id: id, input_revision: revision, input_hash: hash, channel: enumOf(RUN_CHANNELS), test_grant_id: nullable(id), uncovered_items: TestUncoveredItemsSchema, state: runState, stage: nullable(Type.String()), event_cursor: nullable(Type.Integer({ minimum: 0 })), billing_mode: enumOf(RUN_BILLING_MODES), reservation_id: nullable(id), artifact_id: nullable(id), prompt_snapshot_ref: nullable(id), updated_at: utc }, { additionalProperties: false, if: { properties: { state: { const: 'succeeded' } } }, then: { properties: { artifact_id: { type: 'string', minLength: 1 } } } }),
  RunActionRequest: obj({ reason: Type.String({ minLength: 1 }) }),
  MaterialParseJobResponse: MaterialParseJobSchema,
  RunEvent: RunEventSchema,
  RunEventsResponse: obj({ items: Type.Array(RunEventSchema), next_cursor: nullable(Type.Integer({ minimum: 0 })) }),
  ProjectEvent: ProjectEventSchema,
  ProjectEventsResponse: obj({ items: Type.Array(ProjectEventSchema), next_cursor: nullable(Type.Integer({ minimum: 0 })) }),
  InternalObservabilityEvent: InternalObservabilityEventSchema,
  UsageObservation: UsageObservationSchema,
  ArtifactResponse: obj({ artifact_id: id, run_id: id, version: revision, media_type: Type.Literal('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), sha256: hash, quality_status: Type.Literal('passed'), delivery_status: enumOf(ARTIFACT_DELIVERY_STATUSES), download_url: Type.String({ description: 'Short-lived authorized URL, only after owner and hash check.' }), expires_at: utc,
    word_delivery: Type.Optional(obj({ variant: Type.Union([Type.Literal('revision'), Type.Literal('clean'), Type.Literal('baseline')]),
      revision_artifact_id: id, clean_artifact_id: id, baseline_artifact_id: Type.Optional(id),
      writer_version: Type.Union([Type.Literal('bondbuddy-word-delivery-1.0.0'), Type.Literal('bondbuddy-unified-word-1.0.0'), Type.Literal('bondbuddy-file-word-1.0.0')]), source_sha256: nullable(hash), baseline_hash: nullable(hash), effective_baseline_sha256: nullable(hash), plan_hash: nullable(hash),
      delivery_policy: Type.Optional(Type.Literal('generated_pair_v1')), content_review: Type.Optional(Type.Literal('not_performed')),
      baseline_kind: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('uploaded_source'), Type.Literal('reconstructed_pdf'), Type.Literal('project_output')])),
      source_issuer: Type.Optional(nullable(Type.String())), authoring_summary: Type.Optional(Type.Array(Type.String())),
      revision_handling: Type.Optional(ReviewRevisionHandlingSchema), review_passed: Type.Optional(Type.Literal(false)),
      replacements: nullable(Type.Integer({ minimum: 0 })), columns: nullable(Type.Integer({ minimum: 0 })), pending_review_count: nullable(Type.Integer({ minimum: 0 })),
      pending_review: Type.Array(obj({ record_id: id, message: Type.String({ minLength: 1 }) })) })) }),
  ConversationMessageRequest: obj({ message_id: id, project_id: id, body: Type.String({ minLength: 1 }), prompt_version: revision, attachment_material_ids: Type.Array(id) }),
  ConversationMessageResponse: obj({ message_id: id, conversation_id: id, prompt_snapshot_ref: id, intent: Type.Union([Type.Literal('answer'), Type.Literal('update'), Type.Literal('clarify')]), reply: nullable(Type.String()), run_id: nullable(id), created_at: utc }),
  ProjectMessageSaveRequest: obj({ message_id: ProjectMessageIdSchema, submission_request_id: ProjectMessageIdSchema, expected_message_version: nullable(revision), body: Type.String({ minLength: 1, maxLength: 12000 }), material_versions: Type.Array(obj({ material_id: id, material_version: revision }), { maxItems: 100 }) }),
  ProjectMessageSaveResponse: obj({ conversation_id: id, message_id: id, submission_id: id, submission_version: revision, message_version: revision, prompt_snapshot_ref: id, revises_submission_id: nullable(id), content_sha256: hash, created_at: utc, is_current: Type.Boolean(), role: Type.Literal('user'), source_status: Type.Literal('user_asserted'), intent_status: Type.Literal('not_classified'), route: Type.Literal('save_only'), project_message_set_ref: projectMessageSetSchemas.ProjectMessageSetRef }),
  ProjectMessage: ProjectMessageSchema,
  ProjectMessagePage: obj({ conversation_id: id, items: Type.Array(ProjectMessageSchema, { maxItems: 50 }), project_message_set_ref: projectMessageSetSchemas.ProjectMessageSetRef, next_cursor: cursor, has_more: Type.Boolean() }),
  UserSubmissionRequest: obj({ message_id: id, submission_request_id: id, body: Type.String({ minLength: 1, maxLength: 12000 }), run_id: Type.Optional(id), input_revision: Type.Optional(revision), input_hash: Type.Optional(hash), material_versions: Type.Array(obj({ material_id: id, material_version: revision }), { maxItems: 100 }) }),
  UserSubmissionResponse: obj({ submission_id: id, snapshot_id: id, version: revision, message_version: revision, content_sha256: hash, created_at: utc }),
  ModelCallAttempt: obj({ logical_call_id: id, call_id: id, attempt_no: revision, provider_request_id: nullable(id), model_id: Type.String(), prompt_snapshot_ref: id, usage_status: usageStatus, input_tokens: nullable(Type.Integer({ minimum: 0 })), output_tokens: nullable(Type.Integer({ minimum: 0 })), cached_input_tokens: nullable(Type.Integer({ minimum: 0 })), reasoning_tokens: nullable(Type.Integer({ minimum: 0 })), usage_evidence_ref: nullable(id), billable: Type.Boolean(), cost_payer: Type.Literal('platform') }),
  TraceContext: obj({ operation_id: id, request_id: id, trace_id: id, span_id: id, parent_span_id: nullable(id), user_id: nullable(id), project_id: nullable(id), job_id: nullable(id), run_id: nullable(id), work_item_id: nullable(id), occurred_at: utc }),
  ModelAdapterAttemptRecord: obj({ schema_version: Type.Literal(1), adapter: enumOf(MODEL_ADAPTER_KINDS), adapter_version: Type.String({ pattern: '^[A-Za-z0-9._-]{1,128}$' }), trace_id: id, job_id: id, run_id: id, logical_call_id: id, call_id: id, attempt_no: revision, model_id: Type.String({ pattern: '^[A-Za-z0-9._-]{1,128}$' }), model_provider: Type.String({ pattern: '^[a-z0-9_-]{1,64}$' }), model_config_version: Type.String({ pattern: '^[A-Za-z0-9._-]{1,128}$' }), prompt_snapshot_ref: id, provider_request_id: Type.Null({ description: 'codex exec --json exposes no supplier request id; see provider_request_id_status.' }), provider_request_id_status: Type.Literal('unknown'), framework_thread_id: nullable(id), started_at: utc, duration_ms: Type.Integer({ minimum: 0 }), exit_code: nullable(Type.Integer()), exit_signal: nullable(Type.String({ pattern: '^SIG[A-Z0-9]{1,16}$' })), finish_reason: nullable(Type.String({ pattern: '^[a-z_]{1,64}$' })), outcome: enumOf(MODEL_ADAPTER_OUTCOMES), error_code: nullable(enumOf(MODEL_ADAPTER_ERROR_CODES)), tool_attempts: Type.Integer({ minimum: 0 }), usage: obj({ status: enumOf(MODEL_ADAPTER_USAGE_STATUSES), input_tokens: nullable(Type.Integer({ minimum: 0 })), cached_input_tokens: nullable(Type.Integer({ minimum: 0 })), output_tokens: nullable(Type.Integer({ minimum: 0 })), reasoning_tokens: nullable(Type.Integer({ minimum: 0 })), total_tokens: nullable(Type.Integer({ minimum: 0 })) }), pricing_status: Type.Literal('unknown'), result_sha256: nullable(hash) }),
  HealthResponse: obj({ status: Type.Literal('ok'), service: Type.Literal('bondbuddy-m1-api-skeleton'), implementation: Type.Literal('health-and-contract-only') })
} as const;

export type Project = Static<typeof schemas.ProjectResponse>;
export type ArtifactHistoryPage = Static<typeof schemas.ArtifactHistoryResponse>;
export type Run = Static<typeof schemas.RunResponse>;
export type RunEvent = Static<typeof schemas.RunEvent>;
export type ProjectEvent = Static<typeof schemas.ProjectEvent>;
export type Material = Static<typeof schemas.MaterialResponse>;
export type ModelCallAttempt = Static<typeof schemas.ModelCallAttempt>;
export type ModelAdapterAttemptRecord = Static<typeof schemas.ModelAdapterAttemptRecord>;
export type ModelAdapterErrorCode = typeof MODEL_ADAPTER_ERROR_CODES[number];
export type MaterialParseJob = Static<typeof schemas.MaterialParseJobResponse>;
export type Recognition = Static<typeof schemas.RecognitionResponse>;
export type ReportingPeriod = Static<typeof ReportingPeriodSchema>;
export type RecognitionPatchRequest = Static<typeof schemas.RecognitionPatchRequest>;
export type TargetPeriodEvidenceDecisionRequest = Static<typeof schemas.TargetPeriodEvidenceDecisionRequest>;
export type TargetPeriodEvidenceDecisionResponse = Static<typeof schemas.TargetPeriodEvidenceDecisionResponse>;
export type TargetPeriodEvidenceDecisionWithdrawalRequest = Static<typeof schemas.TargetPeriodEvidenceDecisionWithdrawalRequest>;
export type TargetPeriodEvidenceDecisionWithdrawalResponse = Static<typeof schemas.TargetPeriodEvidenceDecisionWithdrawalResponse>;
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
  op('get','/credits/balance','Read available and frozen credits','CreditBalanceResponse'),
  op('post','/projects/{project_id}/credit-quote','Preview one fixed price for the immutable input without reserving credits','FixedQuoteResponse',200,'FixedQuoteRequest',[404,409,503]),
  op('get','/runs/{run_id}/credit-charge','Read this task confirmation and settlement state','RunCreditChargeResponse',200,undefined,[404]),
  op('get','/credits/recharge-config','Read configured payment channels and locked recharge packs','RechargeConfigResponse'),
  op('post','/credits/recharge-orders','Create an idempotent recharge order without starting a task','RechargeOrderResponse',201,'RechargeOrderRequest',[404,409,503]),
  op('get','/credits/recharge-orders/{order_id}','Read an owned recharge order','RechargeOrderResponse',200,undefined,[404]),
  op('post','/credits/recharge-orders/{order_id}/refresh','Verify payment with the configured provider and idempotently issue credits','RechargeOrderResponse',200,undefined,[404,409,422,503]),
  op('post', '/browser-errors', 'Submit a bounded, redacted browser diagnostic under the current session', 'BrowserErrorReportResponse', 201, 'BrowserErrorReportRequest', [401, 403, 404, 422, 429]),
  op('get', '/browser-errors/{report_id}', 'Read one own browser diagnostic', 'BrowserErrorReportView', 200, undefined, [404]),
  op('get', '/admin/browser-errors/{report_id}', 'Audited diagnostic metadata view for log_reader', 'BrowserErrorReportView', 200, undefined, [404]),
  op('get', '/reviewer/projects/{project_id}/issuer-business-profiles', 'List target annual issuer profiles under an active profile-review grant and audit the read', 'IssuerAnnualProfileReviewListResponse', 200, undefined, [404]),
  op('post', '/projects/{project_id}/issuer-business-profiles/{profile_id}/review', 'Approve, request evidence for, or withdraw an exact target annual profile under an active profile-review grant', 'IssuerAnnualProfileReviewResponse', 201, 'IssuerAnnualProfileReviewRequest', [400,403,404,409]),
  op('get', '/projects/{project_id}/materials/{material_id}/versions/{material_version}/issuer-identity/observations', 'Read owned issuer identity review status without raw evidence', 'IssuerIdentityObservationSummaryResponse', 200, undefined, [404]),
  op('get', '/reviewer/projects/{project_id}/materials/{material_id}/versions/{material_version}/issuer-identity/observations', 'Read project-scoped issuer observations under an active reviewer grant and audit the read', 'IssuerIdentityObservationListResponse', 200, undefined, [404]),
  op('get', '/reviewer/projects/{project_id}/materials/{material_id}/versions/{v}/parse-evidence', 'Read paged immutable native parse evidence under an exact project reviewer grant; audits access without excerpts', 'ReviewerParseEvidenceResponse', 200, undefined, [404, 409, 422]),
  op('get', '/reviewer/projects/{project_id}/materials/{material_id}/versions/{v}/issuer-parse-evidence', 'Read immutable issuer material anchors under a scoped identity reviewer grant', 'ReviewerParseEvidenceResponse', 200, undefined, [404,409,422]),
  op('post', '/reviewer/projects/{project_id}/materials/{material_id}/versions/{material_version}/issuer-identity/observations', 'Propose a source observation from one parsed anchor under a scoped identity reviewer grant', 'IssuerIdentityObservationProposalResponse', 201, 'IssuerIdentityObservationProposalRequest', [404,409,422]),
  op('post', '/projects/{project_id}/materials/{material_id}/versions/{material_version}/issuer-identity/observations/{source_record_id}/review', 'Review a source observation with an active reviewer grant', 'IssuerIdentityReviewResponse', 201, 'IssuerIdentityReviewRequest', [400, 403, 404, 409]),
  op('post', '/reviewer/projects/{project_id}/generation-issuer-bindings', 'Append a pending binding against an exact locked input under a scoped identity reviewer grant', 'GenerationIssuerBindingCreateResponse', 201, 'GenerationIssuerBindingCreateRequest', [404,409,422]),
  op('post', '/reviewer/projects/{project_id}/generation-issuer-bindings/{binding_id}/review', 'Review an exact issuer binding under a scoped identity reviewer grant', 'GenerationIssuerBindingReviewResponse', 201, 'GenerationIssuerBindingReviewRequest', [404,409,422]),
  op('get', '/projects/{project_id}/generation-issuer-bindings/{binding_id}/versions/{version}/approved-ref', 'Read an exact currently approved binding ref without source evidence', 'GenerationIssuerBindingRefResponse', 200, undefined, [404]),
  op('get', '/projects/{project_id}/materials/{material_id}/ocr', 'Read latest owned OCR review, not audited facts', 'OcrReview', 200, undefined, [404]),
  op('post', '/projects/{project_id}/materials/{material_id}/ocr/corrections', 'Append a versioned user correction without verifying the source', 'OcrCorrection', 201, 'OcrCorrectionRequest', [404,409]),
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
  ...RECOVERY_OPERATIONS.map(([method,path,response,request]) => op(method,path,'Manual account recovery: verified channel and single-use authorization',response,200,request,[400,404,409,422,429,503])),
  op('get', '/projects', 'Search all owner projects; filter type, actual run state and archive; newest activity first', 'ProjectListResponse', 200, undefined, [422]),
  op('post', '/projects/{project_id}/archive', 'Set archive visibility idempotently without changing inputs, tasks, files or grants', 'ProjectResponse', 200, 'ProjectArchiveRequest', [404]),
  op('post', '/projects', 'Create project draft (contract only)', 'ProjectResponse', 201, 'ProjectCreateRequest'),
  op('get', '/projects/{project_id}', 'Read owner project (contract only)', 'ProjectResponse', 200, undefined, [404]),
  op('delete', '/projects/{project_id}', 'Delete an owned project: access ends now; bytes and derived content purge after the published window', 'ProjectResponse', 204, undefined, [404, 409]),
  op('patch', '/projects/{project_id}', 'Patch draft with If-Match revision (contract only)', 'ProjectResponse', 200, 'ProjectPatchRequest', [404, 409]),
  op('post', '/projects/{project_id}/convert-to-generation', 'Explicit owner conversion of a no-history update draft; immutable old inputs remain historical evidence', 'ProjectKindConversionResponse', 200, 'ProjectKindConversionRequest', [404, 409]),
  op('post', '/projects/{project_id}/input-revisions', 'Lock owner material and draft versions, with optional user-declared target intent; confirmation is neither source fact nor professional review', 'InputRevisionResponse', 201, 'InputRevisionCreateRequest', [404, 409, 422]),
  op('get', '/projects/{project_id}/input-revisions/{input_revision}', 'Read immutable input snapshot (contract only)', 'InputRevisionResponse', 200, undefined, [404]),
  op('post', '/projects/{project_id}/input-revisions/{input_revision}/rule-applicability-context-drafts', 'Create an owner-scoped needs_review applicability draft from a locked input revision', 'RuleApplicabilityContextDraftResponse', 201, 'RuleApplicabilityContextDraftCreateRequest', [404, 409, 422]),
  op('get', '/projects/{project_id}/rule-applicability-context-drafts/{context_id}/versions/{version}', 'Read an exact owner-scoped applicability draft reference; never production eligible', 'RuleApplicabilityContextDraftResponse', 200, undefined, [404]),
  op('post', '/projects/{project_id}/rule-applicability-context-drafts/{context_id}/versions/{version}/reviews', 'Append a project-scoped applicability review or withdrawal; never asserts rule-pack release', 'RuleApplicabilityOverallReviewResponse', 201, 'RuleApplicabilityOverallReviewCreateRequest', [403, 404, 409, 422]),
  op('post', '/projects/{project_id}/materials/uploads', 'Create scoped upload (contract only)', 'UploadSessionResponse', 201, 'UploadCreateRequest', [404, 415, 422]),
  op('post', '/projects/{project_id}/materials/uploads/{upload_id}/complete', 'Verify object bytes/hash and register material idempotently (contract only)', 'MaterialResponse', 200, 'UploadCompleteRequest', [404, 409, 415, 422, 503]),
  op('post', '/projects/{project_id}/materials/role-copies', 'Copy an exact persisted reference into a new historical material; separate owner draft and input actions remain required', 'MaterialRoleCopyResponse', 201, 'MaterialRoleCopyRequest', [404, 409, 422, 503]),
  op('get', '/projects/{project_id}/materials/{material_id}', 'Read current owner material metadata after checking private object availability', 'MaterialResponse', 200, undefined, [404, 503]),
  op('get', '/projects/{project_id}/materials/{material_id}/download', 'Download verified owner material bytes', 'MaterialResponse', 200, undefined, [404]),
  op('delete', '/projects/{project_id}/materials/{material_id}', 'Remove current material access while preserving pinned snapshots', 'MaterialResponse', 204, undefined, [404]),
  op('get', '/projects/{project_id}/events', 'Read current owner material events after the project-local sequence (50 by default, at most 100)', 'ProjectEventsResponse', 200, undefined, [404, 422]),
  op('get', '/projects/{project_id}/materials/{material_id}/parse-job', 'Read the durable parse job of the current material version', 'MaterialParseJobResponse', 200, undefined, [404]),
  op('post', '/projects/{project_id}/materials/{material_id}/parse-job/cancel', 'Cancel a non-final parse job; exactly one final state wins', 'MaterialParseJobResponse', 200, 'RunActionRequest', [404, 409]),
  op('get', '/projects/{project_id}/materials/{material_id}/source-profile', 'Read the latest persisted historical recognition; 409 CAPABILITY_NOT_READY while its parse job is pending', 'RecognitionResponse', 200, undefined, [404, 409]),
  op('patch', '/projects/{project_id}/materials/{material_id}/source-profile', 'Correct source recognition with revision (contract only)', 'RecognitionResponse', 200, 'RecognitionPatchRequest', [404, 409]),
  op('post', '/projects/{project_id}/target-period-evidence-decisions', 'Append a reviewer decision for the complete locked target-period set', 'TargetPeriodEvidenceDecisionResponse', 200, 'TargetPeriodEvidenceDecisionRequest', [403, 404, 409, 422]),
  op('post', '/projects/{project_id}/target-period-evidence-decisions/withdraw', 'Append a reviewer withdrawal of a target-period evidence decision', 'TargetPeriodEvidenceDecisionWithdrawalResponse', 200, 'TargetPeriodEvidenceDecisionWithdrawalRequest', [403, 404, 409, 422]),
  op('get', '/projects/{project_id}/facts/candidates', 'Read owner/project-scoped fact candidates, exact identity and latest decision', 'FactCandidateListResponse', 200, undefined, [404, 422]),
  op('post', '/projects/{project_id}/facts/decisions', 'Append a user conflict decision using the observed expected_version; same-request replays return the original decision', 'FactDecisionResponse', 201, 'FactDecisionRequest', [404, 409, 422]),
  op('get', '/projects/{project_id}/facts/candidates/{candidate_id}/evidence-context', 'Read the immutable server-derived evidence context for its owner or exact granted reviewer', 'FactEvidenceContextResponse', 200, undefined, [403, 404]),
  op('get', '/reviewer/projects/{project_id}/facts/candidates/{candidate_id}/evidence', 'Read exact current fact evidence and native source quotes for an active project-scoped fact evidence reviewer', 'FactEvidenceReviewerReadResponse', 200, undefined, [404, 409, 422]),
  op('post', '/projects/{project_id}/facts/evidence-reviews', 'Append a grant-authorized review pinned to the complete immutable fact evidence context', 'FactEvidenceReviewResponse', 201, 'FactEvidenceReviewRequest', [403, 404, 409, 422]),
  op('post', '/projects/{project_id}/facts/evidence-reviews/withdraw', 'Append a reviewer withdrawal; downstream consumers must fail closed', 'FactEvidenceReviewWithdrawalResponse', 201, 'FactEvidenceReviewWithdrawalRequest', [403, 404, 409, 422]),
  op('post', '/projects/{project_id}/credit-facility-supplements', 'Append owner-scoped user credit assertions with exact immutable revision ancestry', 'CreditFacilitySupplementResponse', 201, 'CreditFacilitySupplementRequest', [404, 409, 422]),
  op('get', '/projects/{project_id}/credit-facility-supplements/{supplement_id}/versions/{version}', 'Read one exact owner/project-scoped credit supplement version', 'CreditFacilitySupplementResponse', 200, undefined, [404, 422]),
  op('post', '/projects/{project_id}/preflight', 'Evaluate an immutable input revision against durable parse jobs, profiles and capability', 'PreflightResponse', 200, 'PreflightRequest', [404, 409]),
  op('post', '/runs/execute', 'Submit idempotent persistent run (contract only)', 'RunResponse', 202, 'ExecuteRequest', [403, 404, 409]),
  op('get', '/runs/{run_id}', 'Re-read owner run after new session (contract only)', 'RunResponse', 200, undefined, [404]),
  op('get', '/runs/{run_id}/events', 'Read events after cursor (contract only)', 'RunEventsResponse', 200, undefined, [404]),
  op('post', '/runs/{run_id}/cancel', 'Cancel server run explicitly (contract only)', 'RunResponse', 200, 'RunActionRequest', [404, 409]),
  op('post', '/runs/{run_id}/resume', 'Resume paused run after provider reconciliation (contract only)', 'RunResponse', 200, 'RunActionRequest', [404, 409]),
  op('get', '/artifacts/{artifact_id}', 'Get authorized checked Word artifact', 'ArtifactResponse', 200, undefined, [404]),
  op('get', '/projects/{project_id}/artifacts', 'List bounded, checked owner/project Word result history; no download grants', 'ArtifactHistoryResponse', 200, undefined, [404, 422, 503]),
  op('get', '/artifacts/{artifact_id}/download', 'Download checked owner Word artifact bytes', 'ArtifactResponse', 200, undefined, [404]),
  op('post', '/conversations/{conversation_id}/messages', 'Submit and snapshot user message (contract only)', 'ConversationMessageResponse', 202, 'ConversationMessageRequest', [404, 409]),
  op('post', '/projects/{project_id}/messages', 'Save a user message or exact edit without assistant reply or run execution', 'ProjectMessageSaveResponse', 201, 'ProjectMessageSaveRequest', [404, 409, 422, 503]),
  op('get', '/projects/{project_id}/messages', 'Audited, owner-only message history with stable cursor and exact active set ref', 'ProjectMessagePage', 200, undefined, [404, 409, 422, 503]),
  op('get', '/projects/{project_id}/messages/{message_id}/versions/{version}', 'Audited owner-only read of an immutable earlier user message version', 'ProjectMessage', 200, undefined, [404, 422, 503]),
  op('post', '/internal/projects/{project_id}/submissions', 'Controlled server-side message submission; disabled until conversation integration', 'UserSubmissionResponse', 201, 'UserSubmissionRequest', [404, 409]),
  // #79 operator routes: deny by default; a session without an active operator grant gets 404.
  op('get', '/admin/logs/events', 'Filter redacted observability events by user/project/job/trace/time/model/status/error (log_reader)', 'AdminLogEventsResponse', 200, undefined, [404, 422]),
  op('get', '/admin/errors', 'Audited error counts by code, category and fingerprint (log_operator)', 'AdminErrorCountsResponse', 200, undefined, [404, 422]),
  op('get', '/admin/jobs/{job_id}/timeline', 'Job timeline: prompt refs, stages, model attempts with token breakdown, errors and artifact (log_reader)', 'AdminJobTimelineResponse', 200, undefined, [404]),
  op('get', '/admin/jobs/{job_id}/user-submissions', 'Audited submitted-prompt version index by job (prompt_viewer); bodies use the separate audited prompt view', 'AdminUserSubmissionListResponse', 200, undefined, [404, 422]),
  op('get', '/admin/metrics', 'Token, success/failure rate and duration aggregates; retries and final consumption kept apart (log_reader)', 'AdminMetricsResponse', 200, undefined, [404, 422]),
  op('get', '/admin/prompts/{snapshot_id}', 'Audited plaintext view of a redacted prompt snapshot (prompt_viewer)', 'AdminPromptView', 200, undefined, [404, 422]),
  op('get', '/admin/alerts', 'List operational alerts (log_reader)', 'AdminAlertsResponse', 200, undefined, [404]),
  op('get', '/admin/evidence-gate', 'Read whether new external model calls are paused (log_reader)', 'EvidenceGateResponse', 200, undefined, [404]),
  op('post', '/admin/evidence-gate/resume', 'Append an operator resume after evidence persistence is healthy (log_operator)', 'EvidenceGateResponse', 200, 'EvidenceGateResumeRequest', [404, 409]),
  op('post', '/admin/attempts/{attempt_id}/usage-corrections', 'Append a usage correction; raw observations are never overwritten (log_operator)', 'UsageCorrectionResponse', 201, 'UsageCorrectionRequest', [404, 409, 422]),
  // --- #17 worker runtime: owner-checked SSE streams of persisted state (text/event-stream) ---
  op('get', '/runs/{run_id}/stream', 'SSE of persisted run events; resumes after Last-Event-ID; closing it never cancels the run', 'RunEvent', 200, undefined, [404, 422]),
  op('get', '/projects/{project_id}/materials/{material_id}/parse-job/stream', 'SSE of persisted parse-job events; resumes after Last-Event-ID', 'JobStreamEvent', 200, undefined, [404, 422]),
  // --- end #17 worker runtime ---
  ...(TRIAL_ADMIN_OPERATIONS as unknown as Operation[]) // #35 trial guard
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
    for (const status of operation.errors ?? []) {
      const description = status === 404
        ? 'Owner-safe not found'
        : status === 409
          ? 'Revision, idempotency or precondition conflict'
          : status === 415
            ? 'Unsupported material format'
            : status === 422
              ? operation.path === '/projects/{project_id}/events' || operation.path === '/projects/{project_id}/artifacts' ? 'Invalid cursor or page size' : 'Contract validation error'
              : status === 503
                ? operation.path === '/projects/{project_id}/artifacts' ? 'Stored Word bytes failed the bounded integrity check; retryable' : operation.path === '/projects/{project_id}/materials/{material_id}' ? 'Private object storage is temporarily unavailable; retryable' : 'Upload inspection capacity is temporarily unavailable; retryable'
                : 'Contract error';
      responses[status] = { description, content: { 'application/json': { schema: ref('Error') } } };
    }
    for (const code of [401,403,501]) responses[code] = { description: code === 501 ? 'Capability not connected' : 'Session or CSRF/Origin check failed', content: { 'application/json': { schema: ref('Error') } } };
    const queryParameters = ['/admin/logs/events','/admin/metrics','/admin/errors'].includes(operation.path) ? ADMIN_LOG_FILTERS.map(name => ({ name, in: 'query', required: false, schema: name === 'limit' ? { type: 'integer', minimum: 1, maximum: 500 } : { type: 'string' } })) : operation.path === '/admin/prompts/{snapshot_id}' ? [{ name: 'reason_code', in: 'query', required: true, schema: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' }, description: 'Recorded in the access audit.' }] : operation.path === '/projects' ? Object.entries(schemas.ProjectListQuery.properties).map(([name, schema]) => ({ name, in: 'query', required: false, schema })) : operation.path === '/projects/{project_id}/facts/candidates' ? [{ name: 'cursor', in: 'query', required: false, schema: { type: 'string' } }, { name: 'limit', in: 'query', required: false, schema: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$', default: '50' } }] : ['/reviewer/projects/{project_id}/materials/{material_id}/versions/{v}/parse-evidence','/reviewer/projects/{project_id}/materials/{material_id}/versions/{v}/issuer-parse-evidence'].includes(operation.path) ? [{ name: 'q', in: 'query', required: false, schema: { type: 'string', maxLength: 200 }, description: 'Case-insensitive literal substring filter over evidence quotes.' }, { name: 'cursor', in: 'query', required: false, schema: { type: 'string', maxLength: 2048 }, description: 'Opaque cursor bound to this material version, immutable snapshot, and query.' }] : operation.path === '/reviewer/projects/{project_id}/facts/candidates/{candidate_id}/evidence' ? [{ name: 'cursor', in: 'query', required: false, schema: { type: 'string', maxLength: 2048 }, description: 'Opaque continuation cursor bound to the exact current evidence context.' }] : operation.path === '/projects/{project_id}/events' ? [{ name: 'after', in: 'query', required: false, schema: { type: 'integer', minimum: 0, maximum: 2147483647, default: 0 }, description: 'Last seen project-local sequence; returned events have greater seq.' }, { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, description: 'Maximum events in this page; requests above 100 are rejected.' }] : operation.path.endsWith('/events') ? [{ name: 'after', in: 'query', required: false, schema: { type: 'integer', minimum: 0 }, description: 'Last seen per-run seq; returned events have greater seq.' }] : [];
    const ifMatch = operation.method === 'patch' && operation.path.includes('/projects/') ? [{ name: 'If-Match', in: 'header', required: true, schema: { type: 'string', description: 'Current draft or source-profile revision as decimal integer' } }] : [];
    const ready = ['/browser-errors','/browser-errors/{report_id}','/projects/{project_id}/archive','/projects/{project_id}/convert-to-generation','/projects','/projects/{project_id}','/projects/{project_id}/artifacts','/projects/{project_id}/messages','/projects/{project_id}/messages/{message_id}/versions/{version}','/projects/{project_id}/input-revisions','/projects/{project_id}/input-revisions/{input_revision}','/projects/{project_id}/materials/uploads','/projects/{project_id}/materials/uploads/{upload_id}/complete','/projects/{project_id}/materials/role-copies','/projects/{project_id}/materials/{material_id}','/projects/{project_id}/materials/{material_id}/download','/projects/{project_id}/events','/projects/{project_id}/materials/{material_id}/parse-job','/projects/{project_id}/materials/{material_id}/parse-job/cancel','/projects/{project_id}/materials/{material_id}/source-profile','/reviewer/projects/{project_id}/materials/{material_id}/versions/{v}/parse-evidence','/projects/{project_id}/target-period-evidence-decisions','/projects/{project_id}/target-period-evidence-decisions/withdraw','/projects/{project_id}/facts/candidates','/projects/{project_id}/facts/decisions','/projects/{project_id}/facts/candidates/{candidate_id}/evidence-context','/reviewer/projects/{project_id}/facts/candidates/{candidate_id}/evidence','/projects/{project_id}/facts/evidence-reviews','/projects/{project_id}/facts/evidence-reviews/withdraw','/projects/{project_id}/credit-facility-supplements','/projects/{project_id}/credit-facility-supplements/{supplement_id}/versions/{version}','/projects/{project_id}/preflight','/runs/{run_id}','/runs/{run_id}/events','/artifacts/{artifact_id}','/artifacts/{artifact_id}/download'].includes(operation.path);
    const issuerReviewReady = operation.path.includes('/issuer-identity/observations') ||
      operation.path.includes('/generation-issuer-bindings') || operation.path.endsWith('/issuer-parse-evidence');
    const status = operation.path.includes('/recovery') ? 'implemented; manual-channel-delivery; configured-support-and-grant-required' : operation.path.startsWith('/admin/') ? 'implemented; operator-grant-required; deny-by-default-404' : operation.path.includes('/ocr') ? 'implemented; requires-valid-session' : (['/auth/register','/auth/login'].includes(operation.path) || operation.path.startsWith('/auth/recovery/')) ? 'implemented; PostgreSQL Argon2id credentials' : (['/auth/refresh','/auth/logout','/me'].includes(operation.path) || operation.path.startsWith('/account')) ? 'implemented; PostgreSQL session' : ['/runs/execute','/runs/{run_id}/cancel','/runs/{run_id}/resume'].includes(operation.path) ? 'test-only-durable-queue; production-501-until-provider-logging-and-delivery' : ready || issuerReviewReady ? 'implemented; requires-valid-session' : 'contract-only-or-501';
    const csrfHeader=operation.method==='post'||operation.method==='patch'||operation.method==='delete' ? [{name:'Origin',in:'header',required:true,schema:{type:'string'}},...(!(['/auth/register','/auth/login'].includes(operation.path) || operation.path.startsWith('/auth/recovery/')) ? [{name:'X-BB-CSRF',in:'header',required:true,schema:{type:'string'},description:'Match bb_csrf cookie; required for authenticated mutations.'}] : [])] : [];
    const messageQueryParameters = operation.path === '/projects/{project_id}/messages' && operation.method === 'get'
      ? [{ name: 'cursor', in: 'query', required: false, schema: { type: 'string', maxLength: 256 } },
        { name: 'limit', in: 'query', required: false, schema: { type: 'string', pattern: '^(?:[1-9]|[1-4][0-9]|50)$', default: '20' } }] : [];
    const historyQueryParameters = operation.path === '/projects/{project_id}/artifacts'
      ? Object.entries(schemas.ArtifactHistoryQuery.properties).map(([name, schema]) => ({ name, in: 'query', required: false, schema })) : [];
    paths[path][operation.method] = { summary: operation.summary, 'x-implementation-status': status, security: (['/auth/register','/auth/login'].includes(operation.path) || operation.path.startsWith('/auth/recovery/')) ? [] : [{ [operation.path==='/auth/refresh'||operation.path==='/auth/logout' ? 'refreshCookie' : 'sessionCookie']: [] }], parameters: [...parameters(path), ...queryParameters, ...messageQueryParameters, ...historyQueryParameters, ...ifMatch, ...csrfHeader], ...(operation.request ? { requestBody: { required: true, content: { 'application/json': { schema: ref(operation.request) } } } } : {}), responses };
  }
  const reviewMutation = (summary: string, request: string, response: string, status: string) => ({
    summary, 'x-implementation-status': status, security: [{ sessionCookie: [] }],
    parameters: [{ name: 'Origin', in: 'header', required: true, schema: { type: 'string' } },
      { name: 'X-BB-CSRF', in: 'header', required: true, schema: { type: 'string' } }],
    requestBody: { required: true, content: { 'application/json': { schema: ref(request as SchemaName) } } },
    responses: { 200: { description: 'Persisted or identical replay', content: { 'application/json': { schema: ref(response as SchemaName) } } },
      403: { description: 'Exact active reviewer/operator authorization required', content: { 'application/json': { schema: ref('Error') } } },
      404: { description: 'Review record not found', content: { 'application/json': { schema: ref('Error') } } },
      409: { description: 'Conflicting immutable review record', content: { 'application/json': { schema: ref('Error') } } },
      422: { description: 'Invalid manifest or review evidence', content: { 'application/json': { schema: ref('Error') } } } },
  });
  paths['/api/v1/rule-pack-reviews/manifests'] = { post: reviewMutation('Freeze an immutable manifest version for a rule pack', 'ProductionReviewManifestCreateRequest', 'ProductionReviewManifest', 'implemented; active-scoped-operator-grant; content-hash-validated') };
  paths['/api/v1/rule-pack-reviews/manifests/{manifest_id}/versions/{version}'] = { get: {
    summary: 'Read one frozen production-review manifest version', 'x-implementation-status': 'implemented; active-scope-grant-required',
    security: [{ sessionCookie: [] }], parameters: parameters('/rule-pack-reviews/manifests/{manifest_id}/versions/{version}'),
    responses: { 200: { description: 'Immutable frozen manifest', content: { 'application/json': { schema: ref('ProductionReviewManifest') } } },
      403: { description: 'Active reviewer/operator grant does not cover the scope', content: { 'application/json': { schema: ref('Error') } } },
      404: { description: 'Manifest not found', content: { 'application/json': { schema: ref('Error') } } } },
  } };
  paths['/api/v1/rule-pack-reviews/manifests/{manifest_id}/versions/{version}/attestations'] = { post: reviewMutation('Submit own industry or technical attestation', 'ProductionReviewAttestationSubmitRequest', 'ProductionReviewAttestationEvent', 'implemented; self-submitted; exact-scope-grant; append-only') };
  paths['/api/v1/rule-pack-reviews/manifests/{manifest_id}/versions/{version}/attestations/{attestation_event_id}/withdrawal'] = { post: reviewMutation('Withdraw own reviewer attestation', 'ProductionReviewWithdrawalCreateRequest', 'ProductionReviewAttestationWithdrawalEvent', 'implemented; own-event-only; exact-scope-grant; append-only') };
  paths['/api/v1/rule-pack-releases'] = { post: reviewMutation('Publish an exactly attested frozen rule-pack manifest', 'ProductionRulePackReleaseCreateRequest', 'ProductionRulePackReleaseEvent', 'implemented; active-scoped-operator; two-active-distinct-approvals; frozen-snapshot-only; append-only') };
  paths['/api/v1/rule-pack-releases/{pack_id}/withdrawals'] = { post: reviewMutation('Withdraw the current production rule-pack event', 'ProductionRulePackReleaseActionRequest', 'ProductionRulePackReleaseEvent', 'implemented; active-scoped-operator; current-event-only; append-only') };
  paths['/api/v1/rule-pack-releases/{pack_id}/rollbacks'] = { post: reviewMutation('Restore an exact immutable earlier production event', 'ProductionRulePackReleaseActionRequest', 'ProductionRulePackReleaseEvent', 'implemented; active-scoped-operator; historical-event-only; append-only') };
  (paths['/api/v1/projects/{project_id}/facts/decisions'].post as { responses: Record<string, unknown> }).responses['200'] = {
    description: 'Identical idempotency-key replay of a previously appended immutable decision',
    content: { 'application/json': { schema: ref('FactDecisionResponse') } },
  };
  (paths['/api/v1/projects/{project_id}/facts/evidence-reviews'].post as { responses: Record<string, unknown> }).responses['200'] = {
    description: 'Identical request_id replay of the original immutable evidence review',
    content: { 'application/json': { schema: ref('FactEvidenceReviewResponse') } },
  };
  (paths['/api/v1/projects/{project_id}/facts/evidence-reviews/withdraw'].post as { responses: Record<string, unknown> }).responses['200'] = {
    description: 'Identical request_id replay of the original immutable withdrawal',
    content: { 'application/json': { schema: ref('FactEvidenceReviewWithdrawalResponse') } },
  };
  (paths['/api/v1/projects/{project_id}/credit-facility-supplements'].post as { responses: Record<string, unknown> }).responses['200'] = {
    description: 'Identical request_id replay of a previously appended immutable user assertion',
    content: { 'application/json': { schema: ref('CreditFacilitySupplementResponse') } },
  };
  paths['/api/v1/projects/{project_id}/materials/{material_id}/ocr/pages/{snapshot_id}/{page}'] = {
    get: { summary: 'Read an owner-authorized OCR page image', security: [{ sessionCookie: [] }],
      parameters: parameters('/projects/{project_id}/materials/{material_id}/ocr/pages/{snapshot_id}/{page}'),
      responses: { 200: { description: 'Verified private PNG', content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } }, 404: { description: 'Owner-safe not found' } } }
  };
  paths['/api/v1/projects/{project_id}/materials/uploads/{upload_id}/bytes'] = { put: {
    summary: 'Stream declared bytes to a private owner-scoped upload session',
    'x-implementation-status': 'implemented; requires-valid-session',
    security: [{ sessionCookie: [] }], parameters: [...parameters('/projects/{project_id}/materials/uploads/{upload_id}/bytes'),{name:'Origin',in:'header',required:true,schema:{type:'string'}},{name:'X-BB-CSRF',in:'header',required:true,schema:{type:'string'}}],
    requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
    responses: { '204': { description: 'Bytes verified and received; call complete to register material' }, '404': { description: 'Unknown or foreign upload' }, '422': { description: 'Content mismatch or expired upload', content: { 'application/json': { schema: ref('Error') } } }, '503': { description: 'Temporary upload inspection capacity unavailable; retryable', content: { 'application/json': { schema: ref('Error') } } } }
  } };
  // --- #17 worker runtime: SSE responses are text/event-stream frames whose `data:` matches the schema ---
  for (const [path, schema] of [['/runs/{run_id}/stream', 'RunEvent'], ['/projects/{project_id}/materials/{material_id}/parse-job/stream', 'JobStreamEvent']] as const) {
    const get = paths[`/api/v1${path}`].get as Record<string, any>;
    get['x-implementation-status'] = 'implemented; requires-valid-session; owner-checked';
    get.parameters = [...get.parameters, { name: 'Last-Event-ID', in: 'header', required: false, schema: { type: 'string', pattern: '^(0|[1-9][0-9]{0,9})$' } }, { name: 'after', in: 'query', required: false, schema: { type: 'string', pattern: '^(0|[1-9][0-9]{0,9})$' } }];
    get.responses['200'] = { description: 'Server-sent events: `snapshot` (no id, only without a cursor), persisted events with `id: <seq>`, then `stream.end` (StreamEnd). Reconnect with Last-Event-ID.', content: { 'text/event-stream': { schema: ref(schema) } } };
  }
  (paths['/api/v1/projects/{project_id}/input-revisions/{input_revision}/rule-applicability-context-drafts'].post as Record<string, unknown>)['x-implementation-status'] =
    'implemented; requires-valid-session; owner-scoped; needs_review-only; production_eligible=false';
  (paths['/api/v1/projects/{project_id}/rule-applicability-context-drafts/{context_id}/versions/{version}'].get as Record<string, unknown>)['x-implementation-status'] =
    'implemented; requires-valid-session; owner-scoped; historical-read; needs_review-only; production_eligible=false';
  (paths['/api/v1/projects/{project_id}/rule-applicability-context-drafts/{context_id}/versions/{version}/reviews'].post as Record<string, unknown>)['x-implementation-status'] =
    'implemented; requires-valid-session; active-exact-reviewer-grant; append-only; transactional-outbox; production_eligible=false';
  (paths['/api/v1/projects/{project_id}/credit-facility-supplements'].post as Record<string, unknown>)['x-implementation-status'] =
    'implemented; requires-valid-session; owner-and-project-scoped; append-only; user_asserted-or-review-required; never-manuscript-ready';
  (paths['/api/v1/projects/{project_id}/credit-facility-supplements/{supplement_id}/versions/{version}'].get as Record<string, unknown>)['x-implementation-status'] =
    'implemented; requires-valid-session; exact-owner-project-version-read';
  for (const [path, method] of [['/runs/execute', 'post'], ['/runs/{run_id}/cancel', 'post'], ['/runs/{run_id}/resume', 'post']] as const)
    (paths[`/api/v1${path}`][method] as Record<string, unknown>)['x-implementation-status'] = 'implemented; worker-runtime; production-501-unless-BB_RUN_RUNTIME_ENABLED; stages-without-implementation-pause-capability_not_ready';
  // --- end #17 worker runtime ---
  for (const operation of operations.filter(o => o.path.startsWith('/credits/') || o.path.endsWith('/credit-quote') || o.path.endsWith('/credit-charge'))) {
    (paths[`/api/v1${operation.path}`][operation.method] as Record<string, unknown>)['x-implementation-status'] =
      'implemented; owner-scoped; new-charges-require-BB_PAID_AUTHORING_ENABLED; recharge-requires-configured-provider';
  }
  Object.assign(paths, trialOpenApiPaths(ref)); // #35 trial guard
  Object.assign(paths, agreementOpenApiPaths(ref)); // #7 registration agreement
  return { openapi: '3.1.0', info: { title: 'BondBuddy M1 public contract', version: '0.3.0', description: 'Username/password registration and login use PostgreSQL Argon2id credentials; legacy SMS routes are absent and fail closed. PostgreSQL-backed sessions bind personal routes to a verified user. Durable queue submission/cancel/resume are available only by explicit in-process synthetic-test injection; production returns 501 until #16 provider reconciliation, #79 logs and checked Word delivery. Other capability routes return 501. UTC timestamps end in Z. Nullable means explicitly unknown/not yet available; 0 is a known measured zero. Cursor is opaque and null at end. All personal resources require owner checks; unknown and foreign IDs share 404. Browser closes do not cancel server runs. Access and rotating refresh tokens use HttpOnly Secure SameSite cookies; bb_csrf is a readable SameSite cookie and mutations require its X-BB-CSRF echo plus exact allowed Origin.' }, servers: [{ url: '/' }], components: { schemas: publicSchemas, securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'bb_session', description: 'Server-set HttpOnly, Secure, SameSite access cookie.' }, refreshCookie: { type:'apiKey', in:'cookie', name:'bb_refresh', description:'Rotating HttpOnly, Secure, SameSite refresh cookie with absolute lifetime.' } } }, paths };
}

export { reportingWindow } from './reporting-window.js';

export * from './review-results.js';
export * from './review-workspace.js';
export * from './review-revision.js';
