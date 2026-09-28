import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { OcrReview } from '@bondbuddy/contracts';
import type { DocumentParseRecord } from './document-parser.js';
import { proposeTargetReportingPeriods, type LockedFinancialMaterialRef, type NativePeriodEvidenceSnapshot,
  type OcrPeriodEvidenceSnapshot } from './target-period-candidates.js';

const material: LockedFinancialMaterialRef = {
  material_id: 'financial-1', material_version: 2, material_sha256: 'a'.repeat(64), role: 'interimFinancial',
};
const cutoff = '2025-06-30';
const otherMaterial: LockedFinancialMaterialRef = {
  material_id: 'financial-2', material_version: 1, material_sha256: 'b'.repeat(64), role: 'financial',
};

function nativeRecord(id: string, quote: string, context: string, options: {
  readonly uncertainty?: string[]; readonly locator?: Record<string, unknown>;
} = {}): DocumentParseRecord & { record_sha256: string } {
  return { record_id: id, material_id: material.material_id, material_version: material.material_version,
    content_hash: material.material_sha256, locator_type: 'xlsx_cell',
    locator: options.locator ?? { path: [{ sheet: '合并利润表', table: 1, row: 1, column: 2 }] },
    literal_quote: quote, context, extraction_method: 'native_text', extractor_version: 'parser-1', confidence: 0.99,
    uncertainty: options.uncertainty ?? [], formatting: { sheet_state: 'visible' }, record_sha256: createHash('sha256').update(id).digest('hex') };
}

function nativeSnapshot(records: readonly (DocumentParseRecord & { record_sha256: string })[], options: {
  readonly status?: NativePeriodEvidenceSnapshot['status']; readonly warnings?: NativePeriodEvidenceSnapshot['warnings'];
} = {}): NativePeriodEvidenceSnapshot {
  return { method: 'native_text', snapshot_id: 'parse-snapshot-1', response_sha256: 'c'.repeat(64),
    material_id: material.material_id, material_version: material.material_version, material_sha256: material.material_sha256,
    media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    parser_version: 'parser-1', status: options.status ?? 'parsed', warnings: options.warnings ?? [], records };
}

function ocrSnapshot(text: string, uncertainty: string[] = []): OcrPeriodEvidenceSnapshot {
  const review: OcrReview = { snapshot_id: 'ocr-snapshot-1', result_sha256: 'd'.repeat(64), material_id: material.material_id,
    material_version: material.material_version, purpose: 'source_preflight', coverage: 'complete', page_count: 1,
    pages: [{ page: 1, width: 100, height: 100, rotation_clockwise: 0, coordinate_system: 'rendered_pixels_top_left',
      image_sha256: 'e'.repeat(64), image_url: 'https://example.invalid/page-1', warnings: [] }],
    records: [{ record_id: 'ocr-record-1', page: 1, bbox: [0, 0, 90, 20], text, confidence: 0.98,
      numeric: { kind: 'unparsed', decimal: null, unit: null }, cell: null, uncertainty, eligible_for_manuscript: false }],
    corrections: [], warnings: [], eligible_for_manuscript: false };
  return { method: 'ocr', review, processor_version: 'ocr-processor-1', material_sha256: material.material_sha256,
    record_sha256_by_id: { 'ocr-record-1': 'f'.repeat(64) } };
}

function extract(snapshots: readonly (NativePeriodEvidenceSnapshot | OcrPeriodEvidenceSnapshot)[], reportingCutoff = cutoff) {
  return proposeTargetReportingPeriods({ reporting_cutoff: reportingCutoff, locked_materials: [material], snapshots });
}
function extractWith(lockedMaterials: readonly LockedFinancialMaterialRef[], snapshots: readonly (NativePeriodEvidenceSnapshot | OcrPeriodEvidenceSnapshot)[], reportingCutoff = cutoff) {
  return proposeTargetReportingPeriods({ reporting_cutoff: reportingCutoff, locked_materials: lockedMaterials, snapshots });
}

