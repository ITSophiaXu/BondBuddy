// #17 worker runtime process: `node apps/worker/dist/runtime.js` (container entrypoint).
// General slots claim run and parse jobs through PostgreSQL leases; dedicated parse slots
// keep uploads moving while long runs occupy every general slot. A sweep loop re-queues paused work
// whose blocker cleared (parsed materials, reconciled provider calls, OCR availability) and can
// forward #79 logs. SIGTERM/SIGINT stop claiming, drain in-flight work, then release leases so
// another worker resumes from the durable checkpoint at once. Nothing here trusts a browser.
import { modelCallConcurrency } from './model-call-budget.js';
import {runUploadConfirmationOnce} from '@bondbuddy/api/upload-confirmation';
import { Pool } from 'pg';
import { azureBlobs, type PrivateBlobs } from '@bondbuddy/api/data';
import { forwardLogs, ndjsonFileSink, ndjsonSizeCapFromEnv, type LogSink } from '@bondbuddy/api/log-ops';
import { releaseMaterialParse, requeueAwaitingOcrParseJobs, type MaterialParseLease } from '@bondbuddy/api/material-jobs';
import { reconcilePausedCall, recoverUnifiedTimeout, recoverFileAuthoringPayload, fileAuthoringPayloadRecoveryCandidates, releaseLease, pausedRuns, resumePausedRun, checkedRunKinds, type RunKind, type Lease } from '@bondbuddy/api/queue';
import { assertModelCallAllowed, defaultWorkerId, recordWorkerHeartbeat, TrialLimitProblem, trialGuardConfig } from '@bondbuddy/api/trial-guard';
import { reconcilePausedProviderCall, type ProviderCallObservation } from '@bondbuddy/api/provider-results';
import { runMaterialParseOnce, type MaterialParseJobDependencies } from './material-parse-job.js';
import { createMaterialsReadyStage, defaultRunStages, materialsReadiness, runPipelineOnce, type LoadGenerationIssuerBinding, type ParsedFactProducer, type RunStage, type TargetPeriodCandidateProducer } from './run-pipeline.js';
import {advanceProjectFileBatch} from '@bondbuddy/api/project-file-workspace';
import {advanceWorkpaperBatch} from '@bondbuddy/api/workpapers';
import {advanceProjectFileUpdates} from '@bondbuddy/api/project-file-consistency';
import { createRuntimeParseCache, runtimeParseCacheVersions } from './runtime-parse-cache.js';
import { modelGenerationRouter } from './model-generation-router.js';
import { loadPinnedApprovedGenerationIssuerBinding } from './generation-issuer-binding-loader.js';
import { produceTargetPeriodCandidateSnapshot } from './target-period-candidate-snapshot-producer.js';
import type { NoHistoryStageAdapters } from './no-history-model-stage.js';
import { loadCodexAdapterConfig, type CodexAdapterConfig } from './codex-adapter.js';
import { assertProbeConfig, runPlatformProbeOnce } from './platform-probe-job.js';
import { historicalWordDeliveryStage } from './historical-word-stage.js';
import { runReviewAssistantOnce } from './review-assistant.js';
import type { ReviewedContextLoader } from '@bondbuddy/api/production-rule-pin';
import { sweepParseStaging } from './parse-staging.js';
import { runFormatDiagnosticOnce } from './word-format-diagnostic.js';
import { createIssuerIdentityProducer } from './issuer-identity-producer.js';
import { createControlledNativeFactCandidateProducer } from './controlled-native-fact-candidate-producer.js';
import { loadReviewedRuleApplicabilityContext } from '@bondbuddy/rule-applicability-context';
import { createSsePrivateTestRuleCapabilityLoader } from './sse-private-test-rule-capability.js';
import type { FactEvidenceReviewGateLoaderOptions } from './fact-evidence-review-gate.js';

export type PendingAttempt = { owner_user_id: string; project_id: string; run_id: string; job_id: string; logical_call_id: string; attempt_no: number; call_id: string; model_id: string | null; prompt_snapshot_ref: string | null; observed: boolean };
export type ReconcileAnswer = { outcome: 'unknown' } | { outcome: 'confirmed_not_sent' } | { outcome: 'completed'; observation: ProviderCallObservation; validate: (value: unknown) => boolean };
/** Answers what really happened to an attempt whose outcome was not recorded (worker died mid-call). */
export interface ProviderCallReconciler { name: string; query(attempt: PendingAttempt): Promise<ReconcileAnswer> }

