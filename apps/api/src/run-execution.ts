import type { Pool, PoolClient } from 'pg';
import type { RUN_BILLING_MODES, TestUncoveredItem } from '@bondbuddy/contracts';
import { Problem, run } from './data.js';

/** Internal execution identity, carried by every run lease. No successor is executable yet. */
export type RunExecutionIdentity = { executionVersion: number; inputRevision: number; inputHash: string };

/** Database run identity. These input fields always describe the original request. */
export type PersistedRunInput = {
  id: string; owner_user_id: string; project_id: string; input_revision: number; input_hash: string;
  readonly originInput?: never;
};
export type PersistedRunExecutionRow = PersistedRunInput & {
  state: string; stage: string | null; task_kind: string; created_at: Date; event_cursor: number;
  billing_mode?: (typeof RUN_BILLING_MODES)[number];
  channel?: 'production' | 'non_production_test'; test_grant_id?: string | null;
  uncovered_items?: TestUncoveredItem[] | null;
};
const executionProjection = Symbol('runExecutionProjection');
export type RunExecutionProjection<T extends PersistedRunInput = PersistedRunExecutionRow> =
  Omit<T, 'input_revision' | 'input_hash' | 'originInput'> & Readonly<RunExecutionIdentity> & {
    readonly [executionProjection]: true;
    readonly originInput: Readonly<{ inputRevision: number; inputHash: string }>;
    /** Compatibility fields for stage consumers: always the resolved execution's input. */
    readonly input_revision: number; readonly input_hash: string;
  };

function validInput(revision: number, hash: string): boolean {
  return Number.isSafeInteger(revision) && revision > 0 && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
}

/** Pure projection only; it grants no execution, billing or successor authorization.
 * Callers must first resolve and assert the durable execution against the raw run. */
export function projectRunExecution<T extends PersistedRunInput>(row: T, identity: RunExecutionIdentity): RunExecutionProjection<T> {
  if ('originInput' in row || 'executionVersion' in row || 'inputRevision' in row || 'inputHash' in row
    || !validInput(row.input_revision, row.input_hash?.trim())
    || !Number.isSafeInteger(identity.executionVersion) || identity.executionVersion < 1
    || !validInput(identity.inputRevision, identity.inputHash)) throw unavailable();
  return Object.freeze({ ...row, [executionProjection]: true as const,
    originInput: Object.freeze({ inputRevision: row.input_revision, inputHash: row.input_hash.trim() }),
    executionVersion: identity.executionVersion, inputRevision: identity.inputRevision, inputHash: identity.inputHash,
    input_revision: identity.inputRevision, input_hash: identity.inputHash });
}

/** Explicitly recover the original request identity for a database assertion.
 * An unbranded lookalike or conflicting execution aliases must never become origin. */
