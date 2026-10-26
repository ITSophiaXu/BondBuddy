// Local-only PostgreSQL 16 rehearsal. No production connection, API, worker or provider.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from 'pg';

const directory=dirname(fileURLToPath(import.meta.url)),root=resolve(directory,'../..');
const template=new URL('postgresql://bb_g03_test@127.0.0.1:15526/bb_g03_template_20261026');
const templateName=decodeURIComponent(template.pathname.slice(1));
assert.equal(template.hostname,'127.0.0.1');assert.equal(template.port,'15526');
const clonePrefix=`bb_g03_migration_lock_${process.pid}_`,cloneName=clonePrefix+randomUUID().replaceAll('-','').slice(0,10);
assert.ok(cloneName.startsWith(clonePrefix)&&/^[a-z0-9_]+$/.test(cloneName)&&cloneName!==templateName&&cloneName.length<=63);
const clone=new URL(template);clone.pathname='/'+cloneName;
const maintenanceUrl=new URL(template);maintenanceUrl.pathname='/postgres';
const migrationName='0119_initial_run_execution_identity.sql';
const sql=await readFile(join(root,'db/migrations',migrationName),'utf8');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const lines=[],report={synthetic:true,started:new Date().toISOString(),status:'running',clone:cloneName,
  migration:migrationName,migration_sha256:hash(sql),observations:{},cleanup:{}};
