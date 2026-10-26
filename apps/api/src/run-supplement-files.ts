import type { Pool, PoolClient } from 'pg';
import { Value } from '@sinclair/typebox/value';
import { ProjectFileOperationSchema, ReviewDraftInputSchema, ReviewExecutionOriginSchema,
  ReviewExportRequestSchema, ReviewOperationSchema } from '@bondbuddy/contracts';
import { Problem, digest, transaction, type PrivateBlobs } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import { readRunExecutionInput } from './run-execution-input.js';
import { readCapturedSupplementResult } from './run-supplement-work.js';
import { extractRunFileReferences, type RunFileReference } from './run-file-reference.js';

/** Service-internal authority. No public DTO, artifact or download grant is created. */
export type CapturedSupplementFileSource =
  | { kind: 'provider_result'; resultId: string; resultSchemaVersion: string }
  | { kind: 'checkpoint'; field: 'correction_result' | 'project_file_result' };
export type CapturedSupplementFilePin = RunFileReference & {
  version: 'captured-supplement-file-v1'; owner: string; projectId: string; runId: string; revision: number;
  executionVersion: number; inputRevision: number; inputHash: string; checkpointHash: string; sourceHash: string;
  source: CapturedSupplementFileSource;
};
type Input = { db: Pool; blobs: PrivateBlobs; owner: string; projectId: string; runId: string;
  revision: number; source: CapturedSupplementFileSource };
const unavailable = () => new Problem(409, 'INPUT_REVISION_CONFLICT', '已保存工作文件暂时无法核对，请保留补料并核对原任务。');
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

async function workScope(db: Pool | PoolClient, input: Input) {
  const work = (await db.query(`SELECT w.* FROM bb_run_supplement_saved_work w
    JOIN bb_projects p ON p.owner_user_id=w.owner_user_id AND p.id=w.project_id AND p.deleted_at IS NULL
    JOIN bb_users u ON u.id=w.owner_user_id AND u.closed_at IS NULL AND u.status<>'closed'
    WHERE w.owner_user_id=$1 AND w.project_id=$2 AND w.run_id=$3 AND w.supplement_revision=$4`,
  [input.owner, input.projectId, input.runId, input.revision])).rows[0];
  if (!work || work.execution_version !== 1 || !record(work.source_checkpoint)
    || inputManifestHash(work.source_checkpoint) !== work.checkpoint_hash.trim()) throw unavailable();
  const frozen = await readRunExecutionInput(db, input.owner, input.runId, {
    executionVersion: work.execution_version, inputRevision: work.input_revision, inputHash: work.input_hash.trim(),
  });
  if (frozen.run.project_id !== input.projectId || !record(frozen.input.manifest)) throw unavailable();
  return { work, manifest: frozen.input.manifest as Record<string, any>, frozen };
}

type WorkScope = Awaited<ReturnType<typeof workScope>>;
const same = (a: unknown, b: unknown) => inputManifestHash(a ?? null) === inputManifestHash(b ?? null);
function correctionSource(scope: WorkScope, local: boolean): boolean {
  const review = scope.manifest.review;
  if (review?.file_delivery?.version !== 'review-correction-v2') return false;
  const execution = scope.frozen.reviewExecution, input = review.input, delivery = review.file_delivery;
  if (review.version !== 'review_v1' || !Value.Check(ReviewOperationSchema, review.operation)
    || !Value.Check(ReviewDraftInputSchema, input) || !input.source_material_ref
    || !execution || execution.version !== review.version_number || execution.operation !== review.operation
    || !record(execution.snapshot) || !same(execution.snapshot.input, input)
    || !same(execution.snapshot.origin, review.origin)
    || review.origin != null && !Value.Check(ReviewExecutionOriginSchema, review.origin)
    || !Array.isArray(scope.manifest.materials) || !scope.manifest.materials.some((pin: any) => record(pin)
      && same({material_id: pin.material_id, material_version: pin.material_version, sha256: pin.sha256}, input.source_material_ref))
    || !Array.isArray(delivery.knowledge) || !delivery.knowledge.every((item: any) => record(item)
      && typeof item.path === 'string' && typeof item.markdown === 'string' && digest(item.markdown) === item.sha256)) throw unavailable();
  if (local) {
    const pin = delivery.export;
    if (!record(pin) || Object.keys(pin).some(key => !['source_run_id','editor_sha256','decisions'].includes(key))
      || !Value.Check(ReviewExportRequestSchema, {request_id:'saved-file-scope',source_run_id:pin.source_run_id,
        expected_editor_sha256:pin.editor_sha256,decisions:pin.decisions})
      || pin.source_run_id === scope.frozen.run.id || execution.snapshot.export_only !== true
      || execution.snapshot.source_run_id !== pin.source_run_id) throw unavailable();
  }
  return true;
}

