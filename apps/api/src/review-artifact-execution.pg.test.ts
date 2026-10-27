// Synthetic inputs and DOCX bytes; real PostgreSQL origins, registration
// bridges, row locks and terminal delivery. DDL seams roll back in private clones.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {Pool,type PoolClient} from 'pg';
import {digest,uid,type PrivateBlobs} from './data.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';
import {inputManifestHash} from './production-rule-pin.js';
import {checkpointStage,finish,promoteWordArtifact,type Lease} from './queue.js';
import {removeReviewArtifactExecutionScaffold} from './review-artifact-migration-test-fixture.js';
import {assertRunExecution} from './run-execution.js';
import {isolatedTestDatabase} from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'review-artifact-execution');
const migrationConnection=await isolatedTestDatabase(undefined,'review-artifact-execution-migration');
const migration=await readFile(new URL('../../../db/migrations/0129_review_execution_artifacts.sql',import.meta.url),'utf8');
type Db=Pool|PoolClient;
type Kind='report'|'comments'|'revision'|'clean'|'baseline';
type Artifact={artifactId:string;artifactVersion:number};
const rejectedWrite=(error:unknown)=>['23502','23503','23514','P0002','P0003'].includes((error as {code?:string}).code??'');
const canonicalSql=`INSERT INTO bb_review_execution_artifacts(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,kind,artifact_id,artifact_version,filename)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
const legacySql=`INSERT INTO bb_review_artifacts(owner_user_id,project_id,run_id,kind,artifact_id,artifact_version,filename)
  VALUES($1,$2,$3,$4,$5,$6,$7)`;

function memoryBlobs():PrivateBlobs{
  const values=new Map<string,Buffer>();
  return {put:async(key,bytes)=>{values.set(key,Buffer.from(bytes));},
    get:async key=>{const bytes=values.get(key);assert.ok(bytes);return bytes;},
    getIfExists:async key=>values.get(key)??null,
    getIfExistsBounded:async(key,max)=>{const bytes=values.get(key);assert.ok(!bytes||bytes.length<=max);return bytes??null;},
    exists:async key=>values.has(key),delete:async key=>{values.delete(key);}};
}

async function fixture(db:Db,existingOwner?:string){
  const owner=existingOwner??uid(),projectId=uid(),runId=uid(),jobId=uid(),token=uid(),materialId=uid(),uploadId=uid();
  if(!existingOwner)await db.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`ra_${uid().replaceAll('-','').slice(0,20)}`]);
  await db.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic execution Word registrations','review')",[projectId,owner]);
  const sourceHash=digest(`Synthetic review artifact source ${materialId}`),key=`synthetic/review-artifacts/${materialId}`;
  await db.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
    VALUES($1,$2,$3,'synthetic-source.pdf','application/pdf',64,$4,'other',$5,now()+interval '1 day','completed')`,
  [uploadId,owner,projectId,sourceHash,key]);
  await db.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
    VALUES($1,1,$2,$3,$4,'other','synthetic-source.pdf','application/pdf',64,$5,$6,'persisted')`,
  [materialId,owner,projectId,uploadId,sourceHash,key]);
  const pin={material_id:materialId,material_version:1,sha256:sourceHash};
  const input={source_material_ref:pin,material_versions:[pin],requirements:['Synthetic registration identity only'],as_of:null};
  const origin={version:'review-execution-origin-v1',entrypoint:'quick_action',accepted_proposal:null,context_report_ref:null};
  const manifest={draft_revision:1,project_kind:'review',materials:[{...pin,role:'other'}],review:{version:'review_v1',
    operation:'full_review',version_number:1,report_id:uid(),source_report_id:null,source_report_sha256:null,
    finding_ids:[],input,origin,file_delivery:{version:'review-correction-v2',knowledge:[]}}};
  const hash=inputManifestHash(manifest);
  await db.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,1,$2,1,$3,$4,$5,'[]')`,[projectId,owner,hash,manifest,JSON.stringify(manifest.materials)]);
  await db.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1',[projectId]);
  await db.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
    VALUES($1,$2,$3,1,$4,$5,'review',$4,'running','word_delivery')`,[runId,owner,projectId,hash,uid()]);
  await db.query(`INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,snapshot)
    VALUES($1,$2,$3,1,'full_review',$4)`,[runId,owner,projectId,{input,origin,finding_ids:[],input_version:1}]);
  await db.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,lease_token,lease_until,attempts)
    VALUES($1,$2,$3,'review','review','running','word_delivery',$4,now()+interval '10 minutes',1)`,[jobId,owner,runId,token]);
  const lease:Lease={owner,runId,jobId,token,checkpoint:{},attempts:1,executionVersion:1,inputRevision:1,inputHash:hash};
  return {owner,projectId,runId,jobId,hash,manifest,lease};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;

