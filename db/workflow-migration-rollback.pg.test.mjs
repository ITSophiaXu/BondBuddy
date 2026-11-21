// Synthetic disposable PostgreSQL and local spool. This is mechanical rollback
// verification; it does not execute a cloud stop or replace a deployed image.
import assert from 'node:assert/strict';
import test from 'node:test';
import {Client,Pool} from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {isolatedTestDatabase} from '../apps/api/dist/test-database.js';
import {claim,pauseRun,completeManagedRunRelease} from '../apps/api/dist/queue.js';
import {configureExecutionCapacity,registerExecutionRuntime,heartbeatExecutionRuntime} from '../apps/api/dist/execution-capacity.js';
import {inputManifestHash} from '../apps/api/dist/production-rule-pin.js';
import {grantCredits} from '../apps/api/dist/billing.js';
import {transaction} from '../apps/api/dist/data.js';
import {restoreBillingSnapshot,restoreCanonical,resumeDatabaseRestoreGate} from '../apps/api/dist/evidence-gate.js';
import {quarantineRestoredDatabase} from './verify-restore.mjs';
import {sealDurableSpool,readDurableSpool,pendingDurableSpool} from '../apps/worker/dist/durable-spool.js';

const template=process.env.BB_TEST_DATABASE_URL;
if(!template||!['127.0.0.1','localhost'].includes(new URL(template).hostname)||!new URL(template).pathname.startsWith('/bb_middle_template'))
  throw Error('isolated local synthetic BB_TEST_DATABASE_URL required');
const digest=value=>createHash('sha256').update(value).digest('hex');
const migrations=fileURLToPath(new URL('./migrations/',import.meta.url));
const runner=fileURLToPath(new URL('./migrate.mjs',import.meta.url));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function startMigration(directory,connectionString){
  const child=spawn(process.execPath,[runner],{cwd:directory,env:{...process.env,DATABASE_URL:connectionString},stdio:['ignore','pipe','pipe']});
  let output='';for(const pipe of [child.stdout,child.stderr])pipe.on('data',bytes=>{output+=bytes.toString();});
  const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,output}));});
  return {child,closed};
}

