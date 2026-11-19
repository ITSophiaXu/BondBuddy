import {seedFileAuthoringRun,FILE_AUTHORING_SEED_STAGE} from './file-authoring-seed.js';
import {authorizedFileAuthoringRecovery,fileAuthoringContextDeadline} from './file-authoring-recovery.js';
import type {StageContext} from './run-pipeline.js';
import { inspectAndIsolateBillingScope } from '../../api/dist/billing-safety.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { digest,uid,transaction,type PrivateBlobs } from '@bondbuddy/api/data';
import { grantCredits,publishPrices,creditBalanceExact } from '../../api/dist/billing.js';
import { saveSnapshotRef } from '@bondbuddy/api/observability';
import { uploadSyntheticAudit, uploadSyntheticReference } from '@bondbuddy/api/test-authoring-source';
import { emptyUpdateDetails,INITIAL_FIXED_PRICES, FILE_AUTHORING_CONTEXT_ROTATION_LIMIT, type FileAuthoringCaptureFailure } from '@bondbuddy/contracts';
import { action,claim,checkpointStage,recordPotentialCall,recordFileAuthoringCaptureOutcome,recoverFileAuthoringPayload,fileAuthoringPayloadRecoveryCandidates,resumePausedRun,pausedRuns,providerReconciliationCandidates,resolveOperatorReconciliation } from '@bondbuddy/api/queue';
import { recordModelAttemptRuntime,recordProviderCallObservation,latestProviderAttempt,providerResultObjectKey,type ProviderCallObservation } from '@bondbuddy/api/provider-results';
import { WorkerRuntime } from './runtime.js';
import { isolatedTestDatabase } from './test-database.js';

const configured=!!process.env.BB_TEST_DATABASE_URL;
const providerOutputLimit='MODEL_PROVIDER_OUTPUT_LIMIT';
for(const [localFailure,localPrefix] of [[providerOutputLimit,'file_authoring_output_limit'],
  ['MODEL_OUTPUT_TOO_LARGE','file_authoring_output_limit'],['MODEL_TIMEOUT','file_authoring_timeout']] as const)
