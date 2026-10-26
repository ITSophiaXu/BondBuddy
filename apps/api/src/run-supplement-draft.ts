import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { Value } from '@sinclair/typebox/value';
import {
  M1_UPLOAD_MATERIAL_ROLES, ReviewDraftInputSchema, ReviewMaterialPinSchema, ReviewResultPinSchema,
  RunSupplementDraftRequestSchema, RunSupplementDraftQuerySchema, RunSupplementDraftResponseSchema,
  type ReviewMaterialPin, type RunSupplementChange, type RunSupplementDraftRequest,
  type RunSupplementDraftResponse, type RunSupplementMaterial,
} from '@bondbuddy/contracts';
import { conflict, date, missing, Problem, run, transaction, uid } from './data.js';
import { assertTestChannelReadable } from './non-production-test.js';
import { inputManifestHash } from './production-rule-pin.js';
import { providerCallNeedsReconciliation } from './queue.js';
import { assertRunExecution, type RunExecutionIdentity } from './run-execution.js';
import { readRunExecutionInput } from './run-execution-input.js';
import { compileRunSupplementInput, runSupplementSourceContext, validRunSupplementSourceChanges } from './run-supplement-input.js';
import { captureRunSupplementWork, runSupplementWorkSummary } from './run-supplement-work.js';

type BasePin = ReviewMaterialPin & { source_project_id: string; role?: string };
type Base = { pins: BasePin[]; supported: boolean; manifest: Record<string, any>; reviewSnapshot: unknown | null;
  execution: RunExecutionIdentity };
function invalid(message: string): never { throw new Problem(422, 'VALIDATION_FAILED', message); }
function corrupt(): never { throw new Problem(503, 'DATA_UNAVAILABLE', '原任务的固定输入暂时无法读取，请稍后重试。'); }
function stale(): never { throw conflict('INPUT_REVISION_CONFLICT', '补料草稿或原任务版本已变化，请刷新后重试。'); }
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const pinKey = (pin: ReviewMaterialPin) => `${pin.material_id}\0${pin.material_version}\0${pin.sha256}`;
const same = (a: unknown, b: unknown) => inputManifestHash(a) === inputManifestHash(b);

/** Result follow-ups use unified authoring, with a separate immutable review snapshot. */
function reviewResultSnapshotMatches(manifest: Record<string, any>, execution: any, taskKind: string, materials: unknown[]) {
  if (taskKind !== 'update' || execution.operation !== 'revision' || !record(execution.snapshot)
    || !Value.Check(ReviewDraftInputSchema, execution.snapshot.input) || !record(manifest.authoring) || manifest.authoring.version !== 'unified_v1'
    || !Value.Check(ReviewResultPinSchema, manifest.authoring.review_result) || !materials.every(record)) return false;
  const result = manifest.authoring.review_result, input = execution.snapshot.input;
  return execution.snapshot.source_run_id === result.run_id
    && same(input.source_material_ref, result.source_material)
    && input.material_versions.some((pin: unknown) => same(pin, result.source_material))
    && same(input.material_versions, materials.map(material => ({ material_id: material.material_id,
      material_version: material.material_version, sha256: material.sha256 })))
    && same(input.requirements, result.requirements ? [result.requirements] : []);
}

