import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DocumentParseRecord, DocumentParseResponse } from './document-parser.js';
import type { StoredParseSnapshot } from './parse-evidence-repository.js';
import { selectIssuerIdentityEvidence, type IssuerIdentityEvidenceScope } from './issuer-identity-evidence-selector.js';

const scope: IssuerIdentityEvidenceScope = {
  ownerUserId: 'identity-owner-a', projectId: 'identity-project-a', materialId: 'identity-material-a',
  materialVersion: 2, snapshotId: 'identity-snapshot-a',
};
const materialHash = 'a'.repeat(64);
const responseHash = 'b'.repeat(64);

function record(recordId: string, quote: string, overrides: Partial<DocumentParseRecord> = {}): DocumentParseRecord {
  return {
    record_id: recordId, material_id: scope.materialId, material_version: scope.materialVersion,
    content_hash: materialHash, locator_type: 'docx_block', locator: { path: [{ paragraph: Number(recordId.slice(-1)) || 1 }] },
    literal_quote: quote, context: '', extraction_method: 'native_text', extractor_version: 'test-parser-1',
    confidence: null, uncertainty: [], formatting: {}, ...overrides,
  };
}

function snapshot(records: DocumentParseRecord[], overrides: Partial<StoredParseSnapshot> = {}): StoredParseSnapshot {
  const response: DocumentParseResponse = {
    schema_version: 'document-parse-response-v1', request_id: 'parse-request-a', parser_version: 'test-parser-1',
    status: 'parsed', material: { material_id: scope.materialId, material_version: scope.materialVersion,
      media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sha256: materialHash },
    records, warnings: [], document: { page_count: null, revision_summary: { insertions: 0, deletions: 0 } }, error: null,
  };
  return {
    snapshotId: scope.snapshotId, ownerUserId: scope.ownerUserId, projectId: scope.projectId, materialId: scope.materialId,
    materialVersion: scope.materialVersion, contentSha256: materialHash, parserVersion: 'test-parser-1',
    requestId: 'parse-request-a', requestHash: 'c'.repeat(64), requestOptions: {}, responseSha256: responseHash,
    response, evidence: records, evidenceComplete: true, evidenceRecordCount: records.length,
    createdAt: '2026-09-26T00:00:00.000Z', replayed: false, ...overrides,
  };
}

test('same issuer name from duplicate exact statements collapses while retaining every anchor', () => {
  const selected = selectIssuerIdentityEvidence(scope, snapshot([
    record('evidence-1', '发行人名称：合成债券有限公司。'),
    record('evidence-2', '发行人全称为“合成债券有限公司”。'),
  ]));
  assert.equal(selected.status, 'needs_review');
  assert.equal(selected.candidates.length, 1);
  assert.equal(selected.candidates[0]?.issuerDisplayName, '合成债券有限公司');
  assert.deepEqual(selected.candidates[0]?.evidence.map(anchor => anchor.sourceRecordId), ['evidence-1', 'evidence-2']);
  assert.equal(selected.candidates[0]?.state, 'needs_review');
  assert.equal('entityId' in selected.candidates[0]!, false);
});

test('different explicit issuer names are retained as a deterministic conflict', () => {
  const records = [record('evidence-2', '发行人为合成乙有限公司。'), record('evidence-1', '发行人：合成甲有限公司。')];
  const first = selectIssuerIdentityEvidence(scope, snapshot(records));
  const second = selectIssuerIdentityEvidence(scope, snapshot([...records].reverse()));
  assert.equal(first.status, 'conflict');
  assert.deepEqual(first, second);
  assert.deepEqual(first.candidates.map(candidate => candidate.issuerDisplayName), ['合成乙有限公司', '合成甲有限公司'].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), 'en')));
  assert.ok(first.candidates.every(candidate => candidate.state === 'needs_review'));
});

test('uncertain records are skipped but certain local anchors survive needs_confirmation', () => {
  const uncertain = record('evidence-1', '发行人：不确定有限公司。', { uncertainty: ['synthetic low confidence'] });
  const certain = record('evidence-2', '发行人：合成确定有限公司。');
  const source = snapshot([uncertain, certain], { response: {
    ...snapshot([]).response, status: 'needs_confirmation',
  } });
  const selected = selectIssuerIdentityEvidence(scope, source);
  assert.equal(selected.status, 'needs_review');
  assert.deepEqual(selected.candidates.map(candidate => candidate.issuerDisplayName), ['合成确定有限公司']);
  assert.deepEqual(selected.candidates[0]?.evidence.map(anchor => anchor.sourceRecordId), ['evidence-2']);
});

test('global parser warning fails closed even when a visible issuer statement exists', () => {
  const parsed = snapshot([record('evidence-1', '发行人：可能不完整有限公司。')]);
  const selected = selectIssuerIdentityEvidence(scope, { ...parsed, response: {
    ...parsed.response, status: 'needs_confirmation', warnings: [{ code: 'OUTPUT_TRUNCATED', message: 'synthetic parser output was truncated' }],
  } });
  assert.equal(selected.status, 'no_candidate');
  assert.equal(selected.reasonCode, 'PARSER_WARNING');
  assert.equal(selected.coverage, 'incomplete');
  assert.deepEqual(selected.warningCodes, ['OUTPUT_TRUNCATED']);
  assert.deepEqual(selected.candidates, []);
});

