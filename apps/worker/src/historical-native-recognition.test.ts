import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { DocumentParseRecord, DocumentParseResponse } from './document-parser.js';
import { runDocumentParser } from './document-parser.js';
import { parseAuthorizedMaterial } from './material-parser.js';
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

test('#11 DFI coverage lists do not become a tranche, while contradictory document claims stay pending', () => {
  const base = [ ...marketRecords('nafmii'),
    record('dfi-cover', '本次DFI统一注册文件覆盖MTN、CP及SCP。', '募集说明书封面'),
    record('dfi-arrangement', '本次储架发行统一注册，拟发行工具包括SCP。', '本次发行概况') ];
  const result = recognizeHistoricalNativeText(response(base), { profileVersion: 1 });
  assert.equal(result.source_offering.value, 'dfi');
  assert.deepEqual(result.source_offering.provenance.evidence_refs, ['dfi-cover', 'dfi-arrangement']);
  const conflict = recognizeHistoricalNativeText(response([...base,
    record('conflict', '本期债券为MTN中期票据。', '本期条款')]), { profileVersion: 2 });
  assert.equal(conflict.source_offering.value, null);
  assert.equal(conflict.source_offering.status, 'needs_confirmation');
  assert.ok(conflict.source_offering.provenance.evidence_refs.includes('conflict'));
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

test('recognizes explicit half-year labels from financial section evidence and deduplicates equivalent ranges', () => {
  const value = recognizeHistoricalNativeText(response([
    record('half-year-label', '2025年半年度', '合并财务报表'),
    record('first-half-label', '2025年上半年', '合并财务报表'),
    record('half-year-range', '报告期：2025年1-6月', '合并财务报表'),
  ]), { profileVersion: 1 });

  assert.equal(value.reporting_periods.length, 1);
  assert.deepEqual(value.reporting_periods[0], {
    start: '2025-01-01', end: '2025-06-30', period_kind: 'interim', scope: 'consolidated',
    raw_value: '2025年半年度；2025年上半年；2025年1-6月',
    provenance: {
      material_id: material.material_id, material_version: material.material_version, method: 'native_text',
      extractor_version: 'historical-native-recognition-v3/synthetic-native-1',
      evidence_refs: ['half-year-label', 'first-half-label', 'half-year-range'],
    },
    uncertainty: [], status: 'recognized',
  });
  assert.equal(value.latest_reporting_cutoff.value, '2025-06-30');
  assert.deepEqual(value.latest_reporting_cutoff.provenance.evidence_refs,
    ['half-year-label', 'first-half-label', 'half-year-range']);
});

test('a half-year label does not hide a separate annual period for the same year', () => {
  const value = recognizeHistoricalNativeText(response([
    record('mixed-periods', '报告期：2025年半年度、2025年一季度、2025年度', '合并财务报表'),
  ]), { profileVersion: 1 });
  assert.deepEqual(value.reporting_periods.map(period => period.end), ['2025-03-31', '2025-06-30', '2025-12-31']);
  assert.equal(value.latest_reporting_cutoff.value, '2025-12-31');
});

test('does not treat cover and signing or issuance dates, or nonfinancial half-year references, as reporting periods', () => {
  const value = recognizeHistoricalNativeText(response([
    record('cover-issue-date', '发行日期：2025年6月30日。', '财务会计信息'),
    record('signing-date', '签署日期：2025年6月30日。', '财务会计信息'),
    record('cover-label', '2025年上半年', '募集说明书封面'),
    record('nonfinancial-reference', '2025年半年度', '发行人历史沿革'),
  ]), { profileVersion: 1 });

  assert.deepEqual(value.reporting_periods, []);
  assert.equal(value.latest_reporting_cutoff.value, null);
  assert.deepEqual(value.latest_reporting_cutoff.provenance.evidence_refs, []);
});

type AuthorizedManifest = {
  cases: Array<{
    case_id: string;
    market: string;
    offering: string;
    source_reporting_periods: string[];
    files: Array<{ path: string; upload_role: string; media_type: string; sha256: string; bytes: number }>;
  }>;
};

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const localPython = join(sourceRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const sampleParserPython = process.env.BB_PYTHON?.trim() || (existsSync(localPython)
  ? localPython
  : process.platform === 'win32' ? 'python' : 'python3');

function expectedPeriodKeys(periods: string[]): string[] {
  return periods.map((period) => {
    const annual = /^(20\d{2})$/.exec(period);
    if (annual) return `${annual[1]}-01-01/${annual[1]}-12-31`;
    const interim = /^(20\d{2})-(\d{2})\/(20\d{2})-(\d{2})$/.exec(period);
    assert.ok(interim, 'manifest period must use a supported year or month-range form');
    const year = Number(interim[3]);
    const month = Number(interim[4]);
    const endDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${interim[1]}-${interim[2]}-01/${interim[3]}-${interim[4]}-${String(endDay).padStart(2, '0')}`;
  }).sort();
}

// Opt in with BB_RUN_AUTHORIZED_SAMPLE_TESTS=1; set BB_PYTHON to a Python
// interpreter with python/requirements.txt installed when no worktree .venv exists.
test('recognizes the four authorized historical DOCX files through the Python bridge', {
  skip: process.env.BB_RUN_AUTHORIZED_SAMPLE_TESTS === '1' ? false : 'set BB_RUN_AUTHORIZED_SAMPLE_TESTS=1 to run the real-material bridge check',
}, async () => {
  const manifestPath = join(sourceRoot, 'tests/samples/2026-09-25/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AuthorizedManifest;
  const historical = manifest.cases.flatMap((sample) => sample.files
    .filter((file) => file.upload_role === 'historical')
    .map((file) => ({ sample, file })));
  assert.equal(historical.length, 4);

  for (const [index, { sample, file }] of historical.entries()) {
    const bytes = await readFile(join(sourceRoot, 'tests/samples/2026-09-25', file.path));
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    assert.equal(bytes.byteLength, file.bytes, `${sample.case_id}: manifest byte size mismatch`);
    assert.equal(actualHash, file.sha256, `${sample.case_id}: manifest hash mismatch`);

    const materialId = `authorized-historical-${index + 1}`;
    const ownerUserId = 'sample-validation-owner';
    const projectId = `sample-validation-${sample.case_id}`;
    const row = {
      owner_user_id: ownerUserId,
      project_id: projectId,
      id: materialId,
      version: 1,
      media_type: file.media_type,
      byte_size: bytes.byteLength,
      sha256: actualHash,
      object_key: `authorized-sample/${sample.case_id}/${materialId}`,
      role: 'historical',
    };
    const parsed = await parseAuthorizedMaterial({
      pool: { query: async () => ({ rows: [row] }) },
      blobs: { getPrivate: async () => bytes },
      parser: (request) => runDocumentParser(request, {
        pythonExecutable: sampleParserPython,
        repoRoot: sourceRoot,
      }),
    }, {
      ownerUserId,
      projectId,
      materialId,
      version: 1,
      requestId: `sample-parse-${index + 1}`,
      requiredRole: 'historical',
    });
    assert.notEqual(parsed.status, 'failed', `${sample.case_id}: parser failed`);
    const recognition = recognizeHistoricalNativeText(parsed, { profileVersion: 1 });
    const actualPeriodKeys = [...new Set(recognition.reporting_periods
      .filter((period) => period.start !== null && period.end !== null)
      .map((period) => `${period.start}/${period.end}`))].sort();
    const expectedPeriods = expectedPeriodKeys(sample.source_reporting_periods);
    const unexpectedPeriods = actualPeriodKeys.filter((period) => !expectedPeriods.includes(period));

    // The manifest is independent comparison evidence only. Recognition receives
    // solely the version/hash-bound result returned by the parser bridge.
    assert.equal(recognition.source_market.value, sample.market, `${sample.case_id}: source market mismatch`);
    assert.equal(recognition.source_offering.value, sample.offering, `${sample.case_id}: source offering mismatch`);
    assert.ok(recognition.source_market.provenance.evidence_refs.length >= 2,
      `${sample.case_id}: market requires independent anchored evidence`);
    assert.ok(recognition.source_offering.provenance.evidence_refs.length >= 2,
      `${sample.case_id}: offering requires independent anchored evidence`);
    for (const expectedPeriod of expectedPeriods) {
      assert.ok(actualPeriodKeys.includes(expectedPeriod), `${sample.case_id}: missing expected source period`);
    }
    for (const unexpectedPeriod of unexpectedPeriods) {
      const candidates = recognition.reporting_periods.filter((period) =>
        period.start !== null && period.end !== null && `${period.start}/${period.end}` === unexpectedPeriod);
      assert.ok(candidates.length > 0 && candidates.every((period) => period.status === 'needs_confirmation'),
        `${sample.case_id}: unsupported extra period must remain unconfirmed`);
    }
    const expectedLatestCutoff = sample.source_reporting_periods.reduce((latest, period) => {
      const key = expectedPeriodKeys([period])[0]!;
      return key.slice(key.indexOf('/') + 1) > latest ? key.slice(key.indexOf('/') + 1) : latest;
    }, '0000-00-00');
    const hasUnconfirmedPeriod = recognition.reporting_periods.some((period) => period.status !== 'recognized');
    assert.equal(recognition.latest_reporting_cutoff.value, hasUnconfirmedPeriod ? null : expectedLatestCutoff,
      `${sample.case_id}: latest cutoff must match or remain unconfirmed with ambiguous periods`);
    if (parsed.status === 'needs_confirmation') {
      assert.equal(recognition.state, 'needs_confirmation', `${sample.case_id}: incomplete parser result must not produce a ready profile`);
      assert.equal(recognition.source_market.status, 'needs_confirmation', `${sample.case_id}: parser uncertainty must propagate`);
      assert.equal(recognition.source_offering.status, 'needs_confirmation', `${sample.case_id}: parser uncertainty must propagate`);
    } else {
      assert.equal(recognition.source_market.status, 'recognized', `${sample.case_id}: source market needs confirmation`);
      assert.equal(recognition.source_offering.status, 'recognized', `${sample.case_id}: source offering needs confirmation`);
    }
  }
});

test('keeps an anchored half-year label awaiting confirmation when its statement scope is unknown', () => {
  const value = recognizeHistoricalNativeText(response([
    record('half-year-unknown-scope', '2025年半年度', '财务会计信息'),
  ]), { profileVersion: 1 });

  assert.equal(value.reporting_periods.length, 1);
  assert.equal(value.reporting_periods[0]?.start, '2025-01-01');
  assert.equal(value.reporting_periods[0]?.end, '2025-06-30');
  assert.equal(value.reporting_periods[0]?.status, 'needs_confirmation');
  assert.equal(value.latest_reporting_cutoff.value, null);
});

test('a year in financial-section context without a reporting-period/table anchor is ignored', () => {
  const value = recognizeHistoricalNativeText(response([
    record('cover-year', '发行日期为2025年3月31日。', '财务报表'),
  ]), { profileVersion: 1 });
  assert.equal(value.reporting_periods.length, 0);
  assert.equal(value.latest_reporting_cutoff.value, null);
});

test('financial-context period opt-in is PDF-only; historical recognition keeps the legacy boundary', () => {
  const annual = record('bare-annual', '2024年度', '财务报表');
  const ordinary = response([annual]);
  assert.deepEqual(recognizeHistoricalNativeText(ordinary, { profileVersion: 1 }).reporting_periods, []);
  assert.deepEqual(recognizeHistoricalNativeText(ordinary, {
    profileVersion: 1, allowPdfFinancialContextPeriods: true,
  }).reporting_periods, []);

  const pdf = {
    ...ordinary,
    material: { ...ordinary.material!, media_type: 'application/pdf' as const },
  };
  const targetOnly = recognizeHistoricalNativeText(pdf, {
    profileVersion: 1, allowPdfFinancialContextPeriods: true,
  });
  assert.equal(targetOnly.reporting_periods.length, 1);
  assert.equal(targetOnly.reporting_periods[0]?.end, '2024-12-31');
  assert.equal(targetOnly.reporting_periods[0]?.status, 'needs_confirmation');
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
