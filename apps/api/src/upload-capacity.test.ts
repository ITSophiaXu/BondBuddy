import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import { M1_UPLOAD_LIMITS } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { azureBlobs, digest } from './data.js';

const connection = process.env.BB_TEST_DATABASE_URL;
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const enabled = process.env.BB_RUN_UPLOAD_CAPACITY_TESTS === '1';
// Explicit opt-in: sends and saves 500 MiB of synthetic bytes. Use a disposable local DB/Blob only.
test('#12 HTTP transport persists five real 100 MiB files and enforces 500 MiB without duplicate jobs', {
  skip: !enabled || !connection || !blobConnection, timeout: 600_000,
}, async t => {
  const pool = new Pool({ connectionString: connection });
  const owner = `capacity-${randomUUID()}`;
  const container = `bb-capacity-${randomUUID().replaceAll('-', '')}`;
  const blobs = azureBlobs(blobConnection!, container);
  const app = createServer({ pool, blobs, principal: async () => ({ userId: owner, csrfVerified: true }), allowedOrigin: 'http://bondbuddy.test' });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const request = async (method: string, path: string, body?: unknown) => {
    const bytes = Buffer.isBuffer(body);
    const response = await fetch(new URL(path, address), { method, headers: { origin: 'http://bondbuddy.test',
      'content-type': bytes ? 'application/octet-stream' : 'application/json' },
      body: body === undefined ? undefined : bytes ? new Uint8Array(body as Buffer) : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  };
  const samples: Array<{ size: number; uploadMs: number; saveMs: number }> = [];
  try {
    const project = await request('POST', '/api/v1/projects', { name: 'Synthetic 500 MiB capacity test', kind: 'update', issuer_name: null, market: 'sse', offering: 'private' });
    assert.equal(project.status, 201);
    const path = `/api/v1/projects/${project.data.project_id}/materials/uploads`;
    const bytes = Buffer.alloc(M1_UPLOAD_LIMITS.fileBytes, 0x61);
    const upload = async (payload: Buffer, name: string) => {
      const declaration = { filename: name, media_type: 'text/plain', byte_size: payload.length, sha256: digest(payload), role: 'audit' };
      const started = await request('POST', path, declaration); assert.equal(started.status, 201, JSON.stringify(started));
      const before = performance.now();
      const put = await request('PUT', started.data.upload_url, payload); assert.equal(put.status, 204, JSON.stringify(put));
      const transferred = performance.now();
      const completed = await request('POST', `${path}/${started.data.upload_id}/complete`, { byte_size: payload.length, sha256: declaration.sha256 });
      samples.push({ size: payload.length, uploadMs: Math.round(transferred - before), saveMs: Math.round(performance.now() - transferred) });
      return completed;
    };
    let last: any;
    for (let i = 0; i < 5; i++) {
      bytes[0] = 0x61 + i;
      last = await upload(bytes, `synthetic-${i}.txt`);
      assert.equal(last.status, 200, JSON.stringify(last));
      assert.equal(last.data.byte_size, M1_UPLOAD_LIMITS.fileBytes);
      const restored = await blobs.get(`users/${owner}/projects/${project.data.project_id}/uploads/${last.data.upload_id}`);
      assert.equal(restored.length, bytes.length); assert.equal(digest(restored), digest(bytes));
    }
    const duplicate = await upload(bytes, 'renamed-final.txt');
    assert.equal(duplicate.status, 200); assert.equal(duplicate.data.material_id, last.data.material_id);
    const extra = await upload(Buffer.from('synthetic over-capacity extra byte payload'), 'over-project-limit.txt');
    assert.equal(extra.status, 422); assert.equal(extra.data.code, 'VALIDATION_FAILED');
    const tooLarge = await request('POST', path, { filename: 'over-file-limit.txt', media_type: 'text/plain',
      byte_size: M1_UPLOAD_LIMITS.fileBytes + 1, sha256: 'a'.repeat(64), role: 'audit' });
    assert.equal(tooLarge.status, 422); assert.equal(tooLarge.data.code, 'VALIDATION_FAILED');
    assert.match(tooLarge.data.message, /limit/i);
    const rows = (await pool.query('SELECT count(*)::int n,sum(byte_size)::bigint bytes FROM bb_material_versions WHERE owner_user_id=$1', [owner])).rows[0];
    assert.equal(rows.n, 5); assert.equal(Number(rows.bytes), M1_UPLOAD_LIMITS.projectBytes);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_jobs WHERE owner_user_id=$1 AND job_type='parse'", [owner])).rows[0].n, 5);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1', [owner])).rows[0].n, 0);
    t.diagnostic(JSON.stringify({ synthetic: true, storage: 'local Azurite', totalPersisted: Number(rows.bytes), samples }));
  } finally {
    await app.close(); await pool.end();
    await BlobServiceClient.fromConnectionString(blobConnection!).getContainerClient(container).deleteIfExists();
  }
});
