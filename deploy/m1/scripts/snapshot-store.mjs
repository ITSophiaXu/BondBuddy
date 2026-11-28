import { createReadStream, statSync } from 'node:fs';
import { BlobServiceClient } from '@azure/storage-blob';
import COS from 'cos-nodejs-sdk-v5';

/** Container-shaped boundary for current application objects in a recovery snapshot. */
export function snapshotStore(env = process.env, options = {}) {
  const provider = env.BB_STORAGE_PROVIDER || 'azure';
  if (provider === 'azure') {
    if (!env.AZURE_STORAGE_CONNECTION_STRING) throw new Error('AZURE_STORAGE_CONNECTION_STRING required');
    const service = BlobServiceClient.fromConnectionString(env.AZURE_STORAGE_CONNECTION_STRING);
    return name => {
      const container = service.getContainerClient(name);
      return {
        exists: () => container.exists(),
        ready: () => container.createIfNotExists(),
        async *list() {
          for await (const blob of container.listBlobsFlat())
            yield { key: blob.name, contentType: blob.properties.contentType ?? null };
        },
        async readStream(key) {
          const response = await container.getBlobClient(key).download();
          if (!response.readableStreamBody) throw new Error(`no download stream for ${name}/${key}`);
          return response.readableStreamBody;
        },
        async putFile(key, file, contentType) {
          await container.getBlockBlobClient(key).uploadFile(file, { blockSize: 4 * 1024 * 1024,
            concurrency: 1, blobHTTPHeaders: contentType ? { blobContentType: contentType } : undefined });
        },
      };
    };
  }
  if (provider !== 'cos') throw new Error('BB_STORAGE_PROVIDER must be azure or cos');
  const id = env.BB_COS_SECRET_ID, secret = env.BB_COS_SECRET_KEY;
  const bucket = env.BB_COS_BUCKET, region = env.BB_COS_REGION;
  const primary = env.BB_STORAGE_CONTAINER || 'bondbuddy-private';
  if (!id || !secret || !bucket || !region) throw new Error('COS application snapshot credentials, bucket and region required');
  if (!/^[a-z0-9][a-z0-9-]*-[0-9]+$/.test(bucket) || !/^[a-z][a-z0-9-]+$/.test(region))
    throw new Error('Invalid COS application bucket or region');
  const client = options.cosClient || new COS({ SecretId: id, SecretKey: secret });
  const object = key => ({ Bucket: bucket, Region: region, Key: key });
  return name => {
    if (name !== primary) throw new Error(`No COS bucket mapping for application container ${name}`);
    return {
      async exists() {
        try { await client.headBucket({ Bucket: bucket, Region: region }); return true; }
        catch (error) { if (error?.statusCode === 404) return false; throw error; }
      },
      async ready() { await client.headBucket({ Bucket: bucket, Region: region }); },
      async *list() {
        let marker;
        do {
          const page = await client.getBucket({ Bucket: bucket, Region: region, MaxKeys: 1000,
            ...(marker ? { Marker: marker } : {}) });
          const items = page.Contents || [];
          for (const item of items) {
            const head = await client.headObject(object(item.Key));
            const contentType = Object.entries(head.headers || {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
            yield { key: item.Key, contentType: typeof contentType === 'string' ? contentType : null,
              etag: item.ETag };
          }
          const next = page.IsTruncated === 'true' ? page.NextMarker || items.at(-1)?.Key : undefined;
          if (page.IsTruncated === 'true' && (!next || next === marker)) throw new Error('COS snapshot cursor did not advance');
          marker = next;
        } while (marker);
      },
      async readStream(key, etag) { return client.getObjectStream({ ...object(key), ...(etag ? { IfMatch: etag } : {}) }); },
      async putFile(key, file, contentType) {
        await client.putObject({ ...object(key), Body: createReadStream(file), ContentLength: statSync(file).size,
          ServerSideEncryption: 'AES256',
          ...(contentType ? { ContentType: contentType } : {}) });
      },
    };
  };
}
