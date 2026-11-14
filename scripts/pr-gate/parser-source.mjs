import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PARSER_106, capabilityHash } from './capabilities.mjs';

export function verifyParserArchive(bytes) {
  assert.equal(capabilityHash(bytes), PARSER_106.archive_sha256, 'Pinned parser 1.0.6 archive hash mismatch');
}
function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, ...options });
  if (result.error || result.status !== 0) throw new Error(`Parser source ${executable} failed (${result.status ?? 'spawn'}); the exact #196 source must already be available`);
  return result.stdout.trim();
}
export function createParserArchive(sourceRoot, destination) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
  // git archive applies working-tree conversions unless explicitly disabled;
  // the Windows system autocrlf setting must not rewrite this historical source.
  const git = args => command('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'tar.umask=0002', '-c', `core.attributesFile=${env.GIT_CONFIG_GLOBAL}`, '-c', 'credential.helper=', ...args], { cwd: sourceRoot, env });
  assert.equal(git(['rev-parse', `${PARSER_106.commit}^{tree}`]), PARSER_106.tree);
  assert.equal(git(['rev-parse', `${PARSER_106.commit}:python`]), PARSER_106.python_tree);
  git(['archive', '--format=tar', `--output=${resolve(destination)}`, PARSER_106.commit, 'python']);
  verifyParserArchive(readFileSync(destination));
  return { source: PARSER_106, archive_sha256: PARSER_106.archive_sha256 };
}
export function restoreParserArchive(archive, destination) {
  verifyParserArchive(readFileSync(archive));
  if (existsSync(destination)) assert.ok(lstatSync(destination).isDirectory() && !lstatSync(destination).isSymbolicLink() && readdirSync(destination).length === 0, 'Parser destination must be an empty real directory');
  else mkdirSync(destination, { recursive: true });
  command('tar', ['-xf', resolve(archive), '-C', resolve(destination)]);
  return verifyParserDirectory(archive, destination);
}
export function verifyParserDirectory(archive, destination) {
  verifyParserArchive(readFileSync(archive));
  assert.ok(lstatSync(destination).isDirectory() && !lstatSync(destination).isSymbolicLink(), 'Parser root must be a real directory');
  const files = command('tar', ['-tf', resolve(archive)]).split(/\r?\n/).filter(path => !path.endsWith('/')).sort();
  const actual = [];
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false, 'Parser source cannot contain links');
      if (entry.isDirectory()) visit(join(directory, entry.name), prefix + entry.name + '/');
      else { assert.ok(entry.isFile()); actual.push(prefix + entry.name); }
    }
  };
  visit(destination); assert.deepEqual(actual.sort(), files, 'Parser source file set changed');
  for (const path of files) {
    assert.ok(path.startsWith('python/') && !path.includes('..') && !path.includes('\\'));
    const result = spawnSync('tar', ['-xOf', resolve(archive), path], { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, 'Cannot read pinned parser source');
    assert.deepEqual(readFileSync(join(destination, path)), result.stdout, 'Parser source bytes changed: ' + path);
  }
  assert.match(readFileSync(join(destination, 'python/bondbuddy_document_parser/parser.py'), 'utf8'), /^PARSER_VERSION = "bondbuddy-document-parser-1\.0\.6"$/m);
  return { source: PARSER_106, archive_sha256: PARSER_106.archive_sha256, root: destination };
}
