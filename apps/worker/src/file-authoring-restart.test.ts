import assert from 'node:assert/strict';
import test from 'node:test';
import { digest } from '@bondbuddy/api/data';
import type { StageContext } from './run-pipeline.js';
import { fileAuthoringRestartStageName } from './file-authoring-restart.js';

const base='file_authoring_v1',logical='file-authoring-v1',attempt='call-stopped';
const stage=`${base}_restart_${digest(attempt).slice(0,12)}`;
function fixture(){
  const audit={actor:'owner:owner',reason_code:'file_authoring_manual_restart',decision:'retry_unknown_usage',retry_mode:'restart_materials',
    recovery_state:'queued',attempt_id:attempt,logical_call_id:logical,request_id:'request',owner_user_id:'owner',project_id:'project',
    run_id:'run',job_id:'job',input_revision:'2',input_hash:'a'.repeat(64)};
  const checkpoint={operator_reconciliations:{[attempt]:audit},user_retry_requests:{request:{request_id:'request',attempt_id:attempt,mode:'restart_materials',confirmed_restart:true}},
    stages:{[`${base}_prompt`]:{snapshot_id:'old-prompt'}}};
  const prior:any={id:attempt,logical_call_id:logical,attempt_no:1,status:'failed',prompt_snapshot_id:'old-prompt',usage_status:'unknown',conflicting_measurements:0,
    adapter:'codex_exec',adapter_version:'codex-file-authoring-2',error_code:'MODEL_OUTPUT_TOO_LARGE',exit_code:null,exit_signal:'SIGKILL',
    checkpoint:structuredClone(checkpoint),has_result:false,newer_count:0};
  let queries=0;const rows:any[]=[prior];
  const ctx={run:{id:'run',owner_user_id:'owner',project_id:'project',input_revision:2,input_hash:'a'.repeat(64)},
    lease:{owner:'owner',jobId:'job',runId:'run',token:'lease',checkpoint},checkpoint:checkpoint.stages,
    pool:{query:async(sql:string,params:unknown[])=>{queries++;assert.match(sql,/j\.lease_until>now\(\)/);
      assert.deepEqual(params,['job','owner','run','lease','project',2,'a'.repeat(64)]);return {rows};}}} as unknown as StageContext;
  return {ctx,prior,rows,queries:()=>queries};
}

test('only an explicitly authorized legacy restart selects a new prompt stage',async()=>{
  const f=fixture(),before=structuredClone(f.ctx.lease.checkpoint);
  assert.equal(await fileAuthoringRestartStageName(f.ctx,base,logical),stage);
  assert.deepEqual(f.ctx.lease.checkpoint,before,'old prompt/audit evidence is preserved');
  assert.equal(f.ctx.checkpoint[`${base}_prompt`].snapshot_id,'old-prompt');
  assert.equal(await fileAuthoringRestartStageName(f.ctx,'file_authoring_size_repair_1','file-authoring-size-repair-1'),'file_authoring_size_repair_1');
  assert.equal(f.queries(),1);
  delete f.ctx.lease.checkpoint.operator_reconciliations;
  assert.equal(await fileAuthoringRestartStageName(f.ctx,base,logical),base);assert.equal(f.queries(),1);
});

test('restart authorization binds owner, task, input, confirmation and immutable ended attempt',async()=>{
  for(const field of ['actor','decision','retry_mode','recovery_state','attempt_id','logical_call_id','owner_user_id','project_id','run_id','job_id','input_revision','input_hash','request_id']){
    const f=fixture(),audit=(f.ctx.lease.checkpoint.operator_reconciliations as Record<string,any>)[attempt];
    audit[field]='foreign';f.prior.checkpoint.operator_reconciliations[attempt][field]='foreign';
    await assert.rejects(fileAuthoringRestartStageName(f.ctx,base,logical),/INPUT_REVISION_CONFLICT/,field);
  }
  for(const mutate of [
    (f:ReturnType<typeof fixture>)=>{f.prior.checkpoint.user_retry_requests.request.confirmed_restart=false;},
    (f:ReturnType<typeof fixture>)=>{f.prior.checkpoint.operator_reconciliations[attempt].request_id='different';},
    (f:ReturnType<typeof fixture>)=>{f.prior.exit_signal=null;},
    (f:ReturnType<typeof fixture>)=>{f.prior.error_code='MODEL_CANCELLED';},
    (f:ReturnType<typeof fixture>)=>{f.prior.adapter_version='codex-file-authoring-1';},
    (f:ReturnType<typeof fixture>)=>{f.prior.usage_status='measured';},
    (f:ReturnType<typeof fixture>)=>{f.prior.conflicting_measurements=1;},
    (f:ReturnType<typeof fixture>)=>{f.prior.has_result=true;},
    (f:ReturnType<typeof fixture>)=>{f.prior.status='pending_reconcile';},
    (f:ReturnType<typeof fixture>)=>{f.prior.checkpoint.stages.file_authoring_recovery=null;},
    (f:ReturnType<typeof fixture>)=>{f.rows.length=0;},
  ]){const f=fixture();mutate(f);await assert.rejects(fileAuthoringRestartStageName(f.ctx,base,logical),/INPUT_REVISION_CONFLICT/);}
});

