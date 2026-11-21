import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { createServer } from './server.js';
import { digest, type PrivateBlobs } from './data.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';
import { createCachedArtifactReader } from './artifact-reader.js';

test('metadata and bytes reuse a checked object only while its stored version is unchanged', async () => {
  const expected = makeSyntheticDocxFixture();
  let bytes = expected, etag = 'synthetic-v1', reads = 0, grants = 0, allowed = true;
  const query = async (sql: string) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('FROM bb_artifact_versions a')) return { rows: allowed ? [{
      id: 'synthetic-artifact', owner_user_id: 'synthetic-owner', project_id: 'synthetic-project',
      run_id: 'synthetic-run', version: 1,
      media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sha256: digest(expected), object_key: 'synthetic/artifact', delivery_evidence_byte_size: expected.length,
      quality_status: 'passed', delivery_status: 'available',
    }] : [] };
    if (sql.includes('FROM bb_jobs')) return { rows: [] };
    if (sql.includes('SELECT 1 FROM bb_artifact_download_grants')) return { rows: [{}] };
    if (sql.includes('INSERT INTO bb_artifact_download_grants')) { grants++; return { rows: [] }; }
    if (sql.includes('SELECT channel FROM bb_runs')) return { rows: [{ channel: 'production' }], rowCount: 1 };
    if (/INSERT INTO bb_(operations|observability_events|outbox)/.test(sql)) return { rows: [], rowCount: 1 };
    throw Error('unexpected synthetic artifact query');
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  const blobs = {
    headVersion: async () => ({ etag, byteSize: bytes.length }),
    getIfExistsBounded: async (_key: string, maximum: number) => {
      reads++;
      assert.equal(maximum, expected.length);
      return bytes;
    },
  } as unknown as PrivateBlobs;
  const app = createServer({ pool, blobs, principal: async () => ({ userId: 'synthetic-owner', csrfVerified: true }) });
  try {
    const metadata = await app.inject('/api/v1/artifacts/synthetic-artifact');
    assert.equal(metadata.statusCode, 200, metadata.body);
    assert.ok(metadata.headers['x-bb-request-id']);
    const download = await app.inject(metadata.json().download_url);
    assert.equal(download.statusCode, 200, download.body);
    assert.ok(download.headers['x-bb-request-id']);
    assert.deepEqual(download.rawPayload, expected);
    assert.equal(reads, 1, 'metadata and binary must not repeat a full read of the same checked stored version');

    allowed = false;
    assert.equal((await app.inject(metadata.json().download_url)).statusCode, 404, 'cached bytes never bypass current ownership and delivery checks');
    allowed = true;
    bytes = Buffer.from(expected);
    bytes[bytes.length - 1] ^= 1;
    etag = 'synthetic-v2';
    assert.equal((await app.inject(metadata.json().download_url)).statusCode, 503, 'a changed ETag requires a new complete integrity proof');
    assert.equal((await app.inject('/api/v1/artifacts/synthetic-artifact')).statusCode, 503);
    assert.equal(grants, 1, 'changed corrupt bytes receive no additional grant');
  } finally { await app.close(); }
});

const cacheBytes = Buffer.from('synthetic checked artifact');
const cacheArtifact = { id: 'synthetic-artifact', owner_user_id: 'synthetic-owner', run_id: 'synthetic-run', version: 1,
  media_type: 'text/plain', object_key: 'synthetic/key', sha256: digest(cacheBytes), delivery_evidence_byte_size: cacheBytes.length };
const integrityFailure = { status: 503, code: 'DATA_UNAVAILABLE' };

