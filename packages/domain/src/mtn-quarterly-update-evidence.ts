/**
 * Research-only evidence-shape review for MTN quarterly refresh inputs.
 *
 * A shape pass means only that the supplied facts have citations and their
 * dates/periods are structurally usable. It does not decide whether NA022
 * applies, what "全面更新" requires, or whether an offering document complies.
 *
 * NA022 PAGE001 item 4 reads: after a new quarterly accounting report is
 * disclosed, an enterprise that then issues debt financing instruments to
 * interbank market institutional investors for the first time should fully
 * refresh the prospectus. This checker therefore keeps four separate pieces of
 * cited evidence and their order: the new quarterly report disclosure, the
 * actual issuance behavior, the "first market issuance" status, and the
 * interbank-institutional investor scope. A claim of "the first tranche under
 * the new registration notice" or a file/project date is not a substitute.
 *
 * NA058 P00015/P00017 is a narrow exception (first-class issuers and listed
 * companies, Q1/Q3 only, movement analysis content only). The latest balance
 * sheet, income statement and cash-flow statement, their data source, and the
 * consolidated-plus-parent presentation remain mandatory. A listed company
 * under investigation, administrative penalty or association self-discipline
 * sanction in the prior year and current period is excluded. NA058 is a
 * compilation whose file date does not establish unconditional 2026 effect.
 * Where the NA022 trigger and an NA058 exception intersect, the checker never
 * grants the omission; it returns needs_review for human decision.
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

/** Investor scope of the actual issuance behavior, preserving 面向银行间市场机构投资者. */
export type MtnQuarterlyInvestorScope = 'interbank-institutional' | 'other' | 'unknown';

/**
 * The trigger basis actually asserted for the refresh. NA022 item 4 is a new
 * quarterly report disclosure followed by a first interbank-institutional
 * issuance; "新注册通知书项下第一期" is a different assertion.
 */
export type MtnQuarterlyTriggerBasis =
  | 'new_quarterly_report_then_first_market_issuance'
  | 'registration_notice_first_period'
  | 'unknown';

export type MtnQuarterlyReportKind = 'q1' | 'q3' | 'half_year' | 'annual' | 'unknown';
export type MtnQuarterlyNa058IssuerBasis = 'first_class' | 'listed_company' | 'other' | 'unknown';

/** NA058 P00015/P00017 exception, restricted to the movement-analysis update only. */
export type MtnQuarterlyNa058ExceptionEvidence = {
  claimed: MtnEvidenceValue<boolean>;
  issuerBasis: MtnEvidenceValue<MtnQuarterlyNa058IssuerBasis>;
  reportKind: MtnEvidenceValue<MtnQuarterlyReportKind>;
  scope: MtnEvidenceValue<'movement_analysis_only' | 'entire_quarterly_section' | 'unknown'>;
  statementListing: {
    latestStatements: MtnEvidenceValue<boolean>;
    dataSource: MtnEvidenceValue<boolean>;
    consolidatedAndParent: MtnEvidenceValue<boolean | 'not_applicable'>;
  };
  listedCompanyCleanRecord: MtnEvidenceValue<boolean | 'not_applicable' | 'unknown'>;
  effectivityBasis: MtnEvidenceValue<'qa_publication_2022_05_25' | 'compilation_file_date' | 'unstated'>;
};

export type MtnQuarterlyUpdateEvidenceInput = {
  actualInstrument: MtnEvidenceValue<'mtn' | 'other' | 'unknown'>;
  issuerEntityId: MtnEvidenceValue<string>;
  issuerTier: MtnEvidenceValue<MtnIssuerTier>;
  registrationArrangement: MtnEvidenceValue<MtnRegistrationArrangement>;
  /** Actual interbank-institutional investor scope of the issuance behavior. */
  investorScope: MtnEvidenceValue<MtnQuarterlyInvestorScope>;
  /** Asserted trigger basis; must not be rewritten as "新注册通知书项下第一期". */
  triggerBasis: MtnEvidenceValue<MtnQuarterlyTriggerBasis>;
  /** Date of the actual market issuance behavior, not a project/file date. */
  issuanceEventDate: MtnEvidenceValue<string>;
  firstMarketIssuance: MtnEvidenceValue<
    'first_market_issuance' | 'prior_market_issuance_exists' | 'unknown'
  >;
  latestQuarterlyReportPeriod: MtnEvidenceValue<MtnQuarterlyPeriod>;
  quarterlyReportPublicationDate: MtnEvidenceValue<string>;
  quarterlyReportSourceSha256: MtnEvidenceValue<string>;
  documentCoveragePeriod: MtnEvidenceValue<MtnQuarterlyPeriod>;
  /** Present only when the issuer asserts the NA058 quarterly movement-analysis exception. */
  na058Exception?: MtnQuarterlyNa058ExceptionEvidence | null;
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

/** Structural equality for evidence values restricted to JSON-compatible data. */
function jsonEvidenceValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return typeof left !== 'number' || Number.isFinite(left);
  if (left === null || right === null || typeof left !== typeof right) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => jsonEvidenceValuesEqual(value, right[index]));
  }
  const leftPrototype = Object.getPrototypeOf(left);
  const rightPrototype = Object.getPrototypeOf(right);
  if ((leftPrototype !== Object.prototype && leftPrototype !== null) ||
      (rightPrototype !== Object.prototype && rightPrototype !== null)) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && jsonEvidenceValuesEqual(leftRecord[key], rightRecord[key]));
}

