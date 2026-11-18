import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {claim} from '@bondbuddy/api/queue';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {PgModelCallBudget} from './model-call-budget.js';
import {isolatedTestDatabase} from './test-database.js';
const database=await isolatedTestDatabase(undefined,'capacity-ownership');
for(const change of ['expired','lease_changed','cancelled','task_signal'] as const)test(`renewal stops on ${change}, keeping the holder until process exit`,{skip:!database,timeout:15000},async()=>{
 const pool=new Pool({connectionString:database}),id=randomUUID(),owner=randomUUID(),hash=inputManifestHash({synthetic:true}),signal=new AbortController();
 const budget=new PgModelCallBudget(pool);
 let permit:Awaited<ReturnType<typeof budget.acquire>>|undefined;
 try{
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'renew_'+owner.slice(0,8)]);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'synthetic','generation')",[id,owner]);
  await pool.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,$4,'[]','[]')",[id,owner,hash,{synthetic:true}]);
  await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$1,1,$3,$1,'generation',$3,'queued')",[id,owner,hash]);
  await pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state) VALUES($1,$2,$1,'generation','default','queued')",[id,owner]);
  const lease=await claim(pool,60,{runKinds:['generation']});assert.ok(lease);assert.equal(lease.runId,id);
  permit=await budget.acquire(signal.signal,'ownership:'+id,{kind:'job',id:lease.jobId,token:lease.token});await permit.renew();assert.equal(permit.signal.aborted,false);
  if(change==='expired')await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[id]);
  if(change==='lease_changed')await pool.query('UPDATE bb_jobs SET lease_token=$2 WHERE id=$1',[id,randomUUID()]);
  if(change==='cancelled')await pool.query("UPDATE bb_jobs SET billing_cancel_requested_at=now() WHERE id=$1",[id]);
  if(change==='task_signal')signal.abort();
  await assert.rejects(permit.renew());assert.equal(permit.signal.aborted,true);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_capacity_holders WHERE admission_job_id=$1',[id])).rows[0].n,1);
 }finally{
  await permit?.release();await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE id=$1",[id]);
  await (budget as unknown as {sessions:Pool}).sessions.end();await pool.end();
 }
});