test('checked-byte cache merges concurrent reads and returns isolated buffers', async () => {
  let release!: () => void, reads = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blobs = { headVersion: async () => ({ etag: 'synthetic-v1', byteSize: cacheBytes.length }), get: async () => { reads++; await gate; return cacheBytes; } } as unknown as PrivateBlobs;
  const cache = createCachedArtifactReader(blobs);
  const first = cache.read(cacheArtifact), second = cache.read(cacheArtifact);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(reads, 1); release();
  const [a, b] = await Promise.all([first, second]); a[0] ^= 1;
  assert.deepEqual(b, cacheBytes);
  b[0] ^= 1;
  assert.deepEqual(await cache.read(cacheArtifact), cacheBytes);
  assert.equal(reads, 1);
});

test('cache TTL, capacity, identity and changed ETags require another full integrity proof', async () => {
  let reads = 0, currentTime = 0, etag = 'synthetic-v1';
  const blobs = { headVersion: async () => ({ etag, byteSize: cacheBytes.length }), get: async () => { reads++; return cacheBytes; } } as unknown as PrivateBlobs;
  const cache = createCachedArtifactReader(blobs, { ttlMs: 60, maxBytes: cacheBytes.length, maxEntries: 1, now: () => currentTime });
  await cache.read(cacheArtifact); await cache.read(cacheArtifact); assert.equal(reads, 1);
  currentTime = 60; await cache.read(cacheArtifact); assert.equal(reads, 2);
  etag = 'synthetic-v2'; await cache.read(cacheArtifact); assert.equal(reads, 3);
  await cache.read({ ...cacheArtifact, owner_user_id: 'another-owner' }); assert.equal(reads, 4);
  await cache.read(cacheArtifact); assert.equal(reads, 5);
  cache.clear(); await cache.read(cacheArtifact); assert.equal(reads, 6);
});

test('missing HEAD capability or an unbound artifact always uses the original cold verifier', async () => {
  let reads = 0;
  const get = async () => { reads++; return cacheBytes; };
  const cold = createCachedArtifactReader({ get } as unknown as PrivateBlobs);
  await cold.read(cacheArtifact); await cold.read(cacheArtifact); assert.equal(reads, 2);
  const unbound = createCachedArtifactReader({ get, headVersion: async () => ({ etag: 'synthetic-v1', byteSize: cacheBytes.length }) } as unknown as PrivateBlobs);
  await unbound.read({ ...cacheArtifact, owner_user_id: undefined }); await unbound.read({ ...cacheArtifact, owner_user_id: undefined });
  assert.equal(reads, 4);
});

test('unavailable or changed storage HEAD never permits cached bytes or a new cache receipt', async () => {
  let invalid: 'missing' | 'size' | 'error' | undefined, heads = 0;
  const cache = createCachedArtifactReader({ get: async () => cacheBytes, headVersion: async () => {
    heads++;
    if (invalid === 'error') throw Error('synthetic unavailable');
    return invalid === 'missing' ? null : { etag: 'synthetic-v1', byteSize: cacheBytes.length + (invalid === 'size' ? 1 : 0) };
  } } as unknown as PrivateBlobs);
  await cache.read(cacheArtifact);
  for (invalid of ['missing', 'size', 'error'] as const) await assert.rejects(cache.read(cacheArtifact), integrityFailure);
  assert.equal(heads, 5);
  let version = 0, reads = 0;
  const changed = createCachedArtifactReader({ get: async () => { reads++; return cacheBytes; }, headVersion: async () => ({ etag: `synthetic-v${version++}`, byteSize: cacheBytes.length }) } as unknown as PrivateBlobs);
  await assert.rejects(changed.read(cacheArtifact), integrityFailure);
  await assert.rejects(changed.read(cacheArtifact), integrityFailure);
  assert.equal(reads, 2, 'a version changing during verification cannot create a reusable receipt');
});

test('a storage response whose bytes disagree with the HEAD size never enters the bounded cache', async () => {
  const cache = createCachedArtifactReader({ get: async () => cacheBytes, headVersion: async () => ({ etag: 'synthetic-v1', byteSize: 1 }) } as unknown as PrivateBlobs, { maxBytes: 1 });
  await assert.rejects(cache.read({ ...cacheArtifact, delivery_evidence_byte_size: 1 }), integrityFailure);
});
