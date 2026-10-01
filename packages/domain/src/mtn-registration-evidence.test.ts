import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkMtnRegistrationEvidence,
  type MtnEvidenceValue,
  type MtnRegistrationEvidenceInput,
  type MtnRegistrationNoticeEvidence,
} from './mtn-registration-evidence.js';

const citation = {
  sourceRefId: 'synthetic:mtn-notice',
  materialVersion: 'synthetic-v1',
  locator: 'page 1, paragraph 1',
  quote: 'Synthetic evidence only; not an actual issuer document.',
};

function ev<T>(value: T, source = citation): MtnEvidenceValue<T> {
  return { value, citations: [{ ...source }], uncertainty: 'clear' };
}

function notice(overrides: Partial<MtnRegistrationNoticeEvidence> = {}): MtnRegistrationNoticeEvidence {
  return {
    noticeId: ev('notice-syn-001'),
    sourceMaterialSha256: ev('a'.repeat(64)),
    issuerEntityId: ev('uscc:synthetic-issuer-001'),
    coveredInstruments: ev(['mtn', 'cp']),
    acceptedDate: ev('2025-10-01'),
    statedExpiryDate: ev('2028-09-30'),
    statedQuota: ev({ status: 'explicitly_not_specified' }),
    statedUsedQuota: ev({ status: 'not_applicable_with_basis' }),
    amendments: ev([]),
    ...overrides,
  };
}

function input(overrides: Partial<MtnRegistrationEvidenceInput> = {}): MtnRegistrationEvidenceInput {
  return {
    actualInstrument: ev('mtn'),
    issuerEntityId: ev('uscc:synthetic-issuer-001'),
    issuerTier: ev('mature_first_class'),
    registrationArrangement: ev('dfi_unified'),
    plannedIssueDate: ev('2026-06-01'),
    proposedAmount: ev({ amount: '10000000000', currency: 'CNY', minorUnitScale: 2 }),
    noticeSetCompleteness: ev('complete_current_set'),
    quotaLedgerCompleteness: ev('not_applicable_with_basis'),
    selectedNotice: ev({ noticeId: 'notice-syn-001', sourceMaterialSha256: 'a'.repeat(64) }),
    transitionBasis: ev('not_applicable_with_basis'),
    notices: [notice()],
    ...overrides,
  };
}

test('a synthetic mature-tier notice with explicit no-quota evidence passes shape only', () => {
  const evidence = input();
  const result = checkMtnRegistrationEvidence(evidence);
  assert.equal(result.decision, 'evidence_shape_pass');
  assert.equal(result.engineeringOnly, true);
  assert.equal(result.evidence, evidence);
});

test('PDFI registration arrangement remains separate from the actual MTN instrument', () => {
  const quotaNotice = notice({
    statedQuota: ev({ status: 'stated', amount: '50000000000', currency: 'CNY', minorUnitScale: 2 }),
    statedUsedQuota: ev({ status: 'stated', amount: '10000000000', currency: 'CNY', minorUnitScale: 2 }),
  });
  const result = checkMtnRegistrationEvidence(input({
    issuerTier: ev('basic_tier'),
    registrationArrangement: ev('pdfi_quota'),
    quotaLedgerCompleteness: ev('complete'),
    notices: [quotaNotice],
  }));
  assert.equal(result.decision, 'evidence_shape_pass');
  assert.equal(result.evidence.actualInstrument.value, 'mtn');
  assert.equal(result.evidence.registrationArrangement.value, 'pdfi_quota');
});

test('quota rules are checked only on the selected notice, not an older non-selected notice', () => {
  const oldNotice = notice({
    noticeId: ev('notice-syn-old-no-quota'),
    sourceMaterialSha256: ev('c'.repeat(64)),
    statedQuota: ev({ status: 'explicitly_not_specified' }),
    statedUsedQuota: ev({ status: 'not_applicable_with_basis' }),
  });
  const currentNotice = notice({
    statedQuota: ev({ status: 'stated', amount: '50000000000', currency: 'CNY', minorUnitScale: 2 }),
    statedUsedQuota: ev({ status: 'stated', amount: '10000000000', currency: 'CNY', minorUnitScale: 2 }),
  });
  const result = checkMtnRegistrationEvidence(input({
    issuerTier: ev('basic_tier'),
    registrationArrangement: ev('basic_tier_unified_quota'),
    quotaLedgerCompleteness: ev('complete'),
    notices: [oldNotice, currentNotice],
  }));
  assert.equal(result.decision, 'evidence_shape_pass');
});

