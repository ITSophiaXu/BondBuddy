import assert from 'node:assert/strict';
import test from 'node:test';
import { privateBlobsFromEnv, storageProviderFromEnv } from './storage-provider.js';

test('Azure remains the default and an unconfigured store is absent', () => {
  assert.equal(storageProviderFromEnv({}), 'azure');
  assert.equal(privateBlobsFromEnv({}), null);
  assert.ok(privateBlobsFromEnv({ AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true' }));
});

test('COS requires complete settings and never falls back to Azure', () => {
  const azure = { AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true' };
  assert.throws(() => privateBlobsFromEnv({ ...azure, BB_STORAGE_PROVIDER: 'cos' }), /COS storage requires/);
  assert.throws(() => storageProviderFromEnv({ BB_STORAGE_PROVIDER: 'unknown' }), /BB_STORAGE_PROVIDER/);
  const cos = { ...azure, BB_STORAGE_PROVIDER: 'cos', BB_COS_SECRET_ID: 'synthetic-id',
    BB_COS_SECRET_KEY: 'synthetic-key', BB_COS_BUCKET: 'test-123', BB_COS_REGION: 'ap-beijing' };
  const store = privateBlobsFromEnv(cos);
  assert.ok(store?.headVersion);
  assert.equal(store?.deleteIfMatch, undefined);
  assert.equal(store?.createUploadUrl, undefined);
  assert.throws(() => privateBlobsFromEnv({ ...cos, BB_DIRECT_BLOB_UPLOADS: '1' }), /direct browser upload/);
  assert.throws(() => privateBlobsFromEnv({ ...cos, BB_COS_BUCKET: 'bad' }), /Invalid COS bucket/);
});
