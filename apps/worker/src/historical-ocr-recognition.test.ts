import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OcrReview } from '@bondbuddy/contracts';
import { recognizeHistoricalOcr } from './historical-ocr-recognition.js';

function review(records: Array<{ id: string; page: number; text: string }>, overrides: Partial<OcrReview> = {}): OcrReview {
  return {
    snapshot_id: 'ocr-snapshot-synthetic', result_sha256: 'a'.repeat(64), material_id: 'historical-synthetic',
    material_version: 3, purpose: 'source_preflight', coverage: 'partial', page_count: 10,
    pages: [], records: records.map(record => ({ record_id: record.id, page: record.page, bbox: [0, 0, 10, 10],
      text: record.text, confidence: 0.99, numeric: { kind: 'unparsed', decimal: null, unit: null }, cell: null,
      uncertainty: ['synthetic OCR uncertainty'], eligible_for_manuscript: false })), corrections: [], warnings: [],
    eligible_for_manuscript: false, ...overrides,
  } as OcrReview;
}

test('corroborated OCR hints retain exact snapshot, result hash and record anchors but never become ready', () => {
  const input = review([
    { id: 'venue-1', page: 1, text: '本期债券发行场所：上海证券交易所。' },
    { id: 'venue-2', page: 2, text: '本期债券在上海证券交易所发行。' },
    { id: 'offering-1', page: 1, text: '本期债券采取非公开发行方式。' },
    { id: 'offering-2', page: 3, text: '本次债券为非公开发行。' },
    { id: 'period-1', page: 4, text: '财务会计信息 2024 年度 合并财务报表。' },
  ]);
  const result = recognizeHistoricalOcr(input, { profileVersion: 2 });
  assert.equal(result.state, 'needs_confirmation');
  assert.equal(result.source_market.value, 'sse');
  assert.equal(result.source_market.status, 'needs_confirmation');
  assert.equal(result.source_market.provenance.method, 'ocr');
  assert.equal(result.source_market.provenance.extractor_version,
    `historical-ocr-recognition-v2:${input.snapshot_id}:${input.result_sha256}`);
  assert.deepEqual(result.source_market.provenance.evidence_refs, ['venue-1', 'venue-2']);
  assert.equal(result.source_offering.value, 'private');
  assert.equal(result.source_offering.status, 'needs_confirmation');
  assert.equal(result.reporting_periods[0]?.end, '2024-12-31');
  assert.equal(result.reporting_periods[0]?.status, 'needs_confirmation');
  assert.match(result.source_market.uncertainty.join(' '), /部分页面/);
});

test('#11 OCR DFI coverage uses the same classifier and retains its uncertainty and source pages', () => {
  const result = recognizeHistoricalOcr(review([
    { id: 'market-a', page: 1, text: '本期债券发行场所：中国银行间市场交易商协会。' },
    { id: 'market-b', page: 2, text: '本期债券在中国银行间市场交易商协会发行。' },
    { id: 'dfi-a', page: 1, text: '本次DFI统一注册文件覆盖MTN、CP及SCP。' },
    { id: 'dfi-b', page: 3, text: '本次储架发行统一注册，拟发行工具包括SCP。' },
  ]), { profileVersion: 1 });
  assert.equal(result.source_offering.value, 'dfi');
  assert.equal(result.source_offering.status, 'needs_confirmation');
  assert.deepEqual(result.source_offering.provenance.evidence_refs, ['dfi-a', 'dfi-b']);
});

test('single OCR mention, bare public issue and financial dates without financial context remain unresolved', () => {
  const result = recognizeHistoricalOcr(review([
    { id: 'venue-single', page: 1, text: '本期债券发行场所：深圳证券交易所。' },
    { id: 'public-a', page: 2, text: '本期公司债券采取公开发行方式。' },
    { id: 'public-b', page: 3, text: '本期公开发行公司债券。' },
    { id: 'date-only', page: 4, text: '2024 年度签署日。' },
  ], { coverage: 'complete' }), { profileVersion: 1 });
  assert.equal(result.state, 'needs_confirmation');
  assert.equal(result.source_market.value, null);
  assert.equal(result.source_offering.value, null);
  assert.equal(result.reporting_periods.length, 0);
  assert.equal(result.latest_reporting_cutoff.value, null);
});

test('half-year and January to June labels never create a phantom annual December cutoff', () => {
  const result = recognizeHistoricalOcr(review([
    { id: 'half-year', page: 1, text: '2025年半年度 合并资产负债表' },
    { id: 'six-months', page: 2, text: '2025年1-6月 合并利润表' },
  ]), { profileVersion: 1 });
  assert.deepEqual(result.reporting_periods.map(period => [period.start, period.end, period.period_kind]), [
    ['2025-01-01', '2025-06-30', 'interim'],
  ]);
  assert.equal(result.latest_reporting_cutoff.value, '2025-06-30');
});

