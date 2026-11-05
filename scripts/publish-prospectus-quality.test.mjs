// SYNTHETIC command-adapter tests only. No acceptance document or GitHub status is created.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { publishProspectusQuality, RELEASE_STATUS, repositoryFromRemote, gateEnvironment } from './publish-prospectus-quality.mjs';

const commit = 'a'.repeat(40), tree = 'b'.repeat(40);
function harness({ failGate = false, failVerify = false, failPending = false, failFailure = false, failSuccess = false, changed = false, dirty = false, missingReceipt = false } = {}) {
  const calls = [], statuses = []; let headReads = 0;
  const env = { GH_TOKEN: 'synthetic-publisher-credential', GITHUB_TOKEN: 'synthetic-other-credential',
    GH_CONFIG_DIR: '/synthetic/credential-home', BB_PROSPECTUS_ACCEPTANCE_FILE: '/private/operator-supplied-evidence.json' };
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'git') {
      if (args.join(' ') === 'rev-parse HEAD') return (++headReads > 1 && changed ? 'c'.repeat(40) : commit) + '\n';
      if (args.join(' ') === 'rev-parse HEAD^{tree}') return tree + '\n';
      if (args[0] === 'status') return dirty ? ' M candidate.ts\n' : '';
      if (args[0] === 'remote') return 'https://github.com/ITSophiaXu/BondBuddy.git\n';
    }
    if (command === 'gh') {
      const body = JSON.parse(options.input); statuses.push(body);
      assert.equal(body.context, RELEASE_STATUS);
      assert.deepEqual(args, ['api', '--hostname', 'github.com', '--method', 'POST', `repos/ITSophiaXu/BondBuddy/statuses/${commit}`, '--input', '-']);
      assert.equal(options.env.GH_TOKEN, env.GH_TOKEN);
      if ((failPending && body.state === 'pending') || (failFailure && body.state === 'failure') || (failSuccess && body.state === 'success')) throw new Error('SYNTHETIC_GH_ERROR');
      return '{}';
    }
    if (command === 'synthetic-node') {
      assert.equal(options.env.GH_TOKEN, undefined); assert.equal(options.env.GITHUB_TOKEN, undefined); assert.equal(options.env.GH_CONFIG_DIR, undefined);
      assert.equal(options.env.BB_PROSPECTUS_ACCEPTANCE_FILE, env.BB_PROSPECTUS_ACCEPTANCE_FILE);
      assert.equal(args[0], 'scripts/prospectus-quality-gate.mjs');
      if ((failGate && args[1] === 'run') || (failVerify && args[1] === 'verify')) throw new Error('SYNTHETIC_RUNNER_REJECTION');
      return '';
    }
    throw new Error('Unexpected synthetic command');
  };
  return { calls, statuses, invoke: options => publishProspectusQuality({ commit, cwd: '/synthetic/reviewed-checkout', platform: 'linux', env,
    node: 'synthetic-node', run, read: () => { if (missingReceipt) throw new Error('SYNTHETIC_MISSING_RECEIPT'); return Buffer.from('SYNTHETIC runner output placeholder; NOT an acceptance record or release receipt'); }, ...options }) };
}
test('controlled publisher runs the full gate then exact-SHA verification before success', () => {
  const h = harness(), result = h.invoke();
  assert.deepEqual(h.statuses.map(s => s.state), ['pending', 'success']);
  const children = h.calls.filter(c => c.command === 'synthetic-node');
  assert.deepEqual(children.map(c => c.args[1]), ['run', 'verify']);
  assert.equal(children[0].args[2], '.local/prospectus-quality.json');
  assert.equal(children[1].args[2], commit);
  assert.equal(result.commit, commit); assert.equal(result.tree, tree);
  assert.match(result.receipt_sha256, /^[a-f0-9]{64}$/);
  assert.ok(h.calls.indexOf(children[1]) < h.calls.findIndex(c => c.command === 'gh' && JSON.parse(c.options.input).state === 'success'));
  assert.ok(!JSON.stringify(h.statuses).includes('/private/'));
  assert.ok(h.statuses.every(s => s.description.length <= 140));
});
for (const [label, options] of [
  ['full gate rejects missing or invalid acceptance', { failGate: true }], ['receipt verification rejects', { failVerify: true }],
  ['source changes during verification', { changed: true }], ['runner leaves no receipt', { missingReceipt: true }],
]) test(`publisher posts failure, never success, when ${label}`, () => {
  const h = harness(options); assert.throws(() => h.invoke());
  assert.deepEqual(h.statuses.map(s => s.state), ['pending', 'failure']);
});
test('failure to establish pending stops before running candidate code', () => {
  const h = harness({ failPending: true }); assert.throws(() => h.invoke());
  assert.deepEqual(h.statuses.map(s => s.state), ['pending']);
  assert.equal(h.calls.filter(c => c.command === 'synthetic-node').length, 0);
});
test('failed failure-status update is an error and never becomes success', () => {
  const h = harness({ failGate: true, failFailure: true }); assert.throws(() => h.invoke(), /FAILURE_STATUS_UNAVAILABLE/);
  assert.deepEqual(h.statuses.map(s => s.state), ['pending', 'failure']);
});
test('success API failure does not report a successful publisher invocation', () => {
  const h = harness({ failSuccess: true }); assert.throws(() => h.invoke());
  assert.equal(h.statuses.at(-1).state, 'failure');
});
test('dirty, abbreviated, different and non-Linux candidates cannot publish any status', () => {
  for (const [setup, options] of [[{ dirty: true }, {}], [{}, { commit: 'a'.repeat(12) }], [{}, { commit: 'c'.repeat(40) }], [{}, { platform: 'win32' }]]) {
    const h = harness(setup); assert.throws(() => h.invoke(options)); assert.equal(h.statuses.length, 0);
  }
});
test('only canonical GitHub origins become status destinations', () => {
  assert.equal(repositoryFromRemote('git@github.com:ITSophiaXu/BondBuddy.git'), 'ITSophiaXu/BondBuddy');
  for (const origin of ['file:///private/clone', 'https://elsewhere.invalid/ITSophiaXu/BondBuddy.git', 'https://github.com/owner/repo?token=private'])
    assert.throws(() => repositoryFromRemote(origin));
});
test('GitHub publisher credentials are not forwarded in the candidate command environment', () => {
  const child = gateEnvironment({ GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', GH_ENTERPRISE_TOKEN: 'secret', GITHUB_ENTERPRISE_TOKEN: 'secret',
    GH_CONFIG_DIR: '/credentials', BONDBUDDY_TEST_PYTHON: '/python', BB_PROSPECTUS_ACCEPTANCE_FILE: '/private/evidence.json' });
  assert.deepEqual(child, { BONDBUDDY_TEST_PYTHON: '/python', BB_PROSPECTUS_ACCEPTANCE_FILE: '/private/evidence.json' });
});
test('hosted CI only runs mechanical validation and never uploads a release receipt', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../.github/workflows/prospectus-quality.yml', import.meta.url)), 'utf8');
  assert.match(workflow, /name: prospectus-quality-mechanical/);
  assert.match(workflow, /run: node scripts\/prospectus-quality-gate\.mjs validate/);
  assert.doesNotMatch(workflow, /run: node scripts\/prospectus-quality-gate\.mjs run/);
  assert.doesNotMatch(workflow, /\.local\/prospectus-quality\.json/);
  assert.doesNotMatch(workflow, /statuses: write|contents: write/);
});
