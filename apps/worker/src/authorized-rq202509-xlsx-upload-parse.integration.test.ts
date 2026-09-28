import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BlobServiceClient } from '@azure/storage-blob';
import { Pool } from 'pg';
import { emptyUpdateDetails } from '@bondbuddy/contracts';
import { createServer } from '@bondbuddy/api';
import { azureBlobs } from '@bondbuddy/api/data';
import { documentParserVersion } from '@bondbuddy/api/material-jobs';
import { appendIssuerIdentitySourceRecord, authorizeIssuerIdentityReviewer, loadVerifiedIssuerIdentitySourceRecord,
  reviewIssuerIdentitySourceRecord } from '@bondbuddy/api/issuer-identity-source';
import { verifiedIssuerIdentityBinding } from '@bondbuddy/api/issuer-identity-binding';
import { runDocumentParser } from './document-parser.js';
import { runMaterialParseOnce } from './material-parse-job.js';
import { createControlledNativeFactCandidateProducer } from './controlled-native-fact-candidate-producer.js';
import { listFactCandidates } from './fact-repository.js';
import { isolatedTestDatabase } from './test-database.js';
import { produceTargetPeriodCandidateSnapshot } from './target-period-candidate-snapshot-producer.js';

type ManifestEvidence = { readonly locator: string; readonly quote: string };
type ManifestFile = {
  readonly file_id: string;
  readonly path: string;
  readonly original_filename: string;
  readonly upload_role: string;
  readonly media_type: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly evidence: readonly ManifestEvidence[];
};
type Manifest = { readonly cases: readonly { readonly case_id: string; readonly files: readonly ManifestFile[] }[] };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const manifestRoot = join(repoRoot, 'tests/samples/2026-09-25');
const localPython = join(repoRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const pythonExecutable = process.env.BB_PYTHON?.trim() || (existsSync(localPython)
  ? localPython : process.platform === 'win32' ? 'python' : 'python3');
const optedIn = process.env.BB_RUN_AUTHORIZED_RQ202509_XLSX_UPLOAD_PARSE === '1';
const producerOptedIn = process.env.BB_RUN_ISSUE76_RQ202509_CANDIDATE_PG === '1';
const databaseUrl = optedIn || producerOptedIn
  ? await isolatedTestDatabase('AUTHORIZED_RQ202509_XLSX_UPLOAD_PARSE_TEST_DATABASE_URL') : undefined;
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const origin = 'http://bondbuddy.test';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FILE_ID = 'rq-202509-02';
const EXPECTED_BYTES = 424_900;
const EXPECTED_SHA256 = 'c11db9a211c7e8c21efc5aab6a8e503b3817aa78f3d184cfe5d077b0a32826c2';
const EXPECTED_RECORDS = 22_014;
const EXPECTED_CACHED_FORMULAS = 3_821;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// Source path and quote travel over stdin; output deliberately contains no workbook content.
const OPENPYXL_ANCHOR_CHECK = String.raw`
import json, sys
from openpyxl import load_workbook
item = json.load(sys.stdin)
book = load_workbook(item['path'], read_only=True, data_only=False, keep_links=False)
try:
    value = book[item['sheet']][item['cell']].value
    print(json.dumps({'manifest_quote_matches_source_cell': isinstance(value, str) and value == item['quote']}, separators=(',', ':')))
finally:
    book.close()
`;

test('authorized rq-202509-02 XLSX crosses public upload and durable PG16 parse (optional Issue #76 producer)', {
  skip: !optedIn && !producerOptedIn ? 'set BB_RUN_AUTHORIZED_RQ202509_XLSX_UPLOAD_PARSE=1 to run the authorized XLSX upload/parser integration'
    : !databaseUrl ? 'set AUTHORIZED_RQ202509_XLSX_UPLOAD_PARSE_TEST_DATABASE_URL or BB_TEST_DATABASE_URL to a disposable migrated PostgreSQL 16 template'
      : !blobConnection ? 'set BB_TEST_AZURITE_CONNECTION_STRING for a disposable Azurite instance' : false,
}, async () => {
  assert.ok(databaseUrl && blobConnection);
  const pythonReady = spawnSync(pythonExecutable, ['-c', 'import openpyxl'], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024,
  });
  assert.ok(pythonReady.status === 0, 'the configured Python parser interpreter must have openpyxl installed');
  const manifest = JSON.parse(await readFile(join(manifestRoot, 'manifest.json'), 'utf8')) as Manifest;
  const registered = manifest.cases.find(item => item.case_id === 'rq-202509')?.files.find(item => item.file_id === FILE_ID);
  assert.ok(registered, 'the authorized XLSX must be registered in the sample manifest');
  assert.deepEqual([registered.upload_role, registered.media_type, registered.bytes, registered.sha256],
    ['interimFinancial', XLSX, EXPECTED_BYTES, EXPECTED_SHA256]);
  const sourceAnchor = registered.evidence.find(anchor => anchor.locator === '01合并资产负债表!B3');
  assert.ok(sourceAnchor, 'manifest registers the independent source cell anchor');
  const sourcePath = resolve(manifestRoot, registered.path);
  assert.ok(sourcePath.startsWith(`${resolve(manifestRoot)}/`), 'manifest path remains inside the authorized sample directory');
  const sourceBytes = await readFile(sourcePath);
  assert.deepEqual([sourceBytes.byteLength, sha256(sourceBytes)], [EXPECTED_BYTES, EXPECTED_SHA256],
    'authorized source bytes match manifest size and SHA-256');

  const pool = new Pool({ connectionString: databaseUrl });
  const suffix = randomUUID().replaceAll('-', '');
  const owner = `rq509-xlsx-owner-${suffix}`;
  const foreignOwner = `rq509-xlsx-foreign-${suffix}`;
  const reviewerUserId = `rq509-xlsx-reviewer-${suffix}`;
  const grantorUserId = `rq509-xlsx-grantor-${suffix}`;
  let activeOwner = owner;
  const containerName = `bb-rq509-xlsx-${suffix}`;
  const blobs = azureBlobs(blobConnection, containerName);
  const app = createServer({ pool, blobs, allowedOrigin: origin,
    principal: async () => ({ userId: activeOwner, csrfVerified: true }), enableUserSubmissionSeam: producerOptedIn });
  const send = (method: string, url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) => app.inject({
    method: method as never, url, payload: payload as never,
    headers: { origin, ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}), ...extraHeaders },
  });
  try {
    const version = await pool.query<{ server_version_num: string }>('SHOW server_version_num');
    assert.ok(Number(version.rows[0]!.server_version_num) >= 160000 && Number(version.rows[0]!.server_version_num) < 170000,
      'this regression requires PostgreSQL 16');
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2),($3,$4),($5,$6),($7,$8)', [
      owner, `r${suffix.slice(0, 24)}`, foreignOwner, `f${suffix.slice(0, 24)}`,
      reviewerUserId, `v${suffix.slice(0, 24)}`, grantorUserId, `g${suffix.slice(0, 24)}`,
    ]);

    const created = await send('POST', '/api/v1/projects', {
      name: 'Authorized interim XLSX upload regression', kind: 'update', issuer_name: null, market: null, offering: null,
      ...(producerOptedIn ? { update_details: { ...emptyUpdateDetails(), reporting_cutoff: '2025-09-30' } } : {}),
    });
    assert.equal(created.statusCode, 201, 'authenticated owner creates a project');
    const projectId = created.json().project_id as string;
    const projectDraftRevision = created.json().draft_revision as number;
    const declaration = { byte_size: EXPECTED_BYTES, sha256: EXPECTED_SHA256 };
    const started = await send('POST', `/api/v1/projects/${projectId}/materials/uploads`, {
      ...declaration, filename: registered.original_filename, role: registered.upload_role, media_type: XLSX,
    });
    assert.equal(started.statusCode, 201, 'owner starts the public upload in the registered interimFinancial role');
    const session = started.json() as { upload_id: string; upload_url: string };
    assert.ok(session.upload_url);
    assert.equal((await send('PUT', session.upload_url, sourceBytes)).statusCode, 204, 'public byte upload passes inspection');
    assert.equal((await send('PUT', session.upload_url, sourceBytes)).statusCode, 204, 'identical received-byte retry is idempotent');

    const completed = await send('POST', `/api/v1/projects/${projectId}/materials/uploads/${session.upload_id}/complete`, declaration);
    assert.equal(completed.statusCode, 200, 'public upload completion persists the material');
    const materialId = completed.json().material_id as string;
    const replayed = await send('POST', `/api/v1/projects/${projectId}/materials/uploads/${session.upload_id}/complete`, declaration);
    assert.equal(replayed.statusCode, 200, 'same completion can be replayed');
    assert.equal(replayed.json().material_id, materialId, 'completion replay returns the same material revision');

    const material = await pool.query<{ object_key: string; sha256: string; byte_size: number; project_id: string }>(
      `SELECT object_key,sha256,byte_size,project_id FROM bb_material_versions
        WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=1`, [owner, projectId, materialId]);
    assert.equal(material.rowCount, 1);
    assert.deepEqual([material.rows[0]!.sha256.trim(), Number(material.rows[0]!.byte_size), material.rows[0]!.project_id],
      [EXPECTED_SHA256, EXPECTED_BYTES, projectId]);
    const privateBytes = await blobs.getIfExistsBounded(material.rows[0]!.object_key, EXPECTED_BYTES);
    assert.ok(privateBytes, 'completed upload bytes reside in private Azurite Blob storage');
    assert.deepEqual([privateBytes.byteLength, sha256(privateBytes)], [EXPECTED_BYTES, EXPECTED_SHA256]);

    const queued = await pool.query<{ id: string; state: string; parser_version: string; material_sha256: string }>(
      `SELECT id,state,parser_version,material_sha256 FROM bb_jobs
        WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND job_type='parse'`, [owner, projectId, materialId]);
    assert.equal(queued.rowCount, 1, 'completion replay must not enqueue a duplicate durable parse job');
    const job = queued.rows[0]!;
    assert.equal(job.state, 'queued');
    assert.equal(job.parser_version, documentParserVersion());
    assert.equal(job.material_sha256.trim(), EXPECTED_SHA256);

    const parser = (request: Parameters<typeof runDocumentParser>[0]) => runDocumentParser(request, {
      pythonExecutable, repoRoot,
    });
    const outcome = await runMaterialParseOnce({ pool, leaseSeconds: 300, material: { pool, blobs: {
      getPrivate: key => blobs.getIfExists(key),
      readToFile: (key, path, max) => blobs.readToFile!(key, path, max),
    }, parser } });
    assert.equal(outcome, 'succeeded', 'real Python parser output is durably snapshotted');

    const finished = await pool.query<{ state: string; parser_version: string; checkpoint: Record<string, any> }>(
      'SELECT state,parser_version,checkpoint FROM bb_jobs WHERE id=$1 AND owner_user_id=$2', [job.id, owner]);
    assert.equal(finished.rowCount, 1);
    assert.equal(finished.rows[0]!.state, 'succeeded');
    assert.equal(finished.rows[0]!.parser_version, documentParserVersion());
    const snapshotId = finished.rows[0]!.checkpoint.stages.parse_evidence.snapshot_id as string;
    assert.ok(snapshotId);
    const snapshot = await pool.query<{ content_sha256: string; response_status: string; response_meta: Record<string, any>; record_count: number; response_sha256: string }>(
      `SELECT content_sha256,response_status,response_meta,record_count,response_sha256 FROM bb_parse_snapshots
        WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 AND material_id=$4 AND parser_version=$5`,
      [snapshotId, owner, projectId, materialId, documentParserVersion()]);
    assert.equal(snapshot.rowCount, 1);
    const parsed = snapshot.rows[0]!;
    assert.equal(parsed.content_sha256.trim(), EXPECTED_SHA256);
    assert.equal(parsed.response_status, 'needs_confirmation', 'unverified formula caches remain unresolved');
    assert.equal(parsed.record_count, EXPECTED_RECORDS);
    assert.equal(parsed.response_meta.status, 'needs_confirmation');
    const document = parsed.response_meta.document as { worksheet_count: number; missing_formula_results: number; cached_formula_results: number };
    assert.equal(document.worksheet_count, 15);
    assert.equal(document.cached_formula_results, EXPECTED_CACHED_FORMULAS);

    const evidenceStats = await pool.query<{ count: string; distinct_ordinals: string; min_ordinal: number; max_ordinal: number;
      cached_formula_records: string; unverified_cached_formula_records: string; missing_cache_formula_records: string }>(
      `SELECT count(*)::text AS count,count(DISTINCT ordinal)::text AS distinct_ordinals,min(ordinal) AS min_ordinal,max(ordinal) AS max_ordinal,
         count(*) FILTER (WHERE formatting ? 'cached_formula_result')::text AS cached_formula_records,
         count(*) FILTER (WHERE formatting ? 'cached_formula_result' AND uncertainty @> '["formula_cached_result_unverified"]'::jsonb)::text AS unverified_cached_formula_records,
         count(*) FILTER (WHERE uncertainty @> '["formula_result_not_cached"]'::jsonb)::text AS missing_cache_formula_records
       FROM bb_parse_evidence WHERE snapshot_id=$1 AND owner_user_id=$2 AND project_id=$3 AND material_id=$4`,
      [snapshotId, owner, projectId, materialId]);
    const stats = evidenceStats.rows[0]!;
    assert.deepEqual([Number(stats.count), Number(stats.distinct_ordinals), stats.min_ordinal, stats.max_ordinal],
      [EXPECTED_RECORDS, EXPECTED_RECORDS, 0, EXPECTED_RECORDS - 1], 'persisted evidence ordinals are contiguous');
    assert.equal(Number(stats.cached_formula_records), EXPECTED_CACHED_FORMULAS);
    assert.equal(Number(stats.unverified_cached_formula_records), EXPECTED_CACHED_FORMULAS,
      'every cached formula result stays explicitly unverified');
    assert.equal(Number(stats.missing_cache_formula_records), document.missing_formula_results,
      'truly missing formula caches remain separately represented');

    const candidateRequest = { ownerUserId: owner, projectId,
      selectedFinancialMaterials: [{ materialId, materialVersion: 1 }],
      projectDraftRevision, reportingCutoff: '2025-09-30' };
    if (producerOptedIn) {
      // Exercise the real trusted producer against the just-persisted, authorized Python parse.
      // The manifest-confirmed target is used only as cutoff intent; no confirmation decision is written.
      const candidateRef = await produceTargetPeriodCandidateSnapshot({ pool, blobs }, candidateRequest);
      const candidateReplay = await produceTargetPeriodCandidateSnapshot({ pool, blobs }, candidateRequest);
      assert.deepEqual(candidateReplay, candidateRef, 'exact source/draft replay returns the same pending reference');
      const candidateRow = await pool.query<{ id: string; content_sha256: string; content: Record<string, any> }>(
        `SELECT id,content_sha256,content FROM bb_target_period_candidate_snapshots
        WHERE owner_user_id=$1 AND project_id=$2 AND candidate_set_id=$3 AND candidate_set_version=$4`,
        [owner, projectId, candidateRef.candidate_set_id, candidateRef.candidate_set_version]);
      assert.equal(candidateRow.rowCount, 1);
      const candidateContent = candidateRow.rows[0]!.content;
      assert.equal(candidateRow.rows[0]!.content_sha256.trim(), candidateRef.content_sha256);
      assert.equal(candidateContent.status, 'needs_confirmation');
      assert.equal(candidateContent.completeness, 'not_determined');
      assert.ok(candidateContent.candidates.length > 0, 'the real visible financial headers produce candidate periods');
      assert.ok(candidateContent.candidates.every((candidate: { status: string }) => candidate.status === 'needs_confirmation'),
        'real-source candidate periods remain pending');
      assert.equal(candidateContent.candidates.some((candidate: { end: string | null }) => candidate.end === '2025-09-30'), true,
        'the cutoff-related candidate is present only as a proposal');
      assert.equal(candidateContent.source_snapshots.length, 1);
      const sourcePin = candidateContent.source_snapshots[0]!;
      assert.deepEqual([sourcePin.evidence_method, sourcePin.snapshot_id, sourcePin.material_id, sourcePin.material_version,
        sourcePin.material_sha256, sourcePin.response_sha256, sourcePin.record_pins.length],
      ['native_text', snapshotId, materialId, 1, EXPECTED_SHA256, parsed.response_sha256.trim(), EXPECTED_RECORDS]);
      assert.equal(new Set(sourcePin.record_pins.map((pin: { record_id: string }) => pin.record_id)).size, EXPECTED_RECORDS,
        'the candidate snapshot pins every unique parser record, not only cited anchors');
      assert.ok(sourcePin.record_pins.every((pin: { record_id: string; record_sha256: string }) =>
        pin.record_id.length > 0 && /^[a-f0-9]{64}$/.test(pin.record_sha256)));
      const pinnedRecords = await pool.query<{ record_id: string; record_sha256: string }>(
        `SELECT record_id,lower(btrim(record_sha256::text)) AS record_sha256 FROM bb_parse_evidence
        WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=1 AND snapshot_id=$4
        ORDER BY record_id`, [owner, projectId, materialId, snapshotId]);
      assert.equal(pinnedRecords.rowCount, EXPECTED_RECORDS);
      assert.deepEqual(sourcePin.record_pins, pinnedRecords.rows,
        'the immutable candidate inventory equals all current PostgreSQL evidence record IDs and hashes');
      const candidateOutbox = await pool.query<{ count: string }>(`SELECT count(*)::text AS count
      FROM bb_outbox WHERE owner_user_id=$1 AND aggregate_id=$2 AND event_type='project.target_period_candidates_snapshotted'`,
      [owner, candidateRow.rows[0]!.id]);
      assert.equal(Number(candidateOutbox.rows[0]!.count), 1, 'exact replay creates only one candidate snapshot and outbox event');
      await assert.rejects(produceTargetPeriodCandidateSnapshot({ pool, blobs }, { ...candidateRequest, ownerUserId: foreignOwner }),
        /TARGET_PERIOD_CANDIDATE_PROJECT_NOT_FOUND/, 'foreign owner cannot produce from this project');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM bb_target_period_candidate_snapshots WHERE owner_user_id=$1`,
        [foreignOwner])).rows[0]!.n, 0, 'foreign owner cannot read or create a candidate snapshot');
    }

    const anchor = await pool.query<{ locator: Record<string, unknown>; literal_quote: string }>(
      `SELECT locator,literal_quote FROM bb_parse_evidence WHERE snapshot_id=$1 AND locator_type='xlsx_cell'
        AND locator->>'sheet'=$2 AND locator->>'cell'=$3`, [snapshotId, '01合并资产负债表', 'B3']);
    assert.equal(anchor.rowCount, 1, 'registered source cell has exactly one persisted parser anchor');
    assert.ok(anchor.rows[0]!.literal_quote === sourceAnchor.quote, 'parser evidence retains the manifest-registered source-cell value');
    const independent = spawnSync(pythonExecutable, ['-c', OPENPYXL_ANCHOR_CHECK], {
      cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024,
      input: JSON.stringify({ path: sourcePath, sheet: '01合并资产负债表', cell: 'B3', quote: anchor.rows[0]!.literal_quote }),
    });
    assert.equal(independent.status, 0, 'independent openpyxl source check completes');
    assert.equal(JSON.parse(independent.stdout).manifest_quote_matches_source_cell, true,
      'persisted parser quote is independently recovered from its original workbook cell');

    const identityEvidence = await pool.query<{ record_id: string }>(`SELECT record_id FROM bb_parse_evidence
      WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=1 AND snapshot_id=$4
        AND literal_quote LIKE '%任丘市建设投资集团有限公司%' ORDER BY ordinal LIMIT 1`,
    [owner, projectId, materialId, snapshotId]);
    assert.equal(identityEvidence.rowCount, 1, 'the authorized report provides an exact issuer identity anchor');
    const reviewerGrantId = randomUUID();
    await pool.query(`INSERT INTO bb_issuer_identity_reviewer_grants
      (id,user_id,role,granted_by,reason_code,authorization_basis,scope_owner_user_id,scope_project_id)
      VALUES($1,$2,'issuer_identity_reviewer',$3,'authorized_test','authorized rq Q3 formula candidate integration',$4,$5)`,
    [reviewerGrantId, reviewerUserId, grantorUserId, owner, projectId]);
    const reviewer = await authorizeIssuerIdentityReviewer(pool, reviewerUserId, { ownerUserId: owner, projectId });
    assert.ok(reviewer);
    const observation = await appendIssuerIdentitySourceRecord({ pool }, {
      ownerUserId: owner, projectId, materialId, materialVersion: 1,
      requestId: `rq-q3-identity-${suffix}`, sourceRecordId: identityEvidence.rows[0]!.record_id,
      issuerDisplayName: '任丘市建设投资集团有限公司', entityId: `rq-q3-observed-${suffix}`,
    });
    await reviewIssuerIdentitySourceRecord({ pool }, {
      ownerUserId: owner, projectId, materialId, materialVersion: 1, sourceRecordRowId: observation.id,
      reviewer, decision: 'verified', verifiedEntityId: 'entity:11111111-1111-4111-8111-111111111111',
      entityBasisKind: 'manual_attestation', entityBasisRef: 'authorized rq Q3 sample integration fixture',
      reasonCode: 'authorized_test_fixture',
    });
    const verifiedIdentity = await loadVerifiedIssuerIdentitySourceRecord(pool, {
      ownerUserId: owner, projectId, materialId, materialVersion: 1,
    });
    assert.ok(verifiedIdentity);
    const inputHash = sha256(Buffer.from(`authorized rq Q3 input ${suffix}`));
    await pool.query(`INSERT INTO bb_input_revisions
      (project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,$4::jsonb,$5::jsonb,'[]'::jsonb)`, [projectId, owner, inputHash,
      JSON.stringify({ issuer_identity: verifiedIssuerIdentityBinding(verifiedIdentity), issuer_entity_id: verifiedIdentity.entityId,
        materials: [{ material_id: materialId, material_version: 1, role: 'interimFinancial', sha256: EXPECTED_SHA256 }] }),
      JSON.stringify([{ material_id: materialId, material_version: 1 }])]);

    const producer = createControlledNativeFactCandidateProducer({ pool });
    const productionContext = { ownerUserId: owner, projectId, inputRevision: 1, inputHash, materialId,
      materialVersion: 1, snapshotId };
    const produced = await producer(productionContext);
    assert.equal(produced.inserted.length, 8, 'the exact authorized formula-cache matrix persists eight candidates');
    assert.equal(produced.needsReview.length, 0);
    const candidates = await listFactCandidates({ pool }, { ownerUserId: owner, projectId });
    const persistedCandidates = candidates.filter(item => item.candidate.source.sourceId === materialId);
    assert.equal(persistedCandidates.length, 8);
    assert.ok(persistedCandidates.every(item => item.candidate.source.kind === 'external' &&
      item.provenance.status === 'needs_confirmation' && item.candidate.auditCheck === null &&
      item.candidate.identity.entityId === verifiedIdentity.entityId));
    assert.ok(persistedCandidates.filter(item => item.candidate.identity.scope === 'parent_only').every(item =>
      item.provenance.uncertainty.some(reason => reason.includes('PERIOD_HEADER_FORMULA_CACHE_UNVERIFIED'))),
    'parent-only candidates explicitly retain uncertainty from their formula-derived period header');
    for (const item of persistedCandidates) {
      const { scope, metric } = item.candidate.identity;
      const expected = metric === 'total_assets' ? { sheet: '01', cell: 'D78' }
        : metric === 'operating_revenue' ? { sheet: '02', cell: 'D6' }
          : metric === 'net_profit' ? { sheet: '02', cell: 'D44' } : { sheet: '03', cell: 'C32' };
      const exactSheetPrefix = `${expected.sheet}${scope === 'consolidated' ? '合并' : '母公司'}`;
      assert.ok(item.provenance.evidence.some(anchor => anchor.locator_type === 'xlsx_cell' &&
        typeof anchor.locator.sheet === 'string' && anchor.locator.sheet.startsWith(exactSheetPrefix) &&
        anchor.locator.cell === expected.cell && anchor.literal_quote.startsWith('=') &&
        anchor.uncertainty.includes('formula_cached_result_unverified')),
      'each candidate binds the exact formula cell for its metric and scope');
      if (scope === 'parent_only') assert.ok(item.provenance.evidence.some(anchor => anchor.locator_type === 'xlsx_cell' &&
        typeof anchor.locator.sheet === 'string' && anchor.locator.sheet.startsWith(exactSheetPrefix) && anchor.locator.cell === 'B3' &&
        anchor.literal_quote.startsWith('=') && anchor.uncertainty.includes('formula_cached_result_unverified')),
      'parent scope retains its formula-derived period header as unresolved evidence');
    }
    const durableRows = await pool.query<{ status: string; source_kind: string; uncertainty: string[]; evidence: Array<{
      locator_type: string; locator: { sheet?: string; cell?: string }; literal_quote: string; uncertainty: string[];
    }> }>(`SELECT status,source_kind,uncertainty,evidence FROM bb_fact_candidates
      WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=1`, [owner, projectId, materialId]);
    assert.equal(durableRows.rowCount, 8);
    assert.ok(durableRows.rows.every(row => row.status === 'needs_confirmation' && row.source_kind === 'external' &&
      row.uncertainty.some(reason => reason.includes('FORMULA_CACHE_VALUE_UNVERIFIED')) &&
      row.uncertainty.some(reason => reason.includes('FORMULA_SOURCE_CHAIN_UNVERIFIED'))));
    assert.ok(durableRows.rows.every(row => row.evidence.some(anchor => anchor.locator_type === 'xlsx_cell' &&
      anchor.literal_quote.startsWith('=') && anchor.uncertainty.includes('formula_cached_result_unverified') &&
      typeof anchor.locator.sheet === 'string' && typeof anchor.locator.cell === 'string')));

    const replay = await producer(productionContext);
    assert.equal(replay.inserted.length, 0);
    assert.equal(replay.replayed.length, 8, 'replaying the exact extraction pin returns its eight prior candidates');
    const ledger = await pool.query<{ extractor_id: string; candidate_ids: string[] }>(`SELECT extractor_id,candidate_ids
      FROM bb_fact_extraction_runs WHERE owner_user_id=$1 AND project_id=$2 AND input_revision=1 AND material_id=$3`,
    [owner, projectId, materialId]);
    assert.equal(ledger.rowCount, 1, 'exact replay reuses one durable extraction ledger row');
    assert.equal(ledger.rows[0]!.extractor_id, 'rq-202509-q3-formula-cache-candidates');
    assert.equal(ledger.rows[0]!.candidate_ids.length, 8);
    const outbox = await pool.query(`SELECT id FROM bb_outbox WHERE owner_user_id=$1 AND aggregate_id=$2
      AND event_type='fact.extraction.completed'`, [owner, projectId]);
    assert.equal(outbox.rowCount, 1, 'candidate persistence and extraction outbox are idempotent');
    assert.equal((await listFactCandidates({ pool }, { ownerUserId: foreignOwner, projectId })).length, 0,
      'another owner cannot read these persisted candidates');
    await assert.rejects(producer({ ...productionContext, ownerUserId: foreignOwner }), /FACT_EXTRACTION_INPUT_REVISION_MISMATCH/,
      'another owner cannot run extraction using this immutable input pin');

    activeOwner = foreignOwner;
    assert.equal((await send('GET', `/api/v1/projects/${projectId}`)).statusCode, 404, 'foreign account cannot read the project');
    assert.equal((await send('GET', `/api/v1/projects/${projectId}/materials/${materialId}`)).statusCode, 404,
      'foreign account cannot read the material');
    assert.equal((await send('GET', `/api/v1/projects/${projectId}/materials/${materialId}/parse-job`)).statusCode, 404,
      'foreign account cannot read parse-job state');
    activeOwner = owner;
    const readable = await send('GET', `/api/v1/projects/${projectId}/materials/${materialId}/parse-job`);
    assert.equal(readable.statusCode, 200);
    assert.equal(readable.json().parser_version, documentParserVersion());
    assert.equal(readable.json().material_id, materialId);

    if (producerOptedIn) {
      const replacementUploadId = `rq509-xlsx-replacement-${suffix}`;
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'replacement.xlsx',$4,$5,$6,'interimFinancial',$7,now()+interval '1 hour','completed')`,
      [replacementUploadId, owner, projectId, XLSX, EXPECTED_BYTES, EXPECTED_SHA256, `synthetic-replacement-upload/${suffix}`]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,2,$2,$3,$4,'interimFinancial','replacement.xlsx',$5,$6,$7,$8,'parsed')`,
      [materialId, owner, projectId, replacementUploadId, XLSX, EXPECTED_BYTES, EXPECTED_SHA256,
        `synthetic-replacement-material/${suffix}`]);
      await assert.rejects(produceTargetPeriodCandidateSnapshot({ pool, blobs }, candidateRequest),
        /TARGET_PERIOD_CANDIDATE_MATERIAL_STALE/, 'a replacement material revision invalidates new candidate production from v1');
      const changedDraft = await send('PATCH', `/api/v1/projects/${projectId}`, {
        update_details: { ...emptyUpdateDetails(), reporting_cutoff: '2025-06-30' },
      }, { 'if-match': String(projectDraftRevision) });
      assert.equal(changedDraft.statusCode, 200);
      await assert.rejects(produceTargetPeriodCandidateSnapshot({ pool, blobs }, candidateRequest),
        /TARGET_PERIOD_CANDIDATE_DRAFT_STALE/, 'a changed draft revision/cutoff invalidates the old producer request');

    // Persist a synthetic project message through the existing private submission seam. The test
    // does not fetch or log its private Blob body; the producer must block based on scoped metadata.
      const savedMessage = await send('POST', `/api/v1/internal/projects/${projectId}/submissions`, {
        message_id: `message-${suffix}`, submission_request_id: `message-request-${suffix}`,
        body: 'Synthetic authorized-test requirement; not customer content.', material_versions: [],
      });
      assert.equal(savedMessage.statusCode, 201);
      const currentDraft = changedDraft.json().draft_revision as number;
      await assert.rejects(produceTargetPeriodCandidateSnapshot({ pool, blobs }, {
        ...candidateRequest, projectDraftRevision: currentDraft, reportingCutoff: '2025-06-30',
      }), /TARGET_PERIOD_CANDIDATE_REQUIREMENTS_STORE_REQUIRED/,
      'owner/project-scoped project-message metadata blocks a candidate with an empty requirement pin');
    }
  } finally {
    activeOwner = owner;
    await app.close();
    await pool.end();
    await BlobServiceClient.fromConnectionString(blobConnection).getContainerClient(containerName).deleteIfExists();
  }
});
