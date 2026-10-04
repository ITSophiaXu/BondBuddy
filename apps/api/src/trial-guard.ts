import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import type { Pool, PoolClient } from 'pg';
import type { OperatorRole, TrialLimitKind, TrialLimits, TrialOverrideEffect } from '@bondbuddy/contracts';
import { digest, missing, Problem, transaction, uid, type PrivateBlobs } from './data.js';
import { gateState, raiseAlert } from './evidence-gate.js';

// #35 controlled trial guard. The platform pays for M1 trial usage, so these limits bound
// cost and abuse; there are no credits and nothing is charged. Limits come from server
// configuration; overrides and the operator kill switch are append-only rows (0025).

export type TrialConfig = TrialLimits;
type Db = Pool | PoolClient;

const intEnv = (env: NodeJS.ProcessEnv, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER) => {
  const raw = env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`Invalid ${name}`);
  return value;
};

/** BB_TRIAL_GUARD=on|off; unset means on in production (NODE_ENV=production) and off elsewhere. */
export function trialConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TrialConfig {
  const flag = env.BB_TRIAL_GUARD;
  if (flag !== undefined && flag !== 'on' && flag !== 'off') throw new Error('Invalid BB_TRIAL_GUARD');
  const zone = env.BB_TRIAL_DAY_TIME_ZONE ?? 'Asia/Shanghai';
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { throw new Error('Invalid BB_TRIAL_DAY_TIME_ZONE'); }
  if (!/^[A-Za-z_]+(?:\/[A-Za-z_+-]+)*$/.test(zone)) throw new Error('Invalid BB_TRIAL_DAY_TIME_ZONE');
  return {
    enabled: flag ? flag === 'on' : env.NODE_ENV === 'production',
    day_time_zone: zone,
    active_runs_per_user: intEnv(env, 'BB_TRIAL_ACTIVE_RUNS_PER_USER', 2),
    runs_per_user_per_day: intEnv(env, 'BB_TRIAL_RUNS_PER_USER_PER_DAY', 10),
    upload_bytes_per_user_per_day: intEnv(env, 'BB_TRIAL_UPLOAD_BYTES_PER_USER_PER_DAY', 1024 * 1024 * 1024),
    model_tokens_per_user_per_day: intEnv(env, 'BB_TRIAL_MODEL_TOKENS_PER_USER_PER_DAY', 2_000_000),
    unknown_usage_tokens_per_attempt: intEnv(env, 'BB_TRIAL_UNKNOWN_USAGE_TOKENS_PER_ATTEMPT', 200_000),
    global_active_runs: intEnv(env, 'BB_TRIAL_GLOBAL_ACTIVE_RUNS', 4),
    projects_per_user_per_day: intEnv(env, 'BB_TRIAL_PROJECTS_PER_USER_PER_DAY', 20),
    projects_per_source_per_hour: intEnv(env, 'BB_TRIAL_PROJECTS_PER_SOURCE_PER_HOUR', 120),
    uploads_per_user_per_hour: intEnv(env, 'BB_TRIAL_UPLOADS_PER_USER_PER_HOUR', 120),
    uploads_per_source_per_hour: intEnv(env, 'BB_TRIAL_UPLOADS_PER_SOURCE_PER_HOUR', 1200),
    kill_switch_config: env.BB_TRIAL_KILL_SWITCH === '1',
  };
}

// The worker-side check (recordPotentialCall) reads one process-wide configuration.
let processConfig: TrialConfig | null = null;
export function trialGuardConfig() { return processConfig ??= trialConfigFromEnv(); }
/** Test hook and embedding hook: replace the process-wide worker-side configuration. */
export function configureTrialGuard(config: TrialConfig | null) { processConfig = config; }

export class TrialLimitProblem extends Problem {
  constructor(status: 403 | 429 | 503, code: 'TRIAL_QUOTA_EXCEEDED' | 'TRIAL_ACCESS_DENIED' | 'MODEL_CALLS_SUSPENDED', readonly limit: TrialLimitKind) {
    super(status, code, code === 'MODEL_CALLS_SUSPENDED' ? 'New model work is suspended by the operator' : code === 'TRIAL_ACCESS_DENIED' ? 'Trial access is suspended for this account' : `Trial limit reached: ${limit}`);
  }
}
const exceeded = (limit: TrialLimitKind) => new TrialLimitProblem(429, 'TRIAL_QUOTA_EXCEEDED', limit);

