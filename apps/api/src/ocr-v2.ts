import type { Pool, PoolClient } from 'pg';
import { Value } from '@sinclair/typebox/value';
import {
  OcrDocumentIdentityV2Schema, validateOcrAggregateV2, validateOcrBatchRequestV2,
  validateOcrBatchResponseV2, validateOcrPageCheckpointV2, ocrPageIdentitySha256V2,
  type OcrAggregateV2, type OcrBatchRequestV2, type OcrBatchResponseV2,
  type OcrCheckpointRefV2, type OcrDocumentIdentityV2, type OcrExecutionContextV2,
  type OcrPageCheckpointV2
} from '@bondbuddy/contracts';
import { authorizeOcrMaterial } from './ocr.js';
import { digest, missing, Problem, project, transaction, uid, type PrivateBlobs } from './data.js';

export type OcrV2Scope = {
  owner: string; projectId: string; materialId: string; version: number;
  purpose: 'source_preflight' | 'full_ocr'; runId?: string; leaseToken?: string;
};
const MAX_CHECKPOINT_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 48 * 1024 * 1024;
const integrity = () => new Problem(503, 'DATA_UNAVAILABLE', 'OCR v2 checkpoint integrity failed');
const invalid = () => new Problem(422, 'VALIDATION_FAILED', 'Invalid OCR v2 identity');

/** Never accept document/context authority from Python or a caller without this DB check. */
export async function authorizeOcrV2(pool: Pool | PoolClient, scope: OcrV2Scope, document: OcrDocumentIdentityV2, lock = false) {
  if (!Value.Check(OcrDocumentIdentityV2Schema, document) ||
    document.owner_user_id !== scope.owner || document.project_id !== scope.projectId ||
    document.material.material_id !== scope.materialId || document.material.material_version !== scope.version) throw invalid();
  const source = await authorizeOcrMaterial(pool, {
    owner: scope.owner, projectId: scope.projectId, materialId: scope.materialId, version: scope.version,
    requestId: 'ocr-v2-authorize', purpose: scope.purpose, runId: scope.runId
  }, lock);
  if (document.material.sha256 !== source.sha256.trim() || document.material.media_type !== source.media_type) throw invalid();
  if (scope.purpose === 'source_preflight') {
    const job = await pool.query(`SELECT id FROM bb_jobs WHERE job_type='parse' AND owner_user_id=$1 AND project_id=$2
      AND material_id=$3 AND material_version=$4 AND material_sha256=$5
      AND state NOT IN ('failed','cancelled') ORDER BY created_at DESC,id DESC LIMIT 1`,
    [scope.owner, scope.projectId, scope.materialId, scope.version, source.sha256.trim()]);
    if (!job.rows[0]) throw new Problem(409, 'CAPABILITY_NOT_READY', 'Source preflight requires a durable parse job');
    return { jobId: job.rows[0].id as string, context: { purpose: 'source_preflight', run: null, billable: false, cost_payer: 'platform' } as const };
  }
  const run = await pool.query(`SELECT r.id,r.execution_request_id,r.input_revision,r.input_hash,j.id AS job_id
    FROM bb_runs r JOIN bb_jobs j ON j.owner_user_id=r.owner_user_id AND j.run_id=r.id
    JOIN bb_input_revisions i ON i.owner_user_id=r.owner_user_id AND i.project_id=r.project_id AND i.revision=r.input_revision
    WHERE r.owner_user_id=$1 AND r.project_id=$2 AND r.id=$3 AND r.state='running'
      AND r.input_hash=i.input_hash AND j.state='running' AND j.lease_token=$6 AND j.lease_until>now()
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(i.material_versions) m
        WHERE m->>'material_id'=$4 AND (m->>'material_version')::integer=$5)`,
  [scope.owner, scope.projectId, scope.runId ?? '', scope.materialId, scope.version, scope.leaseToken ?? '']);
  if (!run.rows[0]) throw new Problem(409, 'CAPABILITY_NOT_READY', 'Full OCR requires an active run and locked material');
  const row = run.rows[0];
  return { jobId: row.job_id as string, context: {
    purpose: 'full_ocr', run: { run_id: row.id as string, execution_request_id: row.execution_request_id as string,
      input_revision: row.input_revision as number, input_hash: (row.input_hash as string).trim() },
    billable: false, cost_payer: 'platform'
  } as const };
}

type PageRow = {
  page: number; identity_sha256: string; result_sha256: string; source_request_id: string;
  checkpoint_key: string; checkpoint_blob_sha256: string; image_key: string; image_sha256: string;
  document_identity: OcrDocumentIdentityV2; request: OcrBatchRequestV2;
};

