import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { exclusionsEvidence, PREPARATION_IDS, RECEIPT_SCHEMA, verifyReceipt } from './receipt.mjs';

const matrix = [
  { name: 'api-1', groups: 'api', shard: '1/2' },
  { name: 'api-2', groups: 'api', shard: '2/2' },
  { name: 'worker-1', groups: 'worker', shard: '1/2', chromium: true },
  { name: 'worker-2', groups: 'worker', shard: '2/2', chromium: true },
  { name: 'misc', groups: 'packages,web-unit,scripts,python', shard: '1/1', render: true },
  { name: 'browser-1', groups: 'browser', shard: '1/3', chromium: true },
  { name: 'browser-2', groups: 'browser', shard: '2/3', chromium: true },
  { name: 'browser-3', groups: 'browser', shard: '3/3', chromium: true },
];
const rawExclusions = `${JSON.stringify({ _说明: 'synthetic', notInCi: [{ pattern: 'local-*.test.mjs', reason: 'needs a persistent local service' }], knownFailing: [], allowSkip: [] })}\n`;
const expected = {
  commit: 'a'.repeat(40), tree: 'b'.repeat(40), develop_commit: 'c'.repeat(40),
  matrix, exclusions: exclusionsEvidence(rawExclusions),
};
const now = Date.parse('2026-11-11T13:02:00.000Z');
function fixture() {
  return {
    schema_version: RECEIPT_SCHEMA, status: 'passed',
    commit: expected.commit, tree: expected.tree, develop_commit: expected.develop_commit,
    clean_tree: true, platform: 'linux', host_platform: 'win32',
    started_at: '2026-11-11T13:00:00.000Z', finished_at: '2026-11-11T13:01:00.000Z',
    exclusions: structuredClone(expected.exclusions),
    preparation: PREPARATION_IDS.map(id => ({ id, status: 'passed' })),
    shards: matrix.map(row => ({
      name: row.name, groups: row.groups, shard: row.shard, exit_code: 0,
      summary: {
        schema: 'pr-gate-summary-v1', job: row.name, groups: row.groups.split(','), shard: row.shard,
        expectedJobs: matrix.length, report: false, commit: expected.commit,
        finishedAt: '2026-11-11T13:00:30.000Z', status: 'passed',
        counts: { selected: 2, passed: 2, blocking: 0, tolerated: 0, notInCi: row.name === 'browser-1' ? 1 : 0 },
        problems: [], blocking: [], tolerated: [], recovered: [], skipsAllowed: [], slowest: [],
        suggestion: { knownFailing: [], allowSkip: [] },
      },
    })),
    merge: { exit_code: 0, result: { schema: 'pr-gate-result-v1', status: 'passed', report: false, expected: 8, received: 8, problems: [], failed: [], suggestion: { knownFailing: [], allowSkip: [] } } },
    cleanup: { status: 'passed' }, errors: [],
  };
}
function rejects(mutate, pattern = /Invalid PR gate receipt/) {
  const receipt = fixture();
  mutate(receipt);
  assert.throws(() => verifyReceipt(receipt, expected, now), pattern);
}

test('exclusion evidence counts entries, ignores metadata and hashes exact bytes', () => {
  assert.deepEqual(expected.exclusions, {
    counts: { notInCi: 1, knownFailing: 0, allowSkip: 0 }, total: 1,
    sha256: createHash('sha256').update(rawExclusions).digest('hex'),
  });
  assert.deepEqual(exclusionsEvidence(Buffer.from(rawExclusions)), expected.exclusions);
  assert.notEqual(exclusionsEvidence(rawExclusions.trim()).sha256, expected.exclusions.sha256);
  assert.throws(() => exclusionsEvidence('{"knownFailing":[{"pattern":"x"}]}'), /reason/);
  assert.throws(() => exclusionsEvidence('{"notInCi":{}}'), /数组/);
});

test('complete local Linux evidence is valid without a freshness expiry', () => {
  const receipt = fixture();
  assert.equal(verifyReceipt(receipt, expected, now), receipt);
  assert.equal(verifyReceipt(receipt, expected, now + 365 * 86400_000), receipt);
});

test('approved known failures and allowed skips retain the existing gate semantics', () => {
  const receipt = fixture();
  const summary = receipt.shards[0].summary;
  summary.counts.passed = 1;
  summary.counts.tolerated = 1;
  summary.tolerated.push({ id: 'legacy.test.mjs', why: 'synthetic failure', listed: 'approved' });
  summary.skipsAllowed.push({ id: 'optional.test.mjs', skipped: 1, listed: 'approved' });
  const raw = JSON.stringify({ notInCi: [], knownFailing: [{ pattern: 'legacy.test.mjs', reason: 'approved' }], allowSkip: [{ pattern: 'optional.test.mjs', reason: 'approved' }] });
  receipt.exclusions = exclusionsEvidence(raw);
  assert.equal(verifyReceipt(receipt, { ...expected, exclusions: receipt.exclusions }, now), receipt);
});

