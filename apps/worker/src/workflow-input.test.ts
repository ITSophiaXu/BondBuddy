import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '@bondbuddy/api/data';
import type {StageContext} from './run-pipeline.js';
import {readWorkflowObject,writeWorkflowObject} from './workflow-input.js';

test('an expired workflow starts no further object IO and never reads back a late write',async()=>{
  const control=new AbortController(),bytes=Buffer.from('synthetic');let reads=0,writes=0;
  const ctx={run:{id:'run',owner_user_id:'owner',project_id:'project'},signal:control.signal,
    blobs:{put:async()=>{writes++;control.abort();},getIfExistsBounded:async()=>{reads++;return bytes;}}} as unknown as StageContext;
  await assert.rejects(writeWorkflowObject(ctx,'fixture.json',bytes),{name:'AbortError'});
  assert.equal(writes,1);assert.equal(reads,0);
  await assert.rejects(readWorkflowObject(ctx,{key:'users/owner/projects/project/runs/run/workflow-v1/fixture',sha256:digest(bytes),byte_size:bytes.length}),{name:'AbortError'});
  assert.equal(reads,0);
});
