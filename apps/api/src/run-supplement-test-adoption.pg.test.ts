// Real isolated PostgreSQL and owned synthetic DOCX bytes. No external model,
// real billing or paid adoption is exercised by these internal authority tests.
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
import { assertRunExecutionTestGrant } from './run-execution-test-grant.js';
import { claim, renew } from './queue.js';

const connection = await isolatedTestDatabase(undefined, 'run-test-successor-adoption');
const previousTier=process.env.BB_DEPLOYMENT_TIER,previousTestChannel=process.env.BB_NON_PRODUCTION_TEST_CHANNEL;
before(()=>{process.env.BB_DEPLOYMENT_TIER='preprod';process.env.BB_NON_PRODUCTION_TEST_CHANNEL='enabled';});
after(()=>{
  if(previousTier===undefined)delete process.env.BB_DEPLOYMENT_TIER;else process.env.BB_DEPLOYMENT_TIER=previousTier;
  if(previousTestChannel===undefined)delete process.env.BB_NON_PRODUCTION_TEST_CHANNEL;else process.env.BB_NON_PRODUCTION_TEST_CHANNEL=previousTestChannel;
});
const denied = (error: unknown) => error instanceof Problem && error.status === 409;
async function fixture(kind: RunSupplementProcessingKind, nonProduction = true, early = false) {
  if (kind === 'authoring') return early
    ? createRunSupplementPreparationFixture(connection!, { nonProduction, earlyPause: 'before_prompt' })
    : createRunSupplementPreparationFixture(connection!, { nonProduction });
  return createRunSupplementFilePreparationFixture(connection!, kind, { nonProduction });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function prepare(f: Fixture, kind: RunSupplementProcessingKind) {
  const basis = await loadRunSupplementProcessingBasis(f.preparationInput, kind);
  const plan = await createRunSupplementProcessingPlan({ ...f.preparationInput, kind, requestId: uid(), expectedBasisHash: basis.basisHash });
  const input = { ...f.preparationInput, kind, planId: plan.id, expectedPlanHash: plan.planHash };
  return { basis, plan, input };
}
async function ledger(f: Fixture) {
  return (await f.pool.query(`SELECT 'events' AS kind,to_jsonb(e) AS row FROM bb_credit_events e WHERE owner_user_id=$1
    UNION ALL SELECT 'reservations',to_jsonb(r) FROM bb_credit_reservations r WHERE owner_user_id=$1
    ORDER BY kind,row`, [f.owner])).rows;
}
async function authority(f: Fixture) {
  return (await f.pool.query(`SELECT (SELECT to_jsonb(h) FROM bb_run_execution_heads h WHERE h.run_id=$1) AS head,
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY execution_version) FROM bb_run_execution_versions e WHERE e.run_id=$1) AS versions,
    (SELECT to_jsonb(j) FROM bb_jobs j WHERE j.id=$2) AS job,
    (SELECT to_jsonb(r) FROM bb_runs r WHERE r.id=$1) AS run,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM bb_run_test_successor_authorizations a WHERE a.run_id=$1) AS receipts`,
  [f.runId, f.jobId])).rows[0];
}

for (const kind of ['authoring', 'review', 'm4'] as const) {
  test(`${kind}: exact new grant adopts the candidate in the same run and claim resolves V2 without changing original accounting`,
    { skip: !connection, timeout: 120000 }, async () => {
      const f = await fixture(kind);
      try {
        const { input, basis } = await prepare(f, kind), before = await authority(f), credits = await ledger(f);
        const target = await stageRunSupplementTestInput(input);
        assert.equal(target.inputHash, basis.candidateInputHash);
        assert.deepEqual(await stageRunSupplementTestInput(input), target);
        assert.deepEqual(await authority(f), before, 'staging cannot adopt or queue');
        const testGrantId = await grantSyntheticSupplementInput(f.pool, f.owner, f.projectId, target.inputRevision, target.inputHash);
        const request = { ...input, requestId: uid(), targetInputRevision: target.inputRevision, testGrantId };
        const adopted = await adoptRunSupplementTestInput(request);
        assert.equal(adopted.runId, f.runId); assert.equal(adopted.executionVersion, 2);
        const after = await authority(f);
        assert.equal(after.versions.length, 2); assert.equal(after.receipts.length, 1);
        assert.equal(after.head.execution_version, 2);
        for (const field of ['input_revision','input_hash','execution_request_id','request_hash','channel','test_grant_id','reservation_id','billing_mode'])
          assert.deepEqual(after.run[field], before.run[field], `original ${field}`);
        assert.deepEqual(after.job.checkpoint.stages, {});
        assert.deepEqual(after.job.checkpoint.stage_execution, { execution_version: 2, input_revision: target.inputRevision, input_hash: target.inputHash });
        assert.deepEqual(after.job.checkpoint.provider_results, before.job.checkpoint.provider_results);
        assert.equal(after.job.state, 'queued'); assert.equal(after.job.user_pause_requested, false);
        assert.equal(after.job.test_grant_id, before.job.test_grant_id);
        assert.deepEqual(await ledger(f), credits);
        const pinned=(await f.pool.query('SELECT bb_material_bytes_pinned($1,$2,$3,$4) AS pinned',
          [f.owner,f.projectId,f.added.material_id,f.added.material_version])).rows[0];
        assert.equal(pinned.pinned,true,'adopted candidate material acquires a durable execution pin');
        const exact = await readRunExecutionInput(f.pool, f.owner, f.runId, target);
        assert.deepEqual(exact.input.manifest, basis.manifest);
        assert.equal(exact.run.originInput.inputHash, f.hash);
        if (kind === 'review') {
          assert.notEqual((exact.input.manifest as any).review.report_id, (f.manifest as any).review.report_id);
          assert.equal(exact.reviewExecution?.version, (f.manifest as any).review.version_number + 1);
        }
        if (kind === 'm4') assert.deepEqual(exact.m4Execution?.manifest, basis.manifest);
        await assert.rejects(readRunExecutionInput(f.pool, f.owner, f.runId, basis.sourceExecution), denied);
        const permission = await assertRunExecutionTestGrant(f.pool, { owner: f.owner, projectId: f.projectId, runId: f.runId, ...target });
        assert.equal(permission.grantId, testGrantId); assert.equal(permission.authorizationId, adopted.id);
        assert.deepEqual(await adoptRunSupplementTestInput(request), adopted);
        assert.deepEqual(await authority(f), after, 'exact replay cannot requeue or duplicate the receipt/event');
        await assert.rejects(adoptRunSupplementTestInput({ ...request, testGrantId: before.run.test_grant_id }), denied);
        assert.deepEqual(await authority(f), after);
        await assert.rejects(f.pool.query(`UPDATE bb_run_test_successor_authorizations SET request_hash=$2 WHERE id=$1`,
          [adopted.id,'a'.repeat(64)]),{code:'23514'});
        await assert.rejects(f.pool.query(`INSERT INTO bb_artifact_versions(id,version,owner_user_id,run_id,media_type,
          sha256,object_key,quality_status,delivery_status) VALUES($1,1,$2,$3,'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          $4,$5,'pending','pending')`,[uid(),f.owner,f.runId,'b'.repeat(64),`synthetic-closed-successor/${uid()}`]),
          {code:'23514',constraint:'bb_test_successor_artifact_closed'});
        assert.deepEqual(await authority(f),after,'old artifact writers and receipt rewrites remain closed');
        const lease = await claim(f.pool, 300, { runKinds: [kind === 'authoring' ? 'update' : kind === 'review' ? 'review' : 'generation'] });
        assert.ok(lease); assert.equal(lease.runId, f.runId);
        assert.deepEqual({ executionVersion: lease.executionVersion, inputRevision: lease.inputRevision, inputHash: lease.inputHash }, target);
        await assert.rejects(renew(f.pool, { ...lease, ...basis.sourceExecution }, 300), denied);
        assert.deepEqual(await ledger(f), credits);
      } finally { await f.cleanup(); }
    });
}

test('production adoption is closed; old, wrong and revoked test grants cannot move the head',
  { skip: !connection, timeout: 120000 }, async () => {
    const production = await fixture('authoring', false);
    try {
      const { input } = await prepare(production, 'authoring'), before = await authority(production);
      await assert.rejects(stageRunSupplementTestInput(input), denied);
      assert.deepEqual(await authority(production), before);
    } finally { await production.cleanup(); }
    const f = await fixture('authoring', true, true);
    try {
      const { input } = await prepare(f, 'authoring');
      const target = await stageRunSupplementTestInput(input), before = await authority(f);
      const request = { ...input, requestId: uid(), targetInputRevision: target.inputRevision, testGrantId: before.run.test_grant_id };
      await assert.rejects(adoptRunSupplementTestInput(request), denied);
      const grant = await grantSyntheticSupplementInput(f.pool, f.owner, f.projectId, target.inputRevision, target.inputHash);
      await f.pool.query(`UPDATE bb_non_production_test_grants SET revoked_at=now(),revoked_by='synthetic_fixture',revoked_reason='Negative authorization test' WHERE grant_id=$1`, [grant]);
      await assert.rejects(adoptRunSupplementTestInput({ ...request, testGrantId: grant }), denied);
      assert.deepEqual(await authority(f), before);
    } finally { await f.cleanup(); }
  });

test('revoking the successor grant blocks a new claim without reusing the original grant',
  {skip:!connection,timeout:120000},async()=>{
    const f=await fixture('authoring',true,true);
    try{
      const {input}=await prepare(f,'authoring'),target=await stageRunSupplementTestInput(input);
      const testGrantId=await grantSyntheticSupplementInput(f.pool,f.owner,f.projectId,target.inputRevision,target.inputHash);
      await adoptRunSupplementTestInput({...input,requestId:uid(),targetInputRevision:target.inputRevision,testGrantId});
      await f.pool.query(`UPDATE bb_non_production_test_grants SET revoked_at=now(),revoked_by='synthetic_fixture',
        revoked_reason='Stop successor new work' WHERE grant_id=$1`,[testGrantId]);
      await assert.rejects(assertRunExecutionTestGrant(f.pool,{owner:f.owner,projectId:f.projectId,runId:f.runId,...target}),
        {code:'TEST_GRANT_REVOKED'});
      assert.equal(await claim(f.pool,300,{runKinds:['update']}),null);
      const after=await authority(f);assert.equal(after.head.execution_version,2);assert.equal(after.versions.length,2);
      assert.equal(after.run.state,'paused');assert.notEqual(after.run.test_grant_id,testGrantId);
    }finally{await f.cleanup();}
  });

test('two adopters serialize on the same paused boundary; exactly one request and one target execution commit',
  { skip: !connection, timeout: 120000 }, async () => {
    const f = await fixture('authoring', true, true);
    try {
      const { input } = await prepare(f, 'authoring'), target = await stageRunSupplementTestInput(input);
      const grant = await grantSyntheticSupplementInput(f.pool, f.owner, f.projectId, target.inputRevision, target.inputHash);
      const request = { ...input, targetInputRevision: target.inputRevision, testGrantId: grant };
      const outcomes = await Promise.allSettled([adoptRunSupplementTestInput({ ...request, requestId: uid() }), adoptRunSupplementTestInput({ ...request, requestId: uid() })]);
      assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
      const after = await authority(f); assert.equal(after.versions.length, 2); assert.equal(after.receipts.length, 1);
    } finally { await f.cleanup(); }
  });

test('direct SQL cannot commit an incomplete adoption or create an unreceipted V2',
  {skip:!connection,timeout:120000},async()=>{
    const f=await fixture('review');
    try{
      const {input,basis}=await prepare(f,'review'),target=await stageRunSupplementTestInput(input);
      const testGrantId=await grantSyntheticSupplementInput(f.pool,f.owner,f.projectId,target.inputRevision,target.inputHash);
      const before=await authority(f),client=await f.pool.connect(),id=uid();
      try{
        await assert.rejects(client.query(`INSERT INTO bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
          VALUES($1,$2,$3,2,$4,$5)`,[f.owner,f.projectId,f.runId,target.inputRevision,target.inputHash]),
          {code:'23514',constraint:'bb_test_successor_execution_origin'});
        await client.query('BEGIN');
        await client.query(`INSERT INTO bb_run_test_successor_authorizations
          (id,owner_user_id,project_id,run_id,job_id,source_execution_version,source_input_revision,source_input_hash,
           supplement_revision,processing_plan_id,request_id,request_hash,execution_version,input_revision,input_hash,test_grant_id)
          VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,2,$12,$13,$14)`,
        [id,f.owner,f.projectId,f.runId,f.jobId,basis.sourceExecution.inputRevision,basis.sourceExecution.inputHash,
          input.revision,input.planId,uid(),'c'.repeat(64),target.inputRevision,target.inputHash,testGrantId]);
        await client.query(`INSERT INTO bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,created_at)
          SELECT owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,created_at
          FROM bb_run_test_successor_authorizations WHERE id=$1`,[id]);
        await assert.rejects(client.query('COMMIT'),{code:'23514',constraint:'bb_test_successor_complete'});
        await client.query('ROLLBACK');
      }finally{client.release();}
      assert.deepEqual(await authority(f),before,'receipt and execution must roll back together');
    }finally{await f.cleanup();}
  });
