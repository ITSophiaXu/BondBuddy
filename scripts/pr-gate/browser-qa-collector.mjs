import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = path => resolve(path).replaceAll('\\', '/');
const digest = value => hash(Buffer.from(JSON.stringify(value)));
export const QA_COLLECTOR_SOURCE = Object.freeze({ commit: '5839177e404d247947de968b58dbb430622409ff', tree: '3d7b9b6d3873f64ffea40b11362255606b63524f' });
export const QA_COLLECTOR_TEST = 'apps/web/tests/qa-single-start-baseline.spec.ts';
export const QA_COLLECTOR_FILES = Object.freeze([
  ['apps/web/package.json', 'a42d935e455b33d29f04b309e437193436a0c3bd', 543, 'e9741baa684ab4767998089e0031077dcee18926f4ac6a019d3067d32067981d'],
  ['apps/web/playwright.config.ts', '9c1312b2dc2f6a4320374014fb359ce5a5ac3e30', 648, '3c4e56eb6b295a4bb41a533d669650dcbfe6501cf01f7e36470e7848082cbba2'],
  ['apps/web/tests/collection-fixtures.ts', 'e988538a853a6e6572ee4273d1519cdeeadb8023', 622, '875abbbcf8f8db896e04f75f1b0c54f182cc8fe46900565c767aa7420cb27934'],
  ['apps/web/tests/project-qa-continuation-fixtures.ts', '57af9b33a567458d0b5152d7580f52422049045f', 18301, 'b825a77c951b8abf6f39c7b66c42e90b4af96d491af0f6ed1db75dba1c5bdaa8'],
  [QA_COLLECTOR_TEST, '89eb6e9084f89883c6c4cb5f15a9d6cb46f997de', 1547, '8016d46b179f0a59c33eb106cbe58b807368912194b0ced85fc38c369d4d170d'],
  ['apps/web/tsconfig.json', '7662068f31b6c85a50f867b5c0f09eec2706984b', 332, '7545ce359f4ab228249540c67e741ffbd1e6aaf5f10d29146457f2626445737a'],
].map(([path, blob, bytes, sha256]) => Object.freeze({ path, blob, bytes, sha256 })));
const CONTRACTS_PACKAGE = Object.freeze({ path: 'packages/contracts/package.json', blob: '34eb979ce49d11b2d8746851917cd0d1776544ce', bytes: 824, sha256: 'b755b3af4a9408b0baaba5dc652825c3ef7b3a1918e63a03c61305de837bc525' });
const CONTRACTS_TREE = '82823b2b281c461b2483818b476861bc856d3117';
const PACKAGE_EXPORTS = Object.freeze({
  '@playwright/test': { name: '@playwright/test', require: 'index.js', import: 'index.mjs' },
  '@playwright/test/cli': { name: '@playwright/test', require: 'cli.js', import: 'cli.js' },
  '@sinclair/typebox': { name: '@sinclair/typebox', require: 'build/cjs/index.js', import: 'build/esm/index.mjs' },
  '@sinclair/typebox/value': { name: '@sinclair/typebox', require: 'build/cjs/value/index.js', import: 'build/esm/value/index.mjs' },
});
export const QA_SCREENSHOTS = Object.freeze(['before-recognition-1440.png', 'before-recognition-390.png', 'before-preparation-1440.png', 'before-preparation-390.png']);
const PNG_CHECK = 'signature, chunk bounds/CRC, IHDR and terminal IEND; no pixel decoding';

