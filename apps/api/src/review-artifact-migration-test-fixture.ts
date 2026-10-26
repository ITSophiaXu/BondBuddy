import {readFile} from 'node:fs/promises';
import type {Pool} from 'pg';

// Private clone replay tests must restore the real predecessor consumers along
// with the schema; a function still reading the removed registry is not 0128.
const oldReady = await readFile(new URL('../../../db/migrations/0110_review_dual_word_settlement.sql', import.meta.url), 'utf8');
const oldDelivery = await readFile(new URL('../../../db/migrations/0126_run_execution_deliveries.sql', import.meta.url), 'utf8');
function originalFunction(sql: string, name: string) {
  const start = sql.indexOf(`CREATE FUNCTION ${name}(`);
  const end = sql.indexOf('END; $$;', start);
  if (start < 0 || end < start) throw Error(`Missing original test predecessor function: ${name}`);
  return sql.slice(start, end + 'END; $$;'.length).replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
}
export async function removeReviewArtifactExecutionScaffold(db: Pick<Pool, 'query'>) {
  await db.query(`DROP FUNCTION IF EXISTS bb_check_review_execution_artifact(),bb_guard_review_execution_artifact(),bb_guard_legacy_review_artifact(),
    bb_bridge_review_execution_artifact(),bb_mirror_review_execution_artifact() CASCADE;
    DROP TABLE IF EXISTS bb_review_execution_artifacts CASCADE;`);
  await db.query(originalFunction(oldReady, 'bb_review_delivery_ready'));
  // Some 0125 lock tests tear their schema down twice. After the first replay,
  // the 0126 composite row types do not exist and its builder must stay absent.
  if ((await db.query("SELECT to_regclass('bb_run_execution_deliveries') AS relation")).rows[0].relation)
    await db.query(originalFunction(oldDelivery, 'bb_run_execution_delivery_plan'));
}
