import assert from 'node:assert/strict';
import test from 'node:test';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHostBroker, createHostPlan, verifyAdapterResult, verifyHostRuns } from './host-dispatch.mjs';
import { makeRequest, planHash, sha256, verifyPlan, verifyRequest, verifyResponse } from './host-dispatch-protocol.mjs';
import { readPlainJson, requestHostExecution } from './host-dispatch-client.mjs';
import { HOST_PROFILES } from './host-profiles.mjs';
import { syntheticHostDispatch, syntheticHostReferences, syntheticHostSources, SYNTHETIC_TAP } from './host-dispatch.test-fixture.mjs';

const candidate = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
const fixture = task => {
  const root = mkdtempSync(join(tmpdir(), 'bb-host-dispatch-'));
  return Promise.resolve().then(() => task(root)).finally(() => rmSync(root, { recursive: true, force: true }));
};
const resultFor = ({ candidate, runId, entry }) => ({
  execution: { code: 0, signal: null, timedOut: false, stdout: SYNTHETIC_TAP, stderr: '', durationMs: 1 },
  evidence: { ...candidate, run_id: runId, profile_id: entry.profileId, test_id: entry.testId, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), commands: [{ executable: 'synthetic protocol fixture' }], resources: [], cleanup: { status: 'passed' } },
});

test('host plan uses original discovery, exclusions and modulo order including new tests', () => fixture(root => {
  const files = [...Object.keys(HOST_PROFILES), 'apps/worker/src/a-new-unrelated.test.ts'];
  for (const file of files) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), '// synthetic source'); }
  const matrix = [{ name: 'worker-1', groups: 'worker', shard: '1/2' }, { name: 'worker-2', groups: 'worker', shard: '2/2' }, { name: 'misc', groups: 'scripts,python', shard: '1/1' }];
  const plan = createHostPlan({ root, candidate, matrix, runId: 'synthetic-run', sourceBlob: file => file.endsWith('exclusions.json') ? Buffer.from('{"notInCi":[],"knownFailing":[],"allowSkip":[]}') : readFileSync(join(root, file)) });
  assert.deepEqual(plan.entries.map(entry => [entry.shard, entry.testId]), [
    ['worker-1', 'apps/worker/src/integrity-desktop.test.ts'], ['worker-2', 'apps/worker/src/codex-file-authoring.test.ts'], ['worker-2', 'apps/worker/src/review-revision-cli-native.test.ts'],
    ['misc', 'scripts/billing-functional/panel-session.test.mjs'], ['misc', 'scripts/release-smoke/archive.test.mjs'],
    ['misc', 'scripts/release-smoke/credentials.linux.test.mjs'], ['misc', 'deploy/m1/scripts/backup-integration.test.mjs'], ['misc', 'python/tests/test_ocr.py'],
  ]);
  assert.ok(plan.entries.every(entry => entry.fileTimeoutMs === 300_000));
}));

test('requests refuse arbitrary commands, old candidates, replay order and widened budgets', () => {
  const { plan } = syntheticHostDispatch(candidate), entry = plan.entries[0], request = makeRequest(plan, entry);
  assert.equal(verifyRequest(request, plan, entry), request);
  for (const key of ['args', 'argv', 'env', 'path', 'command']) assert.throws(() => verifyRequest({ ...request, [key]: 'unexpected' }, plan, entry));
  for (const mutation of [value => { value.sequence++; }, value => { value.test_id = '../outside'; }, value => { value.run_id += 'old'; }, value => { value.plan_sha256 = '0'.repeat(64); }]) {
    const changed = structuredClone(request); mutation(changed); assert.throws(() => verifyRequest(changed, plan, entry));
  }
  for (const mutation of [value => { value.commit = 'c'.repeat(40); }, value => { value.entries[0].fileTimeoutMs++; }, value => { value.entries.pop(); }, value => { value.entries[1].testId = value.entries[0].testId; }]) {
    const changed = structuredClone(plan); mutation(changed); assert.throws(() => verifyPlan(changed, candidate));
  }
});

