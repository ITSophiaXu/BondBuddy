import assert from 'node:assert/strict';
import test from 'node:test';
import { e,input,check,absent,result,pack } from './sse-private-check-test-fixtures.js';
import { evaluateSsePrivateDraftChecks as evaluate } from './sse-private-checks.js';

test('#20-v4 issuer-governance: source/assessment completeness never substitutes a reorganization opinion',()=>{
  const d=input();assert.equal(check(d,'governance_manual_scope').outcome,'needs_judgement');
  d.governanceReview!.currentReorganizationDefinition=e('');d.governanceReview!.currentCompanyLawEvidence=e('');
  assert.equal(check(d,'evidence:governance_reorganization_definition').outcome,'needs_evidence');
  assert.equal(check(d,'evidence:governance_company_law').outcome,'needs_evidence');
  assert.ok(result(d).findings.filter(f=>f.ruleId==='sse-private-issuer-governance').every(f=>f.outcome!=='pass'));
});
test('#20-v4 related-contingent: no search hit is not absence, all areas and signing date must be covered',()=>{
  const d=input();assert.equal(check(d,'contingent_cutoff').outcome,'pass');
  for(const v of ['not_searched','no_hits'] as const){d.contingentReview!.areas[0]!.observation=e(v);assert.equal(check(d,'contingent_0_insufficient').outcome,'issue');}
  d.contingentReview!.areas[0]!.publishedAsAbsent=e(false);assert.equal(check(d,'contingent_0_insufficient').outcome,'needs_evidence');
  d.contingentReview!.areas[0]!.observation=e('present');d.contingentReview!.areas[0]!.publishedAsAbsent=e(true);assert.equal(check(d,'contingent_0_contradiction').outcome,'issue');
  d.contingentReview!.checkedThrough=e('2026-06-30');assert.equal(check(d,'contingent_cutoff').outcome,'needs_evidence');
  d.contingentReview!.checkedThrough=e('2026-09-28');assert.equal(check(d,'contingent_cutoff').outcome,'issue');
  d.contingentReview!.areas=d.contingentReview!.areas.slice(0,4);assert.equal(check(d,'contingent_area_gap').outcome,'needs_evidence');
});
test('#20-v4 sse-focus-2025: parallel profiles preserved; scrutiny does not equal a blanket ban',()=>{
  const d=input();assert.equal(d.focusReview!.triggeredProfiles.value!.length,2);
  assert.equal(check(d,'focus_manual_scope').outcome,'needs_judgement');
  d.focusReview!.blanketIssuanceBanClaimed=e(true);assert.equal(check(d,'focus_blanket_ban').outcome,'issue');
  d.focusReview!.completeFeatureReview=e(false);assert.equal(check(d,'focus_inventory_unknown').outcome,'needs_evidence');
});
test('#20-v4 special-overlays-sse: unknown is not an empty set and ordinary pack cannot approve a specialty',()=>{
  const d=input();assert.equal(check(d,'special_none').outcome,'not_applicable');
  d.specialReview!.completeFeatureReview=e(false);assert.equal(check(d,'special_scope_unknown').outcome,'needs_judgement');absent(d,'special_none');
  d.specialReview!.completeFeatureReview=e(true);d.specialReview!.features=e(['green']);
  assert.equal(check(d,'special_overlay_required').outcome,'issue');assert.equal(check(d,'evidence:special_overlay_evidence').outcome,'needs_evidence');
  d.specialReview!.ordinaryPackOnly=e(false);d.specialReview!.overlayEvidence=e('合成专项引用');assert.equal(check(d,'special_overlay_required').outcome,'needs_judgement');
});
test('#20-v4 private-negative-list: private profit exemption is not blanket eligibility',()=>{
  const d=input();assert.equal(check(d,'negative_manual_scope').outcome,'needs_judgement');
  d.negativeListReview!.publicProfitThresholdUsedToReject=e(true);d.negativeListReview!.unusedPreviousSameInstrumentQuota=e(true);d.negativeListReview!.simultaneousSameInstrumentApplication=e(true);
  for(const key of ['negative_public_profit_gate','negative_unused_quota','negative_parallel_application'])assert.equal(check(d,key).outcome,'issue');
  d.negativeListReview!.currentOfficialList=e('');assert.equal(check(d,'evidence:negative_list_current_source').outcome,'needs_evidence');
});
test('#20-v4 optimized-review-version: expired edition rejected; current edition does not prove qualification',()=>{
  const d=input();assert.equal(check(d,'optimized_not_requested').outcome,'not_applicable');
  d.optimizedReview!.requested={...e(false),value:null};assert.equal(check(d,'evidence:optimized_requested').outcome,'needs_evidence');absent(d,'optimized_not_requested');
  d.optimizedReview!.requested=e(true);d.optimizedReview!.citedEdition=e('2023-10-20');assert.equal(check(d,'optimized_edition').outcome,'issue');
  d.optimizedReview!.citedEdition=e('2026-09-04');assert.equal(check(d,'optimized_edition').outcome,'needs_judgement');
});
test('#20-v4 v3 replay preserves the original eleven-check surface',()=>{
  const legacy=structuredClone(pack);legacy.version='2026.09.27-draft.5';
  const v3=['private-investors','financial-validity-sse','private-use-change','idle-proceeds-2026','continuing-disclosure','period-window','audit-opinion','financial-statements','mdna-thresholds','funds-use-evidence','disclosure-officer-2026'];
  for(const rule of legacy.rules)rule.checker=v3.includes(rule.rule_id.replace(/^sse-private-/,''))
    ?{checker_id:'sse-private-structured-evidence',checker_version:'3',parameter_version:legacy.version}
    :{checker_id:'exchange-manual-evidence-review',checker_version:'unimplemented.1',parameter_version:legacy.version};
  const r=evaluate(legacy,input());assert.equal(r.checkerVersion,'3');assert.equal(r.uncoveredRuleIds.length,20);
  assert.equal(r.handledRuleIds,undefined);assert.ok(r.findings.every(f=>v3.includes(f.ruleId.replace(/^sse-private-/,''))));
  assert.ok(!r.findings.some(f=>f.code==='special_none'));
});