test('actual migration runner rolls back interrupted workflow DDL then reapplies original migration once',{timeout:120000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'workflow-migrate-interruption-'));
  const target=join(directory,'db','migrations');await mkdir(target,{recursive:true});
  const filename='0199_workflow_phase_capacity.sql';
  // Create an empty database, not a production target or a pre-migrated clone.
  const url=new URL(template),maintenance=new URL(template);maintenance.pathname='/postgres';
  const name='bb_middle_migration_'+randomUUID().replaceAll('-','');
  const admin=new Client({connectionString:maintenance.toString()});await admin.connect();
  let pool,blocker,interrupted;
  t.after(async()=>{
    if(interrupted&&interrupted.child.exitCode===null&&!interrupted.child.killed){interrupted.child.kill('SIGKILL');await interrupted.closed;}
    await blocker?.end();await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await admin.end();
    await rm(directory,{recursive:true,force:true});
  });
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  url.pathname='/'+name;const application='workflow-migration-'+randomUUID();url.searchParams.set('application_name',application);
  pool=new Pool({connectionString:url.toString()});blocker=new Client({connectionString:url.toString()});
  await blocker.connect();
  for(const file of (await readdir(migrations)).filter(file=>/^\d+.*\.sql$/.test(file)&&file<filename).sort())
    await writeFile(join(target,file),(await readFile(join(migrations,file),'utf8')).replaceAll('\r\n','\n'));
  const baseline=await startMigration(directory,url.toString()).closed;
  assert.equal(baseline.code,0,baseline.output);
  const baselineCount=Number((await pool.query('SELECT count(*) AS n FROM bb_schema_migrations')).rows[0].n);
  assert.equal((await pool.query("SELECT to_regclass('bb_sealed_model_captures') AS captures")).rows[0].captures,null);
  assert.equal((await pool.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_name='bb_jobs' AND column_name='execution_admission_phase'")).rows[0].n,0);
  const original=(await readFile(join(migrations,filename),'utf8')).replaceAll('\r\n','\n');
  const lock=Number.parseInt(randomUUID().replaceAll('-','').slice(0,7),16);
  await blocker.query('SELECT pg_advisory_lock($1)',[lock]);
  // Only the disposable copied migration has a barrier appended. The source
  // migration bytes and production runner remain unchanged.
  await writeFile(join(target,filename),original+`\nSELECT pg_advisory_lock(${lock}); /* synthetic workflow commit barrier */\n`);
  interrupted=startMigration(directory,url.toString());
  let backend;
  for(let attempt=0;attempt<300;attempt++){
    backend=(await admin.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND wait_event='advisory'",[application])).rows[0];
    if(backend)break;await delay(20);
  }
  assert.ok(backend,'runner reached the appended barrier after executing original DDL inside its transaction');
  assert.equal((await admin.query('SELECT pg_terminate_backend($1) terminated',[backend.pid])).rows[0].terminated,true);
  const stopped=await interrupted.closed;assert.notEqual(stopped.code,0,'interrupted runner must not report success');
  await blocker.query('SELECT pg_advisory_unlock($1)',[lock]);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM bb_schema_migrations')).rows[0].n),baselineCount);
  assert.equal((await pool.query('SELECT 1 FROM bb_schema_migrations WHERE filename=$1',[filename])).rowCount,0);
  assert.equal((await pool.query("SELECT to_regclass('bb_sealed_model_captures') AS captures")).rows[0].captures,null,'CREATE TABLE rolled back');
  assert.equal((await pool.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_name='bb_jobs' AND column_name='execution_admission_phase'")).rows[0].n,0,'ALTER TABLE rolled back');
  assert.equal((await pool.query("SELECT to_regprocedure('bb_workflow_run_eligible(text)') AS fn")).rows[0].fn,null,'CREATE FUNCTION rolled back');
  await writeFile(join(target,filename),original);
  const recovered=await startMigration(directory,url.toString()).closed;assert.equal(recovered.code,0,recovered.output);
  assert.ok((await pool.query("SELECT to_regclass('bb_sealed_model_captures') AS captures")).rows[0].captures);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_schema_migrations WHERE filename=$1',[filename])).rows[0].n,1);
  const schemaBefore=(await pool.query("SELECT attname,atttypid::text FROM pg_attribute WHERE attrelid='bb_jobs'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum")).rows;
  const repeat=await startMigration(directory,url.toString()).closed;assert.equal(repeat.code,0,repeat.output);
  assert.equal(repeat.output.includes(`Applied ${filename}`),false,'retry does not reapply recorded migration');
  assert.deepEqual((await pool.query("SELECT attname,atttypid::text FROM pg_attribute WHERE attrelid='bb_jobs'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum")).rows,schemaBefore);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM bb_schema_migrations')).rows[0].n),baselineCount+1);
});

test('actual pg_dump and pg_restore keep lost post-backup intent unknown and reject unreconciled account',{timeout:60000},async t=>{
  const sourceUrl=await isolatedTestDatabase(undefined,'workflow-backup-restore');
  const source=new Pool({connectionString:sourceUrl}),maintenance=new URL(template);maintenance.pathname='/postgres';
  const admin=new Client({connectionString:maintenance.toString()});await admin.connect();
  const targetName='bb_middle_restored_'+randomUUID().replaceAll('-',''),dumpPath='/tmp/bb_middle_backup_'+randomUUID().replaceAll('-','')+'.dump';
  const targetUrl=new URL(sourceUrl);targetUrl.pathname='/'+targetName;
  const restored=new Pool({connectionString:targetUrl.toString()});
  t.after(async()=>{
    await restored.end();await source.end();await admin.query(`DROP DATABASE IF EXISTS "${targetName}" WITH (FORCE)`);
    // Both filenames and database names are generated fixed-format test values.
    await admin.query(`COPY (SELECT '') TO PROGRAM 'cat >/dev/null; rm -f ${dumpPath}'`);await admin.end();
  });
  const owner=randomUUID(),run=randomUUID(),lostAttempt=randomUUID();
  await source.query("INSERT INTO bb_users(id,username) VALUES($1,'synthetic_actual_restore')",[owner]);
  await transaction(source,c=>grantCredits(c,{owner,source:'existing_grant',key:'synthetic-before-backup',points:100,expiresAt:null,actor:'synthetic',reason:'actual disposable backup fixture'}));
  await source.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'synthetic actual dump','generation')",[run,owner]);
  const manifest={synthetic_actual_restore:true},inputHash=inputManifestHash(manifest);
  await source.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,$4,'[]','[]')",[run,owner,inputHash,manifest]);
  await source.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$1,1,$3,$1,'generation',$3,'running')",[run,owner,inputHash]);
  await source.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,lease_token,lease_until,checkpoint) VALUES($1,$2,$1,'generation','default','running','synthetic-old-token',now()+interval '1 hour',$3)",[run,owner,{synthetic_backup_checkpoint:{input_hash:inputHash,keep:true}}]);
  const backupAt=new Date().toISOString(),sourceName=decodeURIComponent(new URL(sourceUrl).pathname.slice(1));
  assert.match(sourceName,/^[a-zA-Z0-9_]+$/);
  // pg_dump/pg_restore are the actual PostgreSQL 16 server binaries. The
  // disposable trusted superuser invokes them in its own container only;
  // this avoids requiring a client installed in the worker tools image.
  await admin.query(`COPY (SELECT '') TO PROGRAM 'cat >/dev/null; pg_dump -U postgres --format=custom --file=${dumpPath} ${sourceName}'`);
  const dump=(await admin.query('SELECT pg_read_binary_file($1) AS bytes',[dumpPath])).rows[0].bytes;
  assert.ok(Buffer.isBuffer(dump)&&dump.subarray(0,5).toString()==='PGDMP');
  const backupSha=digest(dump),backupMoney=await restoreBillingSnapshot(source,owner);
  await source.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status) VALUES($1,$2,$3,'synthetic-post-backup-call',1,'pending_reconcile')",[lostAttempt,owner,run]);
  await transaction(source,c=>grantCredits(c,{owner,source:'correction',key:'synthetic-after-backup',points:7,expiresAt:null,actor:'synthetic',reason:'post-backup ledger side effect'}));
  const sourceMoney=await restoreBillingSnapshot(source,owner);assert.notDeepEqual(sourceMoney,backupMoney);
  await admin.query(`CREATE DATABASE "${targetName}" TEMPLATE template0`);
  await admin.query(`COPY (SELECT '') TO PROGRAM 'cat >/dev/null; pg_restore -U postgres --no-owner --exit-on-error --dbname=${targetName} ${dumpPath}'`);
  assert.equal(digest((await admin.query('SELECT pg_read_binary_file($1) AS bytes',[dumpPath])).rows[0].bytes),backupSha,'import leaves exact dump bytes intact');
  assert.equal((await restored.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE id=$1',[lostAttempt])).rows[0].n,0,'real old backup has lost post-backup intent');
  assert.deepEqual(await restoreBillingSnapshot(restored,owner),backupMoney,'import reproduces old ledger instead of newer source ledger');
  const checkpoint=(await restored.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[run])).rows[0].checkpoint;
  const receipt={version:'database-restore-safety-v1',restore_id:randomUUID(),backup_sha256:backupSha,control_epoch:randomUUID(),
    audit:{complete:true,backup_at:backupAt,covered_until:new Date().toISOString()},
    account_ids:(await restored.query('SELECT id FROM bb_users')).rows.map(row=>row.id),fences:[],never_sent_runs:[],
    calls:[{attempt_id:lostAttempt,owner_user_id:owner,run_id:run,job_id:run,logical_call_id:'synthetic-post-backup-call',status:'unknown'}],
    billing:[{owner_user_id:owner,sha256:digest(restoreCanonical(sourceMoney)),consistent:false}]};
  receipt.manifest_sha256=digest(restoreCanonical(receipt));
  assert.equal((await quarantineRestoredDatabase(restored,receipt)).unknown,1);
  const parked=(await restored.query('SELECT state,lease_token,checkpoint FROM bb_jobs WHERE id=$1',[run])).rows[0];
  assert.equal(parked.state,'paused');assert.equal(parked.lease_token,'synthetic-old-token');
  assert.deepEqual(parked.checkpoint.synthetic_backup_checkpoint,checkpoint.synthetic_backup_checkpoint);
  assert.ok(parked.checkpoint.database_restore_quarantine.reasons.includes('lost_intent'));
  assert.equal(parked.checkpoint.database_restore_quarantine.classification,'unknown');
  const reconcile={quarantine_id:receipt.restore_id,manifest_sha256:receipt.manifest_sha256,owner_user_ids:[owner]};
  await assert.rejects(resumeDatabaseRestoreGate(restored,'synthetic-operator',reconcile,async()=>{throw Error('no provider result exists');}),e=>e.code==='RESTORE_RECONCILIATION_REQUIRED');
  await assert.rejects(restored.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status) VALUES($1,$2,$3,'synthetic-resend-forbidden',1,'pending_reconcile')",[randomUUID(),owner,run]),e=>e.code==='55000');
  assert.equal((await restored.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[run])).rows[0].n,0);
  assert.deepEqual(await restoreBillingSnapshot(restored,owner),backupMoney,'refused resume never repairs ledger by inventing charges or credits');
  assert.deepEqual(await restoreBillingSnapshot(source,owner),sourceMoney,'restore and quarantine never overwrite the newer source database');
});

