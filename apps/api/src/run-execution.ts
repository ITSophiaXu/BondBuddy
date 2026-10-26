import type { Pool, PoolClient } from 'pg';
import { Problem, run } from './data.js';

/** Internal execution identity, carried by every run lease. No successor is executable yet. */
export type RunExecutionIdentity = { executionVersion: number; inputRevision: number; inputHash: string };
type ExecutionRun = { id: string; owner_user_id: string; project_id: string; input_revision: number; input_hash: string };
type Db = Pick<Pool, 'query'>;
const unavailable = () => new Problem(409, 'INPUT_REVISION_CONFLICT', 'Run execution identity does not match its fixed input');

/** Call after run -> job locks in mutation paths; never fall back when identity is absent. */
export async function assertRunExecution(db: Db, row: ExecutionRun, expected?: RunExecutionIdentity): Promise<RunExecutionIdentity> {
  const entries = (await db.query(`SELECT execution_version,input_revision,input_hash FROM bb_run_execution_versions
    WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3`, [row.owner_user_id, row.project_id, row.id])).rows;
  const entry = entries[0];
  if (entries.length !== 1 || entry.execution_version !== 1 || entry.input_revision !== row.input_revision
    || entry.input_hash.trim() !== row.input_hash.trim()) throw unavailable();
  const identity = { executionVersion: entry.execution_version, inputRevision: entry.input_revision, inputHash: entry.input_hash.trim() };
  if (expected && (expected.executionVersion !== identity.executionVersion || expected.inputRevision !== identity.inputRevision
    || expected.inputHash !== identity.inputHash)) throw unavailable();
  return identity;
}

/** Real worker input resolution. The initial version is the only supported execution. */
export async function resolveRunExecution(db: Pool | PoolClient, owner: string, runId: string, expected: RunExecutionIdentity) {
  if (!expected) throw unavailable();
  const row = await run(db, owner, runId);
  return { ...row, ...await assertRunExecution(db, row, expected) };
}