async function withSource<T>(input: Input, visit: (pins: CapturedSupplementFilePin[], db: PoolClient) => Promise<T>): Promise<T> {
  const describe = (work: any, refs: RunFileReference[], sourceHash: string): CapturedSupplementFilePin[] => refs.map(ref => ({
    ...ref, version: 'captured-supplement-file-v1', owner: input.owner, projectId: input.projectId,
    runId: input.runId, revision: input.revision, executionVersion: work.execution_version,
    inputRevision: work.input_revision, inputHash: work.input_hash.trim(), checkpointHash: work.checkpoint_hash.trim(),
    sourceHash, source: structuredClone(input.source),
  }));
  const source = input.source;
  if (source.kind === 'provider_result') {
    const scope = await workScope(input.db, input), { work } = scope;
    const row = (await input.db.query(`SELECT p.attempt_id,p.result_sha256 FROM bb_run_supplement_saved_results c
      JOIN bb_provider_result_refs p ON p.id=c.result_id AND p.attempt_id=c.attempt_id
        AND p.owner_user_id=c.owner_user_id AND p.project_id=c.project_id AND p.run_id=c.run_id
      WHERE c.owner_user_id=$1 AND c.project_id=$2 AND c.run_id=$3 AND c.supplement_revision=$4
        AND c.result_id=$5 AND p.result_schema_version=$6`,
    [input.owner, input.projectId, input.runId, input.revision, source.resultId, source.resultSchemaVersion])).rows[0];
    if (!row) throw unavailable();
    let result!: T;
    await readCapturedSupplementResult({ ...input, resultId: source.resultId, resultSchemaVersion: source.resultSchemaVersion,
      validate: async (value, db) => {
        let refs: RunFileReference[];
        try { refs = extractRunFileReferences({ scope: { owner: input.owner, projectId: input.projectId, runId: input.runId,
          inputHash: work.input_hash.trim(), source: 'provider', attemptId: row.attempt_id,
          ...(source.resultSchemaVersion === 'codex-review-file-v1'
            ? { reviewCorrection: correctionSource(scope, false) } : {}) },
          resultSchemaVersion: source.resultSchemaVersion, value }); } catch { throw unavailable(); }
        result = await visit(describe(work, refs, row.result_sha256.trim()), db);
        return true;
      } });
    return result;
  }
  if (source.kind !== 'checkpoint' || !['correction_result', 'project_file_result'].includes(source.field)) throw unavailable();
  return transaction(input.db, async db => {
    // Local output has no provider result. Serialize future file cleanup against
    // this exact immutable saved boundary, independently of public artifacts.
    await db.query("SELECT pg_advisory_xact_lock(hashtext('run_work_files'),hashtext($1::text))", [input.runId]);
    const scope = await workScope(db, input), { work, manifest, frozen } = scope;
    const correction = source.field === 'correction_result';
    const value = work.source_checkpoint.stages?.model_generation?.[source.field];
    if (!record(value)) throw unavailable();
    if (correction) { if (!correctionSource(scope, true)) throw unavailable(); }
    else {
      if (!Value.Check(ProjectFileOperationSchema, manifest) || frozen.run.task_kind !== 'generation') throw unavailable();
      const operation = (await db.query(`SELECT o.*,j.subtype FROM bb_project_file_operations o
        JOIN bb_jobs j ON j.owner_user_id=o.owner_user_id AND j.run_id=o.run_id
        WHERE o.owner_user_id=$1 AND o.project_id=$2 AND o.run_id=$3`,
      [input.owner, input.projectId, input.runId])).rows[0];
      if (!operation || operation.subtype !== 'project_file_v1' || operation.input_hash.trim() !== work.input_hash.trim()
        || !same(operation.manifest, manifest) || manifest.operation === 'patch'
          && (!operation.result_hash || operation.result_hash.trim() !== inputManifestHash(value)
            || !same(operation.result, value))) throw unavailable();
    }
    let refs: RunFileReference[];
    try { refs = extractRunFileReferences({ scope: { owner: input.owner, projectId: input.projectId, runId: input.runId,
      inputHash: work.input_hash.trim(), source: correction ? 'local_correction' : 'local_project_file' },
      resultSchemaVersion: correction ? 'codex-review-file-v1' : 'project-file-output-v1', value }); } catch { throw unavailable(); }
    return visit(describe(work, refs, inputManifestHash(value)), db);
  });
}

/** Metadata only: a listed pin is an exact source reference, not a byte-availability promise. */
export async function listCapturedSupplementFiles(input: Input): Promise<CapturedSupplementFilePin[]> {
  return withSource(input, async pins => pins);
}

/** Every read re-derives the complete pin from the immutable source and verifies the bytes.
 * A missing file never causes a provider retry, billing write or public artifact promotion. */
export async function readCapturedSupplementFile(input: Input & { pin: CapturedSupplementFilePin }): Promise<Buffer> {
  return withSource(input, async (pins, db) => {
    const pin = pins.find(value => value.name === input.pin.name);
    if (!pin || inputManifestHash(pin) !== inputManifestHash(input.pin)) throw unavailable();
    await db.query("SELECT pg_advisory_xact_lock(hashtext('run_file_object'),hashtext($1::text))", [pin.key]);
    // Account/project visibility can change while waiting for a content lock.
    await workScope(db, input);
    const registered=(await db.query(`SELECT o.*,s.stored_at,s.purge_started_at FROM bb_run_working_objects o
      LEFT JOIN bb_run_working_object_state s ON s.object_key=o.object_key WHERE o.object_key=$1`,[pin.key])).rows[0];
    if(registered&&(!registered.stored_at||registered.purge_started_at||registered.owner_user_id!==input.owner
      ||registered.project_id!==input.projectId||registered.run_id!==input.runId||registered.filename!==pin.name
      ||registered.sha256.trim()!==pin.sha256||Number(registered.byte_size)!==pin.byteSize||registered.media_type!==pin.mediaType))throw unavailable();
    let bytes: Buffer | null;
    try { bytes = await input.blobs.getIfExistsBounded(pin.key, pin.byteSize); } catch { throw unavailable(); }
    if (!bytes || bytes.length !== pin.byteSize || digest(bytes) !== pin.sha256) throw unavailable();
    return bytes;
  });
}
