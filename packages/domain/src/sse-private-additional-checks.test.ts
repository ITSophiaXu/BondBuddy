import assert from 'node:assert/strict';
import test from 'node:test';
import { e,input,check,absent,result,pack } from './sse-private-check-test-fixtures.js';
import { evaluateSsePrivateDraftChecks as evaluate, SSE_PRIVATE_CHECKED_RULES, type SsePrivateCheckInput } from './sse-private-checks.js';

test('#20-v4 source-authority: select only reviewed comparable candidates; conflict needs a reason',()=>{
  const d=input(); assert.equal(check(d,'source_agreement').outcome,'pass');
  d.sourceSelection!.candidates=[{value:e('100'),applicable:e(true)},{value:e('200'),applicable:e(true)}];
  assert.equal(check(d,'evidence:conflict_resolution_reason').outcome,'needs_evidence');absent(d,'source_agreement');
  d.sourceSelection!.resolution={selected:e('200'),rationale:e('已核对本期重述')};
  assert.equal(check(d,'source_conflict_resolution').outcome,'issue');
  d.sourceSelection!.selected=e('200'); assert.equal(check(d,'source_conflict_resolution').outcome,'pass');
  d.sourceSelection!.selected=e('300'); assert.equal(check(d,'source_not_in_candidates').outcome,'issue');
  d.sourceSelection!.candidates[1]!.value.status='extracted';
  assert.equal(check(d,'source_selection_incomplete').outcome,'needs_evidence');
});
test('#20-v4 evidence-state: missing/uncertain facts continue with explicit markers',()=>{
  for (const status of ['user_asserted','conflicted','extracted'] as const) {
    const d=input();d.evidenceUse!.original.status=status;
    assert.equal(check(d,'unverified_fact_use').outcome,'issue');
    d.evidenceUse!.publishedAsConfirmed=e(false);d.evidenceUse!.markedForConfirmation=e(true);
    assert.equal(check(d,'unverified_fact_use').outcome,'pass');
    assert.equal(check(d,'evidence:original_fact').outcome,'needs_evidence');
  }
});
test('#20-v4 identity: same name never overrides entity, scope, period or unit',()=>{
  const d=input();assert.equal(check(d,'identity_entityId').outcome,'pass');
  for (const [key,value] of [['entityId','other-id'],['scope','parent'],['unit','元'],['currency','USD'],['periodEnd','2025-06-30']] as const) {
    const changed=input();Object.assign(changed.identityComparison!.actual.value!,{[key]:value});
    assert.equal(check(changed,`identity_${key}`).outcome,'issue');
  }
  d.identityComparison!.actual.value!.periodEnd='2025-06-31';
  assert.equal(check(d,'evidence:identity_actual').outcome,'needs_evidence');
});
test('#20-v4 current-terms: actual tranche/current terms differ from old text and public registration',()=>{
  const d=input();assert.equal(check(d,'current_term_match').outcome,'pass');
  d.currentTerm!.value.disclosed=e('6亿元');d.currentTerm!.approvalRoute=e('public_registration');
  assert.equal(check(d,'current_term_match').outcome,'issue');assert.equal(check(d,'private_approval_route').outcome,'issue');
  d.currentTerm!.value.current.status='user_asserted';assert.equal(check(d,'evidence:current_term_current').outcome,'needs_evidence');absent(d,'current_term_match');
});
test('#20-v4 funds-simulation: cash, fees, debt and equity reconcile without choosing accounting policy',()=>{
  const d=input();for(const code of ['simulation_opening_balance','simulation_assets','simulation_liabilities','simulation_equity','previous_balance'])assert.equal(check(d,code).outcome,'pass');
  d.fundsSimulation!.feeTreatment=e('expense');assert.equal(check(d,'simulation_liabilities').outcome,'issue');assert.equal(check(d,'simulation_equity').outcome,'issue');
  d.fundsSimulation!.closingLiabilities=e('65');d.fundsSimulation!.closingEquity=e('39');
  assert.equal(check(d,'simulation_equity').outcome,'pass');
  d.fundsSimulation!.closingAssets=e('105');assert.equal(check(d,'simulation_assets').outcome,'issue');
  d.fundsSimulation!.simpleCashDebtOnly=e(false);assert.equal(check(d,'simulation_complex').outcome,'needs_judgement');absent(d,'simulation_assets');
  d.previousProceeds!.unrectifiedUnauthorizedUse=e(true);assert.equal(check(d,'previous_unrectified_use').outcome,'issue');
  d.previousProceeds!.balance=e('0.200000000001');assert.equal(check(d,'previous_balance').outcome,'issue');
});
test('#20-v4 funds-simulation: missing assumptions and out-of-range cash are not a simulated success',()=>{
  const d=input();d.fundsSimulation!.assumptions=e('');assert.equal(check(d,'evidence:simulation_assumptions').outcome,'needs_evidence');absent(d,'simulation_assets');
  d.fundsSimulation!.assumptions=e('合成');d.fundsSimulation!.debtRepayment=e('20');
  assert.equal(check(d,'simulation_cash_boundary').outcome,'needs_judgement');absent(d,'simulation_assets');
  d.previousProceeds!.repeatApplication=e(false);assert.equal(check(d,'previous_first_application').outcome,'not_applicable');absent(d,'previous_balance');
});
test('#20-v4 business-revenue: exact 10% revenue OR gross profit, not just top three',()=>{
  const d=input();assert.equal(check(d,'business_gross_profit').outcome,'pass');assert.equal(check(d,'business_margin').outcome,'pass');
  d.businessSegment!.operationsDisclosed=e(false);assert.equal(check(d,'business_operations_disclosure').outcome,'issue');
  d.businessSegment!.totalRevenue=e('101');assert.equal(check(d,'business_operations_disclosure').outcome,'issue'); // gross profit still exactly 10%
  d.businessSegment!.totalGrossProfit=e('21');assert.equal(check(d,'business_below_threshold').outcome,'needs_judgement');
  d.businessSegment!.materialRisk=e(true);assert.equal(check(d,'business_operations_disclosure').outcome,'issue');
  d.businessSegment!.totalGrossProfit=e('0');assert.equal(check(d,'business_nonpositive_base').outcome,'needs_judgement');
});
test('#20-v4 indicators: exact rational arithmetic, final rounding, zero/negative denominator and basis',()=>{
  const d=input();assert.equal(check(d,'indicator_value').outcome,'pass');
  d.indicator!.scale=e('percent');d.indicator!.disclosed=e('333.33');assert.equal(check(d,'indicator_value').outcome,'pass');
  d.indicator!.disclosed=e('333.34');assert.equal(check(d,'indicator_value').outcome,'issue');
  d.indicator!.numerator=e('9007199254740993.01');d.indicator!.denominator=e('9007199254740993.01');d.indicator!.disclosed=e('100');assert.equal(check(d,'indicator_value').outcome,'pass');
  for(const v of ['0','-1']) {d.indicator!.denominator=e(v);assert.equal(check(d,'indicator_denominator_nonpositive').outcome,'needs_judgement');absent(d,'indicator_value');}
  d.indicator!.comparable=e(false);assert.equal(check(d,'indicator_basis_unconfirmed').outcome,'needs_judgement');
});
test('#20-v4 cause-evidence: a calculated change or model guess cannot prove a cause',()=>{
  const d=input();assert.equal(check(d,'cause_link_reviewed').outcome,'pass');
  for(const v of ['calculation_only','model_guess'] as const){d.causeStatement!.supportKind=e(v);assert.equal(check(d,'cause_unsubstantiated').outcome,'issue');}
  d.causeStatement!.markedForConfirmation=e(true);assert.equal(check(d,'cause_unsubstantiated').outcome,'needs_judgement');
  d.causeStatement!.supportKind=e('business_evidence');d.causeStatement!.support=e('');assert.equal(check(d,'evidence:cause_support').outcome,'needs_evidence');
});
test('#20-v4 debt-liquidity: full bridge, maturities, explanation and bank facility snapshots',()=>{
  const d=input();for(const code of ['debt_bridge','debt_maturity_sum','credit_balance'])assert.equal(check(d,code).outcome,'pass');
  d.debtReconciliation!.maturityBuckets=[e('30'),e('60')];assert.equal(check(d,'debt_maturity_sum').outcome,'issue');
  d.debtReconciliation!.adjustments=[e('6')];assert.equal(check(d,'debt_bridge').outcome,'issue');
  d.debtReconciliation!.differenceExplanation=e('');assert.equal(check(d,'evidence:debt_difference_explanation').outcome,'needs_evidence');
  d.debtReconciliation!.completeInventory=e(false);absent(d,'debt_bridge');
  d.creditFacility!.available=e('61');assert.equal(check(d,'credit_balance').outcome,'issue');
  d.creditFacility!.simpleAvailableEqualsTotalMinusUsed=e(false);assert.equal(check(d,'credit_conditional_facility').outcome,'needs_judgement');absent(d,'credit_balance');
});
test('#20-v4 rating-enhancement: absent does not imply illegality, present requires report/contract',()=>{
  const d=input();d.ratingEnhancement!.rated=e(false);d.ratingEnhancement!.enhanced=e(false);
  assert.equal(check(d,'rating_absent').outcome,'not_applicable');assert.equal(check(d,'enhancement_absent').outcome,'not_applicable');
  d.ratingEnhancement!.rated=e(true);d.ratingEnhancement!.currentReport=e('');assert.equal(check(d,'evidence:rating_current_report').outcome,'needs_evidence');
  d.ratingEnhancement!.rating!.disclosed=e('AAA');assert.equal(check(d,'rating_conclusion_match').outcome,'issue');
  d.ratingEnhancement!.enhanced=e(true);d.ratingEnhancement!.guarantee!.disclosed=e('全部债务');assert.equal(check(d,'enhancement_terms_match').outcome,'issue');
});
test('#20-v4 protection: reference clauses are not automatically agreed obligations',()=>{
  const d=input();assert.equal(check(d,'protection_term_match').outcome,'pass');
  d.protectionTerms!.actualAgreement=e('');assert.equal(check(d,'evidence:protection_actual_agreement').outcome,'needs_evidence');
  d.protectionTerms!.term.disclosed=e('1/2');assert.equal(check(d,'protection_term_match').outcome,'issue');
  d.protectionTerms!.meetingRulesPresent=e(false);assert.equal(check(d,'protection_meeting_rules').outcome,'issue');
});
test('#20-v4 risk-disclosure: changed facts propagate and removing a risk needs a basis',()=>{
  const d=input();d.riskUpdate!.fact.disclosed=e('旧债务90万元');assert.equal(check(d,'risk_fact_match').outcome,'issue');
  d.riskUpdate!.historicalRiskRemoved=e(true);assert.equal(check(d,'evidence:risk_removal_basis').outcome,'needs_evidence');
  assert.equal(check(d,'risk_sufficiency').outcome,'needs_judgement');
});
test('#20-v4 document-delivery: scoped sections, actual revisions/comments and post-output WPS',()=>{
  const d=input();assert.equal(check(d,'delivery_coverage').outcome,'pass'); // not a mandatory 16-section outline
  assert.equal(check(d,'delivery_wps_receipt').outcome,'needs_judgement');
  d.delivery!.revisionCount=e(0);d.delivery!.commentCount=e(0);
  assert.equal(check(d,'delivery_revisions').outcome,'issue');assert.equal(check(d,'delivery_comments').outcome,'issue');
  d.delivery!.deliveredSections=e(['terms','financial']);assert.equal(check(d,'delivery_coverage').outcome,'issue');
  d.delivery!.exemptSections=e(['risk']);assert.equal(check(d,'evidence:delivery_exemption_basis').outcome,'needs_evidence');absent(d,'delivery_coverage');
  d.delivery!.requiredSections=e([]);assert.equal(check(d,'delivery_empty_plan').outcome,'needs_evidence');
  d.delivery!.artifactHash=e('');d.delivery!.wpsOpenedAndReopened=e(true);
  assert.equal(check(d,'evidence:delivery_artifact_hash').outcome,'needs_evidence');absent(d,'delivery_wps_receipt');absent(d,'delivery_revisions');
});
test('#20-v4 trustee-continuing-duties: guidance and agreements do not prove performance',()=>{
  const d=input();assert.equal(check(d,'trustee_claim_basis').outcome,'pass');
  for(const v of ['guideline_example','agreement'] as const){d.trusteeStatement!.supportKind=e(v);assert.equal(check(d,'trustee_claim_basis').outcome,'issue');}
  d.trusteeStatement!.statementKind=e('arrangement');assert.equal(check(d,'trustee_claim_basis').outcome,'pass');
});
test('#20-v4 coverage and untrusted input: all 31 handled but six professional decisions remain uncovered',()=>{
  const r=result(input());assert.equal(r.handledRuleIds!.length,31);assert.equal(SSE_PRIVATE_CHECKED_RULES.length,25);
  assert.equal(r.manualRuleIds!.length,6);assert.deepEqual(r.uncoveredRuleIds,r.manualRuleIds);assert.equal(r.productionEligible,false);
  const d=input();const poison=(v:unknown):void=>{if(v && typeof v==='object'){const row=v as Record<string,unknown>;if(row.status==='verified')row.status='user_asserted';for(const child of Object.values(row))poison(child);}};
  poison(d);d.asOf=e('2026-09-26');assert.ok(result(d).findings.every(f=>f.outcome!=='pass'));
  d.sourceSelection!.selected={value:'100',status:'verified',anchors:null} as unknown as SsePrivateCheckInput['asOf'];
  assert.doesNotThrow(()=>result(d));
  const mixed=structuredClone(pack);mixed.rules.find(r=>r.rule_id==='sse-private-protection')!.checker.checker_version='3';assert.throws(()=>evaluate(mixed,input()),/VERSION_MISMATCH/);
});
