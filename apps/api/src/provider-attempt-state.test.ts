import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type { Lease } from './queue.js';
import { latestProviderAttempt, loadProviderAttemptState, readExecutionProviderAttempts } from './provider-results.js';

const hash='a'.repeat(64),otherHash='b'.repeat(64);
const mismatch={status:409,code:'INPUT_REVISION_CONFLICT'};
function fixture(){
  const lease:Lease={owner:'owner',runId:'run',jobId:'job',token:'token',attempts:1,checkpoint:{},
    executionVersion:1,inputRevision:1,inputHash:hash};
  const checkpoint:Record<string,unknown>={};
  const run={id:'run',owner_user_id:'owner',project_id:'project',input_revision:1,input_hash:hash,checkpoint};
  const attempts:Record<string,any>[]=[],bindings=new Map<string,Record<string,any>>(),unresolved=new Set<string>();
  let live=true,attemptReads=0;
  function add(id:string,number:number,version=1,status='completed',logical='logical'){
    const revision=version,inputHash=version===1?hash:otherHash,prompt=`prompt-${id}`;
    attempts.push({id,logical_call_id:logical,attempt_no:number,status,usage_status:'measured',prompt_snapshot_id:prompt,
      execution_version:version,input_revision:revision,input_hash:inputHash,prompt_snapshot_ref:prompt,operator_retry:false,observed:true});
    bindings.set(id,{attempt_id:id,owner_user_id:'owner',project_id:'project',run_id:'run',job_id:'job',
      execution_version:version,input_revision:revision,input_hash:inputHash,prompt_snapshot_ref:prompt,
      attempt_owner:'owner',attempt_job:'job',attempt_prompt:prompt,job_owner:'owner',job_run:'run',run_owner:'owner',run_project:'project',
      execution_owner:'owner',execution_project:'project',execution_version_ref:version,execution_input_revision:revision,
      execution_input_hash:inputHash,prompt_owner:'owner',prompt_project:'project',prompt_run:'run',snapshot_kind:'model_request',
      prompt_input_revision:revision,prompt_input_hash:inputHash,revision_input_hash:inputHash});
  }
  const pool={query:async(sql:string,args:unknown[]=[])=>{
    assert.doesNotMatch(sql,/^\s*(UPDATE|INSERT|DELETE|ALTER)\b/i,'lookup never changes evidence or execution gates');
    if(sql.startsWith('SELECT r.*'))return {rows:live?[run]:[],rowCount:live?1:0};
    if(sql.includes('FROM bb_run_execution_versions'))return {rows:[{execution_version:1,input_revision:1,input_hash:hash}]};
    if(sql.includes('FROM bb_model_call_execution_bindings b'))return {rows:bindings.has(args[0] as string)?[bindings.get(args[0] as string)]:[]};
    if(sql.includes('LEFT JOIN bb_model_call_execution_bindings b')){attemptReads++;return {rows:attempts};}
    if(sql.includes('FROM bb_model_call_attempts a')){
      const ids=args[1] as string[]|null;
      const blocked=[...unresolved].some(id=>ids===null || ids.includes(id));
      return {rows:blocked?[{present:1}]:[],rowCount:blocked?1:0};
    }
    throw Error(`Unexpected lookup: ${sql}`);
  }} as unknown as Pool;
  return {pool,lease,checkpoint,attempts,bindings,unresolved,add,expire:()=>{live=false;},attemptReads:()=>attemptReads};
}

test('real attempt lookup validates source before selecting current execution and preserves global numbering',async()=>{
  // Mixed versions exercise the real query consumer without enabling a second
  // database execution or weakening the production V1 gate.
  const f=fixture();f.add('current',1);f.add('history',7,2);
  const result=await readExecutionProviderAttempts(f.pool,f.lease,'logical');
  assert.deepEqual(result.attempts.map(row=>row.call_id),['current']);
  assert.deepEqual(result.all_attempts.map(row=>[row.call_id,row.execution_version,row.input_hash]),
    [['current',1,hash],['history',2,otherHash]]);
  assert.equal(result.next_attempt_no,8);
  const state=await loadProviderAttemptState(f.pool,f.lease,'logical');
  assert.equal(state.latest?.call_id,'current');assert.equal(state.execution_attempt_count,1);
  assert.equal(state.next_attempt_no,8);assert.equal(state.blocked,false);
});

test('a missing or corrupted foreign binding cannot disappear into absent current work',async()=>{
  for(const corruption of ['missing','prompt','input']){
    const f=fixture();f.add('foreign',7,2);
    if(corruption==='missing')f.bindings.delete('foreign');
    else if(corruption==='prompt')f.bindings.get('foreign')!.attempt_prompt='wrong';
    else f.bindings.get('foreign')!.prompt_input_revision=1;
    await assert.rejects(loadProviderAttemptState(f.pool,f.lease,'logical'),mismatch,corruption);
  }
});

test('unknown work remains explicit both across executions and across logical calls',async()=>{
  const f=fixture();f.add('foreign-pending',7,2,'pending_reconcile');f.unresolved.add('foreign-pending');
  const state=await loadProviderAttemptState(f.pool,f.lease,'logical');
  assert.equal(state.latest,null);assert.equal(state.next_attempt_no,8);
  assert.equal(state.execution_attempt_count,0);assert.equal(state.blocked,true);
  await assert.rejects(latestProviderAttempt(f.pool,f.lease,'logical'),{status:409,code:'CAPABILITY_NOT_READY'},
    'the old latest-only API cannot turn blocked history into absent work');
  const same=fixture();same.add('other-pending',1,1,'pending_reconcile','other');same.unresolved.add('other-pending');
  const other=await loadProviderAttemptState(same.pool,same.lease,'logical');
  assert.equal(other.latest,null);assert.equal(other.blocked,true,'a new logical ID does not bypass unknown work');
  const current=await loadProviderAttemptState(same.pool,same.lease,'other');
  assert.equal(current.latest?.call_id,'other-pending');assert.equal(current.blocked,false,
    'the adapter can record the current unknown observation, without resending');
});

test('unprompted V1 history stays visible without receiving an invented execution binding',async()=>{
  const f=fixture();f.attempts.push({id:'legacy',logical_call_id:'logical',attempt_no:1,status:'confirmed_not_sent',
    usage_status:'unknown',prompt_snapshot_id:null,execution_version:null,observed:false});
  const rows=await readExecutionProviderAttempts(f.pool,f.lease,'logical');
  assert.deepEqual(rows.attempts,[]);assert.deepEqual(rows.all_attempts,[]);
  assert.deepEqual(rows.legacy_attempts.map(row=>row.call_id),['legacy']);
  const state=await loadProviderAttemptState(f.pool,f.lease,'logical');
  assert.equal(state.latest?.call_id,'legacy');assert.equal(state.next_attempt_no,2);assert.equal(state.execution_attempt_count,1);
});

test('direct journal lookup checks persisted stage identity and active lease before looking at attempts',async()=>{
  const f=fixture();f.add('current',1);
  f.checkpoint.stage_execution={execution_version:2,input_revision:2,input_hash:otherHash};
  await assert.rejects(loadProviderAttemptState(f.pool,f.lease,'logical'),mismatch);assert.equal(f.attemptReads(),0);
  delete f.checkpoint.stage_execution;f.expire();
  await assert.rejects(readExecutionProviderAttempts(f.pool,f.lease),{status:409,code:'CAPABILITY_NOT_READY'});
  assert.equal(f.attemptReads(),0);
});
