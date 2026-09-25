import { fileURLToPath, pathToFileURL } from 'node:url';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Pool, type PoolClient } from 'pg';
import { ADMIN_LOG_FILTERS, ADMIN_LOG_PAGE_LIMIT, type OperatorRole } from '@bondbuddy/contracts';
import { azureBlobs, digest, missing, Problem, transaction, uid, type PrivateBlobs } from './data.js';
import { emitInternal, internalEvent, saveSnapshotRef } from './observability.js';
import { raiseAlert } from './evidence-gate.js';

const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const safeCode = /^[a-z][a-z0-9_]{0,63}$/;
const iso = (value: Date | string | null | undefined) => value ? new Date(value).toISOString() : null;
const int = (value: unknown) => value === null || value === undefined ? null : Number(value);

// ---------------------------------------------------------------- scrubbing

export const SCRUB_VERSION = 'scrub_v1';
const scrubRules: Array<[RegExp, string]> = [
  [/\b(set-cookie|cookie)(\s*[:=]\s*)[^\r\n]*/gi, '$1$2[REDACTED]'],
  [/\b(authorization|proxy-authorization)(\s*[:=]\s*)[^\r\n]*/gi, '$1$2[REDACTED]'],
  [/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]'],
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, '[REDACTED_KEY]'],
  [/\b(api[_-]?key|access[_-]?key|secret|client[_-]?secret|token|password|passwd|pwd)(\s*["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1$2[REDACTED]'],
  [/(验证码|校验码|动态码|短信码|otp|captcha|verification code)(\s*(?:[:：=]|是|为)?\s*)[A-Za-z0-9]{4,8}\b/gi, '$1$2[REDACTED]']
];
/** Removes credentials, captcha/OTP codes and cookies before a prompt body is stored anywhere. */
export function scrubSecrets(text: string) {
  let value = text;
  for (const [pattern, replacement] of scrubRules) value = value.replace(pattern, replacement);
  return value;
}

/** Scrub, store the body in private Blob only, then register the reference row. */
export async function savePromptSnapshot(pool: Pool, blobs: PrivateBlobs, input: { owner: string; projectId: string; runId?: string; kind: 'user_prompt' | 'model_request' | 'structured_input'; version: number; body: string; inputRevision?: number; inputHash?: string; templateVersion?: string; rulePackVersion?: string; modelParametersVersion?: string }) {
  const scrubbed = scrubSecrets(input.body);
  const objectKey = `users/${input.owner}/projects/${input.projectId}/snapshots/${uid()}`;
  await blobs.put(objectKey, Buffer.from(scrubbed, 'utf8'), 'text/plain; charset=utf-8');
  try {
    return await saveSnapshotRef(pool, { ...input, objectKey, sha256: digest(scrubbed), redactionVersion: SCRUB_VERSION, blobs });
  } catch (error) { await blobs.delete(objectKey).catch(() => undefined); throw error; }
}

// ---------------------------------------------------------------- forwarding

export type LogRecord = { delivery_key: string; outbox_id: string; event: Record<string, unknown> };
/** A sink must treat delivery_key as an idempotency key: the same key may arrive again after a crash. */
export interface LogSink { name: string; deliver(records: LogRecord[]): Promise<void> }

/**
 * NDJSON file sink. The flock child holds an OS lock while it scans and fsyncs
 * the file; a process exit releases the lock. The file itself is the receipt
 * journal, so there is no second index whose crash ordering could lose events.
 */
export function ndjsonFileSink(path: string, name = 'ndjson_file'): LogSink {
  return { name, async deliver(records) {
    if (!records.length) return;
    const lock = await open(`${path}.lock`, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await lock.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('Unsafe NDJSON lock permissions');
      const child = spawn('flock', ['-x', '-F', '/proc/self/fd/3', process.execPath, fileURLToPath(new URL('./ndjson-file-sink.js', import.meta.url)), path],
        { stdio: ['pipe', 'ignore', 'pipe', lock.fd] });
      let errorText = '';
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', chunk => { errorText = (errorText + chunk).slice(0, 4096); });
      const exited = new Promise<number>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', code => resolve(code ?? 1));
      });
      child.stdin!.on('error', () => undefined); // child failure is reported by its exit code
      child.stdin!.end(JSON.stringify(records));
      if (await exited !== 0) throw new Error(`NDJSON sink refused delivery: ${errorText || 'writer failed'}`);
    } finally { await lock.close(); }
  } };
}

