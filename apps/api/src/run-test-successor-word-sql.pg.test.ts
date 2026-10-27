// SQL metadata authority tests. Synthetic pending artifacts/working registrations
// deliberately grant no delivery: actual Word bytes/readback are exercised by
// the worker's separate end-to-end successor tests.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { uid } from './data.js';
import { isolatedTestDatabase } from './test-database.js';
import { createRunSupplementPreparationFixture, grantSyntheticSupplementInput } from './run-supplement-preparation-test-fixture.js';
import { createRunSupplementFilePreparationFixture } from './run-supplement-file-preparation-test-fixture.js';
import { loadRunSupplementProcessingBasis, type RunSupplementProcessingKind } from './run-supplement-preparation.js';
import { createRunSupplementProcessingPlan } from './run-supplement-processing-plan.js';
import { stageRunSupplementTestInput, adoptRunSupplementTestInput } from './run-supplement-test-adoption.js';
import type { RunExecutionIdentity } from './run-execution.js';

const connection = await isolatedTestDatabase(undefined, 'test-successor-word-sql');
const previousTier = process.env.BB_DEPLOYMENT_TIER, previousChannel = process.env.BB_NON_PRODUCTION_TEST_CHANNEL;
before(() => { process.env.BB_DEPLOYMENT_TIER = 'preprod'; process.env.BB_NON_PRODUCTION_TEST_CHANNEL = 'enabled'; });
after(() => {
  if (previousTier === undefined) delete process.env.BB_DEPLOYMENT_TIER; else process.env.BB_DEPLOYMENT_TIER = previousTier;
  if (previousChannel === undefined) delete process.env.BB_NON_PRODUCTION_TEST_CHANNEL; else process.env.BB_NON_PRODUCTION_TEST_CHANNEL = previousChannel;
});
const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const checksum = 'b'.repeat(64);
async function fixture(kind: RunSupplementProcessingKind) {
  return kind === 'authoring'
    ? createRunSupplementPreparationFixture(connection!, { nonProduction: true, earlyPause: 'before_prompt' })
    : createRunSupplementFilePreparationFixture(connection!, kind, { nonProduction: true, earlyPause: 'before_prompt' });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function closeFixture(f: Fixture) {
  try {
    // Keep this file's synthetic queued runs out of later fixtures' global
    // claim scans, including the grant-revocation negatives above.
    await f.pool.query(`UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE id=$1`, [f.jobId]);
    await f.pool.query(`UPDATE bb_runs SET state='cancelled' WHERE id=$1`, [f.runId]);
  } finally { await f.cleanup(); }
}
async function adopt(f: Fixture, kind: RunSupplementProcessingKind) {
  const basis = await loadRunSupplementProcessingBasis(f.preparationInput, kind);
  const plan = await createRunSupplementProcessingPlan({ ...f.preparationInput, kind, requestId: uid(), expectedBasisHash: basis.basisHash });
  const input = { ...f.preparationInput, kind, planId: plan.id, expectedPlanHash: plan.planHash };
  const target = await stageRunSupplementTestInput(input);
  const grant = await grantSyntheticSupplementInput(f.pool, f.owner, f.projectId, target.inputRevision, target.inputHash);
  const receipt = await adoptRunSupplementTestInput({ ...input, requestId: uid(), targetInputRevision: target.inputRevision, testGrantId: grant });
  return { target, grant, receipt };
}
async function artifact(f: Fixture, identity?: RunExecutionIdentity) {
  const id = uid();
  await f.pool.query(`INSERT INTO bb_artifact_versions(id,version,owner_user_id,run_id,media_type,sha256,object_key,
    quality_status,delivery_status,execution_version,input_revision,input_hash)
    VALUES($1,1,$2,$3,$4,$5,$6,'pending','pending',$7,$8,$9)`,
  [id, f.owner, f.runId, docx, checksum, `synthetic-sql-only/${uid()}`,
    identity?.executionVersion ?? null, identity?.inputRevision ?? null, identity?.inputHash ?? null]);
  return id;
}
async function register(f: Fixture, kind: RunSupplementProcessingKind, id: string, identity: RunExecutionIdentity, revision: number) {
  if (kind === 'review') {
    await f.pool.query(`INSERT INTO bb_review_execution_artifacts(owner_user_id,project_id,run_id,execution_version,
      input_revision,input_hash,kind,artifact_id,artifact_version,filename)
      VALUES($1,$2,$3,$4,$5,$6,'report',$7,1,'report.docx')`,
    [f.owner, f.projectId, f.runId, identity.executionVersion, identity.inputRevision, identity.inputHash, id]);
  } else if (kind === 'm4') {
    await f.pool.query(`INSERT INTO bb_m4_execution_artifacts(owner_user_id,project_id,run_id,execution_version,
      input_revision,input_hash,topic_id,artifact_id,artifact_version,kind,filename,byte_size,document_type,base_artifact,revision_number)
      SELECT owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,topic_id,$7,1,'document','document.docx',10,
        manifest#>>'{input,document_type}',manifest#>'{input,edit_base}',$8 FROM bb_m4_execution_snapshots
      WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3 AND execution_version=$4 AND input_revision=$5 AND input_hash=$6`,
    [f.owner, f.projectId, f.runId, identity.executionVersion, identity.inputRevision, identity.inputHash, id, revision]);
  }
}
async function prompt(f: Fixture, identity: RunExecutionIdentity, explicit: number | null = identity.executionVersion) {
  const id = uid();
  await f.pool.query(`INSERT INTO bb_snapshot_refs(id,owner_user_id,project_id,run_id,snapshot_kind,version,
    object_key,content_sha256,redaction_version,input_revision,input_hash,execution_version)
    SELECT $1,$2,$3,$4,'model_request',COALESCE(max(version),0)+1,$5,$6,'synthetic_sql',$7,$8,$9
    FROM bb_snapshot_refs WHERE owner_user_id=$2 AND project_id=$3 AND snapshot_kind='model_request'`,
  [id, f.owner, f.projectId, f.runId, `users/${f.owner}/projects/${f.projectId}/snapshots/${id}`, checksum,
    identity.inputRevision, identity.inputHash, explicit]);
  return id;
}
async function workingObject(f: Fixture) {
  const key = `owners/${f.owner}/projects/${f.projectId}/runs/${f.runId}/file-authoring/${uid()}/${checksum}/tracked.docx`;
  await f.pool.query(`INSERT INTO bb_run_working_objects(object_key,owner_user_id,project_id,run_id,filename,sha256,byte_size,media_type)
    VALUES($1,$2,$3,$4,'tracked.docx',$5,10,$6)`, [key, f.owner, f.projectId, f.runId, checksum, docx]);
  await f.pool.query('INSERT INTO bb_run_working_object_state(object_key) VALUES($1)', [key]);
  return key;
}
async function workingSource(f: Fixture, key: string, identity: RunExecutionIdentity, attempt: string) {
  await f.pool.query(`INSERT INTO bb_run_working_sources(object_key,owner_user_id,project_id,run_id,job_id,
    execution_version,input_revision,input_hash,source_kind,attempt_id,result_schema_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'provider',$9,'codex-file-word-v1')`,
  [key, f.owner, f.projectId, f.runId, f.jobId, identity.executionVersion, identity.inputRevision, identity.inputHash, attempt]);
}

for (const kind of ['authoring', 'review', 'm4'] as const) {
  test(`${kind}: explicit V2 artifacts retain exact historical origin without changing V1 or legacy selections`,
    { skip: !connection, timeout: 120000 }, async () => {
      const f = await fixture(kind);
      try {
        const source = { executionVersion: 1, inputRevision: 'inputRevision' in f ? f.inputRevision : 1, inputHash: f.hash };
        const v1 = await artifact(f);
        await register(f, kind, v1, source, 1);
        const legacyTable = kind === 'review' ? 'bb_review_artifacts' : kind === 'm4' ? 'bb_m4_artifacts' : null;
        const legacyBefore = legacyTable ? (await f.pool.query(`SELECT to_jsonb(t) AS row FROM ${legacyTable} t WHERE run_id=$1`, [f.runId])).rows : [];
        const { target, grant } = await adopt(f, kind);
        await assert.rejects(artifact(f), { code: '23514', constraint: 'bb_test_successor_artifact_closed' });
        await assert.rejects(artifact(f, source), { code: '23514', constraint: 'bb_test_successor_artifact_closed' });
        await assert.rejects(artifact(f, { ...target, inputHash: 'f'.repeat(64) }), { code: '23514', constraint: 'bb_artifact_execution_exact' });
        const v2 = await artifact(f, target);
        await register(f, kind, v2, target, 2);
        const bindings = (await f.pool.query(`SELECT artifact_id,execution_version,input_revision,input_hash FROM bb_artifact_execution_bindings
          WHERE run_id=$1 ORDER BY execution_version`, [f.runId])).rows;
        assert.deepEqual(bindings.map(row => [row.artifact_id, row.execution_version, row.input_revision, row.input_hash.trim()]),
          [[v1, 1, source.inputRevision, source.inputHash], [v2, 2, target.inputRevision, target.inputHash]]);
        if (legacyTable) assert.deepEqual((await f.pool.query(`SELECT to_jsonb(t) AS row FROM ${legacyTable} t WHERE run_id=$1`, [f.runId])).rows, legacyBefore);
        const typedView = kind === 'review' ? 'bb_review_execution_artifact_versions' : kind === 'm4' ? 'bb_m4_execution_artifact_versions' : null;
        if (typedView) assert.deepEqual((await f.pool.query(`SELECT execution_version FROM ${typedView} WHERE run_id=$1 ORDER BY execution_version`, [f.runId])).rows,
          [{ execution_version: 1 }, { execution_version: 2 }]);
        await assert.rejects(f.pool.query(`UPDATE bb_artifact_versions SET execution_version=1,input_revision=$2,input_hash=$3 WHERE id=$1`,
          [v2, source.inputRevision, source.inputHash]), { code: '23514', constraint: 'bb_artifact_execution_identity_immutable' });
        await f.pool.query(`UPDATE bb_non_production_test_grants SET revoked_at=now(),revoked_by='synthetic_sql',
          revoked_reason='Stop new SQL writes, preserve history' WHERE grant_id=$1`, [grant]);
        await assert.rejects(artifact(f, target), { code: '23514', constraint: 'bb_test_successor_write_authority' });
        assert.deepEqual((await f.pool.query(`SELECT id FROM bb_execution_artifact_versions WHERE run_id=$1 ORDER BY id`, [f.runId])).rows,
          [v1, v2].sort().map(id => ({ id })));
        if (typedView) assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${typedView} WHERE run_id=$1`, [f.runId])).rows[0].n, 2);
        assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM bb_delivered_artifact_versions WHERE run_id=$1', [f.runId])).rows[0].n, 0,
          'provenance and registration alone never grant delivery');
      } finally { await closeFixture(f); }
    });
}

test('model prompts and working provider claims require the complete explicit V2 tuple and exact attempt',
  { skip: !connection, timeout: 120000 }, async () => {
    const f = await fixture('authoring');
    try {
      const { target, grant } = await adopt(f, 'authoring');
      await assert.rejects(prompt(f, target, null), { code: '23514', constraint: 'bb_model_call_execution_exact' });
      await assert.rejects(prompt(f, { ...target, inputRevision: 1, inputHash: f.hash }),
        { code: '23514', constraint: 'bb_test_successor_write_authority' });
      const promptId = await prompt(f, target), attempt = uid();
      await f.pool.query(`INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status,
        model_id,prompt_snapshot_id,channel) VALUES($1,$2,$3,'file-authoring-v1',1,'failed','synthetic_sql',$4,'non_production_test')`,
      [attempt, f.owner, f.jobId, promptId]);
      assert.deepEqual((await f.pool.query(`SELECT execution_version,input_revision,input_hash,prompt_snapshot_ref
        FROM bb_model_call_execution_bindings WHERE attempt_id=$1`, [attempt])).rows,
      [{ execution_version: 2, input_revision: target.inputRevision, input_hash: target.inputHash, prompt_snapshot_ref: promptId }]);
      await assert.rejects(f.pool.query(`INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status,channel)
        VALUES($1,$2,$3,'file-authoring-v1',2,'failed','non_production_test')`, [uid(), f.owner, f.jobId]),
      { code: '23514', constraint: 'bb_model_call_execution_exact' });
      const key = await workingObject(f);
      await assert.rejects(workingSource(f, key, target, uid()), { code: '23514', constraint: 'bb_run_working_source_attempt' });
      await workingSource(f, key, target, attempt);
      const purging = await workingObject(f);
      await f.pool.query(`UPDATE bb_run_working_object_state SET purge_started_at=now(),purge_reason='synthetic_sql',policy_version='synthetic_v1' WHERE object_key=$1`, [purging]);
      await assert.rejects(workingSource(f, purging, target, attempt), { code: '23514', constraint: 'bb_run_working_source_live_object' });
      await f.pool.query(`UPDATE bb_non_production_test_grants SET revoked_at=now(),revoked_by='synthetic_sql',revoked_reason='Stop new provider claims' WHERE grant_id=$1`, [grant]);
      await assert.rejects(prompt(f, target), { code: '23514', constraint: 'bb_test_successor_write_authority' });
      await assert.rejects(workingSource(f, key, target, attempt), { code: '23514', constraint: 'bb_test_successor_write_authority' });
      assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM bb_run_working_sources WHERE run_id=$1', [f.runId])).rows[0].n, 1);
    } finally { await closeFixture(f); }
  });
