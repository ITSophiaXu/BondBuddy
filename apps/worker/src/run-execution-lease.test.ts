// Synthetic DB responses exercise the real independent-writer lock helper.
// PostgreSQL lock scheduling and actual writes are covered by the PG suites.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { projectRunExecution, runExecutionOrigin, type RunExecutionIdentity } from '@bondbuddy/api/run-execution';
import type { Lease } from '@bondbuddy/api/queue';
import type { StageContext } from './run-pipeline.js';
import { lockStageRunExecution } from './run-execution-lease.js';

const conflict=(error:unknown)=>(error as {code?:string}).code==='INPUT_REVISION_CONFLICT';
const identity:RunExecutionIdentity={executionVersion:1,inputRevision:7,inputHash:'a'.repeat(64)};

function fixture(){
  const raw={id:'synthetic-run',owner_user_id:'synthetic-owner',project_id:'synthetic-project',
    input_revision:7,input_hash:'a'.repeat(64),task_kind:'update',state:'running',
    billing_mode:'fixed_credits' as const,test_grant_id:'original-grant',execution_request_id:'original-request'};
  const state={run:structuredClone(raw) as typeof raw|null,job:true,versions:[{execution_version:1,input_revision:7,input_hash:raw.input_hash}]};
  const reads:Array<{kind:'run'|'job'|'execution';args:unknown[]|undefined}>=[];
  const client={query:async(sql:string,args?:unknown[])=>{
    if(sql.includes('FROM bb_runs r')){
      assert.match(sql,/FOR UPDATE/);reads.push({kind:'run',args});
      return {rows:state.run?[structuredClone(state.run)]:[]};
    }
    if(sql.includes('FROM bb_jobs')){
      assert.match(sql,/FOR UPDATE/);assert.match(sql,/lease_until>clock_timestamp\(\)/);
      reads.push({kind:'job',args});return {rows:state.job?[{id:'synthetic-job'}]:[]};
    }
    if(sql.includes('FROM bb_run_execution_versions')){
      reads.push({kind:'execution',args});return {rows:structuredClone(state.versions)};
    }
    throw Error('Independent writer attempted an unexpected query or mutation');
  }} as unknown as PoolClient;
  const lease:Lease={...identity,jobId:'synthetic-job',runId:raw.id,owner:raw.owner_user_id,token:'synthetic-lease',
    checkpoint:{},attempts:1};
  const ctx:Pick<StageContext,'run'|'lease'>={run:projectRunExecution({...raw,billing_mode:'platform_trial' as const},identity),lease};
  return {raw,state,client,ctx,reads};
}

test('independent writer locks a fresh raw run and job before resolving and returning its execution projection',async()=>{
  const f=fixture(),before=structuredClone(f.state),locked=await lockStageRunExecution(f.client,f.ctx);
  assert.ok(locked);
  assert.deepEqual(f.reads.map(read=>read.kind),['run','job','execution']);
  assert.deepEqual(f.reads[0].args,[f.ctx.lease.runId,f.ctx.lease.owner]);
  assert.deepEqual(f.reads[1].args,[f.ctx.lease.jobId,f.ctx.lease.owner,f.ctx.lease.runId,f.ctx.lease.token]);
  assert.equal(locked.billing_mode,'fixed_credits','return reloaded metadata, not the stale stage context');
  assert.deepEqual(locked.originInput,{inputRevision:7,inputHash:identity.inputHash});
  assert.deepEqual({executionVersion:locked.executionVersion,inputRevision:locked.inputRevision,inputHash:locked.inputHash},identity);
  assert.equal(locked.input_revision,identity.inputRevision);assert.equal(locked.input_hash,identity.inputHash);
  assert.deepEqual(runExecutionOrigin(locked),{id:f.raw.id,owner_user_id:f.raw.owner_user_id,project_id:f.raw.project_id,
    input_revision:f.raw.input_revision,input_hash:f.raw.input_hash});
  assert.deepEqual(f.state,before,'resolving write authority alone does not mutate any persisted state');
});

test('independent writer refuses foreign lease scope before querying and missing run or job before further work',async()=>{
  for(const field of ['runId','owner'] as const){
    const f=fixture();f.ctx.lease[field]='foreign';
    assert.equal(await lockStageRunExecution(f.client,f.ctx),null);assert.deepEqual(f.reads,[]);
  }
  const absentRun=fixture();absentRun.state.run=null;
  assert.equal(await lockStageRunExecution(absentRun.client,absentRun.ctx),null);
  assert.deepEqual(absentRun.reads.map(read=>read.kind),['run']);
  const absentJob=fixture();absentJob.state.job=false;
  assert.equal(await lockStageRunExecution(absentJob.client,absentJob.ctx),null);
  assert.deepEqual(absentJob.reads.map(read=>read.kind),['run','job']);
});

test('independent writer rejects a stale original input even when its active aliases still match the current lease',async()=>{
  const f=fixture(),before=structuredClone(f.state);
  f.ctx.run=projectRunExecution({...f.raw,input_revision:6,input_hash:'b'.repeat(64)},identity);
  assert.equal(f.ctx.run.input_revision,identity.inputRevision);
  assert.equal(f.ctx.run.input_hash,identity.inputHash);
  assert.equal(await lockStageRunExecution(f.client,f.ctx),null);
  assert.deepEqual(f.state,before);
});

test('independent writer rejects another execution projection and freshly changed project or run state',async()=>{
  for(const active of [{...identity,inputRevision:8},{...identity,inputHash:'b'.repeat(64)},
    {...identity,executionVersion:2}]){
    const f=fixture(),before=structuredClone(f.state);f.ctx.run=projectRunExecution(f.raw,active);
    assert.equal(await lockStageRunExecution(f.client,f.ctx),null);assert.deepEqual(f.state,before);
  }
  for(const change of ['project','state'] as const){
    const f=fixture();assert.ok(f.state.run);
    if(change==='project')f.state.run.project_id='another-project';else f.state.run.state='paused';
    const before=structuredClone(f.state);
    assert.equal(await lockStageRunExecution(f.client,f.ctx),null);assert.deepEqual(f.state,before);
  }
});

test('independent writer does not accept a serialized stage projection or inconsistent input aliases',async()=>{
  for(const change of ['serialized','snake','camel'] as const){
    const f=fixture(),before=structuredClone(f.state);
    const forged=JSON.parse(JSON.stringify(f.ctx.run));
    if(change==='snake')forged.input_revision=8;
    if(change==='camel')forged.inputHash='b'.repeat(64);
    f.ctx.run=forged;
    await assert.rejects(lockStageRunExecution(f.client,f.ctx),conflict);
    assert.deepEqual(f.state,before);
  }
});

test('independent writer rechecks persisted authority and fences wrong leases without repairing their identity',async()=>{
  for(const change of ['missing','version','revision','hash'] as const){
    const f=fixture();
    if(change==='missing')f.state.versions=[];
    else if(change==='version')f.state.versions[0].execution_version=2;
    else if(change==='revision')f.state.versions[0].input_revision=8;
    else f.state.versions[0].input_hash='b'.repeat(64);
    const before=structuredClone(f.state);
    await assert.rejects(lockStageRunExecution(f.client,f.ctx),conflict);assert.deepEqual(f.state,before);
  }
  for(const lease of [{...identity,inputRevision:8},{...identity,inputHash:'b'.repeat(64)},
    {...identity,executionVersion:2}]){
    const f=fixture(),before=structuredClone(f.state);Object.assign(f.ctx.lease,lease);
    await assert.rejects(lockStageRunExecution(f.client,f.ctx),conflict);assert.deepEqual(f.state,before);
  }
});
