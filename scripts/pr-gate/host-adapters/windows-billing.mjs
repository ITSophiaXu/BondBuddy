import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const BILLING_TEST = 'scripts/billing-functional/panel-session.test.mjs';
export const BILLING_PROFILE = 'windows-billing';
const HASH = /^[a-f0-9]{40}$/;
const MAX_OUTPUT = 8 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const normalize = value => value.replaceAll('\r\n', '\n');
const pause = ms => new Promise(done => setTimeout(done, ms));

export function validateBillingRequest({ candidate, runId, entry }) {
  assert.ok(HASH.test(candidate?.commit) && HASH.test(candidate?.tree), 'Exact candidate commit/tree required');
  assert.match(runId ?? '', /^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/, 'Invalid gate run ID');
  assert.equal(entry?.profileId, BILLING_PROFILE);
  assert.equal(entry?.testId, BILLING_TEST, 'Billing adapter accepts one exact test');
  assert.equal(entry.runPath, BILLING_TEST);
  assert.equal(entry.runner, 'node');
  assert.equal(entry.shard, 'misc');
  assert.ok(Number.isSafeInteger(entry.sequence) && entry.sequence >= 0);
  assert.ok(Number.isSafeInteger(entry.fileTimeoutMs) && entry.fileTimeoutMs > 0 && entry.fileTimeoutMs <= 300000, 'Original gate file budget must not increase');
  for (const key of ['args', 'argv', 'env', 'command', 'cwd', 'executable']) assert.equal(Object.hasOwn(entry, key), false, 'Entry must not carry commands or environment');
}

export function billingHostEnvironment(input = process.env) {
  const keep = /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|HOMEDRIVE|HOMEPATH|USERNAME|OS|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i;
  return { ...Object.fromEntries(Object.entries(input).filter(([key]) => keep.test(key))), NODE_ENV: 'test', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' };
}

export function validateBillingDockerEndpoint(endpoint) {
  assert.match(endpoint, /^npipe:\/{4}\.\/pipe\/[a-zA-Z0-9_.-]+$/, 'Only the current local Windows Docker pipe is accepted');
}

export function unusedBillingSubnet(prefixes) {
  const range = cidr => {
    assert.match(cidr, /^(\d+\.){3}\d+\/\d+$/);
    const [ip, rawBits] = cidr.split('/'), bits = Number(rawBits), octets = ip.split('.').map(Number);
    assert.ok(bits >= 0 && bits <= 32 && octets.every(n => n >= 0 && n <= 255));
    const shift = BigInt(32 - bits), n = octets.reduce((value, part) => value * 256n + BigInt(part), 0n), low = n >> shift << shift;
    return [low, low + (1n << shift) - 1n];
  };
  // The host's default route describes Internet routing, not an allocated private subnet.
  const used = prefixes.filter(p => !p.endsWith('/0')).map(range);
  for (let i = 0; i < 256; i++) {
    const subnet = `10.238.${i}.0/24`, [low, high] = range(subnet);
    if (used.every(([a, b]) => high < a || low > b)) return subnet;
  }
  throw new Error('No unused task subnet; host routing remains unchanged');
}

function within(root, path) {
  const rel = relative(realpathSync(root), realpathSync(path));
  assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep), 'Path escapes owned source');
}
function git(root, args, env, binary = false) {
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], { cwd: root, env, encoding: binary ? undefined : 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Candidate Git check failed: ' + (result.error?.message ?? result.stderr));
  return binary ? result.stdout : result.stdout.trim();
}

/** Compare raw checked-out bytes, not Git's CRLF-normalized status alone. */
export function verifyBillingSource(root, candidate, env = billingHostEnvironment()) {
  assert.equal(git(root, ['rev-parse', 'HEAD'], env), candidate.commit);
  assert.equal(git(root, ['rev-parse', 'HEAD^{tree}'], env), candidate.tree);
  assert.equal(git(root, ['status', '--porcelain', '--untracked-files=no'], env), '', 'Candidate source changed');
  const entries = git(root, ['ls-tree', '-r', '-z', candidate.commit], env, true).toString('utf8').split('\0').filter(Boolean);
  const manifest = [];
  for (const entry of entries) {
    const split = entry.indexOf('\t'), [mode, kind, expected] = entry.slice(0, split).split(' '), name = entry.slice(split + 1), file = join(root, name);
    assert.equal(kind, 'blob');
    assert.ok(mode === '100644' || mode === '100755', 'Billing host source must contain regular tracked files');
    assert.ok(!lstatSync(file).isSymbolicLink() && statSync(file).isFile()); within(root, file);
    const bytes = statSync(file).size, sha = createHash('sha1').update(`blob ${bytes}\0`), fd = openSync(file, 'r'), buffer = Buffer.allocUnsafe(1024 * 1024);
    try { for (;;) { const size = readSync(fd, buffer, 0, buffer.length, null); if (!size) break; sha.update(buffer.subarray(0, size)); } } finally { closeSync(fd); }
    assert.equal(sha.digest('hex'), expected, 'Candidate raw source differs: ' + name);
    manifest.push({ path: name, blob: expected, bytes });
  }
  return { files: manifest.length, manifest_sha256: digest(JSON.stringify(manifest)), raw_bytes_verified: true };
}

