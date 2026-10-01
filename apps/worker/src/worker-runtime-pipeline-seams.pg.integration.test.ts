// SYNTHETIC PostgreSQL 16 integration for the #33/#15/#76 worker runtime call points.
//
// A generation run whose locked input manifest pins a `generation_issuer_binding_ref` is now
// re-verified by the run pipeline's `input_lock` stage through the injected #33 loader. A valid
// pin walks on to the next gate (`rule_pack_pin_missing` here, because the synthetic manifest is
// not a production rule pin); a missing/stale pin keeps the run fail-closed at
// `issuer_identity_not_bound`; with no loader injected the manifest pin is ignored (unchanged).
//
// The #76 target-period candidate producer is called once from the same stage for update and
// generation runs whose locked input selects financial materials, from owner-scoped rows only, and
// a producer failure is swallowed (it persists nothing) so it never blocks the rest of the run.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import type { PrivateBlobs } from '@bondbuddy/api/data';
import type { InputRevisionRow } from './run-pipeline.js';
import {
  inputLockStage,
  invokeTargetPeriodCandidateProducer,
  runPipelineOnce,
  type LoadGenerationIssuerBinding,
  type RunRow,
  type RunStage,
  type TargetPeriodCandidateProducer,
} from './run-pipeline.js';
import type { ProduceTargetPeriodCandidateSnapshotRequest } from './target-period-candidate-snapshot-producer.js';
import { isolatedTestDatabase } from './test-database.js';

const connection = await isolatedTestDatabase('BB_TEST_DATABASE_URL', 'worker-runtime-pipeline-seams');

const bindingRef = { binding_id: 'seams-binding', version: 1, content_sha256: 'b'.repeat(64) };
const pinnedManifest = {
  kind: 'generation',
  materials: [{ material_id: 'seams-audit', material_version: 1, role: 'audit', sha256: 'a'.repeat(64) }],
  generation_issuer_binding_ref: bindingRef,
  generation_issuer_entity_id: 'entity:11111111-1111-4111-8111-111111111111',
};

async function pauseReason(pool: Pool, runId: string) {
  return (await pool.query(`SELECT payload->>'reason' AS reason FROM bb_run_events
    WHERE run_id=$1 AND state='paused' ORDER BY seq DESC LIMIT 1`, [runId])).rows[0]?.reason as string | undefined;
}

/** The shared template may carry unrelated queued work; this file's clone is private, so park it. */
async function parkPreExistingRuns(pool: Pool) {
  await pool.query(`UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL
    WHERE job_type<>'parse' AND state IN ('queued','running')`);
  await pool.query(`UPDATE bb_runs SET state='cancelled' WHERE state IN ('queued','running')`);
}

