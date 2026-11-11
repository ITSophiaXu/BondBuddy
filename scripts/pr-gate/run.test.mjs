// 合并前检查脚本自身的回归测试。只用合成的小测试文件，不连数据库、不调用模型。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { evaluateNode, evaluatePlaywright, evaluatePython, globToRegExp, judge, parseExclusions, parseTap, parseUnittest } from './run.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'run.mjs');
const environment = () => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.GITHUB_STEP_SUMMARY; delete env.GITHUB_SHA; return env; };
const gate = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: environment() });
const write = (root, path, content) => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); };
const PASS = "import test from 'node:test';\ntest('ok', () => {});\n";
const FAIL = "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('broken', () => { assert.equal(1, 2); });\n";
const SKIP = "import test from 'node:test';\ntest('ok', () => {});\ntest('needs a database', { skip: true }, () => {});\n";

/** 一个最小的假仓库：api 分组里有通过、失败、带跳过、不在检查里的测试各一个。 */
function fixture(exclusions) {
  const root = mkdtempSync(join(tmpdir(), 'pr-gate-test-'));
  for (const [name, body] of [['passes', PASS], ['fails', FAIL], ['skips', SKIP], ['real-model', FAIL]]) {
    write(root, `apps/api/src/${name}.test.ts`, '// source placeholder\n');
    write(root, `apps/api/dist/${name}.test.js`, body);
  }
  write(root, 'apps/api/src/not-a-test.ts', '');
  write(root, 'apps/api/node_modules/dep/src/ignored.test.ts', '');
  write(root, 'exclusions.json', JSON.stringify(exclusions));
  return root;
}
const baseExclusions = { notInCi: [{ pattern: 'apps/api/src/real-model.test.ts', reason: 'needs a real model' }], knownFailing: [], allowSkip: [] };
const summaryOf = (out, name) => JSON.parse(readFileSync(join(out, `summary-${name}.json`), 'utf8'));

test('TAP summary: the last block wins and a missing block is reported', () => {
  const output = '# tests 9\n# pass 9\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\nnoise\n# tests 3\n# suites 0\n# pass 1\n# fail 1\n# cancelled 0\n# skipped 1\n# todo 0\n';
  assert.deepEqual(parseTap(output), { tests: 3, pass: 1, fail: 1, cancelled: 0, skipped: 1, todo: 0 });
  assert.equal(parseTap('# tests 3\n# pass 3\n'), null);
});

test('node results: failure, timeout, empty run and skips are told apart', () => {
  const ok = '# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.equal(evaluateNode({ code: 0, stdout: ok, timedOut: false }).status, 'passed');
  assert.equal(evaluateNode({ code: 0, stdout: ok.replace('# tests 2', '# tests 0').replace('# pass 2', '# pass 0'), timedOut: false }).status, 'failed');
  assert.equal(evaluateNode({ code: 1, stdout: ok.replace('# fail 0', '# fail 1'), timedOut: false }).status, 'failed');
  assert.equal(evaluateNode({ code: null, signal: 'SIGKILL', stdout: '', timedOut: true }).reason, '超时');
  assert.equal(evaluateNode({ code: 0, stdout: 'no summary', timedOut: false }).status, 'failed');
  const skipped = evaluateNode({ code: 0, stdout: ok.replace('# skipped 0', '# skipped 1').replace('# todo 0', '# todo 2'), timedOut: false });
  assert.deepEqual([skipped.status, skipped.skipped], ['passed', 3]);
});

