import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CASES, sha256 } from './support.mjs';
import { MAX_REPORT_AGE_MS, hasSuccessfulDeployment, verifyReport, verifyRollbackReport } from './verify.mjs';

const now = Date.parse('2026-11-11T12:00:00.000Z');
const expected = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
function fixture() {
  return {
    status: 'passed', modelProbe: 'passed', sha: expected.commit, tree: expected.tree,
    startedAt: new Date(now - 3_600_000).toISOString(), finishedAt: new Date(now - 60_000).toISOString(),
    cases: CASES.map(id => ({ id, status: 'passed', finishedAt: new Date(now - 60_000).toISOString() })),
    images: Object.fromEntries(['api', 'worker', 'web'].map((target, i) => [target, { id: `sha256:${String(i + 1).repeat(64)}` }])),
  };
}
function logFor(raw, { role, operation, commit = expected.commit, digest = sha256(raw), rollback = '0', resumeFirst = '0' } = {}) {
  const event = operation ?? (role ? `deploy-${role}` : 'deploy');
  const detail = role ? `record=release-1 app=${commit} script=${'c'.repeat(40)} rollback=${rollback} resume_first=${resumeFirst}` : `${commit.slice(0, 12)} commit=${commit}`;
  return `2026-11-11T12:00:00Z\t${event}\t${detail} quality_sha256=${'d'.repeat(64)} smoke_sha256=${digest} (previous none)\n`;
}

test('complete current-commit report passes without running Docker or a model', () => {
  const report = fixture();
  assert.equal(verifyReport(report, expected, now), report);
  report.cases.reverse();
  assert.equal(verifyReport(report, expected, now), report);
});

for (const field of ['status', 'modelProbe']) {
  for (const value of [undefined, 'blocked', 'failed', 'skipped', 'not_run']) {
    test(`${field}=${value} cannot authorize deployment`, () => {
      assert.throws(() => verifyReport({ ...fixture(), [field]: value }, expected, now), /must both have passed/);
    });
  }
}

for (const field of ['sha', 'tree']) {
  test(`mismatched or missing ${field} rejects`, () => {
    for (const value of [undefined, '', 'f'.repeat(40), 'a'.repeat(12), 123]) {
      assert.throws(() => verifyReport({ ...fixture(), [field]: value }, expected, now), /commit or source tree/);
    }
  });
}

test('missing, duplicate, unexpected, malformed or empty required cases reject', () => {
  const cases = fixture().cases;
  for (const invalid of [undefined, [], cases.slice(1), [...cases, cases[0]],
    [cases[0], cases[0], ...cases.slice(2)], [{ id: 'unknown', status: 'passed' }, ...cases.slice(1)],
    [null, ...cases.slice(1)], {}]) {
    assert.throws(() => verifyReport({ ...fixture(), cases: invalid }, expected, now), /Required release smoke cases/);
  }
});

test('any required case not passed rejects, including missing status', () => {
  for (const id of CASES) {
    for (const status of [undefined, 'failed', 'blocked', 'running', 'skipped', 'not_run']) {
      const report = fixture();
      report.cases.find(entry => entry.id === id).status = status;
      assert.throws(() => verifyReport(report, expected, now), /Required release smoke cases/);
    }
  }
});

test('every API, worker and web image requires its full immutable identity', () => {
  assert.throws(() => verifyReport({ ...fixture(), images: undefined }, expected, now), /image identity/);
  for (const target of ['api', 'worker', 'web']) {
    for (const value of [undefined, {}, { id: '' }, { id: 'tag:latest' }, { id: `sha256:${'a'.repeat(63)}` }]) {
      const report = fixture(); report.images[target] = value;
      assert.throws(() => verifyReport(report, expected, now), /image identity/);
    }
  }
});

