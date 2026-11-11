import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createGitSnapshot, restoreGitSnapshot } from './git-snapshot.mjs';

const PREFIX = 'bb-pr-gate-git-snapshot-test-';
const digest = value => createHash('sha256').update(value).digest('hex');

// Every recursive deletion is restricted to this test's own immediate child of
// the resolved OS temporary directory, including on Windows junctioned paths.
function removeFixture(directory, temporaryRoot) {
  const target = resolve(directory), base = resolve(temporaryRoot);
  const rel = relative(base, target);
  assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
  assert.equal(dirname(target), base);
  assert.ok(basename(target).startsWith(PREFIX));
  if (!existsSync(target)) return;
  assert.equal(lstatSync(target).isSymbolicLink(), false);
  const actual = realpathSync(target);
  assert.equal(dirname(actual), base);
  assert.ok(basename(actual).startsWith(PREFIX));
  rmSync(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function fixture(check) {
  const temporaryRoot = realpathSync(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, PREFIX));
  const emptyConfig = join(directory, 'empty.gitconfig'), emptyHooks = join(directory, 'empty-hooks');
  writeFileSync(emptyConfig, ''); mkdirSync(emptyHooks);
  const gitEnvironment = () => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig,
  });
  function git(repository, args, { input, failure = false, raw = false } = {}) {
    const result = spawnSync('git', ['-c', `core.hooksPath=${emptyHooks}`, ...args], {
      cwd: repository, env: gitEnvironment(), input, windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.ifError(result.error);
    if (failure) return result;
    assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr?.toString('utf8') ?? ''}`);
    return raw ? result.stdout : result.stdout.toString('utf8').trim();
  }
  const write = (repository, name, bytes) => {
    const file = join(repository, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes);
  };
  function source() {
    const repository = join(directory, 'source'); mkdirSync(repository);
    git(repository, ['init', '--object-format=sha1', '--initial-branch=fixture', `--template=${emptyHooks}`]);
    git(repository, ['config', '--local', 'user.name', 'Synthetic Snapshot Test']);
    git(repository, ['config', '--local', 'user.email', 'snapshot@example.invalid']);
    git(repository, ['config', '--local', 'core.autocrlf', 'false']);
    git(repository, ['config', '--local', 'core.safecrlf', 'false']);
    write(repository, 'history-only.txt', 'This deleted historical file must not enter the shallow snapshot.\n');
    git(repository, ['add', '--', 'history-only.txt']); git(repository, ['commit', '-qm', 'synthetic parent']);
    const parent = git(repository, ['rev-parse', 'HEAD']);
    const historicalBlob = git(repository, ['rev-parse', 'HEAD:history-only.txt']);
    unlinkSync(join(repository, 'history-only.txt'));
    const files = {
      '.gitignore': Buffer.from('ignored.txt\nuntracked-only.txt\n'),
      '.gitattributes': Buffer.from('*.txt -text\nomit-from-archive.txt export-ignore\nsubstitution.txt export-subst\n'),
      'ignored.txt': Buffer.from('Tracked despite .gitignore.\n'),
      'omit-from-archive.txt': Buffer.from('A checkout must retain this export-ignore file.\n'),
      'substitution.txt': Buffer.from('Keep the literal archive substitution token: $Format:%H$\n'),
      'crlf.txt': Buffer.from('first\r\nsecond\r\n'),
      'binary.dat': Buffer.from([0, 0xff, 0x80, 0x0d, 0x0a, 0xfe, 0]),
      '目录/含 空格.txt': Buffer.from('Synthetic Unicode path.\n'),
      'bin/run.sh': Buffer.from('#!/bin/sh\nexit 0\n'),
    };
    for (const [name, bytes] of Object.entries(files)) write(repository, name, bytes);
    if (process.platform !== 'win32') chmodSync(join(repository, 'bin/run.sh'), 0o755);
    git(repository, ['add', '-f', '-A', '--', '.']);
    git(repository, ['update-index', '--chmod=+x', '--', 'bin/run.sh']);
    git(repository, ['commit', '-qm', 'synthetic snapshot candidate']);
    write(repository, 'untracked-only.txt', 'SYNTHETIC_UNTRACKED_PRIVATE_DATA\n');
    return {
      repository, files, parent, historicalBlob,
      commit: git(repository, ['rev-parse', 'HEAD']), tree: git(repository, ['rev-parse', 'HEAD^{tree}']),
    };
  }
  try { return check({ directory, git, source, write, emptyHooks }); }
  finally { removeFixture(directory, temporaryRoot); }
}

function packPath(outputDirectory, manifest) {
  assert.equal(typeof manifest.pack_file, 'string');
  const file = resolve(outputDirectory, manifest.pack_file), rel = relative(resolve(outputDirectory), file);
  assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`), 'pack stays inside its snapshot directory');
  return file;
}

