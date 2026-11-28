import { purgeAccountRecovery } from './recovery-lifecycle.js';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { DATA_POLICY_VERSION, DELETION_PURGED_CONTENT, DELETION_RETAINED_METADATA, type DataPolicy } from '@bondbuddy/contracts';
import { transaction, uid, type PrivateBlobs } from './data.js';
import { privateBlobsFromEnv } from './storage-provider.js';
import { purgeLogContent, retentionPolicyFromEnv } from './log-ops.js';
import { runStorageLifecycle, storageLifecyclePolicyFromEnv, type StorageLifecyclePolicy } from './storage-lifecycle.js';
import { parseInventoryKey } from './storage-inventory.js';

const MAX_BATCH_SIZE = 50;

/**
 * The public data policy is derived from the same variables the purge jobs read (0006 storage lifecycle,
 * 0021 log retention), plus the backup lifetime owned by deployment. Unset windows are null, never 0.
 */
export function dataPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): DataPolicy {
  const storage = storageLifecyclePolicyFromEnv(env);
  const backup = env.BB_BACKUP_RETENTION_DAYS;
  const backupDays = backup !== undefined && /^\d{1,4}$/.test(backup) && Number(backup) <= 3650 ? Number(backup) : null;
  if (backup !== undefined && backup !== '' && backupDays === null) throw new Error('BB_BACKUP_RETENTION_DAYS must be an integer from 0 to 3650');
  return {
    policy_version: DATA_POLICY_VERSION,
    storage_location: 'platform_private_cloud',
    server_side_processing: true,
    model_provider_processing: true,
    active_retention: 'until_user_deletes',
    purge_enabled: storage !== null,
    deleted_content_purge_days: storage?.materialRetentionDays ?? null,
    orphan_upload_purge_hours: storage?.orphanUploadGraceHours ?? null,
    log_content_retention_days: retentionPolicyFromEnv(env).contentRetentionDays,
    backup_retention_days: backupDays,
    pinned_by_active_run: 'retained_until_run_ends',
    purged_content: [...DELETION_PURGED_CONTENT],
    retained_metadata: [...DELETION_RETAINED_METADATA]
  };
}

export type DeletedContentPolicy = {
  /** Same value as StorageLifecyclePolicy.materialRetentionDays: days after deletion before content is purged. */
  deletedContentPurgeDays: number;
  batchSize?: number;
  now?: () => Date;
  /** Test/restore-verifier scope only. The CLI never sets it. */
  ownerScope?: string;
  /** Failure-injection hook: crash after Blob deletes but before the PostgreSQL receipt commits. */
  afterBlobDeletes?: (subject: string) => Promise<void>;
};

export type DeletedContentResult = { materialsPurged: number; projectsPurged: number; objectsDeleted: number; failed: number };

type StoredOcr = { page_objects?: Record<string, { key?: unknown }> };

