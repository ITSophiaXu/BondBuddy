import type { Pool } from 'pg';
import { projectMessageSetRef, type ProjectMessageSetRef } from '@bondbuddy/contracts';
import { conflict, date, digest, missing, Problem, project, transaction, uid, type PrivateBlobs } from './data.js';
import { emitInternal, internalEvent } from './observability.js';
import { ownerProjectMessageBody, scrubSecrets } from './log-ops.js';
import { loadCurrentProjectMessageSetPin, isProjectMessageSetLockError } from './project-message-set-lock.js';
import { prepareUserSubmission, verifiedMaterialVersions } from './user-submissions.js';

export type SaveProjectMessage = {
  message_id: string;
  submission_request_id: string;
  expected_message_version: number | null;
  body: string;
  material_versions: { material_id: string; material_version: number }[];
};

const invalidSet = () => new Problem(503, 'DATA_UNAVAILABLE', 'Stored project message set could not be verified');
const currentSet = async (pool: Pool | import('pg').PoolClient, owner: string, projectId: string) => {
  try { return await loadCurrentProjectMessageSetPin(pool, { ownerUserId: owner, projectId }); }
  catch (error) { if (isProjectMessageSetLockError(error)) throw invalidSet(); throw error; }
};

type StoredMessage = {
  id: string; message_id: string; message_version: number; version: number;
  snapshot_id: string; revises_submission_id: string | null; content_sha256: string;
  material_versions: SaveProjectMessage['material_versions']; created_at: Date;
  run_id: string | null; input_revision: number | null; input_hash: string | null;
};
type MessageRow = StoredMessage & { historical_predecessor_id: string | null };

async function messageDto(
  pool: Pool, blobs: PrivateBlobs, owner: string, projectId: string, row: MessageRow | undefined,
  member: { message_id: string; message_version: number; submission_id: string; content_sha256: string }, signal?: AbortSignal,
) {
  if (!row || row.id !== member.submission_id || row.message_id !== member.message_id ||
      row.message_version !== member.message_version || row.content_sha256.trim() !== member.content_sha256 ||
      (row.message_version === 1 && (row.revises_submission_id || row.historical_predecessor_id)) ||
      (row.message_version > 1 && !row.historical_predecessor_id) ||
      (row.revises_submission_id && row.revises_submission_id !== row.historical_predecessor_id)) throw invalidSet();
  const text = await ownerProjectMessageBody(pool, blobs, owner, projectId, row.snapshot_id, member.content_sha256, signal);
  return { message_id: row.message_id, submission_id: row.id, submission_version: row.version,
    message_version: row.message_version, prompt_snapshot_ref: row.snapshot_id,
    revises_submission_id: row.revises_submission_id ?? row.historical_predecessor_id,
    content_sha256: member.content_sha256, body: text, material_versions: row.material_versions,
    created_at: date(row.created_at), role: 'user' as const, source_status: 'user_asserted' as const,
    intent_status: 'not_classified' as const, route: 'save_only' as const };
}

function sameRequest(row: StoredMessage & { submission_request_id: string }, input: SaveProjectMessage): boolean {
  return row.message_id === input.message_id &&
    row.run_id === null && row.input_revision === null && row.input_hash === null &&
    row.content_sha256.trim() === digest(scrubSecrets(input.body)) &&
    JSON.stringify(row.material_versions) === JSON.stringify(input.material_versions) &&
    (row.message_version === 1 ? input.expected_message_version === null
      : row.message_version - 1 === input.expected_message_version);
}