function snapshot(outputDirectory, candidate) {
  const manifest = createGitSnapshot({
    sourceRoot: candidate.repository, commit: candidate.commit, tree: candidate.tree, outputDirectory,
  });
  assert.equal(manifest.schema, 'pr-gate-git-snapshot-v1');
  assert.equal(manifest.commit, candidate.commit); assert.equal(manifest.tree, candidate.tree);
  assert.equal(manifest.object_format, 'sha1');
  assert.ok(Number.isSafeInteger(manifest.object_count) && manifest.object_count > 0);
  assert.match(manifest.pack_sha256, /^[a-f0-9]{64}$/);
  assert.equal(digest(readFileSync(packPath(outputDirectory, manifest))), manifest.pack_sha256);
  return manifest;
}

function restore(snapshotDirectory, destination, candidate, manifest, overrides = {}) {
  return restoreGitSnapshot({
    snapshotDirectory, destination, expectedCommit: candidate.commit, expectedTree: candidate.tree,
    expectedPackSha256: manifest.pack_sha256, ...overrides,
  });
}

test('real shallow roundtrip retains original tree bytes, archive attributes, ignored tracked files and executable modes', () => fixture(({ directory, git, source }) => {
  const candidate = source(), output = join(directory, 'snapshot'), destination = join(directory, 'restored');
  const originalStatus = git(candidate.repository, ['status', '--porcelain', '--untracked-files=all']);
  const originalConfig = readFileSync(join(candidate.repository, '.git/config'));
  const manifest = snapshot(output, candidate), restored = restore(output, destination, candidate, manifest);
  assert.equal(restored.commit, candidate.commit); assert.equal(restored.tree, candidate.tree);
  assert.equal(restored.clean_tree, true); assert.equal(restored.shallow, true);
  assert.equal(restored.object_count, manifest.object_count);
  assert.equal(git(destination, ['rev-parse', 'HEAD']), candidate.commit);
  assert.equal(git(destination, ['rev-parse', 'HEAD^{tree}']), candidate.tree);
  assert.equal(git(destination, ['rev-parse', '--is-bare-repository']), 'false');
  assert.equal(git(destination, ['rev-parse', '--is-shallow-repository']), 'true');
  assert.equal(realpathSync(git(destination, ['rev-parse', '--show-toplevel'])), realpathSync(destination));
  assert.equal(git(destination, ['status', '--porcelain', '--untracked-files=all']), '');
  assert.equal(git(destination, ['log', '--format=%H']), candidate.commit, 'the recorded original parent is a shallow boundary');
  assert.notEqual(git(destination, ['cat-file', '-e', `${candidate.parent}^{commit}`], { failure: true }).status, 0);
  assert.notEqual(git(destination, ['cat-file', '-e', candidate.historicalBlob], { failure: true }).status, 0);
  git(destination, ['fsck', '--full', '--strict']);
  for (const [name, bytes] of Object.entries(candidate.files)) assert.deepEqual(readFileSync(join(destination, name)), bytes, name);
  assert.equal(existsSync(join(destination, 'untracked-only.txt')), false);
  assert.equal(existsSync(join(destination, 'history-only.txt')), false);
  assert.match(git(destination, ['ls-files', '--stage', '--', 'bin/run.sh']), /^100755 /);
  if (process.platform !== 'win32') assert.ok(lstatSync(join(destination, 'bin/run.sh')).mode & 0o111);
  assert.equal(git(candidate.repository, ['rev-parse', 'HEAD']), candidate.commit);
  assert.equal(git(candidate.repository, ['rev-parse', 'HEAD^{tree}']), candidate.tree);
  assert.equal(git(candidate.repository, ['status', '--porcelain', '--untracked-files=all']), originalStatus);
  assert.deepEqual(readFileSync(join(candidate.repository, '.git/config')), originalConfig);
}));

