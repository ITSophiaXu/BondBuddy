import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Pool } from 'pg';
import { documentParserVersion } from '@bondbuddy/api/material-jobs';
import { DOCUMENT_PARSER_STREAM_MAX_TEXT_BYTES, runDocumentParser, type DocumentParseRequest, type DocumentParseResponse } from './document-parser.js';
import {
  M1_PARSE_BYTE_LIMITS,
  M1_PARSE_OUTPUT_BUDGET_BYTES,
  M1_PARSE_STREAM_OUTPUT_BUDGET_BYTES,
  parseAuthorizedMaterial,
  parseAuthorizedMaterialToStream,
  type MaterialParserDependencies,
  type MaterialParserPool,
} from './material-parser.js';
import { classifyMaterialParseError } from './material-parse-job.js';
import type { ParseCacheDependencies, ParseCacheVersions } from './parse-cache.js';
import { isolatedTestDatabase } from './test-database.js';

const testDatabaseUrl = await isolatedTestDatabase('MATERIAL_CACHE_TEST_DATABASE_URL');

const bytes = Buffer.from('synthetic authorized material\n', 'utf8');
const hash = createHash('sha256').update(bytes).digest('hex');
const row: Record<string, unknown> = {
  owner_user_id: 'owner-alice',
  project_id: 'project-synthetic',
  id: 'material-synthetic',
  version: 2,
  media_type: 'text/plain',
  byte_size: bytes.byteLength,
  sha256: hash,
  object_key: 'private/users/owner-alice/project-synthetic/material-synthetic/v2',
  role: 'historical',
};
const input = {
  ownerUserId: 'owner-alice',
  projectId: 'project-synthetic',
  materialId: 'material-synthetic',
  version: 2,
  requestId: 'parse-synthetic',
  options: { max_pages: 12 },
};

function responseFor(request: DocumentParseRequest): DocumentParseResponse {
  return {
    schema_version: 'document-parse-response-v1',
    request_id: request.request_id,
    parser_version: 'bondbuddy-document-parser-1.0.0',
    status: 'parsed',
    material: {
      material_id: request.material.material_id,
      material_version: request.material.material_version,
      media_type: request.material.media_type,
      sha256: request.material.sha256,
    },
    records: [{
      record_id: 'evidence-000001',
      material_id: request.material.material_id,
      material_version: request.material.material_version,
      content_hash: request.material.sha256,
      locator_type: 'text_line',
      locator: { line: 1, stable_ref: 'text:l000001' },
      literal_quote: 'synthetic authorized material',
      context: '',
      extraction_method: 'native_text',
      extractor_version: 'bondbuddy-document-parser-1.0.0',
      confidence: null,
      uncertainty: [],
      formatting: {},
    }],
    warnings: [],
    document: { page_count: null, encoding: 'utf-8' },
    error: null,
  };
}

async function temporaryRoot(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'bb-material-parser-test-')));
}

function dependencies(options: {
  material?: Record<string, unknown> | null;
  bytes?: Uint8Array | null;
  onBlob?: (key: string) => void;
  parser?: MaterialParserDependencies['parser'];
  parseCache?: MaterialParserDependencies['parseCache'];
  tempRoot?: string;
}): MaterialParserDependencies {
  const pool: MaterialParserPool = {
    async query(sql, values) {
      assert.match(sql, /owner_user_id\s*=\s*\$1/);
      assert.match(sql, /project_id\s*=\s*\$2/);
      assert.match(sql, /id\s*=\s*\$3/);
      assert.match(sql, /version\s*=\s*\$4/);
      assert.match(sql, /role\s*=\s*\$5/);
      assert.match(sql, /deleted_at\s+IS\s+NULL/);
      const material = options.material ?? row;
      const matches = values[0] === material.owner_user_id && values[1] === material.project_id &&
        values[2] === material.id && values[3] === material.version &&
        (values[4] === null || values[4] === material.role);
      return { rows: matches && options.material !== null ? [material] : [] };
    },
  };
  return {
    pool,
    blobs: {
      async getPrivate(key) {
        options.onBlob?.(key);
        return options.bytes === undefined ? bytes : options.bytes;
      },
    },
    ...(options.parser === undefined ? {} : { parser: options.parser }),
    ...(options.parseCache === undefined ? {} : { parseCache: options.parseCache }),
    tempRoot: options.tempRoot,
  };
}