/** Read the accepted input, never the project's later editable draft. */
async function frozenBase(db: Pool | PoolClient, owner: string, r: any, job: any): Promise<Base> {
  // Share the exact input reader used by real worker consumers. The caller has
  // already checked the run identity; unreadable frozen input remains a 503.
  let frozen;
  try { frozen = await readRunExecutionInput(db, owner, r.id, {
    executionVersion: 1, inputRevision: r.input_revision, inputHash: r.input_hash.trim(),
  }); } catch (error) {
    if (error instanceof Problem && error.code === 'INPUT_REVISION_CONFLICT') corrupt();
    throw error;
  }
  const { input, reviewExecution, m4Execution } = frozen;
  if (!input || !record(input.manifest) || input.input_hash.trim() !== r.input_hash.trim()
    || inputManifestHash(input.manifest) !== r.input_hash.trim()) corrupt();
  const manifest = input.manifest;
  let raw: unknown[], supported = false;
  if (job?.subtype === 'm4_document_v1') {
    const execution = m4Execution;
    if (!execution || execution.input_hash.trim() !== r.input_hash.trim() || !same(execution.manifest, manifest)
      || manifest.version !== 'm4-document-input-v1' || manifest.kind !== 'document'
      || !record(manifest.input) || !Array.isArray(manifest.input.materials)) corrupt();
    raw = [...manifest.input.materials, ...(manifest.input.source_material ? [manifest.input.source_material] : []),
      ...(manifest.template_material ? [manifest.template_material] : [])];
    supported = r.task_kind === 'generation';
  } else {
    if (!Array.isArray(manifest.materials)) raw = [];
    else raw = manifest.materials;
    const execution = reviewExecution;
    const hasReviewResult = record(manifest.authoring) && Object.hasOwn(manifest.authoring, 'review_result');
    if ((manifest.review || hasReviewResult) && !execution) corrupt();
    if (execution) {
      if (manifest.review) {
        if (!record(execution.snapshot) || !record(manifest.review) || manifest.review.version !== 'review_v1'
          || !record(execution.snapshot.input) || !record(manifest.review.input)
          || !same(execution.snapshot.input, manifest.review.input) || execution.version !== manifest.review.version_number
          || execution.operation !== manifest.review.operation || !same(execution.snapshot.origin ?? null, manifest.review.origin ?? null)) corrupt();
      } else if (!reviewResultSnapshotMatches(manifest, execution, r.task_kind, raw)) corrupt();
    }
    supported = ['update', 'review', 'generation'].includes(r.task_kind) && Array.isArray(manifest.materials)
      && (!String(job?.subtype).startsWith('m4_'));
  }
  const pins: BasePin[] = [], seen = new Set<string>();
  for (const value of raw) {
    if (!record(value)) corrupt();
    const pin = { material_id: value.material_id, material_version: value.material_version, sha256: value.sha256 };
    if (!Value.Check(ReviewMaterialPinSchema, pin)) corrupt();
    const source = value.source_project_id ?? r.project_id;
    if (typeof source !== 'string' || !source || value.role !== undefined
      && !(M1_UPLOAD_MATERIAL_ROLES as readonly string[]).includes(value.role)) corrupt();
    const key = `${source}\0${pinKey(pin)}`;
    // M4 may cite its source or template twice; it remains one exact base pin.
    if (seen.has(key)) continue;
    seen.add(key); pins.push({ ...pin, source_project_id: source, ...(value.role ? { role: value.role } : {}) });
  }
  if (pins.length > 240) corrupt();
  return { pins, supported, manifest, reviewSnapshot: reviewExecution?.snapshot ?? null,
    execution: { executionVersion: frozen.run.executionVersion, inputRevision: frozen.run.inputRevision, inputHash: frozen.run.inputHash } };
}

async function materialDetails(db: Pool | PoolClient, owner: string, pin: BasePin): Promise<RunSupplementMaterial> {
  const material = (await db.query(`SELECT m.*,p.deleted_at AS project_deleted_at
    FROM bb_material_versions m JOIN bb_projects p ON p.owner_user_id=m.owner_user_id AND p.id=m.project_id
    WHERE m.owner_user_id=$1 AND m.project_id=$2 AND m.id=$3 AND m.version=$4`,
  [owner, pin.source_project_id, pin.material_id, pin.material_version])).rows[0];
  const role = pin.role ?? material?.role;
  if (!(M1_UPLOAD_MATERIAL_ROLES as readonly string[]).includes(role)) corrupt();
  return { material_id: pin.material_id, material_version: pin.material_version, sha256: pin.sha256,
    source_project_id: pin.source_project_id, filename: material?.filename || pin.material_id,
    role: role as RunSupplementMaterial['role'], media_type: material?.media_type || 'application/octet-stream',
    available: !!material && !material.deleted_at && !material.project_deleted_at && material.sha256.trim() === pin.sha256
      && material.role === role };
}

async function saveBlock(db: PoolClient, owner: string, r: any, job: any, base: Base): Promise<string | null> {
  const p = (await db.query('SELECT archived_at FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL', [owner, r.project_id])).rows[0];
  if (!p) throw missing();
  if (p.archived_at) return '请先恢复已归档项目，再准备补充材料。';
  if (!base.supported) return '当前任务不支持保存补料草稿。';
  if (!job || r.state !== 'paused' || job.state !== 'paused' || !job.user_pause_requested)
    return '请先手动暂停任务，等待已有工作保存完毕后再准备补充材料。';
  if (job.lease_token || job.lease_until) return '任务仍在保存已有工作，请等待暂停完成后重试。';
  if (await providerCallNeedsReconciliation(db, job.id)) return '上次模型调用仍待核对，完成核对后才能保存补料草稿。';
  return null;
}

