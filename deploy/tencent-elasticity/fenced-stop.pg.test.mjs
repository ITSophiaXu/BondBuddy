import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {Value} from '@sinclair/typebox/value';
import {ExecutionCloudOperationSchema} from '@bondbuddy/contracts';
import {executionCapacityControl,configureExecutionCapacity,submitFencedExecutionStop,markExecutionNodeLost,bindExecutionRegistration,registerExecutionRuntime,heartbeatExecutionRuntime,executionClaimGate,executionCloudExpenseLedger} from '@bondbuddy/api/execution-capacity';
import {transaction} from '../../apps/api/dist/data.js';
import {isolatedTestDatabase} from '../../apps/api/dist/test-database.js';
import {inputManifestHash} from '../../apps/api/dist/production-rule-pin.js';
import {ExecutionPoolController} from './controller.mjs';
import {TencentCvm,TencentTransport} from './tencent-cvm.mjs';
import {canonical,sha256} from './policy.mjs';

const h='a'.repeat(64),hash=v=>sha256(canonical(v));
const services=[{service_id:'authoring',capabilities:['authoring']},{service_id:'review',capabilities:['review']}];
const config={version:'tencent-execution-pool-v1',enabled:true,phase:'automatic',account_id:'123456',pool_tag:'bondbuddy-execution',region:'ap-beijing',zone:'ap-beijing-7',instance_type:'SA9.LARGE16',min_running:1,max_owned:2,resident_instance_id:'ins-a1',global_model_limit:4,node_model_limit:4,compute_cny_per_hour:.8,compute_cap_cny_per_hour:1.6,scale_up_wait_seconds:60,idle_seconds:300,failure_cooldown_seconds:300,image_id:'img-a1',vpc_id:'vpc-a1',subnet_id:'subnet-a1',security_group_id:'sg-a1',source_sha256:h,image_sha256:h,network_review_sha256:h,quote_sha256:h,role_names:['node-a','node-b'],noncompute_cap_cny_per_hour:.8,total_cap_cny_per_hour:2.4,stop_charging_verified:true,stop_charging_evidence_sha256:h,private_pg_verified:true,service_credentials_verified:true,services,expense_policy_revision:1,expense_policy_sha256:h,time_zone:'Asia/Shanghai',period_cap_cny:48,reservation_hours:1,drain_reserve_hours:1};
config.node_secrets=config.role_names.map((role_name,index)=>({role_name,role_id:String(index+7),secret_name:'node-secret-'+index}));

