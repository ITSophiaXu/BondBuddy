import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import type COS from 'cos-nodejs-sdk-v5';
import { cosBlobs } from './cos-storage.js';

class FakeCos {
  objects = new Map<string, { bytes: Buffer; type: string; etag: string }>();
  seenIfMatch: string[] = [];
  replaceBeforeGet = false;
  private value(key: string) {
    const value = this.objects.get(key);
    if (!value) throw Object.assign(new Error('absent'), { code: 'NoSuchKey', statusCode: 404 });
    return value;
  }
  async putObject(input: { Key: string; Body: Buffer; ContentType: string }) {
    this.objects.set(input.Key, { bytes: Buffer.from(input.Body), type: input.ContentType, etag: randomUUID() });
    return {};
  }
  async sliceUploadFile(input: { Key: string; FilePath: string; ContentType: string }) {
    return this.putObject({ Key: input.Key, Body: await readFile(input.FilePath), ContentType: input.ContentType });
  }
  async getObject(input: { Key: string }) { return { Body: Buffer.from(this.value(input.Key).bytes) }; }
  async headObject(input: { Key: string }) {
    const value = this.value(input.Key);
    return { ETag: value.etag, headers: { 'content-length': String(value.bytes.length) } };
  }
  getObjectStream(input: { Key: string; IfMatch: string }) {
    this.seenIfMatch.push(input.IfMatch);
    if (this.replaceBeforeGet) this.value(input.Key).etag = randomUUID();
    const value = this.value(input.Key);
    if (input.IfMatch !== value.etag)
      return Readable.from((async function* () {
        throw Object.assign(new Error('changed'), { code: 'PreconditionFailed', statusCode: 412 });
      })());
    return Readable.from([Buffer.from(value.bytes)]);
  }
  async deleteObject(input: { Key: string }) { this.objects.delete(input.Key); return {}; }
  async getBucket(input: { Prefix: string; Marker?: string; MaxKeys: number }) {
    const keys = [...this.objects.keys()].filter(key => key.startsWith(input.Prefix) && (!input.Marker || key > input.Marker)).sort();
    const selected = keys.slice(0, input.MaxKeys);
    return { IsTruncated: keys.length > selected.length ? 'true' : 'false', NextMarker: selected.at(-1),
      Contents: selected.map(key => ({ Key: key, Size: String(this.value(key).bytes.length), ETag: this.value(key).etag,
        LastModified: '2026-11-26T00:00:00Z' })) };
  }
}

test('COS adapter supports private object operations with bounded streaming', async () => {
  const fake = new FakeCos();
  const blobs = cosBlobs(fake as unknown as COS, 'test-123', 'ap-beijing');
  const bytes = Buffer.from('bondbuddy cos fixture');
  assert.equal(await blobs.getIfExists('users/a/missing'), null);
  await blobs.put('users/a/one', bytes, 'text/plain');
  assert.equal(fake.objects.get('users/a/one')?.type, 'text/plain');
  assert.deepEqual(await blobs.get('users/a/one'), bytes);
  assert.equal(await blobs.exists('users/a/one'), true);
  assert.deepEqual(await blobs.getIfExistsBounded('users/a/one', bytes.length), bytes);
  await assert.rejects(blobs.getIfExistsBounded('users/a/one', bytes.length - 1), { status: 413 });
  const root = await mkdtemp(join(tmpdir(), 'bb-cos-adapter-'));
  try {
    const path = join(root, 'read.txt');
    const read = await blobs.readToFile!('users/a/one', path, 1024);
    assert.deepEqual(await readFile(path), bytes);
    assert.equal(read?.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(read?.byteSize, bytes.length);
    assert.equal(fake.seenIfMatch.at(-1), read?.etag);
    const upload = join(root, 'upload.txt');
    await writeFile(upload, Buffer.from('from disk'));
    await blobs.putFile!('users/a/two', upload, 'text/plain');
    assert.equal((await blobs.get('users/a/two')).toString(), 'from disk');
    const opened = await blobs.openRead!('users/a/two');
    assert.equal(opened?.contentLength, 9);
    const chunks: Buffer[] = [];
    for await (const chunk of opened!.body) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), 'from disk');
  } finally { await rm(root, { recursive: true, force: true }); }
  const first = await blobs.listPage!('users/a/', undefined, 1);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0]?.key, 'users/a/one');
  const second = await blobs.listPage!('users/a/', first.continuation, 1);
  assert.equal(second.items[0]?.key, 'users/a/two');
  assert.equal(second.continuation, undefined);
  assert.equal(blobs.deleteIfMatch, undefined);
  assert.equal(blobs.createUploadUrl, undefined);
  await blobs.delete('users/a/one');
  assert.equal(await blobs.exists('users/a/one'), false);
});

test('COS adapter rejects a changed object and removes partial output', async () => {
  const fake = new FakeCos();
  const blobs = cosBlobs(fake as unknown as COS, 'test-123', 'ap-beijing');
  await blobs.put('users/a/one', Buffer.from('version one'), 'text/plain');
  fake.replaceBeforeGet = true;
  const root = await mkdtemp(join(tmpdir(), 'bb-cos-race-'));
  const path = join(root, 'partial.txt');
  try {
    await assert.rejects(blobs.readToFile!('users/a/one', path, 1024), { statusCode: 412 });
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
