import assert from 'node:assert/strict';
import test from 'node:test';
import type { LibraryCandidateV1_1, LibraryQueryResponseV1, LibraryQueryResponseV1_1, Market, Offering } from '@bondbuddy/contracts';
import {
  matchBusinessReferences,
  matchLibraryQuery,
  type AnnualBusinessProfile,
  type ReferenceCandidate,
  type ReferenceMatchInput,
} from './reference-match.js';

const syntheticEvidence = ['synthetic:annual-report:business-note:1'];

function line(code: string, label: string, revenue: string, rank: number, evidence = syntheticEvidence) {
  return {
    code, label, originalLabel: `Raw ${label}`, revenue, rank, evidence,
    classificationEvidence: [`synthetic:taxonomy-review:${rank}`],
  };
}

function profile(issuerId: string, overrides: Partial<AnnualBusinessProfile> = {}): AnnualBusinessProfile {
  return {
    issuerId,
    profileVersion: 'profile-v1',
    taxonomyVersion: 'bond-business-2026.1',
    fiscalYear: 2025,
    completeAnnualPeriod: true,
    latestCompleteAnnual: true,
    verificationStatus: 'verified',
    accountingScope: 'consolidated',
    revenueBasis: 'main_business_revenue',
    currency: 'CNY',
    unit: 'CNY 10,000',
    allComparableBusinessLinesPresent: true,
    sourceEvidence: syntheticEvidence,
    lines: [
      line('chemicals', 'Synthetic chemicals', '100.00', 1),
      line('logistics', 'Synthetic logistics', '60', 2),
      line('equipment', 'Synthetic equipment', '40.0', 3),
      line('services', 'Synthetic services', '10', 4),
    ],
    ...overrides,
  };
}

function candidate(referenceId: string, overrides: Partial<ReferenceCandidate> = {}): ReferenceCandidate {
  const target = { market: 'sse' as Market, offering: 'private' as Offering, instrument: 'corporate_bond', documentStage: 'issuance' as const };
  return {
    referenceId,
    documentVersion: 'document-v1',
    profile: profile(`reference-issuer-${referenceId}`),
    ...target,
    availability: 'published',
    readable: true,
    useAuthorized: true,
    sourceValidity: 'valid',
    reviewQuality: 3,
    disclosedAt: '2025-06-01',
    applicableScopes: [{ ...target, ruleVersion: 'rules-v4' }],
    chapterMappings: [],
    ...overrides,
  };
}

function input(overrides: Partial<ReferenceMatchInput> = {}): ReferenceMatchInput {
  return {
    targetProfile: profile('issuer-123'),
    target: { market: 'sse', offering: 'private', instrument: 'corporate_bond', documentStage: 'issuance', ruleVersion: 'rules-v4' },
    ruleVersion: 'rules-v4',
    referenceIndexVersion: 'index-v11',
    libraryAvailable: true,
    candidates: [candidate('ref-a')],
    ...overrides,
  };
}

test('matches exact three-code set when income rank order differs', () => {
  const result = matchBusinessReferences(input({
    candidates: [candidate('ref-a', { profile: profile('ref-issuer', { lines: [
      line('equipment', 'Synthetic equipment', '100', 1),
      line('chemicals', 'Synthetic chemicals', '60', 2),
      line('logistics', 'Synthetic logistics', '40', 3),
      line('services', 'Synthetic services', '10', 4),
    ] }) })],
  }));
  assert.equal(result.status, 'exact');
  assert.equal(result.selectedReferenceId, 'ref-a');
  assert.equal(result.snapshot.targetTop3SetKey, '["chemicals","equipment","logistics"]');
  assert.equal(result.snapshot.selectedProfileVersion, 'profile-v1');
  assert.equal(result.snapshot.targetBusinessProfile?.currency, 'CNY');
  assert.equal(result.snapshot.targetBusinessProfile?.unit, 'CNY 10,000');
  assert.equal(result.snapshot.targetBusinessProfile?.topThree[0]?.rank, 1);
  assert.equal(result.snapshot.targetBusinessProfile?.topThree[0]?.originalLabel, 'Raw Synthetic chemicals');
  assert.deepEqual(result.snapshot.targetBusinessProfile?.topThree[0]?.evidence, syntheticEvidence);
  assert.equal(JSON.stringify(result).includes('reference-issuer-ref-a'), false);
});

