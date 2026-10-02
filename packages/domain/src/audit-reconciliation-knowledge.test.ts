import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AUDIT_RECONCILIATION_KNOWLEDGE as pack } from './audit-reconciliation-knowledge.js';

test('retained user source hash and all original item quotes match the runtime knowledge',async()=>{
  const source=await readFile(new URL('../../../knowledge/audit-reconciliation/sources/source.docx',import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'),pack.source_sha256);
  const index=JSON.parse(await readFile(new URL('../../../knowledge/audit-reconciliation/source-items.json',import.meta.url),'utf8'));
  assert.equal(index.source_sha256,pack.source_sha256);assert.equal(index.authority_claims_verified,false);
  assert.equal(index.items.length,40);assert.equal(pack.rules.length,40);
  assert.deepEqual(pack.rules.map(r=>r.source_item),Array.from({length:40},(_,i)=>i+1));
  assert.equal(new Set(pack.rules.map(r=>r.id)).size,40);
  for(const rule of pack.rules){
    const item=index.items.find((i:{source_item:number})=>i.source_item===rule.source_item);
    assert.equal(rule.title,item.title);assert.equal(rule.source_quote,item.source_quote);
    assert(Number.isInteger(item.source_quote_paragraph)&&item.source_quote_paragraph>item.source_heading_paragraph);
    assert(rule.conditions.length>0);assert(rule.caveat.length>0);
  }
});

test('conditional and qualitative source formulas cannot acquire executable arithmetic by accident',()=>{
  assert.equal(pack.rules.filter(r=>r.category==='deterministic').length,16);
  assert.equal(pack.rules.filter(r=>r.category==='conditional').length,18);
  assert.equal(pack.rules.filter(r=>r.category==='manual').length,6);
  for(const rule of pack.rules){
    if(rule.category==='deterministic')assert(rule.terms?.length);
    else assert.equal(rule.terms,undefined);
  }
  const item=(n:number)=>pack.rules.find(r=>r.source_item===n)!;
  assert.match(item(26).caveat+item(26).conditions.join(''),/汇率/);
  assert.match(item(8).caveat+item(8).conditions.join(''),/少数股东权益/);
  assert.match(item(18).caveat+item(18).conditions.join(''),/负号/);
  assert.match(item(31).caveat+item(31).conditions.join(''),/重述/);
  assert.match(item(34).caveat+item(34).conditions.join(''),/现金等价物/);
  assert.match(item(40).caveat+item(40).conditions.join(''),/重复/);
});

test('runtime formulas and nested aliases cannot be mutated after the version is pinned',()=>{
  assert(Object.isFrozen(pack));assert(Object.isFrozen(pack.rules));
  const rule=pack.rules[0]!;
  assert(Object.isFrozen(rule));assert(Object.isFrozen(rule.terms));assert(Object.isFrozen(rule.terms![0]));
  assert(Object.isFrozen(rule.result_aliases));
  assert.throws(()=>{rule.terms![0]!.coefficient=-1;},TypeError);
});
