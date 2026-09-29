import assert from 'node:assert/strict';
import test from 'node:test';
import type { Market, Offering, ReportingPeriod } from '@bondbuddy/contracts';
import { estimateUpdateDifficulty, type UpdateDifficultyEstimateInput } from './update-difficulty.js';

const provenance = {
  material_id: 'synthetic-material',
  material_version: 1,
  method: 'native_text' as const,
  extractor_version: 'synthetic-extractor-1',
  evidence_refs: ['synthetic-anchor'],
};

function period(end: string, scope: 'consolidated' | 'parent' = 'consolidated', overrides: Partial<ReportingPeriod> = {}): ReportingPeriod {
  return {
    start: `${end.slice(0, 4)}-01-01`, end, period_kind: 'annual', scope, raw_value: end,
    provenance, uncertainty: [], status: 'recognized', ...overrides,
  };
}

function input(overrides: Partial<UpdateDifficultyEstimateInput> = {}): UpdateDifficultyEstimateInput {
  return {
    profileVersion: 3,
    targetRevision: 8,
    source: {
      market: 'sse' as Market,
      offering: 'private' as Offering,
      reportingPeriods: [period('2022-12-31'), period('2023-12-31'), period('2024-12-31')],
    },
    target: {
      market: 'sse' as Market,
      offering: 'private' as Offering,
      reportingPeriods: [period('2022-12-31'), period('2023-12-31'), period('2024-12-31'), period('2025-12-31')],
    },
    replacements: [],
    restatements: [],
    ...overrides,
  };
}

test('old periods retained, only the 2025 cutoff counts as N=1', () => {
  const result = estimateUpdateDifficulty(input());
  assert.equal(result.status, 'ready');
  assert.equal(result.estimatedN, 1);
  assert.deepEqual(result.retainedCutoffs, ['2022-12-31', '2023-12-31', '2024-12-31']);
  assert.deepEqual(result.newCutoffs, ['2025-12-31']);
  assert.equal(result.latestConfirmedSourceCutoff, '2024-12-31');
});

test('confirmed OCR period identity allows N=1 when amount/formula review remains separately pending',()=>{
  const base=input();
  const reviewedOcrPeriod=period('2025-12-31','consolidated',{provenance:{material_id:'synthetic-financial',material_version:1,
    method:'ocr',extractor_version:'synthetic-ocr-v2',evidence_refs:['synthetic-ocr-record']},uncertainty:[]});
  const result=estimateUpdateDifficulty(input({target:{...base.target,reportingPeriods:[...base.target.reportingPeriods.slice(0,3),reviewedOcrPeriod]}}));
  assert.equal(result.status,'ready');
  assert.equal(result.estimatedN,1,'only period-identity uncertainty affects N; amount/formula OCR warnings remain in the immutable review evidence');
});

test('preserves latest confirmed interim cutoff and complete source period set', () => {
  const sourcePeriods = [period('2022-12-31'), period('2023-12-31'), period('2024-12-31'), period('2025-03-31', 'consolidated', {
    start: '2025-01-01', period_kind: 'interim', raw_value: '2025 Q1',
  })];
  const result = estimateUpdateDifficulty(input({
    source: { ...input().source, reportingPeriods: sourcePeriods },
    target: { ...input().target, reportingPeriods: sourcePeriods },
  }));
  assert.equal(result.estimatedN, 0);
  assert.equal(result.latestConfirmedSourceCutoff, '2025-03-31');
  assert.deepEqual(result.sourceReportingPeriods, sourcePeriods);
});

test('same periods across market/offering migration count N=0 while flagging structure adaptation', () => {
  const base = input();
  const result = estimateUpdateDifficulty(input({
    source: { ...base.source, market: 'sse', offering: 'private' },
    target: { ...base.source, market: 'szse', offering: 'public' },
  }));
  assert.equal(result.estimatedN, 0);
  assert.equal(result.structureAdaptationRequired, true);
});

test('an unresolved or conflicting target-period review never counts N as zero', () => {
  const base=input();
  const asserted={start:'2025-01-01',end:'2025-12-31',period_kind:'annual' as const,scope:'consolidated' as const,
    status:'user_asserted' as const,evidence_refs:[] as []};
  const pending=estimateUpdateDifficulty(input({target:{...base.target,reportingPeriods:[...base.target.reportingPeriods.slice(0,3),asserted]}}));
  assert.equal(pending.status,'needs_confirmation');
  assert.equal(pending.estimatedN,null);
});

test('same cutoff across three statements, parent/consolidated scopes, and duplicate materials counts once', () => {
  const duplicated = [period('2024-12-31'), period('2024-12-31', 'parent'), period('2024-12-31')];
  const result = estimateUpdateDifficulty(input({
    source: { ...input().source, reportingPeriods: [period('2024-12-31')] },
    target: { ...input().target, reportingPeriods: duplicated },
  }));
  assert.equal(result.estimatedN, 0);
  assert.deepEqual(result.retainedCutoffs, ['2024-12-31']);
});

test('an explicit substantial restatement of a retained cutoff counts once', () => {
  const result = estimateUpdateDifficulty(input({
    restatements: [{ cutoff: '2024-12-31', evidence: ['synthetic-restatement-anchor'], reason: 'Synthetic material changes reported figures materially.' }],
  }));
  assert.equal(result.estimatedN, 2); // one new 2025 cutoff plus one explicitly restated 2024 cutoff
  assert.deepEqual(result.restatementCutoffs, ['2024-12-31']);
  assert.ok(!result.retainedCutoffs.includes('2024-12-31'));
});

