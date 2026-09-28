/**
 * Research-only structural review of MTN registration evidence.
 *
 * This does not determine legal applicability, publication status, or issuer
 * eligibility. A result of evidence_shape_pass means only that the supplied
 * synthetic/evidence fields are located and internally coherent.
 */

export type MtnEvidenceCitation = {
  sourceRefId: string;
  materialVersion: string;
  locator: string;
  quote: string;
};

export type MtnEvidenceValue<T> = {
  value: T | null;
  citations: MtnEvidenceCitation[];
  uncertainty: 'clear' | 'uncertain';
  conflictingAssertions?: Array<{
    value: T | null;
    citations: MtnEvidenceCitation[];
  }>;
};

export type MtnIssuerTier = 'mature_first_class' | 'mature_second_class' | 'basic_tier' | 'unknown';
export type MtnRegistrationArrangement =
  | 'dfi_unified'
  | 'basic_tier_unified_quota'
  | 'product_by_product'
  | 'pdfi_quota'
  | 'unknown';

export type MtnRegistrationNoticeEvidence = {
  noticeId: MtnEvidenceValue<string>;
  sourceMaterialSha256: MtnEvidenceValue<string>;
  issuerEntityId: MtnEvidenceValue<string>;
  coveredInstruments: MtnEvidenceValue<Array<'mtn' | 'cp' | 'scp' | 'perpetual' | 'other'>>;
  acceptedDate: MtnEvidenceValue<string>;
  statedExpiryDate: MtnEvidenceValue<string>;
  statedQuota: MtnEvidenceValue<
    | { status: 'stated'; amount: string; currency: string; minorUnitScale: number }
    | { status: 'explicitly_not_specified' }
  >;
  statedUsedQuota: MtnEvidenceValue<
    | { status: 'stated'; amount: string; currency: string; minorUnitScale: number }
    | { status: 'not_applicable_with_basis' }
  >;
  amendments: MtnEvidenceValue<Array<{ amendmentId: string; locator: string }>>;
};

export type MtnRegistrationEvidenceInput = {
  actualInstrument: MtnEvidenceValue<'mtn' | 'other' | 'unknown'>;
  issuerEntityId: MtnEvidenceValue<string>;
  issuerTier: MtnEvidenceValue<MtnIssuerTier>;
  registrationArrangement: MtnEvidenceValue<MtnRegistrationArrangement>;
  plannedIssueDate: MtnEvidenceValue<string>;
  proposedAmount: MtnEvidenceValue<{ amount: string; currency: string; minorUnitScale: number }>;
  noticeSetCompleteness: MtnEvidenceValue<'complete_current_set' | 'incomplete_or_unknown'>;
  quotaLedgerCompleteness: MtnEvidenceValue<'complete' | 'not_applicable_with_basis' | 'incomplete_or_unknown'>;
  selectedNotice: MtnEvidenceValue<{ noticeId: string; sourceMaterialSha256: string }>;
  transitionBasis: MtnEvidenceValue<'documented' | 'not_applicable_with_basis' | 'unknown'>;
  notices: MtnRegistrationNoticeEvidence[];
};

export type MtnRegistrationEvidenceDecision =
  | 'evidence_shape_pass'
  | 'evidence_conflict'
  | 'needs_review';

export type MtnRegistrationEvidenceResult = {
  decision: MtnRegistrationEvidenceDecision;
  reasons: string[];
  engineeringOnly: true;
  evidence: MtnRegistrationEvidenceInput;
};

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
function validDate(value: string | null): value is string {
  if (value === null) return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day >= 1 && day <= daysInMonth;
}

function hasCitation(citation: MtnEvidenceCitation): boolean {
  return citation.sourceRefId.trim().length > 0 &&
    citation.materialVersion.trim().length > 0 &&
    citation.locator.trim().length > 0 &&
    citation.quote.trim().length > 0;
}

function hasEvidence(field: MtnEvidenceValue<unknown>): boolean {
  return field.citations.length > 0 && field.citations.every(hasCitation);
}

function isClear(field: MtnEvidenceValue<unknown>): boolean {
  return field.uncertainty === 'clear' && !(field.conflictingAssertions?.length);
}

