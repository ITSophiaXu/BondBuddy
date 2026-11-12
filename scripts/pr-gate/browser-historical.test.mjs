import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { HISTORICAL_SOURCES, historicalBlobIdentity, historicalTree, verifyHistoricalRecord } from './browser-historical-source.mjs';
import { compareInstalledPackage, historicalDependencyClosure, npmTarFiles } from './browser-historical-dependencies.mjs';
import { createBrowserPlan, browserEnvironment } from './browser-profiles.mjs';
import { HISTORICAL_COLLECTORS } from './browser-dispatch.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
function tar(entries) {
  const blocks = [];
  for (const [name, content, type = '0'] of entries) {
    const bytes = Buffer.from(content), header = Buffer.alloc(512); header.write(name, 0); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257);
    const checksum = header.reduce((sum, byte) => sum + byte, 0); header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  const bytes = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])); return { bytes, sri: 'sha512-' + createHash('sha512').update(bytes).digest('base64') };
}
function locks() {
  const packageRow = (name, more = {}) => ({ version: '1.0.0', integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64'), resolved: 'https://registry.npmjs.org/' + name + '/-/one.tgz', ...more });
  const old = { lockfileVersion: 3, packages: {
    'apps/web': { dependencies: { '@bondbuddy/contracts': 'workspace:*' }, devDependencies: { vite: '1.0.0' } },
    'packages/contracts': { dependencies: { box: '1.0.0' }, devDependencies: { typescript: '1.0.0' } },
    'node_modules/vite': packageRow('vite', { dependencies: { box: '1.0.0' }, optionalDependencies: { native: '1.0.0' }, peerDependencies: { optionalPeer: '*' }, peerDependenciesMeta: { optionalPeer: { optional: true } } }),
    'node_modules/box': packageRow('box'), 'node_modules/typescript': packageRow('typescript'), 'node_modules/native': packageRow('native', { os: ['win32'], optional: true }),
  } }; return { old, current: structuredClone(old) };
}

test('historical tree proof is sensitive to complete file names, bytes and duplicate paths', () => {
  const files = [historicalBlobIdentity('src/a.ts', Buffer.from('export const a = 1;\n')), historicalBlobIdentity('src/b.ts', Buffer.from('export const b = 2;\n'))];
  const original = historicalTree(files); assert.match(original, /^[a-f0-9]{40}$/); assert.equal(historicalTree([...files].reverse()), original);
  assert.notEqual(historicalTree(files.slice(1)), original); assert.notEqual(historicalTree([...files, historicalBlobIdentity('src/extra.ts', Buffer.from(''))]), original);
  assert.notEqual(historicalTree([historicalBlobIdentity('src/a.ts', Buffer.from('export const a = 3;\n')), files[1]]), original);
  for (const rows of [[files[0], files[0]], [{ ...files[0], path: 'src/../escape' }], [{ ...files[0], path: '/absolute' }], [{ ...files[0], path: 'src\\escape' }]]) assert.throws(() => historicalTree(rows));
});

test('old commit, old contracts and prototype source identities cannot be interchanged', () => {
  assert.notEqual(HISTORICAL_SOURCES.history.objects['packages/contracts'], HISTORICAL_SOURCES.update.objects['packages/contracts']);
  for (const change of [source => source.commit = HISTORICAL_SOURCES.update.commit, source => source.tree = 'a'.repeat(40), source => source.objects['packages/contracts'] = HISTORICAL_SOURCES.update.objects['packages/contracts'], source => source.objects['product-prototype/public'] = 'f'.repeat(40)]) {
    const source = structuredClone(HISTORICAL_SOURCES.history); change(source);
    const record = { schema: 'pr-gate-historical-app-source-v1', root: '/opt/pr-gate-historical-browser', not_a_seal: true, not_execution_evidence: true,
      profile_sha256: digest(JSON.stringify(HISTORICAL_SOURCES)), sources: { history: { source, files: [] }, update: { source: HISTORICAL_SOURCES.update, files: [] } } };
    assert.throws(() => verifyHistoricalRecord(record), /Expected values to be strictly deep-equal/);
  }
});

test('actual dependency closure binds version, SRI, resolution and transitive relationships', () => {
  const { old, current } = locks(); const result = historicalDependencyClosure(old, current, { platform: 'linux', arch: 'x64' });
  assert.deepEqual(result.packages.map(row => row.path), ['node_modules/box', 'node_modules/typescript', 'node_modules/vite']); assert.deepEqual(result.excluded_platform_packages, ['node_modules/native']);
  // npm may classify the same exact package differently as workspace usage changes.
  current.packages['node_modules/box'].dev = true; assert.deepEqual(historicalDependencyClosure(old, current, { platform: 'linux', arch: 'x64' }), result);
  for (const mutate of [lock => lock.packages['node_modules/box'].version = '2', lock => lock.packages['node_modules/box'].integrity += 'bad', lock => delete lock.packages['node_modules/box'], lock => lock.packages['node_modules/vite'].dependencies = {}, lock => lock.packages['node_modules/vite'].resolved = 'https://elsewhere.test/one']) {
    const changed = structuredClone(current); mutate(changed); assert.throws(() => historicalDependencyClosure(old, changed, { platform: 'linux', arch: 'x64' }));
  }
  const missing = locks(); delete missing.old.packages['node_modules/box']; delete missing.current.packages['node_modules/box']; assert.throws(() => historicalDependencyClosure(missing.old, missing.current));
});

test('npm cache verifier accepts a uniform DT archive root and refuses byte drift, aliases and escapes', () => {
  const archive = tar([['node/package.json', '{"name":"synthetic-only"}'], ['node/index.d.ts', 'export {};']]);
  const files = npmTarFiles(archive.bytes, archive.sri); assert.equal(files.size, 2);
  assert.equal(compareInstalledPackage(new Map(files), files, 'synthetic-only').length, 64);
  assert.throws(() => npmTarFiles(Buffer.concat([archive.bytes, Buffer.from('changed')]), archive.sri), /SRI/);
  for (const change of [map => map.delete('index.d.ts'), map => map.set('derived-bin', { sha256: digest('derived'), bytes: 7 }), map => map.set('index.d.ts', { sha256: digest('changed'), bytes: 7 })]) {
    const actual = new Map(files); change(actual); assert.throws(() => compareInstalledPackage(actual, files, 'synthetic-only'));
  }
  for (const entries of [[['package/package.json', '{}'], ['other/x', '']], [['package/package.json', '{}'], ['package/package.json', '{}']], [['package/package.json', '{}'], ['package/../escape', '']], [['package/package.json', '{}'], ['package/alias', '', '2']]]) {
    const broken = tar(entries); assert.throws(() => npmTarFiles(broken.bytes, broken.sri));
  }
});

test('plans name both old applications without enabling their flags in the shared current environment', () => {
  const files = [...Object.values(HISTORICAL_COLLECTORS).map(row => row.test_id), 'apps/web/tests/consistency-history.spec.ts'];
  const plan = createBrowserPlan({ candidate: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, runId: 'synthetic-history', shard: 'browser-1', files, sourceBlob: path => Buffer.from(path) });
  assert.deepEqual(plan.historical_apps, ['history', 'update']);
  const env = browserEnvironment({ BB_TEST_LIVE_AUTHORING: '0', BB_PLATFORM_PROBE_ENABLED: '0', BB_REVIEW_WEB_SEARCH_ENABLED: '0', BB_CONSISTENCY_HISTORY_BASELINE: '1', BB_UPDATE_HISTORY_BASELINE: '1' }, plan).env;
  for (const { flag } of Object.values(HISTORICAL_COLLECTORS)) assert.equal(env[flag], undefined);
  assert.equal(env.BB_E2E_BASE_URL, 'https://127.0.0.1:5173');
});