test('does not match only two codes, broader overlap, or an accounting basis mismatch', () => {
  const onlyTwo = candidate('only-two', { profile: profile('ref', { lines: [
    line('chemicals', 'Synthetic chemicals', '100', 1),
    line('logistics', 'Synthetic logistics', '60', 2),
  ] }) });
  const wrongSet = candidate('wrong-set', { profile: profile('ref2', { lines: [
    line('chemicals', 'Synthetic chemicals', '100', 1),
    line('logistics', 'Synthetic logistics', '60', 2),
    line('finance', 'Synthetic finance', '40', 3),
  ] }) });
  const wrongBasis = candidate('wrong-basis', { profile: profile('ref3', { revenueBasis: 'parent_only_operating_revenue' }) });
  const result = matchBusinessReferences(input({ candidates: [onlyTwo, wrongSet, wrongBasis] }));
  assert.equal(result.status, 'needs_review');
  assert.equal(result.selectedReferenceId, null);
  assert.deepEqual(result.decisions.map((decision) => decision.reason).sort(), [
    'reference_profile_revenue_basis_not_main_business_revenue', 'reference_profile_fewer_than_three_businesses', 'top_three_business_set_mismatch',
  ].sort());
});

test('LIB-01A requires consolidated main-business revenue on both profiles, even when other bases match', () => {
  const target = profile('issuer-123');
  const operatingTarget = profile('issuer-123', { revenueBasis: 'operating_revenue' });
  const operatingCandidate = candidate('operating-candidate', { profile: profile('reference-issuer', { revenueBasis: 'operating_revenue' }) });
  const bothOperating = matchBusinessReferences(input({ targetProfile: operatingTarget, candidates: [operatingCandidate] }));
  assert.equal(bothOperating.status, 'needs_evidence');
  assert.equal(bothOperating.selectedReferenceId, null);
  assert.deepEqual(bothOperating.reasons, ['profile_revenue_basis_not_main_business_revenue']);

  const candidateOnlyOperating = matchBusinessReferences(input({ targetProfile: target, candidates: [operatingCandidate] }));
  assert.equal(candidateOnlyOperating.status, 'needs_review');
  assert.equal(candidateOnlyOperating.selectedReferenceId, null);
  assert.equal(candidateOnlyOperating.decisions[0]?.reason, 'reference_profile_revenue_basis_not_main_business_revenue');

  for (const scope of ['parent', 'mixed', 'unknown'] as const) {
    const targetResult = matchBusinessReferences(input({ targetProfile: profile(`issuer-${scope}`, { accountingScope: scope }) }));
    assert.notEqual(targetResult.status, 'exact');
    assert.equal(targetResult.selectedReferenceId, null);
    const result = matchBusinessReferences(input({ candidates: [candidate(`scope-${scope}`, {
      profile: profile(`reference-${scope}`, { accountingScope: scope }),
    })] }));
    assert.notEqual(result.status, 'exact');
    assert.equal(result.selectedReferenceId, null);
  }
});

test('business-set key cannot collide when a taxonomy code contains a delimiter', () => {
  const targetProfile = profile('issuer-123', { lines: [
    line('a|b', 'A and B', '30', 1), line('c', 'C', '20', 2), line('d', 'D', '10', 3),
  ] });
  const reference = candidate('delimiter-reference', { profile: profile('reference-issuer', { lines: [
    line('a', 'A', '30', 1), line('b|c', 'B and C', '20', 2), line('d', 'D', '10', 3),
  ] }) });
  const matched = matchBusinessReferences(input({ targetProfile, candidates: [reference] }));
  assert.equal(matched.status, 'no_match');
  assert.equal(matched.decisions[0]?.reason, 'top_three_business_set_mismatch');
});

