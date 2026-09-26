import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadKnowledge, manifest } from '../lib/knowledge.mjs';
const privatePack = JSON.parse(readFileSync(new URL('../../knowledge/exchange-bonds/drafts/sse-private/rule-pack.json', import.meta.url), 'utf8'));

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
    assert.ok(knowledge.sourceChunks.every(chunk=>chunk.records.every(record=>/^(P\d{5}|PAGE\d{3}|NOTICE|FOOTNOTE-\d+|ENDNOTE-\d+)$/.test(record.locator))));
    assert.ok(!knowledge.sourceChunks.some(chunk=>chunk.documentId==='EX021'));
  }
});

test('#20 official evidence is routed only to SSE private; superseded 2023 optimization text is not retrieved',async()=>{
  for(const kind of ['update','review']){
    const knowledge=await loadKnowledge('sse-private',kind);
    assert.equal(knowledge.version,privatePack.version);
    assert.equal(knowledge.rules.length,31);
    assert.ok(knowledge.sources.includes('OV-sse-mature-2026'));
    assert.ok(knowledge.sources.includes('OV-sse-disclosure-2023'));
    assert.ok(!knowledge.sources.includes('EX009'));
    assert.ok(!knowledge.sources.includes('EX003'));
    assert.ok(knowledge.sourceChunks.some(c=>c.documentId==='OV-sse-protection-2021' && c.records.some(r=>r.locator==='NOTICE')));
    assert.ok(knowledge.rules.some(r=>r.rule_id==='sse-private-disclosure-officer-2026'));
    assert.equal(knowledge.productionReady,false);
    const other=await loadKnowledge('sse-public',kind);
    assert.equal(other.version,'2026.09.26-draft.2');
    assert.ok(!other.sources.some(id=>id.startsWith('OV-')));
  }
});

test('source footnotes remain retrievable while comments and superseded versions do not',async()=>{
  const knowledge=await loadKnowledge('sse-private','update');
  assert.ok(knowledge.sourceChunks.some(chunk=>chunk.documentId==='EX015' && chunk.records.some(record=>record.locator.startsWith('FOOTNOTE-'))));
  for(const item of await manifest()){
    const loaded=await loadKnowledge(item.scope,item.kind);
    assert.ok(!loaded.sources.some(id=>['EX009','EX028'].includes(id)));
    assert.ok(loaded.sourceChunks.every(chunk=>chunk.records.every(record=>!record.locator.startsWith('COMMENT-'))));
    assert.equal(loaded.sources.includes('EX039'),item.scope.startsWith('szse-'));
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
