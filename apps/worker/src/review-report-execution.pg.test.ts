// Synthetic reports; real PostgreSQL execution snapshots, leases and atomic V1
// mirrors. No provider, Word process, artifact promotion or customer charge.
import assert from 'node:assert/strict';
import test from 'node:test';
import {Pool} from 'pg';
import {isReviewReport,type ReviewEvidenceRef,type ReviewReport} from '@bondbuddy/contracts';
import {digest,uid} from '@bondbuddy/api/data';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import { resolveRunExecution } from '@bondbuddy/api/run-execution';
import {registerReviewReport} from './review-word-stage.js';
import type {StageContext} from './run-pipeline.js';
import {isolatedTestDatabase} from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'review-report-execution');
const conflict=(error:unknown)=>(error as {code?:string})?.code==='INPUT_REVISION_CONFLICT';

async function fixture(){
  const applicationName=`report-registration-${uid()}`,pool=new Pool({connectionString:connection,application_name:applicationName,statement_timeout:10000});
  const owner=uid(),projectId=uid(),runId=uid(),jobId=uid(),token=uid(),reportId=uid(),materialId=uid(),uploadId=uid();
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`report_worker_${uid().replaceAll('-','').slice(0,16)}`]);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic report writer','review')",[projectId,owner]);
  const bytes=Buffer.from('Synthetic trusted report source'),sourceHash=digest(bytes);
  await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
    VALUES($1,$2,$3,'synthetic-report.pdf','application/pdf',$4,$5,'other',$6,now()+interval '1 hour','completed')`,
  [uploadId,owner,projectId,bytes.length,sourceHash,`users/${owner}/uploads/${uploadId}`]);
  await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
    VALUES($1,1,$2,$3,$4,'other','synthetic-report.pdf','application/pdf',$5,$6,$7,'persisted')`,
  [materialId,owner,projectId,uploadId,bytes.length,sourceHash,`users/${owner}/projects/${projectId}/materials/${materialId}`]);
  const pin={material_id:materialId,material_version:1,sha256:sourceHash};
  const input={source_material_ref:pin,material_versions:[pin],requirements:['Synthetic trusted writer'],as_of:null};
  const origin={version:'review-execution-origin-v1',entrypoint:'quick_action',accepted_proposal:null,context_report_ref:null};
  const manifest={draft_revision:1,project_kind:'review',materials:[{...pin,role:'other'}],review:{version:'review_v1',
    operation:'full_review',version_number:1,report_id:reportId,source_report_id:null,source_report_sha256:null,finding_ids:[],input,origin}};
  const hash=inputManifestHash(manifest);
  await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,1,$2,1,$3,$4,$5,'[]')`,[projectId,owner,hash,manifest,JSON.stringify(manifest.materials)]);
  await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1',[projectId]);
  await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
    VALUES($1,$2,$3,1,$4,$5,'review',$4,'running','word_delivery')`,[runId,owner,projectId,hash,uid()]);
  await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,lease_token,lease_until,attempts)
    VALUES($1,$2,$3,'review','default','running','word_delivery',$4,now()+interval '10 minutes',1)`,[jobId,owner,runId,token]);
  await pool.query(`INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,snapshot)
    VALUES($1,$2,$3,1,'full_review',$4)`,[runId,owner,projectId,{input,origin,finding_ids:[],input_version:1}]);
  const report:ReviewReport={report_id:reportId,project_id:projectId,run_id:runId,input_revision:1,version:1,
    source_material:pin,scope:{mode:'full_review',finding_ids:[]},findings:[],coverage:[],
    limitations:['Synthetic registration only'],created_at:new Date().toISOString()};
  const lease={owner,runId,jobId,token,checkpoint:{},attempts:1,executionVersion:1,inputRevision:1,inputHash:hash};
  const ctx:Pick<StageContext,'pool'|'run'|'lease'>={pool,run:await resolveRunExecution(pool,owner,runId,lease),lease};
  const legacy=async(body:ReviewReport=report)=>pool.query(`INSERT INTO bb_review_reports(id,owner_user_id,project_id,run_id,version,content_sha256,report)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[body.report_id,owner,projectId,runId,body.version,inputManifestHash(body),body]);
  return {pool,owner,projectId,runId,jobId,reportId,hash,manifest,ctx,report,legacy,applicationName};
}

