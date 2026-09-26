/** Private Blob archival runs inside the same inherited flock as the NDJSON writer. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { Pool } from 'pg';
import type { LogRecord } from './log-ops.js';

const keyPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type Segment = { id: string; path: string; bytes: number; sha256: string; keys: string[]; values: Map<string, unknown> };
type Receipt = { delivery_key: string; outbox_id: string };
const fault = (point: string) => {
  if (process.env.NODE_ENV !== 'test' || process.env.BB_LOG_ARCHIVE_TEST_FAULT !== point) return;
  if (point === 'disk_full') throw Object.assign(new Error('Synthetic ENOSPC'), { code: 'ENOSPC' });
  process.exit(79);
};

async function syncDirectory(path: string) {
  const dir = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try { await dir.sync(); } finally { await dir.close(); }
}

async function safeOpen(path: string, flags = constants.O_RDONLY) {
  const file = await open(path, flags | constants.O_NOFOLLOW, 0o600);
  const info = await file.stat();
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1)
    { await file.close(); throw new Error('Unsafe NDJSON segment permissions'); }
  return { file, info };
}

async function scan(path: string, id: string, targets: Set<string>, seen: Set<string>): Promise<Segment> {
  const { file, info } = await safeOpen(path);
  const keys: string[] = [], values = new Map<string, unknown>();
  try {
    if (info.size) {
      const tail = Buffer.alloc(1);
      await file.read(tail, 0, 1, info.size - 1);
      if (tail[0] !== 10) throw new Error('Incomplete NDJSON tail');
      const lines = createInterface({ input: file.createReadStream({ start: 0, end: info.size - 1, autoClose: false }), crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line) throw new Error('Empty NDJSON line');
          let value: unknown;
          try { value = JSON.parse(line); } catch { throw new Error('Corrupt NDJSON line'); }
          if (!value || typeof value !== 'object' || Array.isArray(value) || !keyPattern.test((value as LogRecord).delivery_key))
            throw new Error('Invalid NDJSON delivery key');
          const key = (value as LogRecord).delivery_key;
          if (seen.has(key)) throw new Error('Duplicate NDJSON delivery key');
          seen.add(key); keys.push(key);
          if (targets.has(key)) values.set(key, value);
        }
      } finally { lines.close(); }
    }
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
    return { id, path, bytes: info.size, sha256: hash.digest('hex'), keys, values };
  } finally { await file.close(); }
}

async function receipts(pool: Pool, sink: string, keys: string[]): Promise<Map<string, Receipt>> {
  const result = new Map<string, Receipt>();
  for (let i = 0; i < keys.length; i += 1000) {
    const rows = (await pool.query<Receipt>('SELECT delivery_key,outbox_id FROM bb_log_deliveries WHERE sink=$1 AND delivery_key=ANY($2)',
      [sink, keys.slice(i, i + 1000)])).rows;
    for (const row of rows) {
      const key = row.delivery_key.trim();
      if (createHash('sha256').update(`${sink}:${row.outbox_id}`).digest('hex') !== key)
        throw new Error('Inconsistent PG delivery key receipt');
      result.set(key, row);
    }
  }
  return result;
}

async function persistSegment(pool: Pool, sink: string, segment: Segment, state: 'active' | 'sealed') {
  const q = await pool.query('SELECT sink,state,byte_length,sha256,record_count FROM bb_log_segments WHERE id=$1', [segment.id]);
  if (!q.rowCount) {
    await pool.query(`INSERT INTO bb_log_segments(id,sink,state,byte_length,sha256,record_count,sealed_at)
      VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $3='sealed' THEN now() END)`, [segment.id, sink, state, segment.bytes, segment.sha256, segment.keys.length]);
    return;
  }
  const row = q.rows[0];
  if (row.sink !== sink || row.state === 'sealed' && (state !== 'sealed' || Number(row.byte_length) !== segment.bytes ||
    row.sha256 !== segment.sha256 || Number(row.record_count) !== segment.keys.length)) throw new Error('Segment evidence mismatch');
  if (row.state === 'active') await pool.query(`UPDATE bb_log_segments SET state=$2,byte_length=$3,sha256=$4,record_count=$5,
    sealed_at=CASE WHEN $2='sealed' THEN now() END WHERE id=$1`, [segment.id, state, segment.bytes, segment.sha256, segment.keys.length]);
}

async function writeActiveId(path: string, id: string) {
  const temporary = `${path}.active-id.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(`${id}\n`); await file.sync(); } finally { await file.close(); }
  await rename(temporary, `${path}.active-id`);
  await syncDirectory(path);
}

async function activeId(path: string): Promise<string | null> {
  let file;
  try { file = (await safeOpen(`${path}.active-id`)).file; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const id = (await file.readFile({ encoding: 'utf8' })).trim();
    if (!uuidPattern.test(id)) throw new Error('Invalid active segment identity');
    return id;
  } finally { await file.close(); }
}

async function blobDigest(container: ContainerClient, objectKey: string, length: number, sha256: string) {
  const response = await container.getBlobClient(objectKey).download();
  if (!response.readableStreamBody || response.contentLength !== length) throw new Error('Archive Blob length mismatch');
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of response.readableStreamBody) { const data = Buffer.from(chunk); bytes += data.length; hash.update(data); }
  if (bytes !== length || hash.digest('hex') !== sha256) throw new Error('Archive Blob hash mismatch');
}

async function archive(pool: Pool, container: ContainerClient, sink: string, segment: Segment) {
  // A missing PG key receipt means the local segment remains available for replay.
  const found = await receipts(pool, sink, segment.keys);
  if (segment.keys.some(key => !found.has(key))) return false;
  const objectKey = `log-archive/${sink}/${segment.id}.ndjson`;
  const existing = await pool.query('SELECT object_key,byte_length,sha256,record_count FROM bb_log_archive_receipts WHERE segment_id=$1', [segment.id]);
  if (existing.rowCount && (existing.rows[0].object_key !== objectKey || Number(existing.rows[0].byte_length) !== segment.bytes ||
      existing.rows[0].sha256 !== segment.sha256 || Number(existing.rows[0].record_count) !== segment.keys.length))
    throw new Error('Archive receipt mismatch');
  if (!existing.rowCount) {
    try {
      const { file } = await safeOpen(segment.path);
      try {
        await container.getBlockBlobClient(objectKey).uploadStream(file.createReadStream({ autoClose: false }), 1024 * 1024, 1,
          { conditions: { ifNoneMatch: '*' }, blobHTTPHeaders: { blobContentType: 'application/x-ndjson' },
            metadata: { sha256: segment.sha256, segmentid: segment.id } });
      } finally { await file.close(); }
    } catch {
      // A lost upload response is resolved by checking the same unique object name and its bytes.
      await blobDigest(container, objectKey, segment.bytes, segment.sha256);
    }
  }
  fault('after_blob_upload');
  // Test only: mutate the remote object to exercise an actual readback mismatch.
  if (process.env.NODE_ENV === 'test' && process.env.BB_LOG_ARCHIVE_TEST_FAULT === 'hash_mismatch')
    await container.getBlockBlobClient(objectKey).uploadData(Buffer.from('synthetic-corrupt-archive'));
  await blobDigest(container, objectKey, segment.bytes, segment.sha256);
  fault('after_blob_readback');
  fault('before_receipt');
  if (!existing.rowCount) await pool.query(`INSERT INTO bb_log_archive_receipts(segment_id,object_key,byte_length,sha256,record_count)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [segment.id, objectKey, segment.bytes, segment.sha256, segment.keys.length]);
  fault('after_receipt');
  const confirmed = await pool.query('SELECT object_key,byte_length,sha256,record_count FROM bb_log_archive_receipts WHERE segment_id=$1', [segment.id]);
  if (confirmed.rowCount !== 1 || confirmed.rows[0].object_key !== objectKey || Number(confirmed.rows[0].byte_length) !== segment.bytes ||
    confirmed.rows[0].sha256 !== segment.sha256 || Number(confirmed.rows[0].record_count) !== segment.keys.length)
    throw new Error('Archive receipt transaction failed');
  // Recheck the local bytes and all keys immediately before retirement under flock.
  const local = await scan(segment.path, segment.id, new Set(), new Set());
  if (local.bytes !== segment.bytes || local.sha256 !== segment.sha256 || local.keys.length !== segment.keys.length ||
    (await receipts(pool, sink, segment.keys)).size !== segment.keys.length) throw new Error('Local archive evidence changed');
  fault('before_unlink');
  await unlink(segment.path);
  fault('after_unlink');
  await syncDirectory(segment.path);
  return true;
}

export async function writeArchivedNdjson(path: string, sink: string, records: LogRecord[], maxBytes: number, localBudget: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || !Number.isSafeInteger(localBudget) || localBudget < maxBytes * 2)
    throw new Error('Invalid archive size budget');
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(sink) || records.some(r => !keyPattern.test(r.delivery_key) ||
      !r.event || typeof r.event !== 'object' || Object.hasOwn(r.event, 'delivery_key'))) throw new Error('Invalid archive record');
  if (new Set(records.map(r => r.delivery_key)).size !== records.length) throw new Error('Duplicate archive delivery key');
  const databaseUrl = process.env.DATABASE_URL, connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = process.env.BB_LOG_ARCHIVE_CONTAINER || 'bondbuddy-private';
  if (!databaseUrl || !connectionString || !/^[a-z0-9-]{3,63}$/.test(containerName)) throw new Error('Archive storage is not configured');
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const container = BlobServiceClient.fromConnectionString(connectionString).getContainerClient(containerName);
    const properties = await container.getProperties();
    if (properties.blobPublicAccess) throw new Error('Log archive container must be private');
    const targets = new Set(records.map(r => r.delivery_key)), seen = new Set<string>();
    const oldId = await activeId(path);
    const names = await readdir(dirname(path));
    const prefix = `${basename(path)}.seg.`;
    // A lost active identity must be reconciled against existing PG/file evidence
    // by an operator. Never invent a replacement UUID for an initialized sink.
    if (!oldId && (names.some(name => name.startsWith(prefix)) ||
      (await pool.query('SELECT 1 FROM bb_log_segments WHERE sink=$1 LIMIT 1', [sink])).rowCount))
      throw new Error('Missing active segment identity; operator recovery required');
    for (const name of names.filter(n => n.startsWith(`${basename(path)}.active-id.`) && n.endsWith('.tmp'))) {
      const stale = join(dirname(path), name);
      await safeOpen(stale).then(({ file }) => file.close());
      await unlink(stale); await syncDirectory(path);
    }
    // The old scheduler's .1 is imported once by a unique rename; it can never be overwritten.
    if (names.includes(`${basename(path)}.1`)) {
      const id = randomUUID(), old = `${path}.1`, renamed = `${path}.seg.${id}`;
      const { file } = await safeOpen(old);
      try { await file.sync(); } finally { await file.close(); }
      await rename(old, renamed); await syncDirectory(path);
      names.splice(names.indexOf(`${basename(path)}.1`), 1, basename(renamed));
    }
    let existingBytes = 0;
    for (const name of names.filter(n => n === basename(path) || n.startsWith(prefix))) {
      existingBytes += (await stat(join(dirname(path), name))).size;
      if (existingBytes > localBudget) throw new Error('NDJSON local archive budget reached');
    }
    const sealed: Segment[] = [];
    for (const name of names.filter(n => n.startsWith(prefix)).sort()) {
      const id = name.slice(prefix.length);
      if (!uuidPattern.test(id)) throw new Error('Unknown NDJSON segment filename');
      const segment = await scan(join(dirname(path), name), id, targets, seen);
      await persistSegment(pool, sink, segment, 'sealed');
      sealed.push(segment);
    }
    // Any sealed segment without an archive receipt must remain local. Archived
    // segments are represented by immutable PG receipts after their verified unlink.
    const historical = await pool.query(`SELECT s.id FROM bb_log_segments s LEFT JOIN bb_log_archive_receipts r ON r.segment_id=s.id
      WHERE s.sink=$1 AND s.state='sealed' AND r.segment_id IS NULL`, [sink]);
    const localIds = new Set(sealed.map(s => s.id));
    for (const row of historical.rows) {
      if (!localIds.has(row.id)) throw new Error('Missing local segment without archive receipt');
    }
    let currentExists = true;
    try { await stat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') currentExists = false; else throw error; }
    let id = currentExists && oldId ? oldId : randomUUID();
    if (oldId && !currentExists) {
      if (sealed.some(s => s.id === oldId)) {
        // Rename committed before the new active identity was installed.
        id = randomUUID();
      } else {
        // New identity committed before its empty file was created. A missing
        // nonempty active file is never reconstructed from metadata alone.
        const row = await pool.query('SELECT state,byte_length FROM bb_log_segments WHERE id=$1 AND sink=$2', [oldId, sink]);
        if (!sealed.length || row.rowCount && (row.rows[0].state !== 'active' || Number(row.rows[0].byte_length) !== 0))
          throw new Error('Active segment missing without sealed successor');
        id = oldId;
      }
    }
    if (!currentExists) {
      const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try { await file.sync(); } finally { await file.close(); }
      await syncDirectory(path);
    }
    if (!currentExists || !oldId) await writeActiveId(path, id);
    let current = await scan(path, id, targets, seen);
    await persistSegment(pool, sink, current, 'active');
    // A sealed file can be removed only after its immutable PG receipt, Blob readback and key receipts agree.
    for (const segment of sealed) await archive(pool, container, sink, segment);
    const past = await receipts(pool, sink, records.map(r => r.delivery_key));
    const append: Buffer[] = [];
    for (const record of records) {
      const value = { delivery_key: record.delivery_key, ...record.event };
      if (seen.has(record.delivery_key)) {
        const observed = sealed.find(s => s.values.has(record.delivery_key))?.values.get(record.delivery_key) ?? current.values.get(record.delivery_key);
        if (!isDeepStrictEqual(observed, value)) throw new Error('Conflicting NDJSON delivery key');
      } else if (past.has(record.delivery_key)) {
        if (past.get(record.delivery_key)!.outbox_id !== record.outbox_id) throw new Error('Conflicting PG delivery key');
      } else append.push(Buffer.from(JSON.stringify(value) + '\n'));
    }
    const newBytes = append.reduce((sum, line) => sum + line.length, 0);
    if (newBytes > maxBytes) throw new Error('NDJSON batch exceeds segment limit');
    if (newBytes && current.bytes + newBytes > maxBytes) {
      const sealedPath = `${path}.seg.${id}`;
      const { file: source } = await safeOpen(path);
      try { await source.sync(); } finally { await source.close(); }
      fault('after_seal_filesync');
      await rename(path, sealedPath);
      fault('after_seal_rename');
      await syncDirectory(path);
      fault('after_seal_dirsync');
      current.path = sealedPath;
      await persistSegment(pool, sink, current, 'sealed');
      const prior = current;
      sealed.push(prior);
      // The old ID remains on disk until the new active ID has been fsynced.
      id = randomUUID(); await writeActiveId(path, id);
      fault('after_active_id');
      const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try { await file.sync(); } finally { await file.close(); }
      await syncDirectory(path);
      current = await scan(path, id, targets, seen);
      await persistSegment(pool, sink, current, 'active');
      await archive(pool, container, sink, prior);
    }
    const localFiles = (await readdir(dirname(path))).filter(n => n === basename(path) || n.startsWith(prefix));
    let localBytes = 0;
    for (const name of localFiles) localBytes += (await stat(join(dirname(path), name))).size;
    if (localBytes + newBytes > localBudget) throw new Error('NDJSON local archive budget reached');
    fault('disk_full');
    const file = await safeOpen(path, constants.O_RDWR | constants.O_APPEND).then(r => r.file);
    try {
      for (const line of append) {
        let offset = 0;
        while (offset < line.length) offset += (await file.write(line, offset, line.length - offset)).bytesWritten;
      }
      fault('before_file_sync');
      await file.sync();
      fault('after_file_sync');
    } finally { await file.close(); }
    current = await scan(path, id, new Set(), new Set());
    await persistSegment(pool, sink, current, 'active');
  } finally { await pool.end(); }
}
