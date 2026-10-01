import { createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import type { Pool, PoolClient } from 'pg';
import { LibraryRevenueRankProofSchema, type LibraryRevenueRankProof } from '@bondbuddy/contracts';
import { Problem, transaction, uid } from './data.js';

export const LIBRARY_V11_PRODUCTION_LOCK_ENABLED = false;

type Profile = {
  id: string; profile_version: number; document_version_id: string; fiscal_year: number | null;
  taxonomy_version: string; accounting_scope: string; revenue_basis: string | null;
  currency: string | null; unit: string | null; top3: Array<{ code: string; revenue: string; rank: number }> | null;
  state: string;
};

const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
    : JSON.stringify(value);
const sha256 = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const libraryRevenueRankProofHash = (proof: LibraryRevenueRankProof): string => sha256(proof);

/** The hash covers the immutable financial and classification content, not mutable publication state. */
export function libraryProfileContentHash(profile: Profile): string {
  return sha256({ id: profile.id, profile_version: profile.profile_version, document_version_id: profile.document_version_id,
    fiscal_year: profile.fiscal_year, taxonomy_version: profile.taxonomy_version, accounting_scope: profile.accounting_scope,
    revenue_basis: profile.revenue_basis, currency: profile.currency, unit: profile.unit, top3: profile.top3 });
}

function decimal(value: string, scale: number): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0') || '0');
}

/** Pure proof decision. All amounts use exact base-10 arithmetic and a full, same-unit row universe. */
export function assessLibraryRevenueRankProof(proof: LibraryRevenueRankProof, profile: Profile): { sufficient: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!Value.Check(LibraryRevenueRankProofSchema, proof)) return { sufficient: false, reasons: ['schema_invalid'] };
  if (profile.state !== 'published') reasons.push('profile_not_published');
  if (proof.profile_id !== profile.id || proof.profile_version !== profile.profile_version
    || proof.profile_hash !== libraryProfileContentHash(profile) || proof.document_version_id !== profile.document_version_id
    || proof.fiscal_year !== profile.fiscal_year || proof.currency !== profile.currency || proof.unit !== profile.unit
    || profile.taxonomy_version !== proof.classification_review.taxonomy_version
    || profile.accounting_scope !== 'consolidated' || profile.revenue_basis !== 'main_business_revenue') reasons.push('profile_mismatch');
  const review = proof.classification_review;
  if (review.profile_id !== proof.profile_id || review.profile_version !== proof.profile_version || review.profile_hash !== proof.profile_hash) reasons.push('review_version_mismatch');
  if (proof.rows.some(r => r.currency !== proof.currency || r.unit !== proof.unit || !r.evidence.length
    || r.evidence.some(e => !e.document_version_id || e.page < 1 || !e.quote.trim()))
    || proof.denominator_evidence.some(e => !e.document_version_id || e.page < 1 || !e.quote.trim())) reasons.push('page_evidence_missing');
  const codes = proof.rows.map(r => r.code);
  if (new Set(codes).size !== codes.length) reasons.push('duplicate_business');
  const scale = Math.max(...[proof.denominator, ...proof.rows.map(r => r.amount)].map(v => v.split('.')[1]?.length ?? 0));
  const amounts = proof.rows.map(r => decimal(r.amount, scale));
  if (amounts.some(a => a <= 0n) || decimal(proof.denominator, scale) <= 0n
    || amounts.reduce((a, b) => a + b, 0n) !== decimal(proof.denominator, scale)) reasons.push('denominator_mismatch');
  const ranked = proof.rows.map((row, i) => ({ code: row.code, amount: amounts[i]! }))
    .sort((a, b) => a.amount === b.amount ? a.code.localeCompare(b.code) : a.amount > b.amount ? -1 : 1);
  const thirdAmount = ranked[2]!.amount;
  const tied = ranked.filter(r => r.amount === thirdAmount).map(r => r.code).sort();
  const boundaryTie = ranked.length > 3 && ranked[3]!.amount === thirdAmount;
  if (boundaryTie && ranked[1]!.amount === thirdAmount) reasons.push('third_place_tie_spans_multiple_slots');
  const selected = boundaryTie ? proof.ranking.tie_decision?.selected_code : ranked[2]!.code;
  const expected = [ranked[0]!.code, ranked[1]!.code, selected];
  if (boundaryTie) {
    const decision = proof.ranking.tie_decision;
    if (!decision || !selected || !tied.includes(selected) || !decision.reason.trim()
      || canonical([...decision.excluded_codes].sort()) !== canonical(tied.filter(c => c !== selected))) reasons.push('third_place_tie_unreviewed');
  } else if (proof.ranking.tie_decision !== null) reasons.push('unexpected_tie_decision');
  if (canonical([...proof.ranking.third_place_tied_codes].sort()) !== canonical(boundaryTie ? tied : [])) reasons.push('tie_roster_mismatch');
  if (canonical(proof.ranking.top3_codes) !== canonical(expected)
    || !profile.top3 || canonical(profile.top3.map(r => r.code)) !== canonical(expected)
    || profile.top3.some((r, i) => r.rank !== i + 1 || r.revenue !== proof.rows.find(p => p.code === r.code)?.amount)) reasons.push('ranking_mismatch');
  return { sufficient: reasons.length === 0, reasons };
}

