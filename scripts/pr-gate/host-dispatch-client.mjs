import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRequest, planHash, requestName, sha256, verifyPlan, verifyResponse } from './host-dispatch-protocol.mjs';
import { HOST_PROFILES } from './host-profiles.mjs';

export function readPlainJson(path, limit = 1024 * 1024) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= limit, 'Unsafe dispatch evidence file');
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function initializeHostClient({ root, candidate, shard, parts, fileTimeoutMs, environment = process.env }) {
  if (!environment.PR_GATE_HOST_PLAN && !environment.PR_GATE_HOST_DIRECTORY) return null;
  assert.equal(environment.PR_GATE_HOST_PLAN, '/evidence/host-dispatch/plan.json');
  assert.equal(environment.PR_GATE_HOST_DIRECTORY, '/evidence/host-dispatch');
  const plan = verifyPlan(readPlainJson(environment.PR_GATE_HOST_PLAN), candidate);
  const selected = parts.flatMap(part => part.selected.filter(item => HOST_PROFILES[item.id]).map(item => ({ group: part.group, runner: part.runner, item })));
  const expected = plan.entries.filter(entry => entry.shard === shard);
  assert.deepEqual(selected.map(row => row.item.id), expected.map(entry => entry.testId), 'Host dispatch selection differs from original shard order');
  for (const [index, row] of selected.entries()) {
    const entry = expected[index];
    assert.equal(entry.runPath, row.item.run); assert.equal(entry.runner, row.runner); assert.equal(entry.group, row.group);
    assert.equal(entry.fileTimeoutMs, fileTimeoutMs);
    assert.equal(sha256(readFileSync(join(root, entry.testId))), entry.sourceSha256, 'Host test source differs from planned Git blob');
  }
  return { plan, entries: new Map(expected.map(entry => [entry.testId, entry])), directory: environment.PR_GATE_HOST_DIRECTORY, records: [] };
}

export async function requestHostExecution(client, testId, deadline) {
  const entry = client.entries.get(testId);
  assert.ok(entry, 'Test is not in this host dispatch shard');
  const name = requestName(entry.sequence), request = join(client.directory, 'requests', name), response = join(client.directory, 'responses', name);
  assert.ok(!existsSync(request) && !existsSync(response), 'Host dispatch request was already used');
  const message = makeRequest(client.plan, entry);
  writeFileSync(request + '.tmp', JSON.stringify(message) + '\n', { flag: 'wx' });
  renameSync(request + '.tmp', request);
  // Preparation consumes the original shard budget; the adapter applies the
  // unchanged per-file timeout to the actual original test subprocess.
  while (!existsSync(response)) {
    if (Date.now() >= deadline) throw new Error('Host capability exhausted the original shard budget');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const value = verifyResponse(readPlainJson(response, 32 * 1024 * 1024), client.plan, entry);
  const { stdout, stderr, ...execution } = value.execution;
  const record = { sequence: entry.sequence, test_id: testId, profile_id: entry.profileId, plan_sha256: planHash(client.plan), evidence_sha256: value.evidence_sha256,
    stdout_sha256: sha256(stdout), stderr_sha256: sha256(stderr), execution, infrastructure_error: value.infrastructure_error };
  client.records.push(record);
  return value;
}
