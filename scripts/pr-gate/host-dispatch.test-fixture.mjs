import { HOST_PROFILES } from './host-profiles.mjs';
import { DISPATCH_SCHEMA, planHash, sha256 } from './host-dispatch-protocol.mjs';
import { syntheticDockerEvidence } from './host-adapters/docker-tests.test-fixture.mjs';

export const SYNTHETIC_TAP = '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
export const syntheticHostSources = () => Object.fromEntries(Object.keys(HOST_PROFILES).map(file => [file, 'd'.repeat(64)]));

export function syntheticHostDispatch(candidate, runId = 'synthetic-host-run') {
  const entries = Object.entries(HOST_PROFILES).sort(([a], [b]) => {
    const group = file => file.startsWith('apps/worker/') ? 0 : file.startsWith('scripts/') ? 1 : file.startsWith('deploy/') ? 2 : 3;
    return group(a) - group(b) || a.localeCompare(b);
  }).map(([testId, profile], sequence) => ({ sequence, shard: testId.startsWith('apps/worker/') ? 'worker-1' : 'misc',
    group: testId.startsWith('apps/worker/') ? 'worker' : profile.runner === 'python' ? 'python' : 'scripts', testId,
    runPath: testId.endsWith('.ts') ? testId.replace('/src/', '/dist/').replace(/\.ts$/, '.js') : testId,
    runner: profile.runner, profileId: profile.id, sourceSha256: 'd'.repeat(64), fileTimeoutMs: 300_000 }));
  const plan = { schema: DISPATCH_SCHEMA, run_id: runId, commit: candidate.commit, tree: candidate.tree, profile_sha256: sha256(HOST_PROFILES), entries };
  const records = entries.map(entry => {
    const evidence = { profile_id: entry.profileId, ...candidate, run_id: runId, test_id: entry.testId,
      started_at: '2026-11-11T13:00:10.000Z', finished_at: '2026-11-11T13:00:11.000Z', commands: [{ executable: 'synthetic unit fixture' }], resources: [], cleanup: { status: 'passed' } };
    if (entry.profileId.startsWith('native-')) Object.assign(evidence, { source_bundle_sha256: 'e'.repeat(64), probe: { ...candidate, status: 'passed', uid: 1000, models: 0, network: 'none' },
      isolation: { user: '1000:1000', network: 'none', rootfs_readonly: true, privileged: false }, original_command: { cwd: '/app', output_limit_failed: false,
        command: entry.runner === 'python' ? '/opt/venv/bin/python' : '/usr/local/bin/node', args: entry.runner === 'python' ? ['-m', 'unittest', '-v', 'test_ocr'] : ['--test', '--test-reporter=tap', '/app/' + entry.runPath] } });
    if (entry.profileId.startsWith('docker-')) Object.assign(evidence, syntheticDockerEvidence(candidate, entry, runId));
    return { sequence: entry.sequence, shard: entry.shard, test_id: entry.testId, profile_id: entry.profileId, plan_sha256: planHash(plan),
      evidence_sha256: sha256(evidence), evidence, stdout_sha256: sha256(SYNTHETIC_TAP), stderr_sha256: sha256(''),
      execution: { code: 0, signal: null, timedOut: false, durationMs: 1 }, evaluated: { status: 'passed', tests: 1, skipped: 0 }, infrastructure_error: null };
  });
  return { schema: DISPATCH_SCHEMA, plan, plan_sha256: planHash(plan), records, errors: [], runtime: { commit: candidate.commit, tree: candidate.tree, run_id: runId, cleanup: { status: 'passed' },
    image_id: 'sha256:' + 'e'.repeat(64), core_image_id: 'sha256:' + 'f'.repeat(64), bundle_sha256: 'e'.repeat(64), reportlab_cache_sha256: 'f'.repeat(64),
    source: { files: { ...syntheticHostSources(), ...Object.fromEntries(['backup-stream.mjs','blob-snapshot.mjs','backup-offhost.mjs'].map(file=>['deploy/m1/scripts/'+file,'d'.repeat(64)])) }, raw_source: { files: 10, byte_count: 1000, manifest_sha256: 'd'.repeat(64) } } } };
}

export function syntheticHostReferences(dispatch, shard) {
  return dispatch.records.filter(row => row.shard === shard).map(({ evidence, evaluated, shard: _, ...row }) => ({ ...row, ...evaluated }));
}
