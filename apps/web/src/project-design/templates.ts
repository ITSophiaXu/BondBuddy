import { GENERATABLE } from './catalog.js';
import { newId, type Project } from './model.js';

export type DocumentTemplate = { id: string; type: string; name: string; size: number; version: number; createdAt: string; origin: 'upload' | 'sample' | 'reuse'; copiedFrom?: string };
export function templateFor(p: Project, type: string) {
  const selected = p.draft.templateIds?.[type];
  return selected ? p.templates?.find(t => t.id === selected && t.type === type) : p.templates?.filter(t => t.type === type).at(-1);
}
export function saveTemplate(p: Project, type: string, file: Pick<File, 'name' | 'size'>, origin: DocumentTemplate['origin'] = 'upload', copiedFrom?: string) {
  if (!GENERATABLE.some(d => d.id === type)) throw new Error('请选择有效的文件类型。');
  if (!/\.(docx|doc)$/i.test(file.name)) throw new Error('历史文件 / 模板请选择 Word（DOCX / DOC）格式。');
  if (file.size <= 0 || file.size > 100 * 1024 * 1024) throw new Error('模板不能为空，且单份不超过 100 MB。');
  const templates = p.templates ??= [];
  const t: DocumentTemplate = { id: newId(), type, name: file.name, size: file.size, version: Math.max(0, ...templates.filter(t => t.type === type).map(t => t.version)) + 1, createdAt: new Date().toISOString(), origin, ...(copiedFrom ? { copiedFrom } : {}) };
  templates.push(t); (p.draft.templateIds ??= {})[type] = t.id; p.updatedAt = t.createdAt;
  return t;
}
export function missingTemplates(p: Project) {
  return GENERATABLE.filter(d => p.draft.selected.includes(d.id) && !templateFor(p, d.id));
}
