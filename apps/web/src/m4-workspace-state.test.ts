import assert from 'node:assert/strict';
import test from 'node:test';
import { closeWorkspaceTab, discussTask, initialReading, m4ProgressLabel, openWorkspaceTab, prepareInput, readWorkspaceReading, selectWorkspaceTab, taskArtifactAvailable, taskSubmitted } from './m4-workspace-state.js';

test('submission/completion do not move a reader away from the selected old artifact', () => {
  let state = openWorkspaceTab(initialReading(), { key: 'old', kind: 'artifact', artifactId: 'a1', version: 1, title: '立项 v1' });
  state.scroll.old = 512;
  state = taskSubmitted(state, 'r2', '正在制作');
  state = taskArtifactAvailable(state, 'r2', 'a2', 2, '立项 v2');
  assert.equal(state.selected, 'old'); assert.equal(state.scroll.old, 512);
  assert.deepEqual(state.tabs.at(-1), { key: 'run:r2', kind: 'artifact', runId: 'r2', artifactId: 'a2', version: 2, title: '立项 v2' });
});
test('making becomes the actual artifact in place without duplicate tabs or an extra selection', () => {
  let state = taskSubmitted(initialReading(), 'r1', '正在制作');
  assert.equal(state.selected, 'run:r1');
  state = taskArtifactAvailable(state, 'r1', 'a1', 1, '立项 v1');
  state = taskArtifactAvailable(state, 'r1', 'a1', 1, '立项 v1');
  state = openWorkspaceTab(state, { key: 'a1', kind: 'artifact', artifactId: 'a1', version: 1, title: '立项 v1' });
  assert.equal(state.tabs.length, 2); assert.equal(state.selected, 'run:r1');
});
test('completed task does not reopen a closed making tab', () => {
  const closed = closeWorkspaceTab(taskSubmitted(initialReading(), 'r1', '正在制作'), 'run:r1');
  assert.deepEqual(taskArtifactAvailable(closed, 'r1', 'a1', 1, '立项 v1'), closed);
});
test('discussion focus preserves draft text and an exact old-version quote', () => {
  const quote = { artifactId: 'a1', version: 1, anchor: 'p3', text: '资产100万元' };
  const composer = { text: '还没发送的文字', quote, taskContext: '旧上下文' };
  assert.deepEqual(discussTask(composer, '准备立项 v2'), { text: composer.text, quote, taskContext: '准备立项 v2' });
});
test('prepare input preserves artifact tabs and invalid recovered view cannot replace records', () => {
  const state = prepareInput(openWorkspaceTab(initialReading(), { key: 'a1', kind: 'artifact', artifactId: 'a1', version: 1, title: '正文' }), 'initiation');
  assert.equal(state.selected, 'input'); assert.equal(state.tabs.length, 2);
  assert.deepEqual(readWorkspaceReading(state), state);
  assert.equal(readWorkspaceReading({ ...state, selected: 'missing' }), null);
  assert.equal(readWorkspaceReading({ ...state, tabs: [...state.tabs, state.tabs[0]] }), null);
  assert.equal(readWorkspaceReading({ ...state, scroll: { a1: -10 } }), null);
  assert.equal(selectWorkspaceTab(state, 'missing'), state);
});
test('progress describes observed public actions and keeps unknown internal stages out of the UI',()=>{
  assert.equal(m4ProgressLabel('model_generation','m4_writing_files'),'正在制作可编辑文件');
  assert.equal(m4ProgressLabel('unrecognized_private_stage','unrecognized_reason'),'正在同步本轮执行状态');
});