/**
 * `codex exec` exposes no provider request ID or lookup API (#16: provider_request_id_status is
 * always `unknown`), so the default reconciler cannot prove either supplier outcome.
 * Only the separately checked, bounded unified-timeout policy may authorize another attempt;
 * all other unknown calls stay at `provider_reconcile`. Never guess `confirmed_not_sent`.
 */
export const codexNoLookupReconciler: ProviderCallReconciler = { name: 'codex_no_lookup', query: async () => ({ outcome: 'unknown' }) };

export type WorkerRuntimeOptions = {
  pool: Pool; blobs: PrivateBlobs;
  concurrency?: number; parseSlots?: number; interactiveSlots?: number; pollMs?: number; leaseSeconds?: number; sweepMs?: number; drainMs?: number;
  kinds?: ('run' | 'parse')[];
  /** Private scheduling filter; task kinds come from the shared contract. */
  runKinds?: readonly RunKind[];
  runStages?: RunStage[];
  /** Trusted #15 producer binding. With runStages, only the environment factory's materials stage may be replaced. */
  factCandidateProducer?: ParsedFactProducer;
  /** #15/#19 reviewed context loader; production env options install the existing fail-closed implementation. */
  reviewedContextLoader?: ReviewedContextLoader;
  /** #19 private candidate capability for the explicitly enabled preproduction test channel. */
  testRuleCapabilityLoader?: import('./run-pipeline.js').TestRuleCapabilityLoader;
  /** #15 fact evidence review guard for #31. Absent = off; only the environment flag enables it. */
  factEvidenceReviewGate?: FactEvidenceReviewGateLoaderOptions;
  /** Optional trusted #33 server adapters; absent in production until their sources are ready. */
  noHistoryGenerationAdapters?: NoHistoryStageAdapters;
  /** #33 pinned generation issuer binding loader run at `input_lock`; the env factory installs the pinned-manifest loader. */
  loadGenerationIssuerBinding?: LoadGenerationIssuerBinding;
  /** #76 target-period candidate producer call; off unless the deployment explicitly enables it. */
  produceTargetPeriodCandidates?: TargetPeriodCandidateProducer;
  parse?: Omit<MaterialParseJobDependencies, 'pool' | 'leaseSeconds' | 'onLease'>;
  ocrEnabled?: boolean;
  /** Back-off before a paused awaiting_ocr job is re-queued again. */
  ocrRetrySeconds?: number;
  reconciler?: ProviderCallReconciler;
  logSink?: LogSink | null;
  log?: (event: Record<string, unknown>) => void;
  /** #35 heartbeat row (bb_worker_heartbeats) for readiness and the stale-worker alert. */
  workerId?: string; heartbeatMs?: number;
  /** #79/#16 operator-only platform probe loop (BB_PLATFORM_PROBE_ENABLED=1); absent = never claims probe jobs. */
  platformProbe?: { config: CodexAdapterConfig; pollMs?: number };
  /** M3 discussions use their own leases and never create document runs. */
  reviewAssistant?: { config?: CodexAdapterConfig; pollMs?: number };
  uploadConfirmationEnabled?: boolean;
  stagingRoot?: string;
};

const environmentMaterialsStages = new WeakMap<RunStage, { run: RunStage['run']; replay: RunStage['replay'] }>();

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  if (signal?.aborted) return resolve();
  const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(done, ms);
  const abort = () => { clearTimeout(timer); done(); };
  signal?.addEventListener('abort', abort, { once: true });
});

