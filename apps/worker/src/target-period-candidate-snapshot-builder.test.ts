import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  canonicalTargetPeriodCandidateSnapshotContent,
  validTargetPeriodCandidateSnapshot,
  type OcrReview,
} from '@bondbuddy/contracts';
import type { DocumentParseRecord } from './document-parser.js';
import { buildTargetPeriodCandidateSnapshot, type BuildTargetPeriodCandidateSnapshotInput } from './target-period-candidate-snapshot-builder.js';
import {
  proposeTargetReportingPeriods,
  type LockedFinancialMaterialRef,
  type NativePeriodEvidenceSnapshot,
  type OcrPeriodEvidenceSnapshot,
  type TargetPeriodCandidateSet,
  type TargetPeriodEvidenceSnapshot,
} from './target-period-candidates.js';

const material: LockedFinancialMaterialRef = {
  material_id: 'financial-1', material_version: 2, material_sha256: 'a'.repeat(64), role: 'interimFinancial',
};
const cutoff = '2025-06-30';
const requirements = { version: 3, content_sha256: '9'.repeat(64), message_ids: ['requirement-1'] };

function nativeRecord(id: string, quote: string, context: string, uncertainty: string[] = []): DocumentParseRecord & { record_sha256: string } {
  return {
    record_id: id, material_id: material.material_id, material_version: material.material_version,
    content_hash: material.material_sha256, locator_type: 'xlsx_cell',
    locator: { path: [{ sheet: '合并利润表', table: 1, row: 1, column: 2 }] }, literal_quote: quote, context,
    extraction_method: 'native_text', extractor_version: 'parser-1', confidence: 0.99, uncertainty, formatting: { sheet_state: 'visible' },
    record_sha256: createHash('sha256').update(id, 'utf8').digest('hex'),
  };
}

function nativeSnapshot(records: readonly (DocumentParseRecord & { record_sha256: string })[], warningMessage = ''): NativePeriodEvidenceSnapshot {
  return {
    method: 'native_text', snapshot_id: 'parse-snapshot-1', response_sha256: 'c'.repeat(64),
    material_id: material.material_id, material_version: material.material_version, material_sha256: material.material_sha256,
    media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', parser_version: 'parser-1', status: 'parsed',
    warnings: warningMessage ? [{ code: 'SYNTHETIC_WARNING', message: warningMessage }] : [], records,
  };
}

function ocrSnapshot(): OcrPeriodEvidenceSnapshot {
  const review: OcrReview = {
    snapshot_id: 'ocr-snapshot-1', result_sha256: 'd'.repeat(64), material_id: material.material_id,
    material_version: material.material_version, purpose: 'source_preflight', coverage: 'complete', page_count: 1,
    pages: [{ page: 1, width: 100, height: 100, rotation_clockwise: 0, coordinate_system: 'rendered_pixels_top_left',
      image_sha256: 'e'.repeat(64), image_url: 'https://example.invalid/page-1', warnings: [] }],
    records: [{ record_id: 'ocr-record-1', page: 1, bbox: [0, 0, 90, 20],
      text: '某公司合并财务报表报告期 2024年度', confidence: 0.98,
      numeric: { kind: 'unparsed', decimal: null, unit: null }, cell: null, uncertainty: [], eligible_for_manuscript: false }],
    corrections: [], warnings: [], eligible_for_manuscript: false,
  };
  return { method: 'ocr', review, processor_version: 'ocr-processor-1', material_sha256: material.material_sha256,
    record_sha256_by_id: { 'ocr-record-1': 'f'.repeat(64) } };
}

function candidateSet(snapshots: readonly TargetPeriodEvidenceSnapshot[]): TargetPeriodCandidateSet {
  return proposeTargetReportingPeriods({ reporting_cutoff: cutoff, locked_materials: [material], snapshots });
}

function build(set: TargetPeriodCandidateSet, patch: Partial<BuildTargetPeriodCandidateSnapshotInput> = {}) {
  return buildTargetPeriodCandidateSnapshot({
    candidate_set: set,
    candidate_set_id: 'candidate-set-01',
    candidate_set_version: 1,
    owner_user_id: 'owner-01',
    project_id: 'project-01',
    project_draft_revision: 8,
    reporting_cutoff: cutoff,
    locked_materials: [material],
    supplemental_requirements: requirements,
    ...patch,
  });
}

