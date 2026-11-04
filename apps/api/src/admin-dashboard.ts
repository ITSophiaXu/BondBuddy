import type {FastifyInstance, FastifyRequest} from 'fastify';
import type {Pool, PoolClient} from 'pg';
import {RUN_STATES, schemas, type RunState} from '@bondbuddy/contracts';
import {missing, Problem, transaction} from './data.js';
import {audit, operatorRoles} from './log-ops.js';

// #448 operator-only dashboard. Every route is read-only, deny-by-default and audited.
// Aggregates are computed from the append-only ledger/credit sources; no new tables.
type Deps = {db:()=>Pool; owner:(request:FastifyRequest)=>Promise<string>};

const RANGE_KEYS = ['from','to','user_id','state','cursor','limit'] as const;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const COST = /^(0|[1-9][0-9]{0,17})(?:\.[0-9]{1,10})?$/;

export type DashboardCursor = {createdAt: Date; id: string};
export type DashboardFilter = {
  from: Date | null;
  to: Date | null;
  userId: string | null;
  state: RunState | null;
  cursor: DashboardCursor | null;
  limit: number;
};

/** Only the last four digits may leave the API. Anything shorter is treated as absent. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 4 ? `****${digits.slice(-4)}` : null;
}

/** Costs keep the ledger's exact ten-decimal scale; no floating-point JSON numbers. */
export function dashboardCostText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !COST.test(value)) throw new Error('Unexpected platform cost decimal');
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(10, '0')}`;
}

const invalid = () => new Problem(422, 'VALIDATION_FAILED', 'Invalid dashboard filter');
const iso = (value: Date | string | null | undefined) => value ? new Date(value).toISOString() : null;
const integer = (value: unknown) => value === null || value === undefined ? 0 : Number(value);
const points = (value: unknown) => value === null || value === undefined ? '0' : String(value);
const stateCounts = (value: unknown) => Array.isArray(value)
  ? value.map(entry => ({state: (entry as {state: RunState}).state, count: Number((entry as {count: unknown}).count ?? 0)}))
  : [];

const cursorKey = (kind: 'users' | 'tasks') => kind;

export function encodeDashboardCursor(kind: 'users' | 'tasks', cursor: DashboardCursor): string {
  return Buffer.from(JSON.stringify({k: cursorKey(kind), t: cursor.createdAt.toISOString(), id: cursor.id}), 'utf8').toString('base64url');
}

export function decodeDashboardCursor(kind: 'users' | 'tasks', raw: string): DashboardCursor {
  if (!CURSOR.test(raw)) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
  const value = parsed as Record<string, unknown>;
  if (value.k !== cursorKey(kind) || typeof value.t !== 'string' || typeof value.id !== 'string') throw invalid();
  if (!DATETIME.test(value.t) || Number.isNaN(Date.parse(value.t)) || !ID.test(value.id)) throw invalid();
  return {createdAt: new Date(value.t), id: value.id};
}

function parseDay(raw: string, boundary: 'start' | 'end') {
  if (!DATE.test(raw)) throw invalid();
  const parsed = new Date(`${raw}T${boundary === 'start' ? '00:00:00.000' : '23:59:59.999'}Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) throw invalid();
  return parsed;
}

function parseTime(raw: string, boundary: 'start' | 'end') {
  if (DATE.test(raw)) return parseDay(raw, boundary);
  if (!DATETIME.test(raw) || Number.isNaN(Date.parse(raw))) throw invalid();
  return new Date(raw);
}

/** Strict allow-list parsing; operator input never becomes SQL text. */
export function parseDashboardFilter(query: Record<string, unknown> | undefined, kind: 'users' | 'tasks' = 'tasks'): DashboardFilter {
  const result: DashboardFilter = {from: null, to: null, userId: null, state: null, cursor: null, limit: DEFAULT_LIMIT};
  for (const [key, raw] of Object.entries(query ?? {})) {
    if (!(RANGE_KEYS as readonly string[]).includes(key) || typeof raw !== 'string' || raw.length > 512) throw invalid();
    if (key === 'from' || key === 'to') result[key] = parseTime(raw, key === 'from' ? 'start' : 'end');
    else if (key === 'user_id') { if (!ID.test(raw)) throw invalid(); result.userId = raw; }
    else if (key === 'state') { if (!(RUN_STATES as readonly string[]).includes(raw)) throw invalid(); result.state = raw as RunState; }
    else if (key === 'cursor') result.cursor = decodeDashboardCursor(kind, raw);
    else if (key === 'limit') {
      if (!/^[1-9][0-9]{0,2}$/.test(raw) || Number(raw) > MAX_LIMIT) throw invalid();
      result.limit = Number(raw);
    }
  }
  if (result.from && result.to && result.from > result.to) throw invalid();
  return result;
}

