import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TargetReportingPeriod } from '@bondbuddy/contracts';
import { readTargetReportingPeriods, targetReportingRows } from './update-form.js';

function formData(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

test('target periods round-trip user assertion status without evidence or audited claims', () => {
  const period: TargetReportingPeriod = { start: '2025-01-01', end: '2025-12-31', period_kind: 'annual', scope: 'consolidated', status: 'user_asserted', evidence_refs: [] };
  const html = targetReportingRows([period]);
  assert.match(html, /我填写，待来源核对/);
  assert.match(html, /都不是审计事实或已核验期间/);
  assert.match(html, /target_period_start_0"[^>]*value="2025-01-01/);
  const restored = readTargetReportingPeriods(formData({
    target_period_start_0: '2025-01-01', target_period_end_0: '2025-12-31',
    target_period_kind_0: 'annual', target_period_scope_0: 'consolidated', target_period_status_0: 'user_asserted'
  }), 1);
  assert.deepEqual(restored, [period]);
});

test('incomplete period remains needs_confirmation and an existing uncertain complete period never upgrades implicitly', () => {
  const partial = readTargetReportingPeriods(formData({
    target_period_start_0: '2025-01-01', target_period_status_0: 'user_asserted'
  }), 1);
  assert.deepEqual(partial, [{ start: '2025-01-01', end: null, period_kind: null, scope: null, status: 'needs_confirmation', evidence_refs: [] }]);
  const completeButUncertain = readTargetReportingPeriods(formData({
    target_period_start_0: '2025-01-01', target_period_end_0: '2025-06-30', target_period_kind_0: 'interim',
    target_period_scope_0: 'parent', target_period_status_0: 'needs_confirmation'
  }), 1);
  assert.equal(completeButUncertain[0].status, 'needs_confirmation');
  assert.match(targetReportingRows([{ ...completeButUncertain[0], end: '2025-06-30', period_kind: 'interim', scope: 'parent' }]), /value="needs_confirmation" selected/);
  assert.deepEqual(readTargetReportingPeriods(formData({}), 0), [], 'no rows is an explicit empty set');
});