test('24-hour expiry includes the exact boundary and rejects older evidence', () => {
  const finished = now - MAX_REPORT_AGE_MS;
  const report = { ...fixture(), startedAt: new Date(finished - 1000).toISOString(), finishedAt: new Date(finished).toISOString() };
  for (const entry of report.cases) entry.finishedAt = report.finishedAt;
  assert.equal(verifyReport(report, expected, now), report);
  assert.throws(() => verifyReport(report, expected, now + 1), /expired or has invalid timestamps/);
});

test('resuming a completed suite cannot renew expired execution evidence', () => {
  const report = fixture(), old = now - MAX_REPORT_AGE_MS - 1;
  report.startedAt = new Date(old - 1000).toISOString();
  for (const entry of report.cases) entry.finishedAt = new Date(old).toISOString();
  report.finishedAt = report.lastAttemptFinishedAt = new Date(now).toISOString();
  assert.throws(() => verifyReport(report, expected, now), /expired/);
  // The actual suite ends when its final unfinished journey completes. Earlier
  // passed journeys remain reusable without resubmitting their model jobs.
  report.cases.at(-1).finishedAt = new Date(now - 1).toISOString();
  assert.doesNotThrow(() => verifyReport(report, expected, now));
});

test('every journey needs a valid completion inside the report interval', () => {
  for (const value of [undefined, null, 0, '', 'invalid', new Date(now - 3_600_001).toISOString(), new Date(now).toISOString()]) {
    const report = fixture(); report.cases[0].finishedAt = value;
    assert.throws(() => verifyReport(report, expected, now), /timestamps/);
  }
  const original = fixture();
  original.finishedAt = new Date(now - 30_000).toISOString();
  // Legacy reports were finalized after cleanup; their real case timestamps
  // remain authoritative even when the report timestamp is slightly later.
  assert.doesNotThrow(() => verifyReport(original, expected, now));
});

test('missing, malformed, reversed and future timestamps reject', () => {
  for (const field of ['startedAt', 'finishedAt']) {
    for (const value of [undefined, null, 0, '', 'invalid']) {
      assert.throws(() => verifyReport({ ...fixture(), [field]: value }, expected, now), /timestamps/);
    }
  }
  assert.throws(() => verifyReport({ ...fixture(), startedAt: new Date(now).toISOString() }, expected, now), /timestamps/);
  assert.throws(() => verifyReport({ ...fixture(), finishedAt: new Date(now + 60_001).toISOString() }, expected, now), /timestamps/);
  assert.throws(() => verifyReport(fixture(), expected, NaN), /timestamps/);
  assert.doesNotThrow(() => verifyReport({ ...fixture(), finishedAt: new Date(now + 60_000).toISOString() }, expected, now));
});

test('rollback waives age only for the identical report previously deployed successfully', () => {
  const report = fixture(), raw = JSON.stringify(report);
  const later = now + 2 * MAX_REPORT_AGE_MS;
  assert.throws(() => verifyReport(report, expected, later), /expired/);
  assert.deepEqual(verifyRollbackReport(raw, expected, logFor(raw), later), report);
  for (const log of ['', logFor(raw, { operation: 'rollback' }), logFor(raw, { commit: 'e'.repeat(40) }),
    logFor(raw, { digest: 'e'.repeat(64) }), logFor(raw).replace('quality_sha256=', 'smoke_sha256=')]) {
    assert.throws(() => verifyRollbackReport(raw, expected, log, later), /original passing smoke report/);
  }
  assert.throws(() => verifyRollbackReport(`${raw}\n`, expected, logFor(raw), later), /original passing smoke report/);
});

test('rollback cannot waive failures, missing cases, image IDs or malformed timestamps', () => {
  for (const patch of [{ status: 'failed' }, { modelProbe: 'not_run' }, { cases: [] }, { images: {} }, { finishedAt: 'bad' }]) {
    const raw = JSON.stringify({ ...fixture(), ...patch });
    assert.throws(() => verifyRollbackReport(raw, expected, logFor(raw), now));
  }
});

