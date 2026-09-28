import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { BROWSER_ERROR_LIMIT } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { uid } from './data.js';
import { grantOperator } from './log-ops.js';
import { purgeBrowserErrorContent } from './browser-errors.js';
import { isolatedTestDatabase } from './test-database.js';

const connection = await isolatedTestDatabase();
const ORIGIN = 'http://bondbuddy.test';
const report = (fingerprint = 'a'.repeat(64)) => ({ error_type: 'TypeError', fingerprint,
  message: 'Cookie: bb_session=private\nBearer syntheticsecret. test@example.com +8613812345678',
  route_id: '/projects/:project_id', frontend_version: 'm1.20260928', client_time: new Date().toISOString() });

test('browser diagnostic messages truncate at UTF-8 boundaries before storage', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const owner = `u${uid()}`;
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, owner.replaceAll('-', '').toLowerCase().slice(0, 32)]);
  const app = createServer({ pool, allowedOrigin: ORIGIN,
    principal: async () => ({ userId: owner, csrfVerified: true, sessionId: `${owner}-session` }) });
  try {
    const cases = [
      { input: '€'.repeat(342), expected: '€'.repeat(341) },
      { input: 'x'.repeat(1023) + '😀', expected: 'x'.repeat(1023) },
      { input: '€'.repeat(340) + 'é'.repeat(2), expected: '€'.repeat(340) + 'é'.repeat(2) }
    ];
    for (const [index, sample] of cases.entries()) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/browser-errors',
        headers: { origin: ORIGIN }, payload: { ...report((index + 1).toString(16).padStart(64, '0')), message: sample.input } });
      assert.equal(response.statusCode, 201, response.body);
      const row = (await pool.query('SELECT safe_message,octet_length(safe_message) AS byte_length FROM bb_browser_error_reports WHERE id=$1',
        [response.json().report_id])).rows[0];
      assert.equal(row.safe_message, sample.expected);
      assert.ok(row.byte_length <= 1024);
      assert.ok(!row.safe_message.includes('\uFFFD'));
    }
  } finally { await app.close(); await pool.end(); }
});

