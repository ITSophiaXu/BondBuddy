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
import { recordModelAttemptRuntime,recordProviderCallObservation,latestProviderAttempt,type ProviderCallObservation } from '@bondbuddy/api/provider-results';
import { WorkerRuntime } from './runtime.js';
import { isolatedTestDatabase } from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'file-authoring-payload');
test('file authoring 413 recovery preserves work, unknown usage and the original reservation while bounding retries',
  {skip:!connection,timeout:180000},async()=>{
  const pool=new Pool({connectionString:connection}),owner=`payload-${uid()}`,objects=new Map<string,Buffer>();
  const blobs:PrivateBlobs={put:async(k,b)=>{objects.set(k,b);},get:async k=>objects.get(k)!,getIfExists:async k=>objects.get(k)??null,
    getIfExistsBounded:async k=>objects.get(k)??null,exists:async k=>objects.has(k),delete:async k=>{objects.delete(k);}};
  const app=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true,historicalBillingFixture:true});
  const paidApp=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true,historicalBillingFixture:true,enablePaidAuthoring:true});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin:'http://bondbuddy.test'},payload:payload as any});
  type Options={paid?:boolean;runtime?:boolean;snapshot?:'none'|'bad';error?:string;observationError?:string;exit?:boolean;logical?:string;adapter?:string;conflict?:boolean};
  type Lease=NonNullable<Awaited<ReturnType<typeof claim>>>;
  async function observe(lease:Lease,project:string,inputHash:string,n:number,options:Options={}){
    const logical=options.logical??'file-authoring-v1',content=Buffer.from('synthetic file authoring prompt');
    const objectKey=`users/${owner}/projects/${project}/snapshots/${uid()}`;await blobs.put(objectKey,content,'text/plain');
    const prompt=await saveSnapshotRef(pool,{owner,projectId:project,runId:lease.runId,kind:'model_request',version:n,objectKey,sha256:digest(content),redactionVersion:'synthetic_v1',blobs});
    const attempt=await recordPotentialCall(pool,lease,logical,n,{modelId:'synthetic',promptSnapshotId:prompt});
    const intent={owner_user_id:owner,project_id:project,run_id:lease.runId,trace_id:lease.runId,job_id:lease.jobId,
      logical_call_id:logical,attempt_no:n,call_id:attempt,model_id:'synthetic',model_config_version:'synthetic-v1',prompt_snapshot_ref:prompt};
    if(options.runtime!==false)await recordModelAttemptRuntime(pool,lease,intent,{adapter:'codex_exec',adapter_version:options.adapter??'codex-file-authoring-2',
      model_provider:'deepseek',model_config_version:'synthetic-v1',provider_request_id_status:'unknown',framework_thread_id:null,
      started_at:new Date().toISOString(),duration_ms:1000,exit_code:options.exit===false?null:1,exit_signal:null,finish_reason:'turn_failed',
      error_code:options.error??'MODEL_PROVIDER_PAYLOAD_TOO_LARGE',tool_attempts:3,pricing_status:'unknown'});
    if(options.snapshot!=='none'){
      const bytes=Buffer.from(JSON.stringify({input_hash:inputHash})),sha256=digest(bytes),path='input.json';
      const key=`owners/${owner}/projects/${project}/runs/${lease.runId}/file-authoring/recovery/${attempt}/${sha256}/${path}`;
      await blobs.put(key,bytes,'application/json');
      await checkpointStage(pool,lease,'file_authoring_recovery',{version:'file-authoring-recovery-v1',input_hash:options.snapshot==='bad'?'bad':inputHash,
        attempt_id:attempt,logical_call_id:logical,files:[{path,key,sha256,byte_size:bytes.length}]},false);
    }
    const observation:ProviderCallObservation={...intent,provider_request_id:null,finish_reason:'turn_failed',outcome:'failed',
      usage:{status:'unknown',input_tokens:null,output_tokens:null,cached_input_tokens:null,reasoning_tokens:null,total_tokens:null},
      error_code:options.observationError??options.error??'MODEL_PROVIDER_PAYLOAD_TOO_LARGE',result_ref:null,result_sha256:null,result_schema_version:null,result_byte_size:null};
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
    await observe(next,f.project,f.inputHash,2);await new WorkerRuntime({pool,blobs}).sweep();
    next=await claim(pool,30);assert.ok(next);assert.equal(next.runId,f.lease.runId);
    const third=await observe(next,f.project,f.inputHash,3);assert.equal(await third.recover(),true);
    assert.equal((await row(f.lease.runId)).state,'failed');assert.equal(await third.recover(),false);
    assert.equal((await pool.query('SELECT payload FROM bb_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1',[f.lease.runId])).rows[0].payload.reason,'file_authoring_payload_retries_exhausted');
    for(const options of [{runtime:false},{error:'MODEL_TURN_FAILED'},{exit:false},{observationError:'MODEL_STREAM_BROKEN'},{conflict:true},
      {logical:'review-v1'},{adapter:'codex-file-authoring-1'},{error:'MODEL_PROVIDER_REQUEST_REJECTED'}] satisfies Options[]){
      const refused=await fixture(options);assert.equal(await refused.recover(),false,JSON.stringify(options));await end(refused.lease.runId);
    }
    for(const snapshot of ['none','bad'] as const){
      const unavailable=await fixture({snapshot});assert.equal(await unavailable.recover(),true);assert.equal((await row(unavailable.lease.runId)).state,'failed');
      assert.equal((await pool.query('SELECT payload FROM bb_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1',[unavailable.lease.runId])).rows[0].payload.reason,'file_authoring_payload_recovery_unavailable');
    }
    for(const flag of ['user_pause_requested','credit_pause_requested']){
      const paused=await fixture();
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
    const both=await fixture();await pool.query('UPDATE bb_jobs SET user_pause_requested=true,credit_pause_requested=true WHERE id=$1',[both.lease.jobId]);
    assert.equal(await both.recover(),true);assert.deepEqual(await row(both.lease.runId),{state:'paused',stage:'user_paused'});
    assert.equal(await resumePausedRun(pool,owner,both.lease.runId,'credits_recharged'),false,'recharge cannot override the user pause');await end(both.lease.runId);
    const cancelled=await fixture();await end(cancelled.lease.runId);assert.equal(await cancelled.recover(),false);
    const total=await fixture({logical:'file-authoring-size-repair-2'});
    const history=Object.fromEntries(Array.from({length:6},(_,n)=>[`prior-${n}`,{reason_code:'file_authoring_payload_auto_retry',logical_call_id:`file-authoring-size-repair-${n+10}`} ]));
    await pool.query("UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{operator_reconciliations}',$2::jsonb) WHERE id=$1",[total.lease.jobId,JSON.stringify(history)]);
    assert.equal(await total.recover(),true);assert.equal((await row(total.lease.runId)).state,'failed');
    await publishPrices(pool,{id:'synthetic-payload-prices',prices:INITIAL_FIXED_PRICES,effectiveAt:'2026-01-01T00:00:00Z',actor:'synthetic',reason:'Payload recovery billing regression'});
    await transaction(pool,c=>grantCredits(c,{owner,source:'existing_grant',key:uid(),points:1000000,expiresAt:null,actor:'synthetic',reason:'Synthetic recovery credits'}));
    const paid=await fixture({paid:true});
    const reservationBefore=(await pool.query('SELECT * FROM bb_credit_reservations WHERE run_id=$1',[paid.lease.runId])).rows;
    const eventsBefore=(await pool.query('SELECT * FROM bb_credit_events WHERE run_id=$1 ORDER BY id',[paid.lease.runId])).rows;
    const balanceBefore=await creditBalanceExact(pool,owner);
    assert.equal(await paid.recover(),true);
    assert.deepEqual((await pool.query('SELECT * FROM bb_credit_reservations WHERE run_id=$1',[paid.lease.runId])).rows,reservationBefore);
    assert.deepEqual((await pool.query('SELECT * FROM bb_credit_events WHERE run_id=$1 ORDER BY id',[paid.lease.runId])).rows,eventsBefore);
    assert.deepEqual(await creditBalanceExact(pool,owner),balanceBefore);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1',[paid.project])).rows[0].n,1);
    await end(paid.lease.runId);
    // Legacy unknown calls must not consume the dedicated HTTP-413 scan. A full
    // page of ineligible 413s must also yield to later candidates without changing
    // any evidence or updated_at just to influence queue ordering.
    const unknown=[];
    for(let n=0;n<21;n++)unknown.push(await fixture({error:'MODEL_TURN_FAILED'}));
    const prepared=[];
    for(let n=0;n<21;n++)prepared.push(await prepareFixture());
    prepared.sort((a,b)=>a.lease.jobId<b.lease.jobId?-1:1);
    const blocked=[];
    // Decide the exit evidence before recording the immutable runtime rows.
    for(const [n,p] of prepared.entries())blocked.push(await observe(p.lease,p.project,p.inputHash,1,{exit:n===20}));
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
  }finally{await app.close();await paidApp.close();await pool.end();}
});