export function qaCollectorPaths(plan) {
  assert.match(plan.run_id, /^[a-zA-Z0-9-]{8,80}$/); assert.match(plan.shard, /^browser-[123]$/);
  for (const key of ['commit', 'tree']) assert.match(plan[key], /^[a-f0-9]{40}$/);
  const runtimeRoot = `/tmp/pr-gate-historical/${plan.run_id}/${plan.shard}/qa`, collectorRoot = runtimeRoot + '/collector';
  assert.equal(plan.output_root, `/evidence/shards/${plan.shard}/browser`);
  assert.equal(plan.environment.BB_UX_EVIDENCE_DIR, plan.output_root + '/shared');
  const tests = plan.files.filter(row => row.test_id === QA_COLLECTOR_TEST); assert.equal(tests.length, 1);
  assert.equal(tests[0].source_sha256, QA_COLLECTOR_FILES.find(row => row.path === QA_COLLECTOR_TEST).sha256);
  return { runtimeRoot, collectorRoot, cwd: collectorRoot + '/apps/web', sourceRoot: '/opt/pr-gate-historical-browser/qa',
    screenshotRoot: plan.environment.BB_UX_EVIDENCE_DIR, screenshotArchive: plan.output_root + '/qa-collector-screenshots' };
}
function verifyInputs({ source, runtimeRoot, dependencies, compiler, plan }) {
  const paths = qaCollectorPaths(plan); assert.equal(runtimeRoot, paths.runtimeRoot);
  assert.equal(source.source.commit, QA_COLLECTOR_SOURCE.commit); assert.equal(source.source.tree, QA_COLLECTOR_SOURCE.tree);
  for (const expected of [...QA_COLLECTOR_FILES, CONTRACTS_PACKAGE]) assert.deepEqual(source.files.filter(row => row.path === expected.path), [expected], 'Original QA collector source differs: ' + expected.path);
  assert.equal(compiler.old_contracts_tree, CONTRACTS_TREE); assert.equal(compiler.output_root, runtimeRoot + '/contracts/dist');
  const entries = compiler.output_files.filter(row => row.path === 'index.js'); assert.equal(entries.length, 1); assert.ok(entries[0].bytes > 0); assert.match(entries[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(dependencies.schema, 'pr-gate-historical-dependency-bytes-v1'); assert.equal(dependencies.installed, false); assert.equal(dependencies.workspace_links_changed, false);
  return paths;
}
function registry(dependencies, name) {
  const rows = dependencies.packages.filter(row => row.path === 'node_modules/' + name); assert.equal(rows.length, 1);
  assert.equal(rows[0].actual_root, '/workspace/node_modules/' + name); assert.equal(rows[0].cache_sri_verified, true);
  assert.match(rows[0].files_sha256, /^[a-f0-9]{64}$/); return rows[0];
}
function directory(path) { const stat = lstatSync(path); assert.ok(stat.isDirectory() && !stat.isSymbolicLink()); assert.equal(canonical(realpathSync(path)), canonical(path)); }
function bytesAt(path) { const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink()); assert.equal(canonical(realpathSync(path)), canonical(path)); return readFileSync(path); }
function fileIdentity(path, bytes) { return { path, blob: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), bytes: bytes.length, sha256: hash(bytes) }; }
function expectedLinks(paths, dependencies) {
  return [{ path: paths.cwd + '/node_modules/@bondbuddy/contracts', target: paths.runtimeRoot + '/contracts' },
    ...['@playwright/test', '@sinclair/typebox'].map(name => ({ path: paths.cwd + '/node_modules/' + name, target: registry(dependencies, name).actual_root }))];
}
function expectedCopies(paths) { return QA_COLLECTOR_FILES.map(row => ({ ...row, destination: paths.collectorRoot + '/' + row.path })); }
function readPrivateCopies(paths, links) {
  const allowedFiles = QA_COLLECTOR_FILES.map(row => row.path), allowedLinks = links.map(row => relative(paths.collectorRoot, row.path).replaceAll('\\', '/')), seen = [];
  function walk(dir, prefix = '') {
    directory(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + entry.name, target = join(dir, entry.name);
      if (entry.isSymbolicLink()) { assert.ok(allowedLinks.includes(name), 'Unexpected private collector link'); seen.push(name); }
      else if (entry.isDirectory()) { assert.ok([...allowedFiles, ...allowedLinks].some(path => path.startsWith(name + '/')), 'Unexpected private collector directory'); walk(target, name + '/'); }
      else { assert.ok(allowedFiles.includes(name), 'Unexpected private collector file'); assert.equal(lstatSync(target).nlink, 1); seen.push(name); }
    }
  }
  walk(paths.collectorRoot); assert.deepEqual(seen.sort(), [...allowedFiles, ...allowedLinks].sort());
  for (const link of links) { assert.ok(lstatSync(link.path).isSymbolicLink()); assert.equal(canonical(realpathSync(link.path)), link.target); }
  return QA_COLLECTOR_FILES.map(expected => {
    const destination = paths.collectorRoot + '/' + expected.path, actual = fileIdentity(expected.path, bytesAt(destination)); assert.deepEqual(actual, expected);
    return { ...actual, destination };
  });
}
function exportTarget(value, kind) {
  if (typeof value === 'string') return value;
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  for (const [condition, next] of Object.entries(value)) if (['node', kind, 'default'].includes(condition)) return exportTarget(next, kind);
  assert.fail('Pinned package export has no supported runtime target');
}
function expectedResolutions(paths, dependencies, compiler) {
  const cases = [
    ['apps/web/tests/qa-single-start-baseline.spec.ts', '@playwright/test'],
    ['apps/web/tests/project-qa-continuation-fixtures.ts', '@playwright/test'],
    ['apps/web/tests/project-qa-continuation-fixtures.ts', '@bondbuddy/contracts'],
    ['apps/web/tests/project-qa-continuation-fixtures.ts', '@sinclair/typebox'],
    ['apps/web/tests/project-qa-continuation-fixtures.ts', '@sinclair/typebox/value'],
    ['apps/web/playwright.config.ts', '@playwright/test'],
    ['apps/web/playwright.config.ts', '@playwright/test/cli'],
    ['compiled-contracts/index.js', '@sinclair/typebox'],
  ];
  return cases.map(([origin, specifier]) => {
    const from = origin.startsWith('compiled-contracts/') ? compiler.output_root + '/index.js' : paths.collectorRoot + '/' + origin;
    if (specifier === '@bondbuddy/contracts') return { from, specifier, package_root: paths.runtimeRoot + '/contracts', require_path: compiler.output_root + '/index.js', import_path: compiler.output_root + '/index.js' };
    const entry = PACKAGE_EXPORTS[specifier], pkg = registry(dependencies, entry.name);
    return { from, specifier, package_root: pkg.actual_root, require_path: pkg.actual_root + '/' + entry.require, import_path: pkg.actual_root + '/' + entry.import };
  });
}
function probeResolutions(paths, dependencies, compiler) {
  assert.deepEqual(fileIdentity(CONTRACTS_PACKAGE.path, bytesAt(paths.runtimeRoot + '/contracts/package.json')), CONTRACTS_PACKAGE);
  return expectedResolutions(paths, dependencies, compiler).map(expected => {
    // Resolution only: do not import/evaluate the collector or its fixtures.
    const resolver = createRequire(expected.from); assert.equal(canonical(resolver.resolve(expected.specifier)), expected.require_path);
    const pkg = JSON.parse(bytesAt(expected.package_root + '/package.json'));
    const name = expected.specifier === '@bondbuddy/contracts' ? '@bondbuddy/contracts' : PACKAGE_EXPORTS[expected.specifier].name;
    assert.equal(pkg.name, name);
    const subpath = expected.specifier === name ? '.' : '.' + expected.specifier.slice(name.length);
    for (const kind of ['require', 'import']) assert.equal(canonical(join(expected.package_root, exportTarget(pkg.exports[subpath], kind))), expected[kind + '_path']);
    if (expected.specifier === '@playwright/test/cli') assert.equal(pkg.bin.playwright, 'cli.js');
    const requireBytes = bytesAt(expected.require_path), importBytes = bytesAt(expected.import_path);
    if (expected.specifier === '@bondbuddy/contracts') { const entry = compiler.output_files.find(row => row.path === 'index.js'); assert.equal(hash(requireBytes), entry.sha256); assert.equal(requireBytes.length, entry.bytes); }
    return { ...expected, require_sha256: hash(requireBytes), import_sha256: hash(importBytes) };
  });
}

