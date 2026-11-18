import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { digest,uid,transaction,type PrivateBlobs } from '@bondbuddy/api/data';
import { enqueue,claim,resumePausedRun,checkpointStage,pauseRun,recordPotentialCall,recordProviderReconcileUnknown,providerReconciliationCandidates } from '@bondbuddy/api/queue';
import { saveSnapshotRef } from '@bondbuddy/api/observability';
import { recordModelAttemptRuntime,recordProviderCallObservation } from '@bondbuddy/api/provider-results';
import { uploadSyntheticAudit,uploadSyntheticReference } from '@bondbuddy/api/test-authoring-source';
import { debitAuthoringCredits } from '../../api/dist/authoring-credit-debit.js';
import { grantCredits,publishPrices,creditBalanceExact } from '../../api/dist/billing.js';
import { emptyUpdateDetails,INITIAL_FIXED_PRICES } from '@bondbuddy/contracts';
import { recordWorkerHeartbeat } from '@bondbuddy/api/trial-guard';
import { ProviderReconciliationSweep,reconcileProviderRun,providerReconciliationHealth } from './provider-reconcile-sweep.js';
import { OpsScheduler,tasksFromEnv } from './ops-scheduler.js';
import { isolatedTestDatabase } from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'issue1613');
test('provider reconciliation closes system failures independently of execution capacity (synthetic PostgreSQL)',{skip:!connection,timeout:120_000},async t=>{
  const pool=new Pool({connectionString:connection}),owner=`issue1613-${uid()}`,objects=new Map<string,Buffer>();
  const blobs:PrivateBlobs={put:async(k,b)=>{objects.set(k,b);},get:async k=>objects.get(k)!,getIfExists:async k=>objects.get(k)??null,
    getIfExistsBounded:async k=>objects.get(k)??null,exists:async k=>objects.has(k),delete:async k=>{objects.delete(k);}};
  const app=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true,historicalBillingFixture:true});
  const paidApp=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true,historicalBillingFixture:true,enablePaidAuthoring:true});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin:'http://bondbuddy.test'},payload:payload as any});
  type Options={paid?:boolean;runtime?:boolean;exited?:boolean;kind?:'update'|'review'|'generation'|'qa';pauseOnly?:'user_paused'|'credits_exhausted'|'awaiting_materials';active?:boolean};
  async function fixture(options:Options={}){
    const kind=options.kind??'update';
    const p=await send('POST','/api/v1/projects',{name:'Synthetic issue1613',kind:'update',issuer_name:'合成企业',market:'sse',offering:'private',
      update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1'}});
    assert.equal(p.statusCode,201,p.body);const project=p.json().project_id;
    const materials=await uploadSyntheticReference(app,project);
    const audit=await uploadSyntheticAudit(app,project);
    const input=await send('POST',`/api/v1/projects/${project}/input-revisions`,{...materials,material_versions:[...materials.material_versions,...(audit?[audit]:[])]});
    assert.equal(input.statusCode,201,input.body);
    let quote:string|undefined;
    if(options.paid){const q=await paidApp.inject({method:'POST',url:`/api/v1/projects/${project}/credit-quote`,headers:{origin:'http://bondbuddy.test'},payload:{input_revision:1,input_hash:input.json().input_hash}});
      assert.equal(q.statusCode,200,q.body);quote=q.json().quote.quote_id;}
    const request={execution_request_id:uid(),project_id:project,input_revision:1,input_hash:input.json().input_hash,task_kind:kind,
      input_manifest_ref:'synthetic',storage_origin:'cloud',workspace_id:'synthetic',...(quote?{quote_id:quote}:{})};
    let runId:string;
    if(kind==='update'){
      const started=options.paid?await paidApp.inject({method:'POST',url:'/api/v1/runs/execute',headers:{origin:'http://bondbuddy.test'},payload:request}):await send('POST','/api/v1/runs/execute',request);
      assert.equal(started.statusCode,202,started.body);runId=started.json().run_id;
    }else{
      // Queue-level synthetic records test the shared failure policy. They do not
      // claim to satisfy each product's separate execution/quote admission gate.
      runId=uid();
      await transaction(pool,async client=>{
        const r=(await client.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,
          execution_request_id,task_kind,request_hash,state,event_cursor,channel)
          VALUES($1,$2,$3,1,$4,$5,$6,$7,'queued',0,'production') RETURNING *`,
          [runId,owner,project,input.json().input_hash,request.execution_request_id,kind,digest(Buffer.from(JSON.stringify(request)))])).rows[0];
        await enqueue(client,r);
      });
    }
    const lease=await claim(pool,300);assert.ok(lease);assert.equal(lease.runId,runId);
    await checkpointStage(pool,lease,'materials_ready',{retained:'synthetic extraction'},false);
    if(options.active)return {lease,project,attempt:''};
    if(options.pauseOnly){await pauseRun(pool,lease,options.pauseOnly,options.pauseOnly);return {lease,project,attempt:''};}
    const content=Buffer.from('synthetic request'),objectKey=`users/${owner}/projects/${project}/snapshots/${uid()}`;await blobs.put(objectKey,content,'text/plain');
    const prompt=await saveSnapshotRef(pool,{owner,projectId:project,runId:lease.runId,kind:'model_request',version:1,objectKey,sha256:digest(content),redactionVersion:'synthetic_v1',blobs});
    const logical=kind==='update'?'file-authoring-v1':`synthetic-${kind}`;
    const attempt=await recordPotentialCall(pool,lease,logical,1,{modelId:'synthetic',promptSnapshotId:prompt});
    const intent={owner_user_id:owner,project_id:project,run_id:lease.runId,trace_id:lease.runId,job_id:lease.jobId,
      logical_call_id:logical,attempt_no:1,call_id:attempt,model_id:'synthetic',model_config_version:'synthetic-v1',prompt_snapshot_ref:prompt};
    if(options.runtime!==false)await recordModelAttemptRuntime(pool,lease,intent,{adapter:'codex_exec',adapter_version:'codex-file-authoring-2',
      model_provider:'deepseek',model_config_version:'synthetic-v1',provider_request_id_status:'unknown',framework_thread_id:null,
      started_at:new Date().toISOString(),duration_ms:5400000,exit_code:null,exit_signal:options.exited===false?null:'SIGTERM',finish_reason:'timeout',
      error_code:'MODEL_TIMEOUT',tool_attempts:82,pricing_status:'unknown'});
    await recordProviderCallObservation(pool,blobs,{...intent,provider_request_id:null,finish_reason:'timeout',outcome:'pending_reconcile',
      usage:{status:'unknown',input_tokens:null,output_tokens:null,cached_input_tokens:null,reasoning_tokens:null,total_tokens:null},
      error_code:'MODEL_TIMEOUT',result_ref:null,result_sha256:null,result_schema_version:null,result_byte_size:null},()=>true,{lease,source:'provider'});
    return {lease,project,attempt};
  }
  const state=async(run:string)=>(await pool.query('SELECT state,stage FROM bb_runs WHERE id=$1',[run])).rows[0];
  const end=async(run:string)=>{await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1 AND state NOT IN ('failed','cancelled')",[run]);};
  const reconcile=(f:Awaited<ReturnType<typeof fixture>>)=>reconcileProviderRun({pool},owner,f.lease.runId,f.lease.jobId);
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'r1613_'+uid().slice(0,8)]);
    await publishPrices(pool,{id:'synthetic-1613-price',prices:INITIAL_FIXED_PRICES,effectiveAt:'2026-01-01T00:00:00Z',actor:'synthetic',reason:'Synthetic recovery regression'});
    await transaction(pool,c=>grantCredits(c,{owner,source:'existing_grant',key:uid(),points:1000000,expiresAt:null,actor:'synthetic',reason:'Synthetic recovery regression'}));
    await t.test('legacy timeout with no file snapshot fails atomically, releases credits once and preserves every observation',async()=>{
      const available=(await creditBalanceExact(pool,owner)).available,f=await fixture({paid:true});
      const evidence=async()=>(await pool.query('SELECT to_jsonb(o) value FROM bb_provider_call_observations o WHERE attempt_id=$1 UNION ALL SELECT to_jsonb(u) FROM bb_usage_observations u WHERE attempt_id=$1',[f.attempt])).rows;
      await transaction(pool,async c=>{
        const r=(await c.query('SELECT * FROM bb_runs WHERE id=$1 FOR UPDATE',[f.lease.runId])).rows[0];
        await c.query('SELECT 1 FROM bb_jobs WHERE id=$1 FOR UPDATE',[f.lease.jobId]);
        const debit=await debitAuthoringCredits(c,r,100);assert.ok(debit);assert.equal(debit.charged,100n);
      });
      assert.equal((await creditBalanceExact(pool,owner)).available,available-100n);
      const before=await evidence(),checkpoint=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[f.lease.jobId])).rows[0].checkpoint;
      await pool.query(`ALTER TABLE bb_outbox ADD CONSTRAINT issue1613_rollback CHECK (aggregate_id <> '${f.lease.runId}') NOT VALID`);
      try{await assert.rejects(reconcile(f),/issue1613_rollback/);}finally{await pool.query('ALTER TABLE bb_outbox DROP CONSTRAINT issue1613_rollback');}
      assert.equal((await state(f.lease.runId)).state,'paused');
      assert.equal((await pool.query('SELECT state FROM bb_credit_reservations WHERE run_id=$1',[f.lease.runId])).rows[0].state,'held');
      assert.deepEqual((await Promise.all([reconcile(f),reconcile(f),reconcile(f)])).sort(),[false,false,true]);
      assert.deepEqual(await state(f.lease.runId),{state:'failed',stage:'failed'});
      assert.equal((await pool.query('SELECT state FROM bb_credit_reservations WHERE run_id=$1',[f.lease.runId])).rows[0].state,'released');
      assert.equal((await creditBalanceExact(pool,owner)).available,available);
      assert.deepEqual(await evidence(),before);
      assert.deepEqual((await pool.query('SELECT status,usage_status FROM bb_model_call_attempts WHERE id=$1',[f.attempt])).rows[0],{status:'pending_reconcile',usage_status:'unknown'});
      assert.deepEqual((await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[f.lease.jobId])).rows[0].checkpoint.stages,checkpoint.stages);
      assert.equal((await pool.query("SELECT count(*)::int n FROM bb_run_events WHERE run_id=$1 AND state='failed'",[f.lease.runId])).rows[0].n,1);
      assert.equal(await reconcile(f),false);
    });
    await t.test('27 old rows cannot block submission or starve the next page even when the first 20 throw',async()=>{
      const fixtures=[];for(let i=0;i<27;i++)fixtures.push(await fixture());
      const ordered=fixtures.sort((a,b)=>a.lease.jobId.localeCompare(b.lease.jobId));
      const fresh=await fixture({active:true});assert.equal((await state(fresh.lease.runId)).state,'running');await end(fresh.lease.runId);
      const blocked=new Set(ordered.slice(0,20).map(f=>f.lease.jobId));
      const sweep=new ProviderReconciliationSweep({pool,reconciler:{name:'codex_no_lookup',query:async a=>{
        if(blocked.has(a.job_id))throw Error('synthetic per-row failure');return {outcome:'unknown'};
      }}});
      assert.deepEqual(await sweep.run(),{scanned:20,progressed:0,errors:20});
      assert.deepEqual(await sweep.run(),{scanned:7,progressed:7,errors:0});
      assert.equal((await state(ordered[26]!.lease.runId)).state,'failed');
      for(const f of fixtures)await end(f.lease.runId);
    });
    await t.test('ambiguous calls back off and expire from pause time; old exhausted rows close with no worker or blob access',async()=>{
      const f=await fixture({runtime:false}),now=Date.now();assert.equal(await reconcile(f),false);
      assert.equal((await providerReconciliationCandidates(pool,100)).some(r=>r.run_id===f.lease.runId),false,'next-check prevents hot polling');
      assert.equal(await recordProviderReconcileUnknown(pool,owner,f.lease.runId,f.lease.jobId,'codex_no_lookup',now+3600001),true);
      const old=await fixture({runtime:false});
      await pool.query("UPDATE bb_jobs SET checkpoint=checkpoint||$2::jsonb WHERE id=$1",[old.lease.jobId,JSON.stringify({provider_reconcile_unknown:{first_at:new Date(now-7200000).toISOString(),exhausted:true}})]);
      const task=tasksFromEnv(pool,{BB_STORAGE_PURGE_ENABLED:'false'}).find(t=>t.name==='provider_reconcile');assert.ok(task);
      const logs:Record<string,unknown>[]=[];
      const schedulers=['one','two'].map(name=>new OpsScheduler({pool,tasks:[task],owner:'synthetic-1613-'+name,jitter:0,log:event=>logs.push(event)}));
      await Promise.all(schedulers.map(scheduler=>scheduler.tick()));
      assert.equal(logs.filter(event=>event.task==='provider_reconcile'&&event.progressed===1).length,1);
      assert.deepEqual((await pool.query("SELECT last_status,runs FROM bb_ops_schedule WHERE task='provider_reconcile'")).rows[0],{last_status:'succeeded',runs:'1'});
      assert.equal((await state(old.lease.runId)).state,'failed');
    });
    await t.test('user/material/credit pauses stay paused; inactive projects cannot restart',async()=>{
      for(const stage of ['user_paused','credits_exhausted','awaiting_materials'] as const){
        const f=await fixture({pauseOnly:stage});assert.equal(await reconcile(f),false);assert.equal((await state(f.lease.runId)).stage,stage);await end(f.lease.runId);
      }
      for(const flag of ['user_pause_requested','credit_pause_requested']){
        const f=await fixture();await pool.query(`UPDATE bb_jobs SET ${flag}=true WHERE id=$1`,[f.lease.jobId]);
        assert.equal(await reconcile(f),false);assert.equal((await state(f.lease.runId)).stage,flag==='user_pause_requested'?'user_paused':'credits_exhausted');await end(f.lease.runId);
      }
      for(const path of ['unknown','resume']){
        const cancelled=await fixture({paid:true});
        await transaction(pool,async c=>{
          const r=(await c.query('SELECT * FROM bb_runs WHERE id=$1 FOR UPDATE',[cancelled.lease.runId])).rows[0];
          await c.query('SELECT 1 FROM bb_jobs WHERE id=$1 FOR UPDATE',[cancelled.lease.jobId]);
          await debitAuthoringCredits(c,r,100);
        });
        const balance=await creditBalanceExact(pool,owner);
        await pool.query('UPDATE bb_jobs SET billing_cancel_requested_at=now() WHERE id=$1',[cancelled.lease.jobId]);
        assert.equal(await (path==='unknown'?reconcile(cancelled):resumePausedRun(pool,owner,cancelled.lease.runId,'provider_reconciled')),true);
        assert.deepEqual(await state(cancelled.lease.runId),{state:'cancelled',stage:'cancelled'});
        assert.deepEqual(await creditBalanceExact(pool,owner),balance,'explicit cancellation retains its original debit policy');
        assert.equal(await reconcile(cancelled),false);
      }
      const f=await fixture();await pool.query('UPDATE bb_projects SET archived_at=now() WHERE id=$1',[f.project]);
      assert.equal(await reconcile(f),true);assert.equal((await state(f.lease.runId)).state,'failed');
    });
    await t.test('the same terminal policy applies to review, generation and QA failures',async()=>{
      for(const kind of ['review','generation','qa'] as const){const f=await fixture({kind});assert.equal(await reconcile(f),true);assert.equal((await state(f.lease.runId)).state,'failed');}
    });
    await t.test('a healthy parser is not an authoring heartbeat and reconciliation exposes count and age',async()=>{
      const f=await fixture({runtime:false});
      await recordWorkerHeartbeat(pool,{workerId:'synthetic-parser',startedAt:new Date(),kinds:['parse'],concurrency:1});
      const health=await providerReconciliationHealth(pool);assert.equal(health.paused_count,1);assert.equal(health.worker_alive,0);assert.ok(health.oldest_paused_age_seconds>=0);
      await recordWorkerHeartbeat(pool,{workerId:'synthetic-authoring',startedAt:new Date(),kinds:['run'],concurrency:1});
      assert.equal((await providerReconciliationHealth(pool)).worker_alive,1);await end(f.lease.runId);
    });
  }finally{await app.close();await paidApp.close();await pool.end();}
});
