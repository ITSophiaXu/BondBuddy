import assert from 'node:assert/strict';
import test from 'node:test';
import {evaluateRulePackCapability,nafmiiCpChapterTemplate,nafmiiCpCoverageManifest,nafmiiCpDraftRulePack,publishRulePackBundle,validateRulePackCompanions} from './index.js';

test('CP bundle is valid, independent and preserves the M-table chapter coverage',()=>{
  const result=validateRulePackCompanions(nafmiiCpDraftRulePack,nafmiiCpChapterTemplate,nafmiiCpCoverageManifest);
  assert.equal(result.ok,true,result.ok?'':JSON.stringify(result.problems));
  assert.equal(nafmiiCpDraftRulePack.scope.offering,'cp');
  assert.equal(nafmiiCpDraftRulePack.sources.some(source=>source.source_id==='nafmii-mtn-guide-2021'),false);
  assert.equal(nafmiiCpDraftRulePack.sources.find(source=>source.source_id==='nafmii-cp-guide-2021')?.document_hash,'20995cb88877bd53e81bfc9190898fa21433c544ad2fb35fcd75737ac84ad5b1');
  assert.deepEqual(nafmiiCpChapterTemplate.chapters.map(item=>item.form_refs[0]),Array.from({length:18},(_,index)=>`M-${index}`));
});

test('CP reused M-5 and M-9 chapter metadata is product-neutral and retains source references',()=>{
  for(const [chapterId,formRef] of [['m-5','M-5'],['m-9','M-9']] as const){
    const chapter=nafmiiCpChapterTemplate.chapters.find(item=>item.chapter_id===chapterId);
    assert.ok(chapter,`missing ${chapterId}`);
    assert.doesNotMatch(chapter.applicability,/mtn/i);
    assert.ok(chapter.form_refs.includes(formRef));
    assert.ok(chapter.source_ref_ids.includes('nafmii-public-forms-2020'));
  }
});

test('CP product cases keep the one-year boundary distinct from SCP',()=>{
  const identity=nafmiiCpDraftRulePack.rules.find(rule=>rule.rule_id==='cp-instrument-identity');
  assert.ok(identity?.required_inputs.includes('interest_start_date'));
  assert.ok(identity?.required_inputs.includes('maturity_date'));
  assert.ok(identity?.required_inputs.includes('stated_tenor'));
  const positive=identity?.positive_examples.find(example=>example.example_id==='cp-identity-positive');
  assert.ok(positive);
  assert.match(positive.summary,/合成工程示例/);
  assert.match(positive.summary,/11个月/);
  assert.match(positive.summary,/2025-01-01/);
  assert.match(positive.summary,/2025-12-01/);
  assert.match(positive.summary,/1年内/);
  assert.equal(positive.evidence_ref,'synthetic:cp-eleven-month-tenor');
  assert.doesNotMatch(positive.summary,/365\s*天/);
  assert.equal(nafmiiCpDraftRulePack.sample_suite?.cases.find(example=>example.case_id==='cp-synthetic-basic')?.evidence_ref,positive.evidence_ref);
  assert.match(identity?.boundaries.join('')??'',/365天/);
  assert.match(identity?.boundaries.join('')??'',/SCP.*270/);
  assert.equal(nafmiiCpCoverageManifest.items.find(item=>item.item_id==='mtn-ppn-scp-dfi')?.disposition,'not_applicable');
});

test('CP draft cannot advertise capability or bypass unresolved coverage',()=>{
  const capability=evaluateRulePackCapability(nafmiiCpDraftRulePack,{market:'nafmii',offering:'cp',document_stage:'issuance',issuer_scope:'domestic-nonfinancial-enterprise-public',instrument:'standard-cp',investor_scope:'interbank-institutional',special_features:[],as_of:'2026-09-24'});
  assert.equal(capability.decision,'capability_not_ready');
  assert.throws(()=>publishRulePackBundle(nafmiiCpDraftRulePack,nafmiiCpChapterTemplate,nafmiiCpCoverageManifest,{channel:'test',reviews:[],released_by:'test-release-operator',released_at:'2026-09-24T10:00:00Z',reason:'negative coverage gate test'}),/RULE_PACK_COVERAGE_INCOMPLETE/);
});
