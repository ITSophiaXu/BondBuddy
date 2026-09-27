import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { RulePack } from './index.js';
import { evaluateSsePrivateDraftChecks as evaluate, type CheckEvidence, type SsePrivateCheckInput } from './sse-private-checks.js';

const pack = JSON.parse(readFileSync(new URL('../../../knowledge/exchange-bonds/drafts/sse-private/rule-pack.json', import.meta.url), 'utf8')) as RulePack;
const e = <T>(value: T): CheckEvidence<T> => ({ value, status: 'verified', anchors: ['synthetic:terms-v2:paragraph-4'] });
function input(): SsePrivateCheckInput {
  return JSON.parse(readFileSync(new URL('../examples/sse-private-check-input-v3.json', import.meta.url), 'utf8'));
}
const finding = (data: SsePrivateCheckInput, code: string) => {
  const result = evaluate(pack, data).findings.find(f => f.code === code);
  assert.ok(result, code); return result;
};
const absent = (data: SsePrivateCheckInput, code: string) => assert.ok(!evaluate(pack, data).findings.some(f => f.code === code), code);

test('#20 funds use sums exact decimal amounts including beyond safe integer and rejects mismatches', () => {
  const data = input(); assert.equal(finding(data, 'allocation_sum').outcome, 'pass');
  data.fundsUse!.allocations[0]!.amount = e('9007199254740993.000000000001');
  data.fundsUse!.allocationTotal = e('9007199254740993.200000000001');
  assert.equal(finding(data, 'allocation_sum').outcome, 'pass');
  data.fundsUse!.allocationTotal = e('9007199254740993.200000000002');
  assert.equal(finding(data, 'allocation_sum').outcome, 'issue');
});
test('#20 incomplete allocation or mixed currency/unit/gross-net basis never passes the total', () => {
  for (const field of ['completeAllocationInventory', 'sameCurrencyUnitAndGrossNetBasis'] as const) {
    const data = input(); data.fundsUse![field] = e(false);
    assert.equal(finding(data, 'allocation_scope_unconfirmed').outcome, 'needs_judgement'); absent(data, 'allocation_sum');
  }
});
test('#20 each use has its own support; missing construction permits remain a local gap', () => {
  const data = input(); data.fundsUse!.allocations[1]!.supportingEvidence = { ...e(true), value: null };
  assert.equal(finding(data, 'allocation_0_support').outcome, 'pass');
  assert.equal(finding(data, 'evidence:allocation_1_support').outcome, 'needs_evidence');
  assert.equal(finding(data, 'allocation_sum').outcome, 'pass');
  assert.equal(evaluate(pack, data).productionEligible, false);
});
test('#20 unknown/conflicting/asserted/unanchored/invalid amounts cannot enter arithmetic', () => {
  for (const value of [ { ...e('0.1'), status: 'user_asserted' as const }, { ...e('0.1'), status: 'conflicted' as const },
    { ...e('0.1'), anchors: [] }, { ...e('0.1'), value: null }, e('1e1'), e('-1') ]) {
    const data = input(); data.fundsUse!.allocations[0]!.amount = value;
    assert.equal(finding(data, 'evidence:allocation_0_amount').outcome, 'needs_evidence'); absent(data, 'allocation_sum');
  }
});
test('#20 simplification, empty and excessive inventories cannot silently waive disclosure', () => {
  const data = input(); data.fundsUse!.productiveExpenditureSimplification = e(true);
  assert.equal(finding(data, 'productive_expenditure_exception').outcome, 'needs_judgement'); absent(data, 'allocation_sum');
  data.fundsUse!.productiveExpenditureSimplification = { ...e(false), value: null };
  assert.equal(finding(data, 'evidence:productive_expenditure_simplification').outcome, 'needs_evidence');
  data.fundsUse!.productiveExpenditureSimplification = e(false);
  data.fundsUse!.allocations = []; assert.equal(finding(data, 'allocation_rows_missing').outcome, 'needs_evidence');
  data.fundsUse!.allocations = Array.from({ length: 1001 }, () => input().fundsUse!.allocations[0]!);
  assert.equal(finding(data, 'allocation_inventory_limit').outcome, 'needs_judgement'); absent(data, 'allocation_sum');
});
test('#20 unknown use and unreviewed support do not become confirmed project approvals', () => {
  const data = input(); data.fundsUse!.allocations[0]!.purpose = { ...e('repay_debt'), value: null };
  data.fundsUse!.allocations[0]!.supportingEvidence.status = 'user_asserted';
  assert.equal(finding(data, 'evidence:allocation_0_purpose').outcome, 'needs_evidence');
  assert.equal(finding(data, 'evidence:allocation_0_support').outcome, 'needs_evidence');
  assert.equal(finding(data, 'funds_use_check_scope').outcome, 'needs_judgement');
});
test('#20 officer and liaison fields must have actual reviewed content and anchors', () => {
  const data = input(); data.disclosureOfficer!.liaisonContact = e(''); data.disclosureOfficer!.name.anchors = [];
  assert.equal(finding(data, 'evidence:officer_liaisonContact').outcome, 'needs_evidence');
  assert.equal(finding(data, 'evidence:officer_name').outcome, 'needs_evidence');
  assert.equal(finding(data, 'officer_position').outcome, 'pass');
});
test('#20 unchanged officer with a verified existing commitment need not re-sign', () => {
  const data = input(); assert.equal(finding(data, 'officer_existing_commitment').outcome, 'pass');
  absent(data, 'evidence:officer_current_commitment');
  data.disclosureOfficer!.previousValidCommitment!.status = 'user_asserted';
  assert.equal(finding(data, 'evidence:officer_current_commitment').outcome, 'needs_evidence');
});
test('#20 changed officer needs a current real commitment; previous officer signature cannot pass', () => {
  const data = input(); data.disclosureOfficer!.changed = e(true);
  assert.equal(finding(data, 'evidence:officer_current_commitment').outcome, 'needs_evidence'); absent(data, 'officer_existing_commitment');
  data.disclosureOfficer!.currentSignedCommitment = e(false);
  assert.equal(finding(data, 'officer_current_commitment').outcome, 'issue');
  data.disclosureOfficer!.currentSignedCommitment = e(true);
  assert.equal(finding(data, 'officer_current_commitment').outcome, 'pass');
});
test('#20 incomplete disqualification review is not a clean appointment conclusion', () => {
  const data = input(); data.disclosureOfficer!.disqualificationReviewComplete = e(false);
  assert.equal(finding(data, 'officer_disqualification_incomplete').outcome, 'needs_judgement'); absent(data, 'officer_disqualification');
  data.disclosureOfficer!.disqualificationReviewComplete = e(true); data.disclosureOfficer!.disqualificationPresent = e(true);
  assert.equal(finding(data, 'officer_disqualification').outcome, 'issue');
});
test('#20 v2 replay retains nine checks and rejects mixed checker declarations', () => {
  const old = structuredClone(pack); old.version = '2026.09.26-draft.4';
  for (const rule of old.rules) {
    rule.checker.parameter_version = old.version;
    if (['sse-private-funds-use-evidence', 'sse-private-disclosure-officer-2026'].includes(rule.rule_id))
      rule.checker = { checker_id: 'exchange-manual-evidence-review', checker_version: 'unimplemented.1', parameter_version: old.version };
    else if (rule.checker.checker_id === 'sse-private-structured-evidence') rule.checker.checker_version = '2';
  }
  const result = evaluate(old, input()); assert.equal(result.checkerVersion, '2'); assert.equal(result.uncoveredRuleIds.length, 22);
  assert.ok(!result.findings.some(f => f.code === 'allocation_sum'));
  old.rules.find(r => r.rule_id === 'sse-private-funds-use-evidence')!.checker = {
    checker_id: 'sse-private-structured-evidence', checker_version: '3', parameter_version: old.version };
  assert.throws(() => evaluate(old, input()), /CHECKER_VERSION_MISMATCH/);
});
