import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import COS from 'cos-nodejs-sdk-v5';
import { Problem, type BlobDigest, type PrivateBlobs } from './data.js';
import { deleteCosObjectPermanently } from './cos-permanent-delete.js';

const CHUNK_BYTES = 4 * 1024 * 1024;

function missingObject(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: string; statusCode?: number };
  return value.code === 'NoSuchKey' || (value.statusCode === 404 && value.code !== 'NoSuchBucket');
}

function lengthFrom(headers: Record<string, unknown> | undefined): number {
  const raw = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'content-length')?.[1];
  const bytes = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Problem(503, 'DATA_UNAVAILABLE', 'Stored object length is unavailable');
  return bytes;
}

function bounded(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Problem(422, 'VALIDATION_FAILED', 'Invalid object read limit');
}

/**
 * COS implementation of the common private-object operations. COS DELETE does not
 * expose the Azure If-Match precondition in the installed SDK, so deleteIfMatch is
 * deliberately absent. Callers requiring conditional deletion fail closed.
 * Direct browser upload signing is likewise left disabled until real COS/CORS tests.
 */
export function cosBlobs(client: COS, bucket: string, region: string): PrivateBlobs {
  if (!bucket || !region) throw new Error('COS bucket and region required');
  const object = (key: string) => ({ Bucket: bucket, Region: region, Key: key });
  const head = async (key: string): Promise<{ etag: string; byteSize: number } | null> => {
    try {
      const result = await client.headObject(object(key));
      if (!result.ETag) throw new Problem(503, 'DATA_UNAVAILABLE', 'Stored object version is unavailable');
      return { etag: result.ETag, byteSize: lengthFrom(result.headers) };
    } catch (error) {
      if (missingObject(error)) return null;
      throw error;
    }
  };
  const pinnedStream = (key: string, etag: string, signal?: AbortSignal): Readable => {
    const stream = client.getObjectStream({ ...object(key), IfMatch: etag }) as Readable;
    if (signal) {
      const abort = () => stream.destroy(new Error('Object read aborted'));
      if (signal.aborted) abort();
      else {
        signal.addEventListener('abort', abort, { once: true });
        stream.once('close', () => signal.removeEventListener('abort', abort));
      }
    }
    return stream;
  };
  const consume = async (key: string, maxBytes: number, path: string | null): Promise<{ bytes?: Buffer; digest: BlobDigest } | null> => {
    bounded(maxBytes);
    const version = await head(key);
    if (!version) return null;
    if (version.byteSize > maxBytes) throw new Problem(413, 'DATA_UNAVAILABLE', 'Stored object exceeds the bounded read limit');
    const body = pinnedStream(key, version.etag);
    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    let byteSize = 0;
    try {
      if (path) {
        const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          byteSize += chunk.length;
          if (byteSize > maxBytes) return callback(new Problem(413, 'DATA_UNAVAILABLE', 'Stored object exceeds the bounded read limit'));
          hash.update(chunk);
          callback(null, chunk);
        } });
        await pipeline(body, meter, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
      } else {
        for await (const chunk of body) {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          byteSize += value.length;
          if (byteSize > maxBytes) throw new Problem(413, 'DATA_UNAVAILABLE', 'Stored object exceeds the bounded read limit');
          hash.update(value);
          chunks.push(value);
        }
      }
      if (byteSize !== version.byteSize)
        throw new Problem(503, 'DATA_UNAVAILABLE', 'Stored object size changed during bounded read');
      return { ...(path ? {} : { bytes: Buffer.concat(chunks, byteSize) }),
        digest: { byteSize, sha256: hash.digest('hex'), etag: version.etag } };
    } catch (error) {
      body.destroy();
      if (path) await rm(path, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  return {
    async put(key, bytes, mediaType) {
      await client.putObject({ ...object(key), Body: bytes, ContentLength: bytes.length, ContentType: mediaType,
        ServerSideEncryption: 'AES256' });
    },
    async get(key) { return (await client.getObject(object(key))).Body; },
    async getIfExists(key) {
      try { return (await client.getObject(object(key))).Body; }
      catch (error) { if (missingObject(error)) return null; throw error; }
    },
    async getIfExistsBounded(key, maxBytes) { return (await consume(key, maxBytes, null))?.bytes ?? null; },
    async exists(key) { return (await head(key)) !== null; },
    headVersion: head,
    async delete(key) { await deleteCosObjectPermanently(client, bucket, region, key); },
    async listPage(prefix, continuation, pageSize) {
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000)
        throw new Problem(422, 'VALIDATION_FAILED', 'Invalid object listing page size');
      const result = await client.getBucket({ Bucket: bucket, Region: region, Prefix: prefix,
        ...(continuation ? { Marker: continuation } : {}), MaxKeys: pageSize });
      const items = (result.Contents ?? []).map(item => {
        const bytes = Number(item.Size);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || !item.ETag)
          throw new Problem(503, 'DATA_UNAVAILABLE', 'Stored object listing is incomplete');
        const date = new Date(item.LastModified);
        return { key: item.Key, bytes, etag: item.ETag,
          ...(Number.isNaN(date.getTime()) ? {} : { lastModified: date }) };
      });
      const next = result.IsTruncated === 'true' ? result.NextMarker || items.at(-1)?.key : undefined;
      if (result.IsTruncated === 'true' && (!next || next === continuation))
        throw new Problem(503, 'DATA_UNAVAILABLE', 'Object listing cursor did not advance');
      return { items, continuation: next };
    },
    async putFile(key, path, mediaType) {
      await client.sliceUploadFile({ ...object(key), FilePath: path, ContentType: mediaType,
        ServerSideEncryption: 'AES256',
        ChunkSize: CHUNK_BYTES, SliceSize: CHUNK_BYTES });
    },
    async readToFile(key, path, maxBytes) { return (await consume(key, maxBytes, path))?.digest ?? null; },
    async openRead(key, signal) {
      const version = await head(key);
      if (!version) return null;
      return { body: pinnedStream(key, version.etag, signal), contentLength: version.byteSize };
    },
  };
}
