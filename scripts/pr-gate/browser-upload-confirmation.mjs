import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BROWSER_DATABASE } from './browser-profiles.mjs';

export const UPLOAD_CONFIRMATION_SCHEMA = 'pr-gate-browser-upload-confirmation-v1';
export const UPLOAD_CONFIRMATION_BLOB = 'UseDevelopmentStorage=true';
export const UPLOAD_CONFIRMATION_CONTAINER = 'bondbuddy-private';
const BUDGET = 128 * 1024 * 1024;
const here = fileURLToPath(import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const stamp = () => new Date().toISOString();
const SOURCE_FILES = ['apps/worker/src/upload-confirmation-runtime.ts', 'apps/worker/src/upload-confirmation-spool.ts', 'apps/api/src/upload-confirmation.ts'];
const BUILT_FILES = ['apps/worker/dist/upload-confirmation-runtime.js', 'apps/worker/dist/upload-confirmation-spool.js', 'apps/api/dist/upload-confirmation.js'];
const CONSUMERS = Object.freeze({ upload: ['upload.complete_requested'], run: [], parse: [], model: [] });

export function browserUploadConfirmationConfig({ root, plan }) {
  assert.equal(root, '/workspace'); assert.equal(plan.needs?.api, true);
  for (const key of ['commit', 'tree']) assert.match(plan[key], /^[a-f0-9]{40}$/);
  assert.match(plan.run_id, /^[a-zA-Z0-9-]{8,80}$/); assert.match(plan.shard, /^browser-[123]$/);
  assert.equal(plan.output_root, `/evidence/shards/${plan.shard}/browser`);
  assert.equal(plan.environment.BB_TEST_DATABASE_URL, BROWSER_DATABASE);
  assert.equal(plan.environment.BB_TEST_AZURITE_CONNECTION_STRING, UPLOAD_CONFIRMATION_BLOB);
  return { schema: UPLOAD_CONFIRMATION_SCHEMA, root, commit: plan.commit, tree: plan.tree, run_id: plan.run_id, shard: plan.shard,
    output: plan.output_root + '/upload-confirmation', spool: `/tmp/bb-pr-gate-upload-${plan.run_id}-${plan.shard}`,
    database: BROWSER_DATABASE, storage: UPLOAD_CONFIRMATION_BLOB, container: UPLOAD_CONFIRMATION_CONTAINER,
    budget: BUDGET, lane: 'general', small_slot: false, poll_ms: 100 };
}

// Build from nothing: no shell credentials, proxy, NODE_OPTIONS, run/parse/model
// switches or developer .env are inherited by the dedicated consumer process.
export function browserUploadConfirmationEnvironment(config) {
  assert.deepEqual(config, browserUploadConfirmationConfig({ root: config.root, plan: { ...config, needs: { api: true },
    output_root: posix.dirname(config.output), environment: { BB_TEST_DATABASE_URL: config.database, BB_TEST_AZURITE_CONNECTION_STRING: config.storage } } }));
  return { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8', TMPDIR: '/tmp',
    DATABASE_URL: config.database, AZURE_STORAGE_CONNECTION_STRING: config.storage,
    BB_UPLOAD_CONFIRMATION_ENABLED: '1', BB_UPLOAD_CONFIRMATION_CONTAINER: config.container,
    BB_UPLOAD_CONFIRMATION_LANE: 'general', BB_UPLOAD_CONFIRMATION_SMALL_SLOT: '0', BB_UPLOAD_CONFIRMATION_POLL_MS: '100',
    BB_UPLOAD_SPOOL_DIR: config.spool, BB_UPLOAD_SPOOL_MAX_BYTES: String(BUDGET),
    PR_GATE_UPLOAD_CONFIRMATION_CONFIG: JSON.stringify(config) };
}

export function linuxProcessIdentity(pid = process.pid) {
  assert.equal(process.platform, 'linux'); assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const raw = readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
  assert.match(fields[19], /^\d+$/);
  return { pid, parent_pid: Number(fields[1]), start_ticks: fields[19], platform: 'linux' };
}

/** Injectable lifecycle; production adapters below always use the built runtime.
 * No lease query, event mutation or upload completion algorithm lives here. */
export async function runBrowserUploadConfirmationService(config, { signal, identity, sources, createSpool, connect, createRuntime, publish, log }) {
  const evidence = { ...config, status: 'starting', process: identity, sources, consumers: CONSUMERS,
    entry: 'apps/worker/dist/upload-confirmation-runtime.js#UploadConfirmationRuntime',
    started_at: stamp(), events: {}, errors: [], cleanup: { status: 'pending', steps: [] } };
  let spool, connection, runtime, drain, requestedAt;
  const stop = () => {
    requestedAt ??= stamp();
    if (runtime && !drain) {
      try { drain = Promise.resolve(runtime.stop()); } catch (error) { drain = Promise.reject(error); }
      // The finalizer records the error; avoid an unhandled rejection meanwhile.
      drain.catch(() => {});
    }
  };
  signal.addEventListener('abort', stop);
  const event = value => {
    try { log(value); }
    catch { evidence.errors.push('Upload confirmation event log could not be written'); stop(); }
    if (value.kind === 'upload_confirmation') {
      evidence.events[value.outcome] = (evidence.events[value.outcome] ?? 0) + 1;
      if (value.outcome === 'error') evidence.errors.push('Upload confirmation runtime reported an error');
    }
  };
  const save = type => publish(type, structuredClone(evidence));
  try {
    save('starting');
    spool = await createSpool(config); evidence.spool_identity = spool.identity;
    await spool.acquire();
    if (signal.aborted) return evidence;
    connection = await connect(config); evidence.database_probe = connection.database; evidence.storage_probe = connection.storage;
    if (signal.aborted) return evidence;
    runtime = createRuntime({ pool: connection.pool, blobs: connection.blobs, lane: 'general', smallSlot: false, pollMs: 100, log: event });
    runtime.start();
    evidence.status = 'ready'; evidence.ready_at = stamp(); save('ready');
    await new Promise(done => { if (signal.aborted) done(); else signal.addEventListener('abort', done, { once: true }); });
  } catch (error) {
    // Exceptions can contain storage URLs. Keep their class, not credentials or
    // SQL/body text; detailed safe runtime events are retained separately.
    evidence.errors.push(`Upload confirmation service failed (${error?.name ?? 'Error'})`);
  } finally {
    stop(); evidence.stop_requested_at = requestedAt;
    const cleanup = async (name, action) => {
      try { const result = await action(); evidence.cleanup.steps.push({ name, status: 'passed', ...(result ?? {}) }); }
      catch (error) { evidence.cleanup.steps.push({ name, status: 'failed', error: error?.name ?? 'Error' }); evidence.errors.push(`${name} failed`); }
    };
    // stop() disables new claims immediately and waits for the real consumer's
    // leased read/inspection/commit (and lease renewal) before releasing storage.
    if (runtime) await cleanup('drain', async () => { await drain; return { finished_at: stamp() }; });
    if (connection) await cleanup('pool', async () => { await connection.pool.end(); return { closed: true }; });
    if (spool) {
      if (!evidence.cleanup.steps.some(row => row.name === 'drain' && row.status === 'failed')) await cleanup('spool-release', () => spool.release());
      // Never remove storage after a failed drain/release. Preserve evidence and
      // fail the gate instead of deleting a live or unowned spool file.
      if (evidence.cleanup.steps.every(row => row.status === 'passed')) await cleanup('spool-remove', () => spool.remove());
    }
    signal.removeEventListener('abort', stop);
    evidence.finished_at = stamp(); evidence.status = evidence.errors.length ? 'failed' : 'stopped';
    evidence.cleanup.status = evidence.cleanup.steps.every(row => row.status === 'passed') ? 'passed' : 'failed';
    save('finished');
  }
  return evidence;
}

async function productionAdapters(config) {
  assert.equal(process.platform, 'linux'); assert.equal(config.root, '/workspace');
  const sourceProof = Object.fromEntries([...SOURCE_FILES, ...BUILT_FILES].map(path => [path, hash(readFileSync(join(config.root, path)))]));
  const [{ UploadConfirmationRuntime, confirmationConfig }, { acquireConfirmationSpool }, { reservedSpoolBytes }, { azureBlobs }, { Pool }, { BlobServiceClient }] = await Promise.all([
    import(pathToFileURL(join(config.root, BUILT_FILES[0]))), import(pathToFileURL(join(config.root, BUILT_FILES[1]))),
    import(pathToFileURL(join(config.root, 'apps/api/dist/upload-spool.js'))), import(pathToFileURL(join(config.root, 'apps/api/dist/data.js'))),
    import('pg'), import('@azure/storage-blob')]);
  const validated = confirmationConfig(process.env);
  assert.deepEqual(validated, { root: config.spool, budget: BUDGET, lane: 'general', smallSlot: false, pollMs: 100, container: config.container });
  return { sources: sourceProof, createRuntime: options => new UploadConfirmationRuntime(options),
    createSpool: async () => {
      assert.equal(posix.dirname(config.spool), '/tmp'); assert.equal(realpathSync('/tmp'), '/tmp');
      mkdirSync(config.spool, { mode: 0o700 }); // Exclusive: never adopt another process's directory.
      const created = lstatSync(config.spool), identity = { path: config.spool, dev: String(created.dev), ino: String(created.ino) };
      let release;
      const check = () => { const current = lstatSync(config.spool); assert.ok(current.isDirectory() && !current.isSymbolicLink());
        assert.equal(realpathSync(config.spool), config.spool); assert.equal(String(current.dev), identity.dev); assert.equal(String(current.ino), identity.ino); };
      return { identity, acquire: async () => { release = await acquireConfirmationSpool(config.spool, BUDGET); },
        release: async () => { assert.equal(reservedSpoolBytes(), 0, 'Upload bytes remain reserved after drain'); await release?.(); return { lock_released: true, reserved_bytes: 0 }; },
        remove: async () => {
          check(); const files = readdirSync(config.spool); assert.ok(files.every(name => name === '.confirmation.lock'), 'Upload spool still contains a file');
          if (files.length) { const lock = lstatSync(join(config.spool, files[0])); assert.ok(lock.isFile() && !lock.isSymbolicLink() && lock.nlink === 1); unlinkSync(join(config.spool, files[0])); }
          check(); rmdirSync(config.spool); assert.equal(existsSync(config.spool), false); return { removed: true, absence_confirmed: true };
        } };
    },
    connect: async () => {
      const pool = new Pool({ connectionString: config.database, max: 6, connectionTimeoutMillis: 10_000 });
      try {
        const row = (await pool.query("SELECT current_database() AS database, inet_server_port() AS port, current_user AS username, current_setting('server_version_num') AS version")).rows[0];
        assert.equal(row.database, 'bondbuddy_local'); assert.equal(row.port, 55433); assert.equal(row.username, 'bondbuddy');
        assert.ok(Number(row.version) >= 160000 && Number(row.version) < 170000);
        const container = BlobServiceClient.fromConnectionString(config.storage).getContainerClient(config.container);
        assert.equal(container.url, 'http://127.0.0.1:10000/devstoreaccount1/bondbuddy-private');
        await container.createIfNotExists(); await container.getProperties();
        return { pool, blobs: azureBlobs(config.storage, config.container), database: { status: 'passed', ...row },
          storage: { status: 'passed', endpoint: container.url, container: config.container } };
      } catch (error) { await pool.end(); throw error; }
    } };
}

export function verifyBrowserUploadConfirmation(record, plan, { final = false, pid, parentPid } = {}) {
  const config = browserUploadConfirmationConfig({ root: '/workspace', plan });
  for (const [key, value] of Object.entries(config)) assert.deepEqual(record?.[key], value, `Upload confirmation ${key} differs`);
  assert.deepEqual(record.consumers, CONSUMERS); assert.equal(record.entry, 'apps/worker/dist/upload-confirmation-runtime.js#UploadConfirmationRuntime');
  assert.equal(record.process.platform, 'linux'); assert.ok(Number.isSafeInteger(record.process.pid) && record.process.pid > 0);
  assert.ok(Number.isSafeInteger(record.process.parent_pid) && record.process.parent_pid > 0); assert.match(record.process.start_ticks, /^\d+$/);
  if (pid !== undefined) assert.equal(record.process.pid, pid); if (parentPid !== undefined) assert.equal(record.process.parent_pid, parentPid);
  for (const path of [...SOURCE_FILES, ...BUILT_FILES]) assert.match(record.sources[path], /^[a-f0-9]{64}$/);
  assert.equal(record.spool_identity.path, config.spool); for (const key of ['dev', 'ino']) assert.match(record.spool_identity[key], /^\d+$/);
  assert.equal(record.database_probe.status, 'passed'); assert.equal(record.database_probe.database, 'bondbuddy_local');
  assert.equal(record.database_probe.port, 55433); assert.equal(record.database_probe.username, 'bondbuddy');
  assert.ok(Number(record.database_probe.version) >= 160000 && Number(record.database_probe.version) < 170000);
  assert.deepEqual(record.storage_probe, { status: 'passed', endpoint: 'http://127.0.0.1:10000/devstoreaccount1/bondbuddy-private', container: config.container });
  assert.ok(record.events && typeof record.events === 'object' && !Array.isArray(record.events));
  for (const [outcome, count] of Object.entries(record.events)) {
    assert.ok(['completed', 'failed', 'retry', 'lease_lost', 'error'].includes(outcome)); assert.ok(Number.isSafeInteger(count) && count >= 0);
  }
  assert.equal(record.events.error ?? 0, 0);
  assert.deepEqual(record.errors, []); assert.ok(Date.parse(record.started_at) <= Date.parse(record.ready_at));
  if (!final) { assert.equal(record.status, 'ready'); return record; }
  assert.equal(record.status, 'stopped'); assert.equal(record.cleanup.status, 'passed');
  assert.deepEqual(record.cleanup.steps.map(row => [row.name, row.status]), ['drain', 'pool', 'spool-release', 'spool-remove'].map(name => [name, 'passed']));
  assert.equal(record.cleanup.steps[1].closed, true); assert.equal(record.cleanup.steps[2].lock_released, true); assert.equal(record.cleanup.steps[2].reserved_bytes, 0);
  assert.equal(record.cleanup.steps[3].removed, true); assert.equal(record.cleanup.steps[3].absence_confirmed, true);
  assert.ok(Date.parse(record.ready_at) <= Date.parse(record.stop_requested_at) && Date.parse(record.stop_requested_at) <= Date.parse(record.cleanup.steps[0].finished_at) && Date.parse(record.cleanup.steps[0].finished_at) <= Date.parse(record.finished_at));
  assert.equal(record.process_exit.code, 0); assert.equal(record.process_exit.signal, null); assert.equal(record.process_exit.stop_signal, 'SIGTERM');
  assert.equal(record.log.path, config.output + '/events.jsonl');
  assert.match(record.log.sha256, /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(record.log.bytes) && record.log.bytes >= 0);
  return record;
}

export async function startBrowserUploadConfirmation({ root, plan }) {
  const config = browserUploadConfirmationConfig({ root, plan });
  mkdirSync(config.output, { recursive: false });
  const evidence = { ...config, status: 'starting', cleanup: { status: 'pending' } };
  const save = () => writeFileSync(join(config.output, 'parent.json'), JSON.stringify(evidence, null, 2) + '\n');
  const child = fork(here, ['serve'], { cwd: root, env: browserUploadConfirmationEnvironment(config), execArgv: [],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  let ready, finished, failure, cleanupPromise;
  const exited = new Promise(done => { child.once('error', error => { failure = error; }); child.once('close', (code, signal) => done({ code, signal })); });
  const cleanup = () => cleanupPromise ??= (async () => {
    const alive = Number.isSafeInteger(child.pid) && child.exitCode === null && child.signalCode === null;
    if (alive) child.kill('SIGTERM');
    let timer;
    const result = await Promise.race([exited, new Promise(done => { timer = setTimeout(() => done(null), 120_000); })]); clearTimeout(timer);
    if (!result) { child.kill('SIGKILL'); await exited; failure ??= new Error('Upload confirmation drain timed out'); }
    Object.assign(evidence, finished ?? {}, { process_exit: { ...(result ?? { code: null, signal: 'SIGKILL' }), stop_signal: alive ? 'SIGTERM' : null } });
    try {
      assert.ifError(failure); assert.ok(ready && finished, 'Upload confirmation readiness/final evidence is missing');
      verifyBrowserUploadConfirmation(evidence, plan, { final: true, pid: child.pid, parentPid: process.pid });
    } catch (error) { evidence.status = 'failed'; evidence.parent_error = error.message; throw Object.assign(error, { uploadConfirmationEvidence: evidence }); }
    finally { save(); }
    return evidence;
  })();
  try {
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error('Upload confirmation readiness timed out')), 60_000);
      const failed = error => { clearTimeout(timer); reject(error); };
      child.on('message', message => {
        if (message.type === 'finished') { finished = message.evidence; if (!ready) failed(new Error('Upload confirmation stopped before readiness')); }
        if (message.type === 'ready') {
          try { verifyBrowserUploadConfirmation(message.evidence, plan, { pid: child.pid, parentPid: process.pid });
            assert.deepEqual(message.evidence.process, linuxProcessIdentity(child.pid)); ready = message.evidence; Object.assign(evidence, ready); save(); clearTimeout(timer); done(); }
          catch (error) { failed(error); }
        }
      });
      child.once('error', failed); child.once('exit', () => { if (!ready) failed(new Error('Upload confirmation exited before readiness')); });
    });
    return { evidence, cleanup, isAlive: () => child.exitCode === null && child.signalCode === null };
  } catch (error) {
    failure ??= error;
    try { await cleanup(); } catch { /* retain the startup failure and cleanup evidence */ }
    throw Object.assign(error, { uploadConfirmationEvidence: evidence });
  }
}

