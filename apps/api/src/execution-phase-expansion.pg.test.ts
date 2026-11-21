import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {configureExecutionCapacity,executionCapacityControl} from './execution-capacity.js';
import {isolatedTestDatabase} from './test-database.js';
const connection=await isolatedTestDatabase(undefined,'phase-expansion');
const h='a'.repeat(64);
// This uses the real migrated admission/CAS paths; cloud nodes are synthetic inventory.
test('third node requires budget review and a fourth remains outside configured admission',{skip:!connection},async t=>{
 const pool=new Pool({connectionString:connection});t.after(()=>pool.end());
 const control=executionCapacityControl(pool),settings={managed_nodes:true,global_model_limit:4,max_nodes:3,budget_available:true,workflow_slots_enabled:true,authoring_slots:1,postprocess_slots:1};
 await assert.rejects(configureExecutionCapacity(pool,0,settings),/max_nodes_budget_check/);
 await configureExecutionCapacity(pool,0,{...settings,expansion_budget_review_sha256:h});
 await assert.rejects(configureExecutionCapacity(pool,0,{...settings,expansion_budget_review_sha256:h}),/CAS_CONFLICT/);
 const snapshot=await control.snapshot();assert.equal(snapshot.policy.max_nodes,3);assert.equal(snapshot.policy.expansion_budget_review_sha256,h);
 const addNode=async(index:number)=>pool.query(`INSERT INTO bb_execution_nodes(id,account_id,region,instance_id,epoch,state,source_sha256,image_sha256,launch_manifest_sha256,capabilities,expected_services,cloud_start_operation_id)
  VALUES($1,'synthetic','synthetic',$2,$3,'ready',$4,$4,$4,ARRAY['authoring','postprocess'],$5,'synthetic-start')`,
  [randomUUID(),'synthetic-'+index,randomUUID(),h,JSON.stringify([{service_id:'mixed',capabilities:['authoring','postprocess'],workflow_protocol_version:1}])]);
 await addNode(1);await addNode(2);
 const request={account_id:'synthetic',region:'synthetic',instance_id:null,epoch:randomUUID(),instance_count:1 as const,source_sha256:h,image_sha256:h,launch_manifest_sha256:h,
  capabilities:['authoring','postprocess'] as const,services:[{service_id:'mixed',capabilities:['authoring','postprocess'] as const,workflow_protocol_version:1 as const}]};
 const intent=await control.reserveStart({...request,capabilities:[...request.capabilities],services:request.services.map(s=>({...s,capabilities:[...s.capabilities]}))},'synthetic-third',snapshot.policy.revision);
 assert.equal(intent.state,'intent');assert.equal((await control.snapshot()).nodes.length,2);
 await control.cancelUndispatchedCloudIntent(intent.operation_id,intent.revision,snapshot.policy.revision);
 await addNode(3);
 await assert.rejects(control.reserveStart({...request,epoch:randomUUID(),capabilities:[...request.capabilities],services:request.services.map(s=>({...s,capabilities:[...s.capabilities]}))},'synthetic-fourth',snapshot.policy.revision),/MAX_NODES_REACHED/);
 assert.equal((await control.snapshot()).nodes.length,3);
});
