import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { Value } from '@sinclair/typebox/value';
import { schemas } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { azureBlobs, digest, transaction, uid } from './data.js';
import { emitInternal, internalEvent, observeUsage } from './observability.js';
import { action, finish, recordPotentialCall, type Lease } from './queue.js';
import { gateState, resetProcessGateForTests, tripEvidenceGate } from './evidence-gate.js';
import { checkLogHealth, forwardLogs, grantOperator, ndjsonFileSink, ndjsonSizeCapFromEnv, purgeLogContent, revokeOperator, savePromptSnapshot, scrubSecrets, type LogRecord, type LogSink } from './log-ops.js';
import { isolatedTestDatabase } from './test-database.js';

// Synthetic data only. No real provider, credential or customer material is used.
const connection = await isolatedTestDatabase();
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const skip = !connection || !blobConnection;
const ORIGIN = 'http://bondbuddy.test';
const SECRET_PROMPT = 'Synthetic prompt PLAINTEXT_MARKER_79. 验证码：482913.\nCookie: "bb_session=abc123secret"\napi_key="sk-synthetictestkey000000000000"\nAuthorization: "Bearer syntheticbearertoken"';
const GLUED_QUOTED_SUFFIXES = [
  ...['secret', 'password', 'C_o_o_k_i_e', String.raw`Co\u006Fkie`].flatMap(key =>
    [',', ';', '，', '；', String.raw`\u002C`, String.raw`\u003B`, String.raw`\uFF0C`, String.raw`\uFF1B`]
      .map(punctuation => `${key}="SYN_LEFT"${punctuation}SYN_RIGHT`)),
  'secret="SYN_LEFT\\\"MID",SYN_RIGHT',
  'secret="SYN_LEFT\\\\MID";SYN_RIGHT',
  'secret="SYN_LEFT\nMID"，SYN_RIGHT'
];

async function user(pool: Pool, prefix: string) {
  const id = `${prefix}-${uid().slice(0, 8)}`;
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id, `u${id.replace(/-/g, '_').toLowerCase()}`.slice(0, 32)]);
  return id;
}

async function fixture(pool: Pool) {
  // A drill that failed midway may leave the shared gate paused; reopen it for a clean start.
  if ((await gateState(pool)).state === 'paused') await pool.query("INSERT INTO bb_evidence_gate_events(id,state,reason_code,actor_type) VALUES($1,'open','synthetic_test_reset','system')", [uid()]);
  resetProcessGateForTests();
  const ownerA = await user(pool, 'logops-a'), ownerB = await user(pool, 'logops-b');
  const reader = await user(pool, 'logops-reader'), viewer = await user(pool, 'logops-viewer'), nobody = await user(pool, 'logops-none'), operatorUser = await user(pool, 'logops-op');
  await grantOperator(pool, { userId: reader, role: 'log_reader', grantedBy: 'synthetic-setup', reasonCode: 'synthetic_test' });
  await grantOperator(pool, { userId: operatorUser, role: 'log_operator', grantedBy: 'synthetic-setup', reasonCode: 'synthetic_test' });
  await grantOperator(pool, { userId: viewer, role: 'prompt_viewer', grantedBy: 'synthetic-setup', reasonCode: 'synthetic_test' });
  let current = ownerA;
  const app = createServer({ pool, blobs: azureBlobs(blobConnection!), allowedOrigin: ORIGIN, principal: async () => ({ userId: current, csrfVerified: true }), enableSyntheticQueue: true });
  // Each handle binds its own user per request, so interleaved handles never act as each other.
  const as = (userId: string) => (method: string, url: string, payload?: unknown) => { current = userId; return app.inject({ method: method as never, url, headers: { origin: ORIGIN }, payload: payload as never }); };
  async function runFor(owner: string, name: string) {
    const send = as(owner);
    const project = (await send('POST', '/api/v1/projects', { name, kind: 'update', issuer_name: null, market: null, offering: null })).json().project_id;
    const input = (await send('POST', `/api/v1/projects/${project}/input-revisions`, { draft_revision: 1, material_versions: [], requirement_message_ids: [] })).json();
    const created = await send('POST', '/api/v1/runs/execute', { execution_request_id: `exec-${uid()}`, project_id: project, input_revision: 1, input_hash: input.input_hash, task_kind: 'update', input_manifest_ref: 'synthetic-manifest', storage_origin: 'cloud', workspace_id: 'synthetic-workspace' });
    assert.equal(created.statusCode, 202, created.body);
    const runId = created.json().run_id;
    // Take this run's lease directly: the global claim() would race other suites' leftover jobs.
    const token = uid();
    const job = (await pool.query("UPDATE bb_jobs SET state='running',stage='claimed',lease_token=$2,lease_until=now()+interval '60 seconds',attempts=attempts+1 WHERE run_id=$1 RETURNING id,checkpoint", [runId, token])).rows[0];
    await pool.query("UPDATE bb_runs SET state='running' WHERE id=$1", [runId]);
    const lease: Lease = { jobId: job.id, runId, owner, token, checkpoint: job.checkpoint, attempts: 1 };
    return { project, runId, lease, inputHash: input.input_hash as string };
  }
  return { ownerA, ownerB, reader, viewer, nobody, operatorUser, app, as, runFor };
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function rawGetSocket(address: string, path: string) {
  const target = new URL(address);
  const socket = connect({ host: '127.0.0.1', port: Number(target.port) });
  socket.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
  return socket;
}

class MemorySink implements LogSink {
  name: string; seen = new Map<string, LogRecord>(); calls = 0; down = false;
  constructor(name: string) { this.name = name; }
  async deliver(records: LogRecord[]) { this.calls++; if (this.down) throw new Error('synthetic sink outage'); for (const r of records) this.seen.set(r.delivery_key, r); }
}
async function drain(pool: Pool, sink: LogSink, options = {}) {
  let total = 0;
  for (let i = 0; i < 50; i++) { const r = await forwardLogs(pool, sink, { batchSize: 500, ...options }); total += r.delivered; if (!r.claimed) break; }
  return total;
}

async function forwardInProcess(file: string, sinkName: string, crash: boolean) {
  const source = `import { Pool } from 'pg';
    const { forwardLogs, ndjsonFileSink } = await import(process.env.BB_TEST_LOG_MODULE);
    const pool = new Pool({ connectionString: process.env.BB_TEST_DATABASE_URL });
    try {
      const result = await forwardLogs(pool, ndjsonFileSink(process.env.BB_TEST_LOG_FILE, process.env.BB_TEST_LOG_SINK), {
        batchSize: 500, afterSinkAccept: ${crash ? 'async () => process.exit(17)' : 'undefined'}
      });
      process.stdout.write(JSON.stringify(result));
    } finally { await pool.end(); }`;
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, BB_TEST_DATABASE_URL: connection, BB_TEST_LOG_MODULE: new URL('./log-ops.js', import.meta.url).href,
        BB_TEST_LOG_FILE: file, BB_TEST_LOG_SINK: sinkName }
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('#79 scrubber removes secrets, captcha codes and cookies', () => {
  const out = scrubSecrets(SECRET_PROMPT + '\nset-cookie: x=1\npassword: hunter2hunter2\neyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U');
  for (const leaked of ['482913', 'abc123secret', 'sk-synthetictestkey', 'syntheticbearertoken', 'hunter2hunter2', 'eyJhbGciOiJIUzI1NiJ9', 'x=1']) assert.ok(!out.includes(leaked), leaked);
  assert.ok(out.includes('PLAINTEXT_MARKER_79'), 'ordinary prompt text survives');
});

test('#79 normalized loose keys never leave synthetic values in diagnostics', () => {
  for (const key of ['C_o_o_k_i_e', 'C-o-o-k-i-e', 'C o o k i e', String.raw`C \u006F o k i e`]) {
    for (const prefix of ['', '业务前文 ', '{} ', '{] ']) {
      for (const delimiter of ['=', ':', String.raw`\u003A`]) {
        const input = `${prefix}${key}${delimiter}SYN_LOOSE_SECRET`;
        try { assert.ok(!scrubSecrets(input).includes('SYN_LOOSE_SECRET')); }
        catch (error) { assert.equal((error as Error).message, 'Diagnostic body rejected'); }
      }
    }
  }
  for (const key of ['Cookie', 'session_cookie', 'x_api_key', 'one_time_password', 'otp']) {
    assert.equal(scrubSecrets(`${key}=SYN_PLAIN_SECRET`), `${key}=[REDACTED]`);
  }
});

test('#79 quoted fields preserve ordinary continuation and ambiguous unquoted fields reject', () => {
  const accepted = [
    'secret="SYN_LEFT,SYN_RIGHT" tail SYN_ORDINARY',
    'password="SYN_LEFT SYN_RIGHT" tail SYN_ORDINARY',
    'secret="SYN_LEFT,SYN_RIGHT", 普通业务事实',
    'secret="SYN_LEFT,SYN_RIGHT"; 普通业务事实',
    'secret="SYN_LEFT,SYN_RIGHT"， 普通业务事实',
    'secret="SYN_LEFT,SYN_RIGHT"； 普通业务事实',
    String.raw`secret="SYN_LEFT,SYN_RIGHT"\u002C 普通业务事实`,
    String.raw`secret="SYN_LEFT,SYN_RIGHT"\uFF1B 普通业务事实`,
    'secret="SYN_LEFT,SYN_RIGHT" 普通业务事实',
    '前文 secret="SYN_LEFT,SYN_RIGHT", 普通业务事实',
    'secret="SYN_LEFT,SYN_RIGHT",\r\n普通业务事实',
    'secret="SYN_LEFT,SYN_RIGHT";\r\n普通业务事实',
    'secret="SYN_LEFT,SYN_RIGHT"\r\n普通业务事实',
    'secret="SYN_LEFT\\\"SYN_RIGHT" tail SYN_ORDINARY',
    'secret="SYN_LEFT\\\\SYN_RIGHT"; 普通业务事实',
    'secret="SYN_LEFT\\,SYN_RIGHT" tail SYN_ORDINARY',
    'secret="SYN_LEFT\nSYN_RIGHT" tail SYN_ORDINARY',
    '{"secret":"SYN_LEFT,SYN_RIGHT","note":"SYN_ORDINARY"}',
    '{"password":"SYN_LEFT SYN_RIGHT","note":"SYN_ORDINARY"}',
    '{"Co\\u006Fkie":"SYN_LEFT,SYN_RIGHT","note":"SYN_ORDINARY"}'
  ];
  for (const body of accepted) {
    const cleaned = scrubSecrets(body);
    assert.ok(!cleaned.includes('SYN_LEFT') && !cleaned.includes('SYN_RIGHT'));
    if (body.includes('普通业务事实')) assert.ok(cleaned.endsWith(body.slice(body.indexOf('普通业务事实'))));
    else assert.ok(cleaned.includes('SYN_ORDINARY'));
    if (body.includes('secret="SYN_LEFT,SYN_RIGHT"'))
      assert.equal(cleaned, body.replace('secret="SYN_LEFT,SYN_RIGHT"', 'secret=[REDACTED]'));
  }
  for (const body of [...GLUED_QUOTED_SUFFIXES, 'secret="SYN_LEFT,SYN_RIGHT', 'password="SYN_LEFT\\', 'secret=', 'secret="SYN_LEFT"SYN_RIGHT',
    'secret=SYN_LEFT,SYN_RIGHT\r\ntail SYN_ORDINARY', 'password=SYN_LEFT SYN_RIGHT\r\ntail SYN_ORDINARY',
    'secret=SYN_SECRET 普通业务事实', 'secret=SYN_SECRET, 普通业务事实', 'secret=SYN_SECRET; 普通业务事实',
    'secret=SYN_SECRET:普通业务事实'])
    assert.throws(() => scrubSecrets(body), /Diagnostic body rejected/);
  assert.equal(scrubSecrets('secret=SYN_SINGLE\r\n普通业务事实'), 'secret=[REDACTED]\r\n普通业务事实');
});

test('#79 entire prose values and nested fields are safe in real Blob readback', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  const f = await fixture(pool);
  try {
    const blobs = azureBlobs(blobConnection!);
    const { project } = await f.runFor(f.ownerA, 'Synthetic whole-value scrub');
    const fragments = [
      'secret="SYN_LEFT,SYN_RIGHT" tail SYN_ORDINARY',
      'password="SYN_LEFT SYN_RIGHT" tail SYN_ORDINARY',
      'secret="SYN_LEFT,SYN_RIGHT", 普通业务事实',
      'secret="SYN_LEFT,SYN_RIGHT"; 普通业务事实',
      'secret="SYN_LEFT,SYN_RIGHT"， 普通业务事实',
      'secret="SYN_LEFT,SYN_RIGHT"； 普通业务事实',
      String.raw`secret="SYN_LEFT,SYN_RIGHT"\u002C 普通业务事实`,
      String.raw`secret="SYN_LEFT,SYN_RIGHT"\uFF1B 普通业务事实`,
      'secret="SYN_LEFT,SYN_RIGHT" 普通业务事实',
      '前文 secret="SYN_LEFT,SYN_RIGHT", 普通业务事实',
      'secret="SYN_LEFT,SYN_RIGHT",\r\n普通业务事实',
      'secret="SYN_LEFT,SYN_RIGHT";\r\n普通业务事实',
      'secret="SYN_LEFT,SYN_RIGHT"\r\n普通业务事实',
      'secret="SYN_LEFT\\\"SYN_RIGHT" tail SYN_ORDINARY',
      'secret="SYN_LEFT\\\\SYN_RIGHT"; 普通业务事实',
      'secret="SYN_LEFT\\,SYN_RIGHT" tail SYN_ORDINARY',
      'secret="SYN_LEFT\nSYN_RIGHT" tail SYN_ORDINARY',
      'C_o_o_k_i_e="SYN_LEFT,SYN_RIGHT" tail SYN_ORDINARY',
      '{"secret":"SYN_LEFT,SYN_RIGHT","note":"SYN_ORDINARY"}',
      '{"Co\\u006Fkie":"SYN_LEFT,SYN_RIGHT","note":"SYN_ORDINARY"}'
    ];
    const bodies = [...fragments];
    let nested = '{"password":"SYN_LEFT SYN_RIGHT","note":"SYN_ORDINARY"}';
    for (let layer = 1; layer <= 4; layer++) {
      nested = JSON.stringify({ note: nested });
      bodies.push(nested);
    }
    let encodedNested = '{"Co\\u006Fkie":"SYN_LEFT,SYN_RIGHT","note":"SYN_ORDINARY"}';
    for (let layer = 1; layer <= 4; layer++) {
      encodedNested = JSON.stringify({ note: encodedNested });
      bodies.push(encodedNested);
    }
    let puts = 0;
    const counted = { ...blobs, put: async (...args: Parameters<typeof blobs.put>) => { puts++; await blobs.put(...args); } };
    const countRefs = async () => Number((await pool.query('SELECT count(*)::int n FROM bb_snapshot_refs WHERE owner_user_id=$1 AND project_id=$2',
      [f.ownerA, project])).rows[0].n);
    for (const [index, body] of bodies.entries()) {
      const beforePuts = puts, beforeRefs = await countRefs();
      const id = await savePromptSnapshot(pool, counted, { owner: f.ownerA, projectId: project,
        kind: 'structured_input', version: index + 1, body });
      const row = (await pool.query('SELECT object_key,content_sha256,redaction_version FROM bb_snapshot_refs WHERE id=$1', [id])).rows[0];
      const stored = (await blobs.get(row.object_key)).toString('utf8');
      assert.ok(!stored.includes('SYN_LEFT') && !stored.includes('SYN_RIGHT'), `case ${index} retained a value`);
      if (body.includes('普通业务事实')) assert.ok(stored.includes('普通业务事实'));
      else assert.ok(stored.includes('SYN_ORDINARY'));
      if (body.includes('secret="SYN_LEFT,SYN_RIGHT"'))
        assert.equal(stored, body.replace('secret="SYN_LEFT,SYN_RIGHT"', 'secret=[REDACTED]'));
      assert.equal(row.content_sha256, digest(stored));
      assert.equal(row.redaction_version, 'scrub_v1');
      assert.equal(puts, beforePuts + 1);
      assert.equal(await countRefs(), beforeRefs + 1);
    }
    for (const body of [...GLUED_QUOTED_SUFFIXES, 'secret="SYN_LEFT,SYN_RIGHT', 'password="SYN_LEFT\\', 'secret=', 'secret="SYN_LEFT"SYN_RIGHT',
      'secret=SYN_LEFT,SYN_RIGHT\r\ntail SYN_ORDINARY', 'password=SYN_LEFT SYN_RIGHT\r\ntail SYN_ORDINARY',
      'secret=SYN_SECRET 普通业务事实', 'secret=SYN_SECRET, 普通业务事实', 'secret=SYN_SECRET; 普通业务事实',
      'secret=SYN_SECRET:普通业务事实',
      '前文 secret=SYN_SECRET 普通业务事实']) {
      const beforeRefs = await countRefs(), beforePuts = puts;
      await assert.rejects(savePromptSnapshot(pool, counted, { owner: f.ownerA, projectId: project,
        kind: 'structured_input', version: 99, body }),
      error => error instanceof Error && error.message === 'Diagnostic body rejected' && !error.stack?.includes('SYN_'));
      assert.equal(puts, beforePuts);
      assert.equal(await countRefs(), beforeRefs);
    }
    for (const fragment of ['secret="SYN_LEFT,SYN_RIGHT"', 'password="SYN_LEFT SYN_RIGHT"',
      'secret="SYN_LEFT\\\"SYN_RIGHT"', 'secret="SYN_LEFT\\,SYN_RIGHT"',
      'secret="SYN_LEFT\nSYN_RIGHT"', 'secret="SYN_LEFT,SYN_RIGHT']) {
      let body = fragment;
      for (let layer = 1; layer <= 4; layer++) {
        body = JSON.stringify({ note: body });
        const beforeRefs = await countRefs(), beforePuts = puts;
        await assert.rejects(savePromptSnapshot(pool, counted, { owner: f.ownerA, projectId: project,
          kind: 'structured_input', version: 100 + layer, body }),
        error => error instanceof Error && error.message === 'Diagnostic body rejected' && !error.stack?.includes('SYN_'));
        assert.equal(puts, beforePuts);
        assert.equal(await countRefs(), beforeRefs);
      }
    }
  } finally { await f.app.close(); await pool.end(); }
});

