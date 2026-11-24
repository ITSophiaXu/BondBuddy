import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Pool} from 'pg';
import {createServer} from '@bondbuddy/api';
import {uid,type PrivateBlobs} from '@bondbuddy/api/data';
import {emptyUpdateDetails} from '@bondbuddy/contracts';
import {claim,pauseRun,remainingRunExecutionMs,RUN_ACTIVE_EXECUTION_LIMIT_MS,resumePausedRun} from '@bondbuddy/api/queue';
import {uploadSyntheticAudit,uploadSyntheticReference} from '@bondbuddy/api/test-authoring-source';
import {runPipelineOnce,type RunStage} from './run-pipeline.js';
import {isolatedTestDatabase} from './test-database.js';

const database=await isolatedTestDatabase(undefined,'execution-budget');

test('90-minute execution budget excludes waiting and stops recovered work before model execution',
  {skip:!database,timeout:60000},async()=>{
    const pool=new Pool({connectionString:database});
    const stored=new Map<string,Buffer>();
    const blobs:PrivateBlobs={put:async(key,bytes)=>{stored.set(key,bytes);},get:async key=>stored.get(key)!,getIfExists:async key=>stored.get(key)??null,
      getIfExistsBounded:async key=>stored.get(key)??null,exists:async key=>stored.has(key),delete:async key=>{stored.delete(key);}};
    const owner=`budget-${uid()}`;
    const app=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true});
    const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin:'http://bondbuddy.test'},payload:payload as any});
    try{
      const created=await send('POST','/api/v1/projects',{name:'Synthetic execution budget',kind:'update',issuer_name:'合成企业',market:'sse',offering:'private',update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1'}});
      assert.equal(created.statusCode,201,created.body);
      const project=created.json().project_id;
      const audit=await uploadSyntheticAudit(app,project);
      const material=await uploadSyntheticReference(app,project);
      const input=await send('POST',`/api/v1/projects/${project}/input-revisions`,{...material,material_versions:[...material.material_versions,audit]});
      assert.equal(input.statusCode,201,input.body);
      const started=await send('POST','/api/v1/runs/execute',{execution_request_id:uid(),project_id:project,input_revision:1,input_hash:input.json().input_hash,task_kind:'update',input_manifest_ref:'synthetic',storage_origin:'cloud',workspace_id:'synthetic'});
      assert.equal(started.statusCode,202,started.body);
      const runId=started.json().run_id;
      await pool.query("UPDATE bb_jobs SET created_at=now()-interval '2 hours' WHERE run_id=$1",[runId]);
      const first=await claim(pool);
      assert.equal(first?.runId,runId);
      assert.ok(await remainingRunExecutionMs(pool,first!)>89*60*1000);
      await pool.query('UPDATE bb_jobs SET active_started_at=now()-interval \'20 minutes\' WHERE id=$1',[first!.jobId]);
      const beforePause=await remainingRunExecutionMs(pool,first!);
      assert.ok(beforePause<=70*60*1000 && beforePause>69*60*1000);
      await pauseRun(pool,first!,'awaiting_materials','material_parse_pending');
      const paused=(await pool.query('SELECT active_execution_ms,active_started_at FROM bb_jobs WHERE id=$1',[first!.jobId])).rows[0];
      assert.equal(paused.active_started_at,null);
      await pool.query('UPDATE bb_jobs SET updated_at=now()-interval \'2 hours\' WHERE id=$1',[first!.jobId]);
      await resumePausedRun(pool,owner,runId,'materials_ready');
      await pool.query('UPDATE bb_jobs SET active_execution_ms=$2 WHERE id=$1',[first!.jobId,RUN_ACTIVE_EXECUTION_LIMIT_MS]);
      let modelStarted=false;
      const stage:RunStage={name:'model_generation',run:async()=>{modelStarted=true;return {kind:'fail',code:'DATA_UNAVAILABLE'};}};
      assert.equal(await runPipelineOnce({pool,blobs,stages:[stage]}),'failed');
      assert.equal(modelStarted,false);
      const final=(await pool.query('SELECT state,error_code FROM bb_jobs WHERE id=$1',[first!.jobId])).rows[0];
      assert.deepEqual(final,{state:'failed',error_code:'TASK_EXECUTION_TIME_LIMIT'});
    }finally{await app.close();await pool.end();}
  });