async function purgeOcrObjects(pool: Pool, blobs: PrivateBlobs, t: { owner_user_id: string; project_id: string; material_id: string; material_version: number }) {
  const snapshots = await pool.query(`SELECT s.id,s.result_key,
      EXISTS (SELECT 1 FROM bb_ocr_snapshots o JOIN bb_material_versions m
                ON m.owner_user_id=o.owner_user_id AND m.project_id=o.project_id AND m.id=o.material_id AND m.version=o.material_version
               WHERE o.owner_user_id=s.owner_user_id AND o.result_key=s.result_key AND m.deleted_at IS NULL) AS shared
    FROM bb_ocr_snapshots s
   WHERE s.owner_user_id=$1 AND s.project_id=$2 AND s.material_id=$3 AND s.material_version=$4`,
    [t.owner_user_id, t.project_id, t.material_id, t.material_version]);
  let deleted = 0;
  for (const snapshot of snapshots.rows) {
    if (snapshot.shared) continue;
    // Page keys are listed only in the result object: delete pages first, the result last, so a crash
    // between the two leaves a result that still names every remaining page.
    const bytes = await blobs.getIfExists(snapshot.result_key);
    if (bytes) {
      let stored: StoredOcr = {};
      try { stored = JSON.parse(bytes.toString()) as StoredOcr; } catch { /* unreadable result: delete it below */ }
      const prefix = `users/${t.owner_user_id}/projects/${t.project_id}/ocr/${t.material_id}/${t.material_version}/`;
      for (const page of Object.values(stored.page_objects ?? {})) {
        if (typeof page?.key === 'string' && page.key.startsWith(prefix)) { await blobs.delete(page.key); deleted++; }
      }
      await blobs.delete(snapshot.result_key); deleted++;
    }
  }
  const v2 = await pool.query(`SELECT checkpoint_key,image_key FROM bb_ocr_v2_pages WHERE owner_user_id=$1
    AND project_id=$2 AND material_id=$3 AND material_version=$4`,
    [t.owner_user_id, t.project_id, t.material_id, t.material_version]);
  for (const page of v2.rows) {
    await blobs.delete(page.image_key); deleted++;
    await blobs.delete(page.checkpoint_key); deleted++;
  }
  return deleted;
}

async function purgeOrphanedParseCache(pool: Pool, blobs: PrivateBlobs, owner: string, sha256: string) {
  // The parse cache is keyed by owner + content hash, so it is shared by identical files in other projects.
  const rows = await pool.query(`SELECT c.object_key,c.parser_version,c.ocr_version,c.basis_version FROM bb_parse_cache c
    WHERE c.owner_user_id=$1 AND c.content_sha256=$2
      AND NOT EXISTS (SELECT 1 FROM bb_material_versions m WHERE m.owner_user_id=c.owner_user_id AND m.sha256=c.content_sha256 AND m.deleted_at IS NULL)`,
    [owner, sha256]);
  for (const row of rows.rows) {
    await blobs.delete(row.object_key);
    await pool.query(`DELETE FROM bb_parse_cache WHERE owner_user_id=$1 AND content_sha256=$2 AND parser_version=$3 AND ocr_version=$4 AND basis_version=$5
      AND NOT EXISTS (SELECT 1 FROM bb_material_versions m WHERE m.owner_user_id=$1 AND m.sha256=$2 AND m.deleted_at IS NULL)`,
      [owner, sha256, row.parser_version, row.ocr_version, row.basis_version]);
  }
  return rows.rowCount ?? 0;
}

