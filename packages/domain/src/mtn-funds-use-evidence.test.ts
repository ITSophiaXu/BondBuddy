import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkMtnFundsUseEvidence,
  type MtnFundsUseEvidenceInput,
  type MtnFundsUseLineEvidence,
} from './mtn-funds-use-evidence.js';
import type { MtnEvidenceValue } from './mtn-registration-evidence.js';

const citation = {
  sourceRefId: 'synthetic:mtn-funds-use',
  materialVersion: 'synthetic-v1',
  locator: 'page 1, paragraph 1',
  quote: 'Synthetic evidence only; not an actual issuer document.',
};

function ev<T>(value: T): MtnEvidenceValue<T> {
  return { value, citations: [{ ...citation }], uncertainty: 'clear' };
}

function line(overrides: Partial<MtnFundsUseLineEvidence> = {}): MtnFundsUseLineEvidence {
  return {
    lineId: ev('use-1'),
    useDescription: ev('repay synthetic bank loan'),
    detailLevel: ev('specific'),
    amount: ev({ amount: '1.25', currency: 'CNY', unit: '亿元' }),
    policySensitivity: ev('not_identified_as_sensitive'),
    ...overrides,
  };
}

function input(overrides: Partial<MtnFundsUseEvidenceInput> = {}): MtnFundsUseEvidenceInput {
  return {
    actualInstrument: ev('mtn'),
    stage: ev('issuance'),
    issuerTier: ev('basic_tier'),
    registrationArrangement: ev('basic_tier_unified_quota'),
    useLines: [line()],
    statedTotal: ev({ amount: '1.25', currency: 'CNY', unit: '亿元' }),
    changeProcedure: {
      changeStatus: ev('no_change_asserted'),
      procedureStatus: ev('not_applicable_with_basis'),
      procedureDescription: ev('Synthetic evidence says no change is asserted.'),
      disclosureDate: ev(null),
      intendedUseDate: ev(null),
      statedLeadTimeBusinessDays: ev(null),
    },
    ...overrides,
  };
}

test('issuance stage accepts cited specific uses when exact amount, currency, and unit totals align', () => {
  const evidence = input({ useLines: [
    line({ amount: ev({ amount: '0.5', currency: 'CNY', unit: '亿元' }) }),
    line({ lineId: ev('use-2'), amount: ev({ amount: '0.75', currency: 'CNY', unit: '亿元' }) }),
  ] });
  const result = checkMtnFundsUseEvidence(evidence);
  assert.equal(result.decision, 'evidence_shape_pass', result.reasons.join(','));
  assert.equal(result.engineeringOnly, true);
  assert.equal(result.evidence, evidence);
  assert.equal(result.evidence.useLines[1]?.amount.value?.amount, '0.75');
  assert.equal(result.evidence.useLines[1]?.amount.value?.unit, '亿元');
});

test('basic-tier quota-unified registration may retain broad categories for later issuance detail', () => {
  const result = checkMtnFundsUseEvidence(input({
    stage: ev('registration'),
    issuerTier: ev('basic_tier'),
    registrationArrangement: ev('basic_tier_unified_quota'),
    useLines: [line({ detailLevel: ev('broad_category'), useDescription: ev('working capital') })],
    statedTotal: ev({ amount: '1.25', currency: 'CNY', unit: '亿元' }),
  }));
  assert.equal(result.decision, 'evidence_shape_pass');
});

test('broad categories do not silently pass at issuance or outside the evidenced basic-tier quota registration case', () => {
  const issuance = checkMtnFundsUseEvidence(input({ useLines: [line({ detailLevel: ev('broad_category') })] }));
  assert.equal(issuance.decision, 'needs_review');
  assert.ok(issuance.reasons.includes('use_line_0_specific_use_detail_required_or_applicability_unresolved'));

  const otherRegistration = checkMtnFundsUseEvidence(input({
    stage: ev('registration'), issuerTier: ev('mature_first_class'),
    registrationArrangement: ev('product_by_product'),
    useLines: [line({ detailLevel: ev('broad_category') })],
  }));
  assert.equal(otherRegistration.decision, 'needs_review');
});

test('policy-sensitive use and unresolved policy evidence require specific detail and review', () => {
  const sensitiveBroad = checkMtnFundsUseEvidence(input({
    stage: ev('registration'), issuerTier: ev('basic_tier'),
    registrationArrangement: ev('basic_tier_unified_quota'),
    useLines: [line({ detailLevel: ev('broad_category'), policySensitivity: ev('sensitive') })],
  }));
  assert.equal(sensitiveBroad.decision, 'needs_review');
  assert.ok(sensitiveBroad.reasons.includes('use_line_0_policy_sensitive_use_not_specific'));

  const unresolved = checkMtnFundsUseEvidence(input({
    useLines: [line({ policySensitivity: ev('unresolved') })],
  }));
  assert.equal(unresolved.decision, 'needs_review');
  assert.ok(unresolved.reasons.includes('use_line_0_policy_sensitivity_unresolved'));
});

