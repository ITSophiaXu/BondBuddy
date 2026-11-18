import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Pool } from 'pg';
import { transaction, type PrivateBlobs } from '@bondbuddy/api/data';
import { ndjsonFileSink } from '@bondbuddy/api/log-ops';
import { emitInternal, internalEvent } from '@bondbuddy/api/observability';
import { checkWorkerHeartbeat, claimTask, finishTask, jittered, OpsScheduler, tasksFromEnv, type ScheduledTask } from './ops-scheduler.js';
import { isolatedTestDatabase } from './test-database.js';

// #79/#35 ops scheduler. Synthetic only: no real sinks, blobs or providers.
const connection = await isolatedTestDatabase('BB_TEST_RUNTIME_DATABASE_URL');
const noBlobs = new Proxy({}, { get: () => async () => { throw new Error('no blob access expected'); } }) as PrivateBlobs;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function crashAfterFileAccept(databaseUrl: string, file: string) {
  const source = `import { Pool } from 'pg';
    const { forwardLogs, ndjsonFileSink } = await import('@bondbuddy/api/log-ops');
    const pool = new Pool({ connectionString: process.env.BB_TEST_DATABASE_URL });
    // The pre-fix writer accepted a batch crossing the scheduler's size cap.
    await forwardLogs(pool, ndjsonFileSink(process.env.BB_TEST_LOG_FILE), {
      batchSize: 100, afterSinkAccept: async () => process.exit(17)
    });`;
  return await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, BB_TEST_DATABASE_URL: databaseUrl, BB_TEST_LOG_FILE: file }
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
  });
}

test('jitter stays within the configured band', () => {
  assert.equal(jittered(1000, 0.1, () => 0), 900);
  assert.equal(jittered(1000, 0.1, () => 1), 1100);
  assert.equal(jittered(1000, 0, Math.random), 1000);
});

test('env wiring: sink file enables forwarding; purge needs blob; backfill is opt-in', () => {
  const pool = {} as Pool;
  const base = { BB_TRIAL_GUARD: 'off', BB_STORAGE_PURGE_ENABLED: 'false' } as NodeJS.ProcessEnv;
  assert.deepEqual(tasksFromEnv(pool, base).map(t => t.name), ['provider_reconcile', 'log_health', 'trial_health', 'worker_heartbeat']);
  assert.equal(tasksFromEnv(pool, { ...base, DEEPSEEK_API_KEY: 'synthetic', BB_CODEX_PROVIDER: 'copilot_enterprise' }).some(t => t.name === 'provider_balance'), false);
  assert.equal(tasksFromEnv(pool, { ...base, DEEPSEEK_API_KEY: 'synthetic', BB_CODEX_PROVIDER: 'deepseek' }).some(t => t.name === 'provider_balance'), true);
  const all = tasksFromEnv(pool, { ...base, BB_LOG_SINK_FILE: '/tmp/x.ndjson', BB_STORAGE_PURGE_ENABLED: 'true', BB_STORAGE_MATERIAL_RETENTION_DAYS: '7', BB_STORAGE_ORPHAN_GRACE_HOURS: '24', BB_LOG_CONTENT_RETENTION_DAYS: '180', AZURE_STORAGE_CONNECTION_STRING: 'synthetic', BB_OPS_PARSE_BACKFILL: 'on' }, () => noBlobs);
  assert.deepEqual(all.map(t => t.name), ['provider_reconcile', 'log_forward', 'log_health', 'storage_inventory', 'storage_purge', 'trial_health', 'worker_heartbeat', 'backup_retention', 'parse_backfill']);
  const archived = tasksFromEnv(pool, { ...base, BB_LOG_SINK_FILE: '/tmp/x.ndjson', BB_LOG_ARCHIVE_ENABLED: '1', DATABASE_URL: 'synthetic', AZURE_STORAGE_CONNECTION_STRING: 'synthetic' }, () => noBlobs);
  assert.ok(archived.some(task => task.name === 'archive_retention'));
  assert.throws(() => tasksFromEnv(pool, { ...base, BB_LOG_SINK_FILE: '/tmp/x.ndjson', BB_LOG_ARCHIVE_ENABLED: '1', DATABASE_URL: 'synthetic', AZURE_STORAGE_CONNECTION_STRING: 'synthetic', BB_LOG_ARCHIVE_RETENTION_DAYS: '29' }, () => noBlobs), /30 to 3650/);
  assert.throws(() => tasksFromEnv(pool, { ...base, BB_LOG_SINK_FILE: '/tmp/x.ndjson', BB_LOG_ARCHIVE_ENABLED: '1', DATABASE_URL: 'synthetic', AZURE_STORAGE_CONNECTION_STRING: 'synthetic', BB_LOG_SINK_MAX_BYTES: String(65 * 1024 * 1024) }, () => noBlobs), /64 MiB/);
  assert.throws(() => tasksFromEnv(pool, { ...base, BB_STORAGE_PURGE_ENABLED: 'true', BB_STORAGE_MATERIAL_RETENTION_DAYS: '7', BB_STORAGE_ORPHAN_GRACE_HOURS: '24' }), /AZURE_STORAGE_CONNECTION_STRING/);
});

