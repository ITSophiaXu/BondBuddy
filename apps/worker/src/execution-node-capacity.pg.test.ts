import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {setTimeout as delay} from 'node:timers/promises';
import {spawn} from 'node:child_process';
import {executionCapacityControl,configureExecutionCapacity,bindExecutionRegistration,registerExecutionRuntime,heartbeatExecutionRuntime,executionClaimGate,markExecutionNodeLost,submitFencedExecutionStop} from '@bondbuddy/api/execution-capacity';
import {transaction} from '@bondbuddy/api/data';
import {claim} from '@bondbuddy/api/queue';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import type {ExecutionCloudOperation,ExecutionNodeIdentity,ExecutionLaunchRequest,ExecutionNodeContext} from '@bondbuddy/contracts';
import {PgModelCallBudget,type ModelCallPermit} from './model-call-budget.js';
import {isolatedTestDatabase} from './test-database.js';
import {assertManagedRuntimeOptions} from './execution-node-runtime.js';
const connection=await isolatedTestDatabase(undefined,'execution-node-capacity');
const hash='a'.repeat(64), token='synthetic-registration-token-0123456789';
const until=async(check:()=>Promise<boolean>)=>{for(let i=0;i<100;i++){if(await check())return;await delay(25);}throw Error('condition did not settle');};
// Real migrated PostgreSQL/control/budget adapters; cloud observations are
// explicit synthetic fixtures, not claims of CVM or supplier verification.
test('managed pool admission, dual capacity, drain, and cloud fencing',{skip:!connection,timeout:60000},async t=>{
 const pool=new Pool({connectionString:connection,max:4}),pools=[pool],permits:ModelCallPermit[]=[],cancels:AbortController[]=[];
 const control=executionCapacityControl(pool);
 t.after(async()=>{cancels.forEach(c=>c.abort());await Promise.all(permits.map(p=>p.release()));await Promise.all(pools.map(p=>p.end()));});
 const policy=async()=> (await control.snapshot()).policy;
 const identityFor=(instance:string):ExecutionNodeIdentity=>({account_id:'synthetic-account',region:'synthetic-region',instance_id:instance,epoch:randomUUID()});
 const launch=(i:ExecutionNodeIdentity):ExecutionLaunchRequest=>({...i,instance_count:1,source_sha256:hash,image_sha256:hash,launch_manifest_sha256:hash,capabilities:['authoring'],services:[{service_id:'one',capabilities:['authoring']},{service_id:'two',capabilities:['authoring']}]});
 const observation=(action:string,requestId:string)=>({instance_state:action==='stop'?'STOPPED':'RUNNING',latest_operation:action==='stop'?'StopInstances':action==='start'?'StartInstances':'RunInstances',latest_operation_state:'SUCCESS',latest_operation_request_id:requestId,stop_charging_mode:action==='stop'?'STOP_CHARGING':null,observed_at:new Date().toISOString(),evidence_ref:'synthetic-describe.json',evidence_sha256:hash});
 const finish=async(op:ExecutionCloudOperation,i:ExecutionNodeIdentity)=>{
  const requestId='request-'+op.operation_id;
  op=await control.recordCloudResult(op.operation_id,op.revision,{state:'submitted',identity:i,provider_request_id:requestId,observation:null});
  return control.recordCloudResult(op.operation_id,op.revision,{state:'completed',identity:i,provider_request_id:requestId,observation:observation(op.action,requestId)});
 };
 await t.test('legacy holder must positively drain before managed policy activation',async()=>{
  const old=await new PgModelCallBudget(pool).acquire(undefined,'legacy:before');
  await assert.rejects(configureExecutionCapacity(pool,0,{managed_nodes:true,global_model_limit:4,max_nodes:2,budget_available:true}),/Legacy execution/);
  await old.release();
 });
 await configureExecutionCapacity(pool,0,{managed_nodes:true,global_model_limit:4,max_nodes:2,budget_available:true});
 const a=identityFor('node-a'),b=identityFor('node-b');
 const create=async(i:ExecutionNodeIdentity)=>{let op=await control.reserveStart({...launch(i),instance_id:null},'run-'+i.instance_id,(await policy()).revision);op=await control.claimCloudDispatch(op.operation_id,op.revision);await finish(op,i);await bindExecutionRegistration(pool,i,op.operation_id,token);};
 const enroll=async(i:ExecutionNodeIdentity,service:string)=>{
  const p=new Pool({connectionString:connection,max:2});pools.push(p);
  const context:ExecutionNodeContext={identity:i,session_id:randomUUID()};
  await registerExecutionRuntime(p,context,{service_id:service,capabilities:['authoring'],source_sha256:hash,image_sha256:hash,launch_manifest_sha256:hash,registration_token:token,process_identity:{pid:String(process.pid),boot:'synthetic'}});
  await heartbeatExecutionRuntime(p,{native_processes:0,unpersisted_results:0,ready:true});return p;
 };
 const addJob=async()=>{
  const id=randomUUID(),owner='synthetic-owner',manifest={synthetic:true},h=inputManifestHash(manifest);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'synthetic','generation')",[id,owner]);
  await pool.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,$4,'[]','[]')",[id,owner,h,manifest]);
  await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$1,1,$3,$1,'generation',$3,'queued')",[id,owner,h]);
  await pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state) VALUES($1,$2,$1,'generation','default','queued')",[id,owner]);return id;
 };
 const claimJob=async(p:Pool,id:string)=>{const lease=randomUUID();await transaction(p,async client=>{await executionClaimGate(client,p);await client.query("UPDATE bb_jobs SET state='running',lease_token=$2,lease_until=now()+interval '120 seconds' WHERE id=$1",[id,lease]);});return {kind:'job' as const,id,token:lease};};
 await t.test('unknown Run binds ACK before node registration; first service alone is not ready',async()=>{
  await create(a);const one=await enroll(a,'one');assert.equal((await control.snapshot()).nodes[0]!.state,'starting');
  await assert.rejects(claimJob(one,await addJob()),/not ready/);
 });
 const a1=pools[1]!,a2=await enroll(a,'two');
 await create(b);const b1=await enroll(b,'one'),b2=await enroll(b,'two');
 await t.test('legacy raw SQL and unsupported runtime entrypoints fail closed',async()=>{
  await assert.rejects(control.reserveStart({...launch(identityFor('overflow')),instance_id:null},'overflow',(await policy()).revision),/MAX_NODES/);
  await assert.rejects(configureExecutionCapacity(pool,(await policy()).revision,{managed_nodes:true,global_model_limit:4,max_nodes:3,budget_available:true}),/max_nodes/);
  await assert.rejects(claimJob(pool,await addJob()),/admission required/);
  await assert.rejects(registerExecutionRuntime(pool,{identity:a,session_id:randomUUID()},{service_id:'two',capabilities:['review'],source_sha256:hash,image_sha256:hash,launch_manifest_sha256:hash,registration_token:token,process_identity:{pid:'1'}}),/REGISTRATION_REJECTED/);
  await assert.rejects(new PgModelCallBudget(pool).acquire(undefined,'legacy'),/identity required/);
  assert.throws(()=>assertManagedRuntimeOptions({kinds:['run','parse'],parseSlots:1}),/UNGUARDED/);
  assert.throws(()=>assertManagedRuntimeOptions({kinds:['run'],parseSlots:0,uploadConfirmationEnabled:true}),/UNGUARDED/);
 });
 const jobsA=await Promise.all(Array.from({length:4},()=>addJob()));
 const leasesA:Awaited<ReturnType<typeof claimJob>>[]=[];for(let k=0;k<4;k++)leasesA.push(await claimJob(k%2?a2:a1,jobsA[k]!));
 const budgetA1=new PgModelCallBudget(a1),budgetA2=new PgModelCallBudget(a2),budgetB=new PgModelCallBudget(b1);
 await t.test('node four is shared across processes, and default global four blocks another node',async()=>{
  for(let k=0;k<4;k++)permits.push(await(k%2?budgetA2:budgetA1).acquire(undefined,'a:'+k,leasesA[k]));
  await assert.rejects(claimJob(a1,await addJob()),/claim slots full/);
  const leaseB=await claimJob(b1,await addJob()),cancel=new AbortController();cancels.push(cancel);
  let granted=false;const waiting=budgetB.acquire(cancel.signal,'b:default',leaseB).then(async p=>{granted=true;await p.release();},()=>{});
  await until(async()=>!!(await pool.query("SELECT 1 FROM bb_model_capacity_waiters WHERE scope='b:default'")).rowCount);await delay(150);assert.equal(granted,false);
  cancel.abort();await waiting;
  await pool.query('UPDATE bb_jobs SET lease_token=NULL,lease_until=NULL,state=\'cancelled\' WHERE id=$1',[leaseB.id]);
 });
 await configureExecutionCapacity(pool,(await policy()).revision,{managed_nodes:true,global_model_limit:8,max_nodes:2,budget_available:true,provider_concurrency_limit:8,provider_policy_sha256:hash,expense_policy_sha256:hash});
 await t.test('full-node head waiter cannot block empty-node global capacity',async()=>{
  const cancel=new AbortController();cancels.push(cancel);const waiting=budgetA1.acquire(cancel.signal,'a:blocked',leasesA[0]).then(p=>p.release(),()=>{});
  await until(async()=>!!(await pool.query("SELECT 1 FROM bb_model_capacity_waiters WHERE scope='a:blocked'")).rowCount);
  const leaseB=await claimJob(b1,await addJob());const p=await budgetB.acquire(undefined,'b:eligible',leaseB);permits.push(p);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_capacity_holders')).rows[0].n,5);
  cancel.abort();await waiting;await p.release();await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE id=$1",[leaseB.id]);
 });
 await t.test('beginDrain serializes with claims; existing current lease continues model work',async()=>{
  const client=await a1.connect();await client.query('BEGIN');await executionClaimGate(client,a1).catch(async error=>{ // four existing jobs consume node claim slots
   await client.query('ROLLBACK');await client.query('BEGIN');const n=(await client.query('SELECT id FROM bb_execution_nodes WHERE instance_id=$1 FOR UPDATE',[a.instance_id])).rows[0];assert.ok(n);assert.match(String(error),/full/);
  });
  let drained=false;const n=(await control.snapshot()).nodes.find(n=>n.identity.instance_id===a.instance_id)!;
  const draining=control.beginDrain(a,'drain-a',n.revision).then(r=>{drained=true;return r;});await delay(100);assert.equal(drained,false);await client.query('COMMIT');client.release();await draining;
  await assert.rejects(claimJob(a1,await addJob()),/not ready/);
  await control.setAdmissionBudget((await policy()).revision,false,hash);
  await assert.rejects(claimJob(b1,await addJob()),/budget unavailable/);
  await permits[0]!.release();const follow=await budgetA1.acquire(undefined,'a:followup',leasesA[0]);permits.push(follow);await follow.release();
  assert.equal(await control.drainProof(a,'drain-a'),null);
  await control.setAdmissionBudget((await policy()).revision,true,hash);
 });
 await t.test('live child and expired heartbeat never release capacity; death is not billing replay',async()=>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});assert.ok(child.pid);
  const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
  try{await permits[1]!.bindProcess(child.pid!);await pool.query("UPDATE bb_model_capacity_holders SET renewed_at=now()-interval '100 days'");await budgetA2.reconcileOwnExitedProcesses();assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_capacity_holders')).rows[0].n,3);}
  finally{child.kill('SIGKILL');await closed;}
 });
 await Promise.all(permits.map(p=>p.release()));
 await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE execution_node_id=(SELECT id FROM bb_execution_nodes WHERE instance_id=$1)",[a.instance_id]);
 await t.test('missing expected finished service prevents proof; Stop tombstone forbids readiness/new epoch',async()=>{
  await heartbeatExecutionRuntime(a1,{native_processes:0,unpersisted_results:0,ready:false,finished:true});assert.equal(await control.drainProof(a,'drain-a'),null);
  await heartbeatExecutionRuntime(a2,{native_processes:0,unpersisted_results:0,ready:false,finished:true});const proof=await control.drainProof(a,'drain-a');assert.ok(proof);assert.deepEqual(await control.drainProof(a,'drain-a'),proof);
  let op=await control.submitStop(proof,'stop');op=await control.claimCloudDispatch(op.operation_id,op.revision);
  await assert.rejects(pool.query("UPDATE bb_execution_nodes SET state='ready' WHERE instance_id=$1",[a.instance_id]),/unresolved/);
  await assert.rejects(control.reserveStart(launch({...a,epoch:randomUUID()}),'restart-unknown',(await policy()).revision));
  op=await control.recordCloudResult(op.operation_id,op.revision,{state:'submitted',identity:a,provider_request_id:'stop-ack-a',observation:null});
  await assert.rejects(control.recordCloudResult(op.operation_id,op.revision,{state:'completed',identity:a,provider_request_id:'stop-ack-a',observation:observation('stop','old-stop-request')}),/UNPROVEN/);
  await control.recordCloudResult(op.operation_id,op.revision,{state:'completed',identity:a,provider_request_id:'stop-ack-a',observation:observation('stop','stop-ack-a')});
 });
 await t.test('warm Start rejects image/manifest changes instead of claiming cloud upgrade',async()=>{
  const next={...a,epoch:randomUUID()};await assert.rejects(control.reserveStart({...launch(next),image_sha256:'b'.repeat(64)},'warm-bad',(await policy()).revision),/MANIFEST_CHANGED/);
  let op=await control.reserveStart(launch(next),'warm-good',(await policy()).revision);op=await control.claimCloudDispatch(op.operation_id,op.revision);await finish(op,next);a.epoch=next.epoch;
 });
 await t.test('expired owned lease is preserved without blocking a separate queued run',async()=>{
  // Isolate older queued fixture rows without clearing any leased task.
  await pool.query("UPDATE bb_jobs SET state='cancelled' WHERE state='queued' AND lease_token IS NULL");
  const old=await claimJob(b1,await addJob());await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 day',created_at=now()-interval '100 days' WHERE id=$1",[old.id]);
  const fresh=await addJob();const next=await claim(b2,30,{runKinds:['generation']});assert.equal(next?.jobId,fresh);
  const untouched=(await pool.query('SELECT lease_token,state FROM bb_jobs WHERE id=$1',[old.id])).rows[0];assert.equal(untouched.lease_token,old.token);assert.equal(untouched.state,'running');
  await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE id=ANY($1::text[])",[[old.id,fresh]]);
 });
 await t.test('foreign holder requires exact completed Stop; full preimage and unknown journal survive',async()=>{
  const lease=await claimJob(b1,await addJob());const p=await budgetB.acquire(undefined,'b:lost',lease);permits.push(p);
  const attempt=randomUUID();await pool.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status) VALUES($1,'synthetic-owner',$2,'synthetic-call',1,'pending_reconcile')",[attempt,lease.id]);
  const before=(await pool.query('SELECT row_to_json(a) value FROM bb_model_call_attempts a WHERE id=$1',[attempt])).rows[0].value;
  const n=(await control.snapshot()).nodes.find(n=>n.identity.instance_id===b.instance_id)!;const lost=await markExecutionNodeLost(pool,b,n.revision);
  let op=await submitFencedExecutionStop(pool,b,'lost-stop',lost.revision,'stop');op=await control.claimCloudDispatch(op.operation_id,op.revision);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_capacity_holders')).rows[0].n,1);
  await finish(op,b);assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_capacity_holders')).rows[0].n,0);
  assert.deepEqual((await pool.query('SELECT row_to_json(a) value FROM bb_model_call_attempts a WHERE id=$1',[attempt])).rows[0].value,before);
  const j=(await pool.query('SELECT j.state,r.state run_state FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id WHERE j.id=$1',[lease.id])).rows[0];assert.equal(j.state,'paused');assert.equal(j.run_state,'paused');
  assert.equal((await pool.query('SELECT jsonb_array_length(holder_preimage) n FROM bb_execution_cloud_operations WHERE operation_id=$1',[op.operation_id])).rows[0].n,1);
  assert.ok((await pool.query("SELECT 1 FROM bb_outbox WHERE aggregate_id=$1 AND payload->>'reason'='execution_epoch_stopped'",[lease.id])).rowCount);
 });
});
