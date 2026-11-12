#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { arch, release, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkflow } from './workflow.mjs';
import { exclusionsEvidence, verifyReceipt } from './receipt.mjs';
import { createParserArchive, restoreParserArchive } from './parser-source.mjs';
import { CAPABILITY_PATHS } from './capabilities.mjs';
import { CACHE_FILES, hash, inspectOfflineImage, inspectOfflineContainer, isolatedCommand, offlineImageArgument } from './offline-cache.mjs';
import { HOST_PROFILES } from './host-profiles.mjs';
import { createHostBroker, createHostPlan } from './host-dispatch.mjs';
import { collectCoreSource } from './core-source.mjs';
import { parseExclusions } from './run.mjs';
import { prepareBrowserServices } from './browser-host.mjs';
import { REFERENCE_ROOT, restoreReferenceSource, verifyReferenceDirectory, verifyReferenceMount, collectReferenceCheck } from './browser-reference-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, '.local/pr-gate');
const receiptPath = join(output, 'receipt.json');
const objectEnvironment = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' };
const git = args => {
  const result = spawnSync('git', ['--no-replace-objects', ...args], { cwd: root, env: objectEnvironment, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
};
const blob = (commit, path) => {
  const result = spawnSync('git', ['--no-replace-objects', 'show', `${commit}:${path}`], { cwd: root, env: objectEnvironment, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Cannot read ${path} at ${commit}`);
  return result.stdout;
};
const clean = () => git(['status', '--porcelain', '--untracked-files=normal']) === '';
const json = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;

/** Publish the active receipt last, after its per-run evidence is durable. */
export function persistReceipts(receipt, latestPath, archivePath, io = { writeFileSync, renameSync, rmSync }) {
  const paths = [archivePath, latestPath];
  const publish = path => {
    io.writeFileSync(`${path}.tmp`, `${JSON.stringify(receipt, null, 2)}\n`);
    io.renameSync(`${path}.tmp`, path);
  };
  try {
    // Invalidate even a previous pass before any write can fail. A missing
    // active receipt is safer than retaining evidence from an earlier attempt.
    io.rmSync(latestPath, { force: true });
    for (const path of paths) publish(path);
  } catch (error) {
    receipt.status = 'failed';
    receipt.errors.push(`Cannot save receipt: ${error.message}`);
    const recoveryErrors = [];
    // A failure publishing the active copy may follow a successful archive
    // write. Demote both copies; if a failed receipt cannot be written, remove
    // that copy rather than leaving a passing receipt available to verify.
    for (const path of paths) {
      try { publish(path); }
      catch (writeError) {
        try { io.rmSync(path, { force: true }); }
        catch (removeError) { recoveryErrors.push(`Cannot invalidate ${path}: ${removeError.message}`); }
        recoveryErrors.push(`Cannot write failed receipt ${path}: ${writeError.message}`);
      }
      try { io.rmSync(`${path}.tmp`, { force: true }); }
      catch (tempError) { recoveryErrors.push(`Cannot remove temporary receipt ${path}: ${tempError.message}`); }
    }
    throw new Error([`Cannot save receipt: ${error.message}`, ...recoveryErrors].join('; '));
  }
}

export function dependencySources(env) {
  const sources = {
    npm: env.PR_GATE_NPM_REGISTRY ?? env.npm_config_registry ?? 'https://registry.npmjs.org/',
    pip: env.PR_GATE_PIP_INDEX_URL ?? 'https://pypi.org/simple/',
  };
  for (const [name, raw] of Object.entries(sources)) {
    let url;
    try { url = new URL(raw); } catch { throw new Error(`Invalid ${name} dependency source`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error(`${name} dependency source must be HTTPS without credentials, query or fragment`);
    sources[name] = url.href;
  }
  return sources;
}

export async function cleanupContainers(containers, docker, cleanup = true) {
  const errors = [], removed = [];
  for (const { id, name } of containers) {
    try {
      if (!/^[a-f0-9]{64}$/.test(id ?? '') || !/^bb-pr-gate-[a-zA-Z0-9-]+$/.test(name ?? '')) throw new Error('Invalid owned container identity');
      const inspected = await docker('identify-' + name, ['inspect', '--format', '{{.Id}} {{.Name}}', id], { capture: true, cleanup });
      if (inspected.text !== id + ' /' + name) throw new Error('Owned container identity changed');
      await docker('remove-' + name, ['rm', '--force', '--volumes', id], { cleanup });
      const absent = await docker('absent-' + name, ['inspect', id], { capture: true, allowFailure: true, cleanup });
      if (absent.code === 0 || !/no such (object|container)/i.test(absent.text)) throw new Error('Cannot confirm owned container absence');
      removed.push(name);
    } catch (error) { errors.push(name + ': ' + error.message); }
  }
  if (errors.length) { const error = new Error(errors.join('; ')); error.removedContainers = removed; throw error; }
  return removed;
}

export function expectedFor(ref) {
  if (!ref || ref.startsWith('-')) throw new Error('Specify the commit to verify');
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`]);
  const develop_commit = git(['rev-parse', '--verify', 'origin/develop^{commit}']);
  if (git(['merge-base', commit, develop_commit]) !== develop_commit) throw new Error('Rebase onto the fetched origin/develop before running the gate');
  const exclusions = parseExclusions(JSON.parse(blob(commit, 'scripts/pr-gate/exclusions.json')));
  const browserFiles = git(['ls-tree', '-r', '--name-only', commit, '--', 'apps/web/tests']).split('\n')
    .filter(path => /^apps\/web\/tests\/[^/]+\.spec\.ts$/.test(path) && !exclusions.notInCi.some(entry => entry.expression.test(path))).sort();
  return { commit, tree: git(['rev-parse', `${commit}^{tree}`]), develop_commit,
    matrix: readWorkflow(blob(commit, '.github/workflows/pr-gate.yml').toString()).matrix,
    exclusions: exclusionsEvidence(blob(commit, 'scripts/pr-gate/exclusions.json')),
    cache_files: Object.fromEntries(CACHE_FILES.map(path => [path, hash(blob(commit, path))])),
    host_source_sha256: Object.fromEntries(Object.keys(HOST_PROFILES).map(path => [path, hash(blob(commit, path))])),
    browser_source_sha256: Object.fromEntries(browserFiles.map(path => [path, hash(blob(commit, path))])),
    source_verifier_sha256: hash(blob(commit, 'scripts/pr-gate/git-snapshot.mjs')),
    reference_verifier_sha256: hash(blob(commit, 'scripts/pr-gate/browser-reference-source.mjs')) };
}

export function localOptions(args) {
  const options = {}, offline = [];
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!['--offline-image', '--host-worker-image', '--host-dependency-root'].includes(key) || !value || Object.hasOwn(options, key)) throw new Error('Invalid or duplicate local gate option');
    options[key] = value;
    if (key === '--offline-image') offline.push(key, value);
  }
  const offlineImage = offlineImageArgument(offline), workerImage = options['--host-worker-image'] ?? null, dependencyRoot = options['--host-dependency-root'] ?? null;
  if (workerImage && !/^sha256:[a-f0-9]{64}$/.test(workerImage)) throw new Error('Host worker capability requires an immutable local image ID');
  if (dependencyRoot && !isAbsolute(dependencyRoot)) throw new Error('Host dependency root must be an absolute existing cache path');
  return { offlineImage, workerImage, dependencyRoot };
}

