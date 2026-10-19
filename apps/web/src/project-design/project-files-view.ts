import { esc } from '../ui';
import { prototypeIcon as ico } from '../prototype-design';
import { FOLDERS, DOCUMENTS, belongsTo, folderName, preparationFor } from './catalog';
import { ORIGINAL_CATALOG, ORIGINAL_GROUPS } from './original-catalog';
import { latestFiles, type DesignState, type Project, type ProjectFile } from './model';
import { fileConsistencyState } from './consistency-model';
import { originalSlots } from './project-files';

const path = (p: Project, folder = 'all') => `#/projects/${p.id}/files?folder=${folder}`;
const expandedFolders = new Set(['1','2','3','4']);
export function bindFileTree(root: HTMLElement) {
  root.querySelectorAll<HTMLDetailsElement>('[data-tree-folder]').forEach(d => d.addEventListener('toggle',()=>{if(d.open)expandedFolders.add(d.dataset.treeFolder!);else expandedFolders.delete(d.dataset.treeFolder!);}));
}
function consistencyBadge(state: DesignState, p: Project, file?: ProjectFile) {
  if(!file)return '<span class="muted">—</span>';
  const s=fileConsistencyState(state,p,file);if(!s)return '<span class="muted">—</span>';
  const text=({conflict:`不一致 · ${s.count} 处`,updated:'已同步',consistent:'一致',manual:'需人工确认',checking:'检查中',stale:'版本已变化 · 待重查',unchecked:'未检查'} as const)[s.kind];
  return `<span class="pd-file-consistency ${s.kind}" title="本地检查示例">${s.kind==='conflict'?'!':s.kind==='updated'||s.kind==='consistent'?'✓':'·'} ${text}</span>`;
}
function consistencyAction(state: DesignState, p: Project, file?: ProjectFile) {
  if(!file)return '';const s=fileConsistencyState(state,p,file);
  if(s?.kind==='conflict')return `<a class="pd-file-update-action" href="#consistency?project=${p.id}&job=${s.jobId}&file=${s.fileId}">查看冲突并更新 ${ico('arrow')}</a>`;
  if(s?.kind==='stale')return `<button class="text-button" data-consistency-start data-project="${p.id}">重新检查</button>`;
  return '';
}
function matchesFileStatus(status:string,state:DesignState,p:Project,file?:ProjectFile) {
  if(['all','ready','missing'].includes(status))return status==='all'||(status==='ready'?!!file:!file);
  return !!file&&fileConsistencyState(state,p,file)?.kind===status;
}
export function fileConsistencySummary(p:Project,state:DesignState) {
  const job=state.jobs.find(j=>j.projectId===p.id&&j.consistency);if(!job)return '';
  const statuses=latestFiles(p).map(f=>fileConsistencyState(state,p,f)).filter(Boolean);
  const conflicts=statuses.filter(s=>s?.kind==='conflict').length,manual=statuses.filter(s=>s?.kind==='manual').length,stale=statuses.some(s=>s?.kind==='stale');
  return `<div class="pd-project-consistency-banner ${conflicts||stale?'attention':''}"><div>${ico('review')}<span><strong>${stale?'文件版本已变化，请重新检查':job.consistency!.phase==='checking'?'正在检查项目文件':conflicts?`${conflicts} 份文件与募集书不一致`:'本轮未发现待同步的文件'}</strong><small>${stale?'历史检查保留，新版本需重新核对。':`本地演示结果 · ${manual} 份需人工确认 · 接受更新后保留旧版`}</small></span></div>${stale?`<button class="btn secondary" data-consistency-start data-project="${p.id}">重新检查</button>`:`<a class="btn secondary" href="#consistency?project=${p.id}&job=${job.id}${conflicts?'&filter=conflict':''}">${conflicts?'查看全部冲突':job.consistency!.phase==='checking'?'查看进度':'查看检查结果'}</a>`}</div>`;
}
const fileActions = (f: ProjectFile) => `<button class="text-button" data-action="preview" data-id="${f.id}">查看</button><button class="text-button" data-action="history" data-type="${f.type}" data-id="${f.id}" ${f.catalogId ? `data-catalog="${f.catalogId}"` : ''}>版本记录</button>`;
export function fileTree(p: Project, folder: string) {
  const files = latestFiles(p), count = (id: string) => files.filter(f => belongsTo(f.folder, id)).length;
  const item = (type: string, name: string, code: string) => `<button class="pd-tree-file" data-action="catalog-document" data-type="${type}"><span>${code}</span>${name}</button>`;
  const row = (id:string,name:string) => `<a class="pd-tree-row ${folder === id ? 'active' : ''}" href="${path(p,id)}" ${folder === id ? 'aria-current="page"' : ''}>${ico('folder')}<span>${id==='sources'?'':id+' '}${name}</span><small>${count(id)}</small></a>`;
  return `<a class="pd-tree-all ${folder === 'all' ? 'active' : ''}" href="${path(p)}">全部成果文件 <span>${count('all')}</span></a>${FOLDERS.filter(f => !('parent' in f)).map(f => f.id === 'sources' ? `<div class="pd-tree-group">${row(f.id,f.name)}</div>` : `<details class="pd-tree-folder" data-tree-folder="${f.id}" ${expandedFolders.has(f.id)?'open':''}><summary><span class="pd-tree-chevron" aria-hidden="true">${ico('chevron')}</span>${row(f.id,f.name)}</summary><div class="pd-tree-children">${f.id === '2' ? item('prospectus','募集说明书','2.1') : ''}${DOCUMENTS.filter(d => d.folder === f.id).map(d => item(d.id,d.name,d.code)).join('')}${FOLDERS.filter(sub => 'parent' in sub && sub.parent === f.id).map(sub => `<a class="pd-tree-row child ${folder === sub.id ? 'active' : ''}" href="${path(p, sub.id)}"><span>${sub.id} ${sub.name}</span><small>${count(sub.id)}</small></a>${DOCUMENTS.filter(d => d.folder === sub.id).map(d => item(d.id,d.name,d.code)).join('')}`).join('')}</div></details>`).join('')}<p class="pd-note">已有文件数量不含待准备项。底稿沿用原券商编号。</p>`;
}
export function fileRows(p: Project, folder: string, query: string, status: string, originalGroup: string, state: DesignState) {
  const existing = latestFiles(p), source = existing.find(f => f.type === 'prospectus');
  const rows: { file?: ProjectFile; name: string; folder: string; type: string; code: string }[] = [
    { file: source, name: '募集说明书', folder: '2', type: 'prospectus', code: '2.1' },
    ...DOCUMENTS.map(d => ({ file: existing.find(f => f.type === d.id), name: d.name, folder: d.folder, type: d.id, code: d.code })),
    ...existing.filter(f => f.type !== 'prospectus' && !DOCUMENTS.some(d => d.id === f.type) && !f.catalogId).map(file => ({ file, name: file.name, folder: file.folder, type: file.type, code: '' })),
  ];
  const shown = rows.filter(row => belongsTo(row.folder, folder) && `${row.name} ${row.file?.name ?? ''} ${row.code}`.toLowerCase().includes(query.trim().toLowerCase()) && matchesFileStatus(status,state,p,row.file));
  const prepareLink = (row: typeof rows[number]) => {
    const integrity = row.type.includes('integrity'), hasSource = p.files.some(f => f.id === p.draft.sourceId && f.type === 'prospectus');
    const label = integrity ? '开始核查' : row.type === 'prospectus' ? '添加募集书' : preparationFor(row.type).label;
    return `<a href="#${integrity ? 'integrity' : 'generate'}?project=${p.id}&step=${integrity ? 'subjects' : row.type === 'prospectus' || !hasSource ? 'source' : 'materials'}${integrity || row.type === 'prospectus' ? '' : '&document=' + row.type}">${label}</a>`;
  };
  const table = shown.length ? `<div class="pd-table-wrap"><table class="pd-table pd-file-table"><thead><tr><th>文件名称 / 目录</th><th>当前情况</th><th>一致性</th><th>操作</th></tr></thead><tbody>${shown.map(row => `<tr><td><div class="pd-file-title">${ico('file')}<div><button class="text-button pd-file-name" data-action="${row.file ? 'preview' : 'catalog-document'}" ${row.file ? `data-id="${row.file.id}"` : `data-type="${row.type}"`}>${esc(row.name)}</button><small>${esc(row.code)}${row.code ? ' · ' : ''}${folderName(row.folder)}</small></div></div></td><td>${row.file ? `<span class="pd-chip ${row.file.origin === 'integrity' ? 'amber' : ''}">${row.file.origin === 'integrity' ? '待核实 · 演示' : row.file.origin === 'upload' ? '本地选择' : row.file.origin === 'consistency' ? '已同步 · 演示' : '设计稿示例'}</span><small>v${row.file.version}${row.file.sourceVersion ? ` · 依据募集书 v${row.file.sourceVersion}` : ''}</small>` : `<span class="muted">尚未生成</span><small>${row.type.includes('integrity') ? '先完成诚信核查' : row.type === 'prospectus' ? '上传项目募集说明书' : preparationFor(row.type).hint}</small>`}</td><td>${consistencyBadge(state,p,row.file)}</td><td><div class="pd-row-links">${row.file ? consistencyAction(state,p,row.file) + fileActions(row.file) : prepareLink(row)}</div></td></tr>`).join('')}</tbody></table></div>` : '';
  const originals = ['all','4','4.2'].includes(folder) ? originalLibrary(p, query, status, folder === '4.2', originalGroup,state) : '';
  return table + originals || '<div class="pd-empty">此目录暂无匹配文件。可调整搜索条件，或继续准备项目文件。</div>';
}
function originalLibrary(p: Project, query: string, status: string, full: boolean, group: string,state:DesignState) {
  const slots = originalSlots(p, query, ['ready','missing'].includes(status)?status:'all', full ? group : 'all').filter(d=>matchesFileStatus(status,state,p,d.file));
  const rows = full || query ? slots : slots.slice(0,4);
  return `<section class="pd-original-library"><div class="pd-section-head"><div><h2>4.2 核查记录 · 历史底稿目录</h2><p class="muted">${ORIGINAL_CATALOG.length} 项参考目录，沿用原编号；上传后归入当前项目。</p></div>${full ? '' : `<a class="text-button" href="${path(p,'4.2')}">浏览完整目录 →</a>`}</div>${full ? `<label class="pd-original-filter">原券商底稿分类<select id="original-group" aria-label="原券商底稿分类"><option value="all">全部分类</option>${Object.entries(ORIGINAL_GROUPS).map(([id,name]) => `<option value="${id}" ${id === group ? 'selected' : ''}>${id === 'other' ? '' : id + ' '}${name}</option>`).join('')}</select><small>${slots.length} 项匹配</small></label>` : ''}
  ${rows.length ? rows.map(d => `<div class="pd-original-row"><div class="pd-grow"><button class="text-button pd-file-name" data-action="${d.file ? 'preview' : 'original-slot'}" ${d.file ? `data-id="${d.file.id}"` : `data-catalog="${d.id}"`}>${esc(d.code)} ${esc(d.name)}</button><small>${esc(ORIGINAL_GROUPS[d.group])}${d.file ? ' · v' + d.file.version : ''}</small></div><span class="pd-chip ${d.file ? '' : 'muted'}">${d.file ? d.file.origin === 'sample' ? '示例文件' : d.file.origin === 'consistency' ? '已更新 · 演示' : '已记录文件名' : '待导入原件'}</span>${d.file ? consistencyBadge(state,p,d.file) : ''}<div class="pd-row-links">${d.file ? consistencyAction(state,p,d.file)+fileActions(d.file) : `<button class="text-button" data-action="import-project-file" data-catalog="${d.id}">导入</button>`}</div></div>`).join('') : '<p class="pd-empty">没有符合筛选条件的历史底稿。</p>'}<p class="pd-note">这里展示文件目录，未复制参考项目的原件或核查结论。审计报告等编制依据放在“原始资料”。</p></section>`;
}
