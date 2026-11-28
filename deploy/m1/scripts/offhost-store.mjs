import { createReadStream, statSync } from 'node:fs';
import { BlobServiceClient } from '@azure/storage-blob';
import COS from 'cos-nodejs-sdk-v5';

const missing = error => error?.code === 'NoSuchKey' || error?.statusCode === 404 && error?.code !== 'NoSuchBucket';

/** Small storage boundary for the off-host backup manifest and its files. */
export function offhostStore(env = process.env, options = {}) {
  const provider = env.BB_STORAGE_PROVIDER || 'azure';
  if (provider === 'azure') {
    if (!env.AZURE_STORAGE_CONNECTION_STRING) throw new Error('AZURE_STORAGE_CONNECTION_STRING required');
    const container = BlobServiceClient.fromConnectionString(env.AZURE_STORAGE_CONNECTION_STRING)
      .getContainerClient(env.BB_BACKUP_CONTAINER || 'bb-backups');
    return {
      async ready() { await container.createIfNotExists(); },
      exists: key => container.getBlobClient(key).exists(),
      async uploadFile(key, file, sha256) {
        await container.getBlockBlobClient(key).uploadFile(file, { blockSize: 4 * 1024 * 1024,
          concurrency: 1, metadata: { sha256 } });
      },
      async uploadData(key, data) {
        await container.getBlockBlobClient(key).uploadData(data, { blobHTTPHeaders: { blobContentType: 'application/json' } });
      },
      async readStream(key) {
        const response = await container.getBlobClient(key).download();
        if (!response.readableStreamBody) throw new Error(`no download stream for ${key}`);
        return response.readableStreamBody;
      },
      readBuffer: key => container.getBlobClient(key).downloadToBuffer(),
    };
  }
  if (provider !== 'cos') throw new Error('BB_STORAGE_PROVIDER must be azure or cos');
  const id = env.BB_COS_BACKUP_SECRET_ID || env.BB_COS_SECRET_ID;
  const secret = env.BB_COS_BACKUP_SECRET_KEY || env.BB_COS_SECRET_KEY;
  const bucket = env.BB_COS_BACKUP_BUCKET;
  const region = env.BB_COS_BACKUP_REGION || env.BB_COS_REGION;
  if (!id || !secret || !bucket || !region) throw new Error('COS off-host backup credentials, bucket and region required');
  if (Boolean(env.BB_COS_BACKUP_SECRET_ID) !== Boolean(env.BB_COS_BACKUP_SECRET_KEY))
    throw new Error('COS backup credential pair is incomplete');
  if (!/^[a-z0-9][a-z0-9-]*-[0-9]+$/.test(bucket) || !/^[a-z][a-z0-9-]+$/.test(region))
    throw new Error('Invalid COS backup bucket or region');
  if (bucket === env.BB_COS_BUCKET) throw new Error('COS off-host backup requires a separate bucket');
  const client = options.cosClient || new COS({ SecretId: id, SecretKey: secret });
  const object = key => ({ Bucket: bucket, Region: region, Key: key });
  return {
    async ready() { await client.headBucket({ Bucket: bucket, Region: region }); },
    async exists(key) {
      try { await client.headObject(object(key)); return true; }
      catch (error) { if (missing(error)) return false; throw error; }
    },
    async uploadFile(key, file, sha256) {
      await client.putObject({ ...object(key), Body: createReadStream(file), ContentLength: statSync(file).size,
        ServerSideEncryption: 'AES256',
        'x-cos-meta-sha256': sha256 });
    },
    async uploadData(key, data) {
      await client.putObject({ ...object(key), Body: data, ContentLength: data.length, ContentType: 'application/json',
        ServerSideEncryption: 'AES256' });
    },
    async readStream(key) { return client.getObjectStream(object(key)); },
    async readBuffer(key) { return (await client.getObject(object(key))).Body; },
  };
}
