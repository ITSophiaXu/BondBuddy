import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BROWSER_API_PROFILES, BROWSER_DATABASE, BROWSER_ORIGIN, BROWSER_PROTOTYPE_ORIGIN, browserEnvironment, browserHash, createBrowserPlan, verifyBrowserPlan } from './browser-profiles.mjs';
import { browserFilesForShard, verifyBrowserDatabaseContainer } from './browser-host.mjs';
import { browserInvocation, createBrowserStartupBarrier } from './browser-runtime.mjs';
import { lddLibraryPaths, lddPaths } from './browser-tools.mjs';
import { verifyBrowserRuns } from './browser-receipt.mjs';
import { syntheticBrowserSources, syntheticBrowserShard } from './browser.test-fixture.mjs';
import { GROUPS, parseExclusions } from './run.mjs';
import { QA_BASELINE_TEST } from './browser-reference-source.mjs';
import { fixtureHistoricalExpected, syntheticHistoricalRuns } from './browser-historical.test-fixture.mjs';
import { syntheticReferenceRuns } from './browser-reference.test-fixture.mjs';

const candidate = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), browser_source_sha256: syntheticBrowserSources() };
const runId = 'synthetic-browser-1234';
const options = { candidate, runId, shard: 'browser-1', files: Object.keys(candidate.browser_source_sha256), sourceBlob: path => Buffer.from(path) };
const disabled = { BB_TEST_LIVE_AUTHORING: '0', BB_PLATFORM_PROBE_ENABLED: '0', BB_REVIEW_WEB_SEARCH_ENABLED: '0' };

test('stop waits for an in-flight startup handle and blocks any later service acquisition', async () => {
  const barrier = createBrowserStartupBarrier(), events = []; let acquire;
  const pending = new Promise(done => { acquire = done; });
  const startup = (async () => { barrier.requireStarting(); await pending; events.push('handle acquired');
    try { barrier.requireStarting(); events.push('next service started'); } finally { barrier.finish(); } })();
  const failed = assert.rejects(startup, /stopped during preparation/);
  barrier.requestStop(); const cleanup = (async () => { await barrier.wait(); events.push('handle drained'); })();
  await Promise.resolve(); assert.deepEqual(events, []);
  acquire(); await failed; await cleanup; assert.deepEqual(events, ['handle acquired', 'handle drained']);
  assert.throws(() => barrier.requireStarting());
});

test('all ten actual local API profiles retain their strict original loopback prerequisites', () => {
  assert.equal(Object.keys(BROWSER_API_PROFILES).length, 10);
  const plan = createBrowserPlan(options); assert.equal(plan.environment.BB_TEST_DATABASE_URL, BROWSER_DATABASE); assert.equal(plan.environment.BB_E2E_BASE_URL, BROWSER_ORIGIN);
  assert.equal(plan.environment.BB_E2E_EXECUTION_STAGING, '1'); assert.equal(plan.environment.BB_E2E_OCR, '1'); assert.equal(plan.environment.BB_E2E_PARSE, '1');
  assert.deepEqual(plan.needs, { api: true, prototype: true, parser: true, ocr: true });
  assert.equal(plan.environment.BB_PROTOTYPE_URL, BROWSER_PROTOTYPE_ORIGIN);
  assert.equal(plan.environment.BB_E2E_PROTOTYPE_URL, BROWSER_PROTOTYPE_ORIGIN);
  assert.equal(plan.environment.BB_WORKSPACE_DESIGN, '1');
  assert.equal(plan.environment.BB_WORKSPACE_SCENES_DIR, '/evidence/shards/browser-1/browser/review-workspace/bb_workspace_scenes_dir');
  for (const row of plan.files) assert.equal(row.source_sha256, browserHash(row.test_id));
  assert.deepEqual(verifyBrowserPlan(plan, options), plan);
});

test('plan refuses candidate/run/shard/source changes, dropped files and reordered complete batches', () => {
  const plan = createBrowserPlan(options);
  for (const mutate of [p => p.files.pop(), p => p.files.reverse(), p => p.files[0].source_sha256 = 'd'.repeat(64), p => p.run_id = 'old-run-1234',
    p => p.commit = 'd'.repeat(40), p => p.tree = 'd'.repeat(40), p => p.shard = 'browser-2', p => p.environment.BB_TEST_DATABASE_URL = 'postgresql://production/customer',
    p => p.environment.BB_E2E_REAL_API = '0', p => p.environment.BB_ELEVENTH_REFERENCE = '1']) {
    const altered = structuredClone(plan); mutate(altered); assert.throws(() => verifyBrowserPlan(altered, options));
  }
  assert.throws(() => createBrowserPlan({ ...options, files: [...options.files, options.files[0]] }));
});