function cacheHarness() {
  const rows = new Map<string, Record<string, unknown>>();
  const objects = new Map<string, Uint8Array>();
  const dependencies: ParseCacheDependencies = {
    pool: {
      async query(sql, values) {
        if (sql.includes('FROM bb_parse_cache')) {
          const key = values.slice(0, 5).join('|');
          const cached = rows.get(key);
          return { rows: cached === undefined ? [] : [cached] };
        }
        assert.match(sql, /INSERT INTO bb_parse_cache/);
        const [owner, contentHash, parserVersion, ocrVersion, basisVersion, state, objectKey, objectHash, objectBytes] = values;
        const key = [owner, contentHash, parserVersion, ocrVersion, basisVersion].join('|');
        if (rows.has(key)) return { rows: [] };
        rows.set(key, {
          owner_user_id: owner,
          content_sha256: contentHash,
          parser_version: parserVersion,
          ocr_version: ocrVersion,
          basis_version: basisVersion,
          result_state: state,
          object_key: objectKey,
          object_sha256: objectHash,
          object_bytes: objectBytes,
        });
        return { rows: [{ object_key: objectKey }] };
      },
    },
    blobs: {
      async getPrivate(key) { return objects.get(key) ?? null; },
      async putPrivate(key, value) { objects.set(key, Buffer.from(value)); },
    },
  };
  const versions: ParseCacheVersions = {
    parserVersion: 'bondbuddy-document-parser-1.0.0',
    ocrVersion: 'native-text-1',
    basisVersion: 'evidence-basis-1',
  };
  return {
    adapter: { dependencies, versions },
    rows,
    objects,
    corruptFirstObject() {
      const value = rows.values().next().value as Record<string, unknown> | undefined;
      if (value !== undefined) objects.set(String(value.object_key), Buffer.from('corrupt cache object'));
    },
    poisonFirstObject(reference: string) {
      const row = rows.values().next().value as Record<string, unknown> | undefined;
      if (row === undefined) return;
      const key = String(row.object_key);
      const value = JSON.parse(Buffer.from(objects.get(key)!).toString('utf8')) as DocumentParseResponse;
      value.records[0]!.literal_quote = reference;
      const bytes = Buffer.from(JSON.stringify(value), 'utf8');
      objects.set(key, bytes);
      row.object_sha256 = createHash('sha256').update(bytes).digest('hex');
      row.object_bytes = bytes.byteLength;
    },
    size: () => rows.size,
  };
}

test('bridge scopes the lookup to owner, project, material and version, and hides misses', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const deps = dependencies({ tempRoot: root, material: null });
  await assert.rejects(parseAuthorizedMaterial(deps, { ...input, ownerUserId: 'owner-bob' }), (error: Error) => {
    assert.equal(error.message, 'NOT_FOUND');
    assert.equal(error.name, 'MaterialParserError');
    return true;
  });
  await assert.rejects(parseAuthorizedMaterial(deps, { ...input, projectId: 'project-other' }), /NOT_FOUND/);
  await assert.rejects(parseAuthorizedMaterial(deps, { ...input, version: 1 }), /NOT_FOUND/);
});

test('bridge rejects blob hash or size mismatch before staging or parsing', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  let parserCalls = 0;
  const parser = async (request: DocumentParseRequest) => { parserCalls += 1; return responseFor(request); };
  await assert.rejects(parseAuthorizedMaterial(dependencies({ tempRoot: root, bytes: Buffer.from('other'), parser }), input), /MATERIAL_INTEGRITY_MISMATCH/);
  await assert.rejects(parseAuthorizedMaterial(dependencies({
    tempRoot: root,
    material: { ...row, byte_size: bytes.byteLength + 1 },
    parser,
  }), input), /MATERIAL_INTEGRITY_MISMATCH/);
  assert.equal(parserCalls, 0);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('bb-material-')), []);
});

test('unsupported media types are rejected without fetching bytes or invoking parser', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  let blobCalls = 0;
  let parserCalls = 0;
  const deps = dependencies({
    tempRoot: root,
    material: { ...row, media_type: 'application/octet-stream' },
    onBlob: () => { blobCalls += 1; },
    parser: async (request) => { parserCalls += 1; return responseFor(request); },
  });
  await assert.rejects(parseAuthorizedMaterial(deps, input), /UNSUPPORTED_MEDIA_TYPE/);
  assert.equal(blobCalls, 0);
  assert.equal(parserCalls, 0);
});

