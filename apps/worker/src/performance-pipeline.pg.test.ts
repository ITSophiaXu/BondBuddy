// Real PostgreSQL and queue/delivery code; synthetic stages and in-memory storage, no model calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import type {PrivateBlobs} from '@bondbuddy/api/data';
import {flushPerformanceTraces} from '@bondbuddy/api/performance-trace';
import {isolatedTestDatabase} from './test-database.js';
import {runPipelineOnce,wordDeliveryStage,type RunStage} from './run-pipeline.js';
import {makeWorkerDocxFixture} from './docx-test-fixture.js';

const connection=await isolatedTestDatabase(undefined,'performance-pipeline');
test('pipeline records execution/recovery, checkpoint reuse and every delivery tail without changing outcomes',{skip:!connection,timeout:90000},async()=>{
 const pool=new Pool({connectionString:connection}),owner='perf-'+randomUUID(),files=new Map<string,Buffer>();
 const blobs:PrivateBlobs={put:async(k,b)=>{files.set(k,b);},get:async k=>files.get(k)!,getIfExists:async k=>files.get(k)??null,
  getIfExistsBounded:async(k,max)=>{const b=files.get(k);if(b&&b.length>max)throw Error('too large');return b??null;},exists:async k=>files.has(k),delete:async k=>{files.delete(k);}};
 const submit=async()=>{
  const project=randomUUID(),run=randomUUID(),job=randomUUID(),hash='a'.repeat(64);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic timing','update')",[project,owner]);
  await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')",[project,owner,hash]);
  await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'update',$4,'queued')",[run,owner,project,hash]);
  await pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage) VALUES($1,$2,$3,'update','default','queued','queued')",[job,owner,run]);
  return run;
 };
 const execute=(stages:RunStage[])=>runPipelineOnce({pool,blobs,stages,workerInstanceId:'synthetic-worker',leaseSeconds:30});
 const rows=async(run:string)=>{await flushPerformanceTraces(pool,5000);return (await pool.query('SELECT * FROM bb_performance_spans WHERE run_id=$1 ORDER BY started_at,sequence',[run])).rows;};
 try{
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'perf_'+randomUUID().slice(0,8)]);
  const completed=await submit();
  assert.equal(await execute([{name:'input_lock',run:async()=>({kind:'done',value:{synthetic:true}})},wordDeliveryStage(async()=>makeWorkerDocxFixture({externalLink:false}))]),'succeeded');
  const delivery=await rows(completed),keys=delivery.map(row=>row.step_key);
  for(const key of ['worker.claim','job.queue_wait','stage.execute','stage.checkpoint','artifact.promote','document.inspect','artifact.upload','artifact.readback','artifact.register','run.finish','run.terminal_persist'])assert(keys.includes(key),key);
  assert.equal(delivery.find(row=>row.step_key==='run.execution').status,'succeeded');
  assert(delivery.every(row=>row.duration_ms!==null&&row.duration_ms>=0));
  assert.equal((await pool.query('SELECT complete,worker_instance_id FROM bb_performance_sessions WHERE run_id=$1',[completed])).rows[0].complete,true);
  const retry=await submit();let checkpoints=0;
  const first:RunStage={name:'input_lock',run:async()=>{checkpoints++;return {kind:'done',checkpoint:{synthetic:true}};}};
  assert.equal(await execute([first,{name:'model_generation',run:async()=>{throw Error('synthetic failure');}}]),'retry');
  assert.equal(await execute([first,{name:'model_generation',run:async()=>({kind:'pause',stage:'capability_not_ready',reason:'synthetic_pause'})}]),'paused');
  const recovered=await rows(retry);
  assert.equal(checkpoints,1);assert.equal(recovered.filter(row=>row.step_key==='job.queue_wait').length,1);
  assert(recovered.some(row=>row.step_key==='stage.reuse'&&row.status==='reused'));
  assert.deepEqual(recovered.filter(row=>row.step_key==='run.execution').map(row=>row.status).sort(),['interrupted','paused']);
  assert.equal(new Set(recovered.map(row=>row.run_execution_id)).size,2);
  const failed=await submit();assert.equal(await execute([{name:'input_lock',run:async()=>({kind:'fail',code:'DATA_UNAVAILABLE'})}]),'failed');
  assert((await rows(failed)).some(row=>row.step_key==='run.execution'&&row.status==='failed'));
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE owner_user_id=$1',[owner])).rows[0].n,0);
 }finally{await flushPerformanceTraces(pool,1000);await pool.end();}
});
