/** Runs only beneath flock, with the lock descriptor inherited as fd 3. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { LogRecord } from './log-ops.js';

const keyPattern = /^[a-f0-9]{64}$/;

async function writeLocked(path: string, records: LogRecord[], maxBytes?: number) {
  if (!Array.isArray(records) || records.some(r => !keyPattern.test(r.delivery_key) ||
    !r.event || typeof r.event !== 'object' || Object.hasOwn(r.event, 'delivery_key'))) throw new Error('Invalid delivery record');
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new Error('Invalid NDJSON size cap');
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  let archive: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('Unsafe NDJSON file permissions');
    // An unterminated last line may be a torn write. Refuse to acknowledge or
    // append anything until an operator reconciles it with the PG outbox.
    if (stat.size) {
      const tail = Buffer.alloc(1);
      await file.read(tail, 0, 1, stat.size - 1);
      if (tail[0] !== 10) throw new Error('Incomplete NDJSON tail');
    }
    const targets = new Set(records.map(record => record.delivery_key));
    const seen = new Set<string>();
    const matching = new Map<string, unknown>(); // only incoming keys need payload comparison
    if (stat.size) {
      const lines = createInterface({ input: file.createReadStream({ start: 0, end: stat.size - 1, autoClose: false }), crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line) throw new Error('Empty NDJSON line');
          let parsed: unknown;
          try { parsed = JSON.parse(line); } catch { throw new Error('Corrupt NDJSON line'); }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !keyPattern.test((parsed as LogRecord).delivery_key)) throw new Error('Invalid NDJSON delivery key');
          const key = (parsed as LogRecord).delivery_key;
          if (seen.has(key)) throw new Error('Duplicate NDJSON delivery key');
          seen.add(key);
          if (targets.has(key)) matching.set(key, parsed);
        }
      } finally { lines.close(); }
    }
    try { archive = await open(`${path}.1`, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (archive) {
      const older = await archive.stat();
      if (!older.isFile() || (older.mode & 0o777) !== 0o600 || older.uid !== process.getuid?.()) throw new Error('Unsafe NDJSON archive permissions');
      if (older.size) {
        const tail = Buffer.alloc(1);
        await archive.read(tail, 0, 1, older.size - 1);
        if (tail[0] !== 10) throw new Error('Incomplete NDJSON archive tail');
        const lines = createInterface({ input: archive.createReadStream({ start: 0, end: older.size - 1, autoClose: false }), crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            if (!line) throw new Error('Empty NDJSON archive line');
            let parsed: unknown;
            try { parsed = JSON.parse(line); } catch { throw new Error('Corrupt NDJSON archive line'); }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !keyPattern.test((parsed as LogRecord).delivery_key)) throw new Error('Invalid NDJSON archive key');
            const key = (parsed as LogRecord).delivery_key;
            if (seen.has(key)) throw new Error('Duplicate NDJSON key across segments');
            seen.add(key);
            if (targets.has(key)) matching.set(key, parsed);
          }
        } finally { lines.close(); }
      }
    }
    const toAppend: Buffer[] = [];
    for (const record of records) {
      const value = { delivery_key: record.delivery_key, ...record.event };
      if (seen.has(record.delivery_key)) {
        if (!isDeepStrictEqual(matching.get(record.delivery_key), value)) throw new Error('Conflicting NDJSON delivery key');
        continue;
      }
      toAppend.push(Buffer.from(JSON.stringify(value) + '\n'));
      seen.add(record.delivery_key);
      matching.set(record.delivery_key, value);
    }
    // A finite rotation horizon cannot cover a process delayed past its lease.
    // Keep both existing segments and reject the whole batch before any new bytes
    // are appended if the strict cap would be exceeded.
    if (maxBytes !== undefined && toAppend.length && stat.size + toAppend.reduce((n, bytes) => n + bytes.length, 0) > maxBytes)
      throw new Error('NDJSON size cap reached; rotation requires durable key history');
    for (const bytes of toAppend) {
      let offset = 0;
      while (offset < bytes.length) offset += (await file.write(bytes, offset, bytes.length - offset)).bytesWritten;
    }
    // A prior process may have written a complete line then died before fsync.
    // Even a replay that appends nothing must flush those observed bytes before PG ack.
    await file.sync();
    if (archive) await archive.sync();
    // Also persist the directory entry when the log file was newly created.
    if (stat.size === 0) {
      const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { if (archive) await archive.close(); await file.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chunks: Buffer[] = [];
  process.stdin.on('data', chunk => chunks.push(Buffer.from(chunk)));
  process.stdin.on('end', () => {
    let input: { records: LogRecord[]; maxBytes?: number };
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { process.stderr.write('Invalid NDJSON writer input\n'); process.exitCode = 1; return; }
    void writeLocked(process.argv[2], input.records, input.maxBytes).catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : 'NDJSON write failed'}\n`);
      process.exitCode = 1;
    });
  });
}
