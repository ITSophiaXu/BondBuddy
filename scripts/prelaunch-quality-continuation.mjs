#!/usr/bin/env node
// Own one disposable database and a credential-free child for this exact candidate.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

function templateDatabase(value) {
  const url = new URL(value);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Only a loopback test database is permitted');
  assert.match(url.pathname, /^\/(?:bb_m4_core|bb_prospectus_quality(?:_[a-z0-9_]+)?)$/);
  assert.equal(url.search, ''); assert.equal(url.hash, '');
  return url;
}

async function main() {
  assert.equal(process.platform, 'linux', 'Use the Linux integration workflow');
  const template = templateDatabase(process.env.BB_TEST_DATABASE_URL);
  const commit = git(['rev-parse', 'HEAD']), tree = git(['rev-parse', 'HEAD^{tree}']);
  assert.equal(git(['status', '--porcelain', '--untracked-files=no']), '', 'Build and test the committed candidate');
  const attempt = randomUUID().replaceAll('-', ''), databaseName = `bb_prelaunch_continuation_${attempt}`;
  const logs = resolve(root, '.local/prelaunch-continuation-logs', commit, attempt);
  mkdirSync(logs, { recursive: true });
  const requiredFiles = ['scripts/prelaunch-quality-continuation.mjs', 'scripts/prelaunch-quality-continuation.integration.mjs',
    'apps/api/src/server.ts', 'apps/api/dist/server.js', 'apps/api/src/queue.ts', 'apps/api/dist/queue.js',
    'apps/api/src/none-baseline.ts', 'apps/api/dist/none-baseline.js',
    'apps/worker/src/run-pipeline.ts', 'apps/worker/dist/run-pipeline.js',
    'apps/worker/src/file-authoring-stage.ts', 'apps/worker/dist/file-authoring-stage.js',
    'apps/worker/src/file-authoring-quality.ts', 'apps/worker/dist/file-authoring-quality.js',
    'apps/worker/src/unified-input.ts', 'apps/worker/dist/unified-input.js',
    'apps/api/src/production-rule-pin.ts', 'apps/api/dist/production-rule-pin.js',
    'apps/web/src/authoring-continuation.ts', 'apps/web/dist-test/authoring-continuation.js',
    'apps/web/src/first-draft-confirmation.ts', 'apps/web/dist-test/first-draft-confirmation.js',
    'python/bondbuddy_file_authoring/quality.py', 'python/bondbuddy_file_authoring/check.py',
    'python/bondbuddy_file_authoring/format_diff.py', 'python/bondbuddy_file_authoring/source_outline.py',
    'python/bondbuddy_file_authoring/period_definitions.py', 'python/bondbuddy_file_authoring/template_manifest.py',
    'python/bondbuddy_file_authoring/word_patch.py', 'python/bondbuddy_word_delivery/writer.py',
    'package.json', 'package-lock.json', 'python/requirements.txt', 'python/requirements-dev.txt'];
  const tempRoot = resolve(tmpdir());
  const home = mkdtempSync(resolve(tempRoot, 'bb-prelaunch-continuation-home-'));
  const inherited = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'BONDBUDDY_TEST_PYTHON', 'BONDBUDDY_WORD_PYTHON', 'BB_PYTHON']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const maintenance = new URL(template); maintenance.pathname = '/postgres';
  const database = new URL(template); database.pathname = `/${databaseName}`;
  const env = { ...inherited, HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home,
    XDG_CONFIG_HOME: resolve(home, 'config'), CODEX_HOME: resolve(home, 'codex'),
    BB_TEST_DATABASE_URL: database.href, BB_PRELAUNCH_CONTINUATION_ISOLATED: '1',
    NODE_ENV: 'test', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' };
  const fingerprintCode = () => {
    const paths = new Set(requiredFiles);
    const collect = directory => {
      for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = `${directory}/${entry.name}`;
        if (entry.name === '__pycache__') continue;
        assert.equal(entry.isSymbolicLink(), false, `Unexpected code symlink: ${path}`);
        if (entry.isDirectory()) collect(path);
        else if (['.ts', '.js', '.mjs', '.json', '.py'].includes(extname(path))) paths.add(path);
      }
    };
    // These complete source/compiled trees include input_lock and all its static
    // imports, rather than just fingerprinting the small integration entry points.
    for (const workspace of ['apps/api', 'apps/worker', 'packages/contracts', 'packages/domain', 'packages/rule-pack-registry', 'packages/rule-applicability-context']) {
      collect(`${workspace}/src`); collect(`${workspace}/dist`); paths.add(`${workspace}/package.json`);
    }
    collect('apps/web/src'); collect('apps/web/dist-test'); paths.add('apps/web/package.json'); collect('python');
    const installed = JSON.parse(execFileSync(env.BONDBUDDY_WORD_PYTHON || env.BONDBUDDY_TEST_PYTHON || env.BB_PYTHON || 'python3',
      ['-I', '-B', '-c', 'import json,sys,lxml.etree; print(json.dumps({"python":sys.executable,"lxml":lxml.etree.__file__}))'],
      { cwd: root, env, encoding: 'utf8', timeout: 15_000 }));
    return Object.fromEntries([
      ...[...paths].sort().map(path => [path, hash(readFileSync(resolve(root, path)))]),
      ...Object.entries(installed).sort(([a], [b]) => a.localeCompare(b)).map(([name, path]) => [`installed:${name}:${path}`, hash(readFileSync(path))])
    ]);
  };
  let Client;
  const withMaintenance = async work => {
    const client = new Client({ connectionString: maintenance.href, connectionTimeoutMillis: 10_000, query_timeout: 30_000 });
    await client.connect();
    try { return await work(client); } finally { await client.end(); }
  };
  let created = false, creationAttempted = false, databaseCleanup = 'not_created', failure, result, fingerprints, fingerprintsAfter;
  const started = new Date().toISOString();
  try {
    ({ Client } = await import('pg'));
    fingerprints = fingerprintCode();
    await withMaintenance(async client => {
      assert.equal((await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [databaseName])).rowCount, 0);
      creationAttempted = true;
      await client.query(`CREATE DATABASE "${databaseName}" TEMPLATE "${decodeURIComponent(template.pathname.slice(1))}"`);
      created = true;
    });
    result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap',
      'scripts/prelaunch-quality-continuation.integration.mjs'], { cwd: root, env, encoding: 'utf8',
      timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
    writeFileSync(resolve(logs, 'continuation.tap'), result.stdout || '');
    writeFileSync(resolve(logs, 'continuation.stderr.log'), result.stderr || '');
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Continuation integration failed (${result.status ?? result.signal})`);
    for (const name of ['fail', 'cancelled', 'skipped', 'todo']) assert.match(result.stdout, new RegExp(`^# ${name} 0$`, 'm'));
    assert.match(result.stdout, /^# tests [1-9][0-9]*$/m);
    assert.equal(git(['rev-parse', 'HEAD']), commit); assert.equal(git(['rev-parse', 'HEAD^{tree}']), tree);
    assert.equal(git(['status', '--porcelain', '--untracked-files=no']), '');
    fingerprintsAfter = fingerprintCode();
    assert.deepEqual(fingerprintsAfter, fingerprints, 'Source, compiled and installed checker files changed during the run');
  } catch (error) { failure = error; }
  finally {
    const cleanupErrors = [];
    if (created) {
      try { await withMaintenance(client => client.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)); databaseCleanup = 'completed'; }
      catch (error) { databaseCleanup = 'inspect_errors'; cleanupErrors.push(error.message); }
    } else if (creationAttempted) {
      // A lost response may mean CREATE succeeded. Preserve that ambiguity for
      // inspection; never delete an unconfirmed database or claim it was cleaned.
      databaseCleanup = 'inspect_errors';
      cleanupErrors.push('Database CREATE outcome was not confirmed; inspect the recorded isolated database name');
    }
    try {
      const target = resolve(home);
      assert.equal(dirname(target), tempRoot, 'Cleanup must stay in the captured temporary root');
      assert.match(basename(target), /^bb-prelaunch-continuation-home-[A-Za-z0-9]{6}$/);
      if (existsSync(target)) {
        const stat = lstatSync(target); assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Cleanup home must remain the generated directory');
      }
      rmSync(target, { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(error.message); }
    writeFileSync(resolve(logs, 'candidate.json'), JSON.stringify({ schema_version: 'prelaunch-continuation-v1',
      commit, tree, started_at: started, finished_at: new Date().toISOString(), node: process.version,
      status: failure || cleanupErrors.length ? 'failed' : 'passed', child_exit: result?.status ?? null,
      child_signal: result?.signal ?? null, error: failure?.message ?? null, cleanup_errors: cleanupErrors,
      database: databaseName, database_cleanup: databaseCleanup,
      fingerprints, fingerprints_after: fingerprintsAfter ?? null,
      scope: 'synthetic principal/model/Word/Blob; real API/PG/queue/host checker/compiled guards; no release receipt' }, null, 2) + '\n');
    if (failure || cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors.map(value => Error(value))].filter(Boolean),
      [failure?.message, ...cleanupErrors].filter(Boolean).join('; '));
  }
  console.log(`Continuation mechanical evidence: ${logs}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
