import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Dto } from './api.js';
import { refreshProjectTasks } from './project-task-refresh.js';

type Page = Dto<'ProjectTasksResponse'>;
type Task = Page['items'][number];
const root = 'collection-root';
const task = (id: string, second: number, options: Partial<Task> = {}): Task => ({
  run_id: id, project_id: root, kind: 'update', state: 'running', stage: 'word_delivery',
  created_at: `2026-10-25T08:00:${String(second).padStart(2, '0')}.000Z`,
  updated_at: '2026-10-25T09:00:00.000Z', artifact_id: null, report_id: null, topic_id: null,
  document_type: null, operation: null, ...options,
});
const page = (items: Task[], cursor: string | null = null, projectId = root): Page => ({ project_id: projectId, items, page: { has_more: cursor !== null, next_cursor: cursor } });
function reader(pages: Page[]) {
  const cursors: (string | undefined)[] = [];
  return { cursors, read: async (cursor?: string) => { cursors.push(cursor); assert.ok(pages[cursors.length - 1], 'Unexpected extra read'); return pages[cursors.length - 1]; } };
}

test('initial refresh reads one fresh page and retains its exact continuation', async () => {
  const fresh = page([task('new', 9)], 'fresh-next'), source = reader([fresh]);
  const result = await refreshProjectTasks(root, undefined, source.read, () => false);
  assert.deepEqual(source.cursors, [undefined]); assert.deepEqual(result, fresh);
  fresh.items[0].state = 'failed'; assert.equal(result!.items[0].state, 'running', 'Return detached fresh data');
});

test('refresh includes new tasks and re-reads through the previously loaded tail without stale states', async () => {
  const previous = page([task('old-head', 8), task('old-middle', 6), task('old-tail', 4)], 'old-cursor');
  const before = structuredClone(previous);
  const source = reader([page([task('new', 10), task('old-head', 8, { state: 'succeeded', artifact_id: 'result' })], 'fresh-two'),
    page([task('old-middle', 6, { state: 'failed' }), task('old-tail', 4, { state: 'cancelled' })], 'fresh-older')]);
  const result = await refreshProjectTasks(root, previous, source.read, () => false);
  assert.deepEqual(source.cursors, [undefined, 'fresh-two']);
  assert.deepEqual(result!.items.map(item => [item.run_id, item.state]), [['new', 'running'], ['old-head', 'succeeded'], ['old-middle', 'failed'], ['old-tail', 'cancelled']]);
  assert.equal(result!.page.next_cursor, 'fresh-older'); assert.deepEqual(previous, before);
});

test('an old tail found on the fresh first page needs no stale cursor or extra reads', async () => {
  const source = reader([page([task('new', 10), task('tail', 4)], 'new-older')]);
  const result = await refreshProjectTasks(root, page([task('tail', 4)], 'obsolete'), source.read, () => false);
  assert.deepEqual(source.cursors, [undefined]); assert.equal(result!.page.next_cursor, 'new-older');
});

test('removed tail reads past its entire rounded millisecond bucket rather than guessing the SQL id tie-break', async () => {
  const sameTime = '2026-10-25T08:00:04.123Z';
  const previous = page([task('removed-tail', 4, { created_at: sameTime })], 'stale');
  const source = reader([page([task('z-microsecond-first', 4, { created_at: sameTime })], 'two'),
    page([task('a-microsecond-second', 4, { created_at: sameTime })], 'three'), page([task('strictly-older', 3)], 'four')]);
  const result = await refreshProjectTasks(root, previous, source.read, () => false);
  assert.deepEqual(source.cursors, [undefined, 'two', 'three']);
  assert.deepEqual(result!.items.map(item => item.run_id), ['z-microsecond-first', 'a-microsecond-second', 'strictly-older']);
  assert.equal(result!.page.next_cursor, 'four'); assert.ok(!result!.items.some(item => item.run_id === 'removed-tail'));
});

test('same DTO millisecond does not impose an invented run-id ordering on PostgreSQL microseconds', async () => {
  const at = '2026-10-25T08:00:04.000Z';
  const source = reader([page([task('a-first', 4, { created_at: at })], 'two'), page([task('z-tail', 4, { created_at: at })])]);
  const result = await refreshProjectTasks(root, page([task('z-tail', 4, { created_at: at })]), source.read, () => false);
  assert.deepEqual(result!.items.map(item => item.run_id), ['a-first', 'z-tail']);
});

test('removed tasks disappear when the fresh collection ends, including an empty collection', async () => {
  const prior = page([task('removed', 4)]);
  assert.deepEqual(await refreshProjectTasks(root, prior, async () => page([]), () => false), page([]));
  assert.deepEqual(await refreshProjectTasks(root, prior, async () => page([task('replacement', 9)]), () => false), page([task('replacement', 9)]));
});

test('linked execution projects are valid while the response collection must remain the requested root', async () => {
  const linked = task('linked', 4, { project_id: 'owned-update-workspace', kind: 'review' });
  assert.deepEqual((await refreshProjectTasks(root, undefined, async () => page([linked]), () => false))!.items, [linked]);
  await assert.rejects(refreshProjectTasks(root, undefined, async () => page([linked], null, 'different-root'), () => false), /collection identity/);
  await assert.rejects(refreshProjectTasks(root, page([linked], null, 'different-root'), async () => page([]), () => false), /collection identity/);
});

test('an existing run cannot silently change execution project or submission time', async () => {
  for (const changed of [{ project_id: 'another-execution-project' }, { created_at: '2026-10-25T08:00:05.000Z' }]) {
    await assert.rejects(refreshProjectTasks(root, page([task('old', 4)]), async () => page([task('old', 4, changed)]), () => false), /execution project or submission time/);
  }
});

