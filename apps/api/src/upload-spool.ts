import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Problem } from './data.js';

// Upload bytes never live in memory as a whole: request and Blob bodies are streamed into a
// private spool file while hashing, inspected from that file and staged to Blob in blocks.
// The spool must be disk-backed (a tmpfs counts against the container memory limit).
const MiB = 1024 * 1024;
export type Spooled = { path: string; byteSize: number; sha256: string };

export function spoolDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.BB_UPLOAD_SPOOL_DIR || join(tmpdir(), 'bb-upload-spool');
}

function spoolBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BB_UPLOAD_SPOOL_MAX_BYTES;
  if (raw === undefined || raw === '') return 1024 * MiB;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid BB_UPLOAD_SPOOL_MAX_BYTES');
  return value;
}

let reservedBytes = 0;

/** Reserve spool space for one upload; the returned release is idempotent. */
export function reserveSpool(bytes: number): () => void {
  if (reservedBytes + bytes > spoolBudget()) throw new Problem(503, 'DATA_UNAVAILABLE', 'Upload staging capacity is temporarily busy');
  reservedBytes += bytes;
  let released = false;
  return () => { if (!released) { released = true; reservedBytes -= bytes; } };
}

export function reservedSpoolBytes(): number { return reservedBytes; }

/** Stream `source` into a new spool file, hashing on the way. Bytes beyond `maxBytes` are dropped
 * (a small overrun is drained so the caller can still answer 422); a large overrun aborts the read. */
export async function spoolStream(source: Readable, maxBytes: number, overflow: () => Error): Promise<Spooled> {
  const directory = spoolDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${randomUUID()}.part`);
  const hash = createHash('sha256');
  let byteSize = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      byteSize += chunk.length;
      if (byteSize > maxBytes + MiB) return done(overflow());
      if (byteSize > maxBytes) return done();
      hash.update(chunk);
      done(null, chunk);
    }
  });
  try {
    await pipeline(source, meter, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
  } catch (error) {
    await discardSpool(path);
    if (error instanceof Problem) throw error;
    throw new Problem(422, 'VALIDATION_FAILED', 'Upload body could not be read');
  }
  if (byteSize > maxBytes) { await discardSpool(path); throw overflow(); }
  return { path, byteSize, sha256: hash.digest('hex') };
}

export async function discardSpool(path: string | undefined): Promise<void> {
  if (path) await rm(path, { force: true }).catch(() => undefined);
}

/** Remove leftovers of a previous process (call once at startup, before listening). */
export async function clearSpoolDirectory(): Promise<void> {
  const directory = spoolDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of await readdir(directory)) {
    if (name.endsWith('.part') || name.endsWith('.blob')) await rm(join(directory, name), { force: true });
  }
}
