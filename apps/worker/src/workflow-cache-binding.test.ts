import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '@bondbuddy/api/data';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {loadChapterContext,type ChapterContextV1} from './workflow-input.js';
import type {StageContext} from './run-pipeline.js';

function fixture(){
 const input={manifest:{materials:[{material_id:'material',material_version:1,sha256:'a'.repeat(64),role:'audit'}],authoring:{version:'unified_v1',knowledge:[]}},materials:[{pin:{material_id:'material',material_version:1,sha256:'a'.repeat(64),role:'audit'},records:[],extraction_snapshot:{parse_snapshot:{response_sha256:'b'.repeat(64)},ocr_snapshot:{coverage:{page_count:2,covered:[1],failed:[],missing:[2]}}}}],requirements:['Synthetic cache fixture']} as unknown as ChapterContextV1['input'];
 const parser_version='synthetic-cache-parser-v1',input_hash='c'.repeat(64),value:ChapterContextV1={version:'chapter-context-v1',input_hash,parser_version,input,source:null,chapters:[{title:'Synthetic chapter',source_node_ids:[]}],nodes:[],material_snapshot_hash:inputManifestHash({input,parser_version})};
 let bytes=Buffer.from(JSON.stringify(value)),queries=0,reads=0;const key='users/owner/projects/project/runs/run/workflow-v1/context.json';
 const ctx={run:{id:'run',owner_user_id:'owner',project_id:'project',input_hash},signal:new AbortController().signal,checkpoint:{chapter_context_v1:{ref:{key,sha256:digest(bytes),byte_size:bytes.length},input_hash,material_snapshot_hash:value.material_snapshot_hash}},
  pool:{query:async()=>{queries++;assert.fail('cached chapter context must not enter parse/OCR or database loading');}},blobs:{getIfExistsBounded:async(k:string)=>{reads++;assert.equal(k,key,'cache hit reads only the pinned context object, not original materials');return bytes;}}} as unknown as StageContext;
 return {ctx,value,counts:()=>({queries,reads}),replace:(mutate:(value:ChapterContextV1)=>void,updateObjectRef=false)=>{
  const next=JSON.parse(JSON.stringify(value)) as ChapterContextV1;mutate(next);bytes=Buffer.from(JSON.stringify(next));
  if(updateObjectRef)ctx.checkpoint.chapter_context_v1!.ref={key,sha256:digest(bytes),byte_size:bytes.length};
 }};
}
test('a pinned cache hit across recreated contexts performs no material read, parse or OCR',async()=>{
 const f=fixture();assert.deepEqual(await loadChapterContext(f.ctx),f.value);assert.deepEqual(await loadChapterContext({...f.ctx,checkpoint:structuredClone(f.ctx.checkpoint)}),f.value);assert.deepEqual(f.counts(),{queries:0,reads:2});
});
for(const mutation of ['material_version','coverage','parse_response'] as const)test(`cached ${mutation} alteration rejects before parsing, OCR or further use`,async()=>{
 const f=fixture();f.replace(value=>{
  if(mutation==='material_version')value.input.materials[0]!.pin.material_version=2;
  else if(mutation==='coverage')(value.input.materials[0]!.extraction_snapshot!.ocr_snapshot as any).coverage={page_count:2,covered:[1,2],failed:[],missing:[]};
  else (value.input.materials[0]!.extraction_snapshot!.parse_snapshot as any).response_sha256='d'.repeat(64);
 },true);
 await assert.rejects(loadChapterContext(f.ctx),/INPUT_REVISION_CONFLICT/);assert.deepEqual(f.counts(),{queries:0,reads:1});
});
test('changed object bytes cannot be accepted under the original pinned hash',async()=>{
 const f=fixture();f.replace(value=>{value.input.requirements.push('Synthetic changed bytes');});await assert.rejects(loadChapterContext(f.ctx),/WORKFLOW_OBJECT_READBACK_FAILED/);assert.deepEqual(f.counts(),{queries:0,reads:1});
});
