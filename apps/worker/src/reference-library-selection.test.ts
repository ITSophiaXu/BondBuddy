import assert from 'node:assert/strict';
import test from 'node:test';
import type { LibraryCandidate, LibraryCandidateV1_1, LibraryQueryRequest, LibraryQueryResponse, LibraryQueryResponseV1 } from '@bondbuddy/contracts';
import type { AnnualBusinessProfile } from '@bondbuddy/domain/reference-match';
import { selectNoHistoryLibraryReference } from './reference-library-selection.js';

const businessCodes = ['chemicals', 'logistics', 'equipment'];
const targetProfile: AnnualBusinessProfile = {
  issuerId: 'issuer-synthetic', profileVersion: 'issuer-profile-v1', taxonomyVersion: 'bond-business-2026.1', fiscalYear: 2025,
  completeAnnualPeriod: true, latestCompleteAnnual: true, verificationStatus: 'verified', accountingScope: 'consolidated',
  revenueBasis: 'operating_revenue', currency: 'CNY', unit: 'ten_thousand_yuan', allComparableBusinessLinesPresent: true,
  sourceEvidence: ['synthetic:annual-note'],
  lines: [
    { code: 'chemicals', label: 'Chemicals', originalLabel: 'Chemical products', revenue: '100', rank: 1, evidence: ['synthetic:line-1'], classificationEvidence: ['synthetic:map-1'] },
    { code: 'logistics', label: 'Logistics', originalLabel: 'Logistics services', revenue: '60', rank: 2, evidence: ['synthetic:line-2'], classificationEvidence: ['synthetic:map-2'] },
    { code: 'equipment', label: 'Equipment', originalLabel: 'Equipment sales', revenue: '40', rank: 3, evidence: ['synthetic:line-3'], classificationEvidence: ['synthetic:map-3'] },
    { code: 'services', label: 'Services', originalLabel: 'Services', revenue: '10', rank: 4, evidence: ['synthetic:line-4'], classificationEvidence: ['synthetic:map-4'] },
  ],
};
const target = { market: 'sse' as const, offering: 'private' as const, instrument: 'corporate_bond', documentStage: 'issuance' as const, ruleVersion: 'rules-v4' };
const scope = { market: target.market, offering: target.offering, instrument: target.instrument,
  document_stage: target.documentStage, rule_version: target.ruleVersion };

function candidate(overrides: Partial<LibraryCandidateV1_1> = {}): LibraryCandidateV1_1 {
  return {
    reference_id: 'reference-a', document_version_id: 'document-v3', document_version: 3, profile_id: 'profile-v2', profile_version: 2,
    taxonomy_version: 'bond-business-2026.1', fiscal_year: 2025, market: 'sse', offering: 'private', instrument: 'corporate_bond', document_stage: 'issuance',
    availability: 'published', readable: true, use_authorized: true, source_validity: 'valid', applicable_scopes: [scope], chapter_mapping_versions: [],
    review_quality: 90, disclosed_at: '2025-08-01', top3_set_key: JSON.stringify([...businessCodes].sort()),
    comparability: { accounting_scope: 'consolidated', revenue_basis: 'operating_revenue', currency: 'CNY', unit: 'ten_thousand_yuan', fiscal_year: 2025,
      attestation: { review_id: 'review-v2', reviewed_by: 'operator-synthetic', reviewed_at: '2026-09-25T00:00:00Z', profile_id: 'profile-v2', profile_version: 2 } },
    chapter_mappings: [],
    ...overrides,
  };
}
function response(candidates: LibraryCandidateV1_1[]): LibraryQueryResponse {
  return { schema_version: 'reference-library-query-v1.1', status: candidates.length ? 'candidates' : 'no_match',
    index_release: { release_id: 'release-12', release_no: 12 }, candidates, reason: candidates.length ? null : 'no_published_exact_set' };
}
function input() {
  return { ownerUserId: 'owner-synthetic', projectId: 'project-synthetic', runId: 'run-synthetic', traceId: 'trace-synthetic',
    targetProfile, target, ruleVersion: 'rules-v4' };
}
function adapters(result: LibraryQueryResponse) {
  const calls = { query: 0, lock: 0, persist: 0, request: null as LibraryQueryRequest | null };
  return {
    calls,
    deps: {
      query: async (request: LibraryQueryRequest) => { calls.query++; calls.request = request; return result; },
      lock: async (lockInput: { ownerUserId: string; projectId: string; runId: string; documentVersionId: string; profileId: string; indexReleaseId: string }) => {
        calls.lock++;
        assert.deepEqual(lockInput, { ownerUserId: 'owner-synthetic', projectId: 'project-synthetic', runId: 'run-synthetic',
          documentVersionId: 'document-v3', profileId: 'profile-v2', indexReleaseId: 'release-12' });
        return { lock_id: 'lock-synthetic', query_schema_version: 'reference-library-query-v1' as const, document_version_id: lockInput.documentVersionId,
          profile_id: lockInput.profileId, taxonomy_version: 'bond-business-2026.1', index_release_id: lockInput.indexReleaseId, locked_at: '2026-09-25T00:00:00Z' };
      },
      persist: async () => { calls.persist++; },
    },
  };
}

