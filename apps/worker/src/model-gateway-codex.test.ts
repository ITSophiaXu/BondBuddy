// Gateway/adapter integration uses a synthetic child and loopback provider by default.
// Real Codex checks additionally require BB_TEST_CODEX_BIN; no real provider is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deflateSync, crc32 } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import {
  classifyCodexResult,
  runCodexProcess,
  DEFAULT_DISABLED_FEATURES,
  type CodexAdapterConfig,
} from './codex-adapter.js';
import { MODEL_GATEWAY_EXEC_LOG_MARKER } from './model-gateway.js';

const codex = process.env.BB_TEST_CODEX_BIN;
const KEY = 'synthetic-e2e-key-5b2e';

/** Grayscale page with sparse dark specks: compresses like a scan, inflates when re-encoded. */
function scannedPagePng(width: number, height: number): Buffer {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const raw = Buffer.alloc((width + 1) * height, 255);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    if (y % 3) continue;
    for (let x = 0; x < width; x += 2)
      if (random() < 0.18) raw[y * (width + 1) + 1 + x] = Math.floor(random() * 120);
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

type Scripted = (
  call: number,
  body: Record<string, unknown>,
) => { status: number; item?: Record<string, unknown>; html?: string; incompleteReason?: string };
async function provider(script: Scripted) {
  const received: { bytes: number; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const body = JSON.parse(raw.toString('utf8'));
    received.push({ bytes: raw.length, body });
    const reply = script(received.length, body);
    if (reply.status !== 200) {
      res.writeHead(reply.status, { 'content-type': 'text/html' });
      res.end(reply.html ?? '');
      return;
    }
    const incomplete = reply.incompleteReason !== undefined;
    const response = {
      id: 'resp_e2e_' + received.length,
      object: 'response',
      status: incomplete ? 'incomplete' : 'completed',
      model: 'deepseek-flash',
      output: reply.item ? [reply.item] : [],
      ...(incomplete ? { incomplete_details: { reason: reply.incompleteReason } } : {}),
      usage: {
        input_tokens: 100,
        output_tokens: 5,
        total_tokens: 105,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-request-id': 'req_e2e_' + received.length,
    });
    const events = [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      ...(reply.item
        ? [
            { type: 'response.output_item.added', output_index: 0, item: reply.item },
            { type: 'response.output_item.done', output_index: 0, item: reply.item },
          ]
        : []),
      { type: incomplete ? 'response.incomplete' : 'response.completed', response },
    ];
    for (const e of events) res.write('event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n');
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    received,
    close: () =>
      new Promise<void>((r) => {
        (server as Server).closeAllConnections();
        server.close(() => r());
      }),
  };
}

async function setup(baseUrl: string) {
  const root = await mkdtemp(join(tmpdir(), 'bb-gateway-codex-'));
  const cwd = join(root, 'cwd'),
    home = join(root, 'home');
  await mkdir(cwd);
  await mkdir(home);
  await writeFile(join(cwd, 'page.png'), scannedPagePng(1542, 2184));
  // A named synthetic provider exercises the real CLI protocol without requiring
  // the production /opt/bondbuddy model catalog to be installed on a developer host.
  const config: CodexAdapterConfig = {
    command: [codex!],
    model_id: 'deepseek-flash',
    model_provider: 'synthetic',
    base_url: baseUrl,
    wire_api: 'responses',
    model_config_version: 'synthetic-gateway-e2e',
    reasoning_effort: null,
    credential: { kind: 'env', name: 'BB_SYNTH_E2E_KEY' },
    work_root: root,
    timeout_ms: 120000,
    kill_grace_ms: 500,
    max_output_bytes: 4 * 1024 * 1024,
    exec_log_max_bytes: 8 * 1024 * 1024,
    max_schema_reasks: 0,
    // Deliberately enable native view_image to reproduce the original payload growth;
    // production file authoring now uses the bounded bb_images tool instead.
    disabled_features: DEFAULT_DISABLED_FEATURES.filter((f) => f !== 'view_image'),
    path_env: '/usr/local/bin:/usr/bin:/bin',
    model_gateway: 'measure',
  };
  return { root, cwd, home, config };
}

function gatewaySection(log: string) {
  const at = log.indexOf(MODEL_GATEWAY_EXEC_LOG_MARKER);
  assert.ok(at >= 0, 'exec log carries the gateway appendix');
  return log
    .slice(at + MODEL_GATEWAY_EXEC_LOG_MARKER.length)
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

const viewImage = (cwd: string) => ({
  type: 'function_call',
  id: 'fc_e2e',
  call_id: 'call_e2e',
  name: 'view_image',
  arguments: JSON.stringify({ path: join(cwd, 'page.png') }),
});
const done = {
  type: 'message',
  id: 'msg_e2e',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'done', annotations: [] }],
};
function boundedImageTool(body: Record<string, unknown>) {
  const tools = body.tools as { type?: string; name?: string; tools?: { name?: string }[] }[];
  const namespace = tools.find(
    (tool) =>
      tool.type === 'namespace' &&
      tool.name === 'mcp__bb_images' &&
      tool.tools?.some((child) => child.name === 'view_image'),
  );
  if (namespace) return { name: 'view_image', namespace: namespace.name };
  const flat = tools.find(
    (tool) => tool.name?.includes('bb_images') && tool.name.endsWith('view_image'),
  );
  return flat ? { name: flat.name! } : null;
}

