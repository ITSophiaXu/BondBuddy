import type { Pool } from 'pg';
import type { RunSupplementMaterial } from '@bondbuddy/contracts';
import { digest, Problem, type PrivateBlobs } from './data.js';
import type { Lease } from './queue.js';
import { inputManifestHash } from './production-rule-pin.js';
import { readAdoptedRunSupplementSourceInput, readRunExecutionInput } from './run-execution-input.js';
import { assertAdoptedRunSupplementScope } from './run-supplement-adopted-scope.js';
import { compileRunSupplementInput } from './run-supplement-input.js';
import { readExecutionStages } from './run-execution.js';
import { readCapturedSupplementResult } from './run-supplement-work.js';
import { listCapturedSupplementFiles, readCapturedSupplementFile, type CapturedSupplementFilePin } from './run-supplement-files.js';
import type { RunSupplementProcessingBasis, RunSupplementProcessingKind } from './run-supplement-preparation.js';

export type ReadAdoptedRunSupplementExecutionInput = { pool: Pool; blobs: PrivateBlobs; lease: Lease; kind: RunSupplementProcessingKind };
const unavailable = () => new Problem(409, 'INPUT_REVISION_CONFLICT', '补料续做的固定材料或已保存工作暂时无法核对，请保留原任务。');
const same = (a: unknown, b: unknown) => inputManifestHash(a ?? null) === inputManifestHash(b ?? null);
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const config = {
  authoring: { schema: 'codex-file-word-v1', logical: 'file-authoring-v1', prompt: 'file_authoring_v1_prompt', tasks: ['update', 'generation'] },
  review: { schema: 'codex-review-file-v1', logical: 'review-file-v1', prompt: 'review_file_v1_prompt', tasks: ['review'] },
  m4: { schema: 'codex-m4-document-v1', logical: 'm4-document-v1', prompt: 'm4_document_v1_prompt', tasks: ['generation'] },
} as const;

/** Recover the exact adopted basis without pretending the job is still paused.
 * Recompile from its immutable source and supplement, byte-check the saved work,
 * then recheck authority and material visibility after all independent I/O.
 * Repeated reads remain valid after new V2 stages/attempts have been journaled. */
