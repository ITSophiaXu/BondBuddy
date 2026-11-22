import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startModelGateway } from './model-gateway.js';

const authorization = 'Bearer synthetic-origin-test-only';
const payload = Buffer.from('{ "model": "synthetic", "input": "private synthetic text" }');
const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
async function bytes(stream: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// Set path through ClientRequest options: using new URL() here would normalize away
// the dangerous request target before it reaches the gateway under test.
function sendRaw(baseUrl: string, path: string, method = 'POST') {
  const address = new URL(baseUrl);
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const req = request(
      {
        hostname: address.hostname,
        port: address.port,
        path,
        method,
        headers: {
          authorization,
          'content-type': 'application/json',
          'content-length': payload.length,
        },
      },
      (res) => {
        bytes(res).then((body) => resolve({ status: res.statusCode ?? 0, body }), reject);
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('gateway rejects authority changes and malformed paths before forwarding any credentials', async (t) => {
  let configuredHits = 0,
    otherHits = 0;
  const configured = createServer((req, res) => {
    configuredHits++;
    req.resume();
    res.end('configured');
  });
  const other = createServer((req, res) => {
    otherHits++;
    req.resume();
    res.end('other');
  });
  const configuredPort = await listen(configured),
    otherPort = await listen(other);
  t.after(async () => {
    await close(configured);
    await close(other);
  });
  const otherHost = '127.0.0.1:' + otherPort;
  const invalid = [
    '/\\' + otherHost + '/responses',
    '//' + otherHost + '/responses',
    'http://' + otherHost + '/responses',
    '/%5c%5c' + otherHost + '/responses',
    '/responses/../models',
    '/responses/%2e%2e/models',
    '/../responses',
    '/responses\\compact',
    '/responses%2fcompact',
    '/%72esponses',
    '/responses#fragment',
    '/responses?trace=#fragment',
    '/responses/compact/extra',
    '/v1/responses',
    '/models',
    '/',
  ];
  for (const prefix of ['', '/v1']) {
    const gateway = await startModelGateway({
      upstreamBaseUrl: 'http://127.0.0.1:' + configuredPort + prefix,
    });
    try {
      for (const path of invalid) {
        const response = await sendRaw(gateway.baseUrl, path);
        assert.equal(
          response.status,
          400,
          'reject raw target ' + path + ' with base prefix ' + prefix,
        );
        assert.equal(JSON.parse(response.body.toString()).error.code, 'PATH_INVALID');
        assert.equal(configuredHits, 0, 'invalid paths never reach even the configured origin');
        assert.equal(otherHits, 0, 'no request or authorization reaches the other origin');
      }
      assert.equal(gateway.summary().gateway_rejected, invalid.length);
      assert.ok(
        gateway.records().every((r) => r.gateway_error === 'PATH_INVALID' && r.response === null),
      );
    } finally {
      await gateway.close();
    }
  }
});

test('responses and compact retain the configured base path, query, authorization, body and stream', async (t) => {
  const seen: {
    path: string | undefined;
    method: string | undefined;
    authorization: string | undefined;
    body: Buffer;
  }[] = [];
  const stream =
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_synthetic"}}\n\n';
  const upstream = createServer(async (req, res) => {
    seen.push({
      path: req.url,
      method: req.method,
      authorization: req.headers.authorization,
      body: await bytes(req),
    });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(stream);
  });
  const port = await listen(upstream);
  t.after(() => close(upstream));
  const query = '?trace=%2F%5C%23&api-version=synthetic&repeat=1&repeat=2';
  for (const prefix of ['', '/v1', '/custom/v1/']) {
    const gateway = await startModelGateway({
      upstreamBaseUrl: 'http://127.0.0.1:' + port + prefix,
    });
    try {
      for (const endpoint of ['/responses', '/responses/compact']) {
        for (const method of ['GET', 'POST']) {
          const response = await sendRaw(gateway.baseUrl, endpoint + query, method);
          assert.equal(response.status, 200);
          assert.equal(response.body.toString(), stream);
          assert.deepEqual(seen.at(-1), {
            path: prefix.replace(/\/+$/, '') + endpoint + query,
            method,
            authorization,
            body: payload,
          });
        }
      }
      assert.equal(gateway.summary().requests, 4);
      assert.equal(gateway.summary().gateway_rejected, 0);
    } finally {
      await gateway.close();
    }
  }
  assert.equal(seen.length, 12);
});
