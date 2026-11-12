// Synthetic validator records only. Never written as a gate or execution pass.
import { REFERENCE_FILES, REFERENCE_PROFILE_SHA256, REFERENCE_ROOT, REFERENCE_SOURCE, verifyReferenceMount } from './browser-reference-source.mjs';

export function syntheticReferenceIdentity(root = REFERENCE_ROOT) {
  return structuredClone({ schema: 'pr-gate-reference-components-v1', scope: 'old-components-only', not_a_seal: true, not_execution_evidence: true,
    source: REFERENCE_SOURCE, profile_sha256: REFERENCE_PROFILE_SHA256, root, files: REFERENCE_FILES });
}
export function syntheticReferenceRuns(expected, runId, containerId = 'c'.repeat(64)) {
  const common = { commit: expected.commit, tree: expected.tree, run_id: runId, container_id: containerId };
  const check = (stage, second) => ({ ...common, stage, verifier_sha256: expected.reference_verifier_sha256,
    started_at: `2026-11-11T13:00:${second}.000Z`, finished_at: `2026-11-11T13:00:${second}.000Z`, execution: { code: 0 }, identity: syntheticReferenceIdentity() });
  const root = '/synthetic/reference-sources/' + runId + '/BondBuddy-develop', evidence = '/synthetic/runs/' + runId;
  const mount = verifyReferenceMount({ Id: containerId, Mounts: [
    { Type: 'bind', Destination: '/evidence', RW: true, Source: evidence },
    { Type: 'bind', Destination: '/opt/pr-gate-parser106', RW: false, Source: '/synthetic/parser' },
    { Type: 'bind', Destination: REFERENCE_ROOT, RW: false, Source: root },
  ] }, root, evidence, containerId);
  return { schema: 'pr-gate-reference-components-run-v1', ...common,
    host_before: syntheticReferenceIdentity(root), host_after: syntheticReferenceIdentity(root), mount_before: mount, mount_after: structuredClone(mount),
    container_before: check('prepared', '00'), container_after: check('final', '45'),
    shards: expected.matrix.filter(row => row.groups === 'browser').map(row => ({ name: row.name, before: check(row.name + ':before', '10'), after: check(row.name + ':after', '24') })) };
}
