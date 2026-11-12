// SYNTHETIC fake-codex test. No real provider is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_EXEC_LOG_MAX_BYTES } from '@bondbuddy/api/exec-logs';
import {
  createCodexExecLogCapture,
  DEFAULT_CODEX_EXEC_LOG_MAX_BYTES,
  DEFAULT_DISABLED_FEATURES,
  loadCodexAdapterConfig,
  runCodexProcess,
  runContainedModelCall,
  type CodexAdapterConfig,
  type ContainedCallInput
} from './codex-adapter.js';
import { MemoryCodexJournal } from './codex-memory-journal.js';

const fake = fileURLToPath(new URL('../test-fixtures/codex/fake-codex.mjs', import.meta.url));
const secret = 'synthetic-credential-value-for-exec-log-tests';
const answerSchema = { type: 'object', properties: { answer: { type: 'string' }, n: { type: 'integer' } }, required: ['answer', 'n'], additionalProperties: false };
const isAnswer = (v: unknown) => typeof v === 'object' && v !== null && typeof (v as { answer?: unknown }).answer === 'string' && Number.isInteger((v as { n?: unknown }).n);
const markerBytes = Buffer.byteLength('[stdout]\n\n[stderr]\n');

test('capture includes markers in its exact byte budget and truncates only on overflow', () => {
  const cap = 64, capture = createCodexExecLogCapture(cap);
  capture.stdout('a'.repeat(cap - markerBytes - 3));
  capture.stderr('中');
  const exact = capture.finish();
  assert.equal(exact.bytes.length, cap);
  assert.equal(exact.truncated, false);
  assert.ok(exact.bytes.subarray(-3).equals(Buffer.from('中')));
  capture.stderr('x');
  capture.stdout('ignored after overflow');
  const overflow = capture.finish();
  assert.equal(overflow.truncated, true);
  assert.deepEqual(overflow.bytes, exact.bytes);
});

test('a saturated default capture fits the API storage limit including its markers', () => {
  assert.equal(DEFAULT_CODEX_EXEC_LOG_MAX_BYTES, CODEX_EXEC_LOG_MAX_BYTES);
  const capture = createCodexExecLogCapture(DEFAULT_CODEX_EXEC_LOG_MAX_BYTES);
  capture.stdout('a'.repeat(CODEX_EXEC_LOG_MAX_BYTES - markerBytes));
  capture.stderr('one byte over the total budget');
  const log = capture.finish();
  assert.equal(log.bytes.length, CODEX_EXEC_LOG_MAX_BYTES);
  assert.equal(log.truncated, true);
  assert.ok(log.bytes.subarray(-Buffer.byteLength('\n[stderr]\n')).equals(Buffer.from('\n[stderr]\n')));
});

test('the smallest supported cap preserves complete markers and rejects unstoreable budgets', () => {
  const capture = createCodexExecLogCapture(markerBytes);
  assert.equal(capture.finish().truncated, false);
  capture.stdout('x');
  assert.deepEqual(capture.finish(), { bytes: Buffer.from('[stdout]\n\n[stderr]\n'), truncated: true });
  assert.equal(loadCodexAdapterConfig({ BB_CODEX_EXEC_LOG_MAX_BYTES: String(markerBytes) }).exec_log_max_bytes, markerBytes);
  for (const invalid of [markerBytes - 1, CODEX_EXEC_LOG_MAX_BYTES + 1]) {
    assert.throws(() => createCodexExecLogCapture(invalid), { code: 'MODEL_ADAPTER_CONFIG_INVALID' });
    assert.throws(() => loadCodexAdapterConfig({ BB_CODEX_EXEC_LOG_MAX_BYTES: String(invalid) }), { code: 'MODEL_ADAPTER_CONFIG_INVALID' });
  }
});

