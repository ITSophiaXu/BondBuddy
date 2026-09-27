import { createHash, randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import { M1_MATERIAL_PARTITIONS, emptyUpdateDetails, isMarketOffering, MARKETS, OFFERINGS, schemas, updateDetailsErrors, type Market, type Offering, type Recognition, type ReportingPeriod } from '@bondbuddy/contracts';
import { estimateUpdateDifficulty, type CutoffDecision, type TargetReportingPeriod, type UpdateDifficultyEstimate, type UserAssertedTargetPeriod } from '@bondbuddy/domain/update-difficulty';
import { parseHistoricalNativeExtractorVersion } from '@bondbuddy/domain/historical-native-extractor-version';
import { canonicalTargetPeriods, type TargetConfirmation } from './target-confirmation.js';
import { readOcrPeriodEvidence } from './ocr.js';
import type { PrivateBlobs } from './data.js';

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
  readonly blobs?: PrivateBlobs;
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
  /** Explicit user intent from the exact locked revision; never financial evidence. */
  readonly targetConfirmation?: TargetConfirmation;
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
    readonly targetConfirmation?: TargetConfirmation;
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
async function difficultyEvidenceIdentity(client: UpdateDifficultyClient, input: TrustedUpdateDifficultyInput): Promise<string | null> {
  if(input.inputRevision===undefined)return null;
  const rows=await client.query(`SELECT d.id,d.request_id,d.request_hash,d.source_profile_material_id,d.source_profile_material_version,
      d.source_profile_version,d.source_profile_sha256,d.locked_materials,d.periods,d.reviewer_user_id,d.reviewer_grant_id,
      d.authority,d.reviewed_at,g.revoked_at,g.revoked_by,g.revocation_reason,u.status AS reviewer_status,
      w.id AS withdrawal_id,w.request_hash AS withdrawal_request_hash,w.reason AS withdrawal_reason,w.withdrawn_at
    FROM bb_target_period_evidence_decisions d
    LEFT JOIN bb_target_period_reviewer_grants g ON g.id=d.reviewer_grant_id
    LEFT JOIN bb_users u ON u.id=d.reviewer_user_id
    LEFT JOIN bb_target_period_evidence_decision_withdrawals w ON w.decision_id=d.id
    WHERE d.owner_user_id=$1 AND d.project_id=$2 AND d.input_revision=$3 AND d.input_hash=$4
    ORDER BY d.reviewed_at,d.id`,[input.ownerUserId,input.projectId,input.inputRevision,input.inputHash]);
  const decisions=rows.rows.map(row=>({
    id:String(row.id),requestId:String(row.request_id),requestHash:String(row.request_hash).trim(),
    sourceProfile:{materialId:String(row.source_profile_material_id),materialVersion:Number(row.source_profile_material_version),
      profileVersion:Number(row.source_profile_version),sha256:String(row.source_profile_sha256).trim()},
    lockedMaterials:parseJson(row.locked_materials),periods:parseJson(row.periods),reviewerUserId:String(row.reviewer_user_id),
    reviewerGrantId:String(row.reviewer_grant_id),authority:String(row.authority),reviewedAt:new Date(String(row.reviewed_at)).toISOString(),
    grantRevokedAt:row.revoked_at===null?null:new Date(String(row.revoked_at)).toISOString(),grantRevokedBy:row.revoked_by??null,
    grantRevocationReason:row.revocation_reason??null,reviewerStatus:row.reviewer_status??null,
    withdrawal:row.withdrawal_id===null?null:{id:String(row.withdrawal_id),requestHash:String(row.withdrawal_request_hash).trim(),
      reason:String(row.withdrawal_reason),withdrawnAt:new Date(String(row.withdrawn_at)).toISOString()},
  }));
  const financialMaterialVersions=[...input.financialMaterialVersions].map(item=>({materialId:item.materialId,materialVersion:item.materialVersion}))
    .sort((a,b)=>a.materialId.localeCompare(b.materialId)||a.materialVersion-b.materialVersion);
  return sha256({version:1,ownerUserId:input.ownerUserId,projectId:input.projectId,inputRevision:input.inputRevision,inputHash:input.inputHash,
    targetRevision:input.targetRevision,source:input.source,financialMaterialVersions,targetReportingPeriods:input.targetReportingPeriods,
    targetConfirmation:input.targetConfirmation??null,replacements:input.replacements,restatements:input.restatements,decisions});
}
function validateLockedManifestDigest(manifest: Record<string, unknown>, inputHash: string): void {
  const schema = manifest.manifest_schema;
  if (schema === undefined) return; // Legacy locks predate canonical manifest hashes.
  if (schema !== 'production_rule_pin_v1' || sha256(manifest) !== inputHash) {
    throw fail('TARGET_INPUT_MANIFEST_INVALID');
  }
}

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
    TARGET_PERIOD_DECISION_ASSEMBLY_MISMATCH: 'data_integrity',
    TARGET_CONFIRMATION_REQUIRED: 'pending_input',
    TARGET_CONFIRMATION_INVALID: 'data_integrity',
  };
  return { category: categories[code] ?? 'internal', code };
}

