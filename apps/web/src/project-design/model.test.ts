import { saveTemplate, templateFor, missingTemplates } from './templates.js';
import { regionalPortal } from './regions.js';
import { qaFor, addQAFile, exampleQuestions, runQAPreview, qaParagraphs } from './qa-model.js';
import { reviewParagraphs, reviewExample } from './review-model.js';
import { wordParts, wordBytes } from './word-export.js';
import { dashboardItems } from './dashboard-state.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedState, uploadSource, runPreview, createProject, latestFiles } from './model.js';
import { workFor, saveDetails, selectWorkSource, addWorkFiles, runWorkPreview } from './work-model.js';
import { INTEGRITY_SITES, integrityDraft } from './integrity.js';
import { importProjectFile, migrateCatalogRefs, originalSlots } from './project-files.js';
import { startConsistency, finishConsistency, acceptConsistency, currentProspectus, resultProspectus, pendingIssues, associatedFiles, consistencyParagraphs, fileConsistencyState, CHECK_DURATION } from './consistency-model.js';

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
  saveTemplate(p, 'application', {name:'申请书模板.docx',size:100});
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
  assert.equal(integrityDraft(p).siteIds.length, 20);
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

test('generation requires a separate template for each selected document and freezes its version', () => {
  const state=seedState(),p=state.projects[0];p.draft.sourceId=p.files[0].id;p.draft.selected=['application','legal'];
  const before=p.files.length;
  assert.throws(()=>runPreview(state,p,'generation'),/历史文件/);
  const firstTemplate=saveTemplate(p,'application',{name:'历史申请书.docx',size:100});
  assert.equal(missingTemplates(p).length,1);assert.throws(()=>runPreview(state,p,'generation'),/法律意见书/);
  saveTemplate(p,'legal',{name:'历史法律意见书.docx',size:200});
  const job=runPreview(state,p,'generation'), frozen=structuredClone(p.files.find(f=>f.jobId===job.id&&f.type==='application')!);
  saveTemplate(p,'application',{name:'新模板.docx',size:300});
  assert.equal(templateFor(p,'application')!.version,2);assert.equal(frozen.template!.id,firstTemplate.id);
  assert.deepEqual(p.files.find(f=>f.id===frozen.id),frozen);
  assert.equal(state.projects[1].templates,undefined);assert.equal(p.files.length,before+2);
  assert.throws(()=>saveTemplate(p,'application',{name:'错误.pdf',size:1}),/Word/);
  const restored=JSON.parse(JSON.stringify(state));assert.equal(templateFor(restored.projects[0],'application')!.name,'新模板.docx');
});

test('regional portals handle provinces, independent cities, aliases and unknown registration', () => {
  assert.match(regionalPortal({province:'江苏省',city:'南京市'})!.csrc,/jiangsu/);
  assert.match(regionalPortal({province:'广东',city:'深圳市'})!.tax,/shenzhen/);
  assert.match(regionalPortal({province:'广东',city:'广州市'})!.tax,/guangdong/);
  assert.match(regionalPortal({province:'浙江',city:'宁波'})!.csrc,/ningbo/);
  assert.match(regionalPortal({province:'辽宁',city:'大连市'})!.csrc,/dalian/);
  assert.match(regionalPortal({province:'福建',city:'厦门'})!.tax,/xiamen/);
  assert.match(regionalPortal({province:'山东',city:'青岛市'})!.csrc,/qingdao/);
  assert.match(regionalPortal({province:'广西壮族自治区',city:'南宁'})!.csrc,/guangxi/);
  assert.equal(regionalPortal({province:'其他',city:''}),undefined);
  assert.equal(regionalPortal(undefined),undefined);
  assert.equal(regionalPortal({province:'广东',city:''}),undefined);
  assert.equal(regionalPortal({province:'江苏',city:'深圳市'}),undefined);
});

