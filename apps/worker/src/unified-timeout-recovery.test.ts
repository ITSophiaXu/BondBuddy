import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { digest, uid, type PrivateBlobs } from '@bondbuddy/api/data';
import { saveSnapshotRef } from '@bondbuddy/api/observability';
import { emptyUpdateDetails } from '@bondbuddy/contracts';
import { claim, finish, pauseRun, recordPotentialCall, recoverUnifiedTimeout, repairUnifiedTimeoutRetry } from '@bondbuddy/api/queue';
import { recordModelAttemptRuntime, recordProviderCallObservation, latestProviderAttempt, READ_ONLY_MATERIAL_ADAPTER_VERSION } from '@bondbuddy/api/provider-results';
import { WorkerRuntime } from './runtime.js';
import { isolatedTestDatabase } from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'unified-timeout');
test('terminated unified timeout resumes once, preserves usage/checkpoints, bounds retries and refuses ambiguous evidence',
  {skip:!connection,timeout:60000},async()=>{
    const pool=new Pool({connectionString:connection});
    const owner=`timeout-${uid()}`, bytes=new Map<string,Buffer>();
    const blobs:PrivateBlobs={put:async(k,b)=>{bytes.set(k,b);},get:async k=>bytes.get(k)!,getIfExists:async k=>bytes.get(k)??null,
      getIfExistsBounded:async k=>bytes.get(k)??null,exists:async k=>bytes.has(k),delete:async k=>{bytes.delete(k);}};
    const app=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true});
    const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin:'http://bondbuddy.test'},payload:payload as any});
    const logical='unified-v3-read_0_10_part_0';
    type EvidenceOptions={unified?:boolean;runtime?:boolean;observation?:boolean;error?:string;observationError?:string;exited?:boolean;tools?:number;measured?:boolean;logical?:string;adapterVersion?:string};
    async function fixture(options:EvidenceOptions={}){
      const p=await send('POST','/api/v1/projects',{name:'Synthetic timeout',kind:'update',issuer_name:'合成企业',market:'sse',offering:'private',
        ...(options.unified!==false?{update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1'}}:{})});
      assert.equal(p.statusCode,201,p.body);
      const project=p.json().project_id;
      const input=await send('POST',`/api/v1/projects/${project}/input-revisions`,{draft_revision:1,material_versions:[],requirement_message_ids:[]});
      assert.equal(input.statusCode,201,input.body);
      const started=await send('POST','/api/v1/runs/execute',{execution_request_id:uid(),project_id:project,input_revision:1,input_hash:input.json().input_hash,
        task_kind:'update',input_manifest_ref:'synthetic',storage_origin:'cloud',workspace_id:'synthetic'});
      assert.equal(started.statusCode,202,started.body);
      const lease=await claim(pool,30);assert.ok(lease);assert.equal(lease.runId,started.json().run_id);
      await pool.query(`UPDATE bb_jobs SET checkpoint=checkpoint||'{"stages":{"kept":{"hash":"synthetic"}},"provider_results":{"completed_batch":"synthetic"}}'::jsonb WHERE id=$1`,[lease.jobId]);
      return timeout(lease,project,1,options);
    }
    async function timeout(lease:NonNullable<Awaited<ReturnType<typeof claim>>>,project:string,n:number,options:EvidenceOptions={}){
      const logical=options.logical??'unified-v3-read_0_10_part_0';
      const objectKey=`users/${owner}/projects/${project}/snapshots/${uid()}`;
      const content=Buffer.from('synthetic timeout prompt');await blobs.put(objectKey,content,'text/plain');
      const prompt=await saveSnapshotRef(pool,{owner,projectId:project,runId:lease.runId,kind:'model_request',version:n,objectKey,sha256:digest(content),redactionVersion:'synthetic_v1',blobs});
      const attempt=await recordPotentialCall(pool,lease,logical,n,{modelId:'synthetic',promptSnapshotId:prompt});
      if(options.runtime!==false)await recordModelAttemptRuntime(pool,lease,{owner_user_id:owner,project_id:project,run_id:lease.runId,trace_id:lease.runId,job_id:lease.jobId,
        logical_call_id:logical,attempt_no:n,call_id:attempt,model_id:'synthetic',model_config_version:'synthetic-v1',prompt_snapshot_ref:prompt},
        {adapter:'codex_exec',adapter_version:options.adapterVersion??'synthetic-v1',model_provider:'deepseek',model_config_version:'synthetic-v1',provider_request_id_status:'unknown',
          framework_thread_id:null,started_at:new Date().toISOString(),duration_ms:600000,exit_code:null,exit_signal:options.exited===false?null:'SIGTERM',finish_reason:'timeout',error_code:options.error??'MODEL_TIMEOUT',tool_attempts:options.tools??0,pricing_status:'unknown'});
      if(options.observation!==false)await recordProviderCallObservation(pool,blobs,{owner_user_id:owner,project_id:project,run_id:lease.runId,trace_id:lease.runId,job_id:lease.jobId,
        logical_call_id:logical,attempt_no:n,call_id:attempt,model_id:'synthetic',model_config_version:'synthetic-v1',prompt_snapshot_ref:prompt,
        provider_request_id:null,finish_reason:'timeout',outcome:'pending_reconcile',usage:options.measured?{status:'measured',input_tokens:10,output_tokens:5,cached_input_tokens:0,reasoning_tokens:0,total_tokens:15}:{status:'unknown',input_tokens:null,output_tokens:null,cached_input_tokens:null,reasoning_tokens:null,total_tokens:null},
        error_code:options.observationError??'MODEL_TIMEOUT',result_ref:null,result_sha256:null,result_schema_version:null,result_byte_size:null},()=>true,{lease,source:'provider'});
      else await pauseRun(pool,lease,'provider_reconcile','provider_result_pending');
      return {lease,project,attempt,recover:()=>recoverUnifiedTimeout(pool,owner,lease.runId,lease.jobId)};
    }
    try{
      const f=await fixture();
      assert.equal(await recoverUnifiedTimeout(pool,'other',f.lease.runId,f.lease.jobId),false);
      const before=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[f.lease.jobId])).rows[0].checkpoint;
      await pool.query(`ALTER TABLE bb_outbox ADD CONSTRAINT timeout_rollback CHECK (aggregate_id <> '${f.lease.runId}') NOT VALID`);
      await assert.rejects(f.recover,/timeout_rollback/);
      assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1',[f.lease.runId])).rows[0].state,'paused');
      await pool.query('ALTER TABLE bb_outbox DROP CONSTRAINT timeout_rollback');
      assert.deepEqual((await Promise.all([f.recover(),f.recover()])).sort(),[false,true]);
      const after=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[f.lease.jobId])).rows[0].checkpoint;
      assert.deepEqual(after.stages,before.stages);assert.deepEqual(after.provider_results,before.provider_results);
      const usage=(await pool.query('SELECT usage_status,input_tokens,output_tokens FROM bb_call_usage WHERE attempt_id=$1',[f.attempt])).rows[0];
      assert.deepEqual(usage,{usage_status:'unknown',input_tokens:null,output_tokens:null});
      let next=await claim(pool,30);assert.ok(next);assert.equal(next.runId,f.lease.runId);
      assert.equal((await latestProviderAttempt(pool,next,logical))?.operator_retry,true);
      await timeout(next,f.project,2);
      const runtime=new WorkerRuntime({pool,blobs});await runtime.sweep();
      next=await claim(pool,30);assert.ok(next);assert.equal(next.runId,f.lease.runId);
      const third=await timeout(next,f.project,3);assert.equal(await third.recover(),true);
      assert.deepEqual((await pool.query('SELECT state,stage FROM bb_runs WHERE id=$1',[f.lease.runId])).rows[0],{state:'failed',stage:'failed'});
      assert.equal(await third.recover(),false);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[f.lease.jobId])).rows[0].n,3);
      for(const options of [
        {runtime:false},{error:'MODEL_CANCELLED'},{exited:false},{tools:1},
        {observationError:'MODEL_STREAM_BROKEN'},{observation:false},{measured:true},
        {logical:'unified-v4-update_0',tools:2},
        {logical:'unified-v4-update_0',tools:2,adapterVersion:READ_ONLY_MATERIAL_ADAPTER_VERSION,exited:false},
        {logical:'unified-v4-update_0',tools:2,adapterVersion:READ_ONLY_MATERIAL_ADAPTER_VERSION,error:'MODEL_TOOL_ATTEMPT_BLOCKED'},
      ]){
        const refused=await fixture(options);assert.equal(await refused.recover(),false,JSON.stringify(options));
      }
      const legacy=await fixture({unified:false});assert.equal(await legacy.recover(),false);
      const readonly=await fixture({logical:'unified-v4-update_0',tools:2,adapterVersion:READ_ONLY_MATERIAL_ADAPTER_VERSION});
      assert.equal(await readonly.recover(),true);
      const readonlyLease=await claim(pool,30);assert.equal(readonlyLease?.runId,readonly.lease.runId);
      assert.equal((await latestProviderAttempt(pool,readonlyLease!,'unified-v4-update_0'))?.operator_retry,true);
      assert.equal((await pool.query('SELECT usage_status FROM bb_call_usage WHERE attempt_id=$1',[readonly.attempt])).rows[0].usage_status,'unknown');
      await finish(pool,readonlyLease!,'failed',{errorCode:'MODEL_TIMEOUT',failedStage:'model_generation'});
      const capped=await fixture();
      const history=Object.fromEntries(Array.from({length:6},(_,i)=>[`synthetic-${i}`,{reason_code:'terminated_timeout_auto_retry',logical_call_id:`unified-v3-update_${i}`}]));
      await pool.query("UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{operator_reconciliations}',$2::jsonb) WHERE id=$1",[capped.lease.jobId,JSON.stringify(history)]);
      assert.equal(await capped.recover(),true);
      assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1',[capped.lease.runId])).rows[0].state,'failed');
      const cancelled=await fixture();await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[cancelled.lease.runId]);assert.equal(await cancelled.recover(),false);

      // The old journal could drop the retry flag and fail before attempt 3 was sent.
      // Only this evidenced software failure may be explicitly repaired, once.
      const interrupted=await fixture();assert.equal(await interrupted.recover(),true);
      let repairLease=await claim(pool,30);assert.ok(repairLease);assert.equal(repairLease.runId,interrupted.lease.runId);
      const second=await timeout(repairLease,interrupted.project,2);assert.equal(await second.recover(),true);
      repairLease=await claim(pool,30);assert.ok(repairLease);assert.equal(repairLease.runId,interrupted.lease.runId);
      await finish(pool,repairLease,'failed',{errorCode:'MODEL_OUTPUT_SCHEMA_INVALID',failedStage:'model_generation'});
      const repair=()=>repairUnifiedTimeoutRetry(pool,{runId:interrupted.lease.runId,attemptId:second.attempt,actor:'synthetic-repair'});
      await assert.rejects(repairUnifiedTimeoutRetry(pool,{runId:cancelled.lease.runId,attemptId:second.attempt,actor:'synthetic-repair'}),/does not match/);
      await assert.rejects(repairUnifiedTimeoutRetry(pool,{runId:interrupted.lease.runId,attemptId:interrupted.attempt,actor:'synthetic-repair'}),/does not match/);
      await assert.rejects(repairUnifiedTimeoutRetry(pool,{runId:f.lease.runId,attemptId:third.attempt,actor:'synthetic-repair'}),/does not match/);
      const saved=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[repairLease.jobId])).rows[0].checkpoint;
      await pool.query(`ALTER TABLE bb_outbox ADD CONSTRAINT repair_rollback CHECK (aggregate_id <> '${repairLease.runId}') NOT VALID`);
      await assert.rejects(repair,/repair_rollback/);
      assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1',[repairLease.runId])).rows[0].state,'failed');
      await pool.query('ALTER TABLE bb_outbox DROP CONSTRAINT repair_rollback');
      assert.deepEqual((await Promise.all([repair(),repair()])).map(x=>x.idempotent).sort(),[false,true]);
      const repaired=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[repairLease.jobId])).rows[0].checkpoint;
      assert.deepEqual(repaired.stages,saved.stages);assert.deepEqual(repaired.provider_results,saved.provider_results);
      assert.deepEqual(repaired.operator_reconciliations,saved.operator_reconciliations,'repair does not reset the retry budget');
      assert.equal((await pool.query("SELECT count(*)::int n FROM bb_run_events WHERE run_id=$1 AND payload->>'reason'='provider_timeout_retry_repaired'",[repairLease.runId])).rows[0].n,1);
      assert.equal((await pool.query("SELECT count(*)::int n FROM bb_run_events WHERE run_id=$1 AND payload->>'error_code'='MODEL_OUTPUT_SCHEMA_INVALID'",[repairLease.runId])).rows[0].n,1,'original failure stays in history');
      assert.equal((await pool.query("SELECT count(*)::int n FROM bb_call_usage WHERE job_id=$1 AND usage_status='unknown'",[repairLease.jobId])).rows[0].n,2);
      assert.equal((await claim(pool,30))?.runId,repairLease.runId);
    }finally{await app.close();await pool.end();}
  });
