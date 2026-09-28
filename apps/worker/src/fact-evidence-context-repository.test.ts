import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DOCX_AUXILIARY_TARGETS_PARSER_VERSION, type DocxAuxiliaryTarget, type DocumentParseRecord } from './document-parser.js';
import { deriveFactEvidenceContextManifest } from './fact-evidence-context-repository.js';
import type { StoredParseSnapshot } from './parse-evidence-repository.js';

const body: DocumentParseRecord = {
  record_id: 'evidence-000001', material_id: 'material-1', material_version: 1, content_hash: 'a'.repeat(64),
  locator_type: 'docx_block', locator: { path: [{ table: 1, row: 2, column: 3 }], stable_ref: 'docx:t001:r002:c003' },
  literal_quote: 'synthetic value', context: '', extraction_method: 'native_text', extractor_version: '1.0.7',
  confidence: null, uncertainty: [], formatting: {},
};

function snapshot(overrides: Partial<StoredParseSnapshot> = {}): StoredParseSnapshot {
  const response = {
    schema_version: 'document-parse-response-v1' as const, request_id: 'request-1', parser_version: DOCX_AUXILIARY_TARGETS_PARSER_VERSION,
    status: 'parsed' as const,
    material: { material_id: 'material-1', material_version: 1, media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const,
      sha256: 'a'.repeat(64) },
    records: [body], warnings: [], document: { page_count: null, revision_summary: { insertions: 0, deletions: 0 }, auxiliary_targets: [] }, error: null,
  };
  return {
    snapshotId: 'snapshot-1', ownerUserId: 'owner-1', projectId: 'project-1', materialId: 'material-1', materialVersion: 1,
    contentSha256: 'a'.repeat(64), parserVersion: DOCX_AUXILIARY_TARGETS_PARSER_VERSION, requestId: 'request-1', requestHash: 'b'.repeat(64), requestOptions: {},
    responseSha256: 'c'.repeat(64), response, evidence: [body], evidenceComplete: true, evidenceRecordCount: 1,
    createdAt: new Date(0).toISOString(), replayed: false, ...overrides,
  } as StoredParseSnapshot;
}

const binding = {
  ownerUserId: 'owner-1', projectId: 'project-1', candidateId: 'candidate-1', identityHash: 'd'.repeat(64),
  inputRevision: 7, inputHash: '8'.repeat(64),
  factIdentity: { entityId: 'entity:synthetic', metric: 'synthetic_metric', scope: 'consolidated' },
  candidateStatus: 'needs_confirmation' as const, candidateUncertainty: ['SYNTHETIC_REVIEW'], candidateConfidence: 0.42,
  sourceKind: 'external' as const, materialId: 'material-1', materialVersion: 1, sourceSha256: 'a'.repeat(64),
};

function headerTarget(scopeOverrides: Partial<DocxAuxiliaryTarget['scope']> = {}): DocxAuxiliaryTarget {
  return {
    target_id: `aux-${'e'.repeat(64)}`, kind: 'header', part_name: 'word/header1.xml', locator: { part_name: 'word/header1.xml', paragraph_index: 1 },
    scope: { kind: 'section_reference', status: 'unknown', relationship_part_sha256: 'f'.repeat(64),
      relationships: [{ relationship_id: 'rId1', relationship_id_sha256: '1'.repeat(64), relationship_type: 'header', mode: 'internal',
        target_part: 'word/header1.xml', status: 'resolved' }],
      section_references: [{ section_index: 1, reference_type: 'default', relationship_id: 'rId1', relationship_id_sha256: '1'.repeat(64),
        section_stable_ref: 'docx:p0001' }], unknown_sections: [], body_references: [], reason: 'scope_detail_limit_exceeded', truncated: false,
      ...scopeOverrides },
    part_sha256: '2'.repeat(64), target_sha256: '3'.repeat(64), locator_resolved: true, parseable: true, parse_status: 'parsed',
    text_summary: { sha256: '4'.repeat(64), character_count: 12, has_text: true },
  };
}

function derive(targets: DocxAuxiliaryTarget[]) {
  const current = snapshot();
  const withTargets = { ...current, response: { ...current.response,
    document: { ...current.response.document, auxiliary_targets: targets } } } as StoredParseSnapshot;
  return deriveFactEvidenceContextManifest({ ...binding, snapshot: withTargets, selectedRecords: [body], auxiliaryTargets: targets, docx: true });
}

