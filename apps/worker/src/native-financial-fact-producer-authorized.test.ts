import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Pool } from 'pg';
import {
  appendIssuerIdentitySourceRecord,
  authorizeIssuerIdentityReviewer,
  loadVerifiedIssuerIdentitySourceRecord,
  reviewIssuerIdentitySourceRecord,
} from '@bondbuddy/api/issuer-identity-source';
import { verifiedIssuerIdentityBinding } from '@bondbuddy/api/issuer-identity-binding';
import type { DocumentParseRecord, DocumentParseRequest, DocumentParseResponse } from './document-parser.js';
import { produceParsedFactCandidates, type SemanticFactExtractor } from './fact-candidate-producer.js';
import { listFactCandidates } from './fact-repository.js';
import { createNativeFinancialFactExtractor } from './native-financial-fact-extractor.js';
import { persistParseSnapshot } from './parse-evidence-repository.js';
import { isolatedTestDatabase } from './test-database.js';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const manifestPath = join(sourceRoot, 'tests/samples/2026-09-25/manifest.json');
const authorizedParser = process.env.BB_PYTHON?.trim() || 'python3';
const runAuthorized = process.env.BB_RUN_AUTHORIZED_SAMPLE_TESTS === '1';
const parser106Root = process.env.BB_PARSER_106_SOURCE_ROOT?.trim();
if (runAuthorized && !parser106Root) {
  throw new Error('BB_RUN_AUTHORIZED_SAMPLE_TESTS=1 requires BB_PARSER_106_SOURCE_ROOT pointing to the #196 parser 1.0.6 source tree');
}
const testDatabaseUrl = runAuthorized
  ? await isolatedTestDatabase('NATIVE_FINANCIAL_FACT_PRODUCER_TEST_DATABASE_URL')
  : undefined;
if (runAuthorized && !testDatabaseUrl) {
  throw new Error('BB_RUN_AUTHORIZED_SAMPLE_TESTS=1 requires NATIVE_FINANCIAL_FACT_PRODUCER_TEST_DATABASE_URL or BB_TEST_DATABASE_URL pointing to a fresh migrated PostgreSQL 16 template');
}
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const parseResponseHash = (response: DocumentParseResponse): string => {
  const { request_id: _requestId, ...stableResult } = response;
  return sha(canonical(stableResult));
};

type AuthorizedFile = {
  file_id: string;
  path: string;
  original_filename: string;
  upload_role: string;
  media_type: string;
  bytes: number;
  sha256: string;
};
type AuthorizedManifest = { cases: Array<{ case_id: string; files: AuthorizedFile[] }> };
const SUPPORTED_PARSER_VERSIONS = new Set([
  'bondbuddy-document-parser-1.0.3',
  'bondbuddy-document-parser-1.0.5',
  'bondbuddy-document-parser-1.0.6',
]);

