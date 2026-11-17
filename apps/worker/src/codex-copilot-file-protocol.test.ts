// Real pinned CLI and strict loopback provider only; no supplier or real credential.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';
import { classifyCodexResult, loadCodexAdapterConfig, runCodexProcess } from './codex-adapter.js';
import * as policies from './codex-adapter.js';

const binary = process.env.BB_TEST_CODEX_BIN;
const catalogUrl = new URL('../../../deploy/m1/codex-copilot-file-authoring-model-catalog.json', import.meta.url);
const packagedCatalog = '/opt/bondbuddy/codex-copilot-file-authoring-model-catalog.json';
const token = 'synthetic-copilot-file-protocol-token';
type Tool = { type: string; name: string; namespace?: string };
function tools(value: unknown, namespace?: string): Tool[] {
  return Array.isArray(value) ? value.flatMap((item: any) => item.type === 'namespace'
    ? tools(item.tools, item.name) : [{ type: item.type, name: item.name, ...(namespace ? { namespace } : {}) }]) : [];
}
function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value.map(part => typeof part?.text === 'string' ? part.text : '').join('\n') : '';
}
function hasJpegInput(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasJpegInput);
  const item = value as Record<string, unknown>;
  return item.type === 'input_image' && typeof item.image_url === 'string' && item.image_url.startsWith('data:image/jpeg;base64,')
    || Object.values(item).some(hasJpegInput);
}
function syntheticPng() {
  const chunk = (name: string, data: Buffer) => {
    const header = Buffer.alloc(8); header.writeUInt32BE(data.length); header.write(name, 4);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])) >>> 0);
    return Buffer.concat([header, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(16); header.writeUInt32BE(16, 4); header[8] = 8;
  const pixels = Buffer.alloc(17 * 16, 255); for (let row = 0; row < 16; row++) pixels[row * 17] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

test('Copilot file catalog matches the model and preserves direct bounded image tools', async () => {
  const catalog = JSON.parse(await readFile(catalogUrl, 'utf8'));
  assert.equal(catalog.models.length, 1);
  const model = catalog.models[0];
  assert.equal(model.slug, 'gpt-6-sol');
  assert.equal(model.shell_type, 'unified_exec');
  assert.equal(model.default_reasoning_level, 'max');
  assert.equal(model.default_reasoning_summary, 'none');
  assert.equal(model.tool_mode, 'direct');
  assert.equal(model.use_responses_lite, false);
  assert.equal(model.multi_agent_version, null);
  assert.deepEqual(model.input_modalities, ['text', 'image']);
  assert.deepEqual(model.experimental_supported_tools, []);
  assert.equal(model.supports_search_tool, false);
  assert.match(model.base_instructions, /Read task\.md and input\.json/);
  assert.match(model.base_instructions, /sandboxed shell and file tools/);
  assert.match(model.base_instructions, /bb_images\.view_image/);
  assert.match(model.base_instructions, /required output artifacts/);
  assert.doesNotMatch(model.base_instructions, /transcribe the supplied image|Do not use tools|Return only the requested structured answer/);
  assert.equal(model.model_messages, null, 'no alternate model prompt may override file authoring instructions');
  const dockerfile = await readFile(new URL('../../../deploy/m1/Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /COPY .*codex-copilot-file-authoring-model-catalog.json \/opt\/bondbuddy\/codex-copilot-file-authoring-model-catalog.json/);
});

for (const { executable, compact, label } of [
  { executable: true, compact: false, label: 'recovery preserves required reads and image round trips' },
  { executable: true, compact: true, label: 'recovery continues saved work after compaction' },
  { executable: false, compact: false, label: 'file auth failure preserves unknown usage' },
]) test(`real Codex 0.169: Copilot ${label}`, {
  skip: !binary ? 'set BB_TEST_CODEX_BIN to the pinned Linux CLI' : process.platform !== 'linux' ? 'Linux file sandbox required' : false,
  timeout: 90000,
}, async t => {
  await mkdir(join(homedir(), '.cache'), { recursive: true });
  const root = await mkdtemp(join(homedir(), '.cache', 'bb-copilot-file-protocol-'));
  const cwd = join(root, 'cwd'), home = join(root, 'home'), marker = join(root, 'auth-called');
  await mkdir(join(cwd, 'scratch'), { recursive: true }); await mkdir(join(cwd, 'output')); await mkdir(home);
  t.after(() => rm(root, { recursive: true, force: true }));
  const version = await promisify(execFile)(binary!, ['--version'], { env: { ...process.env, HOME: home, CODEX_HOME: home, TMPDIR: home } });
  assert.equal(version.stdout.trim(), 'codex-cli 0.169.0', 'the wire regression must use the release-pinned CLI');
  assert.deepEqual(await readFile(packagedCatalog), await readFile(catalogUrl), 'the image must ship the exact source catalog');
  const cliRoot = join(cwd, 'codex-test-runtime'), cli = join(cliRoot, 'bin', 'codex');
  await mkdir(join(cliRoot, 'bin'), { recursive: true }); await mkdir(join(cliRoot, 'codex-resources'));
  await copyFile(binary!, cli);
  await copyFile(join(dirname(dirname(binary!)), 'codex-resources', 'bwrap'), join(cliRoot, 'codex-resources', 'bwrap'));
  await writeFile(join(cwd, 'scratch', 'scan.png'), syntheticPng());
  await writeFile(join(cwd, 'input.json'), JSON.stringify({ synthetic: 'SYNTHETIC_MATERIAL_READ' }));
  await writeFile(join(cwd, 'knowledge.md'), 'SYNTHETIC_KNOWLEDGE_READ\n');
  const savedWork = 'SYNTHETIC_SAVED_WORK: continuation step remains unfinished.\n';
  await writeFile(join(cwd, 'scratch', 'worklog.md'), savedWork);
  const pinnedPrompt = 'SYNTHETIC_PINNED_TASK: Read input.json and knowledge.md, inspect the image, then complete the same saved task.';
  const helper = join(root, 'fake-auth'), wrapper = join(root, 'wrapper.mjs');
  await writeFile(helper, `#!${process.execPath}\nimport('node:fs').then(fs=>{fs.appendFileSync(${JSON.stringify(marker)},'called\\n');process.stdout.write(${JSON.stringify(token)}+'\\n');});\n`);
  await chmod(helper, executable ? 0o700 : 0o600);
  await writeFile(wrapper, `import {spawn} from 'node:child_process';
const args=process.argv.slice(2).map(value=>value.startsWith('model_providers.copilot_enterprise.auth.command=')?'model_providers.copilot_enterprise.auth.command='+JSON.stringify(${JSON.stringify(helper)}):value);
const child=spawn(${JSON.stringify(cli)},args,{stdio:'inherit'});child.on('error',()=>process.exit(97));child.on('close',code=>process.exit(code??98));
`);
  const requests: { authenticated: boolean; bytes: number; compact: boolean; continuation: boolean; pinned: boolean;
    materials: boolean; knowledge: boolean; image: boolean; handoff: boolean; worklog: boolean; written: boolean }[] = [];
  const violations: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks), body = JSON.parse(raw.toString()), declared = tools(body.tools);
    const isCompact = declared.length === 0, count = requests.filter(request => !request.compact).length + 1;
    const shell = declared.find(tool => tool.name === 'exec_command' && tool.type === 'function');
    const image = declared.find(tool => tool.type === 'function' && tool.name.endsWith('view_image') && (tool.namespace === 'mcp__bb_images' || tool.name.includes('bb_images')));
    const inputs: any[] = Array.isArray(body.input) ? body.input : [];
    const readSucceeded = (call: string, marker: string) => {
      const output = outputText(inputs.find(item => item.type === 'function_call_output' && item.call_id === call)?.output);
      return output.includes(marker) && /Process exited with code 0/.test(output);
    };
    const instructions = [body.instructions ?? '', ...inputs.filter(item => item.type === 'message').map(item => outputText(item.content))].join('\n');
    const developer = inputs.filter(item => item.role === 'developer').map(item => outputText(item.content)).join('\n');
    const observation = { authenticated: req.headers.authorization === 'Bearer ' + token, bytes: raw.length,
      compact: isCompact, continuation: typeof policies.FILE_AUTHORING_CONTINUATION_INSTRUCTIONS === 'string' && developer.includes(policies.FILE_AUTHORING_CONTINUATION_INSTRUCTIONS), pinned: instructions.includes(pinnedPrompt),
      materials: readSucceeded('call_materials', 'SYNTHETIC_MATERIAL_READ'), knowledge: readSucceeded('call_knowledge', 'SYNTHETIC_KNOWLEDGE_READ'), image: hasJpegInput(inputs),
      handoff: instructions.includes('SYNTHETIC_CONTINUATION_HANDOFF'), worklog: readSucceeded('call_worklog', 'SYNTHETIC_SAVED_WORK'), written: readSucceeded('call_write', 'SYNTHETIC_CONTINUED_AFTER_COMPACTION') };
    requests.push(observation);
    if (!observation.authenticated) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('bad request: missing required Authorization header\n'); return; }
    if (!observation.continuation) violations.push('runtime_continuation_policy_missing');
    if (!observation.pinned) violations.push('original_pinned_task_lost');
    if (isCompact && !compact) {
      violations.push('unexpected_recovery_compaction'); res.writeHead(400); res.end('Synthetic recovery compacted before completing required reads'); return;
    }
    if (req.url !== '/responses' || body.model !== 'gpt-6-sol' || body.reasoning?.effort !== 'max' || !isCompact && (!shell || !image)
      || !instructions.includes('Read task.md and input.json') || !instructions.includes('sandboxed shell and file tools')
      || declared.some(tool => tool.namespace === 'collaboration' || tool.name === 'view_image' && !tool.namespace)) {
      violations.push('unexpected_protocol_shape'); res.writeHead(400); res.end('Synthetic protocol shape rejected'); return;
    }
    let item: Record<string, unknown>;
    if (isCompact) {
      const compactText = outputText(inputs.at(-1)?.content);
      if (typeof policies.FILE_AUTHORING_COMPACT_PROMPT !== 'string' || !compactText.includes(policies.FILE_AUTHORING_COMPACT_PROMPT)) violations.push('custom_handoff_policy_missing');
      if (!observation.materials || !observation.knowledge) violations.push('required_reads_missing_from_compaction');
      item = { type: 'message', id: 'msg_handoff', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'SYNTHETIC_CONTINUATION_HANDOFF: input and knowledge were read. Reconcile scratch/worklog.md, inspect scratch/scan.png, then save the unfinished continuation step. These are synthetic execution notes, not verified financial facts.', annotations: [] }] };
    } else {
      if ((!compact || count === 2) && count >= 2 && !observation.materials) violations.push('material_read_lost');
      if (!compact && count >= 3 && !observation.knowledge) violations.push('knowledge_read_lost');
      if (compact && count >= 3 && !observation.handoff) violations.push('continuation_handoff_lost');
      if (compact && count >= 4 && !observation.worklog) violations.push('saved_work_not_read_after_compaction');
      if (count === (compact ? 5 : 4) && !observation.image) violations.push('image_result_missing');
      if (compact && count === 6 && !observation.written) violations.push('continued_write_missing');
      const shellCall = (call_id: string, cmd: string) => ({ type: 'function_call', id: 'fc_' + call_id, call_id, name: shell!.name,
        arguments: JSON.stringify({ cmd, workdir: cwd, shell: '/bin/bash', login: false, max_output_tokens: 2048, yield_time_ms: 10000 }) });
      item = count <= 2 ? shellCall(count === 1 ? 'call_materials' : 'call_knowledge', count === 1 ? '/usr/bin/cat input.json' : '/usr/bin/cat knowledge.md')
        : compact && count === 3 ? shellCall('call_worklog', '/usr/bin/cat scratch/worklog.md')
        : count === (compact ? 4 : 3) ? { type: 'function_call', id: 'fc_image', call_id: 'call_image', name: image!.name, ...(image!.namespace ? { namespace: image!.namespace } : {}), arguments: JSON.stringify({ path: 'scratch/scan.png' }) }
        : compact && count === 5 ? shellCall('call_write', '/usr/bin/printf SYNTHETIC_CONTINUED_AFTER_COMPACTION | /usr/bin/tee output/continuation.txt')
        : { type: 'message', id: 'msg_done', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] };
    }
    // Synthetic provider usage exercises the real CLI threshold; this is not a tokenizer measurement.
    const inputTokens = isCompact ? 100 : compact && count === 2 ? 65000 : 33000;
    const response = { id: 'resp_synthetic_' + requests.length, object: 'response', status: 'completed', model: 'gpt-6-sol', output: [item],
      usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }])
      res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const config = loadCodexAdapterConfig({ BB_CODEX_AUTH_MODE: 'copilot_enterprise', BB_COPILOT_OAUTH_FILE: '/run/secrets/bb-copilot-oauth',
    BB_CODEX_PROVIDER: 'copilot_enterprise', BB_CODEX_MODEL: 'gpt-6-sol', BB_CODEX_BASE_URL: 'https://api.enterprise.githubcopilot.com',
    BB_CODEX_REASONING_EFFORT: 'max', BB_CODEX_CONFIG_VERSION: 'synthetic-copilot-file-v1', BB_MODEL_GATEWAY_MODE: 'enforce', BB_MODEL_MAX_REQUEST_BYTES: '2097152' });
  const result = await runCodexProcess({ ...config, command: [process.execPath, wrapper], base_url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    work_root: root, timeout_ms: 45000, kill_grace_ms: 500, exec_log_max_bytes: 8 * 1024 * 1024 }, {
    prompt: pinnedPrompt, cwd, home, codexHome: home, schemaFile: null,
    ephemeral: true, resumeThreadId: null, fileAuthoring: true, fileRecovery: true, fileCompletion: true, captureExecLog: true, gatewayLog: () => {},
  });
  const log = result.exec_log?.bytes.toString() ?? '';
  assert.ok(!/Model metadata for.*gpt-6-sol.*not found/.test(log), 'the selected catalog must resolve the actual model');
  assert.ok(!log.includes(token), 'command auth must stay out of captured logs');
  assert.deepEqual(violations, []);
  assert.ok(requests.every(request => request.bytes <= 2 * 1024 * 1024));
  if (executable) {
    assert.equal(result.turn_completed, true, log.slice(-3000));
    assert.equal(requests.length, compact ? 7 : 4);
    assert.equal(requests.filter(request => request.compact).length, compact ? 1 : 0);
    assert.ok(requests.every(request => request.authenticated));
    assert.ok(requests.every(request => request.continuation && request.pinned), 'runtime policy and original pinned task survive compaction');
    assert.equal(requests[1].materials, true); assert.equal(requests[2].knowledge, true); assert.equal(requests[compact ? 5 : 3].image, true);
    for (const marker of ['SYNTHETIC_MATERIAL_READ', 'SYNTHETIC_KNOWLEDGE_READ', ...(compact ? ['SYNTHETIC_SAVED_WORK', 'SYNTHETIC_CONTINUED_AFTER_COMPACTION'] : [])])
      assert.ok(result.file_diagnostics?.tools.some(tool => tool.exit_code === 0 && typeof tool.output === 'string'
        && tool.output.includes(marker)), 'the actual shell event must report the required file read');
    if (compact) {
      assert.equal(await readFile(join(cwd, 'scratch', 'worklog.md'), 'utf8'), savedWork, 'continuation preserves the restored file');
      assert.equal(await readFile(join(cwd, 'output', 'continuation.txt'), 'utf8'), 'SYNTHETIC_CONTINUED_AFTER_COMPACTION');
    }
    assert.equal((await readFile(marker, 'utf8')).trim(), 'called');
  } else {
    assert.equal(requests.length, 1, 'a 400 is not retried');
    assert.equal(requests[0].authenticated, false);
    await assert.rejects(access(marker));
    assert.match(log, /Permission denied/); assert.match(log, /missing required Authorization header/);
    const classified = classifyCodexResult(result, value => ({ ok: true, value }));
    assert.equal(classified.error_code, 'MODEL_TURN_FAILED');
    assert.equal(classified.usage.status, 'unknown');
    assert.notEqual(classified.outcome, 'confirmed_not_sent');
  }
});
