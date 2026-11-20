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
    let directoryReady = false;
    try {
      await mkdir(spoolDirectory(), { recursive: true, mode: 0o700 });
      directoryReady = true;
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
      try { if (directoryReady) await rm(path, { force: true }); release(); }
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

type CacheableArtifact = StoredArtifact & { owner_user_id?: unknown; run_id?: unknown; id?: unknown; version?: unknown };
type ArtifactCacheOptions = { ttlMs?: number; maxBytes?: number; maxEntries?: number; now?: () => number };

/** Server-local checked bytes. A trusted storage HEAD and current route authorization
 * are still required for every delivery; a digest alone is never a cache receipt. */
export function createCachedArtifactReader(blobs: PrivateBlobs, options: ArtifactCacheOptions = {}) {
  const ttl = options.ttlMs ?? 60_000, maximum = options.maxBytes ?? 64 * 1024 * 1024, count = options.maxEntries ?? 16;
  if ([ttl, maximum, count].some(value => !Number.isSafeInteger(value) || value <= 0)) throw new RangeError('Invalid artifact cache limit');
  const now = options.now ?? Date.now;
  const entries = new Map<string, { bytes: Buffer; etag: string; expires: number }>();
  const pending = new Map<string, Promise<Buffer>>();
  let retained = 0, generation = 0;
  const remove = (key: string) => { const entry = entries.get(key); if (entry) { retained -= entry.bytes.length; entries.delete(key); } };
  const prune = () => { for (const [key, entry] of entries) if (entry.expires <= now()) remove(key); };
  const head = async (artifact: CacheableArtifact, size: number) => {
    let value: Awaited<ReturnType<NonNullable<PrivateBlobs['headVersion']>>>;
    try { value = await blobs.headVersion!(artifact.object_key); } catch { throw integrityFailure(); }
    if (!value || typeof value.etag !== 'string' || !value.etag || value.etag.length > 1024 || value.byteSize !== size) throw integrityFailure();
    return value;
  };
  return {
    clear() { generation++; entries.clear(); pending.clear(); retained = 0; },
    async read(artifact: CacheableArtifact): Promise<Buffer> {
      const size = Number(artifact.delivery_evidence_byte_size);
      if (!blobs.headVersion || !Number.isSafeInteger(size) || size <= 0 || size > maximum ||
          ![artifact.owner_user_id, artifact.run_id, artifact.id].every(value => typeof value === 'string' && value.length > 0) ||
          !Number.isSafeInteger(artifact.version) || Number(artifact.version) <= 0 || !/^[a-f0-9]{64}$/.test(artifact.sha256.trim()))
        return readVerifiedArtifact(blobs, artifact);
      const key = JSON.stringify([artifact.owner_user_id, artifact.run_id, artifact.id, artifact.version, artifact.object_key, artifact.sha256.trim(), artifact.media_type, size]);
      prune();
      const version = await head(artifact, size);
      const existing = entries.get(key);
      if (existing && existing.etag === version.etag && existing.expires > now()) {
        entries.delete(key); entries.set(key, existing);
        return Buffer.from(existing.bytes);
      }
      remove(key);
      const flightKey = JSON.stringify([key, version.etag]);
      const inflight = pending.get(flightKey);
      if (inflight) return Buffer.from(await inflight);
      const startedGeneration = generation;
      const read = (async () => {
        const bytes = Buffer.from(await readVerifiedArtifact(blobs, artifact));
        if (bytes.length !== size) throw integrityFailure();
        const after = await head(artifact, size);
        if (after.etag !== version.etag) throw integrityFailure();
        if (generation === startedGeneration) {
          prune(); remove(key);
          while (entries.size >= count || retained + bytes.length > maximum) remove(entries.keys().next().value!);
          entries.set(key, { bytes, etag: version.etag, expires: now() + ttl }); retained += bytes.length;
        }
        return bytes;
      })();
      pending.set(flightKey, read);
      try { return Buffer.from(await read); }
      finally { if (pending.get(flightKey) === read) pending.delete(flightKey); }
    },
  };
}
