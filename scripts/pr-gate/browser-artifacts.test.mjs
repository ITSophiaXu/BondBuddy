import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { archiveBrowserOutput, browserAttachments, verifyBrowserOutputArchive } from './browser-artifacts.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const report = paths => ({ suites: [{ specs: [{ tests: [{ results: [{ attachments: paths.map(path => ({ name: 'synthetic screenshot', path })) }] }] }] }] });

test('before another invocation clears output, original attachment bytes and explicit mapping survive', t => {
  const root = mkdtempSync(join(tmpdir(), 'bb-output-archive-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'results'), evidence = join(root, 'evidence'), archive = join(root, 'archive'); mkdirSync(source); mkdirSync(evidence);
  const path = join(source, 'failure.png'), context = join(source, 'error-context.md'), extra = join(evidence, 'extra.txt');
  writeFileSync(path, 'synthetic image bytes'); writeFileSync(context, 'synthetic context'); writeFileSync(extra, 'synthetic evidence');
  const input = report([path, extra, path]), copy = structuredClone(input), proof = archiveBrowserOutput({ source, destination: archive, evidenceRoot: evidence, report: input });
  assert.deepEqual(input, copy); assert.equal(proof.files.length, 2); assert.equal(proof.attachments.length, 2); assert.deepEqual(browserAttachments(input), [extra, path].sort());
  rmSync(source, { recursive: true }); for (const item of [...proof.files, ...proof.attachments]) assert.equal(hash(readFileSync(item.archive_path)), item.sha256);
  assert.throws(() => archiveBrowserOutput({ source, destination: archive, evidenceRoot: evidence, report: input }), /not fresh/);
});

test('unowned or missing original attachment cannot become a successful archive', t => {
  const root = mkdtempSync(join(tmpdir(), 'bb-output-reject-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'results'), evidence = join(root, 'evidence'); mkdirSync(source); mkdirSync(evidence);
  assert.throws(() => archiveBrowserOutput({ source, destination: join(root, 'one'), evidenceRoot: evidence, report: report([join(root, 'outside.txt')]) }), /outside owned/);
  assert.throws(() => archiveBrowserOutput({ source, destination: join(root, 'traversal'), evidenceRoot: evidence, report: report([source + '/../../outside.txt']) }), /outside owned/);
  assert.throws(() => archiveBrowserOutput({ source, destination: join(root, 'two'), evidenceRoot: evidence, report: report([join(source, 'missing.png')]) }));
});

test('archive receipt refuses changed hashes, group paths and unmapped attachment references', () => {
  const proof = { schema: 'pr-gate-browser-output-archive-v1', source_root: '/tmp/bondbuddy-web-test-results', source_exists: true, archive_root: '/evidence/shards/browser-1/playwright-output-current', files: [], attachments: [], manifest_sha256: hash(JSON.stringify({ files: [], attachments: [] })) };
  verifyBrowserOutputArchive(proof, { shard: 'browser-1', group: 'current' });
  for (const mutate of [row => row.archive_root += '-old', row => row.manifest_sha256 = 'f'.repeat(64), row => row.attachments.push({ original_path: '/root/secret', archive_path: proof.archive_root + '/fake', bytes: 1, sha256: 'a'.repeat(64) })]) {
    const changed = structuredClone(proof); mutate(changed); assert.throws(() => verifyBrowserOutputArchive(changed, { shard: 'browser-1', group: 'current' }));
  }
});
