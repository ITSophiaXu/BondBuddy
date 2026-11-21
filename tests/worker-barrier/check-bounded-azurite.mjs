import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {BlobServiceClient} from '@azure/storage-blob';
import {azureBlobs} from '../../apps/api/dist/data.js';
import {boundedPrivateBlobs} from '../../apps/worker/dist/bounded-private-blobs.js';

// Explicit opt-in integration command, never part of the environment-free unit suite.
const connectionString=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
assert.ok(connectionString?.startsWith('UseDevelopmentStorage=true;'),'A local synthetic Azurite connection is required');
const containerName='bb-bounded-io-'+randomUUID();
const container=BlobServiceClient.fromConnectionString(connectionString).getContainerClient(containerName);
const blobs=boundedPrivateBlobs(azureBlobs(connectionString,containerName),{connectionString,containerName,timeoutMs:15000});
const bytes=Buffer.from('Synthetic bounded storage SDK readback');
try{
  await blobs.put('fixture.txt',bytes,'text/plain');
  assert.deepEqual(await blobs.getIfExistsBounded('fixture.txt',bytes.length),bytes);
  assert.equal(await blobs.getIfExistsBounded('absent.txt',bytes.length),null);
  await assert.rejects(blobs.getIfExistsBounded('fixture.txt',bytes.length-1),/STORAGE_IO_FAILED/);
  process.stdout.write('Bounded Azure SDK child: put, hash-equivalent readback, missing object and size rejection passed.\n');
}finally{
  await container.deleteIfExists();
}