async function setup(overrides: Partial<CodexAdapterConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bb-codex-exec-log-'));
  const config: CodexAdapterConfig = {
    command: [process.execPath, fake], model_id: 'deepseek-flash', model_provider: 'deepseek', base_url: 'https://api.deepseek.com',
    wire_api: 'responses', model_config_version: 'codex-deepseek-flash-test', reasoning_effort: null,
    credential: { kind: 'env', name: 'BB_SYNTHETIC_DEEPSEEK_KEY' }, work_root: root, timeout_ms: 5000, kill_grace_ms: 200,
    max_output_bytes: 1 << 20, max_schema_reasks: 1, disabled_features: DEFAULT_DISABLED_FEATURES, path_env: '/usr/bin:/bin', ...overrides
  };
  return { root, config, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const processOptions = (root: string, captureExecLog = true) => ({ prompt: 'SCENARIO:exec_log', cwd: root, codexHome: root, home: root,
  schemaFile: null, ephemeral: true, resumeThreadId: null, captureExecLog });

test('capture keeps raw stdout JSONL and the full stderr, and redacts the env credential', async () => {
  process.env.BB_SYNTHETIC_DEEPSEEK_KEY = secret;
  const { root, config, cleanup } = await setup();
  try {
    const result = await runCodexProcess(config, processOptions(root));
    assert.equal(result.turn_completed, true);
    assert.equal(result.stop, null);
    const log = result.exec_log!;
    assert.equal(log.truncated, false);
    const text = log.bytes.toString('utf8');
    assert.match(text, /^\[stdout\]\n\{"type":"fake\.trace"/);
    assert.match(text, /\{"type":"thread\.started","thread_id":"thread-exec-log"\}\n/);
    assert.match(text, /\{"type":"turn\.completed"/);
    assert.match(text, /\[stderr\]\nsynthetic stderr line 1\nsynthetic stderr line 2 without newline/);
    assert.equal(text.includes(secret), false, 'the credential value is never persisted');
    assert.match(text, /\[REDACTED\]/);
  } finally { await cleanup(); delete process.env.BB_SYNTHETIC_DEEPSEEK_KEY; }
});

test('a small cap truncates the private log without interrupting the Codex run', async () => {
  const { root, config, cleanup } = await setup({ exec_log_max_bytes: 96 });
  try {
    const result = await runCodexProcess(config, processOptions(root));
    assert.equal(result.turn_completed, true, 'truncating the log does not stop the provider turn');
    assert.equal(result.stop, null);
    assert.equal(result.exec_log!.truncated, true);
    assert.ok(result.exec_log!.bytes.length <= 96);
    assert.match(result.exec_log!.bytes.toString('utf8'), /^\[stdout\]\n/);
  } finally { await cleanup(); }
});

test('capture is opt-in and the loader bounds BB_CODEX_EXEC_LOG_MAX_BYTES', async () => {
  assert.equal(loadCodexAdapterConfig({}).exec_log_max_bytes, DEFAULT_CODEX_EXEC_LOG_MAX_BYTES);
  assert.equal(loadCodexAdapterConfig({ BB_CODEX_EXEC_LOG_MAX_BYTES: '4096' }).exec_log_max_bytes, 4096);
  assert.throws(() => loadCodexAdapterConfig({ BB_CODEX_EXEC_LOG_MAX_BYTES: '0' }), { code: 'MODEL_ADAPTER_CONFIG_INVALID' });
  assert.throws(() => loadCodexAdapterConfig({ BB_CODEX_EXEC_LOG_MAX_BYTES: 'nope' }), { code: 'MODEL_ADAPTER_CONFIG_INVALID' });
  const { root, config, cleanup } = await setup();
  try {
    const result = await runCodexProcess(config, processOptions(root, false));
    assert.equal(result.turn_completed, true);
    assert.equal(result.exec_log, undefined);
  } finally { await cleanup(); }
});

test('a contained attempt persists the same private log through its journal', async () => {
  process.env.BB_SYNTHETIC_DEEPSEEK_KEY = secret;
  const { root, config, cleanup } = await setup();
  try {
    const journal = new MemoryCodexJournal();
    const input: ContainedCallInput = {
      owner_user_id: 'user-synthetic', project_id: 'project-synthetic', job_id: 'job-synthetic', run_id: 'run-synthetic',
      trace_id: 'run-synthetic', logical_call_id: 'logical-synthetic', prompt_snapshot_ref: 'prompt-synthetic',
      prompt: 'SCENARIO:exec_log', result_schema_version: 'answer-v1', output: { kind: 'json', schema: answerSchema, validate: isAnswer },
      newCallId: () => 'call-synthetic-exec-log-1'
    };
    const result = await runContainedModelCall(input, journal, config);
    assert.equal(result.status, 'completed');
    const stored = journal.execLogs.get('call-synthetic-exec-log-1');
    assert.ok(stored, 'the journal receives the attempt log');
    assert.equal(stored!.truncated, false);
    const text = stored!.bytes.toString('utf8');
    assert.match(text, /"type":"thread\.started"/);
    assert.match(text, /synthetic stderr line 1/);
    assert.equal(text.includes(secret), false);
  } finally { await cleanup(); delete process.env.BB_SYNTHETIC_DEEPSEEK_KEY; }
});
