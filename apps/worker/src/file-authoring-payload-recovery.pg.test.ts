import { inspectAndIsolateBillingScope } from '../../api/dist/billing-safety.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { digest,uid,transaction,type PrivateBlobs } from '@bondbuddy/api/data';
import { grantCredits,publishPrices,creditBalanceExact } from '../../api/dist/billing.js';
import { saveSnapshotRef } from '@bondbuddy/api/observability';
import { uploadSyntheticReference } from '@bondbuddy/api/test-authoring-source';
import { emptyUpdateDetails,INITIAL_FIXED_PRICES, type FileAuthoringCaptureFailure } from '@bondbuddy/contracts';
import { action,claim,checkpointStage,recordPotentialCall,recordFileAuthoringCaptureOutcome,recoverFileAuthoringPayload,fileAuthoringPayloadRecoveryCandidates,resumePausedRun,pausedRuns } from '@bondbuddy/api/queue';
import { recordModelAttemptRuntime,recordProviderCallObservation,latestProviderAttempt,providerResultObjectKey,type ProviderCallObservation } from '@bondbuddy/api/provider-results';
import { WorkerRuntime } from './runtime.js';
import { isolatedTestDatabase } from './test-database.js';

const configured=!!process.env.BB_TEST_DATABASE_URL;
for(const [localFailure,localPrefix] of [['MODEL_OUTPUT_TOO_LARGE','file_authoring_output_limit'],['MODEL_TIMEOUT','file_authoring_timeout']] as const)
test(`${localFailure} recovery preserves work, unknown usage and the original reservation while bounding retries`,
  {skip:!configured,timeout:600000},async()=>{
  const connection=await isolatedTestDatabase(undefined,`file-authoring-${localFailure}`);
  const pool=new Pool({connectionString:connection}),owner=`payload-${uid()}`,objects=new Map<string,Buffer>();
  const blobs:PrivateBlobs={put:async(k,b)=>{objects.set(k,b);},get:async k=>objects.get(k)!,getIfExists:async k=>objects.get(k)??null,
    getIfExistsBounded:async k=>objects.get(k)??null,exists:async k=>objects.has(k),delete:async k=>{objects.delete(k);}};
  const app=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true,historicalBillingFixture:true});
  const paidApp=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true,historicalBillingFixture:true,enablePaidAuthoring:true});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin:'http://bondbuddy.test'},payload:payload as any});
  type Options={paid?:boolean;runtime?:boolean;snapshot?:'none'|'bad';error?:string;observationError?:string;
    observationOutcome?:'failed'|'pending_reconcile';exit?:boolean;logical?:string;adapter?:string;conflict?:boolean;result?:boolean;
    capture?:'prepared'|'saved'|'write_failed'|FileAuthoringCaptureFailure};
  type Lease=NonNullable<Awaited<ReturnType<typeof claim>>>;
  async function observe(lease:Lease,project:string,inputHash:string,n:number,options:Options={}){
    const logical=options.logical??'file-authoring-v1',content=Buffer.from('synthetic file authoring prompt');
    const error=options.error??'MODEL_PROVIDER_PAYLOAD_TOO_LARGE',outputLimit=['MODEL_OUTPUT_TOO_LARGE','MODEL_TIMEOUT'].includes(error);
    const objectKey=`users/${owner}/projects/${project}/snapshots/${uid()}`;await blobs.put(objectKey,content,'text/plain');
    const prompt=await saveSnapshotRef(pool,{owner,projectId:project,runId:lease.runId,kind:'model_request',version:n,objectKey,sha256:digest(content),redactionVersion:'synthetic_v1',blobs});
    if(options.snapshot==='none'&&logical==='file-authoring-v1'&&n===1)
      await checkpointStage(pool,lease,'file_authoring_v1_prompt',{snapshot_id:prompt},false);
    const attempt=await recordPotentialCall(pool,lease,logical,n,{modelId:'synthetic',promptSnapshotId:prompt,fileAuthoringRecoveryCapture:!!options.capture});
    if(options.capture){
      const marker=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[lease.jobId])).rows[0].checkpoint.file_authoring_recovery_captures[attempt];
      assert.equal(marker.state,'prepared');assert.equal(marker.attempt_id,attempt);assert.equal(marker.input_hash,inputHash);
      assert.equal(marker.owner_user_id,owner);assert.equal(marker.run_id,lease.runId);assert.equal(marker.project_id,project);assert.equal(marker.input_revision,1);
      assert.deepEqual((lease.checkpoint.file_authoring_recovery_captures as any)[attempt],marker);
      await assert.rejects(recordFileAuthoringCaptureOutcome(pool,{...lease,owner:'foreign'},attempt,logical,{state:'failed',failure_code:'storage_failed'}));
      await assert.rejects(recordFileAuthoringCaptureOutcome(pool,{...lease,token:'stale'},attempt,logical,{state:'failed',failure_code:'storage_failed'}));
      await assert.rejects(recordFileAuthoringCaptureOutcome(pool,lease,'foreign-attempt',logical,{state:'failed',failure_code:'storage_failed'}));
      await assert.rejects(recordFileAuthoringCaptureOutcome(pool,lease,attempt,logical,{state:'saved',failure_code:null}),/complete matching recovery checkpoint/);
    }
    const intent={owner_user_id:owner,project_id:project,run_id:lease.runId,trace_id:lease.runId,job_id:lease.jobId,
      logical_call_id:logical,attempt_no:n,call_id:attempt,model_id:'synthetic',model_config_version:'synthetic-v1',prompt_snapshot_ref:prompt};
    if(options.runtime!==false)await recordModelAttemptRuntime(pool,lease,intent,{adapter:'codex_exec',adapter_version:options.adapter??'codex-file-authoring-2',
      model_provider:'deepseek',model_config_version:'synthetic-v1',provider_request_id_status:'unknown',framework_thread_id:null,
      started_at:new Date().toISOString(),duration_ms:1000,exit_code:options.exit===false||outputLimit?null:1,
      exit_signal:options.exit===false||!outputLimit?null:error==='MODEL_TIMEOUT'?'SIGTERM':'SIGKILL',finish_reason:error==='MODEL_TIMEOUT'?'timeout':'turn_failed',
      error_code:error,tool_attempts:3,pricing_status:'unknown'});
    if(options.snapshot!=='none'){
      const bytes=Buffer.from(JSON.stringify({input_hash:inputHash})),sha256=digest(bytes),path='input.json';
      const key=`owners/${owner}/projects/${project}/runs/${lease.runId}/file-authoring/recovery/${attempt}/${sha256}/${path}`;
      await blobs.put(key,bytes,'application/json');
      await checkpointStage(pool,lease,'file_authoring_recovery',{version:'file-authoring-recovery-v1',input_hash:options.snapshot==='bad'?'bad':inputHash,
        attempt_id:attempt,logical_call_id:logical,files:[{path,key,sha256,byte_size:bytes.length}]},false);
    }
    if(options.capture&&options.capture!=='prepared'){
      if(options.capture==='write_failed'){
        await pool.query(`ALTER TABLE bb_jobs ADD CONSTRAINT capture_outcome_failure CHECK (id <> '${lease.jobId}' OR checkpoint->'file_authoring_recovery_captures'->'${attempt}'->>'state' <> 'failed') NOT VALID`);
        try{await assert.rejects(recordFileAuthoringCaptureOutcome(pool,lease,attempt,logical,{state:'failed',failure_code:'storage_failed'}),/capture_outcome_failure/);}
        finally{await pool.query('ALTER TABLE bb_jobs DROP CONSTRAINT capture_outcome_failure');}
      }else await recordFileAuthoringCaptureOutcome(pool,lease,attempt,logical,options.capture==='saved'?{state:'saved',failure_code:null}:{state:'failed',failure_code:options.capture});
    }
    const observation:ProviderCallObservation={...intent,provider_request_id:null,finish_reason:error==='MODEL_TIMEOUT'?'timeout':'turn_failed',
      outcome:options.observationOutcome??(outputLimit?'pending_reconcile':'failed'),
      usage:{status:'unknown',input_tokens:null,output_tokens:null,cached_input_tokens:null,reasoning_tokens:null,total_tokens:null},
      error_code:options.observationError??error,result_ref:null,result_sha256:null,result_schema_version:null,result_byte_size:null};
    if(options.result){
      const result=Buffer.from(JSON.stringify({retained:'synthetic'})),key=providerResultObjectKey(observation,digest(result));
      await blobs.put(key,result,'application/json');
      Object.assign(observation,{outcome:'pending_reconcile',result_ref:key,result_sha256:digest(result),result_schema_version:'synthetic-v1',result_byte_size:result.length});
    }
    await recordProviderCallObservation(pool,blobs,observation,()=>true,{lease,source:'provider'});
    if(options.conflict)await recordProviderCallObservation(pool,blobs,{...observation,outcome:'pending_reconcile',error_code:'MODEL_STREAM_BROKEN'},()=>true,{source:'provider'});
    return {lease,project,inputHash,attempt,logical,recover:()=>recoverFileAuthoringPayload(pool,owner,lease.runId,lease.jobId)};
  }
  async function prepareFixture(options:Options={}){
    const p=await send('POST','/api/v1/projects',{name:'Synthetic payload recovery',kind:'update',issuer_name:'合成企业',market:'sse',offering:'private',
      update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1'}});assert.equal(p.statusCode,201,p.body);
    const project=p.json().project_id,materials=await uploadSyntheticReference(app,project);
    const input=await send('POST',`/api/v1/projects/${project}/input-revisions`,materials);assert.equal(input.statusCode,201,input.body);
    let quote:string|undefined;
    if(options.paid){const q=await paidApp.inject({method:'POST',url:`/api/v1/projects/${project}/credit-quote`,headers:{origin:'http://bondbuddy.test'},
      payload:{input_revision:1,input_hash:input.json().input_hash}});assert.equal(q.statusCode,200,q.body);quote=q.json().quote.quote_id;}
    const request={execution_request_id:uid(),project_id:project,input_revision:1,input_hash:input.json().input_hash,...(quote?{quote_id:quote}:{}),
      task_kind:'update',input_manifest_ref:'synthetic',storage_origin:'cloud',workspace_id:'synthetic'};
    const started=options.paid?await paidApp.inject({method:'POST',url:'/api/v1/runs/execute',headers:{origin:'http://bondbuddy.test'},payload:request}):await send('POST','/api/v1/runs/execute',request);
    assert.equal(started.statusCode,202,started.body);const lease=await claim(pool,300);assert.ok(lease);assert.equal(lease.runId,started.json().run_id);
    await checkpointStage(pool,lease,'kept',{hash:'synthetic'},false);
    return {lease,project,inputHash:input.json().input_hash as string};
  }
  async function fixture(options:Options={}){
    const prepared=await prepareFixture(options);
    return observe(prepared.lease,prepared.project,prepared.inputHash,1,options);
  }
  const row=async(run:string)=>(await pool.query('SELECT state,stage FROM bb_runs WHERE id=$1',[run])).rows[0];
  const end=async(run:string)=>{await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[run]);};
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'payload_'+uid().slice(0,8)]);
    const f=await fixture({capture:'saved'});
    assert.deepEqual(await row(f.lease.runId),{state:'paused',stage:'provider_reconcile'});
    assert.equal((await pool.query('SELECT payload FROM bb_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1',[f.lease.runId])).rows[0].payload.reason,'file_authoring_payload_recovery_pending');
    assert.equal(await recoverFileAuthoringPayload(pool,'other',f.lease.runId,f.lease.jobId),false);
    const before=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[f.lease.jobId])).rows[0].checkpoint;
    await pool.query(`ALTER TABLE bb_outbox ADD CONSTRAINT payload_recovery_rollback CHECK (aggregate_id <> '${f.lease.runId}') NOT VALID`);
    await assert.rejects(f.recover,/payload_recovery_rollback/);assert.equal((await row(f.lease.runId)).state,'paused');
    await pool.query('ALTER TABLE bb_outbox DROP CONSTRAINT payload_recovery_rollback');
    assert.deepEqual((await Promise.all([f.recover(),f.recover()])).sort(),[false,true]);
    const checkpoint=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[f.lease.jobId])).rows[0].checkpoint;
    assert.deepEqual(checkpoint.stages,before.stages);assert.equal(checkpoint.operator_reconciliations[f.attempt].decision,'retry_unknown_usage');
    assert.deepEqual((await pool.query('SELECT usage_status,input_tokens,output_tokens FROM bb_call_usage WHERE attempt_id=$1',[f.attempt])).rows[0],{usage_status:'unknown',input_tokens:null,output_tokens:null});
    let next=await claim(pool,30);assert.ok(next);assert.equal(next.runId,f.lease.runId);assert.equal((await latestProviderAttempt(pool,next,f.logical))?.operator_retry,true);
    await observe(next,f.project,f.inputHash,2,{error:localFailure,capture:'saved'});await new WorkerRuntime({pool,blobs}).sweep();
    next=await claim(pool,30);assert.ok(next);assert.equal(next.runId,f.lease.runId);
    const third=await observe(next,f.project,f.inputHash,3,{capture:'saved'});assert.equal(await third.recover(),true);
    assert.equal((await row(f.lease.runId)).state,'failed');assert.equal(await third.recover(),false);
    assert.equal((await pool.query('SELECT payload FROM bb_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1',[f.lease.runId])).rows[0].payload.reason,'file_authoring_payload_retries_exhausted');
    for(const options of [{runtime:false},{error:'MODEL_TURN_FAILED'},{exit:false},{observationError:'MODEL_STREAM_BROKEN'},{conflict:true},
      {logical:'review-v1'},{adapter:'codex-file-authoring-1'},{error:'MODEL_PROVIDER_REQUEST_REJECTED'},
      {error:localFailure,runtime:false},{error:localFailure,exit:false},
      {error:localFailure,observationOutcome:'failed'},{error:localFailure,observationError:'MODEL_STREAM_BROKEN'},
      {error:localFailure,conflict:true},{error:localFailure,result:true},
      {error:localFailure,logical:'review-v1'},{error:localFailure,adapter:'codex-file-authoring-1'}] satisfies Options[]){
      const refused=await fixture(options);assert.equal(await refused.recover(),false,JSON.stringify(options));await end(refused.lease.runId);
    }
    for(const snapshot of ['none','bad'] as const){
      const unavailable=await fixture({snapshot});assert.equal(await unavailable.recover(),true);assert.equal((await row(unavailable.lease.runId)).state,'failed');
      assert.equal((await pool.query('SELECT payload FROM bb_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1',[unavailable.lease.runId])).rows[0].payload.reason,'file_authoring_payload_recovery_unavailable');
    }
    for(const flag of ['user_pause_requested','credit_pause_requested']){
      const paused=await fixture({error:localFailure});
      if(flag==='user_pause_requested'){
        assert.equal((await action(pool,owner,paused.lease.runId,'pause')).state,'paused');
        assert.equal((await pool.query('SELECT user_pause_requested FROM bb_jobs WHERE id=$1',[paused.lease.jobId])).rows[0].user_pause_requested,true,
          'a user pause racing the supplier pause must persist the user intent');
        assert.deepEqual(await row(paused.lease.runId),{state:'paused',stage:'provider_reconcile'});
      }else await pool.query('UPDATE bb_jobs SET credit_pause_requested=true WHERE id=$1',[paused.lease.jobId]);
      assert.equal(await paused.recover(),true);
      assert.deepEqual(await row(paused.lease.runId),{state:'paused',stage:flag==='user_pause_requested'?'user_paused':'credits_exhausted'});
      assert.equal(await claim(pool,30),null,'resolving the supplier rejection does not start a user/credit-paused task');
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[paused.lease.jobId])).rows[0].n,1);
      if(flag==='user_pause_requested'){
        assert.equal((await action(pool,owner,paused.lease.runId,'resume')).state,'queued');
        assert.equal((await claim(pool,30))?.runId,paused.lease.runId);
      }else{
        assert.equal(await resumePausedRun(pool,owner,paused.lease.runId,'credits_recharged'),false,'no credits yet');
        const captureCredit=await fixture({error:'MODEL_PROVIDER_PAYLOAD_TOO_LARGE',snapshot:'none',capture:'storage_failed'});
        await pool.query('UPDATE bb_jobs SET credit_pause_requested=true WHERE id=$1',[captureCredit.lease.jobId]);
        assert.equal(await resumePausedRun(pool,owner,captureCredit.lease.runId,'credits_recharged'),false);
        await assert.rejects(action(pool,owner,captureCredit.lease.runId,'resume'),error=>(error as {code:string}).code==='CREDITS_INSUFFICIENT');
        assert.equal((await pausedRuns(pool,'credits_exhausted',100)).some(x=>x.job_id===captureCredit.lease.jobId),false);
        await transaction(pool,c=>grantCredits(c,{owner,source:'existing_grant',key:uid(),points:1,expiresAt:null,actor:'synthetic',reason:'Synthetic recharge'}));
        assert.equal((await pausedRuns(pool,'credits_exhausted',100)).some(x=>x.job_id===captureCredit.lease.jobId),true);
        assert.equal(await resumePausedRun(pool,owner,captureCredit.lease.runId,'credits_recharged'),true);
        assert.deepEqual(await row(captureCredit.lease.runId),{state:'paused',stage:'provider_reconcile'});
        assert.equal(await claim(pool,30),null,'recharge does not authorize restarting after capture failure');
        await end(captureCredit.lease.runId);
        assert.equal(await resumePausedRun(pool,owner,paused.lease.runId,'credits_recharged'),true);
        assert.equal((await claim(pool,30))?.runId,paused.lease.runId);
      }
      await end(paused.lease.runId);
    }
    const both=await fixture({error:localFailure});await pool.query('UPDATE bb_jobs SET user_pause_requested=true,credit_pause_requested=true WHERE id=$1',[both.lease.jobId]);
    assert.equal(await both.recover(),true);assert.deepEqual(await row(both.lease.runId),{state:'paused',stage:'user_paused'});
    assert.equal(await resumePausedRun(pool,owner,both.lease.runId,'credits_recharged'),false,'recharge cannot override the user pause');await end(both.lease.runId);
    const cancelled=await fixture({error:localFailure});await action(pool,owner,cancelled.lease.runId,'cancel');assert.equal(await cancelled.recover(),false);
    const total=await fixture({error:localFailure,logical:'file-authoring-size-repair-2'});
    const history=Object.fromEntries(Array.from({length:6},(_,n)=>[`prior-${n}`,{
      reason_code:['file_authoring_payload_auto_retry','file_authoring_output_limit_auto_retry','file_authoring_timeout_auto_retry','file_authoring_manual_restart'][n%4],
      logical_call_id:`file-authoring-size-repair-${n+10}`} ]));
    await pool.query("UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{operator_reconciliations}',$2::jsonb) WHERE id=$1",[total.lease.jobId,JSON.stringify(history)]);
    assert.equal(await total.recover(),true);assert.equal((await row(total.lease.runId)).state,'failed');
    assert.equal((await pool.query('SELECT payload FROM bb_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1',[total.lease.runId])).rows[0].payload.reason,`${localPrefix}_retries_exhausted`);
    await publishPrices(pool,{id:'synthetic-payload-prices',prices:INITIAL_FIXED_PRICES,effectiveAt:'2026-01-01T00:00:00Z',actor:'synthetic',reason:'Payload recovery billing regression'});
    await transaction(pool,c=>grantCredits(c,{owner,source:'existing_grant',key:uid(),points:1000000,expiresAt:null,actor:'synthetic',reason:'Synthetic recovery credits'}));
    const paid=await fixture({paid:true,error:localFailure,capture:'saved'});
    const reservationBefore=(await pool.query('SELECT * FROM bb_credit_reservations WHERE run_id=$1',[paid.lease.runId])).rows;
    const eventsBefore=(await pool.query('SELECT * FROM bb_credit_events WHERE run_id=$1 ORDER BY id',[paid.lease.runId])).rows;
    const balanceBefore=await creditBalanceExact(pool,owner);
    const usageRows=async()=>(await pool.query('SELECT attempt_id,usage_status,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,conflicting_measurements FROM bb_call_usage WHERE attempt_id=$1',[paid.attempt])).rows;
    const usageBefore=await usageRows();
    const usageEvidenceBefore=(await pool.query('SELECT * FROM bb_usage_observations WHERE attempt_id=$1 ORDER BY id',[paid.attempt])).rows;
    const observationsBefore=(await pool.query('SELECT * FROM bb_provider_call_observations WHERE attempt_id=$1 ORDER BY id',[paid.attempt])).rows;
    assert.equal(await recoverFileAuthoringPayload(pool,'other',paid.lease.runId,paid.lease.jobId),false);
    assert.equal(await recoverFileAuthoringPayload(pool,owner,paid.lease.runId,f.lease.jobId),false);
    assert.equal(observationsBefore[0].outcome,'pending_reconcile');assert.equal(observationsBefore[0].error_code,localFailure);
    assert.equal((await pool.query('SELECT payload FROM bb_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1',[paid.lease.runId])).rows[0].payload.reason,`${localPrefix}_recovery_pending`);
    assert.equal((await pool.query('SELECT status FROM bb_model_call_attempts WHERE id=$1',[paid.attempt])).rows[0].status,'pending_reconcile');
    assert.deepEqual((await Promise.all([paid.recover(),paid.recover()])).sort(),[false,true]);
    assert.equal((await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[paid.lease.jobId])).rows[0].checkpoint.operator_reconciliations[paid.attempt].reason_code,`${localPrefix}_auto_retry`);
    assert.equal((await pool.query('SELECT payload FROM bb_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1',[paid.lease.runId])).rows[0].payload.reason,`${localPrefix}_retry_scheduled`);
    assert.deepEqual(await usageRows(),usageBefore);
    assert.deepEqual((await pool.query('SELECT * FROM bb_usage_observations WHERE attempt_id=$1 ORDER BY id',[paid.attempt])).rows,usageEvidenceBefore);
    assert.deepEqual((await pool.query('SELECT * FROM bb_provider_call_observations WHERE attempt_id=$1 ORDER BY id',[paid.attempt])).rows,observationsBefore);
    assert.deepEqual((await pool.query('SELECT * FROM bb_credit_reservations WHERE run_id=$1',[paid.lease.runId])).rows,reservationBefore);
    assert.deepEqual((await pool.query('SELECT * FROM bb_credit_events WHERE run_id=$1 ORDER BY id',[paid.lease.runId])).rows,eventsBefore);
    assert.deepEqual(await creditBalanceExact(pool,owner),balanceBefore);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1',[paid.project])).rows[0].n,1);
    await end(paid.lease.runId);

    // A real SQL 413 disposition must make exactly one new provider attempt
    // claimable in the same run and accept its durable successful result.
    const success=await fixture({paid:true,capture:'saved'});
    const runBefore=(await pool.query('SELECT id,project_id,input_revision,input_hash,reservation_id FROM bb_runs WHERE id=$1',[success.lease.runId])).rows[0];
    const reservationsBefore=(await pool.query('SELECT * FROM bb_credit_reservations WHERE run_id=$1',[success.lease.runId])).rows;
    const originalUsage=(await pool.query('SELECT attempt_id,usage_status,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,conflicting_measurements FROM bb_call_usage WHERE attempt_id=$1',[success.attempt])).rows;
    assert.equal(await success.recover(),true);
    const successLease=await claim(pool,300);assert.ok(successLease);assert.equal(successLease.runId,success.lease.runId);assert.equal(successLease.jobId,success.lease.jobId);
    const retry=await latestProviderAttempt(pool,successLease,success.logical);assert.equal(retry?.operator_retry,true);
    const prompt=(await pool.query('SELECT prompt_snapshot_id FROM bb_model_call_attempts WHERE id=$1',[success.attempt])).rows[0].prompt_snapshot_id;
    const nextAttempt=await recordPotentialCall(pool,successLease,success.logical,2,{modelId:'synthetic',promptSnapshotId:prompt,fileAuthoringRecoveryCapture:true});
    const body=Buffer.from(JSON.stringify({retained:'completed-after-recovery'}));
    const completed:ProviderCallObservation={owner_user_id:owner,project_id:success.project,run_id:success.lease.runId,trace_id:success.lease.runId,
      job_id:success.lease.jobId,logical_call_id:success.logical,attempt_no:2,call_id:nextAttempt,model_id:'synthetic',model_config_version:'synthetic-v1',prompt_snapshot_ref:prompt,
      provider_request_id:'synthetic-success',outcome:'completed',finish_reason:'stop',error_code:null,
      usage:{status:'measured',input_tokens:20,output_tokens:5,cached_input_tokens:0,reasoning_tokens:0,total_tokens:25},
      result_ref:null,result_sha256:digest(body),result_schema_version:'synthetic-v1',result_byte_size:body.length};
    completed.result_ref=providerResultObjectKey(completed,digest(body));await blobs.put(completed.result_ref,body,'application/json');
    const settled=await recordProviderCallObservation(pool,blobs,completed,()=>true,{lease:successLease,source:'provider'});
    assert.equal(settled.attempt_status,'completed');assert.equal(settled.usage_status,'measured');
    assert.deepEqual((await pool.query('SELECT id,project_id,input_revision,input_hash,reservation_id FROM bb_runs WHERE id=$1',[success.lease.runId])).rows[0],runBefore);
    const reservationsAfter=(await pool.query('SELECT * FROM bb_credit_reservations WHERE run_id=$1',[success.lease.runId])).rows;
    assert.equal(reservationsAfter.length,1);
    const {charged_points:chargedBefore,...identityBefore}=reservationsBefore[0],{charged_points:chargedAfter,...identityAfter}=reservationsAfter[0];
    assert.deepEqual(identityAfter,identityBefore,'the retry reuses the same reservation, amount and policy');
    assert.ok(BigInt(chargedAfter)>=BigInt(chargedBefore),'new active work may accrue credits without resetting the original charge');
    assert.deepEqual((await pool.query('SELECT attempt_id,usage_status,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,conflicting_measurements FROM bb_call_usage WHERE attempt_id=$1',[success.attempt])).rows,originalUsage,'successful retry never rewrites the prior unknown usage');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[success.lease.jobId])).rows[0].n,2);
    assert.equal((await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[success.lease.jobId])).rows[0].checkpoint.provider_results[0].call_id,nextAttempt);
    await end(success.lease.runId);

    for(const options of [
      {capture:'prepared',snapshot:'none'}, {capture:'capacity_exceeded',snapshot:'none'},
      {capture:'storage_failed',snapshot:'none'}, {capture:'write_failed',snapshot:'none'},
      {capture:'prepared'}, {capture:'storage_failed'},
    ] satisfies Options[]){
      const stopped=await fixture(options),before=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[stopped.lease.jobId])).rows[0].checkpoint;
      assert.equal(await stopped.recover(),false,JSON.stringify(options));
      assert.deepEqual(await row(stopped.lease.runId),{state:'paused',stage:'provider_reconcile'});
      assert.deepEqual((await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[stopped.lease.jobId])).rows[0].checkpoint,before);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[stopped.lease.jobId])).rows[0].n,1);
      assert.equal((await pool.query('SELECT usage_status FROM bb_call_usage WHERE attempt_id=$1',[stopped.attempt])).rows[0].usage_status,'unknown');
      await end(stopped.lease.runId);
    }
    for(const [field,value] of [['owner_user_id','other-owner'],['input_hash','f'.repeat(64)],['input_revision',2],['attempt_id','other-attempt'],['prepared_at','invalid']] as const){
      const wrong=await fixture({capture:'saved'});
      await pool.query('UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,$2::text[],$3::jsonb) WHERE id=$1',
        [wrong.lease.jobId,['file_authoring_recovery_captures',wrong.attempt,field],JSON.stringify(value)]);
      assert.equal(await wrong.recover(),false,field);await end(wrong.lease.runId);
    }
    const missingSnapshot=await fixture({capture:'saved'});
    await pool.query("UPDATE bb_jobs SET checkpoint=checkpoint #- '{stages,file_authoring_recovery}' WHERE id=$1",[missingSnapshot.lease.jobId]);
    assert.equal(await missingSnapshot.recover(),false);await end(missingSnapshot.lease.runId);
    const active=await fixture({capture:'saved'});await pool.query("UPDATE bb_jobs SET lease_token=$2,lease_until=now()+interval '1 minute' WHERE id=$1",[active.lease.jobId,uid()]);
    assert.equal(await active.recover(),false);await end(active.lease.runId);
    const cancelling=await fixture({paid:true,capture:'saved'});await pool.query('UPDATE bb_jobs SET billing_cancel_requested_at=now() WHERE id=$1',[cancelling.lease.jobId]);
    assert.equal(await cancelling.recover(),false);await end(cancelling.lease.runId);
    // Legacy unknown calls must not consume the dedicated size-limit scan. A full
    // page of ineligible request/output caps must yield to later candidates without changing
    // any evidence or updated_at just to influence queue ordering.
    const unknown=[];
    for(let n=0;n<21;n++)unknown.push(await fixture({error:'MODEL_TURN_FAILED'}));
    const prepared=[];
    for(let n=0;n<21;n++)prepared.push(await prepareFixture());
    prepared.sort((a,b)=>a.lease.jobId<b.lease.jobId?-1:1);
    const blocked=[];
    // Decide the exit evidence before recording the immutable runtime rows.
    for(const [n,p] of prepared.entries())blocked.push(await observe(p.lease,p.project,p.inputHash,1,
      {exit:n===20,error:n%2===0?localFailure:'MODEL_PROVIDER_PAYLOAD_TOO_LARGE'}));
    const candidates=await fileAuthoringPayloadRecoveryCandidates(pool,100,['update']);
    assert.equal(candidates.length,21);
    assert.deepEqual(await fileAuthoringPayloadRecoveryCandidates(pool,20,['review']),[]);
    const eligible=candidates.at(-1)!,eligibleAttempt=blocked.at(-1)!;
    assert.equal(eligible.job_id,eligibleAttempt.lease.jobId);
    const untouchedIds=[...unknown,...blocked.filter(f=>f.lease.jobId!==eligible.job_id)].map(f=>f.lease.runId);
    const states=async(ids:string[])=>(await pool.query(`SELECT r.id,r.state AS run_state,r.stage AS run_stage,r.updated_at AS run_updated_at,
      j.state AS job_state,j.stage AS job_stage,j.updated_at AS job_updated_at FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id
      WHERE r.id=ANY($1::text[]) ORDER BY r.id`,[ids])).rows;
    const untouchedBefore=await states(untouchedIds),eligibleBefore=await states([eligible.run_id]);
    await new WorkerRuntime({pool,blobs,runKinds:['review']}).sweep();
    assert.deepEqual(await states(untouchedIds),untouchedBefore);
    assert.deepEqual(await states([eligible.run_id]),eligibleBefore,'worker task-kind isolation applies to the dedicated scan');
    const rotating=new WorkerRuntime({pool,blobs,runKinds:['update']});
    await rotating.sweep();
    assert.deepEqual(await states([eligible.run_id]),eligibleBefore,'the first scan contains 20 still-running payload attempts');
    await rotating.sweep();
    assert.deepEqual(await row(eligible.run_id),{state:'queued',stage:'queued'},'the second scan reaches the next candidate');
    assert.deepEqual(await states(untouchedIds),untouchedBefore,'blocked and unknown tasks keep their original state and timestamps');
    assert.equal((await pool.query('SELECT usage_status FROM bb_call_usage WHERE attempt_id=$1',[eligibleAttempt.attempt])).rows[0].usage_status,'unknown');
    await end(eligible.run_id);
    const isolated=await fixture({paid:true,error:localFailure});
    await pool.query(`UPDATE bb_credit_lots SET remaining=remaining-1 WHERE id=(SELECT id FROM bb_credit_lots WHERE owner_user_id=$1 AND remaining>frozen+1 LIMIT 1)`,[owner]);
    assert.equal((await inspectAndIsolateBillingScope(pool,{kind:'wallet',owner})).status,'isolated');
    assert.equal(await isolated.recover(),false);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[isolated.lease.jobId])).rows[0].n,1);
  }finally{await app.close();await paidApp.close();await pool.end();}
});
