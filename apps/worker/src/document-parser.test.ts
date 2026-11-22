import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  runDocumentParser,
  runDocumentParserToFile,
  type DocumentParseRequest,
} from './document-parser.js';
import { createNativeFinancialFactExtractor } from './native-financial-fact-extractor.js';
import type { SemanticFactExtractionRequest } from './fact-candidate-producer.js';

const request: DocumentParseRequest = {
  schema_version: 'document-parse-request-v1',
  request_id: 'parse-synthetic',
  material: {
    material_id: 'material-synthetic',
    material_version: 1,
    media_type: 'text/plain',
    sha256: 'a'.repeat(64),
    authorized_local_path: '/private/synthetic/material.txt',
  },
  options: {},
};

test('trusted staging handles accept host-native absolute paths and reject relative paths before Python', async () => {
  let invocations = 0;
  const invoke = async () => {
    invocations += 1;
    return JSON.stringify(response);
  };
  const hostPath = resolve(tmpdir(), 'synthetic-material.txt');
  await runDocumentParser(
    { ...request, material: { ...request.material, authorized_local_path: hostPath } },
    { invoke },
  );
  assert.equal(invocations, 1);
  for (const path of ['relative.txt', '../material.txt', 'C:relative.txt']) {
    await assert.rejects(
      runDocumentParser(
        { ...request, material: { ...request.material, authorized_local_path: path } },
        { invoke },
      ),
      /INVALID_PARSE_REQUEST/,
    );
  }
  assert.equal(invocations, 1);
});

const response = {
  schema_version: 'document-parse-response-v1',
  request_id: 'parse-synthetic',
  parser_version: 'bondbuddy-document-parser-1.0.0',
  status: 'parsed',
  material: {
    material_id: 'material-synthetic',
    material_version: 1,
    media_type: 'text/plain',
    sha256: 'a'.repeat(64),
  },
  records: [
    {
      record_id: 'evidence-000001',
      material_id: 'material-synthetic',
      material_version: 1,
      content_hash: 'a'.repeat(64),
      locator_type: 'text_line',
      locator: { line: 1, stable_ref: 'text:l000001' },
      literal_quote: 'synthetic',
      context: '',
      extraction_method: 'native_text',
      extractor_version: 'bondbuddy-document-parser-1.0.0',
      confidence: null,
      uncertainty: [],
      formatting: {},
    },
  ],
  warnings: [],
  document: { page_count: null, encoding: 'utf-8-sig' },
  error: null,
};

test('worker validates the versioned parser response and material binding', async () => {
  const result = await runDocumentParser(request, {
    invoke: async (serialized, options) => {
      assert.deepEqual(JSON.parse(serialized), request);
      assert.equal(
        options.timeoutMs,
        15 * 60_000,
        'large DOCX can exceed the previous five-minute bridge limit',
      );
      return JSON.stringify(response);
    },
  });
  assert.equal(result.records[0]?.literal_quote, 'synthetic');
});

test('worker rejects a parser result bound to different immutable bytes', async () => {
  const mismatched = { ...response, material: { ...response.material, sha256: 'b'.repeat(64) } };
  await assert.rejects(
    runDocumentParser(request, { invoke: async () => JSON.stringify(mismatched) }),
    /PARSE_MATERIAL_IDENTITY_MISMATCH/,
  );
});

test('worker rejects failed responses that contain partial records', async () => {
  const invalid = {
    ...response,
    status: 'failed',
    error: { code: 'MATERIAL_UNREADABLE', message: 'synthetic' },
    records: response.records,
  };
  await assert.rejects(
    runDocumentParser(request, { invoke: async () => JSON.stringify(invalid) }),
    /INVALID_PARSE_RESPONSE/,
  );
});

