// Opt-in end-to-end check with the real Codex CLI (#994). Runs only when BB_TEST_CODEX_BIN
// points to a codex binary; the provider is a synthetic loopback Responses server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { runCodexProcess, DEFAULT_DISABLED_FEATURES, type CodexAdapterConfig } from './codex-adapter.js';
import { MODEL_GATEWAY_EXEC_LOG_MARKER } from './model-gateway.js';

const codex = process.env.BB_TEST_CODEX_BIN;
const KEY = 'synthetic-e2e-key-5b2e';

/** Grayscale page with sparse dark specks: compresses like a scan, inflates when re-encoded. */
function scannedPagePng(width: number, height: number): Buffer {
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const raw = Buffer.alloc((width + 1) * height, 255);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    if (y % 3) continue;
    for (let x = 0; x < width; x += 2) if (random() < 0.18) raw[y * (width + 1) + 1 + x] = Math.floor(random() * 120);
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

type Scripted = (call: number, body: Record<string, unknown>) => { status: number; item?: Record<string, unknown>; html?: string };
async function provider(script: Scripted) {
  const received: { bytes: number; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks); const body = JSON.parse(raw.toString('utf8'));
    received.push({ bytes: raw.length, body });
    const reply = script(received.length, body);
    if (reply.status !== 200) { res.writeHead(reply.status, { 'content-type': 'text/html' }); res.end(reply.html ?? ''); return; }
    const response = { id: 'resp_e2e_' + received.length, object: 'response', status: 'completed', model: 'deepseek-flash', output: [reply.item],
      usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req_e2e_' + received.length });
    for (const e of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item: reply.item },
      { type: 'response.output_item.done', output_index: 0, item: reply.item }, { type: 'response.completed', response }]) res.write('event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n');
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port, received, close: () => new Promise<void>(r => { (server as Server).closeAllConnections(); server.close(() => r()); }) };
}

async function setup(baseUrl: string) {
  const root = await mkdtemp(join(tmpdir(), 'bb-gateway-codex-'));
  const cwd = join(root, 'cwd'), home = join(root, 'home');
  await mkdir(cwd); await mkdir(home);
  await writeFile(join(cwd, 'page.png'), scannedPagePng(1542, 2184));
  const config: CodexAdapterConfig = { command: [codex!], model_id: 'deepseek-flash', model_provider: 'deepseek', base_url: baseUrl, wire_api: 'responses',
    model_config_version: 'synthetic-gateway-e2e', reasoning_effort: null, credential: { kind: 'env', name: 'BB_SYNTH_E2E_KEY' }, work_root: root,
    timeout_ms: 120000, kill_grace_ms: 500, max_output_bytes: 4 * 1024 * 1024, exec_log_max_bytes: 8 * 1024 * 1024, max_schema_reasks: 0,
    // view_image stays available, as in file authoring; every other tool surface is disabled.
    disabled_features: DEFAULT_DISABLED_FEATURES.filter(f => f !== 'view_image'), path_env: '/usr/local/bin:/usr/bin:/bin', model_gateway: 'measure' };
  return { root, cwd, home, config };
}

function gatewaySection(log: string) {
  const at = log.indexOf(MODEL_GATEWAY_EXEC_LOG_MARKER);
  assert.ok(at >= 0, 'exec log carries the gateway appendix');
  return log.slice(at + MODEL_GATEWAY_EXEC_LOG_MARKER.length).trim().split('\n').map(l => JSON.parse(l));
}

const viewImage = (cwd: string) => ({ type: 'function_call', id: 'fc_e2e', call_id: 'call_e2e', name: 'view_image', arguments: JSON.stringify({ path: join(cwd, 'page.png') }) });
const done = { type: 'message', id: 'msg_e2e', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] };