test('#79 ambiguous diagnostic rejection leaves structured run error evidence writable', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  const f = await fixture(pool);
  try {
    const blobs = azureBlobs(blobConnection!);
    const { project, runId, lease } = await f.runFor(f.ownerA, 'Synthetic rejected diagnostic run');
    let puts = 0;
    const counted = { ...blobs, put: async (...args: Parameters<typeof blobs.put>) => { puts++; await blobs.put(...args); } };
    await assert.rejects(savePromptSnapshot(pool, counted, { owner: f.ownerA, projectId: project,
      runId, kind: 'model_request', version: 1, body: 'secret=SYN_SECRET 普通业务事实' }),
    error => error instanceof Error && error.message === 'Diagnostic body rejected' && !error.stack?.includes('SYN_'));
    assert.equal(puts, 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_snapshot_refs WHERE run_id=$1', [runId])).rows[0].n, 0);
    await finish(pool, lease, 'failed', { errorCode: 'DATA_UNAVAILABLE', failedStage: 'model_generation' });
    const error = (await pool.query('SELECT code,category,stage,trace_id FROM bb_observability_errors WHERE job_id=$1', [lease.jobId])).rows[0];
    assert.deepEqual(error, { code: 'DATA_UNAVAILABLE', category: 'internal', stage: 'model_generation', trace_id: runId });
    assert.deepEqual((await pool.query('SELECT state,error_code FROM bb_jobs WHERE id=$1', [lease.jobId])).rows[0],
      { state: 'failed', error_code: 'DATA_UNAVAILABLE' });
  } finally { await f.app.close(); await pool.end(); }
});

function* syntheticFieldMatrix() {
  let seed = 0x237a1303;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const keys = ['Cookie', 'CoOkIe', 'C_o_o_k_i_e', 'C-o-o-k-i-e', 'C o o k i e',
    'setCookie', 'otp', 'secret', 'x_api_key', 'one_time_password', 'Authorization'];
  const delimiters = [':', '=', String.raw`\u003A`, String.raw`\u003D`];
  const contexts = [(value: string) => value, (value: string) => `前文 ${value} 后文`,
    (value: string) => `{} ${value}`, (value: string) => `{] ${value}`,
    (value: string) => JSON.stringify({ note: value })];
  for (let index = 0; index < 1400; index++) {
    const key = keys[next() % keys.length];
    const delimiter = delimiters[next() % delimiters.length];
    const context = contexts[next() % contexts.length];
    const layers = next() % 5;
    const marker = `SYN_MATRIX_${index}_MARKER`;
    const spelling = next() % 3 === 0 ? key.replace(/o/i, String.raw`\u006F`) : key;
    const quote = index % 2 === 0 ? '"' : '';
    let body = context(`${quote}${spelling}${quote}${delimiter}${quote}${marker}${quote}`);
    for (let layer = 0; layer < layers; layer++) body = JSON.stringify({ note: body });
    yield { index, body, marker, key, delimiter, layers, context: contexts.indexOf(context), quoted: !!quote };
  }
}

test('#79 fixed-seed decoded field matrix does not retain synthetic values', () => {
  for (const { index, body, marker } of syntheticFieldMatrix()) {
    try { assert.ok(!scrubSecrets(body).includes(marker), `matrix ${index} retained a value`); }
    catch (error) { assert.equal((error as Error).message, 'Diagnostic body rejected'); }
  }
});

test('#79 scrubber handles nested, embedded and escaped JSON without losing surrounding text', () => {
  const cases = [
    '{"Cookie":"SYN_COOKIE_A","nested":[{"otp":"654321","Authorization":"Bearer SYN_AUTH_A","token":"SYN_TOKEN_A","password":"SYN_PASSWORD_A","apiKey":"SYN_APIKEY_A","access_token":"SYN_ACCESS_A"}],"ordinary":"SYN_BUSINESS_A","token_budget":"SYN_BUDGET_A"}',
    '前文 SYN_BUSINESS_B\r\nbody={"cOoKiE":"SYN_COOKIE_B","OTP":"123456","验证码":"876543","验证码提示":"SYN_UNICODE_OK"}; tail SYN_TAIL_B\r\n',
    'prefix | {\\"Cookie\\":\\"SYN_COOKIE_C\\",\\"otp\\":\\"234567\\"} | suffix',
    '{"nested_json":"{\\"Cookie\\":\\"SYN_COOKIE_D\\",\\"otp\\":\\"345678\\"}","plain":"SYN_BUSINESS_D"}'
  ];
  for (const [index, input] of cases.entries()) {
    const output = scrubSecrets(input);
    for (const secret of ['SYN_COOKIE_A', '654321', 'SYN_AUTH_A', 'SYN_TOKEN_A', 'SYN_PASSWORD_A', 'SYN_APIKEY_A', 'SYN_ACCESS_A',
      'SYN_COOKIE_B', '123456', '876543', 'SYN_COOKIE_C', '234567', 'SYN_COOKIE_D', '345678']) {
      assert.ok(!output.includes(secret), `case ${index}: ${secret}`);
    }
    if (index === 0) assert.ok(output.includes('SYN_BUSINESS_A') && output.includes('SYN_BUDGET_A'));
    if (index === 1) {
      assert.ok(output.includes('SYN_BUSINESS_B\r\n'));
      assert.ok(output.includes('SYN_UNICODE_OK'));
      assert.ok(output.includes('SYN_TAIL_B\r\n'));
    }
    if (index === 2) assert.ok(output.includes('prefix | ') && output.includes(' | suffix'));
    if (index === 3) assert.ok(output.includes('SYN_BUSINESS_D'));
  }
});

test('#79 escaped JSON with quoted prose and Chinese business placeholders stays usable', () => {
  const note = 'He said "SYN_ORDINARY" and used \\ a path';
  const escaped = JSON.stringify(JSON.stringify({ Cookie: 'SYN_ESCAPED_COOKIE', note })).slice(1, -1);
  const placeholder = '{债券名称: 本期公司债}';
  const cleaned = scrubSecrets(`业务前文\r\n${escaped}\r\n${placeholder}\r\n业务后文`);
  assert.ok(!cleaned.includes('SYN_ESCAPED_COOKIE'));
  assert.ok(cleaned.includes(`业务前文\r\n`) && cleaned.includes(`${placeholder}\r\n业务后文`));
  const encoded = cleaned.split('\r\n')[1];
  const parsed = JSON.parse(JSON.parse(`"${encoded}"`));
  assert.equal(parsed.note, note);
  assert.equal(parsed.Cookie, '[REDACTED]');
});

test('#79 scrubber bounds JSON depth, body length and malformed brace work', () => {
  const inside = '{"session_cookie":"SYN_DEEP_SECRET"}';
  const nested = (depth: number) => '{"v":'.repeat(depth - 1) + inside + '}'.repeat(depth - 1);
  const accepted = scrubSecrets(nested(64));
  assert.ok(!accepted.includes('SYN_DEEP_SECRET'));
  for (const input of [nested(5000), '{'.repeat(20000) + '}'.repeat(20000), '{session_cookie:"SYN_MALFORMED"}', '{session_cookie SYN_BAD}', '{note: text, setCookie: SYN_LEAK_MARKER}', '{"session_cookie":"SYN_UNCLOSED"',
    '{] "Cookie":"SYN_LEAK_MARKER"}', '{] "setCookie":"SYN_LEAK_MARKER"}', '{] "otp":"SYN_LEAK_MARKER"}',
    '{note: text, ] "Cookie":"SYN_LEAK_MARKER"}', '{"note":"ordinary",] "Cookie":"SYN_LEAK_MARKER"}',
    '{"note":"ordinary"}{] "Cookie":"SYN_LEAK_MARKER"}', '{[} "Cookie":"SYN_LEAK_MARKER"}]',
    '{] } "Cookie":"SYN_LEAK_MARKER"', '{note: text, ] } "setCookie":"SYN_LEAK_MARKER"',
    '{"note":"ordinary"} "otp":"SYN_LEAK_MARKER"', '{] } "\\u0043ookie":"SYN_LEAK_MARKER"']) {
    const start = performance.now();
    assert.throws(() => scrubSecrets(input), error => error instanceof Error && error.message === 'Diagnostic body rejected' && !error.stack?.includes('SYN_'));
    assert.ok(performance.now() - start < 2000, 'rejection remains bounded for malformed or deep input');
  }
  const ordinaryBraces = '{section} 业务正文\r\n'.repeat(20000);
  const proseStart = performance.now();
  assert.equal(scrubSecrets(ordinaryBraces), ordinaryBraces);
  assert.ok(performance.now() - proseStart < 2000, 'many ordinary braces stay linear and unchanged');
  const businessPlaceholders = '{债券名称: 本期公司债}\r\n'.repeat(20000);
  const placeholderStart = performance.now();
  assert.equal(scrubSecrets(businessPlaceholders), businessPlaceholders);
  assert.ok(performance.now() - placeholderStart < 2000, 'many business placeholders stay bounded and unchanged');
  const plainKeys = scrubSecrets('session_cookie=SYN_PLAIN_COOKIE\r\nx_api_key=SYN_PLAIN_KEY\r\none_time_password=SYN_PLAIN_PASSWORD\r\notp=SYN_PLAIN_OTP\r\n业务正文');
  for (const secret of ['SYN_PLAIN_COOKIE', 'SYN_PLAIN_KEY', 'SYN_PLAIN_PASSWORD', 'SYN_PLAIN_OTP']) assert.ok(!plainKeys.includes(secret));
  assert.ok(plainKeys.endsWith('业务正文'));
  assert.ok(!scrubSecrets('{"\\u0043ookie":"SYN_ENCODED_KEY"}').includes('SYN_ENCODED_KEY'));
  for (const body of ['{} "Co\\u006Fkie":"SYN_LEAK_MARKER"', '{} "\\u0043ookie":"SYN_LEAK_MARKER"',
    '{} "Cookie":"SYN_LEAK_MARKER"', '{} "\\uD800":"SYN_INVALID_KEY"',
    '{"\\uD800":"SYN_INVALID_KEY"}', '{} "\\u00ZZ":"SYN_INVALID_ESCAPE"'])
    assert.throws(() => scrubSecrets(body), /Diagnostic body rejected/);
  assert.equal(scrubSecrets('业务正文 ]\r\n{} "\\uD83D\\uDE00债券名称":"SYN_ORDINARY_UNICODE"'),
    '业务正文 ]\r\n{} "\\uD83D\\uDE00债券名称":"SYN_ORDINARY_UNICODE"');
  let layeredOutside = '"Co\\u006Fkie":"SYN_LAYERED_OUTSIDE"';
  let ordinaryOutside = '"债券名称":"SYN_LAYERED_BUSINESS"';
  for (let layer = 0; layer <= 5; layer++) {
    assert.throws(() => scrubSecrets(`{} ${layeredOutside}`), /Diagnostic body rejected/);
    if (layer <= 4) assert.equal(scrubSecrets(`{} ${ordinaryOutside}`), `{} ${ordinaryOutside}`);
    layeredOutside = JSON.stringify(layeredOutside).slice(1, -1);
    ordinaryOutside = JSON.stringify(ordinaryOutside).slice(1, -1);
  }
  assert.throws(() => scrubSecrets('{"\\u0043ookie":"SYN_MALFORMED_UNICODE"'), /Diagnostic body rejected/);
  const layered = Array.from({ length: 6 }).reduce<string>(value => JSON.stringify({ note: value }), '{"Cookie":"SYN_LAYERED_SECRET"}');
  assert.throws(() => scrubSecrets(layered), /Diagnostic body rejected/);
  assert.equal(scrubSecrets('普通正文未闭合 { 和 [\r\n下一段业务内容'), '普通正文未闭合 { 和 [\r\n下一段业务内容');
  assert.equal(scrubSecrets('普通正文孤立 ]、[、{ 和 }\r\n下一段业务内容'), '普通正文孤立 ]、[、{ 和 }\r\n下一段业务内容');
  const windowsPath = JSON.stringify({ note: String.raw`C:\users\docs` });
  assert.equal(scrubSecrets(windowsPath), windowsPath);
  const pathInProse = String.raw`{path: C:\users\docs}`;
  assert.equal(scrubSecrets(pathInProse), pathInProse);
  const longBusinessKey = String.raw`\u0022` + 'Co' + ' '.repeat(65) + 'bond_name' + String.raw`\u0022\u003A` + 'SYN_ORDINARY_LONG_KEY';
  assert.equal(scrubSecrets(JSON.stringify({ note: longBusinessKey })), JSON.stringify({ note: longBusinessKey }));
  let excessiveLayers = JSON.stringify({ note: 'SYN_ORDINARY_DEEP' });
  for (let layer = 0; layer < 21; layer++) excessiveLayers = JSON.stringify({ note: excessiveLayers });
  assert.throws(() => scrubSecrets(excessiveLayers), /Diagnostic body rejected/);
  assert.throws(() => scrubSecrets(String.raw`Cookie\u003ASYN_ROOT_SECRET`), /Diagnostic body rejected/);
  assert.equal(scrubSecrets('{} setCookie=SYN_PLAIN_COOKIE'), '{} setCookie=[REDACTED]');
  const layeredBrackets = JSON.stringify({ note: 'SYN_ORDINARY four layers { [ and CRLF\r\n' });
  let wrappedBrackets = layeredBrackets;
  for (let layer = 0; layer < 4; layer++) wrappedBrackets = JSON.stringify({ note: wrappedBrackets });
  assert.equal(scrubSecrets(wrappedBrackets), wrappedBrackets);
  let quotedProse = JSON.stringify({ note: '"SYN_ORDINARY" prose continues' });
  for (let layer = 0; layer < 4; layer++) quotedProse = JSON.stringify({ note: quotedProse });
  assert.equal(scrubSecrets(quotedProse), quotedProse);
  assert.equal(scrubSecrets(JSON.stringify({ note: 'SYN_ORDINARY quoted "business": text\r\n' })),
    JSON.stringify({ note: 'SYN_ORDINARY quoted "business": text\r\n' }));
  const mixed = scrubSecrets('普通正文未闭合 { 和 [\r\n{"Cookie":"SYN_MIXED_COOKIE","note":"SYN_MIXED_BUSINESS"}');
  assert.ok(mixed.includes('普通正文未闭合 { 和 [\r\n') && mixed.includes('SYN_MIXED_BUSINESS'));
  assert.ok(!mixed.includes('SYN_MIXED_COOKIE'));
  assert.throws(() => scrubSecrets('{note: text,\r\n setCookie: SYN_MULTILINE_LEAK}'), /Diagnostic body rejected/);
  assert.throws(() => scrubSecrets('{note: text,\r\n "Cookie":"SYN_MULTILINE_QUOTED"}'), /Diagnostic body rejected/);
  assert.throws(() => scrubSecrets('{note: text,\r\n "\\u0043ookie":"SYN_MULTILINE_UNICODE"}'), /Diagnostic body rejected/);
  assert.throws(() => scrubSecrets('{note: text, "\\u0043ookie":"SYN_INLINE_UNICODE"}'), /Diagnostic body rejected/);
  const maxBody = 'A'.repeat(10 * 1024 * 1024);
  assert.equal(scrubSecrets(maxBody).length, maxBody.length);
  assert.throws(() => scrubSecrets(maxBody + 'B'), /Diagnostic body rejected/);
});

test('#79 large legal JSON and prompt-shaped text retain the full body', () => {
  const nearFragment = JSON.stringify({ note: 'A'.repeat(256 * 1024 - 100), Cookie: 'SYN_LIMIT_COOKIE' });
  const accepted = scrubSecrets(nearFragment);
  assert.ok(accepted.includes('A'.repeat(100)) && !accepted.includes('SYN_LIMIT_COOKIE'));
  const overFragment = JSON.stringify({ note: 'A'.repeat(256 * 1024), Cookie: 'SYN_OVER_COOKIE' });
  const larger = scrubSecrets(overFragment);
  assert.ok(larger.includes('A'.repeat(256 * 1024)) && !larger.includes('SYN_OVER_COOKIE'));
  const smallObject = '{"note":"x"}';
  assert.ok(scrubSecrets(smallObject.repeat(1024)).includes('"note"'));
  assert.ok(scrubSecrets(smallObject.repeat(1025)).includes('"note"'));
  const aggregate = JSON.stringify({ note: 'A'.repeat(200 * 1024) });
  assert.equal(scrubSecrets(aggregate.repeat(6)), aggregate.repeat(6));
  const wide = '[' + '0,'.repeat(5000).slice(0, -1) + ']';
  assert.equal(scrubSecrets(wide), wide);
});

test('#79 structured secrets are absent from the private diagnostic Blob readback', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  const f = await fixture(pool);
  try {
    const blobs = azureBlobs(blobConnection!);
    const { project } = await f.runFor(f.ownerA, 'Synthetic structured scrub');
    const body = 'business SYN_VISIBLE\r\n' + JSON.stringify({
      Cookie: 'SYN_COOKIE_BLOB', nested: [{ otp: '456789', Authorization: 'SYN_AUTH_BLOB', token: 'SYN_TOKEN_BLOB', password: 'SYN_PASSWORD_BLOB' }],
      session_cookie: 'SYN_SESSION_COOKIE_BLOB', x_api_key: 'SYN_X_API_KEY_BLOB', one_time_password: 'SYN_ONE_TIME_PASSWORD_BLOB',
      note: 'SYN_BUSINESS_BLOB', 验证码提示: 'SYN_UNICODE_BLOB'
    }) + '\r\nmore={\\"Cookie\\":\\"SYN_ESCAPED_BLOB\\",\\"otp\\":\\"567890\\"}';
    const snapshot = await savePromptSnapshot(pool, blobs, { owner: f.ownerA, projectId: project, kind: 'structured_input', version: 1, body });
    const row = (await pool.query('SELECT object_key,content_sha256,redaction_version FROM bb_snapshot_refs WHERE id=$1', [snapshot])).rows[0];
    const stored = (await blobs.get(row.object_key)).toString('utf8');
    for (const secret of ['SYN_COOKIE_BLOB', '456789', 'SYN_AUTH_BLOB', 'SYN_TOKEN_BLOB', 'SYN_PASSWORD_BLOB', 'SYN_ESCAPED_BLOB', '567890',
      'SYN_SESSION_COOKIE_BLOB', 'SYN_X_API_KEY_BLOB', 'SYN_ONE_TIME_PASSWORD_BLOB'])
      assert.ok(!stored.includes(secret), `Blob contains ${secret}`);
    for (const ordinary of ['SYN_VISIBLE\r\n', 'SYN_BUSINESS_BLOB', 'SYN_UNICODE_BLOB']) assert.ok(stored.includes(ordinary));
    assert.equal(row.content_sha256, digest(stored));
    assert.equal(row.redaction_version, 'scrub_v1');
  } finally { await f.app.close(); await pool.end(); }
});

