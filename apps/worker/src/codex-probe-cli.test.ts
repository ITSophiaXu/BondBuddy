import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fake = fileURLToPath(new URL('../test-fixtures/codex/fake-codex.mjs', import.meta.url));
const cli = fileURLToPath(new URL('./codex-probe-cli.js', import.meta.url));

test('in-memory probe refuses managed or production execution before reading files or adapter config', () => {
  for (const restriction of [
    { BB_EXECUTION_ENROLLMENT_FILE: '/missing/private-context.json' },
    { NODE_ENV: 'production' },
  ]) {
    const child = spawnSync(
      process.execPath,
      [cli, '--prompt-file', '/missing/private-prompt.txt'],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: { PATH: process.env.PATH, BB_CODEX_BIN: '/missing/command', ...restriction },
      },
    );
    assert.equal(child.status, 2);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr, 'CODEX_PROBE_REQUIRES_DURABLE_LEASE\n');
  }
});

// Windows cannot execute the fixture's POSIX shebang. Redirect only this synthetic
// command to Node; the CLI, adapter arguments, validator and process stream stay real.
async function fixtureLauncher(dir: string): Promise<string[]> {
  const preload = join(dir, 'fixture-launcher.mjs');
  await writeFile(
    preload,
    [
      "import childProcess from 'node:child_process';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'const originalSpawn = childProcess.spawn;',
      `const fixture = ${JSON.stringify(fake)};`,
      'childProcess.spawn = (command, args, options) => command === fixture',
      '  ? originalSpawn(process.execPath, [fixture, ...args], options)',
      '  : originalSpawn(command, args, options);',
      'syncBuiltinESMExports();',
    ].join('\n'),
  );
  return ['--import', pathToFileURL(preload).href];
}

test('redacted Copilot probe identifies command auth without printing credential values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-copilot-probe-test-'));
  try {
    const prompt = join(dir, 'prompt.txt');
    await writeFile(prompt, 'SCENARIO:structured return JSON');
    const child = spawnSync(
      process.execPath,
      [...(await fixtureLauncher(dir)), cli, '--prompt-file', prompt],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          BB_CODEX_AUTH_MODE: 'copilot_enterprise',
          BB_COPILOT_OAUTH_FILE: '/run/secrets/bb-copilot-oauth',
          BB_CODEX_PROVIDER: 'copilot_enterprise',
          BB_CODEX_BASE_URL: 'https://api.enterprise.githubcopilot.com',
          BB_CODEX_MODEL: 'gpt-6-sol',
          BB_CODEX_REASONING_EFFORT: 'max',
          BB_CODEX_CONFIG_VERSION: 'copilot-test-v1',
          BB_CODEX_BIN: fake,
          BB_CODEX_WORK_ROOT: join(dir, 'work'),
          DEEPSEEK_API_KEY: 'synthetic-private-canary',
        },
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const output = JSON.parse(child.stdout);
    assert.deepEqual(output.config.credential, { kind: 'command' });
    assert.equal(output.status, 'completed');
    assert.ok(!child.stdout.includes('synthetic-private-canary'));
    assert.ok(!child.stdout.includes('/run/secrets/bb-copilot-oauth'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('schema-file probe enforces original uniqueItems after provider schema normalization', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-codex-probe-schema-test-'));
  try {
    const prompt = join(dir, 'prompt.txt'),
      schemaFile = join(dir, 'schema.json');
    await writeFile(prompt, 'SCENARIO:duplicate_ids');
    const launcher = await fixtureLauncher(dir);
    for (const dialect of [undefined, 'https://json-schema.org/draft/2020-12/schema']) {
      for (const uniqueItems of [true, false]) {
        await writeFile(
          schemaFile,
          JSON.stringify({
            ...(dialect ? { $schema: dialect } : {}),
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', uniqueItems, items: { type: 'string' } } },
          }),
        );
        const child = spawnSync(
          process.execPath,
          [...launcher, cli, '--prompt-file', prompt, '--schema-file', schemaFile],
          {
            encoding: 'utf8',
            timeout: 10000,
            env: {
              PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
              BB_CODEX_BIN: fake,
              BB_CODEX_WORK_ROOT: join(dir, 'work'),
              BB_CODEX_MAX_SCHEMA_REASKS: '0',
              DEEPSEEK_API_KEY: 'synthetic-probe-key',
            },
          },
        );
        assert.equal(child.status, uniqueItems ? 1 : 0, child.stderr);
        const output = JSON.parse(child.stdout);
        assert.equal(output.status, uniqueItems ? 'failed' : 'completed');
        assert.equal(output.error_code, uniqueItems ? 'MODEL_OUTPUT_SCHEMA_INVALID' : null);
        assert.equal(output.attempts.length, 1);
        assert.equal(output.attempts[0].usage.status, 'measured');
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
