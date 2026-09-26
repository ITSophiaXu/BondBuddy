import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  validateRulePack, validateRulePackCompanions, evaluateRulePackCapability,
  publishRulePackBundle, type RulePack, type ChapterTemplate, type CoverageManifest,
} from './index.js';
import { isMarketOffering, type Market, type Offering } from '@bondbuddy/contracts';

const base=new URL('../../../knowledge/exchange-bonds/',import.meta.url);
const json=(path:string)=>JSON.parse(readFileSync(new URL(path,base),'utf8'));
const manifest=json('manifest.json') as {scopes:{scope:string}[]};
const sources=json('sources.json') as {source_occurrences:number;sources:{source_id:string;sha256:string;bytes:number;original_path:string;aliases:unknown[];parse_status:string;market:string;document_kind:string}[]};
const official=json('verification/2026-09-26/catalog.json') as {documents:{document_id:string;original_path:string;sha256:string;bytes:number;notice_path:string;notice_sha256:string;attachment_url:string;notice_url:string;published_on:string;effective_from:string|null}[]};
const bundles=manifest.scopes.map(({scope})=>({
  scope, pack:json(`drafts/${scope}/rule-pack.json`) as RulePack,
  template:json(`drafts/${scope}/chapter-template.json`) as ChapterTemplate,
  coverage:json(`drafts/${scope}/coverage.json`) as CoverageManifest,
}));

// These are the synthetic engineering cases referenced by sample_suite.
// They do not execute financial/legal checks or constitute industry acceptance.
test('schema: six exact-scope drafts validate against the existing #19 contract',()=>{
  assert.equal(new Set(bundles.map(b=>b.scope)).size,6);
  for(const {scope,pack,template,coverage} of bundles){
    assert.ok(isMarketOffering(pack.scope.market as Market,pack.scope.offering as Offering));
    assert.equal(scope,`${pack.scope.market}-${pack.scope.offering}`);
    const result=validateRulePackCompanions(pack,template,coverage);
    assert.ok(result.ok,result.ok?'':JSON.stringify(result.problems));
    assert.equal(pack.status,'draft');assert.deepEqual(pack.reviews,[]);assert.equal(pack.release,null);
    assert.equal(pack.sample_suite.data_classification,'synthetic');
    assert.equal(evaluateRulePackCapability(pack,{
      market:pack.scope.market as Market,offering:pack.scope.offering as Offering,document_stage:'issuance',
      issuer_scope:'domestic-company',instrument:'ordinary-company-bond',as_of:'2026-09-25',
    }).decision,'capability_not_ready');
    assert.ok(pack.rules.every(rule=>!rule.enabled && rule.enforcement==='research_only'));
  }
});

test('unverified: enabling an unverified rule is rejected',()=>{
  for(const {pack} of bundles){
    const changed=structuredClone(pack);changed.rules[0]!.enabled=true;
    const validation=validateRulePack(changed);
    assert.equal(validation.ok,false);
    if(!validation.ok)assert.ok(validation.problems.some(p=>p.code==='UNVERIFIED_RULE_ENABLED'));
  }
});

test('publication: incomplete coverage cannot be published',()=>{
  for(const {pack,template,coverage} of bundles){
    assert.throws(()=>publishRulePackBundle(pack,template,coverage,{
      channel:'production',reviews:[],released_by:'synthetic-test-operator',
      released_at:'2026-09-25T10:00:00Z',reason:'synthetic negative publication test',
    }),/RULE_PACK_COVERAGE_INCOMPLETE/);
    const changed=structuredClone(template);
    changed.offering=pack.scope.offering==='public_all'?'public':'public_all';
    assert.equal(validateRulePackCompanions(pack,changed,coverage).ok,false);
  }
});

test('originals, deduplication and exact paragraph/page quotes are reproducible',()=>{
  assert.equal(sources.sources.length,34);assert.equal(sources.source_occurrences,38);
  assert.equal(sources.sources.reduce((n,s)=>n+s.aliases.length,0),38);
  assert.equal(new Set(sources.sources.map(s=>s.sha256)).size,34);
  const map=new Map(sources.sources.map(s=>[s.source_id.toLowerCase(),s]));
  for(const source of sources.sources){
    const bytes=readFileSync(new URL(source.original_path,base));
    assert.equal(bytes.length,source.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),source.sha256);
  }
  for(const {pack} of bundles)for(const source of pack.sources){
    if(source.source_id.startsWith('ov-')){
      assert.equal(pack.pack_id,'sse-private');
      const document=official.documents.find(d=>source.source_id===`ov-${d.document_id}-${source.clause_locator.toLowerCase()}`);
      assert.ok(document,source.source_id);
      const notice=source.clause_locator==='NOTICE';
      const bytes=readFileSync(new URL(notice?document.notice_path:document.original_path,base));
      assert.equal(createHash('sha256').update(bytes).digest('hex'),source.document_hash);
      assert.equal(source.document_hash,notice?document.notice_sha256:document.sha256);
      assert.equal(source.official_url,notice?document.notice_url:document.attachment_url);
      assert.equal(source.published_on,document.published_on);
      assert.equal(source.effective_from,document.effective_from);
      const records=json(`records/OV-${document.document_id}.json`).records;
      assert.equal(records.find((r:{locator:string})=>r.locator===source.clause_locator)?.text,source.exact_quote);
      assert.equal(source.kind,'unverified_lead');assert.equal(source.verified_by,null);
      continue;
    }
    const id=source.source_id.split('-')[0]!;
    const original=map.get(id);assert.ok(original);
    assert.equal(original.sha256,source.document_hash);
    assert.ok(original.market==='shared' || original.market===pack.scope.market || original.document_kind==='internal_method',source.source_id);
    const extracted=json(`records/${original.source_id}.json`);
    const record=extracted.records.find((r:{locator:string})=>r.locator===source.clause_locator);
    assert.ok(record,source.source_id);assert.equal(record.role,'body');
    assert.equal(record.text,source.exact_quote);
    assert.equal(source.kind,'unverified_lead');assert.equal(source.verified_by,null);
  }
  assert.equal(json('records/EX021.json').records.length,0);
  assert.ok(bundles.every(b=>b.pack.sources.every(s=>!s.source_id.startsWith('ex021-'))));
});

test('private, public and public_all keep distinct requirements and market chapter structures',()=>{
  for(const {pack,template} of bundles){
    const ids=pack.rules.map(r=>r.rule_id);
    assert.equal(ids.some(id=>id.endsWith('-private-investors')),pack.scope.offering==='private');
    assert.equal(ids.some(id=>id.endsWith('-public-eligibility')),pack.scope.offering!=='private');
    assert.equal(ids.some(id=>id.endsWith('-retail-public')),pack.scope.offering==='public_all');
    assert.equal(ids.some(id=>id.includes('-retail-metrics-')),pack.scope.offering==='public_all');
    assert.equal(template.chapters.length,pack.scope.market==='sse'?17:14); // front matter + 16/13 sections
  }
});
