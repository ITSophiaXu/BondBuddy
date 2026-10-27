// Real PostgreSQL deletion, visibility and lock races; all bodies are synthetic.
// This suite proves four review SQL-body copies only, not full project cleanup,
// provider/Word acceptance, supplement adoption or pricing.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { DATA_POLICY_VERSION } from '@bondbuddy/contracts';
import { uid } from './data.js';
import { runDeletedContentPurge } from './deletion-lifecycle.js';
import { purgeLogContent } from './log-ops.js';
import { purgeDeletedReviewBodies } from './review-body-deletion.js';
import { createReviewBodyFixture, noReviewBodyBlobs, reviewBodyTables, type ReviewBodyTable } from './review-body-deletion-test-fixture.js';
import { isolatedTestDatabase } from './test-database.js';

const connection = await isolatedTestDatabase(undefined, 'review-body-deletion');
const checked = (constraint?: string) => (error: unknown) => {
  const row = error as { code?: string; constraint?: string };
  return row.code === '23514' && (!constraint || row.constraint === constraint);
};
const pool = () => new Pool({ connectionString: connection, max: 6, statement_timeout: 10000 });
type Fixture = Awaited<ReturnType<typeof createReviewBodyFixture>>;
const zero = { projectsPurged: 0, rowsPurged: 0, failed: 0 };
function policy(f: Fixture, extra: Record<string, unknown> = {}) {
  return { version: 'review_body_purge_v1', owner_user_id: f.owner, project_id: f.projectId,
    deleted_content_purge_days: 7, policy_version: DATA_POLICY_VERSION, ...extra };
}
async function withRollback(db: Pool, work: (client: PoolClient) => Promise<void>, isolation = '') {
  const client = await db.connect();
  try { await client.query('BEGIN' + isolation); await work(client); }
  finally { await client.query('ROLLBACK'); client.release(); }
}
const context = (client: PoolClient, value: unknown) => client.query("SELECT set_config('bb.review_body_purge',$1,true)", [typeof value === 'string' ? value : JSON.stringify(value)]);
const bodyCount = async (f: Fixture) => Object.values(await f.rows()).reduce((sum, rows) => sum + rows.length, 0);
const replay = (client: Pool | PoolClient, table: ReviewBodyTable, row: unknown) => client.query('INSERT INTO ' + table
  + ' SELECT * FROM jsonb_populate_record(NULL::' + table + ',$1::jsonb) ON CONFLICT DO NOTHING', [JSON.stringify(row)]);
async function waitBlocked(db: Pool, waiting: number, blocker: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const row = (await db.query("SELECT wait_event_type='Lock' AND $2::int=ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid=$1", [waiting, blocker])).rows[0];
    if (row?.blocked) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Expected PostgreSQL lock dependency was not observed');
}
async function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 4000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

