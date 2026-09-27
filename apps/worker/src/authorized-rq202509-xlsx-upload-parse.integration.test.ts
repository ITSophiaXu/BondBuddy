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
import { createServer } from '@bondbuddy/api';
import { azureBlobs } from '@bondbuddy/api/data';
import { documentParserVersion } from '@bondbuddy/api/material-jobs';
import { runDocumentParser } from './document-parser.js';
import { runMaterialParseOnce } from './material-parse-job.js';
import { isolatedTestDatabase } from './test-database.js';

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
const databaseUrl = optedIn ? await isolatedTestDatabase('AUTHORIZED_RQ202509_XLSX_UPLOAD_PARSE_TEST_DATABASE_URL') : undefined;
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

test('authorized rq-202509-02 XLSX crosses public upload, private Blob, durable PG16 parse and source-anchor checks', {
  skip: !optedIn ? 'set BB_RUN_AUTHORIZED_RQ202509_XLSX_UPLOAD_PARSE=1 to run the authorized XLSX upload/parser integration'
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
  let activeOwner = owner;
  const containerName = `bb-rq509-xlsx-${suffix}`;
  const blobs = azureBlobs(blobConnection, containerName);
  const app = createServer({ pool, blobs, allowedOrigin: origin,
    principal: async () => ({ userId: activeOwner, csrfVerified: true }) });
  const send = (method: string, url: string, payload?: unknown) => app.inject({
    method: method as never, url, payload: payload as never,
    headers: { origin, ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}) },
  });
  try {
    const version = await pool.query<{ server_version_num: string }>('SHOW server_version_num');
    assert.ok(Number(version.rows[0]!.server_version_num) >= 160000 && Number(version.rows[0]!.server_version_num) < 170000,
      'this regression requires PostgreSQL 16');
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2),($3,$4)', [
      owner, `r${suffix.slice(0, 30)}`, foreignOwner, `f${suffix.slice(0, 30)}`,
    ]);

    const created = await send('POST', '/api/v1/projects', {
      name: 'Authorized interim XLSX upload regression', kind: 'update', issuer_name: null, market: null, offering: null,
    });
    assert.equal(created.statusCode, 201, 'authenticated owner creates a project');
    const projectId = created.json().project_id as string;
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
    const snapshot = await pool.query<{ content_sha256: string; response_status: string; response_meta: Record<string, any>; record_count: number }>(
      `SELECT content_sha256,response_status,response_meta,record_count FROM bb_parse_snapshots
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
  } finally {
    activeOwner = owner;
    await app.close();
    await pool.end();
    await BlobServiceClient.fromConnectionString(blobConnection).getContainerClient(containerName).deleteIfExists();
  }
});
