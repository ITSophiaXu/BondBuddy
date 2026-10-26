import {readFile} from 'node:fs/promises';
import type {Pool} from 'pg';

// Replay tests need the real predecessor consumers, not PL/pgSQL bodies that
// still reference the registry being removed. Keep billing logic and its later
// task-type extensions sourced from the deployed migrations themselves.
const oldDelivery = await readFile(new URL('../../../db/migrations/0129_review_execution_artifacts.sql', import.meta.url), 'utf8');
const oldFinalizer = await readFile(new URL('../../../db/migrations/0105_m4_dynamic_balance.sql', import.meta.url), 'utf8');
const finalizerExtensions = await Promise.all(['0106_m4_case_templates.sql', '0111_project_file_workspace.sql']
  .map(name => readFile(new URL(`../../../db/migrations/${name}`, import.meta.url), 'utf8')));

function originalFunction(sql: string, name: string) {
  const header = new RegExp(`CREATE(?: OR REPLACE)? FUNCTION ${name}\\(`).exec(sql);
  const start = header?.index ?? -1;
  const body = start < 0 ? -1 : sql.indexOf('AS $$', start);
  const end = body < 0 ? -1 : sql.indexOf('$$;', body + 'AS $$'.length);
  if (start < 0 || body < start || end < body) throw Error(`Missing original M4 test predecessor function: ${name}`);
  return sql.slice(start, end + '$$;'.length).replace(/^CREATE(?: OR REPLACE)? FUNCTION/, 'CREATE OR REPLACE FUNCTION');
}

function originalFinalizerExtension(sql: string) {
  const anchor = "SELECT pg_get_functiondef('bb_m4_credit_finalize_run()'::regprocedure)";
  const position = sql.indexOf(anchor);
  const start = position < 0 ? -1 : sql.lastIndexOf('DO $$', position);
  const end = position < 0 ? -1 : sql.indexOf('END $$;', position);
  if (position < 0 || start < 0 || end < position || sql.indexOf(anchor, position + anchor.length) >= 0)
    throw Error('Missing unique original M4 finalizer task-type extension');
  return sql.slice(start, end + 'END $$;'.length);
}

export async function removeM4ArtifactExecutionScaffold(db: Pick<Pool, 'query'>) {
  await db.query(`DROP FUNCTION IF EXISTS bb_check_m4_execution_artifact(),bb_guard_legacy_m4_artifact(),
      bb_bridge_m4_execution_artifact(),bb_mirror_m4_execution_artifact() CASCADE;
    DROP VIEW IF EXISTS bb_m4_artifact_execution_versions,bb_m4_execution_artifact_versions CASCADE;
    DROP TABLE IF EXISTS bb_m4_execution_artifacts CASCADE;
    ALTER TABLE IF EXISTS bb_m4_execution_snapshots DROP CONSTRAINT IF EXISTS bb_m4_execution_snapshot_artifact_key;`);
  // Older replay tests can dismantle 0125/0126 twice. Do not recreate a builder
  // whose bb_run_execution_deliveries composite row type no longer exists.
  if ((await db.query("SELECT to_regclass('bb_run_execution_deliveries') AS relation")).rows[0].relation)
    await db.query(originalFunction(oldDelivery, 'bb_run_execution_delivery_plan'));
  await db.query(originalFunction(oldFinalizer, 'bb_m4_credit_finalize_run'));
  for (const extension of finalizerExtensions) await db.query(originalFinalizerExtension(extension));
}