/** Keyed hash of the trusted remote address; the address itself is never stored. */
export function sourceHash(ip: string | undefined, env: NodeJS.ProcessEnv = process.env) {
  if (!ip) return null;
  return createHash('sha256').update(`bb-trial-source:${env.BB_TRIAL_SOURCE_SALT ?? ''}:${ip}`).digest('hex');
}

async function dayStart(db: Db, zone: string) {
  return (await db.query("SELECT date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1 AS start", [zone])).rows[0].start as Date;
}
const lockKey = (db: Db, key: string) => db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);

export async function activeOverride(db: Db, userId: string): Promise<TrialOverrideEffect | null> {
  const q = await db.query('SELECT effect FROM bb_trial_overrides WHERE user_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) ORDER BY seq DESC LIMIT 1', [userId]);
  return (q.rows[0]?.effect ?? null) as TrialOverrideEffect | null;
}

export async function killSwitchState(db: Db, config: TrialConfig) {
  const q = await db.query('SELECT state,reason_code,created_at FROM bb_trial_kill_switch_events ORDER BY seq DESC LIMIT 1');
  const row = q.rows[0];
  return { engaged: config.kill_switch_config || row?.state === 'engaged', config_engaged: config.kill_switch_config,
    operator_state: (row?.state ?? null) as 'engaged' | 'released' | null, reason_code: (row?.reason_code ?? null) as string | null, changed_at: row ? new Date(row.created_at).toISOString() : null };
}

const ACTIVE_RUN_STATES = "('preparing','queued','running','validating','delivering')";

/** Platform safety budget only: observed tokens plus a conservative allowance for unknown usage. */
export async function tokensSince(db: Db, config: TrialConfig, userId: string, since: Date) {
  const q = await db.query(`SELECT COALESCE(sum(tokens),0)::bigint AS tokens FROM (
    SELECT CASE WHEN a.status='confirmed_not_sent' THEN 0
      WHEN e.usage_status='measured' THEN e.input_tokens+e.output_tokens ELSE $3::bigint END AS tokens
    FROM bb_model_call_attempts a JOIN bb_call_usage_effective e ON e.attempt_id=a.id
    WHERE a.owner_user_id=$1 AND a.created_at>=$2
    UNION ALL
    SELECT CASE WHEN status='confirmed_not_sent' THEN 0
      WHEN usage_status='measured' THEN input_tokens+output_tokens ELSE $3::bigint END AS tokens
    FROM bb_review_assistant_attempts WHERE owner_user_id=$1 AND created_at>=$2
  ) usage_budget`, [userId, since, config.unknown_usage_tokens_per_attempt]);
  return Number(q.rows[0].tokens);
}

async function countAdmissions(db: Db, column: 'owner_user_id' | 'source_hash', value: string, kind: string, since: Date | string) {
  const q = await db.query(`SELECT count(*)::int n, COALESCE(sum(byte_size),0)::bigint bytes FROM bb_trial_admissions WHERE ${column}=$1 AND kind=$2 AND created_at>=$3`, [value, kind, since]);
  return { n: Number(q.rows[0].n), bytes: Number(q.rows[0].bytes) };
}
const hourAgo = () => new Date(Date.now() - 3600_000);
const admit = (db: Db, userId: string, kind: string, source: string | null, bytes = 0) =>
  db.query('INSERT INTO bb_trial_admissions(id,owner_user_id,kind,source_hash,byte_size) VALUES($1,$2,$3,$4,$5)', [uid(), userId, kind, source, bytes]);

/** Deny wins over everything; allow exempts the account from per-account and per-source limits. */
async function accountOverride(db: Db, userId: string) {
  await lockKey(db, `trial:user:${userId}`);
  const effect = await activeOverride(db, userId);
  if (effect === 'deny') throw new TrialLimitProblem(403, 'TRIAL_ACCESS_DENIED', 'operator_deny');
  return effect;
}

export async function admitProjectCreate(client: PoolClient, config: TrialConfig, userId: string, source: string | null) {
  const effect = await accountOverride(client, userId);
  if (config.enabled && effect !== 'allow') {
    if ((await countAdmissions(client, 'owner_user_id', userId, 'project_create', await dayStart(client, config.day_time_zone))).n >= config.projects_per_user_per_day) throw exceeded('projects_per_user_per_day');
    if (source && (await countAdmissions(client, 'source_hash', source, 'project_create', hourAgo())).n >= config.projects_per_source_per_hour) throw exceeded('projects_per_source_per_hour');
  }
  await admit(client, userId, 'project_create', source);
}