async function word(pool:Pool,f:Fixture,blobs:PrivateBlobs,label:string){
  const result=await promoteWordArtifact(pool,f.lease,makeSyntheticDocxFixture({text:`Synthetic ${label} ${uid()}`}),blobs,'generated_pair_v1');
  assert.equal(result.status,'available');
  if(result.status!=='available')throw Error('Synthetic review Word promotion failed');
  return result;
}
function canonicalValues(f:Fixture,a:Artifact,kind:Kind='report',filename=`合成-${kind}-😀.docx`){
  return [f.owner,f.projectId,f.runId,1,1,f.hash,kind,a.artifactId,a.artifactVersion,filename];
}
async function canonical(db:Db,f:Fixture,a:Artifact,kind:Kind='report',filename?:string){
  await db.query(canonicalSql,canonicalValues(f,a,kind,filename));
}
async function legacy(db:Db,f:Fixture,a:Artifact,kind:Kind='report',filename=`合成-${kind}-😀.docx`){
  await db.query(legacySql,[f.owner,f.projectId,f.runId,kind,a.artifactId,a.artifactVersion,filename]);
}
async function rows(db:Db,f:Fixture){
  return (await db.query('SELECT * FROM bb_review_execution_artifacts WHERE run_id=$1 ORDER BY kind',[f.runId])).rows;
}
async function assertMirror(db:Db,f:Fixture){
  const saved=await rows(db,f);
  assert.ok(saved.length>0);
  for(const row of saved){
    assert.equal(row.execution_version,1);assert.equal(row.input_revision,1);assert.equal(row.input_hash.trim(),f.hash);
    const mirror=(await db.query('SELECT * FROM bb_review_artifacts WHERE run_id=$1 AND kind=$2',[f.runId,row.kind])).rows;
    const {execution_version:executionVersion,input_revision:inputRevision,input_hash:inputHash,...oldColumns}=row;
    assert.deepEqual(mirror,[oldColumns],'all seven legacy fields must mirror exactly');
    assert.equal(executionVersion,1);assert.equal(inputRevision,1);assert.equal(inputHash.trim(),f.hash);
  }
  return saved;
}
async function rolledBack(pool:Pool,work:(db:PoolClient)=>Promise<void>){
  const db=await pool.connect();
  try{await db.query('BEGIN');await work(db);}finally{await db.query('ROLLBACK');db.release();}
}
async function rejectStatement(db:PoolClient,sql:string,values:unknown[]=[],predicate=rejectedWrite){
  await db.query('SAVEPOINT expected_rejection');
  try{await assert.rejects(db.query(sql,values),predicate);}
  finally{await db.query('ROLLBACK TO SAVEPOINT expected_rejection');await db.query('RELEASE SAVEPOINT expected_rejection');}
}
async function pair(pool:Pool,f:Fixture,blobs:PrivateBlobs){
  const report=await word(pool,f,blobs,'report'),revision=await word(pool,f,blobs,'revision'),clean=await word(pool,f,blobs,'clean');
  for(const [kind,a] of [['report',report],['revision',revision],['clean',clean]] as const)await canonical(pool,f,a,kind);
  await checkpointStage(pool,f.lease,'word_delivery_pair',{revision_artifact_id:revision.artifactId,clean_artifact_id:clean.artifactId});
  return {report,revision,clean};
}
const receipts=async(db:Db,f:Fixture)=>(await db.query("SELECT * FROM bb_run_execution_deliveries WHERE run_id=$1 AND delivery_phase='final'",[f.runId])).rows;

