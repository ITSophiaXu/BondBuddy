import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import {
  analyzeModelRequest,
  formatModelGatewayExecLogSection,
  imageDimensions,
  modelGatewayRequestLog,
  selectModelGatewayProxy,
  startModelGateway,
  ModelGatewayResponseMeter,
  MODEL_GATEWAY_EXEC_LOG_MARKER,
  MODEL_GATEWAY_LARGE_REQUEST_BYTES,
  type ModelGatewayRecord,
  type ModelGatewayPayloadRejection,
} from './model-gateway.js';
import {
  createCodexExecLogCapture,
  loadCodexAdapterConfig,
  runCodexProcess,
  DEFAULT_DISABLED_FEATURES,
  type CodexAdapterConfig,
} from './codex-adapter.js';

const SECRET = 'SYNTHETIC-PRIVATE-CONTENT-7f3a';
const KEY = 'synthetic-provider-key-8c1d';

function png(width: number, height: number, padding = 2048): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.alloc(padding, 7)]);
}
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14, 1)]);
  const sof = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(512, 3)]);
}
const dataUrl = (mime: string, bytes: Buffer) =>
  'data:' + mime + ';base64,' + bytes.toString('base64');

function responsesBody(images = true) {
  return {
    model: 'deepseek-flash',
    stream: true,
    instructions: SECRET + ' instructions',
    tools: [{ type: 'function', name: 'view_image', parameters: { type: 'object' } }],
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: SECRET + ' user text' }],
      },
      {
        type: 'function_call',
        name: 'view_image',
        arguments: JSON.stringify({ path: SECRET }),
        call_id: 'call_1',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: images
          ? [{ type: 'input_image', image_url: dataUrl('image/png', png(1333, 1888)) }]
          : SECRET,
      },
      ...(images
        ? [
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_image', image_url: dataUrl('image/jpeg', jpeg(1542, 2184)) },
                { type: 'input_image', image_url: 'https://example.invalid/' + SECRET + '.png' },
              ],
            },
          ]
        : []),
    ],
  };
}

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
const closeServer = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
async function collect(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function post(
  url: string,
  body: Buffer,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + KEY,
          'content-length': String(body.length),
          ...headers,
        },
      },
      (res) => {
        collect(res).then(
          (b) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }),
          reject,
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function sseEvents(id: string) {
  const usage = {
    input_tokens: 1200,
    input_tokens_details: { cached_tokens: 1000 },
    output_tokens: 80,
    output_tokens_details: { reasoning_tokens: 30 },
    total_tokens: 1280,
  };
  const events = [
    { type: 'response.created', response: { id, object: 'response', status: 'in_progress' } },
    { type: 'response.output_text.delta', delta: SECRET + ' model text' },
    {
      type: 'response.completed',
      response: {
        id,
        object: 'response',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: SECRET }] }],
        usage,
      },
    },
  ];
  return events.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('');
}

test('request analysis measures items and inline images without retaining content', () => {
  const body = Buffer.from(JSON.stringify(responsesBody()));
  const shape = analyzeModelRequest(body, null);
  assert.equal(shape.analysis, 'parsed');
  assert.equal(shape.model, 'deepseek-flash');
  assert.equal(shape.stream, true);
  assert.equal(shape.input_items, 4);
  assert.deepEqual(Object.keys(shape.items).sort(), [
    'function_call',
    'function_call_output',
    'message:user',
  ]);
  assert.equal(shape.items['message:user'].count, 2);
  assert.equal(shape.tool_count, 1);
  assert.ok(shape.instructions_bytes > SECRET.length);
  assert.equal(shape.image_count, 2);
  assert.equal(shape.image_refs, 1);
  assert.deepEqual(
    shape.images.map((i) => [i.location, i.mime, i.width, i.height]),
    [
      ['function_call_output', 'image/png', 1333, 1888],
      ['message:user', 'image/jpeg', 1542, 2184],
    ],
  );
  assert.equal(shape.images[0].decoded_bytes, png(1333, 1888).length);
  assert.equal(
    shape.image_data_url_bytes,
    shape.images[0].data_url_bytes + shape.images[1].data_url_bytes,
  );
  assert.equal(shape.largest_item?.type, 'function_call_output');
  assert.ok(
    !JSON.stringify(shape).includes(SECRET),
    'no prompt, tool argument, image URL or model text is retained',
  );
  const gz = analyzeModelRequest(gzipSync(body), 'gzip');
  assert.equal(gz.content_encoding, 'gzip');
  assert.equal(gz.json_bytes, body.length);
  assert.equal(gz.image_count, 2);
  assert.equal(analyzeModelRequest(Buffer.from('xx'), 'compress').analysis, 'encoded');
  assert.equal(analyzeModelRequest(Buffer.from('{not json'), null).analysis, 'not_json');
  assert.equal(analyzeModelRequest(Buffer.alloc(0), null).analysis, 'empty');
  assert.deepEqual(
    imageDimensions(
      Buffer.from('GIF89a').length
        ? Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x10, 0x00, 0x20, 0x00])])
        : Buffer.alloc(0),
    ),
    { width: 16, height: 32 },
  );
  assert.equal(imageDimensions(Buffer.from('not an image header')), null);
});