test('XLSX staging uses a trusted suffix required by openpyxl and removes the private copy', async t => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const deps = dependencies({
    tempRoot: root,
    material: { ...row, media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', role: 'financial' },
    parser: async request => {
      assert.equal(request.material.authorized_local_path.split('/').at(-1), 'source.xlsx');
      assert.deepEqual(await readFile(request.material.authorized_local_path), bytes);
      return { ...responseFor(request), status: 'failed', records: [], document: { page_count: null },
        error: { code: 'SYNTHETIC_FAILURE', message: 'synthetic parser failure' } };
    },
  });
  const result = await parseAuthorizedMaterial(deps, input);
  assert.equal(result.status, 'failed');
  assert.equal((await readdir(root)).filter(name => name.startsWith('bb-material-')).length, 0);
});

test('#17 capacity: oversized materials fail before any byte is read, and over-budget output is its own code', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(M1_PARSE_BYTE_LIMITS['text/plain'], 20 * 1024 * 1024);
  assert.equal(M1_PARSE_BYTE_LIMITS['application/pdf'], 100 * 1024 * 1024);
  assert.equal(M1_PARSE_OUTPUT_BUDGET_BYTES, 16 * 1024 * 1024);
  let blobCalls = 0;
  let parserCalls = 0;
  const limited = { ...dependencies({ tempRoot: root, onBlob: () => { blobCalls += 1; },
    parser: async (request) => { parserCalls += 1; return responseFor(request); } }), byteLimits: { 'text/plain': bytes.byteLength - 1 } };
  await assert.rejects(parseAuthorizedMaterial(limited, input), /MATERIAL_PARSE_SIZE_LIMIT/);
  assert.equal(blobCalls, 0);
  assert.equal(parserCalls, 0);
  const overBudget = dependencies({ tempRoot: root, parser: async () => { throw new Error('DOCUMENT_PARSER_OUTPUT_LIMIT'); } });
  await assert.rejects(parseAuthorizedMaterial(overBudget, input), /MATERIAL_PARSE_OUTPUT_LIMIT/);
  const oomKilled = dependencies({ tempRoot: root, parser: async () => { throw new Error('DOCUMENT_PARSER_MEMORY_LIMIT'); } });
  await assert.rejects(parseAuthorizedMaterial(oomKilled, input), /MATERIAL_PARSE_MEMORY_LIMIT/);
  const timedOut = dependencies({ tempRoot: root, parser: async () => { throw new Error('DOCUMENT_PARSER_TIMEOUT'); } });
  await assert.rejects(parseAuthorizedMaterial(timedOut, input), /MATERIAL_PARSE_TIMEOUT/);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('bb-material-')), []);
});

test('#17 bridge streams bytes to the staging file when the store supports it and still verifies them', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { writeFile } = await import('node:fs/promises');
  const limits: number[] = [];
  const streaming = (content: Buffer): MaterialParserDependencies => ({
    ...dependencies({ tempRoot: root, parser: async (request) => {
      assert.deepEqual(await readFile(request.material.authorized_local_path), bytes);
      return responseFor(request);
    } }),
    blobs: {
      async getPrivate() { throw new Error('buffered read must not be used'); },
      async readToFile(_key, path, maxBytes) {
        limits.push(maxBytes);
        await writeFile(path, content, { flag: 'wx', mode: 0o600 });
        return { byteSize: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') };
      },
    },
  });
  const response = await parseAuthorizedMaterial(streaming(bytes), input);
  assert.equal(response.status, 'parsed');
  assert.deepEqual(limits, [bytes.byteLength]);
  await assert.rejects(parseAuthorizedMaterial(streaming(Buffer.from('tampered')), input), /MATERIAL_INTEGRITY_MISMATCH/);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('bb-material-')), []);
});

test('bridge binds parser request and response to the authorized immutable material and cleans up', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  let stagedPath = '';
  const deps = dependencies({
    tempRoot: root,
    parser: async (request) => {
      stagedPath = request.material.authorized_local_path;
      assert.equal(request.request_id, input.requestId);
      assert.equal(request.material.material_id, row.id);
      assert.equal(request.material.material_version, row.version);
      assert.equal(request.material.media_type, row.media_type);
      assert.equal(request.material.sha256, row.sha256);
      assert.deepEqual(request.options, input.options);
      assert.deepEqual(await readFile(stagedPath), bytes);
      assert.equal((await stat(stagedPath)).mode & 0o777, 0o600);
      const directory = join(stagedPath, '..');
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      return responseFor(request);
    },
  });
  const result = await parseAuthorizedMaterial(deps, input);
  assert.equal(result.material?.material_id, row.id);
  assert.equal(result.material?.material_version, row.version);
  assert.equal(result.material?.sha256, row.sha256);
  assert.equal(result.request_id, input.requestId);
  assert.equal(JSON.stringify(result).includes(String(row.object_key)), false);
  assert.equal(JSON.stringify(result).includes(stagedPath), false);
  assert.equal(existsSync(stagedPath), false);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('bb-material-')), []);
});