function stableSnapshotRequestId(input: TrustedUpdateDifficultyInput, evidenceIdentity?: string): string {
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
    targetConfirmation: input.targetConfirmation ?? null,
    replacements: input.replacements,
    restatements: input.restatements,
    ...(evidenceIdentity === undefined ? {} : { evidenceIdentity }),
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
      !Array.isArray(comparisonInput.restatements) || !isRecord(estimate) || !validateEstimate(estimate) ||
      (comparisonInput.targetConfirmation !== undefined && !isRecord(comparisonInput.targetConfirmation))) throw fail('INVALID_UPDATE_DIFFICULTY_ROW');
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

function normalizedTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
function isMarket(value: unknown): value is Market { return typeof value === 'string' && MARKETS.some(market => market === value); }
function isOffering(value: unknown): value is Offering { return typeof value === 'string' && OFFERINGS.some(offering => offering === value); }

function sameTargetConfirmation(manifest: Record<string, unknown>, persisted: TargetConfirmation | null,
  periods: readonly TargetReportingPeriod[], project: Record<string, unknown>): TargetConfirmation {
  const asserted = manifest.target_confirmation;
  if (!isRecord(asserted) || asserted.status !== 'confirmed') {
    if (isRecord(asserted) && asserted.status === 'unconfirmed') throw fail('TARGET_CONFIRMATION_REQUIRED');
    throw fail('TARGET_CONFIRMATION_INVALID');
  }
  if (persisted === null) throw fail('TARGET_CONFIRMATION_INVALID');
  const assertedAt = normalizedTimestamp(asserted.confirmed_at);
  const persistedAt = normalizedTimestamp(persisted.confirmed_at);
  const purpose = asserted.document_purpose;
  const asOf = asserted.as_of;
  const validAsOf = asOf === null || (typeof asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asOf) &&
    !Number.isNaN(Date.parse(`${asOf}T00:00:00.000Z`)) && new Date(`${asOf}T00:00:00.000Z`).toISOString().slice(0, 10) === asOf);
  const normalizedPeriodSet = (value: unknown): unknown => {
    if (!Array.isArray(value)) throw fail('TARGET_CONFIRMATION_INVALID');
    try {
      const validated = value.map(targetPeriodFromManifest).map(period => ({ ...period, evidence_refs: [] as string[] }));
      return canonicalTargetPeriods(validated);
    } catch { throw fail('TARGET_CONFIRMATION_INVALID'); }
  };
  const normalizedAssertedPeriods = normalizedPeriodSet(asserted.target_reporting_periods);
  const normalizedPersistedPeriods = normalizedPeriodSet(persisted.target_reporting_periods);
  const normalizedManifestPeriods = normalizedPeriodSet(periods);
  if (!isMarket(asserted.market) || !isOffering(asserted.offering) || !isMarketOffering(asserted.market, asserted.offering) ||
      asserted.market !== project.market || asserted.offering !== project.offering ||
      asserted.market !== manifest.market || asserted.offering !== manifest.offering ||
      (purpose !== null && purpose !== 'registration' && purpose !== 'issuance') || !validAsOf ||
      typeof asserted.confirmed_by !== 'string' || asserted.confirmed_by.length === 0 || assertedAt === null ||
      persisted.market !== asserted.market || persisted.offering !== asserted.offering ||
      persisted.document_purpose !== purpose || persisted.as_of !== asOf ||
      persisted.confirmed_by !== asserted.confirmed_by || persistedAt === null || persistedAt !== assertedAt ||
      canonical(normalizedAssertedPeriods) !== canonical(normalizedPersistedPeriods) ||
      canonical(normalizedAssertedPeriods) !== canonical(normalizedManifestPeriods)) {
    throw fail('TARGET_CONFIRMATION_INVALID');
  }
  return persisted;
}