test('ambiguous third rank and incomplete evidence remain explicit pending outcomes', () => {
  const tie = profile('issuer-123', { lines: [
    line('chemicals', 'Synthetic chemicals', '100', 1),
    line('logistics', 'Synthetic logistics', '60', 2),
    line('equipment', 'Synthetic equipment', '40.0', 3),
    line('services', 'Synthetic services', '40.00', 4),
  ] });
  const tieResult = matchBusinessReferences(input({ targetProfile: tie }));
  assert.equal(tieResult.status, 'needs_review');
  assert.deepEqual(tieResult.reasons, ['third_place_revenue_tie']);

  const missingEvidence = profile('issuer-123', { lines: [
    line('chemicals', 'Synthetic chemicals', '100', 1, []),
    ...profile('issuer-123').lines.slice(1),
  ] });
  const evidenceResult = matchBusinessReferences(input({ targetProfile: missingEvidence }));
  assert.equal(evidenceResult.status, 'needs_evidence');
  assert.deepEqual(evidenceResult.reasons, ['profile_line_evidence_or_classification_missing']);
});

test('unverified or non-latest target profiles cannot start automatic matching', () => {
  const unverified = matchBusinessReferences(input({ targetProfile: profile('issuer-123', { verificationStatus: 'pending' }) }));
  assert.equal(unverified.status, 'needs_evidence');
  assert.equal(unverified.selectedReferenceId, null);
  const notLatest = matchBusinessReferences(input({ targetProfile: profile('issuer-123', { latestCompleteAnnual: false }) }));
  assert.equal(notLatest.status, 'needs_evidence');
});

test('empty target income table is an explicit evidence gap, not a sort-time exception', () => {
  const result = matchBusinessReferences(input({ targetProfile: profile('issuer-123', { lines: [] }) }));
  assert.equal(result.status, 'needs_evidence');
  assert.deepEqual(result.reasons, ['profile_lines_missing']);
  assert.equal(result.selectedReferenceId, null);
});

test('different taxonomy versions are excluded for review instead of being treated as equivalent', () => {
  const result = matchBusinessReferences(input({ candidates: [candidate('old-taxonomy', {
    profile: profile('reference-issuer', { taxonomyVersion: 'bond-business-2025.4' }),
  })] }));
  assert.equal(result.status, 'needs_review');
  assert.equal(result.decisions[0]?.reason, 'taxonomy_version_mismatch');
});

test('unpublished, unauthorized, withdrawn, superseded, unreadable, or invalid-source candidates cannot win', () => {
  const candidates = [
    candidate('pending', { availability: 'pending' }),
    candidate('withdrawn', { availability: 'withdrawn' }),
    candidate('superseded', { availability: 'superseded' }),
    candidate('unauthorized', { useAuthorized: false }),
    candidate('unreadable', { readable: false }),
    candidate('invalid-source', { sourceValidity: 'unknown' }),
  ];
  const result = matchBusinessReferences(input({ candidates }));
  assert.equal(result.status, 'no_match');
  assert.equal(result.selectedReferenceId, null);
  assert.equal(result.decisions.length, candidates.length);
});

test('target rule applicability is mandatory; a cross-market candidate also needs accepted mapping', () => {
  const szse = { ...candidate('szse-ref', {
    market: 'szse',
    applicableScopes: [{ market: 'sse', offering: 'private', instrument: 'corporate_bond', documentStage: 'issuance', ruleVersion: 'rules-v4' }],
  }) };
  const noMap = matchBusinessReferences(input({ candidates: [szse] }));
  assert.equal(noMap.status, 'no_match');
  assert.equal(noMap.decisions[0]?.reason, 'cross_market_chapter_mapping_not_accepted');

  const accepted = candidate('szse-ref', {
    market: 'szse',
    applicableScopes: [{ market: 'sse', offering: 'private', instrument: 'corporate_bond', documentStage: 'issuance', ruleVersion: 'rules-v4' }],
    chapterMappings: [{ status: 'accepted', version: 'mapping-v2', sourceMarket: 'szse', targetMarket: 'sse', sourceOffering: 'private', targetOffering: 'private', instrument: 'corporate_bond', documentStage: 'issuance', ruleVersion: 'rules-v4' }],
  });
  const cross = matchBusinessReferences(input({ candidates: [accepted] }));
  assert.equal(cross.status, 'exact');
  assert.equal(cross.snapshot.chapterMappingVersion, 'mapping-v2');

  const wrongRules = matchBusinessReferences(input({ candidates: [candidate('wrong-rules', {
    applicableScopes: [{ market: 'sse', offering: 'private', instrument: 'corporate_bond', documentStage: 'issuance', ruleVersion: 'rules-v3' }],
  })] }));
  assert.equal(wrongRules.status, 'no_match');
  assert.equal(wrongRules.decisions[0]?.reason, 'target_rule_scope_not_applicable');
});

