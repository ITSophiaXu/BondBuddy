// Explicit local-only test runner. Creating/reading this file runs no command;
// the caller supplies the already-migrated template after root authorizes it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const root = process.cwd(), require = createRequire(import.meta.url), rawDatabase = process.argv[2];
assert.ok(rawDatabase, 'Supply the root-authorized migrated local test template URL');
const database = new URL(rawDatabase);
assert.ok(['127.0.0.1', 'localhost'].includes(database.hostname) && database.port === '15542', 'Only dedicated local PostgreSQL port 15542');
assert.ok(database.pathname.length > 1 && !['/postgres', '/template0', '/template1'].includes(database.pathname), 'A dedicated test template is required');
const out = resolve('.local/supplement-b1-20261027', `api-${new Date().toISOString().replaceAll(/[-:.]/g, '')}-${process.pid}`);
mkdirSync(out, { recursive: false });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceRoots = ['apps/api/src', 'db/migrations', 'packages/contracts/src', 'packages/domain/src',
  'packages/rule-pack-registry/src', 'packages/rule-applicability-context/src'];
const runtimeRoots = ['apps/api/dist', 'packages/contracts/dist', 'packages/domain/dist',
  'packages/rule-pack-registry/dist', 'packages/rule-applicability-context/dist'];
const sourceFiles = ['package.json', 'package-lock.json', 'apps/api/package.json', 'apps/api/tsconfig.json'];
function manifest(directories, files = []) {
  const paths = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', '__pycache__', '.pytest_cache'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path); else if (entry.isFile()) paths.push(path);
    }
  }
  directories.forEach(directory => walk(resolve(directory)));
  paths.push(...files.map(file => resolve(file)));
  return paths.map(path => { const bytes = readFileSync(path); return { path: relative(root, path).replaceAll('\\', '/'),
    bytes: bytes.length, sha256: sha(bytes) }; }).sort((a, b) => a.path.localeCompare(b.path));
}
const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true, encoding: 'utf8' });
assert.equal(gitHead.status, 0, gitHead.stderr);
const python = 'C:\\Users\\lezhai\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe';
const env = { ...process.env, BB_TEST_DATABASE_URL: rawDatabase,
  BONDBUDDY_WORD_PYTHON: process.env.BONDBUDDY_WORD_PYTHON ?? python,
  BONDBUDDY_TEST_PYTHON: process.env.BONDBUDDY_TEST_PYTHON ?? python,
  BB_PYTHON_BIN: process.env.BB_PYTHON_BIN ?? python };
const summary = { version: 1, startedAt: new Date().toISOString(), scope: 'B1 supplement quote API PostgreSQL and processing-plan regression',
  node: process.version, executable: process.execPath, baseCommit: gitHead.stdout.trim(),
  testTemplate: { host: database.hostname, port: database.port, database: decodeURIComponent(database.pathname.slice(1)) },
  sourceRoots, runtimeRoots, sourceFiles, invocations: [], sourceStable: null, runtimeStable: null, success: false,
  limitations: ['Synthetic provider history and DOCX bytes; no model, supplier, production billing/adoption or browser acceptance is established.'] };
const save = () => writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
const sourcesBefore = manifest(sourceRoots, sourceFiles);
writeFileSync(join(out, 'sources-before.json'), `${JSON.stringify(sourcesBefore, null, 2)}\n`);
writeFileSync(join(out, 'runner.mjs'), readFileSync(new URL(import.meta.url)));
save();
async function run(name, args) {
  process.stdout.write(`${name} started\n`);
  const started = Date.now(), stdoutPath = join(out, `${name}.stdout.log`), stderrPath = join(out, `${name}.stderr.log`);
  const stdout = createWriteStream(stdoutPath, { flags: 'wx' }), stderr = createWriteStream(stderrPath, { flags: 'wx' });
  const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  let spawnError = null;
  child.once('error', error => { spawnError = String(error); });
  const [exitCode, signal] = await new Promise(resolveExit => child.once('close', (code, terminatingSignal) => resolveExit([code, terminatingSignal])));
  await Promise.all([stdout, stderr].map(stream => new Promise((resolveStream, rejectStream) => {
    if (stream.writableFinished) return resolveStream();
    stream.once('finish', resolveStream); stream.once('error', rejectStream);
  })));
  const stdoutBytes = readFileSync(stdoutPath), stderrBytes = readFileSync(stderrPath), log = stdoutBytes.toString('utf8');
  const tap = {};
  for (const match of log.matchAll(/^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([0-9.]+)\s*$/gm)) tap[match[1]] = Number(match[2]);
  const result = { name, command: [process.execPath, ...args], exitCode, signal, durationMs: Date.now() - started,
    error: spawnError, stdout: { path: `${name}.stdout.log`, bytes: stdoutBytes.length, sha256: sha(stdoutBytes) },
    stderr: { path: `${name}.stderr.log`, bytes: stderrBytes.length, sha256: sha(stderrBytes) }, ...Object.keys(tap).length ? { tap } : {} };
  summary.invocations.push(result); save();
  process.stdout.write(`${name} exit=${exitCode} ${JSON.stringify(tap)}\n`);
  return exitCode === 0 && !spawnError;
}
let runtimeBefore = null;
try {
  if (!await run('build-api', [require.resolve('typescript/bin/tsc'), '-p', 'apps/api/tsconfig.json'])) process.exitCode = 1;
  else {
    runtimeBefore = manifest(runtimeRoots);
    writeFileSync(join(out, 'runtime-before.json'), `${JSON.stringify(runtimeBefore, null, 2)}\n`);
    const success = await run('quote-pg', ['--test', '--test-reporter=tap', '--test-concurrency=1', 'apps/api/dist/run-supplement-quote.pg.test.js']);
    const regression = success && await run('processing-plan-pg', ['--test', '--test-reporter=tap', '--test-concurrency=1', 'apps/api/dist/run-supplement-processing-plan.pg.test.js']);
    summary.success = success && regression;
  }
} catch (error) {
  summary.error = String(error); process.exitCode = 1;
} finally {
  const sourcesAfter = manifest(sourceRoots, sourceFiles);
  writeFileSync(join(out, 'sources-after.json'), `${JSON.stringify(sourcesAfter, null, 2)}\n`);
  summary.sourceStable = JSON.stringify(sourcesBefore) === JSON.stringify(sourcesAfter);
  if (runtimeBefore) {
    const runtimeAfter = manifest(runtimeRoots);
    writeFileSync(join(out, 'runtime-after.json'), `${JSON.stringify(runtimeAfter, null, 2)}\n`);
    summary.runtimeStable = JSON.stringify(runtimeBefore) === JSON.stringify(runtimeAfter);
  }
  summary.completedAt = new Date().toISOString();
  summary.success = summary.success && summary.sourceStable && summary.runtimeStable;
  save(); process.stdout.write(`${JSON.stringify(summary)}\n${out}\n`);
  if (!summary.success) process.exitCode = 1;
}
