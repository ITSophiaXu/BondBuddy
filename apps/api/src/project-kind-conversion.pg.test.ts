import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { emptyUpdateDetails } from '@bondbuddy/contracts';
import { isolatedTestDatabase } from './test-database.js';
import { createServer } from './server.js';
import { azureBlobs } from './data.js';

const connection = await isolatedTestDatabase();
const origin = 'http://bondbuddy.test';

test('owner conversion preserves the old input and refuses its preflight and execute; replay is durable', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection! });
  const owner = `synthetic-conversion-${randomUUID()}`;
  let actor = owner;
  const app = createServer({ pool, allowedOrigin: origin, principal: async () => ({ userId: actor, csrfVerified: true }),
    ...(process.env.BB_TEST_AZURITE_CONNECTION_STRING ? { blobs: azureBlobs(process.env.BB_TEST_AZURITE_CONNECTION_STRING) } : {}) });
  const send = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { origin }, payload: payload as any });
  try {
    const created = await send('POST', '/api/v1/projects', { name: 'Synthetic no-history project', kind: 'update', issuer_name: null, market: null, offering: null, update_details: { ...emptyUpdateDetails(), has_historical: false } });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().project_id as string;
    const base = `/api/v1/projects/${id}`;
    const materials = [];
    for (const [index, role] of ['audit', 'audit', 'reference'].entries()) {
      const uploadId = randomUUID(), materialId = randomUUID(), sha = String(index + 1).repeat(64);
      await pool.query("INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state) VALUES($1,$2,$3,'synthetic.pdf','application/pdf',1,$4,$5,$6,now() + interval '1 day','completed')", [uploadId,owner,id,sha,role,`synthetic/upload/${uploadId}`]);
      await pool.query("INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) VALUES($1,1,$2,$3,$4,$5,'synthetic.pdf','application/pdf',1,$6,$7,'persisted')", [materialId,owner,id,uploadId,role,sha,`synthetic/material/${materialId}`]);
      materials.push({ material_id: materialId, material_version: 1 });
    }
    const locked = await send('POST', `${base}/input-revisions`, { draft_revision: 1, material_versions: materials, requirement_message_ids: [] });
    assert.equal(locked.statusCode, 201, locked.body);
    const hash = locked.json().input_hash as string;
    const before = (await pool.query('SELECT * FROM bb_input_revisions WHERE project_id=$1 AND revision=1', [id])).rows[0];
    const request = { conversion_request_id: randomUUID(), expected_draft_revision: 1, expected_input_revision: 1, expected_input_hash: hash, no_historical_prospectus: true };
    const path = `${base}/convert-to-generation`;
    actor = `${owner}-other`;
    assert.equal((await send('POST', path, request)).statusCode, 404);
    actor = owner;
    assert.equal((await send('POST', path, { ...request, no_historical_prospectus: false })).statusCode, 422);
    assert.equal((await send('POST', path, { ...request, expected_input_hash: '0'.repeat(64) })).statusCode, 409);
    assert.equal((await send('POST', path, { ...request, expected_draft_revision: 2 })).statusCode, 409);
    const converted = await send('POST', path, request);
    assert.equal(converted.statusCode, 200, converted.body);
    assert.equal(converted.json().draft_revision, 2);
    assert.deepEqual((await send('POST', path, request)).json(), converted.json());
    assert.equal((await send('POST', path, { ...request, expected_draft_revision: 2 })).json().code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await send('POST', path, { ...request, conversion_request_id: randomUUID() })).statusCode, 409);
    const current = (await send('GET', base)).json();
    assert.equal(current.kind, 'generation');
    assert.equal(current.draft_revision, 2);
    assert.equal(current.input_revision, 1);
    assert.equal(current.input_hash, hash);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE project_id=$1 AND deleted_at IS NULL', [id])).rows[0].n, 3);
    if(process.env.BB_TEST_AZURITE_CONNECTION_STRING){
      const historicalUpload=await send('POST', `${base}/materials/uploads`, { filename:'synthetic.pdf', media_type:'application/pdf', byte_size:1,
        sha256:'a'.repeat(64), role:'historical' });
      assert.equal(historicalUpload.statusCode, 409, historicalUpload.body);
    }
    assert.deepEqual((await pool.query('SELECT * FROM bb_input_revisions WHERE project_id=$1 AND revision=1', [id])).rows[0], before);
    const preflight = await send('POST', `${base}/preflight`, { input_revision: 1, input_hash: hash });
    assert.equal(preflight.statusCode, 409, preflight.body);
    assert.equal(preflight.json().code, 'INPUT_REVISION_CONFLICT');
    const execute = await send('POST', '/api/v1/runs/execute', { execution_request_id: randomUUID(), project_id: id, input_revision: 1, input_hash: hash, task_kind: 'update', input_manifest_ref: id, storage_origin: 'cloud', workspace_id: id });
    assert.equal(execute.statusCode, 409, execute.body);
    assert.equal(execute.json().code, 'INPUT_REVISION_CONFLICT');
    const newLock = await send('POST', `${base}/input-revisions`, { draft_revision: 2, material_versions: materials, requirement_message_ids: [] });
    assert.equal(newLock.statusCode, 201, newLock.body);
    const newManifest = (await pool.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=2', [id])).rows[0].manifest;
    assert.equal(newManifest.kind, 'generation');
    assert.equal(newManifest.materials.length, 3);
    assert.equal(Object.hasOwn(newManifest, 'generation_issuer_binding_ref'), false, 'no issuer approval is fabricated');
    const preflightNew = await send('POST', `${base}/preflight`, { input_revision: 2, input_hash: newLock.json().input_hash });
    assert.notEqual(preflightNew.statusCode, 409, preflightNew.body);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE owner_user_id=$1 AND aggregate_id=$2 AND event_type='project.kind_converted'", [owner,id])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_project_kind_conversions WHERE owner_user_id=$1 AND project_id=$2', [owner,id])).rows[0].n, 1);
  } finally { await app.close(); await pool.end(); }
});

