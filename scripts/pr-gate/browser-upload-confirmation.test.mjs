import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserUploadConfirmationConfig, browserUploadConfirmationEnvironment, runBrowserUploadConfirmationService, verifyBrowserUploadConfirmation } from './browser-upload-confirmation.mjs';
import { BROWSER_DATABASE } from './browser-profiles.mjs';
import { syntheticBrowserUploadConfirmation } from './browser-upload-confirmation.test-fixture.mjs';

const plan = () => ({ commit: 'a'.repeat(40), tree: 'b'.repeat(40), run_id: 'synthetic-upload-1234', shard: 'browser-1', needs: { api: true },
  output_root: '/evidence/shards/browser-1/browser', environment: { BB_TEST_DATABASE_URL: BROWSER_DATABASE, BB_TEST_AZURITE_CONNECTION_STRING: 'UseDevelopmentStorage=true' } });
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };

function fixture() {
  const config = browserUploadConfirmationConfig({ root: '/workspace', plan: plan() }), controller = new AbortController();
  const calls = [], records = [], logs = [], ready = deferred();
  const sourcePaths = ['apps/worker/src/upload-confirmation-runtime.ts', 'apps/worker/src/upload-confirmation-spool.ts', 'apps/api/src/upload-confirmation.ts',
    'apps/worker/dist/upload-confirmation-runtime.js', 'apps/worker/dist/upload-confirmation-spool.js', 'apps/api/dist/upload-confirmation.js'];
  const adapters = { signal: controller.signal, identity: { pid: 123, parent_pid: 100, start_ticks: '456', platform: 'linux' },
    sources: Object.fromEntries(sourcePaths.map(path => [path, 'c'.repeat(64)])),
    createSpool: async () => ({ identity: { path: config.spool, dev: '1', ino: '2' }, acquire: async () => { calls.push('acquire'); },
      release: async () => { calls.push('release'); return { lock_released: true, reserved_bytes: 0 }; },
      remove: async () => { calls.push('remove'); return { removed: true, absence_confirmed: true }; } }),
    connect: async () => ({ pool: { end: async () => { calls.push('pool'); } }, blobs: {},
      database: { status: 'passed', database: 'bondbuddy_local', port: 55433, username: 'bondbuddy', version: '160014' },
      storage: { status: 'passed', endpoint: 'http://127.0.0.1:10000/devstoreaccount1/bondbuddy-private', container: 'bondbuddy-private' } }),
    createRuntime: options => { assert.equal(options.smallSlot, false); assert.equal(options.lane, 'general'); return {
      start: () => { calls.push('start'); options.log({ kind: 'upload_confirmation', outcome: 'completed' }); }, stop: async () => { calls.push('stop'); } }; },
    publish: (type, evidence) => { records.push({ type, evidence }); if (type === 'ready') ready.resolve(evidence); }, log: value => logs.push(value) };
  return { config, controller, calls, records, logs, ready, adapters };
}

test('consumer configuration fixes isolated storage and rejects redirected plans', () => {
  const f = fixture(), env = browserUploadConfirmationEnvironment(f.config);
  assert.equal(env.DATABASE_URL, BROWSER_DATABASE); assert.equal(env.BB_UPLOAD_SPOOL_MAX_BYTES, '134217728');
  assert.equal(env.BB_UPLOAD_SPOOL_DIR, '/tmp/bb-pr-gate-upload-synthetic-upload-1234-browser-1');
  assert.equal(Object.keys(env).some(key => /TOKEN|OPENAI|DEEPSEEK|NODE_OPTIONS|PROXY|WORKER_RUN|WORKER_JOB/.test(key)), false);
  for (const mutate of [p => p.environment.BB_TEST_DATABASE_URL = 'postgresql://production/db', p => p.environment.BB_TEST_AZURITE_CONNECTION_STRING = 'https://real.blob/',
    p => p.run_id = '../foreign', p => p.shard = 'browser-4', p => p.output_root = '/tmp/other', p => p.needs.api = false]) {
    const changed = plan(); mutate(changed); assert.throws(() => browserUploadConfirmationConfig({ root: '/workspace', plan: changed }));
  }
  assert.throws(() => browserUploadConfirmationConfig({ root: '/host', plan: plan() }));
  assert.throws(() => browserUploadConfirmationEnvironment({ ...f.config, database: 'postgresql://production/db' }));
  assert.throws(() => browserUploadConfirmationEnvironment({ ...f.config, small_slot: true }));
});

