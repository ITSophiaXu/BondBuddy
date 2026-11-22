import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { DocumentParseRequest, DocumentParseResponse } from './document-parser.js';
import {
  lookupParseCache,
  saveParseCache,
  type ParseCacheContext,
  type ParseCacheDependencies,
  type ParseCachePool,
  type PrivateParseBlobStore,
} from './parse-cache.js';

const sha256 = 'a'.repeat(64);
const versions = { parserVersion: 'parser-v1', ocrVersion: 'ocr-v1', basisVersion: 'basis-v1' };

function request(materialId: string, version: number, requestId: string): DocumentParseRequest {
  return {
    schema_version: 'document-parse-request-v1',
    request_id: requestId,
    material: {
      material_id: materialId,
      material_version: version,
      media_type: 'text/plain',
      sha256,
      authorized_local_path: '/private/synthetic.txt',
    },
    options: {},
  };
}

function response(
  req: DocumentParseRequest,
  status: 'parsed' | 'needs_confirmation' | 'failed' = 'parsed',
): DocumentParseResponse {
  return {
    schema_version: 'document-parse-response-v1',
    request_id: req.request_id,
    parser_version: versions.parserVersion,
    status,
    material: {
      material_id: req.material.material_id,
      material_version: req.material.material_version,
      media_type: req.material.media_type,
      sha256: req.material.sha256,
    },
    records:
      status === 'failed'
        ? []
        : [
            {
              record_id: 'record-1',
              material_id: req.material.material_id,
              material_version: req.material.material_version,
              content_hash: req.material.sha256,
              locator_type: 'text_line',
              locator: { line: 1, stable_ref: 'text:l000001' },
              literal_quote: 'synthetic content',
              context: '',
              extraction_method: 'native_text',
              extractor_version: versions.parserVersion,
              confidence: null,
              uncertainty: [],
              formatting: {},
            },
          ],
    warnings: [],
    document: status === 'failed' ? { page_count: null } : { page_count: null, encoding: 'utf-8' },
    error: status === 'failed' ? { code: 'PARSE_FAILED', message: 'synthetic' } : null,
  };
}

function context(
  ownerUserId: string,
  req = request('origin-material', 1, 'origin-request'),
): ParseCacheContext {
  return { ownerUserId, request: req, versions };
}

function row(
  ownerUserId: string,
  req: DocumentParseRequest,
  bytes: Buffer,
  overrides: Record<string, unknown> = {},
) {
  return {
    owner_user_id: ownerUserId,
    content_sha256: req.material.sha256,
    parser_version: versions.parserVersion,
    ocr_version: versions.ocrVersion,
    basis_version: versions.basisVersion,
    result_state: 'parsed',
    object_key: 'parse-cache/private-object',
    object_sha256: createHash('sha256').update(bytes).digest('hex'),
    object_bytes: bytes.byteLength,
    ...overrides,
  };
}

class MockPool implements ParseCachePool {
  calls: Array<{ sql: string; values: unknown[] }> = [];
  rows: Record<string, unknown>[] = [];
  async query(sql: string, values: unknown[]) {
    this.calls.push({ sql, values });
    return { rows: this.rows };
  }
}

class MockBlobs implements PrivateParseBlobStore {
  objects = new Map<string, Uint8Array>();
  putCount = 0;
  deletedKeys: string[] = [];
  async getPrivate(objectKey: string) {
    return this.objects.get(objectKey) ?? null;
  }
  async putPrivate(objectKey: string, bytes: Uint8Array) {
    this.putCount += 1;
    this.objects.set(objectKey, bytes);
  }
  async deletePrivate(objectKey: string) {
    this.deletedKeys.push(objectKey);
    this.objects.delete(objectKey);
  }
}

function dependencies(
  pool: ParseCachePool = new MockPool(),
  blobs = new MockBlobs(),
): ParseCacheDependencies {
  return { pool, blobs };
}

test('same account reuses a renamed material and rebinds it to current material and request', async () => {
  const originRequest = request('origin-material', 1, 'origin-request');
  const payload = Buffer.from(JSON.stringify(response(originRequest)));
  const pool = new MockPool();
  const blobs = new MockBlobs();
  pool.rows = [row('owner-a', originRequest, payload)];
  blobs.objects.set('parse-cache/private-object', payload);

  const currentRequest = request('renamed-material', 4, 'current-request');
  const found = await lookupParseCache(
    dependencies(pool, blobs),
    context('owner-a', currentRequest),
  );

  assert.equal(found?.request_id, 'current-request');
  assert.equal(found?.material?.material_id, 'renamed-material');
  assert.equal(found?.material?.material_version, 4);
  assert.equal(found?.records[0]?.material_id, 'renamed-material');
  assert.equal(found?.records[0]?.material_version, 4);
  assert.deepEqual(pool.calls[0]?.values, ['owner-a', sha256, 'parser-v1', 'ocr-v1', 'basis-v1']);
});