async function purgeMaterialDerived(pool: Pool, blobs: PrivateBlobs, policy: DeletedContentPolicy, batchSize: number) {
  // Runs only after 0006 purged the original bytes, which already enforces the window and the active-run pin.
  const due = await pool.query(`SELECT t.id,t.owner_user_id,t.project_id,t.material_id,t.material_version,t.sha256
      FROM bb_storage_tombstones t
     WHERE t.object_kind='material' AND t.state='purged'
       AND ($1::text IS NULL OR t.owner_user_id=$1)
       AND NOT EXISTS (SELECT 1 FROM bb_deleted_content_purges r WHERE r.storage_tombstone_id=t.id)
     ORDER BY t.purged_at,t.id LIMIT $2`, [policy.ownerScope ?? null, batchSize]);
  let purged = 0, objects = 0, failed = 0;
  for (const t of due.rows) {
    try {
      const ocr = await purgeOcrObjects(pool, blobs, t);
      const cache = await purgeOrphanedParseCache(pool, blobs, t.owner_user_id, t.sha256.trim());
      await policy.afterBlobDeletes?.(t.id);
      await transaction(pool, async client => {
        await client.query("SELECT set_config('bb.deleted_content_purge','on',true)");
        const evidence = await client.query('DELETE FROM bb_parse_evidence WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4',
          [t.owner_user_id, t.project_id, t.material_id, t.material_version]);
        const receipt = await client.query(`INSERT INTO bb_deleted_content_purges
          (id,owner_user_id,project_id,subject_kind,material_id,material_version,storage_tombstone_id,parse_evidence_rows,ocr_objects,parse_cache_objects,policy_version)
          VALUES($1,$2,$3,'material_version',$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (storage_tombstone_id) DO NOTHING RETURNING id`,
          [uid(), t.owner_user_id, t.project_id, t.material_id, t.material_version, t.id, evidence.rowCount ?? 0, ocr, cache, DATA_POLICY_VERSION]);
        if (receipt.rowCount) await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
          VALUES($1,$2,'material',$3,'material.derived_content_purged',$4)`,
          [uid(), t.owner_user_id, t.material_id, { project_id: t.project_id, material_version: t.material_version, receipt_id: receipt.rows[0].id }]);
      });
      purged++; objects += ocr + cache;
    } catch { failed++; }
  }
  return { purged, objects, failed };
}

async function purgeDeletedProjects(pool: Pool, blobs: PrivateBlobs, policy: DeletedContentPolicy, batchSize: number, now: Date) {
  const due = await pool.query(`SELECT p.owner_user_id,p.id FROM bb_projects p
     WHERE p.deleted_at IS NOT NULL AND p.deleted_at + ($1::integer * interval '1 day') <= $2::timestamptz
       AND ($3::text IS NULL OR p.owner_user_id=$3)
       AND NOT EXISTS (SELECT 1 FROM bb_runs r WHERE r.owner_user_id=p.owner_user_id AND r.project_id=p.id
         AND r.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected'))
       AND NOT EXISTS (SELECT 1 FROM bb_deleted_content_purges r WHERE r.subject_kind='project' AND r.owner_user_id=p.owner_user_id AND r.project_id=p.id)
     ORDER BY p.deleted_at,p.id LIMIT $4`, [policy.deletedContentPurgeDays, now, policy.ownerScope ?? null, batchSize]);
  let purged = 0, objects = 0, failed = 0;
  for (const p of due.rows) {
    try {
      const artifacts = await pool.query(`SELECT a.object_key FROM bb_artifact_versions a JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id
        WHERE r.owner_user_id=$1 AND r.project_id=$2`, [p.owner_user_id, p.id]);
      for (const a of artifacts.rows) await blobs.delete(a.object_key);
      const authoringObjects = await purgeAuthoringObjects(pool, blobs, p.owner_user_id, p.id);
            const templates=await pool.query(`SELECT DISTINCT r->>'object_key' AS object_key FROM bb_file_template_sets s,
        LATERAL jsonb_array_elements(s.records) r WHERE s.owner_user_id=$1 AND s.project_id=$2`,[p.owner_user_id,p.id]);
      for(const t of templates.rows)await blobs.delete(t.object_key);
      const artifactObjects = (artifacts.rowCount ?? 0) + authoringObjects + (templates.rowCount ?? 0);
      await policy.afterBlobDeletes?.(p.id);
      await transaction(pool, async client => {
        const receipt = await client.query(`INSERT INTO bb_deleted_content_purges(id,owner_user_id,project_id,subject_kind,artifact_objects,policy_version)
          VALUES($1,$2,$3,'project',$4,$5) ON CONFLICT (owner_user_id,project_id) WHERE subject_kind='project' DO NOTHING RETURNING id`,
          [uid(), p.owner_user_id, p.id, artifactObjects, DATA_POLICY_VERSION]);
        if (receipt.rowCount) await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
          VALUES($1,$2,'project',$3,'project.content_purged',$4)`, [uid(), p.owner_user_id, p.id, { receipt_id: receipt.rows[0].id, artifact_objects: artifactObjects, authoring_objects: authoringObjects }]);
      });
      purged++; objects += artifactObjects;
    } catch { failed++; }
  }
  return { purged, objects, failed };
}

