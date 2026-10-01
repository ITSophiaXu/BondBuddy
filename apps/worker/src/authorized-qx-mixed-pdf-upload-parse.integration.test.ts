import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BlobServiceClient } from '@azure/storage-blob';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { azureBlobs } from '@bondbuddy/api/data';
import { isolatedTestDatabase } from './test-database.js';

type RegisteredPdf = {
  readonly file_id: string;
  readonly path: string;
  readonly original_filename: string;
  readonly upload_role: string;
  readonly media_type: string;
  readonly bytes: number;
  readonly sha256: string;
};
type Manifest = { readonly cases: readonly { readonly case_id: string; readonly files: readonly RegisteredPdf[] }[] };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const manifestRoot = join(repoRoot, 'tests/samples/2026-09-25');
const optedIn = process.env.BB_RUN_AUTHORIZED_QX_UPLOAD_PARSE === '1';
const databaseUrl = optedIn ? await isolatedTestDatabase('AUTHORIZED_QX_UPLOAD_PARSE_TEST_DATABASE_URL') : undefined;
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const PDF = 'application/pdf';
const FILE_ID = 'qx-202606-02';
const EXPECTED_BYTES = 6_960_431;
const EXPECTED_SHA256 = 'f6ab6dae2d70f09390915ea9d3eeb7a755df51d3307f1eb204ae1243ed971844';
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('authorized qx-202606-02 signed-widget PDF fails closed at public upload without Blob/material/job', {
  skip: !optedIn ? 'set BB_RUN_AUTHORIZED_QX_UPLOAD_PARSE=1 to run the authorized PDF upload security regression'
    : !databaseUrl ? 'set AUTHORIZED_QX_UPLOAD_PARSE_TEST_DATABASE_URL or BB_TEST_DATABASE_URL to a disposable migrated PostgreSQL 16 template'
      : !blobConnection ? 'set BB_TEST_AZURITE_CONNECTION_STRING for a disposable Azurite instance' : false,
}, async () => {
  assert.ok(databaseUrl && blobConnection);
  const manifest = JSON.parse(await readFile(join(manifestRoot, 'manifest.json'), 'utf8')) as Manifest;
  const registered = manifest.cases.find(item => item.case_id === 'qx-202606')?.files.find(item => item.file_id === FILE_ID);
  assert.ok(registered, 'the authorized PDF must be registered in the sample manifest');
  assert.deepEqual([registered.upload_role, registered.media_type, registered.bytes, registered.sha256],
    ['audit', PDF, EXPECTED_BYTES, EXPECTED_SHA256]);
  const sourcePath = resolve(manifestRoot, registered.path);
  assert.ok(sourcePath.startsWith(`${resolve(manifestRoot)}/`), 'manifest path remains inside the authorized sample directory');
  const sourceBytes = await readFile(sourcePath);
  assert.equal(sourceBytes.byteLength, EXPECTED_BYTES, 'registered source byte size');
  assert.equal(sha256(sourceBytes), EXPECTED_SHA256, 'registered source SHA-256');

  const pool = new Pool({ connectionString: databaseUrl });
  const suffix = randomUUID().replaceAll('-', '');
  const owner = `qx-upload-owner-${suffix}`;
  const foreignOwner = `qx-upload-foreign-${suffix}`;
  let activeOwner = owner;
  const containerName = `bb-qx-upload-${suffix}`;
  const blobs = azureBlobs(blobConnection, containerName);
  const app = createServer({ pool, blobs, allowedOrigin: 'http://bondbuddy.test',
    principal: async () => ({ userId: activeOwner, csrfVerified: true }) });
  const send = (method: string, url: string, payload?: unknown) => app.inject({
    method: method as never, url, payload: payload as never,
    headers: { origin: 'http://bondbuddy.test', ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}) },
  });
  try {
    const version = await pool.query<{ server_version_num: string }>('SHOW server_version_num');
    assert.ok(Number(version.rows[0]!.server_version_num) >= 160000 && Number(version.rows[0]!.server_version_num) < 170000,
      'this regression is PostgreSQL 16 only');
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2),($3,$4)', [
      owner, `q${suffix.slice(0, 30)}`, foreignOwner, `f${suffix.slice(0, 30)}`,
    ]);
    const created = await send('POST', '/api/v1/projects', {
      name: 'Authorized mixed PDF upload security regression', kind: 'update', issuer_name: null, market: null, offering: null,
    });
    assert.equal(created.statusCode, 201, 'authenticated owner creates a project');
    const projectId = created.json().project_id as string;
    const declaration = { byte_size: EXPECTED_BYTES, sha256: EXPECTED_SHA256 };
    const started = await send('POST', `/api/v1/projects/${projectId}/materials/uploads`, {
      ...declaration, filename: registered.original_filename, role: 'audit', media_type: PDF,
    });
    assert.equal(started.statusCode, 201, 'owner starts a public upload');
    const session = started.json() as { upload_id: string; upload_url: string };
    assert.ok(session.upload_url);

    const rejected = await send('PUT', session.upload_url, sourceBytes);
    assert.equal(rejected.statusCode, 415, 'interactive signature widgets are rejected by the normal upload inspection policy');
    assert.equal(rejected.json().code, 'MATERIAL_FORMAT_UNSUPPORTED');
    const repeated = await send('PUT', session.upload_url, sourceBytes);
    assert.equal(repeated.statusCode, 415, 'retrying the exact same bytes cannot bypass inspection');
    assert.equal(repeated.json().code, 'MATERIAL_FORMAT_UNSUPPORTED');

    activeOwner = foreignOwner;
    assert.equal((await send('GET', `/api/v1/projects/${projectId}`)).statusCode, 404,
      'foreign account cannot read the project');
    assert.equal((await send('PUT', session.upload_url, sourceBytes)).statusCode, 404,
      'foreign account cannot use the rejected owner upload session');
    activeOwner = owner;

    const upload = await pool.query<{ state: string; object_key: string }>(
      'SELECT state,object_key FROM bb_uploads WHERE owner_user_id=$1 AND project_id=$2 AND id=$3', [owner, projectId, session.upload_id]);
    assert.equal(upload.rowCount, 1);
    assert.equal(upload.rows[0]!.state, 'uploading', 'rejected bytes never advance upload to received');
    assert.equal(await blobs.exists(upload.rows[0]!.object_key), false, 'rejected bytes never reach private Blob storage');

    const completion = await send('POST', `/api/v1/projects/${projectId}/materials/uploads/${session.upload_id}/complete`, declaration);
    assert.equal(completion.statusCode, 422, 'completion remains invalid until bytes passed inspection');
    assert.equal(completion.json().code, 'MATERIAL_UNREADABLE');
    const materials = await pool.query(
      'SELECT 1 FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2', [owner, projectId]);
    assert.equal(materials.rowCount, 0, 'no material revision is persisted');
    const jobs = await pool.query(
      "SELECT 1 FROM bb_jobs WHERE owner_user_id=$1 AND project_id=$2 AND job_type='parse'", [owner, projectId]);
    assert.equal(jobs.rowCount, 0, 'no durable parse job is queued');
  } finally {
    activeOwner = owner;
    await app.close();
    await pool.end();
    await BlobServiceClient.fromConnectionString(blobConnection).getContainerClient(containerName).deleteIfExists();
  }
});
