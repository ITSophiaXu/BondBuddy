import assert from 'node:assert/strict';
import test from 'node:test';
import { financialUploadGuidance } from './financial-upload-guidance.js';

test('financial upload checklist distinguishes private and public annual windows and cumulative interim statements', () => {
  assert.deepEqual(financialUploadGuidance('sse', 'private', '2026-06-30').items, [
    '2024年度审计报告（含财务报表及附注）', '2025年度审计报告（含财务报表及附注）', '2026年1—6月财务报表'
  ]);
  for (const market of ['sse', 'szse'] as const) {
    for (const end of ['03-31', '06-30', '09-30', '12-31']) {
      const result = financialUploadGuidance(market, 'private', `2026-${end}`);
      assert.equal(result.items.length, end === '12-31' ? 2 : 3);
      assert.match(result.items.at(-1)!, end === '12-31' ? /2026年度审计报告/ : new RegExp(`2026年1—${Number(end.slice(0, 2))}月财务报表`));
      assert.equal(result.items.filter(item => item.includes('2026')).length, 1);
    }
    assert.equal(financialUploadGuidance(market, 'public', '2026-06-30').items.length, 4);
  }
  assert.equal(financialUploadGuidance('nafmii', 'ppn', '2026-06-30').items.length, 3);
  for (const offering of ['mtn', 'cp', 'scp', 'dfi'] as const)
    assert.equal(financialUploadGuidance('nafmii', offering, '2026-06-30').items.length, 4);
  assert.match(financialUploadGuidance('sse', 'private', '2027-03-31').items[0], /2025年度/);
});

test('missing information and invalid market/product/date do not invent required periods', () => {
  assert.match(financialUploadGuidance(null, null, null).note, /发行市场、品种／发行方式、财务截止日/);
  assert.deepEqual(financialUploadGuidance('sse', 'ppn', '2026-06-30').items, []);
  assert.deepEqual(financialUploadGuidance('sse', 'private', '2026-06-29').items, []);
  assert.match(financialUploadGuidance('nafmii', 'ppn', '2026-06-30').note, /通常口径/);
});
