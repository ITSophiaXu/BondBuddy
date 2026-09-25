import { randomBytes } from 'node:crypto';
import { rename, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import type { OpsScheduledTask } from '@bondbuddy/contracts';
import { azureBlobs, type PrivateBlobs } from '@bondbuddy/api/data';
import { raiseAlert } from '@bondbuddy/api/evidence-gate';
import { checkLogHealth, forwardLogs, ndjsonFileSink, retentionPolicyFromEnv } from '@bondbuddy/api/log-ops';
import { storageLifecyclePolicyFromEnv } from '@bondbuddy/api/storage-lifecycle';
import { runUserDeletionLifecycle } from '@bondbuddy/api/deletion-lifecycle';
import { checkTrialHealth, trialConfigFromEnv, trialHealthThresholdsFromEnv } from '@bondbuddy/api/trial-guard';
import { registerLibrarySource } from '@bondbuddy/api/library';
import { backfillParseJobs } from './backfill-parse-jobs.js';
import { backupContainer, pruneOffhostBackups } from './backup-retention.js';
import { runLibrarySyncPass } from './library-scheduler.js';
import { OPERATOR_IMPORT_SOURCE, OperatorImportAdapter, SSE_BOND_SOURCE, SseBondProjectAdapter, type LibrarySourceAdapter } from './library-sources.js';

// #79/#35 ops scheduler: one small process that runs the periodic operations jobs which used to be
// host-cron one-shots. Every task is itself idempotent and bounded; the scheduler only decides when,
// and a PostgreSQL lease on bb_ops_schedule (0028) makes sure only one instance runs a due task.
// A failed run appends a deduplicated scheduled_task_failed alert to the #79 alerts table.

export type TaskOutcome = { ok: boolean; errorCode?: string; detail?: Record<string, string | number> };
export type ScheduledTask = { name: OpsScheduledTask; intervalMs: number; leaseMs: number; run: () => Promise<TaskOutcome> };
export type SchedulerOptions = { pool: Pool; tasks: ScheduledTask[]; owner?: string; tickMs?: number; jitter?: number; log?: (line: Record<string, unknown>) => void };

const safeCode = /^[a-z][a-z0-9_]{0,63}$/;
const token = () => randomBytes(12).toString('base64url');
export const defaultOwner = () => `${hostname().replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)}-${process.pid}`;

/** Wins the task lease only when the task is due and no live lease exists. Returns the lease token or null. */
export async function claimTask(pool: Pool, task: string, owner: string, leaseMs: number) {
  await pool.query('INSERT INTO bb_ops_schedule(task) VALUES($1) ON CONFLICT DO NOTHING', [task]);
  const lease = token();
  const q = await pool.query(`UPDATE bb_ops_schedule SET lease_token=$2,lease_owner=$3,lease_until=now()+make_interval(secs=>$4::double precision/1000),last_started_at=now()
    WHERE task=$1 AND next_due_at<=now() AND (lease_until IS NULL OR lease_until<now()) RETURNING task`, [task, lease, owner, leaseMs]);
  return q.rowCount ? lease : null;
}

/** Releases the lease and sets the next due time. A lost lease (expired and re-claimed) changes nothing. */
export async function finishTask(pool: Pool, task: string, lease: string, outcome: TaskOutcome, nextInMs: number) {
  const code = outcome.ok ? null : (outcome.errorCode && safeCode.test(outcome.errorCode) ? outcome.errorCode : 'task_failed');
  const q = await pool.query(`UPDATE bb_ops_schedule SET lease_token=NULL,lease_owner=NULL,lease_until=NULL,last_finished_at=now(),
      next_due_at=now()+make_interval(secs=>$4::double precision/1000),last_status=$3,last_succeeded_at=CASE WHEN $3='succeeded' THEN now() ELSE last_succeeded_at END,last_error_code=$5,runs=runs+1,failures=failures+CASE WHEN $3='failed' THEN 1 ELSE 0 END
    WHERE task=$1 AND lease_token=$2`, [task, lease, outcome.ok ? 'succeeded' : 'failed', Math.max(0, Math.round(nextInMs)), code]);
  if (!outcome.ok) await raiseAlert(pool, { kind: 'scheduled_task_failed', severity: 'critical', scope: task, detail: { task, error_code: code!, ...(outcome.detail ?? {}) } });
  return q.rowCount === 1;
}

/** Symmetric jitter so instances and tasks drift apart instead of firing together. */
export const jittered = (ms: number, jitter: number, random = Math.random) => Math.round(ms * (1 + jitter * (2 * random() - 1)));

export class OpsScheduler {
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  readonly owner: string;
  constructor(private readonly options: SchedulerOptions) {
    this.owner = options.owner ?? defaultOwner();
    for (const task of options.tasks) if (!safeCode.test(task.name) || task.intervalMs < 1000 || task.leaseMs < 1000) throw new Error(`Invalid scheduled task ${task.name}`);
  }

  /** One pass over all tasks; runs each task this instance wins, one at a time to keep memory flat. */
  async tick() {
    const { pool, tasks, jitter = 0.1, log = () => {} } = this.options;
    for (const task of tasks) {
      if (this.stopped) return;
      let lease: string | null;
      try { lease = await claimTask(pool, task.name, this.owner, task.leaseMs); }
      catch { log({ scheduler: 'claim_failed', task: task.name }); continue; }
      if (!lease) continue;
      const started = Date.now();
      let outcome: TaskOutcome;
      try { outcome = await task.run(); }
      catch (error) { outcome = { ok: false, errorCode: (error as { code?: unknown })?.code && safeCode.test(String((error as { code: unknown }).code)) ? String((error as { code: unknown }).code) : 'task_threw' }; }
      try {
        const kept = await finishTask(pool, task.name, lease, outcome, jittered(task.intervalMs, jitter));
        log({ scheduler: 'task', task: task.name, status: outcome.ok ? 'succeeded' : 'failed', error_code: outcome.errorCode ?? null, duration_ms: Date.now() - started, lease_kept: kept, ...(outcome.detail ?? {}) });
      } catch { log({ scheduler: 'finish_failed', task: task.name }); }
    }
  }

  start() {
    const tickMs = this.options.tickMs ?? 5000;
    const loop = () => {
      if (this.stopped) return;
      this.running = this.tick().finally(() => { this.running = null; if (!this.stopped) this.timer = setTimeout(loop, jittered(tickMs, 0.2)); });
    };
    loop();
    return this;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}

// ---------------------------------------------------------------- task wiring

const intEnv = (env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
};
const off = (value: string | undefined) => ['0', 'false', 'off', 'no'].includes((value ?? '').toLowerCase());

/** Keeps the NDJSON sink bounded: past the size cap the file becomes `.1` (replacing the older one). */
export async function rotateIfLarge(path: string, maxBytes: number) {
  try { if ((await stat(path)).size < maxBytes) return false; } catch { return false; }
  await rename(path, `${path}.1`);
  return true;
}

export function tasksFromEnv(pool: Pool, env: NodeJS.ProcessEnv = process.env, blobsFactory: (cs: string, container?: string) => PrivateBlobs = azureBlobs, backupsFactory = backupContainer,
  libraryAdapters?: (blobs: PrivateBlobs) => Record<string, LibrarySourceAdapter>): ScheduledTask[] {
  const seconds = (name: string, fallback: number) => intEnv(env, name, fallback, 5, 86400 * 7) * 1000;
  const tasks: ScheduledTask[] = [];
  const sinkFile = env.BB_LOG_SINK_FILE;
  if (sinkFile && !off(env.BB_OPS_LOG_FORWARD)) {
    const maxBytes = intEnv(env, 'BB_LOG_SINK_MAX_BYTES', 64 * 1024 * 1024, 1024, 1024 ** 3);
    const sink = ndjsonFileSink(sinkFile);
    tasks.push({ name: 'log_forward', intervalMs: seconds('BB_OPS_LOG_FORWARD_SECONDS', 30), leaseMs: 120_000, run: async (): Promise<TaskOutcome> => {
      let delivered = 0, failed = 0;
      // Bounded drain: up to 10 batches of 100 per run.
      for (let i = 0; i < 10; i++) {
        await rotateIfLarge(sinkFile, maxBytes);
        const r = await forwardLogs(pool, sink);
        delivered += r.delivered; failed += r.failed;
        if (r.failed || r.claimed < 100) break;
      }
      return failed ? { ok: false, errorCode: 'sink_unavailable', detail: { delivered, failed } } : { ok: true, detail: { delivered } };
    } });
  }
  if (!off(env.BB_OPS_LOG_HEALTH)) tasks.push({ name: 'log_health', intervalMs: seconds('BB_OPS_LOG_HEALTH_SECONDS', 60), leaseMs: 60_000, run: async (): Promise<TaskOutcome> => {
    const r = await checkLogHealth(pool, { maxBacklogAgeSeconds: intEnv(env, 'BB_LOG_BACKLOG_ALERT_SECONDS', 300, 30, 86400) });
    return { ok: true, detail: { backlog: r.backlog, alerts: r.alerts.length } };
  } });
  const storage = storageLifecyclePolicyFromEnv(env);
  if (storage && !off(env.BB_OPS_STORAGE_PURGE)) {
    if (!env.AZURE_STORAGE_CONNECTION_STRING) throw new Error('Enabled storage purge requires AZURE_STORAGE_CONNECTION_STRING');
    const blobs = blobsFactory(env.AZURE_STORAGE_CONNECTION_STRING);
    const logDays = retentionPolicyFromEnv(env).contentRetentionDays;
    tasks.push({ name: 'storage_purge', intervalMs: seconds('BB_OPS_STORAGE_PURGE_SECONDS', 900), leaseMs: 900_000, run: async (): Promise<TaskOutcome> => {
      const r = await runUserDeletionLifecycle(pool, blobs, storage, logDays);
      const failed = r.storage.failed + r.derived.failed + r.logs.failed;
      const detail = { purged: r.storage.purged, derived_purged: r.derived.materialsPurged + r.derived.projectsPurged, failed };
      return failed ? { ok: false, errorCode: 'purge_items_failed', detail } : { ok: true, detail };
    } });
  }
  if (!off(env.BB_OPS_TRIAL_HEALTH)) {
    const config = trialConfigFromEnv(env), thresholds = trialHealthThresholdsFromEnv(env);
    tasks.push({ name: 'trial_health', intervalMs: seconds('BB_OPS_TRIAL_HEALTH_SECONDS', 300), leaseMs: 120_000, run: async (): Promise<TaskOutcome> => ({ ok: true, detail: { fired: (await checkTrialHealth(pool, config, thresholds)).length } }) });
  }
  if (!off(env.BB_OPS_WORKER_HEARTBEAT)) {
    const maxAge = intEnv(env, 'BB_READY_WORKER_HEARTBEAT_MAX_AGE_SECONDS', 90, 5, 86400);
    tasks.push({ name: 'worker_heartbeat', intervalMs: seconds('BB_OPS_WORKER_HEARTBEAT_SECONDS', 60), leaseMs: 60_000, run: async (): Promise<TaskOutcome> => ({ ok: true, detail: await checkWorkerHeartbeat(pool, maxAge) }) });
  }
  // #35: deletes off-host backups (bb-backups container) past BB_BACKUP_RETENTION_DAYS; the newest is always kept.
  // Backups themselves are taken by scripts/backup.sh from host cron (docs/runbooks/m1-deploy.md).
  if (env.AZURE_STORAGE_CONNECTION_STRING && !off(env.BB_OPS_BACKUP_RETENTION)) {
    const days = intEnv(env, 'BB_BACKUP_RETENTION_DAYS', 30, 1, 3650);
    const connection = env.AZURE_STORAGE_CONNECTION_STRING;
    let container: ReturnType<typeof backupContainer> | null = null;
    tasks.push({ name: 'backup_retention', intervalMs: seconds('BB_OPS_BACKUP_RETENTION_SECONDS', 21600), leaseMs: 900_000, run: async (): Promise<TaskOutcome> => {
      container ??= backupsFactory(connection);
      const r = await pruneOffhostBackups(container, days);
      const detail = { backups: r.backups, deleted: r.deleted, kept: r.kept, failed: r.failed, retention_days: days };
      return r.failed ? { ok: false, errorCode: 'backup_delete_failed', detail } : { ok: true, detail };
    } });
  }
  // Opt-in: re-enqueues parse jobs for materials that never got one (idempotent, bounded batch).
  if (['1', 'true', 'on', 'yes'].includes((env.BB_OPS_PARSE_BACKFILL ?? '').toLowerCase()))
    tasks.push({ name: 'parse_backfill', intervalMs: seconds('BB_OPS_PARSE_BACKFILL_SECONDS', 3600), leaseMs: 600_000, run: async (): Promise<TaskOutcome> => {
      const r = await backfillParseJobs(pool); return { ok: true, detail: { scanned: r.scanned, enqueued: r.enqueued } };
    } });
  // #78 opt-in: per-source scheduled library sync (discover -> fetch -> dedupe -> review queue) and stale alerts.
  if (['1', 'true', 'on', 'yes'].includes((env.BB_OPS_LIBRARY_SYNC ?? '').toLowerCase())) {
    if (!env.AZURE_STORAGE_CONNECTION_STRING) throw new Error('Enabled library sync requires AZURE_STORAGE_CONNECTION_STRING');
    const blobs = blobsFactory(env.AZURE_STORAGE_CONNECTION_STRING, env.BB_LIBRARY_CONTAINER ?? 'bondbuddy-private');
    const adapters = libraryAdapters?.(blobs) ?? {
      [SSE_BOND_SOURCE.id]: new SseBondProjectAdapter({ maxProjects: intEnv(env, 'BB_LIBRARY_MAX_PROJECTS', 3, 1, 200), delayMs: 800 }),
      [OPERATOR_IMPORT_SOURCE.id]: new OperatorImportAdapter(blobs),
    };
    let registered = false;
    const owner = defaultOwner();
    tasks.push({ name: 'library_sync', intervalMs: seconds('BB_OPS_LIBRARY_SYNC_SECONDS', 60), leaseMs: seconds('BB_OPS_LIBRARY_SYNC_LEASE_SECONDS', 1800), run: async (): Promise<TaskOutcome> => {
      if (!registered && !libraryAdapters) { await registerLibrarySource(pool, SSE_BOND_SOURCE); await registerLibrarySource(pool, OPERATOR_IMPORT_SOURCE); registered = true; }
      const r = await runLibrarySyncPass({ pool, blobs, adapters, owner, retryDelayMs: 5000, maxJobs: intEnv(env, 'BB_LIBRARY_MAX_JOBS_PER_PASS', 5, 1, 100),
        staleFactor: intEnv(env, 'BB_LIBRARY_STALE_FACTOR', 2, 1, 100) });
      // Per-source failures already raised library_sync_failed; the task itself only fails when the pass throws.
      return { ok: true, detail: { ...r } };
    } });
  }
  return tasks;
}

/** Stale or missing live worker heartbeat raises worker_heartbeat_stale (same dedupe scope as trial health). */
export async function checkWorkerHeartbeat(pool: Pool, maxAgeSeconds: number) {
  const row = (await pool.query('SELECT EXTRACT(EPOCH FROM now()-max(last_seen_at))::int age FROM bb_worker_heartbeats WHERE stopped_at IS NULL')).rows[0];
  const age = row.age === null ? null : Math.max(0, Number(row.age));
  const stale = age === null || age > maxAgeSeconds;
  if (stale) await raiseAlert(pool, { kind: 'worker_heartbeat_stale', severity: 'critical', scope: 'workers', detail: { age_seconds: age ?? -1, threshold_seconds: maxAgeSeconds } });
  return { age_seconds: age ?? -1, stale: stale ? 1 : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) { process.stderr.write('ops-scheduler: DATABASE_URL required\n'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const log = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
  let scheduler: OpsScheduler;
  try {
    const tasks = tasksFromEnv(pool);
    scheduler = new OpsScheduler({ pool, tasks, tickMs: intEnv(process.env, 'BB_OPS_TICK_SECONDS', 5, 1, 300) * 1000, log }).start();
    log({ scheduler: 'started', owner: scheduler.owner, tasks: tasks.map(t => t.name).join(',') });
  } catch (error) {
    process.stderr.write(`ops-scheduler: ${error instanceof Error ? error.message : 'configuration failed'}\n`);
    await pool.end(); process.exit(1);
  }
  const shutdown = async () => { await scheduler.stop(); await pool.end(); log({ scheduler: 'stopped' }); process.exit(0); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
}