test('proposes annual and interim periods from exact native evidence and keeps every candidate pending', () => {
  const snapshot = nativeSnapshot([
    nativeRecord('annual', '2024年度', '财务会计信息 / 合并财务报表报告期'),
    nativeRecord('half-year', '2025年上半年', '财务报表 / 合并口径'),
  ]);
  const result = extract([snapshot]);
  assert.equal(result.status, 'needs_confirmation');
  assert.equal(result.completeness, 'not_determined');
  assert.deepEqual(result.candidates.map(item => [item.start, item.end, item.period_kind, item.scope]), [
    ['2024-01-01', '2024-12-31', 'annual', 'consolidated'],
    ['2025-01-01', '2025-06-30', 'interim', 'consolidated'],
  ]);
  assert.ok(result.candidates.every(item => item.status === 'needs_confirmation'));
  assert.ok(result.candidates.every(item => item.evidence.every(ref => ref.snapshot_id === snapshot.snapshot_id &&
    ref.response_sha256 === snapshot.response_sha256 && ref.material_sha256 === material.material_sha256 &&
    /^[a-f0-9]{64}$/.test(ref.record_sha256))));
  assert.ok(result.candidates.every(item => item.anchors.some(anchor => anchor.kind === 'period_end')));
  assert.ok(result.pending_reasons.includes('issuer_identity_not_established_by_candidate_evidence'));
});

test('PDF periods require a nearby table heading and cite only the bounded page evidence cluster', () => {
  const pdfRecord = (id: string, quote: string, top: number, line: number) => ({
    ...nativeRecord(id, quote, 'PDF page 1'), locator_type: 'pdf_bbox' as const,
    locator: { page: 1, line, bbox: { x0: 10, top, x1: 300, bottom: top + 10 }, stable_ref: `pdf:p0001:l${String(line).padStart(4, '0')}` },
  });
  const records = [
    pdfRecord('pdf-header', '合并资产负债表', 30, 1),
    pdfRecord('pdf-entity', '杞县豫资城乡发展建设有限公司', 40, 2),
    pdfRecord('pdf-period', '2024年度', 50, 3),
    pdfRecord('pdf-signing-year', '签署日期：2025年度', 55, 4),
    pdfRecord('pdf-report-number', '审计报告编号：2026年', 60, 5),
    pdfRecord('pdf-distant-period', '2023年度', 300, 6),
    pdfRecord('pdf-distant-issue-date', '发行日期：2025年12月31日', 320, 7),
  ].map(record => ({ ...record, record_sha256: createHash('sha256').update(record.record_id).digest('hex') }));
  const snapshot: NativePeriodEvidenceSnapshot = {
    ...nativeSnapshot(records), media_type: 'application/pdf',
  };
  const result = extract([snapshot]);
  assert.deepEqual(result.candidates.map(candidate => candidate.end), ['2024-12-31']);
  const candidate = result.candidates[0]!;
  assert.equal(candidate.status, 'needs_confirmation');
  assert.deepEqual(candidate.evidence.map(item => item.record_id).sort(), ['pdf-entity', 'pdf-header', 'pdf-period']);
  assert.ok(candidate.anchors.some(anchor => anchor.kind === 'table_header' && anchor.evidence.record_id === 'pdf-header'));
  assert.ok(candidate.anchors.some(anchor => anchor.kind === 'entity' && anchor.evidence.record_id === 'pdf-entity'));
  assert.ok(candidate.anchors.some(anchor => anchor.kind === 'period_end' && anchor.evidence.record_id === 'pdf-period'));
});

test('multiple PDF periods on one page keep separate local evidence clusters', () => {
  const pdfRecord = (id: string, quote: string, top: number, line: number) => ({
    ...nativeRecord(id, quote, 'PDF page 1'), locator_type: 'pdf_bbox' as const,
    locator: { page: 1, line, bbox: { x0: 10, top, x1: 300, bottom: top + 10 }, stable_ref: `pdf:p0001:l${String(line).padStart(4, '0')}` },
  });
  const records = [
    pdfRecord('cluster-a-header', '合并资产负债表', 30, 1),
    pdfRecord('cluster-a-entity', '甲方建设有限公司', 40, 2),
    pdfRecord('cluster-a-period', '2024年度', 50, 3),
    pdfRecord('cluster-b-header', '合并利润表', 130, 4),
    pdfRecord('cluster-b-entity', '乙方发展有限公司', 140, 5),
    pdfRecord('cluster-b-period', '2025年1-6月', 150, 6),
    pdfRecord('unrelated-period', '2022年度', 500, 7),
  ].map(record => ({ ...record, record_sha256: createHash('sha256').update(record.record_id).digest('hex') }));
  const snapshot: NativePeriodEvidenceSnapshot = { ...nativeSnapshot(records), media_type: 'application/pdf' };
  const result = extract([snapshot]);
  assert.deepEqual(result.candidates.map(candidate => [candidate.end, candidate.period_kind]), [
    ['2024-12-31', 'annual'], ['2025-06-30', 'interim'],
  ]);
  const annual = result.candidates.find(candidate => candidate.end === '2024-12-31')!;
  const interim = result.candidates.find(candidate => candidate.end === '2025-06-30')!;
  assert.deepEqual(annual.evidence.map(item => item.record_id).sort(), ['cluster-a-entity', 'cluster-a-header', 'cluster-a-period']);
  assert.deepEqual(interim.evidence.map(item => item.record_id).sort(), ['cluster-b-entity', 'cluster-b-header', 'cluster-b-period']);
  assert.ok(result.candidates.every(candidate => candidate.status === 'needs_confirmation'));
});