export class WorkerRuntime {
  private stopping = false;
  private readonly stopSignal = new AbortController();
  private readonly workAbort = new AbortController();
  private readonly runLeases = new Map<number, Lease>();
  private readonly parseLeases = new Map<number, MaterialParseLease>();
  private loops: Promise<void>[] = [];
  private confirmationLoops: Promise<void>[] = [];
  private stopTask?: Promise<void>;
  private fileAuthoringRecoveryCursor?: string;
  readonly counters = { run: 0, parse: 0, probe: 0, assistant: 0, idle: 0, sweeps: 0, errors: 0 };
  private readonly o: Required<Omit<WorkerRuntimeOptions, 'parse' | 'logSink' | 'log' | 'platformProbe' | 'reviewAssistant' | 'noHistoryGenerationAdapters' | 'factCandidateProducer' | 'reviewedContextLoader' | 'testRuleCapabilityLoader' | 'factEvidenceReviewGate' | 'stagingRoot' | 'loadGenerationIssuerBinding' | 'produceTargetPeriodCandidates'>>
    & Pick<WorkerRuntimeOptions, 'parse' | 'logSink' | 'log' | 'platformProbe' | 'reviewAssistant' | 'reviewedContextLoader' | 'testRuleCapabilityLoader' | 'factEvidenceReviewGate' | 'stagingRoot' | 'loadGenerationIssuerBinding' | 'produceTargetPeriodCandidates'>;

  constructor(options: WorkerRuntimeOptions) {
    this.o = { concurrency: 2, parseSlots: 1, interactiveSlots: 1, pollMs: 1000, leaseSeconds: 30, sweepMs: 15000, drainMs: 20000, kinds: ['run', 'parse'], runKinds: checkedRunKinds(),
      runStages: defaultRunStages({ model_generation: modelGenerationRouter({ noHistoryAdapters: options.noHistoryGenerationAdapters,
        ...(options.factEvidenceReviewGate ? { factEvidenceReviewGate: options.factEvidenceReviewGate } : {}) }),
        word_delivery: historicalWordDeliveryStage() }, options.factCandidateProducer),
      uploadConfirmationEnabled: false, ocrEnabled: false, ocrRetrySeconds: 300, reconciler: codexNoLookupReconciler, workerId: defaultWorkerId(), heartbeatMs: 10000, ...options };
    this.o.runKinds = checkedRunKinds(this.o.runKinds);
    // The environment factory supplies stages before the trusted producer can be installed.
    // Never replace a caller's explicit materials stage without its own integration decision.
    if (options.factCandidateProducer && options.runStages) {
      const materials = options.runStages.filter(stage => stage.name === 'materials_ready');
      const factoryStage = materials.length === 1 ? environmentMaterialsStages.get(materials[0]!) : undefined;
      if (!factoryStage || materials[0]!.run !== factoryStage.run || materials[0]!.replay !== factoryStage.replay)
        throw new Error('factCandidateProducer conflicts with explicit materials_ready stage');
      this.o.runStages = this.o.runStages.map(stage => stage.name === 'materials_ready'
        ? createMaterialsReadyStage(options.factCandidateProducer) : stage);
    }
    if (!Number.isInteger(this.o.concurrency) || this.o.concurrency < 1 || this.o.concurrency > 16) throw new Error('Invalid worker concurrency');
    if (!Number.isInteger(this.o.interactiveSlots) || this.o.interactiveSlots < 0 || this.o.interactiveSlots > 4) throw new Error('Invalid worker interactive slots');
    if (!Number.isInteger(this.o.parseSlots) || this.o.parseSlots < 0 || this.o.parseSlots > 4) throw new Error('Invalid worker parse slots');
  }

  private get dedicatedParseSlots() {
    // A single-kind worker keeps exactly its configured general-slot capacity.
    return this.o.parse && this.o.kinds.includes('run') && this.o.kinds.includes('parse') ? this.o.parseSlots : 0;
  }

  private get dedicatedInteractiveSlots() {
    return this.o.kinds.includes('run') && this.o.runKinds.some(kind=>kind==='qa'||kind==='generation') ? this.o.interactiveSlots : 0;
  }

  start() {
    if(this.o.kinds.includes('run') && this.o.runKinds.some(kind=>kind==='update'||kind==='generation')) this.loops.push(this.formatDiagnosticLoop());
    for (let slot = 0; slot < this.o.concurrency; slot++) this.loops.push(this.slotLoop(slot));
    for (let slot = this.o.concurrency; slot < this.o.concurrency + this.dedicatedParseSlots; slot++) this.loops.push(this.slotLoop(slot, ['parse']));
    const interactiveStart=this.o.concurrency+this.dedicatedParseSlots;
    for(let slot=interactiveStart;slot<interactiveStart+this.dedicatedInteractiveSlots;slot++)this.loops.push(this.slotLoop(slot,['run'],true));
    if(this.o.uploadConfirmationEnabled)this.loops.push(this.uploadConfirmationLoop());
    this.loops.push(this.sweepLoop());
    this.loops.push(this.heartbeatLoop());
    if (this.o.stagingRoot) this.loops.push(this.stagingLoop(this.o.stagingRoot));
    if (this.o.platformProbe) this.loops.push(this.probeLoop(this.o.platformProbe));
    if (this.o.reviewAssistant && this.o.kinds.includes('run') && this.o.runKinds.includes('review')) this.loops.push(this.assistantLoop(this.o.reviewAssistant));
    return this;
  }

