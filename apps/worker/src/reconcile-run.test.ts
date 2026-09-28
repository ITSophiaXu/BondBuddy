import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { azureBlobs, uid } from '@bondbuddy/api/data';
import { claim, pauseRun, recordPotentialCall } from '@bondbuddy/api/queue';
import { latestProviderAttempt } from '@bondbuddy/api/provider-results';
import { runReconcileCommand } from './reconcile-run.js';
import { isolatedTestDatabase } from './test-database.js';

const connection = await isolatedTestDatabase('BB_TEST_RECONCILE_DATABASE_URL');

test('private reconciliation lists, retries and fails exact owned attempts with one audit/outbox transition',
  {skip:!connection},async()=>{
    const pool=new Pool({connectionString:connection});
    const owner=`reconcile-owner-${uid()}`;
    const blobs=azureBlobs('UseDevelopmentStorage=true','reconcile-test');
    const app=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true});
    const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin:'http://bondbuddy.test'},payload:payload as any});
    async function fixture(label:string){
      const project=await send('POST','/api/v1/projects',{name:`Synthetic ${label}`,kind:'update',issuer_name:null,market:null,offering:null});
      assert.equal(project.statusCode,201,project.body);
      const projectId=project.json().project_id;
      const input=await send('POST',`/api/v1/projects/${projectId}/input-revisions`,{draft_revision:1,material_versions:[],requirement_message_ids:[]});
      assert.equal(input.statusCode,201,input.body);
      const submitted=await send('POST','/api/v1/runs/execute',{execution_request_id:`synthetic-${uid()}`,project_id:projectId,input_revision:1,
        input_hash:input.json().input_hash,task_kind:'update',input_manifest_ref:'synthetic-manifest',storage_origin:'cloud',workspace_id:'synthetic'});
      assert.equal(submitted.statusCode,202,submitted.body);
      return submitted.json().run_id as string;
    }
    async function pending(label:string){
      const runId=await fixture(label);
      const lease=await claim(pool,30);assert.ok(lease);assert.equal(lease.runId,runId);
      const attemptId=await recordPotentialCall(pool,lease,'synthetic-call',1);
      await pauseRun(pool,lease,'provider_reconcile','provider_result_pending');
      return {runId,attemptId};
    }
    const actor='synthetic-maintainer';
    const resolve=(runId:string,attemptId:string,decision:'retry_unknown_usage'|'fail_run',reason='supplier_history_unavailable')=>
      runReconcileCommand(pool,['resolve',runId,attemptId,decision,reason],actor);
    try{
      const retry=await pending('retry');
      await pool.query(`INSERT INTO bb_model_call_attempt_runtime
        (id,owner_user_id,project_id,job_id,run_id,trace_id,attempt_id,logical_call_id,attempt_no,
         adapter,adapter_version,model_provider,model_config_version,provider_request_id_status,
         started_at,duration_ms,error_code,tool_attempts,pricing_status)
        SELECT $2,r.owner_user_id,r.project_id,j.id,r.id,r.id,a.id,a.logical_call_id,a.attempt_no,
          'codex_exec','synthetic-v1','deepseek','synthetic-v1','unknown',now(),0,'MODEL_TIMEOUT',0,'unknown'
        FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id JOIN bb_model_call_attempts a ON a.job_id=j.id
        WHERE r.id=$1 AND a.id=$3`,[retry.runId,uid(),retry.attemptId]);
      const list=await runReconcileCommand(pool,['list'],actor) as any[];
      assert.equal(list.length,1);
      assert.equal(list[0].run_id,retry.runId);
      assert.equal(list[0].owner,owner);
      assert.equal(list[0].channel,'production');
      assert.equal(list[0].attempt_id,retry.attemptId);
      assert.equal(list[0].usage_status,'unknown');
      assert.equal(list[0].failure_code,'MODEL_TIMEOUT');
      assert.ok(list[0].started_at);
      const foreign=await pending('foreign');
      await assert.rejects(resolve(foreign.runId,retry.attemptId,'fail_run'),/not found|does not exist/i);
      await assert.rejects(resolve(foreign.runId,retry.attemptId,'retry_unknown_usage'),/not found|does not exist/i);
      const before=(await pool.query('SELECT count(*)::int n FROM bb_outbox WHERE aggregate_id=$1',[retry.runId])).rows[0].n;
      await pool.query(`ALTER TABLE bb_outbox ADD CONSTRAINT bb_reconcile_synthetic_failure CHECK (aggregate_id <> '${retry.runId}') NOT VALID`);
      await assert.rejects(resolve(retry.runId,retry.attemptId,'retry_unknown_usage'),/bb_reconcile_synthetic_failure/);
      assert.deepEqual((await pool.query('SELECT r.state,a.status FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id JOIN bb_model_call_attempts a ON a.job_id=j.id WHERE r.id=$1 AND a.id=$2',[retry.runId,retry.attemptId])).rows[0],
        {state:'paused',status:'pending_reconcile'});
      await pool.query('ALTER TABLE bb_outbox DROP CONSTRAINT bb_reconcile_synthetic_failure');
      assert.deepEqual(await resolve(retry.runId,retry.attemptId,'retry_unknown_usage'),
        {run_id:retry.runId,attempt_id:retry.attemptId,decision:'retry_unknown_usage',idempotent:false});
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_outbox WHERE aggregate_id=$1',[retry.runId])).rows[0].n,before+1);
      assert.deepEqual(await resolve(retry.runId,retry.attemptId,'retry_unknown_usage'),
        {run_id:retry.runId,attempt_id:retry.attemptId,decision:'retry_unknown_usage',idempotent:true});
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_outbox WHERE aggregate_id=$1',[retry.runId])).rows[0].n,before+1);
      await assert.rejects(resolve(retry.runId,retry.attemptId,'fail_run'),/another operator decision/);
      const usage=(await pool.query('SELECT call_status,usage_status,input_tokens,output_tokens FROM bb_call_usage WHERE attempt_id=$1',[retry.attemptId])).rows[0];
      assert.deepEqual(usage,{call_status:'failed',usage_status:'unknown',input_tokens:null,output_tokens:null});
      const audit=(await pool.query("SELECT payload FROM bb_run_events WHERE run_id=$1 AND payload->>'reason'='provider_operator_retry_unknown_usage'",[retry.runId])).rows[0].payload;
      assert.deepEqual([audit.actor,audit.reason_code,audit.attempt_id],[actor,'supplier_history_unavailable',retry.attemptId]);
      assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_id=$1 AND payload->>'attempt_id'=$2",[retry.runId,retry.attemptId])).rows[0].n,1);
      assert.equal((await runReconcileCommand(pool,['list'],actor) as any[]).length,1);
      const resumed=await claim(pool,30);assert.ok(resumed);assert.equal(resumed.runId,retry.runId);
      const prior=await latestProviderAttempt(pool,resumed,'synthetic-call');
      assert.equal(prior?.operator_retry,true);
      assert.equal(prior?.status,'failed');
      await recordPotentialCall(pool,resumed,'synthetic-call',2);
      await pauseRun(pool,resumed,'provider_reconcile','provider_result_pending');

      const pendingUsage=await pending('usage-pending');
      await pool.query(`INSERT INTO bb_usage_observations(id,owner_user_id,attempt_id,source,source_event_id,usage_status)
        VALUES($1,$2,$3,'framework',$4,'pending')`,[uid(),owner,pendingUsage.attemptId,uid()]);
      await assert.rejects(resolve(pendingUsage.runId,pendingUsage.attemptId,'retry_unknown_usage'),
        /Existing result or non-unknown usage requires provider reconciliation/);
      assert.equal((await pool.query('SELECT usage_status FROM bb_call_usage WHERE attempt_id=$1',[pendingUsage.attemptId])).rows[0].usage_status,'pending');

      const failed=await pending('fail');
      const count=(await pool.query('SELECT count(*)::int n FROM bb_outbox WHERE aggregate_id=$1',[failed.runId])).rows[0].n;
      assert.deepEqual(await resolve(failed.runId,failed.attemptId,'fail_run'),
        {run_id:failed.runId,attempt_id:failed.attemptId,decision:'fail_run',idempotent:false});
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_outbox WHERE aggregate_id=$1',[failed.runId])).rows[0].n,count+1);
      assert.equal((await resolve(failed.runId,failed.attemptId,'fail_run') as any).idempotent,true);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_outbox WHERE aggregate_id=$1',[failed.runId])).rows[0].n,count+1);
      const terminal=(await pool.query('SELECT r.state,j.state AS job_state,j.error_code,e.payload FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id JOIN bb_run_events e ON e.run_id=r.id AND e.seq=r.event_cursor WHERE r.id=$1',[failed.runId])).rows[0];
      assert.deepEqual([terminal.state,terminal.job_state,terminal.error_code,terminal.payload.error_code,terminal.payload.actor],
        ['failed','failed','DATA_UNAVAILABLE','DATA_UNAVAILABLE',actor]);
      const active=await fixture('active');
      const lease=await claim(pool,30);assert.ok(lease);assert.equal(lease.runId,active);
      const call=await recordPotentialCall(pool,lease,'synthetic-call',1);
      await assert.rejects(resolve(active,call,'fail_run'),/not awaiting this provider call/);
    }finally{await app.close();await pool.end();}
  });
