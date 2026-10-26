// Real isolated PostgreSQL, exact synthetic test grants and owned DOCX bytes.
// The hook pauses after a real query result; no SQL result is fabricated.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { Problem, uid } from './data.js';
import { isolatedTestDatabase } from './test-database.js';
import { createRunSupplementFilePreparationFixture } from './run-supplement-file-preparation-test-fixture.js';
import { grantSyntheticSupplementInput } from './run-supplement-preparation-test-fixture.js';
import { loadRunSupplementProcessingBasis } from './run-supplement-preparation.js';
import { createRunSupplementProcessingPlan } from './run-supplement-processing-plan.js';
import { adoptRunSupplementTestInput, stageRunSupplementTestInput } from './run-supplement-test-adoption.js';

const connection = await isolatedTestDatabase(undefined, 'run-test-successor-adoption-race');
const previousTier = process.env.BB_DEPLOYMENT_TIER, previousChannel = process.env.BB_NON_PRODUCTION_TEST_CHANNEL;
before(() => { process.env.BB_DEPLOYMENT_TIER = 'preprod'; process.env.BB_NON_PRODUCTION_TEST_CHANNEL = 'enabled'; });
after(() => {
  if (previousTier === undefined) delete process.env.BB_DEPLOYMENT_TIER; else process.env.BB_DEPLOYMENT_TIER = previousTier;
  if (previousChannel === undefined) delete process.env.BB_NON_PRODUCTION_TEST_CHANNEL; else process.env.BB_NON_PRODUCTION_TEST_CHANNEL = previousChannel;
});

async function bounded<T>(pending: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(description)), 10000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Transactions receive a real client proxy. Pool.query's callback checkout and
 * the second connection retain their normal implementation and query results. */
function pauseAfterGrantRead(pool: Pool, grantId: string) {
  const original = pool.connect, connect = pool.connect.bind(pool);
  let reached!: () => void, resume!: () => void, paused = false;
  const atBoundary = new Promise<void>(resolve => { reached = resolve; });
  const released = new Promise<void>(resolve => { resume = resolve; });
  pool.connect = ((callback?: any) => {
    if (callback) return connect(callback);
    return connect().then(client => new Proxy(client, {
      get(target, property) {
        if (property === 'query') return async (...args: any[]) => {
          const result = await (target.query as any).apply(target, args);
          const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
          const values = Array.isArray(args[1]) ? args[1] : args[0]?.values;
          if (!paused && typeof sql === 'string'
            && /SELECT grant_id FROM bb_non_production_test_grants WHERE grant_id=\$1 FOR SHARE/.test(sql)
            && values?.[0] === grantId) {
            paused = true; reached(); await released;
          }
          return result;
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }));
  }) as Pool['connect'];
  return { atBoundary, resume, restore: () => { pool.connect = original; } };
}

async function authority(pool: Pool, runId: string, jobId: string) {
  return (await pool.query(`SELECT
    (SELECT to_jsonb(h) FROM bb_run_execution_heads h WHERE h.run_id=$1) AS head,
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY execution_version) FROM bb_run_execution_versions e WHERE e.run_id=$1) AS versions,
    (SELECT to_jsonb(r) FROM bb_runs r WHERE r.id=$1) AS run,
    (SELECT to_jsonb(j) FROM bb_jobs j WHERE j.id=$2) AS job,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM bb_run_test_successor_authorizations a WHERE a.run_id=$1) AS receipts,
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY execution_version) FROM bb_m4_execution_snapshots s WHERE s.run_id=$1) AS snapshots,
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY seq) FROM bb_run_events e WHERE e.run_id=$1) AS events,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM bb_outbox o WHERE o.aggregate_type='run' AND o.aggregate_id=$1) AS outbox`,
  [runId, jobId])).rows[0];
}

for (const removed of ['material', 'source_project'] as const) {
  test(`M4 adoption rejects a cross-project ${removed} soft deletion committed after its final basis recheck`,
    { skip: !connection, timeout: 120000 }, async () => {
      const f = await createRunSupplementFilePreparationFixture(connection!, 'm4', { nonProduction: true });
      let deleting: PoolClient | undefined, hook: ReturnType<typeof pauseAfterGrantRead> | undefined;
      let outcome: Promise<{ value?: unknown; error?: unknown }> | undefined;
      let deletionOpen = false;
      try {
        const kind = 'm4' as const;
        const basis = await loadRunSupplementProcessingBasis(f.preparationInput, kind);
        const plan = await createRunSupplementProcessingPlan({ ...f.preparationInput, kind,
          requestId: uid(), expectedBasisHash: basis.basisHash });
        const input = { ...f.preparationInput, kind, planId: plan.id, expectedPlanHash: plan.planHash };
        const target = await stageRunSupplementTestInput(input);
        const grantId = await grantSyntheticSupplementInput(f.pool, f.owner, f.projectId, target.inputRevision, target.inputHash);
        const beforeState = await authority(f.pool, f.runId, f.jobId);
        assert.ok(f.sourceProject); assert.notEqual(f.sourceProject, f.projectId);
        assert.equal(f.first.source_project_id, f.sourceProject);
        deleting = await f.pool.connect();
        hook = pauseAfterGrantRead(f.pool, grantId);
        outcome = adoptRunSupplementTestInput({ ...input, requestId: uid(), targetInputRevision: target.inputRevision,
          testGrantId: grantId }).then(value => ({ value }), error => ({ error }));
        await bounded(Promise.race([hook.atBoundary, outcome.then(result => {
          throw new Error('Adoption returned before the final grant-read boundary', { cause: result.error });
        })]), 'Adoption did not reach the final grant-read boundary');

        // This is a separate PostgreSQL transaction, committed while adoption
        // still holds its own target project/run/job and exact grant locks.
        await deleting.query('BEGIN');
        deletionOpen = true;
        await deleting.query("SET LOCAL statement_timeout='5s'");
        const changed = removed === 'material'
          ? await deleting.query(`UPDATE bb_material_versions SET deleted_at=now()
              WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL`,
            [f.owner, f.sourceProject, f.first.material_id, f.first.material_version])
          : await deleting.query(`UPDATE bb_projects SET deleted_at=now()
              WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL`, [f.owner, f.sourceProject]);
        assert.equal(changed.rowCount, 1);
        await deleting.query('COMMIT');
        deletionOpen = false;
        hook.resume();
        const result = await bounded(outcome, 'Adoption did not finish after the committed deletion');
        assert.ok(result.error instanceof Problem, `Expected input conflict; got ${String(result.error ?? result.value)}`);
        assert.equal(result.error.status, 409);
        assert.equal(result.error.code, 'INPUT_REVISION_CONFLICT');
        assert.deepEqual(await authority(f.pool, f.runId, f.jobId), beforeState,
          'Rejected adoption must leave the original input/grant, V1 head, snapshots, checkpoint, events and receipts unchanged');
        assert.equal(beforeState.versions.length, 1); assert.equal(beforeState.head.execution_version, 1);
        assert.equal(beforeState.receipts, null);
      } finally {
        hook?.resume(); hook?.restore();
        try {
          if (deleting) {
            try { if (deletionOpen) await deleting.query('ROLLBACK'); } finally { deleting.release(); }
          }
          if (outcome) await bounded(outcome, 'Adoption remained active during cleanup');
        } finally { await f.cleanup(); }
      }
    });
}
