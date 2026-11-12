import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REFERENCE_ROOT = '/remote-review-20261025-ffd637f/BondBuddy-develop';
export const REFERENCE_TESTS = Object.freeze(['integrity-reference', 'parallel-projects-reference', 'project-qa-reference', 'review-followup-reference'].map(name => `apps/web/tests/${name}.spec.ts`));
export const REFERENCE_SOURCE = Object.freeze({ commit: 'ffd637fac6c1fdf1581112e728f21ec29a94c67c', tree: '9ddc983bf5bf09de5236afd3076830a46649723a' });
export const REFERENCE_FILES = Object.freeze([
  ['project-browser.ts', '2800dfead6c1e7499e26393d85fa2f52e6b385c9', 17474, '41a9ebe7cab9409a9cb5b31991be05dcace48aeb3289b9935472535fceeacb03'],
  ['project-browser.css', '757258ab41fec1405a10f0ee6570c53cddf926b5', 10769, '1b475ddb0be0317ed2b43b7a14a7fc4ece9cfc731786acd920d8e5413143bf63'],
  ['integrity-workspace.ts', 'c01bc49f068e4d945b39737018e75fcb5050baf0', 34953, 'e8e31aa539e862e6014f42b82172f9e3e138039011c9eba49e248a25e5bab858'],
  ['integrity-workspace.css', 'ed7b4da10efd55f3d8739021c021d9da22197d8a', 10029, 'fb8f58b654eddcb7bf2e902f750cd1dfc040381880d0cd314b5073817a0b35e5'],
  ['project-qa-workspace.ts', 'dda48ebff0f9549aa242a5652d85b37675e72fc2', 26562, 'ee78cf781733e6028f63504f5e1eaeed6d879f86adc086afc9bbb6c0f4ecd8a8'],
  ['project-qa-workspace.css', '722719d04e9cf7c34d84e111ca05295f59d4eec9', 3755, 'ad92e00f1c50f265d6993bf9c0313aaee33f319c504a852e9c0746e381376977'],
  ['review-editor.ts', 'c76196c21310f622d11829b7315e18b884c9111b', 14186, '12fd421c14ea25e0453e3aaa772832f8a99cfbee888f5486eb4acb05348543ce'],
  ['review-editor.css', '9ba12a74804c86b80dc8354583f12b170195f898', 3141, '581b461c6ba9f7943bf3b5c3ddb5492a17ea8c3a60042fa973de28b11db62b13'],
  ['review-readable.ts', 'aa31c1f71c31c37c911dbe59cbff550fedd273d1', 4278, '9892a92e995e210f114b22ed104334690935cfdee68cd0f8f65c00dd6af4f297'],
  ['review-readable.css', '3a1e0f894e93f04f25ddf2cb90df1064093e4ef3', 7747, '77b7243e916530c1402d79041035749d35485931c2518c491494d37adc895719'],
  ['review-business-view.ts', '97a203efca32c51fb0121755d7324bd0cc3977dc', 4011, '8b4e68f5bec094ed5ae3bab3488604e11b5a25e7ee31a5f084f7ec7178d40034'],
].map(([name, blob, bytes, sha256]) => Object.freeze({ path: 'apps/web/src/' + name, blob, bytes, sha256 })).sort((a, b) => a.path.localeCompare(b.path)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const REFERENCE_PROFILE_SHA256 = hash(JSON.stringify({ source: REFERENCE_SOURCE, files: REFERENCE_FILES, tests: REFERENCE_TESTS, root: REFERENCE_ROOT }));
const canonical = path => resolve(path).replaceAll('\\', '/');
const exists = path => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const overlap = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
function realDirectory(path) {
  assert.ok(isAbsolute(path), 'Reference directory must be absolute');
  const stat = lstatSync(path); assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Reference directory cannot be a link');
  assert.equal(canonical(realpathSync(path)), canonical(path), 'Reference directory has an aliased ancestor');
  return canonical(path);
}
function fileIdentity(path, bytes) {
  return { path, blob: createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex'), bytes: bytes.length, sha256: hash(bytes) };
}
function record(root, files = REFERENCE_FILES) {
  return { schema: 'pr-gate-reference-components-v1', scope: 'old-components-only', not_a_seal: true, not_execution_evidence: true,
    source: REFERENCE_SOURCE, profile_sha256: REFERENCE_PROFILE_SHA256, root, files };
}
export function verifyReferenceRecord(value, root = REFERENCE_ROOT) {
  assert.deepEqual(value, record(root), 'Pinned reference component identity differs'); return value;
}
export function verifyReferenceDirectory(directory = REFERENCE_ROOT) {
  const root = realDirectory(directory), paths = [];
  const visit = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), 'Reference source cannot contain links');
      const path = prefix + entry.name;
      if (entry.isDirectory()) {
        assert.ok(['apps', 'apps/web', 'apps/web/src'].includes(path), 'Unexpected reference directory');
        realDirectory(join(dir, entry.name)); visit(join(dir, entry.name), path + '/');
      } else {
        assert.ok(entry.isFile() && lstatSync(join(dir, entry.name)).nlink === 1, 'Reference source must contain ordinary unaliased files'); paths.push(path);
      }
    }
  };
  visit(directory); assert.deepEqual(paths.sort(), REFERENCE_FILES.map(file => file.path), 'Reference source file set changed');
  const files = REFERENCE_FILES.map(file => {
    const path = join(directory, file.path); assert.equal(lstatSync(path).size, file.bytes, 'Reference size differs: ' + file.path);
    const actual = fileIdentity(file.path, readFileSync(path)); assert.deepEqual(actual, file, 'Reference bytes differ: ' + file.path); return actual;
  });
  return verifyReferenceRecord(record(root, files), root);
}
export function readReferenceObjects(repository) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
  const git = args => {
    const result = spawnSync('git', ['--no-replace-objects', '-c', 'credential.helper=', '-c', 'core.fsmonitor=false', ...args], { cwd: repository, env, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.ifError(result.error); assert.equal(result.status, 0, 'Exact reference Git objects must already be available'); return result.stdout;
  };
  assert.equal(git(['rev-parse', REFERENCE_SOURCE.commit + '^{tree}']).toString().trim(), REFERENCE_SOURCE.tree, 'Reference source tree differs');
  return new Map(REFERENCE_FILES.map(file => {
    assert.equal(git(['ls-tree', REFERENCE_SOURCE.commit, '--', file.path]).toString().trim(), `100644 blob ${file.blob}\t${file.path}`, 'Reference Git path/mode/blob differs');
    const bytes = git(['cat-file', 'blob', file.blob]); assert.deepEqual(fileIdentity(file.path, bytes), file, 'Reference Git bytes differ'); return [file.path, bytes];
  }));
}
/** A fresh per-run sibling of evidence, never a guessed old checkout or a seal. */
export function restoreReferenceSource(repository, ownerRoot, evidenceRoot) {
  return restoreVerifiedReferenceObjects(readReferenceObjects(repository), ownerRoot, evidenceRoot);
}
/** Shared byte-level restore; the gate always obtains these from readReferenceObjects. */
export function restoreVerifiedReferenceObjects(bytes, ownerRoot, evidenceRoot) {
  const parent = realDirectory(dirname(ownerRoot)), evidence = realDirectory(evidenceRoot), owner = canonical(ownerRoot);
  assert.equal(canonical(dirname(ownerRoot)), parent); assert.ok(!overlap(owner.toLowerCase(), evidence.toLowerCase()), 'Reference source overlaps writable evidence');
  assert.equal(exists(ownerRoot), false, 'Reference destination already exists');
  assert.ok(bytes instanceof Map);
  assert.deepEqual([...bytes.keys()].sort(), REFERENCE_FILES.map(file => file.path), 'Reference restore file set differs');
  for (const file of REFERENCE_FILES) {
    assert.ok(Buffer.isBuffer(bytes.get(file.path)));
    assert.deepEqual(fileIdentity(file.path, bytes.get(file.path)), file, 'Reference restore bytes differ');
  } // Validate the entire allowlist before the first write.
  mkdirSync(ownerRoot); const destination = join(ownerRoot, 'BondBuddy-develop'); mkdirSync(destination);
  for (const [path, content] of bytes) {
    const target = join(destination, path); assert.ok(!relative(destination, target).startsWith('..'));
    mkdirSync(dirname(target), { recursive: true }); realDirectory(dirname(target)); writeFileSync(target, content, { flag: 'wx' });
  }
  return verifyReferenceDirectory(destination);
}
// Docker Desktop may render a Windows bind as its Linux host bridge path.
export function mountSourceIdentity(value) {
  assert.ok(typeof value === 'string' && value.length > 0 && !value.includes('\0'));
  let path = value.replaceAll('\\', '/').replace(/\/$/, '');
  path = path.replace(/^\/(?:run\/desktop\/mnt\/host|host_mnt)\/([a-zA-Z])\//, '$1:/');
  assert.ok(/^(?:\/|[a-zA-Z]:\/)/.test(path) && !path.split('/').some(part => part === '..' || part === '.'), 'Invalid mount source');
  return /^[a-zA-Z]:\//.test(path) ? path.toLowerCase() : path;
}
export function verifyReferenceMount(value, sourceRoot, evidenceRoot, containerId) {
  const source = mountSourceIdentity(sourceRoot), evidence = mountSourceIdentity(evidenceRoot);
  assert.ok(!overlap(source, evidence), 'Reference source overlaps writable evidence');
  const mounts = value.Mounts ?? [];
  assert.deepEqual(mounts.map(m => ({ type: m.Type, destination: m.Destination, writable: m.RW })).sort((a, b) => a.destination.localeCompare(b.destination)),
    [{ type: 'bind', destination: '/evidence', writable: true }, { type: 'bind', destination: '/opt/pr-gate-parser106', writable: false }, { type: 'bind', destination: REFERENCE_ROOT, writable: false }]);
  const reference = mounts.find(m => m.Destination === REFERENCE_ROOT), writable = mounts.find(m => m.Destination === '/evidence');
  assert.equal(mountSourceIdentity(reference.Source), source, 'Reference bind source differs from the verified realpath');
  assert.equal(mountSourceIdentity(writable.Source), evidence, 'Writable evidence bind source differs');
  assert.match(value.Id, /^[a-f0-9]{64}$/);
  assert.equal(value.Id, containerId, 'Reference container differs from this run\'s owned runner');
  return { container_id: value.Id, type: 'bind', root: REFERENCE_ROOT, writable: false, host_source: sourceRoot, host_evidence: evidenceRoot,
    actual_source: reference.Source, actual_evidence: writable.Source };
}
/** Execute committed verifier bytes, never the copy writable by browser tests. */
export function referenceVerifyCommand(verifierBytes) {
  assert.ok(Buffer.isBuffer(verifierBytes) && verifierBytes.length > 0);
  return ['node', '--input-type=module', '-e', `const {verifyReferenceDirectory}=await import(${JSON.stringify('data:text/javascript;base64,' + verifierBytes.toString('base64'))});process.stdout.write(JSON.stringify(verifyReferenceDirectory()));`];
}
export async function collectReferenceCheck({ candidate, runId, containerId, stage, verifierBytes, execute }) {
  const startedAt = new Date().toISOString();
  const execution = await execute('reference-' + stage.replaceAll(':', '-'), referenceVerifyCommand(verifierBytes));
  assert.equal(execution.code, 0, 'Reference byte verification did not exit successfully');
  return { commit: candidate.commit, tree: candidate.tree, run_id: runId, container_id: containerId, stage,
    verifier_sha256: hash(verifierBytes), started_at: startedAt, finished_at: new Date().toISOString(), execution: { code: execution.code },
    identity: verifyReferenceRecord(JSON.parse(execution.text)) };
}
/** Required by the normal receipt validator; a missing input is not an allowed skip. */
export function verifyReferenceRuns(receipt, expected) {
  const proof = receipt.reference_components;
  assert.equal(proof?.schema, 'pr-gate-reference-components-run-v1');
  for (const key of ['commit', 'tree']) assert.equal(proof[key], expected[key]);
  assert.equal(proof.run_id, receipt.run_id);
  assert.match(proof.run_id, /^[a-zA-Z0-9-]{8,80}$/);
  assert.match(proof.container_id, /^[a-f0-9]{64}$/);
  if (receipt.cache_runtime) assert.equal(proof.container_id, receipt.cache_runtime.container_id);
  assert.match(expected.reference_verifier_sha256, /^[a-f0-9]{64}$/, 'Committed reference verifier hash missing');
  const hostRoot = proof.host_before?.root; assert.ok(typeof hostRoot === 'string' && hostRoot.endsWith('/reference-sources/' + receipt.run_id + '/BondBuddy-develop'));
  verifyReferenceRecord(proof.host_before, hostRoot); assert.deepEqual(proof.host_after, proof.host_before, 'Host reference source changed during run');
  const evidenceRoot = hostRoot.slice(0, -('/reference-sources/' + receipt.run_id + '/BondBuddy-develop').length) + '/runs/' + receipt.run_id;
  for (const mount of [proof.mount_before, proof.mount_after]) {
    const reconstructed = verifyReferenceMount({ Id: mount?.container_id, Mounts: [
      { Type: 'bind', Destination: '/evidence', Source: mount?.actual_evidence, RW: true },
      { Type: 'bind', Destination: '/opt/pr-gate-parser106', RW: false },
      { Type: 'bind', Destination: mount?.root, Source: mount?.actual_source, RW: mount?.writable },
    ] }, hostRoot, evidenceRoot, proof.container_id);
    assert.deepEqual(mount, reconstructed, 'Reference mount proof differs');
  }
  assert.deepEqual(proof.mount_before, proof.mount_after, 'Reference bind changed during run');
  const check = (value, stage) => {
    assert.equal(value?.stage, stage);
    for (const key of ['commit', 'tree', 'run_id', 'container_id']) assert.equal(value[key], proof[key], 'Reference check belongs to another run, candidate or runner');
    assert.equal(value.verifier_sha256, expected.reference_verifier_sha256);
    assert.equal(value.execution?.code, 0);
    const start = Date.parse(value.started_at), end = Date.parse(value.finished_at);
    assert.ok(Number.isFinite(start) && Number.isFinite(end) && start >= Date.parse(receipt.started_at) && end >= start && end <= Date.parse(receipt.finished_at), 'Reference check timestamp outside this run');
    verifyReferenceRecord(value.identity); return { start, end };
  };
  const before = check(proof.container_before, 'prepared'), after = check(proof.container_after, 'final');
  assert.deepEqual(proof.container_before.identity, receipt.capabilities.reference_components);
  for (const shard of receipt.shards) {
    assert.ok(before.end <= Date.parse(shard.started_at) && after.start >= Date.parse(shard.finished_at), 'Reference final/prepared checks do not enclose all shards');
  }
  const rows = (expected.matrix ?? []).filter(row => row.groups === 'browser');
  assert.ok(rows.length > 0); assert.deepEqual(proof.shards?.map(row => row.name), rows.map(row => row.name), 'Reference source checks omitted a browser shard');
  for (const file of REFERENCE_TESTS) assert.ok(expected.browser_source_sha256?.[file], 'Reference test missing from original browser discovery');
  for (const row of proof.shards) {
    const shard = receipt.shards.find(s => s.name === row.name), first = check(row.before, row.name + ':before'), last = check(row.after, row.name + ':after');
    assert.ok(first.start >= Date.parse(shard.started_at) && first.end <= Date.parse(shard.summary?.browser_runtime?.started_at) &&
      last.start >= Date.parse(shard.summary?.browser_runtime?.finished_at) && last.end <= Date.parse(shard.finished_at) && last.start >= first.end,
    'Reference checks do not surround the original browser execution');
  }
  return proof;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { assert.deepEqual(process.argv.slice(2), ['verify']); console.log(JSON.stringify(verifyReferenceDirectory())); }
  catch (error) { console.error('Reference components: ' + error.message); process.exitCode = 1; }
}
