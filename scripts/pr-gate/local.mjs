#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { arch, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkflow } from './workflow.mjs';
import { exclusionsEvidence, verifyReceipt } from './receipt.mjs';
import { createParserArchive, restoreParserArchive } from './parser-source.mjs';
import { CAPABILITY_PATHS } from './capabilities.mjs';
import { CACHE_FILES, hash, inspectOfflineImage, inspectOfflineContainer, isolatedCommand, offlineImageArgument } from './offline-cache.mjs';

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

export async function cleanupContainers(names, docker, cleanup = true) {
  // Attempt every exact name even if another removal fails. Confirm absence so
  // a missing container cannot hide a permission/daemon error for its sibling.
  const errors = [];
  for (const name of names) {
    try {
      await docker(`remove-${name}`, ['rm', '--force', '--volumes', name], { allowFailure: true, capture: true, cleanup });
      const remaining = await docker(`inspect-${name}`, ['container', 'ls', '--all', '--quiet', '--filter', `name=^/${name}$`], { capture: true, cleanup });
      if (remaining.text) throw new Error(`${name} still exists`);
    } catch (error) { errors.push(error.message); }
  }
  if (errors.length) throw new Error(errors.join('; '));
}

export function expectedFor(ref) {
  if (!ref || ref.startsWith('-')) throw new Error('Specify the commit to verify');
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`]);
  const develop_commit = git(['rev-parse', '--verify', 'origin/develop^{commit}']);
  if (git(['merge-base', commit, develop_commit]) !== develop_commit) throw new Error('Rebase onto the fetched origin/develop before running the gate');
  return { commit, tree: git(['rev-parse', `${commit}^{tree}`]), develop_commit,
    matrix: readWorkflow(blob(commit, '.github/workflows/pr-gate.yml').toString()).matrix,
    exclusions: exclusionsEvidence(blob(commit, 'scripts/pr-gate/exclusions.json')),
    cache_files: Object.fromEntries(CACHE_FILES.map(path => [path, hash(blob(commit, path))])) };
}

async function run(offlineImage = null) {
  mkdirSync(output, { recursive: true });
  const lock = join(output, 'run.lock');
  try { mkdirSync(lock); } catch { throw new Error(`Another gate may be running. Inspect ${lock} before removing a stale lock.`); }
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const directory = join(output, 'runs', id);
  // Keep the historical source outside /evidence's writable bind mount.
  const parserDirectory = join(output, 'parser-sources', id);
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
  let currentChild, interrupted = false, dockerAvailable = false, expected, workflow, runtimeEnvironment;
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
  const start = async (label, name, args) => {
    const result = await docker(label, ['create', '--pull', offlineImage ? 'never' : 'missing', '--name', name, ...args], { capture: true });
    const id = result.text.trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Docker did not return an exact owned container ID');
    owned.set(name, { id, name });
    await docker('start-' + name, ['start', id], { capture: true });
    return id;
  };
  const removeOwned = async (names, cleanup = true) => {
    const errors = [];
    for (const name of names) {
      const container = owned.get(name); if (!container) continue;
      try {
        const inspected = await docker('identify-' + name, ['inspect', '--format', '{{.Id}} {{.Name}}', container.id], { capture: true, cleanup });
        if (inspected.text !== container.id + ' /' + name) throw new Error('Owned container identity changed');
        await docker('remove-' + name, ['rm', '--force', '--volumes', container.id], { cleanup });
        const absent = await docker('absent-' + name, ['inspect', container.id], { capture: true, allowFailure: true, cleanup });
        if (absent.code === 0 || !/no such (object|container)/i.test(absent.text)) throw new Error('Cannot confirm owned container absence');
        owned.delete(name);
      } catch (error) { errors.push(name + ': ' + error.message); }
    }
    if (errors.length) throw new Error(errors.join('; '));
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
        ...(offlineImage ? ['--entrypoint', '/usr/bin/env'] : envArgs(runtimeEnvironment)), image,
        ...(offlineImage ? isolatedCommand(['sleep', 'infinity'], runtimeEnvironment).slice(1) : [])]);
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
    for (const [index, row] of workflow.matrix.entries()) {
      const record = { name: row.name, groups: row.groups, shard: row.shard, started_at: new Date().toISOString(), exit_code: null, summary: null };
      receipt.shards.push(record);
      try {
        if (index) { await removeOwned([postgres, azurite, httpsAzurite], false); await startServices(); }
        await exec(`${row.name}-blob-readiness`, ['node', '--input-type=module', '-e', `import { BlobServiceClient } from '@azure/storage-blob'; const c=BlobServiceClient.fromConnectionString(process.env.BB_TEST_AZURITE_CONNECTION_STRING).getContainerClient('bb-pr-gate-readiness'); for(let i=0;;i++){try{await c.createIfNotExists();await c.deleteIfExists();break;}catch(e){if(i>=29)throw e;await new Promise(r=>setTimeout(r,1000));}}`]);
        await exec(`${row.name}-migrate`, ['node', 'db/migrate.mjs'], { DATABASE_URL: workflow.env.BB_TEST_DATABASE_URL });
        mkdirSync(join(directory, 'shards', row.name), { recursive: true });
        await exec(`${row.name}-capability-services`, ['node', 'scripts/pr-gate/capability-runtime.mjs', 'services', row.name, `/evidence/shards/${row.name}/capability-services.json`], { NODE_EXTRA_CA_CERTS: CAPABILITY_PATHS.ca });
        record.capability_preparation = json(join(directory, 'shards', row.name, 'capability-services.json'));
        const env = { BB_QA_TEST_OUTPUT_DIRECTORY: `/tmp/${row.name}/qa`, BB_INTEGRITY_TEST_OUTPUT_DIRECTORY: `/tmp/${row.name}/integrity`, BB_WORKPAPER_ASSESSMENT_TEST_OUTPUT_DIRECTORY: `/tmp/${row.name}/workpaper-assessment`,
          PR_GATE_CAPABILITIES_FILE: '/evidence/capabilities/prepared.json',
          ...(row.render === 'true' ? { BONDBUDDY_RUN_AUTHORIZED_DOCX_REGRESSION: '1', BB_REQUIRE_DOCUMENT_RENDER: '1' } : {}) };
        record.exit_code = (await exec(`${row.name}-tests`, ['node', 'scripts/pr-gate/run.mjs', 'run', '--group', row.groups, '--shard', row.shard, '--name', row.name, '--jobs', String(workflow.matrix.length), '--out', `/evidence/shards/${row.name}`], env, { allowFailure: true })).code;
        record.summary = json(join(directory, 'shards', row.name, `summary-${row.name}.json`));
      } catch (error) { record.error = error.message; receipt.errors.push(`${row.name}: ${error.message}`); }
      record.finished_at = new Date().toISOString(); save();
      if (interrupted) break;
    }
  } catch (error) { receipt.errors.push(error.message); console.error(`[pr-gate] ${error.message}`); }
  finally {
    // Merge even partial/empty runs, using unchanged run.mjs and its original exit rules.
    try {
      const result = await command('merge', process.execPath, ['scripts/pr-gate/run.mjs', 'merge', join(directory, 'shards'), '--expect', '8', '--out', join(directory, 'final')], { allowFailure: true, cleanup: true });
      receipt.merge = { exit_code: result.code, result: json(join(directory, 'final', 'pr-gate-result.json')) };
    } catch (error) { receipt.errors.push(error.message); }
    receipt.finished_at = new Date().toISOString(); save();
    try {
      if (dockerAvailable) {
        await removeOwned([postgres, azurite, httpsAzurite, runner]);
      }
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
  if (mode === 'run') return run(offlineImageArgument(args));
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