test('deleted review body pass revisits an old artifact receipt, preserves exact source and ledger metadata, and is idempotent',
  { skip: !connection, timeout: 30000 }, async t => {
    const db = pool(); t.after(() => db.end());
    const f = await createReviewBodyFixture(db), other = await createReviewBodyFixture(db);
    await f.deleteProject(); await other.deleteProject();
    const before = await f.rows(), originalHistory = await f.history(), otherBefore = await other.rows();
    await db.query('INSERT INTO bb_deleted_content_purges(id,owner_user_id,project_id,subject_kind,artifact_objects,policy_version) '
      + "VALUES($1,$2,$3,'project',3,'synthetic-old-artifact-only')", [uid(), f.owner, f.projectId]);
    const oldReceipt = (await db.query('SELECT to_jsonb(t) AS receipt FROM bb_deleted_content_purges t WHERE owner_user_id=$1', [f.owner])).rows;
    const result = await runDeletedContentPurge(db, noReviewBodyBlobs, { ownerScope: f.owner, deletedContentPurgeDays: 7 });
    assert.equal(result.projectsPurged, 0, 'the old artifact receipt is not rewritten or counted again');
    assert.deepEqual(result.reviewBodies, { projectsPurged: 1, rowsPurged: 4, failed: 0 });
    assert.equal(result.failed, 0); assert.equal(await bodyCount(f), 0);
    assert.deepEqual(await f.history(), originalHistory, 'input, business origin, run/job and nonempty credit history stay exact');
    assert.deepEqual(await other.rows(), otherBefore, 'owner scope cannot remove another deleted project');
    assert.deepEqual((await db.query('SELECT to_jsonb(t) AS receipt FROM bb_deleted_content_purges t WHERE owner_user_id=$1', [f.owner])).rows, oldReceipt);
    const receipts = await f.receipts(); assert.equal(receipts.length, 4);
    for (const table of reviewBodyTables) {
      const body = before[table][0], receipt = receipts.find(row => row.body_kind === table);
      assert.ok(receipt); assert.equal(receipt.owner_user_id, f.owner); assert.equal(receipt.project_id, f.projectId);
      assert.equal(receipt.run_id, f.runId); assert.equal(receipt.execution_version, 1);
      assert.equal(receipt.input_revision, 1); assert.equal(receipt.input_hash, f.hash);
      assert.equal(receipt.body_id, body.id ?? f.runId); assert.equal(receipt.body_sha256, body.sha256 ?? body.content_sha256);
      assert.equal(receipt.report_version, table.includes('reports') ? 1 : null);
      assert.equal(receipt.policy_version, DATA_POLICY_VERSION); assert.equal(receipt.purge_window_days, 7);
      assert.equal((await db.query('SELECT body_created_at=$3::timestamptz AS exact_time, '
        + "to_char(body_created_at,'US') LIKE '%123' AS retained_microseconds FROM bb_review_body_purges WHERE body_kind=$1 AND run_id=$2",
      [table, f.runId, body.created_at])).rows[0].exact_time, true);
      assert.equal((await db.query("SELECT to_char(body_created_at,'US') LIKE '%123' AS exact FROM bb_review_body_purges WHERE body_kind=$1 AND run_id=$2", [table, f.runId])).rows[0].exact, true);
      assert.ok(!('snapshot' in receipt)); assert.ok(!('report' in receipt));
      assert.ok(!JSON.stringify(receipt).includes('Synthetic private'));
    }
    const second = await runDeletedContentPurge(db, noReviewBodyBlobs, { ownerScope: f.owner, deletedContentPurgeDays: 7 });
    assert.deepEqual(second.reviewBodies, zero); assert.equal(second.failed, 0);
    assert.deepEqual(await f.receipts(), receipts);
  });

test('terminal and archived live-project bodies outlive log retention; a future service clock cannot shorten the deletion window',
  { skip: !connection, timeout: 30000 }, async t => {
    const db = pool(); t.after(() => db.end());
    const f = await createReviewBodyFixture(db), before = await f.rows();
    const future = () => new Date('2126-10-27T00:00:00Z');
    const logs = await purgeLogContent(db, noReviewBodyBlobs, { contentRetentionDays: 1, now: future, ownerScope: [f.owner] });
    assert.equal(logs.failed, 0); assert.deepEqual(await f.rows(), before);
    const live = await runDeletedContentPurge(db, noReviewBodyBlobs, { ownerScope: f.owner, deletedContentPurgeDays: 7, now: future });
    assert.deepEqual(live.reviewBodies, zero); assert.deepEqual(await f.rows(), before);
    await db.query('UPDATE bb_projects SET archived_at=now() WHERE id=$1', [f.projectId]);
    assert.deepEqual(await purgeDeletedReviewBodies(db, { ownerScope: f.owner, deletedContentPurgeDays: 7 }), zero);
    await f.deleteProject(0);
    const early = await runDeletedContentPurge(db, noReviewBodyBlobs, { ownerScope: f.owner, deletedContentPurgeDays: 7, now: future });
    assert.deepEqual(early.reviewBodies, zero); assert.deepEqual(await f.rows(), before); assert.deepEqual(await f.receipts(), []);
    assert.deepEqual(await purgeDeletedReviewBodies(db, { ownerScope: uid(), deletedContentPurgeDays: 0 }), zero);
  });

