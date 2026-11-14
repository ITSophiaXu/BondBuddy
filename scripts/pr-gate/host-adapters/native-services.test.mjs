import assert from 'node:assert/strict';
import test from 'node:test';
import { validateServiceAuthoringRequest, verifyServiceAuthoringIsolation, verifyServiceAuthoringEvidence } from './native-services.mjs';
import { syntheticServiceAuthoringEvidence, syntheticServiceAuthoringRuntime } from './native-services.test-fixture.mjs';
import { SERVICE_AUTHORING_TESTS, SERVICE_AUTHORING_PROFILE, serviceAuthoringEnvCommand } from './native-services-runtime.mjs';

const candidate = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, runId = 'synthetic-host-run';
function request(testId = Object.keys(SERVICE_AUTHORING_TESTS)[0]) {
  const evidence = syntheticServiceAuthoringRuntime(candidate, runId);
  return { candidate, runId, entry: { sequence: 0, testId, runPath: SERVICE_AUTHORING_TESTS[testId].run,
    profileId: SERVICE_AUTHORING_PROFILE, group: 'worker', runner: 'node', sourceSha256: 'd'.repeat(64), fileTimeoutMs: 300_000 },
    runtime: { candidate: { ...candidate }, runId, evidence, imageId: evidence.image_id, core: { id: evidence.core_container_id, name: 'bb-pr-gate-' + runId, network: { ...evidence.core_network } },
      volume: 'bb-pr-gate-native-' + runId, directory: '/synthetic/transfer', security: [] } };
}

test('service authoring accepts only the two exact complete worker files and the current owned runtime', () => {
  for (const testId of Object.keys(SERVICE_AUTHORING_TESTS)) assert.doesNotThrow(() => validateServiceAuthoringRequest(request(testId)));
  for (const change of [
    value => { value.entry.testId = 'apps/worker/src/codex-file-authoring.test.ts'; },
    value => { value.entry.runPath = '/tmp/injected.js'; }, value => { value.entry.profileId = 'native-sandbox'; },
    value => { value.entry.group = 'api'; }, value => { value.entry.runner = 'python'; }, value => { value.entry.fileTimeoutMs++; },
    value => { value.entry.env = { BB_TEST_LIVE_AUTHORING: '1' }; }, value => { value.entry.command = 'injected'; },
    value => { value.runtime.candidate.commit = 'f'.repeat(40); }, value => { value.runtime.core.id = '0'.repeat(64); },
    value => { value.runtime.core.network.run_id = 'another-run'; }, value => { value.runtime.evidence.core_network.id = '0'.repeat(64); },
    value => { value.runtime.evidence.source.files[value.entry.testId] = '0'.repeat(64); }, value => { value.runtime.volume = 'unowned-volume'; },
  ]) { const value = structuredClone(request()); change(value); assert.throws(() => validateServiceAuthoringRequest(value)); }
});

