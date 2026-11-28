import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import type COS from 'cos-nodejs-sdk-v5';
import { isolatedTestDatabase } from './test-database.js';
import { archiveStoreFromEnv } from './log-archive-store.js';
import { runArchiveLifecycle } from './log-archive-lifecycle.js';

const databaseUrl = await isolatedTestDatabase();
const env = { BB_STORAGE_PROVIDER: 'cos', BB_COS_SECRET_ID: 'synthetic-id', BB_COS_SECRET_KEY: 'synthetic-key',
  BB_COS_BUCKET: 'synthetic-1250000000', BB_COS_REGION: 'ap-beijing' };

test('COS archive retention removes every physical version before recording deletion', { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const id = randomUUID(), key = `log-archive/ndjson_file/${id}.ndjson`;
  const body = Buffer.from(`${JSON.stringify({ delivery_key: 'a'.repeat(64), user_id: 'synthetic-user' })}\n`);
  const hash = createHash('sha256').update(body).digest('hex');
  const versions = new Set(['v2', 'v1']);
  const client = {
    async headBucket() { return {}; },
    async getBucketAcl() { return { ACL: 'private' }; },
    async getBucketVersioning() { return { VersioningConfiguration: { Status: 'Enabled' } }; },
    async headObject() {
      if (!versions.size) throw { statusCode: 404, code: 'NoSuchKey' };
      return { ETag: 'synthetic-etag', headers: { 'content-length': String(body.length) } };
    },
    async getObject() { return { Body: body }; },
    async listObjectVersions() { return { Versions: [...versions].map(VersionId => ({ Key: key, VersionId })),
      DeleteMarkers: [], IsTruncated: 'false' }; },
    async deleteObject(input: { VersionId?: string }) { versions.delete(input.VersionId!); return {}; },
  };
  const store = archiveStoreFromEnv(env, client as unknown as COS);
  const now = new Date('2026-11-28T00:00:00Z');
  try {
    await pool.query(`INSERT INTO bb_log_segments(id,sink,state,byte_length,sha256,record_count,sealed_at)
      VALUES($1,'ndjson_file','sealed',$2,$3,1,$4)`, [id, body.length, hash, new Date(now.getTime() - 31 * 86_400_000)]);
    await pool.query(`INSERT INTO bb_log_archive_receipts(segment_id,object_key,byte_length,sha256,record_count)
      VALUES($1,$2,$3,$4,1)`, [id, key, body.length, hash]);
    await pool.query(`INSERT INTO bb_log_archive_lifecycle(segment_id,object_key,byte_length,sha256,record_count)
      VALUES($1,$2,$3,$4,1)`, [id, key, body.length, hash]);
    const result = await runArchiveLifecycle(pool, '', '', { retentionDays: 30, now: () => now }, env, store);
    assert.deepEqual(result, { due: 1, deleted: 1, rewritten: 0, skipped: 0, failed: 0 });
    assert.equal(versions.size, 0);
    assert.ok((await pool.query('SELECT deleted_at FROM bb_log_archive_lifecycle WHERE segment_id=$1', [id])).rows[0].deleted_at);
  } finally { await pool.end(); }
});
