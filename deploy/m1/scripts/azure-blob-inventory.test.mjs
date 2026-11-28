import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inventoryAzureBlobs } from './azure-blob-inventory.mjs';

const item = (name, bytes, accessTier, extra = {}) => ({ name, deleted: false, snapshot: '',
  properties: { contentLength: bytes, accessTier }, ...extra });

test('Azure inventory separates current bytes, Archive tier, versions, snapshots and soft deletes', async () => {
  let listCalls = 0;
  const service = {
    async *listContainers() { yield { name: 'private' }; },
    getContainerClient(name) {
      assert.equal(name, 'private');
      return { async *listBlobsFlat(options) {
        listCalls++;
        assert.deepEqual(options, { includeVersions: true, includeSnapshots: true,
          includeDeleted: true, includeDeletedWithVersions: true });
        yield item('a', 100, 'Hot');
        yield item('b', 200, 'Archive');
        yield item('a', 80, 'Hot', { versionId: 'old', isCurrentVersion: false });
        yield item('a', 60, 'Hot', { snapshot: 'snap' });
        yield item('b', 0, 'Archive', { deleted: true });
        yield item('c', 0, 'unknown', { hasVersionsOnly: true });
      } };
    },
  };
  const report = await inventoryAzureBlobs(service);
  assert.equal(listCalls, 1);
  assert.equal(report.scope, 'account_containers');
  assert.equal(report.containerCount, 1);
  const row = report.containers[0];
  assert.deepEqual(row.current, { objects: 2, bytes: 300 });
  assert.deepEqual(row.currentByAccessTier.Archive, { objects: 1, bytes: 200 });
  assert.deepEqual(row.historicalVersions, { objects: 1, bytes: 80 });
  assert.deepEqual(row.snapshots, { objects: 1, bytes: 60 });
  assert.deepEqual(row.softDeleted, { objects: 1, bytes: 0 });
  assert.deepEqual(row.versionsOnlyMarkers, { objects: 1, bytes: 0 });
  assert.equal(row.largestCurrentObjectBytes, 200);
  assert.ok(!JSON.stringify(report).includes('"name":"a"'), 'object keys must not be reported');
});

test('explicit container scope is labeled and invalid names fail closed', async () => {
  const service = { getContainerClient: () => ({ async *listBlobsFlat() {} }) };
  const report = await inventoryAzureBlobs(service, ['private']);
  assert.equal(report.scope, 'explicit_containers_only');
  await assert.rejects(() => inventoryAzureBlobs(service, ['private', 'private']), /Invalid explicit/);
  await assert.rejects(() => inventoryAzureBlobs(service, ['../other']), /Invalid explicit/);
});
