import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {executionCapacityControl,configureExecutionCapacity,executionCloudExpenseLedger} from '@bondbuddy/api/execution-capacity';
import {isolatedTestDatabase} from '../../apps/api/dist/test-database.js';

const connection=await isolatedTestDatabase(undefined,'execution-run-acceptance');
// The existing migrated database is a template only. Apply the new migration
// exclusively in the test clone; all cloud responses and prices are synthetic.
test('real PG retains accepted singleton ACK and allows null-latest creation, while absent acceptance stays unknown',{skip:!connection},async t=>{
  const pool=new Pool({connectionString:connection,max:2});t.after(()=>pool.end());
  if(!(await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='bb_execution_cloud_operations' AND column_name='run_acceptance'")).rowCount)await pool.query(await readFile(new URL('../../db/migrations/0182_execution_run_acceptance.sql',import.meta.url),'utf8'));
  const h='a'.repeat(64),services=[{service_id:'authoring',capabilities:['authoring']}];
  const revision=Number((await pool.query('SELECT revision FROM bb_execution_capacity_policy WHERE singleton')).rows[0].revision);
  await configureExecutionCapacity(pool,revision,{managed_nodes:true,global_model_limit:4,max_nodes:2,budget_available:true,expense_policy_sha256:h});
  const control=executionCapacityControl(pool),operationId='synthetic-'+randomUUID(),epoch=randomUUID();
  const request={account_id:'123456',region:'ap-beijing',instance_id:null,instance_count:1,epoch,source_sha256:h,image_sha256:h,launch_manifest_sha256:h,capabilities:['authoring'],services};
  const reserved=await control.reserveStart(request,operationId,(await control.snapshot()).policy.revision),claimed=await control.claimCloudDispatch(operationId,reserved.revision);
  const identity={account_id:request.account_id,region:request.region,instance_id:'ins-syntheticpg',epoch},ack='synthetic-accepted';
  const acceptance={operation_id:operationId,identity,provider_request_id:ack,instance_ids:[identity.instance_id],client_token:claimed.client_token,
    launch_manifest_sha256:h,launch_binding_sha256:h,evidence_ref:'synthetic/accepted',evidence_sha256:h};
  const submitted={state:'submitted',identity,provider_request_id:ack,observation:null,run_acceptance:acceptance};
  await assert.rejects(control.recordCloudResult(operationId,claimed.revision,{...submitted,run_acceptance:{...acceptance,instance_ids:['ins-other']}}),/RUN_ACCEPTANCE_UNPROVEN/);
  await assert.rejects(control.recordCloudResult(operationId,claimed.revision,{...submitted,run_acceptance:undefined}),/RUN_ACCEPTANCE_UNPROVEN/);
  await control.recordCloudResult(operationId,claimed.revision,submitted);
  const loaded=await control.loadOperation(operationId);assert.deepEqual(loaded.run_acceptance,acceptance);
  const observed={instance_state:'RUNNING',latest_operation:null,latest_operation_state:null,latest_operation_request_id:null,stop_charging_mode:null,observed_at:new Date().toISOString(),
    evidence_ref:'synthetic/status',evidence_sha256:h,run_creation:{operation_id:operationId,identity,launch_manifest_sha256:h,launch_binding_sha256:h,
      created_at:claimed.dispatched_at,instance_status:'RUNNING',status_request_id:'synthetic-status'}};
  for(const bad of [{...observed,run_creation:{...observed.run_creation,operation_id:'foreign'}},{...observed,run_creation:{...observed.run_creation,launch_binding_sha256:'b'.repeat(64)}}])
    await assert.rejects(control.recordCloudResult(operationId,loaded.revision,{state:'completed',identity,provider_request_id:ack,observation:bad}),/COMPLETION_UNPROVEN/);
  const completed=await control.recordCloudResult(operationId,loaded.revision,{state:'completed',identity,provider_request_id:ack,observation:observed});
  assert.equal(completed.state,'completed');assert.deepEqual(completed.run_acceptance,acceptance);assert.equal(completed.cloud_observation.latest_operation,null);
  const ledger=await executionCloudExpenseLedger(pool);assert.deepEqual(ledger.operations.find(o=>o.operation_id===operationId).run_acceptance,acceptance);
  assert.equal((await control.snapshot()).nodes.find(n=>n.identity.instance_id===identity.instance_id).cloud_start_operation_id,operationId);
  await assert.rejects(control.recordCloudResult(operationId,completed.revision,{state:'completed',identity,provider_request_id:ack,observation:observed}),/CAS_CONFLICT/);
  const unknownId='synthetic-'+randomUUID(),next={...request,epoch:randomUUID()};
  const pending=await control.reserveStart(next,unknownId,(await control.snapshot()).policy.revision),unknown=await control.claimCloudDispatch(unknownId,pending.revision);
  const owned={...identity,instance_id:'ins-unknownpg',epoch:next.epoch};
  const bound=await control.recordCloudResult(unknownId,unknown.revision,{state:'unknown',identity:owned,provider_request_id:null,observation:null});
  await assert.rejects(control.recordCloudResult(unknownId,bound.revision,{state:'completed',identity:owned,provider_request_id:null,observation:{...observed,run_creation:{...observed.run_creation,identity:owned,operation_id:unknownId}}}),/COMPLETION_UNPROVEN/);
  const unresolved=await control.loadOperation(unknownId);assert.equal(unresolved.state,'unknown');assert.equal(unresolved.provider_request_id,null);assert.equal(unresolved.run_acceptance,null);
});
