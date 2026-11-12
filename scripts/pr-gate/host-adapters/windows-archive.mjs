import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { billingHostEnvironment, verifyBillingSource } from './windows-billing.mjs';

export const ARCHIVE_TEST = 'scripts/release-smoke/archive.test.mjs';
export const ARCHIVE_PROFILE = 'windows-archive';
const digest = value => createHash('sha256').update(value).digest('hex');
const MAX_OUTPUT = 8 * 1024 * 1024;

export function validateArchiveRequest({ candidate, runId, entry }) {
  for (const key of ['commit', 'tree']) assert.match(candidate?.[key] ?? '', /^[a-f0-9]{40}$/);
  assert.match(runId ?? '', /^[a-zA-Z0-9-]{8,80}$/);
  assert.equal(entry?.profileId, ARCHIVE_PROFILE);
  assert.equal(entry.testId, ARCHIVE_TEST); assert.equal(entry.runPath, ARCHIVE_TEST);
  assert.equal(entry.runner, 'node'); assert.equal(entry.group, 'scripts'); assert.equal(entry.shard, 'misc');
  assert.ok(Number.isSafeInteger(entry.sequence) && entry.sequence >= 0);
  assert.equal(entry.fileTimeoutMs, 300_000, 'Original archive file budget must not change');
  assert.match(entry.sourceSha256 ?? '', /^[a-f0-9]{64}$/);
  for (const key of ['args', 'argv', 'env', 'command', 'cwd', 'executable'])
    assert.equal(Object.hasOwn(entry, key), false, 'Archive requests cannot carry commands or environment');
}

