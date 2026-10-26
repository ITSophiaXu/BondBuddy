// Synthetic reports; real PostgreSQL locks and immutable registration. No CLI or customer data.
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import type { ReviewReport } from '@bondbuddy/contracts';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { resolveRunExecution } from '@bondbuddy/api/run-execution';
import { registerReviewReport } from './review-word-stage.js';
import type { StageContext } from './run-pipeline.js';
import { isolatedTestDatabase } from './test-database.js';

const database=await isolatedTestDatabase(undefined,'review-word-registration');
test('report registration locks the project catalog and rejects expired or cancelled writers',{skip:!database,timeout:30000},async t=>{
  const pool=new Pool({connectionString:database});
  async function fixture(){
    const owner=randomUUID(),project=randomUUID(),runId=randomUUID(),jobId=randomUUID(),token=randomUUID(),reportId=randomUUID();
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`word_${owner.replaceAll('-','').slice(0,16)}`]);
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic report registration','review')",[project,owner]);
    const materialId=randomUUID(),uploadId=randomUUID(),bytes=Buffer.from('Synthetic immutable report source');
    const sourceHash=createHash('sha256').update(bytes).digest('hex');
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'synthetic-report.pdf','application/pdf',$4,$5,'other',$6,now()+interval '1 hour','completed')`,
      [uploadId,owner,project,bytes.length,sourceHash,`users/${owner}/uploads/${uploadId}`]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'other','synthetic-report.pdf','application/pdf',$5,$6,$7,'persisted')`,
      [materialId,owner,project,uploadId,bytes.length,sourceHash,`users/${owner}/projects/${project}/materials/${materialId}`]);
    const pin={material_id:materialId,material_version:1,sha256:sourceHash};
    const input={source_material_ref:pin,material_versions:[pin],requirements:['Synthetic registration only'],as_of:null};
    const origin={version:'review-execution-origin-v1',entrypoint:'quick_action',accepted_proposal:null,context_report_ref:null};
    const manifest={draft_revision:1,project_kind:'review',materials:[{...pin,role:'other'}],review:{version:'review_v1',
      operation:'full_review',version_number:1,report_id:reportId,source_report_id:null,source_report_sha256:null,finding_ids:[],input,origin}};
    const hash=inputManifestHash(manifest);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,$4,$5,'[]')`,[project,owner,hash,manifest,JSON.stringify(manifest.materials)]);
    await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1',[project]);
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
      VALUES($1,$2,$3,1,$4,$5,'review',$4,'running')`,[runId,owner,project,hash,randomUUID()]);
    await pool.query(`INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,snapshot)
      VALUES($1,$2,$3,1,'full_review',$4)`,[runId,owner,project,{input,origin,finding_ids:[],input_version:1}]);
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,lease_token,lease_until)
      VALUES($1,$2,$3,'run','review','running',$4,now()+interval '60 seconds')`,[jobId,owner,runId,token]);
    const report:ReviewReport={report_id:reportId,project_id:project,run_id:runId,input_revision:1,version:1,
      source_material:pin,scope:{mode:'full_review',finding_ids:[]},
      findings:[],coverage:[],limitations:['Synthetic registration only'],created_at:new Date().toISOString()};
    const lease={jobId,runId,owner,token,attempts:1,checkpoint:{},executionVersion:1,inputRevision:1,inputHash:hash};
    const ctx:Pick<StageContext,'pool'|'run'|'lease'>={pool,run:await resolveRunExecution(pool,owner,runId,lease),lease};
    const rows=async()=>(await pool.query('SELECT id,report,content_sha256 FROM bb_review_reports WHERE run_id=$1',[runId])).rows;
    return {ctx,report,rows};
  }
  try{
    await t.test('publication refuses the wrong immutable execution despite a live original token',async()=>{
      const f=await fixture(),initial={...f.ctx.lease};
      for(const changed of [{inputHash:'b'.repeat(64)},{inputRevision:2},{executionVersion:2}]){
        Object.assign(f.ctx.lease,initial,changed);
        await assert.rejects(registerReviewReport(f.ctx,f.report),{code:'INPUT_REVISION_CONFLICT'});
        assert.deepEqual(await f.rows(),[]);
      }
      Object.assign(f.ctx.lease,initial);assert.equal(await registerReviewReport(f.ctx,f.report),true);
    });
    await t.test('live lease registers once and only exact report bytes replay',async()=>{
      const f=await fixture();assert.equal(await registerReviewReport(f.ctx,f.report),true);
      const before=await f.rows();assert.equal(before.length,1);assert.equal(before[0].content_sha256.trim(),inputManifestHash(f.report));
      assert.equal(await registerReviewReport(f.ctx,f.report),true);assert.deepEqual(await f.rows(),before);
      assert.equal(await registerReviewReport(f.ctx,{...f.report,limitations:['different bytes']}),false);assert.deepEqual(await f.rows(),before);
    });
    await t.test('expired token, cancelled run, paused run, wrong token and wrong project cannot publish',async()=>{
      for(const mode of ['expired','cancelled','paused','wrong-token','wrong-project'] as const){
        const f=await fixture();
        if(mode==='expired')await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[f.ctx.lease.jobId]);
        else if(mode==='cancelled'||mode==='paused')await pool.query('UPDATE bb_runs SET state=$2 WHERE id=$1',[f.ctx.run.id,mode]);
        else if(mode==='wrong-token')f.ctx.lease.token=randomUUID();else f.ctx.run={...f.ctx.run,project_id:randomUUID()};
        assert.equal(await registerReviewReport(f.ctx,f.report),false,mode);assert.deepEqual(await f.rows(),[]);
      }
    });
    await t.test('adoption/catalog lock serializes a cancelled old completion with a new execution',async()=>{
      const f=await fixture(),adoption=await pool.connect();let registration:Promise<boolean>|undefined;
      try{
        await adoption.query('BEGIN');await adoption.query('SELECT id FROM bb_projects WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[f.ctx.run.project_id,f.ctx.run.owner_user_id]);
        registration=registerReviewReport(f.ctx,f.report);
        let blocked=false;
        for(let attempt=0;attempt<100;attempt++){
          blocked=(await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
            AND query LIKE 'SELECT id FROM bb_projects%') AS waiting`)).rows[0].waiting;
          if(blocked)break;await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert.equal(blocked,true,'writer waits for the same project lock used by proposal adoption');
        assert.equal(Number((await adoption.query('SELECT COALESCE(max(version),0) AS version FROM bb_review_reports WHERE project_id=$1',[f.ctx.run.project_id])).rows[0].version),0);
        await adoption.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[f.ctx.run.id]);
        await adoption.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE id=$1",[f.ctx.lease.jobId]);
        await adoption.query('COMMIT');assert.equal(await registration,false);assert.deepEqual(await f.rows(),[]);
      }finally{await adoption.query('ROLLBACK');adoption.release();await registration;}
    });
  }finally{await pool.end();}
});
