import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POLICY, REQUIRED_CHECKS, verifyReceipt, verifyRollbackReceipt } from '../prospectus-quality-gate.mjs';
import { sha256 } from './support.mjs';

const now = Date.parse('2026-11-11T12:00:00.000Z');
const later = now + 2 * 24 * 60 * 60 * 1000;
const expected = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
function fixture() {
  return {
    schema_version: POLICY, status: 'passed', ...expected, platform: 'linux', clean_tree: true,
    started_at: new Date(now - 1000).toISOString(), finished_at: new Date(now).toISOString(),
    checks: REQUIRED_CHECKS.map(id => ({
      id, status: 'passed', log_sha256: 'c'.repeat(64),
      ...(['gate-regressions', 'api-source-selection', 'browser-input-chain', 'worker-authoring'].includes(id)
        ? { summary: { tests: 4, pass: 4, fail: 0, cancelled: 0, skipped: 0, todo: 0 } } : {}),
      ...(id === 'document-regressions'
        ? { summary: { tests: 4, passed: 4, failures: 0, errors: 0, skipped: 0, expected_failures: 0,
          unexpected_successes: 0, render_required: true, authorized_render_reports: 1, rendered_documents: 3 } } : {}),
      ...(id === 'real-model-acceptance'
        ? { summary: { status: 'passed', ...expected, real_model: true, case_count: 1, evidence_sha256: 'd'.repeat(64) } } : {}),
    })),
  };
}
function logFor(raw, { role = 'main', operation = `deploy-${role}`, commit = expected.commit,
  digest = sha256(raw), rollback = '0', resumeFirst = '0' } = {}) {
  return `2026-11-11T12:00:00Z\t${operation}\trecord=release-1 app=${commit} script=${'e'.repeat(40)} ` +
    `rollback=${rollback} resume_first=${resumeFirst} quality_sha256=${digest} smoke_sha256=${'f'.repeat(64)} (previous none)\n`;
}

for (const role of ['main', 'execution']) {
  test(`quality ${role} rollback accepts only that role's original receipt after expiry`, () => {
    const receipt = fixture(), raw = JSON.stringify(receipt);
    assert.throws(() => verifyReceipt(receipt, expected, later), /expired/);
    assert.deepEqual(verifyRollbackReceipt(raw, expected, logFor(raw, { role }), later, role), receipt);
    assert.throws(() => verifyRollbackReceipt(raw, expected, logFor(raw, { role: role === 'main' ? 'execution' : 'main' }), later, role));
    assert.throws(() => verifyRollbackReceipt(raw, expected, logFor(raw, { role }), later));
  });

  test(`quality ${role} rollback rejects wrong digest, different commit and non-success records`, () => {
    const raw = JSON.stringify(fixture());
    for (const log of ['', logFor(raw, { role, digest: '0'.repeat(64) }),
      logFor(raw, { role, commit: '1'.repeat(40) }), logFor(raw, { role, operation: `deploy-${role}-failed` }),
      logFor(raw, { role, operation: `rollback-${role}` }), logFor(raw, { role, rollback: '1' }),
      logFor(raw, { role }).replace('quality_sha256=', 'smoke_sha256=')]) {
      assert.throws(() => verifyRollbackReceipt(raw, expected, log, later, role));
    }
    assert.throws(() => verifyRollbackReceipt(`${raw}\n`, expected, logFor(raw, { role }), later, role));
  });

  test(`quality ${role} permits a completed first-release recovery, not an ordinary or ambiguous rollback`, () => {
    const raw = JSON.stringify(fixture());
    const firstSuccess = logFor(raw, { role, rollback: '1', resumeFirst: '1' });
    assert.doesNotThrow(() => verifyRollbackReceipt(raw, expected, firstSuccess, later, role));
    for (const log of [firstSuccess.replace(' resume_first=1', ' resume_first=0'),
      firstSuccess.replace(' resume_first=1', ''),
      firstSuccess.replace(' resume_first=1', ' resume_first=1 resume_first=0'),
      firstSuccess.replace(' rollback=1', ' rollback=1 rollback=0')]) {
      assert.throws(() => verifyRollbackReceipt(raw, expected, log, later, role));
    }
  });
}

test('a role deployment log cannot make incomplete quality evidence valid', () => {
  for (const mutate of [receipt => { receipt.status = 'failed'; },
    receipt => { receipt.checks = receipt.checks.filter(check => check.id !== 'real-model-acceptance'); },
    receipt => { receipt.checks.find(check => check.id === 'api-source-selection').summary.skipped = 1; }]) {
    const receipt = fixture(); mutate(receipt); const raw = JSON.stringify(receipt);
    assert.throws(() => verifyRollbackReceipt(raw, expected, logFor(raw), later, 'main'));
  }
});