export function archiveHostEnvironment(input, temporaryRoot, home) {
  const inherited = Object.fromEntries(Object.entries(billingHostEnvironment(input)).filter(([key]) => !/^(TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH)$/i.test(key)));
  const env = { ...inherited, TEMP: temporaryRoot, TMP: temporaryRoot,
    HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  // This is a trusted host setting already supported by the original test, never a dispatch request value.
  if (input.BB_RELEASE_TEST_PYTHON) env.BB_RELEASE_TEST_PYTHON = input.BB_RELEASE_TEST_PYTHON;
  return env;
}

export function parseWindowsPython(output) {
  const value = JSON.parse(output);
  assert.equal(value.platform, 'win32', 'Archive extraction must use actual Windows Python');
  assert.ok(Array.isArray(value.version) && value.version.length === 3 && value.version.every(n => Number.isSafeInteger(n) && n >= 0));
  assert.ok(value.version[0] > 3 || (value.version[0] === 3 && value.version[1] >= 12), 'Existing Python 3.12+ required');
  assert.ok(typeof value.executable === 'string' && win32.isAbsolute(value.executable) && win32.parse(value.executable).root.length > 1, 'Exact Python executable required');
  return value;
}

export async function executeWindowsArchive(options) {
  validateArchiveRequest(options);
  assert.equal(process.platform, 'win32', 'Archive profile requires an actual Windows host');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22);
  const { candidate, runId, entry, signal } = options;
  const source = realpathSync(options.sourceRoot), parent = realpathSync(options.evidenceRoot);
  assert.ok(lstatSync(options.evidenceRoot).isDirectory() && !lstatSync(options.evidenceRoot).isSymbolicLink());
  const out = join(parent, 'windows-archive-' + entry.sequence); mkdirSync(out, { recursive: false });
  // Keep the Git fixture near the OS temp root, as the original test does. Evidence paths can exceed MAX_PATH.
  const temporaryParent = realpathSync(tmpdir()), temporaryOwner = mkdtempSync(join(temporaryParent, 'bb-ar-'));
  assert.equal(dirname(temporaryOwner), temporaryParent); assert.equal(realpathSync(temporaryOwner), temporaryOwner);
  assert.ok(!lstatSync(temporaryOwner).isSymbolicLink());
  writeFileSync(join(temporaryOwner, 'owner.json'), JSON.stringify({ run_id: runId, test_id: ARCHIVE_TEST, sequence: entry.sequence, pid: process.pid }) + '\n', { flag: 'wx' });
  const temporaryRoot = join(temporaryOwner, 'tmp'), home = join(temporaryOwner, 'home'); mkdirSync(temporaryRoot); mkdirSync(home);
  const env = archiveHostEnvironment(process.env, temporaryRoot, home);
  const evidence = { profile_id: ARCHIVE_PROFILE, ...candidate, run_id: runId, test_id: ARCHIVE_TEST,
    started_at: new Date().toISOString(), finished_at: null, platform: process.platform, source_root: source,
    commands: [], resources: [{ kind: 'temporary-directory', path: temporaryRoot, owner: temporaryOwner, retained: true }],
    cleanup: { status: 'pending' }, scope: 'original archive tests on Windows; temporary Git repositories and files only' };
  const save = () => writeFileSync(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  let execution, failure;
  const command = async (label, executable, args, timeoutMs) => {
    if (signal?.aborted) throw new Error('Gate cancelled before ' + label);
    const start = Date.now(), chunks = { stdout: [], stderr: [] }; let child, timedOut = false, cancelled = false, error, bytes = 0;
    const kill = () => { if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { env, windowsHide: true, stdio: 'ignore' }); };
    const abort = () => { cancelled = true; kill(); };
    const result = await new Promise(done => {
      child = spawn(executable, args, { cwd: source, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      for (const stream of ['stdout', 'stderr']) child[stream].on('data', data => {
        bytes += data.length;
        if (bytes <= MAX_OUTPUT) chunks[stream].push(data); else { error ??= new Error('Archive output exceeded original gate limit'); kill(); }
      });
      child.once('error', value => { error = value; });
      child.once('close', (code, childSignal) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); done({ code, signal: childSignal }); });
    });
    const stdout = Buffer.concat(chunks.stdout).toString('utf8'), stderr = Buffer.concat(chunks.stderr).toString('utf8');
    const durationMs = Date.now() - start;
    writeFileSync(join(out, label + '.stdout.log'), stdout); writeFileSync(join(out, label + '.stderr.log'), stderr);
    const record = { label, executable, args, cwd: source, timeout_ms: timeoutMs, started_at: new Date(start).toISOString(), durationMs,
      ...result, timedOut, cancelled, output_limit_failed: bytes > MAX_OUTPUT, stdout_sha256: digest(stdout), stderr_sha256: digest(stderr) };
    evidence.commands.push(record); if (label === 'archive-test') evidence.original_command = record; save();
    if (error) throw error; if (cancelled) throw new Error('Gate cancelled during ' + label);
    return { ...result, timedOut, stdout, stderr, durationMs };
  };
  try {
    evidence.source_before = verifyBillingSource(source, candidate, env);
    evidence.test_source_sha256 = digest(readFileSync(join(source, ARCHIVE_TEST)));
    assert.equal(evidence.test_source_sha256, entry.sourceSha256);
    evidence.node = { platform: process.platform, executable: realpathSync(process.execPath), version: process.versions.node,
      sha256: digest(readFileSync(process.execPath)) };
    const probe = await command('python-identity', env.BB_RELEASE_TEST_PYTHON || 'python',
      ['-I', '-c', 'import json,sys; print(json.dumps({"platform":sys.platform,"version":list(sys.version_info[:3]),"executable":sys.executable}))'], 30_000);
    assert.equal(probe.code, 0, 'Existing Windows Python probe failed'); assert.equal(probe.timedOut, false);
    const python = parseWindowsPython(probe.stdout), executable = realpathSync(python.executable);
    assert.ok(lstatSync(executable).isFile()); env.BB_RELEASE_TEST_PYTHON = executable;
    evidence.python = { ...python, executable, sha256: digest(readFileSync(executable)) };
    const support = await command('archive-support', executable, ['-I', join(source, 'scripts/release-smoke/extract-archive.py'), '--check'], 30_000);
    assert.equal(support.code, 0, 'Windows archive support is unavailable'); assert.equal(support.timedOut, false);
    execution = await command('archive-test', evidence.node.executable, ['--test', '--test-reporter=tap', ARCHIVE_TEST], entry.fileTimeoutMs);
  } catch (error) { failure = error; }
  finally {
    const errors = [], check = task => { try { task(); } catch (error) { errors.push(error.message); } };
    check(() => { evidence.source_after = verifyBillingSource(source, candidate, env); assert.deepEqual(evidence.source_after, evidence.source_before); });
    check(() => { assert.equal(dirname(temporaryOwner), temporaryParent); assert.equal(realpathSync(temporaryOwner), temporaryOwner);
      assert.deepEqual(JSON.parse(readFileSync(join(temporaryOwner, 'owner.json'), 'utf8')), { run_id: runId, test_id: ARCHIVE_TEST, sequence: entry.sequence, pid: process.pid });
      assert.equal(realpathSync(temporaryRoot), resolve(temporaryRoot)); assert.ok(!lstatSync(temporaryRoot).isSymbolicLink());
      evidence.temporary_remaining = readdirSync(temporaryRoot); assert.deepEqual(evidence.temporary_remaining, [], 'Original archive tests left temporary resources'); });
    check(() => { assert.equal(digest(readFileSync(evidence.node.executable)), evidence.node.sha256); });
    check(() => { assert.equal(digest(readFileSync(evidence.python.executable)), evidence.python.sha256); });
    evidence.cleanup = { status: errors.length ? 'failed' : 'passed', errors }; evidence.finished_at = new Date().toISOString(); save();
    if (errors.length) failure = new Error([failure?.message, ...errors].filter(Boolean).join('; '));
  }
  if (failure) { failure.execution = execution; failure.evidence = evidence; throw failure; }
  return { execution, evidence };
}
