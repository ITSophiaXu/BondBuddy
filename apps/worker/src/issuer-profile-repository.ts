import { createHash, randomUUID } from 'node:crypto';
import type { AnnualBusinessProfile } from '@bondbuddy/domain/reference-match';

export interface IssuerProfileRunScope {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly inputRevision: number;
  readonly inputHash: string;
}

export interface IssuerBusinessProfileClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

export interface IssuerBusinessProfilePool {
  connect(): Promise<IssuerBusinessProfileClient>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface IssuerBusinessProfileDependencies {
  readonly pool: IssuerBusinessProfilePool;
  readonly newId?: () => string;
}

/** Internal worker input. The caller must derive the profile from target-issuer materials. */
export interface AppendIssuerBusinessProfileInput extends IssuerProfileRunScope {
  readonly requestId: string;
  readonly sourceMaterialId: string;
  readonly sourceMaterialVersion: number;
  readonly profile: AnnualBusinessProfile;
}

export interface StoredIssuerBusinessProfile extends IssuerProfileRunScope {
  readonly id: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly sourceMaterialId: string;
  readonly sourceMaterialVersion: number;
  readonly profileVersion: number;
  readonly profile: AnnualBusinessProfile;
  readonly profileSha256: string;
  readonly evidenceRefs: readonly string[];
  readonly reviewStatus: 'pending_review';
  readonly createdAt: string;
  readonly replayed: boolean;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const financialRoles = new Set(['audit', 'financial', 'notes']);
const profileKeys = ['issuerId', 'profileVersion', 'taxonomyVersion', 'fiscalYear', 'completeAnnualPeriod', 'latestCompleteAnnual',
  'verificationStatus', 'accountingScope', 'revenueBasis', 'currency', 'unit', 'allComparableBusinessLinesPresent', 'sourceEvidence', 'lines'] as const;
const lineKeys = ['code', 'label', 'originalLabel', 'revenue', 'rank', 'evidence', 'classificationEvidence'] as const;

function fail(code: string): Error {
  const error = new Error(code);
  error.name = 'IssuerBusinessProfileRepositoryError';
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { throw fail('INVALID_ISSUER_PROFILE_ROW'); }
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => (allowed as readonly string[]).includes(key));
}

function cleanProfile(value: unknown): Omit<AnnualBusinessProfile, 'profileVersion' | 'verificationStatus'> & { profileVersion: string; verificationStatus: 'pending' } {
  if (!isRecord(value) || !exactKeys(value, profileKeys) || typeof value.issuerId !== 'string' || !value.issuerId.trim() ||
      typeof value.taxonomyVersion !== 'string' || !value.taxonomyVersion.trim() || !Number.isSafeInteger(value.fiscalYear) ||
      typeof value.completeAnnualPeriod !== 'boolean' || typeof value.latestCompleteAnnual !== 'boolean' ||
      !['verified', 'pending', 'rejected'].includes(String(value.verificationStatus)) ||
      !['consolidated', 'parent', 'mixed', 'unknown'].includes(String(value.accountingScope)) ||
      typeof value.revenueBasis !== 'string' || typeof value.currency !== 'string' || typeof value.unit !== 'string' ||
      typeof value.allComparableBusinessLinesPresent !== 'boolean' || !Array.isArray(value.sourceEvidence) || !Array.isArray(value.lines)) {
    throw fail('INVALID_ISSUER_ANNUAL_BUSINESS_PROFILE');
  }
  const refs = (items: unknown): string[] => {
    if (!Array.isArray(items) || items.length > 200 || items.some(ref => typeof ref !== 'string' || !idPattern.test(ref))) {
      throw fail('INVALID_ISSUER_PROFILE_EVIDENCE_REFS');
    }
    return [...items] as string[];
  };
  const lines = value.lines.map((item): AnnualBusinessProfile['lines'][number] => {
    if (!isRecord(item) || !exactKeys(item, lineKeys) || (item.code !== null && typeof item.code !== 'string') ||
        typeof item.label !== 'string' || !item.label.trim() || typeof item.originalLabel !== 'string' || !item.originalLabel.trim() ||
        (item.revenue !== null && (typeof item.revenue !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(item.revenue))) ||
        !Number.isSafeInteger(item.rank) || Number(item.rank) < 1) throw fail('INVALID_ISSUER_PROFILE_REVENUE_LINE');
    return { code: item.code as string | null, label: item.label, originalLabel: item.originalLabel,
      revenue: item.revenue as string | null, rank: Number(item.rank), evidence: refs(item.evidence),
      classificationEvidence: refs(item.classificationEvidence) };
  });
  const sourceEvidence = refs(value.sourceEvidence);
  const evidenceRefs = new Set([...sourceEvidence, ...lines.flatMap(line => [...line.evidence, ...line.classificationEvidence])]);
  if (evidenceRefs.size === 0) throw fail('ISSUER_PROFILE_EVIDENCE_REQUIRED');
  return {
    issuerId: value.issuerId,
    profileVersion: '0',
    taxonomyVersion: value.taxonomyVersion,
    fiscalYear: Number(value.fiscalYear),
    completeAnnualPeriod: value.completeAnnualPeriod,
    latestCompleteAnnual: value.latestCompleteAnnual,
    verificationStatus: 'pending',
    accountingScope: value.accountingScope as AnnualBusinessProfile['accountingScope'],
    revenueBasis: value.revenueBasis,
    currency: value.currency,
    unit: value.unit,
    allComparableBusinessLinesPresent: value.allComparableBusinessLinesPresent,
    sourceEvidence,
    lines,
  };
}

function evidenceRefs(profile: AnnualBusinessProfile): string[] {
  return [...new Set([ ...profile.sourceEvidence, ...profile.lines.flatMap(line => [...line.evidence, ...line.classificationEvidence]) ])].sort();
}

function mapRow(row: Record<string, unknown>, replayed: boolean): StoredIssuerBusinessProfile {
  const profileValue = parseJson(row.profile);
  const refsValue = parseJson(row.evidence_refs);
  if (!isRecord(profileValue) || !Array.isArray(refsValue) || refsValue.some(ref => typeof ref !== 'string') ||
      row.review_status !== 'pending_review' || !shaPattern.test(String(row.profile_sha256).trim()) ||
      sha256(canonical(profileValue)) !== String(row.profile_sha256).trim() ||
      String(profileValue.profileVersion) !== String(row.profile_version) || profileValue.verificationStatus !== 'pending') {
    throw fail('ISSUER_PROFILE_HASH_OR_STATUS_MISMATCH');
  }
  // Revalidate the stored payload shape and reconstruct the closed internal shape.
  const clean = cleanProfile(profileValue);
  const profileEvidence = evidenceRefs(clean as AnnualBusinessProfile);
  if (canonical(profileEvidence) !== canonical(refsValue)) throw fail('ISSUER_PROFILE_HASH_OR_STATUS_MISMATCH');
  return {
    id: String(row.id), ownerUserId: String(row.owner_user_id), projectId: String(row.project_id), runId: String(row.run_id),
    inputRevision: Number(row.input_revision), inputHash: String(row.input_hash).trim(), requestId: String(row.request_id),
    requestHash: String(row.request_hash).trim(), sourceMaterialId: String(row.source_material_id),
    sourceMaterialVersion: Number(row.source_material_version), profileVersion: Number(row.profile_version),
    profile: { ...clean, profileVersion: String(row.profile_version) } as AnnualBusinessProfile,
    profileSha256: String(row.profile_sha256).trim(), evidenceRefs: refsValue as string[],
    reviewStatus: 'pending_review', createdAt: new Date(String(row.created_at)).toISOString(), replayed,
  };
}

const PROFILE_COLUMNS = `id, owner_user_id, project_id, run_id, input_revision, input_hash, source_material_id,
  source_material_version, profile_version, request_id, request_hash, profile, profile_sha256, evidence_refs, review_status, created_at`;
const QUALIFIED_PROFILE_COLUMNS = PROFILE_COLUMNS.split(/,\s*/).map(column => `p.${column}`).join(', ');

/**
 * Append a target issuer profile in the locked input/run scope. Status from the caller is
 * discarded; this repository cannot establish reviewer identity and stores pending_review only.
 */
export async function appendIssuerBusinessProfile(
  dependencies: IssuerBusinessProfileDependencies,
  input: AppendIssuerBusinessProfileInput,
): Promise<StoredIssuerBusinessProfile> {
  if (![input.ownerUserId, input.projectId, input.runId, input.requestId, input.sourceMaterialId].every(value => idPattern.test(value)) ||
      !Number.isSafeInteger(input.inputRevision) || input.inputRevision < 1 || !shaPattern.test(input.inputHash) ||
      !Number.isSafeInteger(input.sourceMaterialVersion) || input.sourceMaterialVersion < 1) throw fail('INVALID_ISSUER_PROFILE_SCOPE');
  const profile = cleanProfile(input.profile);
  const requestHash = sha256(canonical({ ownerUserId: input.ownerUserId, projectId: input.projectId, runId: input.runId,
    inputRevision: input.inputRevision, inputHash: input.inputHash, sourceMaterialId: input.sourceMaterialId,
    sourceMaterialVersion: input.sourceMaterialVersion, profile }));
  const db = await dependencies.pool.connect();
  const newId = dependencies.newId ?? randomUUID;
  try {
    await db.query('BEGIN');
    const lock = await db.query(
      `SELECT r.id, r.input_revision, r.input_hash, i.material_versions, m.role
         FROM bb_runs r
         JOIN bb_input_revisions i ON i.owner_user_id=r.owner_user_id AND i.project_id=r.project_id AND i.revision=r.input_revision
         JOIN bb_material_versions m ON m.owner_user_id=r.owner_user_id AND m.project_id=r.project_id
          AND m.id=$5 AND m.version=$6 AND m.deleted_at IS NULL
        WHERE r.owner_user_id=$1 AND r.project_id=$2 AND r.id=$3 AND r.input_revision=$4 AND r.input_hash=$7
        FOR UPDATE OF i`,
      [input.ownerUserId, input.projectId, input.runId, input.inputRevision, input.sourceMaterialId, input.sourceMaterialVersion, input.inputHash]);
    if (lock.rows.length !== 1) throw fail('ISSUER_PROFILE_RUN_OR_SOURCE_NOT_FOUND');
    const roles = new Set(String(lock.rows[0]!.role).split(','));
    if (![...financialRoles].some(role => roles.has(role))) throw fail('ISSUER_PROFILE_SOURCE_NOT_FINANCIAL');
    const materialRefs = parseJson(lock.rows[0]!.material_versions);
    if (!Array.isArray(materialRefs) || !materialRefs.some(ref => isRecord(ref) && ref.material_id === input.sourceMaterialId &&
        Number(ref.material_version) === input.sourceMaterialVersion)) throw fail('ISSUER_PROFILE_SOURCE_OUTSIDE_INPUT_REVISION');

    const refs = evidenceRefs(profile as AnnualBusinessProfile);
    const found = await db.query(
      `SELECT DISTINCT e.record_id
         FROM bb_parse_evidence e
         JOIN bb_parse_snapshots s ON s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id
          AND s.material_id=e.material_id AND s.material_version=e.material_version AND s.id=e.snapshot_id
         JOIN bb_material_versions m ON m.owner_user_id=e.owner_user_id AND m.project_id=e.project_id
          AND m.id=e.material_id AND m.version=e.material_version AND m.deleted_at IS NULL
        WHERE e.owner_user_id=$1 AND e.project_id=$2 AND e.material_id=$3 AND e.material_version=$4
          AND s.response_status='parsed' AND e.record_id=ANY($5::text[])`,
      [input.ownerUserId, input.projectId, input.sourceMaterialId, input.sourceMaterialVersion, refs]);
    const known = new Set(found.rows.map(row => String(row.record_id)));
    if (refs.some(ref => !known.has(ref))) throw fail('ISSUER_PROFILE_EVIDENCE_NOT_IN_SOURCE_SNAPSHOT');

    const existing = await db.query(
      `SELECT ${PROFILE_COLUMNS} FROM bb_issuer_business_profiles
        WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3 AND request_id=$4`,
      [input.ownerUserId, input.projectId, input.runId, input.requestId]);
    if (existing.rows.length) {
      const row = existing.rows[0]!;
      if (String(row.request_hash).trim() !== requestHash) throw fail('ISSUER_PROFILE_IDEMPOTENCY_CONFLICT');
      const mapped = mapRow(row, true);
      await db.query('COMMIT');
      return mapped;
    }

    const latest = await db.query(
      `SELECT COALESCE(max(profile_version),0)::int AS profile_version
         FROM bb_issuer_business_profiles
        WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3`,
      [input.ownerUserId, input.projectId, input.runId]);
    const profileVersion = Number(latest.rows[0]?.profile_version ?? 0) + 1;
    const storedProfile = { ...profile, profileVersion: String(profileVersion) };
    const profileText = canonical(storedProfile);
    const profileHash = sha256(profileText);
    const inserted = await db.query(
      `INSERT INTO bb_issuer_business_profiles
       (id, owner_user_id, project_id, run_id, input_revision, input_hash, source_material_id, source_material_version,
        profile_version, request_id, request_hash, profile, profile_sha256, evidence_refs, review_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,'pending_review')
       RETURNING ${PROFILE_COLUMNS}`,
      [newId(), input.ownerUserId, input.projectId, input.runId, input.inputRevision, input.inputHash, input.sourceMaterialId,
        input.sourceMaterialVersion, profileVersion, input.requestId, requestHash, profileText, profileHash, JSON.stringify(refs)]);
    const row = inserted.rows[0];
    if (!row) throw fail('ISSUER_PROFILE_INSERT_FAILED');
    await db.query(
      `INSERT INTO bb_outbox (id, owner_user_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1,$2,'run',$3,'issuer.business_profile.pending_review',$4::jsonb)`,
      [newId(), input.ownerUserId, input.runId, JSON.stringify({ project_id: input.projectId, input_revision: input.inputRevision,
        input_hash: input.inputHash, profile_id: row.id, profile_version: profileVersion, review_status: 'pending_review' })]);
    const mapped = mapRow(row, false);
    await db.query('COMMIT');
    return mapped;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

/** Returns only pending records for internal review work; it never creates an approval. */
export async function getPendingIssuerBusinessProfile(
  pool: IssuerBusinessProfilePool,
  scope: IssuerProfileRunScope,
): Promise<StoredIssuerBusinessProfile | null> {
  const result = await pool.query(
    `SELECT ${QUALIFIED_PROFILE_COLUMNS}
       FROM bb_issuer_business_profiles p
       JOIN bb_runs r ON r.owner_user_id=p.owner_user_id AND r.project_id=p.project_id AND r.id=p.run_id
        AND r.input_revision=p.input_revision AND r.input_hash=p.input_hash
       JOIN bb_input_revisions i ON i.owner_user_id=p.owner_user_id AND i.project_id=p.project_id
        AND i.revision=p.input_revision AND i.input_hash=p.input_hash
      WHERE p.owner_user_id=$1 AND p.project_id=$2 AND p.run_id=$3 AND p.input_revision=$4 AND p.input_hash=$5
        AND p.review_status='pending_review'
      ORDER BY p.profile_version DESC LIMIT 1`,
    [scope.ownerUserId, scope.projectId, scope.runId, scope.inputRevision, scope.inputHash]);
  return result.rows[0] ? mapRow(result.rows[0], false) : null;
}

/**
 * The #33 stage consumes only authenticated review attestations. No trusted review
 * handoff exists yet, so pending storage can never be upgraded by caller-supplied fields.
 */
export async function loadReviewedIssuerAnnualProfile(
  pool: IssuerBusinessProfilePool,
  scope: IssuerProfileRunScope,
): Promise<null> {
  const pending = await getPendingIssuerBusinessProfile(pool, scope);
  if (pending) return null;
  // Even if a row was corrupted or future schema is extended, never infer review authority here.
  return null;
}
