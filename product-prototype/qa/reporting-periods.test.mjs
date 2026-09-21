import test from 'node:test';
import assert from 'node:assert/strict';
import { reportingPeriods } from '../public/reporting-periods.js';

test('private bonds include two completed years and the cumulative current interim',()=>{
  for(const [end,month] of [['03-31',3],['06-30',6],['09-30',9]]){
    const w=reportingPeriods(`2026-${end}`,'private');
    assert.deepEqual(w.periods.map(p=>p.label),['2024年度','2025年度',`2026年1—${month}月`]);
    assert.equal(w.periods[2].start,'2026-01-01');assert.equal(w.periods[2].end,`2026-${end}`);
    assert.equal(w.basis,'两年一期');
  }
});
test('public bonds include three completed years before the selected interim',()=>{
  for(const end of ['03-31','06-30','09-30']){
    const w=reportingPeriods(`2026-${end}`,'public');
    assert.deepEqual(w.periods.slice(0,3).map(p=>p.end),['2023-12-31','2024-12-31','2025-12-31']);
    assert.equal(w.periods[3].end,`2026-${end}`);assert.equal(w.basis,'三年一期');
  }
});
test('year-end rolls into the annual window without adding a duplicate interim',()=>{
  assert.deepEqual(reportingPeriods('2026-12-31','private').periods.map(p=>p.label),['2025年度','2026年度']);
  const w=reportingPeriods('2026-12-31','public');
  assert.deepEqual(w.periods.map(p=>p.label),['2024年度','2025年度','2026年度']);assert.equal(w.hasInterim,false);
  assert.equal(reportingPeriods('2027-03-31','private').periods[1].label,'2026年度');
});
test('invalid dates and issuance types cannot create a misleading reporting window',()=>{
  for(const date of ['2026-07-01','2026-06-31','','2026-6-30'])assert.throws(()=>reportingPeriods(date,'private'));
  assert.throws(()=>reportingPeriods('2026-06-30','unknown'));
});