/** Restore only immutable original collector inputs into a private, fresh cwd. */
export function prepareQaCollector({ sourceRoot, source, runtimeRoot, dependencies, compiler, plan }) {
  const inputs = { source, runtimeRoot, dependencies, compiler, plan }, paths = verifyInputs(inputs); assert.equal(sourceRoot, paths.sourceRoot);
  directory(runtimeRoot); directory(sourceRoot); assert.equal(existsSync(paths.collectorRoot), false, 'QA collector directory is not fresh');
  const sourceBytes = QA_COLLECTOR_FILES.map(row => { const bytes = bytesAt(sourceRoot + '/' + row.path); assert.deepEqual(fileIdentity(row.path, bytes), row); return [row, bytes]; });
  // An old screenshot from another group/run cannot satisfy this collector.
  for (const name of QA_SCREENSHOTS) assert.equal(existsSync(paths.screenshotRoot + '/' + name), false, 'QA screenshot already exists before the collector');
  mkdirSync(paths.collectorRoot);
  for (const [row, bytes] of sourceBytes) { const destination = paths.collectorRoot + '/' + row.path; mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, bytes, { flag: 'wx' }); }
  const links = expectedLinks(paths, dependencies);
  for (const link of links) { directory(link.target); mkdirSync(dirname(link.path), { recursive: true }); symlinkSync(link.target, link.path, 'dir'); }
  const copies = readPrivateCopies(paths, links), resolutions = probeResolutions(paths, dependencies, compiler);
  const cli = resolutions.find(row => row.specifier === '@playwright/test/cli'); assert.equal(process.execPath, '/usr/local/bin/node');
  const command = process.execPath, args = [cli.require_path, 'test', 'tests/qa-single-start-baseline.spec.ts', '--reporter=line,json'];
  const evidence = { schema: 'pr-gate-qa-collector-v1', candidate: { commit: plan.commit, tree: plan.tree }, run_id: plan.run_id, shard: plan.shard,
    test_id: QA_COLLECTOR_TEST, source: QA_COLLECTOR_SOURCE, source_root: sourceRoot, runtime_root: runtimeRoot, cwd: paths.cwd,
    command, args, source_rewrites: 0, installs: 0, source_files: QA_COLLECTOR_FILES, copies_before: copies, private_links: links,
    resolution_method: 'createRequire.resolve plus pinned conditional exports; not actual module-load evidence', resolutions_before: resolutions,
    screenshots_initially_absent: true, verification_after: { status: 'pending' } };
  return { evidence, cwd: paths.cwd, command, args,
    verifyAfter() {
      try {
        evidence.copies_after = readPrivateCopies(paths, links); evidence.resolutions_after = probeResolutions(paths, dependencies, compiler);
        assert.deepEqual(evidence.copies_after, copies); assert.deepEqual(evidence.resolutions_after, resolutions);
        evidence.verification_after = { status: 'passed' }; return verifyQaCollector(evidence, inputs);
      } catch (error) { evidence.verification_after = { status: 'failed', error: error.message }; error.qaCollectorEvidence = evidence; throw error; }
    },
  };
}

