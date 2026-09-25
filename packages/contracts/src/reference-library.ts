import { Type, type Static, type TSchema } from '@sinclair/typebox';

// #78 / #77 backend reference library. Everything in this file is INTERNAL: it is served only to the
// trusted task service and to granted operators under /api/v1/admin/library/*. None of these schemas
// is part of `schemas` or the public OpenAPI document, and the user-facing API never returns them.

export const LIBRARY_QUERY_SCHEMA_VERSION = 'reference-library-query-v1' as const;
/**
 * v1.1 is additive: a caller that sends `reference-library-query-v1.1` receives the v1 candidate plus the
 * reviewed profile's `comparability` facts and the scoped `chapter_mappings`. A v1 caller keeps the exact v1 shape.
 */
export const LIBRARY_QUERY_SCHEMA_VERSION_V1_1 = 'reference-library-query-v1.1' as const;
export const LIBRARY_QUERY_SCHEMA_VERSIONS = [LIBRARY_QUERY_SCHEMA_VERSION, LIBRARY_QUERY_SCHEMA_VERSION_V1_1] as const;
export const LIBRARY_ACCOUNTING_SCOPES = ['consolidated', 'parent', 'mixed', 'unknown'] as const;
export const LIBRARY_REVENUE_BASES = ['operating_revenue', 'main_business_revenue'] as const;
export const LIBRARY_AMOUNT_UNITS = ['yuan', 'thousand_yuan', 'ten_thousand_yuan', 'million_yuan', 'hundred_million_yuan'] as const;
export const LIBRARY_SYSTEM_OWNER = 'system-reference-library' as const;
export const LIBRARY_JOB_TYPE = 'library' as const;
export const LIBRARY_JOB_SUBTYPES = ['library_sync', 'library_record'] as const;
export const LIBRARY_SOURCE_KINDS = ['public_disclosure', 'operator_import'] as const;
export const LIBRARY_USAGE_RIGHTS = ['commercial_licensed', 'evaluation_only', 'revoked'] as const;
export const LIBRARY_VERSION_STATES = ['pending_parse', 'pending_classify', 'pending_review', 'published', 'superseded', 'withdrawn', 'license_revoked', 'rolled_back', 'rejected', 'failed'] as const;
export const LIBRARY_PROFILE_STATES = ['pending_review', 'published', 'superseded', 'rejected', 'withdrawn', 'rolled_back'] as const;
export const LIBRARY_DOCUMENT_STAGES = ['registration', 'issuance'] as const;
export const LIBRARY_SYNC_ITEM_OUTCOMES = ['new_document', 'new_version', 'unchanged', 'stale_ignored', 'ineligible', 'failed'] as const;
export const LIBRARY_REVIEW_ACTIONS = ['approve', 'reject', 'correct', 'withdraw', 'rollback'] as const;
export const LIBRARY_OPERATOR_ROLES = ['library_reader', 'library_operator'] as const;
export const LIBRARY_ALERT_KINDS = ['source_sync_failed', 'source_stale', 'items_failed', 'review_backlog'] as const;
/** Query outcomes. Only `candidates` carries candidates; every other status is an explicit non-match. */
export const LIBRARY_QUERY_STATUSES = ['candidates', 'no_match', 'unavailable', 'index_version_mismatch'] as const;
/** Pipeline error codes (internal; mapped to public ERROR_CODES only at the API edge). */
export const LIBRARY_ERROR_CODES = ['LIBRARY_SOURCE_UNREACHABLE', 'LIBRARY_FETCH_FAILED', 'LIBRARY_BYTES_INVALID', 'LIBRARY_PARSE_FAILED', 'LIBRARY_CLASSIFY_FAILED', 'LIBRARY_STALE_REVISION', 'LIBRARY_SOURCE_DISABLED', 'LIBRARY_ATTEMPTS_EXHAUSTED'] as const;