test('authorized zq XLSX flows through the native producer into pending PG candidates with owner isolation', {
  skip: !runAuthorized ? 'set BB_RUN_AUTHORIZED_SAMPLE_TESTS=1 to run the authorized PG16 producer integration' : false,
}, async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AuthorizedManifest;
  const sampleCase = manifest.cases.find((item) => item.case_id === 'zq-202312');
  assert.ok(sampleCase, 'authorized zq-202312 case must exist in the checked-in manifest');
  const file = sampleCase.files.find((item) => item.file_id === 'zq-202312-02');
  assert.ok(file, 'manifest must identify the exact authorized financial XLSX');
  assert.equal(file.upload_role, 'financial');
  assert.equal(file.media_type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  const filePath = resolve(sourceRoot, 'tests/samples/2026-09-25', file.path);
  const bytes = await readFile(filePath);
  assert.equal(bytes.byteLength, file.bytes, 'authorized sample byte count must match its manifest');
  const contentHash = sha(bytes);
  assert.equal(contentHash, file.sha256, 'authorized sample SHA-256 must match its manifest');

  const parseRequest: DocumentParseRequest = {
    schema_version: 'document-parse-request-v1',
    request_id: `authorized-zq-${randomUUID()}`,
    material: {
      material_id: file.file_id,
      material_version: 1,
      media_type: file.media_type as DocumentParseRequest['material']['media_type'],
      sha256: contentHash,
      authorized_local_path: filePath,
    },
    options: {},
  };
  const python = spawnSync(authorizedParser, ['-m', 'bondbuddy_document_parser'], {
    cwd: parser106Root!,
    env: { ...process.env, PYTHONPATH: join(parser106Root!, 'python') },
    input: JSON.stringify(parseRequest),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.ifError(python.error);
  assert.equal(python.status, 0, `Python 1.0.6 parser failed: ${python.stderr}`);
  const parsed = JSON.parse(python.stdout) as DocumentParseResponse;
  assert.equal(parsed.schema_version, 'document-parse-response-v1');
  assert.equal(parsed.request_id, parseRequest.request_id,
    'Python response must stay bound to the request sent across the Node bridge');
  assert.ok(SUPPORTED_PARSER_VERSIONS.has(parsed.parser_version),
    `authorized mapper supports only verified parser versions, received ${parsed.parser_version}`);
  assert.equal(parsed.parser_version, 'bondbuddy-document-parser-1.0.6',
    'PG opt-in must execute the explicit #196 parser 1.0.6 source tree');
  assert.equal(parsed.status, 'parsed');
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.document.worksheet_count, 8);
  assert.equal(parsed.document.missing_formula_results, 0);
  assert.equal(parsed.document.cached_formula_results, 0);
  assert.equal(parsed.records.length, 1392);
  assert.ok(parsed.material);

  const pool = new Pool({ connectionString: testDatabaseUrl });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const owner = `zq-fact-owner-${suffix}`;
  const foreignOwner = `zq-fact-foreign-${suffix}`;
  const reviewerId = `zq-fact-reviewer-${suffix}`;
  const grantorId = `zq-fact-grantor-${suffix}`;
  const projectId = `zq-fact-project-${suffix}`;
  const uploadId = `zq-fact-upload-${suffix}`;
  const reviewerGrantId = `zq-fact-grant-${suffix}`;
  const inputHash = sha(`synthetic input revision bound to authorized zq sample ${suffix}`);
  const requestId = parseRequest.request_id;
  const snapshotId = `zq-snapshot-${suffix}`;

  try {
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2),($3,$4),($5,$6),($7,$8)', [
      owner, `zqfactowner${suffix}`,
      foreignOwner, `zqfactforeign${suffix}`,
      reviewerId, `zqfactreviewer${suffix}`,
      grantorId, `zqfactgrantor${suffix}`,
    ]);
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Authorized zq PG producer test','update')",
      [projectId, owner]);
    await pool.query(`INSERT INTO bb_uploads
      (id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state,received_sha256,received_bytes)
      VALUES($1,$2,$3,$4,$5,$6,$7,'financial',$8,now()+interval '1 hour','completed',$7,$6)`,
    [uploadId, owner, projectId, file.original_filename, file.media_type, file.bytes, contentHash,
      `synthetic-test/${uploadId}`]);
    await pool.query(`INSERT INTO bb_material_versions
      (id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'financial',$5,$6,$7,$8,$9,'parsed')`,
    [file.file_id, owner, projectId, uploadId, file.original_filename, file.media_type, file.bytes, contentHash,
      `synthetic-test/material/${file.file_id}`]);

    const savedSnapshot = await persistParseSnapshot({ pool, newId: () => snapshotId }, {
      ownerUserId: owner, projectId, materialId: file.file_id, materialVersion: 1, requestId,
    }, { mediaType: file.media_type as DocumentParseRequest['material']['media_type'], sha256: contentHash },
    parsed);
    assert.equal(savedSnapshot.parserVersion, 'bondbuddy-document-parser-1.0.6');
    assert.equal(savedSnapshot.response.parser_version, parsed.parser_version);
    assert.equal(savedSnapshot.responseSha256, parseResponseHash(parsed),
      'PostgreSQL snapshot hash must cover the complete Python response, including cached_formula_results');
    assert.deepEqual(savedSnapshot.response, parsed,
      'PostgreSQL snapshot must round-trip the full Python response without projecting schema 1.0.6 fields');
    assert.deepEqual(savedSnapshot.evidence, parsed.records,
      'PostgreSQL evidence rows must round-trip every response record in order');
    assert.equal(savedSnapshot.evidence.length, 1392);

    const issuerEvidence = parsed.records.find((record) => record.literal_quote.includes('济南章丘控股集团有限公司'));
    assert.ok(issuerEvidence, 'issuer identity test fixture must point to an actual workbook cell quote');
    await pool.query(`INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code)
      VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_test')`, [reviewerGrantId, reviewerId, grantorId]);
    const reviewer = await authorizeIssuerIdentityReviewer(pool, reviewerId);
    assert.ok(reviewer, 'synthetic fixture reviewer grant must authorize the repository review call');
    const observation = await appendIssuerIdentitySourceRecord({ pool }, {
      ownerUserId: owner, projectId, materialId: file.file_id, materialVersion: 1,
      requestId: `zq-identity-${suffix}`, sourceRecordId: issuerEvidence.record_id,
      issuerDisplayName: '济南章丘控股集团有限公司', entityId: `synthetic-issuer-${suffix}`,
    });
    await reviewIssuerIdentitySourceRecord({ pool }, {
      ownerUserId: owner, projectId, materialId: file.file_id, materialVersion: 1,
      sourceRecordRowId: observation.id, reviewer, decision: 'verified', reasonCode: 'synthetic_test_fixture',
    });
    const verifiedIdentity = await loadVerifiedIssuerIdentitySourceRecord(pool, {
      ownerUserId: owner, projectId, materialId: file.file_id, materialVersion: 1,
    });
    assert.ok(verifiedIdentity);
    const inputManifest = {
      issuer_identity: verifiedIssuerIdentityBinding(verifiedIdentity),
      issuer_entity_id: verifiedIdentity.entityId,
      materials: [{ material_id: file.file_id, material_version: 1, role: 'financial', sha256: contentHash }],
    };
    await pool.query(`INSERT INTO bb_input_revisions
      (project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,$4::jsonb,$5::jsonb,'[]'::jsonb)`, [
      projectId, owner, inputHash, JSON.stringify(inputManifest),
      JSON.stringify([{ material_id: file.file_id, material_version: 1 }]),
    ]);

    const nativeExtractor = createNativeFinancialFactExtractor(async () => ({ status: parsed.status, warnings: parsed.warnings }));
    const context = {
      ownerUserId: owner, projectId, inputRevision: 1, inputHash,
      materialId: file.file_id, materialVersion: 1, snapshotId,
    };
    const dependencies = { pool, extractor: nativeExtractor };

    const ambiguousRecords = [...parsed.records, {
      ...parsed.records.find((record) => record.locator_type === 'xlsx_cell' && record.locator.sheet === '合并利润表' && record.locator.cell === 'C5')!,
      record_id: `ambiguous-value-${suffix}`,
    } satisfies DocumentParseRecord];
    const ambiguous = await createNativeFinancialFactExtractor(async () => ({ status: parsed.status, warnings: parsed.warnings }))
      .extract({
        schema_version: 'semantic-fact-extraction-request-v1', owner_user_id: owner, project_id: projectId,
        input_revision: 1, input_hash: inputHash, issuer_identity_record_id: verifiedIdentity.recordId,
        issuer_identity_version: verifiedIdentity.version, issuer_identity_hash: verifiedIdentity.contentHash,
        entity_id: verifiedIdentity.entityId, material_id: file.file_id, material_version: 1,
        material_sha256: contentHash, parse_snapshot_id: snapshotId, parse_response_sha256: savedSnapshot.responseSha256,
        parser_version: parsed.parser_version, records: ambiguousRecords,
      });
    assert.equal(ambiguous.facts.length, 0);
    assert.equal(ambiguous.needs_review[0]?.reason_code, 'FINANCIAL_VALUE_DUPLICATE');

    const unanchoredExtractor: SemanticFactExtractor = {
      ...nativeExtractor,
      async extract(request) {
        const result = await nativeExtractor.extract(request);
        assert.equal(result.facts.length, 1);
        return { ...result, facts: [{ ...result.facts[0]!, evidence_refs: [`not-in-snapshot-${suffix}`] }] };
      },
    };
    await assert.rejects(produceParsedFactCandidates({ pool, extractor: unanchoredExtractor }, context),
      /FACT_EXTRACTION_FACT_INVALID/);

    const produced = await produceParsedFactCandidates(dependencies, context);
    assert.equal(produced.inserted.length, 1);
    assert.equal(produced.replayed.length, 0);
    assert.equal(produced.needsReview.length, 0);
    const stored = produced.inserted[0]!;
    assert.equal(stored.candidate.source.kind, 'external');
    assert.equal(stored.candidate.identity.metric, 'operating_revenue');
    assert.notEqual(stored.candidate.identity.metric, 'main_business_revenue');
    assert.equal(stored.candidate.value.kind, 'known');
    if (stored.candidate.value.kind === 'known') assert.equal(stored.candidate.value.decimalOrText, '3894631419.08');
    assert.deepEqual(stored.candidate.identity.period, { start: '2023-01-01', end: '2023-12-31' });
    assert.equal(stored.candidate.identity.scope, 'consolidated');
    assert.equal(stored.candidate.identity.currency, 'CNY');
    assert.equal(stored.candidate.identity.unit, 'yuan');
    assert.equal(stored.candidate.identity.basis, 'reported_financial_statement');
    assert.equal(stored.candidate.auditCheck, null);
    assert.equal(stored.provenance.status, 'needs_confirmation');
    assert.ok(stored.candidate.uncertainty?.includes('SOURCE_CONFIDENCE_MISSING'));
    assert.deepEqual(stored.provenance.evidence.map((anchor) => anchor.locator.cell), ['A1', 'B2', 'C2', 'E2', 'C3', 'A5', 'C5']);
    assert.deepEqual(stored.provenance.evidence.map((anchor) => anchor.literal_quote), [
      '合并利润表', '口径：合并口径', '期间：2023年度、2022年度、2021年度', '金额单位：人民币元',
      '2023年度', '其中：营业收入', '3894631419.08',
    ]);
    assert.ok(stored.provenance.evidence.every((anchor) => anchor.material_id === file.file_id &&
      anchor.material_version === 1 && anchor.content_hash === contentHash && anchor.confidence === null));

    const replay = await produceParsedFactCandidates(dependencies, context);
    assert.equal(replay.inserted.length, 0);
    assert.equal(replay.replayed.length, 1);
    assert.equal(replay.replayed[0]?.candidate.candidateId, stored.candidate.candidateId);
    const ownerCandidates = await listFactCandidates({ pool }, { ownerUserId: owner, projectId });
    const foreignCandidates = await listFactCandidates({ pool }, { ownerUserId: foreignOwner, projectId });
    assert.equal(ownerCandidates.length, 1);
    assert.equal(foreignCandidates.length, 0);
    await assert.rejects(produceParsedFactCandidates({ pool, extractor: nativeExtractor }, {
      ...context, ownerUserId: foreignOwner,
    }), /FACT_EXTRACTION_INPUT_REVISION_MISMATCH/);

    const artifacts = await pool.query('SELECT count(*)::int AS count FROM bb_artifact_versions WHERE owner_user_id=$1 AND run_id IN (SELECT id FROM bb_runs WHERE project_id=$2)',
      [owner, projectId]);
    assert.equal(artifacts.rows[0]?.count, 0, 'fact extraction must not create or copy any customer-facing output artifact');
  } finally {
    await pool.end();
  }
});
