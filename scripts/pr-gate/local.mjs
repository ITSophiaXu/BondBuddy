#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { arch, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkflow } from './workflow.mjs';
import { exclusionsEvidence, verifyReceipt } from './receipt.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, '.local/pr-gate');
const receiptPath = join(output, 'receipt.json');
const git = args => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
};
const blob = (commit, path) => {
  const result = spawnSync('git', ['show', `${commit}:${path}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Cannot read ${path} at ${commit}`);
  return result.stdout;
};
const clean = () => git(['status', '--porcelain', '--untracked-files=normal']) === '';
const atomic = value => {
  writeFileSync(`${receiptPath}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${receiptPath}.tmp`, receiptPath);
};
const json = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;

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
    exclusions: exclusionsEvidence(blob(commit, 'scripts/pr-gate/exclusions.json')) };
}

async function run() {
  mkdirSync(output, { recursive: true });
  const lock = join(output, 'run.lock');
  try { mkdirSync(lock); } catch { throw new Error(`Another gate may be running. Inspect ${lock} before removing a stale lock.`); }
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const directory = join(output, 'runs', id);
  mkdirSync(directory, { recursive: true });
  const runner = `bb-pr-gate-${id}`;
  const postgres = `${runner}-pg`, azurite = `${runner}-blob`;
  const receipt = { schema_version: 'pr-gate-local-v1', status: 'failed', started_at: new Date().toISOString(), finished_at: null,
    commit: null, tree: null, develop_commit: null, clean_tree: false, platform: 'linux', host_platform: process.platform,
    host_arch: arch(), host_release: release(), run_id: id, artifacts: `runs/${id}`, preparation: [], shards: [], merge: null, cleanup: { status: 'pending' }, errors: [] };
  try { atomic(receipt); } // A failed/dirty new invocation must never leave an older passed receipt active.
  catch (error) { rmSync(lock, { recursive: true }); throw error; }
  const save = () => {
    try { atomic(receipt); }
    catch (error) { receipt.errors.push(`Cannot save receipt: ${error.message}`); console.error(error.message); }
  };
  let currentChild, interrupted = false, dockerAvailable = false, expected, workflow;
  const signal = () => { interrupted = true; currentChild?.kill('SIGTERM'); };
  process.on('SIGINT', signal); process.on('SIGTERM', signal);
  const command = (label, executable, args, { allowFailure = false, capture = false, cleanup = false } = {}) => new Promise((done, reject) => {
    if (interrupted && !cleanup) return reject(new Error('Gate interrupted'));
    console.log(`[pr-gate] ${label}`);
    const log = openSync(join(directory, `${label.replace(/[^a-zA-Z0-9_-]/g, '_')}.log`), 'a');
    const child = spawn(executable, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    currentChild = child;
    let text = '', spawnError;
    const receive = (data, stream) => {
      try { writeFileSync(log, data); if (capture) text += data; else stream.write(data); }
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
  const exec = (label, args, env = {}, options) => docker(label, ['exec', ...envArgs(env), runner, ...args], options);
  const startServices = async () => {
    await docker('start-postgres', ['run', '--detach', '--name', postgres, '--network', `container:${runner}`, ...envArgs(workflow.credentials), workflow.postgres]);
    await docker('start-azurite', ['run', '--detach', '--name', azurite, '--network', `container:${runner}`, workflow.azurite,
      'azurite-blob', '--blobHost', '0.0.0.0', '--skipApiVersionCheck', '--disableProductStyleUrl']);
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
    if (process.env.DOCKER_HOST && !/^(unix|npipe):\/\//.test(process.env.DOCKER_HOST)) throw new Error('Only a local Docker Engine is allowed');
    const endpoint = (await docker('docker-context', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { capture: true })).text;
    if (!/^(unix|npipe):\/\//.test(endpoint)) throw new Error('Only a local Docker context is allowed');
    const os = (await docker('docker-platform', ['info', '--format', '{{.OSType}}'], { capture: true })).text;
    if (os !== 'linux') throw new Error('Docker must be running local Linux containers');
    dockerAvailable = true;
    const archive = join(directory, 'source.tar');
    await command('snapshot', 'git', ['archive', '--format=tar', `--output=${archive}`, expected.commit]);
    const image = `bondbuddy-pr-gate:${createHash('sha256').update(blob(expected.commit, 'scripts/pr-gate/Dockerfile')).digest('hex').slice(0, 16)}`;
    await step('image', async () => {
      await docker('build-test-image', ['build', '--tag', image, '--file', join(root, 'scripts/pr-gate/Dockerfile'), join(root, 'scripts/pr-gate')]);
      // No host credentials, .env, source mount, ports, Docker socket or existing DB enter this container.
      await docker('start-runner', ['run', '--detach', '--name', runner, '--shm-size', '1g', '--mount', `type=bind,source=${directory},target=/evidence`,
        ...envArgs({ ...workflow.env, CI: '1', GITHUB_SHA: expected.commit, GITHUB_WORKSPACE: '/workspace', RUNNER_TEMP: '/tmp',
          BONDBUDDY_TEST_PYTHON: '/usr/local/bin/python', BONDBUDDY_WORD_PYTHON: '/usr/local/bin/python', BB_PYTHON: '/usr/local/bin/python',
          PYTHONPATH: '/workspace/python:/workspace/python/tests' }), image]);
      await exec('extract-source', ['tar', '-xf', '/evidence/source.tar', '-C', '/workspace']);
    });
    await step('services', startServices);
    await step('dependencies', async () => {
      await exec('npm-ci', ['npm', 'ci', '--no-audit', '--no-fund']);
      await exec('python-dependencies', ['python', '-m', 'pip', 'install', '-r', 'python/requirements-dev.txt']);
      await exec('python-check', ['python', '-m', 'pip', 'check']);
      await exec('flock-check', ['flock', '--version']);
    });
    await step('build', () => exec('build', ['npm', 'run', 'build']));
    await step('contracts', () => exec('contracts', ['npm', 'run', 'check:contracts']));
    await step('browser', () => exec('install-chromium', ['npx', 'playwright', 'install', '--with-deps', 'chromium']));
    for (const [index, row] of workflow.matrix.entries()) {
      const record = { name: row.name, groups: row.groups, shard: row.shard, started_at: new Date().toISOString(), exit_code: null, summary: null };
      receipt.shards.push(record);
      try {
        if (index) { await cleanupContainers([postgres, azurite], docker, false); await startServices(); }
        await exec(`${row.name}-blob-readiness`, ['node', '--input-type=module', '-e', `import { BlobServiceClient } from '@azure/storage-blob'; const c=BlobServiceClient.fromConnectionString(process.env.BB_TEST_AZURITE_CONNECTION_STRING).getContainerClient('bb-pr-gate-readiness'); for(let i=0;;i++){try{await c.createIfNotExists();await c.deleteIfExists();break;}catch(e){if(i>=29)throw e;await new Promise(r=>setTimeout(r,1000));}}`]);
        await exec(`${row.name}-migrate`, ['node', 'db/migrate.mjs'], { DATABASE_URL: workflow.env.BB_TEST_DATABASE_URL });
        const env = { BB_QA_TEST_OUTPUT_DIRECTORY: `/tmp/${row.name}/qa`, BB_INTEGRITY_TEST_OUTPUT_DIRECTORY: `/tmp/${row.name}/integrity`, BB_WORKPAPER_ASSESSMENT_TEST_OUTPUT_DIRECTORY: `/tmp/${row.name}/workpaper-assessment`,
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
        await cleanupContainers([postgres, azurite, runner], docker);
      }
      receipt.cleanup = { status: 'passed' };
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
    save();
    if (receipt.errors.length) receipt.status = 'failed';
    process.off('SIGINT', signal); process.off('SIGTERM', signal);
    rmSync(lock, { recursive: true });
  }
  console.log(`[pr-gate] ${receipt.status}; receipt: ${receiptPath}; elapsed: ${((Date.parse(receipt.finished_at) - Date.parse(receipt.started_at)) / 1000).toFixed(1)}s`);
  return receipt.status === 'passed' ? 0 : 1;
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'run' && !args.length) return run();
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