test('a same-market public reference needs accepted mapping before private use', () => {
  const publicSource = candidate('public-ref', { offering: 'public' });
  const blocked = matchBusinessReferences(input({ candidates: [publicSource] }));
  assert.equal(blocked.status, 'no_match');
  assert.equal(blocked.decisions[0]?.reason, 'cross_offering_chapter_mapping_not_accepted');

  const mapped = candidate('public-ref', {
    offering: 'public',
    chapterMappings: [{
      status: 'accepted', version: 'same-market-offering-v1',
      sourceMarket: 'sse', targetMarket: 'sse', sourceOffering: 'public', targetOffering: 'private',
      instrument: 'corporate_bond', documentStage: 'issuance', ruleVersion: 'rules-v4',
    }],
  });
  const accepted = matchBusinessReferences(input({ candidates: [mapped] }));
  assert.equal(accepted.status, 'exact');
  assert.equal(accepted.snapshot.chapterMappingVersion, 'same-market-offering-v1');
});

test('a target rule scope cannot relabel a different source instrument or document stage', () => {
  const wrongInstrument = candidate('cp-source', { instrument: 'cp' });
  const wrongStage = candidate('registration-source', { documentStage: 'registration' });
  const result = matchBusinessReferences(input({ candidates: [wrongInstrument, wrongStage] }));
  assert.equal(result.status, 'no_match');
  assert.equal(result.selectedReferenceId, null);
  assert.deepEqual(result.decisions.map((decision) => decision.reason), [
    'reference_instrument_or_stage_mismatch',
    'reference_instrument_or_stage_mismatch',
  ]);
});

test('prefers exact scope, then newest disclosure, then stable reference ID', () => {
  const lessExact = candidate('aaa', { market: 'szse', chapterMappings: [{ status: 'accepted', version: 'mapping-v1', sourceMarket: 'szse', targetMarket: 'sse', sourceOffering: 'private', targetOffering: 'private', instrument: 'corporate_bond', documentStage: 'issuance', ruleVersion: 'rules-v4' }] });
  const newer = candidate('bbb', { disclosedAt: '2025-09-01' });
  const olderId = candidate('ccc', { disclosedAt: '2025-09-01' });
  const result = matchBusinessReferences(input({ candidates: [olderId, lessExact, newer] }));
  assert.equal(result.selectedReferenceId, 'bbb');
  assert.equal(result.decisions.find((decision) => decision.referenceId === 'ccc')?.reason, 'exact_business_set_usable_but_lower_stable_preference');
});

test('selection hash is reproducible, versioned, and changes with the index version', () => {
  const first = candidate('first');
  const second = candidate('second');
  const resultA = matchBusinessReferences(input({ candidates: [first, second] }));
  const resultB = matchBusinessReferences(input({ candidates: [second, first] }));
  assert.match(resultA.selectionHash, /^[a-f0-9]{64}$/);
  assert.equal(resultA.selectionHash, resultB.selectionHash);
  assert.equal(resultA.snapshot.schemaVersion, 'reference-selection-v1');
  const newIndex = matchBusinessReferences(input({ candidates: [first, second], referenceIndexVersion: 'index-v12' }));
  assert.notEqual(resultA.selectionHash, newIndex.selectionHash);
});