test('an old-only source gaining two distinct new cutoffs estimates N=2', () => {
  const result = estimateUpdateDifficulty(input({
    source: { ...input().source, reportingPeriods: [period('2022-12-31'), period('2023-12-31')] },
    target: { ...input().target, reportingPeriods: [period('2022-12-31'), period('2023-12-31'), period('2024-12-31'), period('2025-12-31')] },
  }));
  assert.equal(result.status, 'ready');
  assert.equal(result.estimatedN, 2);
  assert.deepEqual(result.newCutoffs, ['2024-12-31', '2025-12-31']);
  assert.deepEqual(result.retainedCutoffs, ['2022-12-31', '2023-12-31']);
  assert.equal(result.latestConfirmedSourceCutoff, '2023-12-31');
});

test('duplicate or equivalent representations of two new cutoffs still estimate N=2', () => {
  const result = estimateUpdateDifficulty(input({
    source: { ...input().source, reportingPeriods: [period('2022-12-31'), period('2023-12-31')] },
    target: {
      ...input().target,
      reportingPeriods: [
        period('2022-12-31'),
        period('2023-12-31'),
        period('2024-12-31'),
        period('2024-12-31', 'parent'),
        period('2024-12-31'),
        period('2025-12-31'),
        period('2025-12-31', 'consolidated', { raw_value: '2025 annual (duplicate submission)' }),
      ],
    },
  }));
  assert.equal(result.status, 'ready');
  assert.equal(result.estimatedN, 2);
  assert.deepEqual(result.newCutoffs, ['2024-12-31', '2025-12-31']);
  assert.deepEqual(result.retainedCutoffs, ['2022-12-31', '2023-12-31']);
});

test('replacement and restatement on one cutoff count once and require evidence and reason', () => {
  const result = estimateUpdateDifficulty(input({
    replacements: [{ cutoff: '2024-12-31', evidence: ['synthetic-replacement-anchor'], reason: 'Synthetic replacement financial material.' }],
    restatements: [{ cutoff: '2024-12-31', evidence: ['synthetic-restatement-anchor'], reason: 'Synthetic material restatement.' }],
  }));
  assert.equal(result.estimatedN, 2);
  assert.deepEqual(result.replacementCutoffs, ['2024-12-31']);
  assert.deepEqual(result.restatementCutoffs, ['2024-12-31']);
  const invalid = estimateUpdateDifficulty(input({
    replacements: [{ cutoff: '2024-12-31', evidence: [], reason: '' }],
  }));
  assert.equal(invalid.status, 'needs_confirmation');
  assert.equal(invalid.estimatedN, null);
});

test('unresolved end date blocks estimation instead of assuming zero', () => {
  const result = estimateUpdateDifficulty(input({
    source: { ...input().source, reportingPeriods: [period('2024-12-31'), period('2023-12-31', 'consolidated', { end: null, status: 'needs_confirmation' })] },
  }));
  assert.equal(result.status, 'needs_confirmation');
  assert.equal(result.estimatedN, null);
  assert.ok(result.confirmationReasons.some((reason) => reason.startsWith('source_period_end_missing')));
});

test('invalid revisions block estimation and period start after end needs confirmation', () => {
  const invalidProfileRevision = estimateUpdateDifficulty(input({ profileVersion: 0 }));
  assert.equal(invalidProfileRevision.status, 'needs_confirmation');
  assert.equal(invalidProfileRevision.estimatedN, null);
  const invalidTargetRevision = estimateUpdateDifficulty(input({ targetRevision: Number.NaN }));
  assert.equal(invalidTargetRevision.status, 'needs_confirmation');
  assert.equal(invalidTargetRevision.estimatedN, null);

  const base = input();
  const reversedPeriod = period('2024-12-31', 'consolidated', { start: '2025-01-01' });
  const result = estimateUpdateDifficulty(input({
    source: { ...base.source, reportingPeriods: [reversedPeriod] },
  }));
  assert.equal(result.status, 'needs_confirmation');
  assert.equal(result.estimatedN, null);
  assert.ok(result.confirmationReasons.some((reason) => reason.startsWith('source_period_start_after_end')));
});

test('invalid market/offering pair leaves structure adaptation unknown', () => {
  const base = input();
  const result = estimateUpdateDifficulty(input({
    source: { ...base.source, market: 'nafmii', offering: 'private' as Offering },
  }));
  assert.equal(result.status, 'needs_confirmation');
  assert.equal(result.estimatedN, null);
  assert.equal(result.structureAdaptationRequired, null);
});

test('missing source or target market, offering, or periods always blocks with null N', () => {
  const base = input();
  for (const patch of [
    { source: { ...base.source, market: null } },
    { source: { ...base.source, offering: null } },
    { target: { ...base.target, market: null } },
    { target: { ...base.target, offering: null } },
    { target: { ...base.target, reportingPeriods: [] } },
  ]) {
    const result = estimateUpdateDifficulty(input(patch));
    assert.equal(result.status, 'needs_confirmation');
    assert.equal(result.estimatedN, null);
  }
});
