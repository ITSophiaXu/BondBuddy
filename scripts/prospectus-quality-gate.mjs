#!/usr/bin/env node
/** Release evidence is produced only by a complete, unskipped run on a clean Linux tree. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasSuccessfulDeployment } from './release-smoke/verify.mjs';

export const POLICY = 'prospectus-quality-v1';
export const REQUIRED_CHECKS = Object.freeze(['build', 'contracts', 'gate-regressions', 'database-migrations', 'api-source-selection', 'browser-input-chain', 'worker-authoring', 'document-regressions', 'deploy-regressions', 'real-model-acceptance']);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000, ...options });
  if (result.error || result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    throw Object.assign(new Error(`${command} failed (${result.status ?? result.error?.code})\n${output}`), { output });
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}
function git(args, cwd = root) { return execute('git', args, { cwd }).trim(); }
export function parseTap(output) {
  const result = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...output.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))];
    if (matches.length !== 1) throw new Error(`Missing or ambiguous TAP summary: ${key}`);
    result[key] = Number(matches[0][1]);
  }
  return validateTapSummary(result);
}
function validateTapSummary(result) {
  if (!Number.isSafeInteger(result?.tests) || result.tests < 1 || result.pass !== result.tests || ['fail', 'cancelled', 'skipped', 'todo'].some(key => result[key] !== 0))
    throw new Error('Required tests failed, were skipped, cancelled, TODO, or empty');
  return result;
}
export function validateDocumentSummary(value) {
  if (!Number.isSafeInteger(value?.tests) || value.tests < 1 || value.passed !== value.tests || value.failures !== 0 || value.errors !== 0 || value.skipped !== 0 || value.expected_failures !== 0 || value.unexpected_successes !== 0 || value.render_required !== true || !Number.isSafeInteger(value.authorized_render_reports) || value.authorized_render_reports < 1 || !Number.isSafeInteger(value.rendered_documents) || value.rendered_documents < 3)
    throw new Error('Document regressions were incomplete or rendering was disabled');
  return value;
}
export function validateAcceptanceSummary(value, expected) {
  if (value?.status !== 'passed' || value.commit !== expected.commit || value.tree !== expected.tree || value.real_model !== true || !Number.isSafeInteger(value.case_count) || value.case_count < 1 || !/^[a-f0-9]{64}$/.test(value.evidence_sha256 ?? ''))
    throw new Error('Current-commit real-model golden-case acceptance is required for release');
  return value;
}
export function verifyReceipt(receipt, expected, now = Date.now(), allowExpired = false) {
  if (receipt?.schema_version !== POLICY || receipt.status !== 'passed' || receipt.platform !== 'linux' || receipt.clean_tree !== true)
    throw new Error('Missing complete Linux quality evidence');
  if (!/^[a-f0-9]{40}$/.test(receipt.commit ?? '') || receipt.commit !== expected.commit || receipt.tree !== expected.tree)
    throw new Error('Quality evidence belongs to another commit or source tree');
  const finished = Date.parse(receipt.finished_at), started = Date.parse(receipt.started_at);
  if (!Number.isFinite(finished) || !Number.isFinite(started) || started > finished || finished > now + 60_000 || (!allowExpired && now - finished > 24 * 60 * 60 * 1000))
    throw new Error('Quality evidence is expired or has invalid timestamps');
  if (!Array.isArray(receipt.checks) || receipt.checks.length !== REQUIRED_CHECKS.length || !REQUIRED_CHECKS.every((id, i) => receipt.checks[i]?.id === id && receipt.checks[i].status === 'passed' && /^[a-f0-9]{64}$/.test(receipt.checks[i].log_sha256 ?? '')))
    throw new Error('A required quality check is missing or failed');
  for (const id of ['gate-regressions', 'api-source-selection', 'browser-input-chain', 'worker-authoring']) validateTapSummary(receipt.checks.find(check => check.id === id)?.summary);
  validateDocumentSummary(receipt.checks.find(check => check.id === 'document-regressions')?.summary);
  validateAcceptanceSummary(receipt.checks.find(check => check.id === 'real-model-acceptance')?.summary, expected);
  return receipt;
}
export function verifyRollbackReceipt(rawReceipt, expected, releasesLog, now = Date.now(), role) {
  const receipt = verifyReceipt(JSON.parse(rawReceipt), expected, now, true);
  const digest = createHash('sha256').update(rawReceipt).digest('hex');
  // Only an identical previously deployed receipt may waive freshness. A new SHA
  // or newly fabricated receipt cannot turn rollback into the normal release path.
  if (!hasSuccessfulDeployment(releasesLog, expected, digest, 'quality_sha256', role))
    throw new Error('Rollback requires the original passing receipt of a successfully deployed commit and role');
  return receipt;
}
function cleanTree() {
  if (git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Release evidence requires a clean tracked and untracked source tree; commit the reviewed changes first');
}
export function validateTestDatabase(value) {
  let database;
  try { database = new URL(value); } catch { throw new Error('BB_TEST_DATABASE_URL must point to a disposable local bb_prospectus_quality database'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) || !/^\/bb_prospectus_quality(?:_[a-z0-9_]+)?$/.test(database.pathname) || database.search || database.hash)
    throw new Error('Quality migrations require a disposable loopback database named bb_prospectus_quality or bb_prospectus_quality_<suffix>, without connection overrides');
  return database;
}
function run(receiptPath, release = true) {
  const receiptRelative = relative(resolve(root, '.local'), receiptPath);
  if (!receiptRelative || receiptRelative.startsWith('..') || isAbsolute(receiptRelative) || !receiptPath.endsWith('.json'))
    throw new Error('Write release receipts only beneath the ignored repository .local directory');
  // Invalidate an earlier pass before any preflight or child command can fail.
  if (release) rmSync(receiptPath, { force: true });
  if (process.platform !== 'linux') throw new Error('Release evidence requires Linux; Windows validation cannot cover the production worker');
  if (release) cleanTree();
  const testDatabase = validateTestDatabase(process.env.BB_TEST_DATABASE_URL);
  const commit = git(['rev-parse', 'HEAD']), tree = git(['rev-parse', 'HEAD^{tree}']);
  const started = new Date().toISOString();
  const python = process.env.BONDBUDDY_TEST_PYTHON || process.env.BONDBUDDY_WORD_PYTHON || process.env.BB_PYTHON || 'python3';
  const env = { ...process.env, DATABASE_URL: testDatabase.href, BB_TEST_DATABASE_URL: testDatabase.href, PYTHONPATH: [resolve(root, 'python'), resolve(root, 'python/tests')].join(delimiter),
    BB_PYTHON: python, BONDBUDDY_TEST_PYTHON: python, BONDBUDDY_WORD_PYTHON: python,
    BONDBUDDY_RUN_AUTHORIZED_DOCX_REGRESSION: '1', BB_REQUIRE_DOCUMENT_RENDER: '1', PYTHONDONTWRITEBYTECODE: '1' };
  const checks = [];
  const logRelative = `prospectus-quality-logs/${commit}/${release ? 'release' : 'mechanical'}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const logs = resolve(dirname(receiptPath), logRelative);
  mkdirSync(logs, { recursive: true });
  const check = (id, command, args, validate) => {
    process.stdout.write(`Running required quality check: ${id}\n`);
    let output;
    try { output = execute(command, args, { env }); }
    catch (error) { writeFileSync(resolve(logs, `${id}.log`), error.output || error.message); throw error; }
    writeFileSync(resolve(logs, `${id}.log`), output);
    process.stdout.write(output);
    const summary = validate?.(output);
    checks.push({ id, status: 'passed', log_path: `${logRelative}/${id}.log`, log_sha256: createHash('sha256').update(output).digest('hex'), ...(summary ? { summary } : {}) });
  };
  check('build', 'npm', ['run', 'build']);
  check('contracts', 'npm', ['run', 'check:contracts']);
  check('gate-regressions', process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', 'scripts/prospectus-quality-gate.test.mjs',
    'scripts/release-smoke/verify.test.mjs', 'scripts/release-smoke/quality-role.test.mjs',
    'deploy/m1/scripts/release-evidence.test.mjs',
    'deploy/m1/scripts/maintenance-version.test.mjs',
    'deploy/m1/scripts/role-source-evidence.test.mjs',
    'scripts/verify-prospectus-acceptance.test.mjs', 'scripts/verify-prospectus-expanded-amounts.test.mjs', 'scripts/verify-prospectus-pagination.test.mjs', 'scripts/publish-prospectus-quality.test.mjs', 'scripts/prospectus-input-browser.test.mjs',
    'deploy/m1/scripts/codex-bwrap.test.mjs'], parseTap);
  check('database-migrations', process.execPath, ['db/migrate.mjs']);
  check('api-source-selection', process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap',
    'apps/api/dist/prospectus-source-lock.pg.test.js', 'apps/api/dist/prospectus-auto-adoption.pg.test.js',
    'apps/api/dist/source-format.pg.test.js', 'apps/api/dist/none-baseline.pg.test.js'], parseTap);
  check('browser-input-chain', process.execPath, ['scripts/prospectus-input-browser.mjs'], parseTap);
  check('worker-authoring', process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap',
    'apps/worker/dist/file-authoring-quality.test.js', 'apps/worker/dist/file-authoring-delivery.test.js',
    'apps/worker/dist/file-authoring-repair.test.js',
    'apps/worker/dist/file-authoring-format.test.js', 'apps/worker/dist/file-authoring-quality.pg.test.js',
    'apps/worker/dist/authoring-material-tools.test.js', 'apps/worker/dist/codex-exec-log.test.js',
    'apps/worker/dist/none-baseline.test.js'], parseTap);
  check('document-regressions', python, ['scripts/run-document-quality-tests.py'], output => {
    const lines = output.split(/\r?\n/).filter(line => line.startsWith('DOCUMENT_QUALITY_RESULT='));
    if (lines.length !== 1) throw new Error('Missing document quality summary');
    return validateDocumentSummary(JSON.parse(lines[0].slice('DOCUMENT_QUALITY_RESULT='.length)));
  });
  check('deploy-regressions', 'bash', ['deploy/m1/scripts/test-deploy-space-gate.sh']);
  if (!release) {
    process.stdout.write(`Mechanical checks passed for the working tree based on ${commit}. Real-model acceptance was not run; no release receipt was issued. Logs: ${logs}\n`);
    return;
  }
  check('real-model-acceptance', process.execPath, ['scripts/verify-prospectus-acceptance.mjs'], output => {
    const lines = output.split(/\r?\n/).filter(line => line.startsWith('PROSPECTUS_ACCEPTANCE_RESULT='));
    if (lines.length !== 1) throw new Error('Missing real-model golden-case acceptance summary');
    return validateAcceptanceSummary(JSON.parse(lines[0].slice('PROSPECTUS_ACCEPTANCE_RESULT='.length)), { commit, tree });
  });
  cleanTree();
  if (git(['rev-parse', 'HEAD']) !== commit || git(['rev-parse', 'HEAD^{tree}']) !== tree) throw new Error('Source changed during quality checks');
  const receipt = { schema_version: POLICY, status: 'passed', commit, tree, clean_tree: true, platform: process.platform,
    started_at: started, finished_at: new Date().toISOString(), checks };
  verifyReceipt(receipt, { commit, tree });
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(`${receiptPath}.tmp`, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(`${receiptPath}.tmp`, receiptPath);
  process.stdout.write(`Release quality passed for ${commit}; evidence: ${receiptPath}\n`);
}
function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'run' && args.length <= 1) return run(resolve(args[0] || '.local/prospectus-quality.json'));
  if (mode === 'validate' && args.length === 0) return run(resolve('.local/prospectus-quality.json'), false);
  if ((mode === 'verify' && args.length === 2) || (mode === 'verify-rollback' && (args.length === 3 || args.length === 4))) {
    const [sha, filename, releasesLog, role] = args;
    if (!existsSync(filename)) throw new Error('Quality receipt is required before building, exporting, deploying or rolling back');
    const commit = git(['rev-parse', '--verify', `${sha}^{commit}`]);
    const raw = readFileSync(filename, 'utf8'), expected = { commit, tree: git(['rev-parse', `${commit}^{tree}`]) };
    if (mode === 'verify-rollback') verifyRollbackReceipt(raw, expected, readFileSync(releasesLog, 'utf8'), Date.now(), role);
    else verifyReceipt(JSON.parse(raw), expected);
    process.stdout.write(`Verified complete quality evidence for ${commit}\n`); return;
  }
  throw new Error('Usage: node scripts/prospectus-quality-gate.mjs run [receipt.json] | validate | verify <commit> <receipt.json> | verify-rollback <commit> <receipt.json> <releases.log> [main|execution]');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`Release quality gate: ${error.message}`); process.exitCode = 1; }
}
