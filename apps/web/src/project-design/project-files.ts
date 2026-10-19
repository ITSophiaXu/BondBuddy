import { ORIGINAL_CATALOG, ORIGINAL_GROUPS } from './original-catalog.js';
import { newId, latestFiles, type DesignState, type Project, type ProjectFile } from './model.js';

export function migrateCatalogRefs(state: DesignState) {
  // Only the known v1 synthetic record gets a catalog association. Never infer one for user files.
  for (const p of state.projects) for (const f of p.files) {
    if (!f.catalogId && f.origin === 'sample' && f.type === 'original' && f.id === p.id + '-record' && f.name === '1-0 发行人基本情况的核查记录（示例）.docx') f.catalogId = 'wp000';
  }
}
export function importProjectFile(p: Project, file: Pick<File, 'name' | 'size'>, folder: string, catalogId?: string): ProjectFile {
  if (!['4.2', 'sources'].includes(folder)) throw new Error('请选择历史底稿或原始资料目录。');
  if (!/\.(docx|pdf|xlsx|csv|txt|png|jpg|jpeg)$/i.test(file.name)) throw new Error('请选择文档、表格或图片文件。');
  if (file.size <= 0 || file.size > 100 * 1024 * 1024) throw new Error('文件不能为空，且单份不超过 100 MB。');
  if (catalogId && (folder !== '4.2' || !ORIGINAL_CATALOG.some(d => d.id === catalogId))) throw new Error('底稿目录项不存在。');
  const f: ProjectFile = { id: newId(), name: file.name, type: folder === '4.2' ? 'original' : 'source', folder: folder as '4.2' | 'sources', origin: 'upload', size: file.size, createdAt: new Date().toISOString(), version: catalogId ? Math.max(0, ...p.files.filter(f => f.catalogId === catalogId).map(f => f.version)) + 1 : 1, ...(catalogId ? { catalogId } : {}) };
  p.files.push(f); p.updatedAt = f.createdAt; return f;
}
export function originalSlots(p: Project, query: string, status: string, group = 'all') {
  const files = latestFiles(p), q = query.trim().toLocaleLowerCase();
  return ORIGINAL_CATALOG.map(d => ({ ...d, file: files.find(f => f.catalogId === d.id) })).filter(d => (group === 'all' || d.group === group) && `${d.code} ${d.name} ${d.file?.name ?? ''} ${ORIGINAL_GROUPS[d.group]}`.toLocaleLowerCase().includes(q) && (status === 'all' || (status === 'ready' ? !!d.file : !d.file)));
}
