// SYNTHETIC validator records only. Never runtime, release, module-load, or build evidence.
// Source identities and lock bytes are real immutable inputs; all process/probe/output
// records below are visibly synthetic. No production verifier has a fixture exemption.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HISTORICAL_PROFILE_SHA256, HISTORICAL_ROOT, HISTORICAL_SOURCES, historicalBlobIdentity, historicalHash,
  verifyHistoricalDirectory, verifyHistoricalRecord } from './browser-historical-source.mjs';
import { historicalDependencyClosure } from './browser-historical-dependencies.mjs';
import { HISTORICAL_COLLECTORS } from './browser-dispatch.mjs';
import { QA_BASELINE_SOURCE, QA_HISTORICAL_APP_ROOT, qaBaselineAliasesForApp } from './browser-reference-source.mjs';
import { syntheticQaBaselineIdentity, syntheticReferenceRuns } from './browser-reference.test-fixture.mjs';
import { QA_COLLECTOR_FILES, QA_COLLECTOR_SOURCE, QA_COLLECTOR_TEST, QA_SCREENSHOTS, qaCollectorPaths } from './browser-qa-collector.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const stamp = second => `2026-11-11T13:00:${String(second).padStart(2, '0')}.000Z`;
let sourceInputs;
function pinnedInputs() {
  if (sourceInputs) return sourceInputs;
  const locks = {}, sources = {};
  if (existsSync(HISTORICAL_ROOT)) {
    const record = verifyHistoricalDirectory();
    for (const id of Object.keys(HISTORICAL_SOURCES)) locks[id] = readFileSync(`${HISTORICAL_ROOT}/${id}/package-lock.json`);
    sourceInputs = { record, locks }; return sourceInputs;
  }
  // Read only objects already present. No lazy fetch, credentials, hooks, checkout or network.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
  const git = (args, input) => {
    const result = spawnSync('git', ['--no-replace-objects', '-c', 'credential.helper=', '-c', 'core.fsmonitor=false', ...args],
      { cwd: repository, env, input, windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024 * 1024 });
    assert.ifError(result.error); assert.equal(result.status, 0, 'Fixture requires already-local pinned historical Git objects'); return result.stdout;
  };
  const blobs = new Map();
  for (const [id, source] of Object.entries(HISTORICAL_SOURCES)) {
    assert.equal(git(['rev-parse', source.commit + '^{tree}']).toString().trim(), source.tree);
    for (const [path, object] of Object.entries(source.objects)) assert.equal(git(['rev-parse', `${source.commit}:${path}`]).toString().trim(), object);
    const rows = git(['ls-tree', '-r', '-z', source.commit, '--', ...Object.keys(source.objects)]).toString('utf8').split('\0').filter(Boolean).map(row => {
      const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(row); assert.ok(match, 'Fixture historical source has an unsupported mode'); return { blob: match[1], path: match[2] };
    });
    const missing = [...new Set(rows.map(row => row.blob))].filter(blob => !blobs.has(blob));
    if (missing.length) {
      const bytes = git(['cat-file', '--batch'], Buffer.from(missing.join('\n') + '\n')); let offset = 0;
      for (const blob of missing) {
        const end = bytes.indexOf(10, offset), header = /^([a-f0-9]{40}) blob (\d+)$/.exec(bytes.subarray(offset, end).toString());
        assert.ok(end > offset && header); assert.equal(header[1], blob); const size = Number(header[2]);
        assert.ok(Number.isSafeInteger(size) && size >= 0 && end + 1 + size < bytes.length); assert.equal(bytes[end + 1 + size], 10);
        const body = bytes.subarray(end + 1, end + 1 + size); assert.equal(historicalBlobIdentity('fixture', body).blob, blob);
        blobs.set(blob, body); offset = end + 2 + size;
      }
      assert.equal(offset, bytes.length);
    }
    const files = rows.map(row => historicalBlobIdentity(row.path, blobs.get(row.blob))).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    sources[id] = { source, files, files_sha256: historicalHash(files) };
    locks[id] = blobs.get(source.objects['package-lock.json']);
  }
  const record = verifyHistoricalRecord({ schema: 'pr-gate-historical-app-source-v1', root: HISTORICAL_ROOT,
    profile_sha256: HISTORICAL_PROFILE_SHA256, not_a_seal: true, not_execution_evidence: true, sources });
  sourceInputs = { record, locks }; return sourceInputs;
}
export function fixtureCandidateLockBytes() { return readFileSync(new URL('../../package-lock.json', import.meta.url)); }
export function fixtureHistoricalExpected() {
  return { historical_verifier_sha256: historicalHash(readFileSync(new URL('./browser-historical-source.mjs', import.meta.url))),
    cache_files: { 'package-lock.json': historicalHash(fixtureCandidateLockBytes()) } };
}
export function syntheticHistoricalIdentity(root = HISTORICAL_ROOT) { return { ...structuredClone(pinnedInputs().record), root }; }
export function syntheticHistoricalRuns(expected, runId, containerId = 'c'.repeat(64)) {
  const reference = syntheticReferenceRuns(expected, runId, containerId), common = { commit: expected.commit, tree: expected.tree, run_id: runId, container_id: containerId };
  const root = '/synthetic/historical-browser-sources/' + runId;
  const check = (stage, second) => ({ ...common, stage, verifier_sha256: expected.historical_verifier_sha256,
    started_at: stamp(second), finished_at: stamp(second), execution: { code: 0 }, identity: syntheticHistoricalIdentity() });
  return { schema: 'pr-gate-historical-app-run-v1', ...common,
    host_before: syntheticHistoricalIdentity(root), host_after: syntheticHistoricalIdentity(root),
    mount_before: reference.mount_before, mount_after: structuredClone(reference.mount_after),
    container_before: check('prepared', 0), container_after: check('final', 45),
    shards: expected.matrix.filter(row => row.groups === 'browser').map(row => ({ name: row.name, before: check(row.name + ':before', 10), after: check(row.name + ':after', 24) })) };
}
function syntheticDependencies(id) {
  const old = pinnedInputs().locks[id], candidate = fixtureCandidateLockBytes();
  const closure = historicalDependencyClosure(JSON.parse(old), JSON.parse(candidate), { platform: 'linux', arch: 'x64' });
  return { schema: 'pr-gate-historical-dependency-bytes-v1', installed: false, network_requests: 0, workspace_links_changed: false,
    locks: { old: old.toString('base64'), candidate: candidate.toString('base64') }, old_lock_sha256: historicalHash(old), candidate_lock_sha256: historicalHash(candidate),
    packages: closure.packages.map(row => ({ ...row, actual_root: '/workspace/' + row.path, cache_sri_verified: true, files: 1, files_sha256: historicalHash('synthetic-package-record:' + row.path) })),
    excluded_platform_packages: closure.excluded_platform_packages };
}
function syntheticQaAliases() {
  const value = loads => ({ schema: 'pr-gate-qa-baseline-aliases-v1', source: syntheticQaBaselineIdentity(), application_root: QA_HISTORICAL_APP_ROOT,
    aliases: qaBaselineAliasesForApp(QA_HISTORICAL_APP_ROOT).map(alias => ({ ...alias, loads, requests: loads })) });
  return { before: value(0), after: value(1) };
}
function syntheticQaCollector(plan, compiler) {
  const paths = qaCollectorPaths(plan), compiledHash = compiler.output_files.find(row => row.path === 'index.js').sha256;
  const cases = [
    ['tests/qa-single-start-baseline.spec.ts', '@playwright/test', '@playwright/test', 'index.js', 'index.mjs'],
    ['tests/project-qa-continuation-fixtures.ts', '@playwright/test', '@playwright/test', 'index.js', 'index.mjs'],
    ['tests/project-qa-continuation-fixtures.ts', '@bondbuddy/contracts', '@bondbuddy/contracts', 'dist/index.js', 'dist/index.js'],
    ['tests/project-qa-continuation-fixtures.ts', '@sinclair/typebox', '@sinclair/typebox', 'build/cjs/index.js', 'build/esm/index.mjs'],
    ['tests/project-qa-continuation-fixtures.ts', '@sinclair/typebox/value', '@sinclair/typebox', 'build/cjs/value/index.js', 'build/esm/value/index.mjs'],
    ['playwright.config.ts', '@playwright/test', '@playwright/test', 'index.js', 'index.mjs'],
    ['playwright.config.ts', '@playwright/test/cli', '@playwright/test', 'cli.js', 'cli.js'],
    ['compiled', '@sinclair/typebox', '@sinclair/typebox', 'build/cjs/index.js', 'build/esm/index.mjs'],
  ];
  const resolutions = cases.map(([origin, specifier, name, requireFile, importFile]) => {
    const package_root = name === '@bondbuddy/contracts' ? paths.runtimeRoot + '/contracts' : '/workspace/node_modules/' + name;
    const hashFor = file => name === '@bondbuddy/contracts' ? compiledHash : historicalHash('synthetic-resolved-module:' + name + '/' + file);
    return { from: origin === 'compiled' ? compiler.output_root + '/index.js' : paths.cwd + '/' + origin, specifier, package_root,
      require_path: package_root + '/' + requireFile, import_path: package_root + '/' + importFile, require_sha256: hashFor(requireFile), import_sha256: hashFor(importFile) };
  });
  const copies = QA_COLLECTOR_FILES.map(row => ({ ...row, destination: paths.collectorRoot + '/' + row.path }));
  return { schema: 'pr-gate-qa-collector-v1', candidate: { commit: plan.commit, tree: plan.tree }, run_id: plan.run_id, shard: plan.shard, test_id: QA_COLLECTOR_TEST,
    source: QA_COLLECTOR_SOURCE, source_root: paths.sourceRoot, runtime_root: paths.runtimeRoot, cwd: paths.cwd,
    command: '/usr/local/bin/node', args: ['/workspace/node_modules/@playwright/test/cli.js', 'test', 'tests/qa-single-start-baseline.spec.ts', '--reporter=line,json'],
    source_rewrites: 0, installs: 0, screenshots_initially_absent: true, source_files: QA_COLLECTOR_FILES, copies_before: copies, copies_after: structuredClone(copies),
    private_links: [{ path: paths.cwd + '/node_modules/@bondbuddy/contracts', target: paths.runtimeRoot + '/contracts' },
      ...['@playwright/test', '@sinclair/typebox'].map(name => ({ path: paths.cwd + '/node_modules/' + name, target: '/workspace/node_modules/' + name }))],
    resolution_method: 'createRequire.resolve plus pinned conditional exports; not actual module-load evidence', resolutions_before: resolutions,
    resolutions_after: structuredClone(resolutions), verification_after: { status: 'passed' } };
}
export function syntheticQaScreenshots(plan) {
  const paths = qaCollectorPaths(plan), files = QA_SCREENSHOTS.map(name => ({ name, original_path: paths.screenshotRoot + '/' + name,
    archive_path: paths.screenshotArchive + '/' + name, bytes: 100, sha256: historicalHash('synthetic-screenshot:' + name), valid_png: true }));
  return { schema: 'pr-gate-qa-screenshots-v1', run_id: plan.run_id, shard: plan.shard, source_root: paths.screenshotRoot, archive_root: paths.screenshotArchive,
    png_check: 'signature, chunk bounds/CRC, IHDR and terminal IEND; no pixel decoding', status: 'passed', files, missing: [], errors: [], manifest_sha256: historicalHash({ files, missing: [], errors: [] }) };
}
export function syntheticHistoricalApplication(id, plan, capabilities) {
  const source = structuredClone(pinnedInputs().record.sources[id]), collector = HISTORICAL_COLLECTORS[id], dependencies = syntheticDependencies(id);
  const root = HISTORICAL_ROOT + '/' + id, runtime = `/tmp/pr-gate-historical/${plan.run_id}/${plan.shard}/${id}`;
  const names = source.files.map(row => row.path).filter(path => path.startsWith('packages/contracts/src/') && path.endsWith('.ts') && !path.endsWith('.d.ts')).map(path => path.slice('packages/contracts/src/'.length, -3));
  const compiler = { command: '/usr/local/bin/node', args: ['/workspace/node_modules/typescript/lib/tsc.js', '-p', root + '/packages/contracts/tsconfig.json', '--outDir', runtime + '/contracts/dist', '--baseUrl', runtime + '/node_modules', '--typeRoots', runtime + '/node_modules/@types'],
    exit_code: 0, started_at: stamp(11), finished_at: stamp(12), timeout_ms: 1000, old_contracts_tree: HISTORICAL_SOURCES[id].objects['packages/contracts'], output_root: runtime + '/contracts/dist',
    output_files: names.flatMap(name => [name + '.js', name + '.d.ts']).sort((a, b) => a.localeCompare(b)).map(path => ({ path, bytes: 42, sha256: historicalHash('synthetic-compiler-output:' + id + '/' + path) })) };
  const main = source.files.find(row => row.path === 'apps/web/src/main.ts'), config = source.files.find(row => row.path === 'apps/web/vite.config.ts'), index = compiler.output_files.find(row => row.path === 'index.js');
  return { schema: 'pr-gate-historical-app-runtime-v1', id, test_id: collector.test_id, origin: collector.origin, flag: collector.flag,
    candidate: { commit: plan.commit, tree: plan.tree }, run_id: plan.run_id, shard: plan.shard, pid: 100, model_calls: 0, not_a_seal: true,
    source_root: root, runtime_root: runtime, source_before: source, source_after: structuredClone(source), dependencies_before: dependencies, dependencies_after: structuredClone(dependencies),
    started_at: stamp(11), prepared_at: stamp(12), finished_at: stamp(23), status: 'prepared', alive_before_cleanup: true, listening_after_cleanup: false, cleanup: { status: 'passed', errors: [] }, compiler,
    config: { original_loaded: true, source_rewrites: 0, original_path: root + '/apps/web/vite.config.ts', original_sha256: config.sha256, emitted_sha256: config.sha256,
      overrides: { host: '127.0.0.1', port: Number(new URL(collector.origin).port), cache: runtime + '/vite-cache', api: 'blocked-before-proxy', envFile: false } }, blocked_api_requests: [],
    probe: { status: 'passed', origin: collector.origin, tls_verified: true, ca_sha256: capabilities.tls.ca_sha256, html_sha256: historicalHash('synthetic-historical-html'), main_response_sha256: historicalHash('synthetic-main-response'), source_path: main.path, source_sha256: main.sha256 },
    source_loads: [{ path: main.path, blob: main.blob, sha256: main.sha256, loads: 1 }, { path: 'compiled-contracts/index.js', sha256: index.sha256, loads: 1 }],
    resolutions: [{ specifier: '@bondbuddy/contracts', path: compiler.output_root + '/index.js', old_contracts_tree: compiler.old_contracts_tree }],
    ...(id === 'qa' ? { qa_baseline: { application_source: HISTORICAL_SOURCES.qa, component_source: QA_BASELINE_SOURCE,
      composition: 'original-5839177-collector-app-with-explicit-5ec099a-component-aliases', ...syntheticQaAliases() }, collector: syntheticQaCollector(plan, compiler) } : {}) };
}
