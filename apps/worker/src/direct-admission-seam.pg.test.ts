import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import type { PrivateBlobs } from '@bondbuddy/api/data';
import { inputLockStage, runPipelineOnce } from './run-pipeline.js';
import { isolatedTestDatabase } from './test-database.js';

const databaseUrl = await isolatedTestDatabase(undefined, 'direct-admission-seam');
test('an admitted empty draft exposes the exact remaining issuer-binding dependency after durable creation',
  { skip: !databaseUrl }, async () => {
    const names = ['BB_DEPLOYMENT_TIER','BB_NON_PRODUCTION_TEST_CHANNEL','BB_PREPROD_WORKING_DRAFT_EXPIRES_AT'] as const;
    const saved = names.map(name => process.env[name]);
    process.env.BB_DEPLOYMENT_TIER = 'preprod';
    process.env.BB_NON_PRODUCTION_TEST_CHANNEL = 'enabled';
    process.env.BB_PREPROD_WORKING_DRAFT_EXPIRES_AT = new Date(0).toISOString();
    const pool = new Pool({ connectionString: databaseUrl });
    const owner = `seam-${randomUUID()}`, origin = 'http://bondbuddy.test';
    const app = createServer({pool,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true}),enableRunRuntime:true});
    const post=(url:string,payload:unknown)=>app.inject({method:'POST',url,headers:{origin},payload:payload as any});
    try {
      const project = await post('/api/v1/projects',{name:'Synthetic dependency',kind:'update',issuer_name:null,market:null,offering:null});
      assert.equal(project.statusCode,201,project.body);
      const id=project.json().project_id;
      const locked = await post(`/api/v1/projects/${id}/input-revisions`,{draft_revision:1,material_versions:[],requirement_message_ids:[]});
      assert.equal(locked.statusCode,201,locked.body);
      const input=locked.json();
      const submitted=await post('/api/v1/runs/execute',{execution_request_id:randomUUID(),project_id:id,input_revision:1,
        input_hash:input.input_hash,task_kind:'update',input_manifest_ref:'synthetic',storage_origin:'cloud',workspace_id:'synthetic'});
      assert.equal(submitted.statusCode,202,submitted.body);
      const runId=submitted.json().run_id;
      assert.equal(await runPipelineOnce({pool,blobs:{} as PrivateBlobs,stages:[inputLockStage]}),'paused');
      const event=(await pool.query("SELECT state,stage,payload FROM bb_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1",[runId])).rows[0];
      assert.equal(event.state,'paused');
      assert.equal(event.stage,'capability_not_ready');
      assert.equal(event.payload.reason,'historical_material_not_selected');
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id WHERE j.run_id=$1',[runId])).rows[0].n,0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_artifact_versions WHERE run_id=$1',[runId])).rows[0].n,0);
    } finally {
      await app.close();await pool.end();
      names.forEach((name,index)=>{if(saved[index]===undefined)delete process.env[name];else process.env[name]=saved[index];});
    }
  });
