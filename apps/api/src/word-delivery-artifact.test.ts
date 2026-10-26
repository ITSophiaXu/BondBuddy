import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { digest, type PrivateBlobs } from './data.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';

test('checked revision metadata exposes clean and baseline downloads with pending review summary', async () => {
  const bytes = makeSyntheticDocxFixture();
  const summary = { writer_version: 'bondbuddy-word-delivery-1.0.0', revision_artifact_id: 'word-revision',
    clean_artifact_id: 'word-clean', baseline_artifact_id: 'word-baseline', source_sha256: 'a'.repeat(64),
    baseline_hash: 'b'.repeat(64), effective_baseline_sha256: 'c'.repeat(64), plan_hash: 'd'.repeat(64),
    replacements: 1, columns: 1, pending: 1, pending_review: [{ record_id: 'evidence-000001', message: '待人工确认：材料缺失' }] };
  let owner = 'owner-a';
  const query = async (sql: string, values: unknown[] = []) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM bb_delivered_artifact_versions a')) {
      if (owner !== 'owner-a' || !['word-revision', 'word-clean', 'word-baseline'].includes(String(values[1]))) return { rows: [] };
      return { rows: [{ id: values[1], owner_user_id: owner, project_id: 'project-a', run_id: 'run-1', version: 1,
        media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sha256: digest(bytes), quality_status: 'passed', delivery_status: 'available', object_key: `private/${values[1]}`,
        naming_created_at:'2026-10-09T02:00:00Z',naming_manifest:{name:'冻结项目'},naming_input_revision:3,naming_pair:summary,delivery_evidence_byte_size: bytes.length }] };
    }
    if (sql.includes('FROM bb_artifact_execution_bindings b')) {
      const [requestedOwner,runId,artifactId,version] = values;
      if (requestedOwner !== 'owner-a' || runId !== 'run-1' || version !== 1
        || !['word-revision','word-clean','word-baseline'].includes(String(artifactId))) return { rows: [] };
      return { rows: [{ owner_user_id: requestedOwner,project_id:'project-a',run_id:runId,
        artifact_id:artifactId,artifact_version:version,execution_version:1,input_revision:3,input_hash:'a'.repeat(64),
        run_input_revision:3,run_input_hash:'a'.repeat(64),
        artifact_media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        artifact_sha256:digest(bytes),artifact_object_key:'private/'+artifactId }] };
    }
    if (sql.includes('FROM bb_jobs')) return { rows: [{ pair: summary }] };
    if (sql.includes('SELECT channel FROM bb_runs')) return { rows: [{ channel: 'production' }], rowCount: 1 };
    if (sql.includes('SELECT 1 FROM bb_artifact_download_grants')) return {rows:[{}]};
    if (sql.includes('INSERT INTO bb_artifact_download_grants')) return { rows: [] };
    if (sql.includes('INSERT INTO bb_operations') || sql.includes('INSERT INTO bb_observability_events') || sql.includes('INSERT INTO bb_outbox')) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  const blobs = { getIfExistsBounded: async () => bytes } as unknown as PrivateBlobs;
  const app = createServer({ pool, blobs, principal: async () => ({ userId: owner, csrfVerified: true }), allowedOrigin: 'http://bondbuddy.test' });
  try {
    const revision = await app.inject('/api/v1/artifacts/word-revision');
    assert.equal(revision.statusCode, 200, revision.body);
    assert.equal(revision.json().word_delivery.variant, 'revision');
    assert.equal(revision.json().word_delivery.clean_artifact_id, 'word-clean');
    assert.equal(revision.json().word_delivery.baseline_artifact_id, 'word-baseline');
    assert.deepEqual(revision.json().word_delivery.pending_review, summary.pending_review);
    const clean = await app.inject('/api/v1/artifacts/word-clean');
    assert.equal(clean.statusCode, 200, clean.body);
    assert.equal(clean.json().word_delivery.variant, 'clean');
    assert.equal(revision.json().filename,'冻结项目_募集书修订版_V3_20261009.docx');
    assert.equal(clean.json().filename,'冻结项目_募集书清洁版_V3_20261009.docx');
    const download=await app.inject(clean.json().download_url);
    assert.equal(download.statusCode,200,download.body);
    assert.ok(download.headers['content-disposition']?.includes(encodeURIComponent(clean.json().filename)));
    assert.deepEqual(download.rawPayload,bytes);
    assert.equal((await app.inject('/api/v1/artifacts/word-clean')).json().filename,clean.json().filename);
    owner = 'owner-b';
    assert.equal((await app.inject('/api/v1/artifacts/word-revision')).statusCode, 404);
  } finally { await app.close(); }
});
