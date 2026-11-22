import { createHash, randomUUID } from 'node:crypto';
import { parseCacheKey } from '@bondbuddy/domain/facts';
import {
  DOCUMENT_PARSER_MAX_OUTPUT_BYTES,
  DOCUMENT_PARSE_RESPONSE_VERSION,
  validateDocumentParseResponse,
  type DocumentParseRequest,
  type DocumentParseResponse,
} from './document-parser.js';

export interface ParseCacheVersions {
  parserVersion: string;
  ocrVersion: string;
  basisVersion: string;
}

export interface ParseCachePool {
  query(sql: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** These adapters must address private objects and must never make them public. */
export interface PrivateParseBlobStore {
  getPrivate(objectKey: string): Promise<Uint8Array | null>;
  putPrivate(objectKey: string, bytes: Uint8Array): Promise<void>;
  /** Optional cleanup for an object this exact save attempt created. */
  deletePrivate?(objectKey: string): Promise<void>;
}

export interface ParseCacheDependencies {
  pool: ParseCachePool;
  blobs: PrivateParseBlobStore;
}

export interface ParseCacheContext {
  ownerUserId: string;
  request: DocumentParseRequest;
  versions: ParseCacheVersions;
}

type CacheRow = {
  owner_user_id: string;
  content_sha256: string;
  parser_version: string;
  ocr_version: string;
  basis_version: string;
  result_state: string;
  object_key: string;
  object_sha256: string;
  object_bytes: string | number;
};

function cacheError(code: string): Error {
  const error = new Error(code);
  error.name = 'ParseCacheError';
  return error;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertCacheableContext(context: ParseCacheContext): void {
  if (!context.ownerUserId.trim()) throw cacheError('INVALID_CACHE_IDENTITY');
  if (context.request.options.max_pages !== undefined)
    throw cacheError('PARSE_CACHE_MAX_PAGES_UNSUPPORTED');
  // Reuse the domain's canonical identity validation and account-scoped key semantics.
  parseCacheKey({
    accountId: context.ownerUserId,
    fileSha256: context.request.material.sha256,
    parserVersion: context.versions.parserVersion,
    ocrVersion: context.versions.ocrVersion,
    basisVersion: context.versions.basisVersion,
  });
  if (context.request.material.sha256 !== context.request.material.sha256.toLowerCase()) {
    throw cacheError('INVALID_SHA256');
  }
}

function hasAuthorizedLocalPath(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasAuthorizedLocalPath);
  if (!isObject(value)) return false;
  return Object.entries(value).some(
    ([key, child]) => key === 'authorized_local_path' || hasAuthorizedLocalPath(child),
  );
}

function assertStrictCachedResponse(value: unknown): asserts value is DocumentParseResponse {
  if (
    !isObject(value) ||
    Object.keys(value).sort().join(',') !==
      'document,error,material,parser_version,records,request_id,schema_version,status,warnings' ||
    value.schema_version !== DOCUMENT_PARSE_RESPONSE_VERSION ||
    typeof value.request_id !== 'string' ||
    typeof value.parser_version !== 'string' ||
    !['parsed', 'needs_confirmation'].includes(String(value.status)) ||
    !isObject(value.material) ||
    !Array.isArray(value.records) ||
    !Array.isArray(value.warnings) ||
    !isObject(value.document) ||
    value.error !== null ||
    hasAuthorizedLocalPath(value)
  ) {
    throw cacheError('INVALID_PARSE_CACHE_OBJECT');
  }
  const material = value.material;
  if (
    Object.keys(material).sort().join(',') !== 'material_id,material_version,media_type,sha256' ||
    typeof material.material_id !== 'string' ||
    !Number.isSafeInteger(material.material_version) ||
    typeof material.media_type !== 'string' ||
    typeof material.sha256 !== 'string'
  ) {
    throw cacheError('INVALID_PARSE_CACHE_OBJECT');
  }
  for (const record of value.records) {
    if (
      !isObject(record) ||
      Object.keys(record).sort().join(',') !==
        'confidence,content_hash,context,extraction_method,extractor_version,formatting,literal_quote,locator,locator_type,material_id,material_version,record_id,uncertainty' ||
      typeof record.record_id !== 'string' ||
      typeof record.material_id !== 'string' ||
      !Number.isSafeInteger(record.material_version) ||
      typeof record.content_hash !== 'string' ||
      typeof record.locator_type !== 'string' ||
      !isObject(record.locator) ||
      typeof record.literal_quote !== 'string' ||
      typeof record.context !== 'string' ||
      record.extraction_method !== 'native_text' ||
      typeof record.extractor_version !== 'string' ||
      !(
        record.confidence === null ||
        (typeof record.confidence === 'number' &&
          Number.isFinite(record.confidence) &&
          record.confidence >= 0 &&
          record.confidence <= 1)
      ) ||
      !Array.isArray(record.uncertainty) ||
      !record.uncertainty.every((item) => typeof item === 'string') ||
      !isObject(record.formatting)
    ) {
      throw cacheError('INVALID_PARSE_CACHE_OBJECT');
    }
  }
  for (const warning of value.warnings) {
    if (
      !isObject(warning) ||
      Object.keys(warning).sort().join(',') !== 'code,message' ||
      typeof warning.code !== 'string' ||
      typeof warning.message !== 'string'
    )
      throw cacheError('INVALID_PARSE_CACHE_OBJECT');
  }
  if (
    !Object.hasOwn(value.document, 'page_count') ||
    !(
      value.document.page_count === null ||
      (Number.isSafeInteger(value.document.page_count) && Number(value.document.page_count) >= 0)
    )
  ) {
    throw cacheError('INVALID_PARSE_CACHE_OBJECT');
  }
}

function rowFrom(value: Record<string, unknown>): CacheRow {
  return value as unknown as CacheRow;
}

function assertRowMatches(row: CacheRow, context: ParseCacheContext): void {
  if (
    row.owner_user_id !== context.ownerUserId ||
    row.content_sha256 !== context.request.material.sha256 ||
    row.parser_version !== context.versions.parserVersion ||
    row.ocr_version !== context.versions.ocrVersion ||
    row.basis_version !== context.versions.basisVersion ||
    !['parsed', 'needs_confirmation'].includes(row.result_state) ||
    typeof row.object_key !== 'string' ||
    row.object_key.length === 0 ||
    typeof row.object_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.object_sha256)
  ) {
    throw cacheError('INVALID_PARSE_CACHE_METADATA');
  }
  const bytes = Number(row.object_bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw cacheError('INVALID_PARSE_CACHE_METADATA');
}

function responseForCurrentMaterial(
  value: unknown,
  context: ParseCacheContext,
): DocumentParseResponse {
  assertStrictCachedResponse(value);
  const originMaterial = value.material!;
  if (
    value.parser_version !== context.versions.parserVersion ||
    originMaterial.sha256 !== context.request.material.sha256 ||
    originMaterial.media_type !== context.request.material.media_type ||
    value.records.some(
      (record) =>
        record.material_id !== originMaterial.material_id ||
        record.material_version !== originMaterial.material_version ||
        record.content_hash !== context.request.material.sha256,
    )
  ) {
    throw cacheError('INVALID_PARSE_CACHE_OBJECT');
  }
  const rebound: DocumentParseResponse = {
    ...value,
    request_id: context.request.request_id,
    material: {
      material_id: context.request.material.material_id,
      material_version: context.request.material.material_version,
      media_type: context.request.material.media_type,
      sha256: context.request.material.sha256,
    },
    records: value.records.map((record) => ({
      ...record,
      material_id: context.request.material.material_id,
      material_version: context.request.material.material_version,
    })),
  };
  return validateDocumentParseResponse(rebound, context.request);
}

async function deleteAttemptObject(
  dependencies: ParseCacheDependencies,
  objectKey: string,
  checkReference: boolean,
): Promise<void> {
  if (!dependencies.blobs.deletePrivate) return;
  try {
    if (checkReference) {
      // A failed INSERT may have committed before its connection failed. Keep
      // the object if metadata now points to it; if this check is unavailable,
      // leave a harmless orphan rather than risk deleting a referenced cache.
      const reference = await dependencies.pool.query(
        'SELECT 1 FROM bb_parse_cache WHERE object_key = $1 LIMIT 1',
        [objectKey],
      );
      if (reference.rows.length !== 0) return;
    }
    await dependencies.blobs.deletePrivate(objectKey);
  } catch {
    // Cache cleanup is best effort and must not mask a parse or database error.
  }
}

/** Looks up only within the current owner and verifies private object integrity before reuse. */
export async function lookupParseCache(
  dependencies: ParseCacheDependencies,
  context: ParseCacheContext,
): Promise<DocumentParseResponse | null> {
  assertCacheableContext(context);
  const result = await dependencies.pool.query(
    `SELECT owner_user_id, content_sha256, parser_version, ocr_version, basis_version,
            result_state, object_key, object_sha256, object_bytes
       FROM bb_parse_cache
      WHERE owner_user_id = $1 AND content_sha256 = $2 AND parser_version = $3
        AND ocr_version = $4 AND basis_version = $5`,
    [
      context.ownerUserId,
      context.request.material.sha256,
      context.versions.parserVersion,
      context.versions.ocrVersion,
      context.versions.basisVersion,
    ],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw cacheError('INVALID_PARSE_CACHE_METADATA');
  const row = rowFrom(result.rows[0]!);
  assertRowMatches(row, context);
  const bytes = await dependencies.blobs.getPrivate(row.object_key);
  if (bytes === null) throw cacheError('PARSE_CACHE_OBJECT_MISSING');
  const actual = Buffer.from(bytes);
  if (
    actual.byteLength !== Number(row.object_bytes) ||
    createHash('sha256').update(actual).digest('hex') !== row.object_sha256
  ) {
    throw cacheError('PARSE_CACHE_OBJECT_CORRUPT');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(actual.toString('utf8'));
  } catch {
    throw cacheError('INVALID_PARSE_CACHE_OBJECT');
  }
  const rebound = responseForCurrentMaterial(parsed, context);
  if (rebound.status !== row.result_state) throw cacheError('INVALID_PARSE_CACHE_METADATA');
  return rebound;
}

/** Stores sanitized complete parses and best-effort removes this attempt's unreferenced Blob on conflict/error. */
export async function saveParseCache(
  dependencies: ParseCacheDependencies,
  context: ParseCacheContext,
  response: DocumentParseResponse,
  maxObjectBytes = DOCUMENT_PARSER_MAX_OUTPUT_BYTES,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(maxObjectBytes) ||
    maxObjectBytes < 1 ||
    maxObjectBytes > DOCUMENT_PARSER_MAX_OUTPUT_BYTES
  ) {
    throw cacheError('INVALID_PARSE_CACHE_LIMIT');
  }
  assertCacheableContext(context);
  const validated = validateDocumentParseResponse(response, context.request);
  if (validated.parser_version !== context.versions.parserVersion)
    throw cacheError('PARSE_CACHE_VERSION_MISMATCH');
  if (validated.status === 'failed') return false;
  assertStrictCachedResponse(validated);
  const bytes = Buffer.from(JSON.stringify(validated), 'utf8');
  if (bytes.byteLength > maxObjectBytes) return false;
  const objectSha256 = createHash('sha256').update(bytes).digest('hex');
  // Keep the private object namespace account-scoped as a second boundary in
  // addition to the owner predicate on bb_parse_cache. Hash the owner ID so
  // storage keys do not expose account identifiers to operational tooling.
  const ownerNamespace = createHash('sha256').update(context.ownerUserId).digest('hex');
  const objectKey = `parse-cache/${ownerNamespace}/${randomUUID()}`;
  try {
    await dependencies.blobs.putPrivate(objectKey, bytes);
  } catch (error) {
    await deleteAttemptObject(dependencies, objectKey, false);
    throw error;
  }
  let inserted: { rows: Record<string, unknown>[] };
  try {
    inserted = await dependencies.pool.query(
      `INSERT INTO bb_parse_cache
         (owner_user_id, content_sha256, parser_version, ocr_version, basis_version,
          result_state, object_key, object_sha256, object_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (owner_user_id, content_sha256, parser_version, ocr_version, basis_version) DO NOTHING
       RETURNING object_key`,
      [
        context.ownerUserId,
        context.request.material.sha256,
        context.versions.parserVersion,
        context.versions.ocrVersion,
        context.versions.basisVersion,
        validated.status,
        objectKey,
        objectSha256,
        bytes.byteLength,
      ],
    );
  } catch (error) {
    await deleteAttemptObject(dependencies, objectKey, true);
    throw error;
  }
  if (inserted.rows.length !== 1) await deleteAttemptObject(dependencies, objectKey, false);
  return inserted.rows.length === 1;
}
