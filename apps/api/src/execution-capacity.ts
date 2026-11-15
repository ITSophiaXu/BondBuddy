import {Pool,type PoolClient} from 'pg';
import {finalizeExecutionRunDenial,resumeExecutionRunAuthorization,type ExecutionDenialScope} from './execution-run-denial.js';
import {Value} from '@sinclair/typebox/value';
import {createHash,randomUUID} from 'node:crypto';
import {executionCloudCompletionMatches,executionRunAcceptanceMatches,executionStopAuthorizationMatches,ExecutionNodeContextSchema,ExecutionLaunchRequestSchema,ExecutionCloudObservationSchema,ExecutionCloudRejectionSchema,type ExecutionCloudExpenseLedger,type ExecutionCapacityPolicy,type ExecutionNodeContext,type ExecutionNodeIdentity,type ExecutionNode,type ExecutionCloudOperation,type ExecutionCloudResult,type ExecutionLaunchRequest,type ExecutionCapacityControl,type ExecutionCapacitySnapshot,type ExecutionDrainProof} from '@bondbuddy/contracts';
import {transaction} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {fenceStoppedExecutionEpoch,providerCallNeedsReconciliation} from './queue.js';
import {workpaperDemandKey,type ExecutionBatchDemand} from './execution-demand.js';

const contexts=new WeakMap<Pool,ExecutionNodeContext>();
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
/** Preserve the original durable token algorithm for all existing operations. */
export function executionCloudClientToken(operationId:string):string{return sha(operationId);}
const identity=(row:any):ExecutionNodeIdentity=>({account_id:row.account_id,region:row.region,instance_id:row.instance_id,epoch:row.epoch});
const sameIdentity=(a:ExecutionNodeIdentity,b:ExecutionNodeIdentity)=>JSON.stringify(a)===JSON.stringify(b);
const cas=()=>{throw new Error('EXECUTION_CAPACITY_CAS_CONFLICT');};
export function executionNodeForPool(pool:Pool){return contexts.get(pool);}
/** Set only after trusted registration succeeded. No runtime env controls global capacity. */
function bind(pool:Pool,context:ExecutionNodeContext){if(!Value.Check(ExecutionNodeContextSchema,context))throw Error('EXECUTION_NODE_IDENTITY_INVALID');contexts.set(pool,context);}
function policyDto(p:any):ExecutionCapacityPolicy{return {revision:Number(p.revision),managed_nodes:p.managed_nodes,global_model_limit:p.global_model_limit,node_model_limit:4,max_nodes:p.max_nodes,budget_available:p.budget_available,provider_concurrency_limit:p.provider_concurrency_limit,provider_policy_sha256:p.provider_policy_sha256?.trim()??null,expense_policy_sha256:p.expense_policy_sha256?.trim()??null,cooldown_until:p.cooldown_until?.toISOString()??null,launch_blocked_by_operation_id:p.launch_blocked_by_operation_id??null};}
async function node(client:PoolClient|Pool,i:ExecutionNodeIdentity,lock=false){
 const row=(await client.query(`SELECT * FROM bb_execution_nodes WHERE account_id=$1 AND region=$2 AND instance_id=$3 ${lock?'FOR UPDATE':''}`,[i.account_id,i.region,i.instance_id])).rows[0];
 if(!row||row.epoch!==i.epoch)throw Error('EXECUTION_NODE_EPOCH_MISMATCH');return row;
}
async function dto(client:PoolClient|Pool,row:any):Promise<ExecutionNode>{
 const active=(await client.query(`SELECT (SELECT count(*) FROM bb_jobs WHERE execution_node_id=$1 AND lease_token IS NOT NULL)+(SELECT count(*) FROM bb_review_messages WHERE execution_node_id=$1 AND lease_token IS NOT NULL) AS leases,
 (SELECT count(*) FROM bb_model_capacity_holders WHERE execution_node_id=$1) AS calls`,[row.id])).rows[0];
 const sessions=(await client.query("SELECT service_id,state,ready,heartbeat_at FROM bb_execution_node_sessions WHERE node_id=$1 AND epoch=$2",[row.id,row.epoch])).rows;
 const allReady=row.expected_services.length>0&&row.expected_services.every((service:any)=>sessions.some(s=>s.service_id===service.service_id&&s.state==='active'&&s.ready&&new Date(s.heartbeat_at).getTime()>Date.now()-30000));
 return {identity:identity(row),state:row.state,revision:Number(row.revision),source_sha256:row.source_sha256.trim(),image_sha256:row.image_sha256.trim(),capabilities:row.capabilities,launch_manifest_sha256:row.launch_manifest_sha256.trim(),expected_services:row.expected_services,drain_operation_id:row.drain_operation_id,cloud_start_operation_id:row.cloud_start_operation_id,ready_slots:row.state==='ready'&&allReady?Math.max(0,4-Number(active.leases)):0,active_leases:Number(active.leases),active_model_calls:Number(active.calls),last_heartbeat_at:row.last_heartbeat_at?.toISOString()??null,idle_since:row.idle_since?.toISOString()??null,stop_operation_id:row.stop_operation_id};
}
function opDto(row:any):ExecutionCloudOperation{return {operation_id:row.operation_id,identity:row.instance_id?identity(row):null,action:row.action,state:row.state,revision:Number(row.revision),provider_request_id:row.provider_request_id,proof_sha256:row.proof_sha256?.trim()??null,request:['run','start'].includes(row.action)?row.request:null,client_token:row.client_token,retry_after:row.retry_after?.toISOString()??null,...(row.action==='stop'?{stop_authorization:row.request??(row.legacy_drain_proof?{kind:'graceful-drain',proof:row.legacy_drain_proof}:null)}:{}),run_acceptance:row.run_acceptance??null,dispatched_at:row.dispatched_at?.toISOString()??null,cloud_observation:row.cloud_observation??null,authorization_denial:row.authorization_denial??null};}
async function operation(client:PoolClient|Pool,id:string,lock=false){
 const op=(await client.query(`SELECT * FROM bb_execution_cloud_operations WHERE operation_id=$1 ${lock?'FOR UPDATE':''}`,[id])).rows[0];
 // Legacy graceful intent already owns a persisted session-bound proof. Never
 // reinterpret missing request bytes as an operator fence.
 if(op?.action==='stop'&&!op.request){
  const n=(await client.query('SELECT drain_proof FROM bb_execution_nodes WHERE account_id=$1 AND region=$2 AND instance_id=$3 AND epoch=$4 AND stop_operation_id=$5 AND drain_operation_id=$5',[op.account_id,op.region,op.instance_id,op.epoch,id])).rows[0];
  if(n?.drain_proof?.proof_sha256===op.proof_sha256?.trim()&&sha(n.drain_proof)===op.request_sha256.trim())op.legacy_drain_proof=n.drain_proof;
 }
 return op;
}
async function validatePersistedStop(client:PoolClient,n:any,op:any){
 const view=opDto(op),a=view.stop_authorization;
 if(!executionStopAuthorizationMatches(view,sha)||!a||n.state!=='stop_submitted'||n.stop_operation_id!==op.operation_id||Number(n.revision)!==a.proof.node_revision+1)throw Error('EXECUTION_STOP_AUTHORIZATION_INVALID');
 if(a.kind==='graceful-drain'){
  if(n.drain_operation_id!==op.operation_id||sha(n.drain_proof)!==sha(a.proof)||op.request_sha256.trim()!==sha(a.proof))throw Error('EXECUTION_STOP_AUTHORIZATION_INVALID');
 }else{
  const p=a.proof,pre=op.node_preimage;
  if(op.request_sha256.trim()!==sha(a)||pre?.version!=='execution-operator-fence-preimage-v1'||!pre.node||!Array.isArray(pre.holders)||sha(pre.node)!==p.node_preimage_sha256||sha(pre.holders)!==p.holder_preimage_sha256||
   pre.node.state!=='lost'||Number(pre.node.revision)!==p.node_revision||!sameIdentity(identity(pre.node),identity(n))||p.cloud_start_operation_id!==n.cloud_start_operation_id||
   p.source_sha256!==n.source_sha256.trim()||p.image_sha256!==n.image_sha256.trim()||p.launch_manifest_sha256!==n.launch_manifest_sha256.trim())throw Error('EXECUTION_STOP_AUTHORIZATION_INVALID');
  const start=await operation(client,n.cloud_start_operation_id);
  if(!start||start.state!=='completed'||!['run','start'].includes(start.action)||!sameIdentity(identity(start),identity(n))||start.provider_request_id!==p.cloud_start_provider_request_id||
   start.request?.source_sha256!==p.source_sha256||start.request?.image_sha256!==p.image_sha256||start.request?.launch_manifest_sha256!==p.launch_manifest_sha256)throw Error('EXECUTION_STOP_AUTHORIZATION_INVALID');
 }
}

