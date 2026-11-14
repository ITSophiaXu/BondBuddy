import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TEMPLATE_DATABASE } from '../capabilities.mjs';

export const SERVICE_AUTHORING_TEST = 'apps/worker/src/file-authoring.pg.test.ts';
export const SERVICE_AUTHORING_RUN = 'apps/worker/dist/file-authoring.pg.test.js';
export const SERVICE_AUTHORING_TESTS = Object.freeze({
  [SERVICE_AUTHORING_TEST]: Object.freeze({ run: SERVICE_AUTHORING_RUN, cases: 1 }),
  'apps/worker/src/review-file-delivery.pg.test.ts': Object.freeze({ run: 'apps/worker/dist/review-file-delivery.pg.test.js', cases: 4 }),
});
export const SERVICE_AUTHORING_PROFILE = 'service-authoring';
export const SERVICE_AUTHORING_HELPER = 'scripts/pr-gate/host-adapters/native-services-runtime.mjs';
export const SERVICE_AUTHORING_FILES = Object.freeze([
  ...Object.entries(SERVICE_AUTHORING_TESTS).flatMap(([file, value]) => [file, value.run]), SERVICE_AUTHORING_HELPER,
  'scripts/pr-gate/host-adapters/native-services.mjs', 'scripts/pr-gate/host-adapters/native-services.test-fixture.mjs',
  'apps/worker/test-fixtures/codex/fake-file-authoring.mjs',
  'apps/worker/test-fixtures/codex/review-files.mjs', 'apps/worker/test-fixtures/codex/fake-review-update.mjs',
  'apps/worker/src/review-file-stage.ts', 'apps/worker/dist/review-file-stage.js',
  'apps/worker/src/codex-file-permissions.ts', 'apps/worker/dist/codex-file-permissions.js',
  'apps/worker/src/codex-adapter.ts', 'apps/worker/dist/codex-adapter.js',
  'deploy/m1/scripts/codex-bwrap.sh', 'deploy/m1/security/codex-seccomp.json',
]);
export const SERVICE_AUTHORING_ENVIRONMENT = Object.freeze({
  PATH: '/opt/venv/bin:/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8', TMPDIR: '/tmp', CI: '1',
  PYTHONPATH: '/app/python:/app/python/tests', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8',
  BONDBUDDY_TEST_PYTHON: '/opt/venv/bin/python', BB_PYTHON: '/opt/venv/bin/python', BB_CODEX_PATH: '/usr/local/bin:/usr/bin:/bin',
  BB_TEST_DATABASE_URL: TEMPLATE_DATABASE, BB_TEST_AZURITE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
  BB_TEST_LIVE_AUTHORING: '0', BB_PLATFORM_PROBE_ENABLED: '0', BB_REVIEW_WEB_SEARCH_ENABLED: '0',
});
export const SERVICE_AUTHORING_CANARY = 'BB_SYNTHETIC_SANDBOX_CANARY_NOT_A_CREDENTIAL\n';
export const serviceAuthoringEnvCommand = args => ['/usr/bin/env', '-i', ...Object.entries(SERVICE_AUTHORING_ENVIRONMENT).map(([key, value]) => key + '=' + value), ...args];
const sha = value => createHash('sha256').update(value).digest('hex');
const sync = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
};

