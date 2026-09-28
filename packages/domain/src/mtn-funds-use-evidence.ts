/**
 * Research-only evidence-shape review for MTN proceeds use.
 *
 * It preserves cited source values and stage distinctions. It does not decide
 * legal/policy compliance, whether a use is sensitive, or whether a change
 * procedure is legally sufficient.
 */

import type { MtnEvidenceValue, MtnIssuerTier, MtnRegistrationArrangement } from './mtn-registration-evidence.js';

export type MtnFundsUseStage = 'registration' | 'issuance' | 'unknown';
type MtnFundsUseMoneyBase = {
  /** Exact currency code/text as cited. */
  currency: string;
  /** Exact unit text as cited, e.g. 元、万元、亿元. */
  unit: string;
};
/** A cited amount keeps its source qualifier; limits and estimates are not exact values. */
export type MtnFundsUseMoney = MtnFundsUseMoneyBase & (
  | { kind: 'exact'; amount: string }
  | { kind: 'upper_bound'; amount: string }
  | { kind: 'lower_bound'; amount: string }
  | { kind: 'estimate'; amount: string }
  | { kind: 'range'; minimum: string; maximum: string }
);
type ExactMtnFundsUseMoney = Extract<MtnFundsUseMoney, { kind: 'exact' }>;

export type MtnFundsUseLineEvidence = {
  lineId: MtnEvidenceValue<string>;
  /** Original use wording/category, not a normalized legal conclusion. */
  useDescription: MtnEvidenceValue<string>;
  detailLevel: MtnEvidenceValue<'broad_category' | 'specific'>;
  amount: MtnEvidenceValue<MtnFundsUseMoney>;
  policySensitivity: MtnEvidenceValue<'sensitive' | 'not_identified_as_sensitive' | 'unresolved'>;
};

export type MtnFundsUseChangeProcedureEvidence = {
  changeStatus: MtnEvidenceValue<'no_change_asserted' | 'changed_or_outside_registration_scope' | 'unknown'>;
  procedureStatus: MtnEvidenceValue<'documented' | 'not_applicable_with_basis' | 'unresolved'>;
  /** The procedure/source assertion is kept verbatim with its own citation. */
  procedureDescription: MtnEvidenceValue<string | null>;
  disclosureDate: MtnEvidenceValue<string | null>;
  intendedUseDate: MtnEvidenceValue<string | null>;
  /** Preserve the cited business-day lead time; no calendar conversion is done. */
  statedLeadTimeBusinessDays: MtnEvidenceValue<number | null>;
};

export type MtnFundsUseEvidenceInput = {
  actualInstrument: MtnEvidenceValue<'mtn' | 'other' | 'unknown'>;
  stage: MtnEvidenceValue<MtnFundsUseStage>;
  issuerTier: MtnEvidenceValue<MtnIssuerTier>;
  registrationArrangement: MtnEvidenceValue<MtnRegistrationArrangement>;
  useLines: MtnFundsUseLineEvidence[];
  /** Registration estimate total or the exact issuance total, as applicable. */
  statedTotal: MtnEvidenceValue<MtnFundsUseMoney>;
  changeProcedure: MtnFundsUseChangeProcedureEvidence;
};

export type MtnFundsUseEvidenceDecision = 'evidence_shape_pass' | 'evidence_conflict' | 'needs_review';

export type MtnFundsUseEvidenceResult = {
  decision: MtnFundsUseEvidenceDecision;
  reasons: string[];
  engineeringOnly: true;
  evidence: MtnFundsUseEvidenceInput;
};

function hasCitation(citation: MtnEvidenceValue<unknown>['citations'][number]): boolean {
  return citation.sourceRefId.trim().length > 0 && citation.materialVersion.trim().length > 0 &&
    citation.locator.trim().length > 0 && citation.quote.trim().length > 0;
}

function usable<T>(field: MtnEvidenceValue<T>): field is MtnEvidenceValue<T> & { value: T } {
  return field.value !== null && field.uncertainty === 'clear' && !field.conflictingAssertions?.length &&
    field.citations.length > 0 && field.citations.every(hasCitation);
}

