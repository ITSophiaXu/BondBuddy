import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { BLOB_RANGE_BYTES, BLOB_RANGE_CONCURRENCY, readBlobRangesToFile, type BlobRangeDownload, type BlobRangeResponse } from './blob-range-reader.js';
const bytes = randomBytes(BLOB_RANGE_BYTES * 4 + 97), version = '"first-version"';
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(fn: (path: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'bb-range-')); try { await fn(join(dir, 'copy.blob'), dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
function reply(start: number, count: number): BlobRangeResponse { return { etag: version, contentRange: `bytes ${start}-${start + count - 1}/${bytes.length}`, contentLength: count, body: Readable.from([bytes.subarray(start, start + count)]) }; }

test('range downloads complete out of order with at most four slots, one spool, and an ordered full SHA', async () => fixture(async (path, dir) => {
  let active = 0, peak = 0; const ended: number[] = [], calls: number[] = [];
  const download: BlobRangeDownload = async (start, count, etag, signal) => {
    assert.equal(etag, version); assert.equal(signal.aborted, false); active++; peak = Math.max(peak, active); calls.push(start);
    const r = reply(start, count); r.body = Readable.from((async function* () { try { await delay(start === 0 ? 35 : 5); yield bytes.subarray(start, start + count); ended.push(start); } finally { active--; } })()); return r;
  };
  const proof = await readBlobRangesToFile(download, path, bytes.length, version);
  assert.equal(peak, BLOB_RANGE_CONCURRENCY); assert.equal(active, 0); assert.notEqual(ended[0], 0);
  assert.deepEqual(calls, [0, BLOB_RANGE_BYTES, 2 * BLOB_RANGE_BYTES, 3 * BLOB_RANGE_BYTES, 4 * BLOB_RANGE_BYTES]);
  assert.deepEqual(await readFile(path), bytes); assert.equal(proof.sha256, digest(bytes)); assert.equal(proof.etag, version); assert.equal(proof.byteSize, bytes.length);
  assert.deepEqual(await readdir(dir), ['copy.blob']);
}));

for (const mutation of ['etag', 'range_start', 'range_end', 'range_total', 'length_header', 'short_body', 'long_body', 'no_body'] as const) test(`reject ${mutation}; cancel peers and remove only the partial spool`, async () => fixture(async (path, dir) => {
  const signals: AbortSignal[] = []; let destroyed = 0;
  const download: BlobRangeDownload = async (start, count, _etag, signal) => {
    signals.push(signal); const r = reply(start, count);
    if (start === 0) {
      if (mutation === 'etag') r.etag = '"changed"';
      if (mutation === 'range_start') r.contentRange = `bytes 1-${count}/${bytes.length}`;
      if (mutation === 'range_end') r.contentRange = `bytes 0-${count}/${bytes.length}`;
      if (mutation === 'range_total') r.contentRange = `bytes 0-${count - 1}/${bytes.length + 1}`;
      if (mutation === 'length_header') r.contentLength = count + 1;
      if (mutation === 'short_body') r.body = Readable.from([bytes.subarray(0, count - 1)]);
      if (mutation === 'long_body') r.body = Readable.from([bytes.subarray(0, count + 1)]);
      if (mutation === 'no_body') r.body = undefined;
    } else await delay(15); // Headers may arrive after a peer already failed.
    r.body?.once('close', () => { destroyed++; }); return r;
  };
  await assert.rejects(readBlobRangesToFile(download, path, bytes.length, version));
  assert.ok(signals.every(s => s.aborted)); assert.equal(destroyed, signals.length - (mutation === 'no_body' ? 1 : 0));
  assert.deepEqual(await readdir(dir), []);
}));

test('412 during a multi-range read never retries a new version; all requests settle before cleanup', async () => fixture(async (path, dir) => {
  let finished = 0, active = 0; const tags: string[] = [];
  const download: BlobRangeDownload = async (start, count, tag, signal) => {
    tags.push(tag); active++;
    try { if (start === BLOB_RANGE_BYTES) { await delay(5); throw Object.assign(new Error('version changed'), { statusCode: 412 }); }
      await delay(15); assert.equal(signal.aborted, true); return reply(start, count);
    } finally { active--; finished++; }
  };
  await assert.rejects(readBlobRangesToFile(download, path, bytes.length, version), { statusCode: 412 });
  assert.equal(active, 0); assert.equal(finished, 4); assert.deepEqual(tags, [version, version, version, version]); assert.deepEqual(await readdir(dir), []);
}));

test('streams failing after partial bytes settle and remove the partial spool', async () => fixture(async (path, dir) => {
  const download: BlobRangeDownload = async (start, count) => {
    const r = reply(start, count); if (start === 0) r.body = Readable.from((async function* () { yield bytes.subarray(0, 1024); throw new Error('network interrupted'); })()); return r;
  };
  await assert.rejects(readBlobRangesToFile(download, path, bytes.length, version), /network interrupted/); assert.deepEqual(await readdir(dir), []);
}));

test('positional short writes are retried to preserve every byte', async () => fixture(async (path, dir) => {
  const h = await open(join(dir, 'probe'), 'wx'); const prototype = Object.getPrototypeOf(h); const write = prototype.write; await h.close();
  const mocked = mock.method(prototype, 'write', function(this: unknown, buffer: Buffer, offset: number, length: number, position: number) { return write.call(this, buffer, offset, Math.min(length, 65537), position); });
  try { const proof = await readBlobRangesToFile(async (start, count) => reply(start, count), path, bytes.length, version); assert.equal(proof.sha256, digest(bytes)); assert.ok(mocked.mock.calls.length > 10); } finally { mocked.mock.restore(); }
}));

test('existing caller file is preserved if exclusive open fails', async () => fixture(async path => {
  const h = await open(path, 'wx'); await h.writeFile('retain'); await h.close();
  await assert.rejects(readBlobRangesToFile(async (start, count) => reply(start, count), path, bytes.length, version), { code: 'EEXIST' }); assert.equal(await readFile(path, 'utf8'), 'retain');
}));