test('same reference ID across document versions has exactly one selected decision', () => {
  const v1 = candidate('same-ref', { documentVersion: 'document-v1', disclosedAt: '2025-01-01' });
  const v2 = candidate('same-ref', { documentVersion: 'document-v2', disclosedAt: '2025-09-01' });
  const resultA = matchBusinessReferences(input({ candidates: [v1, v2] }));
  const resultB = matchBusinessReferences(input({ candidates: [v2, v1] }));
  const selected = resultA.decisions.filter((decision) => decision.reason === 'exact_business_set_and_target_scope_selected');
  assert.equal(resultA.selectedReferenceId, 'same-ref');
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.documentVersion, 'document-v2');
  assert.deepEqual(resultA.decisions, resultB.decisions);
  assert.equal(resultA.selectionHash, resultB.selectionHash);
});

test('distinguishes absent library and genuinely empty match set', () => {
  assert.equal(matchBusinessReferences(input({ libraryAvailable: false })).status, 'unavailable');
  assert.equal(matchBusinessReferences(input({ candidates: [] })).status, 'no_match');
});

function libraryCandidateV11(overrides: Partial<LibraryCandidateV1_1> = {}): LibraryCandidateV1_1 {
  return {
    reference_id: 'library-ref', document_version_id: 'document-v2', document_version: 2,
    profile_id: 'library-profile-v2', profile_version: 2, taxonomy_version: 'bond-business-2026.1', fiscal_year: 2025,
    market: 'sse', offering: 'private', instrument: 'corporate_bond', document_stage: 'issuance',
    availability: 'published', readable: true, use_authorized: true, source_validity: 'valid',
    applicable_scopes: [{ market: 'sse', offering: 'private', instrument: 'corporate_bond', document_stage: 'issuance', rule_version: 'rules-v4' }],
    chapter_mapping_versions: [], review_quality: 90, disclosed_at: '2025-08-01',
    top3_set_key: '["chemicals","equipment","logistics"]',
    comparability: { accounting_scope: 'consolidated', revenue_basis: 'main_business_revenue', currency: 'CNY', unit: 'ten_thousand_yuan', fiscal_year: 2025,
      attestation: { review_id: 'review-v2', reviewed_by: 'operator-synthetic', reviewed_at: '2026-09-25T00:00:00Z', profile_id: 'library-profile-v2', profile_version: 2 } },
    revenue_rank_proof: { profile_id: 'library-profile-v2', profile_version: 2, profile_hash: 'a'.repeat(64), proof_hash: 'b'.repeat(64), sufficient: true, reasons: [] },
    chapter_mappings: [],
    ...overrides,
  };
}

function libraryResponseV11(candidates: LibraryCandidateV1_1[]): LibraryQueryResponseV1_1 {
  return { schema_version: 'reference-library-query-v1.1', status: 'candidates',
    index_release: { release_id: 'library-index-v5', release_no: 5 }, candidates, reason: null };
}

test('v1.1 requires exact comparability, audit attestation, and a version-bound full-ranking proof', () => {
  const targetProfile = profile('issuer-123', { unit: 'ten_thousand_yuan' });
  const validCandidate = libraryCandidateV11();
  const matched = matchLibraryQuery({ targetProfile, target: input().target, ruleVersion: 'rules-v4', response: libraryResponseV11([validCandidate]) });
  assert.equal(matched.status, 'exact');
  assert.equal(matched.selected, validCandidate);

  for (const candidateWithBadFacts of [
    libraryCandidateV11({ comparability: null }),
    libraryCandidateV11({ comparability: { ...validCandidate.comparability!, currency: 'USD' } }),
    libraryCandidateV11({ comparability: { ...validCandidate.comparability!, revenue_basis: 'operating_revenue' } }),
    libraryCandidateV11({ comparability: { ...validCandidate.comparability!, unit: 'yuan' } }),
    libraryCandidateV11({ comparability: { ...validCandidate.comparability!, fiscal_year: 2024 } }),
    libraryCandidateV11({ comparability: { ...validCandidate.comparability!, accounting_scope: 'parent' } }),
    libraryCandidateV11({ comparability: { ...validCandidate.comparability!, attestation: {
      ...validCandidate.comparability!.attestation, profile_version: 1,
    } } }),
    libraryCandidateV11({ revenue_rank_proof: { ...validCandidate.revenue_rank_proof!, sufficient: false, proof_hash: null, reasons: ['third_place_tie_unreviewed'] } }),
    libraryCandidateV11({ revenue_rank_proof: { ...validCandidate.revenue_rank_proof!, profile_version: 1 } }),
  ]) {
    const result = matchLibraryQuery({ targetProfile, target: input().target, ruleVersion: 'rules-v4', response: libraryResponseV11([candidateWithBadFacts]) });
    assert.equal(result.status, 'needs_review');
    assert.equal(result.selected, null);
    assert.notEqual(result.decisions[0]?.reason, 'exact_business_set_and_target_scope_selected');
  }
});