export function prepareBillingDependencies(sourceRoot, dependencyRoot) {
  const source = realpathSync(sourceRoot), cache = realpathSync(dependencyRoot);
  assert.notEqual(source, cache, 'Use an isolated host checkout, not the dependency cache');
  const lock = normalize(readFileSync(join(source, 'package-lock.json'), 'utf8'));
  assert.equal(lock, normalize(readFileSync(join(cache, 'package-lock.json'), 'utf8')), 'Dependency lock mismatch');
  const modules = join(source, 'node_modules'); mkdirSync(modules, { recursive: true });
  assert.ok(!lstatSync(modules).isSymbolicLink(), 'Top-level node_modules must be owned');
  const installed = join(cache, 'node_modules');
  for (const name of readdirSync(installed)) {
    if (name === '@bondbuddy' || name.startsWith('.')) continue;
    const from = join(installed, name), to = join(modules, name);
    if (!existsSync(to)) symlinkSync(from, to, 'junction');
    assert.equal(realpathSync(to), realpathSync(from), 'Unexpected installed dependency');
  }
  const hiddenLock = join(installed, '.package-lock.json');
  assert.ok(existsSync(hiddenLock), 'Existing installed dependency lock required');
  const copiedLock = join(modules, '.package-lock.json');
  if (!existsSync(copiedLock)) copyFileSync(hiddenLock, copiedLock);
  assert.deepEqual(readFileSync(copiedLock), readFileSync(hiddenLock));
  mkdirSync(join(modules, '@bondbuddy'), { recursive: true });
  assert.ok(!lstatSync(join(modules, '@bondbuddy')).isSymbolicLink());
  for (const path of JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).workspaces) {
    const target = join(source, path); within(source, target);
    const name = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name;
    assert.match(name, /^@bondbuddy\/[a-zA-Z0-9-]+$/);
    const link = join(modules, name); if (!existsSync(link)) symlinkSync(target, link, 'junction');
    assert.equal(realpathSync(link), realpathSync(target), 'Workspace dependency points outside current candidate');
  }
  const viteTemp = join(modules, '.vite-temp'); if (!existsSync(viteTemp)) mkdirSync(viteTemp);
  assert.ok(!lstatSync(viteTemp).isSymbolicLink()); within(source, viteTemp);
  return { normalized_lock_sha256: digest(lock), installed_lock_sha256: digest(readFileSync(hiddenLock)), cache, installed: false, product_packages: 'current candidate only' };
}

