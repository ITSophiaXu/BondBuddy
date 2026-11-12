import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HOST_PROFILES } from '../host-profiles.mjs';
import { sha256, verifyExecution } from '../host-dispatch-protocol.mjs';

const helper = 'scripts/pr-gate/host-adapters/native-runtime.mjs';
const nativeProfiles = ['native-sandbox', 'native-desktop', 'native-ocr'];
const nativeEnvironment = Object.freeze({ PATH: '/opt/venv/bin:/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8', TMPDIR: '/tmp',
  PYTHONPATH: '/app/.pr-gate-python:/app/python:/app/python/tests', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8',
  BONDBUDDY_TEST_PYTHON: '/opt/venv/bin/python', BB_PYTHON: '/opt/venv/bin/python', BB_CODEX_PATH: '/usr/local/bin:/usr/bin:/bin',
  PLAYWRIGHT_BROWSERS_PATH: '/opt/bondbuddy-browsers', TESSDATA_PREFIX: '/usr/share/tesseract-ocr/5/tessdata', CI: '1' });
const envCommand = args => ['/usr/bin/env', '-i', ...Object.entries(nativeEnvironment).map(([key, value]) => key + '=' + value), ...args];
const hostEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|HOME)$/i.test(key)));
function fileHash(path) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), fd = openSync(path, 'r');
  try { for (;;) { const size = readSync(fd, buffer, 0, buffer.length, null); if (!size) break; hash.update(buffer.subarray(0, size)); } }
  finally { closeSync(fd); }
  return hash.digest('hex');
}

export function narrowedSeccomp(source) {
  const value = structuredClone(source);
  assert.ok(value.defaultAction && Array.isArray(value.syscalls));
  value.syscalls = value.syscalls.flatMap(rule => rule.names.includes('mount') && rule.action === 'SCMP_ACT_ALLOW'
    ? [{ ...rule, names: rule.names.filter(name => name !== 'mount') }, { ...rule, names: ['mount'], args: [...(rule.args ?? []), { index: 3, value: 14, op: 'SCMP_CMP_NE' }] }] : [rule]);
  return value;
}

function dockerCommands({ context, directory, evidence, signal }) {
  let sequence = 0;
  return async (label, args, { timeout = 300_000, allowFailure = false, cleanup = false, privateCapture = false } = {}) => {
    if (signal?.aborted && !cleanup) throw new Error('Host native capability cancelled');
    const started = Date.now(), index = sequence++, commandArgs = ['--context', context, ...args];
    let child, timedOut = false, cancelled = false, stdout = '', stderr = '', outputFailure = false, spawnError;
    const execution = await new Promise(done => {
      child = spawn('docker', commandArgs, { env: hostEnv(), windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      const kill = () => {
        if (!child.pid) return;
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { env: hostEnv(), windowsHide: true, stdio: 'ignore' });
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      };
      const abort = () => { cancelled = true; kill(); };
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
      if (!cleanup) { signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); }
      child.stdout.on('data', data => { stdout += data; if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) { outputFailure = true; kill(); } });
      child.stderr.on('data', data => { stderr += data; if (Buffer.byteLength(stderr) > 8 * 1024 * 1024) { outputFailure = true; kill(); } });
      child.on('error', error => { spawnError = error; });
      child.on('close', (code, childSignal) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); done({ code, signal: childSignal, timedOut, stdout, stderr, durationMs: Date.now() - started }); });
    });
    const name = String(index).padStart(3, '0') + '-' + label;
    if (!privateCapture) { writeFileSync(join(directory, name + '.stdout.log'), stdout); writeFileSync(join(directory, name + '.stderr.log'), stderr); }
    evidence.commands.push({ label, executable: 'docker', args: commandArgs, cwd: process.cwd(), started_at: new Date(started).toISOString(), durationMs: execution.durationMs,
      code: execution.code, signal: execution.signal, timedOut, cancelled, output_limit_failed: outputFailure, private_capture: privateCapture,
      stdout_sha256: sha256(stdout), stderr_sha256: sha256(stderr) });
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    if (spawnError || cancelled || outputFailure || timedOut || (!allowFailure && execution.code !== 0)) throw new Error(`${label}: ${spawnError?.message ?? (cancelled ? 'cancelled' : timedOut ? 'timed out' : outputFailure ? 'output limit' : 'exit ' + execution.code)}`);
    return execution;
  };
}

async function removeContainer(runtime, docker, id, name) {
  assert.match(id, /^[a-f0-9]{64}$/);
  const value = JSON.parse((await docker('cleanup-identity', ['inspect', id], { cleanup: true })).stdout)[0];
  assert.equal(value.Id, id); assert.equal(value.Name, '/' + name); assert.equal(value.Config.Labels['bondbuddy.pr-gate.run'], runtime.runId);
  await docker('cleanup-container', ['rm', '--force', '--volumes', id], { cleanup: true });
  const absent = await docker('cleanup-absent', ['inspect', id], { cleanup: true, allowFailure: true });
  assert.ok(absent.code !== 0 && /no such (object|container)/i.test(absent.stderr));
}