async function serve() {
  const config = JSON.parse(process.env.PR_GATE_UPLOAD_CONFIRMATION_CONFIG);
  // The parent constructs this exact environment; reject mutation before imports.
  for (const [key, value] of Object.entries(browserUploadConfirmationEnvironment(config))) assert.equal(process.env[key], value);
  delete process.env.PR_GATE_UPLOAD_CONFIRMATION_CONFIG;
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop); process.once('disconnect', stop);
  const logPath = join(config.output, 'events.jsonl'); writeFileSync(logPath, '', { flag: 'wx', mode: 0o600 });
  const publish = (type, evidence) => {
    if (type === 'finished') { const bytes = readFileSync(logPath); evidence.log = { path: logPath, sha256: hash(bytes), bytes: bytes.length }; }
    writeFileSync(join(config.output, 'service.json'), JSON.stringify(evidence, null, 2) + '\n'); process.send?.({ type, evidence });
  };
  try {
    const adapters = await productionAdapters(config);
    const evidence = await runBrowserUploadConfirmationService(config, { ...adapters, identity: linuxProcessIdentity(), signal: controller.signal,
      publish, log: value => appendFileSync(logPath, JSON.stringify(value) + '\n') });
    process.exitCode = evidence.status === 'stopped' ? 0 : 1;
  } catch (error) {
    publish('finished', { ...config, status: 'failed', errors: [`Consumer setup failed (${error?.name ?? 'Error'})`], cleanup: { status: 'failed' } }); process.exitCode = 1;
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); process.removeListener('disconnect', stop); process.disconnect?.();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === here && process.argv[2] === 'serve') {
  serve().catch(() => { process.stderr.write('Browser upload confirmation supervision failed\n'); process.exitCode = 1; process.disconnect?.(); });
}
