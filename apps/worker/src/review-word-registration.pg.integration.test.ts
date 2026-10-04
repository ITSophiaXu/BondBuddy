// Synthetic reports; real PostgreSQL locks and immutable registration. No CLI or customer data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import type { ReviewReport } from '@bondbuddy/contracts';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { registerReviewReport } from './review-word-stage.js';
import type { StageContext } from './run-pipeline.js';
import { isolatedTestDatabase } from './test-database.js';

const database=await isolatedTestDatabase(undefined,'review-word-registration');
test('report registration locks the project catalog and rejects expired or cancelled writers',{skip:!database,timeout:30000},async t=>{
  const pool=new Pool({connectionString:database});
  async function fixture(){
    const owner=randomUUID(),project=randomUUID(),runId=randomUUID(),jobId=randomUUID(),token=randomUUID(),hash='a'.repeat(64);
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`word_${owner.replaceAll('-','').slice(0,16)}`]);
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic report registration','review')",[project,owner]);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,'{}','[]','[]')`,[project,owner,hash]);
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
      VALUES($1,$2,$3,1,$4,$5,'review',$4,'running')`,[runId,owner,project,hash,randomUUID()]);
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,lease_token,lease_until)
      VALUES($1,$2,$3,'run','review','running',$4,now()+interval '60 seconds')`,[jobId,owner,runId,token]);
    const report:ReviewReport={report_id:randomUUID(),project_id:project,run_id:runId,input_revision:1,version:1,
      source_material:{material_id:'synthetic-source',material_version:1,sha256:hash},scope:{mode:'full_review',finding_ids:[]},
      findings:[],coverage:[],limitations:['Synthetic registration only'],created_at:'2026-10-04T00:00:00Z'};
    const ctx={pool,run:{id:runId,owner_user_id:owner,project_id:project,input_revision:1,input_hash:hash},
      lease:{jobId,runId,owner,token}} as Pick<StageContext,'pool'|'run'|'lease'>;
    const rows=async()=>(await pool.query('SELECT id,report,content_sha256 FROM bb_review_reports WHERE run_id=$1',[runId])).rows;
    return {ctx,report,rows};
  }
  try{
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
        else if(mode==='wrong-token')f.ctx.lease.token=randomUUID();else f.ctx.run.project_id=randomUUID();
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