test('v1.1 validates comparability but waits for source completeness and tie proof before locking', async () => {
  const fixture = adapters(response([candidate()]));
  const selected = await selectNoHistoryLibraryReference(input(), fixture.deps);
  assert.equal(selected.status, 'needs_review');
  assert.equal(selected.selected, null);
  assert.equal(selected.target.targetBusinessProfile?.topThree[0]?.rank, 1);
  assert.equal(fixture.calls.request?.schema_version, 'reference-library-query-v1.1');
  assert.deepEqual(fixture.calls.request?.target.top3_codes, businessCodes);
  assert.equal(selected.query_schema_version, 'reference-library-query-v1.1');
  assert.equal(selected.candidate_decisions[0]?.reason, 'candidate_business_profile_completeness_or_tie_proof_missing');
  assert.equal(fixture.calls.lock, 0);
  assert.equal(fixture.calls.persist, 1);
});

test('two of three business codes do not match', async () => {
  const partial = candidate({ top3_set_key: JSON.stringify(['chemicals', 'logistics', 'finance'].sort()) });
  const fixture = adapters(response([partial]));
  const selected = await selectNoHistoryLibraryReference(input(), fixture.deps);
  assert.equal(selected.status, 'no_match');
  assert.equal(selected.candidate_decisions[0]?.reason, 'top_three_business_set_mismatch');
  assert.equal(fixture.calls.lock, 0);
});

test('different business ranking remains an exact set candidate but cannot skip source profile review', async () => {
  const fixture = adapters(response([candidate({ top3_set_key: JSON.stringify(['equipment', 'chemicals', 'logistics'].sort()) })]));
  const selected = await selectNoHistoryLibraryReference(input(), fixture.deps);
  assert.equal(selected.status, 'needs_review');
  assert.deepEqual(fixture.calls.request?.target.top3_codes, businessCodes);
  assert.equal(selected.candidate_decisions[0]?.reason, 'candidate_business_profile_completeness_or_tie_proof_missing');
  assert.deepEqual(selected.target.targetBusinessProfile?.topThree.map(line => line.code), businessCodes);
  assert.equal(fixture.calls.lock, 0);
});

test('missing or mismatched profile-bound comparability stays needs_review without a lock', async () => {
  const missing = candidate({ comparability: null });
  const wrongCurrency = candidate({ comparability: { ...candidate().comparability!, currency: 'USD' } });
  const unboundAttestation = candidate({ comparability: { ...candidate().comparability!, attestation: {
    ...candidate().comparability!.attestation, profile_id: 'other-profile',
  } } });
  for (const c of [missing, wrongCurrency, unboundAttestation]) {
    const fixture = adapters(response([c]));
    const selected = await selectNoHistoryLibraryReference(input(), fixture.deps);
    assert.equal(selected.status, 'needs_review');
    assert.equal(selected.selected, null);
    assert.equal(fixture.calls.lock, 0);
  }
});