test('worker rejects malformed response metadata, records, warnings, locators and status combinations', async () => {
  const invalidResponses: unknown[] = [];
  invalidResponses.push({ ...response, parser_version: '' });
  invalidResponses.push({ ...response, parser_version: '../private' });
  invalidResponses.push({
    ...response,
    records: [response.records[0], { ...response.records[0] }],
  });
  invalidResponses.push({ ...response, records: [{ ...response.records[0], record_id: '' }] });
  invalidResponses.push({ ...response, records: [{ ...response.records[0], confidence: 1.1 }] });
  invalidResponses.push({ ...response, records: [{ ...response.records[0], context: null }] });
  invalidResponses.push({
    ...response,
    records: [{ ...response.records[0], locator: { line: 0, stable_ref: 'text:l000000' } }],
  });
  invalidResponses.push({
    ...response,
    records: [{ ...response.records[0], locator_type: 'pdf_bbox' }],
  });
  invalidResponses.push({
    ...response,
    records: [{ ...response.records[0], unexpected_private_field: '/secret' }],
  });
  invalidResponses.push({ ...response, warnings: [{ code: '', message: 'bad' }] });
  invalidResponses.push({
    ...response,
    warnings: [{ code: 'BAD', message: 'bad', path: '/private/source' }],
  });
  invalidResponses.push({ ...response, status: 'needs_confirmation' });
  invalidResponses.push({ ...response, document: { ...response.document, page_count: 1 } });
  invalidResponses.push({
    ...response,
    document: { ...response.document, authorized_local_path: '/private/source' },
  });
  for (const invalid of invalidResponses) {
    await assert.rejects(
      runDocumentParser(request, { invoke: async () => JSON.stringify(invalid) }),
      /INVALID_PARSE_RESPONSE/,
    );
  }
});

