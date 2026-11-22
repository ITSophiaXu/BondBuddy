import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SemanticFactExtractionRequest } from './fact-candidate-producer.js';
import type {
  DocumentParseRecord,
  DocumentParseRequest,
  DocumentParseResponse,
} from './document-parser.js';
import { runDocumentParser } from './document-parser.js';
import { createRqProspectusAnnualFactExtractor } from './rq-prospectus-annual-fact-extractor.js';

const repositoryRoot = join(import.meta.dirname, '../../..');
const parserPython =
  process.env.BB_PYTHON?.trim() || join(repositoryRoot, '.venv', 'bin', 'python');
const sampleRoot = join(repositoryRoot, 'tests/samples/2026-09-25');
const samplePath = join(
  sampleRoot,
  'rq-202509/2、任丘市建设投资集团有限公司2025年面向专业投资者非公开发行公司债券（第二期）募集说明书 (3).docx',
);
const sampleHash = '51f77e36dcdc8b565f9a7b58ebf87cb6be4839a3444b8602df833e3fd61ef678';

function record(
  id: string,
  path: Record<string, unknown>[],
  quote: string,
  uncertainty: string[] = [],
): DocumentParseRecord {
  return {
    record_id: id,
    material_id: 'rq-historical-material-001',
    material_version: 1,
    content_hash: sampleHash,
    locator_type: 'docx_block',
    locator: { path, stable_ref: `docx:${id}` },
    literal_quote: quote,
    context: '',
    extraction_method: 'native_text',
    extractor_version: 'bondbuddy-document-parser-1.0.6',
    confidence: 1,
    uncertainty,
    formatting: { style: '', runs: [], paragraph_overrides: {} },
  };
}

function cell(
  table: number,
  row: number,
  column: number,
  quote: string,
  id: string,
): DocumentParseRecord {
  return record(id, [{ table, row, column }, { paragraph: 1 }], quote);
}

function paragraph(paragraph: number, quote: string, id: string): DocumentParseRecord {
  return record(id, [{ paragraph }], quote);
}

const annualTables = [
  {
    table: 44,
    title: '表5-1 发行人最近两年及一期末合并资产负债表',
    section: '（一）合并财务报表',
    headers: ['项目', '2025年6月末', '2024年末', '2023年末'],
    rows: [[26, '资产总计', '1,623,564.44', '1,536,356.30']],
  },
  {
    table: 45,
    title: '表5-2 发行人最近两年及一期合并利润表',
    section: '（一）合并财务报表',
    headers: ['项目', '2025年1-6月', '2024年度', '2023年度'],
    rows: [
      [3, '其中：营业收入', '110,855.88', '94,950.37'],
      [25, '五、净利润（净亏损“-”填列）', '5,027.56', '4,938.64'],
    ],
  },
  {
    table: 46,
    title: '表5-3 发行人最近两年及一期合并现金流量表',
    section: '（一）合并财务报表',
    headers: ['项目', '2025年1-6月', '2024年度', '2023年度'],
    rows: [[12, '经营活动产生的现金流量净额', '34,838.75', '23,718.78']],
  },
  {
    table: 47,
    title: '表5-4 发行人最近两年及一期末母公司资产负债表',
    section: '（二）母公司财务报表',
    headers: ['项目', '2025年6月末', '2024年末', '2023年末'],
    rows: [[24, '资产总计', '1,041,624.12', '1,019,424.82']],
  },
  {
    table: 48,
    title: '表5-5 发行人最近两年及一期母公司利润表',
    section: '（二）母公司财务报表',
    headers: ['项目', '2025年1-6月', '2024年度', '2023年度'],
    rows: [
      [2, '一、营业收入', '13,660.90', '20,248.01'],
      [24, '五、净利润（净亏损“-”填列）', '2,383.83', '9,651.44'],
    ],
  },
  {
    table: 49,
    title: '表5-6 发行人最近两年及一期母公司现金流量表',
    section: '（二）母公司财务报表',
    headers: ['项目', '2025年1-6月', '2024年度', '2023年度'],
    rows: [[12, '经营活动产生的现金流量净额', '-57,108.40', '51,698.89']],
  },
] as const;

