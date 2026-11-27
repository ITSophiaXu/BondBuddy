import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { copyCurrentObject } from './cos-copy-core.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('copy hashes the Azure stream once and verifies COS before recording success', async () => {
  const objects = new Map();
  let sourceReads = 0, targetReads = 0;
  const source = { async open(key, etag) {
    assert.equal(key, 'users/test/file'); assert.equal(etag, '"source-v1"');
    sourceReads++; return Readable.from([Buffer.from('synthetic '), Buffer.from('object')]);
  } };
  const target = {
    async head(key) { return objects.has(key) ? { bytes: objects.get(key).length } : null; },
    async put(key, body, length, mediaType, options) {
      assert.equal(length, 16); assert.equal(mediaType, 'text/plain'); assert.equal(options.createOnly, true);
      const chunks = []; for await (const chunk of body) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
    },
    async open(key) { targetReads++; return Readable.from([objects.get(key)]); },
  };
  const entry = { key: 'users/test/file', bytes: 16, etag: '"source-v1"', contentType: 'text/plain',
    expectedSha256: digest(Buffer.from('synthetic object')) };
  const record = await copyCurrentObject({ source, target, entry });
  assert.equal(record.status, 'copied');
  assert.equal(record.sha256, entry.expectedSha256);
  const again = await copyCurrentObject({ source, target, entry, previous: record });
  assert.equal(again.status, 'verified_existing');
  assert.equal(sourceReads, 1, 'a successful rerun must not download Azure again');
  assert.equal(targetReads, 2);
  await assert.rejects(copyCurrentObject({ source, target,
    entry: { ...entry, expectedSha256: digest(Buffer.from('different')) }, previous: record }), /trusted database hash/);
  assert.equal(sourceReads, 1);
  objects.set(entry.key, Buffer.from('corrupt')); // The recorded target can never be silently overwritten.
  await assert.rejects(copyCurrentObject({ source, target, entry, previous: record }), /matching verified migration receipt/);
  assert.equal(sourceReads, 1);
});

test('changed source requires explicit replacement and an existing receipt', async () => {
  const objects = new Map([['k', Buffer.from('old')]]);
  const source = { async open() { return Readable.from([Buffer.from('new')]); } };
  const target = {
    async head(key) { return objects.has(key) ? {} : null; },
    async open(key) { return Readable.from([objects.get(key)]); },
    async put(key, body, _length, _type, options) {
      assert.equal(options.createOnly, false);
      const chunks = []; for await (const chunk of body) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
    },
  };
  const previous = { key: 'k', sourceEtag: 'old-etag', bytes: 3, sha256: digest(Buffer.from('old')) };
  const entry = { key: 'k', etag: 'new-etag', bytes: 3, contentType: 'text/plain' };
  await assert.rejects(copyCurrentObject({ source, target, entry, previous }), /explicit incremental replacement/);
  const record = await copyCurrentObject({ source, target, entry, previous, allowReplace: true });
  assert.equal(record.status, 'replaced');
  assert.equal(objects.get('k').toString(), 'new');
  await assert.rejects(copyCurrentObject({ source, target, entry: { ...entry, accessTier: 'Archive' } }), /rehydrated/);
});

test('lost upload response is accepted only after exact COS readback', async () => {
  const objects = new Map();
  const source = { async open() { return Readable.from([Buffer.from('abc')]); } };
  const target = {
    async head(key) { return objects.has(key) ? {} : null; },
    async open(key) { return Readable.from([objects.get(key)]); },
    async put(key, body) {
      const chunks = []; for await (const chunk of body) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
      throw new Error('synthetic response lost');
    },
  };
  const record = await copyCurrentObject({ source, target,
    entry: { key: 'k', etag: 'v1', bytes: 3, contentType: 'text/plain' } });
  assert.equal(record.sha256, digest(Buffer.from('abc')));
  assert.equal(record.status, 'copied');
});

test('trusted hash mismatch cannot replace a previously verified target', async () => {
  const old = Buffer.from('old');
  let targetBody = old, writes = 0;
  const target = {
    async head() { return { bytes: targetBody.length }; },
    async open() { return Readable.from([targetBody]); },
    async put() { writes++; throw new Error('must not upload mismatched source'); },
  };
  const previous = { key: 'k', sourceEtag: 'v1', bytes: old.length, sha256: digest(old) };
  const entry = { key: 'k', etag: 'v2', bytes: 3, contentType: 'text/plain', expectedSha256: digest(Buffer.from('good')) };
  const source = { async open() { return Readable.from([Buffer.from('bad')]); } };
  await assert.rejects(copyCurrentObject({ source, target, entry, previous, allowReplace: true }), /trusted database hash/);
  assert.equal(writes, 0);
  assert.deepEqual(targetBody, old);
});