test('two scheduler instances execute each due task exactly once', { skip: !connection }, async () => {
  const a = new Pool({ connectionString: connection, max: 2 }), b = new Pool({ connectionString: connection, max: 2 });
  try {
    let executions = 0, concurrent = 0, maxConcurrent = 0;
    const task = (): ScheduledTask => ({ name: 'log_health', intervalMs: 60_000, leaseMs: 30_000, run: async () => {
      executions++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(150); concurrent--; return { ok: true };
    } });
    const one = new OpsScheduler({ pool: a, tasks: [task()], owner: 'synthetic-a', tickMs: 20 });
    const two = new OpsScheduler({ pool: b, tasks: [task()], owner: 'synthetic-b', tickMs: 20 });
    // Race many ticks from both instances at once.
    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? one : two).tick()));
    one.start(); two.start();
    await sleep(600);
    await Promise.all([one.stop(), two.stop()]);
    assert.equal(executions, 1, 'the due task ran once across both instances');
    assert.equal(maxConcurrent, 1);
    const row = (await a.query("SELECT * FROM bb_ops_schedule WHERE task='log_health'")).rows[0];
    assert.equal(row.runs, '1');
    assert.equal(row.last_status, 'succeeded');
    assert.equal(row.lease_token, null);
    assert.ok(new Date(row.next_due_at).getTime() > Date.now() + 50_000, 'next run is an interval away (with jitter)');
  } finally { await a.end(); await b.end(); }
});

test('an expired lease can be re-claimed and the stale holder cannot finish over it', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  try {
    const first = await claimTask(pool, 'trial_health', 'synthetic-a', 1000);
    assert.ok(first);
    assert.equal(await claimTask(pool, 'trial_health', 'synthetic-b', 1000), null, 'live lease blocks');
    await sleep(1100);
    const second = await claimTask(pool, 'trial_health', 'synthetic-b', 60_000);
    assert.ok(second, 'crashed holder does not block forever');
    assert.equal(await finishTask(pool, 'trial_health', first!, { ok: true }, 1000), false, 'stale holder is ignored');
    assert.equal(await finishTask(pool, 'trial_health', second!, { ok: true }, 60_000), true);
  } finally { await pool.end(); }
});

test('a failing run appends one deduplicated scheduled_task_failed alert and is retried later', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  try {
    let calls = 0;
    const failing: ScheduledTask = { name: 'storage_purge', intervalMs: 1000, leaseMs: 5000, run: async () => { calls++; if (calls === 1) throw new Error('synthetic'); return { ok: false, errorCode: 'purge_items_failed', detail: { failed: 2 } }; } };
    const s = new OpsScheduler({ pool, tasks: [failing], owner: 'synthetic-a', jitter: 0 });
    await s.tick();
    await s.tick(); // not due yet
    assert.equal(calls, 1);
    await sleep(1100);
    await s.tick();
    assert.equal(calls, 2);
    const row = (await pool.query("SELECT runs,failures,last_status,last_error_code FROM bb_ops_schedule WHERE task='storage_purge'")).rows[0];
    assert.deepEqual(row, { runs: '2', failures: '2', last_status: 'failed', last_error_code: 'purge_items_failed' });
    const alerts = (await pool.query("SELECT kind,severity,detail FROM bb_ops_alerts WHERE kind='scheduled_task_failed'")).rows;
    assert.equal(alerts.length, 1, 'hourly dedupe keeps one open alert per task');
    assert.equal(alerts[0].detail.task, 'storage_purge');
    assert.equal(alerts[0].detail.error_code, 'task_threw');
  } finally { await pool.end(); }
});

