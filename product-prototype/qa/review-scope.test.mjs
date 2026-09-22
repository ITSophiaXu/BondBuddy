import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSearchQueries } from '../public/review-scope.js';
import { gatherExternal,externalDocuments } from '../lib/external.mjs';
test('review searches cover public announcements, registry, legal-credit events and bonds; one failure does not suppress other searches',async()=>{
  const original=globalThis.fetch,seen=[];
  globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);seen.push(body.query);if(seen.length===2)return new Response('',{status:503});return new Response(JSON.stringify({results:[{title:'官方公告',url:'https://example.org/notice',content:'测试发行人 公告'}]}),{status:200});};
  try{
    const result=await gatherExternal({query:'测试发行人',issuer:'测试发行人',queries:reviewSearchQueries('测试发行人','sse-private'),web:true,registry:false,settings:{tavilyKey:'test-only'}});
    assert.equal(seen.length,4);assert(seen.every(q=>q.includes('测试发行人')));assert(seen.some(q=>q.includes('诉讼')));assert.equal(result.results.length,3);assert.equal(result.coverage.length,4);assert(result.coverage.every(c=>c.complete===false));assert(result.limitations.some(v=>v.includes('检索失败')));assert(externalDocuments(result)[0].records[0].text.includes('查询时间'));
  }finally{globalThis.fetch=original;}
});