test('raw signed-looking non-UTF8 merge commit keeps its original object identity and missing parents stay shallow', () => fixture(({ directory, git, source, write }) => {
  const candidate = source();
  const payload = Buffer.concat([
    Buffer.from(`tree ${candidate.tree}\nparent ${candidate.commit}\nparent ${candidate.parent}\nauthor Synthetic Author <author@example.invalid> 1794390000 +0800\ncommitter Synthetic Committer <committer@example.invalid> 1794390001 +0800\nencoding ISO-8859-1\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n c3ludGhldGljLW5vdC1hLXZhbGlkLXNpZ25hdHVyZQ==\n -----END PGP SIGNATURE-----\n\nSynthetic raw byte identity: `),
    Buffer.from([0xe9, 0xff, 0x0a]),
  ]);
  // This is a deliberately invalid cryptographic signature, but a valid raw
  // commit object. The snapshot must preserve bytes, not certify a signature.
  const rawCommit = git(candidate.repository, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: payload });
  git(candidate.repository, ['update-ref', 'HEAD', rawCommit]);
  const rawCandidate = { ...candidate, commit: rawCommit };
  const output = join(directory, 'raw-snapshot'), destination = join(directory, 'raw-restored');
  const manifest = snapshot(output, rawCandidate), restored = restore(output, destination, rawCandidate, manifest);
  assert.equal(restored.commit, rawCommit);
  assert.deepEqual(git(destination, ['cat-file', 'commit', rawCommit], { raw: true }), payload);
  assert.equal(git(destination, ['log', '--format=%H']), rawCommit);
  for (const parent of [candidate.commit, candidate.parent]) assert.notEqual(git(destination, ['cat-file', '-e', `${parent}^{commit}`], { failure: true }).status, 0);
  assert.equal(git(destination, ['rev-parse', 'HEAD^{tree}']), candidate.tree);
  git(destination, ['fsck', '--full', '--strict']);
}));

