// #17 run execution path. One claimed run job executes its stages in order; each completed stage
// is merged into checkpoint.stages under the lease, so a restarted worker skips it. Model stages
// go through the #16 contained Codex adapter with the PostgreSQL journal: a completed call is
// reused, an unknown one pauses the run for reconciliation, never a blind resend. A run becomes
// `succeeded` only via queue.finish after the Word artifact passed inspection and Blob readback.
// A stage the pipeline needs but that is not implemented pauses the run (`capability_not_ready`).
import type { Pool } from 'pg';
import { MATERIAL_PARSE_JOB_TYPE, RUN_PIPELINE_STAGES, type RUN_PAUSE_STAGES } from '@bondbuddy/contracts';
import { digest, Problem, type PrivateBlobs } from '@bondbuddy/api/data';
import { documentParserVersion } from '@bondbuddy/api/material-jobs';
import { savePromptSnapshot } from '@bondbuddy/api/log-ops';
import { loadVerifiedIssuerIdentitySourceRecord } from '@bondbuddy/api/issuer-identity-source';
import { isVerifiedIssuerIdentityBinding, issuerIdentityBindingMatches } from '@bondbuddy/api/issuer-identity-binding';
import { checkpointStage, claim, finish, pauseRun, promoteWordArtifact, releaseLease, renew, type Lease } from '@bondbuddy/api/queue';
import { runContainedModelCall, type CodexAdapterConfig, type CodexJournal } from './codex-adapter.js';
import { CodexDurableJournal } from './durable-probe-journal.js';

export type RunRow = { id: string; owner_user_id: string; project_id: string; input_revision: number; input_hash: string; task_kind: string };
export type StageContext = {
  pool: Pool; blobs: PrivateBlobs; lease: Lease; run: RunRow; signal: AbortSignal;
  /** Checkpoint of completed stages, then values produced by stages in this attempt. */
  checkpoint: Record<string, Record<string, unknown>>; values: Map<string, unknown>;
  /** Revalidate update issuer identity immediately before constructing a prompt and before each provider intent. */
  validateBeforeModelCall?: () => Promise<InputBindingGate | null>;
};
export type StageOutcome =
  | { kind: 'done'; checkpoint?: Record<string, unknown>; value?: unknown }
  | { kind: 'pause'; stage: typeof RUN_PAUSE_STAGES[number]; reason: string }
  | { kind: 'fail'; code: string }
  | { kind: 'deliver'; bytes: Buffer; cleanBytes?: Buffer; baselineBytes?: Buffer; wordSummary?: Record<string, unknown> }
  /** The stage already moved the durable job (e.g. provider reconciliation paused it). */
  | { kind: 'stopped' };
export type RunStage = {
  name: string;
  /** Re-run even when checkpointed: model stages replay through the durable journal (reuse, no new call). */
  replay?: boolean;
  run: (ctx: StageContext) => Promise<StageOutcome>;
};
export type RunPipelineOutcome = 'idle' | 'succeeded' | 'failed' | 'paused' | 'lost' | 'retry' | 'stopped';
export type RunPipelineDependencies = {
  pool: Pool; blobs: PrivateBlobs; stages: RunStage[]; leaseSeconds?: number; maxAttempts?: number;
  signal?: AbortSignal;
  onLease?: (lease: Lease | null) => void;
  /** Test seam only: runs after each durable stage checkpoint, e.g. to simulate a process crash. */
  afterStage?: (stage: string, lease: Lease) => Promise<void>;
};

const lost = (error: unknown) => error instanceof Problem && (error.code === 'ALREADY_TERMINAL' || (error.status === 409 && /lease/i.test(error.message)));
const notImplemented = (name: string): RunStage => ({ name, run: async () => ({ kind: 'pause', stage: 'capability_not_ready', reason: 'stage_not_implemented' }) });

type InputBindingGate = Extract<StageOutcome, { kind: 'pause' | 'fail' }>;
type InputRevisionRow = { input_hash: string; manifest: Record<string, unknown> | null };

