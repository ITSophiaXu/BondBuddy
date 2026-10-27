// Synthetic review bodies; real PostgreSQL source identities and immutable
// registries. No Word delivery, model call, customer material or billing.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {Pool,type PoolClient} from 'pg';
import {isReviewReport,type ReviewEvidenceRef,type ReviewReport} from '@bondbuddy/contracts';
import {digest,Problem,uid} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {assertRunExecution} from './run-execution.js';
import {readReviewExecutionReport} from './review-report-execution.js';
import {isolatedTestDatabase} from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'review-report-execution');
const migrationConnection=await isolatedTestDatabase(undefined,'review-report-execution-migration');
const migration=await readFile(new URL('../../../db/migrations/0128_review_execution_reports.sql',import.meta.url),'utf8');
const missing=(error:unknown)=>error instanceof Problem&&error.status===404;
const unavailable=(error:unknown)=>error instanceof Problem&&error.status===503&&error.code==='DATA_UNAVAILABLE';
const conflict=(error:unknown)=>error instanceof Problem&&error.status===409&&error.code==='INPUT_REVISION_CONFLICT';

async function fixture(connectionString=connection){
  const pool=new Pool({connectionString,statement_timeout:10000});
  const owner=uid(),projectId=uid(),runId=uid(),reportId=uid(),materialId=uid(),uploadId=uid();
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`report_${uid().replaceAll('-','').slice(0,20)}`]);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic execution report','review')",[projectId,owner]);
  const bytes=Buffer.from('Synthetic report source'),sourceHash=digest(bytes);
  await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
    VALUES($1,$2,$3,'synthetic-report.pdf','application/pdf',$4,$5,'other',$6,now()+interval '1 hour','completed')`,
  [uploadId,owner,projectId,bytes.length,sourceHash,`users/${owner}/uploads/${uploadId}`]);
  await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
    VALUES($1,1,$2,$3,$4,'other','synthetic-report.pdf','application/pdf',$5,$6,$7,'persisted')`,
  [materialId,owner,projectId,uploadId,bytes.length,sourceHash,`users/${owner}/projects/${projectId}/materials/${materialId}`]);
  const pin={material_id:materialId,material_version:1,sha256:sourceHash};
  const input={source_material_ref:pin,material_versions:[pin],requirements:['Synthetic frozen report source'],as_of:null};
  const origin={version:'review-execution-origin-v1',entrypoint:'quick_action',accepted_proposal:null,context_report_ref:null};
  const manifest={draft_revision:1,project_kind:'review',materials:[{...pin,role:'other'}],review:{version:'review_v1',
    operation:'full_review',version_number:1,report_id:reportId,source_report_id:null,source_report_sha256:null,finding_ids:[],input,origin}};
  const hash=inputManifestHash(manifest);
  await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,1,$2,1,$3,$4,$5,'[]')`,[projectId,owner,hash,manifest,JSON.stringify(manifest.materials)]);
  await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1',[projectId]);
  await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
    VALUES($1,$2,$3,1,$4,$5,'review',$4,'running','word_delivery')`,[runId,owner,projectId,hash,uid()]);
  await pool.query(`INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,snapshot)
    VALUES($1,$2,$3,1,'full_review',$4)`,[runId,owner,projectId,{input,origin,finding_ids:[],input_version:1}]);
  const ref:ReviewEvidenceRef={material_id:materialId,material_version:1,material_sha256:sourceHash,
    parse_snapshot_id:'synthetic-parse',parse_response_sha256:digest('synthetic parse'),record_id:'synthetic-record',
    record_sha256:digest('synthetic record'),locator_type:'pdf_bbox',
    locator:{page:1,bbox:[0.125,10,1e-7,1e21],'中文定位':'Synthetic numeric locator'},
    quote:'Synthetic evidence only',extraction_method:'native_text',uncertainty:[]};
  const report:ReviewReport={report_id:reportId,project_id:projectId,run_id:runId,input_revision:1,version:1,
    source_material:pin,scope:{mode:'full_review',finding_ids:[]},findings:[{finding_id:'synthetic-finding',report_id:reportId,
      dimension:'financial',conclusion:'manual',severity:'P3',title:'Synthetic finding',description:'Synthetic reader fixture',
      target_refs:[ref],evidence_refs:[ref],limitations:['Synthetic data only'],
      repairability:{can_revise:false,reason:'No professional conclusion',allowed_record_ids:[]},
      origin_report_id:reportId,check_status:'rechecked'}],coverage:[],limitations:['Synthetic report identity only'],created_at:new Date().toISOString()};
  assert.ok(isReviewReport(report));
  const legacy=async()=>pool.query(`INSERT INTO bb_review_reports(id,owner_user_id,project_id,run_id,version,content_sha256,report)
    VALUES($1,$2,$3,$4,1,$5,$6)`,[reportId,owner,projectId,runId,inputManifestHash(report),report]);
  const canonical=async()=>pool.query(`INSERT INTO bb_review_execution_reports(id,owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,version,content_sha256,report)
    VALUES($1,$2,$3,$4,1,1,$5,1,$6,$7)`,[reportId,owner,projectId,runId,hash,inputManifestHash(report),report]);
  const read=(db:Pool|PoolClient=pool)=>readReviewExecutionReport(db,owner,projectId,reportId);
  return {pool,owner,projectId,runId,reportId,hash,manifest,report,legacy,canonical,read};
}

