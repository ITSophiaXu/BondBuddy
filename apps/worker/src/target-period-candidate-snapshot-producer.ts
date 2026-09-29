import { createHash } from 'node:crypto';
import type { OcrReview, TargetPeriodCandidateSnapshotRef } from '@bondbuddy/contracts';
import type { PrivateBlobs } from '@bondbuddy/api/data';
import { validateOcrResponse } from '@bondbuddy/api/ocr';
import type { Pool } from 'pg';
import { getParseSnapshot } from './parse-evidence-repository.js';
import { appendTargetPeriodCandidateSnapshot, type TargetPeriodCandidateSnapshotPool } from './target-period-candidate-snapshot-repository.js';
import { buildTargetPeriodCandidateSnapshot } from './target-period-candidate-snapshot-builder.js';
import { isProjectMessagePinError, loadProjectMessageSetPin, projectMessageSetRequirementsPin,
  type ProjectMessageSetRequirementsPin } from './project-message-set-pin.js';
import { proposeTargetReportingPeriods, type LockedFinancialMaterialRef, type NativePeriodEvidenceSnapshot,
  type OcrPeriodEvidenceSnapshot, type TargetPeriodEvidenceSnapshot } from './target-period-candidates.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_OCR_RESULT_BYTES = 32 * 1024 * 1024;
const PRODUCER_IDENTITY_VERSION = 'target-period-candidate-producer-v1';

export interface TargetPeriodCandidateSnapshotProducerDependencies {
  readonly pool: Pool;
  readonly blobs: PrivateBlobs;
}

export interface ProduceTargetPeriodCandidateSnapshotRequest {
  /** Must come from the authenticated server session, never a browser-supplied owner ID. */
  readonly ownerUserId: string;
  readonly projectId: string;
  /** Exact selected IDs/versions resolved from the current project draft. Hashes and roles are re-read below. */
  readonly selectedFinancialMaterials: readonly { readonly materialId: string; readonly materialVersion: number }[];
  /** Asserted project draft values; the current owner-scoped row is independently compared before persistence. */
  readonly projectDraftRevision: number;
  readonly reportingCutoff: string;
}

type MaterialRow = {
  id: string; version: number | string; sha256: string; role: string; media_type: string; deleted_at: Date | string | null;
};
type StoredOcrResult = {
  response: unknown;
  page_objects: Record<string, { key: string; sha256: string }>;
};

