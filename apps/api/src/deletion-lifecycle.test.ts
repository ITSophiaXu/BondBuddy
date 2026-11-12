import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Ajv } from 'ajv';
import { Pool } from 'pg';
import { dataLifecycleSchemas, emptyUpdateDetails, reportingWindow } from '@bondbuddy/contracts';
import { azureBlobs, digest, type PrivateBlobs } from './data.js';
import { createServer } from './server.js';
import { dataPolicyFromEnv, runDeletedContentPurge, runUserDeletionLifecycle } from './deletion-lifecycle.js';
import { DOCX } from './upload-safety.samples.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';
import { quoteSyntheticAuthoringRun } from './test-authoring-source.js';

// Synthetic data only. Integration tests need a migrated PostgreSQL 16 and Azurite; otherwise they skip.
import { isolatedTestDatabase } from './test-database.js';
const connection = await isolatedTestDatabase();
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const origin = 'http://bondbuddy.test';
const DAY = 86_400_000;
const policyEnv = { BB_STORAGE_PURGE_ENABLED: 'true', BB_STORAGE_MATERIAL_RETENTION_DAYS: '7', BB_STORAGE_ORPHAN_GRACE_HOURS: '24', BB_LOG_CONTENT_RETENTION_DAYS: '180', BB_BACKUP_RETENTION_DAYS: '30' };
const validPolicy = new Ajv({ strict: true }).compile(dataLifecycleSchemas.DataPolicyResponse);

test('data policy is derived from the purge configuration; unset windows are null, not zero', () => {
  const unset = dataPolicyFromEnv({});
  assert.ok(validPolicy(unset));
  assert.equal(unset.purge_enabled, false);
  assert.equal(unset.deleted_content_purge_days, null);
  assert.equal(unset.orphan_upload_purge_hours, null);
  assert.equal(unset.backup_retention_days, null);
  assert.equal(unset.log_content_retention_days, 180, 'the #79 log retention default is reported as-is');
  assert.equal(unset.storage_location, 'platform_private_cloud');
  const configured = dataPolicyFromEnv(policyEnv);
  assert.ok(validPolicy(configured));
  assert.equal(configured.deleted_content_purge_days, 7);
  assert.equal(configured.orphan_upload_purge_hours, 24);
  assert.equal(configured.backup_retention_days, 30);
  assert.throws(() => dataPolicyFromEnv({ BB_BACKUP_RETENTION_DAYS: 'thirty' }), /BB_BACKUP_RETENTION_DAYS/);
  assert.throws(() => dataPolicyFromEnv({ BB_STORAGE_PURGE_ENABLED: 'true' }), /must be explicitly set/);
});

test('GET /api/v1/data-policy is public and renders the server configuration', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, policyEnv);
  const app = createServer({ pool: {} as Pool, principal: async () => null, allowedOrigin: origin });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/data-policy' });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.ok(validPolicy(body));
    assert.equal(body.deleted_content_purge_days, 7);
    assert.equal(body.backup_retention_days, 30);
    process.env.BB_BACKUP_RETENTION_DAYS = 'bad';
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/data-policy' })).statusCode, 503);
  } finally {
    for (const key of Object.keys(policyEnv)) delete process.env[key];
    Object.assign(process.env, saved);
    await app.close();
  }
});

