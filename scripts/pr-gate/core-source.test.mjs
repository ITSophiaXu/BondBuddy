import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { coreSourceCommand, collectCoreSource } from './core-source.mjs';
import { verifyGitSnapshotSource } from './git-snapshot.mjs';

test('host-pinned checker executes exact original verifier and rejects changed tracked bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bb-core-source-test-'));
  const git = args => { const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args], { cwd: directory, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  try {
    git(['init', '--quiet']); git(['config', '--local', 'user.email', 'synthetic@example.invalid']); git(['config', '--local', 'user.name', 'Synthetic Test']);
    const sourcePath = 'a source with spaces.txt', removedPath = 'b removed file.txt', oversizedPath = 'c oversized file.txt';
    const otherPaths = Array.from({ length: 20 }, (_, i) => 'z-' + String(i).padStart(2, '0') + '.txt');
    const trackedPaths = [sourcePath, removedPath, oversizedPath, ...otherPaths];
    for (const name of trackedPaths) writeFileSync(join(directory, name), 'original\n');
    git(['add', '--', ...trackedPaths]); git(['commit', '--quiet', '-m', 'synthetic']);
    const candidate = { commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']) };
    const source = readFileSync(new URL('./git-snapshot.mjs', import.meta.url));
    const args = coreSourceCommand(candidate, source, directory).slice(1);
    const before = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
    assert.equal(before.status, 0, before.stderr);
    assert.deepEqual(JSON.parse(before.stdout), verifyGitSnapshotSource({ sourceRoot: directory, expectedCommit: candidate.commit, expectedTree: candidate.tree }));
    // A writable helper at the ordinary checkout cannot replace the pinned code.
    mkdirSync(join(directory, 'scripts/pr-gate'), { recursive: true });
    writeFileSync(join(directory, 'scripts/pr-gate/git-snapshot.mjs'), 'throw Error("wrong helper imported");');
    const privateBytes = 'SYNTHETIC_FILE_CONTENT_DO_NOT_LOG\n';
    writeFileSync(join(directory, sourcePath), privateBytes);
    unlinkSync(join(directory, removedPath));
    truncateSync(join(directory, oversizedPath), 64 * 1024 * 1024 + 1);
    for (const name of otherPaths) writeFileSync(join(directory, name), 'changed\n');
    const after = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
    assert.notEqual(after.status, 0); assert.match(after.stderr, /Snapshot tracked source changed/); assert.doesNotMatch(after.stderr, /wrong helper imported/);
    const diagnosticLine = after.stderr.split(/\r?\n/).find(line => line.startsWith('Snapshot change diagnostics: '));
    assert.ok(diagnosticLine, 'the rejection records bounded metadata before cleanup');
    const diagnostics = JSON.parse(diagnosticLine.slice('Snapshot change diagnostics: '.length));
    assert.equal(diagnostics.schema, 'pr-gate-source-change-diagnostics-v1');
    assert.equal(diagnostics.total_changes, trackedPaths.length); assert.equal(diagnostics.reported_changes, 20);
    assert.equal(diagnostics.truncated, true); assert.equal(diagnostics.max_files, 20);
    assert.equal(diagnostics.max_hash_bytes, 64 * 1024 * 1024); assert.ok(diagnostics.hashed_bytes < diagnostics.max_hash_bytes);
    assert.deepEqual(diagnostics.files.map(file => file.path), trackedPaths.slice(0, 20));
    const blob = text => createHash('sha1').update('blob ' + Buffer.byteLength(text) + '\0').update(text).digest('hex');
    assert.deepEqual(diagnostics.files[0], { path: sourcePath, status: ' M',
      expected: { mode: '100644', kind: 'blob', blob: blob('original\n') },
      actual: { kind: 'file', mode_bits: (lstatSync(join(directory, sourcePath)).mode & 0o777).toString(8), bytes: Buffer.byteLength(privateBytes), blob: blob(privateBytes) } });
    assert.deepEqual(diagnostics.files[1], { path: removedPath, status: ' D',
      expected: { mode: '100644', kind: 'blob', blob: blob('original\n') }, actual: { kind: 'missing' } });
    assert.deepEqual(diagnostics.files[2].actual, { kind: 'file', mode_bits: (lstatSync(join(directory, oversizedPath)).mode & 0o777).toString(8), bytes: 64 * 1024 * 1024 + 1, reason: 'hash_byte_limit' });
    assert.ok(!after.stderr.includes(privateBytes.trim()), 'diagnostics must not print file contents');
    assert.ok(!after.stdout.includes(privateBytes.trim()), 'stdout must not print file contents');
  } finally {
    assert.equal(dirname(realpathSync(directory)), realpathSync(tmpdir()));
    assert.match(basename(directory), /^bb-core-source-test-/); assert.equal(lstatSync(directory).isSymbolicLink(), false);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('collection records only a successful matching proof and preserves cleanup execution', async () => {
  const candidate = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, verifierBytes = Buffer.from('export function verifyGitSnapshotSource(){}');
  const rawSource = { files: 2, byte_count: 20, manifest_sha256: 'c'.repeat(64) }, shards = [{ finished_at: new Date(Date.now() - 100).toISOString(), summary: { finishedAt: new Date(Date.now() - 200).toISOString() } }];
  const context = { candidate, runId: 'synthetic-run', verifierBytes, rawSource, shards };
  const execute = async (label, args, env, options) => { assert.equal(label, 'core-source-final'); assert.deepEqual(args, coreSourceCommand(candidate, verifierBytes)); assert.deepEqual(options, { capture: true, cleanup: true }); return { code: 0, text: JSON.stringify(rawSource) }; };
  const result = await collectCoreSource({ ...context, execute });
  assert.equal(result.verifier_sha256, createHash('sha256').update(verifierBytes).digest('hex'));
  await assert.rejects(collectCoreSource({ ...context, execute: async () => ({ code: 1, text: JSON.stringify(rawSource) }) }), /exit successfully/);
  await assert.rejects(collectCoreSource({ ...context, execute: async () => ({ code: 0, text: JSON.stringify({ ...rawSource, byte_count: 21 }) }) }), /changed after preparation/);
});
