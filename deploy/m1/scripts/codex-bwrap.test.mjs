// Synthetic command-adapter tests. No credentials, model, customer files or real
// namespace are used here; native canary/Word suites verify the actual boundary.
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = readFileSync(fileURLToPath(new URL('./codex-bwrap.sh', import.meta.url)), 'utf8');
const shell = process.platform === 'linux';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bb-bwrap-synthetic-'));
  const genuine = join(root, 'recording bwrap.mjs'), wrapper = join(root, 'bwrap'), fdFile = join(root, 'options');
  // Only this test copy substitutes the fixed binary with an argv/FD recorder.
  // The shipped script has no environment variable or command override.
  const fixed = 'readonly genuine_bwrap=/opt/codex/codex-resources/bwrap';
  assert.equal(script.split(fixed).length, 2);
  writeFileSync(wrapper, script.replace(fixed, `readonly genuine_bwrap=${quote(genuine)}`), { mode: 0o755 });
  writeFileSync(genuine, `#!${process.execPath}
import { readFileSync } from 'node:fs';
console.log(JSON.stringify({ args: process.argv.slice(2), fd: readFileSync(3, 'utf8') }));
process.exit(Number(process.env.BB_SYNTHETIC_BWRAP_EXIT ?? 0));
`, { mode: 0o755 });
  const fdContent = '--unshare-pid\0--proc\0/proc\0';
  writeFileSync(fdFile, fdContent);
  return {
    fdContent,
    run(args, exit = 0) {
      const fd = openSync(fdFile, 'r');
      try {
        return spawnSync('/bin/bash', [wrapper, ...args], { encoding: 'utf8',
          env: { PATH: '/usr/bin:/bin', BB_SYNTHETIC_BWRAP_EXIT: String(exit) }, stdio: ['ignore', 'pipe', 'pipe', fd] });
      } finally { closeSync(fd); }
    },
    close() { rmSync(root, { recursive: true, force: true }); },
  };
}

test('hardening preserves exact options, separator-valued arguments, command argv and inherited FDs', { skip: !shell }, () => {
  const f = fixture();
  try {
    const options = ['--unshare-pid', '--args', '3', '--ro-bind', '/source with spaces', '/destination with spaces', '--setenv', 'SYNTHETIC', '--'];
    const command = ['/synthetic program', '--', 'argument with spaces'];
    const result = f.run([...options, '--', ...command]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { args: [...options, '--perms', '000', '--tmpfs', '/proc', '--remount-ro', '/proc', '--', ...command], fd: f.fdContent });
  } finally { f.close(); }
});

test('standalone help/version preserve the upstream invocation', { skip: !shell }, () => {
  const f = fixture();
  try {
    for (const option of ['--help', '--version']) {
      const result = f.run([option]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { args: [option], fd: f.fdContent });
    }
  } finally { f.close(); }
});

test('missing commands, truncated options and unknown options fail before the binary is called', { skip: !shell }, () => {
  const f = fixture();
  try {
    for (const args of [[], ['--'], ['--unshare-pid'], ['--ro-bind', '/only-source'], ['--future-option', '--', '/synthetic']]) {
      const result = f.run(args);
      assert.equal(result.status, 64);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /refusing execution/);
    }
  } finally { f.close(); }
});

test('the upstream failure exit status remains a failure', { skip: !shell }, () => {
  const f = fixture();
  try { assert.equal(f.run(['--', '/synthetic'], 73).status, 73); }
  finally { f.close(); }
});

test('the worker image ships the fixed root-owned wrapper and the installer validates its source', () => {
  const dockerfile = readFileSync(fileURLToPath(new URL('../Dockerfile', import.meta.url)), 'utf8');
  const installer = readFileSync(fileURLToPath(new URL('./install-codex-file-sandbox.sh', import.meta.url)), 'utf8');
  assert.match(dockerfile, /COPY --chown=root:root --chmod=0755 deploy\/m1\/scripts\/codex-bwrap\.sh \/usr\/local\/bin\/bwrap/);
  assert.match(dockerfile, /\/usr\/local\/bin\/bwrap --version/);
  assert.match(installer, /test -r "\$wrapper"/);
  assert.match(installer, /\/bin\/bash -n "\$wrapper"/);
});
