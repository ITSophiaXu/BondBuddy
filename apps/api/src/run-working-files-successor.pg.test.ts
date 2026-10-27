// Real PostgreSQL adoption, exact provider provenance and lifecycle registration.
// Bytes are synthetic private fixtures; no model or external storage is called.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { digest, Problem, uid } from './data.js';
import { isolatedTestDatabase } from './test-database.js';
import { createRunSupplementPreparationFixture, grantSyntheticSupplementInput } from './run-supplement-preparation-test-fixture.js';
import { loadRunSupplementProcessingBasis } from './run-supplement-preparation.js';
import { createRunSupplementProcessingPlan } from './run-supplement-processing-plan.js';
import { stageRunSupplementTestInput, adoptRunSupplementTestInput } from './run-supplement-test-adoption.js';
import { action, claim, recordPotentialCall } from './queue.js';
import { savePromptSnapshot } from './log-ops.js';
import { persistProviderResultObject, recordProviderCallObservation, type ProviderCallIntent } from './provider-results.js';
import { inventoryWorkingFilesForContent, purgeRunWorkingFiles, writeRunWorkingFile } from './run-working-files.js';

const enabled = !!process.env.BB_TEST_DATABASE_URL;
const previous = { tier: process.env.BB_DEPLOYMENT_TIER, channel: process.env.BB_NON_PRODUCTION_TEST_CHANNEL };
before(() => { process.env.BB_DEPLOYMENT_TIER = 'preprod'; process.env.BB_NON_PRODUCTION_TEST_CHANNEL = 'enabled'; });
after(() => {
  if (previous.tier === undefined) delete process.env.BB_DEPLOYMENT_TIER; else process.env.BB_DEPLOYMENT_TIER = previous.tier;
  if (previous.channel === undefined) delete process.env.BB_NON_PRODUCTION_TEST_CHANNEL; else process.env.BB_NON_PRODUCTION_TEST_CHANNEL = previous.channel;
});
const schema = 'codex-file-word-v1', word = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function fixture() {
  const database = await isolatedTestDatabase(undefined, `working-successor-${uid()}`);
  assert.ok(database);
  const f = await createRunSupplementPreparationFixture(database, { nonProduction: true });
  try {
    const basis = await loadRunSupplementProcessingBasis(f.preparationInput, 'authoring');
    const plan = await createRunSupplementProcessingPlan({ ...f.preparationInput, kind: 'authoring', requestId: uid(), expectedBasisHash: basis.basisHash });
    const prepared = { ...f.preparationInput, kind: 'authoring' as const, planId: plan.id, expectedPlanHash: plan.planHash };
    const target = await stageRunSupplementTestInput(prepared);
    const testGrantId = await grantSyntheticSupplementInput(f.pool, f.owner, f.projectId, target.inputRevision, target.inputHash);
    const adoption = await adoptRunSupplementTestInput({ ...prepared, requestId: uid(), targetInputRevision: target.inputRevision, testGrantId });
    const lease = await claim(f.pool, 300, { runKinds: ['update'] });
    assert.ok(lease); assert.equal(lease.runId, f.runId); assert.equal(lease.executionVersion, 2);
    return { ...f, adoption, lease };
  } catch (error) { await f.cleanup(); throw error; }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function successorResult(f: Fixture) {
  const { lease } = f;
  const prompt = await savePromptSnapshot(f.pool, f.blobs, { owner: f.owner, projectId: f.projectId, runId: f.runId,
    kind: 'model_request', version: 3, body: 'Synthetic exact V2 model request', executionVersion: 2,
    inputRevision: lease.inputRevision, inputHash: lease.inputHash });
  const intent: ProviderCallIntent = { owner_user_id: f.owner, project_id: f.projectId, run_id: f.runId,
    trace_id: f.runId, job_id: f.jobId, logical_call_id: 'file-authoring-v1', attempt_no: 2, call_id: uid(),
    model_id: 'synthetic-model', model_config_version: 'synthetic-model-v1', prompt_snapshot_ref: prompt };
  await recordPotentialCall(f.pool, lease, intent.logical_call_id, intent.attempt_no,
    { callId: intent.call_id, modelId: intent.model_id, promptSnapshotId: prompt });
  const files: Record<string, { key: string; sha256: string; byte_size: number }> = {};
  for (const name of ['tracked.docx', 'clean.docx']) {
    const bytes = Buffer.from(`Synthetic successor retained ${name}`), sha256 = digest(bytes);
    const key = `owners/${f.owner}/projects/${f.projectId}/runs/${f.runId}/file-authoring/${intent.call_id}/${sha256}/${name}`;
    await writeRunWorkingFile({ pool: f.pool, blobs: f.blobs, lease, projectId: f.projectId,
      source: { kind: 'provider', attemptId: intent.call_id, resultSchemaVersion: schema }, name, key, bytes, mediaType: word });
    files[name] = { key, sha256, byte_size: bytes.length };
  }
  const value = { version: schema, input_hash: lease.inputHash, files, summary: { authoring_summary: ['Synthetic successor result'] } };
  const validate = (candidate: unknown) => JSON.stringify(candidate) === JSON.stringify(value);
  const reference = await persistProviderResultObject({ blobs: f.blobs, intent, bytes: Buffer.from(JSON.stringify(value)), resultSchemaVersion: schema, validate });
  await recordProviderCallObservation(f.pool, f.blobs, { ...intent, ...reference, provider_request_id: null,
    finish_reason: 'stop', outcome: 'completed', error_code: null,
    usage: { status: 'measured', input_tokens: 3, cached_input_tokens: 0, output_tokens: 2, reasoning_tokens: 0, total_tokens: 5 } },
  validate, { lease, source: 'provider' });
  const result = (await f.pool.query('SELECT * FROM bb_provider_result_refs WHERE attempt_id=$1', [intent.call_id])).rows[0];
  return { intent, result, files };
}

test('historical V1 cleanup discovery remains possible after the same run adopts V2', { skip: !enabled, timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    assert.ok(f.selected);
    const original = f.selected.result;
    assert.deepEqual(await inventoryWorkingFilesForContent(f.pool, f.blobs, { kind: 'provider_result', id: original.id }), [f.runId]);
    const claims = (await f.pool.query(`SELECT * FROM bb_run_working_sources WHERE discovered_result_id=$1 ORDER BY object_key`, [original.id])).rows;
    assert.equal(claims.length, Object.keys(f.selected.files).length);
    for (const claim of claims) {
      assert.equal(claim.execution_version, 1); assert.equal(claim.input_revision, 1);
      assert.equal(claim.input_hash.trim(), f.hash); assert.equal(claim.attempt_id, original.attempt_id);
    }
    const head = (await f.pool.query('SELECT execution_version,input_hash FROM bb_run_execution_heads WHERE run_id=$1', [f.runId])).rows[0];
    assert.equal(head.execution_version, 2); assert.equal(head.input_hash.trim(), f.lease.inputHash);
  } finally { await f.cleanup(); }
});