function fail(code: string): Error { return new Error(code); }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { throw fail('TARGET_PERIOD_CANDIDATE_SOURCE_INVALID'); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  const json = JSON.stringify(value);
  if (json === undefined) throw fail('TARGET_PERIOD_CANDIDATE_SOURCE_INVALID');
  return json;
}
function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function date(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function projectCutoff(value: unknown): string | null {
  const details = parseJson(value);
  if (!record(details) || !date(details.reporting_cutoff)) return null;
  return details.reporting_cutoff;
}

function assertNoUnboundProjectRequirements(value: unknown): void {
  const details = parseJson(value);
  if (!record(details)) throw fail('TARGET_PERIOD_CANDIDATE_PROJECT_DETAILS_INVALID');
  // These two open-ended fields can carry user instructions/context but have no immutable
  // requirement-message reference in the current producer contract. Do not silently bind []
  // while dropping their content. Missing/null/whitespace is equivalent to empty.
  for (const key of ['supplementary_notes', 'other_information']) {
    const content = details[key];
    if (content === undefined || content === null) continue;
    if (typeof content !== 'string') throw fail('TARGET_PERIOD_CANDIDATE_PROJECT_DETAILS_INVALID');
    if (content.trim().length > 0) throw fail('TARGET_PERIOD_CANDIDATE_REQUIREMENTS_STORE_REQUIRED');
  }
}

async function loadCurrentProject(pool: Pool, request: ProduceTargetPeriodCandidateSnapshotRequest): Promise<void> {
  const result = await pool.query(`SELECT draft_revision,update_details FROM bb_projects
    WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL`, [request.ownerUserId, request.projectId]);
  if (result.rows.length !== 1) throw fail('TARGET_PERIOD_CANDIDATE_PROJECT_NOT_FOUND');
  const row = result.rows[0]!;
  if (Number(row.draft_revision) !== request.projectDraftRevision || projectCutoff(row.update_details) !== request.reportingCutoff) {
    throw fail('TARGET_PERIOD_CANDIDATE_DRAFT_STALE');
  }
  assertNoUnboundProjectRequirements(row.update_details);
}

/**
 * Resolve the exact active supplemental-requirement set for this owner/project and
 * bind its normalized pin. The private Blob body is never read; only immutable
 * per-message metadata. Any incomplete set fails closed, so a nonempty requirement
 * set is never silently bound as [].
 */
async function loadSupplementalRequirements(pool: Pool,
  request: ProduceTargetPeriodCandidateSnapshotRequest): Promise<ProjectMessageSetRequirementsPin> {
  try {
    const set = await loadProjectMessageSetPin({ query: (sql, values = []) => pool.query(sql, values as never) as never },
      { ownerUserId: request.ownerUserId, projectId: request.projectId });
    return projectMessageSetRequirementsPin(set);
  } catch (error) {
    if (isProjectMessagePinError(error)) throw fail('TARGET_PERIOD_CANDIDATE_REQUIREMENTS_STORE_REQUIRED');
    throw error;
  }
}

function validateRequest(request: ProduceTargetPeriodCandidateSnapshotRequest): void {
  if (!IDENTIFIER.test(request.ownerUserId) || !IDENTIFIER.test(request.projectId) ||
      !Number.isSafeInteger(request.projectDraftRevision) || request.projectDraftRevision < 1 ||
      !date(request.reportingCutoff) || !Array.isArray(request.selectedFinancialMaterials) ||
      request.selectedFinancialMaterials.length < 1 || request.selectedFinancialMaterials.length > 60) {
    throw fail('TARGET_PERIOD_CANDIDATE_REQUEST_INVALID');
  }
  const refs = [...request.selectedFinancialMaterials].sort((a, b) => a.materialId.localeCompare(b.materialId));
  if (new Set(refs.map(item => item.materialId)).size !== refs.length || refs.some(item =>
      !IDENTIFIER.test(item.materialId) || !Number.isSafeInteger(item.materialVersion) || item.materialVersion < 1)) {
    throw fail('TARGET_PERIOD_CANDIDATE_MATERIAL_SELECTION_INVALID');
  }
}

async function loadLockedFinancialMaterials(pool: Pool, request: ProduceTargetPeriodCandidateSnapshotRequest): Promise<LockedFinancialMaterialRef[]> {
  const refs = [...request.selectedFinancialMaterials].sort((a, b) => a.materialId.localeCompare(b.materialId));
  const locked: LockedFinancialMaterialRef[] = [];
  for (const ref of refs) {
    const selected = await pool.query(`SELECT id,version,lower(btrim(sha256::text)) AS sha256,role,media_type
      FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL`,
    [request.ownerUserId, request.projectId, ref.materialId, ref.materialVersion]);
    if (selected.rows.length !== 1) throw fail('TARGET_PERIOD_CANDIDATE_MATERIAL_NOT_FOUND');
    const row = selected.rows[0] as MaterialRow;
    const latest = await pool.query(`SELECT version,lower(btrim(sha256::text)) AS sha256 FROM bb_material_versions
      WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND deleted_at IS NULL ORDER BY version DESC LIMIT 1`,
    [request.ownerUserId, request.projectId, ref.materialId]);
    if (latest.rows.length !== 1 || Number(latest.rows[0]!.version) !== ref.materialVersion ||
        String(latest.rows[0]!.sha256).trim().toLowerCase() !== String(row.sha256).trim().toLowerCase()) {
      throw fail('TARGET_PERIOD_CANDIDATE_MATERIAL_STALE');
    }
    if (!SHA256.test(String(row.sha256).trim().toLowerCase())) throw fail('TARGET_PERIOD_CANDIDATE_MATERIAL_INVALID');
    locked.push({ material_id: String(row.id), material_version: Number(row.version),
      material_sha256: String(row.sha256).trim().toLowerCase(), role: String(row.role) });
  }
  return locked;
}

async function loadNativeSnapshot(pool: Pool, request: ProduceTargetPeriodCandidateSnapshotRequest,
  material: LockedFinancialMaterialRef): Promise<NativePeriodEvidenceSnapshot | null> {
  const latest = await pool.query(`SELECT id FROM bb_parse_snapshots WHERE owner_user_id=$1 AND project_id=$2
    AND material_id=$3 AND material_version=$4 ORDER BY created_at DESC,id DESC LIMIT 1`,
  [request.ownerUserId, request.projectId, material.material_id, material.material_version]);
  if (latest.rows.length === 0) return null;
  const snapshotId = latest.rows.length === 1 ? latest.rows[0]!.id : null;
  if (typeof snapshotId !== 'string' || !IDENTIFIER.test(snapshotId)) throw fail('TARGET_PERIOD_CANDIDATE_SOURCE_INVALID');
  const stored = await getParseSnapshot({ pool }, { ownerUserId: request.ownerUserId, projectId: request.projectId,
    materialId: material.material_id, materialVersion: material.material_version }, snapshotId);
  if (!stored || stored.contentSha256.trim().toLowerCase() !== material.material_sha256 || !stored.evidenceComplete) {
    throw fail('TARGET_PERIOD_CANDIDATE_SOURCE_STALE');
  }
  const rowPins = await pool.query(`SELECT record_id,lower(btrim(record_sha256::text)) AS record_sha256
    FROM bb_parse_evidence WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4 AND snapshot_id=$5
    ORDER BY record_id`, [request.ownerUserId, request.projectId, material.material_id, material.material_version, snapshotId]);
  const recordsById = new Map(stored.response.records.map(record => [record.record_id, record]));
  if (rowPins.rows.length !== recordsById.size) throw fail('TARGET_PERIOD_CANDIDATE_SOURCE_INVENTORY_INVALID');
  const records = rowPins.rows.map(pin => {
    const record = recordsById.get(String(pin.record_id));
    if (!record || typeof pin.record_sha256 !== 'string' || !SHA256.test(pin.record_sha256) ||
        sha256(canonical(record)) !== pin.record_sha256.trim().toLowerCase()) {
      throw fail('TARGET_PERIOD_CANDIDATE_SOURCE_RECORD_HASH_MISMATCH');
    }
    return { ...record, record_sha256: pin.record_sha256.trim().toLowerCase() };
  });
  return {
    method: 'native_text', snapshot_id: stored.snapshotId, response_sha256: stored.responseSha256,
    material_id: material.material_id, material_version: material.material_version, material_sha256: material.material_sha256,
    media_type: stored.response.material!.media_type, parser_version: stored.parserVersion,
    status: stored.response.status, warnings: stored.response.warnings, records,
  };
}

async function loadOcrSnapshot(pool: Pool, blobs: PrivateBlobs, request: ProduceTargetPeriodCandidateSnapshotRequest,
  material: LockedFinancialMaterialRef): Promise<OcrPeriodEvidenceSnapshot | null> {
  const latest = await pool.query(`SELECT s.id,s.request_id,s.result_hash,s.result_key,s.purpose,s.run_id,
      s.material_version,m.sha256 AS material_sha256,m.media_type,m.role
    FROM bb_ocr_snapshots s JOIN bb_material_versions m ON m.owner_user_id=s.owner_user_id AND m.project_id=s.project_id
      AND m.id=s.material_id AND m.version=s.material_version AND m.deleted_at IS NULL
    WHERE s.owner_user_id=$1 AND s.project_id=$2 AND s.material_id=$3 AND s.material_version=$4
    ORDER BY s.created_at DESC,s.id DESC LIMIT 1`,
  [request.ownerUserId, request.projectId, material.material_id, material.material_version]);
  if (latest.rows.length === 0) return null;
  const row = latest.rows[0]!;
  if (row.purpose !== 'source_preflight' || (row.run_id !== null && row.run_id !== undefined)) return null;
  const resultHash = String(row.result_hash).trim().toLowerCase();
  const resultKey = String(row.result_key);
  const materialHash = String(row.material_sha256).trim().toLowerCase();
  const expectedKey = `users/${request.ownerUserId}/projects/${request.projectId}/ocr/results/${resultHash}.json`;
  if (!SHA256.test(resultHash) || resultKey !== expectedKey || materialHash !== material.material_sha256 ||
      String(row.role) !== material.role || Number(row.material_version) !== material.material_version ||
      typeof row.request_id !== 'string' || !IDENTIFIER.test(row.request_id)) {
    throw fail('TARGET_PERIOD_CANDIDATE_OCR_SOURCE_STALE');
  }
  const bytes = await blobs.getIfExistsBounded(resultKey, MAX_OCR_RESULT_BYTES);
  if (!bytes || sha256(bytes) !== resultHash) throw fail('TARGET_PERIOD_CANDIDATE_OCR_RESULT_INTEGRITY_FAILED');
  let stored: StoredOcrResult;
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!record(parsed) || !record(parsed.page_objects)) throw fail('TARGET_PERIOD_CANDIDATE_OCR_RESULT_INVALID');
    stored = parsed as StoredOcrResult;
  } catch { throw fail('TARGET_PERIOD_CANDIDATE_OCR_RESULT_INVALID'); }
  let response: ReturnType<typeof validateOcrResponse>;
  try {
    response = validateOcrResponse(stored.response, { materialId: material.material_id, version: material.material_version,
      sha256: material.material_sha256, mediaType: String(row.media_type), requestId: String(row.request_id), purpose: 'source_preflight' }, false);
  } catch { throw fail('TARGET_PERIOD_CANDIDATE_OCR_RESULT_INVALID'); }
  if (response.status !== 'needs_confirmation' || response.processor_version.length === 0 ||
      (response.coverage !== 'partial' && response.coverage !== 'complete') ||
      response.pages.some(page => page.image_base64 !== '')) throw fail('TARGET_PERIOD_CANDIDATE_OCR_RESULT_INVALID');
  const review: OcrReview = {
    snapshot_id: String(row.id), result_sha256: resultHash, material_id: material.material_id,
    material_version: material.material_version, purpose: 'source_preflight', coverage: response.coverage,
    page_count: response.page_count,
    pages: response.pages.map(page => ({ page: page.page, width: page.width, height: page.height,
      rotation_clockwise: page.rotation_clockwise, coordinate_system: page.coordinate_system,
      image_sha256: page.image_sha256, warnings: page.warnings,
      image_url: `/api/v1/projects/${encodeURIComponent(request.projectId)}/materials/${encodeURIComponent(material.material_id)}/ocr/pages/${encodeURIComponent(String(row.id))}/${page.page}` })),
    records: response.records, corrections: [], warnings: response.warnings, eligible_for_manuscript: false,
  };
  return { method: 'ocr', review, processor_version: response.processor_version, material_sha256: material.material_sha256,
    record_sha256_by_id: Object.fromEntries(response.records.map(item => [item.record_id, sha256(canonical(item))])) };
}