test('numbered issuer statement survives known DOCX non-body omissions only as incomplete review evidence', () => {
  const parsed = snapshot([
    record('evidence-1', '1、发行人名称：合成债券集团有限公司'),
    record('evidence-2', '1、发行人名称：合成债券集团有限公司'),
  ]);
  const selected = selectIssuerIdentityEvidence(scope, { ...parsed, response: {
    ...parsed.response, status: 'needs_confirmation', warnings: [
      { code: 'DOCX_DRAWINGS', message: 'synthetic omitted drawing content' },
      { code: 'DOCX_AUXILIARY_PARTS', message: 'synthetic omitted header or note content' },
    ],
  } });
  assert.equal(selected.status, 'needs_review');
  assert.equal(selected.reasonCode, 'PARSER_COVERAGE_INCOMPLETE');
  assert.equal(selected.coverage, 'incomplete');
  assert.deepEqual(selected.warningCodes, ['DOCX_AUXILIARY_PARTS', 'DOCX_DRAWINGS']);
  assert.equal(selected.candidates.length, 1);
  assert.deepEqual(selected.candidates[0]?.evidence.map(anchor => anchor.sourceRecordId), ['evidence-1', 'evidence-2']);
  assert.equal(selected.candidates[0]?.state, 'needs_review');
  assert.equal('entityId' in selected.candidates[0]!, false);
});

test('a known non-lossy DOCX revision warning does not discard a certain anchored statement', () => {
  const parsed = snapshot([record('evidence-1', '发行人名称：合成修订有限公司。')]);
  const selected = selectIssuerIdentityEvidence(scope, { ...parsed, response: {
    ...parsed.response, status: 'needs_confirmation',
    warnings: [{ code: 'DOCX_REVISIONS_RESOLVED', message: 'synthetic revisions resolved to effective text' }],
  } });
  assert.equal(selected.status, 'needs_review');
  assert.equal(selected.coverage, 'complete');
  assert.deepEqual(selected.warningCodes, ['DOCX_REVISIONS_RESOLVED']);
  assert.deepEqual(selected.candidates.map(candidate => candidate.issuerDisplayName), ['合成修订有限公司']);
});

test('ordinary company-name statements and uncertain issuer statements do not become candidates', () => {
  const selected = selectIssuerIdentityEvidence(scope, snapshot([
    record('evidence-1', '公司名称：合成甲有限公司。'),
    record('evidence-2', '发行人名称：合成乙有限公司。', { uncertainty: ['synthetic uncertain text'] }),
  ]));
  assert.equal(selected.status, 'no_candidate');
  assert.equal(selected.reasonCode, 'LOCAL_UNCERTAINTY_SKIPPED');
  assert.deepEqual(selected.candidates, []);
});

test('wrong owner, project, material version or snapshot cannot reuse loaded evidence', () => {
  const loaded = snapshot([record('evidence-1', '发行人：合成有限公司。')]);
  assert.throws(() => selectIssuerIdentityEvidence({ ...scope, ownerUserId: 'identity-owner-b' }, loaded), /SNAPSHOT_SCOPE_MISMATCH/);
  assert.throws(() => selectIssuerIdentityEvidence({ ...scope, projectId: 'identity-project-b' }, loaded), /SNAPSHOT_SCOPE_MISMATCH/);
  assert.throws(() => selectIssuerIdentityEvidence({ ...scope, materialVersion: 1 }, loaded), /SNAPSHOT_SCOPE_MISMATCH/);
  assert.throws(() => selectIssuerIdentityEvidence({ ...scope, snapshotId: 'identity-snapshot-b' }, loaded), /SNAPSHOT_SCOPE_MISMATCH/);
});

test('record scope and incomplete snapshots fail closed', () => {
  const wrongRecord = record('evidence-1', '发行人：合成有限公司。', { material_id: 'identity-material-b' });
  assert.throws(() => selectIssuerIdentityEvidence(scope, snapshot([wrongRecord])), /RECORD_SCOPE_MISMATCH/);
  assert.throws(() => selectIssuerIdentityEvidence(scope, snapshot([record('evidence-1', '发行人：合成有限公司。')], {
    evidenceComplete: false,
  })), /SNAPSHOT_INCOMPLETE/);
});

test('issuer marker must directly state one name and ambiguity is not guessed', () => {
  const selected = selectIssuerIdentityEvidence(scope, snapshot([
    record('evidence-1', '发行人主营业务包括债券、融资和投资。'),
    record('evidence-2', '发行人：甲有限公司、乙有限公司。'),
    record('evidence-3', '1、发行人相关项目材料需要核验。'),
  ]));
  assert.equal(selected.status, 'no_candidate');
  assert.deepEqual(selected.candidates, []);
});

test('bare issuer-is descriptive prose is not treated as a legal name assignment', () => {
  const selected = selectIssuerIdentityEvidence(scope, snapshot([
    record('evidence-1', '发行人是经合成地区政府批准设立的国有控股公司。'),
    record('evidence-2', '发行人是国有控股公司，主要从事项目投资。'),
    record('evidence-3', '发行人是合成市政府下属唯一的投融资平台。'),
  ]));
  assert.equal(selected.status, 'no_candidate');
  assert.equal(selected.reasonCode, 'NO_UNAMBIGUOUS_ISSUER_NAME_STATEMENT');
  assert.deepEqual(selected.candidates, []);
});

test('bare issuer-is-a-legal-entity form is accepted only when bounded by a legal suffix', () => {
  const selected = selectIssuerIdentityEvidence(scope, snapshot([
    record('evidence-1', '发行人为合成城市建设投资集团有限公司，注册资本另见附注。'),
    record('evidence-2', '发行人为国有控股公司，主要从事项目投资。'),
  ]));
  assert.equal(selected.status, 'needs_review');
  assert.deepEqual(selected.candidates.map(candidate => candidate.issuerDisplayName), ['合成城市建设投资集团有限公司']);
});