test(
  'real Codex: a viewed scan page is measured in every following request',
  { skip: !codex && 'set BB_TEST_CODEX_BIN', timeout: 120000 },
  async (t) => {
    let cwd = '';
    const upstream = await provider((call) => ({
      status: 200,
      item: call === 1 ? viewImage(cwd) : done,
    }));
    const s = await setup(upstream.url);
    cwd = s.cwd;
    process.env.BB_SYNTH_E2E_KEY = KEY;
    t.after(async () => {
      delete process.env.BB_SYNTH_E2E_KEY;
      await upstream.close();
      await rm(s.root, { recursive: true, force: true });
    });
    const logs: Record<string, unknown>[] = [];
    const result = await runCodexProcess(s.config, {
      prompt: 'Look at page.png and answer.',
      cwd: s.cwd,
      codexHome: s.home,
      home: s.home,
      schemaFile: null,
      ephemeral: true,
      resumeThreadId: null,
      captureExecLog: true,
      trace: {
        run_id: 'run_e2e',
        call_id: 'call-e2e',
        logical_call_id: 'file-authoring-v1',
        attempt_no: 1,
      },
      gatewayLog: (l) => logs.push(l),
    });
    assert.equal(result.turn_completed, true, result.exec_log?.bytes.toString().slice(-2000));
    assert.equal(result.last_message, 'done');
    assert.equal(upstream.received.length, 2);
    const section = gatewaySection(result.exec_log!.bytes.toString());
    const [summary, first, second] = section;
    assert.equal(summary.requests, 2);
    assert.equal(summary.max_image_count, 1);
    assert.deepEqual(
      [first.request_bytes, second.request_bytes],
      upstream.received.map((r) => r.bytes),
      'gateway sizes equal what the provider received',
    );
    assert.equal(first.request.image_count, 0);
    assert.equal(second.request.image_count, 1);
    const image = second.request.images[0];
    assert.ok(image.width > 0 && image.height > 0);
    assert.ok(
      second.request.image_data_url_bytes > 0.5 * second.request_bytes,
      'the image dominates the request',
    );
    assert.equal(second.response.upstream_request_id, 'req_e2e_2');
    assert.ok(!result.exec_log!.bytes.toString().includes(KEY));
    t.diagnostic(
      JSON.stringify({
        request_bytes: [first.request_bytes, second.request_bytes],
        image: {
          width: image.width,
          height: image.height,
          mime: image.mime,
          data_url_bytes: image.data_url_bytes,
          decoded_bytes: image.decoded_bytes,
          location: image.location,
        },
      }),
    );
    assert.ok(logs.some((l) => l.event === 'summary' && l.run_id === 'run_e2e'));
  },
);

