import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { REFERENCE_FILES, REFERENCE_ROOT, REFERENCE_TESTS, QA_BASELINE_ROOT, collectReferenceCheck, mountSourceIdentity, readReferenceObjects,
  referenceVerifyCommand, qaBaselineVerifyCommand, collectQaBaselineCheck, restoreReferenceSource, restoreVerifiedReferenceObjects, verifyReferenceDirectory, verifyReferenceMount, verifyReferenceRuns } from './browser-reference-source.mjs';
import { syntheticReferenceIdentity, syntheticReferenceRuns, syntheticQaBaselineIdentity } from './browser-reference.test-fixture.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
// The full gate has a verified read-only mount and intentionally no historical
// Git objects in /workspace. Host units read the same pinned objects directly.
const bytes = existsSync(REFERENCE_ROOT)
  ? (verifyReferenceDirectory(), new Map(REFERENCE_FILES.map(file => [file.path, readFileSync(join(REFERENCE_ROOT, file.path))])))
  : readReferenceObjects(repository);
function fixture(t) {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, 'bb-reference-'));
  t.after(() => { assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  const evidence = join(root, 'runs', 'synthetic-run'), owner = join(root, 'reference-sources', 'synthetic-run');
  mkdirSync(evidence, { recursive: true }); mkdirSync(dirname(owner));
  return { root, owner, evidence, restore: () => restoreVerifiedReferenceObjects(bytes, owner, evidence) };
}
test('eleven exact historical Git blobs restore as raw bytes with component-only provenance', t => {
  const f = fixture(t), proof = f.restore();
  assert.equal(REFERENCE_FILES.length, 11); assert.equal(REFERENCE_FILES.reduce((n, file) => n + file.bytes, 0), 136905);
  assert.equal(REFERENCE_TESTS.length, 4); assert.equal(proof.not_a_seal, true); assert.equal(proof.not_execution_evidence, true);
  for (const file of REFERENCE_FILES) assert.deepEqual(readFileSync(join(proof.root, file.path)), bytes.get(file.path));
  assert.deepEqual(verifyReferenceDirectory(proof.root), proof);
  assert.throws(f.restore, /already exists/);
  const missing = join(f.root, 'no-git'), target = join(dirname(f.owner), 'missing-source'); mkdirSync(missing);
  assert.throws(() => restoreReferenceSource(missing, target, f.evidence), /Git objects/); assert.equal(existsSync(target), false);
});
test('changed bytes, wrong or missing file sets fail before writing any destination', t => {
  const f = fixture(t), path = REFERENCE_FILES[0].path;
  const cases = [map => map.set(path, Buffer.from('current code must not replace the old component')), map => map.delete(path),
    map => map.set('extra.txt', Buffer.from('extra')), map => map.set(path, Buffer.from(map.get(path).toString().replace('\n', '\r\n')))];
  for (const mutate of cases) {
    const changed = new Map(bytes); mutate(changed);
    assert.throws(() => restoreVerifiedReferenceObjects(changed, f.owner, f.evidence)); assert.equal(existsSync(f.owner), false);
  }
});
test('writable evidence overlap, existing targets and aliased ancestors are rejected', t => {
  const f = fixture(t);
  assert.throws(() => restoreVerifiedReferenceObjects(bytes, join(f.evidence, 'inside'), f.evidence), /overlaps/);
  assert.throws(() => restoreVerifiedReferenceObjects(bytes, f.root, f.evidence), /overlaps/);
  const alias = join(f.root, 'alias'); symlinkSync(dirname(f.owner), alias, 'junction');
  assert.throws(() => restoreVerifiedReferenceObjects(bytes, join(alias, 'run'), f.evidence), /link|alias/);
  mkdirSync(f.owner); assert.throws(f.restore, /already exists/);
});
test('post-restore checks reject changed bytes, missing files, extra directories and file aliases', t => {
  const mutations = [root => writeFileSync(join(root, REFERENCE_FILES[0].path), 'changed'),
    root => rmSync(join(root, REFERENCE_FILES[0].path)), root => mkdirSync(join(root, 'extra-empty')),
    root => writeFileSync(join(root, 'extra.txt'), 'extra'),
    root => linkSync(join(root, REFERENCE_FILES[0].path), join(dirname(root), 'hardlink')),
    root => { const path = join(root, REFERENCE_FILES[0].path); rmSync(path); symlinkSync(dirname(path), path, 'junction'); }];
  for (const mutate of mutations) {
    const f = fixture(t), proof = f.restore(); mutate(proof.root); assert.throws(() => verifyReferenceDirectory(proof.root));
  }
});
const containerId = 'c'.repeat(64), host = 'C:/synthetic/reference-sources/synthetic-run/BondBuddy-develop', evidence = 'C:/synthetic/runs/synthetic-run';
const inspection = () => ({ Id: containerId, Mounts: [
  { Type: 'bind', Destination: '/evidence', Source: evidence, RW: true },
  { Type: 'bind', Destination: '/opt/pr-gate-parser106', Source: 'C:/synthetic/parser', RW: false },
  { Type: 'bind', Destination: REFERENCE_ROOT, Source: host, RW: false },
  { Type: 'bind', Destination: QA_BASELINE_ROOT, Source: host.replace('/reference-sources/', '/qa-baseline-sources/'), RW: false },
  { Type: 'bind', Destination: '/opt/pr-gate-identity-parser106', Source: 'C:/synthetic/identity-parser', RW: false },
] });
test('actual mount inspection binds owned container, verified host paths and exact five-mount policy', () => {
  assert.equal(verifyReferenceMount(inspection(), host, evidence, containerId).container_id, containerId);
  for (const mutate of [x => x.Id = 'd'.repeat(64), x => x.Mounts[2].Source = evidence, x => x.Mounts[0].Source += '-old',
    x => x.Mounts[2].RW = true, x => x.Mounts[2].Type = 'volume', x => x.Mounts[2].Destination += '-old', x => x.Mounts.pop(),
    x => x.Mounts[4].RW = true, x => x.Mounts[4].Destination += '-old', x => x.Mounts[3].RW = true, x => x.Mounts[3].Source = evidence, x => x.Mounts[3].Source = host, x => x.Mounts[3].Destination += '-old',
    x => x.Mounts.push({ Type: 'bind', Destination: '/workspace', Source: host, RW: true })]) {
    const value = inspection(); mutate(value); assert.throws(() => verifyReferenceMount(value, host, evidence, containerId));
  }
  for (const bridge of ['/host_mnt/c/', '/run/desktop/mnt/host/c/']) {
    const value = inspection(); for (const mount of value.Mounts) mount.Source = mount.Source.replace('C:/', bridge);
    assert.equal(verifyReferenceMount(value, host, evidence, containerId).host_source, host);
  }
  assert.equal(mountSourceIdentity('c:\\Synthetic\\path'), mountSourceIdentity('/host_mnt/c/synthetic/path'));
  for (const path of ['relative', '/path/../escape', '/path/./alias', 'C:/bad\0path']) assert.throws(() => mountSourceIdentity(path));
});
test('container check executes pinned in-memory verifier and records its actual result', async () => {
  const source = Buffer.from(`export function verifyReferenceDirectory(){return ${JSON.stringify(syntheticReferenceIdentity())};}`);
  const result = await collectReferenceCheck({ candidate: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, runId: 'synthetic-run', containerId, stage: 'prepared', verifierBytes: source,
    execute: async (_label, args, { input }) => { assert.deepEqual(args, referenceVerifyCommand(source)); assert.strictEqual(input, source); const r = spawnSync(process.execPath, args.slice(1), { encoding: 'utf8', input }); return { code: r.status, text: r.stdout }; } });
  assert.equal(result.execution.code, 0); assert.equal(result.container_id, containerId); assert.equal(result.identity.not_a_seal, true);
  await assert.rejects(collectReferenceCheck({ candidate: {}, stage: 'prepared', verifierBytes: source, execute: async () => ({ code: 1, text: '{}' }) }), /successfully/);
});
test('short commands verify large raw stdin before executing either pinned checker', async t => {
  const f = fixture(t), fakeHelper = join(f.root, 'scripts/pr-gate/browser-reference-source.mjs');
  mkdirSync(dirname(fakeHelper), { recursive: true }); writeFileSync(fakeHelper, 'throw Error("WRONG_DISK_HELPER_EXECUTED");');
  const source = Buffer.from('/*纯合成 UTF-8 verifier padding: ' + 'p'.repeat(48 * 1024) + '*/\n' +
    'export function verifyReferenceDirectory(){return ' + JSON.stringify(syntheticReferenceIdentity()) + ';}\n' +
    'export function verifyQaBaselineDirectory(){return ' + JSON.stringify(syntheticQaBaselineIdentity()) + ';}\n');
  assert.ok(source.length > 32_767, 'the raw fixture alone exceeds the Windows command-line limit');
  for (const [command, collect, identity] of [[referenceVerifyCommand, collectReferenceCheck, syntheticReferenceIdentity()],
    [qaBaselineVerifyCommand, collectQaBaselineCheck, syntheticQaBaselineIdentity()]]) {
    const args = command(source); assert.ok(args.join(' ').length < 2048, 'source bytes must not enter argv');
    const execute = async (_label, actualArgs, { input }) => {
      assert.deepEqual(actualArgs, args); assert.strictEqual(input, source);
      const child = spawnSync(process.execPath, actualArgs.slice(1), { cwd: f.root, encoding: 'utf8', input });
      assert.ifError(child.error); assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, '');
      return { code: child.status, text: child.stdout };
    };
    const result = await collect({ candidate: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, runId: 'synthetic-run', containerId,
      stage: 'prepared', verifierBytes: source, execute });
    assert.deepEqual(result.identity, identity); assert.equal(result.execution.code, 0);
    const tampered = Buffer.from(source); tampered[tampered.length - 2] ^= 1;
    for (const [input, reason] of [[Buffer.alloc(0), 'length'], [source.subarray(0, -1), 'length'],
      [Buffer.concat([source, Buffer.from(' ')]), 'length'], [tampered, 'hash']]) {
      const rejected = spawnSync(process.execPath, args.slice(1), { cwd: f.root, encoding: 'utf8', input });
      assert.ifError(rejected.error); assert.notEqual(rejected.status, 0); assert.equal(rejected.stdout, '');
      assert.match(rejected.stderr, new RegExp('Pinned verifier stdin ' + reason + ' mismatch'));
      assert.doesNotMatch(rejected.stderr, /WRONG_DISK_HELPER_EXECUTED/);
    }
  }
});