  private emit(event: Record<string, unknown>) { this.o.log?.({ at: new Date().toISOString(), ...event }); }

  /** General slots alternate claims; dedicated slots claim only their assigned work. */
  private async slotLoop(slot: number, kinds: readonly ('run' | 'parse')[] = this.o.kinds, interactiveOnly=false) {
    let turn = slot;
    while (!this.stopping) {
      let worked = false;
      for (let i = 0; i < kinds.length && !this.stopping && !worked; i++) {
        const kind = kinds[(turn + i) % kinds.length];
        try {
          if(kind==='run'&&!interactiveOnly&&this.o.runKinds.includes('generation')){
            for(const advance of [advanceProjectFileBatch,advanceProjectFileUpdates,advanceWorkpaperBatch])try{await advance(this.o.pool);}
            catch(error){this.emit({slot,kind:'file_batch',outcome:'scheduler_error',message:error instanceof Error?error.message:'Unknown error'});}
          }
          const outcome = kind === 'run'
            ? await runPipelineOnce({ pool: this.o.pool, blobs: this.o.blobs, stages: this.o.runStages, leaseSeconds: this.o.leaseSeconds, signal: this.workAbort.signal,
              runKinds: this.o.runKinds, interactiveOnly, reviewedContextLoader: this.o.reviewedContextLoader,
              testRuleCapabilityLoader: this.o.testRuleCapabilityLoader,
              loadGenerationIssuerBinding: this.o.loadGenerationIssuerBinding,
              produceTargetPeriodCandidates: this.o.produceTargetPeriodCandidates,
              onUnexpectedError: error => this.emit({ slot, kind: 'run', outcome: 'unexpected_error', ...error }),
              onLease: lease => { if (lease) this.runLeases.set(slot, lease); else this.runLeases.delete(slot); } })
            : this.o.parse ? await runMaterialParseOnce({ ...this.o.parse, pool: this.o.pool, leaseSeconds: this.o.leaseSeconds,
              onLease: lease => { if (lease) this.parseLeases.set(slot, lease); else this.parseLeases.delete(slot); } }) : 'idle';
          if (outcome !== 'idle') { worked = true; this.counters[kind]++; this.emit({ slot, kind, outcome }); }
        } catch (error) {
          this.counters.errors++;
          this.emit({ slot, kind, outcome: 'error', error: error instanceof Error ? error.message.slice(0, 64).replace(/[^A-Za-z0-9_ .:-]/g, '') : 'unknown' });
        }
      }
      turn++;
      if (!worked) { this.counters.idle++; await sleep(this.o.pollMs, this.stopSignal.signal); }
    }
  }

  /** One probe at a time, outside the run/parse slots, so a probe never takes a user job's slot. */
  private async probeLoop(probe: NonNullable<WorkerRuntimeOptions['platformProbe']>) {
    while (!this.stopping) {
      let outcome = 'idle';
      try { outcome = await runPlatformProbeOnce({ pool: this.o.pool, blobs: this.o.blobs, config: probe.config }); }
      catch { this.counters.errors++; outcome = 'error'; }
      if (outcome !== 'idle') { this.counters.probe++; this.emit({ kind: 'platform_probe', outcome }); }
      if (outcome === 'idle' || outcome === 'error') await sleep(probe.pollMs ?? 5000, this.stopSignal.signal);
    }
  }

  private async assistantLoop(options: NonNullable<WorkerRuntimeOptions['reviewAssistant']>) {
    while (!this.stopping) {
      let outcome = 'idle';
      try { outcome = await runReviewAssistantOnce({ pool: this.o.pool, blobs: this.o.blobs, signal: this.workAbort.signal, config: options.config }); }
      catch { this.counters.errors++; outcome = 'error'; }
      if (outcome !== 'idle') { this.counters.assistant++; this.emit({ kind: 'review_assistant', outcome }); }
      if (outcome === 'idle' || outcome === 'error') await sleep(options.pollMs ?? this.o.pollMs, this.stopSignal.signal);
    }
  }