/** Called inside every model-job/assistant/probe claim transaction, before job locks. */
export async function executionClaimGate(client:PoolClient,pool:Pool){
 const c=contexts.get(pool);
 const policy=(await client.query('SELECT managed_nodes FROM bb_execution_capacity_policy WHERE singleton FOR SHARE')).rows[0];
 if(c){const n=await node(client,c.identity,true);await client.query("SELECT set_config('bb.execution_node_id',$1,true),set_config('bb.execution_node_epoch',$2,true),set_config('bb.execution_session_id',$3,true)",[n.id,c.identity.epoch,c.session_id]);}
 if(c||policy.managed_nodes)await client.query('SELECT bb_execution_claim_context()');
}
export async function executionNodeState(pool:Pool){const c=contexts.get(pool);return c?(await node(pool,c.identity)).state:null;}

/** Bootstrap secret is pre-bound by the trusted controller after cloud Describe.
 * It is not a metadata assertion, machine-id, or credential copied into an image. */
export async function registerExecutionRuntime(pool:Pool,c:ExecutionNodeContext,input:{source_sha256:string;image_sha256:string;registration_token:string;launch_manifest_sha256:string;service_id:string;capabilities:string[];process_identity:Record<string,string>}){
 if(!Value.Check(ExecutionNodeContextSchema,c))throw Error('EXECUTION_NODE_IDENTITY_INVALID');
 if(contexts.has(pool)&&sha(contexts.get(pool))!==sha(c))throw Error('EXECUTION_REGISTRATION_REJECTED');
 await transaction(pool,async client=>{
  const n=await node(client,c.identity,true);
  if(!['starting','ready'].includes(n.state)||n.source_sha256.trim()!==input.source_sha256||n.image_sha256.trim()!==input.image_sha256||n.registration_token_sha256?.trim()!==sha(input.registration_token)||n.launch_manifest_sha256.trim()!==input.launch_manifest_sha256||!n.expected_services.some((s:any)=>s.service_id===input.service_id&&sha([...s.capabilities].sort())===sha([...input.capabilities].sort())))throw Error('EXECUTION_REGISTRATION_REJECTED');
  const prior=(await client.query('SELECT * FROM bb_execution_node_sessions WHERE session_id=$1',[c.session_id])).rows[0];
  if(prior&&(prior.node_id!==n.id||prior.epoch!==n.epoch||sha(prior.process_identity)!==sha(input.process_identity)||prior.service_id!==input.service_id||prior.state!=='active'))throw Error('EXECUTION_REGISTRATION_REJECTED');
  await client.query("INSERT INTO bb_execution_node_sessions(session_id,node_id,epoch,state,service_id,process_identity) VALUES($1,$2,$3,'active',$4,$5) ON CONFLICT DO NOTHING",[c.session_id,n.id,n.epoch,input.service_id,input.process_identity]);
 });bind(pool,c);
}
export async function bindExecutionRegistration(pool:Pool,i:ExecutionNodeIdentity,operationId:string,token:string){
 await transaction(pool,async client=>{const n=await node(client,i,true),op=await operation(client,operationId,true);
  if(n.state!=='starting'||!op||op.state!=='completed'||!['run','start'].includes(op.action)||!sameIdentity(identity(op),i)||n.cloud_start_operation_id!==operationId)throw Error('EXECUTION_REGISTRATION_REJECTED');
  if(n.registration_token_sha256&&n.registration_token_sha256!==sha(token))throw Error('EXECUTION_REGISTRATION_REJECTED');
  await client.query('UPDATE bb_execution_nodes SET registration_token_sha256=$2 WHERE id=$1',[n.id,sha(token)]);
 });
}
export async function heartbeatExecutionRuntime(pool:Pool,input:{native_processes:number;unpersisted_results:number;ready:boolean;finished?:boolean}){
 const c=contexts.get(pool);if(!c)return;
 if(!Number.isSafeInteger(input.native_processes)||input.native_processes<0||!Number.isSafeInteger(input.unpersisted_results)||input.unpersisted_results<0)throw Error('EXECUTION_RUNTIME_COUNTS_INVALID');
 await transaction(pool,async client=>{
  const n=await node(client,c.identity,true);
  if(input.finished&&(input.native_processes||input.unpersisted_results))throw Error('EXECUTION_RUNTIME_NOT_FINISHED');
  const result=await client.query(`UPDATE bb_execution_node_sessions SET native_processes=$2,unpersisted_results=$3,ready=$4,heartbeat_at=clock_timestamp(),state=CASE WHEN $5 THEN 'finished' ELSE 'active' END,finished_at=CASE WHEN $5 THEN clock_timestamp() ELSE NULL END
   WHERE session_id=$1 AND node_id=$6 AND epoch=$7 AND state='active'`,[c.session_id,input.native_processes,input.unpersisted_results,input.ready,!!input.finished,n.id,n.epoch]);
  if(!result.rowCount)throw Error('EXECUTION_RUNTIME_SESSION_LOST');
  await client.query('UPDATE bb_execution_nodes SET last_heartbeat_at=clock_timestamp() WHERE id=$1',[n.id]);
  if(n.state==='starting'&&input.ready&&!input.finished){
   const ready=await dto(client,{...n,state:'ready'});
   if(ready.ready_slots>0)await client.query("UPDATE bb_execution_nodes SET state='ready',revision=revision+1 WHERE id=$1",[n.id]);
  }
  const fresh=await node(client,c.identity),counts=await dto(client,fresh);
  const sessions=(await client.query('SELECT * FROM bb_execution_node_sessions WHERE node_id=$1 AND epoch=$2',[n.id,n.epoch])).rows;
  const idle=fresh.state==='ready'&&counts.ready_slots===4&&counts.active_model_calls===0&&sessions.every(s=>s.native_processes===0&&s.unpersisted_results===0);
  await client.query('UPDATE bb_execution_nodes SET idle_since=CASE WHEN $2 THEN COALESCE(idle_since,clock_timestamp()) ELSE NULL END WHERE id=$1',[n.id,idle]);
 });
}

