import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BlobServiceClient } from '@azure/storage-blob';
import { Pool } from 'pg';
import { emptyUpdateDetails } from '@bondbuddy/contracts';
import { azureBlobs, digest, type PrivateBlobs } from './data.js';
import { createServer } from './server.js';
import { claim, finish, promoteWordArtifact } from './queue.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';
import { runStorageLifecycle, storageLifecyclePolicyFromEnv } from './storage-lifecycle.js';
import { PDF, pdfSample } from './upload-safety.samples.js';
import { isolatedTestDatabase } from './test-database.js';
import { quoteSyntheticAuthoringRun, uploadSyntheticReference } from './test-authoring-source.js';

const connection = await isolatedTestDatabase(undefined,'storage-lifecycle-tombstones');
const restoreConnection = await isolatedTestDatabase();
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const origin = 'http://bondbuddy.test';
const pdf = pdfSample();
const isConstraintViolation = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '23514';

test('storage purge configuration fails closed without explicitly set policy', () => {
  assert.equal(storageLifecyclePolicyFromEnv({}), null);
  assert.equal(storageLifecyclePolicyFromEnv({ BB_STORAGE_PURGE_ENABLED: 'false' }), null);
  assert.throws(() => storageLifecyclePolicyFromEnv({ BB_STORAGE_PURGE_ENABLED: 'yes' }), /exactly true or false/);
  assert.throws(() => storageLifecyclePolicyFromEnv({ BB_STORAGE_PURGE_ENABLED: 'true' }), /must be explicitly set/);
  assert.deepEqual(storageLifecyclePolicyFromEnv({
    BB_STORAGE_PURGE_ENABLED: 'true',
    BB_STORAGE_MATERIAL_RETENTION_DAYS: '0',
    BB_STORAGE_ORPHAN_GRACE_HOURS: '0'
  }), { materialRetentionDays: 0, orphanUploadGraceHours: 0 });
});

