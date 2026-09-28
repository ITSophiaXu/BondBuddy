/**
 * Internal reader for the immutable #397 project-message version chain.
 *
 * This only resolves metadata pins. It never reads prompt Blob content and does not
 * change the current target-period producer's fail-closed behavior for nonempty
 * project messages while the public aggregate pin contract is being agreed.
 */

export interface ProjectMessagePinQuery {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface ProjectMessagePin {
  readonly message_id: string;
  readonly submission_id: string;
  readonly message_version: number;
  readonly content_sha256: string;
  /** Project-wide submission version that fixes this message's original conversation position. */
  readonly first_submission_version: number;
  /** Immutable submission row that established that original position. */
  readonly first_submission_id: string;
}

const MAX_PROJECT_MESSAGE_VERSIONS = 500;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(): Error {
  const error = new Error('PROJECT_MESSAGE_SET_INVALID');
  error.name = 'ProjectMessagePinLoaderError';
  return error;
}

function positiveInteger(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw fail();
  return parsed;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || !IDENTIFIER.test(value)) throw fail();
  return value;
}

/**
 * Resolve all currently registered project_message versions to one latest pin per
 * message_id. Input rows must already be owner/project scoped by the caller. Message
 * rows are append-only, so the latest registered version is the active text; older
 * versions remain available for audit and old-run references.
 */
export function selectLatestProjectMessagePins(
  rows: readonly Record<string, unknown>[],
  expected: { readonly ownerUserId: string; readonly projectId: string },
): ProjectMessagePin[] {
  if (!IDENTIFIER.test(expected.ownerUserId) || !IDENTIFIER.test(expected.projectId) ||
      !Array.isArray(rows) || rows.length > MAX_PROJECT_MESSAGE_VERSIONS) throw fail();

  type Version = ProjectMessagePin & { readonly version: number };
  const byMessage = new Map<string, Version[]>();
  const ids = new Set<string>();
  const projectVersions = new Set<number>();

  for (const row of rows) {
    if (row.owner_user_id !== expected.ownerUserId || row.project_id !== expected.projectId || row.submission_kind !== 'project_message') throw fail();
    const submissionId = text(row.id);
    const messageId = text(row.message_id);
    const version = positiveInteger(row.version);
    const messageVersion = positiveInteger(row.message_version);
    const contentSha256 = typeof row.content_sha256 === 'string' ? row.content_sha256.trim() : '';
    if (!SHA256.test(contentSha256) || ids.has(submissionId) || projectVersions.has(version)) throw fail();
    ids.add(submissionId);
    projectVersions.add(version);
    const versions = byMessage.get(messageId) ?? [];
    if (versions.some(item => item.message_version === messageVersion)) throw fail();
    versions.push({ message_id: messageId, submission_id: submissionId, message_version: messageVersion,
      content_sha256: contentSha256, first_submission_version: 0, first_submission_id: '', version });
    byMessage.set(messageId, versions);
  }

  const selected: ProjectMessagePin[] = [];
  for (const versions of byMessage.values()) {
    versions.sort((left, right) => left.message_version - right.message_version);
    const first = versions[0]!;
    if (first.message_version !== 1) throw fail();
    for (let index = 1; index < versions.length; index += 1) {
      const current = versions[index]!;
      const prior = versions[index - 1]!;
      if (current.message_version !== prior.message_version + 1 || current.version <= prior.version) throw fail();
    }
    const latest = versions[versions.length - 1]!;
    selected.push({ message_id: latest.message_id, submission_id: latest.submission_id,
      message_version: latest.message_version, content_sha256: latest.content_sha256,
      first_submission_version: first.version, first_submission_id: first.submission_id });
  }

  selected.sort((left, right) => left.first_submission_version - right.first_submission_version);
  return selected;
}

/**
 * Owner/project-scoped bounded loader. The LIMIT sentinel makes excessive history fail
 * closed without materializing an unbounded project history in worker memory.
 */
export async function loadLatestProjectMessagePins(
  client: ProjectMessagePinQuery,
  expected: { readonly ownerUserId: string; readonly projectId: string },
): Promise<ProjectMessagePin[]> {
  if (!IDENTIFIER.test(expected.ownerUserId) || !IDENTIFIER.test(expected.projectId)) throw fail();
  const result = await client.query(
    `SELECT id, owner_user_id, project_id, submission_kind, message_id, message_version,
            version, content_sha256
       FROM bb_user_submission_versions
      WHERE owner_user_id=$1 AND project_id=$2 AND submission_kind='project_message'
      ORDER BY version
      LIMIT $3`,
    [expected.ownerUserId, expected.projectId, MAX_PROJECT_MESSAGE_VERSIONS + 1],
  );
  if (result.rows.length > MAX_PROJECT_MESSAGE_VERSIONS) throw fail();
  return selectLatestProjectMessagePins(result.rows, expected);
}
