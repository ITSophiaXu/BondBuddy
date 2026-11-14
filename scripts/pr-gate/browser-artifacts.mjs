import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const within = (root, path) => { const base = root.replaceAll('\\', '/').replace(/\/$/, ''), value = path.replaceAll('\\', '/'); return value === base || value.startsWith(base + '/'); };
export const BROWSER_OUTPUT_ROOT = '/tmp/bondbuddy-web-test-results';
export function browserAttachments(report) {
  const paths = new Set();
  const walk = suite => { for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) for (const result of test.results ?? []) for (const item of result.attachments ?? []) if (item.path) paths.add(item.path);
    for (const child of suite.suites ?? []) walk(child); };
  for (const suite of report?.suites ?? []) walk(suite); return [...paths].sort();
}
/** Called after each original invocation, before Playwright can clear outputDir. */
export function archiveBrowserOutput({ destination, report, evidenceRoot, source = BROWSER_OUTPUT_ROOT }) {
  assert.ok(isAbsolute(destination) && isAbsolute(source)); assert.equal(existsSync(destination), false, 'Browser output archive is not fresh');
  const files = [], attachments = []; const sourceExists = existsSync(source); mkdirSync(destination, { recursive: true });
  function copy(path, archivePath) {
    const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Browser attachment must be a regular file'); assert.equal(realpathSync(path), resolve(path));
    const bytes = readFileSync(path), target = join(destination, archivePath); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes, { flag: 'wx' });
    assert.equal(hash(readFileSync(target)), hash(bytes)); return { original_path: path, archive_path: target, bytes: bytes.length, sha256: hash(bytes) };
  }
  function walk(dir) { assert.ok(lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink()); assert.equal(realpathSync(dir), resolve(dir));
    for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); assert.ok(!entry.isSymbolicLink());
      if (entry.isDirectory()) walk(path); else files.push(copy(path, 'output/' + relative(source, path).replaceAll('\\', '/'))); } }
  if (sourceExists) walk(source);
  for (const path of browserAttachments(report)) {
    assert.ok(isAbsolute(path) && !path.replaceAll('\\', '/').split('/').some(part => part === '..' || part === '.') && (within(source, resolve(path)) || within(evidenceRoot, resolve(path))), 'Browser attachment is outside owned output/evidence');
    const existing = files.find(row => row.original_path === path); attachments.push(existing ?? copy(path, 'attachments/' + hash(path)));
  }
  files.sort((a, b) => a.original_path.localeCompare(b.original_path));
  const proof = { schema: 'pr-gate-browser-output-archive-v1', source_root: source, source_exists: sourceExists, archive_root: destination, files, attachments };
  proof.manifest_sha256 = hash(JSON.stringify({ files, attachments })); return proof;
}
export function verifyBrowserOutputArchive(proof, { shard, group, attachmentPaths = [] }) {
  assert.equal(proof?.schema, 'pr-gate-browser-output-archive-v1'); assert.equal(proof.source_root, BROWSER_OUTPUT_ROOT);
  const root = `/evidence/shards/${shard}/playwright-output-${group}`; assert.equal(proof.archive_root, root); assert.equal(typeof proof.source_exists, 'boolean');
  assert.ok(Array.isArray(proof.files) && Array.isArray(proof.attachments)); if (!proof.source_exists) assert.equal(proof.files.length, 0);
  const paths = new Set();
  for (const row of proof.files) { assert.ok(within(BROWSER_OUTPUT_ROOT, row.original_path)); assert.ok(!paths.has(row.original_path)); paths.add(row.original_path);
    assert.equal(row.archive_path, root + '/output/' + row.original_path.slice(BROWSER_OUTPUT_ROOT.length + 1)); }
  for (const row of [...proof.files, ...proof.attachments]) {
    assert.ok(!row.original_path.split('/').includes('..') && !row.archive_path.split('/').includes('..')); assert.ok(within(root, row.archive_path));
    assert.ok(Number.isSafeInteger(row.bytes) && row.bytes >= 0); assert.match(row.sha256, /^[a-f0-9]{64}$/);
  }
  assert.ok(Array.isArray(attachmentPaths)); assert.deepEqual(attachmentPaths, [...new Set(attachmentPaths)].sort());
  assert.deepEqual(proof.attachments.map(row => row.original_path).sort(), attachmentPaths, 'Archived attachments differ from the original report reference set');
  assert.equal(new Set(proof.attachments.map(row => row.original_path)).size, proof.attachments.length);
  for (const row of proof.attachments) { const owned = proof.files.find(file => file.original_path === row.original_path);
    if (owned) assert.deepEqual(row, owned); else { assert.ok(within(`/evidence/shards/${shard}/browser`, row.original_path)); assert.equal(row.archive_path, root + '/attachments/' + hash(row.original_path)); } }
  assert.equal(proof.manifest_sha256, hash(JSON.stringify({ files: proof.files, attachments: proof.attachments }))); return proof;
}
