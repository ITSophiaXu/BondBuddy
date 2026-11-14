import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEMPLATE_DATABASE } from '../capabilities.mjs';
import { inspectInternalAttachment, inspectInternalNetwork, NETWORK_ROUTE_PROBE, verifyInternalRoutes } from '../internal-network.mjs';
import { dockerCommands, removeContainer } from './native.mjs';

export const STORAGE_TEST = 'apps/api/src/storage-lifecycle.test.ts';
export const STORAGE_PROFILE = 'postgres-storage';
const helper = 'scripts/pr-gate/host-adapters/storage-postgres-runtime.mjs';
const environment = Object.freeze({ PATH: '/usr/lib/postgresql/16/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: '/tmp', LANG: 'C.UTF-8', TMPDIR: '/tmp', CI: '1', BB_TEST_DATABASE_URL: TEMPLATE_DATABASE,
  BB_TEST_AZURITE_CONNECTION_STRING: 'UseDevelopmentStorage=true', BB_TEST_LIVE_AUTHORING: '0', BB_PLATFORM_PROBE_ENABLED: '0', BB_REVIEW_WEB_SEARCH_ENABLED: '0' });
const envCommand = args => ['/usr/bin/env', '-i', ...Object.entries(environment).map(([key, value]) => key + '=' + value), ...args];
function fileHash(path) {
  const value = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), fd = openSync(path, 'r');
  try { for (;;) { const size = readSync(fd, buffer, 0, buffer.length, null); if (!size) break; value.update(buffer.subarray(0, size)); } }
  finally { closeSync(fd); }
  return value.digest('hex');
}

export function validateStorageRequest({ candidate, runId, entry, runtime }) {
  for (const key of ['commit', 'tree']) assert.match(candidate[key], /^[a-f0-9]{40}$/);
  assert.match(runId, /^[a-zA-Z0-9-]{8,80}$/);
  assert.equal(entry.testId, STORAGE_TEST); assert.equal(entry.profileId, STORAGE_PROFILE); assert.equal(entry.group, 'api');
  assert.equal(entry.runner, 'node'); assert.equal(entry.runPath, 'apps/api/dist/storage-lifecycle.test.js'); assert.equal(entry.fileTimeoutMs, 300000);
  assert.ok(Number.isSafeInteger(entry.sequence) && entry.sequence >= 0);
  for (const key of ['args', 'argv', 'env', 'command', 'cwd', 'executable']) assert.equal(Object.hasOwn(entry, key), false);
  assert.deepEqual(runtime.candidate, candidate); assert.equal(runtime.runId, runId);
  assert.match(runtime.core?.id, /^[a-f0-9]{64}$/); assert.equal(runtime.core.name, 'bb-pr-gate-' + runId);
  assert.equal(runtime.core.network?.run_id, runId, 'Storage capability requires this run\'s owned internal network');
  assert.equal(runtime.evidence.core_container_id, runtime.core.id);
  assert.equal(runtime.evidence.core_network_id, runtime.core.network.id);
  assert.equal(runtime.evidence.source.files[entry.testId], entry.sourceSha256);
  assert.match(runtime.evidence.node_cache?.sha256, /^[a-f0-9]{64}$/);
  assert.equal(runtime.evidence.node_cache.platform, 'linux');
}

export function verifyStorageImage(value, expectedId, node) {
  assert.match(expectedId, /^sha256:[a-f0-9]{64}$/); assert.equal(value.Id, expectedId); assert.equal(value.Os, 'linux');
  assert.equal(value.Architecture, node.arch === 'x64' ? 'amd64' : node.arch);
  assert.deepEqual(Object.keys(value.Config.Volumes ?? {}), ['/var/lib/postgresql/data']);
  assert.ok(value.Config.Env.includes('PG_MAJOR=16'));
  assert.ok(value.Config.Env.every(row => !/(TOKEN|PASSWORD|SECRET|API_KEY|CREDENTIAL)/i.test(row.split('=')[0])));
  return { id: value.Id, os: value.Os, architecture: value.Architecture, pg_major: 16, data_volume: '/var/lib/postgresql/data' };
}