export async function admitUploadCreate(client: PoolClient, config: TrialConfig, userId: string, source: string | null, bytes: number) {
  const effect = await accountOverride(client, userId);
  if (config.enabled && effect !== 'allow') {
    if ((await countAdmissions(client, 'owner_user_id', userId, 'upload_create', hourAgo())).n >= config.uploads_per_user_per_hour) throw exceeded('uploads_per_user_per_hour');
    if (source && (await countAdmissions(client, 'source_hash', source, 'upload_create', hourAgo())).n >= config.uploads_per_source_per_hour) throw exceeded('uploads_per_source_per_hour');
    const today = await countAdmissions(client, 'owner_user_id', userId, 'upload_create', await dayStart(client, config.day_time_zone));
    if (today.bytes + bytes > config.upload_bytes_per_user_per_day) throw exceeded('upload_bytes_per_user_per_day');
  }
  await admit(client, userId, 'upload_create', source, bytes);
}

/** Called inside the execute transaction, after idempotent replay, so a replay never hits a quota. */
export async function admitRunSubmit(client: PoolClient, config: TrialConfig, userId: string, source: string | null) {
  if ((await killSwitchState(client, config)).engaged) throw new TrialLimitProblem(503, 'MODEL_CALLS_SUSPENDED', 'kill_switch');
  const effect = await accountOverride(client, userId);
  if (config.enabled) {
    // One global lock serialises admission so concurrent submits cannot overshoot the cap.
    await lockKey(client, 'trial:global_runs');
    const global = (await client.query(`SELECT count(*)::int n FROM bb_runs WHERE state IN ${ACTIVE_RUN_STATES}`)).rows[0].n;
    if (global >= config.global_active_runs) throw exceeded('global_active_runs');
    if (effect !== 'allow') {
      const active = (await client.query(`SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1 AND state IN ${ACTIVE_RUN_STATES}`, [userId])).rows[0].n;
      if (active >= config.active_runs_per_user) throw exceeded('active_runs_per_user');
      const since = await dayStart(client, config.day_time_zone);
      const today = (await client.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1 AND created_at>=$2', [userId, since])).rows[0].n;
      if (today >= config.runs_per_user_per_day) throw exceeded('runs_per_user_per_day');
      if (config.model_tokens_per_user_per_day > 0 && await tokensSince(client, config, userId, since) >= config.model_tokens_per_user_per_day) throw exceeded('model_tokens_per_user_per_day');
    }
  }
  await admit(client, userId, 'run_submit', source);
}

/** Worker-side check before each new model call intent (inside the intent transaction). */
export async function assertModelCallAllowed(client: PoolClient, config: TrialConfig, userId: string) {
  if ((await killSwitchState(client, config)).engaged) throw new TrialLimitProblem(503, 'MODEL_CALLS_SUSPENDED', 'kill_switch');
  const effect = await activeOverride(client, userId);
  if (effect === 'deny') throw new TrialLimitProblem(403, 'TRIAL_ACCESS_DENIED', 'operator_deny');
  if (config.enabled && effect !== 'allow' && config.model_tokens_per_user_per_day > 0 && await tokensSince(client, config, userId, await dayStart(client, config.day_time_zone)) >= config.model_tokens_per_user_per_day)
    throw exceeded('model_tokens_per_user_per_day');
}

/** Raise the #79 quota alert for a rejection (one per limit and scope per hour). Never throws. */
export async function reportTrialRejection(pool: Pool, error: unknown, userId: string) {
  if (!(error instanceof TrialLimitProblem) || error.limit === 'kill_switch' || error.limit === 'operator_deny') return;
  const scope = error.limit === 'global_active_runs' ? 'global' : userId;
  try { await raiseAlert(pool, { kind: 'trial_quota_exhausted', severity: 'warning', scope: `${error.limit}:${scope}`, detail: { limit_kind: error.limit, scope } }); } catch { /* the rejection itself is still logged */ }
}

// ---- worker heartbeat ----------------------------------------------------------------

export function defaultWorkerId() { return `${hostname().replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)}-${process.pid}-${uid().slice(0, 8)}`; }
export async function recordWorkerHeartbeat(pool: Pool, input: { workerId: string; startedAt: Date; kinds: readonly ('run' | 'parse')[]; concurrency: number; stopped?: boolean }) {
  await pool.query(`INSERT INTO bb_worker_heartbeats(worker_id,started_at,last_seen_at,kinds,concurrency,stopped_at) VALUES($1,$2,now(),$3,$4,CASE WHEN $5 THEN now() END)
    ON CONFLICT(worker_id) DO UPDATE SET last_seen_at=now(),kinds=EXCLUDED.kinds,concurrency=EXCLUDED.concurrency,stopped_at=EXCLUDED.stopped_at`,
  [input.workerId, input.startedAt, [...input.kinds], input.concurrency, !!input.stopped]);
}
export function workerGroupsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.BB_READY_WORKER_GROUPS === undefined) return [];
  const groups = env.BB_READY_WORKER_GROUPS.split(',').map(v => v.trim());
  if (groups.some(v => !/^[a-z][a-z0-9_-]{0,31}$/.test(v)) || new Set(groups).size !== groups.length) throw new Error('Invalid BB_READY_WORKER_GROUPS');
  return groups;
}
async function newestHeartbeatAge(db: Db, groups: readonly string[] = []) {
  if (groups.length) {
    const q = await db.query(`SELECT CASE WHEN count(seen) = cardinality($1::text[]) THEN EXTRACT(EPOCH FROM now()-min(seen))::int END age
      FROM (SELECT g, max(h.last_seen_at) seen FROM unnest($1::text[]) g
        LEFT JOIN bb_worker_heartbeats h ON split_part(h.worker_id, ':', 1)=g AND h.stopped_at IS NULL GROUP BY g) groups`, [groups]);
    return q.rows[0].age === null ? null : Math.max(0, Number(q.rows[0].age));
  }
  const q = await db.query('SELECT EXTRACT(EPOCH FROM now()-max(last_seen_at))::int age FROM bb_worker_heartbeats WHERE stopped_at IS NULL');
  return q.rows[0].age === null ? null : Math.max(0, Number(q.rows[0].age));
}

