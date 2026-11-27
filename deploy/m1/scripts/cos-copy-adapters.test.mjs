import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import COS from 'cos-nodejs-sdk-v5';
import { copyCurrentObject } from './cos-copy-core.mjs';
import { cosMigrationTarget } from './cos-copy-adapters.mjs';

test('real COS SDK sends create-only PUT and pinned read to local protocol fixture', async () => {
  const data = new Map();
  const seen = [];
  const server = createServer(async (request, response) => {
    const key = decodeURIComponent(new URL(request.url || '/', `http://${request.headers.host}`).pathname.slice(1));
    if (!key && request.method === 'HEAD') { response.writeHead(200); response.end(); return; }
    if (request.method === 'HEAD') {
      const body = data.get(key);
      response.writeHead(body ? 200 : 404, body ? { ETag: '"fixture-v1"', 'Content-Length': body.length } : {}); response.end(); return;
    }
    if (request.method === 'PUT') {
      seen.push({ method: 'PUT', condition: request.headers['if-none-match'] });
      if (request.headers['if-none-match'] !== '*' || data.has(key)) { response.writeHead(412); response.end(); return; }
      const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      data.set(key, Buffer.concat(chunks)); response.writeHead(200, { ETag: '"fixture-v1"' }); response.end(); return;
    }
    if (request.method === 'GET') {
      seen.push({ method: 'GET', condition: request.headers['if-match'] });
      if (!data.has(key) || request.headers['if-match'] !== '"fixture-v1"') { response.writeHead(412); response.end(); return; }
      const body = data.get(key); response.writeHead(200, { 'Content-Length': body.length }); response.end(body); return;
    }
    response.writeHead(404); response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const client = new COS({ SecretId: 'synthetic-id', SecretKey: 'synthetic-key',
      Protocol: 'http:', Ip: `127.0.0.1:${address.port}`, Timeout: 5000 });
    const target = cosMigrationTarget({ secretId: 'synthetic-id', secretKey: 'synthetic-key',
      bucket: 'app-123', region: 'ap-beijing', client });
    await target.ready();
    const source = { async open() { return Readable.from([Buffer.from('synthetic copy')]); } };
    const entry = { key: 'users/a/proof', bytes: 14, etag: '"azure-v1"', contentType: 'text/plain' };
    const record = await copyCurrentObject({ source, target, entry });
    assert.equal(record.status, 'copied');
    assert.equal(data.get(entry.key).toString(), 'synthetic copy');
    assert.deepEqual(seen, [{ method: 'PUT', condition: '*' }, { method: 'GET', condition: '"fixture-v1"' }]);
  } finally { server.close(); await once(server, 'close'); }
});
