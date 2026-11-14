import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectInternalAttachment, inspectInternalNetwork, networkIdentity, NETWORK_ROUTE_PROBE, verifyInternalRoutes } from '../internal-network.mjs';
import { sha256, verifyExecution } from '../host-dispatch-protocol.mjs';
import { dockerCommands, narrowedSeccomp, removeContainer } from './native.mjs';
import { SERVICE_AUTHORING_TESTS, SERVICE_AUTHORING_PROFILE, SERVICE_AUTHORING_HELPER,
  SERVICE_AUTHORING_FILES, SERVICE_AUTHORING_ENVIRONMENT, SERVICE_AUTHORING_CANARY, serviceAuthoringEnvCommand } from './native-services-runtime.mjs';

const ID = /^[a-f0-9]{64}$/;
const hostPath = value => value.replaceAll('\\', '/').replace(/\/$/, '');
const mountSource = value => hostPath(value).replace(/^([a-z]):\//i, (_, drive) => '/__drive__/' + drive.toLowerCase() + '/')
  .replace(/^\/(?:run\/desktop\/mnt\/host|host_mnt)\/([a-z])\//i, (_, drive) => '/__drive__/' + drive.toLowerCase() + '/');
function fileHash(path) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), fd = openSync(path, 'r');
  try { for (;;) { const size = readSync(fd, buffer, 0, buffer.length, null); if (!size) break; hash.update(buffer.subarray(0, size)); } }
  finally { closeSync(fd); }
  return hash.digest('hex');
}

