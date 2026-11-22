import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { browserTestEnvironment } from './prospectus-input-browser.mjs';

const database = 'postgresql://synthetic:synthetic-only@127.0.0.1:55321/bb_prospectus_quality';
test('browser runner strips provider, production, child injection and authenticated-home environment', () => {
  const home = resolve('synthetic-empty-home');
  const env = browserTestEnvironment({ BB_TEST_DATABASE_URL: database, PATH: process.env.PATH,
    CODEX_HOME: '/actual-credentials', HOME: '/actual-home', GH_TOKEN: 'synthetic-canary', COPILOT_TOKEN: 'synthetic-canary',
    OPENAI_API_KEY: 'synthetic-canary', AZURE_STORAGE_CONNECTION_STRING: 'synthetic-canary',
    DATABASE_URL: 'postgresql://production/database', NODE_OPTIONS: '--import=untrusted.js', NODE_PATH: '/untrusted',
    HTTP_PROXY: 'http://untrusted.invalid', BB_RUN_RUNTIME_ENABLED: '1', BB_CODEX_COMMAND: 'untrusted',
    PLAYWRIGHT_BROWSERS_PATH: '/synthetic-browser-cache' }, home);
  assert.equal(env.BB_TEST_DATABASE_URL, database);
  assert.equal(env.HOME, home); assert.equal(env.CODEX_HOME, resolve(home, 'codex'));
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, '/synthetic-browser-cache');
  for (const key of ['GH_TOKEN', 'COPILOT_TOKEN', 'OPENAI_API_KEY', 'AZURE_STORAGE_CONNECTION_STRING', 'DATABASE_URL',
    'NODE_OPTIONS', 'NODE_PATH', 'HTTP_PROXY', 'BB_RUN_RUNTIME_ENABLED', 'BB_CODEX_COMMAND']) assert.equal(env[key], undefined, key);
});
test('browser runner rejects missing, shared and remote databases before launching any service', () => {
  for (const value of [undefined, 'postgresql://production/bb_prospectus_quality', 'postgresql://localhost/bondbuddy',
    `${database}?host=production`]) assert.throws(() => browserTestEnvironment({ BB_TEST_DATABASE_URL: value }, '/empty'));
});