test('symlink roundtrip uses a real link when supported and otherwise refuses the missing host capability explicitly', t => fixture(({ directory, git, source, write }) => {
  const candidate = source(), targetName = 'link-target.txt', linkName = 'relative-link';
  write(candidate.repository, targetName, 'Synthetic symlink target.\n');
  let canCreateSymlink = false;
  try { symlinkSync(targetName, join(candidate.repository, linkName), 'file'); canCreateSymlink = true; }
  catch (error) {
    assert.equal(process.platform, 'win32', `Unexpected symlink failure on ${process.platform}: ${error.message}`);
    assert.ok(['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code), `Unexpected capability error: ${error.code}`);
    t.diagnostic(`Windows symlink creation unavailable (${error.code}); constructing a real 120000 Git entry and verifying fail-closed restoration.`);
  }
  git(candidate.repository, ['add', '--', targetName]);
  if (canCreateSymlink) {
    git(candidate.repository, ['-c', 'core.symlinks=true', 'add', '--', linkName]);
  } else {
    const linkObject = git(candidate.repository, ['hash-object', '-w', '--stdin'], { input: Buffer.from(targetName) });
    git(candidate.repository, ['update-index', '--add', '--cacheinfo', '120000', linkObject, linkName]);
  }
  git(candidate.repository, ['commit', '-qm', 'synthetic symlink candidate']);
  const linkCandidate = { ...candidate, commit: git(candidate.repository, ['rev-parse', 'HEAD']), tree: git(candidate.repository, ['rev-parse', 'HEAD^{tree}']) };
  assert.match(git(candidate.repository, ['ls-files', '--stage', '--', linkName]), /^120000 /);
  const output = join(directory, 'link-snapshot'), destination = join(directory, 'link-restored');
  const manifest = snapshot(output, linkCandidate);
  if (canCreateSymlink) {
    const restored = restore(output, destination, linkCandidate, manifest);
    assert.equal(restored.clean_tree, true);
    assert.equal(lstatSync(join(destination, linkName)).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(destination, linkName)).replaceAll('\\', '/'), targetName);
    assert.match(git(destination, ['ls-files', '--stage', '--', linkName]), /^120000 /);
    assert.equal(git(destination, ['status', '--porcelain', '--untracked-files=all']), '');
  } else {
    assert.throws(() => restore(output, destination, linkCandidate, manifest), /symlink|symbolic link|capabilit|privilege/i);
  }
}));

test('snapshots do not import source or host credentials, Git configuration, templates or hooks', () => fixture(({ directory, git, source, write }) => {
  const candidate = source(), output = join(directory, 'private-snapshot'), destination = join(directory, 'private-restored');
  const sourceMarker = 'SYNTHETIC_SOURCE_CREDENTIAL_DO_NOT_COPY', hostMarker = 'SYNTHETIC_HOST_CREDENTIAL_DO_NOT_COPY';
  const sourceHooks = join(candidate.repository, '.git', 'source-hooks'), hostHooks = join(directory, 'host-hooks');
  const template = join(directory, 'host-template'), hookRan = join(directory, 'HOST_HOOK_RAN');
  mkdirSync(sourceHooks); mkdirSync(hostHooks); mkdirSync(join(template, 'hooks'), { recursive: true });
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const hook = `#!/bin/sh\nprintf 'synthetic hook ran\\n' > ${shellQuote(hookRan.replaceAll('\\', '/'))}\n`;
  for (const folder of [sourceHooks, hostHooks, join(template, 'hooks')]) {
    for (const name of ['post-checkout', 'reference-transaction']) {
      const file = join(folder, name); writeFileSync(file, hook); chmodSync(file, 0o755);
    }
  }
  git(candidate.repository, ['config', '--local', 'credential.helper', sourceMarker]);
  git(candidate.repository, ['config', '--local', 'http.extraHeader', `Authorization: ${sourceMarker}`]);
  git(candidate.repository, ['config', '--local', 'core.hooksPath', sourceHooks]);
  writeFileSync(join(candidate.repository, '.git', 'credentials'), sourceMarker);
  const hostConfig = join(directory, 'host.gitconfig');
  writeFileSync(hostConfig, `[credential]\n\thelper = ${hostMarker}\n[http]\n\textraHeader = Authorization: ${hostMarker}\n[core]\n\thooksPath = ${JSON.stringify(hostHooks.replaceAll('\\', '/'))}\n\tautocrlf = true\n`);
  const changes = { GIT_CONFIG_GLOBAL: hostConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TEMPLATE_DIR: template };
  const before = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, changes);
    const manifest = snapshot(output, candidate); restore(output, destination, candidate, manifest);
  } finally {
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  assert.equal(existsSync(hookRan), false, 'restoration must not execute inherited hooks');
  assert.equal(existsSync(join(destination, '.git', 'credentials')), false);
  assert.equal(existsSync(join(destination, '.git', 'source-hooks')), false);
  const localConfig = git(destination, ['config', '--local', '--list']);
  for (const marker of [sourceMarker, hostMarker, sourceHooks, hostHooks, template]) assert.ok(!localConfig.includes(marker), marker);
  assert.doesNotMatch(localConfig, /^(?:credential\.|http\..*extraheader|include(?:if)?\.|core\.sshcommand|url\..*\.insteadof)/im);
  assert.equal(git(destination, ['rev-parse', 'HEAD']), candidate.commit);
  assert.equal(git(destination, ['status', '--porcelain', '--untracked-files=all']), '');
}));