test('integrity snapshots keep each company jurisdiction and do not invent a regional URL', () => {
  const state=seedState(),p=state.projects[0];p.draft.subjects=[
    {id:'a',kind:'company',name:'深圳示例企业',role:'发行人',identifier:'',registration:{province:'广东',city:'深圳'}},
    {id:'b',kind:'company',name:'南京示例企业',role:'子公司',identifier:'',registration:{province:'江苏',city:'南京'}},
    {id:'c',kind:'company',name:'未知注册地企业',role:'子公司',identifier:''},
    {id:'d',kind:'person',name:'示例人员',role:'董事',identifier:''},
  ];integrityDraft(p).siteIds=['local-csrc','local-tax','credit-china'];
  const job=runPreview(state,p,'integrity');const records=job.integrity!.records;
  assert.match(records.find(r=>r.subjectId==='a'&&r.siteId==='local-csrc')!.site!.links[0].url,/shenzhen/);
  assert.match(records.find(r=>r.subjectId==='b'&&r.siteId==='local-tax')!.site!.links[0].url,/jiangsu/);
  assert.equal(records.find(r=>r.subjectId==='c'&&r.siteId==='local-tax')!.site!.links.length,0);
  assert.equal(records.find(r=>r.subjectId==='d'&&r.siteId==='local-tax')!.status,'not-applicable');
  p.draft.subjects[0].registration!.city='广州';assert.equal(records.find(r=>r.subjectId==='a'&&r.siteId==='local-csrc')!.registration!.city,'深圳');
});

test('QA retains missing material instructions inside document and isolates historical rounds', () => {
  const state=seedState(),p=state.projects[0],d=qaFor(p);
  assert.throws(()=>runQAPreview(state,p),/Word/);
  addQAFile(p,{name:'问题清单.docx',size:200});d.questions=exampleQuestions();
  const first=runQAPreview(state,p),frozen=structuredClone(first);
  const text=qaParagraphs(first.qa!).map(p=>p.text).join('\n');assert.match(text,/往来占款明细/);assert.match(text,/暂无法定稿/);
  addQAFile(p,{name:'新增依据.pdf',size:100},true);d.questions[1].answer='用户补充的回答';
  runQAPreview(state,p);assert.deepEqual(first,frozen);
  assert.equal(p.files.find(f=>f.id===first.fileIds[0])!.folder,'4.2');
  assert.equal(state.projects[1].qa,undefined);
  d.fileId=state.projects[1].files[0].id;assert.throws(()=>runQAPreview(state,p),/本项目/);
});

test('review archives tracked and clean examples and retains uncertainty in clean text', () => {
  const state=seedState(),p=state.projects[0];selectWorkSource(p,'review',p.files[0].id);
  const j=runWorkPreview(state,p,'review'), files=p.files.filter(f=>j.fileIds.includes(f.id));
  assert.equal(files.length,3);assert.equal(files.filter(f=>f.folder==='2').length,2);
  assert.match(j.review!.issues.find(i=>i.id==='policy')!.reason,/不能套用于本项目/);
  const parts=reviewParagraphs(j.review!,{consistency:{mode:'original'},chinese:{mode:'manual',text:'手动修改。'}});
  assert.equal(parts.find(p=>p.before===j.review!.issues[0].original)!.text,j.review!.issues[0].original);
  assert.ok(parts.some(p=>p.text==='手动修改。'));assert.ok(parts.some(p=>p.text.includes('待人工确认')));
  j.review!.issues[0].original='changed';assert.notEqual(files.find(f=>f.type==='review-tracked')!.review!.issues[0].original,'changed');
});

test('Word examples encode genuine revisions, linked comments, clean output and escaped text', () => {
  const paragraphs=reviewParagraphs(reviewExample('上交所'));
  paragraphs.push({text:'<示例 & 引用>',before:'原文',comment:'解释 & 依据'});
  const tracked=wordParts('修订示例',paragraphs,true),clean=wordParts('清洁示例',paragraphs,false);
  assert.match(tracked['word/document.xml'],/<w:del /);assert.match(tracked['word/document.xml'],/<w:ins /);
  assert.match(tracked['word/document.xml'],/w:commentRangeStart/);assert.match(tracked['word/comments.xml']!,/第十一条/);
  assert.match(tracked['word/document.xml'],/&lt;示例 &amp; 引用&gt;/);
  assert.doesNotMatch(clean['word/document.xml'],/<w:(ins|del|comment)/);assert.equal('word/comments.xml' in clean,false);
  assert.match(clean['word/document.xml'],/待人工确认/);
  const bytes=wordBytes('修订示例',paragraphs,true),view=new DataView(bytes.buffer);assert.equal(view.getUint32(0,true),0x04034b50);assert.equal(view.getUint32(bytes.length-22,true),0x06054b50);
});

test('global dashboard aggregates projects, exposes QA missing materials and suppresses completed generation drafts', () => {
  const state=seedState(),[a,b]=state.projects;
  a.draft.sourceId=a.files[0].id;a.draft.selected=['application'];saveTemplate(a,'application',{name:'模板.docx',size:1});runPreview(state,a,'generation');
  addQAFile(b,{name:'问题.docx',size:1});qaFor(b).questions=exampleQuestions();runQAPreview(state,b);
  const items=dashboardItems(state);assert.equal(items.filter(i=>i.kind==='generation').length,1);
  assert.equal(items.filter(i=>i.project===b.name)[0].label,'待补材料 · 演示');
  assert.ok(items.some(i=>i.project===a.name));assert.ok(items.some(i=>i.project===b.name));
  assert.ok(dashboardItems(state,a).every(i=>i.project===a.name));
});