test('#79 fixed-seed field matrix stays safe through real Blob and reference writes', { skip }, async t => {
  const pool = new Pool({ connectionString: connection });
  const f = await fixture(pool);
  try {
    const blobs = azureBlobs(blobConnection!);
    const { project } = await f.runFor(f.ownerA, 'Synthetic field matrix');
    const generated = [...syntheticFieldMatrix()];
    const covered = new Set<string>();
    const selected: typeof generated = [];
    for (const item of generated) {
      const dimensions = [`key:${item.key}`, `delimiter:${item.delimiter}`, `layer:${item.layers}`,
        `context:${item.context}`, `quote:${item.quoted}`];
      if (dimensions.some(dimension => !covered.has(dimension))) {
        selected.push(item);
        dimensions.forEach(dimension => covered.add(dimension));
      }
    }
    for (let index = 0; selected.length < 140 && index < generated.length; index += 9)
      if (!selected.includes(generated[index])) selected.push(generated[index]);
    assert.equal(selected.length, 140);
    for (const index of [5, 657, 693, 729, 837, 1089, 1125])
      assert.ok(selected.some(item => item.index === index), `previous Blob failure ${index} stays sampled`);
    let puts = 0, rejected = 0;
    const counted = { ...blobs, put: async (...args: Parameters<typeof blobs.put>) => { puts++; await blobs.put(...args); } };
    const countRefs = async () => Number((await pool.query('SELECT count(*)::int n FROM bb_snapshot_refs WHERE owner_user_id=$1 AND project_id=$2',
      [f.ownerA, project])).rows[0].n);
    for (const { index, body, marker } of selected) {
      const beforePuts = puts, beforeRefs = await countRefs();
      try {
        const id = await savePromptSnapshot(pool, counted, { owner: f.ownerA, projectId: project,
          kind: 'structured_input', version: index + 1, body });
        const row = (await pool.query('SELECT object_key,content_sha256,redaction_version FROM bb_snapshot_refs WHERE id=$1', [id])).rows[0];
        const stored = (await blobs.get(row.object_key)).toString('utf8');
        assert.ok(!stored.includes(marker), `matrix ${index} retained a value in Blob`);
        assert.equal(row.content_sha256, digest(stored));
        assert.equal(row.redaction_version, 'scrub_v1');
        assert.equal(puts, beforePuts + 1);
        assert.equal(await countRefs(), beforeRefs + 1);
      } catch (error) {
        assert.equal((error as Error).message, 'Diagnostic body rejected');
        assert.equal(puts, beforePuts, `matrix ${index} put a Blob before rejection`);
        assert.equal(await countRefs(), beforeRefs, `matrix ${index} left a reference`);
        rejected++;
      }
    }
    t.diagnostic(`140 real field-matrix probes: ${puts} safe Blob writes, ${rejected} zero-write rejections`);
  } finally { await f.app.close(); await pool.end(); }
});

test('#79 escaped quotes and business placeholders survive private Blob readback', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  const f = await fixture(pool);
  try {
    const blobs = azureBlobs(blobConnection!);
    const { project } = await f.runFor(f.ownerA, 'Synthetic escaped quote scrub');
    const note = 'He said "SYN_ORDINARY_BLOB" with \\ a path';
    const escaped = JSON.stringify(JSON.stringify({ Cookie: 'SYN_ESCAPED_COOKIE_BLOB', note })).slice(1, -1);
    const placeholder = '{债券名称: 本期公司债}';
    const body = `业务前文\r\n${escaped}\r\n${placeholder}\r\n业务后文`;
    const snapshot = await savePromptSnapshot(pool, blobs, { owner: f.ownerA, projectId: project, kind: 'structured_input', version: 1, body });
    const row = (await pool.query('SELECT object_key,content_sha256,redaction_version FROM bb_snapshot_refs WHERE id=$1', [snapshot])).rows[0];
    const stored = (await blobs.get(row.object_key)).toString('utf8');
    assert.ok(!stored.includes('SYN_ESCAPED_COOKIE_BLOB'));
    assert.ok(stored.includes(`业务前文\r\n`) && stored.includes(`${placeholder}\r\n业务后文`));
    const parsed = JSON.parse(JSON.parse(`"${stored.split('\r\n')[1]}"`));
    assert.equal(parsed.note, note);
    assert.equal(parsed.Cookie, '[REDACTED]');
    assert.equal(row.content_sha256, digest(stored));
    assert.equal(row.redaction_version, 'scrub_v1');
  } finally { await f.app.close(); await pool.end(); }
});

test('#79 full-size synthetic model diagnostics survive private Blob readback', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  const f = await fixture(pool);
  try {
    const blobs = azureBlobs(blobConnection!);
    const { project } = await f.runFor(f.ownerA, 'Synthetic full-size diagnostic');
    const facts = Array.from({ length: 46 }, (_, i) => ({ candidate_id: `synthetic-fact-${i}`, identity: { metric: `synthetic-metric-${i}` },
      evidence: [{ evidence_id: `synthetic-evidence-${i}`, status: 'verified' }], status: 'extracted' }));
    const historical = JSON.stringify({ candidate_facts: facts, original_blocks: [{ quote: 'SYN_ORDINARY_HISTORICAL' }],
      nested: { session_cookie: 'SYN_HISTORICAL_COOKIE' } }).padEnd(43_660, ' ');
    const largerHistorical = JSON.stringify({ candidate_facts: Array.from({ length: 250 }, (_, i) => ({ ...facts[i % facts.length], candidate_id: `fact-${i}` })),
      original_blocks: [{ quote: 'SYN_ORDINARY_LARGE' }] }).padEnd(239_000, ' ');
    const noHistory = JSON.stringify({ schema_version: 'no-history-generation-input-v1',
      facts: [{ statement: 'SYN_ORDINARY_NO_HISTORY', evidence_refs: ['synthetic-evidence'] }],
      Cookie: 'SYN_NO_HISTORY_COOKIE' }).padEnd(263_273, ' ');
    const nearLimit = JSON.stringify({ note: 'A'.repeat(10 * 1024 * 1024 - 90), otp: 'SYN_NEAR_LIMIT_OTP' });
    const nearLimitUnicode = JSON.stringify({ note: '债'.repeat(Math.floor((10 * 1024 * 1024 - 80) / 3)) });
    for (const [index, [body, ordinary, secret]] of ([
      [historical, 'SYN_ORDINARY_HISTORICAL', 'SYN_HISTORICAL_COOKIE'],
      [largerHistorical, 'SYN_ORDINARY_LARGE', 'SYN_NONE'],
      [noHistory, 'SYN_ORDINARY_NO_HISTORY', 'SYN_NO_HISTORY_COOKIE'],
      [nearLimit, 'A'.repeat(100), 'SYN_NEAR_LIMIT_OTP'],
      [nearLimitUnicode, '债'.repeat(100), 'SYN_NONE'],
      ['普通未闭合 { 和 [\r\n业务正文', '业务正文', 'SYN_NONE'],
      [`otp${' '.repeat(32_000)}X`, `otp${' '.repeat(32_000)}X`, 'SYN_NONE'],
      ['普通孤立 ]、[、{ 和 }\r\n业务正文', '业务正文', 'SYN_NONE'],
      ['业务正文 ]\r\n{} "\\uD83D\\uDE00债券名称":"SYN_UNICODE_BUSINESS"', 'SYN_UNICODE_BUSINESS', 'SYN_NONE'],
      [JSON.stringify({ note: 'SYN_ORDINARY quoted "business": text\r\n' }), 'SYN_ORDINARY quoted', 'SYN_NONE'],
      [JSON.stringify({ note: 'SYN_ORDINARY Cookie 政策；\\uD83D\\uDE00债券名称: 正文' }), 'SYN_ORDINARY Cookie 政策', 'SYN_NONE'],
      [JSON.stringify({ note: String.raw`SYN_ORDINARY C:\users\docs` }), JSON.stringify(String.raw`C:\users\docs`).slice(1, -1), 'SYN_NONE'],
      [JSON.stringify({ note: String.raw`\u0022Co` + ' '.repeat(65) + String.raw`bond_name\u0022\u003ASYN_ORDINARY_LONG_KEY` }), 'SYN_ORDINARY_LONG_KEY', 'SYN_NONE'],
      [JSON.stringify({ note: '{"Cookie":"SYN_INNER_COOKIE","note":"SYN_INNER_BUSINESS"}' }), 'SYN_INNER_BUSINESS', 'SYN_INNER_COOKIE'],
      [wrappedOrdinaryBrackets(), 'SYN_ORDINARY_FOUR_LAYERS', 'SYN_NONE'],
      ['普通正文\r\n{} setCookie=SYN_PLAIN_COOKIE\r\n后文', '后文', 'SYN_PLAIN_COOKIE'],
      ['普通正文\r\notp=SYN_PLAIN_OTP\r\n后文', '后文', 'SYN_PLAIN_OTP'],
      ['普通未闭合 { 和 [\r\n{"Cookie":"SYN_MIXED_BLOB","note":"SYN_MIXED_ORDINARY"}', 'SYN_MIXED_ORDINARY', 'SYN_MIXED_BLOB'],
    ] as const).entries()) {
      assert.ok(Buffer.byteLength(body) <= 10 * 1024 * 1024);
      const snapshot = await savePromptSnapshot(pool, blobs, { owner: f.ownerA, projectId: project,
        kind: 'model_request', version: index + 1, body }).catch(error => {
        throw new Error(`synthetic positive diagnostic ${index} rejected`, { cause: error });
      });
      const row = (await pool.query('SELECT object_key,content_sha256,redaction_version FROM bb_snapshot_refs WHERE id=$1', [snapshot])).rows[0];
      const stored = (await blobs.get(row.object_key)).toString('utf8');
      assert.ok(stored.includes(ordinary));
      assert.ok(!stored.includes(secret));
      assert.equal(row.content_sha256, digest(stored));
      assert.equal(row.redaction_version, 'scrub_v1');
    }
  } finally { await f.app.close(); await pool.end(); }
});

function wrappedOrdinaryBrackets(): string {
  let body = JSON.stringify({ note: 'SYN_ORDINARY_FOUR_LAYERS { [ "business": text\r\n' });
  for (let layer = 0; layer < 4; layer++) body = JSON.stringify({ note: body });
  return body;
}

test('#79 rejected diagnostics never call Blob put or register a partial snapshot', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  const f = await fixture(pool);
  try {
    const blobs = azureBlobs(blobConnection!);
    const { project } = await f.runFor(f.ownerA, 'Synthetic scrub rejection');
    const before = Number((await pool.query('SELECT count(*)::int n FROM bb_snapshot_refs WHERE owner_user_id=$1 AND project_id=$2', [f.ownerA, project])).rows[0].n);
    let puts = 0;
    const counted = { ...blobs, put: async (...args: Parameters<typeof blobs.put>) => { puts++; await blobs.put(...args); } };
    const deep = '{"v":'.repeat(5000) + '{"session_cookie":"SYN_REJECT_SECRET"}' + '}'.repeat(5000);
    const denseUnit = '{"Cookie":"S"},';
    const dense = '[' + denseUnit.repeat(Math.floor(9 * 1024 * 1024 / denseUnit.length)).slice(0, -1) + ']';
    for (const body of [deep, '{'.repeat(20000) + '}'.repeat(20000), '{"x_api_key":"SYN_BAD_JSON"',
      '{"\\u0043ookie":"SYN_BAD_UNICODE"', '{note: text, setCookie: SYN_LEAK_MARKER}', dense,
      '{] "Cookie":"SYN_LEAK_MARKER"}', '{] "setCookie":"SYN_LEAK_MARKER"}', '{] "otp":"SYN_LEAK_MARKER"}',
      '{note: text, ] "Cookie":"SYN_LEAK_MARKER"}', '{"note":"ordinary",] "Cookie":"SYN_LEAK_MARKER"}',
      '{"note":"ordinary"}{] "Cookie":"SYN_LEAK_MARKER"}', '{[} "Cookie":"SYN_LEAK_MARKER"}]',
      '{] } "Cookie":"SYN_LEAK_MARKER"', '{note: text, ] } "setCookie":"SYN_LEAK_MARKER"',
      '{"note":"ordinary"} "otp":"SYN_LEAK_MARKER"', '{] } "\\u0043ookie":"SYN_LEAK_MARKER"',
      '{} setCookie:SYN_LEAK_MARKER', '[] otp:SYN_LEAK_MARKER', '{} secret:SYN_LEAK_MARKER',
      String.raw`C \u006F o k i e\u003ASYN_A14_ENCODED_MARKER`,
      '{"note":? , "C o o k i e":"SYN_A14_MALFORMED_MARKER"}',
      '{note: text, } setCookie:SYN_LEAK_MARKER',
      'A'.repeat(10 * 1024 * 1024 + 1)]) {
      await assert.rejects(savePromptSnapshot(pool, counted, { owner: f.ownerA, projectId: project, kind: 'structured_input', version: 1, body }),
        error => error instanceof Error && error.message === 'Diagnostic body rejected' && !error.stack?.includes('SYN_'));
    }
    await assert.rejects(savePromptSnapshot(pool, counted, { owner: f.ownerA, projectId: project,
      kind: 'structured_input', version: 1,
      body: `{] ${JSON.stringify({ note: String.raw`Co\u006Fkie\u003ASYN_LEAK_MARKER` })}` }),
    error => error instanceof Error && error.message === 'Diagnostic body rejected' && !error.stack?.includes('SYN_'));
    const keys = ['Cookie', 'CoOkIe', 'setCookie', 'SET-COOKIE', 'otp', 'OtP', 'secret', 'SECRET',
      'session_cookie', 'SESSION-COOKIE', 'x-api-key', 'X_API_KEY', 'one_time_password', 'ONE-TIME-PASSWORD',
      'Authorization', 'AUTHORIZATION', 'token', 'password'];
    const prefixes = ['{} ', '[] ', '{] } ', '{"note":"ordinary"} ', '业务 ] '];
    for (const key of keys) for (const prefix of prefixes) for (const position of [0, Math.floor(key.length / 2), key.length - 1]) {
      const escaped = key.slice(0, position) + `\\u${key.charCodeAt(position).toString(16).padStart(4, '0')}` + key.slice(position + 1);
      const body = `${prefix}"${escaped}":"SYN_LEAK_MARKER"`;
      await assert.rejects(savePromptSnapshot(pool, counted, { owner: f.ownerA, projectId: project, kind: 'structured_input', version: 1, body }),
        error => error instanceof Error && error.message === 'Diagnostic body rejected' && !error.stack?.includes('SYN_'));
    }
    for (const key of keys) for (const prefix of ['{} ', '[] ', '{] } ']) {
      await assert.rejects(savePromptSnapshot(pool, counted, { owner: f.ownerA, projectId: project,
        kind: 'structured_input', version: 1, body: `${prefix}${key}:SYN_LEAK_MARKER` }),
      error => error instanceof Error && error.message === 'Diagnostic body rejected' && !error.stack?.includes('SYN_'));
    }
    // Complete outer JSON can conceal a key/value fragment in an ordinary
    // string value, without any inner object or array bracket.
    for (const key of ['Cookie', 'Authorization', 'setCookie', 'Co\\u006Fkie']) {
      let fragment = `"${key}":"SYN_LEAK_MARKER"`;
      for (let layer = 1; layer <= 4; layer++) {
        await assert.rejects(savePromptSnapshot(pool, counted, { owner: f.ownerA, projectId: project,
          kind: 'structured_input', version: 1, body: JSON.stringify({ note: fragment }) }),
        error => error instanceof Error && error.message === 'Diagnostic body rejected' && !error.stack?.includes('SYN_'));
        fragment = JSON.stringify(fragment);
      }
    }
    for (const form of [String.raw`Cookie\u003ASYN_LEAK_MARKER`, String.raw`"Cookie"\u003A"SYN_LEAK_MARKER"`,
      String.raw`Cookie\u003DSYN_LEAK_MARKER`, String.raw`"Cookie"\u003D"SYN_LEAK_MARKER"`,
      String.raw`Co\u006Fkie\u003ASYN_LEAK_MARKER`]) {
      let fragment = form;
      for (let layer = 1; layer <= 4; layer++) {
        await assert.rejects(savePromptSnapshot(pool, counted, { owner: f.ownerA, projectId: project,
          kind: 'structured_input', version: 1, body: JSON.stringify({ note: fragment }) }),
        error => error instanceof Error && error.message === 'Diagnostic body rejected' && !error.stack?.includes('SYN_'));
        fragment = JSON.stringify(fragment);
      }
    }
    // A complete quoted subtoken inside ordinary prose must use the same
    // decoded field classifier even at the final permitted string layer.
    for (const key of [String.raw`Co\u006Fkie`, 'setCookie', 'otp', 'secret']) {
      let fragment = String.raw`${key}\u003ASYN_LEAK_MARKER`;
      for (let layer = 1; layer <= 4; layer++) {
        for (const note of [JSON.stringify(fragment), `业务前文 ${JSON.stringify(fragment)} 业务后文`,
          `{} ${JSON.stringify(fragment)}`]) {
          await assert.rejects(savePromptSnapshot(pool, counted, { owner: f.ownerA, projectId: project,
            kind: 'structured_input', version: 1, body: JSON.stringify({ note }) }),
          error => error instanceof Error && error.message === 'Diagnostic body rejected' && !error.stack?.includes('SYN_'));
        }
        fragment = JSON.stringify(fragment);
      }
    }
    for (const form of [String.raw`\u0022Cookie\u0022\u003ASYN_LEAK_MARKER`,
      String.raw`\u0043ookie\u003ASYN_LEAK_MARKER`]) {
      await assert.rejects(savePromptSnapshot(pool, counted, { owner: f.ownerA, projectId: project,
        kind: 'structured_input', version: 1, body: JSON.stringify({ note: form }) }),
      error => error instanceof Error && error.message === 'Diagnostic body rejected' && !error.stack?.includes('SYN_'));
    }
    for (const spaces of [59, 63, 64, 65]) {
      let fragment = String.raw`\u0022Co` + ' '.repeat(spaces) + String.raw`okie\u0022\u003A"SYN_LEAK_MARKER"`;
      for (let layer = 1; layer <= 4; layer++) {
        await assert.rejects(savePromptSnapshot(pool, counted, { owner: f.ownerA, projectId: project,
          kind: 'structured_input', version: 1, body: JSON.stringify({ note: fragment }) }),
        error => error instanceof Error && error.message === 'Diagnostic body rejected' && !error.stack?.includes('SYN_'));
        fragment = JSON.stringify(fragment);
      }
    }
    for (const key of ['Cookie', 'Authorization', 'setCookie', 'otp', 'x_api_key', 'one_time_password']) {
      for (const position of [0, Math.floor(key.length / 2), key.length - 1]) {
        const escaped = key.slice(0, position) + `\\u${key.charCodeAt(position).toString(16).padStart(4, '0')}` + key.slice(position + 1);
        let fragment = `"${escaped}":"SYN_LEAK_MARKER"`;
        for (let layer = 1; layer <= 5; layer++) {
          await assert.rejects(savePromptSnapshot(pool, counted, { owner: f.ownerA, projectId: project,
            kind: 'structured_input', version: 1, body: JSON.stringify({ note: fragment }) }),
          error => error instanceof Error && error.message === 'Diagnostic body rejected' && !error.stack?.includes('SYN_'));
          fragment = JSON.stringify(fragment);
        }
      }
    }
    for (const fragment of ['otp:SYN_LEAK_MARKER', 'setCookie=SYN_LEAK_MARKER', 'secret:SYN_LEAK_MARKER',
      'Co\\u006Fkie:SYN_LEAK_MARKER', '\\u0043ookie=SYN_LEAK_MARKER',
      '"\\uD800":"SYN_LEAK_MARKER"', '"\\u00ZZ":"SYN_LEAK_MARKER"',
      '\\uD800:SYN_LEAK_MARKER', 'Co\\u00ZZkie:SYN_LEAK_MARKER']) {
      await assert.rejects(savePromptSnapshot(pool, counted, { owner: f.ownerA, projectId: project,
        kind: 'structured_input', version: 1, body: JSON.stringify({ note: fragment }) }),
      error => error instanceof Error && error.message === 'Diagnostic body rejected' && !error.stack?.includes('SYN_'));
    }
    for (const body of ['{} "Co\\u006Fkie":"SYN_LEAK_MARKER"', '{} \\"Co\\\\u006Fkie\\":\\"SYN_LEAK_MARKER\\"',
      '{} "\\uD800":"SYN_INVALID_KEY"', '{"\\uD800":"SYN_INVALID_KEY"}', '{} "\\u00ZZ":"SYN_INVALID_ESCAPE"'])
      await assert.rejects(savePromptSnapshot(pool, counted, { owner: f.ownerA, projectId: project, kind: 'structured_input', version: 1, body }),
        error => error instanceof Error && error.message === 'Diagnostic body rejected' && !error.stack?.includes('SYN_'));
    let layeredField = '"Co\\u006Fkie":"SYN_LAYERED_LEAK"';
    for (let layer = 0; layer <= 5; layer++) {
      await assert.rejects(savePromptSnapshot(pool, counted, { owner: f.ownerA, projectId: project, kind: 'structured_input', version: 1, body: `{} ${layeredField}` }),
        error => error instanceof Error && error.message === 'Diagnostic body rejected' && !error.stack?.includes('SYN_'));
      layeredField = JSON.stringify(layeredField).slice(1, -1);
    }
    // Former matrix leaks may now be safely redacted and saved; the separate
    // 140-case real Blob matrix verifies their readback and references.
    assert.equal(puts, 0, 'scrub rejects before Blob put');
    const after = Number((await pool.query('SELECT count(*)::int n FROM bb_snapshot_refs WHERE owner_user_id=$1 AND project_id=$2', [f.ownerA, project])).rows[0].n);
    assert.equal(after, before, 'no partial snapshot reference');
  } finally { await f.app.close(); await pool.end(); }
});

