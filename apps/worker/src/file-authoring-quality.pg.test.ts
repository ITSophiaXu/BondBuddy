// Synthetic quality outcome, real PostgreSQL checkpoint/lease/terminal-state persistence.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { PrivateBlobs } from '@bondbuddy/api/data';
import { isolatedTestDatabase } from './test-database.js';
import { runPipelineOnce } from './run-pipeline.js';

const database=await isolatedTestDatabase(undefined,'file-authoring-quality');
test('a failed quality report remains checkpointed after the run fails without a delivery-completed event',{skip:!database},async()=>{
  const pool=new Pool({connectionString:database});
  const owner=`quality-owner-${randomUUID()}`,project=`quality-project-${randomUUID()}`;
  const inputHash='a'.repeat(64),runId=`quality-run-${randomUUID()}`,jobId=`quality-job-${randomUUID()}`;
  const gate={version:'word-quality-v1',status:'failed',report:{
    key:`owners/${owner}/projects/${project}/runs/${runId}/file-authoring/quality/${'b'.repeat(64)}/quality-report.json`,
    sha256:'b'.repeat(64),byte_size:123}};
  try{
    await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE job_type<>'parse' AND state IN ('queued','running')");
    await pool.query("UPDATE bb_runs SET state='cancelled' WHERE state IN ('queued','running')");
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind,update_details) VALUES($1,$2,'synthetic quality','generation','{}'::jsonb)",[project,owner]);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb)`,[project,owner,inputHash]);
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,channel)
      VALUES($1,$2,$3,1,$4,$5,'generation',$4,'queued','production')`,[runId,owner,project,inputHash,`exec-${runId}`]);
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage)
      VALUES($1,$2,$3,'generation','default','queued','queued')`,[jobId,owner,runId]);
    assert.equal(await runPipelineOnce({pool,blobs:{} as PrivateBlobs,stages:[{name:'word_delivery',replay:true,
      run:async()=>({kind:'fail',code:'WORD_QUALITY_REJECTED',checkpoint:{quality_gate:gate}})}],
      onUnexpectedError:error=>assert.fail(JSON.stringify(error))}),'failed');
    const saved=(await pool.query('SELECT state,checkpoint FROM bb_jobs WHERE id=$1',[jobId])).rows[0];
    assert.equal(saved.state,'failed');assert.deepEqual(saved.checkpoint.stages.word_delivery.quality_gate,gate);
    const run=(await pool.query('SELECT state,artifact_id FROM bb_runs WHERE id=$1',[runId])).rows[0];
    assert.equal(run.state,'failed');assert.equal(run.artifact_id,null);
    const events=(await pool.query('SELECT payload FROM bb_run_events WHERE run_id=$1',[runId])).rows.map(r=>r.payload);
    assert.equal(events.some(e=>e.reason==='stage_completed'),false);
    assert.ok(events.some(e=>e.reason==='processor_failed' && e.error_code==='WORD_QUALITY_REJECTED'));
  }finally{await pool.end();}
});