test('lifecycle rejects missing, stale, cross-run or cross-container proof and unchecked browser shards', () => {
  const expected = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), reference_verifier_sha256: 'd'.repeat(64),
    browser_source_sha256: Object.fromEntries(REFERENCE_TESTS.map(file => [file, 'e'.repeat(64)])),
    matrix: [1, 2, 3].map(n => ({ name: 'browser-' + n, groups: 'browser' })) };
  const fresh = () => ({ run_id: 'synthetic-run', started_at: '2026-11-11T13:00:00Z', finished_at: '2026-11-11T13:01:00Z',
    capabilities: { reference_components: syntheticReferenceIdentity() }, reference_components: syntheticReferenceRuns(expected, 'synthetic-run'),
    shards: expected.matrix.map(row => ({ name: row.name, started_at: '2026-11-11T13:00:01Z', finished_at: '2026-11-11T13:00:40Z',
      summary: { browser_runtime: { started_at: '2026-11-11T13:00:11Z', finished_at: '2026-11-11T13:00:23Z' } } })) });
  verifyReferenceRuns(fresh(), expected);
  for (const mutate of [p => delete p.host_after, p => p.host_before.files.pop(), p => p.host_after.files[0].sha256 = 'f'.repeat(64),
    p => p.commit = 'f'.repeat(40), p => p.tree = 'f'.repeat(40), p => p.run_id += '-old', p => p.container_id = 'f'.repeat(64),
    p => p.container_before.container_id = 'f'.repeat(64), p => p.container_after.run_id += '-old', p => p.container_after.execution.code = 1,
    p => p.container_after.verifier_sha256 = 'f'.repeat(64), p => p.container_before.identity.not_a_seal = false,
    p => p.mount_after.writable = true, p => p.mount_before.actual_source += '-old', p => p.mount_before.actual_evidence += '-old',
    p => delete p.mount_before.qa_baseline, p => p.mount_after.qa_baseline.writable = true, p => p.mount_before.qa_baseline.actual_source += '-old',
    p => p.shards.pop(), p => p.shards.push(p.shards[0]), p => delete p.shards[0].before, p => delete p.shards[1].after,
    p => p.shards[2].after.identity.files[0].blob = 'f'.repeat(40), p => p.shards[0].before.finished_at = '2026-11-11T13:00:12Z',
    p => p.shards[0].after.started_at = '2026-11-11T13:00:22Z', p => p.container_after.started_at = '2026-11-11T13:00:39Z']) {
    const value = fresh(); mutate(value.reference_components); assert.throws(() => verifyReferenceRuns(value, expected));
  }
  const missingSpec = structuredClone(expected); delete missingSpec.browser_source_sha256[REFERENCE_TESTS[0]];
  assert.throws(() => verifyReferenceRuns(fresh(), missingSpec), /original browser discovery/);
});
