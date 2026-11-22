import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type { PrivateBlobs } from '@bondbuddy/api/data';
import { documentParserVersion } from '@bondbuddy/api/material-jobs';
import { DOCUMENT_PARSER_MAX_OUTPUT_BYTES } from './document-parser.js';
import { createRuntimeParseCache, runtimeParseCacheVersions } from './runtime-parse-cache.js';

test('runtime cache uses the shared parser setting and requires deployment OCR and basis versions', () => {
  assert.throws(() => runtimeParseCacheVersions({}), /BB_PARSE_CACHE_OCR_VERSION/);
  assert.throws(
    () => runtimeParseCacheVersions({ BB_PARSE_CACHE_OCR_VERSION: 'ocr-v1' }),
    /BB_PARSE_CACHE_BASIS_VERSION/,
  );
  const versions = runtimeParseCacheVersions({
    BB_PARSE_CACHE_OCR_VERSION: 'bondbuddy-ocr-1.0.0',
    BB_PARSE_CACHE_BASIS_VERSION: 'evidence-basis-v1',
  });
  assert.deepEqual(versions, {
    parserVersion: documentParserVersion(),
    ocrVersion: 'bondbuddy-ocr-1.0.0',
    basisVersion: 'evidence-basis-v1',
  });
});

test('runtime cache adapter reads and writes only through private Blob methods', async () => {
  const calls: Array<{
    method: string;
    key: string;
    bytes?: Uint8Array;
    mediaType?: string;
    maxBytes?: number;
  }> = [];
  const blobs = {
    async getIfExistsBounded(key: string, maxBytes: number) {
      calls.push({ method: 'getIfExistsBounded', key, maxBytes });
      return Buffer.from('cached');
    },
    async put(key: string, bytes: Buffer, mediaType: string) {
      calls.push({ method: 'put', key, bytes, mediaType });
    },
    async delete(key: string) {
      calls.push({ method: 'delete', key });
    },
  } as unknown as PrivateBlobs;
  const cache = createRuntimeParseCache({} as Pool, blobs, {
    parserVersion: 'parser-v1',
    ocrVersion: 'ocr-v1',
    basisVersion: 'basis-v1',
  });
  const bytes = Buffer.from('private parse snapshot');

  assert.deepEqual(
    await cache.dependencies.blobs.getPrivate('parse-cache/private/key'),
    Buffer.from('cached'),
  );
  await cache.dependencies.blobs.putPrivate('parse-cache/private/key', bytes);

  assert.deepEqual(
    calls.map((call) => call.method),
    ['getIfExistsBounded', 'put'],
  );
  assert.equal(calls[0]?.maxBytes, DOCUMENT_PARSER_MAX_OUTPUT_BYTES);
  assert.equal(calls[1]?.mediaType, 'application/json; charset=utf-8');
  assert.deepEqual(calls[1]?.bytes, bytes);
  await cache.dependencies.blobs.deletePrivate?.('parse-cache/private/key');
  assert.deepEqual(
    calls.map((call) => call.method),
    ['getIfExistsBounded', 'put', 'delete'],
  );
  assert.equal(cache.versions.parserVersion, 'parser-v1');
});