export type ForwardOptions = { batchSize?: number; leaseSeconds?: number; retrySeconds?: number; afterSinkAccept?: () => Promise<void> };
export async function forwardLogs(pool: Pool, sink: LogSink, options: ForwardOptions = {}) {
  const batch = options.batchSize ?? 100, lease = options.leaseSeconds ?? 60, retry = options.retrySeconds ?? 30;
  if (!safeCode.test(sink.name) || !Number.isInteger(batch) || batch < 1 || batch > 1000) throw new Error('Invalid forwarder configuration');
  const token = uid();
  const claimed = await transaction(pool, async client => (await client.query(`UPDATE bb_outbox o SET lease_token=$1,lease_until=now()+($2::integer*interval '1 second'),delivery_attempts=delivery_attempts+1
      WHERE o.id IN (SELECT id FROM bb_outbox WHERE aggregate_type='observability' AND delivered_at IS NULL
        AND (lease_until IS NULL OR lease_until<now()) AND (next_attempt_at IS NULL OR next_attempt_at<=now())
        ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $3)
      RETURNING o.id,o.aggregate_id,o.delivery_attempts,o.created_at`, [token, lease, batch])).rows);
  if (!claimed.length) return { claimed: 0, delivered: 0, failed: 0 };
  claimed.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at) || String(a.id).localeCompare(String(b.id)));
  const events = new Map((await pool.query('SELECT id,event FROM bb_observability_events WHERE id=ANY($1)', [claimed.map(r => r.aggregate_id)])).rows.map(r => [r.id, r.event]));
  const records: LogRecord[] = claimed.filter(r => events.has(r.aggregate_id)).map(r => ({ delivery_key: digest(`${sink.name}:${r.id}`), outbox_id: r.id, event: events.get(r.aggregate_id) }));
  try {
    await sink.deliver(records);
  } catch {
    // Outage: release the lease with backoff; nothing is marked delivered, so the backlog replays.
    await pool.query("UPDATE bb_outbox SET lease_token=NULL,lease_until=NULL,last_delivery_error='sink_unavailable',next_attempt_at=now()+($3::integer*interval '1 second') WHERE id=ANY($1) AND lease_token=$2", [claimed.map(r => r.id), token, retry]);
    await raiseAlert(pool, { kind: 'log_sink_unavailable', severity: 'critical', scope: sink.name, detail: { sink: sink.name, batch: claimed.length } });
    return { claimed: claimed.length, delivered: 0, failed: claimed.length };
  }
  await options.afterSinkAccept?.();
  const byId = new Map(claimed.map(r => [r.id, r]));
  await transaction(pool, async client => {
    for (const record of records) await client.query('INSERT INTO bb_log_deliveries(outbox_id,sink,delivery_key,attempts) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [record.outbox_id, sink.name, record.delivery_key, byId.get(record.outbox_id).delivery_attempts]);
    await client.query('UPDATE bb_outbox SET delivered_at=now(),lease_token=NULL,lease_until=NULL,last_delivery_error=NULL,next_attempt_at=NULL WHERE id=ANY($1) AND lease_token=$2 AND delivered_at IS NULL', [claimed.map(r => r.id), token]);
  });
  return { claimed: claimed.length, delivered: records.length, failed: 0 };
}

/** Periodic health check: stale backlog and unresolved usage conflicts raise alerts. */
export async function checkLogHealth(pool: Pool, thresholds: { maxBacklogAgeSeconds: number } = { maxBacklogAgeSeconds: 300 }) {
  const backlog = (await pool.query("SELECT count(*)::int n, COALESCE(EXTRACT(EPOCH FROM now()-min(created_at)),0)::int age FROM bb_outbox WHERE aggregate_type='observability' AND delivered_at IS NULL")).rows[0];
  const conflicts = (await pool.query("SELECT count(*)::int n FROM bb_call_usage_effective WHERE usage_status='conflict'")).rows[0].n as number;
  const alerts: string[] = [];
  if (backlog.n > 0 && backlog.age > thresholds.maxBacklogAgeSeconds) alerts.push(await raiseAlert(pool, { kind: 'log_backlog_stale', severity: 'critical', scope: 'observability', detail: { backlog: backlog.n, oldest_age_seconds: backlog.age } }));
  if (conflicts > 0) alerts.push(await raiseAlert(pool, { kind: 'usage_conflict', severity: 'warning', scope: 'usage', detail: { attempts: conflicts } }));
  return { backlog: backlog.n as number, oldest_age_seconds: backlog.age as number, usage_conflicts: conflicts, alerts };
}

// ---------------------------------------------------------------- retention

export type LogRetentionPolicy = { contentRetentionDays: number; policyVersion?: string; batchSize?: number; now?: () => Date;
  /** #6: content of a user-deleted project is purged this many days after deletion (the storage purge window). */ deletedProjectPurgeDays?: number;
  /** Test/restore-verifier scope only. The CLI never sets it. */ ownerScope?: string[] };
export function retentionPolicyFromEnv(env = process.env): LogRetentionPolicy {
  const days = Number(env.BB_LOG_CONTENT_RETENTION_DAYS ?? '180');
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('BB_LOG_CONTENT_RETENTION_DAYS must be an integer from 1 to 3650');
  return { contentRetentionDays: days, policyVersion: env.BB_LOG_RETENTION_POLICY_VERSION ?? 'log_retention_v1' };
}
/**
 * Deletes prompt snapshot and provider-result bytes that are past retention (for terminal or
 * run-less content) or belong to a closed account. Metadata rows, hashes, attempts and usage stay;
 * a tombstone records the purge. Blob delete is idempotent, so a crash before the tombstone replays.
 */
