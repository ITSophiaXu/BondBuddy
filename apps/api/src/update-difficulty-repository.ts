import { createHash, randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import { M1_MATERIAL_PARTITIONS, emptyUpdateDetails, schemas, updateDetailsErrors, type Market, type Offering, type Recognition, type ReportingPeriod } from '@bondbuddy/contracts';
import { estimateUpdateDifficulty, type CutoffDecision, type TargetReportingPeriod, type UpdateDifficultyEstimate, type UserAssertedTargetPeriod } from '@bondbuddy/domain/update-difficulty';
import { parseHistoricalNativeExtractorVersion } from '@bondbuddy/domain/historical-native-extractor-version';

export interface UpdateDifficultyClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release?(): void;
}
export interface UpdateDifficultyPool {
  connect(): Promise<UpdateDifficultyClient>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface UpdateDifficultyDependencies {
  pool: UpdateDifficultyPool;
  newId?: () => string;
}

export interface UpdateDifficultyClientOptions {
  readonly newId?: () => string;
}

/** Internal trusted material and target facts. Never bind this to an HTTP DTO. */
export interface TrustedUpdateDifficultyInput {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly source: { readonly materialId: string; readonly materialVersion: number; readonly profileVersion: number };
  /** Current project draft revision. Project market/offering are read from the locked DB row. */
  readonly targetRevision: number;
  /** Optional immutable input lock. When supplied, its hash and draft revision are checked. */
  readonly inputRevision?: number;
  readonly inputHash?: string;
  readonly financialMaterialVersions: readonly { readonly materialId: string; readonly materialVersion: number }[];
  /** Periods and decisions come from a trusted server-side target/material workflow. */
  readonly targetReportingPeriods: readonly TargetReportingPeriod[];
  readonly replacements: readonly CutoffDecision[];
  readonly restatements: readonly CutoffDecision[];
  readonly requestId: string;
}

export interface StoredUpdateDifficultySnapshot {
  readonly id: string;
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly sourceMaterialId: string;
  readonly sourceMaterialVersion: number;
  readonly sourceProfileVersion: number;
  readonly targetRevision: number;
  readonly sourceMarket: Market | null;
  readonly sourceOffering: Offering | null;
  readonly targetMarket: Market | null;
  readonly targetOffering: Offering | null;
  readonly inputRevision: number | null;
  readonly inputHash: string | null;
  readonly financialMaterialVersions: readonly { materialId: string; materialVersion: number }[];
  readonly comparisonInput: {
    readonly targetReportingPeriods: readonly TargetReportingPeriod[];
    readonly replacements: readonly CutoffDecision[];
    readonly restatements: readonly CutoffDecision[];
  };
  /** The profile does not currently carry a reviewed document-level completeness assessment. */
  readonly oldProfileCompleteness: 'complete' | 'incomplete' | 'undetermined';
  readonly estimate: UpdateDifficultyEstimate;
  readonly createdAt: string;
  readonly replayed: boolean;
}

export interface LockedUpdateDifficultyRequest {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly inputRevision: number;
  readonly inputHash: string;
  readonly requestId: string;
  readonly replacements?: readonly CutoffDecision[];
  readonly restatements?: readonly CutoffDecision[];
}

export type UpdateDifficultyFailureCategory = 'pending_input' | 'stale_input' | 'not_found' | 'data_integrity' | 'invalid_request' | 'internal';

export interface ClassifiedUpdateDifficultyFailure {
  readonly category: UpdateDifficultyFailureCategory;
  readonly code: string;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validateRecognition = ajv.compile(schemas.RecognitionResponse);
const FINANCIAL_ROLES: ReadonlySet<string> = new Set(M1_MATERIAL_PARTITIONS.find(partition => partition.label === '财务与审计')?.roles.map(role => role.code) ?? []);

function fail(code: string): Error { const error = new Error(code); error.name = 'UpdateDifficultyRepositoryError'; return error; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function parseJson(value: unknown): unknown { if (typeof value !== 'string') return value; try { return JSON.parse(value) as unknown; } catch { throw fail('INVALID_UPDATE_DIFFICULTY_ROW'); } }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(value: unknown): string { return createHash('sha256').update(canonical(value), 'utf8').digest('hex'); }

/**
 * Classifies repository errors for the future preflight route. Missing inputs
 * and profiles are ordinary pending work; malformed persisted manifests and
 * rows indicate data integrity problems and must not be shown as a user action.
 */
export function classifyUpdateDifficultyFailure(error: unknown): ClassifiedUpdateDifficultyFailure {
  const code = error instanceof Error ? error.message : 'UNKNOWN_UPDATE_DIFFICULTY_ERROR';
  const categories: Readonly<Record<string, UpdateDifficultyFailureCategory>> = {
    HISTORICAL_MATERIAL_SELECTION_REQUIRED: 'pending_input',
    FINANCIAL_MATERIALS_REQUIRED: 'pending_input',
    HISTORICAL_PROFILE_NOT_FOUND: 'pending_input',
    FINANCIAL_MATERIAL_NOT_FOUND: 'pending_input',
    TARGET_INPUT_REVISION_STALE: 'stale_input',
    TARGET_INPUT_REVISION_MISMATCH: 'stale_input',
    TARGET_REVISION_STALE: 'stale_input',
    TARGET_REVISION_ALREADY_SNAPSHOTTED: 'stale_input',
    LOCKED_MATERIAL_STALE: 'stale_input',
    IDEMPOTENCY_CONFLICT: 'stale_input',
    PROJECT_NOT_FOUND: 'not_found',
    INVALID_UPDATE_DIFFICULTY_CONTEXT: 'invalid_request',
    TARGET_INPUT_MANIFEST_INVALID: 'data_integrity',
    INVALID_HISTORICAL_PROFILE_ROW: 'data_integrity',
    INVALID_UPDATE_DIFFICULTY_ROW: 'data_integrity',
    INVALID_FINANCIAL_MATERIAL_VERSIONS: 'data_integrity',
    FINANCIAL_MATERIAL_NOT_IN_INPUT_REVISION: 'data_integrity',
    HISTORICAL_MATERIAL_SELECTION_MISMATCH: 'data_integrity',
    TARGET_REPORTING_PERIODS_LOCK_MISMATCH: 'data_integrity',
  };
  return { category: categories[code] ?? 'internal', code };
}

function stableSnapshotRequestId(input: TrustedUpdateDifficultyInput): string {
  const financialMaterialVersions = [...input.financialMaterialVersions]
    .map(item => ({ materialId: item.materialId, materialVersion: item.materialVersion }))
    .sort((left, right) => left.materialId.localeCompare(right.materialId) || left.materialVersion - right.materialVersion);
  const identity = {
    ownerUserId: input.ownerUserId,
    projectId: input.projectId,
    targetRevision: input.targetRevision,
    inputRevision: input.inputRevision ?? null,
    inputHash: input.inputHash ?? null,
    source: input.source,
    financialMaterialVersions,
    targetReportingPeriods: input.targetReportingPeriods,
    replacements: input.replacements,
    restatements: input.restatements,
  };
  return `update-difficulty-${sha256(identity).slice(0, 56)}`;
}
function validId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value); }
function safeContext(input: TrustedUpdateDifficultyInput): void {
  if (![input.ownerUserId, input.projectId, input.source.materialId, input.requestId].every(validId) ||
      !Number.isSafeInteger(input.source.materialVersion) || input.source.materialVersion < 1 ||
      !Number.isSafeInteger(input.source.profileVersion) || input.source.profileVersion < 1 ||
      !Number.isSafeInteger(input.targetRevision) || input.targetRevision < 1 ||
      (input.inputRevision !== undefined && (!Number.isSafeInteger(input.inputRevision) || input.inputRevision < 1)) ||
      (input.inputHash !== undefined && !/^[a-f0-9]{64}$/.test(input.inputHash)) ||
      ((input.inputRevision === undefined) !== (input.inputHash === undefined))) throw fail('INVALID_UPDATE_DIFFICULTY_CONTEXT');
  if (input.financialMaterialVersions.length === 0) throw fail('FINANCIAL_MATERIALS_REQUIRED');
  const uniqueMaterials = new Set(input.financialMaterialVersions.map(item => `${item.materialId}\0${item.materialVersion}`));
  if (uniqueMaterials.size !== input.financialMaterialVersions.length || input.financialMaterialVersions.some(item =>
    !validId(item.materialId) || !Number.isSafeInteger(item.materialVersion) || item.materialVersion < 1)) throw fail('INVALID_FINANCIAL_MATERIAL_VERSIONS');
}
function activeRecognition(value: unknown, materialId: string, materialVersion: number, profileVersion: number): Recognition {
  const recognition = parseJson(value);
  if (!validateRecognition(recognition)) throw fail('INVALID_HISTORICAL_PROFILE_ROW');
  const typed = recognition as Recognition;
  if (typed.material_id !== materialId || typed.material_version !== materialVersion || typed.profile_version !== profileVersion) throw fail('INVALID_HISTORICAL_PROFILE_ROW');
  return typed;
}
function hasAnchoredRecognizedFields(recognition: Recognition): boolean {
  const supported = (field: Recognition['source_market' | 'source_offering' | 'latest_reporting_cutoff']) => field.value !== null && field.status === 'recognized' &&
    field.uncertainty.length === 0 && field.provenance.evidence_refs.length > 0;
  return supported(recognition.source_market) && supported(recognition.source_offering) &&
    supported(recognition.latest_reporting_cutoff) && recognition.reporting_periods.length > 0 &&
    recognition.reporting_periods.every(period => period.status === 'recognized' && period.start !== null && period.end !== null &&
      period.period_kind !== null && period.scope !== null && period.uncertainty.length === 0 && period.provenance.evidence_refs.length > 0);
}
function mapRow(row: Record<string, unknown>, replayed: boolean): StoredUpdateDifficultySnapshot {
  const materials = parseJson(row.financial_material_versions);
  const comparisonInput = parseJson(row.comparison_input);
  const estimate = parseJson(row.estimate);
  if (!Array.isArray(materials) || !materials.every(item => isRecord(item) && typeof item.materialId === 'string' && Number.isSafeInteger(item.materialVersion)) ||
      !isRecord(comparisonInput) || !Array.isArray(comparisonInput.targetReportingPeriods) || !Array.isArray(comparisonInput.replacements) ||
      !Array.isArray(comparisonInput.restatements) || !isRecord(estimate) || !validateEstimate(estimate)) throw fail('INVALID_UPDATE_DIFFICULTY_ROW');
  return {
    id: String(row.id), ownerUserId: String(row.owner_user_id), projectId: String(row.project_id), requestId: String(row.request_id),
    requestHash: String(row.request_hash).trim(), sourceMaterialId: String(row.source_material_id),
    sourceMaterialVersion: Number(row.source_material_version), sourceProfileVersion: Number(row.source_profile_version),
    targetRevision: Number(row.target_revision), inputRevision: row.input_revision === null ? null : Number(row.input_revision),
    sourceMarket: row.source_market as Market | null, sourceOffering: row.source_offering as Offering | null,
    targetMarket: row.target_market as Market | null, targetOffering: row.target_offering as Offering | null,
    inputHash: row.input_hash === null ? null : String(row.input_hash).trim(),
    financialMaterialVersions: materials as { materialId: string; materialVersion: number }[],
    comparisonInput: comparisonInput as unknown as StoredUpdateDifficultySnapshot['comparisonInput'],
    oldProfileCompleteness: row.old_profile_completeness as StoredUpdateDifficultySnapshot['oldProfileCompleteness'],
    estimate: estimate as unknown as UpdateDifficultyEstimate, createdAt: new Date(String(row.created_at)).toISOString(), replayed,
  };
}
function validateEstimate(value: Record<string, unknown>): boolean {
  return value.status === 'ready' || value.status === 'needs_confirmation';
}

function targetPeriodFromManifest(value: unknown): UserAssertedTargetPeriod {
  if (!isRecord(value) || ![null, 'annual', 'interim'].includes(value.period_kind as string | null) ||
      ![null, 'consolidated', 'parent'].includes(value.scope as string | null) ||
      !['user_asserted', 'needs_confirmation'].includes(value.status as string) ||
      !(value.start === null || typeof value.start === 'string') || !(value.end === null || typeof value.end === 'string') ||
      !Array.isArray(value.evidence_refs) || value.evidence_refs.length !== 0 ||
      Object.keys(value).some(key => !['start', 'end', 'period_kind', 'scope', 'status', 'evidence_refs'].includes(key))) {
    throw fail('TARGET_INPUT_MANIFEST_INVALID');
  }
  return { start: value.start as string | null, end: value.end as string | null,
    period_kind: value.period_kind as UserAssertedTargetPeriod['period_kind'],
    scope: value.scope as UserAssertedTargetPeriod['scope'], status: value.status as UserAssertedTargetPeriod['status'], evidence_refs: [] };
}

function manifestTargetPeriods(manifest: Record<string, unknown>): UserAssertedTargetPeriod[] {
  const details = manifest.update_details;
  if (!isRecord(details)) throw fail('TARGET_INPUT_MANIFEST_INVALID');
  const raw = details.target_reporting_periods ?? [];
  if (!Array.isArray(raw) || raw.length > 30) throw fail('TARGET_INPUT_MANIFEST_INVALID');
  const periods = raw.map(targetPeriodFromManifest);
  const errors = updateDetailsErrors({ ...emptyUpdateDetails(), target_reporting_periods: periods.map(period => ({ ...period, evidence_refs: [] as string[] })) });
  if (errors.some(error => error.field.startsWith('update_details.target_reporting_periods.'))) throw fail('TARGET_INPUT_MANIFEST_INVALID');
  return periods;
}

function targetPeriodMatches(left: readonly TargetReportingPeriod[], right: readonly TargetReportingPeriod[]): boolean {
  const targetPeriodKeys = ['end', 'evidence_refs', 'period_kind', 'scope', 'start', 'status'];
  const periodKey = (period: TargetReportingPeriod): unknown => ({ start: period.start, end: period.end,
    period_kind: period.period_kind, scope: period.scope, status: period.status,
    evidence_refs: 'evidence_refs' in period ? period.evidence_refs : [] });
  return canonical(left.map(periodKey)) === canonical(right.map(periodKey)) &&
    left.every(period => canonical(Object.keys(period).sort()) === canonical(targetPeriodKeys) &&
      !('provenance' in period) && !('raw_value' in period));
}

/**
 * Assembles the trusted #76 input from the immutable lock. Callers provide only
 * the owner/project/lock identity and request key; materials, source profile,
 * and target periods are derived from owner-scoped database rows.
 */
export async function loadLockedUpdateDifficultyInputWithClient(
  client: UpdateDifficultyClient,
  request: LockedUpdateDifficultyRequest,
): Promise<TrustedUpdateDifficultyInput> {
  if (![request.ownerUserId, request.projectId, request.requestId].every(validId) ||
      !Number.isSafeInteger(request.inputRevision) || request.inputRevision < 1 || !/^[a-f0-9]{64}$/.test(request.inputHash)) {
    throw fail('INVALID_UPDATE_DIFFICULTY_CONTEXT');
  }
  const project = await client.query(`SELECT draft_revision,latest_input_revision FROM bb_projects
      WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE`, [request.ownerUserId, request.projectId]);
    if (project.rows.length !== 1) throw fail('PROJECT_NOT_FOUND');
    if (Number(project.rows[0]!.latest_input_revision) !== request.inputRevision) throw fail('TARGET_INPUT_REVISION_STALE');
    const lock = await client.query(`SELECT input_hash,draft_revision,manifest,material_versions FROM bb_input_revisions
      WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3`, [request.ownerUserId, request.projectId, request.inputRevision]);
    const lockedManifest = lock.rows.length === 1 ? parseJson(lock.rows[0]!.manifest) : null;
    if (lock.rows.length !== 1 || String(lock.rows[0]!.input_hash).trim() !== request.inputHash ||
        Number(lock.rows[0]!.draft_revision) !== Number(project.rows[0]!.draft_revision)) throw fail('TARGET_INPUT_REVISION_MISMATCH');
    const manifest = lockedManifest;
    const refs = parseJson(lock.rows[0]!.material_versions);
    if (!isRecord(manifest) || manifest.kind !== 'update' || Number(manifest.draft_revision) !== Number(project.rows[0]!.draft_revision) ||
        !Array.isArray(manifest.materials) || !Array.isArray(refs)) throw fail('TARGET_INPUT_MANIFEST_INVALID');
    const manifestMaterials = manifest.materials.filter(isRecord).map(item => ({
      material_id: item.material_id, material_version: item.material_version, role: item.role, sha256: item.sha256,
    }));
    const manifestRefs = refs.filter(isRecord).map(item => ({ material_id: item.material_id, material_version: item.material_version }));
    const normalizeRefs = (items: { material_id: unknown; material_version: unknown }[]) => items
      .map(item => ({ material_id: item.material_id, material_version: item.material_version }))
      .sort((a, b) => String(a.material_id).localeCompare(String(b.material_id)) || Number(a.material_version) - Number(b.material_version));
    if (manifestMaterials.length !== manifest.materials.length || manifestRefs.length !== refs.length ||
        canonical(normalizeRefs(manifestMaterials)) !== canonical(normalizeRefs(manifestRefs)) ||
        new Set(manifestMaterials.map(item => String(item.material_id))).size !== manifestMaterials.length ||
        manifestMaterials.some(item => typeof item.material_id !== 'string' || !Number.isSafeInteger(item.material_version) ||
          typeof item.role !== 'string' || typeof item.sha256 !== 'string')) throw fail('TARGET_INPUT_MANIFEST_INVALID');
    const historical = manifestMaterials.filter(item => item.role === 'historical');
    if (historical.length !== 1) throw fail('HISTORICAL_MATERIAL_SELECTION_REQUIRED');
    const finance = manifestMaterials.filter(item => FINANCIAL_ROLES.has(String(item.role)));
    if (!finance.length) throw fail('FINANCIAL_MATERIALS_REQUIRED');
    const materialRows = await client.query(`SELECT m.id,m.version,m.role,m.sha256 FROM bb_material_versions m
      JOIN bb_projects p ON p.owner_user_id=m.owner_user_id AND p.id=m.project_id AND p.deleted_at IS NULL
      WHERE m.owner_user_id=$1 AND m.project_id=$2 AND m.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS x(material_id text,material_version integer)
          WHERE x.material_id=m.id AND x.material_version=m.version)`,
    [request.ownerUserId, request.projectId, JSON.stringify(normalizeRefs(manifestMaterials))]);
    if (materialRows.rows.length !== manifestMaterials.length || materialRows.rows.some(row => {
      const pinned = manifestMaterials.find(item => item.material_id === row.id && Number(item.material_version) === Number(row.version));
      return !pinned || String(row.role) !== pinned.role || String(row.sha256).trim().toLowerCase() !== String(pinned.sha256).trim().toLowerCase();
    })) throw fail('LOCKED_MATERIAL_STALE');
    const sourceMaterial = historical[0]!;
    const profile = await client.query(`SELECT profile_version FROM bb_historical_profiles
      WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4
      ORDER BY profile_version DESC LIMIT 1`,
    [request.ownerUserId, request.projectId, sourceMaterial.material_id, sourceMaterial.material_version]);
    if (profile.rows.length !== 1) throw fail('HISTORICAL_PROFILE_NOT_FOUND');
    const targetReportingPeriods = manifestTargetPeriods(manifest);
    const source = { materialId: String(sourceMaterial.material_id), materialVersion: Number(sourceMaterial.material_version),
      profileVersion: Number(profile.rows[0]!.profile_version) };
    const financialMaterialVersions = finance.map(item => ({ materialId: String(item.material_id), materialVersion: Number(item.material_version) }));
  return { ownerUserId: request.ownerUserId, projectId: request.projectId, source,
      targetRevision: Number(project.rows[0]!.draft_revision), inputRevision: request.inputRevision, inputHash: request.inputHash,
      financialMaterialVersions, targetReportingPeriods,
      replacements: request.replacements ?? [], restatements: request.restatements ?? [], requestId: request.requestId };
}

/**
 * Ensures that the caller's current immutable input lock has a difficulty
 * snapshot. The caller owns the transaction. Locking the project before
 * assembling the input serializes target edits and source-profile corrections
 * with snapshot creation; the stable key includes the exact source/profile,
 * target-period and financial-material tuple returned by the locked loader.
 */
export async function ensureCurrentUpdateDifficultySnapshotWithClient(
  client: UpdateDifficultyClient,
  request: Pick<LockedUpdateDifficultyRequest, 'ownerUserId' | 'projectId' | 'inputRevision' | 'inputHash'>,
  options: UpdateDifficultyClientOptions = {},
): Promise<StoredUpdateDifficultySnapshot> {
  if (![request.ownerUserId, request.projectId].every(validId) ||
      !Number.isSafeInteger(request.inputRevision) || request.inputRevision < 1 || !/^[a-f0-9]{64}$/.test(request.inputHash)) {
    throw fail('INVALID_UPDATE_DIFFICULTY_CONTEXT');
  }
  const project = await client.query(
    `SELECT id FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
    [request.ownerUserId, request.projectId]);
  if (project.rows.length !== 1) throw fail('PROJECT_NOT_FOUND');

  // The loader requires a request key, but this preliminary key is only used
  // while loading. The persisted idempotency key below is derived from the
  // complete owner-locked snapshot tuple, never from an HTTP request id.
  const loaderRequestId = `difficulty-load-${sha256({ ownerUserId: request.ownerUserId, projectId: request.projectId,
    inputRevision: request.inputRevision, inputHash: request.inputHash }).slice(0, 48)}`;
  const loaded = await loadLockedUpdateDifficultyInputWithClient(client, { ...request, requestId: loaderRequestId });
  return createUpdateDifficultySnapshotWithClient(client, { ...loaded, requestId: stableSnapshotRequestId(loaded) }, options);
}

/** Pool-owning worker compatibility wrapper; API callers should pass their transaction client directly. */
export async function loadLockedUpdateDifficultyInput(
  dependencies: UpdateDifficultyDependencies,
  request: LockedUpdateDifficultyRequest,
): Promise<TrustedUpdateDifficultyInput> {
  const client = await dependencies.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await loadLockedUpdateDifficultyInputWithClient(client, request);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* keep the original lock validation error */ }
    throw error;
  } finally { client.release?.(); }
}
const RETURNING_COLUMNS = ['id', 'owner_user_id', 'project_id', 'request_id', 'request_hash', 'source_material_id', 'source_material_version',
  'source_profile_version', 'target_revision', 'source_market', 'source_offering', 'target_market', 'target_offering', 'input_revision',
  'input_hash', 'financial_material_versions', 'comparison_input', 'old_profile_completeness', 'estimate', 'created_at'] as const;
const RETURNING = RETURNING_COLUMNS.join(', ');
const QUALIFIED_RETURNING = RETURNING_COLUMNS.map(column => `s.${column}`).join(', ');

async function fetchProfile(client: UpdateDifficultyClient, input: TrustedUpdateDifficultyInput): Promise<{ recognition: Recognition; state: string }> {
  const result = await client.query(
    `SELECT p.recognition, p.recognition->>'state' AS profile_state
       FROM bb_historical_profiles p
       JOIN bb_projects project ON project.owner_user_id=p.owner_user_id AND project.id=p.project_id AND project.deleted_at IS NULL
       JOIN bb_material_versions m ON m.owner_user_id=p.owner_user_id AND m.project_id=p.project_id
        AND m.id=p.material_id AND m.version=p.material_version AND m.role='historical' AND m.deleted_at IS NULL
        AND m.media_type IN ('application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/pdf')
      WHERE p.owner_user_id=$1 AND p.project_id=$2 AND p.material_id=$3 AND p.material_version=$4 AND p.profile_version=$5
        AND NOT EXISTS (SELECT 1 FROM bb_historical_profiles newer WHERE newer.owner_user_id=p.owner_user_id
          AND newer.project_id=p.project_id AND newer.material_id=p.material_id AND newer.material_version=p.material_version
          AND newer.profile_version>p.profile_version)`,
    [input.ownerUserId, input.projectId, input.source.materialId, input.source.materialVersion, input.source.profileVersion]);
  if (result.rows.length !== 1) throw fail('HISTORICAL_PROFILE_NOT_FOUND');
  const recognition = activeRecognition(result.rows[0]!.recognition, input.source.materialId, input.source.materialVersion, input.source.profileVersion);
  const state = String(result.rows[0]!.profile_state);
  // Corrections remain user_asserted/needs_confirmation by repository policy. They
  // may be snapshotted but can never turn a preflight estimate into ready N.
  return { recognition, state };
}

async function verifyEvidenceRefs(client: UpdateDifficultyClient, input: TrustedUpdateDifficultyInput,
  recognition: Recognition, targetPeriods: readonly TargetReportingPeriod[]): Promise<boolean> {
  for (const material of input.financialMaterialVersions) {
    const row = await client.query(
      `SELECT m.role FROM bb_material_versions m
        JOIN bb_projects p ON p.owner_user_id=m.owner_user_id AND p.id=m.project_id AND p.deleted_at IS NULL
       WHERE m.owner_user_id=$1 AND m.project_id=$2 AND m.id=$3 AND m.version=$4 AND m.deleted_at IS NULL`,
      [input.ownerUserId, input.projectId, material.materialId, material.materialVersion]);
    if (row.rows.length !== 1 || !FINANCIAL_ROLES.has(String(row.rows[0]!.role))) throw fail('FINANCIAL_MATERIAL_NOT_FOUND');
  }
  const financialKeys = new Set(input.financialMaterialVersions.map(item => `${item.materialId}\0${item.materialVersion}`));
  if (input.inputRevision !== undefined) {
    const locked = await client.query(
      `SELECT input_hash, draft_revision, material_versions, manifest FROM bb_input_revisions
        WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3`,
      [input.ownerUserId, input.projectId, input.inputRevision]);
    if (locked.rows.length !== 1 || String(locked.rows[0]!.input_hash).trim() !== input.inputHash || Number(locked.rows[0]!.draft_revision) !== input.targetRevision) throw fail('TARGET_INPUT_REVISION_MISMATCH');
    const refs = parseJson(locked.rows[0]!.material_versions);
    const manifest = parseJson(locked.rows[0]!.manifest);
    if (!isRecord(manifest) || manifest.kind !== 'update' || Number(manifest.draft_revision) !== input.targetRevision) throw fail('TARGET_INPUT_MANIFEST_INVALID');
    const periods = manifestTargetPeriods(manifest);
    if (!targetPeriodMatches(input.targetReportingPeriods, periods)) throw fail('TARGET_REPORTING_PERIODS_LOCK_MISMATCH');
    const manifestMaterials = manifest.materials;
    if (!Array.isArray(manifestMaterials) || !manifestMaterials.every(isRecord)) throw fail('TARGET_INPUT_MANIFEST_INVALID');
    const sourceMaterials = manifestMaterials.filter(ref => ref.role === 'historical');
    if (sourceMaterials.length !== 1 || sourceMaterials[0]!.material_id !== input.source.materialId ||
        Number(sourceMaterials[0]!.material_version) !== input.source.materialVersion) throw fail('HISTORICAL_MATERIAL_SELECTION_MISMATCH');
    const manifestFinancial = manifestMaterials.filter(ref => FINANCIAL_ROLES.has(String(ref.role)))
      .map(ref => `${String(ref.material_id)}\0${Number(ref.material_version)}`).sort();
    const providedFinancial = input.financialMaterialVersions.map(ref => `${ref.materialId}\0${ref.materialVersion}`).sort();
    if (canonical(manifestFinancial) !== canonical(providedFinancial)) throw fail('FINANCIAL_MATERIAL_NOT_IN_INPUT_REVISION');
    if (!Array.isArray(refs) || !refs.some(ref => isRecord(ref) &&
      ref.material_id === input.source.materialId && Number(ref.material_version) === input.source.materialVersion) ||
      input.financialMaterialVersions.some(item => !refs.some(ref => isRecord(ref) &&
      ref.material_id === item.materialId && Number(ref.material_version) === item.materialVersion))) throw fail('FINANCIAL_MATERIAL_NOT_IN_INPUT_REVISION');
  }
  const evidenceTargetPeriods = targetPeriods.filter((period): period is ReportingPeriod => 'provenance' in period);
  const targetRefs = evidenceTargetPeriods.flatMap(period => period.provenance.evidence_refs);
  let allEvidenceBound = true;
  const sourceProvenance = [recognition.source_market.provenance, recognition.source_offering.provenance,
    recognition.latest_reporting_cutoff.provenance, ...recognition.reporting_periods.map(period => period.provenance)];
  if (sourceProvenance.some(provenance => provenance.material_id !== input.source.materialId ||
      provenance.material_version !== input.source.materialVersion)) allEvidenceBound = false;
  const sourceExtractor = recognition.source_market.provenance.extractor_version;
  const sourceIdentity = parseHistoricalNativeExtractorVersion(sourceExtractor);
  const sourceParserVersion = sourceIdentity?.parserVersion ?? null;
  if (sourceIdentity === null || [recognition.source_offering.provenance.extractor_version,
    recognition.latest_reporting_cutoff.provenance.extractor_version,
    ...recognition.reporting_periods.map(period => period.provenance.extractor_version)]
    .some(version => {
      const identity = parseHistoricalNativeExtractorVersion(version);
      return identity === null || identity.algorithmVersion !== sourceIdentity.algorithmVersion ||
        identity.parserVersion !== sourceIdentity.parserVersion;
    })) allEvidenceBound = false;
  const sourceRefs = [recognition.source_market.provenance.evidence_refs, recognition.source_offering.provenance.evidence_refs,
    recognition.latest_reporting_cutoff.provenance.evidence_refs, ...recognition.reporting_periods.map(period => period.provenance.evidence_refs)].flat();
  if (!sourceParserVersion || sourceRefs.length === 0) allEvidenceBound = false;
  for (const ref of new Set(sourceRefs)) {
    const result = await client.query(
      `SELECT 1 FROM bb_parse_snapshots s JOIN bb_parse_evidence e ON e.owner_user_id=s.owner_user_id AND e.project_id=s.project_id
        AND e.material_id=s.material_id AND e.material_version=s.material_version AND e.snapshot_id=s.id
       JOIN bb_material_versions m ON m.owner_user_id=s.owner_user_id AND m.project_id=s.project_id AND m.id=s.material_id
        AND m.version=s.material_version AND m.deleted_at IS NULL
       WHERE s.owner_user_id=$1 AND s.project_id=$2 AND s.material_id=$3 AND s.material_version=$4
        AND s.parser_version=$5 AND s.response_status='parsed' AND e.record_id=$6 AND e.extractor_version=s.parser_version LIMIT 2`,
      [input.ownerUserId, input.projectId, input.source.materialId, input.source.materialVersion, sourceParserVersion ?? '', ref]);
    if (result.rows.length !== 1) allEvidenceBound = false;
  }
  for (const period of evidenceTargetPeriods) {
    const key = `${period.provenance.material_id}\0${period.provenance.material_version}`;
    if (!financialKeys.has(key)) { allEvidenceBound = false; continue; }
    for (const ref of period.provenance.evidence_refs) {
      const result = await client.query(
        `SELECT 1 FROM bb_parse_snapshots s JOIN bb_parse_evidence e ON e.owner_user_id=s.owner_user_id AND e.project_id=s.project_id
          AND e.material_id=s.material_id AND e.material_version=s.material_version AND e.snapshot_id=s.id
         JOIN bb_material_versions m ON m.owner_user_id=s.owner_user_id AND m.project_id=s.project_id AND m.id=s.material_id
          AND m.version=s.material_version AND m.deleted_at IS NULL
         WHERE s.owner_user_id=$1 AND s.project_id=$2 AND s.material_id=$3 AND s.material_version=$4
          AND s.parser_version=$5 AND s.response_status='parsed' AND e.record_id=$6 AND e.extractor_version=s.parser_version LIMIT 2`,
        [input.ownerUserId, input.projectId, period.provenance.material_id, period.provenance.material_version,
          period.provenance.extractor_version ?? '', ref]);
      if (result.rows.length !== 1) allEvidenceBound = false;
    }
  }
  // Replacement/restatement evidence can cite either the exact historical source
  // material or one of the financial target versions. A reference must resolve
  // uniquely within those owner/project/version boundaries.
  const allowedEvidenceMaterials = [
    { material_id: input.source.materialId, material_version: input.source.materialVersion },
    ...input.financialMaterialVersions.map(item => ({ material_id: item.materialId, material_version: item.materialVersion })),
  ];
  for (const ref of [...input.replacements, ...input.restatements].flatMap(decision => decision.evidence)) {
    const result = await client.query(
      `SELECT 1 FROM bb_parse_evidence e JOIN bb_material_versions m ON m.owner_user_id=e.owner_user_id AND m.project_id=e.project_id
        AND m.id=e.material_id AND m.version=e.material_version AND m.deleted_at IS NULL
       JOIN bb_parse_snapshots s ON s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id AND s.material_id=e.material_id
        AND s.material_version=e.material_version AND s.id=e.snapshot_id AND s.parser_version=e.extractor_version AND s.response_status='parsed'
       JOIN jsonb_to_recordset($4::jsonb) AS f(material_id text,material_version integer)
        ON f.material_id=e.material_id AND f.material_version=e.material_version
       WHERE e.owner_user_id=$1 AND e.project_id=$2 AND e.record_id=$3 LIMIT 2`,
      [input.ownerUserId, input.projectId, ref, JSON.stringify(allowedEvidenceMaterials)]);
    if (result.rows.length !== 1) allEvidenceBound = false;
  }
  if (targetPeriods.length === 0 || targetRefs.length === 0 || evidenceTargetPeriods.length !== targetPeriods.length) allEvidenceBound = false;
  if (evidenceTargetPeriods.some(period => period.status !== 'recognized' || period.uncertainty.length > 0 || period.provenance.evidence_refs.length === 0) ||
      recognition.reporting_periods.some(period => period.status !== 'recognized' || period.uncertainty.length > 0 || period.provenance.evidence_refs.length === 0) ||
      [recognition.source_market, recognition.source_offering, recognition.latest_reporting_cutoff]
        .some(field => field.status !== 'recognized' || field.uncertainty.length > 0 || field.provenance.evidence_refs.length === 0)) allEvidenceBound = false;
  return allEvidenceBound;
}

/** Persists one immutable comparison in the caller's transaction. */
export async function createUpdateDifficultySnapshotWithClient(
  client: UpdateDifficultyClient,
  input: TrustedUpdateDifficultyInput,
  options: UpdateDifficultyClientOptions = {},
): Promise<StoredUpdateDifficultySnapshot> {
  safeContext(input);
  const normalizedMaterials = [...input.financialMaterialVersions].map(item => ({ materialId: item.materialId, materialVersion: item.materialVersion }))
    .sort((a, b) => a.materialId.localeCompare(b.materialId) || a.materialVersion - b.materialVersion);
  const requestPayload = { ...input, financialMaterialVersions: normalizedMaterials };
  const requestHash = sha256(requestPayload);
  try {
    const activeProject = await client.query(
      `SELECT id FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [input.ownerUserId, input.projectId]);
    if (activeProject.rows.length !== 1) throw fail('PROJECT_NOT_FOUND');
    const prior = await client.query(
      `SELECT ${QUALIFIED_RETURNING}
         FROM bb_update_difficulty_snapshots s
         JOIN bb_projects current_project ON current_project.owner_user_id=s.owner_user_id AND current_project.id=s.project_id
          AND current_project.deleted_at IS NULL
        WHERE s.owner_user_id=$1 AND s.project_id=$2 AND s.request_id=$3
        `,
      [input.ownerUserId, input.projectId, input.requestId]);
    if (prior.rows.length) {
      if (String(prior.rows[0]!.request_hash).trim() !== requestHash) throw fail('IDEMPOTENCY_CONFLICT');
      return mapRow(prior.rows[0]!, true);
    }
    const project = await client.query(
      `SELECT market, offering, draft_revision, latest_input_revision FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [input.ownerUserId, input.projectId]);
    if (project.rows.length !== 1) throw fail('PROJECT_NOT_FOUND');
    if (Number(project.rows[0]!.draft_revision) !== input.targetRevision) throw fail('TARGET_REVISION_STALE');
    if (input.inputRevision !== undefined && Number(project.rows[0]!.latest_input_revision) !== input.inputRevision) throw fail('TARGET_INPUT_REVISION_STALE');
    const { recognition, state } = await fetchProfile(client, input);
    const evidenceBound = await verifyEvidenceRefs(client, input, recognition, input.targetReportingPeriods);
    const sameTarget = await client.query(
      `SELECT id FROM bb_update_difficulty_snapshots WHERE owner_user_id=$1 AND project_id=$2
        AND source_material_id=$3 AND source_material_version=$4 AND source_profile_version=$5 AND target_revision=$6
        AND input_revision IS NOT DISTINCT FROM $7`,
      [input.ownerUserId, input.projectId, input.source.materialId, input.source.materialVersion, input.source.profileVersion, input.targetRevision, input.inputRevision ?? null]);
    if (sameTarget.rows.length) throw fail('TARGET_REVISION_ALREADY_SNAPSHOTTED');
    const sourceMarket: Market | null = recognition.source_market.status === 'recognized' ? recognition.source_market.value as Market | null : null;
    const sourceOffering: Offering | null = recognition.source_offering.status === 'recognized' ? recognition.source_offering.value as Offering | null : null;
    const estimate = estimateUpdateDifficulty({ profileVersion: input.source.profileVersion, targetRevision: input.targetRevision,
      source: { market: sourceMarket, offering: sourceOffering, reportingPeriods: recognition.reporting_periods },
      target: { market: project.rows[0]!.market as Market | null, offering: project.rows[0]!.offering as Offering | null,
        reportingPeriods: input.targetReportingPeriods }, replacements: input.replacements, restatements: input.restatements });
    const gatedEstimate = state === 'ready' && hasAnchoredRecognizedFields(recognition) && evidenceBound ? estimate : {
      ...estimate, status: 'needs_confirmation' as const, estimatedN: null,
      confirmationReasons: [...new Set([...estimate.confirmationReasons,
        state !== 'ready' || !hasAnchoredRecognizedFields(recognition) ? 'source_profile_needs_confirmation' : '',
        !evidenceBound ? 'period_evidence_missing_or_unverified' : '',
      ].filter(Boolean))].sort(),
    };
    // Recognition only records source fields/periods. Completeness of the historical
    // prospectus itself requires a separately reviewed assessment not yet modeled.
    const completeness: StoredUpdateDifficultySnapshot['oldProfileCompleteness'] = 'undetermined';
    const newId = options.newId ?? randomUUID;
    const id = newId();
    const inserted = await client.query(
      `INSERT INTO bb_update_difficulty_snapshots
       (id,owner_user_id,project_id,request_id,request_hash,source_material_id,source_material_version,source_profile_version,
        target_revision,source_market,source_offering,target_market,target_offering,input_revision,input_hash,financial_material_versions,comparison_input,old_profile_completeness,estimate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING ${RETURNING}`,
      [id, input.ownerUserId, input.projectId, input.requestId, requestHash, input.source.materialId, input.source.materialVersion,
        input.source.profileVersion, input.targetRevision,
        recognition.source_market.status === 'recognized' ? recognition.source_market.value : null,
        recognition.source_offering.status === 'recognized' ? recognition.source_offering.value : null,
        project.rows[0]!.market as Market | null, project.rows[0]!.offering as Offering | null, input.inputRevision ?? null, input.inputHash ?? null,
        JSON.stringify(normalizedMaterials), JSON.stringify({ targetReportingPeriods: input.targetReportingPeriods,
          replacements: input.replacements, restatements: input.restatements }), completeness, JSON.stringify(gatedEstimate)]);
    await client.query(
      `INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
       VALUES ($1,$2,'project',$3,'project.update_difficulty_snapshotted',$4)`,
      [newId(), input.ownerUserId, input.projectId,
        JSON.stringify({ snapshot_id: id, profile_version: input.source.profileVersion, target_revision: input.targetRevision,
          status: gatedEstimate.status })]);
    return mapRow(inserted.rows[0]!, false);
  } catch (error) {
    throw error instanceof Error && error.name === 'UpdateDifficultyRepositoryError' ? error : fail('UPDATE_DIFFICULTY_SNAPSHOT_FAILED');
  }
}

/** Pool-owning worker compatibility wrapper. API callers pass their transaction client to the core entry point. */
export async function createUpdateDifficultySnapshot(
  dependencies: UpdateDifficultyDependencies,
  input: TrustedUpdateDifficultyInput,
): Promise<StoredUpdateDifficultySnapshot> {
  const client = await dependencies.pool.connect();
  let open = false;
  try {
    await client.query('BEGIN'); open = true;
    const result = await createUpdateDifficultySnapshotWithClient(client, input, { newId: dependencies.newId });
    await client.query('COMMIT'); open = false;
    return result;
  } catch (error) {
    if (open) { try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ } }
    throw error;
  } finally { client.release?.(); }
}

/** Owner-scoped immutable by-id read for audit and pinned historical consumers. */
export async function getUpdateDifficultySnapshotWithClient(
  client: UpdateDifficultyClient,
  context: { ownerUserId: string; projectId: string; snapshotId: string },
): Promise<StoredUpdateDifficultySnapshot | null> {
  if (![context.ownerUserId, context.projectId, context.snapshotId].every(validId)) throw fail('INVALID_UPDATE_DIFFICULTY_CONTEXT');
  const result = await client.query(
    `SELECT ${QUALIFIED_RETURNING}
       FROM bb_update_difficulty_snapshots s
       JOIN bb_projects p ON p.owner_user_id=s.owner_user_id AND p.id=s.project_id AND p.deleted_at IS NULL
       JOIN bb_material_versions source ON source.owner_user_id=s.owner_user_id AND source.project_id=s.project_id
        AND source.id=s.source_material_id AND source.version=s.source_material_version AND source.role='historical' AND source.deleted_at IS NULL
       AND source.media_type IN ('application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/pdf')
       WHERE s.owner_user_id=$1 AND s.project_id=$2 AND s.id=$3
         AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(s.financial_material_versions) AS f("materialId" text,"materialVersion" integer)
           LEFT JOIN bb_material_versions m ON m.owner_user_id=s.owner_user_id AND m.project_id=s.project_id AND m.id=f."materialId" AND m.version=f."materialVersion"
           WHERE m.id IS NULL OR m.deleted_at IS NOT NULL)`,
    [context.ownerUserId, context.projectId, context.snapshotId]);
  if (!result.rows.length) return null;
  if (result.rows.length !== 1) throw fail('INVALID_UPDATE_DIFFICULTY_ROW');
  return mapRow(result.rows[0]!, false);
}

export async function getUpdateDifficultySnapshot(
  dependencies: UpdateDifficultyDependencies,
  context: { ownerUserId: string; projectId: string; snapshotId: string },
): Promise<StoredUpdateDifficultySnapshot | null> {
  return getUpdateDifficultySnapshotWithClient(dependencies.pool, context);
}

/** Owner-scoped lookup that returns a snapshot only while its lock, draft, and source profile are current. */
export async function getCurrentUpdateDifficultySnapshotWithClient(
  client: UpdateDifficultyClient,
  context: { ownerUserId: string; projectId: string; snapshotId: string },
): Promise<StoredUpdateDifficultySnapshot | null> {
  if (![context.ownerUserId, context.projectId, context.snapshotId].every(validId)) throw fail('INVALID_UPDATE_DIFFICULTY_CONTEXT');
  const result = await client.query(
    `SELECT ${QUALIFIED_RETURNING}
       FROM bb_update_difficulty_snapshots s
       JOIN bb_projects p ON p.owner_user_id=s.owner_user_id AND p.id=s.project_id AND p.deleted_at IS NULL
       JOIN bb_material_versions source ON source.owner_user_id=s.owner_user_id AND source.project_id=s.project_id
        AND source.id=s.source_material_id AND source.version=s.source_material_version AND source.role='historical' AND source.deleted_at IS NULL
        AND source.media_type IN ('application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/pdf')
       WHERE s.owner_user_id=$1 AND s.project_id=$2 AND s.id=$3 AND p.draft_revision=s.target_revision
         AND NOT EXISTS (SELECT 1 FROM bb_historical_profiles newer WHERE newer.owner_user_id=s.owner_user_id
           AND newer.project_id=s.project_id AND newer.material_id=s.source_material_id
           AND newer.material_version=s.source_material_version AND newer.profile_version>s.source_profile_version)
         AND ((s.input_revision IS NULL AND p.latest_input_revision IS NULL) OR
           (s.input_revision=p.latest_input_revision AND EXISTS (SELECT 1 FROM bb_input_revisions current_lock
             WHERE current_lock.owner_user_id=s.owner_user_id AND current_lock.project_id=s.project_id
               AND current_lock.revision=s.input_revision AND current_lock.input_hash=s.input_hash)))
         AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(s.financial_material_versions) AS f("materialId" text,"materialVersion" integer)
           LEFT JOIN bb_material_versions m ON m.owner_user_id=s.owner_user_id AND m.project_id=s.project_id AND m.id=f."materialId" AND m.version=f."materialVersion"
           WHERE m.id IS NULL OR m.deleted_at IS NOT NULL)`,
    [context.ownerUserId, context.projectId, context.snapshotId]);
  if (!result.rows.length) return null;
  if (result.rows.length !== 1) throw fail('INVALID_UPDATE_DIFFICULTY_ROW');
  return mapRow(result.rows[0]!, false);
}

export async function getCurrentUpdateDifficultySnapshot(
  dependencies: UpdateDifficultyDependencies,
  context: { ownerUserId: string; projectId: string; snapshotId: string },
): Promise<StoredUpdateDifficultySnapshot | null> {
  return getCurrentUpdateDifficultySnapshotWithClient(dependencies.pool, context);
}