test('python results: OK, skipped, failed and empty runs', () => {
  assert.deepEqual(parseUnittest('Ran 4 tests in 0.1s\n\nOK (skipped=2)\n'), { tests: 4, ok: true, skipped: 2, failures: 0, errors: 0 });
  assert.equal(evaluatePython({ code: 0, stdout: '', stderr: 'Ran 4 tests in 0.1s\n\nOK\n', timedOut: false }).status, 'passed');
  assert.equal(evaluatePython({ code: 0, stdout: '', stderr: 'Ran 4 tests in 0.1s\n\nOK (skipped=1)\n', timedOut: false }).skipped, 1);
  assert.equal(evaluatePython({ code: 1, stdout: '', stderr: 'Ran 4 tests in 0.1s\n\nFAILED (failures=1, errors=2, skipped=1)\n', timedOut: false }).status, 'failed');
  assert.equal(evaluatePython({ code: 0, stdout: '', stderr: 'Ran 0 tests in 0.0s\n\nOK\n', timedOut: false }).status, 'failed');
  const classSkipped = evaluatePython({ code: 0, stdout: '', stderr: 'Ran 0 tests in 0.0s\n\nOK (skipped=1)\n', timedOut: false });
  assert.deepEqual([classSkipped.status, classSkipped.skipped], ['passed', 1], 'a wholly skipped class is a skip, not a failure');
  assert.equal(evaluatePython({ code: 5, stdout: '', stderr: 'Ran 0 tests in 0.0s\n\nNO TESTS RAN\n', timedOut: false }).status, 'failed');
});

test('browser report: per-file failures, flaky tests, skips, load errors and a missing report', () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map(name => ({ id: `apps/web/tests/${name}.spec.ts` }));
  const spec = status => ({ tests: [{ status }] });
  const report = { errors: [{ message: 'e.spec.ts failed to load' }], suites: [
    { file: 'a.spec.ts', specs: [spec('expected')], suites: [{ title: 'nested', file: 'a.spec.ts', specs: [spec('expected')] }] },
    { file: 'b.spec.ts', specs: [spec('expected'), spec('unexpected')] },
    { file: 'c.spec.ts', specs: [spec('flaky')] },
    { file: 'd.spec.ts', specs: [spec('expected'), spec('skipped')] },
  ] };
  const byId = Object.fromEntries(evaluatePlaywright(report, items, { code: 1 }).results.map(result => [result.id.split('/').at(-1), result]));
  assert.deepEqual([byId['a.spec.ts'].status, byId['a.spec.ts'].tests], ['passed', 2]);
  assert.equal(byId['b.spec.ts'].status, 'failed');
  assert.equal(byId['c.spec.ts'].status, 'failed');
  assert.deepEqual([byId['d.spec.ts'].status, byId['d.spec.ts'].skipped], ['passed', 1]);
  assert.match(byId['e.spec.ts'].reason, /加载出错/);
  assert.ok(evaluatePlaywright(null, items, { code: 1 }).results.every(result => result.status === 'failed'));
  const clean = { errors: [], suites: [{ file: 'a.spec.ts', specs: [spec('expected')] }] };
  assert.equal(evaluatePlaywright(clean, [items[0]], { code: 1 }).problems.length, 1, 'a non-zero exit with no failing file is still a problem');
});

test('exclusion patterns and validation', () => {
  assert.ok(globToRegExp('apps/web/tests/local-*.spec.ts').test('apps/web/tests/local-a.spec.ts'));
  assert.ok(!globToRegExp('apps/web/tests/local-*.spec.ts').test('apps/web/tests/x/local-a.spec.ts'));
  assert.ok(!globToRegExp('apps/api/src/a.test.ts').test('apps/api/src/aXtest.ts'), 'a dot is literal');
  assert.ok(globToRegExp('apps/**/*.pg.test.ts').test('apps/api/src/billing.pg.test.ts'));
  assert.throws(() => parseExclusions({ notInCi: [{ pattern: 'a' }] }), /reason/);
  assert.throws(() => parseExclusions({ quarantine: [] }), /不认识的字段/);
  assert.doesNotThrow(() => parseExclusions({ _note: 'x' }));
});

