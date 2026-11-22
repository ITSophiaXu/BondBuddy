import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

// A volume-wide flock serializes admission and sweeping. Each parse holds its own kernel lock
// through a child whose stdin closes on SIGKILL; SIGSTOP leaves the lock held.
export const PARSE_STAGING_MAX_BYTES = 1024 * 1024 * 1024;
const RESERVED_PARSE_BYTES = 384 * 1024 * 1024;
const MIN_FREE_BYTES = 384 * 1024 * 1024;
const MAX_MANAGED_DIRECTORIES = 64;
const STALE_MS = 30 * 60 * 1000;
const NAME = /^bb-material-[A-Za-z0-9]{6}$/;
const REGISTRY = '.bb-parse-registry.json';
const GLOBAL_LOCK = '.bb-parse-admission.lock';
const OWNER = '.owner.json';
const OWNER_LOCK = '.owner.lock';

type Registry = { version: 1; entries: Record<string, string> };
type HeldLock = { release(): Promise<void> };
const problem = (code: string) => new Error(`PARSE_STAGING_${code}`);

async function safeRoot(root: string): Promise<string> {
  const absolute = resolve(root);
  const info = await lstat(absolute);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(absolute)) !== absolute
  )
    throw problem('UNSAFE_ROOT');
  return absolute;
}

async function privateFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw problem('UNMANAGED_ENTRY');
}

/** The shell and flock share fd 3's open file description; closing stdin releases it. */
async function lockFile(path: string, wait: boolean, create = false): Promise<HeldLock | null> {
  const handle = await open(
    path,
    constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0),
    0o600,
  );
  try {
    await privateFile(path);
    const command = `flock -x ${wait ? '-w 10' : '-n'} 3 || exit 73; printf READY; exec cat >/dev/null`;
    const child = spawn('sh', ['-c', command], {
      stdio: ['pipe', 'pipe', 'ignore', handle.fd],
    }) as ChildProcessWithoutNullStreams;
    try {
      await new Promise<void>((accept, reject) => {
        const timeout = setTimeout(() => reject(problem('LOCK_TIMEOUT')), 12000);
        const finish = (error?: Error) => {
          clearTimeout(timeout);
          error ? reject(error) : accept();
        };
        child.stdout.once('data', (bytes) =>
          finish(String(bytes) === 'READY' ? undefined : problem('LOCK_FAILED')),
        );
        child.once('error', () => finish(problem('LOCK_FAILED')));
        child.once('exit', (code) => finish(problem(code === 73 ? 'LOCK_BUSY' : 'LOCK_FAILED')));
      });
    } catch (error) {
      child.stdin.end();
      if (child.exitCode === null) child.kill();
      if (!wait && error instanceof Error && error.message === 'PARSE_STAGING_LOCK_BUSY')
        return null;
      throw error;
    }
    return {
      release: async () => {
        child.stdin.end();
        if (child.exitCode === null)
          await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      },
    };
  } finally {
    await handle.close();
  }
}

async function withGlobal<T>(base: string, work: () => Promise<T>): Promise<T> {
  const lock = await lockFile(join(base, GLOBAL_LOCK), true, true);
  if (!lock) throw problem('LOCK_FAILED');
  try {
    return await work();
  } finally {
    await lock.release();
  }
}

async function registry(base: string): Promise<Registry> {
  const path = join(base, REGISTRY);
  try {
    await privateFile(path);
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value) ||
      value.version !== 1 ||
      !('entries' in value) ||
      typeof value.entries !== 'object' ||
      value.entries === null ||
      Array.isArray(value.entries)
    )
      throw problem('INVALID_REGISTRY');
    const entries = (value as Registry).entries;
    if (
      Object.entries(entries).some(
        ([name, nonce]) =>
          !NAME.test(name) || typeof nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(nonce),
      )
    )
      throw problem('INVALID_REGISTRY');
    return { version: 1, entries };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: {} };
    throw error;
  }
}

