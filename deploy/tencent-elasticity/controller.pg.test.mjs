import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool} from 'pg';
import {Value} from '@sinclair/typebox/value';
import {ExecutionCapacitySnapshotSchema} from '@bondbuddy/contracts';
import {executionCapacityControl,executionCloudExpenseLedger,configureExecutionCapacity,bindExecutionRegistration,registerExecutionRuntime,heartbeatExecutionRuntime,executionClaimGate} from '@bondbuddy/api/execution-capacity';
import {transaction} from '@bondbuddy/api/data';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {PgModelCallBudget} from '../../apps/worker/dist/model-call-budget.js';
import {isolatedTestDatabase} from '../../apps/api/dist/test-database.js';
import {createExecutionPoolOpsHandler} from './ops-handler.mjs';
import {ExecutionPoolController} from './controller.mjs';
import {produceExpenseSnapshot} from './costcap.mjs';
import {canonical,sha256} from './policy.mjs';
import {runParameters} from './tencent-cvm.mjs';
import {bootstrapUserData} from './bootstrap.mjs';

const connection=await isolatedTestDatabase(undefined,'cloud-factory-joint');
// Real isolated PostgreSQL and runtime enrollment/lease/holder code. All cloud,
// price and SSM responses below are explicitly synthetic; no provider calls.
test('existing ops factory and real PG: dual nodes, expense fence, drain, warm intent recovery',{skip:!connection,timeout:30000},async t=>{
 const h='a'.repeat(64),services=[{service_id:'authoring',capabilities:['authoring']},{service_id:'review',capabilities:['review','assistant']}];
 const dir=await mkdtemp(join(tmpdir(),'bb-cloud-pg-')),pool=new Pool({connectionString:connection,max:4}),pools=[pool],permits=[];
 if(!(await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='bb_execution_cloud_operations' AND column_name='run_acceptance'")).rowCount)await pool.query(await import('node:fs/promises').then(fs=>fs.readFile(new URL('../../db/migrations/0183_execution_run_acceptance.sql',import.meta.url),'utf8')));
 t.after(async()=>{await Promise.all(permits.map(p=>p.release()));await Promise.all(pools.map(p=>p.end()));await rm(dir,{recursive:true});});
 const config={version:'tencent-execution-pool-v1',enabled:true,phase:'single_node_validation',account_id:'123456',pool_tag:'bondbuddy-execution',region:'ap-beijing',zone:'ap-beijing-7',instance_type:'SA9.LARGE16',min_running:1,max_owned:2,resident_instance_id:null,global_model_limit:4,node_model_limit:4,compute_cny_per_hour:.8,compute_cap_cny_per_hour:1.6,noncompute_cap_cny_per_hour:.8,total_cap_cny_per_hour:2.4,scale_up_wait_seconds:30,idle_seconds:60,failure_cooldown_seconds:60,image_id:'img-a1',vpc_id:'vpc-a1',subnet_id:'subnet-a1',security_group_id:'sg-a1',source_sha256:h,image_sha256:h,network_review_sha256:h,role_names:['role-a','role-b'],services,private_pg_verified:true,service_credentials_verified:true,stop_charging_verified:true,stop_charging_evidence_sha256:h,provider_budget_review_sha256:h,expense_policy_revision:1,expense_policy_sha256:h,time_zone:'Asia/Shanghai',period_cap_cny:48,reservation_hours:1,drain_reserve_hours:1,cloud_quote_file:'quote',registration_directory:dir,
 node_secrets:[{role_name:'role-a',role_id:'7',secret_name:'node-a',service_template_file:join(dir,'service-a.json')},{role_name:'role-b',role_id:'8',secret_name:'node-b',service_template_file:join(dir,'service-b.json')}]};
 const quote={version:'execution-cloud-price-bounds-v1',currency:'CNY',account_id:config.account_id,region:config.region,policy_revision:1,valid_from:'2026-01-01T00:00:00Z',valid_until:'2030-01-01T00:00:00Z',fixed_commitments:['secret','snapshot'].map(kind=>({kind,upper_bound_cny:0,evidence_ref:'synthetic/fixed-zero',evidence_sha256:h,enforced_bound_sha256:h})),components:['compute','disk','ip','egress','network','secret'].map(kind=>({kind,running_cny_per_node_hour:kind==='compute'?.8:.02,stopped_cny_per_node_hour:kind==='compute'?0:.02,evidence_ref:'synthetic/price',evidence_sha256:h,enforced_bound_sha256:h}))};
 config.quote_sha256=sha256(canonical(quote));
 for(const descriptor of config.node_secrets)await writeFile(descriptor.service_template_file,canonical({service_environments:{authoring:{DATABASE_URL:connection},review:{DATABASE_URL:connection}}}),{mode:0o600});
 Object.assign(config,{node_model_limit:8,global_model_limit:8});
 const setCapacity=async(limit,quota=limit,review=h)=>configureExecutionCapacity(pool,(await snap()).policy.revision,{
  managed_nodes:true,global_model_limit:limit,node_model_limit:8,max_nodes:2,budget_available:true,
  provider_concurrency_limit:quota,provider_policy_sha256:review,expense_policy_sha256:h
 });
 await configureExecutionCapacity(pool,0,{managed_nodes:true,global_model_limit:8,node_model_limit:8,max_nodes:2,
  budget_available:true,provider_concurrency_limit:8,provider_policy_sha256:h,expense_policy_sha256:h});
 const authority=executionCapacityControl(pool),instances=new Map(),secrets=new Map(),calls=[];let failExpense=false,failDispatch=false;
 const transport={call:async(_,action,p)=>{if(action==='ListSecretVersionIds')return {SecretName:p.SecretName,Versions:[...secrets.keys()].filter(k=>k.startsWith(p.SecretName+':')).map(k=>({VersionId:k.slice(p.SecretName.length+1)}))};if(action==='GetSecretValue'){const value=secrets.get(p.SecretName+':'+p.VersionId);if(!value){const e=Error();e.code='ResourceNotFound';throw e;}return {SecretName:p.SecretName,VersionId:p.VersionId,SecretString:value};}
 if(action==='PutSecretValue'){secrets.set(p.SecretName+':'+p.VersionId,p.SecretString);return {RequestId:'synthetic-secret'};}if(action==='ModifyResourceTags')return {RequestId:'synthetic-tag'};throw Error('unexpected synthetic action');}};
 const cloud={transport,describeRun:async op=>{const i=instances.get(op.identity.instance_id);return {...i,observed_at:new Date().toISOString(),run_creation:{operation_id:op.operation_id,identity:op.identity,launch_manifest_sha256:op.request.launch_manifest_sha256,launch_binding_sha256:h,created_at:op.dispatched_at,instance_status:i.instance_state,status_request_id:'synthetic-status'}};},inventory:async()=>[...instances.values()].map(i=>({...i,observed_at:new Date().toISOString()})),describe:async id=>({...instances.get(id),observed_at:new Date().toISOString()}),execute:async(op,material)=>{
  calls.push({action:op.action,operation_id:op.operation_id,client_token:op.client_token});const requestId='synthetic-'+op.operation_id;
  if(op.action==='run'){assert.equal(sha256(canonical(runParameters(config,op.request,op.client_token,material.userData,material.slot,op.operation_id))),op.request.launch_manifest_sha256);
   const id=instances.size?'ins-b2':'ins-a1';instances.set(id,{account_id:config.account_id,region:config.region,instance_id:id,role_name:config.role_names[material.slot],create_operation_id:op.operation_id,instance_state:'RUNNING',latest_operation:null,latest_operation_state:null,latest_operation_request_id:null,stop_charging_mode:null,evidence_ref:'synthetic/describe',evidence_sha256:h});return {RequestId:requestId,InstanceIdSet:[id],run_acceptance:{operation_id:op.operation_id,identity:{account_id:op.request.account_id,region:op.request.region,instance_id:id,epoch:op.request.epoch},provider_request_id:requestId,instance_ids:[id],client_token:op.client_token,launch_manifest_sha256:op.request.launch_manifest_sha256,launch_binding_sha256:h,evidence_ref:'synthetic/accepted',evidence_sha256:h}};}
  const i=instances.get(op.identity.instance_id);assert.ok(i);i.instance_state=op.action==='stop'?'STOPPED':'RUNNING';i.latest_operation=op.action==='stop'?'StopInstances':'StartInstances';i.latest_operation_state='SUCCESS';i.latest_operation_request_id=requestId;i.stop_charging_mode=op.action==='stop'?'STOP_CHARGING':null;return {RequestId:requestId};
 }};
 const control={...authority,claimCloudDispatch:async(...args)=>{if(failDispatch){failDispatch=false;throw Error('synthetic crash before dispatch');}return authority.claimCloudDispatch(...args);}};
 let enrollmentNow=Date.now();
 const costSnapshot=async inventory=>{if(failExpense)throw Error('synthetic missing fee bound');return produceExpenseSnapshot({ledger:await executionCloudExpenseLedger(pool),inventory,quote,config});};
 const handler=createExecutionPoolOpsHandler({control,configPath:'config',expenseLedger:()=>executionCloudExpenseLedger(pool),enrollmentBinder:(...args)=>bindExecutionRegistration(pool,...args),dependencies:{cloud,costSnapshot,now:()=>enrollmentNow,readConfig:async path=>path==='config'?config:path==='quote'?quote:{service_environments:{authoring:{DATABASE_URL:connection},review:{DATABASE_URL:connection}}}}});
 const snap=()=>authority.snapshot();
 const enroll=async id=>{
  const n=(await snap()).nodes.find(n=>n.identity.instance_id===id),op=await authority.loadOperation(n.cloud_start_operation_id),role=instances.get(id).role_name,slot=config.role_names.indexOf(role);
  const secret=JSON.parse(secrets.get(config.node_secrets[slot].secret_name+':'+op.operation_id));assert.ok(secret.registration_token);const sessions=[];
  for(const service of services){const p=new Pool({connectionString:connection,max:2});pools.push(p);const context={identity:n.identity,session_id:randomUUID()};
   const privatePath=join(dir,id+'-'+service.service_id+'.json');await writeFile(privatePath,canonical({context,service_id:service.service_id,registration_token:secret.registration_token}),{mode:0o600});
   await registerExecutionRuntime(p,context,{source_sha256:h,image_sha256:h,launch_manifest_sha256:n.launch_manifest_sha256,service_id:service.service_id,capabilities:service.capabilities,registration_token:secret.registration_token,process_identity:{pid:String(process.pid),boot:randomUUID()}});
   await heartbeatExecutionRuntime(p,{native_processes:0,unpersisted_results:0,ready:true});sessions.push(p);
  }return sessions;
 };
 const addJob=async(kind='generation')=>{const id=randomUUID(),owner='synthetic-cloud-owner',manifest={synthetic:true},hash=inputManifestHash(manifest);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'synthetic cloud demand',$3)",[id,owner,kind]);
  await pool.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,$4,'[]','[]')",[id,owner,hash,manifest]);
  await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$1,1,$3,$1,$4,$3,'queued')",[id,owner,hash,kind]);
  await pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state) VALUES($1,$2,$1,$3,'default','queued')",[id,owner,kind]);return id;};
 const claimJob=async(p,id)=>{const token=randomUUID();await transaction(p,async c=>{await executionClaimGate(c,p);await c.query("UPDATE bb_jobs SET state='running',lease_token=$2,lease_until=now()+interval '120 seconds' WHERE id=$1",[id,token]);});return {kind:'job',id,token};};
 await t.test('startup records one exact Run; unready node is no capacity and no second Run',async()=>{await handler.tick();assert.equal(calls.length,1);await handler.tick();assert.equal((await snap()).nodes[0].state,'starting');await handler.tick();assert.equal(calls.length,1);assert.equal((await snap()).nodes[0].ready_slots,0);});
 await t.test('expired confirmed enrollment preserves PG token/epoch and does not create sessions or replay cloud Start',async()=>{
  const before=(await pool.query('SELECT epoch,registration_token_sha256 FROM bb_execution_nodes')).rows;
  enrollmentNow+=600001;await handler.tick();
  assert.deepEqual((await pool.query('SELECT epoch,registration_token_sha256 FROM bb_execution_nodes')).rows,before);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_execution_node_sessions')).rows[0].n,0);
  assert.equal(calls.length,1);assert.equal(secrets.size,2);assert.equal((await snap()).policy.budget_available,true);
 });
 const a=await enroll('ins-a1');config.resident_instance_id='ins-a1';config.phase='two_node_validation';
 const aBudget=new PgModelCallBudget(a[0]);
 for(let i=0;i<8;i++){
  const lease=await claimJob(a[0],await addJob());
  permits.push(await aBudget.acquire(undefined,'cloud-a:'+i,lease));
 }
 const queuedReview=await addJob('review');
 await assert.rejects(claimJob(a[1],queuedReview),/claim slots full/);
 await snap();await pool.query("UPDATE bb_execution_work_readiness SET ready_since=clock_timestamp()-interval '60 seconds'");
 await t.test('one full node cannot add capacity at the upstream ceiling; reviewed demand can start a second',async()=>{
  assert.equal((await snap()).nodes[0].active_model_calls,8);
  await handler.tick();assert.equal(calls.length,1);
  await assert.rejects(setCapacity(67,66),{code:'23514'});
  await assert.rejects(setCapacity(67,67,null),{code:'23514'});
  await setCapacity(67);
  delete config.global_model_limit;
  const approved=await snap();
  assert.ok(Value.Check(ExecutionCapacitySnapshotSchema,approved),JSON.stringify([...Value.Errors(ExecutionCapacitySnapshotSchema,approved)]));
  assert.equal(approved.available_model_slots,59);
  await handler.tick();assert.equal(calls.length,2);await handler.tick();
  assert.equal((await snap()).nodes.find(n=>n.identity.instance_id==='ins-b2').state,'starting');
 });
 const b=await enroll('ins-b2');await handler.tick();assert.equal((await snap()).policy.budget_available,true);
 await t.test('review shares global slots across nodes; high occupied IDs survive lowering the quota',async()=>{
  const lease=await claimJob(b[1],queuedReview),bBudget=new PgModelCallBudget(b[1]);
  const review=await bBudget.acquire(undefined,'cloud-b:review',lease);
  permits.push(review);
  assert.deepEqual((await pool.query('SELECT slot FROM bb_model_capacity_holders ORDER BY slot')).rows.map(r=>r.slot),[1,2,3,4,5,6,7,8,9]);
  const high=await transaction(pool,async c=>{
   await c.query("SELECT set_config('bb.execution_lease_token',$1,true)",[lease.token]);
   const token=randomUUID();
   // Node limits preserve a maximum of 16 simultaneous holders. Exercise the
   // former 64-ID constraint with a sparse holder that still has a real lease.
   await c.query(`INSERT INTO bb_model_capacity_holders
    SELECT (jsonb_populate_record(NULL::bb_model_capacity_holders,
      to_jsonb(h)||jsonb_build_object('token',$2::text,'slot',65,'node_slot',2))).*
    FROM bb_model_capacity_holders h WHERE scope=$1`,['cloud-b:review',token]);
   return token;
  });
  try{
   await setCapacity(2147483647);
   const extraLease=await claimJob(b[0],await addJob()),extraBudget=new PgModelCallBudget(b[0]);
   const extra=await extraBudget.acquire(AbortSignal.timeout(2500),'cloud-b:extra',extraLease);
   assert.equal((await pool.query("SELECT slot FROM bb_model_capacity_holders WHERE scope='cloud-b:extra'")).rows[0].slot,10);
   await extra.release();
   await setCapacity(8);
   assert.equal((await snap()).available_model_slots,0);
   await review.renew();
   assert.equal((await pool.query('UPDATE bb_model_capacity_holders SET renewed_at=now() WHERE token=$1 AND slot=65',[high])).rowCount,1);
   const timeout=AbortSignal.timeout(250);
   await assert.rejects(extraBudget.acquire(timeout,'cloud-b:blocked',extraLease),
    error=>error===timeout.reason||error.cause===timeout.reason);
   assert.equal((await snap()).active_model_calls,10);
   await review.release();
   await permits[0].release();
   await permits[1].release();
   // Admission is by the total active count, with occupied IDs above the
   // lowered limit included. The first low hole is usable again.
   permits.push(await extraBudget.acquire(AbortSignal.timeout(2500),'cloud-b:allowed',extraLease));
   assert.equal((await pool.query("SELECT slot FROM bb_model_capacity_holders WHERE scope='cloud-b:allowed'")).rows[0].slot,1);
   assert.equal((await snap()).active_model_calls,8);
   assert.equal(instances.size,2);
  }finally{await pool.query('DELETE FROM bb_model_capacity_holders WHERE token=$1',[high]);}
 });
 await Promise.all(permits.map(p=>p.release()));await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE owner_user_id='synthetic-cloud-owner'");
 await t.test('missing fee source closes claims but preserves lease drain proof until all services finish',async()=>{
  failExpense=true;await handler.tick();assert.equal((await snap()).policy.budget_available,false);assert.equal((await snap()).nodes.find(n=>n.identity.instance_id==='ins-b2').state,'draining');assert.equal(calls.length,2);
  await heartbeatExecutionRuntime(b[0],{native_processes:0,unpersisted_results:0,ready:false,finished:true});await handler.tick();assert.equal(calls.length,2);
  await heartbeatExecutionRuntime(b[1],{native_processes:0,unpersisted_results:0,ready:false,finished:true});await handler.tick();assert.equal(calls.at(-1).action,'stop');await handler.tick();assert.equal((await snap()).nodes.find(n=>n.identity.instance_id==='ins-b2').state,'stopped');
 });
 const old=(await snap()).nodes.find(n=>n.identity.instance_id==='ins-b2');failExpense=false;await authority.setAdmissionBudget((await snap()).policy.revision,true,h);for(let i=0;i<8;i++)await claimJob(a[0],await addJob());await addJob();await snap();await pool.query("UPDATE bb_execution_work_readiness SET ready_since=clock_timestamp()-interval '60 seconds'");
 await t.test('warm intent before dispatch survives budget revisions/restart with same token and original manifest',async()=>{
  // Restore expense admission before submitting a new warm intent.
  await authority.setAdmissionBudget((await snap()).policy.revision,true,h);failDispatch=true;await handler.tick();const op=(await authority.listPendingOperations())[0];assert.equal(op.state,'intent');assert.equal(op.request.launch_manifest_sha256,old.launch_manifest_sha256);const count=calls.length;
  await authority.setAdmissionBudget((await snap()).policy.revision,false,h);await handler.tick();assert.equal(calls.length,count+1);const sent=await authority.loadOperation(op.operation_id);assert.equal(sent.client_token,op.client_token);assert.deepEqual(sent.request,op.request);assert.equal(sent.state,'submitted');await handler.tick();assert.equal((await snap()).nodes.find(n=>n.identity.instance_id==='ins-b2').state,'starting');
 });
 assert.ok((await executionCloudExpenseLedger(pool)).operations.length>=4);assert.equal(instances.size,2);
});