test('conversion rejects historical material and terminal run, and serializes against a new input lock', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection! });
  const owner = `synthetic-conversion-blocks-${randomUUID()}`;
  const app = createServer({ pool, allowedOrigin: origin, principal: async () => ({ userId: owner, csrfVerified: true }), enableRunStaging: true });
  const send = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { origin }, payload: payload as any });
  const create = async () => {
    const response = await send('POST', '/api/v1/projects', { name: 'Synthetic project', kind: 'update', issuer_name: null, market: null, offering: null, update_details: { ...emptyUpdateDetails(), has_historical: false } });
    assert.equal(response.statusCode, 201, response.body);
    const id = response.json().project_id as string;
    const locked = await send('POST', `/api/v1/projects/${id}/input-revisions`, { draft_revision: 1, material_versions: [], requirement_message_ids: [] });
    assert.equal(locked.statusCode, 201, locked.body);
    return { id, hash: locked.json().input_hash as string, request: { conversion_request_id: randomUUID(), expected_draft_revision: 1, expected_input_revision: 1, expected_input_hash: locked.json().input_hash, no_historical_prospectus: true } };
  };
  try {
    const sameKind = await create();
    const edited = await app.inject({ method: 'PATCH', url: `/api/v1/projects/${sameKind.id}`, headers: { origin, 'if-match': '1' },
      payload: { name: 'Synthetic renamed draft' } });
    assert.equal(edited.statusCode, 200, edited.body);
    const sameKindPreflight = await send('POST', `/api/v1/projects/${sameKind.id}/preflight`, { input_revision: 1, input_hash: sameKind.hash });
    assert.notEqual(sameKindPreflight.statusCode, 409, sameKindPreflight.body);
    const material = await create();
    const upload = randomUUID(), materialId = randomUUID();
    await pool.query("INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state) VALUES($1,$2,$3,'synthetic.pdf','application/pdf',1,$4,'historical',$5,now() + interval '1 day','completed')", [upload,owner,material.id,'a'.repeat(64),`synthetic/${upload}`]);
    await pool.query("INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) VALUES($1,1,$2,$3,$4,'historical','synthetic.pdf','application/pdf',1,$5,$6,'persisted')", [materialId,owner,material.id,upload,'a'.repeat(64),`synthetic/material/${upload}`]);
    assert.equal((await send('POST', `/api/v1/projects/${material.id}/convert-to-generation`, material.request)).statusCode, 409);
    assert.equal((await pool.query('SELECT kind FROM bb_projects WHERE id=$1', [material.id])).rows[0].kind, 'update');
    const run = await create();
    await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$5,'update',$6,'failed')", [randomUUID(),owner,run.id,run.hash,randomUUID(),'b'.repeat(64)]);
    assert.equal((await send('POST', `/api/v1/projects/${run.id}/convert-to-generation`, run.request)).statusCode, 409);
    const pendingWork = await create();
    const queueApp = createServer({ pool, allowedOrigin: origin, principal: async () => ({ userId: owner, csrfVerified: true }), enableSyntheticQueue: true });
    try {
      const submitted = await queueApp.inject({ method: 'POST', url: '/api/v1/runs/execute', headers: { origin }, payload: {
        execution_request_id: randomUUID(), project_id: pendingWork.id, input_revision: 1, input_hash: pendingWork.hash,
        task_kind: 'update', input_manifest_ref: pendingWork.id, storage_origin: 'cloud', workspace_id: pendingWork.id } });
      assert.equal(submitted.statusCode, 202, submitted.body);
      assert.equal((await pool.query("SELECT count(*)::int n FROM bb_jobs WHERE run_id=$1 AND state='queued'", [submitted.json().run_id])).rows[0].n, 1);
      assert.equal((await send('POST', `/api/v1/projects/${pendingWork.id}/convert-to-generation`, pendingWork.request)).statusCode, 409);
    } finally { await queueApp.close(); }
    const race = await create();
    const [conversion, lock] = await Promise.all([
      send('POST', `/api/v1/projects/${race.id}/convert-to-generation`, race.request),
      send('POST', `/api/v1/projects/${race.id}/input-revisions`, { draft_revision: 1, material_versions: [], requirement_message_ids: [] })
    ]);
    assert.ok([200,409].includes(conversion.statusCode), conversion.body);
    assert.ok([201,409].includes(lock.statusCode), lock.body);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_project_kind_conversions WHERE project_id=$1', [race.id])).rows[0].n, conversion.statusCode === 200 ? 1 : 0);
    const pendingUpload = await create();
    await pool.query("INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state) VALUES($1,$2,$3,'synthetic.pdf','application/pdf',1,$4,'historical',$5,now() + interval '1 day','received')", [randomUUID(),owner,pendingUpload.id,'a'.repeat(64),`synthetic/pending/${randomUUID()}`]);
    assert.equal((await send('POST', `/api/v1/projects/${pendingUpload.id}/convert-to-generation`, pendingUpload.request)).statusCode, 409);
    const executeRace = await create();
    const [converted, submitted] = await Promise.all([
      send('POST', `/api/v1/projects/${executeRace.id}/convert-to-generation`, executeRace.request),
      send('POST', '/api/v1/runs/execute', { execution_request_id: randomUUID(), project_id: executeRace.id,
        input_revision: 1, input_hash: executeRace.hash, task_kind: 'update', input_manifest_ref: executeRace.id,
        storage_origin: 'cloud', workspace_id: executeRace.id })
    ]);
    assert.ok([200,409].includes(converted.statusCode), converted.body);
    assert.ok([202,409].includes(submitted.statusCode), submitted.body);
    assert.notEqual(converted.statusCode === 200, submitted.statusCode === 202, 'conversion and execute cannot both commit');
  } finally { await app.close(); await pool.end(); }
});
