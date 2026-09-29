import { createHash } from 'node:crypto';
import { factIdentityKey, type FactIdentity } from '@bondbuddy/domain/facts';
import { updateContentHash } from '@bondbuddy/domain/historical-update';
import type { StoredFactCandidate } from './fact-repository.js';
import { readFactEvidenceReviewDetermination, type FactEvidenceReviewDetermination,
  type FactEvidenceReviewPin, type FactEvidenceReviewSeamDependencies } from './fact-evidence-review-seam.js';

export interface HistoricalFactReviewScope {
  ownerUserId: string; projectId: string; inputRevision: number; inputHash: string;
}
export interface HistoricalFactReviewEntry {
  candidateId: string;
  hasRecordedReview: boolean;
  /** Missing evidence is frozen as missing; recovery never selects a later set. */
  pin: FactEvidenceReviewPin | null;
  determination: FactEvidenceReviewDetermination | null;
}
export interface HistoricalFactReviews {
  version: 'historical-fact-reviews-v1';
  entries: HistoricalFactReviewEntry[];
}
const validHash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function invalid(): never { throw new Error('UPDATE_FACT_EVIDENCE_CONTEXT_MISMATCH'); }
function changed(): never { throw new Error('UPDATE_FACT_EVIDENCE_REVIEW_CHANGED'); }
const identityHash = (identity: FactIdentity) => createHash('sha256').update(factIdentityKey(identity)).digest('hex');

function contextPin(row: Record<string, unknown>, scope: HistoricalFactReviewScope, fact: StoredFactCandidate): FactEvidenceReviewPin {
  const m = row.manifest;
  if (!record(m)) invalid();
  const { evidence_set_sha256: sha, ...body } = m;
  const source = fact.candidate.source.kind;
  if (typeof row.id !== 'string' || !row.id || !validHash(sha) || sha !== row.evidence_set_sha256 ||
      updateContentHash(body) !== sha || m.schema_version !== 'fact-evidence-context-v1' ||
      m.owner_user_id !== scope.ownerUserId || m.project_id !== scope.projectId ||
      m.input_revision !== scope.inputRevision || m.input_hash !== scope.inputHash ||
      m.candidate_id !== fact.candidate.candidateId || m.candidate_identity_sha256 !== identityHash(fact.candidate.identity) ||
      !record(m.fact_identity) || updateContentHash(m.fact_identity) !== updateContentHash(fact.candidate.identity) ||
      (source !== 'audited' && source !== 'external') || m.source_kind !== source ||
      m.material_id !== fact.provenance.materialId || m.material_version !== fact.provenance.materialVersion ||
      !validHash(m.material_sha256) || !fact.provenance.evidence.length ||
      fact.provenance.evidence.some(a => a.material_id !== m.material_id || a.material_version !== m.material_version || a.content_hash !== m.material_sha256) ||
      typeof m.snapshot_id !== 'string' || !m.snapshot_id || typeof m.parser_version !== 'string' || !m.parser_version.trim() ||
      !validHash(m.parse_response_sha256) || !['complete', 'incomplete'].includes(String(m.completeness_status)) ||
      m.reviewable !== (m.completeness_status === 'complete')) invalid();
  return { candidateId: fact.candidate.candidateId, evidenceContextSetId: row.id, evidenceSetSha256: sha,
    candidateIdentitySha256: m.candidate_identity_sha256 as string, sourceKind: source,
    inputRevision: scope.inputRevision, inputHash: scope.inputHash, materialId: fact.provenance.materialId,
    materialVersion: fact.provenance.materialVersion, materialSha256: m.material_sha256,
    snapshotId: m.snapshot_id, parserVersion: m.parser_version, parseResponseSha256: m.parse_response_sha256 };
}