test('PostgreSQL/Azurite tombstones pin snapshots, retry deletion and clean orphan uploads in bounded batches', { skip: !connection || !blobConnection }, async () => {
  const pool = new Pool({ connectionString: connection });
  let activeOwner = `storage-${randomUUID()}`;
  const containerName = `bb-lifecycle-${randomUUID().replaceAll('-', '')}`;
  const blobs = azureBlobs(blobConnection!, containerName);
  const app = createServer({ pool, blobs, principal: async () => ({ userId: activeOwner, csrfVerified: true }), allowedOrigin: origin, enableRunStaging: true });
  const send = (method: string, url: string, payload?: unknown, extra: Record<string, string> = {}) => app.inject({
    method: method as any,
    url,
    headers: { origin, ...extra },
    payload: payload as any
  });
  const createProject = async (name: string, authoring = false) => {
    const response = await send('POST', '/api/v1/projects', { name, kind: 'update',
      issuer_name: authoring ? 'Synthetic storage issuer' : null, market: authoring ? 'sse' : null, offering: authoring ? 'private' : null,
      ...(authoring ? { update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1', reporting_cutoff: '2026-09-30' } } : {}) });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().project_id as string;
  };
  const startUpload = async (projectId: string, filename: string, complete: boolean) => {
    const upload = await send('POST', `/api/v1/projects/${projectId}/materials/uploads`, {
      filename, media_type: PDF, byte_size: pdf.length, sha256: digest(pdf), role: filename === 'retryable.pdf' ? 'notes' : 'audit'
    });
    assert.equal(upload.statusCode, 201, upload.body);
    const uploadId = upload.json().upload_id as string;
    const put = await send('PUT', upload.json().upload_url, pdf, { 'content-type': 'application/octet-stream' });
    assert.equal(put.statusCode, 204, put.body);
    const retriedPut = await send('PUT', upload.json().upload_url, pdf, { 'content-type': 'application/octet-stream' });
    assert.equal(retriedPut.statusCode, 204, retriedPut.body);
    if (!complete) return { uploadId };
    const result = await send('POST', `/api/v1/projects/${projectId}/materials/uploads/${uploadId}/complete`, { byte_size: pdf.length, sha256: digest(pdf) });
    assert.equal(result.statusCode, 200, result.body);
    return { uploadId, material: result.json() as { material_id: string; material_version: number } };
  };

  try {
    const projectId = await createProject('Synthetic pinned storage project', true);
    const retryableUpload = await startUpload(projectId, 'retryable.pdf', false);
    const retryableKey = `users/${activeOwner}/projects/${projectId}/uploads/${retryableUpload.uploadId}`;
    await blobs.delete(retryableKey);
    const retriedPut = await send('PUT', `/api/v1/projects/${projectId}/materials/uploads/${retryableUpload.uploadId}/bytes`, pdf, { 'content-type': 'application/octet-stream' });
    assert.equal(retriedPut.statusCode, 204, retriedPut.body);
    assert.equal(digest((await blobs.get(retryableKey))), digest(pdf), 'a retry restores a missing Blob for a received upload');
    const retryableCompletion = await send('POST', `/api/v1/projects/${projectId}/materials/uploads/${retryableUpload.uploadId}/complete`, { byte_size: pdf.length, sha256: digest(pdf) });
    assert.equal(retryableCompletion.statusCode, 200, retryableCompletion.body);

    const pinnedUpload = await startUpload(projectId, 'pinned.pdf', true);
    const pinned = pinnedUpload.material!;
    const pinnedKey = `users/${activeOwner}/projects/${projectId}/uploads/${pinnedUpload.uploadId}`;
    const receivedEvents = await pool.query("SELECT count(*)::int AS n FROM bb_outbox WHERE aggregate_type='upload' AND aggregate_id=$1 AND event_type='upload.received'", [pinnedUpload.uploadId]);
    assert.equal(receivedEvents.rows[0].n, 1, 'repeated PUT does not duplicate the received outbox event');
    // The added source remains a completed live material; only the original audit is tombstoned below.
    const source = await uploadSyntheticReference(app, projectId);
    const inputResponse = await send('POST', `/api/v1/projects/${projectId}/input-revisions`, {
      ...source,
      material_versions: [{ material_id: pinned.material_id, material_version: pinned.material_version }, ...source.material_versions]
    });
    assert.equal(inputResponse.statusCode, 201, inputResponse.body);
    const input = inputResponse.json();
    const lockedMaterials = (await pool.query('SELECT material_versions FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
      [activeOwner, projectId, input.input_revision])).rows[0].material_versions;
    assert.ok(lockedMaterials.some((material: any) => material.material_id === pinned.material_id && material.material_version === pinned.material_version),
      'the original audit version remains pinned by this run input');
    const quoteId = await quoteSyntheticAuthoringRun(app, pool, activeOwner, projectId, input);
    const staged = await send('POST', '/api/v1/runs/execute', {
      execution_request_id: randomUUID(), project_id: projectId, input_revision: input.input_revision,
      input_hash: input.input_hash, task_kind: 'update', input_manifest_ref: 'synthetic-manifest',
      storage_origin: 'cloud', workspace_id: 'synthetic-workspace', quote_id: quoteId
    });
    assert.equal(staged.statusCode, 202, staged.body);
    const snapshotRef = randomUUID();
    await pool.query(`INSERT INTO bb_snapshot_refs
      (id,owner_user_id,project_id,run_id,snapshot_kind,version,object_key,content_sha256,redaction_version,input_revision,input_hash)
      VALUES($1,$2,$3,$4,'structured_input',1,$5,$6,'synthetic-redaction-v1',$7,$8)`,
    [snapshotRef, activeOwner, projectId, staged.json().run_id,
      `users/${activeOwner}/projects/${projectId}/snapshots/${snapshotRef}`, digest(pdf), input.input_revision, input.input_hash]);
    await pool.query(`INSERT INTO bb_artifact_versions
      (id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status)
      VALUES($1,1,$2,$3,'application/vnd.openxmlformats-officedocument.wordprocessingml.document',$4,$5,'pending','pending')`,
    [`artifact-${randomUUID()}`, activeOwner, staged.json().run_id, digest(Buffer.from('synthetic artifact')), `users/${activeOwner}/artifacts/${randomUUID()}`]);

    const deleteUrl = `/api/v1/projects/${projectId}/materials/${pinned.material_id}`;
    assert.equal((await send('DELETE', deleteUrl)).statusCode, 204);
    assert.equal((await send('DELETE', deleteUrl)).statusCode, 204, 'owned repeat delete is idempotent');
    await assert.rejects(
      pool.query('UPDATE bb_material_versions SET deleted_at=NULL WHERE owner_user_id=$1 AND id=$2', [activeOwner, pinned.material_id]),
      isConstraintViolation
    );
    assert.equal((await send('GET', `/api/v1/projects/${projectId}/materials/${pinned.material_id}`)).statusCode, 404);
    assert.equal((await send('GET', `/api/v1/projects/${projectId}/materials/${pinned.material_id}/download`)).statusCode, 404);
    const deletedCount = await pool.query("SELECT count(*)::int AS n FROM bb_outbox WHERE owner_user_id=$1 AND aggregate_type='material' AND aggregate_id=$2 AND event_type='material.deleted'", [activeOwner, pinned.material_id]);
    assert.equal(deletedCount.rows[0].n, 1, 'repeat delete does not duplicate its transactional outbox event');

    activeOwner = `storage-other-${randomUUID()}`;
    assert.equal((await send('GET', `/api/v1/projects/${projectId}/materials/${pinned.material_id}`)).statusCode, 404);
    assert.equal((await send('GET', `/api/v1/projects/${projectId}/materials/${pinned.material_id}/download`)).statusCode, 404);
    assert.equal((await send('DELETE', deleteUrl)).statusCode, 404);
    activeOwner = (await pool.query('SELECT owner_user_id FROM bb_projects WHERE id=$1', [projectId])).rows[0].owner_user_id;

    let currentTime = Date.now() + 2 * 24 * 60 * 60_000;
    const oneDayPolicy = { materialRetentionDays: 1, orphanUploadGraceHours: 1, now: () => new Date(currentTime), ownerScope: activeOwner };
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_storage_tombstones WHERE owner_user_id=$1 AND material_id=$2',
      [activeOwner, source.material_versions[0]!.material_id])).rows[0].n, 0, 'the completed live source adds no purge candidate');
    const pinnedResult = await runStorageLifecycle(pool, blobs, oneDayPolicy);
    assert.equal(pinnedResult.claimed, 0, 'an input revision/run/artifact reference pins the material bytes');
    assert.equal(pinnedResult.pinned, 1, 'the bounded status count reports an eligible pinned tombstone');
    const pin = await pool.query('SELECT state,eligible_at FROM bb_storage_tombstones WHERE material_id=$1', [pinned.material_id]);
    assert.equal(pin.rows[0].state, 'pending');
    assert.ok(pin.rows[0].eligible_at);
    assert.equal(digest((await blobs.getIfExists(pinnedKey))!), digest(pdf));
    assert.equal((await send('GET', `/api/v1/projects/${projectId}/input-revisions/${input.input_revision}`)).statusCode, 200);

    const rollback = await startUpload(projectId, 'outbox-rollback.pdf', true);
    const rollbackMaterial = rollback.material!;
    await pool.query(`CREATE FUNCTION bb_fail_storage_delete_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='material.deleted' THEN RAISE EXCEPTION 'synthetic outbox failure'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER bb_fail_storage_delete_outbox BEFORE INSERT ON bb_outbox FOR EACH ROW EXECUTE FUNCTION bb_fail_storage_delete_outbox()');
    try {
      const failedDelete = await send('DELETE', `/api/v1/projects/${projectId}/materials/${rollbackMaterial.material_id}`);
      assert.equal(failedDelete.statusCode, 500);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS bb_fail_storage_delete_outbox ON bb_outbox');
      await pool.query('DROP FUNCTION IF EXISTS bb_fail_storage_delete_outbox()');
    }
    const rolledBackDelete = await pool.query(`SELECT m.deleted_at,(SELECT count(*)::int FROM bb_storage_tombstones t WHERE t.material_id=m.id) AS tombstones
      FROM bb_material_versions m WHERE m.owner_user_id=$1 AND m.id=$2`, [activeOwner, rollbackMaterial.material_id]);
    assert.equal(rolledBackDelete.rows[0].deleted_at, null, 'outbox failure rolls back the soft delete');
    assert.equal(rolledBackDelete.rows[0].tombstones, 0, 'outbox failure rolls back the tombstone');
    assert.equal((await send('DELETE', `/api/v1/projects/${projectId}/materials/${rollbackMaterial.material_id}`)).statusCode, 204);
    const rollbackOutbox = await pool.query("SELECT count(*)::int AS n FROM bb_outbox WHERE owner_user_id=$1 AND aggregate_id=$2 AND event_type='material.deleted'", [activeOwner, rollbackMaterial.material_id]);
    assert.equal(rollbackOutbox.rows[0].n, 1);
    const rollbackPurge = await runStorageLifecycle(pool, blobs, oneDayPolicy);
    assert.equal(rollbackPurge.purged, 1);

    const unreferenced = await startUpload(projectId, 'unreferenced.pdf', true);
    const unreferencedMaterial = unreferenced.material!;
    const unreferencedKey = `users/${activeOwner}/projects/${projectId}/uploads/${unreferenced.uploadId}`;
    const unreferencedUrl = `/api/v1/projects/${projectId}/materials/${unreferencedMaterial.material_id}`;
    assert.equal((await send('DELETE', unreferencedUrl)).statusCode, 204);
    const unreferencedMarker = await pool.query('SELECT id FROM bb_storage_tombstones WHERE material_id=$1', [unreferencedMaterial.material_id]);
    assert.equal(unreferencedMarker.rowCount, 1);
    const tombstoneId = unreferencedMarker.rows[0].id as string;

    let verifiedClaimBeforeDelete = false;
    let stateSeenAtBlobDelete: string | null = null;
    let blobReadStatus = 'not-read';
    const deleteThenDisconnect: PrivateBlobs = {
      ...blobs,
      async getIfExists(key: string) {
        try {
          const value = await blobs.getIfExists(key);
          blobReadStatus = value === null ? 'absent' : 'present';
          return value;
        } catch {
          blobReadStatus = 'read-error';
          throw new Error('synthetic read failure');
        }
      },
      async delete(key: string) {
        const durable = await pool.query('SELECT state FROM bb_storage_tombstones WHERE id=$1', [tombstoneId]);
        stateSeenAtBlobDelete = durable.rows[0]?.state ?? null;
        if (stateSeenAtBlobDelete !== 'claimed') throw new Error('claim was not durable before Blob deletion');
        verifiedClaimBeforeDelete = true;
        await blobs.delete(key);
        throw new Error('synthetic connection lost after physical deletion');
      }
    };
    const interrupted = await runStorageLifecycle(pool, deleteThenDisconnect, oneDayPolicy);
    let tombstone = await pool.query('SELECT state,attempts,retry_after,last_error_code FROM bb_storage_tombstones WHERE id=$1', [tombstoneId]);
    assert.equal(verifiedClaimBeforeDelete, true, `Blob read=${blobReadStatus}; claim state observed before Blob delete=${String(stateSeenAtBlobDelete)}; safe failure code=${String(tombstone.rows[0]?.last_error_code)}`);
    assert.equal(interrupted.failed, 1);
    assert.equal(tombstone.rows[0].state, 'pending');
    assert.equal(tombstone.rows[0].attempts, 1);
    assert.equal(tombstone.rows[0].last_error_code, 'blob_delete_failed');
    assert.equal(await blobs.getIfExists(unreferencedKey), null, 'failure injection removed Blob bytes before the worker lost its response');
    currentTime = new Date(tombstone.rows[0].retry_after).getTime() + 1;

    const replay = await runStorageLifecycle(pool, blobs, oneDayPolicy);
    assert.equal(replay.purged, 1, 'retry treats an already absent exact object as successfully purged');
    tombstone = await pool.query('SELECT state,attempts,purged_at FROM bb_storage_tombstones WHERE id=$1', [tombstoneId]);
    assert.equal(tombstone.rows[0].state, 'purged');
    assert.equal(tombstone.rows[0].attempts, 2);
    assert.ok(tombstone.rows[0].purged_at);
    assert.equal(await blobs.getIfExists(unreferencedKey), null);
    assert.equal((await send('GET', unreferencedUrl)).statusCode, 404, 'purge replay cannot resurrect soft-deleted API access');

    const mismatched = await startUpload(projectId, 'hash-mismatch.pdf', true);
    const mismatchedMaterial = mismatched.material!;
    const mismatchedKey = `users/${activeOwner}/projects/${projectId}/uploads/${mismatched.uploadId}`;
    assert.equal((await send('DELETE', `/api/v1/projects/${projectId}/materials/${mismatchedMaterial.material_id}`)).statusCode, 204);
    const corrupt = Buffer.from('synthetic-corrupt-bytes');
    await blobs.put(mismatchedKey, corrupt, PDF);
    const mismatchRun = await runStorageLifecycle(pool, blobs, oneDayPolicy);
    assert.equal(mismatchRun.failed, 1);
    const mismatchMarker = await pool.query('SELECT id,last_error_code FROM bb_storage_tombstones WHERE material_id=$1', [mismatchedMaterial.material_id]);
    assert.equal(mismatchMarker.rows[0].last_error_code, 'blob_hash_mismatch');
    assert.equal(digest((await blobs.getIfExists(mismatchedKey))!), digest(corrupt), 'a hash mismatch leaves bytes untouched');
    currentTime = new Date((await pool.query('SELECT retry_after FROM bb_storage_tombstones WHERE id=$1', [mismatchMarker.rows[0].id])).rows[0].retry_after).getTime() + 1;
    await blobs.put(mismatchedKey, pdf, PDF);
    const repairedReplay = await runStorageLifecycle(pool, blobs, oneDayPolicy);
    assert.equal(repairedReplay.purged, 1, 'a verified object can be purged after a transient mismatch is corrected');
    assert.equal(await blobs.getIfExists(mismatchedKey), null);

    const orphanProject = await createProject('Synthetic orphan upload project');
    const firstOrphan = await startUpload(orphanProject, 'orphan-one.pdf', false);
    const secondOrphan = await startUpload(orphanProject, 'orphan-two.pdf', false);
    const orphanIds = [firstOrphan.uploadId, secondOrphan.uploadId];
    await pool.query("UPDATE bb_uploads SET expires_at=now()-interval '3 hours' WHERE owner_user_id=$1 AND id=ANY($2::text[])", [activeOwner, orphanIds]);

    const lockedClient = await pool.connect();
    try {
      await lockedClient.query('BEGIN');
      await lockedClient.query('SELECT id FROM bb_uploads WHERE owner_user_id=$1 AND id=ANY($2::text[]) FOR UPDATE', [activeOwner, orphanIds]);
      const whileUploadLocked = await runStorageLifecycle(pool, blobs, { ...oneDayPolicy, batchSize: 1, now: () => new Date(currentTime + 4 * 60 * 60_000) });
      assert.equal(whileUploadLocked.orphanUploadsQueued, 0, 'SKIP LOCKED avoids racing a live upload/completion transaction');
      assert.equal(whileUploadLocked.claimed, 0);
    } finally {
      await lockedClient.query('ROLLBACK');
      lockedClient.release();
    }

    for (const expected of orphanIds) {
      const before = await pool.query('SELECT state FROM bb_uploads WHERE id=$1', [expected]);
      assert.equal(before.rows[0].state, 'received');
    }
    let cleanup = await runStorageLifecycle(pool, blobs, { ...oneDayPolicy, batchSize: 1, now: () => new Date(currentTime + 4 * 60 * 60_000) });
    assert.equal(cleanup.orphanUploadsQueued, 1, 'orphan selection is bounded to one upload per batch');
    assert.equal(cleanup.claimed, 1);
    let orphanRows = await pool.query('SELECT u.id,u.state,t.state AS tombstone_state FROM bb_uploads u LEFT JOIN bb_storage_tombstones t ON t.upload_id=u.id WHERE u.owner_user_id=$1 AND u.id=ANY($2::text[]) ORDER BY u.id', [activeOwner, orphanIds]);
    assert.equal(orphanRows.rows.filter(row => row.tombstone_state === 'purged').length, 1);
    assert.equal(orphanRows.rows.filter(row => row.tombstone_state === null && row.state === 'received').length, 1);
    cleanup = await runStorageLifecycle(pool, blobs, { ...oneDayPolicy, batchSize: 1, now: () => new Date(currentTime + 4 * 60 * 60_000) });
    assert.equal(cleanup.orphanUploadsQueued, 1);
    assert.equal(cleanup.claimed, 1);
    orphanRows = await pool.query('SELECT u.id,u.state,t.state AS tombstone_state FROM bb_uploads u JOIN bb_storage_tombstones t ON t.upload_id=u.id WHERE u.owner_user_id=$1 AND u.id=ANY($2::text[]) ORDER BY u.id', [activeOwner, orphanIds]);
    assert.equal(orphanRows.rows.length, 2);
    assert.ok(orphanRows.rows.every(row => row.state === 'purged' && row.tombstone_state === 'purged'));
    await assert.rejects(
      pool.query("UPDATE bb_uploads SET state='received' WHERE id=ANY($1::text[])", [orphanIds]),
      isConstraintViolation
    );
    for (const uploadId of orphanIds) assert.equal(await blobs.getIfExists(`users/${activeOwner}/projects/${orphanProject}/uploads/${uploadId}`), null);
  } finally {
    await app.close();
    await pool.end();
    await BlobServiceClient.fromConnectionString(blobConnection!).getContainerClient(containerName).deleteIfExists();
  }
});

function connectionDetails(connectionString: string) {
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.slice(1));
  return { url, database, host: url.hostname, port: url.port || '5432', username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
}

function runPostgresUtility(binary: string, connectionString: string, database: string, args: string[]) {
  const details = connectionDetails(connectionString);
  const commandArgs = [
    '--no-password', '--host', details.host, '--port', details.port,
    ...(details.username ? ['--username', details.username] : []), '--dbname', database, ...args
  ];
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.RESTORE_DATABASE_URL;
  delete env.BB_TEST_DATABASE_URL;
  delete env.PGPASSWORD;
  if (details.password) env.PGPASSWORD = details.password;
  return new Promise<void>((resolve, reject) => {
    const child = spawn(binary, commandArgs, { env, stdio: 'ignore' });
    child.once('error', () => reject(new Error(`${binary} is unavailable`)));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${binary} exited with status ${String(code)}`)));
  });
}

