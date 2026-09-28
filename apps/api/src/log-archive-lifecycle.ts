import { createHash, randomUUID } from 'node:crypto';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { Pool, type PoolClient } from 'pg';
import { pathToFileURL } from 'node:url';

const DAY = 86_400_000;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const uuid = () => randomUUID();
type Row = { segment_id: string; sink: string; sealed_at: Date; object_key: string; byte_length: string; sha256: string; record_count: string;
  pending_old_key: string | null; pending_old_byte_length: string | null; pending_old_sha256: string | null; pending_old_count: string | null;
  delete_started_at: Date | null; delete_reason: 'retention_expired' | 'user_deleted' | null; delete_user_id: string | null; deleted_at: Date | null };
export type ArchivePolicy = { retentionDays: number; now?: () => Date; batchSize?: number;
  /** Injected only by tests; failure leaves the old object as the current receipt. */ beforeSwitch?: () => Promise<void>;
  afterDeleteIntent?: () => Promise<void> };

export function archivePolicyFromEnv(env = process.env): ArchivePolicy {
  const raw = env.BB_LOG_ARCHIVE_RETENTION_DAYS ?? '180';
  if (!/^\d{2,4}$/.test(raw) || Number(raw) < 30 || Number(raw) > 3650)
    throw new Error('BB_LOG_ARCHIVE_RETENTION_DAYS must be an integer from 30 to 3650');
  return { retentionDays: Number(raw) };
}

async function bytes(container: ContainerClient, key: string, expected: { byte_length: string | number; sha256: string; record_count: string | number }) {
  const response = await container.getBlobClient(key).download();
  if (!response.readableStreamBody || response.contentLength !== Number(expected.byte_length) || response.contentLength > 70 * 1024 * 1024)
    throw new Error('Archive length mismatch');
  const parts: Buffer[] = []; let size = 0;
  for await (const part of response.readableStreamBody) {
    const buffer = Buffer.from(part); size += buffer.length;
    if (size > 70 * 1024 * 1024) throw new Error('Archive exceeds verification bound');
    parts.push(buffer);
  }
  const body = Buffer.concat(parts);
  if (size !== Number(expected.byte_length) || sha(body) !== expected.sha256.trim()) throw new Error('Archive hash mismatch');
  const text = body.toString('utf8');
  if (Buffer.from(text).length !== size || (text.length && !text.endsWith('\n'))) throw new Error('Invalid archive encoding');
  const lines = text ? text.slice(0, -1).split('\n').map(line => JSON.parse(line) as { user_id?: unknown; delivery_key?: unknown }) : [];
  if (lines.length !== Number(expected.record_count) || lines.some(line => !line || typeof line !== 'object' || typeof line.user_id !== 'string' || typeof line.delivery_key !== 'string'))
    throw new Error('Archive record count or owner mismatch');
  return { body, lines };
}

const audit = (db: PoolClient, row: Row, action: string, reason: string, actor: string | null, user: string | null,
  after: { sha256: string | null; count: number } = { sha256: row.sha256.trim(), count: Number(row.record_count) }) => db.query(`INSERT INTO bb_log_archive_audit
    (id,segment_id,action,reason,actor_id,user_id,before_sha256,after_sha256,before_count,after_count)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [uuid(), row.segment_id, action, reason, actor, user, row.sha256.trim(), after.sha256, Number(row.record_count), after.count]);

async function held(db: PoolClient, row: Row, users: Set<string>) {
  const q = await db.query(`SELECT id FROM bb_log_archive_legal_holds
    WHERE released_at IS NULL AND (segment_id IS NULL OR segment_id=$1)
      AND (user_id IS NULL OR user_id=ANY($2::text[]))
      AND (from_at IS NULL OR from_at<=$3) AND (to_at IS NULL OR to_at>=$3)
    LIMIT 1`, [row.segment_id, [...users], row.sealed_at]);
  return !!q.rowCount;
}

async function operator(db: PoolClient, actor: string) {
  const q = await db.query(`SELECT 1 FROM bb_operator_grants g JOIN bb_users u ON u.id=g.user_id
    WHERE g.user_id=$1 AND g.role='log_operator' AND g.revoked_at IS NULL AND u.status='active'`, [actor]);
  if (!q.rowCount) throw new Error('Active log_operator grant required');
}

/** A segment, user, or sealed-time range may be held. The hold row itself is the durable set/release audit. */
export async function setArchiveLegalHold(pool: Pool, input: { actorId: string; reasonCode: string; segmentId?: string; userId?: string; from?: Date; to?: Date }) {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(input.reasonCode) || !(input.segmentId || input.userId || input.from || input.to) ||
      input.from && input.to && input.from > input.to ||
      [input.from, input.to].some(x => x && Number.isNaN(x.getTime()))) throw new Error('Invalid legal hold scope');
  const db = await pool.connect();
  try {
    await db.query('BEGIN'); await db.query('SELECT pg_advisory_xact_lock(79,69)'); await operator(db, input.actorId);
    if (input.segmentId) {
      const state = await db.query('SELECT deleted_at FROM bb_log_archive_lifecycle WHERE segment_id=$1', [input.segmentId]);
      if (state.rowCount && state.rows[0].deleted_at) throw new Error('Archive already deleted');
    }
    const id = uuid();
    await db.query(`INSERT INTO bb_log_archive_legal_holds(id,segment_id,user_id,from_at,to_at,actor_id,reason_code)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, input.segmentId ?? null, input.userId ?? null, input.from ?? null, input.to ?? null, input.actorId, input.reasonCode]);
    if (input.segmentId) {
      const row = (await db.query<Row>(`SELECT l.*,s.sink,s.sealed_at FROM bb_log_archive_lifecycle l JOIN bb_log_segments s ON s.id=l.segment_id WHERE l.segment_id=$1`, [input.segmentId])).rows[0];
      if (row) await audit(db, row, 'hold_set', input.reasonCode, input.actorId, input.userId ?? null);
    }
    await db.query('COMMIT'); return id;
  } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
}