  /** Explicitly enabled on the pure parser deployment; one independent upload slot. */
  private async uploadConfirmationLoop(){
    while(!this.stopping){
      let outcome='idle';
      try{outcome=await runUploadConfirmationOnce(this.o.pool,this.o.blobs);}
      catch{this.counters.errors++;outcome='error';}
      if(outcome!=='idle')this.emit({kind:'upload_confirmation',outcome});
      if(outcome==='idle'||outcome==='error')await sleep(this.o.pollMs,this.stopSignal.signal);
    }
  }

  private async sweepLoop() {
    while (!this.stopping) {
      try { await this.sweep(); } catch { this.counters.errors++; }
      await sleep(this.o.sweepMs, this.stopSignal.signal);
    }
  }

  private async formatDiagnosticLoop() {
    while (!this.stopping) {
      let outcome = 'idle';
      try { outcome = await runFormatDiagnosticOnce({ pool: this.o.pool, blobs: this.o.blobs, signal: this.workAbort.signal }); }
      catch { outcome = 'error'; }
      if (outcome !== 'idle') this.emit({ kind: 'word_format_diagnostic', outcome });
      // This independent loop never holds a document execution slot or delays a download.
      await sleep(outcome === 'completed' ? this.o.pollMs : this.o.sweepMs, this.stopSignal.signal);
    }
  }

  private async stagingLoop(root: string) {
    while (!this.stopping) {
      try {
        const result = await sweepParseStaging(root);
        if (result.removed) this.emit({ kind: 'parse_staging_cleanup', removed: result.removed, bytes: result.bytes });
      } catch { this.counters.errors++; this.emit({ kind: 'parse_staging_cleanup', outcome: 'error' }); }
      await sleep(5 * 60 * 1000, this.stopSignal.signal);
    }
  }

  private readonly startedAt = new Date();
  /** Upserts this process's heartbeat; a failed write only counts as an error (readiness will show it stale). */
  async heartbeat(stopped = false) {
    try { await recordWorkerHeartbeat(this.o.pool, { workerId: this.o.workerId, startedAt: this.startedAt, kinds: this.o.kinds, concurrency: this.o.concurrency + this.dedicatedParseSlots + this.dedicatedInteractiveSlots, stopped }); }
    catch { this.counters.errors++; }
  }

  private async heartbeatLoop() {
    while (!this.stopping) {
      await this.heartbeat();
      await sleep(this.o.heartbeatMs, this.stopSignal.signal);
    }
  }

  /** One pass over paused work. Safe to run from several workers: every transition re-checks under row locks. */
  async sweep() {
    const { pool } = this.o;
    this.counters.sweeps++;
    if (this.o.kinds.includes('run')) {
      const payloads=await fileAuthoringPayloadRecoveryCandidates(pool,20,this.o.runKinds,this.fileAuthoringRecoveryCursor);
      this.fileAuthoringRecoveryCursor=payloads.length===20?payloads.at(-1)!.job_id:undefined;
      for(const r of payloads)await recoverFileAuthoringPayload(pool,r.owner_user_id,r.run_id,r.job_id);
      for (const r of await pausedRuns(pool, 'awaiting_materials', 20, this.o.runKinds)) {
        const run = (await pool.query(`SELECT owner_user_id,project_id,input_revision,input_hash,
          (SELECT payload->>'reason' FROM bb_run_events WHERE run_id=bb_runs.id AND state='paused' ORDER BY seq DESC LIMIT 1) AS pause_reason
          FROM bb_runs WHERE id=$1 AND owner_user_id=$2`, [r.run_id, r.owner_user_id])).rows[0];
        if (!run) continue;
        // Parsed material readiness cannot resolve a model context/output/OCR failure.
        if(run.pause_reason!=='material_parse_pending')continue;
        const readiness = await materialsReadiness(pool, run);
        // A failed material is decided on the next claim (the stage fails the run with its code).
        if (readiness.status !== 'pending') await resumePausedRun(pool, r.owner_user_id, r.run_id, 'materials_ready');
      }
      for (const r of await pausedRuns(pool, 'credits_exhausted', 20, this.o.runKinds)) await resumePausedRun(pool, r.owner_user_id, r.run_id, 'credits_recharged');
      for (const r of await pausedRuns(pool, 'provider_reconcile', 20, this.o.runKinds)) await this.reconcileRun(r.owner_user_id, r.run_id, r.job_id);
      for (const r of await pausedRuns(pool, 'trial_limit', 20, this.o.runKinds)) {
        const client = await pool.connect();
        let ready = false;
        try {
          await assertModelCallAllowed(client, trialGuardConfig(), r.owner_user_id);
          ready = true;
        } catch (error) {
          // A later deny override is terminal. Re-claim once so the normal run path records it.
          if (error instanceof TrialLimitProblem) ready = error.limit === 'operator_deny';
          else throw error;
        } finally { client.release(); }
        if (ready) await resumePausedRun(pool, r.owner_user_id, r.run_id, 'trial_limit_cleared');
      }
    }
    if (this.o.kinds.includes('parse') && this.o.ocrEnabled && this.o.parse?.ocr) await requeueAwaitingOcrParseJobs(pool, { minPausedSeconds: this.o.ocrRetrySeconds });
    if (this.o.logSink) await forwardLogs(pool, this.o.logSink);
  }

