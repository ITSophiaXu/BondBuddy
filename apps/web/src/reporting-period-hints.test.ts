import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SourceProspectus } from '@bondbuddy/contracts';
import { financialFilenameCutoff, materialPeriodHint, periodLabel, reportingPeriodHints, renderPeriodHint, sourcePeriodHint } from './reporting-period-hints.js';

const material = { material_id: 'synthetic-source', material_version: 2, sha256: 'a'.repeat(64), filename: '合成原稿.docx', role: 'historical' as const };
const source: SourceProspectus = { ...material, issuer_name: null, relation: 'same_issuer', market: 'nafmii', offering: 'ppn', status: 'user_asserted',
  reporting_periods: [{ start: '2026-01-01', end: '2026-06-30', period_kind: 'interim', scope: null, status: 'needs_confirmation', evidence_refs: [] }] };
const cases: [string, string | undefined][] = [
  ['合成2026年半年度财务报表.pdf', '2026-06-30'],
  ['2026年上半年合并报表.xlsx', '2026-06-30'],
  ['2026年1—6月财务报表及附注.pdf', '2026-06-30'],
  ['２０２６ 年半年度财务报表.pdf', '2026-06-30'],
  ['2026年中期财务报告.pdf', '2026-06-30'],
  ['2026年6月末财务报表.pdf', '2026-06-30'],
  ['2026年第一季度财务报表.pdf', '2026-03-31'],
  ['2026年前三季度财务报告.pdf', '2026-09-30'],
  ['2026年1至9月财务报表.pdf', '2026-09-30'],
  ['2026年度审计报告.pdf', '2026-12-31'],
  ['2026年末财务报表.pdf', '2026-12-31'],
  ['2026-10-12下载_2025年度审计报告.pdf', '2025-12-31'],
  ['2026财务报表.pdf', undefined],
  ['2026-10-12_财务资料.pdf', undefined],
  ['2026年半年度募集说明书.docx', undefined],
  ['财务报表.pdf', undefined],
  ['2026年半年度及2025年度财务报表.pdf', undefined],
];

test('only explicit and unambiguous financial filename periods produce a tentative cutoff', () => {
  for (const [filename, expected] of cases) assert.equal(financialFilenameCutoff(filename), expected, filename);
});

test('source comparison uses its latest end and exact material version/hash without mutating declarations', () => {
  const sources = [structuredClone(source)];
  const before = structuredClone(sources);
  sources[0].reporting_periods.unshift({ ...source.reporting_periods[0], end: '2025-12-31' });
  const expected = structuredClone(sources);
  assert.match(sourcePeriodHint(material, sources, '2025-12-31')!.text, /2026年6月末.*2025年末.*填反/);
  assert.deepEqual(sources, expected);
  for (const mismatch of [{ material_version: 3 }, { sha256: 'b'.repeat(64) }, { material_id: 'another' }]) {
    assert.equal(sourcePeriodHint({ ...material, ...mismatch }, before, '2025-12-31'), undefined);
  }
});

test('same/older source, missing declaration and invalid/unknown target never warn', () => {
  for (const target of ['2026-06-30', '2026-12-31', '2026-02-30', 'invalid', '', null]) {
    assert.equal(sourcePeriodHint(material, [source], target), undefined);
  }
  assert.equal(sourcePeriodHint(material, [], '2025-12-31'), undefined);
  assert.equal(sourcePeriodHint(material, [{ ...source, reporting_periods: [{ ...source.reporting_periods[0], end: '2026-02-30' }] }], '2025-12-31'), undefined);
});

test('filename hints apply only to financial roles and newer dates', () => {
  const financial = { ...material, filename: '2026年半年度财务报表.pdf' };
  for (const role of ['audit', 'financial', 'interimFinancial', 'notes'] as const) {
    assert.match(materialPeriodHint({ ...financial, role }, '2025-12-31')!.text, /文件名.*可能.*报表正文/);
    assert.equal(materialPeriodHint({ ...financial, role }, '2026-06-30'), undefined);
    assert.equal(materialPeriodHint({ ...financial, role }, null), undefined);
  }
  for (const role of ['historical', 'reference', 'other'] as const) assert.equal(materialPeriodHint({ ...financial, role }, '2025-12-31'), undefined);
});

test('both anomalies are preserved and disappear independently when source or target changes', () => {
  const financial = { ...material, material_id: 'synthetic-financial', role: 'audit' as const, filename: '2026年半年度财务报表.pdf' };
  assert.deepEqual(reportingPeriodHints([material, financial], [source], '2025-12-31').map(h => h.kind), ['source', 'material']);
  assert.deepEqual(reportingPeriodHints([material, financial], [], '2025-12-31').map(h => h.kind), ['material']);
  assert.deepEqual(reportingPeriodHints([material, financial], [source], '2026-06-30'), []);
});

test('hint markup safely escapes filenames and arbitrary text', () => {
  const html = renderPeriodHint({ kind: 'material', materialId: 'x', filename: '<img src=x onerror=alert(1)>', text: 'a & <script>bad()</script>' }, true);
  assert.doesNotMatch(html, /<img|<script>/);
  assert.match(html, /&lt;img/);
  assert.match(html, /a &amp; &lt;script&gt;/);
  assert.equal(renderPeriodHint(), '');
  assert.equal(periodLabel('2025-12-31'), '2025年末');
});

test('prototype filename recognition stays aligned with the implementation', async () => {
  const moduleUrl = new URL('../../../product-prototype/public/reporting-period-hints.js', import.meta.url).href;
  const prototype = await import(moduleUrl);
  for (const [filename, expected] of cases) assert.equal(prototype.financialFilenameCutoff(filename), expected, filename);
});
