// Synthetic records for pure verifier tests; never proof of a Docker execution.
import { sha256 } from '../host-dispatch-protocol.mjs';
import { syntheticInternalNetwork } from '../internal-network.test-fixture.mjs';
import { SERVICE_AUTHORING_TESTS, SERVICE_AUTHORING_PROFILE, SERVICE_AUTHORING_FILES, SERVICE_AUTHORING_ENVIRONMENT,
  SERVICE_AUTHORING_CANARY, serviceAuthoringEnvCommand } from './native-services-runtime.mjs';

export function syntheticServiceAuthoringRuntime(candidate, runId = 'synthetic-host-run') {
  return { ...candidate, run_id: runId, image_id: 'sha256:' + 'e'.repeat(64), core_image_id: 'sha256:' + 'f'.repeat(64),
    core_container_id: 'c'.repeat(64), core_network: syntheticInternalNetwork(runId).identity, bundle_sha256: 'e'.repeat(64),
    source: { ...candidate, files: Object.fromEntries(SERVICE_AUTHORING_FILES.map(file => [file, 'd'.repeat(64)])) } };
}

export function syntheticServiceAuthoringEvidence(candidate, entry, runId = 'synthetic-host-run') {
  const runtime = syntheticServiceAuthoringRuntime(candidate, runId), coreId = runtime.core_container_id, id = 'b'.repeat(64);
  const name = 'bb-pr-gate-authoring-' + runId + '-' + entry.sequence;
  const network = syntheticInternalNetwork(runId).evidence.prepared;
  const phase = { core_id: coreId, inspection: network.inspection, attachment: network.attachment, routes: network.routes };
  const sourceFiles = { ...runtime.source.files, [entry.testId]: entry.sourceSha256 };
  const baseProbe = { ...candidate, status: 'passed', uid: 1000, models: 0, network: 'core-internal', source_files: sourceFiles,
    security: { CapEff: '0000000000000000', NoNewPrivs: '1', Seccomp: '2' }, synthetic_canary_sha256: sha256(SERVICE_AUTHORING_CANARY),
    node: { executable: '/usr/local/bin/node', version: 'v22.14.0', sha256: '1'.repeat(64) } };
  const count = SERVICE_AUTHORING_TESTS[entry.testId].cases;
  const stdout = `# tests ${count}\n# pass ${count}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  const args = ['--test', '--test-reporter=tap', '/app/' + entry.runPath];
  const result = { code: 0, signal: null, timedOut: false, durationMs: 1, stdout_sha256: sha256(stdout), stderr_sha256: sha256(''), output_limit_failed: false, cancelled: false };
  const services = { pg: { id: '2'.repeat(64), image: 'sha256:' + '2'.repeat(64), network: 'container:' + coreId },
    blob: { id: '4'.repeat(64), image: 'sha256:' + '5'.repeat(64), network: 'container:' + coreId } };
  return { ...candidate, run_id: runId, test_id: entry.testId, profile_id: SERVICE_AUTHORING_PROFILE,
    started_at: '2026-11-11T13:00:10.000Z', finished_at: '2026-11-11T13:00:11.000Z',
    source_bundle_sha256: runtime.bundle_sha256, test_source_sha256: entry.sourceSha256, core_id: coreId,
    source_before: runtime.bundle_sha256, source_after: runtime.bundle_sha256, services_before: services, services_after: structuredClone(services),
    network: { before: phase, after: structuredClone(phase) }, after: structuredClone(baseProbe),
    probe: { ...baseProbe, profile: SERVICE_AUTHORING_PROFILE, checks: { original_permission_probe: true, python_authoring: 'BB_AUTHORING_IMPORTS_OK',
      tools: Object.fromEntries([['python', '/opt/venv/bin/python'], ['codex', '/usr/local/bin/codex'], ['bwrap', '/usr/bin/bwrap']]
        .map(([tool, executable]) => [tool, { executable, version: 'synthetic unit fixture', sha256: '6'.repeat(64) }])) },
      database: { name: 'bb_m4_core', username: 'bondbuddy', version: 160000 }, blob: { endpoint: 'http://127.0.0.1:10000/devstoreaccount1', readable: true } },
    isolation: { id, name, image: runtime.image_id, core_id: coreId, network: 'container:' + coreId, user: '1000:1000', rootfs_readonly: true,
      privileged: false, cap_drop: ['ALL'], no_new_privileges: true, security_options: ['no-new-privileges', 'seccomp=synthetic'],
      nano_cpus: 1e9, memory: 2 * 1024 ** 3, memory_swap: 2 * 1024 ** 3, pids_limit: 256, shm_size: 256 * 1024 ** 2, published_ports: 0,
      tmpfs: { '/tmp': 'rw,nosuid,nodev,size=1073741824,mode=1777' }, mounts: [
        { destination: '/app', type: 'volume', rw: false, name: 'bb-pr-gate-native-' + runId },
        { destination: '/evidence', type: 'bind', rw: true, source: '/synthetic/evidence' },
        { destination: '/run/secrets/bb-copilot-oauth', type: 'bind', rw: false, source: '/synthetic/transfer/synthetic-secret' },
        { destination: '/transfer', type: 'bind', rw: false, source: '/synthetic/transfer' },
      ] },
    original_command: { command: '/usr/local/bin/node', args, cwd: '/app', environment: { ...SERVICE_AUTHORING_ENVIRONMENT }, timeout_ms: 300_000, ...result },
    commands: [{ label: 'original-test', executable: 'docker', args: ['--context', 'synthetic-local', 'exec', id, ...serviceAuthoringEnvCommand(['/usr/local/bin/node', ...args])], ...result }],
    resources: [{ kind: 'container', id, name, image: runtime.image_id }], cleanup: { status: 'passed', removed_id: id, absence_confirmed: true } };
}