test('staged bytes are cleaned when parser throws and the private error text is hidden', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  let stagedPath = '';
  const deps = dependencies({
    tempRoot: root,
    parser: async (request) => {
      stagedPath = request.material.authorized_local_path;
      throw new Error(`failure at ${stagedPath} for ${String(row.object_key)}`);
    },
  });
  await assert.rejects(parseAuthorizedMaterial(deps, input), (error: Error) => {
    assert.equal(error.message, 'MATERIAL_PARSE_FAILED');
    assert.equal(error.message.includes(String(row.object_key)), false);
    assert.equal(error.message.includes(stagedPath), false);
    return true;
  });
  assert.notEqual(stagedPath, '');
  assert.equal(existsSync(stagedPath), false);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('bb-material-')), []);
});

test('bridge refuses parser output that contains the private blob key or staging path', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  let stagedPath = '';
  const deps = dependencies({
    tempRoot: root,
    parser: async (request) => {
      stagedPath = request.material.authorized_local_path;
      const result = responseFor(request);
      result.document.debug = String(row.object_key);
      return result;
    },
  });
  await assert.rejects(parseAuthorizedMaterial(deps, input), /PARSER_RESULT_CONTAINS_PRIVATE_REFERENCE/);
  assert.equal(existsSync(stagedPath), false);
});

test('bridge rejects parser responses rebound to another material', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const deps = dependencies({
    tempRoot: root,
    parser: async (request) => {
      const forged = responseFor(request);
      forged.material!.material_id = 'material-other-owner';
      return forged;
    },
  });
  await assert.rejects(parseAuthorizedMaterial(deps, input), /MATERIAL_PARSE_FAILED/);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('bb-material-')), []);
});

test('private cache reuses same-owner content across renamed materials and rebinds the current request', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = cacheHarness();
  let parserCalls = 0;
  const parser = async (request: DocumentParseRequest) => { parserCalls += 1; return responseFor(request); };
  const originalMaterial = { ...row };
  const renamedMaterial = {
    ...row,
    project_id: 'project-renamed-reference',
    id: 'material-renamed',
    version: 1,
    object_key: 'private/users/owner-alice/project-renamed-reference/material-renamed/v1',
  };
  await parseAuthorizedMaterial(dependencies({ tempRoot: root, parser, parseCache: cache.adapter }), { ...input, options: {} });
  const result = await parseAuthorizedMaterial(dependencies({
    tempRoot: root,
    material: renamedMaterial,
    parser,
    parseCache: cache.adapter,
  }), {
    ...input,
    projectId: renamedMaterial.project_id,
    materialId: renamedMaterial.id,
    version: renamedMaterial.version,
    requestId: 'parse-after-rename',
    options: {},
  });
  assert.equal(parserCalls, 1);
  assert.equal(cache.size(), 1);
  assert.equal(result.request_id, 'parse-after-rename');
  assert.equal(result.material?.material_id, renamedMaterial.id);
  assert.equal(result.material?.material_version, renamedMaterial.version);
  assert.ok(result.records.every((record) => record.material_id === renamedMaterial.id && record.material_version === renamedMaterial.version));
  assert.equal(result.material?.material_id === originalMaterial.id, false);
  assert.equal(JSON.stringify(result).includes(String(renamedMaterial.object_key)), false);
});