type Fixture=Awaited<ReturnType<typeof fixture>>;
async function rolledBack(f:Fixture,work:(client:PoolClient)=>Promise<void>){
  const client=await f.pool.connect();
  try{await client.query('BEGIN');await work(client);}finally{await client.query('ROLLBACK');client.release();}
}

test('old-writer bridge preserves exact V1 report bytes and an explicit report remains readable before Word final delivery',
  {skip:!connection,timeout:30000},async t=>{
    const f=await fixture();t.after(()=>f.pool.end());await f.legacy();
    const saved=await f.read();
    assert.equal(saved.id,f.reportId);assert.equal(saved.owner_user_id,f.owner);assert.equal(saved.project_id,f.projectId);
    assert.equal(saved.run_id,f.runId);assert.equal(saved.execution_version,1);assert.equal(saved.input_revision,1);
    assert.equal(saved.input_hash.trim(),f.hash);assert.equal(saved.version,1);
    assert.equal(saved.content_sha256.trim(),inputManifestHash(f.report));assert.deepEqual(saved.report,f.report);
    const mirror=(await f.pool.query(`SELECT c.id=l.id AND c.owner_user_id=l.owner_user_id AND c.project_id=l.project_id
      AND c.run_id=l.run_id AND c.version=l.version AND c.content_sha256=l.content_sha256
      AND c.report=l.report AND c.created_at=l.created_at AS exact
      FROM bb_review_execution_reports c JOIN bb_review_reports l ON l.id=c.id WHERE c.id=$1`,[f.reportId])).rows;
    assert.deepEqual(mirror,[{exact:true}]);
    assert.equal((await f.pool.query('SELECT 1 FROM bb_run_execution_deliveries WHERE run_id=$1',[f.runId])).rowCount,0);
    await f.pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[f.runId]);
    assert.deepEqual(await f.read(),saved,'a failed Word attempt does not revoke an explicitly selected persisted report');
  });

test('canonical report reads work without a legacy mirror and never fall back when canonical storage is absent',
  {skip:!connection,timeout:30000},async t=>{
    const f=await fixture();t.after(()=>f.pool.end());await f.canonical();
    assert.equal((await f.pool.query('SELECT 1 FROM bb_review_reports WHERE id=$1',[f.reportId])).rowCount,0);
    assert.deepEqual((await f.read()).report,f.report,'the canonical registry has no legacy existence dependency');
    // Recreate an old V1 mirror, then remove only canonical storage inside a
    // rolled-back corruption seam. A reader must not silently use the mirror.
    await f.pool.query(`INSERT INTO bb_review_reports(id,owner_user_id,project_id,run_id,version,content_sha256,report,created_at)
      SELECT id,owner_user_id,project_id,run_id,version,content_sha256,report,created_at
      FROM bb_review_execution_reports WHERE id=$1`,[f.reportId]);
    await rolledBack(f,async client=>{
      await client.query('ALTER TABLE bb_review_execution_reports DISABLE TRIGGER USER');
      await client.query('DELETE FROM bb_review_execution_reports WHERE id=$1',[f.reportId]);
      assert.equal((await client.query('SELECT 1 FROM bb_review_reports WHERE id=$1',[f.reportId])).rowCount,1);
      await assert.rejects(f.read(client),missing);
    });
    assert.deepEqual((await f.read()).report,f.report);
  });

