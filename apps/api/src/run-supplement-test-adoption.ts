import type { PoolClient } from 'pg';
import { date, Problem, transaction, uid } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import { assertTestGrant, testChannelEnabled } from './non-production-test.js';
import { assertRunExecution, type RunExecutionIdentity } from './run-execution.js';
import { readRunSupplementProcessingPlan, recheckRunSupplementProcessingBasis,
  type ReadRunSupplementProcessingPlanInput } from './run-supplement-processing-plan.js';

/** Internal preproduction protocol only. No HTTP route or grant minting is
 * provided: an operator must independently authorize the exact staged input.
 * Paid adoption remains closed until the additional quote is specified. */
export type StageRunSupplementTestInput = ReadRunSupplementProcessingPlanInput & { expectedPlanHash: string };
export type AdoptRunSupplementTestInput = StageRunSupplementTestInput & {
  requestId: string; targetInputRevision: number; testGrantId: string;
};
export type RunSupplementTestAdoption = RunExecutionIdentity & {
  id: string; runId: string; projectId: string; jobId: string; testGrantId: string;
  processingPlanId: string; requestId: string; adoptedAt: string;
};
const unavailable = () => new Problem(409, 'INPUT_REVISION_CONFLICT', '补料采用依据或测试授权已变化，请重新核对。');
const same = (left: unknown, right: unknown) => inputManifestHash(left) === inputManifestHash(right);
const validKey = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 128;
const validHash = (value: string) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
async function testTransaction<T>(input: StageRunSupplementTestInput, work: (db: PoolClient) => Promise<T>): Promise<T> {
  try { return await transaction(input.db, work); }
  catch (error) {
    const failure=error as {code?:string;constraint?:string};
    if(failure?.code==='55P03'||failure?.code==='23514'&&failure.constraint?.startsWith('bb_test_successor'))throw unavailable();
    throw error;
  }
}

async function lockScope(db: PoolClient, input: StageRunSupplementTestInput) {
  if (!testChannelEnabled()) throw new Problem(403, 'TEST_CHANNEL_DISABLED', 'Test channel is disabled');
  const project = (await db.query(`SELECT p.id FROM bb_projects p JOIN bb_users u ON u.id=p.owner_user_id
    WHERE p.owner_user_id=$1 AND p.id=$2 AND p.deleted_at IS NULL AND p.archived_at IS NULL
      AND u.closed_at IS NULL AND u.status<>'closed' FOR UPDATE OF p`, [input.owner, input.projectId])).rows[0];
  const run = (await db.query(`SELECT * FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
    [input.owner, input.projectId, input.runId])).rows[0];
  const job = (await db.query(`SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2 FOR UPDATE`,
    [input.owner, input.runId])).rows[0];
  if (!project || !run || !job || run.channel !== 'non_production_test' || job.channel !== run.channel
    || !run.test_grant_id || job.test_grant_id !== run.test_grant_id || run.reservation_id
    || run.billing_mode === 'fixed_credits' || run.billing_mode === 'metered_credits') throw unavailable();
  return { run, job };
}

function manifestMaterials(manifest: Record<string, any>) {
  if (manifest.version === 'm4-document-input-v1') {
    const pins = [...manifest.input.materials, ...(manifest.input.source_material ? [manifest.input.source_material] : []),
      ...(manifest.template_material ? [manifest.template_material] : [])];
    return [...new Map(pins.map(pin => [inputManifestHash(pin), pin])).values()];
  }
  return manifest.materials;
}

/** Freezes the already byte-verified candidate so an independent exact-input
 * test grant can reference it. This does not move the head or queue a call. */
export async function stageRunSupplementTestInput(input: StageRunSupplementTestInput): Promise<RunExecutionIdentity> {
  if (!validHash(input.expectedPlanHash)) throw unavailable();
  // Reject production before reading any private preparation bytes.
  await testTransaction(input, db => lockScope(db, input));
  const saved = await readRunSupplementProcessingPlan(input);
  if (saved.plan.planHash !== input.expectedPlanHash) throw unavailable();
  return testTransaction(input, async db => {
    await lockScope(db, input);
    await recheckRunSupplementProcessingBasis(db, input, saved.basis);
    const source = saved.basis.sourceExecution;
    const original = (await db.query(`SELECT * FROM bb_input_revisions
      WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3 AND input_hash=$4`,
    [input.owner, input.projectId, source.inputRevision, source.inputHash])).rows[0];
    if (!original) throw unavailable();
    const candidates = (await db.query(`SELECT revision,manifest FROM bb_input_revisions
      WHERE owner_user_id=$1 AND project_id=$2 AND input_hash=$3 ORDER BY revision`,
    [input.owner, input.projectId, saved.basis.candidateInputHash])).rows;
    const existing = candidates.find(row => same(row.manifest, saved.basis.manifest));
    if (existing) return { executionVersion: 2, inputRevision: existing.revision, inputHash: saved.basis.candidateInputHash };
    const revision = (await db.query(`SELECT COALESCE(max(revision),0)+1 AS revision FROM bb_input_revisions
      WHERE owner_user_id=$1 AND project_id=$2`, [input.owner, input.projectId])).rows[0].revision;
    const manifest = saved.basis.manifest;
    await db.query(`INSERT INTO bb_input_revisions(owner_user_id,project_id,revision,draft_revision,input_hash,manifest,
      material_versions,requirement_message_ids,rule_pack_version,template_version,reference_release)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [input.owner, input.projectId, revision, original.draft_revision, saved.basis.candidateInputHash, manifest,
      JSON.stringify(manifestMaterials(manifest)), JSON.stringify(original.requirement_message_ids),
      original.rule_pack_version, original.template_version, original.reference_release]);
    return { executionVersion: 2, inputRevision: revision, inputHash: saved.basis.candidateInputHash };
  });
}

