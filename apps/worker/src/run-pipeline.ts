// #17 run execution path. One claimed run job executes its stages in order; each completed stage
// is merged into checkpoint.stages under the lease, so a restarted worker skips it. Model stages
// go through the #16 contained Codex adapter with the PostgreSQL journal: a completed call is
// reused, an unknown one pauses the run for reconciliation, never a blind resend. A run becomes
// `succeeded` only via queue.finish after the Word artifact passed inspection and Blob readback.
// A stage the pipeline needs but that is not implemented pauses the run (`capability_not_ready`).
import type { Pool } from 'pg';
import { isUnifiedInput,type M4AssistantReply } from '@bondbuddy/contracts';
import { hasM4Manifest,m4InputGate } from './m4-input.js';
import { unifiedInputGate } from './unified-input.js';
import { isReviewInput, reviewInputGate, reviewMaterialsReady } from './review-input.js';
import { RQ_PROSPECTUS_ANNUAL_SOURCE_SHA256 } from './rq-prospectus-annual-fact-constants.js';
import { ERROR_CODES, MATERIAL_PARSE_JOB_TYPE, M1_MATERIAL_PARTITIONS, RUN_PIPELINE_STAGES, type RUN_PAUSE_STAGES } from '@bondbuddy/contracts';
import { digest, Problem, transaction, type PrivateBlobs } from '@bondbuddy/api/data';
import { registerM4Artifacts,settleM4Metering,type M4ArtifactRegistration } from '@bondbuddy/api/m4-workspace';
import { documentParserVersion } from '@bondbuddy/api/material-jobs';
import { savePromptSnapshot } from '@bondbuddy/api/log-ops';
import { loadVerifiedIssuerIdentitySourceRecord } from '@bondbuddy/api/issuer-identity-source';
import { isVerifiedIssuerIdentityBinding, issuerIdentityBindingMatches } from '@bondbuddy/api/issuer-identity-binding';
import { isTestIssuerCandidate, testIssuerCandidateMatches } from '@bondbuddy/api/test-issuer-candidate';
import { inputManifestHash, revalidateStoredProductionRulePin, type ReviewedContextLoader } from '@bondbuddy/api/production-rule-pin';
import { readTestApplicabilityRef } from '@bondbuddy/api/test-rule-applicability-pin';
import { assertTestGrant } from '@bondbuddy/api/non-production-test';
import { checkpointStage, claim, finish,finishM4Qa, pauseRun, promoteWordArtifact, promoteReviewPdfArtifact, recordReviewAction, releaseLease, renew, upgradeStageCheckpoint, type Lease, type RunKind } from '@bondbuddy/api/queue';
import { TrialLimitProblem } from '@bondbuddy/api/trial-guard';
import { runContainedModelCall, type CodexAdapterConfig, type CodexJournal, type ContainedCallInput, type ContainedCallResult } from './codex-adapter.js';
import { beginRunStage, pauseAtCheckpoint, recordAuthoringActivity } from '@bondbuddy/api/queue';
import { createAuthoringActivityObserver } from './authoring-action-progress.js';
import { createReviewActionObserver, reviewActionMode } from './review-action-progress.js';
import type { MaterialToolData } from './authoring-material-tools.js';
import { isMaterialModelEnvelope } from './material-tool-trace.js';
import { reviewModelEnvelopeAsync, type ReviewToolData } from './review-tools.js';
import { CodexDurableJournal } from './durable-probe-journal.js';
import type { FactCandidateProductionContext, FactCandidateProductionResult } from './fact-candidate-producer.js';
import { markTestWord } from './test-word-marking.js';
import { isTestUncoveredItems, type TestUncoveredItem } from '@bondbuddy/contracts';
import type { ApprovedGenerationIssuerBinding } from './no-history-model-stage.js';
import type { ProduceTargetPeriodCandidateSnapshotRequest } from './target-period-candidate-snapshot-producer.js';

/**
 * Trusted #33 pinned generation issuer binding loader. The production runtime builds the
 * pinned-manifest loader (`loadPinnedApprovedGenerationIssuerBinding`) and injects it here; a
 * non-null value authorizes the generation run's issuer subject, null keeps it fail-closed at the
 * stable `issuer_identity_not_bound` pause. Absent = the run keeps its pre-wiring behavior.
 */
export type GenerationIssuerBindingScope = { ownerUserId: string; projectId: string; runId: string; inputRevision: number; inputHash: string };
export type LoadGenerationIssuerBinding = (scope: GenerationIssuerBindingScope) => Promise<ApprovedGenerationIssuerBinding | null>;
/** #76 target-period candidate producer call site; injected by the runtime only when enabled. */
export type TargetPeriodCandidateProducer = (request: ProduceTargetPeriodCandidateSnapshotRequest) => Promise<void>;

export type RunRow = { billing_mode?: (typeof import('@bondbuddy/contracts').RUN_BILLING_MODES)[number]; id: string; owner_user_id: string; project_id: string; input_revision: number; input_hash: string; task_kind: string; channel?: 'production'|'non_production_test'; test_grant_id?: string|null };
export type StageContext = {
  pool: Pool; blobs: PrivateBlobs; lease: Lease; run: RunRow; signal: AbortSignal;
  /** Checkpoint of completed stages, then values produced by stages in this attempt. */
  checkpoint: Record<string, Record<string, unknown>>; values: Map<string, unknown>;
  /** Revalidate update issuer identity immediately before constructing a prompt and before each provider intent. */
  validateBeforeModelCall?: () => Promise<InputBindingGate | null>;
  reviewedContextLoader?: ReviewedContextLoader;
  testRuleCapabilityLoader?: TestRuleCapabilityLoader;
  /** #33 pinned issuer binding re-verification call point; absent = unchanged. */
  loadGenerationIssuerBinding?: LoadGenerationIssuerBinding;
  /** #76 target-period candidate producer call point; absent = unchanged. */
  produceTargetPeriodCandidates?: TargetPeriodCandidateProducer;
};
export type StageOutcome =
  | { kind: 'done'; checkpoint?: Record<string, unknown>; value?: unknown; upgradeCheckpoint?: boolean }
  | { kind: 'pause'; stage: typeof RUN_PAUSE_STAGES[number]; reason: string }
  | { kind: 'fail'; code: string }
  | { kind: 'deliver'; bytes: Buffer; cleanBytes?: Buffer; baselineBytes?: Buffer; attachments?: { kind: 'comments' | 'report'; bytes: Buffer; mediaType?:'application/pdf' }[];
      namedArtifacts?:{kind:'preparation_note';filename:string;bytes:Buffer;previewContent?:string}[];wordSummary?: Record<string, unknown>; deliveryPolicy?: import('@bondbuddy/contracts').GeneratedWordDeliveryPolicy }
  | {kind:'qa_deliver';reply:M4AssistantReply}
  /** The stage already moved the durable job (e.g. provider reconciliation paused it). */
  | { kind: 'stopped' };
