import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createBrowserDispatch, HISTORICAL_COLLECTORS, mergeBrowserReports, verifyBrowserDispatch, verifyBrowserReports } from './browser-dispatch.mjs';
import { evaluatePlaywright, GROUPS, judge, parseExclusions } from './run.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const prefix = 'apps/web/tests/';
const history = prefix + 'consistency-history-baseline.spec.ts';
const update = prefix + 'consistency-update-history-baseline.spec.ts';
const item = name => ({ id: name.startsWith(prefix) ? name : prefix + name, run: name.startsWith(prefix) ? name : prefix + name });
const current = item('project-execution.spec.ts');
const clone = value => structuredClone(value);

// Shape taken from the gate's Playwright 1.63 JSON reporter: test objects have
// project identity, while the enclosing spec carries the unique id and file.
function reportFor(group, status = 'expected') {
  const count = group.items.length;
  return {
    config: {
      argv: ['/usr/local/bin/node', '/workspace/node_modules/.bin/playwright', 'test',
        ...group.items.map(row => 'tests/' + row.id.slice(prefix.length)), '--reporter=line,json'],
      configFile: '/workspace/apps/web/playwright.config.ts', rootDir: '/workspace/apps/web/tests',
      version: '1.63.0', workers: 1, fullyParallel: false, maxFailures: 0,
      reporter: [['line'], ['json']], metadata: { actualWorkers: 1 },
      projects: [{ id: '', name: '', testDir: '/workspace/apps/web/tests',
        outputDir: '/tmp/bondbuddy-web-test-results', repeatEach: 1, retries: 0, timeout: 30000 }],
    },
    suites: group.items.map(row => {
      const file = row.id.slice(prefix.length);
      return { title: file, file, line: 0, column: 0, specs: [{
        id: 'spec:' + row.id, title: 'collects the original browser behavior', file, line: 8, column: 1,
        ok: status === 'expected' || status === 'skipped', tags: [],
        tests: [{ projectId: '', projectName: '', status, expectedStatus: status === 'skipped' ? 'skipped' : 'passed',
          timeout: 30000, annotations: [], results: [{
            status: status === 'unexpected' ? 'failed' : status === 'skipped' ? 'skipped' : 'passed',
            retry: 0, workerIndex: 0, parallelIndex: 0, duration: 7,
            startTime: '2026-11-13T00:00:00.000Z', errors: [], stdout: [], stderr: [], attachments: [],
          }] }],
      }] };
    }),
    errors: [],
    stats: { startTime: '2026-11-13T00:00:00.000Z', duration: 40,
      expected: status === 'expected' ? count : 0, unexpected: status === 'unexpected' ? count : 0,
      flaky: status === 'flaky' ? count : 0, skipped: status === 'skipped' ? count : 0 },
  };
}
function threeGroups() {
  const items = [current, item(history), item(update)];
  const dispatch = createBrowserDispatch(items);
  return { items, dispatch, reports: dispatch.map(group => ({ id: group.id, report: reportFor(group) })) };
}
const firstSpec = entry => entry.report.suites[0].specs[0];
const firstTest = entry => firstSpec(entry).tests[0];

test('the repository browser discovery retains every selected file, including the two original collectors', () => {
  const items = GROUPS.browser.discover(root);
  assert.ok(items.length > 2);
  assert.equal(items.filter(row => row.id === history).length, 1);
  assert.equal(items.filter(row => row.id === update).length, 1);
  const dispatch = createBrowserDispatch(items);
  assert.deepEqual(dispatch.map(group => group.id), ['current', 'history', 'update']);
  assert.deepEqual(dispatch[1], { id: 'history', origin: 'https://127.0.0.1:5181',
    flag: 'BB_CONSISTENCY_HISTORY_BASELINE', items: [item(history)] });
  assert.deepEqual(dispatch[2], { id: 'update', origin: 'https://127.0.0.1:5182',
    flag: 'BB_UPDATE_HISTORY_BASELINE', items: [item(update)] });
  assert.deepEqual(dispatch[0].items, items.filter(row => ![history, update].includes(row.id)));
  assert.equal(dispatch.flatMap(group => group.items).length, items.length);
  assert.deepEqual(dispatch.flatMap(group => group.items.map(row => row.id)).sort(), items.map(row => row.id).sort());
  assert.equal(verifyBrowserDispatch(dispatch, items), dispatch);
  assert.deepEqual(HISTORICAL_COLLECTORS, {
    history: { test_id: history, flag: 'BB_CONSISTENCY_HISTORY_BASELINE', origin: 'https://127.0.0.1:5181' },
    update: { test_id: update, flag: 'BB_UPDATE_HISTORY_BASELINE', origin: 'https://127.0.0.1:5182' },
  });
});