test('measuring gateway forwards bytes, headers and SSE unchanged and records only sizes, ids and usage', async (t) => {
  const seen: { path?: string; host?: string; auth?: string; sha?: string; hop?: string } = {};
  const upstream = createServer(async (req, res) => {
    const body = await collect(req);
    Object.assign(seen, {
      path: req.url,
      host: req.headers.host,
      auth: req.headers.authorization,
      sha: createHash('sha256').update(body).digest('hex'),
      hop: req.headers['proxy-authorization'],
    });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-request-id': 'req_synthetic_1',
      'x-provider-note': 'kept',
    });
    res.end(sseEvents('resp_synthetic_1'));
  });
  const upstreamPort = await listen(upstream);
  const records: ModelGatewayRecord[] = [];
  const gateway = await startModelGateway({
    upstreamBaseUrl: 'http://127.0.0.1:' + upstreamPort + '/v1',
    onRecord: (r) => records.push(r),
  });
  t.after(async () => {
    await gateway.close();
    await closeServer(upstream);
  });
  assert.match(gateway.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const body = Buffer.from(JSON.stringify(responsesBody()));
  const response = await post(gateway.baseUrl + '/responses?trace=1', body, {
    'proxy-authorization': 'must-not-forward',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'text/event-stream');
  assert.equal(response.headers['x-provider-note'], 'kept');
  assert.equal(
    response.body.toString(),
    sseEvents('resp_synthetic_1'),
    'Codex receives the exact stream',
  );
  assert.equal(seen.path, '/v1/responses?trace=1');
  assert.equal(seen.host, '127.0.0.1:' + upstreamPort);
  assert.equal(seen.auth, 'Bearer ' + KEY, 'credentials pass through untouched');
  assert.equal(seen.hop, undefined, 'hop-by-hop proxy headers are not forwarded');
  assert.equal(seen.sha, createHash('sha256').update(body).digest('hex'));
  await gateway.close();
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.outcome, 'completed');
  assert.equal(r.path, '/responses');
  assert.equal(r.request_bytes, body.length);
  assert.equal(r.request?.image_count, 2);
  assert.equal(r.response?.status, 200);
  assert.equal(r.response?.content_type, 'event-stream');
  assert.equal(r.response?.upstream_request_id, 'req_synthetic_1');
  assert.equal(r.response?.response_id, 'resp_synthetic_1');
  assert.equal(r.response?.terminal_event, 'response.completed');
  assert.deepEqual(r.response?.usage, {
    input_tokens: 1200,
    cached_input_tokens: 1000,
    output_tokens: 80,
    reasoning_tokens: 30,
    total_tokens: 1280,
  });
  const summary = gateway.summary();
  assert.equal(summary.requests, 1);
  assert.equal(summary.max_request_bytes, body.length);
  assert.equal(summary.max_image_count, 2);
  assert.deepEqual(summary.status_counts, { 200: 1 });
  assert.equal(summary.usage.input_tokens, 1200);
  const persisted = JSON.stringify([summary, gateway.records()]);
  assert.ok(
    !persisted.includes(SECRET) && !persisted.includes(KEY) && !persisted.includes('Bearer'),
    'measurements carry no content or credentials',
  );
  assert.equal(
    modelGatewayRequestLog(r),
    null,
    'ordinary successful requests stay out of the live worker log',
  );
});

test('incomplete metering only records an explicit quota, allowed reason and fixed output item counts', async (t) => {
  const upstream = createServer(async (req, res) => {
    await collect(req);
    const mode = new URL(req.url!, 'http://127.0.0.1').searchParams.get('mode');
    const reason =
      mode === 'unknown' ? SECRET : mode === 'safety' ? 'content_filter' : 'max_output_tokens';
    const status = mode === 'inconsistent-status' ? 'completed' : 'incomplete';
    const reply = {
      type: 'response.incomplete',
      response: {
        object: 'response',
        status,
        incomplete_details: { reason },
        output: [
          { type: 'message', content: [{ text: SECRET }] },
          { type: 'function_call', arguments: SECRET },
          { type: SECRET },
        ],
      },
    };
    res.writeHead(mode === 'http-error' ? 400 : 200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify(reply) + '\n\n');
    if (mode === 'duplicate-terminal') res.write('data: ' + JSON.stringify(reply) + '\n\n');
    res.end();
  });
  const port = await listen(upstream);
  const gateway = await startModelGateway({ upstreamBaseUrl: 'http://127.0.0.1:' + port });
  t.after(async () => {
    await gateway.close();
    await closeServer(upstream);
  });
  const body = Buffer.from(JSON.stringify({ ...responsesBody(false), max_output_tokens: 2000 }));
  await post(gateway.baseUrl + '/responses', body);
  assert.deepEqual(gateway.latestOutputLimit(), { seq: 1, transport_completed: true });
  const [record] = gateway.records();
  assert.equal(record.request?.max_output_tokens, 2000);
  assert.equal(record.response?.incomplete_reason, 'max_output_tokens');
  assert.deepEqual(record.response?.output_item_counts, { message: 1, function_call: 1, other: 1 });
  assert.equal(
    analyzeModelRequest(Buffer.from(JSON.stringify(responsesBody(false)))).max_output_tokens,
    null,
  );
  assert.equal(
    analyzeModelRequest(Buffer.from('{"max_output_tokens":"2000"}')).max_output_tokens,
    null,
  );
  assert.equal(modelGatewayRequestLog(record)?.max_output_tokens, 2000);
  assert.equal(modelGatewayRequestLog(record)?.incomplete_reason, 'max_output_tokens');
  for (const mode of [
    'unknown',
    'safety',
    'inconsistent-status',
    'http-error',
    'duplicate-terminal',
  ]) {
    await post(gateway.baseUrl + '/responses?mode=' + mode, body);
    assert.equal(
      gateway.latestOutputLimit(),
      null,
      mode + ' must invalidate the preceding output-limit evidence',
    );
  }
  assert.equal(gateway.records()[1].response?.incomplete_reason, null);
  assert.equal(gateway.records()[2].response?.incomplete_reason, 'content_filter');
  assert.ok(!JSON.stringify([gateway.records(), modelGatewayRequestLog(record)]).includes(SECRET));
});

