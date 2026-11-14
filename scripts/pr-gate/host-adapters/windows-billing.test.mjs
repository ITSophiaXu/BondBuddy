import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { BILLING_TEST, billingHostEnvironment, validateBillingDockerEndpoint, unusedBillingSubnet, validateBillingRequest, verifyBillingSource, prepareBillingDependencies } from './windows-billing.mjs';

const candidate = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
const request = () => ({ candidate, runId: '1794000000000-test', entry: { sequence: 10, profileId: 'windows-billing', shard: 'misc', testId: BILLING_TEST, runPath: BILLING_TEST, runner: 'node', fileTimeoutMs: 300000 } });
function directory(task) {
  const base = realpathSync(tmpdir()), root = mkdtempSync(join(base, 'bb-windows-billing-test-'));
  try { return task(root); }
  finally {
    const actual = realpathSync(root), rel = relative(base, actual);
    assert.equal(dirname(actual), base); assert.ok(rel.startsWith('bb-windows-billing-test-') && !rel.includes(sep));
    rmSync(actual, { recursive: true, force: true });
  }
}
function repo(root) {
  const env = { ...billingHostEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_AUTHOR_NAME: 'Synthetic Gate', GIT_AUTHOR_EMAIL: 'gate@example.invalid', GIT_COMMITTER_NAME: 'Synthetic Gate', GIT_COMMITTER_EMAIL: 'gate@example.invalid' };
  const git = args => { const r = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=' + join(root, 'absent-hooks'), ...args], { cwd: root, env, encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git(['init', '--quiet']); writeFileSync(join(root, 'source.txt'), 'original\n'); git(['add', 'source.txt']); git(['commit', '-qm', 'synthetic']);
  return { candidate: { commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']) }, env, git };
}

test('billing request accepts only the planned original file with original bounds', () => {
  validateBillingRequest(request());
  for (const change of [{ profileId: 'native' }, { testId: 'scripts/other.test.mjs' }, { runPath: '../other.mjs' }, { runner: 'shell' }, { shard: 'api-1' }, { fileTimeoutMs: 300001 }, { fileTimeoutMs: 0 }, { sequence: -1 }, { argv: ['anything'] }, { env: {} }, { command: 'cmd' }]) {
    const value = request(); Object.assign(value.entry, change); assert.throws(() => validateBillingRequest(value));
  }
  for (const runId of ['', '../old', 'a/b', 'a\nb']) assert.throws(() => validateBillingRequest({ ...request(), runId }));
  assert.throws(() => validateBillingRequest({ ...request(), candidate: { ...candidate, commit: 'HEAD' } }));
});

test('host child environment discards inherited credentials, opt-ins and remote Docker configuration', () => {
  const cleaned = billingHostEnvironment({ PATH: 'local-path', SystemRoot: 'C:/Windows', TEMP: 'tmp', DATABASE_URL: 'production', OPENAI_API_KEY: 'secret', DOCKER_HOST: 'tcp://remote', DOCKER_CONTEXT: 'remote', NODE_OPTIONS: '--import hostile', NODE_EXTRA_CA_CERTS: 'external', BB_E2E_LIVE: '1', GIT_CONFIG_COUNT: '1' });
  assert.deepEqual(Object.keys(cleaned).sort(), ['GIT_ALLOW_PROTOCOL', 'GIT_NO_LAZY_FETCH', 'GIT_NO_REPLACE_OBJECTS', 'NODE_ENV', 'PATH', 'SystemRoot', 'TEMP'].sort());
  assert.equal(cleaned.PATH, 'local-path'); assert.equal(cleaned.NODE_ENV, 'test');
});

test('task bridge excludes existing Docker and host-route ranges without changing routing', () => {
  assert.equal(unusedBillingSubnet(['0.0.0.0/0', '10.238.0.0/24', '10.238.1.0/25', '192.168.0.0/16']), '10.238.2.0/24');
  assert.equal(unusedBillingSubnet(['10.238.0.0/23']), '10.238.2.0/24');
  assert.throws(() => unusedBillingSubnet(['10.0.0.0/8']), /No unused/);
  assert.throws(() => unusedBillingSubnet(['10.238.999.0/24']));
});

test('source evidence rejects changed HEAD, changed content and CRLF-only drift', () => directory(root => {
  const r = repo(root), before = verifyBillingSource(root, r.candidate, r.env);
  assert.equal(before.files, 1); assert.equal(before.raw_bytes_verified, true);
  assert.throws(() => verifyBillingSource(root, { ...r.candidate, tree: 'c'.repeat(40) }, r.env));
  writeFileSync(join(root, 'source.txt'), 'changed\n'); assert.throws(() => verifyBillingSource(root, r.candidate, r.env));
  writeFileSync(join(root, 'source.txt'), 'original\r\n'); assert.throws(() => verifyBillingSource(root, r.candidate, r.env));
  writeFileSync(join(root, 'source.txt'), 'original\n'); assert.deepEqual(verifyBillingSource(root, r.candidate, r.env), before);
}));

test('dependency preparation rejects wrong lock and retains current product packages', () => directory(root => {
  const source = join(root, 'source'), cache = join(root, 'cache');
  for (const path of [source, cache]) { mkdirSync(path); mkdirSync(join(path, 'node_modules')); mkdirSync(join(path, 'packages')); mkdirSync(join(path, 'packages/app')); writeFileSync(join(path, 'package.json'), JSON.stringify({ workspaces: ['packages/app'] })); writeFileSync(join(path, 'packages/app/package.json'), JSON.stringify({ name: '@bondbuddy/app' })); }
  writeFileSync(join(source, 'package-lock.json'), '{"version":1}\n'); writeFileSync(join(cache, 'package-lock.json'), '{"version":2}\n');
  assert.throws(() => prepareBillingDependencies(source, cache), /Dependency lock/);
  writeFileSync(join(cache, 'package-lock.json'), '{"version":1}\r\n'); writeFileSync(join(cache, 'node_modules/.package-lock.json'), '{}');
  mkdirSync(join(cache, 'node_modules/thirdparty')); writeFileSync(join(cache, 'node_modules/thirdparty/index.js'), 'existing');
  mkdirSync(join(cache, 'node_modules/.vite-temp')); writeFileSync(join(cache, 'node_modules/.vite-temp/keep'), 'cache');
  const proof = prepareBillingDependencies(source, cache);
  assert.equal(proof.installed, false); assert.equal(realpathSync(join(source, 'node_modules/@bondbuddy/app')), realpathSync(join(source, 'packages/app')));
  assert.equal(realpathSync(join(source, 'node_modules/thirdparty')), realpathSync(join(cache, 'node_modules/thirdparty')));
  assert.notEqual(realpathSync(join(source, 'node_modules/.vite-temp')), realpathSync(join(cache, 'node_modules/.vite-temp')));
  assert.equal(readFileSync(join(cache, 'node_modules/.vite-temp/keep'), 'utf8'), 'cache');
}));

test('Docker transport cannot redirect the Windows adapter to a remote host', () => {
  validateBillingDockerEndpoint('npipe:////./pipe/dockerDesktopLinuxEngine');
  for (const endpoint of ['tcp://127.0.0.1:2375', 'ssh://host', 'npipe:////remote/pipe/docker', 'unix:///var/run/docker.sock']) assert.throws(() => validateBillingDockerEndpoint(endpoint));
});