function verifyRuntime() {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 1000); assert.equal(process.cwd(), '/app');
  assert.equal(process.execPath, '/usr/local/bin/node');
  assert.deepEqual({ ...process.env }, SERVICE_AUTHORING_ENVIRONMENT, 'Only the fixed synthetic service environment is allowed');
  const status = readFileSync('/proc/self/status', 'utf8');
  const security = Object.fromEntries(['CapEff', 'NoNewPrivs', 'Seccomp'].map(key => [key, status.match(new RegExp('^' + key + ':\\s*(.+)$', 'm'))?.[1]]));
  assert.deepEqual(security, { CapEff: '0000000000000000', NoNewPrivs: '1', Seccomp: '2' });
  const manifest = JSON.parse(readFileSync('/transfer/native-manifest.json', 'utf8'));
  for (const key of ['commit', 'tree']) assert.match(manifest[key], /^[a-f0-9]{40}$/);
  for (const file of SERVICE_AUTHORING_FILES) assert.match(manifest.files[file], /^[a-f0-9]{64}$/, 'Required candidate identity missing: ' + file);
  for (const [file, expected] of Object.entries(manifest.files)) assert.equal(sha(readFileSync(join('/app', file))), expected, 'Candidate changed: ' + file);
  assert.equal(sha(readFileSync('/usr/local/bin/bwrap')), manifest.files['deploy/m1/scripts/codex-bwrap.sh']);
  assert.equal(readFileSync('/run/secrets/bb-copilot-oauth', 'utf8'), SERVICE_AUTHORING_CANARY);
  assert.ok(readFileSync('/proc/1/environ').length > 0);
  return { commit: manifest.commit, tree: manifest.tree, uid: 1000, models: 0, security,
    network: 'core-internal', source_files: Object.fromEntries(SERVICE_AUTHORING_FILES.map(file => [file, manifest.files[file]])),
    node: { executable: process.execPath, version: process.version, sha256: sha(readFileSync(process.execPath)) },
    synthetic_canary_sha256: sha(SERVICE_AUTHORING_CANARY) };
}

async function probe() {
  const report = { ...verifyRuntime(), profile: SERVICE_AUTHORING_PROFILE, status: 'failed', checks: {} };
  report.checks.tools = Object.fromEntries([['python', '/opt/venv/bin/python'], ['codex', '/usr/local/bin/codex'], ['bwrap', '/usr/bin/bwrap']]
    .map(([name, executable]) => [name, { executable, version: sync(executable, ['--version']), sha256: sha(readFileSync(executable)) }]));
  report.checks.python_authoring = sync('/opt/venv/bin/python', ['-c', 'from docx import Document; from pypdf import PdfWriter; from bondbuddy_file_authoring.check import package,clean,parse_xml; from bondbuddy_file_authoring.fixed_edit import load_editor; print("BB_AUTHORING_IMPORTS_OK")']);
  const { verifyFilePermissions } = await import(pathToFileURL('/app/apps/worker/dist/codex-file-permissions.js').href);
  const area = mkdtempSync('/tmp/bb-service-authoring-probe-'), cwd = join(area, 'job'), home = join(area, 'home');
  try {
    for (const directory of [cwd, home, join(cwd, 'scratch'), join(cwd, 'output')]) mkdirSync(directory, { mode: 0o700 });
    writeFileSync(join(cwd, 'input.json'), '{}');
    await verifyFilePermissions({ command: ['/usr/local/bin/codex'], path_env: '/usr/local/bin:/usr/bin:/bin' }, cwd, home);
    assert.equal(readFileSync(join(cwd, 'input.json'), 'utf8'), '{}'); report.checks.original_permission_probe = true;
  } finally {
    assert.ok(resolve(area).startsWith('/tmp/bb-service-authoring-probe-')); rmSync(area, { recursive: true, force: true });
  }
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: TEMPLATE_DATABASE, connectionTimeoutMillis: 5000 });
  try {
    const result = await pool.query({ text: "SELECT current_database() AS name, current_user AS username, current_setting('server_version_num')::int AS version", query_timeout: 5000 });
    report.database = result.rows[0]; assert.equal(report.database.name, 'bb_m4_core'); assert.equal(report.database.username, 'bondbuddy');
    assert.ok(report.database.version >= 160000 && report.database.version < 170000);
  } finally { await pool.end(); }
  const { BlobServiceClient } = await import('@azure/storage-blob');
  const blobs = BlobServiceClient.fromConnectionString(SERVICE_AUTHORING_ENVIRONMENT.BB_TEST_AZURITE_CONNECTION_STRING, { retryOptions: { maxTries: 1, tryTimeoutInMs: 5000 } });
  assert.equal(blobs.url, 'http://127.0.0.1:10000/devstoreaccount1');
  await blobs.getProperties(); report.blob = { endpoint: blobs.url, readable: true };
  report.status = 'passed'; return report;
}

// Importing the constants in static gate unit tests must never run a probe.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    assert.equal(process.argv.length, 3);
    const mode = process.argv[2]; assert.ok(['probe', 'verify'].includes(mode));
    console.log(JSON.stringify(mode === 'probe' ? await probe() : { ...verifyRuntime(), status: 'passed' }));
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
