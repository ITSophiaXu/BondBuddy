import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectInternalAttachment } from './internal-network.mjs';

export const CACHE_FILES = Object.freeze(['package-lock.json', 'python/requirements.txt', 'python/requirements-dev.txt']);
export const OFFLINE_SCHEMA = 'pr-gate-offline-cache-v1';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const OFFLINE_BASE_ENV = Object.freeze({ PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', LANG: 'C.UTF-8', TMPDIR: '/tmp' });

export function offlineImageArgument(args) {
  if (!args.length) return null;
  assert.ok(args.length === 2 && args[0] === '--offline-image', 'Usage: npm run pr-gate -- --offline-image sha256:<local-image-id>');
  assert.match(args[1], /^sha256:[a-f0-9]{64}$/, 'Offline cache requires an immutable local image ID, not a tag');
  return args[1];
}

export function inspectOfflineImage(metadata, expectedId) {
  assert.match(expectedId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(metadata?.Id, expectedId, 'Cached image identity changed');
  assert.equal(metadata.Os, 'linux');
  assert.equal(metadata.Config?.WorkingDir, '/workspace', 'Cache must keep dependency inputs under /workspace');
  assert.ok(!metadata.Config.Volumes || Object.keys(metadata.Config.Volumes).length === 0, 'Cache must not create implicit volumes');
  const names = (metadata.Config.Env ?? []).map(item => item.split('=', 1)[0]);
  assert.ok(names.every(name => !/(TOKEN|PASSWORD|SECRET|API_KEY|CREDENTIAL)/i.test(name)), 'Cache contains a credential-like environment variable');
  return { image_id: expectedId, os: metadata.Os, architecture: metadata.Architecture, cached_environment_keys: names.sort() };
}

export function inspectOfflineContainer(value, imageId, network) {
  assert.match(value?.Id, /^[a-f0-9]{64}$/); assert.equal(value.Image, imageId);
  assert.equal(value.Config?.User, '0:0'); assert.equal(value.Config?.WorkingDir, '/workspace');
  const attachment = inspectInternalAttachment(value, network); assert.equal(value.HostConfig.Privileged, false);
  assert.ok(!value.HostConfig.CapAdd?.length); assert.ok(!value.HostConfig.PortBindings || !Object.keys(value.HostConfig.PortBindings).length);
  const mounts = (value.Mounts ?? []).map(row => ({ type: row.Type, destination: row.Destination, writable: row.RW })).sort((a, b) => a.destination.localeCompare(b.destination));
  assert.deepEqual(mounts, [{ type: 'bind', destination: '/evidence', writable: true }, { type: 'bind', destination: '/opt/pr-gate-historical-browser', writable: false }, { type: 'bind', destination: '/opt/pr-gate-identity-parser106', writable: false },
    { type: 'bind', destination: '/opt/pr-gate-parser106', writable: false },
    { type: 'bind', destination: '/qa-single-start-baseline-20261029-5ec099a/BondBuddy-develop', writable: false },
    { type: 'bind', destination: '/remote-review-20261025-ffd637f/BondBuddy-develop', writable: false }]);
  return { container_id: value.Id, image_id: value.Image, user: '0:0', network: 'internal', ...attachment, privileged: false, published_ports: 0, mounts };
}

/** Every process starts with an allowlisted environment; image flags never leak into a test. */
export function isolatedCommand(args, environment) {
  assert.ok(Array.isArray(args) && args.length > 0);
  const env = { ...OFFLINE_BASE_ENV, ...environment };
  for (const [key, value] of Object.entries(env)) {
    assert.match(key, /^[A-Za-z_][A-Za-z0-9_]*$/);
    assert.equal(typeof value, 'string');
    assert.equal(value.includes('\0'), false);
  }
  return ['/usr/bin/env', '-i', ...Object.entries(env).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`), ...args];
}

/** Preserve source bytes and permit only the Windows CRLF -> LF conversion. */
export function compareCacheFiles(cached, candidate) {
  return CACHE_FILES.map(path => {
    const raw = cached[path], exact = candidate[path];
    assert.ok(Buffer.isBuffer(raw) && Buffer.isBuffer(exact), `Cache input missing: ${path}`);
    const converted = Buffer.from(raw.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');
    assert.ok(converted.equals(exact), `Cached ${path} differs from candidate beyond CRLF conversion`);
    return { path, raw_sha256: hash(raw), candidate_sha256: hash(exact), normalized_sha256: hash(converted),
      raw_bytes: raw.length, candidate_bytes: exact.length, conversion: 'CRLF pairs to LF only', exact_normalized_bytes_equal: true };
  });
}

export function verifyOfflineCache(record, expected) {
  assert.equal(record?.schema, OFFLINE_SCHEMA); assert.equal(record.status, 'passed');
  assert.equal(record.commit, expected.commit); assert.equal(record.tree, expected.tree);
  assert.match(record.image_id, /^sha256:[a-f0-9]{64}$/);
  assert.equal(record.network, 'internal'); assert.match(record.network_id, /^[a-f0-9]{64}$/); assert.equal(record.environment, 'allowlist-env-i');
  assert.equal(record.old_source_removed, true); assert.equal(record.old_node_modules_removed, true);
  assert.equal(record.restored?.commit, expected.commit); assert.equal(record.restored?.tree, expected.tree);
  assert.equal(record.restored?.clean_tree, true); assert.equal(record.restored?.shallow, true);
  assert.deepEqual(record.files?.map(row => row.path), [...CACHE_FILES]);
  for (const row of record.files) {
    assert.match(row.raw_sha256, /^[a-f0-9]{64}$/); assert.match(row.candidate_sha256, /^[a-f0-9]{64}$/);
    assert.equal(row.candidate_sha256, expected.cache_files?.[row.path], 'Cache input does not match expected candidate blob');
    assert.equal(row.candidate_sha256, row.normalized_sha256); assert.equal(row.exact_normalized_bytes_equal, true);
    assert.equal(row.conversion, 'CRLF pairs to LF only');
  }
  assert.equal(record.npm?.mode, 'ci-offline'); assert.equal(record.npm?.tree_check, 'passed');
  assert.equal(record.python?.status, 'passed'); assert.ok(record.python.requirements.length > 0);
  assert.equal(record.browser?.status, 'passed'); assert.ok(record.browser.version && record.browser.executable_sha256); assert.equal(record.browser.navigator_online, true);
  return record;
}

export async function restoreOfflineSource(environment = process.env) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const target = '/workspace', evidence = '/evidence/offline-cache';
  assert.equal(lstatSync(target).isSymbolicLink(), false);
  // Refuse to erase a bind/volume or any nested mount. This is only an image layer.
  const mounts = readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n').map(line => line.split(' ')[4]);
  assert.ok(mounts.every(path => path !== target && !path.startsWith(target + '/')), 'Cache workspace must not be a mounted host path');
  mkdirSync(evidence, { recursive: false });
  const cached = {}, candidate = {};
  for (const path of CACHE_FILES) {
    cached[path] = readFileSync(join(target, path));
    candidate[path] = readFileSync(join('/evidence/cache-candidate', path));
  }
  const record = { schema: OFFLINE_SCHEMA, status: 'failed', commit: environment.GITHUB_SHA, tree: environment.PR_GATE_TREE,
    image_id: environment.PR_GATE_OFFLINE_IMAGE, network: 'internal', network_id: environment.PR_GATE_NETWORK_ID, environment: 'allowlist-env-i',
    files: compareCacheFiles(cached, candidate), old_source_removed: false, old_node_modules_removed: false };
  for (const path of CACHE_FILES) writeFileSync(join(evidence, path.replaceAll('/', '__') + '.raw'), cached[path]);
  const save = () => writeFileSync(join(evidence, 'record.json'), JSON.stringify(record, null, 2) + '\n');
  save();
  rmSync('/workspace', { recursive: true }); mkdirSync('/workspace');
  record.old_source_removed = true;
  const { restoreGitSnapshot } = await import('/evidence/git-snapshot.mjs');
  record.restored = restoreGitSnapshot({ snapshotDirectory: '/evidence/source', destination: '/workspace',
    expectedCommit: record.commit, expectedTree: record.tree, expectedPackSha256: environment.PR_GATE_SNAPSHOT_PACK_SHA256 });
  record.old_node_modules_removed = !existsSync('/workspace/node_modules');
  assert.equal(record.old_node_modules_removed, true);
  for (const path of CACHE_FILES) assert.deepEqual(readFileSync(join(target, path)), candidate[path]);
  save(); return record;
}

export function inspectPython() {
  // packaging is already supplied by pip. No installer or network is invoked.
  const source = String.raw`import json, sys
from pathlib import Path
from importlib.metadata import version
try:
    from packaging.requirements import Requirement
except ImportError:
    from pip._vendor.packaging.requirements import Requirement
rows = []
for filename in ('python/requirements.txt', 'python/requirements-dev.txt'):
    for raw in Path(filename).read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or line == '-r requirements.txt':
            continue
        requirement = Requirement(line)
        if requirement.url or requirement.marker or requirement.extras:
            raise RuntimeError('Unsupported cached requirement: ' + line)
        actual = version(requirement.name)
        if actual not in requirement.specifier:
            raise RuntimeError('Installed dependency does not satisfy: ' + line)
        rows.append(dict(requirement=line, installed=actual))
print(json.dumps(dict(status='passed', executable=sys.executable, version=sys.version.split()[0], requirements=rows)))`;
  const result = spawnSync('/usr/local/bin/python', ['-c', source], { cwd: '/workspace', encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0) throw new Error('Existing Python dependencies do not satisfy the candidate requirements: ' + (result.stderr ?? result.error?.message));
  return JSON.parse(result.stdout);
}

export async function inspectBrowser() {
  const { chromium } = await import('/workspace/node_modules/playwright/index.mjs');
  const executable = chromium.executablePath(); assert.ok(existsSync(executable), 'Existing Playwright browser binary is missing');
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); await page.setContent('<title>synthetic offline gate probe</title><p>local only</p>');
    assert.equal(await page.title(), 'synthetic offline gate probe');
    const navigator_online = await page.evaluate(() => navigator.onLine); assert.equal(navigator_online, true, 'Chromium reports an offline interface');
    return { status: 'passed', navigator_online, version: browser.version(), executable, executable_sha256: hash(readFileSync(executable)), synthetic: true, model_calls: 0 };
  } finally { await browser?.close(); }
}

async function main(mode) {
  if (mode === 'restore') return restoreOfflineSource();
  const path = '/evidence/offline-cache/record.json', record = JSON.parse(readFileSync(path, 'utf8'));
  if (mode === 'dependencies') { record.npm = { mode: 'ci-offline', tree_check: 'passed' }; record.python = inspectPython(); }
  else if (mode === 'browser') { record.browser = await inspectBrowser(); record.status = 'passed'; verifyOfflineCache(record, { commit: process.env.GITHUB_SHA, tree: process.env.PR_GATE_TREE, cache_files: Object.fromEntries(CACHE_FILES.map(path => [path, hash(readFileSync(join('/workspace', path)))])) }); }
  else throw new Error('Usage: offline-cache.mjs restore | dependencies | browser');
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n'); return record;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).then(record => console.log(JSON.stringify({ status: record.status, commit: record.commit, tree: record.tree, image: record.image_id })), error => { console.error(error.message); process.exitCode = 1; });
}
