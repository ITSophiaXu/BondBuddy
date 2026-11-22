import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { Problem } from '@bondbuddy/api/data';
import {
  LibrarySelectionLockRequestV1_1Schema,
  LibrarySelectionLockSchema,
  LibrarySelectionLockV1_1Schema,
  type LibraryCandidate,
  type LibraryCandidateV1_1,
  type LibraryQueryRequest,
  type LibraryQueryResponse,
  type LibraryQueryResponseV1,
} from '@bondbuddy/contracts';
import type { AnnualBusinessProfile } from '@bondbuddy/domain/reference-match';
import { selectNoHistoryLibraryReference } from './reference-library-selection.js';

const businessCodes = ['chemicals', 'logistics', 'equipment'];
const targetProfile: AnnualBusinessProfile = {
  issuerId: 'issuer-synthetic',
  profileVersion: 'issuer-profile-v1',
  taxonomyVersion: 'bond-business-2026.1',
  fiscalYear: 2025,
  completeAnnualPeriod: true,
  latestCompleteAnnual: true,
  verificationStatus: 'verified',
  accountingScope: 'consolidated',
  revenueBasis: 'main_business_revenue',
  currency: 'CNY',
  unit: 'ten_thousand_yuan',
  allComparableBusinessLinesPresent: true,
  sourceEvidence: ['synthetic:annual-note'],
  lines: [
    {
      code: 'chemicals',
      label: 'Chemicals',
      originalLabel: 'Chemical products',
      revenue: '100',
      rank: 1,
      evidence: ['synthetic:line-1'],
      classificationEvidence: ['synthetic:map-1'],
    },
    {
      code: 'logistics',
      label: 'Logistics',
      originalLabel: 'Logistics services',
      revenue: '60',
      rank: 2,
      evidence: ['synthetic:line-2'],
      classificationEvidence: ['synthetic:map-2'],
    },
    {
      code: 'equipment',
      label: 'Equipment',
      originalLabel: 'Equipment sales',
      revenue: '40',
      rank: 3,
      evidence: ['synthetic:line-3'],
      classificationEvidence: ['synthetic:map-3'],
    },
    {
      code: 'services',
      label: 'Services',
      originalLabel: 'Services',
      revenue: '10',
      rank: 4,
      evidence: ['synthetic:line-4'],
      classificationEvidence: ['synthetic:map-4'],
    },
  ],
};
const target = {
  market: 'sse' as const,
  offering: 'private' as const,
  instrument: 'corporate_bond',
  documentStage: 'issuance' as const,
  ruleVersion: 'rules-v4',
};
const scope = {
  market: target.market,
  offering: target.offering,
  instrument: target.instrument,
  document_stage: target.documentStage,
  rule_version: target.ruleVersion,
};

