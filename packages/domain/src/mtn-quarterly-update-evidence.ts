/**
 * Research-only evidence-shape review for MTN quarterly refresh inputs.
 *
 * A shape pass means only that the supplied facts have citations and their
 * dates/periods are structurally usable. It does not decide whether NA022
 * applies, what "全面更新" requires, or whether an offering document complies.
 */

import type {
  MtnEvidenceValue,
  MtnIssuerTier,
  MtnRegistrationArrangement,
} from './mtn-registration-evidence.js';

export type MtnQuarterlyPeriod = {
  periodId: string;
  startDate: string;
  endDate: string;
};

export type MtnQuarterlyUpdateEvidenceInput = {
  actualInstrument: MtnEvidenceValue<'mtn' | 'other' | 'unknown'>;
  issuerEntityId: MtnEvidenceValue<string>;
  issuerTier: MtnEvidenceValue<MtnIssuerTier>;
  registrationArrangement: MtnEvidenceValue<MtnRegistrationArrangement>;
  /** Date of the actual market issuance behavior, not a project/file date. */
  issuanceEventDate: MtnEvidenceValue<string>;
  firstMarketIssuance: MtnEvidenceValue<
    'first_market_issuance' | 'prior_market_issuance_exists' | 'unknown'
  >;
  latestQuarterlyReportPeriod: MtnEvidenceValue<MtnQuarterlyPeriod>;
  quarterlyReportPublicationDate: MtnEvidenceValue<string>;
  quarterlyReportSourceSha256: MtnEvidenceValue<string>;
  documentCoveragePeriod: MtnEvidenceValue<MtnQuarterlyPeriod>;
};

export type MtnQuarterlyUpdateEvidenceDecision =
  | 'evidence_shape_pass'
  | 'evidence_conflict'
  | 'needs_review';

export type MtnQuarterlyUpdateEvidenceResult = {
  decision: MtnQuarterlyUpdateEvidenceDecision;
  reasons: string[];
  engineeringOnly: true;
  evidence: MtnQuarterlyUpdateEvidenceInput;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function validDate(value: string | null): value is string {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day || month > 12) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function hasValidCitations(citations: MtnEvidenceValue<unknown>['citations']): boolean {
  return citations.length > 0 && citations.every(citation =>
    citation.sourceRefId.trim().length > 0 && citation.materialVersion.trim().length > 0 &&
    citation.locator.trim().length > 0 && citation.quote.trim().length > 0);
}

function hasCitations(field: MtnEvidenceValue<unknown>): boolean {
  return hasValidCitations(field.citations);
}

function usable(field: MtnEvidenceValue<unknown>): boolean {
  return field.value !== null && field.uncertainty === 'clear' &&
    !(field.conflictingAssertions?.length) && hasCitations(field);
}

function periodIsValid(period: MtnQuarterlyPeriod | null): period is MtnQuarterlyPeriod {
  return period !== null && period.periodId.trim().length > 0 &&
    validDate(period.startDate) && validDate(period.endDate) && period.startDate <= period.endDate;
}

/**
 * Checks required citations, date/period shape, and whether the cited quarterly
 * data could have been available by the cited issuance date. It deliberately
 * leaves trigger applicability and document sufficiency for human review.
 */
export function checkMtnQuarterlyUpdateEvidence(
  input: MtnQuarterlyUpdateEvidenceInput,
): MtnQuarterlyUpdateEvidenceResult {
  const review: string[] = [];
  const conflicts: string[] = [];
  const requiredFields: Array<[string, MtnEvidenceValue<unknown>]> = [
    ['actual_instrument', input.actualInstrument],
    ['issuer_entity_id', input.issuerEntityId],
    ['issuer_tier', input.issuerTier],
    ['registration_arrangement', input.registrationArrangement],
    ['issuance_event_date', input.issuanceEventDate],
    ['first_market_issuance_status', input.firstMarketIssuance],
    ['latest_quarterly_report_period', input.latestQuarterlyReportPeriod],
    ['quarterly_report_publication_date', input.quarterlyReportPublicationDate],
    ['quarterly_report_source_sha256', input.quarterlyReportSourceSha256],
    ['document_coverage_period', input.documentCoveragePeriod],
  ];

  for (const [name, field] of requiredFields) {
    if (!usable(field)) review.push(`${name}_missing_uncited_or_uncertain`);
    if (field.conflictingAssertions?.some(assertion => assertion.value !== field.value &&
        hasValidCitations(assertion.citations))) {
      conflicts.push(`${name}_cited_assertions_conflict`);
    }
    if (field.conflictingAssertions?.some(assertion => !hasValidCitations(assertion.citations))) {
      review.push(`${name}_conflict_assertion_uncited_or_unanchored`);
    }
  }

  if (input.actualInstrument.value !== 'mtn') review.push('actual_mtn_instrument_not_confirmed');
  if (input.issuerTier.value === 'unknown' || input.registrationArrangement.value === 'unknown') {
    review.push('issuer_tier_or_registration_arrangement_unresolved');
  }
  if (input.firstMarketIssuance.value === 'unknown') review.push('first_market_issuance_unresolved');
  if (!validDate(input.issuanceEventDate.value)) review.push('issuance_event_date_invalid');
  if (!validDate(input.quarterlyReportPublicationDate.value)) review.push('quarterly_report_publication_date_invalid');
  if (!periodIsValid(input.latestQuarterlyReportPeriod.value)) review.push('latest_quarterly_report_period_invalid');
  if (!periodIsValid(input.documentCoveragePeriod.value)) review.push('document_coverage_period_invalid');

  const sourceHash = input.quarterlyReportSourceSha256.value;
  if (sourceHash !== null && !SHA256_PATTERN.test(sourceHash)) review.push('quarterly_report_source_sha256_invalid');

  const eventDate = input.issuanceEventDate.value;
  const publicationDate = input.quarterlyReportPublicationDate.value;
  const reportPeriod = input.latestQuarterlyReportPeriod.value;
  const documentPeriod = input.documentCoveragePeriod.value;
  if (validDate(eventDate) && validDate(publicationDate) && publicationDate > eventDate) {
    review.push('quarterly_report_postdates_issuance_event');
  }
  if (periodIsValid(reportPeriod) && validDate(publicationDate) && reportPeriod.endDate > publicationDate) {
    review.push('quarterly_report_period_ends_after_publication_date');
  }
  if (periodIsValid(reportPeriod) && periodIsValid(documentPeriod) &&
      documentPeriod.endDate < reportPeriod.endDate) {
    review.push('document_coverage_ends_before_latest_quarterly_period');
  }

  const decision = conflicts.length > 0
    ? 'evidence_conflict'
    : review.length > 0
      ? 'needs_review'
      : 'evidence_shape_pass';
  return {
    decision,
    reasons: [...new Set([...conflicts, ...review])],
    engineeringOnly: true,
    evidence: input,
  };
}
