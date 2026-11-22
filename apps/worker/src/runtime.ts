import {flushPerformanceTraces} from '@bondbuddy/api/performance-trace';
import {executionNodeForPool,executionNodeState,heartbeatExecutionRuntime} from '@bondbuddy/api/execution-capacity';
import {enrollExecutionNodeFromEnv,assertManagedRuntimeOptions,nativeExecutionChildren,nativeExecutionProcesses} from './execution-node-runtime.js';
import {ManagedRunRetries} from './managed-run-retries.js';
import {needsLeaseRelease} from './lease-outcome.js';
import {durableSpoolRoot,durableSpoolHealth} from './durable-spool.js';
import {runDurableSpoolPass} from './durable-spool-consumer.js';
import {pendingSealedCaptureCount,retryPendingSealedCaptures} from './pending-sealed-captures.js';
import {boundedPrivateBlobs} from './bounded-private-blobs.js';
import {mkdir} from 'node:fs/promises';
import {assertTaskExecution,initializeTaskExecution,taskNativeProcesses,taskReleaseProof,retireTaskExecution,sweepCompletedTaskExecutions,withBackgroundTaskExecution} from './task-execution.js';
import {executionTransportFromEnv,type ExecutionTransportHealth} from './execution-node-transport.js';
import { modelCallConcurrency } from './model-call-budget.js';
import {withWorkflowHandoffPerformance,reportSpoolHealth} from './workflow-observability.js';
import { createFileWorkspaceRetention } from './codex-file-retention.js';
// #17 worker runtime process: `node apps/worker/dist/runtime.js` (container entrypoint).
// General slots claim run and parse jobs through PostgreSQL leases; dedicated parse slots
// keep uploads moving while long runs occupy every general slot. A sweep loop re-queues paused work
// whose blocker cleared (parsed materials, reconciled provider calls, OCR availability) and can
// forward #79 logs. SIGTERM/SIGINT stop claiming, drain in-flight work, then release leases so
// another worker resumes from the durable checkpoint at once. Nothing here trusts a browser.
import {runUploadConfirmationOnce,UPLOAD_CONFIRMATION_SMALL_MAX_BYTES,type UploadConfirmationLane} from '@bondbuddy/api/upload-confirmation';
import {M1_UPLOAD_LIMITS} from '@bondbuddy/contracts';
import { Pool } from 'pg';
import { azureBlobs, type PrivateBlobs } from '@bondbuddy/api/data';
import { forwardLogs, ndjsonFileSink, ndjsonSizeCapFromEnv, type LogSink } from '@bondbuddy/api/log-ops';
import { releaseMaterialParse, requeueAwaitingOcrParseJobs, type MaterialParseLease } from '@bondbuddy/api/material-jobs';
import { releaseLease, completeManagedRunRelease, resumeVerifiedWorkflow, PAUSED_RUN_SWEEP_STAGES,pausedRunSweepCandidates,beginPausedRunSweep,completePausedRunSweep,
 type PausedRunSweepStage,checkedRunKinds, type RunKind, type Lease } from '@bondbuddy/api/queue';
import { assertModelCallAllowed, defaultWorkerId, recordWorkerHeartbeat, TrialLimitProblem, trialGuardConfig } from '@bondbuddy/api/trial-guard';
import { ProviderReconciliationSweep, reconcileProviderRun, codexNoLookupReconciler, type ProviderCallReconciler } from './provider-reconcile-sweep.js';
export { codexNoLookupReconciler, type ProviderCallReconciler, type PendingAttempt, type ReconcileAnswer } from './provider-reconcile-sweep.js';
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