const enumOf = <T extends readonly string[]>(values: T) => Type.Union(values.map(value => Type.Literal<T[number]>(value)));
const obj = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const id = Type.String({ minLength: 1, maxLength: 128 });
const code = Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' });
const taxonomyCode = Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' });
const version = Type.String({ minLength: 1, maxLength: 128 });
const date = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const utc = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' });
const market = enumOf(['sse', 'szse', 'nafmii'] as const);
const offering = enumOf(['private', 'public', 'public_all', 'ppn', 'mtn', 'cp', 'scp', 'dfi'] as const);
const stage = enumOf(LIBRARY_DOCUMENT_STAGES);
const currency = Type.String({ pattern: '^[A-Z]{3}$' });
const instrument = Type.String({ minLength: 1, maxLength: 64 });
const scope = obj({ market, offering, instrument: Type.String({ minLength: 1, maxLength: 64 }), document_stage: stage, rule_version: version });

/**
 * v1 internal query, adopted from @loooo139's proposal on #77. The target business set is an unordered
 * set of approved taxonomy codes; amounts and original ranks stay in #33's target profile and are not sent.
 */
export const LibraryQueryRequestSchema = obj({
  schema_version: enumOf(LIBRARY_QUERY_SCHEMA_VERSIONS),
  service_identity: Type.Literal('task_service'),
  audit: obj({ owner_user_id: id, project_id: id, run_id: nullable(id), trace_id: id }),
  target: obj({
    top3_codes: Type.Array(taxonomyCode, { minItems: 3, maxItems: 3, uniqueItems: true }),
    taxonomy_version: version,
    fiscal_year: Type.Integer({ minimum: 1900, maximum: 9999 }),
    evidence_refs: Type.Array(id, { minItems: 1, maxItems: 30 }),
    market, offering, instrument: Type.String({ minLength: 1, maxLength: 64 }), document_stage: stage, rule_version: version,
  }),
  /** Index release the caller expects; null means "current active release". */
  index_release: nullable(id),
});

export const LibraryCandidateSchema = obj({
  reference_id: id,
  document_version_id: id, document_version: Type.Integer({ minimum: 1 }),
  profile_id: id, profile_version: Type.Integer({ minimum: 1 }), taxonomy_version: version, fiscal_year: Type.Integer(),
  market, offering, instrument: Type.String(), document_stage: stage,
  availability: Type.Literal('published'), readable: Type.Literal(true), use_authorized: Type.Literal(true), source_validity: Type.Literal('valid'),
  applicable_scopes: Type.Array(scope),
  chapter_mapping_versions: Type.Array(version),
  review_quality: Type.Integer({ minimum: 0, maximum: 100 }),
  disclosed_at: nullable(date),
  top3_set_key: Type.String(),
});

/**
 * v1.1: reviewed comparability facts of the candidate's profile version, immutable per profile version and
 * required before publish. `null` only for a profile published before these facts existed; callers must
 * treat that as not comparable (never exact).
 */
export const LibraryComparabilitySchema = obj({
  accounting_scope: enumOf(LIBRARY_ACCOUNTING_SCOPES),
  revenue_basis: enumOf(LIBRARY_REVENUE_BASES),
  currency,
  unit: enumOf(LIBRARY_AMOUNT_UNITS),
  fiscal_year: Type.Integer({ minimum: 1900, maximum: 9999 }),
  attestation: obj({ review_id: id, reviewed_by: Type.String({ minLength: 1, maxLength: 128 }), reviewed_at: utc, profile_id: id, profile_version: Type.Integer({ minimum: 1 }) }),
});

/** v1.1: an accepted chapter-mapping version whose source scope is the candidate and whose target scope is the request. */
export const LibraryChapterMappingSchema = obj({
  mapping_version_id: id,
  mapping_key: Type.String({ minLength: 1, maxLength: 128 }),
  version: Type.Integer({ minimum: 1 }),
  status: Type.Literal('accepted'),
  source: obj({ market, offering, instrument }),
  target: obj({ market, offering, instrument }),
  document_stage: stage,
  rule_version: version,
});

export const LibraryCandidateV1_1Schema = Type.Object({
  ...LibraryCandidateSchema.properties,
  comparability: nullable(LibraryComparabilitySchema),
  chapter_mappings: Type.Array(LibraryChapterMappingSchema),
}, { additionalProperties: false });