// Shared filter arguments: $1 from, $2 to, $3 state, $4 user_id.
const filterArgs = (filter: DashboardFilter) => [filter.from, filter.to, filter.state, filter.userId];

function pageOf<T>(rows: T[], limit: number, kind: 'users' | 'tasks', at: (row: T) => DashboardCursor) {
  const items = rows.slice(0, limit);
  const next = rows.length > limit ? encodeDashboardCursor(kind, at(items[items.length - 1]!)) : null;
  return {items, next_cursor: next};
}

const userRow = (row: any) => ({
  user_id: row.user_id,
  phone_masked: maskPhone(row.phone_e164),
  status: row.status,
  created_at: iso(row.created_at)!,
  projects: integer(row.projects),
  runs: integer(row.runs),
  runs_by_state: stateCounts(row.runs_by_state),
  last_run_at: iso(row.last_run_at),
  model_attempts: integer(row.model_attempts),
  input_tokens: integer(row.input_tokens),
  output_tokens: integer(row.output_tokens),
  cost_amount: dashboardCostText(row.cost_amount),
  currency: row.currency ?? null,
  credit_settled_points: points(row.credit_settled_points)
});

const taskRow = (row: any) => ({
  run_id: row.run_id,
  user_id: row.user_id,
  phone_masked: maskPhone(row.phone_e164),
  project_id: row.project_id,
  project_name: row.project_name,
  task_kind: row.task_kind,
  state: row.state,
  stage: row.stage ?? null,
  created_at: iso(row.created_at)!,
  updated_at: iso(row.updated_at)!,
  duration_ms: row.duration_ms === null || row.duration_ms === undefined ? null : integer(row.duration_ms),
  model_attempts: integer(row.model_attempts),
  input_tokens: integer(row.input_tokens),
  output_tokens: integer(row.output_tokens),
  cost_amount: dashboardCostText(row.cost_amount),
  currency: row.currency ?? null,
  pricing_status: row.pricing_status ?? null,
  last_error_code: row.last_error_code ?? null,
  credit_settled_points: points(row.credit_settled_points),
  latest_attempt_id: row.latest_attempt_id ?? null,
  exec_log_available: row.latest_attempt_id !== null && row.latest_attempt_id !== undefined
});

async function auditRead(client: PoolClient, actorId: string, purpose: string, filter: DashboardFilter) {
  return audit(client, {actorId, role: 'log_reader', owner: filter.userId, purpose, filter});
}