test('#79 wide JSON arrays stay bounded in 128/256 MiB child heaps', async t => {
  const moduleUrl = new URL('./log-ops.js', import.meta.url).href;
  for (const heapMiB of [128, 256]) for (const sizeMiB of [4, 9]) {
    const source = `import { performance } from 'node:perf_hooks';
      const { scrubSecrets } = await import(process.env.BB_TEST_LOG_MODULE);
      const unit = '{"note":"synthetic"},';
      const count = Math.ceil(${sizeMiB} * 1024 * 1024 / unit.length);
      const body = '[' + unit.repeat(count).slice(0, -1) + ']';
      const started = performance.now();
      const stored = scrubSecrets(body);
      const elapsedMs = Math.round(performance.now() - started);
      process.stdout.write(JSON.stringify({ accepted: stored === body, elapsedMs, peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024), inputMiB: ${sizeMiB} }));
      if (stored !== body) process.exitCode = 1;`;
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [`--max-old-space-size=${heapMiB}`, '--input-type=module', '-e', source], {
        env: { ...process.env, BB_TEST_LOG_MODULE: moduleUrl }
      });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout }));
    });
    assert.equal(result.code, 0, `${heapMiB} MiB heap, ${sizeMiB} MiB input`);
    const metrics = JSON.parse(result.stdout);
    assert.equal(metrics.accepted, true);
    assert.ok(metrics.elapsedMs < 2000, 'wide input parses without object-tree allocation');
    t.diagnostic(`${heapMiB} MiB heap / ${sizeMiB} MiB wide input: ${metrics.elapsedMs} ms, peak RSS ${metrics.peakRssMiB} MiB`);
  }
});

test('#79 prose rules scale linearly on long ordinary whitespace in bounded child heaps', async t => {
  const moduleUrl = new URL('./log-ops.js', import.meta.url).href;
  for (const heapMiB of [128, 256]) {
    const times: number[] = [];
    for (const spaces of [2_000, 4_000, 8_000, 16_000, 32_000]) {
      const source = `import { performance } from 'node:perf_hooks';
        const { scrubSecrets } = await import(process.env.BB_TEST_LOG_MODULE);
        const body = 'otp' + ' '.repeat(${spaces}) + 'X';
        const started = performance.now();
        const accepted = scrubSecrets(body) === body;
        process.stdout.write(JSON.stringify({ accepted, elapsedMs: performance.now() - started,
          peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }));
        if (!accepted) process.exitCode = 1;`;
      const result = await new Promise<{ code: number | null; stdout: string; timedOut: boolean }>((resolve, reject) => {
        const child = spawn(process.execPath, [`--max-old-space-size=${heapMiB}`, '--input-type=module', '-e', source],
          { env: { ...process.env, BB_TEST_LOG_MODULE: moduleUrl } });
        let stdout = '', timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 8_000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.resume();
        child.on('error', reject);
        child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, timedOut }); });
      });
      assert.equal(result.timedOut, false, `${heapMiB} MiB heap / ${spaces} spaces timed out`);
      assert.equal(result.code, 0);
      const metrics = JSON.parse(result.stdout);
      assert.equal(metrics.accepted, true);
      assert.ok(metrics.elapsedMs < 500, 'ordinary whitespace should not trigger backtracking growth');
      times.push(metrics.elapsedMs);
      t.diagnostic(`${heapMiB} MiB heap / ${spaces} spaces: ${metrics.elapsedMs.toFixed(1)} ms, peak RSS ${metrics.peakRssMiB} MiB`);
    }
    assert.ok(times[4] < Math.max(25, times[1] * 8), '32k input scales near linearly from 4k');
  }
});

test('#79 repeated non-delimiting escaped quotes have linear bounded work', async t => {
  const moduleUrl = new URL('./log-ops.js', import.meta.url).href;
  for (const heapMiB of [128, 256]) {
    const source = `import { performance } from 'node:perf_hooks';
      const { scrubSecrets } = await import(process.env.BB_TEST_LOG_MODULE);
      const unit = String.fromCharCode(92).repeat(3) + String.fromCharCode(34);
      const body = unit.repeat(1024 * 1024);
      const started = performance.now();
      const result = scrubSecrets(body);
      process.stdout.write(JSON.stringify({ accepted: result === body, elapsedMs: Math.round(performance.now() - started),
        peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }));
      if (result !== body) process.exitCode = 1;`;
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [`--max-old-space-size=${heapMiB}`, '--input-type=module', '-e', source],
        { env: { ...process.env, BB_TEST_LOG_MODULE: moduleUrl } });
      let stdout = '';
      child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.resume(); child.on('error', reject);
      child.on('close', code => resolve({ code, stdout }));
    });
    assert.equal(result.code, 0);
    const metrics = JSON.parse(result.stdout);
    assert.equal(metrics.accepted, true);
    assert.ok(metrics.elapsedMs < 2000);
    t.diagnostic(`${heapMiB} MiB heap / 4 MiB quote runs: ${metrics.elapsedMs} ms, peak RSS ${metrics.peakRssMiB} MiB`);
  }
});

