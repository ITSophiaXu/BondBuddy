import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanupContainers, dependencySources, persistReceipts } from './local.mjs';

function receiptFiles(check) {
  const directory = mkdtempSync(join(tmpdir(), 'bb-pr-gate-receipts-'));
  const latest = join(directory, 'receipt.json'), archive = join(directory, 'run-receipt.json');
  const receipt = { status: 'passed', commit: 'a'.repeat(40), errors: [] };
  for (const file of [latest, archive]) writeFileSync(file, JSON.stringify(receipt));
  try { check({ latest, archive, receipt }); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('active passing receipt is published only after the per-run copy', () => {
  receiptFiles(({ latest, archive, receipt }) => {
    const published = [];
    persistReceipts(receipt, latest, archive, {
      writeFileSync, rmSync,
      renameSync(from, to) {
        if (to === archive) assert.equal(existsSync(latest), false, 'an earlier active pass must already be invalidated');
        if (to === latest) assert.deepEqual(JSON.parse(readFileSync(archive, 'utf8')), receipt);
        published.push(to); renameSync(from, to);
      },
    });
    assert.deepEqual(published, [archive, latest]);
    assert.deepEqual(JSON.parse(readFileSync(latest, 'utf8')), receipt);
  });
});

test('write or rename failure at either destination demotes both receipts before returning failure', () => {
  for (const destination of ['latest', 'archive']) for (const operation of ['writeFileSync', 'renameSync']) {
    receiptFiles(files => {
      let failed = false;
      const io = { writeFileSync, renameSync, rmSync };
      io[operation] = (...args) => {
        const path = operation === 'renameSync' ? args[1] : args[0];
        const affected = operation === 'renameSync' ? files[destination] : `${files[destination]}.tmp`;
        if (!failed && path === affected) { failed = true; throw new Error(`synthetic ${destination} ${operation} failure`); }
        return ({ writeFileSync, renameSync })[operation](...args);
      };
      assert.throws(() => persistReceipts(files.receipt, files.latest, files.archive, io), /synthetic/);
      assert.equal(failed, true);
      assert.equal(files.receipt.status, 'failed');
      assert.equal(files.receipt.errors.length, 1);
      for (const path of [files.latest, files.archive]) {
        assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), files.receipt, `${destination}/${operation} must not retain passed`);
        assert.equal(existsSync(`${path}.tmp`), false);
      }
    });
  }
});

test('persistent write failure removes old passes when neither failed receipt can be saved', () => {
  receiptFiles(({ latest, archive, receipt }) => {
    assert.throws(() => persistReceipts(receipt, latest, archive, {
      renameSync, rmSync, writeFileSync() { throw new Error('synthetic disk full'); },
    }), /synthetic disk full/);
    assert.equal(receipt.status, 'failed');
    assert.equal(existsSync(latest), false);
    assert.equal(existsSync(archive), false);
  });
});

test('persistent active-copy failure removes it and replaces the already-written passing archive with failed', () => {
  receiptFiles(({ latest, archive, receipt }) => {
    assert.throws(() => persistReceipts(receipt, latest, archive, {
      writeFileSync, rmSync,
      renameSync(from, to) {
        if (to === latest) throw new Error('synthetic active receipt rename failure');
        renameSync(from, to);
      },
    }), /synthetic active receipt rename failure/);
    assert.equal(existsSync(latest), false);
    assert.equal(existsSync(`${latest}.tmp`), false);
    assert.deepEqual(JSON.parse(readFileSync(archive, 'utf8')), receipt);
    assert.equal(receipt.status, 'failed');
  });
});

test('dependency-only sources honor npm configuration without accepting insecure URLs or credentials', () => {
  assert.equal(dependencySources({ npm_config_registry: 'https://packagefeedproxy.microsoft.io/npm/' }).npm, 'https://packagefeedproxy.microsoft.io/npm/');
  assert.equal(dependencySources({}).pip, 'https://pypi.org/simple/');
  for (const invalid of ['http://example.test/', 'https://user:secret@example.test/', 'https://example.test/?token=secret', 'file:///cache', 'invalid']) {
    assert.throws(() => dependencySources({ PR_GATE_NPM_REGISTRY: invalid }));
    assert.throws(() => dependencySources({ PR_GATE_PIP_INDEX_URL: invalid }));
  }
});

test('one cleanup failure does not hide behind an absent sibling or prevent runner cleanup', async () => {
  const calls = [];
  await assert.rejects(cleanupContainers(['pg', 'blob', 'runner'], async (label, args) => {
    calls.push(label);
    if (label === 'remove-pg') return { code: 1, text: 'permission denied' };
    if (label === 'inspect-pg') return { code: 0, text: 'still-running-id' };
    if (label === 'remove-blob') return { code: 1, text: 'No such container' };
    return { code: 0, text: '' };
  }), /pg still exists/);
  assert.ok(calls.includes('remove-runner'));
  assert.ok(calls.includes('inspect-runner'));
  await assert.rejects(cleanupContainers(['pg', 'runner'], async label => {
    if (label.startsWith('inspect-')) throw new Error('daemon unavailable');
    return { code: 0, text: '' };
  }), /daemon unavailable/);
});

test('dirty invocation invalidates a prior passed receipt, merges missing results, and releases its lock without Docker', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'bb-pr-gate-dirty-'));
  try {
    const directory = join(fixture, 'scripts/pr-gate'); mkdirSync(directory, { recursive: true });
    for (const name of ['local.mjs', 'run.mjs', 'receipt.mjs', 'workflow.mjs', 'capabilities.mjs', 'parser-source.mjs']) copyFileSync(new URL(name, import.meta.url), join(directory, name));
    writeFileSync(join(fixture, '.gitignore'), '.local/\n');
    const git = args => execFileSync('git', args, { cwd: fixture, stdio: 'pipe' });
    git(['init']); git(['add', '.']); git(['-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.invalid', 'commit', '-m', 'fixture']);
    const out = join(fixture, '.local/pr-gate'); mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'receipt.json'), JSON.stringify({ status: 'passed' }));
    writeFileSync(join(fixture, 'uncommitted.txt'), 'dirty');
    const result = spawnSync(process.execPath, [join(directory, 'local.mjs'), 'run'], { cwd: fixture, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const receipt = JSON.parse(readFileSync(join(out, 'receipt.json'), 'utf8'));
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.clean_tree, false);
    assert.equal(receipt.merge.result.received, 0); assert.equal(receipt.merge.result.status, 'failed');
    assert.equal(receipt.preparation.length, 0); assert.equal(receipt.cleanup.status, 'passed');
    assert.equal(existsSync(join(out, 'run.lock')), false);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