test('verdict: unlisted failures and unlisted skips block; listed ones do not', () => {
  const lists = parseExclusions({ knownFailing: [{ pattern: 'known.test.ts', reason: 'r' }, { pattern: 'fixed.test.ts', reason: 'r' }], allowSkip: [{ pattern: 'may-skip.test.ts', reason: 'r' }] });
  const verdict = judge([
    { id: 'new-failure.test.ts', status: 'failed', reason: 'x', skipped: 0 }, { id: 'known.test.ts', status: 'failed', reason: 'x', skipped: 0 },
    { id: 'fixed.test.ts', status: 'passed', skipped: 0 }, { id: 'may-skip.test.ts', status: 'passed', skipped: 2 },
    { id: 'surprise-skip.test.ts', status: 'passed', skipped: 1 }, { id: 'fine.test.ts', status: 'passed', skipped: 0 },
  ], lists);
  assert.equal(verdict.status, 'failed');
  assert.deepEqual(verdict.blocking.map(row => [row.id, row.kind]), [['new-failure.test.ts', 'failed'], ['surprise-skip.test.ts', 'skipped']]);
  assert.deepEqual(verdict.tolerated.map(row => row.id), ['known.test.ts']);
  assert.deepEqual(verdict.recovered.map(row => row.id), ['fixed.test.ts']);
  assert.equal(judge([{ id: 'fine.test.ts', status: 'passed', skipped: 0 }], lists).status, 'passed');
  assert.equal(judge([{ id: 'fine.test.ts', status: 'passed', skipped: 0 }], lists, ['misconfigured']).status, 'failed');
});