test('#79 dense short strings and long escaped quotes share bounded scan work', async t => {
  const moduleUrl = new URL('./log-ops.js', import.meta.url).href;
  for (const heapMiB of [128, 256]) for (const kind of ['dense', 'long_key'] as const) {
    const source = `import { performance } from 'node:perf_hooks';
      const { scrubSecrets } = await import(process.env.BB_TEST_LOG_MODULE);
      const body = ${kind === 'dense'
        ? `'[' + '"x",'.repeat(900000).slice(0,-1) + ']'`
        : `String.raw\`\\u0022business\` + ' '.repeat(9*1024*1024) + String.raw\`name\\u0022\\u003Aordinary\``};
      const started = performance.now();
      const output = scrubSecrets(body);
      process.stdout.write(JSON.stringify({accepted:output===body, bytes:Buffer.byteLength(body),
        elapsedMs:Math.round(performance.now()-started), peakRssMiB:Math.round(process.resourceUsage().maxRSS/1024)}));
      if (output !== body) process.exitCode = 1;`;
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [`--max-old-space-size=${heapMiB}`, '--input-type=module', '-e', source],
        { env: { ...process.env, BB_TEST_LOG_MODULE: moduleUrl } });
      let stdout = '';
      child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.resume(); child.on('error', reject);
      child.on('close', code => resolve({ code, stdout }));
    });
    assert.equal(result.code, 0, `${heapMiB} MiB / ${kind}`);
    const metrics = JSON.parse(result.stdout);
    assert.equal(metrics.accepted, true);
    assert.ok(metrics.elapsedMs < 5000);
    t.diagnostic(`${heapMiB} MiB heap / ${kind} ${metrics.bytes} B: ${metrics.elapsedMs} ms, peak RSS ${metrics.peakRssMiB} MiB`);
  }
});

test('#79 densely sensitive wide arrays reject safely when redaction exceeds 10 MiB', async t => {
  const moduleUrl = new URL('./log-ops.js', import.meta.url).href;
  for (const heapMiB of [128, 256]) {
    const source = `import { performance } from 'node:perf_hooks';
      const { scrubSecrets } = await import(process.env.BB_TEST_LOG_MODULE);
      const unit = '{"Cookie":"S"},';
      const body = '[' + unit.repeat(Math.floor(9 * 1024 * 1024 / unit.length)).slice(0, -1) + ']';
      const started = performance.now();
      let safe = false;
      try { scrubSecrets(body); } catch (error) { safe = error?.message === 'Diagnostic body rejected' && !String(error?.stack).includes('Cookie'); }
      process.stdout.write(JSON.stringify({ safe, elapsedMs: Math.round(performance.now() - started), peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }));
      if (!safe) process.exitCode = 1;`;
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [`--max-old-space-size=${heapMiB}`, '--input-type=module', '-e', source],
        { env: { ...process.env, BB_TEST_LOG_MODULE: moduleUrl } });
      let stdout = '';
      child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.resume(); child.on('error', reject);
      child.on('close', code => resolve({ code, stdout }));
    });
    assert.equal(result.code, 0);
    const metrics = JSON.parse(result.stdout);
    assert.equal(metrics.safe, true);
    assert.ok(metrics.elapsedMs < 2000);
    t.diagnostic(`${heapMiB} MiB heap / 9 MiB dense sensitive input: ${metrics.elapsedMs} ms, peak RSS ${metrics.peakRssMiB} MiB`);
  }
});

test('#79 densely redacted valid 10 MiB arrays fit bounded child heaps', async t => {
  const moduleUrl = new URL('./log-ops.js', import.meta.url).href;
  for (const heapMiB of [128, 256]) {
    const source = `import { performance } from 'node:perf_hooks';
      const { scrubSecrets } = await import(process.env.BB_TEST_LOG_MODULE);
      const unit = '{"Cookie":"ABCDEFGHIJKL"},';
      const body = '[' + unit.repeat(Math.floor(10 * 1024 * 1024 / unit.length)).slice(0, -1) + ']';
      const started = performance.now();
      const result = scrubSecrets(body);
      const safe = result.includes('[REDACTED]') && !result.includes('ABCDEFGHIJKL');
      process.stdout.write(JSON.stringify({ safe, inputBytes: body.length, outputBytes: result.length,
        elapsedMs: Math.round(performance.now() - started), peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }));
      if (!safe) process.exitCode = 1;`;
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [`--max-old-space-size=${heapMiB}`, '--input-type=module', '-e', source],
        { env: { ...process.env, BB_TEST_LOG_MODULE: moduleUrl } });
      let stdout = '';
      child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.resume(); child.on('error', reject);
      child.on('close', code => resolve({ code, stdout }));
    });
    assert.equal(result.code, 0);
    const metrics = JSON.parse(result.stdout);
    assert.equal(metrics.safe, true);
    assert.ok(metrics.elapsedMs < 2000);
    t.diagnostic(`${heapMiB} MiB heap / ${metrics.inputBytes} B dense valid input: ${metrics.elapsedMs} ms, peak RSS ${metrics.peakRssMiB} MiB`);
  }
});

test('#79 dense ordinary colon strings stay bounded when every value is scanned', async t => {
  const moduleUrl = new URL('./log-ops.js', import.meta.url).href;
  for (const heapMiB of [128, 256]) {
    const source = `import { performance } from 'node:perf_hooks';
      const { scrubSecrets } = await import(process.env.BB_TEST_LOG_MODULE);
      const unit = '{"note":"synthetic: content"},';
      const body = '[' + unit.repeat(Math.floor((10 * 1024 * 1024 - 2) / unit.length)).slice(0, -1) + ']';
      const started = performance.now();
      const result = scrubSecrets(body);
      process.stdout.write(JSON.stringify({ accepted: result === body, inputBytes: body.length,
        elapsedMs: Math.round(performance.now() - started), peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }));
      if (result !== body) process.exitCode = 1;`;
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [`--max-old-space-size=${heapMiB}`, '--input-type=module', '-e', source],
        { env: { ...process.env, BB_TEST_LOG_MODULE: moduleUrl } });
      let stdout = '';
      child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.resume(); child.on('error', reject);
      child.on('close', code => resolve({ code, stdout }));
    });
    assert.equal(result.code, 0);
    const metrics = JSON.parse(result.stdout);
    assert.equal(metrics.accepted, true);
    assert.ok(metrics.elapsedMs < 2500);
    t.diagnostic(`${heapMiB} MiB heap / ${metrics.inputBytes} B dense colon input: ${metrics.elapsedMs} ms, peak RSS ${metrics.peakRssMiB} MiB`);
  }
});

test('#79 near-limit multibyte ordinary JSON remains complete in bounded heaps', async t => {
  const moduleUrl = new URL('./log-ops.js', import.meta.url).href;
  for (const heapMiB of [128, 256]) {
    const source = `import { performance } from 'node:perf_hooks';
      const { scrubSecrets } = await import(process.env.BB_TEST_LOG_MODULE);
      const body = JSON.stringify({note:'债'.repeat(Math.floor((10 * 1024 * 1024 - 80) / 3))});
      const started = performance.now();
      const result = scrubSecrets(body);
      process.stdout.write(JSON.stringify({accepted:result===body, inputBytes:Buffer.byteLength(body),
        elapsedMs:Math.round(performance.now()-started), peakRssMiB:Math.round(process.resourceUsage().maxRSS/1024)}));
      if (result !== body) process.exitCode = 1;`;
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [`--max-old-space-size=${heapMiB}`, '--input-type=module', '-e', source],
        { env: { ...process.env, BB_TEST_LOG_MODULE: moduleUrl } });
      let stdout = '';
      child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.resume(); child.on('error', reject);
      child.on('close', code => resolve({ code, stdout }));
    });
    assert.equal(result.code, 0);
    const metrics = JSON.parse(result.stdout);
    assert.equal(metrics.accepted, true);
    assert.ok(metrics.inputBytes <= 10 * 1024 * 1024 && metrics.inputBytes > 10_000_000);
    assert.ok(metrics.elapsedMs < 3000);
    t.diagnostic(`${heapMiB} MiB heap / ${metrics.inputBytes} B multibyte: ${metrics.elapsedMs} ms, peak RSS ${metrics.peakRssMiB} MiB`);
  }
});

test('#79 NDJSON sink cannot be split by log injection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb79-'));
  try {
    const file = join(dir, 'sink.ndjson');
    await ndjsonFileSink(file).deliver([{ delivery_key: 'a'.repeat(64), outbox_id: 'o1', event: { kind: 'error.recorded', stage: 'x\n{"kind":"forged.event"}\r\n' } }]);
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).kind, 'error.recorded');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('#79 file sink repeat and concurrent processes retain one durable line per key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb79-concurrent-'));
  try {
    const file = join(dir, 'sink.ndjson');
    const records = Array.from({ length: 35 }, (_, i) => ({ delivery_key: i.toString(16).padStart(64, '0'), outbox_id: `synthetic-${i}`, event: { kind: 'synthetic.event', seq: i } }));
    const sink = ndjsonFileSink(file);
    await Promise.all(Array.from({ length: 4 }, () => sink.deliver(records)));
    await sink.deliver(records);
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, records.length);
    assert.equal(new Set(lines.map(line => line.delivery_key)).size, records.length);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(`${file}.lock`)).mode & 0o777, 0o600);
    await assert.rejects(sink.deliver([{ ...records[0], event: { kind: 'changed' } }]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('#79 file sink fails closed on torn/corrupt lines and unsafe permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb79-corrupt-'));
  try {
    const file = join(dir, 'sink.ndjson');
    const record = { delivery_key: 'f'.repeat(64), outbox_id: 'synthetic', event: { kind: 'synthetic.event' } };
    const sink = ndjsonFileSink(file);
    for (const body of ['{"delivery_key":"partial"', '{"delivery_key":"invalid"}\n', '\n']) {
      await writeFile(file, body, { mode: 0o600 });
      await assert.rejects(sink.deliver([record]));
      assert.equal(await readFile(file, 'utf8'), body);
    }
    await writeFile(file, '', { mode: 0o600 });
    await chmod(file, 0o644);
    await assert.rejects(sink.deliver([record]));
    assert.equal(await readFile(file, 'utf8'), '');
    await chmod(file, 0o600);
    await chmod(`${file}.lock`, 0o644);
    await assert.rejects(sink.deliver([record]));
    assert.equal(await readFile(file, 'utf8'), '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('#79 replay of a complete pre-existing line still acknowledges only after file sync', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb79-complete-'));
  try {
    const file = join(dir, 'sink.ndjson');
    const record = { delivery_key: 'e'.repeat(64), outbox_id: 'synthetic', event: { kind: 'synthetic.event' } };
    const line = JSON.stringify({ delivery_key: record.delivery_key, ...record.event }) + '\n';
    await writeFile(file, line, { mode: 0o600 }); // models a complete append before the prior writer's fsync
    await ndjsonFileSink(file).deliver([record]);
    assert.equal(await readFile(file, 'utf8'), line);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('#79 size cap fails closed for new keys but permits replay of a full segment', async () => {
  assert.equal(ndjsonSizeCapFromEnv({}), 64 * 1024 * 1024);
  assert.throws(() => ndjsonSizeCapFromEnv({ BB_LOG_SINK_MAX_BYTES: '0' }));
  const dir = await mkdtemp(join(tmpdir(), 'bb79-cap-'));
  try {
    const file = join(dir, 'sink.ndjson');
    const first = { delivery_key: 'a'.repeat(64), outbox_id: 'synthetic-a', event: { kind: 'synthetic.event', padding: 'x'.repeat(200) } };
    const next = { delivery_key: 'b'.repeat(64), outbox_id: 'synthetic-b', event: { kind: 'synthetic.event' } };
    const sink = ndjsonFileSink(file, 'ndjson_file', 350);
    await sink.deliver([first]);
    const original = await readFile(file, 'utf8');
    assert.ok(Buffer.byteLength(original) < 350);
    await sink.deliver([first]);
    assert.equal(await readFile(file, 'utf8'), original);
    await assert.rejects(sink.deliver([next]));
    assert.equal(await readFile(file, 'utf8'), original);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('#79 replay also detects a key in a legacy rotated segment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb79-archive-'));
  try {
    const file = join(dir, 'sink.ndjson');
    const record = { delivery_key: 'c'.repeat(64), outbox_id: 'synthetic', event: { kind: 'synthetic.event' } };
    const sink = ndjsonFileSink(file);
    await sink.deliver([record]);
    const original = await readFile(file, 'utf8');
    await rename(file, `${file}.1`); // models a pre-fix scheduler rotation before PG acknowledgement
    await sink.deliver([record]);
    assert.equal(await readFile(`${file}.1`, 'utf8'), original);
    assert.equal(await readFile(file, 'utf8'), '');
    await writeFile(`${file}.1`, '{"delivery_key":"partial"', { mode: 0o600 });
    await assert.rejects(sink.deliver([record]), 'an incomplete archive is not silently ignored');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('#79 operator API: deny by default, filters, timeline, metrics, restricted prompt, corrections', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  const f = await fixture(pool);
  try {
    const blobs = azureBlobs(blobConnection!);
    const { project, runId, lease, inputHash } = await f.runFor(f.ownerA, 'Synthetic #79 ops');
    const snapshot = await savePromptSnapshot(pool, blobs, { owner: f.ownerA, projectId: project, runId, kind: 'user_prompt', version: 1, body: SECRET_PROMPT, inputRevision: 1, inputHash, templateVersion: 'synthetic_template_1', modelParametersVersion: 'synthetic_params_1' });
    const stored = await pool.query('SELECT object_key,content_sha256,redaction_version FROM bb_snapshot_refs WHERE id=$1', [snapshot]);
    const storedBody = (await blobs.get(stored.rows[0].object_key)).toString('utf8');
    assert.ok(!storedBody.includes('482913') && !storedBody.includes('abc123secret'), 'secrets never reach Blob');
    assert.equal(stored.rows[0].redaction_version, 'scrub_v1');

    // Retry pair: attempt 1 fails with measured usage, attempt 2 completes; plus a pending call.
    const a1 = await recordPotentialCall(pool, lease, 'draft-call', 1, { modelId: 'synthetic-model-a', promptSnapshotId: snapshot });
    const a2 = await recordPotentialCall(pool, lease, 'draft-call', 2, { modelId: 'synthetic-model-a', promptSnapshotId: snapshot });
    const a3 = await recordPotentialCall(pool, lease, 'qa-call', 1, { modelId: 'synthetic-model-b', promptSnapshotId: snapshot });
    await pool.query("UPDATE bb_model_call_attempts SET status='failed' WHERE id=$1", [a1]);
    await pool.query("UPDATE bb_model_call_attempts SET status='completed',provider_request_id='synthetic-req-2' WHERE id=$1", [a2]);
    await observeUsage(pool, { owner: f.ownerA, attemptId: a1, source: 'provider', sourceEventId: 'u1', status: 'measured', inputTokens: 100, outputTokens: 10, cachedInputTokens: 40, reasoningTokens: 5 });
    await observeUsage(pool, { owner: f.ownerA, attemptId: a2, source: 'provider', sourceEventId: 'u2', status: 'measured', inputTokens: 200, outputTokens: 50, cachedInputTokens: 80, reasoningTokens: 20 });
    // The same supplier call reported again by gateway and framework: counted once.
    await observeUsage(pool, { owner: f.ownerA, attemptId: a2, source: 'gateway', sourceEventId: 'g2', status: 'measured', inputTokens: 200, outputTokens: 50, cachedInputTokens: 80, reasoningTokens: 20 });
    await observeUsage(pool, { owner: f.ownerA, attemptId: a2, source: 'framework', sourceEventId: 'f2', status: 'measured', inputTokens: 200, outputTokens: 50, cachedInputTokens: 80, reasoningTokens: 20 });
    await observeUsage(pool, { owner: f.ownerA, attemptId: a3, source: 'provider', sourceEventId: 'u3', status: 'pending' });

    // Deny by default: non-operators, owners and wrong-role operators all get 404.
    const adminUrls = [`/api/v1/admin/logs/events`, `/api/v1/admin/metrics`, `/api/v1/admin/jobs/${lease.jobId}/timeline`, `/api/v1/admin/alerts`, `/api/v1/admin/evidence-gate`, `/api/v1/admin/prompts/${snapshot}?reason_code=support_case`];
    for (const who of [f.nobody, f.ownerA, f.ownerB]) for (const url of adminUrls) assert.equal((await f.as(who)('GET', url)).statusCode, 404, `${who} ${url}`);
    assert.equal((await f.as(f.reader)('GET', adminUrls[5])).statusCode, 404, 'log_reader cannot read plaintext');
    assert.equal((await f.as(f.viewer)('GET', adminUrls[0])).statusCode, 404, 'prompt_viewer is not a log_reader');
    assert.equal((await f.as(f.nobody)('POST', '/api/v1/admin/evidence-gate/resume', { reason_code: 'x' })).statusCode, 404);
    // Owner A still cannot see owner B's resources through user routes.
    const other = await f.runFor(f.ownerB, 'Synthetic other owner');
    assert.equal((await f.as(f.ownerA)('GET', `/api/v1/runs/${other.runId}`)).statusCode, 404);

    const read = f.as(f.reader);
    // Filter validation is the log-injection boundary for operator input.
    for (const bad of ['?user_id=a%0d%0aforged', '?unknown=1', '?from=yesterday', '?limit=501', '?error_code=bad code', '?status=RUNNING\n'])
      assert.equal((await read('GET', `/api/v1/admin/logs/events${bad}`)).statusCode, 422, bad);
    const events = await read('GET', `/api/v1/admin/logs/events?user_id=${f.ownerA}&job_id=${lease.jobId}&model_id=synthetic-model-a&limit=500`);
    assert.equal(events.statusCode, 200, events.body);
    assert.ok(Value.Check(schemas.AdminLogEventsResponse, events.json()));
    const kinds = events.json().items.map((e: any) => e.kind);
    assert.ok(kinds.includes('model.call_started') && kinds.includes('model.usage_observed'));
    assert.ok(events.json().items.every((e: any) => e.user_id === f.ownerA && e.job_id === lease.jobId));
    assert.ok(!events.json().items.some((e: any) => e.logical_call_id === 'qa-call'), 'model filter excludes other model attempts');
    const byTrace = await read('GET', `/api/v1/admin/logs/events?trace_id=${other.runId}`);
    assert.ok(byTrace.json().items.length > 0 && byTrace.json().items.every((e: any) => e.user_id === f.ownerB));

    const timeline = await read('GET', `/api/v1/admin/jobs/${lease.jobId}/timeline`);
    assert.equal(timeline.statusCode, 200, timeline.body);
    const t = timeline.json();
    assert.ok(Value.Check(schemas.AdminJobTimelineResponse, t));
    assert.equal(t.prompts[0].snapshot_id, snapshot);
    assert.equal(t.prompts[0].content_state, 'available');
    assert.equal(t.prompts[0].template_version, 'synthetic_template_1');
    assert.deepEqual(t.attempts.map((a: any) => [a.logical_call_id, a.attempt_no, a.status, a.usage_status]), [['draft-call', 1, 'failed', 'measured'], ['draft-call', 2, 'completed', 'measured'], ['qa-call', 1, 'pending_reconcile', 'pending']]);
    assert.deepEqual(t.attempts[1].usage, { input_tokens: 200, output_tokens: 50, cached_input_tokens: 80, reasoning_tokens: 20 });
    assert.deepEqual(t.consumption.all_attempts, { attempts: 3, measured_attempts: 2, unresolved_attempts: 1, input_tokens: 300, output_tokens: 60, cached_input_tokens: 120, reasoning_tokens: 25 }, 'retry kept; cached/reasoning are subsets; duplicates once; pending adds nothing');
    assert.deepEqual(t.consumption.completed_attempts, { attempts: 1, measured_attempts: 1, unresolved_attempts: 0, input_tokens: 200, output_tokens: 50, cached_input_tokens: 80, reasoning_tokens: 20 });
    assert.ok(t.stages.length >= 2);
    for (const body of [events.body, timeline.body]) for (const leaked of ['PLAINTEXT_MARKER_79', '482913', 'abc123secret']) assert.ok(!body.includes(leaked), 'normal views have no plaintext');

    const metrics = await read('GET', `/api/v1/admin/metrics?user_id=${f.ownerA}&project_id=${project}`);
    assert.equal(metrics.statusCode, 200, metrics.body);
    const m = metrics.json();
    assert.ok(Value.Check(schemas.AdminMetricsResponse, m));
    assert.equal(m.jobs.total, 1);
    assert.deepEqual([m.attempts.total, m.attempts.completed, m.attempts.failed, m.attempts.pending_reconcile], [3, 1, 1, 1]);
    assert.equal(m.consumption.all_attempts.input_tokens, 300);
    assert.equal(m.consumption.retry_attempts.input_tokens, 200);
    assert.deepEqual(m.by_model.find((x: any) => x.model_id === 'synthetic-model-b'), { model_id: 'synthetic-model-b', attempts: 1, completed: 0, failed: 0, input_tokens: null, output_tokens: null, cached_input_tokens: null, reasoning_tokens: null });
    assert.ok(m.operations.submitted >= 1);
    assert.ok(!metrics.body.includes('PLAINTEXT_MARKER_79'));

    // Conflicting report for the completed attempt: unresolved, contributes nothing until corrected.
    await observeUsage(pool, { owner: f.ownerA, attemptId: a2, source: 'framework', sourceEventId: 'f2-late', status: 'measured', inputTokens: 999, outputTokens: 50 });
    const conflicted = (await read('GET', `/api/v1/admin/jobs/${lease.jobId}/timeline`)).json();
    assert.equal(conflicted.attempts[1].usage_status, 'conflict');
    assert.equal(conflicted.consumption.all_attempts.input_tokens, 100);
    const health = await checkLogHealth(pool, { maxBacklogAgeSeconds: 86_400 });
    assert.ok(health.usage_conflicts >= 1);
    const providerObservation = (await pool.query("SELECT id FROM bb_usage_observations WHERE attempt_id=$1 AND source='provider'", [a2])).rows[0].id;
    const rawBefore = (await pool.query('SELECT * FROM bb_usage_observations WHERE attempt_id=$1 ORDER BY id', [a2])).rows;
    // Writes need log_operator: a read-only log_reader (and a prompt_viewer) gets the same 404.
    const validCorrection = { chosen_observation_id: providerObservation, usage_status: 'measured', reason_code: 'provider_invoice_match' };
    for (const who of [f.reader, f.viewer, f.nobody]) assert.equal((await f.as(who)('POST', `/api/v1/admin/attempts/${a2}/usage-corrections`, validCorrection)).statusCode, 404, who);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_usage_corrections WHERE attempt_id=$1', [a2])).rows[0].n, 0, 'denied write appended nothing');
    const op = f.as(f.operatorUser);
    assert.equal((await op('GET', '/api/v1/admin/logs/events')).statusCode, 404, 'log_operator alone has no read surface');
    assert.equal((await op('POST', `/api/v1/admin/attempts/${a2}/usage-corrections`, { chosen_observation_id: null, usage_status: 'measured', reason_code: 'x' })).statusCode, 422);
    assert.equal((await op('POST', `/api/v1/admin/attempts/${a2}/usage-corrections`, { chosen_observation_id: (await pool.query("SELECT id FROM bb_usage_observations WHERE attempt_id=$1", [a1])).rows[0].id, usage_status: 'measured', reason_code: 'x' })).statusCode, 409, 'observation of another attempt');
    const corrected = await op('POST', `/api/v1/admin/attempts/${a2}/usage-corrections`, validCorrection);
    assert.equal(corrected.statusCode, 201, corrected.body);
    const after = (await read('GET', `/api/v1/admin/jobs/${lease.jobId}/timeline`)).json();
    assert.equal(after.attempts[1].usage_status, 'measured');
    assert.equal(after.attempts[1].corrected, true);
    assert.equal(after.consumption.all_attempts.input_tokens, 300);
    assert.deepEqual((await pool.query('SELECT * FROM bb_usage_observations WHERE attempt_id=$1 ORDER BY id', [a2])).rows, rawBefore, 'raw rows untouched');
    await assert.rejects(pool.query('UPDATE bb_usage_observations SET input_tokens=1 WHERE id=$1', [providerObservation]), (e: any) => e.code === '23514');
    await assert.rejects(pool.query('DELETE FROM bb_usage_corrections WHERE attempt_id=$1', [a2]), (e: any) => e.code === '23514');

    // Plaintext: separate grant, audited, scrubbed, no-store.
    const viewerSend = f.as(f.viewer);
    assert.equal((await viewerSend('GET', `/api/v1/admin/prompts/${snapshot}`)).statusCode, 422, 'reason required');
    const view = await viewerSend('GET', `/api/v1/admin/prompts/${snapshot}?reason_code=support_case`);
    assert.equal(view.statusCode, 200, view.body);
    assert.ok(Value.Check(schemas.AdminPromptView, view.json()));
    assert.equal(view.headers['cache-control'], 'no-store');
    assert.ok(view.json().body.includes('PLAINTEXT_MARKER_79'));
    assert.ok(!view.json().body.includes('482913') && !view.json().body.includes('abc123secret'));
    const auditRow = await pool.query("SELECT * FROM bb_log_access_audit WHERE id=$1", [view.json().audit_id]);
    assert.deepEqual([auditRow.rows[0].actor_id, auditRow.rows[0].owner_user_id, auditRow.rows[0].purpose, auditRow.rows[0].actor_role, auditRow.rows[0].target_ref, auditRow.rows[0].reason_code], [f.viewer, f.ownerA, 'prompt_view', 'prompt_viewer', snapshot, 'support_case']);
    assert.equal((await pool.query("SELECT actor_role FROM bb_log_access_audit WHERE actor_id=$1 AND purpose='usage_correction'", [f.operatorUser])).rows[0].actor_role, 'log_operator');
    assert.ok((await pool.query("SELECT count(*)::int n FROM bb_log_access_audit WHERE actor_id=$1 AND purpose IN ('admin_events','admin_job_timeline','admin_metrics')", [f.reader])).rows[0].n >= 5, 'every operator read is audited');
    await assert.rejects(pool.query('DELETE FROM bb_log_access_audit WHERE actor_id=$1', [f.viewer]), (e: any) => e.code === '23514');

    // Revocation takes effect immediately.
    await revokeOperator(pool, f.viewer, 'prompt_viewer');
    assert.equal((await viewerSend('GET', `/api/v1/admin/prompts/${snapshot}?reason_code=support_case`)).statusCode, 404);
  } finally { await f.app.close(); await pool.end(); }
});

test('#79 forwarding drills: sink outage, process crash and replay never lose or double count', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  const f = await fixture(pool);
  try {
    const sink = new MemorySink(`drill_${uid().slice(0, 8).replace(/-/g, '')}`);
    await drain(pool, new MemorySink('drill_baseline')); // clear older suites' backlog
    const { lease } = await f.runFor(f.ownerA, 'Synthetic forwarding drill');
    const a1 = await recordPotentialCall(pool, lease, 'drill-call', 1, { modelId: 'synthetic-model-a' });
    await pool.query("UPDATE bb_model_call_attempts SET status='failed' WHERE id=$1", [a1]);
    await observeUsage(pool, { owner: f.ownerA, attemptId: a1, source: 'provider', sourceEventId: 'd1', status: 'measured', inputTokens: 7, outputTokens: 3 });
    await action(pool, f.ownerA, lease.runId, 'cancel'); // user cancel is a terminal state
    const expected = (await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_type='observability' AND delivered_at IS NULL")).rows[0].n;
    assert.ok(expected >= 5);

    // 1. Log sink outage: nothing is marked delivered, an alert is raised, business rows are intact.
    sink.down = true;
    const outage = await forwardLogs(pool, sink, { batchSize: 500, retrySeconds: 0 });
    assert.equal(outage.delivered, 0);
    assert.ok((await pool.query("SELECT 1 FROM bb_ops_alerts WHERE kind='log_sink_unavailable' AND detail->>'sink'=$1", [sink.name])).rowCount);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_type='observability' AND delivered_at IS NULL AND last_delivery_error='sink_unavailable'")).rows[0].n, expected);
    assert.equal((await pool.query("SELECT state FROM bb_jobs WHERE id=$1", [lease.jobId])).rows[0].state, 'cancelled');
    // Backlog that stays undelivered becomes a stale-backlog alert.
    await pool.query("UPDATE bb_outbox SET created_at=created_at-interval '2 hours' WHERE aggregate_type='observability' AND delivered_at IS NULL");
    const health = await checkLogHealth(pool, { maxBacklogAgeSeconds: 300 });
    assert.ok(health.backlog >= expected && health.alerts.length >= 1);
    assert.ok((await pool.query("SELECT 1 FROM bb_ops_alerts WHERE kind='log_backlog_stale'")).rowCount);

    // 2. Process crash after the sink accepted but before PostgreSQL recorded delivery.
    sink.down = false;
    await assert.rejects(forwardLogs(pool, sink, { batchSize: 500, afterSinkAccept: async () => { throw new Error('synthetic crash'); } }));
    assert.equal(sink.seen.size, expected, 'sink accepted the batch');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_log_deliveries WHERE sink=$1', [sink.name])).rows[0].n, 0);
    // Lease expiry models the crashed process; the backlog replays with the same delivery keys.
    await pool.query("UPDATE bb_outbox SET lease_until=now()-interval '1 second' WHERE aggregate_type='observability' AND delivered_at IS NULL AND lease_token IS NOT NULL");
    const replayed = await drain(pool, sink);
    assert.equal(replayed, expected);
    assert.ok(sink.calls >= 3);
    assert.equal(sink.seen.size, expected, 'replay re-sent identical keys: no double count');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_log_deliveries WHERE sink=$1', [sink.name])).rows[0].n, expected);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_type='observability' AND delivered_at IS NULL")).rows[0].n, 0);
    const kinds = [...sink.seen.values()].filter(r => r.event.job_id === lease.jobId).map(r => r.event.kind);
    for (const kind of ['model.call_started', 'model.usage_observed', 'job.state_changed']) assert.ok(kinds.includes(kind), kind);
    assert.ok([...sink.seen.values()].some(r => r.event.job_id === lease.jobId && r.event.kind === 'job.state_changed' && r.event.status === 'cancelled'), 'terminal state forwarded');
    assert.equal(await drain(pool, sink), 0, 'nothing left to replay');
    await assert.rejects(pool.query('DELETE FROM bb_log_deliveries WHERE sink=$1', [sink.name]), (e: any) => e.code === '23514');
    // Usage for the attempt is still counted exactly once after all replays.
    assert.equal((await pool.query('SELECT input_tokens FROM bb_call_usage_effective WHERE attempt_id=$1', [a1])).rows[0].input_tokens, 7);
  } finally { await f.app.close(); await pool.end(); }
});

test('#79 production file sink survives two independent processes with crash before PG ack', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  const dir = await mkdtemp(join(tmpdir(), 'bb79-replay-'));
  const f = await fixture(pool);
  try {
    await drain(pool, new MemorySink('synthetic_prior_outbox'));
    const { lease } = await f.runFor(f.ownerA, 'Synthetic file crash drill');
    for (let i = 0; i < 35; i++) await recordPotentialCall(pool, lease, `synthetic-call-${i}`, 1, { modelId: 'synthetic-model' });
    const expected = (await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_type='observability' AND delivered_at IS NULL")).rows[0].n;
    assert.ok(expected >= 35);
    const file = join(dir, 'sink.ndjson');
    const sinkName = `file_${uid().replace(/-/g, '').slice(0, 24)}`;
    const first = await forwardInProcess(file, sinkName, true);
    assert.equal(first.code, 17, first.stderr);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_log_deliveries WHERE sink=$1', [sinkName])).rows[0].n, 0);
    await pool.query("UPDATE bb_outbox SET lease_until=now()-interval '1 second' WHERE aggregate_type='observability' AND delivered_at IS NULL AND lease_token IS NOT NULL");
    const second = await forwardInProcess(file, sinkName, false);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).delivered, expected);
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, expected, 'replay added no physical lines');
    assert.equal(new Set(lines.map(line => line.delivery_key)).size, expected);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_log_deliveries WHERE sink=$1', [sinkName])).rows[0].n, expected);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_type='observability' AND delivered_at IS NULL")).rows[0].n, 0);
  } finally { await f.app.close(); await pool.end(); await rm(dir, { recursive: true, force: true }); }
});

test('#79 a missing source event blocks the whole claimed batch before sink or PG ACK', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const missingId = uid();
  const valid = internalEvent({ kind: 'error.recorded', owner: 'synthetic-missing', traceId: `synthetic-missing-${uid()}`, stage: 'synthetic_stage' });
  const sink = new MemorySink(`missing_${uid().slice(0, 8)}`);
  let validOutboxId: string | undefined;
  try {
    await transaction(pool, client => emitInternal(client, valid));
    validOutboxId = (await pool.query('SELECT id FROM bb_outbox WHERE aggregate_id=$1', [valid.event_id])).rows[0].id;
    await pool.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload,created_at)
      VALUES($1,'synthetic-missing','observability',$2,'error.recorded','{}',now()-interval '1 day')`, [missingId, uid()]);
    await pool.query("UPDATE bb_outbox SET created_at=now()-interval '2 days' WHERE id=$1", [validOutboxId]);
    const result = await forwardLogs(pool, sink, { batchSize: 2, retrySeconds: 0 });
    assert.deepEqual(result, { claimed: 2, delivered: 0, failed: 2 });
    assert.equal(sink.calls, 0);
    const rows = (await pool.query('SELECT id,delivered_at,last_delivery_error,lease_token FROM bb_outbox WHERE id=ANY($1) ORDER BY id', [[validOutboxId, missingId]])).rows;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.delivered_at, null);
      assert.equal(row.last_delivery_error, 'evidence_missing');
      assert.equal(row.lease_token, null);
    }
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_log_deliveries WHERE outbox_id=ANY($1)', [[validOutboxId, missingId]])).rows[0].n, 0);
    assert.equal((await gateState(pool)).state, 'paused');
    assert.ok((await pool.query("SELECT 1 FROM bb_ops_alerts WHERE kind='evidence_persist_failed' AND detail->>'reason_code'='log_event_missing'")).rowCount);
  } finally {
    await pool.query('DELETE FROM bb_outbox WHERE id=ANY($1)', [[validOutboxId, missingId].filter(Boolean)]);
    if ((await gateState(pool)).state === 'paused') await pool.query("INSERT INTO bb_evidence_gate_events(id,state,reason_code,actor_type) VALUES($1,'open','synthetic_test_reset','system')", [uid()]);
    resetProcessGateForTests();
    await pool.end();
  }
});

