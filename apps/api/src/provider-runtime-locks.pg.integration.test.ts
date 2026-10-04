// Synthetic PostgreSQL lock/lease regression. Uses a private database clone,
// creates no material bytes and makes no supplier calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { isolatedTestDatabase } from './test-database.js';
import { recordModelAttemptRuntime, type ModelAttemptRuntime, type ProviderCallIntent } from './provider-results.js';
import type { Lease } from './queue.js';

const connection=await isolatedTestDatabase('BB_TEST_PROVIDER_RUNTIME_DATABASE_URL');
const runtime:ModelAttemptRuntime={adapter:'codex_exec',adapter_version:'synthetic-runtime-1',model_provider:'synthetic',
  model_config_version:'synthetic-model-1',provider_request_id_status:'unknown',framework_thread_id:'synthetic-thread',
  started_at:'2026-10-04T00:00:00.000Z',duration_ms:1000,exit_code:0,exit_signal:null,finish_reason:'stop',error_code:null,
  tool_attempts:0,pricing_status:'unknown'};

test('runtime evidence shares run -> job lock order with renewal and cancellation', {skip:!connection}, async t=>{
  const applicationName=`synthetic-runtime-lock-${randomUUID()}`;
  const pool=new Pool({connectionString:connection,max:4,application_name:applicationName});
  const observer=new Pool({connectionString:connection,max:2});

  async function fixture():Promise<{lease:Lease;intent:ProviderCallIntent}>{
    const owner=`synthetic-owner-${randomUUID()}`,projectId=randomUUID(),runId=randomUUID(),jobId=randomUUID(),callId=randomUUID();
    const inputHash='a'.repeat(64),token=randomUUID(),logicalCallId='synthetic-review';
    await observer.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic runtime lock review','review')",[projectId,owner]);
    await observer.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,'{}','[]','[]')`,[projectId,owner,inputHash]);
    await observer.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
      VALUES($1,$2,$3,1,$4,$1,'review',$4,'running')`,[runId,owner,projectId,inputHash]);
    await observer.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,lease_token,lease_until,attempts)
      VALUES($1,$2,$3,'review','synthetic','running',$4,now()+interval '60 seconds',1)`,[jobId,owner,runId,token]);
    await observer.query(`INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status,model_id)
      VALUES($1,$2,$3,$4,1,'pending_reconcile','synthetic-model')`,[callId,owner,jobId,logicalCallId]);
    return {lease:{jobId,runId,owner,token,checkpoint:{},attempts:1},intent:{owner_user_id:owner,project_id:projectId,job_id:jobId,
      run_id:runId,trace_id:runId,logical_call_id:logicalCallId,call_id:callId,attempt_no:1,model_id:'synthetic-model',
      model_config_version:'synthetic-model-1',prompt_snapshot_ref:'synthetic-prompt'}};
  }

  async function lockRun(lease:Lease):Promise<PoolClient>{
    const holder=await observer.connect();
    await holder.query('BEGIN');
    await holder.query("SET LOCAL statement_timeout='2s'");
    await holder.query('SELECT id FROM bb_runs WHERE owner_user_id=$1 AND id=$2 FOR UPDATE',[lease.owner,lease.runId]);
    return holder;
  }

  async function waitForRuntimeLock(){
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){
      const row=(await observer.query(`SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'
        AND cardinality(pg_blocking_pids(pid))>0`,[applicationName])).rows[0];
      if(row)return;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.fail('runtime transaction did not reach the held run lock');
  }

  try{
    await t.test('renewal keeps the job lock available while runtime waits for the run',async()=>{
      const f=await fixture(),holder=await lockRun(f.lease);
      // Attach both handlers immediately so a failure is never an unhandled rejection.
      const writing=recordModelAttemptRuntime(pool,f.lease,f.intent,runtime).then(value=>({value,error:null}),error=>({value:null,error}));
      try{
        await waitForRuntimeLock();
        // The old job -> run order blocks here until statement_timeout: runtime
        // already holds this job while waiting for the holder's run foreign key.
        await holder.query('SELECT id FROM bb_jobs WHERE id=$1 FOR UPDATE',[f.lease.jobId]);
        await holder.query("UPDATE bb_jobs SET lease_until=now()+interval '60 seconds' WHERE id=$1",[f.lease.jobId]);
        await holder.query('COMMIT');
        const result=await writing;
        assert.equal(result.error,null);
        assert.deepEqual(result.value,{idempotent:false});
        assert.deepEqual(await recordModelAttemptRuntime(pool,f.lease,f.intent,runtime),{idempotent:true});
        assert.equal((await observer.query('SELECT count(*)::int n FROM bb_model_call_attempt_runtime WHERE attempt_id=$1',[f.intent.call_id])).rows[0].n,1);
      }finally{await holder.query('ROLLBACK');holder.release();await writing;}
    });

    await t.test('cancellation wins before evidence locks and prevents a late runtime insert',async()=>{
      const f=await fixture(),holder=await lockRun(f.lease);
      const writing=recordModelAttemptRuntime(pool,f.lease,f.intent,runtime).then(value=>({value,error:null}),error=>({value:null,error}));
      try{
        await waitForRuntimeLock();
        await holder.query('SELECT id FROM bb_jobs WHERE id=$1 FOR UPDATE',[f.lease.jobId]);
        await holder.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[f.lease.runId]);
        await holder.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE id=$1",[f.lease.jobId]);
        await holder.query('COMMIT');
        const result=await writing;
        assert.equal(result.error?.code,'CAPABILITY_NOT_READY');
        assert.equal((await observer.query('SELECT count(*)::int n FROM bb_model_call_attempt_runtime WHERE attempt_id=$1',[f.intent.call_id])).rows[0].n,0);
      }finally{await holder.query('ROLLBACK');holder.release();await writing;}
    });

    await t.test('owner, project, token and expired lease remain enforced',async()=>{
      const f=await fixture();
      await assert.rejects(recordModelAttemptRuntime(pool,{...f.lease,owner:'synthetic-foreign-owner'},f.intent,runtime),{code:'NOT_FOUND'});
      await assert.rejects(recordModelAttemptRuntime(pool,f.lease,{...f.intent,project_id:'synthetic-foreign-project'},runtime),{code:'NOT_FOUND'});
      await assert.rejects(recordModelAttemptRuntime(pool,{...f.lease,token:'synthetic-stale-token'},f.intent,runtime),{code:'CAPABILITY_NOT_READY'});
      await observer.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[f.lease.jobId]);
      await assert.rejects(recordModelAttemptRuntime(pool,f.lease,f.intent,runtime),{code:'CAPABILITY_NOT_READY'});
      assert.equal((await observer.query('SELECT count(*)::int n FROM bb_model_call_attempt_runtime WHERE attempt_id=$1',[f.intent.call_id])).rows[0].n,0);
    });
  }finally{await pool.end();await observer.end();}
});
