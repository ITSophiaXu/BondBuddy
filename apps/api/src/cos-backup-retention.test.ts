import assert from 'node:assert/strict';
import { test } from 'node:test';
import type COS from 'cos-nodejs-sdk-v5';
import { pruneCosOffhostBackups } from './cos-backup-retention.js';

const env = { BB_STORAGE_PROVIDER: 'cos', BB_COS_SECRET_ID: 'synthetic-id', BB_COS_SECRET_KEY: 'synthetic-key',
  BB_COS_BUCKET: 'synthetic-app-1250000000', BB_COS_BACKUP_BUCKET: 'synthetic-backup-1250000000',
  BB_COS_REGION: 'ap-beijing' };

test('COS backup retention keeps newest and removes old data before its manifest', async () => {
  const keys = new Set([
    '20261001T000000Z-old/db.dump', '20261001T000000Z-old/offhost-manifest.json',
    '20261127T000000Z-new/db.dump', '20261127T000000Z-new/offhost-manifest.json',
  ]);
  const removed: string[] = [];
  const client = {
    async headBucket() { return {}; },
    async getBucketAcl() { return { ACL: 'private' }; },
    async getBucketVersioning() { return { VersioningConfiguration: {} }; },
    async getBucket() { return { Contents: [...keys].map(Key => ({ Key })), IsTruncated: 'false' }; },
    async deleteObject({ Key }: { Key: string }) { removed.push(Key); keys.delete(Key); return {}; },
    async headObject({ Key }: { Key: string }) {
      if (!keys.has(Key)) throw { statusCode: 404, code: 'NoSuchKey' };
      return {};
    },
  };
  const result = await pruneCosOffhostBackups(env, 30, new Date('2026-11-28T00:00:00Z'), client as unknown as COS);
  assert.deepEqual(result, { backups: 2, deleted: 1, deletedBlobs: 2, kept: 1, failed: 0 });
  assert.deepEqual(removed, ['20261001T000000Z-old/db.dump', '20261001T000000Z-old/offhost-manifest.json']);
  assert.equal(keys.size, 2);
});

test('COS backup retention refuses public or shared buckets', async () => {
  await assert.rejects(pruneCosOffhostBackups({ ...env, BB_COS_BACKUP_BUCKET: env.BB_COS_BUCKET }, 30), /Separate COS backup/);
  const client = { async headBucket() { return {}; }, async getBucketAcl() { return { ACL: 'public-read' }; } };
  await assert.rejects(pruneCosOffhostBackups(env, 30, new Date(), client as unknown as COS), /must be private/);
});

test('COS backup retention includes hidden versions and delete markers', async () => {
  const old = '20261001T000000Z-old/db.dump';
  const newer = '20261127T000000Z-new/db.dump';
  const oldManifest = '20261001T000000Z-old/offhost-manifest.json';
  const newManifest = '20261127T000000Z-new/offhost-manifest.json';
  const versions = new Map([[old, new Set(['v2', 'v1'])], [oldManifest, new Set(['m1'])],
    [newer, new Set(['v3'])], [newManifest, new Set(['m2'])]]);
  const removed: string[] = [];
  const client = {
    async headBucket() { return {}; },
    async getBucketAcl() { return { ACL: 'private' }; },
    async getBucketVersioning() { return { VersioningConfiguration: { Status: 'Enabled' } }; },
    async listObjectVersions({ Prefix }: { Prefix?: string }) {
      const entries = Prefix ? [[Prefix, versions.get(Prefix) ?? new Set<string>()] as const] : [...versions];
      return { Versions: entries.flatMap(([Key, ids]) => [...ids].map(VersionId => ({ Key, VersionId }))),
        DeleteMarkers: [], IsTruncated: 'false' };
    },
    async deleteObject({ Key, VersionId }: { Key: string; VersionId: string }) {
      removed.push(`${Key}:${VersionId}`); versions.get(Key)?.delete(VersionId); return {};
    },
    async headObject({ Key }: { Key: string }) {
      if (!versions.get(Key)?.size) throw { statusCode: 404, code: 'NoSuchKey' };
      return {};
    },
  };
  const result = await pruneCosOffhostBackups(env, 30, new Date('2026-11-28T00:00:00Z'), client as unknown as COS);
  assert.deepEqual(result, { backups: 2, deleted: 1, deletedBlobs: 2, kept: 1, failed: 0 });
  assert.deepEqual(removed, [`${old}:v2`, `${old}:v1`, `${oldManifest}:m1`]);
  assert.deepEqual([...versions.get(newer)!], ['v3']);
});

test('COS backup retention keeps the last complete backup when a newer upload is incomplete', async () => {
  const complete = '20261001T000000Z-complete', incomplete = '20261127T000000Z-incomplete';
  const keys = new Set([`${complete}/db.dump`, `${complete}/offhost-manifest.json`, `${incomplete}/db.dump`]);
  const client = {
    async headBucket() { return {}; },
    async getBucketAcl() { return { ACL: 'private' }; },
    async getBucketVersioning() { return { VersioningConfiguration: {} }; },
    async getBucket() { return { Contents: [...keys].map(Key => ({ Key })), IsTruncated: 'false' }; },
    async headObject({ Key }: { Key: string }) {
      if (!keys.has(Key)) throw { statusCode: 404, code: 'NoSuchKey' }; return {};
    },
    async deleteObject({ Key }: { Key: string }) { keys.delete(Key); return {}; },
  };
  const result = await pruneCosOffhostBackups(env, 30, new Date('2026-11-28T00:00:00Z'), client as unknown as COS);
  assert.deepEqual(result, { backups: 2, deleted: 0, deletedBlobs: 0, kept: 2, failed: 0 });
  assert.ok(keys.has(`${complete}/offhost-manifest.json`));
});