test('canonical review artifact registration rejects every wrong execution tuple and a same-owner artifact from another run',
  {skip:!connection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:connection,statement_timeout:10000});t.after(()=>pool.end());
    const f=await fixture(pool),foreign=await fixture(pool,f.owner),blobs=memoryBlobs();
    const a=await word(pool,f,blobs,'owned registration'),other=await word(pool,foreign,blobs,'other run');
    await rolledBack(pool,async db=>{
      const defects:Record<string,[number,string|number]>={owner:[0,uid()],project:[1,foreign.projectId],run:[2,foreign.runId],
        execution:[3,2],revision:[4,2],hash:[5,digest('wrong frozen input')],artifact:[7,other.artifactId],version:[8,2]};
      for(const [name,[index,value]] of Object.entries(defects)){
        const values=canonicalValues(f,a);values[index]=value;
        await rejectStatement(db,canonicalSql,values);assert.deepEqual(await rows(db,f),[],name);
      }
      await rejectStatement(db,legacySql,[f.owner,f.projectId,f.runId,'report',other.artifactId,1,'foreign-run.docx']);
      assert.equal((await db.query('SELECT count(*)::int n FROM bb_review_artifacts WHERE run_id=$1',[f.runId])).rows[0].n,0);
    });
    await canonical(pool,f,a);await assertMirror(pool,f);
    const run=(await pool.query('SELECT * FROM bb_runs WHERE id=$1',[f.runId])).rows[0];
    await assert.rejects(assertRunExecution(pool,run,{executionVersion:2,inputRevision:1,inputHash:f.hash}),{code:'INPUT_REVISION_CONFLICT'});
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_run_execution_versions WHERE run_id=$1',[f.runId])).rows[0].n,1);
  });

test('rolling old and new writers mirror exact rows in both directions and replace only the artifact before final delivery',
  {skip:!connection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:connection,statement_timeout:10000});t.after(()=>pool.end());
    const f=await fixture(pool),blobs=memoryBlobs();
    const first=await word(pool,f,blobs,'old insert'),second=await word(pool,f,blobs,'old update'),third=await word(pool,f,blobs,'canonical update');
    await legacy(pool,f,first);const before=await assertMirror(pool,f);
    await pool.query("UPDATE bb_review_artifacts SET artifact_id=$2,artifact_version=$3 WHERE run_id=$1 AND kind='report'",[f.runId,second.artifactId,second.artifactVersion]);
    assert.equal((await assertMirror(pool,f))[0].artifact_id,second.artifactId);
    await pool.query("UPDATE bb_review_execution_artifacts SET artifact_id=$2,artifact_version=$3 WHERE run_id=$1 AND execution_version=1 AND kind='report'",[f.runId,third.artifactId,third.artifactVersion]);
    const after=await assertMirror(pool,f);assert.equal(after[0].artifact_id,third.artifactId);
    assert.deepEqual({...after[0],artifact_id:first.artifactId,artifact_version:first.artifactVersion},before[0]);
    await canonical(pool,f,first,'comments');await assertMirror(pool,f);
    assert.deepEqual(await receipts(pool,f),[],'registration alone never grants final publication');
    await rolledBack(pool,async db=>{
      for(const table of ['bb_review_artifacts','bb_review_execution_artifacts']){
        for(const [column,value] of [['filename','changed.docx'],['kind','baseline'],['project_id',uid()],['run_id',uid()],['owner_user_id',uid()]])
          await rejectStatement(db,`UPDATE ${table} SET ${column}=$2 WHERE run_id=$1 AND kind='report'`,[f.runId,value]);
        await rejectStatement(db,`DELETE FROM ${table} WHERE run_id=$1 AND kind='report'`,[f.runId]);
      }
      for(const [column,value] of [['execution_version',2],['input_revision',2],['input_hash',digest('changed input')]])
        await rejectStatement(db,`UPDATE bb_review_execution_artifacts SET ${column}=$2 WHERE run_id=$1 AND kind='report'`,[f.runId,value]);
      assert.deepEqual(await rows(db,f),await rows(pool,f));
    });
  });