test('service authoring isolation rejects a foreign network, widened sandbox and host mounts', () => {
  const { runtime } = request(), name = 'bb-pr-gate-authoring-' + runId + '-0', directory = '/synthetic/evidence';
  const value = { Id: 'b'.repeat(64), Name: '/' + name, Image: runtime.imageId,
    Config: { User: '1000:1000', WorkingDir: '/app', Labels: { 'bondbuddy.pr-gate.run': runId, 'bondbuddy.pr-gate.profile': SERVICE_AUTHORING_PROFILE },
      Entrypoint: ['/usr/bin/env'], Cmd: serviceAuthoringEnvCommand(['sleep', 'infinity']).slice(1) },
    NetworkSettings: { Networks: {} }, HostConfig: { NetworkMode: 'container:' + runtime.core.id, ReadonlyRootfs: true, Privileged: false,
      CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges', 'seccomp=synthetic'], Init: true, NanoCpus: 1e9, Memory: 2 * 1024 ** 3,
      MemorySwap: 2 * 1024 ** 3, PidsLimit: 256, ShmSize: 256 * 1024 ** 2, PortBindings: {}, Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=1073741824,mode=1777' } },
    Mounts: [{ Destination: '/app', Type: 'volume', Name: runtime.volume, RW: false }, { Destination: '/evidence', Type: 'bind', Source: directory, RW: true },
      { Destination: '/run/secrets/bb-copilot-oauth', Type: 'bind', Source: runtime.directory + '/synthetic-secret', RW: false },
      { Destination: '/transfer', Type: 'bind', Source: runtime.directory, RW: false }] };
  const verify = changed => verifyServiceAuthoringIsolation(changed, { runtime, name, directory });
  assert.doesNotThrow(() => verify(value));
  for (const change of [
    v => { v.HostConfig.NetworkMode = 'host'; }, v => { v.HostConfig.NetworkMode = 'none'; },
    v => { v.HostConfig.NetworkMode = 'container:' + '0'.repeat(64); }, v => { v.NetworkSettings.Networks.external = {}; },
    v => { v.Config.User = '0:0'; }, v => { v.Config.Cmd.push('untrusted'); }, v => { v.HostConfig.Privileged = true; },
    v => { v.HostConfig.ReadonlyRootfs = false; }, v => { v.HostConfig.CapAdd.push('SYS_ADMIN'); }, v => { v.HostConfig.SecurityOpt = []; },
    v => { v.HostConfig.PortBindings = { '3000/tcp': [{ HostPort: '3000' }] }; }, v => { v.HostConfig.ExtraHosts = ['external:1.2.3.4']; },
    v => { v.Mounts[0].RW = true; }, v => { v.Mounts[2].Source = '/real/credential'; }, v => { v.Mounts[3].Source = '/foreign/candidate'; },
    v => { v.Mounts.push({ Destination: '/var/run/docker.sock', Type: 'bind', Source: '/var/run/docker.sock', RW: true }); },
    v => { v.HostConfig.MemorySwap = 0; }, v => { v.HostConfig.Tmpfs['/tmp'] = 'rw'; },
  ]) { const changed = structuredClone(value); change(changed); assert.throws(() => verify(changed)); }
  const windowsRuntime = { ...runtime, directory: 'C:/synthetic/transfer' }, windows = structuredClone(value);
  windows.Mounts[1].Source = '/run/desktop/mnt/host/c/synthetic/evidence';
  windows.Mounts[2].Source = '/host_mnt/c/synthetic/transfer/synthetic-secret'; windows.Mounts[3].Source = 'C:\\synthetic\\transfer';
  assert.doesNotThrow(() => verifyServiceAuthoringIsolation(windows, { runtime: windowsRuntime, name, directory: 'C:/synthetic/evidence' }));
});

test('service authoring receipt binds both original files to isolated services, exact source and original execution', () => {
  for (const testId of Object.keys(SERVICE_AUTHORING_TESTS)) {
    const { entry, runtime } = request(testId), evidence = syntheticServiceAuthoringEvidence(candidate, entry, runId);
    assert.doesNotThrow(() => verifyServiceAuthoringEvidence(evidence, entry, runtime.evidence));
    for (const change of [
      v => { v.source_after = '0'.repeat(64); }, v => { v.test_source_sha256 = '0'.repeat(64); },
      v => { v.probe.source_files[testId] = '0'.repeat(64); }, v => { v.after.node.sha256 = '0'.repeat(64); },
      v => { v.probe.checks.original_permission_probe = false; }, v => { v.probe.models = 1; },
      v => { v.probe.database.name = 'production'; }, v => { v.probe.database.version = 170000; }, v => { v.probe.blob.endpoint = 'https://storage.example'; },
      v => { v.network.before.inspection.id = '0'.repeat(64); }, v => { v.network.after.inspection.members.push({ id: '0'.repeat(64) }); },
      v => { v.network.after.routes.ipv4_routes += 'eth0 00000000 01001DAC 0003 0 0 0 00000000 0 0 0\n'; },
      v => { v.network.before.attachment.dns = ['8.8.8.8']; }, v => { v.isolation.network = 'none'; },
      v => { v.isolation.mounts[0].rw = true; }, v => { v.isolation.security_options = ['no-new-privileges']; },
      v => { v.original_command.args.push('--test-name-pattern=one'); }, v => { v.original_command.timeout_ms++; },
      v => { v.original_command.environment.BB_TEST_LIVE_AUTHORING = '1'; }, v => { v.original_command.stdout_sha256 = '0'.repeat(64); },
      v => { v.commands[0].args[3] = '0'.repeat(64); }, v => { v.commands.push(structuredClone(v.commands[0])); },
      v => { v.services_after.pg.id = '0'.repeat(64); }, v => { v.cleanup.removed_id = '0'.repeat(64); }, v => { v.cleanup.absence_confirmed = false; },
    ]) { const changed = structuredClone(evidence); change(changed); assert.throws(() => verifyServiceAuthoringEvidence(changed, entry, runtime.evidence)); }
  }
});
