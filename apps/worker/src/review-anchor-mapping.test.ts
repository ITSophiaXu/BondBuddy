import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewReport } from '../../../packages/contracts/dist/review-results.js';
import {
  evidenceKey,
  referenceFor,
  reviewContentHash,
  type TrustedReviewRecord,
} from '../../../packages/domain/dist/review-evidence.js';
import { normalizeReviewFindings } from '../../../packages/domain/dist/review-finding-normalization.js';
import { reviewFixture } from '../../../packages/domain/dist/review-test-fixtures.js';
import {
  mapDifferentialReviewTargets,
  retainUnmappedHistoricalFinding,
  type DifferentialMappingInput,
} from './review-anchor-mapping.js';

const paragraph = '合成甲公司本期募集资金全部用于偿还已披露的存量债务，金额为人民币100.00万元。';
function fixture() {
  const f = reviewFixture();
  const old = f.addRecord('old-1', paragraph, true, {
    parse_snapshot_id: 'old-snapshot',
    parse_response_sha256: 'c'.repeat(64),
  });
  const oldContext = { ...f.ctx, report_id: 'historical-report' };
  const findings = normalizeReviewFindings(
    [
      {
        stable_key: 'selected',
        dimension: 'financial',
        conclusion: 'manual',
        severity: 'P2',
        title: '待核金额',
        description: '合成测试问题',
        target_refs: [referenceFor(old, '100.00')],
        evidence_refs: [referenceFor(old)],
      },
    ],
    oldContext,
  );
  const previous: ReviewReport = {
    report_id: oldContext.report_id,
    project_id: oldContext.project_id,
    run_id: 'historical-run',
    input_revision: 1,
    version: 1,
    source_material: oldContext.source_material,
    scope: { mode: 'full_review', finding_ids: [] },
    findings,
    coverage: [],
    limitations: [],
    created_at: '2026-10-02T00:00:00Z',
  };
  const current: TrustedReviewRecord = {
    ...structuredClone(old),
    material_version: 2,
    material_sha256: 'b'.repeat(64),
    parse_snapshot_id: 'new-snapshot',
    parse_response_sha256: 'd'.repeat(64),
    record_id: 'new-7',
    record_sha256: reviewContentHash(['new', paragraph]),
    locator: { stable_ref: 'p7', path: [{ paragraph: 7 }] },
  };
  const input: DifferentialMappingInput = {
    evidence: {
      ...f.ctx,
      report_id: 'new-report',
      source_material: {
        material_id: current.material_id,
        material_version: 2,
        sha256: current.material_sha256,
      },
      records: [current],
    },
    previous_report: previous,
    scope: { mode: 'differential_review', finding_ids: [findings[0]!.finding_id] },
    historical_records: [old],
  };
  return { input, old, current, prior: findings[0]! };
}
const mapping = (input: DifferentialMappingInput) => mapDifferentialReviewTargets(input)[0]!;
const anchor = (input: DifferentialMappingInput) => mapping(input).anchors[0]!;
function tableRecord(
  base: TrustedReviewRecord,
  row: number,
  column: number,
  quote: string,
  table = 1,
): TrustedReviewRecord {
  return {
    ...structuredClone(base),
    record_id: `table-${table}-row-${row}-col-${column}`,
    record_sha256: reviewContentHash([table, row, column, quote]),
    literal_quote: quote,
    locator_type: 'docx_block',
    locator: {
      stable_ref: `t${table}:r${row}:c${column}`,
      path: [{ table }, { row }, { column }, { paragraph: 1 }],
    },
  };
}
function tableFixture() {
  const f = fixture();
  const oldLabel = tableRecord(f.old, 2, 1, '合成甲公司营业收入'),
    oldAmount = tableRecord(f.old, 2, 2, '100.00');
  const newLabel = tableRecord(f.current, 8, 1, '合成甲公司营业收入', 3),
    newAmount = tableRecord(f.current, 8, 2, '100.00', 3);
  f.input.historical_records = [oldLabel, oldAmount];
  f.input.evidence.records = [newLabel, newAmount];
  f.prior.target_refs = [referenceFor(oldAmount)];
  return { ...f, oldLabel, oldAmount, newLabel, newAmount };
}
test('unchanged source requires the exact material, parse, record, quote and locator pins', () => {
  const { input, old } = fixture();
  input.evidence.source_material = {
    material_id: old.material_id,
    material_version: old.material_version,
    sha256: old.material_sha256,
  };
  input.evidence.records = [old];
  assert.equal(anchor(input).method, 'exact_pin');
  assert.equal(mapping(input).source_changed, false);
  input.evidence.records = [{ ...old, parse_response_sha256: 'e'.repeat(64) }];
  assert.equal(anchor(input).status, 'unverified');
  assert.equal(mapping(input).current_target_refs.length, 0);
  input.evidence.records = [old];
  input.previous_report!.findings[0]!.target_refs[0]!.locator = {
    stable_ref: 'invented',
    path: [{ paragraph: 99 }],
  };
  assert.equal(anchor(input).status, 'unverified');
});
test('unique complete native paragraph maps a moved excerpt to current pins, retaining historical positions', () => {
  const { input, old, current } = fixture();
  const result = mapping(input);
  assert.equal(result.complete, true);
  assert.equal(result.source_changed, true);
  assert.equal(result.anchors[0]!.method, 'unique_full_quote');
  assert.equal(evidenceKey(result.current_target_refs[0]!), evidenceKey(current));
  assert.deepEqual(result.current_target_refs[0]!.locator, current.locator);
  assert.equal(
    result.current_target_refs[0]!.quote,
    paragraph,
    'matching uses verified complete record, not short selected quote',
  );
  assert.equal(result.historical_target_refs[0]!.quote, '100.00');
  assert.deepEqual(result.historical_target_refs[0]!.locator, old.locator);
});
test('positional stable_ref never identifies an edited or deleted paragraph across versions', () => {
  const { input, old, current } = fixture();
  current.locator = structuredClone(old.locator);
  current.literal_quote = paragraph.replace('100.00', '200.00');
  assert.equal(anchor(input).status, 'missing');
  assert.equal(mapping(input).complete, false);
  input.evidence.records = [];
  assert.equal(anchor(input).status, 'missing');
});
test('full trusted historical record is required even when the selected excerpt occurs in the new draft', () => {
  const { input, current } = fixture();
  input.historical_records = [];
  assert.equal(anchor(input).status, 'unverified');
  current.literal_quote = '100.00';
  assert.equal(anchor(input).status, 'unverified');
});
test('duplicate complete paragraphs in either snapshot cannot be picked by location', () => {
  const { input, old, current } = fixture();
  input.evidence.records = [
    current,
    {
      ...current,
      record_id: 'new-duplicate',
      locator: { stable_ref: 'p8', path: [{ paragraph: 8 }] },
    },
  ];
  assert.equal(anchor(input).status, 'ambiguous');
  input.evidence.records = [current];
  input.historical_records = [
    old,
    { ...old, record_id: 'old-duplicate', locator: { stable_ref: 'p2', path: [{ paragraph: 2 }] } },
  ];
  assert.equal(anchor(input).status, 'ambiguous');
});
test('native candidates with OCR or uncertain historical content remain unmapped', () => {
  const { input, old, current, prior } = fixture();
  old.extraction_method = 'ocr';
  prior.target_refs = [referenceFor(old)];
  assert.equal(anchor(input).status, 'uncertain');
  old.extraction_method = 'native_text';
  prior.target_refs = [referenceFor(old)];
  current.uncertainty = ['uncertain layout'];
  assert.equal(anchor(input).status, 'uncertain');
});
test('selected cross-version paragraph with a numeric-only or underspecified complete quote requires manual matching', () => {
  const { input, old, current, prior } = fixture();
  old.literal_quote = current.literal_quote = '100.00';
  prior.target_refs = [referenceFor(old)];
  assert.equal(anchor(input).status, 'unverified');
});
test('moving a unique complete table row preserves cell position with entirely new source pins', () => {
  const { input, newAmount } = tableFixture();
  assert.equal(anchor(input).method, 'unique_table_row');
  assert.equal(evidenceKey(anchor(input).current_ref!), evidenceKey(newAmount));
});
test('a lone numeric table cell or edited contextual label does not map', () => {
  const { input, oldAmount } = tableFixture();
  input.historical_records = [oldAmount];
  assert.equal(anchor(input).status, 'unverified');
  const f = tableFixture();
  f.newLabel.literal_quote = '合成甲公司净利润';
  assert.equal(anchor(f.input).status, 'missing');
});
test('duplicated complete table rows in old or new draft remain ambiguous', () => {
  const { input, oldLabel, oldAmount, newLabel, newAmount } = tableFixture();
  input.evidence.records = [
    newLabel,
    newAmount,
    tableRecord(newLabel, 9, 1, newLabel.literal_quote, 3),
    tableRecord(newAmount, 9, 2, newAmount.literal_quote, 3),
  ];
  assert.equal(anchor(input).status, 'ambiguous');
  input.evidence.records = [newLabel, newAmount];
  input.historical_records = [
    oldLabel,
    oldAmount,
    tableRecord(oldLabel, 3, 1, oldLabel.literal_quote),
    tableRecord(oldAmount, 3, 2, oldAmount.literal_quote),
  ];
  assert.equal(anchor(input).status, 'ambiguous');
});
test('OCR or uncertainty in another cell of a table row blocks row matching', () => {
  const { input, oldLabel, newLabel } = tableFixture();
  newLabel.extraction_method = 'ocr';
  assert.equal(anchor(input).status, 'uncertain');
  newLabel.extraction_method = 'native_text';
  oldLabel.uncertainty = ['uncertain row order'];
  assert.equal(anchor(input).status, 'uncertain');
});
test('XLSX and CSV rows use complete row content, not old row numbers', () => {
  for (const type of ['xlsx_cell', 'csv_cell'] as const) {
    const f = tableFixture();
    const records = [f.oldLabel, f.oldAmount, f.newLabel, f.newAmount];
    records.forEach((r, i) => {
      r.locator_type = type;
      r.locator =
        type === 'xlsx_cell'
          ? { sheet: i < 2 ? '原表' : '新表', cell: `${i % 2 ? 'B' : 'A'}${i < 2 ? 2 : 8}` }
          : { row: i < 2 ? 2 : 8, column: (i % 2) + 1 };
    });
    f.prior.target_refs = [referenceFor(f.oldAmount)];
    assert.equal(anchor(f.input).method, 'unique_table_row');
    assert.deepEqual(anchor(f.input).current_ref!.locator, f.newAmount.locator);
  }
});
test('foreign owner/project snapshots cannot establish historical or current mappings', () => {
  const { input, old, current } = fixture();
  old.owner_user_id = 'other-owner';
  assert.equal(anchor(input).status, 'unverified');
  old.owner_user_id = input.evidence.owner_user_id;
  current.project_id = 'other-project';
  assert.equal(anchor(input).status, 'missing');
});
test('selection remains explicit and unmapped old findings retain original positions without revision permission', () => {
  const { input, prior } = fixture();
  const other = { ...structuredClone(prior), finding_id: 'unselected' };
  input.previous_report!.findings.push(other);
  assert.deepEqual(
    mapDifferentialReviewTargets(input).map((f) => f.finding_id),
    [prior.finding_id],
  );
  const retained = retainUnmappedHistoricalFinding(prior, input.evidence.report_id, ['原文已改变']);
  assert.deepEqual(retained.target_refs, prior.target_refs);
  assert.equal(retained.check_status, 'carried_forward');
  assert.equal(retained.origin_report_id, prior.origin_report_id);
  assert.equal(retained.repairability.can_revise, false);
  input.scope.finding_ids = ['invented'];
  assert.throws(() => mapDifferentialReviewTargets(input), /SELECTION_INVALID/);
});