test('report IDs remain owner/project scoped and do not select another source edition',
  {skip:!connection,timeout:30000},async t=>{
    const f=await fixture();t.after(()=>f.pool.end());await f.legacy();
    for(const args of [[uid(),f.projectId,f.reportId],[f.owner,uid(),f.reportId],[f.owner,f.projectId,uid()]] as const)
      await assert.rejects(readReviewExecutionReport(f.pool,...args),missing);
    const sibling=await fixture();t.after(()=>sibling.pool.end());await sibling.legacy();
    await assert.rejects(readReviewExecutionReport(f.pool,f.owner,f.projectId,sibling.reportId),missing);
    assert.deepEqual((await f.read()).report,f.report);
  });

test('report source identity comes from its persisted tuple despite newer input or a damaged current run projection',
  {skip:!connection,timeout:30000},async t=>{
    const f=await fixture();t.after(()=>f.pool.end());await f.legacy();const original=await f.read();
    const manifest=structuredClone(f.manifest);manifest.review.report_id=uid();manifest.review.input.requirements=['Later synthetic task'];
    const hash=inputManifestHash(manifest);
    await f.pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,2,$2,1,$3,$4,$5,'[]')`,[f.projectId,f.owner,hash,manifest,JSON.stringify(manifest.materials)]);
    await f.pool.query('UPDATE bb_projects SET latest_input_revision=2 WHERE id=$1',[f.projectId]);
    await assert.rejects(f.pool.query('UPDATE bb_runs SET input_revision=2,input_hash=$2 WHERE id=$1',[f.runId,hash]),{code:'23514'},
      'the existing run-origin gate still forbids adopting new input');
    await rolledBack(f,async client=>{
      await client.query('ALTER TABLE bb_runs DISABLE TRIGGER USER');
      await client.query('UPDATE bb_runs SET input_revision=2,input_hash=$2 WHERE id=$1',[f.runId,hash]);
      assert.deepEqual(await f.read(client),original,'a source report is not rebound to the run current-input projection');
    });
    assert.deepEqual(await f.read(),original);
    const run=(await f.pool.query('SELECT * FROM bb_runs WHERE id=$1',[f.runId])).rows[0];
    await assert.rejects(assertRunExecution(f.pool,run,{executionVersion:2,inputRevision:1,inputHash:f.hash}),conflict);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_run_execution_versions WHERE run_id=$1',[f.runId])).rows[0].n,1,
      'historical reads do not open the V2 execution gate');
  });

test('valid hashes cannot disguise a report body with the wrong source, identity, business version or scope',
  {skip:!connection,timeout:30000},async t=>{
    const f=await fixture();t.after(()=>f.pool.end());await f.legacy();
    const defects=['body','hash','id','project','run','revision','version','source','scope','findings'] as const;
    for(const defect of defects)await rolledBack(f,async client=>{
      const report=structuredClone(f.report);
      if(defect==='body')(report.findings[0] as unknown as {severity:string}).severity='Synthetic invalid severity';
      if(defect==='id'){
        report.report_id=uid();
        for(const finding of report.findings){finding.report_id=report.report_id;finding.origin_report_id=report.report_id;}
      }
      if(defect==='project')report.project_id=uid();
      if(defect==='run')report.run_id=uid();
      if(defect==='revision')report.input_revision=2;
      if(defect==='version')report.version=2;
      if(defect==='source')report.source_material={...report.source_material,sha256:digest('another synthetic source')};
      if(defect==='scope')report.scope.mode='differential_review';
      if(defect==='findings')report.scope.finding_ids=['unselected-synthetic-finding'];
      if(defect!=='body')assert.ok(isReviewReport(report),`${defect} uses a schema-valid body`);
      await client.query('ALTER TABLE bb_review_execution_reports DISABLE TRIGGER USER');
      await client.query('UPDATE bb_review_execution_reports SET report=$2,content_sha256=$3 WHERE id=$1',
        [f.reportId,report,defect==='hash'?digest('incorrect synthetic body hash'):inputManifestHash(report)]);
      await assert.rejects(f.read(client),unavailable,defect);
    });
    assert.deepEqual((await f.read()).report,f.report,'each damaged body was rolled back');
  });

test('the persisted tuple must resolve an immutable origin and cannot be replaced with the run projection',
  {skip:!connection,timeout:30000},async t=>{
    const f=await fixture();t.after(()=>f.pool.end());await f.legacy();
    for(const defect of ['hash','revision','execution'] as const)await rolledBack(f,async client=>{
      // Deliberately bypass only storage guards in a disposable transaction to
      // model damaged persisted origins, never a supported successor writer.
      await client.query('ALTER TABLE bb_review_execution_reports DISABLE TRIGGER ALL');
      const column={hash:'input_hash',revision:'input_revision',execution:'execution_version'}[defect];
      await client.query(`UPDATE bb_review_execution_reports SET ${column}=$2 WHERE id=$1`,
        [f.reportId,defect==='hash'?digest('missing frozen input'):2]);
      await assert.rejects(f.read(client),error=>missing(error)||unavailable(error),defect);
    });
    assert.deepEqual((await f.read()).report,f.report);
  });

test('matching corruption of a report source and its business snapshot still fails against the original frozen input manifest',
  {skip:!connection,timeout:30000},async t=>{
    const f=await fixture();t.after(()=>f.pool.end());await f.legacy();
    await rolledBack(f,async client=>{
      const report=structuredClone(f.report),snapshot=(await client.query('SELECT snapshot FROM bb_review_execution_snapshots WHERE run_id=$1',[f.runId])).rows[0].snapshot;
      const alteredPin={...report.source_material,sha256:digest('jointly corrupted synthetic source')};
      report.source_material=alteredPin;snapshot.input.source_material_ref=alteredPin;snapshot.input.material_versions=[alteredPin];
      assert.ok(isReviewReport(report));
      await client.query('ALTER TABLE bb_review_execution_snapshots DISABLE TRIGGER USER');
      await client.query('UPDATE bb_review_execution_snapshots SET snapshot=$2 WHERE run_id=$1',[f.runId,snapshot]);
      await client.query('ALTER TABLE bb_review_execution_reports DISABLE TRIGGER USER');
      await client.query('UPDATE bb_review_execution_reports SET report=$2,content_sha256=$3 WHERE id=$1',[f.reportId,report,inputManifestHash(report)]);
      const frozen=(await client.query('SELECT manifest,input_hash FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=1',[f.owner,f.projectId])).rows[0];
      assert.deepEqual(frozen.manifest,f.manifest);assert.equal(inputManifestHash(frozen.manifest),f.hash);
      assert.equal(frozen.input_hash.trim(),f.hash);
      await assert.rejects(f.read(client),unavailable,'body hash and snapshot agreement cannot replace the original input manifest');
    });
    assert.deepEqual((await f.read()).report,f.report);
  });

test('a differential report follow-up must retain the exact source-report digest frozen in its execution input',
  {skip:!connection,timeout:30000},async t=>{
    const f=await fixture();t.after(()=>f.pool.end());await f.legacy();
    await rolledBack(f,async client=>{
      // The source report survives its failed Word delivery; the project may
      // then start a separate differential task under the existing mutex.
      await client.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[f.runId]);
      const runId=uid(),reportId=uid(),findingId=f.report.findings[0].finding_id,sourceHash=inputManifestHash(f.report);
      const review={...f.manifest.review,operation:'differential_review',version_number:2,report_id:reportId,
        source_report_id:f.reportId,source_report_sha256:sourceHash,finding_ids:[findingId]};
      const manifest={...f.manifest,review},hash=inputManifestHash(manifest);
      await client.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,2,$2,1,$3,$4,$5,'[]')`,[f.projectId,f.owner,hash,manifest,JSON.stringify(manifest.materials)]);
      await client.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
        VALUES($1,$2,$3,2,$4,$5,'review',$4,'paused')`,[runId,f.owner,f.projectId,hash,uid()]);
      await client.query(`INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,source_report_id,snapshot)
        VALUES($1,$2,$3,2,'differential_review',$4,$5)`,[runId,f.owner,f.projectId,f.reportId,
        {input:review.input,origin:review.origin,finding_ids:[findingId],input_version:1}]);
      const report:ReviewReport={...f.report,report_id:reportId,run_id:runId,input_revision:2,version:2,
        scope:{mode:'differential_review',finding_ids:[findingId]},findings:[],coverage:[],
        follow_up:{version:'review-follow-up-v1',source_report_id:f.reportId,source_report_sha256:sourceHash,
          findings:[{source_finding_id:findingId,current_finding_ids:[],coverage_check_ids:[],status:'uncompleted',outcome:'uncovered',reason:'Synthetic pending evidence'}]}};
      assert.ok(isReviewReport(report));
      await client.query(`INSERT INTO bb_review_reports(id,owner_user_id,project_id,run_id,version,content_sha256,report)
        VALUES($1,$2,$3,$4,2,$5,$6)`,[reportId,f.owner,f.projectId,runId,inputManifestHash(report),report]);
      assert.deepEqual((await readReviewExecutionReport(client,f.owner,f.projectId,reportId)).report,report);
      report.follow_up!.source_report_sha256=digest('wrong synthetic follow-up source');
      assert.ok(isReviewReport(report));
      await client.query('ALTER TABLE bb_review_execution_reports DISABLE TRIGGER USER');
      await client.query('UPDATE bb_review_execution_reports SET report=$2,content_sha256=$3 WHERE id=$1',[reportId,report,inputManifestHash(report)]);
      await assert.rejects(readReviewExecutionReport(client,f.owner,f.projectId,reportId),unavailable,
        'a recomputed body hash cannot authorize another source-report digest');
    });
  });

async function removeReportScaffold(client:PoolClient){
  await client.query(`DROP TABLE IF EXISTS bb_review_execution_reports CASCADE;
    DROP FUNCTION IF EXISTS bb_bridge_review_execution_report(),bb_check_review_execution_report() CASCADE;
    DROP FUNCTION IF EXISTS bb_review_report_storage_shape(jsonb) CASCADE;`);
}
async function insertOldReport(client:PoolClient,f:Fixture,report=f.report,hash=inputManifestHash(report),createdAt?:string){
  await client.query(`INSERT INTO bb_review_reports(id,owner_user_id,project_id,run_id,version,content_sha256,report,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz,now()))`,
  [report.report_id,f.owner,f.projectId,f.runId,report.version,hash,report,createdAt??null]);
}

test('0128 applies to an empty report registry without adding a run-only unique constraint or opening V2',
  {skip:!migrationConnection,timeout:30000},async t=>{
    const f=await fixture(migrationConnection);t.after(()=>f.pool.end());
    await rolledBack(f,async client=>{
      await removeReportScaffold(client);await client.query(migration);
      assert.equal((await client.query('SELECT count(*)::int n FROM bb_review_execution_reports')).rows[0].n,0);
      const constraints=(await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid='bb_review_execution_reports'::regclass AND contype IN ('p','u')`)).rows.map(r=>r.definition as string);
      assert.ok(constraints.includes('PRIMARY KEY (run_id, execution_version)'));
      assert.ok(constraints.includes('UNIQUE (id)'));
      assert.ok(!constraints.includes('UNIQUE (run_id)'));
      const run=(await client.query('SELECT * FROM bb_runs WHERE id=$1',[f.runId])).rows[0];
      await assert.rejects(assertRunExecution(client,run,{executionVersion:2,inputRevision:1,inputHash:f.hash}),conflict);
    });
  });

