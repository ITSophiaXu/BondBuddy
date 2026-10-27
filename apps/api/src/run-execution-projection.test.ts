// Pure synthetic projection tests. A different execution tuple here is data
// mapping only: no successor is inserted, authorized, queued or billed.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { assertRunExecution, projectRunExecution, runExecutionOrigin, type RunExecutionIdentity } from './run-execution.js';

const conflict=(error:unknown)=>(error as {code?:string}).code==='INPUT_REVISION_CONFLICT';
const origin=()=>({id:'synthetic-run',owner_user_id:'synthetic-owner',project_id:'synthetic-project',
  input_revision:7,input_hash:'a'.repeat(64),task_kind:'update',state:'running',
  billing_mode:'fixed_credits',channel:'non_production_test',test_grant_id:'original-grant',
  execution_request_id:'original-request',request_hash:'c'.repeat(64),created_at:'2026-10-27T00:00:00.123456Z'});
const initial:RunExecutionIdentity={executionVersion:1,inputRevision:7,inputHash:'a'.repeat(64)};
const later:RunExecutionIdentity={executionVersion:2,inputRevision:11,inputHash:'b'.repeat(64)};

test('execution projection separates the original request input from the input consumed by stages',()=>{
  const raw=origin(),before=structuredClone(raw),projected=projectRunExecution(raw,later);
  assert.deepEqual({executionVersion:projected.executionVersion,inputRevision:projected.inputRevision,inputHash:projected.inputHash},later);
  assert.equal(projected.input_revision,later.inputRevision);
  assert.equal(projected.input_hash,later.inputHash);
  assert.deepEqual(projected.originInput,{inputRevision:before.input_revision,inputHash:before.input_hash});
  assert.deepEqual({id:projected.id,owner:projected.owner_user_id,project:projected.project_id},
    {id:raw.id,owner:raw.owner_user_id,project:raw.project_id});
  for(const field of ['task_kind','state','billing_mode','channel','test_grant_id','execution_request_id','request_hash','created_at'] as const)
    assert.equal(projected[field],before[field],`${field} remains original run metadata`);
  assert.deepEqual(raw,before,'preparing stage input cannot rewrite the original run or billing metadata');
  assert.deepEqual(runExecutionOrigin(projected),{id:raw.id,owner_user_id:raw.owner_user_id,project_id:raw.project_id,
    input_revision:raw.input_revision,input_hash:raw.input_hash});
});

test('stage identity cannot be mutated and raw origin rows remain available to their ordinary writers',()=>{
  const raw=origin(),projected=projectRunExecution(raw,later);
  for(const [field,value] of [['input_revision',42],['input_hash','d'.repeat(64)],['executionVersion',42],
    ['inputRevision',42],['inputHash','d'.repeat(64)]] as const)
    assert.throws(()=>{(projected as unknown as Record<string,unknown>)[field]=value;},TypeError);
  assert.throws(()=>{(projected.originInput as {inputRevision:number}).inputRevision=42;},TypeError);
  assert.throws(()=>{(projected.originInput as {inputHash:string}).inputHash='d'.repeat(64);},TypeError);
  raw.state='paused';
  assert.equal(raw.state,'paused','the projection does not freeze a row used by queue/accounting code');
  assert.equal(projected.state,'running','the stage gets its own run-state snapshot');
  assert.deepEqual(projected.originInput,{inputRevision:7,inputHash:'a'.repeat(64)});
});

test('reprojection requires explicit origin extraction and never silently promotes an old execution to origin',()=>{
  const raw=origin(),projected=projectRunExecution(raw,later);
  assert.throws(()=>projectRunExecution(projected as unknown as Parameters<typeof projectRunExecution>[0],initial),conflict);
  const reprojected=projectRunExecution(runExecutionOrigin(projected),initial);
  assert.deepEqual(reprojected.originInput,{inputRevision:7,inputHash:'a'.repeat(64)});
  assert.equal(reprojected.input_revision,7);assert.equal(reprojected.input_hash,'a'.repeat(64));
  assert.deepEqual(raw,origin());
});

test('ordinary origin extraction rejects serialized or client-shaped projection impersonations',()=>{
  const raw=origin(),projected=projectRunExecution(raw,later);
  const impostors=[JSON.parse(JSON.stringify(projected)),
    {...raw,originInput:{inputRevision:7,inputHash:raw.input_hash}},
    {...raw,executionVersion:2,inputRevision:11,inputHash:'b'.repeat(64)}];
  for(const impostor of impostors){
    assert.throws(()=>runExecutionOrigin(impostor),conflict);
    assert.throws(()=>projectRunExecution(impostor,initial),conflict);
  }
  assert.deepEqual(runExecutionOrigin(raw),{id:raw.id,owner_user_id:raw.owner_user_id,project_id:raw.project_id,
    input_revision:raw.input_revision,input_hash:raw.input_hash});
});

test('projection data never opens the persisted V1 execution gate or replaces raw origin checks',async()=>{
  const raw=origin(),projected=projectRunExecution(raw,later);let reads=0;
  const db={query:async()=>{reads++;return {rows:[{execution_version:2,input_revision:11,input_hash:'b'.repeat(64)}]};}} as unknown as Pool;
  await assert.rejects(assertRunExecution(db,projected as unknown as Parameters<typeof assertRunExecution>[1],later),conflict);
  assert.equal(reads,0,'an execution projection cannot be silently used as a raw run origin');
  await assert.rejects(assertRunExecution(db,runExecutionOrigin(projected),later),conflict);
  assert.equal(reads,1);
  const wrongOrigin={...raw,input_revision:8};
  const v1={query:async()=>({rows:[{execution_version:1,input_revision:7,input_hash:raw.input_hash}]})} as unknown as Pool;
  await assert.rejects(assertRunExecution(v1,wrongOrigin,initial),conflict);
  assert.deepEqual(await assertRunExecution(v1,raw,initial),initial);
  assert.deepEqual(raw,origin());
});
