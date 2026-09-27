import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCpTenorEvidence, type CpTenorEvidenceInput, type CpTenorEvidenceValue } from './cp-tenor-evidence.js';

const citation = {
  sourceRefId: 'synthetic:cp-offering-terms',
  materialVersion: 'synthetic-v1',
  locator: 'page 1, paragraph 2',
  quote: 'synthetic evidence only',
};

function evidenced<T>(value: T, extra: Partial<CpTenorEvidenceValue<T>> = {}): CpTenorEvidenceValue<T> {
  return { value, citations: [citation], uncertainty: 'clear', ...extra };
}

function input(overrides: Partial<CpTenorEvidenceInput> = {}): CpTenorEvidenceInput {
  return {
    instrument: evidenced('cp'),
    statedTenorMonths: evidenced(11),
    interestStartDate: evidenced('2025-01-01'),
    maturityDate: evidenced('2025-12-01'),
    dateAdjustment: evidenced('none'),
    ...overrides,
  };
}

test('clear synthetic eleven-month CP evidence passes the bounded shape check', () => {
  const evidence = input();
  const result = checkCpTenorEvidence(evidence);
  assert.equal(result.decision, 'evidence_shape_pass');
  assert.equal(result.evidence, evidence);
  assert.match(result.reasons[0]!, /shorter_than_one_calendar_year/);
});

test('a clearly longer-than-one-calendar-year CP tenor is flagged', () => {
  const result = checkCpTenorEvidence(input({
    statedTenorMonths: evidenced(13),
    interestStartDate: evidenced('2025-01-01'),
    maturityDate: evidenced('2026-02-01'),
  }));
  assert.equal(result.decision, 'tenor_exceeds_one_year');
});

test('stated months must exactly agree with the month distance in explicit dates', () => {
  for (const [statedTenorMonths, maturityDate] of [
    [1, '2025-12-01'],
    [13, '2026-03-01'],
  ] as const) {
    const result = checkCpTenorEvidence(input({
      statedTenorMonths: evidenced(statedTenorMonths),
      maturityDate: evidenced(maturityDate),
    }));
    assert.equal(result.decision, 'needs_review');
    assert.ok(result.reasons.includes('stated_tenor_conflicts_with_explicit_dates'));
  }
});

test('missing or malformed date values need review', () => {
  for (const value of ['', '2025-02-30', '25-01-01']) {
    const result = checkCpTenorEvidence(input({ maturityDate: evidenced(value) }));
    assert.equal(result.decision, 'needs_review', value);
    assert.ok(result.reasons.includes('invalid_or_missing_calendar_date'));
  }
});

test('same dates and reversed dates need review rather than a conclusion', () => {
  for (const maturityDate of ['2025-01-01', '2024-12-31']) {
    const result = checkCpTenorEvidence(input({ maturityDate: evidenced(maturityDate) }));
    assert.equal(result.decision, 'needs_review');
    assert.ok(result.reasons.includes('non_increasing_or_same_dates'));
  }
});