export async function prepareNativeRuntime({ candidate, runId, imageId, core, evidenceRoot, transferRoot, sourceRoot }) {
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/); assert.match(runId, /^[a-zA-Z0-9-]{8,80}$/);
  const directory = join(evidenceRoot, 'native-runtime'); mkdirSync(directory);
  const context = (await core.docker('native-context-name', ['context', 'show'], { capture: true })).text;
  const evidence = { ...candidate, run_id: runId, image_id: imageId, started_at: new Date().toISOString(), commands: [], resources: [], cleanup: { status: 'pending' } };
  const runtime = { candidate: { commit: candidate.commit, tree: candidate.tree }, runId, imageId, context, directory, sourceRoot,
    volume: 'bb-pr-gate-native-' + runId, evidence };
  const docker = dockerCommands({ context, directory, evidence });
  let initializer, volumeCreated = false;
  const name = runtime.volume + '-init';
  try {
    const endpoint = (await docker('local-endpoint', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])).stdout.trim();
    assert.match(endpoint, /^(unix|npipe):\/\//, 'Native capabilities must use the local Docker engine');
    const image = JSON.parse((await docker('image', ['image', 'inspect', imageId], { privateCapture: true })).stdout)[0];
    assert.equal(image.Id, imageId); assert.equal(image.Os, 'linux'); assert.equal(image.Config.WorkingDir, '/app');
    assert.ok(!image.Config.Volumes || Object.keys(image.Config.Volumes).length === 0);
    assert.ok((image.Config.Env ?? []).every(row => !/(TOKEN|PASSWORD|SECRET|API_KEY|CREDENTIAL)/i.test(row.split('=')[0])), 'Native image contains credential-like environment');
    evidence.image = { id: image.Id, os: image.Os, architecture: image.Architecture, dependency_base_revision: image.Config.Labels?.['org.opencontainers.image.revision'] ?? null };
    runtime.security = JSON.parse((await docker('engine-security', ['info', '--format', '{{json .SecurityOptions}}'])).stdout);
    evidence.core_image_id = (await core.docker('native-core-image', ['inspect', '--format', '{{.Image}}', core.runner], { capture: true })).text;
    assert.match(evidence.core_image_id, /^sha256:[a-f0-9]{64}$/);
    await core.exec('bundle-current-native-app', ['node', helper, 'bundle', candidate.commit, candidate.tree]);
    // Move the built candidate outside the core's writable /evidence mount
    // before any test starts. The old image's /app is always hidden by a volume.
    for (const file of ['native-app.tar', 'native-manifest.json', 'native-reportlab.tar', 'native-reportlab.json']) renameSync(join(transferRoot, file), join(directory, file));
    evidence.bundle_sha256 = fileHash(join(directory, 'native-app.tar'));
    evidence.reportlab_cache_sha256 = fileHash(join(directory, 'native-reportlab.tar'));
    evidence.reportlab_cache = JSON.parse(readFileSync(join(directory, 'native-reportlab.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(directory, 'native-manifest.json'), 'utf8'));
    assert.equal(manifest.commit, candidate.commit); assert.equal(manifest.tree, candidate.tree); evidence.source = manifest;
    for (const [file, profile] of [['codex-seccomp.json', 'native-sandbox'], ['integrity-browser-seccomp.json', 'native-desktop']]) {
      const original = readFileSync(join(sourceRoot, 'deploy/m1/security', file));
      assert.equal(sha256(original), manifest.files['deploy/m1/security/' + file]);
      writeFileSync(join(directory, profile + '.json'), JSON.stringify(narrowedSeccomp(JSON.parse(original)), null, 2) + '\n');
    }
    writeFileSync(join(directory, 'synthetic-secret'), 'BB_SYNTHETIC_SANDBOX_CANARY_NOT_A_CREDENTIAL\n');
    const absent = await docker('volume-must-be-new', ['volume', 'inspect', runtime.volume], { allowFailure: true });
    assert.ok(absent.code !== 0 && /no such volume|not found/i.test(absent.stderr), 'Never adopt an existing native app volume');
    assert.equal((await docker('volume-create', ['volume', 'create', '--label', 'bondbuddy.pr-gate.run=' + runId, runtime.volume])).stdout.trim(), runtime.volume);
    volumeCreated = true; evidence.resources.push({ kind: 'volume', name: runtime.volume, label: runId });
    initializer = (await docker('initializer-create', ['create', '--pull', 'never', '--name', name, '--label', 'bondbuddy.pr-gate.run=' + runId,
      '--user', '0:0', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--cpus', '1', '--memory', '2g', '--pids-limit', '128',
      '--mount', `type=volume,source=${runtime.volume},target=/app,volume-nocopy`, '--mount', `type=bind,source=${directory},target=/transfer,readonly`,
      '--mount', `type=bind,source=${join(sourceRoot, helper)},target=/native-runtime.mjs,readonly`, '--entrypoint', '/usr/bin/env', imageId,
      ...envCommand(['node', '/native-runtime.mjs', 'initialize']).slice(1)])).stdout.trim();
    assert.match(initializer, /^[a-f0-9]{64}$/); evidence.resources.push({ kind: 'initializer', id: initializer });
    await docker('initializer-start', ['start', '-a', initializer]);
    await removeContainer(runtime, docker, initializer, name); initializer = null;
    evidence.status = 'prepared'; evidence.prepared_at = new Date().toISOString();
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    return runtime;
  } catch (error) {
    const cleanupErrors = [];
    if (initializer) { try { await removeContainer(runtime, docker, initializer, name); } catch (cleanup) { cleanupErrors.push(cleanup.message); } }
    if (volumeCreated && !cleanupErrors.length) { try { await cleanupNativeRuntime(runtime); } catch (cleanup) { cleanupErrors.push(cleanup.message); } }
    evidence.status = 'failed'; evidence.error = error.message; evidence.cleanup = { status: cleanupErrors.length ? 'failed' : 'passed', errors: cleanupErrors };
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n'); throw error;
  }
}

export function verifyNativeIsolation(value, runtime, profile) {
  assert.match(value.Id, /^[a-f0-9]{64}$/); assert.equal(value.Image, runtime.imageId);
  assert.equal(value.Config.User, '1000:1000'); assert.equal(value.HostConfig.NetworkMode, 'none');
  assert.equal(value.HostConfig.ReadonlyRootfs, true); assert.equal(value.HostConfig.Privileged, false);
  assert.ok(value.HostConfig.CapDrop.includes('ALL') && !value.HostConfig.CapAdd?.length);
  assert.ok(value.HostConfig.SecurityOpt.includes('no-new-privileges'));
  assert.equal(value.HostConfig.NanoCpus, 1_000_000_000); assert.equal(value.HostConfig.Memory, 2 * 1024 ** 3);
  assert.equal(value.HostConfig.MemorySwap, 2 * 1024 ** 3); assert.equal(value.HostConfig.PidsLimit, 256);
  assert.ok(!value.HostConfig.PortBindings || !Object.keys(value.HostConfig.PortBindings).length);
  const mounts = value.Mounts.map(row => ({ destination: row.Destination, type: row.Type, rw: row.RW, name: row.Name })).sort((a, b) => a.destination.localeCompare(b.destination));
  assert.equal(mounts.length, 4); assert.equal(mounts.filter(row => row.rw).length, 1);
  assert.ok(mounts.some(row => row.destination === '/app' && row.name === runtime.volume && row.type === 'volume' && !row.rw));
  assert.ok(mounts.some(row => row.destination === '/evidence' && row.type === 'bind' && row.rw));
  assert.ok(mounts.some(row => row.destination === '/transfer' && row.type === 'bind' && !row.rw));
  assert.ok(mounts.some(row => row.destination === '/run/secrets/bb-copilot-oauth' && row.type === 'bind' && !row.rw));
  if (profile !== 'native-ocr') assert.ok(value.HostConfig.SecurityOpt.some(option => option.startsWith('seccomp=')));
  return { id: value.Id, image: value.Image, user: value.Config.User, network: 'none', rootfs_readonly: true, privileged: false, mounts,
    nano_cpus: value.HostConfig.NanoCpus, memory: value.HostConfig.Memory, pids_limit: value.HostConfig.PidsLimit, security_options: value.HostConfig.SecurityOpt };
}

export async function executeNativeCapability({ candidate, evidenceRoot, runId, entry, runtime, signal }) {
  const profile = HOST_PROFILES[entry.testId];
  assert.ok(profile && nativeProfiles.includes(profile.id)); assert.equal(entry.profileId, profile.id); assert.equal(entry.fileTimeoutMs, 300_000);
  assert.ok(runtime, 'Native capability runtime not prepared'); assert.deepEqual(runtime.candidate, candidate); assert.equal(runtime.runId, runId);
  const evidence = { ...candidate, run_id: runId, test_id: entry.testId, profile_id: profile.id, started_at: new Date().toISOString(), commands: [], resources: [],
    source_bundle_sha256: runtime.evidence.bundle_sha256, cleanup: { status: 'pending' } };
  const docker = dockerCommands({ context: runtime.context, directory: evidenceRoot, evidence, signal });
  const name = runtime.volume + '-' + entry.sequence; let id, execution, failure;
  try {
    assert.equal(fileHash(join(runtime.directory, 'native-app.tar')), runtime.evidence.bundle_sha256, 'Native candidate bundle changed');
    assert.equal(fileHash(join(runtime.directory, 'native-reportlab.tar')), runtime.evidence.reportlab_cache_sha256, 'Native ReportLab cache archive changed');
    const args = ['create', '--pull', 'never', '--name', name, '--label', 'bondbuddy.pr-gate.run=' + runId, '--user', '1000:1000', '--workdir', '/app',
      '--init', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--cpus', '1', '--memory', '2g', '--memory-swap', '2g', '--pids-limit', '256', '--shm-size', '256m',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=1073741824,mode=1777', '--mount', `type=volume,source=${runtime.volume},target=/app,readonly,volume-nocopy`,
      '--mount', `type=bind,source=${evidenceRoot},target=/evidence`, '--mount', `type=bind,source=${runtime.directory},target=/transfer,readonly`,
      '--mount', `type=bind,source=${join(runtime.directory, 'synthetic-secret')},target=/run/secrets/bb-copilot-oauth,readonly`];
    if (profile.id !== 'native-ocr') args.push('--security-opt', 'seccomp=' + join(runtime.directory, profile.id + '.json').replaceAll('\\', '/'));
    if (runtime.security.includes('name=apparmor') && profile.id !== 'native-ocr') args.push('--security-opt', 'apparmor=bondbuddy-codex-v1');
    args.push('--entrypoint', '/usr/bin/env', runtime.imageId, ...envCommand(['sleep', 'infinity']).slice(1));
    id = (await docker('create', args)).stdout.trim(); assert.match(id, /^[a-f0-9]{64}$/);
    evidence.resources.push({ kind: 'container', id, name });
    evidence.isolation = verifyNativeIsolation(JSON.parse((await docker('isolation', ['inspect', id])).stdout)[0], runtime, profile.id);
    await docker('start', ['start', id]);
    await docker('probe', ['exec', id, ...envCommand(['node', '/app/' + helper, 'probe', profile.id])], { timeout: 120_000 });
    evidence.probe = JSON.parse(readFileSync(join(evidenceRoot, 'probe.json'), 'utf8')); assert.equal(evidence.probe.status, 'passed');
    const invocation = await docker('test', ['exec', id, ...envCommand(['node', '/app/' + helper, 'test', entry.testId])], { timeout: 330_000, allowFailure: true });
    execution = verifyExecution(JSON.parse(readFileSync(join(evidenceRoot, 'execution.json'), 'utf8')));
    evidence.original_command = JSON.parse(readFileSync(join(evidenceRoot, 'execution-command.json'), 'utf8'));
    assert.equal(invocation.stdout, execution.stdout); assert.equal(invocation.stderr, execution.stderr);
    assert.equal(invocation.code, execution.code ?? 1); assert.equal(evidence.original_command.output_limit_failed, false);
  } catch (error) { failure = error; }
  finally {
    let cleanupError;
    if (id) { try { await removeContainer(runtime, docker, id, name); } catch (error) { cleanupError = error; } }
    evidence.cleanup = { status: cleanupError ? 'failed' : 'passed', error: cleanupError?.message ?? null, candidate_volume: 'readonly; removed by complete-run cleanup' };
    evidence.finished_at = new Date().toISOString(); writeFileSync(join(evidenceRoot, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    if (cleanupError) failure = cleanupError;
  }
  if (failure) { failure.execution = execution; failure.evidence = evidence; throw failure; }
  return { execution, evidence };
}

export async function cleanupNativeRuntime(runtime) {
  const { evidence, directory, context } = runtime, docker = dockerCommands({ context, directory, evidence });
  try {
    const volume = JSON.parse((await docker('cleanup-volume-identity', ['volume', 'inspect', runtime.volume], { cleanup: true })).stdout)[0];
    assert.equal(volume.Name, runtime.volume); assert.equal(volume.Labels['bondbuddy.pr-gate.run'], runtime.runId);
    await docker('cleanup-volume-remove', ['volume', 'rm', runtime.volume], { cleanup: true });
    const absent = await docker('cleanup-volume-absent', ['volume', 'inspect', runtime.volume], { cleanup: true, allowFailure: true });
    assert.ok(absent.code !== 0 && /no such volume|not found/i.test(absent.stderr));
    evidence.cleanup = { status: 'passed' };
  } catch (error) { evidence.cleanup = { status: 'failed', error: error.message }; throw error; }
  finally { evidence.finished_at = new Date().toISOString(); writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n'); }
}
