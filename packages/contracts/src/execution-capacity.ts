import {Type,type Static,type TSchema} from '@sinclair/typebox';

const obj=<T extends Parameters<typeof Type.Object>[0]>(p:T)=>Type.Object(p,{additionalProperties:false});
const id=Type.String({minLength:1,maxLength:128,pattern:'^[A-Za-z0-9:_-]+$'});
const hash=Type.String({pattern:'^[a-f0-9]{64}$'});
const epoch=Type.String({pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'});
const count=Type.Integer({minimum:0});
const nullable=<T extends TSchema>(s:T)=>Type.Union([s,Type.Null()]);
export const EXECUTION_NODE_STATES=['starting','ready','draining','drained','stop_submitted','stopped','lost'] as const;
export const EXECUTION_CLOUD_ACTIONS=['run','start','stop','destroy'] as const;
export const EXECUTION_OPERATION_STATES=['intent','submitted','unknown','completed','rejected'] as const;
export const EXECUTION_DEMAND_EXCLUSIONS=['shared_plan_waiter','paused','payment_blocked','unknown_call','active_lease','unready_input','batch_window'] as const;
export const EXECUTION_CAPABILITIES=['authoring','review','assistant','probe'] as const;
const literals=<T extends readonly string[]>(v:T)=>Type.Union(v.map(x=>Type.Literal(x)));

/** Trusted cloud registration, never derived from a cloned machine-id. */
export const ExecutionNodeIdentitySchema=obj({account_id:id,region:id,instance_id:id,epoch});
export type ExecutionNodeIdentity=Static<typeof ExecutionNodeIdentitySchema>;
export const ExecutionNodeContextSchema=obj({identity:ExecutionNodeIdentitySchema,session_id:epoch});
export type ExecutionNodeContext=Static<typeof ExecutionNodeContextSchema>;
export const ExecutionCapacityPolicySchema=obj({revision:count,managed_nodes:Type.Boolean(),global_model_limit:Type.Integer({minimum:1,maximum:64}),node_model_limit:Type.Literal(4),max_nodes:Type.Integer({minimum:1,maximum:16}),budget_available:Type.Boolean(),provider_concurrency_limit:Type.Integer({minimum:1,maximum:64}),provider_policy_sha256:nullable(hash),expense_policy_sha256:nullable(hash)});
export type ExecutionCapacityPolicy=Static<typeof ExecutionCapacityPolicySchema>;
export const ExecutionNodeSchema=obj({identity:ExecutionNodeIdentitySchema,state:literals(EXECUTION_NODE_STATES),revision:count,source_sha256:hash,image_sha256:hash,capabilities:Type.Array(literals(EXECUTION_CAPABILITIES),{uniqueItems:true}),launch_manifest_sha256:hash,expected_services:Type.Array(obj({service_id:id,capabilities:Type.Array(literals(EXECUTION_CAPABILITIES),{uniqueItems:true,minItems:1})})),drain_operation_id:nullable(id),ready_slots:count,active_leases:count,active_model_calls:count,last_heartbeat_at:nullable(Type.String()),idle_since:nullable(Type.String()),stop_operation_id:nullable(id)});
export type ExecutionNode=Static<typeof ExecutionNodeSchema>;
export const ExecutionCapacitySnapshotSchema=obj({version:Type.Literal('execution-capacity-v1'),observed_at:Type.String(),policy:ExecutionCapacityPolicySchema,nodes:Type.Array(ExecutionNodeSchema),pending_cloud_reservations:count,active_model_calls:count,available_model_slots:count,effective_queued_work:count,oldest_wait_seconds:nullable(count),groups:Type.Array(obj({capability:literals(EXECUTION_CAPABILITIES),effective_queued_work:count,oldest_wait_seconds:nullable(count),occupied_run_slots:count,available_run_slots:count})),excluded:obj(Object.fromEntries(EXECUTION_DEMAND_EXCLUSIONS.map(k=>[k,count])) as Record<typeof EXECUTION_DEMAND_EXCLUSIONS[number],typeof count>)});
export type ExecutionCapacitySnapshot=Static<typeof ExecutionCapacitySnapshotSchema>;
export const ExecutionDrainProofSchema=obj({version:Type.Literal('execution-drain-v1'),identity:ExecutionNodeIdentitySchema,operation_id:id,node_revision:count,observed_at:Type.String(),active_leases:Type.Literal(0),active_model_calls:Type.Literal(0),native_processes:Type.Literal(0),unpersisted_results:Type.Literal(0),positive_session_receipts:count,accounted_unknown_calls:count,proof_sha256:hash});
export type ExecutionDrainProof=Static<typeof ExecutionDrainProofSchema>;
export const ExecutionCloudObservationSchema=obj({instance_state:id,latest_operation:id,latest_operation_state:id,latest_operation_request_id:nullable(id),stop_charging_mode:nullable(id),observed_at:Type.String(),evidence_ref:Type.String({minLength:1,maxLength:4096}),evidence_sha256:hash});
export type ExecutionCloudObservation=Static<typeof ExecutionCloudObservationSchema>;
export const ExecutionExpectedServiceSchema=obj({service_id:id,capabilities:Type.Array(literals(EXECUTION_CAPABILITIES),{uniqueItems:true,minItems:1})});
export const ExecutionLaunchRequestSchema=obj({account_id:id,region:id,instance_id:nullable(id),epoch,source_sha256:hash,image_sha256:hash,launch_manifest_sha256:hash,capabilities:Type.Array(literals(EXECUTION_CAPABILITIES),{uniqueItems:true,minItems:1}),services:Type.Array(ExecutionExpectedServiceSchema,{minItems:1,maxItems:16})});
export type ExecutionLaunchRequest=Static<typeof ExecutionLaunchRequestSchema>;
export const ExecutionCloudOperationSchema=obj({operation_id:id,identity:nullable(ExecutionNodeIdentitySchema),action:literals(EXECUTION_CLOUD_ACTIONS),state:literals(EXECUTION_OPERATION_STATES),revision:count,provider_request_id:nullable(id),proof_sha256:nullable(hash),request:nullable(ExecutionLaunchRequestSchema),client_token:id});
export type ExecutionCloudOperation=Static<typeof ExecutionCloudOperationSchema>;
export type ExecutionCloudResult={state:'submitted'|'unknown'|'completed'|'rejected';provider_request_id:string|null;identity:ExecutionNodeIdentity|null;observation:ExecutionCloudObservation|null};

/** Private control adapter. Implementations use the sole database and fresh CAS;
 * cloud acknowledgement is submitted, not proof of stop. */
export interface ExecutionCapacityControl {
  snapshot():Promise<ExecutionCapacitySnapshot>;
  reserveStart(request:ExecutionLaunchRequest,operationId:string,expectedPolicyRevision:number):Promise<ExecutionCloudOperation>;
  loadOperation(operationId:string):Promise<ExecutionCloudOperation|null>;
  listPendingOperations():Promise<ExecutionCloudOperation[]>;
  claimCloudDispatch(operationId:string,expectedRevision:number):Promise<ExecutionCloudOperation>;
  beginDrain(identity:ExecutionNodeIdentity,operationId:string,expectedRevision:number):Promise<ExecutionNode>;
  drainProof(identity:ExecutionNodeIdentity,operationId:string):Promise<ExecutionDrainProof|null>;
  submitStop(proof:ExecutionDrainProof,action:'stop'|'destroy'):Promise<ExecutionCloudOperation>;
  recordCloudResult(operationId:string,expectedRevision:number,result:ExecutionCloudResult):Promise<ExecutionCloudOperation>;
}

/** Private runtime enrollment; never returned by a public HTTP endpoint. */
export const ExecutionRuntimeEnrollmentSchema=obj({context:ExecutionNodeContextSchema,service_id:id,source_sha256:hash,image_sha256:hash,launch_manifest_sha256:hash,registration_token:Type.String({minLength:32,maxLength:256})});
export type ExecutionRuntimeEnrollment=Static<typeof ExecutionRuntimeEnrollmentSchema>;