test('another commit, tree, develop base or exclusions cannot reuse a pass', () => {
  for (const key of ['commit', 'tree', 'develop_commit']) rejects(receipt => { receipt[key] = 'd'.repeat(40); }, new RegExp(key));
  rejects(receipt => { receipt.exclusions.sha256 = 'd'.repeat(64); }, /exclusions/);
  rejects(receipt => { receipt.exclusions.counts.knownFailing = 1; receipt.exclusions.total = 2; }, /exclusions/);
  rejects(receipt => { receipt.exclusions.total = 2; }, /exclusions total/);
  rejects(receipt => { receipt.exclusions.counts.notInCi = -1; }, /exclusions counts/);
});

test('failed, dirty, wrong-platform or incomplete evidence is rejected', () => {
  rejects(receipt => { receipt.status = 'failed'; });
  rejects(receipt => { receipt.schema_version = 'old'; });
  rejects(receipt => { receipt.clean_tree = false; }, /clean source tree/);
  rejects(receipt => { receipt.platform = 'win32'; }, /execution platform/);
  rejects(receipt => { delete receipt.host_platform; }, /execution platform/);
  rejects(receipt => { receipt.errors.push('source changed during run'); }, /errors/);
  rejects(receipt => { delete receipt.errors; }, /error record/);
  rejects(receipt => { receipt.cleanup.status = 'failed'; }, /cleanup/);
  rejects(receipt => { delete receipt.cleanup; }, /cleanup/);
});

test('every preparation step must have completed exactly once', () => {
  rejects(receipt => { receipt.preparation.pop(); }, /preparation/);
  rejects(receipt => { receipt.preparation[0].status = 'failed'; }, /preparation/);
  rejects(receipt => { receipt.preparation[0].id = receipt.preparation[1].id; }, /preparation/);
  rejects(receipt => { receipt.preparation[0].id = 'unrelated'; }, /preparation/);
});

test('all eight exact matrix rows must report normal successful execution', () => {
  rejects(receipt => { receipt.shards.pop(); }, /shards/);
  rejects(receipt => { receipt.shards[1] = structuredClone(receipt.shards[0]); }, /shards/);
  rejects(receipt => { receipt.shards[1].name = 'unexpected'; }, /expected shard/);
  for (const [key, value] of [['groups', 'worker'], ['shard', '2/2'], ['exit_code', 1], ['exit_code', null]]) {
    rejects(receipt => { receipt.shards[0][key] = value; }, /expected shard/);
  }
  for (const [key, value] of [['schema', 'old'], ['job', 'api-2'], ['groups', ['worker']], ['shard', '2/2'], ['expectedJobs', 7], ['report', true], ['commit', null], ['status', 'failed']]) {
    rejects(receipt => { receipt.shards[0].summary[key] = value; }, /summary/);
  }
  rejects(receipt => { receipt.shards[4].summary.groups = ['packages']; }, /summary/);
});

test('empty and inconsistent file counts cannot be described as a complete pass', () => {
  for (const [key, value] of [['selected', 3], ['passed', -1], ['blocking', 0.5], ['tolerated', '0'], ['notInCi', NaN]]) {
    rejects(receipt => { receipt.shards[0].summary.counts[key] = value; }, /counts/);
  }
  rejects(receipt => { receipt.shards[0].summary.counts.selected = 0; receipt.shards[0].summary.counts.passed = 0; }, /counts/);
  rejects(receipt => { const s = receipt.shards[0].summary; s.counts.passed = 1; s.counts.blocking = 1; }, /blocking/);
  rejects(receipt => { receipt.shards[0].summary.blocking.push({ id: 'bad.test.mjs' }); }, /blocking/);
  rejects(receipt => { receipt.shards[0].summary.problems.push('a required group was missing'); }, /blocking/);
  rejects(receipt => { receipt.shards[0].summary.tolerated.push({ id: 'bad.test.mjs' }); }, /exception results/);
  rejects(receipt => { receipt.shards[0].summary.suggestion.allowSkip.push('new.test.mjs'); }, /unapproved exceptions/);
});

test('merge must confirm all expected shards and cannot be report-only', () => {
  rejects(receipt => { receipt.merge.exit_code = 1; }, /merge/);
  for (const [key, value] of [['schema', 'old'], ['status', 'failed'], ['report', true], ['expected', 7], ['received', 7]]) {
    rejects(receipt => { receipt.merge.result[key] = value; }, /merge/);
  }
  rejects(receipt => { receipt.merge.result.failed.push('api-1'); }, /merge/);
  rejects(receipt => { receipt.merge.result.problems.push('missing shard'); }, /merge/);
  rejects(receipt => { receipt.merge.result.suggestion.knownFailing.push('bad.test.mjs'); }, /merge/);
});

test('run and shard timestamps must describe one completed run', () => {
  rejects(receipt => { receipt.started_at = 'invalid'; }, /timestamps/);
  rejects(receipt => { receipt.finished_at = '2026-11-11T12:00:00.000Z'; }, /timestamps/);
  rejects(receipt => { receipt.finished_at = '2026-11-11T14:00:00.000Z'; }, /timestamps/);
  rejects(receipt => { receipt.shards[0].summary.finishedAt = '2026-11-10T13:00:30.000Z'; }, /timestamp/);
  rejects(receipt => { receipt.shards[0].summary.finishedAt = '2026-11-11T13:01:01.000Z'; }, /timestamp/);
});