export async function adminDashboardOverview(pool: Pool, actorId: string, filter: DashboardFilter) {
  return transaction(pool, async client => {
    await auditRead(client, actorId, 'admin_dashboard_overview', filter);
    const users = await client.query('SELECT count(*)::int AS n FROM bb_users');
    const projects = await client.query('SELECT count(*)::int AS n FROM bb_projects WHERE deleted_at IS NULL');
    const tasks = await client.query(`SELECT r.state,count(*)::int AS n FROM bb_runs r
      WHERE ($1::timestamptz IS NULL OR r.created_at>=$1)
        AND ($2::timestamptz IS NULL OR r.created_at<=$2)
        AND ($3::text IS NULL OR r.state=$3)
        AND ($4::text IS NULL OR r.owner_user_id=$4)
      GROUP BY r.state ORDER BY r.state`, filterArgs(filter));
    const usage = await client.query(`SELECT count(*)::int AS model_attempts,
        COALESCE(sum(l.input_tokens),0)::text AS input_tokens,
        COALESCE(sum(l.output_tokens),0)::text AS output_tokens,
        sum(l.cost_amount)::text AS cost_amount,
        CASE WHEN count(DISTINCT l.currency) FILTER (WHERE l.currency IS NOT NULL)=1 THEN min(l.currency) END AS currency
      FROM bb_platform_cost_ledger l
      JOIN bb_runs r ON r.id=l.run_id AND r.owner_user_id=l.owner_user_id
      WHERE ($1::timestamptz IS NULL OR r.created_at>=$1)
        AND ($2::timestamptz IS NULL OR r.created_at<=$2)
        AND ($3::text IS NULL OR r.state=$3)
        AND ($4::text IS NULL OR r.owner_user_id=$4)`, filterArgs(filter));
    const credits = await client.query(`SELECT COALESCE(sum(e.points),0)::text AS credit_settled_points
      FROM bb_credit_events e
      JOIN bb_runs r ON r.id=e.run_id AND r.owner_user_id=e.owner_user_id
      WHERE e.kind='settle'
        AND ($1::timestamptz IS NULL OR r.created_at>=$1)
        AND ($2::timestamptz IS NULL OR r.created_at<=$2)
        AND ($3::text IS NULL OR r.state=$3)
        AND ($4::text IS NULL OR r.owner_user_id=$4)`, filterArgs(filter));
    const dailyUsage = await client.query(`SELECT to_char(date_trunc('day', r.created_at),'YYYY-MM-DD') AS date,
        count(DISTINCT r.id)::int AS tasks,
        COALESCE(sum(l.input_tokens),0)::text AS input_tokens,
        COALESCE(sum(l.output_tokens),0)::text AS output_tokens,
        sum(l.cost_amount)::text AS cost_amount,
        CASE WHEN count(DISTINCT l.currency) FILTER (WHERE l.currency IS NOT NULL)=1 THEN min(l.currency) END AS currency
      FROM bb_runs r
      LEFT JOIN bb_platform_cost_ledger l ON l.owner_user_id=r.owner_user_id AND l.run_id=r.id
      WHERE r.created_at >= COALESCE($1::timestamptz, now()-interval '14 days')
        AND ($2::timestamptz IS NULL OR r.created_at<=$2)
        AND ($3::text IS NULL OR r.state=$3)
        AND ($4::text IS NULL OR r.owner_user_id=$4)
      GROUP BY 1 ORDER BY 1`, filterArgs(filter));
    const dailyCredits = await client.query(`SELECT to_char(date_trunc('day', r.created_at),'YYYY-MM-DD') AS date,
        COALESCE(sum(e.points),0)::text AS points
      FROM bb_credit_events e
      JOIN bb_runs r ON r.id=e.run_id AND r.owner_user_id=e.owner_user_id
      WHERE e.kind='settle'
        AND r.created_at >= COALESCE($1::timestamptz, now()-interval '14 days')
        AND ($2::timestamptz IS NULL OR r.created_at<=$2)
        AND ($3::text IS NULL OR r.state=$3)
        AND ($4::text IS NULL OR r.owner_user_id=$4)
      GROUP BY 1`, filterArgs(filter));
    const creditByDay = new Map(dailyCredits.rows.map(row => [row.date as string, String(row.points)]));
    const daily = dailyUsage.rows.map(row => ({
      date: row.date as string,
      tasks: integer(row.tasks),
      input_tokens: integer(row.input_tokens),
      output_tokens: integer(row.output_tokens),
      cost_amount: dashboardCostText(row.cost_amount),
      currency: row.currency ?? null,
      credit_settled_points: points(creditByDay.get(row.date as string) ?? '0')
    }));
    const use = usage.rows[0] ?? {};
    return {
      range: {from: iso(filter.from), to: iso(filter.to)},
      users: integer(users.rows[0]?.n),
      projects: integer(projects.rows[0]?.n),
      tasks: tasks.rows.reduce((sum, row) => sum + integer(row.n), 0),
      tasks_by_state: tasks.rows.map(row => ({state: row.state as RunState, count: integer(row.n)})),
      model_attempts: integer(use.model_attempts),
      input_tokens: integer(use.input_tokens),
      output_tokens: integer(use.output_tokens),
      cost_amount: dashboardCostText(use.cost_amount),
      currency: use.currency ?? null,
      credit_settled_points: points(credits.rows[0]?.credit_settled_points),
      daily
    };
  });
}

