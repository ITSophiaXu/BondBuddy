import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { BROWSER_ERROR_LIMIT, schemas, type BrowserErrorReportRequest } from '@bondbuddy/contracts';
import { digest, missing, Problem, transaction, uid } from './data.js';
import { emitInternal, internalEvent, recordOperation } from './observability.js';
import { scrubSecrets } from './log-ops.js';
import { operatorRoles } from './log-ops.js';

const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const safeMessage = (value: string | undefined) => {
  if (value === undefined) return null;
  // Browser preprocessing is a courtesy; the server is the privacy boundary.
  const scrubbed = scrubSecrets(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, '[REDACTED_PHONE]');
  return Buffer.from(scrubbed, 'utf8').subarray(0, 1024).toString('utf8');
};
const view = (row: Record<string, any>) => ({ report_id: row.id, error_type: row.error_type,
  fingerprint: row.fingerprint.trim(), message: row.safe_message, route_id: row.route_id,
  frontend_version: row.frontend_version, project_id: row.project_id, job_id: row.job_id,
  client_time: new Date(row.client_time).toISOString(), received_at: new Date(row.received_at).toISOString() });

export function installBrowserErrorRoutes(app: FastifyInstance, deps: {
  db: () => Pool; owner: (request: FastifyRequest) => Promise<string>;
  sessionId: (request: FastifyRequest) => Promise<string>;
}) {
  app.post('/api/v1/browser-errors', { bodyLimit: BROWSER_ERROR_LIMIT.bodyBytes,
    schema: { body: schemas.BrowserErrorReportRequest, response: { 201: schemas.BrowserErrorReportResponse } }
  }, async (request, reply) => {
    const owner = await deps.owner(request);
    const sessionId = await deps.sessionId(request);
    const b = request.body as BrowserErrorReportRequest;
    if (Buffer.byteLength(JSON.stringify(b), 'utf8') > BROWSER_ERROR_LIMIT.bodyBytes ||
        !Number.isFinite(Date.parse(b.client_time)) ||
        /(?:\d{7,}|[a-f0-9]{20,})/i.test(b.route_id) || scrubSecrets(b.route_id) !== b.route_id)
      throw new Problem(422, 'VALIDATION_FAILED', 'Browser diagnostic is invalid');
    let message: string | null;
    try { message = safeMessage(b.message); }
    catch { throw new Problem(422, 'VALIDATION_FAILED', 'Browser diagnostic is invalid'); }
    const result = await transaction(deps.db(), async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`browser-error:${owner}`]);
      let projectId = b.project_id ?? null;
      if (projectId) {
        const project = await client.query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL', [owner, projectId]);
        if (!project.rowCount) throw missing();
      }
      if (b.job_id) {
        const job = await client.query(`SELECT COALESCE(j.project_id,r.project_id) AS project_id FROM bb_jobs j
          LEFT JOIN bb_runs r ON r.owner_user_id=j.owner_user_id AND r.id=j.run_id
          WHERE j.owner_user_id=$1 AND j.id=$2`, [owner, b.job_id]);
        if (!job.rowCount || (projectId && projectId !== job.rows[0].project_id)) throw missing();
        projectId = job.rows[0].project_id;
      }
      const sessionHash = digest(sessionId);
      const prior = await client.query(`SELECT id,received_at FROM bb_browser_error_reports
        WHERE owner_user_id=$1 AND session_hash=$2 AND fingerprint=$3 AND received_at>now()-interval '5 minutes'
        ORDER BY received_at DESC LIMIT 1`, [owner, sessionHash, b.fingerprint]);
      if (prior.rowCount) return { report_id: prior.rows[0].id, deduplicated: true, received_at: new Date(prior.rows[0].received_at).toISOString() };
      const count = await client.query("SELECT count(*)::int n FROM bb_browser_error_reports WHERE owner_user_id=$1 AND received_at>now()-interval '5 minutes'", [owner]);
      if (count.rows[0].n >= BROWSER_ERROR_LIMIT.perUser) throw new Problem(429, 'RATE_LIMITED', 'Browser diagnostic rate limit reached');
      const id = uid(), bucket = Math.floor(Date.now() / (BROWSER_ERROR_LIMIT.windowSeconds * 1000));
      const key = digest(`${owner}:${sessionHash}:${b.fingerprint}:${bucket}`);
      const inserted = await client.query(`INSERT INTO bb_browser_error_reports
        (id,owner_user_id,project_id,job_id,session_hash,dedupe_key,fingerprint,error_type,safe_message,route_id,frontend_version,client_time)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING received_at`,
      [id, owner, projectId, b.job_id ?? null, sessionHash, key, b.fingerprint, b.error_type, message, b.route_id, b.frontend_version, b.client_time]);
      const operationId = await recordOperation(client, { owner, projectId, jobId: b.job_id,
        requestId: request.id, traceId: request.id, kind: 'browser_error_report', status: 'submitted' });
      await client.query(`INSERT INTO bb_observability_errors
        (id,owner_user_id,project_id,operation_id,job_id,trace_id,code,category,stage,fingerprint,safe_message_code)
        VALUES($1,$2,$3,$4,$5,$6,'BROWSER_ERROR_REPORTED','internal','browser',$7,'browser_error')`,
      [id, owner, projectId, operationId, b.job_id ?? null, request.id, b.fingerprint]);
      await emitInternal(client, internalEvent({ kind: 'error.recorded', owner, actorType: 'user', projectId,
        jobId: b.job_id, traceId: request.id, operationId, requestId: request.id, stage: 'browser',
        error: { error_id: id, code: 'BROWSER_ERROR_REPORTED', category: 'internal', retryable: false } }));
      return { report_id: id, deduplicated: false, received_at: new Date(inserted.rows[0].received_at).toISOString() };
    });
    return reply.header('cache-control', 'no-store').code(201).send(result);
  });
  app.get('/api/v1/browser-errors/:report_id', { schema: { response: { 200: schemas.BrowserErrorReportView } } }, async (request, reply) => {
    const owner = await deps.owner(request);
    const id = (request.params as Record<string, unknown>).report_id;
    if (!validId(id)) throw missing();
    const row = await deps.db().query('SELECT * FROM bb_browser_error_reports WHERE owner_user_id=$1 AND id=$2', [owner, id]);
    if (!row.rowCount) throw missing();
    return reply.header('cache-control', 'no-store').send(view(row.rows[0]));
  });
  app.get('/api/v1/admin/browser-errors/:report_id', { schema: { response: { 200: schemas.BrowserErrorReportView } } }, async (request, reply) => {
    const actor = await deps.owner(request);
    if (!(await operatorRoles(deps.db(), actor)).has('log_reader')) throw missing();
    const id = (request.params as Record<string, unknown>).report_id;
    if (!validId(id)) throw missing();
    const detail = await transaction(deps.db(), async client => {
      const row = await client.query('SELECT * FROM bb_browser_error_reports WHERE id=$1', [id]);
      const auditId = uid();
      await client.query(`INSERT INTO bb_log_access_audit(id,actor_id,owner_user_id,purpose,filter_hash,actor_role,target_ref,reason_code)
        VALUES($1,$2,$3,'browser_error_view',$4,'log_reader',$5,'browser_error_view')`,
      [auditId, actor, row.rows[0]?.owner_user_id ?? '*', digest(id), id]);
      if (!row.rowCount) throw missing();
      return view(row.rows[0]);
    });
    return reply.header('cache-control', 'no-store').send(detail);
  });
}

