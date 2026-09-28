import assert from 'node:assert/strict';
import test from 'node:test';
import { checkScpTenorEvidence, SCP_MAX_TENOR_DAYS, type ScpTenorEvidenceInput, type ScpTenorEvidenceValue } from './scp-tenor-evidence.js';

const citation = {
  sourceRefId: 'synthetic:scp-offering-terms',
  materialVersion: 'synthetic-v1',
  locator: 'page 1, paragraph 2',
  quote: 'synthetic evidence only',
};

function evidenced<T>(value: T, extra: Partial<ScpTenorEvidenceValue<T>> = {}): ScpTenorEvidenceValue<T> {
  return { value, citations: [citation], uncertainty: 'clear', ...extra };
}

function input(overrides: Partial<ScpTenorEvidenceInput> = {}): ScpTenorEvidenceInput {
  return {
    instrument: evidenced('scp'),
    statedTenorDays: evidenced(269),
    interestStartDate: evidenced('2025-01-01'),
    maturityDate: evidenced('2025-09-27'),
    dateAdjustment: evidenced('none'),
    ...overrides,
  };
}

test('the 270-day ceiling constant is fixed and not a substitutable 365-day figure', () => {
  assert.equal(SCP_MAX_TENOR_DAYS, 270);
});

test('clear synthetic SCP evidence shorter than 270 calendar days passes the bounded shape check', () => {
  const evidence = input();
  const result = checkScpTenorEvidence(evidence);
  assert.equal(result.decision, 'evidence_shape_pass');
  assert.equal(result.evidence, evidence);
  assert.match(result.reasons[0]!, /within_270_calendar_days/);
});

test('a clearly longer-than-270-day SCP tenor is flagged', () => {
  const result = checkScpTenorEvidence(input({
    statedTenorDays: evidenced(271),
    maturityDate: evidenced('2025-09-29'),
  }));
  assert.equal(result.decision, 'tenor_exceeds_270_days');
  assert.match(result.reasons[0]!, /longer_than_270_calendar_days/);
});

