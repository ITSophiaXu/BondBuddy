import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  evaluateRulePackCapability, validateRulePackCompanions,
  nafmiiMtnDraftRulePack, nafmiiCpDraftRulePack, nafmiiScpDraftRulePack,
} from './index.js';

const load=(offering:string,name:string)=>JSON.parse(readFileSync(new URL(`../../../knowledge/nafmii/drafts/${offering}/${name}.json`,import.meta.url),'utf8'));

for(const offering of ['ppn','dfi']) {
  test(`${offering} schema: anchored research bundle conforms to the shared contract`,()=>{
    const result=validateRulePackCompanions(load(offering,'rule-pack'),load(offering,'chapter-template'),load(offering,'coverage'));
    assert.equal(result.ok,true,result.ok?'':JSON.stringify(result.problems));
    if(!result.ok)return;
    assert.equal(result.pack.rules.length,9);
    assert.ok(result.pack.rules.every(r=>!r.enabled&&r.enforcement==='research_only'));
    assert.ok(result.pack.sources.every(s=>s.verified_by===null&&s.verified_at===null));
    assert.ok(result.coverage.items.every(i=>i.disposition==='uncovered'));
  });
  test(`${offering} cross-market: exchanged market and template identity cannot pass validation`,()=>{
    const pack=load(offering,'rule-pack');pack.scope.market='sse';
    const invalid=validateRulePackCompanions(pack,load(offering,'chapter-template'),load(offering,'coverage'));
    assert.equal(invalid.ok,false);
    const template=load(offering,'chapter-template');template.offering=offering==='ppn'?'dfi':'ppn';
    assert.equal(validateRulePackCompanions(load(offering,'rule-pack'),template,load(offering,'coverage')).ok,false);
  });
  test(`${offering} draft-gate: data completeness cannot turn research into a production capability`,()=>{
    const pack=load(offering,'rule-pack');
    const result=evaluateRulePackCapability(pack,{market:'nafmii',offering:offering as 'ppn'|'dfi',document_stage:'issuance',issuer_scope:'domestic-nonfinancial-enterprise',instrument:offering==='ppn'?'standard-ppn':'unified-registration',investor_scope:offering==='ppn'?'directional-institutional':'interbank-institutional',special_features:[],as_of:'2026-09-27'});
    assert.equal(result.decision,'capability_not_ready');
    pack.rules[0].enabled=true;pack.rules[0].enforcement='soft_check';
    assert.equal(validateRulePackCompanions(pack,load(offering,'chapter-template'),load(offering,'coverage')).ok,false);
  });
}

test('current public drafts share the 2023 disclosure source and retain concrete exception text',()=>{
  for(const pack of [nafmiiMtnDraftRulePack,nafmiiCpDraftRulePack,nafmiiScpDraftRulePack]){
    assert.equal(pack.version,pack.pack_id==='nafmii-scp'?'2026.09.28-draft.3':'2026.09.27-draft.2');
    assert.ok(!pack.sources.some(s=>s.source_id==='nafmii-disclosure-rules-2021'));
    const source=pack.sources.find(s=>s.source_id==='nafmii-disclosure-rules-2023');
    assert.equal(source?.document_hash,'cca3cfaed55d9c3a81b3b2fa12480bd325b8bf920af1c437148b34e56a2780da');
    const text=source?.exact_quote.replace(/\s/g,'')??'';
    assert.match(text,/第十三条企业发行债务融资工具/);
    assert.match(text,/第二十七条企业变更债务融资工具募集资金用途/);
    assert.match(text,/定向发行对本条涉及内容另有规定或约定的/);
    assert.ok(pack.sources.some(s=>s.source_id==='nafmii-registration-procedure-2023'));
    assert.ok(pack.sources.some(s=>s.source_id==='nafmii-mature-tier-notice-2025'));
    assert.ok(pack.sources.some(s=>s.source_id==='nafmii-basic-tier-faq-2026'));
    for(const rule of pack.rules){
      const hasUnreviewedSource=rule.source_ref_ids.some(id=>pack.sources.some(s=>s.source_id===id&&s.kind==='unverified_lead'));
      if(hasUnreviewedSource){assert.equal(rule.enabled,false);assert.equal(rule.enforcement,'research_only');}
    }
    assert.equal(pack.release,null);
  }
});

test('PPN uses the full DM outline; DFI is an arrangement overlay, not a replacement M outline',()=>{
  const ppn=load('ppn','chapter-template');
  assert.deepEqual(ppn.chapters.map((c:{chapter_id:string})=>c.chapter_id),Array.from({length:17},(_,i)=>`dm-${i}`));
  assert.ok(ppn.chapters.some((c:{required_fields:string[]})=>c.required_fields.includes('directional_disclosure_arrangements')));
  const dfi=load('dfi','rule-pack');
  assert.ok(dfi.rules.some((r:{required_inputs:string[]})=>r.required_inputs.includes('issuance_instrument')));
  assert.ok(dfi.rules.some((r:{required_inputs:string[]})=>r.required_inputs.includes('registered_amount')));
  const text=JSON.stringify(dfi);
  assert.match(text,/PDFI/);assert.match(text,/第一类/);assert.match(text,/146/);
});
