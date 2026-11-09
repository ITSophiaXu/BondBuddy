import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

export const BLOB_RANGE_BYTES = 4 * 1024 * 1024;
export const BLOB_RANGE_CONCURRENCY = 4;
export type BlobRangeResponse = { body?: Readable; etag?: string; contentRange?: string; contentLength?: number };
export type BlobRangeDownload = (offset: number, count: number, etag: string, signal: AbortSignal) => Promise<BlobRangeResponse>;

export class BlobRangeReadError extends Error {}

/** A single reserved spool, fixed range slots, and a version from actual download responses.
 * No receipt may be returned until every byte of that version has been read and hashed. */
export async function readBlobRangesToFile(download: BlobRangeDownload, path: string, byteSize: number, etag: string) {
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0 || !etag) throw new BlobRangeReadError('Invalid stored object version');
  // An existing caller file is never removed if opening our private spool fails.
  const file = await open(path, 'wx', 0o600);
  const abort = new AbortController();
  const bodies = new Set<Readable>();
  let offset = 0;
  let failure: unknown;
  let closed = false;
  const worker = async () => {
    try {
      while (!abort.signal.aborted && offset < byteSize) {
        const start = offset, count = Math.min(BLOB_RANGE_BYTES, byteSize - start);
        offset += count;
        const response = await download(start, count, etag, abort.signal);
        const body = response.body;
        if (body) bodies.add(body);
        try {
          if (abort.signal.aborted) throw new BlobRangeReadError('Stored object read cancelled');
          if (!body || response.etag !== etag || response.contentLength !== count ||
              response.contentRange !== `bytes ${start}-${start + count - 1}/${byteSize}`)
            throw new BlobRangeReadError('Stored object range or version changed');
          let received = 0;
          for await (const chunk of body) {
            if (abort.signal.aborted) throw new BlobRangeReadError('Stored object read cancelled');
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (received + bytes.length > count) throw new BlobRangeReadError('Stored object range exceeded its declared length');
            let written = 0;
            while (written < bytes.length) {
              const result = await file.write(bytes, written, bytes.length - written, start + received + written);
              if (result.bytesWritten <= 0) throw new BlobRangeReadError('Stored object spool made no progress');
              written += result.bytesWritten;
            }
            received += bytes.length;
          }
          if (received !== count) throw new BlobRangeReadError('Stored object range was incomplete');
        } finally {
          if (body) { body.destroy(); await finished(body).catch(() => undefined); bodies.delete(body); }
        }
      }
    } catch (error) {
      if (failure === undefined) failure = error;
      abort.abort();
      for (const body of bodies) body.destroy();
      throw error;
    }
  };
  try {
    // Rejections trigger shared cancellation inside each worker. Settle all writes/streams
    // before closing or deleting the spool, including requests whose headers arrive late.
    await Promise.allSettled(Array.from({ length: Math.min(BLOB_RANGE_CONCURRENCY, Math.ceil(byteSize / BLOB_RANGE_BYTES)) }, worker));
    if (failure !== undefined) throw failure;
    if ((await file.stat()).size !== byteSize) throw new BlobRangeReadError('Stored object spool size changed');
    await file.close(); closed = true;
    const hash = createHash('sha256');
    let hashed = 0;
    for await (const chunk of createReadStream(path)) {
      hashed += chunk.length;
      if (hashed > byteSize) throw new BlobRangeReadError('Stored object spool grew during verification');
      hash.update(chunk);
    }
    if (hashed !== byteSize) throw new BlobRangeReadError('Stored object spool was incomplete');
    return { byteSize: hashed, sha256: hash.digest('hex'), etag };
  } catch (error) {
    if (!closed) await file.close();
    await rm(path, { force: true });
    throw error;
  }
}