export async function purgeLogContent(pool: Pool, blobs: PrivateBlobs, policy: LogRetentionPolicy) {
  const now = policy.now?.() ?? new Date(), batch = policy.batchSize ?? 100, version = policy.policyVersion ?? 'log_retention_v1';
  if (!Number.isInteger(policy.contentRetentionDays) || policy.contentRetentionDays < 1) throw new Error('Invalid retention policy');
  const cutoff = new Date(now.getTime() - policy.contentRetentionDays * 86_400_000);
  const deletedDays = policy.deletedProjectPurgeDays;
  if (deletedDays !== undefined && (!Number.isInteger(deletedDays) || deletedDays < 0)) throw new Error('Invalid deleted-project purge window');
  const deletedCutoff = deletedDays === undefined ? null : new Date(now.getTime() - deletedDays * 86_400_000);
  const due = (await pool.query(`
    SELECT * FROM (
      SELECT 'prompt_snapshot' kind,s.id,s.owner_user_id,s.project_id,s.object_key,s.created_at,
        CASE WHEN u.status='closed' OR p.deleted_at<$4 THEN 'user_deleted' ELSE 'retention_expired' END reason
      FROM bb_snapshot_refs s JOIN bb_users u ON u.id=s.owner_user_id LEFT JOIN bb_runs r ON r.id=s.run_id
      JOIN bb_projects p ON p.owner_user_id=s.owner_user_id AND p.id=s.project_id
      WHERE (u.status='closed' OR p.deleted_at<$4 OR (s.created_at<$1 AND (r.id IS NULL OR r.state IN ('succeeded','failed','cancelled','rejected'))))
      UNION ALL
      SELECT 'provider_result',p.id,p.owner_user_id,p.project_id,p.result_ref,p.created_at,
        CASE WHEN u.status='closed' OR pj.deleted_at<$4 THEN 'user_deleted' ELSE 'retention_expired' END
      FROM bb_provider_result_refs p JOIN bb_users u ON u.id=p.owner_user_id JOIN bb_runs r ON r.id=p.run_id
      JOIN bb_projects pj ON pj.owner_user_id=p.owner_user_id AND pj.id=p.project_id
      WHERE (u.status='closed' OR pj.deleted_at<$4 OR (p.created_at<$1 AND r.state IN ('succeeded','failed','cancelled','rejected')))
    ) c WHERE ($3::text[] IS NULL OR c.owner_user_id=ANY($3)) AND NOT EXISTS (SELECT 1 FROM bb_log_content_tombstones t WHERE t.content_kind=c.kind AND t.content_id=c.id)
    ORDER BY created_at,id LIMIT $2`, [cutoff, batch, policy.ownerScope ?? null, deletedCutoff])).rows;
  let purged = 0, failed = 0;
  for (const row of due) {
    try { await blobs.delete(row.object_key); }
    catch { failed++; await raiseAlert(pool, { kind: 'retention_purge_failed', severity: 'warning', scope: 'blob', detail: { content_kind: row.kind } }); continue; }
    await transaction(pool, async client => {
      const inserted = await client.query('INSERT INTO bb_log_content_tombstones(id,owner_user_id,content_kind,content_id,object_key,reason,policy_version) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id', [uid(), row.owner_user_id, row.kind, row.id, row.object_key, row.reason, version]);
      if (inserted.rowCount) await emitInternal(client, internalEvent({ kind: 'log.content_purged', owner: row.owner_user_id, projectId: row.project_id, traceId: row.id, stage: row.reason, promptSnapshotRef: row.kind === 'prompt_snapshot' ? row.id : null }));
    });
    purged++;
  }
  return { due: due.length, purged, failed };
}

// ---------------------------------------------------------------- operator access

