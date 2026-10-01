import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { autoTestExecutionKeyStorage, azureBlobs, digest, transaction } from './data.js';
import { claim } from './queue.js';
import { recordLogicalJob } from './observability.js';
import { isolatedTestDatabase } from './test-database.js';

const databaseUrl = await isolatedTestDatabase(undefined, 'direct-execute-admission');
const connection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const origin = 'http://bondbuddy.test';

test('expired service window and incomplete business evidence admit one durable owner-scoped run',
  { skip: !databaseUrl || !connection }, async () => {
    const names = ['BB_DEPLOYMENT_TIER','BB_NON_PRODUCTION_TEST_CHANNEL',
      'BB_PREPROD_WORKING_DRAFT_EXPIRES_AT','BB_PREPROD_WORKING_DRAFT_STAGE',
      'BB_PREPROD_WORKING_DRAFT_AS_OF','BB_PREPROD_WORKING_DRAFT_TAXONOMY_HASH',
      'BB_PREPROD_WORKING_DRAFT_RULE_PACK_HASH'] as const;
    const saved = names.map(name => process.env[name]);
    process.env.BB_DEPLOYMENT_TIER = 'preprod';
    process.env.BB_NON_PRODUCTION_TEST_CHANNEL = 'enabled';
    process.env.BB_PREPROD_WORKING_DRAFT_EXPIRES_AT = new Date(0).toISOString();
    process.env.BB_PREPROD_WORKING_DRAFT_STAGE = 'issuance';
    process.env.BB_PREPROD_WORKING_DRAFT_AS_OF = '2026-09-29';
    process.env.BB_PREPROD_WORKING_DRAFT_TAXONOMY_HASH = 'a'.repeat(64);
    process.env.BB_PREPROD_WORKING_DRAFT_RULE_PACK_HASH = 'b'.repeat(64);
    const pool = new Pool({ connectionString: databaseUrl });
    const blobs = azureBlobs(connection!, `bb-direct-${randomUUID().replaceAll('-','')}`);
    let owner = `direct-${randomUUID()}`;
    const app = createServer({ pool, blobs, allowedOrigin: origin,
      principal: async () => ({ userId: owner, csrfVerified: true }), enableSyntheticQueue: true });
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: { origin }, payload: payload as any });
    try {
      const created = await post('/api/v1/projects', { name: 'Synthetic direct admission', kind: 'update',
        issuer_name: null, market: null, offering: null });
      assert.equal(created.statusCode, 201, created.body);
      const project = created.json().project_id;
      const lock = await post(`/api/v1/projects/${project}/input-revisions`,
        { draft_revision: 1, material_versions: [], requirement_message_ids: [] });
      assert.equal(lock.statusCode, 201, lock.body);
      const input = lock.json();
      // Preserve an expired legacy grant as evidence; admission must not mutate it.
      const legacy = randomUUID();
      await pool.query(`INSERT INTO bb_non_production_test_grants
        (grant_id,user_id,project_id,input_revision,input_hash,sample_manifest_sha256,taxonomy_hash,
         rule_pack_hash,granted_by,reason,created_at,expires_at)
        VALUES($1,$2,$3,1,$4,$5,$5,$5,'preprod_service','legacy synthetic',now()-interval '2 days',now()-interval '1 day')`,
      [legacy,owner,project,input.input_hash,'a'.repeat(64)]);
      const checked = await post(`/api/v1/projects/${project}/preflight`,
        { input_revision: 1, input_hash: input.input_hash });
      assert.equal(checked.statusCode, 200, checked.body);
      assert.equal(checked.json().status, 'needs_confirmation');
      assert.deepEqual(checked.json().blocking_inputs, []);
      assert.ok(checked.json().advisory_inputs.includes('target_market_offering_required'));
      const key = `web-update-${digest(JSON.stringify([project,1,input.input_hash]))}`;
      const request = { execution_request_id: key, project_id: project, input_revision: 1, input_hash: input.input_hash,
        task_kind: 'update', input_manifest_ref: 'synthetic', storage_origin: 'cloud', workspace_id: 'synthetic',
        user_prompt: 'Synthetic supplement: preserve unresolved evidence for confirmation' };
      const requestHash = digest(JSON.stringify({project_id:project,input_revision:1,input_hash:input.input_hash,
        task_kind:'update',input_manifest_ref:'synthetic',storage_origin:'cloud',workspace_id:'synthetic',
        user_prompt_sha256:digest(request.user_prompt)}));
      const rejected = await transaction(pool,client=>recordLogicalJob(client,{owner,projectId:project,
        requestId:randomUUID(),traceId:randomUUID(),kind:'execute',jobType:'update',status:'rejected',
        errorCode:'TEST_GRANT_EXPIRED',inputRevision:1,inputHash:input.input_hash,stage:'submission_rejected',
        executionRequestId:autoTestExecutionKeyStorage(key),requestHash,httpStatus:409,channel:'non_production_test'}));
      const changedRetry = await post('/api/v1/runs/execute',{...request,user_prompt:'Synthetic changed supplement'});
      assert.equal(changedRetry.statusCode,409,changedRetry.body);
      assert.equal(changedRetry.json().code,'IDEMPOTENCY_CONFLICT');
      const results = await Promise.all(Array.from({ length: 3 }, () => post('/api/v1/runs/execute', request)));
      for (const response of results) assert.equal(response.statusCode, 202, response.body);
      const run = results[0]!.json();
      assert.ok(results.every(response => response.json().run_id === run.run_id));
      assert.equal(run.channel, 'non_production_test');
      assert.equal((await pool.query('SELECT state,error_code FROM bb_jobs WHERE id=$1',[rejected.jobId])).rows[0].error_code,'TEST_GRANT_EXPIRED');
      assert.equal(run.state, 'queued');
      assert.notEqual(run.test_grant_id, legacy);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1',[project])).rows[0].n,1);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_jobs WHERE run_id=$1',[run.run_id])).rows[0].n,1);
      assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_id=$1 AND event_type='run.state_changed'",[run.run_id])).rows[0].n,1);
      assert.equal((await pool.query('SELECT expires_at<now() expired FROM bb_non_production_test_grants WHERE grant_id=$1',[legacy])).rows[0].expired,true);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_operations WHERE run_id=$1 AND operation_kind=\'execute\' AND status=\'submitted\'',[run.run_id])).rows[0].n,3);
      const events = await app.inject({ method: 'GET', url: `/api/v1/runs/${run.run_id}/events`, headers: { origin } });
      assert.equal(events.statusCode,200,events.body);
      assert.equal(events.json().items[0].state,'queued');
      assert.equal((await claim(pool, 30))?.runId, run.run_id,
        'an expired configuration must not immediately park the queued job at test_grant_invalid');
      const wrongHash = await post('/api/v1/runs/execute', { ...request, execution_request_id: randomUUID(), input_hash: 'f'.repeat(64) });
      assert.equal(wrongHash.statusCode,409,wrongHash.body);
      assert.equal(wrongHash.json().code,'INPUT_REVISION_CONFLICT');
      owner = `foreign-${randomUUID()}`;
      assert.equal((await post(`/api/v1/projects/${project}/preflight`,{input_revision:1,input_hash:input.input_hash})).statusCode,404);
      assert.equal((await post('/api/v1/runs/execute',{...request,execution_request_id:randomUUID()})).statusCode,404);
      assert.equal((await app.inject({method:'GET',url:`/api/v1/runs/${run.run_id}`,headers:{origin}})).statusCode,404);
      const anonymous = createServer({pool,blobs,allowedOrigin:origin,enableSyntheticQueue:true});
      try { assert.equal((await anonymous.inject({method:'POST',url:'/api/v1/runs/execute',headers:{origin},payload:request})).statusCode,401); }
      finally { await anonymous.close(); }
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_artifact_versions WHERE run_id=$1',[run.run_id])).rows[0].n,0);
    } finally {
      await app.close(); await pool.end();
      names.forEach((name,index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
    }
  });
