import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, chmod, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createControlCredentialProvider, readControlSourceCredentials} from './control-credentials.mjs';

const config = {sourceCredentialsFile: '/synthetic-control/source.json', accountId: '100001',
  sourcePrincipalUin: '100002', roleId: '4611686018427000000',
  roleArn: 'qcs::cam::uin/100001:roleName/bondbuddy-execution-control'};
const source = {secretId: 'synthetic-source-id', secretKey: 'synthetic-source-key'};
const unavailable = error => error.message === 'CONTROL_CREDENTIALS_UNAVAILABLE' && !error.cause &&
  !String(error.stack).includes(source.secretKey);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };

// Deterministic STS fixtures. These never connect to Tencent and cannot prove
// a live role or its permission policy; the real signer is integrated separately.
function harness(overrides = {}) {
  let timestamp = Date.UTC(2026, 10, 15, 0), serial = 0;
  const stats = {reads: 0, assumes: 0, callers: 0, mutations: 0};
  const recorded = [];
  const readSource = async () => { stats.reads++; await overrides.onRead?.(); return {...source}; };
  const createTransport = async options => ({async call(service, action, payload) {
    assert.equal(service, 'sts');
    const c = await options.credentials();
    if (options.purpose === 'control-source') {
      assert.equal(action, 'AssumeRole'); assert.equal(options.assumeRoleArn, config.roleArn);
      assert.equal(Object.hasOwn(c, 'token'), false); assert.deepEqual(c, source);
      assert.deepEqual(payload, {RoleArn: config.roleArn, RoleSessionName: 'bondbuddy-execution-control', DurationSeconds: 1800});
      stats.assumes++; recorded.push({purpose: options.purpose, action});
      await overrides.onAssume?.();
      const expiry = Math.floor(timestamp / 1000) + 1800;
      const issued = {Credentials: {TmpSecretId: `synthetic-short-${++serial}`, TmpSecretKey: 'synthetic-short-key', Token: 'synthetic-short-token'},
        ExpiredTime: expiry, Expiration: new Date(expiry * 1000).toISOString(), RequestId: 'synthetic-assume-request'};
      return overrides.issued ? overrides.issued(issued) : issued;
    }
    assert.equal(options.purpose, 'role'); assert.equal(action, 'GetCallerIdentity');
    assert.ok(c.token); assert.notEqual(c.secretId, source.secretId); stats.callers++;
    recorded.push({purpose: options.purpose, action});
    await overrides.onCaller?.();
    const caller = {AccountId: config.accountId, UserId: `${config.roleId}:bondbuddy-execution-control`,
      PrincipalId: config.sourcePrincipalUin, RequestId: 'synthetic-caller-request'};
    return overrides.caller ? overrides.caller(caller) : caller;
  }});
  const dependencies = {readSource, createTransport, now: () => timestamp};
  const provider = createControlCredentialProvider({...config, ...overrides.config}, dependencies);
  return {provider, stats, recorded, dependencies, get now() { return timestamp; },
    set now(value) { timestamp = value; },
    async mutation() { await provider.get(); stats.mutations++; },
  };
}

test('cold start verifies owner, exact role/session, and source principal before returning isolated short credentials', async () => {
  const h = harness(), value = await h.provider.get();
  assert.deepEqual(Object.keys(value), ['secretId', 'secretKey', 'token', 'expiresAt']);
  assert.ok(Object.isFrozen(value)); assert.throws(() => { value.secretId = 'changed'; });
  const second = await h.provider.get(); assert.notEqual(value, second); assert.deepEqual(value, second);
  assert.deepEqual(h.recorded, [{purpose: 'control-source', action: 'AssumeRole'}, {purpose: 'role', action: 'GetCallerIdentity'}]);
  assert.deepEqual(h.stats, {reads: 1, assumes: 1, callers: 1, mutations: 0});
  assert.equal(JSON.stringify(h.provider.metadata()).includes('secret'), false);
});

test('concurrent cold callers reserve one flight before the source read await', async () => {
  const gate = deferred(), h = harness({onRead: () => gate.promise});
  const calls = Array.from({length: 40}, () => h.provider.get());
  await delay(0); assert.equal(h.stats.reads, 1); assert.equal(h.stats.assumes, 0);
  gate.resolve(); const values = await Promise.all(calls);
  assert.equal(new Set(values.map(v => v.secretId)).size, 1); assert.equal(h.stats.assumes, 1); assert.equal(h.stats.callers, 1);
});

test('refresh begins at the early boundary and concurrent requests cannot use the former bundle', async () => {
  const gate = deferred(); let block = false;
  const h = harness({onRead: () => block ? gate.promise : undefined});
  const old = await h.provider.get(); h.now = old.expiresAt - 300000 - 60000; block = true;
  const next = Array.from({length: 12}, () => h.provider.get()); await delay(0);
  assert.equal(h.provider.metadata().expiresAt, null); assert.equal(h.stats.reads, 2);
  gate.resolve(); const values = await Promise.all(next);
  assert.equal(new Set(values.map(v => v.secretId)).size, 1); assert.notEqual(values[0].secretId, old.secretId);
  assert.equal(h.stats.assumes, 2);
});

test('refresh failure rejects the new mutation despite a still unexpired former token and reveals no error payload', async () => {
  let fail = false; const h = harness({onAssume: () => { if (fail) throw Error(source.secretKey + ' synthetic-short-token'); }});
  const old = await h.provider.get(); h.now = old.expiresAt - 360000; fail = true;
  await assert.rejects(h.mutation, unavailable); assert.equal(h.stats.mutations, 0);
  assert.equal(h.provider.metadata().expiresAt, null); fail = false;
  await h.mutation(); assert.equal(h.stats.mutations, 1); assert.equal(h.stats.assumes, 3);
});

