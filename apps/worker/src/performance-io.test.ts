import assert from 'node:assert/strict';
import test from 'node:test';
import type {PrivateBlobs} from '@bondbuddy/api/data';
import {PerformanceTraceRuntime,type PerformanceSpanRecord} from '@bondbuddy/api/performance-trace';
import {performanceBlobs,withArtifactPromotionPerformance} from './performance-io.js';

test('blob instrumentation preserves private receivers, values, errors and records only hashed references',async()=>{
 const rows=new Map<string,PerformanceSpanRecord>();
 const runtime=new PerformanceTraceRuntime(async(_s,p)=>{for(const row of p)rows.set(row.span_id,row);});
 const bytes=Buffer.from('synthetic private body'),failure=new Error('same storage failure');
 class Adapter{
  #value:Buffer=bytes;
  async put(_key:string,value:Buffer){this.#value=value;}
  async getIfExistsBounded(key:string,_max:number){if(key==='fail')throw failure;return this.#value;}
  async readToFile(){return {byteSize:this.#value.length,sha256:'a'.repeat(64)};}
  async exists(){return this.#value.length>0;}
 }
 const base=new Adapter(),wrapped=performanceBlobs(base as unknown as PrivateBlobs);
 const secret='owners/private/customer/file.docx?sig=secret';
 await runtime.trace({ownerUserId:'owner',projectId:'project',runId:'run'},async()=>{
  assert.equal(wrapped.getIfExistsBounded,wrapped.getIfExistsBounded);
  await wrapped.put(secret,bytes,'text/plain');
  assert.equal(await wrapped.getIfExistsBounded(secret,1024),bytes);
  assert.deepEqual(await wrapped.readToFile!(secret,null,1024),{byteSize:bytes.length,sha256:'a'.repeat(64)});
  assert.equal(await wrapped.exists(secret),true);
  await assert.rejects(wrapped.getIfExistsBounded('fail',1024),e=>e===failure);
 });
 await runtime.drain();
 const operations=[...rows.values()].filter(row=>row.step_key.startsWith('storage.'));
 assert.equal(operations.length,4);
 assert.equal(operations.filter(row=>row.status==='failed').length,1);
 assert.equal(operations.find(row=>row.attributes.operation==='readToFile')?.attributes.output_bytes,bytes.length);
 assert(operations.every(row=>/^[a-f0-9]{64}$/.test(String(row.attributes.object_ref))));
 assert(!JSON.stringify(operations).includes('private'));assert(!JSON.stringify(operations).includes('secret'));
});

test('storage telemetry unavailable never turns successful storage into a failure',async()=>{
 const runtime=new PerformanceTraceRuntime(async()=>{throw Error('telemetry unavailable');});
 const output=Buffer.from('synthetic');
 const blobs=performanceBlobs({getIfExistsBounded:async()=>output} as unknown as PrivateBlobs);
 assert.equal(await runtime.trace({ownerUserId:'owner',projectId:'project',runId:'run'},()=>blobs.getIfExistsBounded('safe',1024)),output);
 await runtime.drain(10);
});

test('handled unavailable delivery is recorded as a failed promotion',async()=>{
 const rows=new Map<string,PerformanceSpanRecord>();
 const runtime=new PerformanceTraceRuntime(async(_s,spans)=>{for(const row of spans)rows.set(row.span_id,row);});
 const value={status:'unavailable',failureCode:'WORD_DELIVERY_UNAVAILABLE'};
 assert.equal(await runtime.trace({ownerUserId:'owner',projectId:'project',runId:'run'},()=>withArtifactPromotionPerformance({},()=>value)),value);
 await runtime.drain();assert.equal([...rows.values()].find(row=>row.step_key==='artifact.promote')?.status,'failed');
});