test('workflow policy rollback requires positive drain and legacy SQL cannot consume retained v1 jobs',{timeout:60000},async t=>{
  const connection=await isolatedTestDatabase(undefined,'workflow-policy-rollback');
  const pool=new Pool({connectionString:connection}),worker=new Pool({connectionString:connection});
  t.after(async()=>{await worker.end();await pool.end();});
  const local=await mkdtemp(join(tmpdir(),'workflow-rollback-spool-'));t.after(()=>rm(local,{recursive:true,force:true}));
  const owner=randomUUID(),nodeId=randomUUID(),epoch=randomUUID(),sessionId=randomUUID(),h='a'.repeat(64),registration='synthetic-rollback-registration-0123456789';
  await pool.query("INSERT INTO bb_users(id,username) VALUES($1,'synthetic_workflow_rollback')",[owner]);
  await transaction(pool,client=>grantCredits(client,{owner,source:'existing_grant',key:'synthetic-workflow-rollback',points:100,expiresAt:null,actor:'synthetic',reason:'mechanical rollback fixture'}));
  await configureExecutionCapacity(pool,0,{managed_nodes:true,global_model_limit:4,max_nodes:2,budget_available:true,workflow_slots_enabled:true});
  const identity={account_id:'synthetic',region:'synthetic',instance_id:'rollback-node',epoch};
  await pool.query(`INSERT INTO bb_execution_nodes(id,account_id,region,instance_id,epoch,state,source_sha256,image_sha256,launch_manifest_sha256,capabilities,expected_services,registration_token_sha256,cloud_start_operation_id)
    VALUES($1,$2,$3,$4,$5,'ready',$6,$6,$6,ARRAY['authoring','postprocess'],$7,$8,'synthetic-start')`,[nodeId,identity.account_id,identity.region,identity.instance_id,epoch,h,JSON.stringify([{service_id:'authoring',capabilities:['authoring','postprocess'],workflow_protocol_version:1}]),inputManifestHash(registration)]);
  await registerExecutionRuntime(worker,{identity,session_id:sessionId},{service_id:'authoring',capabilities:['authoring','postprocess'],source_sha256:h,image_sha256:h,launch_manifest_sha256:h,registration_token:registration,process_identity:{pid:'1',synthetic:'true'},workflow_protocol_version:1});
  await heartbeatExecutionRuntime(worker,{native_processes:0,unpersisted_results:0,ready:true});
  const ids=[];
  for(const phase of ['authoring','postprocess']){
    const id=randomUUID(),manifest={synthetic:true,authoring:{version:'unified_v1'}},inputHash=inputManifestHash(manifest);ids.push(id);
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'synthetic rollback','generation')",[id,owner]);
    await pool.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,$4,'[]','[]')",[id,owner,inputHash,manifest]);
    await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage) VALUES($1,$2,$1,1,$3,$1,'generation',$3,'queued','queued')",[id,owner,inputHash]);
    const body={version:'authoring-plan-v1',input_hash:inputHash,baseline_hash:null,material_snapshot_hash:h,knowledge_hash:h,
      chapters:[{chapter_id:'one',order:0,title:'Synthetic retained chapter',required:true,depends_on:[],source_node_ids:[],evidence_refs:[],batches:[{batch_id:'first',order:0,allowed_node_ids:[],context_refs:[],output_contract:'document-projection-v1'}]}],
      limits:{call_ms:1000,repair_ms:1000,repair_revisions:2,context_records:600,context_chars:18000,context_bytes:96000,output_bytes:98304}};
    const plan={...body,plan_hash:inputManifestHash(body)},receipt={version:'chapter-receipt-v1',run_id:id,job_id:id,input_hash:inputHash,plan_hash:plan.plan_hash,
      chapter_id:'one',batch_id:'first',logical_call_id:'synthetic-rollback-verified',execution_generation:1,call_status:'completed',
      object:{key:`users/${owner}/projects/${id}/workflow-v1/chapter.json`,sha256:h,byte_size:32},projection_version:0,operations_sha256:null,accepted_op_receipts:[],
      validation:{schema_version:'document-projection-v1',range_verified:true,structure_verified:true,evidence_refs_valid:true},created_at:new Date().toISOString()};
    const workflow={protocol_version:1,input_hash:inputHash,plan_hash:plan.plan_hash,plan,phase,next_cursor:{chapter:1,batch:0},completed:[receipt],run_deadline_at:'2026-12-01T00:00:00.000Z',token_budget:{limit:1000,used_known:100,unknown_calls:[]},repair_budget:{used_ms:30,used_revisions:1},phase_failures:{authoring:0,postprocess:0},handoff_id:randomUUID(),postprocess_manifest:{version:'workflow-postprocess-manifest-v1',input_hash:inputHash,plan_hash:plan.plan_hash,chapter_receipts:[receipt],candidate:{key:`users/${owner}/projects/${id}/workflow-v1/candidate.docx`,sha256:h,byte_size:64}}};
    await pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,checkpoint) VALUES($1,$2,$1,'generation','default','queued','queued',$3)",[id,owner,{workflow_v1:workflow,stages:{synthetic_manifest:{sha256:h}}}]);
  }
  const active=await claim(worker,30,{runKinds:['generation'],workflowPhase:'authoring'});assert.equal(active?.jobId,ids[0]);
  const policyBefore=(await pool.query('SELECT row_to_json(p) record FROM bb_execution_capacity_policy p')).rows[0].record;
  const ownedBefore=(await pool.query('SELECT row_to_json(j) record FROM bb_jobs j WHERE id=$1',[active.jobId])).rows[0].record;
  await assert.rejects(configureExecutionCapacity(pool,policyBefore.revision,{managed_nodes:true,global_model_limit:4,max_nodes:2,budget_available:true,workflow_slots_enabled:false}),/positive drain/);
  assert.deepEqual((await pool.query('SELECT row_to_json(p) record FROM bb_execution_capacity_policy p')).rows[0].record,policyBefore);
  assert.deepEqual((await pool.query('SELECT row_to_json(j) record FROM bb_jobs j WHERE id=$1',[active.jobId])).rows[0].record,ownedBefore,'refused rollback cannot change owner or checkpoint');
  const attempt=randomUUID();await pool.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status) VALUES($1,$2,$3,'synthetic-rollback-call',1,'pending_reconcile')",[attempt,owner,active.jobId]);
  const spool=await sealDurableSpool({root:join(local,'spool'),identity:{ownerUserId:owner,projectId:active.jobId,runId:active.runId,jobId:active.jobId,attemptId:attempt,logicalCallId:'synthetic-rollback-call',attemptNo:1,leaseToken:active.token,inputHash:active.checkpoint.workflow_v1.input_hash,planHash:h,originalExecution:{nodeId,epoch,sessionId}},exitProof:{version:'call_cgroup_v1',sealed:true,nativeProcesses:0,logicalCallId:'synthetic-rollback-call',generation:1,epoch,sessionId,key:h,parentKey:h,identity:'synthetic-call',parentIdentity:'synthetic-parent'},usage:{status:'unknown',input_tokens:null,output_tokens:null,total_tokens:null,cached_input_tokens:null,reasoning_tokens:null},outcome:'timeout',files:[{path:'candidate.docx',bytes:Buffer.from('Synthetic retained candidate Word bytes')}],minFreeBytes:0});
  await pauseRun(worker,active,'provider_reconcile','synthetic_rollback_unknown');
  await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[active.jobId]);
  // Synthetic SQL protocol proof exercises the DB release gate only. Native
  // call/parent safety has its separate real-cgroup acceptance suite.
  assert.equal(await completeManagedRunRelease(worker,active,{version:'task_cgroup_v1',nativeProcesses:0,activeExecutions:0,jobId:active.jobId,token:active.token,epoch,sessionId,cgroupIdentity:epoch+':1:1'}),'paused');
  const checkpoints=(await pool.query('SELECT id,checkpoint FROM bb_jobs WHERE id=ANY($1::text[]) ORDER BY id',[ids])).rows;
  const attempts=(await pool.query('SELECT row_to_json(a) record FROM bb_model_call_attempts a WHERE id=$1',[attempt])).rows;
  const money=await restoreBillingSnapshot(pool,owner),sealed=await readDurableSpool(spool),fileHashes=[];
  for(const file of sealed.files)fileHashes.push([file.path,digest(await readFile(join(spool.directory,file.path)))]);
  await configureExecutionCapacity(pool,policyBefore.revision,{managed_nodes:true,global_model_limit:4,max_nodes:2,budget_available:true,workflow_slots_enabled:false});
  assert.equal((await pool.query('SELECT workflow_slots_enabled FROM bb_execution_capacity_policy WHERE singleton')).rows[0].workflow_slots_enabled,false);
  assert.equal(await claim(worker,30,{runKinds:['generation']}),null,'legacy consumer cannot take v1 postprocess or paused authoring');
  const client=await worker.connect();try{
    await client.query('BEGIN');await client.query("SELECT set_config('bb.execution_node_id',$1,true),set_config('bb.execution_node_epoch',$2,true),set_config('bb.execution_session_id',$3,true)",[nodeId,epoch,sessionId]);
    await assert.rejects(client.query("UPDATE bb_jobs SET state='running',lease_token=$2,lease_until=now()+interval '1 minute' WHERE id=$1",[ids[1],randomUUID()]),/workflow phase mismatch/);
  }finally{await client.query('ROLLBACK');client.release();}
  await assert.rejects(pool.query("UPDATE bb_jobs SET state='queued' WHERE id=$1",[ids[0]]),/verified recovery/,'old resume SQL cannot revive paused v1 work');
  assert.deepEqual((await pool.query('SELECT id,checkpoint FROM bb_jobs WHERE id=ANY($1::text[]) ORDER BY id',[ids])).rows,checkpoints);
  assert.deepEqual((await pool.query('SELECT row_to_json(a) record FROM bb_model_call_attempts a WHERE id=$1',[attempt])).rows,attempts);
  assert.deepEqual(await restoreBillingSnapshot(pool,owner),money,'policy rollback cannot settle, refund or overwrite ledger');
  assert.deepEqual(await readDurableSpool(spool),sealed,'policy rollback preserves sealed evidence identity and retry state');
  for(const [path,sha] of fileHashes)assert.equal(digest(await readFile(join(spool.directory,path))),sha);
  assert.equal((await pendingDurableSpool(join(local,'spool'))).pending,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_jobs WHERE id=ANY($1::text[]) AND lease_token IS NOT NULL',[ids])).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=ANY($1::text[])',[ids])).rows[0].n,1,'rollback does not resend');
});
