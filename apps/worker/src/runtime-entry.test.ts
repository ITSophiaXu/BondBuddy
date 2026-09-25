// SYNTHETIC PostgreSQL 16/Azurite smoke for the #17 production worker entry (runtime.ts): options
// built from the container environment, a heartbeat row, a leased parse job, a submitted run
// paused at `capability_not_ready` by defaultRunStages(), the opt-in probe loop with the fake
// `codex` (no provider is called), and SIGTERM on the real `dist/runtime.js` process. Claims are
// global, so the file runs in its own clone of the migrated template (see test-database.ts).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { azureBlobs } from '@bondbuddy/api/data';
import { adminJobTimeline, grantOperator } from '@bondbuddy/api/log-ops';
import type { DocumentParseRequest, DocumentParseResponse } from './document-parser.js';
import { WorkerRuntime, workerRuntimeOptionsFromEnv } from './runtime.js';
import { isolatedTestDatabase } from './test-database.js';

const connection = await isolatedTestDatabase('BB_TEST_RUNTIME_DATABASE_URL');
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const ORIGIN = 'http://bondbuddy.test';
const fake = fileURLToPath(new URL('../test-fixtures/codex/fake-codex.mjs', import.meta.url));
const entry = fileURLToPath(new URL('./runtime.js', import.meta.url));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const until = async <T>(read: () => Promise<T | undefined | null | false>, ms = 15000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const v = await read(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); }
};

function syntheticParse(request: DocumentParseRequest): DocumentParseResponse {
  const m = request.material;
  return { schema_version: 'document-parse-response-v1', request_id: request.request_id, parser_version: 'bondbuddy-document-parser-1.0.3', status: 'parsed',
    material: { material_id: m.material_id, material_version: m.material_version, media_type: m.media_type, sha256: m.sha256 },
    records: [{ record_id: 'line-1', material_id: m.material_id, material_version: m.material_version, content_hash: m.sha256, locator_type: 'text_line', locator: { line: 1, stable_ref: 'text:l000001' },
      literal_quote: 'Synthetic audit text', context: 'synthetic', extraction_method: 'native_text', extractor_version: 'bondbuddy-document-parser-1.0.3', confidence: 1, uncertainty: [], formatting: {} }],
    warnings: [], document: { page_count: null, encoding: 'utf-8' }, error: null } as DocumentParseResponse;
}

