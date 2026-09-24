import { createHash, randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import { M1_MATERIAL_PARTITIONS, schemas, type Market, type Offering, type Recognition, type ReportingPeriod } from '@bondbuddy/contracts';
import { estimateUpdateDifficulty, type CutoffDecision, type UpdateDifficultyEstimate } from '@bondbuddy/domain/update-difficulty';
import { HISTORICAL_NATIVE_RECOGNITION_VERSION } from './historical-native-recognition.js';

export interface UpdateDifficultyClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}
export interface UpdateDifficultyPool {
  connect(): Promise<UpdateDifficultyClient>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface UpdateDifficultyDependencies {
  pool: UpdateDifficultyPool;
  newId?: () => string;
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
  readonly targetReportingPeriods: readonly ReportingPeriod[];
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
    readonly targetReportingPeriods: readonly ReportingPeriod[];
    readonly replacements: readonly CutoffDecision[];
    readonly restatements: readonly CutoffDecision[];
  };
  /** The profile does not currently carry a reviewed document-level completeness assessment. */
  readonly oldProfileCompleteness: 'complete' | 'incomplete' | 'undetermined';
  readonly estimate: UpdateDifficultyEstimate;
  readonly createdAt: string;
  readonly replayed: boolean;
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
      WHERE p.owner_user_id=$1 AND p.project_id=$2 AND p.material_id=$3 AND p.material_version=$4 AND p.profile_version=$5`,
    [input.ownerUserId, input.projectId, input.source.materialId, input.source.materialVersion, input.source.profileVersion]);
  if (result.rows.length !== 1) throw fail('HISTORICAL_PROFILE_NOT_FOUND');
  const recognition = activeRecognition(result.rows[0]!.recognition, input.source.materialId, input.source.materialVersion, input.source.profileVersion);
  const state = String(result.rows[0]!.profile_state);
  // Corrections remain user_asserted/needs_confirmation by repository policy. They
  // may be snapshotted but can never turn a preflight estimate into ready N.
  return { recognition, state };
}

async function verifyEvidenceRefs(client: UpdateDifficultyClient, input: TrustedUpdateDifficultyInput,
  recognition: Recognition, targetPeriods: readonly ReportingPeriod[]): Promise<boolean> {
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
      `SELECT input_hash, draft_revision, material_versions FROM bb_input_revisions
        WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3`,
      [input.ownerUserId, input.projectId, input.inputRevision]);
    if (locked.rows.length !== 1 || String(locked.rows[0]!.input_hash).trim() !== input.inputHash || Number(locked.rows[0]!.draft_revision) !== input.targetRevision) throw fail('TARGET_INPUT_REVISION_MISMATCH');
    const refs = parseJson(locked.rows[0]!.material_versions);
    if (!Array.isArray(refs) || !refs.some(ref => isRecord(ref) &&
      ref.material_id === input.source.materialId && Number(ref.material_version) === input.source.materialVersion) ||
      input.financialMaterialVersions.some(item => !refs.some(ref => isRecord(ref) &&
      ref.material_id === item.materialId && Number(ref.material_version) === item.materialVersion))) throw fail('FINANCIAL_MATERIAL_NOT_IN_INPUT_REVISION');
  }
  const targetRefs = targetPeriods.flatMap(period => period.provenance.evidence_refs);
  let allEvidenceBound = true;
  const sourceProvenance = [recognition.source_market.provenance, recognition.source_offering.provenance,
    recognition.latest_reporting_cutoff.provenance, ...recognition.reporting_periods.map(period => period.provenance)];
  if (sourceProvenance.some(provenance => provenance.material_id !== input.source.materialId ||
      provenance.material_version !== input.source.materialVersion)) allEvidenceBound = false;
  const parserPrefix = `${HISTORICAL_NATIVE_RECOGNITION_VERSION}/`;
  const sourceExtractor = recognition.source_market.provenance.extractor_version;
  const sourceParserVersion = typeof sourceExtractor === 'string' && sourceExtractor.startsWith(parserPrefix)
    ? sourceExtractor.slice(parserPrefix.length) : null;
  const expectedSourceExtractor = sourceParserVersion ? `${parserPrefix}${sourceParserVersion}` : null;
  if (!expectedSourceExtractor || [recognition.source_offering.provenance.extractor_version,
    recognition.latest_reporting_cutoff.provenance.extractor_version,
    ...recognition.reporting_periods.map(period => period.provenance.extractor_version)]
    .some(version => version !== expectedSourceExtractor)) allEvidenceBound = false;
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
  for (const period of targetPeriods) {
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
  if (targetPeriods.length === 0 || targetRefs.length === 0) allEvidenceBound = false;
  if (targetPeriods.some(period => period.status !== 'recognized' || period.uncertainty.length > 0 || period.provenance.evidence_refs.length === 0) ||
      recognition.reporting_periods.some(period => period.status !== 'recognized' || period.uncertainty.length > 0 || period.provenance.evidence_refs.length === 0) ||
      [recognition.source_market, recognition.source_offering, recognition.latest_reporting_cutoff]
        .some(field => field.status !== 'recognized' || field.uncertainty.length > 0 || field.provenance.evidence_refs.length === 0)) allEvidenceBound = false;
  return allEvidenceBound;
}

/** Persists one immutable comparison. Current project revision is locked to prevent stale target writes. */
export async function createUpdateDifficultySnapshot(
  dependencies: UpdateDifficultyDependencies,
  input: TrustedUpdateDifficultyInput,
): Promise<StoredUpdateDifficultySnapshot> {
  safeContext(input);
  const normalizedMaterials = [...input.financialMaterialVersions].map(item => ({ materialId: item.materialId, materialVersion: item.materialVersion }))
    .sort((a, b) => a.materialId.localeCompare(b.materialId) || a.materialVersion - b.materialVersion);
  const requestPayload = { ...input, financialMaterialVersions: normalizedMaterials };
  const requestHash = sha256(requestPayload);
  const client = await dependencies.pool.connect();
  let open = false;
  try {
    await client.query('BEGIN'); open = true;
    const activeProject = await client.query(
      `SELECT id FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [input.ownerUserId, input.projectId]);
    if (activeProject.rows.length !== 1) throw fail('PROJECT_NOT_FOUND');
    const prior = await client.query(
      `SELECT ${QUALIFIED_RETURNING}
         FROM bb_update_difficulty_snapshots s
         JOIN bb_historical_profiles hp ON hp.owner_user_id=s.owner_user_id AND hp.project_id=s.project_id
          AND hp.material_id=s.source_material_id AND hp.material_version=s.source_material_version AND hp.profile_version=s.source_profile_version
         JOIN bb_material_versions source ON source.owner_user_id=s.owner_user_id AND source.project_id=s.project_id
          AND source.id=s.source_material_id AND source.version=s.source_material_version AND source.role='historical' AND source.deleted_at IS NULL
          AND source.media_type IN ('application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/pdf')
        WHERE s.owner_user_id=$1 AND s.project_id=$2 AND s.request_id=$3
          AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(s.financial_material_versions) AS f("materialId" text,"materialVersion" integer)
            LEFT JOIN bb_material_versions m ON m.owner_user_id=s.owner_user_id AND m.project_id=s.project_id AND m.id=f."materialId" AND m.version=f."materialVersion"
            WHERE m.id IS NULL OR m.deleted_at IS NOT NULL)`,
      [input.ownerUserId, input.projectId, input.requestId]);
    if (prior.rows.length) {
      if (String(prior.rows[0]!.request_hash).trim() !== requestHash) throw fail('IDEMPOTENCY_CONFLICT');
      await client.query('COMMIT'); open = false;
      return mapRow(prior.rows[0]!, true);
    }
    const project = await client.query(
      `SELECT market, offering, draft_revision FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [input.ownerUserId, input.projectId]);
    if (project.rows.length !== 1) throw fail('PROJECT_NOT_FOUND');
    if (Number(project.rows[0]!.draft_revision) !== input.targetRevision) throw fail('TARGET_REVISION_STALE');
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
    const id = (dependencies.newId ?? randomUUID)();
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
      [(dependencies.newId ?? randomUUID)(), input.ownerUserId, input.projectId,
        JSON.stringify({ snapshot_id: id, profile_version: input.source.profileVersion, target_revision: input.targetRevision,
          status: gatedEstimate.status })]);
    await client.query('COMMIT'); open = false;
    return mapRow(inserted.rows[0]!, false);
  } catch (error) {
    if (open) { try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ } }
    throw error instanceof Error && error.name === 'UpdateDifficultyRepositoryError' ? error : fail('UPDATE_DIFFICULTY_SNAPSHOT_FAILED');
  } finally { client.release(); }
}

/** Owner-scoped read hides deleted projects and any deleted pinned materials. */
export async function getUpdateDifficultySnapshot(
  dependencies: UpdateDifficultyDependencies,
  context: { ownerUserId: string; projectId: string; snapshotId: string },
): Promise<StoredUpdateDifficultySnapshot | null> {
  if (![context.ownerUserId, context.projectId, context.snapshotId].every(validId)) throw fail('INVALID_UPDATE_DIFFICULTY_CONTEXT');
  const result = await dependencies.pool.query(
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