test('browser diagnostics are owned, bounded, redacted, deduplicated, audited and expired', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const ownerA = `a${uid()}`, ownerB = `b${uid()}`;
  for (const id of [ownerA, ownerB]) await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id, id.replaceAll('-', '').toLowerCase().slice(0, 32)]);
  let active = ownerA;
  const app = createServer({ pool, allowedOrigin: ORIGIN,
    principal: async () => ({ userId: active, csrfVerified: true, sessionId: `${active}-session` }) });
  const send = (method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url,
    headers: { origin: ORIGIN }, payload: payload as never });
  try {
    const project = await send('POST', '/api/v1/projects', { name: 'Synthetic', kind: 'update', issuer_name: null, market: null, offering: null });
    assert.equal(project.statusCode, 201, project.body);
    const projectId = project.json().project_id as string;
    const revision = await send('POST', `/api/v1/projects/${projectId}/input-revisions`,
      { draft_revision: 1, material_versions: [], requirement_message_ids: [] });
    assert.equal(revision.statusCode, 201, revision.body);
    const preflight = await send('POST', `/api/v1/projects/${projectId}/preflight`,
      { input_revision: 1, input_hash: revision.json().input_hash });
    assert.equal(preflight.statusCode, 200, preflight.body);
    const jobId = (await pool.query("SELECT id FROM bb_jobs WHERE owner_user_id=$1 AND project_id=$2 AND job_type='preflight' ORDER BY created_at DESC LIMIT 1", [ownerA, projectId])).rows[0].id as string;
    const body = { ...report(), project_id: projectId, job_id: jobId };
    const first = await send('POST', '/api/v1/browser-errors', body);
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(first.json().deduplicated, false);
    const repeated = await send('POST', '/api/v1/browser-errors', body);
    assert.equal(repeated.statusCode, 201, repeated.body);
    assert.equal(repeated.json().report_id, first.json().report_id);
    assert.equal(repeated.json().deduplicated, true);
    const row = (await pool.query('SELECT * FROM bb_browser_error_reports WHERE id=$1', [first.json().report_id])).rows[0];
    assert.equal(row.owner_user_id, ownerA);
    await assert.rejects(pool.query("UPDATE bb_browser_error_reports SET error_type='OtherError' WHERE id=$1", [row.id]), /immutable/);
    for (const secret of ['private', 'syntheticsecret', 'test@example.com', '13812345678'])
      assert.ok(!JSON.stringify(row).includes(secret), `stored diagnostic contained ${secret}`);
    const own = await send('GET', `/api/v1/browser-errors/${row.id}`);
    assert.equal(own.statusCode, 200, own.body);
    assert.equal(own.headers['cache-control'], 'no-store');
    assert.equal(own.json().project_id, projectId);
    active = ownerB;
    assert.equal((await send('GET', `/api/v1/browser-errors/${row.id}`)).statusCode, 404);
    assert.equal((await send('POST', '/api/v1/browser-errors', body)).statusCode, 404);
    active = ownerA;
    assert.equal((await send('POST', '/api/v1/browser-errors', { ...body, unknown: 'secret' })).statusCode, 422);
    assert.equal((await send('POST', '/api/v1/browser-errors', { ...body, message: 'x'.repeat(2000) })).statusCode, 422);
    assert.equal((await send('POST', '/api/v1/browser-errors', { ...body, route_id: '/path?token=secret' })).statusCode, 422);
    assert.equal((await send('POST', '/api/v1/browser-errors', { ...body, route_id: '/projects/13812345678' })).statusCode, 422);
    for (let i = 1; i < BROWSER_ERROR_LIMIT.perUser; i++) {
      const result = await send('POST', '/api/v1/browser-errors', { ...body, fingerprint: i.toString(16).padStart(64, '0') });
      assert.equal(result.statusCode, 201, result.body);
    }
    const limited = await send('POST', '/api/v1/browser-errors', { ...body, fingerprint: 'f'.repeat(64) });
    assert.equal(limited.statusCode, 429, limited.body);
    assert.equal(limited.json().code, 'RATE_LIMITED');
    const visible = await pool.query("SELECT e.kind FROM bb_observability_events e WHERE e.owner_user_id=$1 AND e.project_id=$2 AND e.job_id=$3 AND e.kind='error.recorded'", [ownerA, projectId, jobId]);
    assert.equal(visible.rowCount, BROWSER_ERROR_LIMIT.perUser);
    const operation = await pool.query("SELECT 1 FROM bb_operations WHERE owner_user_id=$1 AND project_id=$2 AND operation_kind='browser_error_report'", [ownerA, projectId]);
    assert.equal(operation.rowCount, BROWSER_ERROR_LIMIT.perUser);
    assert.equal((await send('GET', `/api/v1/admin/browser-errors/${row.id}`)).statusCode, 404);
    assert.equal((await send('GET', '/api/v1/browser-errors/bad%3Fid')).statusCode, 404);
    await grantOperator(pool, { userId: ownerB, role: 'log_reader', grantedBy: 'synthetic-test', reasonCode: 'synthetic_test' });
    active = ownerB;
    const admin = await send('GET', `/api/v1/admin/browser-errors/${row.id}`);
    assert.equal(admin.statusCode, 200, admin.body);
    assert.equal(admin.headers['cache-control'], 'no-store');
    const events = await send('GET', `/api/v1/admin/logs/events?user_id=${ownerA}&job_id=${jobId}`);
    assert.equal(events.statusCode, 200, events.body);
    assert.ok(events.json().items.some((item: { kind: string; error_id: string }) => item.kind === 'error.recorded' && item.error_id === row.id));
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_log_access_audit WHERE actor_id=$1 AND target_ref=$2 AND purpose='browser_error_view'", [ownerB, row.id])).rows[0].n, 1);
    active = ownerA;
    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/projects/${projectId}`, headers: { origin: ORIGIN } });
    assert.equal(deleted.statusCode, 204, deleted.body);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_operations WHERE owner_user_id=$1 AND project_id=$2 AND operation_kind='project_delete'", [ownerA, projectId])).rows[0].n, 1);
    assert.equal(await purgeBrowserErrorContent(pool, 180, new Date(), ownerA), BROWSER_ERROR_LIMIT.perUser);
    assert.equal((await send('GET', `/api/v1/browser-errors/${row.id}`)).json().message, null);
    assert.equal(await purgeBrowserErrorContent(pool, 180, new Date(), ownerA), 0);
    active = ownerB;
    const expiring = await send('POST', '/api/v1/browser-errors', report('e'.repeat(64)));
    assert.equal(expiring.statusCode, 201, expiring.body);
    assert.equal(await purgeBrowserErrorContent(pool, 180, new Date(Date.now() + 181 * 86_400_000), ownerB), 1);
  } finally { await app.close(); await pool.end(); }
});

test('no session receives 401 and committed account/project actions are searchable', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const app = createServer({ pool, allowedOrigin: ORIGIN, auth: { termsVersion: 'synthetic-v1' } });
  try {
    const unauth = await app.inject({ method: 'POST', url: '/api/v1/browser-errors', headers: { origin: ORIGIN }, payload: report() });
    assert.equal(unauth.statusCode, 401, unauth.body);
    const username = `u${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const register = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: { origin: ORIGIN },
      payload: { username, password: 'synthetic-password-123', accepted_terms_version: 'synthetic-v1' } });
    assert.equal(register.statusCode, 201, register.body);
    const cookies = (register.headers['set-cookie'] as string[]).map(value => value.split(';')[0]);
    const csrf = cookies.find(value => value.startsWith('bb_csrf='))!.slice('bb_csrf='.length);
    const owner = register.json().user_id as string;
    const headers = { origin: ORIGIN, cookie: cookies.join('; '), 'x-bb-csrf': csrf };
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/browser-errors', headers, payload: report() });
    assert.equal(accepted.statusCode, 201, accepted.body);
    const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers });
    assert.equal(logout.statusCode, 204, logout.body);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN }, payload: { username, password: 'synthetic-password-123' } });
    assert.equal(login.statusCode, 200, login.body);
    const actions = (await pool.query('SELECT operation_kind FROM bb_operations WHERE owner_user_id=$1 ORDER BY created_at,id', [owner])).rows.map(r => r.operation_kind);
    for (const kind of ['auth_register', 'auth_login', 'auth_logout', 'browser_error_report']) assert.ok(actions.includes(kind), kind);
    const events = (await pool.query("SELECT kind FROM bb_observability_events WHERE owner_user_id=$1 AND kind='operation.submitted'", [owner])).rows;
    assert.ok(events.length >= 4);
  } finally { await app.close(); await pool.end(); }
});
