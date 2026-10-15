import test from 'node:test';
import assert from 'node:assert/strict';
import { M4_CASE_TEMPLATES, m4DocumentInputIssues, M4DraftInputSchema } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';
import { loadM4Knowledge, validM4Knowledge } from './m4-knowledge.js';
import { emptyM4Draft, m4UnavailableDocument } from './m4-workspace.js';

test('eleven distinct case layouts select by type, market, offering and explicit variant; bytes are pinned',()=>{
  const hashes=new Set<string>();
  for(const entry of M4_CASE_TEMPLATES){
    const pin=loadM4Knowledge(entry.market,entry.document_type,entry.offering,entry.id);
    assert.ok(validM4Knowledge(pin,entry.market,entry.document_type,entry.offering));
    assert.equal(pin.template!.id,entry.id);hashes.add(pin.template!.sha256);
    const saved=structuredClone(pin);
    pin.template!.docx_base64=Buffer.from('tampered').toString('base64');
    assert.equal(validM4Knowledge(pin,entry.market,entry.document_type,entry.offering),false);
    assert.ok(validM4Knowledge(saved,entry.market,entry.document_type,entry.offering));
    assert.equal(validM4Knowledge(saved,entry.market,entry.document_type,entry.offering==='ppn'?'mtn':'ppn'),false);
    assert.equal(Value.Check(M4DraftInputSchema,{...emptyM4Draft(entry.document_type),knowledge:saved}),false);
    assert.equal(loadM4Knowledge(entry.market,entry.document_type,entry.offering).template!.id,
      M4_CASE_TEMPLATES.find(t=>t.default&&t.market===entry.market&&t.offering===entry.offering&&t.document_type===entry.document_type)!.id);
  }
  assert.equal(hashes.size,11);
  for(const [market,offering] of [['sse','private'],['nafmii','cp'],['nafmii','dfi']] as const)
    assert.throws(()=>loadM4Knowledge(market,'recommendation',offering),/UNAVAILABLE/);
  assert.throws(()=>loadM4Knowledge('szse','application','private','sse-private-application'),/SCOPE/);
  assert.throws(()=>loadM4Knowledge('sse','application','private','../../config'),/SCOPE/);
});

test('new material validation is actionable without changing existing initiation requirements',()=>{
  const rec=emptyM4Draft('recommendation');rec.materials=[{source_project_id:'p',material_id:'m',material_version:1,sha256:'a'.repeat(64)}];
  assert.deepEqual(m4DocumentInputIssues(rec).map(i=>i.code),['M4_RECOMMENDATION_MARKET','M4_OFFERING_REQUIRED']);
  rec.fields={market:'nafmii',offering:'ppn'};assert.deepEqual(m4DocumentInputIssues(rec),[]);
  rec.fields.case_template_id='nafmii-mtn-recommendation';assert.equal(m4DocumentInputIssues(rec)[0].code,'M4_CASE_TEMPLATE_SCOPE');
  assert.ok(m4DocumentInputIssues(emptyM4Draft('init')).some(i=>i.code==='M4_TEMPLATE_REQUIRED'));
  assert.equal(m4UnavailableDocument('请生成推荐函'),false);assert.equal(m4UnavailableDocument('请生成申请书'),false);
  assert.equal(m4UnavailableDocument('请生成DFI材料'),true);
});
