import test from 'node:test';
import assert from 'node:assert/strict';
import {
  docxAnchorMetric,
  orderedRecordsSha256,
  snapshotMetric,
  xlsxMetric,
  type AuditEvidenceRow,
  type AuditSnapshotRow,
} from './parse-snapshot-audit.js';

const DOCX_MEDIA = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MEDIA = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const hash = 'a'.repeat(64);

function snapshot(mediaType = DOCX_MEDIA): AuditSnapshotRow {
  return {
    owner_user_id: 'synthetic-owner', project_id: 'synthetic-project', material_id: 'synthetic-material', material_version: 1,
    media_type: mediaType, content_sha256: hash, parser_version: 'synthetic-parser-1', response_status: 'needs_confirmation',
    response_sha256: 'b'.repeat(64), record_count: 1,
    response_meta: { warnings: [{ code: 'XLSX_FORMULA_CACHE_UNVERIFIED', message: 'synthetic only' }], document: { cached_formula_results: 1 } },
  };
}

function evidence(ordinal = 0, locator: unknown = { path: [{ paragraph: 4 }], stable_ref: 'synthetic-locator' }): AuditEvidenceRow {
  return {
    record_id: `evidence-${String(ordinal + 1).padStart(6, '0')}`, locator_type: 'docx_block', locator,
    literal_quote: 'Synthetic private marker text', context: 'Synthetic private context', extraction_method: 'native_text',
    extractor_version: 'synthetic-parser-1', confidence: null, uncertainty: [], formatting: {}, ordinal,
  };
}

test('ordered record hash is stable for replay and differs when the second job has changed records', () => {
  const original = [evidence(0), evidence(1, { path: [{ paragraph: 65 }], stable_ref: 'synthetic-locator-2' })];
  const replay = structuredClone(original);
  const changedSecondJob = structuredClone(original);
  changedSecondJob[1]!.literal_quote = 'Synthetic changed text';
  const firstHash = orderedRecordsSha256(snapshot(), original);
  assert.equal(orderedRecordsSha256(snapshot(), replay), firstHash, 'same immutable snapshot replay hashes identically');
  assert.notEqual(orderedRecordsSha256(snapshot(), changedSecondJob), firstHash, 'different full records must not compare equal');
});

test('ordered record hash preserves array order while sorting object keys canonically', () => {
  const first = [evidence(0, { stable_ref: 'synthetic', path: [{ paragraph: 4 }] })];
  const sameDifferentKeyOrder = [evidence(0, { path: [{ paragraph: 4 }], stable_ref: 'synthetic' })];
  const reversedPath = [evidence(0, { path: [{ paragraph: 4 }, { table: 2, row: 28, column: 3 }], stable_ref: 'synthetic' })];
  assert.equal(orderedRecordsSha256(snapshot(), first), orderedRecordsSha256(snapshot(), sameDifferentKeyOrder));
  assert.notEqual(orderedRecordsSha256(snapshot(), first), orderedRecordsSha256(snapshot(), reversedPath));
});

test('anchor metric reports locator presence without claiming source quote verification', () => {
  const rows = [
    evidence(0, { path: [{ paragraph: 4 }], stable_ref: 'synthetic' }),
    evidence(1, { path: [{ paragraph: 65 }], stable_ref: 'synthetic' }),
    evidence(2, { path: [{ paragraph: 249 }, { table: 2, row: 28, column: 3 }], stable_ref: 'synthetic' }),
  ];
  const result = docxAnchorMetric(rows);
  assert.deepEqual(result.locators.p4, { count: 1, unique: true });
  assert.deepEqual(result.locators.p65, { count: 1, unique: true });
  assert.deepEqual(result.locators.p249_table2_row28_cell3, { count: 1, unique: true });
  assert.equal(result.source_quote_independent_check, 'not_performed');
  assert.equal(JSON.stringify(result).includes('Synthetic private marker text'), false);
});

test('XLSX cached formula metric checks count, record uncertainty, and needs_confirmation status', () => {
  const xlsx = snapshot(XLSX_MEDIA);
  const row: AuditEvidenceRow = {
    ...evidence(), locator_type: 'xlsx_cell', formatting: { cached_formula_result: 'synthetic cached value' },
    uncertainty: ['formula_cached_result_unverified'],
  };
  const result = xlsxMetric(xlsx, [row]);
  assert.equal(result.cached_formula_results_unverified_count, 1);
  assert.equal(result.cached_formula_result_record_count, 1);
  assert.equal(result.cached_formula_unverified_status, 'consistent_needs_confirmation');
  assert.equal(JSON.stringify(result).includes('synthetic cached value'), false);
});

test('snapshot metric rejects a non-complete or unordered evidence sequence', () => {
  assert.throws(() => snapshotMetric(snapshot(), [evidence(1)]), /AUDIT_SNAPSHOT_INTEGRITY_MISMATCH/);
});

test('reported parse metrics exclude record text and identifying IDs', () => {
  const report = JSON.stringify(snapshotMetric(snapshot(), [evidence()]));
  for (const privateValue of ['Synthetic private marker text', 'Synthetic private context', 'evidence-000001', 'synthetic-material', 'synthetic-owner', 'synthetic-project']) {
    assert.equal(report.includes(privateValue), false);
  }
});