export function validateServiceAuthoringRequest({ candidate, runId, entry, runtime }) {
  for (const key of ['commit', 'tree']) assert.match(candidate[key], /^[a-f0-9]{40}$/);
  assert.match(runId, /^[a-zA-Z0-9-]{8,80}$/);
  assert.ok(Object.hasOwn(SERVICE_AUTHORING_TESTS, entry.testId), 'Only the two original service authoring files may run');
  assert.equal(entry.runPath, SERVICE_AUTHORING_TESTS[entry.testId].run);
  assert.equal(entry.profileId, SERVICE_AUTHORING_PROFILE); assert.equal(entry.group, 'worker'); assert.equal(entry.runner, 'node');
  assert.equal(entry.fileTimeoutMs, 300_000); assert.ok(Number.isSafeInteger(entry.sequence) && entry.sequence >= 0);
  for (const key of ['args', 'argv', 'env', 'command', 'cwd', 'executable']) assert.equal(Object.hasOwn(entry, key), false);
  assert.deepEqual(runtime.candidate, candidate); assert.equal(runtime.runId, runId); assert.match(runtime.imageId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(runtime.evidence.image_id, runtime.imageId); assert.match(runtime.core?.id, ID); assert.equal(runtime.core.name, 'bb-pr-gate-' + runId);
  assert.equal(runtime.evidence.core_container_id, runtime.core.id);
  const network = runtime.core.network; assert.match(network?.id, ID);
  assert.deepEqual(networkIdentity(runId), { schema: network.schema, run_id: network.run_id, name: network.name });
  assert.deepEqual(runtime.evidence.core_network, { schema: network.schema, id: network.id, name: network.name, run_id: network.run_id });
  assert.equal(runtime.volume, 'bb-pr-gate-native-' + runId);
  for (const key of ['commit', 'tree']) assert.equal(runtime.evidence.source[key], candidate[key]);
  for (const file of SERVICE_AUTHORING_FILES) assert.match(runtime.evidence.source.files[file], ID);
  assert.equal(runtime.evidence.source.files[entry.testId], entry.sourceSha256);
}

export function verifyServiceAuthoringIsolation(value, { runtime, name, directory }) {
  assert.match(value.Id, ID); assert.equal(value.Name, '/' + name); assert.equal(value.Image, runtime.imageId);
  assert.equal(value.Config.User, '1000:1000'); assert.equal(value.Config.WorkingDir, '/app');
  assert.equal(value.Config.Labels['bondbuddy.pr-gate.run'], runtime.runId); assert.equal(value.Config.Labels['bondbuddy.pr-gate.profile'], SERVICE_AUTHORING_PROFILE);
  assert.deepEqual(value.Config.Entrypoint, ['/usr/bin/env']); assert.deepEqual(value.Config.Cmd, serviceAuthoringEnvCommand(['sleep', 'infinity']).slice(1));
  const config = value.HostConfig;
  assert.equal(config.NetworkMode, 'container:' + runtime.core.id); assert.deepEqual(Object.keys(value.NetworkSettings?.Networks ?? {}), []);
  assert.equal(config.ReadonlyRootfs, true); assert.equal(config.Privileged, false); assert.deepEqual(config.CapDrop, ['ALL']); assert.ok(!config.CapAdd?.length);
  assert.ok(config.SecurityOpt.includes('no-new-privileges')); assert.ok(config.SecurityOpt.some(option => option.startsWith('seccomp=')));
  if (runtime.security.includes('name=apparmor')) assert.ok(config.SecurityOpt.includes('apparmor=bondbuddy-codex-v1'));
  assert.equal(config.Init, true); assert.equal(config.NanoCpus, 1_000_000_000); assert.equal(config.Memory, 2 * 1024 ** 3);
  assert.equal(config.MemorySwap, 2 * 1024 ** 3); assert.equal(config.PidsLimit, 256); assert.equal(config.ShmSize, 256 * 1024 ** 2);
  assert.ok(!Object.keys(config.PortBindings ?? {}).length); assert.ok(!config.Devices?.length); assert.ok(!config.DeviceRequests?.length);
  assert.ok(!config.ExtraHosts?.length); assert.ok(!config.Links?.length);
  assert.deepEqual(config.Tmpfs, { '/tmp': 'rw,nosuid,nodev,size=1073741824,mode=1777' });
  const mounts = value.Mounts.map(row => ({ destination: row.Destination, type: row.Type, rw: row.RW,
    ...(row.Type === 'volume' ? { name: row.Name } : { source: mountSource(row.Source) }) })).sort((a, b) => a.destination.localeCompare(b.destination));
  assert.deepEqual(mounts, [
    { destination: '/app', type: 'volume', rw: false, name: runtime.volume },
    { destination: '/evidence', type: 'bind', rw: true, source: mountSource(directory) },
    { destination: '/run/secrets/bb-copilot-oauth', type: 'bind', rw: false, source: mountSource(join(runtime.directory, 'synthetic-secret')) },
    { destination: '/transfer', type: 'bind', rw: false, source: mountSource(runtime.directory) },
  ]);
  return { id: value.Id, name, image: value.Image, core_id: runtime.core.id, network: config.NetworkMode, user: '1000:1000',
    rootfs_readonly: true, privileged: false, cap_drop: ['ALL'], no_new_privileges: true, security_options: config.SecurityOpt,
    nano_cpus: config.NanoCpus, memory: config.Memory, memory_swap: config.MemorySwap, pids_limit: config.PidsLimit,
    shm_size: config.ShmSize, mounts, tmpfs: config.Tmpfs, published_ports: 0 };
}

function verifyNetworkEvidence(record, runtime, runId) {
  const network = runtime.core_network, inspection = record.inspection, attachment = record.attachment;
  assert.deepEqual(networkIdentity(runId), { schema: network.schema, run_id: network.run_id, name: network.name });
  assert.match(network.id, ID); assert.equal(record.core_id, runtime.core_container_id);
  assert.equal(inspection.id, network.id); assert.equal(inspection.name, network.name); assert.equal(inspection.run_id, runId);
  assert.equal(inspection.driver, 'bridge'); assert.equal(inspection.scope, 'local'); assert.equal(inspection.internal, true);
  for (const field of ['attachable', 'ingress', 'ipv6']) assert.equal(inspection[field], false);
  assert.deepEqual(inspection.labels, { 'com.bondbuddy.pr-gate.run-id': runId, 'com.bondbuddy.pr-gate.network-schema': network.schema });
  assert.deepEqual(inspection.options, { 'com.docker.network.bridge.enable_ip_masquerade': 'false', 'com.docker.network.enable_ipv4': 'true' });
  assert.equal(inspection.members.length, 1); const member = inspection.members[0]; assert.equal(member.id, runtime.core_container_id);
  assert.equal(member.name, 'bb-pr-gate-' + runId); assert.match(member.endpoint_id, ID);
  assert.equal(member.endpoint_id, attachment.endpoint_id); assert.equal(member.ipv4, `${attachment.ipv4}/${attachment.prefix_length}`); assert.equal(member.ipv6, '');
  assert.equal(attachment.network_id, network.id); assert.equal(attachment.network_name, network.name); assert.deepEqual(attachment.dns, ['127.0.0.1']);
  assert.equal(record.routes.status, 'passed'); assert.equal(record.routes.public_probe_requests, 0); verifyInternalRoutes(record.routes, attachment);
}

export function verifyServiceAuthoringEvidence(evidence, entry, runtime) {
  assert.ok(Object.hasOwn(SERVICE_AUTHORING_TESTS, entry.testId)); assert.equal(entry.runPath, SERVICE_AUTHORING_TESTS[entry.testId].run); assert.equal(entry.profileId, SERVICE_AUTHORING_PROFILE);
  assert.equal(evidence.test_id, entry.testId); assert.equal(evidence.profile_id, entry.profileId); assert.equal(evidence.run_id, runtime.run_id);
  assert.equal(evidence.source_bundle_sha256, runtime.bundle_sha256); assert.equal(evidence.test_source_sha256, entry.sourceSha256);
  assert.equal(runtime.source.files[entry.testId], entry.sourceSha256); assert.equal(evidence.core_id, runtime.core_container_id);
  const sourceFiles = Object.fromEntries(SERVICE_AUTHORING_FILES.map(file => { assert.match(runtime.source.files[file], ID); return [file, runtime.source.files[file]]; }));
  for (const key of ['commit', 'tree']) { assert.equal(evidence[key], runtime[key]); assert.equal(evidence.probe[key], runtime[key]); assert.equal(evidence.after[key], runtime[key]); }
  for (const record of [evidence.probe, evidence.after]) {
    assert.equal(record.status, 'passed'); assert.equal(record.uid, 1000); assert.equal(record.models, 0); assert.equal(record.network, 'core-internal');
    assert.deepEqual(record.security, { CapEff: '0000000000000000', NoNewPrivs: '1', Seccomp: '2' }); assert.deepEqual(record.source_files, sourceFiles);
    assert.equal(record.synthetic_canary_sha256, sha256(SERVICE_AUTHORING_CANARY));
    assert.equal(record.node.executable, '/usr/local/bin/node'); assert.match(record.node.sha256, ID); assert.match(record.node.version, /^v\d+\.\d+\.\d+$/);
  }
  assert.deepEqual(evidence.after.node, evidence.probe.node); assert.equal(evidence.probe.profile, SERVICE_AUTHORING_PROFILE);
  assert.equal(evidence.probe.checks.original_permission_probe, true); assert.equal(evidence.probe.checks.python_authoring, 'BB_AUTHORING_IMPORTS_OK');
  for (const [name, executable] of [['python', '/opt/venv/bin/python'], ['codex', '/usr/local/bin/codex'], ['bwrap', '/usr/bin/bwrap']]) {
    const tool = evidence.probe.checks.tools[name]; assert.equal(tool.executable, executable); assert.match(tool.sha256, ID); assert.ok(tool.version.length > 0);
  }
  assert.equal(evidence.probe.database.name, 'bb_m4_core'); assert.equal(evidence.probe.database.username, 'bondbuddy');
  assert.ok(evidence.probe.database.version >= 160000 && evidence.probe.database.version < 170000);
  assert.deepEqual(evidence.probe.blob, { endpoint: 'http://127.0.0.1:10000/devstoreaccount1', readable: true });
  for (const phase of ['before', 'after']) verifyNetworkEvidence(evidence.network[phase], runtime, evidence.run_id);
  for (const key of ['core_id', 'attachment', 'inspection']) assert.deepEqual(evidence.network.after[key], evidence.network.before[key]);
  const isolation = evidence.isolation; assert.match(isolation.id, ID); assert.equal(isolation.image, runtime.image_id);
  assert.equal(isolation.name, 'bb-pr-gate-authoring-' + runtime.run_id + '-' + entry.sequence);
  assert.equal(isolation.core_id, runtime.core_container_id); assert.equal(isolation.network, 'container:' + runtime.core_container_id); assert.equal(isolation.user, '1000:1000');
  assert.equal(isolation.rootfs_readonly, true); assert.equal(isolation.privileged, false); assert.equal(isolation.no_new_privileges, true); assert.deepEqual(isolation.cap_drop, ['ALL']);
  assert.ok(isolation.security_options.includes('no-new-privileges')); assert.ok(isolation.security_options.some(value => value.startsWith('seccomp=')));
  assert.equal(isolation.nano_cpus, 1e9); assert.equal(isolation.memory, 2 * 1024 ** 3); assert.equal(isolation.memory_swap, 2 * 1024 ** 3);
  assert.equal(isolation.pids_limit, 256); assert.equal(isolation.shm_size, 256 * 1024 ** 2); assert.equal(isolation.published_ports, 0);
  assert.deepEqual(isolation.tmpfs, { '/tmp': 'rw,nosuid,nodev,size=1073741824,mode=1777' });
  assert.deepEqual(isolation.mounts.map(({ source: _source, ...row }) => row), [
    { destination: '/app', type: 'volume', rw: false, name: 'bb-pr-gate-native-' + runtime.run_id },
    { destination: '/evidence', type: 'bind', rw: true }, { destination: '/run/secrets/bb-copilot-oauth', type: 'bind', rw: false }, { destination: '/transfer', type: 'bind', rw: false },
  ]);
  const command = evidence.original_command; assert.equal(command.command, '/usr/local/bin/node'); assert.equal(command.cwd, '/app');
  assert.deepEqual(command.args, ['--test', '--test-reporter=tap', '/app/' + entry.runPath]); assert.equal(command.timeout_ms, 300_000); assert.equal(command.timeout_ms, entry.fileTimeoutMs);
  assert.deepEqual(command.environment, SERVICE_AUTHORING_ENVIRONMENT); assert.equal(command.output_limit_failed, false); assert.equal(command.cancelled, false);
  const calls = evidence.commands.filter(row => row.label === 'original-test'); assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, 'docker'); assert.equal(calls[0].args[0], '--context'); assert.ok(calls[0].args[1].length > 0);
  assert.deepEqual(calls[0].args.slice(2), ['exec', isolation.id, ...serviceAuthoringEnvCommand([command.command, ...command.args])]);
  for (const key of ['code', 'signal', 'timedOut', 'durationMs', 'stdout_sha256', 'stderr_sha256', 'output_limit_failed', 'cancelled']) assert.equal(command[key], calls[0][key]);
  assert.equal(evidence.cleanup.status, 'passed'); assert.equal(evidence.cleanup.removed_id, isolation.id); assert.equal(evidence.cleanup.absence_confirmed, true);
  assert.equal(evidence.source_before, runtime.bundle_sha256); assert.equal(evidence.source_after, evidence.source_before);
  assert.deepEqual(Object.keys(evidence.services_before).sort(), ['blob', 'pg']);
  for (const service of Object.values(evidence.services_before)) { assert.match(service.id, ID); assert.match(service.image, /^sha256:[a-f0-9]{64}$/); assert.equal(service.network, 'container:' + runtime.core_container_id); }
  assert.deepEqual(evidence.services_after, evidence.services_before);
}