test('wrong rule, market, or instrument candidates are excluded', async () => {
  const wrongRule = candidate({ applicable_scopes: [{ ...scope, rule_version: 'rules-v3' }] });
  const wrongMarket = candidate({ market: 'szse', applicable_scopes: [scope], chapter_mapping_versions: ['mapping-v2'] });
  const wrongInstrument = candidate({ instrument: 'cp', applicable_scopes: [scope] });
  const fixture = adapters(response([wrongRule, wrongMarket, wrongInstrument]));
  const selected = await selectNoHistoryLibraryReference(input(), fixture.deps);
  assert.equal(selected.status, 'needs_review');
  assert.deepEqual(selected.candidate_decisions.map(decision => decision.reason).sort(), [
    'accepted_chapter_mapping_missing_or_mismatched', 'reference_instrument_or_stage_mismatch', 'target_rule_scope_not_applicable',
  ].sort());
  assert.equal(fixture.calls.lock, 0);
});

test('withdrawn or authorization-limited versions returned as no_match cannot be locked', async () => {
  // The API query filters revoked sources and withdrawn versions before returning candidates.
  const fixture = adapters(response([]));
  const selected = await selectNoHistoryLibraryReference(input(), fixture.deps);
  assert.equal(selected.status, 'no_match');
  assert.equal(fixture.calls.lock, 0);
});

test('empty library produces an explicit no_match and durable bounded result', async () => {
  const fixture = adapters(response([]));
  const selected = await selectNoHistoryLibraryReference(input(), fixture.deps);
  assert.equal(selected.status, 'no_match');
  assert.equal(selected.selected, null);
  assert.equal(fixture.calls.persist, 1);
});

test('legacy v1 responses remain fail-closed and v1 outage or stale releases remain explicit', async () => {
  const legacy: LibraryCandidate = {
    reference_id: 'reference-a', document_version_id: 'document-v3', document_version: 3, profile_id: 'profile-v2', profile_version: 2,
    taxonomy_version: 'bond-business-2026.1', fiscal_year: 2025, market: 'sse', offering: 'private', instrument: 'corporate_bond', document_stage: 'issuance',
    availability: 'published', readable: true, use_authorized: true, source_validity: 'valid', applicable_scopes: [scope], chapter_mapping_versions: [],
    review_quality: 90, disclosed_at: '2025-08-01', top3_set_key: JSON.stringify([...businessCodes].sort()),
  };
  const legacyResponse: LibraryQueryResponseV1 = { schema_version: 'reference-library-query-v1', status: 'candidates',
    index_release: { release_id: 'release-12', release_no: 12 }, candidates: [legacy], reason: null };
  const legacyFixture = adapters(legacyResponse);
  assert.equal((await selectNoHistoryLibraryReference(input(), legacyFixture.deps)).status, 'needs_review');
  assert.equal(legacyFixture.calls.lock, 0);
  const unavailableFixture = adapters({ schema_version: 'reference-library-query-v1', status: 'unavailable', index_release: null, candidates: [], reason: 'library_unavailable' });
  assert.equal((await selectNoHistoryLibraryReference(input(), unavailableFixture.deps)).status, 'unavailable');
  const mismatchFixture = adapters({ schema_version: 'reference-library-query-v1', status: 'index_version_mismatch',
    index_release: { release_id: 'release-13', release_no: 13 }, candidates: [], reason: 'requested_release_not_active' });
  assert.equal((await selectNoHistoryLibraryReference(input(), mismatchFixture.deps)).status, 'index_version_mismatch');
  assert.equal(unavailableFixture.calls.lock + mismatchFixture.calls.lock, 0);
});
