import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { POLICY, REQUIRED_CHECKS, parseTap, validateDocumentSummary, validateAcceptanceSummary, verifyReceipt, verifyRollbackReceipt, validateTestDatabase } from './prospectus-quality-gate.mjs';

const now = Date.parse('2026-11-01T04:00:00Z');
const expected = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
function receipt() { return { schema_version: POLICY, status: 'passed', ...expected, platform: 'linux', clean_tree: true,
  started_at: new Date(now - 1000).toISOString(), finished_at: new Date(now).toISOString(),
  checks: REQUIRED_CHECKS.map(id => ({ id, status: 'passed', log_sha256: 'c'.repeat(64),
    ...(['gate-regressions', 'api-source-selection', 'worker-authoring'].includes(id) ? { summary: { tests: 4, pass: 4, fail: 0, cancelled: 0, skipped: 0, todo: 0 } } : {}),
    ...(id === 'document-regressions' ? { summary: { tests: 4, passed: 4, failures: 0, errors: 0, skipped: 0, expected_failures: 0, unexpected_successes: 0, render_required: true, authorized_render_reports: 1, rendered_documents: 3 } } : {}),
    ...(id === 'real-model-acceptance' ? { summary: { status: 'passed', ...expected, real_model: true, case_count: 1, evidence_sha256: 'e'.repeat(64) } } : {}) })) }; }
test('complete current Linux evidence passes for the exact source tree', () => assert.equal(verifyReceipt(receipt(), expected, now).status, 'passed'));

test('API source-selection cannot be omitted from release or rollback evidence', () => {
  const incomplete = receipt();
  incomplete.checks = incomplete.checks.filter(check => check.id !== 'api-source-selection');
  assert.throws(() => verifyReceipt(incomplete, expected, now));
  const raw = JSON.stringify(incomplete), hash = createHash('sha256').update(raw).digest('hex');
  const log = `${incomplete.finished_at}\tdeploy\t${incomplete.commit.slice(0, 12)} commit=${incomplete.commit} quality_sha256=${hash}\n`;
  assert.throws(() => verifyRollbackReceipt(raw, expected, log, now));
});

test('API source-selection requires its own complete, nonempty and unskipped TAP summary', () => {
  const good = receipt().checks.find(check => check.id === 'api-source-selection').summary;
  for (const summary of [undefined, null, {}, { ...good, tests: 0, pass: 0 }, { ...good, pass: 3 },
    ...['fail', 'cancelled', 'skipped', 'todo'].map(key => ({ ...good, [key]: 1 })),
    ...['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => {
      const missing = { ...good }; delete missing[key]; return missing;
    })]) {
    const invalid = receipt(); invalid.checks.find(check => check.id === 'api-source-selection').summary = summary;
    assert.throws(() => verifyReceipt(invalid, expected, now));
  }
});
test('database migrations accept only a dedicated disposable loopback database', () => {
  assert.equal(validateTestDatabase('postgresql://test:test@127.0.0.1:55491/bb_prospectus_quality').hostname, '127.0.0.1');
  for (const invalid of [undefined, 'postgres://production/bb_prospectus_quality', 'postgres://localhost/bondbuddy',
    'postgres://localhost/bb_prospectus_quality?host=production', 'postgres://localhost/bb_prospectus_quality#override',
    'https://localhost/bb_prospectus_quality']) assert.throws(() => validateTestDatabase(invalid));
});
test('emergency rollback accepts the identical recorded known-good pass even after expiry', () => {
  const old = receipt(); old.started_at = new Date(now - 90_000_000).toISOString(); old.finished_at = new Date(now - 89_000_000).toISOString();
  const raw = JSON.stringify(old), digest = createHash('sha256').update(raw).digest('hex');
  const log = `${old.finished_at}\tdeploy\t${old.commit.slice(0, 12)} commit=${old.commit} quality_sha256=${digest} (previous none)\n`;
  assert.throws(() => verifyReceipt(old, expected, now));
  assert.equal(verifyRollbackReceipt(raw, expected, log, now).commit, old.commit);
  assert.throws(() => verifyRollbackReceipt(raw, expected, '', now));
  assert.throws(() => verifyRollbackReceipt(raw + '\n', expected, log, now));
  assert.throws(() => verifyRollbackReceipt(raw, { ...expected, commit: 'e'.repeat(40) }, log, now));
});
for (const [label, mutate] of [
  ['different commit', r => r.commit = 'd'.repeat(40)], ['different tree', r => r.tree = 'd'.repeat(40)],
  ['dirty tree', r => r.clean_tree = false], ['Windows run', r => r.platform = 'win32'],
  ['old policy', r => r.schema_version = 'old'], ['failed run', r => r.status = 'failed'],
  ['expired pass', r => r.finished_at = new Date(now - 86_400_001).toISOString()],
  ['future pass', r => r.finished_at = new Date(now + 61_000).toISOString()],
  ['missing suite', r => r.checks.pop()], ['failed suite', r => r.checks[0].status = 'failed'],
  ['unknown suite replacing required suite', r => r.checks[0].id = 'unrelated'],
  ['missing log digest', r => delete r.checks[0].log_sha256],
  ['skipped worker evidence', r => r.checks.find(c => c.id === 'worker-authoring').summary.skipped = 1],
  ['missing document evidence', r => delete r.checks.find(c => c.id === 'document-regressions').summary],
  ['missing real model acceptance', r => delete r.checks.find(c => c.id === 'real-model-acceptance').summary],
  ['synthetic-only acceptance', r => r.checks.find(c => c.id === 'real-model-acceptance').summary.real_model = false],
]) test(`rejects ${label}`, () => { const r = receipt(); mutate(r); assert.throws(() => verifyReceipt(r, expected, now)); });