export type WorkerRuntimeOptions = {
  pool: Pool; blobs: PrivateBlobs;
  concurrency?: number; parseSlots?: number; interactiveSlots?: number; pollMs?: number; leaseSeconds?: number; sweepMs?: number; drainMs?: number;
  kinds?: ('run' | 'parse')[];
  /** Private scheduling filter; task kinds come from the shared contract. */
  runKinds?: readonly RunKind[];
  runStages?: RunStage[];
  workflowPhase?:import('@bondbuddy/contracts').WorkflowPhase|'mixed';
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
  /** Trusted private transport health, independent of job lease renewal. */
  executionTransport?:ExecutionTransportHealth;
  /** Authoring candidate bytes must be durable before this process can admit more model work or finish. */
  candidateRetention?: { pendingCount(): Promise<number> };
  /** #79/#16 operator-only platform probe loop (BB_PLATFORM_PROBE_ENABLED=1); absent = never claims probe jobs. */
  platformProbe?: { config: CodexAdapterConfig; pollMs?: number };
  /** M3 discussions use their own leases and never create document runs. */
  reviewAssistant?: { config?: CodexAdapterConfig; pollMs?: number; slots?: number };
  uploadConfirmationEnabled?: boolean;
  /** Internal upload-only claim filter. General preserves the legacy consumer. */
  uploadConfirmationLane?: UploadConfirmationLane;
  /** One extra <=16 MiB slot, sharing this process's bounded upload spool. */
  uploadConfirmationSmallSlot?: boolean;
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
  private readonly retries=new ManagedRunRetries(taskNativeProcesses,async lease=>{
    const result=await withWorkflowHandoffPerformance(this.o.pool,lease,control=>completeManagedRunRelease(control,lease,taskReleaseProof(this.o.pool,lease)));
    if(result!=='blocked')try{await retireTaskExecution(lease);}
    catch{this.counters.errors++;this.emit({kind:'task_cgroup_retire',outcome:'blocked'});}
    return result;
  });
  private loops: Promise<void>[] = [];
  private confirmationLoops: Promise<void>[] = [];
  private stopTask?: Promise<void>;
  private spoolPending=0;
  private spoolGcPending=0;
  private sealedCapturePending=0;
  private spoolUnsafe=false;
  private readonly providerRecovery: ProviderReconciliationSweep;
  private readonly candidateRetention: NonNullable<WorkerRuntimeOptions['candidateRetention']>;
  private candidateScan?: Promise<number>;
  private candidateInventoryFault = false;
  readonly counters = { run: 0, parse: 0, probe: 0, assistant: 0, idle: 0, sweeps: 0, errors: 0 };
  private readonly o: Required<Omit<WorkerRuntimeOptions, 'candidateRetention' | 'workflowPhase' | 'executionTransport' | 'parse' | 'logSink' | 'log' | 'platformProbe' | 'reviewAssistant' | 'noHistoryGenerationAdapters' | 'factCandidateProducer' | 'reviewedContextLoader' | 'testRuleCapabilityLoader' | 'factEvidenceReviewGate' | 'stagingRoot' | 'loadGenerationIssuerBinding' | 'produceTargetPeriodCandidates'>>
    & Pick<WorkerRuntimeOptions, 'workflowPhase' | 'executionTransport' | 'parse' | 'logSink' | 'log' | 'platformProbe' | 'reviewAssistant' | 'reviewedContextLoader' | 'testRuleCapabilityLoader' | 'factEvidenceReviewGate' | 'stagingRoot' | 'loadGenerationIssuerBinding' | 'produceTargetPeriodCandidates'>;

  constructor(options: WorkerRuntimeOptions) {
    // Parser-only deployments never create authoring workspaces. Their independent
    // upload lane must keep operating when an authoring node retains a candidate.
    this.candidateRetention = options.candidateRetention ?? (!options.kinds || options.kinds.includes('run')
      ? createFileWorkspaceRetention() : { pendingCount: async () => 0 });
    this.o = { concurrency: 2, parseSlots: 1, interactiveSlots: 1, pollMs: 1000, leaseSeconds: 30, sweepMs: 15000, drainMs: 20000, kinds: ['run', 'parse'], runKinds: checkedRunKinds(),
      runStages: defaultRunStages({ model_generation: modelGenerationRouter({ noHistoryAdapters: options.noHistoryGenerationAdapters,workflowEnabled:!!options.workflowPhase,
        ...(options.factEvidenceReviewGate ? { factEvidenceReviewGate: options.factEvidenceReviewGate } : {}) }),
        word_delivery: historicalWordDeliveryStage() }, options.factCandidateProducer),
      uploadConfirmationEnabled: false, uploadConfirmationLane: 'general', uploadConfirmationSmallSlot: false, ocrEnabled: false, ocrRetrySeconds: 300, reconciler: codexNoLookupReconciler, workerId: defaultWorkerId(), heartbeatMs: 10000, ...options };
    this.o.runKinds = checkedRunKinds(this.o.runKinds);
    this.providerRecovery = new ProviderReconciliationSweep({...this.o,log:event=>this.emit(event)});
    if (this.o.reviewAssistant && (!Number.isInteger(this.o.reviewAssistant.slots ?? 1) || (this.o.reviewAssistant.slots ?? 1) < 1 || (this.o.reviewAssistant.slots ?? 1) > 8)) throw new Error('Invalid assistant slots');
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
    if(this.o.uploadConfirmationSmallSlot&&(!this.o.uploadConfirmationEnabled||this.o.kinds.length!==1||this.o.kinds[0]!=='parse'))
      throw new Error('Reserved upload confirmation slot requires the pure parser confirmation process');
    if(!['general','small','large'].includes(this.o.uploadConfirmationLane)||this.o.uploadConfirmationLane!=='general'&&
      (!this.o.uploadConfirmationEnabled||this.o.uploadConfirmationSmallSlot||this.o.kinds.length!==1||this.o.kinds[0]!=='parse'))
      throw new Error('A filtered confirmation lane requires one pure parser confirmation loop');
  }

  private get dedicatedParseSlots() {
    // A single-kind worker keeps exactly its configured general-slot capacity.
    return this.o.parse && this.o.kinds.includes('run') && this.o.kinds.includes('parse') ? this.o.parseSlots : 0;
  }

  private get dedicatedInteractiveSlots() {
    if(this.o.workflowPhase)return 0;
    return this.o.kinds.includes('run') && this.o.runKinds.some(kind=>kind==='qa'||kind==='generation') ? this.o.interactiveSlots : 0;
  }

  start() {
    if(executionNodeForPool(this.o.pool)){assertManagedRuntimeOptions(this.o);assertTaskExecution(this.o.pool);}
    if(!executionNodeForPool(this.o.pool)&&this.o.kinds.includes('run') && this.o.runKinds.some(kind=>kind==='update'||kind==='generation')) this.loops.push(this.formatDiagnosticLoop());
    for (let slot = 0; slot < this.o.concurrency; slot++) this.loops.push(this.slotLoop(slot));
    for (let slot = this.o.concurrency; slot < this.o.concurrency + this.dedicatedParseSlots; slot++) this.loops.push(this.slotLoop(slot, ['parse']));
    const interactiveStart=this.o.concurrency+this.dedicatedParseSlots;
    for(let slot=interactiveStart;slot<interactiveStart+this.dedicatedInteractiveSlots;slot++)this.loops.push(this.slotLoop(slot,['run'],true));
    if(this.o.uploadConfirmationEnabled)this.confirmationLoops.push(this.uploadConfirmationLoop(this.o.uploadConfirmationLane));
    if(this.o.uploadConfirmationSmallSlot)this.confirmationLoops.push(this.uploadConfirmationLoop('small'));
    this.loops.push(this.sweepLoop());
    this.heartbeatTask=this.heartbeatLoop();
    if(executionNodeForPool(this.o.pool))this.loops.push(this.spoolLoop());
    if (this.o.stagingRoot) this.loops.push(this.stagingLoop(this.o.stagingRoot));
    if (this.o.platformProbe) this.loops.push(this.probeLoop(this.o.platformProbe));
    if (this.o.reviewAssistant && this.o.kinds.includes('run') && this.o.runKinds.includes('review'))
      for (let slot = 0; slot < (this.o.reviewAssistant.slots ?? 1); slot++) this.loops.push(this.assistantLoop(this.o.reviewAssistant));
    return this;
  }

  private emit(event: Record<string, unknown>) { this.o.log?.({ at: new Date().toISOString(), ...event }); }

  private async retainedCandidateCount(): Promise<number> {
    if (this.candidateScan) return this.candidateScan;
    const scan = (async () => {
      try {
        const count = await this.candidateRetention.pendingCount();
        if (!Number.isSafeInteger(count) || count < 0) throw Error('Invalid candidate inventory');
        if (this.candidateInventoryFault) this.emit({ kind: 'candidate_retention_inventory', outcome: 'recovered' });
        this.candidateInventoryFault = false;
        return count;
      } catch (error) {
        if (!this.candidateInventoryFault) {
          this.counters.errors++;
          const code = (error as NodeJS.ErrnoException)?.code;
          const reason = typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code
            : error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message) ? error.message : 'unavailable';
          this.emit({ kind: 'candidate_retention_inventory', outcome: 'blocked', reason });
        }
        this.candidateInventoryFault = true;
        // Unknown disk state cannot become positive evidence of zero local work.
        return 1;
      }
    })();
    this.candidateScan = scan;
    try { return await scan; } finally { if (this.candidateScan === scan) this.candidateScan = undefined; }
  }

  private enterExecution(){return executionNodeForPool(this.o.pool)?this.retries.enter():()=>{};}
  private async flushRetries(){
    try{
      await this.retrySealedCaptures();
      // Releasing this lease would let another node repeat the model call while
      // the original result still exists only in this process's retained files.
      if(this.retries.pendingCount&&await this.retainedCandidateCount()!==0)return;
      await this.retries.flush();
    }catch{this.counters.errors++;this.emit({kind:'run_retry_release',outcome:'blocked'});}
  }

  /** General slots alternate claims; dedicated slots claim only their assigned work. */
  private async slotLoop(slot: number, kinds: readonly ('run' | 'parse')[] = this.o.kinds, interactiveOnly=false) {
    let turn = slot;
    while (!this.stopping) {
      if(executionNodeForPool(this.o.pool)){await this.refreshSpoolHealth();if(this.spoolUnsafe){await sleep(this.o.pollMs,this.stopSignal.signal);continue;}}
      let worked = false;
      for (let i = 0; i < kinds.length && !this.stopping && !worked; i++) {
        const kind = kinds[(turn + i) % kinds.length];
        if (kind === 'run' && await this.retainedCandidateCount() !== 0) continue;
        void this.flushRetries();
        const leave=this.enterExecution();if(!leave)break;
        let completedLease:Lease|null=null;
        try {
          if(kind==='run'&&!interactiveOnly&&this.o.runKinds.includes('generation')){
            for(const advance of [advanceProjectFileBatch,advanceProjectFileUpdates,advanceWorkpaperBatch])try{await advance(this.o.pool);}
            catch(error){this.emit({slot,kind:'file_batch',outcome:'scheduler_error',message:error instanceof Error?error.message:'Unknown error'});}
          }
          const outcome = kind === 'run'
            ? await runPipelineOnce({ pool: this.o.pool, blobs: this.o.blobs, stages: this.o.runStages, leaseSeconds: this.o.leaseSeconds, signal: this.workAbort.signal,
              runKinds: this.o.runKinds, interactiveOnly,workflowPhase:this.o.workflowPhase==='mixed'?(slot===0?'authoring':'postprocess'):this.o.workflowPhase, workerInstanceId:this.o.workerId, reviewedContextLoader: this.o.reviewedContextLoader,
              testRuleCapabilityLoader: this.o.testRuleCapabilityLoader,
              loadGenerationIssuerBinding: this.o.loadGenerationIssuerBinding,
              produceTargetPeriodCandidates: this.o.produceTargetPeriodCandidates,
              onUnexpectedError: error => this.emit({ slot, kind: 'run', outcome: 'unexpected_error', ...error }),
              onLease: lease => { if (lease) {completedLease=lease;this.runLeases.set(slot, lease);} else this.runLeases.delete(slot); } })
            : this.o.parse ? await runMaterialParseOnce({ ...this.o.parse, pool: this.o.pool, leaseSeconds: this.o.leaseSeconds,
              onLease: lease => { if (lease) this.parseLeases.set(slot, lease); else this.parseLeases.delete(slot); } }) : 'idle';
          if(needsLeaseRelease(outcome)&&completedLease&&executionNodeForPool(this.o.pool))this.retries.defer(completedLease);
          if (outcome !== 'idle') { worked = true; this.counters[kind]++; this.emit({ slot, kind, outcome }); }
        } catch (error) {
          if(completedLease&&executionNodeForPool(this.o.pool))this.retries.defer(completedLease);
          this.counters.errors++;
          this.emit({ slot, kind, outcome: 'error', error: error instanceof Error ? error.message.slice(0, 64).replace(/[^A-Za-z0-9_ .:-]/g, '') : 'unknown' });
        }finally{leave();}
      }
      turn++;
      if (!worked) { this.counters.idle++; await sleep(this.o.pollMs, this.stopSignal.signal); }
    }
  }

  /** One probe at a time, outside the run/parse slots, so a probe never takes a user job's slot. */
  private async probeLoop(probe: NonNullable<WorkerRuntimeOptions['platformProbe']>) {
    while (!this.stopping) {
      if (await this.retainedCandidateCount() !== 0) { await sleep(this.o.pollMs, this.stopSignal.signal); continue; }
      if (this.stopping) break;
      const leave=this.enterExecution();if(!leave){await sleep(this.o.pollMs,this.stopSignal.signal);continue;}
      let outcome = 'idle';
      try { outcome = await runPlatformProbeOnce({ pool: this.o.pool, blobs: this.o.blobs, config: probe.config }); }
      catch { this.counters.errors++; outcome = 'error'; }finally{leave();}
      if (outcome !== 'idle') { this.counters.probe++; this.emit({ kind: 'platform_probe', outcome }); }
      if (outcome === 'idle' || outcome === 'error') await sleep(probe.pollMs ?? 5000, this.stopSignal.signal);
    }
  }

  private async assistantLoop(options: NonNullable<WorkerRuntimeOptions['reviewAssistant']>) {
    while (!this.stopping) {
      if (await this.retainedCandidateCount() !== 0) { await sleep(this.o.pollMs, this.stopSignal.signal); continue; }
      if (this.stopping) break;
      const leave=this.enterExecution();if(!leave){await sleep(this.o.pollMs,this.stopSignal.signal);continue;}
      let outcome = 'idle';
      try { outcome = await runReviewAssistantOnce({ pool: this.o.pool, blobs: this.o.blobs, signal: this.workAbort.signal, config: options.config }); }
      catch { this.counters.errors++; outcome = 'error'; }finally{leave();}
      if (outcome !== 'idle') { this.counters.assistant++; this.emit({ kind: 'review_assistant', outcome }); }
      if (outcome === 'idle' || outcome === 'error') await sleep(options.pollMs ?? this.o.pollMs, this.stopSignal.signal);
    }
  }

  /** Explicitly enabled on the pure parser deployment; at most one general and one small slot. */
  private async uploadConfirmationLoop(lane:UploadConfirmationLane='general'){
    while(!this.stopping){
      let outcome='idle';
      const started=Date.now();
      try{outcome=await runUploadConfirmationOnce(this.o.pool,this.o.blobs,lane,event=>this.emit({kind:'upload_confirmation_phase',lane,...event}));}
      catch{this.counters.errors++;outcome='error';}
      if(outcome!=='idle')this.emit({kind:'upload_confirmation',lane,outcome,elapsed_ms:Date.now()-started});
      if(outcome==='idle'||outcome==='error')await sleep(this.o.pollMs,this.stopSignal.signal);
    }
  }

  private async sweepLoop() {
    while (!this.stopping) {
      try { await this.sweep(); } catch { this.counters.errors++; }
      try{await sweepCompletedTaskExecutions();}
      catch{this.counters.errors++;this.emit({kind:'task_cgroup_retire',outcome:'blocked'});}
      await sleep(this.o.sweepMs, this.stopSignal.signal);
    }
  }

  private async formatDiagnosticLoop() {
    while (!this.stopping) {
      if (await this.retainedCandidateCount() !== 0) { await sleep(this.o.pollMs, this.stopSignal.signal); continue; }
      if (this.stopping) break;
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
        const result = await withBackgroundTaskExecution(()=>sweepParseStaging(root));
        if (result.removed) this.emit({ kind: 'parse_staging_cleanup', removed: result.removed, bytes: result.bytes });
      } catch { this.counters.errors++; this.emit({ kind: 'parse_staging_cleanup', outcome: 'error' }); }
      await sleep(5 * 60 * 1000, this.stopSignal.signal);
    }
  }

  private heartbeatTask:Promise<void>|null=null;
  private transportRefreshTask:Promise<void>|null=null;
  private drainWorkSettled=false;
  private sessionFinished=false;
  private finishSession!:()=>void;
  private readonly sessionFinishedReceipt=new Promise<void>(resolve=>{this.finishSession=resolve;});
  private readonly startedAt = new Date();
  /** Upserts this process's heartbeat; a failed write only counts as an error (readiness will show it stale). */
  async heartbeat(stopped = false) {
    try {
      if(executionNodeForPool(this.o.pool)){
        const transport=this.o.executionTransport;
        if(transport&&!this.transportRefreshTask){
          const refresh=Promise.resolve().then(()=>transport.refresh()).catch(()=>{this.counters.errors++;});
          this.transportRefreshTask=refresh;
          void refresh.finally(()=>{if(this.transportRefreshTask===refresh)this.transportRefreshTask=null;}).catch(()=>{});
        }
        const [native,retained]=await Promise.all([nativeExecutionChildren(),this.retainedCandidateCount()]);
        await this.refreshSpoolHealth();
        await heartbeatExecutionRuntime(this.o.pool,{native_processes:native,unpersisted_results:this.runLeases.size+this.parseLeases.size+retained+this.spoolPending+this.sealedCapturePending,ready:!this.stopping&&retained===0&&!this.spoolUnsafe&&!!transport?.ready(),finished:stopped&&retained===0&&this.spoolPending===0&&this.sealedCapturePending===0});
      } await recordWorkerHeartbeat(this.o.pool, { workerId: this.o.workerId, startedAt: this.startedAt, kinds: this.o.kinds, concurrency: this.o.concurrency + this.dedicatedParseSlots + this.dedicatedInteractiveSlots, stopped }); }
    catch { this.counters.errors++; }
  }

  private async heartbeatLoop() {
    const managed=!!executionNodeForPool(this.o.pool);
    while (!this.stopping || managed&&!this.sessionFinished) {
      if(managed)await this.flushRetries();
      await this.heartbeat();
      if(managed){
        if(this.drainWorkSettled&&!this.retries.pendingCount&&!this.spoolPending&&!this.sealedCapturePending&&await this.retainedCandidateCount()===0){
          try{
            await heartbeatExecutionRuntime(this.o.pool,{native_processes:await nativeExecutionChildren(),unpersisted_results:this.runLeases.size+this.parseLeases.size+this.spoolPending+this.sealedCapturePending+await this.retainedCandidateCount(),ready:false,finished:true});
            this.sessionFinished=true;this.o.executionTransport?.close();this.finishSession();return;
          }catch{this.counters.errors++;this.emit({kind:'execution_session_finish_retry'});}
        }else if(!this.stopping){
          try{const state=await executionNodeState(this.o.pool);if(['draining','drained','stop_submitted','lost'].includes(state??''))void this.stop().catch(()=>{this.counters.errors++;});}catch{this.counters.errors++;}
        }
      }
      await sleep(this.o.heartbeatMs,this.stopping?undefined:this.stopSignal.signal);
    }
  }

  private async refreshSpoolHealth(){
    this.sealedCapturePending=pendingSealedCaptureCount(this.o.pool);
    try{
      const workRoot=process.env.BB_CODEX_WORK_ROOT??process.env.BB_PARSE_STAGING_DIR??'/tmp/bondbuddy-codex';
      await mkdir(workRoot,{recursive:true,mode:0o700});
      const health=await durableSpoolHealth(durableSpoolRoot(workRoot),workRoot);
      this.spoolPending=health.pending+health.retained;this.spoolGcPending=health.gcPending;this.spoolUnsafe=health.unsafe>0||health.lowDisk;
      await reportSpoolHealth(this.o.pool,health,executionNodeForPool(this.o.pool));
    }catch{this.spoolPending=Math.max(1,this.spoolPending);this.spoolUnsafe=true;}
  }
  private async spoolLoop(){
    do{
      await this.retrySealedCaptures();
      await this.refreshSpoolHealth();
      if(this.spoolPending||this.spoolGcPending){
        try{const result=await runDurableSpoolPass(this.o.pool,durableSpoolRoot(process.env.BB_CODEX_WORK_ROOT??process.env.BB_PARSE_STAGING_DIR));this.emit({kind:'durable_spool',registered:result.registered,pending:result.pending,failed:result.failed});}
        catch{this.counters.errors++;this.emit({kind:'durable_spool',outcome:'blocked'});}
      }
      await this.refreshSpoolHealth();
      if(this.stopping&&!this.spoolPending&&!this.spoolGcPending&&!this.sealedCapturePending)break;
      await sleep(Math.max(this.o.pollMs,10000),this.stopping?undefined:this.stopSignal.signal);
    }while(!this.stopping||this.spoolPending>0||this.spoolGcPending>0||this.sealedCapturePending>0);
  }

  private async retrySealedCaptures(){
    try{
      const result=await retryPendingSealedCaptures(this.o.pool);this.sealedCapturePending=result.pending;
      if(result.released||result.failed)this.emit({kind:'sealed_capture_release',...result});
      this.counters.errors+=result.failed;
    }catch{this.sealedCapturePending=pendingSealedCaptureCount(this.o.pool);this.counters.errors++;this.emit({kind:'sealed_capture_release',outcome:'blocked'});}
  }

  private pausedSweepCursors=new Map<PausedRunSweepStage,string>();
  private async sweepPausedRuns(stage:PausedRunSweepStage){
    const {pool}=this.o;
    let rows:Awaited<ReturnType<typeof pausedRunSweepCandidates>>;
    try{rows=await pausedRunSweepCandidates(pool,stage,20,this.o.runKinds,this.pausedSweepCursors.get(stage));}
    catch{this.counters.errors++;this.emit({kind:'paused_sweep',stage,outcome:'query_failed'});return;}
    if(!rows.length){this.pausedSweepCursors.delete(stage);return;}
    for(const r of rows){
      this.pausedSweepCursors.set(stage,r.job_id);
      let checkId:string|null=null,disposition:'waiting'|'error'|'manual_required'|'resumed'='waiting',reason='resume_guard_blocked';
      try{
        checkId=await beginPausedRunSweep(pool,r,stage);if(!checkId)continue;
        if(r.workflow_owned&&r.workflow_protocol_version!==1){disposition='manual_required';reason='workflow_protocol_unsupported';}
        else{
          let ready=true;
          if(stage==='awaiting_materials'){
            const run=(await pool.query(`SELECT owner_user_id,project_id,input_revision,input_hash,
              (SELECT payload->>'reason' FROM bb_run_events WHERE run_id=bb_runs.id AND state='paused' AND type='run.state_changed' ORDER BY seq DESC LIMIT 1) AS pause_reason
              FROM bb_runs WHERE id=$1 AND owner_user_id=$2`,[r.run_id,r.owner_user_id])).rows[0];
            if(!run){ready=false;reason='run_missing';}
            else if(run.pause_reason!=='material_parse_pending'){ready=false;disposition='manual_required';reason='pause_requires_manual_recovery';}
            else if((await materialsReadiness(pool,run)).status==='pending'){ready=false;reason='material_parse_pending';}
          }else if(stage==='trial_limit'){
            const client=await pool.connect();try{await assertModelCallAllowed(client,trialGuardConfig(),r.owner_user_id);}
            catch(error){if(error instanceof TrialLimitProblem){ready=error.limit==='operator_deny';reason='trial_limit_pending';}else throw error;}
            finally{client.release();}
          }
          if(ready){
            const resumeReason={awaiting_materials:'materials_ready',credits_exhausted:'credits_recharged',billing_reconcile:'billing_reconciled',trial_limit:'trial_limit_cleared'} as const;
            if(await resumeVerifiedWorkflow(pool,r.owner_user_id,r.run_id,resumeReason[stage],{blobs:this.o.blobs})){disposition='resumed';reason='blocker_cleared';}
          }
        }
      }catch{this.counters.errors++;disposition='error';reason='readiness_check_failed';this.emit({kind:'paused_sweep',stage,outcome:'check_failed'});}
      if(checkId)try{await completePausedRunSweep(pool,r,stage,checkId,disposition,reason);}
      catch{this.counters.errors++;this.emit({kind:'paused_sweep',stage,outcome:'disposition_failed'});}
    }
  }

  /** One pass over paused work. Safe to run from several workers: every transition re-checks under row locks. */
  async sweep() {
    const { pool } = this.o;
    this.counters.sweeps++;
    await this.retrySealedCaptures();
    if (this.o.kinds.includes('run')) {
      const recovery=await this.providerRecovery.run();
      this.counters.errors+=recovery.errors;
      for(const stage of PAUSED_RUN_SWEEP_STAGES)await this.sweepPausedRuns(stage);
    }
    if (this.o.kinds.includes('parse') && this.o.ocrEnabled && this.o.parse?.ocr) await requeueAwaitingOcrParseJobs(pool, { minPausedSeconds: this.o.ocrRetrySeconds });
    if (this.o.logSink) await forwardLogs(pool, this.o.logSink);
  }

  /** Queries every unresolved attempt first; only proven outcomes are recorded, then the run is re-queued. */
  async reconcileRun(owner: string, runId: string, jobId: string) {
    return reconcileProviderRun({...this.o,log:event=>this.emit(event)},owner,runId,jobId);
  }

  stop(): Promise<void> { return this.stopTask ??= this.drain(); }

  /** Preserve run/parse drain limits. Upload confirmation keeps its lease and spool
   * until its own read/commit settles, before the entry closes the pool or exits. */
  private async drain() {
    this.stopping = true;
    this.stopSignal.abort();
    if(executionNodeForPool(this.o.pool)){
      // Cloud drain has no twenty-second deadline and never releases a live
      // job/model merely because a process heartbeat or lease timed out.
      await Promise.all([...this.loops,...this.confirmationLoops]);
      this.drainWorkSettled=true;
      // The existing heartbeat loop keeps retrying the positive session receipt.
      // A durable global evidence pause is not an unpersisted local result.
      await this.sessionFinishedReceipt;
      await this.heartbeatTask;
      await recordWorkerHeartbeat(this.o.pool,{workerId:this.o.workerId,startedAt:this.startedAt,kinds:this.o.kinds,concurrency:this.o.concurrency,stopped:true}).catch(()=>{this.counters.errors++;});
      this.emit({kind:'execution_session_finished',native_processes:0,unpersisted_results:0,released:0});return;
    }
    const drained = await Promise.race([Promise.all([...this.loops,...(this.heartbeatTask?[this.heartbeatTask]:[])]).then(() => true), sleep(this.o.drainMs).then(() => false)]);
    if (!drained) {
      this.workAbort.abort();
      await Promise.race([Promise.all([...this.loops,...(this.heartbeatTask?[this.heartbeatTask]:[])]), sleep(5000)]);
    }
    // A non-managed process also cannot report a safe stop or release its leases
    // while an unacknowledged result survives only on its local filesystem.
    let retained = await this.retainedCandidateCount();
    if (retained) this.emit({ kind: 'candidate_retention_drain', outcome: 'blocked' });
    while (retained) { await sleep(this.o.heartbeatMs); retained = await this.retainedCandidateCount(); }
    for (const lease of this.runLeases.values()) await releaseLease(this.o.pool, lease).catch(() => undefined);
    for (const lease of this.parseLeases.values()) await releaseMaterialParse(this.o.pool, lease).catch(() => undefined);
    await Promise.all(this.confirmationLoops);
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
  const kinds = (env.BB_WORKER_JOB_KINDS || 'run,parse').split(',').map(k => k.trim());
  if (!kinds.length || kinds.some(k => k !== 'run' && k !== 'parse')) throw new Error('Invalid BB_WORKER_JOB_KINDS');
  const smallSlot=env.BB_UPLOAD_CONFIRMATION_SMALL_SLOT==='1';
  const confirmationLane=env.BB_UPLOAD_CONFIRMATION_LANE??'general';
  if(!['general','small','large'].includes(confirmationLane)||confirmationLane!=='general'&&
    (env.BB_UPLOAD_CONFIRMATION_ENABLED!=='1'||smallSlot||kinds.length!==1||kinds[0]!=='parse'||Number(env.BB_UPLOAD_SPOOL_MAX_BYTES)!==128*1024*1024))
    throw new Error('A filtered confirmation lane requires a pure parser, one loop and 128 MiB spool');
  if(smallSlot&&(env.BB_UPLOAD_CONFIRMATION_ENABLED!=='1'||kinds.length!==1||kinds[0]!=='parse'||Number(env.BB_UPLOAD_SPOOL_MAX_BYTES)<M1_UPLOAD_LIMITS.fileBytes+UPLOAD_CONFIRMATION_SMALL_MAX_BYTES))
    throw new Error('Reserved upload confirmation slot requires a pure parser and spool capacity for 100 MiB + 16 MiB');
  const runKinds = checkedRunKinds(env.BB_WORKER_RUN_KINDS === undefined ? undefined : env.BB_WORKER_RUN_KINDS.split(',').map(k => k.trim()) as RunKind[]);
  const group = env.BB_WORKER_GROUP;
  if (group !== undefined && !/^[a-z][a-z0-9-]{0,31}$/.test(group)) throw new Error('Invalid BB_WORKER_GROUP');
  const ocrEnabled = env.BB_OCR_ENABLED === '1';
  const workflowEnabled=env.BB_WORKFLOW_V1==='1';
  if(workflowEnabled&&env.AZURE_STORAGE_CONNECTION_STRING)blobs=boundedPrivateBlobs(blobs,{connectionString:env.AZURE_STORAGE_CONNECTION_STRING,containerName:env.AZURE_STORAGE_CONTAINER});
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
  const workflowPhase=env.BB_WORKFLOW_PHASE;
  if(workflowEnabled&&(!['authoring','postprocess','mixed'].includes(workflowPhase??'')||!env.BB_DURABLE_SPOOL_ROOT||!env.BB_WORKFLOW_WORK_ROOT||!Number.isSafeInteger(Number(env.BB_WORKFLOW_TOKEN_LIMIT))||Number(env.BB_WORKFLOW_TOKEN_LIMIT)<1))throw Error('WORKFLOW_RUNTIME_CONFIGURATION_REQUIRED');
  if(!workflowEnabled&&workflowPhase)throw Error('WORKFLOW_RUNTIME_CONFIGURATION_CONFLICT');
  const runStages = defaultRunStages({ model_generation: modelGenerationRouter(
    {workflowEnabled,...(factEvidenceReviewGate ? { factEvidenceReviewGate } : {})}),
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
    ...(workflowEnabled?{workflowPhase:workflowPhase as 'authoring'|'postprocess'|'mixed'}:{}),
    ...(group ? { workerId: `${group}_${defaultWorkerId()}` } : {}),
    ...(kinds.includes('run') && runKinds.includes('review') ? { reviewAssistant: { slots: intEnv(env, 'BB_REVIEW_ASSISTANT_SLOTS', 1, 1, 8) } } : {}),
    reviewedContextLoader: loadReviewedRuleApplicabilityContext,
    loadGenerationIssuerBinding: scope => loadPinnedApprovedGenerationIssuerBinding(pool, scope),
    ...(targetPeriodCandidateProducer ? { produceTargetPeriodCandidates: async request =>
      { await produceTargetPeriodCandidateSnapshot({ pool, blobs }, request); } } : {}),
    ...(testChannelEnabled ? { testRuleCapabilityLoader: createSsePrivateTestRuleCapabilityLoader(pool) } : {}),
    factCandidateProducer: createControlledNativeFactCandidateProducer({ pool }),
    interactiveSlots: workflowEnabled?0:intEnv(env, 'BB_WORKER_INTERACTIVE_SLOTS', 1, 0, 4),
    uploadConfirmationEnabled: env.BB_UPLOAD_CONFIRMATION_ENABLED==='1',
    uploadConfirmationLane: confirmationLane as UploadConfirmationLane,
    uploadConfirmationSmallSlot: smallSlot,
    concurrency: workflowEnabled?(workflowPhase==='mixed'?2:1):intEnv(env, 'BB_WORKER_CONCURRENCY', 2, 1, 16), parseSlots: intEnv(env, 'BB_WORKER_PARSE_SLOTS', 1, 0, 4), pollMs: intEnv(env, 'BB_WORKER_POLL_MS', 1000, 100, 60000),
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
  const enrollment=await enrollExecutionNodeFromEnv(pool,options);
  await initializeTaskExecution(pool);
  if(options.stagingRoot)await withBackgroundTaskExecution(()=>sweepParseStaging(options.stagingRoot!));
  options.executionTransport=await executionTransportFromEnv(enrollment);
  const runtime = new WorkerRuntime({ ...options, log: event => process.stdout.write(`${JSON.stringify(event)}\n`) }).start();
  process.stdout.write(`${JSON.stringify({ kind: 'started', kinds: options.kinds, run_kinds: options.runKinds, worker_group: process.env.BB_WORKER_GROUP ?? null, concurrency: options.concurrency, assistant_slots: options.reviewAssistant?.slots ?? 0, model_call_concurrency: modelCallConcurrency(), interactive_slots: interactiveSlots, parse_slots: options.kinds?.includes('run') && options.kinds.includes('parse') ? options.parseSlots : 0, ocr_enabled: options.ocrEnabled, platform_probe: !!options.platformProbe,upload_confirmation:!!options.uploadConfirmationEnabled })}\n`);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await runtime.stop();
    await flushPerformanceTraces(pool,2000);
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}
