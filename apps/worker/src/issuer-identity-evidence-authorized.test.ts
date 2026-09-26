import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { DocumentParseRequest, DocumentParseResponse } from './document-parser.js';
import { runDocumentParser } from './document-parser.js';
import type { StoredParseSnapshot } from './parse-evidence-repository.js';
import { selectIssuerIdentityEvidence } from './issuer-identity-evidence-selector.js';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { appendIssuerIdentitySourceRecord, loadVerifiedIssuerIdentitySourceRecord } from '@bondbuddy/api/issuer-identity-source';
import { createIssuerIdentityProducer } from './issuer-identity-producer.js';
import { persistParseSnapshot } from './parse-evidence-repository.js';
import { isolatedTestDatabase } from './test-database.js';

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
const authorizedDatabase = authorizedOptIn ? await isolatedTestDatabase('BB_TEST_AUTHORIZED_IDENTITY_DATABASE_URL') : undefined;

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
  const produced = await createIssuerIdentityProducer({} as Pool, { loadSnapshot: async () => snapshot })(
    { ...scope, materialSha256: contentHash, evidence: expectedAnchorIds.map(recordId => ({ recordId,
      recordSha256: 'a'.repeat(64), locatorType: 'docx_block' })) });
  assert.deepEqual(produced.map(item => item.sourceRecordId), expectedAnchorIds);
  assert.equal(new Set(produced.map(item => item.requestId)).size, 2);

  assert.ok(authorizedDatabase, 'authorized persistence regression requires a migrated test database');
  const pool = new Pool({ connectionString: authorizedDatabase });
  const owner = scope.ownerUserId, reviewer = 'authorized-identity-reviewer', grantor = 'authorized-identity-grantor';
  const projectId = scope.projectId, materialId = scope.materialId;
  let principal = owner;
  const app = createServer({ pool, allowedOrigin: 'http://bondbuddy.test',
    principal: async () => ({ userId: principal, csrfVerified: true }) });
  try {
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2),($3,$4),($5,$6)',
      [owner, 'authorizedidentityowner', reviewer, 'authorizedidentityreviewer', grantor, 'authorizedidentitygrantor']);
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Authorized identity regression','update')", [projectId, owner]);
    const uploadId = 'authorized-identity-upload';
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state,received_sha256,received_bytes)
      VALUES($1,$2,$3,'authorized.docx',$4,$5,$6,'historical',$7,now()+interval '1 hour','completed',$6,$5)`,
    [uploadId, owner, projectId, file.media_type, bytes.length, contentHash, 'authorized/identity-upload']);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'historical','authorized.docx',$5,$6,$7,$8,'parsed')`,
    [materialId, owner, projectId, uploadId, file.media_type, bytes.length, contentHash, 'authorized/identity-material']);
    let idCalls = 0;
    const saved = await persistParseSnapshot({ pool, newId: () => idCalls++ === 0 ? scope.snapshotId : randomUUID() },
      { ownerUserId: owner, projectId, materialId, materialVersion: 1, requestId: request.request_id },
      { mediaType: file.media_type as DocumentParseRequest['material']['media_type'], sha256: contentHash }, response);
    const records = await pool.query(`SELECT record_id, record_sha256, locator_type FROM bb_parse_evidence
      WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=1 AND snapshot_id=$4 AND uncertainty='[]'::jsonb`,
    [owner, projectId, materialId, saved.snapshotId]);
    const candidates = await createIssuerIdentityProducer(pool)({ ...scope, snapshotId: saved.snapshotId,
      materialSha256: contentHash, evidence: records.rows.map(row => ({ recordId: String(row.record_id),
        recordSha256: String(row.record_sha256).trim(), locatorType: String(row.locator_type) })) });
    assert.deepEqual(candidates.map(item => item.sourceRecordId), expectedAnchorIds);
    for (const item of candidates) await appendIssuerIdentitySourceRecord({ pool }, { ...scope,
      requestId: item.requestId!, observationId: item.observationId, sourceRecordId: item.sourceRecordId,
      issuerDisplayName: item.issuerDisplayName, entityId: item.entityId });
    const url = `/api/v1/projects/${projectId}/materials/${materialId}/versions/1/issuer-identity/observations`;
    const send = (method: 'GET' | 'POST', path: string, payload?: unknown) => app.inject({ method, url: path,
      headers: { origin: 'http://bondbuddy.test' }, payload: payload as never });
    const pending = await send('GET', url);
    assert.equal(pending.statusCode, 200, pending.body);
    assert.deepEqual(pending.json().items.map((item: { evidence_record_id: string }) => item.evidence_record_id), expectedAnchorIds);
    assert.ok(pending.json().items.every((item: { status: string }) => item.status === 'needs_review'));
    await pool.query(`INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code,authorization_basis)
      VALUES($1,$2,'issuer_identity_reviewer',$3,'authorized_test','authorized regression')`, [randomUUID(), reviewer, grantor]);
    principal = reviewer;
    const reviewedId = 'uscc:91310000MA1FL00008';
    for (const item of pending.json().items as { source_record_id: string }[]) {
      const reviewed = await send('POST', `${url}/${item.source_record_id}/review`, { decision: 'verified', reason_code: 'source_checked',
        verified_entity_id: reviewedId, entity_basis_kind: 'uscc', entity_basis_ref: reviewedId.slice(5) });
      assert.equal(reviewed.statusCode, 201, reviewed.body);
    }
    principal = owner;
    assert.equal((await send('GET', url)).json().status, 'verified');
    assert.equal((await loadVerifiedIssuerIdentitySourceRecord(pool, scope))?.entityId, reviewedId);
  } finally { await app.close(); await pool.end(); }
  assert.equal(sha256(await readFile(samplePath)), file.sha256, 'the authorized original must remain unchanged after parsing');
});
