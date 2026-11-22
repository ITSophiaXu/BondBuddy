import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectMessagePin } from './project-message-pin-loader.js';
import {
  PROJECT_MESSAGE_SET_EMPTY_VERSION,
  loadProjectMessageSetPin,
  normalizeProjectMessageSet,
  projectMessageSetRequirementsMatch,
  projectMessageSetRequirementsPin,
} from './project-message-set-pin.js';

const owner = 'synthetic-owner';
const project = 'synthetic-project';
const sha = (letter: string) => letter.repeat(64);

function pin(
  messageId: string,
  messageVersion: number,
  submissionId: string,
  firstSubmissionVersion: number,
  contentSha256: string,
  firstSubmissionId = submissionId,
  latestSubmissionVersion = firstSubmissionVersion + messageVersion - 1,
): ProjectMessagePin {
  return {
    message_id: messageId,
    submission_id: submissionId,
    message_version: messageVersion,
    content_sha256: contentSha256,
    first_submission_version: firstSubmissionVersion,
    latest_submission_version: latestSubmissionVersion,
    first_submission_id: firstSubmissionId,
  };
}

const setA = [
  pin('message-a', 2, 'submission-a2', 2, sha('c'), 'submission-a1'),
  pin('message-b', 1, 'submission-b1', 4, sha('b')),
];

test('one active latest version per message normalizes to a deterministic conversation-ordered set', () => {
  const normalized = normalizeProjectMessageSet(setA);
  assert.equal(normalized.version, 4);
  assert.deepEqual(
    normalized.members.map((member) => [
      member.message_id,
      member.message_version,
      member.submission_id,
    ]),
    [
      ['message-a', 2, 'submission-a2'],
      ['message-b', 1, 'submission-b1'],
    ],
  );
  assert.deepEqual(normalized.message_ids, ['message-a', 'message-b']);
  assert.equal(normalized.content_sha256.length, 64);
  assert.deepEqual(
    normalizeProjectMessageSet([...setA].reverse()),
    normalized,
    'input array order never changes the logical set hash',
  );
  assert.deepEqual(projectMessageSetRequirementsPin(normalized), {
    version: normalized.version,
    content_sha256: normalized.content_sha256,
    message_ids: ['message-a', 'message-b'],
  });
});

test('a different conversation order of the same members hashes differently', () => {
  const reordered = normalizeProjectMessageSet([
    pin('message-b', 1, 'submission-b1', 2, sha('b')),
    pin('message-a', 2, 'submission-a2', 4, sha('c'), 'submission-a1'),
  ]);
  assert.equal(
    reordered.content_sha256 === normalizeProjectMessageSet(setA).content_sha256,
    false,
    'conversation order is part of the hash, lexicographic message-id order is not',
  );
});

test('a saved edit produces a new version that changes the set hash but keeps the conversation position', () => {
  const before = normalizeProjectMessageSet(setA);
  const edited = normalizeProjectMessageSet([
    pin('message-a', 3, 'submission-a3', 2, sha('e'), 'submission-a1', 5),
    pin('message-b', 1, 'submission-b1', 4, sha('b')),
  ]);
  assert.notEqual(edited.content_sha256, before.content_sha256);
  assert.equal(
    edited.version,
    before.version + 1,
    'the set version advances when an existing message is edited',
  );
  assert.deepEqual(
    edited.message_ids,
    before.message_ids,
    'editing a message stays one active member',
  );
});

test('the empty active set is deterministic, versioned, and distinct from any nonempty set', () => {
  const empty = normalizeProjectMessageSet([]);
  assert.equal(empty.version, PROJECT_MESSAGE_SET_EMPTY_VERSION);
  assert.deepEqual(empty.members, []);
  assert.deepEqual(empty.message_ids, []);
  assert.deepEqual(normalizeProjectMessageSet([]), empty);
  assert.notEqual(empty.content_sha256, normalizeProjectMessageSet(setA).content_sha256);
});

