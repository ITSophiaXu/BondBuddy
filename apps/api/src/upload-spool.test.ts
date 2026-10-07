import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { BlobServiceClient } from '@azure/storage-blob';
import { Pool } from 'pg';
import { azureBlobs, digest, Problem, verifiedMedia, verifiedMediaFile } from './data.js';
import { createServer } from './server.js';
import { CSV, csvFormulaSample, csvSample, DOCX, docxSample, PDF, pdfSample, PNG, pngSample, TEXT, textSample } from './upload-safety.samples.js';
import { reserveSpool, reservedSpoolBytes, spoolStream } from './upload-spool.js';

const MiB = 1024 * 1024;
import { isolatedTestDatabase } from './test-database.js';
const connection = await isolatedTestDatabase();
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const origin = 'http://bondbuddy.test';

async function withFile<T>(bytes: Buffer, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'bb-spool-test-'));
  try {
    const path = join(dir, 'upload.part');
    await writeFile(path, bytes);
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function outcome(run: () => Promise<string>): Promise<string> {
  try { return `ok:${await run()}`; } catch (error) { return `${(error as Problem).status}:${(error as Problem).code}`; }
}

// Pads a text body so that `tail` starts `offset` bytes before the 1 MiB chunk boundary.
function acrossBoundary(tail: string, offset: number, header = 'name,value\n'): Buffer {
  const filler = Buffer.alloc(MiB - offset - header.length, 0x61);
  return Buffer.concat([Buffer.from(header), Buffer.from('x,'), filler.subarray(2), Buffer.from(`\n${tail}`)]);
}

test('spooled and in-memory originals accept identical bytes without content checks at chunk boundaries', async () => {
  const cases: Array<{ name: string; bytes: Buffer; mediaType: string }> = [
    { name: 'text', bytes: textSample, mediaType: TEXT },
    { name: 'csv', bytes: csvSample, mediaType: CSV },
    { name: 'csv formula', bytes: csvFormulaSample, mediaType: CSV },
    { name: 'pdf', bytes: pdfSample(), mediaType: PDF },
    { name: 'active pdf', bytes: pdfSample({ javascript: true }), mediaType: PDF },
    { name: 'docx', bytes: await docxSample(), mediaType: DOCX },
    { name: 'png', bytes: pngSample, mediaType: PNG },
    // Multibyte UTF-8 split across the 1 MiB read boundary is still valid text.
    { name: 'utf8 split', bytes: Buffer.concat([Buffer.alloc(MiB - 1, 0x61), Buffer.from('é中文\n')]), mediaType: TEXT },
    { name: 'utf8 truncated', bytes: Buffer.concat([Buffer.alloc(MiB - 1, 0x61), Buffer.from('中').subarray(0, 2)]), mediaType: TEXT },
    { name: 'nul after first chunk', bytes: Buffer.concat([Buffer.alloc(MiB + 10, 0x61), Buffer.from([0])]), mediaType: TEXT },
    // An escaped quote and a CRLF straddling the boundary keep the CSV state machine in sync.
    { name: 'csv escaped quote seam', bytes: acrossBoundary('"a""b",1\r\n', 3), mediaType: CSV },
    { name: 'csv crlf seam', bytes: acrossBoundary('"ok",1\r\n=cmd,2\n', 8), mediaType: CSV },
    { name: 'csv formula after seam', bytes: acrossBoundary('ok,=1+1\n', 2), mediaType: CSV }
  ];
  for (const item of cases) {
    const memory = await outcome(() => verifiedMedia(item.bytes, item.mediaType));
    const file = await withFile(item.bytes, path => outcome(() => verifiedMediaFile(path, item.bytes.length, item.mediaType)));
    assert.equal(memory, `ok:${item.mediaType}`, item.name);
    assert.equal(file, memory, item.name);
  }
  const quoted = acrossBoundary('"a""b",1\r\n', 3), formula = acrossBoundary('ok,=1+1\n', 2);
  assert.ok(quoted.length > MiB && formula.length > MiB);
  assert.equal(await withFile(quoted, path => outcome(() => verifiedMediaFile(path, quoted.length, CSV))), `ok:${CSV}`);
  assert.equal(await withFile(formula, path => outcome(() => verifiedMediaFile(path, formula.length, CSV))), `ok:${CSV}`);
});

test('spooled PDF stays opaque while a mismatched stored size is rejected', async () => {
  const base = pdfSample();
  const body = Buffer.concat([base.subarray(0, base.length - 6), Buffer.from('\n%'), Buffer.alloc(MiB - base.length - 1, 0x20), Buffer.from('/Launch\n'), base.subarray(base.length - 6)]);
  // "/Launch" starts 3 bytes before the 1 MiB boundary.
  assert.equal(body.indexOf('/Launch') < MiB && body.indexOf('/Launch') + 7 > MiB, true);
  assert.equal(await withFile(body, path => outcome(() => verifiedMediaFile(path, body.length, PDF))), `ok:${PDF}`);
  assert.equal(await withFile(base, path => outcome(() => verifiedMediaFile(path, base.length + 1, PDF))), '422:MATERIAL_CONTENT_MISMATCH', 'declared size must match the file');
});

test('spool stream hashes bytes, rejects overruns and leaves no partial file behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-spool-dir-'));
  const previous = process.env.BB_UPLOAD_SPOOL_DIR;
  process.env.BB_UPLOAD_SPOOL_DIR = dir;
  try {
    const bytes = Buffer.alloc(3 * MiB + 7, 0x62);
    const ok = await spoolStream(Readable.from([bytes.subarray(0, MiB), bytes.subarray(MiB)]), bytes.length, () => new Problem(422, 'MATERIAL_CONTENT_MISMATCH', 'x'));
    assert.deepEqual([ok.byteSize, ok.sha256], [bytes.length, digest(bytes)]);
    await rm(ok.path);
    for (const size of [bytes.length - 1, bytes.length - 2 * MiB]) {
      await assert.rejects(spoolStream(Readable.from([bytes]), size, () => new Problem(422, 'MATERIAL_CONTENT_MISMATCH', 'x')), (error: unknown) => (error as Problem).code === 'MATERIAL_CONTENT_MISMATCH');
    }
    assert.deepEqual(await readdir(dir), []);
  } finally {
    if (previous === undefined) delete process.env.BB_UPLOAD_SPOOL_DIR; else process.env.BB_UPLOAD_SPOOL_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('spool reservations are capped and released once', () => {
  const previous = process.env.BB_UPLOAD_SPOOL_MAX_BYTES;
  process.env.BB_UPLOAD_SPOOL_MAX_BYTES = String(10 * MiB);
  try {
    const first = reserveSpool(6 * MiB);
    assert.throws(() => reserveSpool(5 * MiB), (error: unknown) => (error as Problem).status === 503);
    first();
    first();
    assert.equal(reservedSpoolBytes(), 0);
    reserveSpool(10 * MiB)();
  } finally {
    if (previous === undefined) delete process.env.BB_UPLOAD_SPOOL_MAX_BYTES; else process.env.BB_UPLOAD_SPOOL_MAX_BYTES = previous;
  }
});

test('PostgreSQL/Azurite streamed PUT verifies size and hash, stages Blob blocks and cleans the spool', { skip: !connection || !blobConnection }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-spool-put-'));
  const previous = process.env.BB_UPLOAD_SPOOL_DIR;
  process.env.BB_UPLOAD_SPOOL_DIR = dir;
  const pool = new Pool({ connectionString: connection });
  const ownerId = `spool-${randomUUID()}`;
  const containerName = `bb-spool-${randomUUID().replaceAll('-', '')}`;
  const blobs = azureBlobs(blobConnection!, containerName);
  const app = createServer({ pool, blobs, principal: async () => ({ userId: ownerId, csrfVerified: true }), allowedOrigin: origin });
  const send = (method: string, url: string, payload?: unknown, contentType = 'application/json') =>
    app.inject({ method: method as any, url, headers: { origin, 'content-type': contentType }, payload: payload as any });
  try {
    const project = await send('POST', '/api/v1/projects', { name: 'Synthetic Spool', kind: 'update', issuer_name: null, market: null, offering: null });
    assert.equal(project.statusCode, 201, project.body);
    const projectId = project.json().project_id;
    // 9 MiB of text crosses several read chunks and more than two 4 MiB Blob blocks.
    const text = Buffer.alloc(9 * MiB + 3, 0x61);
    text.write('\n', text.length - 1);
    const start = await send('POST', `/api/v1/projects/${projectId}/materials/uploads`, { filename: 'large.txt', media_type: TEXT, byte_size: text.length, sha256: digest(text), role: 'audit' });
    assert.equal(start.statusCode, 201, start.body);
    const url = start.json().upload_url;
    const short = await send('PUT', url, text.subarray(1), 'application/octet-stream');
    assert.equal(short.statusCode, 422, short.body);
    assert.equal(short.json().code, 'MATERIAL_CONTENT_MISMATCH');
    const tampered = Buffer.from(text);
    tampered[0] = 0x62;
    assert.equal((await send('PUT', url, tampered, 'application/octet-stream')).json().code, 'MATERIAL_CONTENT_MISMATCH');
    const put = await send('PUT', url, text, 'application/octet-stream');
    assert.equal(put.statusCode, 204, put.body);
    assert.equal((await send('PUT', url, text, 'application/octet-stream')).statusCode, 204, 'received retry stays idempotent');
    const complete = await send('POST', `/api/v1/projects/${projectId}/materials/uploads/${start.json().upload_id}/complete`, { byte_size: text.length, sha256: digest(text) });
    assert.equal(complete.statusCode, 200, complete.body);
    const stored = await blobs.get(`users/${ownerId}/projects/${projectId}/uploads/${start.json().upload_id}`);
    assert.equal(digest(stored), digest(text));
    assert.deepEqual(await readdir(dir), [], 'spool files are removed after success and failure');
  } finally {
    await pool.query('DELETE FROM bb_outbox WHERE owner_user_id=$1', [ownerId]);
    await app.close();
    await pool.end();
    await BlobServiceClient.fromConnectionString(blobConnection!).getContainerClient(containerName).deleteIfExists();
    if (previous === undefined) delete process.env.BB_UPLOAD_SPOOL_DIR; else process.env.BB_UPLOAD_SPOOL_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