export function verifyStorageIsolation(value, { imageId, coreId, volume, name, runId }) {
  assert.match(value.Id, /^[a-f0-9]{64}$/); assert.equal(value.Name, '/' + name); assert.equal(value.Image, imageId);
  assert.equal(value.Config.User, '1000:1000'); assert.equal(value.Config.WorkingDir, '/app');
  assert.equal(value.Config.Labels['bondbuddy.pr-gate.run'], runId); assert.equal(value.Config.Labels['bondbuddy.pr-gate.profile'], STORAGE_PROFILE);
  assert.equal(value.HostConfig.NetworkMode, 'container:' + coreId); assert.equal(value.HostConfig.ReadonlyRootfs, true);
  assert.equal(value.HostConfig.Privileged, false); assert.deepEqual(value.HostConfig.CapDrop, ['ALL']); assert.ok(!value.HostConfig.CapAdd?.length);
  assert.ok(value.HostConfig.SecurityOpt.includes('no-new-privileges')); assert.equal(value.HostConfig.Init, true);
  assert.equal(value.HostConfig.NanoCpus, 1_000_000_000); assert.equal(value.HostConfig.Memory, 2 * 1024 ** 3);
  assert.equal(value.HostConfig.MemorySwap, 2 * 1024 ** 3); assert.equal(value.HostConfig.PidsLimit, 256);
  assert.ok(!Object.keys(value.HostConfig.PortBindings ?? {}).length);
  assert.deepEqual(Object.keys(value.HostConfig.Tmpfs).sort(), ['/tmp', '/var/lib/postgresql/data']);
  assert.equal(value.HostConfig.Tmpfs['/tmp'], 'rw,nosuid,nodev,size=1073741824,mode=1777');
  assert.equal(value.HostConfig.Tmpfs['/var/lib/postgresql/data'], 'ro,nosuid,nodev,noexec,size=1048576');
  const mounts = value.Mounts.map(row => ({ destination: row.Destination, type: row.Type, rw: row.RW, ...(row.Type === 'volume' ? { name: row.Name } : {}) })).sort((a, b) => a.destination.localeCompare(b.destination));
  assert.deepEqual(mounts, [{ destination: '/app', type: 'volume', rw: false, name: volume }, { destination: '/evidence', type: 'bind', rw: true }, { destination: '/transfer', type: 'bind', rw: false }]);
  return { id: value.Id, name, image: imageId, core_id: coreId, network: 'container:' + coreId, user: '1000:1000', rootfs_readonly: true,
    privileged: false, cap_drop: ['ALL'], no_new_privileges: true, init: true, nano_cpus: value.HostConfig.NanoCpus,
    memory: value.HostConfig.Memory, memory_swap: value.HostConfig.MemorySwap, pids_limit: value.HostConfig.PidsLimit,
    mounts, tmpfs: value.HostConfig.Tmpfs, published_ports: 0 };
}

