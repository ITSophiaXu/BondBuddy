import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {Pool} from 'pg';
import {createServer} from './server.js';
import {beginRunStage,checkpointStage,claim} from './queue.js';
import {collectAdminInspection} from './admin-inspection-data.js';
import {isolatedTestDatabase} from './test-database.js';
import {uploadSyntheticReference} from './test-authoring-source.js';
import type {PrivateBlobs} from './data.js';

const connection=await isolatedTestDatabase(undefined,'stage-timing');
test('stage durations persist with outbox, survive long pauses and reach the scalar inspection snapshot',{skip:!connection,timeout:60000},async()=>{
 const pool=new Pool({connectionString:connection}),owner='stage-timing-'+randomUUID();
 const files=new Map<string,Buffer>();
 const blobs:PrivateBlobs={put:async(k,b)=>{files.set(k,Buffer.from(b));},get:async k=>files.get(k)!,
  getIfExists:async k=>files.get(k)??null,getIfExistsBounded:async k=>files.get(k)??null,exists:async k=>files.has(k),delete:async k=>{files.delete(k);}};
 const origin='http://bondbuddy.test';
 const app=createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true});
 const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,payload:payload as any,headers:{origin}});
 try{
  const project=await send('POST','/api/v1/projects',{name:'Synthetic stage timing',kind:'update',issuer_name:null,market:'sse',offering:'private'});
  assert.equal(project.statusCode,201,project.body);
  const projectId=project.json().project_id,reference=await uploadSyntheticReference(app,projectId);
  const input=await send('POST','/api/v1/projects/'+projectId+'/input-revisions',reference);
  assert.equal(input.statusCode,201,input.body);
  const submitted=await send('POST','/api/v1/runs/execute',{execution_request_id:randomUUID(),project_id:projectId,input_revision:input.json().input_revision,
   input_hash:input.json().input_hash,task_kind:'update',input_manifest_ref:'synthetic-stage-timing',storage_origin:'cloud',workspace_id:'synthetic'});
  assert.equal(submitted.statusCode,202,submitted.body);
  const runId=submitted.json().run_id,lease=await claim(pool,60);assert.ok(lease);assert.equal(lease.runId,runId);
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
 }finally{await app.close();await pool.end();}
});
