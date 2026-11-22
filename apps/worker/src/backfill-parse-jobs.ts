// #17 legacy backfill: `node apps/worker/dist/backfill-parse-jobs.js [--dry-run]`.
// Materials verified before migration 0020 have no parse job. For each live material version
// whose upload completed (the verified-completion path), enqueue the same idempotent parse job the
// completion transaction would have created. Re-running is a no-op: enqueueMaterialParse uses the
// owner + material version + parser version unique key. No material bytes are read here.
import { Pool } from 'pg';
import { transaction, uid } from '@bondbuddy/api/data';
import { documentParserVersion, enqueueMaterialParse } from '@bondbuddy/api/material-jobs';

export type BackfillResult = {
  scanned: number;
  enqueued: number;
  existing: number;
  dry_run: boolean;
};

export async function backfillParseJobs(
  pool: Pool,
  options: { batchSize?: number; dryRun?: boolean; parserVersion?: string } = {},
): Promise<BackfillResult> {
  const batch = options.batchSize ?? 200,
    parserVersion = options.parserVersion ?? documentParserVersion();
  if (!Number.isInteger(batch) || batch < 1 || batch > 5000)
    throw new Error('Invalid backfill batch size');
  const result: BackfillResult = {
    scanned: 0,
    enqueued: 0,
    existing: 0,
    dry_run: !!options.dryRun,
  };
  let cursor = '';
  for (;;) {
    const q = await pool.query(
      `SELECT m.owner_user_id,m.project_id,m.id,m.version,lower(btrim(m.sha256::text)) AS sha256, m.owner_user_id||'/'||m.id||'/'||m.version AS k
      FROM bb_material_versions m
      JOIN bb_uploads u ON u.owner_user_id=m.owner_user_id AND u.id=m.upload_id AND u.state='completed'
      JOIN bb_projects p ON p.owner_user_id=m.owner_user_id AND p.id=m.project_id AND p.deleted_at IS NULL
      WHERE m.deleted_at IS NULL AND m.owner_user_id||'/'||m.id||'/'||m.version > $1
        AND NOT EXISTS (SELECT 1 FROM bb_jobs j WHERE j.job_type='parse' AND j.owner_user_id=m.owner_user_id AND j.project_id=m.project_id
          AND j.material_id=m.id AND j.material_version=m.version AND j.subtype='material_parse' AND j.parser_version=$2)
      ORDER BY k LIMIT $3`,
      [cursor, parserVersion, batch],
    );
    if (!q.rows.length) return result;
    for (const m of q.rows) {
      result.scanned++;
      cursor = m.k;
      if (options.dryRun) continue;
      const outcome = await transaction(pool, async (client) => {
        // Same lock order as upload completion and deletion: project, then the material row.
        const live = await client.query(
          'SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE',
          [m.owner_user_id, m.project_id],
        );
        const material = await client.query(
          'SELECT 1 FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL',
          [m.owner_user_id, m.project_id, m.id, m.version],
        );
        if (!live.rowCount || !material.rowCount) return null;
        return enqueueMaterialParse(client, {
          owner: m.owner_user_id,
          projectId: m.project_id,
          materialId: m.id,
          materialVersion: m.version,
          sha256: m.sha256,
          traceId: uid(),
          parserVersion,
        });
      });
      if (outcome?.created) result.enqueued++;
      else if (outcome) result.existing++;
    }
    if (q.rows.length < batch) return result;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    process.stdout.write(
      `${JSON.stringify(await backfillParseJobs(pool, { dryRun: process.argv.includes('--dry-run') }))}\n`,
    );
  } finally {
    await pool.end();
  }
}