/** Read #15's existing sets and review seam, never create a review or change candidate state. */
export async function readHistoricalFactReviews(
  dependencies: FactEvidenceReviewSeamDependencies,
  scope: HistoricalFactReviewScope,
  facts: readonly StoredFactCandidate[],
  previous?: HistoricalFactReviews,
): Promise<HistoricalFactReviews> {
  if (!scope.ownerUserId || !scope.projectId || !Number.isSafeInteger(scope.inputRevision) || scope.inputRevision < 1 ||
      !validHash(scope.inputHash) || facts.some(f => f.candidate.identity.accountId !== scope.ownerUserId)) invalid();
  const selected = facts.filter(f => ['audited', 'external'].includes(f.candidate.source.kind))
    .slice().sort((a,b) => a.candidate.candidateId.localeCompare(b.candidate.candidateId, 'en'));
  const ids = selected.map(f => f.candidate.candidateId);
  if (new Set(ids).size !== ids.length) invalid();
  if (previous && (previous.version !== 'historical-fact-reviews-v1' || !Array.isArray(previous.entries) ||
      previous.entries.some(e => !record(e) || typeof e.candidateId !== 'string' || typeof e.hasRecordedReview !== 'boolean' ||
        (e.pin !== null && !record(e.pin)) || (e.determination !== null && !record(e.determination)) ||
        (e.pin === null && (e.determination !== null || e.hasRecordedReview))) ||
      updateContentHash(previous.entries.map(e => e.candidateId)) !== updateContentHash(ids))) changed();
  const contextIds = previous?.entries.flatMap(e => e.pin ? [e.pin.evidenceContextSetId] : []);
  // First preparation chooses the latest persisted exact-input set. Replay queries only frozen IDs,
  // including preserving an explicit absence. #15's current-review view checks source invalidation.
  const rows = ids.length && (!previous || contextIds!.length) ? (await dependencies.pool.query(
    `SELECT DISTINCT ON (c.candidate_id) c.id,c.candidate_id,c.evidence_set_sha256,c.manifest,
              EXISTS (SELECT 1 FROM bb_fact_evidence_reviews r WHERE r.owner_user_id=c.owner_user_id
                AND r.project_id=c.project_id AND r.candidate_id=c.candidate_id
                AND r.input_revision=c.input_revision AND r.input_hash=c.input_hash) AS has_recorded_review
       FROM bb_fact_evidence_context_sets c
      WHERE c.owner_user_id=$1 AND c.project_id=$2 AND c.candidate_id=ANY($3::text[])
        AND c.input_revision=$4 AND c.input_hash=$5
        ${previous ? 'AND c.id=ANY($6::text[])' : ''}
      ORDER BY c.candidate_id,c.created_at DESC,c.id DESC`,
    [scope.ownerUserId,scope.projectId,ids,scope.inputRevision,scope.inputHash,...(previous ? [contextIds] : [])])).rows : [];
  if (rows.some(r => !ids.includes(String(r.candidate_id))) || new Set(rows.map(r => r.candidate_id)).size !== rows.length) invalid();
  const entries: HistoricalFactReviewEntry[] = [];
  for (const fact of selected) {
    const prior = previous?.entries.find(e => e.candidateId === fact.candidate.candidateId);
    if (prior && (prior.pin === null) !== (prior.determination === null)) changed();
    const row = rows.find(r => r.candidate_id === fact.candidate.candidateId);
    if (prior && !prior.pin) { if (row) changed(); entries.push(structuredClone(prior)); continue; }
    if (!row) { if (prior?.pin) changed(); entries.push({ candidateId: fact.candidate.candidateId, hasRecordedReview: false, pin: null, determination: null }); continue; }
    if (typeof row.has_recorded_review !== 'boolean') invalid();
    const pin = contextPin(row, scope, fact);
    if (prior && updateContentHash(prior.pin) !== updateContentHash(pin)) changed();
    const determination = await readFactEvidenceReviewDetermination(dependencies, scope, pin);
    if (determination.reviewId !== null && !row.has_recorded_review) invalid();
    const entry = { candidateId: fact.candidate.candidateId, hasRecordedReview: row.has_recorded_review, pin, determination };
    if (prior && updateContentHash(prior) !== updateContentHash(entry)) changed();
    entries.push(entry);
  }
  return { version: 'historical-fact-reviews-v1', entries };
}

/** An evidence review can restrict existing eligibility, never manufacture it. In particular,
 * externalImpactReviewed is not audited eligibility and a missing review is not an upload gate. */
export function historicalReviewAllowsExistingFact(reviews: HistoricalFactReviews | undefined, candidateId: string): boolean {
  if (!reviews) return true; // Legacy checkpoints retain their original model binding.
  const entry = reviews.entries.find(e => e.candidateId === candidateId);
  if (!entry) return false;
  const d = entry.determination;
  return !d || (!entry.hasRecordedReview && d.reason === 'no_current_exact_review' && d.reviewId === null) ||
    (d.reviewedAndCurrent && (d.offerable || d.externalImpactReviewed));
}