test('#79 malformed outbox envelope or source event blocks the entire PG batch', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const owner = `synthetic-contract-${uid().slice(0, 8)}`;
  const cases: Array<{ name: string; payload?: (id: string) => unknown; source?: (event: ReturnType<typeof internalEvent>) => unknown; mixed: boolean }> = [
    { name: 'unknown payload schema version', payload: id => ({ event_id: id, schema_version: 2 }), mixed: false },
    { name: 'mixed valid and wrong-version payload', payload: id => ({ event_id: id, schema_version: 2 }), mixed: true },
    { name: 'missing payload field', payload: id => ({ event_id: id }), mixed: false },
    { name: 'extra payload field', payload: id => ({ event_id: id, schema_version: 1, untrusted: true }), mixed: false },
    { name: 'wrong payload value', payload: id => ({ event_id: `${id}-wrong`, schema_version: 1 }), mixed: false },
    { name: 'invalid source schema version', source: event => ({ ...event, schema_version: 2 }), mixed: false },
    { name: 'extra source field', source: event => ({ ...event, untrusted: true }), mixed: false },
    { name: 'missing source field', source: event => { const { occurred_at: _removed, ...rest } = event; return rest; }, mixed: false }
  ];
  try {
    for (const variant of cases) {
      const sink = new MemorySink(`contract_${uid().slice(0, 8)}`);
      const bad = internalEvent({ kind: 'error.recorded', owner, traceId: uid(), stage: 'synthetic_stage' });
      const good = variant.mixed ? internalEvent({ kind: 'error.recorded', owner, traceId: uid(), stage: 'synthetic_stage' }) : null;
      const outboxIds = [uid(), ...(good ? [uid()] : [])];
      await pool.query(`INSERT INTO bb_observability_events(id,owner_user_id,trace_id,kind,event)
        VALUES($1,$2,$3,$4,$5)`, [bad.event_id, owner, bad.trace_id, bad.kind, variant.source?.(bad) ?? bad]);
      if (good) await pool.query(`INSERT INTO bb_observability_events(id,owner_user_id,trace_id,kind,event)
        VALUES($1,$2,$3,$4,$5)`, [good.event_id, owner, good.trace_id, good.kind, good]);
      await pool.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload,created_at)
        VALUES($1,$2,'observability',$3,$4,$5,now()-interval '3 days')`,
        [outboxIds[0], owner, bad.event_id, bad.kind, variant.payload?.(bad.event_id) ?? { event_id: bad.event_id, schema_version: 1 }]);
      if (good) await pool.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload,created_at)
        VALUES($1,$2,'observability',$3,$4,$5,now()-interval '2 days')`,
        [outboxIds[1], owner, good.event_id, good.kind, { event_id: good.event_id, schema_version: 1 }]);
      try {
        assert.deepEqual(await forwardLogs(pool, sink, { batchSize: outboxIds.length, retrySeconds: 0 }),
          { claimed: outboxIds.length, delivered: 0, failed: outboxIds.length }, variant.name);
        assert.equal(sink.calls, 0, variant.name);
        const rows = (await pool.query('SELECT delivered_at,last_delivery_error,lease_token FROM bb_outbox WHERE id=ANY($1)', [outboxIds])).rows;
        assert.equal(rows.length, outboxIds.length, variant.name);
        for (const row of rows) {
          assert.equal(row.delivered_at, null, variant.name);
          assert.equal(row.last_delivery_error, 'evidence_missing', variant.name);
          assert.equal(row.lease_token, null, variant.name);
        }
        assert.equal((await pool.query('SELECT count(*)::int n FROM bb_log_deliveries WHERE outbox_id=ANY($1)', [outboxIds])).rows[0].n, 0, variant.name);
        assert.equal((await gateState(pool)).state, 'paused', variant.name);
        assert.ok((await pool.query("SELECT 1 FROM bb_ops_alerts WHERE kind='evidence_persist_failed' AND detail->>'reason_code'='log_event_missing'")).rowCount, variant.name);
      } finally {
        await pool.query('DELETE FROM bb_outbox WHERE id=ANY($1)', [outboxIds]);
        if ((await gateState(pool)).state === 'paused') await pool.query("INSERT INTO bb_evidence_gate_events(id,state,reason_code,actor_type) VALUES($1,'open','synthetic_test_reset','system')", [uid()]);
        resetProcessGateForTests();
      }
    }
  } finally { await pool.end(); }
});

test('#79 a conflicting existing receipt cannot ACK a different outbox event', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const sink = new MemorySink(`conflict_${uid().slice(0, 8)}`);
  try {
    const original = internalEvent({ kind: 'error.recorded', owner: 'synthetic-conflict', traceId: `synthetic-original-${uid()}`, stage: 'synthetic_stage' });
    const other = internalEvent({ kind: 'error.recorded', owner: 'synthetic-conflict', traceId: `synthetic-other-${uid()}`, stage: 'synthetic_stage' });
    await transaction(pool, async client => { await emitInternal(client, original); await emitInternal(client, other); });
    const originalId = (await pool.query('SELECT id FROM bb_outbox WHERE aggregate_id=$1', [original.event_id])).rows[0].id;
    const otherId = (await pool.query('SELECT id FROM bb_outbox WHERE aggregate_id=$1', [other.event_id])).rows[0].id;
    const key = digest(`${sink.name}:${originalId}`);
    await pool.query('INSERT INTO bb_log_deliveries(outbox_id,sink,delivery_key,attempts) VALUES($1,$2,$3,1)', [otherId, sink.name, key]);
    await pool.query("UPDATE bb_outbox SET created_at=now()-interval '2 days' WHERE id=$1", [originalId]);
    await assert.rejects(forwardLogs(pool, sink, { batchSize: 1 }), /Inconsistent log delivery receipt/);
    assert.equal(sink.calls, 1, 'sink acceptance precedes PG receipt validation');
    assert.equal((await pool.query('SELECT delivered_at FROM bb_outbox WHERE id=$1', [originalId])).rows[0].delivered_at, null);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_log_deliveries WHERE outbox_id=$1', [originalId])).rows[0].n, 0);
    assert.equal((await gateState(pool)).state, 'paused');
  } finally {
    if ((await gateState(pool)).state === 'paused') await pool.query("INSERT INTO bb_evidence_gate_events(id,state,reason_code,actor_type) VALUES($1,'open','synthetic_test_reset','system')", [uid()]);
    resetProcessGateForTests();
    await pool.end();
  }
});