function syntheticRecords(): DocumentParseRecord[] {
  const out: DocumentParseRecord[] = [
    paragraph(1, '任丘市建设投资集团有限公司最近两年及一期财务数据', 'issuer-name'),
  ];
  for (const spec of annualTables) {
    const start = spec.table * 10;
    out.push(paragraph(start, spec.section, `section-${spec.table}`));
    out.push(paragraph(start + 1, spec.title, `title-${spec.table}`));
    out.push(paragraph(start + 2, '单位：万元', `unit-${spec.table}`));
    spec.headers.forEach((header, index) =>
      out.push(cell(spec.table, 1, index + 1, header, `header-${spec.table}-${index + 1}`)),
    );
    for (const [row, label, value2024, value2023] of spec.rows) {
      out.push(cell(spec.table, row, 1, label, `label-${spec.table}-${row}`));
      out.push(cell(spec.table, row, 3, value2024, `value-${spec.table}-${row}-3`));
      out.push(cell(spec.table, row, 4, value2023, `value-${spec.table}-${row}-4`));
    }
  }
  return out;
}

function request(
  records: DocumentParseRecord[],
  materialId = 'rq-historical-material-001',
): SemanticFactExtractionRequest {
  return {
    schema_version: 'semantic-fact-extraction-request-v1',
    owner_user_id: 'authorized-sample-owner',
    project_id: 'authorized-rq-project',
    input_revision: 1,
    input_hash: 'a'.repeat(64),
    issuer_identity_record_id: 'reviewed-rq-identity',
    issuer_identity_version: 1,
    issuer_identity_hash: 'b'.repeat(64),
    entity_id: 'authorized-rq-entity',
    material_id: materialId,
    material_version: 1,
    material_sha256: sampleHash,
    parse_snapshot_id: 'rq-parse-snapshot',
    parse_response_sha256: 'c'.repeat(64),
    parser_version: 'bondbuddy-document-parser-1.0.6',
    records,
  };
}

const extractor = createRqProspectusAnnualFactExtractor(async () => ({
  status: 'parsed',
  warnings: [],
}));

test('maps only direct 2023/2024 consolidated and parent annual rows as external-source candidates', async () => {
  const result = await extractor.extract(request(syntheticRecords()));
  assert.equal(result.facts.length, 16);
  assert.deepEqual(result.needs_review, []);
  assert.ok(
    result.facts.every((fact) => fact.source_kind === 'external' && fact.uncertainty.length === 0),
  );
  assert.ok(result.facts.every((fact) => fact.identity.unit === 'ten_thousand_yuan'));
  assert.ok(
    result.facts.some(
      (fact) =>
        fact.identity.metric === 'operating_revenue' &&
        fact.identity.scope === 'consolidated' &&
        fact.identity.period.start === '2024-01-01' &&
        fact.value.kind === 'known' &&
        fact.value.decimalOrText === '110855.88',
    ),
  );
  assert.ok(
    result.facts.some(
      (fact) =>
        fact.identity.metric === 'net_cash_from_operating_activities' &&
        fact.identity.scope === 'parent_only' &&
        fact.identity.period.start === '2023-01-01' &&
        fact.value.kind === 'known' &&
        fact.value.decimalOrText === '51698.89',
    ),
  );
  assert.ok(
    result.facts.every(
      (fact) =>
        fact.evidence_refs.some((ref) => ref.startsWith('title-')) &&
        fact.evidence_refs.some((ref) => ref.startsWith('unit-')) &&
        fact.evidence_refs.some((ref) => ref.startsWith('section-')),
    ),
  );
});

test('parser 1.0.7 auxiliary warnings preserve the body-only extractor result and candidate review requirements', async () => {
  const records = syntheticRecords().map((item) => ({
    ...item,
    extractor_version: 'bondbuddy-document-parser-1.0.7',
    confidence: null,
  }));
  const oldVersion = await extractor.extract(request(syntheticRecords()));
  const extractor107 = createRqProspectusAnnualFactExtractor(async () => ({
    status: 'needs_confirmation',
    warnings: [
      { code: 'DOCX_DRAWINGS', message: 'Synthetic drawing warning.' },
      { code: 'DOCX_AUXILIARY_PARTS', message: 'Synthetic auxiliary warning.' },
    ],
  }));
  const current = await extractor107.extract({
    ...request(records),
    parser_version: 'bondbuddy-document-parser-1.0.7',
  });
  assert.deepEqual(
    current.facts.map(
      ({ identity, value, source_kind, confidence, uncertainty, evidence_refs }) => ({
        identity,
        value,
        source_kind,
        confidence,
        uncertainty,
        evidence_refs,
      }),
    ),
    oldVersion.facts.map(
      ({ identity, value, source_kind, confidence, uncertainty, evidence_refs }) => ({
        identity,
        value,
        source_kind,
        confidence,
        uncertainty,
        evidence_refs,
      }),
    ),
  );
  assert.deepEqual(current.needs_review, oldVersion.needs_review);
  assert.ok(
    current.facts.every((fact) => fact.source_kind === 'external' && fact.confidence === 1),
  );
  assert.deepEqual(current.parse_snapshot, {
    snapshot_id: 'rq-parse-snapshot',
    response_sha256: 'c'.repeat(64),
    parser_version: 'bondbuddy-document-parser-1.0.7',
    material_id: 'rq-historical-material-001',
    material_version: 1,
    content_sha256: sampleHash,
  });
  const current108 = await extractor107.extract({
    ...request(
      records.map((item) => ({ ...item, extractor_version: 'bondbuddy-document-parser-1.0.8' })),
    ),
    parser_version: 'bondbuddy-document-parser-1.0.8',
  });
  assert.deepEqual(current108.facts, current.facts);
  assert.deepEqual(current108.needs_review, current.needs_review);
  assert.equal(current108.parse_snapshot.parser_version, 'bondbuddy-document-parser-1.0.8');
});