test('the next attempt replays exactly the restart snapshot, never an old or unrelated prompt',async()=>{
  for(const status of ['pending_reconcile','completed']){
    const f=fixture();f.prior.newer_count=1;
    f.prior.checkpoint.stages[`${stage}_prompt`]={snapshot_id:'restart-prompt'};
    f.ctx.checkpoint[`${stage}_prompt`]={snapshot_id:'restart-prompt'};
    f.rows.unshift({id:'next',logical_call_id:logical,attempt_no:2,status,prompt_snapshot_id:'restart-prompt',has_result:status==='completed'});
    assert.equal(await fileAuthoringRestartStageName(f.ctx,base,logical),stage);
    f.rows[0].prompt_snapshot_id='old-prompt';
    await assert.rejects(fileAuthoringRestartStageName(f.ctx,base,logical),/INPUT_REVISION_CONFLICT/);
  }
  for(const patch of [{logical_call_id:'file-authoring-size-repair-1'},{attempt_no:3},{prompt_snapshot_id:'unrelated'}]){
    const f=fixture();f.prior.newer_count=1;f.prior.checkpoint.stages[`${stage}_prompt`]={snapshot_id:'restart-prompt'};
    f.ctx.checkpoint[`${stage}_prompt`]={snapshot_id:'restart-prompt'};
    f.rows.unshift({id:'next',logical_call_id:logical,attempt_no:2,prompt_snapshot_id:'restart-prompt',...patch});
    await assert.rejects(fileAuthoringRestartStageName(f.ctx,base,logical),/INPUT_REVISION_CONFLICT/);
  }
});

test('completed restart output replays through later repair attempts and their checkpoints without permitting another first-pass call',async()=>{
  const f=fixture();f.prior.newer_count=2;
  f.prior.checkpoint.stages[`${stage}_prompt`]={snapshot_id:'restart-prompt'};
  f.ctx.checkpoint[`${stage}_prompt`]={snapshot_id:'restart-prompt'};
  f.prior.checkpoint.stages.file_authoring_recovery={logical_call_id:'file-authoring-size-repair-1'};
  f.rows.unshift({id:'repair',logical_call_id:'file-authoring-size-repair-1',attempt_no:1,status:'pending_reconcile',prompt_snapshot_id:'repair-prompt'},
    {id:'next',logical_call_id:logical,attempt_no:2,status:'completed',prompt_snapshot_id:'restart-prompt',has_result:true});
  assert.equal(await fileAuthoringRestartStageName(f.ctx,base,logical),stage);
  f.rows[1].has_result=false;
  await assert.rejects(fileAuthoringRestartStageName(f.ctx,base,logical),/INPUT_REVISION_CONFLICT/);
  f.rows[1].has_result=true;f.rows.unshift({id:'unrelated',logical_call_id:logical,attempt_no:3,status:'pending_reconcile',prompt_snapshot_id:'unrelated'});
  await assert.rejects(fileAuthoringRestartStageName(f.ctx,base,logical),/INPUT_REVISION_CONFLICT/);
});

test('temporary database errors remain errors instead of becoming input conflicts',async()=>{
  const f=fixture();f.ctx.pool.query=async()=>{throw Error('temporary database unavailable');};
  await assert.rejects(fileAuthoringRestartStageName(f.ctx,base,logical),/temporary database unavailable/);
});

