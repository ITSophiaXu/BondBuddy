import { inspectAndIsolateBillingScope } from '../../api/dist/billing-safety.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { digest,uid,transaction,type PrivateBlobs } from '@bondbuddy/api/data';
import { grantCredits,publishPrices,creditBalanceExact } from '../../api/dist/billing.js';
import { saveSnapshotRef } from '@bondbuddy/api/observability';
import { uploadSyntheticReference } from '@bondbuddy/api/test-authoring-source';
import { emptyUpdateDetails,INITIAL_FIXED_PRICES } from '@bondbuddy/contracts';
import { action,claim,checkpointStage,recordPotentialCall,recoverFileAuthoringPayload,fileAuthoringPayloadRecoveryCandidates,resumePausedRun } from '@bondbuddy/api/queue';
import { recordModelAttemptRuntime,recordProviderCallObservation,latestProviderAttempt,providerResultObjectKey,type ProviderCallObservation } from '@bondbuddy/api/provider-results';
import { WorkerRuntime } from './runtime.js';
import { isolatedTestDatabase } from './test-database.js';
import { fileAuthoringRestartStageName } from './file-authoring-restart.js';
import type { StageContext } from './run-pipeline.js';

const connection=await isolatedTestDatabase(undefined,'file-authoring-payload');
test('file authoring request/output limit recovery preserves work, unknown usage and the original reservation while bounding retries',
  {skip:!connection,timeout:300000},async()=>{
  const pool=new Pool({connectionString:connection}),owner=`payload-${uid()}`,objects=new Map<string,Buffer>();
  const blobs:PrivateBlobs={put:async(k,b)=>{objects.set(k,b);},get:async k=>objects.get(k)!,getIfExists:async k=>objects.get(k)??null,
    getIfExistsBounded:async k=>objects.get(k)??null,exists:async k=>objects.has(k),delete:async k=>{objects.delete(k);}};
  const app=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true,historicalBillingFixture:true});
  const paidApp=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true,historicalBillingFixture:true,enablePaidAuthoring:true});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin:'http://bondbuddy.test'},payload:payload as any});
  type Options={paid?:boolean;runtime?:boolean;snapshot?:'none'|'bad';error?:string;observationError?:string;
    observationOutcome?:'failed'|'pending_reconcile';exit?:boolean;logical?:string;adapter?:string;conflict?:boolean;result?:boolean};
  type Lease=NonNullable<Awaited<ReturnType<typeof claim>>>;
  async function observe(lease:Lease,project:string,inputHash:string,n:number,options:Options={}){
    const logical=options.logical??'file-authoring-v1',content=Buffer.from('synthetic file authoring prompt');
    const error=options.error??'MODEL_PROVIDER_PAYLOAD_TOO_LARGE',outputLimit=error==='MODEL_OUTPUT_TOO_LARGE';
    const objectKey=`users/${owner}/projects/${project}/snapshots/${uid()}`;await blobs.put(objectKey,content,'text/plain');
    const prompt=await saveSnapshotRef(pool,{owner,projectId:project,runId:lease.runId,kind:'model_request',version:n,objectKey,sha256:digest(content),redactionVersion:'synthetic_v1',blobs});
    if(options.snapshot==='none'&&logical==='file-authoring-v1'&&n===1)
      await checkpointStage(pool,lease,'file_authoring_v1_prompt',{snapshot_id:prompt},false);
    const attempt=await recordPotentialCall(pool,lease,logical,n,{modelId:'synthetic',promptSnapshotId:prompt});
    const intent={owner_user_id:owner,project_id:project,run_id:lease.runId,trace_id:lease.runId,job_id:lease.jobId,
      logical_call_id:logical,attempt_no:n,call_id:attempt,model_id:'synthetic',model_config_version:'synthetic-v1',prompt_snapshot_ref:prompt};
    if(options.runtime!==false)await recordModelAttemptRuntime(pool,lease,intent,{adapter:'codex_exec',adapter_version:options.adapter??'codex-file-authoring-2',
      model_provider:'deepseek',model_config_version:'synthetic-v1',provider_request_id_status:'unknown',framework_thread_id:null,
      started_at:new Date().toISOString(),duration_ms:1000,exit_code:options.exit===false||outputLimit?null:1,
      exit_signal:options.exit===false||!outputLimit?null:'SIGKILL',finish_reason:'turn_failed',
      error_code:error,tool_attempts:3,pricing_status:'unknown'});
    if(options.snapshot!=='none'){
      const bytes=Buffer.from(JSON.stringify({input_hash:inputHash})),sha256=digest(bytes),path='input.json';
      const key=`owners/${owner}/projects/${project}/runs/${lease.runId}/file-authoring/recovery/${attempt}/${sha256}/${path}`;
      await blobs.put(key,bytes,'application/json');
      await checkpointStage(pool,lease,'file_authoring_recovery',{version:'file-authoring-recovery-v1',input_hash:options.snapshot==='bad'?'bad':inputHash,
        attempt_id:attempt,logical_call_id:logical,files:[{path,key,sha256,byte_size:bytes.length}]},false);
    }
    const observation:ProviderCallObservation={...intent,provider_request_id:null,finish_reason:'turn_failed',
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
    const f=await fixture();
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
    await observe(next,f.project,f.inputHash,2,{error:'MODEL_OUTPUT_TOO_LARGE'});await new WorkerRuntime({pool,blobs}).sweep();
    next=await claim(pool,30);assert.ok(next);assert.equal(next.runId,f.lease.runId);
    const third=await observe(next,f.project,f.inputHash,3);assert.equal(await third.recover(),true);
    assert.equal((await row(f.lease.runId)).state,'failed');assert.equal(await third.recover(),false);
    assert.equal((await pool.query('SELECT payload FROM bb_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1',[f.lease.runId])).rows[0].payload.reason,'file_authoring_payload_retries_exhausted');
    for(const options of [{runtime:false},{error:'MODEL_TURN_FAILED'},{exit:false},{observationError:'MODEL_STREAM_BROKEN'},{conflict:true},
      {logical:'review-v1'},{adapter:'codex-file-authoring-1'},{error:'MODEL_PROVIDER_REQUEST_REJECTED'},
      {error:'MODEL_OUTPUT_TOO_LARGE',runtime:false},{error:'MODEL_OUTPUT_TOO_LARGE',exit:false},
      {error:'MODEL_OUTPUT_TOO_LARGE',observationOutcome:'failed'},{error:'MODEL_OUTPUT_TOO_LARGE',observationError:'MODEL_STREAM_BROKEN'},
      {error:'MODEL_OUTPUT_TOO_LARGE',conflict:true},{error:'MODEL_OUTPUT_TOO_LARGE',result:true},
      {error:'MODEL_OUTPUT_TOO_LARGE',logical:'review-v1'},{error:'MODEL_OUTPUT_TOO_LARGE',adapter:'codex-file-authoring-1'}] satisfies Options[]){
      const refused=await fixture(options);assert.equal(await refused.recover(),false,JSON.stringify(options));await end(refused.lease.runId);
    }
    for(const snapshot of ['none','bad'] as const){
      const unavailable=await fixture({snapshot});assert.equal(await unavailable.recover(),true);assert.equal((await row(unavailable.lease.runId)).state,'failed');
      assert.equal((await pool.query('SELECT payload FROM bb_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1',[unavailable.lease.runId])).rows[0].payload.reason,'file_authoring_payload_recovery_unavailable');
    }
    for(const flag of ['user_pause_requested','credit_pause_requested']){
      const paused=await fixture({error:'MODEL_OUTPUT_TOO_LARGE'});
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
        await transaction(pool,c=>grantCredits(c,{owner,source:'existing_grant',key:uid(),points:1,expiresAt:null,actor:'synthetic',reason:'Synthetic recharge'}));
        assert.equal(await resumePausedRun(pool,owner,paused.lease.runId,'credits_recharged'),true);
        assert.equal((await claim(pool,30))?.runId,paused.lease.runId);
      }
      await end(paused.lease.runId);
    }
    const both=await fixture({error:'MODEL_OUTPUT_TOO_LARGE'});await pool.query('UPDATE bb_jobs SET user_pause_requested=true,credit_pause_requested=true WHERE id=$1',[both.lease.jobId]);
    assert.equal(await both.recover(),true);assert.deepEqual(await row(both.lease.runId),{state:'paused',stage:'user_paused'});
    assert.equal(await resumePausedRun(pool,owner,both.lease.runId,'credits_recharged'),false,'recharge cannot override the user pause');await end(both.lease.runId);
    const cancelled=await fixture({error:'MODEL_OUTPUT_TOO_LARGE'});await action(pool,owner,cancelled.lease.runId,'cancel');assert.equal(await cancelled.recover(),false);
    const total=await fixture({error:'MODEL_OUTPUT_TOO_LARGE',logical:'file-authoring-size-repair-2'});
    const history=Object.fromEntries(Array.from({length:6},(_,n)=>[`prior-${n}`,{
      reason_code:['file_authoring_payload_auto_retry','file_authoring_output_limit_auto_retry','file_authoring_manual_restart'][n%3],
      logical_call_id:`file-authoring-size-repair-${n+10}`} ]));
    await pool.query("UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{operator_reconciliations}',$2::jsonb) WHERE id=$1",[total.lease.jobId,JSON.stringify(history)]);
    assert.equal((await send('GET',`/api/v1/runs/${total.lease.runId}/retry`)).json().reason_code,'retry_limit_reached');
    assert.equal(await total.recover(),true);assert.equal((await row(total.lease.runId)).state,'failed');
    assert.equal((await pool.query('SELECT payload FROM bb_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1',[total.lease.runId])).rows[0].payload.reason,'file_authoring_output_limit_retries_exhausted');
    await publishPrices(pool,{id:'synthetic-payload-prices',prices:INITIAL_FIXED_PRICES,effectiveAt:'2026-01-01T00:00:00Z',actor:'synthetic',reason:'Payload recovery billing regression'});
    await transaction(pool,c=>grantCredits(c,{owner,source:'existing_grant',key:uid(),points:1000000,expiresAt:null,actor:'synthetic',reason:'Synthetic recovery credits'}));
    const paid=await fixture({paid:true,error:'MODEL_OUTPUT_TOO_LARGE'});
    const reservationBefore=(await pool.query('SELECT * FROM bb_credit_reservations WHERE run_id=$1',[paid.lease.runId])).rows;
    const eventsBefore=(await pool.query('SELECT * FROM bb_credit_events WHERE run_id=$1 ORDER BY id',[paid.lease.runId])).rows;
    const balanceBefore=await creditBalanceExact(pool,owner);
    const usageRows=async()=>(await pool.query('SELECT attempt_id,usage_status,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,conflicting_measurements FROM bb_call_usage WHERE attempt_id=$1',[paid.attempt])).rows;
    const usageBefore=await usageRows();
    const usageEvidenceBefore=(await pool.query('SELECT * FROM bb_usage_observations WHERE attempt_id=$1 ORDER BY id',[paid.attempt])).rows;
    const observationsBefore=(await pool.query('SELECT * FROM bb_provider_call_observations WHERE attempt_id=$1 ORDER BY id',[paid.attempt])).rows;
    assert.equal(await recoverFileAuthoringPayload(pool,'other',paid.lease.runId,paid.lease.jobId),false);
    assert.equal(await recoverFileAuthoringPayload(pool,owner,paid.lease.runId,f.lease.jobId),false);
    assert.equal(observationsBefore[0].outcome,'pending_reconcile');assert.equal(observationsBefore[0].error_code,'MODEL_OUTPUT_TOO_LARGE');
    assert.equal((await pool.query('SELECT payload FROM bb_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1',[paid.lease.runId])).rows[0].payload.reason,'file_authoring_output_limit_recovery_pending');
    assert.equal((await pool.query('SELECT status FROM bb_model_call_attempts WHERE id=$1',[paid.attempt])).rows[0].status,'pending_reconcile');
    assert.deepEqual((await Promise.all([paid.recover(),paid.recover()])).sort(),[false,true]);
    assert.equal((await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[paid.lease.jobId])).rows[0].checkpoint.operator_reconciliations[paid.attempt].reason_code,'file_authoring_output_limit_auto_retry');
    assert.equal((await pool.query('SELECT payload FROM bb_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1',[paid.lease.runId])).rows[0].payload.reason,'file_authoring_output_limit_retry_scheduled');
    assert.deepEqual(await usageRows(),usageBefore);
    assert.deepEqual((await pool.query('SELECT * FROM bb_usage_observations WHERE attempt_id=$1 ORDER BY id',[paid.attempt])).rows,usageEvidenceBefore);
    assert.deepEqual((await pool.query('SELECT * FROM bb_provider_call_observations WHERE attempt_id=$1 ORDER BY id',[paid.attempt])).rows,observationsBefore);
    assert.deepEqual((await pool.query('SELECT * FROM bb_credit_reservations WHERE run_id=$1',[paid.lease.runId])).rows,reservationBefore);
    assert.deepEqual((await pool.query('SELECT * FROM bb_credit_events WHERE run_id=$1 ORDER BY id',[paid.lease.runId])).rows,eventsBefore);
    assert.deepEqual(await creditBalanceExact(pool,owner),balanceBefore);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1',[paid.project])).rows[0].n,1);
    await end(paid.lease.runId);
    const inspect=(f:{lease:Lease})=>send('GET',`/api/v1/runs/${f.lease.runId}/retry`);
    const manualRequest=(f:{attempt:string},mode:'restore_checkpoint'|'restart_materials'='restore_checkpoint')=>
      ({request_id:uid(),attempt_id:f.attempt,mode,...(mode==='restart_materials'?{confirmed_restart:true}:{})});
    const postRetry=(f:{lease:Lease},request:unknown)=>send('POST',`/api/v1/runs/${f.lease.runId}/retry`,request);
    const manual=await fixture({paid:true,error:'MODEL_OUTPUT_TOO_LARGE'});
    assert.deepEqual((await inspect(manual)).json(),{run_id:manual.lease.runId,mode:'restore_checkpoint',attempt_id:manual.attempt,reason_code:'checkpoint_available'});
    const manualReservation=(await pool.query('SELECT * FROM bb_credit_reservations WHERE run_id=$1',[manual.lease.runId])).rows;
    const manualBalance=await creditBalanceExact(pool,owner),manualEvents=(await pool.query('SELECT * FROM bb_credit_events WHERE run_id=$1 ORDER BY id',[manual.lease.runId])).rows;
    const restoreRequest=manualRequest(manual),restoreResponses=await Promise.all([postRetry(manual,restoreRequest),postRetry(manual,restoreRequest)]);
    for(const result of restoreResponses){assert.equal(result.statusCode,200,result.body);assert.equal(result.json().state,'queued');}
    assert.deepEqual((await pool.query('SELECT * FROM bb_credit_reservations WHERE run_id=$1',[manual.lease.runId])).rows,manualReservation);
    assert.deepEqual((await pool.query('SELECT * FROM bb_credit_events WHERE run_id=$1 ORDER BY id',[manual.lease.runId])).rows,manualEvents);
    assert.deepEqual(await creditBalanceExact(pool,owner),manualBalance);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_run_events WHERE run_id=$1 AND payload->>'reason'='file_authoring_output_limit_retry_scheduled'",[manual.lease.runId])).rows[0].n,1);
    const resumed=await claim(pool,300);assert.ok(resumed);assert.equal(resumed.runId,manual.lease.runId);
    const current=await observe(resumed,manual.project,manual.inputHash,2);
    assert.equal((await postRetry(manual,restoreRequest)).statusCode,200,'same request replay never authorizes the new attempt');
    assert.deepEqual(await row(manual.lease.runId),{state:'paused',stage:'provider_reconcile'});
    const stale=await postRetry(manual,manualRequest(manual));assert.equal(stale.statusCode,409,stale.body);assert.equal(stale.json().code,'INPUT_REVISION_CONFLICT');
    const collision=await postRetry(current,{...restoreRequest,attempt_id:current.attempt});assert.equal(collision.statusCode,409,collision.body);assert.equal(collision.json().code,'IDEMPOTENCY_CONFLICT');
    await end(manual.lease.runId);
    const racing=await fixture({error:'MODEL_OUTPUT_TOO_LARGE'}),raceRequest=manualRequest(racing);
    const [,raceResponse]=await Promise.all([racing.recover(),postRetry(racing,raceRequest)]);
    assert.equal(raceResponse.statusCode,200,raceResponse.body);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_run_events WHERE run_id=$1 AND payload->>'reason'='file_authoring_output_limit_retry_scheduled'",[racing.lease.runId])).rows[0].n,1);
    assert.equal((await postRetry(racing,raceRequest)).statusCode,200);await end(racing.lease.runId);
    for(const error of ['MODEL_TURN_FAILED','MODEL_OUTPUT_TOO_LARGE']){
    const legacy=await fixture({error,snapshot:'none',paid:true}),restartRequest=manualRequest(legacy,'restart_materials');
    assert.equal((await inspect(legacy)).json().mode,'restart_materials');
    if(error==='MODEL_OUTPUT_TOO_LARGE'){
      await action(pool,owner,legacy.lease.runId,'pause');
      assert.deepEqual((await inspect(legacy)).json(),{run_id:legacy.lease.runId,attempt_id:legacy.attempt,mode:'resume',reason_code:'user_paused'});
      assert.equal((await action(pool,owner,legacy.lease.runId,'resume')).state,'paused');
      assert.deepEqual(await row(legacy.lease.runId),{state:'paused',stage:'provider_reconcile'});
      assert.equal((await inspect(legacy)).json().mode,'restart_materials');
      assert.equal(await claim(pool,30),null,'undoing a legacy user pause does not authorize restarting the model');
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[legacy.lease.jobId])).rows[0].n,1);
      assert.equal((await pool.query('SELECT user_pause_requested FROM bb_jobs WHERE id=$1',[legacy.lease.jobId])).rows[0].user_pause_requested,false);
    }
    const legacyBefore=(await pool.query('SELECT state,stage,checkpoint,updated_at FROM bb_jobs WHERE id=$1',[legacy.lease.jobId])).rows[0];
    assert.equal(await legacy.recover(),false,'the automatic sweep cannot terminate or silently restart old calls without saved work');
    assert.deepEqual((await pool.query('SELECT state,stage,checkpoint,updated_at FROM bb_jobs WHERE id=$1',[legacy.lease.jobId])).rows[0],legacyBefore);
    const legacyReservation=(await pool.query('SELECT * FROM bb_credit_reservations WHERE run_id=$1',[legacy.lease.runId])).rows;
    const legacyBalance=await creditBalanceExact(pool,owner);
    assert.equal((await postRetry(legacy,{...restartRequest,confirmed_restart:false})).statusCode,422);
    assert.deepEqual(await row(legacy.lease.runId),{state:'paused',stage:'provider_reconcile'});
    const restarted=await Promise.all([postRetry(legacy,restartRequest),postRetry(legacy,restartRequest)]);
    for(const response of restarted)assert.equal(response.statusCode,200,response.body);
    const legacyCheckpoint=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[legacy.lease.jobId])).rows[0].checkpoint;
    assert.equal(legacyCheckpoint.stages.kept.hash,'synthetic');assert.equal(legacyCheckpoint.stages.file_authoring_recovery,undefined);
    assert.equal(legacyCheckpoint.operator_reconciliations[legacy.attempt].reason_code,'file_authoring_manual_restart');
    assert.equal(legacyCheckpoint.operator_reconciliations[legacy.attempt].retry_mode,'restart_materials');
    assert.equal((await pool.query('SELECT usage_status FROM bb_call_usage WHERE attempt_id=$1',[legacy.attempt])).rows[0].usage_status,'unknown');
    assert.deepEqual((await pool.query('SELECT * FROM bb_credit_reservations WHERE run_id=$1',[legacy.lease.runId])).rows,legacyReservation);
    assert.deepEqual(await creditBalanceExact(pool,owner),legacyBalance);
    const restartedLease=await claim(pool,300);assert.ok(restartedLease);assert.equal(restartedLease.runId,legacy.lease.runId);
    const restartPrior=await latestProviderAttempt(pool,restartedLease,legacy.logical);
    assert.equal(restartPrior?.status,'failed');assert.equal(restartPrior?.operator_retry,true);
    const restartRun=(await pool.query('SELECT * FROM bb_runs WHERE id=$1',[legacy.lease.runId])).rows[0];
    const restartContext={pool,run:restartRun,lease:restartedLease,checkpoint:restartedLease.checkpoint.stages} as unknown as StageContext;
    const restartStage=await fileAuthoringRestartStageName(restartContext,'file_authoring_v1',legacy.logical);
    assert.equal(restartStage,`file_authoring_v1_restart_${digest(legacy.attempt).slice(0,12)}`);
    assert.equal(restartContext.checkpoint.file_authoring_v1_prompt.snapshot_id,legacyCheckpoint.stages.file_authoring_v1_prompt.snapshot_id);
    assert.equal((await pool.query('SELECT input_hash FROM bb_runs WHERE id=$1',[legacy.lease.runId])).rows[0].input_hash.trim(),legacy.inputHash);
    const nextRestart=await observe(restartedLease,legacy.project,legacy.inputHash,2,{error,snapshot:'none'});
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[legacy.lease.jobId])).rows[0].n,2);
    assert.equal((await pool.query('SELECT usage_status FROM bb_call_usage WHERE attempt_id=$1',[legacy.attempt])).rows[0].usage_status,'unknown');
    assert.equal((await postRetry(legacy,restartRequest)).statusCode,200,'replaying the owner confirmation does not restart the next attempt');
    assert.deepEqual(await row(nextRestart.lease.runId),{state:'paused',stage:'provider_reconcile'});
    await end(legacy.lease.runId);
    }
    const mixed=await fixture({error:'MODEL_OUTPUT_TOO_LARGE'});
    await pool.query("UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{operator_reconciliations}',$2::jsonb) WHERE id=$1",[mixed.lease.jobId,JSON.stringify({
      'synthetic-first':{reason_code:'file_authoring_payload_auto_retry',logical_call_id:mixed.logical},
      'synthetic-second':{reason_code:'file_authoring_manual_restart',logical_call_id:mixed.logical}})]);
    assert.equal((await inspect(mixed)).json().reason_code,'retry_limit_reached');
    assert.equal((await postRetry(mixed,manualRequest(mixed))).statusCode,409);
    assert.equal(await mixed.recover(),true);assert.equal((await row(mixed.lease.runId)).state,'failed');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[mixed.lease.jobId])).rows[0].n,1);
    // A newer attempt in another logical stage is still newer work: it must not
    // be bypassed by selecting the only old unresolved attempt.
    for(const status of ['confirmed_not_sent','pending_reconcile']){
      const stale=await fixture({error:'MODEL_OUTPUT_TOO_LARGE'});
      await pool.query(`INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status,model_id,prompt_snapshot_id,channel)
        SELECT $2,owner_user_id,job_id,'file-authoring-size-repair-1',1,$3,model_id,prompt_snapshot_id,channel
        FROM bb_model_call_attempts WHERE id=$1`,[stale.attempt,uid(),status]);
      assert.equal(await stale.recover(),false);
      assert.equal((await inspect(stale)).json().reason_code,status==='pending_reconcile'?'provider_evidence_unresolved':'provider_evidence_conflict');
      assert.equal((await postRetry(stale,manualRequest(stale))).statusCode,409);await end(stale.lease.runId);
    }
    const wrongInput=await fixture({error:'MODEL_OUTPUT_TOO_LARGE'});
    await pool.query('UPDATE bb_jobs SET input_hash=$2 WHERE id=$1',[wrongInput.lease.jobId,'f'.repeat(64)]);
    assert.equal(await wrongInput.recover(),false);assert.equal((await inspect(wrongInput)).json().reason_code,'provider_evidence_conflict');
    assert.equal((await postRetry(wrongInput,manualRequest(wrongInput))).statusCode,409);await end(wrongInput.lease.runId);
    // An explicitly invalid checkpoint is not a historical absence and must
    // never fall through to a destructive restart-materials confirmation.
    for(const saved of [null,{}, {version:'file-authoring-recovery-v1',input_hash:'a'.repeat(64)}]){
      const invalid=await fixture({error:'MODEL_OUTPUT_TOO_LARGE'});
      await pool.query("UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{stages,file_authoring_recovery}',$2::jsonb) WHERE id=$1",[invalid.lease.jobId,JSON.stringify(saved)]);
      assert.equal((await inspect(invalid)).json().reason_code,'checkpoint_unavailable');
      assert.equal((await postRetry(invalid,manualRequest(invalid,'restart_materials'))).statusCode,409);
      assert.equal(await invalid.recover(),true);assert.equal((await row(invalid.lease.runId)).state,'failed');
      assert.equal((await pool.query('SELECT payload FROM bb_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1',[invalid.lease.runId])).rows[0].payload.reason,'file_authoring_output_limit_recovery_unavailable');
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[invalid.lease.jobId])).rows[0].n,1);
    }
    for(const [options,reason] of [
      [{exit:false},'active_attempt'],[{runtime:false},'provider_evidence_unresolved'],[{conflict:true},'provider_evidence_conflict'],
      [{observationError:'MODEL_STREAM_BROKEN'},'provider_evidence_conflict'],[{snapshot:'bad'},'checkpoint_unavailable'],
      [{error:'MODEL_TURN_FAILED',snapshot:'none',result:true},'provider_result_present'],
      [{error:'MODEL_OUTPUT_TOO_LARGE',exit:false},'active_attempt'],
      [{error:'MODEL_OUTPUT_TOO_LARGE',runtime:false},'provider_evidence_unresolved'],
      [{error:'MODEL_TIMEOUT'},'provider_evidence_unresolved'],
      [{error:'MODEL_OUTPUT_TOO_LARGE',observationOutcome:'failed'},'provider_evidence_conflict'],
      [{error:'MODEL_OUTPUT_TOO_LARGE',observationError:'MODEL_STREAM_BROKEN'},'provider_evidence_conflict'],
      [{error:'MODEL_OUTPUT_TOO_LARGE',conflict:true},'provider_evidence_conflict'],
      [{error:'MODEL_OUTPUT_TOO_LARGE',snapshot:'bad'},'checkpoint_unavailable'],
      [{error:'MODEL_OUTPUT_TOO_LARGE',snapshot:'none',logical:'file-authoring-size-repair-1'},'checkpoint_unavailable'],
      [{error:'MODEL_OUTPUT_TOO_LARGE',snapshot:'none',result:true},'provider_result_present']
    ] as [Options,string][]){
      const blockedRetry=await fixture(options),before=(await pool.query('SELECT checkpoint,state,stage FROM bb_jobs WHERE id=$1',[blockedRetry.lease.jobId])).rows[0];
      const inspected=await inspect(blockedRetry);assert.equal(inspected.statusCode,200,inspected.body);assert.equal(inspected.json().mode,'blocked');assert.equal(inspected.json().reason_code,reason,JSON.stringify(options));
      assert.equal((await postRetry(blockedRetry,manualRequest(blockedRetry))).statusCode,409);
      assert.deepEqual((await pool.query('SELECT checkpoint,state,stage FROM bb_jobs WHERE id=$1',[blockedRetry.lease.jobId])).rows[0],before);await end(blockedRetry.lease.runId);
    }
    const active=await fixture({error:'MODEL_OUTPUT_TOO_LARGE'});await pool.query('UPDATE bb_jobs SET lease_token=$2,lease_until=now()+interval \'1 minute\' WHERE id=$1',[active.lease.jobId,uid()]);
    assert.equal(await active.recover(),false);
    assert.equal((await inspect(active)).json().reason_code,'active_attempt');assert.equal((await postRetry(active,manualRequest(active))).statusCode,409);await end(active.lease.runId);
    const activeLegacy=await fixture({error:'MODEL_OUTPUT_TOO_LARGE',snapshot:'none',exit:false});await action(pool,owner,activeLegacy.lease.runId,'pause');
    assert.equal((await inspect(activeLegacy)).json().reason_code,'active_attempt');
    await assert.rejects(()=>action(pool,owner,activeLegacy.lease.runId,'resume'),error=>(error as {code:string}).code==='CAPABILITY_NOT_READY');
    assert.equal((await pool.query('SELECT user_pause_requested FROM bb_jobs WHERE id=$1',[activeLegacy.lease.jobId])).rows[0].user_pause_requested,true);await end(activeLegacy.lease.runId);
    const protectedRun=await fixture({paid:true,error:'MODEL_OUTPUT_TOO_LARGE'});await pool.query('UPDATE bb_jobs SET billing_cancel_requested_at=now() WHERE id=$1',[protectedRun.lease.jobId]);
    assert.equal((await inspect(protectedRun)).json().reason_code,'billing_not_ready');
    assert.equal(await protectedRun.recover(),false);
    const blockedBilling=await postRetry(protectedRun,manualRequest(protectedRun));assert.equal(blockedBilling.statusCode,409);assert.equal(blockedBilling.json().code,'BILLING_NOT_READY');await end(protectedRun.lease.runId);
    const ownership=await fixture({error:'MODEL_OUTPUT_TOO_LARGE'}),ownershipRequest=manualRequest(ownership);
    const foreign=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:'other-owner',csrfVerified:true}),enableSyntheticQueue:true});
    const noCsrf=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:false}),enableSyntheticQueue:true});
    const anonymous=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>null,enableSyntheticQueue:true});
    try{
      for(const method of ['GET','POST'] as const){
        const response=await foreign.inject({method,url:`/api/v1/runs/${ownership.lease.runId}/retry`,headers:{origin:'http://bondbuddy.test'},...(method==='POST'?{payload:ownershipRequest}:{})});
        assert.equal(response.statusCode,404,response.body);
        assert.equal((await anonymous.inject({method,url:`/api/v1/runs/${ownership.lease.runId}/retry`,headers:{origin:'http://bondbuddy.test'},...(method==='POST'?{payload:ownershipRequest}:{})})).statusCode,401);
      }
      assert.equal((await noCsrf.inject({method:'POST',url:`/api/v1/runs/${ownership.lease.runId}/retry`,headers:{origin:'http://bondbuddy.test'},payload:ownershipRequest})).statusCode,403);
      assert.equal((await app.inject({method:'POST',url:`/api/v1/runs/${ownership.lease.runId}/retry`,headers:{origin:'http://foreign.test'},payload:ownershipRequest})).statusCode,403);
    }finally{await foreign.close();await noCsrf.close();await anonymous.close();}
    await action(pool,owner,ownership.lease.runId,'pause');assert.equal((await inspect(ownership)).json().reason_code,'user_pause_pending');
    assert.equal(await ownership.recover(),true);assert.equal((await inspect(ownership)).json().mode,'resume');await end(ownership.lease.runId);
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
      {exit:n===20,error:n%2===0?'MODEL_OUTPUT_TOO_LARGE':'MODEL_PROVIDER_PAYLOAD_TOO_LARGE'}));
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
    const isolated=await fixture({paid:true,error:'MODEL_OUTPUT_TOO_LARGE'});
    await pool.query(`UPDATE bb_credit_lots SET remaining=remaining-1 WHERE id=(SELECT id FROM bb_credit_lots WHERE owner_user_id=$1 AND remaining>frozen+1 LIMIT 1)`,[owner]);
    assert.equal((await inspectAndIsolateBillingScope(pool,{kind:'wallet',owner})).status,'isolated');
    assert.equal((await inspect(isolated)).json().reason_code,'billing_not_ready');
    assert.equal(await isolated.recover(),false);
    const isolatedRetry=await postRetry(isolated,manualRequest(isolated));assert.equal(isolatedRetry.statusCode,409,isolatedRetry.body);assert.equal(isolatedRetry.json().code,'BILLING_NOT_READY');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[isolated.lease.jobId])).rows[0].n,1);
  }finally{await app.close();await paidApp.close();await pool.end();}
});