test(
  'real Codex: provider 413 stops repeated requests and the gateway records the failing size',
  { skip: !codex && 'set BB_TEST_CODEX_BIN', timeout: 180000 },
  async (t) => {
    let cwd = '';
    const upstream = await provider((call) =>
      call === 1
        ? { status: 200, item: viewImage(cwd) }
        : {
            status: 413,
            html: '<html><head><title>413 Request Entity Too Large</title></head></html>',
          },
    );
    const s = await setup(upstream.url);
    cwd = s.cwd;
    process.env.BB_SYNTH_E2E_KEY = KEY;
    t.after(async () => {
      delete process.env.BB_SYNTH_E2E_KEY;
      await upstream.close();
      await rm(s.root, { recursive: true, force: true });
    });
    const logs: Record<string, unknown>[] = [];
    const result = await runCodexProcess(s.config, {
      prompt: 'Look at page.png and answer.',
      cwd: s.cwd,
      codexHome: s.home,
      home: s.home,
      schemaFile: null,
      ephemeral: true,
      resumeThreadId: null,
      captureExecLog: true,
      gatewayLog: (l) => logs.push(l),
    });
    assert.equal(result.turn_completed, false);
    assert.equal(result.stop, 'payload_rejected');
    assert.equal(result.provider_error_code, 'MODEL_PROVIDER_PAYLOAD_TOO_LARGE');
    assert.equal(result.usage.status, 'unknown');
    assert.equal(result.usage.total_tokens, null);
    const [summary, ...records] = gatewaySection(result.exec_log!.bytes.toString());
    assert.equal(summary.first_413_seq, 2);
    assert.equal(
      summary.status_counts['413'],
      1,
      'the rejected body reaches the provider only once',
    );
    assert.equal(upstream.received.length, 2);
    assert.equal(summary.requests, upstream.received.length);
    assert.ok(
      records.slice(1).every((r) => r.response.status === 413 && r.request.image_count === 1),
    );
    const live = logs.filter((l) => l.event === 'request');
    assert.equal(
      live.length,
      summary.status_counts['413'],
      'every 413 is visible in the live worker log',
    );
    t.diagnostic(
      JSON.stringify({
        attempts_413: summary.status_counts['413'],
        first_413_request_bytes: summary.first_413_request_bytes,
      }),
    );
  },
);

const outputLimitMessage = 'Incomplete response returned, reason: max_output_tokens';

test(
  'real Codex: HTTP 200 response.incomplete plus pinned JSONL failure identifies the provider output limit',
  { skip: !codex && 'set BB_TEST_CODEX_BIN', timeout: 30000 },
  async (t) => {
    const upstream = await provider(() => ({ status: 200, incompleteReason: 'max_output_tokens' }));
    const s = await setup(upstream.url);
    process.env.BB_SYNTH_E2E_KEY = KEY;
    t.after(async () => {
      delete process.env.BB_SYNTH_E2E_KEY;
      await upstream.close();
      await rm(s.root, { recursive: true, force: true });
    });
    const failures: unknown[] = [];
    const result = await runCodexProcess(
      { ...s.config, model_gateway: 'enforce', model_max_request_bytes: 2 * 1024 * 1024 },
      {
        prompt: 'Run the synthetic authoring task.',
        cwd: s.cwd,
        codexHome: s.home,
        home: s.home,
        schemaFile: null,
        ephemeral: true,
        resumeThreadId: null,
        fileAuthoring: true,
        contextRotation: true,
        captureExecLog: true,
        onEvent: (event) => {
          if (event.type === 'turn.failed') failures.push(event.error);
        },
        gatewayLog: () => {},
      },
    );
    assert.equal(result.exit_code, 1);
    assert.equal(result.stop, null);
    assert.deepEqual(failures, [{ message: outputLimitMessage }]);
    assert.equal(result.turn_completed, false);
    assert.equal(upstream.received.length, 1);
    const [, request] = gatewaySection(result.exec_log!.bytes.toString());
    assert.equal(request.response.status, 200);
    assert.equal(request.response.terminal_event, 'response.incomplete');
    assert.equal(request.response.incomplete_reason, 'max_output_tokens');
    assert.equal(request.response.usage.output_tokens, 5);
    const classified = classifyCodexResult(result, () =>
      assert.fail('an incomplete outcome cannot be accepted as a result'),
    );
    assert.equal(classified.outcome, 'pending_reconcile');
    assert.equal(classified.error_code, 'MODEL_PROVIDER_OUTPUT_LIMIT');
    assert.equal(classified.finish_reason, 'max_output_tokens');
    assert.equal(classified.usage.status, 'unknown');
    assert.equal(
      classified.usage.output_tokens,
      null,
      'one HTTP observation is not the whole CLI attempt usage',
    );
  },
);