test('uncertain direct cells remain needs-review and do not become facts', async () => {
  const records = syntheticRecords().map((item) =>
    item.record_id === 'value-45-3-3'
      ? { ...item, uncertainty: ['docx_revision_effective_text_unresolved'] }
      : item,
  );
  const result = await extractor.extract(request(records));
  assert.equal(
    result.facts.length,
    15,
    'one uncertain source value should be withheld while the other direct values remain usable',
  );
  assert.equal(
    result.facts.some(
      (fact) =>
        fact.identity.metric === 'operating_revenue' &&
        fact.identity.scope === 'consolidated' &&
        fact.identity.period.start === '2024-01-01',
    ),
    false,
  );
  assert.equal(
    result.needs_review[0]?.reason_code,
    'RQ_PROSPECTUS_ANNUAL_TABLE_INCOMPLETE_OR_UNCERTAIN',
  );
  assert.ok(result.needs_review[0]?.evidence_refs.includes('value-45-3-3'));
});

test('multiple paragraphs in a target value cell are ambiguous and review evidence stays bounded', async () => {
  let records = syntheticRecords();
  for (const spec of annualTables) {
    for (const [row] of spec.rows) {
      for (const column of [3, 4]) {
        const original = records.find((item) => {
          const path = item.locator.path as Array<Record<string, unknown>>;
          return (
            path[0]?.table === spec.table && path[0]?.row === row && path[0]?.column === column
          );
        });
        assert.ok(original);
        records.push({ ...original, record_id: `duplicate-${spec.table}-${row}-${column}` });
      }
    }
  }
  const result = await extractor.extract(request(records));
  assert.equal(result.facts.length, 0, 'all ambiguous target-value cells should be withheld');
  assert.equal(
    result.needs_review[0]?.reason_code,
    'RQ_PROSPECTUS_ANNUAL_TABLE_INCOMPLETE_OR_UNCERTAIN',
  );
  assert.ok((result.needs_review[0]?.evidence_refs.length ?? 0) <= 32);
  assert.ok(
    result.needs_review[0]?.evidence_refs.every((ref) =>
      records.some((item) => item.record_id === ref),
    ),
  );
  assert.deepEqual(
    (await extractor.extract(request(records))).needs_review[0]?.evidence_refs,
    result.needs_review[0]?.evidence_refs,
  );
});

test('mismatched units or missing in-document section evidence fail closed for that statement', async () => {
  const wrongUnit = syntheticRecords().map((item) =>
    item.record_id === 'unit-44' ? { ...item, literal_quote: '单位：元' } : item,
  );
  const result = await extractor.extract(request(wrongUnit));
  assert.equal(
    result.facts.some(
      (fact) => fact.identity.metric === 'total_assets' && fact.identity.scope === 'consolidated',
    ),
    false,
  );
  assert.equal(
    result.needs_review[0]?.reason_code,
    'RQ_PROSPECTUS_ANNUAL_TABLE_INCOMPLETE_OR_UNCERTAIN',
  );

  const wrongScope = syntheticRecords().map((item) =>
    item.record_id === 'section-44' ? { ...item, literal_quote: '（二）母公司财务报表' } : item,
  );
  const scopeResult = await extractor.extract(request(wrongScope));
  assert.equal(
    scopeResult.facts.some(
      (fact) => fact.identity.metric === 'total_assets' && fact.identity.scope === 'consolidated',
    ),
    false,
  );
});

test('review evidence refs stay deterministic and bounded', async () => {
  const base = syntheticRecords();
  const many = [
    ...base,
    ...Array.from({ length: 80 }, (_, index) => ({
      ...base[index % base.length]!,
      record_id: `extra-${String(index).padStart(3, '0')}`,
    })),
  ];
  const unsupported = await extractor.extract({
    ...request(many),
    parser_version: 'unknown-parser',
  });
  assert.equal(unsupported.needs_review[0]?.evidence_refs.length, 32);
  assert.deepEqual(
    unsupported.needs_review[0]?.evidence_refs,
    [...new Set(many.map((entry) => entry.record_id))].slice(0, 32),
  );
});

