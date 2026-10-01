import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fake = fileURLToPath(new URL('../test-fixtures/codex/fake-codex.mjs', import.meta.url));
const cli = fileURLToPath(new URL('./codex-probe-cli.js', import.meta.url));

test('redacted Copilot probe identifies command auth without printing credential values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-copilot-probe-test-'));
  try {
    const prompt = join(dir, 'prompt.txt');
    await writeFile(prompt, 'SCENARIO:structured return JSON');
    const child = spawnSync(process.execPath, [cli, '--prompt-file', prompt], {
      encoding: 'utf8', timeout: 10000,
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        BB_CODEX_AUTH_MODE: 'copilot_enterprise', BB_COPILOT_OAUTH_FILE: '/run/secrets/bb-copilot-oauth',
        BB_CODEX_PROVIDER: 'copilot_enterprise', BB_CODEX_BASE_URL: 'https://api.enterprise.githubcopilot.com',
        BB_CODEX_MODEL: 'gpt-6-sol', BB_CODEX_REASONING_EFFORT: 'max', BB_CODEX_CONFIG_VERSION: 'copilot-test-v1',
        BB_CODEX_BIN: fake, BB_CODEX_WORK_ROOT: join(dir, 'work'), DEEPSEEK_API_KEY: 'synthetic-private-canary',
      },
    });
    assert.equal(child.status, 0, child.stderr);
    const output = JSON.parse(child.stdout);
    assert.deepEqual(output.config.credential, { kind: 'command' });
    assert.equal(output.status, 'completed');
    assert.ok(!child.stdout.includes('synthetic-private-canary'));
    assert.ok(!child.stdout.includes('/run/secrets/bb-copilot-oauth'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