export async function adminDashboardUsers(pool: Pool, actorId: string, filter: DashboardFilter) {
  return transaction(pool, async client => {
    await auditRead(client, actorId, 'admin_dashboard_users', filter);
    const rows = (await client.query(`SELECT u.id AS user_id,u.phone_e164,u.status,u.created_at,
        COALESCE(projects.n,0)::int AS projects,
        COALESCE(runs.runs,0)::int AS runs,runs.runs_by_state,runs.last_run_at,
        usage.model_attempts,usage.input_tokens,usage.output_tokens,usage.cost_amount,usage.currency,
        credits.credit_settled_points
      FROM bb_users u
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n FROM bb_projects p WHERE p.owner_user_id=u.id AND p.deleted_at IS NULL
      ) projects ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(sum(s.n),0)::int AS runs,max(s.updated_at) AS last_run_at,
          COALESCE(json_agg(json_build_object('state',s.state,'count',s.n) ORDER BY s.state) FILTER (WHERE s.state IS NOT NULL),'[]'::json) AS runs_by_state
        FROM (
          SELECT r.state,count(*)::int AS n,max(r.updated_at) AS updated_at
          FROM bb_runs r
          WHERE r.owner_user_id=u.id
            AND ($1::timestamptz IS NULL OR r.created_at>=$1)
            AND ($2::timestamptz IS NULL OR r.created_at<=$2)
            AND ($3::text IS NULL OR r.state=$3)
          GROUP BY r.state
        ) s
      ) runs ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS model_attempts,
          COALESCE(sum(l.input_tokens),0)::text AS input_tokens,
          COALESCE(sum(l.output_tokens),0)::text AS output_tokens,
          sum(l.cost_amount)::text AS cost_amount,
          CASE WHEN count(DISTINCT l.currency) FILTER (WHERE l.currency IS NOT NULL)=1 THEN min(l.currency) END AS currency
        FROM bb_platform_cost_ledger l
        JOIN bb_runs r ON r.id=l.run_id AND r.owner_user_id=l.owner_user_id
        WHERE l.owner_user_id=u.id
          AND ($1::timestamptz IS NULL OR r.created_at>=$1)
          AND ($2::timestamptz IS NULL OR r.created_at<=$2)
          AND ($3::text IS NULL OR r.state=$3)
      ) usage ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(sum(e.points),0)::text AS credit_settled_points
        FROM bb_credit_events e
        JOIN bb_runs r ON r.id=e.run_id AND r.owner_user_id=e.owner_user_id
        WHERE e.owner_user_id=u.id AND e.kind='settle'
          AND ($1::timestamptz IS NULL OR r.created_at>=$1)
          AND ($2::timestamptz IS NULL OR r.created_at<=$2)
          AND ($3::text IS NULL OR r.state=$3)
      ) credits ON true
      WHERE ($4::text IS NULL OR u.id=$4)
        AND ($5::timestamptz IS NULL OR (u.created_at,u.id)<($5::timestamptz,$6::text))
      ORDER BY u.created_at DESC,u.id DESC
      LIMIT $7`, [...filterArgs(filter), filter.cursor?.createdAt ?? null, filter.cursor?.id ?? null, filter.limit + 1])).rows;
    const page = pageOf(rows, filter.limit, 'users', row => ({createdAt: new Date(row.created_at), id: row.user_id}));
    return {items: page.items.map(userRow), next_cursor: page.next_cursor};
  });
}

