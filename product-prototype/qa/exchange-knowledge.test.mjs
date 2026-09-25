import test from 'node:test';
import assert from 'node:assert/strict';
import { loadKnowledge, manifest } from '../lib/knowledge.mjs';

test('six exchange scopes have separate update and review research routes',async()=>{
  const items=await manifest();assert.equal(items.length,12);
  assert.equal(new Set(items.map(x=>x.id)).size,12);
  for(const item of items){
    const knowledge=await loadKnowledge(item.scope,item.kind);
    assert.equal(knowledge.id,item.id);assert.equal(knowledge.scope,item.scope);
    assert.equal(knowledge.productionReady,false);
    assert.equal(knowledge.status,'research_draft');
    assert.equal(knowledge.rules.length,item.ruleCount);
    assert.ok(knowledge.sourceChunks.length);
    assert.ok(knowledge.sourceChunks.every(chunk=>chunk.records.every(record=>/^(P\d{5}|PAGE\d{3})$/.test(record.locator))));
    assert.ok(!knowledge.sourceChunks.some(chunk=>chunk.documentId==='EX021'));
  }
});

test('public_all does not borrow a public package or omit retail qualifications',async()=>{
  for(const market of ['sse','szse'])for(const kind of ['update','review']){
    const retail=await loadKnowledge(`${market}-public_all`,kind);
    const professional=await loadKnowledge(`${market}-public`,kind);
    assert.notEqual(retail.id,professional.id);
    assert.ok(retail.rules.some(r=>r.rule_id.endsWith('-retail-public')));
    assert.ok(retail.rules.some(r=>r.rule_id.endsWith(`-retail-metrics-${market}`)));
    assert.ok(!professional.rules.some(r=>r.rule_id.endsWith('-retail-public')));
    assert.match(retail.handbook,/250亿元/);assert.match(retail.handbook,/100亿元/);
    assert.match(retail.conflicts,/现行效力及专业验收待核/);
  }
});

test('unknown scopes and kinds fail without falling back to another market',async()=>{
  await assert.rejects(loadKnowledge('sse-unknown','update'));
  await assert.rejects(loadKnowledge('sse-private','unknown'));
});
