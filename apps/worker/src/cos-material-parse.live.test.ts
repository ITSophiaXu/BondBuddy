import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import COS from 'cos-nodejs-sdk-v5';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { privateBlobsFromEnv } from '@bondbuddy/api/storage-provider';
import { DEFAULT_DOCUMENT_PARSER_VERSION } from '@bondbuddy/api/material-jobs';
import { runMaterialParseOnce } from './material-parse-job.js';
import type { DocumentParseRequest, DocumentParseResponse } from './document-parser.js';
import { isolatedTestDatabase } from './test-database.js';

const live = process.env.BB_COS_LIVE_TEST_ACK === 'isolated-test-bucket'
  && process.env.BB_STORAGE_PROVIDER === 'cos'
  && /^bb-cos-migration-app-test-[0-9]+$/.test(process.env.BB_COS_BUCKET ?? '')
  && process.env.BB_COS_REGION === 'ap-beijing'
  && !!process.env.BB_COS_SECRET_ID && !!process.env.BB_COS_SECRET_KEY
  && !!process.env.BB_TEST_DATABASE_URL;
const connection = live ? await isolatedTestDatabase() : undefined;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function syntheticParse(request: DocumentParseRequest): DocumentParseResponse {
  const material = request.material;
  return {
    schema_version: 'document-parse-response-v1', request_id: request.request_id,
    parser_version: DEFAULT_DOCUMENT_PARSER_VERSION, status: 'parsed',
    material: { material_id: material.material_id, material_version: material.material_version,
      media_type: material.media_type, sha256: material.sha256 },
    records: [{ record_id: 'synthetic-line-1', material_id: material.material_id,
      material_version: material.material_version, content_hash: material.sha256,
      locator_type: 'text_line', locator: { line: 1, stable_ref: 'text:l000001' },
      literal_quote: 'Synthetic COS worker parse', context: 'synthetic', extraction_method: 'native_text',
      extractor_version: DEFAULT_DOCUMENT_PARSER_VERSION, confidence: 1, uncertainty: [], formatting: {} }],
    warnings: [], document: { page_count: null, encoding: 'utf-8' }, error: null,
  };
}

test('real COS object uploaded by API is read by worker and reaches durable parsed state',
  { skip: !connection }, async () => {
    const bucket = process.env.BB_COS_BUCKET!, region = process.env.BB_COS_REGION!;
    const client = new COS({ SecretId: process.env.BB_COS_SECRET_ID!, SecretKey: process.env.BB_COS_SECRET_KEY! });
    const owner = `cos-parse-${randomUUID()}`, prefix = `users/${owner}/`;
    const origin = 'http://cos-worker-integration.invalid';
    const pool = new Pool({ connectionString: connection });
    const blobs = privateBlobsFromEnv(process.env)!;
    const app = createServer({ pool, blobs, allowedOrigin: origin,
      principal: async () => ({ userId: owner, csrfVerified: true }) });
    const send = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
      app.inject({ method: method as 'GET', url, headers: { origin, ...headers }, payload: payload as any });
    try {
      const created = await send('POST', '/api/v1/projects',
        { name: 'Synthetic COS worker parse', kind: 'update', issuer_name: null, market: 'nafmii', offering: 'mtn' });
      assert.equal(created.statusCode, 201, created.body);
      const projectId = created.json().project_id as string;
      const bytes = Buffer.from('Synthetic COS worker parse\n', 'utf8');
      const declaration = { byte_size: bytes.length, sha256: sha(bytes) };
      const base = `/api/v1/projects/${projectId}/materials/uploads`;
      const createdUpload = await send('POST', base,
        { ...declaration, filename: 'synthetic-parse.txt', media_type: 'text/plain', role: 'audit' });
      assert.equal(createdUpload.statusCode, 201, createdUpload.body);
      const ticket = createdUpload.json() as { upload_id: string; upload_url: string };
      assert.equal((await send('PUT', ticket.upload_url, bytes,
        { 'content-type': 'application/octet-stream' })).statusCode, 204);
      const complete = await send('POST', `${base}/${ticket.upload_id}/complete`, declaration);
      assert.equal(complete.statusCode, 200, complete.body);
      const materialId = complete.json().material_id as string;
      const job = await pool.query("SELECT id,state FROM bb_jobs WHERE job_type='parse' AND material_id=$1", [materialId]);
      assert.equal(job.rowCount, 1);
      assert.equal(job.rows[0].state, 'queued');
      const outcome = await runMaterialParseOnce({ pool, leaseSeconds: 30,
        material: { pool, blobs: { getPrivate: key => blobs.getIfExists(key) },
          parser: async request => syntheticParse(request) } });
      assert.equal(outcome, 'succeeded');
      const durable = await pool.query("SELECT state,checkpoint FROM bb_jobs WHERE id=$1", [job.rows[0].id]);
      assert.equal(durable.rows[0].state, 'succeeded');
      assert.ok(durable.rows[0].checkpoint.stages.parse_evidence.snapshot_id);
      assert.equal((await send('GET', `/api/v1/projects/${projectId}/materials/${materialId}/parse-job`)).statusCode, 200);
      const stored = await pool.query('SELECT object_key FROM bb_material_versions WHERE id=$1', [materialId]);
      assert.deepEqual(await blobs.get(stored.rows[0].object_key), bytes);
    } finally {
      await app.close();
      try {
        const page = await client.getBucket({ Bucket: bucket, Region: region, Prefix: prefix, MaxKeys: 1000 });
        assert.notEqual(page.IsTruncated, 'true');
        for (const item of page.Contents ?? []) await blobs.delete(item.Key);
        const after = await client.getBucket({ Bucket: bucket, Region: region, Prefix: prefix, MaxKeys: 2 });
        const versions = await client.listObjectVersions({ Bucket: bucket, Region: region, Prefix: prefix, MaxKeys: '2' });
        assert.equal(after.Contents?.length ?? 0, 0);
        assert.equal(versions.Versions?.length ?? 0, 0);
        assert.equal(versions.DeleteMarkers?.length ?? 0, 0);
      } finally { await pool.end(); }
    }
  });