test('plain evidence reader rejects directories, hard links and oversized JSON', () => fixture(root => {
  const path = join(root, 'record.json'); writeFileSync(path, '{}'); assert.deepEqual(readPlainJson(path), {});
  assert.throws(() => readPlainJson(root)); assert.throws(() => readPlainJson(path, 1));
  linkSync(path, join(root, 'second.json')); assert.throws(() => readPlainJson(path), /Unsafe/);
}));

test('real file handshake dispatches exact originals sequentially and retains independent raw outputs', () => fixture(async root => {
  const { plan } = syntheticHostDispatch(candidate), directory = join(root, 'channel'), evidenceRoot = join(root, 'private'), calls = [];
  const broker = createHostBroker({ plan, directory, evidenceRoot, sourceRoot: root, executeAdapter: async context => { calls.push(context.entry.testId); return resultFor(context); } });
  const client = { plan, entries: new Map(plan.entries.map(entry => [entry.testId, entry])), directory, records: [] };
  for (const shard of ['worker-1', 'misc']) {
    const task = broker.startShard(shard);
    for (const entry of plan.entries.filter(row => row.shard === shard)) {
      const response = await requestHostExecution(client, entry.testId, Date.now() + 5000);
      assert.equal(response.execution.stdout, SYNTHETIC_TAP); assert.equal(response.infrastructure_error, null);
    }
    await task.finish();
  }
  assert.deepEqual(calls, plan.entries.map(entry => entry.testId)); assert.deepEqual(broker.snapshot().errors, []);
  assert.equal(readFileSync(join(evidenceRoot, '000000', 'test.stdout.log'), 'utf8'), SYNTHETIC_TAP);
  assert.equal(client.records[0].stdout_sha256, sha256(SYNTHETIC_TAP));
  await assert.rejects(requestHostExecution(client, plan.entries[0].testId, Date.now() + 5000), /already used/);
}));