function validMoney(value: MtnFundsUseMoney): boolean {
  const validAmount = (amount: string) => /^\d+(?:\.\d+)?$/.test(amount);
  return value.currency.trim().length > 0 && value.unit.trim().length > 0 &&
    (value.kind === 'range'
      ? validAmount(value.minimum) && validAmount(value.maximum) && amountsCompare(value.minimum, value.maximum) <= 0
      : validAmount(value.amount));
}

function amountsCompare(left: string, right: string): number {
  const a = amountInSourceUnits(left)!;
  const b = amountInSourceUnits(right)!;
  const scale = Math.max(a.scale, b.scale);
  const leftValue = a.integer * 10n ** BigInt(scale - a.scale);
  const rightValue = b.integer * 10n ** BigInt(scale - b.scale);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

const amountQualifierPatterns: Record<Exclude<MtnFundsUseMoney['kind'], 'exact'>, RegExp> = {
  upper_bound: /(?:不超过|不高于|不得超过|最高|至多|上限|不大于|≤|<=|at\s+most|up\s+to|no\s+more\s+than|not\s+exceed)[^\d]{0,8}[\d,.]+|[\d,.]+\s*(?:元|万元|亿元|万|亿)?\s*(?:以内|以下)/i,
  lower_bound: /(?:至少|不低于|不得低于|不小于|不少于|下限|≥|>=|at\s+least|no\s+less\s+than)[^\d]{0,8}[\d,.]+|[\d,.]+\s*(?:元|万元|亿元|万|亿)?\s*(?:以上)/i,
  estimate: /(?:约|预计|预估|大约|估计)[^\d]{0,12}[\d,.]+|(?:approximately|around|estimated?)[^\d]{0,12}[\d,.]+|[\d,.]+\s*(?:元|万元|亿元|万|亿)?\s*(?:左右)/i,
  range: /(?:区间|范围|介于)\s*[\d,.]+|[\d,.]+\s*(?:元|万元|亿元|万|亿)?\s*(?:至|到|[-–—])\s*[\d,.]+|between\s+[\d,.]+\s+and\s+[\d,.]+/i,
};
const pendingAllocationPattern = /按需|结合需要确定|视实际需要|实际需要确定|待分配|尚未确定|待明确|subject\s+to\s+demand/i;

function amountSemanticsMatchCitations(money: MtnFundsUseMoney, citations: MtnEvidenceValue<unknown>['citations']): boolean {
  const quotes = citations.map(citation => citation.quote);
  if (money.kind === 'exact') {
    return ![...Object.values(amountQualifierPatterns), pendingAllocationPattern]
      .some(pattern => quotes.some(quote => pattern.test(quote)));
  }
  const expected = amountQualifierPatterns[money.kind];
  return quotes.some(quote => expected.test(quote)) &&
    !Object.entries(amountQualifierPatterns)
      .some(([kind, pattern]) => kind !== money.kind && quotes.some(quote => pattern.test(quote)));
}

function validDate(value: string | null): value is string {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day || month > 12) return false;
  const actual = new Date(Date.UTC(year, month - 1, day));
  return actual.getUTCFullYear() === year && actual.getUTCMonth() === month - 1 && actual.getUTCDate() === day;
}

function amountInSourceUnits(amount: string): { scale: number; integer: bigint } | null {
  if (!/^\d+(?:\.\d+)?$/.test(amount)) return null;
  const [whole, fraction = ''] = amount.split('.');
  return { scale: fraction.length, integer: BigInt(`${whole}${fraction}`) };
}

function sameUnit(left: MtnFundsUseMoney, right: MtnFundsUseMoney): boolean {
  return left.currency === right.currency && left.unit === right.unit;
}

function amountsEqual(left: MtnFundsUseMoney, right: MtnFundsUseMoney): boolean | null {
  if (left.kind !== 'exact' || right.kind !== 'exact') return null;
  if (!sameUnit(left, right)) return null;
  const a = amountInSourceUnits(left.amount);
  const b = amountInSourceUnits(right.amount);
  if (!a || !b) return null;
  const scale = Math.max(a.scale, b.scale);
  return a.integer * 10n ** BigInt(scale - a.scale) === b.integer * 10n ** BigInt(scale - b.scale);
}