test('real Codex: a viewed scan page is measured in every following request', { skip: !codex && 'set BB_TEST_CODEX_BIN', timeout: 120000 }, async t => {
  let cwd = '';
  const upstream = await provider(call => ({ status: 200, item: call === 1 ? viewImage(cwd) : done }));
  const s = await setup(upstream.url); cwd = s.cwd;
  process.env.BB_SYNTH_E2E_KEY = KEY;
  t.after(async () => { delete process.env.BB_SYNTH_E2E_KEY; await upstream.close(); await rm(s.root, { recursive: true, force: true }); });
  const logs: Record<string, unknown>[] = [];
  const result = await runCodexProcess(s.config, { prompt: 'Look at page.png and answer.', cwd: s.cwd, codexHome: s.home, home: s.home, schemaFile: null, ephemeral: true,
    resumeThreadId: null, captureExecLog: true, trace: { run_id: 'run_e2e', call_id: 'call-e2e', logical_call_id: 'file-authoring-v1', attempt_no: 1 }, gatewayLog: l => logs.push(l) });
  assert.equal(result.turn_completed, true, result.exec_log?.bytes.toString().slice(-2000));
  assert.equal(result.last_message, 'done');
  assert.equal(upstream.received.length, 2);
  const section = gatewaySection(result.exec_log!.bytes.toString());
  const [summary, first, second] = section;
  assert.equal(summary.requests, 2);
  assert.equal(summary.max_image_count, 1);
  assert.deepEqual([first.request_bytes, second.request_bytes], upstream.received.map(r => r.bytes), 'gateway sizes equal what the provider received');
  assert.equal(first.request.image_count, 0);
  assert.equal(second.request.image_count, 1);
  const image = second.request.images[0];
  assert.ok(image.width > 0 && image.height > 0);
  assert.ok(second.request.image_data_url_bytes > 0.5 * second.request_bytes, 'the image dominates the request');
  assert.equal(second.response.upstream_request_id, 'req_e2e_2');
  assert.ok(!result.exec_log!.bytes.toString().includes(KEY));
  t.diagnostic(JSON.stringify({ request_bytes: [first.request_bytes, second.request_bytes], image: { width: image.width, height: image.height, mime: image.mime,
    data_url_bytes: image.data_url_bytes, decoded_bytes: image.decoded_bytes, location: image.location } }));
  assert.ok(logs.some(l => l.event === 'summary' && l.run_id === 'run_e2e'));
});

test('real Codex: provider 413 keeps its classification and the gateway records the failing size', { skip: !codex && 'set BB_TEST_CODEX_BIN', timeout: 180000 }, async t => {
  let cwd = '';
  const upstream = await provider(call => call === 1 ? { status: 200, item: viewImage(cwd) }
    : { status: 413, html: '<html><head><title>413 Request Entity Too Large</title></head></html>' });
  const s = await setup(upstream.url); cwd = s.cwd;
  process.env.BB_SYNTH_E2E_KEY = KEY;
  t.after(async () => { delete process.env.BB_SYNTH_E2E_KEY; await upstream.close(); await rm(s.root, { recursive: true, force: true }); });
  const logs: Record<string, unknown>[] = [];
  const result = await runCodexProcess(s.config, { prompt: 'Look at page.png and answer.', cwd: s.cwd, codexHome: s.home, home: s.home, schemaFile: null, ephemeral: true,
    resumeThreadId: null, captureExecLog: true, gatewayLog: l => logs.push(l) });
  assert.equal(result.turn_completed, false);
  assert.equal(result.provider_error_code, 'MODEL_PROVIDER_REQUEST_REJECTED');
  const [summary, ...records] = gatewaySection(result.exec_log!.bytes.toString());
  assert.equal(summary.first_413_seq, 2);
  assert.ok(summary.status_counts['413'] >= 1);
  assert.equal(summary.requests, upstream.received.length);
  assert.ok(records.slice(1).every(r => r.response.status === 413 && r.request.image_count === 1));
  const live = logs.filter(l => l.event === 'request');
  assert.equal(live.length, summary.status_counts['413'], 'every 413 is visible in the live worker log');
  t.diagnostic(JSON.stringify({ attempts_413: summary.status_counts['413'], first_413_request_bytes: summary.first_413_request_bytes }));
});