test('SSE line bound covers complete lines in one chunk and lines finished in a later chunk', () => {
  const limit = 16 * 1024 * 1024;
  const event =
    'data: ' +
    JSON.stringify({
      type: 'response.incomplete',
      response: {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      },
    });
  const large = Buffer.from(event.padEnd(limit + 1) + '\n\n');
  for (const cut of [0, limit]) {
    const meter = new ModelGatewayResponseMeter(200, { 'content-type': 'text/event-stream' });
    if (cut) meter.push(large.subarray(0, cut));
    meter.push(large.subarray(cut));
    const response = meter.finish();
    assert.equal(response.parse, 'incomplete');
    assert.equal(response.sse_events, 0, 'an oversized line is not parsed as a terminal event');
    assert.equal(meter.observedOutputLimit(), false);
  }
  const atBound = new ModelGatewayResponseMeter(200, { 'content-type': 'text/event-stream' });
  atBound.push(Buffer.from(event.padEnd(limit) + '\n\n'));
  assert.equal(atBound.finish().parse, 'ok', 'the original limit remains inclusive');
  assert.equal(atBound.observedOutputLimit(), true);
});

test('provider 413 passes through unchanged and is summarized for diagnosis', async (t) => {
  const html = '<html><head><title>413 Request Entity Too Large</title></head></html>';
  const upstream = createServer(async (req, res) => {
    await collect(req);
    res.writeHead(413, { 'content-type': 'text/html' });
    res.end(html);
  });
  const port = await listen(upstream);
  const gateway = await startModelGateway({ upstreamBaseUrl: 'http://127.0.0.1:' + port });
  t.after(async () => {
    await gateway.close();
    await closeServer(upstream);
  });
  const body = Buffer.from(JSON.stringify(responsesBody()));
  for (let i = 0; i < 2; i++) {
    const response = await post(gateway.baseUrl + '/responses', body);
    assert.equal(response.status, 413);
    assert.equal(response.body.toString(), html);
  }
  await gateway.close();
  const summary = gateway.summary();
  assert.deepEqual(summary.status_counts, { 413: 2 });
  assert.equal(summary.first_413_seq, 1);
  assert.equal(summary.first_413_request_bytes, body.length);
  const line = modelGatewayRequestLog(gateway.records()[0], {
    run_id: 'run-1',
    call_id: 'call-1',
    logical_call_id: 'file-authoring-v1',
    attempt_no: 1,
  });
  assert.equal(line?.status, 413);
  assert.equal(line?.image_count, 2);
  assert.equal(line?.run_id, 'run-1');
  assert.equal(gateway.records()[0].response?.content_type, 'html');
});

test('enforcement requires an explicit positive safe budget within the gateway resource ceiling', async () => {
  for (const maxRequestBytes of [
    undefined,
    0,
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    256 * 1024 * 1024 + 1,
  ]) {
    await assert.rejects(
      startModelGateway({
        upstreamBaseUrl: 'http://127.0.0.1:9',
        mode: 'enforce',
        maxRequestBytes,
      }),
      /MODEL_GATEWAY_BUDGET_INVALID/,
    );
  }
  const gateway = await startModelGateway({
    upstreamBaseUrl: 'http://127.0.0.1:9',
    mode: 'enforce',
    maxRequestBytes: 256 * 1024 * 1024,
  });
  assert.equal(gateway.summary().mode, 'enforce');
  await gateway.close();
});

test('enforcement preserves requests through the exact byte limit and latches before an oversized request reaches upstream', async (t) => {
  const received: Buffer[] = [],
    rejected: ModelGatewayPayloadRejection[] = [];
  const upstream = createServer(async (req, res) => {
    received.push(await collect(req));
    res.end('{}');
  });
  const port = await listen(upstream),
    maxRequestBytes = 512;
  const gateway = await startModelGateway({
    upstreamBaseUrl: 'http://127.0.0.1:' + port,
    mode: 'enforce',
    maxRequestBytes,
    onPayloadRejected: (event) => rejected.push(event),
  });
  t.after(async () => {
    await gateway.close();
    await closeServer(upstream);
  });
  const below = Buffer.from('{}'),
    exact = Buffer.from('{' + ' '.repeat(maxRequestBytes - 2) + '}'),
    above = Buffer.alloc(maxRequestBytes + 1, 32);
  assert.equal((await post(gateway.baseUrl + '/responses', below)).status, 200);
  assert.equal((await post(gateway.baseUrl + '/responses', exact)).status, 200);
  const denied = await post(gateway.baseUrl + '/responses', above);
  assert.equal(denied.status, 413);
  assert.equal(JSON.parse(denied.body.toString()).error.code, 'MODEL_REQUEST_BUDGET_EXCEEDED');
  assert.equal(
    (await post(gateway.baseUrl + '/responses', below)).status,
    413,
    'a changed retry cannot bypass the latched process',
  );
  assert.deepEqual(received, [below, exact]);
  assert.deepEqual(rejected, [
    {
      source: 'local',
      reason: 'wire_bytes',
      code: 'MODEL_REQUEST_BUDGET_EXCEEDED',
      status: 413,
      request_bytes: above.length,
      max_request_bytes: maxRequestBytes,
    },
  ]);
  assert.equal(gateway.summary().gateway_rejected, 2);
  assert.ok(!JSON.stringify(gateway.records()).includes(KEY));
});