test('selected notice requires a resolved quota state and a resolved used-quota state', () => {
  const unknownQuota = checkMtnRegistrationEvidence(input({
    registrationArrangement: ev('product_by_product'),
    quotaLedgerCompleteness: ev('complete'),
    notices: [notice({
      statedQuota: { value: null, citations: [{ ...citation }], uncertainty: 'clear' },
      statedUsedQuota: ev({ status: 'stated', amount: '100', currency: 'CNY', minorUnitScale: 2 }),
    })],
  }));
  assert.equal(unknownQuota.decision, 'needs_review');
  assert.ok(unknownQuota.reasons.includes('notice_0_quota_state_missing'));

  const unknownUsed = checkMtnRegistrationEvidence(input({
    notices: [notice({ statedUsedQuota: { value: null, citations: [{ ...citation }], uncertainty: 'clear' } })],
  }));
  assert.equal(unknownUsed.decision, 'needs_review');
  assert.ok(unknownUsed.reasons.includes('notice_0_used_quota_state_missing_uncited_or_uncertain'));

  const mismatchedStates = checkMtnRegistrationEvidence(input({
    notices: [notice({
      statedUsedQuota: ev({ status: 'stated', amount: '100', currency: 'CNY', minorUnitScale: 2 }),
    })],
  }));
  assert.equal(mismatchedStates.decision, 'needs_review');
  assert.ok(mismatchedStates.reasons.includes('notice_0_quota_and_usage_state_mismatch'));

  assert.equal(checkMtnRegistrationEvidence(input()).decision, 'evidence_shape_pass');
});

test('missing notice, tier, transition, expiry, or required PDFI quota remains needs_review', () => {
  const noNotice = checkMtnRegistrationEvidence(input({ notices: [] }));
  assert.equal(noNotice.decision, 'needs_review');
  assert.ok(noNotice.reasons.includes('registration_notice_missing'));

  const unknownTier = checkMtnRegistrationEvidence(input({ issuerTier: ev('unknown') }));
  assert.equal(unknownTier.decision, 'needs_review');
  assert.ok(unknownTier.reasons.includes('issuer_tier_unresolved'));

  const unknownTransition = checkMtnRegistrationEvidence(input({ transitionBasis: ev('unknown') }));
  assert.equal(unknownTransition.decision, 'needs_review');
  assert.ok(unknownTransition.reasons.includes('historical_transition_basis_unresolved'));

  const missingExpiry = checkMtnRegistrationEvidence(input({ notices: [notice({
    statedExpiryDate: { value: null, citations: [{ ...citation }], uncertainty: 'clear' },
  })] }));
  assert.equal(missingExpiry.decision, 'needs_review');

  const missingQuotaNotice = notice({
    statedQuota: ev({ status: 'explicitly_not_specified' }),
    statedUsedQuota: ev({ status: 'not_applicable_with_basis' }),
  });
  const missingQuota = checkMtnRegistrationEvidence(input({
    issuerTier: ev('basic_tier'),
    registrationArrangement: ev('pdfi_quota'),
    notices: [missingQuotaNotice],
  }));
  assert.equal(missingQuota.decision, 'needs_review');
  assert.ok(missingQuota.reasons.includes('quota_evidence_missing'));
});

