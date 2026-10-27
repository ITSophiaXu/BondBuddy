// Synthetic registrations only. Real PG16 migration, constraints and transactions;
// historical DDL and fixtures remain inside an outer rollback in a private clone.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {Pool,type PoolClient} from 'pg';
import {digest,uid} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {assertRunExecution} from './run-execution.js';
import {isolatedTestDatabase} from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'material-purge-migration');
const migration=await readFile(new URL('../../../db/migrations/0133_material_purge_barrier.sql',import.meta.url),'utf8');
const previousPinMigration=await readFile(new URL('../../../db/migrations/0097_m4_cross_project_material_retention.sql',import.meta.url),'utf8');
const skip=!connection&&'BB_TEST_DATABASE_URL not set; PG16 migration integration not run';
const word='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const scaffoldFunctions=[
  'bb_material_lifecycle_lock_key','bb_material_lifecycle_input_keys','bb_assert_material_lifecycle_available',
  'bb_guard_run_material_lifecycle','bb_guard_execution_material_lifecycle','bb_guard_m4_legacy_material_lifecycle',
  'bb_guard_job_material_lifecycle','bb_guard_material_byte_identity','bb_check_storage_purge_start',
  'bb_reject_storage_purge_start_rewrite',
];
const scaffoldTriggers=[
  'bb_material_lifecycle_run_guard','bb_material_lifecycle_execution_guard','bb_material_lifecycle_m4_snapshot_guard',
  'bb_material_lifecycle_m4_legacy_guard','bb_material_lifecycle_job_guard','bb_material_byte_identity_guard',
  'bb_storage_purge_start_exact','bb_storage_purge_start_immutable',
];
const rejected=(error:unknown)=>(error as {code?:string}).code==='23514';
const barrierRejected=(error:unknown)=>rejected(error)&&(error as {constraint?:string}).constraint==='bb_material_purge_barrier';

async function removeScaffold(db:PoolClient){
  await db.query(`DROP TABLE IF EXISTS bb_storage_purge_starts CASCADE;
    DROP FUNCTION IF EXISTS bb_guard_run_material_lifecycle(),bb_guard_execution_material_lifecycle(),
      bb_guard_m4_legacy_material_lifecycle(),bb_guard_job_material_lifecycle(),bb_guard_material_byte_identity(),
      bb_check_storage_purge_start(),bb_reject_storage_purge_start_rewrite() CASCADE;
    DROP FUNCTION IF EXISTS bb_assert_material_lifecycle_available(text,text,integer) CASCADE;
    DROP FUNCTION IF EXISTS bb_material_lifecycle_input_keys(text,text,integer) CASCADE;
    DROP FUNCTION IF EXISTS bb_material_lifecycle_lock_key(text,text,text,integer) CASCADE;`);
  await db.query(previousPinMigration);
}

async function inHistoricalTransaction(work:(db:PoolClient)=>Promise<void>){
  const pool=new Pool({connectionString:connection,max:1}),db=await pool.connect();
  try{
    await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const version=Number((await db.query("SELECT current_setting('server_version_num') AS n")).rows[0].n);
    assert(version>=160000&&version<170000,'requires real PostgreSQL 16');
    await removeScaffold(db);
    await work(db);
  }finally{await db.query('ROLLBACK');db.release();await pool.end();}
}

async function rejectStatement(db:PoolClient,sql:string,values:unknown[]=[],predicate=rejected){
  await db.query('SAVEPOINT expected_rejection');
  try{await assert.rejects(db.query(sql,values),predicate);}
  finally{await db.query('ROLLBACK TO SAVEPOINT expected_rejection');await db.query('RELEASE SAVEPOINT expected_rejection');}
}

