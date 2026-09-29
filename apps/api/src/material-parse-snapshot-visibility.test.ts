import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { azureBlobs, digest } from './data.js';
import { createServer } from './server.js';
import { PDF, pdfSample } from './upload-safety.samples.js';

// Synthetic data only. Needs a migrated PostgreSQL 16 and Azurite; otherwise it skips.
import { isolatedTestDatabase } from './test-database.js';
const connection = await isolatedTestDatabase();
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const origin = 'http://bondbuddy.test';

test('owner material read exposes the current non-failed parse snapshot for reference pinning', { skip: !connection || !blobConnection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const owner = `snapshot-${randomUUID()}`;
  const blobs = azureBlobs(blobConnection!, `bb-snapshot-${randomUUID().replaceAll('-', '')}`);
  const app = createServer({ pool, blobs, principal: async () => ({ userId: owner, csrfVerified: true }), allowedOrigin: origin });
  const send = (method: string, url: string, payload?: unknown, extra: Record<string, string> = {}) => app.inject({ method: method as any, url, headers: { origin, ...extra }, payload: payload as any });
  const pdf = pdfSample();
  const sha = digest(pdf);
  const insertSnapshot = async (projectId: string, materialId: string, version: number, id: string, status: 'parsed' | 'needs_confirmation' | 'failed') => {
    const recordCount = status === 'failed' ? 0 : 1;
    const parserVersion = `parser-${id}`;
    await pool.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,response_status,response_schema_version,response_sha256,record_count,response_meta)
      VALUES($1,$2,$3,$4,$5,$6,$10,$6,$7,'document-parse-response-v1',$6,$8,$9)`,
    [id, owner, projectId, materialId, version, sha, status, recordCount,
      { schema_version: 'document-parse-response-v1', request_id: `req-${id}`, status, parser_version: parserVersion, material: { material_id: materialId, material_version: version, sha256: sha }, warnings: [], document: {}, error: status === 'failed' ? { code: 'SYNTHETIC_FAILURE' } : null }, parserVersion]);
  };

  try {
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, `u${owner.replace(/-/g, '_')}`.slice(0, 32)]);
    const project = await send('POST', '/api/v1/projects', { name: '合成参考项目', kind: 'generation', issuer_name: null, market: 'sse', offering: 'private' });
    assert.equal(project.statusCode, 201, project.body);
    const projectId = project.json().project_id as string;
    const created = await send('POST', `/api/v1/projects/${projectId}/materials/uploads`, { filename: 'reference.pdf', media_type: PDF, byte_size: pdf.length, sha256: sha, role: 'reference' });
    assert.equal(created.statusCode, 201, created.body);
    const put = await send('PUT', created.json().upload_url, pdf, { 'content-type': 'application/octet-stream' });
    assert.equal(put.statusCode, 204, put.body);
    const done = await send('POST', `/api/v1/projects/${projectId}/materials/uploads/${created.json().upload_id}/complete`, { byte_size: pdf.length, sha256: sha });
    assert.equal(done.statusCode, 200, done.body);
    const materialId = done.json().material_id as string;
    const version = done.json().material_version as number;

    // No parse snapshot yet: the field is present and null, so the browser does not guess an id.
    const before = await send('GET', `/api/v1/projects/${projectId}/materials/${materialId}`);
    assert.equal(before.statusCode, 200, before.body);
    assert.equal(before.json().parse_snapshot_id, null);
    assert.equal(Object.hasOwn(before.json(), 'parse_snapshot_id'), true);

    await insertSnapshot(projectId, materialId, version, 'snap-parsed-1', 'parsed');
    const parsed = await send('GET', `/api/v1/projects/${projectId}/materials/${materialId}`);
    assert.equal(parsed.json().parse_snapshot_id, 'snap-parsed-1');

    // A newer needs_confirmation snapshot supersedes it.
    await insertSnapshot(projectId, materialId, version, 'snap-confirm-2', 'needs_confirmation');
    assert.equal((await send('GET', `/api/v1/projects/${projectId}/materials/${materialId}`)).json().parse_snapshot_id, 'snap-confirm-2');

    // The newest snapshot failed: expose null rather than a stale older snapshot.
    await insertSnapshot(projectId, materialId, version, 'snap-failed-3', 'failed');
    assert.equal((await send('GET', `/api/v1/projects/${projectId}/materials/${materialId}`)).json().parse_snapshot_id, null);

    // A fresh success after the failure is visible again.
    await insertSnapshot(projectId, materialId, version, 'snap-parsed-4', 'parsed');
    assert.equal((await send('GET', `/api/v1/projects/${projectId}/materials/${materialId}`)).json().parse_snapshot_id, 'snap-parsed-4');

    // Another owner cannot read the material or its snapshot id.
    const other = `other-${randomUUID()}`;
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [other, `u${other.replace(/-/g, '_')}`.slice(0, 32)]);
    const otherApp = createServer({ pool, blobs, principal: async () => ({ userId: other, csrfVerified: true }), allowedOrigin: origin });
    try {
      const foreign = await otherApp.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/materials/${materialId}`, headers: { origin } });
      assert.equal(foreign.statusCode, 404);
    } finally { await otherApp.close(); }
  } finally {
    await pool.end();
  }
});
