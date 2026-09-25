import { mkdtemp, lstat, readdir, realpath, rm, statfs, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// A single parse uses at most 100 MiB of source plus 256 MiB of NDJSON. Two production
// slots fit inside this cap; repeated crashes cannot consume the rest of the host disk.
export const PARSE_STAGING_MAX_BYTES = 1024 * 1024 * 1024;
const RESERVED_PARSE_BYTES = 384 * 1024 * 1024;
const MIN_FREE_BYTES = 384 * 1024 * 1024;
const MAX_MANAGED_DIRECTORIES = 64;
const STALE_MS = 30 * 60 * 1000; // twice the bounded 15-minute DOCX bridge window
const HEARTBEAT_MS = 30 * 1000;
const NAME = /^bb-material-[A-Za-z0-9]{6}$/;
const active = new Set<string>();
let admission: Promise<void> = Promise.resolve();

async function safeRoot(root: string): Promise<string> {
  const absolute = resolve(root);
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 || await realpath(absolute) !== absolute) throw new Error('PARSE_STAGING_UNSAFE_ROOT');
  return absolute;
}

async function managedSize(path: string): Promise<number | null> {
  const files = await readdir(path);
  let bytes = 0;
  for (const name of files) {
    if (name !== '.active' && name !== 'source' && name !== 'records.ndjson') return null;
    const info = await lstat(join(path, name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
        info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) return null;
    bytes += info.size;
  }
  return bytes;
}

/** Only this service's private, old, inactive directories can be reclaimed. Never follow links. */
export async function sweepParseStaging(root: string, now = Date.now()): Promise<{ removed: number; bytes: number }> {
  const base = await safeRoot(root);
  let removed = 0, bytes = 0;
  for (const name of await readdir(base)) {
    if (!NAME.test(name)) continue;
    const path = join(base, name);
    if (active.has(path)) continue;
    const dir = await lstat(path);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0) continue;
    const size = await managedSize(path);
    if (size === null) continue;
    const marker = await lstat(join(path, '.active')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (now - (marker ?? dir).mtimeMs < STALE_MS) continue;
    // Re-check after the scan; a live parser can refresh its marker during a long read.
    const latest = marker ? await lstat(join(path, '.active')) : await lstat(path);
    if (active.has(path) || now - latest.mtimeMs < STALE_MS) continue;
    await rm(path, { recursive: true });
    removed++; bytes += size;
  }
  return { removed, bytes };
}

async function managedUsage(root: string): Promise<{ bytes: number; outstanding: number; directories: number }> {
  let bytes = 0, outstanding = 0, directories = 0;
  for (const name of await readdir(root)) {
    if (!NAME.test(name)) continue;
    const path = join(root, name);
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw new Error('PARSE_STAGING_UNMANAGED_ENTRY');
    directories++;
    const size = await managedSize(path);
    if (size === null) throw new Error('PARSE_STAGING_UNMANAGED_ENTRY');
    const marker = await lstat(join(path, '.active')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const reserved = active.has(path) || (marker !== null && Date.now() - marker.mtimeMs < STALE_MS);
    bytes += Math.max(size, reserved ? RESERVED_PARSE_BYTES : 0);
    if (reserved) outstanding += Math.max(0, RESERVED_PARSE_BYTES - size);
  }
  return { bytes, outstanding, directories };
}

/** Admission reserves one worst-case parse before creating any private source bytes. */
export async function createParseStaging(root: string): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const previous = admission;
  let release!: () => void;
  admission = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    const base = await safeRoot(root);
    await sweepParseStaging(base);
    const usage = await managedUsage(base);
    const free = await statfs(base);
    if (usage.directories >= MAX_MANAGED_DIRECTORIES || usage.bytes + RESERVED_PARSE_BYTES > PARSE_STAGING_MAX_BYTES ||
        free.bavail * free.bsize - usage.outstanding < RESERVED_PARSE_BYTES + MIN_FREE_BYTES) throw new Error('PARSE_STAGING_CAPACITY');
    const directory = await mkdtemp(join(base, 'bb-material-'));
    active.add(directory);
    let timer: NodeJS.Timeout | undefined;
    try {
      await writeFile(join(directory, '.active'), '', { flag: 'wx', mode: 0o600 });
      timer = setInterval(() => {
        const date = new Date();
        void utimes(join(directory, '.active'), date, date).catch(() => undefined);
      }, HEARTBEAT_MS);
      timer.unref();
    } catch (error) {
      active.delete(directory);
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return { directory, cleanup: async () => {
      if (timer) clearInterval(timer);
      try { await rm(directory, { recursive: true, force: true }); }
      finally { active.delete(directory); }
    } };
  } finally { release(); }
}