test('a completed manual then automatic retry chain replays its exact resume prompt after a later repair checkpoint',async()=>{
  for(const error of ['MODEL_OUTPUT_TOO_LARGE','MODEL_PROVIDER_PAYLOAD_TOO_LARGE','MODEL_TIMEOUT'])for(const ownerConfirmation of [undefined,false,true]){
    const f=fixture(),second='call-after-restart',resume=`${base}_resume_${digest(second).slice(0,12)}`;
    const retry:Record<string,unknown>={actor:'worker_file_authoring_recovery',reason_code:error==='MODEL_TIMEOUT'?'file_authoring_timeout_auto_retry':error==='MODEL_OUTPUT_TOO_LARGE'?'file_authoring_output_limit_auto_retry':'file_authoring_payload_auto_retry',
      attempt_id:second,logical_call_id:logical,decision:'retry_unknown_usage',recovery_state:'queued'};
    if(ownerConfirmation!==undefined){
      Object.assign(retry,{actor:'owner:owner',retry_mode:'restore_checkpoint',owner_user_id:'owner',project_id:'project',run_id:'run',job_id:'job',
        input_revision:'2',input_hash:'a'.repeat(64),request_id:'restore-request'});
      const request={request_id:'restore-request',attempt_id:second,mode:'restore_checkpoint',confirmed_restart:ownerConfirmation};
      (f.ctx.lease.checkpoint.user_retry_requests as Record<string,unknown>)['restore-request']=request;
      f.prior.checkpoint.user_retry_requests['restore-request']=structuredClone(request);
    }
    (f.ctx.lease.checkpoint.operator_reconciliations as Record<string,unknown>)[second]=retry;
    f.prior.checkpoint.operator_reconciliations[second]=structuredClone(retry);
    f.prior.newer_count=3;
    for(const [name,prompt] of [[stage,'restart-prompt'],[resume,'resume-prompt']]){
      f.prior.checkpoint.stages[`${name}_prompt`]={snapshot_id:prompt};f.ctx.checkpoint[`${name}_prompt`]={snapshot_id:prompt};
    }
    f.prior.checkpoint.stages.file_authoring_recovery={logical_call_id:'file-authoring-size-repair-1'};
    const afterRestart={...f.prior,id:second,attempt_no:2,prompt_snapshot_id:'restart-prompt',error_code:error,newer_count:2};
    const completed={id:'completed',logical_call_id:logical,attempt_no:3,status:'completed',prompt_snapshot_id:'resume-prompt',has_result:true};
    f.rows.unshift({id:'repair',logical_call_id:'file-authoring-size-repair-1',attempt_no:1,status:'pending_reconcile',prompt_snapshot_id:'repair-prompt'},completed,afterRestart);
    assert.equal(await fileAuthoringRestartStageName(f.ctx,base,logical),resume);
    assert.equal(f.ctx.checkpoint[`${base}_prompt`].snapshot_id,'old-prompt');
    if(ownerConfirmation!==undefined){
      f.prior.checkpoint.user_retry_requests['restore-request'].attempt_id='foreign';
      await assert.rejects(fileAuthoringRestartStageName(f.ctx,base,logical),/INPUT_REVISION_CONFLICT/);
      f.prior.checkpoint.user_retry_requests['restore-request'].attempt_id=second;
    }
    for(const field of ['actor','attempt_id','logical_call_id','decision','recovery_state','reason_code']){
      const before=retry[field as keyof typeof retry];(retry as Record<string,unknown>)[field]='unrelated';
      f.prior.checkpoint.operator_reconciliations[second][field]='unrelated';
      await assert.rejects(fileAuthoringRestartStageName(f.ctx,base,logical),/INPUT_REVISION_CONFLICT/,field);
      (retry as Record<string,unknown>)[field]=before;f.prior.checkpoint.operator_reconciliations[second][field]=before;
    }
    completed.prompt_snapshot_id='unrelated';await assert.rejects(fileAuthoringRestartStageName(f.ctx,base,logical),/INPUT_REVISION_CONFLICT/);completed.prompt_snapshot_id='resume-prompt';
    completed.has_result=false;await assert.rejects(fileAuthoringRestartStageName(f.ctx,base,logical),/INPUT_REVISION_CONFLICT/);completed.has_result=true;
    completed.status='pending_reconcile';await assert.rejects(fileAuthoringRestartStageName(f.ctx,base,logical),/INPUT_REVISION_CONFLICT/);completed.status='completed';
    f.rows.splice(f.rows.indexOf(completed),1);
    await assert.rejects(fileAuthoringRestartStageName(f.ctx,base,logical),/INPUT_REVISION_CONFLICT/,'old auto audit cannot authorize a fresh call without its workspace');
  }
});
