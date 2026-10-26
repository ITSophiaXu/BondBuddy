// Real isolated PostgreSQL and in-memory private objects. No worker process,
// customer files, Blob service or supplier calls are used.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { isolatedTestDatabase } from './test-database.js';
import { digest, transaction, type PrivateBlobs } from './data.js';
import { grantCredits } from './billing.js';
import { assertModelCallExecution, type ModelCallExecutionScope } from './model-call-execution.js';
import { recordPotentialCall, type Lease } from './queue.js';
import { latestProviderAttempt, loadProviderAttemptState, readExecutionProviderAttempts, persistProviderResultObject, readCheckpointedProviderResult, recordModelAttemptRuntime,
  recordProviderCallObservation, type ModelAttemptRuntime, type ProviderCallIntent, type ProviderCallObservation } from './provider-results.js';

const connection=await isolatedTestDatabase(undefined,'model-call-execution');
const mismatch={status:409,code:'INPUT_REVISION_CONFLICT'};
const runtime:ModelAttemptRuntime={adapter:'codex_exec',adapter_version:'synthetic-runtime-1',model_provider:'synthetic',
  model_config_version:'synthetic-model-1',provider_request_id_status:'unknown',framework_thread_id:null,
  started_at:'2026-10-26T00:00:00.000Z',duration_ms:1,exit_code:0,exit_signal:null,finish_reason:'stop',error_code:null,
  tool_attempts:0,pricing_status:'unknown'};

function savepointPool(client:PoolClient):Pool{
  let sequence=0;
  return {query:(sql:string,values?:unknown[])=>client.query(sql,values),connect:async()=>{
    const name=`model_binding_${++sequence}`;
    return {query:async(sql:string,values?:unknown[])=>{
      if(sql==='BEGIN')return client.query(`SAVEPOINT ${name}`);
      if(sql==='COMMIT')return client.query(`RELEASE SAVEPOINT ${name}`);
      if(sql==='ROLLBACK'){
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);return client.query(`RELEASE SAVEPOINT ${name}`);
      }
      return client.query(sql,values);
    },release:()=>{}};
  }} as unknown as Pool;
}

