import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runDocumentParser, type DocumentParseRequest, type DocumentParseResponse } from './document-parser.js';
import {
  parseAuthorizedMaterial,
  type MaterialParserDependencies,
  type MaterialParserPool,
} from './material-parser.js';

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
  return mkdtemp(join(tmpdir(), 'bb-material-parser-test-'));
}

function dependencies(options: {
  material?: Record<string, unknown> | null;
  bytes?: Uint8Array | null;
  onBlob?: (key: string) => void;
  parser?: MaterialParserDependencies['parser'];
  tempRoot: string;
}): MaterialParserDependencies {
  const pool: MaterialParserPool = {
    async query(sql, values) {
      assert.match(sql, /owner_user_id\s*=\s*\$1/);
      assert.match(sql, /project_id\s*=\s*\$2/);
      assert.match(sql, /id\s*=\s*\$3/);
      assert.match(sql, /version\s*=\s*\$4/);
      assert.match(sql, /deleted_at\s+IS\s+NULL/);
      const matches = values[0] === row.owner_user_id && values[1] === row.project_id &&
        values[2] === row.id && values[3] === row.version;
      return { rows: matches && options.material !== null ? [options.material ?? row] : [] };
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
    tempRoot: options.tempRoot,
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
  assert.deepEqual(await readdir(root), []);
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
  assert.deepEqual(await readdir(root), []);
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
  assert.deepEqual(await readdir(root), []);
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
  assert.deepEqual(await readdir(root), []);
});

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const localPython = join(repositoryRoot, '.venv', 'bin', 'python');
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
  assert.deepEqual(await readdir(root), []);
});
