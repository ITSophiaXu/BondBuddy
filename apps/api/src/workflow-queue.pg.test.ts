import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {claim,pauseRun,resumePausedRun,completeManagedRunRelease,commitChapter,recordWorkflowRepair,recordWorkflowFailure,recordSealedCapture,registerRecoveredCaptureEvidence} from './queue.js';
import {digest} from './data.js';
import {configureExecutionCapacity,registerExecutionRuntime,heartbeatExecutionRuntime} from './execution-capacity.js';
import {inputManifestHash} from './production-rule-pin.js';
import {isolatedTestDatabase} from './test-database.js';
import type {AuthoringWorkflowV1,ChapterReceiptV1} from '@bondbuddy/contracts';

const connection=await isolatedTestDatabase(undefined,'workflow-queue');
const h='a'.repeat(64),owner='synthetic-workflow-owner';
// These are database/native-protocol fixtures; no cloud or provider is called.
test('workflow phase claiming and pause/resume safety',{skip:!connection},async t=>{
 const pool=new Pool({connectionString:connection}),worker=new Pool({connectionString:connection});
 t.after(async()=>{await worker.end();await pool.end();});
 t.afterEach(async()=>{await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE owner_user_id=$1 AND state<>'cancelled'",[owner]);});
 await configureExecutionCapacity(pool,0,{managed_nodes:true,global_model_limit:4,max_nodes:2,budget_available:true,workflow_slots_enabled:true});
 const nodeId=randomUUID(),epoch=randomUUID(),sessionId=randomUUID(),registration='synthetic-workflow-registration-token-0123456789';
 const identity={account_id:'synthetic',region:'synthetic',instance_id:'workflow-node',epoch};
 await pool.query(`INSERT INTO bb_execution_nodes(id,account_id,region,instance_id,epoch,state,source_sha256,image_sha256,launch_manifest_sha256,capabilities,expected_services,registration_token_sha256,cloud_start_operation_id)
  VALUES($1,$2,$3,$4,$5,'ready',$6,$6,$6,ARRAY['authoring','postprocess'],$7,$8,'synthetic-start')`,
  [nodeId,identity.account_id,identity.region,identity.instance_id,epoch,h,JSON.stringify([{service_id:'authoring',capabilities:['authoring'],workflow_protocol_version:1}]),inputManifestHash(registration)]);
 await registerExecutionRuntime(worker,{identity,session_id:sessionId},{service_id:'authoring',capabilities:['authoring'],source_sha256:h,image_sha256:h,launch_manifest_sha256:h,registration_token:registration,process_identity:{pid:'1',synthetic:'true'},workflow_protocol_version:1} as any);
 await heartbeatExecutionRuntime(worker,{native_processes:0,unpersisted_results:0,ready:true});
 const workflow=(hash:string,phase:'authoring'|'postprocess'):AuthoringWorkflowV1=>{
  const body={version:'authoring-plan-v1' as const,input_hash:hash,baseline_hash:null,material_snapshot_hash:h,knowledge_hash:h,
   chapters:[{chapter_id:'one',order:0,title:'Synthetic chapter',required:true,depends_on:[],source_node_ids:[],evidence_refs:[],batches:[{batch_id:'first',order:0,allowed_node_ids:[],context_refs:[],output_contract:'document-projection-v1' as const}]}],
   limits:{call_ms:1000,repair_ms:1000,repair_revisions:2,context_records:600,context_chars:18000,context_bytes:96000,output_bytes:98304}};
  const plan={...body,plan_hash:inputManifestHash(body)};
  return {protocol_version:1,input_hash:hash,plan_hash:plan.plan_hash,plan,phase,next_cursor:{chapter:0,batch:0},completed:[],run_deadline_at:new Date(Date.now()+60000).toISOString(),token_budget:{limit:10000,used_known:0,unknown_calls:[]},repair_budget:{used_ms:0,used_revisions:0},phase_failures:{authoring:0,postprocess:0},handoff_id:null,postprocess_manifest:null};
 };
 const add=async(phase:'authoring'|'postprocess',state='queued',reviewRevision=false)=>{
  const id=randomUUID(),manifest={synthetic:true,authoring:{version:'unified_v1',...(reviewRevision?{review_revision:{}}:{})}},hash=inputManifestHash(manifest);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'synthetic','generation')",[id,owner]);
  await pool.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,$4,'[]','[]')",[id,owner,hash,manifest]);
  await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage) VALUES($1,$2,$1,1,$3,$1,'generation',$3,$4,$5)",[id,owner,hash,state,state==='paused'?'capability_not_ready':'queued']);
  await pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,checkpoint) VALUES($1,$2,$1,'generation','default',$3,$4,$5)",[id,owner,state,state==='paused'?'capability_not_ready':'queued',{workflow_v1:workflow(hash,phase)}]);
  return id;
 };
 await t.test('authoring consumer cannot take a postprocess workflow',async()=>{
  const id=await add('postprocess');
  assert.equal(await claim(worker,30,{runKinds:['generation'],workflowPhase:'authoring'} as any),null);
  await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE id=$1",[id]);
 });
 await t.test('preparation admission survives a crash before workflow initialization',async()=>{
  const id=await add('authoring');await pool.query("UPDATE bb_jobs SET checkpoint='{}'::jsonb WHERE id=$1",[id]);
  const lease=await claim(worker,30,{runKinds:['generation'],workflowPhase:'authoring'});assert.ok(lease);
  assert.equal((lease.checkpoint.workflow_admission_v1 as any)?.protocol_version,1);
  await pool.query("UPDATE bb_jobs SET checkpoint=checkpoint||'{\"stages\":{\"workflow_budget_v1\":{\"run_deadline_at\":\"2026-12-01T00:00:00.000Z\"}}}'::jsonb,lease_until=now()-interval '1 second' WHERE id=$1",[id]);
  const proof={version:'task_cgroup_v1' as const,nativeProcesses:0 as const,activeExecutions:0 as const,jobId:id,token:lease.token,epoch,sessionId,cgroupIdentity:epoch+':1:1'};
  assert.equal(await completeManagedRunRelease(worker,lease,proof),'queued');
  assert.equal(await claim(worker,30,{runKinds:['generation']}),null);
  assert.equal((await claim(worker,30,{runKinds:['generation'],workflowPhase:'authoring'}))?.jobId,id);
  await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE id=$1",[id]);
 });
 await t.test('normal workflow pause retains its token until positive release',async()=>{
  const id=await add('authoring');
  const lease=await claim(worker,30,{runKinds:['generation'],workflowPhase:'authoring'} as any);assert.equal(lease?.jobId,id);
  await pauseRun(worker,lease!,'capability_not_ready','synthetic_missing_material');
  const row=(await pool.query('SELECT state,lease_token FROM bb_jobs WHERE id=$1',[id])).rows[0];
  assert.equal(row.lease_token,lease!.token);assert.equal(row.state,'running');
  assert.equal((await pool.query('SELECT execution_admission_phase FROM bb_jobs WHERE id=$1',[id])).rows[0].execution_admission_phase,'authoring');
  await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[id]);
  const proof={version:'task_cgroup_v1' as const,nativeProcesses:0 as const,activeExecutions:0 as const,jobId:id,token:lease!.token,epoch,sessionId,cgroupIdentity:epoch+':1:1'};
  await assert.rejects(completeManagedRunRelease(worker,lease!,{...proof,sessionId:randomUUID()}),/SCOPE_MISMATCH/);
  assert.equal(await completeManagedRunRelease(worker,lease!,proof),'paused');
  const released=(await pool.query('SELECT lease_token,execution_admission_phase,checkpoint FROM bb_jobs WHERE id=$1',[id])).rows[0];
  assert.equal(released.lease_token,null);assert.equal(released.execution_admission_phase,null);assert.equal(released.checkpoint.positive_release_v1.session_id,sessionId);
  assert.deepEqual((await Promise.all([resumePausedRun(worker,owner,id,'materials_ready',{blobs:{getIfExistsBounded:async()=>null} as any}),resumePausedRun(worker,owner,id,'materials_ready',{blobs:{getIfExistsBounded:async()=>null} as any})])).sort(),[false,true]);
  await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE id=$1",[id]);
 });
 await t.test('old SQL and wrong phase capability cannot bypass the workflow gate',async()=>{
  const id=await add('authoring');
  await assert.rejects(claim(worker,30,{runKinds:['generation'],workflowPhase:'postprocess'}),/phase capability mismatch/);
  assert.equal(await claim(worker,30,{runKinds:['generation']}),null);
  const client=await worker.connect();try{await client.query('BEGIN');
   await client.query("SELECT set_config('bb.execution_node_id',$1,true),set_config('bb.execution_node_epoch',$2,true),set_config('bb.execution_session_id',$3,true)",[nodeId,epoch,sessionId]);
   await assert.rejects(client.query("UPDATE bb_jobs SET lease_token=$2,state='running',lease_until=now()+interval '30 seconds' WHERE id=$1",[id,randomUUID()]),/workflow phase mismatch/);
  }finally{await client.query('ROLLBACK');client.release();}
  await pool.query("UPDATE bb_jobs SET state='cancelled' WHERE id=$1",[id]);
 });
 await t.test('absence of a token is not a workflow termination receipt',async()=>{
  const id=await add('authoring','paused');
  assert.equal(await resumePausedRun(pool,owner,id,'materials_ready'),false);
  assert.equal((await pool.query('SELECT state FROM bb_jobs WHERE id=$1',[id])).rows[0].state,'paused');
  for(const reason of ['materials_ready','provider_reconciled','trial_limit_cleared','credits_recharged','billing_reconciled'] as const)
   assert.equal(await resumePausedRun(pool,owner,id,reason,{blobs:{getIfExistsBounded:async()=>null} as any}),false,reason);
  await pool.query("UPDATE bb_jobs SET state='cancelled' WHERE id=$1",[id]);
 });
 await t.test('immutable occupied phase survives a checkpoint handoff; budgets do not reset',async()=>{
  const id=await add('authoring'),lease=await claim(worker,30,{runKinds:['generation'],workflowPhase:'authoring'});assert.ok(lease);
  const reserve={kind:'reserve_revision' as const,repairKey:'workflow_repair_0_0',logicalCallId:'synthetic-repair-one',expectedRevision:0,revision:1,deadlineAt:new Date(Date.now()+900).toISOString(),failureCode:'WORD_EDIT_ANCHOR_MISMATCH'};
  await recordWorkflowRepair(worker,lease,reserve);await recordWorkflowRepair(worker,lease,reserve);
  assert.equal((lease.checkpoint.workflow_v1 as AuthoringWorkflowV1).repair_budget.used_revisions,1);
  assert.equal((lease.checkpoint.stages as any).workflow_repair_0_0.deadline_at,reserve.deadlineAt);
  const recoveredLease:typeof lease={...lease,checkpoint:{}};
  await recordWorkflowRepair(worker,recoveredLease,reserve);
  assert.equal((recoveredLease.checkpoint.stages as any)?.workflow_repair_0_0.deadline_at,reserve.deadlineAt);
  await recordWorkflowRepair(worker,lease,{kind:'record_elapsed',logicalCallId:reserve.logicalCallId,elapsedMs:100});
  await recordWorkflowRepair(worker,lease,{kind:'record_elapsed',logicalCallId:reserve.logicalCallId,elapsedMs:100});
  await recordWorkflowRepair(worker,lease,{kind:'record_elapsed',logicalCallId:reserve.logicalCallId,elapsedMs:300});
  assert.equal((lease.checkpoint.workflow_v1 as AuthoringWorkflowV1).repair_budget.used_ms,300);
  const elapsedReplay:typeof lease={...lease,checkpoint:{}};
  await recordWorkflowRepair(worker,elapsedReplay,{kind:'record_elapsed',logicalCallId:reserve.logicalCallId,elapsedMs:300});
  assert.equal((elapsedReplay.checkpoint.workflow_v1 as AuthoringWorkflowV1)?.repair_budget.used_ms,300);
  await pool.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status) VALUES($1,$2,$3,'synthetic-repair-no-runtime',1,'pending_reconcile')",[randomUUID(),owner,id]);
  await assert.rejects(recordWorkflowRepair(worker,lease,{kind:'record_elapsed',logicalCallId:'synthetic-repair-no-runtime',elapsedMs:1}),/runtime is unavailable/);
  assert.deepEqual(await recordWorkflowFailure(worker,lease,'authoring'),{failures:1,exhausted:false});
  await assert.rejects(recordWorkflowRepair(worker,lease,{kind:'record_elapsed',logicalCallId:reserve.logicalCallId,elapsedMs:1001}),/exhausted/);
  await recordWorkflowRepair(worker,lease,{kind:'record_elapsed',logicalCallId:reserve.logicalCallId,elapsedMs:1000});
  await assert.rejects(recordWorkflowRepair(worker,lease,{...reserve,logicalCallId:'synthetic-repair-spent',expectedRevision:1,revision:2}),/budget exhausted/);
  await pool.query("UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{workflow_v1,phase}','\"postprocess\"'::jsonb) WHERE id=$1",[id]);
  const occupied=(await pool.query('SELECT execution_admission_phase FROM bb_jobs WHERE id=$1',[id])).rows[0];assert.equal(occupied.execution_admission_phase,'authoring');
  await assert.rejects(pool.query("UPDATE bb_jobs SET execution_admission_phase='postprocess' WHERE id=$1",[id]),/immutable/);
  const fresh=await add('authoring');await assert.rejects(claim(worker,30,{runKinds:['generation'],workflowPhase:'authoring'}),/slots full/);
  await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE id=ANY($1::text[])",[[id,fresh]]);
 });
 await t.test('chapter commit is idempotent but cannot accept another hash or stale token',async()=>{
  const id=await add('authoring'),lease=await claim(worker,30,{runKinds:['generation'],workflowPhase:'authoring'});assert.ok(lease);
  const w=lease.checkpoint.workflow_v1 as AuthoringWorkflowV1;
  const receipt:ChapterReceiptV1={version:'chapter-receipt-v1',run_id:id,job_id:id,input_hash:w.input_hash,plan_hash:w.plan_hash,chapter_id:'one',batch_id:'first',logical_call_id:'synthetic-chapter-call',execution_generation:1,call_status:'completed',object:{key:`users/${owner}/projects/${id}/chapters/one.json`,sha256:h,byte_size:1},projection_version:0,operations_sha256:null,accepted_op_receipts:[],validation:{schema_version:'document-projection-v1',range_verified:true,structure_verified:true,evidence_refs_valid:true},created_at:new Date().toISOString()};
  await pool.query("UPDATE bb_jobs SET checkpoint=jsonb_set(jsonb_set(checkpoint,'{workflow_v1,completed}',$2::jsonb),'{workflow_v1,next_cursor}','{\"chapter\":1,\"batch\":0}'::jsonb) WHERE id=$1",[id,JSON.stringify([receipt])]);
  assert.equal((await commitChapter(worker,lease,{chapter:0,batch:0},receipt)).completed.length,1);
  await assert.rejects(commitChapter(worker,lease,{chapter:0,batch:0},{...receipt,object:{...receipt.object,sha256:'b'.repeat(64)}}),/CHAPTER_RECEIPT_CONFLICT/);
  await assert.rejects(commitChapter(worker,{...lease,token:randomUUID()},{chapter:0,batch:0},receipt),/Lease is no longer active/);
  await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE id=$1",[id]);
 });
 await t.test('repair revisions are bounded per batch and cumulative audit survives the next batch',async()=>{
  const id=await add('authoring'),lease=await claim(worker,30,{runKinds:['generation'],workflowPhase:'authoring'});assert.ok(lease);
  const w=lease.checkpoint.workflow_v1 as AuthoringWorkflowV1,{plan_hash:_,...body}=w.plan;
  body.limits={...body.limits,repair_ms:10000};body.chapters=[{...body.chapters[0]!,batches:[body.chapters[0]!.batches[0]!,{...body.chapters[0]!.batches[0]!,batch_id:'second',order:1}]}];
  w.plan={...body,plan_hash:inputManifestHash(body)};w.plan_hash=w.plan.plan_hash;
  await pool.query("UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{workflow_v1}',$2::jsonb) WHERE id=$1",[id,JSON.stringify(w)]);
  const deadlineAt=new Date(Date.now()+9500).toISOString(),base={kind:'reserve_revision' as const,repairKey:'workflow_repair_0_0',deadlineAt,failureCode:'WORD_EDIT_ANCHOR_MISMATCH'};
  await recordWorkflowRepair(worker,lease,{...base,logicalCallId:'repair-first-1',expectedRevision:0,revision:1});
  await recordWorkflowRepair(worker,lease,{...base,logicalCallId:'repair-first-2',expectedRevision:1,revision:2});
  await assert.rejects(recordWorkflowRepair(worker,lease,{...base,logicalCallId:'repair-first-3',expectedRevision:2,revision:3}),/budget exhausted/);
  await pool.query("UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{workflow_v1,next_cursor}','{\"chapter\":0,\"batch\":1}'::jsonb) WHERE id=$1",[id]);
  await recordWorkflowRepair(worker,lease,{...base,repairKey:'workflow_repair_0_1',logicalCallId:'repair-second-1',expectedRevision:0,revision:1});
  assert.equal((lease.checkpoint.workflow_v1 as AuthoringWorkflowV1).repair_budget.used_revisions,3);
 });
 await t.test('legacy QA and accepted review revision retry without inheriting workflow preparation',async()=>{
  for(const mode of ['qa','review_revision'] as const){
    const id=await add('authoring','queued',mode==='review_revision');
    await pool.query("UPDATE bb_jobs SET checkpoint='{}'::jsonb,job_type=$2,subtype=$3 WHERE id=$1",[id,mode==='qa'?'qa':'update',mode==='qa'?'project_qa_v1':'update_pipeline_v1']);
    await pool.query('UPDATE bb_runs SET task_kind=$2 WHERE id=$1',[id,mode==='qa'?'qa':'update']);
    const lease=await claim(worker,30,{runKinds:['qa','update'],workflowPhase:'authoring'});assert.ok(lease);assert.equal(lease.jobId,id);assert.equal(lease.checkpoint.workflow_admission_v1,undefined);
    assert.equal((await pool.query('SELECT execution_admission_phase FROM bb_jobs WHERE id=$1',[id])).rows[0].execution_admission_phase,'legacy');
    await pool.query("UPDATE bb_jobs SET checkpoint=jsonb_build_object('stages',jsonb_build_object($2::text,'{}'::jsonb)),lease_until=now()-interval '1 second' WHERE id=$1",[id,mode==='qa'?'project_qa_prompt':'review_revision_cli_prompt']);
    assert.equal(await completeManagedRunRelease(worker,lease,{version:'task_cgroup_v1',nativeProcesses:0,activeExecutions:0,jobId:id,token:lease.token,epoch,sessionId,cgroupIdentity:epoch+':1:1'}),'queued');
    assert.equal((await claim(worker,30,{runKinds:['qa','update'],workflowPhase:'authoring'}))?.jobId,id);
    await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE id=$1",[id]);
  }
 });
 await t.test('sealed and recovered captures bind the original attempt without completing provider accounting',async()=>{
  const id=await add('authoring'),lease=await claim(worker,30,{runKinds:['generation'],workflowPhase:'authoring'});assert.ok(lease);
  const attemptId=randomUUID(),logicalCallId='synthetic-sealed-call';
  await pool.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status) VALUES($1,$2,$3,$4,1,'pending_reconcile')",[attemptId,owner,id,logicalCallId]);
  const originalExecution={nodeId,epoch,sessionId};
  const callExitProof={version:'call_cgroup_v1' as const,key:h,identity:epoch+':2:2',parentKey:digest(Buffer.from(JSON.stringify({kind:'job',id,token:lease.token}))),parentIdentity:epoch+':1:1',logicalCallId,generation:1,epoch,sessionId,sealed:true as const,nativeProcesses:0 as const};
  const input={attemptId,logicalCallId,attemptNo:1,originalExecution,spoolId:'synthetic-spool',localManifestSha256:h,callExitProof,rawUsage:{status:'unknown'},rawOutcome:'timeout'};
  await assert.rejects(recordSealedCapture(worker,lease,input),/immutable original attempt/);
  await pool.query(`INSERT INTO bb_model_attempt_execution_configs(attempt_id,owner_user_id,project_id,run_id,job_id,logical_call_id,attempt_no,execution_session_id,execution_node_epoch,effective_timeout_ms,timeout_deadline_at,timeout_source,timeout_branch,model_config_version,loaded_adapter_sha256,selected_config_sha256)
   VALUES($1,$2,$3,$3,$3,$4,1,$5,$6,1000,now()+interval '1 second','default','ordinary','synthetic',$7,$7)`,[attemptId,owner,id,logicalCallId,sessionId,epoch,h]);
  const first=await recordSealedCapture(worker,lease,input);assert.equal(first.idempotent,false);
  assert.deepEqual(await recordSealedCapture(worker,lease,input),{id:first.id,idempotent:true});
  await assert.rejects(recordSealedCapture(worker,lease,{...input,localManifestSha256:'b'.repeat(64)}),/evidence changed/);
  await assert.rejects(recordSealedCapture(worker,lease,{...input,originalExecution:{...originalExecution,sessionId:randomUUID()}}),/exact sealed call proof/);
  const bytes=Buffer.from(JSON.stringify({synthetic:true,attemptId})),sha=digest(bytes),capture={key:`users/${owner}/projects/${id}/recovered-captures/${attemptId}-${sha}.json`,sha256:sha,byteSize:bytes.length};
  const recovered={ownerUserId:owner,projectId:id,runId:id,jobId:id,attemptId,logicalCallId,attemptNo:1,originalExecution,capture,manifestSha256:h};
  await assert.rejects(registerRecoveredCaptureEvidence(worker,recovered,{blobs:{getIfExistsBounded:async()=>null} as any}),/missing or changed/);
  const recovery=await registerRecoveredCaptureEvidence(worker,recovered,{blobs:{getIfExistsBounded:async()=>bytes} as any});assert.equal(recovery.idempotent,false);
  assert.equal((await pool.query('SELECT status FROM bb_model_call_attempts WHERE id=$1',[attemptId])).rows[0].status,'pending_reconcile');
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_provider_result_refs WHERE attempt_id=$1',[attemptId])).rows[0].n,0);
  await assert.rejects(pool.query("UPDATE bb_sealed_model_captures SET raw_outcome='{}' WHERE attempt_id=$1",[attemptId]),/immutable|snapshot/i);
  await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE id=$1",[id]);
 });
});
