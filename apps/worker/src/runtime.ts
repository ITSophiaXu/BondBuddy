// #17 worker runtime process: `node apps/worker/dist/runtime.js` (container entrypoint).
// N slots claim run and parse jobs through PostgreSQL leases; a sweep loop re-queues paused work
// whose blocker cleared (parsed materials, reconciled provider calls, OCR availability) and can
// forward #79 logs. SIGTERM/SIGINT stop claiming, drain in-flight work, then release leases so
// another worker resumes from the durable checkpoint at once. Nothing here trusts a browser.
import { Pool } from 'pg';
import { azureBlobs, type PrivateBlobs } from '@bondbuddy/api/data';
import { forwardLogs, ndjsonFileSink, ndjsonSizeCapFromEnv, type LogSink } from '@bondbuddy/api/log-ops';
import { releaseMaterialParse, requeueAwaitingOcrParseJobs, type MaterialParseLease } from '@bondbuddy/api/material-jobs';
import { reconcilePausedCall, releaseLease, pausedRuns, resumePausedRun, type Lease } from '@bondbuddy/api/queue';
import { defaultWorkerId, recordWorkerHeartbeat } from '@bondbuddy/api/trial-guard';
import { reconcilePausedProviderCall, type ProviderCallObservation } from '@bondbuddy/api/provider-results';
import { runMaterialParseOnce, type MaterialParseJobDependencies } from './material-parse-job.js';
import { createMaterialsReadyStage, defaultRunStages, materialsReadiness, runPipelineOnce, type ParsedFactProducer, type RunStage } from './run-pipeline.js';
import { createRuntimeParseCache, runtimeParseCacheVersions } from './runtime-parse-cache.js';
import { modelGenerationRouter } from './model-generation-router.js';
import type { NoHistoryStageAdapters } from './no-history-model-stage.js';
import { loadCodexAdapterConfig, type CodexAdapterConfig } from './codex-adapter.js';
import { assertProbeConfig, runPlatformProbeOnce } from './platform-probe-job.js';
import { historicalWordDeliveryStage } from './historical-word-stage.js';

export type PendingAttempt = { owner_user_id: string; project_id: string; run_id: string; job_id: string; logical_call_id: string; attempt_no: number; call_id: string; model_id: string | null; prompt_snapshot_ref: string | null; observed: boolean };
export type ReconcileAnswer = { outcome: 'unknown' } | { outcome: 'confirmed_not_sent' } | { outcome: 'completed'; observation: ProviderCallObservation; validate: (value: unknown) => boolean };
/** Answers what really happened to an attempt whose outcome was not recorded (worker died mid-call). */
export interface ProviderCallReconciler { name: string; query(attempt: PendingAttempt): Promise<ReconcileAnswer> }

/**
 * `codex exec` exposes no provider request ID or lookup API (#16: provider_request_id_status is
 * always `unknown`), so the default reconciler cannot prove either outcome and leaves the run
 * paused at `provider_reconcile` for an operator. It never guesses `confirmed_not_sent`.
 */
export const codexNoLookupReconciler: ProviderCallReconciler = { name: 'codex_no_lookup', query: async () => ({ outcome: 'unknown' }) };