function candidate(overrides: Partial<LibraryCandidateV1_1> = {}): LibraryCandidateV1_1 {
  return {
    reference_id: 'reference-a',
    document_version_id: 'document-v3',
    document_version: 3,
    profile_id: 'profile-v2',
    profile_version: 2,
    taxonomy_version: 'bond-business-2026.1',
    fiscal_year: 2025,
    market: 'sse',
    offering: 'private',
    instrument: 'corporate_bond',
    document_stage: 'issuance',
    availability: 'published',
    readable: true,
    use_authorized: true,
    source_validity: 'valid',
    applicable_scopes: [scope],
    chapter_mapping_versions: [],
    review_quality: 90,
    disclosed_at: '2025-08-01',
    top3_set_key: JSON.stringify([...businessCodes].sort()),
    comparability: {
      accounting_scope: 'consolidated',
      revenue_basis: 'main_business_revenue',
      currency: 'CNY',
      unit: 'ten_thousand_yuan',
      fiscal_year: 2025,
      attestation: {
        review_id: 'review-v2',
        reviewed_by: 'operator-synthetic',
        reviewed_at: '2026-09-25T00:00:00Z',
        profile_id: 'profile-v2',
        profile_version: 2,
      },
    },
    revenue_rank_proof: {
      profile_id: 'profile-v2',
      profile_version: 2,
      profile_hash: 'a'.repeat(64),
      proof_hash: 'b'.repeat(64),
      sufficient: true,
      reasons: [],
    },
    chapter_mappings: [],
    ...overrides,
  };
}
function response(candidates: LibraryCandidateV1_1[]): LibraryQueryResponse {
  return {
    schema_version: 'reference-library-query-v1.1',
    status: candidates.length ? 'candidates' : 'no_match',
    index_release: { release_id: 'release-12', release_no: 12 },
    candidates,
    reason: candidates.length ? null : 'no_published_exact_set',
  };
}
function input() {
  return {
    ownerUserId: 'owner-synthetic',
    projectId: 'project-synthetic',
    runId: 'run-synthetic',
    traceId: 'trace-synthetic',
    targetProfile,
    target,
    ruleVersion: 'rules-v4',
  };
}
function adapters(result: LibraryQueryResponse) {
  const calls = { query: 0, lock: 0, persist: 0, request: null as LibraryQueryRequest | null };
  return {
    calls,
    deps: {
      query: async (request: LibraryQueryRequest) => {
        calls.query++;
        calls.request = request;
        return result;
      },
      lock: async (lockInput: {
        ownerUserId: string;
        projectId: string;
        runId: string;
        documentVersionId: string;
        profileId: string;
        indexReleaseId: string;
        querySchemaVersion: 'reference-library-query-v1.1';
        documentVersion: number;
        profileVersion: number;
        taxonomyVersion: string;
        candidateScope: { market: string; offering: string; instrument: string };
        targetScope: {
          market: string;
          offering: string;
          instrument: string;
          document_stage: string;
          rule_version: string;
        };
        comparability: NonNullable<LibraryCandidateV1_1['comparability']>;
        chapterMappingVersionId: string | null;
      }) => {
        calls.lock++;
        assert.equal(lockInput.querySchemaVersion, 'reference-library-query-v1.1');
        return {
          lock_id: 'lock-synthetic',
          query_schema_version: 'reference-library-query-v1.1' as const,
          document_version_id: lockInput.documentVersionId,
          profile_id: lockInput.profileId,
          profile_version: lockInput.profileVersion,
          taxonomy_version: lockInput.taxonomyVersion,
          index_release_id: lockInput.indexReleaseId,
          chapter_mapping_version_id: lockInput.chapterMappingVersionId,
          locked_at: '2026-09-25T00:00:00Z',
        };
      },
      persist: async () => {
        calls.persist++;
      },
    },
  };
}

test('selection lock contract keeps v1 shape and requires v1.1 identity and mapping fields', () => {
  const v1 = {
    lock_id: 'lock-v1',
    query_schema_version: 'reference-library-query-v1',
    document_version_id: 'document-v1',
    profile_id: 'profile-v1',
    taxonomy_version: 'taxonomy-v1',
    index_release_id: 'release-v1',
    locked_at: '2026-09-25T00:00:00Z',
  };
  const v11 = {
    ...v1,
    query_schema_version: 'reference-library-query-v1.1',
    profile_version: 2,
    chapter_mapping_version_id: null,
  };
  assert.equal(Value.Check(LibrarySelectionLockSchema, v1), true);
  assert.equal(Value.Check(LibrarySelectionLockSchema, v11), true);
  assert.equal(
    Value.Check(LibrarySelectionLockV1_1Schema, { ...v11, profile_version: undefined }),
    false,
  );
  const reviewed = candidate();
  const request = {
    owner_user_id: 'owner-synthetic',
    project_id: 'project-synthetic',
    run_id: 'run-synthetic',
    query_schema_version: 'reference-library-query-v1.1',
    document_version_id: reviewed.document_version_id,
    document_version: reviewed.document_version,
    profile_id: reviewed.profile_id,
    profile_version: reviewed.profile_version,
    taxonomy_version: reviewed.taxonomy_version,
    index_release_id: 'release-synthetic',
    candidate_scope: {
      market: reviewed.market,
      offering: reviewed.offering,
      instrument: reviewed.instrument,
    },
    target_scope: {
      market: target.market,
      offering: target.offering,
      instrument: target.instrument,
      document_stage: target.documentStage,
      rule_version: target.ruleVersion,
    },
    comparability: reviewed.comparability,
    chapter_mapping_version_id: null,
  };
  assert.equal(Value.Check(LibrarySelectionLockRequestV1_1Schema, request), true);
  assert.equal(
    Value.Check(LibrarySelectionLockRequestV1_1Schema, {
      ...request,
      query_schema_version: 'reference-library-query-v1',
    }),
    false,
  );
});

