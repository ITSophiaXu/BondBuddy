import {constants} from 'node:fs';
import {open, lstat, realpath} from 'node:fs/promises';
import {dirname, isAbsolute} from 'node:path';

const unavailable = () => new Error('CONTROL_CREDENTIALS_UNAVAILABLE');
const assert = (condition, code = 'CONTROL_CREDENTIAL_CONFIG_INVALID') => {
  if (!condition) throw new Error(code);
};
const text = (value, maximum) => typeof value === 'string' && value.length > 0 &&
  value.length <= maximum && !/[\x00-\x20\x7f]/.test(value);

/** Only the privileged control service may read this source. The returned key
 * is used exclusively by the restricted AssumeRole signer, never by CVM/SSM. */
export async function readControlSourceCredentials(path) {
  let file;
  try {
    assert(isAbsolute(path), 'CONTROL_SOURCE_PRIVATE_FILE');
    const parent = await lstat(dirname(path));
    assert(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === 0 &&
      (parent.mode & 0o777) === 0o700 && await realpath(path) === path, 'CONTROL_SOURCE_PRIVATE_FILE');
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat();
    assert(before.isFile() && before.uid === 0 && (before.mode & 0o777) === 0o600 &&
      before.size > 0 && before.size <= 16384, 'CONTROL_SOURCE_PRIVATE_FILE');
    const bytes = await file.readFile();
    const after = await file.stat();
    assert(before.ino === after.ino && before.dev === after.dev && before.size === after.size &&
      before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && bytes.length <= 16384,
    'CONTROL_SOURCE_PRIVATE_FILE');
    return validateSource(JSON.parse(bytes.toString('utf8')));
  } catch { throw unavailable(); }
  finally { await file?.close(); }
}

function validateSource(value) {
  assert(value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 2 && text(value.secretId, 256) && text(value.secretKey, 4096),
  'CONTROL_SOURCE_INVALID');
  return Object.freeze({secretId: value.secretId, secretKey: value.secretKey});
}

async function defaultTransport(options) {
  // The signing implementation and its action allowlist have one owner. This
  // module only supplies the two strictly separated credential sources.
  const {TencentTransport} = await import('./tencent-cvm.mjs');
  return new TencentTransport(options);
}

/** get() is called by the existing control tick and immediately before signing.
 * No polling, credential file cache, or autonomous retry is installed here.
 * Tests may inject the HTTP transport; that does not prove a real STS call. */
