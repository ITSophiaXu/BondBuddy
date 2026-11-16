import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthoringProgress, ReviewTask, Run, RunEvent } from './billing-types.js';
import { reviewLiveStatus, reviewProgressPage } from './review-progress.js';
import { reviewTaskProgress } from './review-timeline.js';

const run = {
  run_id: 'run-1',
  state: 'running',
  stage: 'review_rules',
  event_cursor: 10,
} as Run;

const progress = {
  sampled_at: '2026-11-12T10:01:30Z',
  last_activity_at: '2026-11-12T10:00:00Z',
  clock_running: true,
} as AuthoringProgress;

function actionEvent(seq: number, code: string, state: 'started' | 'completed'): RunEvent {
  return {
    event_id: `event-${seq}`,
    schema_version: 1,
    trace_id: 'trace',
    run_id: run.run_id,
    seq,
    occurred_at: '2026-11-12T10:00:00Z',
    type: 'run.state_changed',
    state: 'running',
    stage: run.stage,
    payload: {
      action: {
        version: 'review-action-v1',
        action_id: seq.toString(16).padStart(64, '0'),
        code,
        state,
      },
    },
  } as RunEvent;
}

const task = {
  run,
  events: [
    actionEvent(1, 'read_materials', 'started'),
    actionEvent(2, 'read_knowledge', 'completed'),
  ],
} as unknown as ReviewTask;

test('running stale status does not claim the model is still processing', () => {
  const status = reviewLiveStatus(run, task, progress);
  assert.match(status.summary, /正在同步任务进度/);
  assert.doesNotMatch(status.summary, /模型仍在处理/);
});

test('current action follows run stage when latest started action lags behind', () => {
  const status = reviewTaskProgress(task);
  assert.equal(status.title, '核对复核依据');
  assert.notEqual(status.title, '正在读取材料');
  assert.deepEqual(status.completed.map(item => item.code), ['read_knowledge']);
});

test('active review progress page exposes a refresh-status action', () => {
  const html = reviewProgressPage(run, task, undefined);
  assert.match(html, /data-review-action="refresh-status"/);
});