async function readPage(blobs: PrivateBlobs,
  document: OcrDocumentIdentityV2, row: PageRow) {
  const identity = { document, page: row.page };
  if (row.identity_sha256.trim() !== await ocrPageIdentitySha256V2(identity) ||
    !Value.Equal(row.document_identity, document) || !row.request.pages.includes(row.page) ||
    row.source_request_id !== row.request.request_id) throw integrity();
  const json = await blobs.getIfExistsBounded(row.checkpoint_key, MAX_CHECKPOINT_BYTES);
  const image = await blobs.getIfExistsBounded(row.image_key, MAX_IMAGE_BYTES);
  if (!json || !image || digest(json) !== row.checkpoint_blob_sha256.trim() ||
      digest(image) !== row.image_sha256.trim()) throw integrity();
  let checkpoint: unknown;
  try { checkpoint = JSON.parse(json.toString('utf8')); }
  catch { throw integrity(); }
  try {
    const verified = await validateOcrPageCheckpointV2(checkpoint, identity, image);
    if (verified.identity_sha256 !== row.identity_sha256.trim() ||
        verified.result_sha256 !== row.result_sha256.trim() ||
        verified.source_request_id !== row.source_request_id ||
        verified.result.page.image_sha256 !== row.image_sha256.trim()) throw integrity();
    return { checkpoint: verified, image };
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw integrity();
  }
}

/** Owner-scoped private read-back: neither a DB status nor a hash without bytes is a cache hit. */
export async function readOcrV2Pages(pool: Pool | PoolClient, blobs: PrivateBlobs,
  scope: OcrV2Scope, document: OcrDocumentIdentityV2) {
  await project(pool, scope.owner, scope.projectId);
  const source = await pool.query(`SELECT 1 FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2
    AND id=$3 AND version=$4 AND deleted_at IS NULL AND sha256=$5 AND media_type=$6`, [
    scope.owner, scope.projectId, scope.materialId, scope.version, document.material.sha256, document.material.media_type
  ]);
  if (!source.rowCount || document.owner_user_id !== scope.owner || document.project_id !== scope.projectId ||
      document.material.material_id !== scope.materialId || document.material.material_version !== scope.version) throw missing();
  const rows = await pool.query<PageRow>(`SELECT p.*,b.document_identity,b.request FROM bb_ocr_v2_pages p
    JOIN bb_ocr_v2_batches b ON b.id=p.source_request_id AND b.owner_user_id=p.owner_user_id
      AND b.project_id=p.project_id AND b.material_id=p.material_id AND b.material_version=p.material_version
    WHERE p.owner_user_id=$1 AND p.project_id=$2 AND p.material_id=$3 AND p.material_version=$4
    ORDER BY p.page`, [scope.owner, scope.projectId, scope.materialId, scope.version]);
  const found = new Map<number, OcrCheckpointRefV2>();
  for (const row of rows.rows) {
    if (!Value.Equal(row.document_identity, document)) continue;
    const { checkpoint } = await readPage(blobs, document, row);
    if (found.has(row.page)) throw integrity();
    found.set(row.page, { page: row.page, identity_sha256: checkpoint.identity_sha256,
      result_sha256: checkpoint.result_sha256, source_request_id: checkpoint.source_request_id });
  }
  return found;
}

export async function readOcrV2Checkpoint(pool: Pool | PoolClient, blobs: PrivateBlobs,
  scope: OcrV2Scope, document: OcrDocumentIdentityV2, ref: OcrCheckpointRefV2) {
  await project(pool, scope.owner, scope.projectId);
  const rows = await pool.query<PageRow>(`SELECT p.*,b.document_identity,b.request FROM bb_ocr_v2_pages p
    JOIN bb_ocr_v2_batches b ON b.id=p.source_request_id AND b.owner_user_id=p.owner_user_id
    WHERE p.owner_user_id=$1 AND p.project_id=$2 AND p.material_id=$3 AND p.material_version=$4 AND p.identity_sha256=$5`,
    [scope.owner, scope.projectId, scope.materialId, scope.version, ref.identity_sha256]);
  const row = rows.rows[0];
  if (!row || row.page !== ref.page || row.result_sha256.trim() !== ref.result_sha256 ||
      row.source_request_id !== ref.source_request_id ||
      document.owner_user_id !== scope.owner || document.project_id !== scope.projectId ||
      document.material.material_id !== scope.materialId ||
      document.material.material_version !== scope.version) throw integrity();
  const active = await pool.query(`SELECT 1 FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2
    AND id=$3 AND version=$4 AND deleted_at IS NULL AND sha256=$5`,
  [scope.owner, scope.projectId, scope.materialId, scope.version, document.material.sha256]);
  if (!active.rowCount) throw missing();
  return readPage(blobs, document, row);
}