export type RunStage = {
  name: string;
  /** Re-run even when checkpointed: model stages replay through the durable journal (reuse, no new call). */
  replay?: boolean;
  run: (ctx: StageContext) => Promise<StageOutcome>;
};
export type RunPipelineOutcome = 'idle' | 'succeeded' | 'test_completed' | 'failed' | 'paused' | 'lost' | 'retry' | 'stopped';
export type RunPipelineDependencies = {
  pool: Pool; blobs: PrivateBlobs; stages: RunStage[]; leaseSeconds?: number; maxAttempts?: number;
  runKinds?: readonly RunKind[];
  signal?: AbortSignal; reviewedContextLoader?: ReviewedContextLoader;
  testRuleCapabilityLoader?: TestRuleCapabilityLoader;
  /** #33 pinned issuer binding re-verification call point; absent = unchanged. */
  loadGenerationIssuerBinding?: LoadGenerationIssuerBinding;
  /** #76 target-period candidate producer call point; absent = unchanged. */
  produceTargetPeriodCandidates?: TargetPeriodCandidateProducer;
  onLease?: (lease: Lease | null) => void;
  /** Test seam only: runs after each durable stage checkpoint, e.g. to simulate a process crash. */
  afterStage?: (stage: string, lease: Lease) => Promise<void>;
  onUnexpectedError?: (error: { stage: string | null; name: string; message: string; code: string | null }) => void;
};

/** Keep diagnostic text to fixed identifiers and known PostgreSQL schema messages. */
export function safeRunError(error: unknown, stage: string | undefined) {
  const object = error && typeof error === 'object' ? error as { name?: unknown; message?: unknown; code?: unknown } : {};
  const name = typeof object.name === 'string' && ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'AggregateError', 'Problem'].includes(object.name)
    ? object.name : 'UnknownError';
  const knownSqlStates = ['42P01', '42703', '23514', '23505', '23503', '40001', '40P01', '08006', '53300', '57P01'];
  const code = typeof object.code === 'string' && ((ERROR_CODES as readonly string[]).includes(object.code) || knownSqlStates.includes(object.code))
    ? object.code : null;
  const raw = typeof object.message === 'string' ? object.message : '';
  const message = raw === 'Invalid pause' || (ERROR_CODES as readonly string[]).includes(raw) ||
    /^(?:relation|column) "[a-z_][a-z0-9_]*" does not exist$/.test(raw) ? raw : 'redacted';
  return { stage: stage ?? null, name, message, code };
}

/** Event reasons are public machine codes; preflight retains field-level review detail. */
export function safePauseReason(reason: string) {
  const prefix = reason.split(':', 1)[0]!;
  return /^[a-z][a-z0-9_]{0,63}$/.test(prefix) ? prefix : 'rule_applicability_needs_review';
}

const lost = (error: unknown) => error instanceof Problem && (error.code === 'ALREADY_TERMINAL' || (error.status === 409 && /lease/i.test(error.message)));
const notImplemented = (name: string): RunStage => ({ name, run: async () => ({ kind: 'pause', stage: 'capability_not_ready', reason: 'stage_not_implemented' }) });

type InputBindingGate = Extract<StageOutcome, { kind: 'pause' | 'fail' }>;
export type TestRuleCapability = { status: 'ready'; sampleManifestSha256: string; taxonomyHash: string; rulePackHash: string;
  uncoveredItems: TestUncoveredItem[] } | { status: 'not_ready'; reason: string };
export type TestRuleCapabilityLoader = (run: RunRow, input: InputRevisionRow) => Promise<TestRuleCapability>;
// #19 supplies the candidate selector. Until then a test run stays paused before any model call.
export const unavailableTestRuleCapability: TestRuleCapabilityLoader = async () =>
  ({ status:'not_ready', reason:'test_rule_capability_not_ready' });
export type InputRevisionRow = { input_hash: string; draft_revision: number; material_versions: unknown;
  manifest: Record<string, unknown> | null; rule_pack_version: string | null; template_version: string | null };

async function verifyTestRuleCapability(pool: Pool, run: RunRow, input: InputRevisionRow,
  loader: TestRuleCapabilityLoader = unavailableTestRuleCapability): Promise<InputBindingGate | null> {
  if (!input.manifest || inputManifestHash(input.manifest) !== String(input.input_hash).trim() ||
      String(input.input_hash).trim() !== run.input_hash.trim())
    return {kind:'fail',code:'INPUT_REVISION_CONFLICT'};
  // An absent professional applicability review is advisory for a scoped test
  // working draft. A supplied but invalid/withdrawn review still fails closed
  // in the capability loader; it cannot silently fall back to the draft path.
  if (input.manifest.test_rule_applicability_ref != null && !readTestApplicabilityRef(input.manifest))
    return {kind:'pause',stage:'capability_not_ready',reason:'test_reviewed_applicability_pin_invalid'};
  if (typeof input.manifest.test_rule_applicability_block_reason === 'string')
    return {kind:'pause',stage:'capability_not_ready',reason:safePauseReason(input.manifest.test_rule_applicability_block_reason)};
  let grant: any;
  try { grant=await assertTestGrant(pool,{grantId:run.test_grant_id!,userId:run.owner_user_id,projectId:run.project_id,inputRevision:run.input_revision,inputHash:run.input_hash}); }
  catch(error){ return {kind:'pause',stage:'capability_not_ready',reason:error instanceof Problem?error.code.toLowerCase():'test_grant_invalid'}; }
  const capability=await loader(run,input);
  if(capability.status==='not_ready')return {kind:'pause',stage:'capability_not_ready',reason:capability.reason};
  if(capability.sampleManifestSha256!==grant.sample_manifest_sha256.trim() ||
     capability.taxonomyHash!==grant.taxonomy_hash.trim() || capability.rulePackHash!==grant.rule_pack_hash.trim())
    return {kind:'pause',stage:'capability_not_ready',reason:'test_grant_hash_mismatch'};
  if(!isTestUncoveredItems(capability.uncoveredItems))
    return {kind:'pause',stage:'capability_not_ready',reason:'test_rule_capability_invalid'};
  await pool.query('UPDATE bb_runs SET uncovered_items=$2 WHERE id=$1 AND channel=\'non_production_test\'',
    [run.id,JSON.stringify(capability.uncoveredItems)]);
  return null;
}