type Fixture=Awaited<ReturnType<typeof fixture>>;
async function rows(f:Fixture){
  return (await f.pool.query(`SELECT c.*,c.id=l.id AND c.owner_user_id=l.owner_user_id AND c.project_id=l.project_id
    AND c.run_id=l.run_id AND c.version=l.version AND c.content_sha256=l.content_sha256
    AND c.report=l.report AND c.created_at=l.created_at AS mirror_exact
    FROM bb_review_execution_reports c JOIN bb_review_reports l ON l.run_id=c.run_id WHERE c.run_id=$1`,[f.runId])).rows;
}
async function absent(f:Fixture){
  for(const table of ['bb_review_execution_reports','bb_review_reports'])
    assert.equal((await f.pool.query(`SELECT 1 FROM ${table} WHERE run_id=$1`,[f.runId])).rowCount,0,table);
}

test('trusted report registration creates one exact execution body and V1 mirror; only identical bytes replay',
  {skip:!connection,timeout:30000},async t=>{
    const f=await fixture();t.after(()=>f.pool.end());
    assert.equal(await registerReviewReport(f.ctx,f.report),true);
    const saved=await rows(f);assert.equal(saved.length,1);assert.equal(saved[0].mirror_exact,true);
    assert.equal(saved[0].id,f.reportId);assert.equal(saved[0].owner_user_id,f.owner);assert.equal(saved[0].project_id,f.projectId);
    assert.equal(saved[0].run_id,f.runId);assert.equal(saved[0].execution_version,1);assert.equal(saved[0].input_revision,1);
    assert.equal(saved[0].input_hash.trim(),f.hash);assert.equal(saved[0].content_sha256.trim(),inputManifestHash(f.report));
    assert.deepEqual(saved[0].report,f.report);
    assert.equal(await registerReviewReport(f.ctx,structuredClone(f.report)),true);assert.deepEqual(await rows(f),saved);
    assert.equal(await registerReviewReport(f.ctx,{...f.report,limitations:['Different immutable report body']}),false);
    assert.equal(await registerReviewReport(f.ctx,{...f.report,report_id:uid()}),false);assert.deepEqual(await rows(f),saved);
    await f.pool.query("UPDATE bb_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.jobId]);
    assert.equal(await registerReviewReport(f.ctx,f.report),false,'an exact replay still requires the current live lease');
    assert.deepEqual(await rows(f),saved);
    for(const table of ['bb_run_execution_deliveries','bb_artifact_versions','bb_credit_events'])
      assert.equal((await f.pool.query(`SELECT 1 FROM ${table} WHERE run_id=$1`,[f.runId])).rowCount,0,
        'report persistence alone creates neither delivery, artifact nor charge');
  });

test('wrong or expired lease identity and mismatched frozen report pins cannot create either registry row',
  {skip:!connection,timeout:45000},async t=>{
    for(const defect of ['expired','cancelled','paused','token','owner','version','revision','hash','source','report-id','business-version','scope'] as const){
      const f=await fixture();t.after(()=>f.pool.end());const report=structuredClone(f.report);
      if(defect==='expired')await f.pool.query("UPDATE bb_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.jobId]);
      if(defect==='cancelled')await f.pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[f.runId]);
      if(defect==='paused')await f.pool.query("UPDATE bb_jobs SET state='paused' WHERE id=$1",[f.jobId]);
      if(defect==='token')f.ctx.lease.token=uid();
      if(defect==='owner')f.ctx.lease.owner=uid();
      if(defect==='version')f.ctx.lease.executionVersion=2;
      if(defect==='revision')f.ctx.lease.inputRevision=2;
      if(defect==='hash')f.ctx.lease.inputHash=digest('wrong execution input');
      if(defect==='source')report.source_material={...report.source_material,sha256:digest('wrong source material')};
      if(defect==='report-id')report.report_id=uid();
      if(defect==='business-version')report.version=2;
      if(defect==='scope')report.scope.mode='differential_review';
      if(['version','revision','hash'].includes(defect))await assert.rejects(registerReviewReport(f.ctx,report),conflict,defect);
      else assert.equal(await registerReviewReport(f.ctx,report),false,defect);
      await absent(f);
      assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_run_execution_versions WHERE run_id=$1',[f.runId])).rows[0].n,1,
        'rejected writers never create a successor execution');
    }
  });