test('incomplete, duplicated, gap or over-limit member metadata fails closed', () => {
  const invalid: ProjectMessagePin[] = [
    pin('message-a', 1, 'submission-a1', 1, sha('a')),
    pin('message-a', 2, 'submission-a2', 2, sha('b'), 'submission-a1'),
  ];
  for (const pins of [
    invalid,
    [
      pin('message-a', 1, 'submission-a1', 1, sha('a')),
      pin('message-b', 1, 'submission-b1', 1, sha('b')),
    ],
    [
      pin('message-a', 1, 'submission-a1', 1, sha('a')),
      pin('message-b', 1, 'submission-a1', 2, sha('b')),
    ],
    [pin('message-a', 0, 'submission-a1', 1, sha('a'))],
    [pin('message-a', 1, 'submission-a1', 0, sha('a'))],
    [pin('message-a', 1, 'submission-a1', 1, 'A'.repeat(64))],
    [pin('message-a', 1, 'submission-a1', 1, 'short')],
    [pin('message-a', 1, 'submission-a1', 1, sha('a'), 'bad first id')],
    Array.from({ length: 501 }, (_, index) =>
      pin(`message-${index}`, 1, `submission-${index}`, index + 1, sha('a')),
    ),
  ]) {
    assert.throws(() => normalizeProjectMessageSet(pins), /PROJECT_MESSAGE_SET_INVALID/);
  }
});

test('bounded load is owner/project scoped and never trusts a foreign or memberless row', async () => {
  let captured: { sql: string; values?: unknown[] } | undefined;
  const loaded = await loadProjectMessageSetPin(
    {
      query: async (sql, values) => {
        captured = { sql, values };
        return {
          rows: [
            {
              id: 'submission-a1',
              owner_user_id: owner,
              project_id: project,
              submission_kind: 'project_message',
              message_id: 'message-a',
              message_version: 1,
              version: 3,
              content_sha256: sha('a'),
            },
          ],
        };
      },
    },
    { ownerUserId: owner, projectId: project },
  );
  assert.equal(loaded.version, 3);
  assert.deepEqual(loaded.message_ids, ['message-a']);
  assert.match(
    captured!.sql,
    /WHERE owner_user_id=\$1 AND project_id=\$2 AND submission_kind='project_message'/,
  );
  await assert.rejects(
    loadProjectMessageSetPin(
      {
        query: async () => ({
          rows: [
            {
              id: 'submission-a1',
              owner_user_id: 'foreign-owner',
              project_id: project,
              submission_kind: 'project_message',
              message_id: 'message-a',
              message_version: 1,
              version: 3,
              content_sha256: sha('a'),
            },
          ],
        }),
      },
      { ownerUserId: owner, projectId: project },
    ),
    /PROJECT_MESSAGE_SET_INVALID/,
  );
  await assert.rejects(
    loadProjectMessageSetPin(
      {
        query: async () => ({
          rows: [
            {
              id: 'submission-a1',
              owner_user_id: owner,
              project_id: project,
              submission_kind: 'project_message',
              message_id: 'message-a',
              message_version: 1,
              version: 3,
            },
          ],
        }),
      },
      { ownerUserId: owner, projectId: project },
    ),
    /PROJECT_MESSAGE_SET_INVALID/,
  );
});

test('a bound aggregate only matches when it carries the exact recomputed members and hash', () => {
  const expected = normalizeProjectMessageSet(setA);
  assert.equal(
    projectMessageSetRequirementsMatch(expected, projectMessageSetRequirementsPin(expected)),
    true,
  );
  assert.equal(
    projectMessageSetRequirementsMatch(expected, {
      version: expected.version,
      content_sha256: expected.content_sha256,
      message_ids: ['message-b', 'message-a'],
    }),
    false,
  );
  assert.equal(
    projectMessageSetRequirementsMatch(expected, {
      version: expected.version,
      content_sha256: expected.content_sha256,
      message_ids: ['message-a'],
    }),
    false,
  );
  assert.equal(
    projectMessageSetRequirementsMatch(expected, {
      version: expected.version,
      content_sha256: sha('f'),
      message_ids: ['message-a', 'message-b'],
    }),
    false,
  );
  assert.equal(
    projectMessageSetRequirementsMatch(expected, {
      version: expected.version,
      content_sha256: sha('a'),
      message_ids: ['message-a', 'message-b'],
    }),
    false,
    'a bare version with no recomputed member hash can never be accepted',
  );
});
