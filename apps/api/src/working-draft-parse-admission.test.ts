import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { autoTestExecutionKeyStorage, digest } from './data.js';
import { executionKeyHash } from './observability.js';
import { documentParserVersion } from './material-jobs.js';
import { isolatedTestDatabase } from './test-database.js';

const databaseUrl = await isolatedTestDatabase('BB_TEST_CHANNEL_DATABASE_URL', 'working-draft-parse-admission');
const origin = 'http://bondbuddy.test';
const sha = (letter: string) => letter.repeat(64);

test('locked materials enter the draft queue before parsing and business review; security pins and channel isolation remain enforced',
  { skip: !databaseUrl }, async () => {
    const names = ['BB_DEPLOYMENT_TIER', 'BB_NON_PRODUCTION_TEST_CHANNEL', 'BB_PREPROD_WORKING_DRAFT_EXPIRES_AT',
      'BB_PREPROD_WORKING_DRAFT_TAXONOMY_HASH', 'BB_PREPROD_WORKING_DRAFT_RULE_PACK_HASH',
      'BB_PREPROD_WORKING_DRAFT_STAGE', 'BB_PREPROD_WORKING_DRAFT_AS_OF'] as const;
    const before = names.map(name => process.env[name]);
    process.env.BB_DEPLOYMENT_TIER = 'preprod';
    process.env.BB_NON_PRODUCTION_TEST_CHANNEL = 'enabled';
    process.env.BB_PREPROD_WORKING_DRAFT_EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();
    process.env.BB_PREPROD_WORKING_DRAFT_TAXONOMY_HASH = sha('a');
    process.env.BB_PREPROD_WORKING_DRAFT_RULE_PACK_HASH = sha('b');
    process.env.BB_PREPROD_WORKING_DRAFT_STAGE = 'issuance';
    process.env.BB_PREPROD_WORKING_DRAFT_AS_OF = '2026-09-29';
    const pool = new Pool({ connectionString: databaseUrl });
    let owner = `parse-owner-${randomUUID()}`;
    const app = createServer({ pool, allowedOrigin: origin,
      principal: async () => ({ userId: owner, csrfVerified: true }), enableSyntheticQueue: true });
    const post = (url: string, payload: unknown) =>
      app.inject({ method: 'POST', url, headers: { origin }, payload: payload as any });
    try {
      const created = await post('/api/v1/projects',
        { name: 'Synthetic parse admission', kind: 'update', issuer_name: null, market: null, offering: null });
      assert.equal(created.statusCode, 201, created.body);
      const project = created.json().project_id as string;
      const add = async (role: 'historical' | 'interimFinancial', hash: string,
        parse: 'succeeded' | 'queued' | 'running' | 'paused' | 'failed' | 'absent' = 'succeeded', parserVersion = documentParserVersion()) => {
        const id = randomUUID(), upload = randomUUID();
        const media = role === 'historical'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        await pool.query(`INSERT INTO bb_uploads
          (id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
          VALUES($1,$2,$3,'synthetic',$4,20,$5,$6,$7,now()+interval '1 day','completed')`,
        [upload, owner, project, media, hash, role, `synthetic/${upload}`]);
        await pool.query(`INSERT INTO bb_material_versions
          (id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
          VALUES($1,1,$2,$3,$4,$5,'synthetic',$6,20,$7,$8,'persisted')`,
        [id, owner, project, upload, role, media, hash, `users/${owner}/projects/${project}/materials/${id}`]);
        if (parse !== 'absent') await pool.query(`INSERT INTO bb_jobs
          (id,owner_user_id,run_id,job_type,subtype,state,project_id,material_id,material_version,
           material_sha256,parser_version,trace_id,max_attempts,result,error_code)
          VALUES($1,$2,NULL,'parse','material_parse',$3,$4,$5,1,$6,$7,$8,3,$9,$10)`,
        [randomUUID(), owner, parse, project, id, hash, parserVersion, randomUUID(),
          parse === 'succeeded'
            ? { outcome: 'needs_confirmation', parse_status: 'needs_confirmation', profile_version: null, pending_capabilities: [] }
            : null, parse === 'failed' ? 'MATERIAL_UNREADABLE' : null]);
        return { material_id: id, material_version: 1 };
      };
      const lock = async (refs: { material_id: string; material_version: number }[]) => {
        const response = await post(`/api/v1/projects/${project}/input-revisions`,
          { draft_revision: 1, material_versions: refs, requirement_message_ids: [] });
        assert.equal(response.statusCode, 201, response.body);
        const input = response.json() as { input_revision: number; input_hash: string };
        return { input_revision: input.input_revision, input_hash: input.input_hash };
      };
      const preflight = (input: { input_revision: number; input_hash: string }) =>
        post(`/api/v1/projects/${project}/preflight`, input);
      const execute = (input: { input_revision: number; input_hash: string }) =>
        post('/api/v1/runs/execute', { execution_request_id: randomUUID(), project_id: project,
          input_revision: input.input_revision, input_hash: input.input_hash, task_kind: 'update',
          input_manifest_ref: 'synthetic', storage_origin: 'cloud', workspace_id: 'synthetic' });
      const counts = async () => {
        const [grants, events, runs] = await Promise.all([
          pool.query('SELECT count(*)::int AS n FROM bb_non_production_test_grants WHERE user_id=$1 AND project_id=$2', [owner, project]),
          pool.query("SELECT count(*)::int AS n FROM bb_outbox WHERE owner_user_id=$1 AND aggregate_type='test_grant'", [owner]),
          pool.query('SELECT count(*)::int AS n FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2', [owner, project]),
        ]);
        return [grants.rows[0].n, events.rows[0].n, runs.rows[0].n];
      };
      const rejectionAudit=async(requestId:string)=>(await pool.query(`SELECT o.owner_user_id,o.project_id,
        o.channel AS operation_channel,e.channel AS event_channel,o.error_code
        FROM bb_operations o JOIN bb_observability_events e
          ON e.owner_user_id=o.owner_user_id AND e.event->>'operation_id'=o.id
        WHERE o.owner_user_id=$1 AND o.request_id=$2 AND e.kind='operation.rejected'`,
        [owner,requestId])).rows[0];
      let accepted = 0;
      const historical = await add('historical', sha('c'));
      for (const [label, hashLetter, state, parser, code, message] of [
        ['missing', '3', 'absent', documentParserVersion(), 'INPUT_REQUIRED', /complete its saved upload again/i],
        ['queued', '4', 'queued', documentParserVersion(), 'CAPABILITY_NOT_READY', /parsing is pending/i],
        ['running', '9', 'running', documentParserVersion(), 'CAPABILITY_NOT_READY', /parsing is pending/i],
        ['paused', '7', 'paused', documentParserVersion(), 'CAPABILITY_NOT_READY', /parsing is pending/i],
        ['failed', '5', 'failed', documentParserVersion(), 'MATERIAL_UNREADABLE', /no successful parse/i],
        ['wrong-parser', '6', 'succeeded', `${documentParserVersion()}-old`, 'INPUT_REQUIRED', /complete its saved upload again/i],
      ] as const) {
        const financial = await add('interimFinancial', sha(hashLetter), state, parser);
        const input = await lock([historical, financial]);
        const checked = await preflight(input), submitted = await execute(input);
        assert.equal(checked.statusCode, 200, `${label}: ${checked.body}`);
        assert.notEqual(checked.json().status, 'blocked');
        assert.equal(submitted.statusCode, 202, `${label}: ${submitted.body}`);
        accepted++;
        assert.deepEqual(await counts(), [accepted, accepted, accepted], label);
      }

      const wrongHash = await add('interimFinancial', sha('e'));
      await pool.query('UPDATE bb_material_versions SET sha256=$2 WHERE id=$1', [wrongHash.material_id, sha('f')]);
      const wrongHashInput = await lock([historical, wrongHash]);
      assert.equal((await preflight(wrongHashInput)).statusCode, 200);
      assert.equal((await execute(wrongHashInput)).statusCode, 202);
      accepted++;
      assert.deepEqual(await counts(), [accepted, accepted, accepted]);

      const financial = await add('interimFinancial', sha('1'));
      const deletedInput = await lock([historical, financial]);
      await pool.query('UPDATE bb_material_versions SET deleted_at=now() WHERE id=$1', [financial.material_id]);
      assert.equal((await preflight(deletedInput)).json().code, 'INPUT_REVISION_CONFLICT');
      assert.equal((await execute(deletedInput)).json().code, 'INPUT_REVISION_CONFLICT');
      assert.deepEqual(await counts(), [accepted, accepted, accepted]);

      const otherProjectResponse = await post('/api/v1/projects',
        { name: 'Synthetic other project', kind: 'update', issuer_name: null, market: null, offering: null });
      assert.equal(otherProjectResponse.statusCode, 201, otherProjectResponse.body);
      const otherProject = otherProjectResponse.json().project_id as string;
      const foreignUpload = randomUUID(), foreignMaterial = randomUUID();
      await pool.query(`INSERT INTO bb_uploads
        (id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
        VALUES($1,$2,$3,'synthetic','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',20,$4,
          'interimFinancial',$5,now()+interval '1 day','completed')`,
      [foreignUpload, owner, otherProject, sha('8'), `synthetic/${foreignUpload}`]);
      await pool.query(`INSERT INTO bb_material_versions
        (id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'interimFinancial','synthetic',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',20,$5,$6,'persisted')`,
      [foreignMaterial, owner, otherProject, foreignUpload, sha('8'),
        `users/${owner}/projects/${otherProject}/materials/${foreignMaterial}`]);
      const foreignLock = await post(`/api/v1/projects/${project}/input-revisions`,
        { draft_revision: 1, material_versions: [historical, { material_id: foreignMaterial, material_version: 1 }],
          requirement_message_ids: [] });
      assert.equal(foreignLock.statusCode, 404, foreignLock.body);
      assert.deepEqual(await counts(), [accepted, accepted, accepted]);

      const active = await add('interimFinancial', sha('2'));
      const input = await lock([historical, active]);
      owner = `other-owner-${randomUUID()}`;
      assert.equal((await preflight(input)).statusCode, 404);
      assert.equal((await execute(input)).statusCode, 404);
      owner = (await pool.query('SELECT owner_user_id FROM bb_projects WHERE id=$1', [project])).rows[0].owner_user_id;
      assert.deepEqual(await counts(), [accepted, accepted, accepted]);
      const states = await pool.query('SELECT state FROM bb_material_versions WHERE id=ANY($1)', [[historical.material_id, active.material_id]]);
      assert.deepEqual(states.rows.map(row => row.state), ['persisted', 'persisted']);
      const checked = await preflight(input);
      assert.equal(checked.statusCode, 200, checked.body);
      assert.ok(checked.json().uncertainty.some((item: string) => item.startsWith('material_needs_confirmation:')),
        'a successful parse with unresolved content remains explicitly uncertain');
      const browserKey=`web-update-${digest(JSON.stringify([project,input.input_revision,input.input_hash]))}`;
      const browserRequest={execution_request_id:browserKey,project_id:project,
        input_revision:input.input_revision,input_hash:input.input_hash,task_kind:'update',
        input_manifest_ref:'synthetic',storage_origin:'cloud',workspace_id:'synthetic'};
      const schemaRejected=await post('/api/v1/runs/execute',{...browserRequest,workspace_id:undefined});
      assert.equal(schemaRejected.statusCode,422,schemaRejected.body);
      assert.deepEqual(await rejectionAudit(schemaRejected.json().correlation_id),{
        owner_user_id:owner,project_id:project,operation_channel:'non_production_test',
        event_channel:'non_production_test',error_code:'VALIDATION_FAILED'});
      const submitted = await post('/api/v1/runs/execute',browserRequest);
      assert.equal(submitted.statusCode, 202, submitted.body);
      assert.equal(submitted.json().channel, 'non_production_test');
      assert.ok(submitted.json().test_grant_id);
      assert.equal(submitted.json().execution_request_id,browserKey);
      assert.equal((await pool.query('SELECT execution_request_id FROM bb_runs WHERE id=$1',[submitted.json().run_id])).rows[0].execution_request_id,
        autoTestExecutionKeyStorage(browserKey));
      const replay=await post('/api/v1/runs/execute',browserRequest);
      assert.equal(replay.statusCode,202,replay.body);
      assert.equal(replay.json().run_id,submitted.json().run_id);
      const explicit=await post('/api/v1/runs/execute',{...browserRequest,test_grant_id:submitted.json().test_grant_id});
      assert.equal(explicit.statusCode,422,explicit.body);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',
        [owner,browserKey])).rows[0].n,0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_jobs WHERE owner_user_id=$1 AND execution_request_key_hash=$2',
        [owner,executionKeyHash(browserKey)])).rows[0].n,0);
      assert.deepEqual(await counts(), [accepted + 1, accepted + 1, accepted + 1]);

      const rejectedCreated=await post('/api/v1/projects',
        {name:'Synthetic missing locked materials',kind:'update',issuer_name:null,market:null,offering:null});
      assert.equal(rejectedCreated.statusCode,201,rejectedCreated.body);
      const rejectedProject=rejectedCreated.json().project_id as string;
      const rejectedLocked=await post(`/api/v1/projects/${rejectedProject}/input-revisions`,
        {draft_revision:1,material_versions:[],requirement_message_ids:[]});
      assert.equal(rejectedLocked.statusCode,201,rejectedLocked.body);
      const rejectedInput=rejectedLocked.json();
      const rejectedKey=`web-update-${digest(JSON.stringify([rejectedProject,1,rejectedInput.input_hash]))}`;
      const rejectedRequest={...browserRequest,project_id:rejectedProject,input_revision:1,
        input_hash:rejectedInput.input_hash,execution_request_id:rejectedKey};
      const missingMaterials=await post('/api/v1/runs/execute',rejectedRequest);
      assert.equal(missingMaterials.statusCode,202,missingMaterials.body);
      assert.equal(missingMaterials.json().state,'queued');
      assert.equal(missingMaterials.json().channel,'non_production_test');
      const missingReplay=await post('/api/v1/runs/execute',rejectedRequest);
      assert.equal(missingReplay.statusCode,202,missingReplay.body);
      assert.equal(missingReplay.json().run_id,missingMaterials.json().run_id);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_jobs WHERE owner_user_id=$1 AND execution_request_key_hash=$2',
        [owner,executionKeyHash(rejectedKey)])).rows[0].n,0);

      const legacyCreated=await post('/api/v1/projects',
        {name:'Synthetic existing raw test run',kind:'update',issuer_name:null,market:null,offering:null});
      assert.equal(legacyCreated.statusCode,201,legacyCreated.body);
      const legacyProject=legacyCreated.json().project_id as string;
      const legacyLocked=await post(`/api/v1/projects/${legacyProject}/input-revisions`,
        {draft_revision:1,material_versions:[],requirement_message_ids:[]});
      assert.equal(legacyLocked.statusCode,201,legacyLocked.body);
      const legacyInput=legacyLocked.json();
      const legacyGrant=randomUUID(),legacyRun=randomUUID();
      await pool.query(`INSERT INTO bb_non_production_test_grants
        (grant_id,user_id,project_id,input_revision,input_hash,sample_manifest_sha256,taxonomy_hash,rule_pack_hash,granted_by,reason,expires_at)
        VALUES($1,$2,$3,1,$4,$5,$6,$7,'synthetic-operator','synthetic test',now()+interval '1 hour')`,
        [legacyGrant,owner,legacyProject,legacyInput.input_hash,sha('a'),sha('b'),sha('c')]);
      const legacyKey=`web-update-${digest(JSON.stringify([legacyProject,1,legacyInput.input_hash]))}`;
      const legacyRequest={...browserRequest,project_id:legacyProject,input_revision:1,
        input_hash:legacyInput.input_hash,execution_request_id:legacyKey};
      const legacyHash=digest(JSON.stringify({project_id:legacyProject,input_revision:1,
        input_hash:legacyInput.input_hash,task_kind:'update',input_manifest_ref:'synthetic',
        storage_origin:'cloud',workspace_id:'synthetic'}));
      await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,
        task_kind,request_hash,state,channel,test_grant_id) VALUES($1,$2,$3,1,$4,$5,'update',$6,'paused','non_production_test',$7)`,
        [legacyRun,owner,legacyProject,legacyInput.input_hash,legacyKey,legacyHash,legacyGrant]);
      const legacyReplay=await post('/api/v1/runs/execute',legacyRequest);
      assert.equal(legacyReplay.statusCode,202,legacyReplay.body);
      assert.equal(legacyReplay.json().run_id,legacyRun);

      const disabledCreated=await post('/api/v1/projects',
        {name:'Synthetic staging disabled',kind:'update',issuer_name:null,market:null,offering:null});
      assert.equal(disabledCreated.statusCode,201,disabledCreated.body);
      const disabledProject=disabledCreated.json().project_id as string;
      const disabledLocked=await post(`/api/v1/projects/${disabledProject}/input-revisions`,
        {draft_revision:1,material_versions:[],requirement_message_ids:[]});
      assert.equal(disabledLocked.statusCode,201,disabledLocked.body);
      const disabledInput=disabledLocked.json();
      const disabledKey=`web-update-${digest(JSON.stringify([disabledProject,1,disabledInput.input_hash]))}`;
      const disabledRequest={...browserRequest,project_id:disabledProject,input_revision:1,
        input_hash:disabledInput.input_hash,execution_request_id:disabledKey};
      const stagingOff=createServer({pool,allowedOrigin:origin,
        principal:async()=>({userId:owner,csrfVerified:true}),enableRunStaging:false});
      try{
        const invalid=await stagingOff.inject({method:'POST',url:'/api/v1/runs/execute',headers:{origin},
          payload:{...disabledRequest,workspace_id:undefined}});
        assert.equal(invalid.statusCode,422,invalid.body);
        const unavailable=await stagingOff.inject({method:'POST',url:'/api/v1/runs/execute',headers:{origin},
          payload:disabledRequest});
        assert.equal(unavailable.statusCode,501,unavailable.body);
        assert.equal((await pool.query('SELECT count(*)::int n FROM bb_jobs WHERE owner_user_id=$1 AND execution_request_key_hash=$2',
          [owner,executionKeyHash(disabledKey)])).rows[0].n,0);
        const disabledJob=(await pool.query(`SELECT channel,test_grant_id,state,project_id FROM bb_jobs
          WHERE owner_user_id=$1 AND execution_request_key_hash=$2`,
          [owner,executionKeyHash(autoTestExecutionKeyStorage(disabledKey))])).rows[0];
        assert.deepEqual(disabledJob,{channel:'non_production_test',test_grant_id:null,
          state:'rejected',project_id:disabledProject});
        assert.deepEqual(await rejectionAudit(unavailable.json().correlation_id),{
          owner_user_id:owner,project_id:disabledProject,operation_channel:'non_production_test',
          event_channel:'non_production_test',error_code:'CAPABILITY_NOT_READY'});
      }finally{await stagingOff.close();}

      for(const name of names.filter(name=>name.startsWith('BB_PREPROD_WORKING_DRAFT_')))delete process.env[name];
      const production=await post('/api/v1/runs/execute',browserRequest);
      assert.equal(production.statusCode,202,production.body);
      assert.equal(production.json().channel,'production');
      assert.equal(production.json().execution_request_id,browserKey);
      assert.notEqual(production.json().run_id,submitted.json().run_id);
      const productionAfterRejection=await post('/api/v1/runs/execute',rejectedRequest);
      assert.equal(productionAfterRejection.statusCode,202,productionAfterRejection.body);
      assert.equal(productionAfterRejection.json().channel,'production');
      const crossChannel=await post('/api/v1/runs/execute',legacyRequest);
      assert.equal(crossChannel.statusCode,409,crossChannel.body);
      assert.equal(crossChannel.json().code,'IDEMPOTENCY_CONFLICT');
      owner=`foreign-${randomUUID()}`;
      for(const runId of [submitted.json().run_id,production.json().run_id]){
        const read=await app.inject({method:'GET',url:`/api/v1/runs/${runId}`,headers:{origin}});
        assert.equal(read.statusCode,404,read.body);
      }
    } finally {
      await app.close();
      await pool.end();
      names.forEach((name, index) => {
        if (before[index] === undefined) delete process.env[name];
        else process.env[name] = before[index];
      });
    }
  });
