import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { canonicalTargetPeriodCandidateSnapshotContent, validTargetPeriodCandidateSnapshot } from '@bondbuddy/contracts';
import { runDocumentParser, type DocumentParseRequest } from './document-parser.js';
import { buildTargetPeriodCandidateSnapshot } from './target-period-candidate-snapshot-builder.js';
import { proposeTargetReportingPeriods, type NativePeriodEvidenceSnapshot } from './target-period-candidates.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sampleRoot = join(repositoryRoot, 'tests/samples/2026-09-25');
const pythonExecutable = process.env.BB_PYTHON?.trim() || join(repositoryRoot, '.venv', 'bin', 'python');
const optedIn = process.env.BB_RUN_AUTHORIZED_RQ202509_TARGET_PERIOD_CANDIDATES === '1';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FILE_ID = 'rq-202509-02';
const EXPECTED_BYTES = 424_900;
const EXPECTED_SHA256 = 'c11db9a211c7e8c21efc5aab6a8e503b3817aa78f3d184cfe5d077b0a32826c2';
const PARSER_VERSION = 'bondbuddy-document-parser-1.0.7';
const REPORTING_CUTOFF = '2025-09-30'; // Target intent only; manifest target_reporting_periods are never passed to recognition.

type ManifestFile = {
  readonly file_id: string;
  readonly path: string;
  readonly upload_role: string;
  readonly media_type: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly evidence: readonly { readonly locator: string; readonly quote: string }[];
  readonly worksheets: readonly { readonly name: string; readonly state: string }[];
};
type Manifest = { readonly cases: readonly { readonly case_id: string; readonly files: readonly ManifestFile[] }[] };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('UNSERIALIZABLE_PARSE_EVIDENCE');
  return encoded;
}
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

