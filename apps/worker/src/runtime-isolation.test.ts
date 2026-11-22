import { emptyUpdateDetails } from '@bondbuddy/contracts';
// Synthetic scheduling and readiness only. No supplier calls or customer material.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { type PrivateBlobs } from '@bondbuddy/api/data';
import { claim, renew, action, pausedRuns, type RunKind } from '@bondbuddy/api/queue';
import { readiness, recordWorkerHeartbeat, workerGroupsFromEnv } from '@bondbuddy/api/trial-guard';
import { WorkerRuntime, workerRuntimeOptionsFromEnv } from './runtime.js';
import {
  uploadSyntheticReference,
  uploadSyntheticAudit,
} from '@bondbuddy/api/test-authoring-source';
import { isolatedTestDatabase } from './test-database.js';

const connection = await isolatedTestDatabase('BB_TEST_RUNTIME_DATABASE_URL', 'worker-isolation');
const waitFor = async (check: () => Promise<boolean>) => {
  const end = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Synthetic worker did not progress');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
};

test('worker filters reject invalid configuration and isolate review assistants', () => {
  const pool = {} as Pool,
    blobs = {} as PrivateBlobs;
  for (const value of ['', 'update,', 'review,review', 'bogus', 'parse'])
    assert.throws(
      () =>
        workerRuntimeOptionsFromEnv(pool, blobs, {
          BB_WORKER_JOB_KINDS: 'run',
          BB_WORKER_RUN_KINDS: value,
        }),
      /run kinds/,
    );
  const opts = workerRuntimeOptionsFromEnv(pool, blobs, {
    BB_WORKER_JOB_KINDS: 'run',
    BB_WORKER_RUN_KINDS: 'update,generation,qa',
    BB_WORKER_GROUP: 'authoring',
  });
  assert.deepEqual(opts.runKinds, ['update', 'generation', 'qa']);
  assert.equal(opts.reviewAssistant, undefined);
  assert.match(opts.workerId!, /^authoring_[A-Za-z0-9_-]+$/);
  assert.ok(
    workerRuntimeOptionsFromEnv(pool, blobs, {
      BB_WORKER_JOB_KINDS: 'run',
      BB_WORKER_RUN_KINDS: 'review',
    }).reviewAssistant,
  );
  assert.equal(
    workerRuntimeOptionsFromEnv(pool, blobs, {
      BB_WORKER_JOB_KINDS: 'parse',
      BB_PARSE_CACHE_OCR_VERSION: 'synthetic-ocr',
      BB_PARSE_CACHE_BASIS_VERSION: 'synthetic-basis',
    }).reviewAssistant,
    undefined,
  );
  assert.throws(
    () => workerGroupsFromEnv({ BB_READY_WORKER_GROUPS: 'authoring,,review' }),
    /BB_READY_WORKER_GROUPS/,
  );
  assert.throws(
    () => workerGroupsFromEnv({ BB_READY_WORKER_GROUPS: 'review,review' }),
    /BB_READY_WORKER_GROUPS/,
  );
  assert.deepEqual(workerGroupsFromEnv({}), []);
});