function usable(field: MtnEvidenceValue<unknown>): boolean {
  return field.value !== null && field.uncertainty === 'clear' &&
    !(field.conflictingAssertions?.some(assertion =>
      !jsonEvidenceValuesEqual(assertion.value, field.value) || !hasValidCitations(assertion.citations))) &&
    hasCitations(field);
}

function periodIsValid(period: MtnQuarterlyPeriod | null): period is MtnQuarterlyPeriod {
  return period !== null && period.periodId.trim().length > 0 &&
    validDate(period.startDate) && validDate(period.endDate) && period.startDate <= period.endDate;
}

/** Rejects a cited conflicting assertion only when it is anchored to the same field. */
function pushConflictIfCited(
  fieldName: string,
  field: MtnEvidenceValue<unknown>,
  conflicts: string[],
): void {
  if (hasCitations(field) && field.conflictingAssertions?.some(assertion =>
      !jsonEvidenceValuesEqual(assertion.value, field.value) &&
      hasValidCitations(assertion.citations))) {
    conflicts.push(`${fieldName}_cited_assertions_conflict`);
  }
}

function checkNa058Exception(
  exception: MtnQuarterlyNa058ExceptionEvidence,
  review: string[],
): void {
  if (!usable(exception.claimed) || typeof exception.claimed.value !== 'boolean') {
    review.push('na058_exception_claim_missing_uncited_or_uncertain');
    return;
  }
  if (exception.claimed.value !== true) return;

  // A claimed exemption is never machine-approved; the intersection with NA022
  // is added by the caller.
  review.push('na058_exception_requires_human_review');
  review.push('na058_exception_not_a_machine_approval');

  const issuerBasisUsable = usable(exception.issuerBasis);
  if (!issuerBasisUsable) review.push('na058_exception_issuer_basis_missing_uncited_or_uncertain');
  else if (exception.issuerBasis.value !== 'first_class' && exception.issuerBasis.value !== 'listed_company') {
    review.push('na058_exception_issuer_not_first_class_or_listed_company');
  }
  const issuerBasis = issuerBasisUsable ? exception.issuerBasis.value : null;

  if (!usable(exception.reportKind)) review.push('na058_exception_report_kind_missing_uncited_or_uncertain');
  else if (exception.reportKind.value !== 'q1' && exception.reportKind.value !== 'q3') {
    // NA058 names Q1/Q3 only; half-year or annual reports cannot extend the exception.
    review.push('na058_exception_report_kind_not_quarterly');
  }

  if (!usable(exception.scope)) review.push('na058_exception_scope_missing_uncited_or_uncertain');
  else if (exception.scope.value !== 'movement_analysis_only') {
    review.push('na058_exception_scope_expanded_beyond_movement_analysis');
  }

  const listing = exception.statementListing;
  if (!usable(listing.latestStatements)) {
    review.push('na058_exception_latest_statements_missing_uncited_or_uncertain');
  } else if (listing.latestStatements.value !== true) {
    review.push('na058_exception_latest_statements_listing_missing');
  }
  if (!usable(listing.dataSource)) {
    review.push('na058_exception_data_source_missing_uncited_or_uncertain');
  } else if (listing.dataSource.value !== true) {
    review.push('na058_exception_statement_data_source_missing');
  }
  if (!usable(listing.consolidatedAndParent)) {
    review.push('na058_exception_parent_statements_missing_uncited_or_uncertain');
  } else if (listing.consolidatedAndParent.value === false) {
    review.push('na058_exception_consolidated_and_parent_statements_missing');
  }

  if (!usable(exception.listedCompanyCleanRecord)) {
    review.push('na058_exception_clean_record_missing_uncited_or_uncertain');
  } else if (exception.listedCompanyCleanRecord.value === false) {
    review.push('na058_exception_enforcement_record_excluded');
  } else if (exception.listedCompanyCleanRecord.value === 'unknown') {
    review.push('na058_exception_clean_record_unresolved');
  } else if (exception.listedCompanyCleanRecord.value === 'not_applicable' && issuerBasis === 'listed_company') {
    review.push('na058_exception_listed_company_clean_record_required');
  }

  if (!usable(exception.effectivityBasis)) {
    review.push('na058_exception_effectivity_basis_missing_uncited_or_uncertain');
  } else if (exception.effectivityBasis.value === 'compilation_file_date') {
    review.push('na058_exception_effectivity_from_compilation_file_date_not_allowed');
  } else if (exception.effectivityBasis.value !== 'qa_publication_2022_05_25') {
    review.push('na058_exception_effectivity_basis_unresolved');
  }
}

