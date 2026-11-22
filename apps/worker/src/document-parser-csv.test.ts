import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runDocumentParser, type DocumentParseRequest } from './document-parser.js';

// Synthetic engineering fixture only. There is no authorized customer CSV in the
// repository, and an XLSX re-save must not be passed off as a native CSV here.
const sha = 'a'.repeat(64);
const request: DocumentParseRequest = {
  schema_version: 'document-parse-request-v1',
  request_id: 'parse-synthetic-csv',
  material: {
    material_id: 'material-synthetic-csv',
    material_version: 1,
    media_type: 'text/csv',
    sha256: sha,
    authorized_local_path: '/private/synthetic/material.csv',
  },
  options: {},
};

const locator = (row: number, column: number) => ({
  row,
  column,
  stable_ref: `csv:r${String(row).padStart(6, '0')}:c${String(column).padStart(4, '0')}`,
});
const record = (index: number, row: number, column: number, quote: string) => ({
  record_id: `evidence-${String(index).padStart(6, '0')}`,
  material_id: request.material.material_id,
  material_version: 1,
  content_hash: sha,
  locator_type: 'csv_cell' as const,
  locator: locator(row, column),
  literal_quote: quote,
  context: '',
  extraction_method: 'native_text' as const,
  extractor_version: 'bondbuddy-document-parser-1.0.7',
  confidence: null,
  uncertainty: [],
  formatting: {},
});
const response = {
  schema_version: 'document-parse-response-v1',
  request_id: 'parse-synthetic-csv',
  parser_version: 'bondbuddy-document-parser-1.0.7',
  status: 'parsed',
  material: {
    material_id: 'material-synthetic-csv',
    material_version: 1,
    media_type: 'text/csv',
    sha256: sha,
  },
  records: [
    record(1, 1, 1, '项目'),
    record(2, 1, 2, '金额'),
    record(3, 1, 3, '说明'),
    record(4, 2, 1, '营业收入'),
    record(5, 2, 2, '1,234,567,890,123.45'),
    record(6, 2, 3, '正常'),
    record(7, 3, 1, '营业成本'),
    record(8, 3, 3, '缺失'),
    record(9, 4, 1, '负债\n合计'),
    record(10, 4, 2, '-98765432109876543210.00'),
    record(11, 4, 3, '跨行说明'),
    record(12, 5, 1, '净利润'),
    record(13, 5, 2, '0.00'),
    record(14, 5, 3, '引号"转义"'),
  ],
  warnings: [],
  document: { page_count: null, encoding: 'utf-8-sig', delimiter: ',' },
  error: null,
};

test('worker strictly validates versioned CSV evidence and row/column anchors', async () => {
  const result = await runDocumentParser(request, {
    invoke: async (serialized) => {
      assert.deepEqual(JSON.parse(serialized), request);
      return JSON.stringify(response);
    },
  });
  assert.equal(result.status, 'parsed');
  assert.equal(result.records.length, 14);
  assert.deepEqual(
    result.records.map((item) => item.record_id),
    Array.from({ length: 14 }, (_, index) => `evidence-${String(index + 1).padStart(6, '0')}`),
  );
  assert.deepEqual(result.records[8]?.locator, {
    row: 4,
    column: 1,
    stable_ref: 'csv:r000004:c0001',
  });
  assert.equal(result.records[8]?.literal_quote, '负债\n合计');
  assert.equal(result.records[9]?.literal_quote, '-98765432109876543210.00');
  assert.equal(result.records[13]?.literal_quote, '引号"转义"');
});

test('worker rejects malformed CSV envelopes, locators and record bindings', async () => {
  const invalid: unknown[] = [
    { ...response, document: { page_count: null, encoding: 'utf-8-sig' } },
    { ...response, document: { ...response.document, delimiter: '' } },
    { ...response, document: { ...response.document, delimiter: ',', unexpected: true } },
    {
      ...response,
      records: [
        {
          ...record(1, 1, 1, '项目'),
          locator: { row: 1, column: 1, stable_ref: 'csv:r000001:c1' },
        },
      ],
    },
    {
      ...response,
      records: [
        {
          ...record(1, 1, 1, '项目'),
          locator: { row: 0, column: 1, stable_ref: 'csv:r000000:c0001' },
        },
      ],
    },
    { ...response, records: [{ ...record(1, 1, 1, '项目'), locator: { row: 1, column: 1 } }] },
    {
      ...response,
      records: [{ ...record(1, 1, 1, '项目'), locator: { ...locator(1, 1), extra: 'x' } }],
    },
    {
      ...response,
      records: [
        {
          ...record(1, 1, 1, '项目'),
          locator_type: 'text_line',
          locator: { line: 1, stable_ref: 'text:l000001' },
        },
      ],
    },
    { ...response, records: [record(1, 1, 1, '项目'), record(1, 1, 1, '项目')] },
    { ...response, records: [{ ...record(1, 1, 1, '项目'), content_hash: 'b'.repeat(64) }] },
    {
      ...response,
      records: [
        { ...record(1, 1, 1, '项目') },
        { ...record(2, 1, 2, '金额'), literal_quote: '   ' },
      ],
    },
  ];
  for (const candidate of invalid) {
    await assert.rejects(
      runDocumentParser(request, { invoke: async () => JSON.stringify(candidate) }),
      /INVALID_PARSE_RESPONSE/,
    );
  }
  await assert.rejects(
    runDocumentParser(request, {
      invoke: async () =>
        JSON.stringify({
          ...response,
          material: { ...response.material, media_type: 'text/plain' },
        }),
    }),
    /PARSE_MATERIAL_IDENTITY_MISMATCH/,
  );
});

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const localPython = process.env.BB_PYTHON?.trim() || join(repositoryRoot, '.venv', 'bin', 'python');
test(
  'synthetic native CSV crosses the real Python to Node strict boundary',
  {
    skip: existsSync(localPython) ? false : 'repository .venv is not installed',
  },
  async (t) => {
    const bytes = Buffer.from(
      '项目,金额,说明\r\n' +
        '"营业收入","1,234,567,890,123.45","正常"\r\n' +
        '"营业成本","","缺失"\r\n' +
        '"负债\n合计","-98765432109876543210.00","跨行说明"\r\n' +
        '"净利润","0.00","引号""转义"""\r\n',
      'utf8',
    );
    const root = await mkdtemp(join(tmpdir(), 'bb-document-parser-csv-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'synthetic.csv');
    await writeFile(path, bytes);
    const csvRequest: DocumentParseRequest = {
      ...request,
      material: {
        ...request.material,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        authorized_local_path: path,
      },
    };
    const result = await runDocumentParser(csvRequest, {
      pythonExecutable: localPython,
      repoRoot: repositoryRoot,
    });
    assert.equal(result.status, 'parsed');
    assert.equal(result.records.length, 14);
    assert.deepEqual(result.document, { page_count: null, encoding: 'utf-8-sig', delimiter: ',' });
    assert.deepEqual(result.records[8]?.locator, {
      row: 4,
      column: 1,
      stable_ref: 'csv:r000004:c0001',
    });
    assert.equal(result.records[13]?.literal_quote, '引号"转义"');
    result.records.forEach((item, index) => {
      assert.equal(item.record_id, `evidence-${String(index + 1).padStart(6, '0')}`);
      assert.equal(item.locator_type, 'csv_cell');
    });
  },
);