function requestHash(input: AdoptRunSupplementTestInput) {
  return inputManifestHash({ version: 'run-test-successor-adoption-v1', owner: input.owner, projectId: input.projectId,
    runId: input.runId, revision: input.revision, kind: input.kind, planId: input.planId,
    expectedPlanHash: input.expectedPlanHash, checkpointHash: input.expectedCheckpointHash,
    candidateInputHash: input.expectedCandidateInputHash, targetInputRevision: input.targetInputRevision, testGrantId: input.testGrantId });
}
function dto(row: any): RunSupplementTestAdoption {
  return { id: row.id, projectId: row.project_id, runId: row.run_id, jobId: row.job_id,
    executionVersion: row.execution_version, inputRevision: row.input_revision, inputHash: row.input_hash.trim(),
    testGrantId: row.test_grant_id, processingPlanId: row.processing_plan_id, requestId: row.request_id, adoptedAt: date(row.created_at) };
}
async function replay(db: PoolClient, input: AdoptRunSupplementTestInput, hash: string) {
  const row = (await db.query(`SELECT * FROM bb_run_test_successor_authorizations
    WHERE owner_user_id=$1 AND run_id=$2 AND request_id=$3`, [input.owner, input.runId, input.requestId])).rows[0];
  if (!row) return null;
  if (row.project_id !== input.projectId || row.request_hash.trim() !== hash) throw unavailable();
  return dto(row);
}

/** Atomic same-run adoption under project -> run -> job locks. The grant is
 * supplied explicitly and checked against the candidate, never copied from V1.
 * Exact replay returns its immutable receipt and cannot schedule another call. */