test('the exact 270-day endpoint stays unresolved without an authoritative convention', () => {
  const result = checkScpTenorEvidence(input({
    statedTenorDays: evidenced(270),
    maturityDate: evidenced('2025-09-28'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('270_day_endpoint_unresolved'));
});

test('stated days must exactly agree with the calendar distance in explicit dates', () => {
  for (const [statedTenorDays, maturityDate] of [
    [200, '2025-09-28'],
    [271, '2025-09-27'],
  ] as const) {
    const result = checkScpTenorEvidence(input({
      statedTenorDays: evidenced(statedTenorDays),
      maturityDate: evidenced(maturityDate),
    }));
    assert.equal(result.decision, 'needs_review');
    assert.ok(result.reasons.includes('stated_tenor_conflicts_with_explicit_dates'));
  }
});

test('missing or malformed date values need review', () => {
  for (const value of ['', '2025-02-30', '25-01-01']) {
    const result = checkScpTenorEvidence(input({ maturityDate: evidenced(value) }));
    assert.equal(result.decision, 'needs_review', value);
    assert.ok(result.reasons.includes('invalid_or_missing_calendar_date'));
  }
});

test('same dates and reversed dates need review rather than a conclusion', () => {
  for (const maturityDate of ['2025-01-01', '2024-12-31']) {
    const result = checkScpTenorEvidence(input({ maturityDate: evidenced(maturityDate) }));
    assert.equal(result.decision, 'needs_review');
    assert.ok(result.reasons.includes('non_increasing_or_same_dates'));
  }
});

test('an interval crossing a leap day stays unresolved instead of normalizing the count', () => {
  const crossed = checkScpTenorEvidence(input({
    statedTenorDays: evidenced(238),
    interestStartDate: evidenced('2024-02-01'),
    maturityDate: evidenced('2024-09-26'),
  }));
  assert.equal(crossed.decision, 'needs_review');
  assert.ok(crossed.reasons.includes('leap_day_tenor_unresolved'));

  const notCrossed = checkScpTenorEvidence(input({
    statedTenorDays: evidenced(269),
    interestStartDate: evidenced('2025-03-01'),
    maturityDate: evidenced('2025-11-25'),
  }));
  assert.equal(notCrossed.decision, 'evidence_shape_pass');
});

test('applied or unknown date adjustment is unresolved and never converted to a holiday convention', () => {
  for (const dateAdjustment of ['applied', 'unknown'] as const) {
    const result = checkScpTenorEvidence(input({ dateAdjustment: evidenced(dateAdjustment) }));
    assert.equal(result.decision, 'needs_review');
    assert.ok(result.reasons.includes('date_adjustment_unresolved'));
  }

  const cited = checkScpTenorEvidence(input({
    interestStartDate: evidenced('2025-01-01'),
    maturityDate: evidenced('2025-09-27'),
    dateAdjustment: evidenced('none'),
  }));
  assert.equal(cited.decision, 'evidence_shape_pass');
});

test('date adjustment must be cited and clear before a tenor conclusion', () => {
  const missing = checkScpTenorEvidence(input({
    dateAdjustment: { value: 'none', citations: [], uncertainty: 'clear' },
  }));
  assert.equal(missing.decision, 'needs_review');
  assert.ok(missing.reasons.includes('evidence_missing_or_unlocated'));

  const uncertain = checkScpTenorEvidence(input({
    dateAdjustment: evidenced('none', { uncertainty: 'uncertain' }),
  }));
  assert.equal(uncertain.decision, 'needs_review');
  assert.ok(uncertain.reasons.includes('evidence_uncertain'));

  const conflicting = checkScpTenorEvidence(input({
    dateAdjustment: evidenced('none', {
      conflictingAssertions: [{ value: 'applied', citations: [{ ...citation, locator: 'page 2, footnote 1' }] }],
    }),
  }));
  assert.equal(conflicting.decision, 'needs_review');
  assert.ok(conflicting.reasons.includes('conflicting_source_assertions'));
});

test('invalid stated tenor values need review', () => {
  for (const statedTenorDays of [0, -5, 12.5, Number.NaN]) {
    const result = checkScpTenorEvidence(input({ statedTenorDays: evidenced(statedTenorDays) }));
    assert.equal(result.decision, 'needs_review', String(statedTenorDays));
    assert.ok(result.reasons.includes('invalid_stated_tenor'));
  }
});

test('only confirmed SCP identity is eligible for this bounded check', () => {
  for (const instrument of ['cp', 'mtn', 'other'] as const) {
    const result = checkScpTenorEvidence(input({ instrument: evidenced(instrument) }));
    assert.equal(result.decision, 'needs_review');
    assert.ok(result.reasons.includes('instrument_not_confirmed_scp'));
  }
});

test('missing citation or uncertain evidence is retained and needs review', () => {
  const result = checkScpTenorEvidence(input({
    maturityDate: { value: '2025-09-27', citations: [], uncertainty: 'uncertain' },
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('evidence_missing_or_unlocated'));
  assert.ok(result.reasons.includes('evidence_uncertain'));
  assert.equal(result.evidence.maturityDate.value, '2025-09-27');
});

test('contradictory source observations remain reviewable and never pass', () => {
  const result = checkScpTenorEvidence(input({
    maturityDate: evidenced('2025-09-27', {
      conflictingAssertions: [{ value: '2025-09-28', citations: [{ ...citation, locator: 'page 2, table 1' }] }],
    }),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('conflicting_source_assertions'));
  assert.equal(result.evidence.maturityDate.conflictingAssertions?.[0]?.value, '2025-09-28');
});

test('malformed assertion, citation and conflict shapes fail closed without throwing', () => {
  const base = input();
  assert.equal(checkScpTenorEvidence(null as unknown as ScpTenorEvidenceInput).decision, 'needs_review');
  const malformed: Array<Partial<ScpTenorEvidenceInput>> = [
    { maturityDate: null as unknown as ScpTenorEvidenceValue<string> },
    { interestStartDate: { value: '2025-01-01', citations: null, uncertainty: 'clear' } as unknown as ScpTenorEvidenceValue<string> },
    { statedTenorDays: { value: 269, citations: [null], uncertainty: 'clear' } as unknown as ScpTenorEvidenceValue<number> },
    { dateAdjustment: { value: 'none', citations: [citation], uncertainty: 'clear', conflictingAssertions: [null] } as unknown as ScpTenorEvidenceValue<'none'> },
    { dateAdjustment: { value: 'none', citations: [citation], uncertainty: 'clear', conflictingAssertions: {} } as unknown as ScpTenorEvidenceValue<'none'> },
  ];
  for (const override of malformed) {
    const result = checkScpTenorEvidence({ ...base, ...override });
    assert.equal(result.decision, 'needs_review');
  }
});

test('evidence citations retain exact source references, versions, locators and quotes', () => {
  const source = { ...citation, sourceRefId: 'NA031', materialVersion: 'docx-sha256:synthetic', quote: '约定在270天以内还本付息' };
  const evidence = input({ interestStartDate: evidenced('2025-01-01', { citations: [source] }) });
  const result = checkScpTenorEvidence(evidence);
  assert.equal(result.evidence.interestStartDate.citations[0], source);
});