async function owner(db:PoolClient){
  const id=uid();
  await db.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[id,`mpm_${uid().replaceAll('-','').slice(0,20)}`]);
  return id;
}
async function project(db:PoolClient,user:string){
  const id=uid();
  await db.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic material purge migration','update')",[id,user]);
  return id;
}
async function material(db:PoolClient,user:string,projectId:string,options:{id?:string;version?:number}={}){
  const id=options.id??uid(),version=options.version??1,uploadId=uid();
  const sha256=digest(`synthetic migration material ${id}/${version}`),key=`users/${user}/projects/${projectId}/uploads/${uploadId}/synthetic.docx`;
  await db.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
    VALUES($1,$2,$3,'synthetic.docx',$4,64,$5,'other',$6,now()+interval '1 day','completed')`,[uploadId,user,projectId,word,sha256,key]);
  await db.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
    VALUES($1,$2,$3,$4,$5,'other','synthetic.docx',$6,64,$7,$8,'persisted')`,[id,version,user,projectId,uploadId,word,sha256,key]);
  return {owner:user,projectId,id,version,uploadId,key,sha256,pin:{material_id:id,material_version:version,sha256}};
}
type Material=Awaited<ReturnType<typeof material>>;
async function deletedMaterial(db:PoolClient,user:string,projectId:string){
  const m=await material(db,user,projectId);
  await db.query("UPDATE bb_material_versions SET deleted_at='2026-01-01T00:00:00.123456Z' WHERE id=$1 AND version=$2",[m.id,m.version]);
  const tombstone=(await db.query('SELECT id FROM bb_storage_tombstones WHERE object_key=$1',[m.key])).rows[0].id as string;
  await db.query("UPDATE bb_storage_tombstones SET eligible_at='2026-01-31T00:00:00.123456Z' WHERE id=$1",[tombstone]);
  return {...m,tombstone};
}
async function claim(db:PoolClient,id:string){
  await db.query(`UPDATE bb_storage_tombstones SET state='claimed',attempts=attempts+1,claim_token=$2,
    lease_until=clock_timestamp()+interval '1 hour',retry_after=NULL,last_error_code=NULL WHERE id=$1`,[id,uid()]);
}
async function retry(db:PoolClient,id:string){
  await db.query(`UPDATE bb_storage_tombstones SET state='pending',claim_token=NULL,lease_until=NULL,
    retry_after='2026-02-01T00:00:00.654321Z',last_error_code='blob_delete_failed' WHERE id=$1`,[id]);
}
async function input(db:PoolClient,user:string,projectId:string,manifest:unknown,pins:unknown[],revision=1){
  const hash=inputManifestHash(manifest);
  await db.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,$2,$3,1,$4,$5,$6,'[]')`,[projectId,revision,user,hash,manifest,JSON.stringify(pins)]);
  return {owner:user,projectId,revision,hash};
}
type Input=Awaited<ReturnType<typeof input>>;
const runSql=`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage,created_at)
  VALUES($1,$2,$3,$4,$5,$1,$6,$5,$7,'synthetic_migration','2026-10-20T01:02:03.123456Z')`;
function runValues(i:Input,id:string,task='update',state='paused'){return [id,i.owner,i.projectId,i.revision,i.hash,task,state];}
async function run(db:PoolClient,i:Input,task='update',state='paused'){
  const id=uid();await db.query(runSql,runValues(i,id,task,state));return id;
}
async function pinned(db:PoolClient,m:Material,user=m.owner,projectId=m.projectId,version=m.version){
  return (await db.query('SELECT bb_material_bytes_pinned($1,$2,$3,$4) AS pinned',[user,projectId,m.id,version])).rows[0].pinned as boolean;
}
async function sourceMetadata(db:PoolClient,user:string){
  return (await db.query(`SELECT 'material' AS kind,id||':'||version AS id,to_jsonb(m) AS data FROM bb_material_versions m WHERE owner_user_id=$1
    UNION ALL SELECT 'tombstone',id,to_jsonb(t) FROM bb_storage_tombstones t WHERE owner_user_id=$1 ORDER BY kind,id`,[user])).rows;
}
async function executionMetadata(db:PoolClient,user:string){
  return (await db.query(`SELECT 'execution' AS kind,run_id,to_jsonb(e) AS data FROM bb_run_execution_versions e WHERE owner_user_id=$1
    UNION ALL SELECT 'head',run_id,to_jsonb(h) FROM bb_run_execution_heads h WHERE owner_user_id=$1 ORDER BY kind,run_id`,[user])).rows;
}
async function executionPolicy(db:PoolClient){
  return (await db.query(`SELECT conrelid::regclass::text AS relation,conname,pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid IN ('bb_run_execution_versions'::regclass,'bb_run_execution_heads'::regclass)
    ORDER BY relation,conname`)).rows;
}

test('0133 refuses an old claimed tombstone atomically before installing any barrier table or guard',
  {skip,timeout:60000},async()=>inHistoricalTransaction(async db=>{
    const user=await owner(db),projectId=await project(db,user),m=await deletedMaterial(db,user,projectId);
    await claim(db,m.tombstone);
    const before=await sourceMetadata(db,user);
    const oldPin=(await db.query("SELECT pg_get_functiondef('bb_material_bytes_pinned(text,text,text,integer)'::regprocedure) AS definition")).rows[0].definition;
    await db.query('SET CONSTRAINTS ALL IMMEDIATE');
    await rejectStatement(db,migration,[],error=>(error as {code?:string}).code==='55000');
    assert.equal((await db.query("SELECT to_regclass('bb_storage_purge_starts') AS name")).rows[0].name,null);
    assert.deepEqual((await db.query("SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[])",[scaffoldFunctions])).rows,[]);
    assert.deepEqual((await db.query('SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname=ANY($1::text[])',[scaffoldTriggers])).rows,[]);
    assert.equal((await db.query("SELECT pg_get_functiondef('bb_material_bytes_pinned(text,text,text,integer)'::regprocedure) AS definition")).rows[0].definition,oldPin);
    assert.deepEqual(await sourceMetadata(db,user),before,'failed installation preserves claim, original identity and retention window');
  }));

test('0133 backfills only attempted material tombstones without rewriting metadata and makes uncertainty append-only',
  {skip,timeout:60000},async()=>inHistoricalTransaction(async db=>{
    const user=await owner(db),projectId=await project(db,user);
    const attempted=await deletedMaterial(db,user,projectId),purged=await deletedMaterial(db,user,projectId),fresh=await deletedMaterial(db,user,projectId);
    for(let n=0;n<2;n++){await claim(db,attempted.tombstone);await retry(db,attempted.tombstone);}
    await claim(db,purged.tombstone);
    await db.query("UPDATE bb_storage_tombstones SET state='purged',claim_token=NULL,lease_until=NULL,purged_at=clock_timestamp() WHERE id=$1",[purged.tombstone]);
    // Orphan upload attempts never acquire a material execution pin.
    const orphanUpload=uid(),orphanId=uid(),orphanKey=`users/${user}/projects/${projectId}/uploads/${orphanUpload}/orphan.docx`,orphanHash=digest('synthetic orphan');
    await db.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'orphan.docx',$4,64,$5,'other',$6,now()-interval '1 day','deleting')`,[orphanUpload,user,projectId,word,orphanHash,orphanKey]);
    await db.query(`INSERT INTO bb_storage_tombstones(id,owner_user_id,project_id,object_kind,upload_id,object_key,sha256,eligible_at)
      VALUES($1,$2,$3,'orphan_upload',$4,$5,$6,'2026-01-31T00:00:00.123456Z')`,[orphanId,user,projectId,orphanUpload,orphanKey,orphanHash]);
    await claim(db,orphanId);await retry(db,orphanId);
    const before=await sourceMetadata(db,user);
    await db.query('SET CONSTRAINTS ALL IMMEDIATE');
    await db.query(migration);
    assert.deepEqual(await sourceMetadata(db,user),before,'migration preserves every original byte identity, hash, state, retry and retention timestamp');
    const starts=(await db.query(`SELECT s.tombstone_id,s.claim_token,s.claim_attempt,s.origin,isfinite(s.created_at) AS finite
      FROM bb_storage_purge_starts s JOIN bb_storage_tombstones t ON t.id=s.tombstone_id
      WHERE t.owner_user_id=$1 ORDER BY s.tombstone_id`,[user])).rows;
    assert.deepEqual(starts,[
      {tombstone_id:attempted.tombstone,claim_token:null,claim_attempt:2,origin:'legacy_attempt',finite:true},
      {tombstone_id:purged.tombstone,claim_token:null,claim_attempt:1,origin:'legacy_attempt',finite:true},
    ].sort((a,b)=>a.tombstone_id.localeCompare(b.tombstone_id)));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM bb_storage_purge_starts WHERE tombstone_id=ANY($1::text[])',[[fresh.tombstone,orphanId]])).rows[0].n,0);
    await rejectStatement(db,'UPDATE bb_storage_purge_starts SET claim_attempt=claim_attempt+1 WHERE tombstone_id=$1',[attempted.tombstone]);
    await rejectStatement(db,'DELETE FROM bb_storage_purge_starts WHERE tombstone_id=$1',[purged.tombstone]);
    await rejectStatement(db,`INSERT INTO bb_storage_purge_starts(tombstone_id,claim_token,claim_attempt,origin,created_at)
      VALUES($1,NULL,1,'legacy_attempt',clock_timestamp())`,[fresh.tombstone]);
    for(const m of [attempted,purged]){
      const local=await input(db,user,projectId,{materials:[m.pin]},[m.pin],m===attempted?1:2);
      const id=uid();await rejectStatement(db,runSql,runValues(local,id),barrierRejected);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM bb_runs WHERE id=$1',[id])).rows[0].n,0);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM bb_run_execution_heads WHERE run_id=$1',[id])).rows[0].n,0);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM bb_run_execution_versions WHERE run_id=$1',[id])).rows[0].n,0);
    }
    const pendingInput=await input(db,user,projectId,{materials:[fresh.pin]},[fresh.pin],3);
    await run(db,pendingInput);
    assert.equal(await pinned(db,fresh),true,'unattempted pending bytes can still obtain the existing local pin');
  }));

