import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { browserAttachments } from './browser-artifacts.mjs';

const TEST_PREFIX = 'apps/web/tests/';
const REPORT_ROOT = '/workspace/apps/web/tests';
const STATUS_KEYS = ['expected', 'unexpected', 'flaky', 'skipped'];
const RESULT_STATUSES = new Set(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']);
export const HISTORICAL_COLLECTORS = Object.freeze({
  history: Object.freeze({ test_id: TEST_PREFIX + 'consistency-history-baseline.spec.ts',
    flag: 'BB_CONSISTENCY_HISTORY_BASELINE', origin: 'https://127.0.0.1:5181' }),
  update: Object.freeze({ test_id: TEST_PREFIX + 'consistency-update-history-baseline.spec.ts',
    flag: 'BB_UPDATE_HISTORY_BASELINE', origin: 'https://127.0.0.1:5182' }),
});
const GROUPS = Object.freeze([
  Object.freeze({ id: 'current', origin: 'https://127.0.0.1:5173', flag: null }),
  ...Object.entries(HISTORICAL_COLLECTORS).map(([id, value]) => Object.freeze({ id, origin: value.origin, flag: value.flag })),
]);
const hash = report => createHash('sha256').update(JSON.stringify(report)).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireObject = (value, label) => assert.ok(isObject(value), label + ' must be an object');
const requireArray = (value, label) => assert.ok(Array.isArray(value), label + ' must be an array');
const requireString = (value, label) => assert.equal(typeof value, 'string', label + ' must be a string');
const fileName = item => item.id.slice(TEST_PREFIX.length);
const counts = () => Object.fromEntries(STATUS_KEYS.map(key => [key, 0]));

/** Partition the original shard only; discovery, exclusions and sharding stay upstream. */
export function createBrowserDispatch(items) {
  requireArray(items, 'Browser items');
  const seen = new Set();
  for (const item of items) {
    requireObject(item, 'Browser item');
    assert.match(item.id, /^apps\/web\/tests\/[^/\\\r\n]+\.spec\.ts$/, 'Invalid browser test id');
    assert.ok(!seen.has(item.id), 'Duplicate browser test id: ' + item.id);
    seen.add(item.id);
  }
  const owner = item => Object.entries(HISTORICAL_COLLECTORS).find(([, value]) => value.test_id === item.id)?.[0] ?? 'current';
  return GROUPS.map(group => ({ ...group, items: items.filter(item => owner(item) === group.id) })).filter(group => group.items.length);
}

export function verifyBrowserDispatch(dispatch, items) {
  assert.deepEqual(dispatch, createBrowserDispatch(items), 'Browser dispatch differs from the original shard');
  return dispatch;
}

function verifyDispatchShape(dispatch) {
  requireArray(dispatch, 'Browser dispatch');
  for (const group of dispatch) {
    requireObject(group, 'Browser group');
    requireArray(group.items, 'Browser group items');
  }
  // The runner verifies against the original shard first. Here we additionally
  // reject malformed groups and duplicate ids when called as a standalone helper.
  verifyBrowserDispatch(dispatch, dispatch.flatMap(group => group.items));
}

function verifyReport(report, group, identities) {
  requireObject(report, 'Browser report for ' + group.id);
  requireObject(report.config, 'Report config');
  const config = report.config;
  assert.equal(config.rootDir, REPORT_ROOT, 'Unexpected report rootDir');
  assert.equal(config.configFile, '/workspace/apps/web/playwright.config.ts', 'Unexpected report configFile');
  assert.equal(config.pr_gate_dispatch, undefined, 'An already merged report cannot be reused');
  requireArray(config.argv, 'Report argv');
  config.argv.forEach(value => requireString(value, 'Report argv entry'));
  assert.ok(config.argv.length >= 5, 'Incomplete report argv');
  assert.equal(config.argv[2], 'test', 'Unexpected Playwright command');
  assert.deepEqual(config.argv.slice(3), [...group.items.map(item => 'tests/' + fileName(item)), '--reporter=line,json'],
    'Report argv differs from its dispatched files');
  requireArray(config.projects, 'Report projects');
  assert.ok(config.projects.length > 0, 'Report has no projects');
  const projects = new Map();
  for (const project of config.projects) {
    requireObject(project, 'Report project');
    requireString(project.id, 'Project id');
    requireString(project.name, 'Project name');
    assert.ok(!projects.has(project.id), 'Duplicate project id');
    assert.equal(project.testDir, REPORT_ROOT, 'Unexpected project testDir');
    projects.set(project.id, project.name);
  }

  requireArray(report.suites, 'Report suites');
  requireArray(report.errors, 'Report errors');
  requireObject(report.stats, 'Report stats');
  const actual = counts(), expectedFiles = new Set(group.items.map(fileName)), seenFiles = new Set();
  const visit = (suite, inheritedFile, titles) => {
    requireObject(suite, 'Report suite');
    const file = suite.file ?? inheritedFile;
    assert.ok(expectedFiles.has(file), 'Suite file is outside its dispatched group: ' + file);
    if (inheritedFile !== undefined) assert.equal(file, inheritedFile, 'Nested suite changed file ownership');
    requireString(suite.title, 'Suite title');
    requireArray(suite.specs, 'Suite specs');
    const titlePath = [...titles, suite.title];
    for (const spec of suite.specs) {
      requireObject(spec, 'Report spec');
      assert.equal(spec.file, file, 'Spec file differs from its owning suite');
      requireString(spec.id, 'Spec id');
      assert.ok(spec.id.length > 0 && !identities.ids.has(spec.id), 'Missing or duplicate spec id: ' + spec.id);
      identities.ids.add(spec.id);
      requireString(spec.title, 'Spec title');
      for (const key of ['line', 'column']) assert.ok(Number.isSafeInteger(spec[key]) && spec[key] >= 0, 'Invalid spec ' + key);
      const sourceIdentity = JSON.stringify([file, spec.line, spec.column, titlePath, spec.title]);
      assert.ok(!identities.sources.has(sourceIdentity), 'Duplicate spec source identity');
      identities.sources.add(sourceIdentity);
      requireArray(spec.tests, 'Spec tests');
      const testedProjects = new Set();
      for (const test of spec.tests) {
        requireObject(test, 'Report test');
        requireString(test.projectId, 'Test projectId');
        requireString(test.projectName, 'Test projectName');
        assert.ok(projects.has(test.projectId), 'Test uses an unknown project');
        assert.equal(test.projectName, projects.get(test.projectId), 'Test project identity mismatch');
        assert.ok(!testedProjects.has(test.projectId), 'Duplicate test project identity in spec');
        testedProjects.add(test.projectId);
        assert.ok(STATUS_KEYS.includes(test.status), 'Unknown test status: ' + test.status);
        requireArray(test.results, 'Test results');
        for (const result of test.results) {
          requireObject(result, 'Test result');
          assert.ok(RESULT_STATUSES.has(result.status), 'Unknown test result status: ' + result.status);
        }
        // Keep Playwright's expected-failure semantics. Results, retries, errors,
        // attachments and skipped cases are never rewritten to make a run pass.
        actual[test.status]++;
      }
    }
    if (suite.suites !== undefined) {
      requireArray(suite.suites, 'Nested suites');
      for (const child of suite.suites) visit(child, file, titlePath);
    }
  };
  for (const suite of report.suites) {
    requireObject(suite, 'Root suite');
    assert.ok(expectedFiles.has(suite.file), 'Root suite file is outside its dispatched group: ' + suite.file);
    assert.ok(!seenFiles.has(suite.file), 'Duplicate root suite for file: ' + suite.file);
    seenFiles.add(suite.file);
    visit(suite, undefined, []);
  }
  assert.deepEqual([...seenFiles].sort(), [...expectedFiles].sort(), 'Report is missing dispatched file suites');
  for (const key of STATUS_KEYS) {
    assert.ok(Number.isSafeInteger(report.stats[key]) && report.stats[key] >= 0, 'Invalid report stats.' + key);
    assert.equal(report.stats[key], actual[key], 'Report stats disagree with test outcomes: ' + key);
  }
  requireString(report.stats.startTime, 'Report startTime');
  assert.ok(Number.isFinite(Date.parse(report.stats.startTime)), 'Invalid report startTime');
  assert.ok(Number.isFinite(report.stats.duration) && report.stats.duration >= 0, 'Invalid report duration');
  // Empty file suites remain empty. evaluatePlaywright must still reject them;
  // no placeholder test or fabricated pass is added to satisfy coverage.
}

/** reports are [{ id, report }] in dispatch order; report is parsed Playwright JSON. */
export function verifyBrowserReports(reports, dispatch) {
  verifyDispatchShape(dispatch);
  requireArray(reports, 'Browser reports');
  assert.equal(reports.length, dispatch.length, 'Browser report count differs from dispatch');
  const identities = { ids: new Set(), sources: new Set() };
  let commonConfig;
  reports.forEach((entry, index) => {
    requireObject(entry, 'Browser report wrapper');
    const group = dispatch[index];
    assert.equal(entry.id, group.id, 'Browser reports are missing, repeated or out of dispatch order');
    verifyReport(entry.report, group, identities);
    const { argv, ...config } = entry.report.config;
    if (index === 0) commonConfig = config;
    else assert.deepEqual(config, commonConfig, 'Browser report configuration changed between groups');
  });
  return reports;
}

/** Preserve native suites/errors and outcome counters for the existing gate judge. */
export function mergeBrowserReports(reports, dispatch) {
  verifyBrowserReports(reports, dispatch);
  assert.ok(reports.length > 0, 'Cannot merge an empty browser dispatch');
  const copies = structuredClone(reports), stats = { ...copies[0].report.stats, ...counts(), duration: 0 };
  for (const { report } of copies) {
    if (Date.parse(report.stats.startTime) < Date.parse(stats.startTime)) stats.startTime = report.stats.startTime;
    stats.duration += report.stats.duration;
    for (const key of STATUS_KEYS) stats[key] += report.stats[key];
  }
  assert.ok(Number.isFinite(stats.duration), 'Combined report duration overflow');
  for (const key of STATUS_KEYS) assert.ok(Number.isSafeInteger(stats[key]), 'Combined report count overflow');
  const config = { ...copies[0].report.config, argv: [], pr_gate_dispatch: {
    schema: 'pr-gate-browser-dispatch-v1',
    report_hash_encoding: 'JSON.stringify/utf8',
    reports: copies.map(({ id, report }, index) => ({ id, origin: dispatch[index].origin, flag: dispatch[index].flag,
      files: dispatch[index].items.map(item => item.id), attachment_paths: browserAttachments(report), report_sha256: hash(report), argv: report.config.argv, stats: report.stats })),
  } };
  return { ...copies[0].report, config, suites: copies.flatMap(entry => entry.report.suites),
    errors: copies.flatMap(entry => entry.report.errors), stats };
}