export function executionCapacityControl(pool:Pool,denialScope?:ExecutionDenialScope):ExecutionCapacityControl {
 return {
  snapshot:()=>executionCapacitySnapshot(pool),
  finalizeRunAuthorizationDenial:async(id,revision,input)=>opDto(await finalizeExecutionRunDenial(pool,denialScope,id,revision,input)),
  resumeRunAuthorization:async(id,revision,review)=>policyDto(await resumeExecutionRunAuthorization(pool,denialScope,id,revision,review)),
  setAdmissionBudget:async(revision,available,expenseHash)=>transaction(pool,async client=>{
   const p=(await client.query('SELECT * FROM bb_execution_capacity_policy WHERE singleton FOR UPDATE')).rows[0];
   if(Number(p.revision)!==revision||!p.managed_nodes||!/^[a-f0-9]{64}$/.test(expenseHash)||available&&p.expense_policy_sha256?.trim()!==expenseHash)cas();
   if(p.budget_available===available)return policyDto(p);
   return policyDto((await client.query('UPDATE bb_execution_capacity_policy SET budget_available=$1,revision=revision+1 WHERE singleton RETURNING *',[available])).rows[0]);
  }),
  reserveStart:async(request,operationId,expectedPolicyRevision)=>transaction(pool,async client=>{
   if(!Value.Check(ExecutionLaunchRequestSchema,request))throw Error('EXECUTION_LAUNCH_INVALID');
   if(new Set(request.services.map(s=>s.service_id)).size!==request.services.length||new Set(request.services.flatMap(s=>s.capabilities)).size!==request.capabilities.length||request.services.flatMap(s=>s.capabilities).some(c=>!request.capabilities.includes(c)))throw Error('EXECUTION_SERVICE_MANIFEST_INVALID');
   const policy=(await client.query('SELECT * FROM bb_execution_capacity_policy WHERE singleton FOR UPDATE')).rows[0];
   const prior=await operation(client,operationId,true);if(prior){if(prior.request_sha256.trim()!==sha(request))cas();return opDto(prior);}
   if(Number(policy.revision)!==expectedPolicyRevision||!policy.managed_nodes||!policy.budget_available||policy.launch_blocked_by_operation_id||policy.cooldown_until&&new Date(policy.cooldown_until).getTime()>Date.now())cas();
   let existing:any;
   if(request.instance_id)existing=(await client.query('SELECT * FROM bb_execution_nodes WHERE account_id=$1 AND region=$2 AND instance_id=$3 FOR UPDATE',[request.account_id,request.region,request.instance_id])).rows[0];
   if(request.instance_id&&(!existing||existing.state!=='stopped'||existing.stop_operation_id&&(await operation(client,existing.stop_operation_id)).state!=='completed'))cas();
   if(existing&&(existing.source_sha256.trim()!==request.source_sha256||existing.image_sha256.trim()!==request.image_sha256||existing.launch_manifest_sha256.trim()!==request.launch_manifest_sha256||sha(existing.expected_services)!==sha(request.services)||sha([...existing.capabilities].sort())!==sha([...request.capabilities].sort())))throw Error('EXECUTION_WARM_START_MANIFEST_CHANGED');
   const inventory=Number((await client.query('SELECT count(*) AS n FROM bb_execution_nodes WHERE destroyed_at IS NULL')).rows[0].n);
   const pending=Number((await client.query("SELECT count(*) AS n FROM bb_execution_cloud_operations WHERE action='run' AND state IN ('intent','submitted','unknown')")).rows[0].n);
   if((await client.query("SELECT 1 FROM bb_execution_cloud_operations WHERE state IN ('intent','submitted','unknown') LIMIT 1")).rowCount)throw Error('EXECUTION_CLOUD_MUTATION_PENDING');
   if(!existing&&inventory+pending>=Number(policy.max_nodes))throw Error('EXECUTION_MAX_NODES_REACHED');
   if(existing&&(await client.query('SELECT 1 FROM bb_model_capacity_holders WHERE execution_node_id=$1',[existing.id])).rowCount)throw Error('EXECUTION_PRIOR_PROCESS_NOT_STOPPED');
   await client.query("INSERT INTO bb_execution_cloud_operations(operation_id,account_id,region,instance_id,epoch,action,state,request,request_sha256,client_token,policy_revision) VALUES($1,$2,$3,$4,$5,$6,'intent',$7,$8,$9,$10)",[operationId,request.account_id,request.region,request.instance_id,request.epoch,existing?'start':'run',request,sha(request),executionCloudClientToken(operationId),policy.revision]);
   if(existing){
    const before=(await client.query('SELECT to_jsonb(n) AS image FROM bb_execution_nodes n WHERE id=$1',[existing.id])).rows[0].image;
    await client.query("UPDATE bb_execution_nodes SET epoch=$2,state='starting',revision=revision+1,source_sha256=$3,image_sha256=$4,capabilities=$5,cloud_start_operation_id=$6,expected_services=$7,launch_manifest_sha256=$8,stop_operation_id=NULL,drain_operation_id=NULL,drain_proof=NULL,registration_token_sha256=NULL WHERE id=$1",[existing.id,request.epoch,request.source_sha256,request.image_sha256,request.capabilities,operationId,JSON.stringify(request.services),request.launch_manifest_sha256]);
    await client.query('UPDATE bb_execution_cloud_operations SET node_preimage=$2,reserved_node_preimage=(SELECT to_jsonb(n) FROM bb_execution_nodes n WHERE id=$3) WHERE operation_id=$1',[operationId,before,existing.id]);
   }
   return opDto(await operation(client,operationId));
  }),
  loadOperation:async id=>{const row=await operation(pool,id);return row?opDto(row):null;},
  listPendingOperations:async()=>{
   const rows=(await pool.query("SELECT * FROM bb_execution_cloud_operations WHERE state IN ('intent','submitted','unknown') ORDER BY created_at,operation_id")).rows;
   return Promise.all(rows.map(async row=>opDto(row.action==='stop'&&!row.request?await operation(pool,row.operation_id):row)));
  },
  reauthorizeCloudIntent:async(id,revision,policyRevision)=>transaction(pool,async client=>{
   const p=(await client.query('SELECT * FROM bb_execution_capacity_policy WHERE singleton FOR UPDATE')).rows[0];
   if(Number(p.revision)!==policyRevision||!p.managed_nodes||!p.budget_available||p.launch_blocked_by_operation_id||p.cooldown_until&&new Date(p.cooldown_until).getTime()>Date.now())cas();
   const peek=await operation(client,id);if(!peek||!['run','start'].includes(peek.action))cas();
   const existing=peek.instance_id?await node(client,identity(peek),true):null;
   const op=await operation(client,id,true);
   if(!op||op.state!=='intent'||Number(op.revision)!==revision||op.dispatched_at||op.provider_request_id||!op.request||op.request_sha256.trim()!==sha(op.request))cas();
   if(existing&&(existing.state!=='starting'||existing.cloud_start_operation_id!==id||existing.source_sha256.trim()!==op.request.source_sha256||existing.image_sha256.trim()!==op.request.image_sha256||existing.launch_manifest_sha256.trim()!==op.request.launch_manifest_sha256||sha(existing.expected_services)!==sha(op.request.services)||sha([...existing.capabilities].sort())!==sha([...op.request.capabilities].sort())))cas();
   if((await client.query("SELECT 1 FROM bb_execution_cloud_operations WHERE operation_id<>$1 AND state IN ('intent','submitted','unknown') LIMIT 1",[id])).rowCount)throw Error('EXECUTION_CLOUD_MUTATION_PENDING');
   const inventory=Number((await client.query('SELECT count(*) AS n FROM bb_execution_nodes WHERE destroyed_at IS NULL')).rows[0].n);
   if(inventory+(op.action==='run'?1:0)>Number(p.max_nodes))throw Error('EXECUTION_MAX_NODES_REACHED');
   if(existing&&(await client.query('SELECT 1 FROM bb_model_capacity_holders WHERE execution_node_id=$1',[existing.id])).rowCount)throw Error('EXECUTION_PRIOR_PROCESS_NOT_STOPPED');
   await client.query('UPDATE bb_execution_cloud_operations SET policy_revision=$2,revision=revision+1 WHERE operation_id=$1',[id,p.revision]);
   return opDto(await operation(client,id));
  }),
  cancelUndispatchedCloudIntent:async(id,revision,policyRevision)=>transaction(pool,async client=>{
   const p=(await client.query('SELECT * FROM bb_execution_capacity_policy WHERE singleton FOR UPDATE')).rows[0];
   if(Number(p.revision)!==policyRevision)cas(); // A revoked budget must still permit safe cancellation.
   const peek=await operation(client,id);if(!peek||!['run','start'].includes(peek.action))cas();
   const existing=peek.instance_id?await node(client,identity(peek),true):null;
   const op=await operation(client,id,true);
   if(!op||op.state!=='intent'||Number(op.revision)!==revision||op.dispatched_at||op.provider_request_id)cas();
   if(op.action==='run'&&existing||op.action==='start'&&(!existing||!op.node_preimage||!op.reserved_node_preimage))cas();
   await client.query("UPDATE bb_execution_cloud_operations SET state='cancelled',revision=revision+1,completed_at=clock_timestamp() WHERE operation_id=$1",[id]);
   if(existing){
    // Restore the stopped predecessor only against the complete reservation image.
    // The epoch trigger additionally checks no service, lease or model work began.
    const restored=await client.query(`UPDATE bb_execution_nodes n SET epoch=prior.epoch,state=prior.state,revision=n.revision+1,
     source_sha256=prior.source_sha256,image_sha256=prior.image_sha256,capabilities=prior.capabilities,
     cloud_start_operation_id=prior.cloud_start_operation_id,expected_services=prior.expected_services,
     launch_manifest_sha256=prior.launch_manifest_sha256,stop_operation_id=prior.stop_operation_id,
     drain_operation_id=prior.drain_operation_id,drain_proof=prior.drain_proof,registration_token_sha256=prior.registration_token_sha256
     FROM jsonb_populate_record(NULL::bb_execution_nodes,$2::jsonb) prior WHERE n.id=$1 AND to_jsonb(n)=$3::jsonb`,[existing.id,op.node_preimage,op.reserved_node_preimage]);
    if(restored.rowCount!==1)cas();
   }
   return opDto(await operation(client,id));
  }),
  claimCloudDispatch:async(id,revision)=>transaction(pool,async client=>{
   const policy=(await client.query('SELECT * FROM bb_execution_capacity_policy WHERE singleton FOR SHARE')).rows[0];
   const peek=await operation(client,id);if(peek?.action==='destroy')throw Error('EXECUTION_DESTROY_UNSUPPORTED');
   // Match completion's policy -> node -> operation lock order.
   const stoppedNode=peek?.action==='stop'?await node(client,identity(peek),true):null;
   const op=await operation(client,id,true);if(!op||op.state!=='intent'||Number(op.revision)!==revision)cas();
   if(op.action==='stop')await validatePersistedStop(client,stoppedNode,op);
   if(['run','start'].includes(op.action)){if(!policy.managed_nodes||!policy.budget_available||policy.launch_blocked_by_operation_id||policy.revision!==op.policy_revision||policy.cooldown_until&&new Date(policy.cooldown_until).getTime()>Date.now())cas();}
   await client.query("UPDATE bb_execution_cloud_operations SET state='unknown',revision=revision+1,dispatched_at=clock_timestamp() WHERE operation_id=$1",[id]);return opDto(await operation(client,id));
  }),
  beginDrain:async(i,id,revision)=>transaction(pool,async client=>{
   const n=await node(client,i,true);
   if(n.drain_operation_id===id&&['draining','drained','stop_submitted','stopped'].includes(n.state))return dto(client,n);
   if(Number(n.revision)!==revision||!['ready','lost'].includes(n.state))cas();
   await client.query("UPDATE bb_execution_nodes SET state='draining',drain_operation_id=$2,revision=revision+1,drain_proof=NULL WHERE id=$1",[n.id,id]);return dto(client,await node(client,i));
  }),
  drainProof:async(i,id)=>transaction(pool,async client=>{
   const n=await node(client,i,true);if(n.drain_operation_id!==id||!['draining','drained'].includes(n.state))cas();
   if(n.state==='drained')return n.drain_proof as ExecutionDrainProof;
   const counts=await dto(client,n);const sessions=(await client.query('SELECT * FROM bb_execution_node_sessions WHERE node_id=$1 AND epoch=$2 ORDER BY session_id FOR UPDATE',[n.id,n.epoch])).rows;
   if(counts.active_leases||counts.active_model_calls||!sessions.length||sessions.some(s=>s.state!=='finished'||s.native_processes!==0||s.unpersisted_results!==0||!s.finished_at)||n.expected_services.some((service:any)=>!sessions.some(s=>s.service_id===service.service_id)))return null;
   const unknown=Number((await client.query("SELECT count(*) AS n FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id WHERE j.execution_node_id=$1 AND j.execution_node_epoch=$2 AND a.status='pending_reconcile'",[n.id,n.epoch])).rows[0].n);
   const body={version:'execution-drain-v1' as const,identity:i,operation_id:id,node_revision:Number(n.revision)+1,observed_at:new Date().toISOString(),active_leases:0 as const,active_model_calls:0 as const,native_processes:0 as const,unpersisted_results:0 as const,positive_session_receipts:sessions.length,accounted_unknown_calls:unknown};
   const proof={...body,proof_sha256:sha({body,sessions})};
   await client.query("UPDATE bb_execution_nodes SET state='drained',revision=revision+1,drain_proof=$2 WHERE id=$1",[n.id,proof]);return proof;
  }),
  submitStop:async(proof,action)=>transaction(pool,async client=>{
   if(action!=='stop')throw Error('EXECUTION_DESTROY_UNSUPPORTED');
   const n=await node(client,proof.identity,true);const prior=await operation(client,proof.operation_id,true);if(prior){if(prior.proof_sha256?.trim()!==proof.proof_sha256||prior.action!==action)cas();return opDto(prior);}
   if(n.state!=='drained'||Number(n.revision)!==proof.node_revision||n.drain_proof?.proof_sha256!==proof.proof_sha256||n.drain_operation_id!==proof.operation_id)cas();
   // Re-check under the node lock. A registration/claim cannot race this fence.
   const fresh=await dto(client,n);if(fresh.active_leases||fresh.active_model_calls)throw Error('EXECUTION_DRAIN_PROOF_STALE');
   await client.query("INSERT INTO bb_execution_cloud_operations(operation_id,account_id,region,instance_id,epoch,action,state,request_sha256,client_token,proof_sha256,request) VALUES($1,$2,$3,$4,$5,$6,'intent',$7,$8,$9,$10)",[proof.operation_id,n.account_id,n.region,n.instance_id,n.epoch,action,sha(proof),executionCloudClientToken(proof.operation_id),proof.proof_sha256,{kind:'graceful-drain',proof}]);
   await client.query("UPDATE bb_execution_nodes SET state='stop_submitted',stop_operation_id=$2,revision=revision+1 WHERE id=$1",[n.id,proof.operation_id]);return opDto(await operation(client,proof.operation_id));
  }),
  recordCloudResult:async(id,revision,result)=>recordExecutionCloudResult(pool,id,revision,result),
 };
}

