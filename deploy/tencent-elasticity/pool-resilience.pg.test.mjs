import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {claim,renew} from '@bondbuddy/api/queue';
import {configureExecutionCapacity,executionCapacityControl,heartbeatExecutionRuntime,registerExecutionRuntime} from '@bondbuddy/api/execution-capacity';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {isolatedTestDatabase} from '../../apps/api/dist/test-database.js';
import {expensePeriod} from './costcap.mjs';
import {createExecutionPoolOpsHandler} from './ops-handler.mjs';
import {planCapacity} from './policy.mjs';

const connection=await isolatedTestDatabase(undefined,'pool-resilience');
const serviceConnection=await isolatedTestDatabase(undefined,'pool-service-isolation');
const hash='a'.repeat(64);
const config={...JSON.parse(await readFile(new URL('./pool.example.json',import.meta.url),'utf8')),
 enabled:true,account_id:'123456',cloud_quote_refresh:undefined,global_model_limit:8,node_model_limit:8,
 expense_policy_sha256:hash,expense_policy_revision:1,quote_sha256:hash,total_cap_cny_per_hour:4};
const services=[{service_id:'authoring',capabilities:['authoring']},{service_id:'review',capabilities:['review','assistant']}];
const identity={account_id:config.account_id,region:config.region,instance_id:'ins-test1',epoch:randomUUID()};
const registration='synthetic-registration-token-0123456789';

async function setup(t,connectionString){
 const pool=new Pool({connectionString});
 const authoring=new Pool({connectionString});
 const review=new Pool({connectionString});
 t.after(()=>Promise.all([pool.end(),authoring.end(),review.end()]));
 const control=executionCapacityControl(pool);
 const policyInput={managed_nodes:true,budget_available:true,global_model_limit:8,node_model_limit:8,
  max_nodes:2,provider_concurrency_limit:8,provider_policy_sha256:hash,expense_policy_sha256:config.expense_policy_sha256};
 await configureExecutionCapacity(pool,0,policyInput);
 await pool.query(`INSERT INTO bb_execution_nodes
  (id,account_id,region,instance_id,epoch,state,source_sha256,image_sha256,launch_manifest_sha256,capabilities,expected_services,registration_token_sha256,cloud_start_operation_id)
  VALUES($1,$2,$3,$1,$4,'starting',$5,$5,$5,$6,$7,$8,$1)`,[identity.instance_id,identity.account_id,identity.region,
    identity.epoch,hash,services.flatMap(service=>service.capabilities),JSON.stringify(services),createHash('sha256').update(JSON.stringify(registration)).digest('hex')]);
 async function enroll(runtime,service){
  await registerExecutionRuntime(runtime,{identity,session_id:randomUUID()},{...service,source_sha256:hash,image_sha256:hash,
   launch_manifest_sha256:hash,registration_token:registration,process_identity:{pid:String(process.pid),boot:'synthetic'}});
  await heartbeatExecutionRuntime(runtime,{native_processes:0,unpersisted_results:0,ready:true});
 }
 return {pool,authoring,review,control,enroll};
}

async function addJob(pool,kind){
 const id=randomUUID(),owner='synthetic-resilience-owner',manifest={synthetic:true},inputHash=inputManifestHash(manifest);
 await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'synthetic', $3)",[id,owner,kind]);
 await pool.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,$4,'[]','[]')",[id,owner,inputHash,manifest]);
 await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$1,1,$3,$1,$4,$3,'queued')",[id,owner,inputHash,kind]);
 await pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state) VALUES($1,$2,$1,$3,'default','queued')",[id,owner,kind]);
 return id;
}

test('local coordinator failure preserves verified admission and a healthy first claim',{skip:!connection},async t=>{
 const {authoring,review,pool,control,enroll}=await setup(t,connection);
 await enroll(authoring,services[0]);await enroll(review,services[1]);
 const job=await addJob(pool,'generation');
 const before=(await control.snapshot()).policy;
 const logs=[];let reads=0,dispatches=0;
 const observed=new Date().toISOString();
 // Synthetic cloud evidence is used only to drive the real PG budget and lease gates.
 const expense={version:'execution-cloud-expense-v2',currency:'CNY',account_id:config.account_id,region:config.region,
  observed_at:observed,...expensePeriod(observed,config.time_zone),quote_sha256:config.quote_sha256,
  expense_policy_sha256:config.expense_policy_sha256,policy_revision:config.expense_policy_revision,
  period_cap_cny:config.period_cap_cny,total_hourly_cap_cny:config.total_cap_cny_per_hour,
  inventory_sha256:createHash('sha256').update('[]').digest('hex'),ledger_sha256:hash,quote_component_evidence:Array(6).fill(hash),
  spent_upper_bound_cny:1,reserved_upper_bound_cny:0,unknown_liability_cny:1,drain_reserve_cny:2,
  resident_remaining_period_cny:0,prospective_slot_cny:0,fixed_commitments_upper_bound_cny:0};
 const conflicting={...control,snapshot:async()=>{
  if(++reads===2)throw Error('EXECUTION_CAPACITY_CAS_CONFLICT');
  return control.snapshot();
 }};
 const handler=createExecutionPoolOpsHandler({control:conflicting,configPath:'synthetic',log:event=>logs.push(event),
  dependencies:{readConfig:async()=>config,costSnapshot:async()=>expense,
   cloud:{inventory:async()=>[],execute:async()=>{dispatches++;}}}});
 await handler.tick();
 assert.equal(logs.find(event=>event.event==='execution_pool_reconcile_local_failure')?.stage,'capacity_plan');
 assert.deepEqual((await control.snapshot()).policy,before);
 assert.equal(dispatches,0);
 assert.equal((await claim(authoring,30,{runKinds:['generation']}))?.jobId,job);
});

