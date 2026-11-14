// Synthetic validator records only. Never written as a gate or execution pass.
import { REFERENCE_FILES, REFERENCE_PROFILE_SHA256, REFERENCE_ROOT, REFERENCE_SOURCE, QA_BASELINE_FILES, QA_BASELINE_ROOT,
  QA_BASELINE_SOURCE, QA_BASELINE_PROFILE_SHA256, QA_BASELINE_ALIASES, verifyReferenceMount } from './browser-reference-source.mjs';

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
    { Type: 'bind', Destination: QA_BASELINE_ROOT, RW: false, Source: root.replace('/reference-sources/', '/qa-baseline-sources/') },
    { Type: 'bind', Destination: '/opt/pr-gate-identity-parser106', RW: false, Source: '/synthetic/identity-parser' },
    { Type: 'bind', Destination: '/opt/pr-gate-historical-browser', RW: false, Source: '/synthetic/historical-browser-sources/' + runId },
  ] }, root, evidence, containerId);
  return { schema: 'pr-gate-reference-components-run-v1', ...common,
    host_before: syntheticReferenceIdentity(root), host_after: syntheticReferenceIdentity(root), mount_before: mount, mount_after: structuredClone(mount),
    container_before: check('prepared', '00'), container_after: check('final', '45'),
    shards: expected.matrix.filter(row => row.groups === 'browser').map(row => ({ name: row.name, before: check(row.name + ':before', '10'), after: check(row.name + ':after', '24') })) };
}
export function syntheticQaBaselineIdentity(root = QA_BASELINE_ROOT) {
  return structuredClone({ schema: 'pr-gate-qa-baseline-components-v1', scope: 'old-components-only', not_a_seal: true, not_execution_evidence: true,
    source: QA_BASELINE_SOURCE, profile_sha256: QA_BASELINE_PROFILE_SHA256, root, files: QA_BASELINE_FILES });
}
export function syntheticQaBaselineRuns(expected, runId, containerId = 'c'.repeat(64)) {
  const proof = syntheticReferenceRuns(expected, runId, containerId), root = '/synthetic/qa-baseline-sources/' + runId + '/BondBuddy-develop';
  proof.schema = 'pr-gate-qa-baseline-components-run-v1';
  proof.host_before = syntheticQaBaselineIdentity(root); proof.host_after = syntheticQaBaselineIdentity(root);
  for (const check of [proof.container_before, proof.container_after, ...proof.shards.flatMap(row => [row.before, row.after])]) check.identity = syntheticQaBaselineIdentity();
  return proof;
}
export function syntheticQaBaselineAliases() {
  const value = loads => ({ schema: 'pr-gate-qa-baseline-aliases-v1', source: syntheticQaBaselineIdentity(),
    aliases: QA_BASELINE_ALIASES.map(alias => ({ ...alias, loads })) });
  return { before: value(0), after: value(1) };
}
