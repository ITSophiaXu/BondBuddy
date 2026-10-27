import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { assertModelCallExecution, type ModelCallExecutionScope } from './model-call-execution.js';
import { latestProviderAttempt, readCheckpointedProviderResult } from './provider-results.js';
import type { Lease } from './queue.js';
import type { PrivateBlobs } from './data.js';

const hash='a'.repeat(64);
const scope:ModelCallExecutionScope={owner:'owner',projectId:'project',runId:'run',jobId:'job',attemptId:'attempt',
  executionVersion:1,inputRevision:1,inputHash:hash};
const mismatch={status:409,code:'INPUT_REVISION_CONFLICT'};
function fixture(){
  const row:Record<string,unknown>={attempt_id:'attempt',owner_user_id:'owner',project_id:'project',run_id:'run',job_id:'job',
    execution_version:1,input_revision:1,input_hash:hash,prompt_snapshot_ref:'prompt',attempt_owner:'owner',attempt_job:'job',attempt_prompt:'prompt',
    job_owner:'owner',job_run:'run',run_owner:'owner',run_project:'project',execution_owner:'owner',execution_project:'project',
    execution_version_ref:1,execution_input_revision:1,execution_input_hash:hash,prompt_owner:'owner',prompt_project:'project',prompt_run:'run',
    snapshot_kind:'model_request',prompt_input_revision:1,prompt_input_hash:hash,revision_input_hash:hash};
  const rows:Record<string,unknown>[]=[row];
  const reads:string[]=[];
  const db={query:async(sql:string,args:unknown[])=>{
    reads.push(sql);assert.deepEqual(args,['attempt']);assert.doesNotMatch(sql,/latest|max\(|ORDER BY/i);return {rows};
  }} as unknown as Pool;
  return {row,rows,reads,db};
}

test('model work binding returns the exact immutable input and prompt without selecting latest',async()=>{
  const f=fixture(),before=structuredClone(f.rows);
  assert.deepEqual(await assertModelCallExecution(f.db,scope),{...scope,promptSnapshotRef:'prompt'});
  assert.deepEqual(f.rows,before);assert.equal(f.reads.length,1);
});

test('missing, duplicate, foreign, altered input and incomplete prompt bindings fail closed',async()=>{
  const fields=['attempt_id','owner_user_id','project_id','run_id','job_id','attempt_owner','attempt_job','attempt_prompt',
    'job_owner','job_run','run_owner','run_project','execution_owner','execution_project','prompt_snapshot_ref',
    'prompt_owner','prompt_project','prompt_run','snapshot_kind','input_hash','execution_input_hash','prompt_input_hash','revision_input_hash'];
  for(const field of fields){
    const f=fixture();f.row[field]='different';
    await assert.rejects(assertModelCallExecution(f.db,scope),mismatch,field);
  }
  for(const field of ['execution_version','input_revision','execution_version_ref','execution_input_revision','prompt_input_revision']){
    const f=fixture();f.row[field]=2;
    await assert.rejects(assertModelCallExecution(f.db,scope),mismatch,`${field}, even when the hash is unchanged`);
  }
  for(const field of ['prompt_snapshot_ref','attempt_prompt','prompt_input_revision','prompt_input_hash']){
    const f=fixture();f.row[field]=null;await assert.rejects(assertModelCallExecution(f.db,scope),mismatch,field);
  }
  const missing=fixture();missing.rows.length=0;await assert.rejects(assertModelCallExecution(missing.db,scope),mismatch);
  const duplicate=fixture();duplicate.rows.push({...duplicate.row});await assert.rejects(assertModelCallExecution(duplicate.db,scope),mismatch);
});

test('actual provider lookups never turn an existing unbound prompted attempt into a new call',async()=>{
  const lease:Lease={owner:'owner',runId:'run',jobId:'job',token:'token',attempts:1,checkpoint:{},executionVersion:1,inputRevision:1,inputHash:hash};
  const run={id:'run',owner_user_id:'owner',project_id:'project',input_revision:1,input_hash:hash,checkpoint:{}};
  let bindingReads=0,blobReads=0;
  const pool={query:async(sql:string)=>{
    if(sql.includes('FROM bb_model_call_execution_bindings')){bindingReads++;return {rows:[]};}
    if(sql.includes('FROM bb_run_execution_versions'))return {rows:[{execution_version:1,input_revision:1,input_hash:hash}]};
    if(sql.startsWith('SELECT r.*'))return {rows:[run],rowCount:1};
    if(sql.includes('FROM bb_model_call_attempts a'))return {rows:[{id:'attempt',attempt_no:1,status:'completed',usage_status:'measured',prompt_snapshot_id:'prompt',checkpoint:{}}]};
    throw Error('Unexpected read after unbound existing attempt');
  }} as unknown as Pool;
  const blobs={get:async()=>{blobReads++;throw Error('No Blob reads expected');}} as unknown as PrivateBlobs;
  await assert.rejects(latestProviderAttempt(pool,lease,'logical'),mismatch);
  await assert.rejects(readCheckpointedProviderResult({pool,blobs,lease,logicalCallId:'logical',attemptNo:1,validateResult:()=>true}),mismatch);
  assert.equal(bindingReads,2);assert.equal(blobReads,0);
});
