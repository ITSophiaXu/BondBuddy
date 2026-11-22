// Real PostgreSQL queue/leases; synthetic stages, no model or production data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import type { PrivateBlobs } from '@bondbuddy/api/data';
import { WorkerRuntime, workerRuntimeOptionsFromEnv } from './runtime.js';
import { isolatedTestDatabase } from './test-database.js';

const connection = await isolatedTestDatabase('BB_TEST_RUNTIME_DATABASE_URL', 'interactive-slots');
const until = async (check: () => Promise<boolean>) => {
  const end = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > end) throw Error('Interactive queue did not progress');
    await new Promise((r) => setTimeout(r, 25));
  }
};
test('interactive slot configuration is bounded and can be disabled', () => {
  const pool = {} as Pool,
    blobs = {} as PrivateBlobs;
  for (const value of ['-1', '5', '1.5', 'bad'])
    assert.throws(
      () =>
        workerRuntimeOptionsFromEnv(pool, blobs, {
          BB_WORKER_JOB_KINDS: 'run',
          BB_WORKER_INTERACTIVE_SLOTS: value,
        }),
      /INTERACTIVE_SLOTS/,
    );
  assert.equal(
    workerRuntimeOptionsFromEnv(pool, blobs, {
      BB_WORKER_JOB_KINDS: 'run',
      BB_WORKER_INTERACTIVE_SLOTS: '0',
    }).interactiveSlots,
    0,
  );
});

test(
  'long document work cannot monopolize QA, question recognition or consistency checks',
  { skip: !connection, timeout: 30000 },
  async () => {
    const pool = new Pool({ connectionString: connection, max: 12 }),
      owner = randomUUID(),
      origin = 'http://bondbuddy.test';
    const app = createServer({
      pool,
      allowedOrigin: origin,
      principal: async () => ({ userId: owner, csrfVerified: true }),
      enableSyntheticQueue: true,
    });
    const send = (method: string, url: string, payload?: unknown) =>
      app.inject({ method: method as any, url, headers: { origin }, payload: payload as any });
    const submit = async (kind: string, subtype: string) => {
      const p = await send('POST', '/api/v1/projects', {
        name: 'Synthetic queue isolation',
        kind: 'update',
        issuer_name: null,
        market: null,
        offering: null,
      });
      assert.equal(p.statusCode, 201, p.body);
      const id = p.json().project_id;
      const input = await send('POST', `/api/v1/projects/${id}/input-revisions`, {
        draft_revision: 1,
        material_versions: [],
        requirement_message_ids: [],
      });
      assert.equal(input.statusCode, 201, input.body);
      const response = await send('POST', '/api/v1/runs/execute', {
        execution_request_id: randomUUID(),
        project_id: id,
        input_revision: 1,
        input_hash: input.json().input_hash,
        task_kind: 'update',
        input_manifest_ref: 'synthetic',
        storage_origin: 'cloud',
        workspace_id: 'synthetic',
      });
      assert.equal(response.statusCode, 202, response.body);
      const run = response.json().run_id;
      await pool.query('UPDATE bb_runs SET task_kind=$2 WHERE id=$1', [run, kind]);
      await pool.query('UPDATE bb_jobs SET job_type=$2,subtype=$3 WHERE run_id=$1', [
        run,
        kind,
        subtype,
      ]);
      return run;
    };
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    let worker: WorkerRuntime | undefined;
    try {
      const long = await submit('update', 'default'),
        nextLong = await submit('update', 'default');
      worker = new WorkerRuntime({
        pool,
        blobs: {} as PrivateBlobs,
        kinds: ['run'],
        runKinds: ['update', 'generation', 'qa'],
        concurrency: 1,
        interactiveSlots: 1,
        parseSlots: 0,
        pollMs: 25,
        sweepMs: 60000,
        heartbeatMs: 1000,
        drainMs: 1000,
        runStages: [
          {
            name: 'input_lock',
            run: async (ctx) => {
              seen.push(ctx.run.id);
              if (ctx.run.id === long) await blocked;
              return { kind: 'pause', stage: 'capability_not_ready', reason: 'synthetic_done' };
            },
          },
        ],
      }).start();
      await until(async () => seen.includes(long));
      const interactive: string[] = [];
      for (const [kind, subtype] of [
        ['qa', 'm4_qa_v1'],
        ['generation', 'project_qa_v1'],
        ['generation', 'project_file_v1'],
      ])
        interactive.push(await submit(kind, subtype));
      await until(async () => interactive.every((id) => seen.includes(id)));
      assert.ok(!seen.includes(nextLong), 'reserved slot cannot take another long document');
      assert.equal(new Set(seen).size, seen.length, 'leases prevent duplicate execution');
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM bb_model_call_attempts WHERE owner_user_id=$1',
            [owner],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      release();
      await worker?.stop();
      await app.close();
      await pool.end();
    }
  },
);
