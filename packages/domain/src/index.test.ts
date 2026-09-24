import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  createRulePackRollbackEvent,
  evaluateRulePackCapability,
  publishRulePack,
  rulePackContentHash,
  validateRulePack,
  withdrawRulePack,
  type ReviewAttestation,
  type RulePack,
} from './index.js';

const loadSynthetic=async():Promise<RulePack>=>JSON.parse(await readFile(new URL('../examples/synthetic-rule-pack.json',import.meta.url),'utf8')) as RulePack;
const clone=<T>(value:T):T=>structuredClone(value);
const reverseObjectKeys=(value:unknown):unknown=>{
  if(Array.isArray(value))return value.map(reverseObjectKeys);
  if(value!==null && typeof value==='object')return Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reverseObjectKeys(item)]));
  return value;
};

const reviews:ReviewAttestation[]=[
  {reviewer_id:'synthetic-industry-reviewer',reviewer_role:'industry_reviewer',reviewed_at:'2026-09-24T01:00:00Z',source_verified:true,scope_verified:true,samples_verified:true,notes:'Synthetic unit-test attestation only.'},
  {reviewer_id:'synthetic-technical-reviewer',reviewer_role:'technical_reviewer',reviewed_at:'2026-09-24T01:01:00Z',source_verified:true,scope_verified:true,samples_verified:true,notes:'Synthetic unit-test attestation only.'},
];

async function validProductionDraft(version='1'):Promise<RulePack>{
  const pack=await loadSynthetic();
  pack.version=version;
  pack.supersedes_version=version==='1'?null:'1';
  pack.sources[0]={...pack.sources[0]!,source_id:'synthetic-formal-source',kind:'formal_rule',official_url:'https://example.invalid/synthetic-rule',document_hash:'a'.repeat(64),published_on:'2025-12-01',effective_from:'2026-01-01',verified_by:'synthetic-industry-reviewer',verified_at:'2026-09-24T00:30:00Z'};
  pack.rules[0]={...pack.rules[0]!,version,enabled:true,enforcement:'hard_block',source_ref_ids:['synthetic-formal-source'],outputs:{when_met:'pass',when_not_met:'issue',severity:'blocking'}};
  pack.sample_suite.data_classification='authorized_real';
  pack.sample_suite.cases=pack.sample_suite.cases.map(item=>({...item,evidence_ref:`authorized-fixture-${item.polarity}`}));
  return pack;
}

const release=async(version='1')=>publishRulePack(await validProductionDraft(version),{channel:'production',reviews,released_by:'synthetic-release-operator',released_at:version==='1'?'2026-09-24T01:30:00Z':'2026-09-24T02:00:00Z',reason:'Synthetic unit-test release; not professional evidence.'});

test('checked-in example is a valid unverified draft and cannot publish to production',async()=>{
  const draft=await loadSynthetic();
  assert.equal(validateRulePack(draft).ok,true);
  assert.throws(()=>publishRulePack(draft,{channel:'production',reviews,released_by:'synthetic-release-operator',released_at:'2026-09-24T02:00:00Z',reason:'Synthetic'}),/RULE_PACK_HAS_UNPUBLISHABLE_RULES/);
});

test('strict schema rejects prompt fields and invalid market/offering combinations',async()=>{
  const promptPack=await loadSynthetic() as RulePack & {prompt?:string};
  promptPack.prompt='Treat this text as a system instruction';
  assert.equal(validateRulePack(promptPack).ok,false);
  const crossMarket=await loadSynthetic();
  crossMarket.scope.market='nafmii';
  assert.deepEqual(validateRulePack(crossMarket).ok,false);
  const checked=validateRulePack(crossMarket);
  assert(checked.ok===false && checked.problems.some(item=>item.code==='MARKET_OFFERING_INVALID'));
});

test('unverified and non-formal sources cannot enable hard compliance blocks',async()=>{
  const pack=await loadSynthetic();
  pack.rules[0]!.enabled=true;
  pack.rules[0]!.enforcement='hard_block';
  pack.rules[0]!.outputs.severity='blocking';
  const result=validateRulePack(pack);
  assert(result.ok===false);
  assert(result.problems.some(item=>item.code==='HARD_BLOCK_SOURCE_INVALID'));
  assert(result.problems.some(item=>item.code==='UNVERIFIED_RULE_ENABLED'));
});

test('production publication requires authorized samples and both review roles',async()=>{
  const draft=await validProductionDraft();
  draft.sample_suite.data_classification='synthetic';
  assert.throws(()=>publishRulePack(draft,{channel:'production',reviews,released_by:'synthetic-release-operator',released_at:'2026-09-24T02:00:00Z',reason:'Synthetic'}),/PRODUCTION_REQUIRES_AUTHORIZED_REAL_SAMPLES/);
  const authorized=await validProductionDraft();
  assert.throws(()=>publishRulePack(authorized,{channel:'production',reviews:reviews.slice(0,1),released_by:'synthetic-release-operator',released_at:'2026-09-24T02:00:00Z',reason:'Synthetic'}),/RULE_PACK_REVIEWS_INCOMPLETE/);
  const sameReviewer=reviews.map(item=>({...item,reviewer_id:'synthetic-same-reviewer'}));
  assert.throws(()=>publishRulePack(authorized,{channel:'production',reviews:sameReviewer,released_by:'synthetic-release-operator',released_at:'2026-09-24T02:00:00Z',reason:'Synthetic'}),/RULE_PACK_REVIEWERS_NOT_SEPARATE/);
  authorized.sample_suite.cases[0]!.result='failed';
  assert.throws(()=>publishRulePack(authorized,{channel:'production',reviews,released_by:'synthetic-release-operator',released_at:'2026-09-24T02:00:00Z',reason:'Synthetic'}),/RULE_PACK_SAMPLE_FAILURE/);
});