test('the exact calendar anniversary remains unresolved', () => {
  const result = checkCpTenorEvidence(input({
    statedTenorMonths: evidenced(12),
    maturityDate: evidenced('2026-01-01'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('one_year_anniversary_boundary_unresolved'));
});

test('a stated twelve-month tenor remains unresolved even when dates disagree', () => {
  const result = checkCpTenorEvidence(input({
    statedTenorMonths: evidenced(12),
    maturityDate: evidenced('2026-01-02'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('month_day_adjustment_or_date_mismatch_unresolved'));
});

test('leap-day anniversary needs review without substituting a date convention', () => {
  const result = checkCpTenorEvidence(input({
    interestStartDate: evidenced('2024-02-29'),
    maturityDate: evidenced('2025-02-28'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('leap_day_anniversary_unresolved'));
});

test('date adjustment must be cited and clear before a tenor conclusion', () => {
  const missing = checkCpTenorEvidence(input({
    dateAdjustment: { value: 'none', citations: [], uncertainty: 'clear' },
  }));
  assert.equal(missing.decision, 'needs_review');
  assert.ok(missing.reasons.includes('evidence_missing_or_unlocated'));

  const uncertain = checkCpTenorEvidence(input({
    dateAdjustment: evidenced('none', { uncertainty: 'uncertain' }),
  }));
  assert.equal(uncertain.decision, 'needs_review');
  assert.ok(uncertain.reasons.includes('evidence_uncertain'));

  const conflicting = checkCpTenorEvidence(input({
    dateAdjustment: evidenced('none', {
      conflictingAssertions: [{ value: 'applied', citations: [{ ...citation, locator: 'page 2, footnote 1' }] }],
    }),
  }));
  assert.equal(conflicting.decision, 'needs_review');
  assert.ok(conflicting.reasons.includes('conflicting_source_assertions'));

  for (const dateAdjustment of ['applied', 'unknown'] as const) {
    const result = checkCpTenorEvidence(input({ dateAdjustment: evidenced(dateAdjustment) }));
    assert.equal(result.decision, 'needs_review');
    assert.ok(result.reasons.includes('date_adjustment_unresolved'));
  }
});

test('an absent month-end date convention remains unresolved instead of normalizing', () => {
  const result = checkCpTenorEvidence(input({
    statedTenorMonths: evidenced(1),
    interestStartDate: evidenced('2025-01-31'),
    maturityDate: evidenced('2025-02-28'),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('month_day_adjustment_or_date_mismatch_unresolved'));
});

test('year zero is invalid and a four-digit anniversary overflow cannot pass', () => {
  const yearZero = checkCpTenorEvidence(input({
    interestStartDate: evidenced('0000-01-01'),
    maturityDate: evidenced('0000-12-01'),
  }));
  assert.equal(yearZero.decision, 'needs_review');
  assert.ok(yearZero.reasons.includes('invalid_or_missing_calendar_date'));

  const maxYear = checkCpTenorEvidence(input({
    interestStartDate: evidenced('9999-01-01'),
    maturityDate: evidenced('9999-12-01'),
  }));
  assert.equal(maxYear.decision, 'evidence_shape_pass');
  const beyondMax = checkCpTenorEvidence(input({
    statedTenorMonths: evidenced(13),
    interestStartDate: evidenced('9999-01-01'),
    maturityDate: evidenced('9999-12-01'),
  }));
  assert.equal(beyondMax.decision, 'needs_review');
  assert.ok(beyondMax.reasons.includes('calendar_year_out_of_supported_range'));
});

test('missing citation or uncertain evidence is retained and needs review', () => {
  const result = checkCpTenorEvidence(input({
    maturityDate: { value: '2025-12-01', citations: [], uncertainty: 'uncertain' },
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('evidence_missing_or_unlocated'));
  assert.ok(result.reasons.includes('evidence_uncertain'));
  assert.equal(result.evidence.maturityDate.value, '2025-12-01');
});

test('contradictory source observations remain reviewable and never pass', () => {
  const result = checkCpTenorEvidence(input({
    maturityDate: evidenced('2025-12-01', {
      conflictingAssertions: [{ value: '2026-01-02', citations: [{ ...citation, locator: 'page 2, table 1' }] }],
    }),
  }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('conflicting_source_assertions'));
  assert.equal(result.evidence.maturityDate.conflictingAssertions?.[0]?.value, '2026-01-02');
});

test('tenor text represented by a different month value than the dates needs review', () => {
  const result = checkCpTenorEvidence(input({ statedTenorMonths: evidenced(13) }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('stated_tenor_conflicts_with_explicit_dates'));
});

test('only confirmed CP identity is eligible for this bounded check', () => {
  for (const instrument of ['scp', 'mtn', 'other'] as const) {
    const result = checkCpTenorEvidence(input({ instrument: evidenced(instrument) }));
    assert.equal(result.decision, 'needs_review');
    assert.ok(result.reasons.includes('instrument_not_confirmed_cp'));
  }
});

test('evidence citations retain exact source references, versions, locators and quotes', () => {
  const source = { ...citation, sourceRefId: 'NA028', materialVersion: 'docx-sha256:synthetic', quote: '约定在1年内还本付息' };
  const evidence = input({ interestStartDate: evidenced('2025-01-01', { citations: [source] }) });
  const result = checkCpTenorEvidence(evidence);
  assert.equal(result.evidence.interestStartDate.citations[0], source);
});