test('#79 PG event lookup outage cannot call the sink or acknowledge the outbox', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const sink = new MemorySink(`lookup_${uid().slice(0, 8)}`);
  const event = internalEvent({ kind: 'error.recorded', owner: 'synthetic-lookup', traceId: `synthetic-lookup-${uid()}`, stage: 'synthetic_stage' });
  let outboxId: string | undefined;
  try {
    await transaction(pool, client => emitInternal(client, event));
    outboxId = (await pool.query('SELECT id FROM bb_outbox WHERE aggregate_id=$1', [event.event_id])).rows[0].id;
    await pool.query("UPDATE bb_outbox SET created_at=now()-interval '3 days' WHERE id=$1", [outboxId]);
    const failedLookup = new Proxy(pool, { get(target, key) {
      if (key === 'query') return (sql: string, ...args: unknown[]) => sql.startsWith('SELECT id,owner_user_id,kind,event FROM bb_observability_events')
        ? Promise.reject(Object.assign(new Error('synthetic PG lookup outage'), { code: '08006' })) : (target.query as (...values: unknown[]) => unknown)(sql, ...args);
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as Pool;
    await assert.rejects(forwardLogs(failedLookup, sink, { batchSize: 1 }), (error: any) => error.code === '08006');
    assert.equal(sink.calls, 0);
    assert.equal((await pool.query('SELECT delivered_at FROM bb_outbox WHERE id=$1', [outboxId])).rows[0].delivered_at, null);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_log_deliveries WHERE outbox_id=$1', [outboxId])).rows[0].n, 0);
    assert.equal((await gateState(pool)).state, 'paused');
  } finally {
    if (outboxId) await pool.query('DELETE FROM bb_outbox WHERE id=$1', [outboxId]);
    if ((await gateState(pool)).state === 'paused') await pool.query("INSERT INTO bb_evidence_gate_events(id,state,reason_code,actor_type) VALUES($1,'open','synthetic_test_reset','system')", [uid()]);
    resetProcessGateForTests();
    await pool.end();
  }
});

test('#79 evidence gate: DB transaction failure pauses new external calls and raises an alert', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  const f = await fixture(pool);
  try {
    resetProcessGateForTests();
    const { lease } = await f.runFor(f.ownerA, 'Synthetic gate drill');
    // Fault injection: the intent INSERT fails like a lost connection inside the transaction.
    const faulty = new Proxy(pool, { get(target, key) {
      if (key !== 'connect') return Reflect.get(target, key).bind?.(target) ?? Reflect.get(target, key);
      return async () => { const client = await target.connect(); return new Proxy(client, { get(c, k) {
        if (k !== 'query') { const v = Reflect.get(c, k); return typeof v === 'function' ? v.bind(c) : v; }
        return (sql: any, ...rest: any[]) => typeof sql === 'string' && sql.startsWith('INSERT INTO bb_model_call_attempts') ? Promise.reject(Object.assign(new Error('synthetic connection loss'), { code: '08006' })) : (c.query as any)(sql, ...rest);
      } }); };
    } }) as Pool;
    await assert.rejects(recordPotentialCall(faulty, lease, 'gate-call', 1), (e: any) => e.code === '08006');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1', [lease.jobId])).rows[0].n, 0, 'rolled back, nothing half-written');
    assert.equal((await gateState(pool)).state, 'paused');
    const pause = (await pool.query("SELECT g.reason_code FROM bb_ops_alerts a JOIN bb_evidence_gate_events g ON g.alert_id=a.id WHERE a.kind='evidence_persist_failed' ORDER BY g.seq DESC LIMIT 1")).rows[0];
    assert.equal(pause.reason_code, 'call_intent_not_persisted');
    // Every process now refuses new calls, even with a healthy connection.
    await assert.rejects(recordPotentialCall(pool, lease, 'gate-call', 1), (e: any) => e.status === 503 && e.code === 'DATA_UNAVAILABLE');
    const gate = await f.as(f.reader)('GET', '/api/v1/admin/evidence-gate');
    assert.equal(gate.json().state, 'paused');
    for (const who of [f.reader, f.viewer]) assert.equal((await f.as(who)('POST', '/api/v1/admin/evidence-gate/resume', { reason_code: 'db_recovered' })).statusCode, 404, who);
    assert.equal((await gateState(pool)).state, 'paused', 'denied resume changed nothing');
    const resumed = await f.as(f.operatorUser)('POST', '/api/v1/admin/evidence-gate/resume', { reason_code: 'db_recovered' });
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(resumed.json().state, 'open');
    assert.equal((await f.as(f.operatorUser)('POST', '/api/v1/admin/evidence-gate/resume', { reason_code: 'db_recovered' })).statusCode, 409);
    const attempt = await recordPotentialCall(pool, lease, 'gate-call', 1);
    assert.ok(attempt);
    // A logical conflict (wrong attempt number) is not an evidence outage.
    await assert.rejects(recordPotentialCall(pool, lease, 'gate-call', 5), (e: any) => e.status === 409);
    assert.equal((await gateState(pool)).state, 'open');

    // Database fully unreachable: the pause is held in-process, then persisted once reachable.
    const dead = new Pool({ connectionString: 'postgresql://nobody@127.0.0.1:1/none', connectionTimeoutMillis: 500 });
    await tripEvidenceGate(dead, 'usage_not_persisted');
    await dead.end();
    assert.equal((await gateState(pool)).process_state, 'paused');
    await assert.rejects(recordPotentialCall(pool, lease, 'gate-call', 2), (e: any) => e.status === 503);
    assert.equal((await gateState(pool)).state, 'paused', 'held pause was persisted for other processes');
    assert.equal((await gateState(pool)).process_state, 'open');
    await f.as(f.operatorUser)('POST', '/api/v1/admin/evidence-gate/resume', { reason_code: 'db_recovered' });
    assert.ok(await recordPotentialCall(pool, lease, 'gate-call', 2));
    await assert.rejects(pool.query('DELETE FROM bb_evidence_gate_events'), (e: any) => e.code === '23514');
    const alerts = await f.as(f.reader)('GET', '/api/v1/admin/alerts');
    assert.ok(Value.Check(schemas.AdminAlertsResponse, alerts.json()));
    assert.ok(alerts.json().items.some((a: any) => a.kind === 'evidence_persist_failed'));
  } finally { resetProcessGateForTests(); await f.app.close(); await pool.end(); }
});

test('#79 retention purge and user-deletion reclamation keep accounting metadata', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  const f = await fixture(pool);
  const blobs = azureBlobs(blobConnection!);
  try {
    const active = await f.runFor(f.ownerA, 'Synthetic retention active');
    const runBound = await savePromptSnapshot(pool, blobs, { owner: f.ownerA, projectId: active.project, runId: active.runId, kind: 'user_prompt', version: 1, body: 'run-bound synthetic prompt' });
    const runless = await savePromptSnapshot(pool, blobs, { owner: f.ownerA, projectId: active.project, kind: 'structured_input', version: 1, body: 'run-less synthetic prompt' });
    const attempt = await recordPotentialCall(pool, active.lease, 'retained-call', 1, { modelId: 'synthetic-model-a', promptSnapshotId: runBound });
    await observeUsage(pool, { owner: f.ownerA, attemptId: attempt, source: 'provider', sourceEventId: 'r1', status: 'measured', inputTokens: 11, outputTokens: 2 });
    const closedProject = (await f.as(f.ownerB)('POST', '/api/v1/projects', { name: 'Synthetic closing owner', kind: 'update', issuer_name: null, market: null, offering: null })).json().project_id;
    const closedSnapshot = await savePromptSnapshot(pool, blobs, { owner: f.ownerB, projectId: closedProject, kind: 'user_prompt', version: 1, body: 'closed owner synthetic prompt' });
    const scope = [f.ownerA, f.ownerB];

    // Nothing is due yet; only the closed account's content is reclaimed after closure.
    assert.equal((await purgeLogContent(pool, blobs, { contentRetentionDays: 30, ownerScope: scope })).due, 0);
    await pool.query("UPDATE bb_users SET status='closed',closed_at=now() WHERE id=$1", [f.ownerB]);
    const closure = await purgeLogContent(pool, blobs, { contentRetentionDays: 30, ownerScope: scope });
    assert.deepEqual([closure.due, closure.purged], [1, 1]);
    const closedKey = (await pool.query('SELECT object_key FROM bb_snapshot_refs WHERE id=$1', [closedSnapshot])).rows[0].object_key;
    assert.equal(await blobs.exists(closedKey), false);
    assert.equal((await pool.query('SELECT reason FROM bb_log_content_tombstones WHERE content_id=$1', [closedSnapshot])).rows[0].reason, 'user_deleted');

    // Past retention: run-less content is purged; content of a non-terminal run is kept.
    const later = () => new Date(Date.now() + 31 * 86_400_000);
    const crashKey = (await pool.query('SELECT object_key FROM bb_snapshot_refs WHERE id=$1', [runless])).rows[0].object_key;
    await blobs.delete(crashKey); // models a crash after Blob delete, before the tombstone commit
    const expired = await purgeLogContent(pool, blobs, { contentRetentionDays: 30, now: later, ownerScope: scope });
    assert.deepEqual([expired.due, expired.purged], [1, 1]);
    assert.equal((await pool.query('SELECT reason FROM bb_log_content_tombstones WHERE content_id=$1', [runless])).rows[0].reason, 'retention_expired');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_log_content_tombstones WHERE content_id=$1', [runBound])).rows[0].n, 0, 'active run content kept');
    await action(pool, f.ownerA, active.runId, 'cancel');
    const terminal = await purgeLogContent(pool, blobs, { contentRetentionDays: 30, now: later, ownerScope: scope });
    assert.deepEqual([terminal.due, terminal.purged], [1, 1]);
    assert.equal((await purgeLogContent(pool, blobs, { contentRetentionDays: 30, now: later, ownerScope: scope })).due, 0, 'idempotent replay');

    // Metadata needed for accounting survives; content refs read as purged; plaintext is gone.
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_snapshot_refs WHERE id=ANY($1)', [[runBound, runless, closedSnapshot]])).rows[0].n, 3);
    assert.equal((await pool.query('SELECT input_tokens FROM bb_call_usage_effective WHERE attempt_id=$1', [attempt])).rows[0].input_tokens, 11);
    await grantOperator(pool, { userId: f.viewer, role: 'log_reader', grantedBy: 'synthetic-setup', reasonCode: 'synthetic_test' });
    const timeline = (await f.as(f.viewer)('GET', `/api/v1/admin/jobs/${active.lease.jobId}/timeline`)).json();
    assert.equal(timeline.prompts.find((p: any) => p.snapshot_id === runBound).content_state, 'purged');
    assert.equal(timeline.attempts[0].usage.input_tokens, 11);
    assert.equal((await f.as(f.viewer)('GET', `/api/v1/admin/prompts/${runBound}?reason_code=support_case`)).statusCode, 404);
    assert.ok((await pool.query("SELECT 1 FROM bb_observability_events WHERE kind='log.content_purged' AND owner_user_id=$1", [f.ownerB])).rowCount);
    await assert.rejects(pool.query('DELETE FROM bb_log_content_tombstones WHERE content_id=$1', [runless]), (e: any) => e.code === '23514');
  } finally { await f.app.close(); await pool.end(); }
});

test('#79 prompt response and purge serialize through delivery, with audit and owner boundary', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  const f = await fixture(pool);
  const blobs = azureBlobs(blobConnection!);
  let releaseSend!: () => void;
  const sendGate = new Promise<void>(resolve => { releaseSend = resolve; });
  let enteredSend!: () => void;
  const inSend = new Promise<void>(resolve => { enteredSend = resolve; });
  let url = '';
  try {
    f.app.addHook('onSend', async (request, reply, payload) => {
      if (request.url === url && reply.statusCode === 200) { enteredSend(); await sendGate; }
      return payload;
    });
    const project = (await f.as(f.ownerB)('POST', '/api/v1/projects', { name: 'Synthetic purge race', kind: 'update', issuer_name: null, market: null, offering: null })).json().project_id;
    const snapshot = await savePromptSnapshot(pool, blobs, { owner: f.ownerB, projectId: project, kind: 'user_prompt', version: 1, body: 'synthetic prompt RACE_MARKER_79' });
    url = `/api/v1/admin/prompts/${snapshot}?reason_code=support_case`;
    assert.equal((await f.as(f.ownerA)('GET', url)).statusCode, 404, 'ordinary user cannot view another account');
    const response = f.as(f.viewer)('GET', url);
    await inSend; // Blob bytes have been read, but HTTP has not sent them.
    await pool.query("UPDATE bb_users SET status='closed',closed_at=now() WHERE id=$1", [f.ownerB]);
    let finished = false;
    const purge = purgeLogContent(pool, blobs, { contentRetentionDays: 30, ownerScope: [f.ownerB] }).then(result => { finished = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(finished, false, 'purge must wait for the unsent response');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_log_content_tombstones WHERE content_id=$1', [snapshot])).rows[0].n, 0);
    releaseSend();
    const sent = await response;
    assert.equal(sent.statusCode, 200, sent.body);
    assert.ok(sent.json().body.includes('RACE_MARKER_79'));
    assert.deepEqual([ (await purge).purged, finished ], [1, true]);
    assert.equal((await f.as(f.viewer)('GET', url)).statusCode, 404, 'after completed purge no body is returned');
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_log_access_audit WHERE actor_id=$1 AND target_ref=$2 AND purpose='prompt_view'", [f.viewer, snapshot])).rows[0].n, 2, 'successful and denied reads are audited');
  } finally { releaseSend(); await f.app.close(); await pool.end(); }
});

test('#79 in-flight Blob purge blocks prompt read and failed delete remains replayable', { skip }, async () => {
  const pool = new Pool({ connectionString: connection });
  const f = await fixture(pool);
  const blobs = azureBlobs(blobConnection!);
  let allowDelete!: () => void;
  const deleteGate = new Promise<void>(resolve => { allowDelete = resolve; });
  let enteredDelete!: () => void;
  const inDelete = new Promise<void>(resolve => { enteredDelete = resolve; });
  try {
    const project = (await f.as(f.ownerA)('POST', '/api/v1/projects', { name: 'Synthetic expiry race', kind: 'update', issuer_name: null, market: null, offering: null })).json().project_id;
    const snapshot = await savePromptSnapshot(pool, blobs, { owner: f.ownerA, projectId: project, kind: 'user_prompt', version: 1, body: 'synthetic prompt PURGE_FIRST_79' });
    const key = (await pool.query('SELECT object_key FROM bb_snapshot_refs WHERE id=$1', [snapshot])).rows[0].object_key;
    const later = () => new Date(Date.now() + 31 * 86_400_000);
    const failingBlobs = { ...blobs, delete: async (_key: string) => { throw new Error('synthetic Blob outage'); } };
    const failed = await purgeLogContent(pool, failingBlobs, { contentRetentionDays: 30, now: later, ownerScope: [f.ownerA] });
    assert.deepEqual([failed.purged, failed.failed], [0, 1]);
    assert.equal(await blobs.exists(key), true);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_log_content_tombstones WHERE content_id=$1', [snapshot])).rows[0].n, 0);
    const pausedBlobs = { ...blobs, delete: async (objectKey: string) => { enteredDelete(); await deleteGate; await blobs.delete(objectKey); } };
    const purge = purgeLogContent(pool, pausedBlobs, { contentRetentionDays: 30, now: later, ownerScope: [f.ownerA] });
    await inDelete;
    let delivered = false;
    const response = f.as(f.viewer)('GET', `/api/v1/admin/prompts/${snapshot}?reason_code=support_case`).then(result => { delivered = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(delivered, false, 'read waits while purge holds the object lock');
    allowDelete();
    assert.equal((await purge).purged, 1);
    assert.equal((await response).statusCode, 404);
    assert.equal(await blobs.exists(key), false);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_log_access_audit WHERE actor_id=$1 AND target_ref=$2 AND purpose='prompt_view'", [f.viewer, snapshot])).rows[0].n, 1);
  } finally { allowDelete(); await f.app.close(); await pool.end(); }
});

for (const late of ['resolve', 'reject'] as const) test(`#79 TCP abort releases prompt lock during pending Blob read (${late} late)`, { skip }, async () => {
  const pool = new Pool({ connectionString: connection, max: 2 });
  const f = await fixture(pool);
  const realBlobs = azureBlobs(blobConnection!);
  const entered = deferred<void>();
  const held = deferred<Buffer | null>();
  let app: ReturnType<typeof createServer> | undefined;
  try {
    const project = (await f.as(f.ownerA)('POST', '/api/v1/projects', { name: 'Synthetic TCP abort', kind: 'update', issuer_name: null, market: null, offering: null })).json().project_id;
    const snapshot = await savePromptSnapshot(pool, realBlobs, { owner: f.ownerA, projectId: project, kind: 'user_prompt', version: 1, body: 'synthetic TCP_ABORT_MARKER_79' });
    const key = (await pool.query('SELECT object_key FROM bb_snapshot_refs WHERE id=$1', [snapshot])).rows[0].object_key;
    const original = await realBlobs.getIfExistsBounded(key, 10 * 1024 * 1024);
    const blobs = { ...realBlobs, getIfExistsBounded: async () => { entered.resolve(); return held.promise; } };
    app = createServer({ pool, blobs, principal: async () => ({ userId: f.viewer, csrfVerified: true }), allowedOrigin: ORIGIN });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const path = `/api/v1/admin/prompts/${snapshot}?reason_code=support_case`;
    const socket = await rawGetSocket(address, path);
    await entered.promise; // The audit committed, and the Blob read is still pending.
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_log_access_audit WHERE actor_id=$1 AND target_ref=$2 AND purpose='prompt_view'", [f.viewer, snapshot])).rows[0].n, 1);
    await pool.query("UPDATE bb_users SET status='closed',closed_at=now() WHERE id=$1", [f.ownerA]);
    let purged = false;
    const purge = purgeLogContent(pool, realBlobs, { contentRetentionDays: 30, ownerScope: [f.ownerA] }).then(value => { purged = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(purged, false, 'live read still owns the lock');
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
    socket.destroy();
    await closed;
    const result = await Promise.race([purge, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('purge waited for a disconnected Blob read')), 1500))]);
    assert.equal(result.purged, 1, 'purge completes before the held Blob promise settles');
    assert.equal(await realBlobs.exists(key), false);
    assert.equal((await pool.query('SELECT 1')).rowCount, 1, 'pool remains usable after the abort');
    assert.equal(pool.idleCount, pool.totalCount, 'all PG connections returned while Blob remains pending');
    if (late === 'resolve') held.resolve(original);
    else held.reject(new Error('synthetic late Blob failure'));
    await new Promise(resolve => setTimeout(resolve, 20));
    const after = await fetch(`${address}${path}`);
    assert.equal(after.status, 404);
    assert.ok(!(await after.text()).includes('TCP_ABORT_MARKER_79'));
  } finally { held.resolve(null); await app?.close(); await f.app.close(); await pool.end(); }
});

test('#79 real TCP slow response and onSend failure release the prompt lock', { skip }, async () => {
  const pool = new Pool({ connectionString: connection, max: 2 });
  const f = await fixture(pool);
  const blobs = azureBlobs(blobConnection!);
  let app: ReturnType<typeof createServer> | undefined;
  const sendEntered = deferred<void>(), sendGate = deferred<void>();
  try {
    const project = (await f.as(f.ownerB)('POST', '/api/v1/projects', { name: 'Synthetic slow TCP', kind: 'update', issuer_name: null, market: null, offering: null })).json().project_id;
    const slow = await savePromptSnapshot(pool, blobs, { owner: f.ownerB, projectId: project, kind: 'user_prompt', version: 1, body: 'synthetic SLOW_TCP_MARKER_79' });
    const errorProject = (await f.as(f.ownerA)('POST', '/api/v1/projects', { name: 'Synthetic onSend error', kind: 'update', issuer_name: null, market: null, offering: null })).json().project_id;
    const failedSnapshot = await savePromptSnapshot(pool, blobs, { owner: f.ownerA, projectId: errorProject, kind: 'user_prompt', version: 1, body: 'synthetic ONSEND_MARKER_79' });
    app = createServer({ pool, blobs, principal: async () => ({ userId: f.viewer, csrfVerified: true }), allowedOrigin: ORIGIN });
    app.addHook('onSend', async (request, reply, payload) => {
      if (reply.statusCode === 200 && request.url.includes(slow)) { sendEntered.resolve(); await sendGate.promise; }
      if (reply.statusCode === 200 && request.url.includes(failedSnapshot)) throw new Error('synthetic onSend failure');
      return payload;
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const slowPath = `/api/v1/admin/prompts/${slow}?reason_code=support_case`;
    const response = fetch(`${address}${slowPath}`);
    await sendEntered.promise;
    await pool.query("UPDATE bb_users SET status='closed',closed_at=now() WHERE id=$1", [f.ownerB]);
    let finished = false;
    const purge = purgeLogContent(pool, blobs, { contentRetentionDays: 30, ownerScope: [f.ownerB] }).then(value => { finished = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(finished, false, 'purge cannot finish before the slow TCP response');
    sendGate.resolve();
    const sent = await response;
    assert.equal(sent.status, 200);
    assert.ok((await sent.text()).includes('SLOW_TCP_MARKER_79'));
    assert.equal((await purge).purged, 1);
    assert.equal((await fetch(`${address}${slowPath}`)).status, 404);

    // A separate active snapshot exercises Fastify's failed onSend path over TCP.
    const failedUrl = `${address}/api/v1/admin/prompts/${failedSnapshot}?reason_code=support_case`;
    const failed = await fetch(failedUrl);
    assert.equal(failed.status, 500);
    assert.ok(!(await failed.text()).includes('ONSEND_MARKER_79'));
    await pool.query("UPDATE bb_users SET status='closed',closed_at=now() WHERE id=$1", [f.ownerA]);
    assert.equal((await purgeLogContent(pool, blobs, { contentRetentionDays: 30, ownerScope: [f.ownerA] })).purged, 1);
    assert.equal(pool.idleCount, pool.totalCount, 'onSend error returned every PG connection');
  } finally { sendGate.resolve(); await app?.close(); await f.app.close(); await pool.end(); }
});

for (const firstOutcome of ['success', 'failure'] as const) test(`#79 disconnected lock waiter frees a two-connection PG pool (${firstOutcome} first read)`, { skip }, async () => {
  const pool = new Pool({ connectionString: connection, max: 2 });
  const f = await fixture(pool);
  const realBlobs = azureBlobs(blobConnection!);
  const firstRead = deferred<Buffer | null>(), readEntered = deferred<void>(), secondEntered = deferred<void>();
  let app: ReturnType<typeof createServer> | undefined;
  let first: ReturnType<typeof connect> | undefined, second: ReturnType<typeof connect> | undefined;
  try {
    const project = (await f.as(f.ownerA)('POST', '/api/v1/projects', { name: 'Synthetic two-socket lock', kind: 'update', issuer_name: null, market: null, offering: null })).json().project_id;
    const snapshot = await savePromptSnapshot(pool, realBlobs, { owner: f.ownerA, projectId: project, kind: 'user_prompt', version: 1, body: 'synthetic TWO_SOCKET_MARKER_79' });
    const key = (await pool.query('SELECT object_key FROM bb_snapshot_refs WHERE id=$1', [snapshot])).rows[0].object_key;
    const original = await realBlobs.getIfExistsBounded(key, 10 * 1024 * 1024);
    let reads = 0, requests = 0;
    const blobs = { ...realBlobs, getIfExistsBounded: async (objectKey: string, limit: number) => {
      if (objectKey === key && ++reads === 1) { readEntered.resolve(); return firstRead.promise; }
      return realBlobs.getIfExistsBounded(objectKey, limit);
    } };
    app = createServer({ pool, blobs, principal: async () => ({ userId: f.viewer, csrfVerified: true }), allowedOrigin: ORIGIN });
    const path = `/api/v1/admin/prompts/${snapshot}?reason_code=support_case`;
    app.addHook('onRequest', async request => { if (request.url === path && ++requests === 2) secondEntered.resolve(); });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    first = await rawGetSocket(address, path);
    let firstResponse = '';
    first.on('data', chunk => { firstResponse += chunk.toString(); });
    await readEntered.promise; // First socket owns the advisory lock and holds Blob I/O.
    second = await rawGetSocket(address, path);
    await secondEntered.promise;
    await new Promise(resolve => setTimeout(resolve, 100));
    const secondClosed = new Promise<void>(resolve => second!.once('close', () => resolve()));
    second.destroy();
    await secondClosed;
    const probe = await Promise.race([pool.query('SELECT 1'), new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('disconnected lock waiter exhausted the PG pool')), 1500))]);
    assert.equal(probe.rowCount, 1);
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.totalCount - pool.idleCount, 1, 'only the first live reader retains a connection');
    await pool.query("UPDATE bb_users SET status='closed',closed_at=now() WHERE id=$1", [f.ownerA]);
    let finished = false;
    const purge = purgeLogContent(pool, realBlobs, { contentRetentionDays: 30, ownerScope: [f.ownerA] }).then(value => { finished = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(finished, false, 'purge waits for the live first response');
    const firstClosed = new Promise<void>(resolve => first!.once('close', () => resolve()));
    if (firstOutcome === 'success') firstRead.resolve(original);
    else firstRead.reject(new Error('synthetic first Blob failure'));
    await firstClosed;
    assert.equal(firstResponse.includes('TWO_SOCKET_MARKER_79'), firstOutcome === 'success');
    assert.equal((await purge).purged, 1);
    const after = await fetch(`${address}${path}`);
    assert.equal(after.status, 404);
    assert.ok(!(await after.text()).includes('TWO_SOCKET_MARKER_79'));
    assert.equal(pool.idleCount, pool.totalCount);
  } finally {
    firstRead.resolve(null);
    first?.destroy(); second?.destroy();
    await app?.close(); await f.app.close(); await pool.end();
  }
});

test('#79 prompt deadline ends a live TCP Blob read and permits purge', { skip }, async () => {
  const pool = new Pool({ connectionString: connection, max: 2 });
  const f = await fixture(pool);
  const realBlobs = azureBlobs(blobConnection!);
  const entered = deferred<void>(), held = deferred<Buffer | null>();
  let app: ReturnType<typeof createServer> | undefined, socket: ReturnType<typeof connect> | undefined;
  try {
    const project = (await f.as(f.ownerA)('POST', '/api/v1/projects', { name: 'Synthetic deadline Blob', kind: 'update', issuer_name: null, market: null, offering: null })).json().project_id;
    const snapshot = await savePromptSnapshot(pool, realBlobs, { owner: f.ownerA, projectId: project, kind: 'user_prompt', version: 1, body: 'synthetic DEADLINE_BLOB_MARKER_79' });
    const key = (await pool.query('SELECT object_key FROM bb_snapshot_refs WHERE id=$1', [snapshot])).rows[0].object_key;
    const original = await realBlobs.getIfExistsBounded(key, 10 * 1024 * 1024);
    const blobs = { ...realBlobs, getIfExistsBounded: async () => { entered.resolve(); return held.promise; } };
    app = createServer({ pool, blobs, promptViewDeadlineMs: 180, principal: async () => ({ userId: f.viewer, csrfVerified: true }), allowedOrigin: ORIGIN });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const path = `/api/v1/admin/prompts/${snapshot}?reason_code=support_case`;
    socket = await rawGetSocket(address, path);
    let received = '';
    socket.on('data', chunk => { received += chunk.toString(); });
    await entered.promise;
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_log_access_audit WHERE target_ref=$1 AND purpose='prompt_view'", [snapshot])).rows[0].n, 1);
    await pool.query("UPDATE bb_users SET status='closed',closed_at=now() WHERE id=$1", [f.ownerA]);
    const result = await Promise.race([purgeLogContent(pool, realBlobs, { contentRetentionDays: 30, ownerScope: [f.ownerA] }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('deadline failed to release pending Blob lock')), 1500))]);
    assert.equal(result.purged, 1);
    assert.ok(!received.includes('DEADLINE_BLOB_MARKER_79'));
    assert.equal(pool.idleCount, pool.totalCount);
    held.resolve(original); // A late Blob result must not send plaintext.
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await fetch(`${address}${path}`)).status, 404);
  } finally { held.resolve(null); socket?.destroy(); await app?.close(); await f.app.close(); await pool.end(); }
});

