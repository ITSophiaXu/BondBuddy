import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Test the trusted subprocess protocol without needing LibreOffice in every unit environment.
async function fakePython(t: import('node:test').TestContext, program: string) {
  const root = await mkdtemp(join(tmpdir(), 'bb-renderer-protocol-'));
  const executable = join(root, 'python');
  await writeFile(executable, '#!/usr/bin/env node\n' + program, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return executable;
}

function usePython(t: import('node:test').TestContext, executable: string) {
  const before = process.env.BONDBUDDY_WORD_PYTHON;
  process.env.BONDBUDDY_WORD_PYTHON = executable;
  t.after(() => {
    if (before === undefined) delete process.env.BONDBUDDY_WORD_PYTHON;
    else process.env.BONDBUDDY_WORD_PYTHON = before;
  });
}

test('host renderer accepts only a successful one-page capability report', { skip: process.platform === 'win32' }, async t => {
  const { verifyHostWordRenderer } = await import('./file-authoring-renderer.js');
  usePython(t, await fakePython(t,
    'process.stdout.write(JSON.stringify({version:"word-renderer-capability-v1",status:"ready",renderer:"LibreOffice",pages:1}))'));
  await verifyHostWordRenderer();
});

test('host renderer rejects exit-zero malformed or contradictory reports', { skip: process.platform === 'win32' }, async t => {
  const { verifyHostWordRenderer } = await import('./file-authoring-renderer.js');
  for (const result of [{}, { version: 'word-renderer-capability-v1', status: 'ready', pages: 0 },
    { version: 'word-renderer-capability-v1', status: 'not_required', reason: 'short_source' },
    { version: 'word-renderer-capability-v1', status: 'unavailable', reason: 'renderer_missing' }]) {
    await t.test(JSON.stringify(result), async sub => {
      usePython(sub, await fakePython(sub,
        'process.stdout.write(' + JSON.stringify(JSON.stringify(result)) + ')'));
      await assert.rejects(verifyHostWordRenderer(), /WORD_RENDERER_/);
    });
  }
});

test('host renderer reports a controlled infrastructure reason without arbitrary stderr', { skip: process.platform === 'win32' }, async t => {
  const { verifyHostWordRenderer } = await import('./file-authoring-renderer.js');
  usePython(t, await fakePython(t,
    'process.stderr.write("synthetic-private-diagnostic");process.stdout.write(JSON.stringify({version:"word-renderer-capability-v1",status:"unavailable",reason:"renderer_process_failed",diagnostic:{exit_code:1,stderr_category:"proc_access_denied"}}));process.exitCode=1;'));
  await assert.rejects(verifyHostWordRenderer(), error => {
    assert.match(String(error), /WORD_RENDERER_UNAVAILABLE:renderer_process_failed/);
    assert.match(String(error), /proc_access_denied:exit=1/);
    assert.doesNotMatch(String(error), /synthetic-private-diagnostic/);
    return true;
  });
});

test('host renderer preserves cancellation and does not treat an interrupted probe as ready', { skip: process.platform === 'win32' }, async t => {
  const { verifyHostWordRenderer } = await import('./file-authoring-renderer.js');
  usePython(t, await fakePython(t, 'setTimeout(()=>{},10000);'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(verifyHostWordRenderer(undefined, controller.signal), /abort/i);
});
