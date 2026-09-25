/** Runs only beneath flock, with the lock descriptor inherited as fd 3. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { LogRecord } from './log-ops.js';

const keyPattern = /^[a-f0-9]{64}$/;

async function writeLocked(path: string, records: LogRecord[]) {
  if (!Array.isArray(records) || records.some(r => !keyPattern.test(r.delivery_key) ||
    !r.event || typeof r.event !== 'object' || Object.hasOwn(r.event, 'delivery_key'))) throw new Error('Invalid delivery record');
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
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
    const seen = new Map<string, unknown>();
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
          seen.set(key, parsed);
        }
      } finally { lines.close(); }
    }
    for (const record of records) {
      const value = { delivery_key: record.delivery_key, ...record.event };
      if (seen.has(record.delivery_key)) {
        if (!isDeepStrictEqual(seen.get(record.delivery_key), value)) throw new Error('Conflicting NDJSON delivery key');
        continue;
      }
      const bytes = Buffer.from(JSON.stringify(value) + '\n');
      let offset = 0;
      while (offset < bytes.length) offset += (await file.write(bytes, offset, bytes.length - offset)).bytesWritten;
      seen.set(record.delivery_key, value);
    }
    // A prior process may have written a complete line then died before fsync.
    // Even a replay that appends nothing must flush those observed bytes before PG ack.
    await file.sync();
    // Also persist the directory entry when the log file was newly created.
    if (stat.size === 0) {
      const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await file.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chunks: Buffer[] = [];
  process.stdin.on('data', chunk => chunks.push(Buffer.from(chunk)));
  process.stdin.on('end', () => {
    let records: LogRecord[];
    try { records = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { process.stderr.write('Invalid NDJSON writer input\n'); process.exitCode = 1; return; }
    void writeLocked(process.argv[2], records).catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : 'NDJSON write failed'}\n`);
      process.exitCode = 1;
    });
  });
}