/** Pure receipt validation: no host path resolution and no runtime execution. */
export function verifyQaCollector(value, inputs) {
  const { dependencies, compiler, plan } = inputs, paths = verifyInputs(inputs);
  assert.equal(value?.schema, 'pr-gate-qa-collector-v1'); assert.deepEqual(value.candidate, { commit: plan.commit, tree: plan.tree });
  assert.equal(value.run_id, plan.run_id); assert.equal(value.shard, plan.shard); assert.equal(value.test_id, QA_COLLECTOR_TEST); assert.deepEqual(value.source, QA_COLLECTOR_SOURCE);
  assert.equal(value.source_root, paths.sourceRoot); assert.equal(value.runtime_root, paths.runtimeRoot); assert.equal(value.cwd, paths.cwd);
  assert.equal(value.source_rewrites, 0); assert.equal(value.installs, 0); assert.equal(value.screenshots_initially_absent, true);
  assert.deepEqual(value.source_files, QA_COLLECTOR_FILES); assert.deepEqual(value.copies_before, expectedCopies(paths)); assert.deepEqual(value.copies_after, value.copies_before);
  assert.deepEqual(value.private_links, expectedLinks(paths, dependencies)); assert.equal(value.resolution_method, 'createRequire.resolve plus pinned conditional exports; not actual module-load evidence');
  const expected = expectedResolutions(paths, dependencies, compiler);
  assert.equal(value.resolutions_before.length, expected.length);
  value.resolutions_before.forEach((row, index) => {
    const { require_sha256, import_sha256, ...binding } = row; assert.deepEqual(binding, expected[index]);
    for (const sha of [require_sha256, import_sha256]) assert.match(sha, /^[a-f0-9]{64}$/);
    if (row.require_path === row.import_path) assert.equal(require_sha256, import_sha256);
    if (row.specifier === '@bondbuddy/contracts') assert.equal(require_sha256, compiler.output_files.find(file => file.path === 'index.js').sha256);
  });
  assert.deepEqual(value.resolutions_after, value.resolutions_before);
  const cli = expected.find(row => row.specifier === '@playwright/test/cli');
  assert.equal(value.command, '/usr/local/bin/node'); assert.deepEqual(value.args, [cli.require_path, 'test', 'tests/qa-single-start-baseline.spec.ts', '--reporter=line,json']);
  assert.deepEqual(value.verification_after, { status: 'passed' }); return value;
}