test('an apparent expiry after the planned date needs review if notice changes are not complete', () => {
  const result = checkMtnRegistrationEvidence(input({
    plannedIssueDate: ev('2029-01-01'),
    noticeSetCompleteness: ev('incomplete_or_unknown'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('notice_0_planned_issue_after_expiry_needs_change_review'));
});

test('only a complete current notice set can elevate a planned date beyond expiry to evidence conflict', () => {
  const result = checkMtnRegistrationEvidence(input({ plannedIssueDate: ev('2029-01-01') }));
  assert.equal(result.decision, 'evidence_conflict');
  assert.ok(result.reasons.includes('notice_0_planned_issue_after_expiry_in_complete_set'));
});

test('an expired or out-of-scope non-selected historical notice does not conflict with the selected current notice', () => {
  const historical = notice({
    noticeId: ev('notice-syn-old'),
    sourceMaterialSha256: ev('c'.repeat(64)),
    coveredInstruments: ev(['cp', 'scp']),
    acceptedDate: ev('2020-01-01'),
    statedExpiryDate: ev('2022-01-01'),
  });
  const result = checkMtnRegistrationEvidence(input({ notices: [historical, notice()] }));
  assert.equal(result.decision, 'evidence_shape_pass');
});

test('scope or issuer conflicts are reported only when the evidence is directly located', () => {
  const scopeConflict = checkMtnRegistrationEvidence(input({
    notices: [notice({ coveredInstruments: ev(['cp', 'scp']) })],
  }));
  assert.equal(scopeConflict.decision, 'evidence_conflict');
  assert.ok(scopeConflict.reasons.includes('notice_0_mtn_absent_from_complete_scope'));

  const issuerConflict = checkMtnRegistrationEvidence(input({
    notices: [notice({ issuerEntityId: ev('uscc:synthetic-other-issuer') })],
  }));
  assert.equal(issuerConflict.decision, 'evidence_conflict');
  assert.ok(issuerConflict.reasons.includes('notice_0_issuer_identity_conflict'));

  const emptyScope = checkMtnRegistrationEvidence(input({
    notices: [notice({ coveredInstruments: ev([]) })],
  }));
  assert.equal(emptyScope.decision, 'needs_review');
  assert.ok(emptyScope.reasons.includes('notice_0_instrument_scope_empty'));
});

test('amount beyond apparent balance needs review unless both notice set and quota ledger are complete', () => {
  const quotaNotice = notice({
    statedQuota: ev({ status: 'stated', amount: '200000000000', currency: 'CNY', minorUnitScale: 2 }),
    statedUsedQuota: ev({ status: 'stated', amount: '150000000000', currency: 'CNY', minorUnitScale: 2 }),
  });
  const incompleteLedger = checkMtnRegistrationEvidence(input({
    registrationArrangement: ev('basic_tier_unified_quota'),
    proposedAmount: ev({ amount: '100000000000', currency: 'CNY', minorUnitScale: 2 }),
    quotaLedgerCompleteness: ev('incomplete_or_unknown'),
    notices: [quotaNotice],
  }));
  assert.equal(incompleteLedger.decision, 'needs_review');
  assert.ok(incompleteLedger.reasons.includes('notice_0_proposed_amount_needs_other_notice_or_change_review'));

  const completeLedger = checkMtnRegistrationEvidence(input({
    registrationArrangement: ev('basic_tier_unified_quota'),
    proposedAmount: ev({ amount: '100000000000', currency: 'CNY', minorUnitScale: 2 }),
    quotaLedgerCompleteness: ev('complete'),
    notices: [quotaNotice],
  }));
  assert.equal(completeLedger.decision, 'evidence_conflict');
  assert.ok(completeLedger.reasons.includes('notice_0_proposed_amount_exceeds_complete_ledger'));
});

test('planned date before acceptance and unclear comparison evidence stay needs_review', () => {
  const beforeAcceptance = checkMtnRegistrationEvidence(input({ plannedIssueDate: ev('2025-09-30') }));
  assert.equal(beforeAcceptance.decision, 'needs_review');
  assert.ok(beforeAcceptance.reasons.includes('notice_0_planned_issue_before_acceptance_needs_review'));

  const unclearDate = ev('2029-01-01');
  unclearDate.uncertainty = 'uncertain';
  const unclearComparison = checkMtnRegistrationEvidence(input({ plannedIssueDate: unclearDate }));
  assert.equal(unclearComparison.decision, 'needs_review');
  assert.ok(!unclearComparison.reasons.includes('notice_0_planned_issue_after_expiry_in_complete_set'));

  const quotaNotice = notice({
    statedQuota: ev({ status: 'stated', amount: '200000000000', currency: 'CNY', minorUnitScale: 2 }),
    statedUsedQuota: ev({ status: 'stated', amount: '150000000000', currency: 'CNY', minorUnitScale: 2 }),
  });
  const unclearAmount = ev({ amount: '100000000000', currency: 'CNY', minorUnitScale: 2 });
  unclearAmount.uncertainty = 'uncertain';
  const amountReview = checkMtnRegistrationEvidence(input({
    registrationArrangement: ev('basic_tier_unified_quota'),
    quotaLedgerCompleteness: ev('complete'),
    proposedAmount: unclearAmount,
    notices: [quotaNotice],
  }));
  assert.equal(amountReview.decision, 'needs_review');
  assert.ok(!amountReview.reasons.includes('notice_0_proposed_amount_exceeds_complete_ledger'));
});

test('quota comparisons with a different currency or minor-unit scale need review, never a conflict', () => {
  const quotaNotice = notice({
    statedQuota: ev({ status: 'stated', amount: '200000000000', currency: 'CNY', minorUnitScale: 2 }),
    statedUsedQuota: ev({ status: 'stated', amount: '150000000000', currency: 'CNY', minorUnitScale: 2 }),
  });
  for (const proposedAmount of [
    { amount: '100000000000', currency: 'USD', minorUnitScale: 2 },
    { amount: '100000000000', currency: 'CNY', minorUnitScale: 0 },
  ]) {
    const result = checkMtnRegistrationEvidence(input({
      registrationArrangement: ev('basic_tier_unified_quota'),
      quotaLedgerCompleteness: ev('complete'),
      proposedAmount: ev(proposedAmount),
      notices: [quotaNotice],
    }));
    assert.equal(result.decision, 'needs_review');
    assert.ok(result.reasons.includes('notice_0_proposed_amount_unit_unmatched'));
    assert.ok(!result.reasons.some(reason => reason.includes('amount_exceeds')));
  }
});

test('same notice ID with different original hashes is not merged and needs review', () => {
  const first = notice();
  const second = notice({ sourceMaterialSha256: ev('b'.repeat(64)) });
  const result = checkMtnRegistrationEvidence(input({ notices: [first, second] }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('notice_1_same_notice_id_different_source_hash'));
});
