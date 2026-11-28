import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import type COS from 'cos-nodejs-sdk-v5';
import { archiveStoreFromEnv } from './log-archive-store.js';

const env = { BB_STORAGE_PROVIDER: 'cos', BB_COS_SECRET_ID: 'synthetic-id', BB_COS_SECRET_KEY: 'synthetic-key',
  BB_COS_BUCKET: 'synthetic-1250000000', BB_COS_REGION: 'ap-beijing' };
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');

test('COS archive store checks private bucket, conditional write and pinned readback', async () => {
  const saved = new Map<string, Buffer>();
  const uploads: Record<string, unknown>[] = [];
  let acl = 'private';
  let versioned = false;
  const versions = new Map<string, string[]>();
  const deleted: Record<string, unknown>[] = [];
  const client = {
    async headBucket() { return {}; },
    async getBucketAcl() { return { ACL: acl }; },
    async putObject(params: Record<string, unknown>) {
      uploads.push(params);
      assert.equal(params.ServerSideEncryption, 'AES256');
      const key = String(params.Key);
      assert.deepEqual(params.Headers, { 'x-cos-forbid-overwrite': 'true' });
      if (saved.has(key)) throw { statusCode: 409, code: 'FileAlreadyExists' };
      const parts: Buffer[] = [];
      for await (const chunk of params.Body as AsyncIterable<Buffer>) parts.push(Buffer.from(chunk));
      const body = Buffer.concat(parts);
      assert.equal(body.length, params.ContentLength);
      saved.set(key, body);
      return {};
    },
    async headObject(params: Record<string, unknown>) {
      const body = saved.get(String(params.Key));
      if (!body) throw { statusCode: 404, code: 'NoSuchKey' };
      return { ETag: 'synthetic-etag', headers: { 'content-length': String(body.length) } };
    },
    async getObject(params: Record<string, unknown>) {
      assert.equal(params.IfMatch, 'synthetic-etag');
      return { Body: saved.get(String(params.Key)) };
    },
    async getBucketVersioning() { return { VersioningConfiguration: versioned ? { Status: 'Enabled' } : {} }; },
    async listObjectVersions(params: Record<string, unknown>) {
      return { Versions: (versions.get(String(params.Prefix)) ?? []).map(VersionId => ({ Key: params.Prefix, VersionId })),
        DeleteMarkers: [], IsTruncated: 'false' };
    },
    async deleteObject(params: Record<string, unknown>) {
      deleted.push(params);
      const key = String(params.Key);
      if (params.VersionId) {
        versions.set(key, (versions.get(key) ?? []).filter(id => id !== params.VersionId));
        if (!(versions.get(key)?.length)) saved.delete(key);
      } else saved.delete(key);
      return {};
    },
  };
  const store = archiveStoreFromEnv(env, client as unknown as COS);
  await store.ready();
  acl = 'public-read';
  await assert.rejects(store.ready(), /must be private/);
  acl = 'private';
  versioned = true;
  await assert.rejects(store.ready(), /requires bucket versioning disabled/);
  versioned = false;
  const body = Buffer.from('{"synthetic":true}\n');
  assert.equal(await store.read('log-archive/synthetic/missing.ndjson'), null);
  await store.uploadStreamIfAbsent('log-archive/synthetic/one.ndjson', Readable.from([body]), body.length, sha(body), 'synthetic-segment');
  assert.deepEqual(await store.read('log-archive/synthetic/one.ndjson'), body);
  assert.equal(uploads[0]?.['x-cos-meta-sha256'], sha(body));
  await assert.rejects(store.uploadDataIfAbsent('log-archive/synthetic/one.ndjson', body, sha(body), 'synthetic-segment'),
    error => (error as { statusCode: number }).statusCode === 409);
  await store.remove('log-archive/synthetic/one.ndjson');
  assert.equal(await store.read('log-archive/synthetic/one.ndjson'), null);
  assert.equal(deleted.at(-1)?.VersionId, undefined);
  versioned = true;
  saved.set('log-archive/synthetic/versioned.ndjson', body);
  versions.set('log-archive/synthetic/versioned.ndjson', ['v2', 'v1']);
  await store.remove('log-archive/synthetic/versioned.ndjson');
  assert.deepEqual(deleted.slice(-2).map(item => item.VersionId), ['v2', 'v1']);
  assert.equal(await store.read('log-archive/synthetic/versioned.ndjson'), null);
});

test('COS archive store rejects missing configuration', () => {
  assert.throws(() => archiveStoreFromEnv({ BB_STORAGE_PROVIDER: 'cos' }), /credentials/);
  assert.throws(() => archiveStoreFromEnv({ ...env, BB_COS_BUCKET: 'bad' }), /bucket or region/);
});