test('cache entries do not cross owner accounts, and OCR/basis version changes invalidate a hit', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = cacheHarness();
  let parserCalls = 0;
  const parser = async (request: DocumentParseRequest) => { parserCalls += 1; return responseFor(request); };
  await parseAuthorizedMaterial(dependencies({ tempRoot: root, parser, parseCache: cache.adapter }), { ...input, options: {} });

  const bobMaterial = { ...row, owner_user_id: 'owner-bob', project_id: 'project-bob', id: 'material-bob',
    object_key: 'private/users/owner-bob/project-bob/material-bob/v2' };
  await parseAuthorizedMaterial(dependencies({ tempRoot: root, material: bobMaterial, parser, parseCache: cache.adapter }), {
    ...input, ownerUserId: 'owner-bob', projectId: bobMaterial.project_id, materialId: bobMaterial.id,
    options: {},
  });
  assert.equal(parserCalls, 2);

  await parseAuthorizedMaterial(dependencies({
    tempRoot: root,
    parser,
    parseCache: { dependencies: cache.adapter.dependencies, versions: { ...cache.adapter.versions, ocrVersion: 'native-text-2' } },
  }), { ...input, requestId: 'parse-new-ocr-version', options: {} });
  await parseAuthorizedMaterial(dependencies({
    tempRoot: root,
    parser,
    parseCache: { dependencies: cache.adapter.dependencies, versions: { ...cache.adapter.versions, basisVersion: 'evidence-basis-2' } },
  }), { ...input, requestId: 'parse-new-basis-version', options: {} });
  assert.equal(parserCalls, 4);
  assert.equal(cache.size(), 4);
});

test('a corrupt cache object fails closed and does not invoke the parser again', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = cacheHarness();
  let parserCalls = 0;
  const parser = async (request: DocumentParseRequest) => { parserCalls += 1; return responseFor(request); };
  await parseAuthorizedMaterial(dependencies({ tempRoot: root, parser, parseCache: cache.adapter }), { ...input, options: {} });
  cache.corruptFirstObject();
  await assert.rejects(parseAuthorizedMaterial(dependencies({ tempRoot: root, parser, parseCache: cache.adapter }), {
    ...input, requestId: 'parse-must-not-fallback', options: {},
  }), (error: Error) => {
    assert.equal(error.message, 'MATERIAL_PARSE_CACHE_FAILED');
    assert.equal(error.message.includes('parse-cache/'), false);
    return true;
  });
  assert.equal(parserCalls, 1);
});

test('a validly hashed cache payload containing the current private blob key is rejected', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = cacheHarness();
  let parserCalls = 0;
  const parser = async (request: DocumentParseRequest) => { parserCalls += 1; return responseFor(request); };
  await parseAuthorizedMaterial(dependencies({ tempRoot: root, parser, parseCache: cache.adapter }), { ...input, options: {} });
  cache.poisonFirstObject(String(row.object_key));
  await assert.rejects(parseAuthorizedMaterial(dependencies({ tempRoot: root, parser, parseCache: cache.adapter }), {
    ...input, requestId: 'parse-must-not-return-private-key', options: {},
  }), /MATERIAL_PARSE_CACHE_FAILED/);
  assert.equal(parserCalls, 1);
});

test('failed and page-limited parser results are not cached', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = cacheHarness();
  let failedParserCalls = 0;
  const failedParser = async (request: DocumentParseRequest): Promise<DocumentParseResponse> => {
    failedParserCalls += 1;
    return {
      ...responseFor(request), status: 'failed', records: [],
      document: { page_count: null },
      error: { code: 'SYNTHETIC_PARSE_FAILURE', message: 'synthetic failure' },
    };
  };
  for (const requestId of ['failed-1', 'failed-2']) {
    const failed = await parseAuthorizedMaterial(dependencies({ tempRoot: root, parser: failedParser, parseCache: cache.adapter }), {
      ...input, requestId, options: {},
    });
    assert.equal(failed.status, 'failed');
  }
  assert.equal(failedParserCalls, 2);
  assert.equal(cache.size(), 0);

  let limitedParserCalls = 0;
  const limitedParser = async (request: DocumentParseRequest) => { limitedParserCalls += 1; return responseFor(request); };
  for (const requestId of ['limited-1', 'limited-2']) {
    await parseAuthorizedMaterial(dependencies({ tempRoot: root, parser: limitedParser, parseCache: cache.adapter }), {
      ...input, requestId, options: { max_pages: 10 },
    });
  }
  assert.equal(limitedParserCalls, 2);
  assert.equal(cache.size(), 0);
});

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const localPython = process.env.BB_PYTHON?.trim() || join(repositoryRoot, '.venv', 'bin', 'python');
const authorizedSampleManifestPath = join(repositoryRoot, 'tests/samples/2026-09-25/manifest.json');
test('bridge parses synthetic text through the actual Python subprocess when the repo venv exists', {
  skip: existsSync(localPython) ? false : 'repository .venv is not installed',
}, async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const deps = dependencies({
    tempRoot: root,
    parser: (request) => runDocumentParser(request, {
      pythonExecutable: localPython,
      repoRoot: repositoryRoot,
    }),
  });
  const result = await parseAuthorizedMaterial(deps, input);
  assert.equal(result.status, 'parsed');
  assert.equal(result.records.some((record) => record.literal_quote.includes('synthetic authorized material')), true);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('bb-material-')), []);
});