export async function adminDashboardTasks(pool: Pool, actorId: string, filter: DashboardFilter) {
  return transaction(pool, async client => {
    await auditRead(client, actorId, 'admin_dashboard_tasks', filter);
    const rows = (await client.query(`SELECT r.id AS run_id,r.owner_user_id AS user_id,u.phone_e164,r.project_id,p.name AS project_name,
        r.task_kind,r.state,r.stage,r.created_at,r.updated_at,
        GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (r.updated_at-r.created_at))*1000))::bigint::text AS duration_ms,
        usage.model_attempts,usage.input_tokens,usage.output_tokens,usage.cost_amount,usage.currency,usage.pricing_status,
        err.last_error_code,credits.credit_settled_points,exec_log.attempt_id AS latest_attempt_id
      FROM bb_runs r
      JOIN bb_projects p ON p.owner_user_id=r.owner_user_id AND p.id=r.project_id
      LEFT JOIN bb_users u ON u.id=r.owner_user_id
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS model_attempts,
          COALESCE(sum(l.input_tokens),0)::text AS input_tokens,
          COALESCE(sum(l.output_tokens),0)::text AS output_tokens,
          sum(l.cost_amount)::text AS cost_amount,
          CASE WHEN count(DISTINCT l.currency) FILTER (WHERE l.currency IS NOT NULL)=1 THEN min(l.currency) END AS currency,
          CASE WHEN count(*)=0 THEN NULL
               WHEN bool_or(l.pricing_status='priced') THEN 'priced'
               WHEN bool_or(l.pricing_status='rate_missing') THEN 'rate_missing'
               ELSE 'unknown' END AS pricing_status
        FROM bb_platform_cost_ledger l
        WHERE l.owner_user_id=r.owner_user_id AND l.run_id=r.id
      ) usage ON true
      LEFT JOIN LATERAL (
        SELECT rt.error_code AS last_error_code
        FROM bb_model_call_attempt_runtime rt
        WHERE rt.owner_user_id=r.owner_user_id AND rt.run_id=r.id AND rt.error_code IS NOT NULL
        ORDER BY rt.recorded_at DESC,rt.attempt_no DESC LIMIT 1
      ) err ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(sum(e.points),0)::text AS credit_settled_points
        FROM bb_credit_events e
        WHERE e.owner_user_id=r.owner_user_id AND e.run_id=r.id AND e.kind='settle'
      ) credits ON true
      LEFT JOIN LATERAL (
        SELECT l.attempt_id
        FROM bb_codex_exec_logs l
        WHERE l.owner_user_id=r.owner_user_id AND l.run_id=r.id
        ORDER BY l.created_at DESC,l.attempt_id DESC LIMIT 1
      ) exec_log ON true
      WHERE ($1::timestamptz IS NULL OR r.created_at>=$1)
        AND ($2::timestamptz IS NULL OR r.created_at<=$2)
        AND ($3::text IS NULL OR r.state=$3)
        AND ($4::text IS NULL OR r.owner_user_id=$4)
        AND ($5::timestamptz IS NULL OR (r.created_at,r.id)<($5::timestamptz,$6::text))
      ORDER BY r.created_at DESC,r.id DESC
      LIMIT $7`, [...filterArgs(filter), filter.cursor?.createdAt ?? null, filter.cursor?.id ?? null, filter.limit + 1])).rows;
    const page = pageOf(rows, filter.limit, 'tasks', row => ({createdAt: new Date(row.created_at), id: row.run_id}));
    return {items: page.items.map(taskRow), next_cursor: page.next_cursor};
  });
}

// Deny by default: without log_reader the answer is the same owner-safe 404 as an unknown resource.
export function installAdminDashboardRoutes(app: FastifyInstance, deps: Deps) {
  async function operator(request: FastifyRequest) {
    const userId = await deps.owner(request);
    if (!(await operatorRoles(deps.db(), userId)).has('log_reader')) throw missing();
    return userId;
  }
  app.get('/api/v1/admin/dashboard/overview', {schema: {response: {200: schemas.AdminDashboardOverviewResponse}}}, async (request, reply) => {
    const actor = await operator(request);
    const filter = parseDashboardFilter(request.query as Record<string, unknown>, 'tasks');
    reply.header('cache-control', 'no-store');
    return adminDashboardOverview(deps.db(), actor, filter);
  });
  app.get('/api/v1/admin/dashboard/users', {schema: {response: {200: schemas.AdminDashboardUsersResponse}}}, async (request, reply) => {
    const actor = await operator(request);
    const filter = parseDashboardFilter(request.query as Record<string, unknown>, 'users');
    reply.header('cache-control', 'no-store');
    return adminDashboardUsers(deps.db(), actor, filter);
  });
  app.get('/api/v1/admin/dashboard/tasks', {schema: {response: {200: schemas.AdminDashboardTasksResponse}}}, async (request, reply) => {
    const actor = await operator(request);
    const filter = parseDashboardFilter(request.query as Record<string, unknown>, 'tasks');
    reply.header('cache-control', 'no-store');
    return adminDashboardTasks(deps.db(), actor, filter);
  });
  // Access probe: returns {allowed} instead of 404 so the account page can hide the link.
  app.get('/api/v1/admin/dashboard/access', {schema: {response: {200: schemas.AdminDashboardAccessResponse}}}, async (request, reply) => {
    const userId = await deps.owner(request);
    reply.header('cache-control', 'private, no-store');
    return {allowed: (await operatorRoles(deps.db(), userId)).has('log_reader')};
  });
}