const tap = '# tests 6\n# pass 6\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
test('TAP evidence requires a complete nonempty summary', () => assert.equal(parseTap(tap).pass, 6));
for (const key of ['fail', 'cancelled', 'skipped', 'todo']) test(`TAP rejects ${key}`, () => assert.throws(() => parseTap(tap.replace(`# ${key} 0`, `# ${key} 1`))));
test('TAP rejects empty, absent or duplicated summary', () => {
  for (const invalid of [tap.replaceAll('6', '0'), '', `${tap}${tap}`, tap.replace('# pass 6\n', '')]) assert.throws(() => parseTap(invalid));
});
test('Python evidence cannot pass an empty, skipped or unrendered run', () => {
  const good = { tests: 4, passed: 4, failures: 0, errors: 0, skipped: 0, expected_failures: 0, unexpected_successes: 0, render_required: true, authorized_render_reports: 1, rendered_documents: 3 };
  assert.equal(validateDocumentSummary(good).passed, 4);
  for (const change of [{ tests: 0, passed: 0 }, { skipped: 1 }, { render_required: false }, { rendered_documents: 0 }, { authorized_render_reports: 0 }, { expected_failures: 1 }, { errors: 1 }]) assert.throws(() => validateDocumentSummary({ ...good, ...change }));
});
test('real-model acceptance is mandatory and must match the candidate commit and tree', () => {
  const good = receipt().checks.find(c => c.id === 'real-model-acceptance').summary;
  assert.equal(validateAcceptanceSummary(good, expected).status, 'passed');
  for (const change of [{ status: 'pending' }, { real_model: false }, { commit: 'f'.repeat(40) }, { tree: 'f'.repeat(40) }, { case_count: 0 }, { evidence_sha256: null }])
    assert.throws(() => validateAcceptanceSummary({ ...good, ...change }, expected));
  assert.equal(REQUIRED_CHECKS.at(-1), 'real-model-acceptance');
  const source = readFileSync(fileURLToPath(new URL('./prospectus-quality-gate.mjs', import.meta.url)), 'utf8');
  assert.ok(source.indexOf('if (!release)') < source.indexOf('writeFileSync(`${receiptPath}.tmp`'));
  assert.match(source, /no release receipt was issued/);
});
test('every release entry verifies quality before Docker or source export', () => {
  for (const name of ['deploy.sh', 'export-images.sh', 'rollback.sh']) {
    const source = readFileSync(fileURLToPath(new URL(`../deploy/m1/scripts/${name}`, import.meta.url)), 'utf8');
    const guard = source.indexOf('prospectus-quality-gate.mjs');
    assert.ok(guard >= 0, `${name}: missing mandatory gate`);
    for (const effect of ['docker build', 'docker save', 'compose up', 'git -C "$BB_REPO" archive', 'git -C "$repo" archive']) {
      const pos = source.indexOf(effect);
      if (pos >= 0) assert.ok(guard < pos, `${name}: quality verification must precede ${effect}`);
    }
    assert.match(source, /BB_RELEASE_QUALITY_RECEIPT:\?/);
  }
});
