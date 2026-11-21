import test from 'node:test';
import assert from 'node:assert/strict';
import {runContainedModelCall,loadCodexAdapterConfig,type ContainedCallInput} from './codex-adapter.js';
import {MemoryCodexJournal} from './codex-memory-journal.js';
import type {ModelCallPermit} from './model-call-budget.js';

test('a JSON call deadline expires while waiting for a permit, before any model intent',async()=>{
 const input:ContainedCallInput={owner_user_id:'synthetic-owner',project_id:'synthetic-project',job_id:'synthetic-job',run_id:'synthetic-run',trace_id:'synthetic-run',
  logical_call_id:'synthetic-chapter',prompt_snapshot_ref:'synthetic-prompt',prompt:'synthetic request',output:{kind:'json',schema:{},validate:()=>true},
  result_schema_version:'synthetic-json-v1',deadlineAt:new Date(Date.now()+200).toISOString()};
 const journal=new MemoryCodexJournal() as MemoryCodexJournal & {acquireCallSlot:(signal?:AbortSignal)=>Promise<ModelCallPermit>};
 let waiting=false;
 journal.acquireCallSlot=signal=>new Promise((_resolve,reject)=>{
  waiting=true;const timer=setTimeout(()=>reject(Error('synthetic_permit_wait_exceeded')),1000);
  const cancelled=()=>{clearTimeout(timer);reject(signal?.reason);};
  signal?.addEventListener('abort',cancelled,{once:true});if(signal?.aborted)cancelled();
 });
 await assert.rejects(runContainedModelCall(input,journal,loadCodexAdapterConfig()),/AUTHORING_CONTEXT_DEADLINE_EXCEEDED/);
 assert.equal(waiting,true);
 assert.equal(journal.intents.length,0);
});