function repositoryPool(pool: Pool): TargetPeriodCandidateSnapshotPool {
  return {
    connect: async () => {
      const client = await pool.connect();
      return { query: (sql, values = []) => client.query(sql, values as never) as never, release: () => client.release() };
    },
    query: (sql, values = []) => pool.query(sql, values as never) as never,
  };
}

/**
 * Builds and persists one server-derived pre-lock period candidate set. The caller supplies only
 * authenticated scope, exact selected financial IDs/versions, and draft intent. Evidence, hashes,
 * roles, parser/OCR identities, and the empty requirement pin are resolved here from trusted rows.
 * The returned reference never approves the candidate or changes target intent.
 */
export async function produceTargetPeriodCandidateSnapshot(
  dependencies: TargetPeriodCandidateSnapshotProducerDependencies,
  request: ProduceTargetPeriodCandidateSnapshotRequest,
): Promise<TargetPeriodCandidateSnapshotRef> {
  validateRequest(request);
  await loadCurrentProject(dependencies.pool, request);
  const lockedMaterials = await loadLockedFinancialMaterials(dependencies.pool, request);
  const snapshots: TargetPeriodEvidenceSnapshot[] = [];
  for (const material of lockedMaterials) {
    const native = await loadNativeSnapshot(dependencies.pool, request, material);
    if (native) snapshots.push(native);
    const ocr = await loadOcrSnapshot(dependencies.pool, dependencies.blobs, request, material);
    if (ocr) snapshots.push(ocr);
  }

  const candidateSet = proposeTargetReportingPeriods({ reporting_cutoff: request.reportingCutoff,
    locked_materials: lockedMaterials, snapshots });
  // Bind the normalized active message set. Empty means no still-effective project messages and
  // still carries an explicit normalized empty pin; nonempty sets are bound from immutable
  // per-message metadata and revalidated under the project lock by the repository.
  const supplementalRequirements = await loadSupplementalRequirements(dependencies.pool, request);
  const identityHash = sha256(canonical({ producer: PRODUCER_IDENTITY_VERSION, owner_user_id: request.ownerUserId,
    project_id: request.projectId, project_draft_revision: request.projectDraftRevision,
    reporting_cutoff: request.reportingCutoff, financial_materials: lockedMaterials,
    candidate_hash: candidateSet.candidate_hash, supplemental_requirements: supplementalRequirements }));
  const candidateSetId = `target-period-candidates-${identityHash.slice(0, 48)}`;
  const requestId = `target-period-candidate-request-${identityHash.slice(0, 48)}`;
  const snapshot = buildTargetPeriodCandidateSnapshot({ candidate_set: candidateSet, candidate_set_id: candidateSetId,
    candidate_set_version: 1, owner_user_id: request.ownerUserId, project_id: request.projectId,
    project_draft_revision: request.projectDraftRevision, reporting_cutoff: request.reportingCutoff,
    locked_materials: lockedMaterials, supplemental_requirements: supplementalRequirements });
  const stored = await appendTargetPeriodCandidateSnapshot({ pool: repositoryPool(dependencies.pool), blobs: dependencies.blobs }, {
    ownerUserId: request.ownerUserId, projectId: request.projectId, requestId,
    selectedFinancialMaterials: request.selectedFinancialMaterials, snapshot,
  });
  return { candidate_set_id: stored.snapshot.candidate_set_id, candidate_set_version: stored.snapshot.candidate_set_version,
    content_sha256: stored.snapshot.content_sha256 };
}
