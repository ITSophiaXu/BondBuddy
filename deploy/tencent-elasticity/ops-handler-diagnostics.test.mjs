import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createExecutionPoolOpsHandler} from './ops-handler.mjs';
import {validateConfig} from './policy.mjs';

const config=JSON.parse(await readFile(new URL('./pool.example.json',import.meta.url),'utf8'));
const operationId='aac1586d-6381-47b7-8ba2-6355449f9037',epoch='6f195681-f1aa-48ce-a1a7-2d587b873b91';
const identity={account_id:'123456',region:config.region,instance_id:'ins-test1',epoch};
const state=()=>({policy:{revision:1,managed_nodes:true,budget_available:true,node_model_limit:4,global_model_limit:4,max_nodes:2,expense_policy_sha256:config.expense_policy_sha256},nodes:[],groups:[],pending_cloud_reservations:0,active_model_calls:0,effective_queued_work:0});
const configured=()=>({...config,account_id:'123456',enabled:true,cloud_quote_refresh:undefined});
validateConfig(configured());

function assertDiagnostic(event,stage,code){
  assert.ok(event,'failure event must exist');
  assert.equal(event.stage,stage);
  assert.equal(event.error_code,code);
  assert.match(event.tick_id,/^[a-f0-9-]{36}$/);
  assert.ok(Number.isFinite(event.elapsed_ms)&&event.elapsed_ms>=0);
}

test('config read failures retain a safe code and stage without changing admission fencing',async()=>{
  const logs=[];let fenced=0;
  const handler=createExecutionPoolOpsHandler({configPath:'/private/config.json',log:x=>logs.push(x),
    control:{snapshot:async()=>state(),setAdmissionBudget:async(_,available)=>{assert.equal(available,false);fenced++;}},
    dependencies:{readConfig:async()=>{throw Object.assign(Error('secret contents must stay private'),{code:'ENOENT',path:'/private/credential.json'});}}});
  await handler.tick();
  assert.equal(fenced,1);
  assertDiagnostic(logs.find(x=>x.event==='execution_pool_reconcile_failed_closed'),'config_read','ENOENT');
  assert.ok(!JSON.stringify(logs).includes('secret contents'));
  assert.ok(!JSON.stringify(logs).includes('/private/'));
});

test('starting node failure includes its original operation and epoch, without starting a replacement',async()=>{
  const logs=[];let reads=0,mutations=0;
  const handler=createExecutionPoolOpsHandler({configPath:'synthetic',log:x=>logs.push(x),
    control:{listPendingOperations:async()=>[],snapshot:async()=>({...state(),nodes:[{identity,state:'starting',cloud_start_operation_id:operationId}]}),
      setAdmissionBudget:async()=>{},loadOperation:async()=>{reads++;throw Error('ENROLLMENT_VAULT_CONFLICT');}},
    dependencies:{readConfig:async()=>configured(),costSnapshot:async()=>{throw Error('EXPENSE_HISTORY_STALE');},
      cloud:{inventory:async()=>[],execute:async()=>{mutations++;}}}});
  await handler.tick();
  const failure=logs.find(x=>x.event==='execution_pool_reconcile_failed_closed');
  assertDiagnostic(failure,'starting_operation_read','ENROLLMENT_VAULT_CONFLICT');
  assert.equal(failure.operation_id,operationId);assert.equal(failure.instance_id,identity.instance_id);assert.equal(failure.epoch,epoch);
  assert.equal(reads,1);assert.equal(mutations,0);
  const budget=logs.find(x=>x.event==='execution_pool_cost_admission_closed');
  assertDiagnostic(budget,'cost_snapshot','EXPENSE_HISTORY_STALE');
  assert.equal(budget.tick_id,failure.tick_id);
});

