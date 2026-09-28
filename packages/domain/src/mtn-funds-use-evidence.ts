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
  /** Registration/issuance amount with its source-qualified semantics preserved. */
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

const amountQualifierPatterns: Record<Exclude<MtnFundsUseMoney['kind'], 'exact'>, RegExp[]> = {
  upper_bound: [
    /(?:不超过|不高于|不得超过|最高|至多|上限|不大于|≤|<=|at\s+most|up\s+to|no\s+more\s+than|not\s+exceed)[^\d]{0,8}([\d,.]+)/i,
    /([\d,.]+)\s*(?:元|万元|亿元|万|亿)?\s*(?:以内|以下)/i,
  ],
  lower_bound: [
    /(?:至少|不低于|不得低于|不小于|不少于|下限|≥|>=|at\s+least|no\s+less\s+than)[^\d]{0,8}([\d,.]+)/i,
    /([\d,.]+)\s*(?:元|万元|亿元|万|亿)?\s*(?:以上)/i,
  ],
  estimate: [
    /(?:约|预计|预估|大约|估计)[^\d]{0,12}([\d,.]+)/i,
    /(?:approximately|around|estimated?)[^\d]{0,12}([\d,.]+)/i,
    /([\d,.]+)\s*(?:元|万元|亿元|万|亿)?\s*(?:左右)/i,
  ],
  range: [
    /([\d,.]+)\s*(?:元|万元|亿元|万|亿)?\s*(?:至|到|[-–—])\s*([\d,.]+)/i,
    /between\s+([\d,.]+)\s+and\s+([\d,.]+)/i,
    /(?:区间|范围|介于)\s*([\d,.]+)[^\d]{0,8}([\d,.]+)/i,
  ],
};
const pendingAllocationPattern = /按需|结合需要确定|视实际需要|实际需要确定|待分配|尚未确定|待明确|subject\s+to\s+demand/i;

function citedAmountsForKind(quote: string, kind: Exclude<MtnFundsUseMoney['kind'], 'exact'>): string[] {
  return amountQualifierPatterns[kind].flatMap(pattern => {
    const globalPattern = new RegExp(pattern.source, `${pattern.flags}g`);
    return [...quote.matchAll(globalPattern)].flatMap(match =>
      match.slice(1).filter((value): value is string => value !== undefined));
  });
}

function quotedRangeMatches(quote: string, money: Extract<MtnFundsUseMoney, { kind: 'range' }>): boolean {
  const pattern = /([\d,.]+)\s*(亿元|万元|元|万|亿)?\s*(?:至|到|[-–—])\s*([\d,.]+)\s*(亿元|万元|元|万|亿)?/i;
  const match = pattern.exec(quote);
  if (!match || !match[1] || !match[3]) return false;
  const min = match[1].replace(/,/g, '');
  const max = match[3].replace(/,/g, '');
  const citedUnits = [match[2], match[4]].filter((unit): unit is string => unit !== undefined);
  return sameSourceNumber(min, money.minimum) && sameSourceNumber(max, money.maximum) &&
    citedUnits.length > 0 && citedUnits.every(unit => unit === money.unit);
}

function quotedAmountMatches(quote: string, quotedAmount: string, structuredAmount: string, unit: string): boolean {
  const escapedUnit = unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const unitAmountPattern = new RegExp(`([\\d,]+(?:\\.\\d+)?)\\s*${escapedUnit}`, 'g');
  return [...quote.matchAll(unitAmountPattern)].some(match => match[1] !== undefined &&
    sameSourceNumber(match[1], quotedAmount) && sameSourceNumber(quotedAmount, structuredAmount));
}

function canonicalQuotedNumber(value: string): string | null {
  if (!/^\d+(?:\.\d+)?$/.test(value) && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(value)) return null;
  return value.replace(/,/g, '');
}

function sameSourceNumber(left: string, right: string): boolean {
  const canonicalLeft = canonicalQuotedNumber(left);
  return canonicalLeft !== null && amountsCompare(canonicalLeft, right) === 0;
}

function amountSemanticsMatchCitations(money: MtnFundsUseMoney, citations: MtnEvidenceValue<unknown>['citations']): boolean {
  const quotes = citations.map(citation => citation.quote);
  if (money.kind === 'exact') {
    const citedExactAmount = quotes.some(quote => {
      const tokens = quote.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
      const amountAppears = tokens.some(token => quotedAmountMatches(quote, token, money.amount, money.unit));
      const sameAmountIsQualified = Object.keys(amountQualifierPatterns).some(kind =>
        citedAmountsForKind(quote, kind as Exclude<MtnFundsUseMoney['kind'], 'exact'>)
          .some(token => quotedAmountMatches(quote, token, money.amount, money.unit)));
      return amountAppears && !sameAmountIsQualified && !pendingAllocationPattern.test(quote);
    });
    return citedExactAmount;
  }
  return quotes.some(quote => {
    const citedAmounts = citedAmountsForKind(quote, money.kind);
    if (money.kind === 'range') {
      const endpoints = [money.minimum, money.maximum];
      const otherQualifierUsesEndpoint = Object.keys(amountQualifierPatterns).some(kind => kind !== money.kind &&
        citedAmountsForKind(quote, kind as Exclude<MtnFundsUseMoney['kind'], 'exact'>)
          .some(amount => endpoints.some(endpoint => sameSourceNumber(amount, endpoint))));
      return quotedRangeMatches(quote, money) && !otherQualifierUsesEndpoint;
    }
    const sameAmountHasAnotherQualifier = Object.keys(amountQualifierPatterns).some(kind => kind !== money.kind &&
      citedAmountsForKind(quote, kind as Exclude<MtnFundsUseMoney['kind'], 'exact'>)
        .some(amount => sameSourceNumber(amount, money.amount)));
    return !sameAmountHasAnotherQualifier &&
      citedAmounts.some(amount => quotedAmountMatches(quote, amount, money.amount, money.unit));
  });
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
        } else {
          review.push('funds_use_amount_semantics_unresolved_for_total');
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