test('enforcement counts streamed chunked bytes and remains latched if its callback throws', async (t) => {
  let hits = 0,
    callbacks = 0;
  const upstream = createServer(async (req, res) => {
    hits++;
    await collect(req);
    res.end('{}');
  });
  const port = await listen(upstream),
    maxRequestBytes = 32;
  const gateway = await startModelGateway({
    upstreamBaseUrl: 'http://127.0.0.1:' + port,
    mode: 'enforce',
    maxRequestBytes,
    onPayloadRejected: () => {
      callbacks++;
      throw new Error('synthetic lifecycle failure');
    },
  });
  t.after(async () => {
    await gateway.close();
    await closeServer(upstream);
  });
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      gateway.baseUrl + '/responses',
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.write(Buffer.alloc(16, 32));
    req.write(Buffer.alloc(17, 32));
    req.end();
  });
  assert.equal(status, 413);
  assert.equal((await post(gateway.baseUrl + '/responses', Buffer.from('{}'))).status, 413);
  assert.equal(callbacks, 1);
  assert.equal(hits, 0);
});

test(
  'enforcement rejects an oversized unfinished stream immediately and blocks concurrent follow-up requests',
  { timeout: 5000 },
  async (t) => {
    let hits = 0;
    const callbacks: ModelGatewayPayloadRejection[] = [];
    const upstream = createServer(async (req, res) => {
      hits++;
      await collect(req);
      res.end('{}');
    });
    const port = await listen(upstream);
    const gateway = await startModelGateway({
      upstreamBaseUrl: 'http://127.0.0.1:' + port,
      mode: 'enforce',
      maxRequestBytes: 64,
      onPayloadRejected: (event) => callbacks.push(event),
    });
    t.after(async () => {
      await gateway.close();
      await closeServer(upstream);
    });
    let unfinished!: ReturnType<typeof httpRequest>;
    const status = await new Promise<number>((resolve, reject) => {
      unfinished = httpRequest(gateway.baseUrl + '/responses', { method: 'POST' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      t.after(() => unfinished.destroy());
      unfinished.on('error', reject);
      unfinished.write(Buffer.alloc(128, 32)); // Deliberately never end this request before checking the latch.
    });
    assert.equal(status, 413);
    assert.equal(callbacks.length, 1);
    assert.equal(callbacks[0]?.request_bytes, 128);
    assert.equal((await post(gateway.baseUrl + '/responses', Buffer.from('{}'))).status, 413);
    assert.equal(hits, 0);
    assert.equal(gateway.summary().gateway_rejected, 2);
    unfinished.end();
  },
);

test('enforcement bounds decoded gzip, deflate and brotli bodies while preserving accepted wire bytes', async (t) => {
  for (const [encoding, compress] of [
    ['gzip', gzipSync],
    ['deflate', deflateSync],
    ['br', brotliCompressSync],
  ] as const) {
    const received: Buffer[] = [],
      rejected: ModelGatewayPayloadRejection[] = [];
    const upstream = createServer(async (req, res) => {
      assert.equal(req.headers['content-encoding'], encoding);
      received.push(await collect(req));
      res.end('{}');
    });
    const port = await listen(upstream),
      maxRequestBytes = 512;
    const gateway = await startModelGateway({
      upstreamBaseUrl: 'http://127.0.0.1:' + port,
      mode: 'enforce',
      maxRequestBytes,
      onPayloadRejected: (event) => rejected.push(event),
    });
    t.after(async () => {
      await gateway.close();
      await closeServer(upstream);
    });
    const exact = Buffer.from('{' + ' '.repeat(maxRequestBytes - 2) + '}'),
      accepted = compress(exact);
    assert.equal(
      (await post(gateway.baseUrl + '/responses', accepted, { 'content-encoding': encoding }))
        .status,
      200,
    );
    assert.deepEqual(
      received,
      [accepted],
      'compression and the JSON/tool structure remain untouched',
    );
    const over = compress(Buffer.from(JSON.stringify({ input: SECRET.repeat(1000) })));
    assert.ok(over.length < maxRequestBytes);
    assert.equal(
      (await post(gateway.baseUrl + '/responses', over, { 'content-encoding': encoding })).status,
      413,
    );
    assert.equal(received.length, 1, 'a compressed body cannot bypass the decoded budget');
    assert.equal(rejected[0]?.reason, 'decoded_bytes');
    assert.equal(rejected[0]?.request_bytes, over.length);
    assert.equal(rejected[0]?.code, 'MODEL_REQUEST_BUDGET_EXCEEDED');
  }
});

test('enforcement rejects unverifiable encoding without relabeling it as oversized or forwarding it', async (t) => {
  for (const encoding of ['unknown', 'gzip, br', 'gzip']) {
    let hits = 0;
    const rejected: ModelGatewayPayloadRejection[] = [];
    const upstream = createServer(async (req, res) => {
      hits++;
      await collect(req);
      res.end('{}');
    });
    const port = await listen(upstream);
    const gateway = await startModelGateway({
      upstreamBaseUrl: 'http://127.0.0.1:' + port,
      mode: 'enforce',
      maxRequestBytes: 512,
      onPayloadRejected: (event) => rejected.push(event),
    });
    t.after(async () => {
      await gateway.close();
      await closeServer(upstream);
    });
    const denied = await post(gateway.baseUrl + '/responses', Buffer.from('{}'), {
      'content-encoding': encoding,
    });
    assert.equal(denied.status, 415);
    assert.equal(JSON.parse(denied.body.toString()).error.code, 'MODEL_REQUEST_ENCODING_INVALID');
    assert.equal(rejected[0]?.reason, 'encoding_unverifiable');
    assert.equal(
      (await post(gateway.baseUrl + '/responses', Buffer.alloc(513))).status,
      415,
      'the first rejection is retained',
    );
    assert.equal(rejected.length, 1);
    assert.equal(hits, 0);
  }
});

test('enforcement budgets the complete image history and retains usage from earlier successful requests', async (t) => {
  let hits = 0;
  const rejected: ModelGatewayPayloadRejection[] = [];
  const upstream = createServer(async (req, res) => {
    hits++;
    await collect(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseEvents('resp_before_budget'));
  });
  const port = await listen(upstream);
  const first = responsesBody(),
    one = Buffer.from(JSON.stringify(first));
  const history = Buffer.from(
    JSON.stringify({ ...first, input: [...first.input, first.input[2]] }),
  );
  const gateway = await startModelGateway({
    upstreamBaseUrl: 'http://127.0.0.1:' + port,
    mode: 'enforce',
    maxRequestBytes: one.length,
    onPayloadRejected: (event) => rejected.push(event),
  });
  t.after(async () => {
    await gateway.close();
    await closeServer(upstream);
  });
  assert.equal((await post(gateway.baseUrl + '/responses', one)).status, 200);
  assert.equal((await post(gateway.baseUrl + '/responses', history)).status, 413);
  assert.equal(hits, 1);
  assert.equal(rejected.length, 1);
  assert.equal(
    gateway.summary().usage.input_tokens,
    1200,
    'rejecting a later request does not erase real earlier usage',
  );
  const saved = JSON.stringify([rejected, gateway.summary(), gateway.records()]);
  assert.ok(
    !saved.includes(SECRET) && !saved.includes(KEY),
    'rejection telemetry contains no prompt, image data or credentials',
  );
});

test(
  'enforcement latches on upstream 413 headers before its response finishes and never resends',
  { timeout: 5000 },
  async (t) => {
    let hits = 0;
    let finishResponse: (() => void) | undefined;
    let rejectObserved!: (event: ModelGatewayPayloadRejection) => void;
    const observed = new Promise<ModelGatewayPayloadRejection>((resolve) => {
      rejectObserved = resolve;
    });
    const upstream = createServer(async (req, res) => {
      hits++;
      await collect(req);
      res.writeHead(413, { 'content-type': 'text/html' });
      res.flushHeaders();
      finishResponse = () => res.end('<html>synthetic provider 413</html>');
    });
    const port = await listen(upstream),
      callbacks: ModelGatewayPayloadRejection[] = [];
    const gateway = await startModelGateway({
      upstreamBaseUrl: 'http://127.0.0.1:' + port,
      mode: 'enforce',
      maxRequestBytes: 512,
      onPayloadRejected: (event) => {
        callbacks.push(event);
        rejectObserved(event);
      },
    });
    t.after(async () => {
      finishResponse?.();
      await gateway.close();
      await closeServer(upstream);
    });
    const pending = post(gateway.baseUrl + '/responses', Buffer.from('{}'));
    const event = await observed;
    assert.equal(event.source, 'upstream');
    assert.equal(event.reason, 'upstream_413');
    assert.equal(event.code, 'MODEL_PROVIDER_PAYLOAD_TOO_LARGE');
    const retry = await post(gateway.baseUrl + '/responses', Buffer.from('{}'));
    assert.equal(retry.status, 413);
    assert.equal(JSON.parse(retry.body.toString()).error.code, 'MODEL_PROVIDER_PAYLOAD_TOO_LARGE');
    assert.equal(hits, 1);
    assert.equal(callbacks.length, 1);
    finishResponse!();
    assert.equal((await pending).body.toString(), '<html>synthetic provider 413</html>');
  },
);

test('large successful requests are reported live; the threshold is the request size', () => {
  const base = {
    kind: 'request',
    v: 'x',
    seq: 1,
    started_at: '',
    duration_ms: 1,
    method: 'POST',
    path: '/responses',
    request: null,
    gateway_error: null,
    outcome: 'completed',
  } as const;
  const ok = { status: 200 } as ModelGatewayRecord['response'];
  assert.equal(
    modelGatewayRequestLog({
      ...base,
      request_bytes: MODEL_GATEWAY_LARGE_REQUEST_BYTES - 1,
      response: ok,
    }),
    null,
  );
  assert.equal(
    modelGatewayRequestLog({
      ...base,
      request_bytes: MODEL_GATEWAY_LARGE_REQUEST_BYTES,
      response: ok,
    })?.request_bytes,
    MODEL_GATEWAY_LARGE_REQUEST_BYTES,
  );
});

test('a client disconnect aborts the upstream stream; upstream failures surface as 502', async (t) => {
  let upstreamClosed = false;
  const upstream = createServer(async (req, res) => {
    await collect(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_slow"}}\n\n',
    );
    res.on('close', () => {
      upstreamClosed = true;
    });
  });
  const port = await listen(upstream);
  const gateway = await startModelGateway({ upstreamBaseUrl: 'http://127.0.0.1:' + port });
  t.after(async () => {
    await gateway.close();
    await closeServer(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest(
      gateway.baseUrl + '/responses',
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      },
    );
    req.on('error', () => undefined);
    req.end('{}');
    setTimeout(() => reject(new Error('no first chunk')), 5000).unref();
  });
  for (let i = 0; i < 50 && !upstreamClosed; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(upstreamClosed, 'upstream request is torn down when Codex goes away');
  await gateway.close();
  assert.equal(gateway.records()[0].outcome, 'client_closed');
  assert.equal(gateway.records()[0].response?.response_id, 'resp_slow');

  const unused = createServer();
  const deadPort = await listen(unused);
  await closeServer(unused);
  const dead = await startModelGateway({ upstreamBaseUrl: 'http://127.0.0.1:' + deadPort });
  const failed = await post(dead.baseUrl + '/responses', Buffer.from('{}'));
  await dead.close();
  assert.equal(failed.status, 502);
  assert.equal(JSON.parse(failed.body.toString()).error.code, 'ECONNREFUSED');
  assert.equal(dead.records()[0].outcome, 'upstream_error');
  assert.equal(dead.summary().upstream_errors, 1);
});

test('only GET/POST relative paths are forwarded', async (t) => {
  let hits = 0;
  const upstream = createServer((req, res) => {
    hits++;
    res.end();
  });
  const port = await listen(upstream);
  const gateway = await startModelGateway({ upstreamBaseUrl: 'http://127.0.0.1:' + port });
  t.after(async () => {
    await gateway.close();
    await closeServer(upstream);
  });
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(gateway.baseUrl + '/responses', { method: 'DELETE' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 405);
  assert.equal(hits, 0);
  assert.equal(gateway.summary().gateway_rejected, 1);
});

test('proxy selection mirrors the child environment and rejects unsupported proxies', () => {
  const api = new URL('https://api.deepseek.com');
  assert.equal(selectModelGatewayProxy(api, {}), null);
  assert.equal(
    selectModelGatewayProxy(api, { HTTPS_PROXY: 'http://egress:3128' })?.host,
    'egress:3128',
  );
  assert.equal(
    selectModelGatewayProxy(api, {
      https_proxy: 'http://egress:3128',
      no_proxy: 'postgres,.deepseek.com',
    }),
    null,
  );
  assert.equal(
    selectModelGatewayProxy(api, { HTTPS_PROXY: 'http://egress:3128', NO_PROXY: '*' }),
    null,
  );
  assert.equal(
    selectModelGatewayProxy(api, {
      HTTPS_PROXY: 'http://egress:3128',
      NO_PROXY: 'localhost,127.0.0.1',
    })?.hostname,
    'egress',
  );
  assert.equal(
    selectModelGatewayProxy(new URL('http://127.0.0.1:9'), { HTTPS_PROXY: 'http://egress:3128' }),
    null,
  );
  assert.throws(
    () => selectModelGatewayProxy(api, { HTTPS_PROXY: 'https://egress:3128' }),
    /MODEL_GATEWAY_PROXY_UNSUPPORTED/,
  );
  assert.throws(
    () => selectModelGatewayProxy(api, { HTTPS_PROXY: 'http://user:pass@egress:3128' }),
    /MODEL_GATEWAY_PROXY_UNSUPPORTED/,
  );
});

function openssl(): string | null {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return 'openssl';
  } catch {
    return null;
  }
}

test('HTTPS upstream through an HTTP CONNECT proxy: TLS verified, tunnel reused, refusal surfaced', async (t) => {
  if (!openssl()) {
    t.skip('openssl unavailable');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'bb-gateway-tls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  const cert = await readFile(join(dir, 'cert.pem')),
    key = await readFile(join(dir, 'key.pem'));
  let requests = 0;
  const upstream = createHttpsServer({ cert, key }, async (req, res) => {
    requests++;
    await collect(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseEvents('resp_tls_' + requests));
  });
  const upstreamPort = await listen(upstream as unknown as Server);
  const connects: string[] = [];
  let refuse = false;
  const proxy = createServer();
  proxy.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    connects.push(req.url ?? '');
    if (refuse) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const [host, port] = (req.url ?? '').split(':');
    const target = netConnect(Number(port), host === 'localhost' ? '127.0.0.1' : host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      target.pipe(client);
      client.pipe(target);
    });
    target.on('error', () => client.destroy());
    client.on('error', () => target.destroy());
  });
  const proxyPort = await listen(proxy);
  t.after(async () => {
    await closeServer(proxy);
    await closeServer(upstream as unknown as Server);
  });
  const upstreamBaseUrl = 'https://localhost:' + upstreamPort;
  const gateway = await startModelGateway({
    upstreamBaseUrl,
    tlsCa: cert,
    proxyEnv: { HTTPS_PROXY: 'http://127.0.0.1:' + proxyPort, NO_PROXY: '127.0.0.1' },
  });
  assert.equal(gateway.proxied, true);
  for (let i = 1; i <= 2; i++) {
    const response = await post(
      gateway.baseUrl + '/responses',
      Buffer.from(JSON.stringify(responsesBody(false))),
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.toString(), sseEvents('resp_tls_' + i));
  }
  await gateway.close();
  assert.deepEqual(
    connects,
    ['localhost:' + upstreamPort],
    'one CONNECT tunnel serves both keep-alive requests',
  );
  assert.equal(gateway.summary().proxied, true);

  const untrusted = await startModelGateway({
    upstreamBaseUrl,
    proxyEnv: { HTTPS_PROXY: 'http://127.0.0.1:' + proxyPort },
  });
  const tlsFailure = await post(untrusted.baseUrl + '/responses', Buffer.from('{}'));
  await untrusted.close();
  assert.equal(tlsFailure.status, 502, 'certificate verification stays on');

  refuse = true;
  const refused = await startModelGateway({
    upstreamBaseUrl,
    tlsCa: cert,
    proxyEnv: { HTTPS_PROXY: 'http://127.0.0.1:' + proxyPort },
  });
  const blocked = await post(refused.baseUrl + '/responses', Buffer.from('{}'));
  await refused.close();
  assert.equal(blocked.status, 502);
  assert.equal(JSON.parse(blocked.body.toString()).error.code, 'PROXY_CONNECT_403');
  assert.equal(requests, 2);
});

test('exec-log appendix keeps the summary and both ends within its byte budget', () => {
  const summary = {
    kind: 'summary',
    v: 'model-gateway-measure-v1',
    requests: 300,
  } as unknown as Parameters<typeof formatModelGatewayExecLogSection>[0];
  const records = Array.from(
    { length: 300 },
    (_, i) =>
      ({ kind: 'request', seq: i + 1, pad: 'x'.repeat(400) }) as unknown as ModelGatewayRecord,
  );
  const all = formatModelGatewayExecLogSection(summary, records.slice(0, 3), 64 * 1024).toString();
  assert.ok(all.startsWith(MODEL_GATEWAY_EXEC_LOG_MARKER));
  assert.equal(all.trim().split('\n').length, 1 + 1 + 3);
  const bounded = formatModelGatewayExecLogSection(summary, records, 32 * 1024);
  assert.ok(bounded.length <= 32 * 1024);
  const lines = bounded
    .toString()
    .slice(MODEL_GATEWAY_EXEC_LOG_MARKER.length)
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(lines[0].kind, 'summary');
  assert.deepEqual(
    lines.slice(1, 11).map((l) => l.seq),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  const omitted = lines.find((l) => l.kind === 'omitted');
  assert.ok(omitted.requests > 0);
  assert.equal(lines.at(-1).seq, 300);
  assert.equal(lines.length - 2 + omitted.requests, 300);
  assert.equal(formatModelGatewayExecLogSection(summary, records, 16).length, 0);
});

test('exec-log capture reserves room for the appendix and never exceeds its limit', () => {
  const capture = createCodexExecLogCapture(4096, 1024);
  capture.stdout('a'.repeat(5000));
  const appendix = Buffer.from(MODEL_GATEWAY_EXEC_LOG_MARKER + '{"kind":"summary"}\n');
  const log = capture.finish(appendix);
  assert.equal(log.truncated, true);
  assert.ok(log.bytes.length <= 4096);
  assert.ok(log.bytes.toString().endsWith(appendix.toString()));
  const tooBig = createCodexExecLogCapture(4096, 16);
  assert.ok(
    !tooBig.finish(appendix).bytes.toString().includes('[bondbuddy-model-gateway]'),
    'an oversized appendix is dropped, not overflowed',
  );
  assert.throws(() => createCodexExecLogCapture(4096, 4096), {
    code: 'MODEL_ADAPTER_CONFIG_INVALID',
  });
});

test('gateway mode is off unless measurement or explicitly budgeted enforcement is selected', () => {
  assert.equal(loadCodexAdapterConfig({}).model_gateway, undefined);
  assert.equal('model_gateway' in loadCodexAdapterConfig({ BB_MODEL_GATEWAY_MODE: 'off' }), false);
  assert.equal(
    loadCodexAdapterConfig({ BB_MODEL_GATEWAY_MODE: 'measure' }).model_gateway,
    'measure',
  );
  assert.equal(
    loadCodexAdapterConfig({ BB_MODEL_GATEWAY_MODE: 'enforce', BB_MODEL_MAX_REQUEST_BYTES: '512' })
      .model_gateway,
    'enforce',
  );
  for (const value of ['on', 'MEASURE', 'enforce', '1'])
    assert.throws(() => loadCodexAdapterConfig({ BB_MODEL_GATEWAY_MODE: value }), {
      code: 'MODEL_ADAPTER_CONFIG_INVALID',
    });
});

// A synthetic stand-in for codex: it reads the provider base_url from its -c overrides,
// sends one Responses request carrying an inline image, then prints the JSONL Codex would.
const FAKE_CODEX = String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
const override = args.find(a => a.startsWith('model_providers.deepseek.base_url='));
const base = JSON.parse(override.slice(override.indexOf('=') + 1));
const png = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13,0x49,0x48,0x44,0x52,0,0,5,0x35,0,0,7,0x60]), Buffer.alloc(300000, 9)]);
const body = JSON.stringify({ model: 'deepseek-flash', stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,' + png.toString('base64') }] }] });
process.stderr.write('base=' + base + ' no_proxy=' + (process.env.NO_PROXY || '') + '\n');
const res = await fetch(base + '/responses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.BB_SYNTH_GATEWAY_KEY }, body });
const text = await res.text();
const status = res.status;
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread_synthetic' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'status ' + status + ' bytes ' + text.length } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } }));
`;

async function fakeCodexConfig(
  dir: string,
  baseUrl: string,
  extra: Partial<CodexAdapterConfig> = {},
): Promise<CodexAdapterConfig> {
  const script = join(dir, 'fake-codex.mjs');
  await writeFile(script, FAKE_CODEX);
  await chmod(script, 0o700);
  return {
    command: [process.execPath, script],
    model_id: 'deepseek-flash',
    model_provider: 'deepseek',
    base_url: baseUrl,
    wire_api: 'responses',
    model_config_version: 'synthetic-gateway',
    reasoning_effort: null,
    credential: { kind: 'env', name: 'BB_SYNTH_GATEWAY_KEY' },
    work_root: dir,
    timeout_ms: 20000,
    kill_grace_ms: 100,
    max_output_bytes: 1024 * 1024,
    exec_log_max_bytes: 8 * 1024 * 1024,
    max_schema_reasks: 0,
    disabled_features: DEFAULT_DISABLED_FEATURES,
    path_env: process.env.PATH ?? '/usr/bin:/bin',
    model_gateway: 'measure',
    ...extra,
  };
}

test('runCodexProcess routes the child through the gateway and appends the measurements to its exec log', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-gateway-process-'));
  const seen: string[] = [];
  const upstream = createServer(async (req, res) => {
    const body = await collect(req);
    seen.push(req.headers.authorization + ' ' + body.length);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req_process_1' });
    res.end(sseEvents('resp_process_1'));
  });
  const port = await listen(upstream);
  process.env.BB_SYNTH_GATEWAY_KEY = KEY;
  t.after(async () => {
    delete process.env.BB_SYNTH_GATEWAY_KEY;
    await closeServer(upstream);
    await rm(dir, { recursive: true, force: true });
  });
  const config = await fakeCodexConfig(dir, 'http://127.0.0.1:' + port, {
    proxy_env: { NO_PROXY: 'postgres' },
  });
  const logs: Record<string, unknown>[] = [];
  const trace = {
    run_id: 'run_synthetic',
    call_id: 'call-synthetic',
    logical_call_id: 'file-authoring-v1',
    attempt_no: 1,
  };
  const result = await runCodexProcess(config, {
    prompt: 'synthetic',
    cwd: dir,
    codexHome: dir,
    home: dir,
    schemaFile: null,
    ephemeral: true,
    resumeThreadId: null,
    captureExecLog: true,
    trace,
    gatewayLog: (line) => logs.push(line),
  });
  assert.equal(result.turn_completed, true);
  assert.match(result.last_message ?? '', /^status 200 bytes \d+$/);
  assert.deepEqual(
    seen.map((s) => s.split(' ')[0] + ' ' + s.split(' ')[1]),
    ['Bearer ' + KEY],
    'the provider received the original credential header',
  );
  const log = result.exec_log!.bytes.toString();
  assert.match(
    log,
    /base=http:\/\/127\.0\.0\.1:\d+ no_proxy=postgres,127\.0\.0\.1/,
    'child uses the loopback gateway and bypasses the egress proxy for it',
  );
  assert.ok(
    !log.includes('base=http://127.0.0.1:' + port + ' '),
    'child never saw the provider URL directly',
  );
  const section = log
    .slice(log.indexOf(MODEL_GATEWAY_EXEC_LOG_MARKER) + MODEL_GATEWAY_EXEC_LOG_MARKER.length)
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(section[0].kind, 'summary');
  assert.equal(section[0].requests, 1);
  assert.equal(section[0].max_image_count, 1);
  assert.ok(section[0].max_request_bytes > 400000);
  assert.equal(section[1].request.images[0].width, 1333);
  assert.equal(section[1].response.upstream_request_id, 'req_process_1');
  assert.ok(!log.slice(log.indexOf(MODEL_GATEWAY_EXEC_LOG_MARKER)).includes(KEY));
  const summaryLog = logs.find((l) => l.event === 'summary');
  assert.equal(summaryLog?.kind, 'model_gateway');
  assert.equal(summaryLog?.run_id, 'run_synthetic');
  assert.equal(summaryLog?.requests, 1);
  assert.ok(!JSON.stringify(logs).includes(KEY));
});

test('a gateway start failure falls back to the direct provider route and is logged', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-gateway-fallback-'));
  const upstream = createServer(async (req, res) => {
    await collect(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseEvents('resp_direct'));
  });
  const port = await listen(upstream);
  process.env.BB_SYNTH_GATEWAY_KEY = KEY;
  t.after(async () => {
    delete process.env.BB_SYNTH_GATEWAY_KEY;
    await closeServer(upstream);
    await rm(dir, { recursive: true, force: true });
  });
  const config = await fakeCodexConfig(dir, 'http://127.0.0.1:' + port + '/?bad=query');
  const logs: Record<string, unknown>[] = [];
  const result = await runCodexProcess(
    { ...config, base_url: 'http://127.0.0.1:' + port },
    {
      prompt: 'synthetic',
      cwd: dir,
      codexHome: dir,
      home: dir,
      schemaFile: null,
      ephemeral: true,
      resumeThreadId: null,
      captureExecLog: true,
      gatewayLog: (line) => logs.push(line),
    },
  );
  assert.equal(result.turn_completed, true, 'gateway enabled path still works');
  const failing = await runCodexProcess(config, {
    prompt: 'synthetic',
    cwd: dir,
    codexHome: dir,
    home: dir,
    schemaFile: null,
    ephemeral: true,
    resumeThreadId: null,
    captureExecLog: true,
    gatewayLog: (line) => logs.push(line),
  });
  assert.ok(
    logs.some((l) => l.event === 'start_failed' && l.error === 'MODEL_GATEWAY_UPSTREAM_INVALID'),
  );
  assert.ok(
    !failing.exec_log!.bytes.toString().includes('[bondbuddy-model-gateway]'),
    'no appendix without a gateway',
  );
  assert.match(
    failing.exec_log!.bytes.toString(),
    /base=http:\/\/127\.0\.0\.1:\d+\/\?bad=query/,
    'child used the configured provider URL directly',
  );
});
