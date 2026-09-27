/**
 * Evidence-shape and unambiguous-boundary check for the CP one-year tenor.
 * This is deliberately not a legal-compliance or production-capability check.
 */

export type CpTenorEvidenceCitation = {
  sourceRefId: string;
  materialVersion: string;
  locator: string;
  quote: string;
};

export type CpTenorEvidenceValue<T> = {
  value: T;
  citations: CpTenorEvidenceCitation[];
  uncertainty: 'clear' | 'uncertain';
  conflictingAssertions?: Array<{
    value: T;
    citations: CpTenorEvidenceCitation[];
  }>;
};

export type CpTenorEvidenceInput = {
  instrument: CpTenorEvidenceValue<'cp' | 'scp' | 'mtn' | 'other'>;
  statedTenorMonths: CpTenorEvidenceValue<number>;
  interestStartDate: CpTenorEvidenceValue<string>;
  maturityDate: CpTenorEvidenceValue<string>;
  dateAdjustment: 'none' | 'applied' | 'unknown';
};

export type CpTenorEvidenceDecision =
  | 'evidence_shape_pass'
  | 'tenor_exceeds_one_year'
  | 'needs_review';

export type CpTenorEvidenceResult = {
  decision: CpTenorEvidenceDecision;
  reasons: string[];
  evidence: CpTenorEvidenceInput;
};

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day >= 1 && day <= days;
}

function hasEvidence<T>(field: CpTenorEvidenceValue<T>): boolean {
  return field.citations.length > 0 && field.citations.every(citation =>
    citation.sourceRefId.trim().length > 0 &&
    citation.materialVersion.trim().length > 0 &&
    citation.locator.trim().length > 0 &&
    citation.quote.trim().length > 0,
  );
}

function hasConflict<T>(field: CpTenorEvidenceValue<T>): boolean {
  return (field.conflictingAssertions ?? []).some(assertion =>
    assertion.value !== field.value || !assertion.citations.length || assertion.citations.some(citation =>
      !citation.sourceRefId.trim() || !citation.materialVersion.trim() ||
      !citation.locator.trim() || !citation.quote.trim(),
    ),
  );
}

function dateOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Checks only a conservative evidence shape and cases clearly inside/outside
 * one calendar year. No 365-day conversion or anniversary normalization is
 * performed. The input evidence is returned intact for downstream review.
 */
export function checkCpTenorEvidence(input: CpTenorEvidenceInput): CpTenorEvidenceResult {
  const reasons: string[] = [];
  const fieldsHaveEvidence = [
    hasEvidence(input.instrument),
    hasEvidence(input.statedTenorMonths),
    hasEvidence(input.interestStartDate),
    hasEvidence(input.maturityDate),
  ];
  const fieldsAreCertain = [
    input.instrument.uncertainty === 'clear',
    input.statedTenorMonths.uncertainty === 'clear',
    input.interestStartDate.uncertainty === 'clear',
    input.maturityDate.uncertainty === 'clear',
  ];
  const fieldsAreConsistent = [
    !hasConflict(input.instrument),
    !hasConflict(input.statedTenorMonths),
    !hasConflict(input.interestStartDate),
    !hasConflict(input.maturityDate),
  ];

  if (fieldsHaveEvidence.some(present => !present)) reasons.push('evidence_missing_or_unlocated');
  if (fieldsAreCertain.some(certain => !certain)) reasons.push('evidence_uncertain');
  if (fieldsAreConsistent.some(consistent => !consistent)) reasons.push('conflicting_source_assertions');

  if (input.instrument.value !== 'cp') reasons.push('instrument_not_confirmed_cp');
  const start = input.interestStartDate.value;
  const maturity = input.maturityDate.value;
  const tenorMonths = input.statedTenorMonths.value;
  if (!isCalendarDate(start) || !isCalendarDate(maturity)) reasons.push('invalid_or_missing_calendar_date');
  if (!Number.isInteger(tenorMonths) || tenorMonths <= 0) reasons.push('invalid_stated_tenor');
  if (input.dateAdjustment !== 'none') reasons.push('date_adjustment_unresolved');

  if (reasons.length) return { decision: 'needs_review', reasons, evidence: input };
  if (dateOrder(start, maturity) >= 0) {
    return { decision: 'needs_review', reasons: ['non_increasing_or_same_dates'], evidence: input };
  }

  const [, yearText, monthText, dayText] = DATE_PATTERN.exec(start)!;
  const year = Number(yearText);
  const month = monthText!;
  const day = dayText!;
  if (month === '02' && day === '29') {
    return { decision: 'needs_review', reasons: ['leap_day_anniversary_unresolved'], evidence: input };
  }

  const anniversary = `${String(year + 1).padStart(4, '0')}-${month}-${day}`;
  const relation = dateOrder(maturity, anniversary);
  if (relation === 0) {
    return { decision: 'needs_review', reasons: ['one_year_anniversary_boundary_unresolved'], evidence: input };
  }

  const datesAreShorterThanYear = relation < 0;
  if (tenorMonths === 12) {
    return { decision: 'needs_review', reasons: ['stated_one_year_tenor_boundary_unresolved'], evidence: input };
  }
  const statedTenorIsShorterThanYear = tenorMonths < 12;
  if (datesAreShorterThanYear !== statedTenorIsShorterThanYear) {
    return { decision: 'needs_review', reasons: ['stated_tenor_conflicts_with_explicit_dates'], evidence: input };
  }

  return datesAreShorterThanYear
    ? { decision: 'evidence_shape_pass', reasons: ['clear_cp_tenor_shorter_than_one_calendar_year'], evidence: input }
    : { decision: 'tenor_exceeds_one_year', reasons: ['clear_cp_tenor_longer_than_one_calendar_year'], evidence: input };
}
