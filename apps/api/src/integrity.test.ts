import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {INTEGRITY_SELECTABLE_SITES, INTEGRITY_SITES, IntegrityDraftSchema, isRetiredIntegritySite, removeUnavailableIntegritySites, integritySelectableSitesForSubjects, resolveIntegritySite, type IntegrityDraft} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import {validateIntegrityDraft} from './integrity.js';

// Expected decisions come from committed live evidence, not from the implementation's allowlist.
const audit = JSON.parse(readFileSync(new URL('../../../docs/acceptance/integrity-accessibility-20261117.json', import.meta.url), 'utf8')) as {
  enabled_site_ids: string[];
  results: {site_id:string;category:string;decision:string;subject:IntegrityDraft['subjects'][number];configured_url:string}[];
};
const draft = (site_ids: string[]): IntegrityDraft => ({subjects: [{id: 'company', kind: 'company', name: '合成测试企业', identifier: '', role: '发行人', province: '北京', city: '北京市'}], site_ids, notes: ''});
const paused = INTEGRITY_SITES.filter(site => !audit.enabled_site_ids.includes(site.id)).map(site => site.id);

test('new saves and checks reject every paused item, including mixed verified scopes', () => {
  assert.ok(paused.length > 8);
  for (const id of paused) for (const start of [false, true]) {
    assert.throws(() => validateIntegrityDraft(draft(['pbc', id]), start), {status: 422, code: 'VALIDATION_FAILED'});
  }
});

test('the selectable catalogue matches the live audit and accepts the verified Beijing scope', () => {
  assert.deepEqual(INTEGRITY_SITES.filter(site => !isRetiredIntegritySite(site.id)).map(site => site.id).sort(), [...audit.enabled_site_ids].sort());
  assert.deepEqual(INTEGRITY_SELECTABLE_SITES.map(site=>site.id).sort(), INTEGRITY_SITES.filter(site=>!site.legacy&&audit.enabled_site_ids.includes(site.id)).map(site=>site.id).sort());
  const d = draft([]);d.site_ids = integritySelectableSitesForSubjects(d.subjects).map(site=>site.id);
  assert.ok(d.site_ids.includes('pbc'));assert.doesNotThrow(() => validateIntegrityDraft(d, true));
  assert.throws(() => validateIntegrityDraft(draft([]), true), {code: 'INPUT_REQUIRED'});
  assert.throws(() => validateIntegrityDraft(draft(['unknown']), true), {code: 'VALIDATION_FAILED'});
});

test('every regional endpoint follows its own audit result without changing historical resolution', () => {
  const regional = audit.results.filter(result=>result.category==='regional');assert.equal(regional.length,72);
  for (const result of regional) {
    const d = draft(['pbc',result.site_id]);d.subjects[0]={...d.subjects[0],...result.subject};
    const resolved = resolveIntegritySite(INTEGRITY_SITES.find(site=>site.id===result.site_id)!,d.subjects[0]);
    assert.equal(resolved.links[0].url,result.configured_url,'historical endpoint remains intact');
    for (const start of [false,true]) if(result.decision==='enabled') assert.doesNotThrow(()=>validateIntegrityDraft(d,start),result.configured_url);
    else assert.throws(()=>validateIntegrityDraft(d,start),{status:422,code:'VALIDATION_FAILED'},result.configured_url);
  }
});

test('mixed-company regional scopes reject any unavailable or unresolved endpoint', () => {
  const d = draft(['pbc','local-csrc']);
  d.subjects.push({...d.subjects[0],id:'other',name:'另一合成企业',province:'',city:''});
  assert.deepEqual(removeUnavailableIntegritySites(d.site_ids,d.subjects),['pbc']);
  assert.throws(()=>validateIntegrityDraft(d,true),{code:'VALIDATION_FAILED'});
  d.site_ids=['pbc'];assert.doesNotThrow(()=>validateIntegrityDraft(d,true));
});

test('preparing new scope never mutates the immutable historical catalogue or draft', () => {
  const historical = draft(INTEGRITY_SITES.map(site=>site.id));const original = structuredClone(historical);
  const prepared = removeUnavailableIntegritySites(historical.site_ids,historical.subjects);
  assert.ok(prepared.includes('pbc'));assert.ok(paused.every(id=>!prepared.includes(id)));
  assert.deepEqual(historical,original);assert.ok(Value.Check(IntegrityDraftSchema,historical));
  for(const id of paused)assert.ok(INTEGRITY_SITES.find(site=>site.id===id)?.links.length);
});

test('five-subject and person-applicability validation remain enforced', () => {
  const six=draft(['pbc']);six.subjects=Array.from({length:6},(_,n)=>({...six.subjects[0],id:String(n),name:'合成企业'+n}));
  assert.throws(()=>validateIntegrityDraft(six),{code:'VALIDATION_FAILED'});
  const onlyPerson=draft(['bankruptcy']);onlyPerson.subjects[0].kind='person';assert.throws(()=>validateIntegrityDraft(onlyPerson,true),{code:'INPUT_REQUIRED'});
  const unresolved=draft(['local-csrc']);unresolved.subjects[0].province='';unresolved.subjects[0].city='';assert.throws(()=>validateIntegrityDraft(unresolved,true),{code:'VALIDATION_FAILED'});
});