test('v1.1 cross-scope chapter mapping must exactly bind source and target; v1 responses remain unchanged', () => {
  const targetProfile = profile('issuer-123', { unit: 'ten_thousand_yuan' });
  const crossScope = libraryCandidateV11({ market: 'szse', chapter_mapping_versions: ['map-version-3'],
    chapter_mappings: [{ mapping_version_id: 'map-version-3', mapping_key: 'szse-to-sse-private', version: 3, status: 'accepted',
      source: { market: 'szse', offering: 'private', instrument: 'corporate_bond' },
      target: { market: 'sse', offering: 'private', instrument: 'corporate_bond' }, document_stage: 'issuance', rule_version: 'rules-v4' }] });
  const accepted = matchLibraryQuery({ targetProfile, target: input().target, ruleVersion: 'rules-v4', response: libraryResponseV11([crossScope]) });
  assert.equal(accepted.status, 'exact');
  assert.equal(accepted.selected, crossScope);
  const wrongSource = libraryCandidateV11({ market: 'szse', chapter_mapping_versions: ['map-version-3'],
    chapter_mappings: [{ ...crossScope.chapter_mappings[0]!, source: { market: 'sse', offering: 'private', instrument: 'corporate_bond' } }] });
  const rejected = matchLibraryQuery({ targetProfile, target: input().target, ruleVersion: 'rules-v4', response: libraryResponseV11([wrongSource]) });
  assert.equal(rejected.status, 'needs_review');
  assert.equal(rejected.decisions[0]?.reason, 'accepted_chapter_mapping_missing_or_mismatched');

  const legacyCandidate: LibraryQueryResponseV1['candidates'][number] = {
    reference_id: 'legacy-ref', document_version_id: 'document-v1', document_version: 1,
    profile_id: 'legacy-profile', profile_version: 1, taxonomy_version: 'bond-business-2026.1', fiscal_year: 2025,
    market: 'sse', offering: 'private', instrument: 'corporate_bond', document_stage: 'issuance',
    availability: 'published', readable: true, use_authorized: true, source_validity: 'valid',
    applicable_scopes: [{ market: 'sse', offering: 'private', instrument: 'corporate_bond', document_stage: 'issuance', rule_version: 'rules-v4' }],
    chapter_mapping_versions: [], review_quality: 90, disclosed_at: null, top3_set_key: '["chemicals","equipment","logistics"]',
  };
  const legacy: LibraryQueryResponseV1 = { schema_version: 'reference-library-query-v1', status: 'candidates',
    index_release: { release_id: 'library-index-v5', release_no: 5 }, candidates: [legacyCandidate], reason: null };
  const oldResult = matchLibraryQuery({ targetProfile, target: input().target, ruleVersion: 'rules-v4', response: legacy });
  assert.equal(oldResult.status, 'needs_review');
  assert.equal(oldResult.decisions[0]?.reason, 'candidate_revenue_basis_not_exposed_by_query_v1');

  const legacyCrossScope: LibraryQueryResponseV1 = { ...legacy, candidates: [
    { ...legacyCandidate, reference_id: 'legacy-cross-market', market: 'szse' },
    { ...legacyCandidate, reference_id: 'legacy-cross-offering', offering: 'public' },
  ] };
  const oldCrossScopeResult = matchLibraryQuery({ targetProfile, target: input().target, ruleVersion: 'rules-v4', response: legacyCrossScope });
  assert.equal(oldCrossScopeResult.status, 'no_match');
  assert.deepEqual(oldCrossScopeResult.decisions.map(decision => decision.reason), [
    'cross_market_or_offering_mapping_details_missing', 'cross_market_or_offering_mapping_details_missing',
  ]);
});
