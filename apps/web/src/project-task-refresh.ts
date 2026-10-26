import { schemas } from '@bondbuddy/contracts';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Dto } from './api.js';
import { isDateTime } from './schema-formats.js';

type TaskPage = Dto<'ProjectTasksResponse'>;
type Task = TaskPage['items'][number];
export type ProjectTaskRefreshBoundary = Pick<Task, 'run_id' | 'created_at'>;
const boundarySchema = Type.Pick(schemas.ProjectTasksResponse.properties.items.items, ['run_id', 'created_at']);

function invalid(reason: string): never {
  throw new Error('Project task refresh could not verify ' + reason);
}

function validatePage(value: TaskPage, projectId: string): void {
  if (!Value.Check(schemas.ProjectTasksResponse, value) || value.project_id !== projectId) invalid('the collection identity or response schema');
  if (value.items.some(task => !isDateTime(task.created_at) || !isDateTime(task.updated_at))) invalid('the task date-time values');
  if (value.page.has_more !== (value.page.next_cursor !== null)) invalid('the continuation cursor');
  if (value.page.has_more && !value.items.length) invalid('an empty continuation page');
  let lastTime = Infinity;
  const seen = new Set<string>();
  for (const task of value.items) {
    if (seen.has(task.run_id)) invalid('duplicate tasks');
    seen.add(task.run_id);
    const time = Date.parse(task.created_at);
    if (!Number.isFinite(time) || time > lastTime) invalid('submission order');
    lastTime = time;
  }
}

/**
 * Re-read a collection's loaded task range using only the fresh cursor chain.
 * The API sorts by PostgreSQL (created_at, id), but DTO timestamps lose its
 * microseconds. An old tail ID is exact; if it disappeared, read past its whole
 * millisecond bucket instead of inventing an id tie-break from rounded dates.
 * No cached task state is appended to a partial fresh page sequence.
 */
export async function refreshProjectTasks(
  projectId: string,
  previous: TaskPage | undefined,
  read: (cursor?: string) => Promise<TaskPage>,
  aborted: () => boolean,
  boundary?: ProjectTaskRefreshBoundary,
): Promise<TaskPage | undefined> {
  if (aborted()) return undefined;
  if (!projectId) invalid('the root project');
  if (previous) validatePage(previous, projectId);
  if (boundary && (!Value.Check(boundarySchema, boundary) || !isDateTime(boundary.created_at))) invalid('the saved task boundary');
  const priorTasks = new Map<string, Task>((previous?.items ?? []).map(task => [task.run_id, task]));
  const tail = previous?.items.at(-1) ?? boundary;
  const boundaryTime = tail ? Date.parse(tail.created_at) : undefined;
  const seenRuns = new Set<string>(), seenCursors = new Set<string>();
  const items: Task[] = [];
  let cursor: string | undefined, lastTime = Infinity;
  try {
    do {
      if (aborted()) return undefined;
      const response = await read(cursor);
      if (aborted()) return undefined;
      validatePage(response, projectId);
      const page = structuredClone(response);
      for (const task of page.items) {
        if (seenRuns.has(task.run_id)) invalid('duplicate tasks across pages');
        seenRuns.add(task.run_id);
        const time = Date.parse(task.created_at), prior = priorTasks.get(task.run_id);
        if (time > lastTime) invalid('submission order across pages');
        if (prior && (prior.project_id !== task.project_id || Date.parse(prior.created_at) !== time)) invalid('an existing task execution project or submission time');
        if (tail?.run_id === task.run_id && Date.parse(tail.created_at) !== time) invalid('the saved tail submission time');
        lastTime = time;
        items.push(task);
      }
      const next = page.page.next_cursor;
      if (next !== null) {
        if (seenCursors.has(next)) invalid('a cursor that did not advance');
        seenCursors.add(next);
      }
      const covered = !tail || seenRuns.has(tail.run_id) || boundaryTime !== undefined && page.items.some(task => Date.parse(task.created_at) < boundaryTime);
      if (covered || !page.page.has_more) return { project_id: projectId, items, page: { ...page.page } };
      cursor = next!;
    } while (true);
  } catch (error) {
    if (aborted()) return undefined;
    throw error;
  }
}