export async function executeWindowsBilling(options) {
  validateBillingRequest(options);
  assert.equal(process.platform, 'win32', 'Billing test requires existing Windows Edge');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22);
  const { candidate, runId, entry, signal } = options;
  const source = realpathSync(options.sourceRoot), env = billingHostEnvironment();
  const out = resolve(options.evidenceRoot, 'windows-billing-' + entry.sequence);
  assert.ok(existsSync(options.evidenceRoot) && !lstatSync(options.evidenceRoot).isSymbolicLink(), 'Fresh host-owned evidence parent required');
  mkdirSync(out, { recursive: false });
  const evidence = { profile_id: BILLING_PROFILE, ...candidate, run_id: runId, test_id: BILLING_TEST,
    started_at: new Date().toISOString(), finished_at: null, commands: [], resources: [], cleanup: { status: 'pending' }, scope: 'real local Web/API/PG and Edge; synthetic payment; no model worker or production' };
  let execution, failure, pg, network, volume, serviceStarted = false, dockerContext;
  const save = () => writeFileSync(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  save();
  const command = async (label, executable, args, { cwd = source, timeout = 300000, cleanup = false } = {}) => {
    if (signal?.aborted && !cleanup) throw new Error('Gate cancelled before ' + label);
    const start = Date.now(), chunks = { stdout: [], stderr: [] }; let child, timedOut = false, cancelled = false, spawnError, bytes = 0;
    const kill = () => { if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { env, windowsHide: true, stdio: 'ignore' }); };
    const abort = () => { cancelled = true; kill(); };
    const result = await new Promise(done => {
      child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
      if (!cleanup) { signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); }
      for (const stream of ['stdout', 'stderr']) child[stream].on('data', data => {
        bytes += data.length;
        if (bytes <= MAX_OUTPUT) chunks[stream].push(data); else { spawnError ??= new Error('Command output exceeded original gate limit'); kill(); }
      });
      child.once('error', error => { spawnError = error; });
      child.once('close', (code, childSignal) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); done({ code, signal: childSignal }); });
    });
    const stdout = Buffer.concat(chunks.stdout).toString('utf8'), stderr = Buffer.concat(chunks.stderr).toString('utf8'), durationMs = Date.now() - start;
    writeFileSync(join(out, label + '.stdout.log'), stdout); writeFileSync(join(out, label + '.stderr.log'), stderr);
    evidence.commands.push({ label, executable, args, cwd, started_at: new Date(start).toISOString(), durationMs, ...result, timedOut, cancelled, stdout_sha256: digest(stdout), stderr_sha256: digest(stderr) }); save();
    if (spawnError) throw spawnError;
    if (cancelled) throw new Error('Gate cancelled during ' + label);
    return { ...result, timedOut, stdout, stderr, durationMs };
  };
  const must = async (label, executable, args, opts) => { const result = await command(label, executable, args, opts); assert.equal(result.code, 0, label + ' failed'); assert.equal(result.timedOut, false, label + ' timed out'); return result.stdout.trim(); };
  const node = (label, args, opts) => must(label, process.execPath, args, opts);
  const docker = (label, args, opts) => must(label, 'docker', ['--context', dockerContext, ...args], opts);
  const runtime = join(source, 'scripts/billing-functional/.runtime');
  try {
    evidence.source_before = verifyBillingSource(source, candidate, env);
    assert.ok(!existsSync(runtime) || readdirSync(runtime).length === 0, 'Fresh billing runtime required; do not adopt an earlier account or ledger');
    evidence.dependencies = prepareBillingDependencies(source, options.dependencyRoot); save();
    for (const port of [5189, 3089, 55432]) await new Promise((done, reject) => { const server = createServer(); server.once('error', reject); server.listen(port, '127.0.0.1', () => server.close(done)); });
    for (const pkg of ['contracts', 'domain', 'rule-pack-registry', 'rule-applicability-context']) await node('build-' + pkg, ['node_modules/typescript/bin/tsc', '-p', 'packages/' + pkg + '/tsconfig.json']);
    await node('build-api', ['node_modules/typescript/bin/tsc', '-p', 'apps/api/tsconfig.json']);
    await node('check-web', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/web/tsconfig.json']);
    await node('build-web', [join(source, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: join(source, 'apps/web') });
    dockerContext = await must('docker-context-name', 'docker', ['context', 'show']);
    const endpoint = await docker('docker-endpoint', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
    validateBillingDockerEndpoint(endpoint);
    assert.equal(await docker('docker-platform', ['info', '--format', '{{.OSType}}']), 'linux');
    const image = await docker('postgres-image', ['image', 'inspect', 'postgres:16.10', '--format', '{{.Id}}']); assert.match(image, /^sha256:[a-f0-9]{64}$/);
    const ids = (await docker('network-list', ['network', 'ls', '-q'])).split(/\s+/).filter(Boolean);
    const networks = ids.length ? JSON.parse(await docker('network-inventory', ['network', 'inspect', ...ids])) : [];
    const routes = JSON.parse(await must('host-route-inventory', 'powershell.exe', ['-NoProfile', '-Command', 'Get-NetRoute -AddressFamily IPv4 -ErrorAction Stop | Select-Object -ExpandProperty DestinationPrefix | ConvertTo-Json -Compress']));
    const subnet = unusedBillingSubnet([...networks.flatMap(n => (n.IPAM.Config ?? []).map(c => c.Subnet)), ...[routes].flat()].filter(x => typeof x === 'string' && /^(\d+\.){3}\d+\/\d+$/.test(x)));
    evidence.network = { subnet, host_routes_changed: false, host_binding: '127.0.0.1:55432' };
    const name = 'bb-pr-gate-billing-' + runId + '-' + entry.sequence, label = 'bondbuddy.pr-gate.run=' + runId;
    network = await docker('network-create', ['network', 'create', '--subnet', subnet, '--label', label, name]);
    evidence.resources.push({ kind: 'network', id: network, name }); save();
    volume = await docker('volume-create', ['volume', 'create', '--label', label, name + '-data']);
    evidence.resources.push({ kind: 'volume', id: volume, retained: true }); save();
    pg = await docker('postgres-create', ['create', '--pull', 'never', '--name', name + '-pg', '--label', label, '--network', network, '--cpus', '0.5', '--memory', '512m', '--pids-limit', '128', '-p', '127.0.0.1:55432:5432', '--mount', 'type=volume,source=' + volume + ',target=/var/lib/postgresql/data', '-e', 'POSTGRES_USER=bondbuddy', '-e', 'POSTGRES_PASSWORD=m3-local-synthetic', '-e', 'POSTGRES_DB=postgres', image]);
    assert.match(pg, /^[a-f0-9]{64}$/); evidence.resources.push({ kind: 'container', id: pg, image }); save();
    await docker('postgres-start', ['start', pg]);
    let ready = false;
    for (let i = 0; i < 30; i++) { const probe = await command('pg-ready-' + i, 'docker', ['--context', dockerContext, 'exec', pg, 'pg_isready', '-U', 'bondbuddy', '-d', 'postgres'], { timeout: 10000 }); if (probe.code === 0) { ready = true; break; } await pause(1000); }
    assert.ok(ready, 'Owned PostgreSQL did not become ready');
    const bound = JSON.parse(await docker('postgres-inspect', ['inspect', pg]))[0].NetworkSettings.Ports;
    assert.deepEqual(bound['5432/tcp'], [{ HostIp: '127.0.0.1', HostPort: '55432' }]);
    await node('pg-host-probe', ['--input-type=module', '-e', "import pg from 'pg';const c=new pg.Client({connectionString:'postgresql://bondbuddy:m3-local-synthetic@127.0.0.1:55432/postgres',connectionTimeoutMillis:5000});await c.connect();try{if((await c.query('SELECT current_database() db')).rows[0].db!=='postgres')throw Error('wrong DB');console.log('Native Windows loopback PostgreSQL passed');}finally{await c.end();}"], { timeout: 15000 });
    serviceStarted = true;
    await node('billing-start', ['scripts/billing-functional/start.mjs'], { timeout: 90000 });
    // The test itself retains its original 90-second deadline. No retries or grep.
    execution = await command('billing-test', process.execPath, ['--test', '--test-reporter=tap', BILLING_TEST], { timeout: entry.fileTimeoutMs });
  } catch (error) { failure = error; }
  finally {
    const cleanupErrors = [], statePath = join(runtime, 'state.json');
    const attempt = async task => { try { await task(); } catch (error) { cleanupErrors.push(error.message); } };
    if (serviceStarted && existsSync(statePath)) await attempt(async () => {
      await node('billing-stop', ['scripts/billing-functional/stop.mjs'], { timeout: 30000, cleanup: true });
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.ok(Number.isSafeInteger(state.pid) && state.pid > 0);
      let alive = true; for (let i = 0; i < 40; i++) { try { process.kill(state.pid, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; break; } await pause(250); }
      assert.equal(alive, false, 'Owned billing service did not exit; do not stop its database');
    });
    if (serviceStarted && !existsSync(statePath)) await attempt(async () => {
      for (const port of [5189, 3089]) await new Promise((done, reject) => { const server = createServer(); server.once('error', () => reject(new Error('Billing port occupied without owned state; database retained'))); server.listen(port, '127.0.0.1', () => server.close(done)); });
    });
    // A failed service stop keeps its database available, and makes the gate fail.
    if (pg && cleanupErrors.length === 0) await attempt(async () => {
      const current = JSON.parse(await docker('cleanup-pg-identity', ['inspect', pg], { cleanup: true }))[0];
      assert.equal(current.Id, pg); assert.equal(current.Config.Labels['bondbuddy.pr-gate.run'], runId);
      await docker('cleanup-pg-stop', ['stop', pg], { cleanup: true });
      await docker('cleanup-pg-remove', ['rm', pg], { cleanup: true });
      const absent = await command('cleanup-pg-absent', 'docker', ['--context', dockerContext, 'inspect', pg], { cleanup: true });
      assert.ok(absent.code !== 0 && /no such (object|container)/i.test(absent.stderr));
    });
    if (network && cleanupErrors.length === 0) await attempt(async () => {
      const current = JSON.parse(await docker('cleanup-network-identity', ['network', 'inspect', network], { cleanup: true }))[0];
      assert.equal(current.Id, network); assert.equal(current.Labels['bondbuddy.pr-gate.run'], runId); assert.equal(Object.keys(current.Containers ?? {}).length, 0);
      await docker('cleanup-network-remove', ['network', 'rm', network], { cleanup: true });
      const absent = await command('cleanup-network-absent', 'docker', ['--context', dockerContext, 'network', 'inspect', network], { cleanup: true });
      assert.ok(absent.code !== 0 && /no such (object|network)|not found/i.test(absent.stderr));
    });
    await attempt(async () => { evidence.source_after = verifyBillingSource(source, candidate, env); assert.deepEqual(evidence.source_after, evidence.source_before); });
    evidence.cleanup = { status: cleanupErrors.length ? 'failed' : 'passed', errors: cleanupErrors, retained_volume: volume ?? null, retained_runtime: runtime };
    evidence.finished_at = new Date().toISOString(); save();
    if (cleanupErrors.length) failure = new Error([failure?.message, ...cleanupErrors].filter(Boolean).join('; '));
  }
  if (failure) { failure.evidence = evidence; failure.execution = execution; throw failure; }
  return { execution, evidence };
}