test('bare annual years in the report-period list plus an explicit first quarter keep the quarter as latest', () => {
  const input = review([
    { id: 'period-history', page: 4, text: '报告期：2022年、2023年、2024年及2025年一季度 合并财务报表' },
  ], { coverage: 'complete' });
  const result = recognizeHistoricalOcr(input, { profileVersion: 1 });
  assert.deepEqual(result.reporting_periods.map(period => [period.start, period.end, period.period_kind]), [
    ['2022-01-01', '2022-12-31', 'annual'],
    ['2023-01-01', '2023-12-31', 'annual'],
    ['2024-01-01', '2024-12-31', 'annual'],
    ['2025-01-01', '2025-03-31', 'interim'],
  ]);
  assert.equal(result.latest_reporting_cutoff.value, '2025-03-31');
  assert.deepEqual(result.reporting_periods[3]?.provenance.evidence_refs, ['period-history']);
  assert.equal(result.reporting_periods[3]?.provenance.material_id, input.material_id);
  assert.equal(result.reporting_periods[3]?.provenance.material_version, input.material_version);
  assert.equal(result.reporting_periods[3]?.status, 'needs_confirmation');
});

test('bare years in an explicitly labeled report-period list are annual, while adjacent signing and issuance dates are excluded', () => {
  const result = recognizeHistoricalOcr(review([
    { id: 'bare-period-list', page: 4, text: '报告期：2022年、2023年及2024年，签署日期2025年，发行日期2026年。合并财务报表' },
  ]), { profileVersion: 1 });
  assert.deepEqual(result.reporting_periods.map(period => [period.start, period.end, period.period_kind]), [
    ['2022-01-01', '2022-12-31', 'annual'],
    ['2023-01-01', '2023-12-31', 'annual'],
    ['2024-01-01', '2024-12-31', 'annual'],
  ]);
  assert.equal(result.latest_reporting_cutoff.value, '2024-12-31');
});

test('a standalone quarter is interim and never creates an annual cutoff', () => {
  const result = recognizeHistoricalOcr(review([
    { id: 'quarter-only', page: 2, text: '报告期：2025年第一季度合并资产负债表' },
  ]), { profileVersion: 1 });
  assert.deepEqual(result.reporting_periods.map(period => [period.start, period.end, period.period_kind]), [
    ['2025-01-01', '2025-03-31', 'interim'],
  ]);
  assert.equal(result.latest_reporting_cutoff.value, '2025-03-31');
});

test('explicit first through fourth quarter labels map to calendar-quarter boundaries', () => {
  const result = recognizeHistoricalOcr(review([
    { id: 'quarters', page: 5, text: '财务数据：2025年一季度、2025年第二季度、2025年第3季度、2025年4季度' },
  ]), { profileVersion: 1 });
  assert.deepEqual(result.reporting_periods.map(period => [period.start, period.end, period.period_kind]), [
    ['2025-01-01', '2025-03-31', 'interim'],
    ['2025-04-01', '2025-06-30', 'interim'],
    ['2025-07-01', '2025-09-30', 'interim'],
    ['2025-10-01', '2025-12-31', 'interim'],
  ]);
});

test('explicit annual and first-quarter evidence for one year are both retained', () => {
  const result = recognizeHistoricalOcr(review([
    { id: 'annual-and-quarter', page: 6, text: '报告期：2025年度及2025年一季度财务报表（合并口径）' },
  ]), { profileVersion: 1 });
  assert.deepEqual(result.reporting_periods.map(period => [period.start, period.end, period.period_kind]), [
    ['2025-01-01', '2025-03-31', 'interim'],
    ['2025-01-01', '2025-12-31', 'annual'],
  ]);
});

test('cover signing and issuance years, filenames and legal citations are not reporting periods', () => {
  const result = recognizeHistoricalOcr(review([
    { id: 'cover', page: 1, text: '封面：签署日期2025年6月，发行日期2025年7月' },
    { id: 'filename', page: 0, text: '2025年度合并财务报表.pdf' },
    { id: 'regulation', page: 7, text: '依据《财务报表编制办法》2025年修订通知，适用本办法。' },
  ], { coverage: 'complete' }), { profileVersion: 1 });
  assert.deepEqual(result.reporting_periods, []);
  assert.equal(result.latest_reporting_cutoff.value, null);
  assert.equal(result.latest_reporting_cutoff.status, 'needs_confirmation');
});

test('OCR user corrections remain separate review evidence and are not used to infer profile values', () => {
  const input = review([{ id: 'ambiguous', page: 1, text: '本期债券发行方式为公募。' }], {
    corrections: [{ correction_id: 'correction-1', record_id: 'ambiguous', revision: 2, original_text: '公墓',
      corrected_text: '小公募', reason: 'synthetic correction', period: null, scope: null, unit: null,
      actor_user_id: 'owner-synthetic', created_at: '2026-09-25T00:00:00Z', status: 'user_asserted',
      eligible_for_manuscript: false }],
  });
  const result = recognizeHistoricalOcr(input, { profileVersion: 1 });
  assert.equal(result.source_offering.value, null);
  assert.equal(result.source_offering.status, 'needs_confirmation');
});
