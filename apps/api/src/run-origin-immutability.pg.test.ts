// Synthetic PostgreSQL origin/queue regression. No provider, payment or Blob calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { isolatedTestDatabase } from './test-database.js';
import { createServer } from './server.js';
import { checkpoint, claim, finish, pauseRun, recordPotentialCall, resolvePotentialCall } from './queue.js';
import { inputManifestHash } from './production-rule-pin.js';

const connection=await isolatedTestDatabase(undefined,'run-origin-immutability');

test('run origin rejects identity replacement while queue progress and original execution replay remain usable',{skip:!connection},async t=>{
  const pool=new Pool({connectionString:connection}),owner=`synthetic-origin-${randomUUID()}`,origin='http://bondbuddy.test';
  const app=createServer({pool,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin},payload:payload as any});
  const good=(response:{statusCode:number;body:string})=>assert.ok(response.statusCode>=200&&response.statusCode<300,response.body);
  try{
    const created=await send('POST','/api/v1/projects',{name:'Synthetic origin',kind:'update',issuer_name:null,market:null,offering:null});good(created);
    const project=created.json().project_id;
    const locked=await send('POST',`/api/v1/projects/${project}/input-revisions`,{draft_revision:1,material_versions:[],requirement_message_ids:[]});good(locked);
    const input=locked.json(),request={execution_request_id:randomUUID(),project_id:project,input_revision:input.input_revision,input_hash:input.input_hash,
      task_kind:'update',input_manifest_ref:'synthetic',storage_origin:'cloud',workspace_id:'synthetic'};
    const accepted=await send('POST','/api/v1/runs/execute',request);good(accepted);
    const runId=accepted.json().run_id,lease=await claim(pool,30);assert.ok(lease);assert.equal(lease.runId,runId);
    await checkpoint(pool,lease,'synthetic_saved',{saved_work:'synthetic-original-input'});
    await recordPotentialCall(pool,lease,'synthetic-origin-call',1);
    await resolvePotentialCall(pool,lease,'synthetic-origin-call',1,'confirmed_not_sent');
    await pauseRun(pool,lease,'awaiting_materials','synthetic_materials_pending');

    // This is another valid, immutable project input. A run may not silently be
    // rebound to it even though its owner/project/revision foreign key is valid.
    const nextManifest={synthetic:'successor'},nextHash=inputManifestHash(nextManifest);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,2,$2,1,$3,$4,'[]','[]')`,[project,owner,nextHash,nextManifest]);
    const otherProject=randomUUID();
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic other project','update')",[otherProject,owner]);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,'{}','[]','[]')`,[otherProject,owner,inputManifestHash({})]);
    const evidence=async()=>({
      run:(await pool.query('SELECT * FROM bb_runs WHERE id=$1',[runId])).rows,
      job:(await pool.query('SELECT * FROM bb_jobs WHERE run_id=$1',[runId])).rows,
      attempts:(await pool.query('SELECT * FROM bb_model_call_attempts WHERE job_id=$1 ORDER BY id',[lease.jobId])).rows,
      events:(await pool.query('SELECT * FROM bb_run_events WHERE run_id=$1 ORDER BY seq',[runId])).rows,
      outbox:(await pool.query('SELECT * FROM bb_outbox WHERE aggregate_id=$1 ORDER BY id',[runId])).rows,
    });
    const before=await evidence();
    const changes=[
      {name:'business run id',sql:'id=$2',values:[randomUUID()]},
      {name:'owner',sql:'owner_user_id=$2',values:[`synthetic-foreign-${randomUUID()}`]},
      {name:'project',sql:'project_id=$2',values:[otherProject]},
      {name:'input revision',sql:'input_revision=$2',values:[2]},
      {name:'input hash',sql:'input_hash=$2',values:[nextHash]},
      {name:'execution request id',sql:'execution_request_id=$2',values:[randomUUID()]},
      {name:'request hash',sql:'request_hash=$2',values:['e'.repeat(64)]},
      {name:'valid successor input pair',sql:'input_revision=$2,input_hash=$3',values:[2,nextHash]},
    ];
    for(const change of changes)await t.test(change.name,async()=>{
      await assert.rejects(pool.query(`UPDATE bb_runs SET ${change.sql} WHERE id=$1`,[runId,...change.values]),
        (error:unknown)=>(error as {code?:string}).code==='23514'&&(error as {constraint?:string}).constraint==='bb_run_origin_immutable');
      assert.deepEqual(await evidence(),before,'a rejected origin replacement cannot change work or execution evidence');
    });
    await pool.query(`UPDATE bb_runs SET id=id,owner_user_id=owner_user_id,project_id=project_id,input_revision=input_revision,
      input_hash=input_hash,execution_request_id=execution_request_id,request_hash=request_hash WHERE id=$1`,[runId]);
    assert.deepEqual(await evidence(),before,'same-value origin updates remain compatible');

    const replay=await send('POST','/api/v1/runs/execute',request);good(replay);
    assert.equal(replay.json().run_id,runId);assert.equal(replay.json().input_revision,input.input_revision);assert.equal(replay.json().input_hash,input.input_hash);
    const resumed=await send('POST',`/api/v1/runs/${runId}/resume`,{reason:'synthetic'});good(resumed);
    const continued=await claim(pool,30);assert.ok(continued);assert.equal(continued.runId,runId);
    assert.deepEqual(continued.checkpoint,{saved_work:'synthetic-original-input',stage_execution:{execution_version:1,input_revision:input.input_revision,input_hash:input.input_hash}});
    await finish(pool,continued,'failed',{errorCode:'VALIDATION_FAILED',failedStage:'synthetic_cleanup'});
    const final=(await pool.query('SELECT * FROM bb_runs WHERE id=$1',[runId])).rows[0],initial=before.run[0];
    for(const field of ['id','owner_user_id','project_id','input_revision','input_hash','execution_request_id','request_hash'])
      assert.equal(final[field],initial[field],`${field} survives pause, resume and terminal settlement`);
    assert.equal(final.state,'failed');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM bb_model_call_attempts WHERE job_id=$1',[lease.jobId])).rows[0].n,1);
  }finally{await app.close();await pool.end();}
});