test('tampered pack, expected pack hash, commit and tree are rejected', () => fixture(({ directory, source }) => {
  const candidate = source(), output = join(directory, 'snapshot');
  const manifest = snapshot(output, candidate);
  for (const [name, overrides] of [
    ['commit', { expectedCommit: 'f'.repeat(40) }],
    ['tree', { expectedTree: 'e'.repeat(40) }],
    ['pack-hash', { expectedPackSha256: '0'.repeat(64) }],
  ]) assert.throws(() => restore(output, join(directory, `rejected-${name}`), candidate, manifest, overrides), name);
  const tampered = join(directory, 'tampered'); cpSync(output, tampered, { recursive: true });
  const file = packPath(tampered, manifest), bytes = readFileSync(file);
  assert.ok(bytes.length > 32); bytes[Math.floor(bytes.length / 2)] ^= 1;
  // Git packs are read-only; cpSync can retain that attribute on Windows.
  // Clear it only on this deliberate tampering copy, never the source pack.
  chmodSync(file, 0o600);
  writeFileSync(file, bytes);
  assert.throws(() => restore(tampered, join(directory, 'rejected-tampering'), candidate, manifest));
}));

test('a missing promisor blob fails closed without hydrating the source from an available local bare remote', t => fixture(({ directory, git, source }) => {
  const candidate = source(), remote = join(directory, 'local-promisor.git');
  // Copy real Git objects before deliberately removing one source object. This
  // fixture never uses a network endpoint, credentials, or an ext/shell helper.
  cpSync(join(candidate.repository, '.git'), remote, { recursive: true });
  git(candidate.repository, [`--git-dir=${remote}`, 'config', '--local', 'core.bare', 'true']);
  git(remote, ['config', '--local', 'uploadpack.allowFilter', 'true']);
  git(remote, ['config', '--local', 'uploadpack.allowAnySHA1InWant', 'true']);
  assert.equal(git(remote, ['rev-parse', '--is-bare-repository']), 'true');

  const remoteName = 'snapshot-test-promisor';
  git(candidate.repository, ['config', '--local', 'core.repositoryFormatVersion', '1']);
  git(candidate.repository, ['config', '--local', 'extensions.partialClone', remoteName]);
  git(candidate.repository, ['config', '--local', `remote.${remoteName}.url`, pathToFileURL(remote).href]);
  git(candidate.repository, ['config', '--local', `remote.${remoteName}.promisor`, 'true']);
  git(candidate.repository, ['config', '--local', `remote.${remoteName}.partialCloneFilter`, 'blob:none']);
  const missing = git(candidate.repository, ['rev-parse', `${candidate.commit}:ignored.txt`]);
  assert.deepEqual(git(remote, ['cat-file', 'blob', missing], { raw: true }), candidate.files['ignored.txt']);
  const loose = join(candidate.repository, '.git', 'objects', missing.slice(0, 2), missing.slice(2));
  assert.ok(existsSync(loose), 'the synthetic current-tree blob starts as a loose object');
  // Git objects can retain Windows' read-only attribute; change only this
  // deliberately damaged temporary source object before unlinking it.
  chmodSync(loose, 0o600); unlinkSync(loose);
  const present = repository => new Set(git(repository, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)']).split(/\r?\n/).filter(Boolean));
  assert.equal(present(candidate.repository).has(missing), false);

  // A separate control retains the same absent object and local promisor
  // configuration. Hydrating the control later cannot repair the tested source.
  const control = join(directory, 'hydrate-control'); cpSync(candidate.repository, control, { recursive: true });
  const output = join(directory, 'rejected-promisor-snapshot');
  let observed;
  assert.throws(() => createGitSnapshot({
    sourceRoot: candidate.repository, commit: candidate.commit, tree: candidate.tree, outputDirectory: output,
  }), error => { observed = error; return error instanceof Error; });
  assert.equal(present(candidate.repository).has(missing), false, 'snapshot creation must not fetch the missing source object');
  assert.equal(existsSync(loose), false);
  assert.equal(existsSync(join(output, 'manifest.json')), false, 'an incomplete pack cannot publish a manifest');
  assert.equal(git(candidate.repository, ['rev-parse', 'HEAD']), candidate.commit);
  assert.equal(git(candidate.repository, ['rev-parse', 'HEAD^{tree}']), candidate.tree);

  // Prove the remote is usable and has the missing blob; a broken local remote
  // must not masquerade as successful isolation. This ordinary fixture Git call
  // intentionally has neither GIT_NO_LAZY_FETCH nor GIT_ALLOW_PROTOCOL set.
  assert.deepEqual(git(control, ['cat-file', 'blob', missing], { raw: true }), candidate.files['ignored.txt']);
  assert.equal(present(control).has(missing), true, 'the independent positive control really hydrates');
  assert.equal(present(candidate.repository).has(missing), false, 'the tested source remains incomplete after the control');
  t.diagnostic(`Promisor snapshot was rejected without source hydration: ${observed.message.split(/\r?\n/)[0]}`);
}));

test('commit and blob replacement refs cannot change the original snapshot or canonical bootstrap bytes', () => fixture(({ directory, git, source }) => {
  const candidate = source(), path = 'substitution.txt';
  const originalBlob = git(candidate.repository, ['rev-parse', `${candidate.commit}:${path}`]);
  const replacedBytes = Buffer.from('SYNTHETIC_REPLACEMENT_MUST_NOT_EXECUTE\n');
  const replacementBlob = git(candidate.repository, ['hash-object', '-w', '--stdin'], { input: replacedBytes });
  git(candidate.repository, ['replace', originalBlob, replacementBlob]);
  assert.deepEqual(git(candidate.repository, ['show', `${candidate.commit}:${path}`], { raw: true }), replacedBytes,
    'the positive control proves plain git show observes a blob replacement');
  assert.deepEqual(git(candidate.repository, ['--no-replace-objects', 'show', `${candidate.commit}:${path}`], { raw: true }), candidate.files[path],
    'the staged local.mjs bootstrap command reads the canonical object bytes');
  git(candidate.repository, ['replace', candidate.commit, candidate.parent]);
  assert.notEqual(git(candidate.repository, ['rev-parse', `${candidate.commit}^{tree}`]), candidate.tree,
    'the positive control proves ordinary identity lookup observes the replaced commit');
  assert.equal(git(candidate.repository, ['--no-replace-objects', 'rev-parse', `${candidate.commit}^{tree}`]), candidate.tree);
  const output = join(directory, 'snapshot'), destination = join(directory, 'restored');
  const manifest = snapshot(output, candidate);
  restore(output, destination, candidate, manifest);
  assert.deepEqual(readFileSync(join(destination, path)), candidate.files[path]);
  assert.equal(git(destination, ['rev-parse', 'HEAD']), candidate.commit);
  assert.equal(git(destination, ['rev-parse', 'HEAD^{tree}']), candidate.tree);
  assert.equal(git(destination, ['for-each-ref', '--format=%(refname)', 'refs/replace/']), '');
  assert.notEqual(git(destination, ['cat-file', '-e', replacementBlob], { failure: true }).status, 0,
    'unreachable replacement objects are not transferred');
}));