async function recordExecutionCloudResult(pool:Pool,id:string,revision:number,result:ExecutionCloudResult):Promise<ExecutionCloudOperation>{
 return transaction(pool,async client=>{
  await client.query('SELECT singleton FROM bb_execution_capacity_policy WHERE singleton FOR UPDATE');
  const peek=await operation(client,id);if(!peek)cas();
  if(peek.instance_id&&peek.action!=='run')await node(client,identity(peek),true);
  const op=await operation(client,id,true);if(!op||Number(op.revision)!==revision||!['unknown','submitted'].includes(op.state))cas();
  if(result.state==='rejected'){
   const e=result.rejection_evidence;
   if(op.action!=='run'||op.state!=='unknown'||op.instance_id||op.provider_request_id||op.request?.instance_count!==1||result.identity||result.observation||!result.provider_request_id||!e||!Value.Check(ExecutionCloudRejectionSchema,e)||!Number.isFinite(Date.parse(e.retry_after))||Date.parse(e.retry_after)<Date.now()+1000||Date.parse(e.retry_after)>Date.now()+86400000)throw Error('EXECUTION_CLOUD_REJECTION_UNPROVEN');
   await client.query("UPDATE bb_execution_cloud_operations SET state='rejected',revision=revision+1,provider_request_id=$2,rejection_evidence=$3,retry_after=$4 WHERE operation_id=$1",[id,result.provider_request_id,e,e.retry_after]);
   await client.query('UPDATE bb_execution_capacity_policy SET cooldown_until=GREATEST(cooldown_until,$1::timestamptz) WHERE singleton',[e.retry_after]);
   return opDto(await operation(client,id));
  }
  if(result.rejection_evidence)throw Error('EXECUTION_CLOUD_REJECTION_UNPROVEN');
  if(result.identity){
   if(result.identity.account_id!==op.account_id||result.identity.region!==op.region||result.identity.epoch!==op.epoch||op.instance_id&&result.identity.instance_id!==op.instance_id)cas();
  }else if(op.instance_id||op.action!=='run'||result.state==='completed')cas();
  if(result.run_acceptance){
   if(result.state!=='submitted'||op.action!=='run'||!executionRunAcceptanceMatches({...opDto(op),identity:result.identity,provider_request_id:result.provider_request_id},result.run_acceptance)||
    op.run_acceptance&&sha(op.run_acceptance)!==sha(result.run_acceptance))throw Error('EXECUTION_RUN_ACCEPTANCE_UNPROVEN');
  }
  if(op.action==='run'&&result.state==='submitted'&&!result.run_acceptance)throw Error('EXECUTION_RUN_ACCEPTANCE_UNPROVEN');
  if(result.state==='completed'){
   const o=result.observation;
   if(!result.identity||!o||!Value.Check(ExecutionCloudObservationSchema,o)||!op.provider_request_id||!executionCloudCompletionMatches(opDto(op),o)
    ||result.provider_request_id!==op.provider_request_id||!Number.isFinite(Date.parse(o.observed_at))
    ||Date.parse(o.observed_at)<new Date(op.dispatched_at).getTime()||Date.parse(o.observed_at)>Date.now()+30000)throw Error('EXECUTION_CLOUD_COMPLETION_UNPROVEN');
  }
  if(op.provider_request_id&&result.provider_request_id&&op.provider_request_id!==result.provider_request_id)cas();
  await client.query(`UPDATE bb_execution_cloud_operations SET state=$2,revision=revision+1,provider_request_id=COALESCE(provider_request_id,$3),
   instance_id=COALESCE(instance_id,$4),cloud_observation=$5,completed_at=CASE WHEN $2='completed' THEN clock_timestamp() ELSE NULL END,
   run_acceptance=COALESCE(run_acceptance,$6) WHERE operation_id=$1`,[id,result.state,result.provider_request_id,result.identity?.instance_id??null,result.observation,result.run_acceptance??null]);
  if(result.state==='completed'&&result.identity){
   if(['run','start'].includes(op.action)){
    const request=op.request as ExecutionLaunchRequest;
    if(op.action==='run')await client.query(`INSERT INTO bb_execution_nodes(id,account_id,region,instance_id,epoch,state,source_sha256,image_sha256,launch_manifest_sha256,capabilities,expected_services,cloud_start_operation_id)
     VALUES($1,$2,$3,$4,$5,'starting',$6,$7,$8,$9,$10,$11)`,[randomUUID(),result.identity.account_id,result.identity.region,result.identity.instance_id,result.identity.epoch,request.source_sha256,request.image_sha256,request.launch_manifest_sha256,request.capabilities,JSON.stringify(request.services),id]);
   }else{
    const n=await node(client,result.identity,true);if(n.state!=='stop_submitted'||n.stop_operation_id!==id)cas();
    // Full contemporaneous preimage is locked, sealed, then CAS-deleted. Cloud
    // completion authorizes capacity recovery, never supplier/billing replay.
    const holders=(await client.query('SELECT row_to_json(h) AS preimage FROM bb_model_capacity_holders h WHERE execution_node_id=$1 AND execution_node_epoch=$2 ORDER BY token FOR UPDATE',[n.id,n.epoch])).rows.map(r=>r.preimage);
    await client.query('UPDATE bb_execution_cloud_operations SET holder_preimage=$2 WHERE operation_id=$1',[id,JSON.stringify(holders)]);
    for(const h of holders){const deleted=await client.query('DELETE FROM bb_model_capacity_holders h WHERE token=$1 AND row_to_json(h)::jsonb=$2::jsonb',[h.token,JSON.stringify(h)]);if(deleted.rowCount!==1)cas();}
    // Positively stopped epoch cannot commit any more. Keep unknown attempts and
    // charges intact; recovered jobs reconcile the original call before retry.
    await fenceStoppedExecutionEpoch(client,n.id,n.epoch);
    await client.query("UPDATE bb_execution_node_sessions SET state='lost',ready=false WHERE node_id=$1 AND epoch=$2 AND state='active'",[n.id,n.epoch]);
    await client.query("UPDATE bb_execution_nodes SET state='stopped',revision=revision+1,destroyed_at=CASE WHEN $2 THEN clock_timestamp() ELSE destroyed_at END WHERE id=$1",[n.id,op.action==='destroy']);
   }
  }
  return opDto(await operation(client,id));
 });
}

