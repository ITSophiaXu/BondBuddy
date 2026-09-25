import type { Pool } from 'pg';
import { documentParserVersion } from '@bondbuddy/api/material-jobs';
import type { PrivateBlobs } from '@bondbuddy/api/data';
import type { ParseCacheDependencies, ParseCacheVersions } from './parse-cache.js';

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requiredVersion(name: string, value: string | undefined): string {
  if (!value || !VERSION_PATTERN.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

/**
 * The parser version comes from the same shared setting used when parse jobs are
 * created. OCR and evidence-basis versions are deployment-owned because their
 * implementations do not currently expose a shared runtime version contract.
 */
export function runtimeParseCacheVersions(env: NodeJS.ProcessEnv = process.env): ParseCacheVersions {
  return {
    parserVersion: requiredVersion('BB_DOCUMENT_PARSER_VERSION', documentParserVersion()),
    ocrVersion: requiredVersion('BB_PARSE_CACHE_OCR_VERSION', env.BB_PARSE_CACHE_OCR_VERSION),
    basisVersion: requiredVersion('BB_PARSE_CACHE_BASIS_VERSION', env.BB_PARSE_CACHE_BASIS_VERSION),
  };
}

/** Adapts the private account Blob container to the parse-cache repository. */
export function createRuntimeParseCache(pool: Pool, blobs: PrivateBlobs, versions: ParseCacheVersions): {
  dependencies: ParseCacheDependencies;
  versions: ParseCacheVersions;
} {
  for (const [name, value] of Object.entries(versions)) requiredVersion(`parse cache ${name}`, value);
  return {
    versions,
    dependencies: {
      pool,
      blobs: {
        getPrivate: key => blobs.getIfExists(key),
        putPrivate: (key, bytes) => blobs.put(key, Buffer.from(bytes), 'application/json; charset=utf-8'),
      },
    },
  };
}
