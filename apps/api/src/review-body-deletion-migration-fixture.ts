import type { Pool, PoolClient } from 'pg';

/** Test-only: restore the exact four-table 0133 guards in a private clone. */
export async function removeReviewBodyDeletionScaffold(db: Pool | PoolClient): Promise<void> {
  const guards = [
    ['bb_review_editors', 'bb_review_editors_immutable'],
    ['bb_review_execution_editors', 'bb_review_execution_editor_immutable'],
    ['bb_review_reports', 'bb_review_report_immutable'],
    ['bb_review_execution_reports', 'bb_review_execution_report_immutable']
  ];
  for (const [table, immutable] of guards) {
    for (const name of ['bb_00_review_body_insert_live', 'bb_review_body_deleted', 'bb_review_body_no_truncate', immutable])
      await db.query(`DROP TRIGGER ${name} ON ${table}`);
    await db.query(`CREATE TRIGGER ${immutable} BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change()`);
  }
  await db.query('DROP TABLE bb_review_body_purges');
  for (const name of ['bb_record_review_body_purge()', 'bb_check_review_body_purge_receipt()',
    'bb_review_body_change_guard()', 'bb_review_body_insert_live()', 'bb_review_body_purge_policy(text,text)'])
    await db.query(`DROP FUNCTION ${name}`);
}
