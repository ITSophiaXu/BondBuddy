import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

async function digestStream(body, expectedBytes) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.length;
    if (bytes > expectedBytes) throw new Error('Object exceeds expected length');
    hash.update(chunk);
  }
  if (bytes !== expectedBytes) throw new Error('Object length mismatch');
  return hash.digest('hex');
}

/**
 * Copies one current object while hashing the only Azure download. The caller must
 * keep the target bucket exclusive to this migration until the final write fence.
 * A prior verified receipt is mandatory before replacing a target object.
 */
export async function copyCurrentObject({ source, target, entry, previous, allowReplace = false, spoolRoot = tmpdir() }) {
  if (!entry || typeof entry.key !== 'string' || !entry.key || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
      typeof entry.etag !== 'string' || !entry.etag || typeof entry.contentType !== 'string')
    throw new Error('Invalid source object inventory entry');
  if (entry.accessTier === 'Archive') throw new Error('Azure Archive object must be rehydrated before copying');
  const targetState = await target.head(entry.key);
  if (targetState) {
    const targetHash = previous && previous.key === entry.key && Number.isSafeInteger(previous.bytes) && previous.bytes >= 0
      ? await digestStream(await target.open(entry.key), previous.bytes).catch(() => null) : null;
    if (!targetHash || previous.sha256 !== targetHash)
      throw new Error('Target object exists without a matching verified migration receipt');
    if (entry.expectedSha256 && entry.expectedSha256 !== targetHash && previous.sourceEtag === entry.etag)
      throw new Error('Existing target hash differs from trusted database hash');
    if (previous.sourceEtag === entry.etag && previous.bytes === entry.bytes)
      return { ...previous, status: 'verified_existing' };
    if (!allowReplace) throw new Error('Source changed; explicit incremental replacement is required');
  }
  const spoolDir = await mkdtemp(join(spoolRoot, 'bb-cos-copy-'));
  const spoolPath = join(spoolDir, 'object');
  try {
    const sourceBody = await source.open(entry.key, entry.etag);
    const hash = createHash('sha256');
    let transferred = 0;
    const meter = new Transform({ transform(chunk, _encoding, done) {
      transferred += chunk.length;
      if (transferred > entry.bytes) return done(new Error('Source object exceeded listed length'));
      hash.update(chunk);
      done(null, chunk);
    } });
    await pipeline(sourceBody, meter, createWriteStream(spoolPath, { mode: 0o600 }));
    if (transferred !== entry.bytes) throw new Error('Source object length changed during copy');
    const sha256 = hash.digest('hex');
    if (entry.expectedSha256 && entry.expectedSha256 !== sha256)
      throw new Error('Source hash differs from trusted database hash');
    let uploadError;
    try { await target.put(entry.key, createReadStream(spoolPath), entry.bytes, entry.contentType,
      { createOnly: !targetState }); }
    catch (error) { uploadError = error; }
    let targetHash;
    try { targetHash = await digestStream(await target.open(entry.key), entry.bytes); }
    catch (error) { if (uploadError) throw uploadError; throw error; }
    if (targetHash !== sha256) throw new Error('COS readback hash mismatch');
    return { key: entry.key, sourceEtag: entry.etag, bytes: entry.bytes, sha256,
      contentType: entry.contentType, status: targetState ? 'replaced' : 'copied' };
  } finally {
    await rm(spoolDir, { recursive: true, force: true });
  }
}
