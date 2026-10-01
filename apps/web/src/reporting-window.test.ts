import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MARKET_OFFERINGS, MARKETS, reportingWindow } from '@bondbuddy/contracts';

test('each supported market/product derives the standard calendar-year window and no duplicate year-end period', () => {
  for (const market of MARKETS) for (const offering of MARKET_OFFERINGS[market]) {
    const count = offering === 'private' || offering === 'ppn' ? 2 : 3;
    for (const end of ['03-31','06-30','09-30','12-31']) {
      const periods=reportingWindow(market,offering,`2026-${end}`);
      assert.equal(periods.length,count+(end==='12-31'?0:1));
      assert.equal(periods[0].start,`${2026-count+(end==='12-31'?1:0)}-01-01`);
      assert.equal(periods.at(-1)?.end,`2026-${end}`);
      assert.equal(new Set(periods.map(p=>p.end)).size,periods.length);
      assert.ok(periods.every(p=>p.status==='needs_confirmation'&&p.scope===null&&p.evidence_refs.length===0));
    }
  }
  assert.deepEqual(reportingWindow('sse','ppn','2026-06-30'),[]);
  assert.deepEqual(reportingWindow(null,null,'2026-06-30'),[]);
  assert.deepEqual(reportingWindow('sse','private','2026-06-29'),[]);
});