export async function operatorRoles(db: Pool | PoolClient, userId: string) {
  const q = await db.query("SELECT g.role FROM bb_operator_grants g JOIN bb_users u ON u.id=g.user_id WHERE g.user_id=$1 AND g.revoked_at IS NULL AND u.status='active'", [userId]);
  return new Set(q.rows.map(r => r.role as OperatorRole));
}
export async function grantOperator(pool: Pool, input: { userId: string; role: OperatorRole; grantedBy: string; reasonCode: string }) {
  const id = uid();
  await pool.query('INSERT INTO bb_operator_grants(id,user_id,role,granted_by,reason_code) VALUES($1,$2,$3,$4,$5)', [id, input.userId, input.role, input.grantedBy, input.reasonCode]);
  return id;
}
export async function revokeOperator(pool: Pool, userId: string, role: OperatorRole) {
  await pool.query('UPDATE bb_operator_grants SET revoked_at=now() WHERE user_id=$1 AND role=$2 AND revoked_at IS NULL', [userId, role]);
}
async function audit(client: PoolClient, input: { actorId: string; role: OperatorRole; owner?: string | null; purpose: string; filter: unknown; target?: string; reason?: string }) {
  const id = uid();
  await client.query('INSERT INTO bb_log_access_audit(id,actor_id,owner_user_id,purpose,filter_hash,actor_role,target_ref,reason_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, input.actorId, input.owner ?? '*', input.purpose, digest(JSON.stringify(input.filter)), input.role, input.target ?? null, input.reason ?? null]);
  return id;
}

export type AdminFilter = { user_id?: string; project_id?: string; job_id?: string; trace_id?: string; from?: Date; to?: Date; model_id?: string; status?: string; error_code?: string; limit: number };
const invalid = () => new Problem(422, 'VALIDATION_FAILED', 'Invalid log filter');
/** Strict allow-list parsing; also the log-injection boundary for operator input. */
export function parseAdminFilter(query: Record<string, unknown>): AdminFilter {
  const result: AdminFilter = { limit: 100 };
  for (const [key, raw] of Object.entries(query ?? {})) {
    if (!(ADMIN_LOG_FILTERS as readonly string[]).includes(key) || typeof raw !== 'string' || raw.length > 128) throw invalid();
    if (['user_id', 'project_id', 'job_id', 'trace_id'].includes(key)) { if (!validId(raw)) throw invalid(); (result as any)[key] = raw; }
    else if (key === 'from' || key === 'to') { if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(raw) || Number.isNaN(Date.parse(raw))) throw invalid(); result[key] = new Date(raw); }
    else if (key === 'model_id') { if (!/^[A-Za-z0-9._-]{1,128}$/.test(raw)) throw invalid(); result.model_id = raw; }
    else if (key === 'status') { if (!safeCode.test(raw)) throw invalid(); result.status = raw; }
    else if (key === 'error_code') { if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(raw)) throw invalid(); result.error_code = raw; }
    else if (key === 'limit') { if (!/^[1-9][0-9]{0,2}$/.test(raw) || Number(raw) > ADMIN_LOG_PAGE_LIMIT) throw invalid(); result.limit = Number(raw); }
  }
  if (result.from && result.to && result.from > result.to) throw invalid();
  return result;
}
const filterArgs = (f: AdminFilter) => [f.user_id ?? null, f.project_id ?? null, f.job_id ?? null, f.trace_id ?? null, f.from ?? null, f.to ?? null, f.model_id ?? null, f.status ?? null, f.error_code ?? null];

export async function adminEvents(pool: Pool, actorId: string, filter: AdminFilter) {
  return transaction(pool, async client => {
    await audit(client, { actorId, role: 'log_reader', owner: filter.user_id, purpose: 'admin_events', filter });
    const q = await client.query(`SELECT e.id,e.owner_user_id,e.project_id,e.job_id,e.run_id,e.trace_id,e.kind,e.created_at,e.event FROM bb_observability_events e
      WHERE ($1::text IS NULL OR e.owner_user_id=$1) AND ($2::text IS NULL OR e.project_id=$2) AND ($3::text IS NULL OR e.job_id=$3) AND ($4::text IS NULL OR e.trace_id=$4)
        AND ($5::timestamptz IS NULL OR e.created_at>=$5) AND ($6::timestamptz IS NULL OR e.created_at<=$6)
        AND ($7::text IS NULL OR EXISTS (SELECT 1 FROM bb_model_call_attempts a WHERE a.job_id=e.job_id AND a.model_id=$7
             AND (e.event->>'logical_call_id' IS NULL OR (a.logical_call_id=e.event->>'logical_call_id' AND a.attempt_no=(e.event->>'attempt_no')::int))))
        AND ($8::text IS NULL OR e.event->>'status'=$8) AND ($9::text IS NULL OR e.event->'error'->>'code'=$9)
      ORDER BY e.created_at,e.id LIMIT $10`, [...filterArgs(filter), filter.limit + 1]);
    const rows = q.rows.slice(0, filter.limit);
    return { truncated: q.rows.length > filter.limit, items: rows.map(r => ({ event_id: r.id, kind: r.kind, occurred_at: iso(r.created_at)!, user_id: r.owner_user_id, project_id: r.project_id, job_id: r.job_id, run_id: r.run_id, trace_id: r.trace_id, actor_type: r.event.actor_type, status: r.event.status ?? null, stage: r.event.stage ?? null, error_code: r.event.error?.code ?? null, logical_call_id: r.event.logical_call_id ?? null, attempt_no: r.event.attempt_no ?? null, prompt_snapshot_ref: r.event.prompt_snapshot_ref ?? null })) };
  });
}