test('opt-in authorized historical DOCX parses through Python and reuses owner-scoped cache by content', {
  skip: process.env.BB_RUN_AUTHORIZED_SAMPLE_TESTS !== '1'
    ? 'set BB_RUN_AUTHORIZED_SAMPLE_TESTS=1 to parse an authorized real sample'
    : existsSync(localPython) ? false : 'repository .venv is not installed',
}, async (t) => {
  const manifest = JSON.parse(await readFile(authorizedSampleManifestPath, 'utf8')) as {
    cases: Array<{ files: Array<{ file_id: string; path: string; upload_role: string; bytes: number; sha256: string; media_type: string }> }>;
  };
  const file = manifest.cases.flatMap((sampleCase) => sampleCase.files)
    .find((candidate) => candidate.file_id === 'rq-202509-01');
  assert.ok(file, 'approved manifest entry rq-202509-01 must exist');
  assert.equal(file.upload_role, 'historical');
  assert.equal(file.media_type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const samplePath = join(repositoryRoot, 'tests/samples/2026-09-25', file.path);
  const sampleBytes = await readFile(samplePath);
  assert.equal(sampleBytes.byteLength, file.bytes, 'authorized sample byte size must match manifest');
  assert.equal(createHash('sha256').update(sampleBytes).digest('hex'), file.sha256,
    'authorized sample SHA-256 must match manifest');

  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = cacheHarness();
  cache.adapter.versions.parserVersion = documentParserVersion();
  let pythonParserCalls = 0;
  const parser: MaterialParserDependencies['parser'] = (request) => {
    pythonParserCalls += 1;
    return runDocumentParser(request, { pythonExecutable: localPython, repoRoot: repositoryRoot });
  };
  const originalMaterial = {
    ...row,
    owner_user_id: 'authorized-owner-alice',
    project_id: 'authorized-project-original-name',
    id: 'authorized-material-original-name',
    version: 1,
    media_type: file.media_type,
    byte_size: file.bytes,
    sha256: file.sha256,
    filename: file.path.split('/').at(-1),
    object_key: 'private/authorized-owner-alice/original-name/v1',
  };
  const renamedMaterial = {
    ...originalMaterial,
    project_id: 'authorized-project-renamed-file',
    id: 'authorized-material-renamed-file',
    filename: 'renamed-historical-prospectus.docx',
    object_key: 'private/authorized-owner-alice/renamed-file/v1',
  };
  const anotherOwnerMaterial = {
    ...renamedMaterial,
    owner_user_id: 'authorized-owner-bob',
    project_id: 'authorized-project-bob',
    id: 'authorized-material-bob',
    object_key: 'private/authorized-owner-bob/renamed-file/v1',
  };
  const parseCache = cache.adapter;
  const parse = (material: Record<string, unknown>, ownerUserId: string, requestId: string) => parseAuthorizedMaterial(
    dependencies({ tempRoot: root, material, bytes: sampleBytes, parser, parseCache }),
    {
      ownerUserId,
      projectId: String(material.project_id),
      materialId: String(material.id),
      version: Number(material.version),
      requestId,
      options: {},
    },
  );

  const first = await parse(originalMaterial, 'authorized-owner-alice', 'authorized-sample-original');
  const sameOwnerRename = await parse(renamedMaterial, 'authorized-owner-alice', 'authorized-sample-renamed');
  assert.ok(first.status === 'parsed' || first.status === 'needs_confirmation');
  assert.equal(sameOwnerRename.status, first.status);
  assert.equal(sameOwnerRename.request_id, 'authorized-sample-renamed');
  assert.equal(sameOwnerRename.material?.material_id, 'authorized-material-renamed-file');
  assert.ok(sameOwnerRename.records.length > 0);
  assert.ok(sameOwnerRename.records.every((record) => record.material_id === 'authorized-material-renamed-file' &&
    record.material_version === 1 && record.content_hash === file.sha256));
  assert.equal(pythonParserCalls, 1, 'same-owner renamed content should be a cache hit');

  const crossOwner = await parse(anotherOwnerMaterial, 'authorized-owner-bob', 'authorized-sample-other-owner');
  assert.ok(crossOwner.status === 'parsed' || crossOwner.status === 'needs_confirmation');
  assert.equal(crossOwner.material?.material_id, 'authorized-material-bob');
  assert.equal(pythonParserCalls, 2, 'another owner must parse independently instead of observing Alice\'s cache');
  assert.equal(cache.size(), 2);
  assert.deepEqual([...cache.rows.values()].map((entry) => entry.owner_user_id).sort(),
    ['authorized-owner-alice', 'authorized-owner-bob']);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('bb-material-')), []);
});

