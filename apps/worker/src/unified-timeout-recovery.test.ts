import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { digest, uid, type PrivateBlobs } from '@bondbuddy/api/data';
import { saveSnapshotRef } from '@bondbuddy/api/observability';
import { emptyUpdateDetails } from '@bondbuddy/contracts';
import { claim, pauseRun, recordPotentialCall, recoverUnifiedTimeout } from '@bondbuddy/api/queue';
import { recordModelAttemptRuntime, recordProviderCallObservation, latestProviderAttempt } from '@bondbuddy/api/provider-results';
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
    const logical='unified-v3-read_0_10';
    type EvidenceOptions={unified?:boolean;runtime?:boolean;observation?:boolean;error?:string;observationError?:string;exited?:boolean;tools?:number;measured?:boolean};
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
      const objectKey=`users/${owner}/projects/${project}/snapshots/${uid()}`;
      const content=Buffer.from('synthetic timeout prompt');await blobs.put(objectKey,content,'text/plain');
      const prompt=await saveSnapshotRef(pool,{owner,projectId:project,runId:lease.runId,kind:'model_request',version:n,objectKey,sha256:digest(content),redactionVersion:'synthetic_v1',blobs});
      const attempt=await recordPotentialCall(pool,lease,logical,n,{modelId:'synthetic',promptSnapshotId:prompt});
      if(options.runtime!==false)await recordModelAttemptRuntime(pool,lease,{owner_user_id:owner,project_id:project,run_id:lease.runId,trace_id:lease.runId,job_id:lease.jobId,
        logical_call_id:logical,attempt_no:n,call_id:attempt,model_id:'synthetic',model_config_version:'synthetic-v1',prompt_snapshot_ref:prompt},
        {adapter:'codex_exec',adapter_version:'synthetic-v1',model_provider:'deepseek',model_config_version:'synthetic-v1',provider_request_id_status:'unknown',
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
      ]){
        const refused=await fixture(options);assert.equal(await refused.recover(),false,JSON.stringify(options));
      }
      const legacy=await fixture({unified:false});assert.equal(await legacy.recover(),false);
      const capped=await fixture();
      const history=Object.fromEntries(Array.from({length:6},(_,i)=>[`synthetic-${i}`,{reason_code:'terminated_timeout_auto_retry',logical_call_id:`unified-v3-update_${i}`}]));
      await pool.query("UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{operator_reconciliations}',$2::jsonb) WHERE id=$1",[capped.lease.jobId,JSON.stringify(history)]);
      assert.equal(await capped.recover(),true);
      assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1',[capped.lease.runId])).rows[0].state,'failed');
      const cancelled=await fixture();await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[cancelled.lease.runId]);assert.equal(await cancelled.recover(),false);
    }finally{await app.close();await pool.end();}
  });
