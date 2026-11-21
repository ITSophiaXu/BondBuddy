// Synthetic isolated PostgreSQL test. No production connection, cloud stop or supplier call.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Pool} from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {isolatedTestDatabase} from '../apps/api/dist/test-database.js';
import {resumeEvidenceGate,resumeDatabaseRestoreGate,restoreBillingSnapshot,restoreCanonical} from '../apps/api/dist/evidence-gate.js';
import {grantCredits} from '../apps/api/dist/billing.js';
import {transaction} from '../apps/api/dist/data.js';
import {quarantineRestoredDatabase} from './verify-restore.mjs';

const template=process.env.BB_TEST_DATABASE_URL;
if(!template||!['127.0.0.1','localhost'].includes(new URL(template).hostname)||!new URL(template).pathname.startsWith('/bb_middle_template'))
  throw new Error('isolated local synthetic BB_TEST_DATABASE_URL required');
const connection=await isolatedTestDatabase(undefined,'database-restore-guard');
const digest=v=>createHash('sha256').update(restoreCanonical(v)).digest('hex');

test('restore SQL preserves old tokens, quarantines lost intent, and permits only a verified account',{timeout:60000},async t=>{
  const pool=new Pool({connectionString:connection});t.after(()=>pool.end());
  const safe='restore-safe-'+randomUUID(),unsafe='restore-unknown-'+randomUUID(),run=randomUUID();
  await pool.query("INSERT INTO bb_users(id,username) VALUES($1,'restore_safe_fixture'),($2,'restore_unknown_fixture')",[safe,unsafe]);
  await transaction(pool,c=>grantCredits(c,{owner:unsafe,source:'existing_grant',key:'synthetic-restore-ledger',points:1000,expiresAt:null,actor:'synthetic-fixture',reason:'nonempty restore ledger verification'}));
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'synthetic restore','generation')",[run,unsafe]);
  const manifest={synthetic_restore:true},inputHash=digest(manifest);
  await pool.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,$4,'[]','[]')",[run,unsafe,inputHash,manifest]);
  await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$1,1,$3,$1,'generation',$3,'running')",[run,unsafe,inputHash]);
  await pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,lease_token,lease_until) VALUES($1,$2,$1,'generation','default','running','synthetic-old-token',now()+interval '1 hour')",[run,unsafe]);
  await pool.query('INSERT INTO bb_authoring_progress(run_id,owner_user_id,active_ms,work_bps,accrued_points) VALUES($1,$2,9000,400,12)',[run,unsafe]);
  await pool.query("INSERT INTO bb_run_model_activity(request_id,owner_user_id,run_id,job_id,lease_token,state) VALUES($1,$2,$1,$1,'synthetic-old-token','active')",[run,unsafe]);
  const originalMoney=await restoreBillingSnapshot(pool,unsafe);
  const originalUsage=(await pool.query('SELECT row_to_json(t) record FROM bb_usage_observations t ORDER BY id')).rows;
  const accounts=(await pool.query('SELECT id FROM bb_users')).rows.map(row=>row.id);
  const receipt={version:'database-restore-safety-v1',restore_id:randomUUID(),backup_sha256:'a'.repeat(64),control_epoch:randomUUID(),
    audit:{complete:true,backup_at:'2026-11-21T00:00:00Z',covered_until:'2026-11-21T02:00:00Z'},account_ids:accounts,fences:[],never_sent_runs:[],
    calls:[{attempt_id:'synthetic-lost-intent',owner_user_id:unsafe,run_id:run,job_id:run,logical_call_id:'synthetic-sent-call',status:'unknown'}],
    billing:[{owner_user_id:safe,sha256:digest(await restoreBillingSnapshot(pool,safe)),consistent:true},
      {owner_user_id:unsafe,sha256:digest(await restoreBillingSnapshot(pool,unsafe)),consistent:true}]};
  receipt.manifest_sha256=digest(receipt);
  assert.equal((await quarantineRestoredDatabase(pool,receipt)).unknown,1);
  const job=(await pool.query('SELECT state,lease_token,checkpoint FROM bb_jobs WHERE id=$1',[run])).rows[0];
  assert.equal(job.state,'paused');assert.equal(job.lease_token,'synthetic-old-token');
  assert.equal(job.checkpoint.database_restore_quarantine.classification,'unknown');
  assert.ok(job.checkpoint.database_restore_quarantine.reasons.includes('lost_intent'));
  const runState=(await pool.query('SELECT state,event_cursor FROM bb_runs WHERE id=$1',[run])).rows[0];
  assert.equal(runState.state,'paused');assert.equal(runState.event_cursor,1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM bb_run_events WHERE run_id=$1 AND stage='database_restore_quarantine'",[run])).rows[0].n,1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_id=$1 AND payload->>'stage'='database_restore_quarantine'",[run])).rows[0].n,1);
  assert.deepEqual(await restoreBillingSnapshot(pool,unsafe),originalMoney,'quarantine cannot bill, change credits or advance active-time meters');
  assert.deepEqual((await pool.query('SELECT row_to_json(t) record FROM bb_usage_observations t ORDER BY id')).rows,originalUsage);
  await quarantineRestoredDatabase(pool,receipt);
  assert.equal((await pool.query('SELECT event_cursor FROM bb_runs WHERE id=$1',[run])).rows[0].event_cursor,1,'quarantine retry cannot append a second pause');
  await assert.rejects(resumeEvidenceGate(pool,'synthetic-operator','normal_resume'),e=>e.code==='RESTORE_QUARANTINE_REQUIRES_RECONCILIATION');
  assert.equal((await pool.query('SELECT bb_restore_account_permitted($1) permitted',[safe])).rows[0].permitted,false);
  await assert.rejects(pool.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status) VALUES('late-old-worker',$1,$2,'late-old-worker',1,'pending_reconcile')",[unsafe,run]),e=>e.code==='55000');
  const result=await resumeDatabaseRestoreGate(pool,'synthetic-operator',{quarantine_id:receipt.restore_id,manifest_sha256:receipt.manifest_sha256,owner_user_ids:[safe]},async()=>{throw Error('unexpected model-result read');});
  assert.deepEqual(result.permitted_owner_user_ids,[safe]);
  assert.equal((await pool.query('SELECT bb_restore_account_permitted($1) permitted',[safe])).rows[0].permitted,true);
  assert.equal((await pool.query('SELECT bb_restore_account_permitted($1) permitted',[unsafe])).rows[0].permitted,false);
  assert.equal((await pool.query('SELECT bb_restore_account_permitted($1) permitted',['new-post-restore-account'])).rows[0].permitted,true);
  await assert.rejects(resumeDatabaseRestoreGate(pool,'synthetic-operator',{quarantine_id:receipt.restore_id,manifest_sha256:receipt.manifest_sha256,owner_user_ids:[unsafe]},async()=>Buffer.from('unverified')),e=>e.code==='RESTORE_RECONCILIATION_REQUIRED');
  await assert.rejects(pool.query("UPDATE bb_database_restore_quarantines SET manifest_sha256=repeat('b',64) WHERE id=$1",[receipt.restore_id]),e=>e.code==='23514');
  await assert.rejects(pool.query('DELETE FROM bb_database_restore_reconciliations WHERE quarantine_id=$1',[receipt.restore_id]),e=>e.code==='23514');
  assert.equal((await pool.query('SELECT lease_token FROM bb_jobs WHERE id=$1',[run])).rows[0].lease_token,'synthetic-old-token');
});

