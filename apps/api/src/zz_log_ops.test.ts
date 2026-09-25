import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { Value } from '@sinclair/typebox/value';
import { schemas } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { azureBlobs, digest, transaction, uid } from './data.js';
import { emitInternal, internalEvent, observeUsage } from './observability.js';
import { action, recordPotentialCall, type Lease } from './queue.js';
import { gateState, resetProcessGateForTests, tripEvidenceGate } from './evidence-gate.js';
import { checkLogHealth, forwardLogs, grantOperator, ndjsonFileSink, ndjsonSizeCapFromEnv, purgeLogContent, revokeOperator, savePromptSnapshot, scrubSecrets, type LogRecord, type LogSink } from './log-ops.js';

// Synthetic data only. No real provider, credential or customer material is used.
const connection = process.env.BB_TEST_DATABASE_URL;
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const skip = !connection || !blobConnection;
const ORIGIN = 'http://bondbuddy.test';
const SECRET_PROMPT = 'Synthetic prompt PLAINTEXT_MARKER_79. 验证码：482913. Cookie: bb_session=abc123secret. api_key=sk-synthetictestkey000000000000. Authorization: Bearer syntheticbearertoken';

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
      env: { ...process.env, BB_TEST_LOG_MODULE: new URL('./log-ops.js', import.meta.url).href, BB_TEST_LOG_FILE: file, BB_TEST_LOG_SINK: sinkName }
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
  for (const input of [nested(65), nested(5000), '{'.repeat(20000) + '}'.repeat(20000), '{session_cookie:"SYN_MALFORMED"}', '{session_cookie SYN_BAD}', '{note: text, setCookie: SYN_LEAK_MARKER}', '{"session_cookie":"SYN_UNCLOSED"']) {
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
  const plainKeys = scrubSecrets('session_cookie=SYN_PLAIN_COOKIE\r\nx_api_key=SYN_PLAIN_KEY\r\none_time_password=SYN_PLAIN_PASSWORD\r\n业务正文');
  for (const secret of ['SYN_PLAIN_COOKIE', 'SYN_PLAIN_KEY', 'SYN_PLAIN_PASSWORD']) assert.ok(!plainKeys.includes(secret));
  assert.ok(plainKeys.endsWith('业务正文'));
  const maxBody = 'A'.repeat(10 * 1024 * 1024);
  assert.equal(scrubSecrets(maxBody).length, maxBody.length);
  assert.throws(() => scrubSecrets(maxBody + 'B'), /Diagnostic body rejected/);
});

test('#79 structured parsing limits bound fragments, aggregate work and token count', () => {
  const nearFragment = JSON.stringify({ note: 'A'.repeat(256 * 1024 - 100), Cookie: 'SYN_LIMIT_COOKIE' });
  const accepted = scrubSecrets(nearFragment);
  assert.ok(accepted.includes('A'.repeat(100)) && !accepted.includes('SYN_LIMIT_COOKIE'));
  const overFragment = JSON.stringify({ note: 'A'.repeat(256 * 1024), Cookie: 'SYN_OVER_COOKIE' });
  assert.throws(() => scrubSecrets(overFragment), /Diagnostic body rejected/);
  const smallObject = '{"note":"x"}';
  assert.ok(scrubSecrets(smallObject.repeat(1024)).includes('"note"'));
  assert.throws(() => scrubSecrets(smallObject.repeat(1025)), /Diagnostic body rejected/);
  const aggregate = JSON.stringify({ note: 'A'.repeat(200 * 1024) });
  assert.throws(() => scrubSecrets(aggregate.repeat(6)), /Diagnostic body rejected/);
  assert.throws(() => scrubSecrets('[' + '0,'.repeat(5000).slice(0, -1) + ']'), /Diagnostic body rejected/);
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
    const wide = '[' + '{"note":"synthetic"},'.repeat(210000).slice(0, -1) + ']';
    for (const body of [deep, '{'.repeat(20000) + '}'.repeat(20000), '{"x_api_key":"SYN_BAD_JSON"', '{note: text, setCookie: SYN_LEAK_MARKER}', wide, 'A'.repeat(10 * 1024 * 1024 + 1)]) {
      await assert.rejects(savePromptSnapshot(pool, counted, { owner: f.ownerA, projectId: project, kind: 'structured_input', version: 1, body }),
        error => error instanceof Error && error.message === 'Diagnostic body rejected' && !error.stack?.includes('SYN_'));
    }
    assert.equal(puts, 0, 'scrub rejects before Blob put');
    const after = Number((await pool.query('SELECT count(*)::int n FROM bb_snapshot_refs WHERE owner_user_id=$1 AND project_id=$2', [f.ownerA, project])).rows[0].n);
    assert.equal(after, before, 'no partial snapshot reference');
  } finally { await f.app.close(); await pool.end(); }
});

test('#79 wide JSON arrays reject in bounded 128/256 MiB child heaps', async t => {
  const moduleUrl = new URL('./log-ops.js', import.meta.url).href;
  for (const heapMiB of [128, 256]) for (const sizeMiB of [4, 9]) {
    const source = `import { performance } from 'node:perf_hooks';
      const { scrubSecrets } = await import(process.env.BB_TEST_LOG_MODULE);
      const unit = '{"note":"synthetic"},';
      const count = Math.ceil(${sizeMiB} * 1024 * 1024 / unit.length);
      const body = '[' + unit.repeat(count).slice(0, -1) + ']';
      const started = performance.now();
      let rejected = false;
      try { scrubSecrets(body); } catch (error) { rejected = error?.message === 'Diagnostic body rejected' && !String(error?.stack).includes('synthetic'); }
      const elapsedMs = Math.round(performance.now() - started);
      process.stdout.write(JSON.stringify({ rejected, elapsedMs, peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024), inputMiB: ${sizeMiB} }));
      if (!rejected) process.exitCode = 1;`;
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
    assert.equal(metrics.rejected, true);
    assert.ok(metrics.elapsedMs < 2000, 'wide input rejects before object-tree allocation');
    t.diagnostic(`${heapMiB} MiB heap / ${sizeMiB} MiB wide input: ${metrics.elapsedMs} ms, peak RSS ${metrics.peakRssMiB} MiB`);
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