for (const state of ['revoked', 'project_deleted', 'account_closed'] as const) {
  test(`V2 ${state}: hidden result inventory and cleanup survive while new file writes stay closed`, { skip: !enabled, timeout: 120000 }, async () => {
    const f = await fixture();
    try {
      const { intent, result, files } = await successorResult(f);
      const originalRun = (await f.pool.query('SELECT input_revision,input_hash,test_grant_id FROM bb_runs WHERE id=$1', [f.runId])).rows[0];
      if (state === 'revoked') await f.pool.query(`UPDATE bb_non_production_test_grants SET revoked_at=now(),revoked_by='synthetic_fixture',
        revoked_reason='Lifecycle must retain historical cleanup authority' WHERE grant_id=$1`, [f.adoption.testGrantId]);
      else if (state === 'project_deleted') await f.pool.query('UPDATE bb_projects SET deleted_at=now() WHERE id=$1', [f.projectId]);
      else await f.pool.query("UPDATE bb_users SET status='closed',closed_at=now() WHERE id=$1", [f.owner]);
      const newBytes = Buffer.from('A new unauthorized successor write'), newHash = digest(newBytes);
      const newKey = `owners/${f.owner}/projects/${f.projectId}/runs/${f.runId}/file-authoring/${intent.call_id}/${newHash}/tracked.docx`;
      await assert.rejects(writeRunWorkingFile({ pool: f.pool, blobs: f.blobs, lease: f.lease, projectId: f.projectId,
        source: { kind: 'provider', attemptId: intent.call_id, resultSchemaVersion: schema },
        name: 'tracked.docx', key: newKey, bytes: newBytes, mediaType: word }), error => error instanceof Problem);
      assert.equal(f.objects.has(newKey), false, 'new bytes must not be written after permission is lost');
      assert.deepEqual(await inventoryWorkingFilesForContent(f.pool, f.blobs, { kind: 'provider_result', id: result.id }), [f.runId]);
      const claims = (await f.pool.query('SELECT * FROM bb_run_working_sources WHERE discovered_result_id=$1', [result.id])).rows;
      assert.equal(claims.length, 2);
      for (const claim of claims) {
        assert.equal(claim.execution_version, 2); assert.equal(claim.input_hash.trim(), f.lease.inputHash);
        assert.equal(claim.attempt_id, intent.call_id); assert.equal(claim.input_revision, f.lease.inputRevision);
      }
      assert.deepEqual((await f.pool.query('SELECT input_revision,input_hash,test_grant_id FROM bb_runs WHERE id=$1', [f.runId])).rows[0], originalRun);
      if (state === 'revoked') await action(f.pool, f.owner, f.runId, 'cancel');
      const purged = await purgeRunWorkingFiles(f.pool, f.blobs, { contentRetentionDays: 1, deletedProjectPurgeDays: 0,
        ownerScope: [f.owner], runId: f.runId, batchSize: 64, now: () => new Date('2126-10-26T00:00:00Z') });
      assert.equal(purged.failed, 0); assert.equal(purged.pending, false);
      assert.ok(purged.purged >= 2);
      for (const file of Object.values(files)) assert.equal(f.objects.has(file.key), false);
      assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM bb_provider_result_refs WHERE id=$1', [result.id])).rows[0].n, 1);
      assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM bb_credit_events WHERE owner_user_id=$1 AND run_id=$2', [f.owner, f.runId])).rows[0].n, 0);
    } finally { await f.cleanup(); }
  });
}
