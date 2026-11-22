import test from 'node:test';
import assert from 'node:assert/strict';
import {validateConfig,planCapacity} from './policy.mjs';
const h='a'.repeat(64);
const base={version:'tencent-execution-pool-v1',enabled:true,phase:'automatic',account_id:'123456',pool_tag:'synthetic',region:'ap-beijing',zone:'ap-beijing-7',instance_type:'SA9.LARGE16',min_running:1,max_owned:2,node_model_limit:4,global_model_limit:4,compute_cny_per_hour:.8,compute_cap_cny_per_hour:1.6,scale_up_wait_seconds:60,idle_seconds:300,failure_cooldown_seconds:300,services:[{service_id:'authoring',capabilities:['authoring']}]};
test('expansion requires explicit budget evidence and uses the configured bound',()=>{
 assert.throws(()=>validateConfig({...base,max_owned:3,compute_cap_cny_per_hour:2.4}),/POOL_BOUND|BUDGET/);
 const expanded={...base,max_owned:3,compute_cap_cny_per_hour:2.4,expansion_budget_review_sha256:h};
 assert.doesNotThrow(()=>validateConfig(expanded));
 const snapshot={policy:{managed_nodes:true,node_model_limit:4,max_nodes:3,budget_available:true,global_model_limit:4,provider_concurrency_limit:4,expansion_budget_review_sha256:h},pending_cloud_reservations:0,nodes:[],active_model_calls:0,effective_queued_work:1,groups:[{capability:'authoring',effective_queued_work:1,oldest_wait_seconds:60,available_run_slots:0}]};
 assert.equal(planCapacity(snapshot,[{instance_state:'RUNNING'},{instance_state:'RUNNING'}],expanded).kind,'run');
 assert.equal(planCapacity(snapshot,[{instance_state:'RUNNING'},{instance_state:'RUNNING'},{instance_state:'RUNNING'}],expanded).reason,'max_owned');
 assert.equal(planCapacity(snapshot,Array.from({length:4},()=>({instance_state:'STOPPED'})),expanded).reason,'inventory_drift');
});
test('phase capacity policy requires a matching opted-in database policy',()=>{
 const config={...base,workflow_slots_enabled:true,authoring_slots:1,postprocess_slots:1};
 const snapshot={policy:{managed_nodes:true,node_model_limit:4,max_nodes:2,budget_available:true,global_model_limit:4,provider_concurrency_limit:4,workflow_slots_enabled:false},pending_cloud_reservations:0,nodes:[],active_model_calls:0,effective_queued_work:0,groups:[]};
 assert.equal(planCapacity(snapshot,[],config).reason,'policy_mismatch');
 assert.throws(()=>validateConfig({...config,authoring_slots:0}),/PHASE_CAPACITY/);
});
