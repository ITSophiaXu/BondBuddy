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
  quote: 'synthetic evidence only',
};

function evidenced(value: string, extra: Partial<CpFundsUseChangeEvidenceValue> = {}): CpFundsUseChangeEvidenceValue {
  return { value, citations: [citation], uncertainty: 'clear', ...extra };
}

function input(overrides: Partial<CpFundsUseChangeEvidenceInput> = {}): CpFundsUseChangeEvidenceInput {
  return {
    disclosureDate: evidenced('2025-04-01'),
    changedUseEffectiveDate: evidenced('2025-04-02'),
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
    disclosureDate: evidenced('2025-04-03'),
    changedUseEffectiveDate: evidenced('2025-04-02'),
  }));
  assert.equal(result.decision, 'disclosure_not_before_change');
  assert.ok(result.reasons.includes('disclosure_date_after_changed_use_effective_date'));
});

test('same-day dates stay in review because date evidence cannot establish ordering', () => {
  const result = checkCpFundsUseChangeEvidence(input({
    disclosureDate: evidenced('2025-04-02'),
    changedUseEffectiveDate: evidenced('2025-04-02'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('same_day_ordering_not_established'));
});

test('missing, uncertain, malformed, or conflicting dates stay in review with evidence retained', () => {
  const cases = [
    input({ disclosureDate: { value: '2025-04-01', citations: [], uncertainty: 'clear' } }),
    input({ changedUseEffectiveDate: evidenced('2025-04-02', { uncertainty: 'uncertain' }) }),
    input({ disclosureDate: evidenced('2025-02-30') }),
    input({ changedUseEffectiveDate: evidenced('2025-04-02', {
      conflictingAssertions: [{ value: '2025-04-03', citations: [{ ...citation, locator: 'page 3' }] }],
    }) }),
  ];
  for (const evidence of cases) {
    const result = checkCpFundsUseChangeEvidence(evidence);
    assert.equal(result.decision, 'needs_review');
    assert.equal(result.evidence, evidence);
  }
});

test('source citations retain exact versions, locators, and quotes', () => {
  const source = {
    ...citation,
    sourceRefId: 'NA028',
    materialVersion: 'docx-sha256:synthetic',
    locator: 'P00008',
    quote: '企业在短期融资券存续期内变更募集资金用途应提前披露。',
  };
  const evidence = input({ disclosureDate: evidenced('2025-04-01', { citations: [source] }) });
  const result = checkCpFundsUseChangeEvidence(evidence);
  assert.equal(result.evidence.disclosureDate.citations[0], source);
});