test('worker validates type-specific PDF and DOCX anchors without fabricating DOCX pages', async () => {
  const pdfRequest: DocumentParseRequest = {
    ...request,
    material: { ...request.material, media_type: 'application/pdf' },
  };
  const pdfResponse = {
    ...response,
    material: { ...response.material, media_type: 'application/pdf' },
    document: { page_count: 2, pages_without_native_text: [], pages_with_images: [] },
    records: [
      {
        ...response.records[0],
        locator_type: 'pdf_bbox',
        locator: {
          page: 2,
          line: 1,
          bbox: { x0: 1, top: 2, x1: 3, bottom: 4 },
          stable_ref: 'pdf:p0002:l0001',
        },
      },
    ],
  };
  const pdf = await runDocumentParser(pdfRequest, {
    invoke: async () => JSON.stringify(pdfResponse),
  });
  assert.equal(pdf.records[0]?.locator.page, 2);
  const croppedPdf = {
    ...pdfResponse,
    records: [
      {
        ...pdfResponse.records[0],
        locator: { ...pdfResponse.records[0].locator, bbox: { x0: -2, top: -1, x1: 3, bottom: 4 } },
      },
    ],
  };
  assert.equal(
    (await runDocumentParser(pdfRequest, { invoke: async () => JSON.stringify(croppedPdf) }))
      .status,
    'parsed',
  );
  const invalidPdf = {
    ...pdfResponse,
    records: [
      {
        ...pdfResponse.records[0],
        locator: { ...pdfResponse.records[0].locator, page: 3, stable_ref: 'pdf:p0003:l0001' },
      },
    ],
  };
  await assert.rejects(
    runDocumentParser(pdfRequest, { invoke: async () => JSON.stringify(invalidPdf) }),
    /INVALID_PARSE_RESPONSE/,
  );
  const overLimit = {
    ...pdfResponse,
    document: { ...pdfResponse.document, page_count: 1501 },
    records: [
      { ...pdfResponse.records[0], locator: { ...pdfResponse.records[0].locator, page: 1 } },
    ],
  };
  await assert.rejects(
    runDocumentParser(pdfRequest, { invoke: async () => JSON.stringify(overLimit) }),
    /INVALID_PARSE_RESPONSE/,
  );
  const failedPdf = {
    ...pdfResponse,
    status: 'failed',
    document: { page_count: null },
    records: [],
    warnings: [],
    error: { code: 'MATERIAL_UNREADABLE', message: 'Synthetic failure' },
  };
  const failed = await runDocumentParser(pdfRequest, {
    invoke: async () => JSON.stringify(failedPdf),
  });
  assert.equal(failed.status, 'failed');

  const docxRequest: DocumentParseRequest = {
    ...request,
    material: {
      ...request.material,
      media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
  };
  const docxResponse = {
    ...response,
    material: { ...response.material, media_type: docxRequest.material.media_type },
    status: 'needs_confirmation',
    warnings: [{ code: 'DOCX_AUXILIARY_PARTS', message: 'Synthetic warning' }],
    document: { page_count: null, revision_summary: { insertions: 0, deletions: 0 } },
    records: [
      {
        ...response.records[0],
        locator_type: 'docx_block',
        locator: {
          path: [{ table: 1, row: 2, column: 3 }, { paragraph: 4 }],
          stable_ref: 'docx:t001:r002:c003:p0004',
        },
      },
    ],
  };
  const docx = await runDocumentParser(docxRequest, {
    invoke: async () => JSON.stringify(docxResponse),
  });
  assert.deepEqual(docx.records[0]?.locator.path, [
    { table: 1, row: 2, column: 3 },
    { paragraph: 4 },
  ]);
  const badDocx = {
    ...docxResponse,
    records: [
      {
        ...docxResponse.records[0],
        locator: { path: [{ paragraph: 1 }], page: 1, stable_ref: 'docx:p0001' },
      },
    ],
  };
  await assert.rejects(
    runDocumentParser(docxRequest, { invoke: async () => JSON.stringify(badDocx) }),
    /INVALID_PARSE_RESPONSE/,
  );
});

test('worker strictly retains parser 1.0.7/1.0.8 auxiliary targets without treating them as facts or clearing warnings', async () => {
  const docxRequest: DocumentParseRequest = {
    ...request,
    material: {
      ...request.material,
      media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
  };
  const hash = (char: string) => char.repeat(64);
  const idHash = (id: string) => createHash('sha256').update(id).digest('hex');
  const baseScope = (
    kind: 'section_reference' | 'note_reference' | 'drawing_relationship' | 'unknown',
    status: 'resolved' | 'partially_resolved' | 'unknown' | 'unreferenced',
    reason: string | null,
    relationships: unknown[] = [],
    section_references: unknown[] = [],
    unknown_sections: number[] = [],
    body_references: unknown[] = [],
  ) => ({
    kind,
    status,
    relationship_part_sha256: hash('a'),
    relationships,
    section_references,
    unknown_sections,
    body_references,
    reason,
    truncated: false,
  });
  const targets = [
    {
      target_id: `aux-${hash('a')}`,
      kind: 'header',
      part_name: 'word/header1.xml',
      locator: { part_name: 'word/header1.xml', paragraph_index: 1 },
      part_sha256: hash('b'),
      target_sha256: hash('c'),
      locator_resolved: true,
      parseable: true,
      parse_status: 'parsed',
      text_summary: { sha256: hash('d'), character_count: 32, has_text: true },
      scope: baseScope(
        'section_reference',
        'resolved',
        null,
        [
          {
            relationship_id: 'rIdHeader',
            relationship_id_sha256: idHash('rIdHeader'),
            relationship_type: 'header',
            mode: 'internal',
            target_part: 'word/header1.xml',
            status: 'resolved',
          },
        ],
        [
          {
            section_index: 1,
            reference_type: 'default',
            relationship_id: 'rIdHeader',
            relationship_id_sha256: idHash('rIdHeader'),
            section_stable_ref: 'docx:p0001',
          },
        ],
      ),
    },
    {
      target_id: `aux-${hash('e')}`,
      kind: 'footnote',
      part_name: 'word/footnotes.xml',
      locator: { part_name: 'word/footnotes.xml', note_id: '9', paragraph_index: null },
      part_sha256: hash('f'),
      target_sha256: hash('1'),
      locator_resolved: true,
      parseable: true,
      parse_status: 'empty',
      text_summary: { sha256: hash('2'), character_count: 0, has_text: false },
      scope: baseScope(
        'note_reference',
        'resolved',
        null,
        [
          {
            relationship_id: 'rIdFootnotes',
            relationship_id_sha256: idHash('rIdFootnotes'),
            relationship_type: 'footnotes',
            mode: 'internal',
            target_part: 'word/footnotes.xml',
            status: 'resolved',
          },
        ],
        [],
        [],
        [{ note_id: '9', note_id_sha256: idHash('9'), stable_ref: 'docx:p0001' }],
      ),
    },
    {
      target_id: `aux-${hash('3')}`,
      kind: 'drawing',
      part_name: 'word/document.xml',
      locator: {
        part_name: 'word/document.xml',
        drawing_index: 1,
        parent_stable_ref: 'docx:p0001',
        drawing_ids: ['77'],
      },
      part_sha256: hash('4'),
      target_sha256: hash('5'),
      locator_resolved: true,
      parseable: false,
      parse_status: 'not_extracted',
      text_summary: null,
      scope: baseScope(
        'drawing_relationship',
        'unknown',
        'drawing_relationship_targets_not_extracted',
      ),
    },
    {
      target_id: `aux-${hash('6')}`,
      kind: 'auxiliary_part',
      part_name: `word/auxiliary-${hash('7')}.xml`,
      locator: { part_name: `word/auxiliary-${hash('7')}.xml`, member_name_sha256: hash('7') },
      part_sha256: hash('8'),
      target_sha256: hash('8'),
      locator_resolved: false,
      parseable: false,
      parse_status: 'unrecognized_part',
      text_summary: null,
      scope: baseScope('unknown', 'unknown', 'auxiliary_part_scope_unknown'),
    },
    {
      target_id: `aux-${hash('9')}`,
      kind: 'auxiliary_part',
      part_name: 'word/footer2.xml',
      locator: { part_name: 'word/footer2.xml' },
      part_sha256: null,
      target_sha256: null,
      locator_resolved: false,
      parseable: false,
      parse_status: 'size_limited',
      text_summary: null,
      scope: baseScope('section_reference', 'unknown', 'no_matching_internal_relationship'),
    },
  ];
  const response107 = {
    ...response,
    parser_version: 'bondbuddy-document-parser-1.0.7',
    material: { ...response.material, media_type: docxRequest.material.media_type },
    status: 'needs_confirmation',
    warnings: [
      { code: 'DOCX_DRAWINGS', message: 'Synthetic drawing warning' },
      { code: 'DOCX_AUXILIARY_PARTS', message: 'Synthetic auxiliary warning' },
    ],
    document: {
      page_count: null,
      revision_summary: { insertions: 0, deletions: 0 },
      auxiliary_targets: targets,
    },
    records: [
      {
        ...response.records[0],
        locator_type: 'docx_block',
        locator: { path: [{ paragraph: 1 }], stable_ref: 'docx:p0001' },
      },
    ],
  };
  const result = await runDocumentParser(docxRequest, {
    invoke: async () => JSON.stringify(response107),
  });
  const result108 = await runDocumentParser(docxRequest, {
    invoke: async () =>
      JSON.stringify({ ...response107, parser_version: 'bondbuddy-document-parser-1.0.8' }),
  });
  assert.deepEqual(result108.document.auxiliary_targets, targets);
  assert.deepEqual(result.document.auxiliary_targets, targets);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['DOCX_DRAWINGS', 'DOCX_AUXILIARY_PARTS'],
  );
  assert.equal(result.status, 'needs_confirmation');
  assert.equal(result.records[0]?.confidence, null);
  assert.deepEqual(result.records[0]?.uncertainty, []);

  const invalid = [
    {
      ...response107,
      document: { ...response107.document, auxiliary_targets: [...targets, { ...targets[0] }] },
    },
    {
      ...response107,
      document: {
        ...response107.document,
        auxiliary_targets: [{ ...targets[0], part_name: 'word/../../secret.xml' }],
      },
    },
    {
      ...response107,
      document: {
        ...response107.document,
        auxiliary_targets: [
          { ...targets[0], text_summary: { ...targets[0].text_summary, sha256: 'bad' } },
        ],
      },
    },
    {
      ...response107,
      document: {
        ...response107.document,
        auxiliary_targets: [{ ...targets[2], parseable: true }],
      },
    },
    {
      ...response107,
      document: {
        ...response107.document,
        auxiliary_targets: [
          { ...targets[3], locator: { ...targets[3].locator, member_name_sha256: hash('a') } },
        ],
      },
    },
    {
      ...response107,
      document: {
        ...response107.document,
        auxiliary_targets: [{ ...targets[0], scope: { ...targets[0].scope, relationships: [] } }],
      },
    },
    {
      ...response107,
      document: {
        ...response107.document,
        auxiliary_targets: [{ ...targets[2], scope: { ...targets[2].scope, status: 'resolved' } }],
      },
    },
    { ...response107, warnings: [{ code: 'DOCX_DRAWINGS', message: 'Synthetic drawing warning' }] },
  ];
  for (const candidate of invalid)
    await assert.rejects(
      runDocumentParser(docxRequest, { invoke: async () => JSON.stringify(candidate) }),
      /INVALID_PARSE_RESPONSE/,
    );
});

test('XLSX response accepts the exact cached-formula count and keeps cached values unverified', async () => {
  const xlsxRequest: DocumentParseRequest = {
    ...request,
    material: {
      ...request.material,
      media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    },
  };
  const cell = {
    ...response.records[0],
    locator_type: 'xlsx_cell',
    locator: {
      sheet: 'Synthetic',
      cell: 'C3',
      merged_range: null,
      stable_ref: 'xlsx:Synthetic:cell:C3',
    },
    literal_quote: '=C2',
    formatting: { cached_formula_result: '123.45' },
    uncertainty: ['formula_cached_result_unverified'],
  };
  const xlsx = {
    ...response,
    material: { ...response.material, media_type: xlsxRequest.material.media_type },
    status: 'needs_confirmation',
    document: {
      page_count: null,
      worksheet_count: 1,
      missing_formula_results: 0,
      cached_formula_results: 1,
    },
    warnings: [
      { code: 'XLSX_FORMULA_CACHE_UNVERIFIED', message: 'Synthetic source cache is unverified' },
    ],
    records: [cell],
  };
  assert.equal(
    (await runDocumentParser(xlsxRequest, { invoke: async () => JSON.stringify(xlsx) })).status,
    'needs_confirmation',
  );
  const invalid = [
    { ...xlsx, status: 'parsed', warnings: [], records: [{ ...cell, uncertainty: [] }] },
    { ...xlsx, warnings: [] },
    { ...xlsx, document: { ...xlsx.document, cached_formula_results: -1 } },
    { ...xlsx, document: { ...xlsx.document, cached_formula_results: '1' } },
    { ...xlsx, document: { ...xlsx.document, cached_formula_results: 1.5 } },
    {
      ...xlsx,
      document: { ...xlsx.document, cached_formula_results: Number.MAX_SAFE_INTEGER + 1 },
    },
    { ...xlsx, document: { ...xlsx.document, cached_formula_results: 0 } },
    { ...xlsx, records: [{ ...cell, uncertainty: [] }] },
    { ...xlsx, document: { ...xlsx.document, unknown_count: 0 } },
    { ...xlsx, document: { page_count: null, worksheet_count: 1, missing_formula_results: 0 } },
  ];
  for (const candidate of invalid)
    await assert.rejects(
      runDocumentParser(xlsxRequest, { invoke: async () => JSON.stringify(candidate) }),
      /INVALID_PARSE_RESPONSE/,
    );
});

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const localPython = process.env.BB_PYTHON?.trim() || join(repositoryRoot, '.venv', 'bin', 'python');
test(
  'authorized rq-202509-02 XLSX passes the bounded strict Python to Node bridge',
  {
    skip:
      process.env.BB_RUN_AUTHORIZED_LARGE_XLSX === '1'
        ? false
        : 'set BB_RUN_AUTHORIZED_LARGE_XLSX=1 with the test Python environment',
  },
  async () => {
    const manifest = JSON.parse(
      await readFile(join(repositoryRoot, 'tests/samples/2026-09-25/manifest.json'), 'utf8'),
    ) as {
      cases: Array<{
        files: Array<{ file_id: string; path: string; sha256: string; bytes: number }>;
      }>;
    };
    const sample = manifest.cases
      .flatMap((item) => item.files)
      .find((item) => item.file_id === 'rq-202509-02');
    assert.ok(sample);
    assert.equal(sample.sha256, 'c11db9a211c7e8c21efc5aab6a8e503b3817aa78f3d184cfe5d077b0a32826c2');
    const path = join(repositoryRoot, 'tests/samples/2026-09-25', sample.path);
    const bytes = await readFile(path);
    assert.equal(bytes.length, sample.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sample.sha256);
    const xlsxRequest: DocumentParseRequest = {
      ...request,
      request_id: 'authorized-rq-202509-02',
      material: {
        ...request.material,
        material_id: 'rq-202509-02',
        media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sha256: sample.sha256,
        authorized_local_path: path,
      },
    };
    let outputBytes = 0;
    const parsed = await runDocumentParser(xlsxRequest, {
      maxOutputBytes: 32 * 1024 * 1024,
      invoke: async (serialized, options) => {
        const child = spawnSync(localPython, ['-m', 'bondbuddy_document_parser'], {
          cwd: repositoryRoot,
          env: { ...process.env, PYTHONPATH: join(repositoryRoot, 'python') },
          input: serialized,
          encoding: 'utf8',
          maxBuffer: options.maxOutputBytes,
          timeout: options.timeoutMs,
        });
        assert.equal(child.status, 0, 'authorized parser process failed');
        assert.ok(!child.error, 'authorized parser process exceeded its bounded output or time');
        outputBytes = Buffer.byteLength(child.stdout);
        assert.ok(outputBytes < 32 * 1024 * 1024);
        return child.stdout;
      },
    });
    assert.equal(parsed.parser_version, 'bondbuddy-document-parser-1.0.8');
    assert.equal(parsed.status, 'needs_confirmation');
    assert.equal(parsed.records.length, 22014);
    assert.equal(parsed.document.cached_formula_results, 3821);
    assert.equal(
      parsed.records.filter((record) =>
        record.uncertainty.includes('formula_cached_result_unverified'),
      ).length,
      3821,
    );
    parsed.records.forEach((record, index) => {
      assert.equal(record.record_id, `evidence-${String(index + 1).padStart(6, '0')}`);
      assert.equal(record.locator_type, 'xlsx_cell');
      assert.ok(typeof record.locator.sheet === 'string' && record.locator.sheet.length > 0);
      assert.match(String(record.locator.cell), /^[A-Z]+[1-9][0-9]*$/);
      assert.ok(record.literal_quote.trim().length > 0);
    });
    assert.ok(outputBytes > 13_000_000 && outputBytes < 32 * 1024 * 1024);
    console.log(
      `authorized rq-202509-02: output_bytes=${outputBytes}, records=${parsed.records.length}, cached=${parsed.document.cached_formula_results}`,
    );
  },
);
test(
  'authorized zq-202312-02 XLSX crosses the real Python to Node parser boundary',
  {
    skip: existsSync(localPython) ? false : 'repository .venv is not installed',
  },
  async () => {
    const path = join(
      repositoryRoot,
      'tests/samples/2026-09-25/zq-202312/2.5 发行人2023年末财务报表.xlsx',
    );
    const sha256 = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
    assert.equal(sha256, '1904db38788dacc07603234ac83be81548493321abc45905601422a6a9b30a2f');
    const xlsxRequest: DocumentParseRequest = {
      ...request,
      material: {
        ...request.material,
        material_id: 'zq-202312-02',
        media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sha256,
        authorized_local_path: path,
      },
    };
    const parsed = await runDocumentParser(xlsxRequest, {
      pythonExecutable: localPython,
      repoRoot: repositoryRoot,
    });
    assert.equal(parsed.parser_version, 'bondbuddy-document-parser-1.0.8');
    assert.equal(parsed.status, 'parsed');
    assert.equal(parsed.records.length, 1392);
    assert.equal(parsed.warnings.length, 0);
    assert.equal(parsed.document.worksheet_count, 8);
    assert.equal(parsed.document.cached_formula_results, 0);
    const factRequest: SemanticFactExtractionRequest = {
      schema_version: 'semantic-fact-extraction-request-v1',
      owner_user_id: 'authorized-sample-owner',
      project_id: 'authorized-zq-project',
      input_revision: 1,
      input_hash: 'a'.repeat(64),
      issuer_identity_record_id: 'reviewed-zq-identity',
      issuer_identity_version: 1,
      issuer_identity_hash: 'b'.repeat(64),
      entity_id: 'authorized-zq-entity',
      material_id: xlsxRequest.material.material_id,
      material_version: 1,
      material_sha256: sha256,
      parse_snapshot_id: 'authorized-zq-parse-snapshot',
      parse_response_sha256: createHash('sha256').update(JSON.stringify(parsed)).digest('hex'),
      parser_version: parsed.parser_version,
      records: parsed.records,
    };
    const mapped = await createNativeFinancialFactExtractor(async () => ({
      status: parsed.status,
      warnings: parsed.warnings,
    })).extract(factRequest);
    assert.equal(mapped.facts.length, 1);
    assert.equal(mapped.needs_review.length, 0);
    const refs = new Set(parsed.records.map((record) => record.record_id));
    assert.ok(mapped.facts[0]!.evidence_refs.every((ref) => refs.has(ref)));
  },
);
test(
  'worker accepts the actual Python subprocess response shape when the repository venv exists',
  {
    skip: existsSync(localPython) ? false : 'repository .venv is not installed',
  },
  async (t) => {
    const bytes = Buffer.from('synthetic parser contract evidence\n', 'utf8');
    const root = await mkdtemp(join(tmpdir(), 'bb-document-parser-contract-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'material.txt');
    await writeFile(path, bytes);
    const actualRequest: DocumentParseRequest = {
      ...request,
      material: {
        ...request.material,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        authorized_local_path: path,
      },
    };
    const result = await runDocumentParser(actualRequest, {
      pythonExecutable: localPython,
      repoRoot: repositoryRoot,
    });
    assert.equal(result.status, 'parsed');
    assert.equal(result.records[0]?.literal_quote, 'synthetic parser contract evidence');
    assert.equal(result.document.page_count, null);
  },
);

test(
  'worker strictly accepts parser 1.0.8 OPC scopes from an actual synthetic DOCX',
  {
    skip: existsSync(localPython) ? false : 'repository .venv is not installed',
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'bb-document-parser-docx-scope-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'synthetic.docx');
    const create = spawnSync(
      localPython,
      [
        '-c',
        [
          'from docx import Document',
          'doc = Document()',
          'doc.add_paragraph("Synthetic section body")',
          'doc.sections[0].header.paragraphs[0].text = "Synthetic private header text"',
          'doc.save(__import__("sys").argv[1])',
        ].join(';'),
        path,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    assert.equal(create.status, 0, create.stderr);
    const bytes = await readFile(path);
    const actualRequest: DocumentParseRequest = {
      ...request,
      material: {
        ...request.material,
        media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        authorized_local_path: path,
      },
    };
    const result = await runDocumentParser(actualRequest, {
      pythonExecutable: localPython,
      repoRoot: repositoryRoot,
    });
    assert.equal(result.parser_version, 'bondbuddy-document-parser-1.0.8');
    assert.equal(result.status, 'needs_confirmation');
    const header = result.document.auxiliary_targets?.find((target) => target.kind === 'header');
    assert.ok(header);
    assert.equal(header.scope.kind, 'section_reference');
    assert.equal(header.scope.status, 'resolved');
    assert.equal(header.scope.section_references[0]?.reference_type, 'default');
    assert.ok(!JSON.stringify(result).includes('Synthetic private header text'));
    assert.ok(result.records.every((record) => record.confidence === null));
  },
);

test('#17 a parser child killed by the kernel (SIGKILL, e.g. container OOM) reports DOCUMENT_PARSER_MEMORY_LIMIT', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bb-parser-oom-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = join(root, 'python3');
  await writeFile(fake, '#!/bin/sh\ncat >/dev/null\nkill -9 $$\n', { mode: 0o700 });
  await assert.rejects(
    runDocumentParser(request, { pythonExecutable: fake, repoRoot: root }),
    /DOCUMENT_PARSER_MEMORY_LIMIT/,
  );
});

test('#17 NDJSON parser bridge spools complete PDF evidence and rejects inconsistent stream summaries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bb-parser-stream-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pdfRequest: DocumentParseRequest = {
    ...request,
    material: { ...request.material, media_type: 'application/pdf' },
  };
  const record = (index: number, page: number) => ({
    record_id: `evidence-${String(index).padStart(6, '0')}`,
    material_id: pdfRequest.material.material_id,
    material_version: pdfRequest.material.material_version,
    content_hash: pdfRequest.material.sha256,
    locator_type: 'pdf_bbox',
    locator: {
      page,
      line: 1,
      bbox: { x0: 10, top: 20, x1: 60, bottom: 32 },
      stable_ref: `pdf:p${String(page).padStart(4, '0')}:l0001`,
    },
    literal_quote: `Synthetic amount ${index}`,
    context: `PDF page ${page}`,
    extraction_method: 'native_text',
    extractor_version: 'bondbuddy-document-parser-1.0.4',
    confidence: null,
    uncertainty: [],
    formatting: {
      fonts: [{ font_name: 'SyntheticSans', size: 9, characters: 10 }],
      word_boxes: [{ text: 'Synthetic', x0: 10, top: 20, x1: 44, bottom: 32 }],
    },
  });
  const events = [
    {
      type: 'start',
      schema_version: 'document-parse-stream-v1',
      request_id: pdfRequest.request_id,
      parser_version: 'bondbuddy-document-parser-1.0.4',
      material: {
        material_id: pdfRequest.material.material_id,
        material_version: pdfRequest.material.material_version,
        sha256: pdfRequest.material.sha256,
        media_type: 'application/pdf',
      },
      document: { page_count: 2 },
    },
    { type: 'record', record: record(1, 1) },
    { type: 'record', record: record(2, 2) },
    {
      type: 'end',
      record_count: 2,
      has_uncertainty: false,
      response: {
        schema_version: 'document-parse-response-v1',
        request_id: pdfRequest.request_id,
        parser_version: 'bondbuddy-document-parser-1.0.4',
        status: 'parsed',
        material: {
          material_id: pdfRequest.material.material_id,
          material_version: pdfRequest.material.material_version,
          media_type: 'application/pdf',
          sha256: pdfRequest.material.sha256,
        },
        warnings: [],
        document: { page_count: 2, pages_without_native_text: [], pages_with_images: [] },
        error: null,
      },
    },
  ];
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const fake = join(root, 'python3');
  await writeFile(
    fake,
    `#!/bin/sh\ncat >/dev/null\n${events.map((event) => `printf '%s\\n' ${quote(JSON.stringify(event))}`).join('\n')}\n`,
    { mode: 0o700 },
  );
  const recordsPath = join(root, 'records.ndjson');
  const result = await runDocumentParserToFile(pdfRequest, recordsPath, {
    pythonExecutable: fake,
    repoRoot: root,
  });
  assert.equal(result.recordCount, 2);
  assert.equal(result.response.document.page_count, 2);
  const rows = (await readFile(recordsPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    rows.map((row) => (row.locator as Record<string, unknown>).stable_ref),
    ['pdf:p0001:l0001', 'pdf:p0002:l0001'],
  );
  assert.equal(
    ((rows[0]!.formatting as Record<string, unknown>).word_boxes as unknown[]).length,
    1,
  );

  const inconsistent = events.map((event) => structuredClone(event));
  (inconsistent.at(-1)!.response as Record<string, unknown>).parser_version =
    'bondbuddy-document-parser-1.0.5';
  await writeFile(
    fake,
    `#!/bin/sh\ncat >/dev/null\n${inconsistent.map((event) => `printf '%s\\n' ${quote(JSON.stringify(event))}`).join('\n')}\n`,
    { mode: 0o700 },
  );
  await assert.rejects(
    runDocumentParserToFile(pdfRequest, join(root, 'bad.ndjson'), {
      pythonExecutable: fake,
      repoRoot: root,
    }),
    /INVALID_PARSE_RESPONSE/,
  );

  const oversized = events.map((event) => structuredClone(event));
  (oversized[1]!.record as Record<string, unknown>).literal_quote = 'x'.repeat(4_096);
  await writeFile(
    fake,
    `#!/bin/sh\ncat >/dev/null\n${oversized.map((event) => `printf '%s\\n' ${quote(JSON.stringify(event))}`).join('\n')}\n`,
    { mode: 0o700 },
  );
  const limitedPath = join(root, 'limited.ndjson');
  await assert.rejects(
    runDocumentParserToFile(pdfRequest, limitedPath, {
      pythonExecutable: fake,
      repoRoot: root,
      maxOutputBytes: 1_024,
    }),
    /DOCUMENT_PARSER_OUTPUT_LIMIT/,
  );
  assert.equal(
    existsSync(limitedPath),
    false,
    'an over-budget stream cannot leave partial evidence behind',
  );
});

// Emits start plus many real-looking text records so the worker's cumulative text budget trips first.
const textBudgetGenerator = [
  '#!/usr/bin/env node',
  "let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{",
  'const req=JSON.parse(input);const m=req.material;const pad="x".repeat(16000);',
  'const emit=o=>process.stdout.write(JSON.stringify(o)+"\\n");',
  'emit({type:"start",schema_version:"document-parse-stream-v1",request_id:req.request_id,parser_version:"bondbuddy-document-parser-1.0.7",material:{material_id:m.material_id,material_version:m.material_version,sha256:m.sha256,media_type:m.media_type},document:{page_count:null,encoding:"utf-8"}});',
  'for(let i=1;i<=1200;i++)emit({type:"record",record:{record_id:"evidence-"+String(i).padStart(6,"0"),material_id:m.material_id,material_version:m.material_version,content_hash:m.sha256,locator_type:"text_line",locator:{line:i,stable_ref:"text:l"+String(i).padStart(6,"0")},literal_quote:pad,context:"",extraction_method:"native_text",extractor_version:"bondbuddy-document-parser-1.0.7",confidence:null,uncertainty:[],formatting:{}}});',
  '});',
].join('\n');

test('#17 streamed text beyond the 16 MiB evidence budget is terminal and leaves no partial spool', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bb-parser-text-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = join(root, 'python3');
  await writeFile(fake, textBudgetGenerator, { mode: 0o700 });
  const recordsPath = join(root, 'records.ndjson');
  await assert.rejects(
    runDocumentParserToFile(request, recordsPath, { pythonExecutable: fake, repoRoot: root }),
    /DOCUMENT_PARSER_TEXT_LIMIT/,
  );
  assert.equal(
    existsSync(recordsPath),
    false,
    'an over-text-budget stream cannot leave partial evidence behind',
  );
});
