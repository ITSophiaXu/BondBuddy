// Real evidence validators and real deployment entry scripts, with synthetic
// Docker/topology commands. No Docker daemon, migration, model or host installer
// is invoked. Topology/pending-recovery behavior has separate lifecycle tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { POLICY, REQUIRED_CHECKS } from '../../../scripts/prospectus-quality-gate.mjs';
import {fiveFlowFixture,SYNTHETIC_INSPECTOR_SOURCE} from '../../../scripts/release-smoke/evidence-fixtures.mjs';

const root = resolve(import.meta.dirname, '../../..');
const digest = value => createHash('sha256').update(value).digest('hex');
const imageId = 'sha256:' + 'd'.repeat(64);
const entries = [
  { script: 'deploy.sh' }, { script: 'export-images.sh', exporting: true },
  { script: 'rollback.sh', rollback: true },
  ...['main', 'execution'].flatMap(role => [
    { script: 'deploy-role.sh', role },
    { script: 'export-images-role.sh', role, exporting: true },
    { script: 'deploy-role.sh', role, rollback: true },
  ]),
];
const label = entry => [entry.script, entry.role, entry.rollback && '--rollback'].filter(Boolean).join(' ');

function fixture(t) {
  const dir = mkdtempSync(join(root, '.release-evidence-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scripts = join(dir, 'deploy/m1/scripts'), bin = join(dir, 'bin'), state = join(dir, 'state');
  for (const path of [scripts, bin, state, join(dir, 'docker-root'), join(dir, 'scripts/release-smoke'), join(dir, 'apps/worker/src')]) mkdirSync(path, { recursive: true });
  for (const name of ['deploy.sh', 'export-images.sh', 'rollback.sh', 'deploy-role.sh', 'export-images-role.sh', 'lib.sh', 'release-evidence.sh'])
    cpSync(join(root, 'deploy/m1/scripts', name), join(scripts, name));
  cpSync(join(root, 'scripts/prospectus-quality-gate.mjs'), join(dir, 'scripts/prospectus-quality-gate.mjs'));
  for (const name of ['verify.mjs', 'support.mjs','evidence-schema.mjs','verify-images.mjs','rollback-readiness.mjs','model-quality-evidence.mjs','image-contract.mjs','upload-confirmation-evidence.mjs']) cpSync(join(root, 'scripts/release-smoke', name), join(dir, 'scripts/release-smoke', name));
  writeFileSync(join(dir,'deploy/m1/Dockerfile'),'FROM scratch AS api\nFROM scratch AS worker\nFROM scratch AS web\n');
  writeFileSync(join(dir,'scripts/release-smoke/artifact-inspect-cli.mjs'),SYNTHETIC_INSPECTOR_SOURCE);
  writeFileSync(join(dir, 'apps/worker/src/runtime.ts'), '// synthetic BB_WORKER_RUN_KINDS marker\n');
  writeFileSync(join(dir, 'deploy/m1/.env'), 'BB_PROFILE=prod\nBB_HTTP_PORT=18090\n');
  for (const name of ['smoke.sh', 'install-codex-file-sandbox.sh']) writeFileSync(join(scripts, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // Only topology helpers are synthetic. Both verifier programs and their Git
  // commit/tree lookup are unmodified production code copied above.
  writeFileSync(join(scripts, 'role-source-lib.sh'), `role_script_source() { BB_DEPLOY_SCRIPT_SHA="$TEST_SHA"; BB_SCRIPT_SHA="$TEST_SHA"; }
role_trusted_source() { :; }
`);
  writeFileSync(join(scripts, 'role-lib.sh'), `export BB_ROLE_COMMAND=1
source "$(dirname "\${BASH_SOURCE[0]}")/lib.sh"
source "$(dirname "\${BASH_SOURCE[0]}")/role-source-lib.sh"
BB_INTEGRITY_MODE=disabled
BB_PARSE_ROLE="$BB_DEPLOY_ROLE"
BB_UPLOAD_CONFIRMATION_ROLE=disabled
role_confirmation_active() { return 1; }
role_compose_arguments() { :; }
role_existing_state() { :; }
role_existing_release() { :; }
role_image_ref() { printf 'bondbuddy-m1-%s:%s\\n' "$1" "$BB_IMAGE_TAG"; }
role_release_snapshot() { printf '{}\\n'; }
role_probe() { :; }
role_compose_raw() { compose "$@"; }
`);
  writeFileSync(join(scripts, 'role-release.mjs'), `import {writeFileSync,rmSync,readFileSync} from 'node:fs';
const [mode,state,role,sha]=process.argv.slice(2);
if(mode==='prepare')writeFileSync(state+'/pending-release.json','{}');
else if(mode==='clear'){rmSync(state+'/pending-release.json',{force:true});writeFileSync(state+'/current',sha.slice(0,12)+'\\n');}
else if(mode==='refs')console.log(process.env.TEST_SHA+'\\n'+process.env.TEST_SHA);
else if(mode==='verify'){const p=JSON.parse(readFileSync(state+'/pending-release.json','utf8'));console.log([readFileSync(state+'/current','utf8').trim(),p.from===''?'1':'0','0'].join('\\n'));}
else throw Error('Unexpected synthetic topology command');
`);
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env node
import fs from 'node:fs';
const a=process.argv.slice(2),e=process.env;
fs.appendFileSync(e.TEST_CALLS,JSON.stringify(a)+'\\n');
if(e.TEST_REWRITE_REPORTS==='1'){fs.writeFileSync(e.BB_RELEASE_QUALITY_RECEIPT,'{"status":"failed"}');fs.writeFileSync(e.BB_RELEASE_SMOKE_REPORT,'{"status":"failed"}');}
const out=x=>process.stdout.write(String(x)+'\\n');
if(a[0]==='image'&&a[1]==='inspect'){if(e.TEST_IMAGES_MISSING==='1')process.exit(1);if(a.includes('--format'))out(a[a.indexOf('--format')+1].includes('revision')?e.TEST_SHA:e.TEST_IMAGE_ID);else out(JSON.stringify([{Id:e.TEST_IMAGE_ID,Os:'linux',Architecture:'amd64',Config:{Labels:{'org.opencontainers.image.revision':e.TEST_SHA}}}]));}
else if(a[0]==='version')out(e.TEST_ENGINE_PLATFORM??'linux/amd64');
else if(a[0]==='inspect')out(e.TEST_IMAGE_ID);
else if(a[0]==='context')out('unix:///synthetic/docker.sock');
else if(a[0]==='info')out(e.TEST_ROOT+'/docker-root');
else if(a[0]==='image'&&a[1]==='ls')out('bondbuddy-m1-api:'+e.TEST_SHA.slice(0,12));
else if(a[0]==='save')out('synthetic image archive');
else if(a[0]==='compose'&&a.includes('ps')&&a.includes('-q')){if(!a.includes('upload-confirmation'))out('synthetic-container');}
`, { mode: 0o755 });
  writeFileSync(join(bin, 'df'), '#!/bin/sh\nprintf "Avail\\n107374182400\\n"\n', { mode: 0o755 });
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Synthetic gate test'); git('config', 'user.email', 'synthetic@example.invalid');
  git('add', '.'); git('commit', '-qm', 'synthetic deployment entry fixture');
  const sha = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  const qualityPath = join(dir, 'quality.json'), smokePath = join(dir, 'report.json'), calls = join(dir, 'calls');
  const stamp = new Date(Date.now() - 10_000).toISOString();
  const tap = { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  const quality = { schema_version: POLICY, status: 'passed', platform: 'linux', clean_tree: true, commit: sha, tree,
    started_at: stamp, finished_at: stamp,
    checks: REQUIRED_CHECKS.map(id => ({ id, status: 'passed', log_sha256: 'c'.repeat(64),
      ...(['gate-regressions', 'api-source-selection', 'browser-input-chain', 'worker-authoring'].includes(id) ? { summary: tap } : {}),
      ...(id === 'document-regressions' ? { summary: { tests: 1, passed: 1, failures: 0, errors: 0, skipped: 0, expected_failures: 0, unexpected_successes: 0, render_required: true, authorized_render_reports: 1, rendered_documents: 3 } } : {}),
      ...(id === 'real-model-acceptance' ? { summary: { status: 'passed', commit: sha, tree, real_model: true, case_count: 1, evidence_sha256: 'e'.repeat(64) } } : {}),
    })) };
  const smoke=fiveFlowFixture({commit:sha,tree,inspectorSha256:digest(SYNTHETIC_INSPECTOR_SOURCE)},stamp,Object.fromEntries(['api','worker','web'].map(target=>[target,{id:imageId,platform:'linux/amd64'}])));
  const save = () => { writeFileSync(qualityPath, JSON.stringify(quality)); writeFileSync(smokePath, JSON.stringify(smoke)); };
  save(); writeFileSync(calls, ''); writeFileSync(join(state, 'current'), sha.slice(0, 12) + '\n'); writeFileSync(join(state, 'releases.log'), '');
  const environment = { ...process.env, PATH: bin + ':' + process.env.PATH, BB_ENV_FILE: join(dir, 'deploy/m1/.env'), BB_STATE_DIR: state,
    BB_RELEASE_QUALITY_RECEIPT: qualityPath, BB_RELEASE_SMOKE_REPORT: smokePath,
    TEST_ROOT: dir, TEST_SHA: sha, TEST_IMAGE_ID: imageId, TEST_CALLS: calls };
  delete environment.DOCKER_HOST; delete environment.DOCKER_CONTEXT;
  const log = (role, rollback = false) => {
    const q = digest(readFileSync(qualityPath)), s = digest(readFileSync(smokePath));
    const entry = role ? `deploy-${role}\trecord=synthetic app=${sha} script=${sha} rollback=${rollback ? 1 : 0} quality_sha256=${q} smoke_sha256=${s}` : `deploy\t${sha.slice(0, 12)} commit=${sha} quality_sha256=${q} smoke_sha256=${s}`;
    writeFileSync(join(state, 'releases.log'), `${new Date().toISOString()}\t${entry}\n`);
  };
  const run = (entry, overrides = {}) => {
    const env = { ...environment, ...overrides };
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
    const args = [...(entry.role ? [entry.role] : []), sha, ...(entry.exporting ? [join(dir, 'images.tar.gz'), ...(entry.role ? ['disabled'] : [])] : []), ...(entry.script === 'deploy-role.sh' && entry.rollback ? ['--rollback'] : [])];
    return spawnSync('bash', [join(scripts, entry.script), ...args], { cwd: dir, env, encoding: 'utf8' });
  };
  return { dir, state, sha, tree, quality, smoke, qualityPath, smokePath, calls, save, log, run, git };
}

function noReleaseEffects(f, current = f.sha.slice(0, 12)) {
  const calls = readFileSync(f.calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(calls.every(args => !['build', 'save', 'up', 'run', 'stop', 'rm'].some(word => args.includes(word))), JSON.stringify(calls));
  assert.equal(existsSync(join(f.dir, 'images.tar.gz')), false);
  assert.equal(existsSync(join(f.state, 'pending-release.json')), false);
  assert.equal(readFileSync(join(f.state, 'current'), 'utf8'), current + '\n');
}

for (const entry of entries) for (const [condition, overrides, error] of [
  ['different image ID', { TEST_IMAGE_ID: 'sha256:' + 'b'.repeat(64) }, /differs from the tested image ID/],
  ['different target architecture', { TEST_ENGINE_PLATFORM: 'linux/arm64' }, /different architecture/],
  ['unavailable tested image', { TEST_IMAGES_MISSING: '1' }, /[Mm]issing.*image|[Ii]mage.*(?:missing|unavailable)|[Tt]ested image is unavailable/],
]) {
  test(`${label(entry)} rejects ${condition} before release effects`, t => {
    const f = fixture(t);
    if (entry.rollback) f.log(entry.role);
    const before = readFileSync(join(f.state, 'releases.log'), 'utf8');
    const result = f.run(entry, overrides);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, error);
    noReleaseEffects(f);
    assert.equal(readFileSync(join(f.state, 'releases.log'), 'utf8'), before);
  });
}

for (const entry of entries.filter(entry => !entry.rollback && !entry.exporting)) {
  test(`${label(entry)} refuses a legacy current version with no original rollback receipts`, t => {
    const f = fixture(t);
    f.git('commit', '--allow-empty', '-qm', 'synthetic previously deployed version');
    const legacy = f.git('rev-parse', 'HEAD').slice(0, 12);
    writeFileSync(join(f.state, 'current'), legacy + '\n');
    const result = f.run(entry);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /no verifiable rollback evidence/);
    noReleaseEffects(f, legacy);
    assert.equal(readFileSync(join(f.state, 'releases.log'), 'utf8'), '');
  });
}

for (const entry of entries) for (const kind of ['quality', 'smoke']) for (const missing of [true, false]) {
  test(`${label(entry)} rejects ${missing ? 'missing' : 'failed'} ${kind} evidence before release effects`, t => {
    const f = fixture(t);
    if (entry.rollback) f.log(entry.role);
    const before = readFileSync(join(f.state, 'releases.log'), 'utf8');
    const key = kind === 'quality' ? 'BB_RELEASE_QUALITY_RECEIPT' : 'BB_RELEASE_SMOKE_REPORT';
    if (!missing) { f[kind].status = 'failed'; f.save(); }
    const result = f.run(entry, missing ? { [key]: undefined } : {});
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, missing ? new RegExp(key) : kind === 'quality' ? /quality|Quality/ : /smoke|Smoke/);
    noReleaseEffects(f);
    assert.equal(readFileSync(join(f.state, 'releases.log'), 'utf8'), before);
  });
}

for (const entry of entries.filter(entry => !entry.rollback)) {
  test(`${label(entry)} accepts both current-commit reports and records both hashes after deployment`, t => {
    const f = fixture(t), result = f.run(entry);
    assert.equal(result.status, 0, result.stderr);
    if (entry.exporting) assert.ok(readFileSync(join(f.dir, 'images.tar.gz')).length > 0);
    else {
      const log = readFileSync(join(f.state, 'releases.log'), 'utf8');
      assert.ok(log.includes('quality_sha256=' + digest(readFileSync(f.qualityPath))), log);
      assert.ok(log.includes('smoke_sha256=' + digest(readFileSync(f.smokePath))), log);
      assert.deepEqual(readFileSync(join(f.state, 'quality', f.sha + '.json')), readFileSync(f.qualityPath));
      assert.deepEqual(readFileSync(join(f.state, 'release-smoke', f.sha + '.json')), readFileSync(f.smokePath));
    }
  });
}

for (const entry of entries.filter(entry => entry.rollback)) {
  test(`${label(entry)} needs an exact successful deployment record before reusing expired evidence`, t => {
    const f = fixture(t), expired = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    f.quality.started_at = f.quality.finished_at = expired;
    f.smoke.startedAt = f.smoke.completedAt = f.smoke.finishedAt = expired;
    for (const entry of f.smoke.cases) entry.finishedAt = expired;
    f.save();
    let result = f.run(entry);
    assert.notEqual(result.status, 0); noReleaseEffects(f);
    if (entry.role) {
      f.log(entry.role, true); writeFileSync(f.calls, '');
      result = f.run(entry); assert.notEqual(result.status, 0); noReleaseEffects(f);
      f.log(entry.role === 'main' ? 'execution' : 'main'); writeFileSync(f.calls, '');
      result = f.run(entry); assert.notEqual(result.status, 0); noReleaseEffects(f);
    }
    f.log(entry.role); writeFileSync(f.calls, '');
    result = f.run(entry); assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(f.calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(calls.every(args => !args.includes('migrate')), 'rollback must not migrate');
  });
}

test('a later change to caller report paths cannot replace the verified release evidence', t => {
  const f = fixture(t), quality = readFileSync(f.qualityPath), smoke = readFileSync(f.smokePath);
  const result = f.run({ script: 'deploy.sh' }, { TEST_REWRITE_REPORTS: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.notDeepEqual(readFileSync(f.qualityPath), quality);
  assert.notDeepEqual(readFileSync(f.smokePath), smoke);
  assert.deepEqual(readFileSync(join(f.state, 'quality', f.sha + '.json')), quality);
  assert.deepEqual(readFileSync(join(f.state, 'release-smoke', f.sha + '.json')), smoke);
  const log = readFileSync(join(f.state, 'releases.log'), 'utf8');
  assert.ok(log.includes('quality_sha256=' + digest(quality)));
  assert.ok(log.includes('smoke_sha256=' + digest(smoke)));
});

for (const role of ['main', 'execution']) for (const expired of [false, true]) {
  test(`${role} resumes a sealed pending candidate only with fresh evidence (${expired ? 'expired' : 'fresh'})`, t => {
    const f = fixture(t), pending = JSON.stringify({ from: 'a'.repeat(12), to: f.sha.slice(0, 12) });
    writeFileSync(join(f.state, 'pending-release.json'), pending);
    if (expired) {
      const stamp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      f.quality.started_at = f.quality.finished_at = stamp;
      f.smoke.startedAt = f.smoke.completedAt = f.smoke.finishedAt = stamp;
      for (const entry of f.smoke.cases) entry.finishedAt = stamp;
      f.save();
      // Even a prior success must not grant an age waiver to a new pending attempt.
      f.log(role);
    }
    const result = f.run({ script: 'deploy-role.sh', role, rollback: true });
    const calls = readFileSync(f.calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    if (expired) {
      assert.notEqual(result.status, 0); assert.match(result.stderr, /expired/);
      assert.ok(calls.every(args => !['up', 'run', 'stop', 'build'].some(word => args.includes(word))));
      assert.equal(readFileSync(join(f.state, 'pending-release.json'), 'utf8'), pending);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.ok(readFileSync(join(f.state, 'releases.log'), 'utf8').includes('resume_candidate=1'));
      assert.equal(existsSync(join(f.state, 'pending-release.json')), false);
      if (role === 'main') assert.ok(calls.some(args => args.includes('migrate')), 'continuing candidate must apply its migrations');
    }
  });
}