// ---- readiness and alerts -----------------------------------------------------------

export type ReadinessOptions = { workerGroups?: readonly string[]; heartbeatMaxAgeSeconds: number; timeoutMs: number };
export function readinessOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ReadinessOptions {
  return { workerGroups: workerGroupsFromEnv(env), heartbeatMaxAgeSeconds: intEnv(env, 'BB_READY_WORKER_HEARTBEAT_MAX_AGE_SECONDS', 90, 86400), timeoutMs: intEnv(env, 'BB_READY_TIMEOUT_MS', 2000, 60000) };
}
const withTimeout = <T>(work: Promise<T>, ms: number) => Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref())]);

/** Only check states leave this function: no error text, host names or counts beyond the heartbeat age. */
export async function readiness(pool: Pool, blobs: PrivateBlobs | null, options: ReadinessOptions) {
  type State = 'ok' | 'failed' | 'paused' | 'stale' | 'missing';
  const checks: Record<'database' | 'blob_storage' | 'evidence_gate' | 'worker_heartbeat', State> = { database: 'failed', blob_storage: 'failed', evidence_gate: 'failed', worker_heartbeat: 'failed' };
  let age: number | null = null;
  try {
    await withTimeout(pool.query('SELECT 1'), options.timeoutMs);
    checks.database = 'ok';
    const gate = await withTimeout(gateState(pool), options.timeoutMs);
    checks.evidence_gate = gate.state === 'paused' || gate.process_state === 'paused' ? 'paused' : 'ok';
    age = await withTimeout(newestHeartbeatAge(pool, options.workerGroups), options.timeoutMs);
    checks.worker_heartbeat = age === null ? 'missing' : age > options.heartbeatMaxAgeSeconds ? 'stale' : 'ok';
  } catch { /* remaining checks stay failed */ }
  if (blobs) {
    try { await withTimeout(blobs.exists('health/readiness-probe'), options.timeoutMs); checks.blob_storage = 'ok'; } catch { /* failed */ }
  }
  const ready = Object.values(checks).every(state => state === 'ok');
  return { status: ready ? 'ready' as const : 'not_ready' as const, checks, worker_heartbeat_age_seconds: age, checked_at: new Date().toISOString() };
}