for (const field of ['AccountId', 'UserId', 'PrincipalId']) {
  test(`wrong ${field} refuses cloud admission`, async () => {
    const h = harness({caller: value => ({...value, [field]: 'different-principal'})});
    await assert.rejects(h.mutation, unavailable); assert.equal(h.stats.mutations, 0);
  });
}

const badResponses = {
  'expired credential': value => ({...value, ExpiredTime: 1, Expiration: '1970-01-01T00:00:01Z'}),
  'inconsistent UTC expiry': value => ({...value, Expiration: new Date((value.ExpiredTime + 1) * 1000).toISOString()}),
  'unbounded future expiry': value => ({...value, ExpiredTime: value.ExpiredTime + 7200,
    Expiration: new Date((value.ExpiredTime + 7200) * 1000).toISOString()}),
  'noninteger expiry': value => ({...value, ExpiredTime: value.ExpiredTime + 0.5}),
  'missing temporary token': value => ({...value, Credentials: {...value.Credentials, Token: null}}),
  'missing request ID': value => ({...value, RequestId: null}),
};
for (const [name, issued] of Object.entries(badResponses)) {
  test(`${name} is rejected before caller verification or cloud writes`, async () => {
    const h = harness({issued}); await assert.rejects(h.mutation, unavailable);
    assert.equal(h.stats.callers, 0); assert.equal(h.stats.mutations, 0);
  });
}

test('credentials crossing the safety boundary during caller verification are never published', async () => {
  let h; h = harness({onCaller: () => { h.now += 1500000; }});
  await assert.rejects(h.mutation, unavailable); assert.equal(h.provider.metadata().expiresAt, null);
});

test('a restarted provider reacquires credentials instead of trusting another process cache or a disk STS bundle', async () => {
  const h = harness(); const first = await h.provider.get();
  const restarted = createControlCredentialProvider(config, h.dependencies);
  const second = await restarted.get(); assert.notEqual(first.secretId, second.secretId);
  assert.equal(h.stats.reads, 2); assert.equal(h.stats.assumes, 2);
});

test('backward clock drift closes admission and forward expiration requires a newly verified role', async () => {
  const h = harness(); const first = await h.provider.get(); const original = h.now;
  h.now -= 60001; await assert.rejects(h.mutation, unavailable); assert.equal(h.stats.assumes, 1);
  h.now = original + 1800001; await h.mutation(); assert.equal(h.stats.assumes, 2);
  assert.notEqual((await h.provider.get()).secretId, first.secretId);
});

test('timed-out uncertain refresh stays single-flight, rejects new writes, and cannot publish a late response', async () => {
  const gate = deferred(); let blocked = true;
  const h = harness({config: {refreshTimeoutMs: 20}, onAssume: () => blocked ? gate.promise : undefined});
  await assert.rejects(h.provider.get(), unavailable);
  await assert.rejects(h.mutation, unavailable); await assert.rejects(h.provider.get(), unavailable);
  assert.equal(h.stats.assumes, 1); assert.equal(h.stats.mutations, 0); assert.equal(h.provider.metadata().refreshing, true);
  blocked = false; gate.resolve(); await delay(10);
  assert.equal(h.stats.callers, 0); assert.equal(h.provider.metadata().expiresAt, null);
  await h.mutation(); assert.equal(h.stats.assumes, 2); assert.equal(h.stats.callers, 1);
});

test('only the exact reviewed role ARN and bounded lifetime configuration are accepted', () => {
  for (const change of [{roleArn: 'qcs::cam::uin/100001:roleName/other'}, {accountId: '100003'},
    {durationSeconds: 43200}, {renewBeforeMs: 1800000}, {clockSkewMs: 600000}, {roleSessionName: 'bad session'}]) {
    assert.throws(() => createControlCredentialProvider({...config, ...change}), /CONTROL_CREDENTIAL_CONFIG_INVALID/);
  }
});

test('actual private-file parser rejects public mode, symlinks, writable parent, extra STS fields, and malformed contents', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bb-control-source-')); await chmod(directory, 0o700);
  t.after(() => rm(directory, {recursive: true})); const path = join(directory, 'source.json');
  await writeFile(path, JSON.stringify(source), {mode: 0o644});
  await assert.rejects(readControlSourceCredentials(path), unavailable); await chmod(path, 0o600);
  const link = join(directory, 'link.json'); await symlink(path, link);
  await assert.rejects(readControlSourceCredentials(link), unavailable);
  await chmod(directory, 0o777); await assert.rejects(readControlSourceCredentials(path), unavailable); await chmod(directory, 0o700);
  await writeFile(path, JSON.stringify({...source, token: 'synthetic-old-sts'}));
  await assert.rejects(readControlSourceCredentials(path), unavailable);
  await writeFile(path, 'invalid ' + source.secretKey); await assert.rejects(readControlSourceCredentials(path), unavailable);
});

test('actual root-owned 0600 source file yields only the dedicated two-key source', {skip: process.getuid?.() !== 0}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bb-control-root-')); await chmod(directory, 0o700);
  t.after(() => rm(directory, {recursive: true})); const path = join(directory, 'source.json');
  await writeFile(path, JSON.stringify(source), {mode: 0o600});
  assert.deepEqual(await readControlSourceCredentials(path), source);
  const h = harness(); const provider = createControlCredentialProvider({...config, sourceCredentialsFile: path},
    {...h.dependencies, readSource: readControlSourceCredentials});
  assert.ok((await provider.get()).token); assert.equal(h.stats.assumes, 1);
});