test(
  'real Codex: enforcement blocks a scan-expanded request before the provider receives it',
  { skip: !codex && 'set BB_TEST_CODEX_BIN', timeout: 120000 },
  async (t) => {
    let cwd = '';
    const upstream = await provider((call) => ({
      status: 200,
      item: call === 1 ? viewImage(cwd) : done,
    }));
    const s = await setup(upstream.url);
    cwd = s.cwd;
    process.env.BB_SYNTH_E2E_KEY = KEY;
    t.after(async () => {
      delete process.env.BB_SYNTH_E2E_KEY;
      await upstream.close();
      await rm(s.root, { recursive: true, force: true });
    });
    const budget = 1024 * 1024;
    const result = await runCodexProcess(
      { ...s.config, model_gateway: 'enforce', model_max_request_bytes: budget },
      {
        prompt: 'Look at page.png and answer.',
        cwd: s.cwd,
        codexHome: s.home,
        home: s.home,
        schemaFile: null,
        ephemeral: true,
        resumeThreadId: null,
        captureExecLog: true,
        gatewayLog: () => {},
      },
    );
    assert.equal(result.stop, 'payload_rejected');
    assert.equal(result.turn_completed, false);
    assert.equal(result.provider_error_code, 'MODEL_PROVIDER_PAYLOAD_TOO_LARGE');
    assert.equal(
      upstream.received.length,
      1,
      'the initial request passes, but the image-bearing request is not forwarded',
    );
    const [summary, ...records] = gatewaySection(result.exec_log!.bytes.toString());
    const rejected = records.find((record) => record.outcome === 'gateway_rejected');
    assert.ok(rejected, 'the local refusal remains inspectable');
    assert.ok(rejected.request_bytes > budget);
    assert.equal(
      summary.usage.responses_with_usage,
      1,
      'the completed earlier HTTP response retains its measured usage',
    );
    assert.equal(summary.usage.input_tokens, 100);
    assert.equal(
      result.usage.status,
      'unknown',
      'one HTTP response cannot prove total CLI turn usage',
    );
    assert.equal(result.usage.total_tokens, null);
  },
);