test('a rolling old writer bridges V1 once and the trusted writer replays its exact persisted timestamp',
  {skip:!connection,timeout:30000},async t=>{
    const f=await fixture();t.after(()=>f.pool.end());await f.legacy();const saved=await rows(f);
    assert.equal(saved.length,1);assert.equal(saved[0].mirror_exact,true);
    assert.equal(await registerReviewReport(f.ctx,f.report),true);assert.deepEqual(await rows(f),saved);
    assert.equal(await registerReviewReport(f.ctx,{...f.report,limitations:['Changed after the old writer']}),false);
    assert.deepEqual(await rows(f),saved);
  });

test('an incompatible V1 mirror rolls back a newly inserted canonical report rather than leaving partial storage',
  {skip:!connection,timeout:30000},async t=>{
    const f=await fixture();t.after(()=>f.pool.end());
    const previous={...f.report,limitations:['Synthetic conflicting legacy report']};await f.legacy(previous);
    const legacy=(await f.pool.query('SELECT * FROM bb_review_reports WHERE run_id=$1',[f.runId])).rows;
    const client=await f.pool.connect();
    try{
      await client.query('BEGIN');
      await client.query('ALTER TABLE bb_review_execution_reports DISABLE TRIGGER USER');
      await client.query('DELETE FROM bb_review_execution_reports WHERE run_id=$1',[f.runId]);
      await client.query('ALTER TABLE bb_review_execution_reports ENABLE TRIGGER USER');
      await client.query('COMMIT');
    }finally{await client.query('ROLLBACK');client.release();}
    await assert.rejects(registerReviewReport(f.ctx,f.report),conflict);
    assert.equal((await f.pool.query('SELECT 1 FROM bb_review_execution_reports WHERE run_id=$1',[f.runId])).rowCount,0);
    assert.deepEqual((await f.pool.query('SELECT * FROM bb_review_reports WHERE run_id=$1',[f.runId])).rows,legacy);
  });