type UsageRow = { usage_status: string; call_status: string; attempt_no: number; input_tokens: number | null; output_tokens: number | null; cached_input_tokens: number | null; reasoning_tokens: number | null };
/** Sums measured attempts only. Unknown/pending/conflict count as unresolved and add no tokens. */
export function consumption(rows: UsageRow[]) {
  const measured = rows.filter(r => r.usage_status === 'measured');
  const sum = (field: 'input_tokens' | 'output_tokens' | 'cached_input_tokens' | 'reasoning_tokens') => {
    const values = measured.map(r => r[field]).filter((v): v is number => v !== null && v !== undefined);
    return values.length ? values.reduce((a, b) => a + Number(b), 0) : null;
  };
  return { attempts: rows.length, measured_attempts: measured.length, unresolved_attempts: rows.length - measured.length, input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'), cached_input_tokens: sum('cached_input_tokens'), reasoning_tokens: sum('reasoning_tokens') };
}
const terminal = ['succeeded', 'failed', 'cancelled', 'rejected'];

export async function adminJobTimeline(pool: Pool, actorId: string, jobId: string) {
  if (!validId(jobId)) throw missing();
  return transaction(pool, async client => {
    const job = (await client.query('SELECT j.*,COALESCE(j.project_id,r.project_id) effective_project_id,r.state run_state,r.artifact_id,r.artifact_version FROM bb_jobs j LEFT JOIN bb_runs r ON r.id=j.run_id WHERE j.id=$1', [jobId])).rows[0];
    await audit(client, { actorId, role: 'log_reader', owner: job?.owner_user_id, purpose: 'admin_job_timeline', filter: { jobId }, target: jobId });
    if (!job) throw missing();
    const prompts = (await client.query(`SELECT s.*,t.id tombstone FROM bb_snapshot_refs s LEFT JOIN bb_log_content_tombstones t ON t.content_kind='prompt_snapshot' AND t.content_id=s.id
      WHERE s.owner_user_id=$1 AND ((s.run_id IS NOT NULL AND s.run_id=$2) OR s.id IN (SELECT prompt_snapshot_id FROM bb_model_call_attempts WHERE job_id=$3)) ORDER BY s.created_at,s.id`, [job.owner_user_id, job.run_id, job.id])).rows;
    const stages = job.run_id
      ? (await client.query('SELECT seq,type,state,stage,payload,occurred_at FROM bb_run_events WHERE owner_user_id=$1 AND run_id=$2 ORDER BY seq', [job.owner_user_id, job.run_id])).rows.map(r => ({ seq: r.seq, type: r.type, state: r.state, stage: r.stage, reason: r.payload?.reason ?? null, occurred_at: iso(r.occurred_at)! }))
      : (await client.query("SELECT kind,event,created_at FROM bb_observability_events WHERE owner_user_id=$1 AND job_id=$2 AND kind='job.state_changed' ORDER BY created_at,id", [job.owner_user_id, job.id])).rows.map((r, i) => ({ seq: i + 1, type: r.kind, state: r.event.status ?? 'unknown', stage: r.event.stage ?? null, reason: null, occurred_at: iso(r.created_at)! }));
    const attemptRows = (await client.query(`SELECT a.id,a.logical_call_id,a.attempt_no,a.status,a.model_id,a.provider_request_id,a.prompt_snapshot_id,a.created_at,
        u.usage_status,u.input_tokens,u.output_tokens,u.cached_input_tokens,u.reasoning_tokens,u.correction_id,rt.duration_ms,
        COALESCE(rt.error_code,(SELECT o.error_code FROM bb_provider_call_observations o WHERE o.attempt_id=a.id ORDER BY o.observed_at DESC,o.id DESC LIMIT 1)) error_code
      FROM bb_model_call_attempts a JOIN bb_call_usage_effective u ON u.attempt_id=a.id LEFT JOIN bb_model_call_attempt_runtime rt ON rt.attempt_id=a.id
      WHERE a.owner_user_id=$1 AND a.job_id=$2 ORDER BY a.logical_call_id,a.attempt_no`, [job.owner_user_id, job.id])).rows;
    const errors = (await client.query('SELECT * FROM bb_observability_errors WHERE owner_user_id=$1 AND job_id=$2 ORDER BY created_at,id', [job.owner_user_id, job.id])).rows;
    const artifact = job.artifact_id ? (await client.query('SELECT * FROM bb_artifact_versions WHERE owner_user_id=$1 AND id=$2 AND version=$3', [job.owner_user_id, job.artifact_id, job.artifact_version])).rows[0] : null;
    const usageRows: UsageRow[] = attemptRows.map(a => ({ usage_status: a.usage_status, call_status: a.status, attempt_no: a.attempt_no, input_tokens: int(a.input_tokens), output_tokens: int(a.output_tokens), cached_input_tokens: int(a.cached_input_tokens), reasoning_tokens: int(a.reasoning_tokens) }));
    const state = job.run_state ?? job.state;
    const created = new Date(job.created_at), updated = new Date(job.updated_at);
    return {
      job: { job_id: job.id, user_id: job.owner_user_id, project_id: job.effective_project_id ?? null, run_id: job.run_id ?? null, trace_id: job.trace_id ?? job.run_id ?? null, job_type: job.job_type, subtype: job.subtype, state: job.state, stage: job.stage ?? null, attempts: job.attempts, error_code: job.error_code ?? null, created_at: created.toISOString(), updated_at: updated.toISOString(), duration_ms: terminal.includes(job.state) ? Math.max(0, updated.getTime() - created.getTime()) : null },
      prompts: prompts.map(s => ({ snapshot_id: s.id, kind: s.snapshot_kind, version: s.version, content_sha256: s.content_sha256.trim(), redaction_version: s.redaction_version, input_revision: s.input_revision, template_version: s.template_version, rule_pack_version: s.rule_pack_version, model_parameters_version: s.model_parameters_version, content_state: s.tombstone ? 'purged' : 'available', created_at: iso(s.created_at)! })),
      stages,
      attempts: attemptRows.map((a, i) => ({ attempt_id: a.id, logical_call_id: a.logical_call_id, attempt_no: a.attempt_no, status: a.status, model_id: a.model_id, provider_request_id: a.provider_request_id, prompt_snapshot_ref: a.prompt_snapshot_id, usage_status: a.usage_status, usage: { input_tokens: usageRows[i].input_tokens, output_tokens: usageRows[i].output_tokens, cached_input_tokens: usageRows[i].cached_input_tokens, reasoning_tokens: usageRows[i].reasoning_tokens }, corrected: !!a.correction_id, duration_ms: int(a.duration_ms), error_code: a.error_code ?? null, created_at: iso(a.created_at)! })),
      errors: errors.map(e => ({ error_id: e.id, code: e.code, category: e.category, stage: e.stage, attempt_id: e.attempt_id, retry_count: e.retry_count, fingerprint: e.fingerprint?.trim() ?? null, recovery_status: e.recovery_status, created_at: iso(e.created_at)! })),
      artifact: artifact ? { artifact_id: artifact.id, version: artifact.version, sha256: artifact.sha256.trim(), quality_status: artifact.quality_status, delivery_status: artifact.delivery_status, created_at: iso(artifact.created_at)! } : null,
      outcome: { state, error_code: job.error_code ?? errors.at(-1)?.code ?? null, artifact_available: !!artifact && artifact.quality_status === 'passed' && artifact.delivery_status === 'available' },
      consumption: { all_attempts: consumption(usageRows), completed_attempts: consumption(usageRows.filter(r => r.call_status === 'completed')) }
    };
  });
}

export async function adminMetrics(pool: Pool, actorId: string, filter: AdminFilter) {
  return transaction(pool, async client => {
    await audit(client, { actorId, role: 'log_reader', owner: filter.user_id, purpose: 'admin_metrics', filter });
    const args = filterArgs(filter);
    // Scope: jobs created in the window. status filters the job state; error_code the job or its error records.
    const scope = `WITH scoped AS (SELECT j.* FROM bb_jobs j LEFT JOIN bb_runs r ON r.id=j.run_id
      WHERE ($1::text IS NULL OR j.owner_user_id=$1) AND ($2::text IS NULL OR COALESCE(j.project_id,r.project_id)=$2) AND ($3::text IS NULL OR j.id=$3)
        AND ($4::text IS NULL OR COALESCE(j.trace_id,j.run_id)=$4) AND ($5::timestamptz IS NULL OR j.created_at>=$5) AND ($6::timestamptz IS NULL OR j.created_at<=$6)
        AND ($7::text IS NULL OR EXISTS (SELECT 1 FROM bb_model_call_attempts a WHERE a.job_id=j.id AND a.model_id=$7))
        AND ($8::text IS NULL OR j.state=$8)
        AND ($9::text IS NULL OR j.error_code=$9 OR EXISTS (SELECT 1 FROM bb_observability_errors e WHERE e.job_id=j.id AND e.code=$9)))`;
    const jobs = (await client.query(`${scope} SELECT count(*)::int total, count(*) FILTER (WHERE state='succeeded')::int succeeded, count(*) FILTER (WHERE state='failed')::int failed,
        count(*) FILTER (WHERE state='cancelled')::int cancelled,
        avg(EXTRACT(EPOCH FROM updated_at-created_at)*1000) FILTER (WHERE state IN ('succeeded','failed','cancelled')) avg_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM updated_at-created_at)*1000) FILTER (WHERE state IN ('succeeded','failed','cancelled')) p95_ms FROM scoped`, args)).rows[0];
    const attempts = (await client.query(`${scope} SELECT a.id,a.model_id,a.status call_status,a.attempt_no,u.usage_status,u.input_tokens,u.output_tokens,u.cached_input_tokens,u.reasoning_tokens,rt.duration_ms
        FROM scoped j JOIN bb_model_call_attempts a ON a.job_id=j.id JOIN bb_call_usage_effective u ON u.attempt_id=a.id LEFT JOIN bb_model_call_attempt_runtime rt ON rt.attempt_id=a.id
        WHERE ($7::text IS NULL OR a.model_id=$7)`, args)).rows.map(a => ({ ...a, input_tokens: int(a.input_tokens), output_tokens: int(a.output_tokens), cached_input_tokens: int(a.cached_input_tokens), reasoning_tokens: int(a.reasoning_tokens) }));
    const errors = (await client.query(`${scope} SELECT e.code error_code,count(*)::int count FROM scoped j JOIN bb_observability_errors e ON e.job_id=j.id GROUP BY e.code ORDER BY count DESC,e.code`, args)).rows;
    const operations = (await client.query(`SELECT count(*) FILTER (WHERE status='submitted')::int submitted, count(*) FILTER (WHERE status='rejected')::int rejected FROM bb_operations o
        WHERE ($1::text IS NULL OR o.owner_user_id=$1) AND ($2::text IS NULL OR o.project_id=$2) AND ($3::text IS NULL OR o.trace_id=$3)
          AND ($4::timestamptz IS NULL OR o.created_at>=$4) AND ($5::timestamptz IS NULL OR o.created_at<=$5) AND ($6::text IS NULL OR o.error_code=$6)`, [filter.user_id ?? null, filter.project_id ?? null, filter.trace_id ?? null, filter.from ?? null, filter.to ?? null, filter.error_code ?? null])).rows[0];
    const finished = jobs.succeeded + jobs.failed + jobs.cancelled;
    const durations = attempts.map(a => a.duration_ms).filter(v => v !== null).map(Number);
    const models = new Map<string | null, typeof attempts>();
    for (const a of attempts) models.set(a.model_id, [...(models.get(a.model_id) ?? []), a]);
    return {
      window: { from: iso(filter.from), to: iso(filter.to) },
      operations: { submitted: operations.submitted, rejected: operations.rejected },
      jobs: { total: jobs.total, succeeded: jobs.succeeded, failed: jobs.failed, cancelled: jobs.cancelled, other: jobs.total - finished, success_rate: finished ? jobs.succeeded / finished : null, failure_rate: finished ? jobs.failed / finished : null, duration_ms_avg: jobs.avg_ms === null ? null : Number(jobs.avg_ms), duration_ms_p95: jobs.p95_ms === null ? null : Number(jobs.p95_ms) },
      attempts: { total: attempts.length, completed: attempts.filter(a => a.call_status === 'completed').length, failed: attempts.filter(a => a.call_status === 'failed').length, pending_reconcile: attempts.filter(a => a.call_status === 'pending_reconcile').length, confirmed_not_sent: attempts.filter(a => a.call_status === 'confirmed_not_sent').length, conflict: attempts.filter(a => a.usage_status === 'conflict').length, duration_ms_avg: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null },
      consumption: { all_attempts: consumption(attempts), completed_attempts: consumption(attempts.filter(a => a.call_status === 'completed')), retry_attempts: consumption(attempts.filter(a => a.attempt_no > 1)) },
      by_model: [...models].map(([model_id, rows]) => { const c = consumption(rows); return { model_id, attempts: rows.length, completed: rows.filter(a => a.call_status === 'completed').length, failed: rows.filter(a => a.call_status === 'failed').length, input_tokens: c.input_tokens, output_tokens: c.output_tokens, cached_input_tokens: c.cached_input_tokens, reasoning_tokens: c.reasoning_tokens }; }),
      errors
    };
  });
}

/** Plaintext is only returned after the audit row commits; a purged or foreign-looking ref is 404. */
export async function adminPromptView(pool: Pool, blobs: PrivateBlobs, actorId: string, snapshotId: string, reasonCode: string) {
  if (!validId(snapshotId)) throw missing();
  if (!safeCode.test(reasonCode)) throw new Problem(422, 'VALIDATION_FAILED', 'reason_code is required');
  const { snapshot, auditId } = await transaction(pool, async client => {
    const snapshot = (await client.query("SELECT s.*,t.id tombstone FROM bb_snapshot_refs s LEFT JOIN bb_log_content_tombstones t ON t.content_kind='prompt_snapshot' AND t.content_id=s.id WHERE s.id=$1", [snapshotId])).rows[0];
    const auditId = await audit(client, { actorId, role: 'prompt_viewer', owner: snapshot?.owner_user_id, purpose: 'prompt_view', filter: { snapshotId }, target: snapshotId, reason: reasonCode });
    return { snapshot, auditId };
  });
  if (!snapshot || snapshot.tombstone) throw missing();
  const bytes = await blobs.getIfExistsBounded(snapshot.object_key, 10 * 1024 * 1024);
  if (!bytes || digest(bytes) !== snapshot.content_sha256.trim()) throw missing();
  return { snapshot_id: snapshot.id, user_id: snapshot.owner_user_id, project_id: snapshot.project_id, kind: snapshot.snapshot_kind, version: snapshot.version, content_sha256: snapshot.content_sha256.trim(), redaction_version: snapshot.redaction_version, media_type: 'text/plain; charset=utf-8' as const, body: bytes.toString('utf8'), audit_id: auditId };
}

export async function adminAlerts(pool: Pool, actorId: string) {
  return transaction(pool, async client => {
    await audit(client, { actorId, role: 'log_reader', purpose: 'admin_alerts', filter: {} });
    const q = await client.query('SELECT a.*,k.acked_at FROM bb_ops_alerts a LEFT JOIN bb_ops_alert_acks k ON k.alert_id=a.id ORDER BY a.created_at DESC,a.id LIMIT 200');
    return { items: q.rows.map(a => ({ alert_id: a.id, kind: a.kind, severity: a.severity, detail: a.detail, created_at: iso(a.created_at)!, acked_at: iso(a.acked_at) })) };
  });
}

/** Append a correction for one supplier attempt; the raw observations stay untouched. */
export async function correctUsage(pool: Pool, actorId: string, attemptId: string, input: { chosen_observation_id: string | null; usage_status: 'measured' | 'unknown'; reason_code: string }) {
  if (!validId(attemptId)) throw missing();
  if (!safeCode.test(input.reason_code) || (input.usage_status === 'measured') !== (input.chosen_observation_id !== null) || (input.chosen_observation_id !== null && !validId(input.chosen_observation_id))) throw new Problem(422, 'VALIDATION_FAILED', 'A measured correction must choose one observation; unknown must not');
  return transaction(pool, async client => {
    const a = (await client.query('SELECT a.*,j.run_id,COALESCE(j.project_id,r.project_id) project_id FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id LEFT JOIN bb_runs r ON r.id=j.run_id WHERE a.id=$1 FOR UPDATE OF a', [attemptId])).rows[0];
    await audit(client, { actorId, role: 'log_operator', owner: a?.owner_user_id, purpose: 'usage_correction', filter: input, target: attemptId, reason: input.reason_code });
    if (!a) throw missing();
    let counts: Array<number | null> = [null, null, null, null];
    if (input.chosen_observation_id) {
      const o = (await client.query("SELECT * FROM bb_usage_observations WHERE id=$1 AND attempt_id=$2 AND usage_status='measured'", [input.chosen_observation_id, attemptId])).rows[0];
      if (!o) throw new Problem(409, 'IDEMPOTENCY_CONFLICT', 'Chosen observation is not a measured observation of this attempt');
      counts = [o.input_tokens, o.output_tokens, o.cached_input_tokens, o.reasoning_tokens];
    }
    const id = uid();
    await client.query('INSERT INTO bb_usage_corrections(id,owner_user_id,attempt_id,chosen_observation_id,usage_status,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,reason_code,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [id, a.owner_user_id, attemptId, input.chosen_observation_id, input.usage_status, ...counts, input.reason_code, actorId]);
    await emitInternal(client, internalEvent({ kind: 'model.usage_corrected', owner: a.owner_user_id, actorType: 'operator', projectId: a.project_id, runId: a.run_id, jobId: a.job_id, traceId: a.run_id ?? a.job_id, logicalCallId: a.logical_call_id, attemptNo: a.attempt_no, usage: { status: input.usage_status === 'measured' ? 'reported' : 'unavailable', input_tokens: counts[0], output_tokens: counts[1], cached_input_tokens: counts[2], reasoning_tokens: counts[3], evidence_ref: input.chosen_observation_id } }));
    return { correction_id: id, attempt_id: attemptId, usage_status: input.usage_status, usage: { input_tokens: counts[0], output_tokens: counts[1], cached_input_tokens: counts[2], reasoning_tokens: counts[3] } };
  });
}

// ---------------------------------------------------------------- CLI

// node dist/log-ops.js forward|health|retention — one bounded batch per invocation (cron/systemd timer).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
    if (command === 'forward') {
      if (!process.env.BB_LOG_SINK_FILE) throw new Error('BB_LOG_SINK_FILE required');
      process.stdout.write(`${JSON.stringify(await forwardLogs(pool, ndjsonFileSink(process.env.BB_LOG_SINK_FILE)))}\n`);
    } else if (command === 'health') {
      process.stdout.write(`${JSON.stringify(await checkLogHealth(pool, { maxBacklogAgeSeconds: Number(process.env.BB_LOG_BACKLOG_ALERT_SECONDS ?? '300') }))}\n`);
    } else if (command === 'retention') {
      if (!process.env.AZURE_STORAGE_CONNECTION_STRING) throw new Error('AZURE_STORAGE_CONNECTION_STRING required');
      process.stdout.write(`${JSON.stringify(await purgeLogContent(pool, azureBlobs(process.env.AZURE_STORAGE_CONNECTION_STRING), retentionPolicyFromEnv()))}\n`);
    } else throw new Error('usage: log-ops forward|health|retention');
  } catch (error) { process.stderr.write(`log-ops failed: ${error instanceof Error ? error.message : 'unknown'}\n`); process.exitCode = 1; }
  finally { await pool.end(); }
}