export async function readOcrV2Aggregate(pool: Pool, blobs: PrivateBlobs,
  scope: OcrV2Scope, document: OcrDocumentIdentityV2, context: OcrExecutionContextV2): Promise<OcrAggregateV2> {
  const pages = await readOcrV2Pages(pool, blobs, scope, document);
  const successful_pages = [...pages.values()]
    .filter(ref => context.purpose !== 'source_preflight' || ref.page <= 5)
    .sort((a, b) => a.page - b.page);
  const aggregate: OcrAggregateV2 = { schema_version: 'ocr-aggregate-v2', document, context, successful_pages,
    coverage: successful_pages.length === document.page_count ? 'complete' : successful_pages.length ? 'partial' : 'none',
    eligible_for_manuscript: false };
  await validateOcrAggregateV2(aggregate, { document, context },
    ref => readOcrV2Checkpoint(pool, blobs, scope, document, ref));
  return aggregate;
}

async function recordBatchCost(client: PoolClient, batch: any, quantity: number | null, outcome: 'succeeded' | 'failed') {
  const job = await client.query('SELECT id FROM bb_jobs WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',
    [batch.job_id, batch.owner_user_id]);
  if (!job.rows[0]) throw integrity();
  const prior = await client.query(`SELECT COALESCE(max((payload->>'attempt')::integer),0) AS attempt FROM bb_outbox
    WHERE owner_user_id=$1 AND event_type='platform.processing_cost' AND payload->>'job_id'=$2
      AND payload->>'stage'='ocr'`, [batch.owner_user_id, batch.job_id]);
  // Parse-worker attempts are at most 10; keep the v2 batch namespace distinct even
  // when a paused v1 hook is later resumed on the same job.
  const attempt = Math.max(1000, Number(prior.rows[0].attempt)) + 1;
  const payload = { job_id: batch.job_id, material_id: batch.material_id, material_version: batch.material_version,
    stage: 'ocr', attempt, unit: 'ocr_page', quantity,
    processing_ms: Math.max(1, Date.now() - new Date(batch.created_at).getTime()),
    billable: false, cost_payer: 'platform', pricing_status: 'unknown', unit_price_ref: null,
    outcome, ocr_pages: quantity, ocr_engine: batch.document_identity.engine.name,
    ocr_engine_version: batch.document_identity.engine.version };
  await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
    VALUES($1,$2,$3,$4,'platform.processing_cost',$5)`, [
    uid(), batch.owner_user_id, batch.purpose === 'source_preflight' ? 'material_parse_job' : 'run',
    batch.purpose === 'source_preflight' ? batch.job_id : batch.context.run.run_id, payload
  ]);
}

/** Finish orphaned attempts before retrying; their consumption is unknown, never zero. */
export async function settleInterruptedOcrV2(pool: Pool, scope: OcrV2Scope) {
  return transaction(pool, async client => {
    await project(client, scope.owner, scope.projectId, true);
    const rows = await client.query(`SELECT * FROM bb_ocr_v2_batches WHERE owner_user_id=$1 AND project_id=$2
      AND material_id=$3 AND material_version=$4 AND state='started' ORDER BY created_at,id FOR UPDATE`,
      [scope.owner, scope.projectId, scope.materialId, scope.version]);
    for (const row of rows.rows) {
      await client.query("UPDATE bb_ocr_v2_batches SET state='interrupted',finished_at=now() WHERE id=$1", [row.id]);
      await recordBatchCost(client, row, null, 'failed');
    }
  });
}

export async function beginOcrV2Batch(pool: Pool, scope: OcrV2Scope, request: OcrBatchRequestV2) {
  await validateOcrBatchRequestV2(request);
  return transaction(pool, async client => {
    const { jobId, context } = await authorizeOcrV2(client, scope, request.document, true);
    if (!Value.Equal(request.context, context)) throw invalid();
    const rows = await client.query(`SELECT state,attempted_pages,request FROM bb_ocr_v2_batches
      WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4
        AND purpose='source_preflight'`, [scope.owner, scope.projectId, scope.materialId, scope.version]);
    if (scope.purpose === 'source_preflight') {
      const reserved = rows.rows.reduce((sum: number, row: any) =>
        sum + (row.attempted_pages === null ? row.request.pages.length : row.attempted_pages), 0);
      if (reserved + request.pages.length > 5) throw new Problem(409, 'CAPABILITY_NOT_READY', 'Source preflight OCR budget exhausted');
    }
    await client.query(`INSERT INTO bb_ocr_v2_batches(id,owner_user_id,project_id,material_id,material_version,
      document_identity,context,job_id,purpose,request,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'started')`, [
      request.request_id, scope.owner, scope.projectId, scope.materialId, scope.version,
      request.document, context, jobId, scope.purpose, request
    ]);
    await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'ocr_v2_batch',$3,'ocr.batch_started',$4)`, [
      uid(), scope.owner, request.request_id, { project_id: scope.projectId, material_id: scope.materialId,
        purpose: scope.purpose, page_count: request.pages.length }
    ]);
  });
}