function targetPeriodMatches(left: readonly TargetReportingPeriod[], right: readonly TargetReportingPeriod[]): boolean {
  const periodKey = (period: TargetReportingPeriod): unknown => ({ start: period.start, end: period.end,
    period_kind: period.period_kind, scope: period.scope });
  const sort = (periods: readonly TargetReportingPeriod[]) => periods.map(periodKey)
    .sort((a,b)=>canonical(a).localeCompare(canonical(b)));
  return canonical(sort(left)) === canonical(sort(right)) && left.every(period =>
    ('provenance' in period
      ? period.status === 'recognized' && period.provenance.evidence_refs.length > 0
      : period.status === 'user_asserted' || period.status === 'needs_confirmation'));
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only a live, exact-scope reviewer decision can turn locked target intent into period evidence. */
async function reviewedTargetPeriods(client: UpdateDifficultyClient, input: {
  ownerUserId:string;projectId:string;inputRevision:number;inputHash:string;
  source:{materialId:string;materialVersion:number;profileVersion:number};
  targetReportingPeriods:readonly UserAssertedTargetPeriod[];
  lockedMaterials:readonly {material_id:string;material_version:number;role:string;sha256:string}[];
  blobs?:PrivateBlobs;
}): Promise<TargetReportingPeriod[]> {
  const result=await client.query(`SELECT d.*,g.id AS active_grant_id,w.id AS withdrawal_id,p.recognition AS source_recognition
    FROM bb_target_period_evidence_decisions d
    LEFT JOIN bb_target_period_reviewer_grants g ON g.id=d.reviewer_grant_id AND g.user_id=d.reviewer_user_id
      AND g.scope_owner_user_id=d.owner_user_id AND g.scope_project_id=d.project_id AND g.revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM bb_users reviewer WHERE reviewer.id=g.user_id AND reviewer.status='active')
    LEFT JOIN bb_target_period_evidence_decision_withdrawals w ON w.decision_id=d.id
    LEFT JOIN bb_historical_profiles p ON p.owner_user_id=d.owner_user_id AND p.project_id=d.project_id
      AND p.material_id=d.source_profile_material_id AND p.material_version=d.source_profile_material_version
      AND p.profile_version=d.source_profile_version
    WHERE d.owner_user_id=$1 AND d.project_id=$2 AND d.input_revision=$3 AND d.input_hash=$4
    ORDER BY d.reviewed_at DESC,d.id DESC LIMIT 1`,
    [input.ownerUserId,input.projectId,input.inputRevision,input.inputHash]);
  const row=result.rows[0];
  if(!row||!row.active_grant_id||row.withdrawal_id||Number(row.source_profile_version)!==input.source.profileVersion||
     String(row.source_profile_material_id)!==input.source.materialId||Number(row.source_profile_material_version)!==input.source.materialVersion||
     !row.source_recognition||sha256(parseJson(row.source_recognition))!==String(row.source_profile_sha256).trim())return [...input.targetReportingPeriods];
  const locked=parsedJsonArray(row.locked_materials);
  const expected=input.lockedMaterials.map(m=>({material_id:m.material_id,material_version:m.material_version,material_sha256:m.sha256.trim().toLowerCase()}))
    .sort((a,b)=>a.material_id.localeCompare(b.material_id)||a.material_version-b.material_version);
  if(!locked||canonical(locked)!==canonical(expected))return [...input.targetReportingPeriods];
  const decisions=parsedJsonArray(row.periods);
  if(!decisions)return [...input.targetReportingPeriods];
  const byKey=new Map(decisions.filter(recordValue).map(period=>[
    canonical({start:period.start??null,end:period.end??null,period_kind:period.period_kind??null,scope:period.scope??null}),period]));
  const output:TargetReportingPeriod[]=[];
  for(const target of input.targetReportingPeriods){
    const decision=byKey.get(canonical({start:target.start,end:target.end,period_kind:target.period_kind,scope:target.scope}));
    if(!recordValue(decision)||decision.outcome!=='confirmed'||!Array.isArray(decision.evidence)){output.push(target);continue;}
    const refs=decision.evidence.filter(recordValue);
    if(!refs.length||refs.some(ref=>typeof ref.material_id!=='string'||!Number.isSafeInteger(ref.material_version)||
      typeof ref.material_sha256!=='string'||typeof ref.parse_snapshot_id!=='string'||typeof ref.parser_version!=='string'||
      typeof ref.response_sha256!=='string'||typeof ref.record_id!=='string'||typeof ref.record_sha256!=='string')){output.push(target);continue;}
    const identities=new Set(refs.map(ref=>`${ref.evidence_method}\0${ref.material_id}\0${ref.material_version}\0${ref.parse_snapshot_id}\0${ref.parser_version}\0${ref.response_sha256}`));
    const roles=new Set(input.lockedMaterials.filter(m=>FINANCIAL_ROLES.has(m.role)).map(m=>`${m.material_id}\0${m.material_version}\0${m.sha256.trim().toLowerCase()}`));
    if(identities.size!==1||refs.some(ref=>!roles.has(`${ref.material_id}\0${ref.material_version}\0${String(ref.material_sha256).toLowerCase()}`))){output.push(target);continue;}
    const first=refs[0]!;
    const anchorKinds=new Set(refs.map(ref=>String(ref.anchor_kind)));
    if(['table_header','entity','scope','period_end'].some(kind=>!anchorKinds.has(kind))){output.push(target);continue;}
    let valid=true;
    for(const ref of refs){
      if(ref.evidence_method==='ocr'){
        if(!input.blobs||!Number.isSafeInteger(ref.page)||typeof ref.page_image_sha256!=='string'||!/[a-f0-9]{64}/.test(ref.page_image_sha256)||!Array.isArray(ref.ocr_uncertainty)) {valid=false;break;}
        try{
          const verified=await readOcrPeriodEvidence(client as any,input.blobs,{owner:input.ownerUserId,projectId:input.projectId,materialId:String(ref.material_id),
            version:Number(ref.material_version),snapshotId:String(ref.parse_snapshot_id),resultSha256:String(ref.response_sha256),recordId:String(ref.record_id),
            page:Number(ref.page),pageImageSha256:String(ref.page_image_sha256)});
          if(verified.processorVersion!==ref.parser_version||verified.recordSha256!==ref.record_sha256||verified.materialSha256!==ref.material_sha256||
             canonical(verified.uncertainty)!==canonical(ref.ocr_uncertainty)){valid=false;break;}
        }catch{valid=false;break;}
        const evidence=await client.query(`SELECT 1 FROM bb_ocr_snapshots s
          JOIN bb_material_versions m ON m.owner_user_id=s.owner_user_id AND m.project_id=s.project_id
            AND m.id=s.material_id AND m.version=s.material_version AND m.deleted_at IS NULL
          JOIN bb_target_period_reviewer_grants g ON g.id=$8 AND g.user_id=$9 AND g.scope_owner_user_id=$1
            AND g.scope_project_id=$2 AND g.revoked_at IS NULL
          WHERE s.owner_user_id=$1 AND s.project_id=$2 AND s.material_id=$3 AND s.material_version=$4
            AND trim(m.sha256)=$5 AND s.id=$6 AND trim(s.result_hash)=$7
            AND s.id=(SELECT s2.id FROM bb_ocr_snapshots s2 WHERE s2.owner_user_id=s.owner_user_id AND s2.project_id=s.project_id
              AND s2.material_id=s.material_id AND s2.material_version=s.material_version ORDER BY s2.created_at DESC,s2.id DESC LIMIT 1)` ,
          [input.ownerUserId,input.projectId,ref.material_id,ref.material_version,ref.material_sha256,ref.parse_snapshot_id,
            ref.response_sha256,String(row.reviewer_grant_id),String(row.reviewer_user_id)]);
        if(evidence.rows.length!==1){valid=false;break;}
        continue;
      }
      const evidence=await client.query(`SELECT e.uncertainty FROM bb_parse_snapshots s JOIN bb_parse_evidence e
        ON e.owner_user_id=s.owner_user_id AND e.project_id=s.project_id AND e.material_id=s.material_id
          AND e.material_version=s.material_version AND e.snapshot_id=s.id
        JOIN bb_material_versions m ON m.owner_user_id=s.owner_user_id AND m.project_id=s.project_id
          AND m.id=s.material_id AND m.version=s.material_version AND m.deleted_at IS NULL
        JOIN bb_target_period_reviewer_grants g ON g.id=$11 AND g.user_id=$12 AND g.scope_owner_user_id=$1
          AND g.scope_project_id=$2 AND g.revoked_at IS NULL
        WHERE s.owner_user_id=$1 AND s.project_id=$2 AND s.material_id=$3 AND s.material_version=$4 AND trim(m.sha256)=$5
          AND s.id=$6 AND s.parser_version=$7 AND trim(s.response_sha256)=$8 AND s.response_status IN ('parsed','needs_confirmation')
        AND e.record_id=$9 AND trim(e.record_sha256)=$10 AND e.extractor_version=s.parser_version AND e.extraction_method=$13
          AND s.id=(SELECT s2.id FROM bb_parse_snapshots s2 WHERE s2.owner_user_id=s.owner_user_id AND s2.project_id=s.project_id
            AND s2.material_id=s.material_id AND s2.material_version=s.material_version ORDER BY s2.created_at DESC,s2.id DESC LIMIT 1)`,
        [input.ownerUserId,input.projectId,ref.material_id,ref.material_version,ref.material_sha256,ref.parse_snapshot_id,
         ref.parser_version,ref.response_sha256,ref.record_id,ref.record_sha256,String(row.reviewer_grant_id),String(row.reviewer_user_id),ref.evidence_method]);
      if(evidence.rows.length!==1){valid=false;break;}
      const uncertainty=evidence.rows[0]!.uncertainty;
      if(!Array.isArray(uncertainty)||uncertainty.length!==0){valid=false;break;}
    }
    if(!valid){output.push(target);continue;}
    output.push({start:target.start,end:target.end,period_kind:target.period_kind,scope:target.scope,
      raw_value:typeof decision.reason==='string'?decision.reason:null,
      provenance:{material_id:String(first.material_id),material_version:Number(first.material_version),method:first.evidence_method as 'native_text'|'ocr',
        extractor_version:String(first.parser_version),evidence_refs:refs.map(ref=>String(ref.record_id))},
      // A confirmed OCR identity can retain unrelated amount/formula warnings in
      // the immutable decision refs without treating them as period uncertainty.
      uncertainty:[],status:'recognized'});
  }
  const targetKeys=input.targetReportingPeriods.map(p=>canonical({start:p.start,end:p.end,period_kind:p.period_kind,scope:p.scope}));
  if(byKey.size!==input.targetReportingPeriods.length||targetKeys.some(key=>!byKey.has(key)))
    return [...input.targetReportingPeriods];
  return output;
}

function parsedJsonArray(value: unknown): unknown[] | null {
  const parsed=parseJson(value);return Array.isArray(parsed)?parsed:null;
}

/**
 * Assembles the trusted #76 input from the immutable lock. Callers provide only
 * the owner/project/lock identity and request key; materials, source profile,
 * and target periods are derived from owner-scoped database rows.
 */
export async function loadLockedUpdateDifficultyInputWithClient(
  client: UpdateDifficultyClient,
  request: LockedUpdateDifficultyRequest,
  options: UpdateDifficultyClientOptions = {},
): Promise<TrustedUpdateDifficultyInput> {
  if (![request.ownerUserId, request.projectId, request.requestId].every(validId) ||
      !Number.isSafeInteger(request.inputRevision) || request.inputRevision < 1 || !/^[a-f0-9]{64}$/.test(request.inputHash)) {
    throw fail('INVALID_UPDATE_DIFFICULTY_CONTEXT');
  }
  const project = await client.query(`SELECT draft_revision,latest_input_revision,market,offering FROM bb_projects
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
    validateLockedManifestDigest(manifest, String(lock.rows[0]!.input_hash).trim());
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
    const assertedTargetPeriods = manifestTargetPeriods(manifest);
    const confirmationRows = await client.query(`SELECT market,offering,document_purpose,as_of::text AS as_of,target_reporting_periods,confirmed_by,confirmed_at
      FROM bb_input_revision_target_confirmations WHERE owner_user_id=$1 AND project_id=$2 AND input_revision=$3`,
    [request.ownerUserId, request.projectId, request.inputRevision]);
    const confirmationRow = confirmationRows.rows.length === 1 ? confirmationRows.rows[0]! : null;
    const persistedConfirmation: TargetConfirmation | null = confirmationRow === null ? null : {
      status: 'confirmed', market: confirmationRow.market as TargetConfirmation['market'], offering: confirmationRow.offering as TargetConfirmation['offering'],
      document_purpose: confirmationRow.document_purpose as TargetConfirmation['document_purpose'],
      as_of: confirmationRow.as_of === null ? null : String(confirmationRow.as_of),
      target_reporting_periods: parseJson(confirmationRow.target_reporting_periods) as TargetConfirmation['target_reporting_periods'],
      confirmed_by: String(confirmationRow.confirmed_by),
      confirmed_at: confirmationRow.confirmed_at instanceof Date ? confirmationRow.confirmed_at.toISOString() : String(confirmationRow.confirmed_at),
    };
    const targetConfirmation = sameTargetConfirmation(manifest, persistedConfirmation, assertedTargetPeriods, project.rows[0]!);
    const source = { materialId: String(sourceMaterial.material_id), materialVersion: Number(sourceMaterial.material_version),
      profileVersion: Number(profile.rows[0]!.profile_version) };
    const targetReportingPeriods = await reviewedTargetPeriods(client, { ownerUserId:request.ownerUserId,projectId:request.projectId,
      inputRevision:request.inputRevision,inputHash:request.inputHash,source,targetReportingPeriods:assertedTargetPeriods,
      lockedMaterials:manifestMaterials.map(item=>({material_id:String(item.material_id),material_version:Number(item.material_version),
        role:String(item.role),sha256:String(item.sha256)})),blobs:options.blobs });
    const financialMaterialVersions = finance.map(item => ({ materialId: String(item.material_id), materialVersion: Number(item.material_version) }));
  return { ownerUserId: request.ownerUserId, projectId: request.projectId, source,
      targetRevision: Number(project.rows[0]!.draft_revision), inputRevision: request.inputRevision, inputHash: request.inputHash,
      financialMaterialVersions, targetReportingPeriods, targetConfirmation,
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
  const loaded = await loadLockedUpdateDifficultyInputWithClient(client, { ...request, requestId: loaderRequestId },options);
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
  'input_hash', 'evidence_identity', 'financial_material_versions', 'comparison_input', 'old_profile_completeness', 'estimate', 'created_at'] as const;
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
  recognition: Recognition, targetPeriods: readonly TargetReportingPeriod[],
  reviewedTargets: readonly TargetReportingPeriod[] = []): Promise<boolean> {
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
    validateLockedManifestDigest(manifest, String(locked.rows[0]!.input_hash).trim());
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
    const trustedReviewedTarget=reviewedTargets.some(candidate=>'provenance' in candidate&&canonical(candidate)===canonical(period));
    if(period.provenance.method==='ocr'){
      if(!trustedReviewedTarget)allEvidenceBound=false;
      continue;
    }
    for (const ref of period.provenance.evidence_refs) {
      const result = await client.query(
        `SELECT 1 FROM bb_parse_snapshots s JOIN bb_parse_evidence e ON e.owner_user_id=s.owner_user_id AND e.project_id=s.project_id
          AND e.material_id=s.material_id AND e.material_version=s.material_version AND e.snapshot_id=s.id
         JOIN bb_material_versions m ON m.owner_user_id=s.owner_user_id AND m.project_id=s.project_id AND m.id=s.material_id
          AND m.version=s.material_version AND m.deleted_at IS NULL
         WHERE s.owner_user_id=$1 AND s.project_id=$2 AND s.material_id=$3 AND s.material_version=$4
          AND s.parser_version=$5 AND s.response_status = ANY($7::text[]) AND e.record_id=$6 AND e.extractor_version=s.parser_version LIMIT 2`,
        [input.ownerUserId, input.projectId, period.provenance.material_id, period.provenance.material_version,
          period.provenance.extractor_version ?? '', ref, trustedReviewedTarget?['parsed','needs_confirmation']:['parsed']]);
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
  let reviewedTargets: readonly TargetReportingPeriod[] = [];
  let evidenceIdentity:string|null=null;
  let requestHash='';
  let normalizedMaterials:{materialId:string;materialVersion:number}[]=[];
  try {
    const activeProject = await client.query(
      `SELECT id FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [input.ownerUserId, input.projectId]);
    if (activeProject.rows.length !== 1) throw fail('PROJECT_NOT_FOUND');
    if(input.inputRevision!==undefined){
      const assembled=await loadLockedUpdateDifficultyInputWithClient(client,{ownerUserId:input.ownerUserId,projectId:input.projectId,
        inputRevision:input.inputRevision,inputHash:input.inputHash!,requestId:`difficulty-review-${sha256({owner:input.ownerUserId,project:input.projectId,
          revision:input.inputRevision,inputHash:input.inputHash}).slice(0,48)}`},{blobs:options.blobs});
      const sortMaterials=(items:readonly {materialId:string;materialVersion:number}[])=>[...items]
        .sort((a,b)=>a.materialId.localeCompare(b.materialId)||a.materialVersion-b.materialVersion);
      if(assembled.targetRevision!==input.targetRevision||assembled.source.materialId!==input.source.materialId||
         assembled.source.materialVersion!==input.source.materialVersion||assembled.source.profileVersion!==input.source.profileVersion||
         canonical(sortMaterials(assembled.financialMaterialVersions))!==canonical(sortMaterials(input.financialMaterialVersions))||
         canonical(assembled.targetReportingPeriods)!==canonical(input.targetReportingPeriods)||
         canonical(assembled.targetConfirmation)!==canonical(input.targetConfirmation))throw fail('TARGET_PERIOD_DECISION_ASSEMBLY_MISMATCH');
      reviewedTargets=assembled.targetReportingPeriods;
      evidenceIdentity=await difficultyEvidenceIdentity(client,assembled);
      input={...input,requestId:stableSnapshotRequestId(assembled,evidenceIdentity??undefined)};
    }
    normalizedMaterials = [...input.financialMaterialVersions].map(item => ({ materialId: item.materialId, materialVersion: item.materialVersion }))
      .sort((a, b) => a.materialId.localeCompare(b.materialId) || a.materialVersion - b.materialVersion);
    requestHash = sha256({ ...input, financialMaterialVersions: normalizedMaterials,
      ...(evidenceIdentity===null?{}:{evidenceIdentity}) });
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
    const evidenceBound = await verifyEvidenceRefs(client, input, recognition, input.targetReportingPeriods,reviewedTargets);
    const sameTarget = await client.query(
      `SELECT id FROM bb_update_difficulty_snapshots WHERE owner_user_id=$1 AND project_id=$2
        AND source_material_id=$3 AND source_material_version=$4 AND source_profile_version=$5 AND target_revision=$6
        AND input_revision IS NOT DISTINCT FROM $7 AND evidence_identity IS NOT DISTINCT FROM $8`,
      [input.ownerUserId, input.projectId, input.source.materialId, input.source.materialVersion, input.source.profileVersion,
        input.targetRevision, input.inputRevision ?? null,evidenceIdentity]);
    if (sameTarget.rows.length) throw fail('TARGET_REVISION_ALREADY_SNAPSHOTTED');
    const sourceMarket: Market | null = recognition.source_market.status === 'recognized' ? recognition.source_market.value as Market | null : null;
    const sourceOffering: Offering | null = recognition.source_offering.status === 'recognized' ? recognition.source_offering.value as Offering | null : null;
    const estimate = estimateUpdateDifficulty({ profileVersion: input.source.profileVersion, targetRevision: input.targetRevision,
      source: { market: sourceMarket, offering: sourceOffering, reportingPeriods: recognition.reporting_periods },
      target: { market: project.rows[0]!.market as Market | null, offering: project.rows[0]!.offering as Offering | null,
        reportingPeriods: input.targetReportingPeriods }, replacements: input.replacements, restatements: input.restatements });
    const targetIntentConfirmed = input.inputRevision === undefined || input.targetConfirmation?.status === 'confirmed';
    const gatedEstimate = state === 'ready' && hasAnchoredRecognizedFields(recognition) && evidenceBound && targetIntentConfirmed ? estimate : {
      ...estimate, status: 'needs_confirmation' as const, estimatedN: null,
      confirmationReasons: [...new Set([...estimate.confirmationReasons,
        state !== 'ready' || !hasAnchoredRecognizedFields(recognition) ? 'source_profile_needs_confirmation' : '',
        !evidenceBound ? 'period_evidence_missing_or_unverified' : '',
        !targetIntentConfirmed ? 'target_intent_needs_confirmation' : '',
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
        target_revision,source_market,source_offering,target_market,target_offering,input_revision,input_hash,evidence_identity,
        financial_material_versions,comparison_input,old_profile_completeness,estimate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING ${RETURNING}`,
      [id, input.ownerUserId, input.projectId, input.requestId, requestHash, input.source.materialId, input.source.materialVersion,
        input.source.profileVersion, input.targetRevision,
        recognition.source_market.status === 'recognized' ? recognition.source_market.value : null,
        recognition.source_offering.status === 'recognized' ? recognition.source_offering.value : null,
        project.rows[0]!.market as Market | null, project.rows[0]!.offering as Offering | null, input.inputRevision ?? null, input.inputHash ?? null,evidenceIdentity,
        JSON.stringify(normalizedMaterials), JSON.stringify({ targetReportingPeriods: input.targetReportingPeriods,
          ...(input.targetConfirmation ? { targetConfirmation: input.targetConfirmation } : {}),
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
  options: UpdateDifficultyClientOptions = {},
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
  const row=result.rows[0]!;
  if(row.evidence_identity!==null&&row.evidence_identity!==undefined&&row.input_revision!==null&&row.input_hash!==null){
    try{
      const assembled=await loadLockedUpdateDifficultyInputWithClient(client,{ownerUserId:context.ownerUserId,projectId:context.projectId,
        inputRevision:Number(row.input_revision),inputHash:String(row.input_hash).trim(),
        requestId:`difficulty-current-${sha256({owner:context.ownerUserId,project:context.projectId,snapshot:context.snapshotId}).slice(0,48)}`},options);
      if(assembled.source.materialId!==String(row.source_material_id)||assembled.source.materialVersion!==Number(row.source_material_version)||
         assembled.source.profileVersion!==Number(row.source_profile_version)||assembled.targetRevision!==Number(row.target_revision))return null;
      const currentIdentity=await difficultyEvidenceIdentity(client,assembled);
      if(currentIdentity!==String(row.evidence_identity).trim())return null;
    }catch{return null;}
  }else if(row.input_revision!==null&&row.input_hash!==null){
    // Pre-0058 rows have no derivation fingerprint. Preserve them while their
    // locked input has no reviewer ledger, but never expose one as current once
    // that input has acquired any period decision (including a later withdrawal).
    const ledger=await client.query(`SELECT 1 FROM bb_target_period_evidence_decisions
      WHERE owner_user_id=$1 AND project_id=$2 AND input_revision=$3 AND input_hash=$4 LIMIT 1`,
      [context.ownerUserId,context.projectId,Number(row.input_revision),String(row.input_hash).trim()]);
    if(ledger.rows.length)return null;
  }
  return mapRow(row, false);
}

export async function getCurrentUpdateDifficultySnapshot(
  dependencies: UpdateDifficultyDependencies,
  context: { ownerUserId: string; projectId: string; snapshotId: string },
  options: UpdateDifficultyClientOptions = {},
): Promise<StoredUpdateDifficultySnapshot | null> {
  return getCurrentUpdateDifficultySnapshotWithClient(dependencies.pool, context,options);
}
