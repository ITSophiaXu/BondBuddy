import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, mock } from 'node:test';
import { BlobServiceClient, BlockBlobClient } from '@azure/storage-blob';
import { azureBlobs, digest } from './data.js';
import { BLOB_RANGE_BYTES } from './blob-range-reader.js';

const storage = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
async function fixture(work: (f: { blobs: ReturnType<typeof azureBlobs>; path: string; dir: string }) => Promise<void>) {
  const name = 'bb-ranges-' + randomUUID().replaceAll('-', '');
  const container = BlobServiceClient.fromConnectionString(storage!).getContainerClient(name);
  const dir = await mkdtemp(join(tmpdir(), 'bb-range-sdk-'));
  try { await work({ blobs: azureBlobs(storage!, name), dir, path: join(dir, 'proof') }); }
  finally { await container.deleteIfExists(); await rm(dir, { recursive: true, force: true }); }
}

test('real SDK large read pins every range to the downloaded version and returns a full spool proof', { skip: !storage }, async () => fixture(async ({ blobs, path }) => {
  const bytes = randomBytes(BLOB_RANGE_BYTES * 4 + 97);
  await blobs.put('large', bytes, 'application/octet-stream');
  const version = await blobs.headVersion!('large');
  const download = BlockBlobClient.prototype.download;
  const calls: { offset?: number; count?: number; ifMatch?: string }[] = [];
  const intercepted = mock.method(BlockBlobClient.prototype, 'download', function(this: BlockBlobClient, ...args: Parameters<typeof download>) {
    calls.push({ offset: args[0], count: args[1], ifMatch: args[2]?.conditions?.ifMatch });
    return download.apply(this, args);
  });
  try {
    const proof = await blobs.readToFile!('large', path, bytes.length);
    assert.deepEqual(proof, { byteSize: bytes.length, sha256: digest(bytes), etag: version!.etag });
    assert.deepEqual(await readFile(path), bytes);
    assert.equal(calls.length, 6); // One initial actual download and five fixed ranges.
    assert.deepEqual(calls.slice(1).map(c => [c.offset, c.count]), [0, 1, 2, 3, 4].map(n => [n * BLOB_RANGE_BYTES, n === 4 ? 97 : BLOB_RANGE_BYTES]));
    assert.ok(calls.slice(1).every(c => c.ifMatch === version!.etag));
  } finally { intercepted.mock.restore(); }
}));

test('real SDK small and digest-only reads retain the full single-stream proof', { skip: !storage }, async () => fixture(async ({ blobs, path }) => {
  const small = randomBytes(1001), large = randomBytes(BLOB_RANGE_BYTES + 31);
  await blobs.put('small', small, 'application/octet-stream');
  await blobs.put('large', large, 'application/octet-stream');
  const download = BlockBlobClient.prototype.download;
  const intercepted = mock.method(BlockBlobClient.prototype, 'download', download);
  try {
    assert.equal((await blobs.readToFile!('small', path, small.length))!.sha256, digest(small));
    assert.deepEqual(await readFile(path), small);
    assert.equal((await blobs.readToFile!('large', null, large.length))!.sha256, digest(large));
    assert.equal(intercepted.mock.calls.length, 2);
    assert.ok(intercepted.mock.calls.every(c => c.arguments.length === 0));
  } finally { intercepted.mock.restore(); }
}));

test('real SDK changed ETag returns 503 and removes the partial spool without reading a new version', { skip: !storage }, async () => fixture(async ({ blobs, path, dir }) => {
  const bytes = randomBytes(BLOB_RANGE_BYTES * 2 + 19);
  await blobs.put('changing', bytes, 'application/octet-stream');
  const first = await blobs.headVersion!('changing');
  const download = BlockBlobClient.prototype.download;
  let changed: Promise<void> | undefined;
  const tags: string[] = [];
  const intercepted = mock.method(BlockBlobClient.prototype, 'download', async function(this: BlockBlobClient, ...args: Parameters<typeof download>) {
    if (args[1] !== undefined) {
      tags.push(args[2]!.conditions!.ifMatch!);
      changed ??= blobs.put('changing', Buffer.alloc(bytes.length, 120), 'application/octet-stream');
      await changed;
    }
    return download.apply(this, args);
  });
  try {
    await assert.rejects(blobs.readToFile!('changing', path, bytes.length), { status: 503, code: 'DATA_UNAVAILABLE' });
    assert.equal(tags.length, 3);
    assert.ok(tags.every(tag => tag === first!.etag));
    assert.deepEqual(await readdir(dir), []);
  } finally { intercepted.mock.restore(); }
}));

test('real SDK enforces the declared read bound before opening any spool', { skip: !storage }, async () => fixture(async ({ blobs, path, dir }) => {
  await blobs.put('too-large', randomBytes(BLOB_RANGE_BYTES + 1), 'application/octet-stream');
  await assert.rejects(blobs.readToFile!('too-large', path, BLOB_RANGE_BYTES), { status: 413, code: 'DATA_UNAVAILABLE' });
  assert.deepEqual(await readdir(dir), []);
}));
