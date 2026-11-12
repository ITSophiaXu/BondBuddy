import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { QA_BASELINE_ROOT, QA_BASELINE_SOURCE, QA_BASELINE_FILES, QA_BASELINE_TEST, QA_BASELINE_ALIASES, REFERENCE_SOURCE, REFERENCE_TESTS,
  readQaBaselineObjects, restoreQaBaselineSource, restoreVerifiedQaBaselineObjects, verifyQaBaselineDirectory,
  createQaBaselineAliases, verifyQaBaselineAliases, verifyQaBaselineRuns, collectQaBaselineCheck } from './browser-reference-source.mjs';
import { syntheticReferenceRuns, syntheticReferenceIdentity, syntheticQaBaselineRuns, syntheticQaBaselineIdentity, syntheticQaBaselineAliases } from './browser-reference.test-fixture.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const bytes = existsSync(QA_BASELINE_ROOT)
  ? (verifyQaBaselineDirectory(), new Map(QA_BASELINE_FILES.map(file => [file.path, readFileSync(join(QA_BASELINE_ROOT, file.path))])))
  : readQaBaselineObjects(repository);
function fixture(t) {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, 'bb-qa-baseline-'));
  t.after(() => { assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  const evidence = join(root, 'runs', 'synthetic-run'), owner = join(root, 'qa-baseline-sources', 'synthetic-run');
  mkdirSync(evidence, { recursive: true }); mkdirSync(dirname(owner));
  return { root, owner, evidence, restore: () => restoreVerifiedQaBaselineObjects(bytes, owner, evidence) };
}
test('QA baseline restores the two original 5ec099a blobs with independent non-seal provenance', t => {
  const f = fixture(t), proof = f.restore();
  assert.equal(QA_BASELINE_SOURCE.commit, '5ec099a27d6e754cf9b7b8c75d0f3616746918a1');
  assert.notDeepEqual(QA_BASELINE_SOURCE, REFERENCE_SOURCE); assert.deepEqual(proof.source, QA_BASELINE_SOURCE);
  assert.equal(proof.not_a_seal, true); assert.equal(proof.not_execution_evidence, true);
  assert.equal(proof.files.length, 2); assert.equal(proof.files.reduce((sum, file) => sum + file.bytes, 0), 100390);
  for (const file of QA_BASELINE_FILES) assert.deepEqual(readFileSync(join(proof.root, file.path)), bytes.get(file.path));
  assert.deepEqual(verifyQaBaselineDirectory(proof.root), proof); assert.throws(f.restore, /already exists/);
  const missing = join(f.root, 'no-git'), destination = join(dirname(f.owner), 'missing'); mkdirSync(missing);
  assert.throws(() => restoreQaBaselineSource(missing, destination, f.evidence), /Git objects/); assert.equal(existsSync(destination), false);
});
test('missing, rewritten, current or extra QA source bytes reject before any export', t => {
  const f = fixture(t), first = QA_BASELINE_FILES[0].path;
  for (const mutate of [m => m.delete(first), m => m.set('extra.ts', Buffer.from('extra')),
    m => m.set(first, Buffer.from('current implementation')), m => m.set(first, Buffer.from(m.get(first).toString().replace('\n', '\r\n')))]) {
    const changed = new Map(bytes); mutate(changed);
    assert.throws(() => restoreVerifiedQaBaselineObjects(changed, f.owner, f.evidence)); assert.equal(existsSync(f.owner), false);
  }
  assert.throws(() => restoreVerifiedQaBaselineObjects(bytes, join(f.evidence, 'inside'), f.evidence), /overlaps/);
});
test('QA source final verification rejects drift, missing files, extra directories and file aliases', t => {
  for (const mutate of [root => writeFileSync(join(root, QA_BASELINE_FILES[0].path), 'changed'),
    root => rmSync(join(root, QA_BASELINE_FILES[0].path)), root => mkdirSync(join(root, 'unexpected')),
    root => linkSync(join(root, QA_BASELINE_FILES[0].path), join(dirname(root), 'hardlink'))]) {
    const f = fixture(t), proof = f.restore(); mutate(proof.root); assert.throws(() => verifyQaBaselineDirectory(proof.root));
  }
});
test('gate virtual aliases return exact historical bytes with current src import resolution and no candidate writes', t => {
  const f = fixture(t), proof = f.restore(), aliases = createQaBaselineAliases(proof.root);
  assert.deepEqual(aliases.before.aliases.map(alias => alias.loads), [0, 0]);
  for (const alias of QA_BASELINE_ALIASES) {
    assert.equal(aliases.plugin.resolveId(alias.url), alias.id);
    assert.equal(aliases.plugin.resolveId(alias.url + '?direct'), alias.id + '?direct');
    assert.deepEqual(Buffer.from(aliases.plugin.load(alias.id + '?direct')), bytes.get(alias.source_path));
  }
  assert.equal(aliases.plugin.resolveId('/src/project-qa-workspace.ts'), null);
  assert.equal(aliases.plugin.load('/workspace/apps/web/src/project-qa-workspace.ts'), null);
  assert.equal(aliases.plugin.resolveId('/src/../qa-single-start-baseline.ts'), null);
  const after = aliases.snapshot(); assert.deepEqual(after.aliases.map(alias => alias.loads), [1, 1]);
  assert.deepEqual(after.source, proof); assert.deepEqual(verifyQaBaselineDirectory(proof.root), proof);
  writeFileSync(join(proof.root, QA_BASELINE_FILES[0].path), 'tampered');
  assert.throws(() => aliases.plugin.load(QA_BASELINE_ALIASES[0].id), /bytes changed/); assert.throws(aliases.snapshot);
});
test('alias receipt requires both exact source identities and actual loads after the zero-load preparation', () => {
  const valid = syntheticQaBaselineAliases(); verifyQaBaselineAliases(valid.before, valid.after);
  for (const mutate of [r => r.before.aliases[0].loads++, r => r.after.aliases[0].loads = 0,
    r => r.after.aliases[1].loads = 0, r => r.after.aliases[0].loads = 1.5, r => r.after.aliases.pop(),
    r => r.after.aliases[0].sha256 = 'f'.repeat(64), r => r.after.aliases[0].url += '-wrong',
    r => r.after.aliases[0].id = '/workspace/apps/web/src/project-qa-workspace.css',
    r => r.after.source = syntheticReferenceIdentity(), r => r.after.source.root = '/writable/evidence',
    r => r.after.source.not_a_seal = false, r => r.after.source.files[0].blob = 'f'.repeat(40)]) {
    const value = structuredClone(valid); mutate(value); assert.throws(() => verifyQaBaselineAliases(value.before, value.after));
  }
});
test('QA lifecycle rejects missing, stale, cross-run or mixed-source evidence without replacing reference proof', async () => {
  const expected = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), reference_verifier_sha256: 'd'.repeat(64),
    browser_source_sha256: Object.fromEntries([...REFERENCE_TESTS, QA_BASELINE_TEST].map(file => [file, 'e'.repeat(64)])),
    matrix: [1, 2, 3].map(n => ({ name: 'browser-' + n, groups: 'browser' })) };
  const fresh = () => ({ run_id: 'synthetic-run', started_at: '2026-11-11T13:00:00Z', finished_at: '2026-11-11T13:01:00Z',
    capabilities: { reference_components: syntheticReferenceIdentity(), qa_single_start_baseline: syntheticQaBaselineIdentity() },
    reference_components: syntheticReferenceRuns(expected, 'synthetic-run'), qa_single_start_baseline: syntheticQaBaselineRuns(expected, 'synthetic-run'),
    shards: expected.matrix.map(row => ({ name: row.name, started_at: '2026-11-11T13:00:01Z', finished_at: '2026-11-11T13:00:40Z',
      summary: { browser_runtime: { started_at: '2026-11-11T13:00:11Z', finished_at: '2026-11-11T13:00:23Z' } } })) });
  verifyQaBaselineRuns(fresh(), expected);
  for (const mutate of [r => delete r.qa_single_start_baseline, r => delete r.qa_single_start_baseline.host_after,
    r => r.qa_single_start_baseline.host_before.source = REFERENCE_SOURCE,
    r => r.qa_single_start_baseline.container_before.identity = syntheticReferenceIdentity(),
    r => r.qa_single_start_baseline.host_before.files.pop(), r => r.qa_single_start_baseline.container_id = 'f'.repeat(64),
    r => r.qa_single_start_baseline.run_id += '-old', r => r.qa_single_start_baseline.commit = 'f'.repeat(40),
    r => r.qa_single_start_baseline.container_after.verifier_sha256 = 'f'.repeat(64),
    r => r.qa_single_start_baseline.shards.pop(), r => delete r.qa_single_start_baseline.shards[0].after,
    r => r.qa_single_start_baseline.mount_after.qa_baseline.writable = true,
    r => r.qa_single_start_baseline.shards[0].after.started_at = '2026-11-11T13:00:22Z']) {
    const value = fresh(); mutate(value); assert.throws(() => verifyQaBaselineRuns(value, expected));
  }
  const missingSpec = structuredClone(expected); delete missingSpec.browser_source_sha256[QA_BASELINE_TEST];
  assert.throws(() => verifyQaBaselineRuns(fresh(), missingSpec), /original browser discovery/);
  await assert.rejects(collectQaBaselineCheck({ candidate: expected, runId: 'synthetic-run', containerId: 'c'.repeat(64), stage: 'prepared',
    verifierBytes: Buffer.from('export function verifyQaBaselineDirectory(){}'), execute: async () => ({ code: 1, text: '{}' }) }), /successfully/);
});