test('end to end: a failing test and an unexpected skip block; listing them unblocks; report mode never blocks', () => {
  const root = fixture(baseExclusions), out = join(root, 'out');
  try {
    const blocked = gate('run', '--root', root, '--exclusions', join(root, 'exclusions.json'), '--group', 'api', '--out', out, '--name', 'api');
    assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
    const summary = summaryOf(out, 'api');
    assert.equal(summary.status, 'failed');
    assert.deepEqual(summary.counts, { selected: 3, passed: 1, blocking: 2, tolerated: 0, notInCi: 1 });
    assert.deepEqual(summary.suggestion, { knownFailing: ['apps/api/src/fails.test.ts'], allowSkip: ['apps/api/src/skips.test.ts'] });
    assert.ok(existsSync(join(out, 'logs', 'apps__api__src__fails.test.ts.log')), 'the full output of a failing file is kept');

    assert.equal(gate('run', '--root', root, '--exclusions', join(root, 'exclusions.json'), '--group', 'api', '--out', out, '--name', 'api', '--report').status, 0);

    write(root, 'exclusions.json', JSON.stringify({ ...baseExclusions, knownFailing: [{ pattern: 'apps/api/src/fails.test.ts', reason: 'tracked in an issue' }], allowSkip: [{ pattern: 'apps/api/src/skips.test.ts', reason: 'needs a database' }] }));
    const passed = gate('run', '--root', root, '--exclusions', join(root, 'exclusions.json'), '--group', 'api', '--out', out, '--name', 'api');
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.deepEqual(summaryOf(out, 'api').counts, { selected: 3, passed: 2, blocking: 0, tolerated: 1, notInCi: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('end to end: misconfiguration blocks instead of passing silently', () => {
  const root = fixture({ ...baseExclusions, allowSkip: [{ pattern: 'apps/api/src/deleted-long-ago.test.ts', reason: 'stale' }, { pattern: 'apps/api/src/skips.test.ts', reason: 'ok' }], knownFailing: [{ pattern: 'apps/api/src/fails.test.ts', reason: 'ok' }] });
  const out = join(root, 'out');
  try {
    const stale = gate('run', '--root', root, '--exclusions', join(root, 'exclusions.json'), '--group', 'api', '--out', out, '--name', 'api');
    assert.equal(stale.status, 1);
    assert.match(summaryOf(out, 'api').problems.join('\n'), /deleted-long-ago/);
    const empty = gate('run', '--root', root, '--exclusions', join(root, 'exclusions.json'), '--group', 'worker', '--out', out, '--name', 'worker');
    assert.equal(empty.status, 1, 'a group with no test files is a problem, not a pass');
    rmSync(join(root, 'apps/api/dist/passes.test.js'));
    write(root, 'exclusions.json', JSON.stringify({ ...baseExclusions, knownFailing: [{ pattern: 'apps/api/src/fails.test.ts', reason: 'ok' }], allowSkip: [{ pattern: 'apps/api/src/skips.test.ts', reason: 'ok' }] }));
    const unbuilt = gate('run', '--root', root, '--exclusions', join(root, 'exclusions.json'), '--group', 'api', '--out', out, '--name', 'api');
    assert.equal(unbuilt.status, 1);
    assert.match(summaryOf(out, 'api').blocking[0].why, /找不到编译产物/);
    assert.equal(gate('run', '--root', root, '--group', 'nope').status, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('end to end: shards split the files without overlap or loss, and a hung test is stopped', () => {
  const root = fixture(baseExclusions);
  try {
    const list = shard => gate('run', '--root', root, '--exclusions', join(root, 'exclusions.json'), '--group', 'api', '--shard', shard, '--list').stdout.split('\n').filter(line => line.startsWith('apps/'));
    const [first, second] = [list('1/2'), list('2/2')];
    assert.deepEqual([...first, ...second].sort(), ['apps/api/src/fails.test.ts', 'apps/api/src/passes.test.ts', 'apps/api/src/skips.test.ts']);
    assert.equal(new Set([...first, ...second]).size, 3);
    write(root, 'apps/api/src/hangs.test.ts', '');
    write(root, 'apps/api/dist/hangs.test.js', "import test from 'node:test';\ntest('never ends', () => new Promise(() => { setInterval(() => {}, 1000); }));\n");
    const out = join(root, 'out');
    const started = Date.now();
    gate('run', '--root', root, '--exclusions', join(root, 'exclusions.json'), '--group', 'api', '--out', out, '--name', 'api', '--file-timeout-minutes', '0.05');
    const hung = summaryOf(out, 'api').blocking.find(row => row.id.endsWith('hangs.test.ts'));
    assert.equal(hung.why, '超时');
    assert.ok(Date.now() - started < 60_000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('merge: every shard must report and pass; the suggested exclusion list is ready to adopt', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pr-gate-merge-'));
  const shard = (job, status, suggestion = { knownFailing: [], allowSkip: [] }, expectedJobs = 2) => write(directory, `${job}/summary-${job}.json`, JSON.stringify({ schema: 'pr-gate-summary-v1', job, status, expectedJobs, commit: 'a'.repeat(40),
    counts: { selected: 2, passed: status === 'passed' ? 2 : 1, blocking: status === 'passed' ? 0 : 1, tolerated: 0, notInCi: 0 }, problems: [], recovered: [], suggestion }));
  const merge = (...args) => gate('merge', directory, '--exclusions', join(directory, 'exclusions.json'), ...args);
  try {
    write(directory, 'exclusions.json', JSON.stringify(baseExclusions));
    shard('api-1', 'passed'); shard('api-2', 'passed');
    assert.equal(merge('--expect', '2').status, 0);
    assert.equal(merge().status, 0, 'the expected count is taken from the shards themselves');
    assert.equal(merge('--expect', '3').status, 1, 'a shard that never reported must fail the gate');
    shard('api-2', 'passed', undefined, 3);
    assert.equal(merge().status, 1, 'shards that disagree about the total cannot prove completeness');
    rmSync(join(directory, 'api-2'), { recursive: true });
    assert.equal(merge().status, 1, 'one of two shards is missing');
    assert.equal(gate('merge', join(directory, 'never-created')).status, 1, 'no results at all is a failure, not a pass');
    shard('api-2', 'passed');
    shard('api-2', 'failed', { knownFailing: ['apps/api/src/fails.test.ts'], allowSkip: ['apps/api/src/skips.test.ts'] });
    assert.equal(merge('--expect', '2').status, 1);
    assert.equal(merge('--expect', '2', '--report').status, 0);
    const fresh = join(directory, 'not', 'yet', 'created');
    assert.equal(merge('--expect', '2', '--out', fresh).status, 1, 'a new output directory is created, and the verdict is still a failure');
    assert.equal(JSON.parse(readFileSync(join(fresh, 'pr-gate-result.json'), 'utf8')).status, 'failed');
    const proposed = JSON.parse(readFileSync(join(fresh, 'exclusions.suggested.json'), 'utf8'));
    assert.deepEqual(proposed.notInCi, baseExclusions.notInCi, 'existing entries are kept');
    assert.deepEqual(proposed.knownFailing.map(entry => entry.pattern), ['apps/api/src/fails.test.ts']);
    assert.deepEqual(proposed.allowSkip.map(entry => entry.pattern), ['apps/api/src/skips.test.ts']);
    assert.doesNotThrow(() => parseExclusions(proposed), 'the suggestion is itself a valid exclusion list');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
