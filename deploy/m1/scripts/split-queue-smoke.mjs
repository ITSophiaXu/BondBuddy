// SYNTHETIC ONLY: invoked by split-deploy.integration.mjs inside the execution container.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createServer } from '../../../apps/api/dist/server.js';
import { claim, renew, pauseRun } from '../../../apps/api/dist/queue.js';
const pool=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000});
let app;
try {
 assert.equal((await pool.query('SHOW cluster_name')).rows[0].cluster_name,'bb907-synthetic');
 const before=(await pool.query('SELECT count(*)::int n FROM bb_schema_migrations')).rows[0].n;
 const owner=`split-${randomUUID()}`,origin='http://bondbuddy.test';
 app=createServer({pool,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true});
 const send=(method,url,payload)=>app.inject({method,url,headers:{origin},payload});
 const p=await send('POST','/api/v1/projects',{name:'Synthetic split queue',kind:'update',issuer_name:null,market:null,offering:null});
 assert.equal(p.statusCode,201,p.body); const id=p.json().project_id;
 const input=await send('POST',`/api/v1/projects/${id}/input-revisions`,{draft_revision:1,material_versions:[],requirement_message_ids:[]});
 assert.equal(input.statusCode,201,input.body);
 const submitted=await send('POST','/api/v1/runs/execute',{execution_request_id:randomUUID(),project_id:id,input_revision:1,input_hash:input.json().input_hash,
  task_kind:'update',input_manifest_ref:'synthetic',storage_origin:'cloud',workspace_id:'synthetic'});
 assert.equal(submitted.statusCode,202,submitted.body);
 const lease=await claim(pool,30,{runKinds:['update']});assert.ok(lease);assert.equal(lease.runId,submitted.json().run_id);
 const expires=(await pool.query('SELECT lease_until FROM bb_jobs WHERE id=$1',[lease.jobId])).rows[0].lease_until;
 await renew(pool,lease,60);
 const renewed=(await pool.query('SELECT lease_until FROM bb_jobs WHERE id=$1',[lease.jobId])).rows[0].lease_until;
 assert.ok(renewed.getTime()>expires.getTime());assert.equal(await claim(pool,30,{runKinds:['update']}),null);
 await assert.rejects(renew(pool,{...lease,token:randomUUID()},60),/Lease is no longer active/);
 await pauseRun(pool,lease,'awaiting_materials','synthetic_split_test');
 assert.equal((await pool.query('SELECT count(*)::int n FROM bb_schema_migrations')).rows[0].n,before,'execution never migrates');
 assert.equal((await pool.query("SELECT count(*)::int n FROM bb_jobs WHERE state='running'")).rows[0].n,0);
 console.log('PASS execution container: API submission, PG task claim, lease renewal, duplicate claim exclusion, stale-token rejection, durable pause, no migration');
} finally {await app?.close();await pool.end();}