test('partitioning is stable for unsorted shards and does not infer a historical app from similar names', () => {
  const items = [item(update), item('qa-single-start-baseline.spec.ts'), item(history),
    item('consistency-history.spec.ts'), item('consistency-update-history.spec.ts'), current];
  const before = clone(items), dispatch = createBrowserDispatch(items);
  assert.deepEqual(dispatch[0].items.map(row => row.id), [
    prefix + 'qa-single-start-baseline.spec.ts', prefix + 'consistency-history.spec.ts',
    prefix + 'consistency-update-history.spec.ts', current.id,
  ]);
  assert.equal(dispatch[1].items[0], items[2]);
  assert.equal(dispatch[2].items[0], items[0]);
  assert.deepEqual(items, before);
  assert.deepEqual(createBrowserDispatch([item(update)]).map(group => group.id), ['update']);
  assert.deepEqual(createBrowserDispatch([current]).map(group => group.id), ['current']);
  assert.deepEqual(createBrowserDispatch([]), []);
});

test('verification rejects omission, repetition, extra files, changed routes and order', () => {
  const items = [current, item('account-live.spec.ts'), item(history), item(update)];
  const good = createBrowserDispatch(items);
  const corruptions = [
    dispatch => dispatch[0].items.pop(),
    dispatch => dispatch[0].items.push(clone(dispatch[0].items[0])),
    dispatch => dispatch[0].items.push(item('unexpected.spec.ts')),
    dispatch => dispatch[0].items.reverse(),
    dispatch => dispatch.reverse(),
    dispatch => { dispatch[1].items = [current]; },
    dispatch => { dispatch[1].origin = 'https://127.0.0.1:5173'; },
    dispatch => { dispatch[1].flag = 'BB_UPDATE_HISTORY_BASELINE'; },
    dispatch => { dispatch[0].flag = 'BB_CONSISTENCY_HISTORY_BASELINE'; },
    dispatch => { dispatch[2].id = 'history'; },
    dispatch => { dispatch[2].items = []; },
  ];
  for (const corrupt of corruptions) {
    const dispatch = clone(good); corrupt(dispatch);
    assert.throws(() => verifyBrowserDispatch(dispatch, items), /original shard/);
  }
  assert.throws(() => createBrowserDispatch([current, clone(current)]), /Duplicate browser test id/);
  for (const id of ['project-execution.spec.ts', prefix + '../escape.spec.ts', prefix + 'nested/file.spec.ts',
    'apps/web/tests\\file.spec.ts', prefix + 'bad\nfile.spec.ts']) {
    assert.throws(() => createBrowserDispatch([{ id }]), /Invalid browser test id/);
  }
});

