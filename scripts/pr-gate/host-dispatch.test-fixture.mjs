import assert from 'node:assert/strict';
import { HOST_PROFILES } from './host-profiles.mjs';
import { DISPATCH_SCHEMA, planHash, sha256 } from './host-dispatch-protocol.mjs';
import { syntheticDockerEvidence } from './host-adapters/docker-tests.test-fixture.mjs';
import { SYNTHETIC_LINUX_NODE, syntheticStorageEvidence, syntheticStorageFiles } from './host-adapters/storage-postgres.test-fixture.mjs';
import { networkIdentity } from './internal-network.mjs';
import { SERVICE_AUTHORING_FILES, SERVICE_AUTHORING_TESTS } from './host-adapters/native-services-runtime.mjs';
import { syntheticServiceAuthoringEvidence } from './host-adapters/native-services.test-fixture.mjs';

export const SYNTHETIC_TAP = '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
export const syntheticHostSources = () => Object.fromEntries(Object.keys(HOST_PROFILES).map(file => [file, 'd'.repeat(64)]));

export function syntheticHostDispatch(candidate, runId = 'synthetic-host-run') {
  const files = { ...syntheticHostSources(), ...syntheticStorageFiles(), ...Object.fromEntries(SERVICE_AUTHORING_FILES.map(file => [file, 'd'.repeat(64)])),
    ...Object.fromEntries(['backup-stream.mjs','blob-snapshot.mjs','backup-offhost.mjs'].map(file=>['deploy/m1/scripts/'+file,'d'.repeat(64)])) };
  const shardFor = file => file.startsWith('apps/worker/') ? 'worker-1' : file.startsWith('apps/api/') ? 'api-1' : 'misc';
  // Complete receipt fixtures use their real matrix order. Focused adapter fixtures
  // without a matrix retain their existing native-first negative-case setup.
  let shardOrder;
  if (candidate.matrix !== undefined) {
    assert.ok(Array.isArray(candidate.matrix), 'Synthetic receipt matrix must be an array');
    shardOrder = new Map(candidate.matrix.map((row, index) => [row.name, index]));
    assert.equal(shardOrder.size, candidate.matrix.length, 'Synthetic receipt matrix has duplicate shards');
    for (const file of Object.keys(HOST_PROFILES)) assert.ok(shardOrder.has(shardFor(file)), 'Synthetic host shard is missing from the receipt matrix');
  }
  const entries = Object.entries(HOST_PROFILES).sort(([a], [b]) => {
    const group = file => file.startsWith('apps/worker/') ? 0 : file.startsWith('apps/api/') ? 1 : file.startsWith('scripts/') ? 2 : file.startsWith('deploy/') ? 3 : 4;
    return (shardOrder ? shardOrder.get(shardFor(a)) - shardOrder.get(shardFor(b)) : 0) || group(a) - group(b) || a.localeCompare(b);
  }).map(([testId, profile], sequence) => ({ sequence, shard: shardFor(testId),
    group: testId.startsWith('apps/worker/') ? 'worker' : testId.startsWith('apps/api/') ? 'api' : profile.runner === 'python' ? 'python' : 'scripts', testId,
    runPath: testId.endsWith('.ts') ? testId.replace('/src/', '/dist/').replace(/\.ts$/, '.js') : testId,
    runner: profile.runner, profileId: profile.id, sourceSha256: 'd'.repeat(64), fileTimeoutMs: 300_000 }));
  const plan = { schema: DISPATCH_SCHEMA, run_id: runId, commit: candidate.commit, tree: candidate.tree, profile_sha256: sha256(HOST_PROFILES), entries };
  const records = entries.map(entry => {
    const tests = entry.profileId === 'windows-archive' ? 4 : entry.profileId === 'postgres-storage' ? 3 : entry.profileId === 'service-authoring' ? SERVICE_AUTHORING_TESTS[entry.testId].cases : 1;
    const stdout = SYNTHETIC_TAP.replace('# tests 1', '# tests ' + tests).replace('# pass 1', '# pass ' + tests);
    const evidence = { profile_id: entry.profileId, ...candidate, run_id: runId, test_id: entry.testId,
      started_at: '2026-11-11T13:00:10.000Z', finished_at: '2026-11-11T13:00:11.000Z', commands: [{ executable: 'synthetic unit fixture' }], resources: [], cleanup: { status: 'passed' } };
    if (entry.profileId.startsWith('native-')) Object.assign(evidence, { source_bundle_sha256: 'e'.repeat(64), probe: { ...candidate, status: 'passed', uid: 1000, models: 0, network: 'none' },
      isolation: { user: '1000:1000', network: 'none', rootfs_readonly: true, privileged: false }, original_command: { cwd: '/app', output_limit_failed: false,
        command: entry.runner === 'python' ? '/opt/venv/bin/python' : '/usr/local/bin/node', args: entry.runner === 'python' ? ['-m', 'unittest', '-v', 'test_ocr'] : ['--test', '--test-reporter=tap', '/app/' + entry.runPath] } });
    if (entry.profileId.startsWith('docker-')) Object.assign(evidence, syntheticDockerEvidence(candidate, entry, runId));
    if (entry.profileId === 'service-authoring') Object.assign(evidence, syntheticServiceAuthoringEvidence(candidate, entry, runId));
    if (entry.profileId === 'postgres-storage') {
      Object.assign(evidence, syntheticStorageEvidence(candidate, entry, runId, files));
      Object.assign(evidence.commands[0], { signal: null, durationMs: 1, stdout_sha256: sha256(stdout), stderr_sha256: sha256('') });
    }
    if (entry.profileId === 'windows-archive') {
      const source = { files: 10, manifest_sha256: 'c'.repeat(64), raw_bytes_verified: true };
      const command = { label: 'archive-test', executable: 'C:/synthetic/node.exe', cwd: 'C:/synthetic/source',
        args: ['--test', '--test-reporter=tap', entry.runPath], timeout_ms: 300_000,
        code: 0, signal: null, timedOut: false, durationMs: 1, cancelled: false, output_limit_failed: false,
        stdout_sha256: sha256(stdout), stderr_sha256: sha256('') };
      Object.assign(evidence, { platform: 'win32', source_root: command.cwd, test_source_sha256: entry.sourceSha256,
        source_before: source, source_after: { ...source }, temporary_remaining: [],
        node: { platform: 'win32', executable: command.executable, version: '22.14.0', sha256: 'e'.repeat(64) },
        python: { platform: 'win32', executable: 'C:/synthetic/python.exe', version: [3, 12, 9], sha256: 'f'.repeat(64) },
        original_command: command, cleanup: { status: 'passed', errors: [] } });
      for (const label of ['python-identity', 'archive-support']) evidence.commands.push({ label, executable: evidence.python.executable,
        args: label === 'archive-support' ? ['-I', 'C:\\synthetic\\source\\scripts\\release-smoke\\extract-archive.py', '--check'] : ['-I', '-c', 'synthetic identity fixture'],
        cwd: command.cwd, code: 0, timedOut: false, cancelled: false, output_limit_failed: false,
        stdout_sha256: sha256('synthetic identity fixture'), stderr_sha256: sha256('') });
      evidence.commands.push(command);
    }
    return { sequence: entry.sequence, shard: entry.shard, test_id: entry.testId, profile_id: entry.profileId, plan_sha256: planHash(plan),
      evidence_sha256: sha256(evidence), evidence, stdout_sha256: sha256(stdout), stderr_sha256: sha256(''),
      execution: { code: 0, signal: null, timedOut: false, durationMs: 1 }, evaluated: { status: 'passed', tests, skipped: 0 }, infrastructure_error: null };
  });
  return { schema: DISPATCH_SCHEMA, plan, plan_sha256: planHash(plan), records, errors: [], runtime: { commit: candidate.commit, tree: candidate.tree, run_id: runId, cleanup: { status: 'passed' },
    image_id: 'sha256:' + 'e'.repeat(64), core_image_id: 'sha256:' + 'f'.repeat(64), bundle_sha256: 'e'.repeat(64), reportlab_cache_sha256: 'f'.repeat(64),
    core_container_id: 'c'.repeat(64), core_network_id: 'a'.repeat(64), node_cache: { ...SYNTHETIC_LINUX_NODE },
    core_network: { ...networkIdentity(runId), id: 'a'.repeat(64) },
    source: { ...candidate, files, raw_source: { files: 10, byte_count: 1000, manifest_sha256: 'd'.repeat(64) } } } };
}

export function syntheticHostReferences(dispatch, shard) {
  return dispatch.records.filter(row => row.shard === shard).map(({ evidence, evaluated, shard: _, ...row }) => ({ ...row, ...evaluated }));
}
