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
type RegisteredPdf = {
  readonly file_id: string;
  readonly path: string;
  readonly original_filename: string;
  readonly upload_role: string;
  readonly media_type: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly page_count: number;
  readonly evidence: readonly ManifestEvidence[];
};
type Manifest = {
  readonly cases: readonly { readonly case_id: string; readonly files: readonly RegisteredPdf[] }[];
};
type PdfAnchor = {
  readonly page: number;
  readonly bbox: {
    readonly x0: number;
    readonly top: number;
    readonly x1: number;
    readonly bottom: number;
  };
  readonly quote: string;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const manifestRoot = join(repoRoot, 'tests/samples/2026-09-25');
const localPython = join(
  repoRoot,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const pythonExecutable =
  process.env.BB_PYTHON?.trim() ||
  (existsSync(localPython) ? localPython : process.platform === 'win32' ? 'python' : 'python3');
const optedIn = process.env.BB_RUN_AUTHORIZED_QX04_UPLOAD_PARSE === '1';
const databaseUrl = optedIn
  ? await isolatedTestDatabase('AUTHORIZED_QX04_UPLOAD_PARSE_TEST_DATABASE_URL')
  : undefined;
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const PDF = 'application/pdf';
const FILE_ID = 'qx-202606-04';
const EXPECTED_BYTES = 348_036;
const EXPECTED_SHA256 = '6fc2b04841cbcf53b42b9c35f4f6fa970c69b130e7bcb0e160372b4de760ea37';
const EXPECTED_RECORDS = 446;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// Source path and original quote travel on stdin; child argv and output never contain either.
const verifyPdfAnchor = String.raw`
import json, sys, pdfplumber
item = json.load(sys.stdin)
with pdfplumber.open(item['path']) as pdf:
    page = pdf.pages[item['anchor']['page'] - 1]
    bbox = item['anchor']['bbox']
    recovered = page.crop((bbox['x0'], bbox['top'], bbox['x1'], bbox['bottom'])).extract_text()
print(json.dumps({'source_quote_matches_bbox': recovered == item['anchor']['quote']}, separators=(',', ':')))
`;

test(
  'authorized qx-202606-04 PDF crosses public upload, private Blob, durable PG16 parse and source-anchor checks',
  {
    skip: !optedIn
      ? 'set BB_RUN_AUTHORIZED_QX04_UPLOAD_PARSE=1 to run the authorized PDF upload/parser integration'
      : !databaseUrl
        ? 'set AUTHORIZED_QX04_UPLOAD_PARSE_TEST_DATABASE_URL or BB_TEST_DATABASE_URL to a disposable migrated PostgreSQL 16 template'
        : !blobConnection
          ? 'set BB_TEST_AZURITE_CONNECTION_STRING for a disposable Azurite instance'
          : false,
  },
  async () => {
    assert.ok(databaseUrl && blobConnection);
    assert.ok(existsSync(pythonExecutable), 'configured Python parser interpreter must exist');
    const manifest = JSON.parse(
      await readFile(join(manifestRoot, 'manifest.json'), 'utf8'),
    ) as Manifest;
    const registered = manifest.cases
      .find((item) => item.case_id === 'qx-202606')
      ?.files.find((item) => item.file_id === FILE_ID);
    assert.ok(registered, 'the authorized PDF must be registered in the sample manifest');
    assert.deepEqual(
      [
        registered.upload_role,
        registered.media_type,
        registered.bytes,
        registered.sha256,
        registered.page_count,
      ],
      ['interimFinancial', PDF, EXPECTED_BYTES, EXPECTED_SHA256, 10],
    );
    assert.ok(
      registered.evidence.some((anchor) => anchor.locator === 'PDF physical page 1') &&
        registered.evidence.some((anchor) => anchor.locator === 'PDF physical page 3'),
      'manifest contains registered source anchors',
    );
    const sourcePath = resolve(manifestRoot, registered.path);
    assert.ok(
      sourcePath.startsWith(`${resolve(manifestRoot)}/`),
      'manifest path remains inside the authorized sample directory',
    );
    const sourceBytes = await readFile(sourcePath);
    assert.equal(sourceBytes.byteLength, EXPECTED_BYTES, 'registered source byte size');
    assert.equal(sha256(sourceBytes), EXPECTED_SHA256, 'registered source SHA-256');

    const pool = new Pool({ connectionString: databaseUrl });
    const suffix = randomUUID().replaceAll('-', '');
    const owner = `qx04-upload-owner-${suffix}`;
    const foreignOwner = `qx04-upload-foreign-${suffix}`;
    let activeOwner = owner;
    const containerName = `bb-qx04-upload-${suffix}`;
    const blobs = azureBlobs(blobConnection, containerName);
    const app = createServer({
      pool,
      blobs,
      allowedOrigin: 'http://bondbuddy.test',
      principal: async () => ({ userId: activeOwner, csrfVerified: true }),
    });
    const send = (method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as never,
        url,
        payload: payload as never,
        headers: {
          origin: 'http://bondbuddy.test',
          ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}),
        },
      });
    try {
      const version = await pool.query<{ server_version_num: string }>('SHOW server_version_num');
      assert.ok(
        Number(version.rows[0]!.server_version_num) >= 160000 &&
          Number(version.rows[0]!.server_version_num) < 170000,
        'this regression is PostgreSQL 16 only',
      );
      await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2),($3,$4)', [
        owner,
        `q${suffix.slice(0, 30)}`,
        foreignOwner,
        `f${suffix.slice(0, 30)}`,
      ]);
      const created = await send('POST', '/api/v1/projects', {
        name: 'Authorized interim PDF upload regression',
        kind: 'update',
        issuer_name: null,
        market: null,
        offering: null,
      });
      assert.equal(created.statusCode, 201, 'authenticated owner creates a project');
      const projectId = created.json().project_id as string;
      const declaration = { byte_size: EXPECTED_BYTES, sha256: EXPECTED_SHA256 };
      const started = await send('POST', `/api/v1/projects/${projectId}/materials/uploads`, {
        ...declaration,
        filename: registered.original_filename,
        role: registered.upload_role,
        media_type: PDF,
      });
      assert.equal(
        started.statusCode,
        201,
        'owner starts the public upload in the registered interimFinancial role',
      );
      const session = started.json() as { upload_id: string; upload_url: string };
      assert.ok(session.upload_url);
      assert.equal(
        (await send('PUT', session.upload_url, sourceBytes)).statusCode,
        204,
        'public byte upload passes inspection',
      );
      assert.equal(
        (await send('PUT', session.upload_url, sourceBytes)).statusCode,
        204,
        'identical received-byte retry is idempotent',
      );

      const completed = await send(
        'POST',
        `/api/v1/projects/${projectId}/materials/uploads/${session.upload_id}/complete`,
        declaration,
      );
      assert.equal(completed.statusCode, 200, 'public upload completion persists the material');
      const materialId = completed.json().material_id as string;
      const replayed = await send(
        'POST',
        `/api/v1/projects/${projectId}/materials/uploads/${session.upload_id}/complete`,
        declaration,
      );
      assert.equal(replayed.statusCode, 200, 'same completion can be replayed');
      assert.equal(
        replayed.json().material_id,
        materialId,
        'completion replay returns the same material revision',
      );

      const material = await pool.query<{
        object_key: string;
        sha256: string;
        byte_size: number;
        project_id: string;
      }>(
        `SELECT object_key,sha256,byte_size,project_id FROM bb_material_versions
        WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=1`,
        [owner, projectId, materialId],
      );
      assert.equal(material.rowCount, 1);
      assert.deepEqual(
        [
          material.rows[0]!.sha256.trim(),
          Number(material.rows[0]!.byte_size),
          material.rows[0]!.project_id,
        ],
        [EXPECTED_SHA256, EXPECTED_BYTES, projectId],
      );
      const privateBytes = await blobs.getIfExistsBounded(
        material.rows[0]!.object_key,
        EXPECTED_BYTES,
      );
      assert.ok(privateBytes, 'completed upload bytes reside in private Azurite Blob storage');
      assert.deepEqual(
        [privateBytes.byteLength, sha256(privateBytes)],
        [EXPECTED_BYTES, EXPECTED_SHA256],
      );

      const queued = await pool.query<{
        id: string;
        state: string;
        parser_version: string;
        material_sha256: string;
      }>(
        `SELECT id,state,parser_version,material_sha256 FROM bb_jobs
        WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND job_type='parse'`,
        [owner, projectId, materialId],
      );
      assert.equal(
        queued.rowCount,
        1,
        'completion replay must not enqueue a duplicate durable parse job',
      );
      const job = queued.rows[0]!;
      assert.equal(job.state, 'queued');
      assert.equal(job.parser_version, documentParserVersion());
      assert.equal(job.material_sha256.trim(), EXPECTED_SHA256);

      const parser = (request: Parameters<typeof runDocumentParser>[0]) =>
        runDocumentParser(request, {
          pythonExecutable,
          repoRoot,
        });
      const outcome = await runMaterialParseOnce({
        pool,
        leaseSeconds: 300,
        material: {
          pool,
          blobs: {
            getPrivate: (key) => blobs.getIfExists(key),
            readToFile: (key, path, max) => blobs.readToFile!(key, path, max),
          },
          parser,
        },
      });
      assert.equal(outcome, 'succeeded', 'real Python parser output is durably snapshotted');

      const finished = await pool.query<{
        state: string;
        parser_version: string;
        checkpoint: Record<string, any>;
      }>('SELECT state,parser_version,checkpoint FROM bb_jobs WHERE id=$1 AND owner_user_id=$2', [
        job.id,
        owner,
      ]);
      assert.equal(finished.rowCount, 1);
      assert.equal(finished.rows[0]!.state, 'succeeded');
      assert.equal(finished.rows[0]!.parser_version, documentParserVersion());
      const snapshotId = finished.rows[0]!.checkpoint.stages.parse_evidence.snapshot_id as string;
      assert.ok(snapshotId);
      const snapshot = await pool.query<{
        content_sha256: string;
        response_status: string;
        response_meta: Record<string, any>;
        record_count: number;
      }>(
        `SELECT content_sha256,response_status,response_meta,record_count FROM bb_parse_snapshots
        WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 AND material_id=$4 AND parser_version=$5`,
        [snapshotId, owner, projectId, materialId, documentParserVersion()],
      );
      assert.equal(snapshot.rowCount, 1);
      const parsed = snapshot.rows[0]!;
      assert.equal(parsed.content_sha256.trim(), EXPECTED_SHA256);
      assert.equal(parsed.response_status, 'parsed');
      assert.equal(parsed.record_count, EXPECTED_RECORDS);
      assert.equal(parsed.response_meta.status, 'parsed');
      assert.equal((parsed.response_meta.document as { page_count: number }).page_count, 10);

      const evidence = await pool.query<{
        ordinal: number;
        locator_type: string;
        locator: Record<string, any>;
        literal_quote: string;
      }>(
        `SELECT ordinal,locator_type,locator,literal_quote FROM bb_parse_evidence WHERE snapshot_id=$1
        AND owner_user_id=$2 AND project_id=$3 AND material_id=$4 ORDER BY ordinal`,
        [snapshotId, owner, projectId, materialId],
      );
      assert.equal(evidence.rowCount, EXPECTED_RECORDS);
      assert.ok(
        evidence.rows.every((row, index) => row.ordinal === index),
        'persisted record ordinals are complete and contiguous',
      );
      const anchorRow = evidence.rows.find(
        (row) =>
          row.locator_type === 'pdf_bbox' &&
          Number(row.locator.page) === 1 &&
          row.locator.bbox &&
          typeof row.literal_quote === 'string' &&
          row.literal_quote.trim().length > 0,
      );
      assert.ok(anchorRow, 'persisted native evidence has a page-1 bbox anchor');
      const bbox = anchorRow.locator.bbox as PdfAnchor['bbox'];
      assert.ok([bbox.x0, bbox.top, bbox.x1, bbox.bottom].every(Number.isFinite));
      assert.ok(bbox.x1 > bbox.x0 && bbox.bottom > bbox.top);
      const checked = spawnSync(pythonExecutable, ['-c', verifyPdfAnchor], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024,
        input: JSON.stringify({
          path: sourcePath,
          anchor: { page: anchorRow.locator.page, bbox, quote: anchorRow.literal_quote },
        }),
      });
      assert.equal(checked.status, 0, 'independent pdfplumber source check completes');
      assert.equal(
        JSON.parse(checked.stdout).source_quote_matches_bbox,
        true,
        'persisted native quote is recovered from the original PDF page bbox',
      );

      activeOwner = foreignOwner;
      assert.equal(
        (await send('GET', `/api/v1/projects/${projectId}`)).statusCode,
        404,
        'foreign account cannot read the project',
      );
      assert.equal(
        (await send('GET', `/api/v1/projects/${projectId}/materials/${materialId}`)).statusCode,
        404,
        'foreign account cannot read the material',
      );
      assert.equal(
        (await send('GET', `/api/v1/projects/${projectId}/materials/${materialId}/parse-job`))
          .statusCode,
        404,
        'foreign account cannot read parse-job state',
      );
      activeOwner = owner;
      const readable = await send(
        'GET',
        `/api/v1/projects/${projectId}/materials/${materialId}/parse-job`,
      );
      assert.equal(readable.statusCode, 200);
      assert.equal(readable.json().parser_version, documentParserVersion());
      assert.equal(readable.json().material_id, materialId);
    } finally {
      activeOwner = owner;
      await app.close();
      await pool.end();
      await BlobServiceClient.fromConnectionString(blobConnection)
        .getContainerClient(containerName)
        .deleteIfExists();
    }
  },
);