test('#79 prompt deadline stops a connected lock waiter without retaining its PG connection', { skip }, async () => {
  const pool = new Pool({ connectionString: connection, max: 2 });
  const f = await fixture(pool);
  const blobs = azureBlobs(blobConnection!);
  let app: ReturnType<typeof createServer> | undefined, socket: ReturnType<typeof connect> | undefined;
  const holder = await pool.connect();
  let holderReleased = false;
  try {
    const project = (await f.as(f.ownerA)('POST', '/api/v1/projects', { name: 'Synthetic deadline waiter', kind: 'update', issuer_name: null, market: null, offering: null })).json().project_id;
    const snapshot = await savePromptSnapshot(pool, blobs, { owner: f.ownerA, projectId: project, kind: 'user_prompt', version: 1, body: 'synthetic DEADLINE_WAIT_MARKER_79' });
    await holder.query("SELECT pg_advisory_lock(hashtext('prompt_snapshot'),hashtext($1::text))", [snapshot]);
    app = createServer({ pool, blobs, promptViewDeadlineMs: 180, principal: async () => ({ userId: f.viewer, csrfVerified: true }), allowedOrigin: ORIGIN });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const path = `/api/v1/admin/prompts/${snapshot}?reason_code=support_case`;
    socket = await rawGetSocket(address, path);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(pool.totalCount - pool.idleCount, 1, 'only the external holder uses a connection');
    assert.equal(pool.waitingCount, 0);
    assert.equal((await pool.query('SELECT 1')).rowCount, 1);
    assert.equal((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout, '0', 'deadline setting must not leak into unrelated pool work');
    await holder.query("SELECT pg_advisory_unlock(hashtext('prompt_snapshot'),hashtext($1::text))", [snapshot]);
    holder.release();
    holderReleased = true;
    await pool.query("UPDATE bb_users SET status='closed',closed_at=now() WHERE id=$1", [f.ownerA]);
    assert.equal((await purgeLogContent(pool, blobs, { contentRetentionDays: 30, ownerScope: [f.ownerA] })).purged, 1);
    assert.equal((await fetch(`${address}${path}`)).status, 404);
    assert.equal(pool.idleCount, pool.totalCount);
  } finally { socket?.destroy(); if (!holderReleased) { await holder.query('SELECT pg_advisory_unlock_all()').catch(() => undefined); holder.release(); } await app?.close(); await f.app.close(); await pool.end(); }
});

for (const readMode of ['unread', 'trickle'] as const) test(`#79 prompt deadline closes a ${readMode} live TCP response and releases purge`, { skip }, async () => {
  const pool = new Pool({ connectionString: connection, max: 2 });
  const f = await fixture(pool);
  const blobs = azureBlobs(blobConnection!);
  let app: ReturnType<typeof createServer> | undefined, socket: ReturnType<typeof connect> | undefined;
  let drip: NodeJS.Timeout | undefined;
  let drippedBytes = 0;
  const sendEntered = deferred<void>(), sendGate = deferred<void>();
  try {
    const project = (await f.as(f.ownerA)('POST', '/api/v1/projects', { name: 'Synthetic deadline unread', kind: 'update', issuer_name: null, market: null, offering: null })).json().project_id;
    const snapshot = await savePromptSnapshot(pool, blobs, { owner: f.ownerA, projectId: project, kind: 'user_prompt', version: 1, body: 'UNREAD_MARKER_79' + 'x'.repeat(9 * 1024 * 1024) });
    app = createServer({ pool, blobs, promptViewDeadlineMs: 1000, principal: async () => ({ userId: f.viewer, csrfVerified: true }), allowedOrigin: ORIGIN });
    app.addHook('onSend', async (request, reply, payload) => {
      if (reply.statusCode === 200 && request.url.includes(snapshot)) { sendEntered.resolve(); await sendGate.promise; }
      return payload;
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const path = `/api/v1/admin/prompts/${snapshot}?reason_code=support_case`;
    socket = await rawGetSocket(address, path);
    socket.pause();
    if (readMode === 'trickle') drip = setInterval(() => { if (socket?.read(1)) drippedBytes++; }, 10);
    await sendEntered.promise;
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_log_access_audit WHERE target_ref=$1 AND purpose='prompt_view'", [snapshot])).rows[0].n, 1);
    await pool.query("UPDATE bb_users SET status='closed',closed_at=now() WHERE id=$1", [f.ownerA]);
    let completed = false;
    const purge = purgeLogContent(pool, blobs, { contentRetentionDays: 30, ownerScope: [f.ownerA] }).then(value => { completed = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(completed, false, 'unread response retains the lock before the deadline');
    sendGate.resolve();
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(completed, false, 'slow reader cannot complete the HTTP send immediately');
    const result = await Promise.race([purge, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('unread response held prompt lock past deadline')), 3000))]);
    assert.equal(result.purged, 1);
    if (readMode === 'trickle') assert.ok(drippedBytes > 0, 'client actually read response bytes in small increments');
    assert.equal((await pool.query('SELECT 1')).rowCount, 1);
    assert.equal(pool.idleCount, pool.totalCount);
    assert.equal((await fetch(`${address}${path}`)).status, 404);
  } finally { sendGate.resolve(); if (drip) clearInterval(drip); socket?.destroy(); await app?.close(); await f.app.close(); await pool.end(); }
});

test('#79 prompt deadline allows a normal TCP response and ends a stuck onSend', { skip }, async () => {
  const pool = new Pool({ connectionString: connection, max: 2 });
  const f = await fixture(pool);
  const blobs = azureBlobs(blobConnection!);
  const sendEntered = deferred<void>(), sendGate = deferred<void>();
  let app: ReturnType<typeof createServer> | undefined, socket: ReturnType<typeof connect> | undefined;
  try {
    const project = (await f.as(f.ownerA)('POST', '/api/v1/projects', { name: 'Synthetic deadline onSend', kind: 'update', issuer_name: null, market: null, offering: null })).json().project_id;
    const normal = await savePromptSnapshot(pool, blobs, { owner: f.ownerA, projectId: project, kind: 'user_prompt', version: 1, body: 'synthetic DEADLINE_NORMAL_MARKER_79' });
    const stuck = await savePromptSnapshot(pool, blobs, { owner: f.ownerA, projectId: project, kind: 'user_prompt', version: 2, body: 'synthetic DEADLINE_ONSEND_MARKER_79' });
    app = createServer({ pool, blobs, promptViewDeadlineMs: 350, principal: async () => ({ userId: f.viewer, csrfVerified: true }), allowedOrigin: ORIGIN });
    app.addHook('onSend', async (request, reply, payload) => {
      if (reply.statusCode === 200 && request.url.includes(stuck)) { sendEntered.resolve(); await sendGate.promise; }
      return payload;
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const normalPath = `/api/v1/admin/prompts/${normal}?reason_code=support_case`;
    const normalResponse = await fetch(`${address}${normalPath}`);
    assert.equal(normalResponse.status, 200);
    assert.ok((await normalResponse.text()).includes('DEADLINE_NORMAL_MARKER_79'));
    for (let i = 0; i < 20 && pool.idleCount !== pool.totalCount; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(pool.idleCount, pool.totalCount);
    const stuckPath = `/api/v1/admin/prompts/${stuck}?reason_code=support_case`;
    socket = await rawGetSocket(address, stuckPath);
    let received = '';
    socket.on('data', chunk => { received += chunk.toString(); });
    await sendEntered.promise;
    await pool.query("UPDATE bb_users SET status='closed',closed_at=now() WHERE id=$1", [f.ownerA]);
    const purged = await Promise.race([purgeLogContent(pool, blobs, { contentRetentionDays: 30, ownerScope: [f.ownerA] }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('onSend held lock past deadline')), 2000))]);
    assert.equal(purged.purged, 2);
    sendGate.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(!received.includes('DEADLINE_ONSEND_MARKER_79'));
    assert.equal((await fetch(`${address}${stuckPath}`)).status, 404);
    assert.equal(pool.idleCount, pool.totalCount);
  } finally { sendGate.resolve(); socket?.destroy(); await app?.close(); await f.app.close(); await pool.end(); }
});

for (const stalledStage of ['snapshot', 'audit'] as const) test(`#79 PG statement deadline cancels a 3-second ${stalledStage} query holding the prompt lock`, { skip }, async () => {
  const pool = new Pool({ connectionString: connection, max: 2 });
  const observer = new Pool({ connectionString: connection, max: 1 });
  const f = await fixture(pool);
  const blobs = azureBlobs(blobConnection!);
  const entered = deferred<void>();
  let app: ReturnType<typeof createServer> | undefined, backendPid: number | undefined;
  try {
    const project = (await f.as(f.ownerA)('POST', '/api/v1/projects', { name: 'Synthetic PG deadline', kind: 'update', issuer_name: null, market: null, offering: null })).json().project_id;
    const snapshot = await savePromptSnapshot(pool, blobs, { owner: f.ownerA, projectId: project, kind: 'user_prompt', version: 1, body: `synthetic PG_DEADLINE_${stalledStage}_79` });
    const connectOriginal = pool.connect.bind(pool);
    let injected = false;
    pool.connect = ((callback?: any) => {
      if (callback) return connectOriginal(callback);
      return (async () => {
      const client = await connectOriginal();
      const queryOriginal = client.query.bind(client);
      client.query = (async (...args: any[]) => {
        const sql = args[0];
        const matches = typeof sql === 'string' && (stalledStage === 'snapshot' ? sql.includes('SELECT s.*,t.id tombstone') : sql.includes('INSERT INTO bb_log_access_audit'));
        if (!injected && matches) {
          injected = true;
          backendPid = (await queryOriginal('SELECT pg_backend_pid()')).rows[0].pg_backend_pid;
          entered.resolve();
          await queryOriginal('SELECT pg_sleep(3)');
        }
        return queryOriginal(...args as [string]);
      }) as typeof client.query;
      return client;
      })();
    }) as typeof pool.connect;
    app = createServer({ pool, blobs, promptViewDeadlineMs: 180, principal: async () => ({ userId: f.viewer, csrfVerified: true }), allowedOrigin: ORIGIN });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const path = `/api/v1/admin/prompts/${snapshot}?reason_code=support_case`;
    const reading = fetch(`${address}${path}`).catch(() => undefined);
    await Promise.race([entered.promise, reading.then(response => { throw new Error(`prompt request finished before PG stall: ${response?.status ?? 'disconnected'}`); }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('prompt request never reached injected PG query')), 1500))]);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((await observer.query("SELECT count(*)::int n FROM pg_stat_activity WHERE pid=$1 AND state='active' AND query LIKE '%pg_sleep%'", [backendPid])).rows[0].n, 1, '3-second PostgreSQL query actually entered the server');
    const started = performance.now();
    await pool.query("UPDATE bb_users SET status='closed',closed_at=now() WHERE id=$1", [f.ownerA]);
    const result = await Promise.race([purgeLogContent(pool, blobs, { contentRetentionDays: 30, ownerScope: [f.ownerA] }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('PG stall outlived the prompt deadline')), 1000))]);
    assert.equal(result.purged, 1);
    assert.ok(performance.now() - started < 1000, 'purge finishes before the injected 3-second query');
    assert.equal((await observer.query("SELECT count(*)::int n FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND granted", [backendPid])).rows[0].n, 0);
    assert.equal((await observer.query("SELECT count(*)::int n FROM pg_stat_activity WHERE pid=$1 AND state='active' AND query LIKE '%pg_sleep%'", [backendPid])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT 1')).rowCount, 1);
    const response = await reading;
    if (response) assert.ok(!(await response.text()).includes(`PG_DEADLINE_${stalledStage}_79`));
    assert.equal((await fetch(`${address}${path}`)).status, 404);
    assert.equal(pool.idleCount, pool.totalCount);
  } finally { await app?.close(); await f.app.close(); await pool.end(); await observer.end(); }
});
