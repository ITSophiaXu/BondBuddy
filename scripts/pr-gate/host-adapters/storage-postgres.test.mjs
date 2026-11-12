import assert from 'node:assert/strict';
import test from 'node:test';
import { STORAGE_TEST, STORAGE_PROFILE, validateStorageRequest, verifyStorageImage, verifyStorageIsolation, verifyStorageEvidence } from './storage-postgres.mjs';
import { SYNTHETIC_LINUX_NODE, syntheticStorageEvidence, syntheticStorageFiles } from './storage-postgres.test-fixture.mjs';

const candidate = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, runId = 'synthetic-storage-run';
const entry = { sequence: 0, group: 'api', shard: 'api-2', testId: STORAGE_TEST, profileId: STORAGE_PROFILE, runner: 'node',
  runPath: 'apps/api/dist/storage-lifecycle.test.js', sourceSha256: 'd'.repeat(64), fileTimeoutMs: 300000 };
const runtimeEvidence = () => ({ ...candidate, bundle_sha256: 'e'.repeat(64), core_container_id: 'c'.repeat(64), core_network_id: 'a'.repeat(64),
  node_cache: { ...SYNTHETIC_LINUX_NODE }, source: { files: syntheticStorageFiles() } });
const request = () => ({ candidate, runId, entry: { ...entry }, runtime: { candidate, runId, evidence: runtimeEvidence(),
  core: { id: 'c'.repeat(64), name: 'bb-pr-gate-' + runId, network: { id: 'a'.repeat(64), run_id: runId } } } });

test('storage capability accepts only the original full API file, candidate and unchanged budget', () => {
  assert.doesNotThrow(() => validateStorageRequest(request()));
  for (const change of [r => r.entry.testId = 'apps/api/src/other.test.ts', r => r.entry.runPath += '.old', r => r.entry.fileTimeoutMs++,
    r => r.entry.group = 'worker', r => r.entry.args = ['--test-name-pattern=partial'], r => r.runtime.core.network.run_id += '-other',
    r => r.runtime.core.id = '0'.repeat(64), r => r.runtime.evidence.source.files[STORAGE_TEST] = '0'.repeat(64), r => r.runtime.evidence.node_cache.platform = 'win32']) {
    const value = request(); change(value); assert.throws(() => validateStorageRequest(value));
  }
});

test('PG image must retain its own matching architecture and PG16 userland without credentials', () => {
  const id = 'sha256:' + '2'.repeat(64), image = { Id: id, Os: 'linux', Architecture: 'amd64', Config: { Env: ['PG_MAJOR=16'], Volumes: { '/var/lib/postgresql/data': {} } } };
  assert.equal(verifyStorageImage(image, id, SYNTHETIC_LINUX_NODE).pg_major, 16);
  for (const change of [v => v.Id = 'sha256:' + '0'.repeat(64), v => v.Architecture = 'arm64', v => v.Config.Env = ['PG_MAJOR=15'],
    v => v.Config.Env.push('PGPASSWORD=secret'), v => v.Config.Volumes['/unowned'] = {}]) {
    const value = structuredClone(image); change(value); assert.throws(() => verifyStorageImage(value, id, SYNTHETIC_LINUX_NODE));
  }
});

test('storage container rejects host networking, mutable sources, sockets and implicit PG volumes', () => {
  const evidence = syntheticStorageEvidence(candidate, entry, runId), spec = { imageId: evidence.postgres_image.id, coreId: evidence.core_id,
    volume: 'bb-pr-gate-native-' + runId, name: evidence.isolation.name, runId };
  const value = { Id: evidence.isolation.id, Name: '/' + spec.name, Image: spec.imageId, Config: { User: '1000:1000', WorkingDir: '/app',
    Labels: { 'bondbuddy.pr-gate.run': runId, 'bondbuddy.pr-gate.profile': STORAGE_PROFILE } }, HostConfig: { NetworkMode: 'container:' + spec.coreId,
    ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges'], Init: true,
    NanoCpus: 1e9, Memory: 2 * 1024 ** 3, MemorySwap: 2 * 1024 ** 3, PidsLimit: 256, PortBindings: {}, Tmpfs: evidence.isolation.tmpfs },
    Mounts: evidence.isolation.mounts.map(row => ({ Destination: row.destination, Type: row.type, RW: row.rw, Name: row.name })) };
  assert.doesNotThrow(() => verifyStorageIsolation(value, spec));
  for (const change of [v => v.Config.User = '0:0', v => v.HostConfig.NetworkMode = 'host', v => v.HostConfig.NetworkMode = 'container:' + '0'.repeat(64),
    v => v.Mounts[0].RW = true, v => v.Mounts.push({ Destination: '/var/run/docker.sock', Type: 'bind', RW: true }),
    v => delete v.HostConfig.Tmpfs['/var/lib/postgresql/data'], v => v.Mounts.push({ Destination: '/var/lib/postgresql/data', Type: 'volume', RW: true }),
    v => v.HostConfig.Privileged = true, v => v.HostConfig.CapAdd.push('SYS_ADMIN'), v => v.HostConfig.ReadonlyRootfs = false,
    v => v.HostConfig.PortBindings = { '5432/tcp': [{ HostPort: '5432' }] }]) {
    const mutated = structuredClone(value); change(mutated); assert.throws(() => verifyStorageIsolation(mutated, spec));
  }
});

test('storage receipt rejects changed tools, test filters, missing verifier, stale identities and failed cleanup', () => {
  assert.doesNotThrow(() => verifyStorageEvidence(syntheticStorageEvidence(candidate, entry, runId), entry, runtimeEvidence()));
  for (const change of [v => v.node.sha256 = '0'.repeat(64), v => v.core_id = '0'.repeat(64), v => v.postgres_image.id = 'sha256:' + '0'.repeat(64),
    v => v.probe.tools.pg_dump.version = 'pg_dump (PostgreSQL) 15.0', v => delete v.probe.tools.pg_restore,
    v => delete v.probe.files['db/verify-storage-restore.mjs'], v => v.probe.database.name = 'production', v => v.isolation.rootfs_readonly = false,
    v => v.original_command.args.push('--test-name-pattern=partial'), v => v.original_command.timeout_ms++,
    v => v.original_command.environment.BB_TEST_DATABASE_URL = 'postgresql://production', v => v.commands[0].cancelled = true,
    v => v.network.inspection.id = '0'.repeat(64), v => v.cleanup.status = 'failed', v => v.cleanup.absence_confirmed = false]) {
    const value = syntheticStorageEvidence(candidate, entry, runId); change(value); assert.throws(() => verifyStorageEvidence(value, entry, runtimeEvidence()));
  }
});
