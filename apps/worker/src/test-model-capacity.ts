// Test-only cloud receipts; no provider or cloud calls. Uses normal node authority/registration.
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {heartbeatExecutionRuntime,configureExecutionCapacity,executionCapacityControl,bindExecutionRegistration,registerExecutionRuntime} from '@bondbuddy/api/execution-capacity';
export async function registerSyntheticCapacity(pool:Pool){
 const control=executionCapacityControl(pool),hash='a'.repeat(64),id=randomUUID(),identity={account_id:'synthetic',region:'synthetic',instance_id:'test-'+id,epoch:randomUUID()};
 await configureExecutionCapacity(pool,0,{managed_nodes:true,global_model_limit:8,node_model_limit:8,max_nodes:2,budget_available:true,provider_concurrency_limit:8,provider_policy_sha256:hash,expense_policy_sha256:hash});
 let op=await control.reserveStart({...identity,instance_id:null,instance_count:1,source_sha256:hash,image_sha256:hash,launch_manifest_sha256:hash,capabilities:['authoring'],services:[{service_id:'one',capabilities:['authoring']}]},id,1);
 op=await control.claimCloudDispatch(op.operation_id,0);
 op=await control.recordCloudResult(op.operation_id,op.revision,{state:'submitted',identity,provider_request_id:'test-ack',observation:null,run_acceptance:{operation_id:op.operation_id,identity,provider_request_id:'test-ack',instance_ids:[identity.instance_id],client_token:op.client_token,launch_manifest_sha256:hash,launch_binding_sha256:hash,evidence_ref:'synthetic-accepted.json',evidence_sha256:hash}});
 await control.recordCloudResult(op.operation_id,op.revision,{state:'completed',identity,provider_request_id:'test-ack',observation:{instance_state:'RUNNING',latest_operation:'RunInstances',latest_operation_state:'SUCCESS',latest_operation_request_id:'test-ack',stop_charging_mode:null,observed_at:new Date().toISOString(),evidence_ref:'synthetic.json',evidence_sha256:hash,run_creation:{operation_id:op.operation_id,identity,launch_manifest_sha256:hash,launch_binding_sha256:hash,created_at:op.dispatched_at!,instance_status:'RUNNING',status_request_id:'synthetic-status'}}});
 const token='synthetic-registration-'+id;await bindExecutionRegistration(pool,identity,id,token);
 await registerExecutionRuntime(pool,{identity,session_id:randomUUID()},{source_sha256:hash,image_sha256:hash,launch_manifest_sha256:hash,registration_token:token,service_id:'one',capabilities:['authoring'],process_identity:{pid:String(process.pid)}});
 await heartbeatExecutionRuntime(pool,{native_processes:0,unpersisted_results:0,ready:true});
}
