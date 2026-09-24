import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { DocumentParseRequest, DocumentParseResponse } from './document-parser.js';
import { precheckHistoricalMaterial } from './historical-material-precheck.js';
import type { MaterialParserDependencies } from './material-parser.js';

const bytes = Buffer.from('synthetic historical prospectus text\n', 'utf8');
const row = {
  owner_user_id: 'owner-alice',
  project_id: 'project-history',
  id: 'material-history',
  version: 4,
  role: 'historical',
  media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  byte_size: bytes.byteLength,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  object_key: 'private/users/owner-alice/project-history/material-history/v4',
};
const input = {
  ownerUserId: row.owner_user_id,
  projectId: row.project_id,
  materialId: row.id,
  version: row.version,
  requestId: 'precheck-history-v4',
  profileVersion: 9,
};

function recognizedParse(request: DocumentParseRequest, status: DocumentParseResponse['status'] = 'parsed'): DocumentParseResponse {
  const material = request.material;
  const snippets = [
    ['venue-cover', '本期债券发行场所：上海证券交易所。', '募集说明书封面'],
    ['venue-overview', '本期债券在上海证券交易所发行。', '本次发行概况'],
    ['offering-cover', '本期债券采取非公开发行方式。', '募集说明书封面'],
    ['offering-overview', '本期公司债券采用私募发行。', '本次发行概况'],
    ['financial-period', '合并财务报表报告期：2022年度、2023年度、2024年度。', '财务会计信息'],
  ] as const;
  return {
    schema_version: 'document-parse-response-v1',
    request_id: request.request_id,
    parser_version: 'synthetic-parser-1',
    status,
    material: {
      material_id: material.material_id,
      material_version: material.material_version,
      media_type: material.media_type,
      sha256: material.sha256,
    },
    records: status === 'failed' ? [] : snippets.map(([id, quote, context], index) => ({
      record_id: id,
      material_id: material.material_id,
      material_version: material.material_version,
      content_hash: material.sha256,
      locator_type: 'docx_block' as const,
      locator: { path: [{ paragraph: index + 1 }], stable_ref: `docx:p${String(index + 1).padStart(4, '0')}` },
      literal_quote: quote,
      context,
      extraction_method: 'native_text' as const,
      extractor_version: 'synthetic-native-1',
      confidence: 1,
      uncertainty: [],
      formatting: {},
    })),
    warnings: status === 'needs_confirmation' ? [{ code: 'SCAN_NOT_OCRD', message: '合成扫描页未执行OCR' }] : [],
    document: status === 'failed' ? { page_count: null } : { page_count: null, revision_summary: { insertions: 0, deletions: 0 } },
    error: status === 'failed' ? { code: 'SYNTHETIC_PARSE_FAILURE', message: 'synthetic failure' } : null,
  };
}

function dependencies(options: {
  material?: typeof row | null;
  bytes?: Uint8Array | null;
  parser?: MaterialParserDependencies['parser'];
  onBytes?: () => void;
} = {}): MaterialParserDependencies {
  return {
    pool: {
      async query(sql, values) {
        assert.match(sql, /owner_user_id\s*=\s*\$1/);
        assert.match(sql, /project_id\s*=\s*\$2/);
        assert.match(sql, /version\s*=\s*\$4/);
        assert.match(sql, /role\s*=\s*\$5/);
        const material = options.material === undefined ? row : options.material;
        const matches = material !== null && values[0] === material.owner_user_id &&
          values[1] === material.project_id && values[2] === material.id && values[3] === material.version &&
          values[4] === 'historical' && material.role === 'historical' &&
          (material.media_type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
            material.media_type === 'application/pdf');
        return { rows: matches ? [material] : [] };
      },
    },
    blobs: {
      async getPrivate() {
        options.onBytes?.();
        return options.bytes === undefined ? bytes : options.bytes;
      },
    },
    ...(options.parser === undefined ? {} : { parser: options.parser }),
  };
}