test('canonical artifact view has no legacy existence dependency and does not fall back to an old registration',
  {skip:!connection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:connection,statement_timeout:10000});t.after(()=>pool.end());
    const f=await fixture(pool),a=await word(pool,f,memoryBlobs(),'canonical-only source');await canonical(pool,f,a);
    const select='SELECT artifact_id,artifact_version,input_hash FROM bb_review_execution_artifact_versions WHERE run_id=$1';
    const expected=[{artifact_id:a.artifactId,artifact_version:1,input_hash:f.hash}];
    assert.deepEqual((await pool.query(select,[f.runId])).rows,expected);
    await rolledBack(pool,async db=>{
      await db.query('ALTER TABLE bb_review_artifacts DISABLE TRIGGER USER');
      await db.query('DELETE FROM bb_review_artifacts WHERE run_id=$1',[f.runId]);
      assert.deepEqual((await db.query(select,[f.runId])).rows,expected);
    });
    await rolledBack(pool,async db=>{
      await db.query('ALTER TABLE bb_review_execution_artifacts DISABLE TRIGGER USER');
      await db.query('DELETE FROM bb_review_execution_artifacts WHERE run_id=$1',[f.runId]);
      assert.equal((await db.query('SELECT 1 FROM bb_review_artifacts WHERE run_id=$1',[f.runId])).rowCount,1);
      assert.deepEqual((await db.query(select,[f.runId])).rows,[]);
    });
    await assertMirror(pool,f);
  });

test('real finish freezes the selected canonical report and pair; exact old/new no-ops replay and every later change is rejected',
  {skip:!connection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:connection,statement_timeout:10000});t.after(()=>pool.end());
    const f=await fixture(pool),blobs=memoryBlobs(),selected=await pair(pool,f,blobs);
    const replacement=await word(pool,f,blobs,'replacement report'),abandoned=await word(pool,f,blobs,'abandoned candidate');
    await pool.query("UPDATE bb_review_execution_artifacts SET artifact_id=$2 WHERE run_id=$1 AND kind='report'",[f.runId,replacement.artifactId]);
    assert.equal((await pool.query('SELECT bb_review_delivery_ready(r) AS ready FROM bb_runs r WHERE id=$1',[f.runId])).rows[0].ready,false,
      'the run has no selected primary yet');
    assert.equal((await finish(pool,f.lease,'succeeded',{artifactId:selected.revision.artifactId,artifactVersion:1,blobs})).state,'succeeded');
    const [receipt]=await receipts(pool,f);assert.ok(receipt);assert.equal(receipt.execution_version,1);assert.equal(receipt.input_hash.trim(),f.hash);
    assert.equal((await pool.query('SELECT bb_review_delivery_ready(r) AS ready FROM bb_runs r WHERE id=$1',[f.runId])).rows[0].ready,true);
    const members=receipt.artifact_manifest as Array<{artifact_id:string;role:string;naming_review_kind:string}>;
    assert.deepEqual(members.map(a=>[a.artifact_id,a.role,a.naming_review_kind]).sort((a,b)=>a[0].localeCompare(b[0])),
      [[replacement.artifactId,'report','report'],[selected.revision.artifactId,'revision','revision'],[selected.clean.artifactId,'clean','clean']].sort((a,b)=>a[0].localeCompare(b[0])));
    for(const artifactId of [selected.report.artifactId,abandoned.artifactId])
      assert.equal((await pool.query('SELECT 1 FROM bb_delivered_artifact_versions WHERE id=$1',[artifactId])).rowCount,0);
    const before=await assertMirror(pool,f);
    for(const table of ['bb_review_artifacts','bb_review_execution_artifacts'])
      await pool.query(`UPDATE ${table} SET artifact_id=artifact_id,artifact_version=artifact_version,filename=filename WHERE run_id=$1`,[f.runId]);
    await pool.query(canonicalSql+` ON CONFLICT(run_id,execution_version,kind) DO UPDATE
      SET artifact_id=EXCLUDED.artifact_id,artifact_version=EXCLUDED.artifact_version,filename=EXCLUDED.filename`,canonicalValues(f,replacement));
    await pool.query(legacySql+` ON CONFLICT(run_id,kind) DO UPDATE
      SET artifact_id=EXCLUDED.artifact_id,artifact_version=EXCLUDED.artifact_version,filename=EXCLUDED.filename`,
    [f.owner,f.projectId,f.runId,'report',replacement.artifactId,replacement.artifactVersion,'合成-report-😀.docx']);
    await rolledBack(pool,async db=>{
      for(const table of ['bb_review_artifacts','bb_review_execution_artifacts']){
        await rejectStatement(db,`UPDATE ${table} SET artifact_id=$2 WHERE run_id=$1 AND kind='report'`,[f.runId,selected.report.artifactId]);
        await rejectStatement(db,`UPDATE ${table} SET filename='different.docx' WHERE run_id=$1 AND kind='report'`,[f.runId]);
        await rejectStatement(db,`DELETE FROM ${table} WHERE run_id=$1 AND kind='report'`,[f.runId]);
      }
      await rejectStatement(db,canonicalSql,canonicalValues(f,abandoned,'comments'));
      await rejectStatement(db,legacySql,[f.owner,f.projectId,f.runId,'comments',abandoned.artifactId,1,'comments.docx']);
    });
    await pool.query('SELECT bb_capture_run_execution_delivery($1,$2)',[f.owner,f.runId]);
    assert.deepEqual(await rows(pool,f),before);assert.deepEqual(await receipts(pool,f),[receipt]);
  });

