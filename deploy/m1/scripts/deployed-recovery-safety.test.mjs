import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertHealthIdentity, assertProxyTarget, assertServiceIdentity, assertWebPort, closeSyntheticAccount } from './deployed-recovery-safety.mjs';

const sha = 'a'.repeat(40);
const healthy = { status: 200, contentType: 'application/json; charset=utf-8',
  body: JSON.stringify({ status: 'ok', service: 'bondbuddy-m1-api-skeleton', implementation: 'health-and-contract-only' }) };
const userId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';

test('health rejects HTML fallback, wrong API body, and non-JSON 200', () => {
  assert.doesNotThrow(() => assertHealthIdentity(healthy, healthy));
  assert.throws(() => assertHealthIdentity(healthy, { ...healthy, contentType: 'text/html', body: '<html>fallback</html>' }), /content type/);
  assert.throws(() => assertHealthIdentity(healthy, { ...healthy, body: JSON.stringify({ status: 'ok', service: 'other' }) }), /body mismatch/);
  assert.throws(() => assertHealthIdentity(healthy, { ...healthy, body: '<html>fallback</html>' }), /not JSON/);
});

test('specified Compose ID and release identity are mandatory', () => {
  const container = { State: { Status: 'running', Paused: false, Health: { Status: 'healthy' } }, Config: { Labels: { 'com.docker.compose.service': 'api' },
    Image: `bondbuddy-m1-api:${sha.slice(0, 12)}`, Env: [`BB_RELEASE_SHA=${sha}`] } };
  assert.doesNotThrow(() => assertServiceIdentity('api', 'actual', 'actual', container, sha));
  assert.throws(() => assertServiceIdentity('api', 'actual', 'other', container, sha), /ID does not match/);
  assert.throws(() => assertServiceIdentity('api', 'actual', 'actual', { ...container, Config: { ...container.Config, Env: ['BB_RELEASE_SHA=wrong'] } }, sha), /image commit mismatch/);
  assert.throws(() => assertServiceIdentity('api', 'actual', 'actual', { ...container, State: { ...container.State, Health: { Status: 'unhealthy' } } }, sha), /healthcheck/);
  assert.doesNotThrow(() => assertProxyTarget('hash', 'hash', '10.1.0.4', ['10.1.0.4']));
  assert.throws(() => assertProxyTarget('wrong', 'hash', '10.1.0.4', ['10.1.0.4']), /configuration mismatch/);
  assert.throws(() => assertProxyTarget('hash', 'hash', '10.1.0.5', ['10.1.0.4']), /specified API container/);
  const bindings = [{ HostIp: '127.0.0.1', HostPort: '18080' }];
  assert.doesNotThrow(() => assertWebPort('http://127.0.0.1:18080', bindings));
  assert.throws(() => assertWebPort('http://127.0.0.1:18081', bindings), /specified Web container/);
  assert.throws(() => assertWebPort('http://localhost:18080', bindings), /specified Web container/);
});

function fixture({ projectId = null, closureFails = false, projectOwner = userId } = {}) {
  const state = { username: 'synthetic79_abcdef', password: 'private', user_id: userId, project_id: projectId };
  let status = 'active';
  const requests = [], records = [];
  const deps = {
    rows(query) {
      if (query.startsWith('SELECT username,status FROM bb_users')) return [[state.username, status]];
      if (query.startsWith('SELECT status FROM bb_users')) return [[status]];
      if (query.startsWith('SELECT id FROM bb_projects')) return [];
      if (query.startsWith('SELECT owner_user_id,name,deleted_at')) return [[projectOwner, 'SYNTHETIC recovery drill', 't']];
      throw new Error(`Unexpected query: ${query}`);
    },
    qid(value) { return `'${value}'`; }, uuid(value) { return value; }, save() {},
    async login() { requests.push('login'); },
    async request(method, path) {
      requests.push(`${method} ${path}`);
      if (path === '/api/v1/account/closure') {
        if (closureFails) throw new Error('closure unavailable');
        status = 'closed';
      }
    },
    record(phase, data) { records.push({ phase, ...data }); }, short(error) { return error.message; },
  };
  return { state, deps, requests, records, get status() { return status; } };
}

test('registration followed by project failure still closes account; repeat recovery is idempotent', async () => {
  const f = fixture();
  assert.equal(await closeSyntheticAccount(f.state, f.deps), true);
  assert.deepEqual(f.requests, ['login', 'POST /api/v1/account/closure']);
  assert.equal(f.status, 'closed');
  assert.equal(await closeSyntheticAccount(f.state, f.deps), true);
  assert.equal(f.requests.length, 2);
  assert.equal(f.records.at(-1).status, 'already_closed');
});

test('failed closure reports failure and refuses another owner project', async () => {
  const failed = fixture({ closureFails: true });
  assert.equal(await closeSyntheticAccount(failed.state, failed.deps), false);
  assert.equal(failed.records.at(-1).status, 'manual_recovery_required');
  const wrong = fixture({ projectId: otherId, projectOwner: otherId });
  assert.equal(await closeSyntheticAccount(wrong.state, wrong.deps), false);
  assert.deepEqual(wrong.requests, ['login']);
});
