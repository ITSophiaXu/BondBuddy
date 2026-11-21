import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import {Value} from '@sinclair/typebox/value';
import { createServer } from '@bondbuddy/api';
import { digest,uid,transaction,type PrivateBlobs } from '@bondbuddy/api/data';
import { enqueue,claim,resumePausedRun,checkpointStage,pauseRun,recordPotentialCall,recordProviderReconcileUnknown,providerReconciliationCandidates } from '@bondbuddy/api/queue';
import { saveSnapshotRef } from '@bondbuddy/api/observability';
import { recordModelAttemptRuntime,recordProviderCallObservation } from '@bondbuddy/api/provider-results';
import { uploadSyntheticAudit,uploadSyntheticReference } from '@bondbuddy/api/test-authoring-source';
import { debitAuthoringCredits } from '../../api/dist/authoring-credit-debit.js';
import { grantCredits,publishPrices,creditBalanceExact } from '../../api/dist/billing.js';
import { emptyUpdateDetails,INITIAL_FIXED_PRICES,AuthoringWorkflowV1Schema,type AuthoringWorkflowV1 } from '@bondbuddy/contracts';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import { recordWorkerHeartbeat } from '@bondbuddy/api/trial-guard';
import { ProviderReconciliationSweep,reconcileProviderRun,providerReconciliationHealth } from './provider-reconcile-sweep.js';
import { OpsScheduler,tasksFromEnv } from './ops-scheduler.js';
import { isolatedTestDatabase } from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'issue1613');
test('provider reconciliation closes system failures independently of execution capacity (synthetic PostgreSQL)',{skip:!connection,timeout:120_000},async t=>{
  const pool=new Pool({connectionString:connection}),objects=new Map<string,Buffer>();
  let owner=`issue1613-${uid()}`;
  const blobs:PrivateBlobs={put:async(k,b)=>{objects.set(k,b);},get:async k=>objects.get(k)!,getIfExists:async k=>objects.get(k)??null,
    getIfExistsBounded:async k=>objects.get(k)??null,exists:async k=>objects.has(k),delete:async k=>{objects.delete(k);}};
  const app=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true,historicalBillingFixture:true});
  const paidApp=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true,historicalBillingFixture:true,enablePaidAuthoring:true});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin:'http://bondbuddy.test'},payload:payload as any});
  type Options={paid?:boolean;runtime?:boolean;exited?:boolean;kind?:'update'|'review'|'generation'|'qa';pauseOnly?:'user_paused'|'credits_exhausted'|'awaiting_materials';active?:boolean;deferPause?:boolean};
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
    if(options.active)return {lease,project,attempt:'',pause:undefined};
    if(options.pauseOnly){await pauseRun(pool,lease,options.pauseOnly,options.pauseOnly);return {lease,project,attempt:'',pause:undefined};}
    const content=Buffer.from('synthetic request'),objectKey=`users/${owner}/projects/${project}/snapshots/${uid()}`;await blobs.put(objectKey,content,'text/plain');
    const prompt=await saveSnapshotRef(pool,{owner,projectId:project,runId:lease.runId,kind:'model_request',version:1,objectKey,sha256:digest(content),redactionVersion:'synthetic_v1',blobs});
    const logical=kind==='update'?'file-authoring-v1':`synthetic-${kind}`;
    const attempt=await recordPotentialCall(pool,lease,logical,1,{modelId:'synthetic',promptSnapshotId:prompt});
    const intent={owner_user_id:owner,project_id:project,run_id:lease.runId,trace_id:lease.runId,job_id:lease.jobId,
      logical_call_id:logical,attempt_no:1,call_id:attempt,model_id:'synthetic',model_config_version:'synthetic-v1',prompt_snapshot_ref:prompt};
    const pause=async(runtime=options.runtime!==false)=>{
    if(runtime)await recordModelAttemptRuntime(pool,lease,intent,{adapter:'codex_exec',adapter_version:'codex-file-authoring-2',
      model_provider:'deepseek',model_config_version:'synthetic-v1',provider_request_id_status:'unknown',framework_thread_id:null,
      started_at:new Date().toISOString(),duration_ms:5400000,exit_code:null,exit_signal:options.exited===false?null:'SIGTERM',finish_reason:'timeout',
      error_code:'MODEL_TIMEOUT',tool_attempts:82,pricing_status:'unknown'});
    await recordProviderCallObservation(pool,blobs,{...intent,provider_request_id:null,finish_reason:'timeout',outcome:'pending_reconcile',
      usage:{status:'unknown',input_tokens:null,output_tokens:null,cached_input_tokens:null,reasoning_tokens:null,total_tokens:null},
      error_code:'MODEL_TIMEOUT',result_ref:null,result_sha256:null,result_schema_version:null,result_byte_size:null},()=>true,{lease,source:'provider'});
    };
    if(!options.deferPause)await pause();
    return {lease,project,attempt,pause};
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
    await t.test('27 legacy rows advance past the first 20 unknown results without replay or extending their pause deadline',async()=>{
      // This second 27-project cohort belongs to another legitimate synthetic
      // user, keeping both users within the unchanged upload admission quota.
      const originalOwner=owner;owner=`issue1613-page-${uid()}`;
      const fixtures=[];
      try{
      await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'r1613page_'+uid().slice(0,8)]);
      await transaction(pool,c=>grantCredits(c,{owner,source:'existing_grant',key:uid(),points:1000000,expiresAt:null,actor:'synthetic',reason:'Synthetic second pagination cohort'}));
      for(let i=0;i<27;i++)fixtures.push(await fixture({deferPause:true}));
      const ordered=fixtures.sort((a,b)=>a.lease.jobId.localeCompare(b.lease.jobId));
      // Complete real intent/runtime/observation writes while each synthetic
      // lease is still active. The first page deliberately lacks exit evidence;
      // the second page has the existing terminated legacy timeout evidence.
      for(let i=0;i<ordered.length;i++)await ordered[i]!.pause!(i>=20);
      const ids=ordered.map(f=>f.lease.jobId),visited:string[]=[];
      const observations=(await pool.query('SELECT to_jsonb(o) value FROM bb_provider_call_observations o WHERE attempt_id=ANY($1::text[]) ORDER BY attempt_id',
        [ordered.map(f=>f.attempt)])).rows;
      const sweep=new ProviderReconciliationSweep({pool,reconciler:{name:'codex_no_lookup',query:async a=>{visited.push(a.job_id);return {outcome:'unknown'};}}});
      assert.deepEqual(await sweep.run(),{scanned:20,progressed:0,errors:0});
      assert.deepEqual(visited,ids.slice(0,20));
      const firstPage=(await pool.query('SELECT id,checkpoint,state FROM bb_jobs WHERE id=ANY($1::text[]) ORDER BY id',[ids.slice(0,20)])).rows;
      assert.ok(firstPage.every(j=>j.state==='paused'&&j.checkpoint.provider_reconcile_unknown.queries===1));
      assert.ok(firstPage.every(j=>!j.checkpoint.workflow_v1&&!j.checkpoint.workflow_admission_v1),'these are actual legacy checkpoints, not protocol-1 admission fixtures');
      assert.deepEqual(await sweep.run(),{scanned:7,progressed:7,errors:0});
      assert.deepEqual(visited,ids,'every eligible row is visited once across the page boundary');
      assert.equal((await state(ordered[26]!.lease.runId)).state,'failed');
      assert.deepEqual(await sweep.run(),{scanned:0,progressed:0,errors:0},'cursor wrap respects persisted backoff');
      assert.deepEqual((await pool.query('SELECT id,checkpoint,state FROM bb_jobs WHERE id=ANY($1::text[]) ORDER BY id',[ids.slice(0,20)])).rows,firstPage);
      assert.deepEqual((await pool.query('SELECT to_jsonb(o) value FROM bb_provider_call_observations o WHERE attempt_id=ANY($1::text[]) ORDER BY attempt_id',
        [ordered.map(f=>f.attempt)])).rows,observations,'discovery and terminal policy never rewrite provider evidence');
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=ANY($1::text[])',[ids])).rows[0].n,27,'reconciliation does not create another model intent');
      }finally{for(const f of fixtures)await end(f.lease.runId);owner=originalOwner;}
    });
    await t.test('missing and JSON NULL legacy due fields are discovered; lazy backfill preserves the immutable pause anchor and future backoff',async()=>{
      for(const previous of [undefined,null,{queries:7,next_check_ms:null}] as const){
        const f=await fixture({runtime:false}),original=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[f.lease.jobId])).rows[0].checkpoint;
        if(previous!==undefined)await pool.query("UPDATE bb_jobs SET checkpoint=checkpoint||jsonb_build_object('provider_reconcile_unknown',$2::jsonb) WHERE id=$1",[f.lease.jobId,JSON.stringify(previous)]);
        const before=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[f.lease.jobId])).rows[0].checkpoint;
        const anchor=(await pool.query("SELECT occurred_at FROM bb_run_events WHERE run_id=$1 AND state='paused' AND stage='provider_reconcile' AND type='run.state_changed' ORDER BY seq DESC LIMIT 1",[f.lease.runId])).rows[0].occurred_at;
        for(let scan=0;scan<2;scan++)assert.ok((await providerReconciliationCandidates(pool,100)).some(r=>r.job_id===f.lease.jobId));
        assert.deepEqual((await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[f.lease.jobId])).rows[0].checkpoint,before,'read-only discovery does not manufacture a new due date');
        const now=Date.now();assert.equal(await recordProviderReconcileUnknown(pool,owner,f.lease.runId,f.lease.jobId,'codex_no_lookup',now),false);
        const backedOff=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[f.lease.jobId])).rows[0].checkpoint;
        assert.equal(backedOff.provider_reconcile_unknown.first_at,new Date(anchor).toISOString());
        assert.equal(backedOff.provider_reconcile_unknown.queries,previous&&'queries' in previous?8:1);
        assert.equal(backedOff.provider_reconcile_unknown.next_check_ms,now+60000);
        assert.deepEqual(backedOff.stages,original.stages,'legacy stage bytes survive lazy metadata backfill');
        for(let scan=0;scan<3;scan++)assert.equal((await providerReconciliationCandidates(pool,100)).some(r=>r.job_id===f.lease.jobId),false);
        assert.deepEqual((await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[f.lease.jobId])).rows[0].checkpoint,backedOff,'repeated discovery never resets the persisted retry interval');
        assert.deepEqual(await state(f.lease.runId),{state:'paused',stage:'provider_reconcile'});
        await end(f.lease.runId);
      }
    });
    await t.test('a future persisted workflow protocol is durably manual, preserves unknown evidence, and never queries or replays the model',async()=>{
      const f=await fixture({runtime:false});
      const inputHash=(await pool.query('SELECT input_hash FROM bb_runs WHERE id=$1',[f.lease.runId])).rows[0].input_hash.trim();
      const base={version:'authoring-plan-v1' as const,input_hash:inputHash,baseline_hash:null,material_snapshot_hash:'a'.repeat(64),knowledge_hash:'b'.repeat(64),
        chapters:[{chapter_id:'synthetic-chapter',order:0,title:'合成章节',required:true,depends_on:[],source_node_ids:[],evidence_refs:[],
          batches:[{batch_id:'synthetic-batch',order:0,allowed_node_ids:[],context_refs:[],output_contract:'document-projection-v1' as const}]}],
        limits:{call_ms:1000,repair_ms:1000,repair_revisions:2,context_records:1,context_chars:1,context_bytes:1,output_bytes:1}};
      const plan={...base,plan_hash:inputManifestHash(base)},v1:AuthoringWorkflowV1={protocol_version:1,input_hash:inputHash,plan_hash:plan.plan_hash,plan,
        phase:'authoring',next_cursor:{chapter:0,batch:0},completed:[],run_deadline_at:new Date(Date.now()+3600000).toISOString(),
        token_budget:{limit:100,used_known:0,unknown_calls:[]},repair_budget:{used_ms:0,used_revisions:0},phase_failures:{authoring:0,postprocess:0},handoff_id:null,postprocess_manifest:null};
      assert.equal(Value.Check(AuthoringWorkflowV1Schema,v1),true);
      const future={...v1,protocol_version:2};assert.equal(Value.Check(AuthoringWorkflowV1Schema,future),false,'only the supported protocol number changed');
      await pool.query("UPDATE bb_jobs SET checkpoint=checkpoint||jsonb_build_object('workflow_v1',$2::jsonb) WHERE id=$1",[f.lease.jobId,JSON.stringify(future)]);
      const evidence=async()=>(await pool.query('SELECT to_jsonb(a) value FROM bb_model_call_attempts a WHERE id=$1 UNION ALL SELECT to_jsonb(o) FROM bb_provider_call_observations o WHERE attempt_id=$1 UNION ALL SELECT to_jsonb(u) FROM bb_usage_observations u WHERE attempt_id=$1',[f.attempt])).rows;
      const before=await evidence();let queries=0;
      const sweep=new ProviderReconciliationSweep({pool,reconciler:{name:'codex_no_lookup',query:async()=>{queries++;return {outcome:'unknown'};}}});
      try{
        const outcome=await sweep.run(),checkpoint=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[f.lease.jobId])).rows[0].checkpoint;
        assert.equal(checkpoint.provider_reconcile_manual?.reason_code,'workflow_protocol_unsupported','unsupported workflow must have a durable manual disposition');
        assert.equal(checkpoint.provider_reconcile_manual.disposition,'manual_required');
        assert.ok(Number.isFinite(Date.parse(checkpoint.provider_reconcile_manual.last_checked_at)));
        assert.equal(outcome.scanned,1);assert.equal(outcome.errors,0);assert.equal(queries,0);
        assert.deepEqual(checkpoint.workflow_v1,future);assert.deepEqual(await evidence(),before);
        assert.deepEqual(await state(f.lease.runId),{state:'paused',stage:'provider_reconcile'});
        // Even an old writer's missing/NULL due field cannot readmit a durable
        // manual workflow to automatic reconciliation.
        await pool.query("UPDATE bb_jobs SET checkpoint=checkpoint||jsonb_build_object('provider_reconcile_unknown',jsonb_build_object('next_check_ms',null)) WHERE id=$1",[f.lease.jobId]);
        assert.equal((await providerReconciliationCandidates(pool,100)).some(r=>r.job_id===f.lease.jobId),false);
        assert.deepEqual(await sweep.run(),{scanned:0,progressed:0,errors:0});assert.equal(queries,0);
        const after=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[f.lease.jobId])).rows[0].checkpoint;
        assert.deepEqual(after.provider_reconcile_manual,checkpoint.provider_reconcile_manual,'manual scans do not reset the decision or its check time');
      }finally{await end(f.lease.runId);}
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
