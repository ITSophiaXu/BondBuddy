import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { PrivateBlobs } from '@bondbuddy/api/data';
import { WorkerRuntime } from './runtime.js';
import { isolatedTestDatabase } from './test-database.js';

// #35: the worker upserts one heartbeat row while running and marks it stopped on shutdown.
// Synthetic only; no jobs, blobs or providers are touched.
const connection = await isolatedTestDatabase('BB_TEST_RUNTIME_DATABASE_URL');
const noBlobs = new Proxy({}, { get: () => async () => { throw new Error('no blob access expected'); } }) as PrivateBlobs;

test('worker runtime writes a fresh heartbeat and marks it stopped on shutdown', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  try {
    const workerId = 'synthetic-heartbeat-worker';
    const runtime = new WorkerRuntime({ pool, blobs: noBlobs, kinds: ['parse'], concurrency: 1, pollMs: 50, sweepMs: 600000, heartbeatMs: 1000, workerId }).start();
    let row;
    for (let i = 0; i < 50 && !row; i++) { row = (await pool.query('SELECT * FROM bb_worker_heartbeats WHERE worker_id=$1', [workerId])).rows[0]; if (!row) await new Promise(r => setTimeout(r, 50)); }
    assert.ok(row, 'heartbeat row written');
    assert.deepEqual(row.kinds, ['parse']);
    assert.equal(row.concurrency, 1);
    assert.equal(row.stopped_at, null);
    const first = new Date(row.last_seen_at).getTime();
    await new Promise(r => setTimeout(r, 1300));
    const later = (await pool.query('SELECT last_seen_at FROM bb_worker_heartbeats WHERE worker_id=$1', [workerId])).rows[0];
    assert.ok(new Date(later.last_seen_at).getTime() > first, 'heartbeat refreshes');
    await runtime.stop();
    const stopped = (await pool.query('SELECT stopped_at FROM bb_worker_heartbeats WHERE worker_id=$1', [workerId])).rows[0];
    assert.ok(stopped.stopped_at, 'stopped workers do not count as live for readiness');
  } finally { await pool.end(); }
});
