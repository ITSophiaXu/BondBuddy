/** Synthetic PostgreSQL lock regression; no provider or material bytes. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import type { Lease } from '@bondbuddy/api/queue';
import type { ProviderCallIntent, PrivateBlobs } from '@bondbuddy/api/provider-results';
import { isolatedTestDatabase } from './test-database.js';
import { CodexDurableJournal } from './durable-probe-journal.js';

const connection=await isolatedTestDatabase(undefined,'synthetic-web-evidence-locks');
test('web evidence follows the run -> job order and cancellation fencing',{skip:!connection},async t=>{
  const applicationName=`synthetic-web-lock-${randomUUID()}`;
  const pool=new Pool({connectionString:connection,max:3,application_name:applicationName});
  const observer=new Pool({connectionString:connection,max:2});
  const blobs={} as PrivateBlobs; // The tested journal method never reads/writes Blob data.
  async function fixture(){
    const owner=`synthetic-owner-${randomUUID()}`,projectId=randomUUID(),runId=randomUUID(),jobId=randomUUID(),callId=randomUUID(),token=randomUUID();
    const inputHash='a'.repeat(64);
    await observer.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic web lock review','review')",[projectId,owner]);
    await observer.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,'{}','[]','[]')`,[projectId,owner,inputHash]);
    await observer.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
      VALUES($1,$2,$3,1,$4,$1,'review',$4,'running')`,[runId,owner,projectId,inputHash]);
    await observer.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,lease_token,lease_until,attempts)
      VALUES($1,$2,$3,'review','synthetic','running',$4,now()+interval '60 seconds',1)`,[jobId,owner,runId,token]);
    await observer.query(`INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status,model_id)
      VALUES($1,$2,$3,'synthetic-web-review',1,'pending_reconcile','synthetic-model')`,[callId,owner,jobId]);
    const lease:Lease={owner,jobId,runId,token,attempts:1,checkpoint:{},executionVersion:1,inputRevision:1,inputHash};
    const intent:ProviderCallIntent={owner_user_id:owner,project_id:projectId,job_id:jobId,run_id:runId,trace_id:runId,
      logical_call_id:'synthetic-web-review',call_id:callId,attempt_no:1,model_id:'synthetic-model',model_config_version:'synthetic-v1',prompt_snapshot_ref:'synthetic-prompt'};
    return {lease,intent,journal:new CodexDurableJournal({pool,blobs,lease,validateResult:()=>true})};
  }
  async function lockRun(lease:Lease){
    const holder=await observer.connect();
    await holder.query('BEGIN');
    await holder.query("SET LOCAL statement_timeout='2s'");
    await holder.query('SELECT id FROM bb_runs WHERE owner_user_id=$1 AND id=$2 FOR UPDATE',[lease.owner,lease.runId]);
    return holder;
  }
  async function waitForBlockedWrite(){
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){
      if((await observer.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0",[applicationName])).rowCount)return;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.fail('evidence transaction did not reach the held run lock');
  }
  try{
    await t.test('a live token cannot write evidence under another input or execution version',async()=>{
      const f=await fixture(),initial={...f.lease};
      for(const changed of [{inputHash:'b'.repeat(64)},{inputRevision:2},{executionVersion:2}]){
        Object.assign(f.lease,initial,changed);
        await assert.rejects(f.journal.recordWebSearchEvents(f.intent,[]),{code:'INPUT_REVISION_CONFLICT'});
        assert.equal((await observer.query('SELECT count(*)::int n FROM bb_model_web_search_evidence WHERE call_id=$1',[f.intent.call_id])).rows[0].n,0);
      }
      Object.assign(f.lease,initial);await f.journal.recordWebSearchEvents(f.intent,[]);
      assert.equal((await observer.query('SELECT count(*)::int n FROM bb_model_web_search_evidence WHERE call_id=$1',[f.intent.call_id])).rows[0].n,1);
    });
    await t.test('renewal retains access to the job while evidence waits for its run',async()=>{
      const f=await fixture(),holder=await lockRun(f.lease);
      const writing=f.journal.recordWebSearchEvents(f.intent,[]).then(()=>({error:null}),error=>({error}));
      try{
        await waitForBlockedWrite();
        // The old job -> run order blocks this renewal-like acquisition.
        await holder.query('SELECT id FROM bb_jobs WHERE id=$1 FOR UPDATE',[f.lease.jobId]);
        await holder.query("UPDATE bb_jobs SET lease_until=now()+interval '60 seconds' WHERE id=$1",[f.lease.jobId]);
        await holder.query('COMMIT');
        assert.equal((await writing).error,null);
        await f.journal.recordWebSearchEvents(f.intent,[]);
        assert.equal((await observer.query('SELECT count(*)::int n FROM bb_model_web_search_evidence WHERE call_id=$1',[f.intent.call_id])).rows[0].n,1);
      }finally{await holder.query('ROLLBACK');holder.release();await writing;}
    });
    await t.test('cancellation winning the run lock rejects late evidence',async()=>{
      const f=await fixture(),holder=await lockRun(f.lease);
      const writing=f.journal.recordWebSearchEvents(f.intent,[]).then(()=>({error:null}),error=>({error}));
      try{
        await waitForBlockedWrite();
        await holder.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[f.lease.runId]);
        await holder.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE id=$1",[f.lease.jobId]);
        await holder.query('COMMIT');
        assert.equal((await writing).error?.code,'CAPABILITY_NOT_READY');
        assert.equal((await observer.query('SELECT count(*)::int n FROM bb_model_web_search_evidence WHERE call_id=$1',[f.intent.call_id])).rows[0].n,0);
      }finally{await holder.query('ROLLBACK');holder.release();await writing;}
    });
    await t.test('project binding and expired lease still reject evidence',async()=>{
      const f=await fixture();
      await assert.rejects(f.journal.recordWebSearchEvents({...f.intent,project_id:randomUUID()},[]),{code:'CAPABILITY_NOT_READY'});
      await observer.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[f.lease.jobId]);
      await assert.rejects(f.journal.recordWebSearchEvents(f.intent,[]),{code:'CAPABILITY_NOT_READY'});
      assert.equal((await observer.query('SELECT count(*)::int n FROM bb_model_web_search_evidence WHERE call_id=$1',[f.intent.call_id])).rows[0].n,0);
    });
  }finally{await pool.end();await observer.end();}
});