async function saveRegistry(base: string, value: Registry): Promise<void> {
  const temp = join(base, `.bb-parse-registry-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temp, join(base, REGISTRY));
  } finally {
    await rm(temp, { force: true });
  }
}

async function managedDirectory(
  base: string,
  name: string,
  nonce: string,
): Promise<{ path: string; bytes: number; ageFrom: number }> {
  if (!NAME.test(name)) throw problem('INVALID_REGISTRY');
  const path = join(base, name);
  const dir = await lstat(path);
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    dir.uid !== process.getuid?.() ||
    (dir.mode & 0o077) !== 0
  )
    throw problem('UNMANAGED_ENTRY');
  const names = await readdir(path);
  if (
    names.some(
      (item) => ![OWNER, OWNER_LOCK, 'source', 'source.xlsx', 'records.ndjson'].includes(item),
    )
  )
    throw problem('UNMANAGED_ENTRY');
  let bytes = 0;
  for (const item of names) {
    await privateFile(join(path, item));
    bytes += (await lstat(join(path, item))).size;
  }
  if (!names.includes(OWNER) || !names.includes(OWNER_LOCK)) throw problem('UNMANAGED_ENTRY');
  const owner = JSON.parse(await readFile(join(path, OWNER), 'utf8')) as {
    version?: unknown;
    nonce?: unknown;
  };
  if (owner.version !== 1 || owner.nonce !== nonce) throw problem('UNMANAGED_ENTRY');
  return { path, bytes, ageFrom: (await lstat(join(path, OWNER))).mtimeMs };
}

async function sweepLocked(
  base: string,
  found: Registry,
  now: number,
): Promise<{ removed: number; bytes: number }> {
  let removed = 0,
    bytes = 0,
    changed = false;
  for (const [name, nonce] of Object.entries(found.entries)) {
    const path = join(base, name);
    const dir = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!dir) {
      delete found.entries[name];
      changed = true;
      continue;
    }
    const managed = await managedDirectory(base, name, nonce);
    if (now - managed.ageFrom < STALE_MS) continue;
    const ownerLock = await lockFile(join(path, OWNER_LOCK), false);
    if (!ownerLock) continue;
    try {
      const checked = await managedDirectory(base, name, nonce);
      if (now - checked.ageFrom < STALE_MS) continue;
      await rm(path, { recursive: true });
      delete found.entries[name];
      changed = true;
      removed++;
      bytes += managed.bytes;
    } finally {
      await ownerLock.release();
    }
  }
  if (changed) await saveRegistry(base, found);
  return { removed, bytes };
}

export async function sweepParseStaging(
  root: string,
  now = Date.now(),
): Promise<{ removed: number; bytes: number }> {
  const base = await safeRoot(root);
  return withGlobal(base, async () => sweepLocked(base, await registry(base), now));
}

async function managedUsage(
  base: string,
  found: Registry,
): Promise<{ bytes: number; outstanding: number; directories: number }> {
  let bytes = 0,
    outstanding = 0;
  const entries = Object.entries(found.entries);
  for (const [name, nonce] of entries) {
    const managed = await managedDirectory(base, name, nonce);
    bytes += Math.max(managed.bytes, RESERVED_PARSE_BYTES);
    outstanding += Math.max(0, RESERVED_PARSE_BYTES - managed.bytes);
  }
  return { bytes, outstanding, directories: entries.length };
}

/** The global flock serializes all workers sharing one volume, including sweeps and admission. */
export async function createParseStaging(
  root: string,
): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const base = await safeRoot(root);
  let directory = '',
    ownerLock: HeldLock | null = null;
  await withGlobal(base, async () => {
    const found = await registry(base);
    await sweepLocked(base, found, Date.now());
    const usage = await managedUsage(base, found);
    const free = await statfs(base);
    if (
      usage.directories >= MAX_MANAGED_DIRECTORIES ||
      usage.bytes + RESERVED_PARSE_BYTES > PARSE_STAGING_MAX_BYTES ||
      free.bavail * free.bsize - usage.outstanding < RESERVED_PARSE_BYTES + MIN_FREE_BYTES
    )
      throw problem('CAPACITY');
    directory = await mkdtemp(join(base, 'bb-material-'));
    const nonce = randomUUID();
    try {
      await writeFile(join(directory, OWNER), JSON.stringify({ version: 1, nonce }), {
        flag: 'wx',
        mode: 0o600,
      });
      const lockHandle = await open(
        join(directory, OWNER_LOCK),
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      await lockHandle.close();
      ownerLock = await lockFile(join(directory, OWNER_LOCK), true);
      if (!ownerLock) throw problem('LOCK_FAILED');
      found.entries[basename(directory)] = nonce;
      await saveRegistry(base, found);
    } catch (error) {
      await ownerLock?.release();
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  });
  return {
    directory,
    cleanup: async () => {
      try {
        await withGlobal(base, async () => {
          const found = await registry(base);
          const nonce = found.entries[basename(directory)];
          if (!nonce) throw problem('UNMANAGED_ENTRY');
          await managedDirectory(base, basename(directory), nonce);
          await rm(directory, { recursive: true });
          delete found.entries[basename(directory)];
          await saveRegistry(base, found);
        });
      } finally {
        await ownerLock?.release();
      }
    },
  };
}