test('merging keeps original failure, flaky, skip, retry, attachment and global-error evidence for the original judge', () => {
  const items = [current, item('account-live.spec.ts'), item(history), item(update)];
  const dispatch = createBrowserDispatch(items);
  const reports = dispatch.map(group => ({ id: group.id, report: reportFor(group) }));
  const main = reports[0].report, mainSpec = firstSpec(reports[0]);
  mainSpec.ok = false;
  mainSpec.tests[0].status = 'unexpected';
  mainSpec.tests[0].results[0] = { ...mainSpec.tests[0].results[0], status: 'failed',
    errors: [{ message: 'real assertion failed', stack: 'original assertion stack' }],
    attachments: [{ name: 'failure', contentType: 'image/png', path: '/evidence/failure.png' }],
    stdout: [{ text: 'before the failure\n' }], stderr: [{ text: 'diagnostic\n' }] };
  main.stats = { ...main.stats, expected: 1, unexpected: 1, duration: 30 };
  const flaky = firstTest(reports[1]);
  flaky.status = 'flaky';
  flaky.results.unshift({ ...clone(flaky.results[0]), status: 'failed', errors: [{ message: 'first attempt failed' }] });
  flaky.results[1].retry = 1;
  reports[1].report.stats = { ...reports[1].report.stats, expected: 0, flaky: 1,
    startTime: '2026-11-12T23:59:59.000Z', duration: 40 };
  reports[2].report = reportFor(dispatch[2], 'skipped');
  reports[2].report.stats.duration = 50;
  reports[2].report.errors.push({ message: 'afterAll global error', stack: 'unmodified error stack' });
  // Exercise an actual describe suite rather than only flat fixture cases.
  const nested = reports[1].report.suites[0];
  nested.suites = [{ title: 'history collection', file: nested.file, line: 7, column: 1, specs: nested.specs }];
  nested.specs = [];
  const original = JSON.stringify(reports);
  const merged = mergeBrowserReports(reports, dispatch);
  assert.equal(JSON.stringify(reports), original, 'merging does not mutate source reports');
  assert.deepEqual(merged.suites, reports.flatMap(entry => entry.report.suites));
  assert.deepEqual(merged.errors, [{ message: 'afterAll global error', stack: 'unmodified error stack' }]);
  assert.deepEqual(merged.stats, { startTime: '2026-11-12T23:59:59.000Z', duration: 120,
    expected: 1, unexpected: 1, flaky: 1, skipped: 1 });
  assert.deepEqual(merged.config.argv, [], 'a multi-process merge must not claim one original argv ran every file');
  const metadata = merged.config.pr_gate_dispatch;
  assert.equal(metadata.schema, 'pr-gate-browser-dispatch-v1');
  assert.equal(metadata.report_hash_encoding, 'JSON.stringify/utf8');
  for (let index = 0; index < reports.length; index++) {
    assert.deepEqual(metadata.reports[index], { id: dispatch[index].id, origin: dispatch[index].origin,
      flag: dispatch[index].flag, files: dispatch[index].items.map(row => row.id), attachment_paths: index === 0 ? ['/evidence/failure.png'] : [],
      report_sha256: createHash('sha256').update(JSON.stringify(reports[index].report)).digest('hex'),
      argv: reports[index].report.config.argv, stats: reports[index].report.stats });
  }
  const evaluated = evaluatePlaywright(merged, items, { code: 1 });
  assert.deepEqual(evaluated.results.map(row => [row.id, row.status, row.tests, row.skipped]), [
    [current.id, 'failed', 1, 0], [prefix + 'account-live.spec.ts', 'passed', 1, 0],
    [history, 'failed', 1, 0], [update, 'passed', 1, 1],
  ]);
  assert.match(evaluated.results[0].reason, /失败 1 项/);
  assert.match(evaluated.results[2].reason, /不稳定 1 项/);
  const verdict = judge(evaluated.results, parseExclusions({}), evaluated.problems);
  assert.deepEqual(verdict.blocking.map(row => [row.id, row.kind]), [
    [current.id, 'failed'], [history, 'failed'], [update, 'skipped'],
  ]);
  assert.equal(verdict.status, 'failed');
});

test('expected failures retain Playwright semantics, while global errors and nonzero exits still block', () => {
  const dispatch = createBrowserDispatch([current]);
  const report = reportFor(dispatch[0]);
  const spec = report.suites[0].specs[0];
  spec.tests[0].expectedStatus = 'failed';
  spec.tests[0].results[0].status = 'failed';
  spec.tests[0].results[0].errors = [{ message: 'expected failing behavior' }];
  const reports = [{ id: 'current', report }];
  const merged = mergeBrowserReports(reports, dispatch);
  assert.equal(evaluatePlaywright(merged, [current]).results[0].status, 'passed');
  assert.deepEqual(merged.suites[0].specs[0], spec);
  assert.equal(evaluatePlaywright(merged, [current], { code: 1 }).problems.length, 1);
  report.errors.push({ message: 'worker crashed after reporting its tests' });
  assert.equal(evaluatePlaywright(mergeBrowserReports(reports, dispatch), [current]).problems.length, 1);
});

