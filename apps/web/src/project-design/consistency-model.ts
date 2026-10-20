import { latestFiles, fileFamily, newId, type DesignState, type Job, type Project, type ProjectFile } from './model.js';
import { reviewText } from './review-model.js';
import type { WordParagraph } from './word-export.js';

export type ConsistencyIssue = { id: string; title: string; location: string; sourceLocation: string; sourceText: string; original: string; suggested: string; reason: string };
export type ConsistencyFile = { file: ProjectFile; status: 'conflict' | 'consistent' | 'manual'; reason: string; issues: ConsistencyIssue[] };
export type ConsistencySnapshot = { source: ProjectFile; sourceFingerprint: string; issuer: string; fromJob?: string; files: ConsistencyFile[] };
export type ConsistencyRun = { phase: 'checking' | 'complete'; completedAt?: string; snapshot: ConsistencySnapshot };
export type ConsistencyUpdate = { fileId: string; issueIds: string[]; acceptedAt: string };
export type ConsistencyArtifact = { checkId: string; sourceFingerprint: string; sourceName: string; sourceVersion: number; originalId: string; previousId: string; issues: ConsistencyIssue[] };
export const CHECK_DURATION = 6500;
const isProspectus = (f: ProjectFile) => ['prospectus', 'review-clean'].includes(f.type);
export function currentProspectus(p: Project) {
  return p.files.map((file,index) => ({file,index})).filter(x => !x.file.deletedAt && isProspectus(x.file)).sort((a,b) => b.file.createdAt.localeCompare(a.file.createdAt) || b.index-a.index)[0]?.file;
}
export function resultProspectus(p: Project, job: Job) {
  return p.files.find(f => job.fileIds.includes(f.id) && f.type === (job.kind === 'review' && job.review ? 'review-clean' : 'prospectus')) ?? p.files.find(f => f.id === job.input?.draft.sourceId && isProspectus(f));
}
export const associatedFiles = (p: Project) => latestFiles(p).filter(f => !['prospectus', 'review-clean', 'review-tracked', 'prospectus-review', 'consistency-report'].includes(f.type));
function fingerprint(state: DesignState, p: Project, source: ProjectFile) {
  const review = state.jobs.find(j => j.id === source.jobId && j.projectId === p.id);
  return JSON.stringify([source.id, source.version, source.review ? review?.reviewDecisions ?? {} : null]);
}
function syntheticIssues(state: DesignState, p: Project, source: ProjectFile, file: ProjectFile): ConsistencyIssue[] {
  const review = state.jobs.find(j => j.id === source.jobId && j.projectId === p.id);
  const issue = source.review?.issues.find(i => i.id === 'consistency');
  const income = issue ? reviewText(issue, review?.reviewDecisions) : '2025 年度，发行人实现营业收入 12.6 亿元。';
  const reconciliation = source.review?.issues.find(i => i.id === 'reconciliation');
  const debt = reconciliation ? reviewText(reconciliation, review?.reviewDecisions) : '短期借款 3.2 亿元，长期借款 5.6 亿元，合计 8.8 亿元。';
  const make = (id: string, title: string, original: string, text: string, location: string, sourceLocation: string, reason: string): ConsistencyIssue => ({ id, title, original, suggested: text, sourceText: text, location, sourceLocation, reason });
  const proceeds = source.review?.issues.find(i => i.id === 'chinese');
  if (['application', 'proceeds', 'recommendation'].includes(file.type)) return [make('proceeds', '募集资金用途表述不同', '募集资金全部用于补充流动资金。', proceeds ? reviewText(proceeds,review?.reviewDecisions) : '募集资金用于偿还借款，补充流动资金。', '发行安排 / 合成段落 1', '募集资金运用 / 合成段落', '关联文件遗漏偿还借款的用途，建议沿用本轮募集书的表述。')];
  return [
    make('income', '同一期间营业收入不一致', '2025 年度，发行人实现营业收入 11.8 亿元。', income, '主要财务情况 / 合成段落 1', issue?.location ?? '第三节 · 发行人概况 / 合成段落', '比较同一期间、同一主体及同一单位，按募集书统一关联文件的营业收入。'),
    make('debt', '有息负债披露金额不一致', '短期借款 3.2 亿元，长期借款 5.6 亿元，合计 8.3 亿元。', debt, '偿债能力 / 合成段落 2', reconciliation?.location ?? '第六节 · 财务信息 / 合成段落', '关联文件合计数与募集书披露不同，建议同步本轮募集书的完整表述。'),
  ];
}
function checkFile(state: DesignState, p: Project, source: ProjectFile, sourceFingerprint: string, file: ProjectFile): ConsistencyFile {
  const base = { file: structuredClone(file), issues: [] as ConsistencyIssue[] };
  if (file.folder === 'sources' || file.type === 'qa-input') return { ...base, status: 'manual', reason: '原始依据仅用于交叉核对，不按募集书改写；需人工确认不同期间、口径或补充可解析文件。' };
  if (file.integrity || file.subjects || file.qa || file.type === 'legal' || (file.origin === 'upload' && !/\.docx$/i.test(file.name))) return { ...base, status: 'manual', reason: '涉及核查证据、问答结论或无法直接改写的原件，需补充依据后确认。不会自动改变专业结论。' };
  const issues = syntheticIssues(state, p, source, file).map(i => ({ ...i, original: file.consistency?.issues.find(old => old.id === i.id)?.suggested ?? i.original })).filter(i => i.original !== i.suggested);
  const accepted = file.consistency?.sourceFingerprint === sourceFingerprint ? file.consistency.issues : [];
  const remaining = issues.filter(i => !accepted.some(a => a.id === i.id));
  if (!remaining.length || ['issuer', 'annual', 'semiannual', 'credit'].includes(file.type)) return { ...base, status: 'consistent', reason: accepted.length ? '本地示例中，已接受的修改与本轮募集书一致。' : '本地示例：对应字段、期间与口径未发现差异。' };
  return { ...base, issues: remaining, status: 'conflict', reason: '发现需随募集书同步的表述，接受后生成新版本。' };
}
export function startConsistency(state: DesignState, p: Project, sourceId?: string, fromJob?: string): Job {
  if (!state.projects.includes(p)) throw new Error('项目不存在。');
  const source = sourceId ? p.files.find(f => !f.deletedAt && f.id === sourceId && isProspectus(f)) : currentProspectus(p);
  if (!source) throw new Error('请先为当前项目添加募集说明书。');
  const files = associatedFiles(p);
  if (!files.length) throw new Error('当前项目还没有可检查的关联文件，请先生成或导入项目文件。');
  const key = fingerprint(state, p, source);
  const run: Job = { id: newId(), kind: 'consistency', projectId: p.id, createdAt: new Date().toISOString(), fileIds: [], consistency: { phase: 'checking', snapshot: { source: structuredClone(source), sourceFingerprint: key, issuer: p.issuer, fromJob, files: files.map(f => checkFile(state, p, source, key, f)) } } };
  state.jobs.unshift(run); p.updatedAt = run.createdAt;
  return run;
}
export function finishConsistency(state: DesignState, time = Date.now()) {
  for (const job of state.jobs) if (job.consistency?.phase === 'checking' && time - Date.parse(job.createdAt) >= CHECK_DURATION) {
    job.consistency.phase = 'complete'; job.consistency.completedAt = new Date(time).toISOString();
  }
}
export function pendingIssues(job: Job, file: ConsistencyFile) {
  const accepted = job.consistencyUpdates?.[file.file.id]?.issueIds ?? [];
  return file.issues.filter(i => !accepted.includes(i.id));
}
export function consistencyStale(state: DesignState, p: Project, job: Job) {
  const s = job.consistency!.snapshot, source = currentProspectus(p);
  return !source || source.id !== s.source.id || fingerprint(state, p, source) !== s.sourceFingerprint;
}
export function targetStale(p: Project, job: Job, item: ConsistencyFile) {
  return latestFiles(p).find(f => fileFamily(f) === fileFamily(item.file))?.id !== (job.consistencyUpdates?.[item.file.id]?.fileId ?? item.file.id);
}
export function acceptConsistency(state: DesignState, p: Project, jobId: string, requests: { fileId: string; issueIds: string[] }[]) {
  const job = state.jobs.find(j => j.id === jobId && j.projectId === p.id);
  if (!state.projects.includes(p) || !job?.consistency || job.consistency.phase !== 'complete') throw new Error('请等待当前项目的检查完成。');
  if (consistencyStale(state, p, job)) throw new Error('募集说明书或复核修改已变化，请重新检查后再接受更新。');
  // Validate the complete batch before writing any versions. Repeated acceptance is idempotent.
  const plans = [...new Map(requests.map(r => [r.fileId, r])).values()].map(request => {
    const item = job.consistency!.snapshot.files.find(f => f.file.id === request.fileId);
    if (!item || request.issueIds.some(id => !item.issues.some(i => i.id === id))) throw new Error('更新项不属于本次检查。');
    const issues = pendingIssues(job, item).filter(i => request.issueIds.includes(i.id));
    if (issues.length && targetStale(p, job, item)) throw new Error('关联文件已有更新版本，请重新检查后再接受更新。');
    return { item, issues };
  }).filter(plan => plan.issues.length);
  const files: ProjectFile[] = [], at = new Date().toISOString();
  for (const { item, issues } of plans) {
    const previous = p.files.find(f => f.id === (job.consistencyUpdates?.[item.file.id]?.fileId ?? item.file.id))!;
    const allIssues = [...new Map([...(previous.consistency?.issues ?? []), ...issues].map(i => [i.id,i])).values()];
    const source = job.consistency.snapshot.source;
    const f: ProjectFile = { ...structuredClone(previous), id: newId(), familyId: fileFamily(previous), version: Math.max(...p.files.filter(f => fileFamily(f) === fileFamily(previous)).map(f => f.version)) + 1, createdAt: at, modifiedAt: at, origin: 'consistency', jobId: job.id, sourceId: source.id, sourceName: source.name, sourceVersion: source.version, consistency: { checkId: job.id, sourceFingerprint: job.consistency.snapshot.sourceFingerprint, sourceName: source.name, sourceVersion: source.version, originalId: item.file.id, previousId: previous.id, issues: allIssues } };
    p.files.push(f); job.fileIds.push(f.id); files.push(f);
    (job.consistencyUpdates ??= {})[item.file.id] = { fileId: f.id, issueIds: [...new Set([...(job.consistencyUpdates?.[item.file.id]?.issueIds ?? []), ...issues.map(i => i.id)])], acceptedAt: at };
  }
  if (files.length) p.updatedAt = at;
  return files;
}
export function consistencyParagraphs(file: ProjectFile): WordParagraph[] {
  return [{ text: `依据募集书：${file.consistency!.sourceName} · v${file.consistency!.sourceVersion}` }, ...file.consistency!.issues.flatMap(i => [{ text: i.location, heading: true }, { text: i.suggested, before: i.original, comment: `${i.reason}\n依据：${i.sourceLocation}\n${i.sourceText}` }])];
}
export type FileConsistencyState = { kind: 'conflict' | 'updated' | 'consistent' | 'manual' | 'checking' | 'stale' | 'unchecked'; count: number; jobId?: string; fileId?: string };
export function fileConsistencyState(state: DesignState, p: Project, file: ProjectFile): FileConsistencyState | undefined {
  if (['prospectus','review-clean','review-tracked','prospectus-review'].includes(file.type)) return undefined;
  const job = state.jobs.find(j => j.projectId === p.id && j.consistency);
  const item = job?.consistency?.snapshot.files.find(f => fileFamily(f.file) === fileFamily(file));
  if (!job || !item) return {kind:'unchecked',count:0};
  const link = {jobId:job.id,fileId:item.file.id}, count = pendingIssues(job,item).length;
  if (consistencyStale(state,p,job) || targetStale(p,job,item)) return {...link,kind:'stale',count:0};
  if (job.consistency!.phase === 'checking') return {...link,kind:'checking',count:0};
  return {...link,count,kind:count ? 'conflict' : item.status === 'manual' ? 'manual' : item.status === 'conflict' || file.consistency?.sourceFingerprint === job.consistency!.snapshot.sourceFingerprint ? 'updated' : 'consistent'};
}