test('cloud error keeps an allowed vendor code and request id but discards vendor text and arbitrary codes',async()=>{
  const requestId='b2317604-aaea-48cf-81d3-91bd598d8edb';
  for(const [code,expected] of [['UnauthorizedOperation','UnauthorizedOperation'],['SECRET_TOKEN_SHAPED_LIKE_A_CODE','UNCLASSIFIED_ERROR']]){
    const logs=[];
    const handler=createExecutionPoolOpsHandler({configPath:'synthetic',log:x=>logs.push(x),
      control:{listPendingOperations:async()=>{throw Object.assign(Error('CLOUD_API_ERROR'),{code,requestId,messageDetail:'Bearer synthetic-private-token'});},snapshot:async()=>state(),setAdmissionBudget:async()=>{}},
      dependencies:{readConfig:async()=>configured(),cloud:{}}});
    await handler.tick();const event=logs.find(x=>x.event==='execution_pool_reconcile_failed_closed');
    assertDiagnostic(event,'pending_operations_read',expected);assert.equal(event.provider_request_id,requestId);
    assert.ok(!JSON.stringify(logs).includes('synthetic-private-token'));assert.ok(!JSON.stringify(logs).includes('SECRET_TOKEN_SHAPED'));
  }
});

test('failure to fence is independently visible and cannot replace the original error',async()=>{
  const logs=[];
  const handler=createExecutionPoolOpsHandler({configPath:'synthetic',log:x=>logs.push(x),
    control:{snapshot:async()=>state(),setAdmissionBudget:async()=>{throw Object.assign(Error('private database details'),{code:'ECONNREFUSED'});}},
    dependencies:{readConfig:async()=>{throw Error('PRIVATE_FILE_PERMISSIONS');}}});
  await handler.tick();
  assertDiagnostic(logs.find(x=>x.event==='execution_pool_reconcile_failed_closed'),'config_read','PRIVATE_FILE_PERMISSIONS');
  assertDiagnostic(logs.find(x=>x.event==='execution_pool_admission_fence_failed'),'failure_admission_fence','ECONNREFUSED');
  assert.equal(new Set(logs.map(x=>x.tick_id)).size,1);
});

test('a failed tick does not keep the busy flag and emits a different id on the next attempt',async()=>{
  const logs=[];let reads=0;
  const handler=createExecutionPoolOpsHandler({configPath:'synthetic',log:x=>logs.push(x),control:{snapshot:async()=>state(),setAdmissionBudget:async()=>{}},
    dependencies:{readConfig:async()=>{reads++;throw Error('PRIVATE_FILE_PERMISSIONS');}}});
  await handler.tick();await handler.tick();
  assert.equal(reads,2);assert.equal(new Set(logs.map(x=>x.tick_id)).size,2);
});

test('known PG authorization and execution CAS/epoch codes remain distinguishable',async()=>{
  for(const code of ['EXECUTION_CAPACITY_CAS_CONFLICT','EXECUTION_NODE_EPOCH_MISMATCH','42501']){
    const logs=[];
    const handler=createExecutionPoolOpsHandler({configPath:'synthetic',log:x=>logs.push(x),
      control:{listPendingOperations:async()=>{throw Object.assign(Error('private PG message'),{code});},snapshot:async()=>state(),setAdmissionBudget:async()=>{}},
      dependencies:{readConfig:async()=>configured(),cloud:{}}});
    await handler.tick();assertDiagnostic(logs.find(x=>x.event==='execution_pool_reconcile_failed_closed'),'pending_operations_read',code);
    assert.ok(!JSON.stringify(logs).includes('private PG message'));
  }
});