export type TrialHealthThresholds = { workerGroups?: readonly string[]; heartbeatMaxAgeSeconds: number; queueBacklogMaxAgeSeconds: number; errorWindowSeconds: number; errorRateThreshold: number; errorMinSample: number };
export function trialHealthThresholdsFromEnv(env: NodeJS.ProcessEnv = process.env): TrialHealthThresholds {
  const rate = env.BB_ALERT_ERROR_RATE === undefined ? 0.5 : Number(env.BB_ALERT_ERROR_RATE);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1) throw new Error('Invalid BB_ALERT_ERROR_RATE');
  return { workerGroups: workerGroupsFromEnv(env), heartbeatMaxAgeSeconds: intEnv(env, 'BB_READY_WORKER_HEARTBEAT_MAX_AGE_SECONDS', 90, 86400), queueBacklogMaxAgeSeconds: intEnv(env, 'BB_ALERT_QUEUE_BACKLOG_SECONDS', 600, 86400 * 7),
    errorWindowSeconds: intEnv(env, 'BB_ALERT_ERROR_WINDOW_SECONDS', 900, 86400), errorRateThreshold: rate, errorMinSample: intEnv(env, 'BB_ALERT_ERROR_MIN_SAMPLE', 5, 100000) };
}

/** One health pass: appends deduplicated #79 alerts and returns the kinds that fired. */
export async function checkTrialHealth(pool: Pool, config: TrialConfig, t: TrialHealthThresholds) {
  const fired: string[] = [];
  const age = await newestHeartbeatAge(pool, t.workerGroups);
  if (age === null || age > t.heartbeatMaxAgeSeconds) {
    await raiseAlert(pool, { kind: 'worker_heartbeat_stale', severity: 'critical', scope: 'workers', detail: { age_seconds: age ?? -1, threshold_seconds: t.heartbeatMaxAgeSeconds } });
    fired.push('worker_heartbeat_stale');
  }
  const backlog = (await pool.query("SELECT EXTRACT(EPOCH FROM now()-min(updated_at))::int age, count(*)::int n FROM bb_jobs WHERE state='queued'")).rows[0];
  if (backlog.age !== null && Number(backlog.age) > t.queueBacklogMaxAgeSeconds) {
    await raiseAlert(pool, { kind: 'queue_backlog_stale', severity: 'warning', scope: 'jobs', detail: { oldest_age_seconds: Number(backlog.age), queued: backlog.n, threshold_seconds: t.queueBacklogMaxAgeSeconds } });
    fired.push('queue_backlog_stale');
  }
  const window = (await pool.query("SELECT count(*) FILTER (WHERE state='failed')::int failed, count(*)::int finished FROM bb_jobs WHERE state IN ('succeeded','failed') AND updated_at>=now()-make_interval(secs=>$1)", [t.errorWindowSeconds])).rows[0];
  if (window.finished >= t.errorMinSample && window.failed / window.finished >= t.errorRateThreshold) {
    await raiseAlert(pool, { kind: 'error_rate_spike', severity: 'critical', scope: 'jobs', bucketSeconds: t.errorWindowSeconds, detail: { failed: window.failed, finished: window.finished, window_seconds: t.errorWindowSeconds } });
    fired.push('error_rate_spike');
  }
  if (config.enabled) {
    const active = (await pool.query(`SELECT count(*)::int n FROM bb_runs WHERE state IN ${ACTIVE_RUN_STATES}`)).rows[0].n;
    if (active >= config.global_active_runs) {
      await raiseAlert(pool, { kind: 'trial_quota_exhausted', severity: 'warning', scope: 'global_active_runs:global', detail: { limit_kind: 'global_active_runs', scope: 'global', active_runs: active } });
      fired.push('trial_quota_exhausted');
    }
  }
  return fired;
}

// ---- operator API -----------------------------------------------------------------