test('slot replacement and real final capture serialize in both lock orders without freezing stale registry members',
  {skip:!connection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:connection,statement_timeout:10000});t.after(()=>pool.end());
    const f=await fixture(pool),blobs=memoryBlobs(),selected=await pair(pool,f,blobs),replacement=await word(pool,f,blobs,'concurrent report');
    const capture=await pool.connect(),writer=await pool.connect();let finishing:ReturnType<typeof finish>|undefined;
    try{
      await capture.query('BEGIN');await capture.query('SELECT id FROM bb_runs WHERE owner_user_id=$1 AND id=$2 FOR UPDATE',[f.owner,f.runId]);
      await writer.query('BEGIN');
      await rejectStatement(writer,"UPDATE bb_review_execution_artifacts SET artifact_id=$2 WHERE run_id=$1 AND kind='report'",[f.runId,replacement.artifactId],error=>(error as {code?:string}).code==='55P03');
      await writer.query('ROLLBACK');await capture.query('ROLLBACK');
      assert.equal((await rows(pool,f)).find(a=>a.kind==='report')?.artifact_id,selected.report.artifactId);
      await writer.query('BEGIN');
      assert.equal((await writer.query('SHOW transaction_isolation')).rows[0].transaction_isolation,'read committed');
      const writerPid=Number((await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      await writer.query("UPDATE bb_review_artifacts SET artifact_id=$2 WHERE run_id=$1 AND kind='report'",[f.runId,replacement.artifactId]);
      finishing=finish(pool,f.lease,'succeeded',{artifactId:selected.revision.artifactId,artifactVersion:1,blobs});
      let blocked=false;
      for(let attempt=0;attempt<100&&!blocked;attempt++){
        blocked=(await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))) AS waiting`,[writerPid])).rows[0].waiting;
        if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(blocked,true,'real finish must wait for the registration transaction holding the run key-share lock');
      assert.deepEqual(await receipts(pool,f),[]);
      await writer.query('COMMIT');assert.equal((await finishing).state,'succeeded');
      const [receipt]=await receipts(pool,f);
      assert.equal(receipt.artifact_manifest.some((a:{artifact_id:string;role:string})=>a.artifact_id===replacement.artifactId&&a.role==='report'),true);
      assert.equal(receipt.artifact_manifest.some((a:{artifact_id:string})=>a.artifact_id===selected.report.artifactId),false);
      await assert.rejects(pool.query("UPDATE bb_review_execution_artifacts SET artifact_id=$2 WHERE run_id=$1 AND kind='report'",[f.runId,selected.report.artifactId]),rejectedWrite);
    }finally{
      await capture.query('ROLLBACK');await writer.query('ROLLBACK');
      if(finishing)await finishing.catch(()=>{});capture.release();writer.release();
    }
  });

test('readiness and delivery planning fail closed when only the legacy report registration survives canonical damage',
  {skip:!connection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:connection,statement_timeout:10000});t.after(()=>pool.end());
    const f=await fixture(pool),blobs=memoryBlobs(),selected=await pair(pool,f,blobs);
    await finish(pool,f.lease,'succeeded',{artifactId:selected.revision.artifactId,artifactVersion:1,blobs});
    const before=await receipts(pool,f);
    await rolledBack(pool,async db=>{
      await db.query('ALTER TABLE bb_review_execution_artifacts DISABLE TRIGGER USER');
      await db.query("DELETE FROM bb_review_execution_artifacts WHERE run_id=$1 AND kind='report'",[f.runId]);
      assert.equal((await db.query("SELECT 1 FROM bb_review_artifacts WHERE run_id=$1 AND kind='report'",[f.runId])).rowCount,1);
      assert.equal((await db.query("SELECT 1 FROM bb_review_execution_artifact_versions WHERE run_id=$1 AND kind='report'",[f.runId])).rowCount,0);
      assert.equal((await db.query('SELECT bb_review_delivery_ready(r) AS ready FROM bb_runs r WHERE id=$1',[f.runId])).rows[0].ready,false);
      // The builder may reject missing canonical selections, or construct a
      // smaller plan which cannot replay the existing immutable delivery.
      // Neither path may recover the report or naming role from the old row.
      await db.query('SAVEPOINT missing_canonical_plan');
      try{
        const plan=(await db.query("SELECT bb_run_execution_delivery_plan($1,$2,'terminal_transition','final') AS plan",[f.owner,f.runId])).rows[0].plan;
        if(plan)assert.equal(plan.artifact_manifest.some((a:{artifact_id:string;naming_review_kind:string|null})=>
          a.artifact_id===selected.report.artifactId||a.naming_review_kind==='report'),false);
      }catch(error){assert.ok(rejectedWrite(error));await db.query('ROLLBACK TO SAVEPOINT missing_canonical_plan');}
      await db.query('RELEASE SAVEPOINT missing_canonical_plan');
      await rejectStatement(db,'SELECT bb_capture_run_execution_delivery($1,$2)',[f.owner,f.runId]);
      assert.deepEqual(await receipts(db,f),before,'a damaged registry cannot rewrite an earlier delivery');
    });
    await assertMirror(pool,f);assert.deepEqual(await receipts(pool,f),before);
  });

test('0129 fresh replay installs exact six/eight-field foreign keys, a versioned slot key and no invented registration timestamp',
  {skip:!migrationConnection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:migrationConnection,statement_timeout:10000});t.after(()=>pool.end());
    await rolledBack(pool,async db=>{
      await removeReviewArtifactExecutionScaffold(db);await db.query(migration);
      const definitions=(await db.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid='bb_review_execution_artifacts'::regclass`)).rows.map(r=>r.definition as string);
      assert.ok(definitions.includes('PRIMARY KEY (run_id, execution_version, kind)'));
      for(const referenced of ['bb_run_execution_versions','bb_review_execution_snapshots'])
        assert.ok(definitions.some(d=>d.includes('FOREIGN KEY (owner_user_id, project_id, run_id, execution_version, input_revision, input_hash)')&&d.includes(`REFERENCES ${referenced}(owner_user_id, project_id, run_id, execution_version, input_revision, input_hash)`)),referenced);
      assert.ok(definitions.some(d=>d.includes('FOREIGN KEY (owner_user_id, project_id, run_id, execution_version, input_revision, input_hash, artifact_id, artifact_version)')
        &&d.includes('REFERENCES bb_artifact_execution_bindings(owner_user_id, project_id, run_id, execution_version, input_revision, input_hash, artifact_id, artifact_version)')));
      const columns=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='bb_review_execution_artifacts' ORDER BY ordinal_position")).rows.map(r=>r.column_name);
      assert.deepEqual(columns.sort(),['owner_user_id','project_id','run_id','execution_version','input_revision','input_hash','kind','artifact_id','artifact_version','filename'].sort());
      assert.equal((await db.query('SELECT count(*)::int n FROM bb_review_execution_artifacts')).rows[0].n,0);
    });
  });