test('migrated PostgreSQL and actual Python reuse content only within the owner account', {
  skip: !testDatabaseUrl || !existsSync(localPython)
    ? 'set MATERIAL_CACHE_TEST_DATABASE_URL and install repository .venv for live integration'
    : false,
}, async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = new Pool({ connectionString: testDatabaseUrl });
  const client = await database.connect();
  const suffix = randomUUID();
  const ownerA = `cache-owner-a-${suffix}`;
  const ownerB = `cache-owner-b-${suffix}`;
  const projectA1 = `cache-project-a1-${suffix}`;
  const projectA2 = `cache-project-a2-${suffix}`;
  const projectB = `cache-project-b-${suffix}`;
  const materialA1 = `cache-material-a1-${suffix}`;
  const materialA2 = `cache-material-a2-${suffix}`;
  const materialB = `cache-material-b-${suffix}`;
  const objects = new Map<string, Uint8Array>();
  const db = { query: async (sql: string, values: unknown[]) => {
    const result = await client.query(sql, values);
    return { rows: result.rows as Record<string, unknown>[] };
  } };
  const privateBlobs = {
    getPrivate: async (key: string) => objects.get(key) ?? null,
    putPrivate: async (key: string, value: Uint8Array) => { objects.set(key, Buffer.from(value)); },
  };
  let parserCalls = 0;
  const deps: MaterialParserDependencies = {
    pool: db,
    blobs: privateBlobs,
    tempRoot: root,
    parser: async (request) => {
      parserCalls += 1;
      return runDocumentParser(request, { pythonExecutable: localPython, repoRoot: repositoryRoot });
    },
    parseCache: { dependencies: { pool: db, blobs: privateBlobs }, versions: {
      parserVersion: documentParserVersion(),
      ocrVersion: 'native-text-1',
      basisVersion: 'evidence-basis-1',
    } },
  };
  async function insertMaterial(owner: string, project: string, materialId: string): Promise<void> {
    const uploadId = `upload-${materialId}`;
    const objectKey = `private/${owner}/${project}/${materialId}`;
    await client.query('INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,$3,$4)',
      [project, owner, 'Synthetic cache project', 'update']);
    await client.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1 hour',$10)`,
    [uploadId, owner, project, 'renamed.txt', 'text/plain', bytes.byteLength, hash, 'audit', `upload/${uploadId}`, 'completed']);
    await client.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [materialId, 1, owner, project, uploadId, 'audit', 'renamed.txt', 'text/plain', bytes.byteLength, hash, objectKey, 'ready']);
    objects.set(objectKey, Buffer.from(bytes));
  }
  try {
    await client.query('BEGIN');
    await insertMaterial(ownerA, projectA1, materialA1);
    await insertMaterial(ownerA, projectA2, materialA2);
    await insertMaterial(ownerB, projectB, materialB);
    const first = await parseAuthorizedMaterial(deps, {
      ownerUserId: ownerA, projectId: projectA1, materialId: materialA1, version: 1, requestId: 'live-first',
    });
    assert.equal(first.parser_version, deps.parseCache!.versions.parserVersion);
    const renamed = await parseAuthorizedMaterial(deps, {
      ownerUserId: ownerA, projectId: projectA2, materialId: materialA2, version: 1, requestId: 'live-renamed',
    });
    assert.equal(first.status, 'parsed');
    assert.equal(renamed.status, 'parsed');
    assert.equal(renamed.request_id, 'live-renamed');
    assert.equal(renamed.material?.material_id, materialA2);
    assert.ok(renamed.records.every((record) => record.material_id === materialA2));
    assert.equal(parserCalls, 1);
    await parseAuthorizedMaterial(deps, {
      ownerUserId: ownerB, projectId: projectB, materialId: materialB, version: 1, requestId: 'live-other-owner',
    });
    assert.equal(parserCalls, 2);
    const cacheRows = await client.query('SELECT owner_user_id FROM bb_parse_cache WHERE owner_user_id = ANY($1::text[])',
      [[ownerA, ownerB]]);
    assert.deepEqual(cacheRows.rows.map((record) => record.owner_user_id).sort(), [ownerA, ownerB].sort());
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith('bb-material-')), []);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await database.end();
  }
});

