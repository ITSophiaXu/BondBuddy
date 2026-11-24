// Real PostgreSQL and queue/delivery code; synthetic stages and in-memory storage, no model calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import type {PrivateBlobs} from '@bondbuddy/api/data';
import {flushPerformanceTraces,withPerformanceTrace,withPerformanceSpan} from '@bondbuddy/api/performance-trace';
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
 const execute=(stages:RunStage[])=>runPipelineOnce({pool,blobs,stages,workerInstanceId:'synthetic-worker',workerHostId:'synthetic-host',leaseSeconds:30});
 const rows=async(run:string)=>{await flushPerformanceTraces(pool,5000);return (await pool.query('SELECT * FROM bb_performance_spans WHERE run_id=$1 ORDER BY started_at,sequence',[run])).rows;};
 try{
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'perf_'+randomUUID().slice(0,8)]);
  const completed=await submit();
  assert.equal(await execute([{name:'input_lock',run:async()=>({kind:'done',value:{synthetic:true}})},wordDeliveryStage(async()=>makeWorkerDocxFixture({externalLink:false}))]),'succeeded');
  const delivery=await rows(completed),keys=delivery.map(row=>row.step_key);
  for(const key of ['worker.claim','job.queue_wait','stage.execute','stage.checkpoint','artifact.promote','document.inspect','artifact.upload','artifact.readback','artifact.register','run.finish','run.terminal_persist'])assert(keys.includes(key),key);
  assert.equal(delivery.find(row=>row.step_key==='run.execution').status,'succeeded');
  assert(delivery.every(row=>row.duration_ms!==null&&row.duration_ms>=0));
  const sessions=(await pool.query('SELECT * FROM bb_performance_sessions WHERE run_id=$1',[completed])).rows;
  assert.equal(sessions.length,1);
  const session=sessions[0];
  assert.equal(session.worker_instance_id,'synthetic-worker');
  const claims=(await pool.query("SELECT payload FROM bb_run_events WHERE run_id=$1 AND payload->>'reason'='claimed' ORDER BY seq",[completed])).rows;
  assert.equal(claims.length,1);
  assert.equal(claims[0].payload.worker_instance_id,'synthetic-worker');
  assert.equal(claims[0].payload.worker_host_id,'synthetic-host');
  assert.equal(claims[0].payload.attempt_no,'1');
  assert.equal(session.closed,true);
  assert.equal(session.generated,delivery.length);
  assert.equal(session.acknowledged,delivery.length);
  assert.equal(session.dropped,0);assert.equal(session.invalid_attributes,0);
  assert(delivery.every(row=>row.session_id===session.session_id&&row.ended_at!==null&&row.status!=='running'));
  // The independent writer deliberately stops waiting on a hot run row after 250ms.
  // A retried, fully acknowledged trace still reports that advisory flush failure.
  assert.equal(session.complete,session.flush_errors===0);
  const retry=await submit();let checkpoints=0;
  const first:RunStage={name:'input_lock',run:async()=>{checkpoints++;return {kind:'done',checkpoint:{synthetic:true}};}};
  assert.equal(await execute([first,{name:'model_generation',run:async()=>{throw Error('synthetic failure');}}]),'retry');
  assert.equal(await execute([first,{name:'model_generation',run:async()=>({kind:'pause',stage:'capability_not_ready',reason:'synthetic_pause'})}]),'paused');
  const recovered=await rows(retry);
  assert.equal(checkpoints,1);assert.equal(recovered.filter(row=>row.step_key==='job.queue_wait').length,1);
  assert(recovered.some(row=>row.step_key==='stage.reuse'&&row.status==='reused'));
  assert.deepEqual(recovered.filter(row=>row.step_key==='run.execution').map(row=>row.status).sort(),['interrupted','paused']);
  const retryClaims=(await pool.query("SELECT payload->>'attempt_no' AS attempt_no,payload->>'worker_instance_id' AS worker_instance_id,payload->>'worker_host_id' AS worker_host_id FROM bb_run_events WHERE run_id=$1 AND payload->>'reason'='claimed' ORDER BY seq",[retry])).rows;
  assert.deepEqual(retryClaims,[{attempt_no:'1',worker_instance_id:'synthetic-worker',worker_host_id:'synthetic-host'},{attempt_no:'2',worker_instance_id:'synthetic-worker',worker_host_id:'synthetic-host'}]);
  assert.equal(new Set(recovered.map(row=>row.run_execution_id)).size,2);
  const failed=await submit();assert.equal(await execute([{name:'input_lock',run:async()=>({kind:'fail',code:'DATA_UNAVAILABLE'})}]),'failed');
  assert((await rows(failed)).some(row=>row.step_key==='run.execution'&&row.status==='failed'));
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE owner_user_id=$1',[owner])).rows[0].n,0);
 }finally{await flushPerformanceTraces(pool,1000);await pool.end();}
});


