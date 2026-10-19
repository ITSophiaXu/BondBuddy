import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedState, uploadSource, runPreview, createProject, latestFiles } from './model.js';
import { workFor, saveDetails, selectWorkSource, addWorkFiles, runWorkPreview } from './work-model.js';

test('opening the v2 workbench extends v1 storage without replacing files or existing drafts', () => {
  const state = seedState(), p = state.projects[0];
  p.draft.sourceId = p.files[0].id; p.draft.requirements = '保留原设计输入';
  const before = structuredClone(p); workFor(p);
  assert.deepEqual(p.files, before.files); assert.deepEqual(p.draft, before.draft);
  assert.equal(workFor(p).details.issuer_name, p.issuer);
  assert.equal(workFor(p).details.market, 'szse');
  assert.equal(workFor(state.projects[1]).details.offering, 'mtn');
  assert.equal(JSON.parse(JSON.stringify(state)).schema, 1);
});

test('update, review and generation keep independent source choices within the same project', () => {
  const state = seedState(), p = state.projects[0]; p.draft.sourceId = p.files[0].id;
  selectWorkSource(p, 'review', p.files[1].id);
  addWorkFiles(p, 'update', 'historical', [{ name: '更新依据.docx', size: 300 }]);
  assert.equal(p.draft.sourceId, p.files[0].id);
  assert.equal(workFor(p).review.sourceId, p.files[1].id);
  assert.notEqual(workFor(p).update.sourceId, workFor(p).review.sourceId);
  assert.throws(() => selectWorkSource(p, 'update', state.projects[1].files[0].id), /当前项目/);
});

test('update and review results retain immutable inputs, versions and their project folders', () => {
  const state = seedState(), p = state.projects[0], work = workFor(p);
  selectWorkSource(p, 'update', p.files[1].id); work.update.requirements = '第一轮更新';
  const first = runWorkPreview(state, p, 'update'), frozen = structuredClone(first);
  work.update.requirements = '第二轮更新'; work.details.update_details!.underwriting = '新承销安排';
  const second = runWorkPreview(state, p, 'update');
  assert.deepEqual(first, frozen); assert.equal(first.input!.draft.requirements, '第一轮更新');
  assert.equal(p.files.find(f => f.id === first.fileIds[0])!.version, 3);
  assert.equal(p.files.find(f => f.id === second.fileIds[0])!.version, 4);
  selectWorkSource(p, 'review', second.fileIds[0]);
  const review = runWorkPreview(state, p, 'review'), output = p.files.find(f => f.id === review.fileIds[0])!;
  assert.equal(output.folder, '4.2'); assert.equal(output.sourceVersion, 4);
  assert.equal(state.projects[1].files.length, 4);
});

test('work execution rejects missing or cross-project inputs before creating any result', () => {
  const state = seedState(), p = state.projects[0], work = workFor(p);
  assert.throws(() => runWorkPreview(state, p, 'review'), /募集说明书/);
  work.review.sourceId = state.projects[1].files[0].id;
  assert.throws(() => runWorkPreview(state, p, 'review'), /募集说明书/);
  selectWorkSource(p, 'review', p.files[0].id);
  work.review.attachments = [{ fileId: state.projects[1].files[2].id, role: 'audit' }];
  assert.throws(() => runWorkPreview(state, p, 'review'), /当前项目/);
  assert.equal(state.jobs.length, 0); assert.equal(p.files.length, 4);
});

test('support uploads validate atomically and reuse original files without crossing workflows', () => {
  const p = seedState().projects[0], count = p.files.length;
  assert.throws(() => addWorkFiles(p, 'review', 'audit', [{ name: '报告.pdf', size: 50 }, { name: '空文件.pdf', size: 0 }]), /不能为空/);
  assert.equal(p.files.length, count);
  addWorkFiles(p, 'review', 'audit', [{ name: '报告.pdf', size: 50 }]);
  addWorkFiles(p, 'update', 'audit', [{ name: '报告.pdf', size: 50 }]);
  assert.equal(p.files.length, count + 1);
  assert.equal(workFor(p).review.attachments[0].fileId, workFor(p).update.attachments[0].fileId);
  workFor(p).review.attachments = [];
  assert.equal(workFor(p).update.attachments.length, 1); assert.equal(p.files.length, count + 1);
});

test('shared project details preserve rich update inputs and the other project identity', () => {
  const state = seedState(), p = state.projects[0], other = structuredClone(state.projects[1]);
  const details = structuredClone(workFor(p).details); details.update_details!.underwriting = '示例承销安排';
  saveDetails(p, 'update', details);
  const reviewEdit = structuredClone(workFor(p).details); reviewEdit.update_details!.reporting_cutoff = '2026-06-30';
  saveDetails(p, 'review', reviewEdit);
  assert.equal(workFor(p).details.update_details!.underwriting, '示例承销安排');
  assert.equal(workFor(p).details.update_details!.reporting_cutoff, '2026-06-30');
  assert.deepEqual(state.projects[1], other);
});

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
