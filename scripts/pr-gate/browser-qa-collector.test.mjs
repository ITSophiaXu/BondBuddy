import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { QA_COLLECTOR_FILES, QA_COLLECTOR_SOURCE, QA_COLLECTOR_TEST, QA_SCREENSHOTS, qaCollectorPaths, qaScreenshotIsPng, verifyQaCollector, verifyQaScreenshots } from './browser-qa-collector.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Synthetic receipt data only; never a source/runtime passing claim.
function specimen() {
  const plan = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), run_id: 'synthetic-qa-closure', shard: 'browser-2',
    output_root: '/evidence/shards/browser-2/browser', environment: { BB_UX_EVIDENCE_DIR: '/evidence/shards/browser-2/browser/shared' },
    files: [{ test_id: QA_COLLECTOR_TEST, source_sha256: '8016d46b179f0a59c33eb106cbe58b807368912194b0ced85fc38c369d4d170d' }] };
  const paths = qaCollectorPaths(plan), dependencies = { schema: 'pr-gate-historical-dependency-bytes-v1', installed: false, workspace_links_changed: false,
    packages: ['@playwright/test', '@sinclair/typebox'].map(name => ({ path: 'node_modules/' + name, actual_root: '/workspace/node_modules/' + name, cache_sri_verified: true, files_sha256: 'c'.repeat(64) })) };
  const compiler = { old_contracts_tree: '82823b2b281c461b2483818b476861bc856d3117', output_root: paths.runtimeRoot + '/contracts/dist', output_files: [{ path: 'index.js', bytes: 42, sha256: 'd'.repeat(64) }] };
  const source = { source: { ...QA_COLLECTOR_SOURCE }, files: structuredClone([...QA_COLLECTOR_FILES, { path: 'packages/contracts/package.json', blob: '34eb979ce49d11b2d8746851917cd0d1776544ce', bytes: 824, sha256: 'b755b3af4a9408b0baaba5dc652825c3ef7b3a1918e63a03c61305de837bc525' }]) };
  const triples = [
    ['tests/qa-single-start-baseline.spec.ts', '@playwright/test', 'index'],
    ['tests/project-qa-continuation-fixtures.ts', '@playwright/test', 'index'],
    ['tests/project-qa-continuation-fixtures.ts', '@bondbuddy/contracts', 'contracts'],
    ['tests/project-qa-continuation-fixtures.ts', '@sinclair/typebox', 'box'],
    ['tests/project-qa-continuation-fixtures.ts', '@sinclair/typebox/value', 'value'],
    ['playwright.config.ts', '@playwright/test', 'index'],
    ['playwright.config.ts', '@playwright/test/cli', 'cli'],
    ['compiled', '@sinclair/typebox', 'box'],
  ];
  const resolutions = triples.map(([from, specifier, type]) => {
    const package_root = type === 'contracts' ? paths.runtimeRoot + '/contracts' : '/workspace/node_modules/' + (type === 'box' || type === 'value' ? '@sinclair/typebox' : '@playwright/test');
    const parts = { index: ['index.js', 'index.mjs'], cli: ['cli.js', 'cli.js'], contracts: ['dist/index.js', 'dist/index.js'], box: ['build/cjs/index.js', 'build/esm/index.mjs'], value: ['build/cjs/value/index.js', 'build/esm/value/index.mjs'] }[type];
    return { from: from === 'compiled' ? compiler.output_root + '/index.js' : paths.cwd + '/' + from, specifier, package_root,
      require_path: package_root + '/' + parts[0], import_path: package_root + '/' + parts[1], require_sha256: (type === 'contracts' ? 'd' : 'e').repeat(64), import_sha256: (type === 'contracts' ? 'd' : 'e').repeat(64) };
  });
  const copies = QA_COLLECTOR_FILES.map(row => ({ ...row, destination: paths.collectorRoot + '/' + row.path }));
  const value = { schema: 'pr-gate-qa-collector-v1', candidate: { commit: plan.commit, tree: plan.tree }, run_id: plan.run_id, shard: plan.shard, test_id: QA_COLLECTOR_TEST,
    source: QA_COLLECTOR_SOURCE, source_root: paths.sourceRoot, runtime_root: paths.runtimeRoot, cwd: paths.cwd,
    command: '/usr/local/bin/node', args: ['/workspace/node_modules/@playwright/test/cli.js', 'test', 'tests/qa-single-start-baseline.spec.ts', '--reporter=line,json'],
    source_rewrites: 0, installs: 0, screenshots_initially_absent: true, source_files: QA_COLLECTOR_FILES, copies_before: copies, copies_after: structuredClone(copies),
    private_links: [{ path: paths.cwd + '/node_modules/@bondbuddy/contracts', target: paths.runtimeRoot + '/contracts' },
      ...['@playwright/test', '@sinclair/typebox'].map(name => ({ path: paths.cwd + '/node_modules/' + name, target: '/workspace/node_modules/' + name }))],
    resolution_method: 'createRequire.resolve plus pinned conditional exports; not actual module-load evidence', resolutions_before: resolutions, resolutions_after: structuredClone(resolutions), verification_after: { status: 'passed' } };
  return { value, inputs: { source, runtimeRoot: paths.runtimeRoot, dependencies, compiler, plan }, paths };
}

test('a complete original collector proof is pure and binds separate require/import targets', () => {
  const { value, inputs } = specimen(), original = structuredClone(value); assert.equal(verifyQaCollector(value, inputs), value); assert.deepEqual(value, original);
  const box = value.resolutions_before.find(row => row.specifier === '@sinclair/typebox'); assert.notEqual(box.require_path, box.import_path);
  assert.equal(value.copies_before.length, 6); assert.equal(value.resolutions_before.filter(row => row.specifier === '@bondbuddy/contracts').length, 1);
});

