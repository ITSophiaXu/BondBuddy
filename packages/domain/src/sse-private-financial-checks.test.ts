import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { RulePack } from './index.js';
import { evaluateSsePrivateDraftChecks as evaluate, type CheckEvidence, type SsePrivateCheckInput } from './sse-private-checks.js';
const pack = JSON.parse(readFileSync(new URL('../../../knowledge/exchange-bonds/drafts/sse-private/rule-pack.json', import.meta.url), 'utf8')) as RulePack;
const e = <T>(value: T): CheckEvidence<T> => ({ value, status: 'verified', anchors: ['synthetic:financial-material-v4:table-3:cell-2'] });
function input(): SsePrivateCheckInput {
  return { market: 'sse', offering: 'private', asOf: e('2026-09-26'),
    reportingWindow: { targetCutoff: e('2025-09-30'), calendarYearBasis: e(true), exceptionClaimed: e(false),
      disclosedAnnualEnds: e(['2023-12-31', '2024-12-31']), disclosedInterimEnds: e(['2025-09-30']) },
    auditOpinion: { periodEnd: e('2024-12-31'), periodKind: e('annual'), audited: e(true), opinion: e('unmodified') },
    financialStatements: { periodEnd: e('2025-09-30'), consolidatedPrepared: e(true),
      disclosedStatements: e(['parent:balance', 'parent:income', 'parent:cashflow', 'consolidated:balance', 'consolidated:income', 'consolidated:cashflow']),
      restatementPresent: e(false), materialConsolidationChange: e(false) },
    mdnaItem: { itemLabel: e('应收账款'), periodEnd: e('2025-09-30'), previousPeriodEnd: e('2024-12-31'),
      kind: e('asset'), currentAmount: e('100'), previousAmount: e('100'), categoryTotal: e('1000'),
      comparable: e(true), materialRisk: e(false), movementDisclosed: e(true), causeSupported: e(true) } };
}
const finding = (data: SsePrivateCheckInput, code: string) => {
  const found = evaluate(pack, data).findings.find(row => row.code === code);
  assert.ok(found, code); return found;
};
const absent = (data: SsePrivateCheckInput, code: string) => assert.ok(!evaluate(pack, data).findings.some(row => row.code === code), code);