test('worker heartbeat check alerts when no live worker is fresh', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  try {
    await pool.query("DELETE FROM bb_worker_heartbeats");
    assert.deepEqual(await checkWorkerHeartbeat(pool, 90), { age_seconds: -1, stale: 1 });
    await pool.query("INSERT INTO bb_worker_heartbeats(worker_id,started_at,last_seen_at,kinds,concurrency) VALUES('synthetic-w',now(),now(),ARRAY['parse'],1)");
    assert.equal((await checkWorkerHeartbeat(pool, 90)).stale, 0);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_ops_alerts WHERE kind='worker_heartbeat_stale'")).rows[0].n, 1);
  } finally { await pool.end(); }
});

test('log forwarding task writes NDJSON to the sink file', { skip: !connection }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-ops-'));
  const pool = new Pool({ connectionString: connection });
  try {
    const file = join(dir, 'sink.ndjson');
    const [forward] = tasksFromEnv(pool, { BB_LOG_SINK_FILE: file, BB_TRIAL_GUARD: 'off', BB_STORAGE_PURGE_ENABLED: 'false' });
    assert.equal(forward.name, 'log_forward');
    for (let i = 0; i < 3; i++) await transaction(pool, client => emitInternal(client, internalEvent({ kind: 'error.recorded', owner: 'synthetic-ops-owner', traceId: `synthetic-trace-${i}`, stage: 'synthetic_stage' })));
    const pending = (await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_type='observability' AND delivered_at IS NULL")).rows[0].n;
    assert.ok(pending >= 3 && pending <= 1000);
    const outcome = await forward.run();
    assert.deepEqual(outcome, { ok: true, detail: { delivered: pending } });
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, pending);
    assert.equal(lines.filter(l => l.user_id === 'synthetic-ops-owner').length, 3);
    assert.deepEqual(await forward.run(), { ok: true, detail: { delivered: 0 } }, 'a second run re-sends nothing');
  } finally { await pool.end(); await rm(dir, { recursive: true, force: true }); }
});