test('PDF records without a valid same-page bbox have no period candidate or whole-page fallback', () => {
  const records = [
    { ...nativeRecord('pdf-header', '合并资产负债表', 'PDF page 1'), locator_type: 'pdf_bbox' as const,
      locator: { page: 1, line: 1, bbox: { x0: 10, top: 30, x1: 300, bottom: 40 }, stable_ref: 'pdf:p0001:l0001' } },
    { ...nativeRecord('pdf-period-no-bbox', '2024年度', 'PDF page 1'), locator_type: 'pdf_bbox' as const,
      locator: { page: 1, line: 2, bbox: { x0: 10, top: 0, x1: 300, bottom: 0 }, stable_ref: 'pdf:p0001:l0002' } },
    { ...nativeRecord('pdf-period-other-page', '2025年度', 'PDF page 2'), locator_type: 'pdf_bbox' as const,
      locator: { page: 2, line: 1, bbox: { x0: 10, top: 50, x1: 300, bottom: 60 }, stable_ref: 'pdf:p0002:l0001' } },
  ].map(record => ({ ...record, record_sha256: createHash('sha256').update(record.record_id).digest('hex') }));
  const snapshot: NativePeriodEvidenceSnapshot = { ...nativeSnapshot(records), media_type: 'application/pdf' };
  assert.deepEqual(extract([snapshot]).candidates, []);
});

test('cutoff only classifies extracted dates and never creates a reporting period', () => {
  const afterCutoff = nativeSnapshot([nativeRecord('annual-2025', '2025年度', '财务报表报告期 合并')]);
  const result = extract([afterCutoff]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.end, '2025-12-31');
  assert.equal(result.candidates[0]!.cutoff_relation, 'after');
  assert.ok(result.candidates[0]!.pending_reasons.includes('candidate_after_reporting_cutoff'));
  assert.equal(extract([], '2025-12-31').candidates.length, 0);

  const wrongQuarter = extract([nativeSnapshot([nativeRecord('q1', '2025年1-3月', '财务报表报告期 合并')])]);
  assert.equal(wrongQuarter.candidates[0]!.end, '2025-03-31');
  assert.ok(wrongQuarter.candidates[0]!.anchors.filter(anchor => anchor.kind === 'period_end')
    .every(anchor => anchor.evidence.quote.includes('2025年1-3月')));
  assert.ok(!wrongQuarter.candidates.some(item => item.end === cutoff), 'same year cannot make Q1 evidence support a June cutoff');
});

test('recognizes bounded visible XLSX financial header month ranges and excludes hidden-sheet periods', () => {
  const xlsxCell = (id: string, sheet: string, cell: string, quote: string, sheetState = 'visible') => ({
    ...nativeRecord(id, quote, `Worksheet ${sheet}`, { locator: { sheet, cell, stable_ref: `xlsx:${sheet}:${cell}` } }),
    formatting: { sheet_state: sheetState },
  });
  const snapshot = nativeSnapshot([
    xlsxCell('visible-current', '02合并利润表', 'B3', '2025年1-9月'),
    xlsxCell('visible-comparison', '02合并利润表', 'E4', '2024年1-9月'),
    xlsxCell('ordinary-date', '02合并利润表', 'A2', '2025年9月30日'),
    xlsxCell('hidden-half-year', 'Sheet4', 'B3', '2022年1-6月财务报表报告期', 'hidden'),
    xlsxCell('very-hidden-annual', 'Sheet3', 'B3', '2022年度财务报表报告期', 'veryHidden'),
    xlsxCell('unknown-visibility', '合并利润表', 'B3', '2023年度财务报表报告期', 'unknown'),
  ]);

  const result = extract([snapshot], '2025-09-30');
  assert.equal(result.status, 'needs_confirmation');
  assert.equal(result.completeness, 'not_determined');
  assert.deepEqual(result.candidates.map(item => [item.start, item.end, item.period_kind, item.scope]), [
    ['2024-01-01', '2024-09-30', 'interim', 'consolidated'],
    ['2025-01-01', '2025-09-30', 'interim', 'consolidated'],
  ]);
  assert.ok(result.candidates.every(item => item.status === 'needs_confirmation'));
  const current = result.candidates.find(item => item.end === '2025-09-30');
  assert.ok(current?.anchors.some(anchor => anchor.kind === 'period_end' && anchor.evidence.record_id === 'visible-current' &&
    anchor.raw_period_token === '2025年1-9月'));
  assert.ok(current?.anchors.some(anchor => anchor.kind === 'table_header' && anchor.evidence.record_id === 'visible-current'));
  assert.ok(result.candidates.every(item => item.evidence.every(ref => ref.record_id !== 'hidden-half-year' &&
    ref.record_id !== 'very-hidden-annual' && ref.record_id !== 'unknown-visibility' && ref.record_id !== 'ordinary-date')));
});