test(localFailure===providerOutputLimit?'#1604: provider output exhaustion only resumes a current saved authoring capture with the original deadline':
  `${localFailure} recovery preserves work, unknown usage and the original reservation while bounding retries`,
  {skip:!configured,timeout:600000},async t=>{
  const connection=await isolatedTestDatabase(undefined,`file-authoring-${localFailure}`);
  const pool=new Pool({connectionString:connection}),owner=`payload-${uid()}`,objects=new Map<string,Buffer>();
  const blobs:PrivateBlobs={put:async(k,b)=>{objects.set(k,b);},get:async k=>objects.get(k)!,getIfExists:async k=>objects.get(k)??null,
    getIfExistsBounded:async k=>objects.get(k)??null,exists:async k=>objects.has(k),delete:async k=>{objects.delete(k);}};
  const app=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true,historicalBillingFixture:true});
  const paidApp=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true,enableRunRuntime:true,historicalBillingFixture:true,enablePaidAuthoring:true});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin:'http://bondbuddy.test'},payload:payload as any});
  type Options={paid?:boolean;runtime?:boolean;seedWork?:boolean;snapshot?:'none'|'bad';error?:string;observationError?:string;
    observationOutcome?:'failed'|'pending_reconcile';exit?:boolean;termination?:'signal'|'zero';logical?:string;adapter?:string;conflict?:boolean;
    result?:boolean;deadline?:string;runtimeFinishReason?:string|null;observationFinishReason?:string|null;conflictingTerminal?:boolean;
    capture?:'prepared'|'saved'|'write_failed'|FileAuthoringCaptureFailure};
  type Lease=NonNullable<Awaited<ReturnType<typeof claim>>>;
  async function observe(lease:Lease,project:string,inputHash:string,n:number,options:Options={}){
    const logical=options.logical??'file-authoring-v1',content=Buffer.from('synthetic file authoring prompt');
    const error=options.error??'MODEL_PROVIDER_PAYLOAD_TOO_LARGE';
    const signaled=['MODEL_OUTPUT_TOO_LARGE','MODEL_TIMEOUT','MODEL_CONTEXT_ROTATION_REQUIRED'].includes(error)||options.termination==='signal';
    const finishReason=error===providerOutputLimit?'max_output_tokens':error==='MODEL_TIMEOUT'?'timeout':'turn_failed';
    const objectKey=`users/${owner}/projects/${project}/snapshots/${uid()}`;await blobs.put(objectKey,content,'text/plain');
    const prompt=await saveSnapshotRef(pool,{owner,projectId:project,runId:lease.runId,kind:'model_request',version:n,objectKey,sha256:digest(content),redactionVersion:'synthetic_v1',blobs});
    if(options.snapshot==='none'&&logical==='file-authoring-v1'&&n===1)
      await checkpointStage(pool,lease,'file_authoring_v1_prompt',{snapshot_id:prompt},false);
    const attempt=await recordPotentialCall(pool,lease,logical,n,{modelId:'synthetic',promptSnapshotId:prompt,fileAuthoringRecoveryCapture:!!options.capture,...(options.deadline!==undefined?{fileAuthoringDeadlineAt:options.deadline}:{})});
    if(options.capture){
      const marker=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[lease.jobId])).rows[0].checkpoint.file_authoring_recovery_captures[attempt];
      assert.equal(marker.state,'prepared');assert.equal(marker.attempt_id,attempt);assert.equal(marker.input_hash,inputHash);assert.equal(marker.deadline_at,options.deadline);
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
      started_at:new Date().toISOString(),duration_ms:1000,exit_code:options.exit===false||signaled?null:options.termination==='zero'?0:1,
      exit_signal:options.exit===false||!signaled?null:error==='MODEL_TIMEOUT'?'SIGTERM':'SIGKILL',
      finish_reason:options.runtimeFinishReason===undefined?finishReason:options.runtimeFinishReason,
      error_code:error,tool_attempts:3,pricing_status:'unknown'});
    if(options.snapshot!=='none'){
      const bytes=Buffer.from(JSON.stringify({input_hash:inputHash})),sha256=digest(bytes),path='input.json';
      const key=`owners/${owner}/projects/${project}/runs/${lease.runId}/file-authoring/recovery/${attempt}/${sha256}/${path}`;
      await blobs.put(key,bytes,'application/json');
      const files=[{path,key,sha256,byte_size:bytes.length}];
      if(options.seedWork){
        const work=Buffer.from(JSON.stringify({version:'synthetic-operations',operations:[{id:'preserved-edit'}]})),workHash=digest(work),workPath='output/operations.json';
        const workKey=key.replace(sha256+'/'+path,workHash+'/'+workPath);await blobs.put(workKey,work,'application/json');
        files.push({path:workPath,key:workKey,sha256:workHash,byte_size:work.length});
      }
      await checkpointStage(pool,lease,'file_authoring_recovery',{version:'file-authoring-recovery-v1',input_hash:options.snapshot==='bad'?'bad':inputHash,
        attempt_id:attempt,logical_call_id:logical,files,
        ...(options.deadline!==undefined?{deadline_at:options.deadline}:{})},false);
    }
    if(options.capture&&options.capture!=='prepared'){
      if(options.capture==='write_failed'){
        await pool.query(`ALTER TABLE bb_jobs ADD CONSTRAINT capture_outcome_failure CHECK (id <> '${lease.jobId}' OR checkpoint->'file_authoring_recovery_captures'->'${attempt}'->>'state' <> 'failed') NOT VALID`);
        try{await assert.rejects(recordFileAuthoringCaptureOutcome(pool,lease,attempt,logical,{state:'failed',failure_code:'storage_failed'}),/capture_outcome_failure/);}
        finally{await pool.query('ALTER TABLE bb_jobs DROP CONSTRAINT capture_outcome_failure');}
      }else await recordFileAuthoringCaptureOutcome(pool,lease,attempt,logical,options.capture==='saved'?{state:'saved',failure_code:null}:{state:'failed',failure_code:options.capture});
    }
    const observation:ProviderCallObservation={...intent,provider_request_id:null,
      finish_reason:options.observationFinishReason===undefined?finishReason:options.observationFinishReason,
      outcome:options.observationOutcome??(signaled||error===providerOutputLimit?'pending_reconcile':'failed'),
      usage:{status:'unknown',input_tokens:null,output_tokens:null,cached_input_tokens:null,reasoning_tokens:null,total_tokens:null},
      error_code:options.observationError??error,result_ref:null,result_sha256:null,result_schema_version:null,result_byte_size:null};
    if(options.result){
      const result=Buffer.from(JSON.stringify({retained:'synthetic'})),key=providerResultObjectKey(observation,digest(result));
      await blobs.put(key,result,'application/json');
      Object.assign(observation,{outcome:'pending_reconcile',result_ref:key,result_sha256:digest(result),result_schema_version:'synthetic-v1',result_byte_size:result.length});
    }
    await recordProviderCallObservation(pool,blobs,observation,()=>true,{lease,source:'provider'});
    if(options.conflict)await recordProviderCallObservation(pool,blobs,{...observation,outcome:'pending_reconcile',error_code:'MODEL_STREAM_BROKEN'},()=>true,{source:'provider'});
    if(options.conflictingTerminal)await recordProviderCallObservation(pool,blobs,{...observation,finish_reason:'turn_failed'},()=>true,{source:'provider'});
    return {lease,project,inputHash,attempt,logical,recover:()=>recoverFileAuthoringPayload(pool,owner,lease.runId,lease.jobId)};
  }
  async function prepareFixture(options:Options={}){
    const p=await send('POST','/api/v1/projects',{name:'Synthetic payload recovery',kind:'update',issuer_name:'合成企业',market:'sse',offering:'private',
      update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1'}});assert.equal(p.statusCode,201,p.body);
    const project=p.json().project_id,audit=await uploadSyntheticAudit(app,project),materials=await uploadSyntheticReference(app,project);
    const input=await send('POST',`/api/v1/projects/${project}/input-revisions`,{...materials,material_versions:[...materials.material_versions,audit]});assert.equal(input.statusCode,201,input.body);
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
    if(localFailure===providerOutputLimit){
      const deadline=new Date(Date.now()+3600_000).toISOString();
      const recoverable={error:providerOutputLimit,capture:'saved',deadline} satisfies Options;
      const cp=async(jobId:string)=>(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[jobId])).rows[0].checkpoint;
      const latestEvent=async(runId:string)=>(await pool.query('SELECT payload FROM bb_run_events WHERE run_id=$1 AND type=$2 ORDER BY seq DESC LIMIT 1',[runId,'run.state_changed'])).rows[0]?.payload;
      const attempts=async(jobId:string)=>(await pool.query('SELECT attempt_no,status,usage_status FROM bb_model_call_attempts WHERE job_id=$1 ORDER BY attempt_no',[jobId])).rows;
      const resultCount=async(jobId:string)=>(await pool.query(`SELECT count(*)::int AS n FROM bb_provider_result_refs r
        JOIN bb_model_call_attempts a ON a.id=r.attempt_id WHERE a.job_id=$1`,[jobId])).rows[0].n;
      const runIdentity=async(runId:string)=>(await pool.query('SELECT id,project_id,input_revision,input_hash,reservation_id,artifact_id FROM bb_runs WHERE id=$1',[runId])).rows[0];
      const reservations=async(runId:string)=>(await pool.query('SELECT * FROM bb_credit_reservations WHERE run_id=$1',[runId])).rows;
      const providerEvidence=async(attempt:string)=>(await pool.query('SELECT * FROM bb_provider_call_observations WHERE attempt_id=$1 ORDER BY id',[attempt])).rows;
      const usageEvidence=async(attempt:string)=>(await pool.query('SELECT * FROM bb_usage_observations WHERE attempt_id=$1 ORDER BY id',[attempt])).rows;
      const usage=async(attempt:string)=>(await pool.query('SELECT usage_status,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,conflicting_measurements FROM bb_call_usage WHERE attempt_id=$1',[attempt])).rows;
      const sweep=()=>new WorkerRuntime({pool,blobs,runKinds:['update']}).sweep();

      await publishPrices(pool,{id:'synthetic-provider-output-limit-prices',prices:INITIAL_FIXED_PRICES,effectiveAt:'2026-01-01T00:00:00Z',actor:'synthetic',reason:'#1604 billing regression'});
      await transaction(pool,c=>grantCredits(c,{owner,source:'existing_grant',key:uid(),points:1000000,expiresAt:null,actor:'synthetic',reason:'Synthetic recovery credits'}));
      const first=await fixture({...recoverable,paid:true}),{runId,jobId}=first.lease;
      const identity=await runIdentity(runId),held=await reservations(runId),before=await cp(jobId);
      const observed=await providerEvidence(first.attempt),usageObserved=await usageEvidence(first.attempt),usageBefore=await usage(first.attempt);
      assert.deepEqual(await row(runId),{state:'paused',stage:'provider_reconcile'});
      assert.equal((await latestEvent(runId))?.reason,'file_authoring_output_limit_recovery_pending');
      assert.deepEqual(await attempts(jobId),[{attempt_no:1,status:'pending_reconcile',usage_status:'unknown'}]);
      assert.deepEqual((await pool.query('SELECT exit_code,exit_signal,finish_reason,error_code FROM bb_model_call_attempt_runtime WHERE attempt_id=$1',[first.attempt])).rows,
        [{exit_code:1,exit_signal:null,finish_reason:'max_output_tokens',error_code:providerOutputLimit}]);
      assert.equal(observed.length,1);
      assert.deepEqual([observed[0].finish_reason,observed[0].error_code,observed[0].outcome,observed[0].usage_status,observed[0].result_id],
        ['max_output_tokens',providerOutputLimit,'pending_reconcile','unknown',null]);
      assert.deepEqual(usageBefore,[{usage_status:'unknown',input_tokens:null,output_tokens:null,cached_input_tokens:null,reasoning_tokens:null,conflicting_measurements:0}]);
      assert.equal(before.file_authoring_recovery_captures[first.attempt].state,'saved');
      assert.equal(before.stages.file_authoring_recovery.attempt_id,first.attempt);
      assert.equal(before.stages.file_authoring_recovery.deadline_at,deadline);
      assert.equal(held.length,1);assert.equal(held[0].state,'held');assert.equal(held[0].id,identity.reservation_id);
      assert.equal(identity.artifact_id,null);

      await Promise.all([sweep(),sweep()]);
      assert.deepEqual(await row(runId),{state:'queued',stage:'queued'});
      assert.equal((await latestEvent(runId))?.reason,'file_authoring_output_limit_retry_scheduled');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM bb_run_events WHERE run_id=$1 AND payload->>'reason'='file_authoring_output_limit_retry_scheduled'`,[runId])).rows[0].n,1);
      const after=await cp(jobId);
      assert.deepEqual(after.stages,before.stages);
      assert.deepEqual(after.file_authoring_recovery_captures,before.file_authoring_recovery_captures);
      assert.deepEqual(Object.keys(after.operator_reconciliations),[first.attempt]);
      const disposition=after.operator_reconciliations[first.attempt];
      assert.deepEqual([disposition.reason_code,disposition.attempt_id,disposition.logical_call_id,disposition.decision,disposition.recovery_state,disposition.deadline_at],
        ['file_authoring_output_limit_auto_retry',first.attempt,first.logical,'retry_unknown_usage','queued',deadline]);
      assert.deepEqual(await runIdentity(runId),identity);
      assert.deepEqual(await reservations(runId),held,'requeue neither replaces nor charges the existing reservation');
      assert.deepEqual(await attempts(jobId),[{attempt_no:1,status:'failed',usage_status:'unknown'}]);
      assert.equal(await resultCount(jobId),0);assert.equal(after.provider_results?.length??0,0);

      // Real dispositions, rather than fabricated retry counters: a 413 and an
      // upstream output-limit recovery share the same two fault retries.
      const secondLease=await claim(pool,300);assert.ok(secondLease);assert.equal(secondLease.runId,runId);assert.equal(secondLease.jobId,jobId);
      assert.equal((await latestProviderAttempt(pool,secondLease,first.logical))?.operator_retry,true);
      await assert.rejects(recordPotentialCall(pool,secondLease,first.logical,2,{modelId:'synthetic',fileAuthoringRecoveryCapture:true,
        fileAuthoringDeadlineAt:new Date(Date.parse(deadline)+1000).toISOString()}),/deadline changed/);
      const second=await observe(secondLease,first.project,first.inputHash,2,{capture:'saved',deadline});
      assert.equal(await second.recover(),true);
      assert.equal((await cp(jobId)).operator_reconciliations[second.attempt].reason_code,'file_authoring_payload_auto_retry');
      const thirdLease=await claim(pool,300);assert.ok(thirdLease);assert.equal(thirdLease.runId,runId);
      const third=await observe(thirdLease,first.project,first.inputHash,3,recoverable);
      assert.equal(await third.recover(),true);
      assert.deepEqual(await row(runId),{state:'failed',stage:'failed'});
      assert.equal((await latestEvent(runId))?.reason,'file_authoring_output_limit_retries_exhausted');
      assert.equal(await claim(pool,30),null,'exhaustion cannot admit a fourth call');
      assert.deepEqual(await attempts(jobId),[1,2,3].map(attempt_no=>({attempt_no,status:'failed',usage_status:'unknown'})));
      assert.deepEqual(await providerEvidence(first.attempt),observed);
      assert.deepEqual(await usageEvidence(first.attempt),usageObserved);
      assert.deepEqual(await usage(first.attempt),usageBefore);
      assert.equal(await resultCount(jobId),0);

      const assertBlocked=async(stopped:Awaited<ReturnType<typeof fixture>>,label:string,expectedAttempts=1)=>{
        const {runId,jobId}=stopped.lease;
        assert.ok(['paused','failed'].includes((await row(runId)).state),label);
        assert.equal(await claim(pool,30),null,label);
        assert.equal((await attempts(jobId)).length,expectedAttempts,label);
        assert.ok(!(await cp(jobId)).operator_reconciliations?.[stopped.attempt]?.decision?.startsWith('retry'),label);
        assert.equal(await resultCount(jobId),0,label);
        await end(runId);
      };
      const sized=await fixture({...recoverable,logical:'file-authoring-size-repair-2'});
      assert.equal(await sized.recover(),true,'size repair uses the same narrowly scoped output-limit policy');
      const sizedLease=await claim(pool,300);assert.ok(sizedLease);assert.equal(sizedLease.runId,sized.lease.runId);
      const stale=await observe(sizedLease,sized.project,sized.inputHash,2,{...recoverable,logical:sized.logical,capture:'prepared',snapshot:'none'});
      assert.equal((await cp(sizedLease.jobId)).stages.file_authoring_recovery.attempt_id,sized.attempt,'the only saved snapshot belongs to the prior attempt');
      await sweep();
      assert.match((await latestEvent(sizedLease.runId))?.reason??'',/^file_authoring_output_limit_/,'do not replace a known output-limit cause with generic reconciliation');
      await assertBlocked(stale,'a previous attempt’s snapshot does not recover the current incomplete execution',2);

      const uncaptured=await fixture({...recoverable,capture:undefined,deadline:undefined,snapshot:'none'});
      await sweep();
      assert.equal((await latestEvent(uncaptured.lease.runId))?.error_code,providerOutputLimit,'no capture still preserves the known cause after the sweep');
      await assertBlocked(uncaptured,'no historical snapshot does not authorize another model attempt');

      for(const [label,options] of [
        ['generic turn failure', {error:'MODEL_TURN_FAILED',observationOutcome:'pending_reconcile'}],
        ['not a pending-reconcile observation', {observationOutcome:'failed'}],
        ['missing runtime finish reason', {runtimeFinishReason:null}],
        ['missing observation finish reason', {observationFinishReason:null}],
        ['no exit evidence', {exit:false}],
        ['signal termination', {termination:'signal'}],
        ['zero exit', {termination:'zero'}],
        ['conflicting terminal observations', {conflictingTerminal:true}],
        ['legacy adapter', {adapter:'codex-file-authoring-1'}],
        ['other logical call', {logical:'review-v1',capture:undefined,deadline:undefined}],
        ['no modern capture', {capture:undefined,deadline:undefined}],
        ['failed capture despite saved files', {capture:'storage_failed'}],
        ['saved capture without a deadline', {deadline:undefined}],
        ['snapshot and intent deadlines disagree', {}],
      ] satisfies [string,Options][]){
        const stopped=await fixture({...recoverable,...options});
        if(label==='snapshot and intent deadlines disagree')await pool.query("UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{stages,file_authoring_recovery,deadline_at}',$2::jsonb) WHERE id=$1",
          [stopped.lease.jobId,JSON.stringify(new Date(Date.parse(deadline)+1000).toISOString())]);
        await stopped.recover();
        if(label==='no modern capture'||label==='failed capture despite saved files'||label==='saved capture without a deadline'){
          assert.match((await latestEvent(stopped.lease.runId))?.reason??'',/^file_authoring_output_limit_/,`${label}: explicit cause remains visible`);
          assert.equal((await providerEvidence(stopped.attempt))[0]?.error_code,providerOutputLimit);
        }
        await assertBlocked(stopped,label);
      }
      return;
    }
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
    if(localFailure==='MODEL_TIMEOUT'){
      const deadline=new Date(Date.now()+3600_000).toISOString(),rotation='MODEL_CONTEXT_ROTATION_REQUIRED';
      const userPaused=await fixture({error:rotation,capture:'saved',deadline});
      assert.equal((await action(pool,owner,userPaused.lease.runId,'pause')).state,'paused');
      assert.equal((await pool.query('SELECT user_pause_requested FROM bb_jobs WHERE id=$1',[userPaused.lease.jobId])).rows[0].user_pause_requested,true,
        'a user pause during context rotation must persist before recovery');
      assert.equal(await userPaused.recover(),true);
      assert.deepEqual(await row(userPaused.lease.runId),{state:'paused',stage:'user_paused'});
      assert.equal(await claim(pool,30),null,'context rotation cannot override the user pause');
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[userPaused.lease.jobId])).rows[0].n,1);
      assert.equal((await action(pool,owner,userPaused.lease.runId,'resume')).state,'queued');
      assert.equal((await claim(pool,30))?.runId,userPaused.lease.runId);
      await end(userPaused.lease.runId);
      // Each image context may emit only two largest previews. Four complete
      // rotations already pass the old six-image/three-context failure point.
      let rotating=await fixture({error:rotation,capture:'saved',deadline});
      const original=(await pool.query('SELECT id,input_hash,input_revision,reservation_id FROM bb_runs WHERE id=$1',[rotating.lease.runId])).rows[0];
      for(let n=1;n<=4;n++){
        assert.equal(await rotating.recover(),true);
        assert.deepEqual(await row(rotating.lease.runId),{state:'queued',stage:'queued'});
        const cp=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[rotating.lease.jobId])).rows[0].checkpoint;
        assert.equal(cp.operator_reconciliations[rotating.attempt].reason_code,'file_authoring_context_rotation');
        assert.equal(cp.operator_reconciliations[rotating.attempt].deadline_at,deadline);
        assert.equal(Object.values(cp.operator_reconciliations).filter((entry:any)=>entry.reason_code==='file_authoring_context_rotation').length,n);
        assert.equal(Object.values(cp.operator_reconciliations).filter((entry:any)=>String(entry.reason_code).endsWith('_auto_retry')).length,0);
        assert.equal((await pool.query('SELECT usage_status FROM bb_call_usage WHERE attempt_id=$1',[rotating.attempt])).rows[0].usage_status,'unknown');
        const lease=await claim(pool,300);assert.ok(lease);assert.equal(lease.runId,rotating.lease.runId);
        if(n===1){
          for(const nextDeadline of [undefined,new Date(Date.parse(deadline)+1000).toISOString(),new Date(Date.parse(deadline)-1000).toISOString()]){
            await assert.rejects(recordPotentialCall(pool,lease,rotating.logical,n+1,{modelId:'synthetic',fileAuthoringRecoveryCapture:true,
              ...(nextDeadline!==undefined?{fileAuthoringDeadlineAt:nextDeadline}:{})}),error=>(error as {code:string}).code==='INPUT_REVISION_CONFLICT');
          }
          await assert.rejects(recordPotentialCall(pool,lease,rotating.logical,n+1,{modelId:'synthetic'}),/deadline changed/,
            'ordinary operator retry cannot remove the first intent deadline');
          assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[lease.jobId])).rows[0].n,1);
        }
        rotating=await observe(lease,rotating.project,rotating.inputHash,n+1,{error:n===4?'MODEL_PROVIDER_PAYLOAD_TOO_LARGE':rotation,capture:'saved',deadline});
      }
      assert.deepEqual((await pool.query('SELECT id,input_hash,input_revision,reservation_id FROM bb_runs WHERE id=$1',[rotating.lease.runId])).rows[0],original);
      // Normal rotation neither spends nor expands the original fault allowance.
      for(let n=0;n<3;n++){
        assert.equal(await rotating.recover(),true);
        assert.equal((await row(rotating.lease.runId)).state,n===2?'failed':'queued');
        if(n<2){const lease=await claim(pool,300);assert.ok(lease);rotating=await observe(lease,rotating.project,rotating.inputHash,n+6,{capture:'saved',deadline});}
      }
      assert.equal((await pool.query('SELECT payload FROM bb_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1',[rotating.lease.runId])).rows[0].payload.reason,'file_authoring_payload_retries_exhausted');

      const capped=await fixture({error:rotation,capture:'saved',deadline,logical:'file-authoring-size-repair-2'});
      const priorRotations=Object.fromEntries(Array.from({length:FILE_AUTHORING_CONTEXT_ROTATION_LIMIT-1},(_,n)=>[`rotation-${n}`,{
        reason_code:'file_authoring_context_rotation',decision:'retry_unknown_usage',logical_call_id:'file-authoring-v1',deadline_at:deadline}]));
      await pool.query("UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{operator_reconciliations}',$2::jsonb) WHERE id=$1",[capped.lease.jobId,JSON.stringify(priorRotations)]);
      assert.equal(await capped.recover(),true);assert.equal((await row(capped.lease.runId)).state,'queued','the 32nd run-wide rotation is permitted');
      const cappedLease=await claim(pool,300);assert.ok(cappedLease);
      const cappedNext=await observe(cappedLease,capped.project,capped.inputHash,2,{error:rotation,capture:'saved',deadline,logical:capped.logical});
      assert.equal(await cappedNext.recover(),true);assert.equal((await row(capped.lease.runId)).state,'failed');
      assert.equal((await pool.query('SELECT payload FROM bb_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1',[capped.lease.runId])).rows[0].payload.reason,'file_authoring_context_rotation_limit_exhausted');

      for(const options of [{error:rotation},{error:rotation,capture:'saved'}] satisfies Options[]){
        const legacy=await fixture(options);assert.equal(await legacy.recover(),false);
        assert.deepEqual(await row(legacy.lease.runId),{state:'paused',stage:'provider_reconcile'});await end(legacy.lease.runId);
      }
      const mismatched=await fixture({error:rotation,capture:'saved',deadline});
      await pool.query("UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{stages,file_authoring_recovery,deadline_at}',$2::jsonb) WHERE id=$1",[mismatched.lease.jobId,JSON.stringify(new Date(Date.parse(deadline)+1000).toISOString())]);
      assert.equal(await mismatched.recover(),false);await end(mismatched.lease.runId);

      for(const error of [rotation,'MODEL_PROVIDER_PAYLOAD_TOO_LARGE','MODEL_TIMEOUT']){
        const expired=await fixture({error,capture:'saved',deadline});
        const clock=t.mock.method(Date,'now',()=>Date.parse(deadline)+1);
        try{assert.equal(await expired.recover(),true);}finally{clock.mock.restore();}
        assert.deepEqual(await row(expired.lease.runId),{state:'failed',stage:'failed'});
        const terminal=(await pool.query('SELECT payload FROM bb_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1',[expired.lease.runId])).rows[0].payload;
        assert.equal(terminal.reason,'file_authoring_context_deadline_exhausted');assert.equal(terminal.error_code,'MODEL_TIMEOUT');
        assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[expired.lease.jobId])).rows[0].n,1);
      }
      const manual=await fixture({error:'MODEL_STREAM_BROKEN',capture:'saved',deadline});
      await resolveOperatorReconciliation(pool,{runId:manual.lease.runId,attemptId:manual.attempt,decision:'retry_unknown_usage',reasonCode:'synthetic_operator_retry',actor:'synthetic'});
      const manualLease=await claim(pool,300);assert.ok(manualLease);assert.equal(manualLease.runId,manual.lease.runId);
      const manualAudit=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[manualLease.jobId])).rows[0].checkpoint.operator_reconciliations[manual.attempt];
      assert.equal(manualAudit.deadline_at,deadline);
      for(const nextDeadline of [undefined,new Date(Date.parse(deadline)+1000).toISOString()])
        await assert.rejects(recordPotentialCall(pool,manualLease,manual.logical,2,{modelId:'synthetic',fileAuthoringRecoveryCapture:true,
          ...(nextDeadline!==undefined?{fileAuthoringDeadlineAt:nextDeadline}:{})}),/deadline changed/);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[manualLease.jobId])).rows[0].n,1);
      await end(manual.lease.runId);
      const admission=await prepareFixture(),past=new Date(Date.now()-1000).toISOString();
      await assert.rejects(recordPotentialCall(pool,admission.lease,'file-authoring-v1',1,{modelId:'synthetic',fileAuthoringRecoveryCapture:true,fileAuthoringDeadlineAt:past}),/AUTHORING_CONTEXT_DEADLINE_EXCEEDED/);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[admission.lease.jobId])).rows[0].n,0);
      assert.notEqual((await pool.query('SELECT state FROM bb_evidence_gate_events ORDER BY seq DESC LIMIT 1')).rows[0]?.state,'paused',
        'the host deadline is not an evidence-storage outage');
      await end(admission.lease.runId);

      // If the deadline expires between intent and spawn, keep not-sent fact but
      // finish the run normally instead of entering a permanent reconcile loop.
      for(const [field,value] of [['valid',null],['project_id','other-project'],['input_revision',2],['input_hash','f'.repeat(64)]] as const){
        const preSpawn=await prepareFixture(),content=Buffer.from('synthetic pre-spawn deadline');
        const objectKey=`users/${owner}/projects/${preSpawn.project}/snapshots/${uid()}`;await blobs.put(objectKey,content,'text/plain');
        const prompt=await saveSnapshotRef(pool,{owner,projectId:preSpawn.project,runId:preSpawn.lease.runId,kind:'model_request',version:1,objectKey,sha256:digest(content),redactionVersion:'synthetic_v1',blobs});
        const preSpawnDeadline=new Date(Date.now()+60_000).toISOString();
        const attempt=await recordPotentialCall(pool,preSpawn.lease,'file-authoring-v1',1,{modelId:'synthetic',promptSnapshotId:prompt,fileAuthoringRecoveryCapture:true,fileAuthoringDeadlineAt:preSpawnDeadline});
        if(field!=='valid')await pool.query('UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,$2::text[],$3::jsonb) WHERE id=$1',
          [preSpawn.lease.jobId,['file_authoring_recovery_captures',attempt,field],JSON.stringify(value)]);
        const notSent:ProviderCallObservation={owner_user_id:owner,project_id:preSpawn.project,run_id:preSpawn.lease.runId,trace_id:preSpawn.lease.runId,job_id:preSpawn.lease.jobId,
          logical_call_id:'file-authoring-v1',attempt_no:1,call_id:attempt,model_id:'synthetic',model_config_version:'synthetic-v1',prompt_snapshot_ref:prompt,
          provider_request_id:null,outcome:'confirmed_not_sent',finish_reason:'context_deadline_exhausted',error_code:'MODEL_TIMEOUT',
          usage:{status:'unknown',input_tokens:null,output_tokens:null,cached_input_tokens:null,reasoning_tokens:null,total_tokens:null},
          result_ref:null,result_sha256:null,result_schema_version:null,result_byte_size:null};
        const clock=t.mock.method(Date,'now',()=>Date.parse(preSpawnDeadline)+1);
        try{await recordProviderCallObservation(pool,blobs,notSent,()=>true,{lease:preSpawn.lease,source:'provider'});}finally{clock.mock.restore();}
        assert.deepEqual(await row(preSpawn.lease.runId),field==='valid'?{state:'failed',stage:'failed'}:{state:'paused',stage:'provider_reconcile'},
          `${field}: only a capture matching the complete locked input may authorize deadline failure`);
        assert.equal((await pool.query('SELECT status FROM bb_model_call_attempts WHERE id=$1',[attempt])).rows[0].status,'confirmed_not_sent');
        assert.equal(await claim(pool,30),null);
        if(field!=='valid')await end(preSpawn.lease.runId);
      }
    }
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
    if(localFailure==='MODEL_TIMEOUT'){
      const deadline=new Date(Date.now()+3600_000).toISOString(),balanceBefore=await creditBalanceExact(pool,owner);
      const rotatingPaid=await fixture({paid:true,error:'MODEL_CONTEXT_ROTATION_REQUIRED',capture:'saved',deadline});
      const held=(await pool.query('SELECT * FROM bb_credit_reservations WHERE run_id=$1',[rotatingPaid.lease.runId])).rows[0];
      assert.equal(held.state,'held');
      const usageRows=async(attempt:string)=>(await pool.query('SELECT * FROM bb_call_usage WHERE attempt_id=$1',[attempt])).rows;
      const evidenceRows=async(attempt:string)=>{
        const [usage,provider]=await Promise.all([
          pool.query('SELECT * FROM bb_usage_observations WHERE attempt_id=$1 ORDER BY id',[attempt]),
          pool.query('SELECT * FROM bb_provider_call_observations WHERE attempt_id=$1 ORDER BY id',[attempt])]);
        return {usage:usage.rows,provider:provider.rows};
      };
      const recoveryAudit=async(attempt:string)=>(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[rotatingPaid.lease.jobId])).rows[0].checkpoint.operator_reconciliations[attempt];
      const usageBefore=await usageRows(rotatingPaid.attempt),evidenceBefore=await evidenceRows(rotatingPaid.attempt);
      assert.equal(usageBefore.length,1);assert.equal(usageBefore[0].call_status,'pending_reconcile');
      assert.equal(await rotatingPaid.recover(),true);
      // bb_call_usage is a view: call_status reflects the explicit recovery
      // disposition, while supplier usage and the original observations stay immutable.
      const disposedUsage=usageBefore.map(value=>({...value,call_status:'failed'}));
      assert.deepEqual(await usageRows(rotatingPaid.attempt),disposedUsage,'normal rotation changes only the attempt disposition, never unknown usage');
      const rotationAudit=await recoveryAudit(rotatingPaid.attempt);
      assert.deepEqual(rotationAudit,{actor:'worker_file_authoring_recovery',reason_code:'file_authoring_context_rotation',
        attempt_id:rotatingPaid.attempt,logical_call_id:rotatingPaid.logical,decision:'retry_unknown_usage',recovery_state:'queued',deadline_at:deadline});
      assert.deepEqual((await pool.query('SELECT * FROM bb_credit_reservations WHERE run_id=$1',[rotatingPaid.lease.runId])).rows,[held],
        'normal rotation does not release, replace, reset or charge the original reservation');
      const lease=await claim(pool,300);assert.ok(lease);assert.equal(lease.runId,rotatingPaid.lease.runId);
      const next=await observe(lease,rotatingPaid.project,rotatingPaid.inputHash,2,{error:'MODEL_TIMEOUT',capture:'saved',deadline,seedWork:true});
      const nextUsageBefore=await usageRows(next.attempt),nextEvidenceBefore=await evidenceRows(next.attempt);
      assert.equal(nextUsageBefore.length,1);assert.equal(nextUsageBefore[0].call_status,'pending_reconcile');
      const clock=t.mock.method(Date,'now',()=>Date.parse(deadline)+1);
      try{assert.equal(await next.recover(),true);}finally{clock.mock.restore();}
      assert.deepEqual(await row(rotatingPaid.lease.runId),{state:'failed',stage:'failed'});
      const released=(await pool.query('SELECT * FROM bb_credit_reservations WHERE run_id=$1',[rotatingPaid.lease.runId])).rows;
      assert.equal(released.length,1);assert.equal(released[0].id,held.id);assert.equal(released[0].state,'released');assert.ok(released[0].finalized_at);
      assert.ok(BigInt(released[0].charged_points)>0n,'the existing dynamic fixture retains its historical debit counter');
      assert.equal((await pool.query("SELECT coalesce(sum(points),0)::text amount FROM bb_credit_events WHERE reservation_id=$1 AND kind='correction' AND reason='authoring_platform_failure_refund'",[held.id])).rows[0].amount,released[0].charged_points,'the ordinary terminal transaction has already refunded that exact amount');
      assert.equal(await creditBalanceExact(pool,owner).then(x=>x.available),balanceBefore.available,'the ordinary failure transaction releases/refunds authoring credits');
      assert.deepEqual(await usageRows(rotatingPaid.attempt),disposedUsage,'terminal settlement cannot change the prior disposed attempt or its unknown usage');
      assert.deepEqual(await usageRows(next.attempt),nextUsageBefore.map(value=>({...value,call_status:'failed'})),
        'deadline exhaustion changes only the latest attempt disposition, never unknown usage');
      assert.deepEqual(await evidenceRows(rotatingPaid.attempt),evidenceBefore,'earlier raw supplier and usage observations remain byte-for-byte unchanged');
      assert.deepEqual(await evidenceRows(next.attempt),nextEvidenceBefore,'deadline failure preserves the latest raw supplier and usage observations');
      assert.deepEqual(await recoveryAudit(rotatingPaid.attempt),rotationAudit,'terminal settlement cannot replace the earlier rotation authorization');
      assert.deepEqual(await recoveryAudit(next.attempt),{actor:'worker_file_authoring_recovery',reason_code:'file_authoring_context_deadline_exhausted',
        attempt_id:next.attempt,logical_call_id:next.logical,decision:'fail_run',recovery_state:'failed',deadline_at:deadline});
      // A fresh normal execution may explicitly import the terminal source's
      // work with a NEW bounded budget. It never revives or edits that source.
      // Legacy billing fixtures pin one quote per price version. Publish a new
      // synthetic version so this is a separately authorized normal purchase;
      // original quote/reservation/observations are never edited.
      await publishPrices(pool,{id:uid(),prices:INITIAL_FIXED_PRICES,effectiveAt:new Date(Date.now()-1000).toISOString(),actor:'synthetic',reason:'Explicit new-run seed fixture quote'});
      const quote=await paidApp.inject({method:'POST',url:'/api/v1/projects/'+rotatingPaid.project+'/credit-quote',headers:{origin:'http://bondbuddy.test'},payload:{input_revision:1,input_hash:rotatingPaid.inputHash}});
      assert.equal(quote.statusCode,200,quote.body);
      const started=await paidApp.inject({method:'POST',url:'/api/v1/runs/execute',headers:{origin:'http://bondbuddy.test'},payload:{execution_request_id:uid(),project_id:rotatingPaid.project,input_revision:1,input_hash:rotatingPaid.inputHash,quote_id:quote.json().quote.quote_id,task_kind:'update',input_manifest_ref:'synthetic',storage_origin:'cloud',workspace_id:'synthetic'}});
      assert.equal(started.statusCode,202,started.body);const target=started.json().run_id;
      const targetJob=(await pool.query('SELECT * FROM bb_jobs WHERE run_id=$1',[target])).rows[0];
      const sourceBefore=(await pool.query('SELECT to_jsonb(r) AS run,to_jsonb(j) AS job FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id WHERE r.id=$1',[rotatingPaid.lease.runId])).rows;
      const creditBefore=(await pool.query('SELECT * FROM bb_credit_events WHERE run_id=ANY($1::text[]) ORDER BY id',[[target,rotatingPaid.lease.runId]])).rows;
      const seedArgs={sourceRunId:rotatingPaid.lease.runId,targetRunId:target,actor:'synthetic',budgetMs:60_000};
      await assert.rejects(seedFileAuthoringRun(pool,blobs,{...seedArgs,actor:''}),/AUTHORING_SEED_CONFLICT/);
      await assert.rejects(seedFileAuthoringRun(pool,blobs,{...seedArgs,budgetMs:91*60000}),/AUTHORING_SEED_CONFLICT/);
      await assert.rejects(seedFileAuthoringRun(pool,blobs,seedArgs),/AUTHORING_SEED_CONFLICT/,'unexpired source cannot get a new budget');
      const seedClock=t.mock.method(Date,'now',()=>Date.parse(deadline)+1);
      try{
        await pool.query("UPDATE bb_jobs SET lease_token=$2,lease_until=now()+interval '1 minute' WHERE id=$1",[targetJob.id,uid()]);
        await assert.rejects(seedFileAuthoringRun(pool,blobs,seedArgs),/AUTHORING_SEED_CONFLICT/);
        await pool.query('UPDATE bb_jobs SET lease_token=NULL,lease_until=NULL WHERE id=$1',[targetJob.id]);
        await assert.rejects(seedFileAuthoringRun(pool,blobs,{...seedArgs,sourceRunId:f.lease.runId}),/AUTHORING_SEED_CONFLICT/,'foreign project rejected');
        const corrupt={...blobs,getIfExistsBounded:async(key:string,max:number)=>key.endsWith('/output/operations.json')?Buffer.from('corrupt'):blobs.getIfExistsBounded(key,max)};
        await assert.rejects(seedFileAuthoringRun(pool,corrupt,seedArgs),/WORD_OUTPUT_BLOB_MISMATCH/);
        assert.deepEqual((await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[targetJob.id])).rows[0].checkpoint,{},'failed copy publishes no partial seed');
        const outcomes=await Promise.all([seedFileAuthoringRun(pool,blobs,seedArgs),seedFileAuthoringRun(pool,blobs,seedArgs)]);
        assert.deepEqual(outcomes.map(x=>x.idempotent).sort(),[false,true]);assert.equal(outcomes[0].deadline_at,outcomes[1].deadline_at);
        assert.ok(Date.parse(outcomes[0].deadline_at)>Date.parse(deadline));
        const checkpoint=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[targetJob.id])).rows[0].checkpoint;
        const ctx={run:{id:target,owner_user_id:owner,project_id:rotatingPaid.project,input_revision:1,input_hash:rotatingPaid.inputHash},lease:{jobId:targetJob.id,checkpoint}} as StageContext;
        const saved=authorizedFileAuthoringRecovery(ctx,'file-authoring-v1');assert.ok(saved);assert.equal(saved.files.length,2);
        assert.equal(fileAuthoringContextDeadline(ctx,'file-authoring-v1'),outcomes[0].deadline_at);
        assert.ok(saved.files.every(f=>f.key.includes('/runs/'+target+'/')));
        await assert.rejects(seedFileAuthoringRun(pool,blobs,{...seedArgs,budgetMs:120_000}),/AUTHORING_SEED_CONFLICT/,'repeating command cannot reset or extend budget');
        assert.equal((await pool.query("SELECT count(*)::int n FROM bb_run_events WHERE run_id=$1 AND payload->>'reason'='file_authoring_prior_work_seeded'",[target])).rows[0].n,1);
        assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[targetJob.id])).rows[0].n,0,'seeding sends no model call');
        assert.deepEqual((await pool.query('SELECT to_jsonb(r) AS run,to_jsonb(j) AS job FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id WHERE r.id=$1',[rotatingPaid.lease.runId])).rows,sourceBefore);
        assert.deepEqual((await pool.query('SELECT * FROM bb_credit_events WHERE run_id=ANY($1::text[]) ORDER BY id',[[target,rotatingPaid.lease.runId]])).rows,creditBefore,'seeding neither recharges nor edits either ledger');
        assert.equal(checkpoint.stages[FILE_AUTHORING_SEED_STAGE].source_attempt_id,next.attempt);
      }finally{seedClock.mock.restore();}
      await action(pool,owner,target,'cancel');
      for(const attempt of [rotatingPaid.attempt,next.attempt]){
        assert.deepEqual((await pool.query('SELECT status,usage_status FROM bb_model_call_attempts WHERE id=$1',[attempt])).rows,
          [{status:'failed',usage_status:'unknown'}]);
        assert.deepEqual((await pool.query('SELECT usage_status,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,conflicting_measurements FROM bb_call_usage WHERE attempt_id=$1',[attempt])).rows,
          [{usage_status:'unknown',input_tokens:null,output_tokens:null,cached_input_tokens:null,reasoning_tokens:null,conflicting_measurements:0}]);
      }
    }
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
    // Every reconciliation candidate shares bounded keyset pagination. Multiple
    // pages of unknown or still-running calls must yield to the recoverable run;
    // durable backoff may update scheduling metadata, never provider evidence.
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
    const allCandidates=await providerReconciliationCandidates(pool,100,['update']);
    const position=allCandidates.findIndex(candidate=>candidate.run_id===eligible.run_id);assert.ok(position>=0);
    const passes=Math.floor(position/20)+1;assert.ok(passes<=3,'42 candidates need at most three bounded passes');
    const evidence=async()=>(await pool.query(`SELECT to_jsonb(o) value FROM bb_provider_call_observations o
      JOIN bb_runs r ON r.id=o.run_id WHERE r.id=ANY($1::text[]) ORDER BY o.id`,[untouchedIds])).rows;
    const beforeEvidence=await evidence();
    const rotating=new WorkerRuntime({pool,blobs,runKinds:['update']});
    for(let pass=1;pass<=passes;pass++){
      await rotating.sweep();
      if(pass<passes)assert.deepEqual(await states([eligible.run_id]),eligibleBefore,'only the current keyset page is processed');
    }
    assert.deepEqual(await row(eligible.run_id),{state:'queued',stage:'queued'},'bounded pagination reaches the recoverable candidate');
    assert.deepEqual(await evidence(),beforeEvidence,'backoff never rewrites provider observations');
    assert.ok((await states(untouchedIds)).every(row=>row.run_state==='paused'&&row.job_state==='paused'),'other unresolved calls are never automatically requeued');
    assert.equal((await pool.query('SELECT usage_status FROM bb_call_usage WHERE attempt_id=$1',[eligibleAttempt.attempt])).rows[0].usage_status,'unknown');
    await end(eligible.run_id);
    const isolated=await fixture({paid:true,error:localFailure});
    await pool.query(`UPDATE bb_credit_lots SET remaining=remaining-1 WHERE id=(SELECT id FROM bb_credit_lots WHERE owner_user_id=$1 AND remaining>frozen+1 LIMIT 1)`,[owner]);
    assert.equal((await inspectAndIsolateBillingScope(pool,{kind:'wallet',owner})).status,'isolated');
    assert.equal(await isolated.recover(),false);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[isolated.lease.jobId])).rows[0].n,1);
  }finally{await app.close();await paidApp.close();await pool.end();}
});
