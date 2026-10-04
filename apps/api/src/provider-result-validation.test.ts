/** Synthetic private-result validation; no database, customer bytes or provider. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { digest, Problem, type PrivateBlobs } from './data.js';
import { persistProviderResultObject, type ProviderCallIntent } from './provider-results.js';

const intent: ProviderCallIntent = {
  owner_user_id:'synthetic-owner',project_id:'synthetic-project',job_id:'synthetic-job',
  run_id:'synthetic-run',trace_id:'synthetic-run',logical_call_id:'synthetic-review',
  call_id:'synthetic-call',attempt_no:1,model_id:'synthetic-model',
  model_config_version:'synthetic-v1',prompt_snapshot_ref:'synthetic-prompt',
};
function storage() {
  const objects = new Map<string,Buffer>();
  const blobs: PrivateBlobs = {
    put: async (key,bytes) => { objects.set(key,Buffer.from(bytes)); },
    get: async key => { const bytes=objects.get(key); assert.ok(bytes); return Buffer.from(bytes); },
    getIfExists: async key => objects.get(key) ?? null,
    getIfExistsBounded: async (key,max) => { const bytes=objects.get(key); assert.ok(!bytes || bytes.length<=max); return bytes ?? null; },
    exists: async key => objects.has(key),delete: async key => { objects.delete(key); },
  };
  return {blobs,objects};
}
const bytes=()=>Buffer.from('{"synthetic":true}');
const schemaFailure=(error:unknown)=>error instanceof Problem && error.status===422 && error.code==='DELIVERY_FAILED';

test('an asynchronous false verdict cannot persist a private result',async()=>{
  const {blobs,objects}=storage();
  await assert.rejects(persistProviderResultObject({blobs,intent,bytes:bytes(),resultSchemaVersion:'synthetic-v1',
    validate:async value=>{assert.deepEqual(value,{synthetic:true});await setImmediate();return false;}}),schemaFailure);
  assert.equal(objects.size,0);
});

test('private persistence waits for an asynchronous verdict and binds checked bytes',async()=>{
  const {blobs,objects}=storage(),input=bytes(),expected=Buffer.from(input);
  let resolve!: (value:boolean)=>void;
  const verdict=new Promise<boolean>(r=>{resolve=r;});
  const pending=persistProviderResultObject({blobs,intent,bytes:input,resultSchemaVersion:'synthetic-v1',
    validate:value=>{assert.deepEqual(value,{synthetic:true});return verdict;}});
  await setImmediate();
  assert.equal(objects.size,0,'no result is stored before validation resolves');
  input.fill(0);
  resolve(true);
  const result=await pending;
  assert.equal(objects.size,1);
  assert.deepEqual(await blobs.get(result.result_ref),expected);
  assert.equal(result.result_sha256,digest(expected));
});

test('a rejected asynchronous validator never stores a result',async()=>{
  const {blobs,objects}=storage(),failure=new Error('Synthetic validator interruption');
  await assert.rejects(persistProviderResultObject({blobs,intent,bytes:bytes(),resultSchemaVersion:'synthetic-v1',
    validate:async()=>{await setImmediate();throw failure;}}),error=>error===failure);
  assert.equal(objects.size,0);
});

test('synchronous validators remain compatible and malformed JSON is rejected first',async()=>{
  const {blobs,objects}=storage();
  await persistProviderResultObject({blobs,intent,bytes:bytes(),resultSchemaVersion:'synthetic-v1',validate:()=>true});
  assert.equal(objects.size,1);
  let called=false;
  await assert.rejects(persistProviderResultObject({blobs,intent,bytes:Buffer.from('{'),resultSchemaVersion:'synthetic-v1',
    validate:async()=>{called=true;return true;}}),schemaFailure);
  assert.equal(called,false);
  assert.equal(objects.size,1);
});
