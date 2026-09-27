import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateRulePackCapability,
  nafmiiMtnChapterTemplate,
  nafmiiMtnCoverageManifest,
  nafmiiMtnDraftRulePack,
  nafmiiCpDraftRulePack,
  nafmiiScpDraftRulePack,
  publishRulePack,
  publishRulePackBundle,
  validateRulePackCompanions,
  type CoverageManifest,
} from './index.js';

const clone = <T>(value:T):T => structuredClone(value);

test('the MTN draft and its chapter/coverage companions are internally consistent',()=>{
  const result=validateRulePackCompanions(nafmiiMtnDraftRulePack,nafmiiMtnChapterTemplate,nafmiiMtnCoverageManifest);
  assert.equal(result.ok,true,result.ok?'':JSON.stringify(result.problems));
  assert.equal(nafmiiMtnDraftRulePack.scope.market,'nafmii');
  assert.equal(nafmiiMtnDraftRulePack.scope.offering,'mtn');
  assert.deepEqual(nafmiiMtnChapterTemplate.chapters.map(item=>item.form_refs[0]),[
    'M-0','M-1','M-2','M-3','M-4','M-5','M-6','M-7','M-8','M-9','M-10','M-11','M-12','M-13','M-14','M-15','M-16','M-17',
  ]);
});

test('the M-12 holder meeting chapter retains its source, form, and semantic fields',()=>{
  const chapter=nafmiiMtnChapterTemplate.chapters.find(item=>item.chapter_id==='m-12');
  assert.ok(chapter,'M-12 holder meeting chapter must remain in the template');
  assert.deepEqual(chapter.form_refs,['M-12']);
  assert.deepEqual(chapter.source_ref_ids,['nafmii-public-forms-2020']);
  assert.ok(nafmiiMtnDraftRulePack.sources.some(item=>item.source_id==='nafmii-public-forms-2020'));
  assert.deepEqual(chapter.required_fields,[
    'meeting_scope','convening','procedures','participation','voting','other_obligations',
  ]);
});

test('official binary sources retain reproducible SHA-256 fingerprints',()=>{
  const expected={
    'nafmii-mtn-guide-2021':'a908a42699ab94c9c396fdbcad6fcacb9a0a12b505a3933b36b3f01d3c612b9e',
    'nafmii-public-forms-2020':'bc07230ee3368b5ee22ec421e6755c6170ed24fe906b9213b53545c4bf0a531c',
    'nafmii-registration-rules-2023':'0047ae2b57158d2a89ae5dff725aed9c296a52e55b20860a382b0920b28e7e6b',
    'nafmii-disclosure-rules-2023':'cca3cfaed55d9c3a81b3b2fa12480bd325b8bf920af1c437148b34e56a2780da',
  } as const;
  for(const [sourceId,hash] of Object.entries(expected)){
    assert.equal(nafmiiMtnDraftRulePack.sources.find(item=>item.source_id===sourceId)?.document_hash,hash);
  }
});

test('shared 2026 notice source cites one contiguous official clause, not stitched policy text',()=>{
  for(const pack of [nafmiiMtnDraftRulePack,nafmiiCpDraftRulePack,nafmiiScpDraftRulePack]){
    const source=pack.sources.find(item=>item.source_id==='nafmii-basic-tier-notice-2026');
    assert.equal(source?.clause_locator,'第一项：优化基础层企业分类');
    assert.equal(source?.exact_quote,'原第四类企业并入第三类企业实施注册发行管理，统称为基础层企业。');
  }
});

test('the MTN draft cannot advertise a production capability',()=>{
  const result=evaluateRulePackCapability(nafmiiMtnDraftRulePack,{
    market:'nafmii',offering:'mtn',document_stage:'issuance',issuer_scope:'domestic-nonfinancial-enterprise-public',
    instrument:'standard-mtn',investor_scope:'interbank-institutional',special_features:[],as_of:'2026-09-24',
  });
  assert.equal(result.decision,'capability_not_ready');
  assert.deepEqual(result.reason_codes,['pack_not_production_published']);
});

test('production publication rejects research sources even with test-only attestations',()=>{
  const reviews=[
    { reviewer_id:'industry-reviewer',reviewer_role:'industry_reviewer' as const,reviewed_at:'2026-09-24T09:00:00Z',source_verified:true,scope_verified:true,samples_verified:true,notes:'test-only attestation' },
    { reviewer_id:'technical-reviewer',reviewer_role:'technical_reviewer' as const,reviewed_at:'2026-09-24T09:01:00Z',source_verified:true,scope_verified:true,samples_verified:true,notes:'test-only attestation' },
  ];
  assert.throws(()=>publishRulePack(nafmiiMtnDraftRulePack,{channel:'production',reviews,released_by:'test-release-operator',released_at:'2026-09-27T10:00:00Z',reason:'negative gate test'}),/RULE_PACK_HAS_UNPUBLISHABLE_RULES/);
});

test('bundle publication cannot bypass explicit uncovered items or blockers',()=>{
  assert.throws(()=>publishRulePackBundle(nafmiiMtnDraftRulePack,nafmiiMtnChapterTemplate,nafmiiMtnCoverageManifest,{
    channel:'test',reviews:[],released_by:'test-release-operator',released_at:'2026-09-24T10:00:00Z',reason:'negative coverage gate test',
  }),/RULE_PACK_COVERAGE_INCOMPLETE/);
});

test('coverage explicitly separates other products and unresolved MTN overlays',()=>{
  const byId=new Map(nafmiiMtnCoverageManifest.items.map(item=>[item.item_id,item.disposition]));
  assert.equal(byId.get('ppn-cp-scp-dfi'),'not_applicable');
  assert.equal(byId.get('basic-tier-2026'),'uncovered');
  assert.equal(byId.get('special-products'),'uncovered');
  assert.equal(byId.get('authorized-real-samples'),'uncovered');
  assert.ok(nafmiiMtnCoverageManifest.open_blockers.length>=3);
});

test('companion validation rejects unknown source references and scope drift',()=>{
  const coverage=clone(nafmiiMtnCoverageManifest) as CoverageManifest;
  coverage.items[0]!.source_ref_ids=['missing-source'];
  const result=validateRulePackCompanions(nafmiiMtnDraftRulePack,{...nafmiiMtnChapterTemplate,offering:'cp'},coverage);
  assert.equal(result.ok,false);
  if(!result.ok){
    assert.ok(result.problems.some(item=>item.code==='TEMPLATE_SCOPE_MISMATCH'));
    assert.ok(result.problems.some(item=>item.code==='SOURCE_REFERENCE_MISSING'));
  }
});