test(
  'real Codex: a bounded-image control result retains its structured text content',
  { skip: !codex && 'set BB_TEST_CODEX_BIN', timeout: 120000 },
  async (t) => {
    const marker = 'BB_AUTHORING_IMAGE_BUDGET_EXCEEDED';
    const upstream = await provider((call, body) => {
      if (call > 1) return { status: 200, item: done };
      const tool = boundedImageTool(body);
      if (!tool) {
        t.diagnostic('Missing bounded-image MCP tool');
        return { status: 200, item: done };
      }
      return {
        status: 200,
        item: {
          type: 'function_call',
          id: 'fc_control',
          call_id: 'call_control',
          ...tool,
          arguments: JSON.stringify({ path: 'scratch/synthetic.png' }),
        },
      };
    });
    const s = await setup(upstream.url);
    const mcp = join(s.root, 'synthetic-control-mcp.mjs'),
      wrapper = join(s.root, 'synthetic-mcp-wrapper.mjs');
    await writeFile(
      mcp,
      `import {createInterface} from 'node:readline';
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
 const request=JSON.parse(line);if(request.id===undefined)continue;
 let result={};
 if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-bb-images',version:'1'}};
 else if(request.method==='tools/list')result={tools:[{name:'view_image',description:'Synthetic bounded-image control response; no image bytes.',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path']},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}}]};
 else if(request.method==='tools/call')result={isError:false,content:[{type:'text',text:${JSON.stringify(marker + '. Synthetic saved-work context rotation signal.')}}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
}
`,
    );
    // Keep the production adapter/CLI configuration, replacing only the MCP
    // server implementation with a deterministic text-only fixture.
    await writeFile(
      wrapper,
      `import {spawn} from 'node:child_process';
const args=process.argv.slice(4).map(value=>value.startsWith('mcp_servers.bb_images.args=')?'mcp_servers.bb_images.args='+JSON.stringify([process.argv[3]]):value);
const child=spawn(process.argv[2],args,{stdio:'inherit'});
child.on('error',()=>process.exit(1));child.on('close',code=>process.exit(code??1));
`,
    );
    process.env.BB_SYNTH_E2E_KEY = KEY;
    t.after(async () => {
      delete process.env.BB_SYNTH_E2E_KEY;
      await upstream.close();
      await rm(s.root, { recursive: true, force: true });
    });
    const events: Record<string, unknown>[] = [];
    const result = await runCodexProcess(
      { ...s.config, command: [process.execPath, wrapper, codex!, mcp] },
      {
        prompt: 'Call the bounded image tool once for scratch/synthetic.png.',
        cwd: s.cwd,
        codexHome: s.home,
        home: s.home,
        schemaFile: null,
        ephemeral: true,
        resumeThreadId: null,
        fileAuthoring: true,
        contextRotation: true,
        captureExecLog: true,
        onEvent: (event) => events.push(event),
        gatewayLog: () => {},
      },
    );
    const item = events.find(
      (event) =>
        event.type === 'item.completed' &&
        (event.item as { type?: string })?.type === 'mcp_tool_call',
    )?.item as
      | {
          server: string;
          tool: string;
          result?: { content?: { type: string; text?: string }[] };
          error?: unknown;
        }
      | undefined;
    assert.ok(item, result.exec_log?.bytes.toString().slice(-3000));
    t.diagnostic(JSON.stringify(item));
    assert.equal(item.server, 'bb_images');
    assert.equal(item.tool, 'view_image');
    const content = item.result?.content;
    assert.ok(content, 'the completed MCP item contains a structured result');
    assert.ok(
      content.some((block) => block.type === 'text' && block.text?.startsWith(marker)),
      'the adapter can inspect item.result.content without scraping an error string',
    );
    assert.ok(!content.some((block) => block.type === 'image'));
    assert.equal(result.stop, 'context_rotation');
    assert.equal(
      classifyCodexResult(result, () => ({ ok: true, value: {} })).error_code,
      'MODEL_CONTEXT_ROTATION_REQUIRED',
    );
    assert.ok(
      upstream.received.every((request) => !JSON.stringify(request.body).includes('data:image/')),
    );
  },
);

