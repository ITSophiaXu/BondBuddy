import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { DocumentParseRequest, DocumentParseResponse } from './document-parser.js';
import { runDocumentParser } from './document-parser.js';
import type { StoredParseSnapshot } from './parse-evidence-repository.js';
import { selectIssuerIdentityEvidence } from './issuer-identity-evidence-selector.js';

type AuthorizedFile = {
  file_id: string;
  path: string;
  upload_role: string;
  media_type: string;
  bytes: number;
  sha256: string;
};
type AuthorizedManifest = { cases: Array<{ case_id: string; files: AuthorizedFile[] }> };

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const localPython = join(sourceRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const parserPython = process.env.BB_PYTHON?.trim() || (existsSync(localPython)
  ? localPython
  : process.platform === 'win32' ? 'python' : 'python3');
const parser106Root = process.env.BB_PARSER_106_SOURCE_ROOT?.trim() || sourceRoot;
const authorizedOptIn = process.env.BB_RUN_AUTHORIZED_SAMPLE_TESTS === '1';

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

function displayNameFromAnchor(quote: string): string | null {
  const match = /(?:发行人(?:法定)?(?:名称|全称)\s*(?:(?:为|是)\s*[:：]?|[:：])|发行人\s*[:：]|发行人\s*为)\s*["“「『]?([^"”」』，,。；;\r\n]+)/u.exec(quote);
  return match?.[1]?.trim().replace(/["”」』]$/u, '').trim() || null;
}

// Opt in with BB_RUN_AUTHORIZED_SAMPLE_TESTS=1. BB_PYTHON and
// BB_PARSER_106_SOURCE_ROOT follow the existing authorized bridge test conventions.
test('authorized rq-202506 DOCX keeps issuer identity selection review-only under parser 1.0.6 coverage warnings', {
  skip: authorizedOptIn ? false : 'set BB_RUN_AUTHORIZED_SAMPLE_TESTS=1 to parse this authorized real sample',
}, async () => {
  const manifestPath = join(sourceRoot, 'tests/samples/2026-09-25/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AuthorizedManifest;
  const sampleCase = manifest.cases.find((entry) => entry.case_id === 'rq-202506');
  assert.ok(sampleCase, 'authorized rq-202506 case must exist in the registered manifest');
  const file = sampleCase.files.find((entry) => entry.file_id === 'rq-202506-01');
  assert.ok(file, 'manifest must identify the exact authorized historical DOCX');
  assert.equal(file.upload_role, 'historical');
  assert.equal(file.media_type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

  const samplePath = resolve(sourceRoot, 'tests/samples/2026-09-25', file.path);
  const bytes = await readFile(samplePath);
  assert.equal(bytes.byteLength, file.bytes, 'authorized sample byte size must match its manifest');
  const contentHash = sha256(bytes);
  assert.equal(contentHash, file.sha256, 'authorized sample SHA-256 must match its manifest');

  const scope = {
    ownerUserId: 'authorized-identity-regression-owner',
    projectId: 'authorized-identity-regression-project',
    materialId: file.file_id,
    materialVersion: 1,
    snapshotId: 'authorized-identity-regression-snapshot',
  };
  const request: DocumentParseRequest = {
    schema_version: 'document-parse-request-v1',
    request_id: 'authorized-identity-regression-parse',
    material: {
      material_id: scope.materialId,
      material_version: scope.materialVersion,
      media_type: file.media_type as DocumentParseRequest['material']['media_type'],
      sha256: contentHash,
      authorized_local_path: samplePath,
    },
    options: {},
  };
  const response = await runDocumentParser(request, {
    pythonExecutable: parserPython,
    repoRoot: parser106Root,
  });

  assert.equal(response.parser_version, 'bondbuddy-document-parser-1.0.6');
  assert.equal(response.status, 'needs_confirmation');
  assert.equal(response.records.length, 9970, 'parser 1.0.6 must return the complete baseline record set');
  assert.deepEqual(response.warnings.map(warning => warning.code).sort(), ['DOCX_AUXILIARY_PARTS', 'DOCX_DRAWINGS']);
  assert.ok(response.material);

  const { request_id: _requestId, ...stableResponse } = response;
  const snapshot: StoredParseSnapshot = {
    ...scope,
    contentSha256: contentHash,
    parserVersion: response.parser_version,
    requestId: request.request_id,
    requestHash: sha256(canonical({
      schema_version: request.schema_version,
      material: {
        material_id: request.material.material_id,
        material_version: request.material.material_version,
        media_type: request.material.media_type,
        sha256: request.material.sha256,
      },
      options: request.options,
      parser_version: response.parser_version,
    })),
    requestOptions: request.options,
    responseSha256: sha256(canonical(stableResponse)),
    response,
    evidence: response.records,
    evidenceComplete: true,
    evidenceRecordCount: response.records.length,
    createdAt: '2026-09-26T00:00:00.000Z',
    replayed: false,
  };
  // This in-memory snapshot exercises selector logic only; it does not persist to PostgreSQL.
  const selected = selectIssuerIdentityEvidence(scope, snapshot);

  assert.equal(selected.status, 'needs_review');
  assert.equal(selected.coverage, 'incomplete');
  assert.deepEqual(selected.warningCodes, ['DOCX_AUXILIARY_PARTS', 'DOCX_DRAWINGS']);
  assert.equal(selected.candidates.length, 1);
  const candidate = selected.candidates[0]!;
  assert.equal(candidate.state, 'needs_review');
  assert.equal('entityId' in candidate, false);

  const expectedAnchorIds = ['evidence-000306', 'evidence-000428'];
  assert.deepEqual(candidate.evidence.map(anchor => anchor.sourceRecordId), expectedAnchorIds);
  const sourceById = new Map(response.records.map(record => [record.record_id, record]));
  for (const anchor of candidate.evidence) {
    const source = sourceById.get(anchor.sourceRecordId);
    assert.ok(source, 'selected source anchor must resolve to the parser response');
    assert.equal(anchor.sourceQuote, source.literal_quote);
    assert.deepEqual(anchor.sourceLocator, source.locator);
    assert.equal(anchor.sourceLocatorType, 'docx_block');
    assert.equal('page' in anchor.sourceLocator, false, 'DOCX evidence must not gain a fabricated static page');
  }
  const derivedDisplayName = displayNameFromAnchor(candidate.evidence[0]!.sourceQuote);
  assert.ok(derivedDisplayName, 'the exact source anchor must state a display name');
  assert.equal(candidate.issuerDisplayName, derivedDisplayName,
    'review display must be text derived from the exact parser anchor');
  assert.equal(sha256(await readFile(samplePath)), file.sha256, 'the authorized original must remain unchanged after parsing');
});