test('consistency freezes exact project inputs and exposes checking, pending and historical dashboard states', () => {
  const state=seedState(),p=state.projects[0],other=structuredClone(state.projects[1]);
  const job=startConsistency(state,p), frozen=structuredClone(job.consistency!.snapshot);
  assert.equal(job.consistency!.snapshot.source.id,p.files[1].id);
  assert.equal(job.consistency!.snapshot.files.length,2);
  assert.equal(dashboardItems(state,p).find(i=>i.id===job.id)!.group,'active');
  assert.throws(()=>acceptConsistency(state,p,job.id,[]),/等待/);
  finishConsistency(state,Date.parse(job.createdAt)+CHECK_DURATION-1);assert.equal(job.consistency!.phase,'checking');
  finishConsistency(state,Date.parse(job.createdAt)+CHECK_DURATION);assert.equal(job.consistency!.phase,'complete');
  assert.equal(dashboardItems(state,p).find(i=>i.id===job.id)!.group,'attention');
  p.files[1].name='重命名输入';assert.deepEqual(job.consistency!.snapshot,frozen);
  startConsistency(state,p);assert.equal(dashboardItems(state,p).find(i=>i.id===job.id)!.label,'已归档 · 演示');
  assert.deepEqual(state.projects[1],other);
});

test('consistency rejects missing prerequisites, foreign inputs and foreign acceptance without mutations', () => {
  const state=seedState(),p=state.projects[0],empty=state.projects[2];
  assert.throws(()=>startConsistency(state,empty),/添加募集说明书/);
  uploadSource(empty,{name:'只有募集书.docx',size:1});assert.throws(()=>startConsistency(state,empty),/没有可检查/);
  assert.throws(()=>startConsistency(state,p,state.projects[1].files[0].id),/当前项目/);
  assert.equal(state.jobs.length,0);
  const job=startConsistency(state,p);finishConsistency(state,Date.parse(job.createdAt)+CHECK_DURATION);
  const before=structuredClone(state);
  assert.throws(()=>acceptConsistency(state,state.projects[1],job.id,[]),/当前项目/);
  assert.throws(()=>acceptConsistency(state,p,job.id,[{fileId:'foreign',issueIds:['income']}]),/不属于/);
  assert.deepEqual(state,before);
});

test('accepting selected conflicts appends versions, preserves snapshots and supports idempotent partial updates', () => {
  const state=seedState(),p=state.projects[0],job=startConsistency(state,p);
  finishConsistency(state,Date.parse(job.createdAt)+CHECK_DURATION);
  const snapshot=structuredClone(job.consistency!.snapshot), item=job.consistency!.snapshot.files.find(f=>f.status==='conflict')!, old=structuredClone(p.files.find(f=>f.id===item.file.id)!);
  const first=acceptConsistency(state,p,job.id,[{fileId:old.id,issueIds:['income']}])[0];
  assert.equal(first.version,2);assert.equal(first.folder,old.folder);assert.equal(pendingIssues(job,item).length,1);
  assert.equal(latestFiles(p).filter(f=>f.type==='original').length,1);
  assert.equal(acceptConsistency(state,p,job.id,[{fileId:old.id,issueIds:['income']}]).length,0);
  const second=acceptConsistency(state,p,job.id,[{fileId:old.id,issueIds:['debt']}])[0];
  assert.equal(second.version,3);assert.equal(second.consistency!.issues.length,2);assert.equal(pendingIssues(job,item).length,0);
  assert.deepEqual(p.files.find(f=>f.id===old.id),old);assert.deepEqual(job.consistency!.snapshot,snapshot);
  assert.equal(job.fileIds.length,2);assert.equal(latestFiles(p).find(f=>f.type==='original')!.id,second.id);
  const next=startConsistency(state,p);assert.equal(next.consistency!.snapshot.files.find(f=>f.file.id===second.id)!.status,'consistent');
  assert.match(wordParts('更新示例',consistencyParagraphs(second),true)['word/document.xml'],/<w:ins /);
  const restored=JSON.parse(JSON.stringify(state));assert.equal(restored.jobs[1].consistencyUpdates[old.id].fileId,second.id);
});

