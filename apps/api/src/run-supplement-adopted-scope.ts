import type { Pool, PoolClient } from 'pg';
import { Value } from '@sinclair/typebox/value';
import { RunSupplementChangeSchema } from '@bondbuddy/contracts';
import { date, Problem } from './data.js';
import type { Lease } from './queue.js';
import { inputManifestHash } from './production-rule-pin.js';
import { assertRunExecution, readExecutionStages, type PersistedRunExecutionRow } from './run-execution.js';
import { assertRunExecutionTestGrant } from './run-execution-test-grant.js';
import type { RunSupplementProcessingKind } from './run-supplement-preparation.js';
import type { RunSupplementProcessingPlan } from './run-supplement-processing-plan.js';
import type { RunSupplementTestAdoption } from './run-supplement-test-adoption.js';

export type AdoptedRunSupplementAuthority = { lease: Lease; authorizationId?: string };
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => inputManifestHash(a ?? null) === inputManifestHash(b ?? null);
const unavailable = () => new Problem(409, 'INPUT_REVISION_CONFLICT', '补料续做的采用记录或当前执行权限已变化，请核对原任务。');

/** Internal historical reads require both the immutable adoption and its current
 * leased successor. They never broaden the public/current input resolver. No
 * relational locks are held across the independent content-purge locks or I/O. */
