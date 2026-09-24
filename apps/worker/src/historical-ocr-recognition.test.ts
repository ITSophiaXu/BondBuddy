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
    `historical-ocr-recognition-v1:${input.snapshot_id}:${input.result_sha256}`);
  assert.deepEqual(result.source_market.provenance.evidence_refs, ['venue-1', 'venue-2']);
  assert.equal(result.source_offering.value, 'private');
  assert.equal(result.source_offering.status, 'needs_confirmation');
  assert.equal(result.reporting_periods[0]?.end, '2024-12-31');
  assert.equal(result.reporting_periods[0]?.status, 'needs_confirmation');
  assert.match(result.source_market.uncertainty.join(' '), /部分页面/);
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
