import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SseBondProjectAdapter, type DiscoveredItem } from './library-sources.js';

const pdfItem = { locator: 'https://static.sse.com.cn/bond/synthetic.pdf' } as DiscoveredItem;
const delayed = (signal: AbortSignal, ms: number) => new Promise<never>((_, reject) => {
  const timer = setTimeout(() => reject(new Error('late body')), ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

test('SSE JSON and PDF timeouts include body consumption after response headers', async () => {
  const json = new SseBondProjectAdapter({ timeoutMs: 25, delayMs: 0, fetch: async (_url, init) => ({
    ok: true, status: 200, body: null, json: () => delayed(init!.signal!, 500),
  }) });
  const start = Date.now();
  await assert.rejects(json.discover({}, {}), { code: 'LIBRARY_SOURCE_UNREACHABLE', retryable: true });
  assert.ok(Date.now() - start < 400);

  const pdf = new SseBondProjectAdapter({ timeoutMs: 25, fetch: async (_url, init) => ({
    ok: true, status: 200, json: async () => ({}), body: new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('%PDF-'));
        init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true });
      },
    }),
  }) });
  await assert.rejects(pdf.fetch(pdfItem), { code: 'LIBRARY_FETCH_FAILED', detail: 'timeout' });
});

test('SSE PDF stops reading on first chunk beyond 150 MiB', async () => {
  let pulled = 0;
  let cancelled = false;
  const chunk = new Uint8Array(76 * 1024 * 1024);
  chunk.set(new TextEncoder().encode('%PDF-'));
  const adapter = new SseBondProjectAdapter({ fetch: async () => ({
    ok: true, status: 200, json: async () => ({}), body: new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) {
        pulled++;
        if (pulled <= 2) controller.enqueue(chunk);
        else controller.enqueue(new TextEncoder().encode('unread tail'));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }),
  }) });
  await assert.rejects(adapter.fetch(pdfItem), { code: 'LIBRARY_BYTES_INVALID', retryable: false });
  assert.equal(pulled, 2, 'the remainder must not be read or buffered');
  assert.equal(cancelled, true);
});

test('SSE spaces list, detail, PDF and retry requests with one clock', async () => {
  let now = 0;
  const starts: number[] = [];
  const sleeps: number[] = [];
  const clock = { now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; } };
  const pdf = () => new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { controller.enqueue(new TextEncoder().encode('%PDF-1.7 synthetic')); controller.close(); } });
  let failPdf = true;
  const adapter = new SseBondProjectAdapter({ maxProjects: 1, maxPages: 1, delayMs: 0, clock,
    fetch: async url => {
      starts.push(now);
      if (url.includes('sqlId=ZQ_XMLB')) return { ok: true, status: 200, body: null, json: async () => ({ pageHelp: { data: [{ BOND_NUM: 'synthetic', PUBLISH_DATE: '2026-09-29', FULL_NAME: 'synthetic issuer', AUDIT_NAME: 'synthetic prospectus' }] } }) };
      if (url.includes('sqlId=ZQ_GGJG')) return { ok: true, status: 200, body: null, json: async () => ({ result: [{ FILE_TYPE: 11, FILE_TITLE: '募集说明书', FILE_PATH: '/synthetic.pdf', FILE_TIME: '2026-09-29', FILE_VERSION: 1 }] }) };
      if (failPdf) { failPdf = false; throw new Error('synthetic network failure'); }
      return { ok: true, status: 200, body: pdf(), json: async () => ({}) };
    },
  });
  const found = await adapter.discover({}, {});
  assert.equal(found.items.length, 1);
  await assert.rejects(adapter.fetch(found.items[0]!), { code: 'LIBRARY_FETCH_FAILED' });
  assert.equal((await adapter.fetch(found.items[0]!)).subarray(0, 5).toString(), '%PDF-');
  assert.deepEqual(starts, [0, 700, 1400, 2100], 'retry follows the same minimum gap, including after failure');
  assert.deepEqual(sleeps, [700, 700, 700], 'no extra discovery-only delay remains');
});

test('SSE serializes concurrent fetches through body completion before granting the next slot', async () => {
  let now = 0;
  const starts: number[] = [];
  let releaseFirst!: () => void;
  const firstBody = new Promise<void>(resolve => { releaseFirst = resolve; });
  const body = () => new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { controller.enqueue(new TextEncoder().encode('%PDF-1.7 synthetic')); controller.close(); } });
  const adapter = new SseBondProjectAdapter({ clock: { now: () => now, sleep: async ms => { now += ms; } },
    fetch: async () => {
      starts.push(now);
      if (starts.length === 1) await firstBody;
      return { ok: true, status: 200, body: body(), json: async () => ({}) };
    },
  });
  const first = adapter.fetch(pdfItem);
  const second = adapter.fetch(pdfItem);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(starts, [0], 'second request waits while first has not returned a body');
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(starts, [0, 700]);
});

function childFetch(url: string, env: Record<string, string>): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['-e', `fetch(${JSON.stringify(url)}).then(r => process.stdout.write(String(r.status)), e => { process.stderr.write(e.name); process.exitCode = 1; })`], {
      env: { ...process.env, ...env, NODE_USE_ENV_PROXY: '1', NODE_TLS_REJECT_UNAUTHORIZED: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', b => output += b);
    child.stderr.on('data', b => output += b);
    child.on('exit', code => resolve({ ok: code === 0, output }));
  });
}

test('Node 22 environment HTTPS proxy uses CONNECT, fails closed, and honors NO_PROXY', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-sse-proxy-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' });
    const origin = createHttpsServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (_req, res) => res.end('synthetic'));
    await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
    const originPort = (origin.address() as { port: number }).port;
    const proxy = createHttpServer();
    let connects = 0;
    proxy.on('connect', (_req, client, head) => {
      connects++;
      const upstream = connect(originPort, '127.0.0.1');
      upstream.on('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
      upstream.on('error', () => client.destroy());
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const target = `https://localhost:${originPort}/`;
      const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
      const via = await childFetch(target, { HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, NO_PROXY: '', no_proxy: '' });
      assert.equal(via.ok, true, via.output);
      assert.equal(connects, 1);
      const broken = await childFetch(target, { HTTPS_PROXY: 'http://127.0.0.1:1', https_proxy: 'http://127.0.0.1:1', NO_PROXY: '', no_proxy: '' });
      assert.equal(broken.ok, false, 'unreachable proxy must not fall back to direct');
      const direct = await childFetch(target, { HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, NO_PROXY: 'localhost', no_proxy: 'localhost' });
      assert.equal(direct.ok, true, direct.output);
      assert.equal(connects, 1, 'NO_PROXY must bypass the proxy');
    } finally {
      proxy.closeAllConnections(); proxy.close(); origin.closeAllConnections(); origin.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