test('review body DELETE requires exact due service policy and READ COMMITTED; UPDATE never becomes a purge operation',
  { skip: !connection, timeout: 40000 }, async t => {
    const db = pool(); t.after(() => db.end());
    const f = await createReviewBodyFixture(db), early = await createReviewBodyFixture(db);
    await f.deleteProject(); await early.deleteProject(0);
    const before = await f.rows();
    const contexts: unknown[] = [null, '', '{', {}, policy(f, { owner_user_id: uid() }), policy(f, { project_id: uid() }),
      policy(f, { version: 'unknown' }), policy(f, { deleted_content_purge_days: -1 }), policy(f, { deleted_content_purge_days: 1.1 }),
      policy(f, { deleted_content_purge_days: 9007199254740992 }), policy(f, { unexpected: true })];
    for (const value of contexts) await withRollback(db, async client => {
      if (value !== null) await context(client, value);
      await assert.rejects(client.query('DELETE FROM bb_review_editors WHERE run_id=$1', [f.runId]), checked());
    });
    await withRollback(db, async client => {
      await client.query("SELECT set_config('bb.deleted_content_purge','on',true)");
      await assert.rejects(client.query('DELETE FROM bb_review_editors WHERE run_id=$1', [f.runId]), checked());
    });
    await withRollback(db, async client => {
      await context(client, policy(early));
      await assert.rejects(client.query('DELETE FROM bb_review_editors WHERE run_id=$1', [early.runId]), checked('bb_review_body_purge_policy'));
    });
    for (const isolation of [' ISOLATION LEVEL REPEATABLE READ', ' ISOLATION LEVEL SERIALIZABLE']) await withRollback(db, async client => {
      await context(client, policy(f));
      await assert.rejects(client.query('DELETE FROM bb_review_editors WHERE run_id=$1', [f.runId]), checked('bb_review_body_purge_isolation'));
    }, isolation);
    for (const table of reviewBodyTables) await withRollback(db, async client => {
      await context(client, policy(f));
      await assert.rejects(client.query('UPDATE ' + table + ' SET created_at=created_at WHERE run_id=$1', [f.runId]), checked('bb_review_body_immutable'));
    });
    assert.deepEqual(await f.rows(), before); assert.deepEqual(await f.receipts(), []);
  });

test('the fourth-table failure rolls back all previous body deletes and receipts; retry completes without forged completion',
  { skip: !connection, timeout: 30000 }, async t => {
    const db = pool(); t.after(() => db.end()); const f = await createReviewBodyFixture(db);
    await f.deleteProject(); const before = await f.rows();
    await db.query("CREATE FUNCTION bb_test_review_body_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic fourth table failure'; END $$");
    await db.query('CREATE TRIGGER bb_test_review_body_failure BEFORE DELETE ON bb_review_execution_reports FOR EACH ROW EXECUTE FUNCTION bb_test_review_body_failure()');
    try {
      assert.deepEqual(await purgeDeletedReviewBodies(db, { ownerScope: f.owner, deletedContentPurgeDays: 7 }), { projectsPurged: 0, rowsPurged: 0, failed: 1 });
      assert.deepEqual(await f.rows(), before); assert.deepEqual(await f.receipts(), []);
    } finally {
      await db.query('DROP TRIGGER bb_test_review_body_failure ON bb_review_execution_reports');
      await db.query('DROP FUNCTION bb_test_review_body_failure()');
    }
    assert.deepEqual(await purgeDeletedReviewBodies(db, { ownerScope: f.owner, deletedContentPurgeDays: 7 }), { projectsPurged: 1, rowsPurged: 4, failed: 0 });
    assert.equal((await f.receipts()).length, 4);
  });

