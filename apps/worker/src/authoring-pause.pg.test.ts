import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {action} from '@bondbuddy/api/queue';
import type {PrivateBlobs} from '@bondbuddy/api/data';
import {runPipelineOnce,type RunStage} from './run-pipeline.js';
import {isolatedTestDatabase} from './test-database.js';
const connection=await isolatedTestDatabase(undefined,'authoring-pause');
test('pipeline saves in-flight work, pauses before the next stage and resumes without repeating saved work',{skip:!connection,timeout:30000},async()=>{
 const pool=new Pool({connectionString:connection}),owner=randomUUID(),project=randomUUID(),runId=randomUUID(),jobId=randomUUID(),hash='a'.repeat(64);
 let release!:()=>void,started!:()=>void,calls=0,following=0;
 const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r);
 try{
   await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic pause','update')",[project,owner]);
   await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')",[project,owner,hash]);
   await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'update',$4,'queued')",[runId,owner,project,hash]);
   await pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage) VALUES($1,$2,$3,'update','default','queued','queued')",[jobId,owner,runId]);
   const stages:RunStage[]=[{name:'model_generation',run:async()=>{calls++;started();await gate;return {kind:'done',checkpoint:{saved:'synthetic-result'}};}},
     {name:'next_stage',run:async()=>{following++;return {kind:'fail',code:'DATA_UNAVAILABLE'};}}];
   const pending=runPipelineOnce({pool,blobs:{} as PrivateBlobs,stages});
   await entered;const paused=await action(pool,owner,runId,'pause');assert.equal(paused.state,'running');
   release();assert.equal(await pending,'paused');assert.equal(calls,1);assert.equal(following,0);
   assert.equal((await pool.query('SELECT stage FROM bb_runs WHERE id=$1',[runId])).rows[0].stage,'user_paused');
   await action(pool,owner,runId,'resume');
   assert.equal(await runPipelineOnce({pool,blobs:{} as PrivateBlobs,stages}),'failed');
   assert.equal(calls,1);assert.equal(following,1);
 }finally{release?.();await pool.end();}
});
