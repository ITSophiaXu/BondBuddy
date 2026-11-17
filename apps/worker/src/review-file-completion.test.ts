import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, rmdir, symlink, link, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reviewCompletionFeedback } from './review-file-completion.js';
import { buildCodexArgs, loadCodexAdapterConfig } from './codex-adapter.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';

const report = '# 合成复核报告\n已核对合成报表收入与原稿披露，金额一致。未提供审计原件，相关结论待确认。';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bb-review-stop-'));
  await mkdir(join(root, 'output'));
  await writeFile(join(root, 'input.json'), JSON.stringify({ version: 'review-file-input-v1' }));
  return root;
}

test('review Stop is explicitly trusted and isolated from authoring recovery capabilities', () => {
  const config = loadCodexAdapterConfig({}), base = { cwd: '/tmp/job', schemaFile: null, ephemeral: true, resumeThreadId: null };
  const args = buildCodexArgs(config, { ...base, fileAuthoring: true, reviewCompletion: true }).join(' ');
  assert.match(args, /--enable hooks/); assert.match(args, /trusted_hash=/);
  assert.match(args, /review-file-completion.js/);
  assert.doesNotMatch(args, /SessionStart|bb_continuation|file-authoring-completion.js|--disable hooks|bypass|dangerously/);
  assert.match(args, /network=\{enabled=false\}/);
  assert.match(args, /scratch\/task-handoff.md/);
  for (const other of [{}, { fileAuthoring: true }]) assert.doesNotMatch(buildCodexArgs(config, { ...base, ...other }).join(' '), /review-file-completion/);
  for (const other of [{}, { fileAuthoring: true, fileCompletion: true }, { fileAuthoring: true, fileRecovery: true }, { fileAuthoring: true, contextRotation: true }]) {
    assert.throws(() => buildCodexArgs(config, { ...base, ...other, reviewCompletion: true }), /MODEL_ADAPTER_CONFIG_INVALID/);
  }
});

test('missing, empty, progress-only and invalid Word reports request one correction', async () => {
  const root = await fixture();
  try {
    for (const text of [null, '', '# **\n', 'BB_REVIEW_PROGRESS:prepare_report:completed\n']) {
      if (text !== null) await writeFile(join(root, 'output/report.md'), text);
      await writeFile(join(root, 'output/report.docx'), 'not a Word document');
      assert.equal((await reviewCompletionFeedback(root, false)).decision, 'block');
      assert.deepEqual(await reviewCompletionFeedback(root, true), {});
    }
    await writeFile(join(root, 'output/report.docx'), makeWorkerDocxFixture({ externalLink: false, text: 'BB_REVIEW_PROGRESS:prepare_report:completed' }));
    assert.equal((await reviewCompletionFeedback(root, false)).decision, 'block');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('either saved Markdown or readable Word is sufficient; no extra companion is required', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'output/report.md'), report);
    assert.deepEqual(await reviewCompletionFeedback(root, false), {});
    await rm(join(root, 'output/report.md'));
    await writeFile(join(root, 'output/report.docx'), makeWorkerDocxFixture({ externalLink: false, text: report }));
    assert.deepEqual(await reviewCompletionFeedback(root, false), {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unsafe, linked and oversized files cannot satisfy completion', async () => {
  const root = await fixture(), path = join(root, 'output/report.md');
  try {
    await writeFile(join(root, 'actual.md'), report);
    await symlink(join(root, 'actual.md'), path);
    assert.equal((await reviewCompletionFeedback(root, false)).decision, 'block');
    await rm(path); await link(join(root, 'actual.md'), path);
    assert.equal((await reviewCompletionFeedback(root, false)).decision, 'block');
    await rm(path); await writeFile(path, report); await truncate(path, 4 * 1024 * 1024 + 1);
    assert.equal((await reviewCompletionFeedback(root, false)).decision, 'block');
    await rm(path); await rmdir(join(root, 'output'));
    await mkdir(join(root, 'elsewhere')); await writeFile(join(root, 'elsewhere/report.md'), report);
    await symlink(join(root, 'elsewhere'), join(root, 'output'), 'junction');
    assert.equal((await reviewCompletionFeedback(root, false)).decision, 'block');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('malformed and non-review input contracts do not acquire a review completion protocol', async () => {
  const root = await fixture();
  try {
    for (const input of ['{', 'null', '{}', '{"version":"codex-file-input-v1"}']) {
      await writeFile(join(root, 'input.json'), input);
      assert.deepEqual(await reviewCompletionFeedback(root, false), {});
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