test('v1.1 proof, comparability, and exact applicability permit the consumer to request a version-pinned lock', async () => {
  const fixture = adapters(response([candidate()]));
  const selected = await selectNoHistoryLibraryReference(input(), fixture.deps);
  assert.equal(selected.status, 'exact');
  assert.equal(selected.selected?.revenue_rank_proof_hash, 'b'.repeat(64));
  assert.equal(selected.target.targetBusinessProfile?.topThree[0]?.rank, 1);
  assert.equal(fixture.calls.request?.schema_version, 'reference-library-query-v1.1');
  assert.deepEqual(fixture.calls.request?.target.top3_codes, businessCodes);
  assert.equal(selected.query_schema_version, 'reference-library-query-v1.1');
  assert.equal(fixture.calls.lock, 1);
  assert.equal(fixture.calls.persist, 1);
});

test('missing, insufficient, or profile-mismatched full-revenue proof remains needs_review and unlocked', async () => {
  const proof = candidate().revenue_rank_proof!;
  const invalidProofs: NonNullable<LibraryCandidateV1_1['revenue_rank_proof']>[] = [
    { ...proof, sufficient: false, proof_hash: null, reasons: ['proof_missing'] },
    { ...proof, profile_id: 'other-profile' },
    { ...proof, proof_hash: null },
  ];
  for (const revenue_rank_proof of invalidProofs) {
    const fixture = adapters(response([candidate({ revenue_rank_proof })]));
    const selected = await selectNoHistoryLibraryReference(input(), fixture.deps);
    assert.equal(selected.status, 'needs_review');
    assert.equal(selected.selected, null);
    assert.equal(fixture.calls.lock, 0);
  }
});

test('a sufficient synthetic proof still cannot lock while production reference acceptance is disabled', async () => {
  const fixture = adapters(response([candidate()]));
  fixture.deps.lock = async () => {
    fixture.calls.lock++;
    throw new Problem(
      409,
      'REFERENCE_COMPLETENESS_REVIEW_REQUIRED',
      'v1.1 reference selection awaits authorized data and business acceptance',
    );
  };
  const selected = await selectNoHistoryLibraryReference(input(), fixture.deps);
  assert.equal(selected.status, 'needs_review');
  assert.equal(selected.selected, null);
  assert.equal(
    selected.candidate_decisions[0]?.reason,
    'candidate_proof_revalidation_or_production_acceptance_pending',
  );
  assert.equal(fixture.calls.lock, 1);
});

test('target or candidate with operating revenue stays pending and never locks', async () => {
  const targetFixture = adapters(response([candidate()]));
  const targetResult = await selectNoHistoryLibraryReference(
    {
      ...input(),
      targetProfile: {
        ...targetProfile,
        revenueBasis: 'operating_revenue',
      },
    },
    targetFixture.deps,
  );
  assert.equal(targetResult.status, 'needs_evidence');
  assert.equal(targetFixture.calls.query, 0);
  assert.equal(targetFixture.calls.lock, 0);

  const operatingCandidate = candidate({
    comparability: {
      ...candidate().comparability!,
      revenue_basis: 'operating_revenue',
    },
  });
  const candidateFixture = adapters(response([operatingCandidate]));
  const candidateResult = await selectNoHistoryLibraryReference(input(), candidateFixture.deps);
  assert.equal(candidateResult.status, 'needs_review');
  assert.equal(candidateResult.selected, null);
  assert.equal(candidateFixture.calls.lock, 0);
});

test('two of three business codes do not match', async () => {
  const partial = candidate({
    top3_set_key: JSON.stringify(['chemicals', 'logistics', 'finance'].sort()),
  });
  const fixture = adapters(response([partial]));
  const selected = await selectNoHistoryLibraryReference(input(), fixture.deps);
  assert.equal(selected.status, 'no_match');
  assert.equal(selected.candidate_decisions[0]?.reason, 'top_three_business_set_mismatch');
  assert.equal(fixture.calls.lock, 0);
});

test('different business ranking is an exact set candidate when its full proof is valid', async () => {
  const fixture = adapters(
    response([
      candidate({ top3_set_key: JSON.stringify(['equipment', 'chemicals', 'logistics'].sort()) }),
    ]),
  );
  const selected = await selectNoHistoryLibraryReference(input(), fixture.deps);
  assert.equal(selected.status, 'exact');
  assert.deepEqual(fixture.calls.request?.target.top3_codes, businessCodes);
  assert.deepEqual(
    selected.target.targetBusinessProfile?.topThree.map((line) => line.code),
    businessCodes,
  );
  assert.equal(fixture.calls.lock, 1);
});