export function verifyStorageEvidence(evidence, entry, runtime) {
  assert.equal(evidence.test_id, STORAGE_TEST); assert.equal(evidence.profile_id, STORAGE_PROFILE);
  assert.equal(evidence.source_bundle_sha256, runtime.bundle_sha256); assert.equal(evidence.test_source_sha256, entry.sourceSha256);
  assert.equal(runtime.source.files[entry.testId], entry.sourceSha256);
  assert.deepEqual(evidence.node, runtime.node_cache); assert.deepEqual(evidence.node_after, evidence.node);
  assert.equal(evidence.core_id, runtime.core_container_id); assert.equal(evidence.isolation.core_id, evidence.core_id);
  assert.equal(evidence.isolation.network, 'container:' + evidence.core_id); assert.equal(evidence.isolation.image, evidence.postgres_image.id);
  const isolation = evidence.isolation;
  assert.equal(isolation.user, '1000:1000'); assert.equal(isolation.rootfs_readonly, true); assert.equal(isolation.privileged, false);
  assert.deepEqual(isolation.cap_drop, ['ALL']); assert.equal(isolation.no_new_privileges, true); assert.equal(isolation.init, true);
  assert.equal(isolation.nano_cpus, 1_000_000_000); assert.equal(isolation.memory, 2 * 1024 ** 3); assert.equal(isolation.memory_swap, 2 * 1024 ** 3);
  assert.equal(isolation.pids_limit, 256); assert.equal(isolation.published_ports, 0);
  assert.deepEqual(isolation.mounts, [{ destination: '/app', type: 'volume', rw: false, name: 'bb-pr-gate-native-' + evidence.run_id },
    { destination: '/evidence', type: 'bind', rw: true }, { destination: '/transfer', type: 'bind', rw: false }]);
  assert.deepEqual(isolation.tmpfs, { '/tmp': 'rw,nosuid,nodev,size=1073741824,mode=1777', '/var/lib/postgresql/data': 'ro,nosuid,nodev,noexec,size=1048576' });
  assert.equal(evidence.postgres_image.pg_major, 16); assert.equal(evidence.postgres_service.image, evidence.postgres_image.id);
  assert.equal(evidence.probe.status, 'passed'); assert.deepEqual(evidence.probe.node, evidence.node);
  assert.equal(evidence.probe.uid, 1000); assert.deepEqual(evidence.probe.security, { CapEff: '0000000000000000', NoNewPrivs: '1', Seccomp: '2' });
  assert.deepEqual(evidence.probe.files, runtime.source.files);
  for (const file of [STORAGE_TEST, entry.runPath, 'db/verify-storage-restore.mjs', helper]) assert.match(evidence.probe.files[file], /^[a-f0-9]{64}$/);
  for (const key of ['commit', 'tree']) assert.equal(evidence.probe[key], runtime[key]);
  for (const name of ['pg_dump', 'pg_restore']) {
    const tool = evidence.probe.tools[name]; assert.equal(tool.executable, '/usr/lib/postgresql/16/bin/' + name);
    assert.match(tool.sha256, /^[a-f0-9]{64}$/); assert.match(tool.version, new RegExp('^' + name + ' \\(PostgreSQL\\) 16\\.'));
  }
  assert.equal(evidence.probe.database.name, 'bb_m4_core'); assert.equal(evidence.probe.database.username, 'bondbuddy');
  assert.equal(evidence.probe.database.projects, 'bb_projects');
  assert.ok(evidence.probe.database.version >= 160000 && evidence.probe.database.version < 170000); assert.equal(evidence.probe.models, 0);
  assert.equal(evidence.network.inspection.internal, true); assert.equal(evidence.network.inspection.id, runtime.core_network_id);
  assert.equal(evidence.network.inspection.run_id, evidence.run_id); assert.equal(evidence.network.attachment.network_id, runtime.core_network_id);
  assert.equal(evidence.network.inspection.members.length, 1); assert.equal(evidence.network.inspection.members[0].id, evidence.core_id);
  verifyInternalRoutes(evidence.network.routes, evidence.network.attachment);
  const command = evidence.original_command;
  assert.equal(command.command, '/transfer/native-node'); assert.equal(command.cwd, '/app'); assert.equal(command.timeout_ms, entry.fileTimeoutMs);
  assert.deepEqual(command.args, ['--test', '--test-reporter=tap', '/app/' + entry.runPath]);
  assert.deepEqual(command.environment, environment); assert.equal(evidence.cleanup.status, 'passed');
  const actual = evidence.commands.filter(row => row.label === 'original-test'); assert.equal(actual.length, 1);
  assert.equal(actual[0].executable, 'docker'); assert.equal(actual[0].args[0], '--context'); assert.ok(actual[0].args[1].length > 0);
  assert.equal(actual[0].code, 0); assert.equal(actual[0].timedOut, false); assert.equal(actual[0].cancelled, false); assert.equal(actual[0].output_limit_failed, false);
  assert.deepEqual(actual[0].args.slice(2), ['exec', isolation.id, ...envCommand([command.command, ...command.args])]);
  assert.equal(evidence.cleanup.removed_id, evidence.isolation.id); assert.equal(evidence.cleanup.absence_confirmed, true);
  assert.deepEqual(evidence.source_after, evidence.source_before); assert.equal(evidence.source_before, runtime.bundle_sha256);
}

