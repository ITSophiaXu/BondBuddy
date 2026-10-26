// Upgrade the genuine 0133 four-table schema in private PostgreSQL clones.
// The bodies, balances and source bytes are synthetic; no external services.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { isolatedTestDatabase } from './test-database.js';
import { createReviewBodyFixture, reviewBodyTables } from './review-body-deletion-test-fixture.js';
import { removeReviewBodyDeletionScaffold } from './review-body-deletion-migration-fixture.js';
import { purgeDeletedReviewBodies } from './review-body-deletion.js';

const connection = await isolatedTestDatabase(undefined, 'review-body-upgrade');
const busyConnection = await isolatedTestDatabase(undefined, 'review-body-upgrade-busy');
const migration = await readFile(new URL('../../../db/migrations/0134_review_body_deletion.sql', import.meta.url), 'utf8');

async function before134(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await removeReviewBodyDeletionScaffold(client);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

test('0133 to 0134 preserves existing live/deleted bodies, exact times and accounting before the separate deletion pass',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection, statement_timeout: 10000 });
    t.after(() => pool.end());
    await before134(pool);
    const live = await createReviewBodyFixture(pool), deleted = await createReviewBodyFixture(pool);
    await deleted.deleteProject();
    const liveRows = await live.rows(), deletedRows = await deleted.rows();
    const liveHistory = await live.history(), deletedHistory = await deleted.history();
    const globalGuard = (await pool.query("SELECT pg_get_functiondef('bb_reject_snapshot_change()'::regprocedure) AS source")).rows;
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query(migration); await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    assert.deepEqual(await live.rows(), liveRows);
    assert.deepEqual(await deleted.rows(), deletedRows, 'installing a guard does not itself purge business bodies');
    assert.deepEqual(await live.history(), liveHistory); assert.deepEqual(await deleted.history(), deletedHistory);
    assert.deepEqual((await pool.query("SELECT pg_get_functiondef('bb_reject_snapshot_change()'::regprocedure) AS source")).rows, globalGuard);
    assert.equal((await deleted.receipts()).length, 0);
    assert.deepEqual(await purgeDeletedReviewBodies(pool, { deletedContentPurgeDays: 7, ownerScope: deleted.owner }),
      { projectsPurged: 1, rowsPurged: 4, failed: 0 });
    for (const table of reviewBodyTables) assert.equal((await deleted.rows())[table].length, 0);
    assert.equal((await deleted.receipts()).length, 4);
    assert.deepEqual(await live.rows(), liveRows); assert.deepEqual(await deleted.history(), deletedHistory);
    await assert.rejects(deleted.insertEditor(), { code: '23514', constraint: 'bb_review_body_source_unavailable' });
    await assert.rejects(deleted.insertReport(), { code: '23514', constraint: 'bb_review_body_source_unavailable' });
  });

test('0134 NOWAIT installation rolls back completely while a rolling writer holds the parent table',
  { skip: !busyConnection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: busyConnection, statement_timeout: 10000 });
    t.after(() => pool.end()); await before134(pool);
    const f = await createReviewBodyFixture(pool), bodies = await f.rows();
    const blocker = await pool.connect(), installer = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM bb_projects WHERE id=$1 FOR UPDATE', [f.projectId]);
      await installer.query('BEGIN');
      await assert.rejects(installer.query(migration), { code: '55P03' });
      await installer.query('ROLLBACK');
      assert.equal((await pool.query("SELECT to_regclass('bb_review_body_purges') AS table_name")).rows[0].table_name, null);
      assert.deepEqual(await f.rows(), bodies);
      await assert.rejects(pool.query('DELETE FROM bb_review_editors WHERE run_id=$1', [f.runId]), { code: '23514' });
      await blocker.query('ROLLBACK');
      await installer.query('BEGIN'); await installer.query(migration); await installer.query('COMMIT');
      assert.deepEqual(await f.rows(), bodies);
      assert.equal((await f.receipts()).length, 0);
    } finally {
      await blocker.query('ROLLBACK'); await installer.query('ROLLBACK');
      blocker.release(); installer.release();
    }
  });