test('browser env removes truthy reference/baseline switches and credentials before enabling exact profiles', () => {
  const plan = createBrowserPlan({ ...options, files: ['apps/web/tests/ux-review-comparison.spec.ts'] });
  const inherited = { ...disabled, PATH: '/usr/local/bin:/usr/bin:/bin', BB_ELEVENTH_REFERENCE: '0', BB_MATERIAL_REFERENCE_BASELINE: '1',
    BB_E2E_BASE_URL: 'https://production.example', QA_PRICE_EVIDENCE: '/old', BB_QA_RECOVERY_CAPTURE: '/old', BB_WORKSPACE_DESIGN: '1',
    DEEPSEEK_API_KEY: 'synthetic-secret', DATABASE_URL: 'postgresql://production', NODE_OPTIONS: '--import=old.mjs', NODE_TEST_CONTEXT: 'child-v8' };
  const { env, removed } = browserEnvironment(inherited, plan);
  for (const key of ['BB_ELEVENTH_REFERENCE', 'BB_MATERIAL_REFERENCE_BASELINE', 'QA_PRICE_EVIDENCE', 'BB_QA_RECOVERY_CAPTURE', 'BB_WORKSPACE_DESIGN', 'DEEPSEEK_API_KEY', 'DATABASE_URL', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT']) { assert.equal(env[key], undefined); assert.ok(removed.includes(key)); }
  assert.equal(env.BB_UX_COMPARE, '/evidence/shards/browser-1/browser/ux-review-comparison/bb_ux_compare');
  assert.notEqual(env.BB_UX_COMPARE, '1'); assert.equal(env.BB_E2E_REAL_API, undefined); assert.equal(inherited.BB_ELEVENTH_REFERENCE, '0');
  assert.throws(() => browserEnvironment({ ...disabled, BB_TEST_LIVE_AUTHORING: '1' }, plan));
  assert.throws(() => browserEnvironment({ ...disabled, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, plan));
});
test('the QA plan names its private application while the shared runtime clears its inherited opt-in', () => {
  const plan = createBrowserPlan({ ...options, files: [QA_BASELINE_TEST] });
  assert.equal(plan.environment.BB_QA_SINGLE_START_BASELINE, undefined); assert.deepEqual(plan.historical_apps, ['qa']);
  assert.equal(plan.environment.BB_UX_EVIDENCE_DIR, '/evidence/shards/browser-1/browser/shared');
  const inherited = { ...disabled, PATH: '/usr/bin', BB_QA_SINGLE_START_BASELINE: '0' };
  const result = browserEnvironment(inherited, plan); assert.equal(result.env.BB_QA_SINGLE_START_BASELINE, undefined);
  assert.ok(result.removed.includes('BB_QA_SINGLE_START_BASELINE'));
  const unrelated = createBrowserPlan({ ...options, files: ['apps/web/tests/account.spec.ts'] });
  assert.equal(browserEnvironment(inherited, unrelated).env.BB_QA_SINGLE_START_BASELINE, undefined);
  const missing = structuredClone(plan); missing.historical_apps = [];
  assert.throws(() => verifyBrowserPlan(missing, { ...options, files: [QA_BASELINE_TEST] }));
});

test('host and original discovery assign the same entire source file table to every browser shard', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const exclusions = parseExclusions(JSON.parse(readFileSync(new URL('./exclusions.json', import.meta.url))));
  const active = GROUPS.browser.discover(root).filter(item => !exclusions.notInCi.some(entry => entry.expression.test(item.id))).map(item => item.id);
  const expected = { browser_source_sha256: Object.fromEntries(active.map(file => [file, browserHash(readFileSync(new URL('../../' + file, import.meta.url)))])) };
  const found = [];
  for (let index = 1; index <= 3; index++) {
    const files = browserFilesForShard(expected, { groups: 'browser', shard: `${index}/3` }); found.push(...files);
    assert.deepEqual(files, active.filter((_, offset) => offset % 3 === index - 1));
    assert.deepEqual(browserInvocation(files.map(id => ({ id })), '/evidence/report.json', {}).args,
      ['playwright', 'test', ...files.map(file => 'tests/' + file.split('/').at(-1)), '--reporter=line,json']);
  }
  assert.deepEqual(found.sort(), active); assert.equal(new Set(found).size, active.length);
});

test('Tesseract ELF closure rejects unresolved or unrecognized dependency output', () => {
  assert.deepEqual(lddPaths(' linux-vdso.so.1 (0xabc)\n libfoo.so.1 => /lib/x86_64-linux-gnu/libfoo.so.1 (0xabc)\n /lib64/ld-linux-x86-64.so.2 (0x123)\n'), ['/lib/x86_64-linux-gnu/libfoo.so.1', '/lib64/ld-linux-x86-64.so.2']);
  for (const output of ['libx => not found', 'statically linked', '', 'libx => relative/path (0x123)']) assert.throws(() => lddPaths(output));
});

test('data-only ELF libraries need an intact x64 dynamic table with no DT_NEEDED, not a bare ldd assertion', () => {
  // Synthetic ELF metadata only, never an executable or native runtime proof.
  const leaf = Buffer.alloc(184); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(leaf);
  leaf.writeUInt16LE(3, 16); leaf.writeUInt16LE(62, 18); leaf.writeBigUInt64LE(64n, 32); leaf.writeUInt16LE(56, 54); leaf.writeUInt16LE(1, 56);
  leaf.writeUInt32LE(2, 64); leaf.writeBigUInt64LE(120n, 72); leaf.writeBigUInt64LE(64n, 96); leaf.writeBigInt64LE(14n, 120);
  assert.deepEqual(lddLibraryPaths('statically linked', leaf), []);
  assert.throws(() => lddPaths('statically linked'));
  for (const mutate of [b => b.writeBigInt64LE(1n, 120), b => b.writeUInt16LE(2, 16), b => b.writeUInt16LE(183, 18), b => b.writeUInt8(2, 5),
    b => b.writeUInt16LE(0, 56), b => b.writeBigUInt64LE(185n, 72), b => b.writeBigUInt64LE(65n, 96),
    b => { for (let p = 120; p < b.length; p += 16) b.writeBigInt64LE(14n, p); }]) {
    const changed = Buffer.from(leaf); mutate(changed); assert.throws(() => lddLibraryPaths('statically linked', changed));
  }
  assert.throws(() => lddLibraryPaths('statically linked', leaf.subarray(0, 128)));
  assert.throws(() => lddLibraryPaths('libfoo.so => not found', leaf));
});

test('browser PG evidence rejects production database, wrong image, ports, or shared external network', () => {
  const expected = { name: 'bb-pr-gate-synthetic-pg', runner: 'bb-pr-gate-synthetic', imageId: 'sha256:' + 'a'.repeat(64), runId };
  const value = { Id: 'b'.repeat(64), Name: '/' + expected.name, Image: expected.imageId, Config: { Labels: { 'bondbuddy.pr-gate.run': runId }, Cmd: ['postgres', '-p', '55433'],
    Env: ['POSTGRES_USER=bondbuddy', 'POSTGRES_PASSWORD=synthetic-ci-only', 'POSTGRES_DB=bondbuddy_local'] }, HostConfig: { NetworkMode: 'container:' + expected.runner, Privileged: false, PortBindings: {} } };
  assert.equal(verifyBrowserDatabaseContainer(value, expected).port, 55433);
  for (const mutate of [p => p.Image = 'old', p => p.HostConfig.NetworkMode = 'bridge', p => p.HostConfig.PortBindings = { '55433/tcp': [{}] }, p => p.HostConfig.Privileged = true,
    p => p.Config.Env[2] = 'POSTGRES_DB=production', p => p.Config.Cmd[2] = '5432', p => p.Config.Labels['bondbuddy.pr-gate.run'] = 'old']) {
    const changed = structuredClone(value); mutate(changed); assert.throws(() => verifyBrowserDatabaseContainer(changed, expected));
  }
});

function receiptFixture(overrides = {}) {
  const expected = { ...candidate, ...fixtureHistoricalExpected(), matrix: [1, 2, 3].map(index => ({ name: `browser-${index}`, groups: 'browser', shard: `${index}/3` })), ...overrides };
  const capabilities = { tls: { ca_sha256: browserHash('synthetic-ca') } }, imageId = 'sha256:' + '8'.repeat(64);
  const receipt = { run_id: runId, started_at: '2026-11-11T13:00:00.000Z', finished_at: '2026-11-11T13:01:00.000Z',
    reference_components: syntheticReferenceRuns(expected, runId), historical_browser_apps: syntheticHistoricalRuns(expected, runId), capabilities, host_dispatch: { runtime: { image_id: imageId } }, shards: expected.matrix.map(row => {
    const { services, runtime, files } = syntheticBrowserShard(expected, row, capabilities, runId, imageId);
    return { ...row, started_at: '2026-11-11T13:00:00.000Z', finished_at: '2026-11-11T13:00:40.000Z', browser_services: services,
      summary: { browser_runtime: runtime, finishedAt: '2026-11-11T13:00:30.000Z', counts: { selected: files.length } } };
  }) };
  return { receipt, expected };
}

test('browser receipt binds complete batch, actual runtime probes, environment, candidate and cleanup', () => {
  const { receipt, expected } = receiptFixture(); verifyBrowserRuns(receipt, expected);
  for (const mutate of [r => r.shards[0].browser_services.plan.files.pop(), r => r.shards[0].summary.browser_runtime.files.pop(),
    r => r.shards[0].summary.browser_runtime.environment.BB_ELEVENTH_REFERENCE = '1', r => r.shards[0].summary.browser_runtime.environment.BB_TEST_LIVE_AUTHORING = '1',
    r => r.shards[0].summary.browser_runtime.invocation.args.splice(2, 1), r => r.shards[0].summary.browser_runtime.invocation.exit_code = 1,
    r => r.shards[0].summary.browser_runtime.invocation.timeout_ms = 71 * 60_000, r => r.shards[0].summary.browser_runtime.services_alive_before_cleanup.api = false,
    r => r.shards[0].summary.browser_runtime.probes.web.tls_verified = false, r => r.shards[0].summary.browser_runtime.probes.proxy.terms_version = 'old',
    r => r.shards[0].summary.browser_runtime.probes.browser_network.navigator_online = false,
    r => delete r.shards[0].summary.browser_runtime.upload_confirmation,
    r => delete r.shards[0].summary.browser_runtime.pid,
    r => r.shards[0].summary.browser_runtime.upload_confirmation.consumers.run.push('run'),
    r => r.shards[0].summary.browser_runtime.upload_confirmation.cleanup.steps[0].status = 'failed',
    r => delete r.shards[0].summary.browser_runtime.probes.browser_network,
    r => r.shards[0].summary.browser_runtime.commit = 'c'.repeat(40), r => r.shards[0].summary.browser_runtime.run_id = 'old',
    r => r.shards[0].summary.browser_runtime.cleanup.status = 'failed', r => r.shards[0].browser_services.cleanup.status = 'failed',
    r => r.shards[0].summary.browser_runtime.invocation.started_at = '2026-11-11T12:00:00.000Z', r => r.shards[0].summary.counts.selected--,
    r => r.shards[0].summary.browser_runtime.invocations.push(structuredClone(r.shards[0].summary.browser_runtime.invocations[0])),
    r => r.shards[0].summary.browser_runtime.invocations[0].environment.BB_UPDATE_HISTORY_BASELINE = '1',
    r => r.shards[0].summary.browser_runtime.preparation_deadline = '2026-11-11T13:00:11.000Z',
    r => r.shards[0].summary.browser_runtime.report.dispatch.reports[0].attachment_paths.push('/tmp/bondbuddy-web-test-results/unarchived.png'),
    r => delete r.shards[0].summary.browser_runtime]) {
    const altered = structuredClone(receipt); mutate(altered); assert.throws(() => verifyBrowserRuns(altered, expected));
  }
  const ocrIndex = receipt.shards.findIndex(row => row.browser_services.plan.needs.ocr);
  for (const mutate of [r => r.shards[ocrIndex].summary.browser_runtime.tools_final.manifest_sha256 = 'c'.repeat(64),
    r => r.shards[ocrIndex].summary.browser_runtime.probes.ocr.languages.pop(), r => r.shards[ocrIndex].browser_services.tools.image_id = 'sha256:' + 'd'.repeat(64)]) {
    const altered = structuredClone(receipt); mutate(altered); assert.throws(() => verifyBrowserRuns(altered, expected));
  }
  const qaIndex = receipt.shards.findIndex(row => row.browser_services.plan.files.some(file => file.test_id === QA_BASELINE_TEST));
  assert.ok(qaIndex >= 0);
  for (const mutate of [r => delete r.shards[qaIndex].summary.browser_runtime.historical_apps.find(app => app.id === 'qa').qa_baseline,
    r => delete r.shards[qaIndex].summary.browser_runtime.invocations.find(call => call.id === 'qa').environment.BB_QA_SINGLE_START_BASELINE,
    r => r.shards[qaIndex].summary.browser_runtime.historical_apps.find(app => app.id === 'qa').qa_baseline.after.aliases[0].loads = 0,
    r => r.shards[qaIndex].summary.browser_runtime.historical_apps.find(app => app.id === 'qa').qa_baseline.after.aliases[1].sha256 = 'f'.repeat(64)]) {
    const altered = structuredClone(receipt); mutate(altered); assert.throws(() => verifyBrowserRuns(altered, expected));
  }
});


test('QA receipt binds the private CLI, native physical paths, four screenshots and exact old app', () => {
  const { receipt, expected } = receiptFixture(); verifyBrowserRuns(receipt, expected);
  const select = r => r.shards.find(row => row.summary.browser_runtime.historical_apps.some(app => app.id === 'qa')).summary.browser_runtime;
  for (const change of [
    runtime => runtime.environment.BB_QA_SINGLE_START_BASELINE = '1',
    runtime => runtime.invocations.find(call => call.id === 'qa').cwd = '/workspace/apps/web',
    runtime => runtime.invocations.find(call => call.id === 'qa').command = 'npx',
    runtime => runtime.invocations.find(call => call.id === 'qa').args.push('--grep', '1440'),
    runtime => delete runtime.invocations.find(call => call.id === 'qa').qa_screenshots,
    runtime => runtime.invocations.find(call => call.id === 'qa').qa_screenshots.files.pop(),
    runtime => runtime.invocations.find(call => call.id === 'qa').output_archive_error = 'synthetic archive failure',
    runtime => runtime.report.dispatch.reports.find(report => report.id === 'qa').stats.expected = 1,
    runtime => runtime.report.dispatch.reports.find(report => report.id === 'qa').config_paths.configFile = '/workspace/apps/web/playwright.config.ts',
    runtime => runtime.report.dispatch.reports.find(report => report.id === 'qa').config_paths.projects[0].testDir = '/tmp/other/tests',
    runtime => runtime.historical_apps.find(app => app.id === 'qa').qa_baseline.after.aliases[0].requests = 0,
    runtime => runtime.historical_apps.find(app => app.id === 'qa').collector.resolutions_after[0].require_path = '/tmp/unverified/index.js',
    runtime => runtime.historical_apps.find(app => app.id === 'qa').listening_after_cleanup = true,
    runtime => runtime.historical_apps.find(app => app.id === 'qa').source_before.source.commit = 'f'.repeat(40),
    runtime => runtime.historical_apps.find(app => app.id === 'qa').compiler.args.push('--skipLibCheck'),
  ]) { const changed = structuredClone(receipt); change(select(changed)); assert.throws(() => verifyBrowserRuns(changed, expected)); }
});


test('current and all three historical dispatch groups fit the same synthetic shard lifecycle', () => {
  const files = ['apps/web/tests/account.spec.ts', 'apps/web/tests/consistency-history-baseline.spec.ts',
    'apps/web/tests/consistency-update-history-baseline.spec.ts', QA_BASELINE_TEST];
  const { receipt, expected } = receiptFixture({ matrix: [{ name: 'browser-1', groups: 'browser', shard: '1/1' }],
    browser_source_sha256: Object.fromEntries(files.map(file => [file, candidate.browser_source_sha256[file] ?? browserHash(file)])) });
  assert.deepEqual(receipt.shards[0].summary.browser_runtime.dispatch.map(group => group.id), ['current', 'history', 'update', 'qa']);
  assert.equal(verifyBrowserRuns(receipt, expected), undefined);
});
