import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {Pool} from 'pg';
import {beginRunStage,checkpointStage,claim,enqueue} from './queue.js';
import {collectAdminInspection} from './admin-inspection-data.js';
import {isolatedTestDatabase} from './test-database.js';
import {transaction} from './data.js';

const connection=await isolatedTestDatabase(undefined,'stage-timing');
test('stage durations persist with outbox, survive long pauses and reach the scalar inspection snapshot',{skip:!connection,timeout:60000},async()=>{
 const pool=new Pool({connectionString:connection}),owner='stage-timing-'+randomUUID();
 // An already accepted synthetic legacy run isolates event persistence from upload, pricing and model workflows.
 const projectId=randomUUID(),runId=randomUUID(),hash='a'.repeat(64);
 try{
  await transaction(pool,async client=>{
   await client.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'stage_timing']);
   await client.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic stage timing','update')",[projectId,owner]);
   await client.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')",[projectId,owner,hash]);
   const run=(await client.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'update',$4,'queued') RETURNING *",[runId,owner,projectId,hash])).rows[0];
   await enqueue(client,run);
  });
  const lease=await claim(pool,60);assert.ok(lease);assert.equal(lease.runId,runId);
  const ageLatest=async(stage:string,seconds:number)=>pool.query("UPDATE bb_run_events SET occurred_at=now()-($3::int*interval '1 second') WHERE id=(SELECT id FROM bb_run_events WHERE run_id=$1 AND stage=$2 AND payload->>'reason'='stage_started' ORDER BY seq DESC LIMIT 1)",[runId,stage,seconds]);
  const complete=async(stage:string)=>{
   await checkpointStage(pool,lease,stage,{synthetic:true});
   const result=(await pool.query("SELECT id,seq,payload FROM bb_run_events WHERE run_id=$1 AND stage=$2 AND payload->>'reason'='stage_completed' ORDER BY seq DESC LIMIT 1",[runId,stage])).rows[0];
   const outbox=(await pool.query("SELECT payload FROM bb_outbox WHERE aggregate_id=$1 AND payload->>'event_id'=$2",[runId,result.id])).rows[0];
   assert.equal(outbox.payload.duration_ms,result.payload.duration_ms);
   assert.equal(outbox.payload.reason,'stage_completed');
   return result;
  };
  await beginRunStage(pool,lease,'input_lock');await ageLatest('input_lock',2);
  const normal=await complete('input_lock');assert.ok(normal.payload.duration_ms>=2000&&normal.payload.duration_ms<15000);
  await beginRunStage(pool,lease,'long_pause');await ageLatest('long_pause',30*86400);
  const long=await complete('long_pause');assert.ok(long.payload.duration_ms>=30*86400*1000);
  assert.equal(Number.isSafeInteger(long.payload.duration_ms),true);
  await beginRunStage(pool,lease,'restarted');await ageLatest('restarted',30*86400);
  await beginRunStage(pool,lease,'restarted');await ageLatest('restarted',1);
  const latest=await complete('restarted');assert.ok(latest.payload.duration_ms>=1000&&latest.payload.duration_ms<15000);
  const missing=await complete('legacy_without_start');assert.equal(Object.hasOwn(missing.payload,'duration_ms'),false);
  await beginRunStage(pool,lease,'incomplete');
  await checkpointStage(pool,lease,'incomplete',{synthetic:true},false);
  assert.equal((await pool.query("SELECT count(*)::int n FROM bb_run_events WHERE run_id=$1 AND stage='incomplete' AND payload->>'reason'='stage_completed'",[runId])).rows[0].n,0);
  await assert.rejects(checkpointStage(pool,{...lease,owner:'foreign-owner'},'foreign',{}));
  assert.equal((await pool.query("SELECT count(*)::int n FROM bb_run_events WHERE run_id=$1 AND stage='foreign'",[runId])).rows[0].n,0);

  const snapshot=await collectAdminInspection(pool,'synthetic_test');
  const events=snapshot.tables.find(t=>t.name==='bb_run_events')!.rows;
  const exported=events.find(e=>e.id===normal.id)!;
  assert.equal(exported.reason,'stage_completed');assert.equal(Number(exported.duration_ms),normal.payload.duration_ms);
  assert.equal(Object.hasOwn(exported,'payload'),false,'inspection keeps its scalar allowlist');
  assert.equal(events.find(e=>e.id===missing.id)!.duration_ms,null);
  assert.equal(Number(events.find(e=>e.id===long.id)!.duration_ms),long.payload.duration_ms);
 }finally{await pool.end();}
});