async function copySyntheticBlobContainer(connectionString: string, sourceName: string, targetName: string) {
  const service = BlobServiceClient.fromConnectionString(connectionString);
  const source = service.getContainerClient(sourceName);
  const target = service.getContainerClient(targetName);
  await target.createIfNotExists();
  for await (const item of source.listBlobsFlat()) {
    const bytes = await source.getBlockBlobClient(item.name).downloadToBuffer();
    await target.getBlockBlobClient(item.name).uploadData(bytes, {
      blobHTTPHeaders: item.properties.contentType ? { blobContentType: item.properties.contentType } : undefined
    });
  }
}

test('PostgreSQL/Azurite dump, restore, Blob copy and tombstone replay preserve pins without resurrection', { skip: !connection || !blobConnection }, async () => {
  const connection = restoreConnection;
  const pool = new Pool({ connectionString: connection });
  const ownerId = `restore-${randomUUID()}`;
  const sourceContainer = `bb-restore-${randomUUID().replaceAll('-', '')}`;
  const restoredContainer = `bb-isolated-${randomUUID().replaceAll('-', '')}`;
  const sourceBlobs = azureBlobs(blobConnection!, sourceContainer);
  // Restore compatibility includes historical single-Word runs and their one immutable delivery-evidence row.
  const app = createServer({ pool, blobs: sourceBlobs, principal: async () => ({ userId: ownerId, csrfVerified: true }), allowedOrigin: origin, enableSyntheticQueue: true,
    historicalBillingFixture: true, enablePaidAuthoring: false });
  const send = (method: string, url: string, payload?: unknown, extra: Record<string, string> = {}) => app.inject({ method: method as any, url, headers: { origin, ...extra }, payload: payload as any });
  const tempDir = await mkdtemp(join(tmpdir(), 'bondbuddy-storage-restore-'));
  const dumpPath = join(tempDir, 'bondbuddy.dump');
  const restoreDatabase = `bb_restore_${randomUUID().replaceAll('-', '')}`;
  const base = connectionDetails(connection!);
  const restoreUrl = new URL(connection!);
  restoreUrl.pathname = `/${restoreDatabase}`;
  const adminPool = new Pool({ connectionString: connection });
  const sourceContainerClient = BlobServiceClient.fromConnectionString(blobConnection!).getContainerClient(sourceContainer);
  const restoredContainerClient = BlobServiceClient.fromConnectionString(blobConnection!).getContainerClient(restoredContainer);

  try {
    const created = await send('POST', '/api/v1/projects', { name: 'Synthetic restore project', kind: 'update', issuer_name: null, market: null, offering: null });
    assert.equal(created.statusCode, 201, created.body);
    const projectId = created.json().project_id as string;

    const addMaterial = async (name: string) => {
      const pdf = pdfSample({tag:name});
      const upload = await send('POST', `/api/v1/projects/${projectId}/materials/uploads`, { filename: name, media_type: PDF, byte_size: pdf.length, sha256: digest(pdf), role: 'audit' });
      assert.equal(upload.statusCode, 201, upload.body);
      assert.equal((await send('PUT', upload.json().upload_url, pdf, { 'content-type': 'application/octet-stream' })).statusCode, 204);
      const completed = await send('POST', `/api/v1/projects/${projectId}/materials/uploads/${upload.json().upload_id}/complete`, { byte_size: pdf.length, sha256: digest(pdf) });
      assert.equal(completed.statusCode, 200, completed.body);
      return { uploadId: upload.json().upload_id as string, materialId: completed.json().material_id as string };
    };
    const referenced = await addMaterial('restore-referenced.pdf');
    const input = await send('POST', `/api/v1/projects/${projectId}/input-revisions`, { draft_revision: 1, material_versions: [{ material_id: referenced.materialId, material_version: 1 }], requirement_message_ids: [] });
    assert.equal(input.statusCode, 201, input.body);
    const inputDto = input.json();
    const queued = await send('POST', '/api/v1/runs/execute', {
      execution_request_id: `synthetic-word-restore-${randomUUID()}`, project_id: projectId,
      input_revision: inputDto.input_revision, input_hash: inputDto.input_hash, task_kind: 'update',
      input_manifest_ref: 'synthetic-restore-manifest', storage_origin: 'cloud', workspace_id: 'synthetic-restore-worker'
    });
    assert.equal(queued.statusCode, 202, queued.body);
    const wordLease = await claim(pool, 60);
    assert.ok(wordLease);assert.equal(wordLease.runId, queued.json().run_id);
    const wordBytes = makeSyntheticDocxFixture();
    const wordPromotion = await promoteWordArtifact(pool, wordLease, wordBytes, sourceBlobs);
    assert.equal(wordPromotion.status, 'available');
    await finish(pool, wordLease, 'succeeded', { artifactId: wordPromotion.artifactId, artifactVersion: wordPromotion.artifactVersion, blobs: sourceBlobs });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM bb_word_delivery_evidence WHERE owner_user_id=$1 AND run_id=$2', [ownerId, wordLease.runId])).rows[0].n, 1);
    const deleted = await addMaterial('restore-deleted.pdf');
    assert.equal((await send('DELETE', `/api/v1/projects/${projectId}/materials/${deleted.materialId}`)).statusCode, 204);
    const marker = await pool.query("SELECT id,object_key,state FROM bb_storage_tombstones WHERE owner_user_id=$1 AND material_id=$2", [ownerId, deleted.materialId]);
    assert.equal(marker.rowCount, 1);
    assert.equal(marker.rows[0].state, 'pending');
    assert.ok(await sourceBlobs.getIfExists(marker.rows[0].object_key));

    await app.close();
    const dbCreated = await adminPool.query(`CREATE DATABASE "${restoreDatabase}"`);
    assert.ok(dbCreated);
    await runPostgresUtility('pg_dump', connection!, base.database, ['--format=custom', '--file', dumpPath]);
    await runPostgresUtility('pg_restore', connection!, restoreDatabase, ['--exit-on-error', '--no-owner', '--no-privileges', dumpPath]);
    await copySyntheticBlobContainer(blobConnection!, sourceContainer, restoredContainer);

    const childEnv = { ...process.env };
    childEnv.DATABASE_URL = connection!;
    childEnv.RESTORE_DATABASE_URL = restoreUrl.toString();
    childEnv.AZURE_STORAGE_CONNECTION_STRING = blobConnection!;
    childEnv.BB_STORAGE_CONTAINER = sourceContainer;
    childEnv.BB_STORAGE_RESTORE_CONTAINER = restoredContainer;
    childEnv.BB_STORAGE_VERIFY_OWNER = ownerId;
    childEnv.BB_STORAGE_EXPECTED_TOMBSTONE_ID = marker.rows[0].id as string;
    childEnv.BB_STORAGE_PURGE_ENABLED = 'true';
    childEnv.BB_STORAGE_MATERIAL_RETENTION_DAYS = '0';
    childEnv.BB_STORAGE_ORPHAN_GRACE_HOURS = '0';
    const verifierPath = fileURLToPath(new URL('../../../db/verify-storage-restore.mjs', import.meta.url));
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [verifierPath], { cwd: process.cwd(), env: childEnv, stdio: ['ignore', 'ignore', 'inherit'] });
      child.once('error', () => reject(new Error('Storage restore verifier could not start')));
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Storage restore verifier exited with status ${String(code)}`)));
    });

    const restored = new Pool({ connectionString: restoreUrl.toString() });
    try {
      const restoredEvidence = await restored.query(`SELECT e.*,a.object_key,a.sha256 AS artifact_sha256,a.delivery_status AS artifact_delivery_status
        FROM bb_word_delivery_evidence e JOIN bb_artifact_versions a
          ON a.owner_user_id=e.owner_user_id AND a.run_id=e.run_id AND a.id=e.artifact_id AND a.version=e.artifact_version AND a.word_delivery_evidence_id=e.id
        WHERE e.owner_user_id=$1 AND e.run_id=$2`, [ownerId, wordLease.runId]);
      assert.equal(restoredEvidence.rowCount, 1, 'Word delivery evidence survives PostgreSQL restore');
      const restoredBlobs = azureBlobs(blobConnection!, restoredContainer);
      const restoredWord = await restoredBlobs.getIfExistsBounded(restoredEvidence.rows[0].object_key, 64 * 1024 * 1024);
      assert.ok(restoredWord, 'the copied private Word Blob survives storage restore');
      assert.equal(restoredWord.length, Number(restoredEvidence.rows[0].byte_size));
      assert.equal(digest(restoredWord), restoredEvidence.rows[0].candidate_sha256.trim());
      assert.equal(restoredEvidence.rows[0].readback_sha256.trim(), restoredEvidence.rows[0].candidate_sha256.trim());
      assert.equal(restoredEvidence.rows[0].artifact_sha256.trim(), restoredEvidence.rows[0].candidate_sha256.trim());
      assert.equal(restoredEvidence.rows[0].artifact_delivery_status, 'available');
      await assert.rejects(restored.query('UPDATE bb_word_delivery_evidence SET byte_size=byte_size+1 WHERE id=$1', [restoredEvidence.rows[0].id]), isConstraintViolation);
      await assert.rejects(restored.query('DELETE FROM bb_word_delivery_evidence WHERE id=$1', [restoredEvidence.rows[0].id]), isConstraintViolation);
      const markerAfterReplay = await restored.query('SELECT state,purged_at FROM bb_storage_tombstones WHERE id=$1', [marker.rows[0].id]);
      assert.equal(markerAfterReplay.rows[0].state, 'purged');
      assert.ok(markerAfterReplay.rows[0].purged_at);
      assert.equal(await restoredBlobs.getIfExists(marker.rows[0].object_key), null);
      const restoredApp = createServer({ pool: restored, blobs: restoredBlobs, principal: async () => ({ userId: ownerId, csrfVerified: true }), allowedOrigin: origin });
      try {
        assert.equal((await restoredApp.inject(`/api/v1/projects/${projectId}/materials/${deleted.materialId}`)).statusCode, 404);
        assert.equal((await restoredApp.inject(`/api/v1/projects/${projectId}/materials/${deleted.materialId}/download`)).statusCode, 404);
        assert.equal((await restoredApp.inject(`/api/v1/projects/${projectId}/materials/${referenced.materialId}/download`)).statusCode, 200);
        const wordMeta = await restoredApp.inject(`/api/v1/artifacts/${wordPromotion.artifactId}`);
        assert.equal(wordMeta.statusCode, 200, wordMeta.body);
        const wordDownload = await restoredApp.inject(wordMeta.json().download_url);
        assert.equal(wordDownload.statusCode, 200, wordDownload.body);
        assert.equal(digest(wordDownload.rawPayload), wordPromotion.sha256);
      } finally {
        await restoredApp.close();
      }
    } finally {
      await restored.end();
    }
  } finally {
    await app.close().catch(() => undefined);
    await adminPool.query(`DROP DATABASE IF EXISTS "${restoreDatabase}" WITH (FORCE)`).catch(() => undefined);
    await adminPool.end();
    await pool.end();
    await sourceContainerClient.deleteIfExists().catch(() => undefined);
    await restoredContainerClient.deleteIfExists().catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
  }
});