export function createControlCredentialProvider({sourceCredentialsFile, accountId, sourcePrincipalUin,
  roleId, roleArn, roleSessionName = 'bondbuddy-execution-control', region = 'ap-beijing',
  durationSeconds = 1800, renewBeforeMs = 300000, clockSkewMs = 60000,
  refreshTimeoutMs = 20000}, {readSource = readControlSourceCredentials,
  createTransport = defaultTransport, now = Date.now} = {}) {
  assert(typeof sourceCredentialsFile === 'string' && isAbsolute(sourceCredentialsFile) && region === 'ap-beijing');
  assert([accountId, sourcePrincipalUin, roleId].every(v => typeof v === 'string' && /^\d{1,20}$/.test(v)));
  assert(roleArn === `qcs::cam::uin/${accountId}:roleName/bondbuddy-execution-control`);
  assert(typeof roleSessionName === 'string' && /^[A-Za-z0-9_+=,.@-]{2,128}$/.test(roleSessionName));
  assert(Number.isInteger(durationSeconds) && durationSeconds >= 900 && durationSeconds <= 7200);
  assert(Number.isInteger(clockSkewMs) && clockSkewMs >= 0 && clockSkewMs <= 120000);
  assert(Number.isInteger(renewBeforeMs) && renewBeforeMs >= 60000 &&
    renewBeforeMs + clockSkewMs < durationSeconds * 1000);
  assert(Number.isInteger(refreshTimeoutMs) && refreshTimeoutMs > 0 && refreshTimeoutMs <= 20000);
  let cache = null, flight = null, highWaterClock = -Infinity;
  const clock = () => {
    const current = now();
    if (!Number.isSafeInteger(current) || current < 0 || current < highWaterClock - clockSkewMs) {
      cache = null;
      throw unavailable();
    }
    highWaterClock = Math.max(highWaterClock, current);
    return current;
  };
  const usable = (entry, current) => entry && entry.credentials.expiresAt > current + renewBeforeMs + clockSkewMs;
  async function refresh(expired) {
    let source;
    try {
      const started = clock();
      source = validateSource(await readSource(sourceCredentialsFile));
      if (expired()) throw unavailable();
      const signer = await createTransport({region, purpose: 'control-source', assumeRoleArn: roleArn,
        credentials: async () => source});
      const issued = await signer.call('sts', 'AssumeRole', {
        RoleArn: roleArn, RoleSessionName: roleSessionName, DurationSeconds: durationSeconds,
      });
      source = undefined;
      if (expired()) throw unavailable();
      const at = clock(), credential = issued?.Credentials;
      const expiresAt = issued?.ExpiredTime * 1000, isoExpiry = Date.parse(issued?.Expiration);
      assert(Number.isSafeInteger(issued?.ExpiredTime) && Number.isSafeInteger(expiresAt) &&
        typeof issued.Expiration === 'string' && /(?:Z|\+00:00)$/.test(issued.Expiration) &&
        Number.isFinite(isoExpiry) && Math.floor(isoExpiry / 1000) === issued.ExpiredTime &&
        expiresAt <= started + durationSeconds * 1000 + clockSkewMs &&
        expiresAt > at + renewBeforeMs + clockSkewMs && text(issued.RequestId, 256),
      'CONTROL_STS_EXPIRY_INVALID');
      assert(text(credential?.TmpSecretId, 256) && text(credential?.TmpSecretKey, 4096) &&
        text(credential?.Token, 16384), 'CONTROL_STS_RESPONSE_INVALID');
      const credentials = Object.freeze({secretId: credential.TmpSecretId, secretKey: credential.TmpSecretKey,
        token: credential.Token, expiresAt});
      const role = await createTransport({region, purpose: 'role', credentials: async () => credentials});
      const caller = await role.call('sts', 'GetCallerIdentity', {});
      // Official STS fields bind both the assumed role and the source principal.
      // A session name is never used as an instance identity.
      assert(caller?.AccountId === accountId && caller.UserId === `${roleId}:${roleSessionName}` &&
        caller.PrincipalId === sourcePrincipalUin && text(caller.RequestId, 256), 'CONTROL_STS_IDENTITY_MISMATCH');
      if (expired()) throw unavailable();
      const entry = Object.freeze({credentials});
      assert(usable(entry, clock()), 'CONTROL_STS_EXPIRY_INVALID');
      cache = entry;
      return entry;
    } catch { cache = null; throw unavailable(); }
    finally { source = undefined; }
  }
  function refreshOnce() {
    if (flight) return flight.exposed;
    cache = null; // A failed refresh must never return the previous credentials.
    let timedOut = false, timer;
    // Reserve the flight before any source read or network await can run.
    const operation = Promise.resolve().then(() => refresh(() => timedOut));
    const cutoff = new Promise((_, reject) => { timer = setTimeout(() => {
      timedOut = true; reject(unavailable());
    }, refreshTimeoutMs); });
    const record = {exposed: Promise.race([operation, cutoff])};
    flight = record;
    // A timeout fences all later get() calls until the actual uncertain request
    // settles. It neither starts a parallel refresh nor publishes a late token.
    operation.finally(() => {
      clearTimeout(timer);
      if (flight === record) flight = null;
    }).catch(() => {});
    return record.exposed;
  }
  return Object.freeze({
    async get() {
      try {
        const current = clock();
        const entry = !flight && usable(cache, current) ? cache : await refreshOnce();
        assert(usable(entry, clock()), 'CONTROL_STS_EXPIRY_INVALID');
        // A caller cannot mutate the credential bundle retained by this source.
        return Object.freeze({...entry.credentials});
      } catch { throw unavailable(); }
    },
    metadata() {
      const current = clock();
      return {refreshing: !!flight, expiresAt: usable(cache, current) ? cache.credentials.expiresAt : null,
        renewBeforeMs, clockSkewMs};
    },
  });
}
