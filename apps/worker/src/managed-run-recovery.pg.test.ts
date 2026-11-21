import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {claim,releaseLease,completeManagedRunRelease,finish,renew} from '@bondbuddy/api/queue';
import {executionCapacityControl,configureExecutionCapacity,bindExecutionRegistration,registerExecutionRuntime,heartbeatExecutionRuntime,executionNodeForPool} from '@bondbuddy/api/execution-capacity';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {isolatedTestDatabase} from './test-database.js';
import {runPipelineOnce} from './run-pipeline.js';
import {ManagedRunRetries} from './managed-run-retries.js';
import {WorkerRuntime} from './runtime.js';
import {setTimeout as delay} from 'node:timers/promises';
import {once} from 'node:events';
import {spawn} from './task-execution.js';
import {transaction,type PrivateBlobs} from '@bondbuddy/api/data';
import {initializeTaskExecution,taskNativeProcesses,taskReleaseProof,retireTaskExecution,withTaskExecution} from './task-execution.js';
const connection=await isolatedTestDatabase(undefined,'managed-run-recovery');
const hash='a'.repeat(64),registration='synthetic-registration-token-0123456789';
const proof={nativeProcesses:0,activeExecutions:0} as const;
const ident=(s:string)=>'"'+s.replaceAll('"','""')+'"';

