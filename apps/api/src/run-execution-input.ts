import type { Pool, PoolClient } from 'pg';
import { Problem } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import { resolveRunExecution, type RunExecutionIdentity } from './run-execution.js';

export type RunExecutionInputRow = {
  owner_user_id: string; project_id: string; revision: number; input_hash: string;
  draft_revision: number; material_versions: unknown; manifest: Record<string, unknown>;
  rule_pack_version: string | null; template_version: string | null;
  [field: string]: any;
};
export type ReviewExecutionInputSnapshot = {
  owner_user_id: string; project_id: string; run_id: string; version: number;
  operation: string; snapshot: Record<string, any>; [field: string]: any;
};
export type M4ExecutionInputSnapshot = {
  owner_user_id: string; run_id: string; topic_id: string; input_hash: string;
  manifest: Record<string, unknown>; [field: string]: any;
};
export type RunExecutionInput = {
  run: Awaited<ReturnType<typeof resolveRunExecution>>;
  input: RunExecutionInputRow;
  reviewExecution: ReviewExecutionInputSnapshot | null;
  m4Execution: M4ExecutionInputSnapshot | null;
};
const unavailable = () => new Problem(409, 'INPUT_REVISION_CONFLICT', 'Run execution input does not match its fixed identity');

/** Read only the resolved execution's exact input and owned immutable business snapshots. */
export async function readRunExecutionInput(db: Pool | PoolClient, owner: string, runId: string,
  expected: RunExecutionIdentity): Promise<RunExecutionInput> {
  const run = await resolveRunExecution(db, owner, runId, expected);
  if (run.id !== runId || run.owner_user_id !== owner) throw unavailable();
  const inputs = (await db.query(`SELECT * FROM bb_input_revisions
    WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3`, [owner, run.project_id, run.inputRevision])).rows;
  const input = inputs[0] as RunExecutionInputRow | undefined;
  if (inputs.length !== 1 || !input || input.owner_user_id !== owner || input.project_id !== run.project_id
    || input.revision !== run.inputRevision || typeof input.input_hash !== 'string'
    || input.input_hash.trim() !== run.inputHash || !input.manifest || typeof input.manifest !== 'object'
    || Array.isArray(input.manifest) || inputManifestHash(input.manifest) !== run.inputHash) throw unavailable();
  const reviews = (await db.query(`SELECT * FROM bb_review_executions
    WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3`, [owner, run.project_id, runId])).rows;
  const m4 = (await db.query(`SELECT e.* FROM bb_m4_executions e
    JOIN bb_m4_topics t ON t.owner_user_id=e.owner_user_id AND t.id=e.topic_id
    WHERE e.owner_user_id=$1 AND t.project_id=$2 AND e.run_id=$3`, [owner, run.project_id, runId])).rows;
  if (reviews.length > 1 || m4.length > 1
    || reviews.some(row => row.owner_user_id !== owner || row.project_id !== run.project_id || row.run_id !== runId)
    || m4.some(row => row.owner_user_id !== owner || row.run_id !== runId)) throw unavailable();
  return { run, input, reviewExecution: reviews[0] ?? null, m4Execution: m4[0] ?? null };
}