export type WorkerRuntimeOptions = {
  pool: Pool; blobs: PrivateBlobs;
  concurrency?: number; pollMs?: number; leaseSeconds?: number; sweepMs?: number; drainMs?: number;
  kinds?: ('run' | 'parse')[];
  runStages?: RunStage[];
  /** Trusted #15 producer binding. With runStages, only the environment factory's materials stage may be replaced. */
  factCandidateProducer?: ParsedFactProducer;
  /** Optional trusted #33 server adapters; absent in production until their sources are ready. */
  noHistoryGenerationAdapters?: NoHistoryStageAdapters;
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
  readonly counters = { run: 0, parse: 0, probe: 0, idle: 0, sweeps: 0, errors: 0 };
  private readonly o: Required<Omit<WorkerRuntimeOptions, 'parse' | 'logSink' | 'log' | 'platformProbe' | 'noHistoryGenerationAdapters' | 'factCandidateProducer'>>
    & Pick<WorkerRuntimeOptions, 'parse' | 'logSink' | 'log' | 'platformProbe'>;

  constructor(options: WorkerRuntimeOptions) {
    this.o = { concurrency: 2, pollMs: 1000, leaseSeconds: 30, sweepMs: 15000, drainMs: 20000, kinds: ['run', 'parse'],
      runStages: defaultRunStages({ model_generation: modelGenerationRouter({ noHistoryAdapters: options.noHistoryGenerationAdapters }),
        word_delivery: historicalWordDeliveryStage() }, options.factCandidateProducer),
      ocrEnabled: false, ocrRetrySeconds: 300, reconciler: codexNoLookupReconciler, workerId: defaultWorkerId(), heartbeatMs: 10000, ...options };
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
  }

  start() {
    for (let slot = 0; slot < this.o.concurrency; slot++) this.loops.push(this.slotLoop(slot));
    this.loops.push(this.sweepLoop());
    this.loops.push(this.heartbeatLoop());
    if (this.o.platformProbe) this.loops.push(this.probeLoop(this.o.platformProbe));
    return this;
  }

  private emit(event: Record<string, unknown>) { this.o.log?.({ at: new Date().toISOString(), ...event }); }

  /** One bounded-concurrency slot: alternates job kinds so neither starves the other. */
  private async slotLoop(slot: number) {
    let turn = slot;
    while (!this.stopping) {
      let worked = false;
      for (let i = 0; i < this.o.kinds.length && !this.stopping && !worked; i++) {
        const kind = this.o.kinds[(turn + i) % this.o.kinds.length];
        try {
          const outcome = kind === 'run'
            ? await runPipelineOnce({ pool: this.o.pool, blobs: this.o.blobs, stages: this.o.runStages, leaseSeconds: this.o.leaseSeconds, signal: this.workAbort.signal,
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

  private async sweepLoop() {
    while (!this.stopping) {
      try { await this.sweep(); } catch { this.counters.errors++; }
      await sleep(this.o.sweepMs, this.stopSignal.signal);
    }
  }

  private readonly startedAt = new Date();
  /** Upserts this process's heartbeat; a failed write only counts as an error (readiness will show it stale). */
  async heartbeat(stopped = false) {
    try { await recordWorkerHeartbeat(this.o.pool, { workerId: this.o.workerId, startedAt: this.startedAt, kinds: this.o.kinds, concurrency: this.o.concurrency, stopped }); }
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
    for (const r of await pausedRuns(pool, 'awaiting_materials')) {
      const run = (await pool.query('SELECT owner_user_id,project_id,input_revision,input_hash FROM bb_runs WHERE id=$1 AND owner_user_id=$2', [r.run_id, r.owner_user_id])).rows[0];
      if (!run) continue;
      const readiness = await materialsReadiness(pool, run);
      // A failed material is decided on the next claim (the stage fails the run with its code).
      if (readiness.status !== 'pending') await resumePausedRun(pool, r.owner_user_id, r.run_id, 'materials_ready');
    }
    for (const r of await pausedRuns(pool, 'provider_reconcile')) await this.reconcileRun(r.owner_user_id, r.run_id, r.job_id);
    if (this.o.ocrEnabled && this.o.parse?.ocr) await requeueAwaitingOcrParseJobs(pool, { minPausedSeconds: this.o.ocrRetrySeconds });
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
      else return false;
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
  const kinds = (env.BB_WORKER_JOB_KINDS || 'run,parse').split(',').map(k => k.trim());
  if (!kinds.length || kinds.some(k => k !== 'run' && k !== 'parse')) throw new Error('Invalid BB_WORKER_JOB_KINDS');
  const ocrEnabled = env.BB_OCR_ENABLED === '1';
  const parseCache = kinds.includes('parse') ? createRuntimeParseCache(pool, blobs, runtimeParseCacheVersions(env)) : undefined;
  let platformProbe: WorkerRuntimeOptions['platformProbe'];
  if (env.BB_PLATFORM_PROBE_ENABLED === '1') {
    const config = loadCodexAdapterConfig(env);
    assertProbeConfig(config, env);
    platformProbe = { config, pollMs: intEnv(env, 'BB_PLATFORM_PROBE_POLL_MS', 5000, 500, 600000) };
  }
  const runStages = defaultRunStages({ model_generation: modelGenerationRouter() });
  const materials = runStages.find(stage => stage.name === 'materials_ready')!;
  environmentMaterialsStages.set(materials, { run: materials.run, replay: materials.replay });
  return {
    pool, blobs, kinds: kinds as ('run' | 'parse')[], runStages,
    concurrency: intEnv(env, 'BB_WORKER_CONCURRENCY', 2, 1, 16), pollMs: intEnv(env, 'BB_WORKER_POLL_MS', 1000, 100, 60000),
    leaseSeconds: intEnv(env, 'BB_WORKER_LEASE_SECONDS', 30, 5, 600), sweepMs: intEnv(env, 'BB_WORKER_SWEEP_MS', 15000, 1000, 600000),
    drainMs: intEnv(env, 'BB_WORKER_DRAIN_MS', 20000, 0, 600000), heartbeatMs: intEnv(env, 'BB_WORKER_HEARTBEAT_MS', 10000, 1000, 300000), ocrRetrySeconds: intEnv(env, 'BB_OCR_RETRY_SECONDS', 300, 0, 86400),
    parse: { material: { pool, blobs: { getPrivate: key => blobs.getIfExists(key) }, ...(parseCache ? { parseCache } : {}) }, ocrProfiles: ocrEnabled ? { pool, blobs } : undefined,
      ocr: ocrEnabled ? ocr?.(pool, blobs) : undefined },
    ocrEnabled,
    logSink: env.BB_LOG_NDJSON_PATH ? ndjsonFileSink(env.BB_LOG_NDJSON_PATH, 'ndjson_file', ndjsonSizeCapFromEnv(env)) : null,
    ...(platformProbe ? { platformProbe } : {}),
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (!process.env.DATABASE_URL || !process.env.AZURE_STORAGE_CONNECTION_STRING) throw new Error('DATABASE_URL and AZURE_STORAGE_CONNECTION_STRING are required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: intEnv(process.env, 'BB_WORKER_CONCURRENCY', 2, 1, 16) + 4 });
  const blobs = azureBlobs(process.env.AZURE_STORAGE_CONNECTION_STRING);
  const { processOcrMaterial } = await import('./ocr.js');
  const options = workerRuntimeOptionsFromEnv(pool, blobs, process.env, (db, store) => input => processOcrMaterial(db, store, { ...input, purpose: 'source_preflight' }));
  const runtime = new WorkerRuntime({ ...options, log: event => process.stdout.write(`${JSON.stringify(event)}\n`) }).start();
  process.stdout.write(`${JSON.stringify({ kind: 'started', kinds: options.kinds, concurrency: options.concurrency, ocr_enabled: options.ocrEnabled, platform_probe: !!options.platformProbe })}\n`);
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