export async function executeStoragePostgres(options) {
  validateStorageRequest(options);
  const { candidate, runId, entry, runtime, signal, evidenceRoot: directory } = options;
  const name = 'bb-pr-gate-storage-' + runId + '-' + entry.sequence;
  const evidence = { ...candidate, run_id: runId, test_id: entry.testId, profile_id: STORAGE_PROFILE, started_at: new Date().toISOString(),
    commands: [], resources: [], source_bundle_sha256: runtime.evidence.bundle_sha256, test_source_sha256: entry.sourceSha256,
    core_id: runtime.core.id, node: runtime.evidence.node_cache, cleanup: { status: 'pending' } };
  const docker = dockerCommands({ context: runtime.context, directory, evidence, signal });
  let id, execution, failure, isolation;
  const identity = async cleanup => {
    const core = JSON.parse((await docker('core-identity', ['inspect', runtime.core.id], { cleanup, privateCapture: true })).stdout)[0];
    assert.equal(core.Id, runtime.core.id); assert.equal(core.Name, '/' + runtime.core.name); assert.equal(core.Image, runtime.evidence.core_image_id);
    assert.equal(core.State.Running, true);
    const attachment = inspectInternalAttachment(core, runtime.core.network);
    const network = JSON.parse((await docker('network-identity', ['network', 'inspect', runtime.core.network.id], { cleanup })).stdout)[0];
    const inspection = inspectInternalNetwork(network, runtime.core.network, [runtime.core.id]);
    const pg = JSON.parse((await docker('postgres-identity', ['inspect', runtime.core.name + '-pg'], { cleanup, privateCapture: true })).stdout)[0];
    assert.match(pg.Id, /^[a-f0-9]{64}$/); assert.equal(pg.Name, '/' + runtime.core.name + '-pg'); assert.equal(pg.State.Running, true);
    assert.ok(['container:' + runtime.core.id, 'container:' + runtime.core.name].includes(pg.HostConfig.NetworkMode));
    for (const pair of ['POSTGRES_USER=bondbuddy', 'POSTGRES_PASSWORD=synthetic-ci-only', 'POSTGRES_DB=bb_m4_core']) assert.ok(pg.Config.Env.includes(pair));
    return { attachment, inspection, postgres: { id: pg.Id, image: pg.Image } };
  };
  try {
    const endpoint = (await docker('local-engine', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])).stdout.trim();
    assert.match(endpoint, /^(unix|npipe):\/\//);
    evidence.source_before = fileHash(join(runtime.directory, 'native-app.tar')); assert.equal(evidence.source_before, runtime.evidence.bundle_sha256);
    assert.equal(fileHash(join(runtime.directory, 'native-node')), evidence.node.sha256);
    const before = await identity(false); evidence.postgres_service = before.postgres;
    const image = JSON.parse((await docker('postgres-image', ['image', 'inspect', before.postgres.image], { privateCapture: true })).stdout)[0];
    evidence.postgres_image = verifyStorageImage(image, before.postgres.image, evidence.node);
    const absent = await docker('container-must-be-new', ['inspect', name], { allowFailure: true });
    assert.ok(absent.code !== 0 && /no such (object|container)/i.test(absent.stderr));
    id = (await docker('create', ['create', '--pull', 'never', '--name', name, '--label', 'bondbuddy.pr-gate.run=' + runId,
      '--label', 'bondbuddy.pr-gate.profile=' + STORAGE_PROFILE, '--user', '1000:1000', '--workdir', '/app', '--init',
      '--network', 'container:' + runtime.core.id, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--cpus', '1', '--memory', '2g', '--memory-swap', '2g', '--pids-limit', '256',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=1073741824,mode=1777', '--tmpfs', '/var/lib/postgresql/data:ro,nosuid,nodev,noexec,size=1048576',
      '--mount', `type=volume,source=${runtime.volume},target=/app,readonly,volume-nocopy`,
      '--mount', `type=bind,source=${runtime.directory},target=/transfer,readonly`, '--mount', `type=bind,source=${directory},target=/evidence`,
      '--entrypoint', '/usr/bin/env', image.Id, ...envCommand(['sleep', 'infinity']).slice(1)])).stdout.trim();
    assert.match(id, /^[a-f0-9]{64}$/); evidence.resources.push({ kind: 'container', id, name, image: image.Id });
    isolation = { imageId: image.Id, coreId: runtime.core.id, volume: runtime.volume, name, runId };
    evidence.isolation = verifyStorageIsolation(JSON.parse((await docker('isolation', ['inspect', id], { privateCapture: true })).stdout)[0], isolation);
    await docker('start', ['start', id]);
    const routes = JSON.parse((await docker('routes', ['exec', id, ...envCommand(['/transfer/native-node', '--input-type=module', '-e', NETWORK_ROUTE_PROBE])])).stdout);
    evidence.network = { inspection: before.inspection, attachment: before.attachment, routes: verifyInternalRoutes(routes, before.attachment) };
    evidence.probe = JSON.parse((await docker('probe', ['exec', id, ...envCommand(['/transfer/native-node', '/app/' + helper, 'probe'])], { timeout: 30000 })).stdout);
    assert.equal(evidence.probe.status, 'passed');
    const args = ['--test', '--test-reporter=tap', '/app/' + entry.runPath];
    evidence.original_command = { command: '/transfer/native-node', args, cwd: '/app', environment, timeout_ms: entry.fileTimeoutMs };
    execution = await docker('original-test', ['exec', id, ...envCommand(['/transfer/native-node', ...args])], { timeout: entry.fileTimeoutMs, allowFailure: true });
  } catch (error) { failure = error; }
  finally {
    const errors = [];
    if (id) {
      try { verifyStorageIsolation(JSON.parse((await docker('cleanup-isolation', ['inspect', id], { cleanup: true, privateCapture: true })).stdout)[0], isolation); }
      catch (error) { errors.push(error.message); }
      // An isolation failure must still reap the exact owned container. The
      // cleanup helper independently rechecks its ID, name and run label.
      try { await removeContainer(runtime, docker, id, name); evidence.cleanup = { status: 'passed', removed_id: id, absence_confirmed: true }; }
      catch (error) { errors.push(error.message); }
    }
    try {
      evidence.source_after = fileHash(join(runtime.directory, 'native-app.tar')); assert.equal(evidence.source_after, evidence.source_before);
      assert.equal(fileHash(join(runtime.directory, 'native-node')), evidence.node.sha256); evidence.node_after = { ...evidence.node };
      if (evidence.postgres_service) assert.deepEqual((await identity(true)).postgres, evidence.postgres_service);
    } catch (error) { errors.push(error.message); }
    if (errors.length || !id) evidence.cleanup = { status: errors.length ? 'failed' : 'passed', errors };
    evidence.finished_at = new Date().toISOString(); writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    if (errors.length) failure = new Error([failure?.message, ...errors].filter(Boolean).join('; '));
  }
  if (failure) { failure.execution = execution; failure.evidence = evidence; throw failure; }
  if (execution.code === 0) try { verifyStorageEvidence(evidence, entry, runtime.evidence); } catch (error) { error.execution = execution; error.evidence = evidence; throw error; }
  return { execution, evidence };
}