test('0128 backfills pre-existing V1 reports with the original canonical hash, JSON and PostgreSQL microsecond timestamp',
  {skip:!migrationConnection,timeout:30000},async t=>{
    const f=await fixture(migrationConnection);t.after(()=>f.pool.end());
    await rolledBack(f,async client=>{
      await removeReportScaffold(client);
      const createdAt=(await client.query("SELECT (clock_timestamp()+interval '1 second')::text AS value")).rows[0].value as string;
      await insertOldReport(client,f,f.report,inputManifestHash(f.report),createdAt);
      const legacy=(await client.query('SELECT * FROM bb_review_reports WHERE run_id=$1',[f.runId])).rows[0];
      await client.query(migration);
      const saved=await f.read(client);
      assert.deepEqual(saved.report,legacy.report);assert.equal(saved.content_sha256.trim(),legacy.content_sha256.trim());
      assert.equal(saved.id,legacy.id);assert.equal(saved.run_id,f.runId);assert.equal(saved.execution_version,1);
      assert.equal(saved.input_revision,1);assert.equal(saved.input_hash.trim(),f.hash);
      assert.equal((await client.query(`SELECT c.created_at=l.created_at AS exact FROM bb_review_execution_reports c
        JOIN bb_review_reports l ON l.id=c.id WHERE c.id=$1`,[f.reportId])).rows[0].exact,true);
      assert.equal((await client.query('SELECT created_at::text AS value FROM bb_review_execution_reports WHERE id=$1',[f.reportId])).rows[0].value,createdAt);
      assert.equal((await client.query('SELECT count(*)::int n FROM bb_run_execution_deliveries WHERE run_id=$1',[f.runId])).rows[0].n,0);
    });
  });

