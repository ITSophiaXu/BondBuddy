import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Recognition } from '@bondbuddy/contracts';
import { applyHistoricalProfileCorrection, validateHistoricalRecognitionProfile } from './historical-profile-correction.js';

function profile(): Recognition {
  const provenance = { material_id: 'material-synthetic', material_version: 1, method: 'native_text' as const,
    extractor_version: 'historical-native-recognition-v2/parser-synthetic', evidence_refs: ['anchor-market'] };
  return {
    material_id: 'material-synthetic', material_version: 1, profile_version: 1, state: 'needs_confirmation',
    source_market: { value: 'sse', raw_value: '上交所', provenance, uncertainty: [], status: 'recognized' },
    source_offering: { value: 'private', raw_value: '私募', provenance, uncertainty: [], status: 'recognized' },
    reporting_periods: [{ start: '2024-01-01', end: '2024-12-31', period_kind: 'annual', scope: 'consolidated',
      raw_value: '2024 年度', provenance, uncertainty: [], status: 'recognized' }],
    latest_reporting_cutoff: { value: '2024-12-31', raw_value: '2024 年度', provenance, uncertainty: [], status: 'recognized' },
  };
}

test('correction helper appends user_asserted values and never promotes them to verified facts', () => {
  const corrected = applyHistoricalProfileCorrection(profile(), {
    profile_version: 1, source_market: 'szse', reason: 'synthetic correction', evidence_refs: ['anchor-market'],
  }, { materialId: 'material-synthetic', materialVersion: 1, profileVersion: 2 });
  assert.equal(corrected.profile_version, 2);
  assert.equal(corrected.state, 'needs_confirmation');
  assert.equal(corrected.source_market.status, 'user_asserted');
  assert.equal(corrected.source_market.provenance.method, 'user_correction');
  assert.deepEqual(corrected.source_market.uncertainty, ['锚点存在但不证明所校正值，需人工核对原文语义']);
  assert.equal(corrected.source_offering.value, 'private', 'omitted correction targets retain the prior source value');
  assert.throws(() => validateHistoricalRecognitionProfile({ ...corrected,
    source_market: { ...corrected.source_market, provenance: { ...corrected.source_market.provenance, material_id: 'foreign-material' } },
  }), /HISTORICAL_PROFILE_EVIDENCE_MATERIAL_MISMATCH/);
});
