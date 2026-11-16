import test from 'node:test';
import assert from 'node:assert/strict';
import {INTEGRITY_SELECTABLE_SITES, INTEGRITY_SITES, IntegrityDraftSchema, removeRetiredIntegritySites, type IntegrityDraft} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import {validateIntegrityDraft} from './integrity.js';

const retired = ['credit-china', 'execution-dishonest', 'execution-debtor', 'execution-restriction', 'industry-credit', 'customs', 'customs-credit', 'nmpa'];
const draft = (site_ids: string[]): IntegrityDraft => ({subjects: [{id: 'company', kind: 'company', name: '合成测试企业', identifier: '', role: '发行人', province: '北京', city: '北京市'}], site_ids, notes: ''});

test('new saves and checks reject each retired item, including mixed active scopes', () => {
  for (const id of retired) for (const start of [false, true]) {
    assert.throws(() => validateIntegrityDraft(draft(['tax', id]), start), {status: 422, code: 'VALIDATION_FAILED'});
  }
});

test('46 current items remain executable; empty and unknown scopes still fail', () => {
  assert.equal(INTEGRITY_SELECTABLE_SITES.length, 46);
  assert.doesNotThrow(() => validateIntegrityDraft(draft(INTEGRITY_SELECTABLE_SITES.map(site => site.id)), true));
  assert.throws(() => validateIntegrityDraft(draft([]), true), {code: 'INPUT_REQUIRED'});
  assert.throws(() => validateIntegrityDraft(draft(['unknown']), true), {code: 'VALIDATION_FAILED'});
});

test('retirement filters new preparation without mutating historical scope or metadata', () => {
  const historical = draft([...retired, 'tax', 'gsxt', 'nfra']);
  const original = structuredClone(historical);
  assert.deepEqual(removeRetiredIntegritySites(historical.site_ids), ['tax', 'gsxt', 'nfra']);
  assert.deepEqual(historical, original);
  assert.ok(Value.Check(IntegrityDraftSchema, historical));
  for (const id of retired) {
    assert.ok(INTEGRITY_SITES.find(site => site.id === id)?.links.length);
    assert.ok(!INTEGRITY_SELECTABLE_SITES.some(site => site.id === id));
  }
  assert.doesNotThrow(() => validateIntegrityDraft(draft(['gsxt', 'execution', 'judgments', 'food-drug']), true));
});

test('new preparation enforces five subjects and each subject needs an executable applicable website',()=>{
 const six=draft(['tax']);six.subjects=Array.from({length:6},(_,n)=>({...six.subjects[0],id:String(n),name:'合成企业'+n}));
 assert.throws(()=>validateIntegrityDraft(six),{code:'VALIDATION_FAILED'});
 const onlyPerson=draft(['gsxt']);onlyPerson.subjects[0].kind='person';assert.throws(()=>validateIntegrityDraft(onlyPerson,true),{code:'INPUT_REQUIRED'});
 const unresolved=draft(['local-csrc']);unresolved.subjects[0].province='';unresolved.subjects[0].city='';assert.throws(()=>validateIntegrityDraft(unresolved,true),{code:'INPUT_REQUIRED'});
 unresolved.site_ids.push('tax');assert.doesNotThrow(()=>validateIntegrityDraft(unresolved,true));
});