test('0128 rejects incompatible pre-existing report origins atomically instead of skipping or rewriting the legacy row',
  {skip:!migrationConnection,timeout:45000},async t=>{
    for(const defect of ['source','missing-origin','body','hash-format','time'] as const){
      const f=await fixture(migrationConnection);t.after(()=>f.pool.end());
      await rolledBack(f,async client=>{
        await removeReportScaffold(client);const report=structuredClone(f.report);
        if(defect==='source')report.source_material={...report.source_material,sha256:digest('invalid legacy source')};
        if(defect==='body')(report as unknown as {findings:unknown}).findings={};
        if(defect==='missing-origin'){
          await client.query('ALTER TABLE bb_review_execution_snapshots DISABLE TRIGGER USER');
          await client.query('DELETE FROM bb_review_execution_snapshots WHERE run_id=$1',[f.runId]);
          await client.query('ALTER TABLE bb_review_execution_snapshots ENABLE TRIGGER USER');
        }
        await insertOldReport(client,f,report,defect==='hash-format'?'invalid-hash-format':inputManifestHash(report),
          defect==='time'?'2001-01-01T00:00:00Z':undefined);
        const legacy=(await client.query('SELECT * FROM bb_review_reports WHERE id=$1',[f.reportId])).rows;
        await client.query('SAVEPOINT apply_report_migration');
        await assert.rejects(client.query(migration),error=>['23502','23503','23514'].includes((error as {code:string}).code),defect);
        await client.query('ROLLBACK TO SAVEPOINT apply_report_migration');
        assert.equal((await client.query("SELECT to_regclass('bb_review_execution_reports') AS relation")).rows[0].relation,null,defect);
        assert.equal((await client.query("SELECT to_regprocedure('bb_review_report_storage_shape(jsonb)') AS fn")).rows[0].fn,null,defect);
        assert.deepEqual((await client.query('SELECT * FROM bb_review_reports WHERE id=$1',[f.reportId])).rows,legacy,defect);
        await client.query('RELEASE SAVEPOINT apply_report_migration');
      });
    }
  });