test('authorized rq-202509 interim XLSX yields only traceable pending target-period candidates', {
  skip: optedIn ? false : 'set BB_RUN_AUTHORIZED_RQ202509_TARGET_PERIOD_CANDIDATES=1 to parse the authorized XLSX locally',
}, async () => {
  // Guard visible financial headers and exclusion of hidden auxiliary periods.
  // Keep this authorized-sample check opt-in; never synthesize rows to satisfy it.
  const manifest = JSON.parse(await readFile(join(sampleRoot, 'manifest.json'), 'utf8')) as Manifest;
  const registered = manifest.cases.find(item => item.case_id === 'rq-202509')?.files.find(item => item.file_id === FILE_ID);
  assert.ok(registered, 'the test source must be registered in the authorized sample manifest');
  assert.deepEqual([registered.upload_role, registered.media_type, registered.bytes, registered.sha256],
    ['interimFinancial', XLSX, EXPECTED_BYTES, EXPECTED_SHA256]);
  assert.equal(registered.worksheets.filter(sheet => sheet.state === 'hidden').length, 7,
    'the registered workbook contains hidden auxiliary worksheets');

  const sourcePath = resolve(sampleRoot, registered.path);
  const relativeSource = relative(resolve(sampleRoot), sourcePath);
  assert.ok(relativeSource.length > 0 && relativeSource !== '..' &&
    !relativeSource.startsWith(`..${sep}`) && !isAbsolute(relativeSource),
  'manifest source path stays inside the authorized sample directory on Windows and POSIX');
  const sourceBytes = await readFile(sourcePath);
  assert.deepEqual([sourceBytes.byteLength, sha256(sourceBytes)], [EXPECTED_BYTES, EXPECTED_SHA256],
    'source bytes match the registered size and SHA-256 before parsing');

  const request: DocumentParseRequest = {
    schema_version: 'document-parse-request-v1',
    request_id: 'authorized-rq202509-target-periods',
    material: {
      material_id: FILE_ID,
      material_version: 1,
      media_type: XLSX,
      sha256: EXPECTED_SHA256,
      authorized_local_path: sourcePath,
    },
    options: {},
  };
  const parsed = await runDocumentParser(request, { pythonExecutable, repoRoot: repositoryRoot, maxOutputBytes: 32 * 1024 * 1024 });
  assert.equal(parsed.parser_version, PARSER_VERSION);
  assert.equal(parsed.status, 'needs_confirmation');
  assert.equal(parsed.records.length, 22_014);
  assert.equal(parsed.document.worksheet_count, 15);
  assert.equal(parsed.document.cached_formula_results, 3_821);
  assert.equal(parsed.records.filter(record => record.uncertainty.includes('formula_cached_result_unverified')).length, 3_821);

  // Compare parser output to registered source anchors after parsing. Manifest target periods are not input to recognition.
  for (const sourceAnchor of registered.evidence) {
    const [sheet, cell] = sourceAnchor.locator.split('!');
    const matched = parsed.records.find(record => record.locator.sheet === sheet && record.locator.cell === cell);
    assert.ok(matched && matched.literal_quote.trim() === sourceAnchor.quote.trim(),
      'the parsed financial header record must independently match its registered source-cell anchor');
  }
  const visibleFinancialHeader = parsed.records.find(record => {
    const sheet = registered.worksheets.find(item => item.name === record.locator.sheet);
    return sheet?.state === 'visible' && /资产负债表|利润表|现金流量表/.test(String(record.locator.sheet));
  });
  assert.ok(visibleFinancialHeader, 'native evidence includes a record from a visible financial statement worksheet');

  const { request_id: _requestId, ...stableResponse } = parsed;
  const responseSha256 = sha256(canonical(stableResponse));
  const snapshotId = `authorized-rq202509-${responseSha256.slice(0, 24)}`;
  const snapshot: NativePeriodEvidenceSnapshot = {
    method: 'native_text',
    snapshot_id: snapshotId,
    response_sha256: responseSha256,
    material_id: FILE_ID,
    material_version: 1,
    material_sha256: EXPECTED_SHA256,
    media_type: XLSX,
    parser_version: parsed.parser_version,
    status: parsed.status,
    warnings: parsed.warnings,
    records: parsed.records.map(record => ({ ...record, record_sha256: sha256(canonical(record)) })),
  };
  const result = proposeTargetReportingPeriods({
    reporting_cutoff: REPORTING_CUTOFF,
    locked_materials: [{ material_id: FILE_ID, material_version: 1, material_sha256: EXPECTED_SHA256, role: registered.upload_role }],
    snapshots: [snapshot],
  });

  console.log(`authorized rq-202509 recognized candidates: ${JSON.stringify(result.candidates.map(candidate => ({
    end: candidate.end,
    status: candidate.status,
    anchor_sheets: [...new Set(candidate.anchors.map(anchor => anchor.evidence.locator?.sheet ?? 'unknown'))].sort(),
  })))}; cutoff=${REPORTING_CUTOFF}`);

  assert.equal(result.status, 'needs_confirmation');
  assert.equal(result.completeness, 'not_determined');
  assert.equal(result.reporting_cutoff, REPORTING_CUTOFF);
  assert.ok(result.source_snapshot_pins.some(pin => pin.snapshot_id === snapshotId &&
    pin.material_id === FILE_ID && pin.material_sha256 === EXPECTED_SHA256 && pin.response_sha256 === responseSha256 &&
    pin.evidence_records.length === parsed.records.length));
  assert.ok(result.candidates.every(candidate => candidate.status === 'needs_confirmation'),
    'parser-derived periods never become confirmed target periods');
  const candidateSnapshot = buildTargetPeriodCandidateSnapshot({
    candidate_set: result,
    candidate_set_id: 'authorized-rq202509-candidates', candidate_set_version: 1,
    // Test-only identity and empty requirement-set pin; no production project or review is asserted.
    owner_user_id: 'authorized-sample-test-owner', project_id: 'authorized-sample-test-project',
    project_draft_revision: 1, reporting_cutoff: REPORTING_CUTOFF,
    locked_materials: [{ material_id: FILE_ID, material_version: 1, material_sha256: EXPECTED_SHA256, role: registered.upload_role }],
    supplemental_requirements: { version: 1, content_sha256: sha256('[]'), message_ids: [] },
  });
  assert.equal(validTargetPeriodCandidateSnapshot(candidateSnapshot), true);
  assert.equal(candidateSnapshot.content.source_snapshots[0]?.record_pins.length, parsed.records.length,
    'the versioned handoff pins every parse record, including a workbook with more than 20,000 records');
  assert.equal(candidateSnapshot.content_sha256, sha256(canonicalTargetPeriodCandidateSnapshotContent(candidateSnapshot)));
  assert.ok(candidateSnapshot.content.candidates.every(candidate => candidate.status === 'needs_confirmation'));
  assert.ok(result.candidates.every(candidate => candidate.evidence.every(ref => ref.material_id === FILE_ID &&
    ref.material_version === 1 && ref.material_sha256 === EXPECTED_SHA256 && ref.snapshot_id === snapshotId &&
    ref.response_sha256 === responseSha256 && /^[a-f0-9]{64}$/.test(ref.record_sha256) &&
    parsed.records.some(record => record.record_id === ref.record_id && sha256(canonical(record)) === ref.record_sha256))),
  'each proposal anchor remains traceable to an exact parsed record and immutable source/snapshot hashes');
  const q3 = result.candidates.find(candidate => candidate.end === REPORTING_CUTOFF);
  const q3Header = registered.evidence.find(anchor => anchor.locator === '02合并利润表!B3');
  assert.ok(q3Header, 'manifest registers the visible current-period profit-statement header anchor');
  const q3HeaderRecord = parsed.records.find(record => record.locator.sheet === '02合并利润表' && record.locator.cell === 'B3');
  assert.ok(q3HeaderRecord && q3HeaderRecord.literal_quote.trim() === q3Header.quote.trim(),
    'the current-period header must match its exact parsed source-cell evidence');
  assert.ok(q3, 'visible current-period statement header should produce a cutoff-related pending candidate');
  assert.equal(q3.status, 'needs_confirmation');
  assert.ok(q3.anchors.some(anchor => anchor.kind === 'table_header' && anchor.evidence.material_id === FILE_ID &&
    anchor.evidence.material_sha256 === EXPECTED_SHA256 && anchor.evidence.locator !== null &&
    anchor.evidence.record_id === q3HeaderRecord.record_id),
  'a cutoff-related candidate must retain the exact current-period financial table-header anchor');
  assert.ok(result.candidates.every(candidate => candidate.anchors.every(anchor => {
    const record = parsed.records.find(item => item.record_id === anchor.evidence.record_id);
    return record !== undefined && registered.worksheets.find(sheet => sheet.name === record.locator.sheet)?.state === 'visible';
  })), 'hidden auxiliary worksheets cannot become reporting-period candidate anchors');

  const comparison = result.candidates.find(candidate => candidate.end === '2024-09-30');
  if (comparison) {
    assert.equal(comparison.status, 'needs_confirmation', 'the comparative period is not promoted to a target period');
    assert.ok(comparison.evidence.every(ref => ref.material_sha256 === EXPECTED_SHA256));
  }

  console.log(`authorized rq-202509 period candidates: records=${parsed.records.length}, cutoff_related=${q3 ? 'present_pending' : 'pending_no_exact_candidate'}, comparison=${comparison ? 'present_pending' : 'not_proposed'}, completeness=${result.completeness}`);

  const unchangedBytes = await readFile(sourcePath);
  assert.equal(sha256(unchangedBytes), EXPECTED_SHA256, 'the authorized source file remains byte-for-byte unchanged');
});