// All CVM/STS HTTP and process identities below are synthetic. PostgreSQL,
// transactions, triggers, controller and Tencent adapter/TC3 code are real.
async function fixture(t,key,{ready=false}={}){
 const url=await isolatedTestDatabase(undefined,'fenced-stop-'+key),pool=new Pool({connectionString:url,max:4});
 t.after(()=>pool.end());
 const policy=(await pool.query('SELECT revision FROM bb_execution_capacity_policy WHERE singleton')).rows[0];
 await configureExecutionCapacity(pool,Number(policy.revision),{managed_nodes:true,global_model_limit:4,max_nodes:2,budget_available:true,expense_policy_sha256:h});
 const control=executionCapacityControl(pool),startId='synthetic-start-'+randomUUID(),epoch=randomUUID();
 const request={account_id:config.account_id,region:config.region,instance_id:null,instance_count:1,epoch,source_sha256:h,image_sha256:h,launch_manifest_sha256:h,capabilities:['authoring','review'],services};
 const intent=await control.reserveStart(request,startId,(await control.snapshot()).policy.revision),claimed=await control.claimCloudDispatch(startId,intent.revision);
 const identity={account_id:request.account_id,region:request.region,instance_id:'ins-a1',epoch},ack='synthetic-run-ack';
 const acceptance={operation_id:startId,identity,provider_request_id:ack,instance_ids:[identity.instance_id],client_token:claimed.client_token,launch_manifest_sha256:h,launch_binding_sha256:h,evidence_ref:'synthetic/accepted',evidence_sha256:h};
 const sent=await control.recordCloudResult(startId,claimed.revision,{state:'submitted',identity,provider_request_id:ack,observation:null,run_acceptance:acceptance});
 await control.recordCloudResult(startId,sent.revision,{state:'completed',identity,provider_request_id:ack,observation:{instance_state:'RUNNING',latest_operation:null,latest_operation_state:null,latest_operation_request_id:null,stop_charging_mode:null,observed_at:new Date().toISOString(),evidence_ref:'synthetic/run-status',evidence_sha256:h,run_creation:{operation_id:startId,identity,launch_manifest_sha256:h,launch_binding_sha256:h,created_at:claimed.dispatched_at,instance_status:'RUNNING',status_request_id:'synthetic-status'}}});
 const instance={InstanceId:identity.instance_id,InstanceState:'RUNNING',CamRoleName:'node-a',Placement:{Zone:config.zone},InstanceType:config.instance_type,InstanceChargeType:'POSTPAID_BY_HOUR',VirtualPrivateCloud:{VpcId:config.vpc_id,SubnetId:config.subnet_id},ImageId:config.image_id,SecurityGroupIds:[config.security_group_id],SystemDisk:{DiskSize:40,DiskType:'CLOUD_PREMIUM'},DataDisks:[{DiskSize:80,DiskType:'CLOUD_PREMIUM'}],PublicIpAddresses:[],Tags:[{Key:'bondbuddy-pool',Value:config.pool_tag},{Key:'bondbuddy-execution-slot',Value:'node-a'},{Key:'bondbuddy-create-op',Value:startId}],LatestOperation:null,LatestOperationState:null,LatestOperationRequestId:null,StopChargingMode:null};
 const state={http:[],stopCalls:0,loseAck:false},sessions=[];
 const transport=new TencentTransport({region:config.region,credentials:async()=>({secretId:'synthetic',secretKey:'synthetic',token:'synthetic',expiresAt:Date.now()+600000}),fetchImpl:async(_url,options)=>{
  const action=options.headers['X-TC-Action'],p=JSON.parse(options.body);state.http.push(action);
  if(action==='GetCallerIdentity')return Response.json({Response:{AccountId:config.account_id,RequestId:'synthetic-sts'}});
  if(action==='DescribeInstances')return Response.json({Response:{TotalCount:1,InstanceSet:[instance],RequestId:'synthetic-describe'}});
  assert.equal(action,'StopInstances');assert.deepEqual(p,{InstanceIds:[identity.instance_id],StopType:'SOFT',StoppedMode:'STOP_CHARGING'});
  state.stopCalls++;instance.InstanceState='STOPPED';instance.LatestOperation='StopInstances';instance.LatestOperationState='SUCCESS';instance.LatestOperationRequestId='synthetic-stop-ack';instance.StopChargingMode='STOP_CHARGING';
  if(state.loseAck)throw Error('synthetic network loss after acceptance');
  return Response.json({Response:{RequestId:'synthetic-stop-ack'}});
 }});
 const cloud=new TencentCvm({config,transport,archive:async bytes=>({ref:'synthetic/archive/'+sha256(bytes),sha256:sha256(bytes)})});
 const controller=new ExecutionPoolController({control,cloud,config});
 const current=async()=> (await control.snapshot()).nodes.find(n=>n.identity.instance_id===identity.instance_id);
 if(ready){
  const token='synthetic-registration-token-'+randomUUID();await bindExecutionRegistration(pool,identity,startId,token);
  for(const service of services){const runtime=new Pool({connectionString:url,max:2});t.after(()=>runtime.end());const context={identity,session_id:randomUUID()};
   await registerExecutionRuntime(runtime,context,{source_sha256:h,image_sha256:h,launch_manifest_sha256:h,registration_token:token,service_id:service.service_id,capabilities:service.capabilities,process_identity:{pid:'1',boot:'synthetic'}});
   await heartbeatExecutionRuntime(runtime,{ready:true,native_processes:0,unpersisted_results:0});sessions.push({pool:runtime,context});
  }
 }
 const fence=async()=>{const n=await current(),lost=await markExecutionNodeLost(pool,identity,n.revision),id='synthetic-stop-'+randomUUID();return {op:await submitFencedExecutionStop(pool,identity,id,lost.revision,'stop'),lostRevision:lost.revision};};
 return {pool,control,controller,cloud,identity,startId,state,instance,sessions,current,fence};
}