test('0128 preserves a valid-format legacy digest unchanged and the trusted reader still rejects an incorrect body digest',
  {skip:!migrationConnection,timeout:30000},async t=>{
    const f=await fixture(migrationConnection);t.after(()=>f.pool.end());
    await rolledBack(f,async client=>{
      await removeReportScaffold(client);const wrongHash=digest('not the synthetic report body');
      await insertOldReport(client,f,f.report,wrongHash);await client.query(migration);
      assert.equal((await client.query('SELECT content_sha256 FROM bb_review_execution_reports WHERE id=$1',[f.reportId])).rows[0].content_sha256.trim(),wrongHash);
      await assert.rejects(f.read(client),unavailable,'SQL backfill does not pretend to compute the JavaScript canonical digest');
    });
  });

test('0128 NOWAIT fails atomically behind an in-flight legacy report lock, then applies after that writer releases it',
  {skip:!migrationConnection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:migrationConnection,statement_timeout:5000});t.after(()=>pool.end());
    const setup=await pool.connect(),blocker=await pool.connect(),migrator=await pool.connect();
    try{
      await setup.query('BEGIN');await removeReportScaffold(setup);await setup.query('COMMIT');
      await blocker.query('BEGIN');await blocker.query('LOCK TABLE bb_review_reports IN ROW EXCLUSIVE MODE');
      await migrator.query('BEGIN');await migrator.query('SAVEPOINT apply_report_migration');
      await assert.rejects(migrator.query(migration),{code:'55P03'});
      await migrator.query('ROLLBACK TO SAVEPOINT apply_report_migration');
      assert.equal((await migrator.query("SELECT to_regclass('bb_review_execution_reports') AS relation")).rows[0].relation,null);
      await blocker.query('ROLLBACK');await migrator.query(migration);
      assert.equal((await migrator.query("SELECT to_regclass('bb_review_execution_reports') AS relation")).rows[0].relation,'bb_review_execution_reports');
      await migrator.query('COMMIT');
    }finally{
      await Promise.allSettled([setup.query('ROLLBACK'),blocker.query('ROLLBACK'),migrator.query('ROLLBACK')]);
      setup.release();blocker.release();migrator.release();
    }
  });
