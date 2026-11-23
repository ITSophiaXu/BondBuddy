import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { PrivateBlobs } from '@bondbuddy/api/data';
import { flushPerformanceTraces } from '@bondbuddy/api/performance-trace';
import { WorkerRuntime } from './runtime.js';
import { isolatedTestDatabase } from './test-database.js';

const connection = await isolatedTestDatabase('BB_TEST_RUNTIME_DATABASE_URL', 'worker-diagnostics');
const until = async (check: () => boolean | Promise<boolean>) => {
  const end = Date.now() + 15000;
  while (!await check()) {
    if (Date.now() > end) throw new Error('Synthetic diagnostics did not settle');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

test('job logs and persisted performance sessions identify the exact Worker without leaking public fields',
  { skip: !connection, timeout: 30000 }, async () => {
  const pool = new Pool({ connectionString: connection, max: 12 });
  const owner = `synthetic-${randomUUID()}`, project = randomUUID(), hash = 'a'.repeat(64);
  const diagnostics: Record<string, unknown>[] = [];
  const workers: WorkerRuntime[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  try {
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, `synthetic_${randomUUID().slice(0, 8)}`]);
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic diagnostics','update')", [project, owner]);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,'{}','[]','[]')`, [project, owner, hash]);
    const expected = new Map<string, string>();
    for (const kind of ['update', 'review'] as const) {
      const run = randomUUID(), job = randomUUID(), workerId = `synthetic-${kind}`;
      expected.set(run, workerId);
      await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
        VALUES($1,$2,$3,1,$4,$1,$5,$4,'queued','queued')`, [run, owner, project, hash, kind]);
      await pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage) VALUES($1,$2,$3,$4,'update_pipeline_v1','queued','queued')",
        [job, owner, run, kind]);
      workers.push(new WorkerRuntime({
        pool, blobs: {} as PrivateBlobs, kinds: ['run'], runKinds: [kind], concurrency: 1, interactiveSlots: 0,
        pollMs: 50, sweepMs: 60000, heartbeatMs: 1000, workerId, resourceLogEnabled: true,
        executionNode: { server_id: `synthetic-server-${kind}`, server_name: 'synthetic-vm', cloud_provider: 'local', execution_host_id: hash },
        log: event => diagnostics.push(event),
        runStages: [{ name: 'input_lock', run: async () => {
          await blocked;
          return { kind: 'pause', stage: 'capability_not_ready', reason: 'synthetic_done' };
        } }],
      }).start());
    }
    await until(() => diagnostics.filter(event => event.kind === 'job_stage_started').length === 2);
    await until(() => diagnostics.some(event => event.kind === 'worker_resources' && event.status === 'sampled'));
    release();
    await until(() => diagnostics.filter(event => event.kind === 'job_execution_finished').length === 2);
    for (const worker of workers) await worker.stop();
    await flushPerformanceTraces(pool, 5000);
    for (const [run, workerId] of expected) {
      const claim = diagnostics.find(event => event.kind === 'job_claimed' && event.run_id === run);
      const stage = diagnostics.find(event => event.kind === 'job_stage_started' && event.run_id === run);
      const end = diagnostics.find(event => event.kind === 'job_execution_finished' && event.run_id === run);
      assert.ok(claim && stage && end);
      assert.equal(claim.owner_user_id, owner);
      assert.equal(claim.worker_id, workerId);
      assert.equal(stage.execution_id, claim.execution_id);
      assert.equal(end.execution_id, claim.execution_id);
      assert.equal(end.outcome, 'paused');
      assert.ok(Number(end.elapsed_ms) >= 0);
      assert.equal('token' in claim, false);
      assert.equal('lease_token' in claim, false);
      const sessions = (await pool.query('SELECT worker_instance_id FROM bb_performance_sessions WHERE run_id=$1', [run])).rows;
      assert.ok(sessions.some(row => row.worker_instance_id === workerId));
    }
    const publicEvents = (await pool.query('SELECT payload FROM bb_run_events WHERE owner_user_id=$1', [owner])).rows;
    assert.equal(JSON.stringify(publicEvents).includes('synthetic-server'), false);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_jobs WHERE owner_user_id=$1 AND state='running'", [owner])).rows[0].n, 0);
  } finally {
    release();
    for (const worker of workers) await worker.stop();
    await pool.end();
  }
});