test('0129 backfills every exact V1 legacy field and supports an old writer followed by a new writer after rollout',
  {skip:!migrationConnection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:migrationConnection,statement_timeout:10000});t.after(()=>pool.end());
    const f=await fixture(pool),blobs=memoryBlobs(),first=await word(pool,f,blobs,'pre-migration'),second=await word(pool,f,blobs,'rolling old writer'),third=await word(pool,f,blobs,'rolling new writer');
    await rolledBack(pool,async db=>{
      await removeReviewArtifactExecutionScaffold(db);await legacy(db,f,first);const old=(await db.query('SELECT * FROM bb_review_artifacts WHERE run_id=$1',[f.runId])).rows;
      await db.query(migration);await assertMirror(db,f);
      assert.deepEqual((await db.query('SELECT * FROM bb_review_artifacts WHERE run_id=$1',[f.runId])).rows,old);
      await db.query("UPDATE bb_review_artifacts SET artifact_id=$2 WHERE run_id=$1 AND kind='report'",[f.runId,second.artifactId]);
      assert.equal((await assertMirror(db,f))[0].artifact_id,second.artifactId);
      await db.query("UPDATE bb_review_execution_artifacts SET artifact_id=$2 WHERE run_id=$1 AND kind='report'",[f.runId,third.artifactId]);
      assert.equal((await assertMirror(db,f))[0].artifact_id,third.artifactId);
      assert.deepEqual(await receipts(db,f),[]);
    });
  });