test('SIGTERM-style abort stops claims immediately and drains before pool/spool release', async () => {
  const f = fixture(), inFlight = deferred();
  f.adapters.createRuntime = options => ({ start: () => { f.calls.push('start'); options.log({ kind: 'upload_confirmation', outcome: 'retry' }); },
    stop: () => { f.calls.push('stop'); return inFlight.promise; } });
  const work = runBrowserUploadConfirmationService(f.config, f.adapters); const ready = await f.ready.promise;
  verifyBrowserUploadConfirmation(ready, plan(), { pid: 123, parentPid: 100 });
  f.controller.abort(); await Promise.resolve();
  assert.deepEqual(f.calls, ['acquire', 'start', 'stop']);
  inFlight.resolve(); const result = await work;
  assert.deepEqual(f.calls, ['acquire', 'start', 'stop', 'pool', 'release', 'remove']);
  assert.equal(result.events.retry, 1); assert.equal(result.status, 'stopped');
  result.process_exit = { code: 0, signal: null, stop_signal: 'SIGTERM' }; result.log = { path: f.config.output + '/events.jsonl', bytes: 42, sha256: 'd'.repeat(64) };
  verifyBrowserUploadConfirmation(result, plan(), { final: true });
  for (const mutate of [r => r.process_exit.code = 1, r => r.process_exit.stop_signal = null, r => r.consumers.parse.push('parse'),
    r => r.cleanup.steps[2].reserved_bytes = 1, r => r.cleanup.steps[3].absence_confirmed = false, r => r.process.pid = 0,
    r => r.database_probe.port = 5432, r => r.sources['apps/worker/dist/upload-confirmation-runtime.js'] = '', r => r.errors.push('consumer error')]) {
    const changed = structuredClone(result); mutate(changed); assert.throws(() => verifyBrowserUploadConfirmation(changed, plan(), { final: true }));
  }
});

test('synthetic receipt fixture follows the same final verifier contract', () => {
  const record = syntheticBrowserUploadConfirmation(plan()); verifyBrowserUploadConfirmation(record, plan(), { final: true });
  record.events.error = 1; assert.throws(() => verifyBrowserUploadConfirmation(record, plan(), { final: true }));
});

test('startup stop before storage readiness never starts a consumer', async () => {
  const f = fixture(), connecting = deferred(), connect = f.adapters.connect;
  f.adapters.connect = async () => { await connecting.promise; return connect(); };
  const work = runBrowserUploadConfirmationService(f.config, f.adapters);
  await Promise.resolve(); await Promise.resolve(); f.controller.abort(); connecting.resolve(); const result = await work;
  assert.equal(f.calls.includes('start'), false); assert.equal(f.records.some(row => row.type === 'ready'), false);
  assert.equal(result.cleanup.status, 'passed'); assert.ok(f.calls.includes('release')); assert.ok(f.calls.includes('remove'));
});

test('startup failure retains failed evidence and cleans its owned spool', async () => {
  const f = fixture(); f.adapters.connect = async () => { throw new Error('sensitive storage URL'); };
  const result = await runBrowserUploadConfirmationService(f.config, f.adapters);
  assert.equal(result.status, 'failed'); assert.equal(f.records.some(row => row.type === 'ready'), false);
  assert.deepEqual(f.calls, ['acquire', 'release', 'remove']); assert.equal(JSON.stringify(result).includes('sensitive storage URL'), false);
});

test('failed drain is recorded and never removes a potentially live spool', async () => {
  const f = fixture(); f.adapters.createRuntime = () => ({ start() {}, stop: async () => { throw new Error('drain failed'); } });
  const work = runBrowserUploadConfirmationService(f.config, f.adapters); await f.ready.promise; f.controller.abort(); const result = await work;
  assert.equal(result.status, 'failed'); assert.equal(result.cleanup.status, 'failed'); assert.equal(f.calls.includes('remove'), false);
  assert.equal(f.calls.includes('release'), false);
  assert.ok(result.cleanup.steps.some(row => row.name === 'drain' && row.status === 'failed'));
});

test('runtime error events remain blocking while expected failed/retry outcomes are preserved', async () => {
  const f = fixture(); f.adapters.createRuntime = options => ({ start: () => {
    for (const outcome of ['failed', 'retry', 'error']) options.log({ kind: 'upload_confirmation', outcome });
  }, stop: async () => {} });
  const work = runBrowserUploadConfirmationService(f.config, f.adapters); await f.ready.promise; f.controller.abort(); const result = await work;
  assert.deepEqual(result.events, { failed: 1, retry: 1, error: 1 }); assert.equal(result.status, 'failed');
  assert.equal(f.logs.length, 3); assert.ok(result.errors.some(value => value.includes('runtime reported')));
});
