import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import COS from 'cos-nodejs-sdk-v5';
import { cosBlobs } from './cos-storage.js';

test('COS SDK adapter sends version-pinned reads to a local protocol fixture', async () => {
  const data = new Map<string, Buffer>();
  const seenMatch: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const key = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const bytes = data.get(key);
    const etag = '"fixture-etag"';
    if (request.method === 'GET' && url.searchParams.has('versioning')) {
      response.writeHead(200, { 'Content-Type': 'application/xml' });
      response.end('<VersioningConfiguration/>');
    } else if (request.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      data.set(key, Buffer.concat(chunks));
      response.writeHead(200, { ETag: etag }); response.end();
    } else if (request.method === 'HEAD') {
      response.writeHead(bytes ? 200 : 404, bytes ? { ETag: etag, 'Content-Length': bytes.length } : {}); response.end();
    } else if (request.method === 'GET' && bytes) {
      seenMatch.push(String(request.headers['if-match'] ?? ''));
      if (request.headers['if-match'] !== etag) { response.writeHead(412); response.end(); return; }
      response.writeHead(200, { ETag: etag, 'Content-Length': bytes.length }); response.end(bytes);
    } else if (request.method === 'DELETE') {
      data.delete(key); response.writeHead(204); response.end();
    } else { response.writeHead(404); response.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server port unavailable');
    const client = new COS({ SecretId: 'synthetic-id', SecretKey: 'synthetic-key',
      Protocol: 'http:', Ip: `127.0.0.1:${address.port}`, Timeout: 5000 });
    const blobs = cosBlobs(client, 'test-123', 'ap-beijing');
    await blobs.put('users/a/file', Buffer.from('local fixture'), 'text/plain');
    assert.equal((await blobs.getIfExistsBounded('users/a/file', 100))?.toString(), 'local fixture');
    assert.deepEqual(seenMatch, ['"fixture-etag"']);
    await blobs.delete('users/a/file');
    assert.equal(data.has('users/a/file'), false);
  } finally { server.close(); await once(server, 'close'); }
});