export async function releaseArchiveLegalHold(pool: Pool, holdId: string, actorId: string) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN'); await db.query('SELECT pg_advisory_xact_lock(79,69)'); await operator(db, actorId);
    const q = await db.query(`UPDATE bb_log_archive_legal_holds SET released_at=now(),released_by=$2
      WHERE id=$1 AND released_at IS NULL RETURNING segment_id,user_id,reason_code`, [holdId, actorId]);
    if (!q.rowCount) throw new Error('Active legal hold not found');
    if (q.rows[0].segment_id) {
      const row = (await db.query<Row>(`SELECT l.*,s.sink,s.sealed_at FROM bb_log_archive_lifecycle l JOIN bb_log_segments s ON s.id=l.segment_id WHERE l.segment_id=$1`, [q.rows[0].segment_id])).rows[0];
      if (row) await audit(db, row, 'hold_released', q.rows[0].reason_code, actorId, q.rows[0].user_id);
    }
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
}

/** Runs only when archive mode is enabled. One transaction locks each segment through Blob I/O. */
export async function runArchiveLifecycle(pool: Pool, connectionString: string, containerName: string, policy: ArchivePolicy) {
  if (!Number.isInteger(policy.retentionDays) || policy.retentionDays < 30 || policy.retentionDays > 3650) throw new Error('Invalid archive retention');
  const now = policy.now?.() ?? new Date(), batch = policy.batchSize ?? 100;
  if (!Number.isInteger(batch) || batch < 1 || batch > 1000) throw new Error('Invalid archive batch size');
  const container = BlobServiceClient.fromConnectionString(connectionString).getContainerClient(containerName);
  if ((await container.getProperties()).blobPublicAccess) throw new Error('Log archive container must be private');
  const candidates = (await pool.query<{segment_id: string}>(`SELECT l.segment_id FROM bb_log_archive_lifecycle l
    JOIN bb_log_segments s ON s.id=l.segment_id
    WHERE l.deleted_at IS NULL AND (l.pending_old_key IS NOT NULL OR l.delete_started_at IS NOT NULL
      OR s.sealed_at <= $1 OR EXISTS (SELECT 1 FROM bb_users u WHERE u.status='closed' AND u.closed_at<=$2
        AND u.closed_at > coalesce(l.last_user_scan_at,'epoch'::timestamptz)))
    ORDER BY s.sealed_at,l.segment_id LIMIT $3`, [new Date(now.getTime() - policy.retentionDays * DAY), now, batch])).rows;
  const result = { due: candidates.length, deleted: 0, rewritten: 0, skipped: 0, failed: 0 };
  for (const { segment_id } of candidates) {
    const db = await pool.connect();
    let failureAction: 'rewrite_failed' | 'delete_failed' = 'rewrite_failed';
    let current: Row | undefined;
    try {
      await db.query('BEGIN'); await db.query('SELECT pg_advisory_xact_lock(79,69)');
      const row = (await db.query<Row>(`SELECT l.*,s.sink,s.sealed_at FROM bb_log_archive_lifecycle l
        JOIN bb_log_segments s ON s.id=l.segment_id WHERE l.segment_id=$1 FOR UPDATE OF l`, [segment_id])).rows[0];
      current = row;
      if (!row || row.deleted_at) { await db.query('COMMIT'); continue; }
      if (row.pending_old_key) {
        failureAction = 'delete_failed';
        const prior = await bytes(container, row.pending_old_key, {
          byte_length: row.pending_old_byte_length!, sha256: row.pending_old_sha256!, record_count: row.pending_old_count! }).catch(error => {
          if ((error as { statusCode?: number }).statusCode === 404) return null;
          throw error;
        });
        if (prior && await held(db, row, new Set(prior.lines.map(line => line.user_id as string)))) {
          await audit(db, { ...row, sha256: row.pending_old_sha256!, record_count: row.pending_old_count! }, 'skipped_hold', 'user_deleted', null, null);
          result.skipped++; await db.query('COMMIT'); continue;
        }
        await container.getBlobClient(row.pending_old_key).deleteIfExists({ deleteSnapshots: 'include' });
        await audit(db, { ...row, sha256: row.pending_old_sha256!, record_count: row.pending_old_count! }, 'old_deleted', 'user_deleted', null, null,
          { sha256: null, count: 0 });
        await db.query(`UPDATE bb_log_archive_lifecycle SET pending_old_key=NULL,pending_old_byte_length=NULL,
          pending_old_sha256=NULL,pending_old_count=NULL WHERE segment_id=$1`, [segment_id]);
        failureAction = 'rewrite_failed';
      }
      const expired = new Date(row.sealed_at).getTime() <= now.getTime() - policy.retentionDays * DAY;
      failureAction = expired || row.delete_started_at ? 'delete_failed' : 'rewrite_failed';
      const snapshot = await bytes(container, row.object_key, row).catch(error => {
        if (row.delete_started_at && (error as { statusCode?: number }).statusCode === 404) return null;
        throw error;
      });
      const owners = new Set(snapshot?.lines.map(line => line.user_id as string) ?? []);
      const closed = !expired && !row.delete_started_at && snapshot
        ? (await db.query<{id: string}>(`SELECT id FROM bb_users WHERE status='closed' AND closed_at<=$1 AND id=ANY($2::text[])
            ORDER BY closed_at,id`, [now, [...owners]])).rows
        : [];
      if (!expired && !row.delete_started_at && !closed.length) {
        await db.query('UPDATE bb_log_archive_lifecycle SET last_user_scan_at=$2 WHERE segment_id=$1', [segment_id, now]);
        await db.query('COMMIT'); continue;
      }
      if (snapshot && await held(db, row, owners)) {
        await audit(db, row, 'skipped_hold', expired ? 'retention_expired' : 'user_deleted', null, null);
        result.skipped++; await db.query('COMMIT'); continue;
      }
      if (expired || row.delete_started_at) {
        failureAction = 'delete_failed';
        const reason = row.delete_reason ?? 'retention_expired';
        if (!row.delete_started_at) {
          await audit(db, row, 'delete_started', 'retention_expired', null, null);
          await db.query("UPDATE bb_log_archive_lifecycle SET delete_started_at=$2,delete_reason='retention_expired' WHERE segment_id=$1", [segment_id, now]);
          await db.query('COMMIT'); await policy.afterDeleteIntent?.();
          await db.query('BEGIN'); await db.query('SELECT pg_advisory_xact_lock(79,69)');
          await db.query('SELECT 1 FROM bb_log_archive_lifecycle WHERE segment_id=$1 FOR UPDATE', [segment_id]);
          if (await held(db, row, owners)) {
            await audit(db, row, 'skipped_hold', 'retention_expired', null, null);
            await db.query('COMMIT'); result.skipped++; continue;
          }
        }
        await container.getBlobClient(row.object_key).deleteIfExists();
        await audit(db, row, 'deleted', reason, null, row.delete_user_id, { sha256: null, count: 0 });
        await db.query('UPDATE bb_log_archive_lifecycle SET deleted_at=$2 WHERE segment_id=$1', [segment_id, now]);
        if (row.delete_user_id) await db.query('INSERT INTO bb_log_archive_user_purges(segment_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [segment_id, row.delete_user_id]);
        result.deleted++; await db.query('COMMIT'); continue;
      }
      const user = closed[0]?.id;
      if (!user || !snapshot) throw new Error('Archive deletion owner unavailable');
      const kept = snapshot.lines.filter(line => line.user_id !== user);
      if (!kept.length) {
        failureAction = 'delete_failed';
        await audit(db, row, 'delete_started', 'user_deleted', null, user);
        await db.query("UPDATE bb_log_archive_lifecycle SET delete_started_at=$2,delete_reason='user_deleted',delete_user_id=$3 WHERE segment_id=$1", [segment_id, now, user]);
        await db.query('COMMIT'); await policy.afterDeleteIntent?.();
        await db.query('BEGIN'); await db.query('SELECT pg_advisory_xact_lock(79,69)');
        await db.query('SELECT 1 FROM bb_log_archive_lifecycle WHERE segment_id=$1 FOR UPDATE', [segment_id]);
        if (await held(db, row, owners)) {
          await audit(db, row, 'skipped_hold', 'user_deleted', null, user);
          await db.query('COMMIT'); result.skipped++; continue;
        }
        await container.getBlobClient(row.object_key).deleteIfExists();
        await audit(db, row, 'deleted', 'user_deleted', null, user, { sha256: null, count: 0 });
        await db.query('UPDATE bb_log_archive_lifecycle SET deleted_at=$2 WHERE segment_id=$1', [segment_id, now]);
        await db.query('INSERT INTO bb_log_archive_user_purges(segment_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [segment_id, user]);
        result.deleted++; await db.query('COMMIT'); continue;
      }
      const next = Buffer.from(kept.map(line => JSON.stringify(line)).join('\n') + '\n');
      failureAction = 'rewrite_failed';
      const nextHash = sha(next);
      const nextKey = `log-archive/${row.sink}/${segment_id}.${createHash('sha256').update(user + row.sha256).digest('hex')}.ndjson`;
      try { await container.getBlockBlobClient(nextKey).uploadData(next, { conditions: { ifNoneMatch: '*' },
        blobHTTPHeaders: { blobContentType: 'application/x-ndjson' }, metadata: { sha256: nextHash, segmentid: segment_id } }); }
      catch { /* A lost upload response is resolved by the readback below. */ }
      await bytes(container, nextKey, { byte_length: next.length, sha256: nextHash, record_count: kept.length });
      await policy.beforeSwitch?.();
      await db.query(`UPDATE bb_log_archive_lifecycle SET object_key=$2,byte_length=$3,sha256=$4,record_count=$5,
        pending_old_key=$6,pending_old_byte_length=$7,pending_old_sha256=$8,pending_old_count=$9
        WHERE segment_id=$1`, [segment_id, nextKey, next.length, nextHash, kept.length,
        row.object_key, row.byte_length, row.sha256, row.record_count]);
      await db.query('INSERT INTO bb_log_archive_user_purges(segment_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [segment_id, user]);
      await audit(db, row, 'rewritten', 'user_deleted', null, user, { sha256: nextHash, count: kept.length });
      result.rewritten++; await db.query('COMMIT');
    } catch {
      await db.query('ROLLBACK').catch(() => {});
      result.failed++;
      await pool.query(`INSERT INTO bb_log_archive_audit(id,segment_id,action,reason,before_sha256,after_sha256,before_count,after_count)
        VALUES($1,$2,$3,'retry_required',$4,$4,$5,$5)`, [uuid(), segment_id, failureAction,
        current?.sha256 ?? null, current?.record_count ?? null]).catch(() => {});
    } finally { db.release(); }
  }
  return result;
}

// Restricted maintenance commands. Authorization is checked against active log_operator grants.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
    const command = process.argv[2];
    if (command === 'retention') {
      if (process.env.BB_LOG_ARCHIVE_ENABLED !== '1' || !process.env.AZURE_STORAGE_CONNECTION_STRING)
        throw new Error('Enabled archive and Blob connection required');
      const result = await runArchiveLifecycle(pool, process.env.AZURE_STORAGE_CONNECTION_STRING,
        process.env.BB_LOG_ARCHIVE_CONTAINER || 'bondbuddy-private', archivePolicyFromEnv());
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.failed) process.exitCode = 1;
    } else if (command === 'hold-set') {
      const [actorId, reasonCode, kind, value, from] = process.argv.slice(3);
      const scope = kind === 'segment' ? { segmentId: value } : kind === 'user' ? { userId: value } :
        kind === 'time' ? { from: new Date(value), to: new Date(from) } : null;
      if (!scope || Object.values(scope).some(x => x instanceof Date && Number.isNaN(x.getTime()))) throw new Error('Invalid hold scope');
      process.stdout.write(`${await setArchiveLegalHold(pool, { actorId, reasonCode, ...scope })}\n`);
    } else if (command === 'hold-release') {
      await releaseArchiveLegalHold(pool, process.argv[4], process.argv[3]);
      process.stdout.write('released\n');
    } else throw new Error('usage: retention | hold-set ACTOR REASON segment|user|time VALUE [TO] | hold-release ACTOR HOLD_ID');
  } catch (error) { process.stderr.write(`archive lifecycle failed: ${error instanceof Error ? error.message : 'unknown'}\n`); process.exitCode = 1; }
  finally { await pool.end(); }
}