/** An explicit operator may fence a lost node for replacement. This is not a
 * graceful proof: no capacity/unknown call is released until Describe proves
 * the exact StopInstances request completed on that instance and epoch. */
export async function submitFencedExecutionStop(pool:Pool,i:ExecutionNodeIdentity,id:string,revision:number,action:'stop'|'destroy'){
 if(action!=='stop')throw Error('EXECUTION_DESTROY_UNSUPPORTED');
 return transaction(pool,async client=>{
  const n=await node(client,i,true),prior=await operation(client,id,true);
  if(prior){
   const a=opDto(prior).stop_authorization;
   if(!executionStopAuthorizationMatches(opDto(prior),sha)||a?.kind!=='operator-fence'||a.proof.node_revision!==revision||!sameIdentity(identity(prior),i)||n.stop_operation_id!==id)cas();
   return opDto(prior); // Same durable token, including unknown; never another intent.
  }
  if(n.state!=='lost'||Number(n.revision)!==revision)cas();
  const start=await operation(client,n.cloud_start_operation_id);
  if(!start||start.state!=='completed'||!['run','start'].includes(start.action)||!start.provider_request_id||!sameIdentity(identity(start),i)||
   start.request?.source_sha256!==n.source_sha256.trim()||start.request?.image_sha256!==n.image_sha256.trim()||start.request?.launch_manifest_sha256!==n.launch_manifest_sha256.trim())throw Error('EXECUTION_FENCE_START_BINDING_INVALID');
  const holders=(await client.query('SELECT row_to_json(h) AS row FROM bb_model_capacity_holders h WHERE execution_node_id=$1 ORDER BY token FOR UPDATE',[n.id])).rows.map(r=>r.row);
  // Hash the same JSON representation that pg persists. Its Date values become
  // ISO strings; changing the shared token/drain canonicalizer would break pins.
  const nodePreimage=JSON.parse(JSON.stringify(n));
  const body={version:'execution-operator-fence-v1' as const,identity:i,operation_id:id,action:'stop' as const,node_state:'lost' as const,node_revision:revision,cloud_start_operation_id:n.cloud_start_operation_id,
   cloud_start_provider_request_id:start.provider_request_id,source_sha256:n.source_sha256.trim(),image_sha256:n.image_sha256.trim(),launch_manifest_sha256:n.launch_manifest_sha256.trim(),node_preimage_sha256:sha(nodePreimage),holder_preimage_sha256:sha(holders)};
  const authorization={kind:'operator-fence' as const,proof:{...body,proof_sha256:sha(body)}};
  if(!executionStopAuthorizationMatches({operation_id:id,identity:i,action:'stop',proof_sha256:authorization.proof.proof_sha256,stop_authorization:authorization} as ExecutionCloudOperation,sha))throw Error('EXECUTION_STOP_AUTHORIZATION_INVALID');
  await client.query("INSERT INTO bb_execution_cloud_operations(operation_id,account_id,region,instance_id,epoch,action,state,request_sha256,client_token,holder_preimage,proof_sha256,request,node_preimage) VALUES($1,$2,$3,$4,$5,$6,'intent',$7,$8,$9,$10,$11,$12)",[id,n.account_id,n.region,n.instance_id,n.epoch,action,sha(authorization),executionCloudClientToken(id),JSON.stringify(holders),authorization.proof.proof_sha256,authorization,{version:'execution-operator-fence-preimage-v1',node:nodePreimage,holders}]);
  await client.query("UPDATE bb_execution_nodes SET state='stop_submitted',stop_operation_id=$2,revision=revision+1 WHERE id=$1",[n.id,id]);return opDto(await operation(client,id));
 });
}
export async function markExecutionNodeLost(pool:Pool,i:ExecutionNodeIdentity,revision:number){return transaction(pool,async client=>{const n=await node(client,i,true);if(Number(n.revision)!==revision||!['starting','ready','draining'].includes(n.state))cas();await client.query("UPDATE bb_execution_nodes SET state='lost',revision=revision+1 WHERE id=$1",[n.id]);return dto(client,await node(client,i));});}
export async function configureExecutionCapacity(pool:Pool,revision:number,input:{managed_nodes:boolean;global_model_limit:number;max_nodes:number;budget_available:boolean;provider_concurrency_limit?:number;provider_policy_sha256?:string;expense_policy_sha256?:string}){
 return transaction(pool,async client=>{const row=(await client.query('SELECT * FROM bb_execution_capacity_policy WHERE singleton FOR UPDATE')).rows[0];if(Number(row.revision)!==revision)cas();await client.query('UPDATE bb_execution_capacity_policy SET managed_nodes=$1,global_model_limit=$2,max_nodes=$3,budget_available=$4,provider_concurrency_limit=$5,provider_policy_sha256=$6,expense_policy_sha256=$7,revision=revision+1 WHERE singleton',[input.managed_nodes,input.global_model_limit,input.max_nodes,input.budget_available,input.provider_concurrency_limit??4,input.provider_policy_sha256??null,input.expense_policy_sha256??null]);});
}