test('a new drain failure retains the same generated operation id and node passed to beginDrain',async()=>{
  const h='a'.repeat(64),logs=[];let requestedOp;
  const c={...configured(),phase:'automatic',min_running:0,image_id:'img-a1',vpc_id:'vpc-a1',subnet_id:'subnet-a1',security_group_id:'sg-a1',
    source_sha256:h,image_sha256:h,network_review_sha256:h,quote_sha256:h,noncompute_cap_cny_per_hour:.8,total_cap_cny_per_hour:2.4,
    private_pg_verified:true,service_credentials_verified:true,stop_charging_verified:true,stop_charging_evidence_sha256:h};
  const node={identity,state:'ready',revision:1,ready_slots:4,active_leases:0,active_model_calls:0,capabilities:['authoring'],idle_since:new Date(Date.now()-3600000).toISOString()};
  const s={...state(),policy:{...state().policy,budget_available:false},nodes:[node]};
  const handler=createExecutionPoolOpsHandler({configPath:'synthetic',log:x=>logs.push(x),
    control:{listPendingOperations:async()=>[],snapshot:async()=>s,beginDrain:async(_,op)=>{requestedOp=op;throw Object.assign(Error('private row'),{code:'EXECUTION_CAPACITY_CAS_CONFLICT'});}},
    dependencies:{readConfig:async()=>c,costSnapshot:async()=>{throw Error('EXPENSE_HISTORY_STALE');},cloud:{inventory:async()=>[{instance_id:identity.instance_id,instance_state:'RUNNING'}]}}});
  await handler.tick();const event=logs.find(x=>x.event==='execution_pool_reconcile_failed_closed');
  assert.ok(requestedOp,'must reach original drain boundary');
  assertDiagnostic(event,'node_drain','EXECUTION_CAPACITY_CAS_CONFLICT');
  assert.equal(event.operation_id,requestedOp);assert.equal(event.instance_id,identity.instance_id);assert.equal(event.epoch,epoch);
});

test('a budget write failure cannot discard the earlier expense error',async()=>{
  const logs=[];
  const handler=createExecutionPoolOpsHandler({configPath:'synthetic',log:x=>logs.push(x),
    control:{listPendingOperations:async()=>[],snapshot:async()=>state(),setAdmissionBudget:async()=>{throw Object.assign(Error('private connection string'),{code:'ECONNREFUSED'});}},
    dependencies:{readConfig:async()=>configured(),costSnapshot:async()=>{throw Error('EXPENSE_HISTORY_STALE');},cloud:{inventory:async()=>[]}}});
  await handler.tick();
  const expense=logs.find(x=>x.error_code==='EXPENSE_HISTORY_STALE'),write=logs.find(x=>x.stage==='budget_admission_write');
  assertDiagnostic(expense,'cost_snapshot','EXPENSE_HISTORY_STALE');assertDiagnostic(write,'budget_admission_write','ECONNREFUSED');
  assert.equal(expense.tick_id,write.tick_id);assert.ok(logs.indexOf(expense)<logs.indexOf(write));
});

test('current enrollment recovery codes and existing reason field remain compatible',async()=>{
 for(const code of ['SECRET_VERSION_CAPACITY','ENROLLMENT_RECOVERY_EXHAUSTED']){
  const logs=[];const handler=createExecutionPoolOpsHandler({configPath:'synthetic',log:x=>logs.push(x),control:{snapshot:async()=>state(),setAdmissionBudget:async()=>{}},dependencies:{readConfig:async()=>{throw Error(code);}}});
  await handler.tick();const event=logs.find(x=>x.event==='execution_pool_reconcile_failed_closed');
  assertDiagnostic(event,'config_read',code);assert.equal(event.reason,code==='SECRET_VERSION_CAPACITY'?code:'RECONCILE_UNAVAILABLE');
 }
});

test('diagnostic logger failures cannot suppress fencing or retain the busy flag',async()=>{
 let fenced=0,reads=0;const handler=createExecutionPoolOpsHandler({configPath:'synthetic',log:()=>{throw Error('logger failure');},control:{snapshot:async()=>state(),setAdmissionBudget:async()=>{fenced++;}},dependencies:{readConfig:async()=>{reads++;throw Error('PRIVATE_FILE_PERMISSIONS');}}});
 await handler.tick();await handler.tick();assert.equal(fenced,2);assert.equal(reads,2);
});