test('malformed responses and impossible date-time values never become a partial refresh', async () => {
  for (const broken of [page([task('bad', 4, { created_at: '2026-02-30T08:00:04Z' })]), page([task('bad', 4, { updated_at: '2026-04-31T08:00:04Z' })]),
    { ...page([]), project_id: undefined }, page([task('bad', 4, { state: 'unknown' as Task['state'] })])]) {
    await assert.rejects(refreshProjectTasks(root, undefined, async () => broken as Page, () => false), /response schema|date-time/);
  }
});

test('duplicate run identities within or across pages are rejected', async () => {
  await assert.rejects(refreshProjectTasks(root, undefined, async () => page([task('same', 4), task('same', 4)]), () => false), /duplicate tasks/);
  const source = reader([page([task('same', 8)], 'two'), page([task('same', 8)])]);
  await assert.rejects(refreshProjectTasks(root, page([task('tail', 1)]), source.read, () => false), /duplicate tasks across pages/);
});

test('missing, contradictory, empty and repeating continuation pages are rejected', async () => {
  const broken = [
    { ...page([task('one', 8)]), page: { has_more: true, next_cursor: null } },
    { ...page([task('one', 8)]), page: { has_more: false, next_cursor: 'unexpected' } },
    page([], 'empty-next'),
  ];
  for (const response of broken) await assert.rejects(refreshProjectTasks(root, undefined, async () => response, () => false), /continuation/);
  const source = reader([page([task('one', 8)], 'same'), page([task('two', 7)], 'same')]);
  await assert.rejects(refreshProjectTasks(root, page([task('tail', 1)]), source.read, () => false), /cursor that did not advance/);
});

test('submission order cannot move newer within a page or across its continuation', async () => {
  await assert.rejects(refreshProjectTasks(root, undefined, async () => page([task('older', 4), task('newer', 8)]), () => false), /submission order/);
  const source = reader([page([task('older', 4)], 'two'), page([task('newer', 8)])]);
  await assert.rejects(refreshProjectTasks(root, page([task('tail', 1)]), source.read, () => false), /submission order across pages/);
});

test('a later read failure returns no partial result and leaves the previous cache unchanged', async () => {
  const previous = page([task('tail', 1)]), before = structuredClone(previous); let calls = 0;
  await assert.rejects(refreshProjectTasks(root, previous, async () => { if (++calls === 1) return page([task('fresh', 9)], 'two'); throw new Error('network failed'); }, () => false), /network failed/);
  assert.equal(calls, 2); assert.deepEqual(previous, before);
});

test('abort before reading does no work and abort after any read suppresses stale data', async () => {
  let reads = 0;
  assert.equal(await refreshProjectTasks(root, undefined, async () => { reads++; return page([]); }, () => true), undefined); assert.equal(reads, 0);
  let cancelled = false;
  assert.equal(await refreshProjectTasks(root, page([task('tail', 1)]), async () => { cancelled = true; return page([task('wrong', 8)], null, 'wrong'); }, () => cancelled), undefined);
  cancelled = false;
  assert.equal(await refreshProjectTasks(root, undefined, async () => { cancelled = true; throw new Error('aborted read'); }, () => cancelled), undefined);
});

test('owner or component generation changes while a page is in flight discard that response', async () => {
  let owner = 'first-owner', release!: (value: Page) => void;
  const pending = refreshProjectTasks(root, undefined, () => new Promise(resolve => { release = resolve; }), () => owner !== 'first-owner');
  owner = 'next-owner'; release(page([task('late', 4)]));
  assert.equal(await pending, undefined);
});

test('a return-to-list boundary restores the read range without cached task content or a fake response', async () => {
  const source = reader([page([task('new', 9)], 'fresh-two'), page([task('tail', 4, { state: 'failed' })], 'fresh-older')]);
  const result = await refreshProjectTasks(root, undefined, source.read, () => false, { run_id: 'tail', created_at: task('tail', 4).created_at });
  assert.deepEqual(source.cursors, [undefined, 'fresh-two']);
  assert.deepEqual(result!.items.map(item => [item.run_id, item.state]), [['new', 'running'], ['tail', 'failed']]);
  assert.equal(result!.page.next_cursor, 'fresh-older');
});

test('a removed return boundary also crosses the rounded millisecond group conservatively', async () => {
  const source = reader([page([task('same-time', 4)], 'next'), page([task('older', 3)])]);
  const result = await refreshProjectTasks(root, undefined, source.read, () => false, { run_id: 'removed', created_at: task('removed', 4).created_at });
  assert.deepEqual(source.cursors, [undefined, 'next']); assert.deepEqual(result!.items.map(item => item.run_id), ['same-time', 'older']);
});

test('an existing complete page range takes precedence over a shallower saved return boundary', async () => {
  const source = reader([page([task('head', 8)], 'next'), page([task('tail', 4)])]);
  const result = await refreshProjectTasks(root, page([task('head', 8), task('tail', 4)]), source.read, () => false, { run_id: 'head', created_at: task('head', 8).created_at });
  assert.deepEqual(source.cursors, [undefined, 'next']); assert.equal(result!.items.at(-1)!.run_id, 'tail');
});

test('malformed saved boundaries and a changed tail submission time fail without accepting a partial range', async () => {
  let reads = 0;
  await assert.rejects(refreshProjectTasks(root, undefined, async () => { reads++; return page([]); }, () => false, { run_id: 'tail', created_at: 'not-a-date' }), /saved task boundary/);
  assert.equal(reads, 0);
  await assert.rejects(refreshProjectTasks(root, undefined, async () => page([task('tail', 5)]), () => false, { run_id: 'tail', created_at: task('tail', 4).created_at }), /tail submission time/);
});
