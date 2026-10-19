import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedState, uploadSource, runPreview, createProject, latestFiles } from './model.js';

test('generation cannot borrow a source from another project', () => {
  const state = seedState(), p = state.projects[0];
  p.draft.sourceId = state.projects[1].files[0].id;
  p.draft.selected = ['application'];
  const original = structuredClone(state);
  assert.throws(() => runPreview(state, p, 'generation'), /当前项目/);
  assert.deepEqual(state, original);
});
test('regeneration retains previous files and their immutable source and requirements', () => {
  const state = seedState(), p = state.projects[0];
  p.draft.sourceId = p.files[1].id; p.draft.selected = ['application']; p.draft.requirements = '第一轮要求';
  const first = runPreview(state, p, 'generation');
  const firstFile = structuredClone(p.files.find(f => f.jobId === first.id)!);
  uploadSource(p, { name: '新募集书.docx', size: 128 }); p.draft.requirements = '第二轮要求';
  runPreview(state, p, 'generation');
  assert.deepEqual(p.files.find(f => f.id === firstFile.id), firstFile);
  assert.equal(firstFile.sourceVersion, 2);
  const latest = latestFiles(p).find(f => f.type === 'application')!;
  assert.equal(latest.version, 2); assert.equal(latest.sourceVersion, 3); assert.equal(latest.requirements, '第二轮要求');
  assert.equal(state.projects[1].files.length, 4);
});
test('integrity archives by subject type and keeps the original roster snapshot', () => {
  const state = seedState(), p = state.projects[0];
  p.draft.subjects = [{ id: 'c', name: '示例企业', role: '发行人', kind: 'company', identifier: '' }, { id: 'p', name: '示例人员', role: '董事', kind: 'person', identifier: '' }];
  const job = runPreview(state, p, 'integrity');
  const files = p.files.filter(f => f.jobId === job.id);
  assert.equal(files.length, 2);
  assert.ok(files.every(f => f.folder === '4.3' && f.origin === 'integrity' && !f.sourceId));
  p.draft.subjects[0].name = '修改后的企业';
  assert.equal(files.find(f => f.type === 'company-integrity')!.subjects![0].name, '示例企业');
  assert.equal(files.find(f => f.type === 'people-integrity')!.subjects![0].kind, 'person');
});
test('company-only checks do not invent personnel results', () => {
  const state = seedState(), p = state.projects[0];
  p.draft.subjects = [{ id: 'c', name: '示例企业', role: '发行人', kind: 'company', identifier: '' }];
  const job = runPreview(state, p, 'integrity');
  assert.equal(job.fileIds.length, 1);
  assert.equal(p.files.find(f => f.id === job.fileIds[0])!.type, 'company-integrity');
});
test('invalid or duplicate subjects cannot create partial jobs or files', () => {
  const state = seedState(), p = state.projects[0];
  const initialFileCount = p.files.length;
  assert.throws(() => runPreview(state, p, 'integrity'), /至少添加/);
  p.draft.subjects = [{ id: 'c', name: '示例企业', role: '发行人', kind: 'company', identifier: 'short' }];
  assert.throws(() => runPreview(state, p, 'integrity'), /18 位/);
  p.draft.subjects[0].identifier = '';
  p.draft.subjects.push({ ...p.draft.subjects[0], id: 'duplicate' });
  assert.throws(() => runPreview(state, p, 'integrity'), /重复对象/);
  assert.equal(p.files.length, initialFileCount); assert.equal(state.jobs.length, 0);
});
test('new project starts empty and source validation never changes an existing version', () => {
  const state = seedState();
  const p = createProject(state, '测试项目', '测试发行人', '深交所');
  assert.equal(p.files.length, 0); assert.equal(p.draft.subjects.length, 0);
  assert.throws(() => uploadSource(p, { name: 'example.exe', size: 10 }), /DOCX/);
  assert.throws(() => uploadSource(p, { name: 'empty.pdf', size: 0 }), /不能为空/);
  assert.equal(p.files.length, 0);
  assert.equal(uploadSource(p, { name: 'example.pdf', size: 10 }).version, 1);
});
