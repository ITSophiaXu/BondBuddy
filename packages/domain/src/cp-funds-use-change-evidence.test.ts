import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkCpFundsUseChangeEvidence,
  type CpFundsUseChangeEvidenceInput,
  type CpFundsUseChangeEvidenceValue,
} from './cp-funds-use-change-evidence.js';

const citation = {
  sourceRefId: 'synthetic:cp-offering-document',
  materialVersion: 'synthetic-v1',
  locator: 'page 2, paragraph 3',
};

function evidenced(
  value: string,
  quote: string,
  extra: Partial<CpFundsUseChangeEvidenceValue> = {},
): CpFundsUseChangeEvidenceValue {
  return { value, citations: [{ ...citation, quote }], uncertainty: 'clear', ...extra };
}

function input(overrides: Partial<CpFundsUseChangeEvidenceInput> = {}): CpFundsUseChangeEvidenceInput {
  return {
    checkedOn: '2025-04-05',
    disclosureDate: evidenced('2025-04-01', '公司已于2025-04-01对外披露募集资金用途变更。'),
    changedUseEffectiveDate: evidenced('2025-04-02', '变更后的募集资金用途自2025-04-02起已开始执行。'),
    ...overrides,
  };
}

test('cited disclosure dated before a CP use change passes the bounded check', () => {
  const evidence = input();
  const result = checkCpFundsUseChangeEvidence(evidence);
  assert.equal(result.decision, 'evidence_shape_pass');
  assert.equal(result.evidence, evidence);
  assert.ok(result.reasons.includes('disclosure_date_precedes_changed_use_effective_date'));
});

test('disclosure after the changed use took effect is flagged', () => {
  const result = checkCpFundsUseChangeEvidence(input({
    disclosureDate: evidenced('2025-04-03', '公司已于2025-04-03对外披露募集资金用途变更。'),
    changedUseEffectiveDate: evidenced('2025-04-02', '变更后的募集资金用途自2025-04-02起已开始执行。'),
  }));
  assert.equal(result.decision, 'disclosure_not_before_change');
  assert.ok(result.reasons.includes('disclosure_date_after_changed_use_effective_date'));
});

test('same-day dates stay in review because date evidence cannot establish ordering', () => {
  const result = checkCpFundsUseChangeEvidence(input({
    disclosureDate: evidenced('2025-04-02', '公司已于2025-04-02对外披露募集资金用途变更。'),
    changedUseEffectiveDate: evidenced('2025-04-02', '变更后的募集资金用途自2025-04-02起已开始执行。'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('same_day_ordering_not_established'));
});

test('missing, uncertain, malformed, or conflicting dates stay in review with evidence retained', () => {
  const cases = [
    input({ disclosureDate: { value: '2025-04-01', citations: [], uncertainty: 'clear' } }),
    input({ changedUseEffectiveDate: evidenced('2025-04-02', '变更后的募集资金用途自2025-04-02起已开始执行。', { uncertainty: 'uncertain' }) }),
    input({ disclosureDate: evidenced('2025-02-30', '公司已于2025-02-30对外披露募集资金用途变更。') }),
    input({ changedUseEffectiveDate: evidenced('2025-04-02', '变更后的募集资金用途自2025-04-02起已开始执行。', {
      conflictingAssertions: [{ value: '2025-04-03', citations: [{ ...citation, quote: '变更后的募集资金用途自2025-04-03起已开始执行。' }] }],
    }) }),
  ];
  for (const evidence of cases) {
    const result = checkCpFundsUseChangeEvidence(evidence);
    assert.equal(result.decision, 'needs_review');
    assert.equal(result.evidence, evidence);
  }
});

test('a date absent from the source quote does not support an otherwise plausible chronology', () => {
  const result = checkCpFundsUseChangeEvidence(input({
    disclosureDate: evidenced('2025-04-01', '公司已披露募集资金用途变更，原文没有记载披露日期。'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('date_not_bound_to_citation_quote'));
});

test('planned dates do not prove completed disclosure or completed use change', () => {
  const result = checkCpFundsUseChangeEvidence(input({
    disclosureDate: evidenced('2025-04-01', '公司计划于2025-04-01披露募集资金用途变更。'),
    changedUseEffectiveDate: evidenced('2025-04-02', '变更后的募集资金用途预计于2025-04-02开始实施。'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('actual_disclosure_event_not_proven'));
  assert.ok(result.reasons.includes('actual_use_change_event_not_proven'));
});

test('future event dates stay in review even when the quote uses completed-event wording', () => {
  const result = checkCpFundsUseChangeEvidence(input({
    checkedOn: '2025-03-31',
    disclosureDate: evidenced('2025-04-01', '公司已于2025-04-01对外披露募集资金用途变更。'),
    changedUseEffectiveDate: evidenced('2025-04-02', '变更后的募集资金用途自2025-04-02起已开始执行。'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('future_event_date_unresolved'));
});

test('an exact Chinese date representation is accepted when its quote proves the actual event', () => {
  const result = checkCpFundsUseChangeEvidence(input({
    disclosureDate: evidenced('2025-04-01', '公司已于2025年4月1日对外披露募集资金用途变更。'),
    changedUseEffectiveDate: evidenced('2025-04-02', '变更后的募集资金用途自2025年04月02日起已开始执行。'),
  }));
  assert.equal(result.decision, 'evidence_shape_pass');
});

test('source citations retain exact versions, locators, and event quotes', () => {
  const source = {
    ...citation,
    sourceRefId: 'NA028',
    materialVersion: 'docx-sha256:synthetic',
    locator: 'P00008',
    quote: '公司已于2025-04-01对外披露募集资金用途变更。',
  };
  const evidence = input({ disclosureDate: evidenced('2025-04-01', source.quote, { citations: [source] }) });
  const result = checkCpFundsUseChangeEvidence(evidence);
  assert.equal(result.evidence.disclosureDate.citations[0], source);
});