async function purgeAuthoringObjects(pool: Pool, blobs: PrivateBlobs, owner: string, project: string) {
  const runs = await pool.query('SELECT id FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2', [owner, project]);
  if (!runs.rowCount) return 0;
  if (!blobs.listPage) throw Error('Authoring content purge requires private Blob listing');
  let deleted = 0;
  for (const run of runs.rows) {
    for (const directory of ['file-authoring', 'format-diagnostics']) {
      const prefix = `owners/${owner}/projects/${project}/runs/${run.id}/${directory}/`;
      let continuation: string | undefined;
      // Each retry deletes another bounded batch before attempting its receipt.
      for (let pageNo = 0; pageNo < 20; pageNo++) {
        const page = await blobs.listPage(prefix, continuation, 100);
        if (page.items.length > 100) throw Error('Authoring content listing exceeded page bound');
        for (const item of page.items) {
          if (!item.key.startsWith(prefix)) throw Error('Authoring content listing escaped owned run');
          if (!['file_authoring', 'format_report'].includes(parseInventoryKey(item.key))) continue;
          await blobs.delete(item.key); deleted++;
        }
        continuation = page.continuation;
        if (!continuation) break;
      }
      if (continuation) throw Error('Authoring content purge batch incomplete');
    }
  }
  return deleted;
}

/**
 * One bounded, idempotent batch. Blob deletes are replay-safe (delete-if-exists) and happen before the
 * PostgreSQL receipt, so a crash at any point is recovered by the next run; the receipt makes it a no-op after.
 */
export async function runDeletedContentPurge(pool: Pool, blobs: PrivateBlobs, policy: DeletedContentPolicy): Promise<DeletedContentResult> {
  if (!Number.isSafeInteger(policy.deletedContentPurgeDays) || policy.deletedContentPurgeDays < 0) throw new Error('Deleted content purge requires a non-negative integer window');
  const batchSize = Math.min(MAX_BATCH_SIZE, policy.batchSize ?? MAX_BATCH_SIZE);
  const now = (policy.now ?? (() => new Date()))();
  const materials = await purgeMaterialDerived(pool, blobs, policy, batchSize);
  const projects = await purgeDeletedProjects(pool, blobs, policy, batchSize, now);
  return { materialsPurged: materials.purged, projectsPurged: projects.purged, objectsDeleted: materials.objects + projects.objects, failed: materials.failed + projects.failed };
}

/** Full user-deletion pass: original bytes (0006), derived content (0026), prompt/provider content (#79). */
export async function runUserDeletionLifecycle(pool: Pool, blobs: PrivateBlobs, storage: StorageLifecyclePolicy, logContentRetentionDays: number) {
  const storageResult = await runStorageLifecycle(pool, blobs, storage);
  const derived = await runDeletedContentPurge(pool, blobs, { deletedContentPurgeDays: storage.materialRetentionDays, now: storage.now, ownerScope: storage.ownerScope, batchSize: storage.batchSize });
  const logs = await purgeLogContent(pool, blobs, { contentRetentionDays: logContentRetentionDays, deletedProjectPurgeDays: storage.materialRetentionDays, now: storage.now, ownerScope: storage.ownerScope ? [storage.ownerScope] : undefined });
  const recovery = await purgeAccountRecovery(pool,storage.ownerScope);
  return { storage: storageResult, derived, logs, recovery };
}

async function main() {
  const storage = storageLifecyclePolicyFromEnv();
  if (!storage) { process.stdout.write('User deletion purge disabled; no objects changed\n'); return; }
  if (!process.env.DATABASE_URL) throw new Error('Enabled deletion purge requires DATABASE_URL');
  const blobs = privateBlobsFromEnv();
  if (!blobs) throw new Error('Enabled deletion purge requires private object storage');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await runUserDeletionLifecycle(pool, blobs, storage, retentionPolicyFromEnv().contentRetentionDays);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.storage.failed + result.derived.failed + result.logs.failed > 0) process.exitCode = 1;
  } finally { await pool.end(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => { process.stderr.write('User deletion purge failed; durable tombstones and receipts allow a safe retry\n'); process.exitCode = 1; });
}