async function ownedPendingCall(f){
 const session=f.sessions[0],id=randomUUID(),owner='synthetic-fence-owner',manifest={synthetic:true},ih=inputManifestHash(manifest),lease=randomUUID(),holder=randomUUID();
  await f.pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'synthetic fence','generation')",[id,owner]);
  await f.pool.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,$4,'[]','[]')",[id,owner,ih,manifest]);
  await f.pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$1,1,$3,$1,'generation',$3,'queued')",[id,owner,ih]);
  await f.pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state) VALUES($1,$2,$1,'generation','default','queued')",[id,owner]);
  await transaction(session.pool,async c=>{
   await executionClaimGate(c,session.pool);await c.query("UPDATE bb_jobs SET state='running',lease_token=$2,lease_until=now()+interval '120 seconds' WHERE id=$1",[id,lease]);
   await c.query("SELECT set_config('bb.execution_lease_token',$1,true)",[lease]);
   await c.query('INSERT INTO bb_model_capacity_scopes(scope) VALUES($1)',[holder]);
   const nodeId=(await c.query('SELECT id FROM bb_execution_nodes WHERE instance_id=$1',[f.identity.instance_id])).rows[0].id;
   await c.query("INSERT INTO bb_model_capacity_holders(token,scope,slot,host_id,execution_host,host_boot_id,pid_namespace,namespace_init_start,parent_pid,parent_start,execution_node_id,execution_node_epoch,execution_session_id,node_slot,admission_job_id) VALUES($1,$1,1,'synthetic','synthetic','synthetic','synthetic','1',1,'1',$2,$3,$4,1,$5)",[holder,nodeId,f.identity.epoch,session.context.session_id,id]);
  });
  await f.pool.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status) VALUES($1,$2,$3,'synthetic-call',1,'pending_reconcile')",[randomUUID(),owner,id]);
 return {id,owner,lease,holder};
}

