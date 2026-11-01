import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import type {Pool, PoolClient} from 'pg';
import {
  adminDashboardTasks,
  adminDashboardUsers,
  dashboardCostText,
  decodeDashboardCursor,
  encodeDashboardCursor,
  installAdminDashboardRoutes,
  maskPhone,
  parseDashboardFilter
} from './admin-dashboard.js';

type Call = {sql: string; params: unknown[]};

function fakePool(answer: (sql: string, params: unknown[]) => unknown[]) {
  const calls: Call[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({sql, params});
      return {rows: answer(sql, params), rowCount: 1};
    },
    release() {}
  };
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({sql, params});
      return {rows: answer(sql, params), rowCount: 1};
    },
    connect: async () => client as unknown as PoolClient
  } as unknown as Pool;
  return {pool, calls};
}

const usersSelect = (calls: Call[]) => calls.find(call => call.sql.includes('FROM bb_users u'))!;
const tasksSelect = (calls: Call[]) => calls.find(call => call.sql.includes('FROM bb_runs r') && call.sql.includes('r.task_kind'))!;

test('phone masking keeps only the last four digits and never returns the full number', () => {
  assert.equal(maskPhone('+8613800001234'), '****1234');
  assert.equal(maskPhone('+1 (415) 555-0199'), '****0199');
  assert.equal(maskPhone(null), null);
  assert.equal(maskPhone(undefined), null);
  assert.equal(maskPhone('+123'), null, 'too short to mask safely is treated as absent');
  for (const phone of ['+8613800001234', '+14155550199']) {
    const masked = maskPhone(phone)!;
    assert.equal(masked.includes('1380000'), false);
    assert.equal(masked.includes('4155550'), false);
  }
});

test('range parsing normalises UTC days and rejects unknown or unsafe filter input', () => {
  const filter = parseDashboardFilter({from: '2026-10-01', to: '2026-10-31', state: 'failed', user_id: 'user_1', limit: '25'}, 'users');
  assert.equal(filter.from?.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(filter.to?.toISOString(), '2026-10-31T23:59:59.999Z');
  assert.equal(filter.state, 'failed');
  assert.equal(filter.userId, 'user_1');
  assert.equal(filter.limit, 25);
  assert.equal(parseDashboardFilter(undefined).limit, 20);
  for (const bad of [
    {limit: '0'}, {limit: '101'}, {limit: '1e2'}, {state: 'nope'}, {user_id: "u' OR 1=1"},
    {from: '2026-02-30'}, {from: '2026-10-02', to: '2026-10-01'}, {unknown: 'x'}, {cursor: 'not a cursor'}
  ]) {
    assert.throws(() => parseDashboardFilter(bad as Record<string, unknown>), (error: any) => error.status === 422, JSON.stringify(bad));
  }
});

test('keyset cursors round-trip the created_at and id pair and are section-scoped', () => {
  const cursor = {createdAt: new Date('2026-10-31T08:00:00.000Z'), id: 'run_1'};
  const raw = encodeDashboardCursor('tasks', cursor);
  const decoded = decodeDashboardCursor('tasks', raw);
  assert.equal(decoded.createdAt.toISOString(), '2026-10-31T08:00:00.000Z');
  assert.equal(decoded.id, 'run_1');
  assert.throws(() => decodeDashboardCursor('users', raw), (error: any) => error.status === 422);
  const forged = Buffer.from(JSON.stringify({k: 'tasks', t: 'yesterday', id: 'run_1'})).toString('base64url');
  assert.throws(() => decodeDashboardCursor('tasks', forged), (error: any) => error.status === 422);
});

test('cost text stays exact decimal and rejects floating-point or malformed values', () => {
  assert.equal(dashboardCostText('1.23'), '1.2300000000');
  assert.equal(dashboardCostText('0'), '0.0000000000');
  assert.equal(dashboardCostText(null), null);
  for (const bad of ['1.2e3', '-1', '1.12345678901', '01', 1.23]) assert.throws(() => dashboardCostText(bad));
});

test('users query applies time/state/user filters, keyset pagination and masked rows', async () => {
  const rows = [
    {user_id: 'user_1', phone_e164: '+8613800001234', status: 'active', created_at: new Date('2026-10-03T00:00:00Z'), projects: 2, runs: 3,
      runs_by_state: [{state: 'succeeded', count: 2}, {state: 'failed', count: 1}], last_run_at: new Date('2026-10-31T00:00:00Z'),
      model_attempts: 4, input_tokens: '100', output_tokens: '20', cost_amount: '1.2300000000', currency: 'CNY', credit_settled_points: '300'},
    {user_id: 'user_2', phone_e164: '+14155550199', status: 'disabled', created_at: new Date('2026-10-02T00:00:00Z'), projects: 0, runs: 0,
      runs_by_state: [], last_run_at: null, model_attempts: 0, input_tokens: '0', output_tokens: '0', cost_amount: null, currency: null, credit_settled_points: '0'},
    {user_id: 'user_3', phone_e164: null, status: 'active', created_at: new Date('2026-10-01T00:00:00Z'), projects: 1, runs: 1,
      runs_by_state: [{state: 'running', count: 1}], last_run_at: new Date('2026-10-01T00:10:00Z'), model_attempts: 1, input_tokens: '5', output_tokens: '6',
      cost_amount: '0.1000000000', currency: 'CNY', credit_settled_points: '0'}
  ];
  const {pool, calls} = fakePool(sql => sql.includes('FROM bb_users u') ? rows : []);
  const filter = parseDashboardFilter({from: '2026-10-01', to: '2026-10-31', state: 'failed', user_id: 'user_1', limit: '2'}, 'users');
  const result = await adminDashboardUsers(pool, 'operator_1', filter);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0]!.phone_masked, '****1234');
  assert.equal(result.items[1]!.phone_masked, '****0199');
  assert.deepEqual(result.items[0]!.runs_by_state, [{state: 'succeeded', count: 2}, {state: 'failed', count: 1}]);
  assert.equal(result.items[0]!.cost_amount, '1.2300000000');
  assert.equal(result.next_cursor !== null, true);
  assert.deepEqual(decodeDashboardCursor('users', result.next_cursor!), {createdAt: new Date('2026-10-02T00:00:00Z'), id: 'user_2'});
  const call = usersSelect(calls);
  assert.match(call.sql, /u\.id=\$4/);
  assert.match(call.sql, /\(u\.created_at,u\.id\)<\(\$5::timestamptz,\$6::text\)/);
  assert.equal(call.params[0]?.toString(), new Date('2026-10-01T00:00:00.000Z').toString());
  assert.equal((call.params[1] as Date).toISOString(), '2026-10-31T23:59:59.999Z');
  assert.equal(call.params[2], 'failed');
  assert.equal(call.params[3], 'user_1');
  assert.equal(call.params[4], null);
  assert.equal(call.params[5], null);
  assert.equal(call.params[6], 3, 'one extra row detects the next page');
  assert.ok(calls.some(entry => entry.sql.includes('INSERT INTO bb_log_access_audit')));
});

