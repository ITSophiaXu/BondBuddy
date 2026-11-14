import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { hostEnvironment } from '../../release-smoke/platform.mjs';

import { DOCKER_TESTS, validateDockerConfig } from '../docker-evidence.mjs';
export { DOCKER_TESTS, validateDockerConfig } from '../docker-evidence.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');

export function withinScratch(root, path) {
  const rel = relative(resolve(root), resolve(path));
  assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep), 'Docker case path escapes owned scratch');
}


export function dockerTestConfig(testId) {
  const path = process.env.BB_PR_GATE_DOCKER_TEST_CONFIG;
  if (!path) return null;
  const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 16384);
  return validateDockerConfig(JSON.parse(readFileSync(path, 'utf8')), testId);
}

export function verifyDockerCaseIsolation(value, config, name) {
  assert.match(value.Id, /^[a-f0-9]{64}$/); assert.equal(value.Name, '/' + name); assert.equal(value.Image, config.image);
  assert.equal(value.Config.Labels['bondbuddy.pr-gate.run'], config.run_id);
  assert.equal(value.Config.Labels['bondbuddy.pr-gate.scope'], config.prefix);
  assert.equal(value.Config.User, '1000:1000'); assert.equal(value.HostConfig.Privileged, false);
  assert.equal(value.HostConfig.ReadonlyRootfs, true);
  assert.ok(value.HostConfig.CapDrop.includes('ALL') && !value.HostConfig.CapAdd?.length);
  assert.ok(value.HostConfig.SecurityOpt.includes('no-new-privileges'));
  assert.equal(value.HostConfig.NetworkMode, config.profile_id === 'docker-backup' ? config.network : 'none');
  assert.ok(!value.HostConfig.PortBindings || !Object.keys(value.HostConfig.PortBindings).length);
  assert.equal(value.HostConfig.Memory, 512 * 1024 ** 2); assert.equal(value.HostConfig.MemorySwap, 512 * 1024 ** 2);
  assert.equal(value.HostConfig.PidsLimit, 128); assert.equal(value.HostConfig.NanoCpus, 1_000_000_000);
  const mounts = value.Mounts.map(row => ({ destination: row.Destination, type: row.Type, rw: row.RW, name: row.Name })).sort((a,b) => a.destination.localeCompare(b.destination));
  if (config.profile_id === 'docker-credentials') {
    assert.equal(mounts.length, 2);
    assert.deepEqual(mounts.map(row => [row.destination, row.type, row.rw]), [['/run/secrets/bb-copilot-oauth','bind',false],['/usr/local/bin/bb-copilot-token','bind',false]]);
  } else {
    assert.equal(mounts.length, 2);
    assert.ok(mounts.some(row => row.destination === '/app' && row.type === 'volume' && row.name === config.app_volume && !row.rw));
    assert.ok(mounts.some(row => row.destination === '/backup' && row.type === 'bind' && row.rw));
    assert.ok(value.HostConfig.Tmpfs?.['/tmp']?.includes('rw'));
  }
  return { id: value.Id, name, image: value.Image, user: '1000:1000', network: value.HostConfig.NetworkMode, rootfs_readonly: true,
    privileged: false, cap_drop: ['ALL'], no_new_privileges: true, memory: value.HostConfig.Memory, memory_swap: value.HostConfig.MemorySwap,
    nano_cpus: value.HostConfig.NanoCpus, pids_limit: value.HostConfig.PidsLimit, mounts };
}

/** Execute one original case on the host's local engine; never mount its socket. */
export function runOwnedDocker(config, args, { timeout = 30000 } = {}) {
  validateDockerConfig(config, config.test_id);
  const trace = JSON.parse(readFileSync(config.trace, 'utf8')), index = trace.length + 1, name = config.prefix + '-case-' + index;
  const limit = config.profile_id === 'docker-credentials' ? 4 : 5;
  assert.ok(index <= limit, 'Unexpected extra Docker case');
  assert.ok(!args.some(arg => ['--name','--label','--cidfile','--rm','--privileged','--cap-add','--publish','-p'].includes(arg)));
  const row = { index, name, commands: [], started_at: new Date().toISOString(), cleanup: { status: 'pending' } };
  trace.push(row); const save = () => writeFileSync(config.trace, JSON.stringify(trace, null, 2) + '\n'); save();
  const command = (commandArgs, budget = 30000) => {
    const start = Date.now(), result = spawnSync('docker', ['--context', config.context, ...commandArgs], {
      encoding: 'utf8', env: hostEnvironment(), windowsHide: true, timeout: budget, maxBuffer: 8 * 1024 * 1024 });
    row.commands.push({ args: commandArgs, status: result.status, signal: result.signal, durationMs: Date.now() - start,
      stdout_sha256: hash(result.stdout ?? ''), stderr_sha256: hash(result.stderr ?? ''), error: result.error?.message ?? null }); save();
    return result;
  };
  const must = args => { const result = command(args); assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  let id, execution, failure;
  try {
    const absent = command(['inspect', name]);
    assert.ok(absent.status !== 0 && /no such (object|container)/i.test(absent.stderr), 'Never adopt an existing Docker case');
    id = must(['create', '--pull', 'never', '--name', name, '--label', 'bondbuddy.pr-gate.run=' + config.run_id,
      '--label', 'bondbuddy.pr-gate.scope=' + config.prefix, '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--cpus', '1', '--memory', '512m', '--memory-swap', '512m', '--pids-limit', '128', ...args]);
    row.isolation = verifyDockerCaseIsolation(JSON.parse(must(['inspect', id]))[0], config, name); save();
    execution = command(['start', '-a', id], timeout);
    // Docker start exits with the CLI status; inspect retains the actual process exit.
    const finished = JSON.parse(must(['inspect', id]))[0];
    assert.equal(finished.State.Running, false, 'Docker case still running');
    assert.equal(execution.status, finished.State.ExitCode, 'CLI and original process status differ');
    row.status = execution.status; row.signal = execution.signal; row.error = execution.error?.message ?? null;
  } catch (error) { failure = error; row.error = error.message; }
  finally {
    try {
      if (id) {
        const current = JSON.parse(must(['inspect', id]))[0];
        assert.equal(current.Id, id); assert.equal(current.Name, '/' + name);
        assert.equal(current.Config.Labels['bondbuddy.pr-gate.run'], config.run_id); assert.equal(current.Config.Labels['bondbuddy.pr-gate.scope'], config.prefix);
        must(['rm', '--force', '--volumes', id]);
        const absent = command(['inspect', id]); assert.ok(absent.status !== 0 && /no such (object|container)/i.test(absent.stderr));
      }
      row.cleanup = { status: 'passed' };
    } catch (error) { row.cleanup = { status: 'failed', error: error.message }; failure = error; }
    row.finished_at = new Date().toISOString(); save();
  }
  if (failure) throw failure;
  return execution;
}
