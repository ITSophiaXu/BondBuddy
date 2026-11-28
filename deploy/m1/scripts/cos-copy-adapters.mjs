import { Readable } from 'node:stream';
import { BlobServiceClient } from '@azure/storage-blob';
import COS from 'cos-nodejs-sdk-v5';

const missing = error => error?.code === 'NoSuchKey' || error?.statusCode === 404 && error?.code !== 'NoSuchBucket';

export function azureCurrentSource(connectionString, containerName) {
  if (!connectionString || !containerName) throw new Error('Azure source connection and container required');
  const container = BlobServiceClient.fromConnectionString(connectionString).getContainerClient(containerName);
  return {
    async *list() {
      for await (const item of container.listBlobsFlat()) {
        const properties = await container.getBlobClient(item.name).getProperties();
        if (!properties.etag || !Number.isSafeInteger(properties.contentLength) || !properties.contentType)
          throw new Error('Azure source object properties incomplete');
        yield { key: item.name, etag: properties.etag, bytes: properties.contentLength,
          contentType: properties.contentType, accessTier: properties.accessTier ?? null };
      }
    },
    async open(key, etag) {
      const response = await container.getBlobClient(key).download(0, undefined, { conditions: { ifMatch: etag } });
      return response.readableStreamBody || Readable.from([]);
    },
  };
}

export function cosMigrationTarget({ secretId, secretKey, bucket, region, client: injected }) {
  if (!secretId || !secretKey || !bucket || !region) throw new Error('COS target credentials, bucket and region required');
  if (!/^[a-z0-9][a-z0-9-]*-[0-9]+$/.test(bucket) || !/^[a-z][a-z0-9-]+$/.test(region))
    throw new Error('Invalid COS migration bucket or region');
  const client = injected || new COS({ SecretId: secretId, SecretKey: secretKey });
  const object = key => ({ Bucket: bucket, Region: region, Key: key });
  return {
    bucket,
    async ready() {
      await client.headBucket({ Bucket: bucket, Region: region });
      const versioning = await client.getBucketVersioning({ Bucket: bucket, Region: region });
      if (versioning.VersioningConfiguration?.Status)
        throw new Error('COS create-only migration upload requires bucket versioning disabled');
    },
    async head(key) {
      try {
        const result = await client.headObject(object(key));
        const raw = Object.entries(result.headers || {}).find(([name]) => name.toLowerCase() === 'content-length')?.[1];
        const bytes = Number(raw);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || !result.ETag) throw new Error('COS object identity incomplete');
        return { bytes, etag: result.ETag };
      } catch (error) { if (missing(error)) return null; throw error; }
    },
    async put(key, body, bytes, contentType, options = {}) {
      await client.putObject({ ...object(key), Body: body, ContentLength: bytes, ContentType: contentType,
        ...(options.createOnly ? { Headers: { 'x-cos-forbid-overwrite': 'true' } } : {}) });
    },
    async open(key) {
      const state = await this.head(key);
      if (!state) throw new Error('COS object missing during readback');
      return client.getObjectStream({ ...object(key), IfMatch: state.etag });
    },
  };
}
