import { emptyUpdateDetails, MARKET_LABELS, OFFERING_LABELS } from '@bondbuddy/contracts';
import { newId, uploadSource, type DesignState, type Project, type ProjectDetails, type WorkKind, type WorkDraft, type Job } from './model.js';

/** Additive v1 migration: never replace the existing project, files or material/integrity drafts. */
export function workFor(p: Project) {
  if (!p.work) {
    const market = p.market.includes('深交所') ? 'szse' : p.market.includes('上交所') ? 'sse' : p.market.includes('交易商协会') ? 'nafmii' : null;
    const offering = market === 'nafmii' ? p.market.includes('PPN') ? 'ppn' : 'mtn' : market ? p.market.includes('私募') ? 'private' : 'public' : null;
    const blank = (): WorkDraft => ({ sourceId: '', attachments: [], requirements: '', sources: [] });
    p.work = { details: { name: p.name, kind: 'update', issuer_name: p.issuer, market, offering, update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1', source_prospectuses: [] } }, update: blank(), review: blank() };
  }
  return p.work;
}
export function touchWork(p: Project, kind: WorkKind) { workFor(p)[kind].touchedAt = p.updatedAt = new Date().toISOString(); }
export function saveDetails(p: Project, kind: WorkKind, value: ProjectDetails) {
  workFor(p).details = structuredClone({ ...value, kind: 'update' });
  // Partly entered forms survive a refresh without erasing the project's readable identity.
  if (value.name.trim()) p.name = value.name.trim();
  if (value.issuer_name?.trim()) p.issuer = value.issuer_name.trim();
  p.market = [value.market && MARKET_LABELS[value.market], value.offering && OFFERING_LABELS[value.offering]].filter(Boolean).join(' · ') || '市场待补充';
  touchWork(p, kind);
}
export function selectWorkSource(p: Project, kind: WorkKind, id: string) {
  if (id && !p.files.some(f => f.id === id && f.type === 'prospectus')) throw new Error('请选择当前项目中的募集说明书。');
  workFor(p)[kind].sourceId = id; touchWork(p, kind);
}
export function addWorkFiles(p: Project, kind: WorkKind, role: string, files: Pick<File, 'name' | 'size'>[]) {
  const source = role === 'historical';
  // Validate the entire selection before modifying a project.
  if (source && files.length !== 1) throw new Error('每次请选择一份募集说明书。');
  for (const f of files) {
    if (!(source ? /\.(docx|pdf)$/i : /\.(docx|pdf|xlsx|csv|txt|png|jpe?g)$/i).test(f.name)) throw new Error('文件格式不支持，请按上传区提示选择。');
    if (f.size <= 0 || f.size > 100 * 1024 * 1024) throw new Error('文件不能为空，且单份不超过 100 MB。');
  }
  const draft = workFor(p)[kind];
  for (const f of files) {
    if (source) {
      const generationSource = p.draft.sourceId;
      draft.sourceId = uploadSource(p, f).id;
      p.draft.sourceId = generationSource;
    } else {
      let file = p.files.find(existing => existing.folder === 'sources' && existing.name === f.name && existing.size === f.size);
      if (!file) { file = { id: newId(), type: 'source', name: f.name, folder: 'sources', version: 1, createdAt: new Date().toISOString(), origin: 'upload', size: f.size }; p.files.push(file); }
      if (!draft.attachments.some(a => a.fileId === file!.id && a.role === role)) draft.attachments.push({ fileId: file.id, role });
    }
  }
  touchWork(p, kind);
}
export function runWorkPreview(state: DesignState, p: Project, kind: WorkKind): Job {
  const work = workFor(p), draft = work[kind];
  const source = p.files.find(f => f.id === draft.sourceId && f.type === 'prospectus');
  if (!source) throw new Error('请先选用或上传本项目的募集说明书。');
  if (!work.details.name.trim() || !work.details.issuer_name?.trim()) throw new Error('请先补全项目名称和发行人。');
  if (draft.attachments.some(a => !p.files.some(f => f.id === a.fileId))) throw new Error('补充材料不属于当前项目，请重新选择。');
  const job: Job = { id: newId(), projectId: p.id, kind, fileIds: [], createdAt: new Date().toISOString(), input: structuredClone({ draft, details: work.details }) };
  const type = kind === 'update' ? 'prospectus' : 'prospectus-review';
  const version = Math.max(0, ...p.files.filter(f => f.type === type).map(f => f.version)) + 1;
  const file = { id: newId(), type, name: `${p.issuer}_${kind === 'update' ? '募集说明书_更新稿' : '募集说明书复核报告'}（设计示例）`, folder: kind === 'update' ? '2' as const : '4.2' as const, version, createdAt: job.createdAt, origin: kind, sourceId: source.id, sourceName: source.name, sourceVersion: source.version, jobId: job.id, requirements: draft.requirements };
  p.files.push(file); job.fileIds.push(file.id); state.jobs.unshift(job); p.updatedAt = job.createdAt;
  return job;
}
