import type { Pool, PoolClient } from 'pg';
import { Value } from '@sinclair/typebox/value';
import { isM4Manifest, ReviewDraftInputSchema, ReviewExecutionOriginSchema, ReviewOperationSchema, ReviewResultPinSchema } from '@bondbuddy/contracts';
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
  execution_version: number; input_revision: number; input_hash: string;
  operation: string; snapshot: Record<string, any>; [field: string]: any;
};
export type M4ExecutionInputSnapshot = {
  owner_user_id: string; project_id: string; run_id: string; topic_id: string; input_hash: string;
  execution_version: number; input_revision: number;
  manifest: Record<string, unknown>; [field: string]: any;
};
export type RunExecutionInput = {
  run: Awaited<ReturnType<typeof resolveRunExecution>>;
  input: RunExecutionInputRow;
  reviewExecution: ReviewExecutionInputSnapshot | null;
  m4Execution: M4ExecutionInputSnapshot | null;
};
const unavailable = () => new Problem(409, 'INPUT_REVISION_CONFLICT', 'Run execution input does not match its fixed identity');
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const same = (left: unknown, right: unknown) => inputManifestHash(left ?? null) === inputManifestHash(right ?? null);

function validReviewSnapshot(row: ReviewExecutionInputSnapshot, manifest: Record<string, any>, taskKind: string): boolean {
  if (!Number.isSafeInteger(row.version) || row.version < 1 || !Value.Check(ReviewOperationSchema, row.operation)
    || !record(row.snapshot) || !Value.Check(ReviewDraftInputSchema, row.snapshot.input)
    || row.snapshot.origin != null && !Value.Check(ReviewExecutionOriginSchema, row.snapshot.origin)) return false;
  if (Object.hasOwn(manifest, 'review')) {
    const review = manifest.review;
    return record(review) && review.version === 'review_v1' && row.version === review.version_number
      && row.operation === review.operation && same(row.source_report_id, review.source_report_id)
      && same(row.snapshot.input, review.input) && same(row.snapshot.origin, review.origin)
      && same(row.snapshot.finding_ids, review.finding_ids);
  }
  // Result revisions deliberately use unified authoring rather than manifest.review.
  const result = manifest.authoring?.review_result, input = row.snapshot.input;
  return taskKind === 'update' && row.operation === 'revision' && manifest.authoring?.version === 'unified_v1'
    && Value.Check(ReviewResultPinSchema, result) && Array.isArray(manifest.materials) && manifest.materials.every(record)
    && row.snapshot.source_run_id === result.run_id && same(input.source_material_ref, result.source_material)
    && input.material_versions.some((pin: unknown) => same(pin, result.source_material))
    && same(input.material_versions, manifest.materials.map(material => ({ material_id: material.material_id,
      material_version: material.material_version, sha256: material.sha256 })))
    && same(input.requirements, result.requirements ? [result.requirements] : []);
}

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
  const exact = [owner, run.project_id, runId, run.executionVersion, run.inputRevision, run.inputHash];
  const reviews = (await db.query(`SELECT * FROM bb_review_execution_snapshots
    WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3 AND execution_version=$4
      AND input_revision=$5 AND input_hash=$6`, exact)).rows as ReviewExecutionInputSnapshot[];
  const m4 = (await db.query(`SELECT e.* FROM bb_m4_execution_snapshots e
    JOIN bb_m4_topics t ON t.owner_user_id=e.owner_user_id AND t.project_id=e.project_id AND t.id=e.topic_id
    WHERE e.owner_user_id=$1 AND e.project_id=$2 AND e.run_id=$3 AND e.execution_version=$4
      AND e.input_revision=$5 AND e.input_hash=$6`, exact)).rows as M4ExecutionInputSnapshot[];
  const exactSnapshot = (row: ReviewExecutionInputSnapshot | M4ExecutionInputSnapshot) => row.owner_user_id === owner
    && row.project_id === run.project_id && row.run_id === runId && row.execution_version === run.executionVersion
    && row.input_revision === run.inputRevision && typeof row.input_hash === 'string' && row.input_hash.trim() === run.inputHash;
  const manifest = input.manifest;
  const needsReview = Object.hasOwn(manifest, 'review') || record(manifest.authoring) && Object.hasOwn(manifest.authoring, 'review_result');
  const needsM4 = typeof manifest.version === 'string' && manifest.version.startsWith('m4-');
  if (reviews.length > 1 || m4.length > 1
    || needsReview !== (reviews.length === 1) || needsM4 !== (m4.length === 1)
    || reviews.some(row => !exactSnapshot(row) || !validReviewSnapshot(row, manifest, run.task_kind))
    || m4.some(row => !exactSnapshot(row) || !isM4Manifest(row.manifest) || row.topic_id !== row.manifest.topic_id
      || !same(row.manifest, manifest) || run.task_kind !== (row.manifest.kind === 'document' ? 'generation' : 'qa')))
    throw unavailable();
  return { run, input, reviewExecution: reviews[0] ?? null, m4Execution: m4[0] ?? null };
}