export async function adoptRunSupplementTestInput(input: AdoptRunSupplementTestInput): Promise<RunSupplementTestAdoption> {
  if (!validKey(input.requestId) || !validKey(input.testGrantId) || !validHash(input.expectedPlanHash)
    || !Number.isSafeInteger(input.targetInputRevision) || input.targetInputRevision < 1) throw unavailable();
  const hash = requestHash(input);
  const previous = await testTransaction(input, async db => {
    await lockScope(db, input); return replay(db, input, hash);
  });
  if (previous) return previous;
  const saved = await readRunSupplementProcessingPlan(input);
  if (saved.plan.planHash !== input.expectedPlanHash) throw unavailable();
  return testTransaction(input, async db => {
    const { run, job } = await lockScope(db, input);
    const existing = await replay(db, input, hash);
    if (existing) return existing;
    await recheckRunSupplementProcessingBasis(db, input, saved.basis);
    const source = saved.basis.sourceExecution;
    const target = { executionVersion: 2, inputRevision: input.targetInputRevision, inputHash: saved.basis.candidateInputHash };
    const candidate = (await db.query(`SELECT * FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2
      AND revision=$3 AND input_hash=$4`, [input.owner, input.projectId, target.inputRevision, target.inputHash])).rows[0];
    if (!candidate || !same(candidate.manifest, saved.basis.manifest) || input.testGrantId === run.test_grant_id) throw unavailable();
    await db.query(`SELECT grant_id FROM bb_non_production_test_grants WHERE grant_id=$1 FOR SHARE`, [input.testGrantId]);
    await assertTestGrant(db, { grantId: input.testGrantId, userId: input.owner, projectId: input.projectId,
      inputRevision: target.inputRevision, inputHash: target.inputHash });
    await db.query('SELECT bb_assert_material_lifecycle_available($1,$2,$3)', [input.owner, input.projectId, target.inputRevision]);
    const receipt = (await db.query(`INSERT INTO bb_run_test_successor_authorizations
      (id,owner_user_id,project_id,run_id,job_id,source_execution_version,source_input_revision,source_input_hash,
       supplement_revision,processing_plan_id,request_id,request_hash,execution_version,input_revision,input_hash,test_grant_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,2,$13,$14,$15) RETURNING *`,
    [uid(), input.owner, input.projectId, input.runId, job.id, source.executionVersion, source.inputRevision, source.inputHash,
      input.revision, input.planId, input.requestId, hash, target.inputRevision, target.inputHash, input.testGrantId])).rows[0];
    await db.query(`INSERT INTO bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,created_at)
      VALUES($1,$2,$3,2,$4,$5,(SELECT created_at FROM bb_run_test_successor_authorizations WHERE id=$6))`,
    [input.owner, input.projectId, input.runId, target.inputRevision, target.inputHash, receipt.id]);
    const manifest = saved.basis.manifest;
    if (manifest.review) {
      const review = manifest.review;
      await db.query(`INSERT INTO bb_review_execution_snapshots(owner_user_id,project_id,run_id,execution_version,input_revision,
        input_hash,version,operation,source_report_id,snapshot,created_at)
        VALUES($1,$2,$3,2,$4,$5,$6,$7,$8,$9,(SELECT created_at FROM bb_run_test_successor_authorizations WHERE id=$10))`,
      [input.owner, input.projectId, input.runId, target.inputRevision, target.inputHash, review.version_number, review.operation,
        review.source_report_id, saved.basis.reviewSnapshot, receipt.id]);
    } else if (manifest.version === 'm4-document-input-v1') {
      await db.query(`INSERT INTO bb_m4_execution_snapshots(owner_user_id,project_id,run_id,execution_version,input_revision,
        input_hash,topic_id,manifest,created_at)
        VALUES($1,$2,$3,2,$4,$5,$6,$7,(SELECT created_at FROM bb_run_test_successor_authorizations WHERE id=$8))`,
      [input.owner, input.projectId, input.runId, target.inputRevision, target.inputHash, manifest.topic_id, manifest, receipt.id]);
    }
    const moved = await db.query(`UPDATE bb_run_execution_heads SET execution_version=2,input_revision=$4,input_hash=$5,
      activated_at=(SELECT created_at FROM bb_run_test_successor_authorizations WHERE id=$6)
      WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3 AND execution_version=$7 AND input_revision=$8 AND input_hash=$9`,
    [input.owner, input.projectId, input.runId, target.inputRevision, target.inputHash, receipt.id,
      source.executionVersion, source.inputRevision, source.inputHash]);
    if (moved.rowCount !== 1) throw unavailable();
    // Whitelist only job-wide evidence. Old prompt/model/delivery state stays
    // in the immutable saved-work checkpoint; it cannot complete execution 2.
    const checkpoint = { ...(Object.hasOwn(job.checkpoint,'provider_results') ? { provider_results: job.checkpoint.provider_results } : {}),
      ...(Object.hasOwn(job.checkpoint,'operator_reconciliations') ? { operator_reconciliations: job.checkpoint.operator_reconciliations } : {}),
      stage_execution: { execution_version: 2, input_revision: target.inputRevision, input_hash: target.inputHash }, stages: {} };
    await db.query(`UPDATE bb_jobs SET state='queued',stage='queued',checkpoint=$2,user_pause_requested=false,
      lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`, [job.id, checkpoint]);
    const seq = run.event_cursor + 1, eventId = uid();
    const payload = { reason: 'test_supplement_adopted', authorization_id: receipt.id, processing_plan_id: input.planId,
      execution_version: 2, input_revision: target.inputRevision, input_hash: target.inputHash, channel: 'non_production_test' };
    await db.query(`UPDATE bb_runs SET state='queued',stage='queued',event_cursor=$2,updated_at=now() WHERE id=$1`, [run.id, seq]);
    await db.query(`INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload)
      VALUES($1,$2,$3,$4,$3,'run.state_changed','queued','queued',$5)`, [eventId, input.owner, run.id, seq, payload]);
    await db.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'run',$3,'run.state_changed',$4)`, [uid(), input.owner, run.id, { run_id: run.id, event_id: eventId, seq, state: 'queued', stage: 'queued', ...payload }]);
    await assertRunExecution(db, run, target);
    return dto(receipt);
  });
}
