import { createHash, randomUUID } from 'node:crypto';
import { hasLib01AAutoMatchBasis, type AnnualBusinessProfile } from '@bondbuddy/domain/reference-match';
import { loadVerifiedIssuerIdentitySourceRecord } from '@bondbuddy/api/issuer-identity-source';

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

export interface AnnualRevenueProof {
  readonly basis: {
    readonly fiscalYear: number;
    readonly accountingScope: 'consolidated';
    readonly revenueBasis: 'main_business_revenue';
    readonly currency: string;
    readonly unit: string;
  };
  readonly total: string;
  readonly totalEvidence: readonly string[];
  readonly thirdPlaceTieProof: {
    readonly status: 'clear' | 'unresolved';
    readonly thresholdRevenue: string;
    readonly tiedBusinessCodes: readonly string[];
    readonly evidence: readonly string[];
  };
}

/** Internal worker input. The caller must derive the profile from target-issuer materials. */
export interface AppendIssuerBusinessProfileInput extends IssuerProfileRunScope {
  readonly requestId: string;
  readonly sourceMaterialId: string;
  readonly sourceMaterialVersion: number;
  readonly profile: AnnualBusinessProfile;
  readonly annualRevenueProof: AnnualRevenueProof;
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
  readonly annualRevenueProof: AnnualRevenueProof;
  readonly sourceMaterialSha256: string | null;
  readonly parseSnapshotId: string | null;
  readonly parseSnapshotSha256: string | null;
  readonly evidenceRecordHashes: Readonly<Record<string, string>>;
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
const decimalPattern = /^(0|[1-9]\d*)(?:\.\d+)?$/;

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

function decimalParts(value: string): { coefficient: bigint; scale: number } {
  if (!decimalPattern.test(value)) throw fail('ISSUER_PROFILE_REVENUE_INVALID');
  const [whole, fraction = ''] = value.split('.');
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function validateAnnualRevenueProof(profile: AnnualBusinessProfile, proof: AnnualRevenueProof): AnnualRevenueProof {
  if (!proof || !proof.basis || !Number.isSafeInteger(proof.basis.fiscalYear) || proof.basis.accountingScope !== 'consolidated' ||
      proof.basis.revenueBasis !== 'main_business_revenue' || typeof proof.basis.currency !== 'string' || !proof.basis.currency.trim() ||
      typeof proof.basis.unit !== 'string' || !proof.basis.unit.trim() || !decimalPattern.test(proof.total) ||
      !Array.isArray(proof.totalEvidence) || proof.totalEvidence.length === 0 ||
      !proof.thirdPlaceTieProof || !['clear', 'unresolved'].includes(proof.thirdPlaceTieProof.status) ||
      !decimalPattern.test(proof.thirdPlaceTieProof.thresholdRevenue) || !Array.isArray(proof.thirdPlaceTieProof.tiedBusinessCodes) ||
      !Array.isArray(proof.thirdPlaceTieProof.evidence) || proof.thirdPlaceTieProof.evidence.length === 0) {
    throw fail('ISSUER_PROFILE_ANNUAL_REVENUE_PROOF_INVALID');
  }
  if (!profile.completeAnnualPeriod || !profile.latestCompleteAnnual || profile.accountingScope !== 'consolidated' ||
      profile.revenueBasis !== 'main_business_revenue' || !profile.allComparableBusinessLinesPresent || profile.lines.length < 3) {
    throw fail('ISSUER_PROFILE_ANNUAL_REVENUE_UNIVERSE_INCOMPLETE');
  }
  if (proof.basis.fiscalYear !== profile.fiscalYear || proof.basis.accountingScope !== profile.accountingScope ||
      proof.basis.revenueBasis !== profile.revenueBasis || proof.basis.currency !== profile.currency || proof.basis.unit !== profile.unit)
    throw fail('ISSUER_PROFILE_ANNUAL_REVENUE_BASIS_MISMATCH');
  const normalized = profile.lines.map(line => ({ ...line, amount: decimalParts(line.revenue ?? '') }));
  if (typeof profile.currency !== 'string' || !profile.currency.trim() || typeof profile.unit !== 'string' || !profile.unit.trim() ||
      normalized.some(line => !line.code?.trim() || !line.label.trim() || !line.originalLabel.trim() ||
        line.evidence.length === 0 || line.classificationEvidence.length === 0)) throw fail('ISSUER_PROFILE_ANNUAL_REVENUE_ROW_EVIDENCE_REQUIRED');
  const scale = Math.max(decimalParts(proof.total).scale, ...normalized.map(line => line.amount.scale));
  const factor = (amount: { coefficient: bigint; scale: number }) => amount.coefficient * 10n ** BigInt(scale - amount.scale);
  const byAmount = [...normalized].sort((a, b) => factor(a.amount) === factor(b.amount) ? String(a.code).localeCompare(String(b.code)) :
    factor(a.amount) > factor(b.amount) ? -1 : 1);
  if (new Set(normalized.map(line => line.code!.trim())).size !== normalized.length ||
      normalized.some(line => line.rank !== byAmount.indexOf(line) + 1) ||
      normalized.reduce((sum, line) => sum + factor(line.amount), 0n) !== factor(decimalParts(proof.total))) {
    throw fail('ISSUER_PROFILE_ANNUAL_REVENUE_TOTAL_OR_RANK_MISMATCH');
  }
  const threshold = byAmount[2]!;
  const tiedCodes = byAmount.filter(line => factor(line.amount) === factor(threshold.amount)).map(line => String(line.code)).sort();
  const topThreeBoundaryIsAmbiguous = byAmount.filter(line => factor(line.amount) >= factor(threshold.amount)).length > 3;
  if (proof.thirdPlaceTieProof.thresholdRevenue !== threshold.revenue ||
      canonical([...proof.thirdPlaceTieProof.tiedBusinessCodes].sort()) !== canonical(tiedCodes) ||
      (proof.thirdPlaceTieProof.status === 'clear' && topThreeBoundaryIsAmbiguous) ||
      (proof.thirdPlaceTieProof.status === 'unresolved' && !topThreeBoundaryIsAmbiguous)) {
    throw fail('ISSUER_PROFILE_THIRD_PLACE_TIE_PROOF_MISMATCH');
  }
  for (const ref of [...proof.totalEvidence, ...proof.thirdPlaceTieProof.evidence]) {
    if (!idPattern.test(ref)) throw fail('INVALID_ISSUER_PROFILE_EVIDENCE_REFS');
  }
  return { basis: { ...proof.basis }, total: proof.total, totalEvidence: [...new Set(proof.totalEvidence)].sort(),
    thirdPlaceTieProof: { ...proof.thirdPlaceTieProof, tiedBusinessCodes: [...proof.thirdPlaceTieProof.tiedBusinessCodes].sort(),
      evidence: [...new Set(proof.thirdPlaceTieProof.evidence)].sort() } };
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
  const proof = parseJson(row.third_place_tie_proof) as AnnualRevenueProof['thirdPlaceTieProof'] | null;
  const totalEvidence = parseJson(row.annual_revenue_total_evidence);
  const basis = parseJson(row.annual_revenue_basis);
  const recordHashes = parseJson(row.evidence_record_hashes);
  if (canonical([...new Set([...profileEvidence, ...(Array.isArray(totalEvidence) ? totalEvidence as string[] : []),
      ...(proof ? proof.evidence : [])])].sort()) !== canonical(refsValue) || !proof || !isRecord(basis) || !Array.isArray(totalEvidence) ||
      !isRecord(recordHashes) || Object.entries(recordHashes).some(([key, value]) => !idPattern.test(key) || !shaPattern.test(String(value)))) {
    throw fail('ISSUER_PROFILE_HASH_OR_STATUS_MISMATCH');
  }
  return {
    id: String(row.id), ownerUserId: String(row.owner_user_id), projectId: String(row.project_id), runId: String(row.run_id),
    inputRevision: Number(row.input_revision), inputHash: String(row.input_hash).trim(), requestId: String(row.request_id),
    requestHash: String(row.request_hash).trim(), sourceMaterialId: String(row.source_material_id),
    sourceMaterialVersion: Number(row.source_material_version), profileVersion: Number(row.profile_version),
    profile: { ...clean, profileVersion: String(row.profile_version) } as AnnualBusinessProfile,
    profileSha256: String(row.profile_sha256).trim(), evidenceRefs: refsValue as string[],
    annualRevenueProof: { basis: parseJson(row.annual_revenue_basis) as AnnualRevenueProof['basis'], total: String(row.annual_revenue_total),
      totalEvidence: totalEvidence as string[], thirdPlaceTieProof: proof },
    sourceMaterialSha256: row.source_material_sha256 ? String(row.source_material_sha256).trim() : null,
    parseSnapshotId: row.parse_snapshot_id ? String(row.parse_snapshot_id) : null,
    parseSnapshotSha256: row.parse_snapshot_sha256 ? String(row.parse_snapshot_sha256).trim() : null,
    evidenceRecordHashes: recordHashes as Record<string, string>,
    reviewStatus: 'pending_review', createdAt: new Date(String(row.created_at)).toISOString(), replayed,
  };
}

const PROFILE_COLUMNS = `id, owner_user_id, project_id, run_id, input_revision, input_hash, source_material_id,
  source_material_version, profile_version, request_id, request_hash, profile, profile_sha256, evidence_refs, review_status, created_at,
  source_material_sha256, parse_snapshot_id, parse_snapshot_sha256, evidence_record_hashes, annual_revenue_total,
  annual_revenue_basis, annual_revenue_total_evidence, third_place_tie_proof`;
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
  const revenueProof = validateAnnualRevenueProof(profile as AnnualBusinessProfile, input.annualRevenueProof);
  const requestHash = sha256(canonical({ ownerUserId: input.ownerUserId, projectId: input.projectId, runId: input.runId,
    inputRevision: input.inputRevision, inputHash: input.inputHash, sourceMaterialId: input.sourceMaterialId,
    sourceMaterialVersion: input.sourceMaterialVersion, profile, revenueProof }));
  const db = await dependencies.pool.connect();
  const newId = dependencies.newId ?? randomUUID;
  try {
    await db.query('BEGIN');
    const lock = await db.query(
      `SELECT r.id, r.input_revision, r.input_hash, i.material_versions, i.manifest, m.role, m.sha256 AS source_material_sha256
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
    const manifest = parseJson(lock.rows[0]!.manifest);
    if (!isRecord(manifest) || !isRecord(manifest.issuer_identity) || manifest.issuer_identity.status !== 'verified' ||
        manifest.issuer_identity.entity_id !== profile.issuerId) throw fail('ISSUER_PROFILE_ISSUER_IDENTITY_NOT_LOCKED');
    const identity = manifest.issuer_identity;
    let verifiedIdentity;
    try {
      verifiedIdentity = await loadVerifiedIssuerIdentitySourceRecord(db, { ownerUserId: input.ownerUserId, projectId: input.projectId,
        materialId: String(identity.material_id), materialVersion: Number(identity.material_version) });
    } catch { throw fail('ISSUER_PROFILE_ISSUER_IDENTITY_REVIEW_STALE'); }
    if (!verifiedIdentity || verifiedIdentity.recordId !== identity.record_id || verifiedIdentity.version !== Number(identity.version) ||
        verifiedIdentity.contentHash !== String(identity.content_hash).trim() || verifiedIdentity.entityId !== identity.entity_id ||
        verifiedIdentity.entityId !== profile.issuerId || verifiedIdentity.sourceSnapshotId !== identity.source_snapshot_id ||
        verifiedIdentity.sourceRecordId !== identity.source_record_id ||
        verifiedIdentity.sourceRecordSha256 !== String(identity.source_record_sha256).trim())
      throw fail('ISSUER_PROFILE_ISSUER_IDENTITY_REVIEW_STALE');

    const refs = [...new Set([...evidenceRefs(profile as AnnualBusinessProfile), ...revenueProof.totalEvidence,
      ...revenueProof.thirdPlaceTieProof.evidence])].sort();
    const latestSnapshot = await db.query(
      `SELECT id, response_sha256, response_status FROM bb_parse_snapshots
        WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4
        ORDER BY created_at DESC, id DESC LIMIT 1 FOR SHARE`,
      [input.ownerUserId, input.projectId, input.sourceMaterialId, input.sourceMaterialVersion]);
    const snapshot = latestSnapshot.rows[0];
    if (!snapshot || snapshot.response_status !== 'parsed' || !shaPattern.test(String(snapshot.response_sha256).trim()))
      throw fail('ISSUER_PROFILE_LATEST_PARSE_SNAPSHOT_UNAVAILABLE');
    const found = await db.query(
      `SELECT DISTINCT e.record_id, e.record_sha256
         FROM bb_parse_evidence e
         JOIN bb_parse_snapshots s ON s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id
          AND s.material_id=e.material_id AND s.material_version=e.material_version AND s.id=e.snapshot_id
         JOIN bb_material_versions m ON m.owner_user_id=e.owner_user_id AND m.project_id=e.project_id
         AND m.id=e.material_id AND m.version=e.material_version AND m.deleted_at IS NULL
        WHERE e.owner_user_id=$1 AND e.project_id=$2 AND e.material_id=$3 AND e.material_version=$4
          AND s.content_sha256=m.sha256 AND e.content_sha256=m.sha256
          AND s.id=$5 AND s.response_status='parsed' AND s.response_sha256=$6 AND e.record_id=ANY($7::text[])`,
      [input.ownerUserId, input.projectId, input.sourceMaterialId, input.sourceMaterialVersion, snapshot.id,
        String(snapshot.response_sha256).trim(), refs]);
    const hashes = Object.fromEntries(found.rows.map(row => [String(row.record_id), String(row.record_sha256).trim()]));
    if (refs.some(ref => !shaPattern.test(hashes[ref] ?? ''))) throw fail('ISSUER_PROFILE_EVIDENCE_NOT_IN_LATEST_PARSE_SNAPSHOT');

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
        profile_version, request_id, request_hash, profile, profile_sha256, evidence_refs, review_status,
        source_material_sha256, parse_snapshot_id, parse_snapshot_sha256, evidence_record_hashes, annual_revenue_basis, annual_revenue_total,
        annual_revenue_total_evidence, third_place_tie_proof)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,'pending_review',$15,$16,$17,$18::jsonb,$19::jsonb,$20,$21::jsonb,$22::jsonb)
       RETURNING ${PROFILE_COLUMNS}`,
      [newId(), input.ownerUserId, input.projectId, input.runId, input.inputRevision, input.inputHash, input.sourceMaterialId,
        input.sourceMaterialVersion, profileVersion, input.requestId, requestHash, profileText, profileHash, JSON.stringify(refs),
        String(lock.rows[0]!.source_material_sha256).trim(), String(snapshot.id), String(snapshot.response_sha256).trim(), JSON.stringify(hashes),
        JSON.stringify(revenueProof.basis), revenueProof.total, JSON.stringify(revenueProof.totalEvidence), JSON.stringify(revenueProof.thirdPlaceTieProof)]);
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
): Promise<AnnualBusinessProfile | null> {
  const result = await pool.query(
    `SELECT ${QUALIFIED_PROFILE_COLUMNS},p.source_material_sha256,p.parse_snapshot_id,p.parse_snapshot_sha256,
        p.evidence_record_hashes,p.annual_revenue_basis,p.annual_revenue_total,p.annual_revenue_total_evidence,p.third_place_tie_proof,
        i.manifest,m.sha256 AS live_material_sha,m.role,m.deleted_at AS material_deleted,
        s.response_sha256 AS live_parse_sha,s.response_status,
        rv.id AS review_id,rv.action AS review_action,rv.profile_version AS reviewed_profile_version,
        rv.profile_sha256 AS reviewed_profile_sha,rv.input_revision AS reviewed_input_revision,rv.input_hash AS reviewed_input_hash,
        rv.source_material_sha256 AS reviewed_material_sha,rv.parse_snapshot_sha256 AS reviewed_parse_sha,
        rv.issuer_identity_record_id,rv.issuer_identity_version,rv.issuer_identity_hash,rv.verified_entity_id,
        g.id AS active_profile_grant_id,
        identity_review.verified_entity_id AS current_identity_entity,identity_source.identity_version AS current_identity_version,
        identity_source.content_sha256 AS current_identity_hash,identity_source.material_id AS current_identity_material_id,
        identity_source.material_version AS current_identity_material_version,identity_source.snapshot_id AS current_identity_snapshot_id,
        identity_source.source_record_id AS current_identity_source_record_id,identity_source.source_record_sha256 AS current_identity_source_record_sha,
        identity_source.source_content_sha256 AS current_identity_source_content_sha,identity_grant.id AS current_identity_grant_id,
        latest_parse.id AS latest_parse_id,latest_parse.response_sha256 AS latest_parse_sha,
        (SELECT jsonb_object_agg(e.record_id,e.record_sha256) FROM bb_parse_evidence e
          WHERE e.owner_user_id=p.owner_user_id AND e.project_id=p.project_id AND e.material_id=p.source_material_id
            AND e.material_version=p.source_material_version AND e.snapshot_id=p.parse_snapshot_id
            AND e.record_id IN (SELECT jsonb_array_elements_text(p.evidence_refs))) AS live_evidence_hashes
       FROM bb_issuer_business_profiles p
       JOIN bb_runs r ON r.owner_user_id=p.owner_user_id AND r.project_id=p.project_id AND r.id=p.run_id
        AND r.input_revision=p.input_revision AND r.input_hash=p.input_hash
       JOIN bb_input_revisions i ON i.owner_user_id=p.owner_user_id AND i.project_id=p.project_id
        AND i.revision=p.input_revision AND i.input_hash=p.input_hash
       JOIN bb_material_versions m ON m.owner_user_id=p.owner_user_id AND m.project_id=p.project_id
        AND m.id=p.source_material_id AND m.version=p.source_material_version
       JOIN bb_parse_snapshots s ON s.owner_user_id=p.owner_user_id AND s.project_id=p.project_id
        AND s.material_id=p.source_material_id AND s.material_version=p.source_material_version AND s.id=p.parse_snapshot_id
       JOIN LATERAL (SELECT x.id,x.response_sha256 FROM bb_parse_snapshots x
          WHERE x.owner_user_id=p.owner_user_id AND x.project_id=p.project_id AND x.material_id=p.source_material_id
            AND x.material_version=p.source_material_version ORDER BY x.created_at DESC,x.id DESC LIMIT 1) latest_parse ON true
       JOIN LATERAL (SELECT a.* FROM bb_issuer_annual_profile_reviews a WHERE a.owner_user_id=p.owner_user_id
          AND a.project_id=p.project_id AND a.profile_id=p.id ORDER BY a.sequence_id DESC LIMIT 1) rv ON true
       JOIN bb_issuer_annual_profile_reviewer_grants g ON g.id=rv.reviewer_grant_id AND g.user_id=rv.reviewer_user_id
        AND g.scope_owner_user_id=p.owner_user_id AND g.scope_project_id=p.project_id AND g.revoked_at IS NULL
       LEFT JOIN bb_issuer_identity_source_records identity_source ON identity_source.owner_user_id=p.owner_user_id
       AND identity_source.project_id=p.project_id AND identity_source.id=rv.issuer_identity_record_id
        AND identity_source.identity_version=(SELECT max(latest.identity_version) FROM bb_issuer_identity_source_records latest
          JOIN bb_issuer_identity_source_reviews latest_review ON latest_review.owner_user_id=latest.owner_user_id
            AND latest_review.project_id=latest.project_id AND latest_review.material_id=latest.material_id
            AND latest_review.material_version=latest.material_version AND latest_review.source_record_id=latest.id
            AND latest_review.decision='verified'
          JOIN bb_issuer_identity_reviewer_grants latest_grant ON latest_grant.id=latest_review.reviewer_grant_id
            AND latest_grant.user_id=latest_review.reviewer_user_id AND latest_grant.role='issuer_identity_reviewer'
            AND latest_grant.revoked_at IS NULL
          WHERE latest.owner_user_id=identity_source.owner_user_id AND latest.project_id=identity_source.project_id
            AND latest.material_id=identity_source.material_id AND latest.material_version=identity_source.material_version)
       LEFT JOIN bb_issuer_identity_source_reviews identity_review ON identity_review.owner_user_id=identity_source.owner_user_id
        AND identity_review.project_id=identity_source.project_id AND identity_review.material_id=identity_source.material_id
        AND identity_review.material_version=identity_source.material_version AND identity_review.source_record_id=identity_source.id
        AND identity_review.decision='verified'
       LEFT JOIN bb_issuer_identity_reviewer_grants identity_grant ON identity_grant.id=identity_review.reviewer_grant_id
        AND identity_grant.user_id=identity_review.reviewer_user_id AND identity_grant.role='issuer_identity_reviewer'
        AND identity_grant.scope_owner_user_id=p.owner_user_id AND identity_grant.scope_project_id=p.project_id AND identity_grant.revoked_at IS NULL
         WHERE p.owner_user_id=$1 AND p.project_id=$2 AND p.run_id=$3 AND p.input_revision=$4 AND p.input_hash=$5
         AND rv.action='approve' AND p.profile_version=(SELECT max(current.profile_version) FROM bb_issuer_business_profiles current
           WHERE current.owner_user_id=p.owner_user_id AND current.project_id=p.project_id AND current.run_id=p.run_id
             AND current.input_revision=p.input_revision AND current.input_hash=p.input_hash)
         AND NOT EXISTS (SELECT 1 FROM bb_issuer_identity_source_records observed
           LEFT JOIN bb_issuer_identity_source_reviews observed_review ON observed_review.owner_user_id=observed.owner_user_id
             AND observed_review.project_id=observed.project_id AND observed_review.material_id=observed.material_id
             AND observed_review.material_version=observed.material_version AND observed_review.source_record_id=observed.id
           LEFT JOIN bb_issuer_identity_reviewer_grants observed_grant ON observed_grant.id=observed_review.reviewer_grant_id
             AND observed_grant.user_id=observed_review.reviewer_user_id AND observed_grant.role='issuer_identity_reviewer'
             AND observed_grant.scope_owner_user_id=observed.owner_user_id AND observed_grant.scope_project_id=observed.project_id
          WHERE observed.owner_user_id=identity_source.owner_user_id AND observed.project_id=identity_source.project_id
            AND observed.material_id=identity_source.material_id AND observed.material_version=identity_source.material_version
            AND (observed_review.id IS NULL OR observed_review.decision NOT IN ('verified','rejected') OR observed_grant.id IS NULL
              OR observed_grant.revoked_at IS NOT NULL OR (observed_review.decision='verified' AND
                observed_review.verified_entity_id IS DISTINCT FROM rv.verified_entity_id)))
       ORDER BY p.profile_version`,
    [scope.ownerUserId, scope.projectId, scope.runId, scope.inputRevision, scope.inputHash]);
  // Ambiguous approved versions do not get resolved by profile recency.
  if (result.rows.length !== 1) return null;
  const row = result.rows[0]!;
  if (row.review_action !== 'approve' || !row.active_profile_grant_id || row.material_deleted ||
      !['audit', 'financial', 'notes'].includes(String(row.role)) || row.response_status !== 'parsed' ||
      String(row.profile_version) !== String(row.reviewed_profile_version) || String(row.profile_sha256).trim() !== String(row.reviewed_profile_sha).trim() ||
      Number(row.input_revision) !== Number(row.reviewed_input_revision) || String(row.input_hash).trim() !== String(row.reviewed_input_hash).trim() ||
      String(row.source_material_sha256).trim() !== String(row.live_material_sha).trim() ||
      String(row.source_material_sha256).trim() !== String(row.reviewed_material_sha).trim() ||
      String(row.parse_snapshot_sha256).trim() !== String(row.live_parse_sha).trim() ||
      String(row.parse_snapshot_sha256).trim() !== String(row.reviewed_parse_sha).trim() ||
      String(row.parse_snapshot_id) !== String(row.latest_parse_id) || String(row.parse_snapshot_sha256).trim() !== String(row.latest_parse_sha).trim() ||
      !row.current_identity_grant_id || row.current_identity_entity !== row.verified_entity_id ||
      Number(row.current_identity_version) !== Number(row.issuer_identity_version) ||
      String(row.current_identity_hash).trim() !== String(row.issuer_identity_hash).trim()) return null;
  const manifest = parseJson(row.manifest);
  const identity = isRecord(manifest) && isRecord(manifest.issuer_identity) ? manifest.issuer_identity : null;
  if (!identity || identity.status !== 'verified' || identity.entity_id !== row.verified_entity_id ||
      identity.record_id !== row.issuer_identity_record_id || Number(identity.version) !== Number(row.issuer_identity_version) ||
      String(identity.content_hash).trim() !== String(row.issuer_identity_hash).trim() ||
      identity.material_id !== row.current_identity_material_id || Number(identity.material_version) !== Number(row.current_identity_material_version) ||
      identity.source_snapshot_id !== row.current_identity_snapshot_id || identity.source_record_id !== row.current_identity_source_record_id ||
      String(identity.source_record_sha256).trim() !== String(row.current_identity_source_record_sha).trim() ||
      String(identity.source_content_sha256).trim() !== String(row.current_identity_source_content_sha).trim() ||
      String(row.issuer_identity_record_id) === '' || !isRecord(row.live_evidence_hashes)) return null;
  let currentIdentity;
  try {
    currentIdentity = await loadVerifiedIssuerIdentitySourceRecord(pool, { ownerUserId: scope.ownerUserId, projectId: scope.projectId,
      materialId: String(identity.material_id), materialVersion: Number(identity.material_version) });
  } catch { return null; }
  if (!currentIdentity || currentIdentity.recordId !== identity.record_id || currentIdentity.version !== Number(identity.version) ||
      currentIdentity.contentHash !== String(identity.content_hash).trim() || currentIdentity.entityId !== identity.entity_id ||
      currentIdentity.sourceSnapshotId !== identity.source_snapshot_id || currentIdentity.sourceRecordId !== identity.source_record_id ||
      currentIdentity.sourceRecordSha256 !== String(identity.source_record_sha256).trim()) return null;
  const stored = mapRow({ ...row, review_status: 'pending_review' }, false);
  const liveHashes = row.live_evidence_hashes as Record<string, unknown>;
  if (Object.entries(stored.evidenceRecordHashes).some(([ref, hash]) => String(liveHashes[ref] ?? '').trim() !== hash)) return null;
  if (!hasLib01AAutoMatchBasis(stored.profile) || stored.annualRevenueProof.thirdPlaceTieProof.status !== 'clear') return null;
  try { validateAnnualRevenueProof(stored.profile, stored.annualRevenueProof); }
  catch { return null; }
  const confirmed = isRecord((manifest as Record<string, unknown>).target_confirmation) ?
    (manifest as Record<string, unknown>).target_confirmation as Record<string, unknown> : null;
  if (!confirmed || confirmed.status !== 'confirmed' || confirmed.confirmed_by !== scope.ownerUserId) return null;
  const periods = Array.isArray(confirmed.target_reporting_periods) ? confirmed.target_reporting_periods : [];
  const annualYears = periods.filter(isRecord).filter(period => period.status === 'user_asserted' && period.period_kind === 'annual' &&
    period.scope === 'consolidated' && typeof period.end === 'string' && /^\d{4}-12-31$/.test(period.end)).map(period => Number(String(period.end).slice(0,4)));
  if (!annualYears.length || stored.profile.fiscalYear !== Math.max(...annualYears)) return null;
  return { ...stored.profile, verificationStatus: 'verified' };
}
