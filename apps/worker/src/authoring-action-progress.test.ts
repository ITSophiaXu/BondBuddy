import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectAuthoringActivity,
  createAuthoringActivityObserver,
} from './authoring-action-progress.js';
test('authoring progress publishes real categories without reasoning, paths, tool output or arbitrary model text', async () => {
  const sensitive = {
    type: 'item.completed',
    item: { id: 'i1', type: 'reasoning', text: 'secret reasoning /private/path' },
  };
  const projected = projectAuthoringActivity(sensitive, 'call')!;
  assert.equal(projected.code, 'analyze');
  assert.equal(projected.state, 'completed');
  assert.doesNotMatch(JSON.stringify(projected), /secret|private/);
  assert.equal(
    projectAuthoringActivity(
      {
        type: 'item.completed',
        item: { id: 'i2', type: 'agent_message', text: 'arbitrary private document text' },
      },
      'call',
    ),
    null,
  );
  assert.equal(
    projectAuthoringActivity(
      {
        type: 'item.completed',
        item: { id: 'i2', type: 'agent_message', text: 'BB_PROGRESS:read_knowledge' },
      },
      'call',
    )?.code,
    'read_knowledge',
  );
  assert.equal(
    projectAuthoringActivity(
      {
        type: 'item.completed',
        item: {
          id: 'i4',
          type: 'agent_message',
          text: 'BB_PROGRESS:write_document | 已完成目录核对，正在更新财务章节。',
        },
      },
      'call',
    )?.summary,
    '已完成目录核对，正在更新财务章节。',
  );
  assert.equal(
    projectAuthoringActivity(
      {
        type: 'item.completed',
        item: {
          id: 'i5',
          type: 'agent_message',
          text: 'BB_PROGRESS:write_document | <script>alert(1)</script>',
        },
      },
      'call',
    )?.summary,
    undefined,
  );
  assert.equal(
    projectAuthoringActivity(
      {
        type: 'item.completed',
        item: { id: 'i3', type: 'command_execution', command: 'word_patch.py', exit_code: 1 },
      },
      'call',
    )?.state,
    'failed',
  );
  const seen: any[] = [],
    abort = new AbortController(),
    observer = createAuthoringActivityObserver({
      signal: abort.signal,
      persist: async (a) => {
        seen.push(a);
      },
    });
  observer.onEvent(sensitive, { call_id: 'call' });
  observer.onEvent(sensitive, { call_id: 'call' });
  await observer.drain();
  assert.equal(seen.length, 1);
});