test('a stale review session preserves authoring claims, spare planning, and the drain proof',{skip:!serviceConnection},async t=>{
 const {authoring,review,pool,control,enroll}=await setup(t,serviceConnection);
 await enroll(authoring,services[0]);
 const authoringJob=await addJob(pool,'generation');
 assert.equal((await control.snapshot()).nodes[0].state,'starting');
 await assert.rejects(claim(authoring,30,{runKinds:['generation']}),/Execution node not ready/);
 await enroll(review,services[1]);
 const oldReview=await addJob(pool,'review');
 const oldLease=await claim(review,30,{runKinds:['review']});
 assert.equal(oldLease?.jobId,oldReview);
 const reviewJob=await addJob(pool,'review');
 await pool.query("UPDATE bb_execution_node_sessions SET heartbeat_at=clock_timestamp()-interval '31 seconds' WHERE service_id='review'");
 await control.snapshot();
 await pool.query("UPDATE bb_execution_work_readiness SET ready_since=clock_timestamp()-interval '120 seconds'");
 const impaired=await control.snapshot();
 assert.equal(impaired.nodes[0].state,'ready');
 assert.equal(impaired.groups.find(g=>g.capability==='authoring').available_run_slots,7);
 for(const capability of ['review','assistant'])assert.equal(impaired.groups.find(g=>g.capability===capability).available_run_slots,0);
 const automatic={...config,phase:'automatic',min_running:0};
 const inventory=[{instance_id:identity.instance_id,instance_state:'RUNNING'},{instance_id:'ins-spare',instance_state:'STOPPED'}];
 assert.deepEqual(planCapacity(impaired,inventory,automatic),{kind:'start',instance_id:'ins-spare',capabilities:['review']});
 const healthyDemand={...impaired,groups:impaired.groups.filter(g=>g.capability==='authoring')};
 assert.equal(planCapacity(healthyDemand,inventory,automatic).kind,'hold');
 assert.equal(planCapacity({...impaired,nodes:[{...impaired.nodes[0],active_leases:0,idle_since:'2026-01-01'}],
  effective_queued_work:0,groups:[]},inventory,automatic).kind,'hold');

 await assert.rejects(claim(review,30,{runKinds:['review']}),/Execution node not ready/);
 await assert.rejects(claim(authoring,30,{runKinds:['review']}),/Execution service capability mismatch/);
 assert.equal((await claim(authoring,30,{runKinds:['generation']}))?.jobId,authoringJob);
 await renew(review,oldLease,120);
 assert.deepEqual((await pool.query('SELECT state,attempts,lease_token FROM bb_jobs WHERE id=$1',[reviewJob])).rows[0],
  {state:'queued',attempts:0,lease_token:null});
 assert.equal((await pool.query('SELECT lease_token FROM bb_jobs WHERE id=$1',[oldReview])).rows[0].lease_token,oldLease.token);

 const operation=randomUUID();
 await control.beginDrain(identity,operation,impaired.nodes[0].revision);
 await assert.rejects(claim(authoring,30,{runKinds:['generation']}),/Execution node not ready/);
 await pool.query("UPDATE bb_jobs SET lease_token=NULL,lease_until=NULL,state='cancelled' WHERE id=ANY($1::text[])",[[authoringJob,oldReview]]);
 await heartbeatExecutionRuntime(authoring,{native_processes:0,unpersisted_results:0,ready:false,finished:true});
 assert.equal(await control.drainProof(identity,operation),null);
 await heartbeatExecutionRuntime(review,{native_processes:0,unpersisted_results:0,ready:false,finished:true});
 assert.equal((await control.drainProof(identity,operation)).positive_session_receipts,2);
});