test('precheck recognizes a synthetic historical-role version and returns no target project fields', async () => {
  let parserCalls = 0;
  const result = await precheckHistoricalMaterial(dependencies({
    parser: async (request) => { parserCalls += 1; return recognizedParse(request); },
  }), input);
  assert.equal(parserCalls, 1);
  assert.equal(result.state, 'ready');
  assert.equal(result.material_id, row.id);
  assert.equal(result.material_version, row.version);
  assert.equal(result.profile_version, input.profileVersion);
  assert.equal(result.source_market.value, 'sse');
  assert.equal(result.source_offering.value, 'private');
  assert.deepEqual(result.reporting_periods.map(period => period.end), ['2022-12-31', '2023-12-31', '2024-12-31']);
  assert.deepEqual(Object.keys(result).sort(), [
    'latest_reporting_cutoff', 'material_id', 'material_version', 'profile_version',
    'reporting_periods', 'source_market', 'source_offering', 'state',
  ].sort());
  assert.equal(JSON.stringify(result).includes('target_market'), false);
});

test('reference role and cross-owner material are denied before private bytes or Python parsing', async () => {
  let blobCalls = 0;
  let parserCalls = 0;
  const parser = async (request: DocumentParseRequest) => { parserCalls += 1; return recognizedParse(request); };
  await assert.rejects(precheckHistoricalMaterial(dependencies({
    material: { ...row, role: 'reference' }, onBytes: () => { blobCalls += 1; }, parser,
  }), input), /NOT_FOUND/);
  await assert.rejects(precheckHistoricalMaterial(dependencies({
    material: { ...row, owner_user_id: 'owner-bob' }, onBytes: () => { blobCalls += 1; }, parser,
  }), input), /NOT_FOUND/);
  assert.equal(blobCalls, 0);
  assert.equal(parserCalls, 0);
});

test('a mismatched database row role or non-prospectus media type fails before reading bytes', async () => {
  let blobCalls = 0;
  let parserCalls = 0;
  const deps = dependencies({ onBytes: () => { blobCalls += 1; }, parser: async (request) => {
    parserCalls += 1;
    return recognizedParse(request);
  } });
  // Simulate a faulty DB adapter that ignores the SQL predicate: the row-level
  // defense must still prevent reaching private storage.
  deps.pool.query = async () => ({ rows: [{ ...row, role: 'reference' }] });
  await assert.rejects(precheckHistoricalMaterial(deps, input), /MATERIAL_ROLE_MISMATCH/);

  await assert.rejects(precheckHistoricalMaterial(dependencies({
    material: { ...row, media_type: 'text/plain' }, onBytes: () => { blobCalls += 1; },
  }), input), /NOT_FOUND/);
  assert.equal(blobCalls, 0);
  assert.equal(parserCalls, 0);
});

test('failed and scan-pending parser states never become ready', async () => {
  for (const [status, expectedState] of [
    ['failed', 'failed'],
    ['needs_confirmation', 'needs_confirmation'],
  ] as const) {
    const result = await precheckHistoricalMaterial(dependencies({
      parser: async (request) => recognizedParse(request, status),
    }), input);
    assert.equal(result.state, expectedState);
  }
  const ambiguous = await precheckHistoricalMaterial(dependencies({
    parser: async (request) => ({ ...recognizedParse(request), records: recognizedParse(request).records.slice(0, 1) }),
  }), input);
  assert.equal(ambiguous.state, 'needs_confirmation');
});

test('invalid profile version fails before the authorized material lookup', async () => {
  let lookups = 0;
  const deps = dependencies({});
  deps.pool.query = async () => { lookups += 1; return { rows: [row] }; };
  await assert.rejects(precheckHistoricalMaterial(deps, { ...input, profileVersion: 0 }), /INVALID_PROFILE_VERSION/);
  assert.equal(lookups, 0);
});
