import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {evaluateRulePackCapability, publishRulePackBundle, type RulePack, type ChapterTemplate, type CoverageManifest} from './index.js';

const base=new URL('../../../knowledge/exchange-bonds/',import.meta.url);
const json=(path:string)=>JSON.parse(readFileSync(new URL(path,base),'utf8'));
const pack=json('drafts/sse-private/rule-pack.json') as RulePack;
const template=json('drafts/sse-private/chapter-template.json') as ChapterTemplate;
const coverage=json('drafts/sse-private/coverage.json') as CoverageManifest;
const catalog=json('verification/2026-09-26/catalog.json');
const map=json('drafts/sse-private/rule-evidence-map.json');

test('#20 all 31 candidates and all 17 chapter entries retain explicit limits and pending acceptance',()=>{
  assert.equal(pack.rules.length,31);
  assert.deepEqual(new Set(map.rules.map((r:any)=>r.rule_id)),new Set(pack.rules.map(r=>r.rule_id)));
  assert.deepEqual(new Set(map.chapters.map((c:any)=>c.chapter_id)),new Set(template.chapters.map(c=>c.chapter_id)));
  for(const row of map.rules){
    assert.ok(row.not_applicable_or_uncovered.length>0);
    assert.equal(row.professional_review,'pending');assert.equal(row.result_acceptance,'pending');
    assert.ok(row.chapter_ids.every((id:string)=>template.chapters.some(c=>c.chapter_id===id)));
    assert.ok(row.source_ref_ids.every((id:string)=>pack.sources.some(s=>s.source_id===id)));
  }
  for(const chapter of map.chapters)assert.ok(chapter.rule_ids.length>0 && chapter.uncovered.length>0);
  assert.ok(coverage.items.filter(i=>i.item_id!=='other-markets').every(i=>i.disposition==='uncovered'));
});

test('#20 immutable official originals/notices match evidence hashes; no professional attestation is fabricated',()=>{
  assert.equal(catalog.documents.length,10);
  for(const doc of catalog.documents){
    const original=readFileSync(new URL(doc.original_path,base));
    const notice=readFileSync(new URL(doc.notice_path,base));
    assert.equal(original.length,doc.bytes);
    assert.equal(createHash('sha256').update(original).digest('hex'),doc.sha256);
    assert.equal(createHash('sha256').update(notice).digest('hex'),doc.notice_sha256);
    assert.equal(doc.industry_review.status,'pending');assert.equal(doc.industry_review.reviewer_id,null);
    assert.equal(doc.effective_to,null); // no guessed sunset date
  }
  assert.equal(catalog.documents.filter((d:any)=>d.provided_source_matches.length>0).length,4);
});

test('#20 publication and effectivity dates are separate; optional reference text has no invented effective date',()=>{
  const officer=catalog.documents.find((d:any)=>d.document_id==='sse-officer-2025');
  assert.equal(officer.published_on,'2025-12-26');assert.equal(officer.effective_from,'2026-05-01');
  const protection=catalog.documents.find((d:any)=>d.document_id==='sse-protection-2021');
  assert.equal(protection.effective_from,null);assert.equal(protection.document_kind,'official_reference_template');
  const mature=catalog.documents.find((d:any)=>d.document_id==='sse-mature-2026');
  assert.equal(mature.effective_from,'2026-09-04');assert.match(mature.replaces,/2023/);
  const evidence=(id:string)=>pack.sources.filter(s=>pack.rules.find(r=>r.rule_id===id)!.source_ref_ids.includes(s.source_id));
  assert.ok(evidence('sse-private-financial-validity-sse').some(s=>s.clause_locator==='P00445' && s.exact_quote.includes('新申报')));
  assert.ok(evidence('sse-private-private-use-change').some(s=>s.clause_locator==='P00028' && s.exact_quote.includes('非限定偿债')));
  assert.ok(evidence('sse-private-protection').some(s=>s.clause_locator==='NOTICE' && s.exact_quote.includes('可以参照')));
});

test('#20 official retrieval and sample target confirmations cannot unlock production capability',()=>{
  for(const asOf of ['2023-12-31','2026-04-30','2026-05-01','2026-09-26']){
    const decision=evaluateRulePackCapability(pack,{market:'sse',offering:'private',
      document_stage:'issuance',issuer_scope:'domestic-company',instrument:'ordinary-company-bond',as_of:asOf});
    assert.notEqual(decision.decision,'eligible_for_evaluation');
  }
  assert.equal(pack.status,'draft');assert.equal(pack.release,null);assert.deepEqual(pack.reviews,[]);
  assert.equal(pack.sample_suite.data_classification,'synthetic');
  assert.ok(pack.rules.every(r=>!r.enabled && r.enforcement==='research_only'));
  assert.throws(()=>publishRulePackBundle(pack,template,coverage,{
    channel:'production',reviews:[],released_by:'synthetic-test-operator',released_at:'2026-09-26T04:46:22Z',reason:'negative test',
  }),/RULE_PACK_COVERAGE_INCOMPLETE/);
});