test('adapts annual and interim proposals with exact evidence and anchor identities, all still pending', () => {
  const set = candidateSet([nativeSnapshot([
    nativeRecord('annual-row', '2024年度', '发行人名称：某公司 / 合并财务报表报告期'),
    nativeRecord('interim-row', '2025年上半年', '发行人名称：某公司 / 合并财务报表报告期'),
  ])]);
  const result = build(set);
  assert.equal(validTargetPeriodCandidateSnapshot(result), true);
  assert.deepEqual(result.content.candidates.map(item => [item.start, item.end, item.period_kind]), [
    ['2024-01-01', '2024-12-31', 'annual'],
    ['2025-01-01', '2025-06-30', 'interim'],
  ]);
  assert.ok(result.content.candidates.every(item => item.status === 'needs_confirmation'));
  assert.deepEqual(result.content.candidates[0]!.anchors.find(item => item.kind === 'period_end'), {
    kind: 'period_end', snapshot_id: 'parse-snapshot-1', record_id: 'annual-row', raw_period_token: '2024年度',
  });
  assert.deepEqual(result.content.evidence_records.map(item => item.record_id), ['annual-row', 'interim-row']);
  assert.equal(result.content.evidence_records[0]!.record_sha256, createHash('sha256').update('annual-row', 'utf8').digest('hex'));
});

test('content hash is deterministic and binds the supplied requirements version/content pin', () => {
  const set = candidateSet([nativeSnapshot([nativeRecord('annual-row', '2024年度', '发行人名称：某公司 / 合并财务报表报告期')])]);
  const first = build(set);
  const second = build(set);
  assert.equal(first.content_sha256, second.content_sha256);
  assert.equal(first.content_sha256, createHash('sha256').update(canonicalTargetPeriodCandidateSnapshotContent(first), 'utf8').digest('hex'));
  const changedRequirement = build(set, { supplemental_requirements: { version: 4, content_sha256: '8'.repeat(64), message_ids: ['requirement-1'] } });
  assert.notEqual(changedRequirement.content_sha256, first.content_sha256, 'changed requirement pins produce a different snapshot hash');
});

test('rejects cutoff/material drift and missing or duplicate source snapshots', () => {
  const set = candidateSet([nativeSnapshot([nativeRecord('annual-row', '2024年度', '发行人名称：某公司 / 合并财务报表报告期')])]);
  assert.throws(() => build(set, { reporting_cutoff: '2025-07-31' }), /CUTOFF_DRIFT/);
  assert.throws(() => build(set, { locked_materials: [{ ...material, material_sha256: 'b'.repeat(64) }] }), /MATERIAL_DRIFT/);

  const missingSource = structuredClone(set) as any;
  missingSource.source_snapshot_pins = [];
  assert.throws(() => build(missingSource), /EVIDENCE_SOURCE_MISMATCH/);
  const duplicateSource = structuredClone(set) as any;
  duplicateSource.source_snapshot_pins.push(structuredClone(duplicateSource.source_snapshot_pins[0]!));
  assert.throws(() => build(duplicateSource), /DUPLICATE_SOURCE/);
});

test('preserves OCR snapshot, processor, response, record, page and image pins', () => {
  const result = build(candidateSet([ocrSnapshot()]));
  const source = result.content.source_snapshots[0]!;
  assert.equal(source.evidence_method, 'ocr');
  assert.equal(source.parser_version, 'ocr-processor-1');
  assert.equal(source.response_sha256, 'd'.repeat(64));
  assert.deepEqual(source.page_image_pins, [{ page: 1, image_sha256: 'e'.repeat(64) }]);
  assert.deepEqual(result.content.evidence_records[0], {
    snapshot_id: 'ocr-snapshot-1', record_id: 'ocr-record-1', record_sha256: 'f'.repeat(64),
    quote: '某公司合并财务报表报告期 2024年度', context: '', locator: { page: 1, bbox: [0, 0, 90, 20] },
    uncertainty: [], page: 1, page_image_sha256: 'e'.repeat(64),
  });
});

test('preserves long global warnings without copying them into candidate-specific reasons', () => {
  const warning = 'synthetic-parser-warning-'.repeat(30);
  const set = candidateSet([nativeSnapshot([nativeRecord('annual-row', '2024年度', '发行人名称：某公司 / 合并财务报表报告期')], warning)]);
  const result = build(set);
  assert.ok(result.content.source_warnings.some(item => item.endsWith(warning)));
  assert.ok(result.content.candidates[0]!.pending_reasons.every(item => !item.includes(warning)));
});

test('represents an empty candidate set as pending and does not infer a period from cutoff', () => {
  const set = candidateSet([]);
  const result = build(set);
  assert.equal(result.content.candidates.length, 0);
  assert.deepEqual(result.content.pending_reasons, ['no_evidenced_reporting_period_candidates', 'period_evidence_snapshots_missing']);
  assert.equal(result.content.status, 'needs_confirmation');
  assert.equal(result.content.completeness, 'not_determined');
  assert.equal(validTargetPeriodCandidateSnapshot(result), true);
});