export async function persistOcrV2Page(pool: Pool, blobs: PrivateBlobs, scope: OcrV2Scope,
  request: OcrBatchRequestV2, checkpoint: OcrPageCheckpointV2, image: Buffer) {
  if (!request.pages.includes(checkpoint.identity.page) || checkpoint.source_request_id !== request.request_id) throw invalid();
  await validateOcrPageCheckpointV2(checkpoint, { document: request.document, page: checkpoint.identity.page }, image);
  const prefix = `users/${scope.owner}/projects/${scope.projectId}/ocr-v2/${scope.materialId}/${scope.version}/${checkpoint.identity_sha256}`;
  const imageKey = `${prefix}/${checkpoint.result_sha256}.png`;
  const checkpointKey = `${prefix}/${checkpoint.result_sha256}.json`;
  const json = Buffer.from(JSON.stringify(checkpoint));
  if (json.length > MAX_CHECKPOINT_BYTES) throw invalid();
  await blobs.put(imageKey, image, 'image/png');
  await blobs.put(checkpointKey, json, 'application/json');
  const persistedImage = await blobs.getIfExistsBounded(imageKey, MAX_IMAGE_BYTES);
  const persistedJson = await blobs.getIfExistsBounded(checkpointKey, MAX_CHECKPOINT_BYTES);
  if (!persistedImage || !persistedJson || digest(persistedImage) !== checkpoint.result.page.image_sha256 ||
      digest(persistedJson) !== digest(json)) throw integrity();
  await transaction(pool, async client => {
    await authorizeOcrV2(client, scope, request.document, true);
    const batch = await client.query(`SELECT 1 FROM bb_ocr_v2_batches WHERE id=$1 AND owner_user_id=$2
      AND project_id=$3 AND state='started' AND request=$4`, [request.request_id, scope.owner, scope.projectId, request]);
    if (!batch.rowCount) throw invalid();
    await client.query(`INSERT INTO bb_ocr_v2_pages(owner_user_id,project_id,material_id,material_version,identity_sha256,
      result_sha256,source_request_id,page,checkpoint_key,checkpoint_blob_sha256,image_key,image_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
      scope.owner, scope.projectId, scope.materialId, scope.version, checkpoint.identity_sha256,
      checkpoint.result_sha256, request.request_id, checkpoint.identity.page, checkpointKey, digest(json),
      imageKey, checkpoint.result.page.image_sha256
    ]);
    await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'ocr_v2_batch',$3,'ocr.page_saved',$4)`, [
      uid(), scope.owner, request.request_id, { project_id: scope.projectId, page: checkpoint.identity.page,
        identity_sha256: checkpoint.identity_sha256, result_sha256: checkpoint.result_sha256 }
    ]);
  });
  await readOcrV2Checkpoint(pool, blobs, scope, request.document, {
    page: checkpoint.identity.page, identity_sha256: checkpoint.identity_sha256,
    result_sha256: checkpoint.result_sha256, source_request_id: request.request_id
  });
}

export async function finishOcrV2Batch(pool: Pool, blobs: PrivateBlobs, scope: OcrV2Scope,
  request: OcrBatchRequestV2, response: OcrBatchResponseV2) {
  await validateOcrBatchResponseV2(response, request,
    ref => readOcrV2Checkpoint(pool, blobs, scope, request.document, ref));
  await transaction(pool, async client => {
    await authorizeOcrV2(client, scope, request.document, true);
    const q = await client.query(`SELECT * FROM bb_ocr_v2_batches WHERE id=$1 AND owner_user_id=$2
      AND project_id=$3 FOR UPDATE`, [request.request_id, scope.owner, scope.projectId]);
    const batch = q.rows[0];
    if (!batch || batch.state !== 'started' || !Value.Equal(batch.request, request)) throw invalid();
    await client.query(`UPDATE bb_ocr_v2_batches SET state='finished',response=$2,
      attempted_pages=$3,finished_at=now() WHERE id=$1`, [batch.id, response, response.attempted_pages]);
    await recordBatchCost(client, batch, response.attempted_pages,
      response.page_results.every(result => result.status === 'succeeded') ? 'succeeded' : 'failed');
    await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'ocr_v2_batch',$3,'ocr.batch_finished',$4)`, [
      uid(), scope.owner, batch.id, { project_id: scope.projectId, coverage: response.coverage,
        failed_pages: response.page_results.filter(result => result.status === 'failed').map(result => result.page) }
    ]);
  });
}
