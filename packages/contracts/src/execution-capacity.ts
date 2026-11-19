import {Type,type Static,type TSchema} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';

const obj=<T extends Parameters<typeof Type.Object>[0]>(p:T)=>Type.Object(p,{additionalProperties:false});
const id=Type.String({minLength:1,maxLength:128,pattern:'^[A-Za-z0-9:_-]+$'});
const hash=Type.String({pattern:'^[a-f0-9]{64}$'});
const epoch=Type.String({pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'});
const count=Type.Integer({minimum:0});
// PostgreSQL integer representation for provider limits and global slot IDs.
const modelCapacity=Type.Integer({minimum:1,maximum:2147483647});
const nullable=<T extends TSchema>(s:T)=>Type.Union([s,Type.Null()]);
export const EXECUTION_NODE_STATES=['starting','ready','draining','drained','stop_submitted','stopped','lost'] as const;
export const EXECUTION_CLOUD_ACTIONS=['run','start','stop','destroy'] as const;
export const EXECUTION_OPERATION_STATES=['intent','submitted','unknown','completed','rejected','cancelled'] as const;
export const EXECUTION_DEMAND_EXCLUSIONS=['shared_plan_waiter','paused','payment_blocked','unknown_call','active_lease','unready_input','batch_window'] as const;
export const EXECUTION_RUN_CAPACITY_REJECTIONS=['ResourceInsufficient.AvailabilityZoneSoldOut','ResourceInsufficient.CloudDiskSoldOut','ResourceInsufficient.InsufficientOfferingMinimum','ResourceInsufficient.SpecifiedInstanceType'] as const;
export const EXECUTION_CAPABILITIES=['authoring','review','assistant','probe'] as const;
const literals=<T extends readonly string[]>(v:T)=>Type.Union(v.map(x=>Type.Literal(x)));
// This exact synchronous authorization denial has no accepted creation result.
// Do not generalize to arbitrary AuthFailure, transport errors or missing ACKs.
export const EXECUTION_RUN_AUTHORIZATION_REJECTIONS=['UnauthorizedOperation'] as const;
export const ExecutionEvidenceReferenceSchema=obj({evidence_ref:Type.String({minLength:1,maxLength:4096}),evidence_sha256:hash});
export type ExecutionEvidenceReference=Static<typeof ExecutionEvidenceReferenceSchema>;
export const ExecutionRunDenialArchiveSchema=obj({service:Type.Literal('cvm'),action:Type.Literal('RunInstances'),instance_count:Type.Literal(1),operation_id:id,client_token_sha256:hash,code:literals(EXECUTION_RUN_AUTHORIZATION_REJECTIONS),request_id:id});
export const ExecutionRunBoundDenialArchiveSchema=obj({...ExecutionRunDenialArchiveSchema.properties,version:Type.Literal('execution-run-denial-v1'),account_id:id,region:id,launch_manifest_sha256:hash,diagnostic:Type.Optional(obj({actions:Type.Array(Type.String({pattern:'^name/(cvm|vpc|cam|finance):[A-Za-z][A-Za-z0-9]{0,79}$'}),{maxItems:8,uniqueItems:true}),resources:Type.Array(Type.String({pattern:'^qcs:([a-z]+/[0-9]+)?:[a-z]+:[a-z0-9-]+:uin/[0-9]+:(instance|systemdisk|datadisk|image|sg|vpc|subnet|roleName)/[A-Za-z0-9_*.-]+$'}),{maxItems:8,uniqueItems:true})}))});
export const ExecutionRunAuthorizationRecoverySchema=obj({version:Type.Literal('execution-run-authorization-recovery-v1'),operation_id:id,account_id:id,region:id,denial_evidence_sha256:hash,correction_evidence:ExecutionEvidenceReferenceSchema,decision:Type.Literal('allow_new_operations')});
export type ExecutionRunAuthorizationRecovery=Static<typeof ExecutionRunAuthorizationRecoverySchema>;
/** Source observation and locally derived linkage are explicitly separate. */
export const ExecutionRunPaymentDenialAuditSchema=obj({version:Type.Literal('payment-prerequisite-audit-attestation-v1'),account_id:id,region:id,action:Type.Literal('run'),cloud_action:Type.Literal('RunInstances'),operation_id:id,provider_request_id:id,client_token_sha256:hash,launch_manifest_sha256:hash,original_rejection_archive_sha256:hash,classification:Type.Literal('payment_rights_prerequisite_rejected'),
 cloud_audit:obj({lookup_api:Type.Literal('cloudaudit.LookUpEvents'),lookup_request_id:id,original_response_sha256:hash,event_time_utc:Type.String(),actor_type:Type.Literal('AssumedRole'),actor_role_id:id,actor_assumer_uin:id,error_message_sha256:hash,instance_ids_returned:Type.Literal(false)}),
 source_notes:obj({token_in_audit:Type.String({maxLength:512}),request_scalar_types:Type.String({maxLength:512}),remaining_request_values:Type.String({maxLength:512})}),
 official_prerequisite:obj({url:Type.Literal('https://cloud.tencent.com/document/product/555/61542'),source_html_sha256:hash,claim:Type.String({maxLength:512})}),derived_at_utc:Type.String()});
/** Normalized product policy readback, not a claim that an actual Run succeeded. */
export const ExecutionRunAuthorizationCorrectionSchema=obj({version:Type.Literal('execution-run-authorization-correction-v1'),account_id:id,region:id,role_id:id,configuration_sha256:hash,
 policy_id:Type.Integer({minimum:1}),policy_document:obj({version:Type.Literal('2.0'),statement:Type.Array(obj({effect:literals(['allow','deny'] as const),action:Type.Array(Type.String({pattern:'^(name/)?(cvm|vpc|cam|finance):[A-Za-z][A-Za-z0-9]{0,79}$'}),{minItems:1,maxItems:64}),resource:Type.Array(Type.String({pattern:'^qcs:[A-Za-z0-9_:/.*-]+$',maxLength:512}),{minItems:1,maxItems:64})}),{minItems:1,maxItems:32})}),policy_document_sha256:hash,policy_readback_request_id:id,attachment_readback_request_id:id,previous_policy_ids:Type.Array(Type.Integer({minimum:1}),{minItems:1,maxItems:100,uniqueItems:true}),attached_policy_ids:Type.Array(Type.Integer({minimum:1}),{minItems:1,maxItems:100,uniqueItems:true})});


/** Trusted cloud registration, never derived from a cloned machine-id. */
export const ExecutionNodeIdentitySchema=obj({account_id:id,region:id,instance_id:id,epoch});
export type ExecutionNodeIdentity=Static<typeof ExecutionNodeIdentitySchema>;
export const ExecutionNodeContextSchema=obj({identity:ExecutionNodeIdentitySchema,session_id:epoch});
export type ExecutionNodeContext=Static<typeof ExecutionNodeContextSchema>;
export const ExecutionCapacityPolicySchema=obj({revision:count,managed_nodes:Type.Boolean(),global_model_limit:modelCapacity,node_model_limit:Type.Union([Type.Literal(4),Type.Literal(8)]),max_nodes:Type.Integer({minimum:1,maximum:2}),budget_available:Type.Boolean(),provider_concurrency_limit:modelCapacity,provider_policy_sha256:nullable(hash),expense_policy_sha256:nullable(hash),cooldown_until:nullable(Type.String()),launch_blocked_by_operation_id:Type.Optional(nullable(id))});
export type ExecutionCapacityPolicy=Static<typeof ExecutionCapacityPolicySchema>;
export const ExecutionNodeSchema=obj({identity:ExecutionNodeIdentitySchema,state:literals(EXECUTION_NODE_STATES),revision:count,source_sha256:hash,image_sha256:hash,capabilities:Type.Array(literals(EXECUTION_CAPABILITIES),{uniqueItems:true}),launch_manifest_sha256:hash,expected_services:Type.Array(obj({service_id:id,capabilities:Type.Array(literals(EXECUTION_CAPABILITIES),{uniqueItems:true,minItems:1})})),drain_operation_id:nullable(id),cloud_start_operation_id:id,ready_slots:count,active_leases:count,active_model_calls:count,last_heartbeat_at:nullable(Type.String()),idle_since:nullable(Type.String()),stop_operation_id:nullable(id)});
export type ExecutionNode=Static<typeof ExecutionNodeSchema>;
export const ExecutionCapacitySnapshotSchema=obj({version:Type.Literal('execution-capacity-v1'),observed_at:Type.String(),policy:ExecutionCapacityPolicySchema,nodes:Type.Array(ExecutionNodeSchema),pending_cloud_reservations:count,active_model_calls:count,available_model_slots:count,effective_queued_work:count,oldest_wait_seconds:nullable(count),groups:Type.Array(obj({capability:literals(EXECUTION_CAPABILITIES),effective_queued_work:count,oldest_wait_seconds:nullable(count),occupied_run_slots:count,available_run_slots:count})),excluded:obj(Object.fromEntries(EXECUTION_DEMAND_EXCLUSIONS.map(k=>[k,count])) as Record<typeof EXECUTION_DEMAND_EXCLUSIONS[number],typeof count>)});
export type ExecutionCapacitySnapshot=Static<typeof ExecutionCapacitySnapshotSchema>;
export const ExecutionDrainProofSchema=obj({version:Type.Literal('execution-drain-v1'),identity:ExecutionNodeIdentitySchema,operation_id:id,node_revision:count,observed_at:Type.String(),active_leases:Type.Literal(0),active_model_calls:Type.Literal(0),native_processes:Type.Literal(0),unpersisted_results:Type.Literal(0),positive_session_receipts:count,accounted_unknown_calls:count,proof_sha256:hash});
export type ExecutionDrainProof=Static<typeof ExecutionDrainProofSchema>;
/** Explicit lost-node fencing is not evidence of graceful task completion. */
export const ExecutionOperatorFenceProofSchema=obj({version:Type.Literal('execution-operator-fence-v1'),identity:ExecutionNodeIdentitySchema,operation_id:id,action:Type.Literal('stop'),node_state:Type.Literal('lost'),node_revision:count,
 cloud_start_operation_id:id,cloud_start_provider_request_id:id,source_sha256:hash,image_sha256:hash,launch_manifest_sha256:hash,node_preimage_sha256:hash,holder_preimage_sha256:hash,proof_sha256:hash});
export type ExecutionOperatorFenceProof=Static<typeof ExecutionOperatorFenceProofSchema>;
export const ExecutionStopAuthorizationSchema=Type.Union([obj({kind:Type.Literal('graceful-drain'),proof:ExecutionDrainProofSchema}),obj({kind:Type.Literal('operator-fence'),proof:ExecutionOperatorFenceProofSchema})]);
export const ExecutionRunAcceptanceSchema=obj({operation_id:id,identity:ExecutionNodeIdentitySchema,provider_request_id:id,instance_ids:Type.Array(id,{minItems:1,maxItems:1}),client_token:id,
 launch_manifest_sha256:hash,launch_binding_sha256:hash,evidence_ref:Type.String({minLength:1,maxLength:4096}),evidence_sha256:hash});
export type ExecutionRunAcceptance=Static<typeof ExecutionRunAcceptanceSchema>;
export const ExecutionRunCreationSchema=obj({operation_id:id,identity:ExecutionNodeIdentitySchema,launch_manifest_sha256:hash,launch_binding_sha256:hash,created_at:Type.String(),instance_status:id,status_request_id:id});
export const ExecutionCloudObservationSchema=obj({instance_state:id,latest_operation:nullable(id),latest_operation_state:nullable(id),latest_operation_request_id:nullable(id),stop_charging_mode:nullable(id),observed_at:Type.String(),evidence_ref:Type.String({minLength:1,maxLength:4096}),evidence_sha256:hash,run_creation:Type.Optional(ExecutionRunCreationSchema)});
export type ExecutionCloudObservation=Static<typeof ExecutionCloudObservationSchema>;
export const ExecutionExpectedServiceSchema=obj({service_id:id,capabilities:Type.Array(literals(EXECUTION_CAPABILITIES),{uniqueItems:true,minItems:1})});
export const ExecutionLaunchRequestSchema=obj({account_id:id,region:id,instance_id:nullable(id),instance_count:Type.Literal(1),epoch,source_sha256:hash,image_sha256:hash,launch_manifest_sha256:hash,capabilities:Type.Array(literals(EXECUTION_CAPABILITIES),{uniqueItems:true,minItems:1}),services:Type.Array(ExecutionExpectedServiceSchema,{minItems:1,maxItems:16})});
export type ExecutionLaunchRequest=Static<typeof ExecutionLaunchRequestSchema>;
export const ExecutionCloudOperationSchema=obj({operation_id:id,identity:nullable(ExecutionNodeIdentitySchema),action:literals(EXECUTION_CLOUD_ACTIONS),state:literals(EXECUTION_OPERATION_STATES),revision:count,provider_request_id:nullable(id),proof_sha256:nullable(hash),request:nullable(ExecutionLaunchRequestSchema),client_token:id,retry_after:nullable(Type.String()),stop_authorization:Type.Optional(nullable(ExecutionStopAuthorizationSchema)),run_acceptance:Type.Optional(nullable(ExecutionRunAcceptanceSchema)),dispatched_at:Type.Optional(nullable(Type.String())),cloud_observation:Type.Optional(nullable(ExecutionCloudObservationSchema)),authorization_denial:Type.Optional(nullable(Type.Object({evidence_ref:Type.String(),evidence_sha256:hash,code:Type.Literal('UnauthorizedOperation'),provider_request_id:id,operation_id:id,account_id:id,region:id,client_token_sha256:hash,launch_manifest_sha256:hash,archive_binding:literals(['legacy_operation_token','bound_v1'] as const),payment_audit:ExecutionEvidenceReferenceSchema},{additionalProperties:false})))});
export type ExecutionCloudOperation=Static<typeof ExecutionCloudOperationSchema>;
export const ExecutionCloudRejectionSchema=obj({code:literals(EXECUTION_RUN_CAPACITY_REJECTIONS),evidence_ref:Type.String({minLength:1,maxLength:4096}),evidence_sha256:hash,retry_after:Type.String()});
export type ExecutionCloudRejection=Static<typeof ExecutionCloudRejectionSchema>;
export type ExecutionCloudResult={run_acceptance?:ExecutionRunAcceptance;rejection_evidence?:ExecutionCloudRejection;state:'submitted'|'unknown'|'completed'|'rejected';provider_request_id:string|null;identity:ExecutionNodeIdentity|null;observation:ExecutionCloudObservation|null};

const exactIdentity=(a:ExecutionNodeIdentity,b:ExecutionNodeIdentity)=>a.account_id===b.account_id&&a.region===b.region&&a.instance_id===b.instance_id&&a.epoch===b.epoch;
/** The caller supplies its canonical SHA implementation; browser contracts do
 * not import Node crypto. Drain's existing session-bound hash is unchanged. */
export function executionStopAuthorizationMatches(op:ExecutionCloudOperation,canonicalHash:(value:unknown)=>string):boolean {
 const a=op.stop_authorization;
 if(op.action!=='stop'||!op.identity||!Value.Check(ExecutionStopAuthorizationSchema,a))return false;
 const p=a.proof;
 if(!exactIdentity(p.identity,op.identity)||p.operation_id!==op.operation_id||p.proof_sha256!==op.proof_sha256)return false;
 if(a.kind==='graceful-drain')return a.proof.positive_session_receipts>0;
 const {proof_sha256,...body}=a.proof;
 return canonicalHash(body)===proof_sha256;
}
/** Each dedicated role has exactly one tag value; pool is verified separately. */
export function executionSlotReadTag(poolTag:string,roleName:string) {
 if(!/^[a-z0-9-]{1,40}$/.test(poolTag)||!/^[-A-Za-z0-9_]{1,60}$/.test(roleName))throw Error('EXECUTION_SLOT_TAG_SCOPE');
 return {Key:'bondbuddy-execution-slot',Value:roleName};
}
/** Safe projection shared by the launch adapter and node readback. Values come
 * from Run parameters or official DescribeInstances; no latest fields invented. */
export function executionInstanceLaunchBinding(i:Record<string,any>) {
 const tags=(i.Tags??[]) as {Key:string;Value:string}[];
 return {role_name:i.CamRoleName,zone:i.Placement?.Zone,instance_type:i.InstanceType,image_id:i.ImageId,charge_type:i.InstanceChargeType,
  vpc_id:i.VirtualPrivateCloud?.VpcId,subnet_id:i.VirtualPrivateCloud?.SubnetId,security_group_ids:[...(i.SecurityGroupIds??[])].sort(),
  system_disk:{type:i.SystemDisk?.DiskType,size:i.SystemDisk?.DiskSize},data_disks:(i.DataDisks??[]).map((d:any)=>({type:d.DiskType,size:d.DiskSize})),
  public_ip_addresses:[...(i.PublicIpAddresses??[])].sort(),pool_tag:tags.find(t=>t.Key==='bondbuddy-pool')?.Value,
  create_operation_id:tags.find(t=>t.Key==='bondbuddy-create-op')?.Value,read_slot_tag:tags.find(t=>t.Key==='bondbuddy-execution-slot')?.Value};
}
export function executionRunAcceptanceMatches(op:ExecutionCloudOperation,acceptance:unknown):acceptance is ExecutionRunAcceptance {
 if(op.action!=='run'||!op.identity||!op.provider_request_id||!op.request||!Value.Check(ExecutionRunAcceptanceSchema,acceptance))return false;
 return acceptance.operation_id===op.operation_id&&exactIdentity(acceptance.identity,op.identity)&&acceptance.provider_request_id===op.provider_request_id&&
  acceptance.instance_ids.length===1&&acceptance.instance_ids[0]===op.identity.instance_id&&acceptance.client_token===op.client_token&&acceptance.launch_manifest_sha256===op.request.launch_manifest_sha256;
}
/** Run's accepted singleton plus immutable creation evidence differs from
 * Start/Stop's documented LatestOperation acknowledgement. */
export function executionCloudCompletionMatches(op:ExecutionCloudOperation,observation:unknown):observation is ExecutionCloudObservation {
 if(!observation||typeof observation!=='object')return false;
 const raw=observation as Record<string,unknown>;
 const o={instance_state:raw.instance_state,latest_operation:raw.latest_operation,latest_operation_state:raw.latest_operation_state,
  latest_operation_request_id:raw.latest_operation_request_id,stop_charging_mode:raw.stop_charging_mode,observed_at:raw.observed_at,
  evidence_ref:raw.evidence_ref,evidence_sha256:raw.evidence_sha256,...(raw.run_creation?{run_creation:raw.run_creation}:{})};
 if(!op.identity||!op.provider_request_id||!Value.Check(ExecutionCloudObservationSchema,o)||!Number.isFinite(Date.parse(o.observed_at)))return false;
 if(op.action==='run'){
  const a=op.run_acceptance,c=o.run_creation;
  if(!executionRunAcceptanceMatches(op,a)||!c||!op.request)return false;
  const created=Date.parse(c.created_at),observed=Date.parse(o.observed_at),dispatch=Date.parse(op.dispatched_at??'');
  return o.instance_state==='RUNNING'&&c.instance_status==='RUNNING'&&c.operation_id===op.operation_id&&exactIdentity(c.identity,op.identity)&&
   c.launch_manifest_sha256===op.request.launch_manifest_sha256&&c.launch_binding_sha256===a.launch_binding_sha256&&
   Number.isFinite(created)&&created<=observed+30000&&(!Number.isFinite(dispatch)||created>=dispatch-30000);
 }
 const expected={start:'StartInstances',stop:'StopInstances',destroy:'TerminateInstances'}[op.action];
 return !!expected&&o.latest_operation===expected&&o.latest_operation_state==='SUCCESS'&&
  o.latest_operation_request_id===op.provider_request_id&&o.instance_state===(op.action==='stop'?'STOPPED':op.action==='destroy'?'TERMINATED':'RUNNING')&&
  (op.action!=='stop'||o.stop_charging_mode==='STOP_CHARGING');
}

export const ExecutionCloudExpenseLedgerSchema=obj({captured_at:Type.String(),operations:Type.Array(obj({...ExecutionCloudOperationSchema.properties,created_at:Type.String(),dispatched_at:nullable(Type.String()),completed_at:nullable(Type.String()),cloud_observation:nullable(ExecutionCloudObservationSchema),rejection_evidence:nullable(ExecutionCloudRejectionSchema),local_preflight_proof_sha256:Type.Optional(hash)})),nodes:Type.Array(obj({identity:ExecutionNodeIdentitySchema,state:literals(EXECUTION_NODE_STATES),created_at:Type.String(),destroyed_at:nullable(Type.String()),cloud_start_operation_id:id,stop_operation_id:nullable(id),launch_manifest_sha256:hash}))});
export type ExecutionCloudExpenseLedger=Static<typeof ExecutionCloudExpenseLedgerSchema>;

/** Private control adapter. Implementations use the sole database and fresh CAS;
 * cloud acknowledgement is submitted, not proof of stop. */
export interface ExecutionCapacityControl {
  snapshot():Promise<ExecutionCapacitySnapshot>;
  finalizeRunAuthorizationDenial(operationId:string,expectedRevision:number,input:{evidence:ExecutionEvidenceReference;payment_audit:ExecutionEvidenceReference;launch_parameters:Record<string,any>}):Promise<ExecutionCloudOperation>;
  resumeRunAuthorization(operationId:string,expectedPolicyRevision:number,review:ExecutionEvidenceReference):Promise<ExecutionCapacityPolicy>;
  setAdmissionBudget(expectedPolicyRevision:number,available:boolean,expensePolicySha256:string):Promise<ExecutionCapacityPolicy>;
  reserveStart(request:ExecutionLaunchRequest,operationId:string,expectedPolicyRevision:number):Promise<ExecutionCloudOperation>;
  loadOperation(operationId:string):Promise<ExecutionCloudOperation|null>;
  listPendingOperations():Promise<ExecutionCloudOperation[]>;
  /** After fresh controller demand/expense checks, renew only an intent never dispatched.
   * The operation, immutable request, epoch and client token remain unchanged. */
  reauthorizeCloudIntent(operationId:string,expectedRevision:number,expectedPolicyRevision:number):Promise<ExecutionCloudOperation>;
  /** Cancel only a never-dispatched run/start. Warm starts restore the exact stopped predecessor. */
  cancelUndispatchedCloudIntent(operationId:string,expectedRevision:number,expectedPolicyRevision:number):Promise<ExecutionCloudOperation>;
  claimCloudDispatch(operationId:string,expectedRevision:number):Promise<ExecutionCloudOperation>;
  beginDrain(identity:ExecutionNodeIdentity,operationId:string,expectedRevision:number):Promise<ExecutionNode>;
  drainProof(identity:ExecutionNodeIdentity,operationId:string):Promise<ExecutionDrainProof|null>;
  submitStop(proof:ExecutionDrainProof,action:'stop'|'destroy'):Promise<ExecutionCloudOperation>;
  recordCloudResult(operationId:string,expectedRevision:number,result:ExecutionCloudResult):Promise<ExecutionCloudOperation>;
}

/** Private runtime enrollment; never returned by a public HTTP endpoint. */
export const ExecutionRuntimeEnrollmentSchema=obj({context:ExecutionNodeContextSchema,service_id:id,source_sha256:hash,image_sha256:hash,launch_manifest_sha256:hash,registration_token:Type.String({minLength:32,maxLength:256})});
export type ExecutionRuntimeEnrollment=Static<typeof ExecutionRuntimeEnrollmentSchema>;
