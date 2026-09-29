import type { FactEvidenceReviewResponse } from '@bondbuddy/contracts';

/**
 * #15 derived seam for the #31 historical-update consumer.
 *
 * This module does not review evidence and does not change any candidate. It only answers one
 * question for an exact run/input/material/parse/candidate/evidence-context pin: is there a
 * currently valid `fact_evidence_reviewer` decision for that exact scope, and what may a consumer
 * derive from it? The review is a separate appended decision, so the original candidate warning,
 * confidence, uncertainty, source kind and status stay untouched. An `external` review can only
 * certify "evidence and impact reviewed"; it is never promotable to `audited`.
 *
 * Fail-closed behavior is inherited from `bb_current_fact_evidence_reviews` (input/material/parse
 * drift, grant revocation, withdrawal) and tightened here: a review counts only when it pins the
 * exact run scope, and only while its evidence context set is still the latest set for the
 * candidate. A `needs_more_evidence` outcome is never reported as reviewed.
 */

export const FACT_EVIDENCE_REVIEW_SEAM_VERSION = 'fact-evidence-review-seam-v1' as const;

export interface FactEvidenceReviewSeamPool {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface FactEvidenceReviewSeamDependencies {
  readonly pool: FactEvidenceReviewSeamPool;
}

/** Trusted worker/run scope. Owner and project come from the authenticated run, never request JSON. */
export interface FactEvidenceReviewScope {
  readonly ownerUserId: string;
  readonly projectId: string;
}

/**
 * Exact immutable pins an update run already holds. The seam never widens or recomputes them; a
 * review is accepted only when every pin equals the reviewed row.
 */
export interface FactEvidenceReviewPin {
  readonly candidateId: string;
  readonly evidenceContextSetId: string;
  readonly evidenceSetSha256: string;
  readonly candidateIdentitySha256: string;
  readonly sourceKind: 'audited' | 'external';
  readonly inputRevision: number;
  readonly inputHash: string;
  readonly materialId: string;
  readonly materialVersion: number;
  readonly materialSha256: string;
  readonly snapshotId: string;
  readonly parserVersion: string;
  readonly parseResponseSha256: string;
}

/** A validated row of the fail-closed `bb_current_fact_evidence_reviews` projection. */
export interface FactEvidenceReviewSeamRow {
  readonly reviewId: string;
  readonly outcome: FactEvidenceReviewResponse['outcome'];
  readonly candidateId: string;
  readonly evidenceContextSetId: string;
  readonly evidenceSetSha256: string;
  readonly candidateIdentitySha256: string;
  readonly sourceKind: 'audited' | 'external';
  readonly inputRevision: number;
  readonly inputHash: string;
  readonly materialId: string;
  readonly materialVersion: number;
  readonly materialSha256: string;
  readonly snapshotId: string;
  readonly parserVersion: string;
  readonly parseResponseSha256: string;
  readonly reviewerUserId: string;
  readonly reviewerGrantId: string;
  readonly reviewedAt: string;
}

export type FactEvidenceReviewReason =
  | 'review_current'
  | 'external_impact_reviewed'
  | 'review_needs_more_evidence'
  | 'no_current_exact_review'
  | 'review_pin_mismatch';

export interface FactEvidenceReviewDetermination {
  readonly schemaVersion: typeof FACT_EVIDENCE_REVIEW_SEAM_VERSION;
  /** An exact, currently valid reviewed outcome exists for this pin. `needs_more_evidence` is not reviewed. */
  readonly reviewedAndCurrent: boolean;
  /** Audited source whose exact evidence impact outcome is `evidence_impact_reviewed`. */
  readonly offerable: boolean;
  /** External source: evidence and impact reviewed, still external and never promotable to audited. */
  readonly externalImpactReviewed: boolean;
  readonly outcome: FactEvidenceReviewResponse['outcome'] | null;
  readonly sourceKind: 'audited' | 'external' | null;
  readonly reason: FactEvidenceReviewReason;
  readonly reviewId: string | null;
  readonly reviewerUserId: string | null;
  readonly reviewerGrantId: string | null;
  readonly reviewedAt: string | null;
  readonly evidenceContextSetId: string;
  readonly evidenceSetSha256: string;
  /** The seam and the ledger never mutate the source candidate; consumers keep original fields. */
  readonly verificationEffect: 'none';
  readonly originalFieldsPreserved: true;
}

export class FactEvidenceReviewSeamError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'FactEvidenceReviewSeamError';
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const OUTCOMES: readonly FactEvidenceReviewResponse['outcome'][] = [
  'evidence_impact_reviewed', 'external_evidence_impact_reviewed', 'needs_more_evidence',
];

function fail(code: string): never {
  throw new FactEvidenceReviewSeamError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateScope(scope: FactEvidenceReviewScope): void {
  if (!IDENTIFIER.test(scope.ownerUserId) || !IDENTIFIER.test(scope.projectId)) fail('FACT_EVIDENCE_REVIEW_SEAM_INVALID_SCOPE');
}

function validatePin(pin: FactEvidenceReviewPin): void {
  if (!IDENTIFIER.test(pin.candidateId) || !IDENTIFIER.test(pin.evidenceContextSetId) ||
    !SHA256.test(pin.evidenceSetSha256) || !SHA256.test(pin.candidateIdentitySha256) ||
    (pin.sourceKind !== 'audited' && pin.sourceKind !== 'external') ||
    !Number.isSafeInteger(pin.inputRevision) || pin.inputRevision < 1 || !SHA256.test(pin.inputHash) ||
    !IDENTIFIER.test(pin.materialId) || !Number.isSafeInteger(pin.materialVersion) || pin.materialVersion < 1 ||
    !SHA256.test(pin.materialSha256) || !IDENTIFIER.test(pin.snapshotId) ||
    !pin.parserVersion.trim() || !SHA256.test(pin.parseResponseSha256)) {
    fail('FACT_EVIDENCE_REVIEW_SEAM_INVALID_PIN');
  }
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) fail('FACT_EVIDENCE_REVIEW_SEAM_ROW_INVALID');
  return date.toISOString();
}

function mapRow(row: Record<string, unknown>): FactEvidenceReviewSeamRow {
  const sourceKind = row.source_kind;
  if ((sourceKind !== 'audited' && sourceKind !== 'external') || !OUTCOMES.includes(row.outcome as FactEvidenceReviewResponse['outcome']) ||
    typeof row.review_id !== 'string' || typeof row.candidate_id !== 'string' || typeof row.evidence_context_set_id !== 'string' ||
    typeof row.evidence_set_sha256 !== 'string' || typeof row.candidate_identity_sha256 !== 'string' ||
    typeof row.input_hash !== 'string' || typeof row.material_id !== 'string' || typeof row.material_sha256 !== 'string' ||
    typeof row.snapshot_id !== 'string' || typeof row.parser_version !== 'string' || typeof row.parse_response_sha256 !== 'string' ||
    typeof row.reviewer_user_id !== 'string' || typeof row.reviewer_grant_id !== 'string' ||
    !Number.isSafeInteger(Number(row.input_revision)) || !Number.isSafeInteger(Number(row.material_version)) ||
    !Number.isFinite(new Date(String(row.reviewed_at)).getTime())) {
    fail('FACT_EVIDENCE_REVIEW_SEAM_ROW_INVALID');
  }
  return {
    reviewId: row.review_id,
    outcome: row.outcome as FactEvidenceReviewResponse['outcome'],
    candidateId: row.candidate_id,
    evidenceContextSetId: row.evidence_context_set_id,
    evidenceSetSha256: String(row.evidence_set_sha256).trim(),
    candidateIdentitySha256: String(row.candidate_identity_sha256).trim(),
    sourceKind,
    inputRevision: Number(row.input_revision),
    inputHash: String(row.input_hash).trim(),
    materialId: row.material_id,
    materialVersion: Number(row.material_version),
    materialSha256: String(row.material_sha256).trim(),
    snapshotId: row.snapshot_id,
    parserVersion: row.parser_version,
    parseResponseSha256: String(row.parse_response_sha256).trim(),
    reviewerUserId: row.reviewer_user_id,
    reviewerGrantId: row.reviewer_grant_id,
    reviewedAt: iso(row.reviewed_at),
  };
}

function pinsMatch(row: FactEvidenceReviewSeamRow, pin: FactEvidenceReviewPin): boolean {
  return row.candidateId === pin.candidateId &&
    row.evidenceContextSetId === pin.evidenceContextSetId &&
    row.evidenceSetSha256 === pin.evidenceSetSha256 &&
    row.candidateIdentitySha256 === pin.candidateIdentitySha256 &&
    row.sourceKind === pin.sourceKind &&
    row.inputRevision === pin.inputRevision &&
    row.inputHash === pin.inputHash &&
    row.materialId === pin.materialId &&
    row.materialVersion === pin.materialVersion &&
    row.materialSha256 === pin.materialSha256 &&
    row.snapshotId === pin.snapshotId &&
    row.parserVersion === pin.parserVersion &&
    row.parseResponseSha256 === pin.parseResponseSha256;
}

/**
 * Pure derivation from an already fail-closed review row to the consumer verdict. It never reads or
 * writes candidate state, so original warning/confidence/status survive by construction.
 */
export function deriveFactEvidenceReviewDetermination(
  row: FactEvidenceReviewSeamRow | null,
  pin: FactEvidenceReviewPin,
): FactEvidenceReviewDetermination {
  const base = {
    schemaVersion: FACT_EVIDENCE_REVIEW_SEAM_VERSION,
    evidenceContextSetId: pin.evidenceContextSetId,
    evidenceSetSha256: pin.evidenceSetSha256,
    verificationEffect: 'none' as const,
    originalFieldsPreserved: true as const,
  };
  if (!row) {
    return { ...base, reviewedAndCurrent: false, offerable: false, externalImpactReviewed: false,
      outcome: null, sourceKind: null, reason: 'no_current_exact_review',
      reviewId: null, reviewerUserId: null, reviewerGrantId: null, reviewedAt: null };
  }
  const provenance = { reviewId: row.reviewId, reviewerUserId: row.reviewerUserId,
    reviewerGrantId: row.reviewerGrantId, reviewedAt: row.reviewedAt };
  if (!pinsMatch(row, pin) || (row.outcome === 'evidence_impact_reviewed' && row.sourceKind !== 'audited') ||
    (row.outcome === 'external_evidence_impact_reviewed' && row.sourceKind !== 'external')) {
    return { ...base, ...provenance, reviewedAndCurrent: false, offerable: false, externalImpactReviewed: false,
      outcome: row.outcome, sourceKind: row.sourceKind, reason: 'review_pin_mismatch' };
  }
  if (row.outcome === 'needs_more_evidence') {
    return { ...base, ...provenance, reviewedAndCurrent: false, offerable: false, externalImpactReviewed: false,
      outcome: row.outcome, sourceKind: row.sourceKind, reason: 'review_needs_more_evidence' };
  }
  if (row.sourceKind === 'external') {
    return { ...base, ...provenance, reviewedAndCurrent: true, offerable: false, externalImpactReviewed: true,
      outcome: row.outcome, sourceKind: 'external', reason: 'external_impact_reviewed' };
  }
  return { ...base, ...provenance, reviewedAndCurrent: true, offerable: true, externalImpactReviewed: false,
    outcome: row.outcome, sourceKind: 'audited', reason: 'review_current' };
}

const SEAM_COLUMNS = `r.id AS review_id, r.outcome, r.candidate_id, r.evidence_context_set_id, r.evidence_set_sha256,
 r.candidate_identity_sha256, r.source_kind, r.input_revision, r.input_hash, r.material_id, r.material_version, r.material_sha256,
 r.snapshot_id, r.parser_version, r.parse_response_sha256, r.reviewer_user_id, r.reviewer_grant_id, r.reviewed_at`;

// The fail-closed view already excludes input/material/parse drift, grant revocation and withdrawal.
// The extra NOT EXISTS closes the remaining case: a later evidence context set for the same candidate
// means the pinned set is no longer the latest evidence, so its review must not be offered.
const CURRENT_REVIEW_SQL = `SELECT ${SEAM_COLUMNS}
  FROM bb_current_fact_evidence_reviews r
  WHERE r.owner_user_id=$1 AND r.project_id=$2 AND r.candidate_id=$3
    AND r.evidence_context_set_id=$4 AND r.evidence_set_sha256=$5
    AND NOT EXISTS (
      SELECT 1 FROM bb_fact_evidence_context_sets newer
       JOIN bb_fact_evidence_context_sets pinned
         ON pinned.owner_user_id=r.owner_user_id AND pinned.project_id=r.project_id AND pinned.id=r.evidence_context_set_id
       WHERE newer.owner_user_id=r.owner_user_id AND newer.project_id=r.project_id AND newer.candidate_id=r.candidate_id
         AND (newer.created_at,newer.id)>(pinned.created_at,pinned.id))
  LIMIT 2`;

async function readOne(
  dependencies: FactEvidenceReviewSeamDependencies,
  scope: FactEvidenceReviewScope,
  pin: FactEvidenceReviewPin,
): Promise<FactEvidenceReviewSeamRow | null> {
  const result = await dependencies.pool.query(CURRENT_REVIEW_SQL,
    [scope.ownerUserId, scope.projectId, pin.candidateId, pin.evidenceContextSetId, pin.evidenceSetSha256]);
  if (result.rows.length > 1) fail('FACT_EVIDENCE_REVIEW_SEAM_AMBIGUOUS');
  return result.rows.length === 1 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

/**
 * Reads the currently valid, exactly pinned reviewer decision for one candidate/evidence-context
 * set and derives the consumer verdict. It never mutates the ledger or the candidate.
 */
export async function readFactEvidenceReviewDetermination(
  dependencies: FactEvidenceReviewSeamDependencies,
  scope: FactEvidenceReviewScope,
  pin: FactEvidenceReviewPin,
): Promise<FactEvidenceReviewDetermination> {
  validateScope(scope);
  validatePin(pin);
  return deriveFactEvidenceReviewDetermination(await readOne(dependencies, scope, pin), pin);
}

/**
 * Batch convenience for a run that already holds many pins. Reads are independent and owner-scoped;
 * the order of results matches the input order.
 */
export async function readFactEvidenceReviewDeterminations(
  dependencies: FactEvidenceReviewSeamDependencies,
  scope: FactEvidenceReviewScope,
  pins: readonly FactEvidenceReviewPin[],
): Promise<readonly FactEvidenceReviewDetermination[]> {
  validateScope(scope);
  const results: FactEvidenceReviewDetermination[] = [];
  for (const pin of pins) {
    validatePin(pin);
    results.push(deriveFactEvidenceReviewDetermination(await readOne(dependencies, scope, pin), pin));
  }
  return results;
}