/**
 * Checks required citations, the retained NA022 trigger elements and their
 * order, date/period shape, and the precise NA058 exception limits. It
 * deliberately leaves trigger applicability and document sufficiency for
 * human review and never returns a compliance conclusion.
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
    ['investor_scope', input.investorScope],
    ['trigger_basis', input.triggerBasis],
    ['issuance_event_date', input.issuanceEventDate],
    ['first_market_issuance_status', input.firstMarketIssuance],
    ['latest_quarterly_report_period', input.latestQuarterlyReportPeriod],
    ['quarterly_report_publication_date', input.quarterlyReportPublicationDate],
    ['quarterly_report_source_sha256', input.quarterlyReportSourceSha256],
    ['document_coverage_period', input.documentCoveragePeriod],
  ];

  for (const [name, field] of requiredFields) {
    if (!usable(field)) review.push(`${name}_missing_uncited_or_uncertain`);
    pushConflictIfCited(name, field, conflicts);
    if (field.conflictingAssertions?.some(assertion => !hasValidCitations(assertion.citations))) {
      review.push(`${name}_conflict_assertion_uncited_or_unanchored`);
    }
  }

  if (input.actualInstrument.value !== 'mtn') review.push('actual_mtn_instrument_not_confirmed');
  if (input.issuerEntityId.value === null || !input.issuerEntityId.value.trim()) {
    review.push('issuer_entity_id_empty');
  }
  if (input.issuerTier.value === 'unknown' || input.registrationArrangement.value === 'unknown') {
    review.push('issuer_tier_or_registration_arrangement_unresolved');
  }
  if (input.firstMarketIssuance.value === 'unknown') review.push('first_market_issuance_unresolved');

  // Keep the interbank-institutional investor scope; another scope is a different trigger.
  if (input.investorScope.value !== 'interbank-institutional') {
    review.push('investor_scope_not_interbank_institutional');
  }

  // Reject the rewritten trigger (新注册通知书项下第一期) and unresolved bases.
  if (input.triggerBasis.value === 'registration_notice_first_period') {
    review.push('trigger_basis_rewritten_to_registration_notice_first_period');
  } else if (input.triggerBasis.value !== 'new_quarterly_report_then_first_market_issuance') {
    review.push('trigger_basis_unresolved_or_not_na022_reading');
  }

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
  if (validDate(eventDate) && validDate(publicationDate)) {
    // "在新的季度会计报表披露后" requires disclosure strictly before issuance.
    if (publicationDate > eventDate) review.push('quarterly_report_postdates_issuance_event');
    else if (publicationDate === eventDate) {
      review.push('quarterly_report_publication_not_before_issuance_event');
    }
  }
  if (periodIsValid(reportPeriod) && validDate(publicationDate) && reportPeriod.endDate > publicationDate) {
    review.push('quarterly_report_period_ends_after_publication_date');
  }
  if (periodIsValid(reportPeriod) && periodIsValid(documentPeriod) &&
      documentPeriod.endDate < reportPeriod.endDate) {
    review.push('document_coverage_ends_before_latest_quarterly_period');
  }

  if (input.na058Exception) checkNa058Exception(input.na058Exception, review);

  const na058Claimed = Boolean(input.na058Exception) &&
    usable(input.na058Exception!.claimed) && input.na058Exception!.claimed.value === true;
  const na022FirstMarketTrigger =
    input.triggerBasis.value === 'new_quarterly_report_then_first_market_issuance' &&
    input.firstMarketIssuance.value === 'first_market_issuance' &&
    input.investorScope.value === 'interbank-institutional';
  if (na058Claimed && na022FirstMarketTrigger) {
    // NA022 and NA058 intersect here; do not apply an omission automatically.
    review.push('na058_na022_intersection_requires_human_review');
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
