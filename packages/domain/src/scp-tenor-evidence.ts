/**
 * Evidence-shape and unambiguous-boundary check for the SCP 270-day tenor.
 * This is deliberately not a legal-compliance or production-capability check:
 * the 270-day endpoint, leap-day crossing and holiday postponement conventions
 * have no confirmed authoritative basis and always stay in review.
 */

export type ScpTenorEvidenceCitation = {
  sourceRefId: string;
  materialVersion: string;
  locator: string;
  quote: string;
};

export type ScpTenorEvidenceValue<T> = {
  value: T;
  citations: ScpTenorEvidenceCitation[];
  uncertainty: 'clear' | 'uncertain';
  conflictingAssertions?: Array<{
    value: T;
    citations: ScpTenorEvidenceCitation[];
  }>;
};

export type ScpTenorEvidenceInput = {
  instrument: ScpTenorEvidenceValue<'scp' | 'cp' | 'mtn' | 'other'>;
  /** Tenor as stated in the offering terms, in calendar days. */
  statedTenorDays: ScpTenorEvidenceValue<number>;
  interestStartDate: ScpTenorEvidenceValue<string>;
  maturityDate: ScpTenorEvidenceValue<string>;
  dateAdjustment: ScpTenorEvidenceValue<'none' | 'applied' | 'unknown'>;
};

export type ScpTenorEvidenceDecision =
  | 'evidence_shape_pass'
  | 'tenor_exceeds_270_days'
  | 'needs_review';

export type ScpTenorEvidenceResult = {
  decision: ScpTenorEvidenceDecision;
  reasons: string[];
  evidence: ScpTenorEvidenceInput;
};

export const SCP_MAX_TENOR_DAYS = 270;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MILLISECONDS_PER_DAY = 86_400_000;

function isCalendarDate(value: string): boolean {
  if (typeof value !== 'string') return false;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWellFormedCitation(citation: unknown): boolean {
  if (!isRecord(citation)) return false;
  return typeof citation.sourceRefId === 'string' && citation.sourceRefId.trim().length > 0 &&
    typeof citation.materialVersion === 'string' && citation.materialVersion.trim().length > 0 &&
    typeof citation.locator === 'string' && citation.locator.trim().length > 0 &&
    typeof citation.quote === 'string' && citation.quote.trim().length > 0;
}

function hasEvidence(field: ScpTenorEvidenceValue<unknown>): boolean {
  return Array.isArray(field.citations) && field.citations.length > 0 && field.citations.every(isWellFormedCitation);
}

function hasConflict(field: ScpTenorEvidenceValue<unknown>): boolean {
  const conflicts = field.conflictingAssertions;
  if (conflicts === undefined) return false;
  if (!Array.isArray(conflicts)) return true;
  return conflicts.some(assertion =>
    !isRecord(assertion) || assertion.value !== field.value ||
    !Array.isArray(assertion.citations) || assertion.citations.length === 0 ||
    assertion.citations.some(citation => !isWellFormedCitation(citation)),
  );
}

function daySpan(start: string, maturity: string): number {
  const [startYear, startMonth, startDay] = start.split('-').map(Number) as [number, number, number];
  const [maturityYear, maturityMonth, maturityDay] = maturity.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(maturityYear, maturityMonth - 1, maturityDay) - Date.UTC(startYear, startMonth - 1, startDay)) / MILLISECONDS_PER_DAY);
}

function crossesLeapDay(start: string, maturity: string): boolean {
  const startYear = Number(start.slice(0, 4));
  const maturityYear = Number(maturity.slice(0, 4));
  for (let year = startYear; year <= maturityYear; year += 1) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    if (!leap) continue;
    const february29 = `${year}-02-29`;
    if (start <= february29 && february29 <= maturity) return true;
  }
  return false;
}

/**
 * Checks only a conservative evidence shape and cases clearly inside/outside
 * 270 calendar days. No inclusive/exclusive endpoint, leap-day or holiday
 * postponement convention is inferred. The input evidence is returned intact.
 */
export function checkScpTenorEvidence(input: ScpTenorEvidenceInput): ScpTenorEvidenceResult {
  const reasons: string[] = [];
  if (!isRecord(input)) return { decision: 'needs_review', reasons: ['evidence_missing_or_unlocated'], evidence: input };
  const rawFields: unknown[] = [input.instrument, input.statedTenorDays, input.interestStartDate, input.maturityDate, input.dateAdjustment];
  if (rawFields.some(field => !isRecord(field))) {
    return { decision: 'needs_review', reasons: ['evidence_missing_or_unlocated'], evidence: input };
  }
  const fields = rawFields as ScpTenorEvidenceValue<unknown>[];
  if (fields.some(field => !hasEvidence(field))) reasons.push('evidence_missing_or_unlocated');
  if (fields.some(field => field.uncertainty !== 'clear')) reasons.push('evidence_uncertain');
  if (fields.some(field => hasConflict(field))) reasons.push('conflicting_source_assertions');

  if (input.instrument.value !== 'scp') reasons.push('instrument_not_confirmed_scp');
  const start = input.interestStartDate.value;
  const maturity = input.maturityDate.value;
  const statedTenorDays = input.statedTenorDays.value;
  if (!isCalendarDate(start) || !isCalendarDate(maturity)) reasons.push('invalid_or_missing_calendar_date');
  if (!Number.isInteger(statedTenorDays) || statedTenorDays <= 0) reasons.push('invalid_stated_tenor');
  if (input.dateAdjustment.value !== 'none') reasons.push('date_adjustment_unresolved');

  if (reasons.length) return { decision: 'needs_review', reasons, evidence: input };
  if (daySpan(start, maturity) <= 0) {
    return { decision: 'needs_review', reasons: ['non_increasing_or_same_dates'], evidence: input };
  }

  const span = daySpan(start, maturity);
  if (span !== statedTenorDays) {
    return { decision: 'needs_review', reasons: ['stated_tenor_conflicts_with_explicit_dates'], evidence: input };
  }
  if (crossesLeapDay(start, maturity)) {
    return { decision: 'needs_review', reasons: ['leap_day_tenor_unresolved'], evidence: input };
  }
  if (span === SCP_MAX_TENOR_DAYS) {
    return { decision: 'needs_review', reasons: ['270_day_endpoint_unresolved'], evidence: input };
  }
  return span < SCP_MAX_TENOR_DAYS
    ? { decision: 'evidence_shape_pass', reasons: ['clear_scp_tenor_within_270_calendar_days'], evidence: input }
    : { decision: 'tenor_exceeds_270_days', reasons: ['clear_scp_tenor_longer_than_270_calendar_days'], evidence: input };
}