test('recognizes visible XLSX year-end period headers and rejects incidental, hidden, or unknown dates', () => {
  const xlsxCell = (id: string, sheet: string, cell: string, quote: string, sheetState = 'visible') => ({
    ...nativeRecord(id, quote, `Worksheet ${sheet}`, { locator: { sheet, cell, stable_ref: `xlsx:${sheet}:${cell}` } }),
    locator_type: 'xlsx_cell' as const,
    formatting: { sheet_state: sheetState },
  });
  const result = extract([nativeSnapshot([
    xlsxCell('visible-balance-periods', '合并资产负债表', 'C2', '期间：2023年12月31日、2022年12月31日'),
    xlsxCell('visible-income-periods', '合并利润表', 'C2', '期间：2023年度、2022年度'),
    xlsxCell('incidental-date', '合并资产负债表', 'A10', '截止日期：2021年12月31日'),
    xlsxCell('hidden-periods', '合并利润表', 'C2', '期间：2021年12月31日', 'hidden'),
    xlsxCell('unknown-periods', '合并现金流量表', 'C2', '期间：2020年12月31日', 'unknown'),
    xlsxCell('non-statement-date', '附表', 'C2', '期间：2019年12月31日'),
  ])], '2023-12-31');

  assert.deepEqual(result.candidates.map(item => [item.start, item.end, item.period_kind, item.scope]), [
    ['2022-01-01', '2022-12-31', 'annual', 'consolidated'],
    ['2023-01-01', '2023-12-31', 'annual', 'consolidated'],
  ]);
  assert.ok(result.candidates.every(item => item.status === 'needs_confirmation'));
  const yearEnd = result.candidates.find(item => item.end === '2023-12-31');
  assert.ok(yearEnd?.anchors.some(anchor => anchor.kind === 'period_end' && anchor.evidence.record_id === 'visible-balance-periods' &&
    anchor.evidence.quote === '期间：2023年12月31日、2022年12月31日' && anchor.raw_period_token === '2023年12月31日'));
  assert.ok(result.candidates.every(item => item.evidence.every(ref => ![
    'incidental-date', 'hidden-periods', 'unknown-periods', 'non-statement-date',
  ].includes(ref.record_id))));
});

test('deduplicated equivalent period tokens retain per-record exact end anchors', () => {
  const equivalent = extract([nativeSnapshot([
    nativeRecord('q2-quarter-token', '2025年第二季度', '财务报表报告期 合并口径'),
    nativeRecord('q2-month-token', '2025年4-6月', '财务报表报告期 合并口径'),
    nativeRecord('q1-wrong-quarter', '2025年1-3月', '财务报表报告期 合并口径'),
  ])]);
  const candidate = equivalent.candidates.find(item => item.end === cutoff);
  assert.ok(candidate, 'equivalent exact period representations deduplicate to one period');
  assert.ok(candidate.raw_value?.includes('2025年第二季度'));
  assert.ok(candidate.raw_value?.includes('2025年4-6月'));
  assert.deepEqual(candidate.evidence.map(item => item.record_id), ['q2-month-token', 'q2-quarter-token']);
  assert.deepEqual(candidate.anchors.filter(anchor => anchor.kind === 'period_end').map(anchor => anchor.evidence.record_id).sort(),
    ['q2-month-token', 'q2-quarter-token']);
  assert.ok(candidate.anchors.filter(anchor => anchor.kind === 'period_end')
    .every(anchor => anchor.evidence.quote.includes(anchor.raw_period_token)), 'each period-end token belongs to its own evidence record');
  assert.ok(!candidate.anchors.some(anchor => anchor.kind === 'period_end' && anchor.evidence.record_id === 'q1-wrong-quarter'),
    'same-year Q1 evidence cannot anchor the deduplicated Q2 period');
  const q1 = equivalent.candidates.find(item => item.end === '2025-03-31');
  assert.ok(q1?.anchors.some(anchor => anchor.kind === 'period_end' && anchor.evidence.record_id === 'q1-wrong-quarter'));
});

