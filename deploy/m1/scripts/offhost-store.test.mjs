import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import COS from 'cos-nodejs-sdk-v5';
import { offhostStore } from './offhost-store.mjs';

const config = { BB_STORAGE_PROVIDER: 'cos', BB_COS_SECRET_ID: 'synthetic-id', BB_COS_SECRET_KEY: 'synthetic-key',
  BB_COS_BUCKET: 'app-123', BB_COS_BACKUP_BUCKET: 'backups-123', BB_COS_REGION: 'ap-beijing' };

test('COS off-host backup keeps files and completion manifest in a separate bucket', async () => {
  const data = new Map();
  const requests = [];
  const server = createServer(async (request, response) => {
    const key = decodeURIComponent(new URL(request.url || '/', `http://${request.headers.host}`).pathname.slice(1));
    requests.push({ method: request.method, host: request.headers.host, key,
      encryption: request.headers['x-cos-server-side-encryption'] });
    if (!key && request.method === 'HEAD') { response.writeHead(200); response.end(); return; }
    const bytes = data.get(key);
    if (request.method === 'HEAD') { response.writeHead(bytes ? 200 : 404, bytes ? { 'Content-Length': bytes.length } : {}); response.end(); return; }
    if (request.method === 'PUT') {
      const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      data.set(key, Buffer.concat(chunks)); response.writeHead(200, { ETag: '"synthetic"' }); response.end(); return;
    }
    if (request.method === 'GET' && bytes) { response.writeHead(200, { 'Content-Length': bytes.length }); response.end(bytes); return; }
    response.writeHead(404); response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'bb-cos-offhost-'));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = new COS({ SecretId: 'synthetic-id', SecretKey: 'synthetic-key',
      Protocol: 'http:', Ip: `127.0.0.1:${address.port}`, Timeout: 5000 });
    const store = offhostStore(config, { cosClient: client });
    await store.ready();
    assert.equal(await store.exists('id/offhost-manifest.json'), false);
    const file = join(dir, 'db.dump');
    const source = Buffer.from('synthetic database backup');
    const sha = createHash('sha256').update(source).digest('hex');
    await writeFile(file, source);
    await store.uploadFile('id/db.dump', file, sha);
    const chunks = []; for await (const chunk of await store.readStream('id/db.dump')) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), source);
    const manifest = Buffer.from('{"backup_id":"id"}');
    await store.uploadData('id/offhost-manifest.json', manifest);
    assert.equal(await store.exists('id/offhost-manifest.json'), true);
    assert.deepEqual(await store.readBuffer('id/offhost-manifest.json'), manifest);
    assert.ok(requests.every(entry => entry.host?.startsWith('backups-123.')));
    assert.ok(requests.filter(entry => entry.method === 'PUT').every(entry => entry.encryption === 'AES256'));
  } finally {
    await rm(dir, { recursive: true, force: true });
    server.closeAllConnections(); server.close(); await once(server, 'close');
  }
});

test('COS off-host configuration rejects shared bucket and incomplete backup identity', () => {
  assert.throws(() => offhostStore({ ...config, BB_COS_BACKUP_BUCKET: 'app-123' }), /separate bucket/);
  assert.throws(() => offhostStore({ ...config, BB_COS_BACKUP_SECRET_ID: 'other' }), /credential pair is incomplete/);
  assert.throws(() => offhostStore({ ...config, BB_COS_BACKUP_BUCKET: '' }), /credentials, bucket and region required/);
});
