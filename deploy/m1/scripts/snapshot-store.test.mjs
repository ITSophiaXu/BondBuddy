import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import COS from 'cos-nodejs-sdk-v5';
import { snapshotStore } from './snapshot-store.mjs';
import { exportApplicationSnapshot, importApplicationSnapshot } from './snapshot-workflow.mjs';

test('COS application snapshot lists and reads version-pinned objects', async () => {
  const data = new Map();
  const seenMatch = [];
  const server = createServer(async (request, response) => {
    const key = decodeURIComponent(new URL(request.url || '/', `http://${request.headers.host}`).pathname.slice(1));
    if (!key && request.method === 'HEAD') { response.writeHead(200); response.end(); return; }
    if (!key && request.method === 'GET') {
      const contents = [...data].map(([name, bytes]) => `<Contents><Key>${name}</Key><Size>${bytes.length}</Size><ETag>"fixture-etag"</ETag><LastModified>2026-11-27T00:00:00.000Z</LastModified></Contents>`).join('');
      response.writeHead(200, { 'Content-Type': 'application/xml' });
      response.end(`<?xml version="1.0"?><ListBucketResult><Name>app-123</Name><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`); return;
    }
    const bytes = data.get(key);
    if (request.method === 'PUT') {
      const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      data.set(key, Buffer.concat(chunks)); response.writeHead(200, { ETag: '"fixture-etag"' }); response.end(); return;
    }
    if (request.method === 'HEAD') {
      response.writeHead(bytes ? 200 : 404, bytes ? { ETag: '"fixture-etag"', 'Content-Length': bytes.length, 'Content-Type': 'text/plain' } : {}); response.end(); return;
    }
    if (request.method === 'GET' && bytes) {
      if (request.headers['if-match']) seenMatch.push(request.headers['if-match']);
      if (request.headers['if-match'] && request.headers['if-match'] !== '"fixture-etag"') { response.writeHead(412); response.end(); return; }
      response.writeHead(200, { 'Content-Length': bytes.length }); response.end(bytes); return;
    }
    response.writeHead(404); response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'bb-cos-snapshot-'));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const client = new COS({ SecretId: 'synthetic-id', SecretKey: 'synthetic-key',
      Protocol: 'http:', Ip: `127.0.0.1:${address.port}`, Timeout: 5000 });
    const env = { BB_STORAGE_PROVIDER: 'cos', BB_COS_SECRET_ID: 'synthetic-id', BB_COS_SECRET_KEY: 'synthetic-key',
      BB_COS_BUCKET: 'app-123', BB_COS_REGION: 'ap-beijing' };
    const storeFor = snapshotStore(env, { cosClient: client });
    assert.throws(() => storeFor('other-container'), /No COS bucket mapping/);
    const store = storeFor('bondbuddy-private');
    await store.ready();
    const file = join(dir, 'proof'); await writeFile(file, 'synthetic snapshot');
    await store.putFile('users/a/proof', file, 'text/plain');
    const items = []; for await (const item of store.list()) items.push(item);
    assert.equal(items.length, 1);
    assert.equal(items[0].contentType, 'text/plain');
    const chunks = []; for await (const chunk of await store.readStream(items[0].key, items[0].etag)) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), 'synthetic snapshot');
    const root = join(dir, 'snapshot');
    assert.deepEqual(await exportApplicationSnapshot(root, ['bondbuddy-private'], storeFor), { exported: 1, containers: 1 });
    data.clear();
    assert.deepEqual(await importApplicationSnapshot(root, 'bb-backups', storeFor), { imported: 1 });
    assert.equal(data.get('users/a/proof')?.toString(), 'synthetic snapshot');
    assert.deepEqual(seenMatch, ['"fixture-etag"', '"fixture-etag"']);
  } finally { await rm(dir, { recursive: true, force: true }); server.close(); await once(server, 'close'); }
});
