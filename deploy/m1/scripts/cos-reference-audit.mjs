// Read-only check of explicit PostgreSQL object references against the COS application bucket.
// Run during a write fence; implied authoring-run directories need a separate inventory check.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import COS from 'cos-nodejs-sdk-v5';
import pg from 'pg';

export const referencesSql = `
  SELECT 'upload' kind, object_key key FROM bb_uploads WHERE state <> 'purged'
  UNION ALL SELECT 'material', m.object_key FROM bb_material_versions m
    WHERE NOT EXISTS (SELECT 1 FROM bb_storage_tombstones t WHERE t.object_key=m.object_key AND t.state='purged')
  UNION ALL SELECT 'snapshot', s.object_key FROM bb_snapshot_refs s
    WHERE NOT EXISTS (SELECT 1 FROM bb_log_content_tombstones t WHERE t.object_key=s.object_key)
  UNION ALL SELECT 'artifact', object_key FROM bb_artifact_versions WHERE object_key IS NOT NULL
  UNION ALL SELECT 'parse_cache', object_key FROM bb_parse_cache WHERE object_key IS NOT NULL
  UNION ALL SELECT 'ocr_result', result_key FROM bb_ocr_snapshots WHERE result_key IS NOT NULL
  UNION ALL SELECT 'ocr_checkpoint', checkpoint_key FROM bb_ocr_v2_pages WHERE checkpoint_key IS NOT NULL
  UNION ALL SELECT 'ocr_page', image_key FROM bb_ocr_v2_pages WHERE image_key IS NOT NULL
  UNION ALL SELECT 'provider_result', p.result_ref FROM bb_provider_result_refs p
    WHERE NOT EXISTS (SELECT 1 FROM bb_log_content_tombstones t WHERE t.object_key=p.result_ref)
  UNION ALL SELECT 'review_assistant_result', result_ref FROM bb_review_assistant_attempts WHERE result_ref IS NOT NULL
  UNION ALL SELECT 'review_pdf_evidence', object_key FROM bb_review_pdf_delivery_evidence
  UNION ALL SELECT 'upload_integrity_receipt', object_key FROM bb_upload_integrity_receipts
  UNION ALL SELECT 'upload_confirmation', object_key FROM bb_upload_confirmations
  UNION ALL SELECT 'upload_confirmation_canonical', canonical_object_key FROM bb_upload_confirmations WHERE canonical_object_key IS NOT NULL
  UNION ALL SELECT 'upload_confirmation_canonical_list', key FROM bb_upload_confirmations,
    LATERAL unnest(canonical_object_keys) key
  UNION ALL SELECT 'exec_log', object_key FROM bb_codex_exec_logs
  UNION ALL SELECT 'library_document', blob_key FROM bb_library_document_versions
  UNION ALL SELECT 'prompt_intent', object_key FROM bb_prompt_blob_intents
    WHERE registered_at IS NULL AND cleared_at IS NULL
  UNION ALL SELECT 'file_template', record->>'object_key' FROM bb_file_template_sets,
    LATERAL jsonb_array_elements(records) record WHERE record->>'object_key' IS NOT NULL
  UNION ALL SELECT 'log_archive', object_key FROM bb_log_archive_lifecycle
    WHERE deleted_at IS NULL AND object_key IS NOT NULL
  UNION ALL SELECT 'log_archive_pending', pending_old_key FROM bb_log_archive_lifecycle
    WHERE deleted_at IS NULL AND pending_old_key IS NOT NULL
  UNION ALL SELECT 'log_archive_receipt', r.object_key FROM bb_log_archive_receipts r
    LEFT JOIN bb_log_archive_lifecycle l ON l.segment_id=r.segment_id
    WHERE l.segment_id IS NULL AND r.object_key IS NOT NULL`;

const keyHash = key => createHash('sha256').update(key).digest('hex');
const absent = error => error?.code === 'NoSuchKey' || error?.statusCode === 404 && error?.code !== 'NoSuchBucket';

/** Fail closed on any unknown COS response; never return customer object keys. */
export async function auditCosReferences(rows, head, concurrency = 8) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32)
    throw new Error('Invalid COS audit concurrency');
  const keys = new Map();
  for (const row of rows) {
    if (typeof row.key !== 'string' || !row.key || typeof row.kind !== 'string')
      throw new Error('Invalid database object reference');
    const kinds = keys.get(row.key) || new Set();
    kinds.add(row.kind); keys.set(row.key, kinds);
  }
  const entries = [...keys];
  let present = 0, missing = 0;
  const missingHashes = [];
  for (let at = 0; at < entries.length; at += concurrency) {
    await Promise.all(entries.slice(at, at + concurrency).map(async ([key]) => {
      let exists;
      try { exists = await head(key); }
      catch (error) { if (absent(error)) exists = false; else throw error; }
      if (typeof exists !== 'boolean') throw new Error('Invalid COS HEAD result');
      if (exists) present++;
      else { missing++; if (missingHashes.length < 20) missingHashes.push(keyHash(key)); }
    }));
  }
  return { referenceRows: rows.length, uniqueKeys: entries.length, present, missing,
    missingKeySha256: missingHashes.sort(), coverage: 'explicit_database_references_only' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  if (env.BB_COS_RECONCILE_ACK !== 'write-fenced')
    throw new Error('Run only at a database/object write fence (BB_COS_RECONCILE_ACK=write-fenced)');
  if (!env.DATABASE_URL || !env.BB_COS_SECRET_ID || !env.BB_COS_SECRET_KEY || !env.BB_COS_BUCKET || !env.BB_COS_REGION)
    throw new Error('Database and COS application bucket configuration required');
  if (env.BB_COS_BUCKET === env.BB_COS_BACKUP_BUCKET) throw new Error('Application and backup COS buckets must differ');
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
  const client = new COS({ SecretId: env.BB_COS_SECRET_ID, SecretKey: env.BB_COS_SECRET_KEY });
  const db = await pool.connect();
  try {
    await client.headBucket({ Bucket: env.BB_COS_BUCKET, Region: env.BB_COS_REGION });
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const rows = (await db.query(referencesSql)).rows;
    await db.query('COMMIT');
    const report = await auditCosReferences(rows, async key => {
      await client.headObject({ Bucket: env.BB_COS_BUCKET, Region: env.BB_COS_REGION, Key: key });
      return true;
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.missing) process.exitCode = 1;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { db.release(); await pool.end(); }
}