test(
  'real Codex: bounded MCP JPEG stays bounded in the following HTTP request',
  { skip: !codex && 'set BB_TEST_CODEX_BIN', timeout: 120000 },
  async (t) => {
    const upstream = await provider((call, body) => {
      if (call > 1) return { status: 200, item: done };
      const tool = boundedImageTool(body);
      if (!tool) {
        t.diagnostic('Missing bounded-image MCP tool');
        return { status: 200, item: done };
      }
      return {
        status: 200,
        item: {
          type: 'function_call',
          id: 'fc_bounded',
          call_id: 'call_bounded',
          ...tool,
          arguments: JSON.stringify({ path: 'scratch/scan.png' }),
        },
      };
    });
    const s = await setup(upstream.url);
    await mkdir(join(s.cwd, 'scratch'));
    await writeFile(join(s.cwd, 'scratch', 'scan.png'), scannedPagePng(1542, 2184));
    process.env.BB_SYNTH_E2E_KEY = KEY;
    t.after(async () => {
      delete process.env.BB_SYNTH_E2E_KEY;
      await upstream.close();
      await rm(s.root, { recursive: true, force: true });
    });
    const result = await runCodexProcess(s.config, {
      prompt: 'View scratch/scan.png with bb_images.view_image and answer.',
      cwd: s.cwd,
      codexHome: s.home,
      home: s.home,
      schemaFile: null,
      ephemeral: true,
      resumeThreadId: null,
      fileAuthoring: true,
      captureExecLog: true,
      gatewayLog: () => {},
    });
    assert.equal(result.turn_completed, true, result.exec_log?.bytes.toString().slice(-3000));
    assert.equal(upstream.received.length, 2);
    for (const { body } of upstream.received) {
      const tools = body.tools as { type?: string; name?: string; tools?: { name?: string }[] }[];
      assert.ok(Array.isArray(tools), 'inspect the actual tool catalog sent by the fixed CLI');
      assert.equal(
        tools.some(
          (tool) =>
            tool.name === 'view_image' ||
            (tool.type === 'namespace' &&
              tool.name !== 'mcp__bb_images' &&
              tool.tools?.some((child) => child.name === 'view_image')),
        ),
        false,
        'native view_image is absent from both flat tools and non-MCP namespaces',
      );
    }
    const [, first, second] = gatewaySection(result.exec_log!.bytes.toString());
    assert.equal(first.request.image_count, 0);
    assert.equal(second.request.image_count, 1, 'a successful real MCP call contributes one image');
    const image = second.request.images[0];
    assert.equal(
      image.mime,
      'image/jpeg',
      'Codex must not re-encode bounded JPEG as an unbounded PNG',
    );
    assert.ok(image.decoded_bytes <= 128 * 1024);
    assert.ok(
      image.data_url_bytes <= Math.ceil((128 * 1024) / 3) * 4 + 'data:image/jpeg;base64,'.length,
    );
    t.diagnostic(
      JSON.stringify({
        request_bytes: [first.request_bytes, second.request_bytes],
        image: {
          mime: image.mime,
          decoded_bytes: image.decoded_bytes,
          data_url_bytes: image.data_url_bytes,
          width: image.width,
          height: image.height,
        },
      }),
    );
  },
);

