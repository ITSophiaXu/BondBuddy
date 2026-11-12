#!/usr/bin/env node
// A separate, credential-free process owns every browser/API/storage fixture.
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { validateTestDatabase } from './prospectus-quality-gate.mjs';

const storageImage = 'mcr.microsoft.com/azure-storage/azurite:3.35.0';
const storageOwnerLabel = 'com.bondbuddy.browser-input';
const storageMemory = 512 * 1024 * 1024;
const storageNanoCpus = 500_000_000;

export function browserStorageHostPort(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535)
    throw Error('Browser storage host port must be a decimal port from 1 to 65535');
  return Number(value);
}

export function browserStorageArguments(name, requestedPort) {
  const port = requestedPort === undefined ? '' : browserStorageHostPort(String(requestedPort));
  return ['run', '-d', '--name', name, '--label', `${storageOwnerLabel}=${name}`,
    '--memory', '512m', '--memory-swap', '512m', '--cpus', '0.5',
    '-p', `127.0.0.1:${port}:10000`, storageImage,
    'azurite-blob', '--blobHost', '0.0.0.0', '--skipApiVersionCheck', '--silent'];
}

export function ownedBrowserStorage(container, name, expectedId) {
  if (!/^[a-f0-9]{64}$/.test(container?.Id ?? '') || (expectedId !== undefined && container.Id !== expectedId) ||
      container.Name !== `/${name}` || container.Config?.Image !== storageImage ||
      container.Config?.Labels?.[storageOwnerLabel] !== name)
    throw Error('Browser storage ownership mismatch');
  return container.Id;
}

export function browserStoragePort(container, name, expectedId, requestedPort) {
  ownedBrowserStorage(container, name, expectedId);
  const bindings = container.NetworkSettings?.Ports?.['10000/tcp'];
  if (bindings?.length !== 1 || bindings[0].HostIp !== '127.0.0.1')
    throw Error('Browser storage must bind only to IPv4 loopback');
  if (Object.entries(container.NetworkSettings.Ports).some(([port, values]) => port !== '10000/tcp' && values?.length))
    throw Error('Browser storage has an unexpected published port');
  const port = browserStorageHostPort(bindings[0].HostPort);
  if (port === undefined || (requestedPort !== undefined && port !== requestedPort))
    throw Error('Browser storage actual port differs from the requested port');
  if (!container.State?.Running || container.State.OOMKilled ||
      container.HostConfig?.Memory !== storageMemory || container.HostConfig.MemorySwap !== storageMemory ||
      container.HostConfig.NanoCpus !== storageNanoCpus)
    throw Error('Browser storage state or resource limits differ');
  return port;
}

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
  // An explicit host port works around Docker Desktop ephemeral-forwarding defects.
  // Only this scalar is configurable; the address always remains 127.0.0.1.
  const requestedStoragePort = browserStorageHostPort(process.env.BB_PROSPECTUS_BROWSER_STORAGE_HOST_PORT);
  const { Client } = await import('pg');
  const home = mkdtempSync(resolve(tmpdir(), 'bb-prospectus-browser-home-'));
  const env = browserTestEnvironment(process.env, home);
  const id = randomUUID().replaceAll('-', '');
  const databaseName = `bb_prospectus_quality_browser_${id}`;
  const storageName = `bb-prospectus-browser-${id}`;
  const maintenance = new URL(template); maintenance.pathname = '/postgres';
  let mayHaveDatabase = false, mayHaveStorage = false, storageId, failure;
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
    const startedId = docker(browserStorageArguments(storageName, requestedStoragePort));
    if (!/^[a-f0-9]{64}$/.test(startedId)) throw Error('Invalid browser storage container identity');
    storageId = startedId;
    const storagePort = browserStoragePort(JSON.parse(docker(['inspect', storageId]))[0],
      storageName, storageId, requestedStoragePort);
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
        const inspected = spawnSync('docker', ['inspect', storageId ?? storageName],
          { env, encoding: 'utf8', timeout: 30_000 });
        if (inspected.error) throw inspected.error;
        if (inspected.status === 0) {
          const ownedId = ownedBrowserStorage(JSON.parse(inspected.stdout)[0], storageName, storageId);
          docker(['rm', '--force', ownedId]);
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