test('role rollback requires that same role and a successful original deployment', () => {
  const raw = JSON.stringify(fixture()), later = now + 2 * MAX_REPORT_AGE_MS;
  for (const role of ['main', 'execution']) {
    assert.doesNotThrow(() => verifyRollbackReport(raw, expected, logFor(raw, { role }), later, role));
    for (const log of [logFor(raw), logFor(raw, { role: role === 'main' ? 'execution' : 'main' }),
      logFor(raw, { role, rollback: '1' }), logFor(raw, { role }).replace(' rollback=0', ''),
      logFor(raw, { role }).replace(' app=', ` app=${expected.commit} app=`)]) {
      assert.throws(() => verifyRollbackReport(raw, expected, log, later, role), /original passing smoke report/);
    }
  }
  assert.throws(() => verifyRollbackReport(raw, expected, logFor(raw, { role: 'main' }), later), /original passing smoke report/);
  assert.throws(() => verifyRollbackReport(raw, expected, logFor(raw), later, 'unknown'), /Unknown deployment role/);
});

test('a completed first-release recovery can authorize a future rollback, but ambiguous markers cannot', () => {
  const raw = JSON.stringify(fixture()), later = now + 2 * MAX_REPORT_AGE_MS;
  for (const role of ['main', 'execution']) {
    const firstSuccess = logFor(raw, { role, rollback: '1', resumeFirst: '1' });
    assert.doesNotThrow(() => verifyRollbackReport(raw, expected, firstSuccess, later, role));
    for (const log of [firstSuccess.replace(' resume_first=1', ''),
      firstSuccess.replace(' resume_first=1', ' resume_first=0'),
      firstSuccess.replace(' resume_first=1', ' resume_first=1 resume_first=0'),
      firstSuccess.replace(' rollback=1', ' rollback=1 rollback=0'),
      firstSuccess.replace(`\tdeploy-${role}\t`, `\tdeploy-${role}-failed\t`)]) {
      assert.throws(() => verifyRollbackReport(raw, expected, log, later, role), /original passing smoke report/);
    }
  }
});

test('shared deployment lookup binds the requested evidence field and rejects ambiguous log entries', () => {
  const raw = JSON.stringify(fixture()), log = logFor(raw);
  assert.equal(hasSuccessfulDeployment(log, expected, 'd'.repeat(64), 'quality_sha256'), true);
  assert.equal(hasSuccessfulDeployment(log, expected, sha256(raw), 'quality_sha256'), false);
  assert.equal(hasSuccessfulDeployment(`prefix${log}`, expected, sha256(raw), 'smoke_sha256'), false);
  for (const invalid of [log.replace('\tdeploy\t', '\tdeploy-failed\t'),
    log.replace(' commit=', ` commit=${expected.commit} commit=`),
    log.replace(' (previous', '\textra (previous'), log.replace(`${expected.commit.slice(0, 12)} commit=`, 'wrongtag commit=')]) {
    assert.equal(hasSuccessfulDeployment(invalid, expected, sha256(raw), 'smoke_sha256'), false);
  }
  assert.throws(() => hasSuccessfulDeployment(log, expected, sha256(raw), 'unknown'), /Unknown release evidence field/);
});

test('a successfully resumed pending candidate becomes known-good only after a success log', () => {
  const raw = JSON.stringify(fixture()), later = now + 2 * MAX_REPORT_AGE_MS;
  for (const role of ['main', 'execution']) {
    const success = logFor(raw, { role, rollback: '1' }).replace(' (previous', ' resume_candidate=1 (previous');
    assert.doesNotThrow(() => verifyRollbackReport(raw, expected, success, later, role));
    for (const invalid of [success.replace('resume_candidate=1', 'resume_candidate=0'),
      success.replace('resume_candidate=1', 'resume_candidate=1 resume_candidate=0'),
      success.replace(`\tdeploy-${role}\t`, '\tpending\t')])
      assert.throws(() => verifyRollbackReport(raw, expected, invalid, later, role));
  }
});