test(
  'authorized rq-202509 historical prospectus tables map through the real parser',
  {
    skip:
      process.env.BB_RUN_AUTHORIZED_RQ_ANNUAL_FACT_TESTS === '1'
        ? false
        : 'set BB_RUN_AUTHORIZED_RQ_ANNUAL_FACT_TESTS=1 with the authorized sample parser environment',
  },
  async () => {
    const manifest = JSON.parse(await readFile(join(sampleRoot, 'manifest.json'), 'utf8')) as {
      cases: Array<{
        case_id: string;
        files: Array<{ file_id: string; path: string; sha256: string; bytes: number }>;
      }>;
    };
    const sample = manifest.cases
      .find((item) => item.case_id === 'rq-202509')
      ?.files.find((item) => item.file_id === 'rq-202509-01');
    assert.ok(sample);
    assert.equal(sample.sha256, sampleHash);
    const bytes = await readFile(samplePath);
    assert.equal(bytes.byteLength, sample.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sampleHash);
    const parseRequest: DocumentParseRequest = {
      schema_version: 'document-parse-request-v1',
      request_id: 'authorized-rq-annual-facts',
      material: {
        material_id: 'rq-historical-material-001',
        material_version: 1,
        media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sha256: sampleHash,
        authorized_local_path: samplePath,
      },
      options: {},
    };
    const parsed = await runDocumentParser(parseRequest, {
      pythonExecutable: parserPython,
      repoRoot: repositoryRoot,
      timeoutMs: 300_000,
      maxOutputBytes: 128 * 1024 * 1024,
    });
    assert.equal(parsed.parser_version, 'bondbuddy-document-parser-1.0.8');
    assert.ok(parsed.status === 'parsed' || parsed.status === 'needs_confirmation');
    assert.ok(
      parsed.warnings.every((warning) =>
        ['DOCX_DRAWINGS', 'DOCX_AUXILIARY_PARTS'].includes(warning.code),
      ),
    );
    const semanticRequest = request(parsed.records, parseRequest.material.material_id);
    const mapped = await createRqProspectusAnnualFactExtractor(async () => ({
      status: parsed.status,
      warnings: parsed.warnings,
    })).extract(semanticRequest);
    assert.equal(mapped.facts.length, 16);
    assert.deepEqual(mapped.needs_review, []);
    assert.ok(
      mapped.facts.every((fact) =>
        fact.evidence_refs.every((ref) =>
          parsed.records.some((record) => record.record_id === ref),
        ),
      ),
    );
    assert.ok(mapped.facts.every((fact) => fact.source_kind === 'external'));
    const actual = new Map(
      mapped.facts.map((fact) => {
        const period =
          'asOf' in fact.identity.period
            ? fact.identity.period.asOf
            : fact.identity.period.start?.slice(0, 4);
        assert.equal(fact.value.kind, 'known');
        return [
          `${fact.identity.scope}|${fact.identity.metric}|${period}`,
          fact.value.kind === 'known' ? fact.value.decimalOrText : '',
        ];
      }),
    );
    assert.deepEqual(
      actual,
      new Map([
        ['consolidated|total_assets|2024-12-31', '1623564.44'],
        ['consolidated|total_assets|2023-12-31', '1536356.30'],
        ['consolidated|operating_revenue|2024', '110855.88'],
        ['consolidated|operating_revenue|2023', '94950.37'],
        ['consolidated|net_profit|2024', '5027.56'],
        ['consolidated|net_profit|2023', '4938.64'],
        ['consolidated|net_cash_from_operating_activities|2024', '34838.75'],
        ['consolidated|net_cash_from_operating_activities|2023', '23718.78'],
        ['parent_only|total_assets|2024-12-31', '1041624.12'],
        ['parent_only|total_assets|2023-12-31', '1019424.82'],
        ['parent_only|operating_revenue|2024', '13660.90'],
        ['parent_only|operating_revenue|2023', '20248.01'],
        ['parent_only|net_profit|2024', '2383.83'],
        ['parent_only|net_profit|2023', '9651.44'],
        ['parent_only|net_cash_from_operating_activities|2024', '-57108.40'],
        ['parent_only|net_cash_from_operating_activities|2023', '51698.89'],
      ]),
    );
    assert.ok((parsed as DocumentParseResponse).material);
  },
);