test('#20 standard private window requires the two right years and latest interim, preserves independent lookbacks', () => {
  const data = input(); assert.equal(finding(data, 'annual_window').outcome, 'pass');
  assert.equal(finding(data, 'interim_window').outcome, 'pass');
  assert.equal(finding(data, 'independent_lookback').outcome, 'needs_judgement');
  data.reportingWindow!.disclosedAnnualEnds = e(['2022-12-31', '2024-12-31']);
  assert.equal(finding(data, 'annual_window').outcome, 'issue');
  data.reportingWindow!.disclosedAnnualEnds = e(['2022-12-31', '2023-12-31', '2024-12-31']);
  assert.equal(finding(data, 'annual_window').outcome, 'pass');
  data.reportingWindow!.disclosedInterimEnds = e([]);
  assert.equal(finding(data, 'interim_window').outcome, 'issue');
});
test('#20 confirmed year-end window, short history, exception and future dates do not imply filing eligibility', () => {
  const data = input(); data.reportingWindow!.targetCutoff = e('2023-12-31');
  data.reportingWindow!.disclosedAnnualEnds = e(['2022-12-31', '2023-12-31']);
  data.reportingWindow!.disclosedInterimEnds = e([]);
  assert.equal(finding(data, 'annual_window').outcome, 'pass'); absent(data, 'interim_window');
  assert.equal(finding(data, 'year_end_window').outcome, 'needs_judgement');
  data.reportingWindow!.exceptionClaimed = e(true);
  assert.equal(finding(data, 'reporting_window_judgement').outcome, 'needs_judgement'); absent(data, 'annual_window');
  data.reportingWindow!.targetCutoff = e('2026-12-31');
  assert.equal(finding(data, 'future_target_cutoff').outcome, 'issue');
});
test('#20 unaudited interim is not a fabricated opinion; missing annual audit and unknown opinion are distinct', () => {
  const data = input(); data.auditOpinion!.audited = e(false);
  assert.equal(finding(data, 'unaudited_report').outcome, 'issue');
  data.auditOpinion!.periodKind = e('interim');
  assert.equal(finding(data, 'unaudited_report').outcome, 'not_applicable'); absent(data, 'unmodified_opinion');
  data.auditOpinion!.audited = e(true); delete data.auditOpinion!.opinion;
  assert.equal(finding(data, 'evidence:audit_opinion_type').outcome, 'needs_evidence');
});
test('#20 emphasis and qualified opinions require the correct issuers of explanations, not a promise that effects disappeared', () => {
  const data = input(); data.auditOpinion!.opinion = e('emphasis_unmodified');
  data.auditOpinion!.issuerExplanation = e(true); data.auditOpinion!.accountantSupplement = e(false);
  data.auditOpinion!.debtImpactAnalysis = e(true);
  assert.equal(finding(data, 'accountant_audit_supplement').outcome, 'issue'); absent(data, 'qualified_impact_review');
  data.auditOpinion!.opinion = e('qualified'); data.auditOpinion!.accountantSupplement = e(true);
  assert.equal(finding(data, 'evidence:qualified_impact_review').outcome, 'needs_evidence');
  data.auditOpinion!.qualifiedImpactReview = e(true);
  assert.equal(finding(data, 'qualified_impact_review').outcome, 'pass');
  for (const opinion of ['adverse', 'disclaimer'] as const) {
    data.auditOpinion!.opinion = e(opinion);
    assert.equal(finding(data, 'other_nonstandard_opinion').outcome, 'needs_judgement'); absent(data, 'unmodified_opinion');
  }
});
test('#20 consolidated issuers require both sets of statements; standalone issuers do not require invented consolidated tables', () => {
  const data = input(); assert.equal(finding(data, 'statement_inventory').outcome, 'pass');
  data.financialStatements!.disclosedStatements = e(['consolidated:balance', 'consolidated:income', 'consolidated:cashflow']);
  assert.equal(finding(data, 'statement_inventory').outcome, 'issue');
  assert.match(finding(data, 'statement_inventory').message, /parent:balance/);
  data.financialStatements!.disclosedStatements = e(['parent:balance', 'parent:income', 'parent:cashflow']);
  assert.equal(finding(data, 'statement_inventory').outcome, 'issue');
  data.financialStatements!.consolidatedPrepared = e(false);
  assert.equal(finding(data, 'statement_inventory').outcome, 'pass');
});
test('#20 restatements preserve originals, and new-subsidiary exception does not waive all consolidation disclosure', () => {
  const data = input(); data.financialStatements!.restatementPresent = e(true);
  data.financialStatements!.originalAndRestatedSeparated = e(false);
  assert.equal(finding(data, 'restatement_separation').outcome, 'issue');
  assert.equal(finding(data, 'evidence:restatement_basis').outcome, 'needs_evidence');
  data.financialStatements!.materialConsolidationChange = e(true); data.financialStatements!.newSubsidiariesOnly = e(false);
  data.financialStatements!.consolidationChangeDetails = e(false);
  assert.equal(finding(data, 'consolidation_change_details').outcome, 'issue');
  data.financialStatements!.newSubsidiariesOnly = e(true);
  assert.equal(finding(data, 'new_subsidiary_exception').outcome, 'not_applicable'); absent(data, 'consolidation_change_details');
});
test('#20 exact 10 percent and 30 percent, including decline, require both movement and evidenced cause', () => {
  const data = input(); data.mdnaItem!.movementDisclosed = e(false); data.mdnaItem!.causeSupported = e(false);
  assert.equal(finding(data, 'mdna_movement_disclosed').outcome, 'issue');
  assert.equal(finding(data, 'mdna_cause_supported').outcome, 'issue');
  data.mdnaItem!.kind = e('other'); delete data.mdnaItem!.categoryTotal;
  for (const amount of ['130', '70']) {
    data.mdnaItem!.currentAmount = e(amount);
    assert.equal(finding(data, 'mdna_cause_supported').outcome, 'issue');
  }
  data.mdnaItem!.currentAmount = e('129.999999999999');
  assert.equal(finding(data, 'mdna_below_threshold').outcome, 'pass'); absent(data, 'mdna_cause_supported');
  data.mdnaItem!.currentAmount = e('70.000000000001');
  assert.equal(finding(data, 'mdna_below_threshold').outcome, 'pass');
  data.mdnaItem!.kind = e('liability'); data.mdnaItem!.categoryTotal = e('1000');
  data.mdnaItem!.currentAmount = e('99.999999999999');
  assert.equal(finding(data, 'mdna_below_threshold').outcome, 'pass');
});
test('#20 large decimals retain exact threshold precision above Number.MAX_SAFE_INTEGER', () => {
  const data = input(); data.mdnaItem!.currentAmount = e('1000000000000000000.000000000000');
  data.mdnaItem!.previousAmount = data.mdnaItem!.currentAmount;
  data.mdnaItem!.categoryTotal = e('10000000000000000000'); data.mdnaItem!.causeSupported = e(false);
  assert.equal(finding(data, 'mdna_cause_supported').outcome, 'issue');
  data.mdnaItem!.currentAmount = e('999999999999999999.999999999999');
  assert.equal(finding(data, 'mdna_below_threshold').outcome, 'pass');
});
test('#20 zero or negative denominators and non-comparable periods do not mechanically pass percentages', () => {
  const data = input();
  for (const amount of ['0', '-100']) {
    data.mdnaItem!.previousAmount = e(amount);
    assert.equal(finding(data, 'mdna_change_judgement').outcome, 'needs_judgement'); absent(data, 'mdna_below_threshold');
    data.mdnaItem!.categoryTotal = e(amount);
    assert.equal(finding(data, 'mdna_share_judgement').outcome, 'needs_judgement');
  }
  data.mdnaItem!.comparable = e(false);
  assert.equal(finding(data, 'mdna_basis_judgement').outcome, 'needs_judgement'); absent(data, 'mdna_change_trigger');
  data.mdnaItem!.materialRisk = e(true); data.mdnaItem!.causeSupported = e(false);
  assert.equal(finding(data, 'mdna_cause_supported').outcome, 'issue');
  data.mdnaItem!.previousPeriodEnd = data.mdnaItem!.periodEnd;
  assert.equal(finding(data, 'mdna_period_order').outcome, 'issue');
});
test('#20 immaterial size cannot waive a verified material risk or turn unknown risk into none', () => {
  const data = input(); data.mdnaItem!.currentAmount = e('1'); data.mdnaItem!.previousAmount = e('1');
  data.mdnaItem!.materialRisk = e(true); data.mdnaItem!.causeSupported = e(false);
  assert.equal(finding(data, 'mdna_cause_supported').outcome, 'issue');
  data.mdnaItem!.materialRisk = { ...e(false), value: null };
  assert.equal(finding(data, 'evidence:mdna_material_risk').outcome, 'needs_evidence'); absent(data, 'mdna_below_threshold');
});
test('#20 missing, conflicted and merely asserted evidence cannot satisfy new checks', () => {
  for (const status of ['user_asserted', 'conflicted'] as const) {
    const data = input(); data.reportingWindow!.disclosedAnnualEnds.status = status;
    data.auditOpinion!.opinion!.status = status; data.financialStatements!.disclosedStatements.status = status;
    data.mdnaItem!.currentAmount.status = status;
    for (const code of ['disclosed_annual_ends', 'audit_opinion_type', 'disclosed_statements', 'mdna_current'])
      assert.equal(finding(data, `evidence:${code}`).outcome, 'needs_evidence');
    for (const code of ['annual_window', 'unmodified_opinion', 'statement_inventory', 'mdna_below_threshold']) absent(data, code);
  }
  const data = input(); data.reportingWindow!.disclosedAnnualEnds = e(['2024-12-31', '2024-12-31']);
  assert.equal(finding(data, 'evidence:disclosed_annual_ends').outcome, 'needs_evidence');
  data.mdnaItem!.currentAmount = e('1e9');
  assert.equal(finding(data, 'evidence:mdna_current').outcome, 'needs_evidence');
  data.auditOpinion!.opinion!.anchors = [];
  assert.equal(finding(data, 'evidence:audit_opinion_type').outcome, 'needs_evidence');
});
test('#20 v2 rejects v1 checker declarations and parameter drift rather than replaying new checks against old packs', () => {
  const old = structuredClone(pack); old.rules.forEach(rule => { if (rule.checker.checker_id === 'sse-private-structured-evidence') rule.checker.checker_version = '1'; });
  assert.throws(() => evaluate(old, input()), /CHECKER_VERSION_MISMATCH/);
  const drift = structuredClone(pack); drift.version = 'unmatched-version';
  assert.throws(() => evaluate(drift, input()), /CHECKER_VERSION_MISMATCH/);
  const result = evaluate(pack, input());
  assert.equal(result.uncoveredRuleIds.length, 22); assert.equal(result.productionEligible, false);
  assert.equal(result.checkerVersion, '2');
});
