// Explicit boundary for the reference-library probe. Never echo connection strings.
const faultSource = 'synthetic_uncommitted_blob_fault';

export function validateProbeConfiguration(env, mode) {
  if (!['live', 'fault', 'recover', 'inventory'].includes(mode)) throw new Error('PROBE_MODE_INVALID');
  if (env.BB_REFERENCE_PROBE_ENV !== 'isolated') throw new Error('PROBE_ISOLATION_REQUIRED');
  if (!env.DATABASE_URL || !env.AZURE_STORAGE_CONNECTION_STRING) throw new Error('PROBE_TEST_STORAGE_REQUIRED');
  let db;
  try { db = new URL(env.DATABASE_URL); } catch { throw new Error('PROBE_DATABASE_REJECTED'); }
  const database = decodeURIComponent(db.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(db.protocol) || !/^bb_ref_probe_[a-z0-9_]+$/.test(database)
    || !env.BB_REFERENCE_PROBE_DB_HOST || db.hostname !== env.BB_REFERENCE_PROBE_DB_HOST) throw new Error('PROBE_DATABASE_REJECTED');
  const endpoint = /(?:^|;)BlobEndpoint=([^;]+)/.exec(env.AZURE_STORAGE_CONNECTION_STRING)?.[1];
  const account = /(?:^|;)AccountName=([^;]+)/.exec(env.AZURE_STORAGE_CONNECTION_STRING)?.[1];
  let blob;
  try { blob = new URL(endpoint); } catch { throw new Error('PROBE_BLOB_REJECTED'); }
  if (blob.protocol !== 'http:' || !/azurite/.test(blob.hostname) || !/^bbprobe[a-z0-9]*$/.test(account ?? '')) throw new Error('PROBE_BLOB_REJECTED');
  if (mode === 'recover' && env.BB_REFERENCE_PROBE_RECOVER !== faultSource) throw new Error('PROBE_RECOVERY_NOT_SELECTED');
  return { database, faultSource };
}

export async function assertProbeDatabase(pool, expectedDatabase, mode = 'inventory') {
  const result = await pool.query(`SELECT current_database() AS database,
    (SELECT count(*)::int FROM bb_projects WHERE id<>'bb-platform-probe-project') AS projects,
    (SELECT count(*)::int FROM bb_users WHERE id<>'bb-platform-probe') AS users,
    (SELECT count(*)::int FROM bb_runs) AS runs,
    (SELECT count(*)::int FROM bb_library_sources WHERE id NOT IN ('sse_bond_project_platform','synthetic_uncommitted_blob_fault') OR usage_rights<>'evaluation_only') AS foreign_sources,
    (SELECT count(*)::int FROM bb_library_documents WHERE source_id NOT IN ('sse_bond_project_platform','synthetic_uncommitted_blob_fault')) AS foreign_documents,
    (SELECT count(*)::int FROM bb_jobs WHERE job_type<>'library' OR library_source_id NOT IN ('sse_bond_project_platform','synthetic_uncommitted_blob_fault')) AS foreign_jobs,
    (SELECT count(*)::int FROM bb_library_document_versions WHERE state='published') AS published_versions,
    (SELECT count(*)::int FROM bb_library_sources) AS sources,
    (SELECT count(*)::int FROM bb_library_documents) AS documents,
    (SELECT count(*)::int FROM bb_jobs WHERE job_type='library') AS library_jobs`);
  const row = result.rows[0];
  if (!row || row.database !== expectedDatabase || ['projects','users','runs','foreign_sources','foreign_documents','foreign_jobs','published_versions'].some(key => Number(row[key]) !== 0)) {
    throw new Error('PROBE_DATABASE_NOT_DEDICATED');
  }
  if (['live', 'fault'].includes(mode) && ['sources', 'documents', 'library_jobs'].some(key => Number(row[key]) !== 0)) {
    throw new Error('PROBE_DATABASE_NOT_EMPTY');
  }
}