test(
  'real Codex: recovery shell preserves every bounded PDF JSON page and continuation cursor',
  { skip: !codex && 'set BB_TEST_CODEX_BIN', timeout: 120000 },
  async (t) => {
    const python = process.env.BONDBUDDY_WORD_PYTHON ?? '/opt/venv/bin/python';
    const pythonRoot = fileURLToPath(new URL('../../../python/', import.meta.url));
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    let expected: string[] = [],
      cwd = '';
    const upstream = await provider((call) => {
      if (call > expected.length) return { status: 200, item: done };
      const offset = (JSON.parse(expected[call - 1]) as { offset: number }).offset;
      const cmd = `${quote(python)} scratch/pdf_pages.py scratch/dense.pdf read --cache-dir scratch/pdf-cache --page 1 --offset ${offset} --limit 200 --ocr never`;
      return {
        status: 200,
        item: {
          type: 'function_call',
          id: `fc_page_${call}`,
          call_id: `call_page_${call}`,
          name: 'exec_command',
          arguments: JSON.stringify({
            cmd,
            workdir: cwd,
            shell: '/bin/bash',
            login: false,
            max_output_tokens: 2048,
            yield_time_ms: 10000,
          }),
        },
      };
    });
    const s = await setup(upstream.url);
    cwd = s.cwd;
    // Real shell tools need Codex's helper aliases. Current CLI versions refuse
    // to install those aliases beneath the system temporary directory.
    await mkdir(join(homedir(), '.cache'), { recursive: true });
    const cliHome = await mkdtemp(join(homedir(), '.cache', 'bb-codex-shell-test-'));
    const cliRoot = join(s.cwd, 'codex-test-runtime'),
      cliBinary = join(cliRoot, 'bin', 'codex');
    // The production binary lives in allowed /opt/codex. A developer's npm
    // cache is outside that boundary, so put the same binary in the read-only
    // task root for this sandbox test instead of allowing an entire home tree.
    await mkdir(join(cliRoot, 'bin'), { recursive: true });
    await mkdir(join(cliRoot, 'codex-resources'));
    await copyFile(codex!, cliBinary);
    await copyFile(
      join(dirname(dirname(codex!)), 'codex-resources', 'bwrap'),
      join(cliRoot, 'codex-resources', 'bwrap'),
    );
    process.env.BB_SYNTH_E2E_KEY = KEY;
    t.after(async () => {
      delete process.env.BB_SYNTH_E2E_KEY;
      await upstream.close();
      await rm(s.root, { recursive: true, force: true });
      await rm(cliHome, { recursive: true, force: true });
    });
    await mkdir(join(s.cwd, 'scratch'));
    // The production helper lives in allowed /app/python; keep the exact helper
    // bytes inside this test's permitted workspace instead of widening access to
    // the developer checkout for a native shell command.
    await writeFile(
      join(s.cwd, 'scratch', 'pdf_pages.py'),
      await readFile(join(pythonRoot, 'bondbuddy_file_authoring', 'pdf_pages.py')),
    );
    const script = `import json
from pathlib import Path
from pypdf import PdfWriter
from bondbuddy_file_authoring.pdf_pages import PdfPages, encoded
source=Path('scratch/dense.pdf')
writer=PdfWriter();writer.add_blank_page(width=612,height=792)
with source.open('wb') as output:writer.write(output)
records=[]
for index in range(6):
 text=(('营业收入应收账款净利润资产负债总额'*100)[:990] if index%2==0 else ('Receivables EBITDA revenue 123,456.78 98,765.43 '*100)[:1800])
 records.append({'record_id':f'p1-r{index+1}','page':1,'bbox':[10,10,500,60],'text':text,'confidence':None,'uncertainty':[]})
with PdfPages(source,'scratch/pdf-cache',language='eng') as pdf:
 pdf._store({'page':1,'mode':'native','coordinate_system':'pdf_points_top_left','width':612,'height':792,'image_count':0,'warnings':[],'records':records},'native')
 replies=[];offset=0
 while True:
  reply=pdf.read(1,offset=offset,limit=200,ocr='never');replies.append(encoded(reply).decode())
  if reply['next_offset'] is None:break
  offset=reply['next_offset']
 Path('scratch/expected.json').write_text(json.dumps(replies,ensure_ascii=False),encoding='utf-8')
`;
    await promisify(execFile)(python, ['-c', script], {
      cwd: s.cwd,
      env: { ...process.env, PYTHONPATH: pythonRoot },
    });
    expected = JSON.parse(
      await readFile(join(s.cwd, 'scratch', 'expected.json'), 'utf8'),
    ) as string[];
    assert.ok(expected.length > 1, 'dense evidence requires more than one bounded reply');
    assert.ok(expected.every((reply) => Buffer.byteLength(reply) <= 6 * 1024));
    const result = await runCodexProcess(
      { ...s.config, command: [cliBinary] },
      {
        prompt:
          'Read the synthetic dense PDF in bounded pages and preserve every continuation cursor.',
        cwd: s.cwd,
        codexHome: cliHome,
        home: s.home,
        schemaFile: null,
        ephemeral: true,
        resumeThreadId: null,
        fileAuthoring: true,
        fileRecovery: true,
        captureExecLog: true,
        gatewayLog: () => {},
      },
    );
    assert.equal(result.turn_completed, true, result.exec_log?.bytes.toString().slice(-3000));
    assert.equal(upstream.received.length, expected.length + 1);
    for (const [index, reply] of expected.entries()) {
      const nextRequest = JSON.stringify(upstream.received[index + 1].body);
      assert.ok(
        nextRequest.includes(JSON.stringify(reply).slice(1, -1)),
        `2048-token shell output must preserve complete PDF JSON page ${index + 1}, including its final cursor; ${JSON.stringify(upstream.received[index + 1].body.input).slice(-1800)}`,
      );
    }
    t.diagnostic(
      JSON.stringify({
        reply_bytes: expected.map((reply) => Buffer.byteLength(reply)),
        complete_json_pages: expected.length,
        shell_output_token_limit: 2048,
        next_offset_preserved: true,
      }),
    );
  },
);

