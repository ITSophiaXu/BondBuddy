import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { Problem, uid } from './data.js';
import { isolatedTestDatabase } from './test-database.js';
import { createRunSupplementPreparationFixture, grantSyntheticSupplementInput } from './run-supplement-preparation-test-fixture.js';
import { createRunSupplementFilePreparationFixture } from './run-supplement-file-preparation-test-fixture.js';
import { loadRunSupplementProcessingBasis, type RunSupplementProcessingKind } from './run-supplement-preparation.js';
import { createRunSupplementProcessingPlan } from './run-supplement-processing-plan.js';
import { stageRunSupplementTestInput, adoptRunSupplementTestInput } from './run-supplement-test-adoption.js';
import { readRunExecutionInput } from './run-execution-input.js';
import { readAdoptedRunSupplementExecution, readAdoptedRunSupplementFile } from './run-supplement-execution.js';
import { checkpointStage, claim, recordPotentialCall } from './queue.js';
import { savePromptSnapshot } from './log-ops.js';

const database = await isolatedTestDatabase(undefined, 'run-supplement-execution');
const previous = { tier: process.env.BB_DEPLOYMENT_TIER, channel: process.env.BB_NON_PRODUCTION_TEST_CHANNEL };
before(() => { process.env.BB_DEPLOYMENT_TIER = 'preprod'; process.env.BB_NON_PRODUCTION_TEST_CHANNEL = 'enabled'; });
after(() => {
  if (previous.tier === undefined) delete process.env.BB_DEPLOYMENT_TIER; else process.env.BB_DEPLOYMENT_TIER = previous.tier;
  if (previous.channel === undefined) delete process.env.BB_NON_PRODUCTION_TEST_CHANNEL; else process.env.BB_NON_PRODUCTION_TEST_CHANNEL = previous.channel;
});
const denied = (error: unknown) => error instanceof Problem && error.status === 409;
async function fixture(kind: RunSupplementProcessingKind, early?: 'before_prompt' | 'after_prompt') {
  if (kind === 'authoring') return early
    ? createRunSupplementPreparationFixture(database!, { nonProduction: true, earlyPause: early })
    : createRunSupplementPreparationFixture(database!, { nonProduction: true });
  return early ? createRunSupplementFilePreparationFixture(database!, kind, { nonProduction: true, earlyPause: early })
    : createRunSupplementFilePreparationFixture(database!, kind, { nonProduction: true });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function adopt(f: Fixture, kind: RunSupplementProcessingKind) {
  const basis = await loadRunSupplementProcessingBasis(f.preparationInput, kind);
  const plan = await createRunSupplementProcessingPlan({ ...f.preparationInput, kind, requestId: uid(), expectedBasisHash: basis.basisHash });
  const prepared = { ...f.preparationInput, kind, planId: plan.id, expectedPlanHash: plan.planHash };
  const target = await stageRunSupplementTestInput(prepared);
  const testGrantId = await grantSyntheticSupplementInput(f.pool, f.owner, f.projectId, target.inputRevision, target.inputHash);
  const adoption = await adoptRunSupplementTestInput({ ...prepared, requestId: uid(), targetInputRevision: target.inputRevision, testGrantId });
  const lease = await claim(f.pool, 300, { runKinds: [kind === 'authoring' ? 'update' : kind === 'review' ? 'review' : 'generation'] });
  assert.ok(lease); assert.equal(lease.runId, f.runId);
  return { basis, plan, adoption, lease, input: { pool: f.pool, blobs: f.blobs, lease, kind } };
}

for (const kind of ['authoring', 'review', 'm4'] as const) {
  test(`${kind}: successor lease reconstructs the exact adopted basis and only its captured files`, { skip: !database, timeout: 120000 }, async () => {
    const f = await fixture(kind);
    try {
      const { basis, plan, adoption, lease, input } = await adopt(f, kind);
      const before = await f.snapshot();
      const resumed = await readAdoptedRunSupplementExecution(input);
      assert.deepEqual(resumed.basis, basis);
      assert.deepEqual(resumed.plan, plan);
      assert.deepEqual(resumed.adoption, adoption);
      assert.deepEqual(resumed.source.checkpoint, f.checkpoint);
      assert.equal(resumed.source.run.executionVersion, 1);
      assert.equal(resumed.source.input.input_hash.trim(), f.hash);
      assert.ok(basis.priorWork);
      for (const pin of basis.priorWork.files) {
        const bytes = await readAdoptedRunSupplementFile({ ...input, pin });
        assert.deepEqual(bytes, f.objects.get(pin.key));
      }
      assert.deepEqual(await f.snapshot(), before, 'historical reads cannot mutate accounting, checkpoints or storage');
      await assert.rejects(readRunExecutionInput(f.pool, f.owner, f.runId, basis.sourceExecution), denied);
      await assert.rejects(readAdoptedRunSupplementExecution({ ...input, lease: { ...lease, token: uid() } }), denied);
      await assert.rejects(readAdoptedRunSupplementExecution({ ...input, lease: { ...lease, ...basis.sourceExecution } }), denied);
      await assert.rejects(readAdoptedRunSupplementFile({ ...input, pin: { ...basis.priorWork.files[0], sha256: 'a'.repeat(64) } }), denied);
      await assert.rejects(readAdoptedRunSupplementExecution({ ...input, kind: kind === 'review' ? 'authoring' : 'review' }), denied);
      await checkpointStage(f.pool, lease, 'resumed_input_checked', { synthetic: true });
      assert.deepEqual((await readAdoptedRunSupplementExecution(input)).basis, basis, 'new V2 stages do not alter the historical basis');
    } finally { await f.cleanup(); }
  });

  for (const early of ['before_prompt', 'after_prompt'] as const) {
    test(`${kind}: ${early} receipt remains no-prior-work after new successor stages`, { skip: !database, timeout: 120000 }, async () => {
      const f = await fixture(kind, early);
      try {
        const { basis, lease, input } = await adopt(f, kind);
        assert.equal(basis.priorWorkStatus, 'no_prior_work');
        assert.deepEqual((await readAdoptedRunSupplementExecution(input)).basis, basis);
        await checkpointStage(f.pool, lease, 'resumed_input_checked', { synthetic: true });
        assert.deepEqual((await readAdoptedRunSupplementExecution(input)).basis, basis);
      } finally { await f.cleanup(); }
    });
  }
}

test('revoked successor permission cannot be replaced with the original grant, including revocation during file I/O',
  { skip: !database, timeout: 120000 }, async () => {
    const f = await fixture('authoring');
    try {
      const { basis, adoption, input } = await adopt(f, 'authoring');
      assert.ok(basis.priorWork);
      const pin = basis.priorWork.files[0];
      let revoked = false;
      const blobs = { ...f.blobs, getIfExistsBounded: async (key: string, max: number) => {
        const bytes = await f.blobs.getIfExistsBounded(key, max);
        if (key === pin.key && !revoked) {
          revoked = true;
          await f.pool.query(`UPDATE bb_non_production_test_grants SET revoked_at=now(),revoked_by='synthetic_fixture',
            revoked_reason='Revoke while reading a captured file' WHERE grant_id=$1`, [adoption.testGrantId]);
        }
        return bytes;
      } };
      await assert.rejects(readAdoptedRunSupplementFile({ ...input, blobs, pin }), { code: 'TEST_GRANT_REVOKED' });
      assert.equal(revoked, true);
      await assert.rejects(readAdoptedRunSupplementExecution(input), { code: 'TEST_GRANT_REVOKED' });
      assert.notEqual((await f.pool.query('SELECT test_grant_id FROM bb_runs WHERE id=$1', [f.runId])).rows[0].test_grant_id, adoption.testGrantId);
    } finally { await f.cleanup(); }
  });

test('candidate material deletion committed during byte I/O rejects the reconstructed basis', { skip: !database, timeout: 120000 }, async () => {
  const f = await fixture('authoring', 'before_prompt');
  try {
    const { input, basis } = await adopt(f, 'authoring');
    const added = basis.materials.find(value => value.pin.material_id === f.added.material_id)!;
    let deleted = false;
    const blobs = { ...f.blobs, getIfExistsBounded: async (key: string, max: number) => {
      const bytes = await f.blobs.getIfExistsBounded(key, max);
      if (key === added.objectKey && !deleted) {
        deleted = true;
        await f.pool.query('UPDATE bb_material_versions SET deleted_at=now() WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4',
          [f.owner, f.projectId, added.pin.material_id, added.pin.material_version]);
      }
      return bytes;
    } };
    await assert.rejects(readAdoptedRunSupplementExecution({ ...input, blobs }), denied);
    assert.equal(deleted, true);
    assert.equal((await f.pool.query('SELECT execution_version FROM bb_run_execution_heads WHERE run_id=$1', [f.runId])).rows[0].execution_version, 2);
  } finally { await f.cleanup(); }
});

test('missing or changed retained Word bytes reject source reuse without a model retry or new ledger writes', { skip: !database, timeout: 120000 }, async () => {
  const f = await fixture('review');
  try {
    const { basis, input } = await adopt(f, 'review');
    assert.ok(basis.priorWork);
    const pin = basis.priorWork.files[0], original = f.objects.get(pin.key)!;
    f.objects.set(pin.key, Buffer.from('changed retained bytes'));
    const before = await f.snapshot();
    await assert.rejects(readAdoptedRunSupplementExecution(input), denied);
    await assert.rejects(readAdoptedRunSupplementFile({ ...input, pin }), denied);
    assert.deepEqual(await f.snapshot(), before);
    f.objects.set(pin.key, original);
    assert.deepEqual((await readAdoptedRunSupplementExecution(input)).basis, basis);
  } finally { await f.cleanup(); }
});

test('a successor lease that expires during retained file I/O cannot release the old bytes', { skip: !database, timeout: 120000 }, async () => {
  const f = await fixture('authoring');
  try {
    const { basis, input } = await adopt(f, 'authoring');
    assert.ok(basis.priorWork);
    const pin = basis.priorWork.files[0];
    let expired = false;
    const blobs = { ...f.blobs, getIfExistsBounded: async (key: string, max: number) => {
      const bytes = await f.blobs.getIfExistsBounded(key, max);
      if (key === pin.key && !expired) {
        expired = true;
        await f.pool.query("UPDATE bb_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [input.lease.jobId]);
      }
      return bytes;
    } };
    await assert.rejects(readAdoptedRunSupplementFile({ ...input, blobs, pin }), denied);
    assert.equal(expired, true);
  } finally {
    // This file shares one isolated clone. Do not leave an expired runnable job
    // for the next fixture's real queue claim to reclaim.
    await f.pool.query("UPDATE bb_jobs SET lease_until=clock_timestamp()+interval '10 minutes' WHERE id=$1 AND state='running'", [f.jobId]);
    await f.cleanup();
  }
});

test('new V2 prompt and attempt carry explicit authority while an old writer cannot borrow the new input', { skip: !database, timeout: 120000 }, async () => {
  const f = await fixture('authoring', 'before_prompt');
  try {
    const { basis, input, lease } = await adopt(f, 'authoring');
    const version = Number((await f.pool.query("SELECT COALESCE(max(version),0)+1 AS next FROM bb_snapshot_refs WHERE owner_user_id=$1 AND project_id=$2 AND snapshot_kind='model_request'",
      [f.owner, f.projectId])).rows[0].next);
    const prompt = { owner: f.owner, projectId: f.projectId, runId: f.runId, kind: 'model_request' as const,
      version, body: 'Synthetic exact successor prompt', inputRevision: lease.inputRevision, inputHash: lease.inputHash };
    const before = new Set(f.objects.keys());
    await assert.rejects(savePromptSnapshot(f.pool, f.blobs, prompt), denied);
    assert.deepEqual(new Set(f.objects.keys()), before, 'a late V1 writer fails before storing prompt bytes');
    const snapshotId = await savePromptSnapshot(f.pool, f.blobs, { ...prompt, executionVersion: 2 });
    const attempt = await recordPotentialCall(f.pool, lease, 'file-authoring-v1', 1,
      { modelId: 'synthetic-successor', promptSnapshotId: snapshotId });
    assert.ok(attempt);
    const binding = (await f.pool.query('SELECT execution_version,input_revision,input_hash FROM bb_model_call_execution_bindings WHERE attempt_id=$1', [attempt])).rows[0];
    assert.deepEqual({ ...binding, input_hash: binding.input_hash.trim() }, { execution_version: 2,
      input_revision: lease.inputRevision, input_hash: lease.inputHash });
    assert.deepEqual((await readAdoptedRunSupplementExecution(input)).basis, basis,
      'a new execution attempt does not manufacture prior work at its historical source');
  } finally { await f.cleanup(); }
});