test('lookup is scoped to the requested owner and cannot return another account cache row', async () => {
  const pool = new MockPool();
  const blobs = new MockBlobs();
  const otherOwnerRequest = request('other-material', 1, 'other-request');
  const payload = Buffer.from(JSON.stringify(response(otherOwnerRequest)));
  pool.rows = [];
  blobs.objects.set('parse-cache/private-object', payload);

  const found = await lookupParseCache(dependencies(pool, blobs), context('owner-b'));

  assert.equal(found, null);
  assert.match(pool.calls[0]?.sql ?? '', /WHERE owner_user_id = \$1 AND content_sha256 = \$2/);
  assert.deepEqual(pool.calls[0]?.values, ['owner-b', sha256, 'parser-v1', 'ocr-v1', 'basis-v1']);
});

test('corrupt cached bytes fail closed before response parsing', async () => {
  const pool = new MockPool();
  const blobs = new MockBlobs();
  const req = request('origin-material', 1, 'origin-request');
  const good = Buffer.from(JSON.stringify(response(req)));
  pool.rows = [row('owner-a', req, good)];
  blobs.objects.set('parse-cache/private-object', Buffer.from('tampered'));

  await assert.rejects(
    lookupParseCache(dependencies(pool, blobs), context('owner-a')),
    /PARSE_CACHE_OBJECT_CORRUPT/,
  );
});

test('cache metadata version mismatch fails closed', async () => {
  const pool = new MockPool();
  const blobs = new MockBlobs();
  const req = request('origin-material', 1, 'origin-request');
  const payload = Buffer.from(JSON.stringify(response(req)));
  pool.rows = [row('owner-a', req, payload, { ocr_version: 'ocr-old' })];
  blobs.objects.set('parse-cache/private-object', payload);

  await assert.rejects(
    lookupParseCache(dependencies(pool, blobs), context('owner-a')),
    /INVALID_PARSE_CACHE_METADATA/,
  );
});

test('metadata state and current media type must agree with the cached response', async () => {
  const req = request('origin-material', 1, 'origin-request');
  const payload = Buffer.from(JSON.stringify(response(req)));
  const pool = new MockPool();
  const blobs = new MockBlobs();
  pool.rows = [row('owner-a', req, payload, { result_state: 'needs_confirmation' })];
  blobs.objects.set('parse-cache/private-object', payload);
  await assert.rejects(
    lookupParseCache(dependencies(pool, blobs), context('owner-a')),
    /INVALID_PARSE_CACHE_METADATA/,
  );

  pool.rows = [row('owner-a', req, payload)];
  const differentMediaType = {
    ...req,
    material: { ...req.material, media_type: 'application/pdf' as const },
  };
  await assert.rejects(
    lookupParseCache(dependencies(pool, blobs), context('owner-a', differentMediaType)),
    /INVALID_PARSE_CACHE_OBJECT/,
  );
});

test('failed responses are not stored', async () => {
  const pool = new MockPool();
  const blobs = new MockBlobs();
  const req = request('origin-material', 1, 'origin-request');

  assert.equal(
    await saveParseCache(
      dependencies(pool, blobs),
      context('owner-a', req),
      response(req, 'failed'),
    ),
    false,
  );
  assert.equal(blobs.putCount, 0);
  assert.equal(pool.calls.length, 0);
});

test('max_pages requests are rejected because that option is outside the cache key', async () => {
  const req = request('origin-material', 1, 'origin-request');
  const capped = { ...req, options: { max_pages: 1 } };

  await assert.rejects(
    lookupParseCache(dependencies(), context('owner-a', capped)),
    /PARSE_CACHE_MAX_PAGES_UNSUPPORTED/,
  );
});

test('save writes only a current response to a private object and inserts metadata idempotently', async () => {
  const req = request('current-material', 2, 'current-request');
  const pool = new MockPool();
  pool.rows = [{ object_key: 'saved' }];
  const blobs = new MockBlobs();

  assert.equal(
    await saveParseCache(dependencies(pool, blobs), context('owner-a', req), response(req)),
    true,
  );
  assert.equal(blobs.putCount, 1);
  const ownerNamespace = createHash('sha256').update('owner-a').digest('hex');
  assert.match([...blobs.objects.keys()][0] ?? '', new RegExp(`^parse-cache/${ownerNamespace}/`));
  assert.match(
    pool.calls[0]?.sql ?? '',
    /ON CONFLICT \(owner_user_id, content_sha256, parser_version, ocr_version, basis_version\) DO NOTHING/,
  );
  assert.equal(
    JSON.stringify(
      [...blobs.objects.values()].map((bytes) => JSON.parse(Buffer.from(bytes).toString('utf8'))),
    ).includes('authorized_local_path'),
    false,
  );
});

