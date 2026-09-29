import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { documentParserVersion } from './material-jobs.js';
import { isolatedTestDatabase } from './test-database.js';

const databaseUrl = await isolatedTestDatabase('BB_TEST_CHANNEL_DATABASE_URL', 'working-draft-parse-admission');
const origin = 'http://bondbuddy.test';
const sha = (letter: string) => letter.repeat(64);

test('persisted material with an exact successful needs-confirmation parse enters only the controlled draft channel',
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
        for (const response of [checked, submitted]) {
          assert.equal(response.statusCode, 409, `${label}: ${response.body}`);
          assert.equal(response.json().code, code, `${label}: ${response.body}`);
          assert.match(response.json().message, message, `${label}: ${response.body}`);
        }
        assert.deepEqual(await counts(), [0, 0, 0], label);
      }
      const wrongHash = await add('interimFinancial', sha('e'));
      await pool.query('UPDATE bb_material_versions SET sha256=$2 WHERE id=$1', [wrongHash.material_id, sha('f')]);
      const wrongHashInput = await lock([historical, wrongHash]);
      assert.equal((await preflight(wrongHashInput)).json().code, 'MATERIAL_UNREADABLE');
      assert.equal((await execute(wrongHashInput)).json().code, 'MATERIAL_UNREADABLE');
      assert.deepEqual(await counts(), [0, 0, 0]);

      const financial = await add('interimFinancial', sha('1'));
      const deletedInput = await lock([historical, financial]);
      await pool.query('UPDATE bb_material_versions SET deleted_at=now() WHERE id=$1', [financial.material_id]);
      assert.equal((await preflight(deletedInput)).json().code, 'INPUT_REVISION_CONFLICT');
      assert.equal((await execute(deletedInput)).json().code, 'INPUT_REVISION_CONFLICT');
      assert.deepEqual(await counts(), [0, 0, 0]);

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
      assert.deepEqual(await counts(), [0, 0, 0]);

      const active = await add('interimFinancial', sha('2'));
      const input = await lock([historical, active]);
      owner = `other-owner-${randomUUID()}`;
      assert.equal((await preflight(input)).statusCode, 404);
      assert.equal((await execute(input)).statusCode, 404);
      owner = (await pool.query('SELECT owner_user_id FROM bb_projects WHERE id=$1', [project])).rows[0].owner_user_id;
      assert.deepEqual(await counts(), [0, 0, 0]);
      const states = await pool.query('SELECT state FROM bb_material_versions WHERE id=ANY($1)', [[historical.material_id, active.material_id]]);
      assert.deepEqual(states.rows.map(row => row.state), ['persisted', 'persisted']);
      const checked = await preflight(input);
      assert.equal(checked.statusCode, 200, checked.body);
      assert.ok(checked.json().uncertainty.some((item: string) => item.startsWith('material_needs_confirmation:')),
        'a successful parse with unresolved content remains explicitly uncertain');
      const submitted = await execute(input);
      assert.equal(submitted.statusCode, 202, submitted.body);
      assert.equal(submitted.json().channel, 'non_production_test');
      assert.ok(submitted.json().test_grant_id);
      assert.deepEqual(await counts(), [1, 1, 1]);
    } finally {
      await app.close();
      await pool.end();
      names.forEach((name, index) => {
        if (before[index] === undefined) delete process.env[name];
        else process.env[name] = before[index];
      });
    }
  });
