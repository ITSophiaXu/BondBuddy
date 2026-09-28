import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BlobServiceClient } from '@azure/storage-blob';
import { Pool } from 'pg';
import { isolatedTestDatabase } from './test-database.js';
import { archivePolicyFromEnv, releaseArchiveLegalHold, runArchiveLifecycle, setArchiveLegalHold } from './log-archive-lifecycle.js';

const databaseUrl = await isolatedTestDatabase();
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const available = !!databaseUrl && !!blobConnection;
const hash = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const day = 86_400_000;

test('#79 archive retention, legal hold and user deletion use PG16 and private Blob', { skip: !available }, async t => {
  const pool = new Pool({ connectionString: databaseUrl });
  const name = `bb79ret${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const container = BlobServiceClient.fromConnectionString(blobConnection!).getContainerClient(name);
  await container.createIfNotExists();
  const now = new Date('2026-09-28T00:00:00.000Z');
  const actor = `op-${randomUUID()}`, removed = `gone-${randomUUID()}`, other = `other-${randomUUID()}`;
  const user = async (id: string) => pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id, `u${randomUUID().replaceAll('-', '').slice(0, 12)}`]);
  const segment = async (lines: Array<{ user_id: string; marker: string }>, ageDays: number) => {
    const id = randomUUID(), sink = 'ndjson_file', key = `log-archive/${sink}/${id}.ndjson`;
    const body = Buffer.from(lines.map((line, index) => JSON.stringify({ delivery_key: String(index).padStart(64, '0'), ...line })).join('\n') + '\n');
    const digest = hash(body);
    await container.getBlockBlobClient(key).uploadData(body);
    await pool.query(`INSERT INTO bb_log_segments(id,sink,state,byte_length,sha256,record_count,sealed_at)
      VALUES($1,$2,'sealed',$3,$4,$5,$6)`, [id, sink, body.length, digest, lines.length, new Date(now.getTime() - ageDays * day)]);
    await pool.query(`INSERT INTO bb_log_archive_receipts(segment_id,object_key,byte_length,sha256,record_count)
      VALUES($1,$2,$3,$4,$5)`, [id, key, body.length, digest, lines.length]);
    await pool.query(`INSERT INTO bb_log_archive_lifecycle(segment_id,object_key,byte_length,sha256,record_count)
      VALUES($1,$2,$3,$4,$5)`, [id, key, body.length, digest, lines.length]);
    return { id, key, body, digest };
  };
  const policy = { retentionDays: 180, now: () => now, batchSize: 100 };
  try {
    await user(actor); await user(removed); await user(other);
    await pool.query(`INSERT INTO bb_operator_grants(id,user_id,role,granted_by,reason_code)
      VALUES($1,$2,'log_operator',$2,'test_grant')`, [randomUUID(), actor]);
    const expired = await segment([{ user_id: other, marker: 'expired' }], 181);
    const held = await segment([{ user_id: other, marker: 'held' }], 181);
    const holdId = await setArchiveLegalHold(pool, { actorId: actor, reasonCode: 'case_review', segmentId: held.id });
    await assert.rejects(setArchiveLegalHold(pool, { actorId: other, reasonCode: 'case_review', segmentId: held.id }), /log_operator/);
    const first = await runArchiveLifecycle(pool, blobConnection!, name, policy);
    assert.equal(first.deleted, 1); assert.equal(first.skipped, 1);
    assert.equal(await container.getBlobClient(expired.key).exists(), false);
    assert.equal(await container.getBlobClient(held.key).exists(), true);
    await releaseArchiveLegalHold(pool, holdId, actor);
    const second = await runArchiveLifecycle(pool, blobConnection!, name, policy);
    assert.equal(second.deleted, 1);
    assert.equal(await container.getBlobClient(held.key).exists(), false);
    const byUser = await segment([{ user_id: other, marker: 'user-hold' }], 181);
    const userHold = await setArchiveLegalHold(pool, { actorId: actor, reasonCode: 'case_review', userId: other });
    assert.equal((await runArchiveLifecycle(pool, blobConnection!, name, policy)).skipped, 1);
    assert.equal(await container.getBlobClient(byUser.key).exists(), true);
    await releaseArchiveLegalHold(pool, userHold, actor);
    const byTime = await segment([{ user_id: other, marker: 'time-hold' }], 181);
    const timeHold = await setArchiveLegalHold(pool, { actorId: actor, reasonCode: 'case_review',
      from: new Date(now.getTime() - 182 * day), to: new Date(now.getTime() - 180 * day) });
    assert.ok((await runArchiveLifecycle(pool, blobConnection!, name, policy)).skipped >= 1);
    assert.equal(await container.getBlobClient(byTime.key).exists(), true);
    await releaseArchiveLegalHold(pool, timeHold, actor);
    await runArchiveLifecycle(pool, blobConnection!, name, policy);
    assert.equal(await container.getBlobClient(byTime.key).exists(), false);

    const mixed = await segment([{ user_id: removed, marker: 'remove' }, { user_id: other, marker: 'keep' }], 1);
    await pool.query("UPDATE bb_users SET status='closed',closed_at=$2 WHERE id=$1", [removed, new Date(now.getTime() - day)]);
    const deletionHold = await setArchiveLegalHold(pool, { actorId: actor, reasonCode: 'case_review', segmentId: mixed.id });
    assert.ok((await runArchiveLifecycle(pool, blobConnection!, name, policy)).skipped >= 1);
    assert.equal(await container.getBlobClient(mixed.key).exists(), true, 'hold preserves the closed account line');
    await releaseArchiveLegalHold(pool, deletionHold, actor);
    const only = await segment([{ user_id: removed, marker: 'alone' }], 1);
    const fail = await runArchiveLifecycle(pool, blobConnection!, name, { ...policy,
      beforeSwitch: async () => { throw new Error('synthetic switch failure'); },
      afterDeleteIntent: async () => { throw new Error('synthetic delete-intent interruption'); } });
    assert.ok(fail.failed >= 1);
    const before = (await pool.query('SELECT object_key,sha256 FROM bb_log_archive_lifecycle WHERE segment_id=$1', [mixed.id])).rows[0];
    assert.equal(before.object_key, mixed.key); assert.equal(before.sha256.trim(), mixed.digest);
    assert.equal(await container.getBlobClient(mixed.key).exists(), true, 'failed switch retains the old verified segment');
    assert.equal(await container.getBlobClient(only.key).exists(), true, 'committed delete intent does not remove bytes before the retry');
    const third = await runArchiveLifecycle(pool, blobConnection!, name, policy);
    assert.equal(third.rewritten, 1, JSON.stringify(third)); assert.equal(fail.deleted + third.deleted, 1, JSON.stringify({ fail, third }));
    const state = (await pool.query('SELECT * FROM bb_log_archive_lifecycle WHERE segment_id=$1', [mixed.id])).rows[0];
    assert.notEqual(state.object_key, mixed.key);
    const rewritten = await container.getBlobClient(state.object_key).downloadToBuffer();
    assert.equal(hash(rewritten), state.sha256.trim());
    assert.equal(Number(state.byte_length), rewritten.length);
    assert.equal(Number(state.record_count), 1);
    assert.equal(JSON.parse(rewritten.toString().trim()).user_id, other);
    assert.equal(await container.getBlobClient(mixed.key).exists(), true, 'old object remains until the switched receipt is durable');
    assert.equal(await container.getBlobClient(only.key).exists(), false);
    assert.equal((await pool.query('SELECT delete_reason,delete_user_id FROM bb_log_archive_lifecycle WHERE segment_id=$1', [only.id])).rows[0].delete_reason, 'user_deleted');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_log_archive_user_purges WHERE segment_id=$1 AND user_id=$2', [only.id, removed])).rows[0].n, 1);
    await runArchiveLifecycle(pool, blobConnection!, name, policy);
    assert.equal(await container.getBlobClient(mixed.key).exists(), false);
    const actions = (await pool.query('SELECT action,segment_id,before_sha256,after_sha256,before_count,after_count FROM bb_log_archive_audit')).rows;
    for (const action of ['hold_set', 'hold_released', 'skipped_hold', 'delete_started', 'deleted', 'rewritten', 'old_deleted', 'rewrite_failed'])
      assert.ok(actions.some(row => row.action === action), `missing ${action} audit`);
    assert.ok(actions.some(row => row.action === 'rewritten' && row.segment_id === mixed.id && row.before_sha256.trim() === mixed.digest &&
      row.after_sha256.trim() === hash(rewritten) && Number(row.before_count) === 2 && Number(row.after_count) === 1));
    assert.ok(actions.some(row => row.action === 'deleted' && row.segment_id === expired.id && row.before_sha256.trim() === expired.digest &&
      row.after_sha256 === null && Number(row.before_count) === 1 && Number(row.after_count) === 0));
    assert.throws(() => archivePolicyFromEnv({ BB_LOG_ARCHIVE_RETENTION_DAYS: '29' }), /30 to 3650/);
    assert.equal(archivePolicyFromEnv({}).retentionDays, 180);
  } finally { await container.deleteIfExists(); await pool.end(); }
});
