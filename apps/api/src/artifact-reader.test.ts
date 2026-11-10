import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { readVerifiedArtifact } from './artifact-reader.js';
import { digest, type PrivateBlobs } from './data.js';
import { BLOB_RANGE_BYTES } from './blob-range-reader.js';
import { WORD_MEDIA_TYPE } from './docx-inspector.js';
import { reservedSpoolBytes } from './upload-spool.js';

const bytes = Buffer.alloc(BLOB_RANGE_BYTES + 31, 123);
const artifact = { media_type: WORD_MEDIA_TYPE, object_key: 'synthetic/artifact', sha256: digest(bytes), delivery_evidence_byte_size: bytes.length };
const failure = { status: 503, code: 'DATA_UNAVAILABLE' };
async function fixture(work: (directory: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'bb-artifact-test-'));
  const previous = process.env.BB_UPLOAD_SPOOL_DIR;
  process.env.BB_UPLOAD_SPOOL_DIR = dir;
  const before = reservedSpoolBytes();
  try { await work(dir); }
  finally {
    assert.equal(reservedSpoolBytes(), before);
    assert.deepEqual(await readdir(dir), []);
    if (previous === undefined) delete process.env.BB_UPLOAD_SPOOL_DIR; else process.env.BB_UPLOAD_SPOOL_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}
function storage(read: NonNullable<PrivateBlobs['readToFile']>): PrivateBlobs {
  return { readToFile: read, getIfExistsBounded: async () => { throw Error('must not fall back after spool failure'); } } as unknown as PrivateBlobs;
}

test('cold artifact reads reserve exactly their bound, verify the spool again and clean up on every read', async () => fixture(async directory => {
  let reads = 0;
  const blobs = storage(async (key, path, bound, options) => {
    reads++;
    assert.equal(key, artifact.object_key); assert.equal(bound, bytes.length);
    assert.equal(reservedSpoolBytes(), bytes.length);
    assert.deepEqual(options, { useRanges: true });
    assert.equal(dirname(path!), directory);
    await writeFile(path!, bytes, { flag: 'wx', mode: 0o600 });
    assert.equal((await stat(path!)).mode & 0o777, 0o600);
    return { byteSize: bound, sha256: digest(bytes), etag: 'synthetic-response-etag' };
  });
  for (let i = 0; i < 2; i++) assert.deepEqual(await readVerifiedArtifact(blobs, artifact), bytes);
  assert.equal(reads, 2, 'repeated reads must not trust a cached integrity receipt');
}));

test('artifact reader rejects missing, damaged and changed spools even with an apparently valid receipt', async () => fixture(async () => {
  for (const kind of ['missing', 'short', 'long', 'same-size-damaged', 'null', 'wrong-proof', 'range-error']) {
    const blobs = storage(async (_key, path, bound) => {
      if (kind !== 'missing') {
        const value = kind === 'short' ? bytes.subarray(1) : kind === 'long' ? Buffer.concat([bytes, Buffer.from('x')]) : kind === 'same-size-damaged' ? Buffer.alloc(bytes.length) : bytes;
        await writeFile(path!, value, { flag: 'wx', mode: 0o600 });
      }
      if (kind === 'range-error') throw Error('range changed or cancelled after its streams settled');
      return kind === 'null' ? null : { byteSize: bound, sha256: kind === 'wrong-proof' ? '0'.repeat(64) : artifact.sha256, etag: 'synthetic-etag' };
    });
    await assert.rejects(readVerifiedArtifact(blobs, artifact), failure, kind);
    assert.equal(reservedSpoolBytes(), 0, kind);
  }
}));

test('artifact range operations have a finite slot limit and restore capacity only after completion', async () => fixture(async () => {
  const gates: (() => void)[] = [];
  const blobs = storage(async (_key, path, bound) => {
    await new Promise<void>(resolve => gates.push(resolve));
    await writeFile(path!, bytes, { flag: 'wx', mode: 0o600 });
    return { byteSize: bound, sha256: artifact.sha256 };
  });
  const first = readVerifiedArtifact(blobs, artifact), second = readVerifiedArtifact(blobs, artifact);
  while (gates.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(reservedSpoolBytes(), 2 * bytes.length);
  await assert.rejects(readVerifiedArtifact(blobs, artifact), failure);
  for (const release of gates) release();
  await Promise.all([first, second]);
  assert.equal(reservedSpoolBytes(), 0);
}));

test('small artifacts and storage implementations without range support preserve bounded full verification', async () => {
  const small = Buffer.from('synthetic-small'); let reads = 0;
  const blobs = { getIfExistsBounded: async (_key: string, bound: number) => { reads++; assert.equal(bound, small.length); return small; }, readToFile: async () => { throw Error('small read must not spool'); } } as unknown as PrivateBlobs;
  const row = { ...artifact, sha256: digest(small), delivery_evidence_byte_size: small.length };
  assert.deepEqual(await readVerifiedArtifact(blobs, row), small);
  await assert.rejects(readVerifiedArtifact(blobs, { ...row, sha256: '0'.repeat(64) }), failure);
  await assert.rejects(readVerifiedArtifact(blobs, { ...row, delivery_evidence_byte_size: 100 * 1024 * 1024 + 1 }), failure);
  assert.equal(reads, 2);
  const legacy = { getIfExistsBounded: async (_key: string, bound: number) => { assert.equal(bound, bytes.length); return bytes; } } as unknown as PrivateBlobs;
  assert.deepEqual(await readVerifiedArtifact(legacy, artifact), bytes);
  await assert.rejects(readVerifiedArtifact(legacy, { ...artifact, sha256: '0'.repeat(64) }), failure);
});

test('large PDF uses the same cold full integrity proof and exact read limit', async () => fixture(async () => {
  const blobs = storage(async (_key, path, bound) => {
    assert.equal(bound, bytes.length);
    await writeFile(path!, bytes, { flag: 'wx', mode: 0o600 });
    return { byteSize: bound, sha256: artifact.sha256 };
  });
  assert.deepEqual(await readVerifiedArtifact(blobs, { ...artifact, media_type: 'application/pdf' }), bytes);
  await assert.rejects(readVerifiedArtifact(blobs, { ...artifact, media_type: 'application/pdf', delivery_evidence_byte_size: 7 }), failure);
}));
