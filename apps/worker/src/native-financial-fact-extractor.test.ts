import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { SemanticFactExtractionRequest } from './fact-candidate-producer.js';
import type { DocumentParseRecord, DocumentParseRequest, DocumentParseResponse } from './document-parser.js';
import {
  createNativeFinancialFactExtractor,
  NATIVE_FINANCIAL_FACT_EXTRACTOR_ID,
  NATIVE_FINANCIAL_FACT_EXTRACTOR_VERSION,
  type NativeFinancialParseCompletion,
} from './native-financial-fact-extractor.js';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const localPython = join(sourceRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const sampleParserPython = process.env.BB_PYTHON?.trim() || (existsSync(localPython)
  ? localPython
  : process.platform === 'win32' ? 'python' : 'python3');
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const SUPPORTED_SAMPLE_PARSER_VERSIONS = new Set([
  'bondbuddy-document-parser-1.0.3',
  'bondbuddy-document-parser-1.0.5',
  'bondbuddy-document-parser-1.0.6',
]);

function evidence(recordId: string, sheet: string, cell: string, literalQuote: string, sheetState = 'visible'): DocumentParseRecord {
  return {
    record_id: recordId,
    material_id: 'zq-202312-02',
    material_version: 1,
    content_hash: 'a'.repeat(64),
    locator_type: 'xlsx_cell',
    locator: { sheet, cell, merged_range: null, stable_ref: `xlsx:${encodeURIComponent(sheet)}:cell:${cell}` },
    literal_quote: literalQuote,
    context: `Worksheet ${sheet}`,
    extraction_method: 'native_text',
    extractor_version: 'bondbuddy-document-parser-1.0.3',
    confidence: 1,
    uncertainty: [],
    formatting: { number_format: 'General', data_type: 's', sheet_state: sheetState },
  };
}

function sampleRecords(): DocumentParseRecord[] {
  return [
    evidence('title', '合并利润表', 'A1', '合并利润表'),
    evidence('scope', '合并利润表', 'B2', '口径：合并口径'),
    evidence('period-note', '合并利润表', 'C2', '期间：2023年度、2022年度、2021年度'),
    evidence('unit', '合并利润表', 'E2', '金额单位：人民币元'),
    evidence('period-2023', '合并利润表', 'C3', '2023年度'),
    evidence('metric', '合并利润表', 'A5', '其中：营业收入'),
    evidence('value', '合并利润表', 'C5', '3894631419.08'),
  ];
}

// Synthetic literal-value variant exercises the positive branch; the authorized workbook's D6 is a formula.
function rqInterimRecords(value = '641154596.19', uncertainty: string[] = []): DocumentParseRecord[] {
  return [
    evidence('rq-title', '02合并利润表', 'A1', '合并利润表'),
    evidence('rq-period-note', '02合并利润表', 'B3', '2025年1-9月'),
    evidence('rq-unit', '02合并利润表', 'E3', '金额单位：人民币元'),
    evidence('rq-current-header', '02合并利润表', 'D4', '2025年1-9月'),
    evidence('rq-comparison-header', '02合并利润表', 'E4', '2024年1-9月'),
    evidence('rq-metric', '02合并利润表', 'A6', '    其中：营业收入'),
    { ...evidence('rq-value', '02合并利润表', 'D6', value), uncertainty,
      formatting: { number_format: 'General', data_type: value.startsWith('=') ? 'f' : 'n', sheet_state: 'visible',
        ...(value.startsWith('=') ? { cached_formula_result: '641154596.19000006' } : {}) } },
    evidence('rq-parent-title', '02母公司利润表', 'A1', '母公司利润表'),
    evidence('rq-parent-period', '02母公司利润表', 'B3', '2025年1-9月'),
    evidence('rq-parent-metric', '02母公司利润表', 'A6', '其中：营业收入'),
    evidence('rq-parent-value', '02母公司利润表', 'D6', '100.00'),
    evidence('rq-interest-expense-label', '02合并利润表', 'A24', '          其中：利息费用'),
    evidence('rq-interest-expense-value', '02合并利润表', 'D24', '295374639.70999998'),
    evidence('rq-interest-income-label', '02合并利润表', 'A25', '                  利息收入'),
    evidence('rq-interest-income-value', '02合并利润表', 'D25', '5438663.7699999996'),
  ];
}

function request(records: DocumentParseRecord[], parserVersion = 'bondbuddy-document-parser-1.0.3'): SemanticFactExtractionRequest {
  return {
    schema_version: 'semantic-fact-extraction-request-v1',
    owner_user_id: 'sample-owner',
    project_id: 'sample-zq-202312',
    input_revision: 1,
    input_hash: digest('synthetic immutable input'),
    issuer_identity_record_id: 'synthetic-reviewed-identity-record',
    issuer_identity_version: 1,
    issuer_identity_hash: digest('synthetic identity binding'),
    entity_id: 'synthetic-zq-entity',
    material_id: 'zq-202312-02',
    material_version: 1,
    material_sha256: 'a'.repeat(64),
    parse_snapshot_id: 'synthetic-parse-snapshot',
    parse_response_sha256: digest('synthetic parser response'),
    parser_version: parserVersion,
    records,
  };
}

const completeParse: NativeFinancialParseCompletion = { status: 'parsed', warnings: [] };
const extractor = createNativeFinancialFactExtractor(async () => completeParse);

test('maps only the exact consolidated 2023 operating revenue row and keeps parent-sheet facts separate', async () => {
  const parentSheet = [
    evidence('parent-title', '母公司利润表', 'A1', '母公司利润表'),
    evidence('parent-scope', '母公司利润表', 'B2', '口径：母公司'),
    evidence('parent-period', '母公司利润表', 'C3', '2023年度'),
    evidence('parent-metric', '母公司利润表', 'A5', '其中：营业收入'),
    evidence('parent-value', '母公司利润表', 'C5', '100.00'),
  ];
  const result = await extractor.extract(request([...sampleRecords(), ...parentSheet]));
  assert.equal(result.extractor.id, NATIVE_FINANCIAL_FACT_EXTRACTOR_ID);
  assert.equal(result.extractor.version, NATIVE_FINANCIAL_FACT_EXTRACTOR_VERSION);
  assert.equal(result.facts.length, 1);
  assert.equal(result.needs_review.length, 0);
  assert.deepEqual(result.facts[0]!.identity, {
    scope: 'consolidated', metric: 'operating_revenue', period: { start: '2023-01-01', end: '2023-12-31' },
    currency: 'CNY', unit: 'yuan', basis: 'reported_financial_statement',
  });
  assert.equal(result.facts[0]!.value.kind, 'known');
  if (result.facts[0]!.value.kind === 'known') assert.equal(result.facts[0]!.value.decimalOrText, '3894631419.08');
  assert.equal(result.facts[0]!.source_kind, 'external');
  assert.deepEqual(result.facts[0]!.evidence_refs, ['title', 'scope', 'period-note', 'unit', 'period-2023', 'metric', 'value']);
  assert.ok(result.facts[0]!.evidence_refs.every((id) => !id.startsWith('parent-')));
});

test('accepts the explicitly supported parser 1.0.5/1.0.6 and rejects unknown parser versions', async () => {
  for (const parserVersion of ['bondbuddy-document-parser-1.0.5', 'bondbuddy-document-parser-1.0.6']) {
    const versionedRecords = sampleRecords().map((record) => ({ ...record, extractor_version: parserVersion }));
    const result = await extractor.extract(request(versionedRecords, parserVersion));
    assert.equal(result.facts.length, 1, `${parserVersion} should reach the native mapper`);
    assert.equal(result.facts[0]?.identity.metric, 'operating_revenue');
  }

  const unknownResult = await extractor.extract(request(sampleRecords(), 'bondbuddy-document-parser-9.9.9'));
  assert.equal(unknownResult.facts.length, 0);
  assert.equal(unknownResult.needs_review[0]?.reason_code, 'UNSUPPORTED_NATIVE_FINANCIAL_PARSE');
});

test('duplicate metric rows and unsupported units return anchored needs_review instead of a fact', async () => {
  const duplicated = [...sampleRecords(), evidence('metric-duplicate', '合并利润表', 'A6', '其中：营业收入'),
    evidence('value-duplicate', '合并利润表', 'C6', '777.00')];
  const duplicateResult = await extractor.extract(request(duplicated));
  assert.equal(duplicateResult.facts.length, 0);
  assert.equal(duplicateResult.needs_review[0]?.reason_code, 'FINANCIAL_METRIC_LABEL_DUPLICATE');
  assert.ok(duplicateResult.needs_review[0]?.evidence_refs.includes('metric-duplicate'));

  const unsupportedUnit = sampleRecords().map((record) => record.record_id === 'unit'
    ? { ...record, literal_quote: '金额单位：人民币万元' }
    : record);
  const unitResult = await extractor.extract(request(unsupportedUnit));
  assert.equal(unitResult.facts.length, 0);
  assert.equal(unitResult.needs_review[0]?.reason_code, 'FINANCIAL_HEADER_OR_UNIT_AMBIGUOUS');
  assert.ok(unitResult.needs_review[0]?.evidence_refs.includes('unit'));
});

test('hidden auxiliary sheets do not override visible facts or contribute values', async () => {
  const hidden = [...sampleRecords(), evidence('hidden-sheet-cell', '辅助表', 'A1', '2022年度', 'hidden')];
  const hiddenResult = await extractor.extract(request(hidden));
  assert.equal(hiddenResult.facts.length, 1);
  assert.ok(hiddenResult.facts[0]?.evidence_refs.every((id) => id !== 'hidden-sheet-cell'));

  const hiddenOnly = [evidence('hidden-only-title', '合并利润表', 'A1', '合并利润表', 'hidden'),
    evidence('hidden-only-value', '合并利润表', 'C5', '999999.00', 'hidden')];
  const hiddenOnlyResult = await extractor.extract(request(hiddenOnly));
  assert.equal(hiddenOnlyResult.facts.length, 0);

  const hiddenWarningExtractor = createNativeFinancialFactExtractor(async () => ({
    status: 'needs_confirmation', warnings: [{ code: 'XLSX_HIDDEN_SHEET', message: 'hidden sheet present' }],
  }));
  const hiddenWarningResult = await hiddenWarningExtractor.extract(request(sampleRecords()));
  assert.equal(hiddenWarningResult.facts.length, 1);
  assert.ok(hiddenWarningResult.facts[0]?.evidence_refs.every((id) => !id.includes('hidden')));
});

test('synthetic exact current nine-month values keep consolidated and parent sheets separate', async () => {
  const result = await extractor.extract(request(rqInterimRecords(), 'bondbuddy-document-parser-1.0.6'));
  assert.equal(result.facts.length, 3);
  const fact = result.facts.find((candidate) => candidate.identity.metric === 'operating_revenue')!;
  assert.deepEqual(fact.identity, {
    scope: 'consolidated', metric: 'operating_revenue', period: { start: '2025-01-01', end: '2025-09-30' },
    currency: 'CNY', unit: 'yuan', basis: 'reported_financial_statement',
  });
  assert.equal(fact.value.kind, 'known');
  if (fact.value.kind === 'known') assert.equal(fact.value.decimalOrText, '641154596.19');
  assert.deepEqual(fact.evidence_refs, ['rq-title', 'rq-period-note', 'rq-unit', 'rq-current-header', 'rq-metric', 'rq-value']);
  assert.ok(fact.evidence_refs.every((id) => !id.includes('parent')));
  assert.equal(result.facts.find((candidate) => candidate.identity.metric === 'interest_expense')?.value.kind, 'known');
  assert.equal(result.facts.find((candidate) => candidate.identity.metric === 'interest_expense')?.identity.scope, 'consolidated');
  assert.equal(result.facts.find((candidate) => candidate.identity.metric === 'interest_income')?.identity.unit, 'yuan');
});

test('a cached formula value for current-period revenue stays needs_confirmation', async () => {
  const records = rqInterimRecords("='[1]利润试算'!$AI$7", ['formula_cached_result_unverified']);
  const result = await extractor.extract(request(records, 'bondbuddy-document-parser-1.0.6'));
  assert.equal(result.facts.length, 2, 'certain direct numeric lines remain independently extractable');
  assert.ok(result.facts.every((fact) => fact.identity.metric !== 'operating_revenue'));
  const revenueReview = result.needs_review.find((item) => item.evidence_refs.includes('rq-value'));
  assert.equal(revenueReview?.reason_code, 'PARSER_EVIDENCE_NEEDS_CONFIRMATION');

  const warningExtractor = createNativeFinancialFactExtractor(async () => ({
    status: 'needs_confirmation', warnings: [{ code: 'XLSX_FORMULA_CACHE_UNVERIFIED', message: 'formula cache present' }],
  }));
  const warningResult = await warningExtractor.extract(request(records, 'bondbuddy-document-parser-1.0.6'));
  assert.equal(warningResult.facts.length, 2);
  assert.ok(warningResult.needs_review.some((item) => item.evidence_refs.includes('rq-value') && item.reason_code === 'PARSER_EVIDENCE_NEEDS_CONFIRMATION'));
});

test('large parser warning results cap evidence refs at 32 in stable record-id order', async () => {
  const records = [...sampleRecords(), ...Array.from({ length: 40 }, (_, index) =>
    evidence(`bulk-${String(index).padStart(2, '0')}`, '辅助表', `A${index + 1}`, `value-${index}`))];
  const warningExtractor = createNativeFinancialFactExtractor(async () => ({
    status: 'needs_confirmation', warnings: [{ code: 'PARSER_WARNING', message: 'ambiguous workbook content' }],
  }));

  const result = await warningExtractor.extract(request(records));
  const needsReview = result.needs_review[0];
  assert.equal(result.facts.length, 0);
  assert.ok(needsReview);
  assert.equal(needsReview.reason_code, 'PARSER_STATUS_OR_WARNING_NEEDS_CONFIRMATION');
  assert.equal(needsReview.evidence_refs.length, 32);
  assert.deepEqual(needsReview.evidence_refs, [
    'title', 'scope', 'period-note', 'unit', 'period-2023', 'metric', 'value',
    ...records.map((record) => record.record_id).filter((id) => id.startsWith('bulk-')).sort().slice(0, 25),
  ]);
});

test('zero parse evidence raises a controlled fail-closed error', async () => {
  await assert.rejects(extractor.extract(request([])), /NATIVE_FINANCIAL_NO_PARSE_EVIDENCE/);
});

type AuthorizedFile = { path: string; media_type: string; sha256: string; bytes: number; upload_role: string };
type AuthorizedManifest = { cases: Array<{ case_id: string; files: AuthorizedFile[] }> };

test('real authorized zq XLSX parses through Python and maps A5/C5 with manifest-bound evidence', {
  skip: process.env.BB_RUN_AUTHORIZED_SAMPLE_TESTS === '1' ? false : 'set BB_RUN_AUTHORIZED_SAMPLE_TESTS=1 to parse the authorized XLSX sample',
}, async () => {
  const manifest = JSON.parse(await readFile(join(sourceRoot, 'tests/samples/2026-09-25/manifest.json'), 'utf8')) as AuthorizedManifest;
  const sample = manifest.cases.find((item) => item.case_id === 'zq-202312');
  assert.ok(sample, 'authorized zq-202312 case must exist in the manifest');
  const file = sample.files.find((item) => item.path.endsWith('2.5 发行人2023年末财务报表.xlsx'));
  assert.ok(file, 'authorized zq financial XLSX must exist in the manifest');
  assert.equal(file.upload_role, 'financial');

  const path = join(sourceRoot, 'tests/samples/2026-09-25', file.path);
  const bytes = await readFile(path);
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(bytes.byteLength, file.bytes);
  assert.equal(contentHash, file.sha256);

  const parseRequest: DocumentParseRequest = {
    schema_version: 'document-parse-request-v1',
    request_id: 'authorized-zq-financial-parse',
    material: {
      material_id: 'zq-202312-02', material_version: 1,
      media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sha256: contentHash, authorized_local_path: resolve(path),
    },
    options: {},
  };
  // Before #196 lands, the checkout parser is the unsupported interim 1.0.4.1.
  // Point the opt-in at the exact 1.0.6 source tree under integration review.
  const parserSourceRoot = process.env.BB_PARSER_106_SOURCE_ROOT?.trim() || sourceRoot;
  const processResult = spawnSync(sampleParserPython, ['-m', 'bondbuddy_document_parser'], {
    cwd: parserSourceRoot,
    env: { ...process.env, PYTHONPATH: join(parserSourceRoot, 'python') },
    input: JSON.stringify(parseRequest),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.ifError(processResult.error);
  assert.equal(processResult.status, 0, `Python parser failed: ${processResult.stderr}`);
  const parsed = JSON.parse(processResult.stdout) as DocumentParseResponse;
  assert.equal(parsed.status, 'parsed');
  assert.deepEqual(parsed.warnings, []);
  assert.ok(SUPPORTED_SAMPLE_PARSER_VERSIONS.has(parsed.parser_version),
    `sample parser version must be explicitly supported, received ${parsed.parser_version}`);
  assert.equal(parsed.document.worksheet_count, 8);

  const mapped = await createNativeFinancialFactExtractor(async () => ({ status: parsed.status, warnings: parsed.warnings }))
    .extract(request(parsed.records, parsed.parser_version));
  assert.equal(mapped.facts.length, 1);
  assert.equal(mapped.needs_review.length, 0);
  const refs = new Map(parsed.records.map((record) => [record.record_id, record]));
  const fact = mapped.facts[0]!;
  assert.equal(fact.source_kind, 'external');
  assert.equal(fact.confidence, 1, 'mapping confidence only; source confidence is carried by the null-confidence parser anchors');
  assert.equal('auditCheck' in fact, false, 'semantic extraction does not attest that an auditor or reviewer verified the value');
  assert.equal(fact.identity.metric, 'operating_revenue');
  assert.notEqual(fact.identity.metric, 'main_business_revenue');
  assert.deepEqual(fact.identity.period, { start: '2023-01-01', end: '2023-12-31' });
  assert.equal(fact.identity.scope, 'consolidated');
  assert.equal(fact.identity.unit, 'yuan');
  assert.deepEqual(fact.evidence_refs.map((id) => refs.get(id)?.locator.cell), ['A1', 'B2', 'C2', 'E2', 'C3', 'A5', 'C5']);
  assert.equal(refs.get(fact.evidence_refs[5]!)?.literal_quote, '其中：营业收入');
  assert.equal(refs.get(fact.evidence_refs[6]!)?.literal_quote, '3894631419.08');

});
