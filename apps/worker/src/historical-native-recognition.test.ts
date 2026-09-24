import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DocumentParseRecord, DocumentParseResponse } from './document-parser.js';
import { recognizeHistoricalNativeText } from './historical-native-recognition.js';

const material = { material_id: 'historical-synthetic', material_version: 3, media_type: 'text/plain' as const, sha256: 'a'.repeat(64) };

function record(id: string, quote: string, context = '', locator: Record<string, unknown> = { paragraph: id }): DocumentParseRecord {
  return {
    record_id: id,
    material_id: material.material_id,
    material_version: material.material_version,
    content_hash: material.sha256,
    locator_type: 'text_line',
    locator,
    literal_quote: quote,
    context,
    extraction_method: 'native_text',
    extractor_version: 'synthetic-native-1',
    confidence: 1,
    uncertainty: [],
    formatting: {},
  };
}

function response(records: DocumentParseRecord[], status: DocumentParseResponse['status'] = 'parsed'): DocumentParseResponse {
  return {
    schema_version: 'document-parse-response-v1',
    request_id: 'parse-synthetic',
    parser_version: 'synthetic-parser-1',
    status,
    material,
    records,
    warnings: status === 'needs_confirmation' ? [{ code: 'PDF_IMAGES_NOT_OCRD', message: '合成扫描页未作OCR' }] : [],
    document: { page_count: null },
    error: status === 'failed' ? { code: 'MATERIAL_UNREADABLE', message: 'synthetic failure' } : null,
  };
}

function marketRecords(market: 'sse' | 'szse' | 'nafmii'): DocumentParseRecord[] {
  const venue = market === 'sse' ? '上海证券交易所' : market === 'szse' ? '深圳证券交易所' : '中国银行间市场交易商协会';
  return [
    record('venue-a', `本期债券发行场所：${venue}。`, '募集说明书封面'),
    record('venue-b', `本期债券在${venue}发行。`, '本次发行概况'),
  ];
}

function offeringRecords(market: 'sse' | 'szse' | 'nafmii', offering: 'private' | 'public' | 'public_all' | 'ppn' | 'mtn' | 'cp' | 'scp' | 'dfi'): DocumentParseRecord[] {
  const phrases: Record<typeof offering, string> = {
    private: '本期债券采取非公开发行方式。',
    public: '本期债券为小公募，仅面向专业投资者公开发行。',
    public_all: '本期债券为大公募，向公众投资者公开发行。',
    ppn: '本期债券为定向债务融资工具（PPN）。',
    mtn: '本期债券为中期票据（MTN）。',
    cp: '本期债券为短期融资券（CP）。',
    scp: '本期债券为超短期融资券（SCP）。',
    dfi: '本期发行文件为DFI储架发行统一注册文件。',
  };
  const phrase = phrases[offering];
  const second: Record<typeof offering, string> = {
    private: '发行对象为专业投资者，本期债券采用私募发行。',
    public: '本期公司债券仅向专业投资者公开发行。',
    public_all: '本期债券按面向公众投资者公开发行方式发行。',
    ppn: '本期债券发行品种为PPN定向工具。',
    mtn: '本期发行工具为MTN中期票据。',
    cp: '本次债券品种为CP短期融资券。',
    scp: '本次发行工具为SCP超短期融资券。',
    dfi: '本次债券按DFI储架发行方式统一注册。',
  };
  // Distinct wording/positions represent independent corroboration, not duplicate records.
  return [record(`offering-${market}-a`, phrase, '募集说明书封面'),
    record(`offering-${market}-b`, second[offering], '本次发行概况')];
}

test('recognizes the three original markets only from two explicit issuance venue records', () => {
  for (const market of ['sse', 'szse', 'nafmii'] as const) {
    const value = recognizeHistoricalNativeText(response(marketRecords(market)), { profileVersion: 7 });
    assert.equal(value.source_market.value, market);
    assert.equal(value.source_market.status, 'recognized');
    assert.equal(value.source_market.provenance.evidence_refs.length, 2);
    assert.equal(value.profile_version, 7);
  }
});

