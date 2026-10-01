import { createHash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { digest, Problem, uid, type PrivateBlobs } from './data.js';
import { recordStructuredError } from './observability.js';

// Material bytes are streamed from Blob to the client with backpressure; the sha256 is computed
// on the way. The last chunk is held back until the digest matches, so a corrupted object never
// completes a download: the stream is aborted (Content-Length is short) and an error is recorded.
type StoredMaterial = { id: string; project_id: string; owner_user_id: string; filename: string; media_type: string; byte_size: string | number; sha256: string; object_key: string };

export function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\%;]/g, '_') || 'material';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

const integrityFailure = () => new Problem(503, 'DATA_UNAVAILABLE', 'Stored material failed integrity check');

async function recordIntegrityAlert(db: Pool, m: StoredMaterial, reason: 'material_integrity_mismatch' | 'material_size_mismatch'): Promise<void> {
  try {
    await recordStructuredError(db, { owner: m.owner_user_id, projectId: m.project_id, traceId: uid(), code: 'DATA_UNAVAILABLE', category: 'internal', stage: 'material_download', safeMessageCode: reason });
  } catch { /* The download still fails closed when the alert cannot be written. */ }
}

/** Verify while streaming: hold back the final chunk until size and sha256 match. */
export function verifyingStream(expectedSha256: string, expectedBytes: number, onMismatch: () => Promise<void>): Transform {
  const hash = createHash('sha256');
  let held: Buffer | null = null;
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > expectedBytes) { void onMismatch(); return done(integrityFailure()); }
      hash.update(chunk);
      const previous = held;
      held = chunk;
      done(null, previous ?? undefined);
    },
    flush(done) {
      if (seen !== expectedBytes || hash.digest('hex') !== expectedSha256) {
        onMismatch().finally(() => done(integrityFailure()));
        return;
      }
      done(null, held ?? undefined);
    }
  });
}

export async function sendMaterial(reply: FastifyReply, db: Pool, blobs: PrivateBlobs, m: StoredMaterial): Promise<FastifyReply> {
  const expectedSha = m.sha256.trim(), expectedBytes = Number(m.byte_size);
  reply.header('content-type', m.media_type).header('x-content-type-options', 'nosniff').header('cache-control', 'private, no-store').header('content-disposition', contentDisposition(m.filename));
  if (!blobs.openRead) {
    const bytes = await blobs.get(m.object_key);
    if (digest(bytes) !== expectedSha) { await recordIntegrityAlert(db, m, 'material_integrity_mismatch'); throw integrityFailure(); }
    return reply.send(bytes);
  }
  let opened: { body: Readable; contentLength: number | undefined } | null;
  try { opened = await blobs.openRead(m.object_key); }
  catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(503, 'DATA_UNAVAILABLE', 'Material storage is temporarily unavailable');
  }
  if (!opened) throw new Problem(503, 'DATA_UNAVAILABLE', 'Material storage is temporarily unavailable');
  if (opened.contentLength !== undefined && opened.contentLength !== expectedBytes) {
    opened.body.destroy();
    await recordIntegrityAlert(db, m, 'material_size_mismatch');
    throw integrityFailure();
  }
  const verified = verifyingStream(expectedSha, expectedBytes, () => recordIntegrityAlert(db, m, 'material_integrity_mismatch'));
  opened.body.once('error', error => verified.destroy(error));
  verified.once('close', () => { if (!opened.body.destroyed) opened.body.destroy(); });
  return reply.header('content-length', String(expectedBytes)).send(opened.body.pipe(verified));
}