async function m4Run(db:PoolClient,user:string,m:Material,kind:'document'|'qa',pin=m.pin){
  const projectId=await project(db,user),topic=uid(),scoped={...pin,source_project_id:m.projectId};
  await db.query(`INSERT INTO bb_m4_topics(id,owner_user_id,project_id,source_project_id,name,creation_request_id,request_hash)
    VALUES($1,$2,$3,$4,'Synthetic migration M4',$5,$6)`,[topic,user,projectId,m.projectId,uid(),digest(uid())]);
  const manifest=kind==='document'
    ?{version:'m4-document-input-v1',kind,topic_id:topic,billing_task:'synthetic-document',input:{document_type:'underwriter',materials:[scoped],fields:{},requirements:[]}}
    :{version:'m4-qa-input-v1',kind,topic_id:topic,billing_task:'synthetic-qa',content:'Synthetic migration question',context:{},context_snapshot:{},materials:[scoped]};
  const i=await input(db,user,projectId,manifest,[scoped]),task=kind==='document'?'generation':'qa',id=await run(db,i,task);
  await db.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage)
    VALUES($1,$2,$3,$4,$5,'paused','synthetic_migration')`,[uid(),user,id,task,kind==='document'?'m4_document_v1':'m4_qa_v1']);
  await db.query('INSERT INTO bb_m4_executions(run_id,owner_user_id,topic_id,manifest,input_hash) VALUES($1,$2,$3,$4,$5)',[id,user,topic,manifest,i.hash]);
  return {...i,id,topic};
}

test('0133 preserves local and exact cross-project M4 byte pins, original V1 executions and frozen active heads',
  {skip,timeout:60000},async()=>inHistoricalTransaction(async db=>{
    const user=await owner(db),foreignOwner=await owner(db),projectId=await project(db,user);
    const local=await material(db,user,projectId),newer=await material(db,user,projectId,{id:local.id,version:2});
    const i=await input(db,user,projectId,{materials:[local.pin]},[local.pin]),id=await run(db,i);
    await input(db,user,projectId,{materials:[newer.pin]},[newer.pin],2);
    await db.query('UPDATE bb_projects SET latest_input_revision=2 WHERE id=$1',[projectId]);
    const documentMaterial=await material(db,user,await project(db,user)),qaMaterial=await material(db,user,await project(db,user));
    const wrongHashMaterial=await material(db,user,await project(db,user));
    const document=await m4Run(db,user,documentMaterial,'document'),qa=await m4Run(db,user,qaMaterial,'qa');
    await m4Run(db,user,wrongHashMaterial,'document',{...wrongHashMaterial.pin,sha256:digest('different synthetic bytes')});
    const observations=async()=>({local:await pinned(db,local),newer:await pinned(db,newer),document:await pinned(db,documentMaterial),
      qa:await pinned(db,qaMaterial),wrongHash:await pinned(db,wrongHashMaterial),foreignOwner:await pinned(db,documentMaterial,foreignOwner),
      wrongProject:await pinned(db,documentMaterial,user,document.projectId),wrongVersion:await pinned(db,documentMaterial,user,documentMaterial.projectId,2)});
    const before=await observations(),metadata=await executionMetadata(db,user),policy=await executionPolicy(db),materials=await sourceMetadata(db,user);
    assert.deepEqual(before,{local:true,newer:false,document:true,qa:true,wrongHash:false,foreignOwner:false,wrongProject:false,wrongVersion:false});
    await db.query('SET CONSTRAINTS ALL IMMEDIATE');await db.query(migration);
    assert.deepEqual(await observations(),before,'existing ordinary and exact M4 reference semantics survive replay');
    assert.deepEqual(await executionMetadata(db,user),metadata,'migration never adopts inputs or changes historical active heads');
    assert.deepEqual(await executionPolicy(db),policy,'V1-only constraints and exact execution/head FKs are unchanged');
    assert.deepEqual(await sourceMetadata(db,user),materials);
    for(const runId of [id,document.id,qa.id]){
      const row=(await db.query('SELECT * FROM bb_runs WHERE id=$1',[runId])).rows[0];
      assert.deepEqual(await assertRunExecution(db,row),{executionVersion:1,inputRevision:1,inputHash:row.input_hash.trim()});
    }
    await rejectStatement(db,`INSERT INTO bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,created_at)
      SELECT owner_user_id,project_id,run_id,2,input_revision,input_hash,created_at FROM bb_run_execution_versions WHERE run_id=$1`,[id]);
    await rejectStatement(db,'UPDATE bb_run_execution_versions SET input_revision=2 WHERE run_id=$1',[id]);
    await rejectStatement(db,'UPDATE bb_run_execution_heads SET input_hash=$2 WHERE run_id=$1',[id,digest('changed synthetic head')]);
    await db.query("UPDATE bb_jobs SET state='cancelled' WHERE run_id=ANY($1::text[])",[[document.id,qa.id]]);
    await db.query("UPDATE bb_runs SET state='cancelled' WHERE id=ANY($1::text[])",[[id,document.id,qa.id]]);
    assert.equal(await pinned(db,local),false);assert.equal(await pinned(db,documentMaterial),false);assert.equal(await pinned(db,qaMaterial),false);
  }));