async function audit(client: PoolClient, actorId: string, role: OperatorRole, purpose: string, filter: unknown, owner?: string | null, target?: string, reason?: string) {
  await client.query('INSERT INTO bb_log_access_audit(id,actor_id,owner_user_id,purpose,filter_hash,actor_role,target_ref,reason_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [uid(), actorId, owner ?? '*', purpose, digest(JSON.stringify(filter ?? {})), role, target ?? null, reason ?? null]);
}
const iso = (value: unknown) => value ? new Date(value as string).toISOString() : null;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const invalid = (message: string) => new Problem(422, 'VALIDATION_FAILED', message);
function onlyKeys(query: Record<string, unknown>, allowed: string[]) {
  for (const [key, value] of Object.entries(query)) if (!allowed.includes(key) || typeof value !== 'string') throw invalid('Unsupported filter');
}
const validDay = (value: string) => dayPattern.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

export async function trialStatus(pool: Pool, config: TrialConfig, actorId: string) {
  return transaction(pool, async client => {
    await audit(client, actorId, 'log_reader', 'trial_status', {});
    const workers = (await client.query('SELECT worker_id,last_seen_at,kinds,concurrency,EXTRACT(EPOCH FROM now()-last_seen_at)::int age FROM bb_worker_heartbeats WHERE stopped_at IS NULL ORDER BY last_seen_at DESC LIMIT 50')).rows;
    const oldest = (await client.query("SELECT EXTRACT(EPOCH FROM now()-min(updated_at))::int age FROM bb_jobs WHERE state='queued'")).rows[0].age;
    return { limits: config, kill_switch: await killSwitchState(client, config),
      global_active_runs: (await client.query(`SELECT count(*)::int n FROM bb_runs WHERE state IN ${ACTIVE_RUN_STATES}`)).rows[0].n,
      workers: workers.map(w => ({ worker_id: w.worker_id, last_seen_at: iso(w.last_seen_at)!, age_seconds: Math.max(0, Number(w.age)), kinds: w.kinds, concurrency: w.concurrency })),
      oldest_queued_age_seconds: oldest === null ? null : Math.max(0, Number(oldest)) };
  });
}

type UsageRow = { day: string; user_id: string | null; runs_created: number; runs_finished: number; run_duration_ms: number; attempts: number; measured_attempts: number; unresolved_attempts: number; model_call_duration_ms: number; measured_tokens: { input_tokens: number; output_tokens: number; cached_input_tokens: number; reasoning_tokens: number }; conservative_tokens: number; upload_bytes: number; pricing_status: 'unknown' };
const emptyRow = (day: string, user: string | null): UsageRow => ({ day, user_id: user, runs_created: 0, runs_finished: 0, run_duration_ms: 0, attempts: 0, measured_attempts: 0, unresolved_attempts: 0, model_call_duration_ms: 0, measured_tokens: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, reasoning_tokens: 0 }, conservative_tokens: 0, upload_bytes: 0, pricing_status: 'unknown' });

/** Daily aggregates per user and in total, grouped by the trial accounting day. */
export async function trialUsage(pool: Pool, config: TrialConfig, actorId: string, query: Record<string, unknown>) {
  onlyKeys(query, ['from', 'to', 'user_id']);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: config.day_time_zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const from = (query.from as string | undefined) ?? today, to = (query.to as string | undefined) ?? from;
  const user = query.user_id as string | undefined;
  if (!validDay(from) || !validDay(to) || from > to || (Date.parse(to) - Date.parse(from)) / 86400_000 > 92) throw invalid('from/to must be dates at most 92 days apart');
  if (user !== undefined && !idPattern.test(user)) throw invalid('Invalid user_id');
  return transaction(pool, async client => {
    await audit(client, actorId, 'log_reader', 'trial_usage', { from, to, user }, user ?? null);
    const tz = config.day_time_zone;
    // $1 zone, $2 from day, $3 to day (inclusive), $4 optional user, $5 conservative charge.
    const range = (column: string) => `(${column} AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date AND ($4::text IS NULL OR owner_user_id=$4)`;
    const args = [tz, from, to, user ?? null];
    const rows = new Map<string, UsageRow>();
    const row = (day: string, u: string) => { const key = `${day}|${u}`; let r = rows.get(key); if (!r) rows.set(key, r = emptyRow(day, u)); return r; };
    const dayText = (column: string) => `to_char((${column} AT TIME ZONE $1)::date,'YYYY-MM-DD')`;
    for (const r of (await client.query(`SELECT ${dayText('created_at')} d,owner_user_id u,count(*)::int n FROM bb_runs WHERE ${range('created_at')} GROUP BY 1,2`, args)).rows) row(r.d, r.u).runs_created = r.n;
    for (const r of (await client.query(`SELECT ${dayText('updated_at')} d,owner_user_id u,count(*)::int n,COALESCE(sum(EXTRACT(EPOCH FROM updated_at-created_at)*1000),0)::bigint ms FROM bb_runs WHERE state IN ('succeeded','test_completed','failed','cancelled') AND ${range('updated_at')} GROUP BY 1,2`, args)).rows) { const x = row(r.d, r.u); x.runs_finished = r.n; x.run_duration_ms = Number(r.ms); }
    for (const r of (await client.query(`SELECT ${dayText('created_at')} d,owner_user_id u,count(*)::int n,
        count(*) FILTER (WHERE usage_status='measured')::int measured,
        count(*) FILTER (WHERE usage_status<>'measured' AND call_status<>'confirmed_not_sent')::int unresolved,
        COALESCE(sum(duration_ms),0)::bigint ms,
        COALESCE(sum(input_tokens) FILTER (WHERE usage_status='measured'),0)::bigint i, COALESCE(sum(output_tokens) FILTER (WHERE usage_status='measured'),0)::bigint o,
        COALESCE(sum(cached_input_tokens) FILTER (WHERE usage_status='measured'),0)::bigint c, COALESCE(sum(reasoning_tokens) FILTER (WHERE usage_status='measured'),0)::bigint rsn,
        COALESCE(sum(CASE WHEN call_status='confirmed_not_sent' THEN 0 WHEN usage_status='measured' THEN input_tokens+output_tokens ELSE $5::bigint END),0)::bigint cons
      FROM bb_platform_cost_ledger WHERE ${range('created_at')} GROUP BY 1,2`, [...args, config.unknown_usage_tokens_per_attempt])).rows) {
      const x = row(r.d, r.u); x.attempts = r.n; x.measured_attempts = r.measured; x.unresolved_attempts = r.unresolved; x.model_call_duration_ms = Number(r.ms);
      x.measured_tokens = { input_tokens: Number(r.i), output_tokens: Number(r.o), cached_input_tokens: Number(r.c), reasoning_tokens: Number(r.rsn) }; x.conservative_tokens = Number(r.cons);
    }
    for (const r of (await client.query(`SELECT ${dayText('created_at')} d,owner_user_id u,COALESCE(sum(byte_size),0)::bigint b FROM bb_trial_admissions WHERE kind='upload_create' AND ${range('created_at')} GROUP BY 1,2`, args)).rows) row(r.d, r.u).upload_bytes = Number(r.b);
    const perUser = [...rows.values()].sort((a, b) => a.day.localeCompare(b.day) || a.user_id!.localeCompare(b.user_id!));
    const totals = new Map<string, UsageRow>();
    for (const r of perUser) {
      const t = totals.get(r.day) ?? emptyRow(r.day, null); totals.set(r.day, t);
      for (const k of ['runs_created', 'runs_finished', 'run_duration_ms', 'attempts', 'measured_attempts', 'unresolved_attempts', 'model_call_duration_ms', 'conservative_tokens', 'upload_bytes'] as const) t[k] += r[k];
      for (const k of ['input_tokens', 'output_tokens', 'cached_input_tokens', 'reasoning_tokens'] as const) t.measured_tokens[k] += r.measured_tokens[k];
    }
    return { from, to, day_time_zone: tz, pricing_status: 'unknown' as const, per_user: perUser, totals: [...totals.values()] };
  });
}