test('preserves distinct consolidated and parent scopes and leaves mixed scope pending', () => {
  const result = extract([nativeSnapshot([
    nativeRecord('consolidated', '2024年度', '财务报表 合并口径'),
    nativeRecord('parent', '2024年度', '财务报表 母公司口径'),
    nativeRecord('scope-conflict', '2023年度', '财务报表 合并及母公司口径'),
  ])]);
  const sameCutoff = result.candidates.filter(item => item.end === '2024-12-31');
  assert.deepEqual(sameCutoff.map(item => item.scope).sort(), ['consolidated', 'parent']);
  const ambiguous = result.candidates.find(item => item.end === '2023-12-31');
  assert.equal(ambiguous?.scope, null);
  assert.ok(ambiguous?.pending_reasons.some(reason => /口径/.test(reason)));
});

test('reports missing subject, date, and financial header anchors without filling them from cutoff', () => {
  const missingSubject = extract([nativeSnapshot([nativeRecord('period-no-entity', '2024年度', '财务报表报告期 合并')])]);
  assert.ok(missingSubject.pending_reasons.includes('issuer_identity_not_established_by_candidate_evidence'));
  assert.ok(missingSubject.candidates[0]!.pending_reasons.includes('missing_explicit_entity_anchor'));

  const missingDate = extract([nativeSnapshot([nativeRecord('header-no-period', '财务报表合并口径', '财务会计信息')])]);
  assert.equal(missingDate.candidates.length, 0);
  assert.ok(missingDate.pending_reasons.includes('financial_period_end_anchor_missing'));
  assert.equal(missingDate.reporting_cutoff, cutoff);

  const missingHeader = extract([nativeSnapshot([nativeRecord('date-no-header', '2024年度', '附件说明', { locator: { paragraph: 3 } })])]);
  assert.equal(missingHeader.candidates.length, 0);
  assert.ok(missingHeader.pending_reasons.includes('financial_table_header_anchor_missing'));
});

test('preserves formula and OCR uncertainty and creates hash-stable order-independent proposals', () => {
  const formula = nativeSnapshot([nativeRecord('formula-period', '2025年1-6月', '财务报表报告期 合并', {
    uncertainty: ['formula_cached_result_unverified'],
  })], { status: 'needs_confirmation', warnings: [{ code: 'FORMULA_CACHE', message: '公式缓存待核' }] });
  const ocr = ocrSnapshot('合并财务报表报告期：2025年上半年', ['period_date_ocr_uncertain']);
  const first = extract([formula, ocr]);
  const second = extract([ocr, formula]);
  assert.equal(first.candidate_hash, second.candidate_hash);
  assert.ok(first.candidates.every(item => item.status === 'needs_confirmation'));
  assert.ok(first.candidates.some(item => item.evidence.some(ref => ref.uncertainty.includes('formula_cached_result_unverified'))));
  const ocrCandidate = first.candidates.find(item => item.evidence.some(ref => ref.evidence_method === 'ocr'));
  assert.ok(ocrCandidate);
  assert.ok(ocrCandidate.evidence.some(ref => ref.page === 1 && ref.page_image_sha256 === 'e'.repeat(64) &&
    ref.record_sha256 === 'f'.repeat(64)));
  assert.ok(ocrCandidate.pending_reasons.some(reason => /OCR/i.test(reason) || /ocr/i.test(reason)));
  assert.ok(first.candidates.some(item => item.pending_reasons.includes('source_contains_formula_or_ocr_uncertainty')));
  assert.ok(first.source_warnings.includes('FORMULA_CACHE:公式缓存待核'));

  const globalWarningOnly = extract([nativeSnapshot([
    nativeRecord('clean-period', '2024年度', '财务报表报告期 合并'),
  ], { status: 'needs_confirmation', warnings: [{ code: 'FORMULA_CACHE', message: '其他单元格公式缓存待核' }] })]);
  assert.ok(globalWarningOnly.candidates[0]!.status === 'needs_confirmation');
  assert.ok(!globalWarningOnly.candidates[0]!.pending_reasons.includes('source_contains_formula_or_ocr_uncertainty'));
  assert.ok(globalWarningOnly.source_warnings.includes('FORMULA_CACHE:其他单元格公式缓存待核'));
});