  /** Queries every unresolved attempt first; only proven outcomes are recorded, then the run is re-queued. */
  async reconcileRun(owner: string, runId: string, jobId: string) {
    const { pool } = this.o;
    const attempts = (await pool.query(`SELECT a.owner_user_id,r.project_id,r.id AS run_id,a.job_id,a.logical_call_id,a.attempt_no,a.id AS call_id,a.model_id,a.prompt_snapshot_id AS prompt_snapshot_ref,
        EXISTS(SELECT 1 FROM bb_provider_call_observations o WHERE o.attempt_id=a.id) AS observed
      FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id JOIN bb_runs r ON r.id=j.run_id
      WHERE a.owner_user_id=$1 AND a.job_id=$2 AND r.id=$3 AND a.status='pending_reconcile' ORDER BY a.logical_call_id,a.attempt_no`, [owner, jobId, runId])).rows as PendingAttempt[];
    for (const attempt of attempts) {
      const answer = await this.o.reconciler.query(attempt);
      this.emit({ kind: 'reconcile', run_id: runId, logical_call_id: attempt.logical_call_id, attempt_no: attempt.attempt_no, reconciler: this.o.reconciler.name, outcome: answer.outcome });
      if (answer.outcome === 'confirmed_not_sent') await reconcilePausedCall(pool, owner, runId, attempt.logical_call_id, attempt.attempt_no, 'confirmed_not_sent');
      else if (answer.outcome === 'completed') await reconcilePausedProviderCall(pool, this.o.blobs, answer.observation, answer.validate);
      else return await recoverFileAuthoringPayload(pool, owner, runId, jobId) || recoverUnifiedTimeout(pool, owner, runId, jobId);
    }
    return resumePausedRun(pool, owner, runId, 'provider_reconciled');
  }

