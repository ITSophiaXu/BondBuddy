import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CACHE_FILES, OFFLINE_SCHEMA, compareCacheFiles, hash, inspectOfflineContainer, inspectOfflineImage, isolatedCommand, offlineImageArgument, verifyOfflineCache } from './offline-cache.mjs';
import { REFERENCE_ROOT, QA_BASELINE_ROOT } from './browser-reference-source.mjs';
import { syntheticInternalNetwork } from './internal-network.test-fixture.mjs';

const image = 'sha256:' + 'd'.repeat(64);
const candidate = Object.fromEntries(CACHE_FILES.map((path, i) => [path, Buffer.from(`synthetic dependency input ${i}\n`)]));
const expected = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), cache_files: Object.fromEntries(CACHE_FILES.map(path => [path, hash(candidate[path])])) };
function fixture() {
  return { schema: OFFLINE_SCHEMA, status: 'passed', ...expected, image_id: image, network: 'internal', network_id: 'a'.repeat(64), environment: 'allowlist-env-i',
    old_source_removed: true, old_node_modules_removed: true, restored: { commit: expected.commit, tree: expected.tree, clean_tree: true, shallow: true },
    files: compareCacheFiles(candidate, candidate), npm: { mode: 'ci-offline', tree_check: 'passed' },
    python: { status: 'passed', requirements: [{ requirement: 'synthetic>=1', installed: '1' }] },
    browser: { status: 'passed', navigator_online: true, version: 'synthetic', executable_sha256: 'e'.repeat(64) } };
}

test('offline mode requires one immutable local image ID and never accepts tags or extra options', () => {
  assert.equal(offlineImageArgument([]), null); assert.equal(offlineImageArgument(['--offline-image', image]), image);
  for (const args of [['--offline-image', 'cached:latest'], ['--offline-image'], ['--offline-image', image, '--skip'], ['--image', image]])
    assert.throws(() => offlineImageArgument(args));
});

test('cache image rejects wrong identity, non-Linux, implicit volumes and credential environment', () => {
  const metadata = { Id: image, Os: 'linux', Architecture: 'amd64', Config: { WorkingDir: '/workspace', Env: ['PATH=/usr/bin', 'BB_TEST_LIVE_AUTHORING=1'] } };
  assert.equal(inspectOfflineImage(metadata, image).image_id, image);
  for (const mutate of [x => x.Id = 'sha256:' + 'f'.repeat(64), x => x.Os = 'windows', x => x.Config.WorkingDir = '/app',
    x => x.Config.Volumes = { '/workspace': {} }, x => x.Config.Env.push('MODEL_API_KEY=synthetic-secret')]) {
    const copy = structuredClone(metadata); mutate(copy); assert.throws(() => inspectOfflineImage(copy, image));
  }
});

test('cached process command explicitly replaces rather than extends inherited environment', () => {
  const command = isolatedCommand(['node', 'scripts/pr-gate/run.mjs'], { CI: '1', GITHUB_SHA: expected.commit });
  assert.deepEqual(command.slice(0, 2), ['/usr/bin/env', '-i']);
  assert.ok(command.includes('GITHUB_SHA=' + expected.commit));
  assert.deepEqual(command.slice(-2), ['node', 'scripts/pr-gate/run.mjs']);
  assert.ok(!command.some(arg => arg.startsWith('BB_TEST_LIVE_AUTHORING=') || arg.startsWith('NODE_OPTIONS=') || arg.startsWith('NODE_PATH=')));
  assert.throws(() => isolatedCommand(['node'], { 'bad-key': 'x' }));
  assert.throws(() => isolatedCommand(['node'], { BAD: 'bad\0value' }));
});

test('dependency comparison permits CRLF pairs only, preserves byte hashes, rejects semantic or whitespace edits', () => {
  const crlf = Object.fromEntries(CACHE_FILES.map(path => [path, Buffer.from(candidate[path].toString().replaceAll('\n', '\r\n'))]));
  assert.throws(() => compareCacheFiles({ ...candidate, 'package-lock.json': Buffer.from([255]) }, { ...candidate, 'package-lock.json': Buffer.from('\uFFFD') }));
  const rows = compareCacheFiles(crlf, candidate);
  assert.equal(rows.length, 3); assert.ok(rows.every(row => row.raw_sha256 !== row.candidate_sha256 && row.exact_normalized_bytes_equal));
  for (const path of CACHE_FILES) {
    assert.throws(() => compareCacheFiles({ ...candidate, [path]: Buffer.from(candidate[path].toString() + ' ') }, candidate));
    assert.throws(() => compareCacheFiles({ ...candidate, [path]: undefined }, candidate));
  }
  assert.throws(() => compareCacheFiles({ ...candidate, 'package-lock.json': Buffer.from('{"x":1}\n') }, { ...candidate, 'package-lock.json': Buffer.from('{ "x": 1 }\n') }));
});

test('actual runner inspection rejects an unowned network, published port, source mount or privileged mode', () => {
  const { identity, container } = syntheticInternalNetwork();
  const value = { ...container, Image: image, Config: { User: '0:0', WorkingDir: '/workspace' },
    Mounts: [{ Type: 'bind', Destination: '/evidence', RW: true }, { Type: 'bind', Destination: '/opt/pr-gate-parser106', RW: false },
      { Type: 'bind', Destination: REFERENCE_ROOT, RW: false }, { Type: 'bind', Destination: QA_BASELINE_ROOT, RW: false }] };
  assert.equal(inspectOfflineContainer(value, image, identity).published_ports, 0);
  for (const mutate of [x => x.HostConfig.NetworkMode = 'host', x => x.HostConfig.PortBindings = { '5432/tcp': [{}] },
    x => x.HostConfig.Privileged = true, x => x.HostConfig.CapAdd = ['SYS_ADMIN'], x => x.Mounts[1].RW = true,
    x => x.Mounts[2].RW = true, x => x.Mounts[2].Destination += '-wrong', x => x.Mounts.pop(),
    x => x.Mounts[3].RW = true, x => x.Mounts[3].Destination += '-wrong',
    x => x.Mounts.push({ Type: 'bind', Destination: '/workspace', RW: true }), x => x.Image = 'sha256:' + 'f'.repeat(64)]) {
    const copy = structuredClone(value); mutate(copy); assert.throws(() => inspectOfflineContainer(copy, image, identity));
  }
});

test('offline receipt requires current candidate blobs, fresh source and real dependency/browser preparation', () => {
  const valid = fixture(); assert.equal(verifyOfflineCache(valid, expected), valid);
  for (const mutate of [x => x.commit = 'f'.repeat(40), x => x.tree = 'f'.repeat(40), x => x.old_source_removed = false,
    x => x.old_node_modules_removed = false, x => x.network = 'bridge', x => x.environment = 'inherited',
    x => x.restored.clean_tree = false, x => x.restored.tree = 'f'.repeat(40), x => x.files.pop(),
    x => x.files[0].candidate_sha256 = 'f'.repeat(64), x => x.npm.mode = 'ci-online', x => x.npm.tree_check = 'failed',
    x => delete x.python, x => x.python.requirements = [], x => delete x.browser, x => x.browser.status = 'failed', x => x.browser.navigator_online = false,
    x => delete x.network_id]) {
    const copy = structuredClone(valid); mutate(copy); assert.throws(() => verifyOfflineCache(copy, expected));
  }
});