test('real provider work is pinned to its exact execution input and cannot fall back across prompts or revisions',
  {skip:!connection,timeout:120000},async t=>{
  const pool=new Pool({connectionString:connection,max:4});
  async function fixture(){
    const owner=`model-binding-${randomUUID()}`,projectId=randomUUID(),runId=randomUUID(),jobId=randomUUID(),token=randomUUID();
    const inputHash=digest(JSON.stringify({synthetic:true,projectId}));
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`binding_${randomUUID().replaceAll('-','').slice(0,16)}`]);
    await transaction(pool,client=>grantCredits(client,{owner,points:5000,key:randomUUID(),source:'existing_grant',
      expiresAt:null,actor:'synthetic-test',reason:'Execution binding ledger preservation'}));
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic model binding','update')",[projectId,owner]);
    for(const revision of [1,2])await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,$2,$3,1,$4,$5,'[]','[]')`,[projectId,revision,owner,inputHash,{synthetic:true,projectId}]);
    // Byte-identical input is still a different immutable revision.
    await pool.query('UPDATE bb_projects SET latest_input_revision=2 WHERE id=$1',[projectId]);
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
      VALUES($1,$2,$3,1,$4,$1,'update',$4,'running','model_generation')`,[runId,owner,projectId,inputHash]);
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,lease_token,lease_until,attempts)
      VALUES($1,$2,$3,'update','synthetic','running','model_generation',$4,now()+interval '10 minutes',1)`,[jobId,owner,runId,token]);
    const objects=new Map<string,Buffer>();let blobReads=0;
    const blobs:PrivateBlobs={put:async(key,bytes)=>{objects.set(key,Buffer.from(bytes));},
      get:async key=>{blobReads++;const bytes=objects.get(key);assert.ok(bytes);return Buffer.from(bytes);},
      getIfExists:async key=>objects.get(key)??null,getIfExistsBounded:async(key,max)=>{const bytes=objects.get(key);assert.ok(!bytes||bytes.length<=max);return bytes??null;},
      exists:async key=>objects.has(key),delete:async key=>{objects.delete(key);}};
    let snapshotVersion=0;
    async function prompt(inputRevision:number|null=1,hash:string|null=inputHash,kind='model_request'){
      const id=randomUUID(),bytes=Buffer.from(`Synthetic prompt ${id}`),key=`users/${owner}/projects/${projectId}/snapshots/${id}`;
      objects.set(key,bytes);
      await pool.query(`INSERT INTO bb_snapshot_refs(id,owner_user_id,project_id,run_id,snapshot_kind,version,object_key,content_sha256,redaction_version,input_revision,input_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'synthetic-v1',$9,$10)`,[id,owner,projectId,runId,kind,++snapshotVersion,key,digest(bytes),inputRevision,hash]);
      return id;
    }
    const lease:Lease={owner,runId,jobId,token,checkpoint:{},attempts:1,executionVersion:1,inputRevision:1,inputHash};
    const promptRef=await prompt(),attemptId=randomUUID();
    const intent:ProviderCallIntent={owner_user_id:owner,project_id:projectId,job_id:jobId,run_id:runId,trace_id:runId,
      logical_call_id:'synthetic-binding-call',call_id:attemptId,attempt_no:1,model_id:'synthetic-model',
      model_config_version:'synthetic-model-1',prompt_snapshot_ref:promptRef};
    const scope:ModelCallExecutionScope={owner,projectId,runId,jobId,attemptId,executionVersion:1,inputRevision:1,inputHash};
    return {owner,projectId,runId,jobId,lease,intent,scope,prompt,blobs,objects,blobReads:()=>blobReads};
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>;
  async function snapshot(db:Pick<Pool,'query'>,f:Fixture){
    const rows:Record<string,unknown>={};
    for(const table of ['bb_runs','bb_jobs','bb_input_revisions','bb_run_execution_versions','bb_model_call_attempts',
      'bb_model_call_execution_bindings','bb_snapshot_refs','bb_provider_result_refs','bb_provider_call_observations',
      'bb_model_call_attempt_runtime','bb_usage_observations','bb_run_events','bb_outbox','bb_authoring_progress',
      'bb_credit_lots','bb_credit_reservations','bb_credit_events','bb_observability_events']){
      rows[table]=(await db.query(`SELECT * FROM ${table} WHERE owner_user_id=$1 ORDER BY to_jsonb(${table})::text`,[f.owner])).rows;
    }
    return rows;
  }
  async function intent(f:Fixture){
    assert.equal(await recordPotentialCall(pool,f.lease,f.intent.logical_call_id,1,{callId:f.intent.call_id,
      modelId:f.intent.model_id,promptSnapshotId:f.intent.prompt_snapshot_ref}),f.intent.call_id);
  }
  async function complete(f:Fixture){
    await intent(f);
    const bytes=Buffer.from('{"synthetic":true}');
    const result=await persistProviderResultObject({blobs:f.blobs,intent:f.intent,bytes,resultSchemaVersion:'synthetic-v1',validate:()=>true});
    const observation:ProviderCallObservation={...f.intent,provider_request_id:null,finish_reason:'stop',outcome:'completed',
      usage:{status:'measured',input_tokens:4,cached_input_tokens:0,output_tokens:2,reasoning_tokens:0,total_tokens:6},error_code:null,...result};
    await recordModelAttemptRuntime(pool,f.lease,f.intent,runtime);
    await recordProviderCallObservation(pool,f.blobs,observation,()=>true,{lease:f.lease,source:'provider'});
    return observation;
  }
  try{
    await t.test('the real intent INSERT atomically binds V1, runtime and completed-result reuse retain their exact source',async()=>{
      const f=await fixture();await complete(f);
      const before=await snapshot(pool,f),objects=[...f.objects].map(([key,bytes])=>[key,digest(bytes)]);
      assert.deepEqual(await assertModelCallExecution(pool,f.scope),{...f.scope,promptSnapshotRef:f.intent.prompt_snapshot_ref});
      assert.equal((await latestProviderAttempt(pool,f.lease,f.intent.logical_call_id))?.call_id,f.intent.call_id);
      const reused=await readCheckpointedProviderResult({pool,blobs:f.blobs,lease:f.lease,logicalCallId:f.intent.logical_call_id,attemptNo:1,validateResult:()=>true});
      assert.deepEqual(reused?.value,{synthetic:true});
      assert.deepEqual(await snapshot(pool,f),before);assert.deepEqual([...f.objects].map(([key,bytes])=>[key,digest(bytes)]),objects);
      for(const altered of [{executionVersion:2},{inputRevision:2},{inputHash:'b'.repeat(64)},{owner:'foreign'},
        {projectId:randomUUID()},{runId:randomUUID()},{jobId:randomUUID()},{attemptId:randomUUID()}]){
        await assert.rejects(assertModelCallExecution(pool,{...f.scope,...altered}),mismatch);
      }
      await assert.rejects(pool.query('UPDATE bb_model_call_execution_bindings SET input_revision=2 WHERE attempt_id=$1',[f.intent.call_id]),{code:'23514'});
      await assert.rejects(pool.query('DELETE FROM bb_model_call_execution_bindings WHERE attempt_id=$1',[f.intent.call_id]),{code:'23514'});
      await assert.rejects(pool.query('UPDATE bb_model_call_attempts SET prompt_snapshot_id=$2 WHERE id=$1',[f.intent.call_id,await f.prompt()]),
        {code:'23514',constraint:'bb_model_call_execution_identity_immutable'});
    });

    await t.test('new attempts reject wrong revision with identical hash, wrong hash, missing input metadata and non-model prompts',async()=>{
      for(const badPrompt of [
        (f:Fixture)=>f.prompt(2),(f:Fixture)=>f.prompt(1,'b'.repeat(64)),
        (f:Fixture)=>f.prompt(null,null),(f:Fixture)=>f.prompt(1,f.scope.inputHash,'structured_input'),
      ]){
        const f=await fixture(),promptRef=await badPrompt(f),before=await snapshot(pool,f);
        await assert.rejects(recordPotentialCall(pool,f.lease,f.intent.logical_call_id,1,{callId:f.intent.call_id,
          modelId:f.intent.model_id,promptSnapshotId:promptRef}),{code:'23514',constraint:'bb_model_call_execution_exact'});
        assert.deepEqual(await snapshot(pool,f),before,'Rejected exact-input check rolls back intent, events and billing together');
      }
    });

    await t.test('real execution lookup keeps job-wide numbering, exact source lists and unresolved work visible',async()=>{
      const f=await fixture();
      assert.deepEqual(await loadProviderAttemptState(pool,f.lease,f.intent.logical_call_id),
        {latest:null,next_attempt_no:1,execution_attempt_count:0,blocked:false});
      await complete(f);
      const completed=await loadProviderAttemptState(pool,f.lease,f.intent.logical_call_id);
      assert.equal(completed.latest?.call_id,f.intent.call_id);assert.equal(completed.next_attempt_no,2);
      assert.equal(completed.execution_attempt_count,1);assert.equal(completed.blocked,false);
      const nextId=randomUUID(),nextPrompt=await f.prompt();
      await recordPotentialCall(pool,f.lease,f.intent.logical_call_id,2,{callId:nextId,
        modelId:f.intent.model_id,promptSnapshotId:nextPrompt});
      const pending=await loadProviderAttemptState(pool,f.lease,f.intent.logical_call_id);
      assert.equal(pending.latest?.call_id,nextId);assert.equal(pending.latest?.status,'pending_reconcile');
      assert.equal(pending.next_attempt_no,3);assert.equal(pending.execution_attempt_count,2);
      assert.equal(pending.blocked,false,'the adapter retains its current pending prior to reconcile, never resend');
      const list=await readExecutionProviderAttempts(pool,f.lease);
      assert.deepEqual(list.attempts.map(row=>[row.call_id,row.prompt_snapshot_ref,row.execution_version,row.input_revision,row.input_hash]),
        [[f.intent.call_id,f.intent.prompt_snapshot_ref,1,1,f.scope.inputHash],[nextId,nextPrompt,1,1,f.scope.inputHash]]);
      assert.equal(list.needs_reconciliation,true);assert.equal(list.foreign_needs_reconciliation,false);
      const unrelated=await loadProviderAttemptState(pool,f.lease,'another-logical-call');
      assert.equal(unrelated.latest,null);assert.equal(unrelated.blocked,true,'another logical ID cannot bypass the pending call');
      await assert.rejects(readExecutionProviderAttempts(pool,{...f.lease,token:'stale-token'}),{status:409,code:'CAPABILITY_NOT_READY'});
      await pool.query('UPDATE bb_jobs SET checkpoint=$2 WHERE id=$1',[f.jobId,{stage_execution:{execution_version:2,input_revision:2,input_hash:f.scope.inputHash}}]);
      const before=await snapshot(pool,f),reads=f.blobReads();
      await assert.rejects(loadProviderAttemptState(pool,f.lease,f.intent.logical_call_id),mismatch);
      await assert.rejects(readCheckpointedProviderResult({pool,blobs:f.blobs,lease:f.lease,
        logicalCallId:f.intent.logical_call_id,attemptNo:1,validateResult:()=>true}),mismatch);
      assert.equal(f.blobReads(),reads);assert.deepEqual(await snapshot(pool,f),before);
    });

    await t.test('missing or corrupted binding blocks real latest, reuse, runtime and observation paths without writes or Blob reads',async()=>{
      const f=await fixture(),observation=await complete(f),wrongPrompt=await f.prompt(2),original=await snapshot(pool,f);
      for(const corrupt of ['missing','wrong prompt']){
        const client=await pool.connect();
        try{
          await client.query('BEGIN');
          await client.query('ALTER TABLE bb_model_call_execution_bindings DISABLE TRIGGER bb_model_call_execution_immutable');
          if(corrupt==='missing')await client.query('DELETE FROM bb_model_call_execution_bindings WHERE attempt_id=$1',[f.intent.call_id]);
          else await client.query('UPDATE bb_model_call_execution_bindings SET prompt_snapshot_ref=$2 WHERE attempt_id=$1',[f.intent.call_id,wrongPrompt]);
          await client.query('ALTER TABLE bb_model_call_execution_bindings ENABLE TRIGGER bb_model_call_execution_immutable');
          const scoped=savepointPool(client),before=await snapshot(client,f),reads=f.blobReads();
          await assert.rejects(assertModelCallExecution(client,f.scope),mismatch);
          await assert.rejects(latestProviderAttempt(scoped,f.lease,f.intent.logical_call_id),mismatch);
          await assert.rejects(loadProviderAttemptState(scoped,f.lease,f.intent.logical_call_id),mismatch);
          await assert.rejects(readExecutionProviderAttempts(scoped,f.lease),mismatch);
          await assert.rejects(readCheckpointedProviderResult({pool:scoped,blobs:f.blobs,lease:f.lease,
            logicalCallId:f.intent.logical_call_id,attemptNo:1,validateResult:()=>true}),mismatch);
          await assert.rejects(recordModelAttemptRuntime(scoped,f.lease,f.intent,runtime),mismatch);
          await assert.rejects(recordProviderCallObservation(scoped,f.blobs,observation,()=>true,{lease:f.lease,source:'provider'}),mismatch);
          assert.equal(f.blobReads(),reads);assert.deepEqual(await snapshot(client,f),before);
        }finally{await client.query('ROLLBACK');client.release();}
        assert.deepEqual(await snapshot(pool,f),original,'Deliberate corruption is local to the rolled-back test transaction');
      }
      assert.equal((await latestProviderAttempt(pool,f.lease,f.intent.logical_call_id))?.call_id,f.intent.call_id);
      const state=await loadProviderAttemptState(pool,f.lease,f.intent.logical_call_id);
      assert.equal(state.latest?.call_id,f.intent.call_id);assert.equal(state.next_attempt_no,2);
      assert.equal(state.execution_attempt_count,1);assert.equal(state.blocked,false);
    });

    await t.test('historical unprompted attempts retain identity but never gain an invented provider input binding',async()=>{
      const f=await fixture();
      await pool.query(`INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status)
        VALUES($1,$2,$3,$4,1,'confirmed_not_sent')`,[f.intent.call_id,f.owner,f.jobId,f.intent.logical_call_id]);
      assert.equal((await pool.query('SELECT 1 FROM bb_model_call_execution_bindings WHERE attempt_id=$1',[f.intent.call_id])).rowCount,0);
      assert.equal((await latestProviderAttempt(pool,f.lease,f.intent.logical_call_id))?.call_id,f.intent.call_id);
      const state=await loadProviderAttemptState(pool,f.lease,f.intent.logical_call_id);
      assert.equal(state.latest?.call_id,f.intent.call_id);assert.equal(state.next_attempt_no,2);
      assert.equal(state.execution_attempt_count,1);assert.equal(state.blocked,false);
      const rows=await readExecutionProviderAttempts(pool,f.lease);
      assert.deepEqual(rows.attempts,[]);assert.deepEqual(rows.all_attempts,[]);
      assert.equal(rows.legacy_attempts[0]?.call_id,f.intent.call_id);
      await assert.rejects(assertModelCallExecution(pool,f.scope),mismatch);
      await assert.rejects(readCheckpointedProviderResult({pool,blobs:f.blobs,lease:f.lease,
        logicalCallId:f.intent.logical_call_id,attemptNo:1,validateResult:()=>true}),mismatch);
    });
  }finally{await pool.end();}
});