test('the input_lock stage re-verifies a pinned generation issuer binding from an injected loader', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection! });
  const owner = `seams-owner-${randomUUID()}`, project = `seams-project-${randomUUID()}`;
  const inputHash = inputManifestHash(pinnedManifest);
  try {
    await parkPreExistingRuns(pool);
    await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,update_details)
      VALUES($1,$2,'synthetic seams','generation',$3::jsonb)`,
    [project, owner, JSON.stringify({ reporting_cutoff: '2025-06-30' })]);
    await pool.query(`INSERT INTO bb_input_revisions
      (project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,$4::jsonb,$5::jsonb,'[]'::jsonb)`,
    [project, owner, inputHash, JSON.stringify(pinnedManifest),
      JSON.stringify([{ material_id: 'seams-audit', material_version: 1 }])]);
    const submit = async () => {
      const runId = `seams-run-${randomUUID()}`, jobId = `seams-job-${randomUUID()}`;
      await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,channel)
        VALUES($1,$2,$3,1,$4,$5,'generation',$4,'queued','production')`, [runId, owner, project, inputHash, `exec-${runId}`]);
      await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage)
        VALUES($1,$2,$3,'generation','default','queued','queued')`, [jobId, owner, runId]);
      return runId;
    };
    let markerReached = 0;
    const stages: RunStage[] = [inputLockStage, { name: 'marker', run: async () => { markerReached++; return { kind: 'done' }; } }];
    const run = (loadGenerationIssuerBinding: LoadGenerationIssuerBinding | undefined, produceTargetPeriodCandidates?: TargetPeriodCandidateProducer) =>
      runPipelineOnce({ pool, blobs: {} as PrivateBlobs, stages, loadGenerationIssuerBinding, produceTargetPeriodCandidates });

    // A pinned ref that the injected loader re-verifies walks on to the next gate, and the #76
    // producer call site runs once from the locked input + owner-scoped project rows.
    const produced: ProduceTargetPeriodCandidateSnapshotRequest[] = [];
    const validRun = await submit();
    const stubBinding = (runId: string): LoadGenerationIssuerBinding => async () => ({ ownerUserId: owner, projectId: project, runId,
      inputRevision: 1, inputHash, bindingId: bindingRef.binding_id, version: 1, contentSha256: bindingRef.content_sha256,
      issuerEntityId: pinnedManifest.generation_issuer_entity_id, reviewEventId: 'seams-review', reviewedAt: '2026-09-29T00:00:00Z' });
    assert.equal(await run(stubBinding(validRun), async request => { produced.push(request); }), 'paused');
    assert.equal(markerReached, 0, 'the synthetic manifest is not a production rule pin, so the run stops at the next gate');
    assert.equal(await pauseReason(pool, validRun), 'rule_pack_pin_missing');
    assert.equal(produced.length, 1);
    assert.deepEqual(produced[0], { ownerUserId: owner, projectId: project, selectedFinancialMaterials: [{ materialId: 'seams-audit', materialVersion: 1 }],
      projectDraftRevision: 1, reportingCutoff: '2025-06-30', inputRevision: 1, inputHash });

    // A missing/stale binding stays fail-closed at the stable identity code, and the producer is
    // not reached because the identity gate precedes it.
    const invalidRun = await submit();
    assert.equal(await run(async () => null, async request => { produced.push(request); }), 'paused');
    assert.equal(await pauseReason(pool, invalidRun), 'issuer_identity_not_bound');
    assert.equal(produced.length, 1, 'a rejected binding never reaches the producer call site');

    // With no loader injected the manifest pin is ignored: unchanged pre-wiring behavior.
    const unchangedRun = await submit();
    assert.equal(await run(undefined), 'paused');
    assert.equal(await pauseReason(pool, unchangedRun), 'rule_pack_pin_missing');
  } finally { await pool.end(); }
});

test('a producer failure is swallowed and never blocks the rest of the run', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection! });
  const owner = `seams-owner-${randomUUID()}`, project = `seams-project-${randomUUID()}`;
  const inputHash = inputManifestHash(pinnedManifest);
  try {
    await parkPreExistingRuns(pool);
    await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,update_details)
      VALUES($1,$2,'synthetic seams','generation',$3::jsonb)`,
    [project, owner, JSON.stringify({ reporting_cutoff: '2025-06-30' })]);
    await pool.query(`INSERT INTO bb_input_revisions
      (project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,$4::jsonb,$5::jsonb,'[]'::jsonb)`,
    [project, owner, inputHash, JSON.stringify(pinnedManifest), JSON.stringify([{ material_id: 'seams-audit', material_version: 1 }])]);
    const runId = `seams-run-${randomUUID()}`;
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,channel)
      VALUES($1,$2,$3,1,$4,$5,'generation',$4,'queued','production')`, [runId, owner, project, inputHash, `exec-${runId}`]);
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage)
      VALUES($1,$2,$3,'generation','default','queued','queued')`, [`seams-job-${randomUUID()}`, owner, runId]);
    const outcome = await runPipelineOnce({ pool, blobs: {} as PrivateBlobs,
      stages: [inputLockStage, { name: 'marker', run: async () => ({ kind: 'done' }) }],
      loadGenerationIssuerBinding: async () => ({ ownerUserId: owner, projectId: project, runId, inputRevision: 1,
        inputHash, bindingId: bindingRef.binding_id, version: 1, contentSha256: bindingRef.content_sha256,
        issuerEntityId: pinnedManifest.generation_issuer_entity_id, reviewEventId: 'seams-review', reviewedAt: '2026-09-29T00:00:00Z' }),
      produceTargetPeriodCandidates: async () => { throw new Error('TARGET_PERIOD_CANDIDATE_SOURCE_INVALID'); } });
    assert.equal(outcome, 'paused');
    assert.equal(await pauseReason(pool, runId), 'rule_pack_pin_missing', 'the producer error never becomes the run outcome');
  } finally { await pool.end(); }
});

test('the producer call site skips inputs without financial materials and reads no rows for them', async () => {
  let called = 0;
  let queries = 0;
  const pool = { query: async () => { queries++; return { rows: [] }; } } as unknown as Pool;
  const run: RunRow = { id: 'run-synthetic', owner_user_id: 'owner-synthetic', project_id: 'project-synthetic',
    input_revision: 1, input_hash: 'a'.repeat(64), task_kind: 'update' };
  const input: InputRevisionRow = { input_hash: 'a'.repeat(64), draft_revision: 1, material_versions: [],
    manifest: { materials: [{ material_id: 'seams-historical', material_version: 1, role: 'historical', sha256: 'a'.repeat(64) }] },
    rule_pack_version: null, template_version: null };
  await invokeTargetPeriodCandidateProducer(pool, run, input, async () => { called++; });
  assert.equal(called, 0);
  assert.equal(queries, 0, 'no owner-scoped project read happens when there are no financial materials');
});