async function verifyUpdateIssuerIdentityBinding(pool: Pool, run: RunRow, manifest: Record<string, unknown> | null): Promise<InputBindingGate | null> {
  if (run.task_kind !== 'update') return null;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    return { kind: 'pause', stage: 'capability_not_ready', reason: 'historical_issuer_identity_not_bound' };
  const binding = manifest.issuer_identity;
  if (!isVerifiedIssuerIdentityBinding(binding)) {
    const reason = binding && typeof binding === 'object' && !Array.isArray(binding) &&
      typeof (binding as Record<string, unknown>).reason === 'string' ? String((binding as Record<string, unknown>).reason)
      : 'historical_issuer_identity_not_bound';
    return { kind: 'pause', stage: 'capability_not_ready', reason };
  }
  if (manifest.issuer_entity_id !== binding.entity_id)
    return { kind: 'pause', stage: 'capability_not_ready', reason: 'historical_issuer_identity_pin_mismatch' };
  const materials = Array.isArray(manifest.materials) ? manifest.materials as Record<string, unknown>[] : [];
  const historical = materials.filter(material => material.role === 'historical');
  if (historical.length !== 1 || historical[0]?.material_id !== binding.material_id ||
      historical[0]?.material_version !== binding.material_version)
    return { kind: 'pause', stage: 'capability_not_ready', reason: 'historical_issuer_material_selection_stale' };
  const material = historical[0]!;
  const currentMaterial = (await pool.query(`SELECT role,sha256 FROM bb_material_versions
    WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL`,
  [run.owner_user_id, run.project_id, binding.material_id, binding.material_version])).rows[0];
  const manifestHash = typeof material.sha256 === 'string' ? material.sha256.trim() : '';
  if (!currentMaterial || currentMaterial.role !== 'historical' || currentMaterial.sha256.trim() !== manifestHash ||
      manifestHash !== binding.source_content_sha256)
    return { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' };
  const current = await loadVerifiedIssuerIdentitySourceRecord(pool, {
    ownerUserId: run.owner_user_id, projectId: run.project_id,
    materialId: binding.material_id, materialVersion: binding.material_version,
  });
  if (!current || !issuerIdentityBindingMatches(binding, current))
    return { kind: 'pause', stage: 'capability_not_ready', reason: 'historical_issuer_identity_stale' };
  return null;
}

async function currentRunInput(pool: Pool, run: RunRow): Promise<InputRevisionRow | null> {
  const result = await pool.query(`SELECT i.input_hash,i.manifest FROM bb_input_revisions i
    JOIN bb_projects p ON p.id=i.project_id AND p.owner_user_id=i.owner_user_id AND p.deleted_at IS NULL
    WHERE i.owner_user_id=$1 AND i.project_id=$2 AND i.revision=$3`, [run.owner_user_id, run.project_id, run.input_revision]);
  return (result.rows[0] as InputRevisionRow | undefined) ?? null;
}

/** input_lock: the run is pinned to its immutable input revision and hash. */
export const inputLockStage: RunStage = {
  name: 'input_lock',
  // Recovery must re-check the production rule pin before any later stage can run.
  replay: true,
  run: async ({ pool, run }) => {
    const q = await pool.query(`SELECT i.input_hash,i.material_versions,i.rule_pack_version,i.manifest,i.template_version,i.reference_release FROM bb_input_revisions i
      JOIN bb_projects p ON p.owner_user_id=i.owner_user_id AND p.id=i.project_id AND p.deleted_at IS NULL
      WHERE i.owner_user_id=$1 AND i.project_id=$2 AND i.revision=$3`, [run.owner_user_id, run.project_id, run.input_revision]);
    const input = q.rows[0];
    if (!input) return { kind: 'fail', code: 'NOT_FOUND' };
    if (input.input_hash.trim() !== run.input_hash.trim()) return { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' };
    const manifest = input.manifest as Record<string, unknown> | null;
    const identityGate = await verifyUpdateIssuerIdentityBinding(pool, run, manifest);
    if (identityGate) return identityGate;
    const pin = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
      ? manifest.rule_pack_pin as Record<string, unknown> | undefined : undefined;
    const completePin = typeof input.rule_pack_version === 'string' && input.rule_pack_version.length > 0 &&
      pin && typeof pin === 'object' && !Array.isArray(pin) &&
      typeof pin.pack_id === 'string' && pin.pack_id.length > 0 &&
      pin.version === input.rule_pack_version && typeof pin.content_hash === 'string' && /^[a-f0-9]{64}$/.test(pin.content_hash);
    if (!completePin) return { kind: 'pause', stage: 'capability_not_ready', reason: 'rule_pack_pin_missing' };
    // 0018 persists test-channel events only. There is no authenticated production release
    // registry/selector yet, so a manifest pin (including one that claims production) cannot
    // establish reviewer authority, active status, exact scope, or current rule/source validity.
    // Keep the run parked until a trusted selector can resolve and verify that exact hash.
    return { kind: 'pause', stage: 'capability_not_ready', reason: 'production_rule_pack_selector_unavailable' };
  },
};

export type MaterialsReadiness = { status: 'ready' | 'pending' | 'failed'; code?: string; materials: { material_id: string; material_version: number; outcome: string | null }[]; pending: string[] };

/** All pinned material versions must have a succeeded parse job for the deployed parser version. */
export async function materialsReadiness(pool: Pool, run: Pick<RunRow, 'owner_user_id' | 'project_id' | 'input_revision'>): Promise<MaterialsReadiness> {
  const refs = (await pool.query('SELECT material_versions FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
    [run.owner_user_id, run.project_id, run.input_revision])).rows[0]?.material_versions as { material_id: string; material_version: number }[] | undefined;
  if (!refs) return { status: 'failed', code: 'NOT_FOUND', materials: [], pending: [] };
  const materials: MaterialsReadiness['materials'] = [], pending: string[] = [];
  for (const ref of refs) {
    const job = (await pool.query(`SELECT state,error_code,result FROM bb_jobs WHERE job_type=$1 AND owner_user_id=$2 AND project_id=$3 AND material_id=$4
      AND material_version=$5 AND subtype='material_parse' AND parser_version=$6`, [MATERIAL_PARSE_JOB_TYPE, run.owner_user_id, run.project_id, ref.material_id, ref.material_version, documentParserVersion()])).rows[0];
    const key = `${ref.material_id}:${ref.material_version}`;
    if (job?.state === 'failed') return { status: 'failed', code: job.error_code ?? 'MATERIAL_UNREADABLE', materials, pending };
    if (job?.state === 'cancelled') return { status: 'failed', code: 'INPUT_REQUIRED', materials, pending };
    if (job?.state !== 'succeeded') { pending.push(key); continue; }
    materials.push({ material_id: ref.material_id, material_version: ref.material_version, outcome: job.result?.outcome ?? null });
  }
  return { status: pending.length ? 'pending' : 'ready', materials, pending };
}

export const materialsReadyStage: RunStage = {
  name: 'materials_ready',
  run: async ({ pool, run }) => {
    const r = await materialsReadiness(pool, run);
    if (r.status === 'failed') return { kind: 'fail', code: r.code! };
    if (r.status === 'pending') return { kind: 'pause', stage: 'awaiting_materials', reason: 'material_parse_pending' };
    return { kind: 'done', checkpoint: { materials: r.materials } };
  },
};

async function nextSnapshotVersion(pool: Pool, owner: string, projectId: string) {
  const q = await pool.query("SELECT COALESCE(max(version),0)::int+1 AS v FROM bb_snapshot_refs WHERE owner_user_id=$1 AND project_id=$2 AND snapshot_kind='model_request'", [owner, projectId]);
  return Number(q.rows[0].v);
}

/**
 * A model stage on the contained Codex adapter. The prompt is saved (scrubbed) as a #79 snapshot
 * and checkpointed before any call; the text actually sent is always read back from that snapshot.
 */
export function codexModelStage(options: {
  name: string; logicalCallId: string; config: CodexAdapterConfig | (() => CodexAdapterConfig);
  buildPrompt: (ctx: StageContext) => Promise<string>; schema: Record<string, unknown>; validate: (value: unknown) => boolean;
  resultSchemaVersion: string; templateVersion?: string;
  /** Test seam only: wraps the durable journal (e.g. to simulate a crash right after the intent commit). */
  wrapJournal?: (journal: CodexJournal) => CodexJournal;
}): RunStage {
  const promptStage = `${options.name}_prompt`;
  return {
    name: options.name,
    replay: true,
    run: async ctx => {
      const { pool, blobs, lease, run } = ctx;
      const initialGate = await ctx.validateBeforeModelCall?.();
      if (initialGate) return initialGate;
      let snapshotId = ctx.checkpoint[promptStage]?.snapshot_id as string | undefined;
      if (!snapshotId) {
        const body = await options.buildPrompt(ctx);
        for (let tries = 0; !snapshotId; tries++) {
          try {
            snapshotId = await savePromptSnapshot(pool, blobs, { owner: run.owner_user_id, projectId: run.project_id, runId: run.id, kind: 'model_request',
              version: await nextSnapshotVersion(pool, run.owner_user_id, run.project_id), body, inputRevision: run.input_revision, inputHash: run.input_hash.trim(), templateVersion: options.templateVersion });
          } catch (error) { if ((error as { code?: string }).code !== '23505' || tries >= 3) throw error; }
        }
        await checkpointStage(pool, lease, promptStage, { snapshot_id: snapshotId });
        ctx.checkpoint[promptStage] = { snapshot_id: snapshotId };
      }
      const ref = (await pool.query('SELECT object_key,content_sha256 FROM bb_snapshot_refs WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 AND run_id=$4', [snapshotId, run.owner_user_id, run.project_id, run.id])).rows[0];
      if (!ref) return { kind: 'fail', code: 'DATA_UNAVAILABLE' };
      const bytes = await blobs.getIfExists(ref.object_key);
      if (!bytes || digest(bytes) !== ref.content_sha256.trim()) return { kind: 'fail', code: 'DATA_UNAVAILABLE' };
      const config = typeof options.config === 'function' ? options.config() : options.config;
      const durable = new CodexDurableJournal({ pool, blobs, lease, validateResult: options.validate });
      const journal = options.wrapJournal ? options.wrapJournal(durable) : durable;
      const callGate = await ctx.validateBeforeModelCall?.();
      if (callGate) return callGate;
      const result = await runContainedModelCall({ owner_user_id: run.owner_user_id, project_id: run.project_id, job_id: lease.jobId, run_id: run.id, trace_id: run.id,
        logical_call_id: options.logicalCallId, prompt_snapshot_ref: snapshotId, prompt: bytes.toString('utf8'), result_schema_version: options.resultSchemaVersion,
        output: { kind: 'json', schema: options.schema, validate: options.validate }, signal: ctx.signal }, journal, config);
      if (result.status === 'completed' || result.status === 'reused')
        return { kind: 'done', value: result.value, checkpoint: { logical_call_id: options.logicalCallId, prompt_snapshot_ref: snapshotId } };
      // The observation may already have paused or failed the job; otherwise park it ourselves.
      const job = (await pool.query('SELECT state,lease_token FROM bb_jobs WHERE id=$1', [lease.jobId])).rows[0];
      if (job?.state !== 'running' || job.lease_token !== lease.token) return { kind: 'stopped' };
      if (result.status === 'needs_reconcile') return { kind: 'pause', stage: 'provider_reconcile', reason: 'provider_result_pending' };
      return { kind: 'fail', code: result.error_code ?? 'MODEL_TURN_FAILED' };
    },
  };
}

/** Word delivery: bytes from a trusted generator go through #102 inspection, Blob readback and finish. */
export function wordDeliveryStage(generate: (ctx: StageContext) => Promise<Buffer>): RunStage {
  return { name: 'word_delivery', run: async ctx => ({ kind: 'deliver', bytes: await generate(ctx) }) };
}

/**
 * Stage composition hook. WorkerRuntime installs the bounded historical model stage;
 * tests and other task kinds may provide their own stages. Missing stages still pause
 * at `capability_not_ready`; installation alone does not satisfy the production input gates.
 */
export function defaultRunStages(installed: Partial<Record<'model_generation' | 'word_delivery', RunStage>> = {}): RunStage[] {
  return RUN_PIPELINE_STAGES.map(name => name === 'input_lock' ? inputLockStage : name === 'materials_ready' ? materialsReadyStage
    : installed[name] ?? notImplemented(name));
}

/** Claims one run job and executes its remaining stages. Returns what happened to the durable job. */
export async function runPipelineOnce(deps: RunPipelineDependencies): Promise<RunPipelineOutcome> {
  const { pool, blobs } = deps;
  const leaseSeconds = deps.leaseSeconds ?? 30, maxAttempts = deps.maxAttempts ?? 3;
  const lease = await claim(pool, leaseSeconds);
  deps.onLease?.(lease);
  if (!lease) return 'idle';
  const abort = new AbortController();
  const onOuterAbort = () => abort.abort();
  deps.signal?.addEventListener('abort', onOuterAbort, { once: true });
  // A lost lease (cancel won, or lease expired) stops in-flight work: codex kills its process group.
  const heartbeat = setInterval(() => { void renew(pool, lease, leaseSeconds).catch(() => { clearInterval(heartbeat); abort.abort(); }); }, Math.max(1000, leaseSeconds * 400));
  let currentStage: string | undefined;
  try {
    const run = (await pool.query('SELECT id,owner_user_id,project_id,input_revision,input_hash,task_kind FROM bb_runs WHERE id=$1 AND owner_user_id=$2', [lease.runId, lease.owner])).rows[0] as RunRow;
    const checkpoint = { ...((lease.checkpoint.stages ?? {}) as Record<string, Record<string, unknown>>) };
    const ctx: StageContext = { pool, blobs, lease, run, signal: abort.signal, checkpoint, values: new Map(), validateBeforeModelCall: async () => {
      if (run.task_kind !== 'update') return null;
      const input = await currentRunInput(pool, run);
      if (!input || input.input_hash.trim() !== run.input_hash.trim()) return { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' };
      return verifyUpdateIssuerIdentityBinding(pool, run, input.manifest);
    } };
    for (const stage of deps.stages) {
      currentStage = stage.name;
      const saved = checkpoint[stage.name];
      if (saved && !stage.replay) { ctx.values.set(stage.name, saved); continue; }
      const outcome = await stage.run(ctx);
      if (outcome.kind === 'done') {
        if (!saved) { await checkpointStage(pool, lease, stage.name, outcome.checkpoint ?? {}); checkpoint[stage.name] = outcome.checkpoint ?? {}; }
        ctx.values.set(stage.name, outcome.value ?? outcome.checkpoint ?? {});
        await deps.afterStage?.(stage.name, lease);
        continue;
      }
      if (outcome.kind === 'pause') { await pauseRun(pool, lease, outcome.stage, outcome.reason); return 'paused'; }
      if (outcome.kind === 'fail') { await finish(pool, lease, 'failed', { errorCode: outcome.code, failedStage: stage.name }); return 'failed'; }
      if (outcome.kind === 'stopped') return 'stopped';
      if (Boolean(outcome.cleanBytes) !== Boolean(outcome.baselineBytes) ||
        (outcome.cleanBytes && !outcome.wordSummary)) {
        await finish(pool, lease, 'failed', { errorCode: 'VALIDATION_FAILED', failedStage: stage.name });
        return 'failed';
      }
      let cleanArtifactId: string | undefined;
      let baselineArtifactId: string | undefined;
      if (outcome.baselineBytes) {
        const baseline = await promoteWordArtifact(pool, lease, outcome.baselineBytes, blobs);
        if (baseline.status !== 'available') {
          await finish(pool, lease, 'failed', { errorCode: baseline.failureCode, failedStage: stage.name });
          return 'failed';
        }
        baselineArtifactId = baseline.artifactId;
      }
      if (outcome.cleanBytes) {
        const clean = await promoteWordArtifact(pool, lease, outcome.cleanBytes, blobs);
        if (clean.status !== 'available') {
          await finish(pool, lease, 'failed', { errorCode: clean.failureCode, failedStage: stage.name });
          return 'failed';
        }
        cleanArtifactId = clean.artifactId;
      }
      const delivered = await promoteWordArtifact(pool, lease, outcome.bytes, blobs);
      await deps.afterStage?.('word_promoted', lease);
      if (delivered.status !== 'available') { await finish(pool, lease, 'failed', { errorCode: delivered.failureCode, failedStage: stage.name }); return 'failed'; }
      if (cleanArtifactId) {
        const pair = { ...outcome.wordSummary, revision_artifact_id: delivered.artifactId,
          clean_artifact_id: cleanArtifactId, baseline_artifact_id: baselineArtifactId };
        await checkpointStage(pool, lease, 'word_delivery_pair', pair);
        ctx.checkpoint.word_delivery_pair = pair;
      }
      await finish(pool, lease, 'succeeded', { artifactId: delivered.artifactId, artifactVersion: delivered.artifactVersion, blobs });
      return 'succeeded';
    }
    // Every production pipeline ends in delivery; running out of stages is never success.
    await pauseRun(pool, lease, 'capability_not_ready', 'stage_not_implemented');
    return 'paused';
  } catch (error) {
    if (error instanceof Error && error.message === 'SYNTHETIC_CRASH') throw error;
    if (lost(error)) return 'lost';
    try {
      // Infrastructure errors retry from the checkpoint; the last allowed attempt fails and keeps the checkpoint.
      if (lease.attempts < maxAttempts) { await releaseLease(pool, lease); return 'retry'; }
      await finish(pool, lease, 'failed', { errorCode: 'DATA_UNAVAILABLE', failedStage: currentStage });
      return 'failed';
    } catch (finishError) { if (lost(finishError)) return 'lost'; throw finishError; }
  } finally {
    clearInterval(heartbeat);
    deps.signal?.removeEventListener('abort', onOuterAbort);
    deps.onLease?.(null);
  }
}
