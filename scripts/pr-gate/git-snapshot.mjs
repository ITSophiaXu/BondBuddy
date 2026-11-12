#!/usr/bin/env node
/** Transfer one original commit and its complete tree without repository configuration or parent history. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = 'pr-gate-git-snapshot-v1';
const MAX_OUTPUT = 64 * 1024 * 1024;
const oidPattern = format => format === 'sha256' ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{40}$/;
function requireOid(value, format, label) {
  if (typeof value !== 'string' || !oidPattern(format).test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
function emptyDirectory(path, label) {
  if (existsSync(path)) {
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink() || readdirSync(path).length) throw new Error(`${label} must be an empty real directory`);
  } else mkdirSync(path, { recursive: true });
}
function sha256File(path) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), fd = openSync(path, 'r');
  try { for (;;) { const size = readSync(fd, buffer, 0, buffer.length, null); if (!size) break; hash.update(buffer.subarray(0, size)); } }
  finally { closeSync(fd); }
  return hash.digest('hex');
}
/** Git sees no caller-supplied config, hooks, alternate object stores, replacements or credential helpers. */
function isolatedGit(task) {
  const base = realpathSync(tmpdir()), area = mkdtempSync(join(base, 'bb-pr-gate-git-'));
  const empty = join(area, 'empty.config'), template = join(area, 'template'), hooks = join(area, 'hooks');
  writeFileSync(empty, ''); mkdirSync(template); mkdirSync(hooks);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: empty, GIT_CONFIG_GLOBAL: empty, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0' });
  const git = (cwd, args, options = {}) => {
    const result = spawnSync('git', ['--no-replace-objects', '-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', `core.attributesFile=${empty}`, '-c', 'credential.helper=', ...args],
      { cwd, env, encoding: 'utf8', maxBuffer: MAX_OUTPUT, timeout: 600_000, windowsHide: true, ...options });
    if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`);
    return result.stdout;
  };
  try { return task({ git, template }); }
  finally {
    const checked = resolve(area), rel = relative(base, checked), actual = realpathSync(checked);
    if (!rel || isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel === '..' || dirname(checked) !== base || dirname(actual) !== base ||
      lstatSync(checked).isSymbolicLink() || !basename(actual).startsWith('bb-pr-gate-git-')) throw new Error('Refusing to remove an unexpected Git temporary directory');
    rmSync(actual, { recursive: true, force: true });
  }
}
function objectRows(git, cwd, index) {
  const lines = git(cwd, ['verify-pack', '-v', index]).trim().split(/\r?\n/);
  return lines.flatMap(line => {
    const match = /^([a-f0-9]{40,64}) (commit|tree|blob|tag) /.exec(line);
    return match ? [{ id: match[1], type: match[2] }] : [];
  });
}
function treeObjects(git, cwd, tree, format) {
  const ids = git(cwd, ['rev-list', '--objects', '--no-object-names', tree]).trim().split(/\r?\n/);
  if (!ids.length || ids.some(id => !oidPattern(format).test(id)) || !ids.includes(tree)) throw new Error('Incomplete Git tree object list');
  return [...new Set(ids)];
}
function verifyExactPack(rows, commit, ids) {
  const expected = new Set([commit, ...ids]), actual = new Set(rows.map(row => row.id));
  if (actual.size !== expected.size || rows.length !== actual.size || [...expected].some(id => !actual.has(id))) throw new Error('Pack does not contain exactly the original commit and its complete tree');
  if (rows.filter(row => row.type === 'commit').length !== 1 || !rows.some(row => row.id === commit && row.type === 'commit') || rows.some(row => !['commit', 'tree', 'blob'].includes(row.type))) throw new Error('Pack contains unexpected history or object types');
}

/** Raw bytes are independent of Git status, which can normalize CRLF to a clean index. */
function rawSourceProof(git, root, commit, format) {
  const base = realpathSync(root), parents = new Set([base]), manifest = [], buffer = Buffer.allocUnsafe(1024 * 1024);
  let byteCount = 0;
  for (const entry of git(root, ['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t'), [mode, kind, expected] = entry.slice(0, tab).split(' '), name = entry.slice(tab + 1), file = resolve(base, name);
    const rel = relative(base, file);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) || kind !== 'blob') throw new Error('Unsupported or escaping snapshot entry');
    const parent = dirname(file);
    if (!parents.has(parent)) { if (realpathSync(parent) !== parent) throw new Error('Snapshot parent is redirected: ' + name); parents.add(parent); }
    const stat = lstatSync(file);
    let actual, bytes;
    if (mode === '120000') {
      if (!stat.isSymbolicLink()) throw new Error('Snapshot symlink is missing: ' + name);
      const target = readlinkSync(file, { encoding: 'buffer' }); bytes = target.length;
      actual = createHash(format).update('blob ' + bytes + '\0').update(target).digest('hex');
    } else {
      if (!['100644', '100755'].includes(mode) || !stat.isFile() || stat.isSymbolicLink()) throw new Error('Snapshot regular file is missing: ' + name);
      bytes = stat.size;
      const hash = createHash(format).update('blob ' + bytes + '\0'), fd = openSync(file, 'r');
      try { for (;;) { const size = readSync(fd, buffer, 0, buffer.length, null); if (!size) break; hash.update(buffer.subarray(0, size)); } }
      finally { closeSync(fd); }
      actual = hash.digest('hex');
    }
    if (actual !== expected) throw new Error('Snapshot raw bytes differ from Git blob: ' + name);
    byteCount += bytes; manifest.push({ path: name, mode, blob: actual, bytes });
  }
  return { files: manifest.length, byte_count: byteCount, manifest_sha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex') };
}

/** Failure-only metadata: never emit file contents or follow a replaced link. */
function changedSourceDiagnostics(git, root, commit, format) {
  const maxFiles = 20, maxBytes = 64 * 1024 * 1024;
  try {
    const base = realpathSync(root), expected = new Map(), changes = [];
    for (const entry of git(root, ['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t'), [mode, kind, blob] = entry.slice(0, tab).split(' ');
      expected.set(entry.slice(tab + 1), { mode, kind, blob });
    }
    const rows = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no']).split('\0');
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i]) continue;
      if (rows[i].length < 4 || rows[i][2] !== ' ') throw new Error('Invalid status row');
      const status = rows[i].slice(0, 2), path = rows[i].slice(3), item = { path, status };
      // In -z mode a rename/copy emits destination then original as a second field.
      if (/[RC]/.test(status)) { if (!rows[i + 1]) throw new Error('Missing original path'); item.original_path = rows[++i]; }
      changes.push(item);
    }
    let hashedBytes = 0;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const inspect = name => {
      try {
        const file = resolve(base, name), rel = relative(base, file), parent = dirname(file);
        if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) return { kind: 'unavailable', reason: 'outside_root' };
        if (realpathSync(parent) !== parent) return { kind: 'unavailable', reason: 'redirected_parent' };
        const stat = lstatSync(file);
        if (stat.isSymbolicLink()) {
          const bytes = readlinkSync(file, { encoding: 'buffer' });
          if (bytes.length > maxBytes - hashedBytes) return { kind: 'symlink', bytes: bytes.length, reason: 'hash_byte_limit' };
          hashedBytes += bytes.length;
          return { kind: 'symlink', bytes: bytes.length, blob: createHash(format).update('blob ' + bytes.length + '\0').update(bytes).digest('hex') };
        }
        if (!stat.isFile()) return { kind: 'unavailable', reason: 'unsupported_file_type' };
        if (stat.size > maxBytes || stat.size > maxBytes - hashedBytes) return { kind: 'file', mode_bits: (stat.mode & 0o777).toString(8), bytes: stat.size, reason: 'hash_byte_limit' };
        if (realpathSync(file) !== file) return { kind: 'unavailable', reason: 'redirected_file' };
        const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
          const opened = fstatSync(fd);
          if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || realpathSync(parent) !== parent) return { kind: 'unavailable', reason: 'changed_during_diagnostic' };
          const hash = createHash(format).update('blob ' + stat.size + '\0');
          let seen = 0;
          while (seen < stat.size) {
            // Bound reads to the observed size; the final stat rejects growth.
            const size = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - seen), null);
            if (!size) break;
            seen += size; hashedBytes += size;
            if (seen > stat.size) return { kind: 'unavailable', reason: 'changed_during_diagnostic' };
            hash.update(buffer.subarray(0, size));
          }
          const after = fstatSync(fd);
          if (seen !== stat.size || after.size !== stat.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) return { kind: 'unavailable', reason: 'changed_during_diagnostic' };
          return { kind: 'file', mode_bits: (stat.mode & 0o777).toString(8), bytes: seen, blob: hash.digest('hex') };
        } finally { closeSync(fd); }
      } catch (error) {
        return error.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unavailable', reason: 'read_failed' };
      }
    };
    const files = changes.slice(0, maxFiles).map(change => ({ ...change, expected: expected.get(change.path) ?? null, actual: inspect(change.path) }));
    return { schema: 'pr-gate-source-change-diagnostics-v1', total_changes: changes.length, reported_changes: files.length,
      truncated: changes.length > files.length, max_files: maxFiles, max_hash_bytes: maxBytes, hashed_bytes: hashedBytes, files };
  } catch {
    // Diagnostics cannot replace the original rejection or disclose Git/OS errors.
    return { schema: 'pr-gate-source-change-diagnostics-v1', unavailable: true };
  }
}

export function verifyGitSnapshotSource({ sourceRoot, expectedCommit, expectedTree }) {
  const source = resolve(sourceRoot);
  return isolatedGit(({ git }) => {
    const format = git(source, ['rev-parse', '--show-object-format']).trim();
    if (!['sha1', 'sha256'].includes(format)) throw new Error('Unsupported Git object format');
    requireOid(expectedCommit, format, 'expected commit'); requireOid(expectedTree, format, 'expected tree');
    if (git(source, ['rev-parse', 'HEAD']).trim() !== expectedCommit || git(source, ['rev-parse', 'HEAD^{tree}']).trim() !== expectedTree || git(source, ['write-tree']).trim() !== expectedTree) throw new Error('Snapshot candidate changed');
    if (git(source, ['status', '--porcelain', '--untracked-files=no']).trim()) {
      const diagnostics = changedSourceDiagnostics(git, source, expectedCommit, format);
      throw new Error('Snapshot tracked source changed\nSnapshot change diagnostics: ' + JSON.stringify(diagnostics));
    }
    return rawSourceProof(git, source, expectedCommit, format);
  });
}

export function createGitSnapshot({ sourceRoot, commit, tree, outputDirectory }) {
  const source = resolve(sourceRoot), output = resolve(outputDirectory);
  return isolatedGit(({ git }) => {
    const format = git(source, ['rev-parse', '--show-object-format']).trim();
    if (!['sha1', 'sha256'].includes(format)) throw new Error('Unsupported Git object format');
    requireOid(commit, format, 'commit'); requireOid(tree, format, 'tree');
    if (git(source, ['rev-parse', '--verify', `${commit}^{commit}`]).trim() !== commit || git(source, ['rev-parse', `${commit}^{tree}`]).trim() !== tree) throw new Error('Expected commit/tree does not match the source repository');
    const ids = treeObjects(git, source, tree, format);
    emptyDirectory(output, 'Snapshot output');
    const packHash = git(source, ['pack-objects', '--window=0', '--depth=0', '--no-reuse-delta', '--no-reuse-object', '--threads=1', join(output, 'source')],
      { input: `${commit}\n${ids.join('\n')}\n` }).trim();
    requireOid(packHash, format, 'pack hash');
    const pack = `source-${packHash}.pack`, index = join(output, `source-${packHash}.idx`);
    verifyExactPack(objectRows(git, source, index), commit, ids);
    const manifest = { schema: SCHEMA, commit, tree, object_format: format, pack_file: pack, pack_sha256: sha256File(join(output, pack)), object_count: ids.length + 1 };
    writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  });
}

export function restoreGitSnapshot({ snapshotDirectory, destination, expectedCommit, expectedTree, expectedPackSha256 }) {
  const source = resolve(snapshotDirectory), target = resolve(destination);
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
  if (manifest.schema !== SCHEMA || !['sha1', 'sha256'].includes(manifest.object_format)) throw new Error('Invalid Git snapshot manifest');
  const format = manifest.object_format;
  requireOid(expectedCommit, format, 'expected commit'); requireOid(expectedTree, format, 'expected tree');
  if (manifest.commit !== expectedCommit || manifest.tree !== expectedTree) throw new Error('Snapshot commit/tree does not match the expected source');
  if (!new RegExp(`^source-[a-f0-9]{${format === 'sha256' ? 64 : 40}}\\.pack$`).test(manifest.pack_file) || !/^[a-f0-9]{64}$/.test(manifest.pack_sha256) || !Number.isSafeInteger(manifest.object_count) || manifest.object_count < 2) throw new Error('Invalid Git snapshot pack evidence');
  if (expectedPackSha256 !== undefined && expectedPackSha256 !== manifest.pack_sha256) throw new Error('Snapshot pack hash does not match the expected evidence');
  const pack = join(source, manifest.pack_file);
  if (!lstatSync(pack).isFile() || lstatSync(pack).isSymbolicLink() || sha256File(pack) !== manifest.pack_sha256) throw new Error('Snapshot pack checksum mismatch');
  emptyDirectory(target, 'Snapshot destination');
  return isolatedGit(({ git, template }) => {
    git(target, ['init', '--quiet', `--template=${template}`, `--object-format=${format}`]);
    git(target, ['config', '--local', 'core.autocrlf', 'false']);
    git(target, ['config', '--local', 'core.eol', 'lf']);
    git(target, ['config', '--local', 'core.fileMode', process.platform === 'win32' ? 'false' : 'true']);
    git(target, ['config', '--local', 'core.symlinks', 'true']);
    git(target, ['config', '--local', 'core.fsmonitor', 'false']);
    mkdirSync(join(target, '.git', 'disabled-hooks'));
    git(target, ['config', '--local', 'core.hooksPath', join(target, '.git', 'disabled-hooks')]);
    // Missing parent objects are intentional: like checkout fetch-depth=1, HEAD is the shallow boundary.
    writeFileSync(join(target, '.git', 'shallow'), `${expectedCommit}\n`);
    const fd = openSync(pack, 'r');
    let indexed;
    try { indexed = git(target, ['index-pack', '--strict', '--stdin'], { stdio: [fd, 'pipe', 'pipe'] }).trim(); }
    finally { closeSync(fd); }
    const packHash = indexed.split(/\s+/).at(-1);
    requireOid(packHash, format, 'indexed pack hash');
    const index = join(target, '.git', 'objects', 'pack', `pack-${packHash}.idx`);
    const ids = treeObjects(git, target, expectedTree, format);
    const rows = objectRows(git, target, index);
    verifyExactPack(rows, expectedCommit, ids);
    if (rows.length !== manifest.object_count) throw new Error('Snapshot object count mismatch');
    if (git(target, ['rev-parse', `${expectedCommit}^{tree}`]).trim() !== expectedTree) throw new Error('Original commit tree mismatch');
    git(target, ['update-ref', '--no-deref', 'HEAD', expectedCommit]);
    // Export attributes are deliberately not applied: these are original Git objects, not a tar export.
    git(target, ['reset', '--hard', expectedCommit]);
    const files = git(target, ['ls-tree', '-r', '-z', expectedCommit]);
    for (const entry of files.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t'), mode = entry.slice(0, 6), path = entry.slice(tab + 1);
      if (mode === '120000' && !lstatSync(join(target, path)).isSymbolicLink()) throw new Error(`Symbolic link capability is required for ${path}`);
      if (mode === '100755' && process.platform !== 'win32' && !(lstatSync(join(target, path)).mode & 0o111)) throw new Error(`Executable mode was not restored for ${path}`);
    }
    if (git(target, ['rev-parse', 'HEAD']).trim() !== expectedCommit || git(target, ['rev-parse', 'HEAD^{tree}']).trim() !== expectedTree || git(target, ['write-tree']).trim() !== expectedTree) throw new Error('Restored commit/tree/index mismatch');
    if (git(target, ['status', '--porcelain', '--untracked-files=all']).trim()) throw new Error('Restored working tree is not clean');
    if (git(target, ['rev-parse', '--is-bare-repository']).trim() !== 'false' || git(target, ['rev-parse', '--is-shallow-repository']).trim() !== 'true' || git(target, ['rev-list', '--count', 'HEAD']).trim() !== '1') throw new Error('Restored repository is not a one-commit shallow checkout');
    git(target, ['fsck', '--connectivity-only', '--no-reflogs']);
    const raw_source = rawSourceProof(git, target, expectedCommit, format);
    return { commit: expectedCommit, tree: expectedTree, clean_tree: true, shallow: true, object_count: rows.length, raw_source };
  });
}

function cli(args) {
  const [mode, ...rest] = args, options = {};
  if (rest.length % 2) throw new Error('Expected --key value pairs');
  for (let i = 0; i < rest.length; i += 2) {
    if (!/^--[a-z][a-z0-9-]*$/.test(rest[i]) || Object.hasOwn(options, rest[i].slice(2))) throw new Error('Invalid or duplicate snapshot option');
    options[rest[i].slice(2)] = rest[i + 1];
  }
  if (mode === 'create' && Object.keys(options).sort().join(',') === 'commit,out,source-root,tree') return createGitSnapshot({ sourceRoot: options['source-root'], commit: options.commit, tree: options.tree, outputDirectory: options.out });
  if (mode === 'restore' && Object.keys(options).sort().join(',') === 'commit,destination,pack-sha256,snapshot,tree') return restoreGitSnapshot({ snapshotDirectory: options.snapshot, destination: options.destination, expectedCommit: options.commit, expectedTree: options.tree, expectedPackSha256: options['pack-sha256'] });
  throw new Error('Usage: git-snapshot.mjs create --source-root <root> --commit <sha> --tree <tree> --out <directory> | restore --snapshot <directory> --destination <directory> --commit <sha> --tree <tree> --pack-sha256 <hash>');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(cli(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