test('batch acceptance validates all files first and refuses a concurrently regenerated target', () => {
  const state=seedState(),p=state.projects[0];p.draft.sourceId=p.files[1].id;p.draft.selected=['initiation','application'];
  for(const type of p.draft.selected)saveTemplate(p,type,{name:type+'.docx',size:1});
  runPreview(state,p,'generation');const job=startConsistency(state,p);finishConsistency(state,Date.parse(job.createdAt)+CHECK_DURATION);
  const requests=job.consistency!.snapshot.files.filter(f=>f.status==='conflict').map(f=>({fileId:f.file.id,issueIds:f.issues.map(i=>i.id)}));
  p.draft.selected=['application'];runPreview(state,p,'generation');const before=structuredClone(p.files);
  assert.throws(()=>acceptConsistency(state,p,job.id,requests),/关联文件已有/);
  assert.deepEqual(p.files,before);assert.equal(job.fileIds.length,0);
  const next=startConsistency(state,p);finishConsistency(state,Date.parse(next.createdAt)+CHECK_DURATION);
  const nextRequests=next.consistency!.snapshot.files.filter(f=>f.status==='conflict').map(f=>({fileId:f.file.id,issueIds:f.issues.map(i=>i.id)}));
  const files=acceptConsistency(state,p,next.id,nextRequests);assert.equal(files.length,3);
  assert.equal(files.find(f=>f.type==='application')!.version,3);
  assert.equal(acceptConsistency(state,p,next.id,nextRequests).length,0);
});

test('review result checks use the reviewed text and block acceptance after a new manual edit or source version', () => {
  const state=seedState(),p=state.projects[0];selectWorkSource(p,'review',p.files[1].id);
  const review=runWorkPreview(state,p,'review');review.reviewDecisions={consistency:{mode:'manual',text:'营业收入为 13.0 亿元（手动示例）。'}};
  const source=resultProspectus(p,review)!;assert.equal(source.type,'review-clean');assert.equal(currentProspectus(p)!.id,source.id);
  assert.ok(associatedFiles(p).every(f=>!f.type.startsWith('review-')&&f.type!=='prospectus-review'));
  const job=startConsistency(state,p,source.id,review.id);finishConsistency(state,Date.parse(job.createdAt)+CHECK_DURATION);
  const file=job.consistency!.snapshot.files.find(f=>f.status==='conflict')!;
  assert.match(file.issues[0].sourceText,/13.0/);
  review.reviewDecisions.consistency.text='营业收入为 14.0 亿元（再次修改）。';
  assert.throws(()=>acceptConsistency(state,p,job.id,[{fileId:file.file.id,issueIds:['income']}]),/复核修改已变化/);
  const next=startConsistency(state,p);finishConsistency(state,Date.parse(next.createdAt)+CHECK_DURATION);
  uploadSource(p,{name:'更新的募集书.docx',size:1});
  assert.throws(()=>acceptConsistency(state,p,next.id,[{fileId:file.file.id,issueIds:['income']}]),/募集说明书/);
  assert.match(file.issues[0].sourceText,/13.0/);assert.equal(job.fileIds.length,0);
});

test('project file markers follow the current scan and turn from conflict to synced without losing the deep link', () => {
  const state=seedState(),p=state.projects[0],file=p.files[3];
  assert.equal(fileConsistencyState(state,p,file)!.kind,'unchecked');
  const job=startConsistency(state,p);assert.equal(fileConsistencyState(state,p,file)!.kind,'checking');
  finishConsistency(state,Date.parse(job.createdAt)+CHECK_DURATION);
  assert.deepEqual(fileConsistencyState(state,p,file),{kind:'conflict',count:2,jobId:job.id,fileId:file.id});
  const part=acceptConsistency(state,p,job.id,[{fileId:file.id,issueIds:['income']}])[0];
  assert.equal(fileConsistencyState(state,p,part)!.count,1);
  const done=acceptConsistency(state,p,job.id,[{fileId:file.id,issueIds:['debt']}])[0];
  assert.equal(fileConsistencyState(state,p,done)!.kind,'updated');
  const next=startConsistency(state,p);finishConsistency(state,Date.parse(next.createdAt)+CHECK_DURATION);
  assert.equal(fileConsistencyState(state,p,done)!.kind,'updated');
  assert.equal(fileConsistencyState(state,p,p.files[2])!.kind,'manual');
  uploadSource(p,{name:'较新募集书.docx',size:1});assert.equal(fileConsistencyState(state,p,done)!.kind,'stale');
  assert.equal(fileConsistencyState(state,state.projects[1],state.projects[1].files[3])!.kind,'unchecked');
});
