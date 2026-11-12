import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const CORE_SOURCE_SCHEMA = 'pr-gate-core-source-final-v1';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const rawProof = value => {
  assert.deepEqual(Object.keys(value ?? {}).sort(), ['byte_count', 'files', 'manifest_sha256']);
  assert.ok(Number.isSafeInteger(value.files) && value.files > 0 && Number.isSafeInteger(value.byte_count) && value.byte_count > 0);
  assert.match(value.manifest_sha256, /^[a-f0-9]{64}$/);
  return value;
};

/** Execute host-pinned verifier bytes; never import a helper writable by tests. */
export function coreSourceCommand(candidate, verifierBytes, sourceRoot = '/workspace') {
  for (const key of ['commit', 'tree']) assert.match(candidate[key], /^[a-f0-9]{40}$/);
  assert.ok(Buffer.isBuffer(verifierBytes) && verifierBytes.length > 0);
  const options = { sourceRoot, expectedCommit: candidate.commit, expectedTree: candidate.tree };
  const code = `const {verifyGitSnapshotSource}=await import(${JSON.stringify('data:text/javascript;base64,' + verifierBytes.toString('base64'))});process.stdout.write(JSON.stringify(verifyGitSnapshotSource(${JSON.stringify(options)})));`;
  return ['node', '--input-type=module', '-e', code];
}

export function verifyCoreSource(record, expected) {
  assert.equal(record?.schema, CORE_SOURCE_SCHEMA, 'Final core raw-source evidence is missing');
  assert.equal(record.status, 'passed'); assert.equal(record.phase, 'after-all-shards'); assert.equal(record.source_root, '/workspace');
  assert.equal(record.run_id, expected.runId, 'Final core source belongs to another run');
  for (const key of ['commit', 'tree']) assert.equal(record[key], expected.candidate[key], 'Final core source belongs to another candidate');
  assert.match(expected.verifierSha256, /^[a-f0-9]{64}$/, 'Expected committed source verifier hash is missing');
  assert.equal(record.verifier_sha256, expected.verifierSha256, 'Final core verifier differs from committed source');
  assert.equal(record.execution?.code, 0, 'Final core source verification did not exit successfully');
  assert.deepEqual(rawProof(record.raw_source), rawProof(expected.rawSource), 'Core raw source changed after preparation');
  const start = Date.parse(record.started_at), end = Date.parse(record.finished_at);
  assert.ok(Number.isFinite(start) && Number.isFinite(end) && start >= Date.parse(expected.startedAt) && end >= start && end <= Date.parse(expected.finishedAt), 'Final core source timestamps are outside this run');
  assert.ok(Array.isArray(expected.shards) && expected.shards.length > 0);
  for (const shard of expected.shards) {
    const completed = Date.parse(shard.finished_at), reported = Date.parse(shard.summary?.finishedAt);
    assert.ok(Number.isFinite(completed) && start >= completed, 'Final core source was checked before a shard completed');
    assert.ok(Number.isFinite(reported) && completed >= reported && start >= reported, 'Final core source or shard completion predates its original summary');
  }
  return record;
}

export async function collectCoreSource({ candidate, runId, verifierBytes, rawSource, shards, execute }) {
  const startedAt = new Date().toISOString();
  const execution = await execute('core-source-final', coreSourceCommand(candidate, verifierBytes), {}, { capture: true, cleanup: true });
  const finishedAt = new Date().toISOString();
  const record = { schema: CORE_SOURCE_SCHEMA, status: 'passed', phase: 'after-all-shards', source_root: '/workspace',
    commit: candidate.commit, tree: candidate.tree, run_id: runId, verifier_sha256: sha256(verifierBytes),
    started_at: startedAt, finished_at: finishedAt, execution: { code: execution.code }, raw_source: JSON.parse(execution.text) };
  return verifyCoreSource(record, { candidate, runId, verifierSha256: sha256(verifierBytes), rawSource, shards, startedAt, finishedAt });
}
