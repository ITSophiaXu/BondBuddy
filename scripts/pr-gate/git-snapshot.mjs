#!/usr/bin/env node
/** Transfer one original commit and its complete tree without repository configuration or parent history. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
    const result = spawnSync('git', ['--no-replace-objects', '-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', `core.attributesFile=${empty}`, '-c', 'credential.helper=', ...args],
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
    return { commit: expectedCommit, tree: expectedTree, clean_tree: true, shallow: true, object_count: rows.length };
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