test('deduplicates repeated evidence and rejects snapshots outside the locked material set', () => {
  const repeated = nativeRecord('same-record', '2024年度', '财务报表报告期 合并');
  const one = extract([nativeSnapshot([repeated])]);
  const two = extract([nativeSnapshot([repeated, repeated])]);
  assert.equal(one.candidate_hash, two.candidate_hash);
  assert.equal(two.candidates[0]!.evidence.length, 1);

  const foreign = nativeSnapshot([nativeRecord('foreign', '2024年度', '财务报表报告期 合并')]);
  assert.throws(() => proposeTargetReportingPeriods({ reporting_cutoff: cutoff, locked_materials: [material],
    snapshots: [{ ...foreign, material_id: 'elsewhere' }] }), /TARGET_PERIOD_CANDIDATE_EVIDENCE_NOT_LOCKED/);

  assert.throws(() => extractWith([material, { ...material, material_version: material.material_version + 1 }], []),
    /TARGET_PERIOD_CANDIDATE_LOCK_DUPLICATE/);
  const conflictingRecord = nativeRecord('same-id-conflict', '2024年度', '财务报表报告期 合并');
  assert.throws(() => extract([nativeSnapshot([conflictingRecord, { ...conflictingRecord, literal_quote: '2025年度' }])]),
    /TARGET_PERIOD_CANDIDATE_RECORD_ID_CONFLICT/);
  assert.throws(() => extract([nativeSnapshot([repeated]), { ...nativeSnapshot([repeated]), response_sha256: 'd'.repeat(64) }]),
    /TARGET_PERIOD_CANDIDATE_SNAPSHOT_ID_CONFLICT/);
});

test('candidate hash binds exact material and parser snapshot pins even with no candidates', () => {
  const emptyOriginal = extractWith([material], []);
  const emptyOtherMaterial = extractWith([otherMaterial], []);
  assert.notEqual(emptyOriginal.candidate_hash, emptyOtherMaterial.candidate_hash);
  assert.deepEqual(emptyOriginal.locked_material_pins, [material]);
  assert.deepEqual(emptyOriginal.source_snapshot_pins, []);

  const failed = nativeSnapshot([], { status: 'failed' });
  const failedV2 = { ...failed, snapshot_id: 'parse-snapshot-2', response_sha256: 'd'.repeat(64) };
  const emptyWithFailed = extractWith([material], [failed]);
  const emptyWithDifferentFailed = extractWith([material], [failedV2]);
  assert.equal(emptyWithFailed.candidates.length, 0);
  assert.equal(emptyWithDifferentFailed.candidates.length, 0);
  assert.notEqual(emptyWithFailed.candidate_hash, emptyWithDifferentFailed.candidate_hash);
  assert.deepEqual(emptyWithFailed.source_snapshot_pins[0], {
    method: 'native_text', snapshot_id: failed.snapshot_id, material_id: material.material_id,
    material_version: material.material_version, material_sha256: material.material_sha256,
    response_sha256: failed.response_sha256, parser_version: failed.parser_version,
    status: 'failed', evidence_records: [],
  });
});

test('candidate hash binds different parse snapshots that yield the same period values', () => {
  const periodRecord = nativeRecord('same-values', '2024年度', '财务报表报告期 合并');
  const original = nativeSnapshot([periodRecord]);
  const updatedSnapshot = { ...original, snapshot_id: 'parse-snapshot-2', response_sha256: 'd'.repeat(64) };
  const first = extract([original]);
  const second = extract([updatedSnapshot]);
  assert.deepEqual(first.candidates.map(item => [item.start, item.end, item.period_kind, item.scope]),
    second.candidates.map(item => [item.start, item.end, item.period_kind, item.scope]));
  assert.notEqual(first.candidate_hash, second.candidate_hash);
  assert.equal(second.source_snapshot_pins[0]!.snapshot_id, 'parse-snapshot-2');
});
