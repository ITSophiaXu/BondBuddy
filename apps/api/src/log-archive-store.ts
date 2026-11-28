import type { Readable } from 'node:stream';
import { BlobServiceClient } from '@azure/storage-blob';
import COS from 'cos-nodejs-sdk-v5';
import { storageProviderFromEnv } from './storage-provider.js';
import { deleteCosObjectPermanently } from './cos-permanent-delete.js';

const MAX_ARCHIVE_BYTES = 70 * 1024 * 1024;
export type ArchiveStore = {
  ready(): Promise<void>;
  read(key: string): Promise<Buffer | null>;
  uploadStreamIfAbsent(key: string, body: Readable, length: number, sha256: string, segmentId: string): Promise<void>;
  uploadDataIfAbsent(key: string, body: Buffer, sha256: string, segmentId: string): Promise<void>;
  remove(key: string): Promise<void>;
};

function missing(error: unknown) {
  const e = error as { code?: string; statusCode?: number } | null;
  return e?.code === 'NoSuchKey' || (e?.statusCode === 404 && e.code !== 'NoSuchBucket');
}

export function archiveStoreFromEnv(env: NodeJS.ProcessEnv = process.env, cosClient?: COS): ArchiveStore {
  if (storageProviderFromEnv(env) === 'azure') {
    if (!env.AZURE_STORAGE_CONNECTION_STRING) throw new Error('Azure archive connection required');
    const container = BlobServiceClient.fromConnectionString(env.AZURE_STORAGE_CONNECTION_STRING)
      .getContainerClient(env.BB_LOG_ARCHIVE_CONTAINER || 'bondbuddy-private');
    return {
      async ready() {
        if ((await container.getProperties()).blobPublicAccess) throw new Error('Log archive container must be private');
      },
      async read(key) {
        try {
          const response = await container.getBlobClient(key).download();
          if (!response.readableStreamBody || response.contentLength === undefined || response.contentLength > MAX_ARCHIVE_BYTES)
            throw new Error('Archive download exceeds bound');
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of response.readableStreamBody) {
            const part = Buffer.from(chunk); size += part.length;
            if (size > MAX_ARCHIVE_BYTES) throw new Error('Archive download exceeds bound');
            chunks.push(part);
          }
          if (size !== response.contentLength) throw new Error('Archive download length changed');
          return Buffer.concat(chunks, size);
        } catch (error) { if ((error as { statusCode?: number }).statusCode === 404) return null; throw error; }
      },
      async uploadStreamIfAbsent(key, body, _length, sha256, segmentId) {
        await container.getBlockBlobClient(key).uploadStream(body, 1024 * 1024, 1, { conditions: { ifNoneMatch: '*' },
          blobHTTPHeaders: { blobContentType: 'application/x-ndjson' }, metadata: { sha256, segmentid: segmentId } });
      },
      async uploadDataIfAbsent(key, body, sha256, segmentId) {
        await container.getBlockBlobClient(key).uploadData(body, { conditions: { ifNoneMatch: '*' },
          blobHTTPHeaders: { blobContentType: 'application/x-ndjson' }, metadata: { sha256, segmentid: segmentId } });
      },
      async remove(key) { await container.getBlobClient(key).deleteIfExists({ deleteSnapshots: 'include' }); },
    };
  }
  const id = env.BB_COS_SECRET_ID, secret = env.BB_COS_SECRET_KEY;
  const bucket = env.BB_COS_BUCKET, region = env.BB_COS_REGION;
  if (!id || !secret || !bucket || !region) throw new Error('COS archive credentials, bucket and region required');
  if (!/^[a-z0-9][a-z0-9-]*-[0-9]+$/.test(bucket) || !/^[a-z][a-z0-9-]+$/.test(region))
    throw new Error('Invalid COS archive bucket or region');
  const client = cosClient ?? new COS({ SecretId: id, SecretKey: secret });
  const object = (key: string) => ({ Bucket: bucket, Region: region, Key: key });
  const put = async (key: string, body: Buffer | Readable, length: number, sha256: string, segmentId: string) => {
    await client.putObject({ ...object(key), Body: body, ContentLength: length, ContentType: 'application/x-ndjson',
      Headers: { 'If-None-Match': '*' }, 'x-cos-meta-sha256': sha256, 'x-cos-meta-segmentid': segmentId });
  };
  return {
    async ready() {
      await client.headBucket({ Bucket: bucket, Region: region });
      const acl = await client.getBucketAcl({ Bucket: bucket, Region: region });
      if (acl.ACL !== 'private') throw new Error('Log archive bucket must be private');
    },
    async read(key) {
      try {
        const head = await client.headObject(object(key));
        const length = Number(Object.entries(head.headers ?? {}).find(([name]) => name.toLowerCase() === 'content-length')?.[1]);
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ARCHIVE_BYTES || !head.ETag)
          throw new Error('Archive download length or version unavailable');
        const response = await client.getObject({ ...object(key), IfMatch: head.ETag });
        if (!Buffer.isBuffer(response.Body) || response.Body.length !== length)
          throw new Error('Archive download length changed');
        return response.Body;
      } catch (error) { if (missing(error)) return null; throw error; }
    },
    async uploadStreamIfAbsent(key, body, length, sha256, segmentId) {
      await put(key, body, length, sha256, segmentId);
    },
    async uploadDataIfAbsent(key, body, sha256, segmentId) {
      await put(key, body, body.length, sha256, segmentId);
    },
    async remove(key) { await deleteCosObjectPermanently(client, bucket, region, key); },
  };
}
