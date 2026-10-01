import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadLatestProjectMessagePins, selectLatestProjectMessagePins } from './project-message-pin-loader.js';

const owner = 'synthetic-owner';
const project = 'synthetic-project';
const sha = (letter: string) => letter.repeat(64);
function row(id: string, messageId: string, messageVersion: number, version: number,
  previousSubmissionId: string | null, contentSha256: string, overrides: Record<string, unknown> = {}) {
  return { id, owner_user_id: owner, project_id: project, submission_kind: 'project_message', message_id: messageId,
    message_version: messageVersion, version, previous_submission_id: previousSubmissionId,
    content_sha256: contentSha256, ...overrides };
}

test('latest saved version per message keeps first-submission conversation order and exact latest pins', () => {
  const rows = [
    row('submission-a1', 'message-a', 1, 2, null, sha('a')),
    row('submission-b1', 'message-b', 1, 4, null, sha('b')),
    row('submission-a2', 'message-a', 2, 7, 'submission-b1', sha('c')),
    row('submission-c1', 'message-c', 1, 8, null, sha('d')),
  ];
  assert.deepEqual(selectLatestProjectMessagePins(rows, { ownerUserId: owner, projectId: project }), [
    { message_id: 'message-a', submission_id: 'submission-a2', message_version: 2, content_sha256: sha('c'),
      first_submission_version: 2, latest_submission_version: 7, first_submission_id: 'submission-a1' },
    { message_id: 'message-b', submission_id: 'submission-b1', message_version: 1, content_sha256: sha('b'),
      first_submission_version: 4, latest_submission_version: 4, first_submission_id: 'submission-b1' },
    { message_id: 'message-c', submission_id: 'submission-c1', message_version: 1, content_sha256: sha('d'),
      first_submission_version: 8, latest_submission_version: 8, first_submission_id: 'submission-c1' },
  ]);
});

test('empty project message history resolves to an empty set', () => {
  assert.deepEqual(selectLatestProjectMessagePins([], { ownerUserId: owner, projectId: project }), []);
});

test('malformed scope, kind, identifiers, versions, hashes and message-version gaps fail closed', () => {
  const valid = row('submission-a1', 'message-a', 1, 2, null, sha('a'));
  for (const invalid of [
    { ...valid, owner_user_id: 'foreign-owner' },
    { ...valid, project_id: 'foreign-project' },
    { ...valid, submission_kind: 'run_execute' },
    { ...valid, id: '' },
    { ...valid, message_id: null },
    { ...valid, version: 0 },
    { ...valid, message_version: 'not-a-version' },
    { ...valid, content_sha256: 'A'.repeat(64) },
    { ...valid, content_sha256: 'short' },
  ]) {
    assert.throws(() => selectLatestProjectMessagePins([invalid], { ownerUserId: owner, projectId: project }), /PROJECT_MESSAGE_SET_INVALID/);
  }
  assert.throws(() => selectLatestProjectMessagePins([
    valid, row('submission-a2', 'message-a', 3, 3, 'submission-a1', sha('b')),
  ], { ownerUserId: owner, projectId: project }), /PROJECT_MESSAGE_SET_INVALID/);
  assert.throws(() => selectLatestProjectMessagePins([
    valid, row('submission-a2', 'message-a', 2, 1, 'submission-a1', sha('b')),
  ], { ownerUserId: owner, projectId: project }), /PROJECT_MESSAGE_SET_INVALID/);
});

test('duplicate submission IDs, project versions or message versions fail closed', () => {
  const first = row('submission-a1', 'message-a', 1, 2, null, sha('a'));
  for (const rows of [
    [first, { ...first, version: 3 }],
    [first, row('submission-b1', 'message-b', 1, 2, null, sha('b'))],
    [first, row('submission-a2', 'message-a', 1, 3, 'submission-a1', sha('b'))],
  ]) {
    assert.throws(() => selectLatestProjectMessagePins(rows, { ownerUserId: owner, projectId: project }), /PROJECT_MESSAGE_SET_INVALID/);
  }
});

test('excessive histories fail closed', () => {
  const tooMany = Array.from({ length: 501 }, (_, index) => row(`submission-${index}`, `message-${index}`, 1,
    index + 1, null, sha('a')));
  assert.throws(() => selectLatestProjectMessagePins(tooMany, { ownerUserId: owner, projectId: project }), /PROJECT_MESSAGE_SET_INVALID/);
});

test('database loader scopes owner/project and requests only the bounded sentinel row', async () => {
  let captured: { sql: string; values?: unknown[] } | undefined;
  const pins = await loadLatestProjectMessagePins({ query: async (sql, values) => {
    captured = { sql, values };
    return { rows: [row('submission-a1', 'message-a', 1, 3, null, sha('a'))] };
  } }, { ownerUserId: owner, projectId: project });
  assert.deepEqual(pins[0], { message_id: 'message-a', submission_id: 'submission-a1', message_version: 1,
    content_sha256: sha('a'), first_submission_version: 3, latest_submission_version: 3, first_submission_id: 'submission-a1' });
  assert.match(captured!.sql, /WHERE owner_user_id=\$1 AND project_id=\$2 AND submission_kind='project_message'/);
  assert.match(captured!.sql, /ORDER BY version\s+LIMIT \$3/);
  assert.deepEqual(captured!.values, [owner, project, 501]);
  await assert.rejects(loadLatestProjectMessagePins({ query: async () => ({ rows: Array(501).fill(row('x', 'm', 1, 1, null, sha('a'))) }) },
    { ownerUserId: owner, projectId: project }), /PROJECT_MESSAGE_SET_INVALID/);
});