/** Trusted service entry point; no user-facing route. The database trigger retains this exact snapshot. */
export async function persistLibraryRevenueRankProof(pool: Pool, proof: LibraryRevenueRankProof) {
  if (!Value.Check(LibraryRevenueRankProofSchema, proof)) throw new Problem(422, 'VALIDATION_FAILED', 'Invalid revenue rank proof');
  return transaction(pool, async client => {
    const profile = (await client.query('SELECT * FROM bb_library_profiles WHERE id=$1 FOR SHARE', [proof.profile_id])).rows[0] as Profile | undefined;
    if (!profile) throw new Problem(404, 'NOT_FOUND', 'Profile not found');
    const decision = assessLibraryRevenueRankProof(proof, profile);
    if (!decision.sufficient) throw new Problem(422, 'VALIDATION_FAILED', `Revenue rank proof insufficient: ${decision.reasons.join(',')}`);
    const evidenceVersionIds = [...new Set([...proof.denominator_evidence, ...proof.rows.flatMap(row => row.evidence)].map(e => e.document_version_id))];
    const evidenceVersions = await client.query('SELECT id FROM bb_library_document_versions WHERE id = ANY($1::text[])', [evidenceVersionIds]);
    if (evidenceVersions.rowCount !== evidenceVersionIds.length) throw new Problem(422, 'VALIDATION_FAILED', 'Revenue proof references a missing evidence document version');
    const proofHash = libraryRevenueRankProofHash(proof);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`library-revenue-proof:${proof.profile_id}`]);
    const existing = (await client.query('SELECT id, proof_hash FROM bb_library_revenue_rank_proofs WHERE profile_id=$1 AND profile_version=$2', [proof.profile_id, proof.profile_version])).rows[0];
    if (existing) {
      if (existing.proof_hash !== proofHash) throw new Problem(409, 'ALREADY_TERMINAL', 'Profile version already has a different proof');
      return { id: existing.id as string, proof_hash: proofHash };
    }
    const id = uid();
    await client.query(`INSERT INTO bb_library_revenue_rank_proofs(id,profile_id,profile_version,profile_hash,proof_hash,proof)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [id, proof.profile_id, proof.profile_version, proof.profile_hash, proofHash, JSON.stringify(proof)]);
    return { id, proof_hash: proofHash };
  });
}

export async function readLibraryRevenueRankProofDecision(pool: Pool | PoolClient, profileId: string) {
  const row = (await pool.query(`SELECT p.*, r.proof, r.proof_hash FROM bb_library_profiles p
    LEFT JOIN bb_library_revenue_rank_proofs r ON r.profile_id=p.id AND r.profile_version=p.profile_version
    WHERE p.id=$1`, [profileId])).rows[0];
  if (!row || !row.proof) return { sufficient: false, reasons: ['proof_missing'], profile_id: profileId,
    profile_version: Number(row?.profile_version ?? 1), profile_hash: null, proof_hash: null };
  if (libraryRevenueRankProofHash(row.proof as LibraryRevenueRankProof) !== row.proof_hash) return { sufficient: false, reasons: ['proof_hash_mismatch'], profile_id: profileId,
    profile_version: Number(row.profile_version), profile_hash: null, proof_hash: null };
  const decision = assessLibraryRevenueRankProof(row.proof as LibraryRevenueRankProof, row as Profile);
  return { ...decision, profile_id: profileId, profile_version: Number(row.profile_version),
    profile_hash: (row.proof as LibraryRevenueRankProof).profile_hash, proof_hash: decision.sufficient ? row.proof_hash as string : null };
}