test(
  'typed gateway rejection terminates a silent retrying child for local budgets and upstream 413',
  { timeout: 30000 },
  async (t) => {
    for (const rejection of ['local', 'upstream', 'after_usage'] as const) {
      await t.test(rejection, async (st) => {
        const upstream = await provider((call) =>
          rejection === 'upstream' || (rejection === 'after_usage' && call > 1)
            ? { status: 413, html: 'synthetic rejected' }
            : { status: 200, item: done },
        );
        const s = await setup(upstream.url);
        const script = join(s.root, 'synthetic-http-codex.mjs');
        // This child deliberately emits no HTTP error/status text. The adapter
        // must react to the trusted gateway event, without waiting for CLI logs.
        await writeFile(
          script,
          `for await (const chunk of process.stdin) {}
const arg=process.argv.find(value=>value.startsWith('model_providers.synthetic.base_url='));
const base=JSON.parse(arg.slice(arg.indexOf('=')+1));
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'synthetic-gateway-thread'})+'\\n');
const body=JSON.stringify({model:'deepseek-flash',input:'x'.repeat(${rejection === 'local' ? 2048 : 10})});
for(;;){try{const response=await fetch(base+'/responses',{method:'POST',headers:{'content-type':'application/json'},body});await response.arrayBuffer();}catch{} await new Promise(resolve=>setTimeout(resolve,25));}
`,
        );
        st.after(async () => {
          await upstream.close();
          await rm(s.root, { recursive: true, force: true });
        });
        const result = await runCodexProcess(
          {
            ...s.config,
            command: [process.execPath, script],
            model_gateway: 'enforce',
            model_max_request_bytes: 1024,
            timeout_ms: 10000,
            kill_grace_ms: 100,
          },
          {
            prompt: 'synthetic',
            cwd: s.cwd,
            codexHome: s.home,
            home: s.home,
            schemaFile: null,
            ephemeral: true,
            resumeThreadId: null,
            captureExecLog: true,
            gatewayLog: () => {},
          },
        );
        assert.equal(result.stop, 'payload_rejected');
        assert.equal(result.turn_completed, false);
        assert.ok(result.duration_ms < 5000, 'trusted refusal terminates before the model timeout');
        assert.equal(
          upstream.received.length,
          rejection === 'local' ? 0 : rejection === 'upstream' ? 1 : 2,
          'retries never cause another upstream send',
        );
        const classified = classifyCodexResult(result, () => ({ ok: false }));
        assert.equal(classified.outcome, 'failed');
        assert.equal(classified.error_code, 'MODEL_PROVIDER_PAYLOAD_TOO_LARGE');
        assert.equal(classified.usage.status, 'unknown');
        assert.equal(classified.usage.total_tokens, null);
        const [summary] = gatewaySection(result.exec_log!.bytes.toString());
        assert.equal(summary.mode, 'enforce');
        assert.ok(summary.requests >= 1);
        if (rejection === 'after_usage') {
          assert.equal(summary.usage.responses_with_usage, 1);
          assert.equal(
            summary.usage.input_tokens,
            100,
            'an earlier measured HTTP response survives the later refusal',
          );
          assert.equal(summary.usage.output_tokens, 5);
        }
        assert.ok(!result.exec_log!.bytes.toString().includes(KEY));
      });
    }
  },
);