const release = nullable(obj({ release_id: id, release_no: Type.Integer({ minimum: 1 }) }));
export const LibraryQueryResponseV1Schema = obj({
  schema_version: Type.Literal(LIBRARY_QUERY_SCHEMA_VERSION),
  status: enumOf(LIBRARY_QUERY_STATUSES),
  index_release: release,
  candidates: Type.Array(LibraryCandidateSchema),
  reason: nullable(code),
});
export const LibraryQueryResponseV1_1Schema = obj({
  schema_version: Type.Literal(LIBRARY_QUERY_SCHEMA_VERSION_V1_1),
  status: enumOf(LIBRARY_QUERY_STATUSES),
  index_release: release,
  candidates: Type.Array(LibraryCandidateV1_1Schema),
  reason: nullable(code),
});
/** The response carries the schema version the request asked for. */
export const LibraryQueryResponseSchema = Type.Union([LibraryQueryResponseV1Schema, LibraryQueryResponseV1_1Schema]);

export const LibraryChapterMappingCreateRequestSchema = obj({
  mapping_key: Type.String({ pattern: '^[a-z][a-z0-9_.-]{0,127}$' }),
  source: obj({ market, offering, instrument }),
  target: obj({ market, offering, instrument }),
  document_stage: stage,
  rule_version: version,
  reason: code,
});

const LibrarySelectionLockV1Schema = obj({
  lock_id: id, query_schema_version: Type.Literal(LIBRARY_QUERY_SCHEMA_VERSION),
  document_version_id: id, profile_id: id, taxonomy_version: version, index_release_id: id, locked_at: utc,
});

/** v1.1 locks additionally pin the reviewed profile version and the exact accepted cross-scope mapping, if any. */
export const LibrarySelectionLockV1_1Schema = obj({
  lock_id: id, query_schema_version: Type.Literal(LIBRARY_QUERY_SCHEMA_VERSION_V1_1),
  document_version_id: id, profile_id: id, profile_version: Type.Integer({ minimum: 1 }), taxonomy_version: version,
  index_release_id: id, chapter_mapping_version_id: nullable(id), locked_at: utc,
});
export const LibrarySelectionLockSchema = Type.Union([LibrarySelectionLockV1Schema, LibrarySelectionLockV1_1Schema]);

/** Trusted internal request to pin exactly the candidate checked in a v1.1 query response. */
export const LibrarySelectionLockRequestV1_1Schema = obj({
  owner_user_id: id, project_id: id, run_id: nullable(id),
  query_schema_version: Type.Literal(LIBRARY_QUERY_SCHEMA_VERSION_V1_1),
  document_version_id: id, document_version: Type.Integer({ minimum: 1 }), profile_id: id, profile_version: Type.Integer({ minimum: 1 }),
  taxonomy_version: version, index_release_id: id,
  candidate_scope: obj({ market, offering, instrument }),
  target_scope: obj({ market, offering, instrument, document_stage: stage, rule_version: version }),
  comparability: LibraryComparabilitySchema,
  chapter_mapping_version_id: nullable(id),
});

export const LibraryReviewActionRequestSchema = obj({
  action: enumOf(LIBRARY_REVIEW_ACTIONS),
  reason: code,
  /** rollback only: release to restore. */
  target_release_id: Type.Optional(id),
  /** approve only. */
  review_quality: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  applicable_scopes: Type.Optional(Type.Array(scope, { maxItems: 20 })),
  /** correct only: operator-reviewed profile with per-line evidence. */
  correction: Type.Optional(obj({
    fiscal_year: Type.Integer({ minimum: 1900, maximum: 9999 }),
    taxonomy_version: version,
    market: Type.Optional(market), offering: Type.Optional(offering), instrument: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })), document_stage: Type.Optional(stage),
    /** Reviewed comparability facts; approve refuses a profile without all three. */
    revenue_basis: Type.Optional(enumOf(LIBRARY_REVENUE_BASES)), currency: Type.Optional(currency), unit: Type.Optional(enumOf(LIBRARY_AMOUNT_UNITS)),
    top3: Type.Array(obj({ code: taxonomyCode, label: Type.String({ minLength: 1, maxLength: 100 }), rank: Type.Integer({ minimum: 1, maximum: 3 }), revenue: Type.String({ pattern: '^(?:0|[1-9]\\d*)(?:\\.\\d+)?$' }), evidence: Type.Array(id, { minItems: 1, maxItems: 10 }) }), { minItems: 3, maxItems: 3 }),
  })),
});