/** Per-attempt platform cost records, oldest first, keyset-paginated. */
export async function costLedger(pool: Pool, config: TrialConfig, actorId: string, query: Record<string, unknown>) {
  onlyKeys(query, ['user_id', 'from', 'to', 'cursor', 'limit']);
  const user = query.user_id as string | undefined, from = query.from as string | undefined, to = query.to as string | undefined, cursor = query.cursor as string | undefined;
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  if (user !== undefined && !idPattern.test(user)) throw invalid('Invalid user_id');
  for (const value of [from, to]) if (value !== undefined && Number.isNaN(Date.parse(value))) throw invalid('Invalid time range');
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw invalid('Invalid limit');
  let after: [string, string] | null = null;
  if (cursor !== undefined) {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!at || !id || Number.isNaN(Date.parse(at)) || !idPattern.test(id)) throw invalid('Invalid cursor');
    after = [at, id];
  }
  return transaction(pool, async client => {
    await audit(client, actorId, 'log_reader', 'trial_cost_ledger', { user, from, to, cursor, limit }, user ?? null);
    // The cursor keeps microsecond precision so a page boundary never repeats or skips a row.
    const q = await client.query(`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at FROM bb_platform_cost_ledger
      WHERE ($1::text IS NULL OR owner_user_id=$1) AND ($2::timestamptz IS NULL OR created_at>=$2) AND ($3::timestamptz IS NULL OR created_at<=$3)
        AND ($4::timestamptz IS NULL OR (created_at,attempt_id)>($4,$5::text))
      ORDER BY created_at,attempt_id LIMIT $6`, [user ?? null, from ?? null, to ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1]);
    const page = q.rows.slice(0, limit);
    const items = page.map(r => ({ attempt_id: r.attempt_id, user_id: r.owner_user_id, job_id: r.job_id, run_id: r.run_id ?? null, logical_call_id: r.logical_call_id, attempt_no: r.attempt_no, model_id: r.model_id ?? null, model_provider: r.model_provider ?? null,
      call_status: r.call_status, usage_status: r.usage_status, input_tokens: r.input_tokens, output_tokens: r.output_tokens, cached_input_tokens: r.cached_input_tokens, reasoning_tokens: r.reasoning_tokens,
      conservative_tokens: r.call_status === 'confirmed_not_sent' ? 0 : r.usage_status === 'measured' ? r.input_tokens + r.output_tokens : config.unknown_usage_tokens_per_attempt,
      duration_ms: r.duration_ms ?? null, billable: r.billable, cost_bearer: r.cost_bearer, rate_ref: r.rate_ref ?? null,
      pricing_status: r.pricing_status, cost_amount: r.cost_amount ?? null, currency: r.pricing_status === 'priced' ? r.currency : null, created_at: iso(r.created_at)! }));
    const last = page.at(-1);
    return { pricing_status: 'unknown' as const, items,
      next_cursor: q.rows.length > limit && last ? Buffer.from(`${last.cursor_at}|${last.attempt_id}`).toString('base64url') : null };
  });
}