test('restricted managed role can finish and safely hand off an unexpected failure',{skip:!connection,timeout:60000},async t=>{
 const admin=new Pool({connectionString:connection}),role='synthetic_recovery_'+randomUUID().replaceAll('-','');
 await admin.query(`CREATE ROLE ${ident(role)} LOGIN`);
 const acl=JSON.parse(await readFile(new URL('../src/fixtures/managed-runtime-acl.json',import.meta.url),'utf8'));
 for(const table of acl.tables){
  for(const privilege of table.privileges)await admin.query(`GRANT ${privilege} ON public.${ident(table.name)} TO ${ident(role)}`);
  for(const [privilege,columns] of Object.entries(table.columns) as [string,string[]][])await admin.query(`GRANT ${privilege}(${columns.map(ident).join(',')}) ON public.${ident(table.name)} TO ${ident(role)}`);
 }
 // The deployed overlay predates 0182's consumer code. Keep its captured ACL
 // intact and apply the explicit full-develop release prerequisite separately.
 assert.equal((await admin.query("SELECT has_table_privilege($1,'bb_run_model_activity','SELECT') AS allowed",[role])).rows[0].allowed,false);
 const delta=await readFile(new URL('../../../deploy/m1/security/managed-model-activity-grants.sql',import.meta.url),'utf8');
 await admin.query(delta.replaceAll(':"runtime_role"',ident(role)));
 const url=new URL(connection!);url.username=role;url.password='';
 const worker=new Pool({connectionString:url.toString()}),other=new Pool({connectionString:url.toString()});
 t.after(async()=>{await worker.end();await other.end();await admin.query(`DROP OWNED BY ${ident(role)}`);await admin.query(`DROP ROLE ${ident(role)}`);await admin.end();});
 assert.equal((await admin.query("SELECT has_table_privilege($1,'bb_error_recovery_events','INSERT') AS allowed",[role])).rows[0].allowed,false);
 const owner=randomUUID();await admin.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'rca_'+owner.slice(0,8)]);
 const add=async()=>{
  const id=randomUUID(),manifest={synthetic:true},h=inputManifestHash(manifest);
  await admin.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'synthetic recovery','generation')",[id,owner]);
  await admin.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,$4,'[]','[]')",[id,owner,h,manifest]);
  await admin.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$1,1,$3,$1,'generation',$3,'queued')",[id,owner,h]);
  await admin.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state) VALUES($1,$2,$1,'generation','default','queued')",[id,owner]);return id;
 };
 await t.test('five terminal states succeed without direct audit grants, including empty history',async()=>{
  for(const state of ['failed','succeeded','test_completed','cancelled','rejected']){
   const id=await add();await worker.query("UPDATE bb_jobs SET state='running' WHERE id=$1",[id]);
   await worker.query('UPDATE bb_jobs SET state=$2 WHERE id=$1',[id,state]);
   assert.equal((await admin.query('SELECT state FROM bb_jobs WHERE id=$1',[id])).rows[0].state,state);
   await admin.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[id]);
  }
  await assert.rejects(worker.query("INSERT INTO bb_error_recovery_events(id,error_id,job_id,outcome) VALUES('forged','forged','forged','recovered')"),{code:'42501'});
  await assert.rejects(worker.query('SELECT bb_record_error_recovery()'),{code:'42501'});
  await worker.query('CREATE TEMP TABLE forged_jobs(id text,state text)');
  await assert.rejects(worker.query('CREATE TRIGGER forged AFTER UPDATE ON forged_jobs FOR EACH ROW EXECUTE FUNCTION public.bb_record_error_recovery()'),{code:'42501'});
 });
 await t.test('all audit outcomes remain append-only, idempotent and independent of caller search_path',async()=>{
  await worker.query('CREATE TEMP TABLE bb_error_recovery_events(id text,error_id text,job_id text,outcome text)');
  await worker.query('CREATE TEMP TABLE bb_observability_errors(id text,job_id text,recovery_status text)');
  for(const [state,outcome] of [['succeeded','recovered'],['test_completed','recovered'],['failed','retried_failed'],['cancelled','user_cancelled'],['rejected','retried_failed']]){
   const id=await add(),errorId=randomUUID();
   await admin.query(`INSERT INTO public.bb_observability_errors(id,owner_user_id,project_id,job_id,trace_id,stage,category,code,fingerprint,retry_count,recovery_status)
    VALUES($1,$2,$3,$3,$3,'model_generation','internal','DATA_UNAVAILABLE',$4,1,'retry_scheduled')`,[errorId,owner,id,hash]);
   await worker.query('UPDATE bb_jobs SET state=$2 WHERE id=$1',[id,state]);
   await worker.query('UPDATE bb_jobs SET state=$2 WHERE id=$1',[id,state]);
   assert.deepEqual((await admin.query('SELECT outcome FROM public.bb_error_recovery_events WHERE error_id=$1',[errorId])).rows,[{outcome}]);
   await admin.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[id]);
  }
  assert.equal((await worker.query('SELECT count(*)::int n FROM pg_temp.bb_error_recovery_events')).rows[0].n,0);
  await worker.query('DROP TABLE pg_temp.bb_error_recovery_events,pg_temp.bb_observability_errors');
 });
 const control=executionCapacityControl(admin);
 await configureExecutionCapacity(admin,0,{managed_nodes:true,global_model_limit:4,max_nodes:2,budget_available:true});
 const enroll=async(p:Pool,instance:string)=>{
  const fixture=p===worker&&process.env.BB_SYNTHETIC_TASK_CGROUP_CONTEXT?JSON.parse(process.env.BB_SYNTHETIC_TASK_CGROUP_CONTEXT):null;
  if(fixture)assert.deepEqual({...fixture.identity,epoch:'synthetic'},{account_id:'synthetic',region:'synthetic',instance_id:instance,epoch:'synthetic'});
  const identity=fixture?.identity??{account_id:'synthetic',region:'synthetic',instance_id:instance,epoch:randomUUID()},session=fixture?.session_id??randomUUID();
  let op=await control.reserveStart({...identity,instance_id:null,instance_count:1,source_sha256:hash,image_sha256:hash,launch_manifest_sha256:hash,capabilities:['authoring'],services:[{service_id:'author',capabilities:['authoring']}]},randomUUID(),(await control.snapshot()).policy.revision);
  op=await control.claimCloudDispatch(op.operation_id,op.revision);const ack=randomUUID();
  op=await control.recordCloudResult(op.operation_id,op.revision,{state:'submitted',identity,provider_request_id:ack,observation:null,run_acceptance:{operation_id:op.operation_id,identity,provider_request_id:ack,instance_ids:[instance],client_token:op.client_token,launch_manifest_sha256:hash,launch_binding_sha256:hash,evidence_ref:'synthetic',evidence_sha256:hash}});
  await control.recordCloudResult(op.operation_id,op.revision,{state:'completed',identity,provider_request_id:ack,observation:{instance_state:'RUNNING',latest_operation:'RunInstances',latest_operation_state:'SUCCESS',latest_operation_request_id:ack,stop_charging_mode:null,observed_at:new Date().toISOString(),evidence_ref:'synthetic',evidence_sha256:hash,run_creation:{operation_id:op.operation_id,identity,launch_manifest_sha256:hash,launch_binding_sha256:hash,created_at:new Date().toISOString(),instance_status:'RUNNING',status_request_id:'synthetic'}}});
  await bindExecutionRegistration(admin,identity,op.operation_id,registration);
  await registerExecutionRuntime(p,{identity,session_id:session},{service_id:'author',capabilities:['authoring'],source_sha256:hash,image_sha256:hash,launch_manifest_sha256:hash,registration_token:registration,process_identity:{pid:String(process.pid)}});
  await heartbeatExecutionRuntime(p,{native_processes:0,unpersisted_results:0,ready:true});return session;
 };
 const session=await enroll(worker,'synthetic-one'),otherSession=await enroll(other,'synthetic-two');
 if(process.env.BB_SYNTHETIC_TASK_CGROUP_CONTEXT)await initializeTaskExecution(worker);
 await t.test('concurrent exact scope admission cannot enter the same native execution twice',
  {skip:!process.env.BB_SYNTHETIC_TASK_CGROUP_CONTEXT},async()=>{
   const scope={kind:'job',id:'synthetic-scope-race',token:'exact-attempt'} as const;
   let calls=0;
   const first=withTaskExecution(worker,scope,async()=>{calls++;return 'completed';});
   await assert.rejects(withTaskExecution(worker,scope,async()=>{calls++;return 'completed';}),/TASK_EXECUTION_ALREADY_ENTERED/);
   await first;assert.equal(calls,1);
  });
 const next=async()=>{const id=await add(),lease=await claim(worker,60,{runKinds:['generation']});assert.equal(lease?.jobId,id);return lease!;};
 const scopedProof=(lease:NonNullable<Awaited<ReturnType<typeof claim>>>)=>({...proof,version:'task_cgroup_v1' as const,
  jobId:lease.jobId,token:lease.token,epoch:executionNodeForPool(worker)!.identity.epoch,sessionId:session,
  cgroupIdentity:'00000000-0000-0000-0000-000000000000:1:1'});
 const addHolder=async(lease:NonNullable<Awaited<ReturnType<typeof claim>>>)=>{
  const holder=randomUUID();
  await transaction(admin,async client=>{
   await client.query("SELECT set_config('bb.execution_lease_token',$1,true)",[lease.token]);
   await client.query(`INSERT INTO bb_model_capacity_holders(token,scope,slot,host_id,execution_host,host_boot_id,pid_namespace,namespace_init_start,parent_pid,parent_start,execution_session_id,execution_node_id,execution_node_epoch,node_slot,admission_job_id)
    SELECT $1,'synthetic-release',1,'synthetic','synthetic','synthetic','synthetic','synthetic',1,'synthetic',execution_session_id,execution_node_id,execution_node_epoch,1,id FROM bb_jobs WHERE id=$2`,[holder,lease.jobId]);
  });
  return holder;
 };
 await t.test('expired lease alone is not reclaimable; only the completed owning session can release',async()=>{
  const lease=await next();await releaseLease(worker,lease);
  assert.equal(await claim(other,60,{runKinds:['generation']}),null);
  await assert.rejects(completeManagedRunRelease(other,lease,proof),/OWNER_MISMATCH/);
  await assert.rejects(completeManagedRunRelease(worker,lease,{nativeProcesses:1 as 0,activeExecutions:0}),/NOT_QUIESCENT/);
  assert.equal(await completeManagedRunRelease(worker,lease,proof),'queued');
  assert.equal(await completeManagedRunRelease(worker,lease,proof),'stale');
  const reclaimed=await claim(other,60,{runKinds:['generation']});assert.equal(reclaimed?.runId,lease.runId);assert.notEqual(reclaimed!.token,lease.token);assert.equal(reclaimed!.attempts,2);
  await assert.rejects(renew(worker,lease,60));
  assert.equal((await finish(other,reclaimed!,'failed',{errorCode:'DATA_UNAVAILABLE'})).state,'failed');
 });
 await t.test('an active model waiter blocks handoff and a user pause is honored',async()=>{
  const lease=await next();await releaseLease(worker,lease);
  const waiter=randomUUID();await admin.query("INSERT INTO bb_model_capacity_scopes(scope) VALUES('synthetic-release')");
  await admin.query("INSERT INTO bb_model_capacity_waiters(token,scope,wait_until,execution_session_id) VALUES($1,'synthetic-release',now()+interval '60 seconds',$2)",[waiter,session]);
  assert.equal(await completeManagedRunRelease(worker,lease,proof),'blocked');
  await admin.query('DELETE FROM bb_model_capacity_waiters WHERE token=$1',[waiter]);
  await admin.query('UPDATE bb_jobs SET user_pause_requested=true WHERE id=$1',[lease.jobId]);
  assert.equal(await completeManagedRunRelease(worker,lease,proof),'paused');
  assert.equal((await admin.query('SELECT stage FROM bb_jobs WHERE id=$1',[lease.jobId])).rows[0].stage,'user_paused');
 });
 await t.test('an active model holder blocks handoff; concurrent claimers get exactly one new token',async()=>{
  const lease=await next(),holder=randomUUID();
  await transaction(admin,async client=>{
   await client.query("SELECT set_config('bb.execution_lease_token',$1,true)",[lease.token]);
   await client.query(`INSERT INTO bb_model_capacity_holders(token,scope,slot,host_id,execution_host,host_boot_id,pid_namespace,namespace_init_start,parent_pid,parent_start,execution_session_id,execution_node_id,execution_node_epoch,node_slot,admission_job_id)
    SELECT $1,'synthetic-release',1,'synthetic','synthetic','synthetic','synthetic','synthetic',1,'synthetic',execution_session_id,execution_node_id,execution_node_epoch,1,id FROM bb_jobs WHERE id=$2`,[holder,lease.jobId]);
  });
  await releaseLease(worker,lease);assert.equal(await completeManagedRunRelease(worker,lease,proof),'blocked');
  await admin.query('DELETE FROM bb_model_capacity_holders WHERE token=$1',[holder]);
  assert.equal(await completeManagedRunRelease(worker,lease,proof),'queued');
  const claims=await Promise.all([claim(worker,60,{runKinds:['generation']}),claim(other,60,{runKinds:['generation']})]);
  assert.equal(claims.filter(Boolean).length,1);const index=claims[0]?0:1,reclaimed=claims[index]!;
  assert.notEqual(reclaimed.token,lease.token);assert.equal(reclaimed.attempts,2);
  await finish(index===0?worker:other,reclaimed,'failed',{errorCode:'DATA_UNAVAILABLE'});
 });
 await t.test('unknown supplier attempt is parked, never replayed by the handoff',async()=>{
  const lease=await next();
  await admin.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status) VALUES($1,$2,$3,'synthetic-unknown',1,'pending_reconcile')",[randomUUID(),owner,lease.jobId]);
  await releaseLease(worker,lease);assert.equal(await completeManagedRunRelease(worker,lease,proof),'paused');
  assert.equal((await admin.query('SELECT stage FROM bb_jobs WHERE id=$1',[lease.jobId])).rows[0].stage,'provider_reconcile');
  assert.equal(await claim(other,60,{runKinds:['generation']}),null);
 });
 await t.test('scoped handoff ignores B holders but retains legacy whole-session protection',async()=>{
  const a=await next(),b=await next(),holder=await addHolder(b);
  await releaseLease(worker,a);
  assert.equal(await completeManagedRunRelease(worker,a,proof),'blocked');
  assert.equal(await completeManagedRunRelease(worker,a,scopedProof(a)),'queued');
  assert.equal((await admin.query('SELECT lease_token FROM bb_jobs WHERE id=$1',[b.jobId])).rows[0].lease_token,b.token);
  await admin.query('DELETE FROM bb_model_capacity_holders WHERE token=$1',[holder]);
  await finish(worker,b,'failed',{errorCode:'DATA_UNAVAILABLE'});
  const reclaimed=await claim(other,60,{runKinds:['generation']});assert.equal(reclaimed?.jobId,a.jobId);
  await finish(other,reclaimed!,'failed',{errorCode:'DATA_UNAVAILABLE'});
 });
 await t.test('same-job holders and cross-session waiters block scoped release; exact fences reject malformed proofs',async()=>{
  const lease=await next(),holder=await addHolder(lease),waiter=randomUUID(),scoped=scopedProof(lease);
  await admin.query("INSERT INTO bb_model_capacity_waiters(token,scope,wait_until,execution_session_id,admission_job_id) VALUES($1,'synthetic-release',now()+interval '60 seconds',$2,$3)",[waiter,otherSession,lease.jobId]);
  await releaseLease(worker,lease);
  for(const invalid of [{...scoped,jobId:randomUUID()},{...scoped,token:randomUUID()},
   {...scoped,epoch:randomUUID()},{...scoped,sessionId:randomUUID()},{...scoped,cgroupIdentity:'unknown'}])
   await assert.rejects(completeManagedRunRelease(worker,lease,invalid),/SCOPE_MISMATCH/);
  await assert.rejects(completeManagedRunRelease(other,lease,scoped),/SCOPE_MISMATCH/);
  assert.equal(await completeManagedRunRelease(worker,lease,scoped),'blocked');
  await admin.query('DELETE FROM bb_model_capacity_holders WHERE token=$1',[holder]);
  assert.equal(await completeManagedRunRelease(worker,lease,scoped),'blocked','waiter from another session retains the exact job fence');
  await admin.query('DELETE FROM bb_model_capacity_waiters WHERE token=$1',[waiter]);
  assert.deepEqual((await Promise.all([completeManagedRunRelease(worker,lease,scoped),completeManagedRunRelease(worker,lease,scoped)])).sort(),['queued','stale']);
  const claims=await Promise.all([claim(worker,60,{runKinds:['generation']}),claim(other,60,{runKinds:['generation']})]);
  assert.equal(claims.filter(Boolean).length,1);
  const index=claims[0]?0:1,reclaimed=claims[index]!;
  assert.notEqual(reclaimed.token,lease.token);
  assert.equal(await completeManagedRunRelease(worker,lease,scoped),'stale');
  await finish(index===0?worker:other,reclaimed,'failed',{errorCode:'DATA_UNAVAILABLE'});
 });
 await t.test('audit is appended exactly once when a retried job fails',async()=>{
  const lease=await next(),errorId=randomUUID();
  await admin.query(`INSERT INTO bb_observability_errors(id,owner_user_id,project_id,job_id,trace_id,stage,category,code,fingerprint,retry_count,recovery_status)
    VALUES($1,$2,$3,$3,$3,'model_generation','internal','DATA_UNAVAILABLE',$4,1,'retry_scheduled')`,[errorId,owner,lease.jobId,hash]);
  await finish(worker,lease,'failed',{errorCode:'DATA_UNAVAILABLE'});
  const rows=await admin.query('SELECT outcome FROM bb_error_recovery_events WHERE error_id=$1',[errorId]);assert.deepEqual(rows.rows,[{outcome:'retried_failed'}]);
  await worker.query("UPDATE bb_jobs SET state='failed' WHERE id=$1",[lease.jobId]);
  assert.equal((await admin.query('SELECT count(*)::int n FROM bb_error_recovery_events WHERE error_id=$1',[errorId])).rows[0].n,1);
 });
 await t.test('real pipeline retry and exhausted retry budget reach a terminal state with the captured role',{skip:!process.env.BB_SYNTHETIC_TASK_CGROUP_CONTEXT},async()=>{
  const id=await add();let captured:Awaited<ReturnType<typeof claim>>=null;
  const dependencies={pool:worker,blobs:{} as PrivateBlobs,runKinds:['generation'] as const,leaseSeconds:60,
   stages:[{name:'model_generation',run:async()=>{throw Error('synthetic transient infrastructure failure');}}],
   onLease:(lease:Awaited<ReturnType<typeof claim>>)=>{if(lease)captured=lease;}};
  const barrier=new ManagedRunRetries(taskNativeProcesses,async lease=>{
   const result=await completeManagedRunRelease(worker,lease,taskReleaseProof(worker,lease));
   if(result!=='blocked')await retireTaskExecution(lease);
   return result;
  });
  for(let attempt=1;attempt<=3;attempt++){
   const leave=barrier.enter()!;
   const result=await runPipelineOnce(dependencies);assert.equal(result,attempt<3?'retry':'failed');
   if(result==='retry')barrier.defer(captured!);leave();await barrier.flush();
  }
  const row=(await admin.query('SELECT state,attempts,lease_token FROM bb_jobs WHERE id=$1',[id])).rows[0];
  assert.deepEqual(row,{state:'failed',attempts:3,lease_token:null});
 });
 await t.test('actual two-slot runtime retries a clean A while B stays running; exact attempts terminate at three',{skip:!process.env.BB_SYNTHETIC_TASK_CGROUP_CONTEXT},async t=>{
  // Run this file in its own PID namespace (e.g. Docker entrypoint node --test).
  // No mocked process inventory, database, queue, pipeline or runtime loop.
  const retryId=await add(),peerId=await add(),logs:Record<string,unknown>[]=[];
  let releasePeer!:()=>void,peerStarted!:()=>void;
  const peerGate=new Promise<void>(r=>{releasePeer=r;}),started=new Promise<void>(r=>{peerStarted=r;});
  await admin.query('UPDATE bb_jobs SET checkpoint=$2 WHERE id=$1',[retryId,{stages:{input_lock:{synthetic:true}}}]);
  const runtime=new WorkerRuntime({pool:worker,blobs:{} as PrivateBlobs,kinds:['run'],runKinds:['generation'],concurrency:2,interactiveSlots:0,parseSlots:0,
   pollMs:20,heartbeatMs:30,sweepMs:1000,leaseSeconds:60,executionTransport:{refresh:async()=>{},ready:()=>true,close:()=>{}},log:e=>logs.push(e),
   runStages:[{name:'model_generation',run:async ctx=>{
    if(ctx.lease.jobId===peerId){
     const child=spawn('/usr/bin/python3',['-c',"import time;print('ready',flush=True);time.sleep(120)"],{stdio:['ignore','pipe','ignore']});
     const exit=once(child,'exit');
     try{await once(child.stdout,'data');peerStarted();await peerGate;return {kind:'fail',code:'DATA_UNAVAILABLE'};}
     finally{child.kill('SIGTERM');await exit;}
    }
    await started;throw Error('synthetic transient infrastructure failure');
   }}]}).start();
  t.after(async()=>{releasePeer();await runtime.stop();});
  const until=async(check:()=>Promise<boolean>)=>{for(let n=0;n<200;n++){if(await check())return;await delay(20);}assert.fail(JSON.stringify(logs.slice(-12)));};
  await until(async()=>logs.some(e=>e.kind==='run'&&e.outcome==='retry'));
  await until(async()=>(await admin.query('SELECT state FROM bb_jobs WHERE id=$1',[retryId])).rows[0].state==='failed');
  assert.equal((await admin.query('SELECT attempts FROM bb_jobs WHERE id=$1',[retryId])).rows[0].attempts,3);
  assert.equal((await admin.query("SELECT count(*)::int n FROM bb_run_events WHERE run_id=$1 AND payload->>'reason'='worker_retry_released'",[retryId])).rows[0].n,2);
  assert.equal((await admin.query('SELECT state FROM bb_jobs WHERE id=$1',[peerId])).rows[0].state,'running');
  releasePeer();
  await until(async()=>(await admin.query("SELECT count(*)::int n FROM bb_jobs WHERE id=ANY($1::text[]) AND state='failed'",[[retryId,peerId]])).rows[0].n===2);
  const row=(await admin.query('SELECT attempts,lease_token,checkpoint FROM bb_jobs WHERE id=$1',[retryId])).rows[0];
  assert.equal(row.attempts,3);assert.equal(row.lease_token,null);assert.deepEqual(row.checkpoint.stages.input_lock,{synthetic:true});
  assert.equal((await admin.query("SELECT count(*)::int n FROM bb_run_events WHERE run_id=$1 AND payload->>'reason'='worker_retry_released'",[retryId])).rows[0].n,2);
  assert.equal((await admin.query('SELECT attempts FROM bb_jobs WHERE id=$1',[peerId])).rows[0].attempts,1);
  await runtime.stop();
 });
});