test('tasks query filters by state/time/user, maps usage and continues from the encoded cursor', async () => {
  const row = {run_id: 'run_2', user_id: 'user_1', phone_e164: '+8613800001234', project_id: 'proj_1', project_name: '合成项目',
    task_kind: 'update', state: 'succeeded', stage: 'delivered', created_at: new Date('2026-10-30T08:00:00Z'), updated_at: new Date('2026-10-30T08:01:00Z'),
    duration_ms: '60000', model_attempts: 3, input_tokens: '1200', output_tokens: '300', cost_amount: '0.4500000000', currency: 'CNY',
    pricing_status: 'priced', last_error_code: null, credit_settled_points: '600', latest_attempt_id: 'att_syn_1'};
  const {pool, calls} = fakePool(sql => sql.includes('r.task_kind') ? [row] : []);
  const cursor = encodeDashboardCursor('tasks', {createdAt: new Date('2026-11-01T00:00:00.000Z'), id: 'run_3'});
  const filter = parseDashboardFilter({from: '2026-10-01T00:00:00Z', state: 'succeeded', cursor, limit: '1'}, 'tasks');
  const result = await adminDashboardTasks(pool, 'operator_1', filter);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0], {
    run_id: 'run_2', user_id: 'user_1', phone_masked: '****1234', project_id: 'proj_1', project_name: '合成项目', task_kind: 'update',
    state: 'succeeded', stage: 'delivered', created_at: '2026-10-30T08:00:00.000Z', updated_at: '2026-10-30T08:01:00.000Z',
    duration_ms: 60000, model_attempts: 3, input_tokens: 1200, output_tokens: 300, cost_amount: '0.4500000000', currency: 'CNY',
    pricing_status: 'priced', last_error_code: null, credit_settled_points: '600',
    latest_attempt_id: 'att_syn_1', exec_log_available: true
  });
  assert.equal(result.next_cursor, null);
  const call = tasksSelect(calls);
  assert.match(call.sql, /r\.state=\$3/);
  assert.match(call.sql, /r\.owner_user_id=\$4/);
  assert.match(call.sql, /\(r\.created_at,r\.id\)<\(\$5::timestamptz,\$6::text\)/);
  assert.equal((call.params[0] as Date).toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(call.params[1], null);
  assert.equal(call.params[2], 'succeeded');
  assert.equal(call.params[3], null);
  assert.equal((call.params[4] as Date).toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(call.params[5], 'run_3');
  assert.equal(call.params[6], 2);
  assert.ok(calls.some(entry => entry.sql.includes('rt.recorded_at DESC')));
  assert.ok(calls.some(entry => entry.sql.includes("e.kind='settle'")));
  assert.ok(calls.some(entry => entry.sql.includes('FROM bb_codex_exec_logs l')));
});

test('routes deny non-operators with the same 404 and return masked rows for log_reader', async () => {
  const row = {user_id: 'user_1', phone_e164: '+8613800001234', status: 'active', created_at: new Date('2026-10-03T00:00:00Z'), projects: 0, runs: 0,
    runs_by_state: [], last_run_at: null, model_attempts: 0, input_tokens: '0', output_tokens: '0', cost_amount: null, currency: null, credit_settled_points: '0'};
  const {pool} = fakePool((sql, params) => {
    if (sql.includes('FROM bb_operator_grants')) return params[0] === 'operator_1' ? [{role: 'log_reader'}] : [];
    if (sql.includes('FROM bb_users u')) return [row];
    return [];
  });
  const app = Fastify();
  app.setErrorHandler((error: any, _request, reply) => {
    const status = typeof error?.status === 'number' ? error.status : 500;
    reply.code(status).send({code: typeof error?.code === 'string' ? error.code : 'DATA_UNAVAILABLE', message: 'synthetic'});
  });
  installAdminDashboardRoutes(app, {db: () => pool, owner: async request => String(request.headers['x-operator'] ?? '')});
  try {
    const denied = await app.inject({method: 'GET', url: '/api/v1/admin/dashboard/users', headers: {'x-operator': 'stranger'}});
    assert.equal(denied.statusCode, 404);
    const allowed = await app.inject({method: 'GET', url: '/api/v1/admin/dashboard/users', headers: {'x-operator': 'operator_1'}});
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(allowed.json().items[0].phone_masked, '****1234');
    assert.equal(allowed.headers['cache-control'], 'no-store');
  } finally {
    await app.close();
  }
});