// Streams start plus records until the requested per-mode budget trips; the media type is ignored by the fake.
const streamBudgetGenerator=[
  '#!/usr/bin/env node',
  "let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{",
  'const req=JSON.parse(input);const m=req.material;const mode=process.env.FAKE_MODE||"text-limit";const pad="x".repeat(16000);',
  'const emit=o=>process.stdout.write(JSON.stringify(o)+"\\n");',
  'emit({type:"start",schema_version:"document-parse-stream-v1",request_id:req.request_id,parser_version:"bondbuddy-document-parser-1.0.7",material:{material_id:m.material_id,material_version:m.material_version,sha256:m.sha256,media_type:m.media_type},document:{page_count:null,encoding:"utf-8"}});',
  'const count=mode==="output-limit"?1:1200;',
  'for(let i=1;i<=count;i++)emit({type:"record",record:{record_id:"evidence-"+String(i).padStart(6,"0"),material_id:m.material_id,material_version:m.material_version,content_hash:m.sha256,locator_type:"text_line",locator:{line:i,stable_ref:"text:l"+String(i).padStart(6,"0")},literal_quote:pad,context:"",extraction_method:"native_text",extractor_version:"bondbuddy-document-parser-1.0.7",confidence:null,uncertainty:[],formatting:{}}});',
  '});',
].join('\n');

test('#17 streamed PDF/TXT stdout and text budgets map to terminal MATERIAL_TOO_LARGE', async (t) => {
  assert.equal(M1_PARSE_STREAM_OUTPUT_BUDGET_BYTES, 256 * 1024 * 1024);
  assert.equal(DOCUMENT_PARSER_STREAM_MAX_TEXT_BYTES, 16 * 1024 * 1024);
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const bindir = join(root, 'bin');
  await mkdir(bindir);
  await writeFile(join(bindir, 'python3'), streamBudgetGenerator, { mode: 0o700 });
  const saved = {
    PATH: process.env.PATH, staging: process.env.BB_PARSE_STAGING_DIR,
    output: process.env.BB_PARSE_STREAM_MAX_OUTPUT_BYTES, mode: process.env.FAKE_MODE,
  };
  process.env.PATH = `${bindir}:${saved.PATH ?? ''}`;
  // No staging root -> a plain temporary directory, so the synthetic failure must be the budget, not staging.
  delete process.env.BB_PARSE_STAGING_DIR;
  t.after(() => {
    if (saved.PATH === undefined) delete process.env.PATH; else process.env.PATH = saved.PATH;
    if (saved.staging === undefined) delete process.env.BB_PARSE_STAGING_DIR; else process.env.BB_PARSE_STAGING_DIR = saved.staging;
    if (saved.output === undefined) delete process.env.BB_PARSE_STREAM_MAX_OUTPUT_BYTES; else process.env.BB_PARSE_STREAM_MAX_OUTPUT_BYTES = saved.output;
    if (saved.mode === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = saved.mode;
  });

  process.env.FAKE_MODE = 'text-limit';
  await assert.rejects(parseAuthorizedMaterialToStream(dependencies({}), { ...input, options: {} }), (error: Error) => {
    assert.equal(error.message, 'MATERIAL_PARSE_SIZE_LIMIT');
    assert.deepEqual(classifyMaterialParseError(error), { code: 'MATERIAL_TOO_LARGE', retryable: false, category: 'material_parse' });
    return true;
  });

  process.env.FAKE_MODE = 'output-limit';
  process.env.BB_PARSE_STREAM_MAX_OUTPUT_BYTES = '1024';
  await assert.rejects(parseAuthorizedMaterialToStream(dependencies({}), { ...input, options: {} }), (error: Error) => {
    assert.equal(error.message, 'MATERIAL_PARSE_OUTPUT_LIMIT');
    assert.deepEqual(classifyMaterialParseError(error), { code: 'MATERIAL_TOO_LARGE', retryable: false, category: 'material_parse' });
    return true;
  });
});
