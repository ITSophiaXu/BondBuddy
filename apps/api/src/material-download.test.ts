import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { azureBlobs, digest } from './data.js';
import { contentDisposition, verifyingStream } from './material-download.js';
import { createServer } from './server.js';
import { DOCX, docxSample } from './upload-safety.samples.js';

const connection = process.env.BB_TEST_DATABASE_URL;
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const origin = 'http://bondbuddy.test';

async function drain(chunks: Buffer[], sha: string, size: number): Promise<{ received: Buffer; error: unknown; alerts: number }> {
  let alerts = 0;
  const received: Buffer[] = [];
  const sink = new Writable({ write(chunk, _encoding, done) { received.push(chunk); done(); } });
  let error: unknown = null;
  try { await pipeline(Readable.from(chunks), verifyingStream(sha, size, async () => { alerts++; }), sink); }
  catch (caught) { error = caught; }
  return { received: Buffer.concat(received), error, alerts };
}

test('verified material stream passes matching bytes and withholds the last chunk on mismatch', async () => {
  const chunks = [Buffer.from('synthetic-'), Buffer.from('material-'), Buffer.from('bytes')];
  const whole = Buffer.concat(chunks);
  const ok = await drain(chunks, digest(whole), whole.length);
  assert.equal(ok.error, null);
  assert.deepEqual(ok.received, whole);
  assert.equal(ok.alerts, 0);

  const bad = await drain(chunks, 'a'.repeat(64), whole.length);
  assert.equal((bad.error as { code?: string })?.code, 'DATA_UNAVAILABLE');
  assert.ok(bad.received.length < whole.length, 'the final chunk is never released');
  assert.equal(bad.alerts, 1);

  const long = await drain(chunks, digest(whole), whole.length - 1);
  assert.equal((long.error as { code?: string })?.code, 'DATA_UNAVAILABLE');
  assert.equal(long.alerts, 1);

  assert.equal(contentDisposition('合成 "材料".docx'), `attachment; filename="__ ____.docx"; filename*=UTF-8''%E5%90%88%E6%88%90%20%22%E6%9D%90%E6%96%99%22.docx`);
});

test('PostgreSQL/Azurite material download streams verified bytes, keeps owner 404 and fails closed on corruption', { skip: !connection || !blobConnection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const containerName = `bb-download-${randomUUID().replaceAll('-', '')}`;
  const blobs = azureBlobs(blobConnection!, containerName);
  let active = `download-${randomUUID()}`;
  const owner = active;
  const app = createServer({ pool, blobs, principal: async () => ({ userId: active, csrfVerified: true }), allowedOrigin: origin });
  const send = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => app.inject({ method: method as any, url, headers: { origin, ...headers }, payload: payload as any });
  try {
    const project = (await send('POST', '/api/v1/projects', { name: 'Synthetic download', kind: 'update', issuer_name: null, market: 'nafmii', offering: 'mtn' })).json().project_id;
    const bytes = await docxSample(), sha = digest(bytes);
    const upload = await send('POST', `/api/v1/projects/${project}/materials/uploads`, { filename: '合成材料.docx', media_type: DOCX, byte_size: bytes.length, sha256: sha, role: 'audit' });
    assert.equal(upload.statusCode, 201, upload.body);
    assert.equal((await send('PUT', upload.json().upload_url, bytes, { 'content-type': 'application/octet-stream' })).statusCode, 204);
    const complete = await send('POST', `/api/v1/projects/${project}/materials/uploads/${upload.json().upload_id}/complete`, { byte_size: bytes.length, sha256: sha });
    assert.equal(complete.statusCode, 200, complete.body);
    const url = `/api/v1/projects/${project}/materials/${complete.json().material_id}/download`;

    const ok = await send('GET', url);
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.rawPayload, bytes);
    assert.equal(ok.headers['content-type'], DOCX);
    assert.equal(ok.headers['cache-control'], 'private, no-store');
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.equal(ok.headers['content-length'], String(bytes.length));
    assert.match(String(ok.headers['content-disposition']), /^attachment; filename="[^"]*"; filename\*=UTF-8''%E5%90%88/);

    active = `download-foreign-${randomUUID()}`;
    assert.equal((await send('GET', url)).statusCode, 404);
    active = owner;

    const key = (await pool.query('SELECT object_key FROM bb_material_versions WHERE owner_user_id=$1 AND id=$2', [owner, complete.json().material_id])).rows[0].object_key;
    const errors = async () => (await pool.query("SELECT safe_message_code FROM bb_observability_errors WHERE owner_user_id=$1 AND stage='material_download' ORDER BY created_at", [owner])).rows.map(row => row.safe_message_code);

    // Same length, different bytes: the stream is aborted before its end and an alert is recorded.
    const flipped = Buffer.from(bytes); flipped[flipped.length - 1] ^= 0xff;
    await blobs.put(key, flipped, DOCX);
    let truncated = true;
    try { const corrupt = await send('GET', url); truncated = corrupt.statusCode !== 200 || corrupt.rawPayload.length < bytes.length; }
    catch { truncated = true; }
    assert.ok(truncated, 'a corrupted object never completes a download');
    assert.deepEqual(await errors(), ['material_integrity_mismatch']);

    // A different stored length is rejected before any byte is sent.
    await blobs.put(key, Buffer.concat([bytes, Buffer.from('x')]), DOCX);
    const resized = await send('GET', url);
    assert.equal(resized.statusCode, 503);
    assert.equal(resized.json().code, 'DATA_UNAVAILABLE');
    assert.deepEqual(await errors(), ['material_integrity_mismatch', 'material_size_mismatch']);
  } finally {
    await app.close();
    await pool.end();
  }
});