function sumExactAmounts(values: ExactMtnFundsUseMoney[]): { amount: string; currency: string; unit: string } | null {
  if (values.length === 0 || values.some(value => !validMoney(value))) return null;
  const first = values[0]!;
  if (values.some(value => !sameUnit(first, value))) return null;
  const parsed = values.map(value => amountInSourceUnits(value.amount));
  if (parsed.some(value => value === null)) return null;
  const scale = Math.max(...parsed.map(value => value!.scale));
  const integer = parsed.reduce((total, value) => total + value!.integer * 10n ** BigInt(scale - value!.scale), 0n);
  const digits = integer.toString().padStart(scale + 1, '0');
  let amount = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  if (scale > 0) amount = amount.replace(/0+$/, '').replace(/\.$/, '');
  return { amount, currency: first.currency, unit: first.unit };
}

function result(decision: MtnFundsUseEvidenceDecision, reasons: string[], evidence: MtnFundsUseEvidenceInput): MtnFundsUseEvidenceResult {
  return { decision, reasons: [...new Set(reasons)], engineeringOnly: true, evidence };
}

/** Checks evidence completeness and direct, source-backed amount conflicts only. */
export function checkMtnFundsUseEvidence(input: MtnFundsUseEvidenceInput): MtnFundsUseEvidenceResult {
  const review: string[] = [];
  const conflicts: string[] = [];
  if (!usable(input.actualInstrument) || !usable(input.stage) || !usable(input.issuerTier) ||
    !usable(input.registrationArrangement) || !usable(input.statedTotal)) {
    review.push('required_context_missing_uncited_or_uncertain');
  }
  if (input.actualInstrument.value !== 'mtn') review.push('actual_instrument_not_confirmed_mtn');
  if (input.stage.value === 'unknown') review.push('document_stage_unresolved');
  if (input.issuerTier.value === 'unknown' || input.registrationArrangement.value === 'unknown') {
    review.push('registration_context_not_resolved');
  }
  if (input.useLines.length === 0) review.push('funds_use_lines_missing');
  if (!usable(input.statedTotal) || !validMoney(input.statedTotal.value)) review.push('stated_total_missing_or_invalid');
  const statedTotal = usable(input.statedTotal) && validMoney(input.statedTotal.value) ? input.statedTotal.value : null;
  let amountSemanticsSupported = true;
  if (statedTotal && !amountSemanticsMatchCitations(statedTotal, input.statedTotal.citations)) {
    review.push('stated_total_amount_qualifier_not_preserved_or_supported');
    amountSemanticsSupported = false;
  }

  const allowBroadRegistrationCategory = input.stage.value === 'registration' &&
    input.issuerTier.value === 'basic_tier' && input.registrationArrangement.value === 'basic_tier_unified_quota';
  const clearAmounts: MtnFundsUseMoney[] = [];
  for (const [index, line] of input.useLines.entries()) {
    if (!usable(line.lineId) || !usable(line.useDescription) || !usable(line.detailLevel) ||
      !usable(line.amount) || !usable(line.policySensitivity)) {
      review.push(`use_line_${index}_missing_uncited_or_uncertain_field`);
      continue;
    }
    if (!line.useDescription.value.trim() || !validMoney(line.amount.value)) {
      review.push(`use_line_${index}_description_or_amount_invalid`);
      continue;
    }
    if (!amountSemanticsMatchCitations(line.amount.value, line.amount.citations)) {
      review.push(`use_line_${index}_amount_qualifier_not_preserved_or_supported`);
      amountSemanticsSupported = false;
    }
    clearAmounts.push(line.amount.value);
    if (line.policySensitivity.value === 'unresolved') review.push(`use_line_${index}_policy_sensitivity_unresolved`);
    if (line.detailLevel.value === 'broad_category' && !allowBroadRegistrationCategory) {
      review.push(`use_line_${index}_specific_use_detail_required_or_applicability_unresolved`);
    }
    if (line.policySensitivity.value === 'sensitive' && line.detailLevel.value !== 'specific') {
      review.push(`use_line_${index}_policy_sensitive_use_not_specific`);
    }
  }

  if (clearAmounts.length === input.useLines.length && statedTotal) {
    if (!amountSemanticsSupported) {
      review.push('funds_use_amount_semantics_unresolved_for_total');
    } else if (clearAmounts.some(value => !sameUnit(value, statedTotal)) ||
      clearAmounts.some(value => !sameUnit(value, clearAmounts[0]!))) {
      review.push('funds_use_amount_units_unmatched');
    } else if (!clearAmounts.every((value): value is ExactMtnFundsUseMoney => value.kind === 'exact')) {
      review.push('funds_use_amount_semantics_unresolved_for_total');
    } else {
      const total = sumExactAmounts(clearAmounts);
      if (total === null) {
        review.push('funds_use_amount_total_unresolved');
      } else if (statedTotal.kind === 'upper_bound') {
        if (amountsCompare(total.amount, statedTotal.amount) > 0) {
          conflicts.push('funds_use_amount_total_conflict');
        }
      } else if (statedTotal.kind === 'exact') {
        const equal = amountsEqual({ ...total, kind: 'exact' }, statedTotal);
        if (equal === false) conflicts.push('funds_use_amount_total_conflict');
        if (equal === null) review.push('funds_use_amount_total_unresolved');
      } else {
        review.push('funds_use_amount_semantics_unresolved_for_total');
      }
    }
  }

  const change = input.changeProcedure;
  if (!usable(change.changeStatus) || !usable(change.procedureStatus)) {
    review.push('change_procedure_status_missing_uncited_or_uncertain');
  }
  if (usable(change.changeStatus) && change.changeStatus.value === 'unknown') {
    review.push('change_procedure_unresolved');
  }
  if (usable(change.procedureStatus) && change.procedureStatus.value === 'unresolved') {
    review.push('change_procedure_unresolved');
  }
  if (usable(change.changeStatus) && change.changeStatus.value === 'no_change_asserted') {
    if (!usable(change.procedureStatus) || change.procedureStatus.value !== 'not_applicable_with_basis' || !usable(change.procedureDescription) ||
      change.procedureDescription.value === null) {
      review.push('no_change_procedure_not_applicable_basis_missing');
    }
  } else if (usable(change.changeStatus) && change.changeStatus.value === 'changed_or_outside_registration_scope') {
    if (!usable(change.procedureStatus) || change.procedureStatus.value !== 'documented' || !usable(change.procedureDescription) ||
      !change.procedureDescription.value?.trim()) {
      review.push('changed_use_procedure_evidence_missing');
    }
    const disclosureDate = usable(change.disclosureDate) ? change.disclosureDate.value : null;
    const intendedUseDate = usable(change.intendedUseDate) ? change.intendedUseDate.value : null;
    if (!validDate(disclosureDate) || !validDate(intendedUseDate)) {
      review.push('changed_use_disclosure_or_use_date_missing_or_invalid');
    } else if (disclosureDate > intendedUseDate) {
      conflicts.push('changed_use_disclosure_after_intended_use_date');
    } else if (disclosureDate === intendedUseDate && usable(change.statedLeadTimeBusinessDays) &&
      change.statedLeadTimeBusinessDays.value !== null && change.statedLeadTimeBusinessDays.value > 0) {
      conflicts.push('changed_use_positive_lead_time_same_day_conflict');
    }
    if (!usable(change.statedLeadTimeBusinessDays) || change.statedLeadTimeBusinessDays.value === null ||
      !Number.isInteger(change.statedLeadTimeBusinessDays.value) || change.statedLeadTimeBusinessDays.value < 0) {
      review.push('changed_use_business_day_lead_time_claim_missing');
    }
  }

  if (conflicts.length) return result('evidence_conflict', [...review, ...conflicts], input);
  if (review.length) return result('needs_review', review, input);
  return result('evidence_shape_pass', [], input);
}
