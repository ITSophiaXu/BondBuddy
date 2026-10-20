import { ORIGINAL_CATALOG, ORIGINAL_GROUPS } from './original-catalog.js';
import { newId, latestFiles, fileFamily, type DesignState, type Project, type ProjectFile } from './model.js';
import { FOLDERS, type FolderId } from './catalog.js';

export function migrateCatalogRefs(state: DesignState) {
  // Only the known v1 synthetic record gets a catalog association. Never infer one for user files.
  for (const p of state.projects) for (const f of p.files) {
    if (!f.catalogId && f.origin === 'sample' && f.type === 'original' && f.id === p.id + '-record' && f.name === '1-0 发行人基本情况的核查记录（示例）.docx') f.catalogId = 'wp000';
  }
}
export function importProjectFile(p: Project, file: Pick<File, 'name' | 'size'> & { lastModified?: number }, folder: string, catalogId?: string, asNewFile = false): ProjectFile {
  if (!FOLDERS.some(f => f.id === folder)) throw new Error('请选择有效的项目文件目录。');
  if (!/\.(docx|pdf|xlsx|csv|txt|png|jpg|jpeg)$/i.test(file.name)) throw new Error('请选择文档、表格或图片文件。');
  if (file.size <= 0 || file.size > 100 * 1024 * 1024) throw new Error('文件不能为空，且单份不超过 100 MB。');
  if (catalogId && (folder !== '4.2' || !ORIGINAL_CATALOG.some(d => d.id === catalogId))) throw new Error('底稿目录项不存在。');
  const previous = !asNewFile ? [...latestFiles(p)].filter(f => f.folder === folder && (catalogId ? f.catalogId === catalogId : f.name.toLocaleLowerCase() === file.name.toLocaleLowerCase())).sort((a,b) => b.version-a.version)[0] : undefined;
  const family = catalogId ? `catalog:${catalogId}` : previous ? fileFamily(previous) : newId();
  const versions = p.files.filter(f => fileFamily(f) === family);
  const f: ProjectFile = { id: newId(), familyId: family, name: file.name, type: previous?.type ?? (folder === '4.2' ? 'original' : 'source'), folder: folder as FolderId, origin: 'upload', size: file.size, createdAt: new Date().toISOString(), version: Math.max(0, ...versions.map(f => f.version)) + 1, ...((catalogId ?? previous?.catalogId) ? { catalogId: catalogId ?? previous?.catalogId } : {}), ...(file.lastModified && Number.isFinite(file.lastModified) ? { modifiedAt: new Date(file.lastModified).toISOString() } : {}) };
  p.files.push(f); p.updatedAt = f.createdAt; return f;
}
export function deleteProjectFile(p: Project, id: string) {
  const file = p.files.find(f => f.id === id && !f.deletedAt);
  if (!file) throw new Error('文件不存在或已删除。');
  file.deletedAt = new Date().toISOString(); p.updatedAt = file.deletedAt;
  if (p.draft.sourceId === id) p.draft.sourceId = '';
  for (const draft of p.work ? [p.work.update,p.work.review] : []) {
    if (draft.sourceId === id) { draft.sourceId = ''; draft.sources = []; }
    draft.attachments = draft.attachments.filter(a => a.fileId !== id);
  }
  return file;
}
export function restoreProjectFile(p: Project, id: string) {
  const file = p.files.find(f => f.id === id && f.deletedAt);
  if (!file) throw new Error('找不到已删除的文件。');
  delete file.deletedAt; p.updatedAt = new Date().toISOString(); return file;
}
export function modifiedTime(file: ProjectFile): string | undefined {
  return file.modifiedAt ?? (file.origin !== 'upload' ? file.createdAt : undefined);
}
export function originalSlots(p: Project, query: string, status: string, group = 'all') {
  const files = latestFiles(p), q = query.trim().toLocaleLowerCase();
  return ORIGINAL_CATALOG.map(d => ({ ...d, file: files.find(f => f.catalogId === d.id) })).filter(d => (group === 'all' || d.group === group) && `${d.code} ${d.name} ${d.file?.name ?? ''} ${ORIGINAL_GROUPS[d.group]}`.toLocaleLowerCase().includes(q) && (status === 'all' || (status === 'ready' ? !!d.file : !d.file)));
}