async function verifyProductionRulePin(pool: Pool, run: RunRow, input: InputRevisionRow, loader?: ReviewedContextLoader): Promise<InputBindingGate | null> {
  if (String(input.input_hash).trim() !== run.input_hash.trim())
    return { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' };
  const result = await revalidateStoredProductionRulePin(pool,
    { ownerUserId: run.owner_user_id, projectId: run.project_id }, input, loader, 'replay');
  if (result.status === 'valid') return null;
  if (result.status === 'tampered') return { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' };
  return { kind: 'pause', stage: 'capability_not_ready', reason: result.reason };
}

async function verifyUpdateIssuerIdentityBinding(pool: Pool, run: RunRow, manifest: Record<string, unknown> | null): Promise<InputBindingGate | null> {
  if (run.task_kind !== 'update') return null;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    return { kind: 'pause', stage: 'capability_not_ready', reason: 'historical_issuer_identity_not_bound' };
  const binding = manifest.issuer_identity;
  if (!isVerifiedIssuerIdentityBinding(binding)) {
    if (run.channel === 'non_production_test' && isTestIssuerCandidate(manifest.test_issuer_candidate)) {
      const candidate=manifest.test_issuer_candidate;
      const materials=Array.isArray(manifest.materials)?manifest.materials as Record<string,unknown>[]:[];
      const historical=materials.filter(material=>material.role==='historical');
      if(historical.length!==1 || historical[0]?.material_id!==candidate.material_id ||
          historical[0]?.material_version!==candidate.material_version ||
          historical[0]?.sha256!==candidate.source_content_sha256)
        return {kind:'fail',code:'INPUT_REVISION_CONFLICT'};
      const matches=await testIssuerCandidateMatches(pool,{ownerUserId:run.owner_user_id,projectId:run.project_id},candidate);
      return matches?null:{kind:'pause',stage:'capability_not_ready',reason:'historical_issuer_candidate_stale'};
    }
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
  const result = await pool.query(`SELECT i.input_hash,i.draft_revision,i.material_versions,i.manifest,i.rule_pack_version,i.template_version FROM bb_input_revisions i
    JOIN bb_projects p ON p.id=i.project_id AND p.owner_user_id=i.owner_user_id AND p.deleted_at IS NULL
    WHERE i.owner_user_id=$1 AND i.project_id=$2 AND i.revision=$3`, [run.owner_user_id, run.project_id, run.input_revision]);
  return (result.rows[0] as InputRevisionRow | undefined) ?? null;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * #33 run-pipeline call point for the pinned generation issuer binding. The worker runtime injects
 * the trusted loader; the run's locked manifest must actually pin a binding ref before the loader
 * is consulted, so a generation input without a pin keeps its current behavior. A present but
 * malformed/stale/withdrawn pin fails closed at the stable `issuer_identity_not_bound`.
 */
async function verifyGenerationIssuerBinding(run: RunRow, manifest: Record<string, unknown> | null,
  load?: LoadGenerationIssuerBinding): Promise<InputBindingGate | null> {
  if (!load || run.task_kind !== 'generation') return null;
  const pinned = manifest?.generation_issuer_binding_ref;
  if (pinned === undefined || pinned === null) return null;
  let binding: ApprovedGenerationIssuerBinding | null = null;
  try {
    binding = await load({ ownerUserId: run.owner_user_id, projectId: run.project_id, runId: run.id,
      inputRevision: run.input_revision, inputHash: run.input_hash.trim() });
  } catch { binding = null; }
  return binding ? null : { kind: 'pause', stage: 'capability_not_ready', reason: 'issuer_identity_not_bound' };
}

/** Selected financial materials from the locked manifest, exactly as the #76 producer re-reads them. */
function financialMaterialSelections(manifest: unknown): { materialId: string; materialVersion: number }[] {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return [];
  const materials = (manifest as Record<string, unknown>).materials;
  if (!Array.isArray(materials)) return [];
  const selected: { materialId: string; materialVersion: number }[] = [];
  for (const item of materials) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.role !== 'string' || !financialRoles.has(record.role)) continue;
    const materialVersion = record.material_version;
    if (typeof record.material_id !== 'string' || !identifierPattern.test(record.material_id) ||
        !Number.isSafeInteger(materialVersion) || (materialVersion as number) < 1) return [];
    selected.push({ materialId: record.material_id, materialVersion: materialVersion as number });
  }
  return selected;
}

function reportingCutoffOf(updateDetails: unknown): string | null {
  let details = updateDetails;
  if (typeof details === 'string') { try { details = JSON.parse(details) as unknown; } catch { return null; } }
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const cutoff = (details as Record<string, unknown>).reporting_cutoff;
  return typeof cutoff === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cutoff) ? cutoff : null;
}

/**
 * Resolve the exact #76 producer request from trusted rows only: the locked input manifest supplies
 * the financial-material identities and the owner-scoped project row supplies the current draft
 * revision plus reporting cutoff. A value the producer could not re-derive is never guessed.
 */
async function targetPeriodCandidateRequest(pool: Pool, run: RunRow, input: InputRevisionRow): Promise<ProduceTargetPeriodCandidateSnapshotRequest | null> {
  const selectedFinancialMaterials = financialMaterialSelections(input.manifest);
  if (!selectedFinancialMaterials.length) return null;
  const project = (await pool.query(`SELECT draft_revision,update_details FROM bb_projects
    WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL`, [run.owner_user_id, run.project_id])).rows[0];
  if (!project) return null;
  const projectDraftRevision = Number(project.draft_revision);
  const reportingCutoff = reportingCutoffOf(project.update_details);
  if (!Number.isSafeInteger(projectDraftRevision) || projectDraftRevision < 1 || !reportingCutoff) return null;
  return { ownerUserId: run.owner_user_id, projectId: run.project_id, selectedFinancialMaterials,
    projectDraftRevision, reportingCutoff, inputRevision: run.input_revision, inputHash: run.input_hash.trim() };
}

/**
 * #76 run-pipeline call point. Called once after the input gates pass, for update/generation runs
 * whose locked input selects financial materials. The producer is atomic: a failure persists nothing
 * and is swallowed here so it never blocks the rest of the run.
 */
export async function invokeTargetPeriodCandidateProducer(pool: Pool, run: RunRow, input: InputRevisionRow,
  producer?: TargetPeriodCandidateProducer): Promise<void> {
  if (!producer || (run.task_kind !== 'update' && run.task_kind !== 'generation')) return;
  let request: ProduceTargetPeriodCandidateSnapshotRequest | null;
  try { request = await targetPeriodCandidateRequest(pool, run, input); } catch { request = null; }
  if (!request) return;
  try { await producer(request); } catch { /* fail-closed: the producer persists nothing on failure */ }
}

/** input_lock: the run is pinned to its immutable input revision and hash. */
export const inputLockStage: RunStage = {
  name: 'input_lock',
  // Recovery must re-check the production rule pin before any later stage can run.
  replay: true,
  run: async ({ pool, run, reviewedContextLoader, testRuleCapabilityLoader, loadGenerationIssuerBinding, produceTargetPeriodCandidates }) => {
    const q = await pool.query(`SELECT i.input_hash,i.draft_revision,i.material_versions,i.rule_pack_version,i.manifest,i.template_version,i.reference_release FROM bb_input_revisions i
      JOIN bb_projects p ON p.owner_user_id=i.owner_user_id AND p.id=i.project_id AND p.deleted_at IS NULL
      WHERE i.owner_user_id=$1 AND i.project_id=$2 AND i.revision=$3`, [run.owner_user_id, run.project_id, run.input_revision]);
    const input = q.rows[0];
    if (!input) return { kind: 'fail', code: 'NOT_FOUND' };
    if (input.input_hash.trim() !== run.input_hash.trim()) return { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' };
    const manifest = input.manifest as Record<string, unknown> | null;
    if (hasM4Manifest(manifest)) return (await m4InputGate(pool,run,input)) ?? {kind:'done',value:{m4_mode:manifest?.kind}};
    if (isUnifiedInput(manifest)) return (await unifiedInputGate(pool, run, input)) ?? { kind: 'done', value: {
      authoring_mode: 'unified_v1', review_revision: !!(manifest as {authoring?:{review_revision?:unknown}}).authoring?.review_revision } };
    if (isReviewInput(manifest)) return (await reviewInputGate(pool, run, input)) ?? { kind: 'done', value: { review_mode: 'review_v1', ...(manifest.review.file_delivery ? { file_delivery: manifest.review.file_delivery.version } : {}) } };
    const identityGate = await verifyUpdateIssuerIdentityBinding(pool, run, manifest);
    if (identityGate) return identityGate;
    const issuerBindingGate = await verifyGenerationIssuerBinding(run, manifest, loadGenerationIssuerBinding);
    if (issuerBindingGate) return issuerBindingGate;
    await invokeTargetPeriodCandidateProducer(pool, run, input, produceTargetPeriodCandidates);
    if(run.channel==='non_production_test')return (await verifyTestRuleCapability(pool,run,input,testRuleCapabilityLoader)) ?? {kind:'done'};
    return (await verifyProductionRulePin(pool, run, input, reviewedContextLoader)) ?? { kind: 'done' };
  },
};

export type PinnedMaterialReadiness = { material_id: string; material_version: number; role: string; sha256: string;
  media_type: string; outcome: string | null; parse_snapshot_id: string | null };
export type MaterialsReadiness = { status: 'ready' | 'pending' | 'failed'; code?: string; materials: PinnedMaterialReadiness[]; pending: string[] };
export type ParsedFactProducer = (context: FactCandidateProductionContext) => Promise<FactCandidateProductionResult>;
const financialRoles: ReadonlySet<string> = new Set(M1_MATERIAL_PARTITIONS.find(partition => partition.roles.some(role => role.code === 'audit'))?.roles.map(role => role.code) ?? []);
const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function isRqAnnualProspectus(material: Pick<PinnedMaterialReadiness, 'role' | 'sha256' | 'media_type'>): boolean {
  return material.role === 'historical' && material.sha256.trim().toLowerCase() === RQ_PROSPECTUS_ANNUAL_SOURCE_SHA256 &&
    material.media_type === DOCX_MEDIA_TYPE;
}
type MaterialCheckpoint = Pick<PinnedMaterialReadiness, 'material_id' | 'material_version' | 'outcome'>;

function checkpointMaterialsMatch(saved: Record<string, unknown>, materials: readonly PinnedMaterialReadiness[]): boolean {
  const keys = Object.keys(saved).sort().join(',');
  if (keys !== 'materials' && keys !== 'extractions,materials') return false;
  const entries = saved.materials;
  return Array.isArray(entries) && entries.length === materials.length && entries.every((entry: unknown, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const prior = entry as Record<string, unknown>;
    const current = materials[index]!;
    return Object.keys(prior).sort().join(',') === 'material_id,material_version,outcome' &&
      prior.material_id === current.material_id && prior.material_version === current.material_version &&
      prior.outcome === current.outcome;
  });
}

/** Resolve the immutable manifest in order and verify exact material, parse job and snapshot pins. */
export async function materialsReadiness(pool: Pool, run: Pick<RunRow, 'owner_user_id' | 'project_id' | 'input_revision'> & Partial<Pick<RunRow, 'input_hash'>>): Promise<MaterialsReadiness> {
  const input = (await pool.query('SELECT input_hash,material_versions,manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
    [run.owner_user_id, run.project_id, run.input_revision])).rows[0];
  if (!input) return { status: 'failed', code: 'NOT_FOUND', materials: [], pending: [] };
  if (run.input_hash && String(input.input_hash).trim() !== run.input_hash.trim())
    return { status: 'failed', code: 'INPUT_REVISION_CONFLICT', materials: [], pending: [] };
  const refs = input.material_versions as { material_id: string; material_version: number }[];
  const manifest = input.manifest as { materials?: { material_id: string; material_version: number; role: string; sha256: string }[] } | null;
  if (!Array.isArray(refs) || !Array.isArray(manifest?.materials) || refs.length !== manifest.materials.length)
    return { status: 'failed', code: 'INPUT_REVISION_CONFLICT', materials: [], pending: [] };
  const materials: MaterialsReadiness['materials'] = [], pending: string[] = [];
  for (const [index, ref] of refs.entries()) {
    const pin = manifest.materials[index];
    if (!pin || pin.material_id !== ref.material_id || pin.material_version !== ref.material_version)
      return { status: 'failed', code: 'INPUT_REVISION_CONFLICT', materials, pending };
    const material = (await pool.query(`SELECT role,media_type,sha256 FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL`,
      [run.owner_user_id, run.project_id, ref.material_id, ref.material_version])).rows[0];
    if (!material || material.role !== pin.role || String(material.sha256).trim() !== pin.sha256)
      return { status: 'failed', code: 'INPUT_REVISION_CONFLICT', materials, pending };
    const job = (await pool.query(`SELECT state,error_code,result,material_sha256,parser_version,checkpoint FROM bb_jobs WHERE job_type=$1 AND owner_user_id=$2 AND project_id=$3 AND material_id=$4
      AND material_version=$5 AND subtype='material_parse' AND parser_version=$6`, [MATERIAL_PARSE_JOB_TYPE, run.owner_user_id, run.project_id, ref.material_id, ref.material_version, documentParserVersion()])).rows[0];
    if (job && String(job.material_sha256).trim() !== pin.sha256)
      return { status: 'failed', code: 'INPUT_REVISION_CONFLICT', materials, pending };
    const key = `${ref.material_id}:${ref.material_version}`;
    if (job?.state === 'failed') return { status: 'failed', code: job.error_code ?? 'MATERIAL_UNREADABLE', materials, pending };
    if (job?.state === 'cancelled') return { status: 'failed', code: 'INPUT_REQUIRED', materials, pending };
    if (job?.state !== 'succeeded') { pending.push(key); continue; }
    const snapshotId = job.checkpoint?.stages?.parse_evidence?.snapshot_id;
    const materialReadiness = { role: pin.role, sha256: pin.sha256, media_type: String(material.media_type) };
    const factSource = !isUnifiedInput(input.manifest) && !isReviewInput(input.manifest) && (financialRoles.has(pin.role) || isRqAnnualProspectus(materialReadiness));
    if (factSource && (typeof snapshotId !== 'string' || !snapshotId))
      return { status: 'failed', code: 'DATA_UNAVAILABLE', materials, pending };
    if (factSource) {
      const snapshot = (await pool.query(`SELECT content_sha256,parser_version,response_status FROM bb_parse_snapshots
        WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 AND material_id=$4 AND material_version=$5`,
      [snapshotId, run.owner_user_id, run.project_id, ref.material_id, ref.material_version])).rows[0];
      if (!snapshot || String(snapshot.content_sha256).trim() !== pin.sha256 || snapshot.parser_version !== job.parser_version || snapshot.response_status === 'failed')
        return { status: 'failed', code: 'DATA_UNAVAILABLE', materials, pending };
    }
    materials.push({ material_id: ref.material_id, material_version: ref.material_version, role: pin.role, sha256: pin.sha256,
      media_type: String(material.media_type),
      outcome: job.result?.outcome ?? null, parse_snapshot_id: typeof snapshotId === 'string' ? snapshotId : null });
  }
  return { status: pending.length ? 'pending' : 'ready', materials, pending };
}

export function createMaterialsReadyStage(producer?: ParsedFactProducer): RunStage {
  return {
  name: 'materials_ready',
  replay: true,
  run: async ({ pool, run, checkpoint, values }) => {
    if ((values.get('input_lock') as {m4_mode?:string})?.m4_mode) return {kind:'done',checkpoint:{original_files:true,m4:true}};
    if ((values.get('input_lock') as { review_mode?: string })?.review_mode === 'review_v1') return reviewMaterialsReady({ pool, run });
    if ((values.get('input_lock') as { authoring_mode?: string })?.authoring_mode === 'unified_v1') {
      // New file-authoring runs consume original files. Readability/OCR is handled by Codex
      // on demand, not by a pre-run full-material parse barrier. Input gate still checks ownership/hashes.
      if(!(values.get('input_lock') as {review_revision?:boolean})?.review_revision
          && !Object.keys(checkpoint).some(k=>/^unified_v[34]_/.test(k)))return {kind:'done',checkpoint:{original_files:true}};
      // Native reading/OCR remains a worker tool; a separate fact inventory is not an admission requirement.
      const r = await materialsReadiness(pool, run);
      if (r.status === 'failed') return { kind: 'pause', stage: 'awaiting_materials', reason: 'authoring_material_unreadable' };
      if (r.status === 'pending') return { kind: 'pause', stage: 'awaiting_materials', reason: 'material_parse_pending' };
      return { kind: 'done', checkpoint: { materials: r.materials.map(({ material_id, material_version, outcome }) => ({ material_id, material_version, outcome })) } };
    }
    const r = await materialsReadiness(pool, run);
    if (r.status === 'failed') return { kind: 'fail', code: r.code! };
    if (r.status === 'pending') return { kind: 'pause', stage: 'awaiting_materials', reason: 'material_parse_pending' };
    const saved = checkpoint?.materials_ready;
    if (saved && !checkpointMaterialsMatch(saved, r.materials))
      return { kind: 'pause', stage: 'capability_not_ready', reason: 'fact_extraction_checkpoint_mismatch' };
    const financial = r.materials.filter(material => financialRoles.has(material.role) || isRqAnnualProspectus(material));
    if (financial.length && !producer) return { kind: 'pause', stage: 'capability_not_ready', reason: 'fact_candidate_producer_unavailable' };
    const extractions: { material_id: string; material_version: number; extraction_run_id: string; snapshot_id: string;
      response_sha256: string; candidate_count: number; needs_review_count: number }[] = [];
    for (const material of financial) {
      const result = await producer!({ ownerUserId: run.owner_user_id, projectId: run.project_id,
        inputRevision: run.input_revision, inputHash: run.input_hash.trim(), materialId: material.material_id,
        materialVersion: material.material_version, snapshotId: material.parse_snapshot_id!,
        ...(run.channel==='non_production_test'?{testRunId:run.id}:{}) });
      if (result.snapshotId !== material.parse_snapshot_id || !result.extractionRunId || !/^[a-f0-9]{64}$/.test(result.responseSha256))
        throw new Error('FACT_EXTRACTION_RESULT_INVALID');
      const stored = (await pool.query(`SELECT input_hash,parse_response_sha256,candidate_ids,needs_review FROM bb_fact_extraction_runs
        WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 AND input_revision=$4 AND material_id=$5 AND material_version=$6 AND snapshot_id=$7`,
      [result.extractionRunId, run.owner_user_id, run.project_id, run.input_revision, material.material_id,
        material.material_version, material.parse_snapshot_id])).rows[0];
      if (!stored || String(stored.input_hash).trim() !== run.input_hash.trim() ||
          String(stored.parse_response_sha256).trim() !== result.responseSha256 ||
          !Array.isArray(stored.candidate_ids) || !Array.isArray(stored.needs_review) ||
          stored.candidate_ids.length !== result.inserted.length + result.replayed.length ||
          stored.needs_review.length !== result.needsReview.length)
        throw new Error('FACT_EXTRACTION_RESULT_NOT_PERSISTED');
      extractions.push({ material_id: material.material_id, material_version: material.material_version,
        extraction_run_id: result.extractionRunId, snapshot_id: result.snapshotId, response_sha256: result.responseSha256,
        candidate_count: stored.candidate_ids.length, needs_review_count: stored.needs_review.length });
    }
    if (financial.length && extractions.every(extraction => extraction.candidate_count === 0))
      return { kind: 'pause', stage: 'capability_not_ready', reason: 'fact_candidates_unavailable' };
    if (saved) {
      const prior = saved.extractions;
      if (prior !== undefined && (!Array.isArray(prior) ||
          prior.length !== extractions.length || extractions.some((item, index) => {
            const recorded = prior[index] as Record<string, unknown> | undefined;
            return !recorded || recorded.material_id !== item.material_id || recorded.material_version !== item.material_version ||
              recorded.extraction_run_id !== item.extraction_run_id || recorded.snapshot_id !== item.snapshot_id ||
              recorded.response_sha256 !== item.response_sha256 || recorded.candidate_count !== item.candidate_count ||
              recorded.needs_review_count !== item.needs_review_count;
          }))) return { kind: 'pause', stage: 'capability_not_ready', reason: 'fact_extraction_checkpoint_mismatch' };
    }
    return { kind: 'done', checkpoint: { materials: r.materials.map(({ material_id, material_version, outcome }): MaterialCheckpoint =>
      ({ material_id, material_version, outcome })), extractions }, upgradeCheckpoint: !!saved && saved.extractions === undefined };
  },
  };
}
export const materialsReadyStage = createMaterialsReadyStage();

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
  normalize?: Extract<ContainedCallInput['output'], { kind: 'json' }>['normalize'];
  materialTools?: MaterialToolData;
  materialToolsTrace?: true;
  fileWorkspace?: ContainedCallInput['fileWorkspace'];
  reviewTools?: ReviewToolData;
  onActivity?: ContainedCallInput['onActivity'];
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
      const validateResult = options.reviewTools ? async (value:unknown) => {
        const envelope = await reviewModelEnvelopeAsync(value,options.reviewTools!,ctx.signal);
        return !!envelope && options.validate(envelope.output);
      }
        : options.materialToolsTrace ? (value:unknown) => isMaterialModelEnvelope(value,options.materialTools!) && options.validate(value.model_output) : options.validate;
      const durable = new CodexDurableJournal({ pool, blobs, lease, validateResult });
      const journal = options.wrapJournal ? options.wrapJournal(durable) : durable;
      const callGate = await ctx.validateBeforeModelCall?.();
      if (callGate) return callGate;
      const mode=reviewActionMode(options.logicalCallId);
      const observed=mode && ((mode==='review'&&options.reviewTools) || (mode==='public_search'&&config.web_search==='live')
        || (mode==='public_compare'&&options.materialTools) || ((mode==='revision'||mode==='file_review')&&options.fileWorkspace));
      const progress=observed?createReviewActionObserver({mode,signal:ctx.signal,
        persist:action=>recordReviewAction(pool,lease,action),onError:()=>{process.stderr.write('review_action_persist_failed\n');}}):undefined;
      const authoring=['update','generation'].includes(run.task_kind)&&(!options.logicalCallId.startsWith('m4-')||options.logicalCallId==='m4-document-v1')
        ?createAuthoringActivityObserver({signal:ctx.signal,persist:activity=>recordAuthoringActivity(pool,lease,activity)}):undefined;
      let result:ContainedCallResult;
      try { result = await runContainedModelCall({ owner_user_id: run.owner_user_id, project_id: run.project_id, job_id: lease.jobId, run_id: run.id, trace_id: run.id,
        logical_call_id: options.logicalCallId, prompt_snapshot_ref: snapshotId, prompt: bytes.toString('utf8'), result_schema_version: options.resultSchemaVersion,
        output: options.fileWorkspace ? {kind:'text'} : { kind: 'json', schema: options.schema, validate: options.validate, normalize: options.normalize }, fileWorkspace: options.fileWorkspace, materialTools: options.materialTools, materialToolsTrace: options.materialToolsTrace, reviewTools: options.reviewTools, signal: ctx.signal,
        ...((progress || authoring || options.onActivity)?{onActivity:(event,intent)=>{progress?.onEvent(event,intent);authoring?.onEvent(event,intent);options.onActivity?.(event,intent);}}:{}) }, journal, config);
      } finally { await progress?.drain(); await authoring?.drain(); }
      if (result.status === 'completed' || result.status === 'reused')
        return { kind: 'done', value: options.reviewTools ? { output:result.value,tool_trace:result.reviewToolTrace } : result.value, checkpoint: { logical_call_id: options.logicalCallId, prompt_snapshot_ref: snapshotId } };
      if(result.status==='needs_reconcile'&&['fixed_credits','metered_credits'].includes(run.billing_mode??'')&&!options.reviewTools){
        const attempt=await durable.latestAttempt(options.logicalCallId);
        if(attempt?.status==='completed'){
          const saved=await durable.readCompleted(options.logicalCallId,attempt.attempt_no);
          if(saved)return {kind:'done',value:saved.value,checkpoint:{logical_call_id:options.logicalCallId,prompt_snapshot_ref:snapshotId}};
        }
      }
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
export function defaultRunStages(installed: Partial<Record<'model_generation' | 'word_delivery', RunStage>> = {}, factProducer?: ParsedFactProducer): RunStage[] {
  return RUN_PIPELINE_STAGES.map(name => name === 'input_lock' ? inputLockStage : name === 'materials_ready' ? createMaterialsReadyStage(factProducer)
    : installed[name] ?? notImplemented(name));
}

/** Claims one run job and executes its remaining stages. Returns what happened to the durable job. */
export async function runPipelineOnce(deps: RunPipelineDependencies): Promise<RunPipelineOutcome> {
  const { pool, blobs } = deps;
  const leaseSeconds = deps.leaseSeconds ?? 30, maxAttempts = deps.maxAttempts ?? 3;
  const lease = await claim(pool, leaseSeconds, { runKinds: deps.runKinds });
  deps.onLease?.(lease);
  if (!lease) return 'idle';
  const abort = new AbortController();
  const onOuterAbort = () => abort.abort();
  deps.signal?.addEventListener('abort', onOuterAbort, { once: true });
  // A lost lease (cancel won, or lease expired) stops in-flight work: codex kills its process group.
  const heartbeat = setInterval(() => { void renew(pool, lease, leaseSeconds).catch(() => { clearInterval(heartbeat); abort.abort(); }); }, Math.max(1000, leaseSeconds * 400));
  let currentStage: string | undefined;
  try {
    const run = (await pool.query('SELECT id,owner_user_id,project_id,input_revision,input_hash,task_kind,channel,test_grant_id,billing_mode FROM bb_runs WHERE id=$1 AND owner_user_id=$2', [lease.runId, lease.owner])).rows[0] as RunRow;
    const checkpoint = { ...((lease.checkpoint.stages ?? {}) as Record<string, Record<string, unknown>>) };
    const ctx: StageContext = { pool, blobs, lease, run, signal: abort.signal, checkpoint, values: new Map(), reviewedContextLoader: deps.reviewedContextLoader, testRuleCapabilityLoader: deps.testRuleCapabilityLoader,
      loadGenerationIssuerBinding: deps.loadGenerationIssuerBinding, produceTargetPeriodCandidates: deps.produceTargetPeriodCandidates,
      validateBeforeModelCall: async () => {
      // Synthetic mechanics tests install their own input-lock stage. The production stage
      // always rechecks every binding before a provider intent, including checkpoint replay.
      if (!deps.stages.includes(inputLockStage)) return null;
      const input = await currentRunInput(pool, run);
      if (!input || input.input_hash.trim() !== run.input_hash.trim()) return { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' };
      if (hasM4Manifest(input.manifest)) return m4InputGate(pool,run,input);
      if (isUnifiedInput(input.manifest)) return unifiedInputGate(pool, run, input);
      if (isReviewInput(input.manifest)) return reviewInputGate(pool, run, input);
      const generationGate = await verifyGenerationIssuerBinding(run, input.manifest, deps.loadGenerationIssuerBinding);
      if (generationGate) return generationGate;
      if(run.channel==='non_production_test')
        return (await verifyUpdateIssuerIdentityBinding(pool,run,input.manifest)) ??
          await verifyTestRuleCapability(pool,run,input,deps.testRuleCapabilityLoader);
      return (await verifyUpdateIssuerIdentityBinding(pool, run, input.manifest)) ?? await verifyProductionRulePin(pool, run, input, deps.reviewedContextLoader);
    } };
    for (const stage of deps.stages) {
      currentStage = stage.name;
      if(run.channel==='non_production_test' && stage.name!=='input_lock'){
        const input=await currentRunInput(pool,run);
        const gate=input
          ? (await verifyGenerationIssuerBinding(run,input.manifest,deps.loadGenerationIssuerBinding)) ??
            (await verifyUpdateIssuerIdentityBinding(pool,run,input.manifest)) ??
            await verifyTestRuleCapability(pool,run,input,deps.testRuleCapabilityLoader)
          : {kind:'fail',code:'INPUT_REVISION_CONFLICT'} as const;
        if(gate?.kind==='pause'){await pauseRun(pool,lease,gate.stage,safePauseReason(gate.reason));return 'paused';}
        if(gate?.kind==='fail'){await finish(pool,lease,'failed',{errorCode:gate.code,failedStage:stage.name});return 'failed';}
      }
      const saved = checkpoint[stage.name];
      if (saved && !stage.replay) { ctx.values.set(stage.name, saved); continue; }
      if(await pauseAtCheckpoint(pool,lease))return 'paused';
      await beginRunStage(pool,lease,stage.name);
      const outcome = await stage.run(ctx);
      if (outcome.kind === 'done') {
        if (!saved) {
          await checkpointStage(pool, lease, stage.name, outcome.checkpoint ?? {});
          checkpoint[stage.name] = outcome.checkpoint ?? {};
        } else if (outcome.upgradeCheckpoint) {
          await upgradeStageCheckpoint(pool, lease, stage.name, outcome.checkpoint ?? {});
          checkpoint[stage.name] = outcome.checkpoint ?? {};
        }
        ctx.values.set(stage.name, outcome.value ?? outcome.checkpoint ?? {});
        await deps.afterStage?.(stage.name, lease);
        continue;
      }
      if (outcome.kind === 'pause') { await pauseRun(pool, lease, outcome.stage, safePauseReason(outcome.reason)); return 'paused'; }
      if (outcome.kind === 'fail') { await finish(pool, lease, 'failed', { errorCode: outcome.code, failedStage: stage.name }); return 'failed'; }
      if (outcome.kind === 'stopped') return 'stopped';
      if (outcome.kind === 'qa_deliver') {
        const result=await finishM4Qa(pool,lease,outcome.reply);
        return result.state==='succeeded'?'succeeded':'paused';
      }
      if ((outcome.deliveryPolicy === 'generated_pair_v1' ? !outcome.cleanBytes : Boolean(outcome.cleanBytes) !== Boolean(outcome.baselineBytes)) ||
        (outcome.cleanBytes && !outcome.wordSummary)) {
        await finish(pool, lease, 'failed', { errorCode: 'VALIDATION_FAILED', failedStage: stage.name });
        return 'failed';
      }
      let cleanArtifactId: string | undefined;
      let baselineArtifactId: string | undefined;
      const reviewExecution = (await pool.query('SELECT operation FROM bb_review_executions WHERE owner_user_id=$1 AND run_id=$2', [run.owner_user_id, run.id])).rows[0];
      const reviewArtifacts: { id: string; version: number; kind: string }[] = [];
      const m4Artifacts:M4ArtifactRegistration[]=[];
      const uncovered:TestUncoveredItem[]=run.channel==='non_production_test'
        ? (await pool.query('SELECT uncovered_items FROM bb_runs WHERE id=$1 AND owner_user_id=$2',[run.id,run.owner_user_id])).rows[0]?.uncovered_items ?? []
        : [];
      const wordBytes=(bytes:Buffer)=>run.channel==='non_production_test'?markTestWord(bytes,uncovered):Promise.resolve(bytes);
      if (outcome.baselineBytes && outcome.deliveryPolicy !== 'generated_pair_v1') {
        const baseline = await promoteWordArtifact(pool, lease, await wordBytes(outcome.baselineBytes), blobs);
        if (baseline.status !== 'available') {
          await finish(pool, lease, 'failed', { errorCode: baseline.failureCode, failedStage: stage.name });
          return 'failed';
        }
        baselineArtifactId = baseline.artifactId;
        reviewArtifacts.push({ id: baseline.artifactId, version: baseline.artifactVersion, kind: 'baseline' });
      }
      if (outcome.cleanBytes) {
        const clean = await promoteWordArtifact(pool, lease, await wordBytes(outcome.cleanBytes), blobs, outcome.deliveryPolicy);
        if (clean.status !== 'available') {
          await finish(pool, lease, 'failed', { errorCode: clean.failureCode, failedStage: stage.name });
          return 'failed';
        }
        cleanArtifactId = clean.artifactId;
        reviewArtifacts.push({ id: clean.artifactId, version: clean.artifactVersion, kind: 'clean' });
      }
      for (const attachment of outcome.attachments ?? []) {
        const extra = attachment.mediaType === 'application/pdf'
          ? await promoteReviewPdfArtifact(pool, lease, attachment.bytes, blobs)
          : await promoteWordArtifact(pool, lease, await wordBytes(attachment.bytes), blobs, outcome.deliveryPolicy);
        if (extra.status !== 'available') { await finish(pool, lease, 'failed', { errorCode: extra.failureCode, failedStage: stage.name }); return 'failed'; }
        reviewArtifacts.push({ id: extra.artifactId, version: extra.artifactVersion, kind: attachment.kind });
      }
      for (const extra of outcome.namedArtifacts??[]) {
        const promoted=await promoteWordArtifact(pool,lease,await wordBytes(extra.bytes),blobs,outcome.deliveryPolicy);
        if (promoted.status!=='available') {await finish(pool,lease,'failed',{errorCode:promoted.failureCode,failedStage:stage.name});return 'failed';}
        m4Artifacts.push({kind:extra.kind,artifact_id:promoted.artifactId,artifact_version:promoted.artifactVersion,filename:extra.filename,byte_size:extra.bytes.length,
          ...(extra.previewContent?{preview_content:extra.previewContent}:{})});
      }
      const delivered = await promoteWordArtifact(pool, lease, await wordBytes(outcome.bytes), blobs, outcome.deliveryPolicy);
      await deps.afterStage?.('word_promoted', lease);
      if (delivered.status !== 'available') { await finish(pool, lease, 'failed', { errorCode: delivered.failureCode, failedStage: stage.name }); return 'failed'; }
      if ((ctx.values.get('input_lock') as {m4_mode?:string})?.m4_mode==='document') {
        m4Artifacts.push({kind:'document',artifact_id:delivered.artifactId,artifact_version:delivered.artifactVersion,filename:'document.docx',byte_size:outcome.bytes.length,
          ...(typeof outcome.wordSummary?.preview_content==='string'?{preview_content:outcome.wordSummary.preview_content}:{})});
        if(m4Artifacts.length!==2 || !m4Artifacts.some(a=>a.kind==='preparation_note')) {await finish(pool,lease,'failed',{errorCode:'WORD_DELIVERY_UNAVAILABLE',failedStage:stage.name});return 'failed';}
        const settled=await transaction(pool,async client=>{
          const activeRun=(await client.query(`SELECT 1 FROM bb_runs WHERE id=$1 AND owner_user_id=$2 AND state='running' FOR UPDATE`,[run.id,run.owner_user_id])).rowCount;
          const current=activeRun && (await client.query(`SELECT 1 FROM bb_jobs WHERE run_id=$1 AND owner_user_id=$2 AND id=$3 AND state='running'
            AND lease_token=$4 AND lease_until>now() FOR UPDATE`,[run.id,run.owner_user_id,lease.jobId,lease.token])).rowCount;
          if(!current)throw new Problem(409,'ALREADY_TERMINAL','Worker lease expired');
          await registerM4Artifacts(client,run.owner_user_id,run.id,m4Artifacts);
          return settleM4Metering(client,run.owner_user_id,run.id);
        });
        if(!settled.ready){await pauseRun(pool,lease,'provider_reconcile','m4_usage_pending');return 'paused';}
      }
      if (reviewExecution) {
        reviewArtifacts.push({ id: delivered.artifactId, version: delivered.artifactVersion, kind: outcome.cleanBytes || reviewExecution.operation === 'revision' ? 'revision' : 'report' });
        for (const artifact of reviewArtifacts) await pool.query(`INSERT INTO bb_review_artifacts(owner_user_id,project_id,run_id,artifact_id,artifact_version,kind,filename)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(run_id,kind) DO UPDATE SET artifact_id=EXCLUDED.artifact_id,artifact_version=EXCLUDED.artifact_version`,
        [run.owner_user_id,run.project_id,run.id,artifact.id,artifact.version,artifact.kind,`${artifact.kind}-${run.id}.docx`]);
      }
      if (cleanArtifactId) {
        const pair = { ...outcome.wordSummary, revision_artifact_id: delivered.artifactId,
          clean_artifact_id: cleanArtifactId, baseline_artifact_id: baselineArtifactId };
        await checkpointStage(pool, lease, 'word_delivery_pair', pair);
        ctx.checkpoint.word_delivery_pair = pair;
      }
      if(await pauseAtCheckpoint(pool,lease))return 'paused';
      const finished=await finish(pool, lease, run.channel==='non_production_test'?'test_completed':'succeeded', { artifactId: delivered.artifactId, artifactVersion: delivered.artifactVersion, blobs });
      return finished.state==='paused'?'paused':run.channel==='non_production_test'?'test_completed':'succeeded';
    }
    // Every production pipeline ends in delivery; running out of stages is never success.
    await pauseRun(pool, lease, 'capability_not_ready', 'stage_not_implemented');
    return 'paused';
  } catch (error) {
    if (error instanceof Error && error.message === 'SYNTHETIC_CRASH') throw error;
    if (lost(error)) return 'lost';
    if (error instanceof TrialLimitProblem) {
      if (error.limit === 'operator_deny') {
        await finish(pool, lease, 'failed', { errorCode: error.code, failedStage: currentStage });
        return 'failed';
      }
      await pauseRun(pool, lease, 'trial_limit', error.limit, error.code);
      return 'paused';
    }
    if (error instanceof Problem && (error.code.startsWith('TEST_GRANT_') || error.code==='TEST_CHANNEL_DISABLED')) {
      await pauseRun(pool,lease,'capability_not_ready',error.code.toLowerCase());
      return 'paused';
    }
    deps.onUnexpectedError?.(safeRunError(error, currentStage));
    try {
      // Infrastructure errors retry from the checkpoint; the last allowed attempt fails and keeps the checkpoint.
      if (lease.attempts < maxAttempts) {
        await releaseLease(pool, lease, currentStage === 'materials_ready' ? 'material_fact_stage_failed' : 'lease_released');
        return 'retry';
      }
      await finish(pool, lease, 'failed', { errorCode: 'DATA_UNAVAILABLE', failedStage: currentStage });
      return 'failed';
    } catch (finishError) { if (lost(finishError)) return 'lost'; throw finishError; }
  } finally {
    clearInterval(heartbeat);
    deps.signal?.removeEventListener('abort', onOuterAbort);
    deps.onLease?.(null);
  }
}