test('completed result recovery rejects missing or altered private bytes before opening an account',{timeout:60000},async t=>{
  const db=await isolatedTestDatabase(undefined,'database-restore-result');
  const pool=new Pool({connectionString:db});t.after(()=>pool.end());
  const owner=randomUUID(),run=randomUUID(),attempt=randomUUID(),snapshot=randomUUID(),result=randomUUID();
  await pool.query("INSERT INTO bb_users(id,username) VALUES($1,'restore_result_fixture')",[owner]);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'synthetic completed restore','generation')",[run,owner]);
  const manifest={synthetic_restore_result:true},inputHash=digest(manifest);
  await pool.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,$4,'[]','[]')",[run,owner,inputHash,manifest]);
  await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$1,1,$3,$1,'generation',$3,'running')",[run,owner,inputHash]);
  await pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,attempts) VALUES($1,$2,$1,'generation','default','running',1)",[run,owner]);
  await pool.query("INSERT INTO bb_snapshot_refs(id,owner_user_id,project_id,run_id,snapshot_kind,version,object_key,content_sha256,redaction_version) VALUES($1,$2,$3,$3,'model_request',1,$4,$5,'synthetic')",[snapshot,owner,run,`users/${owner}/projects/${run}/snapshots/restore`,inputHash]);
  await pool.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status,usage_status,prompt_snapshot_id) VALUES($1,$2,$3,'synthetic-completed',1,'completed','measured',$4)",[attempt,owner,run,snapshot]);
  const bytes=Buffer.from('{"version":"synthetic-provider-result","completed":true}');
  const resultHash=createHash('sha256').update(bytes).digest('hex'),ref=`users/${owner}/projects/${run}/provider-results/${attempt}-${resultHash}.json`;
  await pool.query(`INSERT INTO bb_provider_result_refs(id,owner_user_id,project_id,job_id,run_id,attempt_id,logical_call_id,attempt_no,call_id,trace_id,model_id,model_config_version,prompt_snapshot_ref,result_ref,result_sha256,result_schema_version,byte_size,media_type)
    VALUES($1,$2,$3,$3,$3,$4,'synthetic-completed',1,$4,$3,'synthetic-deepseek','synthetic',$5,$6,$7,'synthetic', $8,'application/json')`,[result,owner,run,attempt,snapshot,ref,resultHash,bytes.length]);
  await pool.query(`INSERT INTO bb_provider_call_observations(id,owner_user_id,project_id,job_id,run_id,attempt_id,logical_call_id,attempt_no,call_id,trace_id,model_id,model_config_version,prompt_snapshot_ref,result_id,outcome,finish_reason,usage_status,input_tokens,output_tokens,total_tokens,observation_hash)
    VALUES($1,$2,$3,$3,$3,$4,'synthetic-completed',1,$4,$3,'synthetic-deepseek','synthetic',$5,$6,'completed','stop','measured',10,5,15,$7)`,[randomUUID(),owner,run,attempt,snapshot,result,resultHash]);
  const billing=await restoreBillingSnapshot(pool,owner);
  const receipt={version:'database-restore-safety-v1',restore_id:randomUUID(),backup_sha256:'a'.repeat(64),control_epoch:randomUUID(),
    audit:{complete:true,backup_at:'2026-11-21T00:00:00Z',covered_until:'2026-11-21T02:00:00Z'},account_ids:(await pool.query('SELECT id FROM bb_users')).rows.map(row=>row.id),fences:[],never_sent_runs:[],
    calls:[{attempt_id:attempt,owner_user_id:owner,run_id:run,job_id:run,logical_call_id:'synthetic-completed',status:'completed_verified',result_ref:ref,result_sha256:resultHash}],
    billing:[{owner_user_id:owner,sha256:digest(billing),consistent:true}]};
  receipt.manifest_sha256=digest(receipt);
  await quarantineRestoredDatabase(pool,receipt);
  const input={quarantine_id:receipt.restore_id,manifest_sha256:receipt.manifest_sha256,owner_user_ids:[owner]};
  for(const candidate of [Buffer.alloc(0),Buffer.from('changed private bytes')]){
    await assert.rejects(resumeDatabaseRestoreGate(pool,'synthetic-operator',input,async key=>{assert.equal(key,ref);return candidate;}),e=>e.code==='RESTORE_OBJECT_HASH_MISMATCH');
    assert.equal((await pool.query('SELECT bb_restore_account_permitted($1) permitted',[owner])).rows[0].permitted,false);
    assert.equal((await pool.query('SELECT state FROM bb_evidence_gate_events ORDER BY seq DESC LIMIT 1')).rows[0].state,'paused');
  }
  await resumeDatabaseRestoreGate(pool,'synthetic-operator',input,async()=>bytes);
  assert.equal((await pool.query('SELECT bb_restore_account_permitted($1) permitted',[owner])).rows[0].permitted,true);
  assert.deepEqual(await restoreBillingSnapshot(pool,owner),billing,'object reconciliation does not alter ledger or meters');
  assert.equal((await pool.query('SELECT status FROM bb_model_call_attempts WHERE id=$1',[attempt])).rows[0].status,'completed');
});