test('0129 rejects incompatible legacy origins atomically rather than skipping a row or rebinding its artifact',
  {skip:!migrationConnection,timeout:45000},async t=>{
    const pool=new Pool({connectionString:migrationConnection,statement_timeout:10000});t.after(()=>pool.end());
    for(const defect of ['missing-review','missing-binding','wrong-run'] as const){
      const f=await fixture(pool),foreign=await fixture(pool,f.owner),blobs=memoryBlobs();
      const owned=await word(pool,f,blobs,'strict backfill'),other=await word(pool,foreign,blobs,'foreign old registration');
      await rolledBack(pool,async db=>{
        await removeReviewArtifactExecutionScaffold(db);await legacy(db,f,defect==='wrong-run'?other:owned);
        if(defect==='missing-review'){
          await db.query('ALTER TABLE bb_review_execution_snapshots DISABLE TRIGGER USER');
          await db.query('DELETE FROM bb_review_execution_snapshots WHERE run_id=$1',[f.runId]);
          await db.query('ALTER TABLE bb_review_execution_snapshots ENABLE TRIGGER USER');
        }
        if(defect==='missing-binding'){
          await db.query('ALTER TABLE bb_artifact_execution_bindings DISABLE TRIGGER USER');
          await db.query('DELETE FROM bb_artifact_execution_bindings WHERE artifact_id=$1',[owned.artifactId]);
          await db.query('ALTER TABLE bb_artifact_execution_bindings ENABLE TRIGGER USER');
        }
        const old=(await db.query('SELECT * FROM bb_review_artifacts WHERE run_id=$1',[f.runId])).rows;
        await rejectStatement(db,migration);
        assert.equal((await db.query("SELECT to_regclass('bb_review_execution_artifacts') AS relation")).rows[0].relation,null,defect);
        assert.deepEqual((await db.query('SELECT * FROM bb_review_artifacts WHERE run_id=$1',[f.runId])).rows,old,defect);
        assert.equal((await db.query('SELECT run_id FROM bb_artifact_versions WHERE id=$1',[other.artifactId])).rows[0].run_id,foreign.runId);
      });
    }
  });

test('0129 NOWAIT rolls back behind an in-flight legacy registry lock and applies after that writer releases it',
  {skip:!migrationConnection,timeout:30000},async t=>{
    const isolated=await isolatedTestDatabase(undefined,'review-artifact-execution-lock');
    const pool=new Pool({connectionString:isolated,statement_timeout:10000});t.after(()=>pool.end());
    const setup=await pool.connect(),writer=await pool.connect(),migrator=await pool.connect();
    try{
      await setup.query('BEGIN');await removeReviewArtifactExecutionScaffold(setup);await setup.query('COMMIT');
      await writer.query('BEGIN');await writer.query('LOCK TABLE bb_review_artifacts IN ROW EXCLUSIVE MODE');
      await migrator.query('BEGIN');
      await rejectStatement(migrator,migration,[],error=>(error as {code?:string}).code==='55P03');
      assert.equal((await migrator.query("SELECT to_regclass('bb_review_execution_artifacts') AS relation")).rows[0].relation,null);
      assert.equal((await migrator.query("SELECT to_regprocedure('bb_check_review_execution_artifact()') AS fn")).rows[0].fn,null);
      await writer.query('COMMIT');await migrator.query(migration);
      assert.equal((await migrator.query("SELECT to_regclass('bb_review_execution_artifacts') AS relation")).rows[0].relation,'bb_review_execution_artifacts');
      assert.equal((await migrator.query('SELECT count(*)::int n FROM bb_review_execution_artifacts')).rows[0].n,0);
      await migrator.query('COMMIT');
    }finally{
      await Promise.allSettled([setup.query('ROLLBACK'),writer.query('ROLLBACK'),migrator.query('ROLLBACK')]);
      setup.release();writer.release();migrator.release();
    }
  });