test('deleted projects reject all four exact replays and new keys; receipt inserts, changes and truncation cannot replace an actual DELETE',
  { skip: !connection, timeout: 40000 }, async t => {
    const db = pool(); t.after(() => db.end()); const f = await createReviewBodyFixture(db), empty = await createReviewBodyFixture(db, { bodies: false });
    const before = await f.rows(); await f.deleteProject(); await empty.deleteProject();
    await purgeDeletedReviewBodies(db, { ownerScope: f.owner, deletedContentPurgeDays: 7 });
    const receipts = await f.receipts();
    for (const table of reviewBodyTables) {
      await assert.rejects(replay(db, table, before[table][0]), checked('bb_review_body_source_unavailable'));
      const changed = { ...before[table][0], ...(table.includes('reports') ? { id: uid() } : {}) };
      await assert.rejects(replay(db, table, changed), checked('bb_review_body_source_unavailable'));
      await assert.rejects(db.query('TRUNCATE ' + table), checked());
    }
    await assert.rejects(empty.insertEditor(), checked('bb_review_body_source_unavailable'));
    await assert.rejects(empty.insertReport(), checked('bb_review_body_source_unavailable'));
    await withRollback(db, async client => {
      await context(client, policy(f));
      await assert.rejects(client.query('INSERT INTO bb_review_body_purges SELECT * FROM jsonb_populate_record(NULL::bb_review_body_purges,$1::jsonb) ON CONFLICT DO NOTHING',
        [JSON.stringify(receipts[0])]), checked('bb_review_body_purge_receipt'));
    });
    await assert.rejects(db.query('UPDATE bb_review_body_purges SET body_sha256=body_sha256 WHERE run_id=$1', [f.runId]), checked());
    await assert.rejects(db.query('DELETE FROM bb_review_body_purges WHERE run_id=$1', [f.runId]), checked());
    await assert.rejects(db.query('TRUNCATE bb_review_body_purges'), checked());
    assert.equal(await bodyCount(f), 0); assert.equal(await bodyCount(empty), 0); assert.deepEqual(await f.receipts(), receipts);
  });