test('synthetic #17 production entry: heartbeat, parse claim, capability_not_ready run, probe loop, SIGTERM', { skip: !connection || !blobConnection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const container = `bb-entry-${randomUUID()}`;
  const blobs = azureBlobs(blobConnection!, container);
  const owner = `entry-owner-${randomUUID()}`, operator = `entry-operator-${randomUUID()}`;
  const app = createServer({ pool, blobs, allowedOrigin: ORIGIN, principal: async () => ({ userId: owner, csrfVerified: true }), enableRunRuntime: true });
  const send = (method: string, url: string, payload?: unknown, contentType?: string) => app.inject({ method: method as any, url,
    headers: { origin: ORIGIN, ...(contentType ? { 'content-type': contentType } : {}) }, payload: payload as any });
  let runtime: WorkerRuntime | undefined;
  const root = await mkdtemp(join(tmpdir(), 'bb-entry-'));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, BB_PARSE_CACHE_OCR_VERSION: 'synthetic-ocr-1', BB_PARSE_CACHE_BASIS_VERSION: 'synthetic-basis-1',
    BB_WORKER_CONCURRENCY: '1', BB_WORKER_POLL_MS: '100', BB_WORKER_HEARTBEAT_MS: '1000', BB_WORKER_SWEEP_MS: '1000', BB_WORKER_DRAIN_MS: '2000',
    BB_PLATFORM_PROBE_ENABLED: '1', BB_PLATFORM_PROBE_POLL_MS: '500', BB_CODEX_BIN: fake, BB_CODEX_CREDENTIAL_ENV: 'BB_SYNTHETIC_DEEPSEEK_KEY',
    BB_SYNTHETIC_DEEPSEEK_KEY: 'synthetic-not-a-key', BB_CODEX_WORK_ROOT: join(root, 'work'),
  };
  try {
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [operator, `u${operator.replace(/-/g, '_').toLowerCase()}`.slice(0, 32)]);
    await grantOperator(pool, { userId: operator, role: 'log_reader', grantedBy: 'synthetic-test', reasonCode: 'runtime_entry_test' });
    const beforeReady = await send('GET', '/api/v1/ready');
    assert.equal(beforeReady.statusCode, 503);
    assert.equal(beforeReady.json().checks.worker_heartbeat, 'missing');

    // Env validation fails closed: a probe without its credential never starts.
    assert.throws(() => workerRuntimeOptionsFromEnv(pool, blobs, { ...env, BB_SYNTHETIC_DEEPSEEK_KEY: '' }), /credential/);
    assert.throws(() => workerRuntimeOptionsFromEnv(pool, blobs, { ...env, BB_WORKER_CONCURRENCY: '0' }), /BB_WORKER_CONCURRENCY/);
    assert.equal(workerRuntimeOptionsFromEnv(pool, blobs, { ...env, BB_PLATFORM_PROBE_ENABLED: '0' }).platformProbe, undefined, 'probe is opt-in');

    // A material (parse job) and a submitted run pinned to it.
    const projectId = (await send('POST', '/api/v1/projects', { name: 'Synthetic entry', kind: 'update', issuer_name: null, market: null, offering: null })).json().project_id as string;
    const text = Buffer.from(`synthetic audit ${randomUUID()}`);
    const start = await send('POST', `/api/v1/projects/${projectId}/materials/uploads`, { filename: 'synthetic-audit.txt', media_type: 'text/plain', byte_size: text.length, sha256: sha(text), role: 'audit' });
    assert.equal(start.statusCode, 201, start.body);
    assert.equal((await send('PUT', start.json().upload_url, text, 'application/octet-stream')).statusCode, 204);
    const material = (await send('POST', `/api/v1/projects/${projectId}/materials/uploads/${start.json().upload_id}/complete`, { byte_size: text.length, sha256: sha(text) })).json();
    const current = (await send('GET', `/api/v1/projects/${projectId}`)).json();
    const input = (await send('POST', `/api/v1/projects/${projectId}/input-revisions`, { draft_revision: current.draft_revision,
      material_versions: [{ material_id: material.material_id, material_version: material.material_version }], requirement_message_ids: [] })).json();
    const submitted = await send('POST', '/api/v1/runs/execute', { execution_request_id: `entry-${randomUUID()}`, project_id: projectId, input_revision: input.input_revision, input_hash: input.input_hash,
      task_kind: 'update', input_manifest_ref: 'synthetic-manifest', storage_origin: 'cloud', workspace_id: 'synthetic-worker' });
    assert.equal(submitted.statusCode, 202, submitted.body);
    const runId = submitted.json().run_id as string;

    // In-process runtime from the production options; only the parser is the synthetic stand-in.
    const options = workerRuntimeOptionsFromEnv(pool, blobs, env);
    assert.ok(options.platformProbe && options.concurrency === 1 && options.runStages!.length > 0);
    assert.deepEqual(options.runStages!.map(stage => stage.name), ['input_lock', 'materials_ready', 'model_generation', 'word_delivery']);
    const workerId = `synthetic-entry-${randomUUID().slice(0, 8)}`;
    runtime = new WorkerRuntime({ ...options, workerId, parse: { ...options.parse, material: { ...options.parse!.material, parser: async r => syntheticParse(r) } } }).start();
    const beat = await until(async () => (await pool.query('SELECT * FROM bb_worker_heartbeats WHERE worker_id=$1', [workerId])).rows[0]);
    assert.deepEqual(beat.kinds, ['run', 'parse']); assert.equal(beat.stopped_at, null);
    const ready = await until(async () => {
      const response = await send('GET', '/api/v1/ready');
      return response.statusCode === 200 ? response : null;
    });
    assert.equal(ready.json().status, 'ready');
    assert.equal(ready.json().checks.worker_heartbeat, 'ok');
    const parse = await until(async () => (await pool.query("SELECT id,state,checkpoint,attempts FROM bb_jobs WHERE job_type='parse' AND owner_user_id=$1 AND state='succeeded'", [owner])).rows[0]);
    assert.equal(parse.state, 'succeeded', 'the runtime claimed and finished the parse job');
    const parseClaimEvents = async () => Number((await pool.query("SELECT count(*)::int n FROM bb_job_events WHERE job_id=$1 AND type='material_parse.claimed'", [parse.id])).rows[0].n);
    assert.equal(await parseClaimEvents(), 1);
    assert.ok(parse.checkpoint.stages.parse_evidence, 'parse checkpoint is durable before restart');
    const run = await until(async () => (await pool.query("SELECT r.state,j.id AS job_id,j.stage,j.error_code,j.state AS job_state FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id WHERE r.id=$1 AND j.stage='capability_not_ready'", [runId])).rows[0]);
    assert.equal(run.state, 'paused', JSON.stringify(run));
    const timeline = await adminJobTimeline(pool, operator, run.job_id);
    assert.ok(timeline.stages.some(s => s.stage === 'capability_not_ready' && ['rule_pack_pin_missing', 'production_rule_pack_selector_unavailable'].includes(s.reason ?? '')), JSON.stringify(timeline.stages));
    assert.notEqual(timeline.outcome.state, 'succeeded');
    await runtime.stop();
    assert.ok((await pool.query('SELECT stopped_at FROM bb_worker_heartbeats WHERE worker_id=$1', [workerId])).rows[0].stopped_at);
    const afterStop = await send('GET', '/api/v1/ready');
    assert.equal(afterStop.statusCode, 503);
    assert.equal(afterStop.json().checks.worker_heartbeat, 'missing');
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_jobs WHERE state='running'")).rows[0].n, 0, 'no lease left behind');
    const runCheckpoint = (await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1', [run.job_id])).rows[0].checkpoint;
    const runningEvents = Number((await pool.query("SELECT count(*)::int n FROM bb_run_events WHERE run_id=$1 AND state='running'", [runId])).rows[0].n);

    // The real entry point: node dist/runtime.js, then SIGTERM -> drained, stopped heartbeat, exit 0.
    const child = spawn(process.execPath, [entry], { env: { ...env, DATABASE_URL: connection, AZURE_STORAGE_CONNECTION_STRING: blobConnection }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
    await until(async () => out.includes('"kind":"started"') && (await pool.query("SELECT 1 FROM bb_worker_heartbeats WHERE stopped_at IS NULL AND kinds=ARRAY['run','parse']")).rows[0], 20000);
    assert.match(out, /"platform_probe":true/);
    child.kill('SIGTERM');
    assert.equal(await exited, 0, out);
    assert.match(out, /"kind":"stopped"/);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_worker_heartbeats WHERE stopped_at IS NULL')).rows[0].n, 0, 'every heartbeat is marked stopped');
    assert.equal(await parseClaimEvents(), 1, 'restart did not claim the completed parse job twice');
    assert.deepEqual((await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1', [parse.id])).rows[0].checkpoint, parse.checkpoint, 'restart preserved the completed parse checkpoint');
    assert.deepEqual((await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1', [run.job_id])).rows[0].checkpoint, runCheckpoint, 'restart preserved the paused run checkpoint');
    assert.equal(Number((await pool.query("SELECT count(*)::int n FROM bb_run_events WHERE run_id=$1 AND state='running'", [runId])).rows[0].n), runningEvents, 'paused run was not claimed a second time');
    assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1', [runId])).rows[0].state, 'paused');
    assert.doesNotMatch(out, /synthetic-not-a-key/, 'the credential value is never logged');
  } finally {
    await runtime?.stop();
    await rm(root, { recursive: true, force: true });
    await app.close();
    await pool.end();
  }
});