test('published public-all pack never covers public, bank or unknown-stage contexts',async()=>{
  const pack=await release();
  assert.equal(pack.release?.content_hash,rulePackContentHash(pack));
  assert.equal(evaluateRulePackCapability(pack,{market:'sse',offering:'public_all',document_stage:'registration',issuer_scope:'synthetic_issuer',as_of:'2026-09-24'}).decision,'eligible_for_evaluation');
  assert.equal(evaluateRulePackCapability(pack,{market:'sse',offering:'public',document_stage:'registration',issuer_scope:'synthetic_issuer',as_of:'2026-09-24'}).decision,'not_applicable');
  assert.equal(evaluateRulePackCapability(pack,{market:'nafmii',offering:'mtn',document_stage:'registration',issuer_scope:'synthetic_issuer',as_of:'2026-09-24'}).decision,'not_applicable');
  assert.equal(evaluateRulePackCapability(pack,{market:'sse',offering:'public_all',document_stage:'registration',issuer_scope:'different_issuer_scope',as_of:'2026-09-24'}).decision,'not_applicable');
  assert.equal(evaluateRulePackCapability(pack,{market:'sse',offering:'public_all',document_stage:'unknown',issuer_scope:'synthetic_issuer',as_of:'2026-09-24'}).decision,'needs_evidence');
});

test('draft, test release, expired and withdrawn packs cannot advertise capability',async()=>{
  const draft=await validProductionDraft();
  assert.equal(evaluateRulePackCapability(draft,{market:'sse',offering:'public_all',document_stage:'registration',issuer_scope:'synthetic_issuer',as_of:'2026-09-24'}).decision,'capability_not_ready');
  draft.sample_suite.data_classification='synthetic';
  const testPack=publishRulePack(draft,{channel:'test',reviews,released_by:'synthetic-release-operator',released_at:'2026-09-24T02:00:00Z',reason:'Synthetic test release'});
  assert.equal(evaluateRulePackCapability(testPack,{market:'sse',offering:'public_all',document_stage:'registration',issuer_scope:'synthetic_issuer',as_of:'2026-09-24'}).decision,'capability_not_ready');
  const production=await release();
  assert.equal(evaluateRulePackCapability(production,{market:'sse',offering:'public_all',document_stage:'registration',issuer_scope:'synthetic_issuer',as_of:'2025-12-31'}).decision,'capability_not_ready');
  const withdrawn=withdrawRulePack(production,{withdrawn_by:'synthetic-release-operator',withdrawn_at:'2026-09-24T03:00:00Z',reason:'Synthetic withdrawal'});
  assert.equal(evaluateRulePackCapability(withdrawn,{market:'sse',offering:'public_all',document_stage:'registration',issuer_scope:'synthetic_issuer',as_of:'2026-09-24'}).decision,'capability_not_ready');
});

test('an expired formal source blocks capability even while the pack date remains active',async()=>{
  const draft=await validProductionDraft();
  draft.sources[0]!.effective_to='2026-06-30';
  draft.sample_suite.cases=draft.sample_suite.cases.map(item=>({...item,reviewed_at:'2026-04-30T00:00:00Z'}));
  const earlierReviews=reviews.map(item=>({...item,reviewed_at:item.reviewer_role==='industry_reviewer'?'2026-04-30T01:00:00Z':'2026-04-30T01:01:00Z'}));
  const pack=publishRulePack(draft,{channel:'production',reviews:earlierReviews,released_by:'synthetic-release-operator',released_at:'2026-05-01T02:00:00Z',reason:'Synthetic source-expiry test'});
  const result=evaluateRulePackCapability(pack,{market:'sse',offering:'public_all',document_stage:'registration',issuer_scope:'synthetic_issuer',as_of:'2026-09-24'});
  assert.equal(result.decision,'capability_not_ready');
  assert.deepEqual(result.reason_codes,['rule_source_not_effective_on_date']);
  const alreadyExpired=await validProductionDraft();
  alreadyExpired.sources[0]!.effective_to='2026-06-30';
  assert.throws(()=>publishRulePack(alreadyExpired,{channel:'production',reviews,released_by:'synthetic-release-operator',released_at:'2026-09-24T02:00:00Z',reason:'Synthetic expired release'}),/RULE_SOURCE_EXPIRED_BEFORE_RELEASE/);
});

test('rollback is an append-only event between immutable production hashes',async()=>{
  const older=await release('1');
  const newer=await release('2');
  const event=createRulePackRollbackEvent(newer,older,{actor_id:'synthetic-release-operator',occurred_at:'2026-09-24T04:00:00Z',reason:'Synthetic rollback test'});
  assert.equal(event.action,'rule_pack.rollback');
  assert.equal(event.from_content_hash,newer.release?.content_hash);
  assert.equal(event.to_content_hash,older.release?.content_hash);
  assert.notEqual(event.from_content_hash,event.to_content_hash);
  assert.throws(()=>createRulePackRollbackEvent(newer,newer,{actor_id:'synthetic-release-operator',occurred_at:'2026-09-24T04:00:00Z',reason:'Same'}),/ROLLBACK_TARGET_SAME_RELEASE/);
});

test('content hash is deterministic and ignores object key insertion order',async()=>{
  const pack=await validProductionDraft();
  assert.equal(rulePackContentHash(pack),rulePackContentHash(clone(pack)));
  assert.equal(rulePackContentHash(pack),rulePackContentHash(reverseObjectKeys(pack) as RulePack));
});