export async function saveProjectMessage(pool: Pool, blobs: PrivateBlobs, owner: string, projectId: string, input: SaveProjectMessage) {
  await project(pool, owner, projectId);
  const sanitized = scrubSecrets(input.body);
  if (!sanitized.trim()) throw new Problem(422, 'VALIDATION_FAILED', 'Message has no content after credential redaction');
  if (new Set(input.material_versions.map(ref => ref.material_id)).size !== input.material_versions.length)
    throw new Problem(422, 'VALIDATION_FAILED', 'Duplicate material references');
  const prepared = await (await prepareUserSubmission(pool, blobs, input.body)).write(owner, projectId);
  try {
    return await transaction(pool, async client => {
      // Same lock order as input-lock: project before the submission/version advisory lock.
      await project(client, owner, projectId, true);
      const old = (await client.query(`SELECT * FROM bb_user_submission_versions
        WHERE owner_user_id=$1 AND project_id=$2 AND submission_request_id=$3 AND submission_kind='project_message'`,
      [owner, projectId, input.submission_request_id])).rows[0] as (StoredMessage & { submission_request_id: string }) | undefined;
      const before = await currentSet(client, owner, projectId);
      if (old) {
        if (!sameRequest(old, input)) throw conflict('IDEMPOTENCY_CONFLICT', 'Request ID is bound to another message version');
        return {
          conversation_id: projectId, message_id: old.message_id, submission_id: old.id,
          submission_version: old.version, message_version: old.message_version,
          prompt_snapshot_ref: old.snapshot_id, revises_submission_id: old.revises_submission_id,
          content_sha256: old.content_sha256.trim(), created_at: date(old.created_at),
          is_current: before.members.some(member => member.submission_id === old.id),
          role: 'user' as const, source_status: 'user_asserted' as const, intent_status: 'not_classified' as const,
          route: 'save_only' as const, project_message_set_ref: projectMessageSetRef(before),
        };
      }
      const latest = (await client.query(`SELECT id,message_version FROM bb_user_submission_versions
        WHERE owner_user_id=$1 AND project_id=$2 AND submission_kind='project_message' AND message_id=$3
        ORDER BY message_version DESC LIMIT 1`,
      [owner, projectId, input.message_id])).rows[0] as { id: string; message_version: number } | undefined;
      if (input.expected_message_version !== (latest?.message_version ?? null))
        throw conflict('INPUT_REVISION_CONFLICT', 'Message version has changed');
      const count = await client.query(`SELECT count(*)::integer AS total FROM bb_user_submission_versions
        WHERE owner_user_id=$1 AND project_id=$2 AND submission_kind='project_message'`, [owner, projectId]);
      if (count.rows[0].total >= 500) throw conflict('INPUT_REVISION_CONFLICT', 'Project message version limit reached');
      await verifiedMaterialVersions(client, owner, projectId, input.material_versions);
      const saved = await prepared.register(client, { kind: 'project_message', messageId: input.message_id,
        submissionRequestId: input.submission_request_id, materialVersions: input.material_versions });
      const after = await currentSet(client, owner, projectId);
      const ref: ProjectMessageSetRef = projectMessageSetRef(after);
      const event = internalEvent({ kind: 'operation.submitted', owner, projectId, actorType: 'user',
        requestId: input.submission_request_id, traceId: uid(), status: 'created',
        promptSnapshotRef: saved.snapshotId, stage: 'message_saved' });
      await emitInternal(client, { ...event, conversation_id: projectId, message_id: input.message_id });
      await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
        VALUES($1,$2,'project_message',$3,'project_message.saved',$4)`,
      [uid(), owner, input.message_id, { project_id: projectId, message_id: input.message_id,
        submission_id: saved.submissionId, message_version: saved.messageVersion, content_sha256: saved.contentSha256,
        prompt_snapshot_ref: saved.snapshotId, project_message_set_ref: ref }]);
      return {
        conversation_id: projectId, message_id: input.message_id, submission_id: saved.submissionId,
        submission_version: saved.version, message_version: saved.messageVersion!,
        prompt_snapshot_ref: saved.snapshotId, revises_submission_id: saved.revisesSubmissionId,
        content_sha256: saved.contentSha256, created_at: date(saved.createdAt),
        is_current: true, role: 'user' as const, source_status: 'user_asserted' as const,
        intent_status: 'not_classified' as const, route: 'save_only' as const, project_message_set_ref: ref,
      };
    });
  } finally {
    await prepared.discard();
  }
}

function cursorValue(value: string | undefined): { hash: string; version: number; after: number } | null {
  if (value === undefined) return null;
  if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Problem(422, 'VALIDATION_FAILED', 'Invalid message cursor');
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { throw new Problem(422, 'VALIDATION_FAILED', 'Invalid message cursor'); }
  if (!Array.isArray(decoded) || decoded.length !== 3 || typeof decoded[0] !== 'string' ||
      !/^[a-f0-9]{64}$/.test(decoded[0]) || !Number.isSafeInteger(decoded[1]) ||
      decoded[1] < 1 || !Number.isSafeInteger(decoded[2]) || decoded[2] < 1 || decoded[2] > 500)
    throw new Problem(422, 'VALIDATION_FAILED', 'Invalid message cursor');
  return { hash: decoded[0], version: decoded[1], after: decoded[2] };
}

export async function readProjectMessages(
  pool: Pool, blobs: PrivateBlobs, owner: string, projectId: string,
  input: { cursor?: string; limit?: string }, signal: AbortSignal = AbortSignal.timeout(60_000),
) {
  const limit = input.limit === undefined ? 20 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || input.limit && !/^[1-9]\d?$/.test(input.limit))
    throw new Problem(422, 'VALIDATION_FAILED', 'Invalid page size');
  const cursor = cursorValue(input.cursor);
  await project(pool, owner, projectId);
  const pin = await currentSet(pool, owner, projectId);
  if (cursor && (cursor.hash !== pin.content_sha256 || cursor.version !== pin.version || cursor.after >= pin.members.length))
    throw conflict('INPUT_REVISION_CONFLICT', 'Message history changed; restart pagination');
  const start = cursor?.after ?? 0;
  const members = pin.members.slice(start, start + limit);
  const ref = projectMessageSetRef(pin);
  if (!members.length) return { conversation_id: projectId, items: [], project_message_set_ref: ref, next_cursor: null, has_more: false };
  const rows = (await pool.query(`SELECT v.id,v.message_id,v.message_version,v.version,v.snapshot_id,v.revises_submission_id,
      v.content_sha256,v.material_versions,v.created_at,
      predecessor.id AS historical_predecessor_id
    FROM bb_user_submission_versions v
    LEFT JOIN bb_user_submission_versions predecessor
      ON predecessor.owner_user_id=v.owner_user_id AND predecessor.project_id=v.project_id
      AND predecessor.submission_kind='project_message' AND predecessor.message_id=v.message_id
      AND predecessor.message_version=v.message_version-1
    WHERE v.owner_user_id=$1 AND v.project_id=$2 AND v.submission_kind='project_message' AND v.id=ANY($3::text[])`,
  [owner, projectId, members.map(m => m.submission_id)])).rows as MessageRow[];
  const byId = new Map(rows.map(row => [row.id, row]));
  if (rows.length !== members.length) throw invalidSet();
  const items = [];
  for (const member of members) {
    items.push(await messageDto(pool, blobs, owner, projectId, byId.get(member.submission_id), member, signal));
  }

  const after = start + members.length;
  return { conversation_id: projectId, items, project_message_set_ref: ref,
    next_cursor: after < pin.members.length ? Buffer.from(JSON.stringify([pin.content_sha256, pin.version, after])).toString('base64url') : null,
    has_more: after < pin.members.length };
}

export async function readProjectMessageVersion(
    pool: Pool, blobs: PrivateBlobs, owner: string, projectId: string,
    messageId: string, version: string, signal: AbortSignal = AbortSignal.timeout(60_000),
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(messageId) ||
        !/^[1-9]\d{0,9}$/.test(version) || Number(version) > 2147483647)
      throw new Problem(422, 'VALIDATION_FAILED', 'Invalid message version');
    await project(pool, owner, projectId);
    await currentSet(pool, owner, projectId);
    const row = (await pool.query(`SELECT v.id,v.message_id,v.message_version,v.version,v.snapshot_id,v.revises_submission_id,
        v.content_sha256,v.material_versions,v.created_at,predecessor.id AS historical_predecessor_id
      FROM bb_user_submission_versions v
      LEFT JOIN bb_user_submission_versions predecessor
        ON predecessor.owner_user_id=v.owner_user_id AND predecessor.project_id=v.project_id
        AND predecessor.submission_kind='project_message' AND predecessor.message_id=v.message_id
        AND predecessor.message_version=v.message_version-1
      WHERE v.owner_user_id=$1 AND v.project_id=$2 AND v.submission_kind='project_message'
        AND v.message_id=$3 AND v.message_version=$4`,
    [owner, projectId, messageId, Number(version)])).rows[0] as MessageRow | undefined;
    if (!row) throw missing();
    return messageDto(pool, blobs, owner, projectId, row, {
      message_id: row.message_id, message_version: row.message_version,
      submission_id: row.id, content_sha256: row.content_sha256.trim(),
    }, signal);
  }
