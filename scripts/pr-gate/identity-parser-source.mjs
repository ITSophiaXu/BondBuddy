import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// #268 was created and passed after #258's style lookup fix, still at 1.0.6.
// Keep that exact source, not a patched #196 archive or the current 1.0.8 parser.
export const IDENTITY_PARSER_TEST = 'apps/worker/src/issuer-identity-evidence-authorized.test.ts';
export const IDENTITY_PARSER_ROOT = '/opt/pr-gate-identity-parser106';
export const IDENTITY_PARSER_106 = Object.freeze({
  commit: 'bec84a95721466c942b65cf2372cecbc5da3fc29',
  tree: '52f2e78a0415f0834f2c91450da8ab83fa61de2c',
  python_tree: 'b16b069604795a79e27a2347940685fa1abb9ebb',
  version: 'bondbuddy-document-parser-1.0.6',
  archive_sha256: '6e051b362bfdf299d6b1b6de6b7aef103a6175184ee0d255521f17b589cdca79',
  parser_sha256: '03c52c7344a7c5e6609ef10ec14d00e1e64d692608cef654d7805a90e33acfd7',
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function verifyIdentityParserArchive(bytes) {
  assert.equal(hash(bytes), IDENTITY_PARSER_106.archive_sha256, 'Pinned identity parser archive hash mismatch');
}
export function verifyIdentityParserRecord(record) {
  assert.deepEqual(record?.source, IDENTITY_PARSER_106, 'Identity regression source differs from its original #268 dependency');
  assert.equal(record.archive_sha256, IDENTITY_PARSER_106.archive_sha256);
  assert.equal(record.parser_sha256, IDENTITY_PARSER_106.parser_sha256);
  assert.equal(record.root, IDENTITY_PARSER_ROOT);
  return record;
}
function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, ...options });
  if (result.error || result.status !== 0) throw new Error('Identity parser source command failed; the exact #268 source must already be available');
  return result.stdout.trim();
}
export function createIdentityParserArchive(sourceRoot, destination) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
  const git = args => command('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf',
    '-c', 'tar.umask=0002', '-c', 'core.attributesFile=' + env.GIT_CONFIG_GLOBAL, '-c', 'credential.helper=', ...args], { cwd: sourceRoot, env });
  assert.equal(git(['rev-parse', IDENTITY_PARSER_106.commit + '^{tree}']), IDENTITY_PARSER_106.tree);
  assert.equal(git(['rev-parse', IDENTITY_PARSER_106.commit + ':python']), IDENTITY_PARSER_106.python_tree);
  git(['archive', '--format=tar', '--output=' + resolve(destination), IDENTITY_PARSER_106.commit, 'python']);
  verifyIdentityParserArchive(readFileSync(destination));
  return { source: IDENTITY_PARSER_106, archive_sha256: IDENTITY_PARSER_106.archive_sha256 };
}
export function restoreIdentityParserArchive(archive, destination) {
  verifyIdentityParserArchive(readFileSync(archive));
  if (existsSync(destination)) assert.ok(lstatSync(destination).isDirectory() && !lstatSync(destination).isSymbolicLink() && readdirSync(destination).length === 0, 'Identity parser destination must be an empty real directory');
  else mkdirSync(destination, { recursive: true });
  command('tar', ['-xf', resolve(archive), '-C', resolve(destination)]);
  return verifyIdentityParserDirectory(archive, destination);
}
export function verifyIdentityParserDirectory(archive, destination) {
  verifyIdentityParserArchive(readFileSync(archive));
  assert.ok(lstatSync(destination).isDirectory() && !lstatSync(destination).isSymbolicLink(), 'Identity parser root must be a real directory');
  const files = command('tar', ['-tf', resolve(archive)]).split(/\r?\n/).filter(path => !path.endsWith('/')).sort();
  const actual = [];
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false, 'Identity parser source cannot contain links');
      if (entry.isDirectory()) visit(join(directory, entry.name), prefix + entry.name + '/');
      else { assert.ok(entry.isFile()); actual.push(prefix + entry.name); }
    }
  };
  visit(destination); assert.deepEqual(actual.sort(), files, 'Identity parser source file set changed');
  for (const path of files) {
    assert.ok(path.startsWith('python/') && !path.includes('..') && !path.includes('\\'));
    const result = spawnSync('tar', ['-xOf', resolve(archive), path], { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, 'Cannot read pinned identity parser source');
    assert.deepEqual(readFileSync(join(destination, path)), result.stdout, 'Identity parser source bytes changed: ' + path);
  }
  const parser = readFileSync(join(destination, 'python/bondbuddy_document_parser/parser.py'));
  assert.equal(hash(parser), IDENTITY_PARSER_106.parser_sha256);
  assert.match(parser.toString('utf8'), /^PARSER_VERSION = "bondbuddy-document-parser-1\.0\.6"$/m);
  return { source: IDENTITY_PARSER_106, archive_sha256: IDENTITY_PARSER_106.archive_sha256,
    parser_sha256: IDENTITY_PARSER_106.parser_sha256, root: destination };
}