export function runExecutionOrigin(row: PersistedRunInput | RunExecutionProjection<PersistedRunInput>): PersistedRunInput {
  let revision = row.input_revision, hash = row.input_hash;
  if (executionProjection in row) {
    if (row[executionProjection] !== true || !row.originInput
      || !Number.isSafeInteger(row.executionVersion) || row.executionVersion < 1
      || row.inputRevision !== revision || row.inputHash !== hash) throw unavailable();
    revision = row.originInput.inputRevision; hash = row.originInput.inputHash;
  } else if ('originInput' in row || 'executionVersion' in row || 'inputRevision' in row || 'inputHash' in row) throw unavailable();
  if (!validInput(revision, hash?.trim()) || !validInput(row.input_revision, row.input_hash?.trim())) throw unavailable();
  return { id: row.id, owner_user_id: row.owner_user_id, project_id: row.project_id, input_revision: revision, input_hash: hash.trim() };
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
type ExecutionStages = Record<string, Record<string, unknown>>;

/** The job has one active stage set. Historical sets live in immutable saved-work
 * receipts; provider results and operator reconciliations remain job-wide history.
 * Callers must resolve the persisted execution before using this pure reader. */
export function readExecutionStages(checkpoint: unknown, identity: RunExecutionIdentity): ExecutionStages {
  if (!record(checkpoint) || !Number.isSafeInteger(identity.executionVersion) || identity.executionVersion < 1
    || !Number.isSafeInteger(identity.inputRevision) || identity.inputRevision < 1 || !/^[a-f0-9]{64}$/.test(identity.inputHash)) throw unavailable();
  if (Object.hasOwn(checkpoint, 'stage_execution')) {
    const stamp = checkpoint.stage_execution;
    if (!record(stamp) || stamp.execution_version !== identity.executionVersion || stamp.input_revision !== identity.inputRevision
      || stamp.input_hash !== identity.inputHash) throw unavailable();
  } else if (identity.executionVersion !== 1) throw unavailable();
  const stages = checkpoint.stages;
  if (stages === undefined) return {};
  if (!record(stages) || Object.values(stages).some(value => !record(value))) throw unavailable();
  return stages as ExecutionStages;
}

/** Never repair a conflicting stamp by overwriting it. Only exact V1 legacy
 * checkpoints can receive their first stamp without an adoption transaction. */
export function stampExecutionCheckpoint(checkpoint: Record<string, unknown>, identity: RunExecutionIdentity): Record<string, unknown> {
  readExecutionStages(checkpoint, identity);
  return { ...checkpoint, stage_execution: { execution_version: identity.executionVersion,
    input_revision: identity.inputRevision, input_hash: identity.inputHash } };
}
type Db = Pick<Pool, 'query'>;
const unavailable = () => new Problem(409, 'INPUT_REVISION_CONFLICT', 'Run execution identity does not match its fixed input');

/** Call after run -> job locks in mutation paths; never fall back when identity is absent. */
export async function assertRunExecution(db: Db, row: PersistedRunInput, expected?: RunExecutionIdentity): Promise<RunExecutionIdentity> {
  if ('originInput' in row || 'executionVersion' in row || 'inputRevision' in row || 'inputHash' in row) throw unavailable();
  const entries = (await db.query(`SELECT e.execution_version,e.input_revision,e.input_hash FROM bb_run_execution_versions e
    WHERE e.owner_user_id=$1 AND e.project_id=$2 AND e.run_id=$3
      AND EXISTS(SELECT 1 FROM bb_run_execution_heads h WHERE h.owner_user_id=e.owner_user_id
        AND h.project_id=e.project_id AND h.run_id=e.run_id AND h.execution_version=e.execution_version
        AND h.input_revision=e.input_revision AND h.input_hash=e.input_hash)
      AND (SELECT count(*) FROM bb_run_execution_versions all_versions WHERE all_versions.owner_user_id=e.owner_user_id
        AND all_versions.project_id=e.project_id AND all_versions.run_id=e.run_id)=1`, [row.owner_user_id, row.project_id, row.id])).rows;
  const entry = entries[0];
  if (entries.length !== 1 || entry.execution_version !== 1 || entry.input_revision !== row.input_revision
    || entry.input_hash.trim() !== row.input_hash.trim()) throw unavailable();
  const identity = { executionVersion: entry.execution_version, inputRevision: entry.input_revision, inputHash: entry.input_hash.trim() };
  if (expected && (expected.executionVersion !== identity.executionVersion || expected.inputRevision !== identity.inputRevision
    || expected.inputHash !== identity.inputHash)) throw unavailable();
  return identity;
}

/** Real worker input resolution. The initial version is the only supported execution. */
export async function resolveRunExecution(db: Pool | PoolClient, owner: string, runId: string,
  expected: RunExecutionIdentity): Promise<RunExecutionProjection> {
  if (!expected) throw unavailable();
  const row: PersistedRunExecutionRow = await run(db, owner, runId);
  return projectRunExecution(row, await assertRunExecution(db, row, expected));
}