const note=(message,data)=>{const item={at:new Date().toISOString(),message,...(data===undefined?{}:{data})};lines.push(JSON.stringify(item));};
const maintenance=new Client({connectionString:maintenanceUrl.toString(),application_name:'bb-initial-execution-lock-maintenance'});
const writer=new Client({connectionString:clone.toString(),application_name:`bb-119-lock-writer-${process.pid}`});
const migrationApp=`bb-119-lock-migration-${process.pid}`;
const migrator=new Client({connectionString:clone.toString(),application_name:migrationApp});
const observer=new Client({connectionString:clone.toString(),application_name:`bb-119-lock-observer-${process.pid}`});
const connected=new Set();let cloned=false,migrationPid,migrationOutcome,migrationSettled=false,migrationCommitted=false,failure;
try{
  await mkdir(directory,{recursive:true});await maintenance.connect();connected.add(maintenance);
  await maintenance.query(`CREATE DATABASE "${cloneName}" TEMPLATE "${templateName}"`);cloned=true;note('Created isolated clone');
  for(const client of [writer,migrator,observer]){await client.connect();connected.add(client);await client.query("SET statement_timeout='15s'");}
  const schema=(await observer.query('SELECT filename FROM bb_schema_migrations ORDER BY filename DESC LIMIT 1')).rows[0]?.filename;
  assert.equal(schema,'0118_run_supplement_drafts.sql','Run this rehearsal before migrating the local template to 0119');
  assert.equal((await observer.query("SELECT to_regclass('public.bb_run_execution_versions') AS relation")).rows[0].relation,null);
  const writerPid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  migrationPid=(await migrator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const owner=`synthetic-lock-${randomUUID()}`,project=randomUUID(),concurrentRun=randomUUID(),laterRun=randomUUID();
  const firstManifest={synthetic:'input created before migration lock'},firstHash=hash(JSON.stringify(firstManifest));
  const laterManifest={synthetic:'new run after 0119'},laterHash=hash(JSON.stringify(laterManifest));
  await observer.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`lock_${randomUUID().replaceAll('-','').slice(0,20)}`]);
  await observer.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic concurrent migration','update')",[project,owner]);
  const insertInput=(client,revision,inputHash,manifest)=>client.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,$2,$3,1,$4,$5,'[]','[]')`,[project,revision,owner,inputHash,manifest]);
  const insertRun=(client,id,revision,inputHash)=>client.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
    VALUES($1,$2,$3,$4,$5,$6,'update',$7,'queued','queued') RETURNING *`,[id,owner,project,revision,inputHash,randomUUID(),hash(id)]);
  const execution=(client,id)=>client.query('SELECT * FROM bb_run_execution_versions WHERE run_id=$1',[id]);
  const expected=(id,revision,inputHash)=>({owner_user_id:owner,project_id:project,run_id:id,execution_version:1,input_revision:revision,input_hash:inputHash});
  const assertIdentity=(row,id,revision,inputHash)=>{assert.ok(row);for(const [key,value] of Object.entries(expected(id,revision,inputHash)))assert.equal(row[key],value,key);};

  await writer.query('BEGIN');await insertInput(writer,1,firstHash,firstManifest);note('Writer inserted input and holds its transaction open');
  await migrator.query('BEGIN');
  migrationOutcome=migrator.query(sql).then(()=>{migrationSettled=true;return {ok:true};},error=>{migrationSettled=true;return {ok:false,error};});
  let waiting;
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){
    const locks=(await observer.query(`SELECT c.relname,l.mode,l.granted,pg_blocking_pids(l.pid) AS blocking_pids
      FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      WHERE l.pid=$1 AND c.oid IN ('bb_input_revisions'::regclass,'bb_runs'::regclass)
      ORDER BY c.relname,l.mode,l.granted`,[migrationPid])).rows;
    const inputWait=locks.find(lock=>lock.relname==='bb_input_revisions'&&lock.mode==='ShareRowExclusiveLock'&&!lock.granted);
    if(inputWait){waiting={locks,inputWait};break;}
    if(migrationSettled){const outcome=await migrationOutcome;if(!outcome.ok)throw outcome.error;assert.fail('Migration completed before the held input lock was released');}
    await new Promise(done=>setTimeout(done,25));
  }
  assert.ok(waiting,'Migration must be observed waiting for the writer input table lock');
  assert.ok(waiting.inputWait.blocking_pids.includes(writerPid));
  const conflictingModes=['ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock'];
  assert.equal(waiting.locks.some(lock=>lock.relname==='bb_runs'&&lock.granted&&conflictingModes.includes(lock.mode)),false,'Waiting migration must not yet own a run lock that conflicts with INSERT');
  const writerLocks=(await observer.query(`SELECT c.relname,l.mode,l.granted FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
    WHERE l.pid=$1 AND c.oid='bb_input_revisions'::regclass ORDER BY l.mode`,[writerPid])).rows;
  assert.ok(writerLocks.some(lock=>lock.mode==='RowExclusiveLock'&&lock.granted));
  report.observations.waiting={writer_pid:writerPid,migration_pid:migrationPid,...waiting,writerLocks};note('Observed input wait and absence of a conflicting run lock',report.observations.waiting);

  // The migration is still waiting for input; this INSERT must not wait for it.
  const original=(await insertRun(writer,concurrentRun,1,firstHash)).rows[0];
  await writer.query('COMMIT');note('Writer inserted run and committed while migration waited');
  const outcome=await migrationOutcome;if(!outcome.ok)throw outcome.error;
  await migrator.query('INSERT INTO bb_schema_migrations(filename) VALUES($1)',[migrationName]);
  await migrator.query('COMMIT');migrationCommitted=true;
  const backfilled=(await execution(observer,concurrentRun)).rows;assert.equal(backfilled.length,1);assertIdentity(backfilled[0],concurrentRun,1,firstHash);
  assert.equal(backfilled[0].created_at.toISOString(),original.created_at.toISOString());
  assert.deepEqual((await observer.query('SELECT * FROM bb_runs WHERE id=$1',[concurrentRun])).rows[0],original,'Migration must not rewrite the concurrent original run');
  report.observations.concurrent_backfill={original,execution:backfilled[0]};note('Migration backfilled the newly committed run without rewriting it');

  // Prove the AFTER INSERT trigger is in the same transaction as the new run.
  await writer.query('BEGIN');await insertInput(writer,2,laterHash,laterManifest);await insertRun(writer,laterRun,2,laterHash);
  const own=(await execution(writer,laterRun)).rows;assert.equal(own.length,1);assertIdentity(own[0],laterRun,2,laterHash);
  assert.equal((await execution(observer,laterRun)).rowCount,0);
  assert.equal((await observer.query('SELECT 1 FROM bb_runs WHERE id=$1',[laterRun])).rowCount,0);
  await writer.query('ROLLBACK');
  assert.equal((await execution(observer,laterRun)).rowCount,0);
  assert.equal((await observer.query('SELECT 1 FROM bb_input_revisions WHERE project_id=$1 AND revision=2',[project])).rowCount,0);
  note('Uncommitted trigger row is private to its writer and rolls back with run/input');
  await writer.query('BEGIN');await insertInput(writer,2,laterHash,laterManifest);await insertRun(writer,laterRun,2,laterHash);
  const beforeCommit=(await execution(writer,laterRun)).rows[0];assertIdentity(beforeCommit,laterRun,2,laterHash);
  await writer.query('COMMIT');const afterCommit=(await execution(observer,laterRun)).rows[0];assertIdentity(afterCommit,laterRun,2,laterHash);
  assert.deepEqual(afterCommit,beforeCommit);
  report.observations.new_transaction={uncommitted_execution:own[0],rollback_removed_run_and_input:true,committed_execution:afterCommit};
  report.status='passed';note('New-run V1 trigger commits atomically with the original run');
}catch(error){
  failure=error;report.status='failed';report.error={name:error?.name??'Error',code:error?.code??null,message:String(error?.message??error)};note('Rehearsal failed',report.error);
}finally{
  const cleanupErrors=[];
  // Cancel only this exact clone/application/backend if an assertion interrupts DDL.
  if(cloned&&!migrationSettled&&migrationPid&&connected.has(observer)){
    try{await observer.query('SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid=$1 AND datname=$2 AND application_name=$3',[migrationPid,cloneName,migrationApp]);}catch(error){cleanupErrors.push(String(error));}
  }
  if(migrationOutcome)await migrationOutcome;
  for(const client of [writer,migrator,observer])if(connected.has(client)){
    try{await client.query('ROLLBACK');}catch(error){cleanupErrors.push(String(error));}
    try{await client.end();connected.delete(client);}catch(error){cleanupErrors.push(String(error));}
  }
  if(cloned&&connected.has(maintenance)){
    try{
      assert.ok(clone.hostname===template.hostname&&clone.port==='15526'&&cloneName.startsWith(clonePrefix)&&/^[a-z0-9_]+$/.test(cloneName)&&cloneName!==templateName);
      const sessions=(await maintenance.query('SELECT pid,application_name FROM pg_stat_activity WHERE datname=$1',[cloneName])).rows;
      assert.equal(sessions.length,0,'All rehearsal clients must close before dropping their exact clone');
      await maintenance.query(`DROP DATABASE IF EXISTS "${cloneName}"`);
      assert.equal((await maintenance.query('SELECT 1 FROM pg_database WHERE datname=$1',[cloneName])).rowCount,0);
      report.cleanup={dropped:true,remaining_clone_count:0};note('Closed clients and dropped exact rehearsal clone');
    }catch(error){cleanupErrors.push(String(error));}
  }
  if(connected.has(maintenance)){try{await maintenance.end();}catch(error){cleanupErrors.push(String(error));}}
  if(cleanupErrors.length){report.cleanup.errors=cleanupErrors;report.status='failed';failure??=new Error('Rehearsal cleanup failed');note('Cleanup errors',cleanupErrors);}
  report.finished=new Date().toISOString();report.migration_committed=migrationCommitted;
  await writeFile(join(directory,'migration-lock-result.json'),JSON.stringify(report,null,2)+'\n');
  await writeFile(join(directory,'migration-lock.log'),lines.join('\n')+'\n');
}
process.stdout.write(JSON.stringify(report,null,2)+'\n');
if(failure)process.exitCode=1;
