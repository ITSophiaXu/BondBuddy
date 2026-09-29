import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  PROJECT_MESSAGE_SET_EMPTY_VERSION,
  canonicalProjectMessageSetContent,
  projectMessageSetRef,
  type ProjectMessageSetRef,
} from '@bondbuddy/contracts';
import {
  assertProjectMessageSetRefMatches,
  isProjectMessageSetLockError,
  loadCurrentProjectMessageSetPin,
} from './project-message-set-lock.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const row = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'submission-a', message_id: 'message-a', message_version: 1, version: 1, content_sha256: sha('a'),
  ...overrides,
});

function queryReturning(rows: Record<string, unknown>[]) {
  return { query: async () => ({ rows }) };
}

test('empty history is an explicit empty set, never inferred from absence of rows', async () => {
  const pin = await loadCurrentProjectMessageSetPin(queryReturning([]), { ownerUserId: 'owner-a', projectId: 'project-a' });
  assert.equal(pin.version, PROJECT_MESSAGE_SET_EMPTY_VERSION);
  assert.deepEqual(pin.members, []);
  assert.deepEqual(pin.message_ids, []);
  assert.equal(pin.content_sha256, createHash('sha256').update(canonicalProjectMessageSetContent(pin), 'utf8').digest('hex'));
});

test('latest version per message is selected in first-submission conversation order', async () => {
  const pin = await loadCurrentProjectMessageSetPin(queryReturning([
    row({ id: 'sub-a1', message_id: 'message-a', message_version: 1, version: 3, content_sha256: sha('a1') }),
    row({ id: 'sub-a2', message_id: 'message-a', message_version: 2, version: 5, content_sha256: sha('a2') }),
    row({ id: 'sub-b1', message_id: 'message-b', message_version: 1, version: 4, content_sha256: sha('b1') }),
  ]), { ownerUserId: 'owner-a', projectId: 'project-a' });
  assert.deepEqual(pin.members.map(member => [member.message_id, member.message_version, member.content_sha256]),
    [['message-a', 2, sha('a2')], ['message-b', 1, sha('b1')]]);
  assert.deepEqual(pin.message_ids, ['message-a', 'message-b']);
  assert.equal(pin.version, 5, 'set version advances on edits without changing conversation order');
});

test('malformed history fails closed instead of fabricating a set', async () => {
  const cases: Array<[string, Record<string, unknown>[]]> = [
    ['duplicate submission id', [row(), row({ message_id: 'message-b', version: 2 })]],
    ['duplicate project version', [row(), row({ id: 'submission-b', message_id: 'message-b', version: 1 })]],
    ['message version gap', [row(), row({ id: 'submission-b', message_version: 3, version: 2 })]],
    ['bad content hash', [row({ content_sha256: 'nope' })]],
  ];
  for (const [name, rows] of cases) {
    await assert.rejects(loadCurrentProjectMessageSetPin(queryReturning(rows), { ownerUserId: 'owner-a', projectId: 'project-a' }),
      (error: unknown) => isProjectMessageSetLockError(error), name);
  }
});

test('only the exact aggregate ref matches; a bare version or divergent projection never does', async () => {
  const pin = await loadCurrentProjectMessageSetPin(queryReturning([
    row({ id: 'sub-a1', message_id: 'message-a', version: 1, content_sha256: sha('a') }),
    row({ id: 'sub-b1', message_id: 'message-b', version: 2, content_sha256: sha('b') }),
  ]), { ownerUserId: 'owner-a', projectId: 'project-a' });
  const ref = projectMessageSetRef(pin);
  assert.doesNotThrow(() => assertProjectMessageSetRefMatches(pin, ref));
  for (const bad of [
    { version: ref.version } as unknown as ProjectMessageSetRef,
    { ...ref, content_sha256: sha('tampered') },
    { ...ref, message_ids: [ref.message_ids[0]!] },
    { ...ref, message_ids: [...ref.message_ids].reverse() },
  ]) assert.throws(() => assertProjectMessageSetRefMatches(pin, bad), (error: unknown) => isProjectMessageSetLockError(error));
  const empty = await loadCurrentProjectMessageSetPin(queryReturning([]), { ownerUserId: 'owner-a', projectId: 'project-a' });
  assert.throws(() => assertProjectMessageSetRefMatches(empty, ref), (error: unknown) => isProjectMessageSetLockError(error),
    'a non-empty ref never matches an empty active set');
});