test('recognizes all exchange offerings and all association instruments with corroboration', () => {
  const combinations = [
    ['sse', 'private'], ['szse', 'public'], ['sse', 'public_all'],
    ['nafmii', 'ppn'], ['nafmii', 'mtn'], ['nafmii', 'cp'], ['nafmii', 'scp'], ['nafmii', 'dfi'],
  ] as const;
  for (const [market, offering] of combinations) {
    const value = recognizeHistoricalNativeText(response([
      ...marketRecords(market), ...offeringRecords(market, offering),
    ]), { profileVersion: 2 });
    assert.equal(value.source_market.value, market);
    assert.equal(value.source_offering.value, offering);
    assert.equal(value.source_offering.status, 'recognized');
    assert.equal(value.source_offering.provenance.evidence_refs.length, 2);
  }
});

test('keeps plain public offering ambiguous and preserves its exact evidence', () => {
  const value = recognizeHistoricalNativeText(response([
    ...marketRecords('sse'), record('public-a', '本期公司债券采取公开发行方式。'), record('public-b', '本期公开发行公司债券。'),
  ]), { profileVersion: 1 });
  assert.equal(value.source_offering.value, null);
  assert.equal(value.source_offering.status, 'needs_confirmation');
  assert.match(value.source_offering.raw_value ?? '', /公开发行/);
  assert.deepEqual(value.source_offering.provenance.evidence_refs, ['public-a', 'public-b']);
});

test('a single contradictory venue record blocks an otherwise corroborated market', () => {
  const value = recognizeHistoricalNativeText(response([
    record('sh-a', '本期债券发行场所：上海证券交易所。'),
    record('sh-b', '本期债券在上海证券交易所发行。'),
    record('sz-conflict', '本期债券拟在深圳证券交易所发行。'),
  ]), { profileVersion: 1 });
  assert.equal(value.source_market.value, null);
  assert.equal(value.source_market.status, 'needs_confirmation');
  assert.match(value.source_market.uncertainty.join(' '), /冲突/);
});

test('duplicate copies of one offering sentence do not count as corroborating evidence', () => {
  const sentence = '本期债券采取非公开发行方式。';
  const value = recognizeHistoricalNativeText(response([
    ...marketRecords('sse'), record('private-copy-a', sentence), record('private-copy-b', sentence),
  ]), { profileVersion: 1 });
  assert.equal(value.source_offering.value, null);
  assert.equal(value.source_offering.status, 'needs_confirmation');
  assert.match(value.source_offering.raw_value ?? '', /非公开发行/);
});

test('two paraphrases in one section do not count as cross-section corroboration', () => {
  const sameSection = marketRecords('sse').map((item) => ({ ...item, context: '本次发行概况' }));
  const value = recognizeHistoricalNativeText(response(sameSection), { profileVersion: 1 });
  assert.equal(value.source_market.value, null);
  assert.equal(value.source_market.status, 'needs_confirmation');
  assert.match(value.source_market.uncertainty.join(' '), /不同位置或章节/);
});

test('does not turn an incidental DFI citation into the instrument for an MTN issuance', () => {
  const value = recognizeHistoricalNativeText(response([
    ...marketRecords('nafmii'),
    record('mtn-a', '本期债券名称：中期票据（MTN）。', '募集说明书封面'),
    record('mtn-b', '本期发行品种为中期票据。', '本次发行概况'),
    record('dfi-citation', '根据《中国银行间市场交易商协会DFI储架发行通知》，本期债券履行相关程序。'),
  ]), { profileVersion: 1 });
  assert.equal(value.source_offering.value, 'mtn');
  assert.equal(value.source_offering.status, 'needs_confirmation');
  assert.match(value.source_offering.raw_value ?? '', /DFI储架发行通知/);
  assert.match(value.source_offering.uncertainty.join(' '), /不能据此判定/);
});