export async function executionCapacitySnapshot(pool:Pool):Promise<ExecutionCapacitySnapshot>{
 return transaction(pool,async client=>{
  await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  const p=(await client.query('SELECT * FROM bb_execution_capacity_policy WHERE singleton')).rows[0];
  const nodes:ExecutionNode[]=[];for(const n of (await client.query('SELECT * FROM bb_execution_nodes WHERE destroyed_at IS NULL ORDER BY account_id,region,instance_id')).rows)nodes.push(await dto(client,n));
  const holders=Number((await client.query('SELECT count(*) AS n FROM bb_model_capacity_holders')).rows[0].n);
  // Already-admitted jobs only. Expiry alone does not turn an owned job into
  // demand, and unknown call/journal state is excluded before group de-dup.
  const rows=(await client.query(`SELECT j.*,r.task_kind,r.state AS run_state,r.input_hash,r.input_revision,r.project_id,r.reservation_id,
   ir.manifest AS locked_manifest,ir.input_hash AS locked_hash,
   EXISTS(SELECT 1 FROM bb_billing_safety_blocks l WHERE l.scope_key='wallet:'||j.owner_user_id AND l.resume_event_id IS NULL AND r.reservation_id IS NOT NULL) AS payment_blocked,
   i.batch_id,i.item_id FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id AND r.owner_user_id=j.owner_user_id
   JOIN bb_projects p ON p.id=r.project_id AND p.owner_user_id=r.owner_user_id
   LEFT JOIN bb_input_revisions ir ON ir.project_id=r.project_id AND ir.owner_user_id=r.owner_user_id AND ir.revision=r.input_revision
   LEFT JOIN bb_workpaper_items i ON i.run_id=j.run_id AND i.owner_user_id=j.owner_user_id
   WHERE j.job_type<>'parse' AND j.state IN ('queued','running','paused') AND r.state NOT IN ('succeeded','failed','cancelled','rejected','test_completed')
   AND p.archived_at IS NULL AND p.deleted_at IS NULL ORDER BY j.created_at,j.id`)).rows;
  const excluded={shared_plan_waiter:0,paused:0,payment_blocked:0,unknown_call:0,active_lease:0,unready_input:0,batch_window:0};
  const work:{capability:'authoring'|'review'|'assistant'|'probe';created:Date;key:string}[]=[];
  const batches=new Map<string,ExecutionBatchDemand>(),batchUsed=new Map<string,number>();
  for(const row of rows){
   if(await providerCallNeedsReconciliation(client,row.id)){excluded.unknown_call++;continue;}
   if(row.payment_blocked||row.credit_pause_requested||row.billing_cancel_requested_at){excluded.payment_blocked++;continue;}
   if(row.state==='paused'||['paused','awaiting_input','preparing'].includes(row.run_state)||row.user_pause_requested){excluded.paused++;continue;}
   if(row.lease_token){excluded.active_lease++;continue;}
   if(row.state!=='queued'||!row.locked_manifest||row.locked_hash.trim()!==row.input_hash.trim()||inputManifestHash(row.locked_manifest)!==row.input_hash.trim()){excluded.unready_input++;continue;}
   let key='job:'+row.id;
   if(row.batch_id){
    let b=batches.get(row.batch_id);
    if(!b){
     const frozen=(await client.query('SELECT * FROM bb_workpaper_batches WHERE id=$1 AND owner_user_id=$2',[row.batch_id,row.owner_user_id])).rows[0];
     const items=(await client.query('SELECT item_id,attempt,manifest FROM bb_workpaper_items WHERE batch_id=$1 AND owner_user_id=$2 ORDER BY ordinal',[row.batch_id,row.owner_user_id])).rows;
     const source=(await client.query('SELECT * FROM bb_workpaper_shared_sources WHERE batch_id=$1 AND owner_user_id=$2',[row.batch_id,row.owner_user_id])).rows[0];
     const whole=(await client.query('SELECT * FROM bb_workpaper_shared_plans WHERE batch_id=$1 AND owner_user_id=$2',[row.batch_id,row.owner_user_id])).rows[0];
     const itemPlans=(await client.query('SELECT item_id,plan,plan_hash FROM bb_workpaper_progressive_plans WHERE batch_id=$1 AND owner_user_id=$2',[row.batch_id,row.owner_user_id])).rows;
     const groups=(await client.query('SELECT group_id,receipt,receipt_hash FROM bb_workpaper_progressive_groups WHERE batch_id=$1 AND owner_user_id=$2',[row.batch_id,row.owner_user_id])).rows;
     b={...frozen,items,invalidInput:!!source&&(source.input_hash.trim()!==inputManifestHash({version:'workpaper-shared-v1',manifests:items.map(i=>i.manifest)})||source.snapshot_hash.trim()!==inputManifestHash(source.snapshot))||!!whole&&whole.plan_hash.trim()!==inputManifestHash(whole.plan)||itemPlans.some(i=>i.plan_hash.trim()!==inputManifestHash(i.plan))||groups.some(g=>inputManifestHash(g.receipt)!==g.receipt_hash.trim()),sourceReady:!!source&&source.input_hash.trim()===inputManifestHash({version:'workpaper-shared-v1',manifests:items.map(i=>i.manifest)})&&source.snapshot_hash.trim()===inputManifestHash(source.snapshot),wholePlanReady:!!whole,itemPlans:new Set(itemPlans.map(i=>i.item_id)),groupReceipts:new Map(groups.filter(g=>inputManifestHash(g.receipt)===g.receipt_hash.trim()).map(g=>[g.group_id.trim(),g.receipt]))} as ExecutionBatchDemand;batches.set(row.batch_id,b);
    }
    const own=b.items.find(i=>i.item_id===row.item_id);
    if(!own||inputManifestHash(own.manifest)!==row.input_hash.trim()){excluded.unready_input++;continue;}
    if(['paused','cancelled','complete','partial'].includes(b.state)||b.progressive_phase==='awaiting_confirmation'){excluded.paused++;continue;}
    if(b.progressive_phase==='trial'&&!b.progressive_plan?.trial_item_ids.includes(row.item_id)){excluded.batch_window++;continue;}
    const demand=workpaperDemandKey(row.batch_id,row.item_id,b);
    if(!demand.key){excluded[demand.reason??'unready_input']++;continue;}
    if((batchUsed.get(row.batch_id)??0)>=Number(b.progressive_plan?.max_parallel??b.max_parallel??1)){excluded.batch_window++;continue;}
    key=demand.key;batchUsed.set(row.batch_id,(batchUsed.get(row.batch_id)??0)+1);
   }
   if(work.some(w=>w.key===key)){excluded.shared_plan_waiter++;continue;}
   work.push({capability:row.job_type==='platform_probe'?'probe':row.task_kind==='review'?'review':'authoring',created:new Date(),key});
  }
  const messages=(await client.query(`SELECT m.*,EXISTS(SELECT 1 FROM bb_review_assistant_attempts a WHERE a.message_id=m.id AND a.status='pending_reconcile') AS unknown,
   EXISTS(SELECT 1 FROM bb_billing_safety_blocks l WHERE l.scope_key='wallet:'||m.owner_user_id AND l.resume_event_id IS NULL) AS payment_blocked
   FROM bb_review_messages m JOIN bb_projects p ON p.id=m.project_id AND p.owner_user_id=m.owner_user_id
   WHERE m.role='user' AND m.reply_status IN ('queued','running','unknown') AND p.archived_at IS NULL AND p.deleted_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM bb_review_messages prior WHERE prior.owner_user_id=m.owner_user_id AND prior.project_id=m.project_id AND prior.role='user' AND prior.reply_status IN ('queued','running') AND (prior.created_at,prior.id)<(m.created_at,m.id))`)).rows;
  for(const m of messages){
   if(m.unknown||m.reply_status==='unknown'){excluded.unknown_call++;continue;}
   if(m.payment_blocked){excluded.payment_blocked++;continue;}
   if(m.lease_token){excluded.active_lease++;continue;}
   if(m.reply_status!=='queued'||!m.context_snapshot||inputManifestHash({project_id:m.project_id,content:m.content,context:m.context})!==m.request_hash.trim()){excluded.unready_input++;continue;}
   work.push({capability:'assistant',created:new Date(),key:'assistant:'+m.id});
  }
  // The hardware wait starts at first observed executable eligibility, never
  // submission time while payment/business/shared dependencies were blocked.
  const keys=work.map(w=>w.key);
  await client.query('DELETE FROM bb_execution_work_readiness WHERE NOT (work_key=ANY($1::text[]))',[keys]);
  for(const w of work){const r=(await client.query('INSERT INTO bb_execution_work_readiness(work_key,capability) VALUES($1,$2) ON CONFLICT(work_key) DO UPDATE SET capability=EXCLUDED.capability RETURNING ready_since',[w.key,w.capability])).rows[0];w.created=r.ready_since;}
  const oldest=(w:typeof work)=>w.length?Math.max(0,Math.floor((Date.now()-Math.min(...w.map(x=>x.created.getTime())))/1000)):null;
  const capabilities=['authoring','review','assistant','probe'] as const;
  return {version:'execution-capacity-v1',observed_at:new Date().toISOString(),policy:policyDto(p),nodes,
   pending_cloud_reservations:Number((await client.query("SELECT count(*) AS n FROM bb_execution_cloud_operations WHERE state IN ('intent','submitted','unknown')")).rows[0].n),active_model_calls:holders,available_model_slots:p.budget_available?Math.max(0,p.global_model_limit-holders):0,effective_queued_work:work.length,oldest_wait_seconds:oldest(work),groups:capabilities.map(capability=>({capability,effective_queued_work:work.filter(w=>w.capability===capability).length,oldest_wait_seconds:oldest(work.filter(w=>w.capability===capability)),occupied_run_slots:nodes.filter(n=>n.capabilities.includes(capability)).reduce((s,n)=>s+n.active_leases,0),available_run_slots:nodes.filter(n=>n.capabilities.includes(capability)).reduce((s,n)=>s+n.ready_slots,0)})),excluded};
 });
}

/** Read-only pool expense source, including old unresolved operations. Financial
 * estimation consumes this history with an approved price manifest, not a file bool. */
export async function executionCloudExpenseLedger(pool:Pool):Promise<ExecutionCloudExpenseLedger>{
 return transaction(pool,async client=>{
  await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const captured=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at;
  const operations=(await client.query('SELECT * FROM bb_execution_cloud_operations ORDER BY created_at,operation_id')).rows.map(r=>({...opDto(r),created_at:r.created_at.toISOString(),dispatched_at:r.dispatched_at?.toISOString()??null,completed_at:r.completed_at?.toISOString()??null,cloud_observation:r.cloud_observation,rejection_evidence:r.rejection_evidence}));
  const nodes=(await client.query('SELECT * FROM bb_execution_nodes ORDER BY account_id,region,instance_id')).rows.map(r=>({identity:identity(r),state:r.state,created_at:r.created_at.toISOString(),destroyed_at:r.destroyed_at?.toISOString()??null,cloud_start_operation_id:r.cloud_start_operation_id,stop_operation_id:r.stop_operation_id,launch_manifest_sha256:r.launch_manifest_sha256.trim()}));
  return {captured_at:captured.toISOString(),operations,nodes};
 });
}