test('current fixtures, wrong historical contracts, missing or duplicated original inputs are rejected', () => {
  for (const change of [
    row => row.source.source.commit = 'f'.repeat(40),
    row => row.source.files.find(file => file.path.endsWith('project-qa-continuation-fixtures.ts')).sha256 = 'f'.repeat(64),
    row => row.source.files.pop(),
    row => row.source.files.push(structuredClone(row.source.files[0])),
    row => row.compiler.old_contracts_tree = 'f'.repeat(40),
    row => row.compiler.output_root = '/workspace/packages/contracts/dist',
  ]) { const { value, inputs } = specimen(); change(inputs); assert.throws(() => verifyQaCollector(value, inputs)); }
});

test('shared candidate cwd, rewritten copies, changed links and unresolved post-run checks stay blocking', () => {
  for (const change of [
    row => row.cwd = '/workspace/apps/web',
    row => row.copies_before[0].destination = '/workspace/apps/web/package.json',
    row => row.copies_after[0].sha256 = 'f'.repeat(64),
    row => row.private_links[0].target = '/workspace/packages/contracts',
    row => row.source_rewrites = 1,
    row => row.installs = 1,
    row => row.verification_after.status = 'pending',
    row => row.screenshots_initially_absent = false,
  ]) { const { value, inputs } = specimen(); change(value); assert.throws(() => verifyQaCollector(value, inputs)); }
});

test('resolution proof rejects candidate contracts, nested foreign packages and false actual-load claims', () => {
  for (const change of [
    rows => rows.find(row => row.specifier === '@bondbuddy/contracts').require_path = '/workspace/packages/contracts/dist/index.js',
    rows => rows.find(row => row.specifier === '@bondbuddy/contracts').require_sha256 = 'f'.repeat(64),
    rows => rows.find(row => row.specifier === '@sinclair/typebox').import_path = '/workspace/node_modules/@sinclair/typebox/node_modules/other/index.js',
    rows => rows.find(row => row.specifier === '@sinclair/typebox').import_path = rows.find(row => row.specifier === '@sinclair/typebox').require_path,
    rows => rows.pop(),
  ]) { const { value, inputs } = specimen(); change(value.resolutions_before); value.resolutions_after = structuredClone(value.resolutions_before); assert.throws(() => verifyQaCollector(value, inputs)); }
  const { value, inputs } = specimen(); value.resolution_method = 'all actual modules loaded'; assert.throws(() => verifyQaCollector(value, inputs));
});

test('the verified absolute CLI runs the original full file with no appended filtering or budget override', () => {
  for (const change of [row => row.command = 'npx', row => row.args[0] = '/workspace/node_modules/playwright/cli.js', row => row.args.push('--grep', '1440'), row => row.args.push('--timeout', '120000'), row => row.args[2] = 'tests/current-qa.spec.ts']) {
    const { value, inputs } = specimen(); change(value); assert.throws(() => verifyQaCollector(value, inputs));
  }
  for (const change of [row => row.run_id = '../outside', row => row.shard = 'browser-4', row => row.environment.BB_UX_EVIDENCE_DIR = '/tmp/other', row => row.files.push(structuredClone(row.files[0]))]) {
    const { inputs } = specimen(); change(inputs.plan); assert.throws(() => qaCollectorPaths(inputs.plan));
  }
});

test('four original PNG names and exact archive mappings are mandatory without rewriting raw reports', () => {
  const { inputs: { plan }, paths } = specimen();
  const files = QA_SCREENSHOTS.map(name => ({ name, original_path: paths.screenshotRoot + '/' + name, archive_path: paths.screenshotArchive + '/' + name, bytes: 100, sha256: 'e'.repeat(64), valid_png: true }));
  const value = { schema: 'pr-gate-qa-screenshots-v1', run_id: plan.run_id, shard: plan.shard, source_root: paths.screenshotRoot, archive_root: paths.screenshotArchive,
    png_check: 'signature, chunk bounds/CRC, IHDR and terminal IEND; no pixel decoding', status: 'passed', files, missing: [], errors: [], manifest_sha256: digest({ files, missing: [], errors: [] }) };
  assert.equal(verifyQaScreenshots(value, plan), value);
  for (const change of [row => row.status = 'incomplete', row => row.missing.push(QA_SCREENSHOTS[0]), row => row.files.pop(), row => row.files[0].archive_path = '/tmp/unowned.png', row => row.files[0].name = 'replacement.png', row => row.files[0].bytes = 0,
    row => row.files[0].valid_png = false, row => row.errors.push({ name: QA_SCREENSHOTS[0], stage: 'archive', error: 'synthetic write failure' }), row => row.manifest_sha256 = 'f'.repeat(64)]) {
    const bad = structuredClone(value); change(bad); assert.throws(() => verifyQaScreenshots(bad, plan));
  }
});

test('a standard PNG retains its integrity while truncation, changed chunks and appended bytes fail', () => {
  // Independent standard-library CRC for a one-pixel unit fixture, not evidence.
  const chunk = (type, data) => { const length = Buffer.alloc(4), payload = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(payload)); return Buffer.concat([length, payload, crc]); };
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', Buffer.from('00000001000000010806000000', 'hex')),
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);
  assert.equal(qaScreenshotIsPng(png), true);
  for (const bytes of [Buffer.alloc(0), png.subarray(0, 8), png.subarray(0, -1), png.subarray(0, -12), Buffer.concat([png, Buffer.from('trailer')])]) assert.equal(qaScreenshotIsPng(bytes), false);
  const changed = Buffer.from(png); changed[changed.length - 16] ^= 1; assert.equal(qaScreenshotIsPng(changed), false);
});
