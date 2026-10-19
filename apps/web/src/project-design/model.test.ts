import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedState, uploadSource, runPreview, createProject, latestFiles } from './model.js';
import { workFor, saveDetails, selectWorkSource, addWorkFiles, runWorkPreview } from './work-model.js';
import { INTEGRITY_SITES, integrityDraft } from './integrity.js';
import { importProjectFile, migrateCatalogRefs, originalSlots } from './project-files.js';

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

test('v3 adds website defaults without rewriting historical jobs or project drafts', () => {
  const state = seedState(), p = state.projects[0], other = structuredClone(state.projects[1]);
  p.draft.subjects = [{ id: 'c', name: '示例企业', role: '发行人', kind: 'company', identifier: '' }];
  const oldJob = { id: 'old', kind: 'integrity' as const, projectId: p.id, fileIds: [], createdAt: '2026-10-18' }; state.jobs.push(oldJob);
  assert.equal(integrityDraft(p).siteIds.length, 19);
  assert.equal(oldJob, state.jobs[0]); assert.equal(state.jobs[0].integrity, undefined);
  assert.deepEqual(state.projects[1], other);
  integrityDraft(p).siteIds = []; assert.equal(integrityDraft(p).siteIds.length, 0);
});

test('integrity freezes website, subject, query and note snapshots separately in jobs and outputs', () => {
  const state = seedState(), p = state.projects[0];
  p.draft.subjects = [{ id: 'c', name: '示例企业', role: '发行人', kind: 'company', identifier: '' }, { id: 'p', name: '示例人员', role: '董事', kind: 'person', identifier: '示例企业' }];
  const draft = integrityDraft(p); draft.siteIds = ['gsxt','judgments']; draft.notes = '首轮说明';
  const first = runPreview(state,p,'integrity'), frozen = structuredClone(first);
  const company = p.files.find(f => f.id === first.fileIds[0])!, person = p.files.find(f => f.id === first.fileIds[1])!;
  assert.equal(first.integrity!.records.length, 4); assert.equal(person.integrity!.records.find(r => r.siteId === 'gsxt')!.status,'not-applicable');
  assert.ok(company.integrity!.records.every(r => r.subjectId === 'c' && r.status === 'pending'));
  draft.siteIds = ['credit-china']; draft.notes = '第二轮说明'; p.draft.subjects[0].name = '已修改名单'; runPreview(state,p,'integrity');
  assert.deepEqual(first,frozen); assert.equal(company.integrity!.notes,'首轮说明');
  first.integrity!.sites[0].name = '修改测试'; assert.equal(company.integrity!.sites[0].name,'国家企业信用信息公示系统');
  assert.equal(INTEGRITY_SITES[0].name,'国家企业信用信息公示系统');
});

test('empty, unknown or wholly inapplicable website scope cannot create files', () => {
  const state = seedState(), p = state.projects[0], count = p.files.length;
  p.draft.subjects = [{ id: 'p', name: '示例人员', role: '董事', kind: 'person', identifier: '' }];
  const draft = integrityDraft(p); draft.siteIds = [];
  assert.throws(() => runPreview(state,p,'integrity'),/至少选择一个核查网站/);
  draft.siteIds = ['gsxt']; assert.throws(() => runPreview(state,p,'integrity'),/支持人员查询/);
  draft.siteIds = ['judgments','unknown']; assert.throws(() => runPreview(state,p,'integrity'),/范围已发生变化/);
  assert.equal(state.jobs.length,0); assert.equal(p.files.length,count);
});

test('original catalog stays separate from files and imported replacements retain versions', () => {
  const state = seedState(), p = state.projects[0], other = structuredClone(state.projects[1]);
  const count = p.files.length; migrateCatalogRefs(state); const snapshot = structuredClone(state); migrateCatalogRefs(state);
  assert.deepEqual(state,snapshot); assert.equal(p.files.length,count);
  assert.equal(originalSlots(p,'','all').length,147); assert.equal(originalSlots(p,'','ready').length,1);
  assert.equal(originalSlots(p,'股东名册','missing').length,2);
  const old = structuredClone(p.files.find(f => f.catalogId === 'wp000'));
  importProjectFile(p,{name:'核查原件.docx',size:100},'4.2','wp000');
  assert.deepEqual(p.files.find(f => f.id === old!.id),old);
  assert.equal(latestFiles(p).find(f => f.catalogId === 'wp000')!.version,2);
  assert.equal(originalSlots(p,'','ready').length,1);
  assert.throws(() => importProjectFile(p,{name:'错误.exe',size:1},'4.2'),/文档/);
  assert.throws(() => importProjectFile(p,{name:'空.docx',size:0},'4.2'),/不能为空/);
  assert.throws(() => importProjectFile(p,{name:'报告.pdf',size:2},'sources','wp001'),/目录项/);
  assert.equal(state.projects[1].files.length,other.files.length);
});
