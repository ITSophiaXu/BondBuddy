import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

// #6 acceptance: provider keys and server environment names never reach the browser bundle.
// The build runs with synthetic canary values in provider-style variables to prove they are not inlined.
const CANARY = 'bb-synthetic-canary-7f3c9a';
const require = createRequire(import.meta.url);
const viteCli = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
const FORBIDDEN = [/DEEPSEEK/i, /OPENAI_API_KEY/, /ANTHROPIC/, /BB_CODEX/, /BB_SYNTHETIC/, /AZURE_STORAGE_CONNECTION_STRING/, /DATABASE_URL/, /PGPASSWORD/,
  /AccountKey=/, /api\.deepseek\.com/, /\bsk-[A-Za-z0-9]{20,}/, /\bBB_[A-Z][A-Z0-9_]{2,}/, new RegExp(CANARY)];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? files(path) : [path]; });
}

test('built web bundle contains no provider key, canary value or server env name', () => {
  const out = mkdtempSync(join(tmpdir(), 'bb-web-bundle-'));
  try {
    const env = { ...process.env, DEEPSEEK_API_KEY: CANARY, OPENAI_API_KEY: CANARY, BB_CODEX_CREDENTIAL_ENV: CANARY, BB_SYNTHETIC_DEEPSEEK_KEY: CANARY, VITE_DEEPSEEK_API_KEY: undefined };
    // Launch the installed CLI directly: Windows cannot execute the npx.cmd
    // shim through spawnSync without a shell. No shell or package download is needed.
    const build = spawnSync(process.execPath, [viteCli, 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { env, encoding: 'utf8' });
    assert.ifError(build.error);
    assert.equal(build.status, 0, build.stderr || `Vite terminated with signal ${build.signal}`);
    const built = files(out);
    assert.ok(built.some(path => path.endsWith('.js')), 'bundle produced JavaScript');
    for (const path of built) {
      const text = readFileSync(path, 'utf8');
      for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern, `${pattern} found in ${path.slice(out.length)}`);
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
});
