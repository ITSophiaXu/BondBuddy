import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { LibraryRevenueRankProof } from '@bondbuddy/contracts';
import { assessLibraryRevenueRankProof, libraryProfileContentHash, persistLibraryRevenueRankProof, readLibraryRevenueRankProofDecision } from './library-revenue-proof.js';
import { classifyLibraryVersion, ingestLibraryVersion, markLibraryVersionParsed, registerLibrarySource, reviewLibraryVersion } from './library.js';
import type { PrivateBlobs } from './data.js';
import { isolatedTestDatabase } from './test-database.js';

const connection = await isolatedTestDatabase();
const profile = { id: 'profile-1', profile_version: 1, document_version_id: 'doc-v1', fiscal_year: 2025,
  taxonomy_version: 'tax-1', accounting_scope: 'consolidated', revenue_basis: 'main_business_revenue', currency: 'CNY', unit: 'yuan',
  top3: ['A', 'B', 'C'].map((code, i) => ({ code, label: code, rank: i + 1, revenue: String(300 - i * 100), evidence: ['p1'] })), state: 'published' };
const evidence = (page: number) => [{ document_version_id: 'doc-v1', page, quote: `Synthetic page ${page}` }];
function fixture(): LibraryRevenueRankProof {
  const hash = libraryProfileContentHash(profile);
  return { profile_id: profile.id, profile_version: 1, profile_hash: hash, document_version_id: 'doc-v1', fiscal_year: 2025,
    accounting_scope: 'consolidated', revenue_basis: 'main_business_revenue', currency: 'CNY', unit: 'yuan', denominator: '650', denominator_evidence: evidence(1),
    rows: ['A', 'B', 'C', 'D'].map((code, i) => ({ code, label: code, amount: String([300, 200, 100, 50][i]), currency: 'CNY', unit: 'yuan', evidence: evidence(i + 2) })),
    ranking: { top3_codes: ['A', 'B', 'C'], third_place_tied_codes: [], tie_decision: null },
    classification_review: { reviewer: 'reviewer-1', reviewed_at: '2026-09-28T00:00:00Z', taxonomy_version: 'tax-1',
      profile_id: profile.id, profile_version: 1, profile_hash: hash, decision: 'approved', evidence_complete: true } };
}

test('synthetic full-line proof rejects mismatched denominator, missing page, stale review and stale profile', () => {
  const base = fixture();
  assert.deepEqual(assessLibraryRevenueRankProof(base, profile), { sufficient: true, reasons: [] });
  const denominator = structuredClone(base); denominator.denominator = '600';
  assert.ok(assessLibraryRevenueRankProof(denominator, profile).reasons.includes('denominator_mismatch'));
  const page = structuredClone(base); page.rows[2]!.evidence = [];
  assert.equal(assessLibraryRevenueRankProof(page, profile).sufficient, false);
  const review = structuredClone(base); review.classification_review.profile_version = 2;
  assert.ok(assessLibraryRevenueRankProof(review, profile).reasons.includes('review_version_mismatch'));
  assert.ok(assessLibraryRevenueRankProof(base, { ...profile, profile_version: 2 }).reasons.includes('profile_mismatch'));
  assert.ok(assessLibraryRevenueRankProof(base, { ...profile, state: 'withdrawn' }).reasons.includes('profile_not_published'));
});

test('third-place tie requires a complete reviewed selection and exact excluded roster', () => {
  const proof = fixture(); proof.rows[3]!.amount = '100'; proof.denominator = '700';
  assert.ok(assessLibraryRevenueRankProof(proof, profile).reasons.includes('third_place_tie_unreviewed'));
  proof.ranking.third_place_tied_codes = ['C', 'D'];
  proof.ranking.tie_decision = { selected_code: 'C', excluded_codes: ['D'], reason: 'Synthetic classification review of both tied lines' };
  assert.deepEqual(assessLibraryRevenueRankProof(proof, profile), { sufficient: true, reasons: [] });
  proof.ranking.tie_decision.excluded_codes = ['A'];
  assert.ok(assessLibraryRevenueRankProof(proof, profile).reasons.includes('third_place_tie_unreviewed'));
  proof.rows[1]!.amount = '100'; proof.denominator = '600';
  assert.ok(assessLibraryRevenueRankProof(proof, profile).reasons.includes('third_place_tie_spans_multiple_slots'));
});