/** Container integrity only, so a partially written screenshot stays incomplete. */
export function qaScreenshotIsPng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 45 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return false;
  let offset = 8, first = true, imageData = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset), end = offset + 12 + size; if (end > bytes.length) return false;
    const type = bytes.toString('ascii', offset + 4, offset + 8); if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (first && (type !== 'IHDR' || size !== 13 || !bytes.readUInt32BE(offset + 8) || !bytes.readUInt32BE(offset + 12))) return false;
    if (!first && type === 'IHDR') return false;
    let crc = 0xffffffff;
    for (let index = offset + 4; index < end - 4; index++) { crc ^= bytes[index]; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(end - 4)) return false;
    if (type === 'IDAT') imageData = true;
    if (type === 'IEND') return !first && imageData && size === 0 && end === bytes.length;
    first = false; offset = end;
  }
  return false;
}
/** Preserve every produced original screenshot even when one is truncated. */
export function captureQaScreenshots(plan) {
  const paths = qaCollectorPaths(plan); assert.equal(existsSync(paths.screenshotArchive), false, 'QA screenshot archive is not fresh');
  mkdirSync(paths.screenshotArchive, { recursive: true }); const files = [], missing = [], errors = [];
  for (const name of QA_SCREENSHOTS) {
    const original_path = paths.screenshotRoot + '/' + name, archive_path = paths.screenshotArchive + '/' + name;
    if (!existsSync(original_path)) { missing.push(name); continue; }
    let stage = 'read';
    try {
      const bytes = bytesAt(original_path); stage = 'archive'; writeFileSync(archive_path, bytes, { flag: 'wx' }); assert.equal(hash(bytesAt(archive_path)), hash(bytes));
      const valid_png = qaScreenshotIsPng(bytes); files.push({ name, original_path, archive_path, bytes: bytes.length, sha256: hash(bytes), valid_png });
      if (!valid_png) errors.push({ name, stage: 'png', error: 'Original PNG is incomplete or failed the recorded container integrity checks' });
    } catch (error) { errors.push({ name, stage, error: error.message }); }
  }
  return { schema: 'pr-gate-qa-screenshots-v1', run_id: plan.run_id, shard: plan.shard, source_root: paths.screenshotRoot, archive_root: paths.screenshotArchive,
    png_check: PNG_CHECK, status: missing.length || errors.length ? 'incomplete' : 'passed', files, missing, errors, manifest_sha256: digest({ files, missing, errors }) };
}
export function verifyQaScreenshots(value, plan) {
  const paths = qaCollectorPaths(plan); assert.equal(value?.schema, 'pr-gate-qa-screenshots-v1'); assert.equal(value.run_id, plan.run_id); assert.equal(value.shard, plan.shard);
  assert.equal(value.source_root, paths.screenshotRoot); assert.equal(value.archive_root, paths.screenshotArchive); assert.equal(value.png_check, PNG_CHECK);
  assert.equal(value.status, 'passed'); assert.deepEqual(value.missing, []); assert.deepEqual(value.errors, []);
  assert.deepEqual(value.files.map(row => row.name), QA_SCREENSHOTS);
  for (const row of value.files) { assert.equal(row.original_path, paths.screenshotRoot + '/' + row.name); assert.equal(row.archive_path, paths.screenshotArchive + '/' + row.name); assert.ok(Number.isSafeInteger(row.bytes) && row.bytes >= 45); assert.match(row.sha256, /^[a-f0-9]{64}$/); assert.equal(row.valid_png, true); }
  assert.equal(value.manifest_sha256, digest({ files: value.files, missing: value.missing, errors: value.errors })); return value;
}