test('directly evidenced amount mismatches conflict while mixed currency or unit remains needs_review', () => {
  const mismatch = checkMtnFundsUseEvidence(input({
    statedTotal: ev({ amount: '1.2', currency: 'CNY', unit: '亿元' }),
  }));
  assert.equal(mismatch.decision, 'evidence_conflict');
  assert.ok(mismatch.reasons.includes('funds_use_amount_total_conflict'));

  const mixedUnit = checkMtnFundsUseEvidence(input({
    useLines: [line({ amount: ev({ amount: '125', currency: 'CNY', unit: '万元' }) })],
  }));
  assert.equal(mixedUnit.decision, 'needs_review');
  assert.ok(mixedUnit.reasons.includes('funds_use_amount_units_unmatched'));
});

test('changed use requires cited procedure, dates, and the source-stated business-day lead time', () => {
  const missing = checkMtnFundsUseEvidence(input({
    changeProcedure: {
      changeStatus: ev('changed_or_outside_registration_scope'),
      procedureStatus: ev('unresolved'),
      procedureDescription: ev(null),
      disclosureDate: ev(null),
      intendedUseDate: ev(null),
      statedLeadTimeBusinessDays: ev(null),
    },
  }));
  assert.equal(missing.decision, 'needs_review');
  assert.ok(missing.reasons.includes('changed_use_procedure_evidence_missing'));
  assert.ok(missing.reasons.includes('changed_use_business_day_lead_time_claim_missing'));

  const afterUse = checkMtnFundsUseEvidence(input({
    changeProcedure: {
      changeStatus: ev('changed_or_outside_registration_scope'),
      procedureStatus: ev('documented'),
      procedureDescription: ev('Synthetic evidence cites a disclosed change procedure.'),
      disclosureDate: ev('2026-05-02'),
      intendedUseDate: ev('2026-05-01'),
      statedLeadTimeBusinessDays: ev(5),
    },
  }));
  assert.equal(afterUse.decision, 'evidence_conflict');
  assert.ok(afterUse.reasons.includes('changed_use_disclosure_after_intended_use_date'));

  const sameDay = checkMtnFundsUseEvidence(input({
    changeProcedure: {
      changeStatus: ev('changed_or_outside_registration_scope'),
      procedureStatus: ev('documented'),
      procedureDescription: ev('Synthetic disclosure timing claim.'),
      disclosureDate: ev('2026-05-01'), intendedUseDate: ev('2026-05-01'), statedLeadTimeBusinessDays: ev(5),
    },
  }));
  assert.equal(sameDay.decision, 'evidence_conflict');
  assert.ok(sameDay.reasons.includes('changed_use_positive_lead_time_same_day_conflict'));

  const invalidDate = checkMtnFundsUseEvidence(input({
    changeProcedure: {
      changeStatus: ev('changed_or_outside_registration_scope'),
      procedureStatus: ev('documented'),
      procedureDescription: ev('Synthetic disclosure timing claim.'),
      disclosureDate: ev('2026-02-30'), intendedUseDate: ev('2026-05-01'), statedLeadTimeBusinessDays: ev(5),
    },
  }));
  assert.equal(invalidDate.decision, 'needs_review');
  assert.ok(invalidDate.reasons.includes('changed_use_disclosure_or_use_date_missing_or_invalid'));
});

test('missing or conflicted line evidence never becomes a confirmed amount or policy fact', () => {
  const missingAmount = line({ amount: { value: null, citations: [{ ...citation }], uncertainty: 'clear' } });
  const result = checkMtnFundsUseEvidence(input({ useLines: [missingAmount] }));
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.includes('use_line_0_missing_uncited_or_uncertain_field'));

  const conflictedSensitivity = ev<'sensitive' | 'not_identified_as_sensitive' | 'unresolved'>('sensitive');
  conflictedSensitivity.conflictingAssertions = [{ value: 'not_identified_as_sensitive', citations: [{ ...citation }] }];
  const conflict = checkMtnFundsUseEvidence(input({ useLines: [line({ policySensitivity: conflictedSensitivity })] }));
  assert.equal(conflict.decision, 'needs_review');
  assert.ok(conflict.reasons.includes('use_line_0_missing_uncited_or_uncertain_field'));
});
