import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HISTORICAL_ROOT, HISTORICAL_SOURCES, historicalHash, verifyHistoricalDirectory } from './browser-historical-source.mjs';
import { dependencyRootForFile, historicalDependencyClosure, verifyHistoricalDependencies } from './browser-historical-dependencies.mjs';
import { HISTORICAL_COLLECTORS } from './browser-dispatch.mjs';

const inside = (parent, path) => path === parent || path.startsWith(parent + '/');
export const historicalRemaining = deadline => { const ms = deadline - Date.now(); assert.ok(Number.isSafeInteger(ms) && ms > 0, 'Original browser shard deadline exhausted'); return ms; };
function outputFiles(directory, base = directory) {
  const rows = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) { assert.ok(!entry.isSymbolicLink()); const path = join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...outputFiles(path, base)); else { const bytes = readFileSync(path); rows.push({ path: relative(base, path).replaceAll('\\', '/'), sha256: historicalHash(bytes), bytes: bytes.length }); } }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
function addPrivateLinks(runtime, dependencies) {
  for (const row of dependencies.packages.filter(row => !row.path.slice('node_modules/'.length).includes('/node_modules/'))) {
    const path = join(runtime, row.path); mkdirSync(dirname(path), { recursive: true }); symlinkSync(row.actual_root, path, 'dir');
  }
}
/** Complete old application, original config and contracts; only writable build/cache is new. */
export async function startHistoricalApplication({ id, plan, deadline, httpsRead, requireStarting }) {
  const collector = HISTORICAL_COLLECTORS[id]; assert.ok(collector); historicalRemaining(deadline); requireStarting();
  const sourceProof = verifyHistoricalDirectory(), source = sourceProof.sources[id], root = join(HISTORICAL_ROOT, id);
  const runtime = `/tmp/pr-gate-historical/${plan.run_id}/${plan.shard}/${id}`; assert.equal(existsSync(runtime), false, 'Historical runtime is not fresh'); mkdirSync(runtime, { recursive: true });
  const evidence = { schema: 'pr-gate-historical-app-runtime-v1', id, test_id: collector.test_id, origin: collector.origin, flag: collector.flag,
    candidate: { commit: plan.commit, tree: plan.tree }, run_id: plan.run_id, shard: plan.shard, pid: process.pid, model_calls: 0,
    not_a_seal: true, source_root: root, runtime_root: runtime, source_before: source, started_at: new Date().toISOString(), status: 'failed', cleanup: { status: 'pending' } };
  let server;
  const loads = new Map(), resolutions = new Map(), blockedApi = [];
  const snapshot = () => { evidence.source_loads = [...loads.values()].sort((a, b) => a.path.localeCompare(b.path)); evidence.resolutions = [...resolutions.values()].sort((a, b) => a.specifier.localeCompare(b.specifier)); evidence.blocked_api_requests = [...blockedApi]; return evidence; };
  const cleanup = async () => {
    const errors = []; evidence.alive_before_cleanup = server?.httpServer?.listening === true;
    try { await server?.close(); } catch (error) { errors.push(error.message); }
    try { evidence.source_after = verifyHistoricalDirectory().sources[id]; assert.deepEqual(evidence.source_after, evidence.source_before); } catch (error) { errors.push(error.message); }
    try { evidence.dependencies_after = verifyHistoricalDependencies(root); assert.deepEqual(evidence.dependencies_after, evidence.dependencies_before); } catch (error) { errors.push(error.message); }
    try { assert.deepEqual(outputFiles(join(runtime, 'contracts/dist')), evidence.compiler.output_files, 'Historical contracts outputs changed during original collector'); } catch (error) { errors.push(error.message); }
    if (blockedApi.length) errors.push('Historical collector attempted unmocked API access');
    if (evidence.status === 'prepared' && !evidence.alive_before_cleanup) errors.push('Historical app exited before cleanup');
    snapshot(); evidence.finished_at = new Date().toISOString(); evidence.cleanup = { status: errors.length ? 'failed' : 'passed', errors };
    if (errors.length) { const error = Error(errors.join('; ')); error.historicalEvidence = evidence; throw error; } return evidence;
  };
  try {
    evidence.dependencies_before = verifyHistoricalDependencies(root); historicalRemaining(deadline); requireStarting();
    addPrivateLinks(runtime, evidence.dependencies_before);
    writeFileSync(join(runtime, 'package.json'), '{"type":"module"}\n', { flag: 'wx' });
    const resolver = createRequire(join(runtime, 'resolver.cjs'));
    const tsPath = resolver.resolve('typescript'); dependencyRootForFile(tsPath, evidence.dependencies_before);
    const ts = (await import(pathToFileURL(tsPath))).default;
    const tsc = join(dirname(tsPath), 'tsc.js'); dependencyRootForFile(tsc, evidence.dependencies_before);
    const contracts = join(runtime, 'contracts'); mkdirSync(contracts); writeFileSync(join(contracts, 'package.json'), readFileSync(join(root, 'packages/contracts/package.json')), { flag: 'wx' });
    const command = [tsc, '-p', join(root, 'packages/contracts/tsconfig.json'), '--outDir', join(contracts, 'dist'), '--baseUrl', join(runtime, 'node_modules'), '--typeRoots', join(runtime, 'node_modules/@types')];
    const started_at = new Date().toISOString(), timeout_ms = historicalRemaining(deadline);
    const compiled = spawnSync(process.execPath, command, { cwd: root, env: process.env, encoding: 'utf8', timeout: timeout_ms, maxBuffer: 8 * 1024 * 1024 });
    evidence.compiler = { command: process.execPath, args: command, started_at, finished_at: new Date().toISOString(), timeout_ms, exit_code: compiled.status,
      old_contracts_tree: HISTORICAL_SOURCES[id].objects['packages/contracts'], output_root: join(contracts, 'dist'), stdout: compiled.stdout, stderr: compiled.stderr };
    assert.ifError(compiled.error); assert.equal(compiled.status, 0, 'Exact historical contracts did not compile');
    evidence.compiler.output_files = outputFiles(join(contracts, 'dist')); assert.ok(evidence.compiler.output_files.some(row => row.path === 'index.js'));
    historicalRemaining(deadline); requireStarting();
    const configSource = readFileSync(join(root, 'apps/web/vite.config.ts'), 'utf8');
    const syntax = ts.createSourceFile('vite.config.ts', configSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); assert.equal(syntax.parseDiagnostics.length, 0);
    assert.deepEqual(syntax.statements.filter(ts.isImportDeclaration).map(row => row.moduleSpecifier.text).sort(), ['node:fs', 'vite']);
    // These two pinned configs are valid JavaScript: load an exact byte copy,
    // not a re-created config or a transpiler's semantically similar output.
    const configBytes = readFileSync(join(root, 'apps/web/vite.config.ts')); assert.deepEqual(Buffer.from(configSource), configBytes);
    const configPath = join(runtime, 'vite.config.mjs'); writeFileSync(configPath, configBytes, { flag: 'wx' });
    const originalConfig = (await import(pathToFileURL(configPath))).default; assert.equal(originalConfig.server.port, 5173); assert.equal(originalConfig.server.strictPort, true);
    const vitePath = resolver.resolve('vite'); dependencyRootForFile(vitePath, evidence.dependencies_before); const { createServer } = await import(pathToFileURL(vitePath));
    evidence.config = { original_path: join(root, 'apps/web/vite.config.ts'), original_sha256: historicalHash(Buffer.from(configSource)), emitted_sha256: historicalHash(readFileSync(configPath)),
      original_loaded: true, source_rewrites: 0, overrides: { host: '127.0.0.1', port: Number(new URL(collector.origin).port), cache: join(runtime, 'vite-cache'), api: 'blocked-before-proxy', envFile: false } };
    const contractsEntry = join(contracts, 'dist/index.js');
    const plugin = { name: 'pr-gate-complete-historical-app', enforce: 'pre',
      configureServer(vite) { vite.middlewares.use((request, response, next) => {
        if (/^\/api(?:\/|\?|$)/.test(request.url ?? '')) { blockedApi.push({ path: request.url, method: request.method }); response.statusCode = 503; response.end('Historical collector has no backend'); return; } next();
      }); },
      async resolveId(specifier) {
        if (specifier === '@bondbuddy/contracts') { resolutions.set(specifier, { specifier, path: contractsEntry, old_contracts_tree: evidence.compiler.old_contracts_tree }); return contractsEntry; }
        if (specifier.startsWith('@bondbuddy/')) throw Error('Unexpected historical workspace dependency: ' + specifier);
        if (/^(?:[a-zA-Z][\w.-]*|@[\w.-]+\/[\w.-]+)(?:\/[^?]*)?$/.test(specifier) && !specifier.startsWith('node:')) {
          const resolved = await this.resolve(specifier, join(runtime, 'entry.mjs'), { skipSelf: true }); assert.ok(resolved && !resolved.external, 'Historical dependency did not resolve locally'); const path = resolved.id.split('?')[0]; dependencyRootForFile(path, evidence.dependencies_before); resolutions.set(specifier, { specifier, path }); return resolved;
        } return null;
      },
      load(id) {
        const path = id.split('?')[0]; if (!isAbsolute(path) || !existsSync(path)) return null;
        const actual = realpathSync(path);
        if (inside(root, actual)) {
          const name = relative(root, actual).replaceAll('\\', '/'), pinned = source.files.find(row => row.path === name); assert.ok(pinned, 'Historical module is outside exact source closure');
          const bytes = readFileSync(actual); assert.equal(historicalHash(bytes), pinned.sha256); const previous = loads.get(name);
          loads.set(name, { path: name, blob: pinned.blob, sha256: pinned.sha256, loads: (previous?.loads ?? 0) + 1 });
        } else if (inside(join(contracts, 'dist'), actual)) {
          const name = relative(join(contracts, 'dist'), actual).replaceAll('\\', '/'), pinned = evidence.compiler.output_files.find(row => row.path === name); assert.ok(pinned); assert.equal(historicalHash(readFileSync(actual)), pinned.sha256);
          const key = 'compiled-contracts/' + name; loads.set(key, { path: key, sha256: pinned.sha256, loads: (loads.get(key)?.loads ?? 0) + 1 });
        } else if (!inside(join(runtime, 'vite-cache'), actual)) dependencyRootForFile(actual, evidence.dependencies_before);
        return null;
      },
    };
    // The pinned old config is loaded above, then only infrastructure is isolated.
    server = await createServer({ ...originalConfig, configFile: false, envFile: false, root: join(root, 'apps/web'), cacheDir: join(runtime, 'vite-cache'), plugins: [plugin],
      server: { ...originalConfig.server, host: '127.0.0.1', port: Number(new URL(collector.origin).port), strictPort: true,
        fs: { strict: true, allow: [root, runtime, ...evidence.dependencies_before.packages.map(row => row.actual_root)] } } });
    requireStarting(); historicalRemaining(deadline); await server.listen(); requireStarting();
    const ca = readFileSync(process.env.NODE_EXTRA_CA_CERTS), web = await httpsRead(collector.origin, ca), main = await httpsRead(collector.origin + '/src/main.ts', ca);
    assert.equal(web.status, 200); assert.match(web.body, /<html/i); assert.equal(main.status, 200); assert.ok(loads.get('apps/web/src/main.ts')?.loads > 0);
    evidence.probe = { status: 'passed', origin: collector.origin, tls_verified: true, ca_sha256: historicalHash(ca), html_sha256: historicalHash(web.body), main_response_sha256: historicalHash(main.body), source_path: 'apps/web/src/main.ts', source_sha256: source.files.find(row => row.path === 'apps/web/src/main.ts').sha256 };
    evidence.status = 'prepared'; evidence.prepared_at = new Date().toISOString(); snapshot(); return { evidence, cleanup, isAlive: () => server.httpServer?.listening === true };
  } catch (error) { evidence.error = error.message; try { await cleanup(); } catch { /* original startup failure remains blocking */ } error.historicalEvidence = snapshot(); throw error; }
}
export function verifyHistoricalApplication(value, { id, plan, source, caSha256, candidateLockSha256 }) {
  const collector = HISTORICAL_COLLECTORS[id]; assert.ok(collector); assert.equal(value?.schema, 'pr-gate-historical-app-runtime-v1');
  for (const [key, expected] of Object.entries({ id, test_id: collector.test_id, origin: collector.origin, flag: collector.flag, run_id: plan.run_id, shard: plan.shard, not_a_seal: true, model_calls: 0 })) assert.deepEqual(value[key], expected);
  assert.deepEqual(value.candidate, { commit: plan.commit, tree: plan.tree }); assert.equal(value.status, 'prepared'); assert.equal(value.cleanup?.status, 'passed'); assert.equal(value.alive_before_cleanup, true);
  assert.deepEqual(value.source_before, source); assert.deepEqual(value.source_after, source); assert.equal(value.source_root, HISTORICAL_ROOT + '/' + id);
  const runtime = `/tmp/pr-gate-historical/${plan.run_id}/${plan.shard}/${id}`; assert.equal(value.runtime_root, runtime);
  assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0);
  const deps = value.dependencies_before; assert.equal(deps?.schema, 'pr-gate-historical-dependency-bytes-v1'); assert.equal(deps.installed, false); assert.equal(deps.network_requests, 0); assert.equal(deps.workspace_links_changed, false);
  assert.deepEqual(value.dependencies_after, deps);
  const oldBytes = Buffer.from(deps.locks.old, 'base64'), candidateBytes = Buffer.from(deps.locks.candidate, 'base64');
  assert.equal(oldBytes.toString('base64'), deps.locks.old); assert.equal(candidateBytes.toString('base64'), deps.locks.candidate);
  assert.equal(historicalHash(oldBytes), deps.old_lock_sha256); assert.equal(historicalHash(candidateBytes), deps.candidate_lock_sha256); assert.equal(deps.candidate_lock_sha256, candidateLockSha256);
  const closure = historicalDependencyClosure(JSON.parse(oldBytes), JSON.parse(candidateBytes), { platform: 'linux', arch: 'x64' });
  assert.deepEqual(deps.packages.map(({ path, version, integrity, resolved }) => ({ path, version, integrity, resolved })), closure.packages); assert.deepEqual(deps.excluded_platform_packages, closure.excluded_platform_packages);
  assert.ok(deps.packages.length > 0); assert.equal(new Set(deps.packages.map(row => row.path)).size, deps.packages.length);
  for (const row of deps.packages) { assert.match(row.path, /^node_modules\//); assert.equal(row.actual_root, '/workspace/' + row.path); assert.equal(row.cache_sri_verified, true); assert.ok(row.files > 0); assert.match(row.files_sha256, /^[a-f0-9]{64}$/); assert.match(row.integrity, /^sha512-/); }
  assert.equal(deps.old_lock_sha256, source.files.find(row => row.path === 'package-lock.json').sha256); assert.match(deps.candidate_lock_sha256, /^[a-f0-9]{64}$/);
  const compiler = value.compiler; assert.equal(compiler.exit_code, 0); assert.equal(compiler.old_contracts_tree, HISTORICAL_SOURCES[id].objects['packages/contracts']); assert.equal(compiler.output_root, runtime + '/contracts/dist');
  assert.equal(compiler.command, '/usr/local/bin/node');
  assert.deepEqual(compiler.args, ['/workspace/node_modules/typescript/lib/tsc.js', '-p', value.source_root + '/packages/contracts/tsconfig.json', '--outDir', runtime + '/contracts/dist', '--baseUrl', runtime + '/node_modules', '--typeRoots', runtime + '/node_modules/@types']);
  const inputNames = source.files.map(row => row.path).filter(path => path.startsWith('packages/contracts/src/') && path.endsWith('.ts') && !path.endsWith('.d.ts')).map(path => path.slice('packages/contracts/src/'.length, -3));
  assert.deepEqual(compiler.output_files.map(row => row.path), inputNames.flatMap(name => [name + '.js', name + '.d.ts']).sort((a, b) => a.localeCompare(b)), 'Historical compiler outputs omit/add source files');
  for (const row of compiler.output_files) { assert.match(row.sha256, /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(row.bytes) && row.bytes > 0); }
  const start = Date.parse(compiler.started_at), end = Date.parse(compiler.finished_at); assert.ok(Number.isFinite(start) && end >= start && start >= Date.parse(value.started_at) && end <= Date.parse(value.prepared_at));
  assert.ok(Number.isSafeInteger(compiler.timeout_ms) && compiler.timeout_ms > 0 && compiler.timeout_ms <= 120_000 && end - start <= compiler.timeout_ms + 1000);
  assert.equal(value.config.original_loaded, true); assert.equal(value.config.source_rewrites, 0); assert.equal(value.config.original_sha256, source.files.find(row => row.path === 'apps/web/vite.config.ts').sha256);
  assert.equal(value.config.original_path, value.source_root + '/apps/web/vite.config.ts'); assert.equal(value.config.emitted_sha256, value.config.original_sha256);
  assert.deepEqual(value.config.overrides, { host: '127.0.0.1', port: Number(new URL(collector.origin).port), cache: runtime + '/vite-cache', api: 'blocked-before-proxy', envFile: false }); assert.deepEqual(value.blocked_api_requests, []);
  assert.equal(value.probe.status, 'passed'); assert.equal(value.probe.origin, collector.origin); assert.equal(value.probe.tls_verified, true); assert.equal(value.probe.ca_sha256, caSha256);
  assert.equal(value.probe.source_sha256, source.files.find(row => row.path === 'apps/web/src/main.ts').sha256);
  assert.equal(new Set(value.source_loads.map(row => row.path)).size, value.source_loads.length);
  for (const row of value.source_loads) { assert.ok(Number.isSafeInteger(row.loads) && row.loads > 0);
    if (row.path.startsWith('compiled-contracts/')) { const compiled = compiler.output_files.find(file => file.path === row.path.slice('compiled-contracts/'.length)); assert.ok(compiled); assert.equal(row.sha256, compiled.sha256); }
    else { const pinned = source.files.find(file => file.path === row.path); assert.ok(pinned); assert.equal(row.sha256, pinned.sha256); assert.equal(row.blob, pinned.blob); } }
  assert.equal(new Set(value.resolutions.map(row => row.specifier)).size, value.resolutions.length);
  for (const row of value.resolutions) if (row.specifier !== '@bondbuddy/contracts') { assert.ok(!row.specifier.startsWith('@bondbuddy/'));
    const pkg = deps.packages.filter(pkg => row.path.startsWith(pkg.actual_root + '/')).sort((a, b) => b.actual_root.length - a.actual_root.length)[0]; assert.ok(pkg);
    assert.ok(!row.path.split('/').includes('..') && !row.path.slice(pkg.actual_root.length + 1).split('/').includes('node_modules')); }
  const main = value.source_loads.find(row => row.path === 'apps/web/src/main.ts'); assert.ok(main?.loads > 0); assert.equal(main.sha256, value.probe.source_sha256);
  const contract = value.resolutions.find(row => row.specifier === '@bondbuddy/contracts'); assert.equal(contract?.path, runtime + '/contracts/dist/index.js'); assert.equal(contract.old_contracts_tree, compiler.old_contracts_tree);
  assert.ok(value.source_loads.some(row => row.path.startsWith('compiled-contracts/') && row.loads > 0), 'Historical app never loaded its own contracts');
  return value;
}
