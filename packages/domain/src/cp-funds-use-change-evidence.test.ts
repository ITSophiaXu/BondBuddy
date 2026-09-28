import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkCpFundsUseChangeEvidence,
  cpFundsUseChangeConfirmedClauses,
  cpFundsUseChangeMisattributedClauses,
  type CpFundsUseChangeEvidenceInput,
  type CpFundsUseChangeEvidenceValue,
} from './cp-funds-use-change-evidence.js';

function sourceForClause(clauseRef: string): string {
  if (clauseRef === '第二十七条' || clauseRef === '第二十六条') return 'nafmii-disclosure-rules-2023';
  if (clauseRef === '第六条') return 'nafmii-funds-use-procedure-2022';
  if (clauseRef === '第四条') return 'nafmii-cp-guide-2021';
  return 'synthetic:unconfirmed-source';
}

function evidenced(
  value: string,
  quote: string,
  clauseRef = '第二十七条',
  extra: Partial<CpFundsUseChangeEvidenceValue> = {},
): CpFundsUseChangeEvidenceValue {
  return {
    value,
    citations: [{
      sourceRefId: sourceForClause(clauseRef),
      materialVersion: 'synthetic-v1',
      locator: `synthetic page, ${clauseRef || 'clause unattributed'}`,
      quote,
      clauseRef,
    }],
    uncertainty: 'clear',
    ...extra,
  };
}

function input(overrides: Partial<CpFundsUseChangeEvidenceInput> = {}): CpFundsUseChangeEvidenceInput {
  return {
    checkedOn: '2025-04-05',
    disclosureDate: evidenced('2025-04-01', '公司已于2025-04-01对外披露募集资金用途变更。', '第二十七条'),
    changedUseEffectiveDate: evidenced('2025-04-02', '变更后的募集资金用途自2025-04-02起已开始执行。', '第六条'),
    ...overrides,
  };
}

test('the confirmed clause chain maps disclosure to 第二十七条 and the use change to the rule basis', () => {
  assert.deepEqual(
    cpFundsUseChangeConfirmedClauses.map(clause => [clause.sourceRefId, clause.clauseNumber, clause.role]),
    [
      ['nafmii-cp-guide-2021', 4, 'rule_basis'],
      ['nafmii-funds-use-procedure-2022', 6, 'rule_basis'],
      ['nafmii-disclosure-rules-2023', 27, 'disclosure_requirement'],
    ],
  );
  assert.equal(cpFundsUseChangeMisattributedClauses[0]?.clauseNumber, 26);
});

test('cited disclosure dated before a CP use change with confirmed clauses passes the bounded check', () => {
  const evidence = input();
  const result = checkCpFundsUseChangeEvidence(evidence);
  assert.equal(result.decision, 'evidence_shape_pass');
  assert.equal(result.evidence, evidence);
  assert.ok(result.reasons.includes('disclosure_date_precedes_changed_use_effective_date'));
});

test('disclosure after the changed use took effect is flagged', () => {
  const result = checkCpFundsUseChangeEvidence(input({
    disclosureDate: evidenced('2025-04-03', '公司已于2025-04-03对外披露募集资金用途变更。', '第二十七条'),
    changedUseEffectiveDate: evidenced('2025-04-02', '变更后的募集资金用途自2025-04-02起已开始执行。', '第六条'),
  }));
  assert.equal(result.decision, 'disclosure_not_before_change');
  assert.ok(result.reasons.includes('disclosure_date_after_changed_use_effective_date'));
});