test('a text-only snapshot with an exact body ref has a stable complete evidence context, not an approval', () => {
  const current = snapshot({ response: { ...snapshot().response, parser_version: '1.0.6' }, parserVersion: '1.0.6' });
  const manifest = deriveFactEvidenceContextManifest({ ...binding, snapshot: current, selectedRecords: [body], auxiliaryTargets: [], docx: false });
  assert.equal(manifest.completeness_status, 'complete');
  assert.equal(manifest.reviewable, true);
  assert.deepEqual(manifest.selected_body, [{ record_id: body.record_id, content_sha256: body.content_hash,
    locator_type: body.locator_type, locator: body.locator, confidence: body.confidence, uncertainty: body.uncertainty }]);
  assert.equal(manifest.candidate_status, 'needs_confirmation');
  assert.deepEqual(manifest.candidate_uncertainty, ['SYNTHETIC_REVIEW']);
  assert.equal(manifest.candidate_confidence, 0.42);
  assert.deepEqual(manifest.original_warnings, []);
  assert.equal(manifest.evidence_set_sha256.length, 64);
  assert.equal('decision' in manifest, false);
  const parserChanged = deriveFactEvidenceContextManifest({ ...binding,
    snapshot: { ...current, snapshotId: 'snapshot-v2-parser', parserVersion: '1.0.8', responseSha256: '5'.repeat(64) },
    selectedRecords: [body], auxiliaryTargets: [], docx: false });
  assert.notEqual(parserChanged.evidence_set_sha256, manifest.evidence_set_sha256);
  const materialChanged = deriveFactEvidenceContextManifest({ ...binding, materialVersion: 2, sourceSha256: '6'.repeat(64),
    snapshot: { ...current, snapshotId: 'snapshot-v2-material', materialVersion: 2, contentSha256: '6'.repeat(64),
      responseSha256: '7'.repeat(64) }, selectedRecords: [body], auxiliaryTargets: [], docx: false });
  assert.notEqual(materialChanged.evidence_set_sha256, manifest.evidence_set_sha256);
});

test('an apparently resolved header relation remains unknown relative to selected body evidence', () => {
  const target = headerTarget({ status: 'resolved', reason: null });
  const manifest = derive([target]);
  assert.equal(manifest.auxiliary_targets[0]?.relevance, 'unknown');
  assert.equal(manifest.reviewable, false);
  assert.ok(manifest.completeness_reasons.includes('AUXILIARY_RELEVANCE_UNKNOWN'));
});

test('a fully located note reference is marked relevant to the exact selected body record', () => {
  const target: DocxAuxiliaryTarget = {
    target_id: `aux-${'9'.repeat(64)}`, kind: 'footnote', part_name: 'word/footnotes.xml',
    locator: { part_name: 'word/footnotes.xml', note_id: '4', paragraph_index: 1 },
    scope: { kind: 'note_reference', status: 'resolved', relationship_part_sha256: '8'.repeat(64),
      relationships: [{ relationship_id: 'rIdFootnotes', relationship_id_sha256: '7'.repeat(64), relationship_type: 'footnotes',
        mode: 'internal', target_part: 'word/footnotes.xml', status: 'resolved' }], section_references: [], unknown_sections: [],
      body_references: [{ note_id: '4', note_id_sha256: '6'.repeat(64), stable_ref: 'docx:t001:r002:c003' }], reason: null, truncated: false },
    part_sha256: '5'.repeat(64), target_sha256: '4'.repeat(64), locator_resolved: true, parseable: true, parse_status: 'parsed',
    text_summary: { sha256: '3'.repeat(64), character_count: 16, has_text: true },
  };
  const manifest = derive([target]);
  assert.equal(manifest.auxiliary_targets[0]?.relevance, 'relevant');
  assert.equal(manifest.reviewable, true);
});

test('truncated auxiliary references and unreadable targets fail closed', () => {
  const truncated = headerTarget({ truncated: true, status: 'unknown', reason: 'scope_detail_limit_exceeded' });
  const manifest = derive([truncated]);
  assert.equal(manifest.reviewable, false);
  assert.ok(manifest.completeness_reasons.includes('AUXILIARY_SCOPE_TRUNCATED'));

  const unreadable = { ...headerTarget(), parseable: false, locator_resolved: false,
    parse_status: 'size_limited' as const, part_sha256: null, target_sha256: null, text_summary: null };
  const unreadableManifest = derive([unreadable]);
  assert.equal(unreadableManifest.reviewable, false);
  assert.ok(unreadableManifest.completeness_reasons.includes('AUXILIARY_TARGET_UNREADABLE'));
});

test('an auxiliary relationship that points to a missing inventory target fails closed', () => {
  const target = headerTarget({ status: 'resolved', reason: null, relationships: [{ relationship_id: 'rId2',
    relationship_id_sha256: '5'.repeat(64), relationship_type: 'header', mode: 'internal', target_part: 'word/header2.xml', status: 'resolved' }] });
  const manifest = derive([target]);
  assert.equal(manifest.reviewable, false);
  assert.ok(manifest.completeness_reasons.includes('AUXILIARY_TARGET_MISSING'));
});

test('missing DOCX auxiliary inventory in a legacy snapshot stays incomplete', () => {
  const current = snapshot({ parserVersion: '1.0.6', response: { ...snapshot().response, parser_version: '1.0.6',
    document: { page_count: null, revision_summary: { insertions: 0, deletions: 0 } } } as StoredParseSnapshot['response'] });
  const manifest = deriveFactEvidenceContextManifest({ ...binding, snapshot: current, selectedRecords: [body], auxiliaryTargets: [], docx: true });
  assert.equal(manifest.reviewable, false);
  assert.ok(manifest.completeness_reasons.includes('DOCX_AUXILIARY_INVENTORY_VERSION_UNSUPPORTED'));
  assert.ok(manifest.completeness_reasons.includes('DOCX_AUXILIARY_INVENTORY_MISSING'));
});
