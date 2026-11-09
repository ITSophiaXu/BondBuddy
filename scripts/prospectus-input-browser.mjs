#!/usr/bin/env node
// A separate, credential-free process owns every browser/API/storage fixture.
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { validateTestDatabase } from './prospectus-quality-gate.mjs';

export function browserTestEnvironment(source, home) {
  const database = validateTestDatabase(source.BB_TEST_DATABASE_URL);
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
    'BONDBUDDY_TEST_PYTHON', 'BONDBUDDY_WORD_PYTHON', 'BB_PYTHON', 'PYTHONUTF8']
    .filter(key => source[key]).map(key => [key, source[key]]));
  return { ...env, HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home, XDG_CONFIG_HOME: resolve(home, 'config'),
    CODEX_HOME: resolve(home, 'codex'), BB_TEST_DATABASE_URL: database.href,
    PLAYWRIGHT_BROWSERS_PATH: source.PLAYWRIGHT_BROWSERS_PATH || resolve(homedir(), '.cache/ms-playwright'),
    BB_PROSPECTUS_BROWSER_ISOLATED: '1', NODE_ENV: 'test', PYTHONDONTWRITEBYTECODE: '1' };
}

async function main() {
  if (process.platform !== 'linux') throw Error('Prospectus browser input evidence requires Linux');
  const template = validateTestDatabase(process.env.BB_TEST_DATABASE_URL);
  const { Client } = await import('pg');
  const home = mkdtempSync(resolve(tmpdir(), 'bb-prospectus-browser-home-'));
  const env = browserTestEnvironment(process.env, home);
  const id = randomUUID().replaceAll('-', '');
  const databaseName = `bb_prospectus_quality_browser_${id}`;
  const storageName = `bb-prospectus-browser-${id}`;
  const maintenance = new URL(template); maintenance.pathname = '/postgres';
  let mayHaveDatabase = false, mayHaveStorage = false, failure;
  const docker = args => {
    const result = spawnSync('docker', args, { env, encoding: 'utf8', timeout: 60_000 });
    if (result.error || result.status !== 0) throw Object.assign(Error(`Docker test fixture failed (${args[0]})`), { cause: result });
    return result.stdout.trim();
  };
  const withDatabase = async work => {
    const client = new Client({ connectionString: maintenance.href, connectionTimeoutMillis: 10_000, query_timeout: 30_000 });
    await client.connect();
    try { return await work(client); } finally { await client.end(); }
  };
  try {
    // The parent owns exact resource names, including cleanup after a timed-out child.
    await withDatabase(async client => {
      if ((await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [databaseName])).rowCount)
        throw Error('Browser test database already exists');
      mayHaveDatabase = true;
      await client.query(`CREATE DATABASE "${databaseName}" TEMPLATE "${decodeURIComponent(template.pathname.slice(1))}"`);
    });
    mayHaveStorage = true;
    docker(['run', '-d', '--name', storageName, '--label', `com.bondbuddy.browser-input=${storageName}`,
      '-p', '127.0.0.1::10000', 'mcr.microsoft.com/azure-storage/azurite:3.35.0',
      'azurite-blob', '--blobHost', '0.0.0.0', '--skipApiVersionCheck', '--silent']);
    const storagePort = Number(docker(['inspect', '--format', '{{ (index (index .NetworkSettings.Ports "10000/tcp") 0).HostPort }}', storageName]));
    if (!Number.isInteger(storagePort) || storagePort < 1 || storagePort > 65535) throw Error('Invalid browser storage port');
    const database = new URL(template); database.pathname = `/${databaseName}`;
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap',
      'scripts/prospectus-input-browser.integration.mjs'], {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
      env: { ...env, BB_TEST_DATABASE_URL: database.href,
        BB_PROSPECTUS_BROWSER_STORAGE_PORT: String(storagePort) }, stdio: 'inherit', timeout: 240_000
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error(`Prospectus browser input failed (${result.status ?? result.signal})`);
  } catch (error) { failure = error; }
  finally {
    const cleanupErrors = [];
    if (mayHaveStorage) {
      try {
        const inspected = spawnSync('docker', ['inspect', '--format', '{{ index .Config.Labels "com.bondbuddy.browser-input" }}', storageName],
          { env, encoding: 'utf8', timeout: 30_000 });
        if (inspected.error) throw inspected.error;
        if (inspected.status === 0) {
          if (inspected.stdout.trim() !== storageName) throw Error('Browser storage ownership label mismatch');
          docker(['rm', '--force', storageName]);
        } else if (!/No such (object|container)/i.test(inspected.stderr)) throw Error('Cannot verify browser storage cleanup');
      } catch (error) { cleanupErrors.push(error); }
    }
    if (mayHaveDatabase) {
      try { await withDatabase(client => client.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)); }
      catch (error) { cleanupErrors.push(error); }
    }
    try { rmSync(home, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
    if (failure || cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors].filter(Boolean),
      [failure?.message, ...cleanupErrors.map(error => error.message)].filter(Boolean).join('; '));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