test('a rolling run-first writer fails promptly on the project barrier and cannot deadlock a parent-first deletion',
  { skip: !connection, timeout: 30000 }, async t => {
    const db = pool(); t.after(() => db.end()); const f = await createReviewBodyFixture(db, { bodies: false });
    const writer = await db.connect(), deleter = await db.connect(); let waiting: Promise<unknown> | undefined;
    try {
      await writer.query('BEGIN'); await deleter.query('BEGIN');
      const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const deletePid = (await deleter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await writer.query('SELECT id FROM bb_runs WHERE id=$1 FOR UPDATE', [f.runId]);
      await deleter.query('SELECT id FROM bb_projects WHERE id=$1 FOR UPDATE', [f.projectId]);
      await f.deleteProject(8, deleter);
      waiting = deleter.query('SELECT id FROM bb_runs WHERE id=$1 FOR UPDATE', [f.runId]); void waiting.catch(() => {});
      await waitBlocked(db, deletePid, writerPid);
      await assert.rejects(bounded(f.insertEditor(writer), 'run-first body writer waited instead of failing safely'), checked('bb_review_body_source_unavailable'));
      await writer.query('ROLLBACK'); await bounded(waiting, 'deletion did not continue after the writer rollback');
      await deleter.query('COMMIT');
      assert.equal(await bodyCount(f), 0); assert.deepEqual(await f.receipts(), []);
      await assert.rejects(f.insertEditor(), checked('bb_review_body_source_unavailable'));
    } finally {
      await writer.query('ROLLBACK'); await deleter.query('ROLLBACK');
      await Promise.allSettled(waiting ? [waiting] : []); writer.release(); deleter.release();
    }
  });

test('a live body INSERT holds SHARE against ordinary deleted_at UPDATE, then the due pass sees and removes its committed mirror',
  { skip: !connection, timeout: 30000 }, async t => {
    const db = pool(); t.after(() => db.end()); const f = await createReviewBodyFixture(db, { bodies: false });
    const writer = await db.connect(), deleter = await db.connect(); let deleting: Promise<unknown> | undefined;
    try {
      await writer.query('BEGIN'); await deleter.query('BEGIN');
      const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const deletePid = (await deleter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await f.insertEditor(writer);
      deleting = f.deleteProject(8, deleter); void deleting.catch(() => {});
      await waitBlocked(db, deletePid, writerPid);
      assert.equal(await bodyCount(f), 0, 'the uncommitted body is invisible to another connection');
      await writer.query('COMMIT'); await bounded(deleting, 'project deletion did not resume after the live writer commit'); await deleter.query('COMMIT');
      assert.equal(await bodyCount(f), 2, 'both committed V1 mirror copies are present before the purge');
      assert.deepEqual(await purgeDeletedReviewBodies(db, { ownerScope: f.owner, deletedContentPurgeDays: 7 }), { projectsPurged: 1, rowsPurged: 2, failed: 0 });
      assert.equal(await bodyCount(f), 0); assert.equal((await f.receipts()).length, 2);
    } finally {
      await writer.query('ROLLBACK'); await deleter.query('ROLLBACK');
      await Promise.allSettled(deleting ? [deleting] : []); writer.release(); deleter.release();
    }
  });

test('nonfinite deleted timestamps do not starve a finite due project in a one-project batch',
  { skip: !connection, timeout: 30000 }, async t => {
    const db = pool(); t.after(() => db.end()); const invalid = await createReviewBodyFixture(db), due = await createReviewBodyFixture(db, { owner: invalid.owner });
    await db.query("UPDATE bb_projects SET deleted_at='-infinity'::timestamptz WHERE id=$1", [invalid.projectId]);
    await due.deleteProject(); const invalidBefore = await invalid.rows();
    assert.deepEqual(await purgeDeletedReviewBodies(db, { ownerScope: due.owner, deletedContentPurgeDays: 7, batchSize: 1 }), { projectsPurged: 1, rowsPurged: 4, failed: 0 });
    assert.equal(await bodyCount(due), 0); assert.deepEqual(await invalid.rows(), invalidBefore); assert.deepEqual(await invalid.receipts(), []);
  });


test('immediate constraints retain atomic receipts and transaction-local policy cannot leak into the next live-project operation',
  { skip: !connection, timeout: 30000 }, async t => {
    const db = pool(); t.after(() => db.end());
    const f = await createReviewBodyFixture(db), live = await createReviewBodyFixture(db);
    await f.deleteProject(); const liveBefore = await live.rows();
    const client = await db.connect();
    try {
      await client.query('BEGIN'); await client.query('SET CONSTRAINTS ALL IMMEDIATE'); await context(client, policy(f));
      for (const table of reviewBodyTables) await client.query('DELETE FROM ' + table + ' WHERE owner_user_id=$1 AND project_id=$2', [f.owner, f.projectId]);
      assert.equal((await client.query('SELECT count(*)::int AS n FROM bb_review_body_purges WHERE run_id=$1', [f.runId])).rows[0].n, 4);
      assert.deepEqual(await f.receipts(), [], 'the pending receipts are private until the deletion transaction commits');
      await client.query('COMMIT');
      const savedContext = (await client.query("SELECT current_setting('bb.review_body_purge',true) AS value")).rows[0].value;
      assert.ok(savedContext === null || savedContext === '', 'service policy is local to the completed transaction');
      await assert.rejects(client.query('DELETE FROM bb_review_editors WHERE run_id=$1', [live.runId]), checked('bb_review_body_purge_policy'));
    } finally { await client.query('ROLLBACK'); client.release(); }
    assert.equal(await bodyCount(f), 0); assert.equal((await f.receipts()).length, 4);
    await withRollback(db, async active => {
      await context(active, policy(live));
      await assert.rejects(active.query('DELETE FROM bb_review_editors WHERE run_id=$1', [live.runId]), checked('bb_review_body_purge_policy'));
    });
    for (const isolation of [' ISOLATION LEVEL REPEATABLE READ', ' ISOLATION LEVEL SERIALIZABLE']) await withRollback(db, async active => {
      await assert.rejects(replay(active, 'bb_review_editors', liveBefore.bb_review_editors[0]), checked('bb_review_body_purge_isolation'));
    }, isolation);
    assert.deepEqual(await live.rows(), liveBefore); assert.deepEqual(await live.receipts(), []);
  });
