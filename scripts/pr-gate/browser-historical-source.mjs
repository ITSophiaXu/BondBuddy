import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export const HISTORICAL_ROOT = '/opt/pr-gate-historical-browser';
const shared = { 'package.json': 'a25c5f954da60c69b5cc58b9e6a92ac3e1fc1ca4', 'package-lock.json': '734e48c4d2e07232d61961deef468d3ffea1aa94',
  'product-prototype/public': '8a7bf43c00df3fdb42e483749d3e67b9f5dab8ec' };
export const HISTORICAL_SOURCES = Object.freeze({
  history: { commit: '8c81e8f1032ba5e23657eb32a43d9dfd0c9612fe', tree: '08dfda840adbe15f2c60ee96aa495c703e7d7a09',
    objects: { ...shared, 'apps/web': 'c6c5158a88cd93bc3df9dfad934f9eea123fa281', 'packages/contracts': '505b88ca7eca0d2bf91ca4a7802ea7de79efb151' } },
  update: { commit: 'ce3f2a8dfd8ca64d3f78334c97576fbf47a586c9', tree: '36214345263f5750d9187010d6900437a4cb36f7',
    objects: { ...shared, 'apps/web': '2d52945e84e83aeafbad1fc29280d0fd983b974f', 'packages/contracts': '28c170be3295643ae9bdb977a02d69f0b86b859a' } },
  // Original collector application/fixtures; its explicit 5ec component aliases
  // remain separately pinned. This is intentionally a declared two-source baseline.
  qa: { commit: '5839177e404d247947de968b58dbb430622409ff', tree: '3d7b9b6d3873f64ffea40b11362255606b63524f',
    objects: { 'package.json': 'a25c5f954da60c69b5cc58b9e6a92ac3e1fc1ca4', 'package-lock.json': 'f5f9ee92bce8a62a931cc35773a2f78b0a721354',
      'apps/web': 'fb36bcedb71791d2e071b5ef5cc87b786635a254', 'packages/contracts': '82823b2b281c461b2483818b476861bc856d3117',
      'product-prototype/public': '083079c68d05a89be0d35eefa7c45d4631611de0' } },
});
export const historicalHash = value => createHash('sha256').update(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const HISTORICAL_PROFILE_SHA256 = historicalHash(HISTORICAL_SOURCES);
const gitHash = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
const canonical = path => resolve(path).replaceAll('\\', '/');
const within = (parent, child) => child === parent || child.startsWith(parent + '/');
const pathOK = path => assert.ok(typeof path === 'string' && !path.includes('\\') && !path.includes('\0') && path.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid historical source path');
function directory(path) { assert.ok(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink()); assert.equal(canonical(realpathSync(path)), canonical(path)); return canonical(path); }
export function historicalBlobIdentity(path, bytes) { return { path, blob: gitHash('blob', bytes), sha256: historicalHash(bytes), bytes: bytes.length }; }
export function historicalTree(rows, prefix = '') {
  const nodes = new Map();
  for (const row of rows.filter(row => row.path.startsWith(prefix))) {
    const path = row.path.slice(prefix.length), [name, ...tail] = path.split('/'); pathOK(path);
    if (!tail.length) { assert.ok(!nodes.has(name), 'Historical tree path conflict'); nodes.set(name, { directory: false, blob: row.blob }); }
    else { assert.notEqual(nodes.get(name)?.directory, false, 'Historical tree directory conflict'); nodes.set(name, { directory: true }); }
  }
  assert.ok(nodes.size > 0, 'Historical source subtree is empty');
  const entries = [...nodes].sort(([a, x], [b, y]) => Buffer.compare(Buffer.from(a + (x.directory ? '/' : '')), Buffer.from(b + (y.directory ? '/' : ''))));
  const bytes = Buffer.concat(entries.map(([name, value]) => Buffer.concat([Buffer.from(`${value.directory ? '40000' : '100644'} ${name}\0`),
    Buffer.from(value.directory ? historicalTree(rows, prefix + name + '/') : value.blob, 'hex')])));
  return gitHash('tree', bytes);
}
export function verifyHistoricalRecord(record, root = HISTORICAL_ROOT) {
  assert.equal(record?.schema, 'pr-gate-historical-app-source-v1'); assert.equal(record.root, root); assert.equal(record.profile_sha256, HISTORICAL_PROFILE_SHA256);
  assert.equal(record.not_a_seal, true); assert.equal(record.not_execution_evidence, true);
  assert.deepEqual(Object.keys(record.sources), Object.keys(HISTORICAL_SOURCES));
  for (const [id, source] of Object.entries(HISTORICAL_SOURCES)) {
    const actual = record.sources[id]; assert.deepEqual(actual.source, source);
    assert.ok(Array.isArray(actual.files) && actual.files.length > 0); assert.deepEqual(actual.files.map(row => row.path), [...new Set(actual.files.map(row => row.path))].sort());
    for (const row of actual.files) { pathOK(row.path); assert.match(row.blob, /^[a-f0-9]{40}$/); assert.match(row.sha256, /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(row.bytes) && row.bytes >= 0);
      assert.ok(Object.keys(source.objects).some(path => (path.endsWith('.json') ? row.path === path : row.path.startsWith(path + '/'))), 'Unexpected file outside historical application closure'); }
    for (const [path, digest] of Object.entries(source.objects)) {
      if (path.endsWith('.json')) assert.equal(actual.files.find(row => row.path === path)?.blob, digest, 'Historical root configuration differs');
      else assert.equal(historicalTree(actual.files, path + '/'), digest, 'Historical application subtree differs: ' + path);
    }
    assert.equal(actual.files_sha256, historicalHash(actual.files));
  }
  return record;
}
export function verifyHistoricalDirectory(root = HISTORICAL_ROOT) {
  directory(root); assert.deepEqual(readdirSync(root).sort(), Object.keys(HISTORICAL_SOURCES).sort());
  const sources = {};
  for (const [id, source] of Object.entries(HISTORICAL_SOURCES)) {
    const base = join(root, id), files = [];
    function walk(dir, prefix = '') {
      directory(dir);
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = prefix + entry.name; pathOK(path); const target = join(dir, entry.name), stat = lstatSync(target);
        assert.ok(!stat.isSymbolicLink(), 'Historical source cannot contain links');
        if (entry.isDirectory()) { assert.ok(Object.keys(source.objects).some(key => key.startsWith(path + '/') || path === key || path.startsWith(key + '/')), 'Unexpected historical source directory'); walk(target, path + '/'); }
        else { assert.ok(entry.isFile() && stat.nlink === 1, 'Historical source must contain ordinary unaliased files'); files.push(historicalBlobIdentity(path, readFileSync(target))); }
      }
    }
    walk(base); files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); sources[id] = { source, files, files_sha256: historicalHash(files) };
  }
  return verifyHistoricalRecord({ schema: 'pr-gate-historical-app-source-v1', root: canonical(root), profile_sha256: HISTORICAL_PROFILE_SHA256, not_a_seal: true, not_execution_evidence: true, sources }, canonical(root));
}
export function restoreHistoricalSource(repository, owner, evidenceRoot) {
  const parent = directory(dirname(owner)), dest = canonical(owner), evidence = directory(evidenceRoot);
  assert.equal(canonical(dirname(owner)), parent); assert.ok(!within(dest.toLowerCase(), evidence.toLowerCase()) && !within(evidence.toLowerCase(), dest.toLowerCase()));
  assert.equal(existsSync(owner), false, 'Historical source destination already exists');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
  const git = (args, input) => { const result = spawnSync('git', ['--no-replace-objects', '-c', 'credential.helper=', '-c', 'core.fsmonitor=false', ...args], { cwd: repository, env, input, windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024 * 1024 });
    assert.ifError(result.error); assert.equal(result.status, 0, 'Exact historical Git objects must already exist'); return result.stdout; };
  const contents = [], availableBlobs = new Map();
  for (const [id, source] of Object.entries(HISTORICAL_SOURCES)) {
    assert.equal(git(['rev-parse', source.commit + '^{tree}']).toString().trim(), source.tree);
    for (const [path, blob] of Object.entries(source.objects)) assert.equal(git(['rev-parse', `${source.commit}:${path}`]).toString().trim(), blob);
    const entries = git(['ls-tree', '-r', '-z', source.commit, '--', ...Object.keys(source.objects)]).toString('utf8').split('\0').filter(Boolean);
    const paths = entries.map(entry => { const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(entry); assert.ok(match, 'Historical source contains unsupported path/mode'); const [, blob, path] = match; pathOK(path); return { blob, path }; });
    const missing = [...new Set(paths.map(row => row.blob))].filter(blob => !availableBlobs.has(blob));
    if (missing.length) {
      const stream = git(['cat-file', '--batch'], Buffer.from(missing.join('\n') + '\n')); let offset = 0;
      for (const blob of missing) { const end = stream.indexOf(10, offset); assert.ok(end > offset); const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(stream.subarray(offset, end).toString());
        assert.ok(match); assert.equal(match[1], blob); const size = Number(match[2]); assert.ok(Number.isSafeInteger(size) && size >= 0 && end + 1 + size < stream.length);
        const bytes = stream.subarray(end + 1, end + 1 + size); assert.equal(stream[end + 1 + size], 10); assert.equal(gitHash('blob', bytes), blob);
        availableBlobs.set(blob, bytes); offset = end + 2 + size; }
      assert.equal(offset, stream.length, 'Unexpected historical Git batch output');
    }
    for (const { blob, path } of paths) contents.push({ id, path, bytes: availableBlobs.get(blob) });
  }
  mkdirSync(owner);
  for (const { id, path, bytes } of contents) { const target = join(owner, id, path); assert.ok(!relative(owner, target).startsWith('..')); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes, { flag: 'wx' }); }
  return verifyHistoricalDirectory(owner);
}
export function historicalVerifyCommand(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0);
  const code = `import {createHash} from 'node:crypto';const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);const source=Buffer.concat(chunks);if(source.length!==${bytes.length}||createHash('sha256').update(source).digest('hex')!==${JSON.stringify(historicalHash(bytes))})throw Error('Historical verifier input mismatch');const {verifyHistoricalDirectory}=await import('data:text/javascript;base64,'+source.toString('base64'));process.stdout.write(JSON.stringify(verifyHistoricalDirectory()));`;
  return ['node', '--input-type=module', '-e', code];
}
export async function collectHistoricalCheck({ candidate, runId, containerId, stage, verifierBytes, execute }) {
  const started_at = new Date().toISOString(); const execution = await execute('historical-' + stage.replaceAll(':', '-'), historicalVerifyCommand(verifierBytes), { input: verifierBytes });
  assert.equal(execution.code, 0); return { commit: candidate.commit, tree: candidate.tree, run_id: runId, container_id: containerId, stage,
    verifier_sha256: historicalHash(verifierBytes), started_at, finished_at: new Date().toISOString(), execution: { code: execution.code }, identity: verifyHistoricalRecord(JSON.parse(execution.text)) };
}
export function verifyHistoricalRuns(receipt, expected) {
  const proof = receipt.historical_browser_apps; assert.equal(proof?.schema, 'pr-gate-historical-app-run-v1');
  for (const key of ['commit', 'tree']) assert.equal(proof[key], expected[key]); assert.equal(proof.run_id, receipt.run_id);
  assert.equal(proof.container_id, receipt.reference_components.container_id);
  const suffix = '/historical-browser-sources/' + receipt.run_id, root = proof.host_before?.root; assert.ok(root?.endsWith(suffix));
  verifyHistoricalRecord(proof.host_before, root); assert.deepEqual(proof.host_after, proof.host_before);
  assert.deepEqual(proof.mount_before, receipt.reference_components.mount_before); assert.deepEqual(proof.mount_after, receipt.reference_components.mount_after);
  assert.equal(proof.mount_before.historical_apps.host_source, root);
  const check = (value, stage) => { assert.equal(value?.stage, stage); for (const key of ['commit', 'tree', 'run_id', 'container_id']) assert.equal(value[key], proof[key]);
    assert.equal(value.verifier_sha256, expected.historical_verifier_sha256); assert.equal(value.execution?.code, 0); verifyHistoricalRecord(value.identity);
    assert.deepEqual(value.identity.sources, proof.host_before.sources);
    const start = Date.parse(value.started_at), end = Date.parse(value.finished_at); assert.ok(Number.isFinite(start) && end >= start && start >= Date.parse(receipt.started_at) && end <= Date.parse(receipt.finished_at)); return { start, end }; };
  const before = check(proof.container_before, 'prepared'), after = check(proof.container_after, 'final');
  assert.deepEqual(proof.shards.map(row => row.name), expected.matrix.filter(row => row.groups === 'browser').map(row => row.name));
  for (const shard of receipt.shards) assert.ok(before.end <= Date.parse(shard.started_at) && after.start >= Date.parse(shard.finished_at));
  for (const row of proof.shards) { const shard = receipt.shards.find(item => item.name === row.name), first = check(row.before, row.name + ':before'), last = check(row.after, row.name + ':after');
    assert.ok(first.start >= Date.parse(shard.started_at) && first.end <= Date.parse(shard.summary.browser_runtime.started_at) && last.start >= Date.parse(shard.summary.browser_runtime.finished_at) && last.end <= Date.parse(shard.finished_at)); }
  return proof;
}