test('registration waiting for the project catalog lock rechecks lease time after that lock is released',
  {skip:!connection,timeout:30000},async t=>{
    const f=await fixture();t.after(()=>f.pool.end());const blocker=await f.pool.connect();
    let pending:Promise<boolean>|undefined;
    try{
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM bb_projects WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[f.projectId,f.owner]);
      pending=registerReviewReport(f.ctx,f.report);
      let waiting=false;
      for(let attempt=0;attempt<200;attempt++){
        waiting=!!(await f.pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1
          AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM bb_projects%'`,[f.applicationName])).rowCount;
        if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(waiting,true,'registration must wait on the same catalog lock used by adoption');
      await blocker.query("UPDATE bb_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.jobId]);
      await blocker.query('COMMIT');assert.equal(await pending,false);await absent(f);
    }finally{
      await blocker.query('ROLLBACK');blocker.release();await pending;
    }
  });

test('a schema-valid undefined locator value cannot commit a partial report after JSONB serialization changes its body hash',
  {skip:!connection,timeout:30000},async t=>{
    const f=await fixture();t.after(()=>f.pool.end());const report=structuredClone(f.report),pin=report.source_material;
    const ref:ReviewEvidenceRef={material_id:pin.material_id,material_version:pin.material_version,material_sha256:pin.sha256,
      parse_snapshot_id:'synthetic-parse',parse_response_sha256:digest('synthetic parse'),record_id:'synthetic-record',record_sha256:digest('synthetic record'),
      locator_type:'pdf_bbox',locator:{page:1,synthetic_unstored:undefined},quote:'Synthetic serialization evidence',extraction_method:'native_text',uncertainty:[]};
    report.findings=[{finding_id:'synthetic-serialization',report_id:report.report_id,dimension:'financial',conclusion:'manual',severity:'P3',
      title:'Synthetic JSON locator',description:'Synthetic serialization boundary',target_refs:[ref],evidence_refs:[ref],limitations:[],
      repairability:{can_revise:false,reason:'Synthetic evidence only',allowed_record_ids:[]},origin_report_id:report.report_id,check_status:'rechecked'}];
    assert.ok(isReviewReport(report),'the Unknown locator contract accepts this JavaScript value');
    assert.notEqual(inputManifestHash(report),inputManifestHash(JSON.parse(JSON.stringify(report))),
      'PostgreSQL receives JSON that omits the undefined property');
    await assert.rejects(registerReviewReport(f.ctx,report),conflict);
    await absent(f);
  });

test('a differential report writer rejects a schema-valid wrong follow-up source digest before either registry is created',
  {skip:!connection,timeout:30000},async t=>{
    const f=await fixture();t.after(()=>f.pool.end());const findingId='synthetic-source-finding';
    f.report.findings=[{finding_id:findingId,report_id:f.reportId,dimension:'financial',conclusion:'needs_evidence',severity:'P3',
      title:'Synthetic source finding',description:'Synthetic missing evidence',target_refs:[],evidence_refs:[],limitations:[],
      repairability:{can_revise:false,reason:'Synthetic evidence pending',allowed_record_ids:[]},origin_report_id:f.reportId,check_status:'rechecked'}];
    assert.equal(await registerReviewReport(f.ctx,f.report),true);
    const sourceRows=await rows(f),sourceHash=inputManifestHash(f.report),runId=uid(),reportId=uid(),jobId=uid(),token=uid();
    await f.pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[f.runId]);
    await f.pool.query("UPDATE bb_jobs SET state='failed',lease_token=NULL,lease_until=NULL WHERE id=$1",[f.ctx.lease.jobId]);
    const review={...f.manifest.review,operation:'differential_review',version_number:2,report_id:reportId,
      source_report_id:f.reportId,source_report_sha256:sourceHash,finding_ids:[findingId]};
    const manifest={...f.manifest,review},hash=inputManifestHash(manifest);
    await f.pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,2,$2,1,$3,$4,$5,'[]')`,[f.projectId,f.owner,hash,manifest,JSON.stringify(manifest.materials)]);
    await f.pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
      VALUES($1,$2,$3,2,$4,$5,'review',$4,'running','word_delivery')`,[runId,f.owner,f.projectId,hash,uid()]);
    await f.pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,lease_token,lease_until,attempts)
      VALUES($1,$2,$3,'review','default','running','word_delivery',$4,now()+interval '10 minutes',1)`,[jobId,f.owner,runId,token]);
    await f.pool.query(`INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,source_report_id,snapshot)
      VALUES($1,$2,$3,2,'differential_review',$4,$5)`,[runId,f.owner,f.projectId,f.reportId,
      {input:review.input,origin:review.origin,finding_ids:[findingId],input_version:1}]);
    const lease={owner:f.owner,runId,jobId,token,checkpoint:{},attempts:1,executionVersion:1,inputRevision:2,inputHash:hash};
    const ctx:Pick<StageContext,'pool'|'run'|'lease'>={pool:f.pool,run:await resolveRunExecution(f.pool,f.owner,runId,lease),lease};
    const report:ReviewReport={...f.report,report_id:reportId,run_id:runId,input_revision:2,version:2,
      scope:{mode:'differential_review',finding_ids:[findingId]},findings:[],coverage:[],
      follow_up:{version:'review-follow-up-v1',source_report_id:f.reportId,source_report_sha256:digest('wrong synthetic follow-up source'),
        findings:[{source_finding_id:findingId,current_finding_ids:[],coverage_check_ids:[],status:'uncompleted',outcome:'uncovered',reason:'Synthetic pending evidence'}]}};
    assert.ok(isReviewReport(report));assert.equal(await registerReviewReport(ctx,report),false);
    for(const table of ['bb_review_execution_reports','bb_review_reports'])
      assert.equal((await f.pool.query(`SELECT 1 FROM ${table} WHERE run_id=$1`,[runId])).rowCount,0,table);
    report.follow_up!.source_report_sha256=sourceHash;
    assert.equal(await registerReviewReport(ctx,report),true,'the same frozen differential task accepts the correct source-report digest');
    const saved=(await f.pool.query('SELECT report,content_sha256 FROM bb_review_execution_reports WHERE run_id=$1',[runId])).rows[0];
    assert.deepEqual(saved.report,report);assert.equal(saved.content_sha256.trim(),inputManifestHash(report));
    assert.deepEqual(await rows(f),sourceRows,'differential publication does not mutate its original source report');
  });
