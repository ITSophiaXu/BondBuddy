import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {claim} from '@bondbuddy/api/queue';
import {configureExecutionCapacity,executionCapacityControl,heartbeatExecutionRuntime,registerExecutionRuntime} from '@bondbuddy/api/execution-capacity';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {isolatedTestDatabase} from '../../apps/api/dist/test-database.js';
import {expensePeriod} from './costcap.mjs';
import {createExecutionPoolOpsHandler} from './ops-handler.mjs';

const connection=await isolatedTestDatabase(undefined,'pool-resilience');
const hash='a'.repeat(64);
const config={...JSON.parse(await readFile(new URL('./pool.example.json',import.meta.url),'utf8')),
 enabled:true,account_id:'123456',cloud_quote_refresh:undefined,global_model_limit:8,node_model_limit:8,
 expense_policy_sha256:hash,expense_policy_revision:1,quote_sha256:hash,total_cap_cny_per_hour:4};
const services=[{service_id:'authoring',capabilities:['authoring']},{service_id:'review',capabilities:['review','assistant']}];
const identity={account_id:config.account_id,region:config.region,instance_id:'ins-test1',epoch:randomUUID()};
const registration='synthetic-registration-token-0123456789';

async function setup(t){
 const pool=new Pool({connectionString:connection});
 const authoring=new Pool({connectionString:connection});
 const review=new Pool({connectionString:connection});
 t.after(()=>Promise.all([pool.end(),authoring.end(),review.end()]));
 const control=executionCapacityControl(pool);
 const policyInput={managed_nodes:true,budget_available:true,global_model_limit:8,node_model_limit:8,
  max_nodes:2,provider_concurrency_limit:8,provider_policy_sha256:hash,expense_policy_sha256:config.expense_policy_sha256};
 if((await control.snapshot()).policy.revision===0)await configureExecutionCapacity(pool,0,policyInput);
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
 const {authoring,review,pool,control,enroll}=await setup(t);
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
