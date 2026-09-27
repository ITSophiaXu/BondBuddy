import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { isMarketOffering, RULE_APPLICABILITY_FEATURE_DIMENSIONS, RULE_APPLICABILITY_FEATURE_EVIDENCE_V2_CONTRACT_VERSION,
  type Market, type Offering } from '@bondbuddy/contracts';
import { resolveSsePrivateFeatureEvidenceV2, SSE_PRIVATE_APPLICABILITY_TAXONOMY_VERSION } from '@bondbuddy/domain';

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Deliberately empty until industry/source evidence and release review are complete.
// Reviewer-supplied version strings and candidate dictionary maps never publish a taxonomy.
const PUBLISHED_RULE_APPLICABILITY_TAXONOMY_VERSIONS: readonly string[] = [];

export type ApplicabilitySourceKind = 'parse_evidence' | 'user_asserted' | 'unknown';
export type ApplicabilitySourceStatus = 'recognized' | 'user_asserted' | 'unknown' | 'conflicting';

export interface RuleApplicabilityEvidenceRef {
  readonly materialId: string;
  readonly materialVersion: number;
  readonly materialSha256: string;
  readonly parseSnapshotId: string;
  readonly recordId: string;
  readonly recordSha256: string;
}

export interface RuleApplicabilityFieldCandidate {
  /** Opaque producer field key. Maxy's taxonomy is intentionally not defined here. */
  readonly fieldKey: string;
  readonly value: unknown | null;
  readonly sourceKind: ApplicabilitySourceKind;
  readonly sourceStatus: ApplicabilitySourceStatus;
  readonly conflictRefs?: readonly string[];
  readonly evidence?: readonly RuleApplicabilityEvidenceRef[];
}

export interface RuleApplicabilityIssuerIdentityBinding {
  readonly recordId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly entityId: string;
  readonly materialId: string;
  readonly materialVersion: number;
}

export interface RuleApplicabilitySelectedMaterial {
  readonly materialId: string;
  readonly materialVersion: number;
  readonly sha256: string;
  readonly parseSnapshotId: string;
}

export interface CreateRuleApplicabilityContextDraftRequest {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly sourceInputRevision: number;
  readonly sourceInputHash: string;
  readonly selectedMaterial: RuleApplicabilitySelectedMaterial;
  readonly issuerIdentityBinding: RuleApplicabilityIssuerIdentityBinding;
  readonly asOf: string | null;
  readonly documentPurpose: 'registration' | 'issuance' | null;
  readonly requestId: string;
  readonly fieldCandidates: readonly RuleApplicabilityFieldCandidate[];
}

export interface RuleApplicabilityContextPin {
  readonly id: string;
  readonly version: number;
  readonly status: 'needs_review';
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly source: { readonly inputRevision: number; readonly inputHash: string; readonly draftRevision: number };
  /** Complete immutable material set in the source input revision, not only the selected parse target. */
  readonly sourceMaterials: readonly { readonly materialId: string; readonly materialVersion: number; readonly sha256: string }[];
  readonly selectedMaterial: RuleApplicabilitySelectedMaterial;
  readonly issuerIdentityBinding: RuleApplicabilityIssuerIdentityBinding;
  readonly asOf: string | null;
  readonly documentPurpose: 'registration' | 'issuance' | null;
  readonly fieldCandidates: readonly (RuleApplicabilityFieldCandidate & {
    readonly ordinal: number;
    readonly reviewDecision: null;
    readonly reviewStatus: 'needs_review';
  })[];
}

export interface CreateRuleApplicabilityContextDraftResult {
  readonly contextId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly status: 'needs_review';
  readonly contextPin: RuleApplicabilityContextPin;
  readonly replayed: boolean;
}

export interface ReviewedRuleApplicabilityContextArgs {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly contextId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly expectedSourceInputRevision: number;
  readonly expectedSourceInputHash: string;
  /** Current project draft revision at the point of production pinning/recovery. */
  readonly currentDraftRevision: number;
  /** Server-selected mode: only a run with a stored production pin may replay. */
  readonly mode?: 'selection' | 'replay';
  /** Full material set resolved by the server for the current input request, not browser-provided hashes. */
  readonly currentMaterialVersions: readonly { readonly materialId: string; readonly materialVersion: number; readonly sha256: string }[];
  readonly expectedIssuerBinding: {
    readonly status: 'verified'; readonly record_id: string; readonly version: number; readonly content_hash: string;
    readonly entity_id: string; readonly issuer_display_name: string; readonly material_id: string; readonly material_version: number;
    readonly source_snapshot_id: string; readonly source_record_id: string; readonly source_record_sha256: string;
    readonly source_content_sha256: string; readonly reviewed_by: string; readonly reviewed_at: string;
  };
}

export type ReviewedRuleApplicabilityContextResult =
  | { readonly status: 'needs_review'; readonly reasons: string[]; readonly contextPin?: RuleApplicabilityContextPin | null }
  | { readonly status: 'approved'; readonly reasons: string[]; readonly request: {
      market: Market; offering: Offering; instrument: string; documentStage: 'registration' | 'issuance';
      issuerScope: string; investorScope: string; industry: string; specialFeatures: readonly string[]; asOf: string;
    }; readonly contextPin: RuleApplicabilityContextPin & Record<string, unknown> };

type CreateDbLike = Pick<Pool, 'connect'>;
type QueryLike = Pick<Pool | PoolClient, 'query'>;
type JsonRecord = Record<string, unknown>;