test('same-day dates stay in review because date evidence cannot establish ordering', () => {
  const result = checkCpFundsUseChangeEvidence(input({
    disclosureDate: evidenced('2025-04-02', '公司已于2025-04-02对外披露募集资金用途变更。', '第二十七条'),
    changedUseEffectiveDate: evidenced('2025-04-02', '变更后的募集资金用途自2025-04-02起已开始执行。', '第六条'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('same_day_ordering_not_established'));
});

test('missing, uncertain, malformed, or conflicting dates stay in review with evidence retained', () => {
  const cases = [
    input({ disclosureDate: { value: '2025-04-01', citations: [], uncertainty: 'clear' } }),
    input({ changedUseEffectiveDate: evidenced('2025-04-02', '变更后的募集资金用途自2025-04-02起已开始执行。', '第六条', { uncertainty: 'uncertain' }) }),
    input({ disclosureDate: evidenced('2025-02-30', '公司已于2025-02-30对外披露募集资金用途变更。', '第二十七条') }),
    input({ changedUseEffectiveDate: evidenced('2025-04-02', '变更后的募集资金用途自2025-04-02起已开始执行。', '第六条', {
      conflictingAssertions: [{ value: '2025-04-03', citations: [{ sourceRefId: 'nafmii-funds-use-procedure-2022', materialVersion: 'synthetic-v1', locator: 'synthetic page, 第六条', quote: '变更后的募集资金用途自2025-04-03起已开始执行。', clauseRef: '第六条' }] }],
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
    disclosureDate: evidenced('2025-04-01', '公司已披露募集资金用途变更，原文没有记载披露日期。', '第二十七条'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('date_not_bound_to_citation_quote'));
});

test('planned dates do not prove completed disclosure or completed use change', () => {
  const result = checkCpFundsUseChangeEvidence(input({
    disclosureDate: evidenced('2025-04-01', '公司计划于2025-04-01披露募集资金用途变更。', '第二十七条'),
    changedUseEffectiveDate: evidenced('2025-04-02', '变更后的募集资金用途预计于2025-04-02开始实施。', '第六条'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('actual_disclosure_event_not_proven'));
  assert.ok(result.reasons.includes('actual_use_change_event_not_proven'));
});

test('a scheduled disclosure date and a stated effective date are not completed events', () => {
  const result = checkCpFundsUseChangeEvidence(input({
    disclosureDate: evidenced('2025-04-01', '披露日期为2025-04-01。', '第二十七条'),
    changedUseEffectiveDate: evidenced('2025-04-02', '变更后的募集资金用途自2025-04-02生效。', '第六条'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('actual_disclosure_event_not_proven'));
  assert.ok(result.reasons.includes('actual_use_change_event_not_proven'));
});

test('a board-meeting date cannot be borrowed as the later actual disclosure date', () => {
  const result = checkCpFundsUseChangeEvidence(input({
    disclosureDate: evidenced('2025-04-01', '公司于2025-04-01召开董事会，已于2025-04-03对外披露募集资金用途变更。', '第二十七条'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('actual_disclosure_event_not_proven'));
});

test('explicit non-disclosure and a date paired with another event never prove actual disclosure', () => {
  for (const quote of [
    '公司已确认于2025-04-01未披露募集资金用途变更。',
    '公司已于2025-04-01召开董事会并披露募集资金用途变更。',
    '公司已于2025-04-01披露年度报告，募集资金用途变更另行公告。',
  ]) {
    const result = checkCpFundsUseChangeEvidence(input({ disclosureDate: evidenced('2025-04-01', quote, '第二十七条') }));
    assert.equal(result.decision, 'needs_review', quote);
    assert.ok(result.reasons.includes('actual_disclosure_event_not_proven'), quote);
  }
});

test('multiple dates in a citation remain ambiguous even if one mentions the completed event', () => {
  const result = checkCpFundsUseChangeEvidence(input({
    disclosureDate: evidenced('2025-04-01', '公司已于2025-04-01对外披露募集资金用途变更，2025-04-02召开债券持有人会议。', '第二十七条'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('actual_disclosure_event_not_proven'));
});

test('future event dates stay in review even when the quote uses completed-event wording', () => {
  const result = checkCpFundsUseChangeEvidence(input({
    checkedOn: '2025-03-31',
    disclosureDate: evidenced('2025-04-01', '公司已于2025-04-01对外披露募集资金用途变更。', '第二十七条'),
    changedUseEffectiveDate: evidenced('2025-04-02', '变更后的募集资金用途自2025-04-02起已开始执行。', '第六条'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('future_event_date_unresolved'));
});

test('an exact Chinese date representation is accepted when its quote proves the actual event', () => {
  const result = checkCpFundsUseChangeEvidence(input({
    disclosureDate: evidenced('2025-04-01', '公司已于2025年4月1日对外披露募集资金用途变更。', '第二十七条'),
    changedUseEffectiveDate: evidenced('2025-04-02', '变更后的募集资金用途自2025年04月02日起已开始执行。', '第六条'),
  }));
  assert.equal(result.decision, 'evidence_shape_pass');
});

test('a citation to the credit-enhancement clause is rejected as a proceeds-use change basis', () => {
  const result = checkCpFundsUseChangeEvidence(input({
    disclosureDate: evidenced('2025-04-01', '公司已于2025-04-01对外披露募集资金用途变更。', '第二十六条'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('cross_clause_citation_misattributed'));
});

test('a mixed valid and cross-clause citation set stays in review', () => {
  const valid = {
    sourceRefId: 'nafmii-disclosure-rules-2023',
    materialVersion: 'synthetic-v1',
    locator: 'synthetic page, 第二十七条',
    quote: '公司已于2025-04-01对外披露募集资金用途变更。',
    clauseRef: '第二十七条',
  };
  const crossClause = { ...valid, locator: 'synthetic page, 第二十六条', clauseRef: '第二十六条' };
  const result = checkCpFundsUseChangeEvidence(input({
    disclosureDate: { value: '2025-04-01', citations: [valid, crossClause], uncertainty: 'clear' },
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('cross_clause_citation_misattributed'));
});

test('citations without a confirmed clause attribution stay in review', () => {
  const result = checkCpFundsUseChangeEvidence(input({
    disclosureDate: evidenced('2025-04-01', '公司已于2025-04-01对外披露募集资金用途变更。', ''),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('clause_attribution_unconfirmed'));
  assert.ok(result.reasons.includes('disclosure_change_clause_mapping_missing'));
});

test('disclosure evidence attributed only to a rule-basis clause is missing the disclosure mapping', () => {
  const result = checkCpFundsUseChangeEvidence(input({
    disclosureDate: evidenced('2025-04-01', '公司已于2025-04-01对外披露募集资金用途变更。', '第四条'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('disclosure_change_clause_mapping_missing'));
  assert.ok(!result.reasons.includes('cross_clause_citation_misattributed'));
});

test('use-change evidence attributed only to the disclosure clause is missing the rule-basis mapping', () => {
  const result = checkCpFundsUseChangeEvidence(input({
    changedUseEffectiveDate: evidenced('2025-04-02', '变更后的募集资金用途自2025-04-02起已开始执行。', '第二十七条'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('use_change_clause_mapping_missing'));
});

test('source citations retain exact versions, locators and event quotes', () => {
  const source = {
    sourceRefId: 'nafmii-disclosure-rules-2023',
    materialVersion: 'docx-sha256:synthetic',
    locator: 'synthetic page 9, 第二十七条',
    quote: '公司已于2025-04-01对外披露募集资金用途变更。',
    clauseRef: '第二十七条',
  };
  const evidence = input({ disclosureDate: evidenced('2025-04-01', source.quote, '第二十七条', { citations: [source] }) });
  const result = checkCpFundsUseChangeEvidence(evidence);
  assert.equal(result.evidence.disclosureDate.citations[0], source);
});
