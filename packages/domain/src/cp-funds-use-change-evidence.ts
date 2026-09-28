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
  /** Trusted evaluation date supplied by the caller, never read from the quote. */
  checkedOn: string;
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

function quoteContainsDate(quote: string, value: string): boolean {
  const target = DATE_PATTERN.exec(value);
  if (!target) return false;
  const [year, month, day] = target.slice(1).map(Number);
  const dateMentions = quote.matchAll(/(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})(?:日)?/g);
  for (const mention of dateMentions) {
    if (Number(mention[1]) === year && Number(mention[2]) === month && Number(mention[3]) === day) return true;
  }
  return false;
}

function quoteDescribesCompletedEvent(quote: string, event: 'disclosure' | 'use_change'): boolean {
  // Modal/prospective language means the quote may describe a plan, not an
  // event that has occurred. Ambiguous wording intentionally fails closed.
  if (/(?:拟|计划|预计|将于|将要|尚未|待披露|待实施|待生效|拟变更|计划变更)/.test(quote)) return false;
  if (event === 'disclosure') {
    return /(?:已|已经).{0,40}(?:对外)?(?:公开)?(?:披露|公告|发布)/.test(quote);
  }
  return /用途.{0,40}(?:已开始使用|已使用|已开始实施|已实施|已开始执行|已执行|已生效)|(?:已开始使用|已使用|已开始实施|已实施|已开始执行|已执行|已生效).{0,40}用途/.test(quote);
}

function citationsBindActualEvent(
  field: CpFundsUseChangeEvidenceValue,
  event: 'disclosure' | 'use_change',
): boolean {
  return field.citations.length > 0 && field.citations.every(citation =>
    citationIsComplete(citation) &&
    quoteContainsDate(citation.quote, field.value) &&
    quoteDescribesCompletedEvent(citation.quote, event),
  );
}

/**
 * A date strictly earlier than the effective date is consistent with prior
 * disclosure only when each source quote anchors the exact date and describes
 * a completed event. Prospective, future, same-day, or ambiguous evidence stays
 * in review. No calendar-day or business-day adjustment is inferred.
 */
export function checkCpFundsUseChangeEvidence(
  input: CpFundsUseChangeEvidenceInput,
): CpFundsUseChangeEvidenceResult {
  const reasons: string[] = [];
  const fields = [input.disclosureDate, input.changedUseEffectiveDate];

  if (!isCalendarDate(input.checkedOn)) reasons.push('checked_on_date_invalid');
  if (fields.some(field => !hasEvidence(field))) reasons.push('evidence_missing_or_unlocated');
  if (fields.some(field => field.uncertainty !== 'clear')) reasons.push('evidence_uncertain');
  if (fields.some(hasConflict)) reasons.push('conflicting_source_assertions');
  if (fields.some(field => !isCalendarDate(field.value))) reasons.push('invalid_or_missing_calendar_date');
  if (fields.some(field => field.citations.some(citation => citationIsComplete(citation) && !quoteContainsDate(citation.quote, field.value)))) {
    reasons.push('date_not_bound_to_citation_quote');
  }
  if (!citationsBindActualEvent(input.disclosureDate, 'disclosure')) reasons.push('actual_disclosure_event_not_proven');
  if (!citationsBindActualEvent(input.changedUseEffectiveDate, 'use_change')) reasons.push('actual_use_change_event_not_proven');
  if (isCalendarDate(input.checkedOn) && fields.some(field => isCalendarDate(field.value) && field.value > input.checkedOn)) {
    reasons.push('future_event_date_unresolved');
  }

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
