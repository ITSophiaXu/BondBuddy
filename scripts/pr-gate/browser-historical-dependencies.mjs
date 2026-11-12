import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const hash = value => createHash('sha256').update(value).digest('hex');
const safe = name => assert.ok(name && !name.startsWith('/') && !name.includes('\\') && name.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe package file path');
const zero = bytes => bytes.every(byte => byte === 0);
const field = bytes => bytes.toString('utf8').replace(/\0.*$/s, '');
/** Read cached npm tar bytes only. No package extraction, installation or network. */
export function npmTarFiles(compressed, integrity) {
  const sri = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity); assert.ok(sri, 'Historical dependency requires exact SHA-512 SRI');
  assert.equal(createHash('sha512').update(compressed).digest('base64'), sri[1], 'Cached dependency SRI mismatch');
  const bytes = gunzipSync(compressed, { maxOutputLength: 256 * 1024 * 1024 }), files = new Map(); let extended = null, longPath = null, archiveRoot;
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512); if (zero(header)) { assert.ok(zero(bytes.subarray(offset)), 'Nonzero tar trailer'); break; }
    let checksum = 0; for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    assert.equal(checksum, parseInt(field(header.subarray(148, 156)).trim(), 8), 'Invalid npm tar header checksum');
    const size = parseInt(field(header.subarray(124, 136)).trim(), 8); assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= bytes.length);
    const data = bytes.subarray(offset + 512, offset + 512 + size), type = header[156], prefix = field(header.subarray(345, 500));
    let name = (prefix ? prefix + '/' : '') + field(header.subarray(0, 100)); offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 120) { assert.equal(extended, null); extended = {};
      for (let p = 0; p < data.length;) { const space = data.indexOf(32, p); assert.ok(space > p); const n = Number(data.subarray(p, space).toString()); assert.ok(Number.isInteger(n) && n > space - p + 1 && p + n <= data.length && data[p + n - 1] === 10);
        const line = data.subarray(space + 1, p + n - 1).toString('utf8'), equal = line.indexOf('='); assert.ok(equal > 0); const key = line.slice(0, equal); assert.equal(extended[key], undefined); extended[key] = line.slice(equal + 1); p += n; }
      assert.ok(Object.keys(extended).every(key => ['path', 'mtime', 'atime', 'ctime'].includes(key)), 'Unsupported npm PAX metadata'); continue; }
    if (type === 76) { assert.equal(longPath, null); longPath = field(data); continue; }
    assert.ok(type === 0 || type === 48 || type === 53, 'Package tar links/special entries are unsupported');
    name = extended?.path ?? longPath ?? name; extended = null; longPath = null;
    const slash = name.indexOf('/'); assert.ok(slash > 0); const top = name.slice(0, slash); safe(top); archiveRoot ??= top; assert.equal(top, archiveRoot, 'Mixed npm tar roots'); name = name.slice(slash + 1).replace(/\/$/, ''); if (!name && type === 53) continue; safe(name);
    if (type === 53) { assert.equal(size, 0); continue; }
    assert.ok(!files.has(name), 'Duplicate package tar member'); files.set(name, { sha256: hash(data), bytes: data.length });
  }
  assert.equal(extended, null); assert.equal(longPath, null); assert.ok(files.has('package.json')); return files;
}
function packageKey(packages, name, from = '') {
  for (let parent = from; ;) { const key = (parent ? parent + '/' : '') + 'node_modules/' + name; if (packages[key]) return key;
    if (!parent) return null; parent = posix.dirname(parent); if (parent === '.') parent = ''; }
}
const allowedPlatform = (list, value) => !list || (!list.includes('!' + value) && (!list.some(item => !item.startsWith('!')) || list.includes(value)));
export function historicalDependencyClosure(oldLock, currentLock, { platform = process.platform, arch = process.arch } = {}) {
  assert.equal(oldLock.lockfileVersion, 3); assert.equal(currentLock.lockfileVersion, 3); const packages = oldLock.packages, pending = [], seen = new Set(), skipped = [];
  for (const workspace of ['apps/web', 'packages/contracts']) {
    assert.ok(packages[workspace]);
    for (const name of Object.keys({ ...packages[workspace].dependencies, ...packages[workspace].devDependencies })) {
      if (name === '@bondbuddy/contracts') continue; const key = packageKey(packages, name, workspace); assert.ok(key, 'Missing old dependency: ' + name); pending.push({ key, optional: false });
    }
  }
  const rows = [];
  while (pending.length) {
    const { key, optional } = pending.shift(); if (seen.has(key)) continue; const record = packages[key]; assert.ok(record && !record.link && record.integrity && record.resolved);
    for (const field of ['version', 'integrity', 'resolved', 'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'os', 'cpu']) assert.deepEqual(currentLock.packages[key]?.[field], record[field], 'Old/current locked package identity or closure differs: ' + key + '/' + field);
    if (!allowedPlatform(record.os, platform) || !allowedPlatform(record.cpu, arch)) { assert.ok(optional || record.optional, 'Required historical dependency does not support this platform'); skipped.push(key); continue; }
    seen.add(key); rows.push({ path: key, version: record.version, integrity: record.integrity, resolved: record.resolved });
    for (const [name, kind] of [...Object.keys(record.dependencies ?? {}).filter(name => !(name in (record.optionalDependencies ?? {}))).map(name => [name, 'required']), ...Object.keys(record.optionalDependencies ?? {}).map(name => [name, 'optional']),
      ...Object.keys(record.peerDependencies ?? {}).map(name => [name, record.peerDependenciesMeta?.[name]?.optional ? 'optional-peer' : 'required'])]) {
      const target = packageKey(packages, name, key); if (!target && kind === 'optional-peer') continue;
      assert.ok(target, 'Missing dependency in old lock closure: ' + key + ' -> ' + name); pending.push({ key: target, optional: kind !== 'required' });
    }
  }
  return { packages: rows.sort((a, b) => a.path.localeCompare(b.path)), excluded_platform_packages: [...new Set(skipped)].sort() };
}
function installedFiles(base) {
  assert.equal(realpathSync(base), resolve(base), 'Historical registry package cannot be a workspace link'); const files = new Map();
  function walk(dir, prefix = '') { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!prefix && entry.name === 'node_modules') continue; const path = prefix + entry.name; safe(path); const target = join(dir, entry.name), stat = lstatSync(target);
    assert.ok(!stat.isSymbolicLink(), 'Unexpected dependency symlink: ' + path);
    if (entry.isDirectory()) walk(target, path + '/'); else { assert.ok(stat.isFile()); const bytes = readFileSync(target); files.set(path, { sha256: hash(bytes), bytes: bytes.length }); }
  } }
  walk(base); return files;
}
export function compareInstalledPackage(actual, archived, label) {
  assert.deepEqual([...actual.keys()].sort(), [...archived.keys()].sort(), 'Installed historical dependency file set differs: ' + label);
  for (const [path, value] of archived) assert.deepEqual(actual.get(path), value, 'Installed historical dependency bytes differ: ' + label + '/' + path);
  return hash(JSON.stringify([...actual].sort(([a], [b]) => a.localeCompare(b))));
}
/** Prove actual installed bytes against each locked tarball already in npm's cache. */
export function verifyHistoricalDependencies(sourceRoot, candidateRoot = '/workspace', cache = '/root/.npm/_cacache/content-v2') {
  const oldBytes = readFileSync(join(sourceRoot, 'package-lock.json')), currentBytes = readFileSync(join(candidateRoot, 'package-lock.json'));
  const closure = historicalDependencyClosure(JSON.parse(oldBytes), JSON.parse(currentBytes)), packages = [];
  for (const record of closure.packages) {
    const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(record.integrity); assert.ok(match); const digest = Buffer.from(match[1], 'base64').toString('hex'); assert.equal(digest.length, 128);
    const archive = join(cache, 'sha512', digest.slice(0, 2), digest.slice(2, 4), digest.slice(4)); assert.ok(existsSync(archive), 'Historical dependency tarball is not in the existing cache: ' + record.path);
    const archived = npmTarFiles(readFileSync(archive), record.integrity), base = join(candidateRoot, record.path), actual = installedFiles(base);
    const metadata = JSON.parse(readFileSync(join(base, 'package.json'))); assert.equal(metadata.version, record.version);
    const files_sha256 = compareInstalledPackage(actual, archived, record.path); packages.push({ ...record, actual_root: base, files: actual.size, files_sha256, cache_sri_verified: true });
  }
  return { schema: 'pr-gate-historical-dependency-bytes-v1', locks: { old: oldBytes.toString('base64'), candidate: currentBytes.toString('base64') }, old_lock_sha256: hash(oldBytes), candidate_lock_sha256: hash(currentBytes),
    installed: false, network_requests: 0, workspace_links_changed: false, packages, excluded_platform_packages: closure.excluded_platform_packages };
}
export function dependencyRootForFile(file, proof) {
  const path = realpathSync(file); const matches = proof.packages.filter(row => path === row.actual_root || path.startsWith(row.actual_root + '/')).sort((a, b) => b.actual_root.length - a.actual_root.length);
  assert.ok(matches.length && !relative(matches[0].actual_root, path).split(/[\\/]/).includes('node_modules'), 'Resolved package is outside the verified historical closure'); return matches[0];
}