async function validateChanges(db: PoolClient, owner: string, projectId: string, base: RunSupplementMaterial[], changes: RunSupplementChange[], manifest: unknown) {
  const added = new Set<string>(), replaced = new Set<string>(), identities = new Set<string>();
  for (const change of changes) {
    const key = pinKey(change.material);
    if (added.has(key) || identities.has(change.material.material_id)) invalid('同一补充材料只能采用一个准确版本。');
    added.add(key); identities.add(change.material.material_id);
    const row = (await db.query(`SELECT m.* FROM bb_material_versions m
      WHERE m.owner_user_id=$1 AND m.project_id=$2 AND m.id=$3 AND m.version=$4
        AND m.deleted_at IS NULL FOR SHARE`, [owner, projectId, change.material.material_id, change.material.material_version])).rows[0];
    if (!row || row.sha256.trim() !== change.material.sha256) stale();
    const material = await materialDetails(db, owner, { ...change.material, source_project_id: projectId });
    if (!material.available) stale();
    if (!validRunSupplementSourceChanges(manifest, [change], [material]))
      invalid('原稿声明必须属于本次 M1 补料的准确历史／参考稿版本；旧成果关联只能在原任务已有关联时明确放弃。');
    if (base.some(pin => pinKey(pin) === key)) invalid('该材料版本已在原任务中，无需再次补充。');
    if (change.replaces) {
      const replacement = pinKey(change.replaces), original = base.find(pin => pinKey(pin) === replacement);
      if (!original || replaced.has(replacement)) invalid('替换对象必须是原任务中的准确材料版本，且只能替换一次。');
      if (original.role !== material.role) invalid('替换材料的分类必须与原任务材料一致。');
      if (base.some(pin => pin.material_id === change.material.material_id && pin.material_id !== original.material_id))
        invalid('原材料的新版本只能替换该材料自己的原版本。');
      replaced.add(replacement);
    } else if (base.some(pin => pin.material_id === change.material.material_id))
      invalid('原材料的新版本必须明确选择替换对象。');
  }
}

/** Internal reader shared by the receipt response and native-file continuation
 * preparation. A candidate remains data and never grants execution authority. */
export async function readRunSupplementCandidate(db: Pool | PoolClient, owner: string, r: any, job: any, receipt: any, frozen?: Base) {
  const base = frozen ?? await frozenBase(db, owner, r, job);
  const baseMaterials = await Promise.all(base.pins.map(pin => materialDetails(db, owner, pin)));
  const changes = (receipt?.changes ?? []) as RunSupplementChange[];
  const additions = await Promise.all(changes.map(change => materialDetails(db, owner, { ...change.material, source_project_id: r.project_id })));
  const replacements = new Map(changes.flatMap((change, index) => change.replaces ? [[pinKey(change.replaces), additions[index]] as const] : []));
  const result = baseMaterials.map(pin => replacements.get(pinKey(pin)) ?? pin);
  changes.forEach((change, index) => { if (!change.replaces) result.push(additions[index]); });
  const compiled = compileRunSupplementInput({ projectId: r.project_id, manifest: base.manifest,
    reviewSnapshot: base.reviewSnapshot, resultMaterials: result, changes,
    ...(receipt ? { reviewIdentityContext: { owner, runId: r.id, baseExecution: base.execution,
      supplement: { revision: receipt.revision, requestId: receipt.request_id, requestHash: receipt.request_hash?.trim() } } } : {}) });
  return {base,baseMaterials,changes,resultMaterials:result,...compiled};
}

async function response(db: PoolClient, owner: string, r: any, job: any, base: Base, receipt: any, latest: number): Promise<RunSupplementDraftResponse> {
  const {baseMaterials,changes,resultMaterials:result,preview}=await readRunSupplementCandidate(db,owner,r,job,receipt,base);
  const blocked = await saveBlock(db, owner, r, job, base);
  return { run_id: r.id, project_id: r.project_id, revision: receipt?.revision ?? 0, latest_revision: latest,
    request_id: receipt?.request_id ?? null, saved_at: receipt ? date(receipt.saved_at) : null,
    base_input_revision: r.input_revision, base_input_hash: r.input_hash.trim(), base_materials: baseMaterials,
    changes, result_materials: result, input_preview: preview,
    ...(runSupplementSourceContext(base.manifest) ? { source_context: runSupplementSourceContext(base.manifest) } : {}),
    saved_work: await runSupplementWorkSummary(db, r, job, receipt?.revision ?? 0),
    can_save: blocked === null, blocked_reason: blocked, adopted: false };
}

