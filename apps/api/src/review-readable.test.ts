import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, type PrivateBlobs } from './data.js';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';
import { registerReadableReview, readReviewMarkdown } from './review-readable.js';

function fixture(options: { foreign?: boolean; input?: string; invalidUtf8?: boolean; noMarkdown?: boolean } = {}) {
  const markdown = options.invalidUtf8 ? Buffer.from([0xff, 0xfe]) : Buffer.from('# 合成报告\n原文位置、发现、建议。'), sha = digest(markdown), input = 'a'.repeat(64);
  const reportKey = `owners/owner/projects/project/runs/run/review-files/call/${sha}/report.md`;
  const result = Buffer.from(JSON.stringify({ version:'codex-review-file-v1', input_hash: options.input ?? input,
    files: options.noMarkdown ? { 'final-response.md': { key:reportKey,sha256:sha,byte_size:markdown.length } } : { 'report.md': { key: options.foreign ? reportKey.replace('/run/', '/other-run/') : reportKey, sha256:sha,byte_size:markdown.length } } }));
  const ref = `users/owner/projects/project/provider-results/call-${digest(result)}.json`;
  const data = new Map([[ref,result],[reportKey,markdown]]), reads: string[] = [];
  const blobs = { getIfExistsBounded: async (key:string) => { reads.push(key); return data.get(key) ?? null; } };
  const row = { owner_user_id:'owner',project_id:'project',run_id:'run',call_id:'call',input_hash:input,result_ref:ref,result_sha256:digest(result),byte_size:result.length };
  return { blobs,row,data,reads,reportKey };
}
test('readable view loads the exact private Markdown, no prompts or final chatter', async () => {
  const f = fixture(), report = await readReviewMarkdown(f.blobs, f.row);
  assert.equal(report?.markdown, '# 合成报告\n原文位置、发现、建议。'); assert.equal(f.reads.length,2);
  const missing = fixture({ noMarkdown:true }); assert.equal(await readReviewMarkdown(missing.blobs, missing.row),null);
});
test('cross-run references, mismatched input/hash, unavailable or invalid UTF8 safely disable only the optional view', async () => {
  for (const options of [{foreign:true},{input:'b'.repeat(64)},{invalidUtf8:true}]) {
    const f = fixture(options); assert.equal(await readReviewMarkdown(f.blobs,f.row),null);
  }
  const f=fixture(); f.data.set(f.reportKey,Buffer.from('tampered'));
  assert.equal(await readReviewMarkdown(f.blobs,f.row),null);
  const g=fixture();g.row.result_ref='users/other/secret.json';
  assert.equal(await readReviewMarkdown(g.blobs,g.row),null);assert.equal(g.reads.length,0);
});

test('historical Word-only progress report is reported invalid by a read-only owner-scoped route',async()=>{
  const word=makeSyntheticDocxFixture({text:'BB_REVIEW_PROGRESS:read_materials:started'}),queries:string[]=[];
  const db={query:async(sql:string,params:unknown[])=>{
    queries.push(sql);assert.match(sql,/^SELECT/);assert.equal(params[0],'owner');assert.equal(params[1],'project');
    if(sql.includes('SELECT p.*'))return {rows:[{id:'project',owner_user_id:'owner'}]};
    if(sql.includes('SELECT r.input_hash'))return {rows:[{input_hash:'a'.repeat(64),version:2}]};
    if(sql.includes('FROM bb_provider_result_refs'))return {rows:[]};
    if(sql.includes('SELECT v.object_key'))return {rows:[{object_key:'owned-report',sha256:digest(word)}]};
    throw Error('unexpected SQL');
  }} as unknown as Pool;
  let content=word;const blobs={getIfExistsBounded:async(key:string)=>{assert.equal(key,'owned-report');return content;}} as unknown as PrivateBlobs;
  const app=Fastify();registerReadableReview(app,()=>db,async()=> 'owner',()=>blobs);
  try{
    const response=await app.inject('/api/v1/projects/project/review-executions/run/readable-report');
    assert.equal(response.statusCode,200);assert.equal(response.json().status,'invalid_content');assert.equal(response.json().markdown,'');
    assert.match(response.headers['cache-control']!,/no-store/);assert.equal(queries.length,4);
    content=Buffer.from('tampered');
    assert.equal((await app.inject('/api/v1/projects/project/review-executions/run/readable-report')).json().status,'unavailable','hash failure cannot be declared empty');
  }finally{await app.close();}
});
