import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import COS from 'cos-nodejs-sdk-v5';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { privateBlobsFromEnv } from './storage-provider.js';
import { PDF, pdfSample } from './upload-safety.samples.js';
import { isolatedTestDatabase } from './test-database.js';

const live = process.env.BB_COS_LIVE_TEST_ACK === 'isolated-test-bucket'
  && process.env.BB_STORAGE_PROVIDER === 'cos'
  && /^bb-cos-migration-app-test-[0-9]+$/.test(process.env.BB_COS_BUCKET ?? '')
  && process.env.BB_COS_REGION === 'ap-beijing'
  && !!process.env.BB_COS_SECRET_ID && !!process.env.BB_COS_SECRET_KEY
  && !!process.env.BB_TEST_DATABASE_URL;
const connection = live ? await isolatedTestDatabase() : undefined;

test('isolated PostgreSQL and real COS preserve upload, restart download, ownership and object reference',
  { skip: !connection }, async () => {
    const bucket = process.env.BB_COS_BUCKET!;
    const region = process.env.BB_COS_REGION!;
    const client = new COS({ SecretId: process.env.BB_COS_SECRET_ID!, SecretKey: process.env.BB_COS_SECRET_KEY! });
    const owner = `cos-live-${randomUUID()}`;
    const prefix = `users/${owner}/`;
    const origin = 'http://cos-integration.invalid';
    const pool = new Pool({ connectionString: connection });
    const blobs = privateBlobsFromEnv(process.env);
    assert.ok(blobs);
    let active = owner;
    let app = createServer({ pool, blobs, allowedOrigin: origin,
      principal: async () => ({ userId: active, csrfVerified: true }) });
    const send = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
      app.inject({ method: method as 'GET', url, headers: { origin, ...headers }, payload: payload as any });
    const list = async () => client.getBucket({ Bucket: bucket, Region: region, Prefix: prefix, MaxKeys: 1000 });
    try {
      assert.equal((await list()).Contents?.length ?? 0, 0, 'test owner prefix must start empty');
      const created = await send('POST', '/api/v1/projects',
        { name: 'Synthetic COS upload', kind: 'update', issuer_name: null, market: 'nafmii', offering: 'mtn' });
      assert.equal(created.statusCode, 201, created.body);
      const projectId = created.json().project_id as string;
      const bytes = pdfSample({ tag: 'COS live synthetic fixture' });
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const base = `/api/v1/projects/${projectId}/materials/uploads`;
      const declaration = { byte_size: bytes.length, sha256 };
      const uploaded = await send('POST', base,
        { ...declaration, filename: 'synthetic-cos.pdf', media_type: PDF, role: 'audit' });
      assert.equal(uploaded.statusCode, 201, uploaded.body);
      const ticket = uploaded.json() as { upload_id: string; upload_url: string };
      const put = await send('PUT', ticket.upload_url, bytes, { 'content-type': 'application/octet-stream' });
      assert.equal(put.statusCode, 204, put.body);
      const completed = await send('POST', `${base}/${ticket.upload_id}/complete`, declaration);
      assert.equal(completed.statusCode, 200, completed.body);
      const materialId = completed.json().material_id as string;
      const replay = await send('POST', `${base}/${ticket.upload_id}/complete`, declaration);
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.json().material_id, materialId);
      const stored = await pool.query('SELECT object_key FROM bb_material_versions WHERE owner_user_id=$1 AND id=$2',
        [owner, materialId]);
      assert.equal(stored.rowCount, 1);
      const key = stored.rows[0].object_key as string;
      assert.ok(key.startsWith(prefix));
      assert.deepEqual(await blobs.get(key), bytes);
      const objectHead = await client.headObject({ Bucket: bucket, Region: region, Key: key });
      assert.equal(objectHead.statusCode, 200);
      assert.equal(objectHead.headers?.['x-cos-server-side-encryption'], 'AES256');
      const url = `/api/v1/projects/${projectId}/materials/${materialId}/download`;
      const downloaded = await send('GET', url);
      assert.equal(downloaded.statusCode, 200, downloaded.body);
      assert.deepEqual(downloaded.rawPayload, bytes);
      active = `cos-foreign-${randomUUID()}`;
      assert.equal((await send('GET', url)).statusCode, 404);
      active = owner;
      await app.close();
      app = createServer({ pool, blobs: privateBlobsFromEnv(process.env)!, allowedOrigin: origin,
        principal: async () => ({ userId: active, csrfVerified: true }) });
      const afterRestart = await send('GET', url);
      assert.equal(afterRestart.statusCode, 200, afterRestart.body);
      assert.deepEqual(afterRestart.rawPayload, bytes);
    } finally {
      await app.close();
      const page = await list();
      assert.notEqual(page.IsTruncated, 'true', 'test cleanup requires complete owner prefix listing');
      for (const item of page.Contents ?? []) await blobs.delete(item.Key);
      assert.equal((await list()).Contents?.length ?? 0, 0, 'test COS objects must be removed');
      const versions = await client.listObjectVersions({ Bucket: bucket, Region: region, Prefix: prefix, MaxKeys: '1000' });
      assert.equal(versions.Versions?.length ?? 0, 0);
      assert.equal(versions.DeleteMarkers?.length ?? 0, 0);
      await pool.end();
    }
  });
