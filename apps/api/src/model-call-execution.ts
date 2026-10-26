import type { Pool } from 'pg';
import { Problem } from './data.js';
import type { RunExecutionIdentity } from './run-execution.js';

export type ModelCallExecutionScope = RunExecutionIdentity & {
  owner: string; projectId: string; runId: string; jobId: string; attemptId: string;
};
export type ModelCallExecutionBinding = ModelCallExecutionScope & { promptSnapshotRef: string };
const unavailable = () => new Problem(409, 'INPUT_REVISION_CONFLICT', 'Model call does not match its exact execution input');

/** Existing work is selected by its attempt ID, then checked. A missing or
 * mismatched binding is never treated as permission to make another model call. */
export async function assertModelCallExecution(db: Pick<Pool, 'query'>,
  scope: ModelCallExecutionScope): Promise<ModelCallExecutionBinding> {
  const entries = (await db.query(`SELECT b.*,
      a.owner_user_id AS attempt_owner,a.job_id AS attempt_job,a.prompt_snapshot_id AS attempt_prompt,
      j.owner_user_id AS job_owner,j.run_id AS job_run,r.owner_user_id AS run_owner,r.project_id AS run_project,
      e.owner_user_id AS execution_owner,e.project_id AS execution_project,
      e.execution_version AS execution_version_ref,e.input_revision AS execution_input_revision,e.input_hash AS execution_input_hash,
      s.owner_user_id AS prompt_owner,s.project_id AS prompt_project,s.run_id AS prompt_run,s.snapshot_kind,
      s.input_revision AS prompt_input_revision,s.input_hash AS prompt_input_hash,i.input_hash AS revision_input_hash
    FROM bb_model_call_execution_bindings b
    JOIN bb_model_call_attempts a ON a.id=b.attempt_id
    JOIN bb_jobs j ON j.id=a.job_id
    JOIN bb_runs r ON r.id=j.run_id
    JOIN bb_run_execution_versions e ON e.run_id=b.run_id AND e.execution_version=b.execution_version
    JOIN bb_snapshot_refs s ON s.id=b.prompt_snapshot_ref
    JOIN bb_input_revisions i ON i.owner_user_id=b.owner_user_id AND i.project_id=b.project_id AND i.revision=b.input_revision
    WHERE b.attempt_id=$1`, [scope.attemptId])).rows;
  const row = entries[0];
  if (entries.length !== 1 || !row || row.attempt_id !== scope.attemptId || row.owner_user_id !== scope.owner
    || row.project_id !== scope.projectId || row.run_id !== scope.runId || row.job_id !== scope.jobId
    || row.execution_version !== scope.executionVersion || row.input_revision !== scope.inputRevision
    || typeof row.input_hash !== 'string' || row.input_hash.trim() !== scope.inputHash
    || row.attempt_owner !== scope.owner || row.attempt_job !== scope.jobId
    || row.job_owner !== scope.owner || row.job_run !== scope.runId || row.run_owner !== scope.owner || row.run_project !== scope.projectId
    || row.execution_owner !== scope.owner || row.execution_project !== scope.projectId
    || row.execution_version_ref !== scope.executionVersion || row.execution_input_revision !== scope.inputRevision
    || row.execution_input_hash?.trim() !== scope.inputHash || row.revision_input_hash?.trim() !== scope.inputHash
    || typeof row.prompt_snapshot_ref !== 'string' || !row.prompt_snapshot_ref || row.attempt_prompt !== row.prompt_snapshot_ref
    || row.prompt_owner !== scope.owner || row.prompt_project !== scope.projectId || row.prompt_run !== scope.runId
    || row.snapshot_kind !== 'model_request' || row.prompt_input_revision !== scope.inputRevision
    || row.prompt_input_hash?.trim() !== scope.inputHash) throw unavailable();
  return { ...scope, promptSnapshotRef: row.prompt_snapshot_ref };
}