test('extracts three annual periods and 2025 Q1 from financial period text, not a cover issue date', () => {
  const value = recognizeHistoricalNativeText(response([
    ...marketRecords('sse'), ...offeringRecords('sse', 'private'),
    record('period-history', '合并财务报表报告期：2022年度、2023年度、2024年度。', '财务会计信息'),
    record('period-q1', '最近一期合并财务报表报告期：2025年第一季度。', '财务会计信息'),
    record('cover-issue-date', '发行日期：2025年3月31日。', '财务会计信息'),
  ]), { profileVersion: 4 });
  assert.deepEqual(value.reporting_periods.map(period => period.end), ['2022-12-31', '2023-12-31', '2024-12-31', '2025-03-31']);
  assert.equal(value.reporting_periods[3]?.period_kind, 'interim');
  assert.equal(value.latest_reporting_cutoff.value, '2025-03-31');
  assert.ok(value.latest_reporting_cutoff.provenance.evidence_refs.includes('period-q1'));
  assert.ok(!value.latest_reporting_cutoff.provenance.evidence_refs.includes('period-history'));
  assert.ok(!value.latest_reporting_cutoff.provenance.evidence_refs.includes('cover-issue-date'));
});

test('recognizes common Q1 month ranges and three-month cutoff wording', () => {
  for (const quote of ['合并财务报表报告期：2025年1-3月。', '合并财务报表报告期：2025年1—3月。', '合并财务报表列示截至2025年3月31日的三个月。']) {
    const value = recognizeHistoricalNativeText(response([record(`period-${quote.length}`, quote, '财务会计信息')]), { profileVersion: 1 });
    assert.equal(value.reporting_periods.length, 1, quote);
    assert.equal(value.reporting_periods[0]?.start, '2025-01-01', quote);
    assert.equal(value.reporting_periods[0]?.end, '2025-03-31', quote);
    assert.equal(value.reporting_periods[0]?.period_kind, 'interim', quote);
  }
});

test('a year in financial-section context without a reporting-period/table anchor is ignored', () => {
  const value = recognizeHistoricalNativeText(response([
    record('cover-year', '发行日期为2025年3月31日。', '财务报表'),
  ]), { profileVersion: 1 });
  assert.equal(value.reporting_periods.length, 0);
  assert.equal(value.latest_reporting_cutoff.value, null);
});

test('a single period record mixing consolidated and parent scopes stays unconfirmed', () => {
  const value = recognizeHistoricalNativeText(response([
    record('mixed-scope', '合并及母公司财务报表报告期：2024年度。', '财务会计信息'),
  ]), { profileVersion: 1 });
  assert.equal(value.reporting_periods.length, 1);
  assert.equal(value.reporting_periods[0]?.scope, null);
  assert.equal(value.reporting_periods[0]?.status, 'needs_confirmation');
  assert.match(value.reporting_periods[0]?.uncertainty.join(' ') ?? '', /口径/);
});

test('uses a financial table heading and its trusted table locator for bare annual column headers', () => {
  const value = recognizeHistoricalNativeText(response([
    record('table-year', '2022年', '合并资产负债表', { path: [{ table: 1, row: 1, column: 2 }] }),
  ]), { profileVersion: 1 });
  assert.equal(value.reporting_periods[0]?.start, '2022-01-01');
  assert.equal(value.reporting_periods[0]?.end, '2022-12-31');
  assert.equal(value.reporting_periods[0]?.scope, 'consolidated');
  assert.equal(value.reporting_periods[0]?.status, 'recognized');
});

test('parser uncertainty and failure remain explicit states', () => {
  const uncertain = recognizeHistoricalNativeText(response([
    ...marketRecords('szse'), ...offeringRecords('szse', 'private'),
  ], 'needs_confirmation'), { profileVersion: 1 });
  assert.equal(uncertain.state, 'needs_confirmation');
  assert.equal(uncertain.source_market.status, 'needs_confirmation');
  assert.match(uncertain.source_market.uncertainty.join(' '), /OCR/);

  const failed = recognizeHistoricalNativeText(response([], 'failed'), { profileVersion: 1 });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.source_market.status, 'unknown');
  assert.match(failed.source_market.uncertainty.join(' '), /解析失败/);
});

test('requires an explicit valid profile version', () => {
  assert.throws(() => recognizeHistoricalNativeText(response([]), { profileVersion: 0 }), /INVALID_PROFILE_VERSION/);
});