export async function purgeBrowserErrorContent(pool: Pool, retentionDays: number, now = new Date(), ownerScope?: string) {
  if (!Number.isInteger(retentionDays) || retentionDays < 0) throw new Error('Invalid browser diagnostic retention');
  return transaction(pool, async client => {
    const due = await client.query(`SELECT b.id,b.owner_user_id,b.project_id,b.job_id,
      CASE WHEN u.status='closed' OR p.deleted_at IS NOT NULL THEN 'user_deleted' ELSE 'retention_expired' END AS reason
      FROM bb_browser_error_reports b JOIN bb_users u ON u.id=b.owner_user_id
      LEFT JOIN bb_projects p ON p.id=b.project_id AND p.owner_user_id=b.owner_user_id
      WHERE b.purged_at IS NULL AND ($3::text IS NULL OR b.owner_user_id=$3)
        AND (b.received_at + ($1::int * interval '1 day') <= $2 OR u.status='closed' OR p.deleted_at IS NOT NULL)
      ORDER BY b.received_at,b.id LIMIT 100 FOR UPDATE OF b SKIP LOCKED`, [retentionDays, now, ownerScope ?? null]);
    for (const row of due.rows) {
      await client.query('UPDATE bb_browser_error_reports SET safe_message=NULL,purged_at=$2 WHERE id=$1', [row.id, now]);
      await emitInternal(client, internalEvent({ kind: 'log.content_purged', owner: row.owner_user_id,
        projectId: row.project_id, jobId: row.job_id, traceId: row.id, stage: row.reason }));
    }
    return due.rowCount ?? 0;
  });
}