test('empty file suites remain zero tests and fail in the original evaluator', () => {
  const dispatch = createBrowserDispatch([current]), report = reportFor(dispatch[0]);
  report.suites[0].specs = [];
  report.stats.expected = 0;
  report.errors = [{ message: 'file failed to load' }];
  const reports = [{ id: 'current', report }];
  assert.equal(verifyBrowserReports(reports, dispatch), reports);
  const merged = mergeBrowserReports(reports, dispatch);
  assert.deepEqual(merged.suites[0].specs, []);
  const evaluated = evaluatePlaywright(merged, [current], { code: 1 });
  assert.equal(evaluated.results[0].tests, 0);
  assert.equal(evaluated.results[0].status, 'failed');
  assert.match(evaluated.results[0].reason, /文件加载出错/);
});

test('a spec without cases also remains empty instead of receiving an invented pass', () => {
  const dispatch = createBrowserDispatch([current]), report = reportFor(dispatch[0]);
  report.suites[0].specs[0].tests = [];
  report.stats.expected = 0;
  const merged = mergeBrowserReports([{ id: 'current', report }], dispatch);
  assert.equal(evaluatePlaywright(merged, [current]).results[0].status, 'failed');
  assert.deepEqual(merged.suites[0].specs[0].tests, []);
});

test('missing suites throw without mutating available failure evidence for the runner fallback', () => {
  const { dispatch, reports, items } = threeGroups();
  reports[0].report = reportFor(dispatch[0], 'unexpected');
  reports[1].report.suites = [];
  reports[1].report.stats.expected = 0;
  const original = clone(reports);
  assert.throws(() => mergeBrowserReports(reports, dispatch), /missing dispatched file suites/);
  assert.deepEqual(reports, original);
  assert.equal(evaluatePlaywright(reports[0].report, [items[0]], { code: 1 }).results[0].status, 'failed');
  assert.equal(evaluatePlaywright(reports[1].report, [items[1]], { code: 1 }).results[0].status, 'failed');
});

test('missing, extra, duplicate, reordered and absent reports are rejected', () => {
  const { dispatch, reports } = threeGroups();
  assert.throws(() => verifyBrowserReports(reports.slice(1), dispatch), /report count/);
  assert.throws(() => verifyBrowserReports([...reports, reports[0]], dispatch), /report count/);
  assert.throws(() => verifyBrowserReports([reports[0], reports[0], reports[2]], dispatch), /dispatch order/);
  assert.throws(() => verifyBrowserReports([...reports].reverse(), dispatch), /dispatch order/);
  assert.throws(() => verifyBrowserReports([{ id: 'current', report: null }, ...reports.slice(1)], dispatch), /Browser report/);
  assert.throws(() => mergeBrowserReports([], []), /empty browser dispatch/);
});

test('rootDir, project roots, command files and inter-group configuration must match the controlled run', () => {
  const corruptions = [
    [entry => { entry.report.config.rootDir = '/somewhere/else/tests'; }, /rootDir/],
    [entry => { entry.report.config.configFile = '/workspace/other.config.ts'; }, /configFile/],
    [entry => { entry.report.config.projects[0].testDir = '/workspace/other/tests'; }, /testDir/],
    [entry => { entry.report.config.argv[3] = 'tests/extra.spec.ts'; }, /argv/],
    [entry => { entry.report.config.argv.splice(3, 0, '--grep=only-one-case'); }, /argv/],
    [entry => { entry.report.config.argv[2] = 'test-subset'; }, /Playwright command/],
    [entry => { entry.report.config.pr_gate_dispatch = {}; }, /already merged/],
    [entry => { entry.report.config.projects = []; }, /no projects/],
    [entry => { entry.report.config.projects.push(clone(entry.report.config.projects[0])); }, /Duplicate project/],
  ];
  for (const [corrupt, message] of corruptions) {
    const { dispatch, reports } = threeGroups(); corrupt(reports[0]);
    assert.throws(() => verifyBrowserReports(reports, dispatch), message);
  }
  const { dispatch, reports } = threeGroups();
  reports[1].report.config.projects[0].retries = 4;
  assert.throws(() => verifyBrowserReports(reports, dispatch), /configuration changed/);
});

