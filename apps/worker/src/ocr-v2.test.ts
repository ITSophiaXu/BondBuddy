import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import {
  ocrPageIdentitySha256V2, ocrPageResultSha256V2,
  type OcrBatchRequestV2, type OcrBatchResponseV2, type OcrDocumentIdentityV2,
  type OcrPageCheckpointV2
} from '@bondbuddy/contracts';
import { enqueueMaterialParse } from '@bondbuddy/api/material-jobs';
import { readOcrV2Aggregate, readOcrV2Checkpoint, type OcrV2Scope } from '@bondbuddy/api/ocr-v2';
import { digest, transaction, uid, type PrivateBlobs } from '@bondbuddy/api/data';
import { isolatedTestDatabase } from './test-database.js';
import { processOcrV2, type OcrV2RunnerOptions } from './ocr-v2.js';

const connection = await isolatedTestDatabase();
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const source = Buffer.from('synthetic PDF bytes; no real OCR or customer material');

function memoryBlobs() {
  const stored = new Map<string, Buffer>();
  const blobs: PrivateBlobs = {
    async put(key, bytes) { stored.set(key, Buffer.from(bytes)); },
    async get(key) { const bytes = stored.get(key); if (!bytes) throw new Error('missing Blob'); return Buffer.from(bytes); },
    async getIfExists(key) { const bytes = stored.get(key); return bytes ? Buffer.from(bytes) : null; },
    async getIfExistsBounded(key, max) {
      const bytes = stored.get(key);
      return bytes && bytes.length <= max ? Buffer.from(bytes) : null;
    },
    async exists(key) { return stored.has(key); },
    async delete(key) { stored.delete(key); }
  };
  return { blobs, stored };
}