test('operator failure fence: real PG through controller and actual Tencent adapter',{skip:!process.env.BB_TEST_DATABASE_URL,timeout:60000},async t=>{
 await t.test('lost starting node persists JSON dates, fences one CAS winner and completes only its ACK',async t=>{
  const f=await fixture(t,'positive'),{op,lostRevision}=await f.fence();
  assert.ok(Value.Check(ExecutionCloudOperationSchema,op));assert.equal(op.request,null);assert.equal(op.stop_authorization.kind,'operator-fence');
  const stored=(await f.pool.query('SELECT * FROM bb_execution_cloud_operations WHERE operation_id=$1',[op.operation_id])).rows[0];
  assert.equal(typeof stored.node_preimage.node.created_at,'string');assert.equal(hash(stored.node_preimage.node),op.stop_authorization.proof.node_preimage_sha256);
  assert.equal(op.stop_authorization.proof.cloud_start_operation_id,f.startId);assert.equal(op.stop_authorization.proof.node_revision,lostRevision);
  // Withdrawal of spend blocks launches, not this already-bound stop.
  await f.pool.query('UPDATE bb_execution_capacity_policy SET budget_available=false WHERE singleton');
  const raced=await Promise.allSettled([f.controller.dispatch(op),f.controller.dispatch(op)]);
  assert.equal(raced.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.state.stopCalls,1);
  const submitted=await f.control.loadOperation(op.operation_id);assert.equal(submitted.state,'submitted');assert.equal((await f.current()).state,'stop_submitted');
  const completed=await f.controller.recover(op.operation_id);assert.equal(completed.state,'completed');assert.equal((await f.current()).state,'stopped');
  assert.equal((await submitFencedExecutionStop(f.pool,f.identity,op.operation_id,lostRevision,'stop')).state,'completed');
  await f.controller.dispatch(completed);assert.equal(f.state.stopCalls,1);
 });
 await t.test('missing or malformed DTO proof is rejected before claim and any HTTP',async t=>{
  const f=await fixture(t,'dto'),{op}=await f.fence();
  const mutate=fn=>{const x=structuredClone(op);fn(x);return x;};
  const bad=[{...op,proof_sha256:null},{...op,stop_authorization:null},mutate(x=>x.identity.epoch=randomUUID()),mutate(x=>x.operation_id='foreign-stop'),mutate(x=>x.stop_authorization.proof.source_sha256='b'.repeat(64)),mutate(x=>x.stop_authorization.kind='graceful-drain'),mutate(x=>x.stop_authorization.extra=true)];
  for(const x of bad){await assert.rejects(f.controller.dispatch(x),/STOP_PROOF_REQUIRED/);await assert.rejects(f.cloud.execute(x),/STOP_PROOF_REQUIRED/);}
  const durable=await f.control.loadOperation(op.operation_id);assert.equal(durable.state,'intent');assert.equal(durable.dispatched_at,null);assert.equal(f.state.http.length,0);
 });
 await t.test('concurrent fencing has one durable intent and cannot reuse a foreign epoch or operation',async t=>{
  const f=await fixture(t,'fence-cas'),n=await f.current(),lost=await markExecutionNodeLost(f.pool,f.identity,n.revision);
  const ids=[randomUUID(),randomUUID()],race=await Promise.allSettled(ids.map(id=>submitFencedExecutionStop(f.pool,f.identity,id,lost.revision,'stop')));
  assert.equal(race.filter(x=>x.status==='fulfilled').length,1);
  const op=race.find(x=>x.status==='fulfilled').value;
  assert.equal((await f.control.listPendingOperations()).length,1);
  await assert.rejects(submitFencedExecutionStop(f.pool,{...f.identity,epoch:randomUUID()},op.operation_id,lost.revision,'stop'),/EPOCH_MISMATCH/);
  await assert.rejects(submitFencedExecutionStop(f.pool,f.identity,op.operation_id,lost.revision+1,'stop'),/CAS_CONFLICT/);
  assert.equal((await submitFencedExecutionStop(f.pool,f.identity,op.operation_id,lost.revision,'stop')).client_token,op.client_token);
  assert.equal(f.state.http.length,0);
 });
 await t.test('self-consistent forged proof cannot override locked pins, revision or original start ACK',async t=>{
  const f=await fixture(t,'durable'),{op}=await f.fence();const auth=op.stop_authorization;
  for(const patch of [{source_sha256:'b'.repeat(64)},{cloud_start_provider_request_id:'foreign-ack'},{node_revision:auth.proof.node_revision+1},{node_preimage_sha256:'b'.repeat(64)},{holder_preimage_sha256:'b'.repeat(64)}]){
   const body={...auth.proof,...patch};delete body.proof_sha256;const a={kind:'operator-fence',proof:{...body,proof_sha256:hash(body)}};
   await f.pool.query('UPDATE bb_execution_cloud_operations SET request=$2,proof_sha256=$3,request_sha256=$4 WHERE operation_id=$1',[op.operation_id,a,a.proof.proof_sha256,hash(a)]);
   await assert.rejects(f.controller.dispatch(await f.control.loadOperation(op.operation_id)),/STOP_AUTHORIZATION_INVALID/);
   const row=await f.control.loadOperation(op.operation_id);assert.equal(row.state,'intent');assert.equal(row.dispatched_at,null);
  }
  await f.pool.query('UPDATE bb_execution_cloud_operations SET request=$2,proof_sha256=$3,request_sha256=$4 WHERE operation_id=$1',[op.operation_id,auth,op.proof_sha256,hash(auth)]);
  await f.pool.query("UPDATE bb_execution_cloud_operations SET state='unknown' WHERE operation_id=$1",[f.startId]);
  await assert.rejects(f.controller.dispatch(await f.control.loadOperation(op.operation_id)),/STOP_AUTHORIZATION_INVALID/);
  assert.equal(f.state.http.length,0);
 });
 await t.test('wrong observed ACK, action, state or charging mode does not complete the fence',async t=>{
  const f=await fixture(t,'observation'),{op}=await f.fence();await f.controller.dispatch(op);const correct={...f.instance};
  for(const patch of [{LatestOperationRequestId:'foreign-ack'},{LatestOperation:'StartInstances'},{LatestOperationState:'FAILED'},{InstanceState:'RUNNING'},{StopChargingMode:'KEEP_CHARGING'}]){
   Object.assign(f.instance,correct,patch);await f.controller.recover(op.operation_id);assert.equal((await f.current()).state,'stop_submitted');
  }
  const sent=await f.control.loadOperation(op.operation_id),observed=await f.cloud.describe(f.identity.instance_id);
  await assert.rejects(f.control.recordCloudResult(op.operation_id,sent.revision,{state:'completed',identity:{...f.identity,epoch:randomUUID()},provider_request_id:sent.provider_request_id,observation:observed}));
  Object.assign(f.instance,correct);await f.controller.recover(op.operation_id);assert.equal((await f.current()).state,'stopped');assert.equal(f.state.stopCalls,1);
 });
 await t.test('unknown Stop retains lease, provider attempt and held capacity; no retry despite stopped inventory',async t=>{
  const f=await fixture(t,'unknown',{ready:true}),{id,lease}=await ownedPendingCall(f);
  const {op,lostRevision}=await f.fence();assert.equal((await f.current()).active_model_calls,1);f.state.loseAck=true;
  const unknown=await f.controller.dispatch(op);assert.equal(unknown.state,'unknown');assert.equal(unknown.provider_request_id,null);
  await f.controller.recover(op.operation_id);await f.controller.dispatch(unknown);
  const repeated=await submitFencedExecutionStop(f.pool,f.identity,op.operation_id,lostRevision,'stop');assert.equal(repeated.state,'unknown');assert.equal(f.state.stopCalls,1);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_model_capacity_holders')).rows[0].n,1);
  assert.equal((await f.pool.query('SELECT lease_token FROM bb_jobs WHERE id=$1',[id])).rows[0].lease_token,lease);
  assert.equal((await f.pool.query('SELECT status FROM bb_model_call_attempts')).rows[0].status,'pending_reconcile');
  const stored=(await f.pool.query('SELECT node_preimage FROM bb_execution_cloud_operations WHERE operation_id=$1',[op.operation_id])).rows[0].node_preimage;
  assert.equal(typeof stored.node.last_heartbeat_at,'string');assert.equal(hash(stored.node),op.stop_authorization.proof.node_preimage_sha256);assert.equal(stored.holders.length,1);
  assert.equal((await executionCloudExpenseLedger(f.pool)).operations.find(x=>x.operation_id===op.operation_id).state,'unknown');
 });
 await t.test('only confirmed StopCharging recovers holders and leases, retaining original provider uncertainty',async t=>{
  const f=await fixture(t,'held-completion',{ready:true}),{id,holder}=await ownedPendingCall(f);
  await f.pool.query('UPDATE bb_jobs SET checkpoint=$2 WHERE id=$1',[id,{synthetic_persisted_checkpoint:true}]);
  const {op}=await f.fence();assert.ok(!JSON.stringify(op).includes(holder));await f.controller.dispatch(op);
  assert.equal((await f.current()).active_model_calls,1);
  f.instance.StopChargingMode='KEEP_CHARGING';await f.controller.recover(op.operation_id);assert.equal((await f.current()).active_model_calls,1);
  f.instance.StopChargingMode='STOP_CHARGING';await f.controller.recover(op.operation_id);
  assert.equal((await f.current()).active_model_calls,0);assert.equal((await f.current()).state,'stopped');
  const job=(await f.pool.query('SELECT state,stage,lease_token,checkpoint FROM bb_jobs WHERE id=$1',[id])).rows[0];
  assert.equal(job.state,'paused');assert.equal(job.stage,'provider_reconcile');assert.equal(job.lease_token,null);assert.deepEqual(job.checkpoint,{synthetic_persisted_checkpoint:true});
  assert.equal((await f.pool.query('SELECT status,usage_status FROM bb_model_call_attempts')).rows[0].status,'pending_reconcile');
  const row=(await f.pool.query('SELECT node_preimage,holder_preimage FROM bb_execution_cloud_operations WHERE operation_id=$1',[op.operation_id])).rows[0];
  assert.equal(row.node_preimage.holders[0].token,holder);assert.equal(row.holder_preimage[0].token,holder);
  assert.equal(f.state.stopCalls,1);
 });
 await t.test('legacy graceful request-null intent resumes through pending list with original proof and hash',async t=>{
  const f=await fixture(t,'legacy',{ready:true}),n=await f.current(),id='synthetic-drain-'+randomUUID();await f.control.beginDrain(f.identity,id,n.revision);
  for(const s of f.sessions)await heartbeatExecutionRuntime(s.pool,{ready:false,native_processes:0,unpersisted_results:0,finished:true});
  const proof=await f.control.drainProof(f.identity,id);assert.equal(proof.positive_session_receipts,2);
  const op=await f.control.submitStop(proof,'stop');await f.pool.query('UPDATE bb_execution_cloud_operations SET request=NULL WHERE operation_id=$1',[id]);
  await f.pool.query('UPDATE bb_execution_capacity_policy SET budget_available=false WHERE singleton');
  const legacy=(await f.control.listPendingOperations()).find(x=>x.operation_id===id);assert.equal(legacy.stop_authorization.kind,'graceful-drain');assert.deepEqual(legacy.stop_authorization.proof,proof);assert.equal(legacy.proof_sha256,op.proof_sha256);
  await f.controller.resumeIntent(legacy);await f.controller.recover(id);assert.equal((await f.current()).state,'stopped');assert.equal(f.state.stopCalls,1);
 });
 await t.test('unsupported destroy and unbound original start fail before intent/claim/HTTP',async t=>{
  const f=await fixture(t,'destroy'),n=await f.current(),lost=await markExecutionNodeLost(f.pool,f.identity,n.revision),id='synthetic-destroy-'+randomUUID();
  await assert.rejects(submitFencedExecutionStop(f.pool,f.identity,id,lost.revision,'destroy'),/DESTROY_UNSUPPORTED/);
  await assert.rejects(f.controller.dispatch({action:'destroy',state:'intent'}),/DESTROY_UNSUPPORTED/);await assert.rejects(f.cloud.execute({action:'destroy'}),/DESTROY_UNSUPPORTED/);
  await f.pool.query("INSERT INTO bb_execution_cloud_operations(operation_id,account_id,region,instance_id,epoch,action,state,request_sha256,client_token) VALUES($1,$2,$3,$4,$5,'destroy','intent',$6,$1)",[id,f.identity.account_id,f.identity.region,f.identity.instance_id,f.identity.epoch,h]);
  await assert.rejects(f.control.claimCloudDispatch(id,0),/DESTROY_UNSUPPORTED/);assert.equal((await f.control.loadOperation(id)).state,'intent');
  await f.pool.query('DELETE FROM bb_execution_cloud_operations WHERE operation_id=$1',[id]);
  await f.pool.query("UPDATE bb_execution_cloud_operations SET provider_request_id=NULL WHERE operation_id=$1",[f.startId]);
  await assert.rejects(submitFencedExecutionStop(f.pool,f.identity,id,lost.revision,'stop'),/FENCE_START_BINDING_INVALID/);
  assert.equal(await f.control.loadOperation(id),null);assert.equal((await f.current()).state,'lost');assert.equal(f.state.http.length,0);
 });
});
