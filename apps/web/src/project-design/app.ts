import { workspaceShell } from '../workspace-shell';
import { prototypeIcon as ico } from '../prototype-design';
import { esc, date } from '../ui';
import { FOLDERS, DOCUMENTS, GENERATABLE, belongsTo, folderName, folderPath } from './catalog';
import { STORAGE_KEY, seedState, createProject, uploadSource, runPreview, latestFiles, newId, type DesignState, type Project, type ProjectFile, type Subject } from './model';
import '../style.css';
import '../../../../product-prototype/public/styles.css';
import '../../../../product-prototype/public/project-workspace.css';
import '../prototype-adapter.css';
import '../project-browser.css';
import './design.css';

const root = document.querySelector<HTMLDivElement>('#app')!;
document.title = 'BondBuddy · 项目材料与诚信核查 · 本地设计稿';
let state: DesignState = seedState();
let storageWarning = '';
let storageBlocked = false;
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const saved = JSON.parse(raw);
    if (saved.schema !== 1 || !Array.isArray(saved.projects) || !Array.isArray(saved.jobs) || saved.projects.some((p: Project) => !p.id || !Array.isArray(p.files) || !Array.isArray(p.draft?.subjects) || !Array.isArray(p.draft?.selected) || !Array.isArray(p.draft?.attachments))) throw new Error('Invalid design state');
    state = saved;
  }
} catch { storageBlocked = true; storageWarning = '无法读取之前的设计数据。当前使用临时示例，不覆盖原记录。'; }
let notification = '';
let selectedProject = '';
let projectSearch = '';
let fileSearch = '';
let fileStatus = 'all';
let newProjectMode: 'generate' | 'integrity' | 'tasks' = 'tasks';
let activeModalTrigger: HTMLElement | null = null;
const route = () => {
  const [path, query] = location.hash.replace(/^#/, '').split('?');
  return { path: path || 'tasks', query: new URLSearchParams(query) };
};
const projectForRoute = () => {
  const { path, query } = route();
  const id = path.match(/^\/projects\/([^/]+)\/files$/)?.[1] ?? query.get('project');
  return state.projects.find(p => p.id === id);
};
const go = (hash: string) => { if (location.hash === '#' + hash) render(); else location.hash = hash; };
const projectLink = (p: Project, folder = 'all') => `/projects/${p.id}/files?folder=${folder}`;
const flowLink = (mode: string, p: Project, step: string) => `${mode}?project=${p.id}&step=${step}`;
const sourceOf = (p: Project) => p.files.find(f => f.id === p.draft.sourceId && f.type === 'prospectus');
const button = (name: string, action: string, primary = false, attrs = '') => `<button type="button" class="btn ${primary ? 'primary' : 'secondary'}" data-action="${action}" ${attrs}>${name}</button>`;
const link = (name: string, href: string, primary = false) => `<a class="btn ${primary ? 'primary' : 'secondary'}" href="#${esc(href)}">${name}</a>`;
function save() {
  if (storageBlocked) return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { storageWarning = '浏览器存储空间不足，本次修改仅保留到页面关闭。请先导出设计数据。'; }
}
function notify(message: string) { notification = message; }
const pageHead = (eyebrow: string, title: string, description: string, actions = '') => `<div class="page-head pd-page-head"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div><div class="pd-actions">${actions}</div></div>`;
function steps(labels: string[], active: number) {
  return `<nav class="pd-steps" aria-label="操作步骤">${labels.map((label, index) => `<div class="pd-step ${index === active ? 'current' : index < active ? 'done' : ''}" ${index === active ? 'aria-current="step"' : ''}><b>${index < active ? ico('check') : index + 1}</b><span>${label}</span></div>`).join('')}</nav>`;
}
function projectContext(p: Project, mode: string) {
  return `<div class="pd-context"><div class="pd-project-icon">${ico('folder')}</div><div><strong>${esc(p.name)}</strong><small>${esc(p.issuer)} · ${esc(p.market)}</small></div><a class="text-button" href="#${mode}">更换项目</a><a class="text-button" href="#${projectLink(p)}">项目文件 ${ico('chevron')}</a></div>`;
}
function projectPicker(mode: 'generate' | 'integrity') {
  const material = mode === 'generate';
  return `${pageHead(material ? 'MATERIAL GENERATION' : 'INTEGRITY CHECK', material ? '材料生成' : '诚信核查', material ? '选定项目和募集说明书，一次准备所需关联材料。' : '按项目管理核查对象，查询记录统一归入底稿文件。')}
    ${steps(material ? ['选择项目', '选择募集说明书', '生成关联材料'] : ['选择项目', '添加核查对象', '核查结果与底稿'], 0)}
    <section class="pd-panel"><div class="pd-section-head"><div><h2>选择本次工作的项目</h2><p class="muted">沿用项目资料，也可以从一个新项目开始。</p></div>${button(ico('plus') + '新建项目', 'new-project', false, `data-mode="${mode}"`)}</div>
    <div class="pd-search">${ico('search')}<input id="project-picker-search" aria-label="搜索已有项目" placeholder="搜索项目名称或发行人" value="${esc(projectSearch)}" type="search"></div><div id="picker-list">${pickerRows()}</div>
    <div class="pd-footer"><span id="picker-summary" class="muted">${selectedProject ? '已选择 1 个项目' : '请选择一个项目以继续'}</span>${button(`下一步：${material ? '选择募集说明书' : '添加核查对象'} ${ico('arrow')}`, 'continue-project', true, `${selectedProject ? '' : 'disabled'} data-mode="${mode}"`)}</div></section>`;
}
function pickerRows() {
  const items = state.projects.filter(p => `${p.name} ${p.issuer}`.toLowerCase().includes(projectSearch.trim().toLowerCase()));
  return `<div class="pd-picker-list">${items.length ? items.map(p => `<label class="pd-project-choice ${selectedProject === p.id ? 'selected' : ''}"><input type="radio" name="project" value="${p.id}" ${selectedProject === p.id ? 'checked' : ''}><div class="pd-project-icon">${ico('folder')}</div><div class="pd-grow"><strong>${esc(p.name)}</strong><small>${esc(p.issuer)} · ${esc(p.market)}</small></div><span class="pd-chip">${p.files.filter(f => f.type === 'prospectus').length ? '有募集说明书' : '待添加募集说明书'}</span></label>`).join('') : '<div class="pd-empty">没有找到项目，可以更换搜索词或新建项目。</div>'}</div>`;
}
function sourcePicker(p: Project) {
  const sources = p.files.filter(f => f.type === 'prospectus').sort((a, b) => b.version - a.version);
  const selected = sourceOf(p);
  return `${pageHead('MATERIAL GENERATION', '选择募集说明书', '本次关联材料将引用同一份募集说明书，保留所选版本。')}${steps(['选择项目', '选择募集说明书', '生成关联材料'], 1)}${projectContext(p, 'generate')}
    <div class="pd-columns"><section class="pd-panel"><div class="pd-section-head"><div><h2>使用项目里的募集说明书</h2><p class="muted">选择一份已有文件，无需重复上传。</p></div><span class="pd-chip">${sources.length} 个版本</span></div>
    ${sources.length ? `<div class="pd-picker-list">${sources.map(f => `<label class="pd-source-choice ${selected?.id === f.id ? 'selected' : ''}"><input type="radio" name="source" value="${f.id}" ${selected?.id === f.id ? 'checked' : ''}><span class="pd-file-icon">${ico('file')}</span><div class="pd-grow"><strong>${esc(f.name)}</strong><small>v${f.version} · ${esc(date(f.createdAt))} · ${f.origin === 'sample' ? '示例文件' : '本地选择'}</small></div></label>`).join('')}</div>` : '<div class="pd-empty">这个项目还没有募集说明书，请在下方上传。</div>'}
    <div class="pd-divider">或上传另一份募集说明书</div><label class="pd-upload" id="source-drop">${ico('upload')}<strong>点击选择，或拖入募集说明书</strong><span>DOCX / PDF · 单份不超过 100 MB</span><input type="file" id="source-upload" aria-label="上传募集说明书" accept=".docx,.pdf"></label><p class="pd-note">设计稿仅保存文件名称和版本，不上传、不解析文件内容。</p></section>
    <aside class="pd-panel pd-summary"><span class="eyebrow">本次生成依据</span><h2>${selected ? '募集说明书已选定' : '等待选择募集说明书'}</h2><p>${selected ? esc(selected.name) : '先选择项目文件，或上传新版本。'}</p>${selected ? `<span class="pd-chip">固定版本 v${selected.version}</span>` : ''}<div class="pd-divider"></div><p class="muted">生成结果会自动归入这个项目的文件目录。</p><ul><li>投标文件及立项申请文件</li><li>申报、发行备案文件</li><li>受托管理材料</li><li>底稿文件</li></ul></aside></div>
    <div class="pd-footer">${link('上一步', 'generate')}${button('下一步：选择关联材料 ' + ico('arrow'), 'continue-source', true, selected ? '' : 'disabled')}</div>`;
}
function materialPicker(p: Project) {
  const source = sourceOf(p);
  if (!source) return sourcePicker(p);
  return `${pageHead('MATERIAL GENERATION', '选择要生成的关联材料', '按项目目录选择文件，生成后统一保存到当前项目。')}${steps(['选择项目', '选择募集说明书', '生成关联材料'], 2)}${projectContext(p, 'generate')}
    <div class="pd-source-strip">${ico('file')}<div class="pd-grow"><strong>${esc(source.name)}</strong><small>本次依据 · v${source.version}</small></div><a class="text-button" href="#${flowLink('generate', p, 'source')}">更换募集书</a></div>
    <div class="pd-columns"><section class="pd-panel"><div class="pd-section-head"><h2>关联材料 <span class="pd-count">${GENERATABLE.length}</span></h2><div class="pd-actions">${button('全选', 'select-all')}${button('清空', 'select-none')}</div></div>
    ${FOLDERS.filter(f => ['1', '2', '3', '4'].includes(f.id)).map(folder => `<section class="pd-material-group"><h3>${ico('folder')} ${folder.id} ${folder.name}</h3><div class="pd-material-grid">${GENERATABLE.filter(d => belongsTo(d.folder, folder.id)).map(d => `<label class="pd-material-choice"><input type="checkbox" name="material" value="${d.id}" ${p.draft.selected.includes(d.id) ? 'checked' : ''}><span><strong>${d.name}</strong><small>${d.hint}</small></span></label>`).join('')}</div></section>`).join('')}
    <div class="pd-inline-note">${ico('shield')}<div>诚信核查底稿通过独立核查流程准备。<a class="text-button" href="#${flowLink('integrity', p, 'subjects')}">前往诚信核查 ${ico('arrow')}</a></div></div></section>
    <aside class="pd-panel pd-summary"><h2>本次材料包</h2><p id="selected-count" class="pd-big-number">${p.draft.selected.length}<small> 份材料</small></p><p class="muted">生成后保存到对应目录，已有版本保留。</p><label class="pd-field">材料生成要求与说明 <span class="muted">选填</span><textarea id="requirements" rows="5" maxlength="12000" placeholder="例如：统一使用本期发行方案，保留待补充信息的标记。">${esc(p.draft.requirements)}</textarea></label><label class="pd-field">补充模板或依据 <span class="muted">选填</span><input id="support-upload" type="file" multiple accept=".docx,.pdf,.xlsx"></label><p id="support-names" class="pd-note">${p.draft.attachments.length ? esc(p.draft.attachments.join('、')) : '立项模板、财务报告、核查依据等可在此补充；设计稿仅记录文件名。'}</p></aside></div>
    <div class="pd-footer">${link('上一步', flowLink('generate', p, 'source'))}<div class="pd-actions"><span class="muted">演示生成 · 不调用模型、不扣费</span>${button(ico('spark') + '开始生成', 'run-generation', true, p.draft.selected.length ? '' : 'disabled')}</div></div>`;
}
function subjectRows(p: Project) {
  return p.draft.subjects.length ? p.draft.subjects.map((s, index) => `<div class="pd-subject" data-subject-row="${s.id}"><span class="pd-row-number">${String(index + 1).padStart(2, '0')}</span><label>对象类型<select data-subject="${s.id}" data-field="kind" aria-label="对象 ${index + 1} 类型"><option value="company" ${s.kind === 'company' ? 'selected' : ''}>企业</option><option value="person" ${s.kind === 'person' ? 'selected' : ''}>个人</option></select></label><label>名称 / 姓名<input data-subject="${s.id}" data-field="name" aria-label="对象 ${index + 1} 名称" value="${esc(s.name)}" maxlength="150" placeholder="填写完整名称"></label><label>关系 / 职务<input data-subject="${s.id}" data-field="role" aria-label="对象 ${index + 1} 关系" value="${esc(s.role)}" maxlength="80" placeholder="如发行人、董事"></label><label>${s.kind === 'company' ? '统一社会信用代码' : '识别信息'} <span class="muted">选填</span><input data-subject="${s.id}" data-field="identifier" aria-label="对象 ${index + 1} 识别信息" value="${esc(s.identifier)}" maxlength="${s.kind === 'company' ? 18 : 80}" placeholder="${s.kind === 'company' ? '18 位信用代码' : '任职公司等消歧信息'}"></label><button type="button" class="icon-btn" data-action="remove-subject" data-id="${s.id}" aria-label="删除对象 ${index + 1}">${ico('close')}</button></div>`).join('') : '<div class="pd-empty">名单还是空的。添加发行人、相关企业或董事及高级管理人员。</div>';
}
function integrityPicker(p: Project) {
  return `${pageHead('INTEGRITY CHECK', '添加诚信核查对象', '核对企业和人员名单，开始后将查询记录保存为本项目底稿。')}${steps(['选择项目', '添加核查对象', '核查结果与底稿'], 1)}${projectContext(p, 'integrity')}
    <section class="pd-panel"><div class="pd-section-head"><div><h2>本轮核查对象 <span id="subject-count" class="pd-count">${p.draft.subjects.length}</span></h2><p class="muted">名单自动保存在此项目，可继续添加或删除。</p></div><div class="pd-actions">${button('带入发行人', 'add-issuer')}${button(ico('plus') + '添加企业', 'add-company')}${button(ico('plus') + '添加人员', 'add-person')}</div></div><div id="subject-list">${subjectRows(p)}</div>
    <details class="pd-details"><summary>批量添加名单</summary><p class="muted">每行一个对象：类型，名称，关系或职务，识别信息（选填）。</p><textarea id="bulk-subjects" rows="4" placeholder="企业，澄川城市建设集团有限公司，发行人\n个人，陈示例，董事"></textarea>${button('添加到名单', 'import-subjects')}</details></section>
    <div class="pd-columns pd-integrity-info"><section class="pd-panel"><h2>核查内容</h2><div class="pd-scope-list"><span>${ico('check')} 失信与被执行信息</span><span>${ico('check')} 行政处罚与信用记录</span><span>${ico('check')} 证券市场诚信记录</span></div><p class="muted">每个对象保留查询条件、网站、时间、记录与截图位置。缺失身份信息时标记待补充。</p></section><section class="pd-panel"><h2>${ico('folder')} 结果归档位置</h2><p>4 底稿文件 / 4.3 诚信核查</p><p class="muted">企业记录：3-1-1<br>董事及高级管理人员记录：1-5-3-4</p></section></div>
    <div class="pd-footer">${link('上一步', 'integrity')}<div class="pd-actions"><span class="muted">设计稿只演示记录，不访问核查网站</span>${button(ico('shield') + '开始诚信核查', 'run-integrity', true, p.draft.subjects.length ? '' : 'disabled')}</div></div>`;
}
function resultView(p: Project, jobId: string) {
  const job = state.jobs.find(j => j.id === jobId && j.projectId === p.id);
  if (!job) return notFound('这次任务记录不存在', projectLink(p));
  const integrity = job.kind === 'integrity';
  const files = p.files.filter(f => job.fileIds.includes(f.id));
  return `${pageHead(integrity ? 'INTEGRITY CHECK' : 'MATERIAL GENERATION', integrity ? '诚信核查结果与底稿' : '本次关联材料', '示例结果已准备，可以查看归档位置和文件版本。')}${steps(integrity ? ['选择项目', '添加核查对象', '核查结果与底稿'] : ['选择项目', '选择募集说明书', '生成关联材料'], 2)}
    <div class="pd-success">${ico('check')}<div><h2>${files.length} 份${integrity ? '核查底稿' : '关联材料'}已加入项目文件</h2><p>${esc(p.name)}${integrity ? ` · ${job.subjectCount} 个核查对象` : ''} · ${esc(date(job.createdAt))}</p><small>${integrity ? '本轮未执行真实检索；对象状态均为“待核实”，不会生成无风险结论。' : '设计稿结果为内容占位，不是实际模型生成的文书。'}</small></div>${link('查看项目文件 ' + ico('arrow'), projectLink(p, integrity ? '4.3' : 'all'), true)}</div>
    <section class="pd-panel"><div class="pd-section-head"><h2>本次文件</h2><span class="muted">旧版本保留，可追溯</span></div><div class="pd-result-list">${files.map(f => `<div class="pd-result-row"><span class="pd-file-icon">${ico('file')}</span><div class="pd-grow"><strong>${esc(f.name)}</strong><small>${folderPath(f.folder)} · v${f.version}${f.sourceVersion ? ` · 依据募集书 v${f.sourceVersion}` : ''}</small></div><span class="pd-chip">${integrity ? '待核实 · 演示' : '设计稿'}</span>${button('查看', 'preview', false, `data-id="${f.id}"`)}</div>`).join('')}</div></section>
    ${integrity ? `<section class="pd-panel pd-result-details"><h2>对象核查记录</h2>${files.flatMap(f => f.subjects ?? []).map(s => `<div class="pd-result-row"><div class="pd-grow"><strong>${esc(s.name)}</strong><small>${esc(s.role)} · ${s.kind === 'company' ? '企业' : '个人'}</small></div><span class="pd-chip amber">未执行检索 · 待核实</span></div>`).join('')}</section>` : ''}
    <div class="pd-footer">${link('返回全部项目', 'tasks')}${link(integrity ? '准备下一轮核查' : '继续生成材料', flowLink(integrity ? 'integrity' : 'generate', p, integrity ? 'subjects' : 'materials'))}</div>`;
}
function projectsView() {
  return `${pageHead('ALL PROJECTS', '全部项目', '每个项目的募集书、关联材料与核查底稿，都在同一个文件目录。', button(ico('plus') + '新建项目', 'new-project', true, 'data-mode="tasks"'))}
    <section class="pd-panel"><div class="pd-section-head"><h2>项目列表 <span class="pd-count">${state.projects.length}</span></h2><span class="muted">按最近活动排序</span></div><div class="pd-search">${ico('search')}<input id="all-project-search" type="search" placeholder="搜索项目名称或发行人" aria-label="搜索项目名称或发行人" value="${esc(projectSearch)}"></div><div id="projects-table">${projectRows()}</div></section>`;
}
function projectRows() {
  const items = state.projects.filter(p => `${p.name} ${p.issuer}`.toLowerCase().includes(projectSearch.trim().toLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return items.length ? `<div class="pd-table-wrap"><table class="pd-table"><thead><tr><th>项目名称</th><th>最近更新</th><th>项目文件</th><th>开始工作</th></tr></thead><tbody>${items.map(p => `<tr><td><a class="pd-project-title" href="#${projectLink(p)}">${esc(p.name)}</a><small>${esc(p.issuer)}</small><span class="pd-chip">${esc(p.market)}</span></td><td><time>${esc(date(p.updatedAt))}</time></td><td><a class="pd-files-entry" href="#${projectLink(p)}">${ico('folder')} 项目文件 <b>${latestFiles(p).filter(f => f.folder !== 'sources').length}</b>${ico('chevron')}</a><small>募集书 · 关联材料 · 核查底稿</small></td><td><div class="pd-row-links"><a href="#${flowLink('generate', p, 'source')}">材料生成</a><a href="#${flowLink('integrity', p, 'subjects')}">诚信核查</a></div></td></tr>`).join('')}</tbody></table></div>` : '<div class="pd-empty">没有找到匹配的项目。</div>';
}
function fileRows(p: Project, folder: string) {
  const existing = latestFiles(p);
  const rows: { file?: ProjectFile; name: string; folder: string; type: string; code: string }[] = [
    ...existing.map(file => ({ file, name: file.name, folder: file.folder, type: file.type, code: DOCUMENTS.find(d => d.id === file.type)?.code ?? (file.type === 'prospectus' ? '2.1' : '') })),
    ...DOCUMENTS.filter(d => !existing.some(f => f.type === d.id)).map(d => ({ name: d.name, folder: d.folder, type: d.id, code: d.code })),
  ];
  if (!existing.some(f => f.type === 'prospectus')) rows.unshift({ name: '募集说明书', folder: '2', type: 'prospectus', code: '2.1' });
  const shown = rows.filter(row => belongsTo(row.folder, folder) && `${row.name} ${row.code}`.toLowerCase().includes(fileSearch.trim().toLowerCase()) && (fileStatus === 'all' || (fileStatus === 'ready' ? !!row.file : !row.file))).sort((a, b) => a.folder.localeCompare(b.folder));
  return shown.length ? `<div class="pd-table-wrap"><table class="pd-table pd-file-table"><thead><tr><th>文件名称 / 目录</th><th>当前情况</th><th>操作</th></tr></thead><tbody>${shown.map(row => `<tr><td><div class="pd-file-title">${ico('file')}<div><strong>${esc(row.name)}</strong><small>${esc(row.code)}${row.code ? ' · ' : ''}${folderName(row.folder)}</small></div></div></td><td>${row.file ? `<span class="pd-chip ${row.file.origin === 'integrity' ? 'amber' : ''}">${row.file.type === 'prospectus' ? '募集说明书' : row.file.origin === 'integrity' ? '待核实 · 演示' : row.file.origin === 'upload' ? '本地选择' : '设计稿示例'}</span><small>v${row.file.version}${row.file.sourceVersion ? ` · 依据募集书 v${row.file.sourceVersion}` : ''}</small>` : '<span class="muted">尚未生成</span>'}</td><td><div class="pd-row-links">${row.file ? `<button class="text-button" data-action="preview" data-id="${row.file.id}">查看</button><button class="text-button" data-action="history" data-type="${row.type}" data-id="${row.file.id}">版本记录</button>` : `<a href="#${flowLink(row.type.includes('integrity') ? 'integrity' : 'generate', p, row.type.includes('integrity') ? 'subjects' : sourceOf(p) ? 'materials' : 'source')}${row.type.includes('integrity') || row.type === 'prospectus' ? '' : '&document=' + row.type}">${row.type.includes('integrity') ? '开始核查' : row.type === 'prospectus' ? '添加募集书' : '准备文件'}</a>`}</div></td></tr>`).join('')}</tbody></table></div>` : '<div class="pd-empty">此目录暂无匹配文件。可调整搜索条件，或继续准备项目材料。</div>';
}
function filesView(p: Project) {
  const requested = route().query.get('folder') ?? 'all';
  const folder = requested === 'all' || FOLDERS.some(f => f.id === requested) ? requested : 'all';
  const latest = latestFiles(p);
  const count = (id: string) => latest.filter(f => belongsTo(f.folder, id)).length;
  return `${pageHead('PROJECT FILES', '项目文件', esc(p.name), link('材料生成', flowLink('generate', p, 'source')) + link('诚信核查', flowLink('integrity', p, 'subjects')))}
    <div class="pd-file-breadcrumb"><a href="#tasks">全部项目</a>${ico('chevron')}<span>${esc(p.name)}</span>${ico('chevron')}<strong>${folder === 'all' ? '全部成果文件' : folderName(folder)}</strong></div>
    <div class="pd-file-workspace"><nav class="pd-folder-tree" aria-label="项目文件目录"><a class="pd-tree-all ${folder === 'all' ? 'active' : ''}" href="#${projectLink(p)}" ${folder === 'all' ? 'aria-current="page"' : ''}>全部成果文件 <span>${count('all')}</span></a>${FOLDERS.map(f => `<a class="pd-tree-row ${'parent' in f ? 'child' : ''} ${folder === f.id ? 'active' : ''}" href="#${projectLink(p, f.id)}" ${folder === f.id ? 'aria-current="page"' : ''}>${ico('folder')}<span>${f.id === 'sources' ? '' : f.id + ' '}${f.name}</span><small>${count(f.id)}</small></a>`).join('')}<p class="pd-note">原券商编号保留。原始材料单独保存，供项目内其他工作复用。</p></nav>
    <section class="pd-panel pd-file-panel"><div class="pd-section-head"><h2>${folder === 'all' ? '全部成果文件' : folderName(folder)}</h2><span class="muted">${count(folder)} 份已有文件</span></div><div class="pd-file-filter"><div class="pd-search">${ico('search')}<input type="search" id="file-search" aria-label="搜索文件名或底稿编号" placeholder="搜索文件名或底稿编号" value="${esc(fileSearch)}"></div><select id="file-status" aria-label="文件状态"><option value="all" ${fileStatus === 'all' ? 'selected' : ''}>全部状态</option><option value="ready" ${fileStatus === 'ready' ? 'selected' : ''}>已有文件</option><option value="missing" ${fileStatus === 'missing' ? 'selected' : ''}>尚未生成</option></select></div><div id="file-list">${fileRows(p, folder)}</div></section></div>`;
}
function notFound(title: string, target = 'tasks') { return `${pageHead('WORKSPACE', title, '请返回项目列表重新选择。')}${link('返回', target, true)}`; }
function dashboardView() {
  return `${pageHead('WORKSPACE', '开始本次工作', '围绕同一个项目，准备材料、完成核查、管理文件。')}<div class="pd-dashboard-grid">${[{ title: '材料生成', desc: '选择项目与募集书，按目录准备 12 类关联材料。', href: 'generate', icon: 'spark' }, { title: '诚信核查', desc: '添加企业与人员名单，核查记录自动归入底稿文件。', href: 'integrity', icon: 'shield' }, { title: '全部项目', desc: '查看每个项目的募集书、材料、底稿及原始资料。', href: 'tasks', icon: 'folder' }].map(x => `<a class="pd-dashboard-card" href="#${x.href}">${ico(x.icon)}<h2>${x.title}</h2><p>${x.desc}</p><span>开始 ${ico('arrow')}</span></a>`).join('')}</div>`;
}
function render() {
  const { path, query } = route();
  const p = projectForRoute();
  let section = path === 'generate' || path === 'integrity' || path === 'dashboard' ? path : 'projects';
  let html: string;
  if (path === 'generate' || path === 'integrity') {
    if (!query.has('project')) html = projectPicker(path);
    else if (!p) html = notFound('项目不存在');
    else if (query.get('step') === 'result') html = resultView(p, query.get('job') ?? '');
    else {
      const type = query.get('document');
      if (type && GENERATABLE.some(d => d.id === type)) {
        if (!p.draft.selected.includes(type)) { p.draft.selected.push(type); save(); }
        query.delete('document');
        history.replaceState(null, '', `${location.pathname}${location.search}#${path}?${query}`);
      }
      html = path === 'integrity' ? integrityPicker(p) : query.get('step') === 'materials' ? materialPicker(p) : sourcePicker(p);
    }
  } else if (path.startsWith('/projects/')) html = p ? filesView(p) : notFound('项目不存在');
  else if (path === 'dashboard') html = dashboardView();
  else if (path === 'tasks' || path === '/') html = projectsView();
  else { section = path; html = `${pageHead('DESIGN PREVIEW', path === 'update' ? '更新募集说明书' : path === 'review' ? '复核募集说明书' : '设计预览', '本轮可交互设计覆盖材料生成、诚信核查和项目文件。')}${link('查看本轮设计', 'dashboard', true)}`; }
  root.innerHTML = workspaceShell(`<div class="pd-design-notice"><span><b>本地设计稿</b> · 合成项目 · 生成与核查为演示</span>${button('预览说明', 'design-info')}</div>${storageWarning ? `<p class="pd-alert" role="alert">${esc(storageWarning)}</p>` : ''}${notification ? `<p class="pd-feedback" role="status">${esc(notification)}</p>` : ''}<div id="flow-error" class="pd-alert" role="alert" hidden></div>${html}`, section, true);
  root.querySelector('.prototype-app')?.classList.add('pd-app');
  root.querySelector('[data-account-name]')!.textContent = '本地设计预览';
  root.querySelector('#logout')?.remove();
  root.querySelector('.top-plan-link')!.textContent = '设计迭代 v1 · 本地保存';
  root.querySelector('.credit-wallet')!.innerHTML = '<div class="pd-local-save">本地独立数据<br><small>不连接线上账号和项目</small></div>';
  notification = '';
  bind();
}
function showError(error: unknown) { const element = root.querySelector<HTMLElement>('#flow-error')!; element.hidden = false; element.textContent = error instanceof Error ? error.message : '操作未完成，请重试。'; element.scrollIntoView({ block: 'nearest' }); }
function modal(title: string, content: string) {
  document.querySelector('#pd-dialog')?.remove();
  activeModalTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = document.createElement('dialog'); dialog.id = 'pd-dialog'; dialog.className = 'pd-dialog'; dialog.setAttribute('aria-labelledby', 'pd-dialog-title');
  dialog.innerHTML = `<div class="pd-dialog-head"><h2 id="pd-dialog-title">${esc(title)}</h2><button class="icon-btn" data-close-dialog aria-label="关闭对话框">${ico('close')}</button></div><div class="pd-dialog-body">${content}</div>`;
  document.body.append(dialog); dialog.showModal();
  dialog.querySelector('[data-close-dialog]')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { dialog.remove(); activeModalTrigger?.focus(); });
  return dialog;
}
function preview(p: Project, file: ProjectFile) {
  const d = DOCUMENTS.find(d => d.id === file.type);
  const dialog = modal(file.name, `<div class="pd-preview-meta"><span class="pd-chip">v${file.version}</span><span>${folderPath(file.folder)}</span></div><p class="pd-note">${file.origin === 'upload' ? '本地选择记录：文件内容未上传或解析。' : '设计稿内容示例，不是实际生成成果或真实核查结论。'}</p>
    ${file.sourceName ? `<div class="pd-source-strip">${ico('file')}<div>依据：${esc(file.sourceName)}<small>固定募集书 v${file.sourceVersion}</small></div></div>` : ''}
    <article class="pd-document"><div class="eyebrow">${file.origin === 'integrity' ? '核查底稿 · 演示记录' : '项目文件 · 预览'}</div><h2>${esc(file.name)}</h2><p>项目：${esc(p.name)}</p>${file.subjects ? file.subjects.map(s => `<section><h3>${esc(s.name)}</h3><p>${esc(s.role)} · ${s.kind === 'company' ? '企业' : '个人'}<br>识别信息：${esc(s.identifier || '待补充')}<br>查询条件：${esc(s.name)}<br>查询网站 / 查询时间 / 原始截图：尚未检索<br>核查状态：未执行检索，待核实</p></section>`).join('') : `<h3>${d ? d.hint : '文件信息'}</h3><p>${d ? '正式生成后，这里展示可核对、可修改的材料正文。本设计稿仅固定所选项目、募集书版本与归档位置。' : '正式接入后可在此阅读原文件。本设计稿保留文件名称、来源及版本信息。'}</p>${file.requirements ? `<h3>本次编制要求</h3><p>${esc(file.requirements)}</p>` : ''}`}</article><div class="pd-footer"><span class="muted">${esc(date(file.createdAt))}</span><button class="btn secondary" id="download-design">导出设计说明（TXT）</button></div>`);
  dialog.querySelector('#download-design')!.addEventListener('click', () => download(`${file.name.replace(/[\\/:*?"<>|]/g, '_')}_v${file.version}_设计说明.txt`, dialog.querySelector('.pd-dialog-body')!.textContent ?? '', 'text/plain;charset=utf-8'));
}
function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function openNewProject(mode: typeof newProjectMode) {
  newProjectMode = mode;
  const dialog = modal('新建项目', `<form id="new-project-form"><p class="muted">建立项目后，募集书、关联材料和核查底稿都保存在这里。</p><label class="pd-field">项目名称<input name="name" required maxlength="150" placeholder="例如：澄川城投 2026 年公司债"></label><label class="pd-field">发行人名称<input name="issuer" required maxlength="150" placeholder="填写发行人全称"></label><label class="pd-field">发行市场与品种<select name="market"><option>深交所 · 普通私募公司债</option><option>上交所 · 普通私募公司债</option><option>上交所 · 公开发行公司债</option><option>深交所 · 公开发行公司债</option><option>交易商协会 · MTN</option><option>交易商协会 · PPN</option><option>其他</option></select></label><p id="create-error" class="pd-alert" role="alert" hidden></p><div class="pd-footer"><span class="muted">仅保存到本地设计稿</span><button class="btn primary" type="submit">创建并继续 ${ico('arrow')}</button></div></form>`);
  dialog.querySelector('form')!.addEventListener('submit', e => {
    e.preventDefault(); const form = new FormData(e.target as HTMLFormElement);
    try { const p = createProject(state, String(form.get('name')), String(form.get('issuer')), String(form.get('market'))); selectedProject = p.id; save(); dialog.close(); notify('项目已创建。'); go(newProjectMode === 'tasks' ? projectLink(p) : flowLink(newProjectMode, p, newProjectMode === 'generate' ? 'source' : 'subjects')); }
    catch (error) { const target = dialog.querySelector<HTMLElement>('#create-error')!; target.hidden = false; target.textContent = (error as Error).message; }
  });
}
function addSubject(p: Project, kind: Subject['kind'], name = '', role = '') {
  p.draft.subjects.push({ id: newId(), kind, name, role, identifier: '' }); save(); render();
  root.querySelector<HTMLInputElement>(`[data-subject="${p.draft.subjects.at(-1)!.id}"][data-field="name"]`)?.focus();
}
function bind() {
  root.querySelector('#toggle-menu')!.addEventListener('click', () => { const open = root.querySelector('#sidebar')!.classList.toggle('mobile-open'); root.querySelector('#toggle-menu')!.setAttribute('aria-expanded', String(open)); });
  root.querySelector('#close-menu')!.addEventListener('click', () => { root.querySelector('#sidebar')!.classList.remove('mobile-open'); root.querySelector('#toggle-menu')!.setAttribute('aria-expanded', 'false'); });
  root.querySelector('#project-picker-search')?.addEventListener('input', e => { projectSearch = (e.target as HTMLInputElement).value; root.querySelector('#picker-list')!.innerHTML = pickerRows(); });
  root.querySelector('#all-project-search')?.addEventListener('input', e => { projectSearch = (e.target as HTMLInputElement).value; root.querySelector('#projects-table')!.innerHTML = projectRows(); });
  const filterFiles = () => { const p = projectForRoute(); if (p) root.querySelector('#file-list')!.innerHTML = fileRows(p, route().query.get('folder') ?? 'all'); };
  root.querySelector('#file-search')?.addEventListener('input', e => { fileSearch = (e.target as HTMLInputElement).value; filterFiles(); });
  root.querySelector('#file-status')?.addEventListener('change', e => { fileStatus = (e.target as HTMLSelectElement).value; filterFiles(); });
  const drop = root.querySelector<HTMLElement>('#source-drop');
  drop?.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragging'); });
  drop?.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop?.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('dragging'); acceptSources(e.dataTransfer?.files); });
}
function acceptSources(files?: FileList | null) {
  const p = projectForRoute(); if (!p || !files?.length) return;
  try { if (files.length !== 1) throw new Error('每次请选择一份募集说明书。'); uploadSource(p, files[0]); save(); notify('已记录募集说明书名称和版本，并选为本次依据。'); render(); }
  catch (error) { showError(error); }
}
root.addEventListener('input', event => {
  const input = event.target as HTMLInputElement; const p = projectForRoute(); if (!p) return;
  if (input.id === 'requirements') { p.draft.requirements = input.value; save(); }
  if (input.dataset.subject && input.dataset.field && input.dataset.field !== 'kind') {
    const s = p.draft.subjects.find(s => s.id === input.dataset.subject); if (!s) return;
    const field = input.dataset.field as 'name' | 'role' | 'identifier'; s[field] = input.value; save();
  }
});
root.addEventListener('change', event => {
  const input = event.target as HTMLInputElement; const p = projectForRoute();
  if (input.name === 'project') { selectedProject = input.value; const b = root.querySelector<HTMLButtonElement>('[data-action="continue-project"]')!; b.disabled = false; root.querySelector('#picker-summary')!.textContent = '已选择 1 个项目'; root.querySelectorAll('.pd-project-choice').forEach(row => row.classList.toggle('selected', !!row.querySelector('input:checked'))); return; }
  if (!p) return;
  if (input.name === 'source') { p.draft.sourceId = input.value; save(); render(); }
  if (input.id === 'source-upload') acceptSources(input.files);
  if (input.id === 'support-upload') {
    const files = [...(input.files ?? [])];
    p.draft.attachments = [...new Set([...p.draft.attachments, ...files.map(f => f.name)])];
    for (const f of files) if (!p.files.some(existing => existing.folder === 'sources' && existing.name === f.name && existing.size === f.size)) {
      p.files.push({ id: newId(), type: 'source', name: f.name, folder: 'sources', version: 1, createdAt: new Date().toISOString(), origin: 'upload', size: f.size });
    }
    save(); root.querySelector('#support-names')!.textContent = p.draft.attachments.join('、') || '未选择补充文件';
  }
  if (input.name === 'material') { p.draft.selected = input.checked ? [...new Set([...p.draft.selected, input.value])] : p.draft.selected.filter(id => id !== input.value); save(); root.querySelector('#selected-count')!.innerHTML = `${p.draft.selected.length}<small> 份材料</small>`; root.querySelector<HTMLButtonElement>('[data-action="run-generation"]')!.disabled = !p.draft.selected.length; }
  if (input.dataset.field === 'kind') { const s = p.draft.subjects.find(s => s.id === input.dataset.subject); if (s) { s.kind = input.value as Subject['kind']; s.identifier = ''; save(); render(); } }
});
root.addEventListener('click', event => {
  const trigger = (event.target as HTMLElement).closest<HTMLElement>('[data-action]'); if (!trigger) return;
  const action = trigger.dataset.action; const p = projectForRoute();
  try {
    if (action === 'new-project') { openNewProject(trigger.dataset.mode as typeof newProjectMode); return; }
    if (action === 'continue-project') { const selected = state.projects.find(p => p.id === selectedProject); if (selected) go(flowLink(trigger.dataset.mode!, selected, trigger.dataset.mode === 'generate' ? 'source' : 'subjects')); return; }
    if (action === 'design-info') {
      const dialog = modal('本轮设计说明', '<p>基于当前线上版本 1742fe6a，沿用 BondBuddy 的导航、配色和工作台外框。</p><p>本轮可操作：选择或新建项目、记录募集书、批量选择关联材料、维护诚信核查名单、按项目浏览文件及历史版本。</p><p>全部项目为合成数据；上传仅记录文件名；生成正文、网站检索及核查截图均未接通。示例结果不构成真实业务成果。</p><p>输入保存在此浏览器的独立设计数据中。可导出 JSON 留存本轮迭代记录。</p><button class="btn secondary" id="export-design-state">导出本地设计数据</button>');
      dialog.querySelector('#export-design-state')!.addEventListener('click', () => download('bondbuddy-project-design-v1.json', JSON.stringify(state, null, 2), 'application/json')); return;
    }
    if (!p) return;
    if (action === 'continue-source') { if (!sourceOf(p)) throw new Error('请先选择募集说明书。'); go(flowLink('generate', p, 'materials')); }
    else if (action === 'select-all' || action === 'select-none') { p.draft.selected = action === 'select-all' ? GENERATABLE.map(d => d.id) : []; save(); render(); }
    else if (action === 'add-company' || action === 'add-person') addSubject(p, action === 'add-company' ? 'company' : 'person');
    else if (action === 'add-issuer') { if (p.draft.subjects.some(s => s.kind === 'company' && s.name.trim() === p.issuer)) throw new Error('发行人已在名单中。'); addSubject(p, 'company', p.issuer, '发行人'); }
    else if (action === 'remove-subject') { p.draft.subjects = p.draft.subjects.filter(s => s.id !== trigger.dataset.id); save(); render(); }
    else if (action === 'import-subjects') {
      const text = root.querySelector<HTMLTextAreaElement>('#bulk-subjects')!.value;
      const rows = text.split('\n').map(line => line.trim()).filter(Boolean); if (!rows.length) throw new Error('请先填写批量名单。');
      const parsed = rows.map((row, i): Subject => { const [kind, name, role, identifier = ''] = row.split(/[，,\t]/).map(x => x.trim()); if (!['企业', '个人'].includes(kind) || !name || !role) throw new Error(`第 ${i + 1} 行格式不完整，请填写类型、名称和关系。`); return { id: newId(), kind: kind === '企业' ? 'company' : 'person', name, role, identifier }; });
      p.draft.subjects.push(...parsed); save(); notify(`已添加 ${parsed.length} 个对象，请核对名单。`); render();
    }
    else if (action === 'run-generation' || action === 'run-integrity') {
      const kind = action === 'run-generation' ? 'generation' : 'integrity'; const job = runPreview(state, p, kind); save();
      (trigger as HTMLButtonElement).disabled = true; go(`${flowLink(kind === 'generation' ? 'generate' : 'integrity', p, 'result')}&job=${job.id}`);
    }
    else if (action === 'preview') { const f = p.files.find(f => f.id === trigger.dataset.id); if (f) preview(p, f); }
    else if (action === 'history') {
      const files = p.files.filter(f => ['source', 'original'].includes(trigger.dataset.type!) ? f.id === trigger.dataset.id : f.type === trigger.dataset.type).sort((a, b) => b.version - a.version);
      const dialog = modal('文件版本记录', `<p class="muted">每次准备新版本均保留旧文件及原始依据。</p>${files.map(f => `<div class="pd-result-row"><div class="pd-grow"><strong>v${f.version} · ${esc(f.name)}</strong><small>${esc(date(f.createdAt))}${f.sourceVersion ? ` · 依据募集书 v${f.sourceVersion}` : ''}</small></div><button class="btn secondary" data-version="${f.id}">查看</button></div>`).join('')}`);
      dialog.querySelectorAll<HTMLElement>('[data-version]').forEach(b => b.addEventListener('click', () => { const f = files.find(f => f.id === b.dataset.version)!; dialog.close(); preview(p, f); }));
    }
  } catch (error) { showError(error); }
});
window.addEventListener('hashchange', () => { document.querySelector<HTMLDialogElement>('#pd-dialog')?.close(); render(); root.querySelector<HTMLElement>('#main')?.focus({ preventScroll: true }); window.scrollTo({ top: 0 }); });
document.querySelector('.skip-link')!.addEventListener('click', e => { e.preventDefault(); root.querySelector<HTMLElement>('#main')?.focus(); });
save(); render();
