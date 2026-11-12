import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { browserTestEnvironment, browserStorageArguments, browserStorageHostPort,
  browserStoragePort, ownedBrowserStorage } from './prospectus-input-browser.mjs';

const database = 'postgresql://synthetic:synthetic-only@127.0.0.1:55321/bb_prospectus_quality';
test('browser runner strips provider, production, child injection and authenticated-home environment', () => {
  const home = resolve('synthetic-empty-home');
  const env = browserTestEnvironment({ BB_TEST_DATABASE_URL: database, PATH: process.env.PATH,
    CODEX_HOME: '/actual-credentials', HOME: '/actual-home', GH_TOKEN: 'synthetic-canary', COPILOT_TOKEN: 'synthetic-canary',
    OPENAI_API_KEY: 'synthetic-canary', AZURE_STORAGE_CONNECTION_STRING: 'synthetic-canary',
    DATABASE_URL: 'postgresql://production/database', NODE_OPTIONS: '--import=untrusted.js', NODE_PATH: '/untrusted',
    HTTP_PROXY: 'http://untrusted.invalid', BB_RUN_RUNTIME_ENABLED: '1', BB_CODEX_COMMAND: 'untrusted',
    BB_PROSPECTUS_BROWSER_STORAGE_PORT: '9999', BB_PROSPECTUS_BROWSER_STORAGE_HOST_PORT: '55588',
    PLAYWRIGHT_BROWSERS_PATH: '/synthetic-browser-cache' }, home);
  assert.equal(env.BB_TEST_DATABASE_URL, database);
  assert.equal(env.HOME, home); assert.equal(env.CODEX_HOME, resolve(home, 'codex'));
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, '/synthetic-browser-cache');
  for (const key of ['GH_TOKEN', 'COPILOT_TOKEN', 'OPENAI_API_KEY', 'AZURE_STORAGE_CONNECTION_STRING', 'DATABASE_URL',
    'NODE_OPTIONS', 'NODE_PATH', 'HTTP_PROXY', 'BB_RUN_RUNTIME_ENABLED', 'BB_CODEX_COMMAND',
    'BB_PROSPECTUS_BROWSER_STORAGE_PORT', 'BB_PROSPECTUS_BROWSER_STORAGE_HOST_PORT']) assert.equal(env[key], undefined, key);
});

const name = 'bb-prospectus-browser-' + 'b'.repeat(32), id = 'a'.repeat(64);
const storage = () => ({ Id: id, Name: `/${name}`,
  Config: { Image: 'mcr.microsoft.com/azure-storage/azurite:3.35.0', Labels: { 'com.bondbuddy.browser-input': name } },
  State: { Running: true, OOMKilled: false },
  HostConfig: { Memory: 512 * 1024 * 1024, MemorySwap: 512 * 1024 * 1024, NanoCpus: 500_000_000 },
  NetworkSettings: { Ports: { '10000/tcp': [{ HostIp: '127.0.0.1', HostPort: '55588' }], '10001/tcp': null } } });

test('browser storage keeps random loopback publishing by default and bounds only its Azurite fixture', () => {
  assert.equal(browserStorageHostPort(undefined), undefined);
  for (const [requested, binding] of [[undefined, '127.0.0.1::10000'], [55588, '127.0.0.1:55588:10000']]) {
    const args = browserStorageArguments(name, requested);
    for (const [flag, expected] of [['-p', binding], ['--memory', '512m'], ['--memory-swap', '512m'], ['--cpus', '0.5']])
      assert.equal(args[args.indexOf(flag) + 1], expected);
    assert.equal(args.filter(value => value === '-p').length, 1);
  }
});

test('browser storage accepts only an explicit decimal host port, never an address or Docker argument', () => {
  for (const value of ['1', '55588', '65535']) assert.equal(browserStorageHostPort(value), Number(value));
  for (const value of ['', '0', '-1', '65536', '1.5', '5e4', '055588', ' 55588', '55588\n',
    '0.0.0.0:55588', '[::1]:55588', '55588:10000', '--network=host', 55588, null])
    assert.throws(() => browserStorageHostPort(value), /decimal port/, String(value));
});

test('browser storage uses the actual owned loopback binding and verifies the requested port', () => {
  assert.equal(browserStoragePort(storage(), name, id), 55588);
  assert.equal(browserStoragePort(storage(), name, id, 55588), 55588);
  assert.throws(() => browserStoragePort(storage(), name, id, 55589), /differs/);
  for (const host of ['0.0.0.0', '::', '::1', 'localhost', '192.0.2.1', undefined]) {
    const value = storage(); value.NetworkSettings.Ports['10000/tcp'][0].HostIp = host;
    assert.throws(() => browserStoragePort(value, name, id), /loopback/);
  }
});

test('browser storage rejects missing, ambiguous, malformed and extra published ports', () => {
  for (const bindings of [undefined, [], [null], [{ HostIp: '127.0.0.1', HostPort: '0' }],
    [{ HostIp: '127.0.0.1', HostPort: '55588:10000' }],
    [{ HostIp: '127.0.0.1', HostPort: '55588' }, { HostIp: '0.0.0.0', HostPort: '55588' }]]) {
    const value = storage(); value.NetworkSettings.Ports['10000/tcp'] = bindings;
    assert.throws(() => browserStoragePort(value, name, id));
  }
  const extra = storage(); extra.NetworkSettings.Ports['10001/tcp'] = [{ HostIp: '0.0.0.0', HostPort: '55589' }];
  assert.throws(() => browserStoragePort(extra, name, id), /unexpected published port/);
});

test('browser cleanup rejects another container even if one ownership field matches', () => {
  const mutations = [value => { value.Id = 'c'.repeat(64); }, value => { value.Name = '/unrelated'; },
    value => { value.Config.Image = 'unrelated'; }, value => { value.Config.Labels = {}; },
    value => { value.Config.Labels['com.bondbuddy.browser-input'] = 'another-attempt'; }];
  for (const mutate of mutations) {
    const value = storage(); mutate(value);
    assert.throws(() => ownedBrowserStorage(value, name, id), /ownership/);
  }
  assert.throws(() => ownedBrowserStorage(undefined, name, id), /ownership/);
});

test('browser cleanup can remove its exact stopped fixture but startup requires running within its budget', () => {
  const stopped = storage(); stopped.State.Running = false;
  assert.equal(ownedBrowserStorage(stopped, name, id), id);
  assert.equal(ownedBrowserStorage(stopped, name), id, 'A partial Docker run is still checked by exact name, label and image');
  assert.throws(() => browserStoragePort(stopped, name, id), /state or resource/);
  for (const change of [value => { value.State.OOMKilled = true; }, value => { value.HostConfig.Memory = 0; },
    value => { value.HostConfig.MemorySwap = -1; }, value => { value.HostConfig.NanoCpus = 0; }]) {
    const value = storage(); change(value);
    assert.throws(() => browserStoragePort(value, name, id), /state or resource/);
  }
});
test('browser runner rejects missing, shared and remote databases before launching any service', () => {
  for (const value of [undefined, 'postgresql://production/bb_prospectus_quality', 'postgresql://localhost/bondbuddy',
    `${database}?host=production`]) assert.throws(() => browserTestEnvironment({ BB_TEST_DATABASE_URL: value }, '/empty'));
});