export async function assertAdoptedRunSupplementScope(db: Pool | PoolClient,
  authority: AdoptedRunSupplementAuthority, kind?: RunSupplementProcessingKind) {
  const { lease } = authority;
  if (!lease || lease.executionVersion !== 2 || !lease.token || !lease.jobId || !lease.runId || !lease.owner
    || kind !== undefined && !['authoring', 'review', 'm4'].includes(kind)) throw unavailable();
  const run = (await db.query(`SELECT r.*,j.checkpoint AS live_checkpoint,j.subtype AS job_subtype
    FROM bb_runs r JOIN bb_jobs j ON j.owner_user_id=r.owner_user_id AND j.run_id=r.id
    JOIN bb_projects p ON p.owner_user_id=r.owner_user_id AND p.id=r.project_id
    JOIN bb_users u ON u.id=r.owner_user_id
    WHERE r.owner_user_id=$1 AND r.id=$2 AND j.id=$3 AND j.lease_token=$4
      AND j.state='running' AND j.lease_until>clock_timestamp() AND r.state='running'
      AND NOT j.user_pause_requested AND p.deleted_at IS NULL AND p.archived_at IS NULL
      AND u.closed_at IS NULL AND u.status<>'closed'`,
  [lease.owner, lease.runId, lease.jobId, lease.token])).rows[0];
  if (!run || run.channel !== 'non_production_test' || run.reservation_id
    || ['fixed_credits', 'metered_credits'].includes(run.billing_mode)) throw unavailable();
  await assertRunExecution(db, run, lease);
  readExecutionStages(run.live_checkpoint, lease);
  const grant = await assertRunExecutionTestGrant(db, { ...lease, projectId: run.project_id });
  if (!grant.authorizationId || authority.authorizationId !== undefined
    && authority.authorizationId !== grant.authorizationId) throw unavailable();
  const receipt = (await db.query(`SELECT * FROM bb_run_test_successor_authorizations
    WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 AND run_id=$4 AND job_id=$5
      AND execution_version=2 AND input_revision=$6 AND input_hash=$7`,
  [grant.authorizationId, lease.owner, run.project_id, lease.runId, lease.jobId, lease.inputRevision, lease.inputHash])).rows[0];
  if (!receipt || receipt.source_execution_version !== 1 || receipt.source_input_revision !== run.input_revision
    || receipt.source_input_hash.trim() !== run.input_hash.trim() || receipt.test_grant_id !== grant.grantId) throw unavailable();
  const sourceExecution = { executionVersion: receipt.source_execution_version,
    inputRevision: receipt.source_input_revision, inputHash: receipt.source_input_hash.trim() };
  const history = (await db.query(`SELECT 1 FROM bb_run_execution_versions WHERE owner_user_id=$1
    AND project_id=$2 AND run_id=$3 AND execution_version=$4 AND input_revision=$5 AND input_hash=$6`,
  [lease.owner, run.project_id, lease.runId, sourceExecution.executionVersion, sourceExecution.inputRevision, sourceExecution.inputHash])).rows;
  const planRow = (await db.query(`SELECT * FROM bb_run_supplement_processing_plans
    WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 AND run_id=$4 AND job_id=$5 AND supplement_revision=$6`,
  [receipt.processing_plan_id, lease.owner, run.project_id, lease.runId, lease.jobId, receipt.supplement_revision])).rows[0];
  const work = (await db.query(`SELECT * FROM bb_run_supplement_saved_work
    WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3 AND supplement_revision=$4`,
  [lease.owner, run.project_id, lease.runId, receipt.supplement_revision])).rows[0];
  const draft = (await db.query(`SELECT * FROM bb_run_supplement_drafts
    WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3 AND revision=$4`,
  [lease.owner, run.project_id, lease.runId, receipt.supplement_revision])).rows[0];
  if (history.length !== 1 || !planRow || !record(planRow.body) || !work || !draft) throw unavailable();
  const body = planRow.body;
  if (kind !== undefined && planRow.kind !== kind || body.kind !== planRow.kind
    || body.version !== 'run-supplement-processing-plan-v1' || body.owner !== lease.owner
    || body.projectId !== run.project_id || body.runId !== lease.runId || body.revision !== receipt.supplement_revision
    || body.requestId !== planRow.request_id || body.candidateInputHash !== lease.inputHash
    || planRow.candidate_input_hash.trim() !== lease.inputHash || !same(body.sourceExecution, sourceExecution)
    || planRow.execution_version !== 1 || planRow.input_revision !== sourceExecution.inputRevision
    || planRow.input_hash.trim() !== sourceExecution.inputHash
    || inputManifestHash(body) !== planRow.plan_hash.trim() || body.basisHash !== planRow.basis_hash.trim()
    || work.job_id !== lease.jobId || work.execution_version !== 1 || work.input_revision !== sourceExecution.inputRevision
    || work.input_hash.trim() !== sourceExecution.inputHash || !record(work.source_checkpoint)
    || inputManifestHash(work.source_checkpoint) !== work.checkpoint_hash.trim()
    || work.checkpoint_hash.trim() !== body.checkpointHash || planRow.checkpoint_hash.trim() !== body.checkpointHash
    || draft.base_input_revision !== sourceExecution.inputRevision || draft.base_input_hash.trim() !== sourceExecution.inputHash
    || draft.request_id !== body.receipt?.requestId || draft.request_hash.trim() !== body.receipt?.requestHash
    || draft.request_id !== planRow.receipt_request_id || draft.request_hash.trim() !== planRow.receipt_request_hash.trim()
    || !Array.isArray(draft.changes) || !draft.changes.every((v: unknown) => Value.Check(RunSupplementChangeSchema, v))
    || inputManifestHash({ request_id: draft.request_id, expected_revision: draft.revision - 1,
      base_input_revision: draft.base_input_revision, base_input_hash: draft.base_input_hash.trim(), changes: draft.changes }) !== draft.request_hash.trim())
    throw unavailable();
  readExecutionStages(work.source_checkpoint, sourceExecution);
  const adoption: RunSupplementTestAdoption = { id: receipt.id, runId: lease.runId, projectId: run.project_id,
    jobId: lease.jobId, testGrantId: receipt.test_grant_id, processingPlanId: receipt.processing_plan_id,
    requestId: receipt.request_id, adoptedAt: date(receipt.created_at), executionVersion: 2,
    inputRevision: lease.inputRevision, inputHash: lease.inputHash };
  const plan: RunSupplementProcessingPlan = { id: planRow.id, planHash: planRow.plan_hash.trim(),
    basisHash: planRow.basis_hash.trim(), body: structuredClone(body), createdAt: date(planRow.created_at) };
  return { run: run as PersistedRunExecutionRow, jobSubtype: run.job_subtype as string | null,
    adoption, plan, work, draft, sourceExecution };
}
