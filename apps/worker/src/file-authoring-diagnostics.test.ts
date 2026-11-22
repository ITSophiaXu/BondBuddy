import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCodexProcess, loadCodexAdapterConfig } from './codex-adapter.js';

test('file authoring captures private command evidence before the workspace is discarded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bb-file-diagnostics-'));
  try {
    for (const name of ['home', 'scratch', 'output']) await mkdir(join(root, name));
    const config = {
      ...loadCodexAdapterConfig({}),
      command: [
        process.execPath,
        fileURLToPath(new URL('../test-fixtures/codex/fake-codex.mjs', import.meta.url)),
      ],
      path_env: process.env.PATH!,
      timeout_ms: 15000,
    };
    const result = await runCodexProcess(config, {
      prompt: 'SCENARIO:tool_attempt',
      cwd: root,
      home: join(root, 'home'),
      codexHome: join(root, 'home'),
      schemaFile: null,
      ephemeral: true,
      resumeThreadId: null,
      fileAuthoring: true,
    });
    assert.equal(result.exit_code, 0);
    assert.equal(result.turn_completed, true);
    assert.equal(result.file_diagnostics?.tools.length, 1);
    assert.equal(result.file_diagnostics?.tools[0]?.output, 'synthetic');
    assert.equal(result.file_diagnostics?.tools[0]?.exit_code, 0);
    assert.equal(result.file_diagnostics?.omitted, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
