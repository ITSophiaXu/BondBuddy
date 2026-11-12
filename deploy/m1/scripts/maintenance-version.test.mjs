// Real maintenance/restore entry scripts with synthetic lifecycle helpers.
// Requires Bash; never starts Docker, restores a database, or accesses a network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const retained = 'a'.repeat(12), candidate = 'b'.repeat(12);

function fixture(t, current = retained) {
  const dir = mkdtempSync(join(tmpdir(), 'bb-maintenance-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scripts = join(dir, 'deploy/m1/scripts'), state = join(dir, 'state');
  const backup = join(dir, 'backup'), calls = join(dir, 'calls');
  for (const path of [scripts, state, join(backup, 'blobs')]) mkdirSync(path, { recursive: true });
  for (const name of ['role-compose.sh', 'restore.sh']) cpSync(join(root, 'deploy/m1/scripts', name), join(scripts, name));
  writeFileSync(calls, '');
  if (current !== null) writeFileSync(join(state, 'current'), current + '\n');
  writeFileSync(join(backup, 'db.dump'), 'synthetic database fixture\n');
  writeFileSync(join(backup, 'manifest.txt'), 'synthetic fixture\n');
  const helpers = `set -euo pipefail
BB_STATE="$TEST_STATE"
BB_DIR="$TEST_ROOT/deploy/m1"
current_tag() { cat "$BB_STATE/current" 2>/dev/null || true; }
compose() { printf 'compose\\t%s\\t%s\\n' "$BB_IMAGE_TAG" "$*" >> "$TEST_CALLS"; }
log_release() { printf 'release\\t%s\\n' "$*" >> "$TEST_CALLS"; }
role_compose_arguments() { :; }
role_script_source() { :; }
role_existing_state() {
  if [ -f "$BB_STATE/pending-release.json" ]; then echo 'pending role release' >&2; exit 3; fi
  if [ "\${TEST_EXISTING:-0}" = 1 ] && [ -z "$(current_tag)" ]; then echo 'existing role project has no retained release state' >&2; exit 2; fi
}
role_probe() { printf 'probe\\t%s\\t%s\\n' "$BB_IMAGE_TAG" "$*" >> "$TEST_CALLS"; }
`;
  for (const name of ['lib.sh', 'role-lib.sh']) writeFileSync(join(scripts, name), helpers);
  const run = (script, args, extra = {}) => {
    const env = { ...process.env, TEST_ROOT: dir, TEST_STATE: state, TEST_CALLS: calls, BB_BACKUP_DIR: join(dir, 'downloaded'), ...extra };
    if (!Object.hasOwn(extra, 'BB_IMAGE_TAG')) delete env.BB_IMAGE_TAG;
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
    return spawnSync('bash', [join(scripts, script), ...args], { cwd: dir, env, encoding: 'utf8' });
  };
  return { dir, state, backup, calls, run, recorded: () => readFileSync(calls, 'utf8') };
}

for (const role of ['main', 'execution']) {
  test(`${role} refuses leading global options and ungated image-preparation commands`, t => {
    for (const current of [retained, '']) {
      const f = fixture(t, current);
      for (const args of [[], ['--ansi', 'never', 'up', 'api'], ['--ansi=never', 'create', 'worker'],
        ['--progress', 'plain', 'run', 'api'], ['--', 'up', '--no-deps', 'egress'],
        ['build'], ['pull', 'egress'], ['watch', '--no-up'], ['scale', 'worker=2'], ['scale', '--no-deps', 'api=2']]) {
        const result = f.run('role-compose.sh', [role, ...args], { BB_IMAGE_TAG: candidate });
        assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
        assert.match(result.stderr, /subcommand first|evidence gates/);
        assert.equal(f.recorded(), '');
      }
    }
  });

  for (const command of ['up', 'create', 'run', 'probe']) {
    test(`${role} ${command} refuses another release before lifecycle commands`, t => {
      const f = fixture(t), args = command === 'probe' ? ['connect'] : ['--no-deps', role === 'main' ? 'api' : 'worker'];
      const result = f.run('role-compose.sh', [role, command, ...args], { BB_IMAGE_TAG: candidate });
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /deploy-role\.sh/);
      assert.equal(f.recorded(), '');
    });

    test(`${role} ${command} keeps the retained release with default or explicit tag`, t => {
      const f = fixture(t), args = command === 'probe' ? ['schema'] : [role === 'main' ? 'api' : 'worker'];
      for (const extra of [{}, { BB_IMAGE_TAG: retained }]) {
        const result = f.run('role-compose.sh', [role, command, ...args], extra);
        assert.equal(result.status, 0, result.stderr);
      }
      assert.match(f.recorded(), new RegExp(`\\t${retained}\\t`));
      assert.doesNotMatch(f.recorded(), new RegExp(candidate));
    });
  }

  for (const command of ['config', 'ps', 'logs', 'images', 'port', 'version']) {
    test(`${role} ${command} retains read-only candidate inspection without current`, t => {
      const f = fixture(t, '');
      const result = f.run('role-compose.sh', [role, command], { BB_IMAGE_TAG: candidate });
      assert.equal(result.status, 0, result.stderr);
      assert.match(f.recorded(), new RegExp(`\\t${candidate}\\t${command}`));
    });
  }

  const infrastructure = role === 'main' ? 'postgres' : 'pg-tunnel';
  for (const command of ['up', 'create']) {
    test(`${role} first ${command} allows only explicit infrastructure without dependencies`, t => {
      const f = fixture(t, '');
      for (const services of [[infrastructure], ['egress'], [infrastructure, 'egress']]) {
        const result = f.run('role-compose.sh', [role, command, '--no-deps', ...services], { BB_IMAGE_TAG: candidate });
        assert.equal(result.status, 0, result.stderr);
        assert.ok(f.recorded().includes(`${command} --no-deps ${services.join(' ')}\n`));
      }
      assert.equal(readFileSync(join(f.state, 'current'), 'utf8'), '\n');
    });
  }

  test(`${role} bootstrap refuses implicit services, dependencies, application containers and option tricks`, t => {
    const f = fixture(t, '');
    const invalid = [
      ['up'], ['up', '--no-deps'], ['up', infrastructure],
      ['up', '--no-deps', 'api'], ['up', '--no-deps', 'worker'], ['up', '--no-deps', 'migrate'],
      ['up', '--no-deps', infrastructure, 'worker-review'],
      ['up', '--no-deps', 'egress', 'api'], ['up', 'egress'],
      ['up', '--no-deps', 'egress', '--build'], ['up', '--no-deps', 'egress', '--pull=always'],
      ['create', '--no-deps', role === 'main' ? 'pg-tunnel' : 'postgres'],
      ['up', '--no-deps', '--build', infrastructure],
      ['up', '--no-deps', '--scale', 'worker=1', infrastructure],
      ['up', '--no-deps', '--', infrastructure],
      ['run', '--no-deps', infrastructure], ['probe', 'connect'],
    ];
    for (const args of invalid) {
      const result = f.run('role-compose.sh', [role, ...args], { BB_IMAGE_TAG: candidate });
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
      assert.match(result.stderr, /deploy-role\.sh/);
      assert.equal(f.recorded(), '');
    }
    const noTag = f.run('role-compose.sh', [role, 'up', '--no-deps', infrastructure]);
    assert.equal(noTag.status, 2, noTag.stderr);
    assert.equal(f.recorded(), '');
  });

  test(`${role} bootstrap cannot adopt an existing untracked project or bypass pending`, t => {
    const f = fixture(t, ''), args = [role, 'up', '--no-deps', infrastructure];
    let result = f.run('role-compose.sh', args, { BB_IMAGE_TAG: candidate, TEST_EXISTING: '1' });
    assert.equal(result.status, 2, result.stderr); assert.equal(f.recorded(), '');
    writeFileSync(join(f.state, 'pending-release.json'), '{}');
    result = f.run('role-compose.sh', args, { BB_IMAGE_TAG: candidate, BB_PENDING_COMMAND: '1', BB_ROLE_READONLY: '1' });
    assert.equal(result.status, 3, result.stderr); assert.equal(f.recorded(), '');
  });
}

for (const source of ['local', 'blob']) for (const current of [retained, '', null]) {
  test(`restore ${source} rejects ${current ? 'another image tag' : current === null ? 'missing current' : 'empty current'} before download or database changes`, t => {
    const f = fixture(t, current), input = source === 'local' ? f.backup : 'blob:20261111T120000Z-synthetic';
    const result = f.run('restore.sh', [input], { BB_IMAGE_TAG: candidate });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /retained current image tag/);
    assert.equal(f.recorded(), '');
    assert.equal(existsSync(join(f.dir, 'downloaded')), false);
  });
}

test('restore keeps the current version while invoking the existing data-recovery sequence', t => {
  const f = fixture(t), result = f.run('restore.sh', [f.backup]);
  assert.equal(result.status, 0, result.stderr);
  const calls = f.recorded();
  assert.match(calls, new RegExp(`compose\\t${retained}\\tstop `));
  assert.match(calls, /pg_restore/);
  assert.match(calls, new RegExp(`compose\\t${retained}\\tup -d --wait `));
  assert.match(calls, /release\trestore /);
});
