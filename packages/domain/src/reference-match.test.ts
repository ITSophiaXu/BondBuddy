import assert from 'node:assert/strict';
import test from 'node:test';
import type { Market, Offering } from '@bondbuddy/contracts';
import {
  matchBusinessReferences,
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
    revenueBasis: 'operating_revenue',
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
    'accounting_scope_or_revenue_basis_mismatch', 'reference_profile_fewer_than_three_businesses', 'top_three_business_set_mismatch',
  ].sort());
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
