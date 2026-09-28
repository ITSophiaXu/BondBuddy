/**
 * Conservative evidence-shape check for the CP rule that a change to the use
 * of proceeds must be disclosed in advance (NA028, paragraph P00008).
 * This does not decide whether a proposed use is lawful or policy-compliant.
 */

export type CpFundsUseChangeCitation = {
  sourceRefId: string;
  materialVersion: string;
  locator: string;
  quote: string;
};

export type CpFundsUseChangeEvidenceValue = {
  value: string;
  citations: CpFundsUseChangeCitation[];
  uncertainty: 'clear' | 'uncertain';
  conflictingAssertions?: Array<{
    value: string;
    citations: CpFundsUseChangeCitation[];
  }>;
};

export type CpFundsUseChangeEvidenceInput = {
  disclosureDate: CpFundsUseChangeEvidenceValue;
  changedUseEffectiveDate: CpFundsUseChangeEvidenceValue;
};

export type CpFundsUseChangeEvidenceDecision =
  | 'evidence_shape_pass'
  | 'disclosure_not_before_change'
  | 'needs_review';

export type CpFundsUseChangeEvidenceResult = {
  decision: CpFundsUseChangeEvidenceDecision;
  reasons: string[];
  evidence: CpFundsUseChangeEvidenceInput;
};

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day >= 1 && day <= days;
}

function citationIsComplete(citation: CpFundsUseChangeCitation): boolean {
  return citation.sourceRefId.trim().length > 0 &&
    citation.materialVersion.trim().length > 0 &&
    citation.locator.trim().length > 0 &&
    citation.quote.trim().length > 0;
}

function hasEvidence(field: CpFundsUseChangeEvidenceValue): boolean {
  return field.citations.length > 0 && field.citations.every(citationIsComplete);
}

function hasConflict(field: CpFundsUseChangeEvidenceValue): boolean {
  return (field.conflictingAssertions ?? []).some(assertion =>
    assertion.value !== field.value || assertion.citations.length === 0 ||
    assertion.citations.some(citation => !citationIsComplete(citation)),
  );
}

/**
 * A date strictly earlier than the effective date is consistent with prior
 * disclosure. Same-day dates cannot establish intraday ordering and stay in
 * review. No calendar-day or business-day adjustment is inferred.
 */
export function checkCpFundsUseChangeEvidence(
  input: CpFundsUseChangeEvidenceInput,
): CpFundsUseChangeEvidenceResult {
  const reasons: string[] = [];
  const fields = [input.disclosureDate, input.changedUseEffectiveDate];

  if (fields.some(field => !hasEvidence(field))) reasons.push('evidence_missing_or_unlocated');
  if (fields.some(field => field.uncertainty !== 'clear')) reasons.push('evidence_uncertain');
  if (fields.some(hasConflict)) reasons.push('conflicting_source_assertions');
  if (fields.some(field => !isCalendarDate(field.value))) reasons.push('invalid_or_missing_calendar_date');

  if (reasons.length) return { decision: 'needs_review', reasons, evidence: input };

  if (input.disclosureDate.value === input.changedUseEffectiveDate.value) {
    return {
      decision: 'needs_review',
      reasons: ['same_day_ordering_not_established'],
      evidence: input,
    };
  }
  if (input.disclosureDate.value > input.changedUseEffectiveDate.value) {
    return {
      decision: 'disclosure_not_before_change',
      reasons: ['disclosure_date_after_changed_use_effective_date'],
      evidence: input,
    };
  }
  return {
    decision: 'evidence_shape_pass',
    reasons: ['disclosure_date_precedes_changed_use_effective_date'],
    evidence: input,
  };
}