test('a run-row lock never blocks the business callback and a retried trace retains its flush error',
 {skip:!connection,timeout:30000},async()=>{
  const pool=new Pool({connectionString:connection});
  const owner='perf-contention-'+randomUUID(),project=randomUUID(),run=randomUUID(),job=randomUUID(),hash='b'.repeat(64);
  const blocker=await pool.connect();let locked=false,blockedFlush:Promise<void>|undefined;
  let callbackTimer:ReturnType<typeof setTimeout>|undefined;
  const scope={ownerUserId:owner,projectId:project,runId:run,jobId:job,taskKind:'update',serviceRole:'worker',workerInstanceId:'synthetic-worker'};
  try{
   await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'perf_lock_'+randomUUID().slice(0,8)]);
   await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic timing contention','update')",[project,owner]);
   await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')",[project,owner,hash]);
   await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'update',$4,'queued')",[run,owner,project,hash]);
   await pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage) VALUES($1,$2,$3,'update','default','queued','queued')",[job,owner,run]);
   // Establish the real advisory pool before taking the run lock, so this scenario
   // exercises its FK lock wait rather than a cold connection timeout.
   const warmExecution=randomUUID();
   await withPerformanceTrace(pool,{...scope,runExecutionId:warmExecution},async()=>undefined);
   await flushPerformanceTraces(pool,5000);
   assert.equal((await pool.query('SELECT complete FROM bb_performance_sessions WHERE run_execution_id=$1',[warmExecution])).rows[0].complete,true);
   await blocker.query('BEGIN');locked=true;
   await blocker.query('SELECT id FROM bb_runs WHERE id=$1 FOR UPDATE',[run]);
   const execution=randomUUID();let flushSettled=false;
   const business=withPerformanceTrace(pool,{...scope,runExecutionId:execution},async()=>{
    // Start the real writer while the callback is running, but never await it here.
    blockedFlush=flushPerformanceTraces(pool,2000);
    void blockedFlush.then(()=>{flushSettled=true;});
    return withPerformanceSpan('stage.execute',{stage:'input_lock'},async()=>'business-result');
   });
   const outcome=await Promise.race([business,new Promise<never>((_,reject)=>{
    callbackTimer=setTimeout(()=>reject(Error('business callback waited for the advisory writer')),2000);
   })]);
   clearTimeout(callbackTimer);callbackTimer=undefined;
   assert.equal(outcome,'business-result');
   assert.equal(flushSettled,false,'business callback finishes while its independent flush is still pending');
   // Keep the real FOR UPDATE lock longer than the unchanged 250ms writer limit.
   await blocker.query('SELECT pg_sleep(0.6)');
   await blockedFlush;
   await blocker.query('ROLLBACK');locked=false;
   await flushPerformanceTraces(pool,5000);
   const sessions=(await pool.query('SELECT * FROM bb_performance_sessions WHERE run_execution_id=$1',[execution])).rows;
   assert.equal(sessions.length,1);
   const session=sessions[0];
   const spans=(await pool.query('SELECT * FROM bb_performance_spans WHERE session_id=$1',[session.session_id])).rows;
   assert.equal(spans.length,2);
   assert.deepEqual(spans.map(row=>row.step_key).sort(),['run.execution','stage.execute']);
   assert(spans.every(row=>row.status==='succeeded'&&row.ended_at!==null&&row.duration_ms!==null&&row.duration_ms>=0));
   assert.equal(session.worker_instance_id,'synthetic-worker');assert.equal(session.closed,true);
   assert.equal(session.generated,spans.length);assert.equal(session.acknowledged,spans.length);
   assert.equal(session.dropped,0);assert.equal(session.invalid_attributes,0);
   assert(session.flush_errors>0,'the timed-out FK check remains visible after every span is retried');
   assert.equal(session.complete,false);assert.equal(session.complete,session.flush_errors===0);
  }finally{
   if(callbackTimer)clearTimeout(callbackTimer);
   if(locked)await blocker.query('ROLLBACK').catch(()=>{});
   blocker.release();
   await blockedFlush;
   await flushPerformanceTraces(pool,1000);await pool.end();
  }
 });
