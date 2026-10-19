import { esc } from '../ui';
import { prototypeIcon as ico } from '../prototype-design';
import { FOLDERS, DOCUMENTS, belongsTo, folderName, preparationFor } from './catalog';
import { ORIGINAL_CATALOG, ORIGINAL_GROUPS } from './original-catalog';
import { latestFiles, type Project, type ProjectFile } from './model';
import { originalSlots } from './project-files';

const path = (p: Project, folder = 'all') => `#/projects/${p.id}/files?folder=${folder}`;
const fileActions = (f: ProjectFile) => `<button class="text-button" data-action="preview" data-id="${f.id}">查看</button><button class="text-button" data-action="history" data-type="${f.type}" data-id="${f.id}" ${f.catalogId ? `data-catalog="${f.catalogId}"` : ''}>版本记录</button>`;
export function fileTree(p: Project, folder: string) {
  const files = latestFiles(p), count = (id: string) => files.filter(f => belongsTo(f.folder, id)).length;
  const item = (type: string, name: string, code: string) => `<button class="pd-tree-file" data-action="catalog-document" data-type="${type}"><span>${code}</span>${name}</button>`;
  return `<a class="pd-tree-all ${folder === 'all' ? 'active' : ''}" href="${path(p)}">全部成果文件 <span>${count('all')}</span></a>${FOLDERS.filter(f => !('parent' in f)).map(f => `<div class="pd-tree-group"><a class="pd-tree-row ${folder === f.id ? 'active' : ''}" href="${path(p, f.id)}" ${folder === f.id ? 'aria-current="page"' : ''}>${ico('folder')}<span>${f.id === 'sources' ? '' : f.id + ' '}${f.name}</span><small>${count(f.id)}</small></a>${f.id !== 'sources' ? `<details ${belongsTo(folder, f.id) ? 'open' : ''}><summary>查看文件目录</summary>${f.id === '2' ? item('prospectus','募集说明书','2.1') : ''}${DOCUMENTS.filter(d => d.folder === f.id).map(d => item(d.id,d.name,d.code)).join('')}${FOLDERS.filter(sub => 'parent' in sub && sub.parent === f.id).map(sub => `<a class="pd-tree-row child ${folder === sub.id ? 'active' : ''}" href="${path(p, sub.id)}"><span>${sub.id} ${sub.name}</span><small>${count(sub.id)}</small></a>${DOCUMENTS.filter(d => d.folder === sub.id).map(d => item(d.id,d.name,d.code)).join('')}`).join('')}</details>` : ''}</div>`).join('')}<p class="pd-note">已有文件数量不含待准备项。底稿沿用原券商编号。</p>`;
}
export function fileRows(p: Project, folder: string, query: string, status: string, originalGroup: string) {
  const existing = latestFiles(p), source = existing.find(f => f.type === 'prospectus');
  const rows: { file?: ProjectFile; name: string; folder: string; type: string; code: string }[] = [
    { file: source, name: '募集说明书', folder: '2', type: 'prospectus', code: '2.1' },
    ...DOCUMENTS.map(d => ({ file: existing.find(f => f.type === d.id), name: d.name, folder: d.folder, type: d.id, code: d.code })),
    ...existing.filter(f => f.type !== 'prospectus' && !DOCUMENTS.some(d => d.id === f.type) && !f.catalogId).map(file => ({ file, name: file.name, folder: file.folder, type: file.type, code: '' })),
  ];
  const shown = rows.filter(row => belongsTo(row.folder, folder) && `${row.name} ${row.file?.name ?? ''} ${row.code}`.toLowerCase().includes(query.trim().toLowerCase()) && (status === 'all' || (status === 'ready' ? !!row.file : !row.file)));
  const prepareLink = (row: typeof rows[number]) => {
    const integrity = row.type.includes('integrity'), hasSource = p.files.some(f => f.id === p.draft.sourceId && f.type === 'prospectus');
    const label = integrity ? '开始核查' : row.type === 'prospectus' ? '添加募集书' : preparationFor(row.type).label;
    return `<a href="#${integrity ? 'integrity' : 'generate'}?project=${p.id}&step=${integrity ? 'subjects' : row.type === 'prospectus' || !hasSource ? 'source' : 'materials'}${integrity || row.type === 'prospectus' ? '' : '&document=' + row.type}">${label}</a>`;
  };
  const table = shown.length ? `<div class="pd-table-wrap"><table class="pd-table pd-file-table"><thead><tr><th>文件名称 / 目录</th><th>当前情况</th><th>下一步</th></tr></thead><tbody>${shown.map(row => `<tr><td><div class="pd-file-title">${ico('file')}<div><button class="text-button pd-file-name" data-action="${row.file ? 'preview' : 'catalog-document'}" ${row.file ? `data-id="${row.file.id}"` : `data-type="${row.type}"`}>${esc(row.name)}</button><small>${esc(row.code)}${row.code ? ' · ' : ''}${folderName(row.folder)}</small></div></div></td><td>${row.file ? `<span class="pd-chip ${row.file.origin === 'integrity' ? 'amber' : ''}">${row.file.origin === 'integrity' ? '待核实 · 演示' : row.file.origin === 'upload' ? '本地选择' : '设计稿示例'}</span><small>v${row.file.version}${row.file.sourceVersion ? ` · 依据募集书 v${row.file.sourceVersion}` : ''}</small>` : `<span class="muted">尚未生成</span><small>${row.type.includes('integrity') ? '先完成诚信核查' : row.type === 'prospectus' ? '上传项目募集说明书' : preparationFor(row.type).hint}</small>`}</td><td><div class="pd-row-links">${row.file ? fileActions(row.file) : prepareLink(row)}</div></td></tr>`).join('')}</tbody></table></div>` : '';
  const originals = ['all','4','4.2'].includes(folder) ? originalLibrary(p, query, status, folder === '4.2', originalGroup) : '';
  return table + originals || '<div class="pd-empty">此目录暂无匹配文件。可调整搜索条件，或继续准备项目文件。</div>';
}
function originalLibrary(p: Project, query: string, status: string, full: boolean, group: string) {
  const slots = originalSlots(p, query, status, full ? group : 'all');
  const rows = full || query ? slots : slots.slice(0,4);
  return `<section class="pd-original-library"><div class="pd-section-head"><div><h2>4.2 核查记录 · 历史底稿目录</h2><p class="muted">${ORIGINAL_CATALOG.length} 项参考目录，沿用原编号；上传后归入当前项目。</p></div>${full ? '' : `<a class="text-button" href="${path(p,'4.2')}">浏览完整目录 →</a>`}</div>${full ? `<label class="pd-original-filter">原券商底稿分类<select id="original-group" aria-label="原券商底稿分类"><option value="all">全部分类</option>${Object.entries(ORIGINAL_GROUPS).map(([id,name]) => `<option value="${id}" ${id === group ? 'selected' : ''}>${id === 'other' ? '' : id + ' '}${name}</option>`).join('')}</select><small>${slots.length} 项匹配</small></label>` : ''}
  ${rows.length ? rows.map(d => `<div class="pd-original-row"><div class="pd-grow"><button class="text-button pd-file-name" data-action="${d.file ? 'preview' : 'original-slot'}" ${d.file ? `data-id="${d.file.id}"` : `data-catalog="${d.id}"`}>${esc(d.code)} ${esc(d.name)}</button><small>${esc(ORIGINAL_GROUPS[d.group])}${d.file ? ' · v' + d.file.version : ''}</small></div><span class="pd-chip ${d.file ? '' : 'muted'}">${d.file ? d.file.origin === 'sample' ? '示例文件' : '已记录文件名' : '待导入原件'}</span><div class="pd-row-links">${d.file ? fileActions(d.file) : `<button class="text-button" data-action="import-project-file" data-catalog="${d.id}">导入</button>`}</div></div>`).join('') : '<p class="pd-empty">没有符合筛选条件的历史底稿。</p>'}<p class="pd-note">这里展示文件目录，未复制参考项目的原件或核查结论。审计报告等编制依据放在“原始资料”。</p></section>`;
}