export async function readAdoptedRunSupplementExecution(input: ReadAdoptedRunSupplementExecutionInput) {
  const { pool, blobs, lease, kind } = input;
  const scope = await assertAdoptedRunSupplementScope(pool, { lease }, kind);
  const { adoption, plan, work, draft, sourceExecution } = scope;
  const owner = lease.owner, projectId = adoption.projectId, runId = lease.runId, revision = work.supplement_revision;
  const authority = { lease, authorizationId: adoption.id };
  const source = await readAdoptedRunSupplementSourceInput(pool, authority);
  const target = await readRunExecutionInput(pool, owner, runId, lease);
  const sourceManifest = source.input.manifest as Record<string, any>, manifest = target.input.manifest as Record<string, any>;
  if (!(config[kind].tasks as readonly string[]).includes(scope.run.task_kind)
    || kind === 'm4' && scope.jobSubtype !== 'm4_document_v1'
    || kind === 'authoring' && (sourceManifest.review || sourceManifest.authoring?.version !== 'unified_v1'
      || Object.hasOwn(sourceManifest.authoring, 'review_result') || Object.hasOwn(sourceManifest.authoring, 'review_revision'))
    || kind === 'review' && (!['full_review', 'differential_review'].includes(sourceManifest.review?.operation)
      || !['review-file-v1', 'review-correction-v2'].includes(sourceManifest.review?.file_delivery?.version))) throw unavailable();
  if (!Array.isArray(plan.body.materials) || !plan.body.materials.length || plan.body.materials.length > 240) throw unavailable();
  const materials: Array<RunSupplementProcessingBasis['materials'][number]> = [];
  const resultMaterials: RunSupplementMaterial[] = [];
  const materialRows: any[] = [];
  async function material(pin: typeof plan.body.materials[number]) {
    const sourceProject = 'source_project_id' in pin ? pin.source_project_id : projectId;
    const row = (await pool.query(`SELECT m.* FROM bb_material_versions m JOIN bb_projects p
      ON p.owner_user_id=m.owner_user_id AND p.id=m.project_id JOIN bb_users u ON u.id=m.owner_user_id
      WHERE m.owner_user_id=$1 AND m.project_id=$2 AND m.id=$3 AND m.version=$4
        AND m.deleted_at IS NULL AND p.deleted_at IS NULL AND u.closed_at IS NULL AND u.status<>'closed'`,
    [owner, sourceProject, pin.material_id, pin.material_version])).rows[0];
    if (!row || row.sha256.trim() !== pin.sha256 || row.role !== pin.role || !row.object_key
      || !Number.isSafeInteger(Number(row.byte_size)) || Number(row.byte_size) < 1 || Number(row.byte_size) > 100 * 1024 * 1024) throw unavailable();
    return row;
  }
  for (const pin of plan.body.materials) {
    const row = await material(pin);
    let bytes: Buffer | null;
    try { bytes = await blobs.getIfExistsBounded(row.object_key, Number(row.byte_size)); } catch { throw unavailable(); }
    if (!bytes || bytes.length !== Number(row.byte_size) || digest(bytes) !== pin.sha256) throw unavailable();
    materials.push({ pin: structuredClone(pin), filename: row.filename, mediaType: row.media_type, objectKey: row.object_key });
    resultMaterials.push({ material_id: pin.material_id, material_version: pin.material_version, sha256: pin.sha256,
      source_project_id: row.project_id, role: row.role, filename: row.filename, media_type: row.media_type, available: true });
    materialRows.push(row);
  }
  const candidate = compileRunSupplementInput({ projectId, manifest: sourceManifest,
    reviewSnapshot: source.reviewExecution?.snapshot ?? null, resultMaterials, changes: draft.changes,
    reviewIdentityContext: { owner, runId, baseExecution: sourceExecution,
      supplement: { revision, requestId: draft.request_id, requestHash: draft.request_hash.trim() } } });
  if (candidate.preview.status !== 'prepared' || !candidate.candidate || candidate.preview.candidate_input_hash !== lease.inputHash
    || !same(candidate.candidate.manifest, manifest)
    || !same(candidate.candidate.reviewSnapshot, target.reviewExecution?.snapshot ?? null)) throw unavailable();
  const stages = readExecutionStages(work.source_checkpoint, sourceExecution), prior = plan.body.priorWork;
  const filesInput = { db: pool, blobs, owner, projectId, runId, revision, adopted: authority };
  if (plan.body.priorWorkStatus === 'no_prior_work') {
    if (prior !== null || stages.model_generation !== undefined
      || work.source_checkpoint.provider_results !== undefined && !same(work.source_checkpoint.provider_results, [])) throw unavailable();
    // V2 work is expected on retry. Only the historical execution must be empty.
    const history = (await pool.query(`SELECT 1 FROM bb_model_call_execution_bindings WHERE owner_user_id=$1
      AND project_id=$2 AND run_id=$3 AND execution_version=1
      UNION ALL SELECT 1 FROM bb_run_working_sources WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3 AND execution_version=1
      UNION ALL SELECT 1 FROM bb_run_supplement_saved_results WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3 AND supplement_revision=$4 LIMIT 1`,
    [owner, projectId, runId, revision])).rows;
    if (history.length) throw unavailable();
    const prompt = stages[config[kind].prompt];
    if (prompt !== undefined) {
      const saved = (await pool.query(`SELECT 1 FROM bb_snapshot_refs s WHERE s.id=$1 AND s.owner_user_id=$2
        AND s.project_id=$3 AND s.run_id=$4 AND s.snapshot_kind='model_request' AND s.input_revision=$5 AND s.input_hash=$6
        AND NOT EXISTS(SELECT 1 FROM bb_log_content_tombstones t WHERE t.content_kind='prompt_snapshot' AND t.content_id=s.id)`,
      [prompt.snapshot_id, owner, projectId, runId, sourceExecution.inputRevision, sourceExecution.inputHash])).rows[0];
      if (!saved) throw unavailable();
    }
  } else {
    const model = stages.model_generation;
    if (plan.body.priorWorkStatus !== 'captured_complete' || !prior || !record(model)
      || prior.source.kind !== 'provider_result' || prior.source.resultSchemaVersion !== config[kind].schema
      || model.logical_call_id !== config[kind].logical || stages[config[kind].prompt]?.snapshot_id !== model.prompt_snapshot_ref) throw unavailable();
    const selected = (await pool.query(`SELECT p.* FROM bb_run_supplement_saved_results c JOIN bb_provider_result_refs p
      ON p.id=c.result_id AND p.attempt_id=c.attempt_id AND p.owner_user_id=c.owner_user_id AND p.project_id=c.project_id AND p.run_id=c.run_id
      WHERE c.owner_user_id=$1 AND c.project_id=$2 AND c.run_id=$3 AND c.supplement_revision=$4 AND c.result_id=$5
        AND p.job_id=$6 AND p.logical_call_id=$7 AND p.prompt_snapshot_ref=$8 AND p.result_schema_version=$9 AND p.result_sha256=$10`,
    [owner, projectId, runId, revision, prior.source.resultId, lease.jobId, model.logical_call_id, model.prompt_snapshot_ref,
      config[kind].schema, prior.resultHash])).rows;
    if (selected.length !== 1) throw unavailable();
    let metadata: Record<string, unknown> = {};
    await readCapturedSupplementResult({ ...filesInput, resultId: prior.source.resultId, resultSchemaVersion: config[kind].schema,
      validate: value => {
        if (!record(value) || Object.hasOwn(value, 'error')) return false;
        if (kind === 'm4') {
          const method = stages.m4_document_method;
          if (!record(method) || method.version !== 'm4-document-method-v1' || inputManifestHash(method) !== value.method_hash
            || method.skill_sha256 !== value.skill_sha256) return false;
          metadata = { method_hash: value.method_hash, skill_sha256: value.skill_sha256 };
        }
        return true;
      } });
    const files = await listCapturedSupplementFiles({ ...filesInput, source: prior.source });
    if (!same(files, prior.files) || !same(metadata, prior.metadata)) throw unavailable();
    for (const pin of files) await readCapturedSupplementFile({ ...filesInput, source: prior.source, pin });
  }
  const basisBody = { version: 'run-supplement-processing-basis-v1' as const, kind, owner, projectId, runId, revision,
    requestId: draft.request_id, requestHash: draft.request_hash.trim(), sourceExecution, checkpointHash: plan.body.checkpointHash,
    candidateInputHash: lease.inputHash, manifest, materials: materials as RunSupplementProcessingBasis['materials'],
    delta: { ...structuredClone(plan.body.delta), sourceProspectuses: { previous: structuredClone(sourceManifest.authoring?.source_prospectuses ?? []),
      current: structuredClone(manifest.authoring?.source_prospectuses ?? []) } },
    priorWork: structuredClone(prior), reviewSnapshot: candidate.candidate.reviewSnapshot, priorWorkStatus: plan.body.priorWorkStatus };
  const basis: RunSupplementProcessingBasis = { ...basisBody, basisHash: inputManifestHash(basisBody) };
  if (basis.basisHash !== plan.basisHash) throw unavailable();
  for (let i = 0; i < plan.body.materials.length; i++) {
    const current = await material(plan.body.materials[i]), original = materialRows[i];
    if (['filename', 'media_type', 'object_key', 'byte_size'].some(key => String(current[key]) !== String(original[key]))) throw unavailable();
  }
  const final = await assertAdoptedRunSupplementScope(pool, authority, kind);
  if (final.plan.planHash !== plan.planHash || !same(final.work.source_checkpoint, work.source_checkpoint)) throw unavailable();
  return { adoption, plan, basis, source: { ...source, checkpoint: structuredClone(work.source_checkpoint) } };
}

/** Pin/source selection comes only from the adopted plan. A caller cannot choose
 * another paused draft, provider result or historical file in the same run. */
export async function readAdoptedRunSupplementFile(input: ReadAdoptedRunSupplementExecutionInput & { pin: CapturedSupplementFilePin }): Promise<Buffer> {
  const { adoption, plan, work } = await assertAdoptedRunSupplementScope(input.pool, { lease: input.lease }, input.kind);
  const prior = plan.body.priorWork;
  const pin = prior?.files.find(file => same(file, input.pin));
  if (!prior || !pin || plan.body.priorWorkStatus !== 'captured_complete') throw unavailable();
  const bytes = await readCapturedSupplementFile({ db: input.pool, blobs: input.blobs, owner: input.lease.owner,
    projectId: adoption.projectId, runId: input.lease.runId, revision: work.supplement_revision,
    adopted: { lease: input.lease, authorizationId: adoption.id }, source: prior.source, pin });
  await assertAdoptedRunSupplementScope(input.pool, { lease: input.lease, authorizationId: adoption.id }, input.kind);
  return bytes;
}
