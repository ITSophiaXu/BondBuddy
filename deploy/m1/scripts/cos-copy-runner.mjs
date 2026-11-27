import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, unlink } from 'node:fs/promises';
import { copyCurrentObject } from './cos-copy-core.mjs';

const readLines = async path => (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));

/** Durable, resumable current-object copy. The manifest contains private object keys. */
export async function runCosCopy({ source, target, container, manifestPath, selected = null, expected = new Map(), allowReplace = false, spoolRoot }) {
  const bucket = target.bucket;
  const lockPath = `${manifestPath}.lock`;
  const lock = await open(lockPath, 'wx', 0o600);
  let manifest;
  try {
    manifest = await open(manifestPath, constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600);
    const info = await manifest.stat();
    if (!info.isFile() || process.platform !== 'win32' &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid() || info.nlink !== 1))
      throw new Error('Migration manifest must be a private regular file');
    const prior = new Map();
    for (const row of await readLines(manifestPath)) {
      if (row.sourceContainer !== container || row.targetBucket !== bucket || typeof row.key !== 'string' ||
          typeof row.sourceEtag !== 'string' || !Number.isSafeInteger(row.bytes) || !/^[a-f0-9]{64}$/.test(row.sha256))
        throw new Error('Migration manifest does not match the selected source and target');
      prior.set(row.key, row);
    }
    await target.ready();
    const started = Date.now();
    const totals = { scanned: 0, selected: 0, copied: 0, replaced: 0, verified_existing: 0, bytes: 0 };
    const seen = new Set();
    for await (const entry of source.list()) {
      totals.scanned++;
      if (selected && !selected.has(entry.key)) continue;
      if (seen.has(entry.key)) throw new Error('Source inventory contains a duplicate object key');
      seen.add(entry.key);
      totals.selected++;
      const keyHash = createHash('sha256').update(entry.key).digest('hex');
      try {
        const record = await copyCurrentObject({ source, target,
          entry: { ...entry, ...(expected.has(entry.key) ? { expectedSha256: expected.get(entry.key) } : {}) },
          previous: prior.get(entry.key), allowReplace, spoolRoot });
        totals[record.status]++;
        if (record.status !== 'verified_existing') {
          const receipt = { sourceContainer: container, targetBucket: bucket, ...record, copiedAt: new Date().toISOString() };
          await manifest.writeFile(`${JSON.stringify(receipt)}\n`);
          await manifest.sync();
          prior.set(entry.key, receipt);
          totals.bytes += record.bytes;
        }
      } catch (error) { throw new Error(`Object ${keyHash} failed: ${error instanceof Error ? error.message : 'unknown'}`); }
    }
    if (selected && totals.selected !== selected.size) throw new Error('Some selected source keys were not found');
    if (!selected && [...prior.keys()].some(key => !seen.has(key)))
      throw new Error('Previously copied source objects disappeared; reconcile deletion tombstones before cutover');
    return { ...totals, elapsedMs: Date.now() - started, targetBucket: bucket };
  } finally {
    await manifest?.close();
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}