// Git for Windows can still reject paths longer than MAX_PATH even when Node
// accepts them. Keep this owned snapshot near the system temp root; do not
// change the host's registry, global Git settings or omit long tracked files.
export function hostSourceDirectory(base = tmpdir(), runId = randomUUID()) {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(runId)) throw new Error('Invalid host source run identity');
  const parent = realpathSync(base), owned = mkdtempSync(join(parent, 'bb-pg-'));
  const verify = () => {
    const stat = lstatSync(owned);
    if (!stat.isDirectory() || stat.isSymbolicLink() || dirname(owned) !== parent || realpathSync(owned) !== owned) throw new Error('Host source directory identity changed');
  };
  verify();
  writeFileSync(join(owned, 'owner.json'), JSON.stringify({ schema: 'pr-gate-host-source-v1', run_id: runId, pid: process.pid,
    parent, directory: owned, created_at: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
  verify();
  return join(owned, 'src');
}

async function run({ offlineImage = null, workerImage = null, dependencyRoot = null } = {}) {
  mkdirSync(output, { recursive: true });
  const lock = join(output, 'run.lock');
  try { mkdirSync(lock); } catch { throw new Error(`Another gate may be running. Inspect ${lock} before removing a stale lock.`); }
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const directory = join(output, 'runs', id);
  // Keep the historical source outside /evidence's writable bind mount.
  const parserDirectory = join(output, 'parser-sources', id);
  const referenceOwner = join(output, 'reference-sources', id);
  mkdirSync(directory, { recursive: true });
  const runner = `bb-pr-gate-${id}`;
  const postgres = `${runner}-pg`, azurite = `${runner}-blob`, httpsAzurite = `${runner}-https-blob`;
  const receipt = { schema_version: 'pr-gate-local-v1', status: 'failed', started_at: new Date().toISOString(), finished_at: null,
    commit: null, tree: null, develop_commit: null, clean_tree: false, platform: 'linux', host_platform: process.platform,
    dependency_mode: offlineImage ? 'offline-cache' : 'download',
    host_arch: arch(), host_release: release(), run_id: id, artifacts: `runs/${id}`, preparation: [], shards: [], merge: null, cleanup: { status: 'pending' }, errors: [] };
  const archiveReceiptPath = join(directory, 'receipt.json');
  try { persistReceipts(receipt, receiptPath, archiveReceiptPath); }
  catch (error) { rmSync(lock, { recursive: true }); throw error; }
  const save = () => {
    try { persistReceipts(receipt, receiptPath, archiveReceiptPath); }
    catch (error) { console.error(error.message); }
  };
  let currentChild, interrupted = false, dockerAvailable = false, expected, workflow, runtimeEnvironment, hostBroker, nativeRuntime, nativeAdapter;
  const owned = new Map();
  const serviceImages = {};
  const signal = () => { interrupted = true; currentChild?.kill('SIGTERM'); };
  process.on('SIGINT', signal); process.on('SIGTERM', signal);
  const command = (label, executable, args, { allowFailure = false, capture = false, cleanup = false, privateCapture = false } = {}) => new Promise((done, reject) => {
    if (interrupted && !cleanup) return reject(new Error('Gate interrupted'));
    console.log(`[pr-gate] ${label}`);
    const log = openSync(join(directory, `${label.replace(/[^a-zA-Z0-9_-]/g, '_')}.log`), 'a');
    const child = spawn(executable, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    currentChild = child;
    let text = '', spawnError;
    const receive = (data, stream) => {
      try { if (!privateCapture) writeFileSync(log, data); if (capture) text += data; else if (!privateCapture) stream.write(data); }
      catch (error) { spawnError ??= error; child.kill('SIGTERM'); }
    };
    child.stdout.on('data', data => receive(data, process.stdout));
    child.stderr.on('data', data => receive(data, process.stderr));
    child.on('error', error => { spawnError = error; });
    child.on('close', code => {
      closeSync(log); currentChild = null;
      if (spawnError || (code !== 0 && !allowFailure)) reject(new Error(`${label}: ${spawnError?.message ?? `exit ${code}`} (see ${directory})`));
      else done({ code, text: text.trim() });
    });
  });
  const docker = (label, args, options) => command(label, 'docker', args, options);
  const step = async (id, task) => {
    const record = { id, status: 'failed', started_at: new Date().toISOString() };
    receipt.preparation.push(record);
    try { await task(); record.status = 'passed'; }
    finally { record.finished_at = new Date().toISOString(); }
  };
  const envArgs = env => Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  const exec = (label, args, env = {}, options) => offlineImage
    ? docker(label, ['exec', runner, ...isolatedCommand(args, { ...runtimeEnvironment, ...env })], options)
    : docker(label, ['exec', ...envArgs(env), runner, ...args], options);
  const referenceCheck = (stage, cleanup = false) => collectReferenceCheck({ candidate: expected, runId: id,
    containerId: owned.get(runner).id, stage, verifierBytes: blob(expected.commit, 'scripts/pr-gate/browser-reference-source.mjs'),
    execute: (label, args) => docker(label, ['exec', owned.get(runner).id, ...isolatedCommand(args, runtimeEnvironment)], { capture: true, cleanup }) });
  const referenceMount = async (label, cleanup = false) => {
    const inspected = JSON.parse((await docker(label, ['inspect', owned.get(runner).id], { capture: true, privateCapture: true, cleanup })).text)[0];
    return verifyReferenceMount(inspected, receipt.reference_components.host_before.root, directory.replaceAll('\\', '/'), owned.get(runner).id);
  };
  const start = async (label, name, args) => {
    const result = await docker(label, ['create', '--pull', offlineImage ? 'never' : 'missing', '--name', name, ...args], { capture: true });
    const id = result.text.trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Docker did not return an exact owned container ID');
    owned.set(name, { id, name });
    await docker('start-' + name, ['start', id], { capture: true });
    return id;
  };
  const removeOwned = async (names, cleanup = true) => {
    const containers = names.flatMap(name => owned.has(name) ? [owned.get(name)] : []);
    try { for (const name of await cleanupContainers(containers, docker, cleanup)) owned.delete(name); }
    catch (error) { for (const name of error.removedContainers ?? []) owned.delete(name); throw error; }
  };
  const startServices = async () => {
    await start('start-postgres', postgres, ['--network', `container:${runner}`, '--cpus', '0.5', '--memory', '512m', '--memory-swap', '512m', ...envArgs(workflow.credentials), serviceImages.postgres ?? workflow.postgres]);
    await start('start-azurite', azurite, ['--network', `container:${runner}`, '--cpus', '0.25', '--memory', '640m', '--memory-swap', '640m', serviceImages.azurite ?? workflow.azurite,
      'azurite-blob', '--blobHost', '0.0.0.0', '--skipApiVersionCheck', '--disableProductStyleUrl']);
    await start('start-https-azurite', httpsAzurite, ['--network', `container:${runner}`, '--cpus', '0.25', '--memory', '640m', '--memory-swap', '640m',
      '--mount', `type=bind,source=${join(directory, 'capabilities/tls')},target=/tls,readonly`, serviceImages.azurite ?? workflow.azurite,
      'azurite-blob', '--blobHost', '127.0.0.1', '--blobPort', '10003', '--cert', '/tls/server.pem', '--key', '/tls/server.key', '--skipApiVersionCheck', '--disableProductStyleUrl']);
    for (let attempt = 0; ; attempt++) {
      const ready = await docker('postgres-readiness', ['exec', postgres, 'pg_isready', '-U', workflow.credentials.POSTGRES_USER, '-d', workflow.credentials.POSTGRES_DB], { allowFailure: true, capture: true });
      if (ready.code === 0) break;
      if (attempt === 29) throw new Error('Disposable Postgres did not become ready');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  };
  try {
    receipt.clean_tree = clean();
    if (!receipt.clean_tree) throw new Error('Commit all tracked/untracked changes before npm run pr-gate');
    await command('fetch-develop', 'git', ['fetch', 'origin', 'develop']);
    expected = expectedFor('HEAD'); Object.assign(receipt, expected); delete receipt.matrix;
    workflow = readWorkflow(blob(expected.commit, '.github/workflows/pr-gate.yml').toString());
    if (!workerImage || !dependencyRoot) throw new Error('Full local gate needs --host-worker-image <existing immutable image ID> and --host-dependency-root <existing matching dependency cache>; no software will be installed by host adapters');
    receipt.dependency_sources = offlineImage ? { mode: 'existing-local-cache', downloads: false } : dependencySources(process.env);
    if (process.env.DOCKER_HOST && !/^(unix|npipe):\/\//.test(process.env.DOCKER_HOST)) throw new Error('Only a local Docker Engine is allowed');
    const endpoint = (await docker('docker-context', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { capture: true })).text;
    if (!/^(unix|npipe):\/\//.test(endpoint)) throw new Error('Only a local Docker context is allowed');
    const os = (await docker('docker-platform', ['info', '--format', '{{.OSType}}'], { capture: true })).text;
    if (os !== 'linux') throw new Error('Docker must be running local Linux containers');
    dockerAvailable = true;
    // Transfer only this original commit and its tree/blob objects; never copy host Git configuration.
    const snapshotHelper = join(directory, 'git-snapshot.mjs');
    writeFileSync(snapshotHelper, blob(expected.commit, 'scripts/pr-gate/git-snapshot.mjs'));
    await command('snapshot', process.execPath, [snapshotHelper, 'create', '--source-root', root,
      '--commit', expected.commit, '--tree', expected.tree, '--out', join(directory, 'source')]);
    const sourceSnapshot = json(join(directory, 'source', 'manifest.json'));
    mkdirSync(join(directory, 'capabilities'));
    createParserArchive(root, join(directory, 'capabilities/parser106.tar'));
    restoreParserArchive(join(directory, 'capabilities/parser106.tar'), parserDirectory);
    mkdirSync(dirname(referenceOwner), { recursive: true });
    receipt.reference_components = { schema: 'pr-gate-reference-components-run-v1', commit: expected.commit, tree: expected.tree, run_id: id,
      host_before: restoreReferenceSource(root, referenceOwner, directory), shards: [] };
    const image = offlineImage ?? `bondbuddy-pr-gate:${createHash('sha256').update(blob(expected.commit, 'scripts/pr-gate/Dockerfile')).digest('hex').slice(0, 16)}`;
    runtimeEnvironment = { ...workflow.env, CI: '1', GITHUB_SHA: expected.commit, GITHUB_WORKSPACE: '/workspace', RUNNER_TEMP: '/tmp',
      PR_GATE_TREE: expected.tree, BONDBUDDY_TEST_PYTHON: '/usr/local/bin/python', BONDBUDDY_WORD_PYTHON: '/usr/local/bin/python', BB_PYTHON: '/usr/local/bin/python',
      PYTHONPATH: '/workspace/python:/workspace/python/tests' };
    if (offlineImage) {
      runtimeEnvironment.PR_GATE_OFFLINE_IMAGE = offlineImage;
      runtimeEnvironment.PR_GATE_SNAPSHOT_PACK_SHA256 = sourceSnapshot.pack_sha256;
      writeFileSync(join(directory, 'offline-cache.mjs'), blob(expected.commit, 'scripts/pr-gate/offline-cache.mjs'));
      for (const path of CACHE_FILES) {
        const destination = join(directory, 'cache-candidate', path); mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, blob(expected.commit, path));
      }
    }
    await step('image', async () => {
      if (offlineImage) {
        const metadata = JSON.parse((await docker('inspect-cache-image', ['image', 'inspect', image], { capture: true, privateCapture: true })).text)[0];
        receipt.cache_image = inspectOfflineImage(metadata, image);
        writeFileSync(join(directory, 'cache-image.json'), JSON.stringify(receipt.cache_image, null, 2) + '\n');
        // Missing services fail without pulling; all tests remain network-isolated.
        for (const [label, service] of [['postgres', workflow.postgres], ['azurite', workflow.azurite]]) {
          const actual = (await docker('inspect-cached-' + label, ['image', 'inspect', '--format', '{{.Id}}', service], { capture: true })).text;
          if (!/^sha256:[a-f0-9]{64}$/.test(actual)) throw new Error('Invalid cached service image identity');
          serviceImages[label] = actual;
        }
        receipt.cache_service_images = { ...serviceImages };
      } else await docker('build-test-image', ['build', '--tag', image, '--file', join(root, 'scripts/pr-gate/Dockerfile'), join(root, 'scripts/pr-gate')]);
      // No host credentials, source mount, ports, socket or existing database.
      await start('start-runner', runner, ['--init', '--user', '0:0', '--workdir', '/workspace', '--shm-size', '1g',
        ...(offlineImage ? ['--network', 'none'] : []), '--cpus', '2', '--memory', '4g', '--memory-swap', '4g', '--pids-limit', '512',
        '--mount', `type=bind,source=${directory},target=/evidence`,
        '--mount', `type=bind,source=${parserDirectory},target=${CAPABILITY_PATHS.parser},readonly`,
        '--mount', `type=bind,source=${receipt.reference_components.host_before.root},target=${REFERENCE_ROOT},readonly`,
        ...(offlineImage ? ['--entrypoint', '/usr/bin/env'] : envArgs(runtimeEnvironment)), image,
        ...(offlineImage ? isolatedCommand(['sleep', 'infinity'], runtimeEnvironment).slice(1) : [])]);
      receipt.reference_components.container_id = owned.get(runner).id;
      receipt.reference_components.mount_before = await referenceMount('inspect-reference-mount-before');
      if (offlineImage) {
        const inspected = JSON.parse((await docker('inspect-cache-runner', ['inspect', owned.get(runner).id], { capture: true, privateCapture: true })).text)[0];
        receipt.cache_runtime = inspectOfflineContainer(inspected, image);
        writeFileSync(join(directory, 'cache-runtime.json'), JSON.stringify(receipt.cache_runtime, null, 2) + '\n');
        await exec('restore-cached-source', ['node', '/evidence/offline-cache.mjs', 'restore']);
      }
      else await exec('restore-source', ['node', '/evidence/git-snapshot.mjs', 'restore', '--snapshot', '/evidence/source',
        '--destination', '/workspace', '--commit', expected.commit, '--tree', expected.tree,
        '--pack-sha256', sourceSnapshot.pack_sha256]);
    });
    await step('capabilities', async () => {
      await exec('prepare-capabilities', ['node', 'scripts/pr-gate/capability-runtime.mjs', 'prepare']);
      receipt.capabilities = json(join(directory, 'capabilities/prepared.json'));
      receipt.reference_components.container_before = await referenceCheck('prepared');
    });
    await step('services', startServices);
    await step('dependencies', async () => {
      await exec('npm-ci', ['npm', 'ci', ...(offlineImage ? ['--offline'] : []), '--no-audit', '--no-fund'],
        { ...(offlineImage ? {} : { npm_config_registry: receipt.dependency_sources.npm }), npm_config_logs_dir: '/evidence/npm-logs' });
      if (offlineImage) await exec('npm-dependency-tree', ['npm', 'ls', '--all', '--json']);
      else await exec('python-dependencies', ['python', '-m', 'pip', 'install', '-r', 'python/requirements-dev.txt'], { PIP_INDEX_URL: receipt.dependency_sources.pip });
      await exec('python-check', ['python', '-m', 'pip', 'check']);
      await exec('flock-check', ['flock', '--version']);
      if (offlineImage) await exec('inspect-offline-dependencies', ['node', 'scripts/pr-gate/offline-cache.mjs', 'dependencies']);
    });
    await step('build', () => exec('build', ['npm', 'run', 'build']));
    await step('contracts', () => exec('contracts', ['npm', 'run', 'check:contracts']));
    await step('browser', async () => {
      if (offlineImage) {
        await exec('inspect-existing-chromium', ['node', 'scripts/pr-gate/offline-cache.mjs', 'browser']);
        receipt.offline_cache = json(join(directory, 'offline-cache/record.json'));
      } else await exec('install-chromium', ['npx', 'playwright', 'install', '--with-deps', 'chromium']);
    });
    await step('host', async () => {
      const sourceRoot = hostSourceDirectory(tmpdir(), id), hostEvidence = join(output, 'host-evidence', id);
      mkdirSync(dirname(hostEvidence), { recursive: true });
      const hostRestored = await command('restore-host-source', process.execPath, [snapshotHelper, 'restore', '--snapshot', join(directory, 'source'), '--destination', sourceRoot,
        '--commit', expected.commit, '--tree', expected.tree, '--pack-sha256', sourceSnapshot.pack_sha256], { capture: true });
      receipt.host_source = { directory: sourceRoot, ...JSON.parse(hostRestored.text) };
      const plan = createHostPlan({ root, candidate: expected, matrix: workflow.matrix, runId: id, sourceBlob: path => blob(expected.commit, path) });
      hostBroker = createHostBroker({ plan, directory: join(directory, 'host-dispatch'), evidenceRoot: hostEvidence, sourceRoot, dependencyRoot });
      nativeAdapter = await import('./host-adapters/native.mjs');
      nativeRuntime = await nativeAdapter.prepareNativeRuntime({ candidate: expected, runId: id, imageId: workerImage, core: { runner, exec, docker },
        evidenceRoot: hostEvidence, transferRoot: directory, sourceRoot });
      hostBroker.setRuntime(nativeRuntime);
      receipt.host_dispatch = hostBroker.snapshot();
    });
    for (const [index, row] of workflow.matrix.entries()) {
      const record = { name: row.name, groups: row.groups, shard: row.shard, started_at: new Date().toISOString(), exit_code: null, summary: null };
      receipt.shards.push(record);
      let browserServices, referenceShard;
      try {
        if (index) { await removeOwned([postgres, azurite, httpsAzurite], false); await startServices(); }
        await exec(`${row.name}-blob-readiness`, ['node', '--input-type=module', '-e', `import { BlobServiceClient } from '@azure/storage-blob'; const c=BlobServiceClient.fromConnectionString(process.env.BB_TEST_AZURITE_CONNECTION_STRING).getContainerClient('bb-pr-gate-readiness'); for(let i=0;;i++){try{await c.createIfNotExists();await c.deleteIfExists();break;}catch(e){if(i>=29)throw e;await new Promise(r=>setTimeout(r,1000));}}`]);
        await exec(`${row.name}-migrate`, ['node', 'db/migrate.mjs'], { DATABASE_URL: workflow.env.BB_TEST_DATABASE_URL });
        mkdirSync(join(directory, 'shards', row.name), { recursive: true });
        await exec(`${row.name}-capability-services`, ['node', 'scripts/pr-gate/capability-runtime.mjs', 'services', row.name, `/evidence/shards/${row.name}/capability-services.json`], { NODE_EXTRA_CA_CERTS: CAPABILITY_PATHS.ca });
        record.capability_preparation = json(join(directory, 'shards', row.name, 'capability-services.json'));
        if (row.groups === 'browser') {
          const postgresImage = (await docker(`${row.name}-postgres-image`, ['inspect', '--format', '{{.Image}}', postgres], { capture: true })).text;
          browserServices = await prepareBrowserServices({ candidate: expected, runId: id, row, sourceBlob: path => blob(expected.commit, path),
            core: { runner, exec, docker, start, removeOwned }, images: { postgres: postgresImage, native: workerImage }, evidenceRoot: directory, sourceRoot: receipt.host_source.directory });
          record.browser_services = browserServices.evidence;
        }
        const env = { BB_QA_TEST_OUTPUT_DIRECTORY: `/tmp/${row.name}/qa`, BB_INTEGRITY_TEST_OUTPUT_DIRECTORY: `/tmp/${row.name}/integrity`, BB_WORKPAPER_ASSESSMENT_TEST_OUTPUT_DIRECTORY: `/tmp/${row.name}/workpaper-assessment`,
          PR_GATE_CAPABILITIES_FILE: '/evidence/capabilities/prepared.json',
          PR_GATE_HOST_PLAN: '/evidence/host-dispatch/plan.json', PR_GATE_HOST_DIRECTORY: '/evidence/host-dispatch',
          ...(browserServices?.env ?? {}),
          ...(row.render === 'true' ? { BONDBUDDY_RUN_AUTHORIZED_DOCX_REGRESSION: '1', BB_REQUIRE_DOCUMENT_RENDER: '1' } : {}) };
        const hostRun = hostBroker.startShard(row.name);
        try {
          if (row.groups === 'browser') {
            referenceShard = { name: row.name }; receipt.reference_components.shards.push(referenceShard);
            referenceShard.before = await referenceCheck(row.name + ':before');
          }
          record.exit_code = (await exec(`${row.name}-tests`, ['node', 'scripts/pr-gate/run.mjs', 'run', '--group', row.groups, '--shard', row.shard, '--name', row.name, '--jobs', String(workflow.matrix.length), '--out', `/evidence/shards/${row.name}`], env, { allowFailure: true })).code;
        }
        finally { await hostRun.finish(); receipt.host_dispatch = hostBroker.snapshot(); }
        record.summary = json(join(directory, 'shards', row.name, `summary-${row.name}.json`));
      } catch (error) { record.error = error.message; receipt.errors.push(`${row.name}: ${error.message}`); }
      finally {
        if (referenceShard) try { referenceShard.after = await referenceCheck(row.name + ':after', true); }
        catch (error) { receipt.errors.push(`${row.name} final reference verification: ${error.message}`); }
        if (browserServices) try { await browserServices.cleanup(); record.browser_services = browserServices.evidence; }
        catch (error) { receipt.errors.push(`${row.name} browser services cleanup: ${error.message}`); } }
      record.finished_at = new Date().toISOString(); save();
      if (interrupted) break;
    }
  } catch (error) { receipt.errors.push(error.message); console.error(`[pr-gate] ${error.message}`); }
  finally {
    // Record failures too, before removing the exact owned runner. Both the
    // host input and container view must remain the pinned eleven blobs.
    if (receipt.reference_components) {
      try { receipt.reference_components.host_after = verifyReferenceDirectory(receipt.reference_components.host_before.root); }
      catch (error) { receipt.errors.push(`Final host reference verification: ${error.message}`); }
      if (owned.has(runner)) {
        try { receipt.reference_components.mount_after = await referenceMount('inspect-reference-mount-after', true); }
        catch (error) { receipt.errors.push(`Final reference mount verification: ${error.message}`); }
        try { receipt.reference_components.container_after = await referenceCheck('final', true); }
        catch (error) { receipt.errors.push(`Final container reference verification: ${error.message}`); }
      }
    }
    // Verify the disposable core before removing it. Outer host Git cleanliness
    // cannot detect tracked screenshots or source files changed inside /workspace.
    try {
      if (!expected || !owned.has(runner)) throw new Error('Final core source verification cannot run without the owned candidate container');
      receipt.core_source_final = await collectCoreSource({ candidate: expected, runId: id,
        verifierBytes: blob(expected.commit, 'scripts/pr-gate/git-snapshot.mjs'), rawSource: nativeRuntime?.evidence.source.raw_source,
        shards: receipt.shards, execute: exec });
    } catch (error) { receipt.errors.push(`Final core source verification: ${error.message}`); }
    // Merge even partial/empty runs, using unchanged run.mjs and its original exit rules.
    try {
      const result = await command('merge', process.execPath, ['scripts/pr-gate/run.mjs', 'merge', join(directory, 'shards'), '--expect', '8', '--out', join(directory, 'final')], { allowFailure: true, cleanup: true });
      receipt.merge = { exit_code: result.code, result: json(join(directory, 'final', 'pr-gate-result.json')) };
    } catch (error) { receipt.errors.push(error.message); }
    receipt.finished_at = new Date().toISOString(); save();
    try {
      const cleanupErrors = [];
      if (nativeRuntime) { try { await nativeAdapter.cleanupNativeRuntime(nativeRuntime); } catch (error) { cleanupErrors.push(error.message); } }
      if (dockerAvailable) {
        try { await removeOwned([postgres, azurite, httpsAzurite, runner]); } catch (error) { cleanupErrors.push(error.message); }
      }
      if (hostBroker) { hostBroker.save(); receipt.host_dispatch = hostBroker.snapshot(); }
      if (cleanupErrors.length) throw new Error(cleanupErrors.join('; '));
      receipt.cleanup = { status: 'passed' };
      // These are disposable test-only keys. Retain the public identities and
      // results, never a private TLS key in the evidence bundle.
      for (const file of ['ca.key', 'server.key']) rmSync(join(directory, 'capabilities/tls', file), { force: true });
    } catch (error) { receipt.cleanup = { status: 'failed', error: error.message }; receipt.errors.push(error.message); }
    try {
      receipt.clean_tree = receipt.clean_tree && clean();
      if (!receipt.clean_tree || git(['rev-parse', 'HEAD']) !== receipt.commit || git(['rev-parse', 'HEAD^{tree}']) !== receipt.tree) throw new Error('Working tree or commit changed during the gate');
      if (git(['rev-parse', 'origin/develop']) !== receipt.develop_commit) throw new Error('Fetched develop changed during the gate');
    } catch (error) { receipt.errors.push(error.message); }
    if (interrupted) receipt.errors.push('Gate interrupted');
    receipt.finished_at = new Date().toISOString();
    if (expected) {
      try { verifyReceipt({ ...receipt, status: 'passed' }, expected); receipt.status = 'passed'; }
      catch (error) { receipt.errors.push(`Receipt validation: ${error.message}`); }
    }
    if (receipt.errors.length) receipt.status = 'failed';
    save();
    process.off('SIGINT', signal); process.off('SIGTERM', signal);
    try { rmSync(lock, { recursive: true }); }
    catch (error) { receipt.status = 'failed'; receipt.errors.push(`Cannot release gate lock: ${error.message}`); save(); }
  }
  console.log(`[pr-gate] ${receipt.status}; receipt: ${receiptPath}; elapsed: ${((Date.parse(receipt.finished_at) - Date.parse(receipt.started_at)) / 1000).toFixed(1)}s`);
  return receipt.status === 'passed' ? 0 : 1;
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'run') return run(localOptions(args));
  if (mode === 'verify' && args.length === 1) {
    const expected = expectedFor(args[0]);
    verifyReceipt(json(receiptPath), expected);
    console.log(`Verified PR gate receipt for ${expected.commit} (tree ${expected.tree})`); return 0;
  }
  throw new Error('Usage: npm run pr-gate | npm run pr-gate:verify <commit>');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => { console.error(`[pr-gate] ${error.message}`); process.exitCode = 1; });
}
