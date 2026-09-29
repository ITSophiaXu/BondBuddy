/**
 * #17 input-lock consumption of the #18/#397 active project-message set (#76 aggregate contract).
 *
 * The public identity/hash semantics live once in `@bondbuddy/contracts`
 * (`project-message-set-pin.ts`). This module only re-reads immutable owner/project-scoped
 * message metadata and mirrors the worker's bounded first-submission selection so the API can
 * prove, inside the input-lock transaction, that a request-supplied aggregate ref is the current
 * exact set. It never reads a prompt Blob body, never fabricates an empty set for a non-empty
 * history, and fails closed on any malformed, duplicate, non-contiguous or over-limit history.
 */
import { createHash } from 'node:crypto';
import {
  PROJECT_MESSAGE_SET_EMPTY_VERSION,
  PROJECT_MESSAGE_SET_MAX_MEMBERS,
  canonicalProjectMessageSetContent,
  projectMessageSetRefMatches,
  type ProjectMessageSetPin,
  type ProjectMessageSetRef,
} from '@bondbuddy/contracts';

export interface ProjectMessageSetLockQuery {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface ProjectMessageSetLockScope {
  /** Authenticated principal; never request JSON. */
  readonly ownerUserId: string;
  readonly projectId: string;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function isProjectMessageSetLockError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ProjectMessageSetLockError';
}

function fail(): never {
  const error = new Error('PROJECT_MESSAGE_SET_INVALID');
  error.name = 'ProjectMessageSetLockError';
  throw error;
}

function positiveInteger(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail();
  return parsed;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail();
  return value;
}

function sha256Hex(value: unknown): string {
  if (typeof value !== 'string' || !SHA256.test(value.trim())) fail();
  return value.trim();
}

/**
 * Owner/project-scoped bounded selection of exactly one latest pin per `message_id`, ordered by the
 * original first-submission position. This mirrors the worker
 * `loadLatestProjectMessagePins` / `normalizeProjectMessageSet` chain validation so the lock-time
 * identity cannot diverge from the consumer's; any gap, duplicate or malformed row fails closed.
 */
export async function loadCurrentProjectMessageSetPin(
  db: ProjectMessageSetLockQuery,
  scope: ProjectMessageSetLockScope,
): Promise<ProjectMessageSetPin> {
  if (!IDENTIFIER.test(scope.ownerUserId) || !IDENTIFIER.test(scope.projectId)) fail();
  const rows = (await db.query(
    `SELECT id, message_id, message_version, version, content_sha256
       FROM bb_user_submission_versions
      WHERE owner_user_id=$1 AND project_id=$2 AND submission_kind='project_message'
      ORDER BY version
      LIMIT $3`,
    [scope.ownerUserId, scope.projectId, PROJECT_MESSAGE_SET_MAX_MEMBERS + 1])).rows;
  if (rows.length > PROJECT_MESSAGE_SET_MAX_MEMBERS) fail();

  type Version = { message_id: string; submission_id: string; message_version: number; content_sha256: string; version: number };
  const byMessage = new Map<string, Version[]>();
  const submissionIds = new Set<string>();
  const projectVersions = new Set<number>();
  for (const row of rows) {
    const submissionId = identifier(row.id);
    const messageId = identifier(row.message_id);
    const version = positiveInteger(row.version);
    const messageVersion = positiveInteger(row.message_version);
    const contentSha256 = sha256Hex(row.content_sha256);
    if (submissionIds.has(submissionId) || projectVersions.has(version)) fail();
    submissionIds.add(submissionId);
    projectVersions.add(version);
    const versions = byMessage.get(messageId) ?? [];
    if (versions.some(item => item.message_version === messageVersion || item.version === version)) fail();
    versions.push({ message_id: messageId, submission_id: submissionId, message_version: messageVersion, content_sha256: contentSha256, version });
    byMessage.set(messageId, versions);
  }

  const ordered: Array<Version & { first_submission_version: number }> = [];
  for (const versions of byMessage.values()) {
    versions.sort((left, right) => left.message_version - right.message_version);
    if (versions[0]!.message_version !== 1) fail();
    for (let index = 1; index < versions.length; index += 1) {
      if (versions[index]!.message_version !== versions[index - 1]!.message_version + 1 ||
          versions[index]!.version <= versions[index - 1]!.version) fail();
    }
    const latest = versions[versions.length - 1]!;
    ordered.push({ ...latest, first_submission_version: versions[0]!.version });
  }
  ordered.sort((left, right) => left.first_submission_version - right.first_submission_version);

  const members = ordered.map(item => ({
    message_id: item.message_id, message_version: item.message_version,
    submission_id: item.submission_id, content_sha256: item.content_sha256,
  }));
  const version = members.length === 0
    ? PROJECT_MESSAGE_SET_EMPTY_VERSION
    : Math.max(...ordered.map(item => item.first_submission_version));
  const candidate: ProjectMessageSetPin = {
    version, content_sha256: '0'.repeat(64), members,
    message_ids: members.map(member => member.message_id).sort(),
  };
  let contentSha256: string;
  try { contentSha256 = createHash('sha256').update(canonicalProjectMessageSetContent(candidate), 'utf8').digest('hex'); }
  catch { fail(); }
  return { ...candidate, content_sha256: contentSha256 };
}

/**
 * Re-verify a request-supplied aggregate ref against the current exact set. A bare version, wrong
 * hash, missing or reordered member projection, or empty-vs-nonempty mismatch fails closed.
 */
export function assertProjectMessageSetRefMatches(expected: ProjectMessageSetPin, ref: ProjectMessageSetRef): void {
  if (!projectMessageSetRefMatches(expected, ref)) fail();
}
