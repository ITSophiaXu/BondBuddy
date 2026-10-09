import assert from 'node:assert/strict';
import test from 'node:test';
import { reportingWindow } from './reporting-window.js';
import { sourceProspectusInputGaps, sourceProspectusMissingFields, type SourceProspectus } from './update-project.js';

const material = { material_id: 'synthetic-source', material_version: 1, sha256: 'a'.repeat(64), role: 'historical' };
const source = (): SourceProspectus => ({ ...material, issuer_name: 'Synthetic issuer', relation: 'same_issuer',
  market: 'sse', offering: 'private', reporting_periods: reportingWindow('sse', 'private', '2025-09-30'), status: 'user_asserted' });

test('each uploaded source requires relation, market, offering and reporting period', () => {
  assert.deepEqual(sourceProspectusMissingFields(source()), []);
  assert.equal(sourceProspectusInputGaps([material], []).length, 1);
  for (const [field, value] of [['relation', null], ['market', null], ['offering', null], ['reporting_periods', []]] as const)
    assert.ok(sourceProspectusMissingFields({ ...source(), [field]: value }).length, field);
  for (const relation of ['same_issuer', 'parent', 'subsidiary', 'similar_business'] as const) {
    assert.deepEqual(sourceProspectusMissingFields({ ...source(), relation }), []);
    assert.ok(sourceProspectusMissingFields({ ...source(), relation, reporting_periods: [] }).length);
  }
  assert.ok(sourceProspectusMissingFields({ ...source(), market: 'sse', offering: 'mtn' }).includes('原品种'));
});

test('source optionality, every-file coverage and version binding are independent', () => {
  assert.deepEqual(sourceProspectusInputGaps([{ ...material, role: 'audit' }], []), []);
  assert.deepEqual(sourceProspectusInputGaps([], []), []);
  const reference = { ...material, material_id: 'synthetic-reference', role: 'reference' };
  assert.deepEqual(sourceProspectusInputGaps([material, reference], [source()]).map(g => g.material_id), ['synthetic-reference']);
  assert.equal(sourceProspectusInputGaps([{ ...material, material_version: 2 }], [source()]).length, 1);
  assert.equal(sourceProspectusInputGaps([{ ...material, sha256: 'b'.repeat(64) }], [source()]).length, 1);
  assert.equal(sourceProspectusInputGaps([material], [source(), source()]).length, 1);
});

test('user-declared periods need valid dates, without financial extraction or scope approval', () => {
  const s = source();
  assert.ok(s.reporting_periods.every(p => p.scope === null && p.status === 'needs_confirmation'));
  assert.deepEqual(sourceProspectusMissingFields(s), []);
  for (const edit of [{ end: null }, { start: null }, { end: '2025-02-30' }, { start: '2026-01-01' }, { period_kind: null }])
    assert.ok(sourceProspectusMissingFields({ ...s, reporting_periods: [{ ...s.reporting_periods[0], ...edit }] }).includes('原稿最新报告期'));
  assert.deepEqual(sourceProspectusMissingFields({ ...s, reporting_periods: [{ ...s.reporting_periods[0], start: '2023-04-01', end: '2024-03-30' }] }), []);
});

test('source issuer name is optional while all other declarations and material pins remain required', () => {
  for (const issuer_name of [null, '', '  ']) {
    const declaration = { ...source(), issuer_name };
    assert.deepEqual(sourceProspectusMissingFields(declaration), []);
    assert.deepEqual(sourceProspectusInputGaps([material], [declaration]), []);
    assert.equal(sourceProspectusInputGaps([{ ...material, material_version: 2 }], [declaration]).length, 1);
  }
});