test('forged host request never executes an adapter or becomes a passing response', () => fixture(async root => {
  const { plan } = syntheticHostDispatch(candidate), directory = join(root, 'channel'); let calls = 0;
  const broker = createHostBroker({ plan, directory, evidenceRoot: join(root, 'private'), sourceRoot: root, executeAdapter: async context => { calls++; return resultFor(context); } });
  const entry = plan.entries[0], operation = broker.startShard(entry.shard);
  writeFileSync(join(directory, 'requests', '000000.json'), JSON.stringify({ ...makeRequest(plan, entry), command: 'not allowed' }));
  const responsePath = join(directory, 'responses', '000000.json');
  for (let count = 0; count < 100; count++) { try { readFileSync(responsePath); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
  const response = verifyResponse(readPlainJson(responsePath), plan, entry); await operation.finish();
  assert.equal(calls, 0); assert.match(response.infrastructure_error, /Unexpected/); assert.equal(response.execution.code, null);
  assert.equal(broker.snapshot().records[0].evaluated.status, 'failed');
}));

test('cleanup failure preserves an original successful exit but blocks the host result', () => {
  const dispatch = syntheticHostDispatch(candidate), entry = dispatch.plan.entries[0];
  const result = resultFor({ candidate, runId: dispatch.plan.run_id, entry });
  assert.doesNotThrow(() => verifyAdapterResult(result, { candidate, runId: dispatch.plan.run_id, entry }));
  result.evidence.cleanup.status = 'failed'; assert.throws(() => verifyAdapterResult(result, { candidate, runId: dispatch.plan.run_id, entry }), /clean/);
  assert.equal(result.execution.code, 0);
});

test('host receipt rejects stale, missing, reordered, rewritten, failed and skipped evidence', () => {
  const receipt = () => { const dispatch = syntheticHostDispatch(candidate); return { ...candidate, run_id: dispatch.plan.run_id, started_at: '2026-11-11T13:00:00Z', finished_at: '2026-11-11T13:01:00Z',
    host_dispatch: dispatch, shards: ['worker-1', 'misc'].map(name => ({ name, summary: { host_dispatch: syntheticHostReferences(dispatch, name) } })) }; };
  const expected = { ...candidate, host_source_sha256: syntheticHostSources() };
  assert.doesNotThrow(() => verifyHostRuns(receipt(), expected));
  for (const mutation of [r => { r.host_dispatch.records.pop(); }, r => { r.host_dispatch.records.reverse(); }, r => { r.shards[0].summary.host_dispatch[0].stdout_sha256 = '0'.repeat(64); },
    r => { r.host_dispatch.records[0].evaluated.skipped = 1; }, r => { r.host_dispatch.records[0].evaluated.status = 'failed'; },
    r => { r.host_dispatch.records[0].evidence.started_at = '2026-11-10T00:00:00Z'; }, r => { r.host_dispatch.errors.push('failure'); }, r => { r.host_dispatch.plan.run_id += 'old'; }, r => { r.host_dispatch.runtime.run_id += 'old'; }]) {
    const value = receipt(); mutation(value); assert.throws(() => verifyHostRuns(value, expected));
  }
  // A recomputed JSON hash must not allow another same-candidate run, test or
  // capability to be substituted for this entry during offline verification.
  for (const key of ['run_id', 'test_id', 'profile_id']) {
    const value = receipt(), record = value.host_dispatch.records[0];
    record.evidence[key] += '-other'; record.evidence_sha256 = sha256(record.evidence);
    value.shards[0].summary.host_dispatch[0].evidence_sha256 = record.evidence_sha256;
    assert.throws(() => verifyHostRuns(value, expected), /another/);
  }
  for (const mutate of [record => { delete record.evidence.probe; }, record => { record.evidence.isolation.network = 'host'; },
    record => { record.evidence.original_command.args.push('--test-name-pattern=partial'); }, record => { record.evidence.source_bundle_sha256 = '0'.repeat(64); }]) {
    const value = receipt(), record = value.host_dispatch.records[0]; mutate(record); record.evidence_sha256 = sha256(record.evidence);
    value.shards[0].summary.host_dispatch[0].evidence_sha256 = record.evidence_sha256; assert.throws(() => verifyHostRuns(value, expected));
  }
});

test('Windows archive receipt retains real platform, exact original command, source and all four cases', () => {
  const expected = { ...candidate, host_source_sha256: syntheticHostSources() };
  const receipt = () => {
    const dispatch = syntheticHostDispatch(candidate);
    return { ...candidate, run_id: dispatch.plan.run_id, started_at: '2026-11-11T13:00:00Z', finished_at: '2026-11-11T13:01:00Z',
      host_dispatch: dispatch, shards: ['worker-1', 'misc'].map(name => ({ name, summary: { host_dispatch: syntheticHostReferences(dispatch, name) } })) };
  };
  assert.doesNotThrow(() => verifyHostRuns(receipt(), expected));
  for (const mutate of [r => { r.evidence.platform = 'linux'; }, r => { r.evidence.python.version = [3, 11, 9]; },
    r => { r.evidence.node.platform = 'linux'; }, r => { r.evidence.test_source_sha256 = '0'.repeat(64); },
    r => { r.evidence.source_after.manifest_sha256 = '0'.repeat(64); }, r => { r.evidence.temporary_remaining = ['leaked-fixture']; },
    r => { r.evidence.original_command.args.push('--test-name-pattern=partial'); }, r => { r.evidence.original_command.timeout_ms++; },
    r => { r.evidence.original_command.stdout_sha256 = '0'.repeat(64); }, r => { r.evidence.original_command.cancelled = true; },
    r => { r.evidence.commands = r.evidence.commands.filter(c => c.label !== 'archive-support'); },
    r => { r.evidence.commands.find(c => c.label === 'python-identity').code = 1; },
    r => { r.evaluated.tests = 1; }, r => { r.evaluated.skipped = 3; }]) {
    const value = receipt(), record = value.host_dispatch.records.find(r => r.profile_id === 'windows-archive');
    mutate(record); record.evidence_sha256 = sha256(record.evidence);
    const row = value.shards.find(s => s.name === 'misc').summary.host_dispatch.find(r => r.profile_id === 'windows-archive');
    Object.assign(row, { evidence_sha256: record.evidence_sha256, tests: record.evaluated.tests, skipped: record.evaluated.skipped });
    assert.throws(() => verifyHostRuns(value, expected));
  }
});