test('file ownership is exact even when a foreign path has the expected basename', () => {
  for (const bad of ['/workspace/apps/web/tests/project-execution.spec.ts', '../project-execution.spec.ts',
    'nested/project-execution.spec.ts', 'apps/web/tests/project-execution.spec.ts', 'project-execution.spec.ts\\']) {
    const { dispatch, reports } = threeGroups();
    reports[0].report.suites[0].file = bad;
    assert.throws(() => verifyBrowserReports(reports, dispatch), /outside its dispatched group/);
  }
  const { dispatch, reports } = threeGroups();
  reports[0].report.suites[0].file = 'consistency-history-baseline.spec.ts';
  assert.throws(() => verifyBrowserReports(reports, dispatch), /outside its dispatched group/);
  reports[0].report = reportFor(dispatch[0]);
  firstSpec(reports[0]).file = 'consistency-history-baseline.spec.ts';
  assert.throws(() => verifyBrowserReports(reports, dispatch), /Spec file differs/);
});

test('nested suites cannot switch to another dispatched file, but may inherit their owner', () => {
  const dispatch = createBrowserDispatch([current, item('account-live.spec.ts')]);
  const report = reportFor(dispatch[0]), outer = report.suites[0];
  outer.suites = [{ title: 'nested', specs: outer.specs }];
  outer.specs = [];
  const reports = [{ id: 'current', report }];
  assert.doesNotThrow(() => verifyBrowserReports(reports, dispatch));
  outer.suites[0].file = 'account-live.spec.ts';
  assert.throws(() => verifyBrowserReports(reports, dispatch), /changed file ownership/);
});

test('duplicate root files, spec ids, source identities and project test identities cannot inflate coverage', () => {
  const corruptions = [
    [reports => reports[0].report.suites.push(clone(reports[0].report.suites[0])), /Duplicate root suite/],
    [reports => { firstSpec(reports[1]).id = firstSpec(reports[0]).id; }, /duplicate spec id/],
    [reports => {
      const duplicate = clone(firstSpec(reports[0])); duplicate.id = 'changed-id';
      reports[0].report.suites[0].specs.push(duplicate);
    }, /Duplicate spec source identity/],
    [reports => firstSpec(reports[0]).tests.push(clone(firstTest(reports[0]))), /Duplicate test project identity/],
  ];
  for (const [corrupt, message] of corruptions) {
    const { dispatch, reports } = threeGroups(); corrupt(reports);
    assert.throws(() => verifyBrowserReports(reports, dispatch), message);
  }
});

test('unknown project identities, statuses and inconsistent counts are rejected', () => {
  const corruptions = [
    [entry => { firstTest(entry).projectId = 'other'; }, /unknown project/],
    [entry => { firstTest(entry).projectName = 'other'; }, /project identity mismatch/],
    [entry => { firstTest(entry).status = 'success'; }, /Unknown test status/],
    [entry => { firstTest(entry).results[0].status = 'success'; }, /Unknown test result status/],
    [entry => { entry.report.stats.expected = 0; }, /stats disagree/],
    [entry => { entry.report.stats.unexpected = -1; }, /Invalid report stats/],
    [entry => { delete entry.report.stats.flaky; }, /Invalid report stats/],
    [entry => { entry.report.stats.duration = NaN; }, /duration/],
    [entry => { entry.report.stats.startTime = 'not a date'; }, /startTime/],
    [entry => { firstSpec(entry).id = ''; }, /Missing or duplicate spec id/],
    [entry => { firstSpec(entry).line = -1; }, /spec line/],
    [entry => { delete firstSpec(entry).tests; }, /Spec tests/],
    [entry => { delete entry.report.errors; }, /Report errors/],
  ];
  for (const [corrupt, message] of corruptions) {
    const { dispatch, reports } = threeGroups(); corrupt(reports[0]);
    assert.throws(() => verifyBrowserReports(reports, dispatch), message);
  }
});


test('merged metadata retains each original attachment reference for archive verification', () => {
  const value = threeGroups(), path = '/tmp/bondbuddy-web-test-results/synthetic-failure/error-context.md';
  firstTest(value.reports[0]).results[0].attachments = [{ name: 'synthetic context', path }];
  const original = clone(value.reports); const merged = mergeBrowserReports(value.reports, value.dispatch);
  assert.deepEqual(value.reports, original); assert.deepEqual(merged.config.pr_gate_dispatch.reports[0].attachment_paths, [path]);
  assert.deepEqual(merged.config.pr_gate_dispatch.reports[1].attachment_paths, []);
});
