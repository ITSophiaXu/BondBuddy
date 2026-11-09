import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { digest, type PrivateBlobs } from './data.js';
import { recordUploadIntegrity, verifyStoredUpload } from './upload-integrity.js';

const bytes = Buffer.from('synthetic immutable original');
const material = { owner_user_id: 'owner', project_id: 'project', id: 'material', version: 1, object_key: 'private-original', sha256: digest(bytes), byte_size: bytes.length };
function fixture() {
  const receipts: any[][] = [], calls: string[] = [];
  let etag = 'v1', body = bytes, captured = 'v1';
  const client = { query: async (sql: string, values: any[]) => {
    if (sql.startsWith('INSERT')) { receipts.push(values); return { rowCount: 1, rows: [] }; }
    const rows = receipts.filter(r => r.slice(0, 7).every((value, i) => String(value) === String(values[i]))).map(r => ({ object_etag: r[7] }));
    return { rowCount: rows.length, rows };
  } } as unknown as PoolClient;
  const blobs = {
    headVersion: async () => { calls.push('head'); return { etag, byteSize: body.length }; },
    readToFile: async () => { calls.push('full-read'); return { byteSize: body.length, sha256: digest(body), etag: captured }; },
  } as unknown as PrivateBlobs;
  return { client, blobs, calls, receipts, change: (version: string, value = bytes) => { etag = captured = version; body = value; }, race: () => { etag = 'v2'; captured = 'v1'; } };
}
test('legacy replay establishes evidence only by a full read, then matching stored version is fast', async () => {
  const f = fixture(); await verifyStoredUpload(f.client, f.blobs, material, true);
  assert.deepEqual(f.calls, ['full-read']); await verifyStoredUpload(f.client, f.blobs, material, true);
  assert.deepEqual(f.calls, ['full-read', 'head']);
});
test('first content reuse always reads the body even with existing version evidence', async () => {
  const f = fixture(); await verifyStoredUpload(f.client, f.blobs, material, true); f.calls.length = 0;
  await verifyStoredUpload(f.client, f.blobs, material, false); assert.deepEqual(f.calls, ['full-read']);
});
test('changed version revalidates same bytes; equal-size corruption is rejected', async () => {
  const f = fixture(); await verifyStoredUpload(f.client, f.blobs, material, true); f.calls.length = 0;
  f.change('v2'); await verifyStoredUpload(f.client, f.blobs, material, true); assert.deepEqual(f.calls, ['head', 'full-read']);
  f.change('v3', Buffer.alloc(bytes.length, 120)); await assert.rejects(verifyStoredUpload(f.client, f.blobs, material, true), /temporarily unavailable/);
  assert.equal(f.receipts.length, 2);
});
test('full-read version is not replaced by a later HEAD after a concurrent overwrite', async () => {
  const f = fixture(); f.race(); await verifyStoredUpload(f.client, f.blobs, material, true);
  assert.equal(f.receipts[0][7], 'v1'); await verifyStoredUpload(f.client, f.blobs, material, true);
  assert.deepEqual(f.calls, ['full-read', 'head', 'full-read']);
});
test('owner, project, object key, material version, hash and size cannot borrow another receipt', async () => {
  for (const change of [{owner_user_id:'other'}, {project_id:'other'}, {object_key:'other'}, {version:2}]) {
    const f = fixture(); await verifyStoredUpload(f.client, f.blobs, material, true); f.calls.length = 0;
    await verifyStoredUpload(f.client, f.blobs, {...material,...change}, true); assert.deepEqual(f.calls, ['full-read']);
  }
  const f = fixture(); await assert.rejects(recordUploadIntegrity(f.client, material, {byteSize:bytes.length,sha256:'a'.repeat(64),etag:'v1'})); assert.equal(f.receipts.length,0);
});
test('missing stored object rejects replay even though an integrity receipt exists', async () => {
  const f = fixture(); await verifyStoredUpload(f.client, f.blobs, material, true);
  f.blobs.headVersion = async () => null; await assert.rejects(verifyStoredUpload(f.client, f.blobs, material, true), /temporarily unavailable/);
});
