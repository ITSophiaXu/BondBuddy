import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_TEST, ARCHIVE_PROFILE, archiveHostEnvironment, parseWindowsPython, validateArchiveRequest } from './windows-archive.mjs';

const request = () => ({ candidate: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, runId: '1794000000000-synthetic',
  entry: { profileId: ARCHIVE_PROFILE, testId: ARCHIVE_TEST, runPath: ARCHIVE_TEST, sequence: 5, shard: 'misc', group: 'scripts',
    runner: 'node', sourceSha256: 'c'.repeat(64), fileTimeoutMs: 300_000 } });

test('archive adapter accepts only the complete exact file with its original budget', () => {
  assert.doesNotThrow(() => validateArchiveRequest(request()));
  for (const mutate of [r => { r.entry.testId = 'other.test.mjs'; }, r => { r.entry.runPath = '../outside'; },
    r => { r.entry.fileTimeoutMs++; }, r => { r.entry.fileTimeoutMs--; }, r => { r.entry.runner = 'python'; },
    r => { r.entry.profileId = 'windows-billing'; }, r => { r.entry.group = 'worker'; }, r => { r.entry.shard = 'worker-1'; },
    r => { r.entry.sourceSha256 = 'wrong'; }, r => { r.candidate.commit = 'HEAD'; }]) {
    const value = request(); mutate(value); assert.throws(() => validateArchiveRequest(value));
  }
  for (const key of ['args', 'argv', 'env', 'command', 'cwd', 'executable']) {
    const value = request(); value.entry[key] = 'untrusted'; assert.throws(() => validateArchiveRequest(value));
  }
});

test('archive host environment keeps existing tools and isolates temporary files without application credentials', () => {
  const env = archiveHostEnvironment({ PATH: 'existing-tools', SystemRoot: 'C:/Windows', Temp: 'old-temp', UserProfile: 'old-home',
    BB_RELEASE_TEST_PYTHON: 'C:/existing/python.exe', DATABASE_URL: 'production', OPENAI_API_KEY: 'secret',
    NODE_OPTIONS: '--import external', DOCKER_HOST: 'tcp://remote', GIT_CONFIG_COUNT: '1' }, 'C:/owned/tmp', 'C:/owned/home');
  assert.equal(env.PATH, 'existing-tools'); assert.equal(env.SystemRoot, 'C:/Windows');
  assert.equal(env.TEMP, 'C:/owned/tmp'); assert.equal(env.TMP, 'C:/owned/tmp');
  assert.equal(env.HOME, 'C:/owned/home'); assert.equal(env.USERPROFILE, 'C:/owned/home');
  assert.equal(env.BB_RELEASE_TEST_PYTHON, 'C:/existing/python.exe');
  for (const key of ['Temp', 'UserProfile', 'DATABASE_URL', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'DOCKER_HOST', 'GIT_CONFIG_COUNT'])
    assert.equal(Object.hasOwn(env, key), false, key);
});

test('Python capability evidence requires a real Windows identity and existing 3.12+ executable', () => {
  const identity = { platform: 'win32', version: [3, 12, 9], executable: 'C:/existing/python.exe' };
  assert.deepEqual(parseWindowsPython(JSON.stringify(identity)), identity);
  for (const change of [{ platform: 'linux' }, { version: [3, 11, 9] }, { version: [3, 12, -1] },
    { version: ['3', 12, 9] }, { executable: 'python' }, { executable: '/usr/bin/python3' }])
    assert.throws(() => parseWindowsPython(JSON.stringify({ ...identity, ...change })));
});