test('oversized serialized cache responses remain valid but are not stored', async () => {
  const req = request('current-material', 2, 'current-request');
  const oversized = response(req);
  oversized.records[0]!.formatting = { synthetic: 'x'.repeat(2048) };
  const pool = new MockPool();
  const blobs = new MockBlobs();

  assert.equal(
    await saveParseCache(dependencies(pool, blobs), context('owner-a', req), oversized, 1024),
    false,
  );
  assert.equal(blobs.putCount, 0);
  assert.equal(pool.calls.length, 0);
  await assert.rejects(
    saveParseCache(
      dependencies(pool, blobs),
      context('owner-a', req),
      response(req),
      Number.MAX_SAFE_INTEGER,
    ),
    /INVALID_PARSE_CACHE_LIMIT/,
  );
  assert.equal(blobs.putCount, 0);
  assert.equal(pool.calls.length, 0);
});

test('save rejects a response bound to another material before writing anything', async () => {
  const req = request('current-material', 2, 'current-request');
  const oldResponse = response(req);
  oldResponse.material = {
    ...oldResponse.material!,
    material_id: 'old-material',
    material_version: 1,
  };
  oldResponse.records[0]!.material_id = 'old-material';
  oldResponse.records[0]!.material_version = 1;
  const pool = new MockPool();
  const blobs = new MockBlobs();

  await assert.rejects(
    saveParseCache(dependencies(pool, blobs), context('owner-a', req), oldResponse),
    /PARSE_MATERIAL_IDENTITY_MISMATCH/,
  );
  assert.equal(pool.calls.length, 0);
  assert.equal(blobs.putCount, 0);
});

test('concurrent cache insert loser deletes only the Blob object created by its attempt', async () => {
  const req = request('current-material', 2, 'current-request');
  const pool = new MockPool();
  const blobs = new MockBlobs();
  blobs.objects.set('parse-cache/winning-object', Buffer.from('winner'));

  assert.equal(
    await saveParseCache(dependencies(pool, blobs), context('owner-a', req), response(req)),
    false,
  );
  assert.equal(blobs.deletedKeys.length, 1);
  assert.equal(blobs.objects.has(blobs.deletedKeys[0]!), false);
  assert.equal(blobs.objects.has('parse-cache/winning-object'), true);
});

test('uncertain cache insert error preserves an object if metadata references it', async () => {
  const req = request('current-material', 2, 'current-request');
  let attemptObjectKey = '';
  const pool = {
    async query(sql: string, values: unknown[]) {
      if (sql.includes('INSERT INTO bb_parse_cache')) {
        attemptObjectKey = String(values[6]);
        throw new Error('synthetic connection lost after commit');
      }
      assert.match(sql, /SELECT 1 FROM bb_parse_cache WHERE object_key = \$1/);
      return { rows: [{ object_key: attemptObjectKey }] };
    },
  };
  const blobs = new MockBlobs();

  await assert.rejects(
    saveParseCache(dependencies(pool, blobs), context('owner-a', req), response(req)),
    /synthetic connection lost after commit/,
  );
  assert.ok(attemptObjectKey);
  assert.equal(blobs.deletedKeys.includes(attemptObjectKey), false);
  assert.equal(blobs.objects.has(attemptObjectKey), true);
});

test('cache insert error deletes its object when metadata confirms it is unreferenced', async () => {
  const req = request('current-material', 2, 'current-request');
  let attemptObjectKey = '';
  const pool = {
    async query(sql: string, values: unknown[]) {
      if (sql.includes('INSERT INTO bb_parse_cache')) {
        attemptObjectKey = String(values[6]);
        throw new Error('synthetic database failure');
      }
      return { rows: [] };
    },
  };
  const blobs = new MockBlobs();

  await assert.rejects(
    saveParseCache(dependencies(pool, blobs), context('owner-a', req), response(req)),
    /synthetic database failure/,
  );
  assert.ok(attemptObjectKey);
  assert.deepEqual(blobs.deletedKeys, [attemptObjectKey]);
  assert.equal(blobs.objects.has(attemptObjectKey), false);
});

test('cached payloads containing a staged local path are rejected', async () => {
  const req = request('origin-material', 1, 'origin-request');
  const unsafe = {
    ...response(req),
    document: { page_count: null, nested: { authorized_local_path: '/private/file' } },
  };
  const payload = Buffer.from(JSON.stringify(unsafe));
  const pool = new MockPool();
  const blobs = new MockBlobs();
  pool.rows = [row('owner-a', req, payload)];
  blobs.objects.set('parse-cache/private-object', payload);

  await assert.rejects(
    lookupParseCache(dependencies(pool, blobs), context('owner-a')),
    /INVALID_PARSE_CACHE_OBJECT/,
  );
});