test('proof snapshot is persisted, immutable, version-bound and withdrawn profiles become insufficient', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const bytes = new Map<string, Buffer>();
  const blobs: PrivateBlobs = { async put(k, b) { bytes.set(k, b); }, async get(k) { return bytes.get(k)!; }, async getIfExists(k) { return bytes.get(k) ?? null; },
    async getIfExistsBounded(k, max) { const b = bytes.get(k); return b && b.length <= max ? b : null; }, async exists(k) { return bytes.has(k); }, async delete(k) { bytes.delete(k); } };
  try {
    const suffix = randomUUID().slice(0, 8);
    const sourceId = `proof_${suffix}`;
    await registerLibrarySource(pool, { id: sourceId, kind: 'operator_import', displayName: 'Synthetic proof', market: 'sse', authorizationBasis: 'synthetic', usageRights: 'evaluation_only' });
    const doc = await ingestLibraryVersion(pool, blobs, { sourceId, externalKey: 'proof', issuerKey: 'proof', issuerName: 'Synthetic Issuer',
      title: 'Synthetic', sourceRevision: '1', sourceRevisionRank: 1, bytes: Buffer.from('%PDF synthetic'), mediaType: 'application/pdf' });
    await markLibraryVersionParsed(pool, doc.versionId, { synthetic: true });
    await classifyLibraryVersion(pool, doc.versionId, { market: 'sse', offering: 'public', instrument: 'corporate_bond', documentStage: 'issuance' },
      { fiscalYear: 2025, taxonomyVersion: 'tax-1', accountingScope: 'consolidated', revenueBasis: 'main_business_revenue', currency: 'CNY', unit: 'yuan',
        top3: ['A', 'B', 'C'].map((code, i) => ({ code, label: code, rank: i + 1, revenue: String(300 - i * 100), evidence: ['p1'] })) });
    await reviewLibraryVersion(pool, doc.versionId, { action: 'approve', reason: 'synthetic_proof', review_quality: 80 }, 'reviewer-1');
    const saved = (await pool.query('SELECT * FROM bb_library_profiles WHERE document_version_id=$1 AND state=$2', [doc.versionId, 'published'])).rows[0];
    const proof = fixture(); proof.profile_id = saved.id; proof.profile_version = saved.profile_version; proof.document_version_id = doc.versionId;
    proof.rows.forEach(row => row.evidence.forEach(e => { e.document_version_id = doc.versionId; }));
    proof.denominator_evidence.forEach(e => { e.document_version_id = doc.versionId; });
    proof.profile_hash = libraryProfileContentHash(saved);
    Object.assign(proof.classification_review, { profile_id: saved.id, profile_version: saved.profile_version, profile_hash: proof.profile_hash });
    const inserted = await persistLibraryRevenueRankProof(pool, proof);
    assert.equal((await persistLibraryRevenueRankProof(pool, proof)).id, inserted.id);
    assert.deepEqual(await readLibraryRevenueRankProofDecision(pool, saved.id), { sufficient: true, reasons: [] });
    await assert.rejects(pool.query('UPDATE bb_library_revenue_rank_proofs SET proof_hash=$1 WHERE id=$2', ['0'.repeat(64), inserted.id]), /immutable/);
    await assert.rejects(pool.query('DELETE FROM bb_library_revenue_rank_proofs WHERE id=$1', [inserted.id]), /immutable/);
    await reviewLibraryVersion(pool, doc.versionId, { action: 'withdraw', reason: 'synthetic_withdrawal' }, 'reviewer-1');
    assert.ok((await readLibraryRevenueRankProofDecision(pool, saved.id)).reasons.includes('profile_not_published'));
  } finally { await pool.end(); }
});