function fail(code: string): Error {
  const error = new Error(code);
  error.name = 'RuleApplicabilityContextError';
  return error;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  if (value === undefined) throw fail('RULE_CONTEXT_VALUE_NOT_JSON');
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function parseJson(value: unknown): unknown {
  // node-postgres already decodes JSONB. Scalar JSON strings must stay strings
  // rather than being parsed as though they were serialized object text.
  return value;
}

function normalizeSourceMaterials(refs: unknown, manifestMaterials: unknown): RuleApplicabilityContextPin['sourceMaterials'] | null {
  if (!Array.isArray(refs) || !Array.isArray(manifestMaterials) || refs.length !== manifestMaterials.length) return null;
  const versions = new Map<string, number>();
  for (const ref of refs) {
    if (!isRecord(ref) || typeof ref.material_id !== 'string' || !Number.isSafeInteger(ref.material_version) ||
        (ref.material_version as number) < 1) return null;
    const key = `${ref.material_id}\u0000${ref.material_version}`;
    if (versions.has(key)) return null;
    versions.set(key, ref.material_version as number);
  }
  const pins: { materialId: string; materialVersion: number; sha256: string }[] = [];
  const seen = new Set<string>();
  for (const material of manifestMaterials) {
    if (!isRecord(material) || typeof material.material_id !== 'string' || !Number.isSafeInteger(material.material_version) ||
        (material.material_version as number) < 1 || typeof material.sha256 !== 'string' || !SHA256.test(material.sha256.toLowerCase())) return null;
    const key = `${material.material_id}\u0000${material.material_version}`;
    if (seen.has(key) || versions.get(key) !== material.material_version) return null;
    seen.add(key);
    pins.push({ materialId: material.material_id, materialVersion: material.material_version as number, sha256: material.sha256.toLowerCase() });
  }
  if (seen.size !== versions.size) return null;
  return pins.sort((a, b) => a.materialId.localeCompare(b.materialId) || a.materialVersion - b.materialVersion);
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && DATE.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function dateText(value: unknown): string | null {
  if (value === null) return null;
  if (value instanceof Date) return `${value.getFullYear().toString().padStart(4, '0')}-${(value.getMonth() + 1).toString().padStart(2, '0')}-${value.getDate().toString().padStart(2, '0')}`;
  return String(value).slice(0, 10);
}

function dateTimeText(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) return String(value);
  return date.toISOString();
}

function validateEvidence(evidence: RuleApplicabilityEvidenceRef): void {
  if (![evidence.materialId, evidence.parseSnapshotId, evidence.recordId].every((value) => ID.test(value)) ||
      !Number.isSafeInteger(evidence.materialVersion) || evidence.materialVersion < 1 ||
      !SHA256.test(evidence.materialSha256) || !SHA256.test(evidence.recordSha256)) {
    throw fail('RULE_CONTEXT_EVIDENCE_REFERENCE_INVALID');
  }
}

function validateRequest(request: CreateRuleApplicabilityContextDraftRequest): void {
  if (![request.ownerUserId, request.projectId, request.requestId,
        request.selectedMaterial.materialId, request.selectedMaterial.parseSnapshotId,
        request.issuerIdentityBinding.recordId, request.issuerIdentityBinding.entityId,
        request.issuerIdentityBinding.materialId].every((value) => typeof value === 'string' && ID.test(value)) ||
      !Number.isSafeInteger(request.sourceInputRevision) || request.sourceInputRevision < 1 ||
      !SHA256.test(request.sourceInputHash) ||
      !Number.isSafeInteger(request.selectedMaterial.materialVersion) || request.selectedMaterial.materialVersion < 1 ||
      !SHA256.test(request.selectedMaterial.sha256) ||
      !Number.isSafeInteger(request.issuerIdentityBinding.version) || request.issuerIdentityBinding.version < 1 ||
      !Number.isSafeInteger(request.issuerIdentityBinding.materialVersion) || request.issuerIdentityBinding.materialVersion < 1 ||
      !SHA256.test(request.issuerIdentityBinding.contentHash) ||
      (request.asOf !== null && !validDate(request.asOf)) ||
      (request.documentPurpose !== null && !['registration', 'issuance'].includes(request.documentPurpose)) ||
      !Array.isArray(request.fieldCandidates) || request.fieldCandidates.length > 256) {
    throw fail('RULE_CONTEXT_REQUEST_INVALID');
  }
  const keys = new Set<string>();
  for (const [ordinal, candidate] of request.fieldCandidates.entries()) {
    if (!candidate || !ID.test(candidate.fieldKey) || keys.has(candidate.fieldKey) ||
        !['parse_evidence', 'user_asserted', 'unknown'].includes(candidate.sourceKind) ||
        !['recognized', 'user_asserted', 'unknown', 'conflicting'].includes(candidate.sourceStatus) ||
        !Array.isArray(candidate.conflictRefs ?? []) || (candidate.conflictRefs?.length ?? 0) > 64 ||
        (candidate.conflictRefs ?? []).some((ref: string) => !ID.test(ref)) ||
        !Array.isArray(candidate.evidence ?? []) || (candidate.evidence?.length ?? 0) > 64) {
      throw fail(`RULE_CONTEXT_CANDIDATE_INVALID:${ordinal}`);
    }
    keys.add(candidate.fieldKey);
    if (candidate.sourceKind === 'unknown' && (candidate.sourceStatus !== 'unknown' || candidate.value !== null)) {
      throw fail(`RULE_CONTEXT_UNKNOWN_MUST_BE_NULL:${candidate.fieldKey}`);
    }
    if (candidate.sourceKind === 'user_asserted' && !['user_asserted', 'conflicting'].includes(candidate.sourceStatus)) {
      throw fail(`RULE_CONTEXT_USER_ASSERTION_STATUS_INVALID:${candidate.fieldKey}`);
    }
    if (candidate.sourceKind === 'parse_evidence' && (!candidate.evidence || candidate.evidence.length === 0)) {
      throw fail(`RULE_CONTEXT_PARSE_EVIDENCE_REQUIRED:${candidate.fieldKey}`);
    }
    if (candidate.fieldKey === 'specialFeatures' && Array.isArray(candidate.value) && candidate.value.length === 0) {
      throw fail('RULE_CONTEXT_EMPTY_SPECIAL_FEATURES_REQUIRES_REVIEW_RECORD');
    }
    canonical(candidate.value);
    for (const evidence of candidate.evidence ?? []) validateEvidence(evidence);
  }
  for (const [fieldKey, value] of [['asOf', request.asOf], ['documentPurpose', request.documentPurpose]] as const) {
    const candidate = request.fieldCandidates.find((field) => field.fieldKey === fieldKey);
    if (!candidate) throw fail(`RULE_CONTEXT_${fieldKey.toUpperCase()}_CANDIDATE_MISSING`);
    if (candidate && canonical(candidate.value) !== canonical(value)) throw fail(`RULE_CONTEXT_${fieldKey.toUpperCase()}_CANDIDATE_MISMATCH`);
  }
}

function normalizeRequest(request: CreateRuleApplicabilityContextDraftRequest): CreateRuleApplicabilityContextDraftRequest {
  return {
    ...request,
    selectedMaterial: { ...request.selectedMaterial },
    issuerIdentityBinding: { ...request.issuerIdentityBinding },
    fieldCandidates: request.fieldCandidates.map((candidate) => ({
      fieldKey: candidate.fieldKey, value: candidate.value, sourceKind: candidate.sourceKind,
      sourceStatus: candidate.sourceStatus, conflictRefs: [...(candidate.conflictRefs ?? [])],
      evidence: [...(candidate.evidence ?? [])].map((evidence) => ({ ...evidence }))
        .sort((a, b) => a.recordId.localeCompare(b.recordId)),
    })),
  };
}

function requestHash(request: CreateRuleApplicabilityContextDraftRequest): string {
  return hash(normalizeRequest(request));
}

/** Same recursively sorted object keys and preserved array order as API inputManifestHash. */
export function ruleApplicabilityContextHash(contextPin: unknown): string {
  return hash(contextPin);
}

function mapPin(row: JsonRecord, candidates: readonly JsonRecord[]): RuleApplicabilityContextPin {
  const binding: RuleApplicabilityIssuerIdentityBinding = {
    recordId: String(row.issuer_identity_record_id), version: Number(row.issuer_identity_version),
    contentHash: String(row.issuer_identity_hash).trim(), entityId: String(row.issuer_entity_id),
    materialId: String(row.issuer_identity_material_id), materialVersion: Number(row.issuer_identity_material_version),
  };
  const fields = candidates.map((candidate) => ({
    fieldKey: String(candidate.field_key), value: parseJson(candidate.candidate_value),
    sourceKind: String(candidate.source_kind) as ApplicabilitySourceKind,
    sourceStatus: String(candidate.source_status) as ApplicabilitySourceStatus,
    conflictRefs: parseJson(candidate.conflict_refs) as string[],
    evidence: parseJson(candidate.evidence_refs) as RuleApplicabilityEvidenceRef[],
    ordinal: Number(candidate.ordinal), reviewDecision: null, reviewStatus: 'needs_review' as const,
  }));
  return {
    id: String(row.id), version: Number(row.version), status: 'needs_review',
    ownerUserId: String(row.owner_user_id), projectId: String(row.project_id),
    source: { inputRevision: Number(row.source_input_revision), inputHash: String(row.source_input_hash).trim(),
      draftRevision: Number(row.source_draft_revision) },
    sourceMaterials: parseJson(row.source_materials) as RuleApplicabilityContextPin['sourceMaterials'],
    selectedMaterial: { materialId: String(row.selected_material_id), materialVersion: Number(row.selected_material_version),
      sha256: String(row.selected_material_sha256).trim(), parseSnapshotId: String(row.selected_parse_snapshot_id) },
    issuerIdentityBinding: binding,
    asOf: dateText(row.as_of),
    documentPurpose: row.document_purpose === null ? null : String(row.document_purpose) as 'registration' | 'issuance',
    fieldCandidates: fields,
  };
}

async function readCandidates(client: QueryLike, ownerUserId: string, projectId: string, contextId: string, version: number): Promise<JsonRecord[]> {
  const result = await client.query(`SELECT c.field_key, c.ordinal, c.candidate_value, c.source_kind, c.source_status,
      c.conflict_refs, COALESCE(jsonb_agg(jsonb_build_object(
        'materialId',e.material_id,'materialVersion',e.material_version,'materialSha256',trim(e.material_sha256),
        'parseSnapshotId',e.parse_snapshot_id,'recordId',e.evidence_record_id,'recordSha256',trim(e.evidence_record_sha256)
      ) ORDER BY e.evidence_record_id) FILTER (WHERE e.evidence_record_id IS NOT NULL), '[]'::jsonb) AS evidence_refs
    FROM bb_rule_applicability_context_candidates c
    LEFT JOIN bb_rule_applicability_context_candidate_evidence e
      ON e.owner_user_id=c.owner_user_id AND e.project_id=c.project_id AND e.context_id=c.context_id
      AND e.context_version=c.context_version AND e.candidate_id=c.candidate_id
    WHERE c.owner_user_id=$1 AND c.project_id=$2 AND c.context_id=$3 AND c.context_version=$4
    GROUP BY c.field_key,c.ordinal,c.candidate_value,c.source_kind,c.source_status,c.conflict_refs
    ORDER BY c.ordinal`, [ownerUserId, projectId, contextId, version]);
  return result.rows as JsonRecord[];
}

/**
 * Append a private candidate snapshot. DB state and its outbox record commit
 * together. This function never writes a reviewed value or production status.
 */
export async function createRuleApplicabilityContextDraft(
  db: CreateDbLike,
  request: CreateRuleApplicabilityContextDraftRequest,
): Promise<CreateRuleApplicabilityContextDraftResult> {
  validateRequest(request);
  request = normalizeRequest(request);
  const reqHash = requestHash(request);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${request.ownerUserId}:${request.projectId}:rule-context:${request.requestId}`]);
    const prior = await client.query(`SELECT * FROM bb_rule_applicability_context_drafts
      WHERE owner_user_id=$1 AND project_id=$2 AND request_id=$3`, [request.ownerUserId, request.projectId, request.requestId]);
    if (prior.rows.length) {
      const row = prior.rows[0] as JsonRecord;
      if (String(row.request_hash).trim() !== reqHash) throw fail('RULE_CONTEXT_IDEMPOTENCY_CONFLICT');
      const candidates = await readCandidates(client, request.ownerUserId, request.projectId, String(row.id), Number(row.version));
      const contextPin = mapPin(row, candidates);
      if (ruleApplicabilityContextHash(contextPin) !== String(row.content_hash).trim()) throw fail('RULE_CONTEXT_STORED_HASH_MISMATCH');
      await client.query('COMMIT');
      return { contextId: contextPin.id, version: contextPin.version, contentHash: String(row.content_hash).trim(),
        status: 'needs_review', contextPin, replayed: true };
    }

    const source = await client.query(`SELECT input_hash, draft_revision, manifest, material_versions FROM bb_input_revisions
      WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3 FOR SHARE`,
    [request.ownerUserId, request.projectId, request.sourceInputRevision]);
    if (!source.rows.length || String(source.rows[0]!.input_hash).trim() !== request.sourceInputHash) throw fail('RULE_CONTEXT_SOURCE_INPUT_MISMATCH');
    const currentDraft = await client.query(`SELECT draft_revision FROM bb_projects
      WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE`, [request.ownerUserId, request.projectId]);
    if (!currentDraft.rows.length || Number(source.rows[0]!.draft_revision) !== Number(currentDraft.rows[0]!.draft_revision)) {
      throw fail('RULE_CONTEXT_SOURCE_DRAFT_STALE');
    }
    const materialRefs = parseJson(source.rows[0]!.material_versions);
    const manifest = parseJson(source.rows[0]!.manifest);
    const manifestMaterials = isRecord(manifest) ? manifest.materials : null;
    const sourceMaterials = normalizeSourceMaterials(materialRefs, manifestMaterials);
    if (!sourceMaterials) throw fail('RULE_CONTEXT_SOURCE_MATERIAL_SET_INVALID');
    for (const pin of sourceMaterials) {
      const currentMaterial = await client.query(`SELECT sha256,deleted_at FROM bb_material_versions
        WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 FOR SHARE`,
      [request.ownerUserId, request.projectId, pin.materialId, pin.materialVersion]);
      if (!currentMaterial.rows.length || String(currentMaterial.rows[0]!.sha256).trim().toLowerCase() !== pin.sha256 ||
          currentMaterial.rows[0]!.deleted_at !== null) throw fail('RULE_CONTEXT_SOURCE_MATERIAL_STALE');
    }
    if (!Array.isArray(materialRefs) || !materialRefs.some((ref) => isRecord(ref) &&
        ref.material_id === request.selectedMaterial.materialId && ref.material_version === request.selectedMaterial.materialVersion) ||
        !Array.isArray(manifestMaterials) || !manifestMaterials.some((ref) => isRecord(ref) &&
          ref.material_id === request.selectedMaterial.materialId && ref.material_version === request.selectedMaterial.materialVersion &&
          String(ref.sha256 ?? '').trim().toLowerCase() === request.selectedMaterial.sha256)) {
      throw fail('RULE_CONTEXT_SELECTED_MATERIAL_NOT_PINNED');
    }
    const material = await client.query(`SELECT sha256,deleted_at FROM bb_material_versions
      WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 FOR SHARE`,
    [request.ownerUserId, request.projectId, request.selectedMaterial.materialId, request.selectedMaterial.materialVersion]);
    if (!material.rows.length || String(material.rows[0]!.sha256).trim().toLowerCase() !== request.selectedMaterial.sha256 || material.rows[0]!.deleted_at !== null) {
      throw fail('RULE_CONTEXT_SELECTED_MATERIAL_STALE');
    }
    const parse = await client.query(`SELECT content_sha256,response_status FROM bb_parse_snapshots
      WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4 AND id=$5 FOR SHARE`,
    [request.ownerUserId, request.projectId, request.selectedMaterial.materialId, request.selectedMaterial.materialVersion, request.selectedMaterial.parseSnapshotId]);
    if (!parse.rows.length || String(parse.rows[0]!.content_sha256).trim() !== request.selectedMaterial.sha256 ||
        !['parsed', 'needs_confirmation'].includes(String(parse.rows[0]!.response_status))) {
      throw fail('RULE_CONTEXT_SELECTED_PARSE_UNAVAILABLE');
    }

    const identity = request.issuerIdentityBinding;
    const identityResult = await client.query(`SELECT r.id, r.identity_version, r.content_sha256, rv.verified_entity_id,
        rv.decision, g.revoked_at, g.id AS grant_id,
        (SELECT max(r2.identity_version) FROM bb_issuer_identity_source_records r2
          WHERE r2.owner_user_id=r.owner_user_id AND r2.project_id=r.project_id
            AND r2.material_id=r.material_id AND r2.material_version=r.material_version) AS latest_version
      FROM bb_issuer_identity_source_records r
      JOIN bb_issuer_identity_source_reviews rv ON rv.owner_user_id=r.owner_user_id AND rv.project_id=r.project_id
        AND rv.material_id=r.material_id AND rv.material_version=r.material_version AND rv.source_record_id=r.id
        AND rv.identity_version=r.identity_version AND rv.content_sha256=r.content_sha256 AND rv.entity_id=r.entity_id
      JOIN bb_issuer_identity_reviewer_grants g ON g.user_id=rv.reviewer_user_id AND g.id=rv.reviewer_grant_id
      WHERE r.owner_user_id=$1 AND r.project_id=$2 AND r.material_id=$3 AND r.material_version=$4
        AND r.id=$5 AND r.identity_version=$6 AND r.content_sha256=$7 AND rv.verified_entity_id=$8
      FOR SHARE OF r,rv,g`, [request.ownerUserId, request.projectId, identity.materialId, identity.materialVersion,
      identity.recordId, identity.version, identity.contentHash, identity.entityId]);
    if (!identityResult.rows.length || identityResult.rows[0]!.decision !== 'verified' || identityResult.rows[0]!.revoked_at !== null ||
        Number(identityResult.rows[0]!.latest_version) !== identity.version) throw fail('RULE_CONTEXT_ISSUER_IDENTITY_NOT_CURRENTLY_VERIFIED');
    const manifestIdentity = isRecord(manifest) ? manifest.issuer_identity : null;
    if (!isRecord(manifestIdentity) || manifestIdentity.status !== 'verified' ||
        manifestIdentity.record_id !== identity.recordId || manifestIdentity.version !== identity.version ||
        manifestIdentity.content_hash !== identity.contentHash || manifestIdentity.entity_id !== identity.entityId ||
        manifestIdentity.material_id !== identity.materialId || manifestIdentity.material_version !== identity.materialVersion) {
      throw fail('RULE_CONTEXT_ISSUER_IDENTITY_SOURCE_MISMATCH');
    }

    for (const candidate of request.fieldCandidates) {
      for (const evidence of candidate.evidence ?? []) {
        const evidenceRow = await client.query(`SELECT e.record_sha256,e.content_sha256,m.sha256 AS material_sha256,m.deleted_at FROM bb_parse_evidence e
          JOIN bb_material_versions m ON m.owner_user_id=e.owner_user_id AND m.project_id=e.project_id
            AND m.id=e.material_id AND m.version=e.material_version
          JOIN bb_parse_snapshots s ON s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id
            AND s.material_id=e.material_id AND s.material_version=e.material_version AND s.id=e.snapshot_id
            AND s.content_sha256=e.content_sha256 AND s.response_status IN ('parsed','needs_confirmation')
          WHERE e.owner_user_id=$1 AND e.project_id=$2 AND e.material_id=$3 AND e.material_version=$4
            AND e.snapshot_id=$5 AND e.record_id=$6 FOR SHARE OF e,m`,
        [request.ownerUserId, request.projectId, evidence.materialId, evidence.materialVersion, evidence.parseSnapshotId, evidence.recordId]);
        const pinnedEvidenceMaterial = Array.isArray(materialRefs) && materialRefs.some((ref) => isRecord(ref) &&
          ref.material_id === evidence.materialId && ref.material_version === evidence.materialVersion) &&
          Array.isArray(manifestMaterials) && manifestMaterials.some((ref) => isRecord(ref) &&
            ref.material_id === evidence.materialId && ref.material_version === evidence.materialVersion &&
            String(ref.sha256 ?? '').trim().toLowerCase() === evidence.materialSha256);
      if (!pinnedEvidenceMaterial || !evidenceRow.rows.length || evidenceRow.rows[0]!.deleted_at !== null ||
            String(evidenceRow.rows[0]!.record_sha256).trim() !== evidence.recordSha256 ||
            String(evidenceRow.rows[0]!.content_sha256).trim() !== evidence.materialSha256 ||
            String(evidenceRow.rows[0]!.material_sha256).trim() !== evidence.materialSha256) {
          throw fail(`RULE_CONTEXT_EVIDENCE_ANCHOR_MISMATCH:${candidate.fieldKey}`);
        }
      }
    }

    const materialValue = request.selectedMaterial;
    const identityValue = request.issuerIdentityBinding;
    const contextId = `rule-context-${randomUUID()}`;
    const contextPin: RuleApplicabilityContextPin = {
      id: contextId, version: 1, status: 'needs_review', ownerUserId: request.ownerUserId, projectId: request.projectId,
      source: { inputRevision: request.sourceInputRevision, inputHash: request.sourceInputHash,
        draftRevision: Number(source.rows[0]!.draft_revision) },
      sourceMaterials,
      selectedMaterial: materialValue, issuerIdentityBinding: identityValue, asOf: request.asOf,
      documentPurpose: request.documentPurpose,
      fieldCandidates: request.fieldCandidates.map((candidate, ordinal) => ({ ...candidate, ordinal,
        conflictRefs: [...(candidate.conflictRefs ?? [])], evidence: [...(candidate.evidence ?? [])],
        reviewDecision: null, reviewStatus: 'needs_review' as const })),
    };
    const contentHash = ruleApplicabilityContextHash(contextPin);
    await client.query(`INSERT INTO bb_rule_applicability_context_drafts
      (id,owner_user_id,project_id,version,source_input_revision,source_input_hash,source_draft_revision,source_materials,selected_material_id,
       selected_material_version,selected_material_sha256,selected_parse_snapshot_id,issuer_identity_material_id,
       issuer_identity_material_version,issuer_identity_record_id,issuer_identity_version,issuer_identity_hash,
       issuer_entity_id,as_of,document_purpose,request_id,request_hash,content_hash)
      VALUES($1,$2,$3,1,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [contextId, request.ownerUserId, request.projectId, request.sourceInputRevision, request.sourceInputHash,
      Number(source.rows[0]!.draft_revision), JSON.stringify(sourceMaterials), materialValue.materialId, materialValue.materialVersion, materialValue.sha256, materialValue.parseSnapshotId,
      identityValue.materialId, identityValue.materialVersion, identityValue.recordId, identityValue.version,
      identityValue.contentHash, identityValue.entityId, request.asOf, request.documentPurpose, request.requestId, reqHash, contentHash]);

    for (const [ordinal, candidate] of request.fieldCandidates.entries()) {
      const candidateId = `rule-context-candidate-${randomUUID()}`;
      await client.query(`INSERT INTO bb_rule_applicability_context_candidates
        (context_id,owner_user_id,project_id,context_version,candidate_id,field_key,ordinal,candidate_value,
         source_kind,source_status,conflict_refs,review_decision,review_status)
        VALUES($1,$2,$3,1,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,NULL,'needs_review')`,
      [contextId, request.ownerUserId, request.projectId, candidateId, candidate.fieldKey, ordinal,
        canonical(candidate.value), candidate.sourceKind, candidate.sourceStatus, JSON.stringify(candidate.conflictRefs ?? [])]);
      for (const evidence of candidate.evidence ?? []) {
        await client.query(`INSERT INTO bb_rule_applicability_context_candidate_evidence
          (owner_user_id,project_id,context_id,context_version,candidate_id,material_id,material_version,
           parse_snapshot_id,evidence_record_id,evidence_record_sha256,material_sha256)
          VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10)`,
        [request.ownerUserId, request.projectId, contextId, candidateId, evidence.materialId, evidence.materialVersion,
          evidence.parseSnapshotId, evidence.recordId, evidence.recordSha256, evidence.materialSha256]);
      }
    }
    await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'rule_applicability_context',$3,'rule_applicability_context.draft_created',$4::jsonb)`,
    [`rule-context-outbox-${randomUUID()}`, request.ownerUserId, contextId,
      JSON.stringify({ project_id: request.projectId, context_id: contextId, version: 1, content_hash: contentHash, status: 'needs_review' })]);
    const row = (await client.query(`SELECT * FROM bb_rule_applicability_context_drafts WHERE id=$1`, [contextId])).rows[0] as JsonRecord;
    const candidates = await readCandidates(client, request.ownerUserId, request.projectId, contextId, 1);
    const persistedPin = mapPin(row, candidates);
    if (ruleApplicabilityContextHash(persistedPin) !== contentHash) throw fail('RULE_CONTEXT_STORED_HASH_MISMATCH');
    await client.query('COMMIT');
    return { contextId, version: 1, contentHash, status: 'needs_review', contextPin: persistedPin, replayed: false };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve producer error */ }
    throw error;
  } finally { client.release(); }
}

export interface RuleApplicabilityContextDraftRef {
  readonly contextId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly sourceInputRevision: number;
  readonly sourceInputHash: string;
  readonly status: 'needs_review';
}

/** Read only the exact owner-scoped draft reference; never returns an eligibility signal. */
export async function readRuleApplicabilityContextDraftRef(
  db: QueryLike,
  expected: { readonly ownerUserId: string; readonly projectId: string; readonly contextId: string; readonly version: number },
): Promise<RuleApplicabilityContextDraftRef | null> {
  const selected = await db.query(`SELECT * FROM bb_rule_applicability_context_drafts
    WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4`,
  [expected.ownerUserId, expected.projectId, expected.contextId, expected.version]);
  if (!selected.rows.length) return null;
  const row = selected.rows[0] as JsonRecord;
  const contextPin = mapPin(row, await readCandidates(db, expected.ownerUserId, expected.projectId, expected.contextId, expected.version));
  const contentHash = String(row.content_hash).trim();
  if (contextPin.status !== 'needs_review' || ruleApplicabilityContextHash(contextPin) !== contentHash) {
    throw fail('RULE_CONTEXT_STORED_HASH_MISMATCH');
  }
  return {
    contextId: String(row.id), version: Number(row.version), contentHash,
    sourceInputRevision: Number(row.source_input_revision), sourceInputHash: String(row.source_input_hash).trim(),
    status: 'needs_review',
  };
}

/**
 * Load an exact context pin on the caller's transaction client and recheck its current source evidence. This slice
 * intentionally has no approved branch until taxonomy and reviewer thresholds
 * are supplied; production callers cannot derive a rule request from a draft.
 */
export async function loadReviewedRuleApplicabilityContext(
  db: QueryLike,
  expected: ReviewedRuleApplicabilityContextArgs,
): Promise<ReviewedRuleApplicabilityContextResult> {
  const selected = await db.query(`SELECT * FROM bb_rule_applicability_context_drafts
    WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4`,
  [expected.ownerUserId, expected.projectId, expected.contextId, expected.version]);
  if (!selected.rows.length) return { status: 'needs_review', reasons: ['rule_applicability_context_pin_mismatch'] };
  const row = selected.rows[0] as JsonRecord;
  const identity = expected.expectedIssuerBinding;
  const storedIdentityMatches = String(row.issuer_identity_record_id) === identity.record_id &&
    Number(row.issuer_identity_version) === identity.version && String(row.issuer_identity_hash).trim() === identity.content_hash &&
    String(row.issuer_entity_id) === identity.entity_id && String(row.issuer_identity_material_id) === identity.material_id &&
    Number(row.issuer_identity_material_version) === identity.material_version;
  if (String(row.owner_user_id) !== expected.ownerUserId || String(row.project_id) !== expected.projectId ||
      String(row.id) !== expected.contextId || Number(row.version) !== expected.version ||
      String(row.content_hash).trim() !== expected.contentHash ||
      Number(row.source_input_revision) !== expected.expectedSourceInputRevision ||
      String(row.source_input_hash).trim() !== expected.expectedSourceInputHash ||
      Number(row.source_draft_revision) !== expected.currentDraftRevision || !storedIdentityMatches) {
    return { status: 'needs_review', reasons: ['rule_applicability_context_pin_mismatch'] };
  }
  const contextPin = mapPin(row, await readCandidates(db, expected.ownerUserId, expected.projectId, expected.contextId, expected.version));
  if (ruleApplicabilityContextHash(contextPin) !== expected.contentHash) {
    return { status: 'needs_review', reasons: ['rule_applicability_context_content_hash_mismatch'] };
  }
    const reasons: string[] = [];
    if (contextPin.status !== 'needs_review') reasons.push('rule_applicability_context_status_invalid');
    const input = await db.query(`SELECT input_hash,draft_revision,material_versions,manifest FROM bb_input_revisions
      WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3`, [expected.ownerUserId, expected.projectId, expected.expectedSourceInputRevision]);
    if (!input.rows.length || String(input.rows[0]!.input_hash).trim() !== expected.expectedSourceInputHash) reasons.push('rule_applicability_source_revision_stale');
    const refs = input.rows.length ? parseJson(input.rows[0]!.material_versions) : null;
    const sourceManifest = input.rows.length ? parseJson(input.rows[0]!.manifest) : null;
    const sourceMaterials = isRecord(sourceManifest) ? sourceManifest.materials : null;
    const currentSourceMaterials = normalizeSourceMaterials(refs, sourceMaterials);
    if (!currentSourceMaterials || canonical(currentSourceMaterials) !== canonical(contextPin.sourceMaterials)) {
      reasons.push('rule_applicability_source_material_set_mismatch');
    }
    const currentDraft = await db.query(`SELECT draft_revision FROM bb_projects
      WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL`, [expected.ownerUserId, expected.projectId]);
    if (!currentDraft.rows.length || Number(input.rows[0]?.draft_revision) !== expected.currentDraftRevision ||
        (expected.mode !== 'replay' && Number(currentDraft.rows[0]!.draft_revision) !== expected.currentDraftRevision)) {
      reasons.push('rule_applicability_current_draft_stale');
    }
    const requestMaterials = expected.currentMaterialVersions.map((item) => ({ ...item, sha256: item.sha256.toLowerCase() }))
      .sort((a, b) => a.materialId.localeCompare(b.materialId) || a.materialVersion - b.materialVersion);
    if (requestMaterials.some((item) => !ID.test(item.materialId) || !Number.isSafeInteger(item.materialVersion) ||
        item.materialVersion < 1 || !SHA256.test(item.sha256)) ||
        new Set(requestMaterials.map((item) => `${item.materialId}\u0000${item.materialVersion}`)).size !== requestMaterials.length ||
        canonical(requestMaterials) !== canonical(contextPin.sourceMaterials)) {
      reasons.push('rule_applicability_current_material_set_mismatch');
    }
    for (const pin of requestMaterials) {
    const material = await db.query(`SELECT sha256,deleted_at FROM bb_material_versions
        WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4`,
      [expected.ownerUserId, expected.projectId, pin.materialId, pin.materialVersion]);
      if (!material.rows.length || String(material.rows[0]!.sha256).trim().toLowerCase() !== pin.sha256 || material.rows[0]!.deleted_at !== null) {
        reasons.push(`rule_applicability_current_material_unverified:${pin.materialId}:${pin.materialVersion}`);
      }
    }
    for (const pin of contextPin.sourceMaterials) {
      const material = await db.query(`SELECT sha256,deleted_at FROM bb_material_versions
        WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4`,
      [expected.ownerUserId, expected.projectId, pin.materialId, pin.materialVersion]);
      if (!material.rows.length || String(material.rows[0]!.sha256).trim().toLowerCase() !== pin.sha256 || material.rows[0]!.deleted_at !== null) {
        reasons.push(`rule_applicability_material_stale:${pin.materialId}:${pin.materialVersion}`);
      }
    }
    const selectedParse = await db.query(`SELECT content_sha256,response_status FROM bb_parse_snapshots
      WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4 AND id=$5`,
    [expected.ownerUserId, expected.projectId, contextPin.selectedMaterial.materialId, contextPin.selectedMaterial.materialVersion,
      contextPin.selectedMaterial.parseSnapshotId]);
    if (!selectedParse.rows.length || String(selectedParse.rows[0]!.content_sha256).trim() !== contextPin.selectedMaterial.sha256 ||
        !['parsed', 'needs_confirmation'].includes(String(selectedParse.rows[0]!.response_status))) {
      reasons.push('rule_applicability_selected_parse_stale');
    }
    const manifestIdentity = isRecord(sourceManifest) ? sourceManifest.issuer_identity : null;
    if (!isRecord(manifestIdentity) || canonical(manifestIdentity) !== canonical(identity)) reasons.push('rule_applicability_manifest_identity_mismatch');
    const currentIdentity = await db.query(`SELECT r.id,r.identity_version,r.content_sha256,rv.verified_entity_id,r.issuer_display_name,
        r.material_id,r.material_version,r.snapshot_id,r.source_record_id,r.source_record_sha256,r.source_content_sha256,
        rv.reviewer_user_id,rv.created_at,rv.decision,g.revoked_at,
        (SELECT max(r2.identity_version) FROM bb_issuer_identity_source_records r2
          WHERE r2.owner_user_id=r.owner_user_id AND r2.project_id=r.project_id
            AND r2.material_id=r.material_id AND r2.material_version=r.material_version) AS latest_version
      FROM bb_issuer_identity_source_records r
      JOIN bb_issuer_identity_source_reviews rv ON rv.owner_user_id=r.owner_user_id AND rv.project_id=r.project_id
        AND rv.material_id=r.material_id AND rv.material_version=r.material_version AND rv.source_record_id=r.id
        AND rv.identity_version=r.identity_version AND rv.content_sha256=r.content_sha256 AND rv.entity_id=r.entity_id
      JOIN bb_issuer_identity_reviewer_grants g ON g.user_id=rv.reviewer_user_id AND g.id=rv.reviewer_grant_id
      WHERE r.owner_user_id=$1 AND r.project_id=$2 AND r.material_id=$3 AND r.material_version=$4
        AND r.id=$5 AND r.identity_version=$6 AND r.content_sha256=$7 AND rv.verified_entity_id=$8`,
    [expected.ownerUserId, expected.projectId, identity.material_id, identity.material_version,
      identity.record_id, identity.version, identity.content_hash, identity.entity_id]);
    const currentRecord = currentIdentity.rows[0] as JsonRecord | undefined;
    if (!currentRecord || currentRecord.decision !== 'verified' || currentRecord.revoked_at !== null ||
        Number(currentRecord.latest_version) !== identity.version ||
        String(currentRecord.issuer_display_name) !== identity.issuer_display_name ||
        String(currentRecord.snapshot_id) !== identity.source_snapshot_id || String(currentRecord.source_record_id) !== identity.source_record_id ||
        String(currentRecord.source_record_sha256).trim() !== identity.source_record_sha256 ||
        String(currentRecord.source_content_sha256).trim() !== identity.source_content_sha256 ||
        String(currentRecord.reviewer_user_id) !== identity.reviewed_by || dateTimeText(currentRecord.created_at) !== identity.reviewed_at) {
      reasons.push('rule_applicability_issuer_identity_stale');
    }
    for (const candidate of contextPin.fieldCandidates) {
      for (const evidence of candidate.evidence ?? []) {
        const found = await db.query(`SELECT e.record_sha256,e.content_sha256,m.sha256 AS material_sha256,m.deleted_at
          FROM bb_parse_evidence e JOIN bb_material_versions m ON m.owner_user_id=e.owner_user_id AND m.project_id=e.project_id
            AND m.id=e.material_id AND m.version=e.material_version
          JOIN bb_parse_snapshots s ON s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id
            AND s.material_id=e.material_id AND s.material_version=e.material_version AND s.id=e.snapshot_id
            AND s.content_sha256=e.content_sha256 AND s.response_status IN ('parsed','needs_confirmation')
          WHERE e.owner_user_id=$1 AND e.project_id=$2 AND e.material_id=$3 AND e.material_version=$4
            AND e.snapshot_id=$5 AND e.record_id=$6`,
        [expected.ownerUserId, expected.projectId, evidence.materialId, evidence.materialVersion, evidence.parseSnapshotId, evidence.recordId]);
        const evidenceMaterialPinned = Array.isArray(refs) && refs.some((ref) => isRecord(ref) && ref.material_id === evidence.materialId &&
          ref.material_version === evidence.materialVersion) && Array.isArray(sourceMaterials) && sourceMaterials.some((ref) => isRecord(ref) &&
            ref.material_id === evidence.materialId && ref.material_version === evidence.materialVersion &&
            String(ref.sha256 ?? '').trim().toLowerCase() === evidence.materialSha256);
        if (!evidenceMaterialPinned || !found.rows.length || found.rows[0]!.deleted_at !== null ||
            String(found.rows[0]!.record_sha256).trim() !== evidence.recordSha256 ||
            String(found.rows[0]!.content_sha256).trim() !== evidence.materialSha256 ||
            String(found.rows[0]!.material_sha256).trim() !== evidence.materialSha256) {
          reasons.push(`rule_applicability_evidence_stale:${candidate.fieldKey}`);
        }
      }
    }
    const overall = await db.query(`SELECT * FROM bb_rule_applicability_overall_reviews
      WHERE owner_user_id=$1 AND project_id=$2 AND context_id=$3 AND context_version=$4
        AND context_content_hash=$5 AND source_input_revision=$6 AND source_input_hash=$7
      ORDER BY sequence_id DESC LIMIT 1`, [expected.ownerUserId, expected.projectId, expected.contextId, expected.version,
      expected.contentHash, expected.expectedSourceInputRevision, expected.expectedSourceInputHash]);
    const review = overall.rows[0] as JsonRecord | undefined;
    if (!review || review.action !== 'approve') {
      reasons.push(review?.action === 'withdraw' ? 'rule_applicability_overall_review_withdrawn' : 'rule_applicability_overall_review_required');
      return { status: 'needs_review', reasons: [...new Set(reasons)], contextPin };
    }
    const reviewGrant = await db.query(`SELECT 1 FROM bb_rule_applicability_reviewer_grants g
      JOIN bb_users u ON u.id=g.user_id AND u.status='active'
      JOIN bb_projects p ON p.owner_user_id=g.scope_owner_user_id AND p.id=g.scope_project_id AND p.deleted_at IS NULL
      WHERE g.id=$1 AND g.user_id=$2 AND g.role='rule_applicability_reviewer' AND g.revoked_at IS NULL
        AND g.scope_owner_user_id=$3 AND g.scope_project_id=$4 FOR SHARE OF g,p,u`,
    [review.reviewer_grant_id, review.reviewer_user_id, expected.ownerUserId, expected.projectId]);
    if (!reviewGrant.rows.length) reasons.push('rule_applicability_overall_review_grant_inactive');
    const laterFieldAction = await db.query(`SELECT 1 FROM bb_rule_applicability_field_reviews
      WHERE owner_user_id=$1 AND project_id=$2 AND context_id=$3 AND context_version=$4 AND reviewed_at>$5 LIMIT 1`,
    [expected.ownerUserId, expected.projectId, expected.contextId, expected.version, review.reviewed_at]);
    if (laterFieldAction.rows.length) reasons.push('rule_applicability_field_review_newer_than_aggregate');
    const approved = parseJson(review.applicability_values);
    const valueEvidence = parseJson(review.value_evidence);
    const featureEvidence = parseJson(review.feature_evidence);
    const taxonomyVersion = typeof review.taxonomy_version === 'string' ? review.taxonomy_version : '';
    const isEvidenceRef = (value: unknown): value is RuleApplicabilityEvidenceRef => isRecord(value) &&
      typeof value.materialId === 'string' && Number.isSafeInteger(value.materialVersion) && typeof value.materialSha256 === 'string' &&
      typeof value.parseSnapshotId === 'string' && typeof value.recordId === 'string' && typeof value.recordSha256 === 'string';
    const legacyFeatureEvidence = Array.isArray(featureEvidence);
    const v2FeatureEvidence = isRecord(featureEvidence) && featureEvidence.contractVersion === RULE_APPLICABILITY_FEATURE_EVIDENCE_V2_CONTRACT_VERSION;
    if (!isRecord(approved) || !isRecord(valueEvidence) || (!legacyFeatureEvidence && !v2FeatureEvidence) ||
        !taxonomyVersion.startsWith('bondbuddy-applicability-')) {
      reasons.push('rule_applicability_overall_review_snapshot_invalid');
      return { status: 'needs_review', reasons: [...new Set(reasons)], contextPin };
    }
    if (!PUBLISHED_RULE_APPLICABILITY_TAXONOMY_VERSIONS.includes(taxonomyVersion)) {
      reasons.push('rule_applicability_taxonomy_not_published');
    }
    const market = approved.market;
    const offering = approved.offering;
    const instrument = approved.instrument;
    const documentStage = approved.documentStage;
    const issuerScope = approved.issuerScope;
    const investorScope = approved.investorScope;
    const industry = approved.industry;
    const specialFeatures = approved.specialFeatures;
    const asOf = approved.asOf;
    if (typeof market !== 'string' || typeof offering !== 'string' || !isMarketOffering(market as Market, offering as Offering) ||
        typeof instrument !== 'string' || instrument.trim() === '' || !['registration', 'issuance'].includes(String(documentStage)) ||
        !['domestic-company', 'other'].includes(String(issuerScope)) || !['professional', 'other'].includes(String(investorScope)) ||
        typeof industry !== 'string' || industry.trim() === '' || !Array.isArray(specialFeatures) ||
        specialFeatures.some((feature) => typeof feature !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(feature)) ||
        !validDate(asOf) || new Set(specialFeatures).size !== specialFeatures.length) {
      reasons.push('rule_applicability_overall_review_values_invalid');
      return { status: 'needs_review', reasons: [...new Set(reasons)], contextPin };
    }
    if (!contextPin.asOf || contextPin.asOf !== asOf || !contextPin.documentPurpose || contextPin.documentPurpose !== documentStage)
      reasons.push('rule_applicability_target_intent_mismatch');
    const confirmation = await db.query(`SELECT market,offering,document_purpose,as_of,confirmed_by
      FROM bb_input_revision_target_confirmations WHERE owner_user_id=$1 AND project_id=$2 AND input_revision=$3`,
    [expected.ownerUserId, expected.projectId, expected.expectedSourceInputRevision]);
    const confirmed = confirmation.rows[0] as JsonRecord | undefined;
    if (!confirmed || confirmed.confirmed_by !== expected.ownerUserId || confirmed.market !== market || confirmed.offering !== offering ||
        confirmed.document_purpose !== documentStage || dateText(confirmed.as_of) !== asOf) reasons.push('rule_applicability_target_confirmation_stale');

    const featureDimensions = legacyFeatureEvidence ? featureEvidence :
      (v2FeatureEvidence && Array.isArray(featureEvidence.dimensions) ? featureEvidence.dimensions : []);
    const featureKeys = featureDimensions.map((item) => isRecord(item) ? item.dimension : null);
    if (featureKeys.length !== RULE_APPLICABILITY_FEATURE_DIMENSIONS.length || new Set(featureKeys).size !== featureKeys.length ||
        RULE_APPLICABILITY_FEATURE_DIMENSIONS.some((key) => !featureKeys.includes(key))) {
      reasons.push('rule_applicability_special_features_evidence_incomplete');
    }
    const positiveFeatures: string[] = [];
    const approvedEvidence: RuleApplicabilityEvidenceRef[] = [];
    for (const key of ['instrument', 'issuerScope', 'investorScope', 'industry']) {
      const fieldEvidence = valueEvidence[key];
      if (!Array.isArray(fieldEvidence) || fieldEvidence.length === 0 || !fieldEvidence.every(isEvidenceRef)) {
        reasons.push(`rule_applicability_approved_field_evidence_missing:${key}`);
      } else approvedEvidence.push(...fieldEvidence);
    }
    if (legacyFeatureEvidence) {
      for (const item of featureEvidence) {
        if (!isRecord(item) || !['present', 'absent', 'not_applicable'].includes(String(item.outcome)) ||
            typeof item.reason !== 'string' || item.reason.trim() === '' || !Array.isArray(item.evidenceRefs) ||
            item.evidenceRefs.length === 0 || !item.evidenceRefs.every(isEvidenceRef)) {
          reasons.push(`rule_applicability_feature_evidence_invalid:${String(isRecord(item) ? item.dimension : 'unknown')}`);
          continue;
        }
        const featureMaterials = [...new Set(item.evidenceRefs.map((evidence) => `${evidence.materialId}\u0000${evidence.materialVersion}`))].sort();
        const pinnedMaterials = contextPin.sourceMaterials.map((material) => `${material.materialId}\u0000${material.materialVersion}`).sort();
        if (canonical(featureMaterials) !== canonical(pinnedMaterials)) reasons.push(`rule_applicability_feature_material_coverage_incomplete:${String(item.dimension)}`);
        approvedEvidence.push(...item.evidenceRefs);
        if (item.outcome === 'present') {
          if (typeof item.featureCode !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(item.featureCode)) reasons.push('rule_applicability_feature_code_invalid');
          else positiveFeatures.push(item.featureCode);
        } else if (item.featureCode !== undefined) reasons.push('rule_applicability_negative_feature_code_invalid');
      }
    } else {
      if (taxonomyVersion !== SSE_PRIVATE_APPLICABILITY_TAXONOMY_VERSION) reasons.push('rule_applicability_feature_taxonomy_version_mismatch');
      const resolved = resolveSsePrivateFeatureEvidenceV2(featureEvidence);
      if (!resolved.accepted) reasons.push(`rule_applicability_feature_evidence_invalid:${resolved.reason}`);
      else positiveFeatures.push(...resolved.specialFeatures);
      for (const item of featureDimensions) {
        if (!isRecord(item) || !Array.isArray(item.evidenceRefs) || item.evidenceRefs.length === 0 || !item.evidenceRefs.every(isEvidenceRef)) {
          reasons.push(`rule_applicability_feature_evidence_invalid:${String(isRecord(item) ? item.dimension : 'unknown')}`);
        } else {
          const featureMaterials = [...new Set(item.evidenceRefs.map((evidence) => `${evidence.materialId}\u0000${evidence.materialVersion}`))].sort();
          const pinnedMaterials = contextPin.sourceMaterials.map((material) => `${material.materialId}\u0000${material.materialVersion}`).sort();
          if (canonical(featureMaterials) !== canonical(pinnedMaterials)) reasons.push(`rule_applicability_feature_material_coverage_incomplete:${String(item.dimension)}`);
          approvedEvidence.push(...item.evidenceRefs);
        }
        const children = isRecord(item) && Array.isArray(item.childAssessments) ? item.childAssessments : [];
        for (const child of children) {
          if (!isRecord(child) || !Array.isArray(child.evidenceRefs) || child.evidenceRefs.length === 0 || !child.evidenceRefs.every(isEvidenceRef)) {
            reasons.push(`rule_applicability_feature_child_evidence_invalid:${String(isRecord(child) ? child.featureCode : 'unknown')}`);
          } else approvedEvidence.push(...child.evidenceRefs);
        }
      }
    }
    if (canonical([...positiveFeatures].sort()) !== canonical([...specialFeatures].sort())) reasons.push('rule_applicability_special_features_value_mismatch');
    for (const evidence of approvedEvidence) {
      const evidenceMaterialPinned = Array.isArray(refs) && refs.some((ref) => isRecord(ref) && ref.material_id === evidence.materialId &&
        ref.material_version === evidence.materialVersion) && Array.isArray(sourceMaterials) && sourceMaterials.some((ref) => isRecord(ref) &&
        ref.material_id === evidence.materialId && ref.material_version === evidence.materialVersion &&
        String(ref.sha256 ?? '').trim().toLowerCase() === evidence.materialSha256);
      const found = await db.query(`SELECT e.record_sha256,e.content_sha256,m.sha256 AS material_sha256,m.deleted_at
        FROM bb_parse_evidence e JOIN bb_material_versions m ON m.owner_user_id=e.owner_user_id AND m.project_id=e.project_id
          AND m.id=e.material_id AND m.version=e.material_version
        JOIN bb_parse_snapshots s ON s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id
          AND s.material_id=e.material_id AND s.material_version=e.material_version AND s.id=e.snapshot_id
          AND s.content_sha256=e.content_sha256 AND s.response_status IN ('parsed','needs_confirmation')
        WHERE e.owner_user_id=$1 AND e.project_id=$2 AND e.material_id=$3 AND e.material_version=$4
          AND e.snapshot_id=$5 AND e.record_id=$6`,
      [expected.ownerUserId, expected.projectId, evidence.materialId, evidence.materialVersion, evidence.parseSnapshotId, evidence.recordId]);
      if (!evidenceMaterialPinned || !found.rows.length || found.rows[0]!.deleted_at !== null ||
          String(found.rows[0]!.record_sha256).trim() !== evidence.recordSha256 ||
          String(found.rows[0]!.content_sha256).trim() !== evidence.materialSha256 ||
          String(found.rows[0]!.material_sha256).trim() !== evidence.materialSha256) reasons.push('rule_applicability_overall_review_evidence_stale');
    }
    if (reasons.length) return { status: 'needs_review', reasons: [...new Set(reasons)], contextPin };
    return { status: 'approved', reasons: [], contextPin: contextPin as RuleApplicabilityContextPin & Record<string, unknown>, request: { market: market as Market, offering: offering as Offering,
      instrument: instrument as string, documentStage: documentStage as 'registration' | 'issuance', issuerScope: issuerScope as string,
      investorScope: investorScope as string, industry: industry as string, specialFeatures: [...specialFeatures] as string[], asOf } };
}
