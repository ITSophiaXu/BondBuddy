import { syntheticInternalNetwork } from '../internal-network.test-fixture.mjs';
import { TEMPLATE_DATABASE } from '../capabilities.mjs';

export const SYNTHETIC_LINUX_NODE = { sha256: '6'.repeat(64), version: 'v22.14.0', modules: '127', arch: 'x64', platform: 'linux' };
export const syntheticStorageFiles = () => Object.fromEntries(['apps/api/src/storage-lifecycle.test.ts', 'apps/api/dist/storage-lifecycle.test.js',
  'db/verify-storage-restore.mjs', 'scripts/pr-gate/host-adapters/storage-postgres-runtime.mjs'].map(file => [file, 'd'.repeat(64)]));

// Pure verifier input. These synthetic identities never claim a Docker run.
export function syntheticStorageEvidence(candidate, entry, runId, files = syntheticStorageFiles()) {
  const core = 'c'.repeat(64), id = '1'.repeat(64), image = 'sha256:' + '2'.repeat(64);
  const network = syntheticInternalNetwork(runId, core).evidence.prepared;
  const environment = { PATH: '/usr/lib/postgresql/16/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/tmp', LANG: 'C.UTF-8', TMPDIR: '/tmp', CI: '1', BB_TEST_DATABASE_URL: TEMPLATE_DATABASE,
    BB_TEST_AZURITE_CONNECTION_STRING: 'UseDevelopmentStorage=true', BB_TEST_LIVE_AUTHORING: '0', BB_PLATFORM_PROBE_ENABLED: '0', BB_REVIEW_WEB_SEARCH_ENABLED: '0' };
  const command = { command: '/transfer/native-node', args: ['--test', '--test-reporter=tap', '/app/' + entry.runPath], cwd: '/app', environment, timeout_ms: 300000 };
  return { ...candidate, run_id: runId, test_id: entry.testId, profile_id: entry.profileId, source_bundle_sha256: 'e'.repeat(64),
    test_source_sha256: entry.sourceSha256, core_id: core, node: { ...SYNTHETIC_LINUX_NODE }, node_after: { ...SYNTHETIC_LINUX_NODE },
    postgres_image: { id: image, pg_major: 16 }, postgres_service: { id: '3'.repeat(64), image }, source_before: 'e'.repeat(64), source_after: 'e'.repeat(64),
    isolation: { id, name: 'bb-pr-gate-storage-' + runId + '-' + entry.sequence, image, core_id: core, network: 'container:' + core,
      user: '1000:1000', rootfs_readonly: true, privileged: false, cap_drop: ['ALL'], no_new_privileges: true, init: true,
      nano_cpus: 1e9, memory: 2 * 1024 ** 3, memory_swap: 2 * 1024 ** 3, pids_limit: 256, published_ports: 0,
      mounts: [{ destination: '/app', type: 'volume', rw: false, name: 'bb-pr-gate-native-' + runId },
        { destination: '/evidence', type: 'bind', rw: true }, { destination: '/transfer', type: 'bind', rw: false }],
      tmpfs: { '/tmp': 'rw,nosuid,nodev,size=1073741824,mode=1777', '/var/lib/postgresql/data': 'ro,nosuid,nodev,noexec,size=1048576' } },
    probe: { ...candidate, status: 'passed', files, node: { ...SYNTHETIC_LINUX_NODE }, uid: 1000, security: { CapEff: '0000000000000000', NoNewPrivs: '1', Seccomp: '2' }, models: 0,
      tools: Object.fromEntries(['pg_dump', 'pg_restore'].map(name => [name, { executable: '/usr/lib/postgresql/16/bin/' + name, sha256: '4'.repeat(64), version: name + ' (PostgreSQL) 16.10' }])),
      database: { name: 'bb_m4_core', username: 'bondbuddy', version: 160010, projects: 'bb_projects' } },
    network, original_command: command, cleanup: { status: 'passed', removed_id: id, absence_confirmed: true },
    commands: [{ label: 'original-test', executable: 'docker', args: ['--context', 'synthetic-local', 'exec', id, '/usr/bin/env', '-i', ...Object.entries(environment).map(([key, value]) => key + '=' + value), command.command, ...command.args],
      code: 0, timedOut: false, cancelled: false, output_limit_failed: false }] };
}
