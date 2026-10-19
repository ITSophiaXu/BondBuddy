import type { KnowledgeCase } from './qa-model.js';
import type { ConsistencyRun, ConsistencyUpdate, ConsistencyArtifact } from './consistency-model.js';
import { missingTemplates, templateFor, type DocumentTemplate } from './templates.js';
import type { QADraft, QASnapshot } from './qa-model.js';
import type { ReviewSnapshot, ReviewDecisions } from './review-model.js';
import { DOCUMENTS, type FolderId } from './catalog.js';
import { integrityDraft, integritySnapshot, type IntegrityDraft, type IntegritySnapshot } from './integrity.js';
import type { Static } from '@sinclair/typebox';
import type { schemas, SourceProspectus } from '@bondbuddy/contracts';

export type ProjectDetails = Static<typeof schemas.ProjectCreateRequest>;
export type WorkKind = 'update' | 'review';
export type WorkDraft = { sourceId: string; attachments: { fileId: string; role: string }[]; requirements: string; sources: SourceProspectus[]; touchedAt?: string };
export type ProjectWork = { details: ProjectDetails; update: WorkDraft; review: WorkDraft };

export type Subject = { id: string; kind: 'company' | 'person'; name: string; role: string; identifier: string; registration?: { province: string; city: string } };
export type ProjectFile = { id: string; familyId?: string; consistency?: ConsistencyArtifact; type: string; name: string; folder: FolderId; version: number; createdAt: string; origin: 'sample' | 'upload' | 'generation' | 'integrity' | 'qa' | 'consistency' | WorkKind; template?: DocumentTemplate; qa?: QASnapshot; review?: ReviewSnapshot; sourceId?: string; sourceName?: string; sourceVersion?: number; jobId?: string; requirements?: string; subjects?: Subject[]; size?: number; integrity?: IntegritySnapshot; catalogId?: string };
export type FlowDraft = { sourceId: string; selected: string[]; requirements: string; attachments: string[]; subjects: Subject[]; templateIds?: Record<string, string>; integrity?: IntegrityDraft };
export type Project = { id: string; name: string; issuer: string; market: string; updatedAt: string; files: ProjectFile[]; draft: FlowDraft; work?: ProjectWork; templates?: DocumentTemplate[]; qa?: QADraft };
export type Job = { id: string; projectId: string; kind: 'generation' | 'integrity' | 'qa' | 'consistency' | WorkKind; consistency?: ConsistencyRun; consistencyUpdates?: Record<string, ConsistencyUpdate>; qa?: QASnapshot; review?: ReviewSnapshot; reviewDecisions?: ReviewDecisions; fileIds: string[]; createdAt: string; subjectCount?: number; integrity?: IntegritySnapshot; input?: { draft: WorkDraft; details: ProjectDetails } };
export type DesignState = { schema: 1; projects: Project[]; jobs: Job[]; knowledge?: KnowledgeCase[] };
export const STORAGE_KEY = 'bondbuddy:project-materials-design:v1';
export const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();
export const blankDraft = (): FlowDraft => ({ sourceId: '', selected: [], requirements: '', attachments: [], subjects: [] });
export function seedState(): DesignState {
  const sample = (id: string, name: string, issuer: string, market: string, populated: boolean): Project => ({
    id, name, issuer, market, updatedAt: '2026-10-19T02:00:00Z', draft: blankDraft(), files: populated ? [
      { id: id + '-source-v1', type: 'prospectus', name: `${issuer}_募集说明书_初稿.docx`, folder: '2', version: 1, createdAt: '2026-10-15T02:00:00Z', origin: 'sample' },
      { id: id + '-source-v2', type: 'prospectus', name: `${issuer}_募集说明书_修订稿.docx`, folder: '2', version: 2, createdAt: '2026-10-18T02:00:00Z', origin: 'sample' },
      { id: id + '-audit', type: 'source', name: '2025 年度审计报告（示例）.pdf', folder: 'sources', version: 1, createdAt: '2026-10-15T02:00:00Z', origin: 'sample' },
      { id: id + '-record', type: 'original', name: '1-0 发行人基本情况的核查记录（示例）.docx', folder: '4.2', version: 1, createdAt: '2026-10-15T02:00:00Z', origin: 'sample' },
    ] : [],
  });
  return { schema: 1, jobs: [], projects: [
    sample('design-chengchuan', '澄川城投 2026 年公司债', '澄川城市建设集团有限公司', '深交所 · 普通私募公司债', true),
    sample('design-yunhe', '云河交通 2026 年中期票据', '云河交通发展有限公司', '交易商协会 · MTN', true),
    sample('design-xinyuan', '新远实业 2026 年公司债', '新远实业有限公司', '上交所 · 普通私募公司债', false),
  ] };
}
export function createProject(state: DesignState, name: string, issuer: string, market: string) {
  if (!name.trim() || !issuer.trim()) throw new Error('请填写项目名称和发行人。');
  const project: Project = { id: newId(), name: name.trim(), issuer: issuer.trim(), market, updatedAt: now(), files: [], draft: blankDraft() };
  state.projects.unshift(project);
  return project;
}
export function uploadSource(project: Project, file: Pick<File, 'name' | 'size'>) {
  if (!/\.(docx|pdf)$/i.test(file.name)) throw new Error('请选择 DOCX 或 PDF 格式的募集说明书。');
  if (file.size <= 0 || file.size > 100 * 1024 * 1024) throw new Error('文件不能为空，且单份不超过 100 MB。');
  const source: ProjectFile = { id: newId(), type: 'prospectus', name: file.name, folder: '2', version: Math.max(0, ...project.files.filter(f => f.type === 'prospectus').map(f => f.version)) + 1, createdAt: now(), origin: 'upload', size: file.size };
  project.files.push(source); project.draft.sourceId = source.id; project.updatedAt = now();
  return source;
}
export function subjectError(subjects: Subject[]) {
  if (!subjects.length) return '请至少添加一个核查对象。';
  const seen = new Set<string>();
  for (const subject of subjects) {
    if (!subject.name.trim()) return '请填写每个核查对象的名称或姓名。';
    if (!subject.role.trim()) return '请填写核查对象与项目的关系或职务。';
    if (subject.kind === 'company' && subject.identifier && !/^[0-9A-Z]{18}$/.test(subject.identifier)) return '企业信用代码需为 18 位大写字母或数字，也可以暂时留空。';
    const key = `${subject.kind}:${subject.name.trim().toLocaleLowerCase()}:${subject.identifier.trim()}`;
    if (seen.has(key)) return '名单中有重复对象，请合并后再开始。';
    seen.add(key);
  }
  return '';
}
export function runPreview(state: DesignState, project: Project, kind: 'generation' | 'integrity'): Job {
  const draft = project.draft;
  const source = project.files.find(f => f.id === draft.sourceId && f.type === 'prospectus');
  const types = kind === 'generation' ? DOCUMENTS.filter(d => d.kind === 'generation' && draft.selected.includes(d.id)) : DOCUMENTS.filter(d => d.kind === 'integrity' && draft.subjects.some(s => s.kind === (d.id === 'company-integrity' ? 'company' : 'person')));
  if (kind === 'generation' && !source) throw new Error('请选择当前项目的募集说明书版本。');
  if (kind === 'generation' && !types.length) throw new Error('请至少选择一份需要生成的文件。');
  if (kind === 'generation' && missingTemplates(project).length) throw new Error('请先为以下文件添加历史文件 / 模板：' + missingTemplates(project).map(d => d.name).join('、'));
  if (kind === 'integrity') { const error = subjectError(draft.subjects); if (error) throw new Error(error); }
  const snapshot = kind === 'integrity' ? integritySnapshot(draft.subjects, integrityDraft(project)) : undefined;
  const job: Job = { id: newId(), projectId: project.id, kind, fileIds: [], createdAt: now(), ...(snapshot ? { subjectCount: draft.subjects.length, integrity: snapshot } : {}) };
  for (const type of types) {
    const subjects = snapshot?.subjects.filter(s => s.kind === (type.id === 'company-integrity' ? 'company' : 'person'));
    const file: ProjectFile = {
      id: newId(), type: type.id, name: type.name, folder: type.folder, version: Math.max(0, ...project.files.filter(f => f.type === type.id).map(f => f.version)) + 1,
      createdAt: job.createdAt, origin: kind, jobId: job.id,
      ...(kind === 'generation' ? { template: structuredClone(templateFor(project, type.id)), sourceId: source!.id, sourceName: source!.name, sourceVersion: source!.version, requirements: draft.requirements } : { subjects: structuredClone(subjects), integrity: structuredClone({ ...snapshot!, subjects: subjects!, records: snapshot!.records.filter(r => subjects!.some(s => s.id === r.subjectId)) }) }),
    };
    project.files.push(file); job.fileIds.push(file.id);
  }
  state.jobs.unshift(job); project.updatedAt = job.createdAt;
  return job;
}
export const fileFamily = (file: ProjectFile) => file.familyId ?? (file.catalogId ? `catalog:${file.catalogId}` : ['source', 'original', 'qa-input'].includes(file.type) ? file.id : file.type);
export function latestFiles(project: Project): ProjectFile[] {
  const latest = new Map<string, ProjectFile>();
  for (const file of project.files) {
    const key = fileFamily(file);
    if (!latest.has(key) || latest.get(key)!.version < file.version) latest.set(key, file);
  }
  return [...latest.values()];
}
