import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { HOST_PROFILES } from './host-profiles.mjs';

export const DISPATCH_SCHEMA = 'pr-gate-host-dispatch-v1';
export const sha256 = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const planHash = plan => sha256(plan);
export const requestName = sequence => String(sequence).padStart(6, '0') + '.json';
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fields = (value, names, message) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), message);
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), message);
};

export function verifyPlan(plan, candidate) {
  fields(plan, ['schema', 'run_id', 'commit', 'tree', 'profile_sha256', 'entries'], 'Unexpected host plan fields');
  assert.equal(plan.schema, DISPATCH_SCHEMA);
  assert.match(plan.run_id, /^[a-zA-Z0-9-]{8,80}$/);
  for (const key of ['commit', 'tree']) assert.ok(oid(plan[key]) && plan[key] === candidate[key], `Host plan ${key} differs from candidate`);
  assert.equal(plan.profile_sha256, sha256(HOST_PROFILES), 'Host profile changed');
  assert.ok(Array.isArray(plan.entries));
  const seen = new Set();
  for (const [sequence, entry] of plan.entries.entries()) {
    fields(entry, ['sequence', 'shard', 'group', 'testId', 'runPath', 'runner', 'profileId', 'sourceSha256', 'fileTimeoutMs'], 'Unexpected host entry fields');
    assert.equal(entry.sequence, sequence);
    assert.match(entry.shard, /^[a-zA-Z0-9_-]+$/);
    assert.match(entry.group, /^[a-z-]+$/);
    const profile = HOST_PROFILES[entry.testId];
    assert.ok(profile, 'Unregistered host test');
    assert.equal(entry.profileId, profile.id); assert.equal(entry.runner, profile.runner);
    const expectedRun = entry.testId.endsWith('.ts') ? entry.testId.replace('/src/', '/dist/').replace(/\.ts$/, '.js') : entry.testId;
    assert.equal(entry.runPath, expectedRun, 'Host compiled path differs from original discovery');
    assert.ok(sha(entry.sourceSha256));
    assert.equal(entry.fileTimeoutMs, 300_000, 'Host dispatch must retain the original local gate file budget');
    assert.ok(!seen.has(entry.testId), 'Duplicate host test'); seen.add(entry.testId);
  }
  assert.deepEqual([...seen].sort(), Object.keys(HOST_PROFILES).sort(), 'Host plan does not cover every registered capability');
  return plan;
}

export function makeRequest(plan, entry) {
  return { schema: DISPATCH_SCHEMA, run_id: plan.run_id, plan_sha256: planHash(plan), sequence: entry.sequence, shard: entry.shard, test_id: entry.testId };
}

export function verifyRequest(request, plan, entry) {
  // The untrusted container may request only the next planned test. It cannot
  // supply a command, argument, environment, filesystem path or image name.
  fields(request, ['schema', 'run_id', 'plan_sha256', 'sequence', 'shard', 'test_id'], 'Unexpected host request fields');
  assert.deepEqual(request, makeRequest(plan, entry), 'Host request is stale, reordered or outside this plan');
  return request;
}

export function verifyExecution(execution) {
  fields(execution, ['code', 'signal', 'timedOut', 'stdout', 'stderr', 'durationMs'], 'Incomplete original test execution');
  assert.ok(execution.code === null || Number.isSafeInteger(execution.code));
  assert.ok(execution.signal === null || typeof execution.signal === 'string');
  assert.equal(typeof execution.timedOut, 'boolean');
  assert.equal(typeof execution.stdout, 'string'); assert.equal(typeof execution.stderr, 'string');
  assert.ok(Number.isFinite(execution.durationMs) && execution.durationMs >= 0);
  return execution;
}

export function verifyResponse(response, plan, entry) {
  fields(response, ['request', 'execution', 'evidence_sha256', 'infrastructure_error'], 'Unexpected host response fields');
  verifyRequest(response.request, plan, entry); verifyExecution(response.execution);
  assert.ok(sha(response.evidence_sha256));
  assert.ok(response.infrastructure_error === null || typeof response.infrastructure_error === 'string');
  return response;
}
