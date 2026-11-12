// Real role entry/source scripts and Git history; synthetic evidence commands
// stop before any Docker operation. Requires Bash and never runs a real gate.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const validators = ['scripts/prospectus-quality-gate.mjs', 'scripts/release-smoke/verify.mjs', 'scripts/release-smoke/support.mjs','scripts/release-smoke/evidence-schema.mjs','scripts/release-smoke/verify-images.mjs','scripts/release-smoke/rollback-readiness.mjs','scripts/release-smoke/model-quality-evidence.mjs','scripts/release-smoke/image-contract.mjs','scripts/release-smoke/upload-confirmation-evidence.mjs'];
const entries = ['main', 'execution'].flatMap(role => [
  { role, script: 'deploy-role.sh' }, { role, script: 'export-images-role.sh', exporting: true },
]);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bb-role-source-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scripts = join(dir, 'deploy/m1/scripts'), trace = join(dir, 'trace');
  mkdirSync(scripts, { recursive: true }); mkdirSync(join(dir, 'scripts/release-smoke'), { recursive: true });
  for (const name of ['deploy-role.sh', 'export-images-role.sh', 'role-source-lib.sh', 'release-evidence.sh'])
    cpSync(join(root, 'deploy/m1/scripts', name), join(scripts, name));
  writeFileSync(join(scripts, 'role-lib.sh'), `set -euo pipefail
BB_REPO="$TEST_REPO"
BB_DEPLOY_SCRIPT_SHA="\${TEST_SCRIPT_PIN:-}"
role_compose_arguments() { :; }
source "$(dirname "\${BASH_SOURCE[0]}")/role-source-lib.sh"
`);
  const gate = `import {appendFileSync} from 'node:fs';
appendFileSync(process.env.TEST_TRACE,'synthetic evidence command executed\\n');
process.exit(89);
`;
  for (const file of validators.slice(0, 2)) writeFileSync(join(dir, file), gate);
  for (const file of validators.slice(2)) writeFileSync(join(dir, file), '// Synthetic dependency, not a production validator.\n');
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Synthetic source test');
  git('config', 'user.email', 'synthetic@example.invalid'); git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('remote', 'add', 'origin', 'https://github.com/ITSophiaXu/BondBuddy.git');
  git('add', '.'); git('commit', '-qm', 'synthetic trusted deployment script source');
  const sha = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/develop', sha);
  writeFileSync(trace, '');
  const quality = join(dir, 'synthetic-quality.json'), smoke = join(dir, 'synthetic-smoke.json');
  writeFileSync(quality, '{}\n'); writeFileSync(smoke, '{}\n');
  const run = (entry, { app = sha, pin, ...extra } = {}) => {
    const env = { ...process.env, TEST_REPO: dir, TEST_TRACE: trace, BB_RELEASE_QUALITY_RECEIPT: quality,
      BB_RELEASE_SMOKE_REPORT: smoke, ...extra };
    delete env.TEST_SCRIPT_PIN;
    if (pin !== undefined) env.TEST_SCRIPT_PIN = pin;
    const args = [entry.role, app, ...(entry.exporting ? [join(dir, 'images.tar.gz'), 'disabled'] : [])];
    return spawnSync('bash', [join(scripts, entry.script), ...args], { cwd: dir, env, encoding: 'utf8' });
  };
  return { dir, trace, sha, git, run, recorded: () => readFileSync(trace, 'utf8') };
}

for (const entry of entries) {
  const label = `${entry.script} ${entry.role}`;
  test(`${label} checks every tracked validator before executing evidence`, t => {
    const f = fixture(t);
    for (const pin of [undefined, f.sha]) {
      for (const path of validators) for (const staged of [false, true]) {
        const absolute = join(f.dir, path), original = readFileSync(absolute);
        writeFileSync(absolute, Buffer.concat([original, Buffer.from('\n// synthetic unreviewed edit\n')]));
        if (staged) f.git('add', path);
        const result = f.run(entry, { pin });
        assert.equal(result.status, 2, result.stderr);
        assert.match(result.stderr, /deployment directory must be clean/);
        assert.equal(f.recorded(), '');
        if (staged) f.git('reset', '--quiet', 'HEAD', '--', path);
        writeFileSync(absolute, original);
      }
    }
  });

  test(`${label} refuses missing or untracked validator dependencies before evidence`, t => {
    const f = fixture(t), path = validators[2], absolute = join(f.dir, path), original = readFileSync(absolute);
    rmSync(absolute);
    let result = f.run(entry);
    assert.equal(result.status, 2, result.stderr); assert.equal(f.recorded(), '');
    writeFileSync(absolute, original); f.git('rm', '--cached', path);
    result = f.run(entry);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /validators must belong/); assert.equal(f.recorded(), '');
  });

  test(`${label} accepts clean source without expanding checks to unrelated product files`, t => {
    const f = fixture(t);
    mkdirSync(join(f.dir, 'apps'), { recursive: true }); writeFileSync(join(f.dir, 'apps/unrelated.txt'), 'uncommitted product fixture\n');
    const result = f.run(entry, { pin: f.sha });
    assert.equal(result.status, 89, result.stderr);
    assert.equal(f.recorded(), 'synthetic evidence command executed\n');
  });
}

for (const role of ['main', 'execution']) {
  test(`${role} requires an explicit script pin when validator source differs from the app commit`, t => {
    const f = fixture(t), path = validators[2];
    writeFileSync(join(f.dir, path), '// Synthetic independently reviewed validator dependency.\n');
    f.git('add', path); f.git('commit', '-qm', 'synthetic independent script update');
    const script = f.git('rev-parse', 'HEAD'); f.git('update-ref', 'refs/remotes/origin/develop', script);
    let result = f.run({ role, script: 'deploy-role.sh' });
    assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, /pin BB_DEPLOY_SCRIPT_SHA/);
    assert.equal(f.recorded(), '');
    result = f.run({ role, script: 'deploy-role.sh' }, { pin: f.sha });
    assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, /checkout must match/);
    assert.equal(f.recorded(), '');
    result = f.run({ role, script: 'deploy-role.sh' }, { pin: script });
    assert.equal(result.status, 89, result.stderr); assert.equal(f.recorded(), 'synthetic evidence command executed\n');
  });
}

test('a failed source-status lookup cannot be mistaken for a clean script checkout', t => {
  const f = fixture(t), bin = join(f.dir, 'bin'); mkdirSync(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh
case "$*" in *' status '*) echo 'synthetic Git status failure' >&2; exit 23;; esac
exec "$TEST_REAL_GIT" "$@"
`, { mode: 0o755 });
  const result = f.run({ role: 'main', script: 'deploy-role.sh' }, { PATH: bin + ':' + process.env.PATH, TEST_REAL_GIT: realGit });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /cannot verify deployment and evidence-validator source state/);
  assert.equal(f.recorded(), '');
});
