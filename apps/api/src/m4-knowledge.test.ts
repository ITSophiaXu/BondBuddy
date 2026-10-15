import test from 'node:test';
import assert from 'node:assert/strict';
import {Value} from '@sinclair/typebox/value';
import {M4_DOCUMENT_TYPES,M4DraftInputSchema,M4KnowledgeSnapshotSchema} from '@bondbuddy/contracts';
import {loadM4Knowledge,validM4Knowledge} from './m4-knowledge.js';
import {emptyM4Draft,m4UnavailableDocument} from './m4-workspace.js';
import {M4_MULTIPLIERS,validateM4BillingConfig} from './m4-billing.js';

test('all material/exchange combinations select actual source knowledge with distinct immutable bytes',()=>{
  const hashes=new Set<string>();
  for(const market of ['sse','szse'] as const)for(const type of M4_DOCUMENT_TYPES.filter(t=>!['application','recommendation'].includes(t))){
    const pin=loadM4Knowledge(market,type);hashes.add(pin.sha256);
    assert.equal(Value.Check(M4KnowledgeSnapshotSchema,pin),true);
    assert.ok(validM4Knowledge(pin,market,type));
    assert.match(pin.content,market==='sse'?/8\.1\.2非公开发行公司债券无需提交募集说明书摘要/:/第一百一十条 非公开发行/);
    assert.ok(pin.source_ids.every(id=>id.startsWith(market+'-')));
    assert.equal(validM4Knowledge(pin,market==='sse'?'szse':'sse',type),false);
    assert.equal(validM4Knowledge({...pin,content:pin.content+'tamper'},market,type),false);
    const other=M4_DOCUMENT_TYPES.find(t=>t!==type)!;assert.equal(validM4Knowledge(pin,market,other),false);
    assert.equal(Value.Check(M4DraftInputSchema,{...emptyM4Draft(type),knowledge:pin}),false);
    const saved=structuredClone(pin);pin.content='future mutation';assert.ok(validM4Knowledge(saved,market,type));
  }
  assert.equal(hashes.size,8);
  assert.throws(()=>loadM4Knowledge('sse','../legal' as never),/M4_KNOWLEDGE_UNAVAILABLE/);
});
test('readable SSE opinion replaces missing case layout while historical guide evidence remains unchanged',()=>{
  const knowledge=loadM4Knowledge('sse','underwriter');
  assert.deepEqual(knowledge.source_ids,['sse-guide','sse-private-underwriter']);
  assert.equal(knowledge.template?.id,'sse-private-underwriter');
  assert.match(knowledge.content,/第四节 主承销商内核程序及内核意见/);
  assert.match(knowledge.content,/IRM 保护，未读取/); // historical October 7 source, not the replacement case
  assert.equal(m4UnavailableDocument('请编制主承销商核查意见'),false);
  assert.equal(m4UnavailableDocument('请生成法律意见书'),false);
  assert.equal(m4UnavailableDocument('请生成推荐函'),false);
  assert.equal(M4_MULTIPLIERS.m4_G02,12);assert.equal(M4_MULTIPLIERS.m4_G03,15);
  const config={model_id:'synthetic',rates:{synthetic:{input_microyuan_per_million:1,cached_microyuan_per_million:1,output_microyuan_per_million:1}},
    budgets:Object.fromEntries(['m4_G01','m4_G05','m4_Q01','m4_Q02','m4_Q03','m4_Q04','m4_Q05'].map(k=>[k,{input_tokens:10,output_tokens:10,reserve_factor:1}]))};
  assert.doesNotThrow(()=>validateM4BillingConfig(config));
  assert.throws(()=>validateM4BillingConfig({...config,budgets:{...config.budgets,m4_G02:{input_tokens:0,output_tokens:10,reserve_factor:1}}}));
});
