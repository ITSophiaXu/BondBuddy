// Run in a disposable, networkless worker container; never starts its runtime.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { filePermissionArgs, verifyFilePermissions } from '/app/apps/worker/dist/codex-file-permissions.js';
import { finalizeFormat } from '/app/apps/worker/dist/file-authoring-format.js';
import { verifyWordQuality } from '/app/apps/worker/dist/file-authoring-quality.js';

const exec = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const python = '/opt/venv/bin/python';
const pathEnv = '/opt/venv/bin:/usr/local/bin:/usr/bin:/bin';
const root = await mkdtemp('/tmp/bb-synthetic-preflight-');
const cliHome = join(root, 'cli-home');
const evidence = { version: 'synthetic-preflight-host-handoff-v1', scope: 'synthetic only',
  model_calls: 0, task_operations: 0, cases: [], source_files: {} };
async function sandboxPreflight(cwd) {
  let exitCode = 0, stdout, stderr;
  try {
    ({ stdout, stderr } = await exec('codex', [...filePermissionArgs(cwd), 'sandbox', '--', python, '-B', '-s', '-m',
      'bondbuddy_file_authoring.fixed_edit', 'preflight', '--input', join(cwd, 'input.json'),
      '--operations', join(cwd, 'output/operations.json'), '--report', join(cwd, 'scratch/preflight.json')],
    { cwd, env: { PATH: pathEnv, HOME: join(cwd, 'scratch'), CODEX_HOME: cliHome, TMPDIR: join(cwd, 'scratch'),
      PYTHONPATH: '/app/python', PYTHONDONTWRITEBYTECODE: '1', LANG: 'C.UTF-8' }, timeout: 300000, maxBuffer: 1024 * 1024 }));
  } catch (error) {
    assert.equal(error.code, 1, error.stderr);
    exitCode = error.code; stdout = error.stdout; stderr = error.stderr;
  }
  assert.equal(exitCode, 1);
  assert.match(stderr, /WORD_PREFLIGHT_REJECTED/);
  return { exitCode, stdout, brief: JSON.parse(stdout),
    report: JSON.parse(await readFile(join(cwd, 'scratch/preflight.json'), 'utf8')) };
}
try {
  await mkdir(cliHome);
  const fixture = await exec(python, ['-B', join(dirname(fileURLToPath(import.meta.url)), 'fixtures.py'), root],
    { env: { ...process.env, PYTHONPATH: '/app/python' }, timeout: 30000 });
  evidence.fixture = JSON.parse(fixture.stdout);
  for (const name of ['python/bondbuddy_file_authoring/preflight.py', 'python/bondbuddy_file_authoring/quality.py',
    'python/bondbuddy_file_authoring/document_size.py', 'apps/worker/dist/file-authoring-format.js',
    'apps/worker/dist/file-authoring-quality.js', 'apps/worker/dist/codex-file-permissions.js'])
    evidence.source_files[name] = digest(await readFile('/app/' + name));
  await verifyFilePermissions({ command: ['codex'], path_env: pathEnv }, join(root, 'good'), cliHome);
  evidence.existing_file_permission_probe = 'passed';
  for (const name of ['good', 'mixed', 'body-collapse']) {
    const cwd = join(root, name);
    const lockedInput = await readFile(join(cwd, 'input.json'));
    const baselineBytes = await readFile(join(cwd, 'source.docx'));
    const operations = await readFile(join(cwd, 'output/operations.json'));
    const permissionArgs = filePermissionArgs(cwd);
    if (name === 'good') {
      const middle = await readFile(join(cwd, 'intermediate-operations.json'));
      await writeFile(join(cwd, 'output/operations.json'), middle);
      const initial = await sandboxPreflight(cwd);
      assert.equal(initial.report.status, 'failed');
      assert.equal(initial.report.snapshot_current, true);
      assert.equal(initial.brief.host_handoff.action, 'defer_page_rendering_to_host');
      assert.equal(initial.brief.host_handoff.authoring_completion, 'not_verified');
      assert.equal(initial.brief.host_handoff.operations_sha256, digest(middle));
      assert.equal(initial.report.operation_count, 30);
      // Continue outstanding authoring work; this intermediate diagnostic cannot
      // approve the 30 additional operations or substitute for a final preflight.
      await writeFile(join(cwd, 'output/operations.json'), operations);
      assert.notEqual(initial.brief.host_handoff.operations_sha256, digest(operations));
      evidence.intermediate_authoring = { preflight: initial.brief,
        continued_operation_count: JSON.parse(operations).operations.length,
        final_operations_sha256: digest(operations) };
    }
    const { exitCode, stdout, brief, report } = await sandboxPreflight(cwd);
    assert.equal(report.status, 'failed'); assert.equal(report.host_acceptance, false);
    assert.equal(report.snapshot_current, true);
    assert.equal(report.input_sha256, digest(lockedInput));
    assert.equal(report.baseline_sha256, digest(baselineBytes));
    assert.equal(report.operations_sha256, digest(operations));
    assert.deepEqual(await readFile(join(cwd, 'input.json')), lockedInput);
    assert.deepEqual(await readFile(join(cwd, 'source.docx')), baselineBytes);
    assert.deepEqual(await readFile(join(cwd, 'output/operations.json')), operations);
    assert.ok(Buffer.byteLength(stdout) < 4096, 'handoff must fit the short model tool result');
    assert.equal(brief.quality_report, undefined); assert.equal(brief.diagnostics, undefined);
    assert.equal(stdout.includes('Source issuer exchange bond disclosure'), false);
    if (name === 'good') {
      assert.deepEqual(report.issues, [{ code: 'WORD_PAGE_COUNT_UNAVAILABLE', reason: 'render_output_invalid' }]);
      assert.equal(brief.host_handoff.action, 'defer_page_rendering_to_host');
      assert.equal(brief.host_handoff.authoring_completion, 'not_verified');
      assert.equal(brief.host_handoff.operations_sha256, digest(operations));
      assert.deepEqual(brief.host_handoff, report.host_handoff);
      assert.equal(report.operation_count, 60);
      assert.equal(evidence.intermediate_authoring.final_operations_sha256, report.operations_sha256);
    } else {
      assert.equal(report.host_handoff, undefined); assert.equal(brief.host_handoff, undefined);
      if (name === 'mixed') assert.deepEqual(new Set(report.issues.map(i => i.code)),
        new Set(['WORD_PAGE_COUNT_UNAVAILABLE', 'WORD_EXPECTED_FACT_MISMATCH']));
      else assert.ok(report.issues.some(i => i.code === 'WORD_DOCUMENT_SIZE_REDUCED' && i.metric === 'body_characters'));
    }
    // Neither preflight nor handoff metadata is supplied to the worker helpers.
    const files = await finalizeFormat({ lockedInput, baselineBytes, operations });
    assert.deepEqual(files.get('baseline.docx'), baselineBytes);
    assert.deepEqual(JSON.parse(files.get('operations.json')), JSON.parse(operations));
    const final = await verifyWordQuality({ data: JSON.parse(lockedInput.toString()),
      tracked: files.get('tracked.docx'), clean: files.get('clean.docx'),
      baseline: baselineBytes, operations: files.get('operations.json') });
    assert.equal(final.tracked_sha256, digest(files.get('tracked.docx')));
    assert.equal(final.clean_sha256, digest(files.get('clean.docx')));
    if (name === 'good') {
      assert.equal(final.status, 'passed', JSON.stringify(final));
      assert.deepEqual(final.issues, []);
      assert.equal(final.document_size_check.page_check.baseline.pages, 60);
      assert.equal(final.document_size_check.page_check.clean.pages, 60);
      assert.equal(final.document_size_check.character_ratio, 1);
      assert.equal(final.document_size_check.page_check.ratio, 1);
    } else {
      assert.equal(final.status, 'failed');
      assert.ok(final.issues.some(i => i.code === (name === 'mixed' ? 'WORD_EXPECTED_FACT_MISMATCH' : 'WORD_DOCUMENT_SIZE_REDUCED')));
    }
    evidence.cases.push({ name, sandbox_exit_code: exitCode, stdout_byte_size: Buffer.byteLength(stdout),
      preflight: brief, host_quality: final, permission_args: permissionArgs,
      host_replay_input_operations_sha256: digest(operations),
      host_replay_output_operations_sha256: digest(files.get('operations.json')) });
    console.error(JSON.stringify({ synthetic_case: name, preflight: report.status, host: final.status }));
  }
  const pageGuard = await exec(python, ['-B', '-c',
    "import json,sys; from pathlib import Path; from bondbuddy_file_authoring.check import package; from bondbuddy_file_authoring.document_size import compare_size; p=Path(sys.argv[1]); print(json.dumps(compare_size(package(p/'source.docx'),package(p/'page-collapse.docx'))))", root],
  { env: { ...process.env, PYTHONPATH: '/app/python' }, timeout: 300000 });
  const pages = JSON.parse(pageGuard.stdout);
  assert.equal(pages.status, 'failed'); assert.equal(pages.character_ratio, 1);
  assert.equal(pages.page_check.baseline.pages, 60); assert.equal(pages.page_check.clean.pages, 20);
  assert.ok(pages.issues.some(i => i.code === 'WORD_DOCUMENT_SIZE_REDUCED' && i.metric === 'rendered_pages'));
  evidence.page_floor_counterexample = pages;
  evidence.status = 'passed';
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