function compareAmount(left: string, right: string): number | null {
  // Integer minor units are used as strings so the checker never rounds money.
  if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) return null;
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function isMoney(value: { amount: string; currency: string; minorUnitScale: number } | null): value is { amount: string; currency: string; minorUnitScale: number } {
  return value !== null && /^\d+$/.test(value.amount) && /^[A-Z]{3}$/.test(value.currency) &&
    Number.isInteger(value.minorUnitScale) && value.minorUnitScale >= 0 && value.minorUnitScale <= 9;
}

function result(
  decision: MtnRegistrationEvidenceDecision,
  reasons: string[],
  evidence: MtnRegistrationEvidenceInput,
): MtnRegistrationEvidenceResult {
  return { decision, reasons, engineeringOnly: true, evidence };
}

/**
 * Checks evidence location, required fields and direct contradictions only.
 * It intentionally does not infer validity periods or quota rules from tier
 * labels. Expired/scope/amount observations require a complete current notice
 * and amendment set before being elevated from needs_review to conflict.
 */
export function checkMtnRegistrationEvidence(input: MtnRegistrationEvidenceInput): MtnRegistrationEvidenceResult {
  const reviewReasons: string[] = [];
  const conflictReasons: string[] = [];
  const commonFields = [
    input.actualInstrument,
    input.issuerEntityId,
    input.issuerTier,
    input.registrationArrangement,
    input.plannedIssueDate,
    input.proposedAmount,
    input.noticeSetCompleteness,
    input.quotaLedgerCompleteness,
    input.selectedNotice,
    input.transitionBasis,
  ];

  if (commonFields.some(field => !hasEvidence(field) || !isClear(field) || field.value === null)) {
    reviewReasons.push('required_context_missing_uncited_or_uncertain');
  }
  if (input.actualInstrument.value !== 'mtn') reviewReasons.push('actual_instrument_not_confirmed_mtn');
  if (input.issuerTier.value === 'unknown') reviewReasons.push('issuer_tier_unresolved');
  if (input.registrationArrangement.value === 'unknown') reviewReasons.push('registration_arrangement_unresolved');
  if (input.transitionBasis.value === 'unknown') reviewReasons.push('historical_transition_basis_unresolved');

  if (input.notices.length === 0) reviewReasons.push('registration_notice_missing');
  if (input.noticeSetCompleteness.value !== 'complete_current_set') {
    reviewReasons.push('current_notice_and_amendment_set_not_proven_complete');
  }

  const plannedDate = input.plannedIssueDate.value;
  const proposed = input.proposedAmount.value;
  if (!validDate(plannedDate)) reviewReasons.push('planned_issue_date_missing_or_invalid');
  if (!isMoney(proposed)) reviewReasons.push('proposed_amount_missing_or_invalid');

  const selectedPinUsable = hasEvidence(input.selectedNotice) && isClear(input.selectedNotice);
  const selectedPin = selectedPinUsable ? input.selectedNotice.value : null;
  const plannedDateUsable = hasEvidence(input.plannedIssueDate) && isClear(input.plannedIssueDate) && validDate(plannedDate);
  const proposedAmountUsable = hasEvidence(input.proposedAmount) && isClear(input.proposedAmount) && isMoney(proposed);
  const currentNoticeSetComplete = hasEvidence(input.noticeSetCompleteness) && isClear(input.noticeSetCompleteness) &&
    input.noticeSetCompleteness.value === 'complete_current_set';
  const quotaLedgerComplete = hasEvidence(input.quotaLedgerCompleteness) && isClear(input.quotaLedgerCompleteness) &&
    input.quotaLedgerCompleteness.value === 'complete';
  if (selectedPin && !SHA256_PATTERN.test(selectedPin.sourceMaterialSha256)) {
    reviewReasons.push('selected_notice_source_hash_invalid');
  }
  const selectedIndexes = selectedPin
    ? input.notices.flatMap((notice, index) =>
      notice.noticeId.value === selectedPin.noticeId &&
      notice.sourceMaterialSha256.value === selectedPin.sourceMaterialSha256 ? [index] : [],
    )
    : [];
  if (selectedIndexes.length !== 1) reviewReasons.push('selected_notice_exact_pin_not_unique_in_current_set');
  const selectedIndex = selectedIndexes.length === 1 ? selectedIndexes[0] : null;
  const selectedNotice = selectedIndex === null ? null : input.notices[selectedIndex]!;
  const quotaArrangement = input.registrationArrangement.value === 'basic_tier_unified_quota' ||
    input.registrationArrangement.value === 'pdfi_quota';
  if (quotaArrangement && selectedNotice?.statedQuota.value?.status !== 'stated') {
    reviewReasons.push('quota_evidence_missing');
  }

  const noticeHashesById = new Map<string, Set<string>>();
  for (const notice of input.notices) {
    const noticeId = notice.noticeId.value;
    const hash = notice.sourceMaterialSha256.value;
    if (noticeId && hash) {
      const hashes = noticeHashesById.get(noticeId) ?? new Set<string>();
      hashes.add(hash);
      noticeHashesById.set(noticeId, hashes);
    }
  }
  const collidingNoticeIds = new Set([...noticeHashesById]
    .filter(([, hashes]) => hashes.size > 1)
    .map(([noticeId]) => noticeId));

  for (const [index, notice] of input.notices.entries()) {
    const noticeFields = [
      notice.noticeId,
      notice.sourceMaterialSha256,
      notice.issuerEntityId,
      notice.coveredInstruments,
      notice.acceptedDate,
      notice.statedExpiryDate,
      notice.amendments,
    ];
    if (noticeFields.some(field => !hasEvidence(field) || !isClear(field) || field.value === null)) {
      reviewReasons.push(`notice_${index}_missing_uncited_or_uncertain_field`);
      continue;
    }
    if (!hasEvidence(notice.statedQuota) || !isClear(notice.statedQuota)) {
      reviewReasons.push(`notice_${index}_quota_missing_uncited_or_uncertain`);
    }
    if (notice.sourceMaterialSha256.value && !SHA256_PATTERN.test(notice.sourceMaterialSha256.value)) {
      reviewReasons.push(`notice_${index}_source_hash_invalid`);
    }
    if (notice.noticeId.value && collidingNoticeIds.has(notice.noticeId.value) &&
      !(selectedPin?.noticeId === notice.noticeId.value &&
        selectedPin.sourceMaterialSha256 === notice.sourceMaterialSha256.value)) {
      // Retain differently hashed versions separately; never treat a reused ID
      // as proof that those source bytes have identical contents.
      reviewReasons.push(`notice_${index}_same_notice_id_different_source_hash`);
    }
    if (hasEvidence(input.issuerEntityId) && isClear(input.issuerEntityId) &&
      hasEvidence(notice.issuerEntityId) && isClear(notice.issuerEntityId) &&
      index === selectedIndex && notice.issuerEntityId.value !== input.issuerEntityId.value) {
      conflictReasons.push(`notice_${index}_issuer_identity_conflict`);
    }
    if (index !== selectedIndex) continue;
    if (notice.coveredInstruments.value === null) {
      reviewReasons.push(`notice_${index}_instrument_scope_missing`);
      continue;
    }

    const accepted = notice.acceptedDate.value;
    const expiry = notice.statedExpiryDate.value;
    if (!validDate(accepted) || !validDate(expiry)) {
      reviewReasons.push(`notice_${index}_dates_missing_or_invalid`);
    } else if (accepted > expiry) {
      conflictReasons.push(`notice_${index}_acceptance_after_stated_expiry`);
    }

    const quota = notice.statedQuota.value?.status === 'stated' ? notice.statedQuota.value : null;
    const usedValue = notice.statedUsedQuota.value;
    const used = usedValue?.status === 'stated' ? usedValue : null;
    if (notice.statedQuota.value === null) {
      // Unknown is not the same as an explicitly evidenced absence of a quota.
      reviewReasons.push(`notice_${index}_quota_state_missing`);
    }
    if (!hasEvidence(notice.statedUsedQuota) || !isClear(notice.statedUsedQuota) || usedValue === null) {
      reviewReasons.push(`notice_${index}_used_quota_state_missing_uncited_or_uncertain`);
    }
    const quotaNotApplicable = notice.statedQuota.value?.status === 'explicitly_not_specified';
    const usedNotApplicable = usedValue?.status === 'not_applicable_with_basis';
    if (quotaNotApplicable !== usedNotApplicable) {
      reviewReasons.push(`notice_${index}_quota_and_usage_state_mismatch`);
    }
    if (quota !== null && !isMoney(quota)) reviewReasons.push(`notice_${index}_quota_invalid`);
    if (used !== null && !isMoney(used)) reviewReasons.push(`notice_${index}_used_quota_invalid`);
    if (quota && used && (quota.currency !== used.currency || quota.minorUnitScale !== used.minorUnitScale)) {
      reviewReasons.push(`notice_${index}_quota_unit_unresolved`);
    }
    if (quota && used && proposed && isMoney(proposed) && quota.currency === used.currency &&
      quota.minorUnitScale === used.minorUnitScale &&
      (proposed.currency !== quota.currency || proposed.minorUnitScale !== quota.minorUnitScale)) {
      reviewReasons.push(`notice_${index}_proposed_amount_unit_unmatched`);
    }

    if (plannedDateUsable && validDate(accepted) && plannedDate < accepted) {
      reviewReasons.push(`notice_${index}_planned_issue_before_acceptance_needs_review`);
    }
    if (plannedDateUsable && validDate(expiry) && plannedDate > expiry) {
      if (currentNoticeSetComplete) {
        conflictReasons.push(`notice_${index}_planned_issue_after_expiry_in_complete_set`);
      } else {
        reviewReasons.push(`notice_${index}_planned_issue_after_expiry_needs_change_review`);
      }
    }

    if (notice.coveredInstruments.value.length === 0) {
      reviewReasons.push(`notice_${index}_instrument_scope_empty`);
    } else if (!notice.coveredInstruments.value.includes('mtn')) {
      if (currentNoticeSetComplete) {
        conflictReasons.push(`notice_${index}_mtn_absent_from_complete_scope`);
      } else {
        reviewReasons.push(`notice_${index}_mtn_scope_needs_change_review`);
      }
    }

    const quotaEvidenceUsable = hasEvidence(notice.statedQuota) && isClear(notice.statedQuota);
    const usedEvidenceUsable = hasEvidence(notice.statedUsedQuota) && isClear(notice.statedUsedQuota);
    if (quota && used && proposed && quotaEvidenceUsable && usedEvidenceUsable && proposedAmountUsable &&
      isMoney(quota) && isMoney(used) && isMoney(proposed) &&
      quota.currency === used.currency && quota.currency === proposed.currency &&
      quota.minorUnitScale === used.minorUnitScale && quota.minorUnitScale === proposed.minorUnitScale) {
      const remaining = compareAmount(quota.amount, used.amount);
      const proposedVsRemaining = remaining === null ? null : compareAmount(proposed.amount, (BigInt(quota.amount) - BigInt(used.amount)).toString());
      if (remaining !== null && remaining < 0) conflictReasons.push(`notice_${index}_used_quota_exceeds_stated_quota`);
      else if (proposedVsRemaining !== null && proposedVsRemaining > 0) {
        if (currentNoticeSetComplete && quotaLedgerComplete) {
          conflictReasons.push(`notice_${index}_proposed_amount_exceeds_complete_ledger`);
        } else {
          reviewReasons.push(`notice_${index}_proposed_amount_needs_other_notice_or_change_review`);
        }
      }
    }
  }

  const selectedHasQuota = selectedNotice?.statedQuota.value?.status === 'stated';
  const selectedQuotaNotApplicable = selectedNotice?.statedQuota.value?.status === 'explicitly_not_specified' &&
    selectedNotice.statedUsedQuota.value?.status === 'not_applicable_with_basis';
  if (selectedHasQuota && input.quotaLedgerCompleteness.value !== 'complete') {
    reviewReasons.push('current_quota_ledger_completeness_unproven');
  }
  if (selectedQuotaNotApplicable && input.quotaLedgerCompleteness.value !== 'not_applicable_with_basis') {
    reviewReasons.push('quota_ledger_not_marked_not_applicable');
  }

  if (conflictReasons.length > 0) return result('evidence_conflict', [...new Set(conflictReasons)], input);
  if (reviewReasons.length > 0) return result('needs_review', [...new Set(reviewReasons)], input);
  return result('evidence_shape_pass', ['supplied_registration_evidence_is_located_and_coherent'], input);
}