export function registerRunSupplementDraftRoutes(app: FastifyInstance, pool: () => Pool, owner: (r: FastifyRequest) => Promise<string>) {
  const load = async (db: PoolClient, user: string, id: string) => {
    // The queue always locks run then job. Receipt reads take the same run lock
    // so an uncertain PUT can be recovered after its transaction has completed.
    const r = await run(db, user, id, true); assertTestChannelReadable(r.channel);
    const job = (await db.query('SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2 FOR UPDATE', [user, id])).rows[0];
    await assertRunExecution(db, r);
    const base = await frozenBase(db, user, r, job);
    const latest = (await db.query(`SELECT * FROM bb_run_supplement_drafts WHERE owner_user_id=$1 AND run_id=$2 ORDER BY revision DESC LIMIT 1`, [user, id])).rows[0];
    return { r, job, base, latest };
  };
  app.get('/api/v1/runs/:run_id/supplement-draft', { schema: { querystring: RunSupplementDraftQuerySchema, response: { 200: RunSupplementDraftResponseSchema } } }, async request => {
    const user = await owner(request), id = (request.params as { run_id: string }).run_id;
    const requestId = (request.query as { request_id?: string }).request_id;
    return transaction(pool(), async db => {
      const { r, job, base, latest } = await load(db, user, id);
      const receipt = requestId ? (await db.query('SELECT * FROM bb_run_supplement_drafts WHERE owner_user_id=$1 AND run_id=$2 AND request_id=$3', [user, id, requestId])).rows[0] : latest;
      if (requestId && !receipt) throw missing();
      return response(db, user, r, job, base, receipt, latest?.revision ?? 0);
    });
  });
  app.put('/api/v1/runs/:run_id/supplement-draft', { schema: { body: RunSupplementDraftRequestSchema, response: { 200: RunSupplementDraftResponseSchema } } }, async request => {
    const user = await owner(request), id = (request.params as { run_id: string }).run_id, b = request.body as RunSupplementDraftRequest;
    return transaction(pool(), async db => {
      const { r, job, base, latest } = await load(db, user, id), hash = inputManifestHash(b);
      const prior = (await db.query('SELECT * FROM bb_run_supplement_drafts WHERE owner_user_id=$1 AND run_id=$2 AND request_id=$3', [user, id, b.request_id])).rows[0];
      if (prior) {
        if (prior.request_hash.trim() !== hash) throw conflict('IDEMPOTENCY_CONFLICT', '同一保存请求已绑定其他补料内容。');
        return response(db, user, r, job, base, prior, latest?.revision ?? 0);
      }
      if (b.base_input_revision !== r.input_revision || b.base_input_hash !== r.input_hash.trim() || b.expected_revision !== (latest?.revision ?? 0)) stale();
      // Project archive/delete starts with its project lock. Avoid a lock-order
      // cycle with the already-held run lock while keeping validation atomic.
      try {
        await db.query('SELECT id FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE NOWAIT', [user, r.project_id]);
      } catch (error) {
        if ((error as { code?: string }).code === '55P03') stale();
        throw error;
      }
      const blocked = await saveBlock(db, user, r, job, base);
      if (blocked) throw conflict('INPUT_REVISION_CONFLICT', blocked);
      const baseMaterials = await Promise.all(base.pins.map(pin => materialDetails(db, user, pin)));
      await validateChanges(db, user, r.project_id, baseMaterials, b.changes, base.manifest);
      const receipt = (await db.query(`INSERT INTO bb_run_supplement_drafts(owner_user_id,project_id,run_id,revision,request_id,request_hash,base_input_revision,base_input_hash,changes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [user, r.project_id, id, (latest?.revision ?? 0) + 1, b.request_id, hash, r.input_revision, r.input_hash.trim(), JSON.stringify(b.changes)])).rows[0];
      await captureRunSupplementWork(db, r, job, receipt.revision);
      await db.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
        VALUES($1,$2,'run_supplement_draft',$3,'run.supplement_draft_saved',$4)`,
      [uid(), user, id, { run_id: id, project_id: r.project_id, revision: receipt.revision, request_id: b.request_id,
        base_input_revision: r.input_revision, base_input_hash: r.input_hash.trim(), adopted: false }]);
      return response(db, user, r, job, base, receipt, receipt.revision);
    });
  });
}