test(
  'long review reserves only review capacity; updates run, claims are fenced and recovery stays in its group',
  { skip: !connection },
  async () => {
    const pool = new Pool({ connectionString: connection, max: 12 });
    const owner = `isolation-${randomUUID()}`,
      origin = 'http://bondbuddy.test';
    const objects = new Map<string, Buffer>();
    const blobs: PrivateBlobs = {
      put: async (k, b) => {
        objects.set(k, b);
      },
      get: async (k) => objects.get(k)!,
      getIfExists: async (k) => objects.get(k) ?? null,
      getIfExistsBounded: async (k) => objects.get(k) ?? null,
      exists: async (k) => objects.has(k),
      delete: async (k) => {
        objects.delete(k);
      },
    };
    const app = createServer({
      pool,
      blobs,
      historicalBillingFixture: true,
      allowedOrigin: origin,
      principal: async () => ({ userId: owner, csrfVerified: true }),
      enableSyntheticQueue: true,
    });
    const send = (method: string, url: string, payload?: unknown) =>
      app.inject({ method: method as any, url, headers: { origin }, payload: payload as any });
    const submit = async (kind: RunKind) => {
      const p = await send('POST', '/api/v1/projects', {
        name: 'Synthetic isolation',
        kind: 'update',
        issuer_name: 'Synthetic issuer',
        market: 'sse',
        offering: 'private',
        update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1' },
      });
      assert.equal(p.statusCode, 201, p.body);
      const source = await uploadSyntheticReference(app, p.json().project_id),
        audit = await uploadSyntheticAudit(app, p.json().project_id);
      const input = await send('POST', `/api/v1/projects/${p.json().project_id}/input-revisions`, {
        ...source,
        material_versions: [...source.material_versions, audit],
      });
      assert.equal(input.statusCode, 201, input.body);
      const response = await send('POST', '/api/v1/runs/execute', {
        execution_request_id: randomUUID(),
        project_id: p.json().project_id,
        input_revision: 1,
        input_hash: input.json().input_hash,
        task_kind: 'update',
        input_manifest_ref: 'synthetic',
        storage_origin: 'cloud',
        workspace_id: 'synthetic',
      });
      assert.equal(response.statusCode, 202, response.body);
      const id = response.json().run_id as string;
      // This fixture exercises the queue, independently of the business review-input gate.
      await pool.query('UPDATE bb_runs SET task_kind=$2 WHERE id=$1', [id, kind]);
      await pool.query('UPDATE bb_jobs SET job_type=$2 WHERE run_id=$1', [id, kind]);
      return id;
    };
    const blocked = gate(),
      updateBlocked = gate();
    const seen: string[] = [];
    let review: WorkerRuntime | undefined, update: WorkerRuntime | undefined;
    try {
      const r1 = await submit('review'),
        r2 = await submit('review'),
        u1 = await submit('update');
      const options = {
        pool,
        blobs: {} as PrivateBlobs,
        kinds: ['run'] as ('run' | 'parse')[],
        concurrency: 1,
        parseSlots: 0,
        pollMs: 50,
        sweepMs: 60000,
        heartbeatMs: 1000,
        drainMs: 1000,
      };
      review = new WorkerRuntime({
        ...options,
        runKinds: ['review'],
        runStages: [
          {
            name: 'input_lock',
            run: async (ctx) => {
              seen.push(ctx.lease.runId);
              await blocked.promise;
              return { kind: 'pause', stage: 'capability_not_ready', reason: 'synthetic_done' };
            },
          },
        ],
      }).start();
      await waitFor(async () => seen.includes(r1));
      update = new WorkerRuntime({
        ...options,
        runKinds: ['update'],
        runStages: [
          {
            name: 'input_lock',
            run: async (ctx) => {
              seen.push(ctx.lease.runId);
              await updateBlocked.promise;
              return { kind: 'pause', stage: 'capability_not_ready', reason: 'synthetic_done' };
            },
          },
        ],
      }).start();
      await waitFor(async () => seen.includes(u1));
      assert.deepEqual(seen, [r1, u1], 'older queued review cannot take the authoring slot');
      assert.equal(
        await claim(pool, 30, { runKinds: ['update'] }),
        null,
        'no double claim of the running update',
      );
      assert.equal(
        (await pool.query('SELECT state FROM bb_jobs WHERE run_id=$1', [r2])).rows[0].state,
        'queued',
      );
      updateBlocked.release();
      blocked.release();
      await waitFor(
        async () =>
          (
            await pool.query(
              "SELECT count(*)::int n FROM bb_jobs WHERE owner_user_id=$1 AND state='paused'",
              [owner],
            )
          ).rows[0].n === 3,
      );
      await update.stop();
      await review.stop();
      assert.deepEqual(
        (await pausedRuns(pool, 'capability_not_ready', 20, ['update'])).map((r) => r.run_id),
        [u1],
      );
      const u2 = await submit('update');
      const leases = await Promise.all(
        Array.from({ length: 6 }, () => claim(pool, 30, { runKinds: ['update'] })),
      );
      const leased = leases.filter((v) => v !== null);
      assert.equal(leased.length, 1);
      assert.equal(leased[0]!.runId, u2);
      await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE run_id=$1", [
        u2,
      ]);
      assert.equal(
        await claim(pool, 30, { runKinds: ['review'] }),
        null,
        'other group cannot recover an expired update lease',
      );
      const recovered = await claim(pool, 30, { runKinds: ['update'] });
      assert.ok(recovered);
      assert.equal(recovered.runId, u2);
      assert.notEqual(recovered.token, leased[0]!.token);
      await assert.rejects(renew(pool, leased[0]!), /Lease/);
      await action(pool, owner, u2, 'cancel');
      await assert.rejects(renew(pool, recovered), /Lease/);
      assert.equal(
        await claim(pool, 30, { runKinds: ['update'] }),
        null,
        'cancelled run cannot be reclaimed',
      );
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
      blocked.release();
      updateBlocked.release();
      await update?.stop();
      await review?.stop();
      await app.close();
      await pool.end();
    }
  },
);

test(
  'readiness requires fresh authoring, review and parsing groups independently',
  { skip: !connection },
  async () => {
    const pool = new Pool({ connectionString: connection });
    const options = {
      heartbeatMaxAgeSeconds: 90,
      timeoutMs: 2000,
      workerGroups: ['authoring', 'review', 'parse'],
    };
    const check = async () =>
      (await readiness(pool, { exists: async () => true } as unknown as PrivateBlobs, options))
        .checks.worker_heartbeat;
    const beat = async (group: string) =>
      recordWorkerHeartbeat(pool, {
        workerId: `${group}_synthetic`,
        startedAt: new Date(),
        kinds: ['run'],
        concurrency: 1,
      });
    try {
      await beat('authoring');
      await beat('parse');
      assert.equal(
        await check(),
        'missing',
        'healthy update/parser must not hide a missing review process',
      );
      await beat('review');
      assert.equal(await check(), 'ok');
      await pool.query(
        "UPDATE bb_worker_heartbeats SET last_seen_at=now()-interval '2 minutes' WHERE worker_id='review_synthetic'",
      );
      assert.equal(await check(), 'stale');
      await beat('review');
      await pool.query(
        "UPDATE bb_worker_heartbeats SET stopped_at=now() WHERE worker_id='review_synthetic'",
      );
      assert.equal(await check(), 'missing');
      await beat('review');
      assert.equal(await check(), 'ok');
    } finally {
      await pool.end();
    }
  },
);