  /** Stop claiming, let in-flight work finish for drainMs, then abort it and release held leases. */
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.stopSignal.abort();
    const drained = await Promise.race([Promise.all(this.loops).then(() => true), sleep(this.o.drainMs).then(() => false)]);
    if (!drained) {
      this.workAbort.abort();
      await Promise.race([Promise.all(this.loops), sleep(5000)]);
    }
    for (const lease of this.runLeases.values()) await releaseLease(this.o.pool, lease).catch(() => undefined);
    for (const lease of this.parseLeases.values()) await releaseMaterialParse(this.o.pool, lease).catch(() => undefined);
    await this.heartbeat(true);
    this.emit({ kind: 'stopped', drained, released: this.runLeases.size + this.parseLeases.size });
  }
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) {
  const raw = env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

/**
 * Production options from the container environment: parse and run pipelines (defaultRunStages()),
 * bounded concurrency and, only when BB_PLATFORM_PROBE_ENABLED=1, the contained Codex adapter for the
 * operator probe (env credential mode, checked without reading the value). Nothing starts here.
 */
export function workerRuntimeOptionsFromEnv(pool: Pool, blobs: PrivateBlobs, env: NodeJS.ProcessEnv = process.env,
  ocr?: (pool: Pool, blobs: PrivateBlobs) => MaterialParseJobDependencies['ocr']): WorkerRuntimeOptions {
  if(env.BB_UPLOAD_CONFIRMATION_ENABLED==='1'&&(!env.BB_UPLOAD_SPOOL_DIR?.startsWith('/')||!Number.isSafeInteger(Number(env.BB_UPLOAD_SPOOL_MAX_BYTES))||Number(env.BB_UPLOAD_SPOOL_MAX_BYTES)<1))
    throw new Error('Upload confirmation requires an explicit absolute spool path and byte budget');
  modelCallConcurrency(env);
  intEnv(env, 'BB_REVIEW_ASSISTANT_SLOTS', 1, 1, 1);
  const kinds = (env.BB_WORKER_JOB_KINDS || 'run,parse').split(',').map(k => k.trim());
  if (!kinds.length || kinds.some(k => k !== 'run' && k !== 'parse')) throw new Error('Invalid BB_WORKER_JOB_KINDS');
  const runKinds = checkedRunKinds(env.BB_WORKER_RUN_KINDS === undefined ? undefined : env.BB_WORKER_RUN_KINDS.split(',').map(k => k.trim()) as RunKind[]);
  const group = env.BB_WORKER_GROUP;
  if (group !== undefined && !/^[a-z][a-z0-9-]{0,31}$/.test(group)) throw new Error('Invalid BB_WORKER_GROUP');
  const ocrEnabled = env.BB_OCR_ENABLED === '1';
  const parseCache = kinds.includes('parse') ? createRuntimeParseCache(pool, blobs, runtimeParseCacheVersions(env)) : undefined;
  let platformProbe: WorkerRuntimeOptions['platformProbe'];
  if (env.BB_PLATFORM_PROBE_ENABLED === '1') {
    const config = loadCodexAdapterConfig(env);
    assertProbeConfig(config, env);
    platformProbe = { config, pollMs: intEnv(env, 'BB_PLATFORM_PROBE_POLL_MS', 5000, 500, 600000) };
  }
  // #15/#31: the fact evidence review guard stays off unless the deployment explicitly enables it.
  const factEvidenceReviewGate = env.BB_FACT_EVIDENCE_REVIEW_GATE === '1'
    ? { enabled: () => true } : undefined;
  const runStages = defaultRunStages({ model_generation: modelGenerationRouter(
    factEvidenceReviewGate ? { factEvidenceReviewGate } : {}),
    word_delivery: historicalWordDeliveryStage() });
  const testChannelEnabled = env.BB_DEPLOYMENT_TIER === 'preprod' && env.BB_NON_PRODUCTION_TEST_CHANNEL === 'enabled';
  // #76 target-period candidate producer: off unless the deployment explicitly enables the call.
  // The #33 pinned issuer binding loader is always installed; it only runs when a generation run's
  // locked manifest actually pins a binding ref, so an unpinned input keeps its current behavior.
  const targetPeriodCandidateProducer = env.BB_TARGET_PERIOD_CANDIDATE_PRODUCER === '1';
  const materials = runStages.find(stage => stage.name === 'materials_ready')!;
  environmentMaterialsStages.set(materials, { run: materials.run, replay: materials.replay });
  return {
    pool, blobs, kinds: kinds as ('run' | 'parse')[], runKinds, runStages,
    ...(group ? { workerId: `${group}_${defaultWorkerId()}` } : {}),
    ...(kinds.includes('run') && runKinds.includes('review') ? { reviewAssistant: {} } : {}),
    reviewedContextLoader: loadReviewedRuleApplicabilityContext,
    loadGenerationIssuerBinding: scope => loadPinnedApprovedGenerationIssuerBinding(pool, scope),
    ...(targetPeriodCandidateProducer ? { produceTargetPeriodCandidates: async request =>
      { await produceTargetPeriodCandidateSnapshot({ pool, blobs }, request); } } : {}),
    ...(testChannelEnabled ? { testRuleCapabilityLoader: createSsePrivateTestRuleCapabilityLoader(pool) } : {}),
    factCandidateProducer: createControlledNativeFactCandidateProducer({ pool }),
    interactiveSlots: intEnv(env, 'BB_WORKER_INTERACTIVE_SLOTS', 1, 0, 4),
    uploadConfirmationEnabled: env.BB_UPLOAD_CONFIRMATION_ENABLED==='1',
    concurrency: intEnv(env, 'BB_WORKER_CONCURRENCY', 2, 1, 16), parseSlots: intEnv(env, 'BB_WORKER_PARSE_SLOTS', 1, 0, 4), pollMs: intEnv(env, 'BB_WORKER_POLL_MS', 1000, 100, 60000),
    leaseSeconds: intEnv(env, 'BB_WORKER_LEASE_SECONDS', 30, 5, 600), sweepMs: intEnv(env, 'BB_WORKER_SWEEP_MS', 15000, 1000, 600000),
    drainMs: intEnv(env, 'BB_WORKER_DRAIN_MS', 20000, 0, 600000), heartbeatMs: intEnv(env, 'BB_WORKER_HEARTBEAT_MS', 10000, 1000, 300000), ocrRetrySeconds: intEnv(env, 'BB_OCR_RETRY_SECONDS', 300, 0, 86400),
    parse: { issuerIdentityProducer: createIssuerIdentityProducer(pool), material: { pool, blobs: { getPrivate: key => blobs.getIfExists(key),
      ...(blobs.readToFile ? { readToFile: (key: string, path: string, max: number) => blobs.readToFile!(key, path, max) } : {}) },
      ...(parseCache ? { parseCache } : {}), ...(env.BB_PARSE_STAGING_DIR ? { tempRoot: env.BB_PARSE_STAGING_DIR } : {}) }, ocrProfiles: ocrEnabled ? { pool, blobs } : undefined,
      ocr: ocrEnabled ? ocr?.(pool, blobs) : undefined },
    ...(env.BB_PARSE_STAGING_DIR ? { stagingRoot: env.BB_PARSE_STAGING_DIR } : {}),
    ocrEnabled,
    logSink: env.BB_LOG_NDJSON_PATH ? ndjsonFileSink(env.BB_LOG_NDJSON_PATH, 'ndjson_file', ndjsonSizeCapFromEnv(env)) : null,
    ...(platformProbe ? { platformProbe } : {}),
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (!process.env.DATABASE_URL || !process.env.AZURE_STORAGE_CONNECTION_STRING) throw new Error('DATABASE_URL and AZURE_STORAGE_CONNECTION_STRING are required');
  const generalSlots = intEnv(process.env, 'BB_WORKER_CONCURRENCY', 2, 1, 16);
  const parseSlots = intEnv(process.env, 'BB_WORKER_PARSE_SLOTS', 1, 0, 4);
  const kinds = (process.env.BB_WORKER_JOB_KINDS || 'run,parse').split(',').map(kind => kind.trim());
  const runKinds=checkedRunKinds(process.env.BB_WORKER_RUN_KINDS?.split(',').map(kind=>kind.trim()) as RunKind[]|undefined);
  const interactiveSlots=kinds.includes('run')&&runKinds.some(kind=>kind==='qa'||kind==='generation')?intEnv(process.env,'BB_WORKER_INTERACTIVE_SLOTS',1,0,4):0;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: generalSlots + interactiveSlots + (kinds.includes('run') && kinds.includes('parse') ? parseSlots : 0) + 4 });
  const blobs = azureBlobs(process.env.AZURE_STORAGE_CONNECTION_STRING);
  const { processOcrMaterial } = await import('./ocr.js');
  const options = workerRuntimeOptionsFromEnv(pool, blobs, process.env, (db, store) => input => processOcrMaterial(db, store, { ...input, purpose: 'source_preflight' }));
  if (options.stagingRoot) await sweepParseStaging(options.stagingRoot);
  const runtime = new WorkerRuntime({ ...options, log: event => process.stdout.write(`${JSON.stringify(event)}\n`) }).start();
  process.stdout.write(`${JSON.stringify({ kind: 'started', kinds: options.kinds, run_kinds: options.runKinds, worker_group: process.env.BB_WORKER_GROUP ?? null, concurrency: options.concurrency, interactive_slots: interactiveSlots, parse_slots: options.kinds?.includes('run') && options.kinds.includes('parse') ? options.parseSlots : 0, ocr_enabled: options.ocrEnabled, platform_probe: !!options.platformProbe,upload_confirmation:!!options.uploadConfirmationEnabled })}\n`);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await runtime.stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}