export async function executeServiceAuthoring(options) {
  validateServiceAuthoringRequest(options);
  const { candidate, runId, entry, runtime, signal, evidenceRoot: directory } = options;
  const name = 'bb-pr-gate-authoring-' + runId + '-' + entry.sequence;
  const evidence = { ...candidate, run_id: runId, test_id: entry.testId, profile_id: SERVICE_AUTHORING_PROFILE, started_at: new Date().toISOString(),
    commands: [], resources: [], source_bundle_sha256: runtime.evidence.bundle_sha256, test_source_sha256: entry.sourceSha256,
    core_id: runtime.core.id, cleanup: { status: 'pending' }, network: {} };
  const docker = dockerCommands({ context: runtime.context, directory, evidence, signal });
  let id, execution, failure;
  const identity = async cleanup => {
    const core = JSON.parse((await docker('core-identity', ['inspect', runtime.core.id], { cleanup, privateCapture: true })).stdout)[0];
    assert.equal(core.Id, runtime.core.id); assert.equal(core.Name, '/' + runtime.core.name); assert.equal(core.Image, runtime.evidence.core_image_id); assert.equal(core.State.Running, true);
    const attachment = inspectInternalAttachment(core, runtime.core.network);
    const raw = JSON.parse((await docker('network-identity', ['network', 'inspect', runtime.core.network.id], { cleanup })).stdout)[0];
    const inspection = inspectInternalNetwork(raw, runtime.core.network, [runtime.core.id]);
    const services = {};
    for (const suffix of ['pg', 'blob']) {
      const service = JSON.parse((await docker(suffix + '-identity', ['inspect', runtime.core.name + '-' + suffix], { cleanup, privateCapture: true })).stdout)[0];
      assert.match(service.Id, ID); assert.match(service.Image, /^sha256:[a-f0-9]{64}$/); assert.equal(service.Name, '/' + runtime.core.name + '-' + suffix); assert.equal(service.State.Running, true);
      assert.ok(['container:' + runtime.core.id, 'container:' + runtime.core.name].includes(service.HostConfig.NetworkMode));
      assert.equal(service.HostConfig.Privileged, false); assert.ok(!Object.keys(service.HostConfig.PortBindings ?? {}).length);
      if (suffix === 'pg') for (const setting of ['POSTGRES_USER=bondbuddy', 'POSTGRES_PASSWORD=synthetic-ci-only', 'POSTGRES_DB=bb_m4_core']) assert.ok(service.Config.Env.includes(setting));
      services[suffix] = { id: service.Id, image: service.Image, network: 'container:' + runtime.core.id };
    }
    return { attachment, inspection, services };
  };
  const auditNetwork = async (value, cleanup) => {
    const routes = JSON.parse((await docker('routes', ['exec', id, ...serviceAuthoringEnvCommand(['node', '--input-type=module', '-e', NETWORK_ROUTE_PROBE])], { cleanup })).stdout);
    return { core_id: runtime.core.id, attachment: value.attachment, inspection: value.inspection, routes: verifyInternalRoutes(routes, value.attachment) };
  };
  try {
    const endpoint = (await docker('local-engine', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])).stdout.trim(); assert.match(endpoint, /^(unix|npipe):\/\//);
    evidence.source_before = fileHash(join(runtime.directory, 'native-app.tar')); assert.equal(evidence.source_before, runtime.evidence.bundle_sha256);
    assert.equal(readFileSync(join(runtime.directory, 'synthetic-secret'), 'utf8'), SERVICE_AUTHORING_CANARY);
    const originalSeccomp = readFileSync(join(runtime.sourceRoot, 'deploy/m1/security/codex-seccomp.json'));
    assert.equal(sha256(originalSeccomp), runtime.evidence.source.files['deploy/m1/security/codex-seccomp.json']);
    assert.deepEqual(JSON.parse(readFileSync(join(runtime.directory, 'native-sandbox.json'))), narrowedSeccomp(JSON.parse(originalSeccomp)));
    const before = await identity(false); evidence.services_before = before.services;
    const absent = await docker('container-must-be-new', ['inspect', name], { allowFailure: true }); assert.ok(absent.code !== 0 && /no such (object|container)/i.test(absent.stderr));
    const args = ['create', '--pull', 'never', '--name', name, '--label', 'bondbuddy.pr-gate.run=' + runId, '--label', 'bondbuddy.pr-gate.profile=' + SERVICE_AUTHORING_PROFILE,
      '--user', '1000:1000', '--workdir', '/app', '--init', '--network', 'container:' + runtime.core.id, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--security-opt', 'seccomp=' + hostPath(join(runtime.directory, 'native-sandbox.json')), '--cpus', '1', '--memory', '2g', '--memory-swap', '2g', '--pids-limit', '256', '--shm-size', '256m',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=1073741824,mode=1777', '--mount', `type=volume,source=${runtime.volume},target=/app,readonly,volume-nocopy`,
      '--mount', `type=bind,source=${directory},target=/evidence`, '--mount', `type=bind,source=${runtime.directory},target=/transfer,readonly`,
      '--mount', `type=bind,source=${join(runtime.directory, 'synthetic-secret')},target=/run/secrets/bb-copilot-oauth,readonly`];
    if (runtime.security.includes('name=apparmor')) args.push('--security-opt', 'apparmor=bondbuddy-codex-v1');
    args.push('--entrypoint', '/usr/bin/env', runtime.imageId, ...serviceAuthoringEnvCommand(['sleep', 'infinity']).slice(1));
    id = (await docker('create', args)).stdout.trim(); assert.match(id, ID); evidence.resources.push({ kind: 'container', id, name, image: runtime.imageId });
    evidence.isolation = verifyServiceAuthoringIsolation(JSON.parse((await docker('isolation', ['inspect', id], { privateCapture: true })).stdout)[0], { runtime, name, directory });
    await docker('start', ['start', id]); evidence.network.before = await auditNetwork(before, false);
    evidence.probe = JSON.parse((await docker('probe', ['exec', id, ...serviceAuthoringEnvCommand(['/usr/local/bin/node', '/app/' + SERVICE_AUTHORING_HELPER, 'probe'])], { timeout: 120_000 })).stdout);
    assert.equal(evidence.probe.status, 'passed');
    const testArgs = ['--test', '--test-reporter=tap', '/app/' + entry.runPath];
    execution = verifyExecution(await docker('original-test', ['exec', id, ...serviceAuthoringEnvCommand(['/usr/local/bin/node', ...testArgs])], { timeout: entry.fileTimeoutMs, allowFailure: true }));
    const recorded = evidence.commands.find(row => row.label === 'original-test');
    evidence.original_command = { command: '/usr/local/bin/node', args: testArgs, cwd: '/app', environment: SERVICE_AUTHORING_ENVIRONMENT, timeout_ms: entry.fileTimeoutMs,
      ...Object.fromEntries(['code', 'signal', 'timedOut', 'durationMs', 'stdout_sha256', 'stderr_sha256', 'output_limit_failed', 'cancelled'].map(key => [key, recorded[key]])) };
    evidence.after = JSON.parse((await docker('verify-after', ['exec', id, ...serviceAuthoringEnvCommand(['/usr/local/bin/node', '/app/' + SERVICE_AUTHORING_HELPER, 'verify'])])).stdout);
  } catch (error) { failure = error; }
  finally {
    const errors = [];
    if (id) {
      try {
        const after = await identity(true); evidence.services_after = after.services; evidence.network.after = await auditNetwork(after, true);
        verifyServiceAuthoringIsolation(JSON.parse((await docker('cleanup-isolation', ['inspect', id], { cleanup: true, privateCapture: true })).stdout)[0], { runtime, name, directory });
      } catch (error) { errors.push(error.message); }
      try { await removeContainer(runtime, docker, id, name); evidence.cleanup = { status: 'passed', removed_id: id, absence_confirmed: true }; }
      catch (error) { errors.push(error.message); }
    }
    try { evidence.source_after = fileHash(join(runtime.directory, 'native-app.tar')); assert.equal(evidence.source_after, evidence.source_before); }
    catch (error) { errors.push(error.message); }
    if (errors.length || !id) evidence.cleanup = { status: errors.length ? 'failed' : 'passed', errors };
    evidence.finished_at = new Date().toISOString(); writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    if (errors.length) failure = new Error([failure?.message, ...errors].filter(Boolean).join('; '));
  }
  if (failure) { failure.execution = execution; failure.evidence = evidence; throw failure; }
  try { verifyServiceAuthoringEvidence(evidence, entry, runtime.evidence); } catch (error) { error.execution = execution; error.evidence = evidence; throw error; }
  return { execution, evidence };
}