test('missing or mismatched profile-bound comparability stays needs_review without a lock', async () => {
  const missing = candidate({ comparability: null });
  const wrongCurrency = candidate({
    comparability: { ...candidate().comparability!, currency: 'USD' },
  });
  const unboundAttestation = candidate({
    comparability: {
      ...candidate().comparability!,
      attestation: {
        ...candidate().comparability!.attestation,
        profile_id: 'other-profile',
      },
    },
  });
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
  const wrongMarket = candidate({
    market: 'szse',
    applicable_scopes: [scope],
    chapter_mapping_versions: ['mapping-v2'],
  });
  const wrongInstrument = candidate({ instrument: 'cp', applicable_scopes: [scope] });
  const fixture = adapters(response([wrongRule, wrongMarket, wrongInstrument]));
  const selected = await selectNoHistoryLibraryReference(input(), fixture.deps);
  assert.equal(selected.status, 'needs_review');
  assert.deepEqual(
    selected.candidate_decisions.map((decision) => decision.reason).sort(),
    [
      'accepted_chapter_mapping_missing_or_mismatched',
      'reference_instrument_or_stage_mismatch',
      'target_rule_scope_not_applicable',
    ].sort(),
  );
  assert.equal(fixture.calls.lock, 0);
});

test('withdrawn or authorization-limited versions returned as no_match cannot be locked', async () => {
  // The API query filters revoked sources and withdrawn versions before returning candidates.
  const fixture = adapters(response([]));
  const selected = await selectNoHistoryLibraryReference(input(), fixture.deps);
  assert.equal(selected.status, 'no_match');
  assert.equal(fixture.calls.lock, 0);
});

test('an unpublished, withdrawn, or non-commercial candidate that reaches the matcher remains needs_review and unlocked', async () => {
  const invalidCandidates = [
    { ...candidate(), availability: 'withdrawn' },
    { ...candidate(), source_validity: 'withdrawn' },
    { ...candidate(), use_authorized: false },
  ] as unknown as LibraryCandidateV1_1[];
  for (const invalid of invalidCandidates) {
    const fixture = adapters(response([invalid]));
    const selected = await selectNoHistoryLibraryReference(input(), fixture.deps);
    assert.equal(selected.status, 'needs_review');
    assert.equal(selected.selected, null);
    assert.equal(fixture.calls.lock, 0);
  }
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
    reference_id: 'reference-a',
    document_version_id: 'document-v3',
    document_version: 3,
    profile_id: 'profile-v2',
    profile_version: 2,
    taxonomy_version: 'bond-business-2026.1',
    fiscal_year: 2025,
    market: 'sse',
    offering: 'private',
    instrument: 'corporate_bond',
    document_stage: 'issuance',
    availability: 'published',
    readable: true,
    use_authorized: true,
    source_validity: 'valid',
    applicable_scopes: [scope],
    chapter_mapping_versions: [],
    review_quality: 90,
    disclosed_at: '2025-08-01',
    top3_set_key: JSON.stringify([...businessCodes].sort()),
  };
  const legacyResponse: LibraryQueryResponseV1 = {
    schema_version: 'reference-library-query-v1',
    status: 'candidates',
    index_release: { release_id: 'release-12', release_no: 12 },
    candidates: [legacy],
    reason: null,
  };
  const legacyFixture = adapters(legacyResponse);
  assert.equal(
    (await selectNoHistoryLibraryReference(input(), legacyFixture.deps)).status,
    'needs_review',
  );
  assert.equal(legacyFixture.calls.lock, 0);
  const unavailableFixture = adapters({
    schema_version: 'reference-library-query-v1',
    status: 'unavailable',
    index_release: null,
    candidates: [],
    reason: 'library_unavailable',
  });
  assert.equal(
    (await selectNoHistoryLibraryReference(input(), unavailableFixture.deps)).status,
    'unavailable',
  );
  const mismatchFixture = adapters({
    schema_version: 'reference-library-query-v1',
    status: 'index_version_mismatch',
    index_release: { release_id: 'release-13', release_no: 13 },
    candidates: [],
    reason: 'requested_release_not_active',
  });
  assert.equal(
    (await selectNoHistoryLibraryReference(input(), mismatchFixture.deps)).status,
    'index_version_mismatch',
  );
  assert.equal(unavailableFixture.calls.lock + mismatchFixture.calls.lock, 0);
});