async function fixture(pool: Pool, blobs: PrivateBlobs, count: number) {
  const owner = uid(), projectId = uid(), materialId = uid(), uploadId = uid(), runId = uid();
  const objectKey = `users/${owner}/projects/${projectId}/materials/${uid()}`;
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, `ocr${uid().replaceAll('-', '').slice(0, 25)}`]);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic OCR v2','update')", [projectId, owner]);
  await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
    VALUES($1,$2,$3,'synthetic.pdf','application/pdf',$4,$5,'audit',$6,now()+interval '1 hour','completed')`,
  [uploadId, owner, projectId, source.length, digest(source), objectKey]);
  await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
    VALUES($1,1,$2,$3,$4,'audit','synthetic.pdf','application/pdf',$5,$6,$7,'persisted')`,
  [materialId, owner, projectId, uploadId, source.length, digest(source), objectKey]);
  await blobs.put(objectKey, source, 'application/pdf');
  await transaction(pool, async client => {
    await enqueueMaterialParse(client, { owner, projectId, materialId, materialVersion: 1, sha256: digest(source), traceId: uid() });
  });
  const inputHash = digest('synthetic immutable input');
  await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,1,$2,1,$3,'{}'::jsonb,$4,'[]'::jsonb)`,
  [projectId, owner, inputHash, JSON.stringify([{ material_id: materialId, material_version: 1 }])]);
  await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
    VALUES($1,$2,$3,1,$4,$5,'update',$6,'running')`,
  [runId, owner, projectId, inputHash, uid(), digest('synthetic request')]);
  const leaseToken = uid();
  await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,lease_token,lease_until)
    VALUES($1,$2,$3,'update','historical_revision','running','materials_ready',$4,now()+interval '1 hour')`,
  [uid(), owner, runId, leaseToken]);
  const full: OcrV2Scope = { owner, projectId, materialId, version: 1, purpose: 'full_ocr', runId, leaseToken,executionIdentity:{executionVersion:1,inputRevision:1,inputHash} };
  const preflight: OcrV2Scope = { owner, projectId, materialId, version: 1, purpose: 'source_preflight' };
  const document: OcrDocumentIdentityV2 = {
    owner_user_id: owner, project_id: projectId, page_count: count, processor_version: 'bondbuddy-ocr-2.0.1',
    material: { material_id: materialId, material_version: 1, media_type: 'application/pdf', sha256: digest(source) },
    engine: { name: 'tesseract', version: 'synthetic-only', language: 'eng',
      language_data_sha256: { eng: 'a'.repeat(64) }, parameters_sha256: 'b'.repeat(64) },
    rendering: { renderer: 'pdfium', renderer_version: 'synthetic-only', dpi: 250,
      max_page_pixels: 20_000_000, parameters_sha256: 'c'.repeat(64) }
  };
  return { full, preflight, document };
}

async function checkpoint(request: OcrBatchRequestV2, page: number) {
  const identity = { document: request.document, page };
  const identity_sha256 = await ocrPageIdentitySha256V2(identity);
  const result: OcrPageCheckpointV2['result'] = {
    page: { page, width: 1, height: 1, rotation_clockwise: 0,
      coordinate_system: 'rendered_pixels_top_left', image_sha256: digest(image), warnings: [] },
    records: [{ record_id: `p${page}-r1`, page, bbox: [0, 0, 1, 1], text: 'synthetic',
      confidence: 0.5, numeric: { kind: 'unparsed', decimal: null, unit: null },
      cell: null, uncertainty: ['synthetic_requires_confirmation'], eligible_for_manuscript: false }],
    status: 'needs_confirmation', eligible_for_manuscript: false
  };
  const value: OcrPageCheckpointV2 = { schema_version: 'ocr-page-checkpoint-v2', identity, identity_sha256,
    source_request_id: request.request_id, result,
    result_sha256: await ocrPageResultSha256V2({ identity_sha256, source_request_id: request.request_id, result }) };
  return value;
}

function runner(document: OcrDocumentIdentityV2, failPage?: number): OcrV2RunnerOptions & { calls: number[][] } {
  const calls: number[][] = [];
  return {
    calls, language: 'eng',
    probe: async () => ({ schema_version: 'ocr-identity-probe-response-v2', document }),
    invoke: async ({ request }) => {
      calls.push([...request.pages]);
      const outputs = [];
      const page_results: OcrBatchResponseV2['page_results'] = [];
      for (const page of request.pages) {
        if (page === failPage) {
          page_results.push({ page, status: 'failed', attempted: true, retryable: true, error: 'OCR_ENGINE_FAILED', warnings: [] });
        } else {
          const value = await checkpoint(request, page);
          outputs.push({ checkpoint: value, image_base64: image.toString('base64') });
          page_results.push({ page, status: 'succeeded', reused: false, checkpoint: {
            page, identity_sha256: value.identity_sha256, result_sha256: value.result_sha256, source_request_id: request.request_id
          } });
        }
      }
      return { schema_version: 'ocr-invocation-response-v2',
        response: { schema_version: 'ocr-response-v2', request_id: request.request_id,
          document, context: request.context, page_results,
          attempted_pages: request.pages.length, coverage: outputs.length ? 'partial' : 'none', eligible_for_manuscript: false },
        checkpoints: outputs };
    }
  };
}

test('v2 PostgreSQL physical-page resume, negative cache readback, retry and cost history (synthetic)', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const { blobs, stored } = memoryBlobs();
  try {
    const { full, preflight, document } = await fixture(pool, blobs, 74);
    await assert.rejects(processOcrV2(pool, blobs, full, runner({
      ...document, processor_version: 'bondbuddy-ocr-2.0.0'
    })), /OCR_INVALID_IDENTITY/);
    const first = runner(document, 74);
    const partial = await processOcrV2(pool, blobs, full, first);
    assert.deepEqual(first.calls.map(pages => [pages[0], pages.at(-1), pages.length]), [[1, 50, 50], [51, 74, 24]]);
    assert.equal(partial.aggregate.coverage, 'partial');
    assert.equal(partial.aggregate.successful_pages.length, 73);
    const retry = runner(document);
    const complete = await processOcrV2(pool, blobs, full, retry);
    assert.deepEqual(retry.calls, [[74]]);
    assert.equal(complete.aggregate.coverage, 'complete');
    const ref = complete.aggregate.successful_pages[0]!;
    await assert.rejects(readOcrV2Checkpoint(pool, blobs, { ...full, owner: uid() }, document, ref));
    const row = await pool.query('SELECT image_key FROM bb_ocr_v2_pages WHERE owner_user_id=$1 AND identity_sha256=$2',
      [full.owner, ref.identity_sha256]);
    stored.set(row.rows[0].image_key, Buffer.from('bad page bytes'));
    await assert.rejects(readOcrV2Aggregate(pool, blobs, full, document, complete.aggregate.context), /integrity/);
    await assert.rejects(processOcrV2(pool, blobs, full, runner(document)), /integrity/);
    stored.set(row.rows[0].image_key, image);
    const costs = await pool.query(`SELECT payload FROM bb_outbox WHERE aggregate_type='run'
      AND event_type='platform.processing_cost' AND owner_user_id=$1 ORDER BY created_at,id`, [full.owner]);
    assert.deepEqual(costs.rows.map(row => row.payload.quantity).sort((a, b) => a - b), [1, 24, 50]);
    assert.ok(costs.rows.every(row => row.payload.billable === false && row.payload.cost_payer === 'platform'));
    const wrongLease = { ...full, leaseToken: uid() };
    await assert.rejects(processOcrV2(pool, blobs, wrongLease, runner(document)), /active run/);
    await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE run_id=$1", [full.runId]);
    await assert.rejects(processOcrV2(pool, blobs, full, runner(document)), /active run/);
    // A separate source preflight has its own bounded first-three-page budget, not 74-page execution.
    const pre = await processOcrV2(pool, blobs, preflight, runner(document));
    assert.equal(pre.responses.length, 0); // exact prior success bytes may be reused across purposes
    await pool.query('UPDATE bb_material_versions SET deleted_at=now() WHERE id=$1', [full.materialId]);
    await assert.rejects(readOcrV2Aggregate(pool, blobs, full, document, complete.aggregate.context));
  } finally { await pool.end(); }
});

test('v2 interrupted partial write preserves success, unknown consumption and only retries missing pages (synthetic)', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const { blobs } = memoryBlobs();
  try {
    const { full, document } = await fixture(pool, blobs, 2);
    const interrupted = runner(document);
    interrupted.afterPage = async page => { if (page === 1) throw new Error('SYNTHETIC_CRASH'); };
    await assert.rejects(processOcrV2(pool, blobs, full, interrupted), /SYNTHETIC_CRASH/);
    const state = await pool.query("SELECT state,attempted_pages FROM bb_ocr_v2_batches WHERE owner_user_id=$1", [full.owner]);
    assert.equal(state.rows[0].state, 'interrupted');
    assert.equal(state.rows[0].attempted_pages, null);
    const resumed = runner(document);
    const result = await processOcrV2(pool, blobs, full, resumed);
    assert.deepEqual(resumed.calls, [[2]]);
    assert.equal(result.aggregate.coverage, 'complete');
    const costs = await pool.query(`SELECT payload FROM bb_outbox WHERE aggregate_type='run'
      AND event_type='platform.processing_cost' AND owner_user_id=$1 ORDER BY created_at,id`, [full.owner]);
    assert.deepEqual(costs.rows.map(row => row.payload.quantity), [null, 1]);
    assert.deepEqual(costs.rows.map(row => row.payload.outcome), ['failed', 'succeeded']);
  } finally { await pool.end(); }
});

test('v2 preflight attempts cannot evade the cumulative five-page budget via new request IDs (synthetic)', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const { blobs } = memoryBlobs();
  try {
    const { preflight, document } = await fixture(pool, blobs, 74);
    const first = runner(document, 1);
    const partial = await processOcrV2(pool, blobs, preflight, first);
    assert.deepEqual(first.calls, [[1, 2, 3]]);
    assert.equal(partial.aggregate.coverage, 'partial');
    const second = runner(document, 1);
    const retry = await processOcrV2(pool, blobs, preflight, second);
    assert.deepEqual(second.calls, [[1]]);
    assert.equal(retry.aggregate.coverage, 'partial');
    const third = runner(document, 1);
    await processOcrV2(pool, blobs, preflight, third);
    assert.deepEqual(third.calls, [[1]]);
    const denied = runner(document);
    await assert.rejects(processOcrV2(pool, blobs, preflight, denied), /budget exhausted/);
    assert.deepEqual(denied.calls, []);
    const costs = await pool.query(`SELECT payload->>'quantity' AS quantity FROM bb_outbox
      WHERE aggregate_type='material_parse_job' AND event_type='platform.processing_cost' AND owner_user_id=$1`, [preflight.owner]);
    assert.deepEqual(costs.rows.map(row => Number(row.quantity)).sort(), [1, 1, 3]);
  } finally { await pool.end(); }
});
