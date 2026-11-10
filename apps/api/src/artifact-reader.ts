import { createReadStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, Problem, uid, type PrivateBlobs } from './data.js';
import { DOCX_LIMITS, WORD_MEDIA_TYPE } from './docx-inspector.js';
import { BLOB_RANGE_BYTES } from './blob-range-reader.js';
import { reserveSpool, spoolDirectory } from './upload-spool.js';

type StoredArtifact = { media_type: string; object_key: string; sha256: string; delivery_evidence_byte_size?: unknown };
const integrityFailure = () => new Problem(503, 'DATA_UNAVAILABLE', 'Artifact integrity check failed');
const MAX_ACTIVE_READS = 2;
let activeReads = 0;

/** A cold read still verifies every byte before advertising or delivering an artifact. */
export async function readVerifiedArtifact(blobs: PrivateBlobs, artifact: StoredArtifact): Promise<Buffer> {
  const bounded = artifact.media_type === WORD_MEDIA_TYPE || artifact.media_type === 'application/pdf';
  const expectedSize = Number(artifact.delivery_evidence_byte_size);
  const minimum = artifact.media_type === 'application/pdf' ? 8 : 0;
  const maximum = artifact.media_type === WORD_MEDIA_TYPE ? DOCX_LIMITS.archiveBytes : 100 * 1024 * 1024;
  if (bounded && (!Number.isSafeInteger(expectedSize) || expectedSize < minimum || expectedSize > maximum))
    throw integrityFailure();
  let bytes: Buffer | null;
  if (bounded && expectedSize > BLOB_RANGE_BYTES && blobs.readToFile) {
    if (activeReads >= MAX_ACTIVE_READS) throw integrityFailure();
    // Share the existing disk-backed staging budget and reserve exactly the size
    // permitted below. The reader creates this private spool with wx/0600.
    const release = reserveSpool(expectedSize);
    activeReads++;
    const path = join(spoolDirectory(), `${uid()}.blob`);
    try {
      await mkdir(spoolDirectory(), { recursive: true, mode: 0o700 });
      const receipt = await blobs.readToFile(artifact.object_key, path, expectedSize, { useRanges: true });
      if (!receipt || receipt.byteSize !== expectedSize || receipt.sha256 !== artifact.sha256.trim()) throw integrityFailure();
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of createReadStream(path)) {
        const value = Buffer.from(chunk);
        total += value.length;
        if (total > expectedSize) throw integrityFailure();
        chunks.push(value);
      }
      bytes = Buffer.concat(chunks, total);
    } catch { throw integrityFailure(); }
    finally {
      try { await rm(path, { force: true }); release(); }
      finally { activeReads--; }
    }
  } else if (bounded) {
    try { bytes = await blobs.getIfExistsBounded(artifact.object_key, expectedSize); }
    catch { throw integrityFailure(); }
  } else {
    bytes = await blobs.get(artifact.object_key);
  }
  if (!bytes || (bounded && bytes.length !== expectedSize) || digest(bytes) !== artifact.sha256.trim()) throw integrityFailure();
  return bytes;
}