export const LibraryOverviewSchema = obj({
  counts: obj({ new_24h: Type.Integer(), pending: Type.Integer(), failed: Type.Integer(), stale_sources: Type.Integer(), published: Type.Integer(), open_reviews: Type.Integer() }),
  sources: Type.Array(obj({ source_id: code, kind: enumOf(LIBRARY_SOURCE_KINDS), usage_rights: enumOf(LIBRARY_USAGE_RIGHTS), enabled: Type.Boolean(), last_success_at: nullable(utc), last_attempt_at: nullable(utc), last_error_code: nullable(Type.String()), stale: Type.Boolean(),
    /** #78 scheduled sync (0032): cadence from the registry, next due time and failures since the last full success. */
    sync_interval_seconds: Type.Integer({ minimum: 300 }), next_sync_due_at: nullable(utc), consecutive_failures: Type.Integer({ minimum: 0 }) })),
  coverage: Type.Array(obj({ market: Type.String(), offering: Type.String(), published: Type.Integer(), business_codes: Type.Integer() })),
  active_release: obj({ release_id: id, release_no: Type.Integer() }),
});

export const LibraryAlertSchema = obj({ kind: enumOf(LIBRARY_ALERT_KINDS), severity: enumOf(['warning', 'critical'] as const), subject: Type.String(), detail: Type.String(), since: nullable(utc) });

export const referenceLibrarySchemas = {
  LibraryQueryRequest: LibraryQueryRequestSchema,
  LibraryQueryResponse: LibraryQueryResponseSchema,
  LibraryCandidate: LibraryCandidateSchema,
  LibraryCandidateV1_1: LibraryCandidateV1_1Schema,
  LibraryComparability: LibraryComparabilitySchema,
  LibraryChapterMapping: LibraryChapterMappingSchema,
  LibraryChapterMappingCreateRequest: LibraryChapterMappingCreateRequestSchema,
  LibrarySelectionLock: LibrarySelectionLockSchema,
  LibrarySelectionLockRequestV1_1: LibrarySelectionLockRequestV1_1Schema,
  LibraryReviewActionRequest: LibraryReviewActionRequestSchema,
  LibraryOverview: LibraryOverviewSchema,
  LibraryAlert: LibraryAlertSchema,
} as const;
export type ReferenceLibrarySchemaName = keyof typeof referenceLibrarySchemas;
export type LibraryQueryRequest = Static<typeof LibraryQueryRequestSchema>;
export type LibraryQueryResponse = Static<typeof LibraryQueryResponseSchema>;
export type LibraryCandidate = Static<typeof LibraryCandidateSchema>;
export type LibraryCandidateV1_1 = Static<typeof LibraryCandidateV1_1Schema>;
export type LibraryComparability = Static<typeof LibraryComparabilitySchema>;
export type LibraryChapterMapping = Static<typeof LibraryChapterMappingSchema>;
export type LibraryChapterMappingCreateRequest = Static<typeof LibraryChapterMappingCreateRequestSchema>;
export type LibraryQueryResponseV1 = Static<typeof LibraryQueryResponseV1Schema>;
export type LibraryQueryResponseV1_1 = Static<typeof LibraryQueryResponseV1_1Schema>;
export type LibrarySelectionLock = Static<typeof LibrarySelectionLockSchema>;
export type LibrarySelectionLockV1_1 = Static<typeof LibrarySelectionLockV1_1Schema>;
export type LibrarySelectionLockRequestV1_1 = Static<typeof LibrarySelectionLockRequestV1_1Schema>;
export type LibraryReviewActionRequest = Static<typeof LibraryReviewActionRequestSchema>;
export type LibraryOverview = Static<typeof LibraryOverviewSchema>;
export type LibraryAlert = Static<typeof LibraryAlertSchema>;
export type LibraryVersionState = typeof LIBRARY_VERSION_STATES[number];
export type LibraryErrorCode = typeof LIBRARY_ERROR_CODES[number];

/** Order-free set key; JSON framing keeps delimiter-bearing codes from colliding (same rule as domain matching). */
export function librarySetKey(codes: readonly string[]): string {
  return JSON.stringify([...codes].sort((a, b) => a.localeCompare(b)));
}