test('PostgreSQL deletion receipts purge v2 page and checkpoint bytes without removing audit rows', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const owner = randomUUID(), project = randomUUID(), material = randomUUID(), upload = randomUUID();
  const job = randomUUID(), batch = randomUUID(), hash = 'a'.repeat(64);
  const original = `users/${owner}/projects/${project}/materials/${upload}`;
  const prefix = `users/${owner}/projects/${project}/ocr-v2/${material}/1/${hash}/${hash}`;
  const pageKey = `${prefix}.png`, checkpointKey = `${prefix}.json`;
  const stored = new Map([[pageKey, Buffer.from('synthetic page')], [checkpointKey, Buffer.from('synthetic checkpoint')]]);
  const blobs = {
    delete: async (key: string) => { stored.delete(key); },
    getIfExists: async (key: string) => stored.get(key) ?? null
  } as PrivateBlobs;
  try {
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, `ocr${owner.replaceAll('-', '').slice(0, 25)}`]);
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'synthetic lifecycle','update')", [project, owner]);
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'synthetic.pdf','application/pdf',1,$4,'audit',$5,now()+interval '1 hour','completed')`,
    [upload, owner, project, hash, original]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'audit','synthetic.pdf','application/pdf',1,$5,$6,'persisted')`,
    [material, owner, project, upload, hash, original]);
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,project_id,material_id,material_version,material_sha256,parser_version,trace_id,max_attempts)
      VALUES($1,$2,NULL,'parse','material_parse','queued','queued',$3,$4,1,$5,'synthetic-parser',$6,3)`,
    [job, owner, project, material, hash, randomUUID()]);
    await pool.query(`INSERT INTO bb_ocr_v2_batches(id,owner_user_id,project_id,material_id,material_version,document_identity,context,job_id,purpose,request,state)
      VALUES($1,$2,$3,$4,1,$5,$6,$7,'source_preflight',$8,'started')`,
    [batch, owner, project, material, { engine: { name: 'synthetic' } }, { purpose: 'source_preflight' }, job, { pages: [1] }]);
    await pool.query(`INSERT INTO bb_ocr_v2_pages(owner_user_id,project_id,material_id,material_version,identity_sha256,result_sha256,source_request_id,page,checkpoint_key,checkpoint_blob_sha256,image_key,image_sha256)
      VALUES($1,$2,$3,1,$4,$5,$6,1,$7,$5,$8,$5)`,
    [owner, project, material, hash, hash, batch, checkpointKey, pageKey]);
    await pool.query('UPDATE bb_material_versions SET deleted_at=now() WHERE owner_user_id=$1 AND id=$2', [owner, material]);
    await pool.query(`UPDATE bb_storage_tombstones SET eligible_at=now()
      WHERE owner_user_id=$1 AND material_id=$2`, [owner, material]);
    await pool.query(`UPDATE bb_storage_tombstones SET state='claimed',attempts=1,claim_token=$3,lease_until=now()+interval '1 hour'
      WHERE owner_user_id=$1 AND material_id=$2`, [owner, material, randomUUID()]);
    await pool.query(`UPDATE bb_storage_tombstones SET state='purged',purged_at=now(),claim_token=NULL,lease_until=NULL
      WHERE owner_user_id=$1 AND material_id=$2`, [owner, material]);
    const first = await runDeletedContentPurge(pool, blobs, { ownerScope: owner, deletedContentPurgeDays: 0 });
    assert.equal(first.materialsPurged, 1);
    assert.equal(first.objectsDeleted, 2);
    assert.equal(stored.size, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM bb_ocr_v2_pages WHERE owner_user_id=$1', [owner])).rows[0].n, 1);
    const second = await runDeletedContentPurge(pool, blobs, { ownerScope: owner, deletedContentPurgeDays: 0 });
    assert.equal(second.materialsPurged, 0);
  } finally { await pool.end(); }
});

test('PostgreSQL/Azurite user deletion tombstones, 404s, then purges bytes and derived content idempotently', { skip: !connection || !blobConnection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const owner = `deletion-${randomUUID()}`;
  let activeOwner = owner;
  const blobs = azureBlobs(blobConnection!, `bb-deletion-${randomUUID().replaceAll('-', '')}`);
  const app = createServer({ pool, blobs, principal: async () => ({ userId: activeOwner, csrfVerified: true }), allowedOrigin: origin, enableRunStaging: true });
  const send = (method: string, url: string, payload?: unknown, extra: Record<string, string> = {}) =>
    app.inject({ method: method as any, url, headers: { origin, ...extra }, payload: payload as any });
  // Both materials retain identical bytes, so deleting one must preserve their shared parse cache.
  const bytes = makeSyntheticDocxFixture({ text: 'Synthetic deletion source' });
  const sha = digest(bytes);

  const createProject = async (name: string) => {
    const response = await send('POST', '/api/v1/projects', { name, kind: 'update', issuer_name: 'Synthetic deletion issuer', market: 'sse', offering: 'private',
      update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1', reporting_cutoff: '2026-09-30' } });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().project_id as string;
  };
  const upload = async (projectId: string, role: string) => {
    const created = await send('POST', `/api/v1/projects/${projectId}/materials/uploads`, { filename: `${role}.docx`, media_type: DOCX, byte_size: bytes.length, sha256: sha, role });
    assert.equal(created.statusCode, 201, created.body);
    const put = await send('PUT', created.json().upload_url, bytes, { 'content-type': 'application/octet-stream' });
    assert.equal(put.statusCode, 204, put.body);
    const done = await send('POST', `/api/v1/projects/${projectId}/materials/uploads/${created.json().upload_id}/complete`, { byte_size: bytes.length, sha256: sha });
    assert.equal(done.statusCode, 200, done.body);
    const m = done.json() as { material_id: string; material_version: number; upload_id: string };
    return { ...m, key: `users/${owner}/projects/${projectId}/uploads/${m.upload_id}` };
  };
  // Synthetic derived content, shaped like the #13 parse evidence, #15 OCR and parse cache writers.
  const derive = async (projectId: string, m: { material_id: string; material_version: number }) => {
    const snapshot = `snap-${randomUUID()}`;
    await pool.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,response_status,response_schema_version,response_sha256,record_count,response_meta)
      VALUES($1,$2,$3,$4,$5,$6,'parser-syn-1',$6,'parsed','document-parse-response-v1',$6,1,$7)`,
      [snapshot, owner, projectId, m.material_id, m.material_version, sha, { schema_version: 'document-parse-response-v1', request_id: `req-${snapshot}`, status: 'parsed', parser_version: 'parser-syn-1', material: { material_id: m.material_id, material_version: m.material_version, sha256: sha }, warnings: [], document: {}, error: null }]);
    await pool.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,locator_type,locator,literal_quote,context,extraction_method,extractor_version,uncertainty,formatting,record_sha256,ordinal)
      VALUES($1,$2,$3,$4,$5,'r1',$6,'text_line','{}','合成摘录','','native_text','syn-1','[]','{}',$6,0)`, [owner, projectId, m.material_id, m.material_version, snapshot, sha]);
    const pageKey = `users/${owner}/projects/${projectId}/ocr/${m.material_id}/${m.material_version}/${sha}.png`;
    const resultKey = `users/${owner}/projects/${projectId}/ocr/results/${randomUUID()}.json`;
    await blobs.put(pageKey, Buffer.from('synthetic page'), 'image/png');
    await blobs.put(resultKey, Buffer.from(JSON.stringify({ page_objects: { 1: { key: pageKey, sha256: sha } } })), 'application/json');
    await pool.query(`INSERT INTO bb_ocr_snapshots(id,owner_user_id,project_id,material_id,material_version,request_id,request_hash,result_hash,result_key,purpose)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,'source_preflight')`, [`ocr-${randomUUID()}`, owner, projectId, m.material_id, m.material_version, `ocr-req-${randomUUID()}`, sha, resultKey]);
    return { pageKey, resultKey };
  };
  const exists = async (key: string) => (await blobs.getIfExists(key)) !== null;
  const evidenceRows = async (materialId: string) => (await pool.query('SELECT count(*)::int n FROM bb_parse_evidence WHERE owner_user_id=$1 AND material_id=$2', [owner, materialId])).rows[0].n;

  try {
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, `u${owner.replace(/-/g, '_')}`.slice(0, 32)]);
    // ---- material deletion inside a live project
    const projectId = await createProject('合成删除项目');
    const kept = await upload(projectId, 'historical');
    const doomed = await upload(projectId, 'notes');
    const doomedDerived = await derive(projectId, doomed);
    const cacheKey = `parse-cache/${randomUUID()}`;
    await blobs.put(cacheKey, Buffer.from('synthetic cache'), 'application/json');
    await pool.query(`INSERT INTO bb_parse_cache(owner_user_id,content_sha256,parser_version,ocr_version,basis_version,result_state,object_key,object_sha256,object_bytes)
      VALUES($1,$2,'p1','o1','b1','parsed',$3,$2,15)`, [owner, sha, cacheKey]);

    assert.equal((await send('DELETE', `/api/v1/projects/${projectId}/materials/${doomed.material_id}`)).statusCode, 204);
    assert.equal((await send('GET', `/api/v1/projects/${projectId}/materials/${doomed.material_id}`)).statusCode, 404);

    let clock = Date.now();
    const storage = { materialRetentionDays: 7, orphanUploadGraceHours: 24, now: () => new Date(clock), ownerScope: owner };
    const early = await runUserDeletionLifecycle(pool, blobs, storage, 180);
    assert.equal(early.storage.purged, 0, 'nothing is purged inside the stated window');
    assert.equal(early.derived.materialsPurged, 0);
    assert.ok(await exists(doomed.key));

    clock += 8 * DAY;
    // Crash after Blob deletes but before the receipt commits: next pass completes, nothing is double counted.
    const storageOnly = await runUserDeletionLifecycle(pool, blobs, { ...storage, now: () => new Date(clock) }, 180);
    assert.equal(storageOnly.storage.purged, 1);
    assert.equal(storageOnly.derived.materialsPurged, 1);
    assert.equal(await exists(doomed.key), false, 'original bytes purged');
    assert.equal(await exists(doomedDerived.pageKey), false, 'OCR page purged');
    assert.equal(await exists(doomedDerived.resultKey), false, 'OCR result purged');
    assert.equal(await evidenceRows(doomed.material_id), 0, 'parse evidence text purged');
    assert.equal(await exists(cacheKey), true, 'parse cache is kept while another live material has the same bytes');
    assert.ok(await exists(kept.key), 'other material untouched');
    const again = await runDeletedContentPurge(pool, blobs, { deletedContentPurgeDays: 7, now: () => new Date(clock), ownerScope: owner });
    assert.deepEqual(again, { materialsPurged: 0, projectsPurged: 0, objectsDeleted: 0, failed: 0 }, 'a repeat run is a no-op');
    const meta = await pool.query('SELECT sha256,deleted_at FROM bb_material_versions WHERE owner_user_id=$1 AND id=$2', [owner, doomed.material_id]);
    assert.equal(meta.rows[0].sha256.trim(), sha, 'hash metadata is retained for audit');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_parse_snapshots WHERE owner_user_id=$1 AND material_id=$2', [owner, doomed.material_id])).rows[0].n, 1, 'parse snapshot header retained');
    await assert.rejects(pool.query('DELETE FROM bb_deleted_content_purges WHERE owner_user_id=$1', [owner]), (e: any) => e.code === '23514', 'receipts are append-only');

    // ---- project deletion
    const keptDerived = await derive(projectId, kept);
    await assert.rejects(pool.query(`DO $$BEGIN PERFORM set_config('bb.deleted_content_purge','on',true); DELETE FROM bb_parse_evidence WHERE owner_user_id='${owner}'; END$$`),
      (e: any) => e.code === '23514', 'evidence of live materials stays immutable, even inside the purge session');
    const current = await send('GET', `/api/v1/projects/${projectId}`);
    assert.equal(current.statusCode, 200, current.body);
    const declared = await send('PATCH', `/api/v1/projects/${projectId}`, { update_details: { ...current.json().update_details,
      source_prospectuses: [{ material_id: kept.material_id, material_version: kept.material_version, sha256: sha,
        issuer_name: 'Synthetic deletion issuer', relation: 'same_issuer', market: 'sse', offering: 'private',
        reporting_periods: reportingWindow('sse', 'private', '2025-12-31'), status: 'user_asserted' }] }
    }, { 'if-match': String(current.json().draft_revision) });
    assert.equal(declared.statusCode, 200, declared.body);
    const versions = await send('GET', `/api/v1/projects/${projectId}/prospectus-versions`);
    assert.equal(versions.statusCode, 200, versions.body);
    assert.equal(versions.json().versions.find((v: any) => v.version_id === versions.json().current_version_id)?.material_id, kept.material_id);
    const revision = await send('POST', `/api/v1/projects/${projectId}/input-revisions`, { draft_revision: declared.json().draft_revision,
      prospectus_selection_revision: versions.json().selection_revision,
      material_versions: [{ material_id: kept.material_id, material_version: kept.material_version }], requirement_message_ids: [] });
    assert.equal(revision.statusCode, 201, revision.body);
    const input = revision.json();
    const quoteId = await quoteSyntheticAuthoringRun(app, pool, owner, projectId, input);
    const staged = await send('POST', '/api/v1/runs/execute', { execution_request_id: randomUUID(), project_id: projectId, input_revision: input.input_revision, input_hash: input.input_hash, task_kind: 'update', input_manifest_ref: 'synthetic-manifest', storage_origin: 'cloud', workspace_id: 'synthetic-workspace', quote_id: quoteId });
    assert.equal(staged.statusCode, 202, staged.body);
    const runId = staged.json().run_id as string;
    const promptKey = `users/${owner}/projects/${projectId}/snapshots/${randomUUID()}`;
    await blobs.put(promptKey, Buffer.from('synthetic prompt body'), 'text/plain');
    const promptId = randomUUID();
    await pool.query(`INSERT INTO bb_snapshot_refs(id,owner_user_id,project_id,run_id,snapshot_kind,version,object_key,content_sha256,redaction_version,input_revision,input_hash)
      VALUES($1,$2,$3,$4,'model_request',1,$5,$6,'syn-redaction-v1',$7,$8)`, [promptId, owner, projectId, runId, promptKey, sha, input.input_revision, input.input_hash]);
    const artifactKey = `users/${owner}/artifacts/${randomUUID()}`;
    await blobs.put(artifactKey, Buffer.from('synthetic docx'), 'application/octet-stream');
    await pool.query(`INSERT INTO bb_artifact_versions(id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status)
      VALUES($1,1,$2,$3,'application/vnd.openxmlformats-officedocument.wordprocessingml.document',$4,$5,'pending','pending')`, [`artifact-${randomUUID()}`, owner, runId, sha, artifactKey]);

    const deleteProject = () => send('DELETE', `/api/v1/projects/${projectId}`);
    const blocked = await deleteProject();
    assert.equal(blocked.statusCode, 409, 'an active run blocks deletion');
    assert.equal(blocked.json().code, 'PROJECT_DELETE_BLOCKED');
    await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1", [runId]);

    activeOwner = `deletion-other-${randomUUID()}`;
    assert.equal((await deleteProject()).statusCode, 404, 'foreign project is owner-safe 404');
    activeOwner = owner;
    assert.equal((await deleteProject()).statusCode, 204);
    assert.equal((await deleteProject()).statusCode, 204, 'repeat delete is idempotent');
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE owner_user_id=$1 AND event_type='project.deleted'", [owner])).rows[0].n, 1);
    for (const url of [`/api/v1/projects/${projectId}`, `/api/v1/projects/${projectId}/materials/${kept.material_id}`, `/api/v1/projects/${projectId}/materials/${kept.material_id}/download`, `/api/v1/runs/${runId}`, `/api/v1/projects/${projectId}/input-revisions/${input.input_revision}`])
      assert.equal((await send('GET', url)).statusCode, 404, url);
    assert.ok(!(await send('GET', '/api/v1/projects')).json().items.some((p: { project_id: string }) => p.project_id === projectId));
    await assert.rejects(pool.query('UPDATE bb_projects SET deleted_at=NULL WHERE id=$1', [projectId]), (e: any) => e.code === '23514', 'project deletion is irreversible');

    clock = Date.now(); // project deleted_at is the real transaction time
    const insideWindow = await runUserDeletionLifecycle(pool, blobs, { ...storage, now: () => new Date(clock) }, 180);
    assert.equal(insideWindow.derived.projectsPurged, 0);
    assert.ok(await exists(artifactKey) && await exists(kept.key) && await exists(promptKey));

    clock += 8 * DAY;
    let crashes = 0;
    const crashing = await runDeletedContentPurge(pool, blobs, { deletedContentPurgeDays: 7, now: () => new Date(clock + DAY), ownerScope: owner, afterBlobDeletes: async () => { crashes++; throw new Error('synthetic crash'); } });
    assert.ok(crashing.failed >= 1 && crashes >= 1, 'injected crash is reported as failed');
    const done = await runUserDeletionLifecycle(pool, blobs, { ...storage, now: () => new Date(clock + DAY) }, 180);
    assert.equal(done.storage.purged, 1, 'the revision no longer pins bytes once the project is deleted');
    assert.equal(done.derived.projectsPurged, 1);
    assert.equal(done.derived.materialsPurged, 1);
    assert.equal(done.logs.purged, 1, 'prompt body purged through the #79 retention job');
    for (const key of [kept.key, artifactKey, promptKey, keptDerived.pageKey, keptDerived.resultKey, cacheKey]) assert.equal(await exists(key), false, key);
    assert.equal(await evidenceRows(kept.material_id), 0);
    assert.equal((await pool.query("SELECT reason FROM bb_log_content_tombstones WHERE content_id=$1", [promptId])).rows[0].reason, 'user_deleted');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_parse_cache WHERE owner_user_id=$1', [owner])).rows[0].n, 0);
    // Audit and cost metadata remain.
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE id=$1', [runId])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_snapshot_refs WHERE id=$1', [promptId])).rows[0].n, 1);
    const receipts = await pool.query('SELECT subject_kind,artifact_objects FROM bb_deleted_content_purges WHERE owner_user_id=$1 ORDER BY subject_kind', [owner]);
    assert.deepEqual(receipts.rows.map(r => r.subject_kind), ['material_version', 'material_version', 'project']);
    const final = await runUserDeletionLifecycle(pool, blobs, { ...storage, now: () => new Date(clock + 2 * DAY) }, 180);
    assert.equal(final.storage.purged + final.derived.materialsPurged + final.derived.projectsPurged + final.logs.purged, 0, 'fully idempotent');
  } finally {
    await app.close();
    await pool.end();
  }
});