test('scheduler does not rotate an over-cap segment before or after two-process replay', { skip: !connection }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-ops-rotation-'));
  const pool = new Pool({ connectionString: connection });
  try {
    const file = join(dir, 'sink.ndjson');
    const [forward] = tasksFromEnv(pool, { BB_LOG_SINK_FILE: file, BB_LOG_SINK_MAX_BYTES: '1024', BB_TRIAL_GUARD: 'off', BB_STORAGE_PURGE_ENABLED: 'false' });
    for (let i = 0; i < 35; i++) await transaction(pool, client => emitInternal(client, internalEvent({ kind: 'error.recorded', owner: 'synthetic-rotation', traceId: `synthetic-rotation-${i}`, stage: 'synthetic_stage' })));
    const pending = (await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_type='observability' AND delivered_at IS NULL")).rows[0].n;
    assert.equal(pending, 35);
    const before = (await pool.query("SELECT count(*)::int n FROM bb_log_deliveries WHERE sink='ndjson_file'")).rows[0].n;
    const crashed = await crashAfterFileAccept(connection!, file);
    assert.equal(crashed.code, 17, crashed.stderr);
    const acceptedSize = (await stat(file)).size;
    assert.ok(acceptedSize >= 1024, 'accepted batch crossed the rotation threshold');
    await assert.rejects(stat(`${file}.1`));
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_log_deliveries WHERE sink='ndjson_file'")).rows[0].n, before);
    await pool.query("UPDATE bb_outbox SET lease_until=now()-interval '1 second' WHERE aggregate_type='observability' AND delivered_at IS NULL AND lease_token IS NOT NULL");
    assert.deepEqual(await forward.run(), { ok: true, detail: { delivered: pending } });
    await assert.rejects(stat(`${file}.1`), 'unacknowledged lines must not rotate');
    const firstLines = (await readFile(file, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    assert.equal(firstLines.length, pending);
    assert.equal(new Set(firstLines.map(line => line.delivery_key)).size, pending);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_log_deliveries WHERE sink='ndjson_file'")).rows[0].n, before + pending);
    assert.deepEqual(await forward.run(), { ok: true, detail: { delivered: 0 } });
    assert.equal((await stat(file)).size, acceptedSize);
    await assert.rejects(stat(`${file}.1`), 'no automatic rotation after acknowledgement: stale processes may still send old keys');
    const old = firstLines[0];
    const { delivery_key, ...event } = old;
    await ndjsonFileSink(file, 'ndjson_file', 1024).deliver([{ delivery_key, outbox_id: 'synthetic-late-forwarder', event }]);
    assert.equal((await stat(file)).size, acceptedSize, 'a late forwarder cannot duplicate a now-acknowledged key');
    await transaction(pool, client => emitInternal(client, internalEvent({ kind: 'error.recorded', owner: 'synthetic-rotation', traceId: 'synthetic-rotation-next', stage: 'synthetic_stage' })));
    const capped = await forward.run();
    assert.equal(capped.ok, false);
    assert.equal(capped.errorCode, 'sink_unavailable');
    assert.equal((await stat(file)).size, acceptedSize);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_type='observability' AND delivered_at IS NULL")).rows[0].n, 1);
  } finally { await pool.end(); await rm(dir, { recursive: true, force: true }); }
});

test('scheduler fails closed at cap when pending file keys cannot be reconciled', { skip: !connection }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-ops-cap-'));
  const pool = new Pool({ connectionString: connection });
  try {
    const file = join(dir, 'sink.ndjson');
    const oldLine = JSON.stringify({ delivery_key: 'f'.repeat(64), kind: 'synthetic.event', padding: 'x'.repeat(1200) }) + '\n';
    await writeFile(file, oldLine, { mode: 0o600 }); // valid file key with no PG receipt
    const pendingBefore = (await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_type='observability' AND delivered_at IS NULL")).rows[0].n;
    await transaction(pool, client => emitInternal(client, internalEvent({ kind: 'error.recorded', owner: 'synthetic-cap', traceId: 'synthetic-cap-trace', stage: 'synthetic_stage' })));
    const [forward] = tasksFromEnv(pool, { BB_LOG_SINK_FILE: file, BB_LOG_SINK_MAX_BYTES: '1024', BB_TRIAL_GUARD: 'off', BB_STORAGE_PURGE_ENABLED: 'false' });
    const outcome = await forward.run();
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorCode, 'sink_unavailable');
    assert.equal(await readFile(file, 'utf8'), oldLine);
    await assert.rejects(stat(`${file}.1`));
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_type='observability' AND delivered_at IS NULL")).rows[0].n, pendingBefore + 1);
  } finally { await pool.end(); await rm(dir, { recursive: true, force: true }); }
});

test('backup_retention records its last success and alerts on failure', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection, max: 2 });
  try {
    let fail = false;
    const container = { exists: async () => { if (fail) throw Object.assign(new Error('synthetic outage'), { code: 'blob_unavailable' }); return false; } };
    const env = { BB_TRIAL_GUARD: 'off', BB_STORAGE_PURGE_ENABLED: 'false', BB_OPS_STORAGE_INVENTORY: 'off', BB_OPS_LOG_HEALTH: 'off', BB_OPS_TRIAL_HEALTH: 'off', BB_OPS_WORKER_HEARTBEAT: 'off', AZURE_STORAGE_CONNECTION_STRING: 'synthetic', BB_BACKUP_RETENTION_DAYS: '30' } as NodeJS.ProcessEnv;
    const tasks = tasksFromEnv(pool, env, () => noBlobs, () => container as never);
    assert.deepEqual(tasks.map(t => t.name), ['backup_retention']);
    const scheduler = new OpsScheduler({ pool, tasks, owner: 'synthetic-backup', jitter: 0 });
    await scheduler.tick();
    const ok = (await pool.query("SELECT last_status,last_succeeded_at FROM bb_ops_schedule WHERE task='backup_retention'")).rows[0];
    assert.equal(ok.last_status, 'succeeded');
    assert.ok(ok.last_succeeded_at instanceof Date);
    fail = true;
    await pool.query("UPDATE bb_ops_schedule SET next_due_at=now() WHERE task='backup_retention'");
    await scheduler.tick();
    const row = (await pool.query("SELECT last_status,last_error_code,last_succeeded_at FROM bb_ops_schedule WHERE task='backup_retention'")).rows[0];
    assert.equal(row.last_status, 'failed');
    assert.equal(row.last_error_code, 'blob_unavailable');
    assert.equal(row.last_succeeded_at.getTime(), ok.last_succeeded_at.getTime(), 'a failure keeps the last success time');
    const alerts = (await pool.query("SELECT count(*)::int n FROM bb_ops_alerts WHERE kind='scheduled_task_failed' AND detail->>'task'='backup_retention'")).rows[0];
    assert.equal(alerts.n, 1);
    assert.throws(() => tasksFromEnv(pool, { ...env, BB_BACKUP_RETENTION_DAYS: '0' }), /BB_BACKUP_RETENTION_DAYS/);
  } finally { await pool.end(); }
});
