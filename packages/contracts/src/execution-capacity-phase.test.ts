import test from 'node:test';
import assert from 'node:assert/strict';
import {Value} from '@sinclair/typebox/value';
import {ExecutionCapacityPolicySchema,ExecutionExpectedServiceSchema} from './execution-capacity.js';
const h='a'.repeat(64),base={revision:1,managed_nodes:true,global_model_limit:5,node_model_limit:4,max_nodes:2,budget_available:true,provider_concurrency_limit:5,provider_policy_sha256:h,expense_policy_sha256:h,cooldown_until:null};
test('phase schemas retain old DTOs and distinguish trusted postprocess enrollment',()=>{
 assert.equal(Value.Check(ExecutionCapacityPolicySchema,base),true);
 assert.equal(Value.Check(ExecutionCapacityPolicySchema,{...base,max_nodes:3,expansion_budget_review_sha256:h,workflow_slots_enabled:true,authoring_slots:1,postprocess_slots:1}),true);
 for(const patch of [{max_nodes:0},{max_nodes:65},{authoring_slots:0},{postprocess_slots:3}])assert.equal(Value.Check(ExecutionCapacityPolicySchema,{...base,...patch}),false);
 assert.equal(Value.Check(ExecutionExpectedServiceSchema,{service_id:'legacy',capabilities:['authoring']}),true);
 assert.equal(Value.Check(ExecutionExpectedServiceSchema,{service_id:'postprocess',capabilities:['postprocess'],workflow_protocol_version:1}),true);
 assert.equal(Value.Check(ExecutionExpectedServiceSchema,{service_id:'postprocess',capabilities:['postprocess'],workflow_protocol_version:2}),false);
});
