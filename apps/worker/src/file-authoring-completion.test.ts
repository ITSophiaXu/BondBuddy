import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { completionFeedback } from './file-authoring-completion.js';
import { buildCodexArgs, loadCodexAdapterConfig } from './codex-adapter.js';

test('only opted-in prospectus authoring enables the fixed trusted hook', () => {
  const c = loadCodexAdapterConfig({}),
    o = { cwd: '/tmp/job', schemaFile: null, ephemeral: true, resumeThreadId: null };
  for (const args of [buildCodexArgs(c, o), buildCodexArgs(c, { ...o, fileAuthoring: true })]) {
    assert.ok(args.join(' ').includes('--disable hooks'));
    assert.equal(
      args.some((a) => a.startsWith('hooks=')),
      false,
    );
  }
  const args = buildCodexArgs(c, { ...o, fileAuthoring: true, fileCompletion: true }).join(' ');
  assert.match(args, /--enable hooks/);
  assert.doesNotMatch(args, /--disable hooks|bypass|dangerously/);
  assert.match(args, /trusted_hash=/);
  assert.match(args, /network=\{enabled=false\}/);
});

test('missing operations continues once without fabricating a journal or accepting arbitrary Word', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bb-completion-'));
  try {
    await mkdir(join(root, 'output'));
    await writeFile(
      join(root, 'input.json'),
      JSON.stringify({
        version: 'codex-file-input-v1',
        format_tools: { version: 'controlled-docx-v1' },
      }),
    );
    await writeFile(join(root, 'output/tracked.docx'), 'arbitrary');
    await writeFile(join(root, 'output/clean.docx'), 'arbitrary');
    assert.equal((await completionFeedback(root, false)).decision, 'block');
    assert.deepEqual(await completionFeedback(root, true), {});
    await writeFile(join(root, 'output/operations.json'), '');
    assert.equal((await completionFeedback(root, false)).decision, 'block');
    await writeFile(
      join(root, 'output/operations.json'),
      'availability only; replay validates data later',
    );
    assert.deepEqual(await completionFeedback(root, false), {});
    await rm(join(root, 'output/operations.json'));
    await symlink(join(root, 'input.json'), join(root, 'output/operations.json'));
    assert.equal((await completionFeedback(root, false)).decision, 'block');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('direct-file route requires both files and unrelated input contracts are unaffected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bb-completion-pair-'));
  try {
    await mkdir(join(root, 'output'));
    await writeFile(join(root, 'input.json'), JSON.stringify({ version: 'codex-file-input-v1' }));
    await writeFile(join(root, 'output/tracked.docx'), 'tracked');
    assert.match(String((await completionFeedback(root, false)).reason), /clean.docx/);
    await writeFile(join(root, 'output/clean.docx'), 'clean');
    assert.deepEqual(await completionFeedback(root, false), {});
    await rm(join(root, 'output/clean.docx'));
    await writeFile(join(root, 'input.json'), JSON.stringify({ version: 'other-tool-v1' }));
    assert.deepEqual(await completionFeedback(root, false), {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