const overrideDto = (r: any) => ({ override_id: r.id, user_id: r.user_id, effect: r.effect, reason_code: r.reason_code, created_at: iso(r.created_at)!, expires_at: iso(r.expires_at), revoked_at: iso(r.revoked_at) });
export async function listOverrides(pool: Pool, actorId: string) {
  return transaction(pool, async client => {
    await audit(client, actorId, 'log_reader', 'trial_overrides', {});
    const q = await client.query('SELECT * FROM bb_trial_overrides WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) ORDER BY seq DESC LIMIT 500');
    return { items: q.rows.map(overrideDto) };
  });
}
export async function createOverride(pool: Pool, actorId: string, input: { user_id: string; effect: TrialOverrideEffect; reason_code: string; expires_at?: string | null }) {
  if (input.expires_at && Date.parse(input.expires_at) <= Date.now()) throw invalid('expires_at must be in the future');
  return transaction(pool, async client => {
    if (!(await client.query('SELECT 1 FROM bb_users WHERE id=$1', [input.user_id])).rowCount) throw missing();
    await audit(client, actorId, 'log_operator', 'trial_override_create', input, input.user_id, input.user_id, input.reason_code);
    const q = await client.query('INSERT INTO bb_trial_overrides(id,user_id,effect,reason_code,actor_id,expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [uid(), input.user_id, input.effect, input.reason_code, actorId, input.expires_at ?? null]);
    return overrideDto(q.rows[0]);
  });
}
export async function revokeOverride(pool: Pool, actorId: string, overrideId: string, reason: string) {
  if (!idPattern.test(overrideId)) throw missing();
  return transaction(pool, async client => {
    const current = (await client.query('SELECT * FROM bb_trial_overrides WHERE id=$1 FOR UPDATE', [overrideId])).rows[0];
    if (!current) throw missing();
    if (current.revoked_at) throw new Problem(409, 'ALREADY_TERMINAL', 'Override already revoked');
    await audit(client, actorId, 'log_operator', 'trial_override_revoke', { overrideId }, current.user_id, overrideId, reason);
    const q = await client.query('UPDATE bb_trial_overrides SET revoked_at=now(),revoked_by=$2,revoke_reason_code=$3 WHERE id=$1 RETURNING *', [overrideId, actorId, reason]);
    return overrideDto(q.rows[0]);
  });
}
export async function setKillSwitch(pool: Pool, config: TrialConfig, actorId: string, state: 'engaged' | 'released', reason: string) {
  return transaction(pool, async client => {
    await client.query('LOCK TABLE bb_trial_kill_switch_events IN SHARE ROW EXCLUSIVE MODE');
    const current = await killSwitchState(client, config);
    if ((current.operator_state ?? 'released') === state) throw new Problem(409, 'ALREADY_TERMINAL', `Kill switch already ${state}`);
    await audit(client, actorId, 'log_operator', 'trial_kill_switch', { state }, null, state, reason);
    await client.query('INSERT INTO bb_trial_kill_switch_events(id,state,reason_code,actor_id) VALUES($1,$2,$3,$4)', [uid(), state, reason, actorId]);
    return killSwitchState(client, config);
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  // `node dist/trial-guard.js health`: one alert pass, for cron or a systemd timer.
  const { Pool } = await import('pg');
  if (process.argv[2] !== 'health' || !process.env.DATABASE_URL) throw new Error('usage: DATABASE_URL=... node dist/trial-guard.js health');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try { process.stdout.write(`${JSON.stringify({ kind: 'trial_health', fired: await checkTrialHealth(pool, trialConfigFromEnv(), trialHealthThresholdsFromEnv()) })}\n`); }
  finally { await pool.end(); }
}
